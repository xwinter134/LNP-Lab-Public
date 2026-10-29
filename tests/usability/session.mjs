// One usability session: a newcomer and then an expert work through a realistic stretch of lab work in the
// app — materials, buffers, every experiment type, the bench record, measurements typed in by hand, pasted
// and imported, the DoE fit, an optimization round with the ML optimizer, insights, calendar, export.
// The numbers come from the simulated lab in lab.mjs, whose optimum is known.
//
//   node tests/usability/session.mjs --cycle 1            → docs/usability/cycle-1/
//
// Every action is logged (actions.jsonl), with a keystroke-level estimate of the time a person would need;
// observations and feature probes go to summary.json. report.md is written from these by hand.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Recorder } from './recorder.mjs';
import { rng, measure, truth, desirability, trueOptimum, zetasizerCsv } from './lab.mjs';

const req = createRequire(import.meta.url);
const { chromium } = (() => { for (const c of ['playwright', '/opt/node-tools/node_modules/playwright', '/opt/node22/lib/node_modules/playwright']) { try { return req(c); } catch {} } throw new Error('playwright not found'); })();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const cycle = arg('cycle', '0');
const out = path.join(root, 'docs/usability', `cycle-${cycle}`);
fs.rmSync(out, { recursive: true, force: true });

const { serve } = await import('../../scripts/serve.mjs');
const srv = await serve(root, 0, '127.0.0.1');
const base = `http://127.0.0.1:${srv.address().port}/`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Europe/Berlin', acceptDownloads: true });
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-10-27T09:30:00+01:00'));
const S = new Recorder(page, out, { cycle, base, viewport: '1440x900', date: '2026-10-27' });
const R = rng(20261027); // same lab noise every cycle, so cycles are comparable
const LIPIDS = JSON.parse(fs.readFileSync(path.join(root, 'app/data/lipids.json'), 'utf8'));
const PEG_KEYS = new Set(LIPIDS.filter((l) => l.class === 'peg').map((l) => l.key));
const REF_COMPS = JSON.parse(fs.readFileSync(path.join(root, 'app/data/compositions.json'), 'utf8'));
const truthLog = []; // every formulation the bench "made", with its true score

// ---------------------------------------------------------------- the bench
/** What was made, read off the formulation record — the operator knows what went into the vial. */
async function made(batchId) {
  return page.evaluate(async ({ batchId }) => {
    const b = (await lnpDb.read('batches')).find((x) => x.id === batchId);
    const comps = await lnpDb.read('compositions');
    return b ? { plan: b.plan, compositionId: b.compositionId, stockId: b.stockId, comp: comps.find((c) => c.id === b.compositionId) || null } : null;
  }, { batchId });
}
async function paramsOf(batchId) {
  const b = await made(batchId);
  if (!b) throw new Error('no batch ' + batchId);
  const comp = b.comp || REF_COMPS.find((c) => c.id === b.compositionId);
  const o = b.plan.compositionOverride || {};
  const pegFromComp = comp ? Object.entries(comp.mol_pct).filter(([k]) => PEG_KEYS.has(k)).reduce((s, [, v]) => s + v, 0) : 1.5;
  return { frr: b.plan.mixing.frr, tfr: b.plan.mixing.totalFlow, np: b.plan.rna.np ?? 6, peg: o.peg_pct ?? o.peg ?? pegFromComp, lotShift_nm: b.stockId === 'Stock-002' ? 4 : 0 };
}
async function bench(batchId, opts = {}) {
  const p = await paramsOf(batchId);
  const m = measure(p, R, opts);
  const t = truth(p);
  truthLog.push({ batchId, ...p, measured: { zave_nm: m.zave_nm, pdi: m.pdi, ee_pct: m.ee_pct }, trueD: desirability(t), condition: opts.condition || null, days: opts.days || 0 });
  return m;
}

// ---------------------------------------------------------------- reusable flows
/** Graphs on the screen: drawn SVGs of a readable size, not the icons and progress rings. */
async function charts(scope = '#main') { return page.evaluate((sc) => [...document.querySelectorAll(`${sc} svg`)].filter((s) => { const r = s.getBoundingClientRect(); return r.width >= 160 && r.height >= 90; }).length, scope); }
async function newExperiment(type, cardText) {
  await S.menu('experiments', 'Experiments in the sidebar');
  await S.click('#main a.btn.primary[href="#/experiments?new=1"]', 'New experiment');
  await S.click(`#main a[href="#/experiments?new=1&type=${type}"]`, `type card: ${cardText}`);
}
async function createAndRead(name) {
  await S.click('#createExp', 'Create experiment', { wait: 500 });
  const t = await S.read('#main', 'read the new experiment');
  const id = /Experiments ›\s*Experiment (\d+)/i.exec(t)?.[1];
  if (!id) throw new Error(`${name}: did not land on the experiment detail`);
  return 'E' + id;
}
// The records are read through the app's test door (window.lnpDb), whatever the store keeps them in.
const readCol = (col, p = page) => p.evaluate((c) => window.lnpDb.read(c), col);
async function batchesOf(expId) { return (await readCol('experiments')).find((e) => e.id === expId)?.batchIds || []; }
async function openSlots(expId, test) { return ((await readCol('experiments')).find((e) => e.id === expId)?.expected || []).filter((s) => s.status === 'open' && (!test || s.test === test)); }

/** Type a DLS result by hand: choose the expected measurement, three runs of Z-ave and PDI, save. */
async function typeDls(sampleName, m) {
  await S.selectByText('select[name=slotId]', `${sampleName} · dls`, `choose ${sampleName} · dls`);
  for (let i = 0; i < 3; i++) { await S.fill(`input[name=run_z${i + 1}]`, m.runs[i].zave_nm.toFixed(1), `Z-ave run ${i + 1}`); await S.fill(`input[name=run_p${i + 1}]`, m.runs[i].pdi.toFixed(3), `PDI run ${i + 1}`); }
  await S.click('#saveManual', 'Save result', { wait: 300 });
}
async function typeEe(sampleName, m) {
  await S.selectByText('select[name=slotId]', `${sampleName} · ee`, `choose ${sampleName} · ee`);
  await S.fill('input[name=v_ee_pct]', m.ee_pct.toFixed(1), 'EE %');
  await S.click('#saveManual', 'Save result', { wait: 300 });
}

async function openPaste() { if (!(await page.locator('details[open]:has(#pasteBox)').count())) await S.click('#main details:has(#pasteBox) > summary', 'or paste it here'); }
/** EE for several samples at once: a pasted RiboGreen block when the app takes one, else typed one by one. */
async function enterEe(list) {
  if (!list.length) return;
  if (await page.locator('#importTest option[value=ee]').count()) {
    await openPaste();
    await S.paste('#pasteBox', ['Sample Name\tEE (%)', ...list.map(([n, m]) => `${n}\t${m.ee_pct.toFixed(1)}`)].join('\n'), 'paste the RiboGreen EE block');
    await S.click('#pasteGo', 'Read what I pasted', { wait: 500 });
    if ((await page.locator('#importTest').inputValue()) !== 'ee') { S.note('friction', 'A pasted EE block was not recognised as EE; the type had to be switched by hand.', 'minor'); await S.select('#importTest', 'ee', 'import type: EE'); }
    await S.click('#doImport', 'Import selected', { wait: 600 });
    await probeImportEval('EE paste');
  } else for (const [n, m] of list) await typeEe(n, m);
}
/** Type results into the grid for the waiting experiment: rows by sample name, cells by field. */
async function gridEntry(expText, rows) {
  await S.selectByText('#waitExp', expText, `waiting for: ${expText}`);
  if (await S.exists('#gridOpen')) await S.click('#gridOpen', 'Type results as a grid', { wait: 400 });
  for (const [name, vals] of rows) for (const [key, v] of Object.entries(vals)) {
    const sel = `#resultGrid tr[data-sample="${name}"] input.gcell[data-key=${key}]`;
    if (await S.exists(sel)) await S.fill(sel, v, `${name} ${key}`);
  }
  await S.click('#gridSave', 'Save all', { wait: 300 });
  return S.read('#toast', 'read what was saved').catch(() => '');
}
/** The probe for automatic evaluation after an import: a summary of what came in, with at least one graph. */
async function probeImportEval(label) {
  const svg = await charts();
  const t = await page.locator('#main').innerText();
  const pass = svg > 0 && /evaluation|summary of (this|the) import|what came in|just imported/i.test(t);
  S.probe('import.autoEval', `${label}: after an import the app evaluates the data with graphs`, pass, `${svg} svg on screen`);
}

// ---------------------------------------------------------------- the session
const truthOpt = trueOptimum();
const ids = {};
await page.goto(base); await S.settle(800);

