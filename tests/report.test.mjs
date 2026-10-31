// The printed experiment report (app/ui/report.js) and the print-ready charts it carries (charts.js printSvg).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The demo lab is seeded through the store, which is localStorage; node has none, so give it one first.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  get length() { return mem.size; },
  key: (i) => [...mem.keys()][i],
};
const { buildExperiment } = await import('../app/calc/experiment.js');
const { DEFAULT_SETTINGS, getRef, getSettings } = await import('../app/refdata.js');
const { experimentReport, designFits } = await import('../app/ui/report.js');
const { printSvg, PRINT_COLOURS, barChart } = await import('../app/ui/charts.js');
const { paretoSvg } = await import('../app/ui/doeplots.js');
const { Store } = await import('../app/store.js');
const { seedDemo, DEMO_NS } = await import('../app/demo.js');

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

/** Reference data as the screens see it: the shipped JSON, plus whatever the "store" adds. */
function refWith(extra = {}) {
  const data = {};
  for (const f of ['lipids', 'compositions', 'buffers_catalog', 'tff_modules', 'materials', 'pka', 'reagents', 'devices']) data[f] = JSON.parse(read(`app/data/${f}.json`));
  data.lipidByKey = Object.fromEntries(data.lipids.map((l) => [l.key, l]));
  data.compositionById = Object.fromEntries(data.compositions.map((c) => [c.id, c]));
  return getRef({ data, store: { all: (k) => extra[k] || [], get: () => null } });
}
const ref = refWith({
  compositions: [{ id: 2, synonym: 'More PEG', mol_pct: { MC3: 50, DSPC: 10, Chol: 37, DMG0PEG2000: 3 } }],
  rnaLots: [{ id: 'RNA-7', construct: 'FLuc mRNA', conc_mg_mL: 1.02 }],
});
const settings = { ...DEFAULT_SETTINGS, operator: 'GM' };
const env = (id = 'E1') => ({ settings: DEFAULT_SETTINGS, takenFormulations: [], experimentId: id });
const NOW = new Date(2026, 9, 27, 14, 5);

let n = 0;
const dls = (batchId, runs, extra = {}) => ({ id: `m${++n}`, batchId, test: 'dls', stage: 'final', date: '2026-10-21', operator: 'AB',
  values: { zave_nm: runs.reduce((a, r) => a + r[0], 0) / runs.length, pdi: runs.reduce((a, r) => a + r[1], 0) / runs.length, runs: runs.map(([z, p]) => ({ zave_nm: z, pdi: p })) }, ...extra });
const ee = (batchId, v, extra = {}) => ({ id: `m${++n}`, batchId, test: 'ee', stage: 'final', date: '2026-10-22', values: { ee_pct: v }, ...extra });

/** The report's words, as a reader sees them: no markup, no style sheet, a chart as [SVG]. */
const words = (body) => body.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, ' [SVG] ')
  .replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const svgsOf = (body) => body.match(/<svg[\s\S]*?<\/svg>/g) || [];

/* ---------- print-ready charts ---------- */

