// Typing results in as a grid (spec 9.3): one row per formulation of an experiment, one column per quantity,
// the way the numbers sit in the lab's spreadsheet. Pure: what a cell says, what a pasted block puts where, and
// what a row stores. The screen (app/ui/entrygrid.js) draws the grid and saves what this returns; the import
// preview draws its cells with the same functions, so a typed result and an imported one look the same.
//
// A cell holds one value or up to three replicates ("82; 85; 80"). Replicates are what DLS gives, and typed as a
// single number a result had n = 1 and no SD, while an instrument file keeps every run (usability cycle 3, F2).
// They are stored as an imported result stores them: the runs, their mean as the value, and the SD of the mean
// field (values.runs, zave_nm, zave_sd, pdi for DLS), so nothing downstream has to know how they came in.
import { checkValues, qcFlags, mean, sd } from './qc.js';

/** At most this many replicates in one cell: the three runs a DLS measurement is made of. */
export const MAX_REPLICATES = 3;

/**
 * The quantities the grid can take, in the order the columns appear. `test` is the measurement a column belongs
 * to (a Z-ave and a PDI on one row are one DLS result), `key` the field in `values`, `spread` the field the SD of
 * replicates goes into. `d` is how many decimals a mean is shown with.
 */
export const GRID_COLUMNS = [
  { id: 'zave', test: 'dls', key: 'zave_nm', label: 'Z-ave', unit: 'nm', spread: 'zave_sd', d: 1 },
  { id: 'pdi', test: 'dls', key: 'pdi', label: 'PDI', unit: '', d: 3 },
  { id: 'kcps', test: 'dls', key: 'countRate_kcps', label: 'Count rate', unit: 'kcps', d: 0, single: true },
  { id: 'zeta', test: 'zeta', key: 'zeta_mV', label: 'Zeta', unit: 'mV', spread: 'sd_mV', d: 1 },
  { id: 'ee', test: 'ee', key: 'ee_pct', label: 'EE', unit: '%', spread: 'ee_sd', d: 1 },
  { id: 'rna', test: 'content', key: 'rna_mg_mL', label: 'RNA content', unit: 'mg/mL', spread: 'rna_sd', d: 3 },
  { id: 'ph', test: 'ph', key: 'ph', label: 'pH', unit: '', d: 2, single: true },
  { id: 'osmo', test: 'osmolality', key: 'mOsm_kg', label: 'Osmolality', unit: 'mOsm/kg', d: 0, single: true },
  { id: 'integrity', test: 'integrity', key: 'pct', label: 'Integrity', unit: '%', d: 1, single: true },
  { id: 'endotoxin', test: 'endotoxin', key: 'eu_mL', label: 'Endotoxin', unit: 'EU/mL', d: 2, single: true },
];
export const COLUMN_BY_ID = Object.fromEntries(GRID_COLUMNS.map((c) => [c.id, c]));

/** The columns a set of due tests asks for: size and PDI for DLS, and so on. Z-ave, PDI and EE when none is due. */
export function columnsForTests(tests = []) {
  const want = { dls: ['zave', 'pdi'], zeta: ['zeta'], ee: ['ee'], content: ['rna'], ph: ['ph'], osmolality: ['osmo'], integrity: ['integrity'], endotoxin: ['endotoxin'] };
  const ids = new Set(tests.flatMap((t) => want[t] || []));
  const out = GRID_COLUMNS.filter((c) => ids.has(c.id)).map((c) => c.id);
  return out.length ? out : ['zave', 'pdi', 'ee'];
}

/**
 * One typed number: a decimal comma is a decimal point, the typographic minus some spreadsheets copy out is a
 * minus, and a trailing unit is noise. Anything else is NaN, which says it was a mistake rather than storing 0.
 */
export function cellNumber(s) {
  const t = String(s ?? '').trim().replace(/−/g, '-').replace(',', '.').replace(/\s*(%|nm|mv|mg\/ml|kcps)$/i, '');
  return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? Number(t) : NaN;
}

/**
 * What one cell says: its replicates, their mean and SD, and what is wrong with it as typed.
 *
 * Replicates are separated by a semicolon, a slash, a space or a comma followed by a space ("82; 85; 80",
 * "82 85 80", "82, 85, 80"); a comma inside a number is a decimal comma ("82,4; 85,1"). "82,85,80" is refused
 * rather than guessed at: it could be three sizes or a typing slip, and a wrong guess is a stored result.
 * @returns {{text, values: number[], mean: number|null, sd: number|null, n: number, error: string|null}}
 */
