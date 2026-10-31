// The ML module's maths, checked against cases with known answers. The closed-loop check at the end is the
// one that matters: a suggestion engine that cannot beat random search is worse than useless, because it
// spends real batches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cholesky, cholSolve, cholLogDet, normCdf, normInv, matVec, mulberry32 } from '../app/calc/ml/linalg.js';
import { fitGP, looPredictions, extendGP, defaultPriors, SIGNAL_VARIANCE, MIN_LENGTHSCALE, NOISE_PRIOR } from '../app/calc/ml/gp.js';
import { desirability, overallDesirability, paretoFront, DEFAULT_GOALS } from '../app/calc/ml/objective.js';
import { snap, toUnit, fromUnit, pointToPlan, mixtureInfo, readFactors, suggestSpace, COMPOSITION_FACTORS } from '../app/calc/ml/space.js';
import { suggestRuns, latinHypercube, maxNormDistance, expectedImprovement, probFeasible } from '../app/calc/ml/acquire.js';
import { evaluateResponse, buildFolds, crossValidate, LEARNERS, standardise, verdict, spearman, hitRate, oneFactorAtATime, nullDistribution, fitQuadratic } from '../app/calc/ml/model.js';
import { noiseFromReplicates, replicateGroups } from '../app/calc/ml/dataset.js';
import { permutationImportance, partialDependence, ardImportance, collapseCheck } from '../app/calc/ml/explain.js';
import { startingDesign, readinessFor, analyse, fitModels, score, predictAt } from '../app/calc/ml/optimizer.js';
import { checkSetting, checkSuggestions } from '../app/calc/ml/feasible.js';
import { goalProblems } from '../app/ui/ml.js';

test('Cholesky solve, log determinant and the normal distribution helpers are exact', () => {
  const A = [[4, 2, 1], [2, 5, 3], [1, 3, 6]];
  const { L } = cholesky(A);
  const x = cholSolve(L, [1, 2, 3]);
  matVec(A, x).forEach((v, i) => assert.ok(Math.abs(v - [1, 2, 3][i]) < 1e-12, 'A x = b'));
  assert.ok(Math.abs(cholLogDet(L) - Math.log(67)) < 1e-10, 'log|A| = log 67');
  assert.ok(Math.abs(normCdf(1.959964) - 0.975) < 1e-5);
  assert.ok(Math.abs(normInv(0.975) - 1.959964) < 1e-6);
  assert.ok(Math.abs(normCdf(normInv(0.3)) - 0.3) < 1e-6);
  assert.equal(cholesky([[1, 2], [2, 1]], { jitters: [0] }), null, 'indefinite matrix is refused');
});

test('the Gaussian process interpolates, and its uncertainty grows away from the data', () => {
  const f = (x) => Math.sin(6 * x);
  const X = [0.05, 0.2, 0.35, 0.5, 0.62, 0.78, 0.95].map((v) => [v]);
  const s = standardise(X.map((r) => f(r[0])));
  const gp = fitGP(X, s.z, {});
  assert.ok(gp, 'fit succeeds');
  for (const t of [0.1, 0.28, 0.45, 0.7, 0.9]) {
    const p = gp.predict([t]);
    assert.ok(Math.abs(p.mean * s.sd + s.mean - f(t)) < 0.25, `interpolates near ${t}`);
  }
  assert.ok(gp.predict([0.2]).sd < 0.25, 'confident at a training point');
  assert.ok(gp.predict([2.5]).sd > 0.8, 'unsure far outside the data');
  assert.equal(gp.lengthscales.length, 1);
  const loo = looPredictions(gp);
  assert.equal(loo.length, X.length);
  assert.ok(loo.every((p) => p.variance > 0));
});

