// Screen: Data — every formulation in one place, filtered like a shop (spec 5).
//
// Left the facets with their counts, above the numbers for the selection, in the middle the table, on the right
// the distributions and how complete the selection is. Every filter is in the hash (app/calc/facets.js
// writeFilter), so Back undoes the last click, a bookmark keeps a selection, and "Use in optimizer" hands the
// same selection over as a query. The rows are worked out once per change of the records (Store.stamp), not per
// click, so filtering 10,000 formulations stays well under the 200 ms the spec allows.
import { header, esc, fmt, fmtDate, toast, download, saveBlob, todayISO, uid, ask } from './kit.js';
import { getRef } from '../refdata.js';
import { dataRows, facetDefs, applyFilter, readFilter, writeFilter, filterQuery, parseFilterQuery, summary, completeness, histogram, perMonth, tally, describeFilter, columnDefs, sortRows, toCsv, textMatches, chosenLabel, overlayDistributions } from '../calc/facets.js';
import { xlsxBytes } from '../calc/xlsx.js';
import { buildIndex, tokens, scoreEntry } from '../calc/search.js';

const clone = (o) => JSON.parse(JSON.stringify(o)); // structuredClone needs Safari 15.4
const ROW_H = 30; // px per table row; the table draws only the rows in view
const COLS_KEY = 'lnp-lab.ui.dataColumns';
let cache = null; // {key, rows, index}

/** The rows and the search index, worked out again only when batches, results, experiments or lipids changed. */
function rowsFor(ctx, ref) {
  const st = ctx.store;
  const key = ['batches', 'measurements', 'experiments', 'compositions', 'lipids', 'studies', 'bioMeasurements'].map((c) => st.stamp(c)).join('.') + '|' + st.ns;
  if (cache?.key === key) return cache;
  const src = { batches: st.all('batches'), experiments: st.all('experiments'), measurements: st.all('measurements') };
  const rows = dataRows({ ...src, studies: st.all('studies'), bioMeasurements: st.all('bioMeasurements') }, ref);
  // The free text goes through the app's own search index, built lazily: most visits never type.
  let index = null;
  cache = { key, rows, get index() { return (index ||= buildIndex({ ...src, stocks: st.all('stocks'), buffers: st.all('buffers'), rnaLots: st.all('rnaLots'), compositions: ref.compositions })); } };
  return cache;
}

/** The selection a hand-over names, for the optimizer: the ids of the formulations it holds and its sentence. */
export function selectionFor(ctx, query) {
  const ref = getRef(ctx), defs = facetDefs(ref);
  const c = rowsFor(ctx, ref);
  const f = parseFilterQuery(query, defs);
  const text = f.q ? textMatches(f.q, c.rows, c.index, { tokens, scoreEntry }) : null;
  const { rows } = applyFilter(c.rows, f, defs, text);
  return { ids: new Set(rows.map((r) => r.id)), sentence: describeFilter(f, defs, rows.length, c.rows), filter: f };
}

const readCols = (cols) => { try { const v = JSON.parse(localStorage.getItem(COLS_KEY) || 'null'); if (Array.isArray(v)) return new Set(v); } catch {} return new Set(cols.filter((c) => c.on).map((c) => c.key)); };
const writeCols = (set) => { try { localStorage.setItem(COLS_KEY, JSON.stringify([...set])); } catch {} };

