import test from 'node:test';
import assert from 'node:assert/strict';
import { insightSummary, matchedEffect, drift, batchSetting, settingKey, repeatedSettings } from '../app/calc/insights.js';
import { controlLimits, ols } from '../app/calc/stats.js';
import { rng, measure } from './usability/lab.mjs';

/** A setting as batchSetting gives it, from a short name: batches with the same name were made the same way. */
const at = (name) => ({ recipe: '#1', change: '', process: name, stage: { dls: '', ee: '', zeta: '' } });
/** Batches in time order: [value, group, setting] triples, numbered E1-F1, E1-F2 … */
const batches = (rows, key = 'stockId', response = 'zave_nm') => rows.map(([v, g, s = 'S1'], i) => ({ batchId: `E1-F${i + 1}`, [response]: v, [key]: g, setting: at(s) }));
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} is not ${b}`);

test('a lot is compared only where both lots ran the same setting, against the scatter of batches made the same way', () => {
  // S1: both lots, twice each. S2: a design corner, one batch. S3: a second setting Stock-001 repeated.
  const rows = batches([[80, 'Stock-001', 'S1'], [82, 'Stock-001', 'S1'], [85, 'Stock-002', 'S1'], [87, 'Stock-002', 'S1'],
    [60, 'Stock-001', 'S2'], [100, 'Stock-001', 'S3'], [104, 'Stock-001', 'S3']]);
  const e = matchedEffect(rows, 'zave_nm', 'stockId');
  assert.equal(e.kind, 'effect');
  assert.equal(e.hi.g, 'Stock-002');
  assert.deepEqual([e.hi.n, e.lo.n, e.settings], [2, 2, 1]);
  near(e.diff, 5);                      // 86 − 81, at S1 only: the corner and S3 say nothing about the lots
  near(e.sd, 2);                        // within-cell sums of squares 2 + 2 + 8 on 3 df
  near(e.se, 2);                        // 2 / √(2·2/4)
  near(e.ci[0], 5 - 3.1824463052836593 * 2, 1e-6);
  assert.equal(e.verdict, 'few');       // the interval, ±6.4 nm, is wider than the batch-to-batch SD
  // Every Stock-001 batch together spreads over 44 nm; that is the design, not the noise.
  const s = insightSummary(rows, { response: 'zave_nm', colorBy: 'stockId' }).sentences;
  assert.equal(s[0], 'Stock-002 has 2 batches at a setting Stock-001 also ran: size 5.0 nm larger (n 2 vs 2), too few to tell (95 % CI −1.4 to 11.4 nm).');
});

test('a difference the interval sets apart from zero is a finding, quoted with its interval and the batch-to-batch SD', () => {
  const rows = batches([[80, 'Stock-001'], [81, 'Stock-001'], [79, 'Stock-001'], [80, 'Stock-001'],
    [84, 'Stock-002'], [85, 'Stock-002'], [83, 'Stock-002'], [84, 'Stock-002']]);
  const e = matchedEffect(rows, 'zave_nm', 'stockId');
  near(e.diff, 4);
  near(e.sd, Math.sqrt(4 / 6));          // sums of squares 2 + 2 on 3 + 3 df
  near(e.se, Math.sqrt(4 / 6) / Math.sqrt(2));
  assert.equal(e.verdict, 'clear');
  const s = insightSummary(rows, { response: 'zave_nm', colorBy: 'stockId' }).sentences;
  assert.equal(s[0], 'At the same settings, Stock-002 batches are 4.0 nm larger than Stock-001 (n 4 vs 4; 95 % CI 2.6 to 5.4 nm), about 4.9 × the batch-to-batch SD of 0.8 nm.');
});

test('"within the noise" only once the whole interval lies within one batch-to-batch SD of zero', () => {
  const lots = (shift) => batches([...Array.from({ length: 12 }, (_, i) => [i % 2 ? 82 : 80, 'Stock-001']),
    ...Array.from({ length: 12 }, (_, i) => [(i % 2 ? 82 : 80) + shift, 'Stock-002'])]);
  const half = 2.073873067904125 * Math.sqrt(24 / 22) / Math.sqrt(6);   // t(22) · SD · √(1/12 + 1/12)
  const e = matchedEffect(lots(0.1), 'zave_nm', 'stockId');
  near(e.sd, Math.sqrt(24 / 22));
  near(e.ci[1], 0.1 + half, 1e-6);
  assert.equal(e.verdict, 'noise');      // the interval reaches 1.0 nm, inside the SD of 1.04 nm
  assert.equal(insightSummary(lots(0.1), { colorBy: 'stockId' }).sentences[0],
    'At the same settings, Stock-002 batches are 0.1 nm larger than Stock-001 (n 12 vs 12; 95 % CI −0.8 to 1.0 nm): within the batch-to-batch noise (SD 1.0 nm).');
  // including zero is not enough: a shift of half an SD might hide inside an interval reaching 1.4 nm
  assert.equal(matchedEffect(lots(0.5), 'zave_nm', 'stockId').verdict, 'few');
});

test('over several shared settings the difference is the least-squares group effect with the setting as a block', () => {
  const rows = batches([[10, 'A', 'S1'], [12, 'A', 'S1'], [15, 'B', 'S1'], [20, 'A', 'S2'], [26, 'B', 'S2'], [28, 'B', 'S2']]);
  const e = matchedEffect(rows, 'zave_nm', 'stockId');
  // by hand: weights 2·1/3 at both settings, differences 4 and 7
  near(e.diff, 5.5);
  // and the same number from an ordinary least-squares fit: intercept, a dummy for S2, a dummy for B
  const fit = ols(rows.map((r) => [1, r.setting.process === 'S2' ? 1 : 0, r.stockId === 'B' ? 1 : 0]), rows.map((r) => r.zave_nm));
  near(fit.beta[2], e.diff);
  near(e.sd, Math.sqrt(2)); near(e.se, Math.sqrt(2) / Math.sqrt(4 / 3));
  assert.equal(e.verdict, 'clear');
  assert.equal(insightSummary(rows, { colorBy: 'stockId' }).sentences[0],
    'At the same settings, B batches are 5.5 nm larger than A (n 3 vs 3 over 2 settings both ran; 95 % CI 0.2 to 10.8 nm), about 3.9 × the batch-to-batch SD of 1.4 nm.');
});

test('with three lots the clearest pair is reported, its interval widened for the three pairs it was picked from', () => {
  const rows = batches([[80, 'A'], [82, 'A'], [84, 'B'], [86, 'B'], [81, 'C'], [83, 'C']]);
  const e = matchedEffect(rows, 'zave_nm', 'stockId');
  assert.deepEqual([e.hi.g, e.lo.g, e.pairs], ['B', 'A', 3]);
  // Šidák: each of three intervals at 1 − 0.95^(1/3), t(3) = 4.83 rather than 3.18
  near(e.ci[1] - e.diff, 4.826461527880388 * Math.SQRT2, 1e-6);
  assert.equal(insightSummary(rows, { colorBy: 'stockId' }).sentences[0],
    'Of 3 stock lots, B has 2 batches at a setting A also ran: size 4.0 nm larger (n 2 vs 2), too few to tell (95 % CI −2.8 to 10.8 nm).');
});

test('lots never made at the same settings, or never repeated, are said to be beyond telling', () => {
  const apart = insightSummary(batches([[80, 'Stock-001', 'S1'], [82, 'Stock-001', 'S1'], [95, 'Stock-002', 'S2'], [97, 'Stock-002', 'S2']]), { colorBy: 'stockId' }).sentences[0];
  assert.equal(apart, 'Stock-001 and Stock-002 batches were never made at the same settings, so a difference between them cannot be told apart from what their settings do.');
  const three = insightSummary(batches([[80, 'A', 'S1'], [90, 'B', 'S2'], [100, 'C', 'S3']]), { colorBy: 'stockId' }).sentences[0];
  assert.match(three, /^No two of the 3 stock lots have batches made at the same settings/);
  const once = batches([[80, 'A', 'S1'], [84, 'B', 'S1'], [90, 'A', 'S2'], [93, 'B', 'S2']]);
  const e = matchedEffect(once, 'zave_nm', 'stockId');
  near(e.diff, 3.5);
  assert.equal(e.sd, null);
  assert.equal(insightSummary(once, { colorBy: 'stockId' }).sentences[0],
    'B has 2 batches at 2 settings A also ran: size 3.5 nm larger (n 2 vs 2), too few to tell: no setting was made twice with one stock lot, so there is no batch-to-batch SD to judge it by.');
});

test('one group, or no group recorded, is said rather than compared', () => {
  const one = insightSummary(batches([[80, 'Stock-001'], [81, 'Stock-001'], [82, 'Stock-001']]), { colorBy: 'stockId' }).sentences[0];
  assert.equal(one, 'All 3 batches share one stock lot (Stock-001), so there is no stock lot effect to see.');
  const none = insightSummary(batches([[80, ''], [81, ''], [82, '']], 'operator'), { colorBy: 'operator' }).sentences[0];
  assert.equal(none, 'No batch in this view has an operator recorded, so operators cannot be compared.');
  // the batch with no composition is a mix, not a group; by composition, only the process has to match
  const comps = insightSummary(batches([[80, 1], [84, 1], [81, 2], [83.5, 2], [90, null]], 'compositionId'), { colorBy: 'compositionId' }).sentences[0];
  assert.match(comps, /^#2 has 2 batches at a setting #1 also ran: size 0\.3 nm larger \(n 2 vs 2\), too few to tell \(95 % CI −9\.9 to 10\.4 nm\)\.$/);
});

test('the simulated lab: a +4 nm lot shift hidden by a CCD is found at matched settings', () => {
  // The session's lab (tests/usability/lab.mjs): an 18-run face-centred CCD on Stock-001, and repeats of the
  // default recipe on both lots. Truth: Stock-002 makes particles 4 nm larger; batch-to-batch noise 2.5 nm.
  const ccd = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) ccd.push([a, b, c]);
  for (let i = 0; i < 3; i++) { const p = [0, 0, 0]; p[i] = -1; ccd.push([...p]); p[i] = 1; ccd.push(p); }
  for (let i = 0; i < 4; i++) ccd.push([0, 0, 0]);
  const real = ([a, b, c]) => ({ frr: 3 + a, tfr: 90 + 30 * b, peg: 1.75 + 0.75 * c, np: 6 });
  const lab = (seed, repeats) => {
    const r = rng(seed), rows = [];
    for (const x of ccd) { const p = real(x); rows.push({ zave_nm: measure(p, r).zave_nm, stockId: 'Stock-001', setting: at(`FRR ${p.frr} · flow ${p.tfr} · PEG ${p.peg}`) }); }
    for (const lot of ['Stock-001', 'Stock-002']) for (let i = 0; i < repeats; i++) {
      const p = { frr: 3, tfr: 112.5, np: 6, peg: 1.5, lotShift_nm: lot === 'Stock-002' ? 4 : 0 };
      rows.push({ zave_nm: measure(p, r).zave_nm, stockId: lot, setting: at('reference') });
    }
    return rows;
  };
  // The old yardstick, the spread of every Stock-001 batch, is the design's: several times the true noise.
  const rows = lab(20261027, 6);
  const all001 = rows.filter((r) => r.stockId === 'Stock-001').map((r) => r.zave_nm);
  const spread = Math.sqrt(all001.reduce((s, v, _, a) => s + (v - a.reduce((x, y) => x + y, 0) / a.length) ** 2, 0) / (all001.length - 1));
  const e = matchedEffect(rows, 'zave_nm', 'stockId');
  assert.ok(spread > 4 * e.sd, `the design spread ${spread} against the batch-to-batch SD ${e.sd}`);
  assert.ok(e.sd > 1.5 && e.sd < 4, `batch-to-batch SD ${e.sd}, truth 2.5 nm (plus the instrument's own)`);
  assert.ok(e.ci[0] < 4 && e.ci[1] > 4, `the interval ${e.ci} should hold the true shift`);
  // Over many labs the 95 % interval holds the true +4 nm about 95 times in 100, and with six repeats a lot
  // the shift is found more often than not. Neither the session's two repeats a lot nor ten ever call it noise.
  let covered = 0, found = 0, called = 0;
  const N = 300;
  for (let seed = 1; seed <= N; seed++) {
    const x = matchedEffect(lab(seed * 7919, 6), 'zave_nm', 'stockId');
    const [lo, hi] = x.hi.g === 'Stock-002' ? x.ci : [-x.ci[1], -x.ci[0]];
    if (lo < 4 && 4 < hi) covered++;
    if (lo > 0) found++;
    for (const n of [2, 10]) if (matchedEffect(lab(seed * 7919, n), 'zave_nm', 'stockId').verdict === 'noise') called++;
  }
  assert.ok(covered / N > 0.92 && covered / N < 0.98, `coverage ${covered}/${N}`);
  assert.ok(found / N > 0.6, `found in ${found}/${N}`);
  assert.equal(called, 0, 'a 4 nm shift is never put down to noise');
});

