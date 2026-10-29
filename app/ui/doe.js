// Screen: DoE — design and run table, the fitted model and its diagnostics,
// quick in-app fit with p-values, and the OFAT dose-response view.
//
// With results in, the screen reads top down in the order a decision is made: the one setting that balances
// every response, then a sentence per response on what drives it, then a sentence on whether to believe that
// fit, with the one picture that shows why. The other diagnostic plots, the run table, the coefficient table
// and the exports are reference material for after the decision, so they fold to one line each that says
// what is in them. Before anything is measured the design itself is the only thing worth reading, and it comes
// first, open.
import { raw, fmt, field, table, chip, header, fmtDate, kpi, download, toast, todayISO, esc } from './kit.js';
import { FACTORS, TYPES, productionDate, isCategoricalFactor, levelText } from '../calc/experiment.js';
import { DESIGN_TYPES, MODEL_TYPES, MIXTURE_ORDERS, RESPONSES, designSummary, responsesForBatch, toRawDataCSV, toDesignCSV, toReal, specMode, specComponents, designColumns, processOrderOf, factorLabel, termLabel, isCategorical, categoricalName } from '../calc/doe.js';
import { scheffeTerms, processTerms, crossedTerms, fitMixture, toPseudo } from '../calc/mixture.js';
import { mixtureDesignFor } from '../calc/doe.js';
import { designTableModel, designSubtitle } from '../calc/designtable.js';
import { paretoEffects, residualPoints, qqPoints, qqLine, surfaceGrid, effectLines, blendTrace, sigfig, processDrivers, blendDrivers, driverSentence, fitVerdict } from '../calc/diagnostics.js';
import { paretoSvg, residualSvg, qqSvg, obsPredSvg, surfaceSvg, surface3dSvg, surface3dOpeningYaw, SURFACE3D_PITCH, effectSvg, traceSvg } from './doeplots.js';
import { tablePdf, tableCsv, tableTsv } from '../calc/pdf.js';
import { designSvgFromRuns, designCaption, blendSvgFromRuns, blendCaption, blendLabels } from './designviz.js';
import { describeId } from '../schema.js';
import { getSettings, getRef } from '../refdata.js';
import { balanceColumn } from '../calc/composition.js';
import { info, wireLearn } from './learn.js';
import { ols } from '../calc/stats.js';
import { flatRows } from './insights.js';
import { balancedOptimum, boxTerms } from '../calc/balance.js';
import { wireFigures } from './charts.js';
import { openReport } from './report.js';
import { gridHtml, wireGrid, GRID_FIELDS } from './resultgrid.js';
import { experimentResults, resultsCsv } from '../calc/results.js';
import { resultsCard, resultFigures, wireResults } from './resultsview.js';
import { figure } from './charts.js';

const RESP = { zave_nm: 'Z-average (nm)', pdi: 'PDI', ee_pct: 'EE (%)', zeta_mV: 'Zeta (mV)' };
const SHORT = { particle_size_nm: 'Size (nm)', PDI: 'PDI', encapsulation_efficiency: 'EE (%)', zeta_potential_mV: 'Zeta (mV)', rna_content_mg_mL: 'RNA (mg/mL)' };
/** The response as the subject of a sentence, where the unit in brackets would get in the way. */
const WORD = { particle_size_nm: 'Size', PDI: 'PDI', encapsulation_efficiency: 'EE', zeta_potential_mV: 'Zeta', rna_content_mg_mL: 'RNA content', size_drift: 'Size drift' };
const UNIT = Object.fromEntries(RESPONSES.map((r) => [r.name, r.unit || '']));
const p3 = (p) => raw(`<span style="white-space:nowrap">${p == null ? '–' : p < 0.001 ? '&lt; 0.001' : fmt(p, 3)}</span>`);
const stars = (p) => (p == null ? '' : p < 0.001 ? '***' : p < 0.01 ? '**' : p < 0.05 ? '*' : '');
/** The SVG / PNG buttons of charts.js, for a diagnostic plot that already has its own heading. */
const dlButtons = '<span class="fig-dl"><button type="button" data-fig-dl="svg" title="Save this graph as SVG">SVG</button><button type="button" data-fig-dl="png" title="Save this graph as a PNG image">PNG</button></span>';
const figHead = (title, name) => `<div class="fig-head"><h3 style="flex:1;margin:0">${title}</h3>${dlButtons}</div>`;
const mono = (s) => `<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px">${s}</span>`;

/**
 * A factor setting to the precision its range supports: about a tenth of the range, so 63 mL/min on a 60–120
 * range, FRR 3.9 on 2–4 and PEG 1.9 on 1–2.5 mol%. Finer than that the model cannot tell two settings apart and
 * the pump cannot hold them; "4.000" for a ratio of four only makes the reader check the decimals.
 */
function setting(f, v) {
  // a mixer is a name, whether it is given its code or its "real" value (the same −1/+1, calc/doe.js)
  if (isCategorical(f)) return Number.isFinite(v) ? categoricalName(f, v) : '–';
  if (!Number.isFinite(v)) return '–';
  const span = Math.abs(Number(f.high) - Number(f.low));
  const dp = span > 0 ? Math.max(0, Math.min(4, -Math.floor(Math.log10(span / 10)))) : 2;
  return Number(v.toFixed(dp)).toLocaleString('en-US', { maximumFractionDigits: dp });
}

/**
 * Which folds the user has opened or closed, per experiment. Every select on this screen redraws it from the
 * URL, so the choice has to outlive a render: a module variable keeps it for the session, the way the 3D view
 * below keeps its angle. Only a click is recorded, never the default, so a fold that opens by default (the run
 * table of an unmeasured design) still closes by default once there are results to lead with.
 */
const folds = new Map();

/**
 * The blend to read a blend model from: the centre replicates when the design has them, else the mean of the
 * runs, which is inside the region because the region is convex.
 */
function blendReference(measured, comps) {
  const centre = measured.find((r) => r.point_type === 'center') || measured.find((r) => r.point_type === 'centroid');
  return comps.map((c) => (centre ? centre.real[c.name] : measured.reduce((a, r) => a + r.real[c.name], 0) / measured.length));
}

/** Latest measured value per response for a batch (final stage preferred). */
const responseValues = (measurements, batchId, driftBasis) =>
  responsesForBatch(measurements, batchId, { driftBasis }).values;

export async function render(el, ctx) {
  // Every experiment has results to read, not only a designed one: a reference set, a comparison and a stability
  // study were read on their experiment page, so the results of five of the seven demo experiments could not be
  // found here. Each type is read the way its own statistics are: a design through its model, the rest through
  // the Results card the experiment page shows.
  const exps = ctx.store.all('experiments').sort((a, b) => (b.startDate || '').localeCompare(a.startDate || '') || expNo(b.id) - expNo(a.id));
  const sel = (ctx.params.id && exps.find((e) => e.id === ctx.params.id)) || lastWorkedOn(ctx, exps) || exps[0];
  const settings = getSettings(ctx);
  let body = '', pinned = '', read = null;
  if (sel?.type === 'doe' && sel.design?.doe?.spec) { body = doeBody(el, ctx, sel); pinned = doePinned(sel, ctx); }
  else if (sel?.type === 'doe') body = `<div class="note warn">${describeId(sel.id)} was created before the design generator was wired in, so it has no run table. Create it again from the wizard.</div>`;
  else if (sel) { read = resultsBody(ctx, sel, settings); ({ body, pinned } = read); }
  const data = sel ? dataCard(ctx, sel, settings) : '';

  const byType = TYPES.map((t) => [t, exps.filter((e) => e.type === t.id)]).filter(([, xs]) => xs.length);
  const options = exps.length
    ? byType.map(([t, xs]) => `<optgroup label="${esc(t.name)}">${xs.map((e) => `<option value="${esc(e.id)}"${e.id === sel?.id ? ' selected' : ''}>${esc(`${describeId(e.id)} · ${e.name || ''}`)}</option>`).join('')}</optgroup>`).join('')
    : '<option value="">No experiments yet</option>';
  el.innerHTML = header('Evaluate', 'Design & results', `${sel ? '<button id="reportDoe" title="A page for the lab notebook: the plan, the recommendation, what drives each response, the coefficients, the diagnostic plots and the run table, to print or save as PDF">Report</button>' : ''}<a class="btn primary" href="#/experiments?new=1&type=doe">New DoE</a><a class="btn" href="#/experiments?new=1&type=ofat">New OFAT</a><a class="btn" href="#/ml" title="fit a surface to every measured formulation, not just this design, and get the next runs proposed">Optimizer</a>`) +
    `<div class="card wsp-pick"><label for="expSel">Experiment</label><select id="expSel" name="expSel">${options}</select>
      ${sel ? `<span class="muted">${esc(TYPES.find((t) => t.id === sel.type)?.name || sel.type)}</span><a class="btn" href="#/experiments?id=${esc(sel.id)}">The plan</a>` : ''}</div>` +
    // The figure stays beside the data and the verdicts while the page scrolls: type a result on the left and the
    // surface or the bars on the right redraw with it, with no trip to another screen and back.
    (sel ? `<div class="wsp${pinned ? '' : ' nopin'}"><div class="wsp-main">${data}${body}</div>${pinned ? `<aside class="wsp-pin" id="pinned">${pinned}</aside>` : ''}</div>` : '');
  wireLearn(el);
  wireFigures(el);
  wireResults(el);
  el.querySelector('[name=expSel]').addEventListener('change', (e) => ctx.navigate('doe', { id: e.target.value }));
  // The model chosen above goes with it, so the printed coefficients are the ones on the screen.
  el.querySelector('#reportDoe')?.addEventListener('click', () => openReport(ctx, sel.id, { model: ctx.params.model }));
  if (sel) wireData(el, ctx, sel, settings);
  // The Results card's export, as the experiment page wires it.
  el.querySelector('#exportResults')?.addEventListener('click', () => download(`${sel.id}_results.csv`,
    resultsCsv(read.res, { experimentId: sel.id, compositionName: (cid) => (cid != null ? read.compLabel(cid) : '') }), 'text/csv'));
  if (sel?.type === 'doe' && sel.design?.doe?.spec) wireDoe(el, ctx, sel);
  // every select on this screen is a view setting, so it travels in the URL and the screen redraws from it
  const views = ['response', 'model', 'fa', 'fb', 'ef', 'eg', 'at'];
  el.addEventListener('change', (ev) => {
    const name = ev.target?.name;
    if (!views.includes(name)) return;
    const next = { ...ctx.params, id: sel.id };
    for (const v of views) { const node = el.querySelector(`[name=${v}]`); if (node) next[v] = node.value; }
    ctx.navigate('doe', next);
  });
}