test('one lengthscale per factor: the GP ignores a factor that does nothing', () => {
  const rnd = mulberry32(3);
  const X = Array.from({ length: 28 }, () => [rnd(), rnd(), rnd()]);
  const s = standardise(X.map((x) => 3 * x[0] + 0.3 * x[1]));
  const gp = fitGP(X, s.z, {});
  assert.ok(gp.lengthscales[0] < gp.lengthscales[1], 'the strong factor gets the shorter lengthscale');
  assert.ok(gp.lengthscales[1] < gp.lengthscales[2], 'the irrelevant factor gets the longest');
  const imp = permutationImportance(gp, X, s.z, [{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
  assert.equal(imp[0].key, 'a');
  assert.ok(imp[0].share > 0.6, 'the driving factor takes most of the importance');
  assert.equal(ardImportance(gp, [{ key: 'a' }, { key: 'b' }, { key: 'c' }])[0].key, 'a');
  const pd = partialDependence(gp, X, [{ key: 'a', lo: 0, hi: 1 }, { key: 'b', lo: 0, hi: 1 }, { key: 'c', lo: 0, hi: 1 }], 0, { n: 8 });
  assert.ok(pd[pd.length - 1].mean > pd[0].mean, 'partial dependence rises with the driving factor');
});

test('conditioning on a fantasy point removes the uncertainty there', () => {
  const X = [[0.1], [0.4], [0.9]];
  const gp = fitGP(X, standardise([0.2, 0.7, 0.1]).z, {});
  const before = gp.predict([0.65]).sd;
  const after = extendGP(gp, [[0.65]], [gp.predict([0.65]).mean]).predict([0.65]).sd;
  assert.ok(after < before * 0.7, `uncertainty drops at the fantasised point (${before.toFixed(3)} → ${after.toFixed(3)})`);
});

test('the lengthscale prior scales with the number of factors, and the signal variance is fixed', () => {
  // The dimension-scaled prior of Hvarfner et al. (ICML 2024): ln l ~ N(sqrt(2) + ln(D)/2, sqrt(3)).
  // Distances between random points in the unit cube grow as sqrt(D), so lengthscales must grow with them
  // for the prior to mean the same thing at three factors and at eight.
  for (const D of [2, 4, 8]) {
    const pr = defaultPriors(D);
    assert.equal(pr.length, D + 1, 'one lengthscale per factor plus the noise');
    assert.ok(Math.abs(pr[0].mu - (Math.SQRT2 + Math.log(D) / 2)) < 1e-12);
    assert.ok(Math.abs(pr[0].sd - Math.sqrt(3)) < 1e-12);
  }
  assert.ok(defaultPriors(8)[0].mu > defaultPriors(2)[0].mu, 'more factors, longer expected lengthscales');
  const rnd = mulberry32(3);
  const X = Array.from({ length: 20 }, () => [rnd(), rnd(), rnd()]);
  const gp = fitGP(X, standardise(X.map((x) => 2 * x[0] + x[1])).z, {});
  assert.equal(gp.sf2, SIGNAL_VARIANCE, 'the signal variance is not fitted: standardised outputs make it 1');
  assert.ok(gp.lengthscales.every((l) => l >= MIN_LENGTHSCALE - 1e-12), 'no lengthscale collapses below the floor');
});

test('multistart buys almost nothing once the prior is informative, which is why two starts are enough', () => {
  // The standard advice is 8 to 16 restarts, but that is advice for maximum likelihood, where the surface has
  // several optima. Under the dimension-scaled prior this module uses, the extra starts find the same answer.
  const rnd = mulberry32(17);
  const g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  let one = 0, many = 0;
  for (let rep = 0; rep < 4; rep++) {
    const D = 4, n = 22;
    const X = Array.from({ length: n }, () => Array.from({ length: D }, () => rnd()));
    const y = standardise(X.map((x) => 3 * Math.sin(2.2 * x[0]) + Math.sin(2.2 * x[1]) + 0.1 * x[2] + g() * 0.15)).z;
    one += fitGP(X, y, { restarts: 1, seed: 5 }).logMarginalLikelihood;
    many += fitGP(X, y, { restarts: 8, seed: 5 }).logMarginalLikelihood;
  }
  assert.ok(many >= one - 1e-6, 'more starts never finds a worse optimum');
  assert.ok(many - one < 0.5, `eight starts should not beat one by much (gained ${(many - one).toFixed(3)} nats over 4 fits)`);
});

test('replicate scatter anchors the noise without freezing it', () => {
  const rnd = mulberry32(9);
  const g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const base = Array.from({ length: 12 }, () => [rnd(), rnd()]);
  const X = [...base, ...base.slice(0, 4)];
  const y = X.map((x) => 5 * Math.sin(2 * x[0]) + 2 * x[1] + g() * 0.8);
  const rows = X.map((_, i) => ({ experimentId: `E${i % 3}` }));
  const free = evaluateResponse({ X, y, rows, strategy: 'experiment', nullCheck: false });
  const measured = evaluateResponse({ X, y, rows, strategy: 'experiment', nullCheck: false, noiseSd: 0.8, noiseDf: 4 });
  assert.equal(free.gp.noiseFixed, false);
  assert.equal(measured.gp.noiseFixed, false, 'an estimate from a handful of repeats is evidence, not a fact');
  assert.ok(measured.gp.sn2 > free.gp.sn2, 'the measured noise is larger than the fit would have inferred, and raises it');
  assert.ok(measured.noiseVar > 0);

  // The estimate is evidence about the noise, so its grip has to tighten with the degrees of freedom behind it.
  // One repeat should leave the fit free to disagree; fifty should not. Binois et al. 2018 (p. 26) is the
  // reason this matters: a pooled estimate from very few repeats is not to be believed outright.
  const target = (0.8 / standardise(y).sd) ** 2;
  const off = (df) => {
    const m = evaluateResponse({ X, y, rows, strategy: 'experiment', nullCheck: false, noiseSd: 0.8, noiseDf: df });
    return Math.abs(Math.log(m.gp.sn2) - Math.log(target));
  };
  assert.ok(off(50) < off(1) + 1e-9, `fifty degrees of freedom should hold the noise nearer the measurement than one (${off(50).toFixed(3)} vs ${off(1).toFixed(3)})`);
  // and the replicate estimator itself
  const rows2 = [...base, ...base.slice(0, 4)].map((f, i) => ({ factors: { a: f[0], b: f[1] }, values: { v: y[i] } }));
  const space = [{ key: 'a', lo: 0, hi: 1 }, { key: 'b', lo: 0, hi: 1 }];
  const est = noiseFromReplicates(rows2, space, 'v');
  assert.ok(est && est.df === 4, `four replicated settings give four degrees of freedom, got ${est?.df}`);
  assert.ok(Math.abs(est.sd - 0.8) < 0.6, `the pooled estimate should land near the true 0.8, got ${est.sd.toFixed(2)}`);
});

test('one repeat that happens to agree does not set the noise; thirty degrees of freedom do', () => {
  // Following "stop and confirm" means one repeat of the model's pick. When it measured close to the first, its
  // single degree of freedom used to become the centre of the noise prior: the noise fell to the pair's scatter,
  // the surface grew sure of itself around the pick, and the next verdict said another round was worth it
  // (benchmark seed 23: a 9 % chance before the repeat, 61 % after). Two batches that agree say little about how
  // far the next two may differ, so the estimate enters as the likelihood it is (gp.js, fitGP).
  const rnd = mulberry32(3);
  const g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const X = Array.from({ length: 10 }, () => [rnd(), rnd(), rnd()]);
  X.push([...X[0]]);
  const y = X.map((x) => 3 * Math.sin(2 * x[0]) + 2 * x[1] - x[2] + g() * 0.6);
  y[10] = y[0] + 0.02; // the repeat agrees to 0.02, against a true scatter of 0.6
  const s = standardise(y);
  const noise = (m) => Math.sqrt(m.sn2) * s.sd;
  const free = fitGP(X, s.z, {});
  const one = fitGP(X, s.z, { noisePrior: { var: ((y[10] - y[0]) ** 2 / 2) / s.sd ** 2, df: 1 } });
  assert.ok(noise(one) > 0.6 * noise(free), `one agreeing repeat took the noise from ${noise(free).toFixed(3)} to ${noise(one).toFixed(3)}`);
  const many = fitGP(X, s.z, { noisePrior: { var: (0.6 / s.sd) ** 2, df: 30 } });
  assert.ok(Math.abs(noise(many) - 0.6) < 0.15, `thirty degrees of freedom at the true 0.6 should hold the noise near it, got ${noise(many).toFixed(3)}`);
  // and a repeat that disagrees widely is real evidence of a larger noise, even alone
  const wide = fitGP(X, s.z, { noisePrior: { var: (1.5 / s.sd) ** 2, df: 1 } });
  assert.ok(noise(wide) > 1.5 * noise(free), `one widely different repeat should raise the noise, got ${noise(wide).toFixed(3)} from ${noise(free).toFixed(3)}`);
});

test('the module proposes a repeat of its own best run, which no acquisition function would', () => {
  // Expected improvement gives no value to re-running a setting already measured, so an optimiser left alone
  // never confirms its incumbent — and chases it even if that one result was a lucky measurement.
  const rnd = mulberry32(21);
  const space = [{ key: 'frr', lo: 2, hi: 6, step: 0.1 }, { key: 'tfr', lo: 20, hi: 150, step: 1 }];
  const obs = Array.from({ length: 14 }, () => {
    const point = { frr: 2 + rnd() * 4, tfr: 20 + rnd() * 130 };
    return { point, batchId: 'B' + Math.round(rnd() * 1e6), values: { ee: 70 + 20 * Math.exp(-((point.frr - 4) ** 2) / 2) + rnd() } };
  });
  const X = obs.map((o) => toUnit(o.point, space));
  const s = standardise(obs.map((o) => o.values.ee));
  const models = [{ name: 'ee', gp: fitGP(X, s.z, {}), yMean: s.mean, ySd: s.sd }];
  const goals = [{ name: 'ee', goal: 'maximize', worst: 70, best: 95, weight: 1, on: true }];
  const r = suggestRuns({ models, space, goals, observed: obs, q: 2, mode: 'balanced', seed: 5, nCandidates: 400, samples: 64 });
  assert.ok(r.confirm, 'with no repeat of the best run, a confirmation is advised');
  assert.deepEqual(r.confirm.point, r.bestRun.point, 'and it is a repeat of that exact setting');
  assert.ok(/never been repeated/.test(r.confirm.reason));
  // once a repeat exists the advice stops
  const withRepeat = [...obs, { point: { ...r.bestRun.point }, batchId: 'REPEAT', values: { ...r.bestRun.values } }];
  const X2 = withRepeat.map((o) => toUnit(o.point, space));
  const s2 = standardise(withRepeat.map((o) => o.values.ee));
  const r2 = suggestRuns({ models: [{ name: 'ee', gp: fitGP(X2, s2.z, {}), yMean: s2.mean, ySd: s2.sd }], space, goals,
    observed: withRepeat, q: 2, mode: 'balanced', seed: 5, nCandidates: 400, samples: 64 });
  assert.equal(r2.confirm, null, 'and is not repeated once the run has been confirmed');
});

test('half-and-half mode places half the batch to win and half to learn', () => {
  const rnd = mulberry32(44);
  const space = [{ key: 'frr', lo: 2, hi: 6, step: 0.1 }, { key: 'tfr', lo: 20, hi: 150, step: 1 }];
  const obs = Array.from({ length: 16 }, () => {
    const point = { frr: 2 + rnd() * 4, tfr: 20 + rnd() * 130 };
    return { point, values: { ee: 70 + 20 * Math.exp(-((point.frr - 4) ** 2) / 2) + rnd() } };
  });
  const X = obs.map((o) => toUnit(o.point, space));
  const s = standardise(obs.map((o) => o.values.ee));
  const models = [{ name: 'ee', gp: fitGP(X, s.z, {}), yMean: s.mean, ySd: s.sd }];
  const goals = [{ name: 'ee', goal: 'maximize', worst: 70, best: 95, weight: 1, on: true }];
  const { picks } = suggestRuns({ models, space, goals, observed: obs, q: 4, mode: 'split', seed: 8, nCandidates: 500, samples: 64 });
  assert.equal(picks.filter((p) => p.purpose === 'win').length, 2);
  assert.equal(picks.filter((p) => p.purpose === 'learn').length, 2);
  const sdOf = (p) => p.predicted.ee.sd;
  assert.ok(Math.max(...picks.filter((p) => p.purpose === 'learn').map(sdOf)) >= Math.max(...picks.filter((p) => p.purpose === 'win').map(sdOf)),
    'the runs placed to learn sit where the model is less sure');
});

test('Derringer-Suich desirability: endpoints, midpoints, and one bad response sinking the batch', () => {
  const t = { goal: 'target', target: 80, lo: 50, hi: 120, exponent: 1 };
  assert.equal(desirability(80, t), 1);
  assert.equal(desirability(50, t), 0);
  assert.equal(desirability(120, t), 0);
  assert.equal(desirability(130, t), 0, 'outside the acceptable range is unacceptable');
  assert.ok(Math.abs(desirability(65, t) - 0.5) < 1e-9, 'linear between the low limit and the target');
  assert.ok(Math.abs(desirability(100, t) - 0.5) < 1e-9, 'linear between the target and the high limit');
  const mn = { goal: 'minimize', best: 0.05, worst: 0.3 };
  assert.equal(desirability(0.04, mn), 1); assert.equal(desirability(0.31, mn), 0);
  const mx = { goal: 'maximize', worst: 70, best: 95 };
  assert.equal(desirability(96, mx), 1); assert.equal(desirability(69, mx), 0);
  const curved = desirability(65, { ...t, exponent: 2 });
  assert.ok(curved < 0.5, 'an exponent above 1 demands results closer to the ideal');

  // An acceptance band: everything inside is equally good, which a target curve cannot express. This is the
  // shape Maharjan et al. 2024 specify particle size with, and the shape a release specification has.
  const band = { goal: 'range', lo: 40, hi: 120 };
  for (const y of [40, 60, 80, 120]) assert.equal(desirability(y, band), 1, `${y} is inside the band`);
  assert.ok(desirability(30, band) > 0 && desirability(30, band) < 1, 'just outside falls away rather than off a cliff');
  assert.equal(desirability(0, band), 0, 'far outside is unacceptable');
  assert.equal(desirability(141, band), 0, 'and symmetrically on the high side');
  assert.ok(desirability(130, band) > desirability(135, band), 'a near miss beats a wild one');

  const goals = DEFAULT_GOALS.filter((g) => g.on);
  // Read the ideal off the goals rather than repeating the numbers here, so a change of limits shows up as
  // a failure in the goals themselves and not as a puzzle in this file.
  const ideal = Object.fromEntries(goals.map((g) => [g.name, g.goal === 'target' ? g.target : g.goal === 'range' ? (g.lo + g.hi) / 2 : g.best]));
  const good = overallDesirability(ideal, goals);
  assert.ok(Math.abs(good.D - 1) < 1e-6, 'everything ideal gives 1');
  assert.equal(overallDesirability({ ...ideal, PDI: 0.35 }, goals).D, 0,
    'one unacceptable response sinks the whole batch');
  const weighted = overallDesirability({ ...ideal, particle_size_nm: 65 },
    goals.map((g) => (g.name === 'particle_size_nm' ? { ...g, weight: 3 } : g)));
  const even = overallDesirability({ ...ideal, particle_size_nm: 65 }, goals);
  assert.ok(weighted.D < even.D, 'weighting a response up makes its shortfall count for more');
});

test('the Pareto front keeps runs nothing beats on every goal at once', () => {
  const goals = DEFAULT_GOALS.filter((g) => g.on);
  const rows = [
    { batchId: 'A', particle_size_nm: 80, PDI: 0.10, encapsulation_efficiency: 90 },
    { batchId: 'B', particle_size_nm: 85, PDI: 0.20, encapsulation_efficiency: 80 }, // beaten by A on all three
    { batchId: 'C', particle_size_nm: 120, PDI: 0.05, encapsulation_efficiency: 95 },
  ];
  const front = paretoFront(rows, goals).map((r) => r.batchId).sort();
  assert.deepEqual(front, ['A', 'C']);
});

test('the design space snaps to what a pump can do and survives the round trip', () => {
  const space = [{ key: 'frr', lo: 2, hi: 6, step: 0.1 }, { key: 'tfr', lo: 20, hi: 150, step: 1 }];
  const p = snap({ frr: 3.14159, tfr: 97.6 }, space);
  assert.deepEqual(p, { frr: 3.1, tfr: 98 });
  assert.deepEqual(snap(fromUnit(toUnit(p, space), space), space), p);
  assert.deepEqual(snap({ frr: 99, tfr: -5 }, space), { frr: 6, tfr: 20 }, 'clipped into the space');
});

test('lipid mol% totals 100 exactly, and a batch written by the module reads back unchanged', () => {
  const space = [{ key: 'ionizable_pct', lo: 35, hi: 60, step: 0.5 }, { key: 'peg_pct', lo: 0.5, hi: 3, step: 0.1 }];
  const mix = mixtureInfo(space);
  assert.equal(mix.balance, 'sterol', 'cholesterol balances when it is not being varied');
  const { composition } = pointToPlan({ ionizable_pct: 50, peg_pct: 1.5 }, space, {});
  const total = ['ionizable', 'helper', 'peg', 'sterol', 'other'].reduce((s, k) => s + composition[k], 0);
  assert.ok(Math.abs(total - 100) < 1e-9, `mol% totals 100, got ${total}`);
  const back = readFactors({ compositionId: 1, plan: { compositionOverride: composition, rna: {}, mixing: {}, factors: {} } },
    { compositionById: {}, lipidByKey: {} });
  assert.equal(back.ionizable_pct, 50);
  assert.equal(back.peg_pct, 1.5);
  assert.ok(Math.abs(back.sterol_pct - 38.5) < 1e-9, 'the balance lipid took up the slack');
  // the DoE screen writes the other spelling; both must be readable
  assert.equal(readFactors({ compositionId: 1, plan: { compositionOverride: { peg_pct: 2.2 }, rna: {}, mixing: {}, factors: {} } },
    { compositionById: {}, lipidByKey: {} }).peg_pct, 2.2);
  // every composition class varied: nothing is free to balance, and the module says so
  const all = COMPOSITION_FACTORS.map((c) => ({ key: c.key, lo: c.lo, hi: c.hi }));
  assert.ok(pointToPlan({ ionizable_pct: 60, helper_pct: 20, peg_pct: 3, sterol_pct: 55 }, all, {}).warnings.length);
});

test('a factor never varied is not offered as something to optimise', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ factors: { frr: 2 + i * 0.3, tfr: 100, np: 6 } }));
  const space = suggestSpace(rows);
  assert.ok(space.some((s) => s.key === 'frr'), 'a varied factor is offered');
  assert.ok(!space.some((s) => s.key === 'tfr'), 'a constant factor is not');
  assert.ok(!space.some((s) => s.key === 'np'), 'nor is a second constant factor');
  const frr = space.find((s) => s.key === 'frr');
  assert.ok(frr.lo <= 2 && frr.hi >= 4.7, 'the search range covers what was run');
});

