// Screen: Studies, the biological layers' home (spec 8). In the sidebar only when a layer is switched on in
// Settings. A study is one in-vitro or in-vivo experiment on formulations: its plan (groups, reference,
// controls, context, licence), its values (typed into a grid, or imported from a plate reader or an IVIS
// export), and its evaluation (fold over the reference per group, statistics with effect sizes, organs,
// tropism). Across studies, only normalised values are compared (8.2).
//
// The calculations are all in app/calc/bio.js (normalisation, statistics), app/calc/parsers.js (plates),
// app/calc/ivis.js and app/calc/bli.js (images); this file draws and stores.
import { esc, raw, table, header, chip, toast, field, autoSaver, todayISO, registerDirty, fieldsChanged } from './kit.js';
import { getSettings, getRef } from '../refdata.js';
import {
  LAYERS, layerById, activeLayers, CATALOGS, catalog, catalogRecord, nextStudyId, newStudy, nextGroupId, studyWarnings,
  normaliseStudy, compareToReference, organRatios, tropismShares, seriesLabel, seriesKey, fmtFold, plannedSubjects,
  measurementId, plateToMeasurements, normalisedByFormulation, seriesCatalogue, physchemScatter,
} from '../calc/bio.js';
import { parsePlate } from '../calc/parsers.js';
import { provenance } from '../calc/provenance.js';
import { sha256 } from '../calc/sha256.js';
import { dataRows } from '../calc/facets.js';
import { foldChart, stackedShares, scatterChart, figure, wireFigures, seriesColor } from './charts.js';
import { mountBli } from './bliview.js';

const ROLES = [['test', 'Test'], ['reference', 'Reference'], ['negative', 'Negative control']];
const PARTS = [['results', 'Results'], ['plan', 'Plan'], ['enter', 'Enter values'], ['plate', 'Plate reader'], ['ivis', 'IVIS images']];
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sig = (x) => (!Number.isFinite(x) ? '–' : Math.abs(x) >= 1e5 || (Math.abs(x) < 0.01 && x !== 0) ? x.toExponential(2) : Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));

export async function render(el, ctx) {
  const s = getSettings(ctx);
  const on = activeLayers(s);
  if (!on.length) {
    el.innerHTML = header('Evaluate', 'Studies') + '<div class="card"><p>The biological layers are all switched off. Switch one on under <a href="#/settings">Settings › Biological layers</a> to record in-vitro or in-vivo studies.</p></div>';
    return;
  }
  if (ctx.params.new) return create(el, ctx, on);
  if (ctx.params.id) {
    const st = ctx.store.get('studies', ctx.params.id);
    if (!st) { el.innerHTML = header(raw('<a href="#/studies">Studies</a>'), 'Not found') + `<div class="note warn">No study ${esc(ctx.params.id)}.</div>`; return; }
    return detail(el, ctx, st, on);
  }
  return list(el, ctx, on);
}

/* ------------------------------------------------------------------ list, across studies, catalogues */

function list(el, ctx, on) {
  const studies = ctx.store.all('studies');
  const ms = ctx.store.all('bioMeasurements');
  const rows = studies.map((st) => {
    const n = ms.filter((m) => m.studyId === st.id).length;
    const w = studyWarnings(st, on.map((l) => l.id));
    return { attrs: `data-study="${esc(st.id)}"`, cells: [
      raw(`<a href="#/studies?id=${esc(st.id)}"><b>${esc(st.id)}</b></a>`), st.name || '–', st.type,
      raw((st.layers || []).map((l) => chip(layerById[l]?.name || l)).join(' ')), st.date || '–',
      (st.groups || []).length, n, raw(w.length ? `<span class="chip warn" title="${esc(w.join(' '))}">${w.length} to check</span>` : chip('ok', 'ok')),
    ] };
  });
  el.innerHTML = header('Evaluate', 'Studies', '<a class="btn primary" id="newStudy" href="#/studies?new=1">New study</a>') +
    `<p class="muted" style="margin-top:0">Layers on: ${on.map((l) => `${l.no} · ${esc(l.name)}`).join(', ')}. Raw values are stored; every evaluation is normalised to the reference that ran in the same study.</p>
    <div class="card"><h2>Studies</h2>${table(['Study', 'Name', 'Type', 'Layers', 'Date', { label: 'Groups', right: true }, { label: 'Values', right: true }, 'Check'], rows, { empty: 'No studies yet. A study holds the groups, the reference and the values of one in-vitro or in-vivo experiment.' })}</div>
    ${acrossCard(ctx)}
    ${catalogCard(ctx)}`;
  wireAcross(el, ctx);
  wireCatalog(el, ctx, () => list(el, ctx, on));
  wireFigures(el);
}

const PHYS = [['size', 'Size (Z-ave, nm)'], ['pdi', 'PDI'], ['ee', 'Encapsulation (%)'], ['zeta', 'Zeta potential (mV)']];