const expNo = (id) => Number(/^E(\d+)/.exec(String(id || ''))?.[1]) || 0;

/**
 * The experiment last worked on: created, or given a result (a result closes a slot of its experiment, which
 * stores the experiment again). That is the one someone arriving here without a choice is most likely after.
 */
function lastWorkedOn(ctx, exps) {
  return exps.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
}

/* ---------------- the data sheet ---------------- */

// A stability study's stages are its timepoints, T0 … T28, which sort by day and not by character.
const stageDay = (s) => Number(/^T(\d+)$/.exec(s)?.[1] ?? NaN);
const stageOrder = (a, b) => (s0(a) - s0(b)) || stageDay(a) - stageDay(b) || String(a).localeCompare(String(b));
const s0 = (s) => (s === 'final' ? 1 : /^T\d+$/.test(s) ? 2 : 0);

/**
 * The experiment's samples as one sheet, the way a lab notebook table is drawn: a row per sample, a column per
 * number, what is stored already filled in, and what is still due as cells to type or paste into. One stage at
 * a time (the final product, or one stability timepoint), because a stage is what one sitting at the
 * instrument covers; it opens on the first stage that still has something due.
 */
function dataCard(ctx, sel, settings) {
  const slots = (sel.expected || []).map((s) => ({ ...s, experimentId: sel.id }));
  const gridable = slots.filter((s) => GRID_FIELDS[s.test]);
  if (!gridable.length) return '';
  const stages = [...new Set(gridable.map((s) => s.stage))].sort(stageOrder);
  const openIn = (st) => gridable.some((s) => s.stage === st && s.status === 'open');
  const stage = stages.includes(ctx.params.stage) ? ctx.params.stage : stages.find(openIn) || stages[stages.length - 1];
  const rows = sheetRows(ctx, gridable.filter((s) => s.stage === stage));
  const open = gridable.filter((s) => s.status === 'open');
  const today = todayISO();
  const overdue = rows.filter((r) => r.tests.length && r.dueDate < today).length;
  const stored = gridable.filter((s) => s.status === 'done').length;
  const say = open.length ? `${stored} of ${gridable.length} results in · ${open.length} still due` : `all ${gridable.length} results in`;
  const tabs = stages.length < 2 ? '' : `<div class="seg wsp-stages" role="group" aria-label="Stage or timepoint">${stages.map((st) => `<button type="button" data-stage="${esc(st)}" class="${st === stage ? 'on' : ''}"${openIn(st) ? ' title="still has results due"' : ''}>${esc(st)}${openIn(st) ? ' •' : ''}</button>`).join('')}</div>`;
  // Folded to its line once every result is in: then the sheet is the record, and the reading below is the point.
  // Open while anything is due, because then typing into it is the next thing to do.
  const isOpen = folds.get(`${sel.id}:data`) ?? !!open.length;
  return `<details class="card fold" id="dataCard" data-datafold ${isOpen ? 'open' : ''}><summary><h2>Data</h2><span class="fold-say">${esc(say)}</span></summary>
    ${tabs ? `<div class="wsp-stagebar">${tabs}</div>` : ''}
    ${gridHtml(rows, settings, overdue, { done: true })}
    <p class="muted wsp-more">An instrument export goes in on <a href="#/measurements?waiting=${esc(sel.id)}">Measurements</a>, where it is matched by sample name; it lands in this sheet.</p></details>`;
}

/** One row per sample (vial) of a stage, with the slot of every test still due and the result of every test stored. */
function sheetRows(ctx, slots) {
  const byName = new Map();
  for (const s of slots) {
    let r = byName.get(s.sampleName);
    if (!r) byName.set(s.sampleName, r = { sampleName: s.sampleName, batchId: s.batchId, stage: s.stage, dueDate: s.dueDate, tests: [], slots: {}, done: {} });
    if (s.status === 'open') { if (!r.tests.includes(s.test)) r.tests.push(s.test); r.slots[s.test] ||= s; if (s.dueDate < r.dueDate) r.dueDate = s.dueDate; }
    else if (s.measurementId) { const m = ctx.store.get('measurements', s.measurementId); if (m) r.done[s.test] = m; }
  }
  return [...byName.values()];
}

function wireData(el, ctx, sel, settings) {
  el.querySelector('#dataCard > summary')?.addEventListener('click', (e) => { if (!e.target.closest('a, button')) folds.set(`${sel.id}:data`, !el.querySelector('#dataCard').open); });
  el.querySelectorAll('.wsp-stages [data-stage]').forEach((b) => b.addEventListener('click', () => ctx.navigate('doe', { ...ctx.params, id: sel.id, stage: b.dataset.stage })));
  const open = (sel.expected || []).filter((s) => s.status === 'open').map((s) => ({ ...s, experimentId: sel.id }));
  // Drawn again in place after a save, so the figures and the verdicts beside the sheet move with the numbers.
  wireGrid(el, ctx, settings, open, () => render(el, ctx));
}

/* ---------------- the pinned figure ---------------- */

/**
 * What stays in view beside the sheet for a design: the fitted surface of the response being read once there
 * is a model, and before that the design itself, so the shape of the experiment is in sight while it is set up
 * and run. diagnostics() has just worked out which surface (surfaceView), so this draws the same one.
 */
function doePinned(sel, ctx) {
  const { spec, runs } = sel.design.doe;
  const names = spec.factors.map((f) => f.name);
  const resp = spec.responses.map((r) => r.name);
  const respSel = resp.includes(ctx.params.response) ? ctx.params.response : resp[0];
  if (surfaceView) {
    // The same Contour / 3D switch as the figure in the diagnostics, and the two follow each other: the pinned
    // panel is where the surface is usually looked at, so a choice made in either holds for both.
    return `<div class="fig" data-fig="pinned-surface"><div class="fig-head"><h3 style="flex:1;margin:0">${esc(SHORT[respSel] || respSel)}: the fitted surface</h3>${dlButtons}</div>
      ${surfaceBox('pin')}<p class="muted wsp-cap">${surfaceMode === 'solid' ? 'The model fitted to the runs measured so far, as a surface' : 'Contour of the model fitted to the runs measured so far'}${surfaceView.slice ? `, with ${esc(surfaceView.slice)}` : ''}; ${surfaceMode === 'solid' ? 'the dots are the runs at their measured value' : 'the points are the runs'}${surfaceView.slice ? ' made there' : ''}. The axes${surfaceView.slice ? ', the mixer' : ''} and the response are chosen in Model fit.</p></div>`;
  }
  const mode = specMode(spec), sm = designSummary(spec, runs);
  const fig = mode === 'process'
    ? `${designSvgFromRuns(runs, names, { size: 250, names: names.map(factorLabel) })}<p class="muted wsp-cap">${designCaption(names.length, sm.byType, { grid: names.length > 3 })}</p>`
    : `${blendSvgFromRuns(runs, specComponents(spec), { size: 250, total: Number(spec.total) || 100 })}<p class="muted wsp-cap">${blendCaption(specComponents(spec).length, sm.byType, { crossed: mode === 'crossed' })}</p>`;
  return `<div class="fig" data-fig="pinned-design"><div class="fig-head"><h3 style="flex:1;margin:0">The design</h3>${dlButtons}</div>${fig}
    <p class="muted wsp-cap">The fitted surface takes its place once there are enough runs measured to fit the model.</p></div>`;
}

/* ---------------- every other experiment ---------------- */

