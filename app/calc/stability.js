// How fast a formulation drifts, as a number a model can optimise.
//
// Stability is already in the app as an experiment type: timepoints, storage conditions, reminders. What it
// was not, until now, is a *response*. Size, dispersity and encapsulation each reduce to one number per
// batch and can therefore be targeted, ranked and predicted; "it held for four weeks" could not, so the
// optimiser had no way to prefer a formulation that keeps than one that drifts, and the planner could not
// tell you which factors drive drift.
//
// The number is the slope of particle size against time, from the DLS timepoints the batch already has. It
// is a rate, so it needs a unit, and there is no single right one: a four-day study and a six-month study do
// not belong on the same scale. Three bases are offered and one is chosen for you from the spacing of your
// own timepoints, which is the only thing that can decide it.

import { parseISO } from './dates.js';

export const DRIFT_BASES = [
  { id: 'auto', label: 'Chosen from the timepoints', short: 'auto' },
  { id: 'day', label: 'Per day', short: 'nm/day', per: 1 },
  { id: 'week', label: 'Per week', short: 'nm/week', per: 7 },
  { id: 'window', label: 'Over the whole observed window', short: 'nm over the window' },
];

/** Days between two ISO dates, timezone-independent because both are parsed as local midnight. */
const daysBetween = (aISO, bISO) => Math.round((parseISO(bISO) - parseISO(aISO)) / 86400000);

/** A timepoint written into the stage, as stability records carry it: T0, T3, T28. */
function stageDay(stage) {
  const m = /^T\s*(\d+(?:\.\d+)?)$/i.exec(String(stage || '').trim());
  return m ? Number(m[1]) : null;
}

/**
 * The size-over-time series for one batch, in days from its first measurement.
 * Dates are used where they exist, because they are what actually happened; a timepoint in the stage is the
 * fallback for a record entered without one.
 * @returns {Array<{day:number, nm:number, date:string, stage:string, condition:string}>}
 */
export function dlsSeries(measurements, batchId, { condition = null, test = 'dls', key = 'zave_nm' } = {}) {
  const ms = measurements.filter((m) => m.batchId === batchId && m.test === test && Number.isFinite(Number(m.values?.[key]))
    && (condition == null || (m.condition || null) === condition));
  if (!ms.length) return [];
  const dated = ms.filter((m) => m.date);
  const first = dated.length ? dated.map((m) => m.date).sort()[0] : null;
  const out = [];
  for (const m of ms) {
    const day = m.date && first ? daysBetween(first, m.date) : stageDay(m.stage);
    if (day == null || !Number.isFinite(day)) continue;
    out.push({ day, nm: Number(m.values[key]), date: m.date || '', stage: m.stage || '', condition: m.condition || '' });
  }
  return out.sort((a, b) => a.day - b.day || String(a.stage).localeCompare(String(b.stage)));
}

/**
 * Which storage condition a single drift figure should describe.
 *
 * A batch on two shelves has two drift rates, and averaging them is not a compromise, it is a third number
 * that describes neither. The accelerated shelf is the one the question is usually about, so the condition
 * with the highest temperature in its name wins; where no name carries a temperature, the condition with the
 * most timepoints does. A batch on one shelf, or none, is unaffected.
 *
 * @returns {string|null} the condition to use, or null when there is nothing to choose between
 */
export function pickCondition(series) {
  const conds = [...new Set(series.map((p) => p.condition || ''))];
  if (conds.length < 2) return null;
  const degC = (c) => { const m = /(-?\d+(?:\.\d+)?)\s*°?\s*C/i.exec(c); return m ? Number(m[1]) : null; };
  const warm = conds.filter((c) => degC(c) != null).sort((a, b) => degC(b) - degC(a));
  if (warm.length) return warm[0];
  const count = (c) => series.filter((p) => (p.condition || '') === c).length;
  return [...conds].sort((a, b) => count(b) - count(a) || String(a).localeCompare(b))[0];
}

/** Which basis the spacing of these timepoints can actually carry. */
export function autoBasis(spanDays) {
  if (!Number.isFinite(spanDays) || spanDays <= 0) return 'window';
  if (spanDays <= 10) return 'day';
  if (spanDays <= 100) return 'week';
  return 'window';
}

