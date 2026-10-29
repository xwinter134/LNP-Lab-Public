// Mixture designs: experiments where the factors are parts of a whole.
//
// A lipid composition is not a box. Four mol% values that must add to 100 have only three degrees of
// freedom, so a design matrix with an intercept and all four columns is rank deficient, and a Box-Behnken
// run on them is simply the wrong shape — raising one lipid necessarily lowers another, and the design
// cannot tell you which of the two did the work. The classical answer, from Scheffé (1958), is to drop the
// intercept and fit a canonical polynomial on the simplex. Everything here follows from that.
//
// What this module provides
//   · designs on the simplex: lattice, centroid, and extreme vertices for a constrained region
//   · pseudo-components, so lower bounds do not waste half the design on infeasible corners
//   · Scheffé canonical model terms, and the crossed mixture-by-process terms for a combined experiment
//   · D-optimal selection, because a crossed design has more candidate points than anyone can run
//
// What it deliberately does not do: renormalise afterwards. A run is feasible when it is generated or it
// is not generated at all.

import { ols } from './stats.js';
import { cholesky, cholInverse } from './ml/linalg.js';

/* ================================ geometry ================================ */

/** Integer compositions of `m` into `q` parts: the lattice {q, m} before scaling. */
function compositions(q, m) {
  if (q === 1) return [[m]];
  const out = [];
  for (let i = 0; i <= m; i++) for (const rest of compositions(q - 1, m - i)) out.push([i, ...rest]);
  return out;
}

/** Simplex lattice design {q, m}: every point whose coordinates are multiples of 1/m. */
export function simplexLattice(q, m = 2) {
  return compositions(q, m).map((c) => c.map((v) => v / m));
}

/** Simplex centroid design: the centroid of every non-empty subset of the components. */
export function simplexCentroid(q, maxSubset = q) {
  const out = [];
  for (let mask = 1; mask < (1 << q); mask++) {
    const members = [];
    for (let i = 0; i < q; i++) if (mask & (1 << i)) members.push(i);
    if (members.length > maxSubset) continue;
    const v = new Array(q).fill(0);
    for (const i of members) v[i] = 1 / members.length;
    out.push(v);
  }
  return out;
}

const key = (p) => p.map((v) => Math.round(v * 1e6)).join(',');
const dedupe = (pts) => { const seen = new Set(); return pts.filter((p) => { const k = key(p); if (seen.has(k)) return false; seen.add(k); return true; }); };

/**
 * Extreme vertices of a constrained mixture region (McLean & Anderson, 1966).
 *
 * With both lower and upper bounds the feasible region is a polytope inside the simplex, and its corners
 * are not the pure components. Fix every component but one at a bound, solve for the last, keep it if it
 * lands inside its own bounds: that enumerates the vertices exactly, and for the handful of lipids anyone
 * actually blends the enumeration is trivially small (q · 2^(q−1) candidates).
 *
 * @param {Array<{lo:number, hi:number}>} bounds in the same units as `total`
 * @returns {Array<number[]>} vertices as fractions of the total
 */
export function extremeVertices(bounds, total = 100) {
  const q = bounds.length, out = [];
  for (let free = 0; free < q; free++) {
    const others = [...Array(q).keys()].filter((i) => i !== free);
    for (let mask = 0; mask < (1 << others.length); mask++) {
      const x = new Array(q).fill(0);
      let used = 0;
      others.forEach((i, b) => { const v = (mask >> b) & 1 ? bounds[i].hi : bounds[i].lo; x[i] = v; used += v; });
      const rest = total - used;
      if (rest < bounds[free].lo - 1e-9 || rest > bounds[free].hi + 1e-9) continue;
      x[free] = rest;
      out.push(x.map((v) => v / total));
    }
  }
  return dedupe(out);
}

/** The centroid of a set of points. */
export const centroid = (pts) => (pts.length ? pts[0].map((_, i) => pts.reduce((s, p) => s + p[i], 0) / pts.length) : []);

/**
 * Candidate points for a constrained region: the corners, the middle of every edge, the centre of every
 * face up to `faceUpTo` vertices, and the overall centroid. This is the set a D-optimal search chooses from.
 */
