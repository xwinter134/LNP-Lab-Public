// The mixer as a process variable (UX revision 2: "different mixers as process variables, like the IJM 1 to 5
// from KNAUER"): the KNAUER sizes in the device list, an OFAT over mixers, and a DoE with the mixer as a
// categorical 2-level factor coded −1/+1 with no centre (app/calc/doe.js isCategorical).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildExperiment, FACTORS, levelText, isCategoricalFactor } from '../app/calc/experiment.js';
import { buildDesign, validateSpec, isCategorical, categoricalLevel, categoricalName, toDesignCSV, designSummary } from '../app/calc/doe.js';
import { designTableModel } from '../app/calc/designtable.js';
import { experimentResults, resultsCsv } from '../app/calc/results.js';
import { balancedOptimum } from '../app/calc/balance.js';
import { batchSetting } from '../app/calc/insights.js';
import { processDrivers, driverSentence, effectLines } from '../app/calc/diagnostics.js';
import { boxTerms } from '../app/calc/balance.js';
import { ols } from '../app/calc/stats.js';
import { mixersFor, processOf } from '../app/calc/process.js';
import { DEFAULT_SETTINGS } from '../app/refdata.js';

const devices = JSON.parse(readFileSync(new URL('../app/data/devices.json', import.meta.url)));
const ref = { devices: devices.instruments, mixers: devices.mixers };
const env = (id = 'E1') => ({ settings: DEFAULT_SETTINGS, takenFormulations: [], experimentId: id });
const IJM = [1, 2, 3, 4, 5].map((i) => `knauer-ijm-${i}`);

test('the KNAUER IJM 1 to 5 are mixers of their own on the NanoScaler, and the generic IJM stays for old records', () => {
  for (const id of IJM) {
    const m = devices.mixers.find((x) => x.id === id);
    assert.ok(m, id);
    assert.equal(m.kind, 'IJM'); assert.equal(m.vendor, 'KNAUER'); assert.match(m.name, /^KNAUER IJM [1-5]$/);
    // no invented dimensions: the datasheet is where they come from
    assert.ok(!('chamber_mm' in m) && !('jet_mm' in m), 'no internal dimensions are made up');
    assert.match(m.notes, /datasheet/);
  }
  assert.ok(devices.mixers.some((m) => m.id === 'ijm'), 'the generic entry is kept');
  assert.deepEqual(mixersFor(ref.devices.find((d) => d.id === 'nanoscaler'), ref).map((m) => m.id).slice(0, 5), IJM);
});

test('the mixer is a categorical factor whose level is a mixer id, written into the process only', () => {
  const f = FACTORS.find((x) => x.key === 'mixer');
  assert.ok(f && f.categorical && isCategoricalFactor('mixer') && !isCategoricalFactor('frr'));
  const plan = { process: { deviceId: 'nanoscaler', mixerId: 'knauer-ijm-1', quench: true } };
  f.apply(plan, 'knauer-ijm-3');
  assert.deepEqual(plan.process, { deviceId: 'nanoscaler', mixerId: 'knauer-ijm-3', quench: true }, 'the device and the rest stay');
  assert.equal(levelText('mixer', 'knauer-ijm-3', { 'knauer-ijm-3': 'KNAUER IJM 3' }), 'KNAUER IJM 3');
  assert.equal(levelText('mixer', 'gone'), 'gone', 'an id it cannot name is shown as it is');
  assert.equal(levelText('np', 6), '6');
});