test('a chart printed carries its own colours: no CSS variable is left, and the class rules travel inside it', () => {
  const svg = barChart({ bars: [{ label: 'A', mean: 80, sd: 2, points: [78, 80, 82], color: 'var(--s2)' }], ylab: 'Z-ave (nm)', ref: [{ y: 150, label: '' }] });
  assert.match(svg, /var\(--s2\)/, 'the screen chart follows the theme');
  const out = printSvg(svg);
  assert.doesNotMatch(out, /var\(--/);
  assert.match(out, new RegExp(`fill="${PRINT_COLOURS.s2}"`), 'the bar takes the light theme’s second series colour');
  assert.match(out, new RegExp(`stroke="${PRINT_COLOURS.warn}"`), 'the QC line its warning colour');
  assert.match(out, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*><style>\.ax\{stroke:rgba\(0,0,0,0\.16\)\}\.lb\{fill:#6E6E73/);
  // a fallback the chart named is used where the palette has no such token
  assert.match(printSvg('<svg><rect fill="var(--nope, #123456)"/></svg>'), /fill="#123456"/);
  assert.equal(printSvg(''), '');
  assert.doesNotMatch(printSvg(paretoSvg({ effects: [{ name: 'FRR', abs: 3, coef: -1, t: -3, significant: true }], tCrit: 2.3 })), /var\(--/);
});

test('the print palette is the light theme of index.html, except that the page is white', () => {
  const html = read('index.html');
  const light = /:root\s*\{([\s\S]*?)\}/.exec(html)[1];
  const tokens = Object.fromEntries([...light.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  for (const [k, v] of Object.entries(PRINT_COLOURS)) {
    if (k === 'bg') { assert.equal(v, '#FFFFFF'); continue; }
    assert.equal(v.toLowerCase(), String(tokens[k]).toLowerCase(), `--${k}`);
  }
  // and every `svg .class` rule the screen styles charts with has its printed counterpart
  const style = /<style>([\s\S]*?)<\/style>/.exec(printSvg('<svg></svg>'))[1];
  for (const [, cls] of html.matchAll(/svg \.(\w+)/g)) assert.match(style, new RegExp(`\\.${cls}\\b`), `.${cls}`);
});

/* ---------- the report ---------- */

test('a reference experiment: header, plan, statistics, data table with mean ± SD (n) and CV, figures, footer', () => {
  const { experiment, batches } = buildExperiment({ type: 'reference', name: 'Repeat <b>run</b>', startDate: '2026-10-20', compositionId: 1, reference: { n: 3 }, rnaLotId: 'RNA-7', stockId: 'Stock-004' }, env('E3'));
  const zs = [80, 84, 82];
  const ms = batches.flatMap((b, i) => [dls(b.id, [[zs[i] - 1, 0.08], [zs[i], 0.09], [zs[i] + 1, 0.1]]), ee(b.id, 90 + i)]);
  for (const s of experiment.expected) s.status = 'done'; // as saving a result does
  for (const b of batches) b.status = 'measured';
  ms.push(dls('E9-F1', [[300, 0.5]], { date: '2026-12-01' })); // another experiment's result is not this report's
  const stocks = [{ id: 'Stock-004', compositionId: 1, molarity_mM: 50 }];
  const { title, body } = experimentReport({ exp: experiment, batches, measurements: ms, ref, settings, stocks, version: '9.9.9', now: NOW });
  const t = words(body);
  assert.equal(title, 'E3 report · Repeat <b>run</b>');
  assert.match(body, /Repeat &lt;b&gt;run&lt;\/b&gt;/, 'a name is printed as text, never as markup');
  assert.match(t, /Experiment 3 \(E3\) · Repeat <b>run<\/b>/);
  assert.match(t, /Type Reference reproducibility · all measured/);
  assert.match(t, /Dates started 20 Oct 2026 · production 20 Oct 2026 · measured 21 Oct 2026 – 22 Oct 2026/);
  assert.match(t, /Operator AB /, 'whoever entered the results, before the operator in Settings');
  assert.match(t, /Composition #1 MC3 reference \(Onpattro-like\), DLin-MC3-DMA 50 \/ DSPC 10 \/ Cholesterol 38\.5 \/ DMG-PEG2000 1\.5/);
  assert.match(t, /Lots lipid stock Stock-004 \(#1, 50\.0 mM\) · mRNA RNA-7 \(FLuc mRNA, 1\.02 mg\/mL\)/);
  // the cargo names the RNA (calc/cargo.js): an older record without one is mRNA
  assert.match(t, /Process FRR 3 : 1 · total flow 112\.5 mL\/min · quench ×2 · lipid stock 50 mM · mRNA per batch 3 mg · RNA working conc\. 0\.40 mg\/mL · N\/P \d/);
  // how it was made: the mode and the process, here the lab layout an older record reads as (calc/process.js)
  assert.match(t, /Set-up Full process · Three-pump layout \(lab default\) · T-mixer · inline quench; aqueous Citrate 50 mM, pH 4\.0; dialysis into PBS, pH 7\.4/);
  assert.match(t, /Plan The same recipe, #1 MC3 reference \(Onpattro-like\), made 3 times to show how reproducible it is from batch to batch, each measured for DLS \(Z-ave, PDI\) and EE % \(RiboGreen\) on the final product\. 6 of 6 planned measurements are in\./);
  assert.match(t, /Statistics Batch to batch, over 3 batches: Z-ave 82\.0 ± 2\.0 nm \(CV 2\.4 %\)/, 'the Results card’s own sentence');
  assert.match(t, /Data table Formulation Z-ave \(nm\) mean ± SD PDI mean ± SD EE \(%\) mean ± SD E3-F1 rep 1 80\.0 ± 1\.0 n = 3 · CV 1\.3 %/);
  assert.match(t, /Batch to batch 3 batches 82\.0 ± 2\.0 n = 3 · CV 2\.4 %/);
  assert.match(t, /Figures Figure 1\. Z-ave \(nm\) \[SVG\] Dashed lines: QC limits 40 and 150 nm\. Figure 2\. PDI \[SVG\][\s\S]*Figure 3\. EE \(%\) \[SVG\]/);
  assert.equal(svgsOf(body).length, 4, 'three figures and the drawing of the process');
  for (const s of svgsOf(body)) assert.doesNotMatch(s, /var\(--/, 'every figure is inlined with its colours');
  assert.doesNotMatch(body, /data-fig-dl|<button/, 'no download buttons on paper');
  assert.match(t, /Date \/ signature operator Date \/ signature review/);
  assert.match(t, /LNP Lab v9\.9\.9 · printed 27 Oct 2026, 14:05 · Data: 6 measurements, last result 22 Oct 2026$/);
  assert.match(body, /@page\{size:A4/);
});

test('a comparison made in triplicate: the per-arm table and the test between arms, with the difference in words', () => {
  const { experiment, batches } = buildExperiment({ type: 'comparison', name: 'PEG', startDate: '2026-10-20', compositionId: 1, comparison: { compositionIds: [1, 1, 1, 2, 2, 2] } }, env());
  const z = [80, 81, 82, 90, 92, 89], p = [0.10, 0.12, 0.11, 0.11, 0.10, 0.12];
  const ms = batches.map((b, i) => dls(b.id, [[z[i] - 1, p[i]], [z[i] + 1, p[i]]]));
  const t = words(experimentReport({ exp: experiment, batches, measurements: ms, ref, settings, now: NOW }).body);
  assert.match(t, /Compositions #1 MC3 reference[\s\S]*#2 More PEG, DLin-MC3-DMA 50 \/ DSPC 10 \/ Cholesterol 37 \/ DMG-PEG2000 3/);
  assert.match(t, /2 compositions compared under one process, #1 MC3 reference \(Onpattro-like\) \(3 batches\) and #2 More PEG \(3 batches\): 6 formulations in all/);
  assert.match(t, /#2 \(E1-F4, E1-F5, E1-F6\) against #1: Z-ave \+9\.3 nm/);
  assert.match(t, /Welch’s t-test on the batch means \(n = 3 and 3 batches\): #2 differs from #1 in Z-ave \(t = 8\.85, df = 3\.4, p = 0\.0017\)/);
  assert.match(t, /Per arm Arm Batches Z-ave \(nm\) mean ± SD PDI mean ± SD #1 MC3 reference \(Onpattro-like\) 3 81\.0 ± 1\.0 n = 3 · CV 1\.2 %/);
  assert.match(t, /Test on the batch means Response Test Statistic df p p < 0\.05 Z-ave Welch’s t t = 8\.85 3\.4 p = 0\.0017 yes PDI Welch’s t t = 0\.00 4\.0 p = 1\.00 no/);
  assert.match(t, /Operator AB/);
});

test('a stability study: the days across with the slope column, the slope sentences, a line chart per response', () => {
  const { experiment, batches } = buildExperiment({ type: 'stability', name: 'Shelf', startDate: '2026-10-01', compositionId: 1,
    stability: { formulations: [{ compositionId: 1 }], conditions: ['4C', '25C'], timepoints: [0, 7, 14, 21, 28], tests: ['dls'] } }, env());
  const slot = (c, t) => experiment.expected.find((s) => s.condition === c && s.timepoint === t && s.test === 'dls');
  const at = (c, t, z) => { const s = slot(c, t); s.status = 'done'; return dls('E1-F1', [[z - 0.5, 0.1], [z + 0.5, 0.1]], { slotId: s.id, stage: s.stage, condition: c, timepoint: t, sampleName: s.sampleName, date: s.dueDate }); };
  const ms = [0, 7, 14, 21].flatMap((t, i) => [at('25C', t, [80, 84, 87, 91][i]), at('4C', t, [80, 80.5, 80.2, 80.4][i])]);
  // printed a week after the T28 samples were due, with none of them measured
  const { body } = experimentReport({ exp: experiment, batches, measurements: ms, ref, settings, now: new Date(2026, 10, 5, 9, 0) });
  const t = words(body);
  assert.match(t, /One formulation, #1 MC3 reference \(Onpattro-like\), stored at 4 °C and 25 °C and sampled on days 0, 7, 14, 21 and 28: 2 storage samples, each measured for DLS \(Z-ave, PDI\) on every day/);
  assert.match(t, /At 25 °C, E1-F1 grows 0\.51 nm\/day \(95 % CI 0\.43–0\.60\); at that rate it reaches 150 nm around day 140\./);
  assert.match(t, /Formulation Condition T0 production T7 day 7 T14 day 14 T21 day 21 T28 day 28 Trend least squares, per day/);
  assert.match(t, /E1-F1 #1 25 °C 80\.0 ± 0\.7 PDI 0\.100 84\.0 ± 0\.7 PDI 0\.100 \+4\.0 nm \(\+5\.0 %\)[\s\S]*? missing \+0\.51 nm\/day 95 % CI 0\.43–0\.60 150 nm ≈ day 140/,
    'a day not measured by its due date reads "missing", as on the screen');
  assert.match(t, /Figure 1\. Z-ave over time \[SVG\][\s\S]*Figure 2\. PDI over time \[SVG\]/);
  assert.match(body, /<div class="legend"><span><i style="background:var\(--s1\)"><\/i>E1-F1 · 4 °C<\/span>/, 'the legend names each line; its colours come from the sheet’s own palette');
  assert.match(body, new RegExp(`--s1:${PRINT_COLOURS.s1}`));
});

test('nothing measured: the plan and what is due, no statistics invented, and a footer that says there is no data', () => {
  const { experiment, batches } = buildExperiment({ type: 'single', name: 'Next', startDate: '2026-10-29', compositionId: 1 }, env('E7'));
  const t = words(experimentReport({ exp: experiment, batches, measurements: [], ref, settings, now: NOW }).body);
  assert.match(t, /Plan One formulation of #1 MC3 reference \(Onpattro-like\), measured for DLS \(Z-ave, PDI\) and EE % \(RiboGreen\) on the final product\. 0 of 2 planned measurements are in; 2 still due, the next on 30 Oct 2026\./);
  assert.match(t, /Results Nothing measured yet/);
  assert.match(t, /Operator GM /, 'the operator in Settings when no record names one');
  assert.doesNotMatch(t, /Statistics|Figure 1/);
  assert.match(t, /Data: 0 measurements$/);
});

/* ---------- a designed experiment, on the demo response surface ---------- */

const demo = () => { mem.clear(); const s = new Store(DEMO_NS); seedDemo(s); return s; };

test('the demo DoE: the balanced setting, what drives each response, the run table, coefficients and diagnostics', () => {
  const s = demo();
  const exp = s.get('experiments', 'E4');
  const batches = exp.batchIds.map((id) => s.get('batches', id));
  const { body } = experimentReport({ exp, batches, measurements: s.all('measurements'), ref, settings: getSettings({ store: s }), now: NOW });
  const t = words(body);
  assert.match(t, /Plan A central composite, face-centred design over FRR 2–4, total flow 60–120 mL\/min and PEG mol% 1–2\.5 mol%: 18 runs \(6 axial, 8 factorial, 4 center\), made in randomised order and fitted with a quadratic model \(9 terms and an intercept, 8 residual df\)\. Responses: Size \(target 80\), PDI \(as low as possible\) and EE \(as high as possible\)\./);
  assert.match(t, /Composition #1[\s\S]*PEG-lipid mol% set run by run by the design/);
  assert.match(t, /Process FRR 2 : 1 to 4 : 1 \(varied\) · total flow 60 mL\/min to 120 mL\/min \(varied\)/, 'a varied setting is printed as the range it was varied over');
  assert.match(t, /Recommended setting: the best balance of all responses[\s\S]*Factor Setting coded FRR[\s\S]*Response Predicted scatter ± Goal Score Size \(nm\)[\s\S]*Overall score 0\.\d\d/);
  assert.match(t, /What drives each response Size (falls|rises) with [\s\S]*R² 0\.\d\d · predicted R² [\s\S]*PDI [\s\S]*EE/);
  assert.match(t, /Runs and results Label Run order FRR total flow mL\/min PEG mol% Lot Planned Z-ave \(nm\) mean ± SD/);
  for (let i = 1; i <= 18; i++) assert.match(t, new RegExp(`R0${String(i).padStart(2, '0')} \\(\\w+\\)`), `run ${i} in the run table`);
  for (const name of ['Size \\(nm\\)', 'PDI', 'EE \\(%\\)']) {
    assert.match(t, new RegExp(`Model for ${name} R² [\\d.]+ · adjusted[\\s\\S]*?Term Coefficient SE t p Intercept [\\d.]+[\\s\\S]*?\\(PEG mol%\\)²`), `${name}: coefficients with p values`);
  }
  assert.equal(svgsOf(body).length, 13, 'four diagnostic plots for each of the three responses, and the process');
  for (const sv of svgsOf(body)) assert.doesNotMatch(sv, /var\(--/);
  assert.match(t, /Figure 12\. EE \(%\): measured against predicted/);
  assert.match(t, /Data: 36 measurements, last result/);
  // the lab's words throughout, as on the screen (cycle 6, I2); the identifiers are for the CSV only
  assert.doesNotMatch(t, /flow_rate|PEG_mol_pct|NP_ratio|quench_factor/, 'no factor is printed under its identifier');
});

test('the DoE report prints the model chosen on screen, and its coefficients are the fit the screen makes', () => {
  const s = demo();
  const exp = s.get('experiments', 'E4');
  const batches = exp.batchIds.map((id) => s.get('batches', id));
  const ms = s.all('measurements');
  const t = words(experimentReport({ exp, batches, measurements: ms, ref, settings: getSettings({ store: s }), now: NOW, model: 'linear' }).body);
  assert.match(t, /Every model below is the main effects model chosen on Design & results; the design was planned for quadratic\./);
  assert.doesNotMatch(t, /FRR²|\(PEG mol%\)²/, 'a linear model has no squares');
  const d = designFits(exp.design.doe.spec, exp.design.doe.runs, ms, { model: 'linear' });
  assert.deepEqual(d.terms.map((x) => x.name), ['Intercept', 'FRR', 'flow_rate', 'PEG_mol_pct']);
  assert.equal(d.fits.particle_size_nm.fit.n, 18);
  assert.ok(Number.isFinite(d.fits.particle_size_nm.fit.r2));
});

test('the other demo experiments all print: OFAT with its level column, the screening DoE, the stability study', () => {
  const s = demo();
  for (const id of ['E1', 'E2', 'E3', 'E5', 'E6', 'E7']) {
    const exp = s.get('experiments', id);
    const batches = exp.batchIds.map((b) => s.get('batches', b));
    const { body } = experimentReport({ exp, batches, measurements: s.all('measurements'), ref, settings: getSettings({ store: s }), now: NOW });
    assert.match(body, /Date \/ signature operator/, id);
    assert.doesNotMatch(words(body), /undefined|NaN|\[object Object\]/, id);
  }
  const e2 = s.get('experiments', 'E2');
  const t = words(experimentReport({ exp: e2, batches: e2.batchIds.map((b) => s.get('batches', b)), measurements: s.all('measurements'), ref, settings, now: NOW }).body);
  assert.match(t, /N\/P ratio varied over 3, 6, 9 and 12, everything else held at the settings above: 4 formulations/);
  assert.match(t, /Data table Formulation N\/P ratio Z-ave/);
  assert.match(t, /Figure 1\. Z-ave against N\/P ratio/);
});

test('a lipid-blend design: read along the lipids, a Scheffé table, the lipids as run-table columns, no box optimum', () => {
  const C3 = [{ name: 'ALC315', lipidKey: 'ALC315', lo: 40, hi: 60 }, { name: 'Chol', lipidKey: 'Chol', lo: 35, hi: 55 }, { name: 'DMGPEG', lipidKey: 'DMG0PEG2000', lo: 1, hi: 5 }];
  const doe = { mode: 'mixture', model: 'linear', mixtureOrder: 'quadratic', mixtureKind: 'auto', components: C3, factors: [],
    responses: [{ name: 'particle_size_nm', unit: 'nm', goal: 'target', target: 90, min_valid: 20, max_valid: 500 }], centerPoints: 3, seed: 42, total: 100, budget: 14 };
  const { experiment, batches } = buildExperiment({ type: 'doe', name: 'Blend', startDate: '2026-10-05', compositionId: 1, tests: ['dls'], doe }, env('E2'));
  // more PEG, smaller particles, with a little noise so the fit has residuals to plot
  const ms = experiment.design.doe.runs.map((r, i) => dls(r.batchId, [[140 - 9 * r.real.DMGPEG + 0.25 * (r.real.ALC315 - 50) + 0.4 * Math.sin(i), 0.1]]));
  const { body } = experimentReport({ exp: experiment, batches, measurements: ms, ref, settings, now: NOW });
  const t = words(body);
  assert.match(t, /Plan A lipid-blend design over ALC315 40–60, Chol 35–55 and DMGPEG 1–5 mol% \(always adding up to 100\): \d+ runs \([\s\S]*quadratic blending model \(6 terms, no intercept/);
  assert.match(t, /the lipid blend set run by run by the design/);
  assert.doesNotMatch(t, /Recommended setting/, 'the balanced search walks a box, which a blend is not');
  assert.match(t, /What drives each response Size falls with more DMGPEG/);
  assert.match(t, /Runs and results Label Run order ALC315 mol% Chol mol% DMGPEG mol% Lot/);
  assert.match(t, /Model for Size \(nm\)[\s\S]*Scheffé model, no intercept[\s\S]*Term Coefficient SE t p ALC315 [\d.]+/);
  assert.equal(svgsOf(body).length, 5, 'four figures and the process');
});
