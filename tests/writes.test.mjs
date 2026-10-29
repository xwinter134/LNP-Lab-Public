// Writes that fail or take long (usability cycle 6, W3–W5): what an undone transaction takes with it when
// something has changed the same records while its write was still out, what a create's number does when it is
// undone, and when the screen that waited for the write is kept as it is. The backend here holds each write until
// the test says whether it is stored or refused, as a slow or full disk would.
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  get length() { return mem.size; },
  key: (i) => [...mem.keys()][i] ?? null,
};
const { Store } = await import('../app/store.js');
const { raiseCounter, counterTop, usedIds, nextExperimentId } = await import('../app/schema.js');
console.warn = () => {}; // the store says on the console what it could not store; here that is the point

const quotaError = () => Object.assign(new Error('The operation failed because the storage quota was exceeded'), { name: 'QuotaExceededError' });
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Every write waits in `queue` until settle('ok') or settle('fail') lets the oldest one land. */
function heldBackend() {
  const data = new Map(), queue = [];
  const b = {
    kind: 'held', data, queue,
    load: async (ns) => Object.fromEntries([...data].filter(([k]) => k.startsWith(ns + '.')).map(([k, v]) => [k.slice(ns.length + 1), v])),
    write: (ns, entries) => new Promise((resolve, reject) => queue.push({
      ok: () => { for (const [col, text] of entries) { if (text == null) data.delete(`${ns}.${col}`); else data.set(`${ns}.${col}`, text); } resolve(); },
      fail: () => reject(quotaError()),
    })),
    clear: async () => {},
  };
  b.rows = (col) => JSON.parse(data.get(`lnp-lab.${col}`) || '[]');
  b.settle = async (how) => { await tick(); const w = queue.shift(); assert.ok(w, 'a write is out'); w[how](); await tick(); await tick(); };
  return b;
}

/** Experiment E1 with a formulation waiting for its size, and E3 with one of its own, all stored. */
async function lab() {
  mem.clear();
  const b = heldBackend();
  const s = new Store('lnp-lab', { backend: b });
  await s.ready();
  for (const n of [1, 3]) {
    s.put('experiments', { id: `E${n}`, batchIds: [`E${n}-F1`], expected: [{ id: 'A', status: 'open', measurementId: null }, { id: 'B', status: 'open', measurementId: null }] });
    s.put('batches', { id: `E${n}-F1`, experimentId: `E${n}`, status: 'produced', notes: '' });
  }
  raiseCounter(s, 'experiment', 'E3');
  await b.settle('ok');
  return { s, b };
}
/** saveMeasurement's writes (app/ui/measurements.js): the result, the slot it closes, the formulation's status. */
const saveResult = (s, exp, slot, id, more = {}) => s.transaction(() => {
  s.put('measurements', { id, batchId: `${exp}-F1`, slotId: slot });
  const e = s.get('experiments', exp); const x = e.expected.find((y) => y.id === slot); x.status = 'done'; x.measurementId = id; s.put('experiments', e);
  const f = s.get('batches', `${exp}-F1`); f.status = 'measured'; s.put('batches', f);
}, { what: `the result ${id}`, ...more });
/** The wizard's create (app/ui/experiments.js): formulations, experiment and the series' counter, one write. */
const createExperiment = (s, more = {}) => {
  const id = nextExperimentId(usedIds(s, 'experiment'));
  s.transaction(() => {
    s.put('batches', { id: `${id}-F1`, experimentId: id, status: 'planned', notes: '' });
    s.put('experiments', { id, batchIds: [`${id}-F1`], expected: [] });
    raiseCounter(s, 'experiment', id);
  }, { what: `the new ${id}`, ...more });
  return id;
};

test('an undone create takes with it the formulation set to "produced" while it was being stored (W3)', async () => {
  const { s, b } = await lab();
  const id = createExperiment(s);
  await tick(); // its write is out
  const f = s.get('batches', `${id}-F1`); f.status = 'produced'; s.put('batches', f); // the record's auto-save
  await b.settle('fail');
  assert.equal(s.get('experiments', id), null);
  assert.equal(s.get('batches', `${id}-F1`), null, 'not left behind as a formulation of an experiment that does not exist');
  await b.settle('ok'); // the auto-save's own write
  assert.deepEqual(b.rows('batches').map((x) => x.id), ['E1-F1', 'E3-F1']);
  assert.deepEqual(b.rows('experiments').map((x) => x.id), ['E1', 'E3']);
});

test('a record the undone transaction changed gets back what it changed, and keeps a later edit to the rest (W3)', async () => {
  const { s, b } = await lab();
  saveResult(s, 'E1', 'A', 'm1');
  await tick();
  const f = s.get('batches', 'E1-F1'); f.notes = 'typed at the bench'; s.put('batches', f); // built on "measured"
  await b.settle('fail');
  assert.equal(s.get('batches', 'E1-F1').status, 'produced', 'not "measured" without a result');
  assert.equal(s.get('batches', 'E1-F1').notes, 'typed at the bench');
  await b.settle('ok');
  const stored = b.rows('batches').find((x) => x.id === 'E1-F1');
  assert.deepEqual([stored.status, stored.notes], ['produced', 'typed at the bench']);
  assert.deepEqual(b.rows('measurements'), []);
});

