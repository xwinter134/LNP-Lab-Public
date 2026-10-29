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
import { cholesky, cholSolve, cholLogDet, cholInverse, zeros, dot, mulberry32, randn } from './linalg.js';

const SQRT5 = Math.sqrt(5);

/** Squared ARD distance between two rows. */
function sqDist(a, b, invL2) {
  let s = 0;
  for (let d = 0; d < a.length; d++) { const diff = a[d] - b[d]; s += diff * diff * invL2[d]; }
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
    // ∂k/∂(log ℓ_d) = (5/3) σf² (1 + √5 r) e^{−√5 r} · (Δ_d²/ℓ_d²); the 1/r cancels, so r = 0 is safe.
    dkdlog: (r2, sf2, scaledDiff2) => { const r = Math.sqrt(Math.max(0, r2)); return (5 / 3) * sf2 * (1 + SQRT5 * r) * Math.exp(-SQRT5 * r) * scaledDiff2; } },
  rbf: { name: 'Squared exponential', k: rbfK,
    dkdlog: (r2, sf2, scaledDiff2) => sf2 * Math.exp(-0.5 * r2) * scaledDiff2 },
};

/**
 * Negative log marginal likelihood and its gradient in log-parameter space.
 * theta = [log ℓ_1 … log ℓ_D, log σf, log σn]
 */
function nlml(theta, X, y, kernel, priors, opts = {}) {
  const n = X.length, D = X[0].length;
  const invL2 = new Float64Array(D);
  for (let d = 0; d < D; d++) { const l = Math.exp(theta[d]); invL2[d] = 1 / (l * l); }
  const sf2 = SIGNAL_VARIANCE;
  const sn2 = opts.fixedNoise != null ? opts.fixedNoise : Math.exp(2 * theta[D]);

  const K = zeros(n, n), R2 = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      const r2 = sqDist(X[i], X[j], invL2);
      const k = kernel.k(r2, sf2);
      K[i][j] = K[j][i] = k + (i === j ? sn2 : 0);
      R2[i][j] = R2[j][i] = r2;
    }
  }
  const ch = cholesky(K);
  if (!ch) return { f: 1e30, g: new Float64Array(theta.length) };
  const alpha = cholSolve(ch.L, y);
  let f = 0.5 * dot(y, alpha) + 0.5 * cholLogDet(ch.L) + 0.5 * n * Math.log(2 * Math.PI);

  // gradient: ∂(−log p)/∂θ = −½ tr((ααᵀ − K⁻¹) ∂K/∂θ)
  const Kinv = cholInverse(ch.L);
  const W = zeros(n, n); // ααᵀ − K⁻¹
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) W[i][j] = alpha[i] * alpha[j] - Kinv[i][j];

  const g = new Float64Array(theta.length);
  for (let d = 0; d < D; d++) {
    let s = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const diff = X[i][d] - X[j][d];
      s += W[i][j] * kernel.dkdlog(R2[i][j], sf2, diff * diff * invL2[d]);
    }
    g[d] = -0.5 * s;
  }
  if (opts.fixedNoise == null) { // the noise is the only remaining scale parameter; the signal variance is fixed
    let sSn = 0;
    for (let i = 0; i < n; i++) sSn += W[i][i] * 2 * sn2;
    g[D] = -0.5 * sSn;
  }

  // Gaussian priors on the log-parameters act as a quadratic penalty (MAP rather than ML).
  for (let t = 0; t < theta.length; t++) {
    const pr = priors[t];
    if (!pr) continue;
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

/** Standardised outputs have unit variance, so the signal variance is 1 by construction rather than fitted. */
export const SIGNAL_VARIANCE = 1;
/** Lengthscales below this on the unit cube mean the model has collapsed onto its own training points. */
export const MIN_LENGTHSCALE = 0.025;
/** The noise variance floor; below it the kernel matrix stops being conditioned by anything but jitter. */
export const MIN_NOISE_VARIANCE = 1e-4;

/**
 * The dimension-scaled prior of Hvarfner et al. (ICML 2024), as used by the current BoTorch default:
 * ln ℓ_d ~ N(√2 + ½ ln D, √3), and ln σ² ~ N(−4, 1) for the noise. Expressed here on the parameters this
 * file optimises, which are ln ℓ_d and ln σ (hence half the mean and half the spread for the noise).
 */
export function defaultPriors(D) {
  return [
    ...Array.from({ length: D }, () => ({ mu: Math.SQRT2 + 0.5 * Math.log(D), sd: Math.sqrt(3) })),
    { mu: -2, sd: 0.5 },
  ];
}

/** Adam on the log-parameters: cheap, robust, and good enough for a 5-10 parameter smooth objective. */
function adam(theta0, grad, { steps = 220, lr = 0.08, tol = 1e-5, patience = 25 } = {}) {
  const theta = Float64Array.from(theta0);
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
  }
  return best;
}

