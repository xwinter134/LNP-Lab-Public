// The evaluation half of an experiment page: the next-step strip at the top and the Results card. The numbers
// and the sentences come from calc/results.js; this module only lays them out — statistics first, because
// that is the answer, then the figures, then the data table they were computed from.
//
// The page is read more than it is used, so a table says each thing once: a stability study gets one table
// with the days across (which is also its plan: what is missing, what is due), and a long table shows its
// first rows until asked for the rest.
import { raw, fmt, table, esc, fmtDate, chip } from './kit.js';
import { TESTS } from '../calc/experiment.js';
import { barChart, lineChart, figure, legend, seriesColor } from './charts.js';
import { outsideQc, responseByKey, trendSummary, stabilityFigureLine } from '../calc/results.js';
import { groupBy } from '../calc/indexes.js';

const condName = (c) => String(c || '').replace(/^(-?\d+)C$/i, '$1 °C');
const axisLabel = (r) => `${r.label}${r.unit ? ` (${r.unit})` : ''}`;
// The sign is decided on the rounded number, so a change too small to show reads "0.000" and not "+0.000".
const signed = (x, dp) => { if (!Number.isFinite(x)) return '–'; const v = Number(x.toFixed(dp)); return (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(x), dp); };
const unitOf = (r) => (r.unit === '%' ? ' %' : r.unit ? ` ${r.unit}` : '');
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** "+3.8 nm (+4.7 %)", or for EE "−1.5 points": a change in a percentage is in points. */
export function changeText(r, d) {
  if (!d || !Number.isFinite(d.abs)) return '';
  return r.points ? `${signed(d.abs, r.dp)} points` : `${signed(d.abs, r.dp)}${unitOf(r)}${Number.isFinite(d.pct) ? ` (${signed(d.pct, 1)} %)` : ''}`;
}

/** One cell of the data table: mean ± SD on top, n and CV underneath, and anything else (a change) below. */
function cell(r, c, qc, extra = '') {
  if (!c) return raw('<span class="muted">–</span>');
  const bad = outsideQc(r.key, c.mean, qc);
  const top = c.sd != null ? `${fmt(c.mean, r.dp)} ± ${fmt(c.sd, r.dp)}` : fmt(c.mean, r.dp);
  // A value taken before the final product (IPC4 …) is only shown when there is no final one; say which it is.
  const sub = [`n = ${c.n}`, c.cv != null ? `CV ${fmt(c.cv, 1)} %` : null, c.stage && c.stage !== 'final' && !/^T\d+$/i.test(c.stage) ? c.stage : null].filter(Boolean).join(' · ');
  return raw(`<span class="res-v${bad ? ' qc-out' : ''}"${bad ? ' title="outside the QC limit in Settings"' : ''}>${top}</span><div class="res-sub">${esc(sub)}</div>${extra}`);
}

const head = (r) => ({ label: axisLabel(r), sub: 'mean ± SD', right: true });

/* ---------- the next step ---------- */

/**
 * What to do next, from the records: make what is still planned, measure what is still due, then evaluate.
 * A new experiment otherwise opens on a page of plans with no hint which of them is the next thing to do.
 */
export function nextStepStrip(exp, st, res) {
  if (exp.status === 'done') return '';
  let text, actions;
  if (st.planned) {
    text = `Next step: make the formulations — ${st.planned} planned`;
    actions = `<a class="btn" href="#/formulation?batch=${esc(st.firstPlanned)}">Open ${esc(st.firstPlanned)}</a>
      <button class="primary" id="nextMarkProduced" data-bulk="produced" title="Set every planned formulation of this experiment to produced">Mark all produced</button>`;
  } else if (st.open) {
    const when = st.overdue ? `, ${st.overdue} of them overdue` : st.nextDue ? `, the next on ${fmtDate(st.nextDue)}` : '';
    text = `Next step: measure — ${st.open} result${st.open === 1 ? '' : 's'} still due${when}`;
    actions = `<a class="btn primary" href="#/doe?id=${esc(exp.id)}" title="The data sheet of this experiment, to type or paste the results into, beside its figures">Enter results</a><a class="btn" href="#/measurements?waiting=${esc(exp.id)}">What to measure</a>${res.measuredRows ? '<button id="nextShowResults">Results so far</button>' : ''}`;
  } else {
    text = 'Next step: evaluate — every result is in';
    actions = `<a class="btn primary" href="#/doe?id=${esc(exp.id)}">Design &amp; results</a><button id="nextShowResults">Results</button>`;
  }
  return `<div class="nextstep" id="nextStep"><span class="ns-text">${esc(text)}</span><span class="ns-act">${actions}</span></div>`;
}