test('the setting a batch was made at: recipe, change, process; a lot\'s own molarity only when it was varied', () => {
  const plan = (o = {}) => ({ rna: { np: null, working_mg_mL: 0.4, ...o.rna }, mixing: { frr: 3, totalFlow: 112.5, quenchFactor: 2, lipidStock_mM: 50, ...o.mixing }, factors: o.factors || {}, ...(o.ov ? { compositionOverride: o.ov } : {}) });
  const ref = batchSetting({ compositionId: 1, plan: plan() });
  assert.equal(settingKey(ref), '#1 · FRR 3 · flow 112.5 mL/min · quench 2 · RNA 0.4 mg/mL');
  // another lot writes its own measured molarity into the plan, and is still the same setting
  assert.equal(settingKey(batchSetting({ compositionId: 1, plan: plan({ mixing: { lipidStock_mM: 47.38 } }) })), settingKey(ref));
  // unless the experiment varied it
  const varied = batchSetting({ compositionId: 1, plan: plan({ factors: { lipid_mM: 30 }, mixing: { lipidStock_mM: 30 } }) });
  assert.equal(settingKey(varied), '#1 · FRR 3 · flow 112.5 mL/min · quench 2 · RNA 0.4 mg/mL · lipid 30 mM');
  // a DoE run: the PEG change, an N/P target, a factor recorded but not applied, and no float noise
  const exp = { design: { doe: { spec: { factors: [{ name: 'FRR', applyTo: 'frr' }, { name: 'temp', unit: '°C', applyTo: null }] } } } };
  const run = batchSetting({ compositionId: 1, plan: plan({ ov: { peg_pct: 1.75 }, rna: { np: 6 }, mixing: { frr: 2.9999999999 }, factors: { FRR: 3, temp: 25 } }) }, exp);
  assert.equal(settingKey(run), '#1 with PEG 1.75 mol% · FRR 3 · flow 112.5 mL/min · N/P 6 · quench 2 · RNA 0.4 mg/mL · temp 25 °C');
  // compared by composition, the composition is the group, so only what was done to it counts
  assert.equal(settingKey(run, { colorBy: 'compositionId' }), 'with PEG 1.75 mol% · FRR 3 · flow 112.5 mL/min · N/P 6 · quench 2 · RNA 0.4 mg/mL · temp 25 °C');
  // a stability pull is not a repeat of the fresh product; day 0 is
  const pulled = batchSetting({ compositionId: 1, plan: plan() }, null, { dls: { stage: 'T28', condition: '25C' }, ee: { stage: 'T0' } });
  assert.equal(settingKey(pulled), `${settingKey(ref)} · T28 25C`);
  assert.equal(settingKey(pulled, { response: 'ee_pct' }), settingKey(ref));
  // a blend names its lipids
  assert.equal(batchSetting({ compositionId: 2, plan: plan({ ov: { mol_pct: { DSPC: 10, 'DLin-MC3-DMA': 50 } } }) }).change, 'DLin-MC3-DMA 50 / DSPC 10 mol%');
});

