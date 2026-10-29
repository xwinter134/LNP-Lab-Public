// Assembling a training set out of what the lab already recorded. No separate data entry: every produced batch
// with a measured response is a training row, so the model improves as a side effect of normal work.
import { getRef, getSettings } from '../../refdata.js';
import { readFactors } from './space.js';
import { RESPONSES, responsesForBatch } from '../doe.js';
import { measurementIndex } from '../indexes.js';

/** Response definitions shared with the DoE pipeline, so a run means the same thing in both places. */
export const RESPONSE_DEFS = RESPONSES;

/**
 * One row per batch: its factor settings, its measured responses, and the grouping keys used for honest
 * cross-validation (experiment, composition, date, lipid stock lot).
 */
export function buildRows(ctx) {
  const ref = getRef(ctx);
  const driftBasis = getSettings(ctx).driftBasis || 'auto';
  // Each batch is handed only its own measurements, grouped once: responsesForBatch() looks no further than
  // the batch it is asked about, and a pass over a year of measurements for every batch took seconds.
  const measurements = measurementIndex(ctx.store.all('measurements'));
  const exps = Object.fromEntries(ctx.store.all('experiments').map((e) => [e.id, e]));
  const rows = [];
  for (const b of ctx.store.all('batches')) {
    // One reader for measured and derived responses alike, shared with the DoE screen.
    const { values, sources } = responsesForBatch(measurements.forBatch(b.id), b.id, { driftBasis });
    const comp = ref.compositionById[b.compositionId];
    rows.push({
      batchId: b.id, experimentId: b.experimentId || null, experimentName: exps[b.experimentId]?.name || '',
      experimentType: exps[b.experimentId]?.type || '', label: b.label || '', compositionId: b.compositionId ?? null,
      synonym: comp?.synonym || '', stockId: b.stockId || null, status: b.status,
      date: sources[RESPONSE_DEFS[0].name]?.date || b.plannedDate || '',
      factors: readFactors(b, ref), values, sources,
      suggestedByMl: !!b.ml, mlPredicted: b.ml?.predicted || null, mlPurpose: b.ml?.purpose || null,
      nResponses: Object.keys(values).length,
    });
  }
  return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** Rows usable for a given set of factors and responses: every factor known, at least one response measured. */
export function usableRows(rows, space, responseNames) {
  return rows.filter((r) => space.every((s) => Number.isFinite(r.factors[s.key])) && responseNames.some((n) => Number.isFinite(r.values[n])));
}

/** Per-response counts, so the screen can say which goal has enough data to model. */
export function responseCounts(rows, space) {
  const out = {};
  for (const r of RESPONSE_DEFS) {
    const n = rows.filter((x) => Number.isFinite(x.values[r.name]) && space.every((s) => Number.isFinite(x.factors[s.key]))).length;
    out[r.name] = n;
  }
  return out;
}

/** Duplicate settings (same factor values) are replicates: worth flagging, since they set the noise floor. */
export function replicateGroups(rows, space) {
  const key = (r) => space.map((s) => Math.round(r.factors[s.key] * 1e4) / 1e4).join('|');
  const by = {};
  for (const r of rows) (by[key(r)] ||= []).push(r);
  return Object.values(by).filter((g) => g.length > 1);
}

/** Observed noise per response, estimated from replicates; the floor on what any model can predict. */
export function noiseFromReplicates(rows, space, responseName) {
  const groups = replicateGroups(rows, space);
  let ss = 0, df = 0;
  for (const g of groups) {
    const v = g.map((r) => r.values[responseName]).filter(Number.isFinite);
    if (v.length < 2) continue;
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    ss += v.reduce((a, b) => a + (b - m) ** 2, 0);
    df += v.length - 1;
  }
  return df > 0 ? { sd: Math.sqrt(ss / df), df, groups: groups.length } : null;
}

/* ---------------- where the data comes from ---------------- */

/**
 * The optimizer's data, accounted for: which formulations the model is fitted on, from which experiments, and
 * every formulation left out with the reason. "Fitted on 38 formulations from 5 experiments" is a statement
 * the user can check against their own records; "38 usable runs" was not (usability: "it just says it has
 * discovered runs").
 *
 * A formulation is left out, for the first of these that holds:
 *   excluded       its experiment was switched off on the Data used card
 *   noResult       no result yet for any response switched on as a goal (planned, or measured for others only)
 *   missingFactor  a factor being modelled has no value on its record
 *   outside        a factor lies outside the limits the optimizer works in at all (space.js, ALL_FACTORS lo–hi)
 * Everything else is used. A used formulation whose setting lies outside the search range typed on the screen
 * is still used (it is evidence about the surface near that edge) and is marked `outsideSearch`, so the card
 * can say so rather than leave the user wondering why the model knows about a corner they ruled out.
 *
 * @param {object[]} rows  buildRows()
 * @param {object} o
 * @param {object[]} o.space    the factors being modelled ({key, lo, hi})
 * @param {object[]} o.goals    the goals; those with `on: false` do not count
 * @param {string[]} [o.excluded]  experiment ids switched off ('' for formulations under no experiment)
 * @param {object[]} [o.limits] the factor limits (ALL_FACTORS); passed in so this stays free of space.js
 */
export function dataAccount(rows, { space = [], goals = [], excluded = [], limits = [] } = {}) {
  const off = new Set(excluded.map(String));
  const active = goals.filter((g) => g.on !== false).map((g) => g.name);
  const limitOf = new Map(limits.map((f) => [f.key, f]));
  const fmtv = (v) => String(Number(Number(v).toPrecision(4)));
  const out = { used: [], left: [], experiments: [], reasons: { excluded: 0, noResult: 0, missingFactor: 0, outside: 0 } };
  const byExp = new Map();
  for (const r of rows) {
    const key = r.experimentId || '';
    if (!byExp.has(key)) {
      byExp.set(key, { id: key, name: r.experimentName || '', type: r.experimentType || '', excluded: off.has(key),
        total: 0, measured: 0, used: 0, responses: {}, left: { excluded: 0, noResult: 0, missingFactor: 0, outside: 0 }, outsideSearch: 0 });
    }
    const e = byExp.get(key);
    e.total++;
    const has = Object.keys(r.values || {}).filter((n) => Number.isFinite(r.values[n]));
    for (const n of has) e.responses[n] = (e.responses[n] || 0) + 1;
    if (has.length) e.measured++;
    let reason = null, detail = '';
    if (e.excluded) { reason = 'excluded'; detail = 'its experiment is switched off'; }
    else if (!active.some((n) => Number.isFinite(r.values?.[n]))) {
      reason = 'noResult';
      detail = r.status === 'planned' && !has.length ? 'not made yet' : has.length ? 'measured, but not for a response switched on as a goal' : 'no result yet';
    } else {
      const missing = space.filter((s) => !Number.isFinite(r.factors?.[s.key]));
      if (missing.length) { reason = 'missingFactor'; detail = `no ${missing.map((s) => s.name || s.key).join(', ')} on its record`; }
      else {
        const far = space.filter((s) => { const f = limitOf.get(s.key); const v = r.factors[s.key]; return f && (v < f.lo || v > f.hi); });
        if (far.length) { reason = 'outside'; detail = far.map((s) => { const f = limitOf.get(s.key); return `${s.name || s.key} ${fmtv(r.factors[s.key])}, outside ${fmtv(f.lo)}–${fmtv(f.hi)}`; }).join('; '); }
      }
    }
    if (reason) {
      out.reasons[reason]++; e.left[reason]++;
      out.left.push({ batchId: r.batchId, experimentId: key, label: r.label || '', reason, detail });
    } else {
      const outsideSearch = space.filter((s) => r.factors[s.key] < s.lo - 1e-9 || r.factors[s.key] > s.hi + 1e-9).map((s) => s.name || s.key);
      if (outsideSearch.length) e.outsideSearch++;
      e.used++;
      out.used.push(outsideSearch.length ? { ...r, outsideSearch } : r);
    }
  }
  const num = (id) => Number(/^E(\d+)/.exec(id)?.[1]) || Infinity;
  out.experiments = [...byExp.values()].sort((a, b) => num(a.id) - num(b.id) || a.id.localeCompare(b.id));
  out.usedExperiments = out.experiments.filter((e) => e.used > 0).length;
  return out;
}
