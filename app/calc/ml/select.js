// Which formulations a model is fitted to (spec 7.1, 7.2): the selection per ionizable lipid and mixer type, and
// the data budget for when that still leaves more runs than a Gaussian process should carry.
//
// Why filter by lipid and mixer at all: both change the physics. A T-junction and a herringbone chip mix on
// different time scales, so the same flow rate ratio gives different particles, and two ionizable lipids with
// different pKa and tails do not share one response surface. A model fitted across them averages surfaces that
// are not the same and is confidently wrong for every one of them. So by default the optimizer works on one
// lipid and one mixer type, asks which (preselecting the combination with most data), and says how many
// formulations that leaves out and why. The categorical lipid kernel (lipidmode.js) is the way to use the other
// lipids without pretending they are the same; it filters by mixer only.
//
// Why a budget: the GP costs n³ per likelihood step and holds an n × n matrix, so 10,000 formulations would not
// fit in a browser tab, and most of them would say nothing the nearest few hundred do not. Above the budget
// (Settings, 100-800, default 400) the runs are chosen in four steps, each recorded per formulation so the
// screen can say why any one is not in the model:
//
//   1. relevance      a searched factor outside the search range plus a margin (20 % of the range each side):
//                     a run far outside the box tells the surface inside it little and costs as much as one inside
//   2. quality        a measurement it was read from is not to be believed (dataset.js qualityIssues)
//   3. replicates     the same recipe made several times (the key replicateGroups uses, within one lipid) becomes
//                     one point at the mean. Their scatter is not lost: it is measured before merging and goes to
//                     the fit as the replicate noise estimate, the same path noiseFromReplicates feeds when the
//                     repeats are separate rows. A mean of k runs is less noisy than one run, so treating it as a
//                     single run's noise is conservative: the model is a little less sure near merged points
//                     than it could be, never more.
//   4. subselection   if still over budget, a space-filling choice (greedy maximin on the unit cube), each run's
//                     distance to those already chosen weighted up for a good overall score and for being recent,
//                     so the regions that matter and the current way of working keep their density
//
// Below the budget none of the four steps runs, and the model sees exactly the runs it saw before this existed.
// Every step is deterministic: ties are broken by a seeded order of batch ids, so the same seed and the same
// data give the same selection (tests/mlphase4.test.mjs).
import { NOT_RECORDED } from './dataset.js';
import { overallDesirability } from './objective.js';
import { mulberry32 } from './linalg.js';

/** The data budget's limits (spec 7.2). `warnAbove`: points reaching the GP beyond which the screen warns (7.8). */
export const BUDGET = { default: 400, min: 100, max: 800, margin: 0.2, warnAbove: 300 };
export const clampBudget = (v) => Math.max(BUDGET.min, Math.min(BUDGET.max, Math.round(Number(v) || BUDGET.default)));

const lipidOf = (r) => r.lipid || NOT_RECORDED;
const mixerOf = (r) => r.mixerType || NOT_RECORDED;

/**
 * The lipid and mixer combinations in the data, with how many formulations carry a measured result, most first
 * (ties by name, so the preselection is the same every visit).
 */
export function lipidMixerCombos(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!(r.nResponses > 0)) continue;
    const k = `${lipidOf(r)}|${mixerOf(r)}`;
    if (!by.has(k)) by.set(k, { key: k, lipid: lipidOf(r), mixer: mixerOf(r), n: 0 });
    by.get(k).n++;
  }
  return [...by.values()].sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

/** Measured formulations per lipid among some rows, most first. */
export function lipidCounts(rows) {
  const by = {};
  for (const r of rows) if (r.nResponses > 0) by[lipidOf(r)] = (by[lipidOf(r)] || 0) + 1;
  return Object.entries(by).map(([lipid, n]) => ({ lipid, n })).sort((a, b) => b.n - a.n || a.lipid.localeCompare(b.lipid));
}

/** A row's position in the unit cube of the space, clipped, for the distance the subselection spreads by. */
const unit = (r, space) => space.map((s) => (s.hi > s.lo ? Math.max(0, Math.min(1, (r.factors[s.key] - s.lo) / (s.hi - s.lo))) : 0.5));

/**
 * Greedy weighted maximin: k of the rows, spread through the space, with a preference for good and recent runs.
 * Each step takes the run whose distance to the nearest one already taken, times its weight, is largest. The
 * weight is 1 + 0.5·(score rank) + 0.25·(date rank), both ranks from 0 to 1, so a good run is preferred over
 * an equally isolated poor one but never over a gap in the coverage twice its distance. The first run is the
 * best scored. O(n·k·D), which for 10,000 runs and a budget of 400 is a fraction of a second.
 */