/**
 * A single formulation, a reference set, a comparison or a stability study, read as its experiment page reads
 * it: the statistics in sentences, the figures and the data table. The lead figure is pinned beside the sheet.
 */
function resultsBody(ctx, sel, settings) {
  const batches = (sel.batchIds || []).map((id) => ctx.store.get('batches', id)).filter(Boolean);
  const res = experimentResults(sel, batches, ctx.store.all('measurements'), { qc: settings.qc });
  const ref = getRef(ctx);
  const compLabel = (id) => { const c = ref.compositionById[id]; return c ? `#${c.id}${c.synonym ? ' ' + c.synonym : ''}` : `#${id}`; };
  const rctx = { qc: settings.qc, compLabel, today: todayISO() };
  const g = resultFigures(sel, res, rctx);
  const lead = g.figs[0];
  const pinned = lead ? `${figure(lead.svg, lead)}${g.figs.length > 1 ? `<p class="muted wsp-cap">${g.figs.length - 1} more figure${g.figs.length === 2 ? '' : 's'} in Results, below.</p>` : ''}` : '';
  let body = resultsCard(sel, res, rctx);
  if (sel.type === 'ofat') body = ofatBody(ctx, sel) + body;
  return { body, pinned, res, compLabel };
}

/**
 * What the 3D surface is currently drawn from and turned to. diagnostics() builds the grid and wireDoe()
 * redraws it on every drag, and the two run one after the other in the same render, so a module variable is
 * enough and the alternative — 625 grid numbers serialised into a data- attribute — is not worth it.
 */
let surfaceView = null;

/**
 * Contour or 3D, for the pinned panel and the diagnostics figure alike, kept for the next visit: someone who
 * turned to the 3D view to see the shape usually wants it again. A preference of this browser, like the theme.
 */
const SURFACE_KEY = 'lnp-lab.surfaceMode';
let surfaceMode = (() => { try { return localStorage.getItem(SURFACE_KEY) === 'solid' ? 'solid' : 'flat'; } catch { return 'flat'; } })();

/**
 * The surface as a box with its switch: Contour or 3D, and with 3D a reset and the floor's contour lines. The
 * same markup in both places it appears, told apart by `where`; wireSurface() draws and turns every box at once.
 */
function surfaceBox(where) {
  const v = surfaceView, solid = surfaceMode === 'solid';
  return `<div class="surfbox" data-surfbox="${where}">
    <div class="surfbar"><div class="seg" role="group" aria-label="How to draw the surface"><button type="button" data-surf="flat" class="${solid ? '' : 'on'}" title="A map seen from above: read settings off it">Contour</button><button type="button" data-surf="solid" class="${solid ? 'on' : ''}" title="The predicted response as height, with the runs at their measured value">3D</button></div>
      <span class="surf3dOnly"${solid ? '' : ' hidden'}><button type="button" class="surfReset" title="Back to the opening angle">Reset view</button>
      <label class="inline surfFloor"><input type="checkbox" class="surfContours" ${v.contours ? 'checked' : ''} style="width:auto"> contours on the floor</label></span></div>
    <div class="surfFlat"${solid ? ' hidden' : ''}>${surfaceSvg(v.grid, v)}</div>
    <div class="surfSolid"${solid ? '' : ' hidden'}>${solid ? surface3dSvg(v.grid, v) : ''}</div></div>`;
}