test('the settings made more than once, most-run first: what the control chart shows by default', () => {
  const rows = batches([[80, 'A', 'ref'], [90, 'A', 'corner'], [81, 'A', 'ref'], [70, 'A', 'centre'], [71, 'A', 'centre'], [82, 'B', 'ref']]);
  const r = repeatedSettings(rows, 'zave_nm');
  assert.deepEqual(r.map((x) => [x.key, x.n]), [['#1 · ref', 3], ['#1 · centre', 2]]);
  assert.deepEqual(r[0].rows.map((x) => x.batchId), ['E1-F1', 'E1-F3', 'E1-F6']);
  // a reference experiment's setting comes first, even when a design's centre points were run more often
  const withRef = rows.map((x) => (x.setting.process === 'centre' ? x : { ...x, experimentType: 'reference' }))
    .concat(batches([[72, 'A', 'centre'], [70.5, 'A', 'centre']]));
  assert.deepEqual(repeatedSettings(withRef, 'zave_nm').map((x) => [x.key, x.n, x.reference]), [['#1 · ref', 3, true], ['#1 · centre', 4, false]]);
});

test('drift and the control limits are read off the batches on the chart', () => {
  const steady = [80, 81, 82, 79, 80, 81, 80, 79, 81, 80];
  const chart = batches([...steady, 86, 87, 85, 88, 86].map((v) => [v, 'Stock-001']));
  // a design corner in view, off the chart, moves neither sentence
  const rows = [...chart, { batchId: 'E9-F1', zave_nm: 140, stockId: 'Stock-001', setting: at('corner') }];
  const s = insightSummary(rows, { response: 'zave_nm', chart }).sentences;
  assert.equal(s[1], 'The latest 5 batches on the chart drift up: 6.1 nm larger than the 10 before them, more than batch-to-batch scatter explains.');
  const flat = insightSummary(batches([...steady, 80, 81, 79, 80, 81].map((v) => [v, 'Stock-001'])), { response: 'zave_nm' }).sentences;
  assert.equal(flat[1], 'No drift: the latest 5 batches on the chart are within 0.1 nm of the 10 before them.');
  assert.equal(drift([1, 2, 3, 4, 5, 6, 7]).enough, false);
  const few = insightSummary(batches([[80, 'A'], [81, 'B'], [82, 'C'], [80, 'A']]), { response: 'zave_nm' }).sentences;
  assert.equal(few[1], 'Not enough batches on the chart to say whether the latest drift: 4 so far, and it takes 8.');
});

