import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { once } from 'node:events';
import { createAppServer } from '../scripts/serve.mjs';

let server;
let browser;
let origin;
const storageKey = 'ananyas-next-read.feedback.v1';

before(async () => {
  server = createAppServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

function fixtures(size = 10) {
  const books = Array.from({ length: size }, (_, index) => ({
    id: String(index + 1), title: `Book ${String(index + 1).padStart(2, '0')}`,
    author: 'Test Author', isbn13: null, seasons: ['autumn']
  }));
  const checkedAt = new Date().toISOString();
  return {
    'library.json': { schemaVersion: 1, books },
    'catalog.json': books.map(book => ({ ...book, recordId: `S246C${book.id}`, description: 'A short description used only by the browser tests.' })),
    'availability.json': {
      schemaVersion: 1,
      results: books.map(book => ({
        id: book.id, recordId: `S246C${book.id}`, status: 'ok', copies: 3, available: 1, holds: 0,
        availableCopies: [{ location: 'Central Library', status: 'In' }],
        countsCheckedAt: checkedAt, locationsCheckedAt: checkedAt
      }))
    }
  };
}

async function open(t, data = fixtures(), date) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 720 } });
  t.after(() => context.close());
  const page = await context.newPage();
  if (date) await page.clock.setFixedTime(date);
  // Fixtures prevent test runs from making extra requests to SPL or using personal data.
  await page.route('**/data/*.json', route => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    return route.fulfill({ status: data[name] ? 200 : 404, contentType: 'application/json', body: JSON.stringify(data[name] ?? {}) });
  });
  await page.goto(origin);
  return page;
}

async function picks(page) {
  await page.locator('#recommend').click();
  await page.waitForFunction(() => !document.getElementById('skip').disabled || !document.getElementById('load-error').hidden);
  assert.equal(await page.locator('#load-error').isVisible(), false, await page.locator('#load-error').innerText());
  await page.locator('#skip').click();
}

test('overlap months blend both shelves with incoming artwork, while manual selection uses one season', async t => {
  const date = new Date('2026-03-15T20:00:00Z');
  const data = fixtures(10);
  for (const [index, book] of data['library.json'].books.entries()) {
    const shelves = index === 8 ? ['winter'] : index === 9 ? ['spring'] : [];
    book.seasons = shelves;
    data['catalog.json'][index].seasons = shelves;
    data['availability.json'].results[index].countsCheckedAt = date.toISOString();
    data['availability.json'].results[index].locationsCheckedAt = date.toISOString();
  }
  const page = await open(t, data, date);
  assert.equal(await page.locator('#season').inputValue(), 'spring');
  await page.locator('#recommend').click();
  assert.equal(await page.locator('#motion .spring-art').count(), 1);
  await page.waitForFunction(() => !document.getElementById('skip').disabled);
  await page.locator('#skip').click();
  assert.equal(await page.locator('#heading').innerText(), 'here comes the sun');
  assert.match(await page.locator('#summary').innerText(), /Blending spring and winter shelves/);
  assert.deepEqual(await page.locator('.card').evaluateAll(cards => cards.slice(0, 2).map(card => card.dataset.bookId)), ['9', '10']);
  assert.equal(await page.locator('[data-book-id="9"] .reason').innerText(), 'On your winter shelf.');
  assert.equal(await page.locator('[data-book-id="10"] .reason').innerText(), 'On your spring shelf.');
  await page.locator('#season').selectOption('winter');
  assert.equal(await page.locator('#heading').innerText(), 'winter is hopeful');
  assert.doesNotMatch(await page.locator('#summary').innerText(), /Blending/);
  assert.equal(await page.locator('[data-book-id="10"]').count(), 0, 'Manual winter selection must stop boosting the spring-only book.');
  await page.locator('#refresh').click();
  await page.waitForFunction(() => !document.getElementById('skip').disabled);
  await page.locator('#skip').click();
  assert.doesNotMatch(await page.locator('#summary').innerText(), /Blending/);
  assert.equal(await page.locator('[data-book-id="10"]').count(), 0);
});