/* ---------------- DoE ---------------- */
function doeBody(el, ctx, sel) {
  const { spec, runs } = sel.design.doe;
  // Drawn afresh for this experiment, or the pinned panel would go on showing the last design's surface.
  surfaceView = null;
  const measurements = ctx.store.all('measurements');
  const batches = Object.fromEntries(sel.batchIds.map((id) => [id, ctx.store.get('batches', id)]).filter(([, b]) => b));
  const names = spec.factors.map((f) => f.name);
  const resps = spec.responses.map((r) => r.name);
  const vals = Object.fromEntries(runs.map((r) => [r.run_id, responseValues(measurements, r.batchId)]));
  const complete = runs.filter((r) => resps.every((n) => vals[r.run_id][n] != null)).length;
  const sm = designSummary(spec, runs);
  const respSel = resps.includes(ctx.params.response) ? ctx.params.response : resps[0];
  const model = MODEL_TYPES[ctx.params.model] ? ctx.params.model : spec.model;

  // One model behind the table and all three exports, so what is read and what is exported cannot drift.
  const order = ctx.params.order === 'run' ? 'run' : 'std';
  // A design on PEG or ionizable mol% moves the sterol too (it takes up the difference); the table shows it.
  const balance = balanceColumn(spec, runs, sel.compositionId, getRef(ctx));
  const dt = designTableModel(spec, runs, { batches, values: vals, order, full: true, balance, label: factorLabel,
    responses: resps.map((n) => ({ name: n, label: SHORT[n] || n, unit: RESPONSES.find((r) => r.name === n)?.unit || '' })) });
  // The screen shows the same cells, with the point type as a chip and the lot as a link.
  const lotCol = dt.columns.findIndex((c) => c.key === 'lot');
  const runTable = table(dt.columns, dt.rows.map((cells) => ({ cells: cells.map((v, i) => {
    if (i === 0) { const m = /^(\S+) \((.+)\)$/.exec(v); return m ? raw(`${mono(m[1])} ${chip(m[2], m[2] === 'center' ? 'info' : '')}`) : v; }
    if (i === lotCol && v) return raw(`<a href="#/formulation?batch=${esc(v)}"><b>${esc(v)}</b></a>`);
    return v;
  }) })));

  // Quick in-app fit on coded settings. A blend is fitted as a Scheffe polynomial with no intercept — the
  // mol% already sum to a constant, so an intercept column would be a linear combination of them and the
  // normal equations singular. The coded values for a blend are its L-pseudo-components, which still sum to
  // one, so the coefficients mean what the mixture literature says they mean.
  const mode = specMode(spec);
  const comps = specComponents(spec);
  const mixTerms = mode === 'process' ? [] : scheffeTerms(comps.map((c) => c.name), spec.mixtureOrder || 'quadratic');
  // The process terms come from the builder the balanced optimum uses, so the card and the fits below it are
  // the same models, and each term knows whether it is a main effect, an interaction or a square.
  const terms = mode === 'process' ? boxTerms(names, model)
    : mode === 'mixture' ? mixTerms
    : crossedTerms(mixTerms, processTerms(names, processOrderOf({ ...spec, model })));
  // One fit per response, all made the same way: the summary reads every response, the plots and the
  // coefficient table read the selected one, and the two must not be able to disagree.
  const fitOf = (name) => {
    const measured = runs.filter((r) => vals[r.run_id][name] != null);
    const y = measured.map((r) => vals[r.run_id][name]);
    const fit = measured.length > terms.length
      ? (mode === 'process' ? ols(measured.map((r) => terms.map((t) => t.f(r.coded))), y) : fitMixture(measured.map((r) => r.coded), y, terms))
      : null;
    return { fit, measured };
  };
  const fits = Object.fromEntries(resps.map((n) => [n, fitOf(n)]));
  const { fit, measured } = fits[respSel];
  const anyFit = resps.some((n) => fits[n].fit?.beta);
  const goal = spec.responses.find((r) => r.name === respSel) || {};
  const withData = runs.filter((r) => resps.some((n) => vals[r.run_id][n] != null)).length;
  const fold = (key, dflt, title, say, body) => `<details class="card fold" id="${key}Fold" data-fold="${key}" ${(folds.get(`${sel.id}:${key}`) ?? dflt) ? 'open' : ''}>
      <summary><h2>${title}</h2><span class="fold-say">${say}</span></summary>${body}</details>`;
  const link = (p) => `#/doe?${new URLSearchParams(Object.entries({ ...ctx.params, id: sel.id, ...p }).filter(([, v]) => v != null && v !== '')).toString()}`;

  const design = mode === 'process'
    ? { help: info(spec.designType === 'plackett_burman' || spec.designType === 'full_factorial' ? 'screening' : 'rsm'), name: DESIGN_TYPES[spec.designType]?.name || spec.designType, sub: `${names.length} factors · model: ${spec.model}` }
    : { help: info('mixture'), name: mode === 'mixture' ? 'Lipid blend' : 'Blend and process',
      sub: `${comps.length} lipids${names.length ? ` · ${names.length} process factor${names.length === 1 ? '' : 's'}` : ''} · ${(MIXTURE_ORDERS[spec.mixtureOrder || 'quadratic'] || '').replace(/ —.*/, '').toLowerCase()} blending` };
  const byType = Object.entries(sm.byType).map(([k, v]) => `${v} ${k}`).join(' · ');
  // With results in, the design is background to the answer under it: one line rather than four tiles, as the
  // fit below and the folded run table say the rest (usability cycle 6, L1). Before, the tiles are the page.
  const kpis = anyFit
    ? `<div class="card" id="designLine"><p style="margin:0">${esc(design.name)} ${design.help} · ${esc(design.sub)} · ${sm.runs} runs ${info('center')} (${byType}), ${complete === sm.runs ? 'all' : `${complete} of ${sm.runs}`} measured for ${resps.length} response${resps.length === 1 ? '' : 's'}</p></div>`
    : `<div class="card"><div class="grid g4">
      ${kpi(raw(`Design ${design.help}`), design.name, design.sub)}
      ${kpi(raw(`Runs ${info('center')}`), sm.runs, byType)}
      ${kpi('Measured', `${complete} / ${sm.runs}`, `complete for ${resps.length} response${resps.length === 1 ? '' : 's'}`)}
      ${kpi('Model', fit?.r2 != null ? `R² ${fmt(fit.r2, 3)}` : '–', fit?.r2 != null ? `${fit.n} runs, ${fit.n - fit.p} residual df` : `${sm.terms} terms, ${sm.residualDf} residual df`)}
    </div></div>`;

  // The response and model selects stay outside every fold: they decide what the verdict below is about, and a
  // select that has to be found inside a closed section is a select nobody uses.
  // The next model up, for a verdict that finds a term missing; a quadratic needs a third level to stand on.
  const fuller = mode !== 'process' ? null
    : model === 'linear' ? 'the model with interactions (Model terms, above)'
    : model === 'interaction' && (DESIGN_TYPES[spec.designType]?.levels || 2) >= 3 ? 'the quadratic model (Model terms, above)' : null;
  const fitCard = `<div class="card" id="fitCard"><h2>Model fit</h2>
      <div class="grid g3" id="modelForm">${field({ id: 'response', label: 'Response', type: 'select', value: respSel, options: resps.map((n) => ({ value: n, label: SHORT[n] || n })) })}${field({ id: 'model', label: 'Model terms', type: 'select', value: model, options: Object.entries(MODEL_TYPES).map(([id, l]) => ({ value: id, label: l })) })}</div>
      ${fit?.beta
        ? diagnostics(fit, terms, names, spec, measured, goal, { ...ctx.params, response: respSel }, mode === 'process' ? [] : comps,
            { open: folds.get(`${sel.id}:plots`) ?? false, fuller }) || '<p class="muted">Too few runs to draw the diagnostics.</p>'
        : `<p class="muted">${esc(fit?.note || `Needs more than ${terms.length} runs with ${SHORT[respSel] || respSel} (${measured.length} so far).`)}</p>`}</div>`;

  const runsFold = fold('runs', !anyFit, 'Design and runs',
    `${sm.runs} runs, ${complete === sm.runs ? 'all measured' : `${complete} of ${sm.runs} measured`} · the table and the design diagram, as PDF, CSV or to paste`,
    `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px"><span style="flex:1"></span>
        <div class="seg" id="orderSeg" role="group" aria-label="Row order"><button type="button" data-order="std" class="${order === 'std' ? 'on' : ''}">Standard order</button><button type="button" data-order="run" class="${order === 'run' ? 'on' : ''}">Run order</button></div>
        <a class="btn" href="#/experiments?id=${sel.id}">The plan</a><a class="btn" href="#/formulation">Formulations</a></div>
      <div style="display:grid;grid-template-columns:minmax(0,2.3fr) minmax(220px,1fr);gap:18px;align-items:start">
        <div>${runTable}
          ${mode === 'process' ? '' : `<div class="muted" style="margin-top:2px">Lipids: ${comps.map((c) => `${c.name} ${sigfig(c.lo)}–${sigfig(c.hi)} mol%`).join(' · ')} — every run adds up to ${fmt(Number(spec.total) || 100, 0)}</div>`}
          ${!spec.factors?.length ? '' : `<div class="muted" style="margin-top:2px">${mode === 'process' ? 'Factors' : 'Process factors'}: ${spec.factors.map((f) => `${esc(factorLabel(f))} ${isCategorical(f) ? `${esc(categoricalName(f, -1))} / ${esc(categoricalName(f, 1))}` : `${sigfig(Number(f.low))} / ${sigfig(toReal(f, 0))} / ${sigfig(Number(f.high))}`}${f.applyTo ? (FACTORS.find((x) => x.key === f.applyTo)?.doeName === f.name ? '' : ` → ${FACTORS.find((x) => x.key === f.applyTo)?.name}`) : ' (record only)'}`).join(' · ')}${balance ? `. ${esc(balance.note)}` : ''}</div>`}
        </div>
        <div>${mode === 'process'
          ? `${designSvgFromRuns(runs, names, { size: 250, names: names.map(factorLabel) })}<p class="muted" style="font-size:11.5px;margin:8px 0 0">${designCaption(names.length, sm.byType, { grid: names.length > 3 })}</p>`
          : `${blendSvgFromRuns(runs, comps, { size: 250, total: Number(spec.total) || 100 })}<p class="muted" style="font-size:11.5px;margin:8px 0 0">${blendCaption(comps.length, sm.byType, { crossed: mode === 'crossed' })}</p>${mode === 'crossed' && names.length >= 2 ? `<div style="margin-top:12px">${designSvgFromRuns(runs, names, { size: 220, labels: blendLabels(), names: names.map(factorLabel) })}<p class="muted" style="font-size:11.5px;margin:8px 0 0">The process side of the same runs: ×n is how many blends were made at that setting. The colours are still the blend's point types, because that is what each run is.</p></div>` : ''}`}</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">
        <button id="expPdf">Export PDF</button><button id="expCsv">Export CSV</button><button id="expCopy">Copy for paste</button>
        <span class="muted">exactly the ${dt.rows.length} rows and ${dt.columns.length} columns above, in the order shown</span></div>`);

  const coef = fit?.beta ? coefficients(fit, terms, spec, goal, { mode, comps, names, respSel }) : null;
  const coefFold = coef ? fold('coef', false, 'Coefficients and the one-response optimum', coef.say, coef.html) : '';

  // Everything this design can say is said on this screen. The export is for taking the numbers somewhere
  // else — a paper, a statistics package, a colleague's spreadsheet — not a step in the workflow.
  const exportFold = fold('export', false, 'Take the data elsewhere', `the design and the measured data as CSV (${withData} of ${runs.length} runs have data)`,
    `<p class="muted">Two CSVs: the design as it was built, and the measured responses beside the settings that produced them. Both are written in the order the run table shows.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button id="expDesign">Export design CSV</button><button id="expRaw">Export measured data CSV (${withData} of ${runs.length} runs have data)</button></div>`);

  if (!anyFit) return kpis + runsFold + exportFold + fitCard;
  return kpis
    + (mode === 'process' ? balanceCard(spec, runs, vals, model) : '')
    + driversCard({ spec, mode, terms, comps, names, resps, fits, respSel, link })
    + fitCard + runsFold + coefFold + exportFold;
}

/**
 * One sentence per response on what drives it, read off the same fits as everything else on the page. This is
 * what the coefficient table and the Pareto say, in the words a formulator would use, so the tables can fold
 * away; the predicted R² sits beside each sentence because a sentence from a poor model reads just as fluently
 * as one from a good model.
 */
function driversCard({ spec, mode, terms, comps, names, resps, fits, respSel, link }) {
  // a process factor in the lab's words (FRR, total flow, PEG mol%); a lipid is already called what it is
  const word = (s) => esc(names.includes(s) ? factorLabel(s) : s);
  const items = resps.map((n) => {
    const { fit, measured } = fits[n];
    const label = `<a href="${esc(link({ response: n }))}" title="show the plots for ${esc(SHORT[n] || n)}"><b>${esc(WORD[n] || n)}</b></a>`;
    if (!fit?.beta) return `<li>${label}: ${esc(fit?.note || `needs more than ${terms.length} measured runs, ${measured.length} so far`)}.</li>`;
    const d = mode === 'process' ? processDrivers(fit, terms, spec.factors)
      : blendDrivers(fit, terms, comps, { total: Number(spec.total) || 100, reference: blendReference(measured, comps), factors: names.length ? spec.factors : [] });
    const q = fit.predR2;
    // Below 0.5 the model predicts a run it has not seen poorly, and the sentence above it reads no less sure
    // of itself for that; the warning goes on the same line so it is read with the number it qualifies.
    const weak = q == null || q < 0.5;
    const facts = [`R² ${fmt(fit.r2, 2)}`, ...(weak ? [] : [`predicted R² ${fmt(q, 2)}`]), ...(n === respSel ? ['plotted below'] : [])];
    // a PDI is read to three decimals and everything else here to two, so no change is quoted finer than that
    return `<li${n === respSel ? ' class="on"' : ''}>${driverSentence(label, d, { unit: UNIT[n], term: word, text: esc, maxDp: n === 'PDI' ? 3 : 2 })}
      <span class="muted">${facts.join(' · ')}</span>
      ${weak ? `<span class="chip warn" title="predicted R² measures how well the model predicts a run it was not fitted to">predicted R² ${q == null ? 'not available' : fmt(q, 2)}: below 0.5, a lead to check, not a finding</span>` : ''}</li>`;
  }).join('');
  // What a change means, said once and short: predicted R² has its own "?" beside the fit below.
  const how = mode === 'process'
    ? 'Each change is low to high across the range you ran, the other factors at their centre; terms with p < 0.05, strongest first.'
    : `Each lipid from the least to the most of it the region allows, the others falling in proportion${mode === 'crossed' ? '; each process factor across its range at the centre blend' : ''}; blending terms with p < 0.05.`;
  return `<div class="card" id="driversCard"><h2>What drives each response</h2>
    <ul class="drivers">${items}</ul>
    <p class="muted small">${how}</p></div>`;
}

