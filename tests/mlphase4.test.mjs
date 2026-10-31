// Spec 7 (Baustein D): the optimizer's data selection per lipid and mixer, the data budget, the lipid modes
// (filter, categorical kernel, descriptors, auto), the model fingerprint and its reproduction, prediction
// against measurement, and the hook for biological targets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cholesky, cholInverse, cholInverseFast, mulberry32, randn } from '../app/calc/ml/linalg.js';
import { _nlmlForTest, fitGP, fixedInputView, defaultPriors, hyperparameters } from '../app/calc/ml/gp.js';
import { standardise, LEARNERS } from '../app/calc/ml/model.js';
import { selectData, subselect, lipidMixerCombos, clampBudget, BUDGET } from '../app/calc/ml/select.js';
import { selectionAccount, NOT_RECORDED, qualityIssues } from '../app/calc/ml/dataset.js';
import { modeAvailability, modesToTry, descriptorVector, lipidLearner, DESCRIPTORS } from '../app/calc/ml/lipidmode.js';
import { runOptimizer, reproduce, prepare, fitPrepared, defaultSelection, modeSentence } from '../app/calc/ml/pipeline.js';
import { canonical, hashOf, makeFingerprint, ML_CODE_VERSION } from '../app/calc/ml/fingerprint.js';
import { fitModels } from '../app/calc/ml/optimizer.js';
import { predictionCheck, hitRateSentence } from '../app/calc/ml/predcheck.js';
import { biologicalTargets, applyTargets, targetGoals, physchemAsLimits, normalisedLog, INVIVO_OPTIMISATION } from '../app/calc/ml/targets.js';
import { readFactors, suggestSpace, PROCESS_FACTORS, pointToPlan } from '../app/calc/ml/space.js';
import { DEFAULT_GOALS, overallDesirability } from '../app/calc/ml/objective.js';
import { fingerprintBlock } from '../app/ui/report.js';
import { accountLines } from '../app/ui/mlpanel.js';

const GOALS = DEFAULT_GOALS.filter((g) => g.on !== false);
const SPACE = [
  { key: 'frr', name: 'Flow rate ratio', unit: '', lo: 2, hi: 5, step: 0.1 },
  { key: 'tfr', name: 'Total flow rate', unit: 'mL/min', lo: 40, hi: 140, step: 1 },
];
/** The usability lab's shape, enough for a model to find: size, PDI and EE from FRR and flow. */
const truth = (frr, tfr, shift = 0) => ({
  particle_size_nm: 80 + 11 * (3.7 - frr) + 3 * (frr - 3.7) ** 2 - 0.12 * (tfr - 80) + shift,
  PDI: 0.065 + 0.03 * (frr - 3.7) ** 2 + 0.00003 * (tfr - 80) ** 2,
  encapsulation_efficiency: 95 - 3 * (frr - 3.5) ** 2 - 0.0005 * (tfr - 80) ** 2,
});
/** Rows as buildRows makes them, for a lipid and mixer, with seeded noise. */
function rowsFor(n, { lipid = 'SM102', mixer = 'T-mixer', seed = 1, prefix = 'B', shift = 0, exp = (i) => `E${Math.floor(i / 6)}` } = {}) {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const frr = Math.round((2 + 3 * rnd()) * 10) / 10, tfr = Math.round(40 + 100 * rnd());
    const t = truth(frr, tfr, shift);
    const values = { particle_size_nm: t.particle_size_nm + randn(rnd) * 2.5, PDI: Math.max(0.02, t.PDI + randn(rnd) * 0.008), encapsulation_efficiency: t.encapsulation_efficiency + randn(rnd) * 1.2 };
    return { batchId: `${prefix}${String(i).padStart(4, '0')}`, experimentId: exp(i), label: '', compositionId: 1, factors: { frr, tfr }, values,
      date: `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`, lipid, mixerType: mixer, nResponses: 3, quality: [], status: 'produced' };
  });
}

