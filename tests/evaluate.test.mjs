import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateImport, replicate, qcFindings, robustZ, shortLabels, metricsFor, describe, median, experimentStatus } from '../app/calc/evaluate.js';
import { buildExperiment } from '../app/calc/experiment.js';
import { DEFAULT_SETTINGS } from '../app/refdata.js';

const qc = DEFAULT_SETTINGS.qc; // pdiMax 0.2, zaveMin 40, zaveMax 150, eeMin 85, countRateMin 50
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} is not ${b} (±${tol})`);
const env = (id) => ({ settings: DEFAULT_SETTINGS, takenFormulations: [], experimentId: id });

/** A DLS record the way the importer stores one: the mean, the runs behind it and the slot it filled. */
let seq = 0;
function dls(slot, runs, extra = {}) {
  const z = runs.map((r) => r[0]), p = runs.map((r) => r[1]);
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  seq += 1;
  return { id: `m${seq}`, test: 'dls', batchId: slot.batchId, experimentId: extra.experimentId, slotId: slot.id, stage: slot.stage, sampleName: slot.sampleName,
    condition: slot.condition, timepoint: slot.timepoint, createdAt: `2026-10-17T10:00:${String(seq).padStart(2, '0')}Z`,
    values: { zave_nm: avg(z), pdi: avg(p), runs: runs.map(([zave_nm, pdi]) => ({ zave_nm, pdi })), countRate_kcps: extra.kcps ?? 300 } };
}
/** What saveMeasurement does to the experiment: the slot is marked done. */
const markDone = (exp, recs) => { for (const r of recs) { const s = exp.expected.find((x) => x.id === r.slotId); if (s) { s.status = 'done'; s.measurementId = r.id; } } };

test('one sample: the stored mean, the SD and CV of its runs; a single run has no SD', () => {
  const r = replicate({ zave_nm: 82.8, runs: [{ zave_nm: 82.4 }, { zave_nm: 83.1 }, { zave_nm: 82.9 }] }, 'zave_nm');
  near(r.mean, 82.8); assert.equal(r.n, 3);
  near(r.sd, 0.360555127546399, 1e-12); // sample SD of 82.4, 83.1, 82.9
  near(r.cv, 100 * 0.360555127546399 / 82.8, 1e-9);
  const one = replicate({ zave_nm: 91.2, runs: [{ zave_nm: 91.2 }] }, 'zave_nm');
  assert.equal(one.sd, null); assert.equal(one.cv, null); assert.equal(one.n, 1);
  // a value stored without runs (a zeta import, a typed EE) is still a result
  near(replicate({ zeta_mV: -4.2 }, 'zeta_mV').mean, -4.2);
  assert.equal(replicate({ pdi: 0.1 }, 'zave_nm'), null);
});

test('QC findings name the number, the limit and which way it is out', () => {
  const m = (z, p, runs = []) => ({ zave_nm: replicate({ zave_nm: z, runs: runs.map((x) => ({ zave_nm: x })) }, 'zave_nm'), pdi: replicate({ pdi: p }, 'pdi') });
  assert.deepEqual(qcFindings('dls', m(82, 0.1, [81.5, 82.5]), 300, qc), []);
  const big = qcFindings('dls', m(162.3, 0.24), 300, qc);
  assert.deepEqual(big.map((f) => f.kind), ['limit', 'limit']);
  assert.match(big[0].text, /162\.3 nm is above the 150 nm limit/);
  assert.match(big[1].text, /PDI 0\.240 is above the 0\.2 limit/);
  assert.match(qcFindings('dls', m(35, 0.1), 300, qc)[0].text, /below the 40 nm limit/);
  // runs 75 and 90: CV 12.9 %, past the 5 % the record's own flag uses
  const cv = qcFindings('dls', m(82.5, 0.1, [75, 90]), 300, qc);
  assert.equal(cv.length, 1); assert.equal(cv[0].kind, 'cv'); assert.match(cv[0].text, /12\.9 % between runs/);
  const dim = qcFindings('dls', m(82, 0.1), 32, qc);
  assert.equal(dim[0].kind, 'count'); assert.match(dim[0].text, /32 kcps is below 50/);
  const ee = qcFindings('ee', { ee_pct: replicate({ ee_pct: 71.4 }, 'ee_pct') }, null, qc);
  assert.match(ee[0].text, /71\.4 % is below the 85 % limit/);
  assert.deepEqual(qcFindings('dls', m(500, 0.9), 1, {}), [], 'no limits set, nothing to say');
});

test('robust z: one wild sample stands out, a small set is not judged, identical values do not divide by zero', () => {
  const xs = [80, 81, 82, 83, 81.5, 82.5, 130];
  const z = robustZ(xs);
  assert.ok(z[6] > 3.5, `130 nm should be far out, got ${z[6]}`);
  assert.ok(z.slice(0, 6).every((v) => Math.abs(v) < 3.5));
  // the classic score: median 82, MAD 1, so 0.6745 × 48
  near(z[6], 0.6745 * 48, 1e-9);
  assert.deepEqual(robustZ([80, 81, 200, 82]), [null, null, null, null], 'four samples are too few to call one unusual');
  const flat = robustZ([80, 80, 80, 80, 80, 95]);
  assert.ok(Number.isFinite(flat[5]) && flat[5] > 3.5, 'MAD of zero falls back to the mean absolute deviation');
  assert.deepEqual(robustZ([5, 5, 5, 5, 5]), [0, 0, 0, 0, 0]);
  assert.equal(robustZ([1, 2, NaN, 3, 4, 5])[2], null);
});

test('chart labels drop what every sample shares, and keep full names when that would make two the same', () => {
  assert.deepEqual(shortLabels(['E3-F1_final', 'E3-F2_final', 'E3-F10_final']), { labels: ['F1', 'F2', 'F10'], prefix: 'E3-', suffix: '_final' });
  assert.deepEqual(shortLabels(['E1-F1_4C_T07', 'E1-F2_25C_T07']), { labels: ['F1_4C_T07', 'F2_25C_T07'], prefix: 'E1-', suffix: '' });
  assert.deepEqual(shortLabels(['E1-F1_final', 'E2-F1_final']).labels, ['E1-F1', 'E2-F1']);
  assert.deepEqual(shortLabels(['E1-F1_final', 'E1-F1']), { labels: ['E1-F1_final', 'E1-F1'], prefix: '', suffix: '' });
  // an inbox row never had the experiment in its name; it neither blocks the shortening nor is changed by it
  assert.deepEqual(shortLabels(['E1-F1_final', 'E1-F2_final', 'Sample 6']).labels, ['F1', 'F2', 'Sample 6']);
  assert.deepEqual(shortLabels(['E1-F3_final', 'F3']).labels, ['E1-F3_final', 'F3']);
});

test('small helpers: median, describe, and the metric a record is read by', () => {
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([4, 1, 3, 2]), 2.5); assert.equal(median([]), null);
  const d = describe([80, 82, 84, NaN]);
  assert.equal(d.n, 3); near(d.mean, 82); near(d.sd, 2); near(d.cv, 100 * 2 / 82); assert.equal(d.min, 80); assert.equal(d.max, 84);
  assert.deepEqual(metricsFor('dls', [{ values: { zave_nm: 80, pdi: 0.1 } }]).map((m) => m.key), ['zave_nm', 'pdi']);
  assert.deepEqual(metricsFor('ee', [{ values: { ee_pct: 92, total_mg_mL: 0.1 } }]).map((m) => m.key), ['ee_pct']);
  // a test this file has never heard of is read by its first numeric result, not by its settings
  assert.deepEqual(metricsFor('turbidity', [{ values: { temp_c: 25, ntu: 3.2, method: 'x' } }]).map((m) => m.key), ['ntu']);
  assert.deepEqual(metricsFor('dls', [{ values: {} }]), []);
});

test('an import into a single experiment: headline, flags, what is still open', () => {
  // three single-formulation experiments would be three experiments; a comparison of five compositions is one
  const { experiment: exp, batches } = buildExperiment({ type: 'comparison', name: 'five recipes', startDate: '2026-10-12', compositionId: 1,
    comparison: { compositionIds: [1, 2, 3, 4, 5] }, tests: ['dls', 'ee'] }, env('E4'));
  const slots = exp.expected.filter((s) => s.test === 'dls');
  const recs = [
    dls(slots[0], [[80.1, 0.08], [80.9, 0.09], [80.5, 0.08]], { experimentId: 'E4' }),
    dls(slots[1], [[82.0, 0.10], [82.4, 0.11], [81.8, 0.10]], { experimentId: 'E4' }),
    dls(slots[2], [[79.5, 0.07], [80.3, 0.08], [79.9, 0.07]], { experimentId: 'E4' }),
    dls(slots[3], [[81.0, 0.09], [81.6, 0.10], [81.2, 0.09]], { experimentId: 'E4' }),
    // the odd one: big, broad, and its runs disagree
    dls(slots[4], [[150, 0.22], [170, 0.26], [166, 0.25]], { experimentId: 'E4', kcps: 40 }),
  ];
  markDone(exp, recs);
  const inbox = [{ id: 'i1', sampleName: 'Sample 6', test: 'dls', values: { zave_nm: 84.0, pdi: 0.12, runs: [{ zave_nm: 84, pdi: 0.12 }] } }];
  const ev = evaluateImport({ records: recs, inbox, experiments: [exp], batches, qc, info: { samples: 7, imported: 5, inbox: 1 }, today: '2026-10-17' });

  const h = ev.headline;
  assert.equal(h.samples, 7); assert.equal(h.stored, 5); assert.equal(h.inbox, 1); assert.equal(h.skipped, 1);
  assert.equal(h.flagged, 1, 'only the odd sample');
  const size = h.byTest.dls.metrics.find((m) => m.key === 'zave_nm');
  assert.equal(size.n, 6);
  near(size.min, 79.9, 1e-9); near(size.max, 162, 1e-9);
  near(size.mean, (80.5 + 82.0666666666666667 + 79.9 + 81.2666666666666667 + 162 + 84) / 6, 1e-9);
  const pdi = h.byTest.dls.metrics.find((m) => m.key === 'pdi');
  near(pdi.min, 0.0733333333333333, 1e-9); near(pdi.max, 0.2433333333333333, 1e-9);

  const odd = ev.samples.find((s) => s.sampleName === slots[4].sampleName);
  assert.deepEqual(odd.flags.map((f) => f.kind).sort(), ['count', 'cv', 'limit', 'limit', 'outlier', 'outlier'].sort());
  assert.ok(odd.outliers.some((o) => o.metric === 'zave_nm' && o.z > 3.5));
  near(odd.metrics.zave_nm.sd, Math.sqrt(((150 - 162) ** 2 + (170 - 162) ** 2 + (166 - 162) ** 2) / 2), 1e-9);

  // the inbox row is evaluated with the rest but belongs to no experiment, and sorts last
  assert.equal(ev.samples.at(-1).source, 'inbox'); assert.equal(ev.samples.at(-1).experimentId, null);
  // samples in the order a person reads them
  assert.deepEqual(ev.samples.slice(0, 5).map((s) => s.sampleName), slots.map((s) => s.sampleName));

  assert.equal(ev.experiments.length, 1);
  const x = ev.experiments[0];
  assert.equal(x.id, 'E4'); assert.equal(x.type, 'comparison');
  const byTest = Object.fromEntries(x.byTest.map((t) => [t.test, t]));
  assert.deepEqual([byTest.dls.done, byTest.dls.total, byTest.dls.open, byTest.dls.fromImport], [5, 5, 0, 5]);
  assert.deepEqual([byTest.ee.done, byTest.ee.open], [0, 5]);
  assert.ok(byTest.ee.overdue > 0, 'made on the 12th, measured by the 13th: past due on the 17th');
  assert.equal(x.groups.length, 0, 'a comparison has no repeat structure to summarise');
});

test('DoE: the centre points give the pure error, once two of them are in', () => {
  const doe = { designType: 'full_factorial', model: 'interaction', centerPoints: 3, replicates: 1, seed: 7,
    factors: [{ name: 'FRR', low: 2, high: 4, applyTo: 'frr' }, { name: 'flow_rate', unit: 'mL/min', low: 60, high: 120, applyTo: 'tfr' }],
    responses: [{ name: 'particle_size_nm', goal: 'target', target: 80 }] };
  const { experiment: exp, batches } = buildExperiment({ type: 'doe', name: 'screen', startDate: '2026-10-12', compositionId: 1, doe, tests: ['dls', 'ee'] }, env('E3'));
  const centre = batches.filter((b) => b.doe.point_type === 'center');
  assert.equal(centre.length, 3);
  const slotOf = (b) => exp.expected.find((s) => s.batchId === b.id && s.test === 'dls');
  const centreValues = [[90, 0.10], [92, 0.12], [94, 0.11]];
  const recs = batches.map((b, i) => {
    const c = centre.indexOf(b);
    const [z, p] = c >= 0 ? centreValues[c] : [70 + 4 * i, 0.08 + 0.01 * i];
    return dls(slotOf(b), [[z - 0.5, p], [z + 0.5, p], [z, p]], { experimentId: 'E3' });
  });
  markDone(exp, recs);
  const ev = evaluateImport({ records: recs, experiments: [exp], batches, qc, info: { samples: recs.length, imported: recs.length, inbox: 0 } });
  const g = ev.experiments[0].groups.find((x) => x.kind === 'centre');
  assert.ok(g, 'a centre-point summary');
  assert.equal(g.planned, 3); assert.equal(g.measured, 3);
  const size = g.metrics.find((m) => m.key === 'zave_nm');
  near(size.mean, 92); near(size.sd, 2); near(size.cv, 100 * 2 / 92);
  const pdi = g.metrics.find((m) => m.key === 'pdi');
  near(pdi.mean, 0.11); near(pdi.sd, 0.01, 1e-12);
  assert.equal(ev.experiments[0].byTest.find((t) => t.test === 'ee').open, 7);

  // one centre point in so far: the group says how many, and no spread is made up
  const one = evaluateImport({ records: [recs[batches.indexOf(centre[0])]], experiments: [exp], batches, measurements: [recs[batches.indexOf(centre[0])]], qc });
  const g1 = one.experiments[0].groups[0];
  assert.equal(g1.measured, 1); assert.equal(g1.metrics[0].sd, null);
});

test('reference series: batch-to-batch spread, the latest result of each batch counting once', () => {
  const { experiment: exp, batches } = buildExperiment({ type: 'reference', name: 'ref', startDate: '2026-10-12', compositionId: 1, reference: { n: 3 }, tests: ['dls'] }, env('E1'));
  const slots = exp.expected;
  const old = dls(slots[0], [[120, 0.2], [120, 0.2]], { experimentId: 'E1' });
  const recs = [dls(slots[0], [[80, 0.1], [80, 0.1]], { experimentId: 'E1' }), dls(slots[1], [[84, 0.1], [84, 0.1]], { experimentId: 'E1' }), dls(slots[2], [[82, 0.1], [82, 0.1]], { experimentId: 'E1' })];
  markDone(exp, recs);
  const ev = evaluateImport({ records: recs, experiments: [exp], batches, measurements: [old, ...recs], qc });
  const g = ev.experiments[0].groups[0];
  assert.equal(g.kind, 'repeats'); assert.equal(g.measured, 3);
  const size = g.metrics.find((m) => m.key === 'zave_nm');
  near(size.mean, 82); near(size.sd, 2);
  assert.match(ev.experiments[0].byTest.map((t) => `${t.test} ${t.done}/${t.total}`).join(), /dls 3\/3/);
});

test('stability: by shelf and day, with the change since the first day', () => {
  const { experiment: exp, batches } = buildExperiment({ type: 'stability', name: 'st', startDate: '2026-10-01', compositionId: 1,
    stability: { formulations: [{ compositionId: 1 }, { compositionId: 2 }], conditions: ['4C', '25C'], timepoints: [0, 7, 14], tests: ['dls'] } }, env('E6'));
  const slot = (b, c, t) => exp.expected.find((s) => s.batchId === b && s.condition === c && s.timepoint === t && s.test === 'dls');
  const size = { 'E6-F1|4C': [80, 81, 82], 'E6-F2|4C': [90, 91, 92], 'E6-F1|25C': [80, 86, 94], 'E6-F2|25C': [90, 98, 110] };
  const recs = [];
  for (const [k, zs] of Object.entries(size)) {
    const [b, c] = k.split('|');
    // T14 still to come for the second formulation on the warm shelf
    [0, 7, 14].forEach((t, i) => { if (!(b === 'E6-F2' && c === '25C' && t === 14)) recs.push(dls(slot(b, c, t), [[zs[i], 0.1], [zs[i], 0.1]], { experimentId: 'E6' })); });
  }
  markDone(exp, recs);
  const ev = evaluateImport({ records: recs, experiments: [exp], batches, qc, today: '2026-10-17' });
  const g = ev.experiments[0].groups[0];
  assert.equal(g.kind, 'stability');
  assert.deepEqual(g.rows.map((r) => `${r.condition} T${r.timepoint} n${r.n}`), ['4C T0 n2', '4C T7 n2', '4C T14 n2', '25C T0 n2', '25C T7 n2', '25C T14 n1']);
  const warm7 = g.rows.find((r) => r.condition === '25C' && r.timepoint === 7);
  near(warm7.metrics.zave_nm.mean, 92); near(warm7.change.zave_nm, 92 - 85);
  assert.equal(g.rows.find((r) => r.condition === '4C' && r.timepoint === 0).change.zave_nm, null);
  // only F1 is in on day 14 at 25 °C: its change is against its own day 0 (94 - 80), not the two-arm mean (85)
  near(g.rows.find((r) => r.condition === '25C' && r.timepoint === 14).change.zave_nm, 14);
  assert.equal(g.lines.length, 4);
  assert.deepEqual(g.lines.find((l) => l.batchId === 'E6-F1' && l.condition === '25C').points.map((p) => [p.x, p.values.zave_nm.mean]), [[0, 80], [7, 86], [14, 94]]);
  assert.deepEqual(g.timepoints, [0, 7, 14]);
  const t = ev.experiments[0].byTest[0];
  assert.deepEqual([t.done, t.open, t.total], [11, 1, 12]);
  assert.equal(t.nextDue, exp.expected.find((s) => s.status === 'open').dueDate);
});

test('other tests are evaluated without being taught: zeta, EE, and anything with a number in it', () => {
  const z = [-4, -5, -3.5, -4.2, -4.8].map((v, i) => ({ id: `z${i}`, test: 'zeta', sampleName: `S${i}`, values: { zeta_mV: v } }));
  const ev = evaluateImport({ records: z, qc });
  assert.deepEqual(ev.tests, ['zeta']);
  assert.deepEqual(ev.metrics.zeta.map((m) => m.key), ['zeta_mV']);
  near(ev.headline.byTest.zeta.metrics[0].mean, -4.3);
  assert.equal(ev.headline.byTest.zeta.metrics[0].cv, null, 'no CV for a value that can be zero');
  assert.equal(replicate({ zeta_mV: -4, runs: [{ zeta_mV: -3 }, { zeta_mV: -5 }] }, 'zeta_mV').cv, null);
  assert.equal(ev.headline.flagged, 0);

  const ee = [{ id: 'e1', test: 'ee', sampleName: 'A', values: { ee_pct: 93.1 } }, { id: 'e2', test: 'ee', sampleName: 'B', values: { ee_pct: 70.2, runs: [{ ee_pct: 69 }, { ee_pct: 71.4 }] } }];
  const ev2 = evaluateImport({ records: ee, qc });
  assert.equal(ev2.headline.flagged, 1);
  assert.match(ev2.samples.find((s) => s.sampleName === 'B').flags[0].text, /below the 85 % limit/);
  near(ev2.samples.find((s) => s.sampleName === 'B').metrics.ee_pct.sd, Math.sqrt(2 * 1.2 ** 2), 1e-9);

  const odd = evaluateImport({ records: [{ id: 'n1', test: 'turbidity', sampleName: 'A', values: { ntu: 3.2 } }], qc });
  assert.deepEqual(odd.metrics.turbidity.map((m) => m.key), ['ntu']);
  assert.equal(odd.samples[0].metrics.ntu.mean, 3.2);

  const none = evaluateImport({ records: [], inbox: [], qc, info: { samples: 2, imported: 0, inbox: 0 } });
  assert.equal(none.headline.samples, 2); assert.equal(none.headline.skipped, 2); assert.deepEqual(none.samples, []);
});

test('experimentStatus on its own: an experiment nothing has come in for yet', () => {
  const { experiment: exp } = buildExperiment({ type: 'single', name: 's', startDate: '2026-10-12', compositionId: 1, tests: ['dls', 'ee'] }, env('E2'));
  const s = experimentStatus(exp, { today: '2026-10-12' });
  assert.equal(s.total, 2); assert.equal(s.open, 2); assert.equal(s.done, 0);
  assert.deepEqual(s.byTest.map((t) => t.test), ['dls', 'ee']);
  assert.equal(s.byTest[0].overdue, 0);
});
