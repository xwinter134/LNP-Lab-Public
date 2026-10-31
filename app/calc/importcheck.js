// The strict half of every import of tidy tables (spec 6.1): one check, used by the historical-data script
// (scripts/import-tidy.mjs), the MCP server (mcp/tools.js) and the app's Quarantine screen (app/ui/quarantine.js),
// so the three can never accept different things.
//
// Whoever prepares the tables, a person, Claude in Claude Desktop or Claude Code, does the fuzzy part: which
// column is which, units, names. This file does the strict part. A row passes when every value passes the app's
// own rules (app/calc/variables.js checkVariable, the sense limits below, the lipid catalogue, mol% adding up);
// a row that does not pass is never dropped: it goes to quarantine with its reason in words, to be fixed and
// checked again (spec 6.5).
//
// Pure: no DOM, no store, no file system. The callers read the tables and the lab, and write what comes out.
//
// The tables are the ones docs/HISTORICAL-DATA.md describes: experiments, formulations, measurements, one object
// per row keyed by the column names, plus `__row` (its row number in the file it came from) and, optionally,
// `__origin` = {file: {name, sha256}, sheet, row}, the cell range in the original spreadsheet the row was read
// from. The origin is what an import is deduplicated by (file hash plus row, spec 6.5).
import { VARIABLES, VARIABLE_BY_KEY, checkVariable } from './variables.js';
import { dataRows, completeness } from './facets.js';
import { LIMITS, checkValues } from './qc.js';
import { GRID_COLUMNS } from './gridentry.js';

/** RFC 4180 CSV, with ; or , as separator (whichever the header uses), and a decimal comma read as a point. */
export function parseCsv(text) {
  const [head, ...body] = parseCsvRows(text).filter((r) => r.cells.some((c) => c.trim() !== ''));
  const keys = (head?.cells || []).map((h) => h.trim());
  return body.map((r, i) => ({ __row: i + 2, ...Object.fromEntries(keys.map((k, j) => [k, (r.cells[j] ?? '').trim()])) }));
}

/** The same file as raw rows, each with its line number in the file: [{row, cells}], blank lines included. */
export function parseCsvRows(text) {
  text = String(text).replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0];
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : first.includes('\t') && !first.includes(',') ? '\t' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((cells, i) => ({ row: i + 1, cells }));
}

/** A number as a sheet writes it: '' and null are missing (null), a decimal comma is a point, anything else NaN. */
export const num = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return Number.isFinite(v) ? v : NaN; const n = Number(String(v).trim().replace(',', '.')); return Number.isFinite(n) ? n : NaN; };

export const EXPERIMENT_TYPES = ['single', 'reference', 'comparison', 'ofat', 'doe', 'stability'];

/**
 * The tests a measurement row may name, and the value columns of each, with their sense limits: {test: {key:
 * [min, max]}} (null where a field has no limit). Not a list of its own (spec 6.1/6.2: "app and import never run
 * apart"): the fields and limits are the app's, the ones a result typed into the Measurements screen is checked
 * by (app/calc/qc.js LIMITS, checkValues), plus the further fields the results grid stores per test
 * (app/calc/gridentry.js GRID_COLUMNS: the count rate, and the SD of replicates under its `spread` key). So a
 * value the app would refuse is refused here, and a value it takes is taken, with the same words.
 */
export const TESTS = (() => {
  const out = {};
  for (const [test, rules] of Object.entries(LIMITS)) out[test] = Object.fromEntries(rules.map((r) => [r.key, [r.min ?? null, r.max ?? null]]));
  for (const c of GRID_COLUMNS) {
    out[c.test] ||= {};
    if (!(c.key in out[c.test])) out[c.test][c.key] = [null, null];
    if (c.spread && !(c.spread in out[c.test])) out[c.test][c.spread] = [0, null];
  }
  return out;
})();
const VALUE_LABEL = Object.fromEntries([...Object.values(LIMITS).flat().map((r) => [r.key, r.label]), ...GRID_COLUMNS.map((c) => [c.key, c.label])]);
const SPREAD_KEYS = new Set(GRID_COLUMNS.map((c) => c.spread).filter(Boolean));

