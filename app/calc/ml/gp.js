// Gaussian process regression: the surrogate that turns a handful of batches into a predicted response
// surface with honest error bars. Matérn 5/2 with one lengthscale per factor (ARD), fitted by maximising the
// log marginal likelihood plus log prior — maximum a posteriori, not maximum likelihood.
//
// Why Matérn 5/2 and not the squared exponential: the squared exponential assumes an infinitely smooth
// response, which makes it over-confident between points, and its kernel matrices go near-singular much
// faster as runs cluster. Matérn 5/2 is twice differentiable, which is the assumption that matches a physical
// response with real measurement noise, and it conditions better — worth having when the Cholesky is your own.
//
// Why priors, and why these: with 10 to 40 runs plain maximum likelihood has nothing holding the lengthscales
// up, so it shrinks them, fits the noise, and reports near-zero uncertainty everywhere — the model then
// predicts the mean across most of the space and is confident about it. The priors below are the
// dimension-scaled set introduced by Hvarfner et al. (ICML 2024) and now the default in the standard
// Bayesian-optimisation toolbox: lengthscales are expected to grow as the square root of the number of
// factors, because the distance between two random points in the unit cube grows that way, so the same prior
// means the same model complexity whether there are three factors or eight.
//
// The signal variance is fixed at 1 rather than fitted. The outputs are standardised, so 1 is the right
// scale by construction, and a fitted output scale tends to shrink over a campaign and drag the model toward
// over-local behaviour. One fewer hyperparameter is worth a lot at this sample size.
import { cholesky, cholSolve, cholLogDet, cholInverse, cholInverseFast, zeros, dot, mulberry32, randn } from './linalg.js';

const SQRT5 = Math.sqrt(5);

/** Squared ARD distance between two rows. */
function sqDist(a, b, invL2) {
  let s = 0;
  // Over the kernel's own factors: a multi-task row carries its lipid's index after them (fixedInputView).
  for (let d = 0; d < invL2.length; d++) { const diff = a[d] - b[d]; s += diff * diff * invL2[d]; }
  return s;
}

/** Matérn 5/2: k(r) = σf² (1 + √5 r + 5r²/3) exp(−√5 r). */
export function maternK(r2, sf2) {
  const r = Math.sqrt(Math.max(0, r2));
  return sf2 * (1 + SQRT5 * r + (5 / 3) * r2) * Math.exp(-SQRT5 * r);
}
/** Squared exponential: k(r) = σf² exp(−r²/2). */
export const rbfK = (r2, sf2) => sf2 * Math.exp(-0.5 * r2);

export const KERNELS = {
  matern52: { name: 'Matérn 5/2', k: maternK,
    // k and the factor every lengthscale derivative shares, from one exponential: k = σf² (1 + √5 r + 5r²/3) e,
    // ∂k/∂(log ℓ_d) = base · Δ_d²/ℓ_d² with base = (5/3) σf² (1 + √5 r) e.
    kd: (r2, sf2) => { const r = Math.sqrt(Math.max(0, r2)), e = Math.exp(-SQRT5 * r); return [sf2 * (1 + SQRT5 * r + (5 / 3) * r2) * e, (5 / 3) * sf2 * (1 + SQRT5 * r) * e]; },
    // ∂k/∂(log ℓ_d) = (5/3) σf² (1 + √5 r) e^{−√5 r} · (Δ_d²/ℓ_d²); the 1/r cancels, so r = 0 is safe.
    dkdlog: (r2, sf2, scaledDiff2) => { const r = Math.sqrt(Math.max(0, r2)); return (5 / 3) * sf2 * (1 + SQRT5 * r) * Math.exp(-SQRT5 * r) * scaledDiff2; } },
  rbf: { name: 'Squared exponential', k: rbfK,
    kd: (r2, sf2) => { const k = sf2 * Math.exp(-0.5 * r2); return [k, k]; },
    dkdlog: (r2, sf2, scaledDiff2) => sf2 * Math.exp(-0.5 * r2) * scaledDiff2 },
};

