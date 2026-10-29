// When to stop asking for rounds, and which run to take forward (app/calc/ml/stopping.js): the verdict's
// thresholds and sentences, the model's pick against a lucky single measurement, what the latest round did for
// that pick, and the confirmation runs offered in place of another round.
import test from 'node:test';
import assert from 'node:assert/strict';
import { roundVerdict, modelsPick, timesRun, STOP_RULE, BENCHMARK, LEVELS } from '../app/calc/ml/stopping.js';
import { confirmAdvice, sameSetting } from '../app/calc/ml/acquire.js';
import { analyse } from '../app/calc/ml/optimizer.js';
import { mulberry32 } from '../app/calc/ml/linalg.js';

// A surface that knows the truth, standing in for a fitted model, so the pick is checked against a known
// answer: y = 1 − (a − 0.6)², best at a = 0.6, and the goal maps y straight onto the score.
const space = [{ key: 'a', name: 'A', lo: 0, hi: 1, step: 0.01 }];
const truth = (a) => 1 - (a - 0.6) ** 2;
const models = [{ name: 'y', yMean: 0, ySd: 1, gp: { predict: (u) => ({ mean: truth(u[0]), sd: 0.02 }) } }];
const goals = [{ name: 'y', goal: 'maximize', worst: 0, best: 1, weight: 1, on: true }];
const run = (batchId, a, y, experimentId, date) => ({ batchId, point: { a }, values: { y }, experimentId, date });

test('the verdict says stop below one chance in ten when the latest runs did not move the pick, with its number', () => {
  const v = roundVerdict({ pBeats: 0.03, gain: 0.002, q: 4, confirmBatches: 3 });
  assert.equal(v.level, 'stop');
  assert.equal(v.stop, true);
  assert.equal(v.sentence, "Stop here and confirm the best candidates instead (3 batches): the best of these 4 suggestions has only a 3 % chance of beating your best run, and your latest runs did not raise the model's pick.");
  assert.equal(v.evidence, "On the app's simulated-lab benchmark, 9 % of 43 rounds in this situation improved the result by more than 0.01.", 'the benchmark it rests on');
  // with only one round on record there is no progress to report, and the odds alone decide
  assert.equal(roundVerdict({ pBeats: 0.03, gain: null, q: 4, confirmBatches: 1 }).sentence,
    'Stop here and confirm the best candidates instead (1 batch): the best of these 4 suggestions has only a 3 % chance of beating your best run.');
  // a Monte Carlo estimate of zero is not a proof of zero
  assert.match(roundVerdict({ pBeats: 0, gain: 0, q: 4, confirmBatches: 3 }).sentence, /has less than a 1 % chance of beating/);
  // nothing left to confirm: the pick goes forward as it is
  assert.equal(roundVerdict({ pBeats: 0.04, gain: 0, q: 4, confirmBatches: 0 }).sentence,
    "Stop here: the best of these 4 suggestions has only a 4 % chance of beating your best run, your latest runs did not raise the model's pick, and the best candidates are confirmed already, so take the model's pick forward.");
});

test('the verdict says a round is worth it at good odds, and may still pay while the latest runs raise the pick', () => {
  const odds = roundVerdict({ pBeats: 0.48, gain: 0, q: 4, confirmBatches: 3 });
  assert.equal(odds.level, 'go');
  assert.equal(odds.sentence, 'Another round is worth its batches: the best of these 4 suggestions has a 48 % chance of beating your best run.');
  assert.match(odds.evidence, /49 % of 45 rounds/);
  assert.equal(roundVerdict({ pBeats: 0.48, gain: 0.021, q: 4 }).sentence,
    "Another round is worth its batches: the best of these 4 suggestions has a 48 % chance of beating your best run, and your latest runs raised the model's pick by 0.02.");
  const moving = roundVerdict({ pBeats: 0.04, gain: 0.032, q: 4, confirmBatches: 3 });
  assert.equal(moving.level, 'maybe', 'a search that is still moving has not converged, whatever the odds of one suggestion');
  assert.equal(moving.sentence, "Another round may still pay: your latest runs raised the model's pick by 0.03, though the best of these 4 suggestions has only a 4 % chance of beating your best run.");
  assert.match(moving.evidence, /29 % of 62 rounds/);
  const between = roundVerdict({ pBeats: 0.22, gain: 0.004, q: 3 });
  assert.equal(between.level, 'maybe');
  assert.match(between.sentence, /^Another round may still pay, though the gains are getting small: the best of these 3 suggestions has a 22 % chance/);
  assert.match(roundVerdict({ pBeats: 0.5, q: 1 }).sentence, /the suggestion has a 50 % chance/, 'one suggestion is not "the best of 1"');
  assert.match(roundVerdict({ pBeats: 1, q: 4 }).sentence, /has more than a 99 % chance of beating/, 'nor is every simulated outcome a certainty');
  assert.equal(roundVerdict({ pBeats: NaN }), null);
});