export async function render(el, ctx) {
  const ref = getRef(ctx), defs = facetDefs(ref), cols = columnDefs(ref);
  const c = rowsFor(ctx, ref);
  if (ctx.params.compare) { compare(el, ctx, ref, defs, c); return; }
  const f = readFilter(ctx.params, defs);
  const t0 = performance.now();
  const text = f.q ? textMatches(f.q, c.rows, c.index, { tokens, scoreEntry }) : null;
  const res = applyFilter(c.rows, f, defs, text);
  const ms = performance.now() - t0;
  const sort = { key: ctx.params.sort || 'date', dir: ctx.params.dir === 'asc' ? 1 : -1 };
  const sortCol = cols.find((x) => x.key === sort.key) || cols.find((x) => x.key === 'date');
  const rows = sortRows(res.rows, sortCol, sort.dir);
  const shown = readCols(cols);
  const s = summary(rows);
  const go = (next) => ctx.navigate('data', { ...writeFilter(next, defs), ...(ctx.params.sort ? { sort: ctx.params.sort, dir: ctx.params.dir } : {}) });
  const sentence = describeFilter(f, defs, rows.length, c.rows);
  const active = Object.keys(writeFilter(f, defs)).length > 0;

  if (!c.rows.length) {
    el.innerHTML = header('Evaluate', 'Data') + `<div class="card"><p>No formulations yet. Plan an experiment, or bring in older data (docs/HISTORICAL-DATA.md), and they are all listed here, with filters like a shop's.</p></div>`;
    return;
  }

  el.innerHTML = header('Evaluate', 'Data', `<button id="toMl" class="primary" ${rows.length ? '' : 'disabled'}>Use in optimizer</button><button id="saveView">Save view</button><button id="exportCsv">CSV</button><button id="exportXlsx">XLSX</button>`) +
    `<div class="kpis" id="dataKpis">
      ${kpi('Formulations', s.formulations, `of ${c.rows.length}`)}${kpi('Experiments', s.experiments)}
      ${kpi('Period', s.from ? `${fmtDate(s.from)} – ${fmtDate(s.to)}` : '–')}
      ${kpi('Median size', s.size != null ? `${fmt(s.size, 0)} nm` : '–', s.nSize ? `n = ${s.nSize}` : '')}${kpi('Median PDI', s.pdi != null ? fmt(s.pdi, 3) : '–', s.nPdi ? `n = ${s.nPdi}` : '')}
      ${kpi('Median EE', s.ee != null ? `${fmt(s.ee, 1)} %` : '–', s.nEe ? `n = ${s.nEe}` : '')}</div>
    <div class="dataChips" id="dataChips">${chips(f, defs, c.rows)}${active ? `<a href="#/data" class="chip" id="clearAll">Clear all</a>` : ''}<span class="muted" style="margin-left:auto">${esc(sentence)} · ${ms.toFixed(0)} ms</span></div>
    <div class="dataGrid">
      <aside class="facets" id="facets">${facetPanel(f, defs, res, c.rows)}</aside>
      <section class="dataMain">
        <details class="colPick"><summary>Columns (${shown.size})</summary><div>${cols.map((col) => `<label><input type="checkbox" data-col="${col.key}" ${shown.has(col.key) ? 'checked' : ''}> ${esc(col.label)}</label>`).join('')}</div></details>
        <div class="vtable" id="vtable" tabindex="0"><table><thead><tr>${cols.filter((x) => shown.has(x.key)).map((x) => `<th data-sort="${x.key}" class="${x.num ? 'r' : ''}" aria-sort="${x.key === sortCol.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${esc(x.label)}${x.key === sortCol.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead><tbody id="vbody"></tbody></table></div>
        <p class="muted" style="margin-top:6px">${rows.length} formulation${rows.length === 1 ? '' : 's'}. Click a row to open it; click a heading to sort.</p>
      </section>
      <aside class="dataSide">${viewsCard(ctx)}${distributions(rows, ref)}${completenessCard(rows)}</aside>
    </div>`;

  // ---- the table, drawing only the rows in view
  const vis = cols.filter((x) => shown.has(x.key));
  const box = el.querySelector('#vtable'), body = el.querySelector('#vbody');
  const cell = (x, r) => { const v = x.get(r); return `<td class="${x.num ? 'r' : ''}">${v == null ? '' : esc(x.num ? String(v) : v)}</td>`; };
  let drawn = '';
  const paint = () => {
    const top = Math.max(0, Math.floor(box.scrollTop / ROW_H) - 10), n = Math.ceil(box.clientHeight / ROW_H) + 20;
    const key = `${top}:${n}`; if (key === drawn) return; drawn = key;
    const end = Math.min(rows.length, top + n);
    body.innerHTML = `<tr style="height:${top * ROW_H}px"></tr>` + rows.slice(top, end).map((r) => `<tr data-open="${esc(r.id)}" style="height:${ROW_H}px">${vis.map((x) => cell(x, r)).join('')}</tr>`).join('') + `<tr style="height:${(rows.length - end) * ROW_H}px"></tr>`;
  };
  paint();
  box.addEventListener('scroll', () => requestAnimationFrame(paint), { passive: true });
  body.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-open]'); if (tr) ctx.navigate('formulation', { batch: tr.dataset.open }); });
  el.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort, dir = k === sortCol.key && sort.dir < 0 ? 'asc' : 'desc';
    ctx.navigate('data', { ...writeFilter(f, defs), sort: k, dir });
  }));
  el.querySelectorAll('[data-col]').forEach((cb) => cb.addEventListener('change', () => {
    const set = readCols(cols); if (cb.checked) set.add(cb.dataset.col); else set.delete(cb.dataset.col); writeCols(set);
    render(el, ctx).then(() => el.querySelector('.colPick')?.setAttribute('open', ''));
  }));

  // ---- facets, chips, charts and completeness all set the filter through the hash
  el.addEventListener('click', (e) => {
    const a = e.target.closest('[data-facet]');
    if (!a) return;
    e.preventDefault();
    const { facet, value } = a.dataset;
    const next = clone(f);
    if (facet === 'missing') { next.missing = next.missing === value ? undefined : value; }
    else if (a.dataset.lo != null || a.dataset.hi != null) { next[facet] = [a.dataset.lo === '' ? null : a.dataset.lo, a.dataset.hi === '' ? null : a.dataset.hi].map((v) => (v == null || facet === 'date' ? v : Number(v))); }
    else if (a.dataset.only != null) { next[facet] = [value]; }
    else { const list = new Set(next[facet] || []); if (list.has(value)) list.delete(value); else list.add(value); next[facet] = [...list]; }
    if (a.dataset.drop) delete next[facet];
    go(next);
  });
  el.querySelectorAll('[data-range]').forEach((inp) => inp.addEventListener('change', () => {
    const k = inp.dataset.range, d = defs.find((x) => x.key === k);
    const lo = el.querySelector(`[data-range="${k}"][data-end="lo"]`).value, hi = el.querySelector(`[data-range="${k}"][data-end="hi"]`).value;
    const next = clone(f);
    next[k] = [lo === '' ? null : d.dates ? lo : Number(lo), hi === '' ? null : d.dates ? hi : Number(hi)];
    go(next);
  }));
  // The two sliders of a range, one per end (spec 5.1, "pH range as a slider"). Dragging shows the value in the
  // box above and keeps the ends from crossing; letting go sets the filter, so the hash, and with it Back, gets one
  // entry per setting rather than one per pixel. An end pushed back to the edge leaves that side open.
  el.querySelectorAll('[data-slider]').forEach((sl) => {
    const k = sl.dataset.slider, d = defs.find((x) => x.key === k);
    const pair = (end) => el.querySelector(`[data-slider="${k}"][data-end="${end}"]`);
    const dp = String(d.step || '').split('.')[1]?.length || 0;
    const val = (s) => Number(Number(s).toFixed(dp));
    sl.addEventListener('input', () => {
      const lo = pair('lo'), hi = pair('hi');
      if (Number(lo.value) > Number(hi.value)) (sl === lo ? lo : hi).value = (sl === lo ? hi : lo).value;
      el.querySelector(`[data-range="${k}"][data-end="${sl.dataset.end}"]`).value = val(sl.value);
    });
    sl.addEventListener('change', () => {
      const [min, max] = res.ranges[k];
      const a = val(pair('lo').value), b = val(pair('hi').value);
      go({ ...clone(f), [k]: [a <= val(min) ? null : a, b >= val(max) ? null : b] });
    });
  });
  el.querySelector('#facetText')?.addEventListener('change', (e) => go({ ...clone(f), q: e.target.value.trim() || undefined }));
  wireViews(el, ctx);

  // ---- actions on the selection (spec 5.3)
  el.querySelector('#toMl').addEventListener('click', () => ctx.navigate('ml', { data: filterQuery(f, defs) || 'all' }));
  el.querySelector('#exportCsv').addEventListener('click', () => download(`lnp-lab-data-${todayISO()}.csv`, '﻿' + toCsv(rows, cols), 'text/csv'));
  el.querySelector('#exportXlsx').addEventListener('click', () => saveBlob(`lnp-lab-data-${todayISO()}.xlsx`, new Blob([xlsxBytes(cols.map((x) => x.label), rows.map((r) => cols.map((x) => x.get(r))))], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })));
  // A view is named in a field that opens beside the button: prompt() blocks, and the macOS app has none.
  el.querySelector('#saveView').addEventListener('click', () => {
    const bar = el.querySelector('#dataChips');
    if (bar.querySelector('#viewName')) { bar.querySelector('#viewName').focus(); return; }
    bar.insertAdjacentHTML('afterbegin', `<span id="viewNameBox" style="display:inline-flex;gap:6px"><input id="viewName" type="text" style="width:220px" placeholder="Name of the view" value="${esc(sentence.replace(/, \d+ formulations?$/, ''))}"><button id="viewNameOk" class="primary">Save</button></span>`);
    const inp = bar.querySelector('#viewName');
    const save = () => {
      const name = inp.value.trim();
      if (!name) { inp.focus(); return; }
      ctx.store.put('views', { id: uid(), name, query: filterQuery(f, defs), createdAt: new Date().toISOString() });
      toast(`Saved "${name}": it is in the sidebar under Data`, 'ok');
      location.hash = `#/data?${filterQuery(f, defs)}&saved=1`; // a new route, so the sidebar is drawn with it
    };
    bar.querySelector('#viewNameOk').addEventListener('click', save);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    inp.select();
  });
}