/**
 * Negative log marginal likelihood and its gradient in log-parameter space.
 * theta = [log ℓ_1 … log ℓ_D, log σn, then, for a multi-task fit, the lipid matrix's w (T·rank) and log v (T)]
 *
 * The cost per optimiser step (spec 7.8). The likelihood itself needs only the Cholesky factor: α comes from two
 * triangular solves and the log determinant from the diagonal. The gradient needs tr(K⁻¹ ∂K/∂θ) for every
 * parameter, and that trace cannot be had from solves alone without n of them, so K⁻¹ is still formed, but from
 * the factor by one triangular inversion (linalg.js, cholInverseFast) rather than by n fresh solves, and the
 * kernel's exponential is taken once per pair instead of once per pair per factor, over half the matrix since
 * it is symmetric. Measured on 300 runs over 6 factors, 40 steps of one start: 2.5 s before, 0.8 s after (3.2
 * times faster; 2.1 to 3.1 times at 150 runs), with the same fit to 1e-13 (tests/mlphase4.test.mjs holds the new
 * inverse against the old and the gradient against finite differences).
 */
function nlml(theta, X, y, kernel, priors, opts = {}) {
  const n = X.length, D = opts.dims ?? X[0].length;
  const invL2 = new Float64Array(D);
  for (let d = 0; d < D; d++) { const l = Math.exp(theta[d]); invL2[d] = 1 / (l * l); }
  const sf2 = SIGNAL_VARIANCE;
  const sn2 = opts.fixedNoise != null ? opts.fixedNoise : Math.exp(2 * theta[D]);
  const mt = opts.tasks ? taskMatrix(theta, opts.taskOffset, opts.nTasks, opts.rank) : null;
  const task = opts.tasks;

  // M is the process kernel, Bk the derivative factor shared by every lengthscale (KERNELS[].kd); K = M∘B + σn²I.
  const K = zeros(n, n), M = zeros(n, n), Bk = zeros(n, n);
  for (let i = 0; i < n; i++) {
    const xi = X[i], Ki = K[i], Mi = M[i], Bi = Bk[i];
    for (let j = 0; j < i; j++) {
      const r2 = sqDist(xi, X[j], invL2);
      const [k, base] = kernel.kd(r2, sf2);
      const b = mt ? mt.B[task[i]][task[j]] : 1;
      Ki[j] = K[j][i] = k * b;
      Mi[j] = M[j][i] = k;
      Bi[j] = Bk[j][i] = base * b;
    }
    const b = mt ? mt.B[task[i]][task[i]] : 1;
    Ki[i] = sf2 * b + sn2; Mi[i] = sf2;
  }
  const ch = cholesky(K);
  if (!ch) return { f: 1e30, g: new Float64Array(theta.length) };
  const alpha = cholSolve(ch.L, y);
  let f = 0.5 * dot(y, alpha) + 0.5 * cholLogDet(ch.L) + 0.5 * n * Math.log(2 * Math.PI);

  // gradient: ∂(−log p)/∂θ = −½ tr((ααᵀ − K⁻¹) ∂K/∂θ). W = ααᵀ − K⁻¹ is symmetric, so each pair is visited once.
  const Kinv = cholInverseFast(ch.L);
  const g = new Float64Array(theta.length);
  const S = mt ? zeros(opts.nTasks, opts.nTasks) : null; // Σ over pairs in tasks (a, b) of W_ij M_ij, for B
  let sSn = 0;
  for (let i = 0; i < n; i++) {
    const xi = X[i], Kinvi = Kinv[i], Bi = Bk[i], Mi = M[i], ai = alpha[i];
    for (let j = 0; j < i; j++) {
      const w = ai * alpha[j] - Kinvi[j];
      const c = 2 * w * Bi[j]; // the pair (i, j) and (j, i)
      const xj = X[j];
      for (let d = 0; d < D; d++) { const diff = xi[d] - xj[d]; g[d] += c * diff * diff * invL2[d]; }
      if (S) { const v = w * Mi[j]; S[task[i]][task[j]] += v; S[task[j]][task[i]] += v; }
    }
    const wii = ai * ai - Kinvi[i];
    sSn += wii;
    if (S) S[task[i]][task[i]] += wii * Mi[i];
  }
  for (let d = 0; d < D; d++) g[d] *= -0.5;
  if (opts.fixedNoise == null) g[D] = -0.5 * sSn * 2 * sn2; // the signal variance is fixed; the noise is a scale
  if (mt) {
    // B = W Wᵀ + diag(v). ∂B_ab/∂W_ck = δ_ac W_bk + δ_bc W_ak, so with S symmetric the gradient is −(S W)_ck;
    // ∂B_cc/∂ln v_c = v_c, so that one is −½ S_cc v_c.
    const { W, v } = mt, T = opts.nTasks, R = opts.rank, off = opts.taskOffset;
    for (let c = 0; c < T; c++) {
      for (let k = 0; k < R; k++) { let s = 0; for (let b = 0; b < T; b++) s += S[c][b] * W[b][k]; g[off + c * R + k] = -s; }
      g[off + T * R + c] = -0.5 * S[c][c] * v[c];
    }
  }

  // Gaussian priors on the log-parameters act as a quadratic penalty (MAP rather than ML).
  for (let t = 0; t < theta.length; t++) {
    const pr = priors[t];
    if (!pr) continue;
    if (t === D && opts.fixedNoise != null) continue;
    const z = (theta[t] - pr.mu) / pr.sd;
    f += 0.5 * z * z;
    g[t] += z / pr.sd;
  }
  // Replicate scatter s² on df degrees of freedom (fitGP): −ln p(s² | σ) = df·ln σ + df·s²/(2σ²) + const, and
  // theta[D] is ln σ.
  if (opts.noiseLik && opts.fixedNoise == null) {
    const { df, s2 } = opts.noiseLik, e = s2 * Math.exp(-2 * theta[D]);
    f += df * theta[D] + 0.5 * df * e;
    g[D] += df - df * e;
  }
  return { f, g };
}

