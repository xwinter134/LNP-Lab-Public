// The record store: backup and restore (the export holds the data and nothing else, and neither direction
// throws on a stray key), and since usability cycle 4 its persistence: collections held in memory and written
// to a backend (IndexedDB in the browser, a fake one here), moved once out of localStorage, written together,
// and a write that cannot be stored undone and said plainly.
import test from 'node:test';
import assert from 'node:assert/strict';

// Without IndexedDB (node has none) the store keeps its collections in localStorage, as it did before cycle 4,
// and node has no localStorage either: give it one before the modules that use it load.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  get length() { return mem.size; },
  key: (i) => [...mem.keys()][i] ?? null,
};
const { Store, describeFailure, storageProblem, failureKind } = await import('../app/store.js');

// What a browser holds after a while in the app: preferences written as bare strings by main.js, demo.js,
// settings.js, calendar.js and migrate.js, sitting under the same prefix as the data.
const PREFS = {
  'lnp-lab.mode': 'advanced',
  'lnp-lab.theme': 'dark',
  'lnp-lab.navExperiments': 'closed',
  'lnp-lab.lastExport': '27/10/2026, 10:12:03',
  'lnp-lab.demo': '1',
  'lnp-lab.reminders': '1',
  'lnp-lab.notified.2026-10-27': '1',
  'lnp-lab.schemaVersion': '2',
};

function browser() {
  mem.clear();
  for (const [k, v] of Object.entries(PREFS)) localStorage.setItem(k, v);
  const s = new Store('lnp-lab');
  s.put('experiments', { id: 'E1', name: 'N/P scan', type: 'ofat' });
  s.put('experiments', { id: 'E2', name: 'Stability', type: 'stability' });
  s.put('batches', { id: 'E1-F1', experimentId: 'E1', status: 'planned' });
  s.put('settings', { id: 'default', operator: 'AB' });
  // The demo lab lives beside the real one and must not leak into its backup.
  new Store('lnp-demo').put('experiments', { id: 'E1', name: 'Invented' });
  return s;
}

test('export works with the preferences present, and holds only the data collections', () => {
  const s = browser();
  const out = s.exportAll(); // threw "Unexpected token 'a', "advanced" is not valid JSON" before
  assert.deepEqual(Object.keys(out.collections).sort(), ['batches', 'experiments', 'settings']);
  assert.equal(out.ns, 'lnp-lab');
  assert.deepEqual(out.collections.experiments.map((e) => e.name), ['N/P scan', 'Stability'], 'the real lab, not the demo');
  assert.doesNotThrow(() => JSON.stringify(out));
});

test('a damaged key or a non-array value is skipped, not fatal', () => {
  browser();
  localStorage.setItem('lnp-lab.events', '[{"id": "ev1"'); // cut off mid-write
  localStorage.setItem('lnp-lab.inbox', '{"id": "not a list"}');
  localStorage.setItem('lnp-lab.imports', 'null');
  const out = new Store('lnp-lab').exportAll(); // the store reads them when it opens
  assert.deepEqual(Object.keys(out.collections).sort(), ['batches', 'experiments', 'settings']);
});

test('an export round-trips through import on a clean machine, and the preferences there are left alone', () => {
  const file = JSON.parse(JSON.stringify(browser().exportAll()));
  mem.clear();
  localStorage.setItem('lnp-lab.mode', 'simple');
  localStorage.setItem('lnp-lab.theme', 'light');
  const s = new Store('lnp-lab');
  const done = s.importAll(file);
  assert.deepEqual(done, { collections: 3, records: 4, skipped: [] });
  assert.deepEqual(s.all('experiments').map((e) => e.id), ['E1', 'E2']);
  assert.equal(s.get('batches', 'E1-F1').status, 'planned');
  assert.equal(s.get('settings', 'default').operator, 'AB');
  assert.equal(localStorage.getItem('lnp-lab.mode'), 'simple', 'a restore carries data, not the old browser\'s view');
  assert.equal(localStorage.getItem('lnp-lab.theme'), 'light');
  // and what came in exports again unchanged
  assert.deepEqual(s.exportAll().collections, file.collections);
});

