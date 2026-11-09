// Classical ANOVA table for a fitted process-design model: Model / Residual / (Lack of fit + Pure error) / Total,
// plus variance inflation factors and leverage. Built on the least-squares fit the DoE screen already makes
// (stats.ols), so the table cannot disagree with the coefficient table beside it.
import { fTestP, solve } from './stats.js';

const key = (c, names) => names.map((n) => Number(c[n]).toFixed(6)).join('|');

/**
 * @param fit    result of ols() on the model matrix of `terms` (needs yhat, residuals, n, p, leverage)
 * @param runs   the measured runs the fit used, in the same order, each {coded:{factor: -1..1}}
 * @param terms  [{name, kind, f(coded)}] with the intercept first (calc/balance.js boxTerms)
 * @returns {rows, vif, leverage, lackOfFit}|null
 *   rows: [{id, label, ss, df, ms, F, p}] for model, residual, lof, pe, total (lof/pe only when replicated);
 *   lackOfFit: {state:'significant'|'none'|'untestable-replicates'|'untestable-saturated', p}
 */
export function anova(fit, runs, terms) {
  if (!fit?.beta || !fit.yhat || runs.length !== fit.n) return null;
  const { n, p } = fit;
  const y = fit.yhat.map((v, i) => v + fit.residuals[i]);
  const my = y.reduce((a, b) => a + b, 0) / n;
  const sst = y.reduce((s, v) => s + (v - my) ** 2, 0);
  const sse = fit.residuals.reduce((s, e) => s + e * e, 0);
  const ssm = Math.max(0, sst - sse);
  const dfm = p - 1, dfe = n - p;
  const row = (id, label, ss, df, extra = {}) => ({ id, label, ss, df, ms: df > 0 ? ss / df : null, F: null, p: null, ...extra });
  const model = row('model', 'Model', ssm, dfm), resid = row('residual', 'Residual', sse, dfe), total = row('total', 'Total', sst, n - 1);
  if (model.ms != null && resid.ms > 0) { model.F = model.ms / resid.ms; model.p = fTestP(model.F, dfm, dfe); }
  const rows = [model, resid];

  // Pure error: spread among runs made at exactly the same coded setting (centre points are the usual ones).
  const names = Object.keys(runs[0]?.coded || {});
  const groups = new Map();
  runs.forEach((r, i) => { const k = key(r.coded, names); (groups.get(k) || groups.set(k, []).get(k)).push(y[i]); });
  let ssPE = 0, dfPE = 0;
  for (const g of groups.values()) { if (g.length < 2) continue; const m = g.reduce((a, b) => a + b, 0) / g.length; ssPE += g.reduce((s, v) => s + (v - m) ** 2, 0); dfPE += g.length - 1; }
  const dfLOF = dfe - dfPE;
  let lackOfFit = { state: 'untestable-replicates', p: null };
  if (dfPE > 0 && dfLOF <= 0) lackOfFit = { state: 'untestable-saturated', p: null };
  else if (dfPE > 0) {
    const lof = row('lof', 'Lack of fit', Math.max(0, sse - ssPE), dfLOF), pe = row('pe', 'Pure error', ssPE, dfPE);
    if (pe.ms > 0) { lof.F = lof.ms / pe.ms; lof.p = fTestP(lof.F, dfLOF, dfPE); }
    else if (lof.ms != null) lof.F = lof.ms > 1e-12 ? Infinity : 0, lof.p = lof.ms > 1e-12 ? 0 : 1; // identical replicates
    rows.push(lof, pe);
    lackOfFit = { state: lof.p != null && lof.p < 0.05 ? 'significant' : 'none', p: lof.p };
  }
  rows.push(total);

  // VIF of each non-intercept term: the diagonal of the inverse correlation matrix of those columns.
  const cols = terms.map((t, j) => ({ t, j })).filter((c) => c.t.kind !== 'intercept');
  const X = runs.map((r) => cols.map((c) => c.t.f(r.coded)));
  const m = cols.length, mean = cols.map((_, c) => X.reduce((s, r) => s + r[c], 0) / n);
  const cen = X.map((r) => r.map((v, c) => v - mean[c]));
  const ss = cols.map((_, c) => cen.reduce((s, r) => s + r[c] ** 2, 0));
  const R = cols.map((_, a) => cols.map((_, b) => (ss[a] > 0 && ss[b] > 0 ? cen.reduce((s, r) => s + r[a] * r[b], 0) / Math.sqrt(ss[a] * ss[b]) : a === b ? 1 : 0)));
  const vif = cols.map((c, a) => {
    if (!(ss[a] > 0)) return { name: c.t.name, vif: null };
    const col = solve(R, Array.from({ length: m }, (_, i) => (i === a ? 1 : 0)));
    return { name: c.t.name, vif: col && col[a] > 0 ? col[a] : null };
  });

  // Scaled leverage h·n/p: 1 means every run pulls equally; a run far above 2–3 steers the fit on its own.
  const lev = fit.leverage || [];
  const maxH = lev.length ? Math.max(...lev) : null;
  return { rows, vif, lackOfFit, leverage: { max: maxH, scaledMax: maxH != null ? maxH * n / p : null }, n, p };
}

/** One plain sentence on lack of fit, for the fold. */
export function lackOfFitSentence(lof) {
  const pf = (p) => (p < 0.001 ? '< 0.001' : p.toFixed(2));
  if (lof.state === 'significant') return `Lack of fit is significant (p ${pf(lof.p)}): the model shape misses something; add centre points or a higher-order term.`;
  if (lof.state === 'none') return `No sign of lack of fit (p ${pf(lof.p)}): the model shape is consistent with the replicate scatter.`;
  if (lof.state === 'untestable-saturated') return 'Replicates exist but no degrees of freedom are left over for lack of fit: the model uses every distinct setting.';
  return 'No replicates, so lack of fit cannot be tested: add centre points.';
}