/**
 * The lipid matrix of the categorical kernel (spec 7.3.1), from its slice of theta: B = W Wᵀ + diag(v), with
 * W of T rows and `rank` columns and v = exp(log v) > 0, so B is positive definite whatever the optimiser does.
 */
function taskMatrix(theta, off, T, R) {
  const W = Array.from({ length: T }, (_, a) => Array.from({ length: R }, (_, k) => theta[off + a * R + k]));
  const v = Array.from({ length: T }, (_, a) => Math.exp(theta[off + T * R + a]));
  const B = Array.from({ length: T }, (_, a) => Array.from({ length: T }, (_, b) => {
    let s = a === b ? v[a] : 0;
    for (let k = 0; k < R; k++) s += W[a][k] * W[b][k];
    return s;
  }));
  return { W, v, B };
}

/** Exposed for the gradient check in the tests: the objective fitGP minimises, at any theta. */
export function _nlmlForTest(theta, X, y, opts = {}) {
  const kernel = KERNELS[opts.kernel || 'matern52'];
  return nlml(Float64Array.from(theta), X, Float64Array.from(y), kernel, opts.priors || [], opts);
}

/** Standardised outputs have unit variance, so the signal variance is 1 by construction rather than fitted. */
export const SIGNAL_VARIANCE = 1;
/** Lengthscales below this on the unit cube mean the model has collapsed onto its own training points. */
export const MIN_LENGTHSCALE = 0.025;
/** The noise variance floor; below it the kernel matrix stops being conditioned by anything but jitter. */
export const MIN_NOISE_VARIANCE = 1e-4;

