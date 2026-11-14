// Confirmation runs: making the recommended setting again and checking that the model was right about it.
//
// A designed experiment ends in a prediction, and a prediction is only worth acting on once it has been
// tested on batches the model never saw. The check is the one Design-Expert's "Confirmation" tool makes: the
// mean of the m confirmation batches against the 95 % prediction interval for a mean of m new batches,
//
//   ŷ ± t(df) · √(SE(ŷ)² + s²/m),
//
// with SE(ŷ) the model's uncertainty at that setting and s the residual SD. Inside, the model has predicted
// something it was not fitted to; outside, it has not, and its optimum is not to be built on yet.
//
// The prediction is frozen when the confirmation runs are planned and stored with them. Fitted again after
// more results, the model would move, and a confirmation held against a prediction that moved to meet it
// confirms nothing.

import { tCritical } from './stats.js';
import { sigfig } from './diagnostics.js';

/**
 * What to store with planned confirmation runs: the setting and, per response, what the model said there.
 * @param b      a balancedOptimum() result (process designs)
 * @param o      {model, n, date}
 * @returns {{date, model, n, coded, real, predicted: {name: {mean, seMean, se, df}}}}
 */
export function confirmationPlan(b, { model = '', n = 3, date = '' } = {}) {
  const predicted = {};
  for (const g of b.used || []) {
    const iv = b.interval?.[g.name], fit = b.fits?.[g.name];
    if (!iv || !fit) continue;
    predicted[g.name] = { mean: iv.mean, seMean: iv.seMean, se: fit.se, df: iv.df };
  }
  return { date, model, n: Math.max(1, Math.round(Number(n) || 3)), coded: { ...b.coded }, real: { ...b.real }, predicted };
}

/**
 * The 95 % interval a mean of m new batches should fall in, from a stored prediction.
 * @returns {{lo, hi, half, t}|null}
 */
export function intervalForMean(pred, m, alpha = 0.05) {
  if (!pred || !Number.isFinite(pred.mean) || !(m >= 1) || pred.se == null || pred.seMean == null || !(pred.df > 0)) return null;
  const t = tCritical(pred.df, alpha);
  const half = t * Math.sqrt(pred.seMean ** 2 + pred.se ** 2 / m);
  return { lo: pred.mean - half, hi: pred.mean + half, half, t };
}

/**
 * How the confirmation runs came out against the stored prediction.
 * @param plan    confirmationPlan()
 * @param values  {responseName: [measured values of the confirmation batches]}
 * @param o       {label: (name) => text, unit: (name) => text}
 * @returns {{rows: [{name, m, mean, predicted, lo, hi, inside}], measured, inside, outside, level, sentence}}
 *   level 'ok' when every measured response is inside, 'warn' when one is not, '' when nothing is measured yet
 */
export function confirmationResult(plan, values, { label = (n) => n } = {}) {
  const rows = [];
  for (const [name, pred] of Object.entries(plan?.predicted || {})) {
    const xs = (values?.[name] || []).map(Number).filter(Number.isFinite);
    const m = xs.length;
    const mean = m ? xs.reduce((a, v) => a + v, 0) / m : null;
    const iv = m ? intervalForMean(pred, m) : intervalForMean(pred, plan.n || 1);
    rows.push({ name, m, mean, predicted: pred.mean, lo: iv?.lo ?? null, hi: iv?.hi ?? null,
      inside: m && iv ? mean >= iv.lo && mean <= iv.hi : null });
  }
  const done = rows.filter((r) => r.m && r.inside != null);
  const outside = done.filter((r) => !r.inside);
  const out = { rows, measured: done.length, inside: done.length - outside.length, outside: outside.map((r) => r.name), level: '', sentence: '' };
  const n = plan?.n || 0;
  if (!done.length) {
    out.sentence = `${n} confirmation run${n === 1 ? '' : 's'} planned at the recommended setting; each response is held against the 95 % interval for the mean of the runs, set when they were planned.`;
    return out;
  }
  const left = rows.some((r) => r.m < n) ? ` Not every run is measured yet; the interval widens to match the runs there are.` : '';
  if (!outside.length) {
    out.level = 'ok';
    out.sentence = `Confirmed: ${done.length === 1 ? 'the measured response falls' : `all ${done.length} measured responses fall`} inside the 95 % interval the model gave before the runs were made, so its optimum can be built on.${left}`;
  } else {
    out.level = 'warn';
    const say = outside.map((r) => `${label(r.name)} ${sigfig(r.mean, 3)} against ${sigfig(r.lo, 3)} to ${sigfig(r.hi, 3)}`);
    out.sentence = `Not confirmed: ${say.join('; ')}. The model was wrong about this setting, by more than the scatter of a batch explains; look for a term or a range it is missing before using the optimum.${left}`;
  }
  return out;
}