const kpi = (label, value, sub = '') => `<div class="kpi"><div class="l">${esc(label)}</div><div class="v">${esc(String(value))}</div>${sub ? `<div class="muted">${esc(sub)}</div>` : ''}</div>`;

/** The active filters as chips, each with its own ×. */
function chips(f, defs, all) {
  const out = [];
  for (const d of defs) {
    const v = f[d.key];
    if (!v) continue;
    if (d.range) { if (v[0] != null || v[1] != null) out.push(`<a href="#" class="chip on" data-facet="${d.key}" data-drop="1" title="Remove">${esc(d.label)} ${esc(v[0] ?? '…')}–${esc(v[1] ?? '…')} ×</a>`); }
    else for (const x of v) out.push(`<a href="#" class="chip on" data-facet="${d.key}" data-value="${esc(x)}" title="Remove">${esc(d.label1 ? d.label1(x, all) : x)} ×</a>`);
  }
  if (f.q) out.push(`<a href="#" class="chip on" data-facet="q" data-drop="1">"${esc(f.q)}" ×</a>`);
  if (f.missing) out.push(`<a href="#" class="chip on" data-facet="missing" data-value="${esc(f.missing)}">without ${esc(f.missing)} ×</a>`);
  if (f.ids?.length) out.push(`<a href="#" class="chip on" id="idsChip" data-facet="ids" data-drop="1" title="${esc(f.ids.slice(0, 20).join(', '))}${f.ids.length > 20 ? ' …' : ''}">${esc(chosenLabel(f.ids.length))} ×</a>`);
  return out.join('');
}