/* ---------- figures ---------- */

/** QC limits as dashed lines. Unlabelled on purpose: a label on a line that crosses the bars lands on a bar. */
function qcLines(key, qc) {
  if (!qc) return [];
  if (key === 'zave') return [qc.zaveMin, qc.zaveMax].filter(Number.isFinite);
  if (key === 'pdi') return [qc.pdiMax].filter(Number.isFinite);
  if (key === 'ee') return [qc.eeMin].filter(Number.isFinite);
  return [];
}
// No-break spaces keep a number and its unit on one line when the caption wraps.
function qcCaption(key, qc, lines) {
  if (!qc || !lines.length) return '';
  if (key === 'zave') return lines.length > 1 ? `Dashed lines: QC limits ${lines[0]} and ${lines[1]} nm.` : `Dashed line: QC limit ${lines[0]} nm.`;
  if (key === 'pdi') return `Dashed line: QC limit, PDI ≤ ${lines[0]}.`;
  if (key === 'ee') return `Dashed line: QC limit, EE ≥ ${lines[0]} %.`;
  return '';
}

/**
 * Over time the drift is the picture, so a QC limit is drawn only when the data come within reach of it:
 * a 150 nm ceiling over a series that moves from 80 to 84 nm would flatten the very change being shown.
 */
function nearLimits(key, qc, values) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return [];
  const lo = Math.min(...v), hi = Math.max(...v);
  return qcLines(key, qc).filter((y) => (key === 'ee' || (key === 'zave' && y === qc.zaveMin) ? lo <= y * 1.2 : hi >= y * 0.8));
}

const FIG_KEYS = ['zave', 'pdi', 'ee'];

/*
 * Each figure builder returns {figs, legend, note}: the charts as {svg, title, caption, name}, one legend for
 * all of them (the series are the same in every chart of a group, so they are named once), and one line on
 * what a bar or a point is. The charts stay data until the Results card wraps them in figure(), so the printed
 * report (report.js) can draw the very same ones without the download buttons.
 */

function barFigures(exp, res, { qc, compLabel }) {
  const st = res.stats || {};
  const figs = [];
  let legendItems = null, note;
  if (st.kind === 'comparison') {
    legendItems = st.arms.map((a, i) => ({ name: `${a.compositionId != null ? compLabel(a.compositionId) : a.label} · ${a.batchIds.join(', ')}`, color: seriesColor(i) }));
    note = st.arms.some((a) => a.batchIds.length > 1)
      ? 'Bars: mean ± SD per arm — between batches where the arm was made more than once (circles are the batch means), otherwise of the instrument’s repeat runs on its one batch (circles are the runs).'
      : 'Bars: mean ± SD of the instrument’s repeat runs on each arm’s one batch; circles are the runs.';
  } else {
    note = 'Bars: mean ± SD of the instrument’s repeat runs on each batch; circles are the runs.';
    if (st.kind === 'repeats' && Object.values(st.byResponse).some((g) => g.n >= 2)) note += ' The last bar, "Mean", is the mean of the batch means ± the SD between batches, with each batch as a circle.';
  }
  for (const key of FIG_KEYS) {
    const r = res.responses.find((x) => x.key === key);
    if (!r) continue;
    let bars;
    if (st.kind === 'comparison') {
      bars = st.arms.map((a, i) => {
        const g = a.byResponse[key];
        return { label: a.compositionId != null ? `#${a.compositionId}` : a.batchIds[0], mean: g?.mean, sd: g?.sd, n: g?.n, points: g?.points, color: seriesColor(i) };
      });
    } else {
      bars = res.rows.map((row) => { const c = row.cells[key]; return { label: row.batchId, mean: c?.mean, sd: c?.sd, n: c?.n, points: c?.points, color: seriesColor(0) }; });
      const g = st.kind === 'repeats' ? st.byResponse[key] : null;
      if (g && g.n >= 2) bars.push({ label: 'Mean', mean: g.mean, sd: g.sd, n: g.n, points: g.points, color: seriesColor(1) });
    }
    const lines = qcLines(key, qc);
    const svg = barChart({ bars, ylab: axisLabel(r), title: `${r.label} per ${st.kind === 'comparison' ? 'arm' : 'formulation'}`, ref: lines.map((y) => ({ y, label: '' })), w: 380, h: 240 });
    if (svg) figs.push({ svg, title: axisLabel(r), caption: qcCaption(key, qc, lines), name: `${exp.id}_${key}` });
  }
  return { figs, legend: legendItems, note };
}