test('a transaction built on an undone one is undone with it, and the note names both (W3)', async () => {
  const { s, b } = await lab();
  const notes = [];
  s.onProblem = (p) => notes.push(p);
  let secondSaved = false;
  saveResult(s, 'E1', 'A', 'm1');
  await tick(); // the first result's write is out
  saveResult(s, 'E1', 'B', 'm2', { onSaved: () => { secondSaved = true; } }); // the same experiment's other slot
  await b.settle('fail');
  assert.deepEqual(s.get('experiments', 'E1').expected.map((x) => [x.status, x.measurementId]), [['open', null], ['open', null]],
    'neither slot is closed by a result that is not there');
  assert.deepEqual(s.all('measurements'), []);
  assert.deepEqual(notes.at(-1).what, ['the result m1', 'the result m2']);
  assert.equal(s.unsaved(), false, 'nothing is left for "Try again" to store');
  assert.equal(b.queue.length, 0);
  await tick(); await tick();
  assert.equal(secondSaved, false);
  assert.ok(s.problem, 'and the note stays: nothing has been stored since');
  // Twice undone, the first transaction's own records must not come back either.
  saveResult(s, 'E3', 'A', 'm3');
  await b.settle('ok');
  assert.deepEqual(b.rows('measurements').map((m) => m.id), ['m3']);
  assert.deepEqual(b.rows('experiments').find((e) => e.id === 'E1').expected.map((x) => x.status), ['open', 'open']);
  assert.equal(s.problem, null);
});

test('a transaction on other records is not undone with an earlier one, and is stored (W3)', async () => {
  const { s, b } = await lab();
  let saved = false;
  saveResult(s, 'E1', 'A', 'm1');
  await tick();
  saveResult(s, 'E3', 'A', 'm2', { onSaved: () => { saved = true; } });
  await b.settle('fail');
  assert.deepEqual(s.all('measurements').map((m) => m.id), ['m2']);
  await b.settle('ok');
  assert.equal(saved, true);
  assert.deepEqual(b.rows('measurements').map((m) => m.id), ['m2']);
  assert.deepEqual(b.rows('experiments').map((e) => e.expected[0].status), ['open', 'done']);
});

test('an undone create gives its number out again, and the browser\'s mark rises only once one is stored (W4)', async () => {
  const { s, b } = await lab();
  assert.equal(mem.get('lnp-lab.counter.experiment'), '3');
  assert.equal(createExperiment(s), 'E4');
  await b.settle('fail');
  assert.equal(counterTop(s, 'experiment'), 3);
  assert.equal(mem.get('lnp-lab.counter.experiment'), '3', 'the form that showed E4 still gets E4');
  assert.equal(createExperiment(s), 'E4');
  await tick();
  assert.equal(createExperiment(s), 'E5', 'while E4 is being stored its number is taken');
  await b.settle('ok');
  assert.equal(mem.get('lnp-lab.counter.experiment'), '4');
  await b.settle('ok');
  assert.equal(mem.get('lnp-lab.counter.experiment'), '5');
  assert.deepEqual(b.rows('experiments').map((e) => e.id), ['E1', 'E3', 'E4', 'E5']);
  // A create numbered past one that is then undone goes with it, so no number is skipped.
  assert.equal(createExperiment(s), 'E6');
  await tick();
  assert.equal(createExperiment(s), 'E7');
  await b.settle('fail');
  assert.equal(b.queue.length, 0);
  assert.equal(nextExperimentId(usedIds(s, 'experiment')), 'E6');
  assert.equal(mem.get('lnp-lab.counter.experiment'), '5');
});

test('the screen that waited is kept as it is only while it is still showing (W5)', async () => {
  const { s, b } = await lab();
  const notes = [];
  s.onProblem = (p) => notes.push(p);
  createExperiment(s, { again: 'Create experiment', onUndone: () => true });
  await b.settle('fail');
  assert.equal(notes.at(-1).kept, true);
  assert.match(notes.at(-1).message, /Everything on this screen is still here\. .* press “Create experiment” again\.$/);
  createExperiment(s, { again: 'Create experiment', onUndone: () => false }); // the user has moved to another screen
  await b.settle('fail');
  assert.equal(notes.at(-1).kept, false, 'drawn again, so the list the user moved to stops showing it');
  assert.doesNotMatch(notes.at(-1).message, /this screen|Create experiment/);
  // Joined into an outer transaction, it is kept only if every screen that waited still shows.
  s.transaction(() => { createExperiment(s, { onUndone: () => false }); }, { onUndone: () => true });
  await b.settle('fail');
  assert.equal(notes.at(-1).kept, false);
});