export function constrainedCandidates(bounds, total = 100, { faceUpTo = 3 } = {}) {
  const V = extremeVertices(bounds, total);
  const pts = V.map((p) => ({ x: p, type: 'vertex' }));
  for (let i = 0; i < V.length; i++) for (let j = i + 1; j < V.length; j++) pts.push({ x: centroid([V[i], V[j]]), type: 'edge' });
  if (faceUpTo >= 3) {
    for (let i = 0; i < V.length; i++) for (let j = i + 1; j < V.length; j++) for (let k = j + 1; k < V.length; k++) {
      pts.push({ x: centroid([V[i], V[j], V[k]]), type: 'interior' });
    }
  }
  if (V.length) pts.push({ x: centroid(V), type: 'centroid' });
  const seen = new Set();
  return pts.filter((p) => { const k = key(p.x); if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Lower bounds, handled properly: L-pseudo-components.
 * With lower bounds L_i that leave room R = total − ΣL, the transform x'_i = (x_i − L_i)/R turns the
 * feasible region back into a full simplex, so a lattice or centroid design can be built on it and mapped
 * back. Without this, most of a lattice lands outside the region and is thrown away.
 */
export const toPseudo = (x, lows, total) => { const R = total - lows.reduce((a, b) => a + b, 0); return x.map((v, i) => (R > 0 ? (v - lows[i]) / R : 0)); };
export const fromPseudo = (p, lows, total) => { const R = total - lows.reduce((a, b) => a + b, 0); return p.map((v, i) => lows[i] + v * R); };

/** Does any upper bound actually cut into the region left by the lower bounds? */
export function uppersBind(bounds, total = 100) {
  const R = total - bounds.reduce((s, b) => s + b.lo, 0);
  return bounds.some((b) => b.hi < b.lo + R - 1e-9);
}

/* ================================ designs ================================ */

const TYPE_BY_NONZERO = (p) => {
  const nz = p.filter((v) => v > 1e-9).length;
  return nz === 1 ? 'pure' : nz === 2 ? 'binary' : nz === 3 ? 'ternary' : 'blend';
};

/**
 * Candidate points for a mixture region, in real units — the pool a design is chosen from, not the design.
 *
 * The distinction matters. Four lipids with both lower and upper bounds have a feasible polytope with a
 * dozen corners, and its corners, edges and interior centroids run into the hundreds: a useful pool, an
 * absurd experiment. `mixtureDesign` below picks from it.
 *
 * @param {Array<{key:string, lo:number, hi:number}>} components  bounds in mol%
 */
export function mixturePool(components, { total = 100, kind = 'auto', degree = 2 } = {}) {
  const q = components.length;
  if (q < 2) throw new Error('a mixture needs at least two components');
  const bounds = components.map((c) => ({ lo: Number(c.lo) || 0, hi: Number.isFinite(Number(c.hi)) ? Number(c.hi) : total }));
  const sumLo = bounds.reduce((s, b) => s + b.lo, 0), sumHi = bounds.reduce((s, b) => s + b.hi, 0);
  if (sumLo > total + 1e-9) throw new Error(`the lower bounds add to ${+sumLo.toFixed(3)} mol%, more than ${total}`);
  if (sumHi < total - 1e-9) throw new Error(`the upper bounds only add to ${+sumHi.toFixed(3)} mol%, less than ${total}`);

  const bind = uppersBind(bounds, total);
  const chosen = kind === 'auto' ? (bind ? 'vertices' : 'centroid') : kind;
  const lows = bounds.map((b) => b.lo);
  const wrap = (arr, type) => ({ x: Object.fromEntries(arr.map((v, i) => [components[i].key, Math.round(v * 1e6) / 1e6])), type });

  let points, note;
  if (chosen === 'vertices' || bind) {
    points = constrainedCandidates(bounds, total, { faceUpTo: q >= 3 ? 3 : 2 }).map((p) => wrap(p.x.map((v) => v * total), p.type));
    note = bind
      ? 'Upper bounds cut into the simplex, so the region is a polytope: its corners, edge midpoints, interior centroids and overall centre make up the pool.'
      : 'Pool built from the corners, edges and centre of the feasible region.';
  } else if (chosen === 'lattice') {
    points = simplexLattice(q, Math.max(1, degree)).map((p) => wrap(fromPseudo(p, lows, total), TYPE_BY_NONZERO(p)));
    note = `Simplex lattice {${q}, ${degree}} on pseudo-components, so every point respects the lower bounds exactly.`;
  } else {
    points = simplexCentroid(q, Math.min(q, Math.max(2, degree + 1))).map((p) => wrap(fromPseudo(p, lows, total), TYPE_BY_NONZERO(p)));
    note = 'Simplex centroid on pseudo-components: each component at its highest, every blend of two, and the overall centre.';
  }
  return { points, kind: chosen, note, bounds, total, constrained: bind };
}

/** The centre of a pool, as a run object — the natural place to put replicates. */
export function poolCentre(pool) {
  const keys = Object.keys(pool.points[0].x);
  const c = pool.points.find((p) => p.type === 'centroid');
  if (c) return { ...c.x };
  return Object.fromEntries(keys.map((k) => [k, Math.round((pool.points.reduce((s, p) => s + p.x[k], 0) / pool.points.length) * 1e6) / 1e6]));
}

/**
 * Per-run D-efficiency, |X'X|^(1/k) / n.
 *
 * Normalising by the number of runs is what makes two designs of different size comparable: a design is
 * not better merely for being larger. Scale-dependent, so compare only within one model.
 */
export const dEfficiency = (logdet, k, n) => (Number.isFinite(logdet) && n > 0 ? Math.exp(logdet / k) / n : 0);

/**
 * A run as the fit sees it: the blend as L-pseudo-components, anything else (the process settings) as given.
 *
 * buildDesign hands the DoE screen's fit exactly these coordinates, so the selection is made in them too.
 * For a linear or quadratic blending model that changes nothing in principle (the pseudo-component model is
 * a linear reparametrisation of the mol% one), but it makes the design that was chosen and the design that
 * is fitted the same matrix, which is the only way to promise the second can be fitted.
 */
function asFitted(components, bounds, total) {
  const lows = bounds.map((b) => b.lo);
  const R = total - lows.reduce((a, b) => a + b, 0);
  return (x) => {
    const out = { ...x };
    components.forEach((c, i) => { out[c.key] = R > 0 ? (Number(x[c.key]) - lows[i]) / R : 0; });
    return out;
  };
}

/**
 * Refuse a design its own model cannot be fitted to, before anything reaches the bench.
 *
 * Usability cycle 3 (C3): the default blend × process design was built, made and measured, and only then did
 * the fit report "singular design". Thirty-eight batches is too high a price for a message the generator
 * could have given while the wizard was still open. The wizard shows a builder's error in place of the
 * preview and will not create, so throwing here is how it says so.
 *
 * Centre replicates add no rank, so this is checked on the selected runs; the pool's own rank says whether a
 * larger budget could help or whether the region and the model are simply incompatible.
 */
function assertFittable(points, terms, fitted, { pool, budget, model }) {
  const k = terms.length;
  const rank = modelRank(designMatrix(points.map((p) => fitted(p.x)), terms));
  if (rank >= k) return rank;
  const poolRank = modelRank(designMatrix(pool, terms));
  if (poolRank < k) {
    throw new Error(`The candidate runs in these ranges can only separate ${poolRank} of the ${k} terms of the ${model}, so no selection from them can be fitted. Widen the narrowest mol% range, or choose a simpler blending or process model.`);
  }
  throw new Error(`${budget ?? points.length} runs chosen from these candidates separate only ${rank} of the ${k} terms of the ${model}. Raise the run budget.`);
}

/**
 * A mixture design in real units: build the pool, then keep the runs that determine the model best.
 *
 * @param {Array<{key:string, lo:number, hi:number}>} components
 * @param {object} o
 * @param {number} [o.budget]      how many distinct runs you are willing to make; null keeps the whole pool
 * @param {string} [o.order]       Scheffe order the selection optimises for
 * @param {number} [o.replicates]  extra runs at the centre, for pure error
 */
export function mixtureDesign(components, { total = 100, kind = 'auto', degree = 2, order = 'quadratic', budget = null, replicates = 0, seed = 7 } = {}) {
  const pool = mixturePool(components, { total, kind, degree });
  const terms = scheffeTerms(components.map((c) => c.key), order);
  const fitted = asFitted(components, pool.bounds, total);
  const runs = pool.points.map((p) => fitted(p.x));
  const poolLd = logDet(designMatrix(runs, terms));
  let points = pool.points, selected = false, logdet = poolLd, note = pool.note;

  if (budget != null && budget < pool.points.length) {
    if (budget < terms.length) throw new Error(`${budget} runs cannot determine the ${terms.length} terms of a ${order} model`);
    const pick = dOptimal(runs, terms, budget, { seed });
    points = pick.picked.map((i) => pool.points[i]);
    selected = true;
    logdet = pick.logdet;
    note += ` Reduced from ${pool.points.length} candidate points to ${budget} by D-optimal exchange against the ${order} model.`;
  }
  assertFittable(points, terms, fitted, { pool: runs, budget: selected ? budget : null, model: `${order.replace('_', ' ')} blending model` });

  const reps = Math.max(0, Number(replicates) || 0);
  if (reps > 0) {
    const c = poolCentre(pool);
    for (let i = 0; i < reps; i++) points = [...points, { x: { ...c }, type: 'center' }];
    note += ` ${reps} replicate${reps > 1 ? 's' : ''} at the centre give an independent estimate of pure error.`;
  }

  return {
    points, pool: pool.points, kind: pool.kind, note, bounds: pool.bounds, total,
    constrained: pool.constrained, selected, terms, logdet,
    efficiency: dEfficiency(logdet, terms.length, points.length),
    poolEfficiency: dEfficiency(poolLd, terms.length, pool.points.length),
  };
}

/* ================================ models ================================ */

/**
 * Scheffé canonical terms. There is no intercept — on a simplex the components already sum to one, so a
 * constant column is a linear combination of them and the fit would be singular.
 */
export function scheffeTerms(names, order = 'quadratic') {
  const t = names.map((n) => ({ name: n, f: (x) => x[n] }));
  if (order === 'linear') return t;
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = names[i], b = names[j];
    t.push({ name: `${a}·${b}`, f: (x) => x[a] * x[b] });
  }
  if (order === 'special_cubic') {
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) for (let k = j + 1; k < names.length; k++) {
      const a = names[i], b = names[j], c = names[k];
      t.push({ name: `${a}·${b}·${c}`, f: (x) => x[a] * x[b] * x[c] });
    }
  }
  return t;
}

/** Ordinary process terms, with the constant kept separate so it can be crossed. */
export function processTerms(names, order = 'linear') {
  if (!names.length || order === 'none') return [];
  const t = names.map((n) => ({ name: n, f: (x) => x[n] }));
  if (order === 'interaction' || order === 'quadratic') {
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      t.push({ name: `${a}×${b}`, f: (x) => x[a] * x[b] });
    }
  }
  if (order === 'quadratic') for (const n of names) t.push({ name: `${n}²`, f: (x) => x[n] * x[n] });
  return t;
}

