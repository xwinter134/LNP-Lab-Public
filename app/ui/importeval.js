// The evaluation card on Measurements: what an import just brought in, drawn the moment it lands.
//
// A results list sorted by date answers "what do I have?", which nobody asks straight after an import. What
// they ask is whether the numbers that just came in are any good and what is still missing. So an import now
// ends here: the headline numbers, a graph per sample with the runs behind each bar, where each experiment
// it touched stands, and the samples that need a look, with the reason. The numbers come from
// app/calc/evaluate.js; this file lays them out. app/ui/measurements.js calls mountImportEval() once its own
// page is built, so the screen itself only had to learn where an import's records are.
import { esc, fmt, fmtDate, kpi, table, chip, raw, todayISO } from './kit.js';
import { getSettings } from '../refdata.js';
import { describeId } from '../schema.js';
import { evaluateImport, shortLabels, median, qcChecked, TEST_LABEL, RUN_CV_LIMIT, OUTLIER_Z, OUTLIER_MIN_N } from '../calc/evaluate.js';
import { barChart, scatterChart, lineChart, figure, wireFigures, seriesColor } from './charts.js';
import { infoLink, wireLearn } from './learn.js';

/** Past this many samples the bars are too thin to read, so a chart carries the first ones and says so. */
const CHART_MAX = 40;
/** Above this many samples a per-sample chart takes the whole width of the card. */
const WIDE_FROM = 12;

const TYPE_LABEL = { single: 'single', stability: 'stability', ofat: 'OFAT', doe: 'DoE', comparison: 'comparison', reference: 'reference' };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const mono = (s) => `<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px">${esc(s)}</span>`;
const unitOf = (m) => (m.unit ? (m.unit === '%' ? ' %' : ' ' + m.unit) : '');
const meanSd = (r, m) => (r ? `${fmt(r.mean, m.digits)}${Number.isFinite(r.sd) ? ` ± ${fmt(r.sd, m.digits)}` : ''}${unitOf(m)}` : '–');
const when = (iso) => { if (!iso) return '–'; const d = new Date(iso); return `${fmtDate(iso)} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`; };
/** "79.6–195.9", but "-5.8 to -4.0": a dash between two minus signs reads as arithmetic. */
const span = (a, b, d) => (a < 0 || b < 0 ? `${fmt(a, d)} to ${fmt(b, d)}` : `${fmt(a, d)}–${fmt(b, d)}`);
const fileLabel = (name) => (name === 'pasted' ? 'pasted block' : name || '–');

/**
 * The records an import stored, and its rows still in the inbox. Imports recorded before the ids were kept
 * are found by the file's SHA-256 instead, which is exact unless the same file was imported twice.
 */
export function importRecords(ctx, imp) {
  const all = ctx.store.all('measurements');
  const byId = new Map(all.map((m) => [m.id, m]));
  const ids = Array.isArray(imp.measurementIds) ? imp.measurementIds : null;
  const records = ids ? ids.map((id) => byId.get(id)).filter(Boolean) : all.filter((m) => imp.sha256 && m.raw?.sha256 === imp.sha256);
  const box = ctx.store.all('inbox');
  const inbox = Array.isArray(imp.inboxIds) ? box.filter((r) => imp.inboxIds.includes(r.id)) : box.filter((r) => imp.sha256 && r.raw?.sha256 === imp.sha256);
  return { records, inbox, all, deleted: ids ? ids.length - records.length : 0, legacy: !ids };
}

/**
 * An inbox row assigned later still came in with its import, so its new record joins that import's list and
 * the evaluation, if it is open, takes it in on the next draw.
 */
export function linkAssignedToImport(ctx, inboxId, measurementId) {
  for (const imp of ctx.store.all('imports')) {
    if (!(imp.inboxIds || []).includes(inboxId) || (imp.measurementIds || []).includes(measurementId)) continue;
    ctx.store.put('imports', { ...imp, measurementIds: [...(imp.measurementIds || []), measurementId] });
  }
}