export function subselect(rows, k, space, goals, seed = 7) {
  const n = rows.length;
  if (n <= k) return { keep: rows.slice(), drop: [] };
  const rnd = mulberry32(seed + 4049);
  // A seeded tie-break per run, in batch-id order, so two runs at the same distance are settled the same way
  // every time whatever order they came in.
  const ids = rows.map((r, i) => [String(r.batchId), i]).sort((a, b) => a[0].localeCompare(b[0]));
  const tie = new Float64Array(n);
  for (const [, i] of ids) tie[i] = rnd() * 1e-9;
  const rankOf = (vals) => {
    const order = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0] || String(rows[a[1]].batchId).localeCompare(String(rows[b[1]].batchId)));
    const out = new Float64Array(n);
    order.forEach(([, i], r) => { out[i] = n > 1 ? r / (n - 1) : 0; });
    return out;
  };
  const act = goals.filter((g) => g.on !== false);
  const good = rankOf(rows.map((r) => overallDesirability(r.values, act).D));
  const dates = [...new Set(rows.map((r) => String(r.date || '')))].sort();
  const recent = rankOf(rows.map((r) => dates.indexOf(String(r.date || ''))));
  const w = rows.map((_, i) => 1 + 0.5 * good[i] + 0.25 * recent[i] + tie[i]);
  const U = rows.map((r) => unit(r, space));
  const minD = new Float64Array(n).fill(Infinity);
  const taken = new Uint8Array(n);
  let first = 0;
  for (let i = 1; i < n; i++) if (good[i] + tie[i] > good[first] + tie[first]) first = i;
  const order = [first];
  taken[first] = 1;
  const update = (j) => {
    const uj = U[j];
    for (let i = 0; i < n; i++) {
      if (taken[i]) continue;
      let d = 0; const ui = U[i];
      for (let t = 0; t < uj.length; t++) { const x = ui[t] - uj[t]; d += x * x; }
      if (d < minD[i]) minD[i] = d;
    }
  };
  update(first);
  while (order.length < k) {
    let best = -1, bestS = -Infinity;
    for (let i = 0; i < n; i++) {
      if (taken[i]) continue;
      const s = Math.sqrt(minD[i]) * w[i];
      if (s > bestS) { bestS = s; best = i; }
    }
    if (best < 0) break;
    taken[best] = 1; order.push(best); update(best);
  }
  return { keep: order.map((i) => rows[i]), drop: rows.filter((_, i) => !taken[i]) };
}

/**
 * Runs of one recipe as one point: the mean of each response, the first run's settings, the latest date, and the
 * experiment most of them came from, since the point is held out as one in cross-validation. Exported because the
 * fingerprint's "Reproduce" rebuilds merged points from their ids and must arrive at the same numbers.
 */
export function mergeRows(g) {
  const values = {};
  for (const name of new Set(g.flatMap((r) => Object.keys(r.values)))) {
    const v = g.map((r) => r.values[name]).filter(Number.isFinite);
    if (v.length) values[name] = v.reduce((a, b) => a + b, 0) / v.length;
  }
  const exp = new Map();
  for (const r of g) exp.set(r.experimentId ?? null, (exp.get(r.experimentId ?? null) || 0) + 1);
  let experimentId = null, most = 0;
  for (const [k, c] of exp) if (c > most) { most = c; experimentId = k; }
  return { ...g[0], values, experimentId, date: g.map((r) => String(r.date || '')).sort().pop(), nResponses: Object.keys(values).length,
    suggestedByMl: g.some((r) => r.suggestedByMl), mergedFrom: g.map((r) => r.batchId) };
}