/** Physicochemistry against the normalised biological signal, every formulation of every study (8.4). */
function acrossCard(ctx) {
  const by = normalisedByFormulation(ctx.store.all('studies'), ctx.store.all('bioMeasurements'));
  const keys = seriesCatalogue(by);
  if (!keys.length) return '';
  const key = ctx.params.series && keys.some((k) => k.key === ctx.params.series) ? ctx.params.series : (keys.find((k) => /liver/.test(k.key)) || keys[0]).key;
  const x = PHYS.some(([k]) => k === ctx.params.x) ? ctx.params.x : 'size';
  const ref = getRef(ctx);
  const rows = dataRows({ batches: ctx.store.all('batches'), experiments: ctx.store.all('experiments'), measurements: ctx.store.all('measurements') }, ref);
  const sc = physchemScatter(rows, by, { x, key });
  const svg = scatterChart({ points: sc.points.map((p) => ({ x: p.x, y: p.y, label: `${p.label}: ${fmtFold(p.fold)}×` })), xlab: PHYS.find(([k]) => k === x)[1], ylab: 'log10 fold over reference', refY: [{ y: 0, label: 'reference' }] });
  return `<div class="card" id="acrossCard"><h2>Across studies</h2>
    <div class="grid g4">${field({ id: 'acrossSeries', label: 'Biological read-out', type: 'select', value: key, options: keys.map((k) => ({ value: k.key, label: k.label })) })}
      ${field({ id: 'acrossX', label: 'Against', type: 'select', value: x, options: PHYS.map(([value, label]) => ({ value, label })) })}</div>
    ${sc.points.length ? figure(svg, { title: 'Physicochemistry against the normalised signal', caption: `One point per formulation, its mean log10 fold over the reference of each study it ran in. ${sc.n} formulation${sc.n === 1 ? '' : 's'}${sc.r != null ? `, Pearson r = ${sc.r.toFixed(2)}` : ''}. Only normalised values are compared across studies.`, name: 'across_studies' })
      : '<p class="muted">No formulation has both this read-out and the chosen physicochemical value yet.</p>'}</div>`;
}
function wireAcross(el, ctx) {
  const go = () => ctx.navigate('studies', { series: el.querySelector('#acrossSeries').value, x: el.querySelector('#acrossX').value });
  el.querySelector('#acrossSeries')?.addEventListener('change', go);
  el.querySelector('#acrossX')?.addEventListener('change', go);
}

/** The catalogues (8.1): shipped entries, and the lab's own, added here. */
function catalogCard(ctx) {
  const own = ctx.store.all('bioCatalog');
  return `<details class="card" id="catalogCard"><summary><h2 style="display:inline">Catalogues</h2> <span class="muted">cell lines, strains, organs, cell populations</span></summary>
    <div class="grid g2">${Object.entries(CATALOGS).map(([kind, c]) => `<div><h3 style="margin:10px 0 4px">${esc(c.label)}</h3>
      <div style="display:flex;flex-wrap:wrap;gap:4px">${catalog(kind, own).map((n) => chip(n, c.items.includes(n) ? '' : 'info')).join('')}</div>
      <div style="display:flex;gap:6px;margin-top:6px"><input type="text" data-cat-input="${kind}" placeholder="Add to ${esc(c.label.toLowerCase())}" aria-label="Add to ${esc(c.label.toLowerCase())}"><button type="button" data-cat-add="${kind}">Add</button></div></div>`).join('')}</div></details>`;
}
function wireCatalog(el, ctx, redraw) {
  el.querySelectorAll('[data-cat-add]').forEach((b) => b.addEventListener('click', () => {
    const kind = b.dataset.catAdd, input = el.querySelector(`[data-cat-input="${kind}"]`), name = input.value.trim();
    if (!name) return;
    if (catalog(kind, ctx.store.all('bioCatalog')).some((n) => n.toLowerCase() === name.toLowerCase())) { toast(`${name} is already in the list`); return; }
    ctx.store.put('bioCatalog', catalogRecord(kind, name));
    toast(`Added ${name}`, 'ok');
    redraw();
    el.querySelector('#catalogCard')?.setAttribute('open', '');
  }));
}

/* ------------------------------------------------------------------ a new study */

function create(el, ctx, on) {
  const type = on.some((l) => l.id !== 'invitro') && !on.some((l) => l.id === 'invitro') ? 'in vivo' : on.some((l) => l.id === 'invitro') && on.length === 1 ? 'in vitro' : 'in vivo';
  el.innerHTML = header(raw('<a href="#/studies">Studies</a>'), 'New study') +
    `<div class="card"><div class="grid g4" id="newForm">
      ${field({ id: 'name', label: 'Name', type: 'text', value: '', placeholder: 'e.g. Liver screen, round 2' })}
      ${field({ id: 'type', label: 'Type', type: 'select', value: type, options: ['in vitro', 'in vivo'] })}
      ${field({ id: 'date', label: 'Date', type: 'date', value: todayISO() })}
      <div><label>Layers</label>${on.map((l) => `<label class="inline" style="font-weight:400;display:block"><input type="checkbox" name="layer_${l.id}" style="width:auto" ${(type === 'in vitro') === (l.id === 'invitro') ? 'checked' : ''}> ${esc(l.name)}</label>`).join('')}</div>
    </div><p><button class="primary" id="createStudy">Create study</button></p>
    <p class="muted">The study starts with a reference group and one test group; add groups, the formulations they ran and the negative control in its plan.</p></div>`;
  el.querySelector('#createStudy').addEventListener('click', () => {
    const f = el.querySelector('#newForm');
    const id = nextStudyId(ctx.store.all('studies'), ctx.store.all('trash'));
    const st = newStudy({ id, name: f.querySelector('[name=name]').value.trim(), type: f.querySelector('[name=type]').value, date: f.querySelector('[name=date]').value, layers: on.filter((l) => f.querySelector(`[name=layer_${l.id}]`).checked).map((l) => l.id) });
    st.provenance = provenance('manual');
    ctx.store.put('studies', st);
    toast(`Created ${id}`, 'ok');
    ctx.navigate('studies', { id, part: 'plan' });
  });
}

