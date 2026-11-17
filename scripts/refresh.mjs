import { chromium } from 'playwright';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFresh, validateAvailability, validateCatalog } from '../public/recommendations.js';

function count(text, label) {
  // Screen-reader labels repeat counts; conflicting values must not become a guess.
  const pattern = label === 'copies' ? 'cop(?:y|ies)' : label;
  const values = [...new Set([...text.matchAll(new RegExp(`\\b(\\d+) ${pattern}\\b`, 'g'))].map(match => Number(match[1])))];
  if (values.length !== 1) throw new Error(`Missing or conflicting "${label}" count.`);
  return values[0];
}

export function parseCounts(text) {
  if (/^On order$/m.test(text) && !/\b\d+ cop(?:y|ies)\b/.test(text)) {
    if (count(text, 'on order') === 0 || /\b\d+ available\b|^All copies in use$/m.test(text)) {
      throw new Error('Contradictory on-order availability labels.');
    }
    return { copies: 0, available: 0, holds: count(text, 'on hold') };
  }
  // SPL includes on-order stock in its total; only owned copies count for recommendations.
  const totalCopies = count(text, 'copies');
  const onOrder = /\b\d+ on order\b/.test(text) ? count(text, 'on order') : 0;
  const copies = totalCopies - onOrder;
  if (copies < 0) throw new Error('On-order copies exceed total copies.');
  const holds = count(text, 'on hold');
  let available;
  if (/^All copies in use$/m.test(text)) {
    if (/\b[1-9]\d* available\b/.test(text)) throw new Error('Contradictory availability labels.');
    available = 0; // SPL omits the numeric zero when it explicitly says all copies are in use.
  } else {
    available = count(text, 'available');
  }
  if (available > copies) throw new Error('Available copies exceed total copies.');
  return { copies, available, holds };
}

export function parseLocations(groups, counts) {
  if (!groups.length && counts.copies === 0 && counts.available === 0) return [];
  if (!groups.length || groups.some(group => group.rows.length !== group.count)) {
    throw new Error('Location tables are incomplete.');
  }
  const availableRows = groups.filter(group => group.available).flatMap(group => group.rows);
  if (groups.reduce((sum, group) => sum + group.count, 0) !== counts.copies || availableRows.length !== counts.available) {
    throw new Error('Location and record counts disagree; availability may have changed during the check.');
  }
  if (availableRows.some(row => ![4, 5].includes(row.length) || !row[0] || !row[3])) {
    throw new Error('Unexpected location/status columns.');
  }
  // Preserve status per copy: "Not yet shelved" is not a promise of shelf-ready stock.
  return availableRows.map(row => ({ location: row[0], status: row[3] }));
}

async function navigate(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  const status = response?.status();
  const blocked = [401, 403, 429].includes(status) || /access denied|just a moment|verify you|captcha/i.test(await page.title());
  if (!response?.ok() || blocked) {
    const error = new Error(`SPL navigation failed (${status ?? 'no response'}).${blocked ? ' Collection stopped; no access restrictions will be bypassed.' : ''}`);
    if (blocked) error.code = 'SPL_ACCESS_BLOCKED';
    throw error;
  }
}

export async function refreshBook(page, book) {
  if (book.format === 'ebook') throw new Error('Ebook suggestions do not have physical availability checks.');
  const url = `https://seattle.bibliocommons.com/v2/record/${book.recordId}`;
  await navigate(page, url);
  const main = page.getByRole('main');
  await main.getByText(/^\d+ on hold$/).first().waitFor();
  const text = await main.innerText();
  const title = await main.getByRole('heading', { level: 1 }).innerText();
  if (!title.includes(book.title) || !text.includes(book.catalogAuthor) || !/Current format, Book,/.test(text)) {
    throw new Error('The record does not match the expected physical book.');
  }
  if (book.edition && !text.includes(book.edition)) throw new Error('The selected edition does not match.');
  let counts;
  // SPL hydrates status and numeric labels separately; wait for agreement without refetching.
  for (let attempt = 0; attempt < 20; attempt++) {
    const snapshot = await main.innerText();
    const start = snapshot.indexOf('Title availability\n');
    const end = snapshot.indexOf('Availability by location', start);
    if (start < 0 || end < 0) throw new Error('The availability section has changed.');
    try {
      counts = parseCounts(snapshot.slice(start, end));
      break;
    } catch (error) {
      if (attempt === 19) throw error;
      await page.waitForTimeout(250);
    }
  }
  const countsCheckedAt = new Date().toISOString();

  await page.waitForTimeout(1500);
  await navigate(page, `https://seattle.bibliocommons.com/v2/availability/${book.recordId}`);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('table').first().waitFor();
  const groups = await dialog.evaluate(element =>
    [...element.querySelectorAll('h3')].flatMap(heading => {
      const match = heading.innerText.match(/^(Available|Not available at this time) \((\d+)\)$/);
      if (!match) return [];
      const table = heading.parentElement.querySelector('table');
      if (!table) throw new Error('Missing location table.');
      const headers = [...table.querySelectorAll('thead th')].map(cell => cell.innerText.trim());
      const expected = ['Location', 'Collection', 'Call No.', 'Status', 'Due'];
      if (![4, 5].includes(headers.length) || headers.some((header, index) => header !== expected[index])) {
        throw new Error('Unexpected location table headers.');
      }
      return [{
        available: match[1] === 'Available',
        count: Number(match[2]),
        rows: [...table.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.innerText.trim()))
      }];
    })
  );
  return {
    id: book.id, recordId: book.recordId, status: 'ok', ...counts,
    availableCopies: parseLocations(groups, counts),
    countsCheckedAt, locationsCheckedAt: new Date().toISOString()
  };
}

