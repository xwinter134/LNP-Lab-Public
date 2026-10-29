// Screen: Insights — what it found (calc/insights.js), then an explorer that puts any response against any
// parameter the records carry (the process, the recipe, every lot, who and when, anything else on a record and
// the lab's own custom parameters), a group-by-group comparison with its test, a correlation map, the control
// chart over time with process capability against the QC limits, the custom parameters themselves, and the
// flat export.
//
// The explorer chooses the chart from what was picked, never asks for one: a number on X is a scatter with its
// trend line, a category is a strip of points per group with mean ± SD, a date is a time series. The user
// says what they want to look at, the screen decides how to draw it.
import { raw, fmt, field, table, chip, header, fmtDate, download, kpi, todayISO, addDays, esc, toast, ask } from './kit.js';
import { getRef, getSettings } from '../refdata.js';
import { mean, sd, pearson, controlLimits } from '../calc/stats.js';
import { FACTORS } from '../calc/experiment.js';
import { insightSummary, batchSetting, settingKey, repeatedSettings, RESPONSE_PARAMS, KNOWN_PARAMS, discoverFields, getPath, weekdayOf, dayNumber,
  chartKind, trend, groupCompare, correlationMatrix, qcLimits, capability } from '../calc/insights.js';
import { measurementIndex, byId, batchResults, groupBy, pageOf } from '../calc/indexes.js';
import { responsesForBatch } from '../calc/doe.js';
import { processOf } from '../calc/process.js';
import { PAGE_ROWS, moreLine, focusFirstNew } from './pager.js';
import { wireFigures, SERIES } from './charts.js';
import { customDefs, saveCustomDefs, newCustomId, customField, customInput, setCustom } from './customparams.js';

const RESPONSES = { zave_nm: { test: 'dls', label: 'Z-average (nm)' }, pdi: { test: 'dls', label: 'PDI' }, ee_pct: { test: 'ee', label: 'EE (%)' }, zeta_mV: { test: 'zeta', label: 'Zeta (mV)' } };
const CLASSES = ['ionizable', 'helper', 'sterol', 'peg'];

/**
 * Which folds of this screen the user has opened or closed (the correlations, the list of formulations). Every
 * filter redraws the screen from the address, so the choice is kept for the session in a module variable, as
 * on Design & results. Only a click is recorded, never the default.
 */
const folds = new Map();

/**
 * One row per formulation: its settings, its materials, who and when, and its latest results, for Insights,
 * its CSV export and the DoE screen. The measurements are indexed once and each row looks its results up
 * (app/calc/indexes.js): a filter over every measurement for every formulation took seconds once a lab had a
 * year of them.
 *
 * Besides the fields every record has, a row carries every other plain field found on the records
 * (discoverFields: `x.plan.rna.cargo`, `x.freezeThaw` …) and the lab's custom parameters (`cp_<id>`), so a
 * field added anywhere in the app is something Insights can plot without being told about it.
 */
export function flatRows(ctx) {
  const ref = getRef(ctx);
  const all = ctx.store.all('measurements');
  const results = measurementIndex(all);
  const exps = byId(ctx.store.all('experiments'));
  const stocks = byId(ctx.store.all('stocks'));
  const batches = ctx.store.all('batches');
  const rnaLots = byId(ref.rnaLots || []);
  const extra = discoverFields(batches, { factorNames: FACTORS.flatMap((f) => [f.key, f.doeName]) });
  const customs = customDefs(ctx.store);
  // A recipe's share of a lipid class is the same for every formulation made from it: worked out once per
  // composition, not once per row.
  const shares = new Map();
  const shareOf = (comp, cls) => {
    const k = `${comp.id}|${cls}`;
    if (!shares.has(k)) shares.set(k, Object.entries(comp.mol_pct).filter(([key]) => ref.lipidByKey[key]?.class === cls).reduce((s, [, v]) => s + v, 0));
    return shares.get(k);
  };
  // A stock's lots by lipid class, once per stock: "which ionizable lot went into this" is a question about the
  // stock the formulation was made from.
  const lotsOf = new Map();
  const stockLots = (s) => {
    if (!s) return null;
    if (!lotsOf.has(s.id)) {
      const by = {};
      for (const row of s.rows || []) {
        if (!row?.lot) continue;
        const cls = ref.lipidByKey[row.key]?.class || 'other';
        by[cls] = by[cls] ? `${by[cls]} + ${row.lot}` : String(row.lot);
      }
      const allLots = (s.rows || []).filter((x) => x?.lot).map((x) => `${x.key} ${x.lot}`).join(' · ');
      lotsOf.set(s.id, { by, all: allLots || null });
    }
    return lotsOf.get(s.id);
  };
  return batches.map((b) => {
    const comp = ref.compositionById[b.compositionId];
    const pct = (cls) => (comp ? shareOf(comp, cls) : null);
    const ov = b.plan?.compositionOverride || {};
    // a design or the optimizer may have moved a class away from the registry recipe
    const classPct = (cls) => (Number.isFinite(ov[`${cls}_pct`]) ? ov[`${cls}_pct`] : Number.isFinite(ov[cls]) ? ov[cls] : pct(cls));
    const { dls: d, ee: e, zeta: z } = batchResults(results, b.id);
    const stock = b.stockId ? stocks.get(b.stockId) : null;
    const lots = stockLots(stock);
    const proc = processOf(b.plan, ref);
    const derived = responsesForBatch(results.forBatch(b.id), b.id).values;
    const rnaLot = b.plan?.rna?.lotId ? rnaLots.get(b.plan.rna.lotId) : null;
    const row = { batchId: b.id, experimentId: b.experimentId, experimentType: exps.get(b.experimentId)?.type || '', label: b.label, compositionId: b.compositionId, synonym: comp?.synonym || '', date: d?.date || b.plannedDate, plannedDate: b.plannedDate, status: b.status,
      stockId: b.stockId || '', operator: d?.operator || '', np: b.plan?.rna?.np ?? null, frr: b.plan?.mixing?.frr ?? null, tfr: b.plan?.mixing?.totalFlow ?? null, quench: b.plan?.mixing?.quenchFactor ?? null,
      lipid_mM: b.plan?.mixing?.lipidStock_mM ?? stock?.molarity_mM ?? null, rna_mg_mL: b.plan?.rna?.working_mg_mL ?? null, peg_pct: classPct('peg'), ionizable_pct: classPct('ionizable'),
      helper_pct: classPct('helper'), sterol_pct: classPct('sterol'),
      rna_mass_mg: b.plan?.rna?.mass_mg ?? null, volume_mL: b.plan?.mode === 'quick' ? b.plan?.volume_mL ?? null : null,
      aq_pH: proc?.aqueous?.pH ?? null, aq_ionic: proc?.aqueous?.ionicStrength_mM ?? null, aqBuffer: proc?.aqueous?.buffer || '',
      deviceId: proc?.deviceId || '', mixerId: proc?.mixerId || '',
      rnaLot: b.plan?.rna?.lotId ? (rnaLot ? `${rnaLot.id}${rnaLot.construct ? ` (${rnaLot.construct})` : ''}` : b.plan.rna.lotId) : '',
      ...Object.fromEntries(CLASSES.map((cls) => [`lot_${cls}`, lots?.by[cls] || ''])), lipidLots: lots?.all || '',
      weekday: weekdayOf(b.plannedDate) || '',
      ...Object.fromEntries(Object.entries(b.plan?.factors || {}).map(([k, v]) => ['factor_' + k, v])),
      zave_nm: d?.values?.zave_nm ?? null, pdi: d?.values?.pdi ?? null, ee_pct: e?.values?.ee_pct ?? null, zeta_mV: z?.values?.zeta_mV ?? null, dlsId: d?.id || null,
      rna_content: derived.rna_content_mg_mL ?? null, size_drift: derived.size_drift ?? null,
      // what the record says was set, so batches made the same way can be compared with each other only
      setting: batchSetting(b, exps.get(b.experimentId), { dls: d, ee: e, zeta: z }) };
    for (const f of extra) { const v = getPath(b, f.path); row[f.key] = v == null || v === '' ? (f.kind === 'numeric' ? null : '') : typeof v === 'boolean' ? (v ? 'yes' : 'no') : v; }
    for (const c of customs) { const v = b.custom?.[c.id]; row[customField(c)] = v == null || v === '' ? (c.kind === 'numeric' ? null : '') : v; }
    return row;
  });
}