await S.runTask('T01', 'First look: what is this app and where do I start?', 'newcomer', async () => {
  await S.go('overview', 'open the app');
  await S.shot('overview-empty');
  const t = await S.read('#main', 'read the overview');
  if (!/Getting started/.test(t)) S.note('friction', 'No getting-started guidance on an empty install.', 'major');
  else S.note('good', 'Empty overview explains the five steps (plan, set up, materials, bench, evaluate) with links.');
  S.probe('nav.sidebarWorkflow', 'Sidebar is ordered as the workflow (Plan, Run, Evaluate, Optimize)', /Plan[\s\S]*Run[\s\S]*Evaluate[\s\S]*Optimize/i.test(await page.locator('nav').innerText()));
});

await S.runTask('T02', 'Settings: my initials and QC limits', 'newcomer', async () => {
  await S.menu('settings', 'Settings & export');
  await S.fill('input[name=operator]', 'GM', 'operator initials'); // stored as typed: no Save button
  await S.shot('settings');
});

await S.runTask('T03', 'Materials: register the RNA lot and lipid lots with purity', 'newcomer', async () => {
  await S.menu('materials', 'Materials & lots');
  await S.go('materials?tab=rna', 'RNA tab');
  await S.fill('#rnaForm input[name=id]', 'RNA-FLuc-2610', 'RNA lot id');
  await S.fill('#rnaForm input[name=construct]', 'FLuc mRNA', 'construct');
  await S.fill('#rnaForm input[name=conc_mg_mL]', '1.02', 'RNA stock conc');
  await S.click('#addRna', 'Add RNA lot');
  await S.go('materials?tab=lipids', 'Lipids tab');
  for (const [k, lot, pur] of [['MC3', 'MC3-L2401', '98.5'], ['DSPC', 'DSPC-850365', '99'], ['Chol', 'CHOL-C8667', '99.5'], ['DMG0PEG2000', 'PEG-880151', '97']]) {
    await S.select('#lotForm select[name=lipidKey]', k, `lipid ${k}`);
    await S.fill('#lotForm input[name=lot]', lot, 'lot number');
    await S.fill('#lotForm input[name=purityPct]', pur, 'purity %');
    await S.click('#addLot', 'Add lot');
  }
  const t = await S.read('#tabBody', 'check the lots are listed');
  if (!/CHOL-C8667/.test(t)) throw new Error('lipid lot not listed');
  await S.shot('materials-lots');
  // a second recipe to compare against later: more PEG
  await S.go('materials?tab=compositions', 'Compositions tab');
  await S.fill('#compForm input[name=synonym]', 'MC3 high PEG (3 mol%)', 'composition name');
  for (const [i, [key, pct]] of [['MC3', '50'], ['DSPC', '10'], ['Chol', '37'], ['DMG0PEG2000', '3']].entries()) {
    await S.select(`#compForm select[name=k${i}]`, key, `lipid ${i + 1}`);
    await S.fill(`#compForm input[name=p${i}]`, pct, `mol% ${i + 1}`);
  }
  await S.click('#addComp', 'Register composition');
  const c = await S.read('#tabBody', 'check composition registered');
  if (!/high PEG/.test(c)) throw new Error('composition not registered');
});

await S.runTask('T04', 'Lipid stocks: weigh in two lots of the MC3 stock', 'newcomer', async () => {
  for (const [n, vol] of [[1, '20'], [2, '10']]) {
    await S.menu('stocks', 'Lipid stocks');
    if (await S.exists('#main a[href="#/stocks?new=1"]')) await S.click('#main a[href="#/stocks?new=1"]', 'New stock');
    else { S.note('friction', 'No "New stock" button on the stocks list; reached the form by URL.', 'major'); await S.go('stocks?new=1'); }
    await S.select('select[name=compositionId]', '1', 'composition #1');
    await S.fill('input[name=molarity_mM]', '50', 'molarity');
    await S.fill('input[name=volume_mL]', vol, 'volume');
    const plan = await S.read('#stockForm', 'read the weigh-in');
    // hand check: 50 mM × 20 mL = 1.0 mmol; DSPC 10 % × 790.15 g/mol = 0.0790 g before purity
    const dspc = /(0\.\d{3,4})/.exec(await page.locator('[data-key=DSPC]').first().innerText().catch(() => ''))?.[1];
    if (n === 1) S.note('calc', `DSPC weigh-in shown ${dspc ?? '?'} g for 0.1 mmol × 790.15 g/mol (0.0790 g before purity, 0.0798 g at 99 %).`, dspc && Math.abs(Number(dspc) - 0.0798) < 0.0012 ? 'ok' : 'check');
    const f = Number(vol) / 20;
    for (const [k, v] of [['MC3', 0.3051], ['DSPC', 0.0752], ['Chol', 0.1418], ['DMG0PEG2000', 0.0365]]) await S.fill(`input[name=actual_${k}]`, (v * f).toFixed(4), `actual ${k}`);
    await S.read('#stockForm', 'read ethanol to add');
    await S.click('#saveStock', 'Save stock');
  }
  const t = await S.read('#stockList', 'stock list');
  if (!/Stock-002/.test(t)) throw new Error('second stock not saved');
  await S.shot('stocks');
});

await S.runTask('T05', 'Buffers: citrate, acetate, PBS, Tris-sucrose', 'newcomer', async () => {
  const want = [
    ['Citric acid', '4.0', '50', '500', 0, 0, 'Citrate 50 mM pH 4.0'],
    ['Acetic acid', '5.0', '25', '250', 0, 0, 'Acetate 25 mM pH 5.0'],
    ['Phosphoric acid', '7.4', '10', '2000', 137, 0, 'PBS 10 mM pH 7.4'],
    ['Tris(hydroxymethyl)- aminomethane (tris)', '7.4', '20', '1000', 0, 300, 'Tris 20 mM sucrose 300 mM pH 7.4'],
  ];
  for (const [sys, ph, mM, vol, nacl, suc, name] of want) {
    await S.menu('buffers', 'Buffers');
    if (await S.exists('#main a[href="#/buffers?new=1"]')) await S.click('#main a[href="#/buffers?new=1"]', 'New buffer');
    else { S.note('friction', 'No "New buffer" button found on the buffers list; used the URL.', 'major'); await S.go('buffers?new=1'); }
    await S.select('select[name=system]', sys, `system ${sys}`);
    await S.fill('input[name=targetPH]', ph, 'target pH');
    await S.fill('input[name=conc_mM]', mM, 'concentration');
    await S.fill('input[name=volume_mL]', vol, 'volume');
    if (nacl) await S.fill('input[name=nacl_mM]', String(nacl), 'NaCl');
    if (suc) await S.fill('input[name=sucrose_mM]', String(suc), 'sucrose');
    const r = await S.read('#bufferResult', 'read the recipe');
    const pred = /predicted pH\s*([\d.]+)/i.exec(r)?.[1];
    S.note('calc', `${name}: predicted pH ${pred ?? '?'} for target ${ph}.`, pred && Math.abs(Number(pred) - Number(ph)) < 0.06 ? 'ok' : 'check');
    await S.fill('input[name=name]', name, 'buffer name');
    await S.click('#saveBuffer', 'Save lot');
  }
  const t = await S.read('#main', 'buffer list');
  if (!/Buffer-004/.test(t)) throw new Error('fourth buffer missing');
  await S.shot('buffers');
});