test('OFAT over three IJM sizes: one formulation per mixer, labelled by its name, each on its own mixer', () => {
  const labels = { 'knauer-ijm-1': 'KNAUER IJM 1', 'knauer-ijm-3': 'KNAUER IJM 3', 'knauer-ijm-5': 'KNAUER IJM 5' };
  const process = { deviceId: 'nanoscaler', mixerId: 'knauer-ijm-1', quench: true };
  const { experiment, batches } = buildExperiment({ type: 'ofat', name: 'IJM sizes', startDate: '2026-10-20', compositionId: 1, mode: 'quick', process,
    ofat: { factor: 'mixer', levels: Object.keys(labels), labels } }, env());
  assert.deepEqual(batches.map((b) => b.label), ['Mixer KNAUER IJM 1', 'Mixer KNAUER IJM 3', 'Mixer KNAUER IJM 5']);
  assert.deepEqual(batches.map((b) => processOf(b.plan, ref).mixerId), Object.keys(labels));
  assert.deepEqual(batches.map((b) => b.plan.factors.mixer), Object.keys(labels), 'the record says which mixer, by id');
  assert.ok(batches.every((b) => b.plan.process.deviceId === 'nanoscaler'));
  assert.deepEqual(experiment.design.labels, labels, 'the names are kept with the experiment');
  assert.throws(() => buildExperiment({ type: 'ofat', name: 'x', startDate: '2026-10-20', compositionId: 1, ofat: { factor: 'mixer', levels: [] } }, env()), /tick at least one mixer/);

  // results: the levels are the mixers, by name, in the order ticked, compared as groups
  let n = 0;
  const dls = (batchId, z) => ({ id: `m${++n}`, batchId, test: 'dls', stage: 'final', date: '2026-10-21', values: { zave_nm: z, pdi: 0.1 } });
  const res = experimentResults(experiment, batches, [dls(batches[0].id, 70), dls(batches[1].id, 90), dls(batches[2].id, 110)]);
  assert.equal(res.stats.categorical, true);
  assert.deepEqual(res.stats.levels.map((l) => l.text), ['KNAUER IJM 1', 'KNAUER IJM 3', 'KNAUER IJM 5']);
  assert.deepEqual(res.rows.map((r) => r.levelText), ['KNAUER IJM 1', 'KNAUER IJM 3', 'KNAUER IJM 5']);
  assert.ok(res.sentences.some((s) => /lowest at Mixer KNAUER IJM 1[\s\S]*highest at Mixer KNAUER IJM 5/.test(s)), res.sentences.join(' | '));
  assert.match(resultsCsv(res), /KNAUER IJM 3/);
  assert.doesNotMatch(res.sentences.join(' '), /knauer-ijm/, 'never the id');

  // Insights tells the mixers apart, by name
  assert.match(batchSetting(batches[1], experiment).process, /^mixer KNAUER IJM 3 · FRR/);
  assert.doesNotMatch(batchSetting(batches[1], { ...experiment, design: {} }).process, /mixer/, 'only where the experiment varied it');
});

/** A DoE spec over FRR and total flow and two mixers. */
const mixSpec = (over = {}) => ({ mode: 'process', designType: 'full_factorial', model: 'interaction', centerPoints: 3, replicates: 1, seed: 7,
  factors: [
    { name: 'FRR', unit: '', low: 2, high: 4, applyTo: 'frr' },
    { name: 'flow_rate', unit: 'mL/min', low: 60, high: 120, applyTo: 'tfr' },
    { name: 'mixer', unit: '', low: -1, high: 1, center: null, applyTo: 'mixer', levels: ['knauer-ijm-1', 'knauer-ijm-3'], levelNames: ['KNAUER IJM 1', 'KNAUER IJM 3'] },
  ],
  responses: [{ name: 'particle_size_nm', goal: 'target', target: 80 }, { name: 'PDI', goal: 'minimize' }], ...over });

test('a categorical factor is coded −1/+1: low is the first mixer, high the second, and nothing in between', () => {
  const f = mixSpec().factors[2];
  assert.ok(isCategorical(f) && !isCategorical(mixSpec().factors[0]));
  assert.equal(categoricalLevel(f, -1), 'knauer-ijm-1'); assert.equal(categoricalLevel(f, 1), 'knauer-ijm-3');
  assert.equal(categoricalName(f, -1), 'KNAUER IJM 1'); assert.equal(categoricalName(f, 0.4), 'KNAUER IJM 3');
  const runs = buildDesign(mixSpec());
  assert.equal(runs.length, 8 + 3);
  for (const r of runs) assert.ok([-1, 1].includes(r.coded.mixer), `run ${r.run_id} has mixer ${r.coded.mixer}`);
  // centre points: the numeric factors at their centre, split between the two mixers in turn
  const centres = runs.filter((r) => r.point_type === 'center');
  assert.equal(centres.length, 3);
  assert.deepEqual(centres.map((r) => [r.coded.FRR, r.coded.flow_rate, r.coded.mixer]), [[0, 0, -1], [0, 0, 1], [0, 0, -1]]);
  assert.equal(designSummary(mixSpec(), runs).byType.center, 3);
});

