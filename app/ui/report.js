// The experiment report: one printable page for the lab notebook, in the spirit of a GraphPad layout. It
// carries what the experiment was (ids, dates, operator, recipe, lots, process), the plan in a paragraph, the
// statistics in words, the data table with mean ± SD (n) and CV, the figures with their captions and, for a
// designed experiment, the recommendation, what drives each response, the coefficients, the diagnostic plots
// and the run table. It ends on a line to sign, like the bench worksheet.
//
// It is assembled from the same calculations the screens draw (calc/results.js behind the Results card; the
// fits, the desirability search and the diagnostics behind Design & results), never by copying the screen.
// A screen folds, links and hides things that a sheet of paper cannot, and a report scraped from it would
// print whatever happened to be open. experimentReport() is pure, records in and {title, body} out, so the
// wording and the numbers are tested in node; openReport() gathers the records and hands the page to the
// same print window as the worksheet, which fixes the sheet to A4 and the colours to the light theme.
import { esc, fmt, fmtDate, printHtml, toISODate } from './kit.js';
import { TYPES, TESTS, FACTORS, levelText } from '../calc/experiment.js';
import { experimentResults, outsideQc, trendSummary, responseByKey, pText, progressStage } from '../calc/results.js';
import { resultFigures, changeText, shortDate } from './resultsview.js';
import { printSvg, PRINT_COLOURS } from './charts.js';
import { describeId } from '../schema.js';
import { getRef, getSettings, compositionLabel } from '../refdata.js';
import { mixingPlan } from '../calc/batch_record.js';
import { DESIGN_TYPES, MODEL_TYPES, MIXTURE_ORDERS, RESPONSES, designSummary, responsesForBatch, specMode, specComponents, processOrderOf, factorLabel, termLabel, isCategorical, categoricalName } from '../calc/doe.js';
import { scheffeTerms, processTerms, crossedTerms, fitMixture } from '../calc/mixture.js';
import { designTableModel } from '../calc/designtable.js';
import { paretoEffects, residualPoints, qqPoints, qqLine, processDrivers, blendDrivers, driverSentence, sigfig } from '../calc/diagnostics.js';
import { paretoSvg, residualSvg, qqSvg, obsPredSvg } from './doeplots.js';
import { ols } from '../calc/stats.js';
import { balancedOptimum, boxTerms } from '../calc/balance.js';
import { batchIndex } from '../calc/indexes.js';
import { processOf, processSummary, modeOf } from '../calc/process.js';
import { processSvg } from './processviz.js';
import { cargoOf, cargoLabel, massPerPhosphate } from '../calc/cargo.js';

// The running version, for the footer. main.js is the app's entry and starts the app as it loads, so it is
// only ever imported where the app is already running: there it is loaded, and this resolves straight away,
// long before anyone presses Report. The report itself takes the version as an argument, which is what lets
// the tests build one without a browser.
let appVersion = '';
if (typeof document !== 'undefined') import('../main.js').then((m) => { appVersion = m.APP_VERSION || ''; }, () => {});

/* ---------- small helpers ---------- */

const uniq = (xs) => [...new Set(xs)];
const andList = (xs, and = 'and') => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${and} ${xs[xs.length - 1]}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const condName = (c) => String(c || '').replace(/^(-?\d+)C$/i, '$1 °C');
const axisLabel = (r) => `${r.label}${r.unit ? ` (${r.unit})` : ''}`;
const unitOf = (r) => (r.unit === '%' ? ' %' : r.unit ? ` ${r.unit}` : '');
const num = (v) => (v === '' || v == null ? NaN : Number(v));
const mono = (s) => `<code>${esc(s)}</code>`;
/** One day, or the first and last of several, each in full: a notebook page is read long after the year is obvious. */
const dateSpan = (dates) => {
  const d = uniq(dates.filter(Boolean).map((x) => String(x).slice(0, 10))).sort();
  return !d.length ? '' : d.length === 1 ? fmtDate(d[0]) : `${fmtDate(d[0])} – ${fmtDate(d[d.length - 1])}`;
};

/**
 * A plain table. Not kit.table(): that one sits in a scroll box, which a printer clips instead of scrolling.
 * Cells are markup the caller has already escaped; the header repeats on each page a long table runs over.
 */