/**
 * The mixture-by-process model: every mixture term, on its own and multiplied by every process term.
 * That is the standard crossed form — it says the shape of the mixture response may itself depend on the
 * process setting, which is exactly the question a combined experiment is asked to answer.
 */
export function crossedTerms(mixTerms, procTerms) {
  const out = mixTerms.map((m) => ({ ...m }));
  for (const p of procTerms) for (const m of mixTerms) {
    out.push({ name: `${m.name} × ${p.name}`, f: (x) => m.f(x) * p.f(x) });
  }
  return out;
}

/** Model matrix for a set of runs. */
export const designMatrix = (runs, terms) => runs.map((r) => terms.map((t) => t.f(r)));

/**
 * Fit a mixture (or crossed) model by least squares.
 *
 * This is the app's ordinary `ols` with the Scheffé design matrix and no intercept column — the components
 * already sum to a constant, so a constant column would be a linear combination of them and the normal
 * equations would be singular. Everything else, the standard errors, the t statistics and the predicted R²
 * by PRESS, is the same machinery the process-factor fit uses, because a second least-squares implementation
 * is a second set of conventions to keep straight.
 *
 * @param {Array<object>} runs   one object per run, keyed by component and factor name
 * @param {number[]} y           the response
 * @param {Array<{name:string,f:Function}>} terms
 */