await S.runTask('T06', 'Single formulation: plan, fill the batch record, make it, measure it', 'newcomer', async () => {
  await newExperiment('single', 'Single formulation');
  await S.fill('input[name=name]', 'First MC3 batch', 'name');
  await S.select('select[name=stockId]', 'Stock-001', 'stock lot');
  await S.select('select[name=rnaLotId]', 'RNA-FLuc-2610', 'RNA lot');
  ids.single = await createAndRead('single');
  await S.shot('single-detail');
  const t = await S.read('#main', 'what now?');
  S.probe('exp.nextStep', 'A new experiment says what to do next (make it, then measure it)', /next step|what next|to do next|then measure/i.test(t));
  const [b] = await batchesOf(ids.single);
  await S.click(`#main a[href="#/formulation?batch=${b}"]`, 'open the formulation record');
  await S.fill('input[name=rna_mass_mg]', '3', 'RNA mass');
  await S.read('#main', 'read RNA dilution and mixing volumes');
  if (await S.exists('#step3 > summary') && !(await page.locator('#step3[open]').count())) await S.click('#step3 > summary', 'open step 3 · dialysis');
  await S.fill('input[name=ds_dialysis_start_mL]', '10', 'dialysis start volume');
  await S.fill('input[name=a_dialysis_end_mL]', '12.5', 'dialysis end volume');
  // The record stores each value as it is typed (cycle 5, K6): there is no Save button to press.
  await S.select('#statusSel', 'produced', 'mark produced');
  await S.shot('batch-record');
  const m = await bench(b);
  await S.menu('measurements', 'Measurements');
  await typeDls(`${b}_final`, m);
  await typeEe(`${b}_final`, m);
  const r = await S.read('#main', 'see the result listed');
  if (!new RegExp(`${b}_final`).test(r)) throw new Error('result not listed');
  // enter an impossible value to see whether the form stops it
  await S.select('select[name=batchId]', b, 'free entry: formulation');
  await S.fill('input[name=stage]', 'retest', 'stage');
  await S.fill('input[name=run_z1]', '81', 'Z-ave'); await S.fill('input[name=run_p1]', '5', 'PDI 5 (typo for 0.05)');
  await S.click('#saveManual', 'Save result');
  const after = await page.locator('#main').innerText();
  const stored = (await readCol('measurements')).some((x) => x.values?.pdi === 5);
  S.probe('entry.validation', 'An impossible value (PDI 5) is caught before it is stored', !stored, stored ? 'stored with a QC flag only' : 'blocked');
  if (stored) S.note('bug', 'A PDI of 5 (typo for 0.05) is stored as a result; only a QC chip marks it. A PDI above 1 is not a measurement.', 'major');
  if (stored) {
    // clean up the typo like a user would: open it and delete it
    const mid = (await readCol('measurements')).find((x) => x.values?.pdi === 5)?.id;
    await S.go(`measurements?id=${mid}`, 'open the wrong result');
    await S.click('#del', 'Delete');
  }
  await S.go(`experiments?id=${ids.single}`, 'back to the experiment');
  const d = await S.read('#main', 'read the experiment result');
  S.probe('exp.resultsVisible', 'The experiment page shows its results', /\d+\.\d \/ 0\.\d\d/.test(d));
  void after;
});

await S.runTask('T07', 'Reproducibility: four repeats on two stock lots', 'expert', async () => {
  await page.locator('#modeToggle').check(); await S.settle(200);
  S.write({ action: 'check', target: '#modeToggle', label: 'Show advanced options', ok: true, dur_ms: 0, est_s: 1.5 });
  await newExperiment('reference', 'Reference reproducibility');
  await S.fill('input[name=name]', 'MC3 repeats, two stock lots', 'name');
  await S.fill('input[name=ref_n]', '4', 'repeats');
  ids.ref = await createAndRead('reference');
  const bs = await batchesOf(ids.ref);
  for (const [i, b] of bs.entries()) {
    await S.go(`formulation?batch=${b}`, `record ${b}`);
    await S.select('select[name=stockId]', i < 2 ? 'Stock-001' : 'Stock-002', 'stock lot');
    await S.select('select[name=rna_lotId]', 'RNA-FLuc-2610', 'RNA lot');
  }
  await S.menu('measurements', 'Measurements');
  if (await S.exists('#gridOpen')) {
    const rows = []; for (const b of bs) { const m = await bench(b); rows.push([`${b}_final`, { zave_nm: m.zave_nm.toFixed(1), pdi: m.pdi.toFixed(3), ee_pct: m.ee_pct.toFixed(1) }]); }
    const rep = await gridEntry('MC3 repeats', rows);
    if (!/Saved 8 result/.test(rep)) S.note('check', `Grid saved: "${rep.slice(0, 120)}" (expected 8 results: 4 × DLS and EE).`, 'major');
  } else for (const b of bs) { const m = await bench(b); await typeDls(`${b}_final`, m); await typeEe(`${b}_final`, m); }
  await S.go(`experiments?id=${ids.ref}`, 'open the repeats');
  const t = await S.read('#main', 'how reproducible was it?');
  S.probe('exp.replicateStats', 'Repeats are summarised as mean ± SD / CV', /±|\bCV\b|SD/.test(t));
  await S.shot('reference-detail');
});

await S.runTask('T08', 'Comparison: reference recipe against high PEG', 'expert', async () => {
  await newExperiment('comparison', 'Compare compositions');
  await S.fill('input[name=name]', 'PEG 1.5 vs 3 mol%', 'name');
  await S.click('#addCmp', '+ Add composition');
  await S.selectByText('select[name=cmp_1]', 'high PEG', 'second composition');
  ids.cmp = await createAndRead('comparison');
  await S.menu('measurements', 'Measurements');
  for (const b of await batchesOf(ids.cmp)) { const m = await bench(b); await typeDls(`${b}_final`, m); await typeEe(`${b}_final`, m); }
  await S.go(`experiments?id=${ids.cmp}`, 'open the comparison');
  const t = await S.read('#main', 'which one is better?');
  S.probe('exp.compareChart', 'A comparison shows its arms side by side in a graph', (await charts()) > 0);
  void t;
  await S.shot('comparison-detail');
});

await S.runTask('T09', 'OFAT: N/P 3, 6, 9, 12', 'expert', async () => {
  await newExperiment('ofat', 'OFAT');
  await S.fill('input[name=name]', 'N/P scan', 'name');
  await S.select('select[name=ofat_factor]', 'np', 'factor N/P');
  await S.fill('input[name=ofat_levelsText]', '3, 6, 9, 12', 'levels');
  ids.ofat = await createAndRead('ofat');
  await S.menu('measurements', 'Measurements');
  // pasted out of a spreadsheet this time
  const bs = await batchesOf(ids.ofat);
  const ms = []; for (const b of bs) ms.push([b, await bench(b)]);
  await openPaste();
  await S.paste('#pasteBox', ['Sample Name\tZ-Average (d.nm)\tPdI', ...ms.map(([b, m]) => `${b}_final\t${m.zave_nm.toFixed(1)}\t${m.pdi.toFixed(3)}`)].join('\n'), 'paste DLS block');
  await S.click('#pasteGo', 'Read what I pasted', { wait: 500 });
  await S.click('#doImport', 'Import selected', { wait: 500 });
  await probeImportEval('OFAT paste');
  // EE: try the same paste route, then fall back to typing
  await openPaste();
  const eeOffered = await page.locator('#importTest option[value=ee]').count();
  S.probe('import.ee', 'EE results can be pasted or imported in bulk, not only typed one by one', eeOffered > 0);
  if (!eeOffered) S.note('friction', 'EE (RiboGreen) cannot be imported or pasted; every EE value is typed one formulation at a time (4 actions each).', 'major');
  await enterEe(ms.map(([b, m]) => [`${b}_final`, m]));
  await S.menu('doe', 'Design & results');
  await S.select('select[name=expSel]', ids.ofat, 'choose the N/P scan');
  const t = await S.read('#main', 'read the dose response');
  S.probe('ofat.chart', 'The OFAT view plots response against the factor level', (await charts()) > 0);
  void t;
  await S.shot('ofat-results', { full: true });
});

await S.runTask('T10', 'Stability: two recipes, 4 °C and 25 °C, four weeks', 'expert', async () => {
  await newExperiment('stability', 'Stability study');
  await S.fill('input[name=name]', 'Storage: PEG 1.5 vs 3', 'name');
  await S.click('#addForm', '+ Add formulation');
  await S.selectByText('select[name=form_1]', 'high PEG', 'second formulation');
  await S.fill('input[name=st_intervalDays]', '7', 'every 7 days');
  ids.stab = await createAndRead('stability');
  await S.shot('stability-detail');
  const slots = (await openSlots(ids.stab, 'dls')).filter((s) => [0, 7].includes(s.timepoint));
  await S.menu('measurements', 'Measurements');
  await S.selectByText('#waitExp', 'Storage', 'waiting for: the stability study');
  const t0 = slots.filter((s) => s.timepoint === 0);
  const lines = ['Sample Name,Z-Average (d.nm),PdI'];
  for (const s of t0) { const m = await bench(s.batchId, { condition: s.condition, days: 0 }); lines.push(`${s.sampleName},${m.zave_nm.toFixed(1)},${m.pdi.toFixed(3)}`); }
  await openPaste();
  await S.paste('#pasteBox', lines.join('\n'), 'paste T0');
  await S.click('#pasteGo', 'Read what I pasted', { wait: 500 });
  await S.click('#doImport', 'Import selected', { wait: 500 });
  for (const s of slots.filter((x) => x.timepoint === 7)) { const m = await bench(s.batchId, { condition: s.condition, days: 7 }); await typeDls(s.sampleName, m); }
  await S.go(`experiments?id=${ids.stab}`, 'open the study');
  const t = await S.read('#main', 'is it stable?');
  if (!/T7[\s\S]*\d+\.\d( ± [\d.]+)?\s*(\/\s*)?(PDI )?0\.\d/.test(t)) S.note('bug', 'The stability page does not show the T7 values just entered.', 'major');
  await S.shot('stability-matrix', { full: true });
});