/** Puts the evaluation (when the address asks for one) under the page title, and the recent imports under the import card. */
export function mountImportEval(el, ctx) {
  const current = ctx.params.evaluated || '';
  const head = el.querySelector('.crumb')?.nextElementSibling;
  if (current && head) {
    let card;
    // The import has already been stored by the time this runs; a fault in drawing it must not cost the
    // screen the results list underneath.
    try { card = evaluationCard(ctx, getSettings(ctx), current); }
    catch (err) { card = `<div class="card" id="importEval"><div class="evalHead"><h2>Evaluation of this import</h2><a class="btn" href="#/measurements">Close</a></div><div class="note warn">The evaluation could not be drawn: ${esc(err.message)}. The results themselves are stored and listed below.</div></div>`; }
    head.insertAdjacentHTML('afterend', card);
    const node = el.querySelector('#importEval');
    wireFigures(node); wireLearn(node);
  }
  const recent = recentImportsCard(ctx, current);
  if (!recent) return;
  const importCard = el.querySelector('#csvFile')?.closest('.card');
  if (importCard) importCard.insertAdjacentHTML('afterend', recent); else el.insertAdjacentHTML('beforeend', recent);
}

/** The last five imports, each of which reopens its evaluation. */
export function recentImportsCard(ctx, current = '') {
  // Newest first; two imports in the same millisecond keep the order they were stored in.
  const imps = ctx.store.all('imports').map((imp, i) => ({ imp, i }))
    .sort((a, b) => String(b.imp.importedAt || '').localeCompare(String(a.imp.importedAt || '')) || b.i - a.i).slice(0, 5).map((x) => x.imp);
  if (!imps.length) return '';
  // An import records the tests it read; one stored before it did is named by its first stored result (or inbox row).
  const testById = new Map([...ctx.store.all('measurements'), ...ctx.store.all('inbox')].map((m) => [m.id, m.test]));
  const testsOf = (i) => (Array.isArray(i.tests) && i.tests.length ? i.tests : [[...(i.measurementIds || []), ...(i.inboxIds || [])].map((id) => testById.get(id)).find(Boolean) || i.test].filter(Boolean));
  const testOf = (i) => { const ts = testsOf(i); return ts.length ? `${ts.map((t) => TEST_LABEL[t] || t).join(' + ')} · ` : ''; };
  return `<div class="card" id="recentImports"><h2>Recent imports</h2>
    ${table(['When', 'From', 'What came in', ''], imps.map((i) => ({ cells: [
      when(i.importedAt), raw(mono(fileLabel(i.fileName))),
      `${testOf(i)}${plural(i.rows ?? i.samples ?? 0, 'sample')} · ${i.imported ?? 0} stored${i.inbox ? ` · ${i.inbox} to the inbox` : ''}`,
      raw(i.id === current ? '<span class="muted">shown above</span>' : `<a href="#/measurements?evaluated=${encodeURIComponent(i.id)}" data-evaluate="${esc(i.id)}">Evaluate</a>`),
    ] })))}</div>`;
}

function evaluationCard(ctx, settings, impId) {
  const close = '<a class="btn" href="#/measurements">Close</a>';
  const imp = ctx.store.get('imports', impId);
  if (!imp) return `<div class="card" id="importEval"><div class="evalHead"><h2>Evaluation of this import</h2>${close}</div><p class="muted">That import is no longer on record.</p></div>`;
  const { records, inbox, all, deleted, legacy } = importRecords(ctx, imp);
  const ev = evaluateImport({ records, inbox, experiments: ctx.store.all('experiments'), batches: ctx.store.all('batches'), measurements: all, qc: settings.qc, info: imp, today: todayISO() });
  const notes = [
    deleted ? `${plural(deleted, 'result')} from this import ${deleted === 1 ? 'has' : 'have'} been deleted since, and ${deleted === 1 ? 'is' : 'are'} left out.` : '',
    legacy ? 'This import is older than the evaluation, so its results were found by the file’s fingerprint.' : '',
  ].filter(Boolean);
  return `<div class="card" id="importEval">
    <div class="evalHead"><h2>Evaluation of this import</h2><span class="muted">${esc(fileLabel(imp.fileName))} · ${esc(when(imp.importedAt))}</span>${close}</div>
    <p style="margin:8px 0 0">${lede(ev, imp, settings.qc)}</p>
    ${notes.map((n) => `<p class="muted" style="margin:4px 0 0">${esc(n)}</p>`).join('')}
    ${kpis(ev, perVial(imp))}
    ${charts(ev, settings, imp)}
    ${ev.experiments.length ? `<h3>Where each experiment stands</h3>${ev.experiments.map((x) => experimentBlock(x, ev)).join('')}` : ''}
    ${flaggedTable(ev)}
    ${numbersTable(ev)}
  </div>`;
}

