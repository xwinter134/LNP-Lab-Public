import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDesign } from '../app/calc/doe.js';
import { balancedOptimum, goalsFor } from '../app/calc/balance.js';
import { overallDesirability } from '../app/calc/ml/objective.js';

const spec = {
  mode: 'process', designType: 'ccd_faced', model: 'quadratic', centerPoints: 3, replicates: 1, seed: 1,
  factors: [{ name: 'FRR', unit: '', low: 2, center: null, high: 4 }, { name: 'flow_rate', unit: 'mL/min', low: 60, center: null, high: 120 }],
  responses: [{ name: 'particle_size_nm', goal: 'target', target: 80 }, { name: 'PDI', goal: 'minimize' }, { name: 'encapsulation_efficiency', goal: 'maximize' }],
};
// A quadratic truth the model can represent exactly, so the search has one right answer to find: size hits
// 80 nm along a line, PDI is lowest at FRR 3.5 / 80 mL/min, EE is flat-ish. The balance sits near (3.5, 80).
const truth = ({ FRR, flow_rate }) => ({
  particle_size_nm: 80 + 12 * (3.5 - FRR) - 0.1 * (flow_rate - 80),
  PDI: 0.06 + 0.04 * (FRR - 3.5) ** 2 + 0.00002 * (flow_rate - 80) ** 2,
  encapsulation_efficiency: 94 - 2 * (FRR - 3.2) ** 2,
});

test('goals follow the design: its size target, and nothing for a response marked none', () => {
  const g = goalsFor({ responses: [...spec.responses, { name: 'zeta_potential_mV', goal: 'none' }] });
  assert.deepEqual(g.map((x) => x.name), ['particle_size_nm', 'PDI', 'encapsulation_efficiency']);
  assert.equal(g[0].target, 80);
  assert.ok(g[0].lo < 80 && g[0].hi > 80);
});

test('the balanced optimum finds the setting that is good on every response at once', () => {
  const runs = buildDesign(spec);
  const vals = Object.fromEntries(runs.map((r) => [r.run_id, truth(r.real)]));
  const b = balancedOptimum(spec, runs, vals);
  assert.ok(b, 'a result');
  assert.ok(Math.abs(b.real.FRR - 3.5) < 0.12, `FRR ${b.real.FRR}`);
  assert.ok(Math.abs(b.real.flow_rate - 80) < 6, `flow ${b.real.flow_rate}`);
  // the predicted point must really be at least as good as every run that was made
  const dTrue = overallDesirability(truth(b.real), goalsFor(spec)).D;
  assert.ok(dTrue >= b.best.D - 1e-9, `true score at the optimum ${dTrue} vs best run ${b.best.D}`);
  assert.equal(b.used.length, 3);
});

test('nothing to balance with a single scored response, or too few runs', () => {
  const runs = buildDesign(spec);
  const one = { ...spec, responses: [{ name: 'PDI', goal: 'minimize' }] };
  assert.equal(balancedOptimum(one, runs, Object.fromEntries(runs.map((r) => [r.run_id, truth(r.real)]))), null);
  const few = Object.fromEntries(runs.slice(0, 4).map((r) => [r.run_id, truth(r.real)]));
  assert.equal(balancedOptimum(spec, runs, few), null);
});

test('an empty target is the usual target, or skipped with a reason, never zero', () => {
  const skipped = [];
  const g = goalsFor({ responses: [{ name: 'particle_size_nm', goal: 'target', target: null }, { name: 'PDI', goal: 'target', target: '' }] }, skipped);
  assert.equal(g.length, 1);
  assert.equal(g[0].target, 80); // the optimizer's own size target
  assert.equal(skipped[0].name, 'PDI');
  const t = goalsFor({ responses: [{ name: 'PDI', goal: 'target', target: 0.15 }] })[0];
  assert.ok(t.lo < 0.15 && t.hi > 0.15, `window ${t.lo}..${t.hi}`);
});

test('a size goal of "minimize" is scored as one, not silently dropped', () => {
  const [g] = goalsFor({ responses: [{ name: 'particle_size_nm', goal: 'minimize' }] });
  assert.equal(g.goal, 'minimize');
  assert.ok(g.best < g.worst);
});

test('with a response unacceptable everywhere, the card is told which, and the pick is not just the first corner', () => {
  const runs = buildDesign(spec);
  // EE below the 75 % floor at every setting; PDI best at the high-FRR, high-flow corner
  const vals = Object.fromEntries(runs.map((r) => [r.run_id, { ...truth(r.real), encapsulation_efficiency: 60 + r.real.FRR, PDI: 0.25 - 0.02 * r.real.FRR - 0.0005 * r.real.flow_rate }]));
  const b = balancedOptimum(spec, runs, vals);
  assert.deepEqual(b.blocked, ['encapsulation_efficiency']);
  assert.equal(b.D, 0);
  assert.notDeepEqual(b.coded, { FRR: -1, flow_rate: -1 });
});

test('a rotatable CCD is searched out to its axial points, not stopped at the cube', () => {
  const rot = { ...spec, designType: 'ccd_rotatable' };
  const runs = buildDesign(rot);
  const a = Math.max(...runs.map((r) => Math.abs(r.coded.FRR)));
  assert.ok(a > 1.3);
  // the size target is met only past the cube along FRR
  const vals = Object.fromEntries(runs.map((r) => [r.run_id, { particle_size_nm: 80 + 20 * (1.3 - r.coded.FRR), PDI: 0.08, encapsulation_efficiency: 94 }]));
  const b = balancedOptimum(rot, runs, vals);
  assert.ok(b.coded.FRR > 1.05, `stopped at ${b.coded.FRR}`);
  assert.ok(Math.abs(b.extent.FRR - a) < 1e-9);
});