await S.runTask('T23', 'Stability follow-up: the later timepoints, typed as they come', 'expert', async () => {
  const later = (await openSlots(ids.stab, 'dls')).filter((s) => s.timepoint > 0).sort((a, b) => a.timepoint - b.timepoint);
  if (!later.length) { S.note('bug', 'The stability study has no timepoints after T0, although it was set to 28 days every 7 days: an empty "custom timepoints" field is read as [0] and overrides the interval.', 'critical'); S.probe('stab.trend', 'The stability study plots size over time per condition', false, 'no timepoints to plot'); return; }
  await S.menu('measurements', 'Measurements');
  const eeOpen = new Set((await openSlots(ids.stab, 'ee')).map((x) => x.sampleName));
  if (await S.exists('#gridOpen')) {
    // one sitting per timepoint, as the weeks come: the rows due that day, size, PDI and EE
    for (const tp of [...new Set(later.map((x) => x.timepoint))]) {
      const rows = [];
      for (const s of later.filter((x) => x.timepoint === tp)) { const m = await bench(s.batchId, { condition: s.condition, days: s.timepoint }); rows.push([s.sampleName, { zave_nm: m.zave_nm.toFixed(1), pdi: m.pdi.toFixed(3), ...(eeOpen.has(s.sampleName) ? { ee_pct: m.ee_pct.toFixed(1) } : {}) }]); }
      await gridEntry('Storage', rows);
    }
  } else {
    for (const s of later) { const m = await bench(s.batchId, { condition: s.condition, days: s.timepoint }); await typeDls(s.sampleName, m); }
    for (const s of (await openSlots(ids.stab, 'ee'))) { const m = await bench(s.batchId, { condition: s.condition, days: s.timepoint }); await typeEe(s.sampleName, m); }
  }
  await S.go(`experiments?id=${ids.stab}`, 'open the study');
  await S.read('#main', 'which recipe holds up at 25 °C?');
  S.probe('stab.trend', 'The stability study plots size over time per condition', (await charts()) > 0);
  await S.shot('stability-complete', { full: true });
});

await S.runTask('T11', 'DoE: face-centred CCD on FRR × flow × PEG, size target 80 nm', 'expert', async () => {
  await newExperiment('doe', 'DoE');
  await S.fill('input[name=name]', 'CCD FRR flow PEG', 'name');
  await S.click('[data-addf=peg_pct]', '+ PEG-lipid factor');
  await S.select('select[name=doe_designType]', 'ccd_faced', 'design: CCD faced');
  await S.select('select[name=doe_model]', 'quadratic', 'model: quadratic');
  await S.fill('input[name=doe_centerPoints]', '4', 'centre points');
  await S.fill('input[name=doe_r_target_particle_size_nm]', '80', 'size target 80');
  const pv = await S.read('#main', 'check the run count');
  if (!/18 runs/.test(pv)) S.note('check', `CCD preview did not read "18 runs": ${/\d+ runs/.exec(pv)?.[0]}`, 'major');
  await S.shot('doe-wizard', { full: true });
  ids.ccd = await createAndRead('ccd');
});

await S.runTask('T21', 'Bench day: make the 18 CCD runs and record them', 'expert', async () => {
  await S.menu('formulation', 'Formulations');
  const t = await S.read('#main', 'find the CCD runs');
  S.probe('batch.bulkStatus', 'Several formulations can be marked produced in one go', /mark (all|selected)|select all|bulk/i.test(t) || (await page.locator('#main input[type=checkbox]').count()) > 3);
  const bs = await batchesOf(ids.ccd);
  await S.go(`experiments?id=${ids.ccd}`, 'open the CCD');
  if (await S.exists('#markAllProduced')) {
    await S.select('#bulkStock', 'Stock-001', 'lipid stock for all'); await S.click('#applyStock', 'Apply');
    await S.select('#bulkRna', 'RNA-FLuc-2610', 'RNA lot for all'); await S.click('#applyRna', 'Apply');
    await S.click('#markAllProduced', 'Mark all produced', { wait: 400 });
    const left = (await readCol('batches')).filter((b) => bs.includes(b.id) && (b.status === 'planned' || b.stockId !== 'Stock-001')).length;
    if (left) S.note('bug', `${left} CCD formulations not produced or without the stock after the bulk actions.`, 'major');
    await S.go(`formulation?batch=${bs[0]}`, `look at one record ${bs[0]}`);
  } else {
    for (const [i, b] of bs.entries()) {
      await S.go(`formulation?batch=${b}`, `record ${b}`);
      if (i === 0) { await S.select('select[name=stockId]', 'Stock-001', 'stock lot'); await S.select('select[name=rna_lotId]', 'RNA-FLuc-2610', 'RNA lot'); }
      await S.select('#statusSel', 'produced', 'mark produced');
    }
    S.note('friction', `Recording the day took ${bs.length} separate record visits just to change a status; the stock and RNA lot chosen on the first record are not carried to the others.`, 'major');
  }
  if (await S.exists('#printBatch')) {
    const [pop] = await Promise.all([context.waitForEvent('page', { timeout: 4000 }).catch(() => null), page.click('#printBatch')]);
    S.write({ action: 'click', target: '#printBatch', label: 'Print worksheet', ok: !!pop, dur_ms: 0, est_s: 1.5 });
    if (pop) { await pop.waitForTimeout(400); await pop.close(); }
  }
});

await S.runTask('T12', 'Measure the CCD: blank sheet → instrument export → import, one typo', 'expert', async () => {
  await S.menu('measurements', 'Measurements');
  await S.selectByText('#waitExp', 'CCD', 'waiting for: the CCD');
  const sheet = await S.download('#blankSheet', 'Blank sheet (CSV)');
  const names = fs.readFileSync(sheet, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(',')[0]);
  const ccdB = await batchesOf(ids.ccd);
  const mine = names.filter((n) => ccdB.includes(n.replace(/_final$/, '')));
  if (mine.length !== 18) S.note('check', `Blank sheet listed ${mine.length} CCD samples, expected 18.`, 'major');
  const samples = [];
  const meas = {};
  for (const n of mine) { const b = n.replace(/_final$/, ''); meas[b] = await bench(b); samples.push({ name: n, runs: meas[b].runs }); }
  // the operator mistypes one name on the instrument
  const typoOf = samples[5].name;
  samples[5] = { ...samples[5], name: 'Sample 6' }; // forgot to rename it on the instrument
  const csv = zetasizerCsv(samples);
  await S.upload('#csvFile', { name: 'CCD_zetasizer_export.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) }, 'drop the Zetasizer export');
  const pv = await S.read('#importPreview', 'read the preview');
  const matched = Number(/(\d+) matched/.exec(pv)?.[1] || 0);
  S.note(matched >= 17 ? 'good' : 'bug', `Import preview matched ${matched} of 18 samples (one name was mistyped on purpose).`, matched >= 17 ? 'ok' : 'major');
  S.probe('import.unmatchedHelp', 'An unmatched row offers the samples still missing from that file, so the gap is obvious', /missing from this file|not in this file|still missing|only one left/i.test(pv));
  await S.shot('import-preview');
  await S.click('#doImport', 'Import selected', { wait: 600 });
  await probeImportEval('CCD file');
  await S.shot('after-import');
  // the typo went to the inbox; assign it
  if (await S.exists('[data-assignbtn]')) {
    const want = typoOf;
    await S.selectByText('select[data-assign]', want, `assign to ${want}`);
    await S.click('[data-assignbtn]', 'Assign');
  } else if ((await openSlots(ids.ccd, 'dls')).some((x) => x.sampleName === typoOf)) S.note('check', 'The unrenamed sample neither reached the inbox nor its slot.', 'major');
  else S.note('good', `The unrenamed "Sample 6" was matched to ${typoOf} by elimination, the only sample missing from the file.`, 'ok');
  await enterEe(mine.map((n) => [n, meas[n.replace(/_final$/, '')]]));
  const open = (await openSlots(ids.ccd)).length;
  if (open) S.note('check', `${open} CCD measurements still open after entry.`, 'major');
});

await S.runTask('T22', 'Zeta potential for the CCD from the instrument export', 'expert', async () => {
  await S.menu('measurements', 'Measurements');
  const bs = await batchesOf(ids.ccd);
  const lines = ['Sample Name,Zeta Potential (mV),Conductivity (mS/cm)'];
  for (const b of bs) { const p = await paramsOf(b); const z = truth(p).zeta_mV; for (let k = 1; k <= 3; k++) lines.push(`${b}_final ${k},${(z + R.g() * 0.9).toFixed(2)},${(0.9 + R.g() * 0.05).toFixed(3)}`); }
  await S.select('#importTest', 'zeta', 'import type: Zeta potential');
  await S.upload('#csvFile', { name: 'CCD_zeta.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n')) }, 'drop the zeta export');
  const pv = await S.read('#importPreview', 'read the preview');
  const matched = Number(/(\d+) matched/.exec(pv)?.[1] || 0);
  if (matched < 18) S.note('check', `Zeta import matched ${matched} of 18.`, 'major');
  await S.click('#doImport', 'Import selected', { wait: 500 });
  await probeImportEval('CCD zeta file');
});

