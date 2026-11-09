// When to stop asking for rounds, and which run to take forward.
//
// Expected improvement always finds something to propose, so an optimiser left to itself never says "enough".
// The screen has to, because every round costs batches. The signal is already on it: each suggestion carries
// the chance it beats the best run so far, and tests/usability/campaign.mjs calibrated that chance against
// what the next round actually gained on a simulated lab whose truth is known. Below about one in ten, another
// round of four brought a real gain about one time in six; at one in three or better, about half the time.
// Whether the latest round still raised the model's pick splits the low-odds rounds further: after a round that
// did not, the next paid off one time in eleven; after one that did, about one time in three. So the verdict
// reads both.
//
// The run to take forward is not the single best measurement. That one is the luckiest batch as much as the
// best setting: a run measured once sits a batch-to-batch scatter away from its truth, and the highest of
// twenty such runs is selected for exactly that scatter. The model's pick is the run made whose predicted
// score is highest, which averages a lucky measurement with its neighbours. In every campaign mode it was as
// good as or better than the best measured run (balanced, 16 runs: 0.921 against 0.906 true score).
import { overallDesirability } from './objective.js';
import { predictAll, sameSetting } from './acquire.js';
import { toUnit } from './space.js';

/**
 * The thresholds of the verdict. `stopBelow` and `goFrom` are chances that the best suggestion beats the best
 * run so far; `realGain` is a rise in the model's pick worth a round of batches, the same 0.01 of score the
 * benchmark counts as a real gain.
 *
 * Calibrated on the simulated lab only (tests/usability/lab.mjs), not on a real campaign. The screen says so
 * in the evidence line. They are to be set again once the historical benchmark on real data has run (spec 7.7),
 * and before the GP's noise prior is strengthened further, since a less confident model gives lower odds
 * (gp.js, NOISE_PRIOR).
 *
 * AWAITING RECALIBRATION: the harness for that is tests/usability/history.mjs (npm run history -- --db <file>
 * --campaign <experiment ids>), which replays a finished campaign with only the runs that were really made. It
 * has run on the simulated lab only (docs/history-benchmark.md); a finished historical campaign with its run
 * order is an open point for the lab, and until it has run these numbers stay as the simulated lab set them.
 */
export const STOP_RULE = { stopBelow: 0.10, goFrom: 0.35, realGain: 0.01 };

/**
 * What a round brought in the benchmark, by the best suggestion's chance to beat the best run: 150 rounds,
 * balanced mode, the standard lab, 30 campaigns (npm run campaign -- --seeds 30 --rounds 6). `real` is the
 * share of rounds that raised the true score of the model's pick by more than 0.01; `mean` the mean gain.
 */
export const BENCHMARK = [
  { from: 0, to: 0.05, rounds: 44, real: 0.14, mean: 0.004 },
  { from: 0.05, to: 0.10, rounds: 19, real: 0.21, mean: 0.005 },
  { from: 0.10, to: 0.20, rounds: 15, real: 0.27, mean: 0.009 },
  { from: 0.20, to: 0.35, rounds: 27, real: 0.30, mean: 0.010 },
  { from: 0.35, to: 1.0001, rounds: 45, real: 0.49, mean: 0.019 },
];

/**
 * The same 150 rounds by what the verdict said before each: what the sentence's evidence line quotes. The odds
 * alone left "maybe" and "go" indistinguishable (38 % against 37 %) when a rise in the pick could make a round
 * "go"; letting it lift a low-odds round only as far as "maybe" is what separates the three.
 */
export const LEVELS = {
  stop: { rounds: 43, real: 0.09, mean: 0.003 },
  maybe: { rounds: 62, real: 0.29, mean: 0.009 },
  go: { rounds: 45, real: 0.49, mean: 0.019 },
};

/** How many of the runs were made at this setting, the run itself included. */
export const timesRun = (point, observed, space) => observed.filter((o) => sameSetting(o.point, point, space)).length;

/** The predicted overall score at a setting: the surface's means pushed through the goals, zero past a hard limit. */
function predictedScore(models, space, goals, constraints, point) {
  const u = toUnit(point, space);
  if (!u.every(Number.isFinite)) return null;
  const predicted = predictAll(models, u);
  const means = Object.fromEntries(Object.entries(predicted).map(([k, v]) => [k, v.mean]));
  const ok = constraints.every((c) => (c.op === '<' ? means[c.name] < c.value : means[c.name] > c.value));
  return { predicted, predictedD: ok ? overallDesirability(means, goals).D : 0 };
}