/**
 * The drift of particle size over time for one series.
 *
 * Least squares through every point rather than first against last: a study with five timepoints has spent
 * the money to see the shape, and taking the ends throws four fifths of it away and doubles the effect of a
 * single bad measurement at either end. The quality of that line comes back with it, because a slope through
 * scattered points is a number the user should be allowed to disbelieve.
 *
 * @param {Array<{day:number, nm:number}>} series
 * @param {'auto'|'day'|'week'|'window'} [basis]
 * @returns {{value:number, unit:string, basis:string, perDay:number, n:number, spanDays:number, r2:number,
 *            first:number, last:number, total:number}|null}
 */
export function sizeDrift(series, basis = 'auto') {
  if (!series || series.length < 2) return null;
  const days = [...new Set(series.map((p) => p.day))];
  if (days.length < 2) return null; // every point at one timepoint is not a time course

  const n = series.length;
  const mx = series.reduce((a, p) => a + p.day, 0) / n;
  const my = series.reduce((a, p) => a + p.nm, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of series) { sxy += (p.day - mx) * (p.nm - my); sxx += (p.day - mx) ** 2; syy += (p.nm - my) ** 2; }
  if (!(sxx > 0)) return null;
  const perDay = sxy / sxx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 1;

  const spanDays = Math.max(...series.map((p) => p.day)) - Math.min(...series.map((p) => p.day));
  const chosen = basis === 'auto' ? autoBasis(spanDays) : basis;
  const def = DRIFT_BASES.find((b) => b.id === chosen) || DRIFT_BASES[1];
  const value = chosen === 'window' ? perDay * spanDays : perDay * (def.per || 1);

  const firstDay = Math.min(...series.map((p) => p.day));
  const lastDay = Math.max(...series.map((p) => p.day));
  const at = (d) => my + perDay * (d - mx);

  return {
    value: Math.round(value * 1e4) / 1e4,
    unit: chosen === 'window' ? `nm over ${spanDays} day${spanDays === 1 ? '' : 's'}` : def.short,
    basis: chosen, perDay, n, spanDays, r2: Math.round(r2 * 1e4) / 1e4,
    first: at(firstDay), last: at(lastDay), total: perDay * spanDays,
  };
}

/**
 * Drift for a batch straight from the measurement store.
 * With several storage conditions and none asked for, one is chosen (see pickCondition) rather than fitting
 * one line through all of them; the chosen one comes back on the result so the screen can say which.
 */
export function batchDrift(measurements, batchId, basis = 'auto', opts = {}) {
  let series = dlsSeries(measurements, batchId, opts);
  let picked = opts.condition ?? null;
  if (picked == null) {
    picked = pickCondition(series);
    if (picked != null) series = series.filter((p) => (p.condition || '') === picked);
  }
  const d = sizeDrift(series, basis);
  return d && picked != null ? { ...d, condition: picked } : d;
}

/**
 * One sentence about a drift figure, including whether the line is worth believing.
 * A slope fitted through four points that scatter badly is not a rate, it is a shrug.
 */
export function driftNote(d) {
  if (!d) return 'Needs particle size measured at two or more timepoints.';
  const dir = d.value > 0 ? 'growing' : d.value < 0 ? 'shrinking' : 'flat';
  const trust = d.n < 3 ? 'Two timepoints give a line through two points: it cannot be wrong, and it cannot be checked either.'
    : d.r2 >= 0.8 ? 'The points sit close to that line.'
      : d.r2 >= 0.4 ? 'The points scatter around that line, so read the rate as a direction rather than a number.'
        : 'The points barely follow a line at all, so this rate is not evidence of a trend.';
  const where = d.condition ? ` at ${d.condition}` : '';
  return `${dir === 'flat' ? 'No measurable drift' : `${dir} by ${Math.abs(d.value).toFixed(2)} ${d.unit}`}${where} over ${d.spanDays} day${d.spanDays === 1 ? '' : 's'}, from ${d.n} measurements. ${trust}`;
}
