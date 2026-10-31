# Preparing historical data for LNP Lab

How to turn old Excel sheets into records the app can take, without a single value being guessed into the
database. It is meant for a session of its own (with Claude, or by hand) that has the raw files.

## The way through

1. **Prepare** three tidy tables, `experiments.csv`, `formulations.csv` and `measurements.csv`, in one folder
   (the columns are below). This is the fuzzy part: which column is which, units, names. Claude can do it.
2. **Check and convert** them. Close LNP Lab first, then:
   ```bash
   node scripts/import-tidy.mjs <folder> --db ~/Library/Application\ Support/org.lnplab.app/lnp-lab.db
   ```
   This is the strict part. It opens the database read-only, only to number the new experiments after yours
   (E7, E8 …) and to know your lipids and compositions. It checks every row with the app's own rules and
   writes three files into the folder:
   - `quality-report.md`: what is importable, what was refused and why, and how complete each field is.
   - `quarantine.csv`: every refused row with its reason. Fix the table and run the script again: the import is
     built afresh each time. An experiment already in the lab (recognised by its `exp_key`, kept in its notes)
     is refused as "already in the lab as E7", so restoring a second run does not bring anything in twice.
   - `import.json`: the importable records.
3. **Read the report**, then in LNP Lab: **Settings & export › Backup & restore › Import JSON**, choose
   `import.json`, with "replace instead of merge" left unticked. Make a backup first (**Export everything**).
   Every record carries the import's id, the file and the row it came from.
   The refused rows come along into the app's **Quarantine** (in the sidebar while any wait there): open one,
   fill in what is missing, and **Check again** runs the same check. **Settings & export › Imports** lists the
   import, and **Undo import** moves all of it into Recently deleted, from where Restore puts it back.

With Claude Desktop or Claude Code, the optional MCP server in [`mcp/`](../mcp/README.md) does steps 2 and 3 in
the conversation: Claude reads the Excel files and maps them, the server checks them with the same code
(`app/calc/importcheck.js`) and, after you approve the report, writes them into the macOS app's database while
the app is closed, or makes the same `import.json` for the browser version. Claude then reads your lab data, and
it is sent to Anthropic; the server itself sends nothing over the network.

A working example, with three planted mistakes, is in [`historical-example/`](historical-example/).

## The tables

CSV with a header row; `,` or `;` as separator; a decimal comma is read as a point. Dates as `YYYY-MM-DD`.
Empty cells are fine: a missing value stays missing and shows in the completeness table, it is never filled in.

### experiments.csv (optional)