/**
 * The coefficient table and the one-response optimum, with the line that stands for them while they are
 * folded: how many terms are real, and where this response alone would like to be.
 */
function coefficients(fit, terms, spec, goal, { mode, comps, names, respSel }) {
  const opt = mode === 'process' ? optimum(fit, terms, spec, goal) : blendOptimum(fit, terms, spec, goal, comps, names);
  const pe = paretoEffects(fit, terms);
  const real = pe.effects.filter((e) => e.significant).length;
  const say = `${esc(SHORT[respSel] || respSel)}: ${mode === 'process'
    ? `${real} of ${pe.effects.length} terms pass p < 0.05`
    : `Scheffé blend model${mode === 'crossed' ? ' crossed with the process' : ''}`}, R² ${fmt(fit.r2, 3)}${opt ? ` · ${opt.say}` : ''}`;
  const html = `${table(['Term', { label: 'Coefficient', right: true }, { label: 'SE', right: true }, { label: 't', right: true }, { label: 'p', right: true }, ''],
      terms.map((t, i) => ({ cells: [termLabel(t.name, names), fmt(fit.beta[i], 3), fmt(fit.stdErr?.[i], 3), fmt(fit.tValues?.[i], 2), p3(fit.pValues?.[i]), raw(`<b>${stars(fit.pValues?.[i])}</b>`)] })))}
      <div class="muted" style="margin-top:6px">R² ${fmt(fit.r2, 3)} · adjusted ${fmt(fit.adjR2, 3)} · residual SE ${fmt(fit.se, 3)}. ${mode === 'process'
        ? 'Coded units: a coefficient is the change per half range.'
        : `Scheffé model, no intercept: a lipid's coefficient is the predicted response for that lipid alone at the top of its range, and a pairwise term is how much the blend beats (or misses) the straight average of the two. Blends in pseudo-components${mode === 'crossed' ? ', process factors in coded units' : ''}.`} * p < 0.05, ** p < 0.01, *** p < 0.001.</div>
      ${opt ? opt.html : ''}`;
  return { say, html };
}

/**
 * The conclusion first: the one setting that does best on every response together. It sits above everything
 * else because it is what the design was for; the summary, the diagnostics and the single-response optimum
 * further down are how to check it.
 */
function balanceCard(spec, runs, vals, model) {
  let b;
  try { b = balancedOptimum(spec, runs, vals, { model }); } catch { b = null; }
  if (!b) return '';
  const goalText = (p) => {
    const g = b.used.find((x) => x.name === p.name);
    return g.goal === 'target' ? `target ${sigfig(g.target)}` : g.goal === 'minimize' ? 'as low as possible' : g.goal === 'maximize' ? 'as high as possible' : `${sigfig(g.lo)} to ${sigfig(g.hi)}`;
  };
  const scoreChip = (d) => chip(fmt(d, 2), d >= 0.8 ? 'ok' : d >= 0.5 ? 'info' : 'warn');
  // A best point on the boundary of the box is the design saying "further this way": the model cannot see
  // past the ranges that were run, so the honest next step is to extend them, not to trust the corner.
  const edge = spec.factors.filter((f) => !isCategorical(f) && Math.abs(b.coded[f.name]) >= (b.extent?.[f.name] ?? 1) - 0.01);
  // Nothing in the region is acceptable on every goal: say which response is the reason, rather than present
  // the least-bad point as a recommendation.
  const blocked = b.blocked?.length ? `<div class="note warn" style="margin-top:8px"><b>No setting in the ranges you ran is acceptable on every goal.</b> ${b.blocked.map((n) => esc(SHORT[n] || n)).join(' and ')} ${b.blocked.length === 1 ? 'stays' : 'stay'} outside the acceptable window everywhere in the region, so the overall score is 0 at every setting. Below is the least-bad compromise, not a recommendation: change ${b.blocked.length === 1 ? 'that response' : 'those responses'}' limits on the Optimizer if they are stricter than you need, or look outside these ranges.</div>` : '';
  return `<div class="card" id="balanceCard" style="border-color:var(--c-doe)"><h2>${b.blocked?.length ? 'No setting meets every goal' : 'Best balance of all responses'} ${info('desirability')}</h2>
    <p class="muted">Where the fitted models together come closest to every goal at once (the goals are in the table): the setting to try next.</p>
    <div class="grid g2" style="align-items:start">
      <div>${table(['Factor', { label: 'Setting', right: true }, { label: 'coded', right: true }], spec.factors.map((f) => ({ cells: [factorLabel(f), `${setting(f, b.real[f.name])}${f.unit ? ' ' + f.unit : ''}`, sigfig(b.coded[f.name], 2)] })))}</div>
      <div>${table(['Response', { label: 'Predicted', right: true }, { label: 'scatter ±', right: true }, 'Goal', { label: 'Score', right: true }], b.parts.map((p) => ({ cells: [SHORT[p.name] || p.name, sigfig(b.predicted[p.name], 3, { maxDp: 3 }), sigfig(b.scatter[p.name], 2, { maxDp: 3 }), goalText(p), raw(scoreChip(p.d))] })))}</div>
    </div>
    ${blocked}
    <p style="margin:10px 0 0">Overall score <b>${fmt(b.D, 2)}</b> <span class="muted">(1 = every goal met)</span>${b.best ? ` · best run you made: <a href="#/formulation?batch=${esc(b.best.batchId)}">${esc(b.best.run_id)}</a> at <b>${fmt(b.best.D, 2)}</b>` : ''}.</p>
    ${edge.length && !b.blocked?.length ? `<div class="note" style="margin-top:8px">${edge.map((f) => esc(factorLabel(f))).join(' and ')} ${edge.length === 1 ? 'sits' : 'sit'} at the edge of the range you ran: the best setting may lie beyond it, and only a design over a wider range can tell.</div>` : ''}
    <p class="muted small" style="margin-top:4px">A prediction inside the ranges you ran; "scatter" is about how far one batch lands from it. Make two or three batches here before relying on it.${b.skipped.length ? ` Not included: ${b.skipped.map((x) => `${esc(SHORT[x.name] || x.name)} (${esc(x.why)})`).join('; ')}.` : ''}</p></div>`;
}

/**
 * Whether to believe the fit, then what it looks like.
 *
 * A coefficient table says which terms are large; it cannot say whether the model is the right shape, and a
 * model whose residuals have structure still reports an R² no less confident for being wrong. The diagnostic
 * plots are where that shows, but six plots with a paragraph each, read once per response, were most of the
 * words on this screen. So the reading comes first, as one sentence from fitVerdict(), with the one plot it
 * points at beside it; the rest fold into "All diagnostic plots", the surface and the effect plots with them,
 * since those say what the model claims rather than whether to believe it.
 *
 * @param o {open, fuller}: whether the plots fold is open (remembered across redraws), and the next model up
 *          to suggest when the verdict finds a term missing
 */
