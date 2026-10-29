// One window writes (usability cycle 6, W1; app/store.js, WindowRole). Each window holds the collections in memory
// and stores them whole, so two windows on one lab wrote over each other: Settings, an experiment page left open,
// a record neither had stored, "Delete all data" undone by the other window. Now the first window on a lab writes;
// another one only shows the records, refuses every change whole, and writes only once it takes over.
//
// Each test is an origin of its own: one database, one localStorage, and the messages between its windows (a
// stand-in for the BroadcastChannel, or the storage event where there is none), with the timings shortened.
import test from 'node:test';
import assert from 'node:assert/strict';

const { Store, memoryBackend, windowLink } = await import('../app/store.js');

const TIMES = { beat: 20, stale: 60, ask: 30, settle: 10, handover: 150, bye: 5 };
const until = async (ok, ms = 1000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end;) await new Promise((r) => setTimeout(r, 5)); return ok(); };

/** An origin. window() gives a window's {link, storage, kill}: kill() makes it stop answering, as a crash does. */
function origin({ storageEvents = false } = {}) {
  const backend = { ...memoryBackend(), kind: 'indexeddb' };
  const data = new Map(), windows = new Set();
  const shared = { getItem: (k) => (data.has(k) ? data.get(k) : null), get length() { return data.size; }, key: (i) => [...data.keys()][i] ?? null };
  // The store's own bookkeeping (clear() and the moved-to-IndexedDB mark) reads the global one.
  globalThis.localStorage = { ...shared, setItem: (k, v) => { data.set(k, String(v)); }, removeItem: (k) => { data.delete(k); }, get length() { return data.size; } };
  const window = () => {
    const w = { dead: false, fns: new Set() };
    const changed = (key, newValue) => { for (const o of windows) if (o !== w && !o.dead) setTimeout(() => o.fns.forEach((fn) => fn({ key, newValue }))); };
    w.storage = {
      ...shared,
      setItem: (k, v) => { if (w.dead) return; data.set(k, String(v)); if (storageEvents) changed(k, String(v)); },
      removeItem: (k) => { if (w.dead) return; data.delete(k); if (storageEvents) changed(k, null); },
    };
    if (storageEvents) w.link = windowLink({ storage: w.storage, target: { addEventListener: (type, fn) => { if (type === 'storage') w.fns.add(fn); } } });
    else {
      const fns = new Set();
      w.hear = (m) => { if (!w.dead) fns.forEach((fn) => fn(m)); };
      w.link = { post: (m) => { if (w.dead) return; const copy = JSON.parse(JSON.stringify(m)); for (const o of windows) if (o !== w) setTimeout(() => o.hear?.(copy)); }, listen: (fn) => fns.add(fn) };
    }
    w.kill = () => { w.dead = true; };
    windows.add(w);
    return w;
  };
  const stored = async (ns, col) => JSON.parse((await backend.load(ns))[col] || '[]');
  return { backend, window, stored, data };
}

async function open(o, ns = 'lnp-lab') {
  const w = o.window();
  const s = new Store(ns, { backend: o.backend, windows: { link: w.link, storage: w.storage, times: TIMES } });
  await s.ready();
  s.kill = w.kill;
  return s;
}

