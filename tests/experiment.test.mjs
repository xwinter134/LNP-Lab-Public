import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExperiment, flowsFromTotal, experimentProgress, parseNumberList, stabilityTimepoints } from '../app/calc/experiment.js';
import { DEFAULT_SETTINGS } from '../app/refdata.js';

const env = () => ({ settings: DEFAULT_SETTINGS, takenFormulations: [], experimentId: 'E1' });

test('flows from total reproduce the record pumps (112.5 mL/min, FRR 3, quench 2)', () => {
  const f = flowsFromTotal(112.5, 3, 2);
  assert.equal(f.p1, 56.25); assert.equal(f.p2, 18.75); assert.equal(f.p3, 37.5);
});

test('a single formulation is numbered inside its experiment and gets its final slots', () => {
  const { experiment, batches } = buildExperiment({ type: 'single', name: 'x', startDate: '2026-10-20', compositionId: 363, tests: ['dls', 'ee'] }, env());
  assert.equal(batches.length, 1);
  assert.equal(batches[0].id, 'E1-F1');
  assert.equal(experiment.expected.length, 2);
  assert.equal(experiment.expected[0].sampleName, 'E1-F1_final');
});

test('stability: 2 formulations × 2 conditions × 10 timepoints × 2 tests + potency at T0/T28', () => {
  const { experiment, batches } = buildExperiment({ type: 'stability', name: 's', startDate: '2026-10-20', compositionId: 363,
    stability: { formulations: [{ compositionId: 363 }, { compositionId: 315 }], conditions: ['4C', '25C'], timepoints: [0, 3, 6, 9, 12, 15, 18, 21, 24, 28], tests: ['dls', 'ee'], potencyAt: [0, 28] } }, env());
  assert.equal(batches.length, 2);
  // numbered inside the experiment, so the second arm is F2 and not whatever the global counter was on
  assert.deepEqual(batches.map((b) => b.id), ['E1-F1', 'E1-F2']);
  assert.equal(experiment.expected.length, 2 * 2 * (10 * 2 + 2));
  const t9 = experiment.expected.find((s) => s.timepoint === 9 && s.condition === '4C' && s.batchId === 'E1-F1' && s.test === 'dls');
  assert.equal(t9.sampleName, 'E1-F1_4C_T09');
  assert.equal(t9.dueDate, '2026-10-29');
  // 2026-10-20 is a Tuesday; T12 falls on Sunday 2026-11-01 -> shifted to Monday 2nd
  const t12 = experiment.expected.find((s) => s.timepoint === 12 && s.test === 'dls');
  assert.equal(t12.dueDate, '2026-11-02');
  const p = experimentProgress(experiment, '2026-10-20');
  assert.equal(p.total, experiment.expected.length); assert.equal(p.open, p.total);
});

test('a typed number list: empty boxes and stray separators add nothing, a decimal comma needs semicolons', () => {
  // Number('') is 0, so a naive split turned an empty box into [0] and a trailing comma into an extra 0.
  for (const empty of ['', '   ', ',', ' , ; ', null, undefined]) assert.deepEqual(parseNumberList(empty), [], `"${empty}"`);
  assert.deepEqual(parseNumberList('0, 7, 14'), [0, 7, 14]);
  assert.deepEqual(parseNumberList(' 3 6,9, 12, '), [3, 6, 9, 12]);
  assert.deepEqual(parseNumberList('0,5'), [0, 5], 'without semicolons a comma separates');
  assert.deepEqual(parseNumberList('0,5; 1,5;2'), [0.5, 1.5, 2], 'with them it is a decimal comma');
  assert.deepEqual(parseNumberList('1.5, x, 2'), [1.5, 2], 'a word is skipped, not read as 0');
});

