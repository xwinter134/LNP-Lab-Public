// The Insights explorer's statistics and field discovery (app/calc/insights.js), and the optimizer's account of
// its data (app/calc/ml/dataset.js, dataAccount).
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupCompare, correlationMatrix, capability, qcLimits, trend, chartKind, discoverFields, weekdayOf, dayNumber, humanise } from '../app/calc/insights.js';
import { dataAccount } from '../app/calc/ml/dataset.js';
import { ALL_FACTORS } from '../app/calc/ml/space.js';
import { welchTest, anovaOneWay } from '../app/calc/stats.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} is not ${b}`);

test('groupCompare: mean ± SD per lot, each against the others, and Welch for two groups', () => {
  const rows = [80, 82, 81, 79].map((v) => ({ lot: 'A', zave_nm: v })).concat([86, 88, 87].map((v) => ({ lot: 'B', zave_nm: v })), [{ lot: '', zave_nm: 300 }, { lot: 'A', zave_nm: null }]);
  const c = groupCompare(rows, 'zave_nm', 'lot');
  assert.equal(c.n, 7, 'no lot and no value are left out');
  const [a, b] = c.groups;
  assert.deepEqual([a.g, a.n, b.g, b.n], ['A', 4, 'B', 3]);
  near(a.mean, 80.5); near(b.mean, 87); near(a.diff, -6.5); near(b.diff, 6.5);
  near(a.sd, Math.sqrt(5 / 3));
  const w = welchTest([80, 82, 81, 79], [86, 88, 87]);
  assert.equal(c.test.kind, 'welch');
  near(c.test.p, w.p);
  near(a.p, w.p, 1e-12); // with two groups, "against the others" is the same test
  assert.ok(c.test.p < 0.001);
});

test('groupCompare: one-way ANOVA for three groups, in the order asked for; a group of one is listed but not tested', () => {
  const rows = [['Mon', 1], ['Mon', 2], ['Wed', 3], ['Wed', 5], ['Fri', 9], ['Fri', 8], ['Tue', 4]].map(([d, v]) => ({ weekday: d, ee_pct: v }));
  const c = groupCompare(rows, 'ee_pct', 'weekday', { order: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] });
  assert.deepEqual(c.groups.map((g) => g.g), ['Mon', 'Tue', 'Wed', 'Fri']);
  assert.equal(c.groups[1].p, null, 'one batch cannot be tested');
  const a = anovaOneWay([[1, 2], [4], [3, 5], [9, 8]]);
  assert.equal(c.test.kind, 'anova');
  near(c.test.p, a.p); near(c.test.F, a.F);
  assert.deepEqual(c.test.df, [3, 3]);
});

test('trend, correlations and the chart each kind of X gets', () => {
  const rows = [1, 2, 3, 4, 5].map((x) => ({ frr: x, zave_nm: 100 - 4 * x + (x % 2 ? 0.5 : -0.5), pdi: 0.1, peg: x === 3 ? null : 1 }));
  const t = trend(rows, 'frr', 'zave_nm');
  near(t.slope, -4, 0.3);
  assert.ok(t.p < 0.001 && t.r < -0.99);
  assert.equal(trend(rows.slice(0, 2), 'frr', 'zave_nm'), null);
  const m = correlationMatrix(rows, ['frr', 'peg'], ['zave_nm', 'pdi']);
  assert.equal(m.length, 4);
  assert.ok(m.find((c) => c.x === 'frr' && c.y === 'zave_nm').r < -0.99);
  assert.equal(m.find((c) => c.x === 'frr' && c.y === 'pdi').r, null, 'no spread in PDI: no r');
  assert.equal(m.find((c) => c.x === 'peg' && c.y === 'zave_nm').r, null, 'a constant parameter: no r');
  assert.equal(chartKind({ kind: 'numeric' }), 'scatter');
  assert.equal(chartKind({ kind: 'category' }), 'strip');
  assert.equal(chartKind({ kind: 'date' }), 'time');
});

test('capability against the QC limits of Settings', () => {
  assert.deepEqual(qcLimits('zave_nm', { zaveMin: 40, zaveMax: 150 }), { lsl: 40, usl: 150 });
  assert.deepEqual(qcLimits('pdi', { pdiMax: 0.2 }), { lsl: null, usl: 0.2 });
  assert.deepEqual(qcLimits('ee_pct', { eeMin: 85 }), { lsl: 85, usl: null });
  assert.equal(qcLimits('pdi', { pdiMax: null }), null, 'a limit switched off');
  assert.equal(qcLimits('zeta_mV', { pdiMax: 0.2 }), null);
  const c = capability([90, 95, 100, 105, 110], { lsl: 40, usl: 150 });
  const s = Math.sqrt(62.5);
  near(c.sd, s); near(c.cpk, 50 / (3 * s)); near(c.cp, 110 / (6 * s));
  assert.equal(c.verdict, 'capable');
  const one = capability([0.18, 0.21, 0.24, 0.27], { usl: 0.2 });
  assert.equal(one.cp, null, 'one-sided: no Cp');
  assert.ok(one.cpk < 0);
  assert.equal(one.outside, 3);
  assert.equal(one.verdict, 'not capable');
  assert.equal(capability([1, 1, 1], { usl: 2 }), null, 'no spread');
  assert.equal(capability([1, 2], { usl: 2 }), null, 'too few');
});

