// The cargo (mRNA, siRNA), freeze–thaw counting, and one ionic strength for every screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CARGO_TYPES, cargoInfo, cargoOf, cargoLabel, massPerPhosphate, lotMassPerPhosphate } from '../app/calc/cargo.js';
import { mixingPlan } from '../app/calc/batch_record.js';
import { buildExperiment } from '../app/calc/experiment.js';
import { DEFAULT_SETTINGS } from '../app/refdata.js';
import { buildIndex, search } from '../app/calc/search.js';
import { thawCount, withThaw, withoutThaw, thawedOn, overThaw, ftTag, ftWords, lastThaw, tracksThaw } from '../app/calc/freezethaw.js';
import { designBuffer } from '../app/calc/buffer.js';
import { ionicStrength_mM, bufferFacts, withBuffer, LAB_PROCESS, deviceOf, processOf, bufferLine } from '../app/calc/process.js';

const data = (f) => JSON.parse(readFileSync(new URL(`../app/data/${f}.json`, import.meta.url)));
const pka = data('pka'), reagents = data('reagents'), catalog = data('buffers_catalog');

test('cargo: mRNA and siRNA, an old record reads as mRNA, the plan before its lot before the default', () => {
  assert.deepEqual(CARGO_TYPES.map((c) => c.id), ['mRNA', 'siRNA']);
  assert.equal(cargoOf({ rna: {} }), 'mRNA', 'a plan from before the choice is mRNA');
  assert.equal(cargoOf(null), 'mRNA');
  assert.equal(cargoOf({ rna: {} }, { cargo: 'siRNA' }), 'siRNA', 'the lot says it when the plan does not');
  assert.equal(cargoOf({ rna: { cargo: 'mRNA' } }, { cargo: 'siRNA' }), 'mRNA', 'the plan keeps what it was made as');
  assert.equal(cargoInfo('nonsense').id, 'mRNA');
  assert.equal(cargoLabel('siRNA'), 'siRNA');
  // the mass per phosphate: 330 for mRNA (the app's long-standing convention), 333 for a 21-bp siRNA duplex
  assert.equal(massPerPhosphate({ rna: {} }), 330);
  assert.equal(massPerPhosphate({ rna: { cargo: 'siRNA' } }), 333);
  assert.equal(massPerPhosphate({ rna: { cargo: 'siRNA' } }, { massPerPhosphate: 340 }), 340, 'a lot that knows its own number');
  assert.equal(massPerPhosphate({ rna: { cargo: 'siRNA', massPerPhosphate: 320 } }, { massPerPhosphate: 340 }), 320, 'the record keeps the number it was made with');
  assert.equal(lotMassPerPhosphate({ cargo: 'siRNA', massPerPhosphate: '' }), 333, 'an empty field is the default');
  assert.equal(cargoInfo('siRNA').defaultNP, 3); assert.equal(cargoInfo('mRNA').defaultNP, 6);
});

test('N/P is worked out with the cargo\'s mass per phosphate', () => {
  const p = { rna_mg: 3, working_mg_mL: 0.4, lipidStock_mM: 50, frr: 3, quenchFactor: 2, flows: { p1: 56.25, p2: 18.75, p3: 37.5 }, ionizableMolPct: 50 };
  const old = mixingPlan(p).np, mrna = mixingPlan({ ...p, massPerPhosphate: 330 }).np, sirna = mixingPlan({ ...p, massPerPhosphate: 333 }).np;
  assert.equal(old, mrna, 'without a number it is the mRNA convention, so no older record moves');
  assert.ok(Math.abs(sirna / mrna - 333 / 330) < 1e-12, 'N/P scales with the mass per phosphate');
  assert.equal(mixingPlan({ ...p, nucleotideMw: 333 }).np, sirna, 'the old parameter name still works');
});

test('an experiment carries its cargo onto every formulation', () => {
  const spec = { type: 'reference', name: 'x', startDate: '2026-10-20', compositionId: 1, reference: { n: 2 }, tests: ['dls'], cargo: 'siRNA' };
  const { batches } = buildExperiment(spec, { settings: DEFAULT_SETTINGS, experimentId: 'E9', takenFormulations: [] });
  assert.ok(batches.every((b) => b.plan.rna.cargo === 'siRNA'));
  const old = buildExperiment({ ...spec, cargo: undefined }, { settings: DEFAULT_SETTINGS, experimentId: 'E9', takenFormulations: [] });
  assert.ok(old.batches.every((b) => b.plan.rna.cargo === 'mRNA'), 'a spec without a cargo is mRNA');
});

test('search finds the siRNA experiments and lots, and says a stock\'s freeze–thaw count', () => {
  const idx = buildIndex({
    experiments: [{ id: 'E1', name: 'old one', type: 'single' }, { id: 'E2', name: 'knockdown', type: 'single', spec: { cargo: 'siRNA' } }],
    rnaLots: [{ id: 'L1', construct: 'TTR', cargo: 'siRNA', conc_mg_mL: 2 }],
    stocks: [{ id: 'Stock-001', compositionId: 1, molarity_mM: 50, thaws: [{ date: '2026-10-01' }, { date: '2026-10-02' }] }],
  });
  const hits = search(idx, 'siRNA').groups.flatMap((g) => g.items).map((h) => h.id);
  assert.ok(hits.includes('E2') && hits.includes('L1') && !hits.includes('E1'), JSON.stringify(hits));
  assert.match(idx.find((x) => x.id === 'E2').sub, /siRNA/);
  assert.match(idx.find((x) => x.id === 'Stock-001').sub, /2 F\/T/);
});

