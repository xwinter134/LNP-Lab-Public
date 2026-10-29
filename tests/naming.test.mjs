// The naming scheme, and the rename that brings an older store onto it.
import test from 'node:test';
import assert from 'node:assert/strict';

// The store is localStorage; node has none, so give it one before the modules that use it load.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  get length() { return mem.size; },
  key: (i) => [...mem.keys()][i],
};
const { Store } = await import('../app/store.js');
const { migrate, renameToNumberedScheme, SCHEMA_VERSION } = await import('../app/migrate.js');
const { experimentId, formulationId, stockId, describeId, nextExperimentId, nextStockId,
  makeFormulationAllocator, sampleName, parseSampleName } = await import('../app/schema.js');

test('an id says which experiment a record belongs to, and nothing else', () => {
  assert.equal(experimentId(3), 'E3');
  assert.equal(formulationId('E3', 2), 'E3-F2');
  assert.equal(stockId(7), 'Stock-007');
  assert.equal(describeId('E3-F2'), 'Experiment 3 · formulation 2');
  assert.equal(describeId('E12'), 'Experiment 12');
  assert.equal(describeId('Stock-001'), 'Stock-001', 'anything else is left as it is');
});

test('the next free number is read off the ids in use, not off a count', () => {
  // A count breaks the moment a record is deleted: two experiments would both be numbered 2.
  assert.equal(nextExperimentId(['E1', 'E2', 'E10']), 'E11');
  assert.equal(nextExperimentId([]), 'E1');
  assert.equal(nextStockId(['Stock-001', 'Stock-012']), 'Stock-013');
  const next = makeFormulationAllocator('E3', ['E3-F1', 'E3-F2', 'E4-F9']);
  assert.equal(next(), 'E3-F3', 'another experiment\'s formulations do not move this counter');
  assert.equal(next(), 'E3-F4');
});

test('sample names round-trip, and the two older schemes still parse', () => {
  assert.equal(sampleName({ batchId: 'E6-F1', condition: '4C', timepoint: 9 }), 'E6-F1_4C_T09');
  assert.equal(sampleName({ batchId: 'E3-F2' }), 'E3-F2_final');
  assert.equal(sampleName({ batchId: 'E3-F2', stage: 'IPC4' }), 'E3-F2_IPC4');

  assert.deepEqual(parseSampleName('E6-F1_4C_T09'),
    { batchId: 'E6-F1', experimentId: 'E6', formulation: 'F1', condition: '4C', timepoint: 9 });
  assert.deepEqual(parseSampleName('E3-F2_final'), { batchId: 'E3-F2', stage: 'final' });
  assert.deepEqual(parseSampleName('E3-F2'), { batchId: 'E3-F2', stage: null });
  // An export written under an older scheme is still a file somebody will drop on the importer.
  assert.deepEqual(parseSampleName('S-013_F1_4C_T09'),
    { experimentId: 'S-013', formulation: 'F1', condition: '4C', timepoint: 9 });
  assert.deepEqual(parseSampleName('LNP_04_final'), { batchId: 'LNP_04', stage: 'final' });
  assert.equal(parseSampleName('Blank_PBS'), null, 'a blank is not a sample');
});

/** A store as an earlier version wrote it: S-001 experiments, one global LNP_nn counter. */
function oldStore() {
  mem.clear();
  const s = new Store('test');
  s.put('experiments', { id: 'S-002', type: 'doe', name: 'second', batchIds: ['LNP_03', 'LNP_04'],
    design: { doe: { runs: [{ run_id: 'R1', batchId: 'LNP_03' }, { run_id: 'R2', batchId: 'LNP_04' }] } },
    expected: [{ id: 'LNP_03_final_dls', batchId: 'LNP_03', test: 'dls', stage: 'final', sampleName: 'LNP_03_final', status: 'open' }] });
  s.put('experiments', { id: 'S-001', type: 'stability', name: 'first', batchIds: ['LNP_02'],
    expected: [{ id: 'LNP_02_T9_dls_4C', batchId: 'LNP_02', test: 'dls', stage: 'T9', condition: '4C', timepoint: 9,
      sampleName: 'S-001_F1_4C_T09', status: 'done', measurementId: 'm1' }] });
  s.put('batches', { id: 'LNP_02', experimentId: 'S-001', label: 'F1', stockId: 'LNP_01' });
  s.put('batches', { id: 'LNP_03', experimentId: 'S-002', label: 'R1 (center)', stockId: 'LNP_01' });
  s.put('batches', { id: 'LNP_04', experimentId: 'S-002', label: 'R2 (factorial)', stockId: null });
  s.put('stocks', { id: 'LNP_01', compositionId: 1 });
  s.put('measurements', { id: 'm1', batchId: 'LNP_02', experimentId: 'S-001', slotId: 'LNP_02_T9_dls_4C', sampleName: 'S-001_F1_4C_T09' });
  s.put('events', { id: 'e1', date: '2026-10-20', title: 'Produce LNP_04', link: '#/formulation?batch=LNP_04' });
  return s;
}