test('the first window writes; another on the same lab only shows the records and refuses every change whole, without an exception', async () => {
  const o = origin();
  const a = await open(o), b = await open(o);
  assert.equal(a.readOnly, false);
  assert.equal(b.readOnly, true, 'the second window only shows the records');
  a.put('experiments', { id: 'E1', name: 'Size screen' }); a.put('batches', { id: 'E1-F1', experimentId: 'E1', status: 'planned' });
  await a.flush();
  assert.ok(await until(() => b.get('experiments', 'E1')), 'it reads back what the writer stored');

  const refused = [];
  b.onRefused = (r) => refused.push(r);
  const rec = b.put('experiments', { id: 'E2', name: 'typed in the second window' });
  assert.equal(rec.id, 'E2', 'put() gives back the record, as a caller expects');
  assert.equal(b.get('experiments', 'E2'), null, 'and memory is unchanged');
  b.remove('experiments', 'E1');
  assert.ok(b.get('experiments', 'E1'));
  assert.equal(refused.length, 2);

  // A transaction runs, so its caller gets its value, and everything it changed goes back: nothing half-done.
  let saved = false, undone = null;
  localStorage.setItem('lnp-lab.counter.experiment', '1');
  const value = b.transaction(() => {
    const e = b.get('experiments', 'E1'); e.name = 'renamed'; b.put('experiments', e);
    b.put('batches', { id: 'E1-F2', experimentId: 'E1' });
    b.put('measurements', { id: 'm1', batchId: 'E1-F1' });
    // a create raises the id high-water marks as it goes (raiseCounter in app/schema.js)
    localStorage.setItem('lnp-lab.counter.experiment', '2'); localStorage.setItem('lnp-lab.counter.stock', '5');
    return { id: 'm1' };
  }, { what: 'the result for E1-F1_final', onSaved: () => { saved = true; }, onUndone: (p) => { undone = p; } });
  assert.deepEqual(value, { id: 'm1' });
  assert.equal(b.get('experiments', 'E1').name, 'Size screen');
  assert.equal(b.count('batches'), 1);
  assert.equal(b.count('measurements'), 0);
  assert.equal(localStorage.getItem('lnp-lab.counter.experiment'), '1', 'a refused create does not use up its number');
  assert.equal(localStorage.getItem('lnp-lab.counter.stock'), null);
  await new Promise((r) => setTimeout(r));
  assert.equal(saved, false);
  assert.equal(undone?.kind, 'readonly', 'a screen waiting on the write hears it was not made');
  assert.deepEqual(refused.at(-1), { what: 'the result for E1-F1_final', kept: true });

  assert.equal(b.moveToTrash([['experiments', 'E1']], { label: 'E1' }), null, 'no delete, so nothing to undo');
  assert.ok(b.get('experiments', 'E1'));
  assert.equal(b.restoreFromTrash('trash-x').ok, false);
  assert.equal(b.importAll({ collections: { experiments: [{ id: 'E9' }] } }).records, 1);
  assert.equal(b.get('experiments', 'E9'), null);
  b.emptyTrash();
  const cleared = await b.clear();
  assert.equal(cleared.ok, false, '"Delete all data" in the window that only shows the records deletes nothing');
  await assert.rejects(b.poke('lnp-lab', 'experiments', []), /another window/);

  // Nothing of it reaches the database, and nothing waits to be written.
  assert.deepEqual((await b.flush()).ok, true);
  assert.equal(b.unsaved(), false);
  assert.deepEqual((await o.stored('lnp-lab', 'experiments')).map((e) => [e.id, e.name]), [['E1', 'Size screen']]);
  assert.equal((await o.stored('lnp-lab', 'batches')).length, 1);
  assert.equal(b.count('experiments'), 1, 'and the window still shows the records');
  a.leave(); b.leave();
});

test('takeover works both ways, and the writer first stores what it has pending', async () => {
  const o = origin();
  const a = await open(o), b = await open(o);
  const roles = [];
  a.onRole = (ro) => roles.push(['a', ro]); b.onRole = (ro) => roles.push(['b', ro]);
  a.put('experiments', { id: 'E1', name: 'stored' }); await a.flush();
  // A save still waiting for the typing to pause in window a (kit.js runs these before the handover).
  a.beforeYield = () => { const e = a.get('experiments', 'E1'); e.name = 'typed in a just before'; a.put('experiments', e); };

  assert.equal(await b.takeOver(), true);
  assert.equal(b.readOnly, false); assert.equal(a.readOnly, true);
  assert.deepEqual(roles, [['a', true], ['b', false]]);
  assert.equal(b.get('experiments', 'E1').name, 'typed in a just before', 'what a had pending was stored, and read back here');
  assert.equal((await o.stored('lnp-lab', 'experiments'))[0].name, 'typed in a just before');

  b.put('experiments', { id: 'E2', name: 'from b' }); await b.flush();
  assert.equal(a.put('experiments', { id: 'E3' }).id, 'E3');
  assert.equal(a.get('experiments', 'E3'), null, 'a, now read-only, refuses');
  assert.ok(await until(() => a.get('experiments', 'E2')));

  a.beforeYield = null;
  assert.equal(await a.takeOver(), true, 'and back');
  assert.equal(a.readOnly, false); assert.equal(b.readOnly, true);
  a.put('experiments', { id: 'E4' }); await a.flush();
  assert.deepEqual((await o.stored('lnp-lab', 'experiments')).map((e) => e.id), ['E1', 'E2', 'E4']);
  a.leave(); b.leave();
});

test('a writer that closes frees the role at once; one that stops answering, within a few beats', async () => {
  const o = origin();
  const a = await open(o), b = await open(o), c = await open(o);
  a.put('experiments', { id: 'E1' }); await a.flush();
  await a.flush(); a.leave(); // what pagehide does
  assert.ok(await until(() => !b.readOnly || !c.readOnly, 500), 'another window writes once the writer has closed');
  assert.equal([b, c].filter((s) => !s.readOnly).length, 1, 'one of them, not both');
  const [writer, other] = b.readOnly ? [c, b] : [b, c];
  writer.put('experiments', { id: 'E2' }); await writer.flush();
  assert.ok(await until(() => other.get('experiments', 'E2')));
  writer.kill(); // a crash: no goodbye, no heartbeat, no answer
  const t0 = Date.now();
  assert.ok(await until(() => !other.readOnly, 2000), 'the last window takes the role');
  assert.ok(Date.now() - t0 >= TIMES.stale - TIMES.beat, 'once the writer has been quiet for a while, not at once');
  assert.ok(other.get('experiments', 'E2'), 'with the records as stored');
  other.put('experiments', { id: 'E3' }); await other.flush();
  assert.deepEqual((await o.stored('lnp-lab', 'experiments')).map((e) => e.id), ['E1', 'E2', 'E3']);
  other.leave();
});