await S.runTask('T13', 'Evaluate the CCD: fit, diagnostics, optimum', 'expert', async () => {
  await S.menu('doe', 'Design & results');
  await S.select('select[name=expSel]', ids.ccd, 'choose the CCD');
  if (await S.exists('#coefFold > summary')) await S.click('#coefFold > summary', 'open the coefficients and the one-response optimum');
  const t = await S.read('#main', 'read the fit');
  const r2 = Number(/R² ([\d.]+)/.exec(t)?.[1]);
  S.note('calc', `Size model R² ${r2} on 18 runs (truth has curvature in FRR and flow; noise sd ~2.5 nm).`, r2 > 0.8 ? 'ok' : 'check');
  const opt = /Predicted closest to target[\s\S]*?FRR\s+([\d.]+)[\s\S]*?(?:flow_rate|total flow)\s+([\d.]+)[\s\S]*?(?:PEG_mol_pct|PEG mol%)\s+([\d.]+)/.exec(t);
  if (opt) {
    const p = { frr: Number(opt[1]), tfr: Number(opt[2]), peg: Number(opt[3]), np: 6 };
    const d = desirability(truth(p));
    S.note('calc', `DoE size-only optimum FRR ${p.frr}, flow ${p.tfr}, PEG ${p.peg}: true desirability ${d.toFixed(3)} (true best ${truthOpt.d.toFixed(3)} at FRR ${truthOpt.frr.toFixed(2)}, flow ${truthOpt.tfr}, PEG ${truthOpt.peg.toFixed(2)}).`, 'info');
    truthLog.push({ batchId: 'doe-optimum (predicted)', ...p, trueD: d });
  } else S.note('check', 'Could not read the predicted optimum off the DoE screen.', 'minor');
  if (await S.exists('#balanceCard')) {
    const bt = await S.read('#balanceCard', 'read the balanced recommendation');
    const num = (k) => Number(new RegExp(k + '\\s+([\\d.]+)').exec(bt)?.[1]);
    const p = { frr: num('FRR'), tfr: num('(?:flow_rate|total flow)'), peg: num('(?:PEG_mol_pct|PEG mol%)'), np: 6 };
    if ([p.frr, p.tfr, p.peg].every(Number.isFinite)) {
      const d = desirability(truth(p));
      S.note('calc', `DoE balanced recommendation FRR ${p.frr}, flow ${p.tfr}, PEG ${p.peg}: true desirability ${d.toFixed(3)}.`, 'info');
      truthLog.push({ batchId: 'doe-balance (predicted)', ...p, trueD: d });
    }
  }
  S.probe('doe.multiResponse', 'The DoE screen balances size, PDI and EE into one recommended setting', /desirability|overall|all responses|balanc/i.test(t));
  S.probe('fig.export', 'A graph can be saved as an image (SVG/PNG) for a slide', await page.locator('#main button, #main a').filter({ hasText: /svg|png|save (figure|graph|plot)|download (figure|graph|plot)/i }).count() > 0);
  await S.shot('doe-results', { full: true });
  for (const r of ['PDI', 'encapsulation_efficiency']) { await S.select('select[name=response]', r, `response ${r}`); await S.read('#main', `read ${r} fit`); }
});

await S.runTask('T14', 'Optimize: ML round 1 → make the suggestions → measure → round 2', 'expert', async () => {
  await S.menu('ml', 'Optimizer');
  await S.read('#main', 'read what the optimizer knows');
  await S.click('#runBtn', 'Fit and suggest', { wait: 300 });
  await page.waitForFunction(() => /What to run next/.test(document.querySelector('#main')?.innerText || ''), null, { timeout: 30000 });
  const t0 = await S.read('#main', 'read the suggestions');
  if (await S.exists('#modelFold > summary')) await S.click('#modelFold > summary', 'open the model report');
  const t = t0 + (await page.locator('#main').innerText());
  const q2 = /Cross-validated Q²[^\d-]*(-?[\d.]+)/.exec(t)?.[1] ?? /Q² (-?[\d.]+)/.exec(t)?.[1];
  S.note('info', `ML round 1 fitted (cross-validated Q² ${q2 ?? '?'}).`);
  await S.shot('ml-round1', { full: true });
  await S.click('#makeExp', 'Make these runs', { wait: 800 });
  const expId = /Experiment (\d+)/.exec(await page.locator('#main .crumb').innerText().catch(() => ''))?.[1];
  ids.ml1 = expId ? 'E' + expId : null;
  if (!ids.ml1) throw new Error('no experiment created from suggestions');
  const bs = await batchesOf(ids.ml1);
  await S.menu('measurements', 'Measurements');
  const lines = ['Sample Name,Z-Average (d.nm),PdI'];
  const ms = {};
  for (const b of bs) { ms[b] = await bench(b); lines.push(`${b}_final,${ms[b].zave_nm.toFixed(1)},${ms[b].pdi.toFixed(3)}`); }
  await openPaste();
  await S.paste('#pasteBox', lines.join('\n'), 'paste DLS for the suggestions');
  await S.click('#pasteGo', 'Read what I pasted', { wait: 500 });
  await S.click('#doImport', 'Import selected', { wait: 500 });
  await enterEe(bs.map((b) => [`${b}_final`, ms[b]]));
  await S.go(`experiments?id=${ids.ml1}`, 'how did the predictions do?');
  await S.read('#main', 'read predicted vs measured');
  await S.shot('ml-round1-scored', { full: true });
  await S.menu('ml', 'Optimizer');
  await S.click('#runBtn', 'Fit and suggest again', { wait: 300 });
  await page.waitForFunction(() => /What to run next/.test(document.querySelector('#main')?.innerText || ''), null, { timeout: 30000 });
  await S.read('#main', 'read round 2');
  await S.click('#makeExp', 'Make round 2', { wait: 800 });
  const e2 = /Experiment (\d+)/.exec(await page.locator('#main .crumb').innerText().catch(() => ''))?.[1];
  if (e2) ids.ml2 = 'E' + e2;
});

await S.runTask('T25', 'Optimize: measure round 2 and ask for round 3', 'expert', async () => {
  if (!ids.ml2) throw new Error('no round 2 to measure');
  const bs = await batchesOf(ids.ml2);
  await S.menu('measurements', 'Measurements');
  const lines = ['Sample Name,Z-Average (d.nm),PdI'];
  const ms = {};
  for (const b of bs) { ms[b] = await bench(b); lines.push(`${b}_final,${ms[b].zave_nm.toFixed(1)},${ms[b].pdi.toFixed(3)}`); }
  await openPaste();
  await S.paste('#pasteBox', lines.join('\n'), 'paste DLS for round 2');
  await S.click('#pasteGo', 'Read what I pasted', { wait: 500 });
  await S.click('#doImport', 'Import selected', { wait: 500 });
  await probeImportEval('ML round 2 paste');
  await enterEe(bs.map((b) => [`${b}_final`, ms[b]]));
  await S.menu('ml', 'Optimizer');
  await S.click('#runBtn', 'Fit and suggest (round 3)', { wait: 300 });
  await page.waitForFunction(() => /What to run next/.test(document.querySelector('#main')?.innerText || ''), null, { timeout: 30000 });
  const t = await S.read('#main', 'is it still worth more batches?');
  const best = /best (?:run )?so far[^\d]*(0\.\d+)/i.exec(t)?.[1];
  S.note('info', `After two rounds the optimizer's own best score so far reads ${best ?? '?'}.`);
  await S.shot('ml-round3', { full: false });
});