/**
 * One measurement row's values checked as the app checks a result: {values, problems, warnings}. A problem refuses
 * the row; a warning (a probable unit slip, checkValues' second list) is kept on the result as a flag, as the app
 * shows it beside a typed one. The app's own sentence is used ("PDI 8.5 is outside 0–1"), with "probably a typing
 * slip" said of a PDI over 1, which can only be one, and the app's guess at what was meant in brackets.
 */
export function checkMeasurementValues(test, row) {
  const values = {}, problems = [];
  for (const k of Object.keys(TESTS[test] || {})) {
    const v = num(row[k]);
    if (v == null) continue;
    if (Number.isNaN(v)) problems.push(`${VALUE_LABEL[k] || k} "${row[k]}" is not a number`);
    else values[k] = v;
  }
  const { errors, warnings } = checkValues(test, values);
  for (const e of errors) {
    const [base, meant] = e.text.split(/\s+\u2014\s+/);
    const slip = e.key === 'pdi' && values.pdi > 1 ? ', probably a typing slip' : '';
    problems.push(`${base}${slip}${meant ? ` (${meant})` : ''}`);
    delete values[e.key];
  }
  // The SD of replicates is worked out by the app, never typed there; imported, it cannot be negative.
  for (const k of Object.keys(values)) if (SPREAD_KEYS.has(k) && values[k] < 0) { problems.push(`${k} ${values[k]} cannot be negative`); delete values[k]; }
  return { values, problems, warnings: warnings.map((w) => w.text.replace(/\s+\u2014\s+/, ': ')) };
}

/** The plan's numbers a formulation row may carry: [column, low, high, label, unit]. */
export const PLAN_COLUMNS = [
  ['frr', 0.5, 20, 'FRR', 'aqueous : organic'], ['tfr_ml_min', 0.1, 500, 'total flow (mL/min)', 'mL/min'], ['np', 0.5, 50, 'N/P', ''],
  ['quench_factor', 0, 20, 'quench factor', '× lipid volume'], ['lipid_mM', 0.1, 200, 'lipid stock (mM)', 'mM'], ['rna_mg_mL', 0.001, 10, 'RNA working conc. (mg/mL)', 'mg/mL'],
];
export const LIPID_COLUMNS = [['ionizable_lipid', 'ionizable_pct'], ['helper_lipid', 'helper_pct'], ['sterol', 'sterol_pct'], ['peg_lipid', 'peg_pct']];
export const PROCESS_COLS = VARIABLES.filter((v) => v.kind !== 'derived').map((v) => v.key);

/**
 * The fields of each table, for get_schema and the Quarantine screen's form: {table: [{key, required, kind,
 * unit, options, lo, hi, note}]}. Built from the same constants the check uses, so it cannot describe a
 * different import from the one that runs.
 */
const unitOf = (key) => (Object.values(LIMITS).flat().find((r) => r.key === key) || GRID_COLUMNS.find((c) => c.key === key))?.unit || undefined;

