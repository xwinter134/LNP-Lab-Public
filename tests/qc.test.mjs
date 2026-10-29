import test from 'node:test';
import assert from 'node:assert/strict';
import { checkValues, qcFlags, correctResult, describeCorrection } from '../app/calc/qc.js';

const texts = (r) => r.errors.map((e) => e.text);

test('a PDI of 5 is refused, and the message says what was probably meant', () => {
  const r = checkValues('dls', { zave_nm: 82.4, pdi: 5 });
  assert.deepEqual(texts(r), ['PDI 5 is outside 0–1 — did you mean 0.05?']);
  assert.equal(r.errors[0].key, 'pdi');
  assert.match(checkValues('dls', { pdi: 12 }).errors[0].text, /did you mean 0\.12\?/);
  assert.match(checkValues('dls', { pdi: -0.05 }).errors[0].text, /outside 0–1 — did you mean 0\.05\?/);
  // the bounds themselves are possible values
  assert.deepEqual(checkValues('dls', { zave_nm: 82, pdi: 0 }).errors, []);
  assert.deepEqual(checkValues('dls', { zave_nm: 82, pdi: 1 }).errors, []);
});

test('Z-ave must be above 0 and at most 10 000 nm', () => {
  assert.match(texts(checkValues('dls', { zave_nm: 0 }))[0], /Z-ave 0 nm must be above 0/);
  assert.match(texts(checkValues('dls', { zave_nm: -80 }))[0], /must be above 0/);
  assert.equal(texts(checkValues('dls', { zave_nm: 82400 }))[0], 'Z-ave 82400 nm is above 10000 nm — did you mean 82.4?');
  assert.deepEqual(checkValues('dls', { zave_nm: 10000 }).errors, []);
});

test('a bad run is named, and the mean it spoils is not reported a second time', () => {
  const r = checkValues('dls', { zave_nm: 82, pdi: 1.7, runs: [{ zave_nm: 82, pdi: 0.05 }, { zave_nm: 82, pdi: 5 }] });
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].run, 1);
  assert.match(r.errors[0].text, /^run 2: PDI 5 is outside 0–1/);
});

test('EE outside 0–100 %, |zeta| above 200 mV and negative concentrations are refused', () => {
  assert.equal(texts(checkValues('ee', { ee_pct: 925 }))[0], 'EE 925 % is outside 0–100 % — did you mean 92.5?');
  assert.equal(texts(checkValues('ee', { ee_pct: 101 }))[0], 'EE 101 % is outside 0–100 %');
  assert.equal(checkValues('ee', { ee_pct: -1 }).errors.length, 1);
  assert.deepEqual(checkValues('ee', { ee_pct: 100 }).errors, []);
  assert.equal(texts(checkValues('zeta', { zeta_mV: -350 }))[0], 'Zeta -350 mV is outside ±200 mV — did you mean -35?');
  assert.deepEqual(checkValues('zeta', { zeta_mV: -200 }).errors, []);
  assert.equal(texts(checkValues('ee', { ee_pct: 95, free_mg_mL: -0.001 }))[0], 'Free RNA -0.001 mg/mL cannot be negative');
  assert.equal(texts(checkValues('content', { rna_mg_mL: -0.1 }))[0], 'RNA content -0.1 mg/mL cannot be negative');
  assert.equal(checkValues('dls', { pdi: NaN }).errors.length, 1);
  // An EE worked out from free above total is arithmetic, not a typo, so there is nothing to guess at.
  const derived = checkValues('ee', { ee_pct: -40, total_mg_mL: 0.05, free_mg_mL: 0.07 });
  assert.deepEqual(texts(derived), ['EE -40 % is outside 0–100 %']);
  assert.match(derived.warnings[0].text, /Free RNA 0\.07 is above total RNA 0\.05/);
});

test('probable unit slips are warnings, not refusals', () => {
  const f = checkValues('ee', { ee_pct: 0.95 });
  assert.deepEqual(f.errors, []);
  assert.match(f.warnings[0].text, /looks like a fraction — was it 95 %/);
  const u = checkValues('content', { rna_mg_mL: 45 });
  assert.deepEqual(u.errors, []);
  assert.match(u.warnings[0].text, /was it µg\/mL \(0\.045 mg\/mL\)/);
});

test('nothing to check is nothing refused; tests without limits pass through', () => {
  assert.deepEqual(checkValues('dls', null), { errors: [], warnings: [] });
  assert.deepEqual(checkValues('dls', {}), { errors: [], warnings: [] });
  assert.deepEqual(checkValues('potency', { rlu: 123456, pctControl: 140 }), { errors: [], warnings: [] });
});