export function parseCell(text, { max = MAX_REPLICATES } = {}) {
  const t = String(text ?? '').trim();
  const out = { text: t, values: [], mean: null, sd: null, n: 0, error: null };
  if (!t) return out;
  // Units go first, wherever they were typed ("82 nm; 85 nm"), so they do not read as values of their own.
  const tokens = t.replace(/%|mg\/ml|\b(?:nm|mv|kcps)\b/gi, ' ').trim().split(/\s*[;/]\s*|,\s+|\s+/).filter((x) => x !== '');
  const nums = tokens.map(cellNumber);
  const bad = tokens.filter((_, i) => Number.isNaN(nums[i]));
  if (bad.length) {
    out.error = /^\d+(,\d+){2,}$/.test(t) || /\d,\d+,\d/.test(bad[0])
      ? `"${bad[0]}" is not a number: separate replicates with ";" (82; 85; 80)`
      : `"${bad[0]}" is not a number`;
    return out;
  }
  if (nums.length > max) { out.error = `up to ${max} values in one cell, ${nums.length} were typed`; return out; }
  out.values = nums; out.n = nums.length; out.mean = mean(nums); out.sd = sd(nums);
  return out;
}

/**
 * A block from the clipboard as rows of cells. Excel and Numbers copy a range as lines of tab-separated cells;
 * a cell that holds a line break or a tab comes out in double quotes, with its own quotes doubled. A single
 * line without a tab is not a block: it is one value, and pastes as one. Trailing empty lines are dropped.
 * @returns {string[][] | null} null when the text is a single value
 */
export function parseClipboard(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  const rows = [[]];
  let cell = '', i = 0, quoted = false;
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { quoted = true; i++; continue; }
    if (ch === '\t') { rows[rows.length - 1].push(cell); cell = ''; i++; continue; }
    if (ch === '\n') { rows[rows.length - 1].push(cell); cell = ''; rows.push([]); i++; continue; }
    cell += ch; i++;
  }
  rows[rows.length - 1].push(cell);
  while (rows.length > 1 && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop();
  const out = rows.map((r) => r.map((c) => c.trim()));
  if (out.length === 1 && out[0].length === 1) return null;
  return out;
}

/**
 * Where the cells of a pasted block go: from the cell it was pasted into, one row per line and one column per
 * tab, into the cells that exist. `free(row, col)` says whether a cell can take a value (a row past the last
 * formulation cannot, nor a column off the grid). An empty cell of the block clears the cell it lands on, as
 * pasting a range in a spreadsheet does.
 * @returns {{puts: {row, col, text}[], lost: number}} lost counts the non-empty values that had nowhere to go
 */
export function distributePaste(block, at, size, free = () => true) {
  const puts = [];
  let lost = 0;
  block.forEach((line, dr) => line.forEach((text, dc) => {
    const row = at.row + dr, col = at.col + dc;
    if (row < size.rows && col < size.cols && free(row, col)) puts.push({ row, col, text });
    else if (text !== '') lost++;
  }));
  return { puts, lost };
}

// Not impossible, and not a QC limit either: what an LNP measurement is very unlikely to be. Said in the warning
// colour as it is typed, and stored if it is saved; the impossible values (checkValues) are refused.
const UNLIKELY = [
  { key: 'zave_nm', test: (x) => x < 10, text: (x) => `Z-ave ${x} nm is smaller than an LNP (below 10 nm)` },
  { key: 'zave_nm', test: (x) => x > 1000, text: (x) => `Z-ave ${x} nm is larger than an LNP (above 1000 nm)` },
];

/**
 * What one row stores, per test, from the cells typed in it. `cells` is {columnId: text}. A Z-ave and a PDI on
 * one row are one DLS result: with replicates, the runs pair up in order (Z-ave 1 with PDI 1), and a PDI typed
 * once beside three sizes is the PDI of the result, not of a run. Each result is checked as any entry is.
 * @returns {{[test]: {values: object|null, errors: {col, text}[], warnings: {col, text}[], flags: object[]}}}
 *   values is null when the result is refused (an impossible value, a cell that is not a number)
 */