test('the triangular inverse gives the same K⁻¹ as n solves', () => {
  const rnd = mulberry32(3);
  const n = 40, X = Array.from({ length: n }, () => [rnd(), rnd()]);
  const K = X.map((a) => X.map((b) => Math.exp(-((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) / 0.2)));
  for (let i = 0; i < n; i++) K[i][i] += 0.05;
  const { L } = cholesky(K);
  const A = cholInverse(L), B = cholInverseFast(L);
  let worst = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) worst = Math.max(worst, Math.abs(A[i][j] - B[i][j]) / Math.max(1, Math.abs(A[i][j])));
  assert.ok(worst < 1e-10, `max relative difference ${worst}`);
});

test('the marginal-likelihood gradient matches finite differences, lipid matrix included (rank 1 and 2)', () => {
  const rnd = mulberry32(5);
  const n = 16, D = 2, T = 3;
  const X = Array.from({ length: n }, () => [rnd(), rnd()]);
  const tasks = Int32Array.from(X.map((_, i) => i % T));
  const y = X.map((x, i) => Math.sin(4 * x[0]) + 0.3 * tasks[i] + 0.1 * rnd());
  for (const R of [1, 2]) {
    const theta = [-0.5, 0.2, -1.2, ...Array.from({ length: T * R }, () => rnd() - 0.3), ...Array.from({ length: T }, () => Math.log(0.1 + rnd()))];
    const priors = [...defaultPriors(D), ...Array.from({ length: T * R }, () => ({ mu: 0, sd: 1 })), ...Array.from({ length: T }, () => ({ mu: -2, sd: 1 }))];
    const opts = { tasks, nTasks: T, rank: R, taskOffset: D + 1, dims: D, priors };
    const { g } = _nlmlForTest(theta, X, y, opts);
    for (let t = 0; t < theta.length; t++) {
      const h = 1e-6, a = [...theta], b = [...theta]; a[t] += h; b[t] -= h;
      const fd = (_nlmlForTest(a, X, y, opts).f - _nlmlForTest(b, X, y, opts).f) / (2 * h);
      assert.ok(Math.abs(fd - g[t]) < 1e-5 * Math.max(1, Math.abs(fd)), `rank ${R}, parameter ${t}: analytic ${g[t]}, numeric ${fd}`);
    }
  }
  // and the plain kernel, with the noise and the replicate likelihood
  const th = [-0.4, 0.1, -1.1];
  const o = { priors: defaultPriors(D), noiseLik: { df: 3, s2: 0.05 } };
  const { g } = _nlmlForTest(th, X, y, o);
  for (let t = 0; t < th.length; t++) {
    const h = 1e-6, a = [...th], b = [...th]; a[t] += h; b[t] -= h;
    const fd = (_nlmlForTest(a, X, y, o).f - _nlmlForTest(b, X, y, o).f) / (2 * h);
    assert.ok(Math.abs(fd - g[t]) < 1e-5 * Math.max(1, Math.abs(fd)), `single task, parameter ${t}`);
  }
});

test('multi-task GP: a lipid with few runs predicts better with the lipid kernel than alone', () => {
  // Lipid A: 30 runs. Lipid B: the same surface 0.4 higher and a little steeper, 5 runs. Predict B on a grid.
  const f = (x, l) => Math.sin(5 * x[0]) + x[1] * x[1] + (l ? 0.4 + 0.3 * x[0] : 0);
  const rnd = mulberry32(11);
  const XA = Array.from({ length: 30 }, () => [rnd(), rnd()]), XB = Array.from({ length: 5 }, () => [rnd(), rnd()]);
  const yA = XA.map((x) => f(x, 0) + 0.05 * randn(rnd)), yB = XB.map((x) => f(x, 1) + 0.05 * randn(rnd));
  const sA = standardise(yA), sB = standardise(yB);
  const mt = fitGP([...XB, ...XA], [...sB.z, ...sA.z], { tasks: [...XB.map(() => 0), ...XA.map(() => 1)], nTasks: 2 });
  const shared = fixedInputView(mt, [0], 2);
  const alone = fitGP(XB, sB.z, {});
  const grid = [];
  for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) grid.push([i / 8, j / 8]);
  const rmse = (m) => Math.sqrt(grid.reduce((s, x) => s + (m.predict(x).mean * sB.sd + sB.mean - f(x, 1)) ** 2, 0) / grid.length);
  const eShared = rmse(shared), eAlone = rmse(alone);
  assert.ok(eShared < 0.6 * eAlone, `kernel RMSE ${eShared.toFixed(3)} against ${eAlone.toFixed(3)} alone`);
  // B learned: the two lipids are strongly correlated, and the fingerprint carries the matrix
  const B = mt.lipidMatrix, corr = B[0][1] / Math.sqrt(B[0][0] * B[1][1]);
  assert.ok(corr > 0.6, `fitted correlation ${corr.toFixed(2)}`);
  assert.equal(hyperparameters(shared).lipidMatrix.length, 2);
  assert.deepEqual(hyperparameters(shared).at, [0]);
});