test('stability timepoints: an empty custom box keeps the duration/interval schedule', () => {
  assert.deepEqual(stabilityTimepoints({ timepointsText: '', durationDays: 28, intervalDays: 7 }), [0, 7, 14, 21, 28]);
  assert.deepEqual(stabilityTimepoints({ timepointsText: '', durationDays: 10, intervalDays: 3 }), [0, 3, 6, 9, 10], 'the duration is always the last pull');
  assert.deepEqual(stabilityTimepoints({ timepointsText: '14, 0, 7, 7', durationDays: 28, intervalDays: 7 }), [0, 7, 14], 'a custom list overrides, sorted and unique');
  // Built the way the wizard builds it: the study gets every timepoint, its reminders and the potency pull at T28.
  const st = { timepointsText: '', durationDays: 28, intervalDays: 7, potencyAtText: '0, 28' };
  const { experiment } = buildExperiment({ type: 'stability', name: 's', startDate: '2026-10-20', compositionId: 363,
    stability: { formulations: [{ compositionId: 363 }], conditions: ['4C'], timepoints: stabilityTimepoints(st), tests: ['dls'], potencyAt: parseNumberList(st.potencyAtText) } }, env());
  assert.deepEqual(experiment.design.stability.timepoints, [0, 7, 14, 21, 28]);
  assert.deepEqual([...new Set(experiment.expected.map((s) => s.stage))], ['T0', 'T7', 'T14', 'T21', 'T28']);
  assert.ok(experiment.expected.some((s) => s.stage === 'T28' && s.test === 'potency'), 'potency at T28 has a slot');
});

test('OFAT with no levels typed is refused rather than made at level 0', () => {
  assert.throws(() => buildExperiment({ type: 'ofat', name: 'o', startDate: '2026-10-20', compositionId: 363, ofat: { factor: 'np', levels: parseNumberList('') } }, env()), /at least one level/);
});

test('OFAT on N/P creates one batch per level with the factor applied; DoE full factorial 2^2 + 1 center', () => {
  const o = buildExperiment({ type: 'ofat', name: 'o', startDate: '2026-10-20', compositionId: 363, ofat: { factor: 'np', levels: [3, 6, 9, 12] }, batchesPerDay: 2 }, env());
  assert.equal(o.batches.length, 4);
  assert.equal(o.batches[2].plan.rna.np, 9);
  assert.equal(o.batches[2].plannedDate, '2026-10-21');
  const doe = { designType: 'full_factorial', model: 'interaction', centerPoints: 1, replicates: 1, seed: 1, plateFormat: 96,
    factors: [{ name: 'FRR', low: 2, high: 4, applyTo: 'frr' }, { name: 'flow_rate', unit: 'mL/min', low: 60, high: 120, applyTo: 'tfr' }, { name: 'temperature', unit: 'degC', low: 4, high: 37 }],
    responses: [{ name: 'particle_size_nm', goal: 'target', target: 90 }, { name: 'zeta_potential_mV', goal: 'none' }] };
  const d = buildExperiment({ type: 'doe', name: 'd', startDate: '2026-10-20', compositionId: 363, doe, tests: ['dls', 'ee', 'zeta'] }, env());
  assert.equal(d.batches.length, 9);
  assert.ok(d.batches.some((b) => b.plan.mixing.frr === 2 && b.plan.mixing.totalFlow === 120));
  const center = d.batches.find((b) => b.doe.point_type === 'center');
  assert.equal(center.plan.mixing.frr, 3); assert.equal(center.plan.mixing.flows.p2, 90 / 6);
  assert.deepEqual(center.plan.factors, { FRR: 3, flow_rate: 90, temperature: 20.5 }); // record-only factor kept on the plan
  assert.equal(center.label, `${center.doe.run_id} (center)`);
  const runs = d.experiment.design.doe.runs;
  assert.deepEqual(runs.map((r) => r.run_order), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(runs[0].batchId, d.batches[0].id); assert.equal(runs[0].well, 'A1');
  assert.equal(d.batches[0].doe.well, 'A1');
  assert.ok(d.experiment.expected.some((s) => s.batchId === center.id && s.test === 'zeta'));
});