await S.runTask('T15', 'Screening: Plackett-Burman on five factors, and a Box-Behnken I delete again', 'expert', async () => {
  await newExperiment('doe', 'DoE');
  await S.fill('input[name=name]', 'PB screen 5 factors', 'name');
  for (const k of ['peg_pct', 'np', 'quench']) await S.click(`[data-addf=${k}]`, `+ ${k}`);
  await S.select('select[name=doe_designType]', 'plackett_burman', 'design: Plackett-Burman');
  await S.select('select[name=doe_model]', 'linear', 'model: main effects');
  const pv = await S.read('#main', 'run count');
  const pbRuns = /(\d+) runs: ([^—\n]*)/.exec(pv);
  S.note(pbRuns && /8 factorial/.test(pbRuns[2]) ? 'calc' : 'bug', `Plackett-Burman for 5 factors: ${pbRuns ? pbRuns[1] + ' runs (' + pbRuns[2].trim() + ')' : '?'}. A PB design for 5 factors has 8 runs plus centres; 7 means the all-high run is missing and the columns are not balanced.`, pbRuns && /8 factorial/.test(pbRuns[2]) ? 'ok' : 'major');
  ids.pb = await createAndRead('pb');
  await newExperiment('doe', 'DoE');
  await S.fill('input[name=name]', 'BBD to delete', 'name');
  await S.click('[data-addf=peg_pct]', '+ PEG');
  await S.select('select[name=doe_designType]', 'bbd', 'design: Box-Behnken');
  await S.select('select[name=doe_model]', 'quadratic', 'model: quadratic');
  ids.bbd = await createAndRead('bbd');
  await S.click('#delExp', 'Delete experiment', { wait: 400 });
  const left = (await readCol('experiments')).some((e) => e.id === ids.bbd);
  if (left) S.note('bug', 'Deleting the Box-Behnken did not remove it.', 'major');
  S.probe('safety.undo', 'A deleted experiment can be restored (undo or trash)', /undo|restore|trash/i.test(await page.locator('body').innerText()));
});

await S.runTask('T24', 'Measure the screening design and read which factors matter', 'expert', async () => {
  await S.menu('measurements', 'Measurements');
  await S.selectByText('#waitExp', 'PB screen', 'waiting for: the PB screen');
  const sheet = await S.download('#blankSheet', 'Blank sheet (CSV)');
  const pbB = await batchesOf(ids.pb);
  const names = fs.readFileSync(sheet, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(',')[0]).filter((n) => pbB.includes(n.replace(/_final$/, '')));
  const meas = {}; const samples = [];
  for (const n of names) { const b = n.replace(/_final$/, ''); meas[b] = await bench(b); samples.push({ name: n, runs: meas[b].runs }); }
  await S.upload('#csvFile', { name: 'PB_zetasizer_export.csv', mimeType: 'text/csv', buffer: Buffer.from(zetasizerCsv(samples)) }, 'drop the export');
  await S.click('#doImport', 'Import selected', { wait: 600 });
  await probeImportEval('PB file');
  await enterEe(names.map((n) => [n, meas[n.replace(/_final$/, '')]]));
  await S.menu('doe', 'Design & results');
  await S.select('select[name=expSel]', ids.pb, 'choose the PB screen');
  const t = await S.read('#main', 'which factors matter?');
  // The screen leads with a sentence per response ("Size falls with FRR (−32 nm …) and …"); the Pareto that
  // used to be read here is folded under "All diagnostic plots" since cycle 4.
  const top = /\bSize\s+(?:falls|rises)\s+with\s+([A-Za-z_]+)/.exec(t)?.[1]
    ?? /WHICH TERMS ARE REAL(?:\s*SVG\s*PNG)?[\s\S]*?\n([A-Za-z_]+)/i.exec(t)?.[1];
  S.note('calc', `PB screen for size: the app's first term is ${top ?? '?'}; the truth says FRR and PEG dominate size, N/P is small, quench has no effect.`, top && /FRR|PEG/.test(top) ? 'ok' : 'check');
  await S.shot('pb-results', { full: true });
});

await S.runTask('T16', 'Insights: does the second stock lot shift the size?', 'expert', async () => {
  await S.menu('insights', 'Insights');
  await S.select('select[name=colorBy]', 'stockId', 'colour by stock lot');
  const t = await S.read('#main', 'read the lot effect');
  S.note(/Stock-002/.test(t) ? 'good' : 'check', `Insights by stock lot ${/Stock-002/.test(t) ? 'separates Stock-001 and Stock-002' : 'does not show Stock-002'} (true lot shift +4 nm).`);
  await S.shot('insights', { full: true });
});

await S.runTask('T17', 'Calendar: what is due, add a reminder, export', 'newcomer', async () => {
  await S.menu('calendar', 'Calendar');
  await S.read('#main', 'read upcoming');
  if (await S.exists('#evForm')) {
    await S.fill('#evForm input[name=title]', 'Order more DSPC', 'event title');
    await S.fill('#evForm input[name=date]', '2026-11-02', 'date');
    await S.click('#addEv', 'Add event');
  }
  if (await S.exists('#exportIcs')) await S.download('#exportIcs', 'Export .ics');
  await S.shot('calendar');
});

await S.runTask('T18', 'Planner: ask what to run next, then troubleshoot high PDI', 'newcomer', async () => {
  await S.menu('advisor', 'Plan an experiment');
  await S.click('a.adv-door[href="#/advisor?mode=wizard"]', 'Answer three questions');
  await S.click('[data-set="aim=size"]', 'aim: size');
  await S.click('[data-set="budget=medium"]', 'budget: medium');
  await S.click('[data-set="scope=process"]', 'scope: process');
  await S.read('#main', 'read the recommendation');
  await S.shot('planner');
  await S.go('advisor?mode=wizard&aim=trouble', 'start from a symptom');
  await S.click('[data-set="symptom=pdi"]', 'symptom: PDI too high');
  await S.read('#main', 'read the causes');
});

await S.runTask('T19', 'Export everything and restore it on a clean machine', 'newcomer', async () => {
  await S.menu('settings', 'Settings & export');
  const f = await S.download('#exportAll', 'Export all data (JSON)');
  const dump = JSON.parse(fs.readFileSync(f, 'utf8'));
  const n = Object.fromEntries(Object.entries(dump.collections || {}).map(([k, v]) => [k, v.length]));
  const ctx2 = await browser.newContext(); const p2 = await ctx2.newPage();
  await p2.goto(base + '#/settings'); await p2.waitForTimeout(800);
  p2.on('dialog', (d) => d.accept());
  await p2.setInputFiles('#importFile', f); await p2.waitForTimeout(800);
  const back = { experiments: (await readCol('experiments', p2)).length, measurements: (await readCol('measurements', p2)).length };
  S.write({ action: 'upload', target: '#importFile', label: 'restore on a clean browser', ok: true, dur_ms: 0, est_s: 8 });
  const ok = back.experiments === n.experiments && back.measurements === n.measurements;
  S.note(ok ? 'good' : 'bug', `Round trip: ${n.experiments} experiments / ${n.measurements} measurements exported, ${back.experiments} / ${back.measurements} restored.`, ok ? 'ok' : 'critical');
  await ctx2.close();
});

await S.runTask('T26', 'Fix a mistake: a result was typed wrong last week', 'newcomer', async () => {
  const b = (await batchesOf(ids.single))[0];
  await S.menu('measurements', 'Measurements');
  // the stored results are one line until opened
  if (await S.exists('#resultsList:not([open]) > summary')) await S.click('#resultsList > summary', 'open the stored results');
  await S.click(`#main a[href^="#/measurements?id="]:has-text("${b}_final")`, `open ${b}_final`);
  const t = await S.read('#main', 'look for a way to correct it');
  const canEdit = await S.exists('#main button:has-text("Edit"), #main a:has-text("Edit"), #main button:has-text("Correct")');
  S.probe('entry.edit', 'A stored result can be corrected (edit with a reason), not only deleted', canEdit);
  if (!canEdit) S.note('friction', 'A stored result can only be deleted, not corrected; fixing a typo means delete and re-enter, and the audit trail loses why.', 'major');
  void t;
});

await S.runTask('T27', 'Repeat an earlier experiment with one change', 'expert', async () => {
  await S.go(`experiments?id=${ids.cmp}`, 'open the comparison');
  const t = await S.read('#main', 'look for duplicate / repeat');
  const can = await S.exists('#main button:has-text("Duplicate"), #main a:has-text("Duplicate"), #main a:has-text("Repeat"), #main button:has-text("Repeat"), #main a:has-text("Copy"), #main button:has-text("Copy as new")');
  S.probe('exp.duplicate', 'An experiment can be repeated as a new one with its settings carried over', can);
  if (!can) S.note('friction', 'No way to repeat an experiment: every setting has to be entered again in the wizard.', 'minor');
  void t;
});

await S.runTask('T28', 'Make a figure for Monday\'s group meeting', 'expert', async () => {
  await S.go(`experiments?id=${ids.ref}`, 'open the repeats');
  if (await S.exists('#main [data-fig-dl="png"]')) {
    const f = await S.download('#main [data-fig-dl="png"]', 'save the graph as PNG');
    S.note('good', `Saved ${path.basename(f)} for the slide.`, 'ok');
  } else S.note('friction', 'No graph to save on the experiment page; a figure for a slide means exporting CSV and rebuilding it elsewhere.', 'major');
  S.probe('fig.export', 'A graph can be saved as an image (SVG/PNG) for a slide', await S.exists('#main [data-fig-dl]'));
});