/**
 * The dimension-scaled lengthscale prior of Hvarfner et al. (ICML 2024), as used by the current BoTorch default:
 * ln ℓ_d ~ N(√2 + ½ ln D, √3). Expressed here on the parameters this file optimises, ln ℓ_d and ln σ.
 *
 * The noise prior is NOT BoTorch's ln σ² ~ N(−4, 1). That prior expects the noise to be about 2 % of the output
 * variance, which suits simulators and well-replicated assays, not a lab where DLS and RiboGreen scatter is a
 * real fraction of the spread between recipes. Without replicate runs to say otherwise it let the fit explain
 * noise as structure: on four synthetic surfaces (3 factors, 12-30 runs, noise SD 2) the fitted noise SD came
 * out at a third of the truth (median 0.32) and the 95 % prediction intervals held 74 % of new measurements.
 *
 * ln σ² ~ N(−3, 1) is used instead. On the same surfaces the noise comes out at 0.57 of the truth and coverage
 * rises to 78 % (86 % from 30 runs); on nearly noiseless data error and coverage barely move (93 %).
 * A stronger prior, ln σ² ~ N(−2, 1), gets further (0.79, 83 %) but was measured to break the stop rule: on the
 * 15-seed simulated campaign the optimiser found the same recipes either way, yet 10 of 15 campaigns were told
 * to stop, some before round 1, giving up 0.02 of true score, against 4 of 15 and 0.001 now. The stop rule's
 * thresholds were set against the old, more confident model (stopping.js), so the next step is to recalibrate
 * them on a historical campaign and then strengthen this prior, not the other way round.
 *
 * What remains below 95 % at 12-20 runs is mostly the model being unsure of its own lengthscales: with the true
 * noise fixed, coverage is 84 % at 12 runs and 93 % at 30. A point estimate of the hyperparameters cannot carry
 * that; see tests/ml.test.mjs, "prediction intervals: the noise prior".
 */
export const NOISE_PRIOR = { mu: -1.5, sd: 0.5 }; // on ln σ, i.e. ln σ² ~ N(−3, 1)
export function defaultPriors(D) {
  return [
    ...Array.from({ length: D }, () => ({ mu: Math.SQRT2 + 0.5 * Math.log(D), sd: Math.sqrt(3) })),
    { ...NOISE_PRIOR },
  ];
}

/** Adam on the log-parameters: cheap, robust, and good enough for a 5-10 parameter smooth objective. */
function adam(theta0, grad, { steps = 220, lr = 0.08, tol = 1e-5, patience = 25, project = (t) => t } = {}) {
  const theta = project(Float64Array.from(theta0));
  const m = new Float64Array(theta.length), v = new Float64Array(theta.length);
  let best = { f: Infinity, theta: Float64Array.from(theta) }, stale = 0;
  for (let t = 1; t <= steps; t++) {
    const { f, g } = grad(theta);
    if (f < best.f - tol) { best = { f, theta: Float64Array.from(theta) }; stale = 0; }
    else { if (f < best.f) best = { f, theta: Float64Array.from(theta) }; stale++; }
    if (stale >= patience) break; // the marginal likelihood is flat here; more steps buy nothing
    if (!Number.isFinite(f)) break;
    for (let i = 0; i < theta.length; i++) {
      m[i] = 0.9 * m[i] + 0.1 * g[i];
      v[i] = 0.999 * v[i] + 0.001 * g[i] * g[i];
      const mh = m[i] / (1 - Math.pow(0.9, t)), vh = v[i] / (1 - Math.pow(0.999, t));
      theta[i] -= (lr * mh) / (Math.sqrt(vh) + 1e-8);
      theta[i] = Math.max(-8, Math.min(8, theta[i])); // keep the log-parameters in a band Math.exp survives
    }
    // Projected gradient descent: the iterate itself is put back inside the bounds after every step. Clamping
    // only a copy for evaluation (as this file once did) lets Adam wander below a floor where the objective is
    // flat, so the gradient it sees belongs to a different point than the one it is moving, and its moment
    // estimates fill with steps that change nothing.
    project(theta);
  }
  return best;
}