export function tidySchema() {
  const req = (key, note = '') => ({ key, required: true, kind: 'text', note });
  const txt = (key, note = '') => ({ key, required: false, kind: 'text', note });
  const formulations = [
    req('exp_key', 'the experiment it belongs to'), req('form_key', 'its name inside the experiment, unique there'),
    txt('label'), { key: 'date', required: false, kind: 'date', note: 'YYYY-MM-DD' }, txt('notes'),
    { key: 'composition_id', required: false, kind: 'number', note: 'a composition number the lab has; or give the lipids and their mol% below' },
    ...LIPID_COLUMNS.flatMap(([l, p]) => [{ key: l, required: false, kind: 'lipid', note: 'a lipid name of the catalogue (list_catalog)' }, { key: p, required: false, kind: 'number', unit: 'mol%', note: 'the four add up to 100 (± 0.5)' }]),
    ...PLAN_COLUMNS.map(([key, lo, hi, , unit]) => ({ key, required: false, kind: 'number', unit, lo, hi })),
    txt('rna_lot'),
    ...VARIABLES.filter((v) => v.kind !== 'derived').map((v) => ({ key: v.key, required: false, kind: v.kind, unit: v.unit, lo: v.min, hi: v.max, options: v.kind === 'category' && !v.addable ? v.options : undefined, note: v.addable ? 'free text, joins the lab\'s list' : v.kind === 'bool' ? 'yes or no' : v.name })),
  ];
  const measurements = [
    req('exp_key'), req('form_key'), { key: 'test', required: true, kind: 'category', options: Object.keys(TESTS) },
    { key: 'stage', required: false, kind: 'text', note: 'final (default), or an in-process stage such as IPC4' },
    { key: 'date', required: false, kind: 'date' }, txt('operator'), txt('replicate', 'number the replicates of one test and stage'), txt('notes'),
    txt('condition', 'for stability pulls, e.g. 4C'), { key: 'timepoint_days', required: false, kind: 'number', unit: 'days' },
    // One column per value key; a key two tests share (total_mg_mL: EE's total RNA and the total lipid of
    // lipid_content) is listed once, naming both.
    ...Object.entries(TESTS).flatMap(([test, vals]) => Object.entries(vals).map(([key, [lo, hi]]) => ({ key, required: false, kind: 'number', lo: lo ?? undefined, hi: hi ?? undefined, unit: unitOf(key), note: `for ${test}` })))
      .reduce((acc, f) => { const g = acc.find((x) => x.key === f.key); if (g) g.note += `, ${f.note.slice(4)}`; else acc.push(f); return acc; }, []),
    txt('source_file'), txt('sheet'),
  ];
  const experiments = [req('exp_key', 'your own name for it, unique; the app gives it an E number'), txt('name'), { key: 'type', required: false, kind: 'category', options: EXPERIMENT_TYPES }, { key: 'date', required: false, kind: 'date' }, txt('notes')];
  return { experiments, formulations, measurements };
}

const squash = (s) => String(s || '').toLowerCase().replace(/[\s\-_0]/g, '');
/** A lipid name to its catalogue key: null when none is given, undefined when it is not in the catalogue. */
export function lipidMatcher(lipids) {
  return (name) => { if (!name) return null; const s = squash(name); const l = lipids.find((x) => squash(x.key) === s || squash(x.name) === s); return l ? l.key : undefined; };
}
const sameMix = (a, b) => { const ka = Object.keys(a).filter((k) => a[k] > 0).sort(), kb = Object.keys(b).filter((k) => b[k] > 0).sort(); return ka.join() === kb.join() && ka.every((k) => Math.abs(a[k] - b[k]) < 0.05); };

/** The columns of a row, without the bookkeeping fields (`__row`, `__origin`, `_raw` …). */
export const columnsOf = (row) => Object.fromEntries(Object.entries(row || {}).filter(([k]) => !k.startsWith('_')));

/**
 * The key an import is deduplicated by (spec 6.5): the file's hash, sheet and row the record was read from, which
 * table it went to, and for a measurement which test of the row (one sheet row often holds a size and an EE).
 * A row without an origin is keyed by its content instead, so the same mapped row is not imported twice either.
 */
export function originKey(table, row, sha) {
  const o = row?.__origin || {};
  const file = o.file?.sha256 || o.file?.name || sha || '';
  const where = o.row != null || file ? `${file}|${o.sheet || ''}|${o.row ?? row?.__row ?? ''}` : `content:${JSON.stringify(columnsOf(row))}`;
  const part = table === 'measurements' ? `|${String(row.test || '').toLowerCase()}|${row.stage || 'final'}|${row.condition || ''}|${row.timepoint_days || ''}|${row.replicate || ''}` : '';
  return `${where}|${table}${part}`;
}

/** "Historical key: GH-2024-03" in a record's notes: the name the lab's own sheets gave it. */
export const historicalKey = (rec) => /Historical key: (.+)/.exec(String(rec?.notes || ''))?.[1]?.trim() || null;

/**
 * What the check needs to know about the lab, from anything with all(col) (the Store, or the MCP server's
 * read-only view of the database file): the experiments and formulations an earlier import brought in, by their
 * historical keys, the origin keys already imported, and the ids already used.
 */