/** Merge runs of one recipe (same lipid, same searched factors to 1e-4) into a point at their mean. */
function mergeReplicates(rows, space, goalNames) {
  const key = (r) => `${lipidOf(r)}|${space.map((s) => Math.round(r.factors[s.key] * 1e4) / 1e4).join('|')}`;
  const groups = new Map();
  for (const r of rows) { const k = key(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const out = [], merged = [];
  for (const g of groups.values()) {
    if (g.length === 1) { out.push(g[0]); continue; }
    out.push(mergeRows(g));
    merged.push({ into: g[0].batchId, rows: g });
  }
  // Replicate scatter per response, pooled within each recipe: what the merged rows would have told the noise.
  const noise = {};
  for (const name of goalNames) {
    let ss = 0, df = 0;
    for (const { rows: g } of merged) {
      const v = g.map((r) => r.values[name]).filter(Number.isFinite);
      if (v.length < 2) continue;
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      ss += v.reduce((a, b) => a + (b - m) ** 2, 0); df += v.length - 1;
    }
    if (df > 0) noise[name] = { sd: Math.sqrt(ss / df), df, groups: merged.length, merged: true };
  }
  return { rows: out, merged, noise };
}

/**
 * Choose the formulations a model is fitted to.
 * @param {object[]} rows  buildRows() output
 * @param {object} o  {space, goals, lipid, mixer (null: no filter; NOT_RECORDED: the ones without), mode
 *   ('filter' | 'kernel' | 'descriptor'), budget, seed, handedIds (a Set from the Data overview, or null)}
 * @returns {{rows, target, others, account, steps, noise, budget, over, lipid, mixer, mode}}
 *   rows: everything the model sees (target lipid first); target: those of the chosen lipid; others: the other
 *   lipids' (empty in filter mode); noise: replicate scatter measured before merging, per response, or null
 */
export function selectData(rows, o = {}) {
  const space = o.space || [], goals = (o.goals || []).filter((g) => g.on !== false);
  const names = goals.map((g) => g.name);
  const mode = o.mode || 'filter';
  const budget = clampBudget(o.budget ?? BUDGET.default);
  const seed = o.seed ?? 7;
  const account = [];
  const note = (r, status, reason, detail = '') => account.push({ batchId: r.batchId, label: r.label || '', lipid: lipidOf(r), mixer: mixerOf(r), status, reason, detail });
  const steps = { total: rows.length, handed: 0, otherLipid: 0, otherMixer: 0, noResponse: 0, missingFactor: 0, relevance: 0, quality: 0, mergedRuns: 0, mergedGroups: 0, subselected: 0 };

  let pool = [];
  for (const r of rows) {
    if (o.handedIds && !o.handedIds.has(r.batchId)) { note(r, 'excluded', 'handed', 'not in the selection from Data'); steps.handed++; continue; }
    if (o.mixer != null && mixerOf(r) !== o.mixer) { note(r, 'excluded', 'filtered', 'other mixer'); steps.otherMixer++; continue; }
    if (mode === 'filter' && o.lipid != null && lipidOf(r) !== o.lipid) { note(r, 'excluded', 'filtered', 'other lipid'); steps.otherLipid++; continue; }
    // A multi-lipid mode may still leave a lipid out (lipidmode.js): too few runs to share, or no descriptors.
    const why = mode !== 'filter' && o.lipidOk && lipidOf(r) !== o.lipid ? o.lipidOk(lipidOf(r)) : true;
    if (why !== true) { note(r, 'excluded', 'filtered', `other lipid, ${why}`); steps.otherLipid++; continue; }
    if (!names.some((n) => Number.isFinite(r.values[n]))) { note(r, 'excluded', 'no response', 'nothing measured for the goals switched on'); steps.noResponse++; continue; }
    const missing = space.filter((s) => !Number.isFinite(r.factors[s.key]));
    if (missing.length) { note(r, 'excluded', 'missing factor', missing.map((s) => s.name || s.key).join(', ')); steps.missingFactor++; continue; }
    pool.push(r);
  }

  let noise = null;
  const over = pool.length > budget;
  if (over) {
    // 1. relevance
    const m = BUDGET.margin;
    pool = pool.filter((r) => {
      const out = space.filter((s) => { const span = s.hi - s.lo, v = r.factors[s.key]; return v < s.lo - m * span || v > s.hi + m * span; });
      if (out.length) { note(r, 'excluded', 'outside range', out.map((s) => `${s.name || s.key} ${r.factors[s.key]}`).join(', ')); steps.relevance++; return false; }
      return true;
    });
    // 2. quality
    pool = pool.filter((r) => {
      if (r.quality?.length) { note(r, 'excluded', 'quality', r.quality.join('; ')); steps.quality++; return false; }
      return true;
    });
    // 3. replicates
    const mg = mergeReplicates(pool, space, names);
    for (const { into, rows: g } of mg.merged) {
      for (const r of g.slice(1)) note(r, 'merged', 'merged', `into ${into} with ${g.length - 1} other run${g.length === 2 ? '' : 's'} of the same recipe`);
      steps.mergedRuns += g.length - 1; steps.mergedGroups++;
    }
    pool = mg.rows;
    noise = Object.keys(mg.noise).length ? mg.noise : null;
    // 4. subselection: the chosen lipid first; the others, in a multi-lipid mode, share what it leaves
    if (pool.length > budget) {
      const isTarget = (r) => mode === 'filter' || o.lipid == null || lipidOf(r) === o.lipid;
      const tgt = pool.filter(isTarget), oth = pool.filter((r) => !isTarget(r));
      const tq = oth.length ? Math.min(tgt.length, Math.max(budget - oth.length, Math.round(budget * 0.6))) : Math.min(tgt.length, budget);
      const a = subselect(tgt, tq, space, goals, seed), b = subselect(oth, budget - tq, space, goals, seed + 1);
      for (const r of [...a.drop, ...b.drop]) note(r, 'excluded', 'subselected', 'left out by the space-filling choice');
      steps.subselected = a.drop.length + b.drop.length;
      const keep = new Set([...a.keep, ...b.keep]);
      pool = pool.filter((r) => keep.has(r));
    }
  }
  for (const r of pool) note(r, 'used', 'used', r.mergedFrom ? `mean of ${r.mergedFrom.length} runs` : '');
  const isTarget = (r) => mode === 'filter' || o.lipid == null || lipidOf(r) === o.lipid;
  const target = pool.filter(isTarget), others = pool.filter((r) => !isTarget(r));
  return { rows: [...target, ...others], target, others, account, steps: { ...steps, used: pool.length }, noise, budget, over,
    lipid: o.lipid ?? null, mixer: o.mixer ?? null, mode };
}