test('import merges by id, or replaces the collections the file carries', () => {
  const s = browser();
  const file = { collections: { experiments: [{ id: 'E2', name: 'Stability, renamed' }, { id: 'E3', name: 'New' }] } };
  s.importAll(file);
  assert.deepEqual(s.all('experiments').map((e) => `${e.id} ${e.name}`), ['E1 N/P scan', 'E2 Stability, renamed', 'E3 New']);
  s.importAll(file, { merge: false });
  assert.deepEqual(s.all('experiments').map((e) => e.id), ['E2', 'E3']);
  assert.equal(s.count('batches'), 1, 'a collection the file does not carry is kept');
});

test('import is as forgiving as export: preferences, odd names and damaged rows are skipped', () => {
  const s = browser();
  const done = s.importAll({
    exportedAt: '2026-10-01T00:00:00Z',
    collections: {
      mode: [{ id: 'x' }], // an array under a preference's name must not overwrite the preference
      demo: [{ id: 'meta' }], // the demo namespace's marker, met here where `demo` is the demo switch
      theme: 'dark', schemaVersion: 2, 'notified.2026-10-01': [], '': [],
      experiments: [null, 7, 'E9', [1], { id: 'E9', name: 'From the file' }, { name: 'no id' }],
    },
  });
  assert.equal(localStorage.getItem('lnp-lab.mode'), 'advanced');
  assert.equal(localStorage.getItem('lnp-lab.demo'), '1', 'the demo switch is untouched');
  assert.equal(localStorage.getItem('lnp-lab.theme'), 'dark');
  assert.deepEqual(s.all('experiments').map((e) => e.id ?? e.name), ['E1', 'E2', 'E9', 'no id']);
  assert.deepEqual(done.skipped.sort(), ['', 'demo', 'mode', 'notified.2026-10-01'], 'the lists refused; non-lists were never data');
  assert.equal(done.records, 2);
  for (const bad of [null, undefined, {}, { collections: null }, { collections: 'x' }, { collections: [] }]) {
    assert.doesNotThrow(() => s.importAll(bad));
  }
});

test('in demo mode the export is the demo lab, and its marker collection comes with it', () => {
  browser();
  const demo = new Store('lnp-demo');
  demo.put('demo', { id: 'meta', version: 1 });
  localStorage.setItem('lnp-demo.schemaVersion', '2');
  const out = demo.exportAll();
  assert.deepEqual(Object.keys(out.collections).sort(), ['demo', 'experiments']);
  assert.equal(out.collections.experiments[0].name, 'Invented');
});

test('a restore repairs a collection a cut-off write damaged, and still leaves the preferences alone', () => {
  browser();
  localStorage.setItem('lnp-lab.events', '[{"id":"ev1"'); // the write that never finished
  const s = new Store('lnp-lab');
  const done = s.importAll({ collections: { events: [{ id: 'ev1', title: 'Make E1' }], mode: ['x'], demo: [{ id: 'd' }] } }, { merge: false });
  assert.deepEqual(s.all('events'), [{ id: 'ev1', title: 'Make E1' }]);
  assert.equal(localStorage.getItem('lnp-lab.mode'), 'advanced');
  assert.equal(localStorage.getItem('lnp-lab.demo'), '1');
  assert.deepEqual(done.skipped.sort(), ['demo', 'mode']);
});

test('records without an id survive a merge and are not added twice by importing the same file again', () => {
  browser();
  const s = new Store('lnp-lab');
  const file = { collections: { compositions: [{ id: null, synonym: 'a' }, { synonym: 'b' }, { id: 7, synonym: 'c' }] } };
  s.importAll(file); s.importAll(file);
  const names = s.all('compositions').map((r) => r.synonym).sort();
  assert.deepEqual(names, ['a', 'b', 'c']);
});

/* ---------------- persistence (usability cycle 4, S1) ---------------- */