test('the thresholds sit where the benchmark puts them, and the boundaries fall on the side of another round', () => {
  assert.deepEqual(STOP_RULE, { stopBelow: 0.10, goFrom: 0.35, realGain: 0.01 });
  assert.equal(roundVerdict({ pBeats: 0.0999, gain: 0 }).level, 'stop');
  assert.equal(roundVerdict({ pBeats: 0.10, gain: 0 }).level, 'maybe');
  assert.equal(roundVerdict({ pBeats: 0.3499, gain: 0 }).level, 'maybe');
  assert.equal(roundVerdict({ pBeats: 0.35, gain: 0 }).level, 'go');
  assert.equal(roundVerdict({ pBeats: 0.05, gain: 0.01 }).level, 'maybe');
  assert.equal(roundVerdict({ pBeats: 0.05, gain: 0.0099 }).level, 'stop');
  // the bands cover every chance once, and below the stop line a round paid off about one time in six
  for (let p = 0; p <= 1; p += 0.01) assert.equal(BENCHMARK.filter((b) => p >= b.from && p < b.to).length, 1, `one band for ${p}`);
  const low = BENCHMARK.filter((b) => b.to <= STOP_RULE.stopBelow + 1e-9);
  const share = low.reduce((s, b) => s + b.real * b.rounds, 0) / low.reduce((s, b) => s + b.rounds, 0);
  assert.ok(share > 0.12 && share < 0.2, `rounds below the stop line paid ${share.toFixed(2)} of the time`);
  // and the three answers are three different situations, each paying off more often than the one before
  assert.ok(LEVELS.stop.real < LEVELS.maybe.real && LEVELS.maybe.real < LEVELS.go.real);
  assert.equal(LEVELS.stop.rounds + LEVELS.maybe.rounds + LEVELS.go.rounds, 150);
});

test('the model’s pick is the run the surface rates best, not the luckiest measurement', () => {
  const observed = [
    run('E1-F1', 0.1, 0.74, 'E1', '2026-01-05'), run('E1-F2', 0.3, 1.0, 'E1', '2026-01-05'), // measured 1.0, truly 0.91
    run('E1-F3', 0.9, 0.9, 'E1', '2026-01-06'), run('E2-F1', 0.62, 0.97, 'E2', '2026-02-02'), run('E2-F2', 0.45, 0.96, 'E2', '2026-02-02'),
  ];
  const pick = modelsPick({ observed, models, space, goals });
  assert.equal(pick.batchId, 'E2-F1', 'the run nearest the true best, although E1-F2 measured higher');
  assert.ok(Math.abs(pick.predictedD - truth(0.62)) < 1e-12);
  assert.equal(pick.measuredD, 0.97);
  assert.deepEqual(pick.runs, ['E2-F1'], 'made once');
  // the latest round, E2, raised the pick from E2-F2's rival in E1 (E1-F2 or E1-F3, both 0.91) to E2-F1
  assert.equal(pick.lastRound.id, 'E2');
  assert.equal(pick.lastRound.n, 2);
  assert.ok(Math.abs(pick.lastRound.gain - (truth(0.62) - truth(0.3))) < 1e-12, `gain ${pick.lastRound.gain}`);

  // a round that only repeats the pick does not raise it, and the repeat is counted
  const repeat = [...observed, run('E3-F1', 0.62, 0.93, 'E3', '2026-03-01')];
  const again = modelsPick({ observed: repeat, models, space, goals });
  assert.equal(again.batchId, 'E2-F1');
  assert.deepEqual(again.runs, ['E2-F1', 'E3-F1']);
  assert.equal(again.lastRound.id, 'E3');
  assert.equal(again.lastRound.gain, 0);
  assert.equal(timesRun({ a: 0.62 }, repeat, space), 2);

  // one experiment is one round: there is nothing to compare with yet
  assert.equal(modelsPick({ observed: observed.map((o) => ({ ...o, experimentId: 'E1' })), models, space, goals }).lastRound, null);
  // the latest round is the one with the newest run, wherever it sits in the list
  const shuffled = [observed[3], observed[0], observed[4], observed[1], observed[2]];
  assert.equal(modelsPick({ observed: shuffled, models, space, goals }).lastRound.id, 'E2');
  // a run predicted past a hard limit scores nothing
  const limited = modelsPick({ observed, models, space, goals, constraints: [{ name: 'y', op: '<', value: 0.99 }] });
  assert.equal(limited.batchId, 'E2-F2', 'E2-F1 is predicted at 0.9996, past the limit of 0.99');
  assert.equal(modelsPick({ observed: [], models, space, goals }), null);
  assert.equal(modelsPick({ observed, models: [], space, goals }), null);
});