/** The facet panel: groups, each facet a list of values with counts, ranges as two sliders. */
function facetPanel(f, defs, res, all) {
  let html = `<input type="search" id="facetText" placeholder="Search: E12, ALC-0315, a lot …" value="${esc(f.q || '')}" style="width:100%;margin-bottom:8px">`;
  let group = null;
  for (const d of defs) {
    // A group's heading is written with its first facet that has something to show, so an empty group (no
    // process values recorded yet) leaves no heading behind.
    const heading = () => { if (d.group !== group) { group = d.group; html += `<div class="fgroup">${esc(group)}</div>`; } };
    if (d.range) {
      const [lo, hi] = res.ranges[d.key] || [];
      if (lo == null) continue;
      const v = f[d.key] || [null, null];
      const type = d.dates ? 'date' : 'number';
      heading();
      html += `<div class="facet"><div class="fname">${esc(d.label)}</div><div class="frange">
        <input type="${type}" data-range="${d.key}" data-end="lo" value="${esc(v[0] ?? '')}" placeholder="${esc(d.dates ? lo : fmt(lo, 2))}" ${d.step ? `step="${d.step}"` : ''} min="${esc(lo)}" max="${esc(hi)}">
        <span>–</span><input type="${type}" data-range="${d.key}" data-end="hi" value="${esc(v[1] ?? '')}" placeholder="${esc(d.dates ? hi : fmt(hi, 2))}" ${d.step ? `step="${d.step}"` : ''} min="${esc(lo)}" max="${esc(hi)}"></div>
        ${!d.dates && lo < hi ? ['lo', 'hi'].map((end, i) => `<input type="range" class="fslider" data-slider="${d.key}" data-end="${end}" min="${lo}" max="${hi}" step="${d.step || 'any'}" value="${v[i] ?? (i ? hi : lo)}" aria-label="${esc(d.label)}, ${i ? 'upper' : 'lower'} end">`).join('') : ''}</div>`;
      continue;
    }
    const counts = [...res.counts[d.key].entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }));
    const on = new Set(f[d.key] || []);
    for (const x of on) if (!res.counts[d.key].has(x)) counts.unshift([x, 0]);
    if (!counts.length) continue;
    heading();
    const item = ([v, n]) => `<a href="#" class="fval${on.has(v) ? ' on' : ''}${n ? '' : ' zero'}" data-facet="${d.key}" data-value="${esc(v)}" role="checkbox" aria-checked="${on.has(v)}"><span class="box"></span><span class="lbl">${esc(d.label1 ? d.label1(v, all) : v)}</span><span class="n">(${n})</span></a>`;
    const head = counts.slice(0, 6), rest = counts.slice(6);
    html += `<div class="facet" data-key="${d.key}"><div class="fname">${esc(d.label)}</div>${head.map(item).join('')}${rest.length ? `<details><summary class="muted">${rest.length} more</summary>${rest.map(item).join('')}</details>` : ''}</div>`;
  }
  return html;
}