test('QC flags are unchanged: a high PDI inside 0–1 still only flags', () => {
  const qc = { pdiMax: 0.2, zaveMin: 40, zaveMax: 150, eeMin: 85, countRateMin: 50 };
  assert.deepEqual(checkValues('dls', { zave_nm: 160, pdi: 0.4 }).errors, []);
  assert.equal(qcFlags('dls', { zave_nm: 160, pdi: 0.4 }, qc).length, 2);
});

test('a stored result is corrected with a reason, keeps what it replaced, and is checked like any entry', () => {
  const qc = { pdiMax: 0.2, zaveMin: 50, zaveMax: 150, eeMin: 80, countRateMin: 100 };
  const m = { id: 'm1', test: 'dls', sampleName: 'E2-F1_final', values: { zave_nm: 82.4, pdi: 0.5 }, flags: [{ level: 'warn', text: 'PDI 0.50 > 0.2' }] };
  // a PDI of 5 is refused here as on entry
  const five = correctResult(m, { values: { zave_nm: 82.4, pdi: 5 }, reason: 'typo', by: 'GM', at: '2026-10-27T09:00:00Z' }, qc);
  assert.equal(five.record, null);
  assert.match(five.errors.map((e) => e.text).join(' '), /PDI 5 is outside 0–1/);
  // no reason, no correction
  const silent = correctResult(m, { values: { zave_nm: 82.4, pdi: 0.05 }, reason: '  ' }, qc);
  assert.equal(silent.record, null);
  assert.equal(silent.errors[0].key, 'reason');
  // nothing changed is said, not stored as a correction
  assert.match(correctResult(m, { values: { ...m.values }, reason: 'typo' }, qc).errors.map((e) => e.text).join(' '), /Nothing was changed/);
  const ok = correctResult(m, { values: { zave_nm: 82.4, pdi: 0.05 }, reason: ' typo ', by: 'GM', at: '2026-10-27T09:00:00Z' }, qc);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.record.values.pdi, 0.05);
  assert.deepEqual(ok.record.flags, []); // the PDI flag went with the typo
  assert.deepEqual(ok.record.history, [{ at: '2026-10-27T09:00:00Z', by: 'GM', reason: 'typo', values: { zave_nm: 82.4, pdi: 0.5 } }]);
  assert.equal(describeCorrection('dls', ok.record.history[0].values, ok.record.values), 'PDI 0.5');
  // a second correction keeps the first
  const again = correctResult(ok.record, { values: { zave_nm: 84.1, pdi: 0.05 }, reason: 're-measured', by: 'GM', at: '2026-10-28T09:00:00Z' }, qc);
  assert.equal(again.record.history.length, 2);
  assert.equal(describeCorrection('dls', again.record.history[1].values, again.record.values), 'Z-ave 82.4 nm');
  // a value cleared reads as emptied, in the units of its field
  assert.equal(describeCorrection('ee', { ee_pct: 925, total_mg_mL: 0.05 }, { ee_pct: 92.5 }), 'EE 925 %, Total RNA 0.05 mg/mL');
});

test('a corrected run moves the mean and the spread with it', () => {
  const runs = [{ zave_nm: 80, pdi: 0.08 }, { zave_nm: 812, pdi: 0.1 }, { zave_nm: 82, pdi: 0.09 }];
  const m = { test: 'dls', values: { zave_nm: 324.6666666666667, pdi: 0.09, runs, zave_sd: 422, countRate_kcps: 300 } };
  const fixed = runs.map((r, i) => (i === 1 ? { ...r, zave_nm: 81.2 } : r));
  const r = correctResult(m, { values: { ...m.values, runs: fixed }, reason: 'typo' }, {});
  assert.ok(Math.abs(r.record.values.zave_nm - 81.06666666666666) < 1e-9);
  assert.ok(Math.abs(r.record.values.zave_sd - 1.0066445913694333) < 1e-9);
  assert.equal(r.record.values.countRate_kcps, 300);
  assert.equal(describeCorrection('dls', m.values, r.record.values), 'Z-ave 324.67 nm, run 2 Z-ave 812 nm');
  // an impossible run is refused with its index
  const bad = correctResult(m, { values: { ...m.values, runs: runs.map((x, i) => (i === 2 ? { ...x, pdi: 5 } : x)) }, reason: 'typo' }, {});
  assert.equal(bad.record, null);
  assert.equal(bad.errors.find((e) => e.key === 'pdi').run, 2);
  // a PDI typed once beside runs that never had one is left as it was given
  const typed = { test: 'dls', values: { zave_nm: 82, pdi: 0.07, runs: [{ zave_nm: 81, pdi: null }, { zave_nm: 83, pdi: null }] } };
  const t2 = correctResult(typed, { values: { ...typed.values, runs: [{ zave_nm: 81, pdi: null }, { zave_nm: 85, pdi: null }] }, reason: 'typo' }, {});
  assert.equal(t2.record.values.pdi, 0.07);
  assert.equal(t2.record.values.zave_nm, 83);
});
