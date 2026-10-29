// The overview's latest results: which formulations, and the sentence that judges them against the QC limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { latestMeasured, latestSentence, qcOf, nameList } from '../app/calc/latest.js';

const QC = { zaveMin: 40, zaveMax: 150, pdiMax: 0.2 };
const dls = (batchId, date, zave, pdi, extra = {}) => ({ id: `${batchId}@${date}`, batchId, sampleName: `${batchId}_final`, test: 'dls', date, values: { zave_nm: zave, pdi }, ...extra });

test('each formulation once, with its most recent DLS result, oldest first, at most n', () => {
  const ms = [
    dls('E1-F1', '2026-10-01', 80, 0.1),
    dls('E1-F1', '2026-10-08', 84, 0.12, { sampleName: 'E1-F1_4C_T07' }),
    dls('E1-F2', '2026-10-03', 90, 0.15),
    { id: 'ee', batchId: 'E1-F3', test: 'ee', date: '2026-10-09', values: { ee_pct: 93 } },
    { id: 'free', test: 'dls', date: '2026-10-09', values: { zave_nm: 70, pdi: 0.1 } }, // no formulation
    dls('E1-F4', '2026-10-05', NaN, 0.1),
    dls('E1-F5', '2026-10-05', 100, undefined),
  ];
  const rows = latestMeasured(ms, 20);
  assert.deepEqual(rows.map((r) => r.batchId), ['E1-F2', 'E1-F5', 'E1-F1']);
  assert.equal(rows[2].zave, 84);
  assert.equal(rows[2].sampleName, 'E1-F1_4C_T07');
  assert.equal(rows[1].pdi, null, 'a missing PDI is kept as missing');
  assert.deepEqual(latestMeasured(ms, 2).map((r) => r.batchId), ['E1-F5', 'E1-F1'], 'the newest n');
  assert.deepEqual(latestMeasured([], 20), []);
  // the same day is ordered by when the result was stored
  const sameDay = [dls('E2-F1', '2026-10-10', 80, 0.1, { createdAt: '2026-10-10T09:00:00Z' }), dls('E2-F2', '2026-10-10', 80, 0.1, { createdAt: '2026-10-10T08:00:00Z' })];
  assert.deepEqual(latestMeasured(sameDay).map((r) => r.batchId), ['E2-F2', 'E2-F1']);
});

test('QC judgement: size below or above the band, PDI above its limit, a missing PDI not judged', () => {
  assert.deepEqual(qcOf({ zave: 80, pdi: 0.1 }, QC), { size: null, pdi: false, ok: true });
  assert.deepEqual(qcOf({ zave: 30, pdi: 0.1 }, QC), { size: 'low', pdi: false, ok: false });
  assert.deepEqual(qcOf({ zave: 160, pdi: 0.25 }, QC), { size: 'high', pdi: true, ok: false });
  assert.deepEqual(qcOf({ zave: 80, pdi: null }, QC), { size: null, pdi: false, ok: true });
  assert.equal(qcOf({ zave: 150, pdi: 0.2 }, QC).ok, true, 'the limits themselves are inside');
});

test('the sentence: how many inside, and who is outside on what', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ batchId: `E6-F${i + 1}`, zave: 80, pdi: 0.1 }));
  rows[3].pdi = 0.31; rows[13].pdi = 0.24;
  assert.equal(latestSentence(rows, QC), '18 of the last 20 inside the QC limits for size and PDI; E6-F4 and E6-F14 are outside on PDI.');
  rows[5].zave = 170; rows[3].zave = 20;
  assert.equal(latestSentence(rows, QC), '17 of the last 20 inside the QC limits for size and PDI; E6-F4 is outside on size and PDI; E6-F14 is outside on PDI; E6-F6 is outside on size.');
  assert.equal(latestSentence(rows.map((r) => ({ ...r, zave: 80, pdi: 0.1 })), QC), 'All of the last 20 inside the QC limits for size and PDI.');
});

test('fewer results than the window, one result, none', () => {
  const rows = [{ batchId: 'E1-F1', zave: 80, pdi: 0.1 }, { batchId: 'E1-F2', zave: 80, pdi: 0.5 }];
  assert.equal(latestSentence(rows, QC), '1 of the 2 measured so far inside the QC limits for size and PDI; E1-F2 is outside on PDI.');
  assert.equal(latestSentence([rows[0]], QC), 'E1-F1, the only formulation measured so far, is inside the QC limits for size and PDI.');
  assert.equal(latestSentence([rows[1]], QC), 'E1-F2, the only formulation measured so far, is outside on PDI.');
  assert.equal(latestSentence([rows[0], rows[0]], QC), 'All 2 formulations measured so far inside the QC limits for size and PDI.');
  assert.equal(latestSentence([], QC), '');
});

test('a long list of names is cut short', () => {
  assert.equal(nameList([]), '');
  assert.equal(nameList(['A']), 'A');
  assert.equal(nameList(['A', 'B', 'C']), 'A, B and C');
  assert.equal(nameList(['A', 'B', 'C', 'D']), 'A, B, C and D');
  assert.equal(nameList(['A', 'B', 'C', 'D', 'E', 'F']), 'A, B, C and 3 more');
});
