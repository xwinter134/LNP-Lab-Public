// Record types (documentation by JSDoc) and the naming conventions.
// Collections in the store: experiments, batches, stocks, buffers, measurements, events, lots, counters (see
// counterTop).

/**
 * @typedef {object} Experiment
 * @property {string} id            E1, E2 … (see experimentId())
 * @property {'single'|'stability'|'ofat'|'doe'|'comparison'|'reference'} type
 * @property {string} name
 * @property {object} design        type-specific: factors/levels, conditions, timepoints, measurements per timepoint
 * @property {string[]} batchIds
 * @property {object[]} expected    expected measurement slots {batchId, condition, timepoint, test, dueDate, status}
 * @property {string} status        planned | running | done
 */

/**
 * @typedef {object} Batch   one LNP lot, mirrors the batch record steps
 * @property {string} id            E1-F2 — formulation 2 of experiment 1 (see formulationId())
 * @property {string} experimentId
 * @property {number} compositionId entry # in the composition registry
 * @property {string} stockId       lipid stock used (Stock.id)
 * @property {object} rna           {lot, construct, stock_mg_mL, working_mg_mL, mass_mg, np}
 * @property {object} mixing        {flows:{p1,p2,p3,p4}, frr, quenchFactor, lipidStock_mM, totalFlow}
 * @property {object} downstream    {dialysis:{start_mL, volume_L, hours}, tff:{target_mg_mL}, finalFormulation:{buffer1, buffer2, final_mg_mL}, filtration, fill}
 * @property {object} process       device, mixer, quench, aqueous and quench buffers, downstream steps (app/calc/process.js);
 *                                  older records kept rna.diluent, mixing.quenchBuffer, dialysis.cassette/buffer and
 *                                  tff.enabled/module instead, which the record moves here when it is opened
 * @property {string} mode          'quick' (mixing only, from volume_mL) | 'full' (missing on older records: full)
 * @property {object} actual        operator-entered actual values per step, never overwriting the plan
 * @property {string} status        planned | produced | measured | analyzed
 */

/**
 * @typedef {object} Stock   lipid stock in ethanol (from the weigh-in sheet)
 * @property {string} id            Stock-001 … (see stockId())
 * @property {number} compositionId
 * @property {number} molarity_mM
 * @property {number} volume_mL
 * @property {object[]} rows        {key, lot, pct, mw, weighG, actualG}
 * @property {number} ethanolG
 * @property {string} date, operator, container, filter
 */

/**
 * @typedef {object} Buffer
 * @property {string} id            Buffer-001 …
 * @property {string} name          "Acetate 50 mM pH 5.5"
 * @property {string} lot           Buffer-001
 * @property {object} recipe        {system, targetPH, conc_M, volume_mL, reagents:[{name, grams}], predictedPH, ionicStrength}
 * @property {string[]} roles       loading | quench | dialysis | final formulation
 */

/**
 * @typedef {object} Measurement
 * @property {string} id
 * @property {string} batchId
 * @property {string} stage         final | IPC4 | … | release | T0 | T3 …  (stability timepoint)
 * @property {string} test          dls | zeta | ee | content | potency | ph | osmolality | integrity | lipid_content | endotoxin
 * @property {object} values        test-specific: {zave_nm, pdi, runs:[…]} …
 * @property {object} raw           {fileName, sha256, parser, parserVersion}
 * @property {string} date, operator
 */

/**
 * Naming.
 *
 * Experiments are numbered 1, 2, 3 …, and each formulation is numbered inside the experiment that planned
 * it: `E3-F2` is the second formulation of experiment 3. An id therefore says where a record sits in the
 * plan, which is the one thing worth encoding — when an instrument export comes back with forty rows in it,
 * what you need from a sample name is which experiment it belongs to and which arm of it.
 *
 * What the formulation was made from is on its record, not in its name. An earlier scheme numbered every
 * formulation in one global sequence (LNP_01, LNP_02 …), and before that put the composition number in the
 * lot; the first told you nothing about the experiment, and the second told you something that stops being
 * true the moment a run varies the composition — which, in a designed experiment, is the point.
 *
 * Lipid stocks and buffers are materials rather than formulations and get their own plain series,
 * `Stock-001` and `Buffer-001`.
 */
