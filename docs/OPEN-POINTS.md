# Open points after the next stage (v0.16.0)

What only Gholan can provide or decide, collected from all six phases. Each item says what it unblocks.

## Data to provide

| # | What | Unblocks |
|---|---|---|
| D1 | A finished historical campaign with its run order (real data; the current database has 8 measured runs) | Historical benchmark (7.7, `npm run history`), then the stop rule's recalibration, then a stronger GP noise prior |
| D2 | 3–5 typical Excel files, messy ones included | Testing the MCP import and `scripts/import-tidy.mjs` on real sheets |
| D3 | 20–30 IVIS export folders with the manual Living Image values, how the ROIs were drawn (whole mouse, liver, tumour), Living Image version and instrument | The BLI test bench on the lab's own images (8.7) |
| D4 | Real plate reader exports and the lab's plate layout template | Checking the plate reader import (8.3) |
| D5 | An example study plan with groups and reference | The study model (8.3) |
| D6 | Instrument files to try the importer with (its preview is now always drawn as the results grid) | 9.3 |
| D7 | The list of LNP-ML papers whose methods went into the app | The licence and patent table, `docs/LICENSE-CHECK.md` (11.1) |
| D8 | The lab's list of buffer lot codes (12.3) | Typing them into Materials › Buffer catalog; the shipped codes (CIT50, PBS1X …) are suggestions |

## Texts to write

| # | What | Where it goes |
|---|---|---|
| T1 | The animal welfare notice | `ANIMAL_WELFARE_NOTICE` in `app/calc/designs.js` (11.3) |
| T2 | The final privacy wording for the MCP import and Claude insights (a draft is in place) | `mcp/README.md`, `mcp/manifest.json`, `PRIVACY_NOTE` in `app/ui/imports.js` (11.2) |
| T3 | The author name for the Claude Desktop extension | `mcp/manifest.json` |

## Decisions

| # | Question | Today |
|---|---|---|
| E2 | Which fields make an imported record usable | only experiment, formulation and a composition are required |
| E3 | What one historical experiment is: a day, a series, a paper figure (it decides how the optimizer's cross-validation holds data out) | the `exp_key` as given |
| E4 | Data budget default | 400 runs |
| E5 | The budget's quality step drops only measurements that cannot be believed, not results outside the QC limits | as described |
| E6 | Relevance margin and subselection weights of the budget | 20 % of the range; 0.5 for good results, 0.25 for recent ones |
| E7 | The optimizer's Data and model panel folds to one line after a fit (to stay within the screen's word limit); always open instead? | folds |
| E8 | Results grid and troubleshooting assistant: on by default? | off |
| E9 | Impossible values (PDI over 1, EE over 100 %) are refused in the grid, implausible ones stored with a warning | as described |
| E10 | The troubleshooter's thresholds are textbook values: FRR 3:1; total flow slow under 6 mL/min on a microfluidic chip, under 30 on other mixers; PEG under 1 or from 2.5 mol%; N/P under 4 or from 6; pH over 5; ionizable lipid under 35 or from 45 mol%. The lab's own? | textbook |
| E11 | The Measurements screen's older slot grid next to the new grid: remove, or point it at the new one? | both |
| E12 | "Total flux" in BLI: the whole mouse, or an organ or tumour region? | whole mouse plus a liver region |
| E13 | Copy the raw IVIS images next to the database in the Mac app? | referenced by path and SHA-256 |
| E14 | Lipid descriptors from SMILES with RDKit.js (a new dependency) | entered by hand, behind a switch |
| E15 | Store a model summary so Claude insights can read the GP's lengthscales | not stored |
| E17 | Leaving a form with typed, unsaved input asks first (spec 9.1). The experiment wizard and the buffer designer keep drafts instead and do not ask; should they ask too? | drafts, no question |
| E18 | Comparing two views: each bar is the share of its own view (so a view of 40 reads against one of 400). Counts instead? | shares, counts beside them |
| E16 | Em dashes are gone from the screens (spec 12.1); an empty value or choice now shows an en dash "–", a choice still to make "Choose…". Something else for the empty value (blank, "none", "n/a")? | "–" |
| E19 | Reagents (`app/data/reagents.json`) are reference data with no screen to add or edit them, so they are not part of archiving (9.5). Should the lab manage its own reagents? They would then be archived like the other components | shipped only, not archivable |
| E20 | A deleted experiment stays in the trash, past 30 days and through "Empty trash", while its results or a study still name its formulations (12.2). Should results alone keep it, or only studies? | results, studies and study values keep it |
| E21 | Publish the MCP server to npm (`lnp-lab-mcp`), and under whose npm account | packed, not published (`npm run pack:npm` in `mcp/`) |
| E22 | The approval code when the client cannot ask (no MCP elicitation, no Mac notification) travels in the tool result marked for the user: acceptable, or refuse to write without elicitation or a notification? | accepted, documented as the weaker path |
| E23 | Biological values: refuse implausible ones (e.g. % positive over 100) in the import and the Studies grid alike? Today both take any number, and the unit must be the quantity's | any number |
| E24 | The standard BLI crop: 5 × 11 cm at 8 px/cm, body axis up. Fine for training data later, or another size? | 5 × 11 cm, 8 px/cm |

## To check on a Mac

| # | What |
|---|---|
| M1 | Build the Mac app once: the lock file the MCP server checks (`src-tauri/src/lib.rs`) could not be compiled here |
| M2 | Claude Desktop's bundled Node must be 22.13 or later for the MCP server (`node:sqlite`) |