function diagnostics(fit, terms, names, spec, measured, goal, params, comps = [], { open = false, fuller = null } = {}) {
  if (!fit?.beta || measured.length < 4) return '';
  const blend = comps.length > 0;
  const rows = measured.map((r) => ({ label: `${r.run_id} (${r.point_type})`, pointType: r.point_type }));
  const res = residualPoints(fit, rows);
  const pareto = paretoEffects(fit, terms);
  const qq = qqPoints(fit.residuals);
  const verdict = fitVerdict(fit, measured.map((r) => ({ label: r.run_id, setting: r.coded })), { fuller });

  // which slice of the surface, and which factor the effect plot walks along. A categorical factor (a mixer)
  // is never an axis: a surface "between" two mixers is the model talking about a mixer that does not exist.
  // The surface is drawn over two numeric factors at one mixer (`at`, a slice), and the effect plot splits a
  // numeric factor by the mixer, one line per mixer (calc/doe.js isCategorical).
  const catF = (spec.factors || []).filter(isCategorical);
  const cat = new Set(catF.map((f) => f.name));
  const axes = names.filter((n) => !cat.has(n));
  const ia = axes.includes(params.fa) ? names.indexOf(params.fa) : names.indexOf(axes[0]);
  const ibRaw = axes.includes(params.fb) ? names.indexOf(params.fb) : -1;
  const ib = ibRaw >= 0 && ibRaw !== ia ? ibRaw : names.indexOf(axes.find((n) => n !== names[ia]) ?? names[ia]);
  const ef = axes.includes(params.ef) ? params.ef : axes[0];
  // A design with a mixer opens its effect plot split by the mixer, one line each, which is the question a second
  // mixer asks; "nothing" (value none) averages over them.
  const eg = names.includes(params.eg) && params.eg !== ef ? params.eg : params.eg == null && catF.length && catF[0].name !== ef ? catF[0].name : '';
  // the slice: each categorical factor held at one of its levels, −1 unless the reader picked the other
  const at = params.at === '1' ? 1 : -1;
  const base = Object.fromEntries(catF.map((f) => [f.name, at]));
  const sel = (id, value, opts, label) => `<label class="inline">${label}
    <select name="${id}" style="width:auto">${opts.map((o) => `<option value="${esc(o.value)}" ${o.value === value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
  const fOpts = axes.map((n) => ({ value: n, label: factorLabel(n) }));
  const gOpts = names.map((n) => ({ value: n, label: factorLabel(n) }));
  // the plots name a factor the way the rest of the screen does; the model still knows it by its name
  const named = (f) => ({ ...f, name: factorLabel(f) });

  // Over a box, holding the other factors at zero is a real setting. On a simplex it is not a blend at all,
  // so the surface and effect plots are replaced by a response trace, which moves along directions that stay
  // inside the simplex.
  const grid = !blend && axes.length >= 2 ? surfaceGrid(fit, terms, names, { a: ia, b: ib, base }) : null;
  // Trace from the centre of the region, not the centre of the simplex. A design always carries that point:
  // the centre replicates are it, and failing those the mean of the runs is inside the region because the
  // region is convex.
  const reference = !blend ? null : blendReference(measured, comps);
  const trace = blend ? blendTrace(fit, terms, comps, { total: Number(spec.total) || 100, base: Object.fromEntries(names.map((n) => [n, 0])), reference }) : [];
  // Each run with its measured value, for the 3D view to stand it at; on a mixer slice only the runs made at that
  // mixer. With a third numeric factor the surface is the slice through its centre, so a run made at another level
  // of it is left off the solid: its gap to this slice would be partly that factor, not the model's miss.
  const heldNames = names.filter((n, i) => i !== ia && i !== ib && !cat.has(n));
  const pts = axes.length >= 2 ? measured.map((r, i) => ({ r, i })).filter(({ r }) => catF.every((f) => Math.sign(r.coded[f.name]) === at))
    .map(({ r, i }) => ({ x: r.coded[names[ia]], y: r.coded[names[ib]], label: r.run_id, value: res[i]?.measured,
      offSlice: heldNames.some((n) => Math.abs(Number(r.coded[n]) || 0) > 1e-6) })) : [];
  const unit = RESPONSES.find((x) => x.name === params.response)?.unit || '';
  const zlab = SHORT[params.response] || `${params.response || 'predicted'}${unit ? ` (${unit})` : ''}`;
  const yaw0 = grid ? surface3dOpeningYaw(grid) : 0.7;
  surfaceView = grid ? { grid, fa: named(spec.factors[ia]), fb: named(spec.factors[ib]), runs: pts, goal, zlab, contours: true,
    yaw: yaw0, pitch: SURFACE3D_PITCH, yaw0, pitch0: SURFACE3D_PITCH } : null;
  if (surfaceView && catF.length) surfaceView.slice = catF.map((f) => `${factorLabel(f)} ${categoricalName(f, at)}`).join(', ');
  const held = heldNames.map(factorLabel);
  const sliceSay = catF.map((f) => `${factorLabel(f)} ${categoricalName(f, at)}`).join(', ');
  const sliceSel = catF.length ? `<span class="muted">at</span>${sel('at', String(at), [-1, 1].map((v) => ({ value: String(v), label: catF.map((f) => categoricalName(f, v)).join(' · ') })), '')}` : '';

  // The four checks, a sentence each; what each is for, at more length, is behind the "?" by the heading.
  // `say` is how the fold's line names a plot, worded apart from its heading so the two are not read twice.
  const marked = res.some((r) => Math.abs(r.student || 0) > 2);
  const checks = [
    { key: 'effects', title: 'Which terms are real', say: 'the Pareto', svg: paretoSvg({ ...pareto, effects: pareto.effects.map((e) => ({ ...e, name: termLabel(e.name, names) })) }),
      caption: 'Bars are |t|, each coefficient against its own error; past the dashed line a term is unlikely to be chance (p < 0.05).' },
    { key: 'residuals', title: 'Residuals against fitted', say: 'residuals', svg: residualSvg(res),
      caption: `A shapeless band is good: a funnel means the scatter grows with the value, a curve that a term is missing${marked ? ', and runs beyond ±2 are marked' : ''}.` },
    { key: 'normal-plot', title: 'Normal plot of the residuals', say: 'normal plot', svg: qqSvg(qq, qqLine(qq)),
      caption: 'On the line the residuals are normal, and the p values can be taken at face value.' },
    { key: 'measured-vs-predicted', title: 'Measured against predicted', say: 'measured vs predicted', svg: obsPredSvg(res),
      caption: `Drawn from the runs the model was fitted on, so it flatters; predicted R² ${fmt(fit.predR2, 3)} is the honest version.` },
  ];
  const figure = (c) => `<div class="fig" data-fig="${c.key}">${figHead(c.title)}${c.svg}<p class="muted small">${c.caption}</p></div>`;
  // the plot the verdict points at, or the plainest one when the one it names cannot be drawn
  const lead = checks.find((c) => c.key === verdict.plot && c.svg) || checks.find((c) => c.key === 'measured-vs-predicted');
  const rest = checks.filter((c) => c !== lead && c.svg);
  const others = verdict.level === 'warn' ? verdict.flags.slice(1).map((f) => f.short) : [];
  // the effect plot needs one numeric factor to walk along, and a second factor (numeric or a mixer) to be worth a fold
  const effectOn = !blend && !!ef && names.length >= 2;
  const folded = [...rest.map((c) => c.say), ...(trace.length ? ['lipid traces'] : []), ...(grid ? ['surface'] : []), ...(effectOn ? ["one factor's effect"] : [])];
  const foldSay = folded.length > 1 ? `${folded.slice(0, -1).join(', ')} and ${folded[folded.length - 1]}` : folded.join('');

  return `<h2 style="margin-top:14px">Is this fit any good? ${info('diagnostics')}</h2>
    <div class="grid g2" style="align-items:start">
      <div>
        <p class="note verdict ${verdict.level === 'sound' ? 'ok' : verdict.level === 'warn' ? 'warn' : ''}" id="fitVerdict" data-level="${verdict.level}" data-plot="${lead.key}">${esc(verdict.sentence)}</p>
        ${others.length ? `<p class="muted small">Also: ${others.map(esc).join(' · ')}.</p>` : ''}
        <p class="muted small">The fit of ${esc(SHORT[params.response] || params.response || '')}: R² ${fmt(fit.r2, 3)}, adjusted ${fmt(fit.adjR2, 3)}, predicted ${fmt(fit.predR2, 3)} ${info('q2')} · ${fit.n} runs, ${fit.n - fit.p} residual df.</p>
      </div>
      ${figure(lead)}
    </div>
    <details class="fold sub" id="plotsFold" data-fold="plots" ${open ? 'open' : ''}><summary><h2>All diagnostic plots</h2><span class="fold-say">${esc(foldSay)}</span></summary>
    <div class="grid g2" style="align-items:start">${rest.map(figure).join('')}
    ${!trace.length ? '' : `<div class="fig" data-fig="blend-trace">${figHead(`What each lipid does ${info('mixture')}`)}${traceSvg(trace, { response: SHORT[params.response] || '' })}
        <p class="muted small">Each line moves one lipid across its own mol% range, the others falling in proportion${names.length ? ' and the process factors at their centre' : ''}: steep is a direction worth moving in, flat one that does nothing.</p></div>`}
    ${grid ? `<div class="fig" data-fig="surface"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><h3 style="flex:1">The fitted surface</h3>${dlButtons}
          ${sel('fa', names[ia], fOpts, '')}<span class="muted">against</span>${sel('fb', names[ib], fOpts, '')}${sliceSel}</div>
        ${surfaceBox('main')}
        <p class="muted small">What the model claims${sliceSay ? ` with ${esc(sliceSay)}` : ''}${held.length ? `${sliceSay ? ' and' : ','} ${esc(held.join(' and '))} held at the centre (in 3D only the runs made there stand at their measured value; the others belong to other slices)` : sliceSay ? '' : ' over the whole design'}; where there are no runs it is the model talking, not your runs.</p></div>` : ''}
    ${effectOn ? `<div class="fig" data-fig="effect-of-one-factor"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><h3 style="flex:1">Effect of one factor</h3>${dlButtons}
          ${sel('ef', ef, fOpts, '')}<span class="muted">split by</span>${sel('eg', eg, [{ value: 'none', label: 'nothing' }, ...gOpts.filter((o) => o.value !== ef)], '')}</div>
        ${effectSvg(effectLines(fit, terms, names, ef, eg || null, { levels: cat.has(eg) ? [-1, 1] : undefined }), { factor: ef, against: eg || null, response: SHORT[params.response] || '', spec, label: factorLabel,
          levelNames: cat.has(eg) ? [-1, 1].map((v) => categoricalName(spec.factors.find((f) => f.name === eg), v)) : null })}
        <p class="muted small">${eg ? 'Parallel lines mean the two factors do not interact; lines that cross or fan out mean the effect of one depends on the other.' : 'This factor with the others at their centre; split it by a second to see whether that shape depends on it.'}</p></div>` : ''}
    </div>
    </details>`;
}

/**
 * The goal's target as a number. An empty target box means the response's usual target (the balanced optimum
 * reads it the same way), not zero: aiming a particle size at 0 nm would send the search to whichever corner
 * is smallest and call it "closest to target".
 */
function targetOf(goal) {
  if (goal.goal !== 'target') return null;
  const t = goal.target != null && goal.target !== '' ? Number(goal.target) : Number(RESPONSES.find((r) => r.name === goal.name)?.target);
  return Number.isFinite(t) ? t : null;
}

/**
 * Where the fitted surface of the selected response alone peaks, inside the box: the table, and a clause for
 * the line the coefficients fold shows while it is closed.
 */
function optimum(fit, terms, spec, goal) {
  const names = spec.factors.map((f) => f.name);
  const target = targetOf(goal);
  if (names.length > 4 || !goal.goal || goal.goal === 'none' || (goal.goal === 'target' && target == null)) return null;
  const steps = 13; let best = null;
  const score = (y) => (goal.goal === 'minimize' ? -y : goal.goal === 'maximize' ? y : -Math.abs(y - target));
  const walk = (i, c) => {
    if (i === names.length) { const y = terms.reduce((s, t, j) => s + t.f(c) * fit.beta[j], 0); const sc = score(y); if (!best || sc > best.sc) best = { y, sc, c: { ...c } }; return; }
    if (isCategorical(spec.factors[i])) { for (const v of [-1, 1]) walk(i + 1, { ...c, [names[i]]: v }); return; } // no mixer in between
    for (let s = 0; s < steps; s++) walk(i + 1, { ...c, [names[i]]: -1 + (2 * s) / (steps - 1) });
  };
  walk(0, {});
  const what = goal.goal === 'target' ? `closest to target ${sigfig(target)}` : goal.goal === 'minimize' ? 'minimum' : 'maximum';
  const at = spec.factors.map((f) => `${factorLabel(f)} ${setting(f, toReal(f, best.c[f.name]))}`).join(', ');
  return {
    say: `on its own, ${what} at ${esc(at)} (${sigfig(best.y)})`,
    html: `<h2 style="margin-top:10px">Predicted ${what} (grid on the fitted model, inside the box)</h2>
    <p>${SHORT[goal.name] || goal.name}: <b>${sigfig(best.y)}</b></p>${table(['Factor', { label: 'Setting', right: true }, { label: 'coded', right: true }], spec.factors.map((f) => ({ cells: [factorLabel(f), `${setting(f, toReal(f, best.c[f.name]))}${f.unit ? ' ' + f.unit : ''}`, sigfig(best.c[f.name], 2)] })))}<p class="muted">This response alone, inside the ranges you ran: where the fitted surface peaks, not where one batch will land.</p>`,
  };
}

function wireDoe(el, ctx, sel) {
  const { spec, runs } = sel.design.doe;
  const settings = getSettings(ctx);
  const measurements = ctx.store.all('measurements');
  // Each export says so once there is a file: in the macOS app download() answers only after the save dialog, with
  // null if it was cancelled (./kit.js).
  const whenSaved = (file, msg) => Promise.resolve(file).then((path) => path && toast(msg, 'ok'));
  el.querySelector('#expRaw')?.addEventListener('click', () => whenSaved(download(`${sel.id}_raw_data.csv`, toRawDataCSV(spec, runs, (run, r) => responseValues(measurements, run.batchId)[r.name]), 'text/csv'), 'Raw data exported'));
  el.querySelector('#expDesign')?.addEventListener('click', () => whenSaved(download(`${sel.id}_design.csv`, toDesignCSV(spec, runs), 'text/csv'), 'Design exported'));
  // The exports are built from the same model the table was, so they cannot disagree with it.
  const order = ctx.params.order === 'run' ? 'run' : 'std';
  const dt = designTableModel(spec, runs, { batches: Object.fromEntries(sel.batchIds.map((id) => [id, ctx.store.get('batches', id)]).filter(([, b]) => b)),
    values: Object.fromEntries(runs.map((r) => [r.run_id, responseValues(measurements, r.batchId)])), order, full: true,
    balance: balanceColumn(spec, runs, sel.compositionId, getRef(ctx)), label: factorLabel,
    responses: spec.responses.map((r) => ({ name: r.name, label: SHORT[r.name] || r.name, unit: RESPONSES.find((x) => x.name === r.name)?.unit || '' })) });
  const subtitle = designSubtitle(spec, runs, DESIGN_TYPES[spec.designType]?.name || spec.designType, fmtDate(todayISO()));
  el.querySelectorAll('#orderSeg button').forEach((b) => b.addEventListener('click', () => ctx.navigate('doe', { ...ctx.params, id: sel.id, order: b.dataset.order })));
  // The click runs before the details toggles, so the state it is about to take is the opposite of now. A
  // control inside the line (a link, a "?") handles its own click and toggles nothing, so it is not recorded.
  el.querySelectorAll('details[data-fold] > summary').forEach((s) => s.addEventListener('click', (e) => {
    if (e.target.closest('button, a, select, input')) return;
    folds.set(`${sel.id}:${s.parentElement.dataset.fold}`, !s.parentElement.open);
  }));
  wireSurface(el);
  el.querySelector('#expPdf')?.addEventListener('click', () => {
    whenSaved(download(`${sel.id}_design.pdf`, tablePdf({ title: `${sel.id} · ${sel.name || 'Design'}`, subtitle,
      columns: dt.columns, rows: dt.rows, footer: `LNP Lab · ${order === 'run' ? 'run order' : 'standard order'}`,
      landscape: dt.columns.length > 5 }), 'application/pdf'), 'Design PDF exported');
  });
  el.querySelector('#expCsv')?.addEventListener('click', () => whenSaved(download(`${sel.id}_design_table.csv`, tableCsv(dt.columns, dt.rows), 'text/csv'), 'Design CSV exported'));
  el.querySelector('#expCopy')?.addEventListener('click', async () => {
    const text = tableTsv(dt.columns, dt.rows);
    try { await navigator.clipboard.writeText(text); toast(`${dt.rows.length} rows copied: paste into a sheet or a document`, 'ok'); }
    catch {
      // Clipboard access needs a secure context and a permission; a hidden textarea works where it does not.
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      toast(ok ? `${dt.rows.length} rows copied` : 'Could not reach the clipboard; use the CSV export', ok ? 'ok' : 'warn');
    }
  });
}

/* ---------------- OFAT ---------------- */
function ofatBody(ctx, sel) {
  const rows = flatRows(ctx).filter((r) => r.experimentId === sel.id);
  const k = sel.design.factor, fname = FACTORS.find((f) => f.key === k)?.name || k;
  const resp = RESP[ctx.params.response] ? ctx.params.response : 'zave_nm';
  // A mixer is read by its name, and is not a dose: its levels are bars in Results below, not a line here.
  const categorical = isCategoricalFactor(k);
  const lv = (v) => (categorical ? levelText(k, v, sel.design.labels) : fmt(v, 2));
  const measured = categorical ? [] : rows.filter((r) => r[resp] != null);
  const runTable = table(['Formulation', fname, 'Planned', 'Status', { label: 'Z-ave', right: true }, { label: 'PDI', right: true }, { label: 'EE %', right: true }],
    rows.map((r) => ({ cells: [raw(`<a href="#/formulation?batch=${r.batchId}"><b>${r.batchId}</b></a> <span class="muted">${r.label}</span>`), lv(r['factor_' + k]), fmtDate(r.plannedDate), raw(chip(r.status, r.status === 'planned' ? '' : 'info')), fmt(r.zave_nm, 1), fmt(r.pdi, 3), fmt(r.ee_pct, 1)] })));
  let chart = '';
  if (measured.length >= 2) {
    const pts = measured.slice().sort((a, b) => a['factor_' + k] - b['factor_' + k]);
    const W = 520, H = 200, L = 46, R = 16, T = 16, B = 34;
    const xs = pts.map((r) => r['factor_' + k]), ys = pts.map((r) => r[resp]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), py = (y1 - y0) * 0.15 || 1;
    const sx = (x) => L + (x1 > x0 ? (x - x0) / (x1 - x0) : 0.5) * (W - L - R), sy = (y) => T + (1 - (y - (y0 - py)) / ((y1 + py) - (y0 - py))) * (H - T - B);
    chart = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${RESP[resp]} versus ${fname}" style="width:100%;max-width:560px;height:auto;display:block"><line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="ax"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="ax"/>
      <polyline points="${pts.map((r) => `${sx(r['factor_' + k])},${sy(r[resp])}`).join(' ')}" fill="none" class="ac" stroke-width="2"/>${pts.map((r) => `<circle cx="${sx(r['factor_' + k])}" cy="${sy(r[resp])}" r="4.5" class="af"><title>${r.batchId}: ${fmt(r[resp], 2)}</title></circle>`).join('')}
      ${pts.map((r) => `<text x="${sx(r['factor_' + k])}" y="${H - B + 16}" class="lb" text-anchor="middle">${fmt(r['factor_' + k], 1)}</text>`).join('')}<text x="${W - R}" y="${H - 4}" class="lb" text-anchor="end">${fname}</text>
      <text x="${L - 6}" y="${sy(y1) + 4}" class="lb" text-anchor="end">${fmt(y1, 1)}</text><text x="${L - 6}" y="${sy(y0) + 4}" class="lb" text-anchor="end">${fmt(y0, 1)}</text></svg>`;
  }
  return `<div class="card"><div class="grid g4">${kpi('Type', TYPES.find((t) => t.id === sel.type)?.name || sel.type, `${fname} at ${sel.design.levels?.length} levels`)}${kpi('Runs', rows.length, `${measured.length} with ${RESP[resp]}`)}${kpi('Levels', (sel.design.levels || []).map(lv).join(', '))}${kpi('Fixed', 'other parameters', 'as set in the wizard')}</div></div>
    <div class="card"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="flex:1">Run table</h2><a class="btn" href="#/experiments?id=${sel.id}">Experiment</a></div>${runTable}</div>
    <div class="card"><h2>Dose response</h2><div class="grid g3" id="modelForm">${field({ id: 'response', label: 'Response', type: 'select', value: resp, options: Object.entries(RESP).map(([k2, v]) => ({ value: k2, label: v })) })}<input type="hidden" name="model" value="linear"></div>${chart || `<p class="muted">${categorical ? `The ${esc(fname.toLowerCase())}s are compared side by side, as bars, in Results below: nothing lies between two of them to draw a line through.` : 'Needs two measured levels.'}</p>`}</div>`;
}

/**
 * The best blend the fitted model predicts, searched over the design's own candidate region.
 *
 * A process optimum can walk a grid over the coded box because every corner of that box is a real setting.
 * A blend cannot: most of the box is a composition that does not add to 100, and the rest may still break a
 * mol% bound. So the search runs over the feasible candidates the design was chosen from, which are by
 * construction blends you could actually make.
 */
function blendOptimum(fit, terms, spec, goal, comps, procNames) {
  const target = targetOf(goal);
  if (!fit?.beta || !goal.goal || goal.goal === 'none' || (goal.goal === 'target' && target == null)) return null;
  let pool;
  try { pool = mixtureDesignFor(spec).pool; } catch { return null; }
  if (!pool?.length) return null;
  const total = Number(spec.total) || 100;
  const lows = comps.map((c) => c.lo);
  const score = (y) => (goal.goal === 'minimize' ? -y : goal.goal === 'maximize' ? y : -Math.abs(y - target));

  let best = null;
  for (const p of pool) {
    const mol = comps.map((c) => Number(p.x[c.name]) || 0);
    const pseudo = toPseudo(mol, lows, total);
    const coded = { ...Object.fromEntries(comps.map((c, i) => [c.name, pseudo[i]])), ...Object.fromEntries(procNames.map((n) => [n, Number(p.x[n]) || 0])) };
    const y = terms.reduce((s, t, j) => s + t.f(coded) * fit.beta[j], 0);
    const sc = score(y);
    if (!best || sc > best.sc) best = { y, sc, mol, coded };
  }
  const label = goal.goal === 'target' ? `closest to target ${sigfig(target)}` : goal.goal === 'minimize' ? 'minimum' : 'maximum';
  const procRows = procNames.length
    ? table(['Process factor', { label: 'Setting', right: true }, { label: 'coded', right: true }],
        spec.factors.map((f) => ({ cells: [factorLabel(f), `${setting(f, toReal(f, best.coded[f.name]))}${f.unit ? ' ' + f.unit : ''}`, sigfig(best.coded[f.name], 2)] })))
    : '';
  const blendText = comps.map((c, i) => `${c.name} ${sigfig(best.mol[i])}`).join(' · ');
  return {
    say: `on its own, ${label} at ${esc(blendText)} mol%${procNames.length ? `, ${esc(spec.factors.map((f) => `${factorLabel(f)} ${setting(f, toReal(f, best.coded[f.name]))}`).join(', '))}` : ''} (${sigfig(best.y)})`,
    html: `<h2 style="margin-top:10px">Predicted ${label} (over the blends this design could have used)</h2>
    <p>${SHORT[goal.name] || goal.name}: <b>${sigfig(best.y)}</b></p>
    ${table(['Lipid', { label: 'mol%', right: true }], comps.map((c, i) => ({ cells: [raw(mono(esc(c.name))), sigfig(best.mol[i])] })))}
    ${procRows}
    <p class="muted">A first look only, and only over the ${pool.length} candidate blends in the region you set — not a continuous optimum, and it uses one response rather than balancing them all.</p>`,
  };
}


/**
 * The contour / 3D switch, and turning the 3D view.
 *
 * Every surface box on the screen (the pinned panel and the diagnostics figure) shows the same view: switching
 * or turning one switches or turns both, so the two can never disagree about what the surface looks like. The
 * angles stay in this module rather than in the URL: turning a picture to look at it is not a view setting
 * worth reloading the screen for, and a redraw per pointer move has to touch one element, not rebuild the page.
 * Drawing waits for the next frame, so a fast drag redraws at most once a frame (a 25 x 25 surface takes a few
 * milliseconds; the page's own layout of it is most of the cost).
 */
function wireSurface(el) {
  const boxes = [...el.querySelectorAll('[data-surfbox]')];
  if (!boxes.length || !surfaceView) return;
  const v = surfaceView;
  let frame = 0;
  const drawSolid = () => {
    frame = 0;
    for (const b of boxes) { const solid = b.querySelector('.surfSolid'); if (!solid.hidden) solid.innerHTML = surface3dSvg(v.grid, v); }
  };
  const soon = () => { if (!frame) frame = requestAnimationFrame(drawSolid); };
  const setMode = (mode) => {
    surfaceMode = mode;
    try { localStorage.setItem(SURFACE_KEY, mode); } catch { /* not remembered, still shown */ }
    for (const b of boxes) {
      b.querySelectorAll('[data-surf]').forEach((x) => x.classList.toggle('on', x.dataset.surf === mode));
      b.querySelector('.surfFlat').hidden = mode === 'solid';
      b.querySelector('.surfSolid').hidden = mode !== 'solid';
      b.querySelector('.surf3dOnly').hidden = mode !== 'solid';
    }
    // the pinned caption says which picture it is under
    const cap = el.querySelector('[data-fig="pinned-surface"] .wsp-cap');
    if (cap) cap.textContent = `${mode === 'solid' ? 'The model fitted to the runs measured so far, as a surface; the dots are the runs at their measured value.' : 'Contour of the model fitted to the runs measured so far; the points are the runs.'} The axes and the response are chosen in Model fit.`;
    if (mode === 'solid') drawSolid();
  };
  const reset = () => { v.yaw = v.yaw0; v.pitch = v.pitch0; drawSolid(); };
  // Past level the surface is seen from underneath and past straight down it has no depth at all, so the
  // tilt stops short of both rather than letting the picture turn inside out.
  const turn = (yaw, pitch) => { v.yaw = yaw; v.pitch = Math.max(0.12, Math.min(1.4, pitch)); soon(); };
  for (const b of boxes) {
    b.querySelectorAll('[data-surf]').forEach((x) => x.addEventListener('click', () => setMode(x.dataset.surf)));
    b.querySelector('.surfReset').addEventListener('click', reset);
    b.querySelector('.surfContours').addEventListener('change', (e) => {
      v.contours = e.target.checked;
      boxes.forEach((o) => { o.querySelector('.surfContours').checked = v.contours; });
      drawSolid();
    });
    const solid = b.querySelector('.surfSolid');
    let from = null;
    solid.addEventListener('pointerdown', (e) => {
      const svg = e.target.closest('svg'); if (!svg) return;
      from = { x: e.clientX, y: e.clientY, yaw: v.yaw, pitch: v.pitch };
      svg.setPointerCapture?.(e.pointerId); svg.style.cursor = 'grabbing';
    });
    solid.addEventListener('pointermove', (e) => {
      if (!from) return;
      turn(from.yaw + (e.clientX - from.x) / 110, from.pitch + (e.clientY - from.y) / 150);
    });
    const stop = () => { if (!from) return; from = null; const svg = solid.querySelector('svg'); if (svg) svg.style.cursor = 'grab'; };
    solid.addEventListener('pointerup', stop);
    solid.addEventListener('pointercancel', stop);
    solid.addEventListener('dblclick', reset);
    // The keyboard turns it too: arrows by about ten degrees, Home back to the start.
    solid.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: [-0.17, 0], ArrowRight: [0.17, 0], ArrowUp: [0, -0.1], ArrowDown: [0, 0.1] }[e.key];
      if (step) { e.preventDefault(); turn(v.yaw + step[0], v.pitch + step[1]); }
      else if (e.key === 'Home') { e.preventDefault(); reset(); }
    });
  }
}