export function fitMixture(runs, y, terms) {
  const fit = ols(designMatrix(runs, terms), y);
  if (!fit.beta) return { ...fit, terms, note: fit.note || 'the design cannot separate these terms' };
  const pred = (r) => terms.reduce((s, t, i) => s + t.f(r) * fit.beta[i], 0);
  // No intercept means no degree of freedom spent on one: n - k residual df, not n - k - 1.
  return { ...fit, terms, pred, k: terms.length, df: fit.n - terms.length, rmse: fit.se };
}

/* ================================ choosing runs ================================ */

/**
 * log|X'X| through a Cholesky; −Infinity when the model cannot be fitted on these runs.
 *
 * A column counts as dependent when its Cholesky pivot falls below RANK_TOL² of its own diagonal, which is the
 * squared form of modelRank's test. There used to be an absolute 1e-9 added to the diagonal instead: on a
 * mol% matrix with diagonals in the millions that never made anything singular, and on a small one it moved
 * two equally good designs apart by 1e-9·tr((X'X)⁻¹), so a tie stopped looking like a tie. Forming X'X squares
 * the condition number, so on badly scaled runs this can still miss a dependency; modelRank, which works on
 * the columns directly, is what gives the verdict on whether a design can be fitted.
 */
export function logDet(X) {
  const k = X[0]?.length || 0;
  const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
  const diag = A.map((r, i) => r[i]);
  let s = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j <= i; j++) {
      let v = A[i][j];
      for (let m = 0; m < j; m++) v -= A[i][m] * A[j][m];
      if (i === j) { if (!(v > RANK_TOL * RANK_TOL * diag[i])) return -Infinity; A[i][i] = Math.sqrt(v); s += Math.log(A[i][i]); }
      else A[i][j] = v / A[j][j];
    }
  }
  return 2 * s;
}

