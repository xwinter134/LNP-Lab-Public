import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExperiment } from '../app/calc/experiment.js';
import { DEFAULT_SETTINGS } from '../app/refdata.js';
import { experimentResults, resultsCsv, progressStage, cellOf, whereOf, describe, pooledRunSd, responseByKey, driftTrend, trendSummary, pText, aroundDay, stabilityFigureLine, predictionSummary } from '../app/calc/results.js';

const env = (id = 'E1') => ({ settings: DEFAULT_SETTINGS, takenFormulations: [], experimentId: id });
const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) < eps, `${msg} expected ${b}, got ${a}`);

let n = 0;
/** A DLS result as the importer stores it: the mean, and the replicate runs it came from. */
const dls = (batchId, runs, extra = {}) => ({ id: `m${++n}`, batchId, test: 'dls', stage: 'final', date: '2026-10-20',
  values: { zave_nm: runs.reduce((a, r) => a + r[0], 0) / runs.length, pdi: runs.reduce((a, r) => a + r[1], 0) / runs.length, runs: runs.map(([z, p]) => ({ zave_nm: z, pdi: p })) }, ...extra });
const ee = (batchId, v, extra = {}) => ({ id: `m${++n}`, batchId, test: 'ee', stage: 'final', date: '2026-10-20', values: { ee_pct: v }, ...extra });

test('a cell is the mean ± SD of the replicate runs, n and CV with it; without runs it is the value with n = 1', () => {
  const c = cellOf(dls('X', [[80, 0.1], [82, 0.12], [84, 0.11]]), responseByKey.zave);
  assert.equal(c.n, 3); close(c.mean, 82); close(c.sd, 2); close(c.cv, (2 / 82) * 100);
  assert.equal(c.basis, 'runs');
  const e = cellOf(ee('X', 93.5), responseByKey.ee);
  assert.equal(e.n, 1); assert.equal(e.mean, 93.5); assert.equal(e.sd, null); assert.equal(e.cv, null);
  assert.equal(cellOf(ee('X', 93.5), responseByKey.zave), null, 'a test that does not carry the response gives no cell');
  assert.deepEqual(describe([1, NaN, 3]).points, [1, 3]);
});

test('reference repeats: batch-to-batch mean, SD and CV of the batch means, with the pooled run SD beside it', () => {
  const { experiment, batches } = buildExperiment({ type: 'reference', name: 'r', startDate: '2026-10-20', compositionId: 1, reference: { n: 4 } }, env());
  const zs = [80, 84, 82, 86];
  const ms = batches.flatMap((b, i) => [dls(b.id, [[zs[i] - 1, 0.08], [zs[i], 0.09], [zs[i] + 1, 0.1]]), ee(b.id, 90 + i)]);
  const res = experimentResults(experiment, batches, ms, { qc: DEFAULT_SETTINGS.qc });
  assert.equal(res.rows.length, 4); assert.equal(res.measuredRows, 4);
  assert.deepEqual(res.responses.map((r) => r.key), ['zave', 'pdi', 'ee']);
  const z = res.stats.byResponse.zave;
  assert.equal(z.n, 4); close(z.mean, 83);
  const sdExpected = Math.sqrt(((80 - 83) ** 2 + (84 - 83) ** 2 + (82 - 83) ** 2 + (86 - 83) ** 2) / 3);
  close(z.sd, sdExpected); close(z.cv, (sdExpected / 83) * 100);
  close(z.run.sd, 1, 1e-9, 'every batch has runs ±1 around its mean, so the pooled run SD is 1');
  assert.equal(z.run.meanRuns, 3);
  assert.match(res.sentences[0], /Batch to batch, over 4 batches: Z-ave 83\.0 ± 2\.6 nm \(CV 3\.1 %\)/);
  assert.match(res.sentences.join(' '), /more than the measurement explains/);
  assert.match(res.sentences.join(' '), /inside the QC limits/);
});

test('reference repeats whose batches differ no more than the runs do are called as alike as the instrument can tell', () => {
  const { experiment, batches } = buildExperiment({ type: 'reference', name: 'r', startDate: '2026-10-20', compositionId: 1, reference: { n: 3 } }, env());
  const ms = batches.map((b, i) => dls(b.id, [[78, 0.1], [82 + i * 0.1, 0.1], [86, 0.1]]));
  const res = experimentResults(experiment, batches, ms);
  assert.match(res.sentences.join(' '), /as alike as this instrument can tell/);
});