test('the selection filters per lipid and mixer, and the account says why for each formulation', () => {
  const rows = [...rowsFor(20, { lipid: 'SM102', mixer: 'T-mixer', prefix: 'A' }), ...rowsFor(7, { lipid: 'MC3', mixer: 'T-mixer', prefix: 'M', seed: 2 }),
    ...rowsFor(5, { lipid: 'SM102', mixer: null, prefix: 'N', seed: 3 })];
  rows[3].factors.tfr = null; // a missing factor
  rows[4].values = {}; rows[4].nResponses = 0; // nothing measured
  const combos = lipidMixerCombos(rows);
  assert.deepEqual(combos.map((c) => [c.lipid, c.mixer, c.n]), [['SM102', 'T-mixer', 19], ['MC3', 'T-mixer', 7], ['SM102', NOT_RECORDED, 5]]);
  assert.deepEqual(defaultSelection(rows), { lipid: 'SM102', mixer: 'T-mixer' });
  const sel = selectData(rows, { space: SPACE, goals: GOALS, lipid: 'SM102', mixer: 'T-mixer' });
  assert.equal(sel.target.length, 18);
  assert.equal(sel.steps.otherLipid, 7);
  assert.equal(sel.steps.otherMixer, 5);
  assert.equal(sel.steps.missingFactor, 1);
  assert.equal(sel.steps.noResponse, 1);
  const acc = selectionAccount(sel);
  assert.equal(acc.total, rows.length, 'one line per formulation');
  assert.equal(acc.used, 18);
  assert.equal(acc.rows.find((r) => r.batchId === 'M0000').reason, 'filtered');
  assert.equal(acc.rows.find((r) => r.batchId === 'M0000').detail, 'other lipid');
  assert.equal(acc.rows.find((r) => r.batchId === 'N0000').detail, 'other mixer');
  assert.equal(acc.rows.find((r) => r.batchId === 'A0003').reason, 'missing factor');
  // "not recorded" is a mixer of its own
  const nr = selectData(rows, { space: SPACE, goals: GOALS, lipid: 'SM102', mixer: NOT_RECORDED });
  assert.equal(nr.target.length, 5);
  // the lipid kernel filters the mixer only, and keeps the other lipids beside the chosen one
  const k = selectData(rows, { space: SPACE, goals: GOALS, lipid: 'SM102', mixer: 'T-mixer', mode: 'kernel' });
  assert.equal(k.target.length, 18); assert.equal(k.others.length, 7); assert.equal(k.steps.otherLipid, 0);
  assert.deepEqual(accountLines(sel.steps).map((l) => l[0]), [7, 5, 1, 1]);
});