test('freeze–thaw: one entry per thaw, in date order, the count is the list, a mistake can be taken back', () => {
  const now = new Date('2026-10-29T10:00:00Z');
  let s = { id: 'Stock-001' };
  assert.equal(thawCount(s), 0); assert.equal(ftTag(s), ''); assert.equal(ftWords(s), 'not thawed yet');
  s = withThaw(s, { operator: 'AB' }, now);
  assert.equal(thawCount(s), 1); assert.equal(s.thaws[0].date, '2026-10-29'); assert.equal(s.thaws[0].operator, 'AB');
  assert.ok(thawedOn(s, '2026-10-29'));
  s = withThaw(s, { date: '2026-10-20', note: 'logged late', batchId: 'E3-F1' }, now);
  assert.deepEqual(s.thaws.map((t) => t.date), ['2026-10-20', '2026-10-29'], 'in the order they happened');
  assert.equal(lastThaw(s).date, '2026-10-29'); assert.equal(s.thaws[0].batchId, 'E3-F1');
  assert.equal(ftWords(s), '2 freeze–thaw cycles');
  s = withoutThaw(s, 0);
  assert.equal(thawCount(s), 1);
  for (let i = 0; i < 5; i++) s = withThaw(s, {}, now);
  assert.equal(thawCount(s), 6);
  assert.ok(overThaw(s, 5)); assert.ok(!overThaw(s, 6)); assert.ok(!overThaw(s, 0), '0 switches the warning off');
  assert.equal(ftTag(s, 5), ' · 6 F/T ⚠'); assert.equal(ftTag(s, 10), ' · 6 F/T');
  assert.ok(tracksThaw({ trackFT: true })); assert.ok(!tracksThaw({}));
});

test('one ionic strength: the process designer gives what the Buffers screen gives, for every common buffer', () => {
  const ref = { pka, reagents, buffersCatalog: catalog, buffers: [] };
  for (const b of catalog) {
    const d = designBuffer({ ...b, method: 'auto' }, { pka, reagents });
    assert.ok(!d.err, b.name);
    assert.ok(Math.abs(d.pH - b.targetPH) < 0.005, `${b.name}: the recipe reads ${d.pH} on the meter`);
    const I = ionicStrength_mM(bufferFacts(b.name, ref), ref);
    assert.ok(Math.abs(I - d.I * 1000) < 1e-9, `${b.name}: designer ${d.I * 1000} mM, process ${I} mM`);
  }
  // the case that disagreed: citrate 50 mM pH 4.0 was 76.6 mM on the Buffers screen and 58 mM in the process designer
  const citrate = withBuffer({}, 'Citrate 50 mM, pH 4.0', ref).ionicStrength_mM;
  assert.equal(citrate, Math.round(designBuffer({ system: 'Citric acid', targetPH: 4, conc_mM: 50 }, { pka, reagents }).I * 1000));
  assert.equal(citrate, LAB_PROCESS.aqueous.ionicStrength_mM);
  assert.ok(citrate > 65 && citrate < 75, `citrate 50 mM pH 4.0: ${citrate} mM`);
  // a prepared lot, named by its lot number, gives the same number as the recipe it was made by
  const lot = { id: 'Buffer-001', lot: 'Buffer-001', name: 'my citrate', system: 'Citric acid', method: 'auto', targetPH: 4, conc_mM: 50, nacl_mM: 0, activity: true };
  const withLot = { ...ref, buffers: [lot] };
  assert.equal(withBuffer({}, 'Buffer-001', withLot).ionicStrength_mM, citrate);
  assert.match(bufferLine({ buffer: 'Buffer-001', pH: 4, mM: 50 }, ref), /Buffer-001 \(deleted lot\)/, 'a deleted lot says so where it is shown');
  assert.doesNotMatch(bufferLine({ buffer: 'Buffer-001', pH: 4, mM: 50 }, withLot), /deleted/);
});

test('the designer aims at the pH the meter reads: the activity scale, with p[H] beside it', () => {
  const d = designBuffer({ system: 'Citric acid', targetPH: 4, conc_mM: 50 }, { pka, reagents });
  assert.ok(Math.abs(d.pH - 4) < 0.002);
  assert.ok(d.pcH < 3.95 && d.pcH > 3.85, `p[H] ${d.pcH}`);
  const off = designBuffer({ system: 'Citric acid', targetPH: 4, conc_mM: 50, activity: false }, { pka, reagents });
  assert.ok(Math.abs(off.pH - 4) < 0.002 && Math.abs(off.pcH - 4) < 0.002, 'without activity the two scales are one');
  // a system without reagents on record still gets a pH and an ionic strength, no grams
  const none = designBuffer({ system: 'Ammonia', targetPH: 9.2, conc_mM: 20 }, { pka, reagents });
  assert.equal(none.method, 'none'); assert.equal(none.reagents.length, 0); assert.ok(none.I > 0);
});

test('a deleted instrument or mixer stays on the record that keeps a copy of it', () => {
  const ref = { devices: [], mixers: [] };
  const proc = { deviceId: 'my-rig', mixerId: 'chip-x', deviceRecord: { id: 'my-rig', name: 'My rig', quench: 'none' }, mixerRecord: { id: 'chip-x', name: 'Chip X', kind: 'chip' } };
  assert.equal(deviceOf(proc, ref).name, 'My rig'); assert.equal(deviceOf(proc, ref).deleted, true);
  assert.equal(processOf({ process: proc }, ref).deviceRecord.name, 'My rig', 'reading the process keeps the copy');
  assert.equal(deviceOf({ deviceId: 'other', deviceRecord: proc.deviceRecord }, ref), null, 'a copy of another device is not taken for this one');
});
