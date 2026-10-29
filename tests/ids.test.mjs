// Ids are never given out twice (usability cycle 3, C1): the next number in every series is past every id
// that still leaves a trace, in the trash and in the records that name one, not only past the live records.
import test from 'node:test';
import assert from 'node:assert/strict';

// The store is localStorage; node has none, so give it one before the modules that use it load.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  get length() { return mem.size; },
  key: (i) => [...mem.keys()][i] ?? null,
};
const { Store, TRASH_DAYS } = await import('../app/store.js');
const { usedIds, orphanedResults, nextExperimentId, nextStockId, makeFormulationAllocator } = await import('../app/schema.js');
const { nextBufferLot } = await import('../app/calc/buffer.js');

/** Ten experiments of two formulations each, the way the wizard leaves them; E10-F1 has a size. */
function lab() {
  mem.clear();
  const s = new Store('lnp-lab');
  for (let n = 1; n <= 10; n++) {
    const id = `E${n}`, forms = [`${id}-F1`, `${id}-F2`];
    s.put('experiments', { id, name: `Experiment ${n}`, batchIds: forms,
      expected: forms.map((b) => ({ id: `${b}_final_dls`, batchId: b, test: 'dls', stage: 'final', sampleName: `${b}_final`, status: 'open' })) });
    for (const b of forms) s.put('batches', { id: b, experimentId: id, status: 'planned', stockId: 'Stock-001' });
  }
  s.put('measurements', { id: 'm1', batchId: 'E10-F1', experimentId: 'E10', test: 'dls', stage: 'final', sampleName: 'E10-F1_final', values: { zave_nm: 81.2, pdi: 0.09 } });
  s.put('stocks', { id: 'Stock-001', compositionId: 1 });
  return s;
}
const deleteExperiment = (s, id, now = new Date('2026-10-27T10:00:00Z')) =>
  s.moveToTrash([['experiments', id], ...s.all('batches').filter((b) => b.experimentId === id).map((b) => ['batches', b.id])], { kind: 'experiment' }, now);

test('the session: E10 deleted, the next experiment is E11, not E10 again', () => {
  const s = lab();
  assert.equal(nextExperimentId(usedIds(s, 'experiment')), 'E11');
  const entry = deleteExperiment(s, 'E10');
  assert.ok(!s.get('experiments', 'E10'), 'E10 is in the trash');
  // The live records alone would say E10 is free: that was the bug.
  assert.equal(nextExperimentId(s.all('experiments').map((e) => e.id)), 'E10');
  const id = nextExperimentId(usedIds(s, 'experiment'));
  assert.equal(id, 'E11');
  const next = makeFormulationAllocator(id, usedIds(s, 'formulation'));
  assert.equal(next(), 'E11-F1', 'a fresh experiment starts at F1');
  s.put('experiments', { id, name: 'the next one', batchIds: ['E11-F1'] });
  s.put('batches', { id: 'E11-F1', experimentId: id, status: 'planned' });
  // Nothing of the old E10 attaches to the new experiment, and Undo of the old delete still works.
  assert.deepEqual(s.all('measurements').filter((m) => m.batchId.startsWith(`${id}-`)), []);
  assert.equal(s.restoreFromTrash(entry.id).ok, true);
  assert.equal(s.get('batches', 'E10-F1').experimentId, 'E10');
});

test('a result still names its formulation after the trash entry has expired, so its number stays taken', () => {
  const s = lab();
  deleteExperiment(s, 'E10', new Date('2026-08-01T10:00:00Z'));
  // A later delete drops trash entries older than TRASH_DAYS: E10 is gone for good, its result is not.
  deleteExperiment(s, 'E3', new Date(Date.parse('2026-08-01T10:00:00Z') + (TRASH_DAYS + 1) * 864e5));
  assert.ok(!JSON.stringify(s.all('trash')).includes('"E10"'), 'the E10 entry has expired');
  assert.equal(nextExperimentId(usedIds(s, 'experiment')), 'E11', 'm1 still names E10-F1');
  assert.ok(usedIds(s, 'formulation').includes('E10-F1'));
  assert.deepEqual(orphanedResults(s), { missing: [{ id: 'm1', batchId: 'E10-F1' }], reused: [] });
});

test('every place an id can be named reserves its number: inbox rows, expected slots, calendar links', () => {
  const s = lab();
  s.put('inbox', { id: 'i1', sampleName: 'E14-F2_4C_T09', test: 'dls', values: { zave_nm: 90 } });
  assert.equal(nextExperimentId(usedIds(s, 'experiment')), 'E15', 'an unassigned row of E14 keeps E14');
  s.put('events', { id: 'ev1', date: '2026-10-30', title: 'Make the repeat', link: '#/formulation?batch=E21-F3' });
  assert.equal(nextExperimentId(usedIds(s, 'experiment')), 'E22', 'a calendar link counts by its parameters');
  // An expected slot of an experiment in the trash names its formulations too.
  s.put('experiments', { id: 'E30', name: 'thirty', batchIds: [], expected: [{ id: 'E30-F7_final_dls', batchId: 'E30-F7', sampleName: 'E30-F7_final' }] });
  deleteExperiment(s, 'E30');
  assert.equal(nextExperimentId(usedIds(s, 'experiment')), 'E31');
  assert.ok(usedIds(s, 'formulation').includes('E30-F7'));
  // Free text that only mentions an id does not count; nothing would explain the gap.
  s.put('events', { id: 'ev2', date: '2026-10-31', title: 'as E99, but colder', link: '' });
  s.put('batches', { id: 'E1-F1', experimentId: 'E1', notes: 'E98 looked better' });
  assert.equal(nextExperimentId(usedIds(s, 'experiment')), 'E31');
});

