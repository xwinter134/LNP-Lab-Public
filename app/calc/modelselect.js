// Which model to fit: the fit summary, automatic term selection and the Box-Cox check.
//
// A design is planned for a model, but whether the data support it is a question only the data can answer. Three
// tools answer it, as Design-Expert's Fit Summary, model reduction and Box-Cox plot do:
//
//   fitSummary   the linear, two-factor-interaction and quadratic models side by side: what each order adds over
//                the one below it (the sequential F test), whether it still misses the replicates (lack of fit),
//                and how well it predicts a run it has not seen (predicted R²). The suggestion is the highest
//                order that adds something real and that the design can carry.
//   reduceTerms  backward elimination on AICc from the chosen model, keeping it hierarchical: a main effect stays
//                while an interaction or square containing it does. AICc rather than p values, because it weighs
//                fit against size in one number, and its small-sample correction matters at twenty runs.
//   boxCox       whether the response wants a power transform (a log, a square root) to make its scatter even;
//                said as advice, with the interval of λ the data allow.
//
// All three are for the process model over a box. A Scheffé blend has no hierarchy of orders to step through in
// the same way, and its terms are not removed one at a time without changing what the others mean.

import { ols, fTestP } from './stats.js';
import { boxTerms } from './balance.js';
import { lackOfFit, settingKey } from './diagnostics.js';

export const MODEL_ORDERS = ['linear', 'interaction', 'quadratic'];

/** The model value the screen offers for the reduced model; the design's own models are those in MODEL_TYPES. */
export const REDUCED = 'reduced';

const sse = (fit) => fit.residuals.reduce((a, e) => a + e * e, 0);

/**
 * The three model orders compared on one response.
 * @param rows   [{coded, y}] the measured runs, in any order
 * @param names  the factor names
 * @param o      {levels: how many levels the design has per factor (a 2-level design cannot carry squares), alpha}
 * @returns {{rows: [{model, terms, aliased, why, seqF, seqDf, seqP, lofP, r2, adjR2, predR2, se}], suggested, why}}
 */
export function fitSummary(rows, names, { levels = 3, alpha = 0.05 } = {}) {
  const y = rows.map((r) => r.y), n = y.length;
  const mean = y.reduce((a, v) => a + v, 0) / n;
  let prev = { sse: y.reduce((a, v) => a + (v - mean) ** 2, 0), df: n - 1 };
  const keys = rows.map((r) => settingKey(r.coded));
  const out = [];
  for (const model of MODEL_ORDERS) {
    const terms = boxTerms(names, model);
    const row = { model, terms: terms.length, aliased: false };
    if (model === 'quadratic' && levels < 3) { out.push({ ...row, aliased: true, why: 'a two-level design cannot fit squares' }); continue; }
    if (model === 'interaction' && names.length < 2) { out.push({ ...row, aliased: true, why: 'one factor has no interactions' }); continue; }
    if (n <= terms.length) { out.push({ ...row, aliased: true, why: `needs more than ${terms.length} runs, ${n} measured` }); continue; }
    const fit = ols(rows.map((r) => terms.map((t) => t.f(r.coded))), y);
    if (!fit?.beta) { out.push({ ...row, aliased: true, why: 'the runs cannot separate these terms (aliased)' }); continue; }
    const s = sse(fit), df = n - fit.p, dfAdd = prev.df - df;
    const seqF = dfAdd > 0 && df > 0 && s > 0 ? ((prev.sse - s) / dfAdd) / (s / df) : null;
    const lof = lackOfFit(fit, keys);
    out.push({ ...row, seqF, seqDf: [dfAdd, df], seqP: seqF == null ? null : fTestP(seqF, dfAdd, df), lofP: lof?.p ?? null,
      r2: fit.r2, adjR2: fit.adjR2, predR2: fit.predR2, se: fit.se });
    prev = { sse: s, df };
  }
  // the highest order whose added terms pass the sequential test; the one below if nothing above linear does
  const usable = out.filter((r) => !r.aliased);
  let suggested = null, why = '';
  for (const r of usable) if (r.seqP != null && r.seqP < alpha) suggested = r.model;
  if (!suggested) {
    suggested = usable[0]?.model || null;
    why = suggested ? 'no model order adds a term that passes p < 0.05; the simplest is suggested, and nothing in the ranges run may move this response' : 'no model can be fitted yet';
  } else {
    const s = out.find((r) => r.model === suggested);
    why = `the highest order whose added terms pass the sequential F test (p ${s.seqP < 0.001 ? '< 0.001' : s.seqP.toFixed(3)})${s.lofP != null && s.lofP < alpha ? ', though it still lacks fit: a term or a transform is missing' : ''}`;
  }
  // A block of added terms can fail its test as a block while one term in it is real (one interaction of three):
  // the higher order then predicts better, and the reduced model is the way to keep that term alone.
  const base = out.find((r) => r.model === suggested);
  const better = base?.predR2 != null ? usable.filter((r) => MODEL_ORDERS.indexOf(r.model) > MODEL_ORDERS.indexOf(suggested) && r.predR2 != null && r.predR2 > base.predR2 + 0.02)
    .sort((a, b) => b.predR2 - a.predR2)[0] || null : null;
  return { rows: out, suggested, why, better: better ? { model: better.model, predR2: better.predR2 } : null };
}