await S.runTask('T29', 'Find an old result: what size did the first MC3 batch have?', 'newcomer', async () => {
  await S.menu('overview', 'Overview');
  const hasSearch = await S.exists('input[type=search], #search, [aria-label*="Search" i]');
  S.probe('nav.search', 'There is a search box that finds a formulation or sample by name', hasSearch);
  if (!hasSearch) S.note('friction', 'No search: finding a formulation means knowing which experiment it was in.', 'minor');
  await S.menu('experiments', 'Experiments');
  await S.clickText('First MC3 batch', 'open the experiment by name');
  const t = await S.read('#main', 'read the size');
  if (!/\d+\.\d \/ 0\.\d\d/.test(t)) S.note('check', 'The size was not visible on the experiment page.', 'minor');
});

await S.runTask('T30', 'Compare two recipes properly: two batches of each', 'expert', async () => {
  await newExperiment('comparison', 'Compare compositions');
  await S.fill('input[name=name]', 'PEG 1.5 vs 3, in duplicate', 'name');
  for (let i = 1; i <= 3; i++) await S.click('#addCmp', '+ Add composition');
  await S.selectByText('select[name=cmp_2]', 'high PEG', 'third arm: high PEG');
  await S.selectByText('select[name=cmp_3]', 'high PEG', 'fourth arm: high PEG');
  ids.cmp2 = await createAndRead('cmp2');
  const bs = await batchesOf(ids.cmp2);
  if (await S.exists('#markAllProduced')) await S.click('#markAllProduced', 'Mark all produced', { wait: 300 });
  await S.menu('measurements', 'Measurements');
  if (await S.exists('#gridOpen')) {
    const rows = []; for (const b of bs) { const m = await bench(b); rows.push([`${b}_final`, { zave_nm: m.zave_nm.toFixed(1), pdi: m.pdi.toFixed(3), ee_pct: m.ee_pct.toFixed(1) }]); }
    await gridEntry('in duplicate', rows);
  } else for (const b of bs) { const m = await bench(b); await typeDls(`${b}_final`, m); await typeEe(`${b}_final`, m); }
  await S.go(`experiments?id=${ids.cmp2}`, 'open the comparison');
  const t = await S.read('#main', 'is high PEG really smaller?');
  S.probe('exp.statsTest', 'With two batches per arm, the comparison reports a test between arms (p value)', /\bp\s*[=<≤]\s*0?\.\d|ANOVA|Welch|t-test/i.test(t));
  await S.shot('comparison-duplicate', { full: true });
});