/**
 * Whether an import read several tests from one sheet. Its file then holds more results than samples (a size
 * and an EE for each vial), and the evaluation counts results; said as "6 samples" alone, every vial would be
 * counted once per test, so the samples are named as well.
 */
const perVial = (imp) => (imp?.tests?.length || 0) > 1 && Number.isFinite(imp.rows);

/** Two or three sentences a person would say looking over your shoulder. */
function lede(ev, imp = null, qc = {}) {
  const h = ev.headline;
  const exps = ev.experiments.map((x) => esc(describeId(x.id)));
  const where = exps.length === 1 ? exps[0] : exps.length === 2 ? `${exps[0]} and ${exps[1]}` : `${exps.length} experiments`;
  const bits = [];
  if (h.stored) bits.push(`${h.stored} stored${exps.length ? ` with ${where}` : ''}`);
  if (h.inbox) bits.push(`${h.inbox} waiting in the inbox below, because ${h.inbox === 1 ? 'its name matched' : 'their names matched'} nothing expected`);
  if (h.skipped) bits.push(`${h.skipped} left out`);
  const count = perVial(imp) ? `<b>${plural(imp.rows, 'sample')}</b> (${plural(h.samples, 'result')})` : `<b>${plural(h.samples, 'sample')}</b>`;
  const first = `${count} in ${ev.tests.length ? `the ${ev.tests.map((t) => TEST_LABEL[t] || t).join(' and ')} data` : 'the file'}${bits.length ? `: ${bits.join(', ')}` : ''}.`;
  if (!ev.samples.length) return `${first} Nothing from it was stored, so there is nothing to evaluate.`;
  const hasRuns = ev.samples.some((s) => Object.values(s.metrics).some((m) => m.n >= 2));
  // Say only what was actually checked: zeta has no limits in Settings, a limit switched off there checks
  // nothing, and below five samples nobody is called unlike the rest, so "none is far from the rest" would be a
  // claim nothing tested.
  const { checked, off } = qcChecked(ev.tests, qc, ev.samples);
  const judged = ev.tests.some((t) => ev.samples.filter((s) => s.test === t).length >= OUTLIER_MIN_N);
  const checks = [checked.length ? `every sample is inside the QC limits in Settings for ${and(checked)}` : '', hasRuns && ev.tests.includes('dls') ? 'the runs of each sample agree' : '', judged ? 'none is far from the rest' : ''].filter(Boolean);
  const verdict = h.flagged
    ? `<b>${plural(h.flagged, 'sample needs', 'samples need')} a look</b>; ${h.flagged === 1 ? 'it is' : 'they are'} listed at the end of this card with the reason.`
    : checks.length ? `Nothing stands out: ${checks.length > 1 ? `${checks.slice(0, -1).join(', ')} and ${checks[checks.length - 1]}` : checks[0]}.` : '';
  const few = !judged ? ` With fewer than ${OUTLIER_MIN_N} samples, none is singled out as unlike the others.` : '';
  const single = h.singleRun && hasRuns ? ` ${plural(h.singleRun, 'sample was', 'samples were')} measured once, so ${h.singleRun === 1 ? 'it has' : 'they have'} no error bar.` : '';
  const unchecked = off.length ? ` ${and(off.map((t) => TEST_LABEL[t] || t))} ${off.length === 1 ? 'has' : 'have'} no QC limit switched on in Settings, so ${off.length === 1 ? 'it was' : 'they were'} not checked against one.` : '';
  return `${first} ${verdict}${single}${unchecked}${few}`;
}