function stabilityFigures(exp, res, { qc }) {
  const series = res.stats?.series || [];
  const names = series.map((s, i) => ({ name: `${s.batchId} · ${condName(s.condition)}`, color: seriesColor(i) }));
  const figs = [];
  for (const key of FIG_KEYS) {
    const r = res.responses.find((x) => x.key === key);
    if (!r) continue;
    // Colours are given before empty series are dropped, so a series keeps its colour in every chart.
    const lines = series.map((s, i) => ({ name: names[i].name, color: names[i].color,
      points: s.points.filter((p) => p.cells[key]).map((p) => ({ x: p.t, y: p.cells[key].mean, sd: p.cells[key].sd, label: `day ${p.t}` })) }))
      .filter((s) => s.points.length);
    if (!lines.length) continue;
    const refs = nearLimits(key, qc, lines.flatMap((s) => s.points.map((p) => p.y)));
    const title = `${r.label} over time`;
    const svg = lineChart({ series: lines, xlab: 'Day', ylab: axisLabel(r), title, ref: refs.map((y) => ({ y, label: '' })), w: 460, h: 250 });
    if (svg) figs.push({ svg, title, caption: qcCaption(key, qc, refs), name: `${exp.id}_${key}_over_time`, key });
  }
  return { figs, legend: names, note: 'One line per formulation and storage condition; each point is the mean ± SD of the instrument’s repeat runs on that day.', wide: true };
}

function ofatFigures(exp, res, { qc }) {
  const st = res.stats;
  const figs = [];
  const xlab = `${st.factorName}${st.unit ? ` (${st.unit})` : ''}`;
  for (const key of FIG_KEYS) {
    const r = res.responses.find((x) => x.key === key);
    if (!r) continue;
    const have = st.levels.filter((l) => l.byResponse[key]);
    if (!have.length) continue;
    const title = `${r.label} against ${st.factorName}`;
    const refs = nearLimits(key, qc, have.map((l) => l.byResponse[key].mean));
    // Mixers are not points on an axis: nothing lies between IJM 1 and IJM 3, so a line through them would
    // draw a trend that is not there. They are bars, one per mixer, like the arms of a comparison.
    if (st.categorical) {
      const bars = have.map((l, i) => { const g = l.byResponse[key]; return { label: l.text, mean: g.mean, sd: g.sd, n: g.n, points: g.points, color: seriesColor(i) }; });
      const svg = barChart({ bars, ylab: axisLabel(r), title, ref: refs.map((y) => ({ y, label: '' })), w: 400, h: 240 });
      if (svg) figs.push({ svg, title, caption: qcCaption(key, qc, refs), name: `${exp.id}_${key}_vs_${st.factor}` });
      continue;
    }
    const pts = have.map((l) => ({ x: l.level, y: l.byResponse[key].mean, sd: l.byResponse[key].sd, label: `${st.factorName} ${l.level}` }));
    const svg = lineChart({ series: [{ name: r.label, color: seriesColor(0), points: pts }], xlab, ylab: axisLabel(r), title, ref: refs.map((y) => ({ y, label: '' })), w: 400, h: 240 });
    if (svg) figs.push({ svg, title, caption: qcCaption(key, qc, refs), name: `${exp.id}_${key}_vs_${st.factor}` });
  }
  const repeated = st.levels.some((l) => l.batchIds.length > 1);
  return { figs, legend: null, note: repeated
    ? 'Each point: mean ± SD at that level — between batches where the level was made more than once, otherwise of the instrument’s repeat runs on its one batch.'
    : 'Each point: mean ± SD of the instrument’s repeat runs on the one batch made at that level.' };
}

/**
 * The figures of an experiment's results, by type: {figs: [{svg, title, caption, name}], legend, note, wide}.
 * None before the first result, and none for a DoE, which is read through its model on its own screen.
 */