export function labIndex(lab) {
  const experimentsByKey = new Map(), batchesByKey = new Map(), origins = new Map();
  const exps = lab.all('experiments');
  for (const e of exps) { const k = historicalKey(e); if (k) experimentsByKey.set(k, e); }
  const keyOfExp = new Map([...experimentsByKey].map(([k, e]) => [e.id, k]));
  for (const b of lab.all('batches')) {
    const ek = keyOfExp.get(b.experimentId), fk = historicalKey(b);
    if (ek && fk) batchesByKey.set(`${ek}/${fk}`, b);
  }
  for (const col of ['experiments', 'batches', 'measurements', 'compositions']) for (const r of lab.all(col)) if (r?.provenance?.originKey) origins.set(r.provenance.originKey, r.provenance.importId || null);
  return { experimentsByKey, batchesByKey, origins };
}

/**
 * Check tidy tables and build the records they become.
 *
 * @param {{experiments?: {name, sha256?, rows}, formulations: {name, sha256?, rows}, measurements?: {name, sha256?, rows}}} tables
 * @param {object} ref
 *   lipids, compositions: the catalogue (shipped plus the lab's own); mixers: the lab's mixer list;
 *   topExperiment: the highest E number in use; takenFormulations: formulation ids in use (usedIds);
 *   lab: labIndex() of the lab, when there is one; measurementStart: how many measurement ids of this import are
 *   taken already (a row fixed from quarantine joins an import that has some).
 * @param {object} opts
 *   importId, importedAt (ISO): shared by every record of this import;
 *   source: 'restore' (the script) or 'mcp-import' (the MCP server), written in each provenance;
 *   attachTo(exp): whether formulations may join this experiment already in the lab (the Quarantine screen:
 *     an experiment of the same import); otherwise a formulation whose experiment is in the lab is refused;
 *   attachMeasurements: whether a measurement may name a formulation already in the lab (deduplicated by
 *     origin, so it is safe where every row has one: the MCP server, the Quarantine screen);
 *   dedupe: refuse rows whose origin key the lab already holds (they are listed as duplicates, not quarantined).
 * @returns {{importId, importedAt, experiments, experimentUpdates, batches, measurements, compositions, mixers,
 *   quarantine, duplicates, read}}
 */
