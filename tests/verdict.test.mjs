// Whether to believe a DoE fit, in one sentence: fitVerdict() and the statistics under it, on constructed
// cases whose answer is known — a clean fit, a funnel, an outlier, too many terms, nothing to find, a missing
// term, a bent normal plot, a run the fit leans on, and a fit with too few residual df to say much.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitVerdict, externalStudent, normalPlotLimit, normalPlotCorrelation, lackOfFit, settingKey, residualPoints, VERDICT_LIMITS } from '../app/calc/diagnostics.js';
import { ols } from '../app/calc/stats.js';
import { boxTerms } from '../app/calc/balance.js';

const corners = (k) => Array.from({ length: 2 ** k }, (_, i) => Array.from({ length: k }, (_, j) => ((i >> j) & 1 ? 1 : -1)));
const obj = (names, v) => Object.fromEntries(names.map((n, i) => [n, v[i]]));
/** Fit a process model on coded points and read it, the way the DoE screen does; runs are R1, R2, … */
function read(names, model, pts, y, o = {}) {
  const terms = boxTerms(names, model);
  const coded = pts.map((v) => obj(names, v));
  const fit = ols(coded.map((c) => terms.map((t) => t.f(c))), y);
  return { fit, v: fitVerdict(fit, coded.map((c, i) => ({ label: `R${i + 1}`, setting: c })), o) };
}