/**
 * An orthonormal basis for the column space of a model matrix, by modified Gram–Schmidt.
 *
 * Why this exists: a Scheffé model on a realistic LNP region is badly conditioned in the units it is written
 * in. In mol% a pairwise term of two major lipids is in the thousands and a PEG term near one, so the diagonal
 * of X'X runs from about 10³ to 10⁹; in pseudo-components a PEG held between 1 and 2 mol% spans 0–0.03. A
 * ridge or a rounding error sized to the large directions then swamps the small ones, and a design that
 * cannot separate two terms looks, numerically, no worse than one that can. Expressing every candidate in an
 * orthonormal basis of the pool's own model space changes no determinant ratio (that is a fixed linear
 * reparametrisation, and the D-optimal subset does not depend on it) but makes every direction count equally.
 *
 * Columns are scaled to unit length first so the tolerance is relative: a column whose remainder after
 * projection is below `tol` of its own length is a combination of the earlier ones and is dropped.
 *
 * @param {number[][]} X  rows of the model matrix
 * @returns {{Z:Float64Array[], rank:number}} Z holds each row in the basis (N × rank)
 */
export function orthonormalBasis(X, { tol = RANK_TOL } = {}) {
  const N = X.length, k = X[0]?.length || 0;
  const Q = [];
  for (let j = 0; j < k; j++) {
    const v = new Float64Array(N);
    let norm = 0;
    for (let i = 0; i < N; i++) { v[i] = X[i][j]; norm += v[i] * v[i]; }
    norm = Math.sqrt(norm);
    if (!(norm > 0)) continue;
    for (let i = 0; i < N; i++) v[i] /= norm;
    // Twice is enough: one pass of Gram–Schmidt loses orthogonality on nearly dependent columns, two do not.
    for (let pass = 0; pass < 2; pass++) {
      for (const q of Q) { let d = 0; for (let i = 0; i < N; i++) d += q[i] * v[i]; for (let i = 0; i < N; i++) v[i] -= d * q[i]; }
    }
    let rest = 0; for (let i = 0; i < N; i++) rest += v[i] * v[i];
    rest = Math.sqrt(rest);
    if (rest < tol) continue;
    for (let i = 0; i < N; i++) v[i] /= rest;
    Q.push(v);
  }
  const Z = Array.from({ length: N }, (_, i) => Float64Array.from(Q, (q) => q[i]));
  return { Z, rank: Q.length };
}