test('points outside the control limits are counted and named; one in twenty is what chance gives', () => {
  const base = Array.from({ length: 20 }, (_, i) => 80 + (i % 2 ? 1 : -1));
  const rows = batches([...base, 95, 64].map((v) => [v, 'Stock-001']));
  const lim = controlLimits(rows.map((r) => r.zave_nm));
  const r = insightSummary(rows, { response: 'zave_nm', limits: lim });
  assert.deepEqual(r.outside.map((x) => x.batchId), ['E1-F21', 'E1-F22']);
  assert.match(r.sentences[2], /^2 of 22 points on the chart sit outside the control limits \(77\.9–82\.1 nm\): E1-F21 \(95\.0\), E1-F22 \(64\.0\)\.$/);
  const one = insightSummary(batches([...base, 95].map((v) => [v, 'Stock-001'])), { response: 'zave_nm' });
  assert.match(one.sentences[2], /^1 of 21 points on the chart sits outside the control limits \(77\.9–82\.1 nm\), about what chance alone gives at ± 2 SD: E1-F21 \(95\.0\)\.$/);
  const inside = insightSummary(batches(base.map((v) => [v, 'Stock-001'])), { response: 'zave_nm' });
  assert.match(inside.sentences[2], /^All 20 points on the chart sit inside the control limits/);
});

