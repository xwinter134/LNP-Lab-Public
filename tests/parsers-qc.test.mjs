// What an import's evaluation and the Overview say about the QC limits once a limit can be switched off
// (usability cycle 6, Q1): only the limits that are set, and that a reading in the data could be held against.
import test from 'node:test';
import assert from 'node:assert/strict';
import { qcChecked } from '../app/calc/evaluate.js';
import { latestSentence } from '../app/calc/latest.js';

const ALL = { zaveMin: 40, zaveMax: 150, pdiMax: 0.2, eeMin: 85, countRateMin: 50 };
const off = (...keys) => ({ ...ALL, ...Object.fromEntries(keys.map((k) => [k, null])) });

test('qcChecked: the readings with a limit set, and the tests with every limit switched off', () => {
  assert.deepEqual(qcChecked(['dls', 'ee'], ALL), { checked: ['size', 'PDI', 'count rate', 'encapsulation'], off: [] });
  assert.deepEqual(qcChecked(['ee'], off('eeMin')), { checked: [], off: ['ee'] });
  assert.deepEqual(qcChecked(['dls', 'ee'], off('eeMin', 'pdiMax')), { checked: ['size', 'count rate'], off: ['ee'] });
  assert.deepEqual(qcChecked(['dls'], off('zaveMin', 'zaveMax', 'pdiMax', 'countRateMin')), { checked: [], off: ['dls'] });
  // one end of the size window is enough to check size
  assert.deepEqual(qcChecked(['dls'], off('zaveMin', 'pdiMax', 'countRateMin')).checked, ['size']);
  // zeta and RNA content have no limits to switch off
  assert.deepEqual(qcChecked(['zeta', 'content'], off('zaveMin', 'zaveMax', 'pdiMax', 'eeMin', 'countRateMin')), { checked: [], off: [] });
  assert.deepEqual(qcChecked(['dls'], undefined), { checked: [], off: ['dls'] });
});

test('qcChecked with the samples: a limit counts only for a reading the data carries', () => {
  const sizeOnly = [{ test: 'dls', metrics: { zave_nm: { mean: 80 }, pdi: { mean: 0.1 } }, countRate: null }];
  assert.deepEqual(qcChecked(['dls'], ALL, sizeOnly).checked, ['size', 'PDI'], 'a pasted size and PDI has no count rate');
  assert.deepEqual(qcChecked(['dls'], ALL, [{ ...sizeOnly[0], countRate: 300 }]).checked, ['size', 'PDI', 'count rate']);
  // limits set but nothing to hold against them: no claim either way
  assert.deepEqual(qcChecked(['ee'], ALL, [{ test: 'ee', metrics: {} }]), { checked: [], off: [] });
});

test('the Overview names only the limits that are switched on, and judges nothing with none', () => {
  const rows = [{ batchId: 'E1-F1', zave: 80, pdi: 0.1 }, { batchId: 'E1-F2', zave: 200, pdi: 0.5 }];
  assert.equal(latestSentence(rows, ALL), '1 of the 2 measured so far inside the QC limits for size and PDI; E1-F2 is outside on size and PDI.');
  assert.equal(latestSentence(rows, off('pdiMax')), '1 of the 2 measured so far inside the QC limits for size; E1-F2 is outside on size.');
  assert.equal(latestSentence(rows, off('zaveMin', 'zaveMax')), '1 of the 2 measured so far inside the QC limits for PDI; E1-F2 is outside on PDI.');
  assert.equal(latestSentence([rows[0], rows[0]], off('zaveMin', 'pdiMax')), 'All 2 formulations measured so far inside the QC limits for size.');
  const none = off('zaveMin', 'zaveMax', 'pdiMax');
  assert.equal(latestSentence(rows, none), 'No QC limit for size or PDI is switched on in Settings, so these results are not judged against one.');
  assert.doesNotMatch(latestSentence([rows[0]], none), /inside/);
  assert.equal(latestSentence([], none), '');
});