/**
 * A stand-in for IndexedDB: whole collections as JSON under `<ns>.<col>`, every write recorded, and switches to
 * make a write fail (`fail`), hold it until released (`gate`), or make the database not open at all (`failLoad`).
 */
function fakeBackend({ kind = 'fake' } = {}) {
  const data = new Map();
  const b = {
    kind, data, writes: [], fail: null, gate: null, failLoad: null,
    async load(ns) {
      if (b.failLoad) throw b.failLoad;
      return Object.fromEntries([...data].filter(([k]) => k.startsWith(ns + '.')).map(([k, v]) => [k.slice(ns.length + 1), v]));
    },
    async write(ns, entries) {
      b.writes.push(entries.map(([col]) => col));
      if (b.gate) await b.gate;
      if (b.fail) throw b.fail;
      for (const [col, text] of entries) { if (text == null) data.delete(`${ns}.${col}`); else data.set(`${ns}.${col}`, text); }
    },
    async clear(ns) { for (const k of [...data.keys()]) if (k.startsWith(ns + '.')) data.delete(k); },
  };
  b.rows = (ns, col) => JSON.parse(data.get(`${ns}.${col}`) || '[]');
  return b;
}
// What Chrome rejects an IndexedDB write with when the site's share of the disk is used up.
const quotaError = () => Object.assign(new Error('The operation failed because the storage quota was exceeded'), { name: 'QuotaExceededError' });

async function opened(backend, ns = 'lnp-lab') { const s = new Store(ns, { backend }); await s.ready(); return s; }

/** One experiment with one formulation waiting for its size, stored. */
async function labWithAnOpenSlot(backend) {
  mem.clear();
  const s = await opened(backend);
  s.put('experiments', { id: 'E1', name: 'One', batchIds: ['E1-F1'], expected: [{ id: 'E1-F1_final_dls', batchId: 'E1-F1', test: 'dls', sampleName: 'E1-F1_final', status: 'open', measurementId: null }] });
  s.put('batches', { id: 'E1-F1', experimentId: 'E1', status: 'produced' });
  assert.equal((await s.flush()).ok, true);
  return s;
}
/** saveMeasurement's three writes (app/ui/measurements.js), as one transaction. */
function saveResult(s, id = 'm1') {
  return s.transaction(() => {
    s.put('measurements', { id, batchId: 'E1-F1', experimentId: 'E1', test: 'dls', sampleName: 'E1-F1_final', values: { zave_nm: 81.2, pdi: 0.09 } });
    const e = s.get('experiments', 'E1');
    e.expected[0].status = 'done'; e.expected[0].measurementId = id;
    s.put('experiments', e);
    const b = s.get('batches', 'E1-F1'); b.status = 'measured'; s.put('batches', b);
    return { id };
  }, { what: 'the result for E1-F1_final' });
}

test('records round-trip through the backend: written by one store, read by the next one opened on it', async () => {
  mem.clear();
  const backend = fakeBackend();
  const a = await opened(backend);
  const saved = a.put('experiments', { id: 'E1', name: 'N/P scan', nested: { levels: [3, 6, 9] } });
  assert.equal(saved.name, 'N/P scan');
  assert.ok(saved.createdAt && saved.updatedAt, 'stamped as before');
  assert.equal(a.get('experiments', 'E1').name, 'N/P scan', 'readable at once, before anything is written');
  assert.deepEqual(await a.flush(), { ok: true, error: null });
  assert.deepEqual(backend.rows('lnp-lab', 'experiments').map((e) => e.id), ['E1']);
  assert.equal(mem.size, 0, 'nothing went to localStorage');
  const b = await opened(backend);
  assert.deepEqual(b.get('experiments', 'E1').nested, { levels: [3, 6, 9] });
  assert.equal(b.count('experiments'), 1);
  // What a caller gets is a copy: changing it changes nothing stored.
  b.get('experiments', 'E1').name = 'changed by accident';
  b.all('experiments')[0].nested.levels.push(12);
  assert.equal(b.get('experiments', 'E1').name, 'N/P scan');
  assert.deepEqual(b.get('experiments', 'E1').nested.levels, [3, 6, 9]);
  assert.equal(new Store('lnp-demo', { backend }).count('experiments'), 0, 'another namespace is another lab');
});