export function resultFigures(exp, res, ctx) {
  if (!res.measuredRows || res.type === 'doe') return { figs: [], legend: null, note: '' };
  return res.type === 'stability' ? stabilityFigures(exp, res, ctx) : res.type === 'ofat' ? ofatFigures(exp, res, ctx) : barFigures(exp, res, ctx);
}

/* ---------- folding a long table ---------- */

// Past eight rows a table shows its first six and a button for the rest: the statistics above it are the
// answer, and twenty rows under them push the figures and the next card off the page.
const FOLD_AT = 8, FOLD_SHOW = 6;

/** A table whose rows beyond the first few start hidden, with the button that shows them. `tail` rows (a total) always show. */
function foldedTable(headers, rows, tail = []) {
  if (rows.length <= FOLD_AT) return table(headers, [...rows, ...tail]);
  const shown = rows.map((r, i) => (i < FOLD_SHOW ? r : { ...r, attrs: `${r.attrs || ''} data-fold hidden` }));
  return `<div class="res-fold">${table(headers, [...shown, ...tail])}
    <button class="ghost res-showall" data-showall="${rows.length}" aria-expanded="false">Show all ${rows.length} rows</button></div>`;
}

/**
 * Which folds of an experiment page the user has opened or closed ("E5:figs", "E7:ml"), and whether a stability
 * table shows every value ("E5:values"). The page is drawn again after every bench action and every time it is
 * opened, so the choice is kept for the session in a module variable, as the folds of Design & results are.
 * Only a click is recorded, never the default.
 */
const folds = new Map();
/** Whether the fold `key` is open: as the user last left it, or `dflt`. Read by the experiment screen too. */
export const foldOpen = (key, dflt = false) => folds.get(key) ?? dflt;

const VIEW_MORE = 'Show SD, change from T0, other tests, trend', VIEW_LESS = 'Show Z-ave / PDI only';

/**
 * Makes the "Show all N rows" buttons of a Results card work, the stability table's view toggle, and records
 * which folds (details[data-resfold]) are open. Delegated, so a redrawn card needs no rewiring.
 */
export function wireResults(root) {
  if (!root || root.__resWired) return;
  root.__resWired = true;
  root.addEventListener('click', (e) => {
    // The click runs before the details toggles, so the state it is about to take is the opposite of now. A
    // link or a button inside the line handles its own click and toggles nothing, so it is not recorded.
    const sum = e.target.closest?.('details[data-resfold] > summary');
    if (sum && !e.target.closest('a, button')) { folds.set(sum.parentElement.dataset.resfold, !sum.parentElement.open); return; }
    // The toggle only swaps which half of every cell is shown (CSS), so nothing is redrawn under the reader.
    const v = e.target.closest?.('[data-resview]');
    if (v) {
      const box = v.closest('.res-stab');
      const full = !box.classList.contains('res-full');
      box.classList.toggle('res-full', full);
      folds.set(v.dataset.resview, full);
      v.setAttribute('aria-pressed', String(full));
      v.textContent = full ? VIEW_LESS : VIEW_MORE;
      return;
    }
    const b = e.target.closest?.('[data-showall]');
    if (!b) return;
    const open = b.getAttribute('aria-expanded') === 'true';
    b.closest('.res-fold')?.querySelectorAll('tr[data-fold]').forEach((tr) => { tr.hidden = open; });
    b.setAttribute('aria-expanded', String(!open));
    b.textContent = open ? `Show all ${b.dataset.showall} rows` : 'Show the first rows only';
  });
}

/* ---------- data table ---------- */

function formulationCell(row, label) {
  return raw(`<a href="#/formulation?batch=${esc(row.batchId)}"><b>${esc(row.batchId)}</b></a>${label ? ` <span class="muted">${esc(label)}</span>` : ''}`);
}