// A face-centred CCD over three factors with four centre points (18 runs, quadratic: 10 terms, 8 residual
// df, pure error on 3 df), a known surface, and a fixed set of noise values with SD about 0.9.
const abc = ['a', 'b', 'c'];
const ccd = [...corners(3), ...[0, 1, 2].flatMap((j) => [-1, 1].map((s) => [0, 1, 2].map((i) => (i === j ? s : 0)))), [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
const surface = ([a, b, c]) => 100 - 12 * a + 8 * b - 5 * c + 3 * a * b + 4 * a * a;
const noise = [0.6, -1.1, 0.3, 1.4, -0.7, 0.2, -1.6, 0.9, 1.2, -0.4, -0.2, 0.5, -0.9, 1.0, -0.3, 0.8, -1.2, 0.1];
const clean = ccd.map((p, i) => surface(p) + noise[i]);

test('a clean fit is called sound, says what was checked, and shows measured against predicted', () => {
  const { v } = read(abc, 'quadratic', ccd, clean);
  assert.equal(v.level, 'sound');
  assert.equal(v.plot, 'measured-vs-predicted');
  assert.deepEqual(v.flags, []);
  assert.match(v.sentence, /^The fit looks sound: residuals shapeless, no run stands out, no lack of fit, predicted R² 0\.98\.$/);
  // the lack-of-fit test ran on the centre replicates: 3 df of pure error, 5 left for the misfit
  assert.equal(v.checks.lackOfFit.dfPe, 3);
  assert.equal(v.checks.lackOfFit.dfLof, 5);
  assert.ok(v.checks.lackOfFit.p > 0.05);
});

test('an outlier is named, with its size, and the residual plot is the one opened', () => {
  // nine units on a centre run: low leverage, so the fit cannot bend to it and the residual shows it all
  const { v } = read(abc, 'quadratic', ccd, clean.map((y, i) => (i === 15 ? y + 9 : y)));
  assert.equal(v.level, 'warn');
  assert.equal(v.plot, 'residuals');
  assert.equal(v.flags[0].kind, 'outlier');
  assert.deepEqual(v.flags[0].runs, ['R16']);
  assert.match(v.sentence, /^Check R16: its residual is 2\.7 SD, more than chance allows in 18 runs; look at its batch record and measurement before trusting the optimum\.$/);
  // the same run bends the normal plot, which is not reported as a second finding
  assert.ok(!v.flags.some((f) => f.kind === 'normality'));
});

test('a run beyond ±2 that chance explains is named softly, and the fit is still sound', () => {
  const { v } = read(abc, 'quadratic', ccd, clean.map((y, i) => (i === 15 ? y + 3.5 : y)));
  assert.equal(v.level, 'sound');
  assert.deepEqual(v.checks.mild, ['R16']);
  assert.match(v.sentence, /^The fit looks sound: residuals shapeless, no lack of fit, predicted R² 0\.97; R16 sits at 2\.4 SD, as one run in twenty does by chance\.$/);
  assert.doesNotMatch(v.sentence, /no run stands out/, 'and it does not also claim that none does');
});

test('a funnel: the scatter growing with the value is found and pointed at the residual plot', () => {
  // a 3 x 3 grid made three times over, a plane fitted to it, and noise in proportion to the value
  const grid = [-1, 0, 1].flatMap((a) => [-1, 0, 1].map((b) => [a, b]));
  const pts = [...grid, ...grid, ...grid];
  const plane = ([a, b]) => 100 + 40 * a + 20 * b;
  const sign = pts.map((_, i) => [1, -1, 1, -1, 1, 1, -1, 1, -1][i % 9] * (i < 9 ? 1 : i < 18 ? -1 : 1));
  const { v } = read(['a', 'b'], 'linear', pts, pts.map((p, i) => plane(p) + sign[i] * 0.12 * (plane(p) - 35) * (1 + 0.3 * ((i * 7) % 3))));
  assert.equal(v.level, 'warn');
  assert.equal(v.flags[0].kind, 'funnel');
  assert.equal(v.plot, 'residuals');
  assert.match(v.sentence, /^The scatter grows with the value \(the residuals fan out, p < 0\.001\), so the high end is less certain than the p values say\.$/);
  assert.ok(v.checks.funnel.rho > 0.9);
});

test('too many terms for the runs is overfitting, pointed at the terms that are real', () => {
  // 2^2 + 2 centres with the interaction model: one corner off on its own is fitted by spending every term
  const { fit, v } = read(['a', 'b'], 'interaction', [...corners(2), [0, 0], [0, 0]], [10, 10.4, 9.8, 16, 10.6, 10.1]);
  assert.ok(fit.adjR2 > 0.8 && fit.predR2 < 0, 'the case is what it says: good on its own runs, useless on a new one');
  assert.equal(v.level, 'warn');
  assert.equal(v.flags[0].kind, 'overfit');
  assert.equal(v.plot, 'effects');
  assert.match(v.sentence, /^Too many terms for 6 runs: the model fits its own runs \(adjusted R² 0\.82\) far better than one left out \(predicted R² −2\.29\); trust only the terms past the line/);
});

test('pure noise: the model predicts a new run worse than the average, and says so', () => {
  const { v } = read(abc, 'quadratic', ccd, noise.map((e) => 100 + 2 * e));
  assert.equal(v.level, 'warn');
  assert.equal(v.flags[0].kind, 'noSignal');
  assert.equal(v.plot, 'measured-vs-predicted');
  assert.match(v.sentence, /^The model predicts a run left out worse than the plain average would \(predicted R² −2\.39\)/);
});

test('a missing term shows as lack of fit against the replicates, with the next model suggested', () => {
  // 2^3 + 4 centres, a plane fitted, the centre six units below the corners and the replicates tight
  const pts = [...corners(3), [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const jitter = [0.4, -0.3, 0.2, -0.5, 0.3, 0.1, -0.2, 0.0, 0.3, -0.2, 0.1, -0.2];
  const y = pts.map(([a, b, c], i) => 100 + 10 * a + 5 * b - 3 * c + (a || b || c ? 3 : -3) + jitter[i]);
  const { v } = read(abc, 'linear', pts, y, { fuller: 'the model with interactions' });
  assert.equal(v.flags[0].kind, 'lackOfFit');
  assert.equal(v.plot, 'residuals');
  assert.ok(v.checks.lackOfFit.p < 0.001);
  assert.match(v.sentence, /^The model misses something real: it is further from the runs than the replicates are from each other \(lack of fit p < 0\.001\); try the model with interactions\.$/);
  // the centre runs all sitting low bends the normal plot too; that is the same finding, not a second one
  assert.ok(!v.flags.some((f) => f.kind === 'normality'));
  // without a model to suggest, the advice is general rather than wrong
  assert.match(read(abc, 'linear', pts, y).v.sentence, /a term is missing, or the response wants a transform\.$/);
});

test('residuals in two clumps fail the normal plot, and that plot is the one opened', () => {
  const grid = [-1, 0, 1].flatMap((a) => [-1, 0, 1].map((b) => [a, b]));
  const pts = [...grid, ...grid, ...grid];
  const clumps = pts.map((_, i) => ((i * 5) % 2 ? 1 : -1) * (1 + 0.05 * ((i * 3) % 4)));
  const { v } = read(['a', 'b'], 'linear', pts, pts.map(([a, b], i) => 100 + 40 * a + 20 * b + 3 * clumps[i]));
  assert.equal(v.flags.length, 1);
  assert.equal(v.flags[0].kind, 'normality');
  assert.equal(v.plot, 'normal-plot');
  assert.ok(v.checks.normality.r < v.checks.normality.limit);
  assert.match(v.sentence, /^The residuals are not normal/);
});

test('a run the fit leans on is a note beside a sound fit, not a fault', () => {
  // nine runs close together and one far out: that run alone sets the slope, so its residual is near zero
  const pts = [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2], [0, 0], [-0.2, 0], [0.2, 0], [0, -0.2], [0, 0.2], [1, 1]];
  const jitter = [0.2, -0.1, 0.15, -0.25, 0.05, -0.05, 0.1, -0.15, 0.1, 0.05];
  const { v } = read(['a', 'b'], 'linear', pts, pts.map(([a, b], i) => 50 + 10 * a + 5 * b + jitter[i]));
  assert.equal(v.level, 'note');
  assert.equal(v.plot, 'measured-vs-predicted');
  assert.deepEqual(v.checks.leverage.runs, ['R10']);
  assert.match(v.sentence, /^The fit looks sound: residuals shapeless, no run stands out, predicted R² 1\.00, but the fit leans on R10 \(leverage 0\.89\): its residual checks little, and a second batch there would steady the model\.$/);
});

test('with few residual df the verdict says how far it can see, and claims nothing it could not test', () => {
  const { v } = read(['a', 'b'], 'interaction', [...corners(2), [0, 0], [0, 0], [0, 0]], [10, 16, 7, 14, 11.6, 11.9, 11.4]);
  assert.equal(v.level, 'sound');
  assert.equal(v.checks.df, 3);
  assert.equal(v.checks.shapeTested, false);
  assert.equal(v.checks.outliers.tested, false, 'a studentised residual cannot pass 2 on four df or fewer');
  assert.match(v.sentence, /^The fit looks sound as far as 3 residual df can show: no lack of fit, predicted R² 0\.98\.$/);
  assert.equal(fitVerdict(null).sentence, 'No fit to judge.');
});

test('the externally studentised residual is the residual against a fit made without that run', () => {
  // a plane and some noise on a 2^2 + 3 design: refit without each run and compare
  const pts = [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0], [0, 0], [0, 0]];
  const y = [9.2, 14.9, 5.1, 10.6, 7.0, 6.6, 7.5];
  const X = pts.map(([a, b]) => [1, a, b]);
  const fit = ols(X, y);
  const df = fit.n - fit.p;
  const pts2 = residualPoints(fit, pts.map((_, i) => ({ label: `R${i + 1}` })));
  pts2.forEach((q, i) => {
    const without = ols(X.filter((_, j) => j !== i), y.filter((_, j) => j !== i));
    const sDel = without.se;
    const direct = fit.residuals[i] / (sDel * Math.sqrt(1 - fit.leverage[i]));
    assert.ok(Math.abs(externalStudent(q.student, df) - direct) < 1e-9, `run ${i + 1}: ${externalStudent(q.student, df)} vs ${direct}`);
  });
  assert.equal(externalStudent(1, 1), null, 'one residual df leaves nothing to estimate the error from without the run');
});

test('the normal-plot limits are the Ryan–Joiner values, and a straight plot passes them', () => {
  // published critical values: n 20 at 5 % is 0.950, n 10 at 5 % is 0.918, stricter limits sit lower
  assert.ok(Math.abs(normalPlotLimit(20, 0.05) - 0.9503) < 0.001, `${normalPlotLimit(20, 0.05)}`);
  assert.ok(Math.abs(normalPlotLimit(10, 0.05) - 0.9179) < 0.001, `${normalPlotLimit(10, 0.05)}`);
  assert.ok(normalPlotLimit(20, 0.01) < normalPlotLimit(20, 0.05) && normalPlotLimit(20, 0.05) < normalPlotLimit(20, 0.1));
  assert.equal(normalPlotLimit(3), null);
  // normal scores themselves lie exactly on the line
  const scores = [-1.64, -1.04, -0.67, -0.39, -0.13, 0.13, 0.39, 0.67, 1.04, 1.64];
  assert.ok(normalPlotCorrelation(scores) > 0.99);
  assert.ok(normalPlotCorrelation([0, 0, 0, 0, 0, 0, 0, 0, 0, 10]) < 0.7, 'one point far off the end is not normal');
});

test('lack of fit is the misfit against the scatter between replicates, by hand', () => {
  // four runs at two settings, a model that is a single mean: pure error from the pairs, the rest is misfit
  const fit = ols([[1], [1], [1], [1]], [1, 3, 9, 11]);
  const lof = lackOfFit(fit, ['lo', 'lo', 'hi', 'hi']);
  // pure error: (1-2)^2 + (3-2)^2 + (9-10)^2 + (11-10)^2 = 4 on 2 df; the SSE about the mean of 6 is 68, so
  // the misfit is 64 on 1 df and F = 64 / (4 / 2) = 32, the square of t = 5.66 on 2 df: p = 0.030
  assert.equal(lof.ssPe, 4); assert.equal(lof.dfPe, 2); assert.equal(lof.dfLof, 1);
  assert.ok(Math.abs(lof.ssLof - 64) < 1e-9 && Math.abs(lof.F - 32) < 1e-9, `F ${lof.F}`);
  assert.ok(Math.abs(lof.p - 0.0298) < 0.001, `p ${lof.p}`);
  assert.equal(lackOfFit(fit, ['a', 'b', 'c', 'd']), null, 'no repeated setting, no pure error');
  // replicates that agree exactly leave nothing to compare with, and no verdict is drawn from them
  assert.equal(lackOfFit(ols([[1], [1], [1], [1]], [2, 2, 10, 10.5]), ['lo', 'lo', 'x', 'y']).p, null);
});

test('a setting is the same setting whatever order its factors are listed in', () => {
  assert.equal(settingKey({ a: 0, b: 1 }), settingKey({ b: 1, a: 0 }));
  assert.notEqual(settingKey({ a: 0, b: 1 }), settingKey({ a: 0, b: -1 }));
  assert.equal(settingKey({ a: 1e-12 }), settingKey({ a: 0 }), 'rounding noise in a coded value is not a new setting');
  assert.equal(settingKey('R1'), 'R1');
});

test('the limits are where the comments say', () => {
  assert.deepEqual(VERDICT_LIMITS, { shapeAlpha: 0.01, lofAlpha: 0.05, outlierAlpha: 0.05, minShapeDf: 4, minNormalDf: 8, gap: 0.2, weakQ2: 0.5 });
});
