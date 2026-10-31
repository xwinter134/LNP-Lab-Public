# Preparing historical data for LNP Lab

How to turn old Excel sheets into records the app can take, without a single value being guessed into the
database. It is meant for a session of its own (with Claude, or by hand) that has the raw files.

## The way through

1. **Prepare** three tidy tables, `experiments.csv`, `formulations.csv` and `measurements.csv`, in one folder
   (the columns are below), and for biological data `studies.csv` and `bioMeasurements.csv`. This is the fuzzy
   part: which column is which, units, names. Claude can do it.
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

A working example, with three planted mistakes in the physicochemistry and two in the biological tables (a
group role that is not one of the three, a flux typed as RLU), is in [`historical-example/`](historical-example/).

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
| `test` | yes | `dls`, `zeta`, `ee`, `content`, `lipid_content`, `ph`, `osmolality`, `integrity`, `endotoxin` |
| `stage` | | `final` (default), or an in-process stage such as `IPC4` |
| `date`, `operator`, `replicate`, `notes` | | |
| `condition`, `timepoint_days` | | for stability pulls, e.g. `4C`, `28` |
| `zave_nm`, `pdi`, `zave_sd`, `countRate_kcps` | for dls | size in nm, PDI 0–1 |
| `zeta_mV`, `sd_mV` | for zeta | mV |
| `ee_pct`, `total_mg_mL`, `free_mg_mL`, `ee_sd` | for ee | EE in % (0–100), RNA in mg/mL |
| `rna_mg_mL`, `rna_sd` | for content | RNA content, mg/mL (as the results grid stores it) |
| `total_mg_mL` | for lipid_content | total lipid, mg/mL |
| `ph`, `mOsm_kg`, `pct`, `eu_mL` | for ph, osmolality, integrity, endotoxin | |
| `source_file`, `sheet` | | where the number was read, for the provenance |

The value columns and their limits are the app's own (`app/calc/qc.js` and the results grid,
`app/calc/gridentry.js`), not a list of the import's: a value the Measurements screen refuses is refused here,
with the same words, and a probable unit slip it only warns about (an EE of 0.93 %) is imported with that warning
as a flag.

### studies.csv (optional, biological layers)

One row per **group** of a study; the rows of one study share its `study_key`. The study's own fields (name,
type, layers, date, licence, context) may be given on its first row only; a later row that says otherwise is
refused. The model is the Studies screen's (`app/calc/bio.js`, spec 8.3).

| Column | Required | Meaning |
|---|---|---|
| `study_key` | yes | Your own name for the study, unique; the app gives it a Study number (Study-004) |
| `name`, `date`, `notes` | | |
| `type` | | `in vitro` or `in vivo` (in vivo unless the only layer is `invitro`) |
| `layers` | | `invitro`, `invivo`, `biodist`, `tropism`, separated by `;` (from its values when empty) |
| `licence` | | animal licence or ethics approval number |
| `subtract_background` | | yes (default) or no: the negative control is subtracted before normalising |
| `group` | yes | the group's key inside the study (`G1`, `Ref` …), unique there |
| `group_name` | | shown in the charts |
| `role` | yes | `reference` (the lab standard running alongside, one per study), `test` or `negative` (PBS, empty LNP) |
| `exp_key`, `form_key` | | the group's formulation, of this import or an earlier one |
| `formulation_id` | | or the id of a formulation in the lab (`E12-F3`) |
| `n` | | animals or wells in the group |
| context | | in vitro: `cellLine`, `cargo`, `reporter`, `dose_ng`, `cells`, `timepoint_h`, `serum`; in vivo: `species`, `strain`, `sex`, `age`, `route` (i.v., i.m., s.c., i.p., intranasal, other), `dose_mg_kg`, `timepoint_h`, `animalsPerGroup`; biodistribution: `organs` (separated by `;`, liver if empty); tropism: `organ`, `method` (flow cytometry, imaging), `markers` |

A study without a reference group, without a test group or (in vivo) without a licence number is imported all
the same; the report lists it under "Worth a look", as the Studies screen warns about it (spec 8.2).

### bioMeasurements.csv (optional)

One **raw** value per study, group, subject and read-out. The app normalises to the reference group itself,
every time it shows a study; never give fold changes here.

| Column | Required | Meaning |
|---|---|---|
| `study_key`, `group` | yes | the study and one of its groups (its key, id or name) |
| `subject` | yes | the animal or well id (`M1`, `B3`): one value per subject and read-out |
| `layer` | yes | `invitro`, `invivo`, `biodist`, `tropism` |
| `quantity` | yes | in vitro: `luciferase` (RLU), `positive_pct` (%), `mfi` (a.u.), `viability_pct` (%); in vivo: `total_flux` (p/s), `serum_titer` (ng/mL); biodistribution: `organ_flux` (p/s), `organ_signal` (a.u.), `invivo_roi_flux` (p/s); tropism: `positive_pct` (%), `mfi` (a.u.) |
| `value` | yes | the raw number |
| `unit` | | the quantity's unit as above; a value in another unit is refused (convert it first) |
| `organ` | for biodist | `liver`, `spleen` … |
| `population` | for tropism | `hepatocytes`, `Kupffer cells` … |
| `timepoint_h`, `view` | | hours; `dorsal` or `ventral` |
| `date`, `notes` | | |
| `image_file`, `image_sha256` | | the raw image a value was read from (IVIS), its path and SHA-256 |

## What is refused

A row goes to quarantine, with the reason, when:
- a required column is empty, or a key appears twice;
- a lipid name is unknown (add the lipid under Materials first, then run again with `--db`);
- the mol% do not add up to 100 (± 0.5);
- a number is outside what is physically sensible, by the app's own rules: PDI over 1 ("probably a typing
  slip"), EE over 100 %, a size of 0 or above 10 000 nm, a pH outside 0–14, a negative concentration, and so on;
- a category is not one of its words (mixer type, buffer system …);
- a measurement names a formulation that is not there, or was refused itself;
- the same formulation, test, stage and timepoint appear twice without a replicate number;
- a study row with a role other than reference, test or negative, or naming a formulation that is not there; a
  biological value whose group, layer, quantity or unit does not fit its study, or one for the same subject and
  read-out twice.

A row already imported (the same file, by its SHA-256, the same sheet and row) is not imported again: the report
counts it under duplicates.

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