/**
 * Every parameter and response the explorer can offer, from what the rows actually hold: a known parameter
 * nobody has recorded is not offered (an empty "RNA lot" choice is a dead end), the discovered fields and the
 * custom parameters are added, and each is marked with how many formulations carry it.
 */
export function explorerParams(rows, ctx) {
  const customs = customDefs(ctx.store).map((c) => ({ key: customField(c), label: c.name, unit: c.unit || '', kind: c.kind === 'numeric' ? 'numeric' : 'category', custom: true }));
  const extra = discoverFields(ctx.store.all('batches'), { factorNames: FACTORS.flatMap((f) => [f.key, f.doeName]) });
  const has = (p) => rows.filter((r) => (p.kind === 'numeric' ? Number.isFinite(Number(r[p.key])) && r[p.key] != null && r[p.key] !== '' : r[p.key] != null && r[p.key] !== '')).length;
  const tag = (p, role) => ({ ...p, role: role || p.role || 'parameter', n: has(p) });
  return {
    responses: RESPONSE_PARAMS.map((p) => tag(p, 'response')),
    params: [...KNOWN_PARAMS, ...extra.map((f) => ({ key: f.key, label: f.label, unit: '', kind: f.kind, found: true }))].map((p) => tag(p)),
    customs: customs.map((p) => tag(p)),
  };
}

/** A category value as the screen writes it: "#3 MC3 standard" for a composition, the value otherwise. */
function catText(key, v, ref) {
  if (v == null || v === '') return '–';
  if (key === 'compositionId') { const c = ref.compositionById[v]; return `#${v}${c?.synonym ? ` ${c.synonym}` : ''}`; }
  return String(v);
}
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** A short, stable name for a setting in the address: the setting itself can run to a hundred characters. */
const tag = (key) => { let h = 5381; for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0; return h.toString(36); };

/* ---------------- the explorer's charts ---------------- */

// The app's series colours (index.html --s1 … --s8), set per theme and told apart without colour vision.
const PALETTE = SERIES;
/** Round axis numbers (the calc module's, which charts on this screen share). */
function ticks(lo, hi, n = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) { const d = Math.abs(lo) * 0.1 || 1; lo -= d; hi += d; }
  const raw = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(10)));
  if (out[out.length - 1] < hi) out.push(Number((out[out.length - 1] + step).toPrecision(10)));
  return out;
}
const tickText = (v) => (Math.abs(v) >= 1000 ? String(Math.round(v)) : String(Number(v.toPrecision(4))).replace('-', '−'));
const dateText = (day) => new Date(day * 86400000).toISOString().slice(0, 10);
/** A deterministic spread of points across a strip, so the picture is the same on every redraw. */
const jitter = (i) => (((i * 0.6180339887) % 1) - 0.5) * 0.5;

/**
 * Y against X, drawn as the kind of X decides (calc/insights.js chartKind). `colour(r)` gives each point's
 * group and colour; the strip view takes its groups from X itself.
 */