test('fields another part of the app adds reach Insights without being listed', () => {
  const batches = [
    { id: 'E1-F1', status: 'produced', freezeThaw: 2, plan: { rna: { lotId: 'R1', cargo: 'mRNA', np: 6 }, mixing: { frr: 3 }, factors: { FRR: 3, mixer: 't-mixer', temp_C: 20 } } },
    { id: 'E1-F2', status: 'produced', freezeThaw: 0, plan: { rna: { cargo: 'siRNA' }, mixing: { frr: 4 }, factors: { FRR: 4, mixer: 'chip', temp_C: 25 } } },
  ];
  const f = discoverFields(batches, { factorNames: ['frr', 'FRR'] });
  const by = Object.fromEntries(f.map((x) => [x.path, x]));
  assert.equal(by['plan.rna.cargo'].kind, 'category');
  assert.equal(by['plan.rna.cargo'].key, 'x.plan.rna.cargo');
  assert.equal(by.freezeThaw.kind, 'numeric');
  assert.equal(by.freezeThaw.label, 'Freeze thaw');
  assert.equal(by['plan.factors.mixer'].kind, 'category');
  assert.equal(by['plan.factors.temp_C'].kind, 'numeric');
  assert.ok(!by['plan.factors.FRR'], 'a factor already read as FRR is not offered twice');
  assert.ok(!by['plan.rna.np'] && !by['plan.mixing.frr'] && !by.status && !by.id, 'nor are the known fields');
  assert.equal(humanise('rna_cargo'), 'Rna cargo');
  assert.equal(weekdayOf('2026-10-29'), 'Thu');
  assert.equal(weekdayOf(''), null);
  assert.equal(dayNumber('1970-01-03'), 2);
});

test('the optimizer accounts for every formulation: used, or left out with the reason', () => {
  const space = [{ key: 'frr', name: 'FRR', lo: 2, hi: 4 }, { key: 'tfr', name: 'Total flow', lo: 60, hi: 120 }];
  const goals = [{ name: 'particle_size_nm', on: true }, { name: 'PDI', on: true }, { name: 'zeta_potential_mV', on: false }];
  const row = (id, exp, factors, values, extra = {}) => ({ batchId: id, experimentId: exp, experimentName: `Exp ${exp}`, experimentType: 'doe', factors, values, status: 'measured', ...extra });
  const rows = [
    row('E1-F1', 'E1', { frr: 3, tfr: 90 }, { particle_size_nm: 90, PDI: 0.1 }),
    row('E1-F2', 'E1', { frr: 5, tfr: 90 }, { particle_size_nm: 95 }), // outside the search range, inside the limits: used
    row('E1-F3', 'E1', { frr: 3, tfr: null }, { particle_size_nm: 95 }), // no flow on record
    row('E1-F4', 'E1', { frr: 3, tfr: 90 }, {}, { status: 'planned' }), // not made
    row('E1-F5', 'E1', { frr: 3, tfr: 90 }, { zeta_potential_mV: -3 }), // measured, not for a goal
    row('E2-F1', 'E2', { frr: 9, tfr: 90 }, { particle_size_nm: 80 }), // FRR 9: past the 1–6 the optimizer works in
    row('E3-F1', 'E3', { frr: 3, tfr: 90 }, { particle_size_nm: 85 }),
    row('X-1', null, { frr: 3, tfr: 70 }, { PDI: 0.2 }),
  ];
  const a = dataAccount(rows, { space, goals, excluded: ['E3'], limits: ALL_FACTORS });
  assert.deepEqual(a.used.map((r) => r.batchId), ['E1-F1', 'E1-F2', 'X-1']);
  assert.deepEqual(a.used[1].outsideSearch, ['FRR']);
  assert.deepEqual(a.reasons, { excluded: 1, noResult: 2, missingFactor: 1, outside: 1 });
  const why = Object.fromEntries(a.left.map((x) => [x.batchId, x]));
  assert.equal(why['E1-F3'].detail, 'no Total flow on its record');
  assert.equal(why['E1-F4'].detail, 'not made yet');
  assert.equal(why['E1-F5'].detail, 'measured, but not for a response switched on as a goal');
  assert.equal(why['E2-F1'].detail, 'FRR 9, outside 1–6');
  assert.equal(why['E3-F1'].reason, 'excluded');
  assert.equal(a.used.length + a.left.length, rows.length, 'every formulation is either used or left out');
  // experiment by experiment, in number order, the formulations without an experiment last
  assert.deepEqual(a.experiments.map((e) => e.id), ['E1', 'E2', 'E3', '']);
  const e1 = a.experiments[0];
  assert.deepEqual([e1.total, e1.measured, e1.used, e1.outsideSearch], [5, 4, 2, 1]);
  assert.deepEqual(e1.responses, { particle_size_nm: 3, PDI: 1, zeta_potential_mV: 1 });
  assert.equal(a.experiments[2].excluded, true);
  assert.equal(a.usedExperiments, 2, 'E1 and the formulations outside any experiment');
});