test('the data budget: four steps, each counted, and the same seed and data give the same selection', () => {
  const rows = rowsFor(700, { seed: 9 });
  // replicates: 30 recipes made three times
  const rr = mulberry32(99);
  for (let i = 0; i < 30; i++) for (const k of [1, 2]) {
    const r = rows[i * 3 + k], f = rows[i * 3].factors, t = truth(f.frr, f.tfr);
    r.factors = { ...f };
    r.values = { particle_size_nm: t.particle_size_nm + randn(rr) * 2.5, PDI: Math.max(0.02, t.PDI + randn(rr) * 0.008), encapsulation_efficiency: t.encapsulation_efficiency + randn(rr) * 1.2 };
  }
  // out of range, and a measurement not to be believed
  rows[200].factors.frr = 9; rows[201].factors.tfr = 400;
  rows[300].quality = ['M1: count rate 5 kcps low'];
  const o = { space: SPACE, goals: GOALS, lipid: 'SM102', mixer: 'T-mixer', budget: 400, seed: 7 };
  const a = selectData(rows, o), b = selectData(rows, o);
  assert.deepEqual(a.rows.map((r) => r.batchId), b.rows.map((r) => r.batchId), 'deterministic');
  assert.ok(a.over);
  assert.equal(a.steps.relevance, 2);
  assert.equal(a.steps.quality, 1);
  assert.ok(a.steps.mergedGroups >= 30 && a.steps.mergedRuns >= 60, `merged ${a.steps.mergedRuns} into ${a.steps.mergedGroups}`);
  assert.equal(a.rows.length, 400);
  const left = 700 - 2 - 1 - a.steps.mergedRuns;
  assert.equal(a.steps.subselected, left - 400, 'what the subselection dropped is what was over');
  const acc = selectionAccount(a);
  assert.equal(acc.total, 700);
  assert.equal(acc.counts.subselected, a.steps.subselected);
  assert.equal(acc.counts.merged, a.steps.mergedRuns);
  // the merged scatter goes to the noise model
  assert.ok(a.noise?.particle_size_nm?.df >= 60, 'replicate noise measured before merging');
  assert.ok(Math.abs(a.noise.particle_size_nm.sd - 2.5) < 0.8, `noise SD ${a.noise.particle_size_nm.sd}`);
  // a merged point is the mean of its runs
  const m = a.rows.find((r) => r.mergedFrom) || null;
  if (m) {
    const g = m.mergedFrom.map((id) => rows.find((r) => r.batchId === id));
    assert.ok(Math.abs(m.values.PDI - g.reduce((s, r) => s + r.values.PDI, 0) / g.length) < 1e-12);
  }
  // another seed may break ties differently, but never changes what the budget has to drop
  const c = selectData(rows, { ...o, seed: 8 });
  assert.equal(c.rows.length, 400);
  // under the budget nothing happens: the model sees exactly what it saw before
  const small = selectData(rows.slice(0, 120), o);
  assert.equal(small.over, false);
  assert.equal(small.rows.length, 120);
  assert.equal(small.noise, null);
  assert.equal(clampBudget(50), BUDGET.min); assert.equal(clampBudget(5000), BUDGET.max); assert.equal(clampBudget(undefined), 400);
});

test('the subselection spreads out, and prefers good and recent runs over equally isolated ones', () => {
  const rows = rowsFor(300, { seed: 4 });
  const { keep } = subselect(rows, 40, SPACE, GOALS, 7);
  assert.equal(keep.length, 40);
  // coverage: every quarter of the FRR range is represented
  for (let q = 0; q < 4; q++) assert.ok(keep.some((r) => r.factors.frr >= 2 + q * 0.75 && r.factors.frr < 2 + (q + 1) * 0.75 + 1e-9), `quarter ${q}`);
  // the first one taken is the best scored
  const D = (r) => overallDesirability(r.values, GOALS).D;
  assert.equal(D(keep[0]), Math.max(...rows.map(D)));
  // good runs are kept more often than poor ones
  const sorted = rows.map(D).sort((x, y) => x - y), median = sorted[150];
  assert.ok(keep.filter((r) => D(r) > median).length > keep.filter((r) => D(r) <= median).length, 'more of the better half');
});

