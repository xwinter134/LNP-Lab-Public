// Small statistics helpers for Insights and DoE: Pearson r, ordinary least squares, control limits.
export const mean = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
export const sd = (xs) => { const v = xs.filter(Number.isFinite); if (v.length < 2) return null; const m = mean(v); return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); };

export function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 3) return { r: null, n: pairs.length };
  const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return { r: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null, n: pairs.length };
}

/** Solve A x = b (small dense system) by Gaussian elimination with partial pivoting. */
export function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/**
 * OLS fit y = X b. X: rows of regressors (include a 1 for the intercept). Returns coefficients, R², adjusted R², residuals.
 */
export function ols(X, y) {
  const n = y.length, p = X[0].length;
  if (n <= p) return { beta: null, r2: null, adjR2: null, residuals: [], n, p, note: `needs more than ${p} runs` };
  const XtX = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
  const Xty = Array.from({ length: p }, (_, i) => X.reduce((s, r, k) => s + r[i] * y[k], 0));
  const beta = solve(XtX, Xty);
  if (!beta) return { beta: null, r2: null, adjR2: null, residuals: [], n, p, note: 'singular design (factors confounded)' };
  const yhat = X.map((r) => r.reduce((s, x, i) => s + x * beta[i], 0));
  const my = mean(y), sst = y.reduce((s, v) => s + (v - my) ** 2, 0), sse = y.reduce((s, v, i) => s + (v - yhat[i]) ** 2, 0);
  const r2 = sst > 0 ? 1 - sse / sst : null;
  const adjR2 = r2 != null && n - p > 0 ? 1 - (1 - r2) * (n - 1) / (n - p) : null;
  const se = n - p > 0 ? Math.sqrt(sse / (n - p)) : null;
  const residuals = y.map((v, i) => v - yhat[i]);
  // (X'X)^-1 for standard errors and leverages
  const inv = [];
  for (let j = 0; j < p; j++) { const e = Array.from({ length: p }, (_, i) => (i === j ? 1 : 0)); const col = solve(XtX, e); inv.push(col); }
  const mse = n - p > 0 ? sse / (n - p) : null;
  const stdErr = mse != null ? beta.map((_, j) => Math.sqrt(Math.max(0, mse * inv[j][j]))) : null;
  const tValues = stdErr ? beta.map((b, j) => (stdErr[j] > 0 ? b / stdErr[j] : null)) : null;
  const pValues = tValues ? tValues.map((t) => (t == null ? null : tTestP(t, n - p))) : null;
  const leverage = X.map((r) => r.reduce((s, xi, i) => s + xi * r.reduce((s2, xj, j) => s2 + inv[i][j] * xj, 0), 0));
  const press = residuals.reduce((s, e, i) => s + (e / (1 - leverage[i])) ** 2, 0);
  const predR2 = sst > 0 ? 1 - press / sst : null;
  return { beta, r2, adjR2, predR2, press, residuals, yhat, n, p, se, stdErr, tValues, pValues, leverage };
}

