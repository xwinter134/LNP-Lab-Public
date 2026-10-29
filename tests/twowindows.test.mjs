// One record open in two windows (app/ui/kit.js sharedRecord, Store.watchOtherWindows). Each window stores as it
// is edited, and a save used to write the window's whole copy: the window opened first undid what the other had
// stored since, and could bring back a record the other had moved to the trash. Now a save lays what was changed
// in its window over the record as stored, and a window hears the other's writes.
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); }, get length() { return mem.size; }, key: (i) => [...mem.keys()][i] ?? null };
const { Store, memoryBackend } = await import('../app/store.js');
const { sharedRecord } = await import('../app/ui/kit.js');

async function lab(backend = memoryBackend()) { const s = new Store('lnp-lab', { backend }); await s.ready(); return s; }
const batch = () => ({ id: 'E1-F1', notes: '', plan: { rna: { mass_mg: 3, stock_mg_mL: null }, mixing: { frr: 3 } }, actual: {} });

test('a save stores what was changed in this window over what another window stored meanwhile', async () => {
  const store = await lab();
  store.put('batches', batch());
  // window 1 opens the record
  const mine = store.get('batches', 'E1-F1');
  const rna = mine.plan.rna;
  const shared = sharedRecord(store, 'batches', mine);
  // window 2 stores a remark and an RNA input
  const theirs = store.get('batches', 'E1-F1');
  theirs.notes = 'from window 2'; theirs.plan.rna.mass_mg = 4.2;
  store.put('batches', theirs);
  // window 1, still showing the record as it opened it, ticks a box
  mine.actual.pretest = true;
  assert.equal(shared.take(), true);
  store.put('batches', mine); shared.stored();
  let stored = store.get('batches', 'E1-F1');
  assert.equal(stored.notes, 'from window 2');
  assert.equal(stored.plan.rna.mass_mg, 4.2);
  assert.equal(stored.actual.pretest, true);
  // and the screen shows what is stored, in the objects it holds
  assert.equal(mine.notes, 'from window 2');
  assert.equal(mine.plan.rna, rna);
  assert.equal(rna.mass_mg, 4.2);

  // the next save carries what changed here since, and nothing older: window 2's next remark stays too
  const later = store.get('batches', 'E1-F1'); later.notes = 'second remark'; store.put('batches', later);
  mine.plan.mixing.frr = 4;
  shared.take(); store.put('batches', mine); shared.stored();
  stored = store.get('batches', 'E1-F1');
  assert.equal(stored.notes, 'second remark');
  assert.equal(stored.plan.mixing.frr, 4);
  assert.equal(stored.actual.pretest, true);

  // a field both windows changed: the later save wins, as it would on paper
  const both = store.get('batches', 'E1-F1'); both.plan.rna.mass_mg = 5; store.put('batches', both);
  mine.plan.rna.mass_mg = 6;
  shared.take(); store.put('batches', mine); shared.stored();
  assert.equal(store.get('batches', 'E1-F1').plan.rna.mass_mg, 6);

  // a mass cleared in window 2 (the key deleted) is not put back by window 1
  mine.actual.mc3 = 0.1; shared.take(); store.put('batches', mine); shared.stored();
  const cleared = store.get('batches', 'E1-F1'); delete cleared.actual.mc3; store.put('batches', cleared);
  mine.notes = 'third remark';
  shared.take(); store.put('batches', mine); shared.stored();
  assert.equal('mc3' in store.get('batches', 'E1-F1').actual, false);
  assert.equal('mc3' in mine.actual, false);
});

test('typing not yet stored survives a refresh from another window, and is stored with the next save', async () => {
  const store = await lab();
  store.put('batches', batch());
  const mine = store.get('batches', 'E1-F1');
  const shared = sharedRecord(store, 'batches', mine);
  mine.plan.rna.mass_mg = 2.5; // typed, waiting for the pause before it is stored
  const theirs = store.get('batches', 'E1-F1'); theirs.notes = 'from window 2'; store.put('batches', theirs);
  assert.equal(shared.take(), true); // the other window's write is heard: the screen is brought up to date
  assert.equal(mine.notes, 'from window 2');
  assert.equal(mine.plan.rna.mass_mg, 2.5, 'what is being typed stays on the screen');
  assert.equal(store.get('batches', 'E1-F1').plan.rna.mass_mg, 3, 'and is not stored by the refresh');
  shared.take(); store.put('batches', mine); shared.stored(); // the pause
  assert.equal(store.get('batches', 'E1-F1').plan.rna.mass_mg, 2.5);
  assert.equal(store.get('batches', 'E1-F1').notes, 'from window 2');
});

test('a record moved to the trash, in this window or another, is not brought back by a save', async () => {
  const store = await lab();
  store.put('stocks', { id: 'Stock-001', notes: '', status: 'made' });
  const mine = store.get('stocks', 'Stock-001');
  const shared = sharedRecord(store, 'stocks', mine);
  store.moveToTrash([['stocks', 'Stock-001']], { kind: 'stock' });
  mine.notes = 'typed after the delete';
  assert.equal(shared.take(), false);
  assert.equal(store.get('stocks', 'Stock-001'), null);
  assert.equal(mine.notes, 'typed after the delete', 'what was typed is left as it was');
  // and the trash can still put it back: nothing newer has taken its place
  assert.equal(store.restoreFromTrash(store.recentTrash()[0].id).ok, true);
});

test('a window hears what another window stored once it has read it back, and only about its own record', async () => {
  // Two windows: two stores on one database. The store says what it stored on a BroadcastChannel only when
  // that database is IndexedDB, so the stand-in calls itself that.
  const backend = { ...memoryBackend(), kind: 'indexeddb' };
  const w1 = await lab(backend), w2 = await lab(backend);
  w1.put('batches', batch()); w1.put('batches', { ...batch(), id: 'E1-F2' });
  await w1.flush();
  const until = async (ok) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); return ok(); };
  assert.ok(await until(() => w2.get('batches', 'E1-F1')), 'window 2 read the first write back');

  const heard = [], told = [];
  const stop = w2.watchOtherWindows((cols) => heard.push(cols));
  const mine = w2.get('batches', 'E1-F1');
  let shown = true;
  sharedRecord(w2, 'batches', mine).watch(() => shown, (now) => told.push(now));

  const other = w1.get('batches', 'E1-F2'); other.notes = 'another record'; w1.put('batches', other);
  await w1.flush();
  assert.ok(await until(() => heard.length === 1));
  assert.deepEqual(heard[0], ['batches']);
  assert.equal(told.length, 0, 'a change to another record of the collection is not this screen\'s');

  const b = w1.get('batches', 'E1-F1'); b.notes = 'from window 1'; w1.put('batches', b);
  await w1.flush();
  assert.ok(await until(() => told.length === 1));
  assert.equal(told[0].notes, 'from window 1');
  assert.equal(w2.get('batches', 'E1-F1').notes, 'from window 1', 'read back before the screen is told');

  w1.moveToTrash([['batches', 'E1-F1']]);
  await w1.flush();
  assert.ok(await until(() => told.length === 2));
  assert.equal(told[1], null, 'gone: the screen is told so');

  // a screen that is gone stops listening, and so does a stopped watch
  shown = false; stop();
  w1.put('batches', { ...batch(), id: 'E1-F3' }); await w1.flush();
  await until(() => w2.get('batches', 'E1-F3'));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(heard.length, 3);
  assert.equal(told.length, 2);
});
