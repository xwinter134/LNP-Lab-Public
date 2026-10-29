// The numbers behind the DoE diagnostic plots.
//
// Everything here is read off the fit the app already computes: ols() returns residuals, fitted values,
// leverage, standard errors and t statistics, so none of this is new modelling, only new ways of looking at
// the same fit. Keeping it out of the screen means the plots can be tested without a browser, and the two
// cannot drift apart.
//
// What the plots are for, in one line each, because that is the part usually left out:
//   Pareto        which terms are large relative to their own error; the line is where significance starts
//   residuals     a fit is only as good as its leftovers: structure here means the model is wrong, not noisy
//   normal plot   the p values above assume normal residuals; this is where you find out
//   observed vs predicted   the plainest statement of how well the model does on the runs it was given
//   surface       what the model actually claims, including where it claims it outside your design
//   effect lines  the shape of one factor, and whether another factor changes that shape (an interaction)
//
// And two more readings of the same fit, in words: what drives each response, and whether to believe the fit
// at all (fitVerdict, at the end of this file), which reads the plots above so the screen can lead with a
// sentence and fold the pictures behind it.

import { tTestP, fTestP } from './stats.js';
import { toReal, isCategorical, categoricalName } from './doe.js';

/** Two-sided critical t by bisection on the p value: exact enough, and avoids a second special function. */
export function tCritical(df, alpha = 0.05) {
  if (!(df > 0)) return null;
  let lo = 0, hi = 100;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (tTestP(mid, df) > alpha) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Terms ranked by how big they are against their own standard error.
 * The intercept is dropped: it is the grand mean, not an effect, and leaving it in dwarfs everything else.
 */
export function paretoEffects(fit, terms, alpha = 0.05) {
  if (!fit?.beta) return { effects: [], tCrit: null };
  const df = fit.n - fit.p;
  const effects = terms.map((t, i) => ({
    name: t.name, coef: fit.beta[i], t: fit.tValues?.[i] ?? null, p: fit.pValues?.[i] ?? null,
    abs: Math.abs(fit.tValues?.[i] ?? 0),
  })).filter((e) => e.name !== 'Intercept').sort((a, b) => b.abs - a.abs);
  const tCrit = tCritical(df, alpha);
  for (const e of effects) e.significant = tCrit != null && e.abs >= tCrit;
  return { effects, tCrit, df };
}

/**
 * One point per run: what the model predicted, what was measured, and the difference.
 * The studentised residual divides by the error that *this* run's position in the design allows it, so a
 * corner run and a centre run become comparable; without it a high-leverage point always looks well fitted.
 */
export function residualPoints(fit, rows) {
  if (!fit?.beta || !fit.residuals?.length) return [];
  return rows.map((r, i) => {
    const h = fit.leverage?.[i] ?? 0;
    const denom = fit.se != null && h < 1 ? fit.se * Math.sqrt(1 - h) : null;
    return {
      label: r.label, fitted: fit.yhat[i], measured: fit.yhat[i] + fit.residuals[i], resid: fit.residuals[i],
      student: denom ? fit.residuals[i] / denom : null, leverage: h, pointType: r.pointType || '',
    };
  });
}

// Acklam's rational approximation to the inverse normal CDF; |error| < 1.15e-9, which is far below anything a
// plotted point can show.
export function invNorm(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Sorted residuals against the normal quantiles they would have if they were normal.
 * Blom's plotting position (i - 3/8)/(n + 1/4): the usual choice, and it keeps the end points off the edge
 * of the plot where (i)/(n) would push them to infinity.
 */
export function qqPoints(residuals) {
  const v = residuals.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const n = v.length;
  if (n < 3) return [];
  return v.map((y, i) => ({ theoretical: invNorm((i + 1 - 0.375) / (n + 0.25)), sample: y }));
}

/** A straight line through the normal plot, fitted on the middle half so the tails do not set its slope. */
export function qqLine(points) {
  if (points.length < 4) return null;
  const mid = points.slice(Math.floor(points.length * 0.25), Math.ceil(points.length * 0.75));
  const mx = mid.reduce((s, p) => s + p.theoretical, 0) / mid.length;
  const my = mid.reduce((s, p) => s + p.sample, 0) / mid.length;
  let sxy = 0, sxx = 0;
  for (const p of mid) { sxy += (p.theoretical - mx) * (p.sample - my); sxx += (p.theoretical - mx) ** 2; }
  return sxx > 0 ? { slope: sxy / sxx, intercept: my - (sxy / sxx) * mx } : null;
}

/** Predict from the fitted model at a coded point. */
export const predictAt = (fit, terms, coded) => terms.reduce((s, t, i) => s + t.f(coded) * fit.beta[i], 0);

/**
 * The fitted surface over two factors, on a grid in coded units.
 *
 * The other factors are held at the centre unless `base` says otherwise, and that is worth saying out loud on
 * the screen: a contour is a slice, and a slice taken somewhere else can look nothing like this one.
 */
export function surfaceGrid(fit, terms, names, { a = 0, b = 1, base = {}, steps = 25 } = {}) {
  if (!fit?.beta || names.length < 2) return null;
  const na = names[a], nb = names[b];
  const at = (i) => -1 + (2 * i) / (steps - 1);
  const z = [];
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < steps; j++) {
    const row = [];
    for (let i = 0; i < steps; i++) {
      const c = {};
      for (const n of names) c[n] = base[n] ?? 0;
      c[na] = at(i); c[nb] = at(j);
      const v = predictAt(fit, terms, c);
      row.push(v); if (v < lo) lo = v; if (v > hi) hi = v;
    }
    z.push(row);
  }
  return { z, lo, hi, steps, a: na, b: nb };
}

/**
 * One line per level of a second factor, showing how the first factor behaves.
 * With `against` null it is a main-effect plot; with a second factor it is an interaction plot, and parallel
 * lines are the picture of "no interaction".
 */
export function effectLines(fit, terms, names, factor, against = null, { steps = 21, base = {}, levels: given = null } = {}) {
  if (!fit?.beta) return [];
  // `levels` for a split factor that has no middle (a mixer: −1 and +1, calc/doe.js isCategorical)
  const levels = against ? given || [-1, 0, 1] : [0];
  return levels.map((lv) => ({
    level: lv,
    points: Array.from({ length: steps }, (_, i) => {
      const x = -1 + (2 * i) / (steps - 1);
      const c = {};
      for (const n of names) c[n] = base[n] ?? 0;
      c[factor] = x; if (against) c[against] = lv;
      return { x, y: predictAt(fit, terms, c) };
    }),
  }));
}

/**
 * Cox response trace: the mixture equivalent of a main-effects plot.
 *
 * A main-effects plot moves one factor and holds the rest, which on a simplex is impossible — raising one
 * lipid has to lower the others. Cox's answer is to move one component along the line from a reference blend
 * toward its own vertex, letting the others fall in proportion to where they already are. Every point on that
 * line is a blend that sums correctly, and the slope at the reference is the honest answer to "what does this
 * lipid do here".
 *
 * Two things have to be right or the plot is worse than nothing:
 *
 *   The reference blend must be inside the region. The centre of the simplex is not: with PEG held between
 *   1 and 2 mol% the equal-parts blend puts it at thirteen, a composition no one would make.
 *
 *   The line must stop at the bounds. Run it to the vertex instead and the far end of every trace is the
 *   model extrapolating to blends the design never went near, which is what sends the axis to a value no
 *   particle size could take.
 *
 * Returned in pseudo-components, with the real mol% carried alongside. x runs -1 to 1: 0 is the reference
 * blend, ±1 the ends of what the mol% ranges allow along this direction.
 *
 * @param {object} fit     a fitted Scheffe model
 * @param {Array} terms    its terms
 * @param {Array} comps    [{name, lo, hi}] in column order
 * @param {object} [o] {total, base, steps, reference} reference is the blend to trace from, in mol%;
 *                     base holds any process factors at their centre
 */
export function blendTrace(fit, terms, comps, { total = 100, base = {}, steps = 25, reference = null } = {}) {
  if (!fit?.beta || comps.length < 2) return [];
  const q = comps.length;
  const lows = comps.map((x) => Number(x.lo) || 0);
  const highs = comps.map((x) => (Number.isFinite(Number(x.hi)) ? Number(x.hi) : total));
  const room = total - lows.reduce((a, b) => a + b, 0);
  if (!(room > 0)) return [];

  // The reference in pseudo-components, defaulting to the centre of the simplex when none is given (which is
  // the right answer only when no upper bound bites).
  const c = reference && reference.length === q
    ? reference.map((v, i) => (Number(v) - lows[i]) / room)
    : new Array(q).fill(1 / q);
  const cap = comps.map((_, i) => (highs[i] - lows[i]) / room);
  if (c.some((v, i) => !(v >= -1e-9 && v <= cap[i] + 1e-9))) return [];

  return comps.map((comp, i) => {
    // u_i = s, and u_j = c_j (1-s)/(1-c_i) for the rest, which keeps the sum at one and passes through the
    // reference at s = c_i. Feasible while s <= cap_i and every other component stays under its own cap.
    let sMin = 0, sMax = Math.min(1, cap[i]);
    comps.forEach((_, j) => {
      if (j === i || c[j] <= 1e-12) return;
      sMin = Math.max(sMin, 1 - (cap[j] * (1 - c[i])) / c[j]);
    });
    const lo = Math.min(Math.max(sMin, 0), c[i]), hi = Math.max(Math.min(sMax, 1), c[i]);
    if (!(hi - lo > 1e-9)) return { name: comp.name, points: [] };
    return {
      name: comp.name,
      from: lows[i] + lo * room,
      to: lows[i] + hi * room,
      points: Array.from({ length: steps }, (_, k) => {
        const t = -1 + (2 * k) / (steps - 1);
        const s = t >= 0 ? c[i] + t * (hi - c[i]) : c[i] + t * (c[i] - lo);
        const rest = (1 - s) / (1 - c[i]);
        const x = { ...base };
        comps.forEach((cj, j) => { x[cj.name] = j === i ? s : c[j] * rest; });
        return { x: t, y: predictAt(fit, terms, x), mol: lows[i] + s * room };
      }),
    };
  }).filter((l) => l.points.length);
}

/* ---------------- what drives each response, in words ---------------- */

/**
 * A number for reading rather than for a column: whole numbers whole, anything else to `n` significant
 * figures with the trailing zeros off — "target 80", "63 mL/min", "PDI 0.064". A column of one quantity can
 * keep its fixed decimals so it lines up; a number read on its own should not carry digits nobody measured.
 * `sign` writes the + of a change as well as the −, because "12 nm" on its own does not say which way.
 * `maxDp` caps the decimals where the instrument stops: a PDI is read to three, so 0.0912 is 0.091.
 */
export function sigfig(x, n = 3, { sign = false, maxDp = 6 } = {}) {
  if (x == null || x === '' || !Number.isFinite(Number(x))) return '–';
  const v = Number(x), a = Math.abs(v);
  const dp = a === 0 ? 0 : Math.max(0, Math.min(maxDp, n - 1 - Math.floor(Math.log10(a))));
  // round first, so that a value which rounds to nothing reads 0 rather than "-0" or "+0"
  const r = Number(v.toFixed(dp));
  if (r === 0) return '0';
  return `${r < 0 ? '−' : sign ? '+' : ''}${Math.abs(r).toLocaleString('en-US', { maximumFractionDigits: dp })}`;
}

/**
 * The process-model reading of a fit: every term in the Pareto's order (|t|), sorted into main effects,
 * interactions and curvature, with each main effect turned into the change it makes across the range that was
 * run, low to high with the other factors at their centre. That change is twice the coded coefficient (a
 * coefficient is per half range), and it is the number a formulator can use without decoding anything: going
 * from 1 to 2.5 mol% PEG takes 25 nm off. Squared terms are symmetric and interactions vanish with the other
 * factors at their centre, so neither alters it.
 *
 * @param fit      an ols() fit
 * @param terms    its terms, each with `kind` and `of` (boxTerms in balance.js)
 * @param factors  the spec's factors [{name, unit, low, high, center}]
 */
export function processDrivers(fit, terms, factors, { alpha = 0.05 } = {}) {
  if (!fit?.beta) return null;
  const { effects, tCrit, df } = paretoEffects(fit, terms, alpha);
  const termOf = Object.fromEntries(terms.map((t) => [t.name, t]));
  const factorOf = Object.fromEntries(factors.map((f) => [f.name, f]));
  const out = { kind: 'process', alpha, df, tCrit, main: [], interactions: [], curvature: [] };
  for (const e of effects) {
    const t = termOf[e.name];
    if (t?.kind === 'main') {
      const f = factorOf[t.of[0]];
      out.main.push({ ...e, factor: t.of[0], change: 2 * e.coef, from: f ? toReal(f, -1) : -1, to: f ? toReal(f, 1) : 1, unit: f?.unit || '',
        // a mixer goes "from KNAUER IJM 1 to KNAUER IJM 3", not from −1 to 1
        ...(isCategorical(f) ? { fromText: categoricalName(f, -1), toText: categoricalName(f, 1) } : {}) });
    } else if (t?.kind === 'interaction') out.interactions.push({ ...e, factors: t.of });
    else if (t?.kind === 'square') out.curvature.push({ ...e, factor: t.of[0] });
  }
  return out;
}

/**
 * The blend reading of a fit. A Scheffé coefficient is the predicted response at a corner of the region, not
 * an effect, so testing it against zero says nothing: every one of them "passes". What a lipid does is read off
 * its Cox trace instead, the same lines as the "What each lipid does" plot: from the least to the most of that
 * lipid the region allows, the others falling in proportion. A process factor in a crossed design is read
 * across its range at the reference blend. The terms whose test does mean something are the pairwise blending
 * terms: whether two lipids together beat or miss the straight average of the two.
 *
 * @param comps  [{name, lo, hi}] in column order
 * @param o      {total, reference (mol%, the blend to read from), factors (the process factors), alpha}
 */
export function blendDrivers(fit, terms, comps, { total = 100, reference = null, factors = [], alpha = 0.05 } = {}) {
  if (!fit?.beta) return null;
  const base = Object.fromEntries(factors.map((f) => [f.name, 0]));
  const lipids = blendTrace(fit, terms, comps, { total, base, reference }).map((l) => ({
    factor: l.name, lipid: true, change: l.points[l.points.length - 1].y - l.points[0].y, from: l.from, to: l.to, unit: 'mol%' }));
  const lows = comps.map((c) => Number(c.lo) || 0);
  const room = total - lows.reduce((a, b) => a + b, 0);
  const ref = reference && reference.length === comps.length && room > 0
    ? Object.fromEntries(comps.map((c, i) => [c.name, (Number(reference[i]) - lows[i]) / room]))
    : Object.fromEntries(comps.map((c) => [c.name, 1 / comps.length]));
  const at = (name, v) => predictAt(fit, terms, { ...ref, ...base, [name]: v });
  const process = factors.map((f) => ({ factor: f.name, change: at(f.name, 1) - at(f.name, -1), from: toReal(f, -1), to: toReal(f, 1), unit: f.unit || '' }));
  const df = fit.n - fit.p;
  const tCrit = tCritical(df, alpha);
  const pairs = new Map();
  comps.forEach((a, i) => comps.slice(i + 1).forEach((b) => pairs.set(`${a.name}·${b.name}`, [a.name, b.name])));
  const blending = terms.map((t, i) => (pairs.has(t.name) ? {
    name: t.name, factors: pairs.get(t.name), coef: fit.beta[i], t: fit.tValues?.[i] ?? null, p: fit.pValues?.[i] ?? null,
    significant: tCrit != null && Math.abs(fit.tValues?.[i] ?? 0) >= tCrit,
  } : null)).filter(Boolean).sort((a, b) => Math.abs(b.t ?? 0) - Math.abs(a.t ?? 0));
  // With no test to rank them by, the size of the change does it: a trace and a process effect are both in the
  // response's own units over the region that was run, so they compare directly.
  const main = [...lipids, ...process].sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  return { kind: 'blend', alpha, df, tCrit, main, blending };
}

/**
 * One sentence per response, from processDrivers() or blendDrivers(): what moves it, which way and by how much,
 * strongest first; what matters less; what has no clear effect; interactions and curvature. It is the
 * coefficient table and the Pareto said the way a formulator would say them, so it is only ever as good as the
 * fit, and the screen prints the predicted R² beside it for that reason.
 *
 * Built here rather than in the screen so the wording can be tested without a browser. `label` is used as
 * given (the screen passes a link); `term` formats a factor or lipid name and `text` escapes free text (units).
 * `maxDp` stops a change at the decimals the response is measured to, so a small one reads 0.003, not 0.0029.
 */
export function driverSentence(label, d, { unit = '', term = (s) => s, text = (s) => s, maxDp = 6 } = {}) {
  if (!d) return `${label}: no fit.`;
  const blend = d.kind === 'blend';
  if (!blend && d.tCrit == null) return `${label}: no residual degrees of freedom are left, so no term can be told apart from noise.`;
  // A change in EE (%) is in percentage points; "−3 %" would read as three per cent of the value.
  const u = unit === '%' ? ' points' : unit ? ` ${text(unit)}` : '';
  const size = (v) => `${sigfig(v, 2, { sign: true, maxDp })}${u}`;
  const range = (e) => (e.fromText != null ? `${text(e.fromText)} to ${text(e.toText)}` : `${sigfig(e.from)} to ${sigfig(e.to)}${e.unit ? ` ${text(e.unit)}` : ''}`);
  const list = (xs, and = 'and') => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${and} ${xs[xs.length - 1]}`);
  const name = (e) => (e.lipid ? `more ${term(e.factor)}` : term(e.factor));

  // A blend's changes carry no test, so all of them count and only their size decides.
  const counted = blend ? d.main.filter((e) => Number.isFinite(e.change)) : d.main.filter((e) => e.significant);
  const top = Math.max(0, ...counted.map((e) => Math.abs(e.change)));
  // Under a third of the strongest a change is real but not where to look first.
  const strong = top > 0 ? counted.filter((e) => Math.abs(e.change) >= top / 3) : [];
  const weak = counted.filter((e) => !strong.includes(e));
  const clauses = [];
  if (strong.length) {
    const falls = strong.filter((e) => e.change < 0), rises = strong.filter((e) => e.change > 0);
    const groups = (strong[0].change < 0 ? [['falls', falls], ['rises', rises]] : [['rises', rises], ['falls', falls]]).filter(([, xs]) => xs.length);
    clauses.push(`${label} ${groups.map(([verb, xs]) => `${verb} with ${list(xs.map((e) => `${name(e)} (${size(e.change)} from ${range(e)})`))}`).join(' and ')}`);
  }
  if (weak.length) clauses.push(`${list(weak.map(name))} matter${weak.length === 1 ? 's' : ''} less (${weak.map((e) => size(e.change)).join(', ')})`);
  const quiet = blend ? [] : d.main.filter((e) => !e.significant);
  if (quiet.length && counted.length) clauses.push(`no clear effect of ${list(quiet.map(name), 'or')}`);
  const pairs = (blend ? d.blending : d.interactions).filter((e) => e.significant);
  if (pairs.length) {
    const who = pairs.length === 1 ? pairs[0].factors.map(term).join(' and ') : list(pairs.map((e) => e.factors.map(term).join(blend ? ' · ' : ' × ')));
    clauses.push(`${who} ${blend ? 'blend non-linearly' : 'interact'}`);
  }
  const curved = blend ? [] : d.curvature.filter((e) => e.significant);
  if (curved.length) clauses.push(`curvature in ${list(curved.map((e) => term(e.factor)))}`);
  if (!counted.length) {
    clauses.unshift(clauses.length ? `${label}: no main effect stands out` : `${label}: nothing in the ranges run moves it clearly (no term passes p < ${d.alpha ?? 0.05})`);
  }
  return `${clauses.join('; ')}.`;
}

/* ---------------- is this fit any good, in one sentence ---------------- */

// The thresholds a statistician would use, and why each is where it is.
//
// The shape checks (funnel, curvature, normality) are screening tests run on every fit of every response, so
// they sit at p < 0.01: at 0.05 the three together would call about one clean fit in seven suspect, and a
// verdict that cries wolf on that many screens is a verdict nobody reads. Lack of fit is the one formal test
// of the set and keeps its conventional 0.05.
//
// A run "stands out" when its residual is larger than chance allows across all the runs, not merely larger
// than 2: with 18 runs, one beyond ±2 SD turns up in about half of all perfectly good fits. The test is the
// externally studentised residual against a Bonferroni limit (p < 0.05 shared over the runs), the outlier test
// most DoE software uses. A run between ±2 and that limit is still named, softly, because the residual plot
// marks it and the reader will wonder.
//
// Predicted R² is held to the usual rule: within 0.2 of adjusted R², and 0.5 or more before its numbers are
// read as more than a lead (the same 0.5 the "What drives each response" card warns at).
export const VERDICT_LIMITS = { shapeAlpha: 0.01, lofAlpha: 0.05, outlierAlpha: 0.05, minShapeDf: 4, minNormalDf: 8, gap: 0.2, weakQ2: 0.5 };

const pText = (p) => (p < 0.001 ? '< 0.001' : sigfig(p, 2));
// R² to two decimals as the rest of the screen writes it, so 0.80 is not "0.8" here and 0.80 beside it
const r2Text = (v) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`;
const listOf = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Average ranks (1-based), ties sharing the mean of the ranks they span. */
function ranks(v) {
  const order = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(v.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) out[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

function corr(x, y) {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Two-sided p of a correlation coefficient on n points, through its t statistic on n − 2 df. */
function corrP(r, n) {
  if (r == null || n < 4) return null;
  if (Math.abs(r) >= 1) return 0;
  return tTestP(r * Math.sqrt((n - 2) / (1 - r * r)), n - 2);
}

/**
 * The externally studentised residual (R-student): the residual scaled by the error estimated without that
 * run, so a wild run cannot hide by inflating the very error it is measured against. From the internally
 * studentised r on df = n − p: t = r·√((df − 1)/(df − r²)), which follows t on df − 1 when nothing is wrong.
 */
export function externalStudent(r, df) {
  if (r == null || !(df > 1)) return null;
  const room = df - r * r;
  return room > 1e-12 ? r * Math.sqrt((df - 1) / room) : Math.sign(r) * Infinity;
}

/**
 * The Ryan–Joiner limit for the correlation of a normal plot: below it the points bend away from a straight
 * line more than normal residuals would (Ryan & Joiner 1976, in the polynomial form Minitab publishes). It is
 * the normal-plot reading of a Shapiro–Wilk test and agrees with it closely, without Royston's coefficients.
 * Given for alpha 0.10, 0.05 and 0.01.
 */
export function normalPlotLimit(n, alpha = 0.05) {
  if (!(n >= 4)) return null;
  const s = Math.sqrt(n);
  if (alpha >= 0.1) return 1.0071 - 0.1371 / s - 0.3682 / n + 0.7780 / (n * n);
  if (alpha >= 0.05) return 1.0063 - 0.1288 / s - 0.6118 / n + 1.3505 / (n * n);
  return 0.9963 - 0.0211 / s - 1.4106 / n + 3.1791 / (n * n);
}

/** The normal plot as one number: how straight it is, the correlation of its points (Blom positions). */
export function normalPlotCorrelation(residuals) {
  const pts = qqPoints(residuals);
  return pts.length < 4 ? null : corr(pts.map((p) => p.theoretical), pts.map((p) => p.sample));
}

/**
 * Lack of fit against pure error. Runs made at the same setting (centre replicates, mostly) say how far apart
 * two batches land when nothing is changed; if the model misses the runs by much more than that, it is missing
 * something, not merely noisy. Needs a repeated setting and a degree of freedom left over for the misfit.
 *
 * @param fit   an ols() fit
 * @param keys  one key per run in fit order; equal keys are the same setting
 */
export function lackOfFit(fit, keys) {
  if (!fit?.beta || !keys?.length || keys.length !== fit.residuals.length) return null;
  const y = fit.residuals.map((e, i) => fit.yhat[i] + e);
  const groups = new Map();
  keys.forEach((k, i) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(y[i]); });
  let ssPe = 0, dfPe = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const m = g.reduce((a, b) => a + b, 0) / g.length;
    ssPe += g.reduce((a, b) => a + (b - m) ** 2, 0);
    dfPe += g.length - 1;
  }
  const sse = fit.residuals.reduce((a, e) => a + e * e, 0);
  const dfLof = fit.n - fit.p - dfPe;
  if (!(dfPe >= 1) || !(dfLof >= 1)) return null;
  const ssLof = Math.max(0, sse - ssPe);
  // Replicates that agree exactly leave no error to compare with, and any misfit at all would then count as
  // "significant": a statement about the replicates, not the model, so it is not made.
  if (!(ssPe > 1e-12 * sse)) return { dfLof, dfPe, ssLof, ssPe, F: null, p: null };
  const F = (ssLof / dfLof) / (ssPe / dfPe);
  return { dfLof, dfPe, ssLof, ssPe, F, p: fTestP(F, dfLof, dfPe) };
}

/** A setting as a key: equal settings give equal keys, whatever order the factors are listed in. */
export function settingKey(setting) {
  if (setting == null) return '';
  if (typeof setting !== 'object') return String(setting);
  return Object.keys(setting).sort().map((k) => `${k}=${Number.isFinite(Number(setting[k])) ? Number(setting[k]).toFixed(6) : setting[k]}`).join('|');
}

/**
 * Whether to believe a fit, in one sentence, with the evidence behind it.
 *
 * It reads the fit the way a statistician reads the diagnostic plots, in the order that decides what to do
 * next: a run that does not belong first, because it distorts everything after it; then lack of fit against
 * the replicates; then whether the model predicts a run it has not seen at all; then the shape of the
 * residuals; then normality, which the p values assume; and last the runs the fit leans on.
 *
 *   outlier     a run the residual plot marks (studentised beyond ±2) whose externally studentised residual
 *               also passes the Bonferroni limit (see VERDICT_LIMITS); only possible from five residual df
 *   lackOfFit   F of the misfit against pure error from repeated settings, p < 0.05
 *   noSignal    predicted R² < 0: a run left out is predicted worse than by the plain average
 *   overfit     predicted R² under 0.5 and more than 0.2 below an adjusted R² of 0.5 or more. The advice is to
 *               read only the terms past the line rather than to drop to a smaller model: a response with
 *               real curvature and too few runs is overfitted by the quadratic and lacks fit without it, and
 *               sending the reader from one to the other helps nobody
 *   curvature   the residuals regressed on (fitted − mean)², with its linear part taken out first: the smile
 *               or frown the eye looks for on the plot. Conservative against Ramsey's RESET, which projects
 *               the square off every model column rather than two, and it needs no design matrix.
 *   funnel      Spearman correlation of |studentised residual| with the fitted value (a rank Glejser test)
 *   weak        predicted R² from 0 to 0.5 without the gap that makes it overfitting
 *   normality   Ryan–Joiner: the normal plot of the studentised residuals less straight than its 1 % limit;
 *               not reported beside an outlier, a missing term or a funnel, which then bend the plot
 *   leverage    a run above 2p/n, or fitted exactly (≥ 0.99): its residual checks nothing (a note, not a fault:
 *               in a complete design no run reaches 2p/n, so this means runs are missing)
 *
 * The shape checks need residual degrees of freedom to mean anything; below minShapeDf they are skipped and
 * the sentence says so rather than calling the residuals shapeless. Normality waits for minNormalDf (below).
 *
 * Checked by simulation, 2,000 fits each. On clean data (normal noise, the right model) a face-centred CCD
 * of 18 runs reads sound 90 % of the time, a 2^3 + 3 centre factorial 94 %, a 2^4 + 4 one 86 % and a 2^2 + 3
 * one 87 %; the misses are mostly the outlier and lack-of-fit tests at their nominal 5 %. Pure noise is called
 * out more than nine times in ten. A missing square is caught a quarter to all of the time, mostly by lack of
 * fit, so it needs replicates. A run shifted by seven SD at a corner is caught a third to seven tenths of the
 * time: a corner's leverage pulls the fit onto it and hides part of its own error, which no residual can show.
 *
 * @param fit   an ols() or fitMixture() fit
 * @param runs  [{label, setting}] in fit order: what to call each run, and its setting (an object of coded
 *              values, or a key) for finding the replicates
 * @param o     {fuller}: the model to suggest when a term is missing, as the words after "try" ("the quadratic
 *              model"); without it the advice is general
 * @returns {{level: 'sound'|'note'|'warn', sentence: string, plot: string, flags: Array, checks: object}}
 *   `plot` names the picture that shows the problem (a data-fig name: 'residuals', 'normal-plot', 'effects',
 *   'measured-vs-predicted'); measured against predicted when all is well. Each flag has {kind, level, plot,
 *   say (its own sentence), short (a phrase for a list)}, in the order above.
 */
export function fitVerdict(fit, runs = [], { fuller = null, limits = {} } = {}) {
  const L = { ...VERDICT_LIMITS, ...limits };
  if (!fit?.beta || !fit.residuals?.length) {
    return { level: 'warn', sentence: 'No fit to judge.', plot: 'measured-vs-predicted', flags: [], checks: {} };
  }
  const n = fit.n, p = fit.p, df = n - p;
  const label = (i) => runs[i]?.label || `run ${i + 1}`;
  if (!(df > 0) || fit.se == null) {
    return { level: 'warn', sentence: 'No residual degrees of freedom are left: every run went into the model, so nothing can say whether it is any good.', plot: 'measured-vs-predicted', flags: [], checks: { n, p, df } };
  }
  const pts = residualPoints(fit, fit.residuals.map((_, i) => ({ label: label(i) })));
  const flags = [];
  const checks = { n, p, df };

  // ---- runs that stand out
  // Only a run the residual plot marks (beyond ±2) can be called out, and an internally studentised residual
  // cannot pass √df, so with four residual df or fewer no run can stand out and none is said not to.
  const outlierTestable = df > 4;
  const limit = outlierTestable ? tCritical(df - 1, L.outlierAlpha / n) : null;
  const rs = pts.map((q) => ({ label: q.label, r: q.student, t: externalStudent(q.student, df), h: q.leverage }));
  const outliers = outlierTestable ? rs.filter((x) => x.t != null && Math.abs(x.r) > 2 && Math.abs(x.t) > limit) : [];
  const mild = rs.filter((x) => x.r != null && Math.abs(x.r) > 2 && !outliers.includes(x));
  checks.outliers = { tested: outlierTestable, limit, runs: outliers.map((x) => x.label) };
  checks.mild = mild.map((x) => x.label);
  if (outliers.length) {
    const one = outliers.length === 1, who = listOf(outliers.map((x) => x.label));
    flags.push({ kind: 'outlier', level: 'warn', plot: 'residuals', runs: outliers.map((x) => x.label),
      say: `Check ${who}: ${one ? 'its residual is' : 'their residuals are'} ${listOf(outliers.map((x) => sigfig(x.r, 2)))} SD, more than chance allows in ${n} runs; look at ${one ? 'its' : 'their'} batch record and measurement before trusting the optimum.`,
      short: `${who} stand${one ? 's' : ''} out (${listOf(outliers.map((x) => sigfig(x.r, 2)))} SD)` });
  }

  // ---- lack of fit against the replicates
  const lof = runs.length === n ? lackOfFit(fit, runs.map((r) => settingKey(r?.setting))) : null;
  checks.lackOfFit = lof;
  if (lof?.p != null && lof.p < L.lofAlpha) {
    flags.push({ kind: 'lackOfFit', level: 'warn', plot: 'residuals',
      say: `The model misses something real: it is further from the runs than the replicates are from each other (lack of fit p ${pText(lof.p)}); ${fuller ? `try ${fuller}` : 'a term is missing, or the response wants a transform'}.`,
      short: `lack of fit (p ${pText(lof.p)})` });
  }

  // ---- prediction: nothing to find, or more terms than the runs can carry
  const q2 = Number.isFinite(fit.predR2) ? fit.predR2 : null, adj = fit.adjR2;
  checks.predR2 = q2; checks.adjR2 = adj;
  if (q2 != null && q2 < L.weakQ2) {
    if (adj != null && adj >= L.weakQ2 && adj - q2 > L.gap) {
      flags.push({ kind: 'overfit', level: 'warn', plot: 'effects',
        say: `Too many terms for ${n} runs: the model fits its own runs (adjusted R² ${r2Text(adj)}) far better than one left out (predicted R² ${r2Text(q2)}); trust only the terms past the line, and its predictions only roughly.`,
        short: `predicted R² ${r2Text(q2)} against adjusted ${r2Text(adj)}` });
    } else if (q2 < 0) {
      flags.push({ kind: 'noSignal', level: 'warn', plot: 'measured-vs-predicted',
        say: `The model predicts a run left out worse than the plain average would (predicted R² ${r2Text(q2)}): nothing in the ranges run moves this response more than the batch-to-batch scatter does.`,
        short: `predicts worse than the average (predicted R² ${r2Text(q2)})` });
    } else {
      flags.push({ kind: 'weak', level: 'warn', plot: 'measured-vs-predicted',
        say: `The fit is weak (predicted R² ${r2Text(q2)}): it can rank settings, but its numbers are a lead to check, not a finding.`,
        short: `weak (predicted R² ${r2Text(q2)})` });
    }
  }

  // ---- the shape of the residuals
  const shapeTestable = df >= L.minShapeDf && n >= 6;
  checks.shapeTested = shapeTestable;
  if (shapeTestable) {
    // curvature: the residuals on the square of the centred fitted value, with its straight-line part removed
    // (the residuals are already orthogonal to a constant and to the fitted value, so only the bend is left)
    const f = pts.map((q) => q.fitted), e = fit.residuals;
    const fm = f.reduce((a, b) => a + b, 0) / n;
    const z = f.map((v) => (v - fm) ** 2);
    const zm = z.reduce((a, b) => a + b, 0) / n;
    const sff = f.reduce((a, v) => a + (v - fm) ** 2, 0);
    const bz = sff > 0 ? f.reduce((a, v, i) => a + (v - fm) * (z[i] - zm), 0) / sff : 0;
    const zc = z.map((v, i) => v - zm - bz * (f[i] - fm));
    const szz = zc.reduce((a, v) => a + v * v, 0);
    const sse = e.reduce((a, v) => a + v * v, 0);
    if (szz > 1e-12 * z.reduce((a, v) => a + v * v, 0) && sse > 0) {
      const ez = e.reduce((a, v, i) => a + v * zc[i], 0);
      const g = ez / szz;
      const s2 = (sse - g * ez) / (df - 1);
      const t = s2 > 0 ? g / Math.sqrt(s2 / szz) : Math.sign(g) * Infinity;
      const pc = Number.isFinite(t) ? tTestP(t, df - 1) : 0;
      checks.curvature = { t, p: pc };
      if (pc != null && pc < L.shapeAlpha) {
        flags.push({ kind: 'curvature', level: 'warn', plot: 'residuals',
          say: `The residuals bend against the fitted values (p ${pText(pc)}): the model is missing a term; ${fuller ? `try ${fuller}` : 'a transform of the response, such as its log, may straighten them'}.`,
          short: `residuals bend (p ${pText(pc)})` });
      }
    }
    // funnel: does the size of a residual follow the fitted value?
    const use = pts.filter((q) => Number.isFinite(q.student));
    if (use.length >= 6) {
      const rho = corr(ranks(use.map((q) => Math.abs(q.student))), ranks(use.map((q) => q.fitted)));
      const pf = corrP(rho, use.length);
      checks.funnel = { rho, p: pf };
      if (pf != null && pf < L.shapeAlpha) {
        const grows = rho > 0;
        flags.push({ kind: 'funnel', level: 'warn', plot: 'residuals',
          say: `The scatter ${grows ? 'grows' : 'shrinks'} with the value (the residuals fan ${grows ? 'out' : 'in'}, p ${pText(pf)}), so the ${grows ? 'high' : 'low'} end is less certain than the p values say.`,
          short: `scatter ${grows ? 'grows' : 'shrinks'} with the value (p ${pText(pf)})` });
      }
    }
    // Normality, on the studentised residuals so that a corner run and a centre run are on one scale. The
    // residuals of a fit are n numbers carrying only df independent ones, and when df is small they come in
    // look-alike sets (in a 2^3 factorial with its interactions every corner's residual is the same ± size),
    // which a normal plot reads as two clumps. Simulated on a clean 2^3 + 3 centre fit, four residual df
    // failed the 1 % limit a third of the time; from eight it holds its level, so below eight it is not run.
    // Nor is it reported beside a fault already found: an outlier, a missing term or a funnel bends the
    // normal plot too, and "not normal" would only be the same finding read off a second picture.
    const rNorm = df >= L.minNormalDf ? normalPlotCorrelation(use.map((q) => q.student)) : null;
    const crit = normalPlotLimit(use.length, L.shapeAlpha);
    checks.normality = { r: rNorm, limit: crit };
    const explained = flags.some((x) => ['outlier', 'lackOfFit', 'curvature', 'funnel'].includes(x.kind));
    if (rNorm != null && crit != null && rNorm < crit && !explained) {
      flags.push({ kind: 'normality', level: 'warn', plot: 'normal-plot',
        say: 'The residuals are not normal (the normal plot bends away from its line), so the p values are only approximate.',
        short: `residuals not normal (normal-plot r ${sigfig(rNorm, 2)})` });
    }
  }

  // ---- runs the fit leans on
  const levLimit = Math.min(0.99, (2 * p) / n);
  const heavy = rs.filter((x) => x.h > levLimit + 1e-9);
  checks.leverage = { limit: levLimit, runs: heavy.map((x) => x.label) };
  if (heavy.length) {
    const one = heavy.length === 1;
    flags.push({ kind: 'leverage', level: 'note', plot: 'measured-vs-predicted', runs: heavy.map((x) => x.label),
      say: `The fit leans on ${listOf(heavy.map((x) => `${x.label} (leverage ${sigfig(x.h, 2)})`))}: ${one ? 'its residual checks' : 'their residuals check'} little, and a second batch there would steady the model.`,
      short: `leans on ${listOf(heavy.map((x) => x.label))} (leverage ${listOf(heavy.map((x) => sigfig(x.h, 2)))})` });
  }

  const ORDER = ['outlier', 'lackOfFit', 'noSignal', 'overfit', 'curvature', 'funnel', 'weak', 'normality', 'leverage'];
  flags.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const warn = flags.filter((x) => x.level === 'warn');
  if (warn.length) return { level: 'warn', sentence: warn[0].say, plot: warn[0].plot, flags, checks };

  // Nothing wrong: say what was checked, so that "sound" is a finding and not the absence of one.
  const seen = [
    ...(shapeTestable ? ['residuals shapeless'] : []),
    ...(outlierTestable && !mild.length ? ['no run stands out'] : []),
    ...(lof?.p != null ? ['no lack of fit'] : []),
    q2 != null ? `predicted R² ${r2Text(q2)}` : `R² ${r2Text(fit.r2)}`,
  ];
  const chance = mild.length
    ? `; ${listOf(mild.map((x) => x.label))} ${mild.length === 1 ? 'sits' : 'sit'} at ${listOf(mild.map((x) => sigfig(x.r, 2)))} SD, as one run in twenty does by chance`
    : '';
  const head = shapeTestable ? 'The fit looks sound' : `The fit looks sound as far as ${df} residual df can show`;
  const lean = flags.find((x) => x.kind === 'leverage');
  return {
    level: lean ? 'note' : 'sound',
    sentence: `${head}: ${seen.join(', ')}${chance}${lean ? `, but ${lean.say.charAt(0).toLowerCase()}${lean.say.slice(1)}` : '.'}`,
    plot: 'measured-vs-predicted', flags, checks,
  };
}