test('lipid modes: availability by the rules, and a lipid with no runs cannot use the kernel', () => {
  const rows = [...rowsFor(12, { lipid: 'SM102' }), ...rowsFor(9, { lipid: 'MC3', prefix: 'M', seed: 2 }), ...rowsFor(3, { lipid: 'ALC315', prefix: 'L', seed: 3 })];
  const a = modeAvailability(rows, 'ALC315');
  assert.equal(a.filter.ok, true);
  assert.equal(a.kernel.ok, true, 'two lipids with 8 or more runs; ALC315 has runs of its own');
  assert.equal(modeAvailability(rows, 'DODMA').kernel.ok, false);
  assert.match(modeAvailability(rows, 'DODMA').kernel.why, /no runs of its own/);
  assert.equal(modeAvailability(rows.slice(0, 18), 'SM102').kernel.ok, false, 'MC3 has only 6 there');
  assert.equal(a.descriptor.ok, false, 'behind the feature flag');
  assert.deepEqual(modesToTry('auto', a), ['filter', 'kernel']);
  assert.deepEqual(modesToTry('kernel', a), ['kernel']);
  assert.deepEqual(modesToTry('descriptor', a), ['filter'], 'a mode not available falls back to filter');
  // descriptors: all six or none, and 20 lipids before the mode opens
  const lip = { descriptors: { pKa: 6.6, tails: 2, chainLength: 16, unsaturation: 0, logP: 14, headGroup: 'tertiary amine' } };
  assert.equal(descriptorVector(lip).length, DESCRIPTORS.length);
  assert.equal(descriptorVector({ descriptors: { pKa: 6.6 } }), null);
  const byKey = { SM102: lip, MC3: lip, ALC315: lip };
  assert.match(modeAvailability(rows, 'SM102', { descriptorsOn: true, lipidByKey: byKey }).descriptor.why, /about 20 lipids/);
});

test('auto compares the modes by cross-validated Q² and says which it chose against what', () => {
  const rows = [...rowsFor(30, { lipid: 'SM102', seed: 21 }), ...rowsFor(30, { lipid: 'MC3', prefix: 'M', seed: 22, shift: 6, exp: (i) => `F${Math.floor(i / 6)}` })];
  const target = rowsFor(10, { lipid: 'ALC315', prefix: 'L', seed: 23, shift: -4, exp: (i) => `G${Math.floor(i / 5)}` });
  const all = [...rows, ...target];
  const space = SPACE;
  const goals = GOALS.filter((g) => g.name !== 'encapsulation_efficiency');
  const prep = prepare(all, { space, goals, lipid: 'ALC315', mixer: 'T-mixer', lipidMode: 'auto', seed: 7 });
  assert.deepEqual(prep.tries, ['filter', 'kernel']);
  const fit = fitPrepared(prep, { space, goals, seed: 7 });
  assert.equal(fit.lipidChoice.compared.length, 2);
  const [f, k] = fit.lipidChoice.compared;
  assert.equal(fit.lipidChoice.mode, (k.q2 ?? -Infinity) > (f.q2 ?? -Infinity) ? 'kernel' : 'filter');
  assert.match(modeSentence(fit), /chosen automatically, Q² -?\d\.\d\d against -?\d\.\d\d in /);
  if (fit.lipidChoice.mode === 'kernel') {
    assert.equal(fit.lipidModel.others, 60);
    assert.ok(fit.models[0].gp.view, 'suggestions come from the kernel seen at the chosen lipid');
  }
  // filter mode on the same data fits the chosen lipid's runs only
  const pf = prepare(all, { space, goals, lipid: 'ALC315', mixer: 'T-mixer', lipidMode: 'filter', seed: 7 });
  const ff = fitPrepared(pf, { space, goals, seed: 7 });
  assert.equal(ff.n, 10);
  assert.match(modeSentence(ff), /Filter \(fixed by you\)/);
});

