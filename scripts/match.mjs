import { chromium } from 'playwright';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLibrary } from '../public/recommendations.js';

export function normalize(value) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/['\u2019]/g, '').replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function searchTitle(title) {
  return title.replace(/\s+\([^)]*#\d[^)]*\)$/, '').split(':')[0].trim();
}

export function sameAuthor(expected, actual) {
  const words = normalize(actual).split(' ');
  return normalize(expected).split(' ').every(word => words.includes(word));
}

export function verifyRecord(book, record) {
  if (!record.fields.title?.length) return 'Full catalog details are incomplete.';
  if (normalize(searchTitle(book.title)) !== normalize(record.title)) return 'The main title differs.';
  if (!sameAuthor(book.author, record.author)) return 'The author differs.';
  if (record.language !== 'en') return 'English language is not confirmed by the catalog title metadata.';
  if (!/\bCurrent format, Book,/.test(record.format)) return 'Not a standard physical book.';
  const edition = [record.subtitle, ...(record.fields.edition ?? []), ...record.fields.title].join(' ');
  if (/\b(abridged|adapted|adaptation|dramatization|dramatisation|retold|young readers|simplified|study guide|graphic novel|selections|excerpts)\b/i.test(edition)) {
    return 'This edition needs review for adaptation or abridgment.';
  }
  return null;
}

export function catalogDescription(fields) {
  const clean = value => value.replace(/\s*[\u2014-]+\s*Fiction\.?$/i, '').replace(/\.$/, '').trim();
  const subjects = [...new Set((fields.subject ?? []).map(clean))].filter(value => value && value.length <= 100).slice(0, 3);
  if (subjects.length) return `Catalog themes: ${subjects.join('; ')}.`;
  const genres = (fields.genre ?? []).map(clean).filter(value => value && !/^(fiction|novels)$/i.test(value)).slice(0, 2);
  if (genres.length) return `Catalog genres: ${genres.join('; ')}.`;
  return 'Plot summary not yet curated; open the SPL listing for details.';
}

async function navigate(page, url) {
  await page.waitForTimeout(3000);
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error(`SPL returned ${response?.status() ?? 'no response'}; stopping without retries.`);
  const title = await page.title();
  if (/access denied|just a moment|verify you|captcha/i.test(title)) {
    throw new Error('SPL requested human verification; stopping without bypassing it.');
  }
}

async function matchBook(page, book) {
  const query = searchTitle(book.title);
  await navigate(page, `https://seattle.bibliocommons.com/v2/search?query=${encodeURIComponent(query)}&searchType=title`);
  const main = page.getByRole('main');
  await main.getByRole('heading', { level: 1 }).first().waitFor();
  const candidates = await main.getByRole('heading', { level: 3 }).evaluateAll(headings =>
    headings.flatMap(heading => {
      const link = heading.querySelector('a[href*="/v2/record/"]');
      if (!link || !heading.innerText.includes(', Book')) return [];
      return [{
        title: heading.innerText.split('\n')[0],
        recordId: link.href.match(/\/record\/(S246C\d+)/)?.[1],
        details: heading.parentElement.parentElement.innerText.slice(0, 900)
      }];
    })
  );
  const exact = candidates.filter(candidate => candidate.recordId &&
    normalize(candidate.title) === normalize(query) && sameAuthor(book.author, candidate.details));
  const rejected = [];
  for (const candidate of exact.slice(0, 3)) {
    await navigate(page, `https://seattle.bibliocommons.com/v2/record/${candidate.recordId}`);
    const recordMain = page.getByRole('main');
    const heading = recordMain.getByRole('heading', { level: 1 });
    await heading.waitFor();
    const record = await heading.evaluate(element => {
      // Recommended books below the record also have author/title blocks.
      const info = element.closest('.main-info');
      if (!info) throw new Error('The primary record metadata layout has changed.');
      return {
        title: element.innerText.split('\n')[0],
        language: element.getAttribute('lang'),
        author: info.querySelector('.cp-bib-authors').innerText.split('\n')[0],
        subtitle: info.querySelector('.cp-bib-title').innerText,
        format: info.querySelector('.cp-format-chooser-sr-message').textContent.trim()
      };
    });
    await page.waitForTimeout(1500);
    await recordMain.getByRole('link', { name: 'Full details of this title, opens an overlay', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await dialog.locator('.cp-bib-field-label').first().waitFor();
    record.fields = await dialog.evaluate(element => Object.fromEntries(
      [...element.querySelectorAll('.cp-bib-field')].map(field => [
        field.querySelector('.cp-bib-field-label').textContent.trim().toLowerCase(),
        [...field.querySelectorAll('.formatted-value')].map(value => value.innerText.trim())
      ])
    ));
    const reason = verifyRecord(book, record);
    if (reason) {
      rejected.push({ recordId: candidate.recordId, reason });
      continue;
    }
    return { status: 'verified', match: { recordId: candidate.recordId, ...record }, candidates, rejected };
  }
  return {
    status: 'review',
    reason: exact.length ? 'No inspected edition passed verification.' : 'No exact title/author physical edition on the first search page.',
    candidates, rejected
  };
}

async function matchAll(limit) {
  const library = validateLibrary(JSON.parse(await readFile(new URL('../public/data/library.json', import.meta.url), 'utf8')));
  const catalog = JSON.parse(await readFile(new URL('../public/data/catalog.json', import.meta.url), 'utf8'));
  const directory = new URL('../.local/', import.meta.url);
  const output = new URL('matching.json', directory);
  await mkdir(directory, { recursive: true });
  let report = { schemaVersion: 1, results: [] };
  try {
    report = JSON.parse(await readFile(output, 'utf8'));
    if (report.schemaVersion !== 1 || !Array.isArray(report.results)) throw new Error('Unsupported matching checkpoint.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const matched = new Set(catalog.map(book => book.id));
  const pending = library.filter(book => !matched.has(book.id) && !report.results.some(row =>
    row.id === book.id && row.title === book.title && row.author === book.author && row.status !== 'error'
  )).slice(0, limit);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(30000);
    for (const book of pending) {
      let result;
      try {
        result = await matchBook(page, book);
      } catch (error) {
        result = { status: 'error', reason: error.message };
      }
      const row = { id: book.id, title: book.title, author: book.author, checkedAt: new Date().toISOString(), ...result };
      report.results = [...report.results.filter(item => item.id !== book.id), row];
      report.updatedAt = new Date().toISOString();
      await writeFile(new URL('matching.json.tmp', directory), JSON.stringify(report, null, 2));
      await rename(new URL('matching.json.tmp', directory), output);
      console.log(`${result.status}: ${book.title}${result.reason ? ` - ${result.reason}` : ''}`);
      if (result.status === 'error') throw new Error(`Stopped at ${book.title}: ${result.reason}`);
    }
  } finally {
    await browser.close();
  }
  console.log(`Saved ${report.results.length} local audit results. No mappings were published or promoted automatically.`);
}

async function applyMatches() {
  const library = validateLibrary(JSON.parse(await readFile(new URL('../public/data/library.json', import.meta.url), 'utf8')));
  const output = new URL('../public/data/catalog.json', import.meta.url);
  const catalog = JSON.parse(await readFile(output, 'utf8'));
  const report = JSON.parse(await readFile(new URL('../.local/matching.json', import.meta.url), 'utf8'));
  let descriptions = {};
  try {
    descriptions = JSON.parse(await readFile(new URL('../.local/descriptions.json', import.meta.url), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const ids = new Set(catalog.map(book => book.id));
  const recordIds = new Set(catalog.map(book => book.recordId));
  let added = 0;
  for (const row of report.results.filter(row => row.status === 'verified')) {
    if (ids.has(row.id)) continue;
    const book = library.find(book => book.id === row.id);
    if (!book || book.title !== row.title || book.author !== row.author) throw new Error(`TBR identity changed for ${row.title}; match again.`);
    const reason = verifyRecord(book, row.match);
    if (reason) throw new Error(`${row.title}: ${reason}`);
    if (!/^S246C\d+$/.test(row.match.recordId)) throw new Error(`Invalid record identity for ${row.title}.`);
    if (recordIds.has(row.match.recordId)) {
      console.warn(`Not added: ${row.title} duplicates an existing physical record.`);
      continue;
    }
    const description = descriptions[row.id] ?? catalogDescription(row.match.fields);
    if (typeof description !== 'string' || !description.trim()) throw new Error(`Invalid description for ${row.title}.`);
    catalog.push({
      id: row.id, title: row.match.title, catalogAuthor: row.match.author,
      recordId: row.match.recordId, description
    });
    ids.add(row.id);
    recordIds.add(row.match.recordId);
    added++;
  }
  await writeFile(new URL('../public/data/catalog.json.tmp', import.meta.url), JSON.stringify(catalog, null, 2) + '\n');
  await rename(new URL('../public/data/catalog.json.tmp', import.meta.url), output);
  console.log(`Added ${added} verified matches locally; ${catalog.length} total. Review results were not added.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--apply') {
    await applyMatches();
  } else {
    const limit = Number(process.argv[2] ?? 25);
    if (process.argv.length > 3 || !Number.isSafeInteger(limit) || limit < 1 || limit > 336) {
      throw new Error('Usage: npm run match -- <book limit from 1 to 336>, or npm run match -- --apply');
    }
    await matchAll(limit);
  }
}