/** Two-sided p-value of a t statistic with df degrees of freedom (regularised incomplete beta). */
export function tTestP(t, df) {
  if (!Number.isFinite(t) || df <= 0) return null;
  const x = df / (df + t * t);
  return Math.min(1, Math.max(0, betaI(df / 2, 0.5, x)));
}
function betaI(a, b, x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta);
  if (x < (a + 1) / (a + b + 2)) return (front * betaCF(a, b, x)) / a;
  return 1 - (front * betaCF(b, a, 1 - x)) / b;
}
function betaCF(a, b, x) {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap; if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function lnGamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015; for (const gi of g) ser += gi / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Control limits from the first `base` points (mean ± k·sd). */
export function controlLimits(values, base = 20, k = 2) {
  const v = values.filter(Number.isFinite);
  const ref = v.slice(0, Math.min(base, v.length));
  const m = mean(ref), s = sd(ref);
  return { mean: m, sd: s, ucl: m != null && s != null ? m + k * s : null, lcl: m != null && s != null ? m - k * s : null, n: ref.length };
}

/*
 * Tests between groups and a straight line through time, for the experiment page (calc/results.js). The p
 * values reuse the incomplete beta above, so the t test, the F test and the DoE fit share one special function.
 */

/**
 * Upper-tail p value of an F statistic on (df1, df2) degrees of freedom: how often an F this large turns up
 * when every group has the same mean. P(F > f) = I_x(df2/2, df1/2) with x = df2 / (df2 + df1·f).
 */
export function fTestP(F, df1, df2) {
  if (!Number.isFinite(F) || !(df1 > 0) || !(df2 > 0)) return null;
  if (F <= 0) return 1;
  return Math.min(1, Math.max(0, betaI(df2 / 2, df1 / 2, df2 / (df2 + df1 * F))));
}

/**
 * The least-squares line y = intercept + slope·x, with the slope's standard error on n − 2 degrees of freedom.
 * Residuals are summed directly rather than as Syy − b·Sxy, which loses digits when the line fits well.
 * @returns {{slope, intercept, seSlope, df, n, r2, xMin, xMax}|null} null below two distinct x
 */
export function linearFit(xs, ys) {
  const pts = xs.map((x, i) => [Number(x), Number(ys[i])]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = pts.length;
  if (n < 2) return null;
  const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx, intercept = my - slope * mx;
  const sse = pts.reduce((s, [x, y]) => s + (y - intercept - slope * x) ** 2, 0);
  const df = n - 2;
  return {
    slope, intercept, df, n,
    seSlope: df > 0 ? Math.sqrt(sse / df / sxx) : null,
    r2: syy > 0 ? Math.max(0, 1 - sse / syy) : 1,
    xMin: Math.min(...pts.map((p) => p[0])), xMax: Math.max(...pts.map((p) => p[0])),
  };
}

/**
 * Six results of 0.1 sum to 0.6000000000000001, so their variance comes out near 1e-33 rather than 0: that is
 * no spread at all, and an F or t divided by it would be a large number about nothing.
 */
const negligible = (variance, values) => !(variance > 1e-20 * Math.max(Number.MIN_VALUE, ...values.map((v) => v * v)));

/**
 * Welch's t test of two independent samples: no assumption that the two have the same spread, which two
 * recipes need not have. Degrees of freedom by Welch–Satterthwaite, so usually not a whole number.
 * @returns {{t, df, p, diff, se, n: [na, nb]}|null} null with fewer than two values in either sample, or no spread at all
 */
export function welchTest(a, b) {
  const x = a.filter(Number.isFinite), y = b.filter(Number.isFinite);
  if (x.length < 2 || y.length < 2) return null;
  const va = sd(x) ** 2 / x.length, vb = sd(y) ** 2 / y.length;
  if (negligible(va + vb, [...x, ...y])) return null;
  const se = Math.sqrt(va + vb);
  const diff = mean(x) - mean(y), t = diff / se;
  const df = (va + vb) ** 2 / (va ** 2 / (x.length - 1) + vb ** 2 / (y.length - 1));
  return { t, df, p: tTestP(t, df), diff, se, n: [x.length, y.length] };
}

/**
 * One-way analysis of variance: do k groups share one mean? Every group needs a value; the residual mean
 * square (msw) is also the pooled variance the pairwise comparisons below use.
 * @returns {{F, df1, df2, p, ssb, ssw, msb, msw, means, ns}|null}
 */
export function anovaOneWay(groups) {
  const gs = groups.map((g) => g.filter(Number.isFinite));
  if (gs.length < 2 || gs.some((g) => !g.length)) return null;
  const N = gs.reduce((s, g) => s + g.length, 0), k = gs.length;
  if (N - k < 1) return null;
  const means = gs.map(mean), ns = gs.map((g) => g.length);
  const grand = mean(gs.flat());
  const ssb = gs.reduce((s, g, i) => s + g.length * (means[i] - grand) ** 2, 0);
  const ssw = gs.reduce((s, g, i) => s + g.reduce((a, v) => a + (v - means[i]) ** 2, 0), 0);
  const df1 = k - 1, df2 = N - k, msb = ssb / df1, msw = ssw / df2;
  if (negligible(msw, gs.flat())) return null;
  const F = msb / msw;
  return { F, df1, df2, p: fTestP(F, df1, df2), ssb, ssw, msb, msw, means, ns };
}

/**
 * Holm–Šídák step-down adjustment of a family of p values, returned in the order given. The smallest is
 * tested against all m comparisons, the next against m − 1, and so on; an adjusted p never falls below the
 * one before it, so the order of significance cannot invert.
 */
export function holmSidak(ps) {
  const m = ps.length;
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(m);
  let run = 0;
  order.forEach(([p, i], j) => { run = Math.max(run, 1 - (1 - p) ** (m - j)); out[i] = Math.min(1, run); });
  return out;
}

/**
 * Every pair of groups after a one-way ANOVA, as Prism does it: a t test on the ANOVA's pooled variance and
 * residual degrees of freedom, with Holm–Šídák adjusted p values.
 * @returns {Array<{i, j, diff, t, p, pAdj}>}
 */
export function pairwiseAfterAnova(groups, anova) {
  if (!anova) return [];
  const pairs = [];
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    const diff = anova.means[i] - anova.means[j];
    const t = diff / Math.sqrt(anova.msw * (1 / anova.ns[i] + 1 / anova.ns[j]));
    pairs.push({ i, j, diff, t, p: tTestP(t, anova.df2) });
  }
  const adj = holmSidak(pairs.map((x) => x.p));
  return pairs.map((x, k) => ({ ...x, pAdj: adj[k] }));
}