test('grouped folds hold out whole experiments, not single runs', () => {
  const rows = [{ experimentId: 'A' }, { experimentId: 'A' }, { experimentId: 'B' }, { experimentId: 'B' }, { experimentId: 'C' }];
  const folds = buildFolds(rows, 'experiment');
  assert.equal(folds.length, 3);
  assert.deepEqual(folds[0].test, [0, 1], 'both runs of experiment A are held out together');
  assert.equal(buildFolds(rows.map(() => ({ experimentId: 'A' })), 'experiment').length, 5,
    'with only one experiment it falls back to leaving one run out');
  const tf = buildFolds([{ date: '2026-01-01' }, { date: '2026-02-01' }, { date: '2026-03-01' }, { date: '2026-04-01' }, { date: '2026-05-01' }], 'time');
  assert.ok(tf.every((f) => f.train.every((i) => i < f.test[0])), 'the time split never trains on the future');
});

test('a random split flatters a model that a grouped split exposes', () => {
  // Each "experiment" sits at its own offset: a model can memorise the offsets and look good on a random
  // split while knowing nothing transferable. The grouped split is what catches that.
  const rnd = mulberry32(9);
  const rows = [], X = [], y = [];
  for (let e = 0; e < 5; e++) {
    const offset = (e - 2) * 20;
    for (let i = 0; i < 5; i++) {
      const x = [rnd(), rnd()];
      X.push(x); y.push(offset + rnd() * 0.5); rows.push({ experimentId: `E${e}` });
    }
  }
  const byRun = crossValidate(LEARNERS.gp, X, y, buildFolds(rows, 'run'));
  const byExp = crossValidate(LEARNERS.gp, X, y, buildFolds(rows, 'experiment'));
  assert.ok(byExp.q2 < byRun.q2, `grouped Q² (${byExp.q2?.toFixed(2)}) is below leave-one-run-out Q² (${byRun.q2?.toFixed(2)})`);
  assert.ok(byExp.q2 < 0.3, 'and it correctly reports that nothing transferable was learned');
});