test('confirming the best candidates: one repeat of the pick and the optimum twice, until each has two results', () => {
  const observed = [
    run('E1-F1', 0.1, 0.74, 'E1', '2026-01-05'), run('E1-F2', 0.3, 1.0, 'E1', '2026-01-05'), run('E1-F3', 0.9, 0.9, 'E1', '2026-01-06'),
    run('E2-F1', 0.55, 0.97, 'E2', '2026-02-02'), run('E2-F2', 0.45, 0.96, 'E2', '2026-02-02'), run('E2-F3', 0.75, 0.97, 'E2', '2026-02-03'),
  ];
  const pick = modelsPick({ observed, models, space, goals });
  assert.equal(pick.batchId, 'E2-F1');
  const optimum = { point: { a: 0.6 }, desirability: 1, predicted: { y: { mean: 1, sd: 0.02 } } };
  const bestRun = observed[1];
  const c = confirmAdvice(observed, space, bestRun, { pick, optimum });
  assert.equal(c.batches, 3);
  assert.deepEqual(c.runs.map((r) => [r.kind, r.copies]), [['pick', 1], ['optimum', 2]]);
  assert.deepEqual(c.point, { a: 0.55 }, 'the first run offered is the repeat of the pick, as the button names it');
  assert.equal(c.reason, "Confirm before you take a setting forward, 3 batches: a repeat of E2-F1 (the model's pick) and the predicted optimum made twice. Then each candidate has two results, and the model's pick on everything measured is the one to keep. E1-F2, the best single result, was made once, and the model rates its setting lower than E2-F1's.");

  // made: the pick repeated and the optimum twice, there is nothing left to confirm
  const done = [...observed, run('E3-F1', 0.55, 0.95, 'E3', '2026-03-01'), run('E3-F2', 0.6, 0.99, 'E3', '2026-03-01'), run('E3-F3', 0.6, 1.0, 'E3', '2026-03-01')];
  assert.equal(confirmAdvice(done, space, bestRun, { pick: modelsPick({ observed: done, models, space, goals }), optimum }), null);
  // an optimum the surface rates no higher than the pick settles nothing
  const flat = confirmAdvice(observed, space, bestRun, { pick, optimum: { ...optimum, desirability: pick.predictedD } });
  assert.deepEqual(flat.runs.map((r) => r.kind), ['pick']);
  assert.equal(flat.batches, 1);
  // without a pick the advice is the old one: a repeat of the best run, until it has one
  const old = confirmAdvice(observed, space, bestRun);
  assert.equal(old.batchId, 'E1-F2');
  assert.match(old.reason, /never been repeated/);
  assert.ok(sameSetting({ a: 0.3 }, { a: 0.1 + 0.2 }, space), 'the same recipe, whatever the floating point made of it');
  assert.ok(!sameSetting({ a: 0.3 }, { a: 0.305 }, space), 'a setting one step away is a neighbour, not a repeat');
});

