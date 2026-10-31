// The biological layers' tabs in the formulation and experiment views (spec 8.5): each layer switched on in
// Settings is its own tab beside the formulation itself; with none on, no tab bar is drawn and the views look
// as they always did. A tab shows what the studies hold for the formulation(s) on view, normalised to each
// study's reference (8.2), with the effect size beside every test (8.4), and links to the study for the rest.
import { esc, raw, table, header, chip } from './kit.js';
import { getSettings, getRef } from '../refdata.js';
import { activeLayers, layerById, normaliseStudy, compareToReference, seriesLabel, fmtFold } from '../calc/bio.js';
import { foldChart, figure, wireFigures, seriesColor } from './charts.js';
import { describeId } from '../schema.js';

/** The layer a view's `tab` parameter names, when that layer is switched on; null for the formulation itself. */
export function layerTab(ctx) {
  const t = ctx.params?.tab;
  return t && activeLayers(getSettings(ctx)).some((l) => l.id === t) ? t : null;
}

/**
 * The tab bar: "Formulation" (or "Experiment") and one tab per active layer. Empty when no layer is on, so
 * nothing of this is visible to a lab that does not use it.
 * @param {object} ctx
 * @param {string} current   'core' or a layer id
 * @param {(tab: string|null) => string} href   the hash for a tab
 * @param {string} coreLabel
 */
export function layerTabBar(ctx, current, href, coreLabel = 'Formulation') {
  const layers = activeLayers(getSettings(ctx));
  if (!layers.length) return '';
  const tab = (id, label) => `<a class="btn${current === id ? ' primary' : ''}" role="tab" aria-selected="${current === id}" data-layer-tab="${esc(id)}" href="${esc(href(id === 'core' ? null : id))}">${esc(label)}</a>`;
  return `<div class="layerTabs" role="tablist" aria-label="Layers" style="display:flex;gap:6px;flex-wrap:wrap;margin:-4px 0 14px">${tab('core', coreLabel)}${layers.map((l) => tab(l.id, `${l.no} · ${l.name}`)).join('')}</div>`;
}

/**
 * Draw one layer's tab for a formulation or an experiment.
 * @param {HTMLElement} el
 * @param {object} ctx
 * @param {{layer: string, batchIds: string[], crumb: object, title: string, bar: string, what: string}} o
 */
export function renderLayerTab(el, ctx, { layer, batchIds, crumb, title, bar, what }) {
  const L = layerById[layer];
  const ids = new Set(batchIds);
  const studies = ctx.store.all('studies');
  const all = ctx.store.all('bioMeasurements');
  const ref = getRef(ctx);
  const cards = [];
  for (const st of studies) {
    const ms = all.filter((m) => m.studyId === st.id && m.layer === layer);
    if (!ms.length) continue;
    const mine = (st.groups || []).filter((g) => g.batchId && ids.has(g.batchId));
    if (!mine.length && !ms.some((m) => ids.has(m.batchId))) continue;
    const norm = normaliseStudy(st, ms);
    for (const s of norm.series) {
      const cmp = compareToReference(s);
      const shown = s.groups.filter((g) => g.role === 'reference' || g.role === 'negative' || (g.batchId && ids.has(g.batchId)));
      if (!shown.some((g) => g.batchId && ids.has(g.batchId))) continue;
      const rows = shown.map((g) => {
        const c = cmp.find((x) => x.group === g.group);
        return { cells: [
          raw(`${esc(g.name)} ${g.role === 'reference' ? chip('reference', 'info') : g.role === 'negative' ? chip('negative control') : ''}`),
          g.batchId ? raw(`<a href="#/formulation?batch=${esc(g.batchId)}">${esc(g.batchId)}</a>`) : '–',
          g.n,
          g.rawMean == null ? '–' : `${sig(g.rawMean)}${g.rawSd != null ? ` ± ${sig(g.rawSd)}` : ''} ${s.unit}`,
          g.fold == null ? '–' : `${fmtFold(g.fold)}×`,
          c ? c.text.replace(/^[^:]+:\s*/, '') : g.role === 'reference' ? 'the yardstick' : '',
        ] };
      });
      const chart = foldChart({ groups: shown.filter((g) => g.role !== 'negative').map((g, i) => {
        const c = cmp.find((x) => x.group === g.group);
        return { label: g.name, points: g.logs.map((v) => 10 ** v), mean: g.fold, lo: c?.ci?.[0], hi: c?.ci?.[1], n: g.nLog, color: g.role === 'reference' ? 'var(--ink3)' : seriesColor(i) };
      }), title: seriesLabel(s) });
      cards.push(`<div class="card"><h2><a href="#/studies?id=${esc(st.id)}">${esc(st.id)}</a> · ${esc(st.name || 'untitled')} <span class="muted" style="font-weight:400">· ${esc(seriesLabel(s))}</span></h2>
        ${norm.series.length && !s.reference ? '<div class="note warn">This study has no reference values for this read-out: the values are raw, not normalised.</div>' : ''}
        ${figure(chart, { title: `${seriesLabel(s)}, fold over reference`, caption: 'Each point is one animal or well. Bar: geometric mean; whisker: 95 % confidence interval from Welch\'s test on log10 values; dashed line: the reference at 1-fold.', name: `${st.id}_${s.quantity}` })}
        ${table(['Group', 'Formulation', { label: 'n', right: true }, 'Raw mean ± SD', 'Fold', 'Against the reference'], rows)}</div>`);
    }
  }
  const comp = (id) => { const b = ctx.store.get('batches', id); return b ? ref.compositionById[b.compositionId]?.synonym || '' : ''; };
  el.innerHTML = header(crumb, title) + bar +
    `<p class="muted" style="margin-top:0">${esc(L.no)} · ${esc(L.name)}: ${esc(L.what.toLowerCase())}. Values from the studies that ran ${esc(what)}${batchIds.length === 1 && comp(batchIds[0]) ? ` (${esc(comp(batchIds[0]))})` : ''}, each normalised to the reference that ran in the same study.</p>` +
    (cards.length ? cards.join('') : `<div class="card"><h2>No ${esc(L.name.toLowerCase())} data yet</h2><p class="muted">No study holds ${esc(L.name.toLowerCase())} values for ${esc(what)}. <a href="#/studies?new=1">Set up a study</a>, name ${batchIds.length === 1 ? 'this formulation' : 'these formulations'} in its groups, and enter or import the values there.</p></div>`);
  wireFigures(el);
}

const sig = (x) => (!Number.isFinite(x) ? '–' : Math.abs(x) >= 1e5 || (Math.abs(x) < 0.01 && x !== 0) ? x.toExponential(2) : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));

/** The heading parts for a formulation's layer tab, matching the formulation screen's own. */
export function formulationCrumb(batch) {
  return raw(`<a href="#/formulation">Formulations</a> › <a href="#/experiments?id=${esc(batch.experimentId)}">${esc(describeId(batch.experimentId))}</a>`);
}