test('writes made together go out together: one write per moment, each collection once in it', async () => {
  mem.clear();
  const backend = fakeBackend();
  const s = await opened(backend);
  for (let i = 1; i <= 20; i++) s.put('batches', { id: `E1-F${i}`, experimentId: 'E1' });
  s.put('experiments', { id: 'E1', batchIds: [] });
  s.remove('batches', 'E1-F20');
  assert.equal(backend.writes.length, 0, 'nothing written while the click is still running');
  await s.flush();
  assert.equal(backend.writes.length, 1, '22 changes, one write');
  assert.deepEqual(backend.writes[0].sort(), ['batches', 'experiments']);
  assert.equal(backend.rows('lnp-lab', 'batches').length, 19);
  await s.flush();
  assert.equal(backend.writes.length, 1, 'nothing changed, nothing written');
});

test('collections an earlier version kept in localStorage are moved once, and the preferences stay', async () => {
  mem.clear();
  for (const [k, v] of Object.entries(PREFS)) localStorage.setItem(k, v);
  localStorage.setItem('lnp-lab.ui.formulations', '{"filter":"open"}');
  localStorage.setItem('lnp-lab.hidden.orphans', 'E900-F1');
  localStorage.setItem('lnp-lab.experiments', JSON.stringify([{ id: 'E1', name: 'Old' }, { id: 'E2', name: 'Older' }]));
  localStorage.setItem('lnp-lab.measurements', JSON.stringify([{ id: 'm1', batchId: 'E1-F1' }]));
  localStorage.setItem('lnp-lab.events', '[{"id":"ev1"'); // damaged: nothing in it can be moved, so it is left alone
  localStorage.setItem('lnp-demo.experiments', JSON.stringify([{ id: 'E1', name: 'Invented' }]));
  const backend = fakeBackend({ kind: 'indexeddb' });
  const s = await opened(backend);
  assert.deepEqual(s.all('experiments').map((e) => e.name), ['Old', 'Older']);
  assert.deepEqual(backend.rows('lnp-lab', 'experiments').map((e) => e.id), ['E1', 'E2'], 'stored in the backend');
  assert.equal(backend.rows('lnp-lab', 'measurements').length, 1);
  assert.equal(localStorage.getItem('lnp-lab.experiments'), null, 'removed from localStorage once stored');
  assert.equal(localStorage.getItem('lnp-lab.measurements'), null);
  for (const [k, v] of Object.entries(PREFS)) assert.equal(localStorage.getItem(k), v, `${k} stays a preference`);
  assert.equal(localStorage.getItem('lnp-lab.ui.formulations'), '{"filter":"open"}');
  assert.equal(localStorage.getItem('lnp-lab.hidden.orphans'), 'E900-F1');
  assert.equal(localStorage.getItem('lnp-lab.events'), '[{"id":"ev1"');
  assert.ok(localStorage.getItem('lnp-demo.experiments'), 'the demo lab moves when the demo is opened, not before');
  assert.equal(localStorage.getItem('lnp-lab.storage.idb'), '1', 'remembered: the records now live in the database');
  assert.deepEqual(Object.keys(s.exportAll().collections).sort(), ['experiments', 'measurements']);
  // The next start finds nothing left to move and the same records.
  const writes = backend.writes.length;
  const again = await opened(backend);
  assert.equal(backend.writes.length, writes);
  assert.deepEqual(again.all('experiments').map((e) => e.name), ['Old', 'Older']);
});

