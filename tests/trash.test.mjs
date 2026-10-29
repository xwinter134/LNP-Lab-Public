// Deleting into the trash and restoring from it: what goes back is exactly what went, where it was.
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

function lab() {
  mem.clear();
  localStorage.setItem('lnp-lab.mode', 'advanced');
  const s = new Store('lnp-lab');
  for (const id of ['E1', 'E2', 'E3']) s.put('experiments', { id, name: `Experiment ${id}`, batchIds: [`${id}-F1`, `${id}-F2`] });
  for (const e of ['E1', 'E2', 'E3']) for (const f of ['F1', 'F2']) s.put('batches', { id: `${e}-${f}`, experimentId: e, status: 'planned' });
  s.put('measurements', { id: 'm1', batchId: 'E2-F1', test: 'dls', values: { zave_nm: 80 } });
  s.put('stocks', { id: 'Stock-001', compositionId: 1 });
  return s;
}
const snapshot = (s) => ({ experiments: s.all('experiments'), batches: s.all('batches'), measurements: s.all('measurements'), stocks: s.all('stocks') });
const deleteE2 = (s, now) => s.moveToTrash([['experiments', 'E2'], ['batches', 'E2-F1'], ['batches', 'E2-F2']], { kind: 'experiment', label: 'Experiment 2 · 2 formulations' }, now);

test('an experiment and its formulations go to the trash as one entry; measurements stay', () => {
  const s = lab();
  const entry = deleteE2(s, new Date('2026-10-27T10:00:00Z'));
  assert.deepEqual(s.all('experiments').map((e) => e.id), ['E1', 'E3']);
  assert.deepEqual(s.all('batches').map((b) => b.id), ['E1-F1', 'E1-F2', 'E3-F1', 'E3-F2']);
  assert.equal(s.count('measurements'), 1, 'measurements are not deleted with an experiment');
  assert.equal(s.count('trash'), 1);
  assert.equal(entry.kind, 'experiment');
  assert.equal(entry.label, 'Experiment 2 · 2 formulations');
  assert.equal(entry.deletedAt, '2026-10-27T10:00:00.000Z');
  assert.deepEqual(entry.records.map((r) => `${r.col}/${r.rec.id}`), ['experiments/E2', 'batches/E2-F1', 'batches/E2-F2']);
  assert.deepEqual(s.recentTrash({ now: new Date('2026-10-27T11:00:00Z') }).map((t) => t.id), [entry.id]);
});

test('restoring puts back exactly what was removed, in the same places, and empties the entry', () => {
  const s = lab();
  const before = snapshot(s);
  const entry = deleteE2(s);
  const r = s.restoreFromTrash(entry.id);
  assert.equal(r.ok, true);
  assert.equal(r.entry.id, entry.id);
  assert.deepEqual(snapshot(s), before, 'same records, same timestamps, same order');
  assert.equal(s.count('trash'), 0);
  assert.equal(s.restoreFromTrash(entry.id).ok, false, 'a second restore has nothing left to restore');
});

test('several deletes restore independently, in any order', () => {
  const s = lab();
  const before = snapshot(s);
  const a = deleteE2(s);
  const b = s.moveToTrash([['stocks', 'Stock-001']], { kind: 'stock' });
  const c = s.moveToTrash([['experiments', 'E1'], ['batches', 'E1-F1'], ['batches', 'E1-F2']], { kind: 'experiment' });
  assert.equal(s.count('experiments'), 1);
  for (const e of [a, c, b]) assert.equal(s.restoreFromTrash(e.id).ok, true);
  assert.deepEqual(snapshot(s), before);
});

test('an id given to a new record meanwhile is not overwritten; nothing is restored and the reason is given', () => {
  const s = lab();
  const entry = s.moveToTrash([['experiments', 'E3'], ['batches', 'E3-F1'], ['batches', 'E3-F2']], { kind: 'experiment' });
  // The next new experiment takes the highest free number, which is 3 again.
  s.put('experiments', { id: 'E3', name: 'A new one' });
  const r = s.restoreFromTrash(entry.id);
  assert.equal(r.ok, false);
  assert.deepEqual(r.taken, ['E3']);
  assert.match(r.reason, /E3 is in use again/);
  assert.equal(s.get('experiments', 'E3').name, 'A new one');
  assert.equal(s.get('batches', 'E3-F1'), null, 'not half restored');
  assert.equal(s.count('trash'), 1, 'and still in the trash');
});

test('a delete cut off after the trash was written restores without doubling the record', () => {
  const s = lab();
  const keep = s.get('stocks', 'Stock-001');
  const entry = s.moveToTrash([['stocks', 'Stock-001']]);
  s.replace('stocks', [keep]); // as if the removal had never been written
  assert.equal(s.restoreFromTrash(entry.id).ok, true);
  assert.deepEqual(s.all('stocks'), [keep]);
});

test('nothing to move is not an entry', () => {
  const s = lab();
  assert.equal(s.moveToTrash([['experiments', 'E9']]), null);
  assert.equal(s.moveToTrash([]), null);
  assert.equal(s.count('trash'), 0);
});

test('the restore list covers 30 days; older entries go at the next delete, and Empty trash erases all', () => {
  const s = lab();
  const old = s.moveToTrash([['stocks', 'Stock-001']], {}, new Date('2026-09-25T10:00:00Z')); // 32 days before "now"
  const recent = deleteE2(s, new Date('2026-10-20T10:00:00Z'));
  const now = new Date('2026-10-27T10:00:00Z');
  assert.equal(TRASH_DAYS, 30);
  assert.deepEqual(s.recentTrash({ now }).map((t) => t.id), [recent.id], 'listed: the last 30 days only');
  assert.equal(s.count('trash'), 2, 'the old one is still stored until something else is deleted');
  const newest = s.moveToTrash([['experiments', 'E1']], {}, now);
  assert.deepEqual(s.all('trash').map((t) => t.id), [recent.id, newest.id], 'and then dropped');
  assert.deepEqual(s.recentTrash({ now }).map((t) => t.id), [newest.id, recent.id], 'newest first');
  void old;
  s.emptyTrash();
  assert.equal(s.count('trash'), 0);
  assert.equal(s.restoreFromTrash(recent.id).ok, false);
});

test('two deletes in the same millisecond still list the later one first', () => {
  const s = lab();
  const now = new Date('2026-10-27T10:00:00Z');
  const a = s.moveToTrash([['stocks', 'Stock-001']], {}, now);
  const b = s.moveToTrash([['experiments', 'E1']], {}, now);
  assert.deepEqual(s.recentTrash({ now }).map((t) => t.id), [b.id, a.id]);
});

test('the trash is exported and imported like any collection, and restores after the round trip', () => {
  const s = lab();
  const before = snapshot(s);
  const entry = deleteE2(s);
  const file = JSON.parse(JSON.stringify(s.exportAll()));
  assert.ok(Array.isArray(file.collections.trash) && file.collections.trash.length === 1, 'the backup carries the trash');
  mem.clear();
  const fresh = new Store('lnp-lab');
  fresh.importAll(file);
  assert.equal(fresh.count('trash'), 1);
  assert.equal(fresh.restoreFromTrash(entry.id).ok, true);
  assert.deepEqual(snapshot(fresh), before);
});