test('the screen’s report carries the pick and the verdict once there are suggestions', () => {
  // Two experiments on a smooth surface in two factors, the second one nearer the top.
  const rnd = mulberry32(9);
  const sp = [{ key: 'frr', lo: 2, hi: 6, step: 0.1 }, { key: 'tfr', lo: 20, hi: 150, step: 1 }];
  const ee = (f) => 70 + 25 * Math.exp(-((f.frr - 4) ** 2) / 1.5 - ((f.tfr - 100) / 60) ** 2);
  const rows = Array.from({ length: 16 }, (_, i) => {
    const late = i >= 10;
    const f = late ? { frr: 3.2 + rnd() * 1.6, tfr: 70 + rnd() * 60 } : { frr: 2 + rnd() * 4, tfr: 20 + rnd() * 130 };
    const factors = { frr: Math.round(f.frr * 10) / 10, tfr: Math.round(f.tfr) };
    return { batchId: `B${i + 1}`, experimentId: late ? 'E2' : 'E1', date: late ? '2026-02-01' : '2026-01-01', factors, values: { encapsulation_efficiency: ee(factors) + (rnd() - 0.5) } };
  });
  const out = analyse({ rows, space: sp, goals: [{ name: 'encapsulation_efficiency', goal: 'maximize', worst: 70, best: 96, weight: 1, on: true }], q: 2, seed: 3 });
  assert.ok(out.suggestions?.picks?.length, 'suggestions were made');
  assert.ok(rows.some((r) => r.batchId === out.pick.batchId), 'the pick is a run that was made');
  assert.equal(out.pick.lastRound.id, 'E2');
  assert.ok(['stop', 'maybe', 'go'].includes(out.verdict.level));
  assert.match(out.verdict.sentence, /chance of beating your best run/);
  assert.equal(out.verdict.pBeats, Math.max(...out.suggestions.picks.map((p) => p.pBeatsBest)));
  if (out.suggestions.confirm) assert.ok(out.suggestions.confirm.runs.some((r) => r.kind === 'pick' && r.batchId === out.pick.batchId), 'the confirmation is about the pick');
});

test('a run one step from the pick is a neighbour, not a repeat: the pick measured once is offered its repeat', () => {
  // Benchmark seed 18: the pick (FRR 3.8, 76 mL/min) and the best run (3.8, 77) were counted as one recipe "made
  // twice", no repeat was offered, and the verdict said the best candidates were confirmed already. A replicate is
  // an exact match, as it is to the noise estimate (dataset.js, replicateGroups).
  const sp = [{ key: 'frr', lo: 2, hi: 5, step: 0.1 }, { key: 'tfr', lo: 40, hi: 140, step: 1 }];
  const peak = (u) => 1 - (u[0] - 0.6) ** 2 - (u[1] - 0.36) ** 2; // best at FRR 3.8, 76 mL/min
  const m2 = [{ name: 'y', yMean: 0, ySd: 1, gp: { predict: (u) => ({ mean: peak(u), sd: 0.02 }) } }];
  const at = (batchId, frr, tfr, y, experimentId, date) => ({ batchId, point: { frr, tfr }, values: { y }, experimentId, date });
  const observed = [
    at('R0-1', 2.5, 50, 0.7, 'R0', '2026-01-01'), at('R0-2', 4.5, 130, 0.6, 'R0', '2026-01-01'), at('R0-3', 3, 100, 0.85, 'R0', '2026-01-02'),
    at('R1-1', 3.5, 80, 0.93, 'R1', '2026-01-15'), at('R1-2', 4, 70, 0.94, 'R1', '2026-01-15'),
    at('R2-2', 3.8, 77, 0.99, 'R2', '2026-02-01'), at('R3-3', 3.8, 76, 0.97, 'R3', '2026-02-15'),
  ];
  const pick = modelsPick({ observed, models: m2, space: sp, goals });
  assert.equal(pick.batchId, 'R3-3');
  assert.deepEqual(pick.runs, ['R3-3'], 'made once: R2-2 is a step away on the flow');
  assert.equal(timesRun(observed[5].point, observed, sp), 1, 'and so is the best run');
  const c = confirmAdvice(observed, sp, observed[5], { pick });
  assert.deepEqual(c?.runs.map((r) => [r.kind, r.batchId, r.copies]), [['pick', 'R3-3', 1]], 'so its repeat is offered');
  assert.match(roundVerdict({ pBeats: 0.02, gain: 0, q: 4, confirmBatches: c.batches }).sentence, /^Stop here and confirm the best candidates instead \(1 batch\)/);
  // a true repeat, at the same settings, is counted, and then there is nothing left to confirm
  const repeated = [...observed, at('C-1', 3.8, 76, 0.96, 'C', '2026-03-01')];
  const again = modelsPick({ observed: repeated, models: m2, space: sp, goals });
  assert.deepEqual(again.runs, ['R3-3', 'C-1']);
  assert.equal(confirmAdvice(repeated, sp, observed[5], { pick: again }), null);
});