function dataTable(exp, res, { qc, compLabel }, { fold = true } = {}) {
  const R = res.responses;
  const st = res.stats || {};
  // A comparison with one batch per arm is its own arm table: the difference from the first arm goes in the cell.
  const arms = new Map();
  if (st.kind === 'comparison') for (const a of st.arms) for (const id of a.batchIds) if (!arms.has(id)) arms.set(id, a);
  const armOf = (row) => arms.get(row.batchId) || null;
  const oneEach = st.kind === 'comparison' && st.arms.every((a) => a.batchIds.length === 1);
  const firstArm = st.kind === 'comparison' ? st.arms.find((a) => a.key === st.first) : null;
  const labelOf = (row) => (exp.type === 'comparison' && row.compositionId != null ? compLabel(row.compositionId) : row.label);
  const rows = res.rows.map((x) => ({ cells: [
    formulationCell(x, labelOf(x)),
    ...(res.type === 'ofat' ? [x.levelText ?? x.level ?? '–'] : []),
    ...R.map((r) => {
      const a = oneEach ? armOf(x) : null;
      const d = a && a !== firstArm ? a.diff[r.key] : null;
      return cell(r, x.cells[r.key], qc, d ? `<div class="res-sub">${esc(changeText(r, d))} vs #${esc(String(firstArm.compositionId ?? firstArm.batchIds[0]))}</div>` : '');
    }),
  ] }));
  const tail = [];
  if (st.kind === 'repeats') {
    const n = Math.max(0, ...Object.values(st.byResponse).map((g) => g.n));
    if (n >= 2) {
      tail.push({ attrs: 'class="res-total"', cells: [raw(`<b>Batch to batch</b> <span class="muted">${n} batches</span>`),
        ...R.map((r) => cell(r, st.byResponse[r.key] ? { ...st.byResponse[r.key], stage: '' } : null, null))] });
    }
  }
  const lead = res.type === 'ofat' ? ['Formulation', { label: st.factorName || 'Level', right: true }] : ['Formulation'];
  const headers = [...lead, ...R.map(head)];
  return fold ? foldedTable(headers, rows, tail) : table(headers, [...rows, ...tail]);
}

/** Arms made more than once get their own small table: n is batches, and the difference sits beside it. */
function armsTable(res, { compLabel }) {
  const st = res.stats;
  if (st?.kind !== 'comparison' || st.arms.every((a) => a.batchIds.length === 1)) return '';
  const first = st.arms.find((a) => a.key === st.first);
  return `<h3>Per arm</h3>${foldedTable(['Arm', { label: 'Batches', right: true }, ...res.responses.map(head)], st.arms.map((a) => ({ cells: [
    a.compositionId != null ? compLabel(a.compositionId) : a.label, a.batchIds.length,
    ...res.responses.map((r) => cell(r, a.byResponse[r.key] ? { ...a.byResponse[r.key], stage: '' } : null, null,
      a !== first && a.diff[r.key] ? `<div class="res-sub">${esc(changeText(r, a.diff[r.key]))} vs first</div>` : '')),
  ] })))}`;
}

