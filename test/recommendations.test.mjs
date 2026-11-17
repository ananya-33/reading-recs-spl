import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, currentSeasons, rankBooks, validateCatalog, validateFeedback, validateAvailability } from '../public/recommendations.js';

const now = Date.parse('2026-11-12T20:00:00Z');
const feedback = { version: 1, read: [], deferred: {} };
const library = [
  { id: '1', title: 'Autumn', author: 'A', seasons: ['autumn'] },
  { id: '2', title: 'No season', author: 'B', seasons: [] },
  { id: '3', title: 'Summer', author: 'C', seasons: ['summer'] }
];
const catalog = library.map(book => ({ id: book.id, recordId: `S246C${book.id}` }));
function stock(id, changes = {}) {
  return {
    id, recordId: `S246C${id}`, status: 'ok', copies: 5, available: 0, holds: 0, availableCopies: [],
    countsCheckedAt: new Date(now).toISOString(), locationsCheckedAt: new Date(now).toISOString(), ...changes
  };
}
const choose = (rows, saved = feedback) => rankBooks(library, catalog, rows, saved, ['autumn'], now).map(book => book.id);

test('seasonal shelves boost ranking without excluding other or unseasoned books', () => {
  assert.deepEqual(choose([stock('2'), stock('3'), stock('1')]), ['1', '2', '3']);
});

test('the fewer-than-five threshold excludes five, failures, stale counts, and mismatched editions', () => {
  assert.deepEqual(choose([stock('1', { holds: 4 }), stock('2', { holds: 5 }), stock('3', { status: 'error' })]), ['1']);
  assert.deepEqual(choose([stock('1', { countsCheckedAt: new Date(now - DAY - 1).toISOString() }), stock('2', { recordId: 'S246C999' })]), []);
  assert.deepEqual(choose([stock('1', { countsCheckedAt: new Date(now - DAY).toISOString() })]), ['1']);
  assert.deepEqual(choose([stock('1', { locationsCheckedAt: new Date(now + 1).toISOString() })]), []);
});

test('read feedback persists and temporary deferrals expire at the exact deadline', () => {
  const rows = library.map(book => stock(book.id));
  assert.deepEqual(choose(rows, { version: 1, read: ['1'], deferred: { '2': now + 1, '3': now } }), ['3']);
});

test('confirmed ebook suggestions share seasonal ranking and feedback, without physical stock claims', () => {
  const books = [
    { id: '1', title: 'Winter ebook', seasons: ['winter'] },
    { id: '2', title: 'Winter print', seasons: ['winter'] },
    { id: '3', title: 'Autumn print', seasons: ['autumn'] }
  ];
  const matches = books.map(book => ({ ...book, recordId: `S246C${book.id}`, description: 'Description',
    ...(book.id === '1' ? { format: 'ebook', editionCheckedAt: new Date(now - 3 * DAY).toISOString() } : {}) }));
  validateCatalog(matches);
  const rows = [stock('2'), stock('3')];
  const chooseBooks = (saved = feedback, snapshots = rows) => rankBooks(books, matches, snapshots, saved, ['winter'], now);
  assert.deepEqual(chooseBooks().map(book => book.id), ['2', '1', '3']);
  assert.equal(chooseBooks().find(book => book.id === '1').stock, null);
  assert.deepEqual(chooseBooks(feedback, [stock('1', { holds: 500 }), stock('2', { holds: 5 })]).map(book => book.id), ['1']);
  assert.deepEqual(chooseBooks({ version: 1, read: ['1'], deferred: {} }).map(book => book.id), ['2', '3']);
  assert.deepEqual(chooseBooks({ version: 1, read: [], deferred: { '1': now + 1 } }).map(book => book.id), ['2', '3']);
  assert.equal(chooseBooks({ version: 1, read: [], deferred: { '1': now } }).length, 3);
  assert.throws(() => validateCatalog([{ ...matches[0], editionCheckedAt: undefined }]), /mapping is invalid/);
  assert.throws(() => validateCatalog([{ ...matches[0], format: 'unknown' }]), /mapping is invalid/);
});

test('invalid saved feedback and invalid counts are surfaced', () => {
  assert.throws(() => validateFeedback({ read: [] }), /Saved reading feedback/);
  assert.throws(() => validateFeedback({ version: 1, read: [], deferred: { '1': 'tomorrow' } }), /Saved reading feedback/);
  assert.throws(() => validateAvailability({ schemaVersion: 1, results: [stock('1', { holds: -1 })] }), /invalid/);
  assert.throws(() => validateAvailability({ schemaVersion: 1, results: [stock('1', { available: 1 })] }), /invalid/);
});

test('automatic seasons overlap for all four transition months in Seattle time', () => {
  const expected = [
    ['winter'], ['winter'], ['spring', 'winter'],
    ['spring'], ['spring'], ['summer', 'spring'],
    ['summer'], ['summer'], ['autumn', 'summer'],
    ['autumn'], ['autumn'], ['winter', 'autumn']
  ];
  for (const [index, result] of expected.entries()) {
    assert.deepEqual(currentSeasons(new Date(Date.UTC(2026, index, 15, 20))), result);
  }
  assert.deepEqual(currentSeasons(new Date('2026-03-01T07:59:00Z')), ['winter']);
  assert.deepEqual(currentSeasons(new Date('2026-03-01T08:00:00Z')), ['spring', 'winter']);
  assert.deepEqual(currentSeasons(new Date('2026-04-01T06:59:00Z')), ['spring', 'winter']);
  assert.deepEqual(currentSeasons(new Date('2026-04-01T07:00:00Z')), ['spring']);
});

test('overlapping shelves get one equal boost, while unrelated books remain eligible', () => {
  const books = [
    { id: '1', title: 'A winter book', seasons: ['winter'] },
    { id: '2', title: 'B spring book', seasons: ['spring'] },
    { id: '3', title: 'C both shelves', seasons: ['winter', 'spring'] },
    { id: '4', title: 'D unseasoned book', seasons: [] },
    { id: '5', title: 'E summer book', seasons: ['summer'] }
  ];
  const matches = books.map(book => ({ id: book.id, recordId: `S246C${book.id}` }));
  const ranked = preferences => rankBooks(books, matches, books.map(book => stock(book.id)), feedback, preferences, now).map(book => book.id);
  assert.deepEqual(ranked(['spring', 'winter']), ['1', '2', '3', '4', '5']);
  assert.deepEqual(ranked(['spring']), ['2', '3', '1', '4', '5']);
});