/* ------------------------------------------------------------------ one study */

function detail(el, ctx, st, on) {
  const ms = ctx.store.all('bioMeasurements').filter((m) => m.studyId === st.id);
  const part = PARTS.some(([p]) => p === ctx.params.part) ? ctx.params.part : (ms.length ? 'results' : 'plan');
  const warnings = studyWarnings(st, on.map((l) => l.id));
  const tabs = `<div class="layerTabs" role="tablist" style="display:flex;gap:6px;flex-wrap:wrap;margin:-4px 0 14px">${PARTS.filter(([p]) => p !== 'ivis' || on.some((l) => l.id === 'invivo' || l.id === 'biodist')).map(([p, label]) => `<a class="btn${p === part ? ' primary' : ''}" role="tab" aria-selected="${p === part}" data-part="${p}" href="#/studies?id=${esc(st.id)}&part=${p}">${esc(label)}</a>`).join('')}</div>`;
  el.innerHTML = header(raw('<a href="#/studies">Studies</a>'), `${st.id} · ${st.name || 'untitled'}`,
    `<span class="chip info">${esc(st.type)}</span><span class="muted">${ms.length} value${ms.length === 1 ? '' : 's'}</span><button id="delStudy">Delete study</button>`) + tabs +
    (warnings.length ? `<div class="note warn" id="studyWarnings">${warnings.map((w) => `<div>${esc(w)}</div>`).join('')}</div>` : '') +
    '<div id="partBody"></div>';
  const body = el.querySelector('#partBody');
  const redraw = () => detail(el, ctx, ctx.store.get('studies', st.id) || st, on);
  if (part === 'plan') planPart(body, ctx, st, on, redraw);
  else if (part === 'enter') enterPart(body, ctx, st, on, redraw);
  else if (part === 'plate') platePart(body, ctx, st, on, redraw);
  else if (part === 'ivis') mountBli(body, ctx, st, redraw);
  else resultsPart(body, ctx, st, ms, on);
  el.querySelector('#delStudy').addEventListener('click', () => {
    // To the trash with its values and image records, as an experiment goes with its formulations; Undo puts all back.
    const refs = [['studies', st.id], ...ms.map((m) => ['bioMeasurements', m.id]), ...ctx.store.all('bliImages').filter((b) => b.studyId === st.id).map((b) => ['bliImages', b.id])];
    const entry = ctx.store.moveToTrash(refs, { kind: 'study', label: `${st.id} · ${st.name || 'untitled'}${ms.length ? ` · ${ms.length} values` : ''}` });
    if (entry) toast(`Deleted ${st.id}`, '', { action: 'Undo', onAction: () => { const r = ctx.store.restoreFromTrash(entry.id); if (r.ok) ctx.navigate('studies', { id: st.id }); else toast(`Not restored: ${r.reason}`, 'warn'); } });
    ctx.navigate('studies');
  });
}

/* ---------------- the plan */