/**
 * The model's pick, and what the latest round did for it.
 *
 * A round is an experiment (a date stands in for a run recorded without one), and the latest is the one whose
 * newest run is newest. Its effect is measured with the current surface on both sides: the pick among every
 * run against the pick among the runs before it. Comparing with the pick an earlier fit made would mix what
 * the round found with what the refit changed its mind about.
 *
 * @param {object} a {observed:[{point, values, batchId, label, experimentId, date}], models, space, goals, constraints,
 *   feasible: optional test a run's setting must pass to be taken forward, such as its recipe fitting the mixture}
 * @returns {null | {batchId, label, point, values, predicted, predictedD, measuredD, runs:[batchId], lastRound}}
 */
export function modelsPick({ observed, models, space, goals, constraints = [], feasible = null }) {
  if (!models?.length || !observed?.length) return null;
  const scored = [];
  observed.forEach((o, i) => {
    if (feasible && !feasible(o.point)) return;
    const s = predictedScore(models, space, goals, constraints, o.point);
    if (s) scored.push({ ...o, ...s, order: i });
  });
  if (!scored.length) return null;
  const top = (xs) => xs.reduce((b, x) => (!b || x.predictedD > b.predictedD ? x : b), null);
  const pick = top(scored);

  const roundOf = (o) => o.experimentId || o.date || '';
  const latest = {};
  for (const o of scored) {
    const k = roundOf(o), d = String(o.date || '');
    if (!latest[k] || d > latest[k].date || (d === latest[k].date && o.order > latest[k].order)) latest[k] = { date: d, order: o.order };
  }
  const keys = Object.keys(latest);
  let lastRound = null;
  if (keys.length > 1) {
    const last = keys.reduce((a, b) => (latest[b].date > latest[a].date || (latest[b].date === latest[a].date && latest[b].order > latest[a].order) ? b : a));
    const before = top(scored.filter((o) => roundOf(o) !== last));
    lastRound = { id: last, n: scored.filter((o) => roundOf(o) === last).length, gain: pick.predictedD - before.predictedD,
      before: { batchId: before.batchId, predictedD: before.predictedD } };
  }
  const same = observed.filter((o) => sameSetting(o.point, pick.point, space));
  return { batchId: pick.batchId, label: pick.label, point: { ...pick.point }, values: pick.values, predicted: pick.predicted,
    predictedD: pick.predictedD, measuredD: overallDesirability(pick.values || {}, goals).D, runs: same.map((o) => o.batchId), lastRound };
}

// A Monte Carlo estimate of zero is not a proof of zero, nor one of a hundred a certainty.
const chanceText = (p) => (p < 0.005 ? 'less than a 1 % chance' : p > 0.995 ? 'more than a 99 % chance'
  : `${p < STOP_RULE.stopBelow ? 'only ' : ''}a ${Math.round(p * 100)} % chance`);

/**
 * Whether another round is worth its batches, in one sentence, with the number it rests on.
 *
 * Three answers. "stop" when the best suggestion has under one chance in ten of beating the best run and the
 * latest runs did not raise the model's pick: in the benchmark the next round then paid about one time in
 * eleven, so a few batches spent confirming the best candidates buy more. "go" when the chance is one in three
 * or better, where a round paid about half the time. "maybe" in between, and for a low-odds round after one
 * that still raised the pick, because a search that is still moving has not converged whatever the odds of any
 * one suggestion; those rounds paid about one time in three.
 *
 * @param {object} a {pBeats: the best suggestion's chance to beat the best run, gain: what the latest round
 *   added to the model's pick (null when there is only one round), q: suggestions in the round,
 *   confirmBatches: what confirming the best candidates costs (0 when they are confirmed already)}
 */
