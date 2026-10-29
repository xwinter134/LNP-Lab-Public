# Changelog

What changed for you, version by version, newest first. Most versions are the work of one usability cycle: a
scripted session against a simulated lab found the problems, and the version fixed them. This public repository
starts at 0.15.0; the entries before it describe how the app got there.

The version you are running is shown at the foot of the sidebar.

## 0.15.0: siRNA or mRNA, one view, a real 3D surface, Insights you can ask anything

From the user's second review (October 2026).

- **One view.** The "Show advanced options" switch is gone: every field shows. The DoE wizard's seed, axial
  distance and plate wells fold under one line beside the design.
- **siRNA or mRNA.** The cargo is set on the RNA lot (with an editable mass per phosphate for N/P) and follows into
  the experiment and every formulation; labels say "siRNA per formulation", N/P defaults follow the cargo
  (around 3 for siRNA, 6 for mRNA). Old records read as mRNA.
- **Freeze–thaw cycles.** Lipid stocks, and lots of lipids marked "track freeze–thaw", log each thaw ("Thawed
  today"); pickers show "· 3 F/T", with a warning past the limit in Settings.
- **Every material can be deleted**, with Undo. When records still use it, the question names them, and they keep
  a copy of what they calculate with. A composition a formulation reads its recipe from, and a lipid a recipe
  uses, are still refused, with the reason.
- **Buffers.** One ionic strength everywhere (the process designer and the buffer designer disagreed), recipes aim
  at the pH a meter reads, the speciation table is at the designed pH, the common buffers are grouped by where
  they go in the process, and prepared lots can be picked in the process designer. The demo has its buffer lots.
- **Unfinished experiments are kept.** An experiment started in the wizard and left shows under "Not created yet"
  in Experiments, in the sidebar and on the Overview, with Continue and Discard; it survives closing the tab.
- **Mixers as a process variable.** KNAUER IJM 1 to 5 are listed (enter their dimensions from the datasheet). An
  OFAT can compare mixers, and a DoE can take the mixer as a two-level factor (the surface is drawn at one mixer).
- **Design catalogue.** "More about …" opens across the whole width with the arrow on the left, and every fold is
  closed again when you come back.

- **The fitted surface in 3D is a surface.** Height is the predicted response, on a z axis with ticks and the
  response's unit; faces are coloured by height (with a legend) and shaded by how they face the light, painted
  far to near; the box has ticks and names on x, y and z; the measured runs stand at their measured value, filled
  above the surface and open below, with a line to it and down to the floor, where the contour map is drawn.
  Drag or use the arrow keys to turn it, Reset view or a double-click to go back. The pinned figure on Design &
  results has the same Contour / 3D switch, both follow one choice, and it is remembered. SVG and PNG save the
  view shown.
- **The optimizer says where its data comes from.** A Data used card lists every experiment it reads (the
  formulations each gives, the results they carry, links to the experiment and its results), every formulation
  left out and why, and a tick to leave an experiment out, which is remembered. The header says "fitted on N
  formulations from M experiments" instead of "N usable runs".
- **Insights explores.** Any result against any parameter: the process, the recipe, every lipid lot, the stock,
  the RNA lot, operator, device, mixer, buffer, weekday, date, any other field on the records (a cargo or a
  freeze–thaw count appears by itself) and your own **custom parameters**, defined on Insights and filled in on
  each formulation record or for a whole experiment at once (a pasted column fills down). The chart follows
  from the choice; a sentence says what it shows, a table compares the groups (mean ± SD, n, difference from the
  others, Welch t or one-way ANOVA). Also a correlation map, process capability (Cpk) against the QC limits, and
  a CSV of every formulation with its lots and custom parameters.

## 0.14.0: enter results and see them on one screen; quick formulations and a process designer

From the user's review of the UI and the workflow (October 2026).

- **Design & results is the place for results.** Every experiment is listed, not only DoE and OFAT (7 of 7 in the
  demo). Each opens on its data sheet: samples as rows, numbers as columns, like a spreadsheet; what is stored is
  filled in, what is due is typed or pasted from Excel, one stage or stability timepoint at a time. Saving redraws
  the statistics and the figures on the same screen. A figure stays pinned at the side while the page scrolls: the
  fitted surface, the design before there is a model, the lead figure for every other type. The DoE wizard pins
  the design figure the same way while it is set up. Measurements, the import evaluation, the experiment page and
  a finished formulation all lead there.
- **Quick or full formulation.** Quick: say the volume to make for the whole experiment (each formulation can
  change it) and the mRNA in mg, the phases and the pump flows follow; no dilution, dialysis or TFF. Full: the
  six-step record as before. A **Finish formulation** button closes a record and goes on to the next one.
- **Process designer.** Device (KNAUER NanoScaler, NanoAssemblr Ignite, syringe pumps, the three-pump lab
  layout), mixer (T-mixer, impinging jet, microfluidic chips), inline quench, the aqueous and quench buffers (type,
  pH, mM, ionic strength) and the downstream steps (dialysis, TFF, dilution, filtration with their exchange
  buffers), drawn as a schematic in the wizard, on the experiment and on every formulation record and worksheet.
  Aqueous pH and ionic strength can be OFAT/DoE factors.
- **Materials.** Lipid classes coloured with a colour-blind-safe palette and a letter (I, H, S, P). Lot numbers and
  your own compositions can be edited afterwards, with what depends on them named first. TFF modules cut to one
  example, a Dialysis tab and a Formulation devices tab, each with your own entries.
- **Design catalogue.** A small figure per design, one line each, the details under "More"; Simple experiments
  (single, reference reproducibility, compare compositions) first.
- **Experiments list.** Grouped in progress / planned / done, each experiment opening to its formulations, with
  Expand all and Collapse all.
- Screens, records and tabs open at the top. The default lipid stock is 50 mM. The new purple-blue app icon.

## 0.13.0: the Mac app keeps its records in a database file

- **SQLite in the macOS app.** The records live in one file, `lnp-lab.db` in
  `~/Library/Application Support/org.lnplab.app/`. Each save is stored whole or not at all. Records an earlier
  version of the app kept in its window are moved into the file on the first start. The browser version is unchanged.
- **Build it yourself:** `./scripts/build-mac.sh` makes `LNP Lab.app` and a `.dmg` for Apple Silicon and Intel Macs,
  signed ad hoc, or with a Developer ID and notarised when those are set. See `docs/MACOS.md`.
- **An app icon.**

## 0.12.0: one window, imports you can trust

Usability cycle 6, checkpoint branch `usability-c6`.

**One window writes.** The first window on your lab writes. A second window or tab opens read-only, with a banner,
and its record fields are locked so nothing typed there can be lost. "Use this window instead" moves the writing
over, after the other window has stored what it had pending. Two windows used to write over each other.

**Imports you can trust.** Samples whose names end in a number ("LNP-1", "LNP-2", "Sample 6") are no longer averaged
as the runs of one sample. A file you have already imported is flagged and left unticked. With a QC limit switched
off, no sentence claims results are inside it.

**Insights compares like with like.** A stock-lot or operator effect is judged at matched settings (or with the
recorded factors taken out), not against the spread of designed experiments, and it says when there are too few
batches to tell. The control chart starts from the batches that repeat a setting.

**Also:**
- Saves that fail on a full disk undo the whole action, inbox and import records included.
- The number a form shows is the number stored.
- The buffer catalogue opens each buffer with its own recipe.
- The DoE screen speaks lab language (FRR, total flow, PEG mol%, N/P).
- Notices no longer cover charts.
- Several small fixes.

## 0.11.0: ready to hand over

Usability cycle 5, checkpoint branch `usability-c5`.

**The optimizer says when to stop, and which run to trust.** The results open with one sentence. When another round
is unlikely to beat your best run, it says to stop and offers to confirm the best candidates instead (a repeat of the
model's pick and the predicted optimum made twice). When a round is still worth it, it says that. The thresholds come
from simulated campaigns against a lab whose optimum is known. Stopping where the sentence says saved about 7 of 32
batches and gave up very little. The run to take forward is the model's pick, not the luckiest single measurement,
and "best so far" says how often it was made. Suggestions no longer propose recipes that cannot be weighed out (the
demo used to suggest −13.9 mol% DSPC). The predicted interval for a run now includes the batch-to-batch noise.

**Nothing you type is lost.** The bench record, a stock or buffer lot on record, and the settings are stored as you
type, with a quiet "Saved" in the header; the Save buttons are gone. A new stock, buffer or experiment keeps a draft
and offers it back when you return. If the browser refuses a save (a full disk), you stay where you were, with
everything you typed, and the note says what to do. Changing a made stock's composition asks before it discards
weighed masses.

**The Mac app.** It now runs on macOS 12 (Safari 15), which could not create an experiment before. Exports and
backups go through a save dialog, print sheets are saved as a page to print from Safari, and reminders use the
system's notifications. **In the Mac app, Cancel did not cancel**: "Delete all data", a replacing import, emptying
the trash and deleting a result ran whatever you answered. Every question now waits for the answer.
`docs/MACOS.md` has a checklist to run on a real Mac before handing over.

**Shorter pages.** The stability experiment page, Insights, the experiment page after an optimizer round and
Measurements after a few weeks lead with what they found; figures, method text and long tables fold under a line that
says what they hold.

**Fixed:** step 5 of the bench record (Final formulation & filtration) never stored what was typed and threw on every
keystroke, since the public edition. A second press on "Create" during a slow save made a duplicate. Two windows on one
bench record undid each other's typing (still possible for Settings and some other cases; see the cycle 5 report).

**Documentation:** a user guide with pictures (`docs/GUIDE.md`), a note for the next maintainer (`docs/HANDOVER.md`)
and this changelog.

## 0.10.0: a year of data

**Your records have room for years.** They now live in the browser's database (IndexedDB) instead of its small
key-value store, which filled up after about six months of a busy lab, after which every save failed. A year of a
busy lab (520 experiments, 2,561 formulations, 5,694 results) now fits. The first start of this version moves your
records over by itself and removes the old copies only once the move is stored.

- **A save is stored whole or not at all.** A result, its experiment's progress and its formulation's status are
  saved together. If the browser cannot store them, the change is undone and a plain note at the top of the screen
  says what happened and what to do ("Not saved: this browser's storage is full …"). It stays until saving works
  again. Before, the message was a programming error, and a save could stop halfway.
- **Settings shows the storage:** how much your records take, what the browser allows, whether it has agreed to keep
  them when the disk runs low, and when you last exported. The app now asks the browser to keep its data.
- **The overview reminds you to back up** when the last export is a week old and something has changed since, with
  **Export now** and **Remind me tomorrow**.
- **A number is never given out again**, not even after a deleted experiment has left the trash, and restoring an
  older backup cannot lower the count.
- **Fast with a year of data.** The Formulations list took 10 seconds with 2,561 formulations; it now opens in under
  a tenth of a second. Long lists show a page at a time.
- **Measurements opens on what is due:** overdue, today and the next seven days, one line per experiment and stage,
  each with its own Copy names, Blank sheet and Grid. Importing and typing in a single result fold to one line, and
  the results list can be filtered and paged. The page is a third as long as before after two weeks of work.
- **The DoE screen reads the fit for you:** one sentence on whether to believe it (a run that stands out, lack of
  fit, too many terms, a curve or a funnel in the residuals, residuals that are not normal) beside the one plot that
  shows the problem. The other diagnostic plots fold away. Axis labels lose "−0" and repeated ticks.

## 0.9.0: numbers you can trust, files as instruments write them

**Fixed: a deleted experiment's number was given to the next one,** and the deleted experiment's results then
appeared as results of the new one, in its Results card, the optimizer and the exports. Experiments, formulations,
stocks and buffers are now numbered past every number that was ever used, including the trash and results that
still name a deleted formulation. At start-up, the overview lists any result whose formulation no longer exists;
nothing is changed without you.

- **A DoE or OFAT factor on PEG, ionizable or helper mol% keeps the recipe at 100 mol%:** cholesterol takes up the
  difference. Before, every bench record of such a design said the recipe totalled 100.25 mol% and left the decision
  to the operator. The run table has a "Cholesterol (balance)" column, the bench record names the lipid that took up
  the difference, and the stock weigh-in opens with the recipe actually to weigh out. Older records are read the same
  way.
- **The default blend × process design can be fitted.** It used to stop with "singular design".
- **The bench record opens on the step the batch is at.** The other steps fold to a line with their state and key
  numbers, which halves the page.
- **The results grid takes up to three DLS runs per sample,** so typed results keep their SD.
- **A printable notebook report** from the experiment page and from the DoE screen: plan, data table, statistics,
  numbered figures, the DoE recommendation and diagnostics, and lines for signatures.
- **Instrument files as they come:** UTF-16, UTF-8 and Windows-1252; comma, semicolon or tab, chosen from the file;
  metadata lines above the header; German Zetasizer column names; units in the headers; summary rows dropped; size
  and zeta records split; dates in any common format; blanks and standards left out of RiboGreen plates. A German
  UTF-16 export matches every sample.
- **Insights leads with what it found:** the largest stock-lot or operator effect against the batch-to-batch SD,
  drift in the latest batches, and points outside the control limits.
- The optimizer reads a DoE batch's recipe as it was weighed out, not the registry recipe.
- Fixed: a slow screen could be painted over the one you had already moved on to.

## 0.8.0: statistics, corrections, search and undo

- **Stability studies:** one table with the days as columns, in place of three lists that repeated each other; a
  slope per formulation and shelf with its 95 % confidence interval, and the day it would reach the QC limit.
- **Comparisons and repeats with two or more batches per arm** get a test between the arms: Welch's t for two arms,
  one-way ANOVA with Holm–Šídák comparisons for more.
- **Repeat as new** opens the wizard filled in from an earlier experiment.
- **One blank sheet for every test:** it carries a column for each test still due (size, PDI, zeta, EE), and one
  import stores them all.
- **A stored result can be corrected,** with a reason. Its earlier values are kept in its history. Before, the only
  way was to delete it and type it again.
- **The import preview names the expected samples missing from the file,** and fills in a lone unmatched row by
  elimination.
- **The DoE screen leads with the conclusion:** the recommended setting, then a sentence per response on what drives
  it, then the plots. The run table, the coefficients and the exports fold away. The optimizer leads with what to run
  next; its evidence folds behind lines that state what it found. Its page went from about 2,400 words to 540.
- **Search** in the sidebar (Ctrl/⌘ K) across experiments, formulations, sample names, stocks, buffers, RNA lots
  and compositions.
- **Undo for deletes:** a deleted experiment, stock or buffer goes to a trash, with Undo on the notice and Restore
  under Settings for 30 days.
- **The overview shows the latest results as a chart** against the QC limits.
- **The bench record opens with "At the bench":** the volumes, syringes and pump flows to set, on screen and on the
  printed worksheet.
- **The Formulations list is grouped by experiment,** folded when finished, with a filter for what is still to make.
- Cleaner numbers: "target 80", not "target 80.00".

## 0.7.0: every import evaluated, results per experiment

**Fixed**

- **Stability studies kept only T0.** A 28-day study at 7-day intervals was created with no later timepoints, no
  reminders and no potency slots, because an empty "custom timepoints" field was read as day 0.
- **Export everything failed** once "Show advanced options" had ever been switched on, so there was no backup.
- **Plackett-Burman dropped a run:** five factors gave 7 unbalanced runs instead of 8. Fixed.
- **Typing in a stock or buffer form and clicking the next field threw an error** and lost the field you clicked
  into. Pressing Save straight after typing now uses what you typed, here and on the bench record.
- **An impossible value is refused where it is entered,** with the reason: a PDI outside 0 to 1 ("did you mean
  0.05?"), an EE outside 0 to 100 %, a negative size or concentration. Before, a PDI of 5 was stored and flowed into
  fits and the optimizer.
- An import of the app's own blank sheet with only zeta filled in was read as an empty DLS table; an RNA content
  result could close a DLS measurement; a bulk "stock for all" could put one recipe's stock on another arm of a
  comparison.

**New**

- **Every import ends in its own evaluation:** what came in, Z-average and PDI per sample with the runs and the QC
  limits, size against PDI, which samples need a look and why, and where each experiment it fed now stands.
- **EE and RNA content by import or paste** (an EE column, or total and free RiboGreen RNA), told apart from DLS
  and zeta by their columns, and **a results grid** for typing in everything still waiting, with Tab going down a
  column and a pasted Excel column filling down.
- **Results per experiment,** in the GraphPad manner: a data table with mean ± SD (n) and CV, plain-language
  statistics by experiment type, and figures (bars with SD and every run, lines over time), each saved as SVG or
  PNG, the table as CSV.
- **One recommended setting on the DoE screen** that balances every response, with the predicted values and a
  warning when it sits at the edge of the ranges run. Before, the optimum was worked out one response at a time.
- **Every DoE diagnostic plot** can be saved as SVG or PNG.
- **Bench actions for a whole experiment:** mark all produced, set the lipid stock or RNA lot for all; tick several
  on the Formulations list.
- **A "Next step" line on each experiment** (make, measure, evaluate), and an experiment's status follows its
  progress.
- Notices no longer pile up: at most three, a repeat counts up, and old ones go when you change screens.

## 0.6.0: the public edition

The starting point of the usability work: the app as it was published, with no data from any particular lab.

- **Numbers that say where a record belongs:** experiments `E1, E2 …`, formulations inside them (`E3-F2`, measured as
  `E3-F2_final`), lipid stocks `Stock-001`, buffer lots `Buffer-001`. A lab written by an earlier version is renamed
  to this scheme on its first start, sample names and references included.
- **The sidebar is the workflow:** plan, run, evaluate, optimize. Experiments and Formulations are two views of one
  tree; "Design & results" and the optimizer are separate screens.
- **The MC3 reference (Onpattro ratio) is composition #1** and every default opens on it. The composition registry
  ships with that one recipe; you add your own under Materials & lots.
- **Measurements says what it is waiting for:** each experiment's samples, with Copy names and a blank CSV carrying
  the names and the column headers the importer knows; results can be pasted as well as imported.
- **A 3D view of the fitted surface** beside the contour map.
- The screens for lipid stocks, buffers, materials, the experiment wizard (single, stability, OFAT, DoE,
  comparison, reference), the bench record, measurements, calendar, Insights, the planner, the design catalogue,
  the reference entries, the optional optimizer and demo mode.
