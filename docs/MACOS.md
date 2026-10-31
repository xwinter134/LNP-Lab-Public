# macOS app

The web app is wrapped unchanged with Tauri 2 (a native WebView window). Nothing in `app/` changes.

## Build it (on the Mac)

You need Xcode (or just its command line tools: `xcode-select --install`) and Node.js 18 or newer
(https://nodejs.org, or `brew install node`). Rust is installed by the script on its first run.

```bash
git clone https://github.com/xwinter134/LNP-Lab-Public.git && cd LNP-Lab-Public
git checkout usability-loop           # or main, once it is merged
./scripts/build-mac.sh                # universal app (Apple Silicon + Intel) and a .dmg
./scripts/build-mac.sh --native       # only for this Mac's processor: faster, for trying it out
```

The first build compiles Tauri and SQLite and takes about 5–15 minutes; later builds take a minute or two. The result
is in `src-tauri/target/universal-apple-darwin/release/bundle/`: `macos/LNP Lab.app` and `dmg/LNP Lab_<version>_universal.dmg`.
The script opens that folder when it is done. To work on the app with live reloading: `npm install`, then
`npm run tauri dev`.

## Sending it to others

The build is signed *ad hoc*: it runs on the Mac that built it, and anywhere else macOS says it "cannot be opened
because Apple cannot check it for malicious software". The recipient opens it once like this:

1. Drag **LNP Lab** from the .dmg into Applications.
2. Right-click (or Control-click) the app › **Open**, then **Open** again in the dialog. On macOS 15 and later:
   double-click, then System Settings › Privacy & Security › **Open Anyway**.

After that it opens normally. For a double-click without this step the app must be signed with an Apple
Developer ID and notarised (Apple Developer Program, 99 €/year). The script does that when these are set:

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
APPLE_ID=you@example.com APPLE_PASSWORD=<app-specific password> APPLE_TEAM_ID=TEAMID ./scripts/build-mac.sh
```

## Data

The records live in a SQLite file in the app's data folder:

    ~/Library/Application Support/org.lnplab.app/lnp-lab.db

One row per collection (`<lab>.<collection>`, holding its JSON), written through `tauri-plugin-sql`
(`app/store.js` `sqliteBackend`). A save that touches several collections is one statement, so it is stored whole
or not at all. The real lab and the demo are kept apart in the same file. Settings › Data shows where the records are.

- **Backups:** Settings › Export everything still writes a JSON file, which is the backup to keep and the way to
  move records to another Mac (Import there). Copying `lnp-lab.db` while the app is closed also works.
- **From an earlier version of the app:** versions before 0.13 kept the records in the window's own storage
  (IndexedDB). On the first start of this version they are copied into the file, and the old copy is left alone.
- **If the file cannot be opened,** the app falls back to the window's own storage and says so in Settings › Data.
- The browser version (`npm start`) is unchanged and keeps using the browser's IndexedDB.

## Exports, printing and reminders in the app

In a browser the page saves every file (the backup JSON, CSVs, the design PDF, figures as SVG and PNG, the blank
sheet, the calendar's `.ics`) as a download: an `<a download>` on a blob URL. It prints by opening a second window
(`window.open`) and calling `print()` there, and it sends reminders with the browser's Notification API. WKWebView,
the app's window, does none of the three unless the host app handles them, and without the first a user of the app
cannot even make a backup. So the page takes a second path where Tauri is there, and only there:

- **`withGlobalTauri: true`** in `src-tauri/tauri.conf.json` puts the plugins' JavaScript API on `window.__TAURI__`. A
  browser has no such object, so it keeps the browser path unchanged.
- **Files** (`saveBlob()` in `app/ui/kit.js`, which `download()` and the figure buttons go through): the app asks
  `__TAURI__.dialog.save({ defaultPath: <file name> })` and writes the same bytes the browser would have saved with
  `__TAURI__.fs.writeFile(path, bytes)`. It needs `dialog:default` (which includes `save`) and `fs:allow-write-file` in
  `src-tauri/capabilities/default.json`; the dialog itself lets the file plugin write the path it returns, so no wider
  file scope is granted. A dialog that was cancelled writes nothing, does not count as a backup and is not reported as
  exported (a screen says "… exported" only once the file is written); a write that fails says "Not saved: … could
  not be written (…)" with the plugin's reason.
- **Questions** (`ask()` in `app/ui/kit.js`): the dialog plugin also replaces `window.confirm` with a native dialog,
  but an asynchronous one, so `confirm()` returns a promise there. Every question before something that cannot be
  undone is therefore awaited, and only an explicit OK goes ahead; a dialog that cannot be shown counts as Cancel. The
  page asks nothing through `prompt()`, which the app's window answers with null (item 8, and the smoke scenario
  `questionsWaitForTheAnswer`).
- **Printing** (`printHtml()`, used by the report and the worksheets): the app opens no second window, so the sheet is
  saved through the same dialog as an `.html` page, and a note says to open it in Safari and print it from there (or
  save it as PDF). Printing straight from the app would need Rust: a command that opens a new `WebviewWindow` on the
  sheet and calls its `print()`. That can only be built and tried on a Mac.
- **Reminders** (`app/ui/calendar.js`): the app asks `__TAURI__.notification` (`isPermissionGranted`,
  `requestPermission`, `sendNotification`) instead of `Notification`, with `notification:default`.

The smoke scenario `inAppSavesThroughTauri` stands a recording stand-in for those three APIs in a browser and checks
what the page asks of them. Whether Tauri then does its part is item 0 of the checklist below. If it does not, run
`npm run tauri dev`, right-click › Inspect Element, and in the console check that `Object.keys(window.__TAURI__)` lists
`dialog`, `fs` and `notification`; a refused permission is named in the error, and goes into the capabilities file.

## The oldest Mac it has to run on

The app window is the system's WKWebView, which is the WebKit of the installed Safari. So the oldest Safari the app
has to work in is the one that came with the oldest macOS it installs on: `minimumSystemVersion` 12.0 in
`src-tauri/tauri.conf.json`, which is Safari 15.0 (macOS 12.3 brought 15.4). Two automated checks hold that line, and
neither runs WebKit, which cannot be installed in the cloud session:

- `tests/compat.test.mjs` (part of `npm test`) reads `app/**/*.js` and `index.html` and fails on any feature newer than
  the floor, each listed with the Safari version that shipped it, unless the use is guarded and listed with the reason.
  It reads the floor from `tauri.conf.json`; raising the minimum there needs one line in the test's macOS-to-Safari table.
- The smoke scenario `runsWithoutWhatSafari15Lacks` (`npm run smoke`) runs the app in a Chromium with everything from
  Safari 15.4 on deleted, and without `crypto.subtle`, `navigator.clipboard` and `navigator.storage`.

`color-mix()` (Safari 16.2) stays for current engines, but each one sits in an `@supports` block after a plain value,
because a plain value written just before a `color-mix()` that holds `var()` does not survive in an engine without it.

The release build serves the page from `tauri://localhost`, `npm run tauri dev` from `http://localhost:8787`. Whether
WebKit treats `tauri://` as a secure context decides whether `crypto.subtle`, the clipboard and the storage API are
there at all, so test the **built** app (`npm run tauri build`), not only `tauri dev`. The app copes without each of
them; the checklist says what you then see.

## Handover-week test on a real Mac

Run it on two Macs: macOS 12 if one is available (otherwise the oldest at hand), and a current macOS. On each, run it
twice: in the built app (open `LNP Lab.app` from the `.dmg`; right-click › Open the first time, since it is not
signed), and in Safari with `npm start` and `http://localhost:8787/`. Start each run on an empty lab: a Mac where the
app has not run, or a fresh Safari profile (or Safari › Settings › Privacy › Manage Website Data › remove localhost).

Write down first: the macOS version (Apple menu › About This Mac), the Safari version (Safari › About Safari; the app
uses the same WebKit) and the app version (the end of the sidebar footer in a wide window, `0.10.0` today). For each
item note pass or fail per run, and for a fail what you saw. For errors, Safari's console is under Develop › Show
JavaScript Console (turn on the Develop menu in Safari › Settings › Advanced); in the app, `npm run tauri dev` allows
right-click › Inspect Element, the release build does not.

The fixtures used below are in the repository: `tests/fixtures/zetasizer_de.csv` (a German Zetasizer export, UTF-16)
and `tests/fixtures/zetasizer_records_en.txt` (an English one, UTF-16).

### 0. Blocking for handover: export a backup, print a report, export a figure, a reminder fires

In the built app on both Macs (and in Safari for comparison). If one of these fails in the app, the app is not
ready to hand over: a lab that cannot export a backup keeps its records in one place only. Demo mode (item 2) gives
an experiment to work with.

- [ ] **Export a backup.** Settings & export › Export everything (JSON). **Look for, in the app:** a save dialog
  offering `lnp-lab-export-<date>.json`; after Save, the file in the folder chosen, opening in TextEdit as JSON that
  starts with `"collections"`; "Last export" in the storage card showing the time. Then once more and Cancel: nothing
  is written and "Last export" stays as it was. **In Safari:** the file in Downloads. **A fail:** nothing happens, or
  "Not saved: … could not be written (…)": copy that note, it names what was refused.
- [ ] **Print a report.** An experiment with results (demo E1) › Report. **Look for, in the app:** a save dialog for
  the report as an `.html` page, then "Saved …: open it in Safari and print it from there (⌘P)"; that page opened in
  Safari prints as the report (item 7). **In Safari:** a second window with the report and the print dialog.
  **A fail:** nothing happens at all.
- [ ] **Export a figure.** On the same page, hover a figure › PNG, then SVG. **Look for, in the app:** a save dialog
  for each; the PNG opens in Preview, sharp and not blank, the SVG in Safari with the same colours.
- [ ] **A reminder fires.** Calendar: add an event dated today, then Enable reminders, and allow LNP Lab when macOS
  asks. **Look for:** "Reminders on", and at once a macOS notification "LNP Lab: due today" naming the event (System
  Settings › Notifications › LNP Lab must allow it). It fires once a day: the next morning, opening the app on a day
  with events shows it again. **A fail:** "Notifications not supported here", or no notification although macOS
  allows them.

### 1. First start

- [ ] Open the app (or the page). **Look for:** the sidebar and the Overview within a few seconds, and no "LNP Lab did
  not start" note. If that note appears, copy the list of files and errors it shows: that is the report.
- [ ] **Look for:** the sidebar footer ends with the app version; Overview shows zeros (Due today 0, Measurements
  open 0) and a Getting started card.
- [ ] The **Demo mode** switch at the bottom of the sidebar is drawn as a sliding switch, not as a square checkbox.

### 2. Demo mode

- [ ] Turn on Demo mode. **Look for:** the page reloads, the sidebar takes a faint purple tint and a DEMO chip, and the
  Experiments list holds 7 experiments.
- [ ] Open each demo experiment, then Design & results for E3, E4 and E5. **Look for:** tables, figures and the verdict
  sentences; no "Screen … failed" note.
- [ ] Optimizer › Fit model and suggest runs. **Look for:** a result within about 20 seconds, no "Model fit failed".
- [ ] Turn Demo mode off. **Look for:** the empty lab again, without the tint.

### 3. Creating each experiment type

Experiments › New, then each type in this order, so the first one is E1 (item 5 imports a file named for it):

- [ ] **Reference**, 3 repeats. **Look for:** the preview says "Formulations 3"; Create opens Experiment 1 with E1-F1,
  E1-F2 and E1-F3.
- [ ] **Single** (composition #1), **Stability** (two formulations, 28 days: the preview lists T0, T3 … T28),
  **OFAT**, and **DoE** (the default factorial: "Formulations 7"). **Look for:** each opens its own page, numbered
  E2, E3 …, with its formulations and a next-step strip with a thin blue border.
- [ ] **Comparison**: first add a second recipe under Materials & lots › Compositions. **Look for:** two arms, E…-F1
  and E…-F2.
- [ ] On the stability study's page, Copy names for next due date; on Measurements, Copy sample names. **Look for:**
  "Copied … sample names" and "… copied", and the names pasted into TextEdit. Where the clipboard is not available
  (possible in the app), the first saves `sample-names.txt` instead and the second says "Could not reach the
  clipboard". Either is a pass; nothing happening at all is a fail.

### 4. The bench record

- [ ] Add an RNA lot (Materials & lots › RNA lots) and a lipid stock (Lipid stocks › New stock; save it). **Look
  for:** the weigh-in cards, the ethanol step once every mass is in, and the stock listed as Stock-001.
- [ ] Prepare a buffer (Buffers › Prepare, any one from the shelf; save it). **Look for:** the predicted pH and the lot
  Buffer-001.
- [ ] Formulations › E2-F1. **Look for:** the "At the bench" card first, its tiles a shade darker than the card in
  light mode (lighter in dark mode), the step lines folded with a chevron each.
- [ ] Choose the RNA lot and the stock, type an RNA mass, open steps 2, 3 and 5 and type into them. **Look for:** the
  tiles and the RNA volume follow what you type; no error note.
- [ ] Save (or wait for "Saved", if the record saves as you type), open Overview, come back. **Look for:** every value
  you typed is still there.
- [ ] Print worksheet. **Look for:** as in item 7.

### 5. Importing a file (UTF-16)

- [ ] Measurements › choose the instrument's export › `zetasizer_de.csv`. **Look for:** "read as DLS + zeta · 18 rows
  → 3 samples · SHA-256 46880cdf…", "3 matched · 0 unmatched", sizes with a decimal point (82.8, not 828), no
  "Mittelwert" or "Standardabweichung" row, no "Could not parse". The SHA-256 is worked out from the decoded text, so
  it is the same in every browser and in the app; a different one means the file was read differently. If the file
  chooser does not open, or nothing appears after choosing, note it.
- [ ] Import. **Look for:** the evaluation of the import (size and PDI per sample against the QC limits); E1's results
  now show 82.8, 91.2 and 87.3 nm, dated 27 Oct 2026. A stored result's own page ends "Raw: zetasizer_de.csv ·
  SHA-256 46880cdf37fe77cf…".
- [ ] Choose `zetasizer_records_en.txt`. **Look for:** "read as DLS · 9 rows → 3 samples · SHA-256 2c1d81c1…"; its
  samples are named for E3, so they may be unmatched, with a menu to send each one to a formulation or the inbox.
  Leave it without importing.
- [ ] Type a result by hand for a DLS sample that is due, with PDI 5. **Look for:** "Not saved … PDI 5 is outside
  0–1, did you mean 0.05?" and the field marked light red; with 0.05 it saves.

### 6. The results figures and SVG/PNG export

- [ ] Experiment 1 › Results. **Look for:** the statistics sentences, the data table with mean ± SD (n) and the
  figure (open them if they are folded): bars with error bars and every run, in colour, axis labels readable.
- [ ] Hover the figure, click SVG, then PNG. **Look for:** two files (in Downloads from Safari, through a save dialog
  in the app). The SVG opens in Safari or Preview with the same colours; the PNG opens in Preview, sharp, not blank,
  on a white (light) or dark grey (dark mode) background. Nothing happening at all is a fail.
- [ ] The same on a demo DoE (Design & results › any plot) and on Insights.

### 7. Printing the report

- [ ] Experiment 1 › Report. **Look for:** in Safari a second window with the report, then the print dialog; in the
  app the report saved as an `.html` page (item 0), opened in Safari and printed with ⌘P. Either way: A4, black text
  on white even in dark mode, figures in colour, no table row split across pages, the signature line at the end.
  "Save as PDF" in the dialog gives the same pages.

### 8. Backup export and import

- [ ] Settings & export › Export everything (JSON). **Look for:** `lnp-lab-export-<date>.json` saved (note where),
  and "Last export" in the storage card showing the time.
- [ ] Import the same file (merge). **Look for:** the same number of experiments, formulations and results, nothing
  doubled.
- [ ] Import the file exported from the app into Safari on the same Mac (or the other way round), with "replace
  instead of merge". First make the lab differ from the file: open Experiment 1, press Mark done (or Reopen) and note
  its status. Then choose the file. **Look for:** the question "Replace all current data with the file contents?" in
  a dialog. Press **Cancel** first, and check that nothing changed: no "Imported …" note, and Experiment 1 still has
  the status you gave it. Then choose the file again and press **OK**: "Imported …", the same lab as in the file (the
  experiments, E1's results and the stock), and Experiment 1 with the status it had in the file. **A fail:** after
  Cancel, "Imported …" appeared or Experiment 1's status went back. The page then did not wait for the answer, and
  every other question in the app (below) goes ahead whatever is answered: note it, and do not use those buttons in
  the app on real data. A question that never appears, with nothing imported, means the window does not show the
  page's dialogs: note that too.
- [ ] In the app, in demo mode (item 2), so that nothing of yours is at stake: Settings › change PDI max, then Reset to
  defaults; Experiment 1 › Delete, then Settings › Recently deleted › Empty trash; a stored result's own page ›
  Delete; Settings › Delete all data in this browser; the sidebar's Start over. Press **Cancel** each time. **Look
  for:** the question each time, and after Cancel nothing changed: PDI max as you typed it, the experiment still in
  Recently deleted, the result still there, the demo lab whole, and no reload. Then Empty trash again and press
  **OK**: the trash is emptied.

### 9. The storage meter in Settings

- [ ] Settings & export. **Look for:** one sentence, a bar, and "Your records take … kept in this browser's database
  (IndexedDB)". On Safari 17 or later it also says how much the browser allows; on Safari 15 and 16 that part is
  missing, which is expected (no `navigator.storage.estimate()` there).
- [ ] **A fail:** it names localStorage ("because its database could not be opened"), "memory only" or "nowhere". The
  app then cannot keep a busy lab, or anything; note the exact sentence.

### 10. Closing and reopening the app (data kept)

- [ ] Quit (⌘Q), wait, open again. **Look for:** every experiment, the stock, the buffer and E1's results; the theme and
  the simple/advanced view as you left them.
- [ ] Quit straight after typing a value (within a second) and reopen. **Look for:** the value is there.
- [ ] Optional: restart the Mac and open again. Same result.

### 11. Dark mode

- [ ] System Settings › Appearance › Dark (with the sidebar's appearance switch on Auto), then Light and Dark on the
  switch itself. **Look for:** the whole page follows, text stays readable, date fields are dark too.
- [ ] In dark mode: the bench tiles a shade lighter than their card, a refused value's chip and cell faintly red, the
  next-step strip's thin blue border, the demo sidebar's purple tint. On macOS 12 these are the plain fallback colours
  and should look the same as on the current Mac.
- [ ] A figure's lines and labels are visible on the dark card, and the printed report (item 7) is still on white.

### What only a Mac can settle

- Whether WKWebView treats `tauri://localhost` as a secure context: `crypto.subtle` (the SHA-256 of an import, item 5),
  the clipboard (item 3) and `navigator.storage` (item 9). The app copes without each; the items say what you see.
- Whether IndexedDB opens and keeps the records in the built app, and how much it may use (items 9 and 10).
- Whether `window.__TAURI__` is there in the built app with `dialog`, `fs` and `notification`, and whether the save
  dialog, the file write and the notification then work with the permissions granted (item 0). The page's side is
  tested in a browser with a stand-in; Tauri's side is not.
- Whether the page waits for the answer to its own questions in the app window (item 8). tauri-plugin-dialog shows
  `confirm()` there as a native dialog, but asynchronously, so `confirm()` returns a promise instead of the answer;
  read as an answer, a promise is yes, and the action ran before the question had even appeared. The page now awaits
  every answer (`ask()` in `app/ui/kit.js`), and the smoke scenario `questionsWaitForTheAnswer` checks it against the
  plugin's confirm in a browser; only a Mac shows whether the real dialog behaves the same. So press Cancel first and
  check that nothing changed, then OK. The failure to look for is an action that has already happened when the
  question appears, or happens after Cancel; a question that never appears, with nothing done, means the dialog
  permission is missing. Nothing asks through `prompt()` any more, which WKWebView answers with null.
- Whether the app window opens the file chooser (items 5 and 8). WKWebView does not unless the app provides it.
- How the CSS degrades on Safari 15: the `color-mix()` fallbacks (item 11), `accent-color` (checkboxes in the system
  accent instead) and `:focus-visible` (the folds keep the system focus ring).
