// Optimizer UX stage: the outlier rule (outliers.js), a failed run's neighbourhood (acquire.js avoid), the plain
// data sentence (guard.js), the data account's new reasons (dataset.js) and the progress series without the
// starting design counted as suggestions (optimizer.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitModels, score, progressSeries } from '../app/calc/ml/optimizer.js';
import { flagOutliers } from '../app/calc/ml/outliers.js';
import { dataSentence, avoidPoints } from '../app/calc/ml/guard.js';
import { dataAccount } from '../app/calc/ml/dataset.js';
import { suggestRuns } from '../app/calc/ml/acquire.js';
import { mulberry32 } from '../app/calc/ml/linalg.js';
import { toUnit } from '../app/calc/ml/space.js';

const sp = [{ key: 'frr', lo: 2, hi: 6, step: 0.1 }, { key: 'tfr', lo: 20, hi: 150, step: 1 }];
const goals = [{ name: 'particle_size_nm', goal: 'target', target: 80, lo: 40, hi: 120, weight: 1, on: true }, { name: 'PDI', goal: 'minimize', best: 0.05, worst: 0.3, weight: 1, on: true }];
function make(seed, n, plant) {
  const rnd = mulberry32(seed);
  const g = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / 0.7071; };
  return Array.from({ length: n }, (_, i) => {
    const factors = { frr: Math.round((2 + rnd() * 4) * 10) / 10, tfr: Math.round(20 + rnd() * 130) };
    let size = 60 + 8 * factors.frr + 0.2 * factors.tfr + g() * 3;
    if (i === plant) size *= 3;
    return { batchId: `B${i}`, experimentId: `E${i % 4}`, factors, values: { particle_size_nm: size, PDI: 0.1 + 0.01 * factors.frr + g() * 0.01 } };
  });
}

test('outlier rule: one planted result is flagged, clean data is not', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) for (const n of [16, 30]) {
    assert.deepEqual(flagOutliers(fitModels({ rows: make(seed, n), space: sp, goals })), [], `clean, seed ${seed}, n ${n}`);
    const f = flagOutliers(fitModels({ rows: make(seed, n, 5), space: sp, goals }));
    assert.equal(f.length, 1, `planted, seed ${seed}, n ${n}`);
    assert.equal(f[0].batchId, 'B5');
    assert.equal(f[0].name, 'particle_size_nm');
    assert.equal(f[0].source, 'fit');
    assert.ok(f[0].z > 3.5 && f[0].measured > f[0].expected + 50);
  }
});

test('outlier rule: a result far from the forecast the optimizer gave is flagged, a near one is not', () => {
  const rows = make(1, 16).map((r, i) => ({ ...r, mlPredicted: i === 2 ? { particle_size_nm: { mean: 90, sd: 5 } } : i === 3 ? { particle_size_nm: { mean: r.values.particle_size_nm - 6, sd: 5 } } : null }));
  rows[2].values.particle_size_nm = 130; // 8 sd from its forecast
  const f = flagOutliers(fitModels({ rows, space: sp, goals }), rows);
  const hit = f.find((x) => x.batchId === 'B2');
  assert.ok(hit && Math.abs(hit.z) >= 4);
  assert.equal(f.find((x) => x.batchId === 'B3'), undefined);
});

test('a failed run: suggestions keep away from its settings, and nothing changes without one', () => {
  const fit = fitModels({ rows: make(3, 24), space: sp, goals });
  const base = score(fit, { goals, q: 4, seed: 5 });
  const near = base.suggestions.picks[0].point;
  const again = score(fit, { goals, q: 4, seed: 5 });
  assert.deepEqual(again.suggestions.picks.map((p) => p.point), base.suggestions.picks.map((p) => p.point), 'no avoid: same picks');
  const away = score(fit, { goals, q: 4, seed: 5, avoid: [near] });
  for (const p of away.suggestions.picks) {
    const d = Math.max(...toUnit(p.point, sp).map((v, i) => Math.abs(v - toUnit(near, sp)[i])));
    assert.ok(d >= 0.12, `pick ${JSON.stringify(p.point)} is ${d.toFixed(3)} from the failed setting`);
  }
  assert.equal(typeof suggestRuns, 'function');
  const rows = [{ batchId: 'F1', factors: { frr: 3, tfr: 100 } }, { batchId: 'F2', factors: { frr: 3 } }, { batchId: 'F3', factors: { frr: 4, tfr: 50 } }];
  assert.deepEqual(avoidPoints(rows, ['F1', 'F2'], sp), [{ frr: 3, tfr: 100 }], 'a failed run missing a free factor cannot be placed');
});

test('the one-sentence summary uses the minimum-run rule', () => {
  assert.equal(dataSentence({ runs: 39, experiments: 6, factors: 5 }), '39 runs from 6 experiments: enough for a 5-factor model (needs about 25).');
  assert.equal(dataSentence({ runs: 12, experiments: 1, factors: 5 }), '12 runs from 1 experiment: not yet enough for a 5-factor model (needs about 25).');
  assert.match(dataSentence({ runs: 6, experiments: 1, factors: 1 }), /not yet enough for a 1-factor model \(needs about 8\)/, 'never fewer than the 8 a first model needs');
  assert.match(dataSentence({ runs: 0, experiments: 0, factors: 3 }), /^No measured runs yet: not yet enough/);
  assert.match(dataSentence({ runs: 10, experiments: 2, factors: 0 }), /choose the factors/);
});

test('data account: a run left out or marked failed is listed with its reason, only that run', () => {
  const rows = [{ batchId: 'A1', experimentId: 'E1', values: { particle_size_nm: 80 }, factors: { frr: 3, tfr: 50 }, status: 'done' },
    { batchId: 'A2', experimentId: 'E1', values: { particle_size_nm: 90 }, factors: { frr: 3, tfr: 60 }, status: 'done' },
    { batchId: 'A3', experimentId: 'E1', values: {}, factors: { frr: 3, tfr: 70 }, status: 'done' }];
  const a = dataAccount(rows, { space: sp, goals, dropped: new Map([['A1', 'leftOut'], ['A3', 'failed']]) });
  assert.deepEqual(a.used.map((r) => r.batchId), ['A2']);
  assert.equal(a.reasons.leftOut, 1);
  assert.equal(a.reasons.failed, 1);
  assert.equal(a.left.find((x) => x.batchId === 'A3').reason, 'failed', 'failed beats "no result yet"');
});

test('progress: the starting design is not a suggestion and is compared against', () => {
  const vals = (d) => ({ particle_size_nm: 80 + d, PDI: 0.1, encapsulation_efficiency: 90 });
  const g = [{ name: 'particle_size_nm', goal: 'target', target: 80, lo: 40, hi: 120, on: true }];
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => ({ batchId: `S${i}`, date: `2026-01-0${i + 1}`, values: vals(30 - i), suggestedByMl: true, mlStart: true })),
    ...Array.from({ length: 3 }, (_, i) => ({ batchId: `M${i}`, date: `2026-02-0${i + 1}`, values: vals(5 - i), suggestedByMl: true, mlStart: false })),
  ];
  const p = progressSeries(rows, g, (r) => r.suggestedByMl && !r.mlStart, (r) => r.mlStart);
  assert.equal(p.suggestedRuns, 3);
  assert.equal(p.startRuns, 8);
  assert.equal(p.ownRuns, 0);
  assert.equal(p.otherRuns, 8);
  assert.ok(p.improvedByOther != null);
});