/** "a", "a and b", "a, b and c". */
const and = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0] || '');

function kpis(ev, results = false) {
  const h = ev.headline;
  const cells = [kpi(results ? 'Results in the data' : 'Samples in the data', h.samples), kpi('Stored', h.stored), kpi('In the inbox', h.inbox), kpi('Need a look', h.flagged)];
  for (const t of ev.tests) {
    for (const m of h.byTest[t].metrics) {
      if (!m.n) continue;
      // Size reads as a level with a spread; PDI is read against a ceiling, so its range is the headline.
      if (m.key === 'pdi') cells.push(kpi(m.n > 1 ? 'PDI · range' : 'PDI', m.n > 1 ? span(m.min, m.max, 3) : fmt(m.mean, 3), m.n > 1 ? `mean ${fmt(m.mean, 3)}` : ''));
      else cells.push(kpi(m.n > 1 ? `${m.label} · mean ± SD` : m.label, `${fmt(m.mean, m.digits)}${m.n > 1 && Number.isFinite(m.sd) ? ` ± ${fmt(m.sd, m.digits)}` : ''}${unitOf(m)}`, m.n > 1 ? `range ${span(m.min, m.max, m.digits)}${unitOf(m)}` : ''));
    }
  }
  return `<div class="evalKpis">${cells.join('')}</div>`;
}

/**
 * Wide enough that the sample names under the bars do not run into each other. barChart turns a name longer
 * than 7 characters by 35° and leaves a shorter one level, name by name; turned, 24 px apart clears the next
 * one, and a level name needs its own width (about 7 px a character at 11 px) plus a gap.
 */
function chartWidth(labels) {
  const slot = Math.max(24, ...labels.map((l) => (String(l).length > 7 ? 24 : 7 * String(l).length + 10)));
  return Math.max(460, 62 + slot * labels.length);
}

/**
 * The names under the bars. Shortened ones read best, but a level name of a few characters needs far more
 * room than a turned one, so across forty samples "E1-F10" would stretch the chart until the browser shrinks
 * it, type and all. Past about a card's width the full names, which are all long enough to be turned, win.
 */
function axisLabels(names) {
  const short = shortLabels(names);
  const ws = chartWidth(short.labels), wf = chartWidth(names);
  return ws > 1040 && wf < ws ? { labels: names.map(String), prefix: '', suffix: '' } : short;
}

/**
 * A reference line is labelled only where its label cannot land on the data: the label sits just above the
 * line, so that is safe exactly when nothing is drawn above it. Otherwise the caption names the line.
 */
const refLine = (y, text, values) => ({ y, label: values.every((v) => v <= y) ? text : '' });