/**
 * Priors on the lipid matrix of the categorical kernel (spec 7.3.1), B = W Wᵀ + diag(v) on standardised outputs.
 * w ~ N(0, 1) puts E[w²] at 1, the scale every task's outputs have after standardising; ln v ~ N(ln 0.1, 1) says
 * the part of a lipid's behaviour the others cannot explain is expected to be about a tenth of its spread, and
 * leaves the data free to say it is all of it (v large, the lipids unrelated) or none (v small, one surface).
 * The start is w = 0.9 and v = 0.19: every lipid at unit variance, correlation 0.81 between any two, which is
 * where a lab that keeps the same process across ionizable lipids would put its bet.
 */
export const LIPID_PRIOR = { w: { mu: 0, sd: 1 }, logV: { mu: Math.log(0.1), sd: 1 }, start: { w: 0.9, v: 0.19 } };

/**
 * Fit a GP to standardised inputs (unit cube) and standardised outputs (zero mean, unit variance).
 * @param {number[][]} X  n×D, each column already scaled to roughly [0,1]
 * @param {number[]} y    n standardised responses
 * @param {object} opts   {kernel:'matern52'|'rbf', restarts, noiseFloor, priors, noisePrior: {var, df}, the pooled
 *   replicate variance on the standardised scale and its degrees of freedom; tasks: one integer per row (0…T−1),
 *   for the categorical lipid kernel, with nTasks and rank (1, or 2). A multi-task row of X carries its process
 *   factors only; the task goes in `tasks`, and the model's own X holds it after them as a last column.}
 */