/** AICc of a fit: n ln(SSE/n) + 2k + 2k(k + 1)/(n − k − 1), with k the coefficients plus the error variance. */
export function aicc(fit) {
  const n = fit.n, k = fit.p + 1;
  const s = sse(fit);
  if (!(n - k - 1 > 0) || !(s > 0)) return null;
  return n * Math.log(s / n) + 2 * k + (2 * k * (k + 1)) / (n - k - 1);
}

/**
 * Backward elimination on AICc, hierarchical.
 *
 * Start from every term of `terms`, and at each step remove the one term whose removal lowers AICc most, among
 * the terms that may go: never the intercept, and a main effect only once no interaction or square containing
 * it is left. Stop when no removal lowers AICc. Hierarchy matters because a coded model without it changes
 * meaning when the coding changes: a model with FRR² but no FRR says the curve is centred exactly where the
 * centre point was put.
 *
 * @param rows   [{coded, y}]
 * @param terms  boxTerms() of the model to start from (each with kind and of)
 * @returns {{terms, removed: [{name, aicc}], aicc, start}} terms in their original order
 */
export function reduceTerms(rows, terms) {
  const y = rows.map((r) => r.y);
  const fitOf = (ts) => (rows.length > ts.length ? ols(rows.map((r) => ts.map((t) => t.f(r.coded))), y) : null);
  let keep = terms.slice();
  let fit = fitOf(keep);
  let score = fit?.beta ? aicc(fit) : null;
  const start = score;
  const removed = [];
  if (score == null) return { terms: keep, removed, aicc: null, start };
  for (;;) {
    const may = keep.filter((t) => t.kind !== 'intercept'
      && !(t.kind === 'main' && keep.some((u) => u !== t && u.kind !== 'main' && u.of.includes(t.of[0]))));
    let best = null;
    for (const t of may) {
      const f = fitOf(keep.filter((u) => u !== t));
      const a = f?.beta ? aicc(f) : null;
      if (a != null && (!best || a < best.a)) best = { t, a };
    }
    if (!best || !(best.a < score - 1e-9)) break;
    keep = keep.filter((u) => u !== best.t);
    removed.push({ name: best.t.name, aicc: best.a });
    score = best.a;
  }
  return { terms: keep, removed, aicc: score, start };
}

/**
 * The terms to fit for each response, for the model chosen on the screen: the design's model as it is, or with
 * REDUCED that model reduced response by response (each response keeps the terms it needs, as Design-Expert
 * reduces each one on its own).
 * @param spec  process spec
 * @param runs  design runs {run_id, coded}
 * @param vals  {run_id: {response: value}}
 * @param model 'linear' | 'interaction' | 'quadratic' | REDUCED
 * @returns {{full: terms, of: {name: {terms, removed}}}}
 */