/* ---------- the stability table ---------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "3 Nov", with the year only when it is not this year's: a table cell has room for a date, not a sentence. */
export function shortDate(iso, today = '') {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '–';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${today && today.slice(0, 4) !== m[1] ? ` ${m[1]}` : ''}`;
}

const TEST_SHORT = { dls: 'DLS', ee: 'EE', zeta: 'Zeta', content: 'RNA content', potency: 'Potency', ph: 'pH' };

/** What a day still waits for, as the measurement matrix said it: missing once overdue, due today, or the date. */
function dueMark(open, today) {
  const due = open.map((s) => s.dueDate).filter(Boolean).sort()[0];
  if (due && today && due < today) return chip('missing', 'warn');
  if (due && due === today) return chip('due today', 'info');
  return `<span class="muted">${esc(due ? shortDate(due, today) : 'due')}</span>`;
}

/**
 * One day of one formulation on one shelf. Two views of it share the cell, and the table's toggle shows one or
 * the other: compact, Z-ave / PDI (the means of the runs, the size a link to its measurement); in full, Z-ave
 * mean ± SD, PDI under it, the change from T0 in small type and any other test on a line of its own. A value
 * outside a QC limit is marked and shows in both, as does a test due today or missed; the cell's title carries
 * the full cell, so a hover reads it without the toggle. A day not measured yet shows what the measurement
 * matrix showed: missing, due today, or its due date.
 */
function dayCell(row, slots, { qc, today, R }) {
  const z = row?.cells.zave, p = row?.cells.pdi;
  const others = R.filter((r) => r.key !== 'zave' && r.key !== 'pdi' && row?.cells[r.key]);
  const open = slots.filter((s) => s.status === 'open');
  if (!z && !p && !others.length) {
    if (open.length) return raw(dueMark(open, today));
    return raw(`<span class="muted">${slots.length ? 'done' : '–'}</span>`);
  }
  const qcAttr = (bad) => (bad ? ' qc-out" title="outside the QC limit in Settings' : '');
  const more = (show) => (show ? '' : ' res-more');
  const parts = [], tip = [];
  const pOut = !!p && outsideQc('pdi', p.mean, qc);
  if (z) {
    const sd = z.sd != null ? ` ± ${fmt(z.sd, 1)}` : '';
    const span = `<span class="res-v${qcAttr(outsideQc('zave', z.mean, qc))}">${fmt(z.mean, 1)}${sd ? `<span class="res-more">${sd}</span>` : ''}</span>`;
    parts.push(z.measurementId ? `<a class="res-link" href="#/measurements?id=${esc(z.measurementId)}">${span}</a>` : span);
    // compact: the PDI after the size on the same line, as the Formulations table shows them
    if (p) parts.push(`<span class="res-less res-pdi${qcAttr(pOut)}"> / ${fmt(p.mean, 3)}</span>`);
    tip.push(`Z-ave ${fmt(z.mean, 1)}${sd} nm`);
  }
  if (p) { parts.push(`<div class="res-sub${more(!z)}${qcAttr(pOut)}">PDI ${fmt(p.mean, 3)}</div>`); tip.push(`PDI ${fmt(p.mean, 3)}`); }
  const ch = row.timepoint > 0 ? row.change?.zave : null;
  if (ch) { parts.push(`<div class="res-sub res-chg res-more">${esc(changeText(responseByKey.zave, ch))}</div>`); tip.push(`${changeText(responseByKey.zave, ch)} vs T0`); }
  for (const r of others) {
    const v = row.cells[r.key].mean, bad = outsideQc(r.key, v, qc);
    // with no size or PDI on the day, the other tests are all the compact cell has to show
    parts.push(`<div class="res-sub${more(bad || (!z && !p))}${qcAttr(bad)}">${esc(r.label)} ${fmt(v, r.dp)}${esc(unitOf(r))}</div>`);
    tip.push(`${r.label} ${fmt(v, r.dp)}${unitOf(r)}`);
  }
  // a day half done: the size is in, EE is not. Missed or due today is something to do, so the compact view keeps it.
  if (open.length) {
    const tests = [...new Set(open.map((s) => TEST_SHORT[s.test] || s.test))].join(', ');
    const due = open.map((s) => s.dueDate).filter(Boolean).sort()[0];
    parts.push(`<div class="res-sub${more(!!(due && today && due <= today))}">${esc(tests)} ${dueMark(open, today)}</div>`);
    tip.push(`${tests} ${due ? (today && due < today ? 'missing' : due === today ? 'due today' : `due ${shortDate(due, today)}`) : 'due'}`);
  }
  return raw(`<div class="res-cell" title="${esc(tip.join(' · '))}">${parts.join('')}</div>`);
}

/** The drift column: Z-ave per day with its interval and the projected day, PDI per day under it. */
function trendCell(tr) {
  const z = trendSummary('zave', tr?.zave), p = trendSummary('pdi', tr?.pdi);
  if (!z && !p) return raw('<span class="muted">needs a later day</span>');
  const warn = (t) => t?.projection && ['ahead', 'passed'].includes(t.projection.status);
  const parts = [];
  if (z) parts.push(`<span class="res-v">${esc(z.rate)}</span><div class="res-sub">${esc(z.ci)}</div>${z.projection ? `<div class="res-sub${warn(tr.zave) ? ' qc-out' : ''}">${esc(z.projection)}</div>` : ''}`);
  if (p) parts.push(`<div class="res-sub">PDI ${esc(p.rate)}${tr.pdi.ci ? ` · ${esc(p.ci.replace('95 % CI ', ''))}` : ''}</div>${warn(tr.pdi) ? `<div class="res-sub qc-out">${esc(p.projection)}</div>` : ''}`);
  return raw(parts.join(''));
}

/**
 * A stability study in one table, GraphPad's grouped layout: one row per formulation × storage condition,
 * the days across. It is the data table and the measurement plan at once (a day still to come shows when it
 * is due), so it replaces both the row-per-day table and the measurement matrix that said the same thing.
 */
function stabilityTable(exp, res, { qc, today = '' }) {
  const R = res.responses;
  // A cell finds its row, its expected slots and its trend by key, not by a search of the study for each cell.
  const shelf = (batchId, condition) => `${batchId}\u0001${condition}`;
  const groups = [], byShelf = new Map();
  for (const row of res.rows) {
    const k = shelf(row.batchId, row.condition);
    let g = byShelf.get(k);
    if (!g) { groups.push(g = { batchId: row.batchId, label: row.label, compositionId: row.compositionId, condition: row.condition, byDay: new Map() }); byShelf.set(k, g); }
    g.byDay.set(row.timepoint, row);
  }
  const days = [...new Set(res.rows.map((r) => r.timepoint))].sort((a, b) => a - b);
  const slots = exp.expected || [];
  const slotsByDay = groupBy(slots, (s) => `${shelf(s.batchId, s.condition)}\u0001${Number(s.timepoint)}`);
  const slotsAt = (g, t) => slotsByDay.get(`${shelf(g.batchId, g.condition)}\u0001${t}`) || [];
  const trends = new Map((res.stats?.series || []).map((s) => [shelf(s.batchId, s.condition), s]));
  const rows = groups.map((g) => ({ cells: [
    // the recipe by number only: the row is read across, and a long name would take the width the days need
    formulationCell(g, g.compositionId != null ? `#${g.compositionId}` : g.label),
    condName(g.condition),
    ...days.map((t) => dayCell(g.byDay.get(t), slotsAt(g, t), { qc, today, R })),
    trendCell(trends.get(shelf(g.batchId, g.condition))?.trend),
  ] }));
  const headers = ['Formulation', 'Condition', ...days.map((t) => ({ label: `T${t}`, right: true })),
    { label: 'Trend', sub: 'least squares, per day' }];
  // The names for the instrument, from the next day anything is due; the copy button is wired by the screen.
  const next = slots.filter((s) => s.status === 'open').sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];
  const names = next
    ? `<p class="muted res-names">Sample names for the instrument: <code>${esc(next.sampleName)}</code> …
        <button id="copyNames" title="Copy the sample names due on ${esc(shortDate(next.dueDate, today))}, one per line">Copy names for next due date</button></p>`
    : '';
  // Compact until asked: Z-ave / PDI per day, the trend column hidden (the sentences above say the same thing).
  // The full view is the table as it always was, one click away, and stays chosen through the page's redraws.
  const key = `${exp.id}:values`, full = !!res.measuredRows && foldOpen(key);
  const note = res.measuredRows
    ? `<span class="res-less">Each cell: Z-ave (nm) / PDI; a value opens its measurement.</span>
       <span class="res-more">Each cell: Z-ave mean ± SD (nm) of the repeat runs, PDI underneath, and the change in Z-ave vs T0 in small type; a value opens its measurement.</span>`
    : 'Each cell is a day in storage and says when it is due; the values fill in as they are measured.';
  const toggle = res.measuredRows
    ? `<button type="button" class="ghost res-view" data-resview="${esc(key)}" aria-pressed="${full}" aria-controls="stabTable">${full ? VIEW_LESS : VIEW_MORE}</button>`
    : '';
  return `<div class="res-stab${full ? ' res-full' : ''}"><div class="res-tablehead"><h3>${res.measuredRows ? 'Data table' : 'Plan'}</h3>${toggle}</div>
    <p class="muted res-note">${note}</p>
    <div id="stabTable">${foldedTable(headers, rows)}</div>${names}</div>`;
}