export function rowResults(cells = {}, qc = {}) {
  const parsed = {};
  for (const [id, text] of Object.entries(cells)) {
    const col = COLUMN_BY_ID[id];
    if (!col || !String(text ?? '').trim()) continue;
    parsed[id] = parseCell(text, { max: col.single ? 1 : MAX_REPLICATES });
  }
  const byTest = new Map();
  for (const id of Object.keys(parsed)) {
    const col = COLUMN_BY_ID[id];
    if (!byTest.has(col.test)) byTest.set(col.test, []);
    byTest.get(col.test).push(col);
  }
  const out = {};
  for (const [test, cols] of byTest) {
    const errors = [], warnings = [];
    for (const c of cols) if (parsed[c.id].error) errors.push({ col: c.id, text: `${c.label}: ${parsed[c.id].error}` });
    const values = {};
    if (!errors.length) {
      // Replicates go into runs when a column has more than one value. In a DLS result they pair up across the
      // columns that have as many values as the most; a column with one value is the result's own.
      const n = Math.max(...cols.map((c) => parsed[c.id].n));
      if (n > 1) {
        const inRuns = cols.filter((c) => parsed[c.id].n === n);
        for (const c of cols) {
          const p = parsed[c.id];
          if (p.n !== n && p.n !== 1) errors.push({ col: c.id, text: `${c.label}: ${p.n} values beside ${n} of ${inRuns[0].label}; type ${n}, or one for the result as a whole` });
        }
        if (!errors.length) {
          values.runs = Array.from({ length: n }, (_, i) => Object.fromEntries(inRuns.map((c) => [c.key, parsed[c.id].values[i]])));
          for (const c of cols) {
            const p = parsed[c.id];
            values[c.key] = p.mean;
            if (c.spread && p.n > 1) values[c.spread] = p.sd;
          }
        }
      } else for (const c of cols) values[c.key] = parsed[c.id].mean;
      if (!errors.length) {
        const keyCol = (k) => cols.find((c) => c.key === k)?.id || cols[0].id;
        for (const e of checkValues(test, values).errors) errors.push({ col: keyCol(e.key), text: e.text });
        for (const w of checkValues(test, values).warnings) warnings.push({ col: keyCol(w.key), text: w.text });
        for (const u of UNLIKELY) {
          const x = values[u.key];
          if (Number.isFinite(x) && cols.some((c) => c.key === u.key) && u.test(x)) warnings.push({ col: keyCol(u.key), text: u.text(+x.toPrecision(4)) });
        }
      }
    }
    const ok = !errors.length;
    const flags = ok ? qcFlags(test, values, qc) : [];
    // A QC flag is a warning in the grid too, on the column it is about.
    const flagCol = (f) => cols.find((c) => new RegExp(`^${c.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(f.text))?.id || cols[0].id;
    for (const f of flags) if (f.level === 'warn') warnings.push({ col: flagCol(f), text: f.text });
    out[test] = { values: ok ? values : null, errors, warnings, flags };
  }
  return out;
}

/**
 * The state a cell is drawn in: 'bad' (refused on save), 'warn' (stored, worth a look) or '' (fine or empty),
 * and the reasons, for its title. Read from the row's results, so a PDI that makes the whole DLS result refused
 * is marked on its own cell and not on the Z-ave beside it.
 */
export function cellState(results, colId) {
  const col = COLUMN_BY_ID[colId];
  const r = col && results[col.test];
  if (!r) return { state: '', reasons: [] };
  const bad = r.errors.filter((e) => e.col === colId).map((e) => e.text);
  if (bad.length) return { state: 'bad', reasons: bad };
  const warn = r.warnings.filter((w) => w.col === colId).map((w) => w.text);
  return { state: warn.length ? 'warn' : '', reasons: warn };
}

/** "82.3 ± 2.5 (n = 3)": what a cell of replicates comes to, as shown under it. '' for one value or none. */
export function cellSummary(p, d = 1) {
  if (!p || p.n < 2 || p.mean == null) return '';
  const f = (x) => (Number.isFinite(x) ? x.toFixed(d) : '–');
  return `${f(p.mean)} ± ${f(p.sd)} (n = ${p.n})`;
}

/**
 * A stored or imported result as the text of its cell: the runs when it has them, the value otherwise. The
 * import preview draws its cells from this, so a file read back looks as it would have looked typed.
 */
export function cellTextOf(values, colId) {
  const col = COLUMN_BY_ID[colId];
  if (!col || !values) return '';
  const runs = (values.runs || []).map((r) => r?.[col.key]).filter(Number.isFinite);
  const show = (x) => String(+Number(x).toFixed(Math.max(col.d + 1, 2)));
  if (runs.length > 1) return runs.map(show).join('; ');
  return Number.isFinite(values[col.key]) ? show(values[col.key]) : '';
}

/**
 * What undoing a grid save has to put back: each result it stored goes, each slot it closed opens again (unless
 * something else has closed it since), and each formulation it moved to "measured" goes back to the status it
 * had, unless another result keeps it measured. `receipt` is what the save recorded: {measurementIds,
 * slots: [{experimentId, slotId}], batches: [{id, status}]}. `now` = {measurements, experiments, batches} as
 * stored now. Pure, so the undo is the same reverse write wherever it is called from.
 * @returns {{removeMeasurements: string[], experiments: object[], batches: object[]}} the records to put
 */
export function undoGridSave(receipt, now) {
  const gone = new Set((receipt.measurementIds || []).filter((id) => (now.measurements || []).some((m) => m.id === id)));
  const exps = new Map();
  for (const { experimentId, slotId } of receipt.slots || []) {
    const e = exps.get(experimentId) || (now.experiments || []).find((x) => x.id === experimentId);
    if (!e) continue;
    const copy = exps.get(experimentId) || { ...e, expected: (e.expected || []).map((s) => ({ ...s })) };
    const s = copy.expected.find((x) => x.id === slotId);
    if (s && gone.has(s.measurementId)) { s.status = 'open'; s.measurementId = null; }
    exps.set(experimentId, copy);
  }
  const still = (batchId) => (now.measurements || []).some((m) => m.batchId === batchId && !gone.has(m.id));
  const batches = [];
  for (const { id, status } of receipt.batches || []) {
    const b = (now.batches || []).find((x) => x.id === id);
    if (b && b.status === 'measured' && !still(id)) batches.push({ ...b, status });
  }
  return { removeMeasurements: [...gone], experiments: [...exps.values()], batches };
}
