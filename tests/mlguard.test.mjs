// The optimizer's input checks and the honesty of its verdict (app/calc/ml/guard.js, stopping.js, space.js
// startRange, dataset.js repeatMeasurements): ranges that cannot be searched, limits no result can meet, what a
// switched-off factor is held at, a verdict that must not say "stop" on a model that cannot predict.
import test from 'node:test';
import assert from 'node:assert/strict';
import { goalProblems, rangeProblems, limitProblems, heldValues, heldNotes } from '../app/calc/ml/guard.js';
import { roundVerdict, trustIssues, mostlyLongShots, repeatOf } from '../app/calc/ml/stopping.js';
import { startRange, ALL_FACTORS, PROCESS_FACTORS, COMPOSITION_FACTORS } from '../app/calc/ml/space.js';
import { repeatMeasurements, repeatNotes } from '../app/calc/ml/dataset.js';
import { analyse } from '../app/calc/ml/optimizer.js';
import { mulberry32 } from '../app/calc/ml/linalg.js';

test('a range typed backwards, equal or with an empty bound is refused with a message naming the factor', () => {
  const sp = (lo, hi) => [{ key: 'tfr', name: 'Total flow rate', lo, hi }];
  assert.deepEqual(rangeProblems(sp(40, 140)), []);
  assert.match(rangeProblems(sp(120, 100))[0].text, /Total flow rate: the range runs backwards \(from 120 to 100\)/);
  assert.match(rangeProblems(sp(100, 100))[0].text, /both 100, so there is nothing to search/);
  assert.match(rangeProblems(sp(null, 100))[0].text, /both ends of the search range are needed/);
  assert.match(rangeProblems(sp(40, undefined))[0].text, /both ends/);
  assert.match(rangeProblems(sp('', 100))[0].text, /both ends/);
  assert.equal(rangeProblems(sp(0, 100)).length, 0, 'zero is a bound like any other');
  assert.equal(rangeProblems([...sp(120, 100), { key: 'frr', name: 'FRR', lo: 2, hi: 5 }]).length, 1, 'only the bad one');
});

test('a hard limit no measurement can meet is named', () => {
  assert.equal(limitProblems([{ name: 'PDI', op: '<', value: 0.3, on: true }]).length, 0);
  assert.match(limitProblems([{ name: 'PDI', op: '<', value: 0.0005, on: true }])[0], /PDI must be below 0.0005/);
  assert.equal(limitProblems([{ name: 'PDI', op: '<', value: 0.0005, on: false }]).length, 0, 'a limit that is off does not count');
  assert.match(limitProblems([{ name: 'encapsulation_efficiency', op: '>', value: 100, on: true }])[0], /above 100/);
  assert.equal(limitProblems([{ name: 'encapsulation_efficiency', op: '>', value: 90, on: true }]).length, 0);
  assert.equal(limitProblems([{ name: 'particle_size_nm', op: '<', value: 0.5, on: true }]).length, 1);
});

test('goalProblems is unchanged by the move: a target outside its band is a problem', () => {
  assert.match(goalProblems([{ name: 'particle_size_nm', label: 'Size', goal: 'target', target: 300, lo: 90, hi: 150, on: true }])[0], /ideal value 300 is outside the acceptable range 90 to 150/);
  assert.deepEqual(goalProblems([{ name: 'PDI', label: 'PDI', goal: 'minimize', best: 0.05, worst: 0.3, on: true }]), []);
});

test('a factor that is switched off says what it is held at, and warns when earlier runs varied it', () => {
  const space = [{ key: 'frr', name: 'Flow rate ratio (aq : org)', lo: 2, hi: 5 }];
  const settings = { defaultFRR: 3, defaultQuenchFactor: 4, defaultLipidStock_mM: 40, defaultWorking_mg_mL: 0.5 };
  const held = heldValues({ space, settings, baseClasses: { ionizable: 47.5, peg: 1.8, helper: 10, sterol: 40.7 } });
  assert.equal(held.frr, undefined, 'a factor that is on is not held');
  assert.deepEqual(held.tfr, { value: 112.5, unit: 'mL/min', source: 'app default' });
  assert.equal(held.quench.value, 4);
  assert.equal(held.quench.source, 'your Settings default');
  assert.equal(held.np.value, null, 'N/P follows from the RNA mass');
  assert.equal(held.peg_pct.value, 1.8);
  const notes = heldNotes({ space, held, observed: { tfr: { n: 20, distinct: 8, lo: 40, hi: 140 }, quench: { n: 20, distinct: 1, lo: 4, hi: 4 }, peg_pct: { n: 20, distinct: 1, lo: 1.8, hi: 1.8 }, frr: { n: 20, distinct: 6, lo: 2, hi: 5 } } });
  const tfr = notes.find((x) => x.key === 'tfr');
  assert.equal(tfr.varied, true);
  assert.equal(tfr.text, 'Total flow rate held at 112.5 mL/min (app default), not the value your earlier runs varied (40 to 140 mL/min). The model treats those differences as noise. Switch it on to let the optimizer set it.');
  assert.equal(notes.find((x) => x.key === 'quench').varied, false);
  assert.match(notes.find((x) => x.key === 'quench').text, /held at 4 × lipid volume \(your Settings default\)\.$/);
  assert.equal(notes.find((x) => x.key === 'peg_pct'), undefined, 'a lipid nobody varied is the ordinary case: no note');
  assert.equal(notes.find((x) => x.key === 'frr'), undefined, 'a factor that is on has no note');
  assert.equal(notes.find((x) => x.key === 'np'), undefined, 'no note for a factor no run recorded');
});