await S.runTask('T31', 'A smaller screen: laptop 1280×720 and a tablet at 1024', 'newcomer', async () => {
  const pages = ['overview', `experiments?id=${ids.stab}`, 'measurements', `doe?id=${ids.ccd}`, 'formulation', 'ml'];
  const wide = [];
  for (const vp of [{ width: 1280, height: 720 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(vp);
    for (const h of pages) {
      await S.go(h, `${h} at ${vp.width}px`);
      const over = await page.evaluate(() => { const m = document.querySelector('#main'); return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, m ? m.scrollWidth - m.clientWidth : 0); });
      if (over > 4) wide.push(`${h} @${vp.width} (+${over}px)`);
    }
    await S.shot(`overview-${vp.width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  S.probe('layout.noHScroll', 'Key screens fit a 1024 px window without scrolling sideways', !wide.length, wide.join(', '));
  if (wide.length) S.note('friction', `Sideways scrolling on: ${wide.join(', ')}.`, 'minor');
});

await S.runTask('T32', 'Stability: which recipe holds up at 25 °C, and for how long?', 'expert', async () => {
  await S.go(`experiments?id=${ids.stab}`, 'open the stability study');
  const t = await S.read('#main', 'look for a rate and a shelf life');
  S.probe('stab.slope', 'Stability gives a rate of change per shelf (with CI) and when it would cross the QC limit', /(nm\/day|per day)[\s\S]{0,200}(CI|±)/i.test(t) && /(reach|cross|exceed)[\s\S]{0,80}(day|limit)/i.test(t));
});

await S.runTask('T33', 'At the bench: what do I set on the pumps for the first CCD run?', 'newcomer', async () => {
  const b = (await batchesOf(ids.ccd))[0];
  await S.go(`formulation?batch=${b}`, `open ${b}`);
  // above the inputs, with the pump flows in it: the first thing on the record after any warning about the recipe
  const top = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#main .card')].find((c) => /at the bench/i.test(c.innerText));
    const inputs = [...document.querySelectorAll('#main .card')].find((c) => /^\s*Inputs/.test(c.innerText));
    return { text: card?.innerText || '', above: !!card && (!inputs || card.compareDocumentPosition(inputs) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  S.probe('bench.card', 'The bench record shows the volumes and pump flows to set at the top', top.above && /mL\/min/.test(top.text));
  await S.shot('bench-record-top');
});

await S.runTask('T34', 'Two weeks later: what is due and what did I miss?', 'newcomer', async () => {
  // the lab moves on: the app is opened on 10 November, after the T7 timepoints and with T14 due
  await page.clock.setFixedTime(new Date('2026-11-10T09:00:00+01:00'));
  await S.go('overview', 'open the app two weeks later');
  const t = await S.read('#main', 'what needs doing?');
  const stabName = 'Storage';
  S.probe('time.dueVisible', 'Two weeks on, the overview names the stability timepoints due or overdue', new RegExp(`(due|overdue)[\\s\\S]{0,400}(T14|${stabName}|E5)`, 'i').test(t) || /(T14|E5-F\d_\w+_T14)[\s\S]{0,200}(due|overdue)/i.test(t));
  await S.shot('overview-two-weeks');
  await S.menu('measurements', 'Measurements');
  const w = await S.read('#main', 'what is the lab waiting for?');
  if (!/overdue|past due/i.test(w)) S.note('check', 'Two weeks on, the Measurements screen does not say anything is past due.', 'minor');
  await page.clock.setFixedTime(new Date('2026-10-27T09:30:00+01:00'));
});

await S.runTask('T35', 'Print the comparison for the lab notebook', 'expert', async () => {
  await S.go(`experiments?id=${ids.cmp2 || ids.cmp}`, 'open the comparison');
  const btn = page.locator('#main button, #main a').filter({ hasText: /^\s*(Report|Print report|Notebook report)\s*$/i }).first();
  if (!(await btn.count())) { S.probe('exp.report', 'An experiment prints as a notebook report (plan, data, statistics, figures)', false, 'no report button'); S.note('friction', 'No printable report: a notebook page means exporting CSV and saving figures one by one.', 'minor'); return; }
  const [pop] = await Promise.all([context.waitForEvent('page', { timeout: 5000 }).catch(() => null), btn.click()]);
  S.write({ action: 'click', target: 'Report', label: 'Report', ok: !!pop, dur_ms: 0, est_s: 1.5 });
  let ok = false;
  if (pop) { await pop.waitForTimeout(800); const html = await pop.content(); ok = /<svg/i.test(html) && /±/.test(html) && /(p\s*[=<]|Welch|ANOVA|CV)/i.test(html); await pop.close(); }
  S.probe('exp.report', 'An experiment prints as a notebook report (plan, data, statistics, figures)', ok);
});

await S.runTask('T36', 'A colleague’s instrument: German Zetasizer export, UTF-16', 'expert', async () => {
  await newExperiment('reference', 'Reference reproducibility');
  await S.fill('input[name=name]', 'Repeats measured on the German Zetasizer', 'name');
  await S.fill('input[name=ref_n]', '3', 'repeats');
  ids.de = await createAndRead('de');
  const bs = await batchesOf(ids.de);
  const lines = ['Messdatei: LNP_Lab_Oktober.dts', 'Bediener: GM', '', 'Datensatz\tProbenname\tZ-Mittelwert (d.nm)\tPdI\tAbgeleitete Zählrate (kcps)\tMessdatum'];
  let rec = 1;
  for (const b of bs) { const m = await bench(b); m.runs.forEach((r, i) => lines.push(`${rec++}\t${b}_final ${i + 1}\t${r.zave_nm.toFixed(2).replace('.', ',')}\t${r.pdi.toFixed(3).replace('.', ',')}\t${r.countRate_kcps.toFixed(0)}\t27.10.2026 14:0${i}`)); }
  const text = lines.join('\r\n') + '\r\n';
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  await S.menu('measurements', 'Measurements');
  await S.upload('#csvFile', { name: 'Zetasizer_Export_DE.txt', mimeType: 'text/plain', buffer: buf }, 'drop the German UTF-16 export');
  const pv = await S.read('#importPreview', 'read the preview').catch(() => '');
  const matched = Number(/(\d+) matched/.exec(pv)?.[1] || 0);
  S.probe('import.messy', 'A UTF-16, German, tab-separated Zetasizer export with metadata lines imports and matches', matched === 3, `${matched} matched`);
  if (matched) await S.click('#doImport', 'Import selected', { wait: 500 });
});

await S.runTask('T37', 'Delete, start over, then change my mind', 'newcomer', async () => {
  await newExperiment('single', 'Single formulation');
  await S.fill('input[name=name]', 'Throwaway', 'name');
  const gone = await createAndRead('throwaway');
  const b = (await batchesOf(gone))[0];
  // a result exists for it before it is deleted, and measurements are kept on delete
  await page.evaluate(async (id) => { const m = await lnpDb.read('measurements'); m.push({ id: 'orphan-check', batchId: id, test: 'dls', stage: 'final', date: '2026-10-27', values: { zave_nm: 333, pdi: 0.3 } }); await lnpDb.write('measurements', m); }, b);
  await S.click('#delExp', 'Delete', { wait: 400 });
  await newExperiment('single', 'Single formulation');
  await S.fill('input[name=name]', 'Fresh start', 'name');
  const fresh = await createAndRead('fresh');
  const t = await S.read('#main', 'is the new one clean?');
  S.probe('safety.idsUnique', 'A new experiment never reuses a deleted one’s number, so old results cannot attach to it', fresh !== gone && !/333/.test(t), `deleted ${gone}, new ${fresh}`);
  if (fresh === gone) S.note('bug', `The new experiment got the deleted one's number (${fresh}); the deleted formulation's kept result ${/333/.test(t) ? 'now shows on the new experiment' : 'would attach to it'}.`, 'critical');
});

/** Make and measure one optimizer round: DLS pasted as a block, EE as a RiboGreen block. */
async function measureRound(expId, label) {
  const bs = await batchesOf(expId);
  await S.menu('measurements', 'Measurements');
  const lines = ['Sample Name,Z-Average (d.nm),PdI'];
  const ms = {};
  for (const b of bs) { ms[b] = await bench(b); lines.push(`${b}_final,${ms[b].zave_nm.toFixed(1)},${ms[b].pdi.toFixed(3)}`); }
  await openPaste();
  await S.paste('#pasteBox', lines.join('\n'), `paste DLS for ${label}`);
  await S.click('#pasteGo', 'Read what I pasted', { wait: 500 });
  await S.click('#doImport', 'Import selected', { wait: 500 });
  await enterEe(bs.map((b) => [`${b}_final`, ms[b]]));
}
async function fitAndSuggest(what) {
  await S.menu('ml', 'Optimizer');
  await S.click('#runBtn', what, { wait: 300 });
  await page.waitForFunction(() => /What to run next/.test(document.querySelector('#main')?.innerText || ''), null, { timeout: 30000 });
}

await S.runTask('T38', 'Optimize: rounds 3 and 4, and when to stop', 'expert', async () => {
  // T25 measured round 2 and asked for round 3: make it, measure it, and ask again
  await fitAndSuggest('Fit and suggest (round 3)');
  await S.read('#main', 'read round 3');
  await S.click('#makeExp', 'Make round 3', { wait: 800 });
  const e3 = /Experiment (\d+)/.exec(await page.locator('#main .crumb').innerText().catch(() => ''))?.[1];
  if (!e3) throw new Error('no round 3 experiment');
  ids.ml3 = 'E' + e3;
  await measureRound(ids.ml3, 'round 3');
  await fitAndSuggest('Fit and suggest (round 4)');
  const t = await S.read('#main', 'is another round worth four more batches?');
  // The campaign benchmark (tests/usability/campaign.mjs) finds that after about three rounds the gains are
  // inside the batch-to-batch noise. Does the screen say so, or only offer more runs?
  const stop = /\b(stop|diminishing|no longer (improv|gain)|unlikely to (beat|improve)|within (the )?noise|plateau|enough rounds|confirm (the|your) best)/i.test(t);
  S.probe('ml.stopAdvice', 'After several rounds the optimizer says whether another round is worth its batches', stop);
  if (!stop) S.note('friction', 'After four optimizer rounds the screen still only offers more runs. Nothing says the last rounds stopped improving, or that the gains left are within the batch-to-batch noise and the best run should be confirmed instead.', 'major');
  await S.shot('ml-round4', { full: false });
});

await S.runTask('T39', 'The disk is full: create an experiment anyway', 'newcomer', async () => {
  await newExperiment('single', 'Single formulation');
  await S.fill('input[name=name]', 'Saved on a full disk', 'name');
  await page.evaluate(() => window.lnpDb.failWrites('QuotaExceededError'));
  await S.click('#createExp', 'Create experiment', { wait: 1500 });
  const t = await S.read('#main', 'what happened?');
  const plain = /not saved/i.test(t) && /storage is full/i.test(t) && !/Uncaught|QuotaExceededError|setItem/.test(t);
  S.probe('safety.fullDiskPlain', 'A save on a full disk says so in plain words and leaves nothing half-saved', plain);
  const kept = await page.evaluate(() => [...document.querySelectorAll('#main input, #main textarea')].some((el) => el.value === 'Saved on a full disk'));
  S.probe('safety.fullDiskKeepsInput', 'After a failed save, what was typed is still there to save again', kept);
  if (!kept) S.note('friction', `After the failed save the screen ${/No experiment/i.test(t) ? 'shows "No experiment …" under the note' : 'has moved on'}, and what was typed into the wizard is gone: once space is freed, the experiment has to be set up again.`, 'major');
  await S.shot('full-disk');
  await page.evaluate(() => window.lnpDb.failWrites(null));
  // Room again: do what the note says. "Try again" is offered only while something waits to be written;
  // after an undone create there is nothing, and the note says to press the wizard's button again.
  if (await S.exists('#storageRetry')) await S.click('#storageRetry', 'Try again', { wait: 800 });
  else if (await S.exists('#createExp')) await S.click('#createExp', 'Create experiment again', { wait: 800 });
});

await S.runTask('T20', 'Overview at the end of the day', 'newcomer', async () => {
  await S.menu('overview', 'Overview');
  const t = await S.read('#main', 'what needs attention?');
  S.probe('overview.results', 'The overview shows the latest results as a graph, not only a table', (await charts()) > 0);
  void t;
  await S.shot('overview-end', { full: true });
});

// ---------------------------------------------------------------- the score
const madeRuns = truthLog.filter((x) => x.measured && !x.condition);
const bestMade = madeRuns.reduce((a, b) => (!a || b.trueD > a.trueD ? b : a), null);
const byPhase = (pred) => { const xs = truthLog.filter(pred); return xs.length ? Math.max(...xs.map((x) => x.trueD)) : null; };
const optimization = {
  trueOptimum: truthOpt,
  defaultRecipeD: desirability(truth({ frr: 3, tfr: 112.5, np: 6, peg: 1.5 })),
  bestBeforeMl: byPhase((x) => x.measured && !x.condition && ![ids.ml1, ids.ml2, ids.ml3].some((e) => e && x.batchId.startsWith(e + '-'))),
  bestMlRound1: ids.ml1 ? byPhase((x) => x.batchId.startsWith(ids.ml1 + '-')) : null,
  bestMlRound2: ids.ml2 ? byPhase((x) => x.measured && x.batchId.startsWith(ids.ml2 + '-')) : null,
  bestMlRound3: ids.ml3 ? byPhase((x) => x.measured && x.batchId.startsWith(ids.ml3 + '-')) : null,
  doeOptimumD: truthLog.find((x) => x.batchId.startsWith('doe-optimum'))?.trueD ?? null,
  doeBalanceD: truthLog.find((x) => x.batchId.startsWith('doe-balance'))?.trueD ?? null,
  bestMade,
};
fs.writeFileSync(path.join(out, 'truth.json'), JSON.stringify({ ids, truthLog }, null, 2));
const sum = S.finish({ optimization, ids });
console.log(`\n${sum.tasks_ok}/${sum.tasks_total} tasks · ${sum.actions} actions (${sum.clicks} clicks, ${sum.fills} fields, ${sum.chars_typed} chars) · ~${sum.est_human_min} min for a person · probes ${sum.probes_pass}/${sum.probes_total} · page errors ${sum.pageErrors.length}`);
console.log('optimization', JSON.stringify({ ...optimization, trueOptimum: undefined, bestMade: undefined }));
await browser.close(); srv.close();