test('a move that cannot be stored loses nothing: localStorage keeps the records until the backend has them', async () => {
  mem.clear();
  localStorage.setItem('lnp-lab.experiments', JSON.stringify([{ id: 'E1', name: 'Old' }]));
  const backend = fakeBackend();
  backend.fail = quotaError();
  const s = await opened(backend);
  assert.equal(s.get('experiments', 'E1').name, 'Old', 'the records are there to work with');
  assert.ok(localStorage.getItem('lnp-lab.experiments'), 'and still in localStorage');
  assert.equal(s.problem?.kind, 'quota');
  // A later start, with room again, finishes the move. Rows already moved are not doubled.
  backend.data.set('lnp-lab.experiments', JSON.stringify([{ id: 'E1', name: 'Old' }]));
  backend.fail = null;
  const t = await opened(backend);
  assert.deepEqual(t.all('experiments').map((e) => e.id), ['E1']);
  assert.equal(localStorage.getItem('lnp-lab.experiments'), null);
});

test('a transaction that cannot be stored is undone in memory, whole, and said plainly', async () => {
  const backend = fakeBackend();
  const s = await labWithAnOpenSlot(backend);
  const notes = [];
  s.onProblem = (p) => notes.push(p);
  backend.fail = quotaError();
  const rec = saveResult(s);
  assert.equal(rec.id, 'm1', 'the caller gets its value at once, as with put()');
  assert.equal(s.count('measurements'), 1, 'and sees the change until the write has failed');
  const done = await s.flush();
  assert.equal(done.ok, false);
  assert.equal(done.error.name, 'QuotaExceededError');
  // Nothing half-written, in memory or in the backend.
  assert.equal(s.count('measurements'), 0);
  assert.equal(s.get('experiments', 'E1').expected[0].status, 'open');
  assert.equal(s.get('batches', 'E1-F1').status, 'produced');
  assert.deepEqual(backend.rows('lnp-lab', 'measurements'), []);
  assert.equal(backend.rows('lnp-lab', 'experiments')[0].expected[0].status, 'open');
  // Said once, in words, with what was undone.
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'quota');
  assert.equal(notes[0].undone, true);
  assert.match(notes[0].message, /^Not saved: this browser's storage is full\. The result for E1-F1_final was undone, so nothing is half-saved\. Export a backup under Settings, then free space/);
  assert.doesNotMatch(notes[0].message, /Uncaught|QuotaExceededError|setItem/);
  // Room again: the next write goes through and the note is withdrawn.
  backend.fail = null;
  saveResult(s, 'm2');
  assert.equal((await s.flush()).ok, true);
  assert.equal(notes.at(-1), null, 'the note is taken down');
  assert.equal(s.problem, null);
  assert.deepEqual(backend.rows('lnp-lab', 'measurements').map((m) => m.id), ['m2']);
  assert.equal(backend.rows('lnp-lab', 'batches')[0].status, 'measured');
});

test('a transaction whose function throws is undone at once and nothing is written', async () => {
  const backend = fakeBackend();
  const s = await labWithAnOpenSlot(backend);
  const writes = backend.writes.length;
  assert.throws(() => s.transaction(() => { s.put('batches', { id: 'E1-F2', experimentId: 'E1' }); s.put('experiments', { id: 'E2' }); throw new Error('halfway'); }), /halfway/);
  assert.equal(s.count('batches'), 1);
  assert.equal(s.get('experiments', 'E2'), null);
  await s.flush();
  assert.equal(backend.writes.length, writes, 'nothing to write: memory is exactly as it was');
});

test('undoing a transaction keeps a change made after it in the same collection', async () => {
  const backend = fakeBackend();
  const s = await labWithAnOpenSlot(backend);
  let release; backend.gate = new Promise((r) => { release = r; });
  backend.fail = quotaError();
  saveResult(s, 'm1');
  await new Promise((r) => setTimeout(r, 0)); // the write is out, and held
  s.put('measurements', { id: 'later', batchId: 'E1-F1', test: 'ee', values: { ee_pct: 93 } });
  release(); backend.gate = null;
  await s.flush();
  assert.deepEqual(s.all('measurements').map((m) => m.id), ['later'], 'the transaction\'s result went, the later one stayed');
  assert.equal(s.get('experiments', 'E1').expected[0].status, 'open');
  assert.equal(s.problem.kind, 'quota');
  assert.equal(s.unsaved(), true, 'the later one is still waiting to be stored');
});

