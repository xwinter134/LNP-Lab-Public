// How good a design is before a single batch is made: what it can detect, how evenly it predicts, and which
// effects it cannot tell apart.
//
// All of it depends only on the design matrix and the model, not on any result, which is why it can be read in
// the wizard: changing the design changes these numbers at once, and a design that cannot see an effect of the
// size that matters is better found out at the planning stage than after twenty batches.
//
//   power        for each model term, the chance of finding it significant (p < 0.05) when it is really there
//                at a given size. The size is said as Design-Expert says it, as a signal-to-noise ratio: an
//                effect of 2 SD across the range (low to high) is a coded coefficient of 1 SD. Computed from the
//                noncentral F, so no simulation is involved and the answer is the same every time.
//   FDS          the fraction of the design space where the model predicts the mean to within ±d: where the
//                half-width of the 95 % CI, t·σ·√(x'(X'X)⁻¹x), is below d. Said for d = σ (the noise of one batch)
//                by default. Design-Expert asks for 80 % or more before a response-surface design is used to
//                optimise.
//   correlation  between the model's own columns: 0 for an orthogonal design, and above 0.5 two terms start to
//                borrow each other's effect, which inflates both their standard errors (the VIF says by how much)
//   aliases      what the terms left out of the model do to the ones in it: E[b] = β + A·β₂ with the alias matrix
//                A = (X'X)⁻¹X'X₂. A Plackett-Burman main effect carrying ±⅓ of several interactions is the classic case.
//   D-efficiency |X'X|^(1/p)/n: 100 % for an orthogonal two-level design, lower for designs that spend runs less
//                evenly. It compares designs of the same model; it is not a pass mark.

import { betaIncomplete, fTestP } from './stats.js';
import { boxTerms } from './balance.js';
import { fQuantile } from './diagnostics.js';

/** The F value with P(F > f) = alpha on (df1, df2). */
const fCrit = (alpha, df1, df2) => fQuantile(alpha, df1, df2);

/**
 * P(F' > f) for a noncentral F on (df1, df2) with noncentrality lambda: the Poisson mixture of central F (as
 * beta) distributions, summed until the Poisson weights run out.
 */
export function noncentralFUpper(f, df1, df2, lambda) {
  if (!(f > 0)) return 1;
  if (!(lambda > 0)) return fTestP(f, df1, df2);
  const x = (df1 * f) / (df1 * f + df2);
  const h = lambda / 2;
  // start at the Poisson mode and sum outwards, so a large lambda does not underflow the first weights
  const k0 = Math.floor(h);
  const lw = (k) => -h + k * Math.log(h) - lnFact(k);
  let cdf = 0;
  for (let k = k0; k < k0 + 2000; k++) {
    const w = Math.exp(lw(k));
    cdf += w * betaIncomplete(df1 / 2 + k, df2 / 2, x);
    if (w < 1e-14 && k > k0 + 5) break;
  }
  for (let k = k0 - 1; k >= 0; k--) {
    const w = Math.exp(lw(k));
    cdf += w * betaIncomplete(df1 / 2 + k, df2 / 2, x);
    if (w < 1e-14) break;
  }
  return Math.min(1, Math.max(0, 1 - cdf));
}
const lnFactCache = [0];
function lnFact(k) {
  for (let i = lnFactCache.length; i <= k; i++) lnFactCache[i] = lnFactCache[i - 1] + Math.log(i);
  return lnFactCache[k];
}

/** (X'X)⁻¹ by Gauss-Jordan, or null when the design cannot separate the terms. */
export function inverseXtX(X) {
  const p = X[0]?.length || 0;
  const A = Array.from({ length: p }, (_, i) => [...Array.from({ length: p }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)), ...Array.from({ length: p }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-10 * Math.max(1, Math.abs(A[c][c]))) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c];
    for (let k = 0; k < 2 * p; k++) A[c][k] /= d;
    for (let r = 0; r < p; r++) if (r !== c) { const f = A[r][c]; if (f) for (let k = 0; k < 2 * p; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map((row) => row.slice(p));
}

/** A reproducible spread of points over the coded box (a Halton sequence), for averaging over the design space. */
function halton(i, base) { let f = 1, r = 0; while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); } return r; }
const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37];

