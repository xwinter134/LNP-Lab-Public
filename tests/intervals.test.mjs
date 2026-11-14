// Prediction and confidence intervals, coefficient CIs, the real-unit equation, the case statistics, the
// run-order drift check and confirmation runs. Each is checked against a computation that does not share its
// code: the textbook formula, a refit without the run, the model with one more column.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ols, predictionAt, coefficientCIs, tCritical } from '../app/calc/stats.js';
import { caseStatistics, runOrderTrend, fitVerdict } from '../app/calc/diagnostics.js';
import { realEquation, equationText, symmetricCoding } from '../app/calc/equation.js';
import { confirmationPlan, confirmationResult, intervalForMean } from '../app/calc/confirm.js';
import { boxTerms, balancedOptimum } from '../app/calc/balance.js';
import { buildDesign, randomizeRuns, toCoded } from '../app/calc/doe.js';
import { buildExperiment, confirmationRuns } from '../app/calc/experiment.js';

const near = (a, b, tol = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg} ${a} vs ${b}`);
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());

test('critical t matches the tables', () => {
  near(tCritical(10), 2.228, 1e-3);
  near(tCritical(4), 2.776, 1e-3);
  near(tCritical(30, 0.01), 2.750, 1e-3);
});

test('the intervals of a straight line are the textbook ones', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8], ys = [2.1, 3.9, 6.2, 7.8, 10.1, 12.2, 13.8, 16.1];
  const fit = ols(xs.map((x) => [1, x]), ys);
  const n = xs.length, xbar = xs.reduce((a, b) => a + b, 0) / n, sxx = xs.reduce((a, x) => a + (x - xbar) ** 2, 0);
  const x0 = 6.5, t = tCritical(n - 2);
  const yhat = fit.beta[0] + fit.beta[1] * x0;
  const p = predictionAt(fit, [1, x0]);
  near(p.mean, yhat);
  near(p.ci[1] - p.mean, t * fit.se * Math.sqrt(1 / n + (x0 - xbar) ** 2 / sxx), 1e-6);
  near(p.pi[1] - p.mean, t * fit.se * Math.sqrt(1 + 1 / n + (x0 - xbar) ** 2 / sxx), 1e-6);
  // the mean of three new batches: between the CI and the one-batch PI
  const p3 = predictionAt(fit, [1, x0], { m: 3 });
  near(p3.pi[1] - p3.mean, t * fit.se * Math.sqrt(1 / 3 + 1 / n + (x0 - xbar) ** 2 / sxx), 1e-6);
  assert.ok(p3.pi[1] - p3.mean < p.pi[1] - p.mean && p3.pi[1] - p3.mean > p.ci[1] - p.mean);
});

test('a coefficient CI is beta ± t·SE and agrees with its p value', () => {
  const X = [], y = [];
  for (let i = 0; i < 12; i++) { const a = (i % 3) - 1, b = (i % 2) * 2 - 1; X.push([1, a, b]); y.push(5 + 2 * a + 0.1 * b + 0.5 * gauss()); }
  const fit = ols(X, y);
  const ci = coefficientCIs(fit);
  const t = tCritical(fit.n - fit.p);
  fit.beta.forEach((b, j) => {
    near(ci[j][0], b - t * fit.stdErr[j]);
    assert.equal(ci[j][0] > 0 || ci[j][1] < 0, fit.pValues[j] < 0.05, `term ${j}: CI excludes 0 exactly when p < 0.05`);
  });
});

test('the real-unit equation predicts what the coded model predicts', () => {
  const factors = [{ name: 'FRR', low: 2, high: 4 }, { name: 'flow_rate', low: 60, high: 120 }, { name: 'PEG', low: 1, high: 2.5 }];
  const names = factors.map((f) => f.name);
  const terms = boxTerms(names, 'quadratic');
  const beta = terms.map(() => gauss() * 10);
  const eq = realEquation(beta, terms, factors);
  assert.ok(eq.ok);
  assert.equal(eq.equations.length, 1);
  for (let k = 0; k < 20; k++) {
    const real = Object.fromEntries(factors.map((f) => [f.name, f.low + rnd() * (f.high - f.low) * 1.4 - 0.2 * (f.high - f.low)]));
    const coded = Object.fromEntries(factors.map((f) => [f.name, toCoded(f, real[f.name])]));
    const yCoded = terms.reduce((s, t, i) => s + t.f(coded) * beta[i], 0);
    const yReal = eq.equations[0].terms.reduce((s, t) => s + t.coef * t.vars.reduce((p, v) => p * real[v], 1), 0);
    near(yReal, yCoded, 1e-8, 'prediction');
  }
  // one term per monomial of a full quadratic in three factors
  assert.equal(eq.equations[0].terms.length, 10);
  assert.match(equationText(eq.equations[0], { lhs: 'Size' }), /^Size = .*FRR.*flow_rate².*$/);
});

test('a centre off the middle has no real-unit equation; a mixer gives one per level', () => {
  const off = [{ name: 'FRR', low: 2, high: 4, center: 3.5 }, { name: 'flow_rate', low: 60, high: 120 }];
  assert.equal(symmetricCoding(off[0]), false);
  const r = realEquation([1, 2, 3, 4], boxTerms(['FRR', 'flow_rate'], 'interaction'), off);
  assert.equal(r.ok, false);
  assert.match(r.why, /FRR has its centre off the middle/);

  const mix = [{ name: 'FRR', low: 2, high: 4 }, { name: 'mixer', low: -1, high: 1, levels: ['m1', 'm3'], levelNames: ['IJM 1', 'IJM 3'] }];
  const terms = boxTerms(['FRR', 'mixer'], 'interaction');
  const beta = [10, 2, 3, 1]; // 10 + 2 FRRc + 3 mixer + 1 FRRc·mixer
  const e = realEquation(beta, terms, mix);
  assert.ok(e.ok);
  assert.deepEqual(e.equations.map((x) => x.level), ['mixer = IJM 1', 'mixer = IJM 3']);
  // at IJM 1 (−1): 7 + 1·FRRc = 7 + (FRR − 3); at IJM 3: 13 + 3·(FRR − 3)
  const at = (eqn, frr) => eqn.terms.reduce((s, t) => s + t.coef * (t.vars.length ? frr : 1), 0);
  near(at(e.equations[0], 3.5), 7.5);
  near(at(e.equations[1], 3.5), 14.5);
});

test("Cook's distance and DFFITS are what leaving the run out does", () => {
  const spec = { designType: 'ccd_faced', model: 'quadratic', centerPoints: 3, responses: [{ name: 'y' }], factors: [{ name: 'A', low: 0, high: 1 }, { name: 'B', low: 0, high: 1 }] };
  const runs = buildDesign(spec);
  const terms = boxTerms(['A', 'B'], 'quadratic');
  const X = runs.map((r) => terms.map((t) => t.f(r.coded)));
  const y = runs.map((r) => 3 + r.coded.A - 2 * r.coded.B * r.coded.B + 0.3 * gauss());
  const fit = ols(X, y);
  const cs = caseStatistics(fit, runs.map((r, i) => ({ label: r.run_id, order: i + 1 })));
  for (const i of [0, 5, 9]) {
    const loo = ols(X.filter((_, j) => j !== i), y.filter((_, j) => j !== i));
    const shift = X.map((row) => row.reduce((s, x, k) => s + x * (fit.beta[k] - loo.beta[k]), 0));
    const cook = shift.reduce((s, d) => s + d * d, 0) / (fit.p * fit.se ** 2);
    near(cs.rows[i].cook, cook, 1e-8, `Cook ${i}`);
    near(cs.rows[i].dffits, shift[i] / (loo.se * Math.sqrt(fit.leverage[i])), 1e-8, `DFFITS ${i}`);
  }
  near(cs.cookLimit, 0.95, 0.15); // median of F(6, 5), about 1
});

test('the run-order drift is the t of the order as one more model column', () => {
  const spec = { designType: 'full_factorial', model: 'interaction', centerPoints: 4, seed: 3, responses: [{ name: 'y' }], factors: ['A', 'B', 'C'].map((name) => ({ name, low: 0, high: 1 })) };
  const runs = randomizeRuns(spec, buildDesign(spec));
  const terms = boxTerms(['A', 'B', 'C'], 'interaction');
  const X = runs.map((r) => terms.map((t) => t.f(r.coded)));
  const y = runs.map((r) => 1 + r.coded.A + 0.4 * r.run_order + gauss() * 0.5);
  const fit = ols(X, y);
  const d = runOrderTrend(fit, runs.map((r) => r.run_order));
  const aug = ols(X.map((row, i) => [...row, runs[i].run_order]), y);
  near(d.t, aug.tValues[aug.tValues.length - 1], 1e-7);
  near(d.p, aug.pValues[aug.pValues.length - 1], 1e-7);
  assert.equal(d.df, aug.n - aug.p);
  const v = fitVerdict(fit, runs.map((r) => ({ label: r.run_id, setting: r.coded, order: r.run_order })));
  assert.ok(v.flags.some((f) => f.kind === 'drift'), v.sentence);
  assert.match(v.flags.find((f) => f.kind === 'drift').say, /later runs come out higher/);
});

test('drift is not reported on clean data more often than its 1 % level', () => {
  const spec = { designType: 'bbd', model: 'quadratic', centerPoints: 3, seed: 5, responses: [{ name: 'y' }], factors: ['A', 'B', 'C'].map((name) => ({ name, low: 0, high: 1 })) };
  const runs = randomizeRuns(spec, buildDesign(spec));
  const terms = boxTerms(['A', 'B', 'C'], 'quadratic');
  const X = runs.map((r) => terms.map((t) => t.f(r.coded)));
  let hits = 0;
  const N = 600;
  for (let s = 0; s < N; s++) {
    const fit = ols(X, runs.map((r) => 2 * r.coded.A + gauss()));
    if ((runOrderTrend(fit, runs.map((r) => r.run_order))?.p ?? 1) < 0.01) hits++;
  }
  assert.ok(hits / N < 0.03, `${hits} of ${N}`);
});

/** A 2² factorial with centre points on FRR and flow, two responses, made from known surfaces. */
function smallDesign() {
  const spec = { designType: 'full_factorial', model: 'interaction', centerPoints: 4, replicates: 2, seed: 11,
    factors: [{ name: 'FRR', low: 2, high: 4, applyTo: 'frr' }, { name: 'flow_rate', low: 60, high: 120, applyTo: 'tfr' }],
    responses: [{ name: 'particle_size_nm', goal: 'target', target: 90 }, { name: 'PDI', goal: 'minimize' }] };
  const runs = randomizeRuns(spec, buildDesign(spec));
  const vals = Object.fromEntries(runs.map((r) => [r.run_id, {
    particle_size_nm: 100 - 8 * r.coded.FRR - 4 * r.coded.flow_rate + 2 * gauss(),
    PDI: 0.15 + 0.03 * r.coded.FRR + 0.01 * gauss() }]));
  return { spec, runs, vals };
}

test('the balanced optimum carries a CI and a PI per response', () => {
  const { spec, runs, vals } = smallDesign();
  const b = balancedOptimum(spec, runs, vals);
  for (const g of b.used) {
    const iv = b.interval[g.name];
    near(iv.mean, b.predicted[g.name], 1e-9);
    assert.ok(iv.pi[0] < iv.ci[0] && iv.ci[0] < iv.mean && iv.mean < iv.ci[1] && iv.ci[1] < iv.pi[1], g.name);
  }
});

test('a confirmation is held against the PI for the mean of its runs, frozen when planned', () => {
  const { spec, runs, vals } = smallDesign();
  const b = balancedOptimum(spec, runs, vals);
  const plan = confirmationPlan(b, { model: 'interaction', n: 3, date: '2026-11-14' });
  const pred = plan.predicted.particle_size_nm;
  const iv3 = intervalForMean(pred, 3);
  near(iv3.half, tCritical(pred.df) * Math.sqrt(pred.seMean ** 2 + pred.se ** 2 / 3));
  // one batch gives a wider interval than three
  assert.ok(intervalForMean(pred, 1).half > iv3.half);

  const none = confirmationResult(plan, {});
  assert.equal(none.level, '');
  assert.match(none.sentence, /3 confirmation runs planned/);

  const ok = confirmationResult(plan, { particle_size_nm: [pred.mean - 1, pred.mean, pred.mean + 1.5], PDI: [plan.predicted.PDI.mean] });
  assert.equal(ok.level, 'ok');
  assert.match(ok.sentence, /^Confirmed: all 2 measured responses fall inside/);
  assert.match(ok.sentence, /Not every run is measured yet/);

  const off = confirmationResult(plan, { particle_size_nm: [iv3.hi + 5, iv3.hi + 6, iv3.hi + 7] }, { label: () => 'Size (nm)' });
  assert.equal(off.level, 'warn');
  assert.deepEqual(off.outside, ['particle_size_nm']);
  assert.match(off.sentence, /^Not confirmed: Size \(nm\)/);
});

test('confirmation runs are new formulations at the setting, outside the design runs', () => {
  const { spec } = smallDesign();
  const settings = { defaultWorking_mg_mL: 0.4, defaultFRR: 3, defaultQuenchFactor: 2, defaultLipidStock_mM: 50 };
  const { experiment, batches } = buildExperiment({ type: 'doe', name: 'x', startDate: '2026-11-16', compositionId: 1, tests: ['dls', 'ee'], doe: spec },
    { settings, experimentId: 'E007', takenFormulations: [] });
  const byId = Object.fromEntries(batches.map((x) => [x.id, x]));
  const plan = { n: 2, coded: { FRR: 0.5, flow_rate: -1 }, real: { FRR: 3.5, flow_rate: 60 }, predicted: {} };
  const made = confirmationRuns(experiment, byId, plan, { takenFormulations: batches.map((x) => x.id), startDate: '2026-11-20' });
  assert.equal(made.batches.length, 2);
  assert.deepEqual(made.batches.map((x) => x.label), ['C1 (confirmation)', 'C2 (confirmation)']);
  assert.ok(made.batches.every((x) => !byId[x.id]), 'new ids');
  for (const x of made.batches) {
    assert.equal(x.plan.mixing.frr, 3.5);
    assert.equal(x.plan.mixing.totalFlow, 60);
    assert.equal(x.doe.point_type, 'confirmation');
    const f = x.plan.mixing.flows;
    near(f.p1 + f.p2 + f.p3 + f.p4, 60, 1e-9, 'flows add to the total');
  }
  assert.equal(made.slots.length, 4);
  assert.deepEqual(made.confirmation.batchIds, made.batches.map((x) => x.id));
  // the design's own runs are untouched: the model is never fitted to its confirmation
  assert.equal(experiment.design.doe.runs.length, batches.length);
});
