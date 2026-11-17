export const DAY = 24 * 60 * 60 * 1000;
const seasons = ['winter', 'spring', 'summer', 'autumn'];

export function currentSeasons(date = new Date()) {
  const month = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'numeric' }).format(date));
  const index = Math.floor((month % 12) / 3);
  // The incoming season controls the artwork; transition months boost both shelves equally.
  return month % 3 === 0 ? [seasons[index], seasons[(index + 3) % 4]] : [seasons[index]];
}

export function validateLibrary(data) {
  if (data?.schemaVersion !== 1 || !Array.isArray(data.books)) throw new Error('Unsupported reading-library data.');
  const ids = new Set();
  for (const book of data.books) {
    if (typeof book.id !== 'string' || !/^\d+$/.test(book.id) || ids.has(book.id) || typeof book.title !== 'string' || !book.title ||
        typeof book.author !== 'string' || !book.author || !Array.isArray(book.seasons) || book.seasons.some(value => !seasons.includes(value))) {
      throw new Error('A reading-library entry is invalid.');
    }
    ids.add(book.id);
  }
  return data.books;
}

export function validateAvailability(data) {
  if (data?.schemaVersion !== 1 || !Array.isArray(data.results)) throw new Error('Unsupported SPL snapshot.');
  const ids = new Set();
  for (const row of data.results) {
    if (typeof row.id !== 'string' || !/^\d+$/.test(row.id) || ids.has(row.id) || !/^S246C\d+$/.test(row.recordId)) throw new Error('Invalid SPL book identity.');
    ids.add(row.id);
    if (row.status === 'error') {
      if (typeof row.error !== 'string' || !row.error) throw new Error('An SPL error has no explanation.');
      continue;
    }
    if (row.status !== 'ok' || !['copies', 'available', 'holds'].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0) ||
        row.available > row.copies || !Number.isFinite(Date.parse(row.countsCheckedAt)) || !Number.isFinite(Date.parse(row.locationsCheckedAt)) ||
        !Array.isArray(row.availableCopies) || row.availableCopies.length !== row.available ||
        row.availableCopies.some(copy => typeof copy.location !== 'string' || !copy.location || typeof copy.status !== 'string' || !copy.status)) {
      throw new Error('An SPL availability entry is invalid.');
    }
  }
  return data.results;
}

export function validateCatalog(data) {
  const ids = new Set();
  const records = new Set();
  if (!Array.isArray(data)) throw new Error('The checked catalog mapping is invalid.');
  for (const book of data) {
    if (!book || typeof book.id !== 'string' || !/^\d+$/.test(book.id) || ids.has(book.id) ||
        typeof book.title !== 'string' || !book.title || typeof book.description !== 'string' ||
        !/^S246C\d+$/.test(book.recordId) || records.has(book.recordId) ||
        (book.format !== undefined && !['book', 'ebook'].includes(book.format)) ||
        (book.format === 'ebook' && !Number.isFinite(Date.parse(book.editionCheckedAt)))) {
      throw new Error('The checked catalog mapping is invalid.');
    }
    ids.add(book.id);
    records.add(book.recordId);
  }
  return data;
}

export function validateFeedback(value) {
  if (value?.version !== 1 || !Array.isArray(value.read) || value.read.some(id => typeof id !== 'string' || !/^\d+$/.test(id)) ||
      !value.deferred || typeof value.deferred !== 'object' || Array.isArray(value.deferred) ||
      Object.entries(value.deferred).some(([id, until]) => !/^\d+$/.test(id) || !Number.isFinite(until) || until < 0)) {
    throw new Error("Saved reading feedback is damaged or from an unsupported version. Clear this site's browser data to reset it.");
  }
  return value;
}

export function isFresh(row, now) {
  if (row.status !== 'ok') return false;
  const times = [Date.parse(row.countsCheckedAt), Date.parse(row.locationsCheckedAt)];
  return times.every(time => Number.isFinite(time) && time <= now && now - time <= DAY);
}

export function rankBooks(library, catalog, availability, feedback, preferredSeasons, now = Date.now()) {
  const matches = new Map(catalog.map(book => [book.id, book]));
  const snapshots = new Map(availability.map(row => [row.id, row]));
  return library.flatMap(book => {
    const match = matches.get(book.id);
    const stock = snapshots.get(book.id);
    // A season is a preference, not a filter. Unknown/stale stock is never "zero holds."
    if (!match || feedback.read.includes(book.id) || feedback.deferred[book.id] > now) return [];
    if (match.format === 'ebook') return [{ ...book, ...match, stock: null }];
    if (!stock || stock.recordId !== match.recordId || !isFresh(stock, now) ||
        stock.holds >= 5 || stock.copies === 0) return [];
    return [{ ...book, ...match, stock }];
  }).sort((a, b) =>
    Number(preferredSeasons.some(season => b.seasons.includes(season))) - Number(preferredSeasons.some(season => a.seasons.includes(season))) ||
    Number(a.format === 'ebook') - Number(b.format === 'ebook') ||
    (a.format === 'ebook' ? a.title.localeCompare(b.title) :
    Number(b.stock.available > 0) - Number(a.stock.available > 0) ||
    a.stock.holds / a.stock.copies - b.stock.holds / b.stock.copies ||
    a.title.localeCompare(b.title))
  );
}