test('real feedback replaces without duplicates and survives reload; the full batch is capped at eight', async t => {
  const page = await open(t);
  await picks(page);
  assert.equal(await page.locator('.card').count(), 8);
  assert.match(await page.locator('#summary').innerText(), /^8 picks/);
  await page.getByRole('button', { name: 'Read already: Book 01', exact: true }).click();
  await page.locator('[data-book-id="9"]').waitFor();
  assert.equal(await page.locator('[data-book-id="1"]').count(), 0);
  assert.deepEqual(await page.locator('.card').evaluateAll(cards => cards.map(card => card.dataset.bookId)), ['9', '2', '3', '4', '5', '6', '7', '8']);
  await page.getByRole('button', { name: 'Not today: Book 02', exact: true }).click();
  await page.locator('[data-book-id="10"]').waitFor();
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
  assert.deepEqual(saved.read, ['1']);
  assert.ok(saved.deferred['2'] > Date.now());
  await page.reload();
  await picks(page);
  const seen = await page.locator('.card').evaluateAll(cards => cards.map(card => card.dataset.bookId));
  assert.equal(new Set(seen).size, 8);
  assert.ok(!seen.includes('1') && !seen.includes('2'));
});

test('an exhausted pool removes a card without repeating excluded books', async t => {
  const page = await open(t, fixtures(1));
  await picks(page);
  await page.getByRole('button', { name: 'Not today: Book 01', exact: true }).click();
  await page.locator('#empty').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.card').count(), 0);
  assert.match(await page.locator('#notice').innerText(), /No more checked books/);
  assert.equal(await page.locator('#heading').evaluate(element => document.activeElement === element), true);
});

test('ebooks appear within eight picks with honest labels, no request action, and persistent feedback', async t => {
  const data = fixtures(10);
  for (const book of data['catalog.json'].slice(0, 2)) {
    book.format = 'ebook';
    book.seasons = ['winter'];
    book.editionCheckedAt = new Date(Date.now() - 3 * 86400000).toISOString();
    data['library.json'].books.find(entry => entry.id === book.id).seasons = ['winter'];
  }
  data['availability.json'].results = data['availability.json'].results.filter(row => !['1', '2'].includes(row.id));
  data['availability.json'].results[0] = { id: '3', recordId: 'S246C3', status: 'error', error: 'Check failed' };
  const page = await open(t, data);
  await page.locator('#season').selectOption('winter');
  await picks(page);
  assert.equal(await page.locator('.card').count(), 8);
  const ebook = page.locator('[data-book-id="1"]');
  assert.equal(await ebook.locator('.ebook-note').innerText(), 'Ebook only at SPL');
  assert.equal(await ebook.getByRole('link').count(), 0);
  assert.equal(await ebook.locator('.availability').innerText(), 'Ebook suggestion');
  assert.match(await ebook.locator('.location').innerText(), /holds and availability are not checked/);
  assert.match(await ebook.locator('.checked').innerText(), /^Edition checked/);
  assert.match(await page.locator('#summary').innerText(), /Includes 2 ebook suggestions/);
  assert.match(await page.locator('#data-warning').innerText(), /^1 failed, 0 outdated, and 0 missing/);
  assert.equal(await page.getByRole('link', { name: /Request .* from SPL/ }).count(), 6);
  await ebook.getByRole('button', { name: 'Not today: Book 01', exact: true }).click();
  await page.locator('[data-book-id="10"]').waitFor();
  assert.equal(await page.locator('.card').count(), 8);
  assert.match(await page.locator('#summary').innerText(), /Includes 1 ebook suggestion;/);
  await page.reload();
  await picks(page);
  assert.equal(await page.locator('[data-book-id="1"]').count(), 0);
  await page.getByRole('button', { name: 'Read already: Book 02', exact: true }).click();
  await page.locator('[data-book-id="2"]').waitFor({ state: 'detached' });
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
  assert.deepEqual(saved.read, ['2']);
  assert(saved.deferred['1'] > Date.now());
});