/**
 * The remainder, relative to a column's own length, below which a model column counts as a combination of
 * the others. Relative, so it does not care whether the runs are in mol% or pseudo-components. A remainder
 * below a millionth means a coefficient whose standard error is inflated a million-fold over an orthogonal
 * design, which is not an estimate anyone can use, and it sits far above the round-off of a true dependency
 * (around 1e-13), so the verdict does not flicker with the last digit.
 */
export const RANK_TOL = 1e-6;

/** How many model terms a set of runs can actually separate: the numerical column rank of its model matrix. */
export const modelRank = (X, tol = RANK_TOL) => (X.length ? orthonormalBasis(X, { tol }).rank : 0);

/**
 * D-optimal selection by Fedorov exchange.
 *
 * A crossed mixture-by-process design offers more candidate points than anyone can run: four lipids and
 * two process factors already reach several hundred. Rather than cutting the design by hand, pick the `n`
 * runs that determine the chosen model best — the set whose information matrix has the largest determinant.
 *
 * The exchange is driven by the determinant *ratio*, not the determinant. Swapping run i out and candidate
 * j in gives |M'| / |M| = (1 + a_j)(1 - b_i) + c_ij², with a, b, c the quadratic forms x'M⁻¹x. One inverse
 * per accepted swap then costs O(k) per candidate pair instead of a fresh Cholesky, which is the difference
 * between a wizard that answers and one that hangs. A small ridge keeps M invertible from a random start.
 *
 * Everything is computed in an orthonormal basis of the candidates' model space (`orthonormalBasis`). In the
 * raw units the default four-lipid crossed design came out of the exchange with rank 28 of 30 (usability
 * cycle 3, C3): its PEG directions were below the ridge, so the search could not see that it was dropping
 * them, and `logDet` could not see it afterwards either.
 *
 * The first start is built rather than drawn: runs are added one at a time, each the candidate the design so
 * far predicts worst (a pivoted QR on the rows, then the classical sequential construction). The first
 * `rank` of them are linearly independent by construction, and an exchange only ever raises the determinant,
 * so whenever the candidate pool can fit the model at all, the selected design can too. The other starts are
 * random, because exchange is greedy and can stall in a poor corner. Points are never repeated — replication
 * is chosen deliberately at the centre, not by the search.
 *
 * @returns {{picked:number[], logdet:number, rank:number, poolRank:number, starts:number, swaps:number}}
 *   logdet is log|X'X| of the selection in the units the terms were given, comparable with `logDet`.
 */