/** Small bar charts; each bar is a link that sets the filter (spec 5.1). */
function bars(title, items, { facet, max = 12 } = {}) {
  if (!items.length) return '';
  const top = Math.max(1, ...items.map((i) => i.n)), list = items.slice(0, max);
  return `<div class="card mini"><h3>${esc(title)}</h3><div class="hbars">${list.map((i) => `<a href="#" class="hbar" ${i.attrs || ''} data-facet="${facet}" title="${esc(i.label)}: ${i.n}"><span class="hl">${esc(i.label)}</span><span class="hb"><i style="width:${(100 * i.n / top).toFixed(1)}%"></i></span><span class="hn">${i.n}</span></a>`).join('')}</div></div>`;
}
function distributions(rows, ref) {
  const ln = (k) => ref.lipidByKey[k]?.name || k;
  const sizeBins = histogram(rows.map((r) => r.size), { bins: 8 }), pdiBins = histogram(rows.map((r) => r.pdi), { bins: 8 });
  const binItems = (bs, dp) => bs.map((b) => ({ label: `${fmt(b.lo, dp)}–${fmt(b.hi, dp)}`, n: b.n, attrs: `data-lo="${b.lo.toFixed(dp + 1)}" data-hi="${b.hi.toFixed(dp + 1)}"` }));
  const months = perMonth(rows);
  const lastDay = (m) => { const [y, mo] = m.split('-').map(Number); return `${m}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`; };
  return bars('Runs per ionizable lipid', tally(rows, (r) => r.ionizable).map((t) => ({ label: ln(t.value), n: t.n, attrs: `data-value="${esc(t.value)}" data-only="1"` })), { facet: 'ionizable' })
    + bars('Size (nm)', binItems(sizeBins, 0), { facet: 'size' })
    + bars('PDI', binItems(pdiBins, 2), { facet: 'pdi' })
    + bars('Runs per month', months.map((m) => ({ label: m.month, n: m.n, attrs: `data-lo="${m.month}-01" data-hi="${lastDay(m.month)}"` })).reverse(), { facet: 'date', max: 18 });
}

/** Spec 5.2: how complete the selection is, per field; a row filters to the formulations it lacks. */
function completenessCard(rows) {
  if (!rows.length) return '';
  const lv = { good: 'ok', warn: 'warn', bad: 'bad' };
  return `<div class="card mini"><h3>Completeness</h3><div class="hbars">${completeness(rows).map((c) => `<a href="#" class="hbar comp ${lv[c.level]}" data-facet="missing" data-value="${c.key}" title="${c.n} of ${rows.length} have ${esc(c.label)}. Click to list the ones without."><span class="hl">${esc(c.label)}</span><span class="hb"><i style="width:${(100 * c.share).toFixed(1)}%"></i></span><span class="hn">${Math.round(100 * c.share)} %</span></a>`).join('')}</div>
    <p class="muted">Over 90 % good, 50–90 % patchy, under 50 % missing. Click a field to list the formulations that lack it.</p></div>`;
}

/**
 * Two saved views side by side: their numbers, and all four distributions of the data screen over each other
 * (spec 5.3). Which two is picked at the top, any two of the saved views; the sidebar's link opens it on the
 * first two, which used to be the only pair it could show.
 */