export function checkTidy(tables, ref = {}, opts = {}) {
  const { importId = 'imp', importedAt = new Date().toISOString(), source = 'restore', attachTo = () => false, attachMeasurements = false, dedupe = false } = opts;
  const lipids = ref.lipids || [];
  const compositions = ref.compositions || [];
  const lab = ref.lab || { experimentsByKey: new Map(), batchesByKey: new Map(), origins: new Map() };
  const lipidKey = lipidMatcher(lipids);
  let topExperiment = Number.isFinite(ref.topExperiment) ? ref.topExperiment : 99;
  const exT = tables.experiments || null, foT = tables.formulations || null, meT = tables.measurements || null;

  const quarantine = [], duplicates = [];
  const tableOf = { experiments: exT, formulations: foT, measurements: meT };
  const fileOf = (t) => tableOf[t]?.name || `${t}.csv`;
  const prov = (t, row) => {
    const tb = tableOf[t] || {};
    const o = row.__origin || {};
    const p = { source, file: o.file || (tb.name ? { name: tb.name, ...(tb.sha256 ? { sha256: tb.sha256 } : {}) } : undefined), sheet: o.sheet, row: o.row ?? row.__row, importId, importedAt };
    if (dedupe) p.originKey = originKey(t, row, tb.sha256);
    return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  };
  const refuse = (t, row, reason) => quarantine.push({ table: t, file: fileOf(t), row: row.__row, reason, raw: columnsOf(row), origin: row.__origin || null, originKey: originKey(t, row, tableOf[t]?.sha256), source: row._raw || null });
  // A row already imported: said, and left out, rather than quarantined (it is in the lab already).
  const seen = new Set();
  const duplicate = (t, row) => {
    if (!dedupe) return false;
    const k = originKey(t, row, tableOf[t]?.sha256);
    if (lab.origins.has(k)) { duplicates.push({ table: t, file: fileOf(t), row: row.__row, origin: row.__origin || null, reason: `already imported${lab.origins.get(k) ? ` in ${lab.origins.get(k)}` : ''}` }); return true; }
    if (seen.has(k)) { duplicates.push({ table: t, file: fileOf(t), row: row.__row, origin: row.__origin || null, reason: 'the same source row appears twice in this import' }); return true; }
    seen.add(k);
    return false;
  };

  // ---- experiments
  const experiments = new Map(); // exp_key → record (new, or one in the lab formulations may join)
  const inLab = new Map(); // exp_key → the lab's record, for those joined
  for (const r of exT?.rows || []) {
    if (duplicate('experiments', r)) continue;
    if (!r.exp_key) { refuse('experiments', r, 'exp_key is empty'); continue; }
    if (experiments.has(r.exp_key)) { refuse('experiments', r, `exp_key ${r.exp_key} appears twice`); continue; }
    const there = lab.experimentsByKey.get(r.exp_key);
    if (there) {
      if (attachTo(there)) { experiments.set(r.exp_key, { ...there, batchIds: [...(there.batchIds || [])] }); inLab.set(r.exp_key, there); continue; }
      refuse('experiments', r, `already in the lab as ${there.id}`); continue;
    }
    const type = String(r.type || 'single').toLowerCase();
    if (!EXPERIMENT_TYPES.includes(type)) { refuse('experiments', r, `type "${r.type}" is not one of ${EXPERIMENT_TYPES.join(', ')}`); continue; }
    experiments.set(r.exp_key, { id: `E${++topExperiment}`, type, name: r.name || r.exp_key, startDate: r.date || null, status: 'done', batchIds: [], expected: [], notes: [r.notes, `Historical key: ${r.exp_key}`].filter(Boolean).join('\n'), provenance: prov('experiments', r) });
  }

  // ---- formulations
  const newComps = [];
  let topComp = Math.max(0, ...compositions.map((c) => Number(c.id) || 0));
  const taken = new Set(ref.takenFormulations || []);
  const nextFormulation = (exp) => {
    const re = new RegExp(`^${String(exp.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-F(\\d+)$`);
    let n = 0;
    for (const id of [...taken, ...exp.batchIds]) { const m = re.exec(String(id)); if (m) n = Math.max(n, Number(m[1])); }
    const id = `${exp.id}-F${n + 1}`;
    taken.add(id);
    return id;
  };
  const batches = new Map(); // `${exp_key}/${form_key}` → record
  const refusedForms = new Set(); // exp_keys with a formulation in quarantine: the experiment is kept for it
  for (const r of foT?.rows || []) {
    const T = 'formulations';
    if (duplicate(T, r)) continue;
    if (!r.exp_key || !r.form_key) { refuse(T, r, 'exp_key and form_key are both required'); continue; }
    let exp = experiments.get(r.exp_key);
    const there = lab.experimentsByKey.get(r.exp_key);
    if (!exp && there) {
      if (attachTo(there)) { exp = { ...there, batchIds: [...(there.batchIds || [])] }; experiments.set(r.exp_key, exp); inLab.set(r.exp_key, there); }
      else { refuse(T, r, `its experiment is already in the lab as ${there.id}`); continue; }
    }
    if (!exp && !exT) { // no experiments table: one experiment per exp_key, made here
      exp = { id: `E${++topExperiment}`, type: 'single', name: r.exp_key, startDate: r.date || null, status: 'done', batchIds: [], expected: [], notes: `Historical key: ${r.exp_key}`, provenance: prov(T, r) };
      experiments.set(r.exp_key, exp);
    }
    if (!exp) { refuse(T, r, `exp_key ${r.exp_key} is not in the experiments table`); continue; }
    const key = `${r.exp_key}/${r.form_key}`;
    if (batches.has(key)) { refuse(T, r, `form_key ${r.form_key} appears twice in ${r.exp_key}`); refusedForms.add(r.exp_key); continue; }
    if (lab.batchesByKey.has(key)) { refuse(T, r, `already in the lab as ${lab.batchesByKey.get(key).id}`); continue; }

    // Composition: an id the lab has, or the four lipids with their mol%.
    let compositionId = r.composition_id != null && r.composition_id !== '' ? num(r.composition_id) : null;
    const problems = [];
    if (compositionId != null && !compositions.some((c) => c.id === compositionId) && !newComps.some((c) => c.id === compositionId)) problems.push(`composition_id ${r.composition_id} is not in the lab's registry`);
    if (compositionId == null) {
      const mol = {};
      for (const [lc, pc] of LIPID_COLUMNS) {
        if (!r[lc] && (r[pc] == null || r[pc] === '')) continue;
        const k = lipidKey(r[lc]), p = num(r[pc]);
        if (k === undefined) { problems.push(`lipid name "${r[lc]}" is unknown (add it under Materials first, or use one of: ${lipids.map((l) => l.name).join(', ')})`); continue; }
        if (!k || !Number.isFinite(p)) { problems.push(`${lc} and ${pc} go together`); continue; }
        mol[k] = (mol[k] || 0) + p;
      }
      const sum = Object.values(mol).reduce((a, b) => a + b, 0);
      if (problems.length) { /* an unknown lipid already says why; its mol% missing from the sum would only repeat it */ }
      else if (!Object.keys(mol).length) problems.push('no composition: give composition_id, or the lipids and their mol%');
      else if (Math.abs(sum - 100) > 0.5) problems.push(`mol% add up to ${Math.round(sum * 100) / 100}, not 100`);
      else {
        const found = [...compositions, ...newComps].find((c) => c.mol_pct && sameMix(c.mol_pct, mol));
        if (found) compositionId = found.id;
        else { compositionId = ++topComp; newComps.push({ id: compositionId, synonym: r.composition_name || null, mol_pct: mol, sum, provenance: prov(T, r) }); }
      }
    }
    // Process numbers of the plan, with sense limits; and the process variables, checked by the app's own rule.
    const n = (c, lo, hi, label) => { const v = num(r[c]); if (v == null) return null; if (!Number.isFinite(v)) { problems.push(`${label} "${r[c]}" is not a number`); return null; } if (v < lo || v > hi) problems.push(`${label} ${v} is outside ${lo}–${hi}`); return v; };
    const plan = Object.fromEntries(PLAN_COLUMNS.map(([c, lo, hi, label]) => [c, n(c, lo, hi, label)]));
    // On plan.conditions: an imported record has no process designer behind it, so what the sheet says about the
    // buffer, the mixer and the downstream is kept there and read as the record's own (calc/variables.js).
    const conditions = {};
    for (const k of PROCESS_COLS) {
      if (r[k] == null || r[k] === '') continue;
      const v = VARIABLE_BY_KEY[k];
      let val = v.kind === 'number' ? num(r[k]) : v.kind === 'bool' ? (typeof r[k] === 'boolean' ? r[k] : /^(yes|ja|true|1|y)$/i.test(r[k]) ? true : /^(no|nein|false|0|n)$/i.test(r[k]) ? false : r[k]) : r[k];
      if (v.kind === 'number' && Number.isNaN(val)) val = r[k];
      if (v.kind === 'category' && !v.addable) val = v.options.find((o) => o.toLowerCase() === String(val).toLowerCase()) || val;
      const bad = checkVariable(k, val);
      if (bad.length) problems.push(...bad); else conditions[k] = val;
    }
    if (problems.length) {
      // A composition made only for this row goes with it: it would otherwise enter the lab unused.
      const mine = newComps.findIndex((c) => c.id === compositionId && c.provenance?.row === (r.__origin?.row ?? r.__row));
      if (mine >= 0 && mine === newComps.length - 1) { newComps.pop(); topComp--; }
      refuse(T, r, problems.join('; ')); refusedForms.add(r.exp_key); continue;
    }
    const id = nextFormulation(exp);
    exp.batchIds.push(id);
    batches.set(key, {
      id, experimentId: exp.id, label: r.label || r.form_key, compositionId, stockId: null, plannedDate: r.date || exp.startDate || null, status: 'measured',
      plan: { rna: { lotId: r.rna_lot || null, working_mg_mL: plan.rna_mg_mL, np: plan.np, ...(['mRNA', 'siRNA'].includes(conditions.rnaType) ? { cargo: conditions.rnaType } : {}) }, mixing: { frr: plan.frr, totalFlow: plan.tfr_ml_min, quenchFactor: plan.quench_factor, lipidStock_mM: plan.lipid_mM, mixer: null }, downstream: {}, factors: {}, conditions },
      actual: {}, notes: [r.notes, `Historical key: ${r.form_key}`].filter(Boolean).join('\n'), provenance: prov(T, r),
    });
  }

  // ---- measurements
  const measurements = [];
  const seenM = new Set();
  for (const r of meT?.rows || []) {
    const T = 'measurements';
    if (duplicate(T, r)) continue;
    const b = batches.get(`${r.exp_key}/${r.form_key}`) || (attachMeasurements ? lab.batchesByKey.get(`${r.exp_key}/${r.form_key}`) : null);
    if (!b) { refuse(T, r, `no formulation ${r.exp_key}/${r.form_key} (or it was refused itself)`); continue; }
    const test = String(r.test || '').toLowerCase();
    if (!TESTS[test]) { refuse(T, r, `test "${r.test}" is not one of ${Object.keys(TESTS).join(', ')}`); continue; }
    const { values, problems, warnings } = checkMeasurementValues(test, r);
    if (!Object.keys(values).length && !problems.length) problems.push(`no value for ${test} (columns: ${Object.keys(TESTS[test]).join(', ')})`);
    const stage = r.stage || 'final';
    const dup = `${b.id}|${test}|${stage}|${r.timepoint_days || ''}|${r.condition || ''}|${r.replicate || ''}`;
    if (seenM.has(dup)) problems.push('the same formulation, test, stage and timepoint appear twice (number the replicates in "replicate")');
    if (problems.length) { refuse(T, r, problems.join('; ')); continue; }
    seenM.add(dup);
    if (test === 'dls') values.runs = [{ zave_nm: values.zave_nm ?? null, pdi: values.pdi ?? null }];
    const sample = `${b.id}_${stage}${r.condition ? '_' + r.condition : ''}${r.timepoint_days ? '_T' + String(r.timepoint_days).padStart(2, '0') : ''}`;
    const p = prov(T, r);
    measurements.push({ id: `${importId}-m${(ref.measurementStart || 0) + measurements.length + 1}`, batchId: b.id, experimentId: b.experimentId, stage, test, values, date: r.date || b.plannedDate, operator: r.operator || '',
      sampleName: sample, remarks: r.notes || '', raw: r.source_file ? { fileName: r.source_file } : null, condition: r.condition || undefined, timepoint: r.timepoint_days ? num(r.timepoint_days) : undefined,
      flags: warnings.map((text) => ({ level: 'warn', text })), provenance: { ...p, ...(r.source_file && !r.__origin ? { file: { name: r.source_file } } : {}), ...(r.sheet && !r.__origin ? { sheet: r.sheet } : {}) } });
  }

  // A mixer named in the sheet stays on the formulation's conditions; the lab's mixer records (Materials ›
  // Devices) are not added to from an import, so a typo cannot become a device.
  const mixers = [];
  // An experiment with nothing in it is left out, unless a formulation of it waits in quarantine: it is where that
  // formulation goes once it is fixed (app/ui/quarantine.js).
  const all = [...experiments.entries()];
  const fresh = all.filter(([k, e]) => !inLab.has(k) && (e.batchIds.length || refusedForms.has(k))).map(([, e]) => e);
  const experimentUpdates = all.filter(([k, e]) => inLab.has(k) && e.batchIds.length > (inLab.get(k).batchIds || []).length).map(([k, e]) => ({ id: e.id, batchIds: e.batchIds, added: e.batchIds.slice((inLab.get(k).batchIds || []).length) }));
  return {
    importId, importedAt, experiments: fresh, experimentUpdates, batches: [...batches.values()], measurements, compositions: newComps, mixers, quarantine, duplicates,
    read: { experiments: exT ? exT.rows.length : null, formulations: foT ? foT.rows.length : null, measurements: meT ? meT.rows.length : null },
  };
}