export function dOptimal(candidates, terms, n, { starts = null, maxSwaps = 400, seed = 7 } = {}) {
  const N = candidates.length, k = terms.length;
  // Each pass costs about n·N·k, so a large problem gets fewer restarts rather than a slower wizard.
  const tries = Math.max(1, starts != null ? starts : (n * N * k > 3e5 ? 3 : 6));
  const raw = candidates.map((c) => terms.map((t) => t.f(c)));
  if (n >= N) { const all = modelRank(raw); return { picked: [...Array(N).keys()], logdet: logDet(raw), rank: all, poolRank: all, starts: 0, swaps: 0 }; }
  if (n < k) throw new Error(`${n} runs cannot determine ${k} model terms`);
  // The same tolerance as modelRank, so a direction the search ignores is one the verdict afterwards ignores too.
  const { Z: row, rank: r } = orthonormalBasis(raw);
  const dim = r;
  // The basis is orthonormal over the pool, so a run's squared length averages dim / N: that is the scale.
  const ridge = 1e-9 * (dim / N || 1);
  let st = seed >>> 0;
  const rnd = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; };

  /** M⁻¹ for the current design, with a ridge so a random start is always invertible. */
  const inverse = (picked) => {
    const M = Array.from({ length: dim }, (_, a) => Array.from({ length: dim }, (_, b) => {
      let v = a === b ? ridge : 0;
      for (const i of picked) v += row[i][a] * row[i][b];
      return v;
    }));
    // Relative jitter: M is a sum of squares over the runs, so its scale moves with n and the term sizes.
    const ch = cholesky(M, { absolute: false });
    return ch ? cholInverse(ch.L) : null;
  };
  /** a_j = x_j'M⁻¹x_j, and v_j = M⁻¹x_j, for every candidate. */
  const variances = (Minv) => {
    const v = row.map((x) => { const o = new Float64Array(dim); for (let a = 0; a < dim; a++) { let s = 0; for (let b = 0; b < dim; b++) s += Minv[a][b] * x[b]; o[a] = s; } return o; });
    const a = row.map((x, j) => { let s = 0; for (let b = 0; b < dim; b++) s += x[b] * v[j][b]; return s; });
    return { v, a };
  };

  /** The built start: a pivoted QR on the rows for the first `dim` runs, then the worst-predicted candidate. */
  const sequentialStart = () => {
    const picked = [], taken = new Uint8Array(N);
    const resid = row.map((x) => Float64Array.from(x));
    for (let step = 0; step < Math.min(dim, n); step++) {
      let bj = -1, bn = -1;
      for (let j = 0; j < N; j++) {
        if (taken[j]) continue;
        let s = 0; for (let a = 0; a < dim; a++) s += resid[j][a] * resid[j][a];
        if (s > bn) { bn = s; bj = j; }
      }
      if (bj < 0 || !(bn > 1e-24)) break;
      picked.push(bj); taken[bj] = 1;
      const q = Float64Array.from(resid[bj], (x) => x / Math.sqrt(bn));
      for (let j = 0; j < N; j++) {
        if (taken[j]) continue;
        let d = 0; for (let a = 0; a < dim; a++) d += q[a] * resid[j][a];
        for (let a = 0; a < dim; a++) resid[j][a] -= d * q[a];
      }
    }
    while (picked.length < n) {
      const Minv = inverse(picked);
      let bj = -1, ba = -Infinity;
      if (Minv) {
        const { a } = variances(Minv);
        for (let j = 0; j < N; j++) if (!taken[j] && a[j] > ba) { ba = a[j]; bj = j; }
      }
      if (bj < 0) for (let j = 0; j < N && bj < 0; j++) if (!taken[j]) bj = j;
      picked.push(bj); taken[bj] = 1;
    }
    return picked;
  };

  let best = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    let picked;
    if (attempt === 0) picked = sequentialStart();
    else {
      const set = new Set();
      while (set.size < n) set.add(Math.floor(rnd() * N));
      picked = [...set];
    }
    let swaps = 0;
    for (;;) {
      const Minv = inverse(picked);
      if (!Minv) break;
      const { v, a } = variances(Minv);
      const inSet = new Set(picked);
      let bestGain = 1 + 1e-10, bi = -1, bj = -1;
      for (let pos = 0; pos < n; pos++) {
        const xi = row[picked[pos]], b = a[picked[pos]];
        for (let j = 0; j < N; j++) {
          if (inSet.has(j)) continue;
          let c = 0; for (let m = 0; m < dim; m++) c += xi[m] * v[j][m];
          const gain = (1 + a[j]) * (1 - b) + c * c;
          if (gain > bestGain) { bestGain = gain; bi = pos; bj = j; }
        }
      }
      if (bi < 0 || ++swaps > maxSwaps) break;
      picked[bi] = bj;
    }
    // Compared in the orthonormal basis, where a lost direction costs what it should.
    const ld = logDet(picked.map((i) => row[i]));
    if (!best || ld > best.ld) best = { picked: picked.slice().sort((x, y) => x - y), ld, starts: attempt + 1, swaps };
  }
  const chosen = best.picked.map((i) => raw[i]);
  return { picked: best.picked, logdet: logDet(chosen), rank: modelRank(chosen), poolRank: r, starts: best.starts, swaps: best.swaps };
}

/* ================================ mixture x process ================================ */

/** Coded process grid: every combination of the given levels. 3 levels are needed for a quadratic term. */
export function processGrid(names, levels = 3) {
  const vals = levels <= 2 ? [-1, 1] : levels === 3 ? [-1, 0, 1] : [-1, -1 / 3, 1 / 3, 1];
  let rows = [[]];
  for (let i = 0; i < names.length; i++) rows = rows.flatMap((r) => vals.map((v) => [...r, v]));
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
}

/**
 * One experiment that varies the lipid blend and the process together.
 *
 * Running a mixture design at fixed process settings, then a process design at one fixed blend, answers two
 * smaller questions and misses the one that matters: whether the best blend is still the best blend at a
 * different flow rate. The crossed model asks it directly, at the price of a candidate set that is the
 * product of the two — which is why the design is then selected rather than run whole.
 *
 * @param {Array<{key:string, lo:number, hi:number}>} components  lipid bounds in mol%
 * @param {string[]} processNames  process factors, in coded units here; the caller maps them to real units
 */
