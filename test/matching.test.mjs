import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, searchTitle, sameAuthor, verifyRecord, catalogDescription } from '../scripts/match.mjs';

test('matching tolerates punctuation and catalog name order, not a different work or author', () => {
  assert.equal(normalize('Love & Saffron'), normalize('Love and Saffron'));
  assert.equal(normalize('Garc\u00eda M\u00e1rquez'), normalize('Garcia Marquez'));
  assert.equal(searchTitle('Less (Arthur Less, #1)'), 'Less');
  assert.equal(searchTitle('Evicted: Poverty and Profit in the American City'), 'Evicted');
  assert.equal(sameAuthor('J. D. Salinger', 'Salinger, J. D. (Jerome David), 1919-2010'), true);
  assert.equal(sameAuthor('Diane Wilson', 'Wilson, Daniel'), false);
});

test('uncurated descriptions label factual catalog themes rather than inventing plots', () => {
  assert.equal(catalogDescription({ subject: ['Friendship \u2014 Fiction.', 'Friendship \u2014 Fiction.', 'Immigrants \u2014 Fiction.'] }),
    'Catalog themes: Friendship; Immigrants.');
  assert.equal(catalogDescription({ genre: ['Novels.', 'Historical fiction.'] }), 'Catalog genres: Historical fiction.');
  assert.match(catalogDescription({}), /not yet curated/);
});

test('only exact English physical works pass; adaptations and unknown language require review', () => {
  const book = { title: 'Less (Arthur Less, #1)', author: 'Andrew Sean Greer' };
  const record = { title: 'Less', author: 'Greer, Andrew Sean', language: 'en', format: 'Current format, Book, 2017, First edition.', subtitle: '', fields: { title: ['Less / Andrew Sean Greer.'] } };
  assert.equal(verifyRecord(book, record), null);
  for (const change of [
    { title: 'Less Is Lost' }, { author: 'A different writer' }, { language: null }, { language: 'fr' },
    { format: 'Current format, eBook, 2017' }, { fields: { ...record.fields, edition: ['Adapted for young readers.'] } },
    { fields: { title: ['Less : a dramatization'] } }, { fields: {} }
  ]) {
    assert.equal(typeof verifyRecord(book, { ...record, ...change }), 'string');
  }
});