export function experimentId(no) { return `E${Math.max(1, Math.floor(no) || 1)}`; }
export function formulationId(expId, no) { return `${expId}-F${Math.max(1, Math.floor(no) || 1)}`; }
export function stockId(no) { return `Stock-${String(Math.max(1, Math.floor(no) || 1)).padStart(3, '0')}`; }

/** "Experiment 3", "Experiment 3 · formulation 2" — the id spelled out for a heading. */
export function describeId(id) {
  const m = /^E(\d+)(?:-F(\d+))?$/.exec(String(id || ''));
  if (!m) return String(id || '');
  return m[2] ? `Experiment ${m[1]} · formulation ${m[2]}` : `Experiment ${m[1]}`;
}

/** The highest number already used in a series, so the next one is free. `re` must capture the number. */
function highest(ids, re) {
  let top = 0;
  for (const id of ids || []) { const m = re.exec(String(id)); if (m) top = Math.max(top, Number(m[1]) || 0); }
  return top;
}

/**
 * Next free experiment id. Pass `usedIds(store, 'experiment')`, not the live experiments: a number is free
 * only when nothing anywhere still carries it (see usedIds).
 */
export function nextExperimentId(ids) { return experimentId(highest(ids, /^E(\d+)$/) + 1); }

/** Next free lipid stock id, from `usedIds(store, 'stock')`. */
export function nextStockId(ids) { return stockId(highest(ids, /^Stock-(\d+)$/) + 1); }

/*
 * A number is never given out twice (usability cycle 3, C1).
 *
 * Deleting an experiment moves it and its formulations to the trash and leaves its measurements where they
 * are: a result is evidence, and outlives the plan it was made under. Numbering the next experiment from the
 * live records alone therefore handed the deleted experiment's number to the next one created, and with it
 * the formulation ids the old results still name. The old E10-F1's size became the new E10-F1's, in its
 * Results card, in the optimizer and in every export, and an instrument file of the old run matched the new
 * one; Undo of the delete was then refused because E10 was taken.
 *
 * So the next id in every series is numbered past every id that still leaves a trace anywhere: the live
 * records, the ones in the trash, and everything that names one (a measurement's formulation and experiment,
 * the sample name of an unassigned import, an expected slot, the stock or buffer lot written on a formulation,
 * the link on a calendar entry). One helper collects them all, so no screen that creates a record can forget
 * a source.
 */

// The collections whose records can carry an id or name one. The trash is walked whole, so a deleted record
// counts with every reference it held.
const TRACE_COLLECTIONS = ['experiments', 'batches', 'stocks', 'buffers', 'measurements', 'inbox', 'imports', 'events', 'trash'];

// What counts as an id of each series. A string that *is* one, or starts with one followed by "_" (a sample
// name or slot id: E3-F2_final, E6-F1_4C_T09, E3-F2_final_dls); a formulation id counts for its experiment too.
// `lead` is the first letter every such string starts with, so the thousands of other strings in a large lab
// are passed over without a regular expression being run on them. A series with a counter (see below) also
// says how its number is read (`no`) and written (`make`).
const SERIES = {
  experiment: { lead: 'E', re: /^(E\d+)(?:-F\d+)?(?:_|$)/, no: /^E(\d+)$/, make: experimentId },
  formulation: { lead: 'E', re: /^(E\d+-F\d+)(?:_|$)/ },
  stock: { lead: 'S', re: /^(Stock-\d+)$/, no: /^Stock-(\d+)$/, make: stockId },
  // Written here rather than imported from calc/buffer.js (bufferLot), which would make the two modules import
  // each other; the format is the same, Buffer-001.
  buffer: { lead: 'B', re: /^(Buffer-\d+)$/, no: /^Buffer-(\d+)$/, make: (n) => `Buffer-${String(n).padStart(3, '0')}` },
};