test('renaming an older store moves every reference with the id', () => {
  const s = oldStore();
  const map = renameToNumberedScheme(s);

  // Experiments are renumbered in the order they were created, not the order they come back in.
  assert.deepEqual(map.experiments, { 'S-002': 'E1', 'S-001': 'E2' });
  assert.deepEqual(s.all('experiments').map((e) => e.id).sort(), ['E1', 'E2']);
  assert.equal(s.get('experiments', 'E2').name, 'first');

  // Formulations are numbered inside their own experiment, in the order the experiment lists them.
  assert.deepEqual(map.batches, { 'LNP_03': 'E1-F1', 'LNP_04': 'E1-F2', 'LNP_02': 'E2-F1' });
  assert.deepEqual(s.all('batches').map((b) => b.id).sort(), ['E1-F1', 'E1-F2', 'E2-F1']);
  assert.equal(s.get('batches', 'E1-F1').experimentId, 'E1');
  assert.equal(s.get('batches', 'E1-F1').label, 'R1 (center)', 'the label is left alone: it describes, it does not identify');

  // Lipid stocks get their own series, and the formulation that used one follows it.
  assert.deepEqual(map.stocks, { 'LNP_01': 'Stock-001' });
  assert.equal(s.get('batches', 'E1-F1').stockId, 'Stock-001');
  assert.equal(s.get('batches', 'E1-F2').stockId, null, 'and a formulation with no stock keeps none');

  // The references that are easy to miss: the design run, the slot id, the sample name the importer matches,
  // the measurement that points at both, and the calendar link.
  assert.deepEqual(s.get('experiments', 'E1').batchIds, ['E1-F1', 'E1-F2']);
  assert.deepEqual(s.get('experiments', 'E1').design.doe.runs.map((r) => r.batchId), ['E1-F1', 'E1-F2']);
  const slot = s.get('experiments', 'E1').expected[0];
  assert.equal(slot.id, 'E1-F1_final_dls');
  assert.equal(slot.sampleName, 'E1-F1_final');
  const m = s.get('measurements', 'm1');
  assert.equal(m.batchId, 'E2-F1'); assert.equal(m.experimentId, 'E2'); assert.equal(m.slotId, 'E2-F1_T9_dls_4C');
  assert.equal(s.get('events', 'e1').link, '#/formulation?batch=E1-F2');
  assert.equal(s.get('events', 'e1').title, 'Produce LNP_04', 'a title is the user\'s own words and is not rewritten');
});

test('the rename runs once and is a no-op on a store already renamed', () => {
  const s = oldStore();
  assert.ok(migrate(s), 'the first load renames');
  assert.equal(localStorage.getItem('test.schemaVersion'), String(SCHEMA_VERSION));
  const before = JSON.stringify(s.all('batches').map((b) => b.id));
  assert.equal(migrate(s), null, 'the second load does nothing');
  assert.equal(JSON.stringify(s.all('batches').map((b) => b.id)), before);
});

test('a name the rename does not recognise is left strange rather than renamed into a collision', () => {
  mem.clear();
  const s = new Store('test');
  s.put('experiments', { id: 'E4', name: 'already current', batchIds: ['E4-F1'] });
  s.put('experiments', { id: 'S-001', name: 'old', batchIds: ['MYLAB_07'] });
  s.put('batches', { id: 'E4-F1', experimentId: 'E4' });
  s.put('batches', { id: 'MYLAB_07', experimentId: 'S-001' });
  s.put('batches', { id: 'ORPHAN_1', experimentId: 'S-999' }); // no experiment to be numbered inside
  const map = renameToNumberedScheme(s);
  assert.equal(map.experiments['S-001'], 'E5', 'E4 is taken, so the next free number is 5');
  assert.equal(map.batches['MYLAB_07'], 'E5-F1', 'a custom lot still gets a place in its experiment');
  assert.equal(map.batches.ORPHAN_1, undefined);
  assert.equal(s.get('batches', 'ORPHAN_1').id, 'ORPHAN_1');
  assert.equal(s.get('batches', 'E4-F1').id, 'E4-F1', 'a formulation already numbered keeps its number');
});
