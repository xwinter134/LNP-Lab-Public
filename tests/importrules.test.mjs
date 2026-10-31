// One rule set (spec 6.1/6.2): the import of tidy tables checks a measurement's values with the app's own rules
// (app/calc/qc.js checkValues and LIMITS) and takes the value keys the results grid stores, so the app and an
// import cannot disagree about what a result may be.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TESTS, checkMeasurementValues, checkTidy, tidySchema } from '../app/calc/importcheck.js';
import { LIMITS, checkValues } from '../app/calc/qc.js';
import { GRID_COLUMNS } from '../app/calc/gridentry.js';

test('the import knows exactly the tests and fields of the app', () => {
  for (const [t, rules] of Object.entries(LIMITS)) for (const r of rules) assert.deepEqual(TESTS[t][r.key], [r.min ?? null, r.max ?? null], `${t}.${r.key}`);
  for (const c of GRID_COLUMNS) assert.ok(c.key in TESTS[c.test], `${c.test}.${c.key} of the grid`);
  assert.ok('rna_mg_mL' in TESTS.content, 'RNA content is stored as the grid stores it');
  const m = tidySchema().measurements;
  assert.deepEqual(m.find((f) => f.key === 'test').options, Object.keys(TESTS));
  assert.match(m.find((f) => f.key === 'total_mg_mL').note, /ee.*lipid_content/);
});

test('a value is refused by the import exactly when the app refuses it', () => {
  const cases = [['dls', 'pdi', [0.1, 1, 1.2, -0.1, 8.5]], ['dls', 'zave_nm', [0, 0.5, 80, 9999, 12000]], ['zeta', 'zeta_mV', [-250, -30, 199]], ['ee', 'ee_pct', [-1, 0, 93, 100, 925]],
    ['content', 'rna_mg_mL', [-0.1, 0.2]], ['ph', 'ph', [-1, 7.4, 15]], ['integrity', 'pct', [50, 101]], ['endotoxin', 'eu_mL', [-1, 3]]];
  for (const [test, key, xs] of cases) for (const x of xs) {
    const app = checkValues(test, { [key]: x }).errors.length > 0;
    const imp = checkMeasurementValues(test, { [key]: String(x).replace('.', ',') }).problems.length > 0;
    assert.equal(imp, app, `${test} ${key} ${x}: app ${app ? 'refuses' : 'takes'} it`);
  }
  assert.match(checkMeasurementValues('dls', { pdi: '8.5' }).problems[0], /^PDI 8\.5 is outside 0–1, probably a typing slip \(did you mean 0\.085\?\)$/);
  assert.match(checkMeasurementValues('dls', { zave_nm: 'n.d.' }).problems[0], /Z-ave "n\.d\." is not a number/);
  assert.match(checkMeasurementValues('dls', { zave_nm: '80', zave_sd: '-2' }).problems[0], /zave_sd -2 cannot be negative/);
  for (const p of [...checkMeasurementValues('ee', { ee_pct: '925' }).problems, ...checkMeasurementValues('ee', { ee_pct: '0.9' }).warnings]) assert.ok(!p.includes('—'), 'no em dash in an import reason');
});

test('a probable unit slip is imported, with the app\'s warning as a flag', () => {
  const tables = {
    formulations: { name: 'f.csv', rows: [{ __row: 2, exp_key: 'X', form_key: 'F1', composition_id: '1' }] },
    measurements: { name: 'm.csv', rows: [{ __row: 2, exp_key: 'X', form_key: 'F1', test: 'ee', ee_pct: '0.93' }, { __row: 3, exp_key: 'X', form_key: 'F1', test: 'content', rna_mg_mL: '0.12' }] },
  };
  const r = checkTidy(tables, { compositions: [{ id: 1, mol_pct: { A: 100 } }] });
  assert.equal(r.measurements.length, 2);
  assert.match(r.measurements[0].flags[0].text, /EE 0\.93 % looks like a fraction: was it 93 %\?/);
  assert.deepEqual(r.measurements[1].values, { rna_mg_mL: 0.12 });
});