/**
 * Fit a GP to standardised inputs (unit cube) and standardised outputs (zero mean, unit variance).
 * @param {number[][]} X  n×D, each column already scaled to roughly [0,1]
 * @param {number[]} y    n standardised responses
 * @param {object} opts   {kernel:'matern52'|'rbf', restarts, noiseFloor, priors, noisePrior: {var, df}, the pooled
 *   replicate variance on the standardised scale and its degrees of freedom}
 */
export function fitGP(X, y, opts = {}) {
  const kernel = KERNELS[opts.kernel || 'matern52'];
  const n = X.length, D = X[0].length;
  const yv = Float64Array.from(y);
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
  const nParam = D + (fixedNoise == null ? 1 : 0);
  const clampTheta = (t) => {
    for (let d = 0; d < D; d++) t[d] = Math.max(minL, t[d]);
    if (fixedNoise == null) t[D] = Math.max(t[D], minNoise);
    return t;
  };
  const grad = (th) => nlml(clampTheta(Float64Array.from(th)), X, yv, kernel, priors, { fixedNoise, noiseLik });

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
  const starts = [clampTheta(Float64Array.from([...priors.slice(0, D).map(mode), mode(priors[D])]))];
  while (starts.length < restarts) {
    starts.push(clampTheta(Float64Array.from([
      ...Array.from({ length: D }, (_, d) => mode(priors[d]) + randn(rnd) * priors[d].sd * 0.5),
      mode(priors[D]) + randn(rnd) * priors[D].sd * 0.7,
    ])));
  }
  let best = null;
  for (const s of starts) {
    const r = adam(s.slice(0, nParam === D ? D : D + 1), grad, { steps: opts.steps ?? 180, patience: opts.patience ?? 20 });
    if (!best || r.f < best.f) best = r;
  }
  const theta = clampTheta(Float64Array.from(best.theta));

  const lengthscales = Array.from({ length: D }, (_, d) => Math.exp(theta[d]));
  // A lengthscale pinned to the floor means the fit wanted to go shorter still, which is the collapse this
  // floor exists to stop. The penalty for hitting it is a few nats, so it can bind without anything else
  // looking wrong; counting it here lets the screen say so instead of quietly reporting a confident model.
  const clampedLengthscales = lengthscales.filter((l) => l <= Math.exp(minL) * 1.001).length;
  const sf2 = SIGNAL_VARIANCE, sn2 = fixedNoise != null ? fixedNoise : Math.exp(2 * theta[D]);
  const invL2 = lengthscales.map((l) => 1 / (l * l));
  const K = zeros(n, n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    const k = kernel.k(sqDist(X[i], X[j], invL2), sf2);
    K[i][j] = K[j][i] = k + (i === j ? sn2 : 0);
  }
  const ch = cholesky(K);
  if (!ch) return null;
  const alpha = cholSolve(ch.L, yv);

  const model = {
    kind: 'gp', kernelName: kernel.name, X, y: yv, L: ch.L, alpha, lengthscales, sf2, sn2,
    logMarginalLikelihood: -best.f, jitter: ch.jitter, noiseFixed: fixedNoise != null, clampedLengthscales,
    /** Posterior mean and standard deviation at one point (standardised space). `noiseless` omits σn. */
    predict(x, { noiseless = true } = {}) {
      const kstar = new Float64Array(n);
      for (let i = 0; i < n; i++) kstar[i] = kernel.k(sqDist(X[i], x, invL2), sf2);
      const mean = dot(kstar, alpha);
      const v = cholSolve(ch.L, kstar);
      const varf = Math.max(1e-12, sf2 - dot(kstar, v));
      return { mean, sd: Math.sqrt(noiseless ? varf : varf + sn2), variance: varf };
    },
    /** Posterior mean and covariance for several points at once (needed for correlated batch sampling). */
    posterior(Xs) {
      const m = Xs.length, Ks = zeros(m, n);
      for (let a = 0; a < m; a++) for (let i = 0; i < n; i++) Ks[a][i] = kernel.k(sqDist(X[i], Xs[a], invL2), sf2);
      const mean = Ks.map((row) => dot(row, alpha));
      const cov = zeros(m, m);
      const V = Ks.map((row) => cholSolve(ch.L, row));
      for (let a = 0; a < m; a++) for (let b = 0; b <= a; b++) {
        const kab = kernel.k(sqDist(Xs[a], Xs[b], invL2), sf2);
        const val = kab - dot(Ks[a], V[b]);
        cov[a][b] = cov[b][a] = val;
      }
      for (let a = 0; a < m; a++) cov[a][a] = Math.max(cov[a][a], 1e-10);
      return { mean, cov };
    },
  };
  return model;
}