test('formulations: a round added to an experiment is numbered past its deleted and its stray formulations', () => {
  const s = lab();
  // A result of E4-F3, a formulation no longer on record, and an unassigned row whose sample name is E4-F5.
  s.put('measurements', { id: 'm2', batchId: 'E4-F3', experimentId: 'E4', test: 'ee', values: { ee_pct: 91 } });
  s.put('inbox', { id: 'i2', sampleName: 'E4-F5_final', test: 'dls', values: {} });
  const next = makeFormulationAllocator('E4', usedIds(s, 'formulation'));
  assert.equal(next(), 'E4-F6');
  assert.equal(next(), 'E4-F7');
  assert.equal(makeFormulationAllocator('E2', usedIds(s, 'formulation'))(), 'E2-F3', 'other experiments do not move it');
});

test('stocks and buffer lots: a deleted one keeps its number while the trash or a formulation names it', () => {
  const s = lab();
  s.put('stocks', { id: 'Stock-002', compositionId: 1 });
  s.moveToTrash([['stocks', 'Stock-002']], { kind: 'stock' });
  assert.equal(nextStockId(s.all('stocks').map((x) => x.id)), 'Stock-002', 'the shelf alone would give it out again');
  assert.equal(nextStockId(usedIds(s, 'stock')), 'Stock-003');
  // A stock deleted long ago, still written on a formulation and on the plan of an experiment.
  s.put('batches', { id: 'E2-F1', experimentId: 'E2', stockId: 'Stock-007' });
  s.put('experiments', { id: 'E5', name: 'five', batchIds: [], spec: { stockId: 'Stock-009' } });
  assert.equal(nextStockId(usedIds(s, 'stock')), 'Stock-010');

  s.put('buffers', { id: 'Buffer-001', lot: 'Buffer-001', name: 'Acetate 50 mM pH 5.5' });
  s.put('buffers', { id: 'Buffer-002', lot: 'Buffer-002', name: 'PBS' });
  s.moveToTrash([['buffers', 'Buffer-002']], { kind: 'buffer' });
  assert.equal(nextBufferLot(s.all('buffers')), 'Buffer-002', 'the shelf alone would give it out again');
  assert.equal(nextBufferLot(usedIds(s, 'buffer')), 'Buffer-003');
  // The dialysis buffer of a formulation, wherever on the record it is written.
  s.put('batches', { id: 'E2-F2', experimentId: 'E2', plan: { downstream: { dialysis: { buffer: 'Buffer-005' } } } });
  assert.equal(nextBufferLot(usedIds(s, 'buffer')), 'Buffer-006');
});

test('usedIds lists each id once and refuses a series it does not know', () => {
  const s = lab();
  const ids = usedIds(s, 'experiment');
  assert.equal(ids.length, new Set(ids).size);
  assert.deepEqual(ids.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), Array.from({ length: 10 }, (_, i) => `E${i + 1}`));
  assert.throws(() => usedIds(s, 'lot'), /no series called "lot"/);
  assert.deepEqual(usedIds({ all: () => [] }, 'stock'), [], 'an empty store uses nothing');
});

test('orphaned results: gone, in the trash, and a number an earlier version gave out twice', () => {
  const s = lab();
  assert.deepEqual(orphanedResults(s), { missing: [], reused: [] }, 'a healthy store has none');
  // Its formulation in the trash: not orphaned, Undo brings it back.
  const entry = deleteExperiment(s, 'E10');
  assert.deepEqual(orphanedResults(s), { missing: [], reused: [] });
  // The old numbering: a new E10 created over the deleted one. The result may belong to either.
  s.put('experiments', { id: 'E10', name: 'new ten', batchIds: ['E10-F1'] });
  s.put('batches', { id: 'E10-F1', experimentId: 'E10', status: 'planned', createdAt: '2026-10-28T09:00:00.000Z' });
  assert.deepEqual(orphanedResults(s).reused, [{ id: 'm1', batchId: 'E10-F1' }]);
  assert.equal(s.restoreFromTrash(entry.id).ok, false, 'and that is why Undo was refused');
  // A record hand-deleted from the store, with no trash entry: its result is missing its formulation.
  s.remove('batches', 'E2-F2');
  s.put('measurements', { id: 'm3', batchId: 'E2-F2', test: 'dls', values: { zave_nm: 75 } });
  s.put('measurements', { id: 'm4', batchId: null, test: 'ph', values: { ph: 7.4 } });
  assert.deepEqual(orphanedResults(s).missing, [{ id: 'm3', batchId: 'E2-F2' }], 'a result with no formulation at all is not orphaned');
});

test('a delete cut off halfway leaves the same formulation in both places, which is not a reuse', () => {
  const s = lab();
  const rec = s.get('batches', 'E10-F1');
  // The trash entry is written first; the crash comes before the records are removed.
  s.put('trash', { id: 'trash-x', kind: 'experiment', deletedAt: '2026-10-27T10:00:00.000Z', records: [{ col: 'batches', index: 18, after: 'E9-F2', before: 'E10-F2', rec }] });
  s.put('batches', { ...rec, status: 'produced' }); // edited since: still the same record
  assert.deepEqual(orphanedResults(s), { missing: [], reused: [] });
});