/**
 * The evaluation of a process design for a model.
 * @param runs   design rows [{coded}] (buildDesign), centre points and replicates included
 * @param names  factor names
 * @param model  'linear' | 'interaction' | 'quadratic'
 * @param o      {snr: signal-to-noise of the effect to detect (2 = 2 SD across the range), alpha, d: FDS precision
 *               in SD, samples for FDS, ext: half widths of the region in coded units per factor}
 * @returns {{ok, why?, n, p, df, power: [{term, kind, power}], fds, fdsCurve, maxCorrelation, correlations, vif, aliases, dEfficiency}}
 */
export function evaluateDesign(runs, names, model, { snr = 2, alpha = 0.05, d = 1, samples = 2000, ext = {} } = {}) {
  const terms = boxTerms(names, model);
  const X = runs.map((r) => terms.map((t) => t.f(r.coded)));
  const n = X.length, p = terms.length, df = n - p;
  if (n < p) return { ok: false, why: `${n} runs cannot fit the ${p} terms of this model`, n, p, df };
  const inv = inverseXtX(X);
  if (!inv) return { ok: false, why: 'the runs cannot separate the terms of this model (they are aliased)', n, p, df };

  // power: a coded coefficient of snr/2 SD, tested on 1 and df degrees of freedom
  const b = snr / 2;
  const fc = df > 0 ? fCrit(alpha, 1, df) : null;
  const power = terms.map((t, j) => ({ term: t.name, kind: t.kind, of: t.of,
    // a square's coded column runs 0 to 1 rather than −1 to 1, so the same coefficient is half the change
    power: fc == null || t.kind === 'intercept' ? null : noncentralFUpper(fc, 1, df, (b * b) / inv[j][j]) }))
    .filter((x) => x.kind !== 'intercept');

  // FDS: the share of the region where t·√(x'(X'X)⁻¹x) ≤ d (σ = 1), and the curve of that share against d
  const tq = df > 0 ? Math.sqrt(fCrit(alpha, 1, df)) : null;
  const k = names.length;
  const spv = [];
  for (let i = 1; i <= samples; i++) {
    const c = Object.fromEntries(names.map((nm, q) => [nm, (2 * halton(i, PRIMES[q % PRIMES.length]) - 1) * (ext[nm] ?? 1)]));
    const x = terms.map((t) => t.f(c));
    let h = 0;
    for (let a = 0; a < p; a++) { let s = 0; for (let bb = 0; bb < p; bb++) s += inv[a][bb] * x[bb]; h += x[a] * s; }
    spv.push(Math.sqrt(Math.max(0, h)));
  }
  spv.sort((a, c) => a - c);
  const fds = tq == null ? null : spv.filter((v) => tq * v <= d).length / spv.length;
  const fdsCurve = tq == null ? [] : Array.from({ length: 21 }, (_, q) => {
    const frac = q / 20;
    return { fraction: frac, halfWidth: tq * spv[Math.min(spv.length - 1, Math.floor(frac * (spv.length - 1)))] };
  });

  // correlations between the model's columns (the intercept left out) and each term's variance inflation
  const cols = terms.map((_, j) => X.map((r) => r[j]));
  const corr = (u, v) => {
    const mu = u.reduce((a, x) => a + x, 0) / n, mv = v.reduce((a, x) => a + x, 0) / n;
    let su = 0, sv = 0, suv = 0;
    for (let i = 0; i < n; i++) { su += (u[i] - mu) ** 2; sv += (v[i] - mv) ** 2; suv += (u[i] - mu) * (v[i] - mv); }
    return su > 0 && sv > 0 ? suv / Math.sqrt(su * sv) : 0;
  };
  const correlations = [];
  let maxCorrelation = 0;
  for (let a = 1; a < p; a++) for (let c = a + 1; c < p; c++) {
    const r = corr(cols[a], cols[c]);
    if (Math.abs(r) > 1e-9) correlations.push({ a: terms[a].name, b: terms[c].name, r });
    maxCorrelation = Math.max(maxCorrelation, Math.abs(r));
  }
  correlations.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  const vif = terms.map((t, j) => {
    if (t.kind === 'intercept') return null;
    const m = cols[j].reduce((a, x) => a + x, 0) / n;
    const ss = cols[j].reduce((a, x) => a + (x - m) ** 2, 0);
    return { term: t.name, vif: ss > 0 ? inv[j][j] * ss : null };
  }).filter(Boolean);

  // aliases: the terms of the next model up that are not in this one, and how much of each lands on each term
  const up = model === 'linear' ? 'interaction' : model === 'interaction' ? 'quadratic' : null;
  const aliases = [];
  if (up) {
    const inModel = new Set(terms.map((t) => t.name));
    const out = boxTerms(names, up).filter((t) => !inModel.has(t.name));
    for (const t2 of out) {
      const x2 = X.map((_, i) => t2.f(runs[i].coded));
      const xtx2 = terms.map((_, j) => X.reduce((s, r, i) => s + r[j] * x2[i], 0));
      terms.forEach((t, j) => {
        const a = inv[j].reduce((s, v, q) => s + v * xtx2[q], 0);
        if (Math.abs(a) > 0.05) aliases.push({ term: t.name, carries: t2.name, coef: a });
      });
    }
  }

  // D-efficiency of the model matrix: |X'X|^(1/p) / n
  const logDet = -logDetOf(inv);
  const dEfficiency = Math.exp(logDet / p) / n;

  return { ok: true, n, p, df, snr, alpha, d, power, fds, fdsCurve, maxCorrelation, correlations, vif, aliases, dEfficiency };
}