/* ---------- the card ---------- */

/** A section shown as one line that says what it holds until it is opened; `key` keeps it as the user left it. */
function fold(key, cls, title, say, body) {
  return `<details class="fold sub ${cls}" data-resfold="${esc(key)}" ${foldOpen(key) ? 'open' : ''}>
    <summary><h2>${esc(title)}</h2><span class="fold-say">${esc(say)}</span></summary>${body}</details>`;
}

/**
 * A stability study's figures: size over time open, because that is the drift the sentences above are about,
 * and the others (PDI, EE …) folded under a line that says what they show, so the table is not three charts
 * further down. The fold opens to the same charts the report prints.
 */
function stabilityFigs(exp, res, ctx, g) {
  const lead = g.figs.find((f) => f.key === 'zave') || g.figs[0];
  const rest = g.figs.filter((f) => f !== lead);
  const names = andList(rest.map((f) => responseByKey[f.key]?.label || f.title));
  // What a point is goes with the folded figures; on the open one its tooltip says it.
  return `${legend(g.legend)}<div class="figs res-figs res-lead" title="${esc(g.note)}">${figure(lead.svg, lead)}</div>
    ${fold(`${exp.id}:figs`, 'res-figfold', `${names} over time`, stabilityFigureLine(res, rest.map((f) => f.key), ctx.qc),
    `<div class="figs res-figs wide">${rest.map((f) => figure(f.svg, f)).join('')}</div><p class="muted res-note">${esc(g.note)}</p>`)}`;
}