export function fitGP(X, y, opts = {}) {
  const kernel = KERNELS[opts.kernel || 'matern52'];
  const D = X[0].length;
  const yv = Float64Array.from(y);
  const multi = Array.isArray(opts.tasks) || ArrayBuffer.isView(opts.tasks);
  const T = multi ? Math.max(opts.nTasks ?? 0, ...Array.from(opts.tasks).map((t) => t + 1)) : 0;
  const R = multi ? Math.max(1, Math.min(2, opts.rank ?? 1)) : 0;
  const priors = opts.priors ? [...opts.priors] : defaultPriors(D);
  const minL = Math.log(opts.minLengthscale ?? MIN_LENGTHSCALE);
  // When replicate runs exist the noise does not have to be guessed, but it must not be believed outright
  // either: Binois, Gramacy and Ludkovski (2018, p. 26) warn against the empirical replicate variance below
  // about fifty repeats, and a lab that has repeated one recipe three times has two degrees of freedom, not
  // fifty. So the pooled estimate s² enters as what it is, the likelihood of the noise variance from df degrees
  // of freedom (df·s²/σ² is χ² on df), added to the noise prior rather than put in its place (nlml, `noiseLik`).
  // That evidence is lopsided at few degrees of freedom: two batches that happen to agree say little about how
  // far the next two may differ, two that differ widely say a good deal. So one agreeing repeat barely moves
  // the noise, one that disagrees raises it, and twenty repeats pin it down either way. It used to replace the
  // prior, centred on s² with the large-sample width √(2/df): the first repeat of the model's pick, measuring
  // close to it, then set the noise from one degree of freedom, the surface grew sure of itself around that
  // run, and doing what "stop and confirm" said flipped the verdict to "another round" (usability cycle 5).
  // `fixedNoise` still freezes it outright, which is only for callers that genuinely know the noise.
  const noiseMeas = opts.noisePrior && Number.isFinite(opts.noisePrior.var) && opts.noisePrior.var > 0 && opts.noisePrior.df > 0
    ? opts.noisePrior : null;
  const noiseLik = noiseMeas ? { df: noiseMeas.df, s2: Math.max(MIN_NOISE_VARIANCE, noiseMeas.var) } : null;
  const fixedNoise = Number.isFinite(opts.fixedNoise) ? Math.max(MIN_NOISE_VARIANCE, opts.fixedNoise) : null;
  const minNoise = 0.5 * Math.log(opts.noiseFloor ?? MIN_NOISE_VARIANCE);
  // A multi-task theta keeps the noise slot even when the noise is fixed, so the lipid matrix always starts at
  // D + 1; nlml leaves that slot alone then (no gradient, no prior).
  const taskOffset = D + 1;
  const nParam = multi ? taskOffset + T * R + T : D + (fixedNoise == null ? 1 : 0);
  if (multi) {
    while (priors.length < taskOffset) priors.push(null);
    for (let a = 0; a < T * R; a++) priors[taskOffset + a] = { ...LIPID_PRIOR.w };
    for (let a = 0; a < T; a++) priors[taskOffset + T * R + a] = { ...LIPID_PRIOR.logV };
  }
  const clampTheta = (t) => {
    for (let d = 0; d < D; d++) t[d] = Math.max(minL, t[d]);
    if (fixedNoise == null) t[D] = Math.max(t[D], minNoise);
    // The lipid variances keep off zero for the same reason the noise does: a task with v → 0 and its w
    // collinear with another makes B singular, and the factor stops being conditioned by anything but jitter.
    if (multi) for (let a = 0; a < T; a++) t[taskOffset + T * R + a] = Math.max(Math.log(1e-3), t[taskOffset + T * R + a]);
    return t;
  };
  const taskOpts = multi ? { tasks: Int32Array.from(opts.tasks), nTasks: T, rank: R, taskOffset, dims: D } : {};
  // The iterate is clamped inside adam (`project`), so the gradient is always taken at the point being moved.
  const grad = (th) => nlml(th, X, yv, kernel, priors, { fixedNoise, noiseLik, ...taskOpts });

  // Multistart is the standard advice for ARD, because maximum likelihood leaves a surface with several local
  // optima. Measured on this module's own data it buys almost nothing: across 18 fits of 14 to 40 runs over 3
  // to 5 factors, eight starts improved the total log marginal likelihood by 0.01 nat over one, for thirteen
  // times the work (tests/ml.test.mjs, "multistart"). That is the prior doing its job — it is informative
  // enough to leave one optimum worth finding. Two starts are kept as cheap insurance against a bad draw.
  const rnd = mulberry32(opts.seed ?? 20260101);
  const restarts = Math.max(1, opts.restarts ?? 2);
  // Start at the prior's mode, not its mean. The prior on ln ℓ is wide (sd √3), so its mean sits at a
  // lengthscale of several cube widths — a near-flat surface that takes many steps to climb down from. The
  // mode, exp(mu - sd²), is where the prior actually puts its weight and is close to where real data lands.
  const mode = (p) => p.mu - p.sd * p.sd;
  // The lipid matrix starts where LIPID_PRIOR says. A second rank column starts small and of alternating sign
  // over the lipids, not at zero: B = W Wᵀ + diag(v) has a zero gradient in a column that is zero throughout, so
  // a rank-2 fit started there never left it and came out the rank-1 fit.
  const taskStart = () => (multi ? [
    ...Array.from({ length: T * R }, (_, a) => (a % R === 0 ? LIPID_PRIOR.start.w : (Math.floor(a / R) % 2 ? 1 : -1) * 0.2 * LIPID_PRIOR.start.w)),
    ...Array.from({ length: T }, () => Math.log(LIPID_PRIOR.start.v)),
  ] : []);
  const starts = [clampTheta(Float64Array.from([...priors.slice(0, D).map(mode), mode(priors[D]), ...taskStart()]))];
  while (starts.length < restarts) {
    starts.push(clampTheta(Float64Array.from([
      ...Array.from({ length: D }, (_, d) => mode(priors[d]) + randn(rnd) * priors[d].sd * 0.5),
      mode(priors[D]) + randn(rnd) * priors[D].sd * 0.7,
      ...taskStart(),
    ])));
  }
  let best = null;
  for (const s of starts) {
    const r = adam(s.slice(0, nParam), grad, { steps: opts.steps ?? 180, patience: opts.patience ?? 20, project: clampTheta });
    if (!best || r.f < best.f) best = r;
  }
  const theta = clampTheta(Float64Array.from(best.theta));

  const lengthscales = Array.from({ length: D }, (_, d) => Math.exp(theta[d]));
  // A lengthscale pinned to the floor means the fit wanted to go shorter still, which is the collapse this
  // floor exists to stop. The penalty for hitting it is a few nats, so it can bind without anything else
  // looking wrong; counting it here lets the screen say so instead of quietly reporting a confident model.
  const clampedLengthscales = lengthscales.filter((l) => l <= Math.exp(minL) * 1.001).length;
  const sf2 = SIGNAL_VARIANCE, sn2 = fixedNoise != null ? fixedNoise : Math.exp(2 * theta[D]);
  const invL2 = Float64Array.from(lengthscales.map((l) => 1 / (l * l)));
  const lipid = multi ? taskMatrix(theta, taskOffset, T, R) : null;
  // The covariance of two (augmented) rows: the process kernel, times the lipid matrix's entry when there is one.
  const cov = lipid
    ? (a, b) => kernel.k(sqDist(a, b, invL2), sf2) * lipid.B[a[D]][b[D]]
    : (a, b) => kernel.k(sqDist(a, b, invL2), sf2);
  const Xm = multi ? X.map((x, i) => [...x, opts.tasks[i]]) : X;
  return buildModel({ kind: 'gp', kernelName: kernel.name, X: Xm, y: yv, lengthscales, sf2, sn2, cov, dims: D,
    logMarginalLikelihood: -best.f, noiseFixed: fixedNoise != null, clampedLengthscales,
    ...(lipid ? { lipidMatrix: lipid.B.map((r) => [...r]), lipidW: lipid.W, lipidV: lipid.v, nTasks: T, rank: R } : {}) });
}

