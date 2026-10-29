// The process a formulation is made by, and quick mode (app/calc/process.js): the volume → mRNA formula, the
// defaults, the ionic strength estimate, reading an old record's process from its own fields, and what
// buildExperiment puts on a plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  quickVolumes, quickVolumeFor, syncQuick, defaultModeFor, defaultProcess, LAB_PROCESS, QUICK_VOLUME_mL, ionicStrength_mM, bufferFacts,
  withBuffer, processOf, adoptProcess, effectiveQuench, chooseDevice, mixersFor, stepOf, processSummary,
} from '../app/calc/process.js';
import { buildExperiment, FACTORS } from '../app/calc/experiment.js';
import { mixingPlan } from '../app/calc/batch_record.js';
import { DEFAULT_SETTINGS } from '../app/refdata.js';

const data = (f) => JSON.parse(readFileSync(new URL(`../app/data/${f}.json`, import.meta.url)));
const devices = data('devices');
const ref = { devices: devices.instruments, mixers: devices.mixers, buffersCatalog: data('buffers_catalog'), buffers: [], pka: data('pka'), reagents: data('reagents'),
  materials: data('materials'), tffModules: data('tff_modules') };
const close = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);

test('quick mode: the volume out of the mixer and the mRNA it holds, V × C × FRR / (FRR + 1 + q)', () => {
  const v = quickVolumes({ volume_mL: 5, working_mg_mL: 0.4, frr: 3, quenchFactor: 2 });
  close(v.rna_mg, 1); close(v.aqueous_mL, 2.5); close(v.lipid_mL, 5 / 6); close(v.quench_mL, 5 / 3);
  close(v.aqueous_mL + v.lipid_mL + v.quench_mL, 5, 1e-12, 'the phases add up to the volume');
  // without quench the whole volume is aqueous + lipid: 3/4 of it is RNA phase
  close(quickVolumes({ volume_mL: 4, working_mg_mL: 0.5, frr: 3, quenchFactor: 0 }).rna_mg, 1.5);
  // it is mixingPlan run backwards: that much mRNA gives exactly V of primary product at the standard split
  const m = mixingPlan({ rna_mg: v.rna_mg, working_mg_mL: 0.4, lipidStock_mM: 50, frr: 3, quenchFactor: 2, flows: { p1: 56.25, p2: 18.75, p3: 37.5 } });
  close(m.primary_mL, 5, 1e-9, 'primary product volume'); close(m.primary_mg_mL, v.product_mg_mL);
  close(quickVolumeFor({ rna_mg: 1, working_mg_mL: 0.4, frr: 3, quenchFactor: 2 }), 5, 1e-12, 'and back');
  assert.equal(quickVolumes({ volume_mL: 0, working_mg_mL: 0.4, frr: 3 }), null, 'no volume, nothing worked out');
});

test('syncQuick writes the mRNA from the volume in quick mode only, after quench is switched off too', () => {
  const plan = { mode: 'quick', volume_mL: 5, rna: { working_mg_mL: 0.4, mass_mg: 3 }, mixing: { frr: 3, quenchFactor: 2 } };
  syncQuick(plan); close(plan.rna.mass_mg, 1);
  plan.process = { quench: false }; syncQuick(plan); close(plan.rna.mass_mg, 1.5, 1e-9, 'no quench: 3/4 of 5 mL × 0.4');
  assert.equal(effectiveQuench(plan), 0);
  const full = { rna: { mass_mg: 3, working_mg_mL: 0.4 }, mixing: { frr: 3 }, volume_mL: 5 };
  syncQuick(full); assert.equal(full.rna.mass_mg, 3, 'a full-process plan keeps its RNA input');
});