test('a plain write that cannot be stored stays in memory, is said, and goes out with the next write', async () => {
  const backend = fakeBackend();
  const s = await labWithAnOpenSlot(backend);
  backend.fail = quotaError();
  s.put('stocks', { id: 'Stock-001' });
  await s.flush();
  assert.equal(s.count('stocks'), 1, 'kept in this window');
  assert.match(s.problem.message, /^Not saved: this browser's storage is full\. Your latest changes are only in this window for now\. Export a backup under Settings/);
  assert.deepEqual(s.exportAll().collections.stocks.map((x) => x.id), ['Stock-001'], 'and in a backup exported now');
  backend.fail = null;
  s.put('buffers', { id: 'Buffer-001' });
  await s.flush();
  assert.deepEqual(backend.rows('lnp-lab', 'stocks').map((x) => x.id), ['Stock-001']);
  assert.equal(s.problem, null);
});

test('the failure messages are plain sentences, never the exception', () => {
  assert.match(describeFailure({ kind: 'quota' }), /^Not saved: this browser's storage is full\. Your latest changes are only in this window for now\. Export a backup under Settings, then free space/);
  assert.match(describeFailure({ kind: 'unavailable', undone: true, what: ['the new Experiment 3'] }), /^Not saved: this browser is not letting LNP Lab store anything \(a private window[^)]*\)\. The new Experiment 3 was undone, so nothing is half-saved\. Export a backup under Settings before you close this window\.$/);
  assert.match(describeFailure({ kind: 'other', reason: 'Connection to Indexed Database server lost.' }), /refused to store the change \(Connection to Indexed Database server lost\)\./);
  assert.match(describeFailure({ kind: 'unopened' }), /could not be opened[\s\S]*Nothing is lost[\s\S]*Reload the page/);
  assert.match(describeFailure({ kind: 'quota', undone: true, what: ['a', 'b', 'c'] }), /A and b and 1 more were undone/);
  // What the global error handler turns into the note instead of "Error: Uncaught QuotaExceededError: …"
  const ls = Object.assign(new Error("Failed to execute 'setItem' on 'Storage': Setting the value of 'lnp-lab.batches' exceeded the quota."), { name: 'QuotaExceededError' });
  assert.equal(storageProblem(ls).kind, 'quota');
  assert.doesNotMatch(storageProblem(ls).message, /setItem|Uncaught/);
  assert.equal(storageProblem(new TypeError('x is undefined')), null, 'a programming error stays one');
  assert.equal(failureKind({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }), 'quota', 'Firefox');
  assert.equal(failureKind({ code: 22, name: 'Error' }), 'quota', 'old WebKit');
});

test('IndexedDB that will not open: localStorage as before, or, once the records live there, nothing accepted', async () => {
  mem.clear();
  localStorage.setItem('lnp-lab.experiments', JSON.stringify([{ id: 'E1', name: 'In localStorage' }]));
  const backend = fakeBackend({ kind: 'indexeddb' });
  backend.failLoad = Object.assign(new Error('The user denied permission to access the database.'), { name: 'UnknownError' });
  const s = await opened(backend);
  assert.equal(s.engine, 'localStorage', 'a browser without a working database works as it always did');
  assert.equal(s.get('experiments', 'E1').name, 'In localStorage');
  s.put('experiments', { id: 'E2', name: 'Written through' });
  assert.equal(JSON.parse(localStorage.getItem('lnp-lab.experiments')).length, 2, 'straight away, as before');
  assert.equal(s.problem, null, 'and nothing to say until something fails');
  // Records already moved to the database: an empty lab from localStorage would invite a second Experiment 1.
  mem.clear();
  localStorage.setItem('lnp-lab.storage.idb', '1');
  const notes = [];
  const t = new Store('lnp-lab', { backend }); t.onProblem = (p) => notes.push(p);
  await t.ready();
  assert.equal(t.engine, 'none');
  assert.equal(notes[0]?.kind, 'unopened');
  t.put('experiments', { id: 'E1', name: 'Would collide' });
  await t.flush();
  assert.equal(mem.get('lnp-lab.experiments'), undefined, 'not written anywhere');
  assert.equal(t.problem.kind, 'unopened', 'the note still says to reload');
});

test('localStorage fallback: a transaction that does not fit is undone in memory and in localStorage', () => {
  mem.clear();
  const s = new Store('lnp-lab'); // node: no IndexedDB, so localStorage, written straight away
  assert.equal(s.engine, 'localStorage');
  s.put('experiments', { id: 'E1', expected: [] });
  s.put('batches', { id: 'E1-F1', status: 'produced' });
  const before = localStorage.getItem('lnp-lab.batches');
  const realSet = localStorage.setItem;
  let notes = 0; s.onProblem = (p) => { if (p) notes++; };
  // A full localStorage: the second key of the transaction does not fit.
  localStorage.setItem = (k, v) => { if (k === 'lnp-lab.measurements') throw Object.assign(new Error('exceeded the quota'), { name: 'QuotaExceededError' }); realSet(k, v); };
  try {
    s.transaction(() => {
      s.put('batches', { id: 'E1-F1', status: 'measured' });
      s.put('measurements', { id: 'm1', batchId: 'E1-F1' });
    }, { what: 'the result for E1-F1_final' });
  } finally { localStorage.setItem = realSet; }
  assert.equal(localStorage.getItem('lnp-lab.batches'), before, 'the key already written got its old value back');
  assert.equal(localStorage.getItem('lnp-lab.measurements'), null);
  assert.equal(s.get('batches', 'E1-F1').status, 'produced');
  assert.equal(s.count('measurements'), 0);
  assert.equal(notes, 1);
  assert.match(s.problem.message, /^Not saved: this browser's storage is full\. The result for E1-F1_final was undone/);
});

test('the schema rename is recorded as done only once the renamed records are stored', async () => {
  const { migrate, SCHEMA_VERSION } = await import('../app/migrate.js');
  const old = (backend) => { backend.data.set('lnp-lab.experiments', JSON.stringify([{ id: 'S-001', name: 'old', batchIds: ['LNP_01'], expected: [] }])); backend.data.set('lnp-lab.batches', JSON.stringify([{ id: 'LNP_01', experimentId: 'S-001' }])); };
  mem.clear();
  const backend = fakeBackend(); old(backend);
  const s = await opened(backend);
  backend.fail = quotaError();
  migrate(s);
  assert.equal(s.get('experiments', 'E1')?.name, 'old', 'renamed in memory at once');
  await s.flush();
  assert.equal(s.get('experiments', 'S-001')?.name, 'old', 'undone when it could not be stored');
  assert.equal(localStorage.getItem('lnp-lab.schemaVersion'), null, 'and not marked as done, so the next start tries again');
  backend.fail = null;
  const t = await opened(backend);
  migrate(t);
  await t.flush();
  assert.equal(localStorage.getItem('lnp-lab.schemaVersion'), String(SCHEMA_VERSION));
  assert.deepEqual(backend.rows('lnp-lab', 'batches').map((b) => b.id), ['E1-F1']);
});

test('clear() empties this namespace in the backend and in localStorage, and leaves the other one', async () => {
  mem.clear();
  const backend = fakeBackend();
  const demo = await opened(backend, 'lnp-demo');
  demo.put('experiments', { id: 'E1', name: 'Invented' });
  localStorage.setItem('lnp-demo.schemaVersion', '2');
  localStorage.setItem('lnp-lab.mode', 'advanced');
  const real = await opened(backend);
  real.put('experiments', { id: 'E1', name: 'Mine' });
  await demo.flush(); await real.flush();
  assert.deepEqual(await demo.clear(), { ok: true, error: null });
  assert.equal(demo.count('experiments'), 0);
  assert.equal(backend.data.has('lnp-demo.experiments'), false);
  assert.equal(localStorage.getItem('lnp-demo.schemaVersion'), null);
  assert.equal(backend.rows('lnp-lab', 'experiments')[0].name, 'Mine');
  assert.equal(localStorage.getItem('lnp-lab.mode'), 'advanced');
  assert.equal((await opened(backend, 'lnp-demo')).count('experiments'), 0, 'gone after a restart too');
});

test('peek and poke reach another namespace without opening it (the test door)', async () => {
  mem.clear();
  const backend = fakeBackend();
  const demo = await opened(backend, 'lnp-demo');
  await demo.poke('lnp-lab', 'experiments', [{ id: 'E1', name: 'Mine' }]);
  assert.deepEqual((await demo.peek('lnp-lab', 'experiments')).map((e) => e.name), ['Mine']);
  assert.equal(demo.count('experiments'), 0, 'the open namespace is untouched');
  await demo.poke('lnp-demo', 'experiments', [{ id: 'E1', name: 'Invented' }]);
  assert.equal(demo.get('experiments', 'E1').name, 'Invented', 'the open one is written through the store');
  assert.equal(backend.rows('lnp-demo', 'experiments')[0].name, 'Invented', 'and stored when poke resolves');
  localStorage.setItem('lnp-old.batches', '[{"id":"x"}]');
  assert.deepEqual(await demo.peek('lnp-old', 'batches'), [{ id: 'x' }], 'a namespace not yet moved is read where it is');
});

test('a screen that keeps its input hears that its write was undone, and nothing is left to "try again"', async () => {
  const backend = fakeBackend();
  const s = await labWithAnOpenSlot(backend);
  const notes = [];
  s.onProblem = (p) => notes.push(p);
  backend.fail = quotaError();
  let undone = false, saved = false;
  s.transaction(() => {
    s.put('experiments', { id: 'E2', name: 'Two', batchIds: ['E2-F1'], expected: [] });
    s.put('batches', { id: 'E2-F1', experimentId: 'E2', status: 'planned' });
  }, { what: 'the new Experiment 2', again: 'Create experiment', onUndone: () => { undone = true; return true; }, onSaved: () => { saved = true; } });
  await s.flush();
  assert.equal(saved, false);
  assert.equal(undone, true, 'told, and it said the screen is still showing');
  assert.equal(notes[0].kept, true, 'the screen kept its input, so it is not drawn again');
  assert.match(notes[0].message, /^Not saved: this browser's storage is full\. The new Experiment 2 was undone, so nothing is half-saved\. Everything on this screen is still here\. Export a backup under Settings, then free space \(empty the trash there, or free disk space\) and press “Create experiment” again\.$/);
  assert.equal(s.unsaved(), false, 'memory is as stored: there is nothing to write again');
  assert.equal(s.get('experiments', 'E2'), null);
  // with room again, doing it again stores it and the note goes
  backend.fail = null;
  s.transaction(() => { s.put('experiments', { id: 'E2', name: 'Two', batchIds: [], expected: [] }); }, { onSaved: () => { saved = true; } });
  assert.equal((await s.flush()).ok, true);
  assert.equal(saved, true);
  assert.equal(notes.at(-1), null);
});

test('an undone transaction leaves an earlier change that was not stored waiting to be written', async () => {
  const backend = fakeBackend();
  const s = await labWithAnOpenSlot(backend);
  backend.fail = quotaError();
  s.put('stocks', { id: 'Stock-001' }); // a plain write: kept in memory when it cannot be stored
  saveResult(s);
  await s.flush();
  assert.equal(s.problem.kept, false, 'no screen said it keeps its input: the screen is drawn again');
  assert.equal(s.count('stocks'), 1);
  assert.equal(s.unsaved(), true, 'the stock is still to be written, so "Try again" has something to do');
  backend.fail = null;
  assert.equal((await s.flush()).ok, true);
  assert.deepEqual(backend.rows('lnp-lab', 'stocks').map((x) => x.id), ['Stock-001']);
});
