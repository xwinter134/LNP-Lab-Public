# Handover

For whoever maintains LNP Lab next. It says how the app is put together, how to run, test and update it, how the
data is kept safe, and what is known to be unfinished. The user's side is in [GUIDE.md](GUIDE.md); what changed in
each version is in [../CHANGELOG.md](../CHANGELOG.md).

State at handover: version 0.13.0 (the macOS app with its SQLite file; checkpoint `usability-c6` is 0.12.0); see the changelog. The app is used
by one formulation scientist at a time, on their own computer.

## 1. Architecture in a page

Static files served over http: plain HTML and ES modules, no build step, no framework, no runtime dependencies, no
server-side code. Node is needed only to serve the folder and run the tests; Playwright and its Chromium only for the
browser tests; Rust and the Tauri CLI only for the macOS app.

| Path | What it is responsible for |
|---|---|
| `index.html` | The shell: sidebar and main containers, all CSS (theme tokens for light and dark), and the startup watchdog that explains a blank page after 3 s |
| `app/main.js` | The router, the sidebar (rebuilt on every navigation), the demo switch, the storage-failure note, `APP_VERSION`, the `SCREENS` list, and the test door `window.lnpDb` |
| `app/store.js` | The record store (below) |
| `app/schema.js` | Record types (JSDoc), the id scheme (`E3`, `E3-F2`, `Stock-001`, `Buffer-001`), `usedIds` and the id counters, sample-name parsing, the start-up check for orphaned results |
| `app/migrate.js` | Renames a store written under the old id schemes, once, references included |
| `app/refdata.js` | The shipped JSON merged with the user's own lipids, compositions and lots; `DEFAULT_SETTINGS` |
| `app/demo.js` | The demo namespace and the seeded demo lab |
| `app/calc/` | Pure calculations, no DOM and no store: lipid stock, batch record, buffer pH solver, experiment templates, DoE and mixture designs, diagnostics, balance (desirability), parsers, QC, statistics, results, import evaluation, insights, search, indexes, calendar export, a small PDF writer |
| `app/calc/surface3d.js` | The 3D response surface's geometry for Design & results: projection, painter's ordering, lighting, colour by height, floor contours (drawn by `surface3dSvg` in `app/ui/doeplots.js`) |
| `app/ui/customparams.js` | The lab's own custom parameters: definitions (settings record `customParams`), the values on each formulation (`batch.custom`), the card on the formulation record |
| `app/calc/ml/` | The optional optimizer: Gaussian process, models and cross-validation, desirability, acquisition, design space, feasibility (see `docs/ML.md`) |
| `app/calc/advise.js`, `designs.js` | The planner's reasoning and the design catalogue (see `docs/LEARN.md`) |
| `app/ui/` | One module per screen, each exporting `render(el, ctx)`; shared pieces: `kit.js` (html/escape helpers, fields, tables, toasts, downloads, printing), `charts.js`, `doeplots.js`, `designviz.js`, `resultsview.js`, `importeval.js`, `report.js`, `pager.js`, `searchbox.js`, `backup.js` |
| `app/learn/topics.js` | The 32 reference entries behind every `?` |
| `app/data/*.json` | Shipped reference data: lipids, the reference composition, buffer catalogue, reagents, pKa table, formulation devices, one TFF module (`tff_modules_retired.json` holds the ones earlier versions shipped, copied into a user's own list at start-up when a record names one), consumables with example dialysis devices. Literature-generic only |
| `scripts/serve.mjs` | The development server (no-cache headers) |
| `scripts/dist.mjs` | Copies `index.html` and `app/` into `dist/` for the Tauri bundle |
| `src-tauri/` | The macOS wrapper (Tauri 2) |
| `tests/` | Unit tests (`*.test.mjs`), the browser smoke test (`smoke.mjs`, `scenarios.mjs`), instrument file fixtures, and the usability tools (`usability/`) |
| `docs/` | This note, the guide and its pictures, `MACOS.md`, `ML.md`, `LEARN.md`, `MIXTURE.md`, `FORMULAS.md` (every formula) |

### The store

`app/store.js`, class `Store`. Every screen reads and writes through it, synchronously:

- **Collections** are JSON arrays by name: `experiments`, `batches` (the formulations), `measurements`, `stocks`,
  `buffers`, `events` (manual calendar entries), `inbox`, `imports`, `rnaLots`, `lipidLots`, `lipids`,
  `compositions`, `devices`, `mixers`, `tffModules`, `dialysis`, `settings`, `trash`, `counters`. The four
  device lists hold the user's own entries and their edits of shipped ones under the same id (`deleted: true`
  hides a shipped one); `getRef()` in `app/refdata.js` merges them.