test('fingerprint: a run is reproduced exactly from its record, and an edited result is caught', () => {
  const rows = rowsFor(24, { seed: 31 });
  const o = { space: SPACE, goals: GOALS, constraints: [], lipid: 'SM102', mixer: 'T-mixer', lipidMode: 'filter', budget: 400, seed: 7, q: 3, mode: 'balanced', strategy: 'experiment', appVersion: '0.16.0' };
  const report = runOptimizer(rows, o);
  const fp = report.fingerprint;
  assert.match(fp.hash, /^[0-9a-f]{64}$/);
  assert.match(fp.dataHash, /^[0-9a-f]{64}$/);
  assert.equal(fp.n, 24); assert.equal(fp.ids.length, 24);
  assert.equal(fp.mlVersion, ML_CODE_VERSION); assert.equal(fp.appVersion, '0.16.0');
  assert.equal(fp.suggestions.length, 3);
  assert.ok(fp.hyper.PDI.lengthscales.length === 2 && fp.hyper.PDI.noiseVariance > 0);
  assert.equal(fp.setup.seed, 7); assert.equal(fp.setup.lipid, 'SM102');
  // the same records and setup: the same fingerprint, twice over
  assert.equal(runOptimizer(rows, o).fingerprint.hash, fp.hash);
  const r = reproduce(JSON.parse(JSON.stringify(fp)), rows, {});
  assert.equal(r.match, true, r.sentence);
  assert.match(r.sentence, /^Reproduced/);
  // a result corrected afterwards
  const edited = rows.map((x) => (x.batchId === 'B0005' ? { ...x, values: { ...x.values, PDI: x.values.PDI + 0.01 } } : x));
  const r2 = reproduce(fp, edited, {});
  assert.equal(r2.match, false); assert.equal(r2.data, false);
  assert.match(r2.sentence, /records have changed/);
  // a formulation gone
  const r3 = reproduce(fp, rows.slice(1), {});
  assert.equal(r3.match, false); assert.match(r3.sentence, /no longer in the records/);
  // canonical text does not depend on key order or last-bit noise
  assert.equal(canonical({ b: 1, a: [0.1 + 0.2] }), canonical({ a: [0.3], b: 1 }));
  assert.equal(hashOf({ x: 1 }), hashOf({ x: 1.0000000000001 }));
});

test('fingerprint: the rank of the lipid kernel is recorded and used again, so a rank-2 round reproduces', () => {
  const others = [...rowsFor(30, { lipid: 'SM102', seed: 21 }), ...rowsFor(30, { lipid: 'MC3', prefix: 'M', seed: 22, shift: 6, exp: (i) => `F${Math.floor(i / 6)}` })];
  const target = rowsFor(10, { lipid: 'ALC315', prefix: 'L', seed: 23, shift: -4, exp: (i) => `G${Math.floor(i / 5)}` });
  const goals = GOALS.filter((g) => g.name !== 'encapsulation_efficiency');
  const o = { space: SPACE, goals, constraints: [], lipid: 'ALC315', mixer: 'T-mixer', lipidMode: 'kernel', rank: 2, seed: 7, q: 2, mode: 'balanced', strategy: 'experiment' };
  const report = runOptimizer([...others, ...target], o);
  assert.equal(report.lipidChoice.mode, 'kernel');
  assert.equal(report.fingerprint.rank, 2);
  const r = reproduce(JSON.parse(JSON.stringify(report.fingerprint)), [...others, ...target], {});
  assert.equal(r.match, true, r.sentence);
  // the same round read as rank 1 is another model
  const r1 = reproduce({ ...report.fingerprint, rank: 1 }, [...others, ...target], {});
  assert.equal(r1.model, false);
});

test('fingerprint: a run over the data budget, with merged replicates, reproduces too', () => {
  const rows = rowsFor(130, { seed: 41 });
  for (let i = 0; i < 10; i++) rows[100 + i].factors = { ...rows[i].factors };
  const o = { space: SPACE, goals: GOALS, constraints: [], lipid: 'SM102', mixer: 'T-mixer', lipidMode: 'filter', budget: 100, seed: 7, q: 2, mode: 'balanced', strategy: 'experiment' };
  const report = runOptimizer(rows, o);
  assert.ok(report.selection.over && report.selection.steps.mergedGroups >= 10);
  assert.ok(report.fingerprint.ids.some(Array.isArray), 'a merged point records the runs merged into it');
  assert.ok(report.fingerprint.noise, 'and the replicate noise measured before merging');
  const r = reproduce(report.fingerprint, [...rows].reverse(), {});
  assert.equal(r.match, true, r.sentence);
});

