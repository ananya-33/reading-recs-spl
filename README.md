# Ananya's next read

A local-first reading picker using your unread Goodreads export, seasonal shelves,
and checked physical-book availability at The Seattle Public Library.

## Run locally

Install Node.js 22 or newer. From this folder:

```sh
npm ci
npx playwright install chromium --only-shell
npm run import -- "absolute path to goodreads_library_export.csv"
npm run refresh
npm start
```

Open <http://127.0.0.1:4173>. On Windows, use `npm.cmd` and `npx.cmd` if
PowerShell blocks the corresponding `.ps1` launcher. On macOS, use `npm` and `npx`.

- Import again when you want to replace the Goodreads starting snapshot.
- Run `npm run match -- 25` to inspect up to 25 unmatched books. It resumes
  from an ignored local checkpoint; use a larger limit for a deliberate full run.
- Refresh again to retrieve current availability. This is not scheduled yet.
  If a long refresh is interrupted, `npm run refresh -- --resume` reuses fresh
  successes from `.local/refresh.json` and checks missing, failed, or stale rows.
- Run `npm test` for local tests. Browser tests use fictional fixtures, not SPL.
- Stop the local server with Ctrl+C.

## How the files fit together

When you press **Recs please!**, the website reads your book list and the last
saved library check. It chooses books that fit the rules, then shows their
titles, descriptions, and availability. Each file below has one part of that job.
JSON files are simply saved lists of information that the programs can read.

### Browser files: `public/`

- **`index.html`** says what appears on the page: the greeting, buttons, loading
  screen, and spaces for book details. Changing a button's wording starts here.
- **`styles.css`** says how those things look: beige background, fonts, spacing,
  moving leaves and waves, and the smaller-screen layouts. The sections go from
  shared appearance to each screen, then tablet and phone adjustments.
- **`seasons.js`** keeps the four seasonal drawings and messages in one place.
  For example, it supplies the waves and beach-reading message for summer.
- **`recommendations.js`** decides which books to suggest. It checks the current
  season, your saved read/defer choices, and the library counts. For example, it
  leaves out a book with five holds rather than recommending it.
- **`app.js`** makes the buttons work. It reads the saved book information, asks
  for suitable choices, puts them on the screen, and remembers your feedback.
  It also replaces books after feedback and explains when something has gone wrong.
- **`data/catalog.json`** connects a book on your list to the correct SPL page.
  It currently contains 310 checked matches with short, original synopses.
  Goodreads and SPL use different book IDs, so both IDs are needed here. A
  selected library edition can differ from the edition in your Goodreads export.
  Confirmed ebook suggestions have `format: "ebook"` and `editionCheckedAt`;
  entries without a format remain physical books.
- **`data/library.json`** is the website's clean copy of your TBR: titles,
  authors, book IDs, ISBNs when present, and seasonal shelves. The import command
  creates it without copying reviews or private notes. This sanitized list is public.
- **`data/availability.json`** is the last saved answer from SPL: how many copies
  and holds each checked book has, where copies are available, and when they
  were checked. It saves an error if a check fails, rather than inventing counts.
  This snapshot is public; it contains no library-account data.
- **`assets/`** contains the actual picture and font files: shelf, paper texture,
  spring flower, and lettering. The font license files state how those fonts
  may be used. There are no decorative book covers.

### Local scripts: `scripts/`

- **`match.mjs`** searches the unread TBR for physical SPL editions. It compares
  normalized titles and author names, checks English catalog metadata and
  standard-book format, and flags adaptations for review. It saves results and
  source metadata in ignored `.local/matching.json`, outside the served website.
  Verified candidates need an audit review before they are added to the
  recommendation catalog. After reviewing the audit, run
  `npm run match -- --apply` to add verified entries locally. Existing descriptions
  are preserved. New entries require a short, source-grounded synopsis in
  `.local/descriptions.json`; promotion stops if one is missing. Library subject
  headings are matching-audit metadata, not substitutes for book descriptions.
  Ambiguous results are not guesses.
  It pauses between requests and stops on errors or human-verification pages;
  it does not retry around access restrictions.
- **`import.mjs`** reads the spreadsheet-style export downloaded from Goodreads
  and makes `library.json`. First it understands the CSV rows, then checks them,
  then copies only the unread-book fields the website needs.
- **`refresh.mjs`** checks SPL again and updates `availability.json`. First it
  defines how to read counts and locations, then opens the matched book pages in
  an invisible, logged-out browser, and finally saves the results. It checks
  books one at a time with pauses; it does not place holds or bypass access rules.
  Copy counts exclude stock still on order. Location tables can include or omit
  the optional due-date column; unexpected layouts are reported as errors.
  On-order-only titles have zero owned copies and cannot be recommended.
  Briefly inconsistent counts are reread locally while SPL finishes rendering;
  persistent contradictions remain errors, without retrying website requests.
  Progress is saved outside the website after each book, and access-denied,
  rate-limit, or human-verification responses stop collection without bypasses.
- **`serve.mjs`** makes the site available at `localhost:4173` on your computer.
  When your browser asks for a page, picture, or saved book list, this program
  sends that file back. It shares only the website folder, not the entire repo.

### Project support files

- **`package.json`** lists the commands you can run and the two outside tools
  the project uses: one reads CSV files; the other controls the invisible browser.
- **`package-lock.json`** records the exact versions of those tools. npm creates
  it so your Mac can install the same versions as this computer.
- **`.gitignore`** tells Git which files not to include when you eventually
  upload the project, including raw CSV files, credentials, and local audit files.