/**
 * The posterior of a fitted kernel on rows X with outputs y: the Cholesky factor, α, and the two ways of asking
 * it (one point, or several jointly). fitGP and extendGP both end here, so a fantasy point added for batch
 * suggestion is conditioned on in exactly the way the original data was. `cov` takes rows as X holds them; a
 * multi-task model's prior variance at a row is its lipid's diagonal entry, which cov(x, x) gives.
 */
function buildModel(m) {
  const { X, y, cov, sn2 } = m;
  const n = X.length;
  const K = zeros(n, n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    const k = cov(X[i], X[j]);
    K[i][j] = K[j][i] = k + (i === j ? sn2 : 0);
  }
  const ch = cholesky(K);
  if (!ch) return null;
  const alpha = cholSolve(ch.L, y);
  const kvec = (x) => { const k = new Float64Array(n); for (let i = 0; i < n; i++) k[i] = cov(X[i], x); return k; };
  return { ...m, L: ch.L, alpha, jitter: ch.jitter,
    /** Posterior mean and standard deviation at one point (standardised space). `noiseless` omits σn. */
    predict(x, { noiseless = true } = {}) {
      const kstar = kvec(x);
      const mean = dot(kstar, alpha);
      const v = cholSolve(ch.L, kstar);
      const varf = Math.max(1e-12, cov(x, x) - dot(kstar, v));
      return { mean, sd: Math.sqrt(noiseless ? varf : varf + sn2), variance: varf };
    },
    /** Posterior mean and covariance for several points at once (needed for correlated batch sampling). */
    posterior(Xs) {
      const mm = Xs.length, Ks = Xs.map(kvec);
      const mean = Ks.map((row) => dot(row, alpha));
      const covm = zeros(mm, mm);
      const V = Ks.map((row) => cholSolve(ch.L, row));
      for (let a = 0; a < mm; a++) for (let b = 0; b <= a; b++) {
        const val = cov(Xs[a], Xs[b]) - dot(Ks[a], V[b]);
        covm[a][b] = covm[b][a] = val;
      }
      for (let a = 0; a < mm; a++) covm[a][a] = Math.max(covm[a][a], 1e-10);
      return { mean, cov: covm };
    },
  };
}

