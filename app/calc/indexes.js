// Lookups by formulation, built once per render.
//
// Usability cycle 4, S2: with a year of records the Formulations list took 10 s to open. Each row found its
// formulation by reading every formulation, and its results with a filter over every measurement, so the
// work grew as formulations × measurements. A screen now builds these maps once, from the arrays it already
// holds, and every row asks the maps instead: the cost grows with the number of records, not with their
// product. Pure: arrays in, maps out, no store and no DOM.
//
// "Latest" means one thing everywhere it is asked here: the newest by measurement date, then by when it was
// stored, because a re-import adds a record and never edits one (the same order as app/calc/results.js and
// app/calc/latest.js). Two records equal on both keep the order they were stored in, the first winning, as
// the first of a stable sort would.

/** Newest first: by measurement date, then by when it was stored. */
export const newestFirst = (a, b) => String(b?.date || '').localeCompare(String(a?.date || ''))
  || String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''));

// Joins the parts of a compound key. Ids, tests and stages are typed or generated text, which never holds a
// control character, so two different keys cannot run together into the same string.
const SEP = '\u0001';
const key = (...parts) => parts.map((p) => (p == null ? '' : String(p))).join(SEP);
const EMPTY = Object.freeze([]);

/**
 * Records grouped by a key, each group in the order the records came in. A record whose key is missing
 * (null, undefined or '') belongs to no group: a measurement waiting in no formulation is not a formulation's.
 */
export function groupBy(rows = [], keyOf) {
  const out = new Map();
  for (const r of rows) {
    if (!r) continue;
    const k = keyOf(r);
    if (k == null || k === '') continue;
    const g = out.get(k);
    if (g) g.push(r); else out.set(k, [r]);
  }
  return out;
}

/** id → record. Of two records with the same id the first wins, as the store's get() finds it. */
export function byId(rows = []) {
  const out = new Map();
  for (const r of rows) if (r && r.id != null && !out.has(r.id)) out.set(r.id, r);
  return out;
}

/**
 * The measurements of a lab, indexed for what a screen asks once per formulation.
 *   forBatch(batchId)              its measurements, in the order they were stored ([] when it has none)
 *   forTest(test)                  every measurement of one test
 *   forBatchTest(batchId, test)    one formulation's measurements of one test
 *   latest(batchId, test, stage)   the newest of those, of that stage when one is given; null when none
 * The arrays handed out are the index's own: read them, do not change them.
 */
export function measurementIndex(measurements = []) {
  const byBatch = new Map(), byTest = new Map(), byBatchTest = new Map(), newest = new Map();
  const push = (map, k, m) => { const g = map.get(k); if (g) g.push(m); else map.set(k, [m]); };
  // The newest per key in one pass. Only a strictly newer record replaces the one held, so a tie keeps the
  // first stored.
  const keep = (k, m) => { const prev = newest.get(k); if (!prev || newestFirst(m, prev) < 0) newest.set(k, m); };
  for (const m of measurements) {
    if (!m) continue;
    if (m.test != null) push(byTest, m.test, m);
    if (m.batchId == null || m.batchId === '') continue;
    push(byBatch, m.batchId, m);
    push(byBatchTest, key(m.batchId, m.test), m);
    keep(key(m.batchId, m.test), m);
    if (m.stage) keep(key(m.batchId, m.test, m.stage), m);
  }
  return {
    size: measurements.length,
    forBatch: (batchId) => byBatch.get(batchId) || EMPTY,
    forTest: (test) => byTest.get(test) || EMPTY,
    forBatchTest: (batchId, test) => byBatchTest.get(key(batchId, test)) || EMPTY,
    latest: (batchId, test, stage = null) => (stage ? newest.get(key(batchId, test, stage)) : newest.get(key(batchId, test))) || null,
    batchIds: () => [...byBatch.keys()],
  };
}

/**
 * Formulations by id and by experiment. Two questions with different answers, both asked by the app:
 *   of(exp)                 the experiment's own list, `batchIds`, in its order (the order they are made in),
 *                           leaving out ids no longer on record — what the experiment page shows
 *   forExperiment(expId)    every formulation that names the experiment, in store order — what the
 *                           progress of an experiment in a list is worked out from
 */
export function batchIndex(batches = []) {
  const ids = byId(batches);
  const byExp = groupBy(batches, (b) => b.experimentId);
  return {
    get: (id) => ids.get(id) || null,
    has: (id) => ids.has(id),
    forExperiment: (expId) => byExp.get(expId) || EMPTY,
    of: (exp) => (exp?.batchIds || []).map((id) => ids.get(id)).filter(Boolean),
  };
}

/**
 * A formulation's results as its row in a list shows them: the newest size of the final product (any stage
 * when the final one was not measured), and the newest EE and zeta. The one rule for the Formulations list
 * and for Insights' rows (which the DoE screen reads too), so the two cannot disagree about a value.
 */
export function batchResults(idx, batchId) {
  return {
    dls: idx.latest(batchId, 'dls', 'final') || idx.latest(batchId, 'dls'),
    ee: idx.latest(batchId, 'ee'),
    zeta: idx.latest(batchId, 'zeta'),
  };
}

/** The first `n` of a list and how many are left: the one rule for a list that renders in pages. */
export function pageOf(rows = [], n = Infinity) {
  const limit = Math.max(0, Math.floor(Number.isFinite(n) ? n : rows.length));
  const shown = rows.length > limit ? rows.slice(0, limit) : rows;
  return { shown, total: rows.length, rest: rows.length - shown.length };
}