- **Namespaces:** `lnp-lab` for the user's lab, `lnp-demo` for the demo. The namespace is chosen once at start-up
  (`storeNamespace()` in `app/demo.js`), and every screen goes through `ctx.store`, so no screen can reach the real
  records in demo mode.
- **In memory, then IndexedDB.** `await store.ready()` loads every collection before the first screen. Reads (`all`,
  `get`, `count`) come from memory and return copies. Writes (`put`, `remove`, `replace`) change memory at once and
  go to IndexedDB a moment later; the writes of one turn of the event loop go out as one IndexedDB transaction.
- **All or nothing.** `store.transaction(fn, { what })` wraps a save that touches several collections (a result, its
  experiment slot, the formulation status). If it cannot be stored, it is undone in memory too.
- **Failures are never thrown at the caller.** The store keeps the change, sets `store.problem` and calls `onProblem`;
  `app/main.js` shows the sticky note at the head of the screen and redraws the screen when a change was undone. The
  wording is in `describeFailure()`.
- **Backends:** `idbBackend` (database `lnp-lab`, one object store, one entry per collection keyed
  `<namespace>.<collection>`); `localStorageBackend`, the fallback where IndexedDB does not open; `memoryBackend` for
  tests; `unavailableBackend` when the database once held the records but will not open now, so that an empty lab is
  never shown and written over. Keep all storage access in this class: the planned SQLite store for the Mac app is
  meant to be a new backend and nothing else.
- **Migration from localStorage.** Before version 0.10, collections lived in localStorage under `<ns>.<collection>`.
  On start the store adopts any it finds, merges them by id, and removes the keys only once they are stored in
  IndexedDB. It runs on every start, so an interrupted move simply happens again.
- **One window writes** each namespace (`WindowRole` in `app/store.js`, cycle 6): the first one opened. Another
  window or tab on the same lab only shows the records, with a banner and "Use this window instead" (`app/main.js`);
  the store refuses its changes whole (`readOnly`, `onRefused`) and reads back what the writer stored. A takeover
  makes the writer store what it has pending first. A closed writer frees the role after 1.5 s (a reload takes it
  back); one that crashed or stopped answering, within about 5 s. The windows talk over a BroadcastChannel, or
  localStorage's storage event where there is none (Safari 15.0); the writer is named in `<ns>.window.writer`. The
  real lab and the demo each have a writer. The macOS app (one window) leaves this off. Pending writes are flushed
  on `pagehide`.
- **Backup and restore:** `exportAll()` writes the collections and nothing else; `importAll(obj, { merge })` merges by
  id or replaces whole collections, skips anything that is not a collection, never writes over a preference, and runs
  as one transaction.
- **Trash:** `moveToTrash`, `restoreFromTrash`, `recentTrash`, `emptyTrash`; entries keep where each record sat, so a
  restore puts it back in place. 30 days (`TRASH_DAYS`).