/**
 * Every id of one series that has ever been used and still leaves a trace in the store (see above), for
 * nextExperimentId, makeFormulationAllocator, nextStockId and nextBufferLot.
 *
 * Every string in those collections is looked at, rather than a list of the fields known to hold an id: a
 * field added next year that names a formulation is then covered without anyone remembering this function.
 * Free text that mentions an id in passing ("as E3, but colder") does not count; reserving its number would do
 * no harm, but nothing would explain the gap. A link counts by its parameters (#/formulation?batch=E3-F2).
 *
 * What it cannot see is a number nothing names any more: an experiment without results whose trash entry has
 * expired. That is what the series' counter is for (see counterTop): its high-water mark counts as one more
 * trace, written as the id it stands for, so every allocator reads it without being told.
 *
 * @param {{all: (col: string) => object[], ns?: string}} store   the Store, or anything that reads a collection the same way
 * @param {'experiment'|'formulation'|'stock'|'buffer'} kind
 * @returns {string[]} the ids, each once, in no particular order
 */
export function usedIds(store, kind) {
  if (!Object.prototype.hasOwnProperty.call(SERIES, kind)) throw new Error(`usedIds: no series called "${kind}"`);
  const { lead, re, make } = SERIES[kind];
  const out = new Set();
  if (make) { const top = counterTop(store, kind); if (top > 0) out.add(make(top)); }
  const one = (s) => { if (s[0] === lead) { const m = re.exec(s); if (m) out.add(m[1]); } };
  const take = (s) => {
    one(s);
    const q = s.indexOf('?');
    if (q >= 0) for (const v of new URLSearchParams(s.slice(q + 1)).values()) one(v);
  };
  const visit = (v) => {
    if (typeof v === 'string') take(v);
    else if (Array.isArray(v)) for (const x of v) visit(x);
    else if (v && typeof v === 'object') for (const k in v) { one(k); visit(v[k]); }
  };
  for (const col of TRACE_COLLECTIONS) visit(store.all(col));
  return [...out];
}

/*
 * The high-water mark of each series (usability cycle 4, m1).
 *
 * usedIds finds every number something in the store still names. An experiment that never had a result leaves
 * nothing behind once its 30-day trash entry has expired, so its number was free again, and that is not
 * harmless: the tube labels, printed worksheets and instrument files of the old E14 still say E14, and the
 * next import would match them to the new one.
 *
 * So each series keeps the highest number it has given out, in the `counters` collection
 * ({id: 'experiment', top: 14}), raised whenever a record is saved under a new number (raiseCounter). It is an
 * ordinary collection, so a backup carries it and a restore on another machine brings it along.
 *
 * Formulations have no counter of their own. They are numbered inside their experiment and are only ever
 * created with a new one (an optimizer round is a new experiment too, see app/ui/ml.js), and only deleted with
 * it, so a new experiment number is enough to keep every formulation id new.
 *
 * A restore must never lower a counter. Store.importAll replaces a record by id (and, asked to replace, a whole
 * collection), so an older backup hands back its lower top along with its records. The mark is therefore also
 * kept in this browser's own bookkeeping, a dotted key under the namespace (`lnp-lab.counter.experiment`), which
 * a backup neither carries nor overwrites, and the higher of the two counts: a backup with a higher counter wins,
 * one with a lower counter changes nothing. Clearing the browser's data clears both, as it clears everything else.
 */
const COUNTERS = 'counters';

const markKey = (store, kind) => (store?.ns ? `${store.ns}.counter.${kind}` : null);
function markGet(store, kind) {
  const k = markKey(store, kind);
  try { return k ? Number(globalThis.localStorage?.getItem(k)) || 0 : 0; } catch { return 0; }
}
function markSet(store, kind, n) {
  const k = markKey(store, kind);
  try { if (k) globalThis.localStorage?.setItem(k, String(n)); } catch {}
}
const recordTop = (store, kind) => Number(store.all(COUNTERS).find((c) => c?.id === kind)?.top) || 0;