test('a writer that lost the role without hearing of it stores nothing over the window that has it', async () => {
  const o = origin();
  const a = await open(o), b = await open(o);
  a.put('experiments', { id: 'E1', name: 'stored' }); await a.flush();
  await until(() => b.get('experiments', 'E1'));
  // Window a stops answering (a frozen tab); b is asked to take over and, hearing nothing, takes the role.
  const deaf = a.kill; deaf();
  assert.equal(await b.takeOver(), true);
  b.put('experiments', { id: 'E1', name: 'from b' }); await b.flush();
  // Window a wakes up and its user types on: it reads the role from the lease, and refuses.
  let undone = null;
  a.transaction(() => { a.put('experiments', { id: 'E1', name: 'old copy from a' }); }, { onUndone: (p) => { undone = p; } });
  assert.equal(a.readOnly, true);
  await a.flush();
  assert.equal((await o.stored('lnp-lab', 'experiments'))[0].name, 'from b');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(undone?.kind, 'readonly');
  b.leave();
});

test('the real lab and the demo are separate: a window on each writes', async () => {
  const o = origin();
  const lab = await open(o, 'lnp-lab'), demo = await open(o, 'lnp-demo'), demo2 = await open(o, 'lnp-demo');
  assert.equal(lab.readOnly, false);
  assert.equal(demo.readOnly, false);
  assert.equal(demo2.readOnly, true, 'a second window on the demo only shows it');
  lab.put('experiments', { id: 'E1', name: 'real' }); demo.put('experiments', { id: 'E1', name: 'invented' });
  await lab.flush(); await demo.flush();
  assert.equal((await o.stored('lnp-lab', 'experiments'))[0].name, 'real');
  assert.equal((await o.stored('lnp-demo', 'experiments'))[0].name, 'invented');
  lab.leave(); demo.leave(); demo2.leave();
});

test('two windows opened at the same moment agree: one of them writes', async () => {
  const o = origin();
  const ws = await Promise.all([open(o), open(o), open(o)]);
  assert.equal(ws.filter((s) => !s.readOnly).length, 1);
  ws.forEach((s) => s.leave());
});

test('"Delete all data" in the writer empties the other window too, and the writer keeps writing', async () => {
  const o = origin();
  const a = await open(o), b = await open(o);
  a.put('experiments', { id: 'E1' }); a.put('batches', { id: 'E1-F1' }); await a.flush();
  assert.ok(await until(() => b.count('batches') === 1));
  assert.equal((await a.clear()).ok, true);
  assert.ok(await until(() => b.count('batches') === 0 && b.count('experiments') === 0), 'the other window shows the empty lab');
  await new Promise((r) => setTimeout(r, TIMES.stale + 2 * TIMES.beat));
  assert.equal(a.readOnly, false, 'the record of who writes is not erased with the lab');
  assert.equal(b.readOnly, true);
  a.leave(); b.leave();
});

test('without BroadcastChannel (Safari 15.0) the windows talk through localStorage\'s storage event', async () => {
  const BC = globalThis.BroadcastChannel;
  delete globalThis.BroadcastChannel;
  try {
    const o = origin({ storageEvents: true });
    const a = await open(o), b = await open(o);
    assert.equal(a.readOnly, false); assert.equal(b.readOnly, true);
    a.put('experiments', { id: 'E1' }); await a.flush();
    assert.ok(await until(() => b.get('experiments', 'E1')), 'the stored collections are read back');
    a.beforeYield = () => a.put('experiments', { id: 'E2' });
    assert.equal(await b.takeOver(), true);
    assert.equal(a.readOnly, true);
    assert.ok(b.get('experiments', 'E2'), 'the takeover waited for what a had pending');
    b.leave();
    assert.ok(await until(() => !a.readOnly, 500), 'and a window that closes frees the role');
    a.leave();
  } finally { globalThis.BroadcastChannel = BC; }
});

test('a store without windows (tests, the macOS app) always writes, and talks to no window where there is no BroadcastChannel', async () => {
  const o = origin();
  const BC = globalThis.BroadcastChannel;
  delete globalThis.BroadcastChannel; // the macOS app's window on macOS 12.0
  try {
    const s = new Store('lnp-lab', { backend: o.backend });
    await s.ready();
    assert.equal(s.readOnly, false);
    s.put('experiments', { id: 'E1' }); await s.flush();
    assert.ok(s.get('experiments', 'E1'));
    assert.equal(await s.takeOver(), true);
    assert.equal(await s.rejoin(), false);
    s.leave();
    assert.deepEqual([...o.data.keys()].filter((k) => /window/.test(k)), [], 'no messages through localStorage, and no record of a writer');
  } finally { globalThis.BroadcastChannel = BC; }
});