One row per experiment (one campaign, one plate, one day's series: whatever belonged together then).

| Column | Required | Meaning |
|---|---|---|
| `exp_key` | yes | Your own name for it, unique, e.g. `GH-2024-03`. Kept in the notes; the app gives it an E number |
| `name` | | Title shown in the app |
| `type` | | `single`, `reference`, `comparison`, `ofat`, `doe` or `stability` (default `single`) |
| `date` | | Start date |
| `notes` | | Free text |

Without this table, every `exp_key` in formulations.csv becomes an experiment of its own.

### formulations.csv (required)

One row per formulation that was made.

| Column | Required | Unit / values |
|---|---|---|
| `exp_key`, `form_key` | yes | The experiment, and your name for the formulation inside it (`F1`, `A` …), unique within it |
| `label`, `date`, `notes` | | |
| `composition_id` | either this | A composition number the app already has |
| `ionizable_lipid`, `ionizable_pct`, `helper_lipid`, `helper_pct`, `sterol`, `sterol_pct`, `peg_lipid`, `peg_pct` | or these | Lipid names as in the app (ALC-0315, SM-102, DLin-MC3-DMA, DSPC, Cholesterol, DMG-PEG2000, ALC-0159 …) and mol%, adding up to 100. A mix the app knows is matched to its number, a new one is added |
| `frr` | | aqueous : organic, e.g. 3 |
| `tfr_ml_min` | | total flow, mL/min |
| `np` | | N/P ratio |
| `quench_factor` | | × lipid volume |
| `lipid_mM` | | lipid stock, mM |
| `rna_mg_mL` | | RNA working concentration, mg/mL |
| `rna_lot` | | |
| `bufferSystem` | | Acetate, Citrate, Malate, Phosphate, Other |
| `loadingPH` | | pH of the loading buffer |
| `bufferMolarity_mM` | | mM |
| `ethanolPct` | | ethanol in the lipid phase, % v/v |
| `mixTemp_C` | | °C |
| `mixerType` | | T-mixer, IJM, Microfluidic chip, Other (the kinds of the app's mixer list) |
| `mixer` | | the mixer's name or geometry, free text (kept on the formulation) |
| `postMethod` | | Dilution, Dialysis, TFF |
| `targetBuffer`, `targetPH` | | PBS, HEPES, Tris, Histidine, Other; pH |
| `finalRna_mg_mL` | | mg/mL |
| `cryoprotectant`, `cryo_pct` | | None, Sucrose, Trehalose; % w/v |
| `sterileFiltered` | | yes / no |
| `rnaType` | | mRNA, saRNA, siRNA, Other |

The ionizable lipid and "PEG-free" are worked out from the composition and need no column.

### measurements.csv (optional)

One row per result; replicates as separate rows numbered in `replicate`.

| Column | Required | Meaning |
|---|---|---|
| `exp_key`, `form_key` | yes | The formulation it belongs to |
| `test` | yes | `dls`, `zeta`, `ee`, `content`, `ph`, `osmolality`, `endotoxin` |
| `stage` | | `final` (default), or an in-process stage such as `IPC4` |
| `date`, `operator`, `replicate`, `notes` | | |
| `condition`, `timepoint_days` | | for stability pulls, e.g. `4C`, `28` |
| `zave_nm`, `pdi`, `zave_sd`, `countRate_kcps` | for dls | size in nm, PDI 0–1 |
| `zeta_mV` | for zeta | |
| `ee_pct`, `total_mg_mL`, `free_mg_mL` | for ee | EE in % (0–100), RNA in mg/mL |
| `total_mg_mL` | for content | |
| `ph`, `mOsm_kg`, `eu_mL` | for ph, osmolality, endotoxin | |
| `source_file`, `sheet` | | where the number was read, for the provenance |

## What is refused

A row goes to quarantine, with the reason, when:
- a required column is empty, or a key appears twice;
- a lipid name is unknown (add the lipid under Materials first, then run again with `--db`);
- the mol% do not add up to 100 (± 0.5);
- a number is outside what is physically sensible: PDI over 1 ("probably a typing slip"), EE over 100 %, size
  under 10 nm, a pH outside 0–14, and so on;
- a category is not one of its words (mixer type, buffer system …);
- a measurement names a formulation that is not there, or was refused itself;
- the same formulation, test, stage and timepoint appear twice without a replicate number.

## What Gholan decides before the first real run

- **Which fields make a record usable.** At the moment only `exp_key`, `form_key` and a composition are
  required, so that nothing is thrown away. If, say, FRR and a size are the minimum for the optimizer, say so and
  the script will refuse rows without them.
- **How old experiments are cut.** One `exp_key` per day, per series or per paper figure; it decides how the
  optimizer's cross-validation holds data out.

## Prompt for the separate session

> I want to bring my historical LNP data into LNP Lab. The format is in `docs/HISTORICAL-DATA.md` in the
> LNP-LAB repository (branch `next-stage`), with a worked example in `docs/historical-example/`. My raw Excel
> files are in `<folder>`. Please:
> 1. Read every file and every sheet and tell me what you find, before changing anything: which sheets hold
>    formulations, which measurements, which columns map to which field, which units are used, and what is
>    unclear.
> 2. After I confirm the mapping, write `experiments.csv`, `formulations.csv` and `measurements.csv` into a new
>    folder. Do not invent or fill in values; leave a cell empty when the sheet does not say it. Record the
>    source file and sheet of every measurement. Map lipid names to the names the app uses.
> 3. Run `node scripts/import-tidy.mjs <new folder> --db "<path to lnp-lab.db>"` and go through
>    `quality-report.md` and `quarantine.csv` with me. Fix only what is clearly a transcription problem, and ask
>    about anything else.
> 4. Do not restore anything into the app yourself; I do that after reading the report.