function compare(el, ctx, ref, defs, c) {
  const views = savedViews(ctx.store);
  const asked = String(ctx.params.compare).split(',').map((id) => ctx.store.get('views', id));
  // Views are matched by id: the store may hand out a copy of a record, not the one in the list.
  const a = asked[0] || views[0], b = (asked[1] && asked[1].id !== a?.id ? asked[1] : null) || views.find((v) => v.id !== a?.id);
  const picker = (which, cur) => `<select id="cmp${which}" aria-label="View ${which}">${views.map((v) => `<option value="${esc(v.id)}"${v.id === cur.id ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select>`;
  if (!a || !b) { el.innerHTML = header('Evaluate', 'Compare views') + '<div class="note warn">Save two views first (Save view on the Data screen), then pick them here.</div>'; return; }
  const sel = (v) => { const f = parseFilterQuery(v.query, defs); const t = f.q ? textMatches(f.q, c.rows, c.index, { tokens, scoreEntry }) : null; return applyFilter(c.rows, f, defs, t).rows; };
  const ra = sel(a), rb = sel(b), sa = summary(ra), sb = summary(rb);
  const line = (label, x, y) => `<tr><td>${esc(label)}</td><td class="r">${esc(String(x ?? '–'))}</td><td class="r">${esc(String(y ?? '–'))}</td></tr>`;
  const ov = overlayDistributions(ra, rb);
  const ln = (k) => ref.lipidByKey?.[k]?.name || k;
  const chart = (id, title, items, label, max = 18) => {
    if (!items.length) return '';
    const list = items.slice(0, max);
    const top = Math.max(1e-9, ...list.map((x) => Math.max(x.shareA, x.shareB)));
    const pct = (x) => `${Math.round(100 * x)} %`;
    return `<div class="card mini" id="${id}"><h3>${esc(title)}, share of each view</h3><div class="hbars">${list.map((x) => `<div class="hbar" title="${esc(label(x))}: ${esc(a.name)} ${x.a} (${pct(x.shareA)}), ${esc(b.name)} ${x.b} (${pct(x.shareB)})"><span class="hl">${esc(label(x))}</span><span class="hb two"><i style="width:${(100 * x.shareA / top).toFixed(1)}%"></i><i class="b" style="width:${(100 * x.shareB / top).toFixed(1)}%"></i></span><span class="hn">${x.a} · ${x.b}</span></div>`).join('')}</div></div>`;
  };
  const bin = (dp) => (x) => `${fmt(x.lo, dp)}–${fmt(x.hi, dp)}`;
  el.innerHTML = header('Evaluate', 'Compare views') + `<div class="card"><div class="cmpPick" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px"><span class="swatch a"></span>${picker('A', a)}<span class="muted">against</span><span class="swatch b"></span>${picker('B', b)}</div>
    <table id="cmpTable"><thead><tr><th></th><th class="r"><a href="#/data?${esc(a.query)}">${esc(a.name)}</a></th><th class="r"><a href="#/data?${esc(b.query)}">${esc(b.name)}</a></th></tr></thead><tbody>
    ${line('Formulations', sa.formulations, sb.formulations)}${line('Experiments', sa.experiments, sb.experiments)}
    ${line('Median size (nm)', sa.size != null ? fmt(sa.size, 0) : null, sb.size != null ? fmt(sb.size, 0) : null)}${line('Median PDI', sa.pdi != null ? fmt(sa.pdi, 3) : null, sb.pdi != null ? fmt(sb.pdi, 3) : null)}${line('Median EE (%)', sa.ee != null ? fmt(sa.ee, 1) : null, sb.ee != null ? fmt(sb.ee, 1) : null)}
    </tbody></table><p class="muted"><span class="swatch a"></span> ${esc(a.name)} <span class="swatch b"></span> ${esc(b.name)}. Each bar is the share of its own view; the numbers are the counts.</p></div>
    <div class="grid g2">${chart('cmpLipid', 'Runs per ionizable lipid', ov.lipid, (x) => ln(x.key), 12)}${chart('cmpSize', 'Size (nm)', ov.size, bin(0))}${chart('cmpPdi', 'PDI', ov.pdi, bin(2))}${chart('cmpMonth', 'Runs per month', ov.month.slice().reverse(), (x) => x.key)}</div>`;
  // Picking on one side the view the other side shows swaps the two, rather than comparing a view with itself.
  const pick = (side) => {
    let x = el.querySelector('#cmpA').value, y = el.querySelector('#cmpB').value;
    if (x === y) { if (side === 'A') y = a.id; else x = b.id; }
    ctx.navigate('data', { compare: `${x},${y}` });
  };
  el.querySelector('#cmpA').addEventListener('change', () => pick('A'));
  el.querySelector('#cmpB').addEventListener('change', () => pick('B'));
}

/**
 * The saved views on the data screen itself: each opens its filter, and can be renamed or deleted there (the
 * sidebar lists them but has no room for either). With two or more, any two can be compared.
 */
function viewsCard(ctx) {
  const views = savedViews(ctx.store);
  if (!views.length) return '';
  const opt = (v, on) => `<option value="${esc(v.id)}"${on ? ' selected' : ''}>${esc(v.name)}</option>`;
  return `<details class="card mini fold" id="viewsCard"${viewsOpen ? ' open' : ''}><summary><h3 style="display:inline">Saved views (${views.length})</h3></summary>
    <ul class="viewList" style="list-style:none;padding:0;margin:6px 0">${views.map((v) => `<li data-view="${esc(v.id)}" style="display:flex;gap:6px;align-items:center;margin:3px 0"><a href="#/data?${esc(v.query)}" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(v.name)}">${esc(v.name)}</a><button type="button" data-rename="${esc(v.id)}" style="padding:2px 6px">Rename</button><button type="button" data-delview="${esc(v.id)}" style="padding:2px 6px">Delete</button></li>`).join('')}</ul>
    ${views.length > 1 ? `<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center"><select id="viewA" aria-label="First view" style="flex:1;min-width:0">${views.map((v, i) => opt(v, i === 0)).join('')}</select><select id="viewB" aria-label="Second view" style="flex:1;min-width:0">${views.map((v, i) => opt(v, i === 1)).join('')}</select><button type="button" id="compareViews">Compare</button></div>` : ''}</details>`;
}
let viewsOpen = false;

/** Rename, delete and compare on the views card. A change to the views redraws the sidebar, which lists them. */
function wireViews(el, ctx) {
  const card = el.querySelector('#viewsCard');
  if (!card) return;
  card.querySelector('summary').addEventListener('click', () => { viewsOpen = !card.open; });
  const changed = () => { viewsOpen = true; window.dispatchEvent(new Event('lnp:drafts')); render(el, ctx); }; // lnp:drafts redraws the sidebar (app/main.js)
  card.querySelectorAll('[data-delview]').forEach((b) => b.addEventListener('click', async () => {
    if (await deleteView(ctx, b.dataset.delview)) { toast('View deleted', 'ok'); changed(); }
  }));
  // Renamed in a field that opens in place, as a view is named when it is saved (no prompt(): the macOS app has none).
  card.querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', () => {
    const li = b.closest('li'), v = ctx.store.get('views', b.dataset.rename);
    if (!v || li.querySelector('input')) return;
    li.innerHTML = `<input type="text" class="viewRename" value="${esc(v.name)}" aria-label="New name" style="flex:1;min-width:0"><button type="button" class="primary" data-renameok>Save</button>`;
    const inp = li.querySelector('input');
    const save = () => {
      const name = inp.value.trim();
      if (!name) { inp.focus(); return; }
      ctx.store.put('views', { ...v, name, renamedAt: new Date().toISOString() });
      toast(`Renamed to "${name}"`, 'ok');
      changed();
    };
    li.querySelector('[data-renameok]').addEventListener('click', save);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') changed(); });
    inp.select();
  }));
  card.querySelector('#compareViews')?.addEventListener('click', () => {
    const x = card.querySelector('#viewA').value, y = card.querySelector('#viewB').value;
    if (x === y) { toast('Pick two different views', 'warn'); return; }
    ctx.navigate('data', { compare: `${x},${y}` });
  });
}

/** The saved views, for the sidebar (app/main.js) and the views card. */
export const savedViews = (store) => store.all('views').sort((a, b) => String(a.name).localeCompare(String(b.name)));
/** Delete a view after asking; true when it went. */
export async function deleteView(ctx, id) {
  const v = ctx.store.get('views', id);
  if (!v || !(await ask(`Delete the view "${v.name}"? The formulations in it are not affected.`))) return false;
  ctx.store.remove('views', id);
  return true;
}