export function validateRefreshForPublication(report, catalog, now = Date.now()) {
  const rows = validateAvailability(report);
  const physical = validateCatalog(catalog).filter(book => book.format !== 'ebook');
  const started = Date.parse(report.startedAt);
  const completed = Date.parse(report.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || started > completed || completed > now ||
      rows.length !== physical.length || physical.some(book =>
        !rows.some(row => row.id === book.id && row.recordId === book.recordId))) {
    throw new Error('Refresh is incomplete; the published snapshot will not be replaced.');
  }
  const successful = rows.filter(row => row.status === 'ok');
  if (!successful.length || successful.some(row => !isFresh(row, now) ||
      Date.parse(row.countsCheckedAt) < started || Date.parse(row.locationsCheckedAt) < started)) {
    throw new Error('Refresh has no usable new checks or contains old checks; publication stopped.');
  }
  return { successful: successful.length, failed: rows.length - successful.length };
}

async function refreshAll(resume, publish) {
  const catalog = validateCatalog(JSON.parse(await readFile(new URL('../public/data/catalog.json', import.meta.url), 'utf8')))
    .filter(book => book.format !== 'ebook');
  const directory = new URL('../.local/', import.meta.url);
  const checkpoint = new URL('refresh.json', directory);
  await mkdir(directory, { recursive: true });
  const report = resume
    ? JSON.parse(await readFile(checkpoint, 'utf8'))
    : { schemaVersion: 1, startedAt: new Date().toISOString(), results: [] };
  report.results = validateAvailability(report).filter(row => catalog.some(book => book.id === row.id && book.recordId === row.recordId));
  const pending = catalog.filter(book => !report.results.some(row => row.id === book.id && isFresh(row, Date.now())));
  console.log(`Checking ${pending.length} editions; reusing ${catalog.length - pending.length} fresh checks.`);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(30000);
    for (const [index, book] of pending.entries()) {
      let blocked;
      report.results = report.results.filter(row => row.id !== book.id);
      try {
        const result = await refreshBook(page, book);
        report.results.push(result);
        console.log(`${book.title}: ${result.holds} holds, ${result.available}/${result.copies} available.`);
      } catch (error) {
        // A per-book failure is recorded, never disguised as zero holds or fresh old data.
        const message = error instanceof Error ? error.message : String(error);
        report.results.push({ id: book.id, recordId: book.recordId, status: 'error', error: message, checkedAt: new Date().toISOString() });
        console.error(`${book.title}: ${message}`);
        if (!publish) process.exitCode = 1;
        if (error.code === 'SPL_ACCESS_BLOCKED') blocked = error;
      }
      // Keep interrupted work outside public/; only a complete run replaces the visible snapshot.
      await writeFile(new URL('refresh.json.tmp', directory), JSON.stringify(report, null, 2));
      await rename(new URL('refresh.json.tmp', directory), checkpoint);
      if (blocked) throw blocked;
      if (index < pending.length - 1) await page.waitForTimeout(3000);
    }
  } finally {
    await browser.close();
  }
  report.completedAt = new Date().toISOString();
  if (publish) {
    const outcome = validateRefreshForPublication(report, catalog);
    console.log(`Publication check: ${outcome.successful} fresh successes, ${outcome.failed} explicit failures excluded.`);
    if (outcome.failed) console.warn('::warning::Some SPL checks failed; those books are excluded from recommendations.');
  }
  // Replace the snapshot only after the complete JSON file has been written.
  const output = new URL('../public/data/availability.json', import.meta.url);
  const temporary = new URL('../public/data/availability.json.tmp', import.meta.url);
  await writeFile(temporary, JSON.stringify(report, null, 2));
  await rename(temporary, output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || (process.argv[2] && !['--resume', '--publish'].includes(process.argv[2]))) {
    throw new Error('Usage: npm run refresh, or npm run refresh -- --resume / --publish');
  }
  await refreshAll(process.argv[2] === '--resume', process.argv[2] === '--publish');
}