- **`test/data.test.mjs`** checks that importing does not copy private notes and
  that missing or conflicting library counts and access restrictions are reported.
- **`test/matching.test.mjs`** checks work identity, physical format, language,
  adaptation exclusions, and honest labeling of uncurated descriptions.
- **`test/recommendations.test.mjs`** checks the book-picking rules. For example,
  a book marked read should not return, and five holds should be too many.
- **`test/ui.test.mjs`** clicks through the website automatically to check that
  buttons work, feedback is remembered after reloading, and layouts fit screens.

## Current behavior and limits

- All 336 unread books from the initial import are retained locally, but only
  the 296 checked physical editions can be recommended after fresh availability
  checks. Fourteen confirmed ebooks can also appear among the eight picks.
  The remaining 26 are unresolved (including Milkiverse, left pending by request);
  this does not establish
  that SPL has no copies of them.
- Seasonal shelves boost ranking; books on other shelves or with no season
  remain eligible. This version does not infer mood from descriptions.
  Automatic seasons use Seattle time: December-March is winter, March-June
  spring, June-September summer, and September-December autumn. In March, June,
  September, and December, both shelves get an equal boost (not a double boost
  for books on both). The incoming season supplies the heading and animation.
  Choosing a season manually uses only that season until the page is reloaded.
- A physical book needs fewer than **5 holds**, at least one owned copy, and successful
  count/location checks no older than **24 hours**. Available stock is preferred
  within a seasonal ranking, followed by fewer holds per copy.
- Confirmed ebook suggestions share the eight-pick limit, seasonal preferences,
  and read/defer feedback. Within the same seasonal tier, eligible physical books
  come first. Ebooks are labeled **Ebook only at SPL**, with no physical request
  action, copy counts, or claim to meet the holds threshold. Ebook stock/holds
  are not collected; the edition-check date is not a fresh availability check.
  The physical refresh skips ebook mappings.
- Up to eight books are shown together without pagination: four columns on
  desktop (two rows for eight picks), two columns on tablets, and one vertically
  scrollable column on phones. Results can scroll on any screen when needed.
  At 1024 px wide and below, the home
  screen uses taller bookshelf artwork with a transparent wall so the site's
  parchment shows through. Shorter screens reveal fewer lower shelves to keep
  the greeting and button clear. Wider screens keep the original artwork.
  The phone home screen fits the viewport and uses a smaller "Recs please!" button.
  A smaller verified pool produces fewer picks, never fictional padding.
- **Not today** defers a book for 24 hours. **Read already** excludes it until
  this site's browser data is cleared. Neither action updates Goodreads.
- Feedback is local to this browser and origin; it does not sync to another
  computer. Storage failures are shown, not silently accepted.
- Shelf-ready Central copies, Central copies not yet shelved, and copies
  available elsewhere are described separately. Counts are snapshots, not
  reservations or guarantees of pickup timing.
- The request link opens the exact physical-edition catalog page. Sign in and
  select pickup at SPL yourself; this app never places a hold.
- Descriptions are concise, original paraphrases of SPL or publisher synopses,
  focused on the premise rather than review language or subject headings.
  They use one or two short sentences, generally around two to four card lines;
  wrapping varies with viewport width. They are maintained separately from the
  daily availability refresh, which never replaces them with catalog tags.
  Full publisher blurbs remain in the private matching audit, not the public data.
  Automatic Goodreads sync is not implemented.

## Privacy and publication

The raw export stays outside this repository. Reviews, private notes, unrelated
shelves, and read-book history are not copied into the app.

Publication of the sanitized TBR (titles, authors, IDs, ISBNs, seasonal shelves),
catalog mappings, and availability snapshots was approved for the personal
`ananya-33/reading-recs-spl` repository. These files are publicly downloadable.
Browser feedback stays in local storage and is never uploaded. Raw CSV files
and `.local/` source audits are not published.

`.github/workflows/pages.yml` tests and deploys the static `public/` folder on
pushes to `main`, a manual dispatch, or a daily schedule. The site is served
at <https://ananya-33.github.io/reading-recs-spl/>.

Daily collection runs at 13:17 UTC (5:17 a.m. Seattle standard time, 6:17 a.m.
daylight time), after tests pass. GitHub may delay scheduled jobs. It saves the
new snapshot to `main` and deploys it without requiring this computer to be on.
Manual dispatch refreshes by default; ordinary code pushes do not scrape SPL.
Pull the latest `main` before making local changes so the bot's snapshot commits
are included.

`npm run refresh -- --publish` allows a completed run with explicit per-book
failures, but requires a result for every physical mapping and fresh successful
checks from this run. Failed books remain excluded. Access restrictions,
interrupted runs, all-failed runs, and failed snapshot pushes stop deployment.
The prior site remains live; its physical checks still expire after 24 hours.
Monitor failed runs in GitHub Actions; a scheduled run is not a guarantee of
continuous fresh availability.

Local refreshes still use `npm run refresh`, followed by a reviewed commit and
push. Refreshing the Goodreads CSV remains a local import followed by a reviewed
commit and push; it is not part of the daily SPL update.

The separate manual-only `.github/workflows/validate-refresh.yml` collector is
only validates collection and does not publish. The daily collection and
publication are handled together by `pages.yml`.

The user confirmed library permission for scheduled GitHub-hosted collection.
This is not a supported public availability API. Collection remains sequential
and paced, and stops on access restrictions without bypassing them. Reconfirm
permission before expanding volume or frequency.