function exploreSvg(rows, { x, y, kind, colourOf, groupsOf, xText, yLabel, xLabel, line }) {
  const W = 860, H = 340, L = 60, R = 18, T = 16, B = 52;
  const ys = rows.map((r) => Number(r[y.key]));
  const yt = ticks(Math.min(...ys), Math.max(...ys));
  const y0 = yt[0], y1 = yt[yt.length - 1];
  const sy = (v) => T + (1 - (v - y0) / ((y1 - y0) || 1)) * (H - T - B);
  const grid = yt.map((v) => `<line x1="${L}" x2="${W - R}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}" class="ax" opacity=".4"/><text x="${L - 6}" y="${(sy(v) + 4).toFixed(1)}" class="lb" text-anchor="end">${tickText(v)}</text>`).join('');
  const frame = `<line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="ax"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="ax"/>
    <text x="${(L + W - R) / 2}" y="${H - 8}" class="lb" text-anchor="middle" font-weight="600">${esc(xLabel)}</text>
    <text x="14" y="${(T + H - B) / 2}" class="lb" text-anchor="middle" font-weight="600" transform="rotate(-90 14 ${(T + H - B) / 2})">${esc(yLabel)}</text>`;
  const tip = (r) => `${r.batchId} · ${xText(r)} · ${fmt(Number(r[y.key]), y.key === 'pdi' ? 3 : 2)}`;
  const dot = (cx, cy, r) => `<a href="#/formulation?batch=${esc(r.batchId)}"><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4.5" fill="${colourOf(r)}" stroke="var(--card)" stroke-width="1.5" opacity=".9"><title>${esc(tip(r))}</title></circle></a>`;
  let body = '';
  if (kind === 'strip') {
    const groups = groupsOf;
    const bw = (W - L - R) / groups.length;
    const sx = (i) => L + bw * (i + 0.5);
    groups.forEach((g, i) => {
      const pts = rows.filter((r) => r.__g === g.g);
      body += pts.map((r, k) => dot(sx(i) + jitter(k) * Math.min(bw, 70), sy(Number(r[y.key])), r)).join('');
      if (g.mean != null) {
        const half = Math.min(bw * 0.32, 26);
        body += `<line x1="${(sx(i) - half).toFixed(1)}" x2="${(sx(i) + half).toFixed(1)}" y1="${sy(g.mean).toFixed(1)}" y2="${sy(g.mean).toFixed(1)}" stroke="var(--ink)" stroke-width="2.4"><title>${esc(g.label)}: mean ${fmt(g.mean, 3)}${g.sd != null ? ` ± ${fmt(g.sd, 3)} SD` : ''}, n ${g.n}</title></line>`;
        if (g.sd != null) body += `<line x1="${sx(i).toFixed(1)}" x2="${sx(i).toFixed(1)}" y1="${sy(g.mean - g.sd).toFixed(1)}" y2="${sy(g.mean + g.sd).toFixed(1)}" stroke="var(--ink)" stroke-width="1.3"/>`
          + [g.mean - g.sd, g.mean + g.sd].map((v) => `<line x1="${(sx(i) - 6).toFixed(1)}" x2="${(sx(i) + 6).toFixed(1)}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}" stroke="var(--ink)" stroke-width="1.3"/>`).join('');
      }
      const lab = g.label.length > 16 ? g.label.slice(0, 15) + '…' : g.label;
      body += `<text x="${sx(i).toFixed(1)}" y="${H - B + 15}" class="lb" text-anchor="middle"${groups.length > 8 ? ` transform="rotate(-25 ${sx(i).toFixed(1)} ${H - B + 15})"` : ''}>${esc(lab)}</text>`;
    });
  } else {
    const xs = rows.map((r) => Number(kind === 'time' ? r.__day : r[x.key]));
    const xt = ticks(Math.min(...xs), Math.max(...xs), kind === 'time' ? 5 : 6);
    const x0 = xt[0], x1 = xt[xt.length - 1];
    const sx = (v) => L + ((v - x0) / ((x1 - x0) || 1)) * (W - L - R);
    body += xt.map((v) => `<text x="${sx(v).toFixed(1)}" y="${H - B + 16}" class="lb" text-anchor="middle">${kind === 'time' ? fmtDate(dateText(v)) : tickText(v)}</text>`).join('');
    if (kind === 'time') {
      // one line per colour group, in time order, so a lot's run of batches reads as its own series
      const by = groupBy(rows.slice().sort((a, b) => a.__day - b.__day), (r) => colourOf(r));
      for (const [col, rs] of by) if (rs.length > 1) body += `<polyline points="${rs.map((r) => `${sx(r.__day).toFixed(1)},${sy(Number(r[y.key])).toFixed(1)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="1.2" opacity=".45"/>`;
    }
    if (line) body += `<line x1="${sx(line.xMin).toFixed(1)}" x2="${sx(line.xMax).toFixed(1)}" y1="${sy(line.intercept + line.slope * line.xMin).toFixed(1)}" y2="${sy(line.intercept + line.slope * line.xMax).toFixed(1)}" stroke="var(--ink2)" stroke-width="1.6" stroke-dasharray="6 4"><title>least-squares line</title></line>`;
    body += rows.map((r) => dot(sx(Number(kind === 'time' ? r.__day : r[x.key])), sy(Number(r[y.key])), r)).join('');
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)} against ${esc(xLabel)}" style="width:100%;height:auto;display:block">${grid}${frame}${body}</svg>`;
}

const pText = (p) => (p == null ? '–' : p < 0.001 ? '< 0.001' : p < 0.1 ? p.toFixed(3) : p.toFixed(2));
const withUnit = (p) => `${p.label}${p.unit ? ` (${p.unit})` : ''}`;
/** A selection list in groups, so forty choices read as four short lists. */
function selectGroups(name, value, groups, { none = null } = {}) {
  return `<select name="${name}" id="${name}">${none ? `<option value="">${esc(none)}</option>` : ''}${groups.filter(([, ps]) => ps.length).map(([label, ps]) =>
    `<optgroup label="${esc(label)}">${ps.map((p) => `<option value="${esc(p.key)}" ${p.key === value ? 'selected' : ''}${p.n ? '' : ' disabled'}>${esc(withUnit(p))}${p.n ? '' : ' · nothing recorded'}</option>`).join('')}</optgroup>`).join('')}</select>`;
}

export async function render(el, ctx) {
  const settings = getSettings(ctx);
  const ref = getRef(ctx);
  const rowsAll = flatRows(ctx);
  const comps = [...new Set(rowsAll.map((r) => r.compositionId))].sort((a, b) => a - b);
  const p = ctx.params;
  const resp = RESPONSES[p.response] ? p.response : 'zave_nm';
  const colorBy = p.colorBy || 'stockId';
  const compFilter = p.comp ? Number(p.comp) : '';
  const months = p.period ? Number(p.period) : 0;
  const since = months ? addDays(todayISO(), -Math.round(months * 30.4)) : '';
  const inView = rowsAll.filter((r) => (!compFilter || r.compositionId === compFilter) && (!since || (r.date || '') >= since));
  const rows = inView.filter((r) => r[resp] != null).sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // The control chart shows the batches of one setting: the one the reference experiments repeat, else the
  // most-run, unless the user picks another or every batch. Designed experiments change the settings on purpose:
  // on one chart with them, the limits are the design's spread, and the points "outside" are its corners, not bad
  // batches (usability cycle 6, I1).
  const repeated = repeatedSettings(rows, resp);
  const wantAll = p.chart === 'all';
  const picked = wantAll ? null : repeated.find((x) => tag(x.key) === p.chart) || repeated[0] || null;
  const chartRows = picked ? picked.rows : rows;
  const chartSel = picked ? tag(picked.key) : 'all';
  const groups = [...new Set(chartRows.map((r) => r[colorBy] || '–'))];
  const palette = PALETTE;
  // Coloured by experiment, a year has hundreds of groups: a point finds its group in a map, not by a search.
  const groupNo = new Map(groups.map((g, i) => [g, i]));
  const colorOf = (g) => palette[(groupNo.get(g) ?? 0) % palette.length];
  const lim = controlLimits(chartRows.map((r) => r[resp]));

  // chart
  const W = 760, H = 260, L = 50, R = 20, T = 20, B = 40;
  const ys = chartRows.map((r) => r[resp]);
  const yMin = Math.min(...ys, lim.lcl ?? Infinity), yMax = Math.max(...ys, lim.ucl ?? -Infinity);
  const pad = (yMax - yMin) * 0.15 || 1;
  const y0 = yMin - pad, y1 = yMax + pad;
  const sx = (i) => L + (chartRows.length > 1 ? (i / (chartRows.length - 1)) * (W - L - R) : (W - L - R) / 2);
  const sy = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const chart = chartRows.length ? `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${RESPONSES[resp].label} per batch over time" style="width:100%;height:auto;display:block">
    <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="ax"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="ax"/>
    ${[y0, (y0 + y1) / 2, y1].map((v) => `<text x="${L - 6}" y="${sy(v) + 4}" class="lb" text-anchor="end">${fmt(v, resp === 'pdi' ? 2 : 0)}</text>`).join('')}
    ${lim.mean != null ? `<line x1="${L}" x2="${W - R}" y1="${sy(lim.mean)}" y2="${sy(lim.mean)}" class="mn" stroke-dasharray="2 4"/>` : ''}
    ${lim.ucl != null ? `<line x1="${L}" x2="${W - R}" y1="${sy(lim.ucl)}" y2="${sy(lim.ucl)}" class="lm" stroke-dasharray="4 4"/><line x1="${L}" x2="${W - R}" y1="${sy(lim.lcl)}" y2="${sy(lim.lcl)}" class="lm" stroke-dasharray="4 4"/>` : ''}
    ${chartRows.map((r, i) => `<a href="${r.dlsId ? '#/measurements?id=' + r.dlsId : '#/formulation?batch=' + r.batchId}"><circle cx="${sx(i)}" cy="${sy(r[resp])}" r="4.5" fill="${colorOf(r[colorBy] || '–')}" ${lim.ucl != null && (r[resp] > lim.ucl || r[resp] < lim.lcl) ? 'class="ol" stroke-width="2"' : ''}><title>${r.batchId} · ${fmtDate(r.date)} · ${fmt(r[resp], 2)}</title></circle></a>`).join('')}
    ${chartRows.length > 1 ? [0, Math.floor((chartRows.length - 1) / 2), chartRows.length - 1].map((i) => `<text x="${sx(i)}" y="${H - B + 16}" class="lb" text-anchor="middle">${fmtDate(chartRows[i].date)}</text>`).join('') : ''}
  </svg>` : '<p class="muted">No results yet for this selection.</p>';
  // What the chart holds, said under it: which setting, and what was left off and why.
  const left = rows.length - chartRows.length;
  const limitsSay = `Limits mean ± 2 sd from the first ${lim.n} points: ${lim.mean != null ? `${fmt(lim.mean, 2)} (${fmt(lim.lcl, 2)} – ${fmt(lim.ucl, 2)})` : '–'}. Points outside are outlined.`;
  const which = picked !== repeated[0] ? 'one setting' : picked.reference ? 'the setting of the reference experiments' : 'the most-run setting';
  const chartSay = !rows.length ? 'No batches in this view.' : picked
    ? `${chartRows.length} batches made at ${which}: ${picked.key}.${left ? ` The other ${left} in view were made at other settings and are left off, so the limits are the scatter between batches made the same way.` : ''} ${limitsSay}`
    : `${repeated.length ? 'Every batch in view' : 'No setting in view was made twice, so every batch is shown'} (${chartRows.length}), whatever its settings. Designed experiments change the settings on purpose, so these limits are wider than batch-to-batch scatter, and a point outside them may be a corner of a design rather than a bad batch. ${limitsSay}`;
  const chartOpts = [...repeated.slice(0, 12).map((x) => ({ value: tag(x.key), label: `${x.key} (${x.n}${x.reference ? ', reference' : ''})` })), { value: 'all', label: `Every batch in view (${rows.length}), settings differ` }];

  // The table describes the chart: the same batches, so its means are comparable with each other.
  const valuesOf = groupBy(chartRows, (r) => r[colorBy] || '–');
  const groupStats = groups.map((g) => { const v = (valuesOf.get(g) || []).map((r) => r[resp]); return { g, n: v.length, mean: mean(v), sd: sd(v) }; });
  const overall = mean(chartRows.map((r) => r[resp]));
  const corr = [['np', 'N/P'], ['frr', 'FRR'], ['tfr', 'Total flow'], ['quench', 'Quench factor'], ['peg_pct', 'PEG mol%'], ['ionizable_pct', 'Ionizable mol%'], ['lipid_mM', 'Lipid stock mM'], ['rna_mg_mL', 'RNA working mg/mL']]
    .map(([k, l]) => ({ k, l, ...pearson(rows.map((r) => r[k]), rows.map((r) => r[resp])) })).filter((c) => c.r != null).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

  // The finding first: what the chart and the group table below say, for the same batches and grouping, so the
  // filters, the chart and the tables are where to check it rather than where to look for it.
  const summary = insightSummary(rows, { response: resp, colorBy, chart: chartRows, limits: lim });
  // The evidence that is not the finding folds to a line saying what it holds: the correlations to the ones
  // worth a look, the list of formulations to how many there are (the chart above already shows every one).
  const fold = (key, title, say, body, dflt = false) => `<details class="card fold" id="${key}Fold" data-fold="${key}"${(folds.get(key) ?? dflt) ? ' open' : ''}>
      <summary><h2>${title}</h2><span class="fold-say">${esc(say)}</span></summary>${body}</details>`;
  const strong = corr.filter((c) => Math.abs(c.r) >= 0.3).slice(0, 2);
  const corrSay = !corr.length ? 'needs at least 3 batches with varying factors'
    : strong.length ? `strongest: ${strong.map((c) => `${c.l} r ${fmt(c.r, 2)} (n ${c.n})`).join(' and ')}; direction only`
      : `no factor goes with it beyond r ±0.3 across these ${rows.length} batches`;
  const newestRow = rows[rows.length - 1];
  const rowsSay = newestRow ? `${rows.length} batch${rows.length === 1 ? '' : 'es'}, newest first (${newestRow.batchId}, ${fmtDate(newestRow.date)}), each with its stock, operator and settings` : 'nothing in this view';

  // Process capability of the batches on the control chart against the QC limits in Settings: the chart's
  // batches, because capability is a question about a process run the same way, not about a design's corners.
  const capLim = qcLimits(resp, settings.qc);
  const cap = capLim ? capability(chartRows.map((r) => r[resp]), capLim) : null;
  const capCard = `<div class="card" id="capCard"><h2>Process capability</h2>${!capLim
    ? `<p class="muted" style="margin:0">No QC limit for ${esc(RESPONSES[resp].label)} in <a href="#/settings">Settings</a>; capability is worked out against the size, PDI and EE limits there.</p>`
    : !cap ? `<p class="muted" style="margin:0">Needs three batches or more with some scatter on the chart (${chartRows.length} now).</p>`
      : `<div class="grid g2">${kpi('Cpk', fmt(cap.cpk, 2), cap.verdict)}${kpi('Mean ± SD', `${fmt(cap.mean, resp === 'pdi' ? 3 : 1)} ± ${fmt(cap.sd, resp === 'pdi' ? 3 : 1)}`, `n ${cap.n}${cap.cp != null ? `, Cp ${fmt(cap.cp, 2)}` : ''}`)}</div>
      <p class="muted small" style="margin:6px 0 0" id="capSay">The ${cap.n} batches on the chart against ${capLim.lsl != null ? `${capLim.lsl}` : ''}${capLim.lsl != null && capLim.usl != null ? '–' : ''}${capLim.usl != null ? `${capLim.lsl == null ? 'at most ' : ''}${capLim.usl}` : ''}${capLim.lsl != null && capLim.usl == null ? ' or more' : ''} (Settings): ${cap.verdict === 'capable' ? 'the scatter fits well inside the limits (Cpk ≥ 1.33)' : cap.verdict === 'marginal' ? 'inside the limits, with little room (Cpk 1 to 1.33)' : 'batches outside the limits are to be expected (Cpk below 1)'}${cap.outside ? `; ${cap.outside} already outside` : ''}. Cpk is the distance from the mean to the nearer limit in units of 3 SD${cap.n < 10 ? `; from ${cap.n} batches it is a rough figure, since the SD itself is uncertain` : ''}.</p>`}</div>`;

  /* ---------------- the explorer ---------------- */
  const catalogue = explorerParams(inView, ctx);
  const allParams = [...catalogue.responses, ...catalogue.params, ...catalogue.customs];
  const find = (k) => allParams.find((q) => q.key === k);
  const firstWith = (ps, kinds) => ps.find((q) => q.n >= 3 && kinds.includes(q.kind) && new Set(inView.map((r) => r[q.key]).filter((v) => v != null && v !== '')).size > 1);
  const yP = (find(p.y)?.role === 'response' && find(p.y)) || find(resp === 'zave_nm' ? 'zave_nm' : resp) || catalogue.responses[0];
  const xP = (p.x && find(p.x) && p.x !== yP.key && find(p.x)) || firstWith(catalogue.params.filter((q) => q.key !== 'date'), ['numeric']) || find('date');
  const gP = p.g && find(p.g)?.kind === 'category' && p.g !== xP.key ? find(p.g) : null;
  const kind = chartKind(xP);
  const xHas = (r) => (xP.kind === 'numeric' ? r[xP.key] != null && r[xP.key] !== '' && Number.isFinite(Number(r[xP.key])) : xP.kind === 'date' ? dayNumber(r.date) != null : r[xP.key] != null && r[xP.key] !== '');
  const exRows = inView.filter((r) => r[yP.key] != null && Number.isFinite(Number(r[yP.key])) && xHas(r))
    .map((r) => ({ ...r, __day: dayNumber(r.date) }));
  const label = (q, v) => catText(q.key, v, ref);
  // The groups a strip is drawn in: weekdays in week order, compositions by number, the rest as they come.
  const order = (key, vals) => (key === 'weekday' ? WEEK.filter((d) => vals.includes(d)) : key === 'compositionId' ? vals.slice().sort((a, b) => a - b) : vals.slice().sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })));
  const compareBy = kind === 'strip' ? xP : gP;
  const cmpOrder = compareBy ? order(compareBy.key, [...new Set(exRows.map((r) => r[compareBy.key]).filter((v) => v != null && v !== ''))]) : [];
  const cmp = compareBy ? groupCompare(exRows, yP.key, compareBy.key, { order: cmpOrder }) : null;
  // colours: by the colour choice, or for a strip by X itself; a group past the eighth shares a colour, said in the legend
  const colourKey = gP ? gP.key : kind === 'strip' ? xP.key : null;
  const colourVals = colourKey ? order(colourKey, [...new Set(exRows.map((r) => r[colourKey]).filter((v) => v != null && v !== ''))]) : [];
  const colourNo = new Map(colourVals.map((v, i) => [v, i]));
  const colourOf = (r) => (colourKey ? (colourNo.has(r[colourKey]) ? PALETTE[colourNo.get(r[colourKey]) % PALETTE.length] : '#8E8E93') : PALETTE[0]);
  let stripGroups = [];
  if (kind === 'strip') {
    const top = cmp.groups.slice().sort((a, b) => b.n - a.n).slice(0, 24).map((g) => g.g);
    stripGroups = cmp.groups.filter((g) => top.includes(g.g)).map((g) => ({ ...g, label: label(xP, g.g) }));
    exRows.forEach((r) => { r.__g = r[xP.key]; });
  }
  const line = kind === 'scatter' ? trend(exRows, xP.key, yP.key) : kind === 'time' ? trend(exRows, '__day', yP.key) : null;
  const yLabel = withUnit(yP), xLabel = kind === 'time' ? 'Date' : withUnit(xP);
  const xText = (r) => (kind === 'time' ? fmtDate(r.date) : kind === 'strip' ? label(xP, r[xP.key]) : `${xP.label} ${fmt(Number(r[xP.key]), 3)}`);
  const exChart = exRows.length >= 2 ? exploreSvg(exRows.filter((r) => kind !== 'strip' || stripGroups.some((g) => g.g === r.__g)), { x: xP, y: yP, kind, colourOf, groupsOf: stripGroups, xText, yLabel, xLabel, line })
    : `<p class="muted" id="exEmpty">${exRows.length ? 'Only one formulation' : 'No formulation'} in view has both ${esc(yP.label)} and ${esc(xP.label)}. ${xP.n ? '' : `Nothing records ${esc(xP.label)} yet.`}</p>`;
  const yUnit = yP.unit && yP.unit !== '%' ? ` ${yP.unit}` : yP.unit === '%' ? ' points' : '';
  const dp = yP.key === 'pdi' ? 3 : 2;
  const exSay = exRows.length < 3 ? ''
    : kind === 'scatter' ? (line ? (line.p != null && line.p < 0.05
      ? `Across ${line.n} formulations, ${yP.label} ${line.slope > 0 ? 'rises' : 'falls'} by ${fmt(Math.abs(line.slope), dp)}${yUnit} for each ${xP.unit ? `1 ${xP.unit}` : 'unit'} of ${xP.label} (r ${fmt(line.r, 2)}, p ${pText(line.p)}). An association across everything in view, not a cause: designed experiments change several settings at once.`
      : `No clear trend of ${yP.label} with ${xP.label} across ${line.n} formulations (r ${fmt(line.r, 2)}, p ${pText(line.p)}).`) : `${xP.label} does not vary across these formulations, so there is no trend to see.`)
      : kind === 'time' ? (line ? (line.p != null && line.p < 0.05
        ? `Over time, ${yP.label} ${line.slope > 0 ? 'rises' : 'falls'} by about ${fmt(Math.abs(line.slope) * 30, dp)}${yUnit} a month (${line.n} formulations, p ${pText(line.p)}). Worth checking what changed: a lot, a buffer, an instrument.`
        : `No clear drift of ${yP.label} over time (${line.n} formulations, p ${pText(line.p)}).`) : 'All on one day: no time course to see.')
        : (!cmp?.test ? `Too few formulations per ${xP.label.toLowerCase()} to test a difference: each group needs two, with some scatter.`
          : (() => {
            const hi = cmp.groups.filter((g) => g.diff != null).sort((a, b) => b.diff - a.diff)[0];
            const sig = cmp.test.p < 0.05;
            return `${sig ? `${yP.label} differs between the ${cmp.groups.length} ${xP.label.toLowerCase()} groups` : `No clear difference in ${yP.label} between the ${cmp.groups.length} ${xP.label.toLowerCase()} groups`} (${cmp.test.kind === 'welch' ? "Welch's t" : 'one-way ANOVA'}, p ${pText(cmp.test.p)}, n ${cmp.n})${sig && hi ? `; ${label(xP, hi.g)} is ${fmt(Math.abs(hi.diff), dp)}${yUnit} ${hi.diff > 0 ? 'above' : 'below'} the others` : ''}. Over every formulation in view, whatever its other settings.`;
          })());
  const legendHtml = colourKey && colourVals.length ? `<div class="fig-legend" id="exLegend">${colourVals.slice(0, 8).map((v, i) => `<span><i style="background:${PALETTE[i]}"></i>${esc(label(find(colourKey) || { key: colourKey }, v))}</span>`).join('')}${colourVals.length > 8 ? `<span><i style="background:#8E8E93"></i>${colourVals.length - 8} more</span>` : ''}</div>` : '';
  const cmpTable = !cmp ? `<p class="muted small" id="groupNote">Pick a category as X (a lot, an operator, a weekday) or colour by one to compare its groups here.</p>`
    : `<div id="groupTable"><h3 style="margin:12px 0 4px;font-size:13.5px">${esc(yP.label)} by ${esc(compareBy.label.toLowerCase())}</h3>${table(['Group', { label: 'n', right: true }, { label: 'Mean ± SD', right: true }, { label: 'vs the others', right: true }, { label: 'p', right: true }],
      cmp.groups.map((g) => ({ cells: [label(compareBy, g.g), g.n, raw(`${fmt(g.mean, dp)}${g.sd != null ? ` <span class="muted">± ${fmt(g.sd, dp)}</span>` : ''}`),
        g.diff == null ? '–' : `${g.diff > 0 ? '+' : g.diff < 0 ? '−' : ''}${fmt(Math.abs(g.diff), dp)}`, raw(g.p == null ? '<span class="muted">–</span>' : g.p < 0.05 ? `<b>${pText(g.p)}</b>` : pText(g.p))] })), { empty: 'No groups.' })}
      <p class="muted small" style="margin:4px 0 0">${cmp.test ? `Across the groups: ${cmp.test.kind === 'welch' ? `Welch's t, p ${pText(cmp.test.p)}` : `one-way ANOVA, F ${fmt(cmp.test.F, 2)} on ${cmp.test.df[0]} and ${cmp.test.df[1]} df, p ${pText(cmp.test.p)}`}. ` : ''}"vs the others" is each group's mean minus the mean of every other formulation, with Welch's t for that difference. These compare every formulation in view whatever its settings; the first sentence at the top compares lots and operators only at matched settings, which is the fairer test when designs are mixed in.</p></div>`;
  const pickGroups = (excludeKey) => [
    ['Results', catalogue.responses.filter((q) => q.key !== excludeKey)],
    ['Process and recipe', catalogue.params.filter((q) => q.kind !== 'category' && !q.found)],
    ['Materials, people and time', catalogue.params.filter((q) => q.kind === 'category' && !q.found)],
    ['Other fields on the records', catalogue.params.filter((q) => q.found)],
    ['Your custom parameters', catalogue.customs],
  ];
  const explorer = `<div class="card" id="explorer"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="flex:1">Explore</h2><span class="fig-dl"><button type="button" data-fig-dl="svg" title="Save this graph as SVG">SVG</button><button type="button" data-fig-dl="png" title="Save this graph as a PNG image">PNG</button></span></div>
    <p class="muted" style="margin:0 0 8px">Pick a result and anything it might depend on. The chart follows from what you pick: a number gives a scatter with its trend line, a lot or an operator one column of points per group with mean ± SD, a date the course over time.</p>
    <div class="exPick" id="exPick">
      <label>Result (Y)${selectGroups('ex_y', yP.key, [['Results', catalogue.responses]])}</label>
      <label>Against (X)${selectGroups('ex_x', xP.key, pickGroups(yP.key))}</label>
      <label>Colour by${selectGroups('ex_g', gP?.key || '', [['Materials, people and time', catalogue.params.filter((q) => q.kind === 'category' && !q.found && q.key !== xP.key)], ['Other fields on the records', catalogue.params.filter((q) => q.kind === 'category' && q.found && q.key !== xP.key)], ['Your custom parameters', catalogue.customs.filter((q) => q.kind === 'category' && q.key !== xP.key)]], { none: 'Nothing' })}</label>
    </div>
    <div class="fig" data-fig="insights-${esc(yP.key)}-${esc(xP.key)}" style="margin-top:10px">${legendHtml}${exChart}</div>
    ${exSay ? `<p class="exSay" id="exSay">${esc(exSay)}</p>` : ''}
    ${cmpTable}</div>`;

  /* ---------------- the correlation map ---------------- */
  const numParams = [...catalogue.params, ...catalogue.customs].filter((q) => q.kind === 'numeric' && q.n >= 3 && new Set(inView.map((r) => r[q.key]).filter((v) => v != null && v !== '')).size > 1);
  const respWith = catalogue.responses.filter((q) => q.n >= 3);
  const heat = correlationMatrix(inView, numParams.map((q) => q.key), respWith.map((q) => q.key));
  const cell = (x, y) => heat.find((c) => c.x === x && c.y === y);
  const heatColour = (r) => (r == null ? 'transparent' : r > 0 ? `rgba(42, 98, 208, ${(Math.abs(r) * 0.85).toFixed(2)})` : `rgba(217, 119, 46, ${(Math.abs(r) * 0.85).toFixed(2)})`);
  const strongest = heat.filter((c) => c.r != null).sort((a, b) => Math.abs(b.r) - Math.abs(a.r))[0];
  const heatSay = strongest ? `${numParams.length} parameters against ${respWith.length} results; strongest ${find(strongest.x)?.label} with ${find(strongest.y)?.label}, r ${fmt(strongest.r, 2)} (n ${strongest.n})` : 'needs three formulations or more with a parameter that varies';
  const heatBody = !strongest ? '<p class="muted">Needs three formulations or more where a parameter varies and a result is recorded.</p>'
    : `<p class="muted" style="margin-top:0">Pearson r of each parameter against each result, over the formulations in view: blue goes up together, orange goes opposite ways, pale is no straight-line relation. Click a cell to plot it. Direction only; a designed experiment says what causes what.</p>
    <div style="overflow-x:auto"><table class="heat" id="heatTable"><thead><tr><th></th>${respWith.map((q) => `<th class="rot">${esc(q.label)}</th>`).join('')}</tr></thead><tbody>
    ${numParams.map((q) => `<tr><th style="text-align:left;font-weight:500">${esc(withUnit(q))}</th>${respWith.map((rq) => { const c = cell(q.key, rq.key);
      return `<td class="hc" style="background:${heatColour(c?.r)};${c?.r != null && Math.abs(c.r) > 0.55 ? 'color:#fff;' : ''}${c?.r != null ? 'cursor:pointer' : ''}"${c?.r != null ? ` data-x="${esc(q.key)}" data-y="${esc(rq.key)}" title="r ${fmt(c.r, 2)}, n ${c.n}: click to plot"` : ' title="too few formulations with both"'}>${c?.r != null ? fmt(c.r, 2) : '<span class="muted">·</span>'}</td>`; }).join('')}</tr>`).join('')}
    </tbody></table></div>`;

  /* ---------------- custom parameters ---------------- */
  const defs = customDefs(ctx.store);
  const exps = ctx.store.all('experiments').filter((e) => (e.batchIds || []).length).sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
  const cpExp = exps.find((e) => e.id === p.cpExp) || exps[0] || null;
  const cpBatches = cpExp ? cpExp.batchIds.map((id) => ctx.store.get('batches', id)).filter(Boolean) : [];
  const valuesFor = (d) => [...new Set(ctx.store.all('batches').map((b) => b.custom?.[d.id]).filter((v) => v != null && v !== ''))].slice(0, 50);
  const defRows = defs.map((d) => `<div class="cpRow" data-def="${esc(d.id)}"><input type="text" class="cpDefName" value="${esc(d.name)}" style="width:200px" aria-label="name">
      <input type="text" class="cpDefUnit" value="${esc(d.unit || '')}" placeholder="unit" style="width:90px" aria-label="unit">
      <span class="muted">${d.kind === 'numeric' ? 'a number' : 'a category (text)'}</span>
      <button type="button" class="cpDefDel" style="padding:3px 9px;min-height:0">Remove</button></div>`).join('');
  const customBody = `<p class="muted" style="margin-top:0">Record anything the app has no field for: a lipid mix number, the room temperature, an extruder pass count, who weighed the cholesterol. Define it once here, then fill it in for a whole experiment below or on each formulation record. It appears under "Your custom parameters" in the explorer, to plot and compare like any other.</p>
    <div class="cpDefs" id="cpDefs">${defRows || '<p class="muted">None yet.</p>'}
      <div class="cpRow" id="cpAddRow"><input type="text" id="cpName" placeholder="New parameter, e.g. Lipid mix no." style="width:240px"><input type="text" id="cpUnit" placeholder="unit (optional)" style="width:110px">
        <select id="cpKind" style="width:auto"><option value="category">a category (text, e.g. a lot or mix number)</option><option value="numeric">a number</option></select>
        <button type="button" id="cpAdd" class="primary" style="padding:4px 12px;min-height:0">Add parameter</button></div></div>
    ${defs.length && cpExp ? `<h3 style="margin:14px 0 6px;font-size:13.5px">Fill in for one experiment</h3>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px"><select id="cpExp" style="width:auto">${exps.map((e) => `<option value="${esc(e.id)}" ${e.id === cpExp.id ? 'selected' : ''}>${esc(`${e.id} · ${e.name || ''}`)}</option>`).join('')}</select>
        <span class="muted small">Stored as you leave each box. Paste a column from a spreadsheet into the first box and it fills down.</span><span id="cpSaved" class="muted small" aria-live="polite"></span></div>
      ${defs.filter((d) => d.kind !== 'numeric').map((d) => `<datalist id="cpList_${esc(d.id)}">${valuesFor(d).map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`).join('')}
      <div style="overflow-x:auto"><table class="cpGrid" id="cpGrid"><thead><tr><th style="text-align:left">Formulation</th>${defs.map((d) => `<th style="text-align:left">${esc(d.name)}${d.unit ? ` <span class="muted">(${esc(d.unit)})</span>` : ''}</th>`).join('')}</tr></thead><tbody>
      ${cpBatches.map((b) => `<tr><td><a href="#/formulation?batch=${esc(b.id)}">${esc(b.id)}</a> <span class="muted">${esc(b.label || '')}</span></td>${defs.map((d) => `<td>${customInput(d, b.custom?.[d.id], `cpb|${b.id}|${d.id}`)}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>` : defs.length ? '<p class="muted">No experiment with formulations yet.</p>' : ''}`;
  const customSay = defs.length ? `${defs.length} defined: ${defs.map((d) => d.name).join(', ')}; filled in on ${ctx.store.all('batches').filter((b) => defs.some((d) => b.custom?.[d.id] != null && b.custom[d.id] !== '')).length} formulations` : 'none yet: add your own, such as a lipid mix number or a room temperature';

  const sel = (id, label, value, options) => field({ id, label, type: 'select', value, options });
  el.innerHTML = header('Evaluate', 'Insights', `<button id="exportCsv" title="Every formulation as one row: settings, materials, lots, custom parameters and results">Export CSV</button>`) +
    `<div class="card" id="insightSummary"><h2>What this shows</h2><ul class="drivers">${summary.sentences.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>
    <div class="card"><div class="grid g4" id="filters">
      ${sel('response', 'Response', resp, Object.entries(RESPONSES).map(([k, v]) => ({ value: k, label: v.label })))}
      ${sel('comp', 'Composition', compFilter, [{ value: '', label: 'All' }, ...comps.map((c) => ({ value: c, label: '#' + c }))])}
      ${sel('period', 'Period', months, [{ value: 0, label: 'All time' }, { value: 6, label: 'Last 6 months' }, { value: 12, label: 'Last 12 months' }, { value: 24, label: 'Last 24 months' }])}
      ${sel('colorBy', 'Color by', colorBy, [{ value: 'stockId', label: 'Lipid stock lot' }, { value: 'operator', label: 'Operator' }, { value: 'experimentId', label: 'Experiment' }, { value: 'compositionId', label: 'Composition' }, { value: 'experimentType', label: 'Experiment type' }])}
    </div></div>
    ${explorer}
    <div class="grid g2" style="grid-template-columns:2fr 1fr">
      <div class="card"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="flex:1">Control chart · ${RESPONSES[resp].label}</h2>${groups.map((g) => `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink2)"><span style="width:10px;height:10px;border-radius:50%;background:${colorOf(g)}"></span>${esc(g)}</span>`).join('')}</div>
        <div id="chartPick" style="max-width:520px">${sel('chart', 'On the chart', chartSel, chartOpts)}</div>
        ${chart}<p class="muted" id="chartNote">${esc(chartSay)}</p></div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="card"><h2>By ${colorBy === 'stockId' ? 'stock lot' : colorBy}</h2><p class="muted small" style="margin:0 0 6px">The ${chartRows.length} batches on the chart.</p>${table(['Group', { label: 'n', right: true }, { label: 'Mean', right: true }, { label: 'SD', right: true }, { label: 'Δ vs all', right: true }], groupStats.map((s) => ({ cells: [s.g, s.n, fmt(s.mean, 2), fmt(s.sd, 2), raw(s.mean != null && overall != null ? `<span class="${Math.abs(s.mean - overall) > (lim.sd || Infinity) ? 'chip warn' : ''}">${fmt(s.mean - overall, 2)}</span>` : '–')] })), { empty: 'No groups.' })}</div>
        ${capCard}
        ${fold('corr', `Correlation with ${RESPONSES[resp].label}`, corrSay, `${table(['Factor', { label: 'r', right: true }, { label: 'n', right: true }], corr.map((c) => ({ cells: [c.l, raw(`<div style="display:flex;align-items:center;gap:6px;justify-content:flex-end"><div style="height:8px;width:${Math.abs(c.r) * 80}px;background:${c.r > 0 ? 'var(--accent)' : 'var(--warn)'};border-radius:4px"></div>${fmt(c.r, 2)}</div>`), c.n] })), { empty: 'Needs at least 3 batches with varying factors.' })}
          <p class="muted">Pearson correlation across the filtered batches. Direction only; confirm with a designed experiment.</p>`)}
      </div>
    </div>
    ${fold('heat', 'Correlation map', heatSay, heatBody)}
    ${fold('custom', 'Custom parameters', customSay, customBody, p.custom === '1')}
    ${fold('rows', 'Formulations in this view', rowsSay, '<div id="insightRows"></div>')}`;

  // Newest first, a page at a time: the chart above already shows every batch, and a table of a year's
  // worth is seconds of layout for rows nobody scrolls to.
  const newest = rows.slice().reverse();
  const rowBox = el.querySelector('#insightRows');
  let limit = PAGE_ROWS;
  const drawRows = () => {
    const { shown } = pageOf(newest, limit);
    rowBox.innerHTML = table(['Formulation', 'Date', 'Composition', 'Stock', 'Operator', { label: RESPONSES[resp].label, right: true }, 'N/P', 'FRR', 'TFR'], shown.map((r) => ({ cells: [raw(`<a href="#/formulation?batch=${r.batchId}">${r.batchId}</a>`), fmtDate(r.date), `#${r.compositionId}`, r.stockId || '–', r.operator || '–', fmt(r[resp], 2), r.np != null ? fmt(r.np, 1) : '–', r.frr != null ? fmt(r.frr, 1) : '–', r.tfr != null ? fmt(r.tfr, 1) : '–'] })), { empty: 'Nothing to show.' })
      + moreLine({ id: 'insightMore', shown: shown.length, total: newest.length, noun: 'formulations' });
    rowBox.querySelector('#insightMore')?.addEventListener('click', () => {
      const from = limit;
      limit += PAGE_ROWS; drawRows();
      focusFirstNew(rowBox.querySelectorAll('tbody tr'), from);
    });
  };
  drawRows();

  wireFigures(el);
  // The click runs before the details toggles, so the state it is about to take is the opposite of now.
  el.querySelectorAll('details[data-fold] > summary').forEach((sm) => sm.addEventListener('click', () => folds.set(sm.parentElement.dataset.fold, !sm.parentElement.open)));
  // The chart's choice travels with the filters; a setting no longer in view falls back to the default one.
  // So do the explorer's three choices, so a picture can be bookmarked or sent.
  const go = (extra = {}) => {
    const g = (n) => el.querySelector(`[name=${n}]`)?.value ?? '';
    const next = { response: g('response'), comp: g('comp'), period: g('period'), colorBy: g('colorBy'), chart: g('chart'), y: g('ex_y'), x: g('ex_x'), g: g('ex_g'), ...(p.cpExp ? { cpExp: p.cpExp } : {}), ...extra };
    ctx.navigate('insights', Object.fromEntries(Object.entries(next).filter(([, v]) => v != null && v !== '')));
  };
  el.querySelector('#chartPick').addEventListener('change', () => go());
  el.querySelector('#filters').addEventListener('change', () => go());
  el.querySelector('#exPick').addEventListener('change', () => go());
  el.querySelectorAll('#heatTable td[data-x]').forEach((td) => td.addEventListener('click', () => go({ x: td.dataset.x, y: td.dataset.y, g: '' })));
  el.querySelector('#exportCsv').addEventListener('click', () => {
    // every column any row has (the fields found on records and the custom parameters vary by row), in a
    // stable order: the fixed ones first, then the rest as found; the custom ones under their names
    const cols = [];
    const seen = new Set();
    for (const r of rowsAll) for (const c of Object.keys(r)) if (!seen.has(c)) { seen.add(c); cols.push(c); }
    const names = Object.fromEntries(customDefs(ctx.store).map((d) => [customField(d), `custom: ${d.name}${d.unit ? ` (${d.unit})` : ''}`]));
    // the setting goes out as the words the chart uses, so batches made the same way can be found again in a sheet
    const cell = (r, c) => (c === 'setting' ? settingKey(r.setting) : r[c]);
    const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
    const csv = [cols.map((c) => q(names[c] || c)).join(','), ...rowsAll.map((r) => cols.map((c) => q(cell(r, c))).join(','))].join('\n');
    download('lnp-lab-batches.csv', csv, 'text/csv');
  });
  wireCustom(el, ctx, { go, cpExp, defs });
}

