import { parse } from 'csv-parse/sync';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const seasons = new Set(['autumn', 'winter', 'spring', 'summer']);
const requiredColumns = ['Book Id', 'Title', 'Author', 'ISBN13', 'Bookshelves', 'Exclusive Shelf'];

export function importGoodreads(csv) {
  // A CSV parser handles quoted commas, embedded newlines, and Excel-style ISBN cells.
  const rows = parse(csv, {
    bom: true,
    skip_empty_lines: true,
    columns(headers) {
      if (requiredColumns.some(name => !headers.includes(name))) {
        throw new Error('This CSV is missing required Goodreads export columns.');
      }
      return headers;
    }
  });
  if (!rows.length) throw new Error('The Goodreads export is empty.');
  const ids = new Set();
  return rows.filter(row => row['Exclusive Shelf'] === 'to-read').map(row => {
    const id = row['Book Id'].trim();
    const title = row.Title.trim();
    const author = row.Author.trim().replace(/\s+/g, ' ');
    const isbn13 = row.ISBN13.trim().replace(/^="(.*)"$/, '$1');
    if (!/^\d+$/.test(id) || !title || !author || ids.has(id)) {
      throw new Error(`Missing or duplicate book identity: ${id || '(empty)'}.`);
    }
    if (isbn13 && !/^\d{13}$/.test(isbn13)) {
      throw new Error(`Invalid ISBN13 for book ${id}.`);
    }
    ids.add(id);
    // Allow-list fields instead of copying reviews, private notes, or unrelated shelves.
    return {
      id, title, author, isbn13: isbn13 || null,
      seasons: [...new Set(row.Bookshelves.split(',').map(value => value.trim()).filter(value => seasons.has(value)))]
    };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: npm run import -- "path to goodreads_library_export.csv"');
  const books = importGoodreads(await readFile(resolve(input), 'utf8'));
  const output = new URL('../public/data/library.json', import.meta.url);
  const temporary = new URL('../public/data/library.json.tmp', import.meta.url);
  await writeFile(temporary, JSON.stringify({ schemaVersion: 1, importedAt: new Date().toISOString(), books }, null, 2));
  await rename(temporary, output);
  console.log(`Imported ${books.length} unread books into website data. Review before publishing; no reviews or private notes were copied.`);
}