test('a mixer factor needs a 2-level process design and two different mixers', () => {
  assert.deepEqual(validateSpec(mixSpec()), []);
  assert.deepEqual(validateSpec(mixSpec({ designType: 'plackett_burman', model: 'linear' })), []);
  for (const dt of ['ccd_faced', 'bbd', 'full_factorial_3']) assert.ok(validateSpec(mixSpec({ designType: dt, model: 'quadratic' })).some((e) => /no setting halfway[\s\S]*2-level design/.test(e)), dt);
  const same = mixSpec(); same.factors[2].levels = ['knauer-ijm-1', 'knauer-ijm-1'];
  assert.ok(validateSpec(same).some((e) => /two different mixers/.test(e)));
});

test('DoE with a mixer: each run is made on its mixer, and the table, the CSV and the drivers say mixer names', () => {
  const spec = mixSpec();
  const { experiment, batches } = buildExperiment({ type: 'doe', name: 'mixers', startDate: '2026-10-20', compositionId: 1, mode: 'quick',
    process: { deviceId: 'nanoscaler', mixerId: 'knauer-ijm-1', quench: true }, doe: spec }, env());
  const runs = experiment.design.doe.runs;
  for (const r of runs) {
    const b = batches.find((x) => x.id === r.batchId);
    const want = r.coded.mixer > 0 ? 'knauer-ijm-3' : 'knauer-ijm-1';
    assert.equal(b.plan.process.mixerId, want); assert.equal(b.plan.factors.mixer, want);
    assert.equal(b.plan.mixing.frr, r.real.FRR);
  }
  const dt = designTableModel(spec, runs, { label: (f) => f.name });
  const col = dt.columns.findIndex((c) => c.key === 'mixer');
  assert.deepEqual([...new Set(dt.rows.map((row) => row[col]))].sort(), ['KNAUER IJM 1', 'KNAUER IJM 3']);
  const csv = toDesignCSV(spec, runs);
  assert.match(csv.split('\n')[0], /mixer_coded/); assert.match(csv, /,KNAUER IJM 3,/);

  // a fit with a real mixer effect: the drivers name the mixers, and the optimum never sits between them
  const truth = (c) => 90 - 6 * c.FRR + 8 * c.mixer + 3 * c.FRR * c.mixer;
  const terms = boxTerms(['FRR', 'flow_rate', 'mixer'], 'interaction');
  const noise = [0.3, -0.2, 0.1, -0.4, 0.2, 0.0, -0.1, 0.3, -0.3, 0.1, 0.2];
  const fit = ols(runs.map((r) => terms.map((t) => t.f(r.coded))), runs.map((r, i) => truth(r.coded) + noise[i]));
  const d = processDrivers(fit, terms, spec.factors);
  const m = d.main.find((e) => e.factor === 'mixer');
  assert.equal(m.fromText, 'KNAUER IJM 1'); assert.equal(m.toText, 'KNAUER IJM 3');
  assert.match(driverSentence('Size', d, { unit: 'nm' }), /mixer \(\+16 nm from KNAUER IJM 1 to KNAUER IJM 3\)/);
  // the effect plot split by the mixer: one line per mixer
  assert.deepEqual(effectLines(fit, terms, ['FRR', 'flow_rate', 'mixer'], 'FRR', 'mixer', { levels: [-1, 1] }).map((l) => l.level), [-1, 1]);
  const vals = Object.fromEntries(runs.map((r, i) => [r.run_id, { particle_size_nm: truth(r.coded) + noise[i], PDI: 0.12 + 0.02 * r.coded.mixer + 0.01 * noise[i] }]));
  const b = balancedOptimum(spec, runs, vals);
  assert.ok(b && [-1, 1].includes(b.coded.mixer), `the balanced optimum puts the mixer at ${b?.coded.mixer}`);
});
