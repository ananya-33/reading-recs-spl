import test from 'node:test';
import assert from 'node:assert/strict';
import { importGoodreads } from '../scripts/import.mjs';
import { parseCounts, parseLocations, refreshBook } from '../scripts/refresh.mjs';

test('import handles CSV quoting, cleans ISBNs, and excludes private/read data', () => {
  const csv = '\uFEFFBook Id,Title,Author,ISBN13,Bookshelves,Exclusive Shelf,Private Notes,My Review\n' +
    '1,"A title, with commas",An  Author,"=""9780593724996""","to-read, autumn, spring, personal-shelf",to-read,SECRET,SECRET\n' +
    '2,Read book,Someone,"=""""",read,read,SECRET,SECRET\n';
  assert.deepEqual(importGoodreads(csv), [{
    id: '1', title: 'A title, with commas', author: 'An Author', isbn13: '9780593724996', seasons: ['autumn', 'spring']
  }]);
});

test('import preserves books without ISBNs or seasonal shelves', () => {
  assert.deepEqual(importGoodreads('Book Id,Title,Author,ISBN13,Bookshelves,Exclusive Shelf\n1,Title,Author,,"to-read, other",to-read\n'), [
    { id: '1', title: 'Title', author: 'Author', isbn13: null, seasons: [] }
  ]);
});

test('malformed imports fail rather than producing a misleading library', () => {
  assert.throws(() => importGoodreads('Title,Author\nExample,Author'), /required/);
  assert.throws(() => importGoodreads('Book Id,Title,Author,ISBN13,Bookshelves,Exclusive Shelf\n1,Title,Author,bad,to-read,to-read'), /ISBN13/);
  assert.throws(() => importGoodreads('Book Id,Title,Author,ISBN13,Bookshelves,Exclusive Shelf\n1,A,B,,to-read,to-read\n1,A,B,,to-read,to-read'), /duplicate/);
});

test('SPL duplicate accessibility labels are accepted; missing counts are not zero', () => {
  assert.deepEqual(parseCounts('Available\n8 copies\n8 copies\n2 available\n2 available\n0 on hold\n0 on hold'), { copies: 8, available: 2, holds: 0 });
  assert.deepEqual(parseCounts('All copies in use\n24 copies\n93 on hold'), { copies: 24, available: 0, holds: 93 });
  assert.throws(() => parseCounts('8 copies\n0 on hold'), /available/);
  assert.throws(() => parseCounts('8 copies\n2 available'), /on hold/);
  assert.throws(() => parseCounts('8 copies\n9 copies\n2 available\n0 on hold'), /conflicting/);
  assert.throws(() => parseCounts('All copies in use\n8 copies\n2 available\n0 on hold'), /Contradictory/);
});

test('SPL singular copy counts work without hiding conflicting counts', () => {
  assert.deepEqual(parseCounts('All copies in use\n1 copy\n1 copy\n4 on hold\n4 on hold'), { copies: 1, available: 0, holds: 4 });
  assert.deepEqual(parseCounts('Available\n1 copy\n1 available\n0 on hold'), { copies: 1, available: 1, holds: 0 });
  assert.throws(() => parseCounts('All copies in use\n1 copy\n2 copies\n4 on hold'), /conflicting/);
});

test('SPL on-order stock is excluded from owned copies and inconsistent totals fail', () => {
  assert.deepEqual(parseCounts('All copies in use\n49 copies\n33 on order\n33 on order\n244 on hold'), { copies: 16, available: 0, holds: 244 });
  assert.deepEqual(parseCounts('All copies in use\n3 copies\n3 on order\n2 on hold'), { copies: 0, available: 0, holds: 2 });
  assert.throws(() => parseCounts('All copies in use\n3 copies\n4 on order\n2 on hold'), /On-order/);
  assert.throws(() => parseCounts('Available\n3 copies\n2 on order\n2 available\n0 on hold'), /exceed/);
  assert.throws(() => parseCounts('All copies in use\n49 copies\n33 on order\n34 on order\n244 on hold'), /conflicting/);
});