**Preferences stay in localStorage**, never in a backup: `lnp-lab.mode` (simple or advanced), `lnp-lab.theme`,
`lnp-lab.navExperiments`, `lnp-lab.demo` (the demo switch, always in the real namespace), `lnp-lab.reminders`,
`lastExport` and `lastExportAt` (when the last export was made), and dotted bookkeeping keys:
`lnp-lab.notified.<date>`, `<ns>.snooze.backup`, `<ns>.counter.<series>` (the id high-water marks),
`<ns>.hidden.orphans`, `<ns>.ui.formulations`, `<ns>.draft.experiment.<type>.<id>` (an experiment started in the
wizard and not created, one per wizard, listed as "Not created yet"; drafts of a new stock or buffer lot stay in the
window's sessionStorage), `<ns>.window.writer` (which window writes; kept by "Delete all
data"), `lnp-lab.window.message` (messages between windows without a BroadcastChannel), and `<ns>.storage.idb`,
which marks that the records have moved to IndexedDB. The keys the store treats as preferences are `PREFS` at the
end of `app/store.js`.

**Id numbers** come from `usedIds()` and the counters in `app/schema.js`, never from counting records: a new number
is above everything that was ever used (live records, the trash, measurements, the inbox, imports, calendar links)
and above the `counters` collection and the browser's own high-water mark, so neither a deleted experiment nor an
older backup can bring a number back. Formulations are numbered inside their experiment.

**Naming migration:** `app/migrate.js` (`SCHEMA_VERSION = 2`) renames stores from the old schemes (`S-001`,
`LNP_nn`) on first load, before any screen reads them. A new migration goes there too, and must leave anything it
does not recognise alone.

### The router

Hash routes: `#/<screen>?<params>`, for example `#/experiments?id=E3` or `#/formulation?batch=E3-F2`. On every
`hashchange`, `route()` in `app/main.js` closes an open explainer, drops old notices, rebuilds the sidebar, imports
`./ui/<screen>.js` and calls `render(main, { ...ctx, params })`. Each navigation takes a sequence number and only the
newest may write the screen, so a slow screen cannot paint over the one the user moved on to. A screen that throws
shows "Screen … failed" with the stack; the rest of the app keeps working.

`ctx` holds `store`, `data` (the shipped reference data), `mode` (simple or advanced), `navigate(id, params)`,
`params`, and `orphans` (the start-up check).

To add a screen: write `app/ui/<id>.js` exporting `render(el, ctx)`, add it to `SCREENS` in `app/main.js`, and add
it to the `screens` list in `tests/smoke.mjs`. The optimizer can be removed by deleting its `SCREENS` entry; nothing
else imports it.

**Start-up order** (end of `app/main.js`): reference data → `store.ready()` → naming migration → orphan check →
demo seeding if the demo store is empty → first route → `window.__lnpStarted = true`, which the watchdog in
`index.html` and every test wait for.

### Calculations and screens

`app/calc/` is pure: plain data in, plain data out, no DOM, no store, so all of it runs under `node --test`. A number
the user reads is worked out there, not in a screen, and is tested there; `docs/FORMULAS.md` lists every
batch record and stock formula. `app/ui/` renders HTML strings through `kit.js` (`html`, `raw`,
`esc`, `field`, `table`) and wires the events. Where a screen shows the same number twice (the bench card and the
step tables), both read one computed object, so they cannot disagree. Long lists render a page at a time
(`pager.js`), and lookups by formulation go through one index per render (`calc/indexes.js`), not a scan per row.

## 2. Running and updating

- **`npm start`** runs `scripts/serve.mjs` on port 8787 (`--port`, `--root`, `--host`, or `PORT=`). It sends
  `Cache-Control: no-cache` with `Last-Modified`, so a reload after `git pull` gets the new modules. A plain
  `python3 -m http.server` lets browsers keep old modules for days; old and new modules then mix and the page stays
  blank. The watchdog recognises that case and says to hard-reload.
- **`Start LNP Lab.command`** is what the user double-clicks on the Mac. It adds Homebrew's paths, checks for Node,
  opens the browser if the app is already running, otherwise runs `git pull --ff-only` (a clone with local changes
  stays on its version and says so), starts the server, waits for it and opens the browser. Closing its Terminal
  window stops the server.
- **Publishing an update to the user** is a push to the branch their clone follows (the README calls it `main`; the
  development branch has been `usability-loop`). Their next double-click pulls it. Check the version at the foot of
  the sidebar afterwards.
- **The port is part of the data's address.** Records are stored per origin, so the lab at `localhost:8787` is not
  the lab at `localhost:8788` or `127.0.0.1:8787`. The `.command` file suggests `PORT=8788` when 8787 is busy; tell
  the user that this shows an empty lab, and free the port instead.
- **Releasing a version:** bump it in `package.json`, `APP_VERSION` in `app/main.js`, `src-tauri/tauri.conf.json` and
  `src-tauri/Cargo.toml` (`tests/version.test.mjs` fails until all four agree), add a section to `CHANGELOG.md`, run
  the tests below, and keep the release as a branch (`usability-cN`), since the remote refuses tags.

## 3. Tests and benchmarks

Each usability tool's header says the same in more detail; read it before changing the tool.

| Command | What it does | Takes | Run it |
|---|---|---:|---|
| `npm test` | `node --test`: every `tests/*.test.mjs`, about 350 tests of the calculations (checked against values worked out by hand and textbook statistics), the store with fake backends, parsers on the realistic fixtures in `tests/fixtures/`, the id rules, the reference content, the version strings | 20 s | After every change |
| `npm run smoke` | `tests/smoke.mjs`: serves the app, opens the 15 screens and their parameterised variants, runs about 50 end-to-end scenarios from `tests/scenarios.mjs`, and the startup watchdog cases (merge-conflict markers, a missing module, a syntax error, broken JSON, a stale cache, a slow start). Fails on any page or console error. `SCREENSHOTS=1 npm run smoke` also rewrites `docs/screenshots/`, the README's pictures | 3–4 min | Before every push. Run it twice before a release: one smoke scenario has failed intermittently (K7 below) |
| `npm run scale` | `tests/usability/scale.mjs`: seeds a busy lab of 6 months straight into the store and times the daily screens against an 800 ms budget (median of 3). Options: `--months 12`, `--budget`, `--runs`, `--out docs/usability/scale-12m.json`, `--quota` (what the user sees when storage is full) | 5 s at 6 months | After any change to lists, indexes, the store, or code that loops over records. At 12 months before a release |
| `node tests/usability/session.mjs --cycle N` | The scripted usability session: a newcomer and an expert work through 39 tasks (materials, buffers, every experiment type, the bench, imports, DoE, optimizer rounds, a full disk, export and restore) against the simulated lab in `lab.mjs`, logging every action with a time estimate for a person. **Deletes and rewrites `docs/usability/cycle-N/`** | about 3 min | Once per usability cycle |
| `npm run campaign` (`node tests/usability/campaign.mjs`) | Closed-loop optimizer campaigns with the app's own modelling code (no browser) against a simulated lab with a known optimum, compared with random runs and a CCD on the same budget. Options: `--seeds 10`, `--rounds 6`, `--q 4`, `--mode balanced\|exploit\|explore\|split`, `--lab standard\|hard`, `--out docs/usability/campaign-….json` | about 30 s per seed | After any change under `app/calc/ml/` |
| `node tests/usability/crawl.mjs` | Opens every screen and record of the demo lab in a fresh profile, clicks every distinct control, types odd values (−1, 0, 1e9, letters, nothing) into every input, and reports page errors, console errors, "Error:" notices and blank screens. Options: `--max 70` controls per screen, `--only <hash prefix>`, `--out docs/usability/crawl.json`. Exit 1 when it finds anything | 5 min | Before a release, and after changing a screen's controls |
| `node tests/usability/guide-shots.mjs` | Rebuilds the pictures in `docs/guide/` for the user guide. `--only <name>` for one | 45 s | After changing a screen the guide shows; look at the pictures before committing them |

The browser tests need the `playwright` package and its Chromium; the scripts look for it in `node_modules` and in
two global locations (see the top of `tests/smoke.mjs`). Scenarios and the usability tools read and write records
through `window.lnpDb` (`read`, `write`, `flush`, `failWrites('QuotaExceededError')` to simulate a full disk,
`engine`), never through a storage engine, so they survive changes to the store. A new scenario is pushed onto the
`scenarios` array in `tests/scenarios.mjs`.

## 4. Building the macOS app

See [MACOS.md](MACOS.md): Xcode command line tools, Rust, `npm install`, icons, then `npm run tauri dev` to run and
`npm run tauri build` for `LNP Lab.app` and a `.dmg`. `npm run dist` copies the web files into `dist/` for the
bundle. The app declares macOS 12.0 as its minimum (`src-tauri/tauri.conf.json`) and runs on the system's WKWebView,
which follows the installed Safari. Its records live in that WebView's own storage, separate from any browser on the
same Mac, so a user moving from the browser to the app moves their data with a backup and a restore.

## 5. Data safety

- **Where the data is:** the browser's IndexedDB for the origin the app was opened at, per browser profile; the
  macOS app has its own. Clearing the site's data, or a browser evicting it on a full disk, deletes everything. The
  app asks for persistent storage at every start (`navigator.storage.persist()`), and Settings shows whether the
  browser agreed.
- **Backups** are the only copy outside the browser. Settings exports every collection of the current namespace as
  `lnp-lab-export-<date>.json`; the overview reminds the user when the last export is 7 days old and something has
  changed (`app/ui/backup.js`; the demo never reminds). Not in a backup: preferences, the other namespace, the
  shipped reference data, and the instrument files, of which only the name and SHA-256 are kept with each result.
- **Restore** (Settings › Import JSON) merges by id, or replaces each collection the file holds, as one transaction.
  It tolerates damaged files and files from older versions, and reports what it skipped.
- **Ids are never reused** (see the store section). The cost of getting this wrong was real: in cycle 3 a deleted
  experiment's number was given out again and its results attached to the new experiment. The start-up check
  (`orphanedResults` in `app/schema.js`) reports results whose formulation is gone, on the overview, and changes
  nothing.
- **The trash** holds deleted experiments (with their formulations), stocks and buffers for 30 days, with Undo on
  the notice and Restore in Settings. Measurements are never deleted with an experiment. Deleting a single result,
  dropping an inbox row and removing a manual calendar entry are permanent. Results are otherwise append-only: a
  correction keeps the old values, the reason and the date in the result's `history`.
- **Deleting a material other records name** (UX revision 2) asks first, naming those records, and then keeps
  what they calculate with on them, so no number changes silently: a formulation gets its RNA lot's concentration,
  cargo and own mass per phosphate on `plan.rna`; a stock gets a copy of a deleted lipid lot in `stock.lotRecords`
  (its purity correction); a TFF step gets its module in `moduleRecord`; a process gets its instrument or mixer in
  `deviceRecord` / `mixerRecord` (read by `deviceOf` / `mixerOf` in `calc/process.js`). A deleted buffer lot,
  stock or dialysis device is kept by name, with its pH, mM and ionic strength already on the process. The records
  show the item as "(deleted)". Two are still refused, because the records hold nothing to keep: a composition a
  formulation reads its recipe from, and a lipid a recipe or a stock uses (its MW).
- **Freeze–thaw** (`calc/freezethaw.js`): `thaws: [{date, operator, note, at, batchId?}]` on a stock or a lipid lot
  (lots only of lipids with `trackFT`); the count is the list's length; the warning threshold is
  `settings.ftWarnCycles` (5).
- **A full disk** (or a browser that refuses storage) makes a write fail with `QuotaExceededError` or similar. The
  store keeps the app usable, undoes a multi-collection save it could not store, and the note at the head of every
  screen says plainly what happened and what to do (export, free space, Try again) until a write gets through. With
  IndexedDB the limit is a share of the disk, so this should be rare. Simulate it with
  `window.lnpDb.failWrites('QuotaExceededError')`, `npm run scale -- --quota`, or session task T39.
- **If IndexedDB will not open** after the records were moved there, the app shows nothing and accepts nothing, and
  says to reload, rather than show an empty lab the user might start filling.

## 6. Known limits and open items

**Not tested here, and must be before the Mac app is handed out**

- **WebKit / Safari / WKWebView.** Only Chromium is available in the environment the app was developed in. None of
  the browser tests has run on WebKit. Run the Mac test plan in [MACOS.md](MACOS.md) on a Mac, in Safari and in the
  built app.
- **The web code calls no Tauri API.** Exports (JSON, CSV, SVG, PNG, `.ics`) are browser downloads of a blob,
  printing opens a new window (`window.open`) and calls `print()`, and reminders use the browser Notification API.
  The Tauri plugins wired in `src-tauri/` (dialog, fs, notification, opener) are not used from JavaScript. Check on a
  Mac that the built app saves an export, opens the print window and shows a reminder. If downloads do nothing in
  the app, its users cannot make a backup from it. (The comment in `src-tauri/src/lib.rs` still says the store is
  in localStorage; it is IndexedDB, with localStorage as the fallback.)
- **macOS 12.0–12.2** ship Safari 15.0–15.3, which lack features the app used (`Object.hasOwn`, `structuredClone`,
  `Array.prototype.at`, CSS `color-mix()`). Cycle 5 is replacing them (K5); check `MACOS.md` for the floor that was
  actually tested.

**Open items from the usability reports** (cycle 5; most have been closed since)

| # | Item |
|---|---|
| K2 | The optimizer did not say when to stop; it kept leading with "Run next" when another round was unlikely to help |
| K3 | "Best so far" is a single measurement; the model's pick does better in every simulated campaign |
| K4 | A save that failed on a full disk lost what was typed into the wizard; "Try again" retried nothing |
| K5 | macOS 12.0–12.2 could not create an experiment; Safari before 16.2 dropped some colours |
| K6 | The bench record kept typed values only until you left it, without a warning |
| K7 | An intermittent "Loading …" that stays after opening a search hit (seen in smoke runs, never reproduced in isolation) |
| m1 | The longest pages: the stability experiment page, Measurements after a few weeks, Insights, the experiment page after an optimizer round |

**Older open items**

- No XLSX import (export CSV from the instrument), no potency assay parser, no reading of the Zetasizer's own
  measurement files.
- The SQLite store for the Mac app (`tauri-plugin-sql`) is planned, not started.

**Found while writing the guide** (not fixed; candidates for the next cycle)

- **In the demo lab, the optimizer's default factors give impossible recipes.** Cholesterol varied in the demo's
  DoE, so it is ticked as a factor and the helper lipid is left to balance: every suggestion needs a negative DSPC
  (−13.9 mol% for the first), the table does not say so, and only a confirm dialog on "Create an experiment" warns.
  Accepting it stores a composition with DSPC −13.9.
- The README calls the stock weigh-in "purity-corrected"; it is not, by design (see the header of
  `app/calc/lipid_stock.js`).

**By design, and worth knowing**

- One user, one computer, no server, no sync, no accounts. "Operator" is free text. There is no audit trail beyond
  the correction history.
- Two windows on one lab: one writes, the other only shows the records. Two computers do not stay in step, except
  by backup and restore.

## 7. The usability evidence, and running another cycle

Six cycles so far, each with a report in `docs/usability/cycle-N/report.md` (the reports of the earlier cycles are
not part of this public repository; the tools below write a new cycle's into that folder): what was tested, the session at a
glance (tasks completed, page errors, feature probes, an estimate of a person's time, words per screen), the
findings by severity, the recommendations split into one area per agent, and a "What changed" section added after
the work. Beside each report:

- `summary.json`: tasks, probes and observations;
- `actions.jsonl`: every action, with its time estimate;
- `truth.json`: every formulation the simulated bench made, with its true score;
- `shots/` and `downloads/`: the screens and files the session saw.

Also in `docs/usability/`: the optimizer campaigns (`campaign-*.json`), the 12-month scale run (`scale-12m.json`)
and the crawl (`crawl.json`).

**To run cycle 6:**

1. Keep the state you are testing as a branch, `usability-c5` (the remote refuses tags).
2. Add tasks and probes for what changed to `tests/usability/session.mjs` (the next task is T40). A probe is a yes/no
   check of something good bench software does; keep the old ones, so the score compares across cycles.
3. Run `node tests/usability/session.mjs --cycle 6`, then the crawl, `npm run scale -- --months 12`, and the campaign
   if the optimizer changed.
4. Write `docs/usability/cycle-6/report.md` by hand from `summary.json` and the shots, in the shape of the earlier
   reports, ending with recommendations: one area each, in separate files, so the agents or people working on them
   in parallel do not collide.
5. After the fixes: merge, `npm test`, `npm run smoke` twice, bump the version, add the changelog section, rerun
   `tests/usability/guide-shots.mjs` if screens in the guide changed, and add "What changed" to the report.