function charts(ev, settings, imp) {
  const qc = settings.qc || {};
  const base = String(imp.fileName || 'import').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'import';
  const figs = [];
  const notes = [];
  for (const t of ev.tests) {
    const all = ev.samples.filter((s) => s.test === t && Object.keys(s.metrics).length);
    if (!all.length) continue;
    const shown = all.slice(0, CHART_MAX);
    if (all.length > shown.length) notes.push(`The ${t === 'dls' ? 'DLS' : t} graphs show the first ${CHART_MAX} of ${all.length} samples, experiment by experiment; the table at the end has every one.`);
    const { labels, prefix, suffix } = axisLabels(shown.map((s) => s.sampleName));
    const expIds = [...new Set(shown.map((s) => s.experimentId).filter(Boolean))];
    const anyInbox = shown.some((s) => s.source === 'inbox');
    const colorOf = (s) => (s.source === 'inbox' ? 'var(--ink3)' : seriesColor(Math.max(0, expIds.indexOf(s.experimentId))));
    const legendItems = expIds.length > 1 || anyInbox ? [...expIds.map((id, i) => ({ name: describeId(id), color: seriesColor(i) })), ...(anyInbox ? [{ name: 'in the inbox', color: 'var(--ink3)' }] : [])] : null;
    const w = chartWidth(labels);
    const wide = shown.length > WIDE_FROM;
    const hasRuns = shown.some((s) => Object.values(s.metrics).some((m) => m.runs.length >= 2));
    const dropped = [prefix, suffix].filter(Boolean).map((x) => `“${x}”`);
    const nameNote = dropped.length ? ` Names leave off ${dropped.join(' and ')}.` : '';
    const how = hasRuns ? 'Bars are the mean of the runs, whiskers ± 1 SD, circles the single runs.' : 'One value per sample, so there is no error bar.';

    for (const m of ev.metrics[t]) {
      const vals = shown.flatMap((s) => { const r = s.metrics[m.key]; return r ? [r.mean + (r.sd || 0), ...r.runs] : []; }).filter(Number.isFinite);
      const bars = shown.map((s, i) => {
        const r = s.metrics[m.key];
        const flags = s.flags.filter((f) => f.metric === m.key || (m.key === 'zave_nm' && f.kind === 'count'));
        return { label: labels[i], mean: r?.mean, sd: r?.sd, n: r?.n, points: r && r.runs.length >= 2 ? r.runs : [], color: colorOf(s), flag: flags.map((f) => f.text).join('; ') };
      });
      let ref = [], limits = '';
      if (m.key === 'zave_nm' && Number.isFinite(qc.zaveMin) && Number.isFinite(qc.zaveMax)) {
        ref = [refLine(qc.zaveMin, `limit ${qc.zaveMin} nm`, vals), refLine(qc.zaveMax, `limit ${qc.zaveMax} nm`, vals)];
        limits = ` Dashed lines: the size window in Settings, ${qc.zaveMin}–${qc.zaveMax} nm.`;
      } else if (m.key === 'pdi' && Number.isFinite(qc.pdiMax)) {
        ref = [refLine(qc.pdiMax, `limit ${qc.pdiMax}`, vals)];
        limits = ` Dashed line: the PDI limit in Settings, ${qc.pdiMax}.`;
      } else if (m.key === 'ee_pct' && Number.isFinite(qc.eeMin)) {
        ref = [refLine(qc.eeMin, `limit ${qc.eeMin} %`, vals)];
        limits = ` Dashed line: the lowest encapsulation Settings accepts, ${qc.eeMin} %.`;
      } else if (vals.length && vals.every((v) => v < 0)) {
        // All below zero: a bar has to grow from zero to be read as a value, so zero has to be on the axis.
        ref = [{ y: 0, label: '' }];
        limits = ' The dashed line is zero.';
      }
      const flagged = bars.some((b) => b.flag) ? ' A paler bar has a flag on this number.' : '';
      const svg = barChart({ bars, ylab: `${m.label}${m.unit ? ` (${m.unit})` : ''}`, title: `${m.label} per sample`, ref, w, h: 250 });
      // A wide chart in a narrow window would shrink its type with it; below this width the drawing scrolls
      // sideways instead, while its title, download buttons and caption stay in view.
      const drawing = wide && svg ? `<div class="figScroll"><div style="min-width:${Math.min(w, 880)}px">${svg}</div></div>` : svg;
      const fig = figure(drawing, { title: `${m.label} per sample`, caption: `${how}${limits}${flagged}${nameNote}`, name: `${base}_${m.key}`, legendItems });
      figs.push(`<div${wide ? ' class="wide"' : ''}>${fig}</div>`);
    }

    // Size against PDI: where a sample sits on both at once, which neither bar chart shows.
    if (t === 'dls' && ev.metrics[t].some((m) => m.key === 'zave_nm') && ev.metrics[t].some((m) => m.key === 'pdi')) {
      const pts = shown.filter((s) => s.metrics.zave_nm && s.metrics.pdi).map((s) => ({ x: s.metrics.zave_nm.mean, y: s.metrics.pdi.mean, label: s.sampleName, color: colorOf(s) }));
      if (pts.length >= 3) {
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        // A size limit is drawn only when a sample comes near it; otherwise it would squeeze the cloud into a corner.
        const refX = [qc.zaveMin, qc.zaveMax].filter((x) => Number.isFinite(x) && (x === qc.zaveMin ? Math.min(...xs) < x * 1.15 : Math.max(...xs) > x * 0.85)).map((x) => ({ x, label: '' }));
        // The PDI label sits at the right-hand end of its line, which is where a size limit line would cross it.
        const refY = Number.isFinite(qc.pdiMax) ? [refLine(qc.pdiMax, refX.length ? '' : `PDI limit ${qc.pdiMax}`, ys)] : [];
        const svg = scatterChart({ points: pts, xlab: 'Z-average (nm)', ylab: 'PDI', title: 'Size against PDI', refX, refY });
        figs.push(`<div>${figure(svg, { title: 'Size against PDI', caption: `Each point is one sample. A sample off on its own, or a drift towards the top right (larger and broader), is the pattern to look for.${refY.length ? ' Dashed: the PDI limit' : ''}${refX.length ? ' and the size window' : ''}${refY.length || refX.length ? '.' : ''}`, name: `${base}_size_vs_pdi`, legendItems })}</div>`);
      }
    }
  }
  if (!figs.length) return '';
  return `${notes.map((n) => `<p class="muted">${esc(n)}</p>`).join('')}<div class="figs evalFigs">${figs.join('')}</div>`;
}