/**
 * Condition an existing fit on extra points, keeping the fitted hyperparameters. Used for batch suggestion:
 * after picking a run, the optimiser pretends it already came back at the predicted value ("kriging believer")
 * so the next pick sees the uncertainty that run would have removed, and the batch spreads out by itself.
 */
export function extendGP(model, newX, newY) {
  const X = [...model.X, ...newX], y = Float64Array.from([...model.y, ...newY]);
  const n = X.length, D = X[0].length;
  const kernel = Object.values(KERNELS).find((k) => k.name === model.kernelName) || KERNELS.matern52;
  const invL2 = model.lengthscales.map((l) => 1 / (l * l));
  const K = zeros(n, n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    const k = kernel.k(sqDist(X[i], X[j], invL2), model.sf2);
    K[i][j] = K[j][i] = k + (i === j ? model.sn2 : 0);
  }
  const ch = cholesky(K);
  if (!ch) return model;
  const alpha = cholSolve(ch.L, y);
  const kvec = (x) => { const k = new Float64Array(n); for (let i = 0; i < n; i++) k[i] = kernel.k(sqDist(X[i], x, invL2), model.sf2); return k; };
  // Both predict and posterior are rebuilt. Spreading the object and overriding only predict would leave
  // posterior closed over the original factorisation, so a joint draw would silently ignore the extra points.
  return { ...model, X, y, L: ch.L, alpha,
    predict(x, { noiseless = true } = {}) {
      const kstar = kvec(x);
      const mean = dot(kstar, alpha);
      const varf = Math.max(1e-12, model.sf2 - dot(kstar, cholSolve(ch.L, kstar)));
      return { mean, sd: Math.sqrt(noiseless ? varf : varf + model.sn2), variance: varf };
    },
    posterior(Xs) {
      const m = Xs.length, Ks = Xs.map(kvec);
      const mean = Ks.map((row) => dot(row, alpha));
      const V = Ks.map((row) => cholSolve(ch.L, row));
      const cov = zeros(m, m);
      for (let a = 0; a < m; a++) for (let b = 0; b <= a; b++) {
        const kab = kernel.k(sqDist(Xs[a], Xs[b], invL2), model.sf2);
        cov[a][b] = cov[b][a] = kab - dot(Ks[a], V[b]);
      }
      for (let a = 0; a < m; a++) cov[a][a] = Math.max(cov[a][a], 1e-10);
      return { mean, cov };
    } };
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