export function termsForResponses(spec, runs, vals, model) {
  const names = (spec.factors || []).map((f) => f.name);
  const base = model === REDUCED ? spec.model : model;
  const full = boxTerms(names, base);
  const of = {};
  for (const r of spec.responses || []) {
    if (model !== REDUCED) { of[r.name] = { terms: full, removed: [] }; continue; }
    const rows = runs.filter((x) => Number.isFinite(vals[x.run_id]?.[r.name])).map((x) => ({ coded: x.coded, y: vals[x.run_id][r.name] }));
    const red = reduceTerms(rows, full);
    of[r.name] = { terms: red.terms, removed: red.removed };
  }
  return { full, of };
}

/**
 * The Box-Cox profile: for each λ the log likelihood of the model fitted to the transformed response, scaled
 * by the geometric mean so that likelihoods at different λ compare. The best λ, the 95 % interval of λ
 * (where the log likelihood is within χ²₁(0.95)/2 = 1.92 of its peak), and the advice: no transform when λ = 1
 * is inside the interval, otherwise the plainest power inside it (log for 0, square root for 0.5, inverse for −1).
 *
 * Only for a response that is positive everywhere. With a ratio of largest to smallest under 3 a power transform
 * barely bends the data, which the advice says rather than recommend one.
 *
 * @param X  the model's regressor rows
 * @param y  the response
 * @returns {{lambda, ci: [lo, hi], advice: {lambda, name}|null, ratio, curve: [{lambda, ll}]}|null}
 */
export function boxCox(X, y, { from = -3, to = 3, step = 0.05 } = {}) {
  if (!y.length || y.some((v) => !(v > 0))) return null;
  const n = y.length;
  const lgm = y.reduce((a, v) => a + Math.log(v), 0) / n, gm = Math.exp(lgm);
  const curve = [];
  for (let l = from; l <= to + 1e-9; l += step) {
    const lam = Math.round(l * 1000) / 1000 + 0; // + 0: no −0
    const w = y.map((v) => (Math.abs(lam) < 1e-9 ? gm * Math.log(v) : (v ** lam - 1) / (lam * gm ** (lam - 1))));
    const fit = ols(X, w);
    if (!fit?.beta) return null;
    const s = sse(fit);
    if (!(s > 0)) return null;
    curve.push({ lambda: lam, ll: (-n / 2) * Math.log(s / n) });
  }
  const top = curve.reduce((a, c) => (c.ll > a.ll ? c : a));
  const inside = curve.filter((c) => c.ll >= top.ll - 1.92);
  const ci = [inside[0].lambda, inside[inside.length - 1].lambda];
  // the interval reaching both ends of the grid: the data cannot tell one power from another
  const open = ci[0] <= from + 1e-9 && ci[1] >= to - 1e-9;
  const ratio = Math.max(...y) / Math.min(...y);
  const named = [[1, 'none'], [0.5, 'square root'], [0, 'log'], [-0.5, 'inverse square root'], [-1, 'inverse'], [2, 'square'], [-2, 'inverse square'], [3, 'cube'], [-3, 'inverse cube']];
  let advice = null;
  if (ci[0] <= 1 && ci[1] >= 1) advice = { lambda: 1, name: 'none' };
  else {
    const fits = named.filter(([l]) => l >= ci[0] - 1e-9 && l <= ci[1] + 1e-9).sort((a, b) => Math.abs(a[0] - top.lambda) - Math.abs(b[0] - top.lambda));
    advice = fits.length ? { lambda: fits[0][0], name: fits[0][1] } : { lambda: top.lambda, name: `power ${top.lambda}` };
  }
  return { lambda: top.lambda, ci, open, advice, ratio, curve };
}
