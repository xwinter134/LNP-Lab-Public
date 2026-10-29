// One recommended setting for a whole designed experiment, rather than one per response.
//
// The DoE screen's own optimum walks the fitted surface of a single response, so with particle size targeted
// it will happily pick a corner where PDI and encapsulation suffer: in the first usability session it chose a
// setting whose true score was 0.88 against 0.94 available. A formulator wants the setting that is acceptable
// on everything at once, which is what Derringer-Suich desirability is for. This fits every response with the
// design's own model, scores each predicted point with the same desirability curves the optimizer uses, and
// walks the coded box for the best overall score — so the DoE screen and the optimizer cannot disagree about
// what "good" means, only about how well they know the surface.
import { ols } from './stats.js';
import { toReal, isCategorical } from './doe.js';
import { DEFAULT_GOALS, overallDesirability } from './ml/objective.js';

/**
 * The goals for a design: the optimizer's default curves, with the goal and target the design was created
 * with layered on top. A response marked "none" is left out; one whose goal cannot be scored is listed in
 * `skipped` with the reason, so the card never claims to balance a response it ignored.
 */
export function goalsFor(spec, skipped = []) {
  const out = [];
  const given = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  for (const r of spec.responses || []) {
    const base = DEFAULT_GOALS.find((g) => g.name === r.name);
    if (!r.goal || r.goal === 'none') continue;
    if (!base) { skipped.push({ name: r.name, why: 'no scoring curve for this response' }); continue; }
    // The window a response is acceptable in, from the optimizer's curve whatever its shape.
    const lo = Number(base.lo ?? (base.goal === 'minimize' ? base.best : base.worst));
    const hi = Number(base.hi ?? (base.goal === 'minimize' ? base.worst : base.best));
    const g = { ...base, on: true };
    if (r.goal === 'target') {
      // An empty target box means "the usual target", not zero; with no usual target there is nothing to aim at.
      const t = given(r.target) ? Number(r.target) : base.goal === 'target' ? Number(base.target) : null;
      if (t == null) { skipped.push({ name: r.name, why: 'goal is "target" but no target value was given' }); continue; }
      g.goal = 'target'; g.target = t;
      g.lo = lo < t ? lo : t - (Math.abs(t) * 0.5 || 1);
      g.hi = hi > t ? hi : t + (Math.abs(t) * 0.5 || 1);
    } else if (r.goal === 'minimize' || r.goal === 'maximize') {
      if (base.goal !== r.goal) {
        // e.g. particle size asked to be as small as possible: the same window, read as a one-sided curve
        if (!(hi > lo)) { skipped.push({ name: r.name, why: `cannot ${r.goal} without a range` }); continue; }
        g.goal = r.goal;
        g.best = r.goal === 'minimize' ? lo : hi; g.worst = r.goal === 'minimize' ? hi : lo;
      }
    }
    out.push(g);
  }
  return out;
}

/**
 * The terms of a process model over coded factors, in the order the DoE screen fits them.
 * Each carries what kind of term it is and which factors it is made of, so a summary can say "curvature in
 * FRR" without parsing the name back apart, which breaks the first time a factor name contains " x ".
 */
export function boxTerms(names, model) {
  const t = [{ name: 'Intercept', kind: 'intercept', of: [], f: () => 1 }, ...names.map((n) => ({ name: n, kind: 'main', of: [n], f: (c) => c[n] }))];
  if (model !== 'linear') for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) t.push({ name: `${names[i]} x ${names[j]}`, kind: 'interaction', of: [names[i], names[j]], f: (c) => c[names[i]] * c[names[j]] });
  if (model === 'quadratic') for (const n of names) t.push({ name: `${n}^2`, kind: 'square', of: [n], f: (c) => c[n] ** 2 });
  return t;
}

/**
 * @param spec  the design spec (process mode)
 * @param runs  design runs with {run_id, batchId, coded}
 * @param vals  {run_id: {responseName: value}}
 * @returns null when there is nothing to balance (fewer than two scored responses with a fit), else
 *   {coded, real, predicted, scatter, parts, D, best: {run_id, batchId, D, values}, used, skipped}
 */
