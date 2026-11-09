import test from 'node:test';
import assert from 'node:assert/strict';
import { nextStep } from '../app/calc/nextstep.js';

const exp = (id, status = 'running', expected = []) => ({ id, status, expected });
const bat = (id, experimentId, status, plannedDate = '2026-01-01') => ({ id, experimentId, status, plannedDate });

test('an empty lab is asked to plan an experiment', () => {
  const n = nextStep([], [], []);
  assert.equal(n.text, 'Plan an experiment');
  assert.equal(n.href, '#/advisor');
});

test('a planned formulation is made next', () => {
  const n = nextStep([exp('E7')], [bat('E7-F2', 'E7', 'planned', '2026-02-02'), bat('E7-F1', 'E7', 'planned', '2026-02-01')], []);
  assert.match(n.text, /^Make E7-F1 \(and 1 more planned\)$/);
  assert.equal(n.label, 'Open record');
  assert.equal(n.href, '#/formulation?batch=E7-F1');
});

test('results that are due come before anything still to make', () => {
  const e = exp('E4', 'running', [{ batchId: 'E4-F3', status: 'open', dueDate: '2026-01-05' }]);
  const n = nextStep([e, exp('E7')], [bat('E4-F3', 'E4', 'produced'), bat('E7-F1', 'E7', 'planned')], []);
  assert.equal(n.text, 'Enter results for E4-F3');
  assert.equal(n.label, 'Measure');
  assert.equal(n.href, '#/measurements?batch=E4-F3');
});

test('a made formulation with a result and no open slot is not due', () => {
  const n = nextStep([exp('E1')], [bat('E1-F1', 'E1', 'produced')], [{ batchId: 'E1-F1' }]);
  assert.equal(n.kind, 'plan');
});

test('experiments that are done are ignored', () => {
  const n = nextStep([exp('E1', 'done')], [bat('E1-F1', 'E1', 'planned')], []);
  assert.equal(n.kind, 'plan');
  assert.match(n.text, /Plan the next experiment/);
});

import { typeShort, defaultExperimentName } from '../app/calc/experiment.js';
test('short type names and the default experiment name', () => {
  assert.equal(typeShort('doe'), 'DoE');
  assert.equal(typeShort('ofat'), 'OFAT');
  assert.equal(defaultExperimentName('stability', '2026-11-09'), 'Stability · 2026-11-09');
});