test('with no runs that vary a factor, its range starts at the span the testers settled on, not the factor limits', () => {
  const by = (k) => ALL_FACTORS.find((f) => f.key === k);
  assert.deepEqual(startRange(by('frr')), { lo: 2, hi: 5 });
  assert.deepEqual(startRange(by('tfr')), { lo: 40, hi: 140 });
  assert.deepEqual(startRange(by('np')), { lo: 4, hi: 10 });
  assert.deepEqual(startRange(by('peg_pct')), { lo: 0.5, hi: 3 });
  assert.deepEqual(startRange(by('quench')), { lo: 1, hi: 10 }, 'a factor without a narrower start keeps its limits');
  // the factor limits themselves are untouched: suggestSpace clips to them
  assert.deepEqual([by('frr').lo, by('frr').hi, by('tfr').lo, by('tfr').hi, by('np').lo, by('np').hi], [1, 6, 20, 150, 3, 12]);
  // runs that do vary it still decide: their span, within the limits
  assert.deepEqual(startRange(by('frr'), [1.5, 4, 3]), { lo: 1.5, hi: 4 });
  assert.deepEqual(startRange(by('frr'), [0.2, 9]), { lo: 1, hi: 6 });
  assert.deepEqual(startRange(by('frr'), [3, 3]), { lo: 2, hi: 5 }, 'all at one value: nothing to span');
  assert.ok(PROCESS_FACTORS.length && COMPOSITION_FACTORS.length);
});

test('the verdict never says stop on a model that cannot predict, and carries the Q2 caveat', () => {
  const trust = [{ name: 'particle_size_nm', level: 'none', text: 'Size is predicted worse than the average (Q² -0.99)' }];
  for (const pBeats of [0.001, 0.06, 0.5, 0.999]) {
    const v = roundVerdict({ pBeats, gain: 0, q: 4, confirmBatches: 1, trust });
    assert.notEqual(v.level, 'stop');
    assert.equal(v.stop, false);
    assert.match(v.sentence, /Q² -0.99/);
    assert.match(v.sentence, /space-filling plan, not predictions/);
    assert.doesNotMatch(v.sentence, /may still pay/, 'no encouragement from a model that cannot tell');
    assert.doesNotMatch(v.sentence, /Stop here/);
  }
  assert.match(roundVerdict({ pBeats: 0.999, trust }).sentence, /by its own reckoning .* more than a 99 % chance/i);
  assert.equal(roundVerdict({ pBeats: 0.03, gain: 0, q: 4, confirmBatches: 1 }).level, 'stop', 'a trusted model still can stop');
});

