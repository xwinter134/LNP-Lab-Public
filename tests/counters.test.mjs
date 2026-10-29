// The high-water mark of each id series (usability cycle 4, m1): a number given out once is never given out
// again, even after nothing in the store names it any more, and a restore cannot lower the mark.
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
const { usedIds, nextExperimentId, nextStockId, makeFormulationAllocator, counterTop, raiseCounter, seedCounters } = await import('../app/schema.js');
const { nextBufferLot } = await import('../app/calc/buffer.js');

const DAY = 864e5;
const T0 = Date.parse('2026-09-01T10:00:00Z');

/** Create an experiment of two formulations the way the wizard does: number it, save it, raise the counter. */
function create(s, name) {
  const id = nextExperimentId(usedIds(s, 'experiment'));
  const next = makeFormulationAllocator(id, usedIds(s, 'formulation'));
  const forms = [next(), next()];
  for (const b of forms) s.put('batches', { id: b, experimentId: id, status: 'planned' });
  s.put('experiments', { id, name, batchIds: forms, expected: forms.map((b) => ({ id: `${b}_final_dls`, batchId: b, sampleName: `${b}_final`, status: 'open' })) });
  raiseCounter(s, 'experiment', id);
  return id;
}
const del = (s, id, at) => s.moveToTrash([['experiments', id], ...s.all('batches').filter((b) => b.experimentId === id).map((b) => ['batches', b.id])], { kind: 'experiment' }, new Date(at));
// A later delete is what drops trash entries older than TRASH_DAYS.
const expire = (s, at) => { s.put('experiments', { id: 'tmp', name: 'to delete', batchIds: [] }); s.moveToTrash([['experiments', 'tmp']], { kind: 'experiment' }, new Date(at)); };

function lab(n = 13) {
  mem.clear();
  const s = new Store('lnp-lab');
  for (let i = 1; i <= n; i++) create(s, `Experiment ${i}`);
  return s;
}

test('m1: an experiment without results, deleted, its trash entry expired: its number is not given out again', () => {
  const s = lab();
  const e14 = create(s, 'never measured');
  assert.equal(e14, 'E14');
  del(s, e14, T0);
  expire(s, T0 + (TRASH_DAYS + 1) * DAY);
  // Nothing in the store names E14 any more: not a record, not the trash, not a result.
  assert.ok(!/"E14(-F\d+)?(_|")/.test(JSON.stringify(s.exportAll().collections)), 'E14 has left no trace');
  // Without the counter, every trace-based count would hand E14 out again: that was m1.
  const traces = usedIds({ all: (c) => (c === 'counters' ? [] : s.all(c)) }, 'experiment');
  assert.equal(nextExperimentId(traces), 'E14');
  const id = nextExperimentId(usedIds(s, 'experiment'));
  assert.equal(id, 'E15');
  assert.equal(makeFormulationAllocator(id, usedIds(s, 'formulation'))(), 'E15-F1', 'a new experiment starts at F1, under a number nobody has used');
  assert.equal(create(s, 'the next one'), 'E15');
  assert.equal(counterTop(s, 'experiment'), 15);
});

test('stocks and buffer lots keep their counters the same way', () => {
  mem.clear();
  const s = new Store('lnp-lab');
  for (let i = 0; i < 3; i++) {
    const id = nextStockId(usedIds(s, 'stock'));
    s.put('stocks', { id, compositionId: 1 });
    raiseCounter(s, 'stock', id);
    const lot = nextBufferLot(usedIds(s, 'buffer'));
    s.put('buffers', { id: lot, lot, name: 'PBS' });
    raiseCounter(s, 'buffer', lot);
  }
  s.moveToTrash([['stocks', 'Stock-003'], ['buffers', 'Buffer-003']], { kind: 'stock' }, new Date(T0));
  expire(s, T0 + (TRASH_DAYS + 1) * DAY);
  assert.ok(!JSON.stringify(s.all('trash')).includes('Stock-003'), 'the entry has expired');
  assert.equal(nextStockId(usedIds(s, 'stock')), 'Stock-004');
  assert.equal(nextBufferLot(usedIds(s, 'buffer')), 'Buffer-004');
});

test('import of an older backup does not lower the counter, merged or replacing', () => {
  for (const merge of [true, false]) {
    const s = lab(10);
    const older = s.exportAll(); // carries counters: experiment at 10
    assert.equal(older.collections.counters.find((c) => c.id === 'experiment').top, 10, 'a backup carries the counter');
    for (let i = 0; i < 4; i++) create(s, 'after the backup'); // E11 … E14
    del(s, 'E14', T0);
    expire(s, T0 + (TRASH_DAYS + 1) * DAY);
    s.importAll(older, { merge });
    // The store's own record was handed back at 10, as Store.importAll replaces by id; this browser's mark was not.
    assert.equal(s.get('counters', 'experiment').top, 10, `merge=${merge}: the restore did replace the record`);
    assert.equal(counterTop(s, 'experiment'), 14, `merge=${merge}: but not the counter`);
    assert.equal(nextExperimentId(usedIds(s, 'experiment')), 'E15', `merge=${merge}: E14 stays taken`);
    // The next number given out brings the stored record back up, so the next backup carries it.
    create(s, 'after the restore');
    assert.equal(s.get('counters', 'experiment').top, 15);
  }
});

