// The lookups a screen builds once per render (app/calc/indexes.js): grouping, the latest result per
// formulation, test and stage, formulations by experiment, and the page of a long list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newestFirst, groupBy, byId, measurementIndex, batchIndex, batchResults, pageOf } from '../app/calc/indexes.js';

const m = (id, batchId, test, date, extra = {}) => ({ id, batchId, test, date, stage: 'final', values: {}, ...extra });

test('groupBy keeps store order inside a group and leaves out records with no key', () => {
  const rows = [{ k: 'a', n: 1 }, { k: 'b', n: 2 }, { k: 'a', n: 3 }, { k: null, n: 4 }, { k: '', n: 5 }, null, { n: 6 }];
  const g = groupBy(rows, (r) => r.k);
  assert.deepEqual([...g.keys()], ['a', 'b']);
  assert.deepEqual(g.get('a').map((r) => r.n), [1, 3]);
  assert.equal(g.get('c'), undefined);
  assert.equal(groupBy([], (r) => r.k).size, 0);
});

test('byId: the first record of an id wins, as the store finds it', () => {
  const ids = byId([{ id: 'x', v: 1 }, { id: 'y', v: 2 }, { id: 'x', v: 3 }, { v: 4 }, null]);
  assert.equal(ids.get('x').v, 1);
  assert.equal(ids.size, 2);
});

test('newest first: by measurement date, then by when it was stored', () => {
  const a = { date: '2026-10-01', createdAt: '2026-10-01T09:00:00Z' };
  const b = { date: '2026-10-02', createdAt: '2026-10-01T08:00:00Z' };
  const c = { date: '2026-10-02', createdAt: '2026-10-02T08:00:00Z' };
  assert.deepEqual([a, b, c].sort(newestFirst), [c, b, a]);
  assert.equal(newestFirst({}, {}), 0, 'records with neither date compare equal');
});

test('measurements by formulation, by test and by both, in store order', () => {
  const ms = [
    m('1', 'E1-F1', 'dls', '2026-10-01'), m('2', 'E1-F2', 'dls', '2026-10-01'), m('3', 'E1-F1', 'ee', '2026-10-02'),
    m('4', 'E1-F1', 'dls', '2026-10-03'), { id: 'inbox', test: 'dls', date: '2026-10-04' }, null,
  ];
  const idx = measurementIndex(ms);
  assert.deepEqual(idx.forBatch('E1-F1').map((x) => x.id), ['1', '3', '4']);
  assert.deepEqual(idx.forTest('dls').map((x) => x.id), ['1', '2', '4', 'inbox'], 'a result with no formulation still has a test');
  assert.deepEqual(idx.forBatchTest('E1-F1', 'dls').map((x) => x.id), ['1', '4']);
  assert.deepEqual(idx.forBatch('E9-F1'), [], 'a formulation with nothing measured has an empty list, not undefined');
  assert.deepEqual(idx.forBatchTest('E1-F2', 'ee'), []);
  assert.deepEqual(idx.batchIds().sort(), ['E1-F1', 'E1-F2']);
});

test('latest per formulation and test, and per stage when one is asked for', () => {
  const ms = [
    m('old', 'E1-F1', 'dls', '2026-10-01'),
    m('ipc', 'E1-F1', 'dls', '2026-10-05', { stage: 'IPC4' }),
    m('new', 'E1-F1', 'dls', '2026-10-03'),
    m('ee', 'E1-F1', 'ee', '2026-10-02'),
    m('only-ipc', 'E1-F2', 'dls', '2026-10-02', { stage: 'IPC4' }),
  ];
  const idx = measurementIndex(ms);
  assert.equal(idx.latest('E1-F1', 'dls').id, 'ipc', 'any stage: the newest of all');
  assert.equal(idx.latest('E1-F1', 'dls', 'final').id, 'new', 'the final product only');
  assert.equal(idx.latest('E1-F1', 'dls', 'IPC4').id, 'ipc');
  assert.equal(idx.latest('E1-F1', 'zeta'), null);
  assert.equal(idx.latest('E1-F2', 'dls', 'final'), null);
  assert.equal(idx.latest('nobody', 'dls'), null);
  // the row rule: the final product's size, any stage when the final one was not measured
  assert.equal(batchResults(idx, 'E1-F1').dls.id, 'new');
  assert.equal(batchResults(idx, 'E1-F2').dls.id, 'only-ipc');
  assert.equal(batchResults(idx, 'E1-F1').ee.id, 'ee');
  assert.equal(batchResults(idx, 'E1-F1').zeta, null);
});