function testPhrase(t) {
  const fromHere = t.fromImport ? ` (${t.fromImport} from this import)` : '';
  // Past due is the news when there is any; otherwise when the next one is.
  const when = t.overdue ? `, ${t.overdue === t.open ? (t.open === 1 ? '' : 'all ') : `${t.overdue} `}past due` : t.nextDue ? `, next due ${fmtDate(t.nextDue)}` : '';
  if (!t.open) return t.total === 1 ? `${t.label} in${fromHere}` : `all ${t.total} ${t.label} in${fromHere}`;
  if (!t.done) return `${t.label} still open for ${t.open}${when}`;
  return `${t.done} of ${t.total} ${t.label} in${fromHere}, ${t.open} still open${when}`;
}

function experimentBlock(x, ev) {
  // Every experiment's figures and statistics are on Design & results now, beside its data sheet, so an import
  // leads there whatever the type, and the reader does not have to go back into the experiment and scroll.
  const links = [
    `<a class="btn primary" href="#/doe?id=${encodeURIComponent(x.id)}">See the results</a>`,
    x.open ? `<a href="#/measurements?waiting=${encodeURIComponent(x.id)}">What is still due (${x.open})</a>` : '',
  ].filter(Boolean).join(' · ');
  const progress = x.byTest.length ? x.byTest.map(testPhrase).join('; ') : 'nothing was planned for it to measure';
  const done = x.total && !x.open ? ' Everything it planned to measure is in.' : '';
  return `<div class="evalExp" data-exp="${esc(x.id)}">
    <div><b>${esc(describeId(x.id))}</b>${x.name ? ` · ${esc(x.name)}` : ''} ${chip(TYPE_LABEL[x.type] || x.type || '')}</div>
    <p>${esc(progress.charAt(0).toUpperCase() + progress.slice(1))}.${done} <span class="evalLinks">${links}</span></p>
    ${x.groups.map((g) => groupHtml(g, x, ev)).join('')}</div>`;
}