test('a restored backup with a higher counter wins, on this machine or a new one', () => {
  const s = lab(10);
  const backup = s.exportAll();
  backup.collections.counters = [{ id: 'experiment', top: 20 }]; // made on a machine that had got to E20
  s.importAll(backup);
  assert.equal(counterTop(s, 'experiment'), 20);
  assert.equal(nextExperimentId(usedIds(s, 'experiment')), 'E21');
  // A new machine: nothing in this browser but what the backup brings.
  mem.clear();
  const fresh = new Store('lnp-lab');
  fresh.importAll(backup);
  assert.equal(nextExperimentId(usedIds(fresh, 'experiment')), 'E21');
});

test('raiseCounter: only ever up, and only for a series that has a counter', () => {
  const s = lab(3);
  assert.equal(raiseCounter(s, 'experiment', 'E2'), 3, 'a lower number leaves it where it is');
  assert.equal(raiseCounter(s, 'experiment', 'E9'), 9);
  assert.equal(raiseCounter(s, 'experiment', 'not an id'), 9);
  assert.equal(raiseCounter(s, 'stock', 'Stock-012'), 12);
  assert.equal(raiseCounter(s, 'buffer', 'Buffer-007'), 7);
  assert.ok(usedIds(s, 'stock').includes('Stock-012'), 'the mark counts as one more trace, written as the id it stands for');
  assert.ok(usedIds(s, 'buffer').includes('Buffer-007'));
  assert.throws(() => raiseCounter(s, 'formulation', 'E1-F3'), /no counter/);
  assert.equal(counterTop(s, 'formulation'), 0);
  // A store with no namespace (a plain reader) has no browser mark; the collection alone counts.
  const rows = { counters: [{ id: 'experiment', top: 5 }] };
  assert.equal(counterTop({ all: (c) => rows[c] || [] }, 'experiment'), 5);
  assert.equal(nextExperimentId(usedIds({ all: (c) => rows[c] || [] }, 'experiment')), 'E6');
});

test('seedCounters: a store from before the counters starts from what it still names, the trash included', () => {
  mem.clear();
  const s = new Store('lnp-lab');
  // Written by an earlier version: records, no counters. E14 was deleted and is still in the trash.
  for (let i = 1; i <= 14; i++) s.put('experiments', { id: `E${i}`, name: `${i}`, batchIds: [] });
  s.put('stocks', { id: 'Stock-002', compositionId: 1 });
  s.moveToTrash([['experiments', 'E14']], { kind: 'experiment' }, new Date(T0));
  seedCounters(s);
  assert.deepEqual(Object.fromEntries(s.all('counters').map((c) => [c.id, c.top])), { experiment: 14, stock: 2, buffer: 0 },
    'a series with nothing in it is stored at 0, so it is not walked again');
  expire(s, T0 + (TRASH_DAYS + 1) * DAY);
  assert.equal(nextExperimentId(usedIds(s, 'experiment')), 'E15', 'the expiry no longer frees E14');
  // Once there is a counter, seeding leaves it alone.
  raiseCounter(s, 'experiment', 'E30');
  seedCounters(s);
  assert.equal(s.get('counters', 'experiment').top, 30);
  // The demo namespace keeps its own.
  const demo = new Store('lnp-demo');
  demo.put('stocks', { id: 'Stock-004', compositionId: 1 });
  seedCounters(demo);
  assert.equal(counterTop(demo, 'experiment'), 0);
  assert.equal(counterTop(demo, 'stock'), 4);
});

test('seedCounters: a fresh browser writes nothing until there is a number to keep, so a restore is still seeded from', () => {
  mem.clear();
  const s = new Store('lnp-lab');
  seedCounters(s); // the overview of an empty app
  assert.deepEqual(s.all('counters'), []);
  // A backup made before there were counters: E7 in its trash, no counters collection.
  const old = { collections: { experiments: [{ id: 'E1', name: 'one', batchIds: [] }], trash: [{ id: 't1', kind: 'experiment', deletedAt: new Date(T0).toISOString(), records: [{ col: 'experiments', index: 1, rec: { id: 'E7', name: 'seven', batchIds: [] } }] }] } };
  s.importAll(old);
  seedCounters(s);
  expire(s, T0 + (TRASH_DAYS + 1) * DAY);
  assert.equal(nextExperimentId(usedIds(s, 'experiment')), 'E8');
  assert.equal(s.get('counters', 'buffer').top, 0, 'and the series with nothing in it are settled at 0');
});