test('a re-import on the same day wins over the first import; a full tie keeps the first stored', () => {
  const first = m('first', 'E2-F1', 'dls', '2026-10-10', { createdAt: '2026-10-10T09:00:00Z' });
  const again = m('again', 'E2-F1', 'dls', '2026-10-10', { createdAt: '2026-10-10T11:00:00Z' });
  assert.equal(measurementIndex([first, again]).latest('E2-F1', 'dls').id, 'again');
  assert.equal(measurementIndex([again, first]).latest('E2-F1', 'dls').id, 'again', 'whatever order they were stored in');
  const twin = m('twin', 'E2-F1', 'dls', '2026-10-10', { createdAt: '2026-10-10T09:00:00Z' });
  assert.equal(measurementIndex([first, twin]).latest('E2-F1', 'dls').id, 'first', 'as the first of a stable sort');
  // the same answer as sorting the formulation's records, which is what each screen used to do per row
  const ms = Array.from({ length: 60 }, (_, i) => m(`m${i}`, `E3-F${i % 4}`, i % 3 ? 'dls' : 'ee', `2026-10-${String(1 + (i * 7) % 28).padStart(2, '0')}`, { createdAt: `2026-11-01T${String(i % 24).padStart(2, '0')}:00:00Z` }));
  const idx = measurementIndex(ms);
  for (const b of ['E3-F0', 'E3-F1', 'E3-F2', 'E3-F3']) for (const t of ['dls', 'ee']) {
    const sorted = ms.filter((x) => x.batchId === b && x.test === t).sort(newestFirst)[0] || null;
    assert.equal(idx.latest(b, t), sorted, `${b} ${t}`);
  }
});

test('formulations by id, by the experiment list, and by the experiment they name', () => {
  const batches = [
    { id: 'E1-F2', experimentId: 'E1' }, { id: 'E1-F1', experimentId: 'E1' }, { id: 'E2-F1', experimentId: 'E2' },
    { id: 'X-1', experimentId: null },
  ];
  const idx = batchIndex(batches);
  assert.equal(idx.get('E2-F1').experimentId, 'E2');
  assert.equal(idx.get('nope'), null);
  assert.ok(idx.has('X-1'));
  assert.deepEqual(idx.of({ id: 'E1', batchIds: ['E1-F1', 'E1-F2', 'E1-F3'] }).map((b) => b.id), ['E1-F1', 'E1-F2'],
    'in the experiment\'s own order, an id no longer on record left out');
  assert.deepEqual(idx.of({ id: 'E3' }), [], 'an experiment without a list has nothing in it');
  assert.deepEqual(idx.forExperiment('E1').map((b) => b.id), ['E1-F2', 'E1-F1'], 'every formulation naming it, in store order');
  assert.deepEqual(idx.forExperiment('E9'), []);
});

test('a page of a long list says how many are left', () => {
  const rows = Array.from({ length: 450 }, (_, i) => i);
  assert.deepEqual(pageOf(rows, 200).shown, rows.slice(0, 200));
  assert.equal(pageOf(rows, 200).rest, 250);
  assert.equal(pageOf(rows, 200).total, 450);
  assert.equal(pageOf(rows, 600).rest, 0);
  assert.equal(pageOf(rows).shown.length, 450, 'no limit, everything');
  assert.deepEqual(pageOf([], 10), { shown: [], total: 0, rest: 0 });
});

test('a year of records indexes in one pass', () => {
  // 2,561 formulations and 5,694 measurements, the cycle 4 benchmark's year: the lookups that used to scan
  // every measurement per formulation now answer from the maps.
  const ms = [];
  for (let b = 0; b < 2561; b++) for (const t of ['dls', 'ee']) ms.push(m(`m${ms.length}`, `B${b}`, t, `2026-${String(1 + (b % 12)).padStart(2, '0')}-01`));
  const t0 = performance.now();
  const idx = measurementIndex(ms);
  let found = 0;
  for (let b = 0; b < 2561; b++) if (batchResults(idx, `B${b}`).dls) found++;
  assert.equal(found, 2561);
  assert.ok(performance.now() - t0 < 500, 'well under the time one screen may take');
});