const spreadText = (g) => g.metrics.filter((m) => m.n).map((m) => `${m.label} ${fmt(m.mean, m.digits)}${Number.isFinite(m.sd) ? ` ± ${fmt(m.sd, m.digits)}` : ''}${unitOf(m)}${Number.isFinite(m.cv) ? `, CV ${fmt(m.cv, 1)} %` : ''}`).join('; ');

function groupHtml(g, x, ev) {
  if (g.kind === 'centre') {
    if (g.measured < 2) return `<p class="muted">${infoLink('center', 'Centre points')}: ${g.measured} of ${g.planned} measured so far; their spread needs at least two.</p>`;
    return `<p>${infoLink('center', 'Centre points')} (${g.measured} of ${g.planned} measured): ${esc(spreadText(g))}. They repeat one setting, so this spread is the pure error, the ${infoLink('noise', 'noise')} every factor effect in the model is judged against.</p>`;
  }
  if (g.kind === 'repeats') {
    if (g.measured < 2) return `<p class="muted">Batch to batch: ${g.measured} of ${g.planned} repeats measured so far; the spread needs at least two.</p>`;
    // Set beside the run-to-run spread inside one sample, the batch-to-batch figure says where the variation lives.
    const first = g.metrics.find((m) => m.n >= 2);
    const runCv = first ? median(ev.samples.filter((s) => s.experimentId === x.id && s.test === g.test).map((s) => s.metrics[first.key]?.cv ?? NaN)) : null;
    const where = first && Number.isFinite(first.cv) && Number.isFinite(runCv)
      ? ` Inside one sample the runs vary by a median ${fmt(runCv, 1)} %${first.cv > 2 * runCv ? ', so most of the spread comes from making the batch, not from measuring it' : first.cv < 1.5 * runCv ? ', about as much as between batches: the process repeats as well as the instrument can tell' : ''}.`
      : '';
    return `<p>Batch to batch (${g.measured} of ${g.planned} repeats measured): ${esc(spreadText(g))}.${where}</p>`;
  }
  if (g.kind === 'stability') return stabilityHtml(g, x);
  return '';
}

function stabilityHtml(g, x) {
  const [m1, m2] = g.metrics;
  const head = ['Shelf', { label: 'Day', right: true }, { label: 'n', right: true }, { label: m1.label, sub: `${m1.unit ? m1.unit + ', ' : ''}mean ± SD`, right: true }, { label: 'Change', sub: 'since the first day', right: true }];
  if (m2) head.push({ label: m2.label, sub: 'mean', right: true });
  const rows = g.rows.map((r) => ({ cells: [r.condition, r.timepoint, r.n,
    r.metrics[m1.key] ? `${fmt(r.metrics[m1.key].mean, m1.digits)}${Number.isFinite(r.metrics[m1.key].sd) ? ` ± ${fmt(r.metrics[m1.key].sd, m1.digits)}` : ''}` : '–',
    Number.isFinite(r.change[m1.key]) ? `${r.change[m1.key] >= 0 ? '+' : '−'}${fmt(Math.abs(r.change[m1.key]), m1.digits)}` : '',
    ...(m2 ? [r.metrics[m2.key] ? fmt(r.metrics[m2.key].mean, m2.digits) : '–'] : [])] }));
  let chart = '';
  if (g.timepoints.length >= 2) {
    const lines = g.lines.slice(0, 8);
    const series = lines.map((l, i) => ({ name: `${l.batchId} · ${l.condition}`, color: seriesColor(i), points: l.points.map((p) => ({ x: p.x, y: p.values[m1.key]?.mean, sd: p.values[m1.key]?.sd, label: `day ${p.x}` })) }));
    const svg = lineChart({ series, xlab: 'Days in storage', ylab: `${m1.label}${m1.unit ? ` (${m1.unit})` : ''}`, title: `${m1.label} over time` });
    chart = figure(svg, { title: `${m1.label} over time, per formulation and shelf`, caption: `One line per formulation on each shelf${g.lines.length > lines.length ? ` (the first ${lines.length} of ${g.lines.length})` : ''}; whiskers ± 1 SD of the runs.`, name: `${x.id}_stability_${m1.key}`, legendItems: series.map((s) => ({ name: s.name, color: s.color })) });
  }
  return `<div class="figs evalFigs" style="align-items:start;margin-top:6px"><div><p class="muted" style="margin-top:0">By shelf and day, everything measured so far for this study (formulations averaged).</p>${table(head, rows)}</div><div>${chart}</div></div>`;
}

