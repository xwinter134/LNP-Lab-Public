// The optimizer's biological targets (spec 7.9), wired to the studies of the biology layers (calc/ml/biotargets.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { biologicalTargets, applyTargets, targetGoals, activeLayers, physchemAsLimits } from '../app/calc/ml/targets.js';
import { studyTargets } from '../app/calc/ml/biotargets.js';

const study = { id: 'Study-001', type: 'in vitro', layers: ['invitro'], subtractBackground: false,
  groups: [{ id: 'G1', name: 'Reference', role: 'reference', batchId: 'E1-F1', n: 3 }, { id: 'G2', name: 'Candidate', role: 'test', batchId: 'E2-F3', n: 3 }] };
const m = (group, subject, value) => ({ studyId: 'Study-001', group, subject, value, layer: 'invitro', quantity: 'luciferase', unit: 'RLU', organ: '', population: '', timepoint_h: 24 });
const store = (cols) => ({ all: (k) => cols[k] || [] });
const ctx = { store: store({ studies: [study], bioMeasurements: [m('G1', 'w1', 100), m('G1', 'w2', 100), m('G1', 'w3', 100), m('G2', 'w4', 1000), m('G2', 'w5', 1000), m('G2', 'w6', 1000)] }) };

test('the layers are read where the app keeps them (settings.bio), and none means no targets', () => {
  assert.deepEqual(activeLayers({ bio: { invitro: true, invivo: false } }), ['invitro']);
  assert.deepEqual(biologicalTargets(ctx, { bio: { invitro: false } }), []);
  const ts = biologicalTargets(ctx, { bio: { invitro: true } });
  assert.equal(ts.length, 1, 'one series measured: in vitro luciferase at 24 h');
  assert.equal(ts[0].layer, 'invitro');
});

test('a formulation gets its log10 fold over the reference, and its study for the split', () => {
  const ts = studyTargets(ctx, {}, () => true);
  const rows = applyTargets([{ batchId: 'E2-F3', values: {} }, { batchId: 'E1-F1', values: {} }, { batchId: 'E9-F9', values: {} }], ts, ctx);
  assert.ok(Math.abs(rows[0].values[ts[0].name] - 1) < 1e-9, 'ten times the reference is +1');
  assert.ok(Math.abs(rows[1].values[ts[0].name]) < 1e-9, 'the reference itself is 0');
  assert.equal(rows[2].values[ts[0].name], undefined, 'a formulation without a study has no value');
  assert.equal(rows[0].studyId, 'Study-001');
});

test('every animal layer is in vivo and stays locked; size and PDI can become limits', () => {
  const goals = targetGoals([{ name: 'a', layer: 'invitro' }, { name: 'b', layer: 'invivo' }, { name: 'c', layer: 'biodist' }, { name: 'd', layer: 'tropism' }]);
  assert.equal(goals[0].locked, undefined);
  assert.ok(goals.slice(1).every((g) => g.locked), 'potency, biodistribution and tropism are all measured in animals');
  const { goals: g2, constraints } = physchemAsLimits([{ name: 'particle_size_nm', goal: 'target', lo: 60, hi: 120, on: true }, { name: 'PDI', goal: 'minimize', worst: 0.3, on: true }]);
  assert.ok(g2.every((g) => g.on === false));
  assert.deepEqual(constraints.map((c) => `${c.name}${c.op}${c.value}`), ['particle_size_nm>60', 'particle_size_nm<120', 'PDI<0.3']);
});