test('defaults: quick for the screening types, the lab layout as the process, a buffer\'s ionic strength', () => {
  assert.deepEqual(['single', 'stability', 'ofat', 'doe', 'comparison', 'reference'].map(defaultModeFor), ['full', 'full', 'quick', 'quick', 'quick', 'full']);
  assert.equal(QUICK_VOLUME_mL, 5);
  const p = defaultProcess(ref);
  assert.equal(p.deviceId, 'pumps-3'); assert.equal(p.mixerId, 't-mixer'); assert.equal(p.quench, true);
  assert.equal(p.aqueous.buffer, 'Citrate 50 mM, pH 4.0'); assert.equal(p.downstream[0].step, 'dialysis'); assert.equal(p.downstream[0].buffer, 'PBS, pH 7.4');
  assert.ok(ref.materials.dialysis_cassettes.includes(p.downstream[0].device), 'the cassette is one on record');
  p.aqueous.pH = 9; assert.equal(LAB_PROCESS.aqueous.pH, 4, 'a default handed out is a copy');
  // the ionic strengths written into LAB_PROCESS are what the estimate gives for those buffers
  for (const b of [LAB_PROCESS.aqueous, LAB_PROCESS.quenchBuffer, LAB_PROCESS.downstream[0]]) {
    assert.equal(withBuffer({}, b.buffer, ref).ionicStrength_mM, b.ionicStrength_mM, b.buffer);
  }
  // PBS: 137 mM NaCl plus ~26 mM from the phosphate and its Na⁺ at pH 7.4; HEPES 10 mM at its pKa, about half deprotonated
  const pbs = ionicStrength_mM({ ...bufferFacts('PBS, pH 7.4', ref) }, ref.pka);
  assert.ok(pbs > 150 && pbs < 170, `PBS ${pbs}`);
  const hepes = ionicStrength_mM({ system: 'HEPES', pH: 7.48, mM: 10 }, ref.pka);
  close(hepes, 5, 0.3, 'HEPES at its pKa: about 5 mM anion + 5 mM Na⁺, halved (activity moves the split a little)');
  assert.equal(ionicStrength_mM({ system: 'Unobtainium', pH: 7, mM: 10 }, ref.pka), null);
  // a known buffer fills pH and mM; an unknown one keeps what was typed
  assert.deepEqual(withBuffer({ pH: 5, mM: 20 }, 'my own buffer', ref), { pH: 5, mM: 20, buffer: 'my own buffer' });
});

test('a device sets what its mixer and quench can be', () => {
  const ignite = chooseDevice(defaultProcess(ref), 'ignite', ref);
  assert.equal(ignite.mixerId, 'nxgen', 'the Ignite takes the NxGen cartridge only'); assert.equal(ignite.quench, false);
  assert.deepEqual(mixersFor(ref.devices.find((d) => d.id === 'syringe'), ref).map((m) => m.id), ['t-mixer', 'herringbone', 'flow-focusing']);
  const back = chooseDevice(ignite, 'nanoscaler', ref);
  assert.equal(back.mixerId, 'knauer-ijm-1', 'the NanoScaler opens on the first of its KNAUER IJM sizes'); assert.equal(back.quench, true);
});