test('on-order-only records explicitly have no owned or available copies', () => {
  assert.deepEqual(parseCounts('On order\n29 on order\n29 on order\n191 on hold\n191 on hold'), { copies: 0, available: 0, holds: 191 });
  assert.deepEqual(parseLocations([], { copies: 0, available: 0 }), []);
  assert.throws(() => parseLocations([], { copies: 1, available: 0 }), /incomplete/);
  assert.throws(() => parseCounts('29 on order\n191 on hold'), /copies/);
  assert.throws(() => parseCounts('On order\n0 on order\n191 on hold'), /Contradictory/);
  assert.throws(() => parseCounts('On order\n29 on order\n1 available\n191 on hold'), /Contradictory/);
});

test('location parsing preserves not-yet-shelved copies and rejects partial tables', () => {
  const groups = [
    { available: true, count: 1, rows: [['Central Library', 'Fiction', 'CALL', 'Not yet shelved', '']] },
    { available: false, count: 1, rows: [['Lake City Branch', 'Fiction', 'CALL', 'Out', 'Tomorrow']] }
  ];
  assert.deepEqual(parseLocations(groups, { copies: 2, available: 1 }), [{ location: 'Central Library', status: 'Not yet shelved' }]);
  assert.throws(() => parseLocations(groups, { copies: 2, available: 0 }), /disagree/);
  assert.throws(() => parseLocations([{ ...groups[0], count: 2 }], { copies: 2, available: 2 }), /incomplete/);
});

test('location tables may omit Due but must retain location and status columns', () => {
  const group = { available: true, count: 1, rows: [['Central Library', 'Fiction', 'CALL', 'In']] };
  assert.deepEqual(parseLocations([group], { copies: 1, available: 1 }), [{ location: 'Central Library', status: 'In' }]);
  assert.throws(() => parseLocations([{ ...group, rows: [['Central Library', 'Fiction', 'CALL']] }], { copies: 1, available: 1 }), /columns/);
});

test('refresh access restrictions and human challenges stop collection before reading stock', async () => {
  for (const [status, title] of [[403, 'Forbidden'], [429, 'Too many requests'], [200, 'Verify you are human']]) {
    const page = {
      goto: async () => ({ ok: () => status === 200, status: () => status }),
      title: async () => title
    };
    await assert.rejects(refreshBook(page, { recordId: 'S246C123' }), error =>
      error.code === 'SPL_ACCESS_BLOCKED' && /Collection stopped/.test(error.message));
  }
});

test('ebook suggestions never enter the physical availability collector', async () => {
  await assert.rejects(refreshBook({}, { format: 'ebook' }), /do not have physical availability checks/);
});

test('refresh waits for coherent hydrated counts without refetching, but persistent contradictions fail', async () => {
  const pending = 'All copies in use\n1 copy\n1 available\n0 on hold';
  const settled = 'Available\n1 copy\n1 available\n0 on hold';
  function fixture(states) {
    let reads = 0;
    const navigations = [];
    const waits = [];
    const ready = { first: () => ({ waitFor: async () => {} }) };
    const main = {
      getByText: () => ready,
      getByRole: () => ({ innerText: async () => 'Test book' }),
      innerText: async () => 'Test author\nCurrent format, Book,\nTitle availability\n' +
        states[Math.min(reads++, states.length - 1)] + '\nAvailability by location'
    };
    const dialog = {
      getByRole: () => ready,
      evaluate: async () => [{ available: true, count: 1, rows: [['Central Library', 'Fiction', 'CALL', 'In']] }]
    };
    return {
      navigations, waits,
      goto: async url => { navigations.push(url); return { ok: () => true, status: () => 200 }; },
      title: async () => 'SPL catalog',
      getByRole: role => role === 'main' ? main : dialog,
      waitForTimeout: async delay => { waits.push(delay); }
    };
  }
  const book = { id: '1', recordId: 'S246C123', title: 'Test book', catalogAuthor: 'Test author' };
  const recovering = fixture([pending, pending, settled]);
  const row = await refreshBook(recovering, book);
  assert.equal(row.available, 1);
  assert.deepEqual(row.availableCopies, [{ location: 'Central Library', status: 'In' }]);
  assert.equal(recovering.navigations.length, 2);
  assert(recovering.waits.includes(250));
  const broken = fixture([pending]);
  await assert.rejects(refreshBook(broken, book), /Contradictory availability/);
  assert.equal(broken.navigations.length, 1);
});