export function roundVerdict({ pBeats, gain = null, q = 4, confirmBatches = 0, trust = [], blocked = [] }) {
  if (!Number.isFinite(pBeats) && !blocked.length) return null;
  // Limits or goals that cannot be met outrank everything: the chance of beating the best run is a chance of
  // beating a score that cannot be reached, and "the best candidates are confirmed" would send the person to
  // confirm a run that scores zero (usability: PDI below 0.001 read "Stop here ... take the model's pick forward").
  if (blocked.length) {
    return { level: 'blocked', stop: false, blocked: true, sentence: `Fix the goals or limits first: ${blocked.join(' ')} As set, no setting can meet them, so there is no round to judge.`,
      evidence: '', pBeats: Number.isFinite(pBeats) ? pBeats : null, gain: Number.isFinite(gain) ? gain : null };
  }
  // A model that predicts worse than the average, or only weakly, cannot say whether another round pays: its
  // "chance of beating your best run" is the chance by its own reckoning. One wild result is enough to cause
  // it, and it must not end a campaign ("Stop here" at 6 % with Q2 -0.99), nor read ">99 %" as a promise.
  if (trust.length) {
    const what = trust.map((t) => t.text).join('; ');
    const odds = `by its own reckoning the best of ${q > 1 ? `these ${q}` : 'the suggestion'} has ${chanceText(pBeats)} of beating your best run`;
    return { level: 'unsure', stop: false, untrusted: true,
      sentence: `The model cannot say yet whether another round pays: ${what}. ${odds[0].toUpperCase() + odds.slice(1)}; treat them as a space-filling plan, not predictions.`,
      // no benchmark line: its rounds were all fitted by a model that predicted held-out runs
      evidence: '', pBeats, gain: Number.isFinite(gain) ? gain : null };
  }
  const rose = Number.isFinite(gain) && gain >= STOP_RULE.realGain;
  const flat = Number.isFinite(gain) && !rose;
  const level = pBeats >= STOP_RULE.goFrom ? 'go' : pBeats < STOP_RULE.stopBelow && !rose ? 'stop' : 'maybe';
  const best = q > 1 ? `the best of these ${q} suggestions` : 'the suggestion';
  const odds = `${best} has ${chanceText(pBeats)} of beating your best run`;
  const stalled = flat ? `your latest runs did not raise the model's pick` : '';
  const raised = rose ? `your latest runs raised the model's pick by ${gain.toFixed(2)}` : '';
  let sentence;
  if (level === 'stop') {
    sentence = confirmBatches > 0
      ? `Stop here and confirm the best candidates instead (${confirmBatches} batch${confirmBatches === 1 ? '' : 'es'}): ${odds}${stalled ? `, and ${stalled}` : ''}.`
      : `Stop here: ${odds}${stalled ? `, ${stalled}` : ''}, and the best candidates are confirmed already, so take the model's pick forward.`;
  } else if (level === 'go') {
    sentence = `Another round is worth its batches: ${odds}${raised ? `, and ${raised}` : ''}.`;
  } else if (rose) {
    sentence = `Another round may still pay: ${raised}, though ${odds}.`;
  } else {
    sentence = `Another round may still pay, though the gains are getting small: ${odds}${stalled ? `, and ${stalled}` : ''}.`;
  }
  const seen = LEVELS[level];
  const evidence = `On the app's simulated-lab benchmark, ${Math.round(seen.real * 100)} % of ${seen.rounds} rounds in this situation improved the result by more than 0.01.`;
  return { level, stop: level === 'stop', sentence, evidence, pBeats, gain: Number.isFinite(gain) ? gain : null };
}

/**
 * Which goals' models are not good enough to rest a verdict on: trust 'none' (worse than the average, or too few
 * groups to test), or 'weak' with a Q² below 0. `responses` are the report's per-response results, `names` the goals the
 * suggestions were made for.
 * @returns {{name:string, level:string, text:string}[]}
 */
export function trustIssues(responses, names) {
  const out = [];
  for (const r of responses || []) {
    if (names && !names.includes(r.name) || r.skipped) continue;
    const level = r.trust?.level;
    const q = r.best?.q2;
    // 'none' is worse than the average (or untestable); 'weak' with Q² below 0 is the same on values and only
    // ranks settings. A weak model with Q² of 0 or more captures something, so it can still carry a verdict
    // (and on the benchmark, where every round is its own experiment, requiring more would end every stop).
    if (!(level === 'none' || (level === 'weak' && Number.isFinite(q) && q < 0))) continue;
    const label = r.label || r.name;
    const qText = Number.isFinite(q) ? ` (Q² ${q.toFixed(2)})` : '';
    out.push({ name: r.name, level, text: Number.isFinite(q) ? `${label} is predicted worse than the average${qText}` : `${label} could not be tested yet` });
  }
  return out;
}

/** Whether most of the suggested runs have under one chance in twenty of beating the best run so far. */
export const mostlyLongShots = (picks) => !!picks?.length && picks.filter((p) => (p.pBeatsBest ?? 0) < 0.05).length > picks.length / 2;

/** The run already made at this setting, if any: a suggestion that is an exact repeat is a repeat, not a new setting. */
export const repeatOf = (point, observed, space) => (observed || []).find((o) => sameSetting(o.point, point, space)) || null;