test('the trust verdict is honest about a model that is worse than guessing the average', () => {
  assert.equal(verdict({ q2: -0.4, rmse: 10 }, { rmse: 8 }, 20, 3, 4).level, 'none');
  assert.equal(verdict({ q2: 0.15, rmse: 7 }, { rmse: 8 }, 20, 3, 4).level, 'weak');
  assert.equal(verdict({ q2: 0.45, rmse: 5 }, { rmse: 8 }, 20, 3, 4).level, 'fair');
  assert.equal(verdict({ q2: 0.7, rmse: 3 }, { rmse: 8 }, 20, 3, 4).level, 'good');
  assert.equal(verdict({ q2: 0.9, rmse: 2 }, { rmse: 8 }, 20, 3, 4).level, 'strong');
  assert.equal(verdict(null, null, 3, 2, 1).level, 'none');
  assert.ok(/fewer than five runs per factor/.test(verdict({ q2: 0.45, rmse: 5 }, { rmse: 8 }, 8, 4, 3).detail),
    'thin data is called out');
});

test('the response surface reports which terms it could actually fit', () => {
  const rnd = mulberry32(31);
  const mk = (n, D) => Array.from({ length: n }, () => Array.from({ length: D }, () => rnd()));
  // With 5 factors the three models need 6, 11 and 21 terms, and each needs more than two spare runs.
  const few = fitQuadratic(mk(12, 5), Array.from({ length: 12 }, () => rnd()));
  assert.equal(few.level, 'main effects only');
  assert.equal(few.nTerms, 6, 'intercept plus five main effects');
  const some = fitQuadratic(mk(16, 5), Array.from({ length: 16 }, () => rnd()));
  assert.equal(some.level, 'quadratic, no interactions');
  assert.equal(some.nTerms, 11);
  const all = fitQuadratic(mk(40, 5), Array.from({ length: 40 }, () => rnd()));
  assert.equal(all.level, 'quadratic with interactions');
  assert.equal(all.nTerms, 21);
  // the boundaries are where the term count plus two spare runs is crossed
  assert.equal(fitQuadratic(mk(13, 5), Array.from({ length: 13 }, () => rnd())).level, 'main effects only');
  assert.equal(fitQuadratic(mk(14, 5), Array.from({ length: 14 }, () => rnd())).level, 'quadratic, no interactions');
  assert.equal(fitQuadratic(mk(23, 5), Array.from({ length: 23 }, () => rnd())).level, 'quadratic, no interactions');
  assert.equal(fitQuadratic(mk(24, 5), Array.from({ length: 24 }, () => rnd())).level, 'quadratic with interactions');
  // and the level travels with the evaluation so the screen cannot claim terms that were never fitted
  const X = mk(12, 5), y = X.map((x) => x[0] + rnd() * 0.1);
  const ev = evaluateResponse({ X, y, rows: X.map((_, i) => ({ experimentId: `E${i % 3}` })), nullCheck: false });
  assert.equal(ev.quadLevel, 'main effects only');
});

test('every learner is compared against the predict-the-average baseline', () => {
  const rnd = mulberry32(12);
  const X = Array.from({ length: 24 }, () => [rnd(), rnd()]);
  const y = X.map((x) => 10 + 5 * x[0] - 3 * x[1] + rnd() * 0.3);
  const rows = X.map((_, i) => ({ experimentId: `E${i % 4}` }));
  const ev = evaluateResponse({ X, y, rows, strategy: 'experiment' });
  assert.ok(ev.results.some((r) => r.key === 'dummy'), 'the baseline is always reported');
  assert.ok(ev.best.q2 > ev.dummy.q2, 'the chosen model beats the baseline on this learnable problem');
  assert.ok(ev.gp, 'a Gaussian process is fitted even when another model cross-validates better');
  assert.equal(ev.foldPredictions.length, X.length);
});

test('a Latin hypercube spreads out, and the starting design does better than clustering', () => {
  const rnd = mulberry32(2);
  const pts = latinHypercube(10, 2, rnd);
  for (let j = 0; j < 2; j++) {
    const bins = new Set(pts.map((p) => Math.floor(p[j] * 10)));
    assert.equal(bins.size, 10, 'each column uses every stratum exactly once');
  }
  const space = [{ key: 'frr', lo: 2, hi: 6, step: 0.1 }, { key: 'tfr', lo: 20, hi: 150, step: 1 }, { key: 'peg_pct', lo: 0.5, hi: 3, step: 0.1 }];
  const design = startingDesign(space, 8, 5);
  assert.equal(design.length, 8);
  assert.ok(design.every((p) => space.every((s) => p[s.key] >= s.lo && p[s.key] <= s.hi)), 'inside the space');
  const units = design.map((p) => toUnit(p, space));
  let worst = Infinity;
  for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) worst = Math.min(worst, maxNormDistance(units[i], units[j]));
  assert.ok(worst > 0.1, `no two starting runs are near-duplicates (closest ${worst.toFixed(2)})`);
});

test('expected improvement rewards upside and the feasibility probability respects a hard limit', () => {
  const goals = [{ name: 'ee', goal: 'maximize', worst: 70, best: 95, weight: 1, on: true }];
  const rnd = mulberry32(4);
  const certainAtBest = expectedImprovement({ ee: { mean: 85, sd: 0.01 } }, goals, [], 0.6, { samples: 400, rnd, xi: 0 });
  const uncertain = expectedImprovement({ ee: { mean: 85, sd: 8 } }, goals, [], 0.6, { samples: 400, rnd: mulberry32(4), xi: 0 });
  assert.ok(uncertain.ei > certainAtBest.ei, 'the same expected value with more uncertainty is worth more to try');
  const hopeless = expectedImprovement({ ee: { mean: 71, sd: 0.01 } }, goals, [], 0.6, { samples: 200, rnd: mulberry32(4), xi: 0 });
  assert.ok(hopeless.ei < 1e-6, 'a setting certain to be worse than the best run scores nothing');
  assert.ok(Math.abs(probFeasible({ PDI: { mean: 0.2, sd: 0.05 } }, [{ name: 'PDI', op: '<', value: 0.2 }]) - 0.5) < 0.01);
  assert.ok(probFeasible({ PDI: { mean: 0.1, sd: 0.02 } }, [{ name: 'PDI', op: '<', value: 0.2 }]) > 0.99);
});