export function balancedOptimum(spec, runs, vals, { model = spec.model } = {}) {
  const names = (spec.factors || []).map((f) => f.name);
  if (!names.length || names.length > 4) return null;
  const skipped = [];
  const goals = goalsFor(spec, skipped);
  const terms = boxTerms(names, model);
  const fits = {};
  for (const g of goals) {
    const rows = runs.filter((r) => Number.isFinite(vals[r.run_id]?.[g.name]));
    if (rows.length <= terms.length) { skipped.push({ name: g.name, why: `${rows.length} runs measured, the model needs more than ${terms.length}` }); continue; }
    const fit = ols(rows.map((r) => terms.map((t) => t.f(r.coded))), rows.map((r) => vals[r.run_id][g.name]));
    if (!fit?.beta) { skipped.push({ name: g.name, why: 'the fit failed' }); continue; }
    fits[g.name] = fit;
  }
  const used = goals.filter((g) => fits[g.name]);
  if (used.length < 2) return null;

  const predict = (c) => Object.fromEntries(used.map((g) => [g.name, terms.reduce((s, t, j) => s + t.f(c) * fits[g.name].beta[j], 0)]));
  // Search the region the runs cover, not only the cube: a rotatable or circumscribed CCD ran its axial points
  // past ±1. Per factor out to the furthest level run, and no further from the centre than the furthest run,
  // so the corners of that wider box (never run) are not searched either.
  const ext = names.map((n) => Math.max(1, ...runs.map((r) => Math.abs(Number(r.coded?.[n]) || 0))));
  const radius = Math.max(...runs.map((r) => Math.hypot(...names.map((n) => Number(r.coded?.[n]) || 0))));
  // fine enough that the answer does not move with the grid, coarse enough to stay instant at four factors
  const steps = names.length <= 2 ? 41 : names.length === 3 ? 21 : 11;
  const cat = spec.factors.map(isCategorical);
  let best = null;
  const maxD = Object.fromEntries(used.map((g) => [g.name, 0]));
  const walk = (i, c) => {
    if (i === names.length) {
      if (Math.hypot(...names.map((n) => c[n])) > radius + 1e-9) return;
      const y = predict(c);
      const { D, parts } = overallDesirability(y, used);
      for (const p of parts) maxD[p.name] = Math.max(maxD[p.name], p.d);
      // With one response unacceptable everywhere every D is 0, and the first point visited would win by
      // default; the mean of the single desirabilities then says which compromise is least bad.
      const tie = parts.reduce((a, p) => a + p.d, 0) / parts.length;
      if (!best || D > best.D + 1e-12 || (Math.abs(D - best.D) <= 1e-12 && tie > best.tie)) best = { coded: { ...c }, predicted: y, D, parts, tie };
      return;
    }
    // a categorical factor (the mixer) is either one level or the other: there is no mixer at 0.3
    if (cat[i]) { for (const v of [-1, 1]) walk(i + 1, { ...c, [names[i]]: v }); return; }
    for (let s = 0; s < steps; s++) walk(i + 1, { ...c, [names[i]]: -ext[i] + (2 * ext[i] * s) / (steps - 1) });
  };
  walk(0, {});
  // the responses no setting in the region makes acceptable: the reason a score of 0 is the best there is
  const blocked = used.filter((g) => maxD[g.name] <= 0).map((g) => g.name);

  // the best run actually made, scored the same way, so the prediction can be held against something real
  let bestRun = null;
  for (const r of runs) {
    const v = vals[r.run_id] || {};
    if (!used.every((g) => Number.isFinite(v[g.name]))) continue;
    const { D } = overallDesirability(v, used);
    if (!bestRun || D > bestRun.D) bestRun = { run_id: r.run_id, batchId: r.batchId, D, values: v };
  }
  return {
    coded: best.coded,
    real: Object.fromEntries(spec.factors.map((f) => [f.name, toReal(f, best.coded[f.name])])),
    predicted: best.predicted,
    // the residual scatter of each fit: a batch made at this setting will land about this far off, at best
    scatter: Object.fromEntries(used.map((g) => [g.name, fits[g.name].se])),
    parts: best.parts, D: best.D, best: bestRun, used, skipped, blocked,
    // where each factor's search stopped: the outermost level that was run
    extent: Object.fromEntries(names.map((n, i) => [n, ext[i]])),
  };
}