test('the printed record of an ML round carries its fingerprint; other experiments print none', () => {
  const rows = rowsFor(12, { seed: 5 });
  const report = runOptimizer(rows, { space: SPACE, goals: GOALS, lipid: 'SM102', mixer: 'T-mixer', seed: 3, q: 2 });
  const html = fingerprintBlock({ design: { ml: { fingerprint: report.fingerprint } } });
  assert.match(html, /Model fingerprint/);
  assert.ok(html.includes(report.fingerprint.hash));
  assert.ok(html.includes(report.fingerprint.dataHash));
  assert.match(html, /lengthscales/);
  assert.equal(fingerprintBlock({ design: {} }), '');
  assert.ok(!/—/.test(html), 'no em dash in printed text');
});

test('more than 300 points reaching the model are warned about', () => {
  const rows = rowsFor(305, { seed: 6 });
  const fit = fitModels({ rows, space: SPACE.slice(0, 1), goals: GOALS.filter((g) => g.name === 'PDI'), seed: 1 });
  assert.ok(fit.warnings.some((w) => /305 points reach the model/.test(w)), fit.warnings.join(' | '));
  const few = fitModels({ rows: rows.slice(0, 20), space: SPACE, goals: GOALS, seed: 1 });
  assert.ok(!few.warnings.some((w) => /points reach the model/.test(w)));
});

test('prediction against measurement: hit rate inside the 95 % interval and its course over the rounds', () => {
  const rows = [];
  const rnd = mulberry32(3);
  for (let k = 0; k < 40; k++) {
    const mean = 80 + k, sd = 4, y = mean + randn(rnd) * sd;
    rows.push({ batchId: `X${k}`, experimentId: `R${Math.floor(k / 4)}`, experimentName: `ML round ${Math.floor(k / 4) + 1}`, date: `2026-0${1 + Math.floor(k / 8)}-1${k % 8}`,
      values: { particle_size_nm: y }, mlPredicted: { particle_size_nm: { mean, sd } } });
  }
  rows.push({ batchId: 'plain', values: { particle_size_nm: 90 }, mlPredicted: null });
  rows.push({ batchId: 'pending', values: {}, mlPredicted: { particle_size_nm: { mean: 90, sd: 3 } } });
  const c = predictionCheck(rows);
  assert.equal(c.overall.n, 40);
  assert.ok(c.overall.rate > 0.85 && c.overall.rate <= 1, `hit rate ${c.overall.rate}`);
  assert.equal(c.rounds.length, 10);
  assert.equal(c.rounds[9].cumulative, c.overall.rate);
  const pt = c.responses[0].points[0];
  assert.ok(Math.abs(pt.hi - pt.lo - 2 * 1.959964 * 4) < 1e-9);
  assert.match(hitRateSentence(c.overall), /of 40 results \(\d+ %\) fell inside/);
  assert.match(hitRateSentence({ n: 0 }), /No suggested formulation/);
});

test('biological targets: none without a layer switched on; log10 against the reference; in vivo locked', () => {
  const provider = () => [{ name: 'liver_luc', label: 'Liver signal', layer: 'invivo', read: (r) => r.bio },
    { name: 'hek_luc', label: 'HEK293 expression', layer: 'invitro', read: (r) => r.bio }];
  assert.deepEqual(biologicalTargets({}, {}, [provider]), []);
  assert.deepEqual(biologicalTargets({}, { bioLayers: { invitro: false } }, [provider]), []);
  const ts = biologicalTargets({}, { bioLayers: { invitro: true } }, [provider]);
  assert.deepEqual(ts.map((t) => t.name), ['hek_luc'], 'only the layer that is on');
  const both = biologicalTargets({}, { bioLayers: { invitro: true, invivo: true } }, [provider]);
  const goals = targetGoals(both);
  assert.equal(goals.find((g) => g.name === 'liver_luc').locked, 'In-vivo optimisation is not enabled in this version.');
  assert.equal(INVIVO_OPTIMISATION, false);
  assert.ok(goals.every((g) => g.on === false), 'never switched on by arriving');
  const rows = applyTargets([{ batchId: 'a', values: { PDI: 0.1 }, bio: { value: 1000, reference: 100, studyId: 'S1' } }, { batchId: 'b', values: {}, bio: null }], ts);
  assert.equal(rows[0].values.hek_luc, 1);
  assert.equal(rows[0].studyId, 'S1');
  assert.equal(rows[1].values.hek_luc, undefined);
  assert.equal(normalisedLog(0, 10), null);
  // size and PDI as hard limits instead of goals
  const { goals: g2, constraints } = physchemAsLimits(DEFAULT_GOALS.map((g) => ({ ...g })));
  assert.ok(g2.filter((g) => ['particle_size_nm', 'PDI'].includes(g.name)).every((g) => g.on === false));
  assert.ok(constraints.some((c) => c.name === 'PDI' && c.op === '<'));
  assert.ok(constraints.some((c) => c.name === 'particle_size_nm' && c.op === '>'));
});