test('a suggested batch contains genuinely different runs', () => {
  const rnd = mulberry32(21);
  const space = [{ key: 'frr', lo: 2, hi: 6, step: 0.1 }, { key: 'tfr', lo: 20, hi: 150, step: 1 }];
  const obs = Array.from({ length: 14 }, () => {
    const point = { frr: 2 + rnd() * 4, tfr: 20 + rnd() * 130 };
    return { point, values: { ee: 70 + 20 * Math.exp(-((point.frr - 4) ** 2) / 2) + rnd() } };
  });
  const X = obs.map((o) => toUnit(o.point, space));
  const s = standardise(obs.map((o) => o.values.ee));
  const models = [{ name: 'ee', gp: fitGP(X, s.z, {}), yMean: s.mean, ySd: s.sd }];
  const goals = [{ name: 'ee', label: 'EE', goal: 'maximize', worst: 70, best: 95, weight: 1, on: true }];
  const { picks } = suggestRuns({ models, space, goals, observed: obs, q: 4, mode: 'balanced', seed: 5, nCandidates: 600, samples: 64 });
  assert.equal(picks.length, 4);
  for (let i = 0; i < picks.length; i++) for (let j = i + 1; j < picks.length; j++) {
    assert.ok(maxNormDistance(picks[i].unit, picks[j].unit) >= 0.04,
      `suggestions ${i + 1} and ${j + 1} are not near-duplicates`);
  }
  assert.ok(picks.every((p) => p.point.frr >= 2 && p.point.frr <= 6 && p.point.tfr >= 20 && p.point.tfr <= 150));
  assert.ok(picks.every((p) => typeof p.rationale === 'string' && p.rationale.length > 10), 'each suggestion explains itself');
  const again = suggestRuns({ models, space, goals, observed: obs, q: 4, mode: 'balanced', seed: 5, nCandidates: 600, samples: 64 });
  assert.deepEqual(again.picks.map((p) => p.point), picks.map((p) => p.point), 'the same seed gives the same proposals');
});

test('a hard limit keeps the optimiser out of settings that would breach it', () => {
  const rnd = mulberry32(31);
  const space = [{ key: 'frr', lo: 2, hi: 6, step: 0.1 }];
  // EE is best at high FRR, but PDI blows up there: the limit must win.
  const obs = Array.from({ length: 16 }, (_, i) => {
    const frr = 2 + (i / 15) * 4;
    return { point: { frr }, values: { ee: 70 + 6 * frr + rnd() * 0.5, PDI: 0.05 + 0.06 * Math.max(0, frr - 3.5) + rnd() * 0.004 } };
  });
  const X = obs.map((o) => toUnit(o.point, space));
  const models = ['ee', 'PDI'].map((name) => {
    const s = standardise(obs.map((o) => o.values[name]));
    return { name, gp: fitGP(X, s.z, {}), yMean: s.mean, ySd: s.sd };
  });
  const goals = [{ name: 'ee', goal: 'maximize', worst: 70, best: 100, weight: 1, on: true }];
  const free = suggestRuns({ models, space, goals, observed: obs, q: 1, mode: 'balanced', seed: 2, nCandidates: 400, samples: 64 });
  const limited = suggestRuns({ models, space, goals, constraints: [{ name: 'PDI', op: '<', value: 0.12 }], observed: obs, q: 1, mode: 'balanced', seed: 2, nCandidates: 400, samples: 64 });
  assert.ok(free.picks[0].point.frr > 5, 'without the limit it chases the highest flow ratio');
  assert.ok(limited.picks[0].point.frr < free.picks[0].point.frr, 'the PDI limit pulls it back');
  assert.ok(limited.picks[0].predicted.PDI.mean < 0.14, 'and the chosen setting is predicted to stay near the limit');
});

test('closed loop: the optimiser finds a better formulation than random search on the same budget', () => {
  // A deliberately LNP-shaped truth: size falls with flow ratio, total flow and PEG; PDI is worst at the
  // extremes; encapsulation rises with ionizable lipid and saturates. Noise is on the scale of real DLS scatter.
  const space = [
    { key: 'frr', lo: 2, hi: 6, step: 0.1 }, { key: 'tfr', lo: 20, hi: 150, step: 1 },
    { key: 'ionizable_pct', lo: 35, hi: 60, step: 0.5 }, { key: 'peg_pct', lo: 0.5, hi: 3, step: 0.1 },
  ];
  const truth = (p, rnd) => {
    const g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    return {
      particle_size_nm: 140 - 9 * (p.frr - 2) - 0.18 * (p.tfr - 20) - 14 * (p.peg_pct - 0.5) + 0.003 * (p.tfr - 85) ** 2 + g() * 2,
      PDI: Math.max(0.02, 0.08 + 0.02 * Math.abs(p.frr - 4) + 0.0004 * Math.abs(p.tfr - 95) + 0.05 * Math.max(0, 1.2 - p.peg_pct) + g() * 0.008),
      encapsulation_efficiency: Math.min(99, Math.max(10, 97 / (1 + Math.exp(-(p.ionizable_pct - 44) / 3)) - 2 * Math.max(0, p.frr - 5) + g() * 1.2)),
    };
  };
  const goals = DEFAULT_GOALS.filter((g) => g.on);
  const D = (v) => overallDesirability(v, goals).D;
  let wins = 0;
  const gains = [];
  for (let rep = 0; rep < 3; rep++) {
    const seed = 100 + rep * 31, rnd = mulberry32(seed);
    const start = startingDesign(space, 8, seed).map((point) => ({ point, values: truth(point, rnd) }));
    let obs = [...start];
    for (let round = 0; round < 4; round++) {
      const X = obs.map((o) => toUnit(o.point, space));
      const models = goals.map((g) => {
        const s = standardise(obs.map((o) => o.values[g.name]));
        return { name: g.name, gp: fitGP(X, s.z, {}), yMean: s.mean, ySd: s.sd };
      });
      const { picks } = suggestRuns({ models, space, goals, observed: obs, q: 4, mode: 'balanced', seed: seed + round, nCandidates: 500, samples: 64 });
      const r2 = mulberry32(seed * 7 + round);
      for (const p of picks) obs.push({ point: p.point, values: truth(p.point, r2) });
    }
    const r3 = mulberry32(seed + 5000);
    const rand = [...start];
    for (let i = 0; i < 16; i++) {
      const point = snap(fromUnit(space.map(() => r3()), space), space);
      rand.push({ point, values: truth(point, r3) });
    }
    const bestBO = Math.max(...obs.map((o) => D(o.values)));
    const bestRS = Math.max(...rand.map((o) => D(o.values)));
    gains.push(bestBO - bestRS);
    if (bestBO >= bestRS) wins++;
  }
  assert.ok(wins >= 3, `the optimiser should win every repeat on the same 24-run budget (won ${wins}/3)`);
  assert.ok(gains.every((g) => g > 0.01), `and by a real margin (${gains.map((g) => g.toFixed(3)).join(', ')})`);
});

test('a surface that has reverted to its prior is reported as such', () => {
  // Eriksson and Jankowiak 2021 describe the failure: with too little data for the number of factors, the
  // fitted lengthscales go short, no two runs are correlated and the posterior falls back on the prior. The
  // model is then empty rather than wrong, and no accuracy figure says so. With the signal variance fixed at
  // 1 and standardised outputs, the posterior variance between runs IS the fraction of prior left.
  const rnd = mulberry32(5);
  // A fit forced into the failure: lengthscales so short that no two runs are correlated.
  const Xc = Array.from({ length: 12 }, () => Array.from({ length: 4 }, () => rnd()));
  const short = [...Array.from({ length: 4 }, () => ({ mu: Math.log(0.03), sd: 0.3 })), { mu: -2, sd: 0.5 }];
  const collapsed = collapseCheck(fitGP(Xc, standardise(Xc.map(() => rnd())).z, { priors: short }), 4, { seed: 3 });
  assert.ok(collapsed.priorShare > 0.9, `a collapsed fit leaves the prior intact (${collapsed.priorShare.toFixed(2)})`);
  assert.equal(collapsed.collapsed, true, 'and is flagged');

  // The same data under the module's own prior must NOT collapse. That prior exists to prevent exactly this
  // failure, and if noise over four factors still triggered the flag, the flag would be measuring the prior
  // rather than the data.
  const underDefault = collapseCheck(fitGP(Xc, standardise(Xc.map(() => rnd())).z, {}), 4, { seed: 3 });
  assert.equal(underDefault.collapsed, false, 'the dimension-scaled prior keeps the surface from falling apart on noise');

  // And a learnable surface keeps far less of its prior than either.
  const X = Array.from({ length: 30 }, () => [rnd(), rnd()]);
  const y = X.map((x) => 3 * x[0] + 2 * x[0] * x[1]);
  const learned = collapseCheck(fitGP(X, standardise(y).z, {}), 2, { seed: 3 });
  assert.ok(learned.priorShare < underDefault.priorShare, 'a learnable surface keeps less of its prior than noise does');
  assert.equal(learned.collapsed, false);
});