/** The refusal reasons grouped by kind: quoted values and numbers stand as …, the list of known lipids is left off. */
export function groupReasons(quarantine) {
  const reasons = {};
  for (const q of quarantine) {
    const k = `${q.file}: ${q.reason.split('; ').map((r) => r.replace(/ \(add it under Materials.*$/, ' (add it under Materials first)').replace(/"[^"]*"/g, '"…"').replace(/no formulation \S+/, 'no formulation …').replace(/ as E\d+(-F\d+)?/, ' as E…').replace(/\b\d+(\.\d+)?\b/g, '…')).join('; ')}`;
    reasons[k] = (reasons[k] || 0) + 1;
  }
  return Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, n }));
}

/**
 * The completeness of what would be imported, exactly as the Data overview reports it (app/calc/facets.js
 * completeness): the importable formulations, with their measurements, as data-overview rows.
 * `ref` = {compositionById, lipidByKey}.
 */
export function importCompleteness(result, ref = {}) {
  const compositionById = { ...(ref.compositionById || {}), ...Object.fromEntries(result.compositions.map((c) => [c.id, c])) };
  const rows = dataRows({ batches: result.batches, experiments: result.experiments, measurements: result.measurements }, { ...ref, compositionById });
  return completeness(rows).map((c) => ({ key: c.key, label: c.label, n: c.n, share: Math.round(c.share * 100), level: c.level }));
}