test('missing data, stale snapshots, and failed saves are visible rather than success-shaped', async t => {
  const missing = fixtures();
  delete missing['availability.json'];
  const page = await open(t, missing);
  await page.locator('#recommend').click();
  await page.locator('#load-error').waitFor({ state: 'visible' });
  assert.match(await page.locator('#load-error').innerText(), /npm run refresh/);

  const stale = fixtures(1);
  stale['availability.json'].results[0].countsCheckedAt = '2000-01-01T00:00:00Z';
  const stalePage = await open(t, stale);
  await picks(stalePage);
  assert.equal(await stalePage.locator('.card').count(), 0);
  assert.match(await stalePage.locator('#data-warning').innerText(), /1 outdated/);

  const savePage = await open(t, fixtures(1));
  await picks(savePage);
  await savePage.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); }; });
  await savePage.getByRole('button', { name: 'Read already: Book 01', exact: true }).click();
  await savePage.locator('#notice[role="alert"]').waitFor({ state: 'visible' });
  assert.match(await savePage.locator('#notice').innerText(), /Couldn't save/);
  assert.equal(await savePage.locator('.card').count(), 1);
});

test('Home cancels delayed navigation, and reduced motion disables all seasonal animation', async t => {
  const page = await open(t);
  await page.locator('#season').selectOption('summer');
  await page.locator('#recommend').click();
  await page.waitForFunction(() => !document.getElementById('skip').disabled);
  assert.equal(await page.locator('.shore-water').evaluate(element => getComputedStyle(element).animationName), 'none');
  assert.equal(await page.locator('.summer-vector circle').count(), 0);
  await page.locator('#home-button').click();
  await page.waitForTimeout(4300);
  assert.equal(await page.locator('#home').isVisible(), true);
});

test('the loader advances automatically at the approved pace and book text is not interpreted as HTML', async t => {
  const data = fixtures(1);
  data['catalog.json'][0].title = '<img src=x onerror=alert(1)>';
  data['availability.json'].results[0].copies = 1;
  const page = await open(t, data);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('#season').selectOption('summer');
  const started = Date.now();
  await page.locator('#recommend').click();
  await page.locator('.shore-water').waitFor();
  assert.equal(await page.locator('.shore-water').evaluate(element => getComputedStyle(element).animationName), 'shore-wash');
  await page.locator('#results').waitFor({ state: 'visible', timeout: 8000 });
  assert.ok(Date.now() - started >= 4000);
  assert.equal(await page.locator('.card h2').innerText(), '<img src=x onerror=alert(1)>');
  assert.equal(await page.locator('.card img').count(), 0);
  assert.equal(await page.locator('.availability').innerText(), '1 available - 1 copy - 0 holds');
  assert.equal(await page.locator('.card').evaluate(element => getComputedStyle(element).animationDuration), '0.65625s');
});