test('the way a pending run is imagined was chosen by measurement, not by citation', () => {
  // Ginsbourger et al. 2010 recommend the constant liar over the kriging believer, lying with the worst
  // outcome seen. On this problem that is the worst of the available options, and drawing one outcome from
  // the posterior wins; see the table in acquire.js. The point of this test is that the choice stays
  // falsifiable: if a change makes the default worse than the published recommendation, this fails.
  const space = [{ key: 'frr', lo: 2, hi: 6, step: 0.1 }, { key: 'tfr', lo: 20, hi: 150, step: 1 }, { key: 'peg_pct', lo: 0.5, hi: 3, step: 0.1 }];
  const truth = (p, rnd) => {
    const g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    return {
      particle_size_nm: 140 - 9 * (p.frr - 2) - 0.18 * (p.tfr - 20) - 14 * (p.peg_pct - 0.5) + 0.003 * (p.tfr - 85) ** 2 + g() * 2,
      PDI: Math.max(0.02, 0.08 + 0.02 * Math.abs(p.frr - 4) + 0.05 * Math.max(0, 1.2 - p.peg_pct) + g() * 0.008),
      encapsulation_efficiency: Math.min(99, Math.max(10, 86 - 2 * Math.max(0, p.frr - 5) + g() * 1.2)),
    };
  };
  const goals = DEFAULT_GOALS.filter((g) => g.on);
  const bestWith = (liar, seed) => {
    const rnd = mulberry32(seed);
    let obs = startingDesign(space, 8, seed).map((point) => ({ point, values: truth(point, rnd) }));
    for (let round = 0; round < 3; round++) {
      const X = obs.map((o) => toUnit(o.point, space));
      const models = goals.map((g) => {
        const st = standardise(obs.map((o) => o.values[g.name]));
        return { name: g.name, gp: fitGP(X, st.z, {}), yMean: st.mean, ySd: st.sd };
      });
      const { picks } = suggestRuns({ models, space, goals, observed: obs, q: 3, mode: 'balanced', seed: seed + round, nCandidates: 300, samples: 48, liar });
      const r2 = mulberry32(seed * 7 + round);
      for (const p of picks) obs.push({ point: p.point, values: truth(p.point, r2) });
    }
    return Math.max(...obs.map((o) => overallDesirability(o.values, goals).D));
  };
  // Twelve seeds: on three, a change of the GP's noise prior (0.14) flipped the order by 0.004, which is seed
  // luck at that size; on twelve the default is ahead (0.777 against 0.776).
  const seeds = Array.from({ length: 12 }, (_, i) => 100 + 31 * i);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const dflt = mean(seeds.map((s) => bestWith(undefined, s)));
  const liar = mean(seeds.map((s) => bestWith('min', s)));
  assert.ok(dflt >= liar - 1e-9, `the default should be no worse than the constant liar (${dflt.toFixed(4)} vs ${liar.toFixed(4)})`);
});

test('rank correlation, hit rate, one-factor-at-a-time detection and the null check behave', () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  assert.ok(Math.abs(spearman([1, 2, 2, 4], [1, 3, 3, 4]) - 1) < 1e-12, 'ties get averaged ranks');
  assert.equal(spearman([1, 2], [2, 1]), null, 'too few points to rank');
  const h = hitRate([1, 5, 3, 9, 7, 2], [2, 4, 3, 8, 9, 1], 2);
  assert.equal(h.hits, 2); assert.equal(h.rate, 1); assert.ok(Math.abs(h.byChance - 1 / 3) < 1e-12);
  assert.ok(oneFactorAtATime([[0, 0], [1, 0], [1, 1], [1, 2], [1, 3]]), 'a one-at-a-time series is recognised');
  assert.ok(!oneFactorAtATime([[0, 0], [1, 1], [0.3, 0.7], [0.9, 0.2], [0.1, 0.4]]), 'a space-filling design is not');
  // on pure noise the null distribution should sit at or below zero
  const rnd = mulberry32(13);
  const X = Array.from({ length: 18 }, () => [rnd(), rnd()]);
  const y = X.map(() => rnd());
  const rows = X.map((_, i) => ({ experimentId: `E${i % 3}` }));
  const nul = nullDistribution(LEARNERS.gp, X, y, buildFolds(rows, 'experiment'), { repeats: 5 });
  assert.ok(nul && nul.median < 0.5, `shuffled data should not look learnable (median Q² ${nul?.median?.toFixed(2)})`);
  assert.ok(nul.high >= nul.median, 'the reported high is at or above the median');
  assert.equal(typeof nul.isMax, 'boolean', 'the report says whether that high is really a quantile or just the largest');
  // and the verdict downgrades a fit the null check sits close behind
  const close = verdict({ q2: 0.85, rho: 0.9, rmse: 2 }, { rmse: 8 }, 20, 3, 4, { rho: 0.9, nul: { high: 0.84, median: 0.6, isMax: true, n: 8 } });
  assert.notEqual(close.level, 'strong', 'a fit the null check nearly matches is not called strong');
  assert.ok(/by chance alone/.test(close.detail));
});

test('replicated settings are found by their factor values', () => {
  const space = [{ key: 'a', lo: 0, hi: 1 }, { key: 'b', lo: 0, hi: 1 }];
  const rows = [
    { factors: { a: 0.5, b: 0.2 }, values: { v: 10 } }, { factors: { a: 0.5, b: 0.2 }, values: { v: 12 } },
    { factors: { a: 0.9, b: 0.1 }, values: { v: 5 } },
  ];
  const groups = replicateGroups(rows, space);
  assert.equal(groups.length, 1); assert.equal(groups[0].length, 2);
  const n = noiseFromReplicates(rows, space, 'v');
  assert.equal(n.df, 1);
  assert.ok(Math.abs(n.sd - Math.sqrt(2)) < 1e-9, 'pooled sd of 10 and 12 is sqrt(2)');
});

test('suggestions are checked against the shelf and against the ground already covered', () => {
  const settings = { defaultFRR: 3, defaultQuenchFactor: 2 };
  // What the lab has actually run: a narrow band of flow settings.
  const observed = [{ frr: 3, tfr: 100 }, { frr: 3.2, tfr: 110 }, { frr: 2.8, tfr: 120 }];

  const inside = checkSetting({ frr: 3, tfr: 112.5 }, { quench: 2 }, { settings, stocks: [], observed });
  assert.notEqual(inside.level, 'warn', 'a setting inside the ground already covered raises nothing');
  assert.ok(inside.summary.flows.p1 > 0, 'the pump flows are worked out');

  // Far outside that band the surrogate is extrapolating, and nothing here models the rig, so say so.
  const far = checkSetting({ frr: 3, tfr: 400 }, { quench: 2 }, { settings, stocks: [], observed });
  assert.equal(far.level, 'warn');
  assert.ok(far.notes.some((n) => /well outside/.test(n.text)), 'extrapolation beyond the runs is flagged');
  assert.ok(far.notes.some((n) => /check the setting is one your rig can hold/.test(n.text)),
    'and it says plainly that the program cannot judge the hardware for you');

  const justOut = checkSetting({ frr: 3, tfr: 123 }, { quench: 2 }, { settings, stocks: [], observed });
  assert.equal(justOut.level, 'info', 'a little outside is a note, not a warning');

  const noStock = checkSetting({ frr: 3, tfr: 110, lipid_mM: 61 }, { quench: 2 },
    { settings, stocks: [{ molarity_mM: 50 }], observed });
  assert.ok(noStock.notes.some((n) => /No lipid stock on the shelf/.test(n.text)), 'a stock that does not exist is flagged');
});


