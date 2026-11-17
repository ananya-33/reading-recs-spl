import { seasons } from './seasons.js';
import { DAY, currentSeasons, validateLibrary, validateCatalog, validateAvailability, validateFeedback, isFresh, rankBooks } from './recommendations.js';

const $ = id => document.getElementById(id);
const storageKey = 'ananyas-next-read.feedback.v1';
const pendingActions = new Set();
const checkedFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
let data;
let feedback;
let batch = [];
let preferredSeasons = currentSeasons();
let generation = 0;
let ready = false;
let loadingTimer;
let noticeTimer;

// Feedback stays on this browser. Storage errors are visible, not "saved" in memory only.
function readFeedback() {
  const saved = localStorage.getItem(storageKey);
  return saved === null ? { version: 1, read: [], deferred: {} } : validateFeedback(JSON.parse(saved));
}

function notify(message, error = false) {
  clearTimeout(noticeTimer);
  $('notice').setAttribute('role', error ? 'alert' : 'status');
  $('notice').textContent = message;
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 10000 : 6000);
}

function showScreen(name) {
  for (const id of ['home', 'loading', 'results']) $(id).hidden = id !== name;
}

function updateSeasonArt() {
  const season = seasons[$('season').value];
  document.documentElement.style.setProperty('--accent', season.color);
  // Only our static illustration markup uses innerHTML; book text never does.
  $('motion').innerHTML = season.art;
  $('loading-copy').textContent = season.loading;
  $('heading').textContent = season.heading;
}

async function getJSON(path, missingMessage) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 404 ? missingMessage : `Could not load ${path} (HTTP ${response.status}).`);
  return response.json();
}

function candidates() {
  return rankBooks(data.library, data.catalog, data.availability, feedback, preferredSeasons);
}

function startBatch() {
  batch = candidates().slice(0, 8);
}

// Load files in parallel, but let Home invalidate a request that finishes later.
async function load() {
  const request = ++generation;
  const started = performance.now();
  clearTimeout(loadingTimer);
  ready = false;
  $('motion').hidden = false;
  $('load-error').hidden = true;
  $('retry').hidden = true;
  $('skip').hidden = false;
  $('skip').disabled = true;
  updateSeasonArt();
  showScreen('loading');
  try {
    const [library, catalog, availability] = await Promise.all([
      getJSON('data/library.json', 'Import your Goodreads CSV first: npm run import -- "path to export.csv".'),
      getJSON('data/catalog.json', 'The checked catalog mapping is missing.'),
      getJSON('data/availability.json', 'Run npm run refresh to create the SPL availability snapshot.')
    ]);
    if (request !== generation) return;
    data = { library: validateLibrary(library), catalog: validateCatalog(catalog), availability: validateAvailability(availability) };
    feedback = readFeedback();
    startBatch();
    ready = true;
    $('skip').disabled = false;
    $('skip').focus({ preventScroll: true });
    loadingTimer = setTimeout(showResults, Math.max(0, 4200 - (performance.now() - started)));
  } catch (error) {
    console.error('Unable to load recommendations:', error);
    if (request !== generation) return;
    $('motion').hidden = true;
    $('loading-copy').textContent = "Couldn't load your books.";
    $('load-error').textContent = error.message;
    $('load-error').hidden = false;
    $('skip').hidden = true;
    $('retry').hidden = false;
    $('retry').focus({ preventScroll: true });
  }
}

function showResults() {
  if (!ready) return;
  clearTimeout(loadingTimer);
  showScreen('results');
  renderResults(new Set(batch.map(book => book.id)));
  $('heading').focus({ preventScroll: true });
}

function locationText(stock) {
  const central = stock.availableCopies.filter(copy => copy.location === 'Central Library');
  const onShelf = central.filter(copy => copy.status === 'In').length;
  if (onShelf) return `${onShelf} at Central with shelf status "In".`;
  if (central.length) return `${central.length} at Central; ${[...new Set(central.map(copy => copy.status.toLowerCase()))].join(', ')}.`;
  if (stock.available) return 'Available elsewhere; check Central pickup options at SPL.';
  return 'No copies available now; request through SPL to join the queue.';
}