/** log |A| of a symmetric positive definite matrix through its Cholesky factor. */
function logDetOf(A) {
  const p = A.length, L = Array.from({ length: p }, () => new Array(p).fill(0));
  let s = 0;
  for (let i = 0; i < p; i++) for (let j = 0; j <= i; j++) {
    let v = A[i][j];
    for (let k = 0; k < j; k++) v -= L[i][k] * L[j][k];
    if (i === j) { if (!(v > 0)) return NaN; L[i][i] = Math.sqrt(v); s += Math.log(L[i][i]); } else L[i][j] = v / L[j][j];
  }
  return 2 * s;
}

/**
 * The evaluation in two or three sentences for the wizard: the weakest power and which terms it belongs to,
 * the FDS against its 80 % mark, and what aliasing or correlation there is.
 */
export function designEvalSentences(ev, { label = (s) => s } = {}) {
  if (!ev?.ok) return [ev?.why || 'This design cannot be evaluated.'];
  const out = [];
  const pct = (v) => `${Math.round(v * 100)} %`;
  if (ev.df <= 0) out.push(`No residual degrees of freedom: every run goes into the model, so no term can be tested and no interval given. Add centre points or runs.`);
  else {
    const byKind = (k) => ev.power.filter((x) => x.kind === k);
    const part = (k, word) => { const xs = byKind(k); if (!xs.length) return null; const lo = Math.min(...xs.map((x) => x.power)); return `${word} ${pct(lo)}`; };
    const parts = [part('main', 'main effects'), part('interaction', 'interactions'), part('square', 'squares')].filter(Boolean);
    const weakest = Math.min(...ev.power.map((x) => x.power));
    out.push(`Power to find an effect of ${ev.snr} SD across the range (p < ${ev.alpha}): ${parts.join(', ')}. ${weakest >= 0.8 ? 'Every term is well covered (80 % or more).' : `Below the usual 80 %${weakest < 0.5 ? ', so an effect of that size will more often be missed than found' : ''}: more runs or replicates, or a larger effect to look for.`}`);
    if (ev.fds != null && ev.power.some((x) => x.kind === 'square')) out.push(`The model predicts the mean to within ±${ev.d} SD over ${pct(ev.fds)} of the region (FDS); ${ev.fds >= 0.8 ? 'enough to optimise on.' : 'under the 80 % that optimising needs.'}`);
  }
  if (ev.aliases.length) {
    const worst = ev.aliases.slice().sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef))[0];
    const full = ev.aliases.filter((a) => Math.abs(Math.abs(a.coef) - 1) < 1e-6);
    out.push(full.length
      ? `${full.length} term${full.length === 1 ? ' is' : 's are'} fully aliased with a term left out (${full.slice(0, 2).map((a) => `${label(a.term)} = ${label(a.carries)}`).join('; ')}${full.length > 2 ? ' …' : ''}): what is found for one is the sum of both.`
      : `Terms left out of the model lean on the ones in it (largest: ${label(worst.term)} carries ${worst.coef > 0 ? '+' : '−'}${Math.abs(worst.coef).toFixed(2)} of ${label(worst.carries)}); if those effects are real, the estimates shift by that much.`);
  } else if (ev.maxCorrelation > 0.5) {
    const c = ev.correlations[0];
    out.push(`${label(c.a)} and ${label(c.b)} are correlated (r ${c.r.toFixed(2)}) in this design, which widens both their intervals.`);
  }
  return out;
}