/** The highest number a series has given out, as far as this browser knows: 0 when it has none. */
export function counterTop(store, kind) {
  if (!SERIES[kind]?.make) return 0;
  return Math.max(recordTop(store, kind), markGet(store, kind));
}

/**
 * Raise a series' counter to the number in `id` (E14, Stock-014, Buffer-014), once a record has been saved
 * under it. Called after the save, not when the number is worked out, so a creation given up halfway (a
 * confirm cancelled, nothing to build) leaves no gap behind. Never lowers it; brings the stored record back up
 * to this browser's mark when a restore has lowered it, so the next backup carries the right number.
 * Returns the counter's top.
 *
 * Called inside the create's transaction, the counter record goes with it, stored or undone, and this
 * browser's mark is raised only once it is stored (usability cycle 6, W4). Raised at once, the mark outlived an
 * undone create: the form had shown Buffer-001, the press that failed on a full disk was undone, and the next
 * press stored Buffer-002, so the bottle labelled from the printed recipe did not match its record. While the
 * write is pending the number is still taken: the counter record and the new record are in memory, where
 * usedIds and counterTop read them.
 */
export function raiseCounter(store, kind, id) {
  const s = SERIES[kind];
  if (!s?.make) throw new Error(`raiseCounter: the series "${kind}" has no counter`);
  const m = s.no.exec(String(id ?? ''));
  const top = Math.max(counterTop(store, kind), m ? Number(m[1]) || 0 : 0);
  if (top > recordTop(store, kind)) store.put(COUNTERS, { id: kind, top });
  const mark = () => { if (top > markGet(store, kind)) markSet(store, kind, top); };
  // Outside a transaction this runs at once, as the put above is kept whatever happens to its write.
  if (typeof store.transaction === 'function') store.transaction(() => {}, { onSaved: mark }); else mark();
  return top;
}

/**
 * Give every series a counter if it has none: a store written before there were counters, or restored from a
 * backup made before them, starts from every number it still names, the trash included, before an expiry can
 * free one. Each series is walked once, the first time; afterwards this is one read. Once the app holds any
 * number, a series with nothing in it is stored at 0, so it is not walked again; until then nothing is written,
 * since an empty store has nothing to protect and costs nothing to walk, and the first backup restored into a
 * fresh browser is then still seeded from.
 */
export function seedCounters(store) {
  const rows = store.all(COUNTERS);
  const have = new Set(rows.map((c) => c?.id));
  const tops = Object.keys(SERIES).filter((kind) => SERIES[kind].make && !have.has(kind))
    .map((kind) => [kind, highest(usedIds(store, kind), SERIES[kind].no)]);
  if (!rows.length && tops.every(([, top]) => top === 0)) return;
  for (const [kind, top] of tops) {
    store.put(COUNTERS, { id: kind, top });
    if (top > markGet(store, kind)) markSet(store, kind, top);
  }
}

/**
 * Results whose formulation is not where they say, for the start-up check in app/main.js. Nothing is changed;
 * the overview says where to look, and what to do with each result is the user's call.
 *
 * `missing`: the measurement names a formulation that is neither on record nor in the trash. Deleting an
 * experiment keeps its formulations in the trash for 30 days, so this is a formulation whose trash entry has
 * expired, or a record damaged or edited by hand.
 *
 * `reused`: the formulation it names is on record, but the trash holds a different, earlier formulation of the
 * same id. Only the numbering before usedIds could do that: the result may belong to either.
 *
 * @returns {{missing: {id: string, batchId: string}[], reused: {id: string, batchId: string}[]}}
 */
export function orphanedResults(store) {
  const live = new Map(store.all('batches').filter((b) => b?.id != null).map((b) => [b.id, b]));
  const trashed = new Map();
  for (const t of store.all('trash')) for (const r of t?.records || []) if (r?.col === 'batches' && r.rec?.id != null) trashed.set(r.rec.id, r.rec);
  const missing = [], reused = [];
  for (const m of store.all('measurements')) {
    const id = m?.batchId;
    if (id == null || id === '') continue;
    const cur = live.get(id), old = trashed.get(id);
    if (!cur) { if (!old) missing.push({ id: m.id, batchId: id }); continue; }
    // A delete cut off halfway leaves the same record in both places; only a different record is a reuse.
    // createdAt tells them apart, and survives edits; without it on both there is no telling, so nothing is said.
    if (old && old.createdAt && cur.createdAt && old.createdAt !== cur.createdAt) reused.push({ id: m.id, batchId: id });
  }
  return { missing, reused };
}