test('an old record\'s process is read from its own fields, and moved onto plan.process once', () => {
  const plan = { rna: { diluent: 'Acetate 25 mM, pH 5.0' }, mixing: { quenchBuffer: 'PBS, pH 7.4', mixer: null },
    downstream: { dialysis: { cassette: '10K G2 30-70 ml', buffer: 'HEPES 10 mM, pH 7.4', volume_L: 2, hours: 12 }, tff: { enabled: true, module: 'C02-E100-05-N', target_mg_mL: 0.2 } } };
  const p = processOf(plan, ref);
  assert.equal(p.deviceId, 'pumps-3'); assert.equal(p.mixerId, 't-mixer'); assert.equal(p.quench, true);
  assert.equal(p.aqueous.buffer, 'Acetate 25 mM, pH 5.0'); assert.equal(p.aqueous.pH, 5);
  assert.equal(p.quenchBuffer.buffer, 'PBS, pH 7.4');
  assert.deepEqual(p.downstream.map((s) => [s.step, s.device]), [['dialysis', '10K G2 30-70 ml'], ['tff', 'C02-E100-05-N']]);
  assert.equal(stepOf(p, 'dialysis').buffer, 'HEPES 10 mM, pH 7.4');
  adoptProcess(plan, ref);
  assert.deepEqual(plan.process, p);
  assert.ok(!('diluent' in plan.rna) && !('quenchBuffer' in plan.mixing) && !('cassette' in plan.downstream.dialysis) && !('enabled' in plan.downstream.tff), 'one answer, not two');
  assert.equal(plan.downstream.dialysis.volume_L, 2, 'the quantities stay where they were'); assert.equal(plan.downstream.tff.target_mg_mL, 0.2);
  assert.deepEqual(processOf(plan, ref), p, 'and it reads the same afterwards');
  assert.match(processSummary(p, ref), /Three-pump layout.*T-mixer.*inline quench.*aqueous Acetate 25 mM, pH 5\.0.*dialysis into HEPES 10 mM, pH 7\.4, then tff/);
});

test('buildExperiment: mode, volume and a copy of the process on every formulation; flows follow the quench', () => {
  const env = { settings: DEFAULT_SETTINGS, takenFormulations: [], experimentId: 'E1' };
  const process = chooseDevice(defaultProcess(ref), 'syringe', ref); // syringes: no quench to start with
  const { batches } = buildExperiment({ type: 'ofat', name: 'q', startDate: '2026-10-20', compositionId: 1, mode: 'quick', volume_mL: 4, process,
    ofat: { factor: 'frr', levels: [2, 3] } }, env);
  for (const b of batches) { assert.equal(b.plan.mode, 'quick'); assert.equal(b.plan.volume_mL, 4); assert.equal(b.plan.process.deviceId, 'syringe'); assert.equal(b.plan.mixing.flows.p3, 0); }
  // at a fixed volume the mRNA follows FRR: 4 × 0.4 × 2/3 and 4 × 0.4 × 3/4
  close(batches[0].plan.rna.mass_mg, 4 * 0.4 * 2 / 3, 1e-6); close(batches[1].plan.rna.mass_mg, 1.2, 1e-6);
  batches[0].plan.process.aqueous.pH = 5.5;
  assert.equal(batches[1].plan.process.aqueous.pH, 4, 'each formulation has its own copy');
  // a spec from before modes existed is the full process with its RNA input, and no process stored
  const old = buildExperiment({ type: 'single', name: 'o', startDate: '2026-10-20', compositionId: 1, rna_mg: 2 }, env).batches[0];
  assert.equal(old.plan.mode, 'full'); assert.equal(old.plan.rna.mass_mg, 2); assert.ok(!('process' in old.plan)); assert.equal(old.plan.mixing.flows.p3, 37.5);
});

test('the aqueous pH and ionic strength are factors a design can vary', () => {
  const env = { settings: DEFAULT_SETTINGS, takenFormulations: [], experimentId: 'E2' };
  const { batches } = buildExperiment({ type: 'ofat', name: 'pH', startDate: '2026-10-20', compositionId: 1, process: defaultProcess(ref), ofat: { factor: 'aq_pH', levels: [3, 4, 5] } }, env);
  assert.deepEqual(batches.map((b) => b.plan.process.aqueous.pH), [3, 4, 5]);
  assert.equal(batches[0].plan.process.aqueous.buffer, 'Citrate 50 mM, pH 4.0', 'the rest of the phase stays as planned');
  const plan = { rna: {}, mixing: {} };
  FACTORS.find((f) => f.key === 'aq_ionic').apply(plan, 120);
  assert.equal(processOf(plan, ref).aqueous.ionicStrength_mM, 120, 'a plan with no process yet gets one with that level');
});