/** What this experiment is waiting for, said as an instruction rather than as an empty table. `after`: the stability plan. */
function emptyState(exp, after = '') {
  const open = (exp.expected || []).filter((s) => s.status === 'open');
  const tests = [...new Set(open.map((s) => s.test))].map((t) => TESTS.find((x) => x.id === t)?.name || t);
  const first = open.slice().sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];
  const where = exp.type === 'stability'
    ? 'on day 0 (T0) of each formulation and storage condition first'
    : 'on the final product of each formulation';
  const what = tests.length ? `Measure ${andList(tests)} ${where}` : 'Enter or import the results for these formulations';
  return `<div class="card" id="resultsCard"><h2>Results</h2>
    <p>Nothing measured yet. ${esc(what)}${first ? ` — name the samples on the instrument as the app expects them, <code>${esc(first.sampleName)}</code> …, and the export matches by itself` : ''}.
    The data table, the statistics and the graphs appear here with the first result.</p>
    <a class="btn" href="#/measurements?waiting=${esc(exp.id)}">What to measure</a>${after}</div>`;
}

/**
 * The Results card. `ctx`: {qc, compLabel(id), today}. The export button (#exportResults), the "Results so
 * far" buttons and #copyNames are wired by the experiment screen, which owns the download and the clipboard;
 * the "Show all" buttons by wireResults().
 */
export function resultsCard(exp, res, ctx) {
  const stab = res.type === 'stability';
  if (!res.measuredRows) return emptyState(exp, stab ? stabilityTable(exp, res, ctx) : '');
  const counted = stab
    ? `${res.measuredRows} of ${res.totalRows} samples × days measured`
    : `${res.measuredRows} of ${res.totalRows} formulation${res.totalRows === 1 ? '' : 's'} measured`;
  const headRow = `<div class="res-head"><h2>Results</h2><span class="muted">${esc(counted)}</span>
    <button id="exportResults" title="The data table below as CSV: mean, SD, n and CV % per response">Export results (CSV)</button></div>`;
  // A stability study's caveat is how its slopes are worked out: method, folded under the one thing in it a
  // reader has to keep in mind. Any other caveat (what an SD of one batch is not) is read with the numbers.
  const caveat = !res.caveat ? ''
    : stab ? fold(`${exp.id}:method`, 'res-method', 'How the slopes are worked out', 'a projected day assumes the drift stays linear', `<p class="muted res-caveat">${esc(res.caveat)}</p>`)
      : `<p class="muted res-caveat">${esc(res.caveat)}</p>`;
  const stats = `<ul class="res-stats">${res.sentences.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>${caveat}`;

  if (res.type === 'doe') {
    // A designed experiment is read through its model rather than run by run, and that screen already has it.
    return `<div class="card" id="resultsCard">${headRow}${stats}
      <a class="btn primary" href="#/doe?id=${esc(exp.id)}">Design &amp; results</a>
      <details style="margin-top:10px"><summary class="muted" style="cursor:pointer">Data table (${res.rows.length} runs)</summary>${dataTable(exp, res, ctx, { fold: false })}</details></div>`;
  }
  const g = resultFigures(exp, res, ctx);
  const figs = !g.figs.length ? ''
    : stab && g.figs.length > 1 ? stabilityFigs(exp, res, ctx, g)
      : `${g.legend ? legend(g.legend) : ''}<div class="figs res-figs${g.wide ? ' wide' : ''}">${g.figs.map((f) => figure(f.svg, f)).join('')}</div><p class="muted res-note">${esc(g.note)}</p>`;
  return `<div class="card" id="resultsCard">${headRow}${stats}
    ${figs}
    ${armsTable(res, ctx)}
    ${stab ? stabilityTable(exp, res, ctx) : `<h3>Data table</h3>${dataTable(exp, res, ctx)}`}</div>`;
}