test('degenerate data does not produce NaN, Infinity or a thrown error anywhere', () => {
  // Every one of these will happen in a real lab: a response that never varied, a factor held constant, a
  // single run, a goal whose limits collapse, a batch with no composition. None may produce a non-finite
  // number, because one NaN in a score silently reorders every suggestion below it.
  const goals = DEFAULT_GOALS.filter((g) => g.on);
  const space = [{ key: 'frr', name: 'FRR', lo: 2, hi: 6, step: 0.1 }, { key: 'tfr', name: 'TFR', lo: 20, hi: 150, step: 1 }];
  const row = (frr, tfr, values) => ({ batchId: `B${frr}_${tfr}`, experimentId: 'E1', compositionId: 463, date: '2026-01-01', factors: { frr, tfr }, values });
  const finite = (label, v) => {
    const json = JSON.stringify(v, (k, x) => (typeof x === 'function' ? '[fn]' : typeof x === 'number' && !Number.isFinite(x) ? `NONFINITE:${x}` : x));
    assert.ok(!/NONFINITE/.test(json || ''), `${label} produced a non-finite number`);
  };
  const flat = (v) => Array.from({ length: 12 }, (_, i) => row(2 + i * 0.3, 50 + i, v));
  finite('identical responses', analyse({ rows: flat({ particle_size_nm: 80, PDI: 0.1, encapsulation_efficiency: 90 }), space, goals }));
  finite('constant factor', analyse({ rows: Array.from({ length: 12 }, (_, i) => row(3, 50 + i * 5, { particle_size_nm: 80 + i, PDI: 0.1, encapsulation_efficiency: 90 })), space, goals }));
  finite('everything constant', analyse({ rows: Array.from({ length: 12 }, () => row(3, 100, { particle_size_nm: 80, PDI: 0.1, encapsulation_efficiency: 90 })), space, goals }));
  finite('no factors', analyse({ rows: [row(3, 100, { particle_size_nm: 80 })], space: [], goals }));
  finite('one run', analyse({ rows: [row(3, 100, { particle_size_nm: 80, PDI: 0.1, encapsulation_efficiency: 90 })], space, goals }));
  finite('no composition', analyse({ rows: Array.from({ length: 10 }, (_, i) => ({ ...row(2 + i * 0.3, 50 + i, { particle_size_nm: 80 + i, PDI: 0.1, encapsulation_efficiency: 90 }), compositionId: null })), space, goals }));
  finite('missing response', overallDesirability({ particle_size_nm: NaN, PDI: 0.1, encapsulation_efficiency: 90 }, goals));
  assert.equal(overallDesirability({ particle_size_nm: NaN, PDI: 0.1, encapsulation_efficiency: 90 }, goals).D, 0,
    'a run missing one of the active responses cannot be scored, so it scores zero');
  assert.equal(overallDesirability({ PDI: 0.1 }, goals.map((g) => ({ ...g, weight: 0 }))).D, 0, 'all weights zero is not a score');
  assert.equal(desirability(80, { goal: 'target', target: 80, lo: 80, hi: 80 }), 1, 'collapsed limits still recognise the ideal');
  // Limits entered the wrong way round degrade to a step at the "good enough" value rather than zeroing the
  // whole score, because one mistyped field should not silently make every run unacceptable. The screen says
  // so separately; see goalProblems() in app/ui/ml.js.
  const swapped = { goal: 'minimize', best: 0.3, worst: 0.05 };
  assert.equal(desirability(0.1, swapped), 1);
  assert.equal(desirability(0.5, swapped), 0);
  finite('constant y', fitGP([[0.1], [0.5], [0.9]], [0, 0, 0], {}));
  assert.equal(standardise([5, 5, 5]).sd, 1, 'zero spread falls back to 1 rather than dividing by zero');
  assert.equal(spearman([1, 1, 1, 1], [2, 3, 4, 5]), null, 'no variation means no rank correlation');
  assert.ok(hitRate([1, 2, 3, 4], [4, 3, 2, 1], 99).k <= 3, 'k is clamped below the number of runs');
  assert.equal(toUnit({ a: 5 }, [{ key: 'a', lo: 3, hi: 3 }])[0], 0.5, 'a zero-width factor maps to the middle');
  for (const z of [-50, 50, -1e6, 1e6]) assert.ok(Number.isFinite(normCdf(z)), `normCdf(${z})`);
  assert.ok(Number.isFinite(normInv(1e-300)) || normInv(1e-300) === -Infinity);
});

test('limits entered the wrong way round are reported rather than silently absorbed', () => {
  assert.deepEqual(goalProblems([{ name: 'PDI', label: 'PDI', goal: 'minimize', best: 0.05, worst: 0.3, on: true }]), []);
  const swapped = goalProblems([{ name: 'PDI', label: 'PDI', goal: 'minimize', best: 0.3, worst: 0.05, on: true }]);
  assert.equal(swapped.length, 1);
  assert.ok(/must be below/.test(swapped[0]));
  assert.ok(/as low as possible/.test(goalProblems([{ name: 'EE', goal: 'maximize', best: 70, worst: 95, on: true }])[0]) === false);
  assert.ok(/must be above/.test(goalProblems([{ name: 'EE', goal: 'maximize', best: 70, worst: 95, on: true }])[0]));
  assert.ok(/outside the acceptable range/.test(goalProblems([{ name: 'size', goal: 'target', target: 200, lo: 50, hi: 120, on: true }])[0]));
  assert.ok(/low limit must be below/.test(goalProblems([{ name: 'size', goal: 'target', target: 80, lo: 120, hi: 50, on: true }])[0]));
  assert.ok(/are needed/.test(goalProblems([{ name: 'size', goal: 'target', target: 80, lo: null, hi: 120, on: true }])[0]));
  assert.deepEqual(goalProblems([{ name: 'PDI', goal: 'minimize', best: 0.3, worst: 0.05, on: false }]), [], 'a goal switched off is not checked');
});

test('a batch never contains two identical recipes, even when the steps are coarse', () => {
  // Separation used to be checked on the unit cube before snapping, so on a narrow range with a coarse step
  // two "separated" candidates could round to the same pump settings and a batch bought one answer four times.
  const rnd = mulberry32(77);
  for (const space of [
    [{ key: 'frr', lo: 3, hi: 3.3, step: 0.1 }],
    [{ key: 'frr', lo: 3, hi: 3.3, step: 0.1 }, { key: 'tfr', lo: 100, hi: 104, step: 1 }],
    [{ key: 'np', lo: 4.5, hi: 7.5, step: 0.5 }, { key: 'quench', lo: 1, hi: 3, step: 0.5 }],
  ]) {
    const obs = Array.from({ length: 10 }, () => {
      const point = Object.fromEntries(space.map((f) => [f.key, f.lo + rnd() * (f.hi - f.lo)]));
      return { point, values: { ee: 70 + rnd() * 20 } };
    });
    const X = obs.map((o) => toUnit(o.point, space));
    const s = standardise(obs.map((o) => o.values.ee));
    const models = [{ name: 'ee', gp: fitGP(X, s.z, {}), yMean: s.mean, ySd: s.sd }];
    const goals = [{ name: 'ee', goal: 'maximize', worst: 70, best: 95, weight: 1, on: true }];
    const { picks } = suggestRuns({ models, space, goals, observed: obs, q: 4, mode: 'balanced', seed: 3, nCandidates: 400, samples: 48 });
    const keys = picks.map((p) => space.map((f) => p.point[f.key]).join('|'));
    assert.equal(new Set(keys).size, keys.length,
      `a batch over ${space.map((f) => f.key).join(' and ')} contained a duplicate recipe: ${keys.join(' / ')}`);
  }
});