test('impossible goals or limits replace the verdict: the limits cannot be met', () => {
  const v = roundVerdict({ pBeats: 0.02, gain: 0, q: 1, confirmBatches: 0, blocked: ['PDI must be below 0.0005, which no measurement can reach.'] });
  assert.equal(v.level, 'blocked');
  assert.equal(v.stop, false);
  assert.match(v.sentence, /^Fix the goals or limits first: PDI must be below 0.0005/);
  assert.doesNotMatch(v.sentence, /Stop here|take the model's pick forward/);
  // even without a number to quote
  assert.equal(roundVerdict({ pBeats: NaN, blocked: ['x'] }).level, 'blocked');
  assert.equal(roundVerdict({ pBeats: NaN }), null);
});

test('trustIssues lists the goals whose model is worse than the average, in words that fit the Q2', () => {
  const resp = [
    { name: 'particle_size_nm', label: 'Size', trust: { level: 'none' }, best: { q2: -0.99 } },
    { name: 'PDI', label: 'PDI', trust: { level: 'weak' }, best: { q2: 0.12 } },
    { name: 'tfr2', label: 'Flow', trust: { level: 'weak' }, best: { q2: -0.2 } },
    { name: 'encapsulation_efficiency', label: 'EE', trust: { level: 'fair' }, best: { q2: 0.5 } },
    { name: 'zeta', label: 'Zeta', trust: { level: 'none' }, best: null },
    { name: 'x', label: 'X', skipped: 'fewer than four', trust: { level: 'none' } },
  ];
  const t = trustIssues(resp, ['particle_size_nm', 'PDI', 'tfr2', 'encapsulation_efficiency', 'zeta', 'x']);
  assert.deepEqual(t.map((x) => x.text), ['Size is predicted worse than the average (Q² -0.99)', 'Flow is predicted worse than the average (Q² -0.20)', 'Zeta could not be tested yet'],
    'weak with a Q² of 0.12 still captures something: it can carry a verdict');
  assert.deepEqual(trustIssues(resp, ['encapsulation_efficiency']), [], 'goals the suggestions ignore do not count');
});

test('the optimizer: a wild result cannot turn the verdict to stop; an impossible PDI limit is named', () => {
  const rnd = mulberry32(9);
  const sp = [{ key: 'frr', lo: 2, hi: 6, step: 0.1 }, { key: 'tfr', lo: 20, hi: 150, step: 1 }];
  const ee = (f) => 70 + 25 * Math.exp(-((f.frr - 4) ** 2) / 1.5 - ((f.tfr - 100) / 60) ** 2);
  const rows = Array.from({ length: 16 }, (_, i) => {
    const late = i >= 10;
    const f = late ? { frr: 3.2 + rnd() * 1.6, tfr: 70 + rnd() * 60 } : { frr: 2 + rnd() * 4, tfr: 20 + rnd() * 130 };
    const factors = { frr: Math.round(f.frr * 10) / 10, tfr: Math.round(f.tfr) };
    return { batchId: `B${i + 1}`, experimentId: late ? 'E2' : 'E1', date: late ? '2026-02-01' : '2026-01-01', factors,
      values: { encapsulation_efficiency: i === 12 ? 6 : ee(factors) + (rnd() - 0.5) * 60, PDI: 0.1 + rnd() * 0.1 } };
  });
  const goals = [{ name: 'encapsulation_efficiency', goal: 'maximize', worst: 70, best: 96, weight: 1, on: true }, { name: 'PDI', goal: 'minimize', best: 0.05, worst: 0.3, weight: 1, on: true }];
  const o = analyse({ rows, space: sp, goals, q: 4, seed: 3 });
  const weak = o.responses.filter((r) => ['none', 'weak'].includes(r.trust?.level));
  assert.ok(weak.length, 'the noisy data gives a model the screen itself calls weak or worse');
  assert.notEqual(o.verdict.level, 'stop');
  assert.equal(o.verdict.level, 'unsure');
  assert.match(o.verdict.sentence, /Q²/);
  const lim = analyse({ rows, space: sp, goals, constraints: [{ name: 'PDI', op: '<', value: 0.0005, on: true }], q: 4, seed: 3 });
  assert.equal(lim.verdict.level, 'blocked');
  assert.match(lim.verdict.sentence, /PDI must be below 0.0005/);
  const bad = analyse({ rows, space: sp, goals: [{ ...goals[0], goal: 'target', target: 300, lo: 90, hi: 150 }, goals[1]], q: 4, seed: 3 });
  assert.equal(bad.verdict.level, 'blocked');
  assert.match(bad.verdict.sentence, /ideal value 300 is outside/);
});

test('most suggestions with under 5 % chance is a long-shot round; an exact repeat is recognised', () => {
  const p = (x) => ({ pBeatsBest: x });
  assert.equal(mostlyLongShots([p(0.01), p(0.0), p(0.2), p(0.01)]), true);
  assert.equal(mostlyLongShots([p(0.01), p(0.3), p(0.2), p(0.01)]), false, 'half is not most');
  assert.equal(mostlyLongShots([]), false);
  const space = [{ key: 'frr' }, { key: 'tfr' }];
  const obs = [{ batchId: 'E2-F4', point: { frr: 3.5, tfr: 80 } }];
  assert.equal(repeatOf({ frr: 3.5, tfr: 80 }, obs, space).batchId, 'E2-F4');
  assert.equal(repeatOf({ frr: 3.6, tfr: 80 }, obs, space), null, 'a neighbour is not a repeat');
});

test('a sample measured twice: which measurement the model reads is named', () => {
  const m = (id, date, size, stage = 'final') => ({ id, test: 'dls', stage, date, values: { zave_nm: size } });
  const sources = { particle_size_nm: { id: 'M1', date: '2026-01-02', stage: 'final' } };
  const d = repeatMeasurements([m('M1', '2026-01-02', 80), m('M2', '2026-01-02', 105)], sources);
  assert.equal(d.length, 1);
  assert.equal(d[0].usedId, 'M1');
  assert.deepEqual(d[0].others.map((o) => o.id), ['M2']);
  assert.deepEqual(repeatMeasurements([m('M1', '2026-01-02', 80), m('M3', '2026-01-01', 90, 'initial')], sources), [], 'another stage is not a second measurement');
  assert.deepEqual(repeatMeasurements([m('M1', '2026-01-02', 80)], sources), []);
  const notes = repeatNotes([{ batchId: 'E3-F1', repeatMeasured: d }]);
  assert.equal(notes[0].text, 'E3-F1 measured twice: DLS uses M1 (2026-01-02), not M2.');
});