test('home fits the viewport and all eight results form responsive rows without horizontal overflow', async t => {
  const page = await open(t);
  for (const [width, height, columns] of [[768, 1024, 2], [1024, 768, 2], [1025, 768, 4], [1280, 720, 4], [1440, 900, 4]]) {
    await page.setViewportSize({ width, height });
    await page.locator('#home-button').click();
    await page.evaluate(() => document.fonts.ready);
    const shelf = await page.locator('.shelf').boundingBox();
    assert.equal(shelf.x, 0);
    assert.equal(shelf.width, width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), false, `Home overflows at ${width}x${height}`);
    await picks(page);
    assert.equal(await page.locator('.card').count(), 8);
    const layout = await page.locator('#grid').evaluate(element => ({
      columns: getComputedStyle(element).gridTemplateColumns.split(' ').length,
      rows: new Set([...element.children].map(card => card.offsetTop)).size
    }));
    assert.equal(layout.columns, columns);
    assert.equal(layout.rows, 8 / columns);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.card').count(), 8);
  assert.equal(await page.locator('.cover').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator('#grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length), 1);
  for (const path of ['/.git/config', '/scripts/import.mjs', '/%2e%2e%5cpackage.json']) {
    assert.equal((await page.request.get(`${origin}${path}`)).status(), 404);
  }
});

test('mobile scrolls through the whole batch, preserves cards on resize, and keeps a compact home', async t => {
  const page = await open(t);
  await page.setViewportSize({ width: 390, height: 844 });
  await picks(page);
  assert.equal(await page.locator('.card').count(), 8);
  assert.equal(await page.getByRole('navigation', { name: 'Recommendation pages' }).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), true);
  await page.locator('[data-book-id="8"]').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('[data-book-id="8"]').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= innerHeight;
  }), true, 'The last book must be reachable by scrolling.');
  await page.locator('[data-book-id="4"] button').first().focus();
  await page.locator('[data-book-id="4"]').evaluate(element => { element.dataset.resizeCheck = 'preserved'; });
  await page.setViewportSize({ width: 1280, height: 720 });
  assert.equal(await page.locator('.card').count(), 8);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('[data-book-id="4"]').getAttribute('data-resize-check'), 'preserved');
  assert.equal(await page.locator('[data-book-id="4"] button').first().evaluate(element => element === document.activeElement), true);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'Read already: Book 04', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('[data-book-id="9"]').waitFor();
  assert.equal(await page.locator('[data-book-id="4"]').count(), 0);
  assert.equal(await page.locator('.card').count(), 8);

  for (const [width, height] of [[390, 844], [360, 640], [320, 568]]) {
    await page.setViewportSize({ width, height });
    await page.locator('#home-button').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight), false, `Home overflows at ${width}x${height}`);
    const button = await page.locator('#recommend').boundingBox();
    const shelf = await page.locator('.shelf').boundingBox();
    assert.ok(button.y + button.height < shelf.y, `Greeting/button overlaps the shelf at ${width}x${height}`);
    await page.locator('.shelf-art').evaluate(image => image.decode());
    const artwork = await page.locator('.shelf-art').evaluate(image => {
      const bounds = image.getBoundingClientRect();
      return {
        left: bounds.left, right: bounds.right, top: bounds.top,
        ratio: bounds.width / bounds.height, naturalRatio: image.naturalWidth / image.naturalHeight
      };
    });
    assert.equal(artwork.left, 0);
    assert.equal(artwork.right, width);
    assert.equal(artwork.top, shelf.y);
    assert.equal(shelf.y + shelf.height, height);
    assert.ok(Math.abs(artwork.ratio - artwork.naturalRatio) < .01, 'The shelf must retain its proportions.');
    assert.ok(button.width < width * .6);
    assert.ok(button.height >= 44, 'The smaller button must remain easy to tap.');
    const fonts = await page.evaluate(() => ({
      button: parseFloat(getComputedStyle(document.getElementById('recommend')).fontSize),
      title: parseFloat(getComputedStyle(document.querySelector('.brand')).fontSize)
    }));
    assert.ok(fonts.button < fonts.title, 'The mobile button text should be smaller than the site title.');
  }
});

test('tablet and phone use transparent taller artwork; desktop keeps the original shelf', async t => {
  const page = await open(t);
  for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1024, 768], [1025, 768], [1280, 720]]) {
    await page.setViewportSize({ width, height });
    const taller = width <= 1024;
    await page.waitForFunction(filename => {
      const image = document.querySelector('.shelf-art');
      return image.currentSrc.endsWith(filename) && image.complete && image.naturalWidth > 0;
    }, taller ? 'bookshelf-tall.png' : 'bookshelf-preview.png');
    await page.locator('.shelf-art').evaluate(image => image.decode());
    await page.evaluate(() => document.fonts.ready);
    const image = page.locator('.shelf-art');
    assert.match(await image.evaluate(element => element.currentSrc), taller ? /bookshelf-tall\.png$/ : /bookshelf-preview\.png$/);
    const shelf = await page.locator('.shelf').boundingBox();
    assert.equal(shelf.x, 0);
    assert.equal(shelf.width, width);
    assert.equal(shelf.y + shelf.height, height);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight), false);
    if (taller) {
      const button = await page.locator('#recommend').boundingBox();
      assert.ok(button.y + button.height + 23 <= shelf.y, `Artwork overlaps the button at ${width}x${height}`);
      const alpha = await image.evaluate(element => {
        const canvas = document.createElement('canvas');
        canvas.width = element.naturalWidth;
        canvas.height = element.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(element, 0, 0);
        const sample = (x, y) => context.getImageData(x, y, 1, 1).data[3];
        return { wall: sample(canvas.width / 2, 0), books: sample(canvas.width / 2, canvas.height - 1) };
      });
      assert.equal(alpha.wall, 0, 'The wall must show the actual site background, not a beige rectangle.');
      assert.equal(alpha.books, 255, 'Removing the wall must preserve the bookcase.');
      if (width === 390) assert.equal(shelf.height, width, 'A tall phone should reveal all three shelves.');
    }
  }
});
