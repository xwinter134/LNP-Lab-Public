import test from 'node:test';
import assert from 'node:assert/strict';
import { inputProblems, dialysisTimeProblem } from '../app/calc/batch_record.js';

test('nothing entered is not a problem, and ordinary values pass', () => {
  assert.deepEqual(inputProblems({}), []);
  assert.deepEqual(inputProblems({ frr: null, totalFlow: undefined, mass_mg: '' }), []);
  assert.deepEqual(inputProblems({ frr: 3, quenchFactor: 2, totalFlow: 112.5, mass_mg: 3, working_mg_mL: 0.4, stock_mg_mL: 2, lipidStock_mM: 50 }), []);
  assert.deepEqual(inputProblems({ quenchFactor: 0 }), [], 'no quench is a possible setting');
});

test('values no run can have are named, with the field they belong to', () => {
  const p = inputProblems({ frr: -3, totalFlow: -5, mass_mg: 99999999, stock_mg_mL: 0 });
  assert.deepEqual(p.map((x) => x.field).sort(), ['mixing_frr', 'mixing_totalFlow', 'rna_mass_mg', 'rna_stock_mg_mL'].sort());
  assert.match(p.find((x) => x.field === 'mixing_frr').text, /above 0 \(it is -3\)/);
  assert.match(p.find((x) => x.field === 'rna_mass_mg').text, /check that it is in mg/);
});

test('zero is an entry too: FRR 0 is refused instead of quietly becoming the default', () => {
  assert.equal(inputProblems({ frr: 0 }).length, 1);
  assert.equal(inputProblems({ quenchFactor: -1 }).length, 1);
});

test('recorded volumes: zero, negative and absurd are named, ordinary ones pass', () => {
  assert.deepEqual(inputProblems({ primary_mL: 15, dialysis_end_mL: 14.5, tff_end_mL: 3, dialysis_start_mL: 15 }), []);
  const p = inputProblems({ primary_mL: -15, dialysis_end_mL: 0, tff_end_mL: 5e6 });
  assert.deepEqual(p.map((x) => x.field).sort(), ['a_dialysis_end_mL', 'a_primary_mL', 'a_tff_end_mL']);
  assert.match(p.find((x) => x.field === 'a_tff_end_mL').text, /in mL/);
  assert.equal(inputProblems({ final_mg_mL: -1, measured_mg_mL: 0 }).length, 2);
  assert.deepEqual(inputProblems({ primary_mL: null, tff_end_mL: '' }), []);
});

test('dialysis end before start is named; missing or ordered times are not', () => {
  assert.match(dialysisTimeProblem('2026-03-02T09:30', '2026-03-01T09:30'), /before its start/);
  assert.equal(dialysisTimeProblem('2026-03-02T09:30', '2026-03-03T09:30'), null);
  assert.equal(dialysisTimeProblem('2026-03-02T09:30', ''), null);
  assert.equal(dialysisTimeProblem('', '2026-03-02T09:30'), null);
  assert.equal(dialysisTimeProblem('2026-03-02T09:30', '2026-03-02T09:30'), null);
});