function createCard(book, animate) {
  const card = $('book-card').content.firstElementChild.cloneNode(true);
  card.dataset.bookId = book.id;
  card.classList.toggle('entering', animate);
  const matchedSeasons = preferredSeasons.filter(season => book.seasons.includes(season));
  const ebook = book.format === 'ebook';
  const fields = {
    title: book.title,
    author: book.author,
    description: book.description,
    reason: (matchedSeasons.length ? `On your ${matchedSeasons.join(' and ')} ${matchedSeasons.length === 1 ? 'shelf' : 'shelves'}.` : 'From your TBR.') +
      (book.edition ? ` ${book.edition}` : ''),
    availability: ebook ? 'Ebook suggestion' :
      `${book.stock.available} available - ${book.stock.copies} ${book.stock.copies === 1 ? 'copy' : 'copies'} - ${book.stock.holds} holds`,
    location: ebook ? 'Ebook holds and availability are not checked.' : locationText(book.stock),
    checked: ebook ? `Edition checked ${checkedFormat.format(new Date(book.editionCheckedAt))}` :
      `Checked ${checkedFormat.format(new Date(Math.min(Date.parse(book.stock.countsCheckedAt), Date.parse(book.stock.locationsCheckedAt))))}`
  };
  for (const [name, text] of Object.entries(fields)) {
    card.querySelectorAll(`[data-field="${name}"]`).forEach(element => { element.textContent = text; });
  }
  const title = card.querySelector('h2');
  title.id = `book-${book.id}`;
  card.setAttribute('aria-labelledby', title.id);
  const link = card.querySelector('a');
  link.hidden = ebook;
  card.querySelector('.ebook-note').hidden = !ebook;
  link.href = `https://seattle.bibliocommons.com/v2/record/${book.recordId}`;
  link.setAttribute('aria-label', `Request ${book.title} from SPL (opens a new tab)`);
  for (const button of card.querySelectorAll('button')) {
    button.disabled = pendingActions.has(book.id);
    button.setAttribute('aria-label', `${button.textContent}: ${book.title}`);
    button.addEventListener('click', () => replaceBook(book, card, button.dataset.action));
  }
  return card;
}

function renderResults(animateIds = new Set()) {
  $('grid').replaceChildren(...batch.map(book => createCard(book, animateIds.has(book.id))));
  $('empty').hidden = batch.length !== 0;
  const ebooks = batch.filter(book => book.format === 'ebook').length;
  $('summary').textContent = `${batch.length} ${batch.length === 1 ? 'pick' : 'picks'} from your TBR` +
    (ebooks ? `. Includes ${ebooks} ebook ${ebooks === 1 ? 'suggestion' : 'suggestions'}; ebook holds are not checked. Physical picks have fewer than 5 holds.` :
      ', each with fewer than 5 holds.') +
    (preferredSeasons.length > 1 ? ` Blending ${preferredSeasons.join(' and ')} shelves.` : '');

  const imported = new Set(data.library.map(book => book.id));
  const matched = data.catalog.filter(book => imported.has(book.id));
  const physical = matched.filter(book => book.format !== 'ebook');
  const matchedIds = new Set(physical.map(book => book.id));
  const checked = data.availability.filter(row => matchedIds.has(row.id));
  const failed = checked.filter(row => row.status === 'error');
  const stale = checked.filter(row => row.status === 'ok' && !isFresh(row, Date.now()));
  const missing = physical.length - checked.length;
  $('data-warning').hidden = !failed.length && !stale.length && !missing;
  $('data-warning').textContent = `${failed.length} failed, ${stale.length} outdated, and ${missing} missing availability checks. These books are excluded. Run npm run refresh to check again.`;
  $('footnote').textContent = `${matched.length} matched editions. Physical counts expire after 24 hours; confirm at SPL. "Not today": hidden for 24 hours. "Read already": saved in this browser.`;
}

async function replaceBook(book, card, action) {
  if (pendingActions.has(book.id)) return;
  const request = generation;
  try {
    const next = readFeedback();
    if (action === 'read') next.read = [...new Set([...next.read, book.id])];
    else next.deferred[book.id] = Date.now() + DAY;
    localStorage.setItem(storageKey, JSON.stringify(next));
    feedback = next;
  } catch (error) {
    console.error('Unable to save reading feedback:', error);
    notify(`Couldn't save that change: ${error.message}`, true);
    return;
  }
  pendingActions.add(book.id);
  card.querySelectorAll('button').forEach(button => { button.disabled = true; });
  card.classList.add('leaving');
  await new Promise(resolve => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 337.5));
  pendingActions.delete(book.id);
  if (request !== generation || $('results').hidden) return;

  // Never cycle through excluded books or duplicate a book already in this batch.
  const remaining = batch.filter(item => item.id !== book.id);
  const replacement = candidates().find(item => !remaining.some(shown => shown.id === item.id));
  const index = batch.findIndex(item => item.id === book.id);
  if (replacement) batch.splice(index, 1, replacement);
  else batch.splice(index, 1);
  renderResults(new Set(replacement ? [replacement.id] : []));
  const replacementCard = [...$('grid').children].find(element => element.dataset.bookId === replacement?.id);
  const focus = replacementCard?.querySelector(`[data-action="${action}"]`) ?? $('grid').querySelector('button') ?? $('heading');
  focus.focus({ preventScroll: true });
  notify(`${action === 'read' ? 'Saved as read.' : 'Set aside for 24 hours.'} ${replacement ? "Here's another option." : 'No more checked books to swap in yet.'}`);
}

// Navigation changes presentation; feedback is only changed by the two card actions.
$('season').value = preferredSeasons[0];
updateSeasonArt();
$('recommend').addEventListener('click', load);
$('refresh').addEventListener('click', load);
$('retry').addEventListener('click', load);
$('skip').addEventListener('click', showResults);
$('home-button').addEventListener('click', () => {
  generation++;
  clearTimeout(loadingTimer);
  showScreen('home');
  $('recommend').focus({ preventScroll: true });
});
$('season').addEventListener('change', () => {
  preferredSeasons = [$('season').value];
  updateSeasonArt();
  if (!$('results').hidden) {
    generation++;
    startBatch();
    renderResults();
  }
});
