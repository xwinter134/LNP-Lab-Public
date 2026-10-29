import test from 'node:test';
import assert from 'node:assert/strict';
import { qcFlags } from '../app/calc/qc.js';
import { getSettings, DEFAULT_SETTINGS } from '../app/refdata.js';

const withStored = (rec) => ({ store: { get: (col, id) => (col === 'settings' && id === 'default' ? rec : null) } });
const texts = (fs) => fs.map((x) => x.text);

test('a QC limit switched off, stored as null, checks nothing and is never compared as a number', () => {
  const off = { pdiMax: null, zaveMin: null, zaveMax: null, eeMin: null, countRateMin: null };
  // compared as it stood, null was 0: "PDI 0.12 > null" on every result, and every size "outside null–null"
  assert.deepEqual(qcFlags('dls', { zave_nm: 300, pdi: 0.12, countRate_kcps: 5 }, off), []);
  assert.deepEqual(qcFlags('ee', { ee_pct: 40 }, off), []);
  // the same values against limits that are set
  assert.deepEqual(texts(qcFlags('dls', { zave_nm: 300, pdi: 0.32, countRate_kcps: 5 }, DEFAULT_SETTINGS.qc)), ['PDI 0.32 > 0.2', 'Z-ave 300.0 nm outside 40–150', 'count rate 5 kcps low']);
  assert.deepEqual(texts(qcFlags('ee', { ee_pct: 40 }, DEFAULT_SETTINGS.qc)), ['EE 40.0 % < 85 %']);
  // one side of the size window off: the other still applies, and the flag names only that one
  assert.deepEqual(texts(qcFlags('dls', { zave_nm: 300 }, { ...DEFAULT_SETTINGS.qc, zaveMin: null })), ['Z-ave 300.0 nm > 150']);
  assert.deepEqual(texts(qcFlags('dls', { zave_nm: 30 }, { ...DEFAULT_SETTINGS.qc, zaveMax: null })), ['Z-ave 30.0 nm < 40']);
  assert.deepEqual(qcFlags('dls', { zave_nm: 30 }, { ...DEFAULT_SETTINGS.qc, zaveMin: null }), []);
});

test('settings as read: an empty default gives way to the shipped one, and a QC limit stored as null stays off', () => {
  const s = getSettings(withStored({ id: 'default', operator: 'GM', defaultFRR: null, defaultLipidStock_mM: 25, qc: { pdiMax: null, eeMin: 80 } }));
  assert.equal(s.defaultFRR, DEFAULT_SETTINGS.defaultFRR, 'an FRR stored empty would reach every new wizard empty');
  assert.equal(s.defaultLipidStock_mM, 25);
  assert.equal(s.operator, 'GM');
  assert.equal(s.qc.pdiMax, null, 'switched off with its box');
  assert.equal(s.qc.eeMin, 80);
  assert.equal(s.qc.zaveMax, DEFAULT_SETTINGS.qc.zaveMax, 'a limit never stored is the shipped one');
  assert.deepEqual(getSettings(withStored(null)), DEFAULT_SETTINGS);
});