/**
 * The quality report's numbers (spec 6.4): per table how many rows were read, are importable, are refused and
 * are duplicates; the reasons grouped; the completeness matrix.
 */
export function qualityReport(result, ref = {}) {
  const per = (t, importable) => ({ read: result.read[t], importable, refused: result.quarantine.filter((q) => q.table === t).length, duplicates: result.duplicates.filter((q) => q.table === t).length });
  const exps = result.experiments;
  return {
    importId: result.importId,
    counts: {
      experiments: per('experiments', exps.length), formulations: per('formulations', result.batches.length), measurements: per('measurements', result.measurements.length),
      newCompositions: result.compositions.length, newMixers: result.mixers.length,
    },
    experimentIds: exps.length ? [exps[0].id, exps[exps.length - 1].id] : [],
    reasons: groupReasons(result.quarantine),
    completeness: importCompleteness(result, ref),
  };
}

/** The report as markdown, for quality-report.md and for Claude to show. */
export function reportMarkdown(rep, { title = 'Import quality report', from = '', next = '' } = {}) {
  const c = rep.counts, dash = (v) => (v == null ? '–' : v);
  const line = (label, k) => `| ${label} | ${dash(c[k].read)} | ${c[k].importable} | ${c[k].refused} | ${c[k].duplicates} |`;
  const mark = (l) => ({ good: 'good', warn: 'patchy', bad: 'missing' }[l]);
  return `# ${title}

Import ${rep.importId}${from ? ` · ${from}` : ''}

| | read | importable | refused | duplicates |
|---|---:|---:|---:|---:|
${line('Experiments', 'experiments')}
${line('Formulations', 'formulations')}
${line('Measurements', 'measurements')}
| New compositions | | ${c.newCompositions} | | |

New experiment numbers: ${rep.experimentIds.length ? `${rep.experimentIds[0]} to ${rep.experimentIds[1]}` : 'none'}.

## Why rows were refused
${rep.reasons.length ? rep.reasons.map((r) => `- ${r.n} × ${r.reason}`).join('\n') : 'None.'}

Every refused row goes to quarantine with its own reason, to be fixed and checked again.

## Completeness of the importable formulations
| Field | Share | |
|---|---:|---|
${rep.completeness.map((x) => `| ${x.label} | ${x.share} % | ${mark(x.level)} |`).join('\n')}
${next ? `\n## Next step\n${next}\n` : ''}`;
}

/** Quarantine records for the store: {id, importId, table, raw, mapping, reason, origin, originKey, status, createdAt}. */
export function quarantineRecords(result, { at = result.importedAt } = {}) {
  return result.quarantine.map((q, i) => ({
    id: `${result.importId}-q${i + 1}`, importId: result.importId, table: q.table, file: q.file, row: q.row,
    raw: q.source, mapping: q.raw, reason: q.reason, origin: q.origin, originKey: q.originKey, status: 'open', createdAt: at,
  }));
}