/**
 * Allocate formulation ids inside one experiment. The wizard creates its runs all at once; the optimizer
 * builds them one at a time into one new experiment, sharing one allocator (each optimizer round is a new
 * experiment, never more runs added to an old one). The counter starts above whatever `taken` holds for the
 * experiment: `taken` is `usedIds(store, 'formulation')`, so a formulation only its results still name keeps
 * its number too. Ids of other experiments are ignored.
 */
export function makeFormulationAllocator(expId, taken = []) {
  const re = new RegExp(`^${String(expId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-F(\\d+)$`);
  let next = highest(taken, re) + 1;
  return () => formulationId(expId, next++);
}

/** Sample name for instrument exports; the importer parses it back. E6-F1_4C_T09 / E3-F2_final */
export function sampleName({ condition, timepoint, batchId, stage }) {
  if (condition != null && timepoint != null) return `${batchId}_${condition}_T${String(timepoint).padStart(2, '0')}`;
  return `${batchId}_${stage ?? 'final'}`;
}

/**
 * Read a sample name back. The current scheme is `E3-F2` plus either a stage or a condition and timepoint;
 * the two older ones are still parsed, because an instrument export written last year is still a file
 * somebody will drop on the importer this year.
 */
export function parseSampleName(name) {
  const s = String(name);
  // E6-F1_4C_T09 — a formulation at a storage condition and timepoint.
  let m = s.match(/^(E(\d+)-F(\d+))_([^_]+)_T(\d+)/);
  if (m) return { batchId: m[1], experimentId: `E${m[2]}`, formulation: `F${m[3]}`, condition: m[4], timepoint: Number(m[5]) };
  // E3-F2_final, E3-F2_IPC4, or the bare id.
  m = s.match(/^(E\d+-F\d+)(?:_([A-Za-z0-9]+))?/);
  if (m) return { batchId: m[1], stage: m[2] ?? null };
  // Legacy: S-013_F1_4C_T09, where the formulation was a label rather than part of the id.
  m = s.match(/^(S-\d+)_(F\d+)_([^_]+)_T(\d+)/);
  if (m) return { experimentId: m[1], formulation: m[2], condition: m[3], timepoint: Number(m[4]) };
  // Legacy: <prefix>_<number>, with the prefix left open because it used to be a setting. Requiring digits
  // after the underscore keeps "Blank_PBS" out.
  m = s.match(/^([A-Za-z][A-Za-z0-9]*_\d+)(?:_([A-Za-z0-9]+))?/);
  if (m) return { batchId: m[1], stage: m[2] ?? null };
  return null;
}

const DATA_FILES = ['lipids', 'compositions', 'buffers_catalog', 'tff_modules', 'tff_modules_retired', 'materials', 'pka', 'reagents', 'devices'];

/** Loads app/data/*.json once; the UI gets them through ctx.data. */
export async function loadReferenceData() {
  const out = {};
  await Promise.all(DATA_FILES.map(async (f) => {
    const r = await fetch(`./app/data/${f}.json`);
    if (!r.ok) { out[f] = []; return; }
    const text = await r.text();
    try { out[f] = JSON.parse(text); }
    catch (e) { throw new Error(`app/data/${f}.json is not valid JSON (${e.message})${/^(<<<<<<< |=======$|>>>>>>> )/m.test(text) ? '; it contains git merge-conflict markers, so the last pull did not complete' : ''}`); }
  }));
  out.lipidByKey = Object.fromEntries(out.lipids.map((l) => [l.key, l]));
  out.compositionById = Object.fromEntries(out.compositions.map((c) => [c.id, c]));
  return out;
}