test('the explore half is not derailed by a response centred on zero', () => {
  // Uncertainty used to be scored relative to the predicted mean, which diverges wherever a prediction passes
  // through zero. Zeta potential is a shipped goal with a target of 0, so this was reachable with the defaults.
  const rnd = mulberry32(88);
  const space = [{ key: 'frr', lo: 2, hi: 6, step: 0.1 }, { key: 'tfr', lo: 20, hi: 150, step: 1 }];
  const obs = Array.from({ length: 16 }, () => {
    const point = { frr: 2 + rnd() * 4, tfr: 20 + rnd() * 130 };
    return { point, values: { zeta: (point.frr - 4) * 6 + rnd(), ee: 70 + 20 * Math.exp(-((point.frr - 4) ** 2) / 2) + rnd() } };
  });
  const X = obs.map((o) => toUnit(o.point, space));
  const models = ['zeta', 'ee'].map((name) => {
    const s = standardise(obs.map((o) => o.values[name]));
    return { name, gp: fitGP(X, s.z, {}), yMean: s.mean, ySd: s.sd };
  });
  const goals = [{ name: 'zeta', goal: 'target', target: 0, lo: -20, hi: 20, weight: 1, on: true },
    { name: 'ee', goal: 'maximize', worst: 70, best: 95, weight: 1, on: true }];
  const { picks } = suggestRuns({ models, space, goals, observed: obs, q: 4, mode: 'split', seed: 11, nCandidates: 600, samples: 48 });
  const learn = picks.filter((p) => p.purpose === 'learn');
  assert.equal(learn.length, 2);
  // the runs placed to learn must sit where the model is least sure, not where zeta happens to cross zero
  const zetaMeans = learn.map((p) => Math.abs(p.predicted.zeta.mean));
  assert.ok(Math.max(...zetaMeans) > 1,
    `the explore picks all landed where zeta is near zero (|mean| = ${zetaMeans.map((v) => v.toFixed(2)).join(', ')}), which is the divergence this guards against`);
  const sds = learn.map((p) => p.predicted.zeta.sd + p.predicted.ee.sd);
  const winSds = picks.filter((p) => p.purpose === 'win').map((p) => p.predicted.zeta.sd + p.predicted.ee.sd);
  assert.ok(Math.max(...sds) >= Math.max(...winSds) * 0.9, 'and they are at least as uncertain as the runs placed to win');
});

test('readiness stages match what the module can honestly offer', () => {
  assert.equal(readinessFor(0).stage, 'none');
  assert.equal(readinessFor(5).stage, 'seed');
  assert.equal(readinessFor(8).stage, 'model');
  assert.equal(readinessFor(15).stage, 'trust');
  assert.equal(readinessFor(40).stage, 'rich');
});

test('each suggestion carries what one batch there should measure: the surfaces as fitted, noise included', () => {
  // The interval stored with a batch is what its result is later held against (results.js, predictionSummary).
  // The surface's uncertainty about the mean held about 57 % of single results in the campaign, and from the
  // second pick of a batch on it came from surfaces that pretend the earlier picks already came back.
  const rnd = mulberry32(12);
  const g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
  const sp = [{ key: 'frr', lo: 2, hi: 6, step: 0.1 }, { key: 'tfr', lo: 20, hi: 150, step: 1 }];
  const ee = (f) => 70 + 25 * Math.exp(-((f.frr - 4) ** 2) / 1.5 - ((f.tfr - 100) / 60) ** 2);
  const rows = Array.from({ length: 18 }, (_, i) => {
    const factors = { frr: Math.round((2 + rnd() * 4) * 10) / 10, tfr: Math.round(20 + rnd() * 130) };
    return { batchId: `B${i + 1}`, experimentId: i < 9 ? 'E1' : 'E2', date: i < 9 ? '2026-01-01' : '2026-02-01', factors,
      values: { encapsulation_efficiency: ee(factors) + g() * 1.5 } };
  });
  const goals = [{ name: 'encapsulation_efficiency', goal: 'maximize', worst: 70, best: 96, weight: 1, on: true }];
  const out = analyse({ rows, space: sp, goals, q: 3, seed: 3 });
  assert.equal(out.suggestions.picks.length, 3);
  out.suggestions.picks.forEach((p, i) => {
    const f = p.forecast.encapsulation_efficiency;
    assert.deepEqual(f, predictAt(out.models, sp, p.point, { run: true }).encapsulation_efficiency, `pick ${i + 1}: from the surfaces as fitted, at the setting to be made`);
    const surface = predictAt(out.models, sp, p.point).encapsulation_efficiency;
    assert.ok(f.noise > 0 && Math.abs(f.sd ** 2 - surface.sd ** 2 - f.noise ** 2) < 1e-9 * f.sd ** 2, `pick ${i + 1}: the surface's uncertainty and the noise together`);
  });
  assert.ok(out.suggestions.picks.slice(1).some((p) => p.forecast.encapsulation_efficiency.mean !== p.predicted.encapsulation_efficiency.mean),
    'the later picks were chosen on surfaces that pretend, and what they carry forward is not from those');
  for (const r of out.suggestions.confirm?.runs || []) assert.ok(r.forecast.encapsulation_efficiency.noise > 0, 'a confirmation run carries one too');
});

test('analyse refuses to model when there is nothing to model, and says why', () => {
  const rows = [{ batchId: 'b1', factors: { frr: 3 }, values: { PDI: 0.1 }, experimentId: 'E1' }];
  const out = analyse({ rows, space: [{ key: 'frr', lo: 2, hi: 6, step: 0.1 }], goals: DEFAULT_GOALS.filter((g) => g.name === 'PDI') });
  assert.equal(out.n, 1);
  assert.ok(out.warnings.length, 'it explains the shortfall rather than returning an empty page');
  assert.ok(!out.suggestions, 'and makes no suggestions');
});

test('prediction intervals: the noise prior no longer lets a fit without replicates explain noise as structure', () => {
  // Spec 7.8. Without replicate runs the old prior, ln σ² ~ N(−4, 1), fitted the noise SD at about a third of the
  // truth and its 95 % intervals held about three new measurements in four. The calibration study behind the
  // present prior is in the comment on NOISE_PRIOR (gp.js); this is a small, fast slice of it.
  const fns = [
    (x) => 10 * Math.sin(2 * x[0]) + 6 * x[1] - 4 * x[2] ** 2,
    (x) => -15 * ((x[0] - 0.4) ** 2 + (x[1] - 0.6) ** 2) + 3 * x[2],
  ];
  const run = (noisePrior) => {
    let hit = 0, tot = 0; const ratio = [];
    for (const f of fns) for (let seed = 1; seed <= 4; seed++) {
      const rnd = mulberry32(seed * 7 + 1), g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
      const X = Array.from({ length: 24 }, () => [rnd(), rnd(), rnd()]);
      const y = X.map((x) => f(x) + 2 * g());
      const s = standardise(y);
      const priors = defaultPriors(3); priors[3] = noisePrior;
      const gp = fitGP(X, s.z, { priors });
      ratio.push(Math.sqrt(gp.sn2) * s.sd / 2);
      for (let t = 0; t < 30; t++) {
        const x = [rnd(), rnd(), rnd()], yo = f(x) + 2 * g();
        const p = gp.predict(x, { noiseless: false });
        if (Math.abs(yo - (p.mean * s.sd + s.mean)) <= 1.96 * p.sd * s.sd) hit++;
        tot++;
      }
    }
    ratio.sort((a, b) => a - b);
    return { coverage: hit / tot, noise: ratio[ratio.length >> 1] };
  };
  const old = run({ mu: -2, sd: 0.5 }), now = run(NOISE_PRIOR);
  assert.ok(now.noise > old.noise * 1.15, `the fitted noise should rise towards the truth (${old.noise.toFixed(2)} → ${now.noise.toFixed(2)} of it)`);
  assert.ok(now.coverage > old.coverage, `coverage should rise (${(old.coverage * 100).toFixed(0)} % → ${(now.coverage * 100).toFixed(0)} %)`);
  assert.ok(now.noise < 1.5, 'and not overshoot it');
});

test('the optimiser stays inside its bounds: a lengthscale is never moved below the floor it is measured at', () => {
  // Spec 7.8: the gradient used to be taken at a clamped copy while Adam moved the unclamped value on.
  const rnd = mulberry32(17);
  const X = Array.from({ length: 10 }, () => [rnd(), rnd()]);
  const y = X.map((x) => Math.sin(40 * x[0]) + (rnd() - 0.5)); // wants a lengthscale far under the floor
  const gp = fitGP(X, standardise(y).z, {});
  assert.ok(gp.lengthscales.every((l) => l >= MIN_LENGTHSCALE * 0.999), `lengthscales ${gp.lengthscales.map((l) => l.toFixed(3))}`);
  assert.ok(Number.isFinite(gp.logMarginalLikelihood));
});