function contextField(st, layer, [key, label, kind], ctx) {
  const v = st.context?.[layer]?.[key] ?? '';
  const id = `ctx_${layer}_${key}`;
  if (kind === 'organs') {
    const chosen = new Set(st.context?.[layer]?.organs || ['liver']);
    return `<div style="grid-column:1/-1"><label>${esc(label)}</label><div style="display:flex;flex-wrap:wrap;gap:10px">${catalog('organ', ctx.store.all('bioCatalog')).map((o) => `<label class="inline" style="font-weight:400"><input type="checkbox" data-organ="${esc(o)}" style="width:auto" ${chosen.has(o) ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</div></div>`;
  }
  if (kind.startsWith('catalog:')) {
    const items = catalog(kind.slice(8), ctx.store.all('bioCatalog'));
    return `<div><label for="${id}">${esc(label)}</label><input type="text" id="${id}" name="${id}" list="${id}_l" value="${esc(v)}"><datalist id="${id}_l">${items.map((i) => `<option value="${esc(i)}">`).join('')}</datalist></div>`;
  }
  if (kind.startsWith('select:')) return field({ id, label, type: 'select', value: v, options: ['', ...kind.slice(7).split(',')] });
  return field({ id, label, type: kind === 'number' ? 'number' : 'text', value: v });
}

function planPart(body, ctx, st, on, redraw) {
  const batches = ctx.store.all('batches');
  const exps = ctx.store.all('experiments');
  const layersShown = LAYERS.filter((l) => on.some((x) => x.id === l.id) || (st.layers || []).includes(l.id));
  const groupRow = (g, i) => `<tr data-group="${esc(g.id)}"><td><input type="text" name="g_name" value="${esc(g.name || '')}" aria-label="Group name"></td>
    <td><select name="g_role" aria-label="Role">${ROLES.map(([v, l]) => `<option value="${v}" ${g.role === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
    <td><input type="text" name="g_batch" list="batchList" value="${esc(g.batchId || '')}" placeholder="${g.role === 'negative' ? 'none (PBS)' : 'E3-F2'}" aria-label="Formulation"></td>
    <td><input type="number" name="g_n" min="0" step="1" value="${esc(g.n ?? '')}" aria-label="Animals or wells" style="width:80px"></td>
    <td><button type="button" data-rmgroup="${esc(g.id)}" title="Remove this group">Remove</button></td></tr>`;
  body.innerHTML = `<div class="card" id="planForm"><div style="display:flex;align-items:center;gap:10px"><h2 style="flex:1">Plan</h2><span id="planSave"></span></div>
    <div class="grid g4">
      ${field({ id: 'name', label: 'Name', type: 'text', value: st.name })}
      ${field({ id: 'type', label: 'Type', type: 'select', value: st.type, options: ['in vitro', 'in vivo'] })}
      ${field({ id: 'date', label: 'Date', type: 'date', value: st.date })}
      ${field({ id: 'licence', label: st.type === 'in vivo' ? 'Animal licence number' : 'Ethics or licence number', type: 'text', value: st.licence, placeholder: 'free text' })}
    </div>
    <div style="margin-top:8px"><label>Layers in this study</label>${layersShown.map((l) => `<label class="inline" style="font-weight:400;margin-right:14px"><input type="checkbox" name="layer_${l.id}" style="width:auto" ${(st.layers || []).includes(l.id) ? 'checked' : ''}> ${l.no} · ${esc(l.name)}</label>`).join('')}</div>
    <h3 style="margin:14px 0 4px">Groups</h3>
    <p class="muted" style="margin-top:0">One reference group that runs the lab standard in this study; a negative control (PBS, empty LNP) if the background should be subtracted; the formulations under test.</p>
    <datalist id="batchList">${batches.slice(-400).map((b) => `<option value="${esc(b.id)}">${esc(b.label || '')}</option>`).join('')}</datalist>
    <div style="overflow-x:auto"><table id="groupTable"><thead><tr><th>Group</th><th>Role</th><th>Formulation</th><th>${st.type === 'in vitro' ? 'Wells' : 'Animals'}</th><th></th></tr></thead><tbody>${(st.groups || []).map(groupRow).join('')}</tbody></table></div>
    <p><button type="button" id="addGroup">Add group</button></p>
    ${field({ id: 'subtractBackground', label: 'Subtract the negative control as background before normalising', type: 'checkbox', value: st.subtractBackground })}
    ${layersShown.filter((l) => (st.layers || []).includes(l.id)).map((l) => `<h3 style="margin:14px 0 4px">${l.no} · ${esc(l.name)}: context</h3><div class="grid g4">${l.context.map((c) => contextField(st, l.id, c, ctx)).join('')}</div>`).join('')}
    <h3 style="margin:14px 0 4px">Linked experiments</h3>
    <div style="display:flex;flex-wrap:wrap;gap:10px">${exps.slice(-60).map((e) => `<label class="inline" style="font-weight:400"><input type="checkbox" data-exp="${esc(e.id)}" style="width:auto" ${(st.experimentIds || []).includes(e.id) ? 'checked' : ''}> ${esc(e.id)} ${esc(e.name || '')}</label>`).join('') || '<span class="muted">No experiments yet.</span>'}</div>
    ${field({ id: 'notes', label: 'Notes', type: 'textarea', value: st.notes, rows: 2 })}
  </div>`;
  const form = body.querySelector('#planForm');
  const read = () => {
    const cur = ctx.store.get('studies', st.id) || st;
    const q = (n) => form.querySelector(`[name="${n}"]`);
    const next = { ...cur, name: q('name').value.trim(), type: q('type').value, date: q('date').value, licence: q('licence').value, notes: q('notes').value, subtractBackground: q('subtractBackground').checked };
    next.layers = LAYERS.filter((l) => q(`layer_${l.id}`)?.checked || (!q(`layer_${l.id}`) && (cur.layers || []).includes(l.id))).map((l) => l.id);
    next.groups = [...form.querySelectorAll('#groupTable tbody tr')].map((tr) => {
      const g = (cur.groups || []).find((x) => x.id === tr.dataset.group) || { id: tr.dataset.group };
      const n = tr.querySelector('[name=g_n]').value;
      return { ...g, name: tr.querySelector('[name=g_name]').value.trim(), role: tr.querySelector('[name=g_role]').value, batchId: tr.querySelector('[name=g_batch]').value.trim() || null, n: n === '' ? null : Number(n) };
    });
    const ref = next.groups.find((g) => g.role === 'reference');
    next.referenceBatchId = ref?.batchId || null;
    next.context = { ...(cur.context || {}) };
    for (const l of LAYERS) for (const [key, , kind] of l.context) {
      if (kind === 'organs') { const boxes = form.querySelectorAll('[data-organ]'); if (boxes.length) next.context[l.id] = { ...(next.context[l.id] || {}), organs: [...boxes].filter((b) => b.checked).map((b) => b.dataset.organ) }; continue; }
      const input = q(`ctx_${l.id}_${key}`);
      if (!input) continue;
      const v = input.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
      next.context[l.id] = { ...(next.context[l.id] || {}), [key]: v };
    }
    next.experimentIds = [...form.querySelectorAll('[data-exp]')].filter((b) => b.checked).map((b) => b.dataset.exp);
    return next;
  };
  const saver = autoSaver(ctx.store, () => { ctx.store.put('studies', read()); });
  body.querySelector('#planSave').innerHTML = saver.html();
  form.addEventListener('input', saver.soon);
  form.addEventListener('change', (e) => {
    saver.now();
    // A role, a layer or the type changes what the plan shows: drawn again once stored.
    if (/^(g_role|type)$|^layer_/.test(e.target.name || '')) redraw();
  });
  body.querySelector('#addGroup').addEventListener('click', () => {
    const cur = read();
    const id = nextGroupId(cur);
    cur.groups.push({ id, name: `Group ${id.slice(1)}`, batchId: null, role: 'test', n: cur.groups[cur.groups.length - 1]?.n ?? (cur.type === 'in vitro' ? 3 : 5) });
    ctx.store.put('studies', cur); redraw();
  });
  body.querySelectorAll('[data-rmgroup]').forEach((b) => b.addEventListener('click', () => {
    const gid = b.dataset.rmgroup;
    if (ctx.store.all('bioMeasurements').some((m) => m.studyId === st.id && m.group === gid)) { toast('This group has values: it is kept. Move its values to another group first.', 'warn'); return; }
    const cur = read(); cur.groups = cur.groups.filter((g) => g.id !== gid); ctx.store.put('studies', cur); redraw();
  }));
}

/* ---------------- choosing a series (shared by typed and imported values) */

/** The read-out a grid or an import writes, from the URL so it survives every redraw. */
function seriesFrom(ctx, st, on) {
  const layers = LAYERS.filter((l) => (st.layers || []).includes(l.id) && on.some((x) => x.id === l.id));
  const p = ctx.params;
  const L = layers.find((l) => l.id === p.layer) || layers[0] || null;
  if (!L) return { layers, L: null };
  const q = L.quantities.find((x) => x.key === p.quantity) || L.quantities[0];
  const organs = L.byOrgan ? (st.context?.biodist?.organs?.length ? st.context.biodist.organs : ['liver']) : [];
  const pops = L.byPopulation ? catalog('population', ctx.store.all('bioCatalog')) : [];
  const ctxTp = st.context?.[L.id]?.timepoint_h;
  return { layers, L, q, organs, pops,
    organ: L.byOrgan ? (organs.includes(p.organ) ? p.organ : organs[0]) : L.id === 'tropism' ? (st.context?.tropism?.organ || '') : '',
    population: L.byPopulation ? (p.population || pops[0]) : '',
    timepoint_h: p.tp !== undefined && p.tp !== '' ? Number(p.tp) : Number.isFinite(ctxTp) ? ctxTp : null,
    view: p.view || '',
    unit: p.unit || q.unit };
}

function seriesPicker(sel, part, st) {
  if (!sel.L) return '<div class="note warn">This study has no layer that is switched on. Choose its layers in the plan.</div>';
  return `<div class="grid g4" id="seriesPick" data-part="${part}">
    ${field({ id: 'sp_layer', label: 'Layer', type: 'select', value: sel.L.id, options: sel.layers.map((l) => ({ value: l.id, label: `${l.no} · ${l.name}` })) })}
    ${field({ id: 'sp_quantity', label: 'Read-out', type: 'select', value: sel.q.key, options: sel.L.quantities.map((q) => ({ value: q.key, label: `${q.label} (${q.unit})` })) })}
    ${sel.L.byOrgan ? field({ id: 'sp_organ', label: 'Organ', type: 'select', value: sel.organ, options: sel.organs }) : ''}
    ${sel.L.byPopulation ? field({ id: 'sp_population', label: 'Cell population', type: 'select', value: sel.population, options: sel.pops }) : ''}
    ${field({ id: 'sp_tp', label: 'Timepoint (h)', type: 'number', value: sel.timepoint_h ?? '' })}
    ${sel.L.id !== 'invitro' ? field({ id: 'sp_view', label: 'View', type: 'select', value: sel.view, options: [{ value: '', label: '–' }, 'dorsal', 'ventral', 'ex vivo'] }) : ''}
    ${field({ id: 'sp_unit', label: 'Unit', type: 'text', value: sel.unit })}
  </div>`;
}
function wireSeriesPicker(body, ctx, st, part) {
  body.querySelector('#seriesPick')?.addEventListener('change', () => {
    const v = (id) => body.querySelector(`#${id}`)?.value;
    const layerChanged = v('sp_layer') !== ctx.params.layer;
    ctx.navigate('studies', { id: st.id, part, layer: v('sp_layer'), quantity: layerChanged ? undefined : v('sp_quantity'), organ: v('sp_organ'), population: v('sp_population'), tp: v('sp_tp'), view: v('sp_view'), unit: layerChanged ? undefined : v('sp_unit') });
  });
}
const seriesOf = (sel) => ({ layer: sel.L.id, quantity: sel.q.key, organ: sel.organ || '', population: sel.population || '', timepoint_h: sel.timepoint_h, view: sel.view || '', unit: sel.unit });

/* ---------------- typed values: a grid, one row per animal or well */

function enterPart(body, ctx, st, on, redraw) {
  const sel = seriesFrom(ctx, st, on);
  if (!sel.L) { body.innerHTML = seriesPicker(sel, 'enter', st); return; }
  const ser = seriesOf(sel);
  const key = seriesKey(ser);
  const have = ctx.store.all('bioMeasurements').filter((m) => m.studyId === st.id && seriesKey(m) === key);
  // The plan's subjects first, then any already stored that the plan does not name.
  const subjects = plannedSubjects(st);
  for (const m of have) if (!subjects.some((s) => s.subject === m.subject)) subjects.push({ group: m.group, subject: m.subject });
  const valueOf = (s) => have.find((m) => m.subject === s.subject)?.value ?? '';
  const groupOpts = (cur) => (st.groups || []).map((g) => `<option value="${esc(g.id)}" ${g.id === cur ? 'selected' : ''}>${esc(g.name || g.id)}</option>`).join('');
  const row = (s) => `<tr><td><select name="e_group" aria-label="Group">${groupOpts(s.group)}</select></td><td><input type="text" name="e_subject" value="${esc(s.subject)}" aria-label="${sel.L.subject === 'well' ? 'Well' : 'Animal'}"></td><td><input type="number" step="any" name="e_value" value="${esc(valueOf(s))}" aria-label="Value"></td></tr>`;
  body.innerHTML = `<div class="card"><h2>Enter values</h2>${seriesPicker(sel, 'enter', st)}
    <p class="muted">One row per ${sel.L.subject === 'well' ? 'well' : 'animal'} of the plan. Type or paste a column of numbers into the first value box: it fills downwards. An emptied value is removed when saved.</p>
    <div style="overflow-x:auto"><table id="enterGrid"><thead><tr><th>Group</th><th>${sel.L.subject === 'well' ? 'Well' : 'Animal'}</th><th>${esc(sel.q.label)} (${esc(ser.unit)})</th></tr></thead><tbody>${subjects.map(row).join('')}</tbody></table></div>
    <p style="display:flex;gap:8px"><button type="button" id="addRow">Add row</button><button type="button" class="primary" id="saveValues">Save values</button></p></div>`;
  wireSeriesPicker(body, ctx, st, 'enter');
  const grid = body.querySelector('#enterGrid tbody');
  // Values typed or pasted and not saved are asked about before leaving (spec 9.1); Save draws the grid again.
  registerDirty(grid, 'values typed into the study grid', () => fieldsChanged(grid, '[name=e_value], [name=e_subject], [name=e_group]'));
  // A pasted column (from Excel) fills the value boxes from the one pasted into, downwards.
  grid.addEventListener('paste', (e) => {
    const t = e.target;
    if (t.name !== 'e_value') return;
    const lines = (e.clipboardData?.getData('text') || '').split(/\r?\n/).map((x) => x.trim()).filter((x) => x !== '');
    if (lines.length < 2) return;
    e.preventDefault();
    const boxes = [...grid.querySelectorAll('[name=e_value]')];
    const at = boxes.indexOf(t);
    lines.forEach((v, k) => { if (boxes[at + k]) boxes[at + k].value = String(Number(v.replace(',', '.'))); });
  });
  body.querySelector('#addRow').addEventListener('click', () => {
    grid.insertAdjacentHTML('beforeend', row({ group: (st.groups || [])[0]?.id, subject: '' }));
  });
  body.querySelector('#saveValues').addEventListener('click', () => {
    const rows = [...grid.querySelectorAll('tr')].map((tr) => ({ group: tr.querySelector('[name=e_group]').value, subject: tr.querySelector('[name=e_subject]').value.trim(), raw: tr.querySelector('[name=e_value]').value }));
    const subjectsSeen = new Set();
    let saved = 0;
    const removed = [];
    ctx.store.transaction(() => {
      for (const r of rows) {
        if (!r.subject) continue;
        if (subjectsSeen.has(r.subject)) { toast(`${r.subject} is listed twice: only the first is kept`, 'warn'); continue; }
        subjectsSeen.add(r.subject);
        const g = (st.groups || []).find((x) => x.id === r.group);
        const m = { studyId: st.id, batchId: g?.batchId || null, group: r.group, subject: r.subject, ...ser };
        const id = measurementId(st.id, m);
        if (r.raw === '' || !Number.isFinite(Number(r.raw))) { if (have.some((x) => x.id === id)) removed.push(id); continue; }
        const old = have.find((x) => x.id === id);
        ctx.store.put('bioMeasurements', { ...(old || {}), ...m, id, value: Number(r.raw), provenance: old?.provenance || provenance('manual') });
        saved++;
      }
    }, { what: 'the values' });
    // Emptied values go to the trash rather than out of existence: a value is evidence (spec 1, "never lose data").
    if (removed.length) ctx.store.moveToTrash(removed.map((id) => ['bioMeasurements', id]), { kind: 'values', label: `${removed.length} value${removed.length === 1 ? '' : 's'} of ${st.id}` });
    toast(`Saved ${saved} value${saved === 1 ? '' : 's'}${removed.length ? `, removed ${removed.length}` : ''}`, 'ok');
    redraw();
  });
}

/* ---------------- plate reader import */

function platePart(body, ctx, st, on, redraw) {
  const sel = seriesFrom(ctx, st, on);
  body.innerHTML = `<div class="card"><h2>Import a plate reader export</h2>${seriesPicker(sel, 'plate', st)}
    <p class="muted">A plate grid (rows A–H, columns 1–12, one block per read) or a long table (a Well column and a value column) as CSV, TSV or text, or pasted from Excel. The plate layout says which group is in which well: paste it as the same grid with the group names (or the formulation ids) in the wells, or let the export's sample column say it. Real exports of the lab's reader are still needed to check this against.</p>
    <div class="grid g2"><div><label for="plateFile">Export file</label><input type="file" id="plateFile" accept=".csv,.tsv,.txt,text/plain"><label for="plateText" style="margin-top:6px">or paste the export</label><textarea id="plateText" rows="6" placeholder="Luminescence&#10;\t1\t2\t3 …&#10;A\t1520\t1610 …"></textarea></div>
      <div><label for="plateLayout">Plate layout (group names in a grid)</label><textarea id="plateLayout" rows="9" placeholder="\t1\t2\t3 …&#10;A\tReference\tReference\tReference …&#10;B\tGroup 2 …"></textarea></div></div>
    <div id="platePreview"></div></div>`;
  if (!sel.L) return;
  wireSeriesPicker(body, ctx, st, 'plate');
  let file = null;
  const preview = async () => {
    const box = body.querySelector('#platePreview');
    const text = file ? file.bytes : body.querySelector('#plateText').value;
    if (!text || (typeof text === 'string' && !text.trim())) { box.innerHTML = ''; return; }
    const read = parsePlate(text);
    if (!read.layout) { box.innerHTML = '<div class="note warn">No plate grid (a header row 1, 2, 3 …) and no Well column found.</div>'; return; }
    const lay = body.querySelector('#plateLayout').value.trim();
    const layoutRead = lay ? parsePlate(lay) : null;
    const layout = layoutRead?.blocks[0] ? Object.fromEntries(Object.entries(layoutRead.blocks[0].wells).map(([w, c]) => [w, c.raw])) : read.samples;
    const blockNo = Math.min(read.blocks.length - 1, Number(body.querySelector('#plateBlock')?.value) || 0);
    const res = plateToMeasurements({ values: read.blocks[blockNo].wells, layout, study: st, series: seriesOf(sel), provenance: provenance('instrument-import', file ? { file: { name: file.name, sha256: file.sha } } : {}) });
    const byGroup = (st.groups || []).map((g) => ({ cells: [g.name || g.id, res.measurements.filter((m) => m.group === g.id).length] }));
    box.innerHTML = `<h3 style="margin:12px 0 4px">Preview</h3>
      <p>${read.layout === 'grid' ? `Plate grid, ${read.blocks.length} block${read.blocks.length === 1 ? '' : 's'}` : 'Long table'}, ${read.wells} wells${read.decimalComma ? ', decimal commas' : ''}. ${Object.keys(layout || {}).length ? '' : '<b>No layout:</b> paste one, or use an export with a sample column.'}</p>
      ${read.blocks.length > 1 ? `<label for="plateBlock">Read</label><select id="plateBlock" style="width:auto">${read.blocks.map((b, i) => `<option value="${i}" ${i === blockNo ? 'selected' : ''}>${esc(b.label)}</option>`).join('')}</select>` : ''}
      ${table(['Group', { label: 'Wells matched', right: true }], byGroup)}
      ${res.unmatched.length ? `<div class="note warn">Names in the layout that match no group: ${res.unmatched.map(esc).join(', ')}. Their wells are not imported. Use the group names of the plan, their ids (G2) or the formulation ids.</div>` : ''}
      <p><button class="primary" id="plateSave" ${res.measurements.length ? '' : 'disabled'}>Import ${res.measurements.length} value${res.measurements.length === 1 ? '' : 's'}</button> <span class="muted">${res.skipped} empty or unnamed well${res.skipped === 1 ? '' : 's'} skipped. A well imported before is replaced.</span></p>`;
    box.querySelector('#plateBlock')?.addEventListener('change', preview);
    box.querySelector('#plateSave')?.addEventListener('click', () => {
      ctx.store.transaction(() => { for (const m of res.measurements) ctx.store.put('bioMeasurements', m); }, { what: 'the plate import' });
      toast(`Imported ${res.measurements.length} values into ${st.id}`, 'ok');
      ctx.navigate('studies', { id: st.id, part: 'results' });
    });
  };
  body.querySelector('#plateFile').addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    file = { name: f.name, bytes, sha: hex(sha256(bytes)) };
    preview();
  });
  body.querySelector('#plateText').addEventListener('input', () => { file = null; preview(); });
  body.querySelector('#plateLayout').addEventListener('input', preview);
}

/* ---------------- results */

function resultsPart(body, ctx, st, ms, on) {
  const onIds = on.map((l) => l.id);
  const norm = normaliseStudy(st, ms.filter((m) => onIds.includes(m.layer)));
  if (!norm.series.length) {
    body.innerHTML = `<div class="card"><h2>No values yet</h2><p class="muted">Enter values in a grid, or import a plate reader export${onIds.some((l) => l !== 'invitro') ? ' or IVIS images' : ''}. <a href="#/studies?id=${esc(st.id)}&part=enter">Enter values</a></p></div>`;
    return;
  }
  const cards = [];
  // Organs side by side (8.4: small multiples), the rest one card per read-out.
  const organSeries = norm.series.filter((s) => s.layer === 'biodist');
  const other = norm.series.filter((s) => s.layer !== 'biodist' && s.layer !== 'tropism');
  for (const s of other) cards.push(seriesCard(st, s));
  if (organSeries.length) cards.push(organCard(st, norm, organSeries));
  const trop = norm.series.filter((s) => s.layer === 'tropism');
  if (trop.length) cards.push(tropismCard(norm, trop));
  body.innerHTML = (norm.warnings.length ? `<div class="note warn">${norm.warnings.map((w) => `<div>${esc(w)}</div>`).join('')}</div>` : '') + cards.join('');
  wireFigures(body);
}

function chartGroups(s, cmp) {
  return s.groups.filter((g) => g.role !== 'negative').map((g, i) => {
    const c = cmp.find((x) => x.group === g.group);
    return { label: g.name, points: g.logs.map((v) => 10 ** v), mean: g.fold, lo: c?.ci?.[0], hi: c?.ci?.[1], n: g.nLog, color: g.role === 'reference' ? 'var(--ink3)' : seriesColor(i), note: c?.star ? `${c.star} (Holm)` : '' };
  });
}

function statsTable(s, cmp) {
  return table(['Group', 'Formulation', { label: 'n', right: true }, 'Raw mean ± SD', 'Fold over reference (95 % CI)', 'p (Welch, Holm)', ''], s.groups.map((g) => {
    const c = cmp.find((x) => x.group === g.group);
    return { cells: [
      raw(`${esc(g.name)} ${g.role === 'reference' ? chip('reference', 'info') : g.role === 'negative' ? chip('negative control') : ''}`),
      g.batchId ? raw(`<a href="#/formulation?batch=${esc(g.batchId)}">${esc(g.batchId)}</a>`) : '–',
      g.n, `${sig(g.rawMean)}${g.rawSd != null ? ` ± ${sig(g.rawSd)}` : ''}`,
      g.role === 'negative' ? 'background' : g.fold == null ? '–' : c?.ci ? `${fmtFold(c.fold)}× (${fmtFold(c.ci[0])}–${fmtFold(c.ci[1])})` : `${fmtFold(g.fold)}×${c?.note ? ` (${c.note})` : ''}`,
      c?.pAdj != null ? (c.pAdj < 0.0001 ? '< 0.0001' : c.pAdj.toFixed(c.pAdj < 0.01 ? 4 : 3)) : '–',
      c?.star || '',
    ] };
  }));
}

function seriesCard(st, s) {
  const cmp = compareToReference(s);
  const svg = foldChart({ groups: chartGroups(s, cmp), title: seriesLabel(s) });
  const bg = s.background ? ` Background: mean of ${s.background.n} negative-control value${s.background.n === 1 ? '' : 's'}, ${sig(s.background.mean)} ${s.unit}${s.background.subtracted ? ', subtracted before normalising' : ', not subtracted'}.` : '';
  return `<div class="card" data-series="${esc(s.key)}"><h2>${esc(layerById[s.layer]?.name || s.layer)} · ${esc(seriesLabel(s))}</h2>
    ${figure(svg, { title: `${seriesLabel(s)}, fold over reference`, caption: `Each point is one ${s.layer === 'invitro' ? 'well' : 'animal'}; bar: geometric mean; whisker: 95 % CI of the fold from Welch's test on log10 values; dashed line: the reference at 1-fold. Stars only where the CI excludes 1-fold, Holm-adjusted over the groups.${bg}`, name: `${st.id}_${s.quantity}${s.organ ? '_' + s.organ : ''}` })}
    ${statsTable(s, cmp)}
    <p class="muted">${cmp.map((c) => esc(c.text)).join(' ')}</p></div>`;
}

function organCard(st, norm, organSeries) {
  const multiples = organSeries.map((s) => {
    const cmp = compareToReference(s);
    return `<div>${figure(foldChart({ groups: chartGroups(s, cmp), title: seriesLabel(s), w: 320, h: 220 }), { title: seriesLabel(s), name: `${st.id}_${s.organ || s.quantity}` })}</div>`;
  }).join('');
  // Ratios to every other organ measured, the liver first as the numerator when it is there (8.4: liver to spleen).
  const organs = [...new Set(organSeries.map((s) => s.organ).filter(Boolean))];
  const num = organs.includes('liver') ? 'liver' : organs[0];
  const quantity = organSeries.find((s) => s.organ === num)?.quantity;
  const ratios = organs.filter((o) => o !== num).map((den) => ({ den, rows: organRatios(norm, { num, den, quantity }) })).filter((r) => r.rows.length);
  const rTable = ratios.length ? table(['Ratio', 'Group', { label: 'n', right: true }, 'Geometric mean'], ratios.flatMap((r) => r.rows.map((x) => ({ cells: [`${num} : ${r.den}`, x.name, x.n, `${fmtFold(x.ratio)} : 1`] })))) : '<p class="muted">Ratios need two organs measured in the same animals.</p>';
  return `<div class="card" id="organCard"><h2>Organs</h2><div class="grid g2">${multiples}</div><h3 style="margin:12px 0 4px">Organ ratios, per animal</h3>${rTable}</div>`;
}

function tropismCard(norm, trop) {
  const shares = tropismShares(norm);
  const svg = stackedShares({ bars: shares.map((g) => ({ label: g.name, parts: g.parts.map((p) => ({ name: p.population, share: p.share })) })), title: 'Cell tropism' });
  const names = [...new Set(shares.flatMap((g) => g.parts.map((p) => p.population)))];
  const rows = trop.map((s) => ({ s, cmp: compareToReference(s) }));
  return `<div class="card" id="tropismCard"><h2>Cell tropism</h2>
    ${figure(svg, { title: 'Share of the positive cells per population', caption: 'Each bar is a group; the parts are the populations\' mean % positive, as shares of their sum.', name: 'tropism', legendItems: names.map((n, i) => ({ name: n, color: seriesColor(i) })) })}
    ${rows.map(({ s, cmp }) => `<h3 style="margin:10px 0 4px">${esc(seriesLabel(s))}</h3>${statsTable(s, cmp)}`).join('')}</div>`;
}