/** The custom parameters card: define, rename, remove, and fill in a whole experiment at once. */
function wireCustom(el, ctx, { go, cpExp, defs }) {
  const box = el.querySelector('#customFold');
  if (!box) return;
  const keepOpen = () => folds.set('custom', true);
  const redraw = () => { keepOpen(); render(el, ctx); };
  box.querySelector('#cpAdd')?.addEventListener('click', () => {
    const name = box.querySelector('#cpName').value.trim();
    if (!name) { toast('Give the parameter a name first', 'warn'); box.querySelector('#cpName').focus(); return; }
    if (defs.some((d) => d.name.toLowerCase() === name.toLowerCase())) { toast(`There is already a parameter called ${name}`, 'warn'); return; }
    const id = newCustomId(defs, ctx.store);
    saveCustomDefs(ctx.store, [...defs, { id, name, unit: box.querySelector('#cpUnit').value.trim(), kind: box.querySelector('#cpKind').value === 'numeric' ? 'numeric' : 'category' }]);
    toast(`${name} added: fill it in below or on each formulation`, 'ok');
    redraw();
  });
  box.querySelector('#cpName')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') box.querySelector('#cpAdd').click(); });
  box.querySelectorAll('[data-def]').forEach((row) => {
    const id = row.dataset.def;
    const save = () => {
      const name = row.querySelector('.cpDefName').value.trim();
      if (!name) { toast('A parameter needs a name; remove it instead', 'warn'); return; }
      saveCustomDefs(ctx.store, customDefs(ctx.store).map((d) => (d.id === id ? { ...d, name, unit: row.querySelector('.cpDefUnit').value.trim() } : d)));
    };
    row.querySelector('.cpDefName').addEventListener('change', save);
    row.querySelector('.cpDefUnit').addEventListener('change', save);
    row.querySelector('.cpDefDel').addEventListener('click', async () => {
      const d = defs.find((x) => x.id === id);
      const n = ctx.store.all('batches').filter((b) => b.custom?.[id] != null).length;
      if (n && !(await ask(`Remove ${d.name}? The ${n} value${n === 1 ? '' : 's'} entered stay on the records but are no longer shown or plotted.`))) return;
      saveCustomDefs(ctx.store, customDefs(ctx.store).filter((x) => x.id !== id));
      redraw();
    });
  });
  box.querySelector('#cpExp')?.addEventListener('change', (e) => { keepOpen(); go({ cpExp: e.target.value, custom: '1' }); });
  const grid = box.querySelector('#cpGrid');
  if (!grid) return;
  const said = box.querySelector('#cpSaved');
  const store1 = (input) => {
    const [, batchId, defId] = input.name.split('|');
    const def = defs.find((d) => d.id === defId), b = ctx.store.get('batches', batchId);
    if (!def || !b) return false;
    if (!setCustom(b, def, input.value)) { toast(`${def.name} takes a number; "${input.value}" is not one`, 'warn'); input.focus(); return false; }
    ctx.store.put('batches', b);
    return true;
  };
  grid.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.name?.startsWith('cpb|')) return;
    if (store1(t)) said.textContent = `Saved ${t.name.split('|')[1]}`;
  });
  // A column pasted from a spreadsheet fills down from the box it was pasted into, one value per row.
  grid.addEventListener('paste', (e) => {
    const t = e.target;
    if (!t.name?.startsWith('cpb|')) return;
    const text = e.clipboardData?.getData('text') || '';
    const lines = text.replace(/\r/g, '').split('\n');
    if (lines.length < 2) return;
    e.preventDefault();
    const col = t.name.split('|')[2];
    const inputs = [...grid.querySelectorAll('input')].filter((x) => x.name.split('|')[2] === col);
    const from = inputs.indexOf(t);
    let n = 0;
    lines.filter((l, i) => i < lines.length - 1 || l !== '').forEach((l, i) => {
      const input = inputs[from + i];
      if (!input) return;
      input.value = l.split('\t')[0].trim();
      if (store1(input)) n++;
    });
    said.textContent = `Saved ${n} value${n === 1 ? '' : 's'} pasted`;
  });
}