test('each response is spoken of in its own words and decimals', () => {
  const pdi = insightSummary(batches([[0.08, 'A'], [0.11, 'B'], [0.09, 'A'], [0.12, 'B']], 'stockId', 'pdi'), { response: 'pdi' }).sentences[0];
  assert.match(pdi, /^B has 2 batches at a setting A also ran: PDI 0\.030 higher \(n 2 vs 2\), too few to tell \(95 % CI 0\.000 to 0\.060\)\.$/);
  const ee = insightSummary(batches([[93, 'A'], [90, 'B'], [94, 'A'], [91, 'B']], 'stockId', 'ee_pct'), { response: 'ee_pct' }).sentences;
  assert.match(ee[0], /^A has 2 batches at a setting B also ran: EE 3\.0 points higher .*points\)\.$/);
  assert.match(ee[2], /control limits \([\d.]+–[\d.]+ %\)/);
  // a difference below the response's decimals keeps one significant figure instead of reading 0.000
  const tiny = insightSummary(batches([[0.0801, 'A'], [0.0803, 'B'], [0.0803, 'A'], [0.0805, 'B']], 'stockId', 'pdi'), { response: 'pdi' }).sentences[0];
  assert.match(tiny, /PDI 0\.0002 higher/);
  assert.equal(insightSummary([], { response: 'ee_pct' }).sentences[0], 'Not enough batches to say yet: none with an EE result in this view, and it takes three.');
});