function ptable(headers, rows, cls = '') {
  const h = headers.map((x) => (typeof x === 'object' ? x : { label: x }));
  const th = h.map((x) => `<th${x.right ? ' class="r"' : ''}>${esc(x.label)}${x.sub ? `<div class="sub">${esc(x.sub)}</div>` : ''}</th>`).join('');
  const body = rows.map((r) => `<tr${r.cls ? ` class="${r.cls}"` : ''}>${r.cells.map((c, i) => `<td${h[i]?.right ? ' class="r"' : ''}>${c ?? ''}</td>`).join('')}</tr>`).join('');
  return `<table${cls ? ` class="${cls}"` : ''}><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

/* ---------- what the experiment was ---------- */

/** "#3 MC3-LNP": a recipe by number and short name, as the Results card names an arm. */
const compShort = (ref, cid) => { const c = ref.compositionById?.[cid]; return c ? `#${c.id}${c.synonym ? ` ${c.synonym}` : ''}` : `#${cid}`; };

/** The tests the plan asked for, in the order the app lists them, by their full names. */
function testsOf(exp) {
  const ids = uniq((exp.expected || []).map((s) => s.test));
  return TESTS.filter((t) => ids.includes(t.id)).map((t) => t.name).concat(ids.filter((id) => !TESTS.some((t) => t.id === id)));
}

/** The ionizable lipid's share of a batch's recipe, override included, for the N/P the overview card shows. */
function ionizablePct(ref, b) {
  const ov = b.plan?.compositionOverride || {};
  if (Number.isFinite(num(ov.ionizable_pct))) return num(ov.ionizable_pct);
  const mol = ov.mol_pct || ref.compositionById?.[b.compositionId]?.mol_pct;
  if (!mol) return null;
  const pct = Object.entries(mol).filter(([k]) => ref.lipidByKey?.[k]?.class === 'ionizable').reduce((s, [, v]) => s + Number(v), 0);
  return pct || null;
}

/** The cargo of the formulations, as the report says it: "siRNA", or "mRNA / siRNA" for a mixed experiment. */
function cargoWord(ref, batches) {
  const lots = ref.rnaLots || [];
  const all = uniq(batches.map((b) => cargoLabel(cargoOf(b.plan, lots.find((r) => r.id === b.plan?.rna?.lotId)))));
  return all.length ? all.join(' / ') : 'RNA';
}

/** N/P of one batch: the planned value where a factor set it, else worked out the way the experiment page does. */
function npOf(ref, b) {
  if (Number.isFinite(num(b.plan?.rna?.np))) return num(b.plan.rna.np);
  const ion = ionizablePct(ref, b), p = b.plan;
  if (!ion || !p?.rna || !p?.mixing) return null;
  try {
    return mixingPlan({ rna_mg: p.rna.mass_mg, working_mg_mL: p.rna.working_mg_mL, lipidStock_mM: p.mixing.lipidStock_mM, frr: p.mixing.frr,
      quenchFactor: p.mixing.quenchFactor, flows: p.mixing.flows, ionizableMolPct: ion,
      massPerPhosphate: massPerPhosphate(p, (ref.rnaLots || []).find((r) => r.id === p.rna.lotId)) }).np ?? null;
  } catch { return null; }
}

/**
 * One process setting over every formulation: the value when they share it, the range when a factor varied it.
 * A notebook has to say which, because "FRR 3" over a design that ran FRR 2 to 4 is wrong in a way that reads right.
 */
function spread(batches, get, show) {
  const v = uniq(batches.map(get).map(num).filter(Number.isFinite));
  if (!v.length) return null;
  if (v.length === 1) return show(v[0]);
  return `${show(Math.min(...v))} to ${show(Math.max(...v))} (varied)`;
}

function processLine(ref, batches) {
  const s = (v, dp) => fmt(v, Number.isInteger(v) ? 0 : dp);
  const parts = [
    ['FRR', spread(batches, (b) => b.plan?.mixing?.frr, (v) => `${s(v, 2)} : 1`)],
    ['total flow', spread(batches, (b) => b.plan?.mixing?.totalFlow, (v) => `${s(v, 1)} mL/min`)],
    ['quench', spread(batches, (b) => b.plan?.mixing?.quenchFactor, (v) => `×${s(v, 2)}`)],
    ['lipid stock', spread(batches, (b) => b.plan?.mixing?.lipidStock_mM, (v) => `${s(v, 1)} mM`)],
    [`${cargoWord(ref, batches)} per batch`, spread(batches, (b) => b.plan?.rna?.mass_mg, (v) => `${s(v, 2)} mg`)],
    ['RNA working conc.', spread(batches, (b) => b.plan?.rna?.working_mg_mL, (v) => `${s(v, 2)} mg/mL`)],
    ['N/P', spread(batches, (b) => npOf(ref, b), (v) => fmt(v, 1))],
  ].filter(([, v]) => v);
  return parts.map(([k, v]) => `${k} ${v}`).join(' · ');
}

/**
 * How the formulations were made: the mode and the process (device, mixer, quench, buffers, downstream), once
 * when they share it, and per group of formulations when a record was given a process of its own. Returns
 * { line: HTML for the meta list, proc, quick }: the process to draw, when there is one to draw.
 */
function setupOf(ref, batches) {
  if (!batches.length) return { line: '–', proc: null, quick: false };
  const groups = new Map();
  for (const b of batches) {
    const proc = processOf(b.plan, ref), quick = modeOf(b.plan) === 'quick';
    const vol = quick && Number(b.plan?.volume_mL) > 0 ? `, ${fmt(Number(b.plan.volume_mL), 2)} mL` : '';
    const key = JSON.stringify([proc, quick, vol]);
    if (!groups.has(key)) groups.set(key, { proc, quick, words: `${quick ? `Quick: mixing only${vol}` : 'Full process'} · ${processSummary(proc, ref, { quick })}`, ids: [] });
    groups.get(key).ids.push(b.id);
  }
  const gs = [...groups.values()];
  if (gs.length === 1) return { line: esc(gs[0].words), proc: gs[0].proc, quick: gs[0].quick };
  return { line: gs.map((g) => `${esc(g.ids.join(', '))}: ${esc(g.words)}`).join('<br>'), proc: gs[0].proc, quick: gs[0].quick };
}

/** The recipes the formulations were made from, in full, and a word where a design changed them run by run. */
function compositionLines(ref, batches) {
  const lines = uniq(batches.map((b) => b.compositionId).filter((v) => v != null))
    .map((cid) => { const c = ref.compositionById?.[cid]; return esc(c ? compositionLabel(c, ref) : `#${cid}`); });
  const ov = batches.map((b) => b.plan?.compositionOverride).filter(Boolean);
  if (ov.length) {
    const what = uniq(ov.flatMap((o) => Object.keys(o))).map((k) => { const f = FACTORS.find((x) => x.key === k); return k === 'mol_pct' ? 'the lipid blend' : f ? `${f.name}${f.unit ? ` ${f.unit}` : ''}` : k; });
    lines.push(`<span class="muted">${esc(andList(uniq(what)))} set run by run by the design (see the run table)</span>`);
  }
  return lines.join('<br>') || '–';
}

function lotsLine(ref, batches, stocks) {
  const parts = [];
  const stockIds = uniq(batches.map((b) => b.stockId).filter(Boolean));
  const noStock = batches.filter((b) => !b.stockId).length;
  if (stockIds.length) {
    parts.push(`lipid stock ${stockIds.map((id) => {
      const st = stocks.find((x) => x.id === id);
      const mM = st ? num(st.molarityActual_mM) || num(st.molarity_mM) : NaN;
      return `${esc(id)}${st ? ` (#${esc(String(st.compositionId ?? ''))}${Number.isFinite(mM) ? `, ${fmt(mM, 1)} mM` : ''})` : ''}`;
    }).join(', ')}${noStock ? ` <span class="muted">(none recorded on ${noStock})</span>` : ''}`);
  } else parts.push('lipid stock <span class="muted">not recorded</span>');
  const rnaIds = uniq(batches.map((b) => b.plan?.rna?.lotId).filter(Boolean));
  const noRna = batches.filter((b) => !b.plan?.rna?.lotId).length;
  if (rnaIds.length) {
    parts.push(`${cargoWord(ref, batches)} ${rnaIds.map((id) => {
      const r = (ref.rnaLots || []).find((x) => x.id === id);
      return `${esc(id)}${r ? ` (${esc([r.construct, Number.isFinite(num(r.conc_mg_mL)) ? `${fmt(num(r.conc_mg_mL), 2)} mg/mL` : ''].filter(Boolean).join(', '))})` : ' (deleted)'}`;
    }).join(', ')}${noRna ? ` <span class="muted">(none recorded on ${noRna})</span>` : ''}`);
  } else parts.push(`${cargoWord(ref, batches)} lot <span class="muted">not recorded</span>`);
  return parts.join(' · ');
}

/** Whoever entered the results or prepared the RNA; the operator in Settings when no record names anyone. */
function operatorsOf(batches, ms, settings) {
  const named = uniq([...batches.map((b) => b.actual?.rna_operator), ...ms.map((m) => m.operator)].map((x) => String(x || '').trim()).filter(Boolean));
  return named.length ? named.join(', ') : String(settings.operator || '').trim();
}

function headerBlock(exp, batches, ms, { ref, settings, stocks, today }) {
  const T = TYPES.find((t) => t.id === exp.type);
  const stage = exp.status === 'done' ? 'done' : progressStage(exp, batches, today).stage;
  const dates = [
    exp.startDate ? `started ${fmtDate(exp.startDate)}` : '',
    batches.length ? `production ${dateSpan(batches.map((b) => b.plannedDate))}` : '',
    ms.length ? `measured ${dateSpan(ms.map((m) => m.date))}` : 'nothing measured yet',
  ].filter(Boolean).join(' · ');
  const operator = operatorsOf(batches, ms, settings);
  const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  const setup = setupOf(ref, batches);
  return `<div class="kicker">LNP Lab · experiment report</div>
    <h1>${esc(describeId(exp.id))} <span class="muted">(${esc(exp.id)})</span> · ${esc(exp.name || 'untitled')}</h1>
    <dl class="meta">
      ${row('Type', `${esc(T?.name || exp.type)} · ${esc(stage)}`)}
      ${row('Dates', esc(dates))}
      ${row('Operator', operator ? esc(operator) : '<span class="blank"></span>')}
      ${row(uniq(batches.map((b) => b.compositionId)).length > 1 ? 'Compositions' : 'Composition', compositionLines(ref, batches))}
      ${row('Lots', lotsLine(ref, batches, stocks))}
      ${row('Process', esc(processLine(ref, batches)) || '–')}
      ${row('Set-up', setup.line)}
    </dl>
    ${setup.proc ? `<div class="procfig">${printSvg(processSvg(setup.proc, ref, { quick: setup.quick, flows: batches[0]?.plan?.mixing?.flows, lipid_mM: batches[0]?.plan?.mixing?.lipidStock_mM }))}</div>` : ''}`;
}

/* ---------- the plan, in one paragraph ---------- */

const GOAL_WORDS = { minimize: 'as low as possible', maximize: 'as high as possible', none: 'recorded only' };
const SHORT = { particle_size_nm: 'Size (nm)', PDI: 'PDI', encapsulation_efficiency: 'EE (%)', zeta_potential_mV: 'Zeta (mV)', rna_content_mg_mL: 'RNA (mg/mL)', size_drift: 'Size drift' };
const WORD = { particle_size_nm: 'Size', PDI: 'PDI', encapsulation_efficiency: 'EE', zeta_potential_mV: 'Zeta', rna_content_mg_mL: 'RNA content', size_drift: 'Size drift' };
const UNIT = Object.fromEntries(RESPONSES.map((r) => [r.name, r.unit || '']));

function designWords(spec, runs) {
  const mode = specMode(spec);
  const sm = designSummary(spec, runs);
  const byType = Object.entries(sm.byType).map(([k, v]) => `${v} ${k}`).join(', ');
  const factors = (spec.factors || []).map((f) => (isCategorical(f) ? `${factorLabel(f)} ${categoricalName(f, -1)} or ${categoricalName(f, 1)}` : `${factorLabel(f)} ${sigfig(Number(f.low))}–${sigfig(Number(f.high))}${f.unit ? ` ${f.unit}` : ''}`));
  const comps = specComponents(spec).map((c) => `${c.name} ${sigfig(c.lo)}–${sigfig(c.hi)}`);
  const what = mode === 'process'
    ? `A ${(DESIGN_TYPES[spec.designType]?.name || spec.designType || 'design').toLowerCase()} design over ${andList(factors)}`
    : mode === 'mixture'
      ? `A lipid-blend design over ${andList(comps)} mol% (always adding up to ${fmt(Number(spec.total) || 100, 0)})`
      : `A blend × process design over ${andList(comps)} mol% and ${andList(factors)}`;
  const model = mode === 'process' ? (MODEL_TYPES[spec.model] || spec.model || '').replace(/ \(.*\)$/, '').toLowerCase()
    : `${(MIXTURE_ORDERS[spec.mixtureOrder || 'quadratic'] || '').replace(/ —.*/, '').toLowerCase()} blending${mode === 'crossed' ? ` × ${(MODEL_TYPES[spec.model] || '').replace(/ \(.*\)$/, '').toLowerCase()}` : ''}`;
  const goals = (spec.responses || []).map((r) => {
    const g = r.goal === 'target' ? `target ${sigfig(Number(r.target ?? RESPONSES.find((x) => x.name === r.name)?.target))}` : GOAL_WORDS[r.goal] || r.goal;
    return `${WORD[r.name] || r.name} (${g})`;
  });
  return `${what}: ${plural(sm.runs, 'run')} (${byType}), made in randomised order and fitted with a ${model} model (${sm.terms} terms${mode === 'process' ? ' and an intercept' : ', no intercept'}, ${sm.residualDf} residual df). Responses: ${andList(goals)}.`;
}

function planText(exp, batches, ref) {
  const tests = andList(testsOf(exp));
  const n = batches.length;
  const onFinal = tests ? `, ${n === 1 ? '' : 'each '}measured for ${tests} on the final product` : '';
  const st = exp.design?.stability;
  switch (exp.type) {
    case 'single': return `One formulation of ${compShort(ref, exp.compositionId)}${onFinal}.`;
    case 'reference': return `The same recipe, ${compShort(ref, exp.compositionId)}, made ${n} times to show how reproducible it is from batch to batch${onFinal}.`;
    case 'comparison': {
      const arms = uniq(batches.map((b) => b.compositionId));
      const named = arms.map((cid) => { const k = batches.filter((b) => b.compositionId === cid).length; return `${compShort(ref, cid)}${k > 1 ? ` (${k} batches)` : ''}`; });
      return `${plural(arms.length, 'composition')} compared under one process, ${andList(named)}: ${plural(n, 'formulation')} in all${onFinal}. Differences are read against the first.`;
    }
    case 'ofat': {
      const f = FACTORS.find((x) => x.key === exp.design?.factor);
      // a mixer is named; a number is shown to its significant figures
      const levels = (exp.design?.levels || []).map((v) => (f?.categorical ? levelText(f.key, v, exp.design?.labels) : sigfig(Number(v))));
      return `${f?.name || exp.design?.factor || 'One factor'} varied over ${andList(levels)}${f?.unit ? ` ${f.unit}` : ''}, everything else held at the settings above: ${plural(n, 'formulation')}${onFinal}.`;
    }
    case 'stability': {
      const forms = andList(uniq(batches.map((b) => compShort(ref, b.compositionId))));
      const conds = st?.conditions || [];
      const days = (st?.timepoints || []).map(String);
      const onDay = (xs) => `day${xs.length === 1 ? '' : 's'} ${andList(xs)}`;
      const potency = (st?.potencyAt || []).length ? `, and potency on ${onDay(st.potencyAt.map(String))}` : '';
      const stTests = andList((st?.tests || []).map((t) => TESTS.find((x) => x.id === t)?.name || t));
      return `${n === 1 ? 'One formulation' : plural(n, 'formulation')}, ${forms}, stored at ${andList(conds.map(condName))} and sampled on ${onDay(days)}: ${plural(n * conds.length, 'storage sample')}, each measured for ${stTests || 'the planned tests'} on every day${potency}. Day 0 is the day of production.`;
    }
    case 'doe': {
      const d = exp.design?.doe;
      return d?.spec ? designWords(d.spec, d.runs || []) : `A designed experiment of ${plural(n, 'formulation')}${onFinal}.`;
    }
    default: return `${plural(n, 'formulation')}${onFinal}.`;
  }
}

function progressText(exp) {
  const slots = exp.expected || [];
  const open = slots.filter((s) => s.status === 'open');
  const next = open.map((s) => s.dueDate).filter(Boolean).sort()[0];
  return `${slots.length - open.length} of ${slots.length} planned measurements are in${open.length ? `; ${open.length} still due${next ? `, the next on ${fmtDate(next)}` : ''}` : ''}.`;
}

/* ---------- the data tables ---------- */

/** One value: mean ± SD on top, n and CV under it, as on the Results card; outside a QC limit in bold. */
function valueCell(r, c, qc, extra = '') {
  if (!c) return '<span class="muted">–</span>';
  const bad = outsideQc(r.key, c.mean, qc);
  const top = c.sd != null ? `${fmt(c.mean, r.dp)} ± ${fmt(c.sd, r.dp)}` : fmt(c.mean, r.dp);
  const sub = [`n = ${c.n}`, c.cv != null ? `CV ${fmt(c.cv, 1)} %` : null, c.stage && c.stage !== 'final' && !/^T\d+$/i.test(c.stage) ? c.stage : null].filter(Boolean).join(' · ');
  return `<span class="v${bad ? ' qc' : ''}">${top}</span><div class="sub">${esc(sub)}</div>${extra}`;
}
const head = (r) => ({ label: axisLabel(r), sub: 'mean ± SD', right: true });

function dataTable(exp, res, { qc, compLabel }) {
  const R = res.responses, st = res.stats || {};
  const oneEach = st.kind === 'comparison' && st.arms.every((a) => a.batchIds.length === 1);
  const firstArm = st.kind === 'comparison' ? st.arms.find((a) => a.key === st.first) : null;
  const armOf = (row) => (st.kind === 'comparison' ? st.arms.find((a) => a.batchIds.includes(row.batchId)) : null);
  const labelOf = (row) => (exp.type === 'comparison' && row.compositionId != null ? compLabel(row.compositionId) : row.label);
  const rows = res.rows.map((x) => ({ cells: [
    `<b>${esc(x.batchId)}</b>${labelOf(x) ? ` <span class="muted">${esc(labelOf(x))}</span>` : ''}`,
    ...(res.type === 'ofat' ? [esc(x.levelText ?? x.level ?? '–')] : []),
    ...R.map((r) => {
      const a = oneEach ? armOf(x) : null;
      const d = a && a !== firstArm ? a.diff[r.key] : null;
      return valueCell(r, x.cells[r.key], qc, d ? `<div class="sub">${esc(changeText(r, d))} vs #${esc(String(firstArm.compositionId ?? firstArm.batchIds[0]))}</div>` : '');
    }),
  ] }));
  if (st.kind === 'repeats') {
    const n = Math.max(0, ...Object.values(st.byResponse).map((g) => g.n));
    if (n >= 2) rows.push({ cls: 'total', cells: [`<b>Batch to batch</b> <span class="muted">${n} batches</span>`, ...R.map((r) => valueCell(r, st.byResponse[r.key] ? { ...st.byResponse[r.key], stage: '' } : null, null))] });
  }
  const lead = res.type === 'ofat' ? ['Formulation', { label: st.factorName || 'Level', sub: st.unit || '', right: true }] : ['Formulation'];
  return ptable([...lead, ...R.map(head)], rows);
}

/** Arms made more than once: n counts batches, and the difference from the first arm sits in the cell. */
function armsTable(res, { compLabel }) {
  const st = res.stats;
  if (st?.kind !== 'comparison' || st.arms.every((a) => a.batchIds.length === 1)) return '';
  const first = st.arms.find((a) => a.key === st.first);
  return `<h3>Per arm</h3>${ptable(['Arm', { label: 'Batches', right: true }, ...res.responses.map(head)], st.arms.map((a) => ({ cells: [
    esc(a.compositionId != null ? compLabel(a.compositionId) : a.label), String(a.batchIds.length),
    ...res.responses.map((r) => valueCell(r, a.byResponse[r.key] ? { ...a.byResponse[r.key], stage: '' } : null, null,
      a !== first && a.diff[r.key] ? `<div class="sub">${esc(changeText(r, a.diff[r.key]))} vs first</div>` : '')),
  ] })))}`;
}

/** The test between arms (or levels), one row per response: the numbers behind the sentence. */
function testsTable(res) {
  const t = res.stats?.tests;
  if (!t) return '';
  const rows = res.responses.filter((r) => t[r.key]).map((r) => {
    const x = t[r.key], welch = x.kind === 'welch';
    return { cells: [esc(r.label), welch ? 'Welch’s t' : 'one-way ANOVA', welch ? `t = ${fmt(x.t, 2)}` : `F = ${fmt(x.F, x.F < 100 ? 2 : 1)}`,
      welch ? fmt(x.df, 1) : `${x.df1}, ${x.df2}`, `p ${esc(pText(x.p))}`, x.p < 0.05 ? '<b>yes</b>' : 'no'] };
  });
  return `<h3>Test on the batch means</h3>${ptable(['Response', 'Test', { label: 'Statistic', right: true }, { label: 'df', right: true }, { label: 'p', right: true }, 'p < 0.05'], rows)}`;
}

/** A stability day as the Results card shows it: Z-ave ± SD, PDI, the change from T0, any other test. */
function dayCell(row, slots, { qc, today, R }) {
  const z = row?.cells.zave, p = row?.cells.pdi;
  const others = R.filter((r) => r.key !== 'zave' && r.key !== 'pdi' && row?.cells[r.key]);
  const open = slots.filter((s) => s.status === 'open');
  if (!z && !p && !others.length) {
    if (!open.length) return '<span class="muted">–</span>';
    const due = open.map((s) => s.dueDate).filter(Boolean).sort()[0];
    return `<span class="muted">${due && today && due < today ? 'missing' : `due ${esc(shortDate(due, today))}`}</span>`;
  }
  const parts = [];
  if (z) parts.push(`<span class="v${outsideQc('zave', z.mean, qc) ? ' qc' : ''}">${z.sd != null ? `${fmt(z.mean, 1)} ± ${fmt(z.sd, 1)}` : fmt(z.mean, 1)}</span>`);
  if (p) parts.push(`<div class="sub${outsideQc('pdi', p.mean, qc) ? ' qc' : ''}">PDI ${fmt(p.mean, 3)}</div>`);
  const ch = row.timepoint > 0 ? row.change?.zave : null;
  if (ch) parts.push(`<div class="sub">${esc(changeText(responseByKey.zave, ch))}</div>`);
  for (const r of others) parts.push(`<div class="sub${outsideQc(r.key, row.cells[r.key].mean, qc) ? ' qc' : ''}">${esc(r.label)} ${fmt(row.cells[r.key].mean, r.dp)}${esc(unitOf(r))}</div>`);
  return parts.join('');
}

function trendCell(tr) {
  const z = trendSummary('zave', tr?.zave), p = trendSummary('pdi', tr?.pdi);
  if (!z && !p) return '<span class="muted">needs a later day</span>';
  const parts = [];
  if (z) parts.push(`<span class="v">${esc(z.rate)}</span><div class="sub">${esc(z.ci)}</div>${z.projection ? `<div class="sub">${esc(z.projection)}</div>` : ''}`);
  if (p) parts.push(`<div class="sub">PDI ${esc(p.rate)}${tr.pdi.ci ? ` · ${esc(p.ci.replace('95 % CI ', ''))}` : ''}</div>`);
  return parts.join('');
}

/** The stability study pivoted, GraphPad's grouped layout: formulation × shelf down, the days across, the slope last. */
function stabilityTable(exp, res, { qc, today }) {
  const R = res.responses;
  const groups = [];
  for (const row of res.rows) {
    let g = groups.find((x) => x.batchId === row.batchId && x.condition === row.condition);
    if (!g) groups.push(g = { batchId: row.batchId, compositionId: row.compositionId, label: row.label, condition: row.condition, byDay: new Map() });
    g.byDay.set(row.timepoint, row);
  }
  const days = uniq(res.rows.map((r) => r.timepoint)).sort((a, b) => a - b);
  const slots = exp.expected || [];
  const series = res.stats?.series || [];
  const rows = groups.map((g) => ({ cells: [
    `<b>${esc(g.batchId)}</b> <span class="muted">${esc(g.compositionId != null ? `#${g.compositionId}` : g.label)}</span>`,
    esc(condName(g.condition)),
    ...days.map((t) => dayCell(g.byDay.get(t), slots.filter((s) => s.batchId === g.batchId && s.condition === g.condition && Number(s.timepoint) === t), { qc, today, R })),
    trendCell(series.find((s) => s.batchId === g.batchId && s.condition === g.condition)?.trend),
  ] }));
  return ptable(['Formulation', 'Condition', ...days.map((t) => ({ label: `T${t}`, sub: t ? `day ${t}` : 'production', right: true })), { label: 'Trend', sub: 'least squares, per day' }], rows, 'stab');
}

/**
 * The QC limits the bold values were judged against, so a printed bold still means something a year later.
 * Only when something is bold: with every value inside, the statistics already say so.
 */
function qcNote(res, qc) {
  if (!qc || !res.rows.some((row) => res.responses.some((r) => row.cells[r.key] && outsideQc(r.key, row.cells[r.key].mean, qc)))) return '';
  const keys = res.responses.map((r) => r.key);
  const lim = [];
  if (keys.includes('zave') && (Number.isFinite(qc.zaveMin) || Number.isFinite(qc.zaveMax))) lim.push(`Z-ave ${Number.isFinite(qc.zaveMin) ? qc.zaveMin : '…'}–${Number.isFinite(qc.zaveMax) ? qc.zaveMax : '…'} nm`);
  if (keys.includes('pdi') && Number.isFinite(qc.pdiMax)) lim.push(`PDI ≤ ${qc.pdiMax}`);
  if (keys.includes('ee') && Number.isFinite(qc.eeMin)) lim.push(`EE ≥ ${qc.eeMin} %`);
  return lim.length ? `Values in bold are outside the QC limits set in the app (${andList(lim)}).` : '';
}

/* ---------- figures ---------- */

/** A figure for paper: numbered, titled, the chart with its colours written in, and its caption. */
const printFigure = (f, n) => `<figure><figcaption class="t"><b>Figure ${n}.</b> ${esc(f.title)}</figcaption>${printSvg(f.svg)}${f.caption ? `<figcaption>${esc(f.caption)}</figcaption>` : ''}</figure>`;

function figuresBlock(g, counter) {
  if (!g.figs.length) return '';
  const legend = g.legend ? `<div class="legend">${g.legend.map((it) => `<span><i style="background:${esc(it.color)}"></i>${esc(it.name)}</span>`).join('')}</div>` : '';
  // Two to a row even where the screen gives a time course the full width: on A4 that is still 85 mm a chart,
  // and the three charts of a stability study then fit beside its table instead of running onto a second page.
  return `<h2>Figures</h2>${legend}<div class="figs">${g.figs.map((f) => printFigure(f, ++counter.n)).join('')}</div>${g.note ? `<p class="note">${esc(g.note)}</p>` : ''}`;
}

/* ---------- a designed experiment ----------
 * setting(), blendReference() and designFits() repeat what doe.js does inline, because the screen keeps them
 * private; they are small, and a change to how the screen fits or rounds has to be made here as well.
 */

/** A factor setting to the precision its range supports, as Design & results prints it (doe.js `setting`). */
function setting(f, v) {
  if (isCategorical(f)) return Number.isFinite(v) ? categoricalName(f, v) : '–'; // a mixer by its name
  if (!Number.isFinite(v)) return '–';
  const span = Math.abs(Number(f.high) - Number(f.low));
  const dp = span > 0 ? Math.max(0, Math.min(4, -Math.floor(Math.log10(span / 10)))) : 2;
  return Number(v.toFixed(dp)).toLocaleString('en-US', { maximumFractionDigits: dp });
}

/** The blend a blend model is read from: the centre replicates, else the mean of the runs (doe.js `blendReference`). */
function blendReference(measured, comps) {
  const centre = measured.find((r) => r.point_type === 'center') || measured.find((r) => r.point_type === 'centroid');
  return comps.map((c) => (centre ? centre.real[c.name] : measured.reduce((a, r) => a + r.real[c.name], 0) / measured.length));
}

/**
 * Every response of a design fitted the way Design & results fits it: the same terms for the same model (the
 * screen's model choice is passed in, so the report says what the screen showed), ordinary least squares over
 * a box and a Scheffé polynomial over a blend, on the latest final result of each run.
 */
export function designFits(spec, runs, measurements, { model = spec.model } = {}) {
  const mode = specMode(spec);
  const comps = specComponents(spec);
  const names = (spec.factors || []).map((f) => f.name);
  const vals = Object.fromEntries(runs.map((r) => [r.run_id, responsesForBatch(measurements, r.batchId).values]));
  const mixTerms = mode === 'process' ? [] : scheffeTerms(comps.map((c) => c.name), spec.mixtureOrder || 'quadratic');
  const terms = mode === 'process' ? boxTerms(names, model)
    : mode === 'mixture' ? mixTerms
      : crossedTerms(mixTerms, processTerms(names, processOrderOf({ ...spec, model })));
  const fits = {};
  for (const r of spec.responses || []) {
    const measured = runs.filter((x) => vals[x.run_id][r.name] != null);
    const y = measured.map((x) => vals[x.run_id][r.name]);
    let fit = null;
    if (measured.length > terms.length) {
      try { fit = mode === 'process' ? ols(measured.map((x) => terms.map((t) => t.f(x.coded))), y) : fitMixture(measured.map((x) => x.coded), y, terms); }
      catch (e) { fit = { note: e.message }; }
    }
    fits[r.name] = { fit, measured };
  }
  return { mode, comps, names, vals, terms, fits, model };
}

function balanceBlock(spec, runs, vals, model) {
  let b;
  try { b = balancedOptimum(spec, runs, vals, { model }); } catch { b = null; }
  if (!b) return '';
  const goalText = (p) => {
    const g = b.used.find((x) => x.name === p.name);
    return g.goal === 'target' ? `target ${sigfig(g.target)}` : g.goal === 'minimize' ? 'as low as possible' : g.goal === 'maximize' ? 'as high as possible' : `${sigfig(g.lo)} to ${sigfig(g.hi)}`;
  };
  const edge = spec.factors.filter((f) => !isCategorical(f) && Math.abs(b.coded[f.name]) >= (b.extent?.[f.name] ?? 1) - 0.01);
  const blocked = b.blocked?.length
    ? `<p class="warnbox"><b>No setting in the ranges run is acceptable on every goal.</b> ${esc(andList(b.blocked.map((n) => SHORT[n] || n)))} ${b.blocked.length === 1 ? 'stays' : 'stay'} outside the acceptable window everywhere in the region, so the setting below is the least-bad compromise, not a recommendation.</p>`
    : '';
  return `<h2>${b.blocked?.length ? 'No setting meets every goal' : 'Recommended setting: the best balance of all responses'}</h2>
    <p>Where the fitted models together come closest to every goal at once (desirability): ${esc(b.parts.map((p) => `${SHORT[p.name] || p.name} ${goalText(p)}`).join(', '))}.</p>
    ${blocked}
    <div class="two">
      ${ptable(['Factor', { label: 'Setting', right: true }, { label: 'coded', right: true }], spec.factors.map((f) => ({ cells: [esc(factorLabel(f)), esc(`${setting(f, b.real[f.name])}${f.unit ? ` ${f.unit}` : ''}`), esc(sigfig(b.coded[f.name], 2))] })))}
      ${ptable(['Response', { label: 'Predicted', right: true }, { label: 'scatter ±', right: true }, 'Goal', { label: 'Score', right: true }], b.parts.map((p) => ({ cells: [esc(SHORT[p.name] || p.name), esc(sigfig(b.predicted[p.name], 3, { maxDp: 3 })), esc(sigfig(b.scatter[p.name], 2, { maxDp: 3 })), esc(goalText(p)), fmt(p.d, 2)] })))}
    </div>
    <p>Overall score <b>${fmt(b.D, 2)}</b> <span class="muted">(0 = unacceptable on something, 1 = ideal on everything)</span>${b.best ? ` · best run made: ${esc(b.best.run_id)} (${esc(b.best.batchId || '')}) at <b>${fmt(b.best.D, 2)}</b>` : ''}.</p>
    ${edge.length && !b.blocked?.length ? `<p class="note">${edge.map((f) => esc(factorLabel(f))).join(' and ')} ${edge.length === 1 ? 'sits' : 'sit'} at the edge of the range run, so the best setting may lie beyond it; the model cannot see past the ranges.</p>` : ''}
    <p class="note">A prediction from the runs made, inside the ranges run. "Scatter" is each model's residual spread, about how far one batch will land from the prediction. Make two or three batches at this setting before relying on it.${b.skipped.length ? ` Not included: ${esc(b.skipped.map((x) => `${SHORT[x.name] || x.name} (${x.why})`).join('; '))}.` : ''}</p>`;
}

function driversBlock(spec, d) {
  const items = (spec.responses || []).map((r) => {
    const n = r.name, { fit, measured } = d.fits[n];
    const label = `<b>${esc(WORD[n] || n)}</b>`;
    if (!fit?.beta) return `<li>${label}: ${esc(fit?.note || `needs more than ${d.terms.length} measured runs, ${measured.length} so far`)}.</li>`;
    const dr = d.mode === 'process' ? processDrivers(fit, d.terms, spec.factors)
      : blendDrivers(fit, d.terms, d.comps, { total: Number(spec.total) || 100, reference: blendReference(measured, d.comps), factors: d.names.length ? spec.factors : [] });
    const q = fit.predR2, weak = q == null || q < 0.5;
    const facts = [`R² ${fmt(fit.r2, 2)}`, `predicted R² ${q == null ? 'not available' : fmt(q, 2)}`];
    return `<li>${driverSentence(label, dr, { unit: UNIT[n], term: (s) => esc(d.names.includes(s) ? factorLabel(s) : s), text: esc, maxDp: n === 'PDI' ? 3 : 2 })} <span class="muted">${facts.join(' · ')}</span>${weak ? ' <i class="flag">below 0.5: a lead to check, not a finding</i>' : ''}</li>`;
  }).join('');
  const how = d.mode === 'process'
    ? 'Each change is across the range run, low to high with the other factors at their centre, for the terms that pass p &lt; 0.05, strongest first.'
    : 'Each lipid is read from the least to the most of it the region allows, the others falling in proportion; blending terms are named when they pass p &lt; 0.05.';
  return `<h2>What drives each response</h2><ul class="stats">${items}</ul><p class="note">${how} Predicted R² is how well a model predicts a run it was not fitted to.</p>`;
}

const p3 = (p) => (p == null || !Number.isFinite(p) ? '–' : p < 0.001 ? '&lt; 0.001' : fmt(p, 3));
const stars = (p) => (p == null ? '' : p < 0.001 ? '***' : p < 0.01 ? '**' : p < 0.05 ? '*' : '');

/** Per response: the fit in one line, the coefficients with p values, and the four plots that say whether to believe it. */
function modelBlock(spec, d, counter) {
  // the Pareto's bars carry the terms in the lab's words, as the coefficient table above them does
  const named = (pe) => ({ ...pe, effects: pe.effects.map((e) => ({ ...e, name: termLabel(e.name, d.names) })) });
  return (spec.responses || []).map((r) => {
    const { fit, measured } = d.fits[r.name];
    const title = `Model for ${SHORT[r.name] || r.name}`;
    if (!fit?.beta) return `<h2>${esc(title)}</h2><p class="muted">${esc(fit?.note || `Not fitted: needs more than ${d.terms.length} runs with this response, ${measured.length} so far.`)}</p>`;
    const coef = ptable(['Term', { label: 'Coefficient', right: true }, { label: 'SE', right: true }, { label: 't', right: true }, { label: 'p', right: true }, ''],
      d.terms.map((t, i) => ({ cells: [esc(termLabel(t.name, d.names)), fmt(fit.beta[i], 3), fmt(fit.stdErr?.[i], 3), fmt(fit.tValues?.[i], 2), p3(fit.pValues?.[i]), `<b>${stars(fit.pValues?.[i])}</b>`] })), 'coef');
    const units = d.mode === 'process' ? 'Coded units: a coefficient is the change per half range.' : `Scheffé model, no intercept; blends in pseudo-components${d.mode === 'crossed' ? ', process factors in coded units' : ''}.`;
    let plots = '';
    if (measured.length >= 4) {
      const pts = residualPoints(fit, measured.map((x) => ({ label: `${x.run_id} (${x.point_type})`, pointType: x.point_type })));
      const qq = qqPoints(fit.residuals);
      const name = SHORT[r.name] || r.name;
      const figs = [
        { svg: paretoSvg(named(paretoEffects(fit, d.terms))), title: `${name}: which terms are real`, caption: 'Bars are |t|, the coefficient against its own standard error; past the dashed line a term would come up less than one time in twenty by chance.' },
        { svg: residualSvg(pts), title: `${name}: residuals against fitted`, caption: 'Should be a shapeless band; a funnel or a curve means the model is the wrong shape.' },
        { svg: qqSvg(qq, qqLine(qq)), title: `${name}: normal plot of the residuals`, caption: 'On the line, the p values can be taken at face value.' },
        { svg: obsPredSvg(pts), title: `${name}: measured against predicted`, caption: `The runs the model was fitted on, so this flatters it; the predicted R² (${fmt(fit.predR2, 3)}) is the honest version.` },
      ].filter((f) => f.svg);
      plots = figs.length ? `<div class="figs">${figs.map((f) => printFigure(f, ++counter.n)).join('')}</div>` : '';
    }
    return `<h2>${esc(title)}</h2>
      <p class="note">R² ${fmt(fit.r2, 3)} · adjusted ${fmt(fit.adjR2, 3)} · predicted ${fmt(fit.predR2, 3)} · residual SE ${fmt(fit.se, 3)} · n ${fit.n}, ${fit.n - fit.p} residual df. ${units} * p &lt; 0.05, ** p &lt; 0.01, *** p &lt; 0.001.</p>
      ${coef}${plots}`;
  }).join('');
}

/** The run table: the design's own columns (as the export writes them) and each response as mean ± SD (n). */
function runTable(spec, runs, batchesById, res, qc) {
  const dt = designTableModel(spec, runs, { batches: batchesById, order: 'std', full: true, responses: [], label: factorLabel });
  // the same order designTableModel sorts by, so each row can be matched back to its formulation's results
  const sorted = [...runs].sort((a, b) => (a.std_order ?? 0) - (b.std_order ?? 0));
  const byBatch = Object.fromEntries(res.rows.map((x) => [x.batchId, x]));
  const rows = dt.rows.map((cells, i) => ({ cells: [
    ...cells.map((v, j) => (j === 0 ? `<b>${esc(v)}</b>` : esc(v))),
    ...res.responses.map((r) => valueCell(r, byBatch[sorted[i].batchId]?.cells[r.key], qc)),
  ] }));
  return ptable([...dt.columns, ...res.responses.map(head)], rows, 'runs');
}

/* ---------- the page ---------- */

/**
 * The report for one experiment, as {title, body} for printHtml().
 * @param o.exp, o.batches, o.measurements  the records (measurements of other formulations are ignored)
 * @param o.ref, o.settings, o.stocks       reference data, settings (QC limits, operator) and the lipid stocks
 * @param o.version  the app version for the footer; o.now the moment it is printed; o.model a DoE model to use
 *                   instead of the design's own (Design & results passes the one on screen)
 */
export function experimentReport({ exp, batches, measurements = [], ref, settings, stocks = [], version = '', now = new Date(), model = null }) {
  const today = toISODate(now);
  const ids = new Set(batches.map((b) => b.id));
  const ms = measurements.filter((m) => ids.has(m.batchId));
  const qc = settings?.qc || null;
  const res = experimentResults(exp, batches, ms, { qc });
  const compLabel = (cid) => compShort(ref, cid);
  const counter = { n: 0 };
  const doe = exp.type === 'doe' && exp.design?.doe?.spec ? exp.design.doe : null;

  let results;
  if (!res.measuredRows) {
    results = `<h2>Results</h2><p>Nothing measured yet: the statistics, the data table and the figures fill in with the first result.</p>${exp.type === 'stability' ? `<h3>Plan</h3>${stabilityTable(exp, res, { qc, today })}` : ''}`;
  } else if (doe) {
    const d = designFits(doe.spec, doe.runs, ms, { model: MODEL_TYPES[model] ? model : doe.spec.model });
    const anyFit = Object.values(d.fits).some((f) => f.fit?.beta);
    const batchesById = Object.fromEntries(batches.map((b) => [b.id, b]));
    // A model picked on Design & results is what the screen showed, so it is what is printed, said once here.
    const modelName = (m) => (MODEL_TYPES[m] || m || '').replace(/ \(.*\)$/, '').toLowerCase();
    const swapped = d.mode !== 'mixture' && d.model !== doe.spec.model
      ? `<p class="note">Every model below is the ${esc(modelName(d.model))} model chosen on Design &amp; results; the design was planned for ${esc(modelName(doe.spec.model))}.</p>` : '';
    results = swapped + (anyFit && d.mode === 'process' ? balanceBlock(doe.spec, doe.runs, d.vals, d.model) : '')
      + (anyFit ? driversBlock(doe.spec, d) : `<h2>Results</h2><p>${esc(res.sentences[0] || '')} No model can be fitted yet: it needs more than ${d.terms.length} measured runs.</p>`)
      + `<h2>Runs and results</h2>${runTable(doe.spec, doe.runs, batchesById, res, qc)}<p class="note">Standard order; the run order is the order the formulations were made in. Each result is the mean ± SD of the instrument's repeat runs on that formulation. ${esc(qcNote(res, qc))}</p>`
      + (anyFit ? modelBlock(doe.spec, d, counter) : '');
  } else {
    const stab = res.type === 'stability';
    const stats = `<h2>Statistics</h2><ul class="stats">${res.sentences.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>${res.caveat ? `<p class="note">${esc(res.caveat)}</p>` : ''}`;
    const table = stab
      ? `<h2>Data table</h2><p class="note">Each cell: Z-ave mean ± SD (nm) of the repeat runs, PDI under it and the change in Z-ave from T0; the last column is the least-squares slope per day with its 95 % CI and the day it would reach the QC limit. ${esc(qcNote(res, qc))}</p>${stabilityTable(exp, res, { qc, today })}`
      : `<h2>Data table</h2>${dataTable(exp, res, { qc, compLabel })}<p class="note">Each cell: mean ± SD, with n and the CV under it. ${esc(qcNote(res, qc))}</p>${armsTable(res, { compLabel })}${testsTable(res)}`;
    results = stats + table + figuresBlock(resultFigures(exp, res, { qc, compLabel, today }), counter);
  }

  const last = ms.map((m) => m.date).filter(Boolean).sort().pop();
  const stamp = `${fmtDate(today)}, ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const body = `<style>${CSS}</style>
    ${headerBlock(exp, batches, ms, { ref, settings: settings || {}, stocks, today })}
    <h2>Plan</h2><p>${esc(planText(exp, batches, ref))} ${esc(progressText(exp))}</p>
    ${results}
    <div class="sig"><div>Date / signature operator</div><div>Date / signature review</div></div>
    <p class="foot">LNP Lab${version ? ` v${esc(version)}` : ''} · printed ${esc(stamp)} · Data: ${plural(ms.length, 'measurement')}${last ? `, last result ${esc(fmtDate(last))}` : ''}</p>`;
  return { title: `${exp.id} report · ${exp.name || describeId(exp.id)}`, body };
}

/** Gather an experiment's records and open its report in the print window. `opts.model`: the DoE model on screen. */
export function openReport(ctx, expId, { model = null } = {}) {
  const exp = ctx.store.get('experiments', expId);
  if (!exp) return;
  const batches = batchIndex(ctx.store.all('batches')).of(exp);
  const { title, body } = experimentReport({ exp, batches, measurements: ctx.store.all('measurements'), ref: getRef(ctx), settings: getSettings(ctx),
    stocks: ctx.store.all('stocks'), version: appVersion, now: new Date(), model });
  printHtml(title, body);
}

/*
 * The sheet. printHtml() owns the base style (type, tables, the signature line); these rules add the page
 * size, the light palette whatever the screen's theme, and the layout of the figures. Breaks are kept out of
 * a figure, a table row and the line under a heading, since a chart split over two pages is no chart at all.
 */
const CSS = `:root{color-scheme:light;${Object.entries(PRINT_COLOURS).map(([k, v]) => `--${k}:${v}`).join(';')}}
  html{background:#fff}
  @page{size:A4;margin:14mm 13mm 15mm}
  @media print{body{margin:0}}
  @media screen{body{max-width:184mm}}
  .kicker{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#555;margin-bottom:2px}
  h1 .muted{font-weight:400}
  dl.meta{display:grid;grid-template-columns:24mm 1fr;gap:3px 10px;margin:8px 0 4px;font-size:11.5px;line-height:1.4}
  dl.meta dt{color:#555}dl.meta dd{margin:0}
  p{margin:4px 0 8px;line-height:1.45}
  h2,h3{break-after:avoid}h3{font-size:12px;margin:12px 0 4px}
  table{break-inside:auto}tr{break-inside:avoid}thead{display:table-header-group}
  th,td{padding:3px 5px;vertical-align:top;font-size:10.5px}th{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .sub{font-size:9.5px;color:#555;font-weight:400;white-space:nowrap;font-variant-numeric:tabular-nums}
  .v{font-variant-numeric:tabular-nums;white-space:nowrap}.qc{font-weight:700;color:#8A4B00}
  tr.total td{border-top:1.5px solid #333}
  table.runs td,table.runs th,table.stab td,table.stab th{font-size:9.5px;padding:2px 4px}
  table.coef{width:auto;min-width:60%}
  ul.stats{margin:4px 0 6px;padding-left:16px;line-height:1.45}ul.stats li{margin-bottom:3px}
  .note{font-size:10.5px;color:#444}
  .flag{color:#8A4B00}
  .warnbox{border:1px solid #c98a00;padding:5px 8px}
  .two{display:grid;grid-template-columns:1fr 1.4fr;gap:12px;align-items:start}
  .figs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;margin:6px 0}
  figure{margin:0;break-inside:avoid}figure svg{width:100%;height:auto;display:block}
  figcaption{font-size:9.5px;color:#444;margin-top:2px;line-height:1.35}figcaption.t{font-size:10.5px;color:#111;margin:0 0 3px}
  .legend{display:flex;flex-wrap:wrap;gap:2px 14px;font-size:10.5px;color:#333;margin:4px 0}
  .legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  code{font-family:ui-monospace,Menlo,monospace;font-size:10px}
  .procfig{break-inside:avoid;margin:4px 0 6px}.procfig svg{width:100%;height:auto;max-height:58mm;display:block}
  .sig{break-inside:avoid;margin-top:26px}
  .foot{margin-top:10px;font-size:9.5px;color:#555;border-top:1px solid #999;padding-top:4px}`;
