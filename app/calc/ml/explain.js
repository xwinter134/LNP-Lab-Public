// What the model thinks drives what — and the standing caveat that it describes correlations in the runs that
// were done, not causes. A factor can look unimportant because it was never varied, and two factors changed
// together will share credit arbitrarily. The UI repeats this; the maths cannot.
//
// Permutation importance is the measure used: shuffle one factor's column, see how much worse the predictions
// get. It is model-agnostic (so the GP, the quadratic and the linear model are compared on equal terms) and,
// unlike reading coefficients, it answers "how much does this factor contribute to predicting", which is the
// question being asked. It is run with repeats because a single shuffle on 20 runs is noise.
import { mulberry32 } from './linalg.js';
import { overallDesirability } from './objective.js';

const rmse = (y, p) => Math.sqrt(y.reduce((s, v, i) => s + (v - p[i]) ** 2, 0) / y.length);

/**
 * Has the surface collapsed back onto its own prior?
 *
 * Eriksson and Jankowiak (UAI 2021) describe the failure precisely: when the fitted lengthscales go short
 * enough that no two runs are correlated, the posterior returns to the prior. The mean goes flat and the
 * intervals span the whole output range, so the model is not overconfident, it is empty. Because the signal
 * variance here is fixed at 1 and the outputs are standardised, the posterior variance at a point *is* the
 * fraction of prior variance left: a median near 1 across the space means the data has told the model
 * nothing, however good its headline figures look.
 *
 * @returns {{priorShare:number, collapsed:boolean, clamped:number}}
 */
export function collapseCheck(gp, dims, { n = 160, seed = 11 } = {}) {
  const D = typeof dims === 'number' ? dims : dims?.length || 0;
  if (!gp || !D) return { priorShare: NaN, collapsed: false, clamped: 0 };
  const rnd = mulberry32(seed);
  const vars = [];
  for (let i = 0; i < n; i++) {
    const u = Array.from({ length: D }, () => rnd());
    const p = gp.predict(u);
    vars.push(p.sd * p.sd);
  }
  vars.sort((a, b) => a - b);
  const priorShare = vars[Math.floor(vars.length / 2)];
  const clamped = gp.clampedLengthscales || 0;
  return { priorShare, collapsed: priorShare > 0.9 || clamped >= Math.max(1, Math.ceil(D / 2)), clamped };
}

/**
 * Permutation importance for one fitted model.
 * @returns [{key, name, importance, sd, share}] sorted by importance, importance in units of the response.
 */
export function permutationImportance(model, X, y, space, { repeats = 12, seed = 11 } = {}) {
  const rnd = mulberry32(seed);
  const base = rmse(y, X.map((x) => model.predict(x).mean));
  const out = space.map((s, d) => {
    const deltas = [];
    for (let r = 0; r < repeats; r++) {
      const col = X.map((x) => x[d]);
      for (let i = col.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [col[i], col[j]] = [col[j], col[i]]; }
      const Xp = X.map((x, i) => { const c = [...x]; c[d] = col[i]; return c; });
      deltas.push(rmse(y, Xp.map((x) => model.predict(x).mean)) - base);
    }
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const sd = Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, deltas.length - 1));
    return { key: s.key, name: s.name || s.key, unit: s.unit || '', importance: Math.max(0, mean), sd };
  });
  const total = out.reduce((a, b) => a + b.importance, 0) || 1;
  return out.map((o) => ({ ...o, share: o.importance / total })).sort((a, b) => b.importance - a.importance);
}

/**
 * How much of the response surface a GP attributes to each factor, read off its fitted lengthscales.
 * A short lengthscale means the response changes quickly along that factor. Reported as a cross-check on
 * permutation importance, never alone: a short lengthscale can also mean the GP is chasing noise.
 */
export function ardImportance(gp, space) {
  if (!gp?.lengthscales) return [];
  const inv = gp.lengthscales.map((l) => 1 / Math.max(l, 1e-6));
  const total = inv.reduce((a, b) => a + b, 0) || 1;
  return space.map((s, d) => ({ key: s.key, name: s.name || s.key, lengthscale: gp.lengthscales[d], share: inv[d] / total }))
    .sort((a, b) => b.share - a.share);
}

/**
 * Partial dependence: sweep one factor across its range with the others held at the dataset average, in the
 * model's own units, with the GP's uncertainty band where available.
 */
export function partialDependence(model, X, space, dim, { n = 40 } = {}) {
  const mean = space.map((_, d) => X.reduce((s, x) => s + x[d], 0) / X.length);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const x = [...mean]; x[dim] = u;
    const p = model.predict(x);
    // average over the observed rows too (true partial dependence, not just a slice through the mean)
    let acc = 0, accN = 0;
    for (const row of X) { const xr = [...row]; xr[dim] = u; acc += model.predict(xr).mean; accN++; }
    pts.push({ u, real: space[dim].lo + u * (space[dim].hi - space[dim].lo), mean: acc / accN, slice: p.mean, sd: Number.isFinite(p.sd) ? p.sd : null });
  }
  return pts;
}

/** A 2D grid of predicted desirability for the contour view; the other factors sit at `base`. */
export function desirabilityGrid(models, space, dimA, dimB, goals, { n = 24, base = null, constraints = [], feasible = null } = {}) {
  const b = base || space.map(() => 0.5);
  const grid = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < n; j++) {
      const x = [...b];
      x[dimA] = i / (n - 1); x[dimB] = j / (n - 1);
      const vals = {}, sds = {};
      for (const m of models) { const p = m.gp.predict(x); vals[m.name] = p.mean * m.ySd + m.yMean; sds[m.name] = p.sd * m.ySd; }
      const ok = constraints.every((c) => (c.op === '<' ? vals[c.name] < c.value : vals[c.name] > c.value));
      // `made` is false where the recipe could not be weighed out (feasible takes the unit-cube point), so the
      // map can leave those cells out instead of showing a good score for a formulation that does not exist.
      row.push({ D: ok ? overallDesirability(vals, goals).D : 0, values: vals, sd: sds, made: feasible ? feasible(x) : true });
    }
    grid.push(row);
  }
  return { grid, n, a: space[dimA], b: space[dimB] };
}

/**
 * Which factors were actually varied enough to be judged? A factor held nearly constant cannot be shown to
 * matter, and saying so is more useful than reporting it as unimportant.
 */
export function coverage(rows, space) {
  return space.map((s) => {
    const vals = rows.map((r) => r.factors?.[s.key]).filter(Number.isFinite);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const distinct = new Set(vals.map((v) => Math.round(v * 1e4) / 1e4)).size;
    const spanFrac = s.hi > s.lo ? (hi - lo) / (s.hi - s.lo) : 0;
    return { key: s.key, name: s.name || s.key, unit: s.unit || '', n: vals.length, distinct, lo, hi, spanFrac,
      status: distinct < 2 ? 'constant' : distinct < 3 ? 'two levels only' : spanFrac < 0.25 ? 'narrow range' : 'ok' };
  });
}