/**
 * Condition an existing fit on extra points, keeping the fitted hyperparameters. Used for batch suggestion:
 * after picking a run, the optimiser pretends it already came back at the predicted value ("kriging believer")
 * so the next pick sees the uncertainty that run would have removed, and the batch spreads out by itself.
 * Both predict and posterior are rebuilt (buildModel): spreading the object and overriding only predict would
 * leave posterior closed over the original factorisation, so a joint draw would silently ignore the extra points.
 * A view at one lipid (fixedInputView) is extended underneath, with that lipid's columns added to the new rows.
 */
export function extendGP(model, newX, newY) {
  if (model.view) return fixedInputView(extendGP(model.view.base, newX.map(model.view.aug), newY), model.view.suffix) || model;
  const out = buildModel({ ...model, X: [...model.X, ...newX], y: Float64Array.from([...model.y, ...newY]) });
  return out || model;
}

/**
 * A fitted model seen at fixed values of its last inputs: the categorical kernel at one lipid (suffix [task]),
 * the descriptor mode at one lipid's descriptors. Everything downstream (acquire.js, explain.js, the screen)
 * passes points of the searched factors only, so the view appends the suffix and otherwise behaves as the model.
 * `dims` says how many of the base's inputs are searched factors; their lengthscales are the view's.
 */
export function fixedInputView(base, suffix, dims = null) {
  if (!base) return null;
  const s = Array.from(suffix);
  const aug = (x) => [...x, ...s];
  const D = dims ?? base.viewDims ?? (base.X[0].length - s.length);
  const ls = base.lengthscales.slice(0, D);
  return { ...base, viewDims: D, view: { base, suffix: s, aug }, lengthscales: ls,
    clampedLengthscales: ls.filter((l) => l <= MIN_LENGTHSCALE * 1.001).length,
    predict: (x, o) => base.predict(aug(x), o),
    posterior: (Xs) => base.posterior(Xs.map(aug)) };
}

/**
 * The fitted hyperparameters in plain numbers, for the model fingerprint (spec 7.5): lengthscales, noise, and
 * the lipid matrix when the categorical kernel was used. Rounded to 12 significant digits, so a refit on the
 * same data reproduces them and two platforms' last-bit differences do not read as a different model.
 */
export function hyperparameters(model) {
  if (!model) return null;
  const b = model.view?.base || model;
  const r = (v) => Number(Number(v).toPrecision(12));
  return { kernel: b.kernelName, lengthscales: b.lengthscales.map(r), noiseVariance: r(b.sn2),
    ...(b.lipidMatrix ? { lipidMatrix: b.lipidMatrix.map((row) => row.map(r)) } : {}),
    ...(model.view ? { at: model.view.suffix.map(r) } : {}) };
}

/** Leave-one-out predictive mean and variance in closed form (Rasmussen & Williams eq. 5.12): n fits for free. */
export function looPredictions(model) {
  const n = model.X.length;
  const Kinv = cholInverse(model.L);
  const out = [];
  for (let i = 0; i < n; i++) {
    const varI = 1 / Kinv[i][i];
    out.push({ mean: model.y[i] - model.alpha[i] * varI, variance: varI });
  }
  return out;
}