function resultText(s, ev) {
  return (ev.metrics[s.test] || []).filter((m) => s.metrics[m.key]).map((m) => (m.key === 'pdi' ? `PDI ${meanSd(s.metrics[m.key], m)}` : meanSd(s.metrics[m.key], m))).join(' · ') || '–';
}

function sampleCell(s) {
  return s.source === 'inbox' ? raw(`${mono(s.sampleName)} <span class="muted">in the inbox</span>`) : raw(`<a href="#/measurements?id=${encodeURIComponent(s.id)}">${esc(s.sampleName)}</a>`);
}

function flaggedTable(ev) {
  const flagged = ev.samples.filter((s) => s.flags.length);
  if (!flagged.length) return '';
  const order = { limit: 0, count: 1, cv: 2, outlier: 3 };
  return `<h3>Samples that need a look</h3>
    ${table(['Sample', 'Experiment', 'Result', 'Why'], flagged.map((s) => ({ cells: [
      sampleCell(s), s.experimentId ? describeId(s.experimentId) : '–', resultText(s, ev),
      raw([...s.flags].sort((a, b) => order[a.kind] - order[b.kind]).map((f) => `<div>${f.level === 'warn' ? chip('check', 'warn') : chip('note', 'info')} ${esc(f.text)}</div>`).join('')),
    ] })))}
    <p class="muted small">"Check" is against the limits in Settings, or runs of one sample that differ by more than ${RUN_CV_LIMIT} %. "Note" marks a sample far from the others in this import (a robust z-score above ${OUTLIER_Z}, from the median and the median absolute deviation, so one odd sample cannot hide itself); a sample can be far from the others for a good reason (a corner of a design, the warm shelf at the last timepoint), so look before you discard it.</p>`;
}

function numbersTable(ev) {
  if (!ev.samples.length) return '';
  const tests = ev.tests;
  const blocks = tests.map((t) => {
    const ms = ev.metrics[t] || [];
    const mine = ev.samples.filter((s) => s.test === t);
    const head = ['Sample', 'Experiment', { label: 'Runs', right: true }, ...ms.flatMap((m) => [{ label: m.label, sub: `${m.unit ? m.unit + ', ' : ''}mean ± SD`, right: true }, { label: 'CV', sub: '%', right: true }])];
    if (t === 'dls') head.push({ label: 'Count rate', sub: 'kcps', right: true });
    head.push('Flags');
    const rows = mine.map((s) => ({ cells: [sampleCell(s), s.experimentId ? s.experimentId : '–', Math.max(1, ...Object.values(s.metrics).map((m) => m.n)),
      ...ms.flatMap((m) => { const r = s.metrics[m.key]; return [r ? `${fmt(r.mean, m.digits)}${Number.isFinite(r.sd) ? ` ± ${fmt(r.sd, m.digits)}` : ''}` : '–', r && Number.isFinite(r.cv) ? fmt(r.cv, 1) : '–']; }),
      ...(t === 'dls' ? [Number.isFinite(s.countRate) ? fmt(s.countRate, 0) : '–'] : []),
      raw(s.flags.length ? chip(String(s.flags.length), s.flags.some((f) => f.level === 'warn') ? 'warn' : 'info') : chip('ok', 'ok'))] }));
    return `${tests.length > 1 ? `<h3>${esc(t)}</h3>` : ''}${table(head, rows)}`;
  }).join('');
  return `<details style="margin-top:12px"><summary class="muted" style="cursor:pointer">Every sample in numbers (${ev.samples.length})</summary>${blocks}</details>`;
}