test('comparison: per arm mean ± SD, the difference from the first arm, and the technical-replicate caveat', () => {
  const { experiment, batches } = buildExperiment({ type: 'comparison', name: 'c', startDate: '2026-10-20', compositionId: 1, comparison: { compositionIds: [1, 2] } }, env());
  const ms = [dls(batches[0].id, [[80, 0.08], [82, 0.1]]), dls(batches[1].id, [[90, 0.12], [92, 0.14]]), ee(batches[0].id, 94), ee(batches[1].id, 91)];
  const res = experimentResults(experiment, batches, ms, { qc: DEFAULT_SETTINGS.qc });
  const [a, b] = res.stats.arms;
  assert.equal(res.stats.kind, 'comparison');
  close(a.byResponse.zave.mean, 81); close(a.byResponse.zave.sd, Math.SQRT2); assert.equal(a.byResponse.zave.basis, 'runs');
  close(b.diff.zave.abs, 10); close(b.diff.zave.pct, (10 / 81) * 100);
  close(b.diff.ee.abs, -3);
  assert.deepEqual(a.diff, {}, 'the first arm is the reference, so it has no difference');
  assert.match(res.sentences[0], /#2 \(E1-F2\) against #1: Z-ave \+10\.0 nm \(\+12\.3 %\), PDI \+0\.040 \(\+44\.4 %\) and EE −3\.0 percentage points/);
  assert.match(res.caveat, /technical replicates/);
  assert.match(res.caveat, /not a test of batch-to-batch difference/);
});

test('comparison: the same recipe made twice is one arm, with its SD between batches', () => {
  const { experiment, batches } = buildExperiment({ type: 'comparison', name: 'c', startDate: '2026-10-20', compositionId: 1, comparison: { compositionIds: [1, 1, 2, 2] } }, env());
  const ms = batches.map((b, i) => dls(b.id, [[[80, 84, 90, 94][i], 0.1]]));
  const res = experimentResults(experiment, batches, ms);
  assert.equal(res.stats.arms.length, 2);
  const [a, b] = res.stats.arms;
  assert.equal(a.byResponse.zave.basis, 'batches'); assert.equal(a.byResponse.zave.n, 2); close(a.byResponse.zave.mean, 82);
  close(b.diff.zave.abs, 10);
  assert.match(res.caveat, /spread between its batches/);
});

test('stability: one row per formulation × condition × day, change from T0 absolute and in %', () => {
  const { experiment, batches } = buildExperiment({ type: 'stability', name: 's', startDate: '2026-10-20', compositionId: 1,
    stability: { formulations: [{ compositionId: 1 }, { compositionId: 2 }], conditions: ['4C', '25C'], timepoints: [0, 7, 14], tests: ['dls'] } }, env());
  const slot = (b, c, t) => experiment.expected.find((s) => s.batchId === b && s.condition === c && s.timepoint === t && s.test === 'dls');
  const at = (b, c, t, z, p) => { const s = slot(b, c, t); return dls(b, [[z - 0.5, p], [z + 0.5, p]], { slotId: s.id, stage: s.stage, condition: c, timepoint: t, sampleName: s.sampleName }); };
  const ms = [at('E1-F1', '4C', 0, 80, 0.08), at('E1-F1', '4C', 7, 82, 0.09), at('E1-F1', '25C', 0, 80, 0.08), at('E1-F1', '25C', 7, 88, 0.12),
    // no T0 at 25 °C for F2: the 4 °C T0 is the same sample before storage and serves as the baseline
    at('E1-F2', '4C', 0, 100, 0.1), at('E1-F2', '25C', 14, 110, 0.15)];
  const res = experimentResults(experiment, batches, ms);
  assert.equal(res.rows.length, 2 * 2 * 3);
  assert.equal(res.measuredRows, 6);
  const row = res.rows.find((r) => r.batchId === 'E1-F1' && r.condition === '25C' && r.timepoint === 7);
  close(row.cells.zave.mean, 88); close(row.change.zave.abs, 8); close(row.change.zave.pct, 10);
  close(row.change.pdi.abs, 0.04);
  const f2 = res.rows.find((r) => r.batchId === 'E1-F2' && r.condition === '25C' && r.timepoint === 14);
  close(f2.change.zave.abs, 10, 1e-9, 'baseline taken from the other shelf');
  assert.equal(res.stats.series.length, 4);
  assert.match(res.sentences.join(' '), /E1-F1 at 25 °C, day 7: Z-ave 80\.0 → 88\.0 nm \(\+10\.0 %\)/);
  assert.match(res.sentences.join(' '), /largest size change is E1-F1 at 25 °C: \+10\.0 % by day 7/);
  const csv = resultsCsv(res, { experimentId: 'E1' }).trim().split('\n');
  assert.equal(csv.length, 1 + 6, 'the export is the measured rows');
  assert.match(csv[0], /^experiment,formulation,label,composition,condition,day,Z-ave \(nm\) mean,Z-ave \(nm\) SD,Z-ave n,Z-ave CV %,Z-ave \(nm\) change from T0,Z-ave change from T0 %/);
  assert.ok(csv.includes('E1,E1-F1,arm 1,#1,25C,7,88,0.707,2,0.8,8,10,0.12,0,2,0,0.04,50'), csv.join('\n'));
});

test('stability: a result that reached its formulation without a slot is placed by its sample name', () => {
  const { experiment, batches } = buildExperiment({ type: 'stability', name: 's', startDate: '2026-10-20', compositionId: 1,
    stability: { formulations: [{ compositionId: 1 }], conditions: ['4C'], timepoints: [0], tests: ['dls'] } }, env());
  assert.deepEqual(whereOf({ sampleName: 'E1-F1_4C_T07', stage: 'T07' }), { timepoint: 7, condition: '4C' });
  const ms = [dls('E1-F1', [[80, 0.1]], { sampleName: 'E1-F1_4C_T00', stage: 'T00' }), dls('E1-F1', [[86, 0.1]], { sampleName: 'E1-F1_4C_T07', stage: 'T07' })];
  const res = experimentResults(experiment, batches, ms);
  assert.deepEqual(res.rows.map((r) => r.timepoint), [0, 7]);
  close(res.rows[1].change.zave.pct, 7.5);
});

test('stability: only day 0 measured says so instead of inventing a trend', () => {
  const { experiment, batches } = buildExperiment({ type: 'stability', name: 's', startDate: '2026-10-20', compositionId: 1,
    stability: { formulations: [{ compositionId: 1 }], conditions: ['4C'], timepoints: [0, 7], tests: ['dls'] } }, env());
  const res = experimentResults(experiment, batches, [dls('E1-F1', [[80, 0.1]], { condition: '4C', timepoint: 0, stage: 'T0' })]);
  assert.match(res.sentences[0], /Only day 0 is measured so far/);
});

test('OFAT: the response by level, lowest and highest named', () => {
  const { experiment, batches } = buildExperiment({ type: 'ofat', name: 'o', startDate: '2026-10-20', compositionId: 1, ofat: { factor: 'np', levels: [3, 6, 9] } }, env());
  const ms = [dls(batches[0].id, [[98, 0.2], [100, 0.2]]), dls(batches[1].id, [[80, 0.08]]), dls(batches[2].id, [[85, 0.1]]), ee(batches[0].id, 80), ee(batches[1].id, 95), ee(batches[2].id, 96)];
  const res = experimentResults(experiment, batches, ms, { qc: DEFAULT_SETTINGS.qc });
  assert.deepEqual(res.stats.levels.map((l) => l.level), [3, 6, 9]);
  assert.equal(res.stats.factorName, 'N/P ratio');
  close(res.stats.levels[0].byResponse.zave.mean, 99);
  assert.match(res.sentences.join(' '), /Z-ave is lowest at N\/P ratio 6 \(80\.0 nm\) and highest at N\/P ratio 3 \(99\.0 nm\)/);
  assert.match(res.sentences.join(' '), /Highest EE at N\/P ratio 9 \(96\.0 %\)/);
  assert.match(res.sentences.join(' '), /Outside the QC limits: E1-F1 EE 80\.0 % \(min 85\)/);
  assert.match(resultsCsv(res).split('\n')[0], /,level,/);
});

test('single: the values with their run SD; the final product wins over an in-process sample, the newest over an older result', () => {
  const { experiment, batches } = buildExperiment({ type: 'single', name: 'x', startDate: '2026-10-20', compositionId: 1 }, env('E2'));
  const ms = [
    dls('E2-F1', [[70, 0.3]], { stage: 'IPC4', date: '2026-10-22' }),
    dls('E2-F1', [[90, 0.1]], { date: '2026-10-20' }),
    dls('E2-F1', [[82, 0.08], [83, 0.09]], { date: '2026-10-21' }),
    dls('E9-F1', [[999, 0.9]]), // another experiment's formulation
  ];
  const res = experimentResults(experiment, batches, ms);
  close(res.rows[0].cells.zave.mean, 82.5);
  assert.equal(res.rows[0].cells.zave.n, 2);
  assert.match(res.sentences[0], /^E2-F1: Z-ave 82\.5 ± 0\.7 nm \(2 runs, CV 0\.9 %\) and PDI 0\.085 ± 0\.007 \(2 runs, CV 8\.3 %\)\.$/);
});

test('single with several formulations (an optimizer round): ranges, not a sentence per formulation', () => {
  const { experiment, batches } = buildExperiment({ type: 'single', name: 'x', startDate: '2026-10-20', compositionId: 1 }, env());
  const extra = ['E1-F2', 'E1-F3', 'E1-F4', 'E1-F5'].map((id) => ({ ...batches[0], id }));
  const all = [...batches, ...extra];
  const ms = all.map((b, i) => dls(b.id, [[90 - i * 3, 0.1]]));
  const res = experimentResults(experiment, all, ms);
  assert.equal(res.sentences[0], '5 formulations measured.');
  assert.equal(res.sentences[1], 'Z-ave from 78.0 nm (E1-F5) to 90.0 nm (E1-F1).');
});

test('nothing measured: no rows count as measured and no statistics are made up', () => {
  const { experiment, batches } = buildExperiment({ type: 'reference', name: 'r', startDate: '2026-10-20', compositionId: 1, reference: { n: 3 } }, env());
  const res = experimentResults(experiment, batches, []);
  assert.equal(res.measuredRows, 0); assert.equal(res.totalRows, 3);
  assert.deepEqual(res.responses, []); assert.equal(res.stats, null); assert.deepEqual(res.sentences, []);
});

test('the CSV quotes what needs quoting and leaves numbers plain', () => {
  const { experiment, batches } = buildExperiment({ type: 'single', name: 'x', startDate: '2026-10-20', compositionId: 1 }, env());
  batches[0].label = 'the "best", so far';
  const csv = resultsCsv(experimentResults(experiment, batches, [ee('E1-F1', 93.25)]), { experimentId: 'E1' });
  assert.equal(csv, 'experiment,formulation,label,composition,EE (%) mean,EE (%) SD,EE n,EE CV %\nE1,E1-F1,"the ""best"", so far",#1,93.25,,1,\n');
});

test('pooled run SD weights each sample by its degrees of freedom', () => {
  const p = pooledRunSd([{ n: 3, sd: 1 }, { n: 2, sd: 2 }, { n: 1, sd: null }, null]);
  close(p.sd, Math.sqrt((2 * 1 + 1 * 4) / 3)); close(p.meanRuns, 2.5);
  assert.equal(pooledRunSd([{ n: 1, sd: null }]), null);
});

test('progress stage follows the records: planned, in production, measuring, all measured', () => {
  const { experiment, batches } = buildExperiment({ type: 'reference', name: 'r', startDate: '2026-10-20', compositionId: 1, reference: { n: 2 }, tests: ['dls'] }, env());
  let s = progressStage(experiment, batches);
  assert.equal(s.stage, 'planned'); assert.equal(s.planned, 2); assert.equal(s.firstPlanned, 'E1-F1'); assert.equal(s.open, 2);
  batches[0].status = 'produced';
  assert.equal(progressStage(experiment, batches).stage, 'in production');
  batches[1].status = 'produced';
  s = progressStage(experiment, batches);
  assert.equal(s.stage, 'measuring'); assert.equal(s.nextDue, experiment.expected[0].dueDate);
  assert.equal(s.overdue, 0, 'without a date nothing is overdue');
  assert.equal(progressStage(experiment, batches, '2027-01-01').overdue, 2);
  experiment.expected.forEach((x) => { x.status = 'done'; });
  assert.equal(progressStage(experiment, batches).stage, 'all measured');
});

test('zeta potential gets mean ± SD but no CV, and a change that rounds to nothing carries no sign', () => {
  const { experiment, batches } = buildExperiment({ type: 'reference', name: 'r', startDate: '2026-10-20', compositionId: 1, reference: { n: 3 } }, env());
  const zeta = (b, v) => ({ id: `m${++n}`, batchId: b, test: 'zeta', stage: 'final', date: '2026-10-20', values: { zeta_mV: v, runs: [{ zeta_mV: v - 1 }, { zeta_mV: v + 1 }] } });
  const res = experimentResults(experiment, batches, [zeta('E1-F1', -0.4), zeta('E1-F2', -6.1), zeta('E1-F3', -3.3)]);
  assert.equal(res.rows[0].cells.zeta.cv, null, 'a CV of a value either side of zero means nothing');
  assert.ok(res.rows[0].cells.zeta.sd > 0);
  assert.equal(res.stats.byResponse.zeta.cv, null);
  assert.match(res.sentences[0], /Zeta −3\.3 ± 2\.9 mV\./);

  const s = buildExperiment({ type: 'stability', name: 's', startDate: '2026-10-20', compositionId: 1,
    stability: { formulations: [{ compositionId: 1 }], conditions: ['4C'], timepoints: [0, 7], tests: ['dls'] } }, env());
  const at = (t, p) => dls('E1-F1', [[80, p]], { condition: '4C', timepoint: t, stage: `T${t}` });
  const st = experimentResults(s.experiment, s.batches, [at(0, 0.0801), at(7, 0.0802)]);
  assert.match(st.sentences[0], /PDI 0\.080 → 0\.080 \(\+0\.1 %\)/);
  assert.match(st.sentences[0], /Z-ave 80\.0 → 80\.0 nm \(0\.0 %\)/);
});

test('an arm made twice with only one batch measured keeps the technical-replicate caveat', () => {
  const { experiment, batches } = buildExperiment({ type: 'comparison', name: 'c', startDate: '2026-10-20', compositionId: 1, comparison: { compositionIds: [1, 1, 2, 2] } }, env());
  // the second batch of composition #1 is not measured yet
  const ms = [dls(batches[0].id, [[80, 0.1], [82, 0.1], [84, 0.1]]), dls(batches[2].id, [[90, 0.1], [91, 0.1]]), dls(batches[3].id, [[92, 0.1], [93, 0.1]])];
  const res = experimentResults(experiment, batches, ms, { qc: DEFAULT_SETTINGS.qc });
  assert.match(res.caveat, /technical replicates/);
});

test('a QC limit cleared in Settings is left out of the sentence, not printed as null', () => {
  const { experiment, batches } = buildExperiment({ type: 'single', name: 's', startDate: '2026-10-20', compositionId: 1 }, env());
  const res = experimentResults(experiment, batches, [dls(batches[0].id, [[30, 0.1], [31, 0.1]])], { qc: { ...DEFAULT_SETTINGS.qc, zaveMin: null } });
  const text = res.sentences.join(' ');
  assert.doesNotMatch(text, /null/);
  assert.match(text, /Z-ave ≤ \d+ nm/);
});

/* ---------- stability: slope, interval, projection ---------- */

test('drift trend: the slope with its 95 % CI on n − 2 df, and the day the line meets the QC limit', () => {
  // the hand-worked line of stats.test.mjs: slope 168/490 nm/day, intercept 79.8, se √(1.6/3/490), t(3) = 3.182446
  const pts = [[0, 80], [7, 82], [14, 85], [21, 86], [28, 90]].map(([t, y]) => ({ t, y }));
  const tr = driftTrend(pts, { limit: 150 });
  const se = Math.sqrt(1.6 / 3 / 490), slope = 168 / 490;
  close(tr.ci[0], slope - 3.182446 * se, 1e-5); close(tr.ci[1], slope + 3.182446 * se, 1e-5);
  close(tr.ci[0], 0.237864, 1e-5); close(tr.ci[1], 0.447850, 1e-5);
  assert.equal(tr.timepoints, 5);
  // 150 nm at (150 − 79.8) / (168/490) = 204.75 days, inside 28 + 365
  assert.equal(tr.projection.status, 'ahead'); close(tr.projection.day, 204.75, 1e-9);
  assert.equal(driftTrend(pts, { limit: 150, horizonDays: 100 }).projection.status, 'beyond', '204.75 is past 28 + 100');
  const passed = driftTrend(pts, { limit: 85 }).projection;
  assert.equal(passed.status, 'passed'); close(passed.day, 5.2 / slope, 1e-9);
  assert.equal(driftTrend(pts.map((p) => ({ t: p.t, y: 200 - p.y })), { limit: 150 }).projection.status, 'away', 'a falling size does not reach an upper limit');
  assert.equal(driftTrend(pts, {}).projection, null, 'no limit, no projection');
  const two = driftTrend(pts.slice(0, 2), { limit: 150 });
  assert.equal(two.ci, null, 'two timepoints leave no degrees of freedom for an interval');
  assert.equal(two.projection, null, 'and are not carried forward');
  assert.deepEqual(trendSummary('zave', tr), { rate: '+0.34 nm/day', ci: '95 % CI 0.24–0.45', projection: '150 nm ≈ day 200' });
  assert.equal(trendSummary('zave', two).projection, 'a projection needs 3 timepoints');
});

test('a projected day is said as roughly as it is known; p values as Prism prints them', () => {
  assert.deepEqual([aroundDay(12.4), aroundDay(23.3), aroundDay(135.9), aroundDay(1234)], [12, 25, 140, 1200]);
  assert.deepEqual([pText(0.00002), pText(0.0024), pText(0.015), pText(0.41)], ['< 0.0001', '= 0.0024', '= 0.015', '= 0.41']);
});

test('stability: one sentence per shelf with the slope, its CI and the day it reaches the QC limit', () => {
  const { experiment, batches } = buildExperiment({ type: 'stability', name: 's', startDate: '2026-10-01', compositionId: 1,
    stability: { formulations: [{ compositionId: 1 }], conditions: ['4C', '25C'], timepoints: [0, 7, 14, 21], tests: ['dls'] } }, env());
  const slot = (c, t) => experiment.expected.find((s) => s.condition === c && s.timepoint === t && s.test === 'dls');
  const at = (c, t, z, p) => { const s = slot(c, t); return dls('E1-F1', [[z - 0.5, p], [z + 0.5, p]], { slotId: s.id, stage: s.stage, condition: c, timepoint: t, sampleName: s.sampleName }); };
  // 25 °C: Sxx 245, Sxy 126 → 0.514 nm/day from 80.1; residuals ±0.1, ±0.3 → se √(0.1/245), t(2) = 4.3027
  // 4 °C: a slope of 0.013 nm/day whose interval takes in zero
  const z25 = [80, 84, 87, 91], z4 = [80, 80.5, 80.2, 80.4];
  const ms = [0, 7, 14, 21].flatMap((t, i) => [at('25C', t, z25[i], 0.1 + 0.002 * i), at('4C', t, z4[i], 0.1)]);
  const res = experimentResults(experiment, batches, ms, { qc: DEFAULT_SETTINGS.qc });
  const s25 = res.stats.series.find((s) => s.condition === '25C').trend.zave;
  close(s25.slope, 126 / 245, 1e-12);
  close(s25.ci[1] - s25.slope, 4.302653 * Math.sqrt(0.1 / 245), 1e-5);
  close(s25.projection.day, (150 - 80.1) / (126 / 245), 1e-9);
  const text = res.sentences.join('\n');
  assert.match(text, /At 25 °C, E1-F1 grows 0\.51 nm\/day \(95 % CI 0\.43–0\.60\); at that rate it reaches 150 nm around day 140\./);
  assert.match(text, /At 4 °C, E1-F1 grows 0\.013 nm\/day \(95 % CI −0\.051 to 0\.076, so no clear trend\); at that rate it does not reach 150 nm within the next 365 days\./);
  assert.match(text, /Soonest to a QC limit: E1-F1 at 25 °C, Z-ave around day 140\./);
  assert.doesNotMatch(text, /day 21: Z-ave/, 'with three timepoints the slope replaces the change from T0');
  assert.match(res.caveat, /least-squares line through the day means[\s\S]*95 % confidence interval[\s\S]*n − 2/);
});

test('stability: PDI joins the sentence when it reaches its limit before the size does', () => {
  const { experiment, batches } = buildExperiment({ type: 'stability', name: 's', startDate: '2026-10-01', compositionId: 1,
    stability: { formulations: [{ compositionId: 1 }], conditions: ['25C'], timepoints: [0, 7, 14, 21], tests: ['dls'] } }, env());
  const z = [80, 84, 87, 91], p = [0.1, 0.131, 0.159, 0.19];
  const ms = [0, 7, 14, 21].map((t, i) => dls('E1-F1', [[z[i], p[i]]], { condition: '25C', timepoint: t, stage: `T${t}` }));
  const res = experimentResults(experiment, batches, ms, { qc: DEFAULT_SETTINGS.qc });
  assert.match(res.sentences[0], /reaches 150 nm around day 140\. Its PDI rises 0\.0043\/day \(95 % CI [\d.–]+\): at that rate it reaches a PDI of 0\.2 around day 25, before the size limit\./);
});

test('stability: a shelf without its own T0 starts its line from the T0 on another shelf', () => {
  const { experiment, batches } = buildExperiment({ type: 'stability', name: 's', startDate: '2026-10-01', compositionId: 1,
    stability: { formulations: [{ compositionId: 1 }], conditions: ['4C', '25C'], timepoints: [0, 7, 14], tests: ['dls'] } }, env());
  const ms = [dls('E1-F1', [[80, 0.1]], { condition: '4C', timepoint: 0, stage: 'T0' }),
    dls('E1-F1', [[84, 0.1]], { condition: '25C', timepoint: 7, stage: 'T7' }), dls('E1-F1', [[88, 0.1]], { condition: '25C', timepoint: 14, stage: 'T14' })];
  const res = experimentResults(experiment, batches, ms, { qc: DEFAULT_SETTINGS.qc });
  const tr = res.stats.series.find((s) => s.condition === '25C').trend.zave;
  assert.equal(tr.timepoints, 3); close(tr.slope, 8 / 14, 1e-12); close(tr.intercept, 80, 1e-9);
});

/* ---------- a test between arms ---------- */

test('comparison with three batches per arm: Welch t on the batch means, the arm that differs named', () => {
  const { experiment, batches } = buildExperiment({ type: 'comparison', name: 'c', startDate: '2026-10-20', compositionId: 1, comparison: { compositionIds: [1, 1, 1, 2, 2, 2] } }, env());
  const z = [80, 81, 82, 90, 92, 89], p = [0.10, 0.12, 0.11, 0.11, 0.10, 0.12];
  // the runs scatter ±1 nm around each batch mean: the test must use the batch means, not the six runs per arm
  const ms = batches.map((b, i) => dls(b.id, [[z[i] - 1, p[i]], [z[i] + 1, p[i]]]));
  const res = experimentResults(experiment, batches, ms, { qc: DEFAULT_SETTINGS.qc });
  const w = res.stats.tests.zave;
  assert.equal(w.kind, 'welch');
  // arm means 81 and 90.33, variances 1 and 2.33: se = √(1/3 + 2.33/3), df = 3.448 (Welch–Satterthwaite)
  close(w.t, (90 + 1 / 3 - 81) / Math.sqrt(1 / 3 + 7 / 9), 1e-9, 't');
  close(w.df, 3.448276, 1e-5, 'df');
  close(w.p, 0.0017241, 1e-6, 'p (by numerical integration of the t density)');
  close(res.stats.tests.pdi.p, 1, 1e-9, 'equal PDI means');
  assert.match(res.sentences.join(' '), /Welch’s t-test on the batch means \(n = 3 and 3 batches\): #2 differs from #1 in Z-ave \(t = 8\.85, df = 3\.4, p = 0\.0017\); not in PDI \(p = 1\.00\)\./);
  assert.match(res.caveat, /tests compare batch means/);
});

test('comparison with technical replicates only: the caveat stays and no p value is computed', () => {
  const { experiment, batches } = buildExperiment({ type: 'comparison', name: 'c', startDate: '2026-10-20', compositionId: 1, comparison: { compositionIds: [1, 2] } }, env());
  const ms = [dls(batches[0].id, [[80, 0.1], [81, 0.1], [82, 0.1]]), dls(batches[1].id, [[90, 0.1], [91, 0.1], [92, 0.1]])];
  const res = experimentResults(experiment, batches, ms);
  assert.equal(res.stats.tests, null);
  assert.doesNotMatch(res.sentences.join(' '), /p [=<]|Welch|ANOVA/);
  assert.match(res.caveat, /technical replicates/);
});

test('OFAT with every level made six times: one-way ANOVA on the batch means and the pairs that differ', () => {
  // the textbook ANOVA data as batch means: F(2, 15) = 9.26, p = 0.0024; by Holm–Šídák, level 3 differs from 6 and from 9
  const groups = [[6, 8, 4, 5, 3, 4], [8, 12, 9, 11, 6, 8], [13, 9, 11, 8, 7, 12]];
  const { experiment, batches } = buildExperiment({ type: 'ofat', name: 'o', startDate: '2026-10-20', compositionId: 1,
    ofat: { factor: 'np', levels: [3, 3, 3, 3, 3, 3, 6, 6, 6, 6, 6, 6, 9, 9, 9, 9, 9, 9] } }, env());
  const zs = groups.flat();
  const ms = batches.map((b, i) => dls(b.id, [[zs[i] - 0.5, 0.1], [zs[i] + 0.5, 0.1]]));
  const res = experimentResults(experiment, batches, ms);
  const a = res.stats.tests.zave;
  assert.equal(a.kind, 'anova'); assert.equal(a.df1, 2); assert.equal(a.df2, 15);
  close(a.p, 0.0023988, 1e-6);
  const text = res.sentences.join('\n');
  assert.match(text, /One-way ANOVA on the batch means \(3 levels\): Z-ave differs between the levels \(F\(2, 15\) = 9\.26, p = 0\.0024\)\./);
  assert.match(text, /Z-ave, pair by pair \(Holm–Šídák\): N\/P ratio 3 and N\/P ratio 6 differ \(p = 0\.011\) and N\/P ratio 3 and N\/P ratio 9 differ \(p = 0\.0030\); no other pair does\./);
  assert.match(res.caveat, /Every level was made more than once/);
});

/* ---------- the lines that stand for what a page folds away ---------- */

test('stability figures folded away: the span of each response, the shelves where it clearly drifts, and the QC limits', () => {
  const { experiment, batches } = buildExperiment({ type: 'stability', name: 's', startDate: '2026-10-01', compositionId: 1,
    stability: { formulations: [{ compositionId: 1 }], conditions: ['4C', '25C'], timepoints: [0, 7, 14, 21], tests: ['dls'] } }, env());
  const run = (pdi25, days = [0, 7, 14, 21]) => {
    const p4 = [0.1, 0.11, 0.1, 0.11];
    const ms = days.flatMap((t, i) => ['4C', '25C'].map((c) => dls('E1-F1', [[80 + i, c === '25C' ? pdi25[i] : p4[i]]], { condition: c, timepoint: t, stage: `T${t}` })));
    return experimentResults(experiment, batches, ms, { qc: DEFAULT_SETTINGS.qc });
  };
  // 25 °C rises by exactly 0.02 a week, so its interval leaves out zero; 4 °C wobbles, and its interval takes zero in
  const res = run([0.1, 0.12, 0.14, 0.16]);
  assert.equal(stabilityFigureLine(res, ['pdi'], DEFAULT_SETTINGS.qc), 'PDI 0.100–0.160, rising on E1-F1 at 25 °C; every day mean inside the QC limit for PDI (≤ 0.2).');
  assert.equal(stabilityFigureLine(res, ['pdi'], null), 'PDI 0.100–0.160, rising on E1-F1 at 25 °C.', 'no limits, nothing said about them');
  assert.equal(stabilityFigureLine(run([0.1, 0.11, 0.1, 0.11]), ['pdi'], DEFAULT_SETTINGS.qc), 'PDI 0.100–0.110, no clear drift on any shelf; every day mean inside the QC limit for PDI (≤ 0.2).');
  assert.equal(stabilityFigureLine(run([0.1, 0.17, 0.24, 0.31]), ['pdi'], DEFAULT_SETTINGS.qc), 'PDI 0.100–0.310, rising on E1-F1 at 25 °C; 2 day means outside the QC limit for PDI (≤ 0.2).');
  // two days cannot tell a drift from noise, so the line says nothing about one
  assert.equal(stabilityFigureLine(run([0.1, 0.12], [0, 7]), ['pdi'], DEFAULT_SETTINGS.qc), 'PDI 0.100–0.120; every day mean inside the QC limit for PDI (≤ 0.2).');
  assert.equal(stabilityFigureLine(res, ['ee'], DEFAULT_SETTINGS.qc), '', 'a response never measured gives no line');
});

test('the folded-figures line calls a drift from the same points as the slope in the table, a T0 borrowed from another shelf included', () => {
  const { experiment, batches } = buildExperiment({ type: 'stability', name: 's', startDate: '2026-10-01', compositionId: 1,
    stability: { formulations: [{ compositionId: 1 }], conditions: ['4C', '25C'], timepoints: [0, 7, 14, 21, 28], tests: ['dls'] } }, env());
  // T0 is measured once, on the 4 °C shelf, and 25 °C starts from it
  const run = (pdi25, days) => experimentResults(experiment, batches, [dls('E1-F1', [[80, 0.1]], { condition: '4C', timepoint: 0, stage: 'T0' }),
    ...days.map((t, i) => dls('E1-F1', [[85 + i, pdi25[i]]], { condition: '25C', timepoint: t, stage: `T${t}` }))], { qc: DEFAULT_SETTINGS.qc });
  const column = (res) => { const ci = res.stats.series.find((s) => s.condition === '25C').trend.pdi.ci; return ci[0] > 0 ? 'rising' : ci[1] < 0 ? 'falling' : 'no clear'; };
  // a jump after T0, then a slow fall: 25 °C's own four points fall, but its slope from T0 has an interval that takes in zero
  let res = run([0.150, 0.148, 0.146, 0.144], [7, 14, 21, 28]);
  assert.equal(column(res), 'no clear');
  assert.equal(stabilityFigureLine(res, ['pdi'], null), 'PDI 0.100–0.150, no clear drift on any shelf.');
  // two days on the shelf and the borrowed T0 make three: the table gives a slope, and the line says the same
  res = run([0.12, 0.14], [7, 14]);
  assert.equal(column(res), 'rising');
  assert.equal(stabilityFigureLine(res, ['pdi'], null), 'PDI 0.100–0.140, rising on E1-F1 at 25 °C.');
  // the borrowed T0 is in the fit only: it counts once against the limit, as the 4 °C day mean it is
  assert.equal(stabilityFigureLine(res, ['pdi'], { ...DEFAULT_SETTINGS.qc, pdiMax: 0.11 }), 'PDI 0.100–0.140, rising on E1-F1 at 25 °C; 2 day means outside the QC limit for PDI (≤ 0.11).');
});

test('the folded-figures line names the QC limits it checked: none once they are cleared, and never Z-ave, which it does not count', () => {
  const { experiment, batches } = buildExperiment({ type: 'stability', name: 's', startDate: '2026-10-01', compositionId: 1,
    stability: { formulations: [{ compositionId: 1 }], conditions: ['4C'], timepoints: [0, 7, 14], tests: ['dls', 'ee'] } }, env());
  const ms = (pdi) => [0, 7, 14].flatMap((t, i) => [dls('E1-F1', [[[120, 160, 190][i], pdi[i]]], { condition: '4C', timepoint: t, stage: `T${t}` }),
    ee('E1-F1', [92, 90, 88][i], { condition: '4C', timepoint: t, stage: `T${t}` })]);
  const off = { ...DEFAULT_SETTINGS.qc, pdiMax: null, eeMin: null };
  // a PDI of 0.35 with its limit cleared: nothing was checked, so nothing is said about QC
  assert.equal(stabilityFigureLine(experimentResults(experiment, batches, ms([0.1, 0.25, 0.35]), { qc: off }), ['pdi', 'ee'], off),
    'PDI 0.100–0.350, no clear drift on any shelf; EE 88.0–92.0 %, falling on E1-F1 at 4 °C.');
  // Z-ave at 160 and 190 nm, over its 150 nm limit, is not among the day means this line vouches for
  const res = experimentResults(experiment, batches, ms([0.1, 0.1, 0.1]), { qc: DEFAULT_SETTINGS.qc });
  assert.equal(stabilityFigureLine(res, ['pdi', 'ee'], DEFAULT_SETTINGS.qc),
    'PDI 0.100, no clear drift on any shelf; EE 88.0–92.0 %, falling on E1-F1 at 4 °C; every day mean inside the QC limits for PDI (≤ 0.2) and EE (≥ 85 %).');
  // one limit cleared: only the other is named
  assert.equal(stabilityFigureLine(res, ['pdi', 'ee'], { ...DEFAULT_SETTINGS.qc, eeMin: null }),
    'PDI 0.100, no clear drift on any shelf; EE 88.0–92.0 %, falling on E1-F1 at 4 °C; every day mean inside the QC limit for PDI (≤ 0.2).');
});

test('an optimizer round in a line: how many results fell inside the 95 % interval, and which way the others missed', () => {
  // A run stored since cycle 5 carries the interval one batch should fall in, with the measurement noise in it.
  const item = (batchId, label, mean, sd, measured) => ({ batchId, label, mean, sd, noise: sd * 0.8, measured });
  // inside means within 1.96 SD of the prediction: 80 ± 1.96 × 2 takes in 83.9 and leaves out 84
  const a = predictionSummary([item('E7-F1', 'Z-ave', 80, 2, 83.9), item('E7-F2', 'Z-ave', 80, 2, 84), item('E7-F2', 'EE', 91, 1, 94), item('E7-F3', 'EE', 91, 1, 95), item('E7-F3', 'PDI', 0.1, 0.02, null)]);
  assert.equal(a.total, 5); assert.equal(a.measured, 4); assert.equal(a.inside, 1);
  assert.equal(a.sentence, '1 of 4 measured values fell inside the model’s 95 % interval; 1 still to measure. Outside it: Z-ave on E7-F2; EE on E7-F2 and E7-F3, all higher than predicted.');
  const b = predictionSummary([item('E7-F1', 'Z-ave', 80, 2, 70), item('E7-F2', 'EE', 91, 1, 95)]);
  assert.equal(b.sentence, 'None of the 2 measured values fell inside the model’s 95 % interval. Outside it: Z-ave on E7-F1 (lower than predicted); EE on E7-F2 (higher than predicted).');
  assert.equal(predictionSummary([item('E7-F1', 'Z-ave', 80, 2, 81), item('E7-F1', 'PDI', 0.1, 0.02, 0.11)]).sentence, 'All 2 measured values fell inside the model’s 95 % interval.');
  assert.equal(predictionSummary([item('E7-F1', 'Z-ave', 80, 2, null), item('E7-F2', 'Z-ave', 80, 2, null)]).sentence, 'Nothing measured yet: the predictions for 2 runs wait for their results.');
  assert.equal(predictionSummary([]).sentence, '', 'no prediction, no line');

  // One stored before carries the surface's uncertainty about the mean alone, which a single batch misses about
  // half the time with the model right. Its noise was not kept, so the line says which interval it is.
  const before = (...a) => { const { noise, ...x } = item(...a); return x; };
  assert.equal(predictionSummary([before('E7-F1', 'Z-ave', 80, 2, 81), before('E7-F1', 'PDI', 0.1, 0.02, 0.11)]).sentence,
    'All 2 measured values fell inside the model’s 95 % interval for the mean.');
  assert.equal(predictionSummary([before('E7-F1', 'Z-ave', 80, 2, 70), before('E7-F2', 'EE', 91, 1, 91.5), before('E7-F3', 'EE', 91, 1, null)]).sentence,
    '1 of 2 measured values fell inside the model’s 95 % interval for the mean, which leaves out the scatter between batches, so a single result can fall outside it even when the model is right; 1 still to measure. Outside it: Z-ave on E7-F1, lower than predicted.');
});