export function crossedDesign(components, processNames, {
  total = 100, kind = 'auto', degree = 2, mixtureOrder = 'quadratic', processOrder = 'linear',
  budget = null, replicates = 0, seed = 7, levels = 3, maxPool = null,
} = {}) {
  if (!processNames.length) throw new Error('a crossed design needs at least one process factor');
  const pool = mixturePool(components, { total, kind, degree });
  const grid = processGrid(processNames, processOrder === 'quadratic' ? Math.max(3, levels) : levels);
  const mixTerms = scheffeTerms(components.map((c) => c.key), mixtureOrder);
  const terms = crossedTerms(mixTerms, processTerms(processNames, processOrder));
  const procOrderName = processOrder === 'quadratic' ? 'quadratic' : processOrder === 'interaction' ? 'interaction' : 'linear';
  const model = `crossed model (${mixtureOrder.replace('_', ' ')} blending × ${procOrderName} process)`;
  const fitted = asFitted(components, pool.bounds, total);

  // Keep the product tractable before it is built: thin the mixture side first if the cross would be huge.
  // The exchange needs room to choose, not every point there is — a pool of roughly a dozen candidates per
  // run selected is ample, and the search cost is linear in the pool. Thinning keeps a blend set that fits the
  // blending model, and a full blend set crossed with the process grid fits the crossed model (its model
  // matrix is the Kronecker product of the two), so this never costs the pool its rank.
  const cap = maxPool != null ? maxPool : (budget != null ? Math.max(400, 12 * budget) : 2500);
  let mixPoints = pool.points, thinned = 0;
  if (mixPoints.length * grid.length > cap) {
    const want = Math.max(mixTerms.length, Math.floor(cap / grid.length));
    if (want < mixPoints.length) {
      const pick = dOptimal(mixPoints.map((p) => fitted(p.x)), mixTerms, want, { seed });
      thinned = mixPoints.length - want;
      mixPoints = pick.picked.map((i) => mixPoints[i]);
    }
  }

  const candidates = [];
  for (const g of grid) for (const m of mixPoints) candidates.push({ x: { ...m.x, ...g }, type: m.type, mixType: m.type, process: g });
  const runs = candidates.map((c) => fitted(c.x));
  const poolLd = logDet(designMatrix(runs, terms));

  let points = candidates, selected = false, logdet = poolLd;
  let note = `${mixPoints.length} blend${mixPoints.length > 1 ? 's' : ''} × ${grid.length} process setting${grid.length > 1 ? 's' : ''} = ${candidates.length} candidate runs.`;
  if (thinned) note += ` The blend pool was thinned by ${thinned} points first to keep the product workable.`;

  if (budget != null && budget < candidates.length) {
    if (budget < terms.length) throw new Error(`${budget} runs cannot determine the ${terms.length} terms of this crossed model`);
    const pick = dOptimal(runs, terms, budget, { seed });
    points = pick.picked.map((i) => candidates[i]);
    selected = true;
    logdet = pick.logdet;
    note += ` Reduced to ${budget} runs by D-optimal exchange against the crossed model.`;
  } else {
    note += ' Run whole: no selection needed.';
  }
  assertFittable(points, terms, fitted, { pool: runs, budget: selected ? budget : null, model });

  const reps = Math.max(0, Number(replicates) || 0);
  if (reps > 0) {
    const centre = { ...poolCentre(pool), ...Object.fromEntries(processNames.map((n) => [n, 0])) };
    for (let i = 0; i < reps; i++) points = [...points, { x: { ...centre }, type: 'center' }];
    note += ` ${reps} replicate${reps > 1 ? 's' : ''} at the centre of both give pure error.`;
  }

  return {
    points, pool: candidates, terms, mixTerms, grid, kind: pool.kind, note,
    bounds: pool.bounds, total, constrained: pool.constrained, selected, logdet,
    efficiency: dEfficiency(logdet, terms.length, points.length),
    poolEfficiency: dEfficiency(poolLd, terms.length, candidates.length),
  };
}