test('loading pH and buffer molarity are factors read from the process record, offered only once varied', () => {
  const keys = PROCESS_FACTORS.map((f) => f.key);
  assert.deepEqual(keys.slice(0, 6), ['frr', 'tfr', 'np', 'quench', 'lipid_mM', 'rna_mg_mL'], 'the existing six are unchanged and first');
  assert.ok(keys.includes('loadingPH') && keys.includes('bufferMolarity_mM'));
  const ref = { compositionById: {}, lipidByKey: {} };
  const b = (ph, mM) => ({ id: 'x', plan: { mixing: { frr: 3 }, conditions: { loadingPH: ph, bufferMolarity_mM: mM } } });
  assert.equal(readFactors(b(4.5, 50), ref).loadingPH, 4.5);
  assert.equal(readFactors({ plan: {} }, ref).loadingPH, null);
  const never = Array.from({ length: 10 }, (_, i) => ({ factors: { frr: 2 + i * 0.3, loadingPH: null, bufferMolarity_mM: 25 } }));
  const s1 = suggestSpace(never).map((f) => f.key);
  assert.ok(!s1.includes('loadingPH') && !s1.includes('bufferMolarity_mM'), 'never recorded, or never varied, is never offered');
  const varied = never.map((r, i) => ({ factors: { ...r.factors, loadingPH: 4 + (i % 4) * 0.5 } }));
  assert.ok(suggestSpace(varied).some((f) => f.key === 'loadingPH'));
  const plan = pointToPlan({ frr: 3, loadingPH: 5 }, [{ key: 'frr', lo: 2, hi: 5 }, { key: 'loadingPH', lo: 3, hi: 6.5 }]).plan;
  assert.equal(plan.loadingPH, 5);
});

test('a measurement not to be believed is a quality issue; a result outside the QC limits is not', () => {
  const ms = [{ id: 'm1', test: 'dls', values: { zave_nm: 90, pdi: 0.35 }, flags: [{ level: 'warn', text: 'PDI 0.35 > 0.2' }] },
    { id: 'm2', test: 'dls', values: { zave_nm: 90, pdi: 0.1 }, flags: [{ level: 'warn', text: 'count rate 5 kcps low' }] },
    { id: 'm3', test: 'ee', values: { ee_pct: 120 } }];
  assert.deepEqual(qualityIssues(ms, { PDI: { id: 'm1' } }), [], 'a high PDI is what the formulation did');
  assert.equal(qualityIssues(ms, { PDI: { id: 'm2' } }).length, 1);
  assert.equal(qualityIssues(ms, { encapsulation_efficiency: { id: 'm3' } }).length, 1, 'an impossible value');
  assert.deepEqual(qualityIssues(ms, {}), [], 'only the measurements a response was read from');
});

test('the historical benchmark replays a campaign with only the runs that were made', async () => {
  const { replay, simulated } = await import('./usability/history.mjs');
  const { rows, space } = simulated(4, 40);
  const r = replay(rows, space, { q: 4 });
  assert.equal(r.n, 40);
  assert.ok(r.replay >= 1 && r.replay <= 40);
  assert.ok(r.historical >= 1 && r.historical <= 40);
  assert.equal(r.historyTrace.length, 40);
  assert.equal(r.replayTrace[r.replay - 1], r.bestD, 'the replay stops once the best recipe is revealed');
  assert.deepEqual(replay(rows, space, { q: 4 }).replayTrace, r.replayTrace, 'deterministic');
});
