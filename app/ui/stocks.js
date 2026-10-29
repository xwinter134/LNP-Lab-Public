// Screen: Lipid stocks — plan a weigh-in, record actual weights, compute ethanol, save as a stock lot, print worksheet.
import { html, raw, fmt, field, readForm, table, chip, toast, printHtml, header, todayISO, addDays, fmtDate, esc, swapHtml, redrawSoon, autoSaver, sharedRecord, readDraft, writeDraft, dropDraft, uid, ask } from './kit.js';
import { getRef, getSettings, compositionLabel, latestLipidLot } from '../refdata.js';
import { lipidClassChip } from './lipidclass.js';
import { nextStockId, usedIds, raiseCounter } from '../schema.js';
import { planLipidStock, reconcileLipidStock, massFractions } from '../calc/lipid_stock.js';
import { withThaw, thawedOn, ftWords, ftTag, tracksThaw } from '../calc/freezethaw.js';
import { thawPanel, thawChip, wireThaw } from './thaw.js';

// The drafts whose "Create stock" is being stored: not a stock still to create, so not offered back meanwhile.
const storing = new Set();
const notStoring = (d) => (d && storing.has(d.draftId) ? null : d);

export async function render(el, ctx) {
  const ref = getRef(ctx), settings = getSettings(ctx);
  const editing = ctx.params.id ? ctx.store.get('stocks', ctx.params.id) : null;
  const showForm = !!(ctx.params.new || editing);

  el.innerHTML = header('Run', 'Lipid stocks', `<a class="btn primary" href="#/stocks?new=1">New stock</a>`) +
    `<div id="stockDraft"></div><div id="stockEditor"></div>
     <div class="card"><h2>Stock lots</h2><div id="stockList"></div></div>`;
  const listBox = el.querySelector('#stockList');
  // "Thawed today" in the list. The stock open in the form above goes through the form, which stores it as
  // it is edited and would otherwise write its own copy, without the thaw, over the one stored here.
  let thawOpenStock = null; // set by the form of a stock on record
  listBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-thaw-stock]');
    if (!b) return;
    const id = b.dataset.thawStock;
    if (thawOpenStock && editing?.id === id) { thawOpenStock(); return; }
    const s = ctx.store.get('stocks', id);
    if (!s) return;
    const next = withThaw(s, { operator: settings.operator });
    ctx.store.put('stocks', next);
    toast(`${id}: ${ftWords(next)}`, 'ok');
    renderList();
  });

  renderList();
  // The draft of a new stock is offered back wherever the form is not already showing it.
  if (!(showForm && renderEditor(editing))) offerDraft(showForm && !editing);

  // Read from the store each time: an open stock is stored as it is edited, and the list shows what is stored.
  function renderList() {
    if (!listBox.isConnected) return;
    const today = todayISO();
    const stocks = ctx.store.all('stocks').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const limit = getSettings(ctx).ftWarnCycles;
    listBox.innerHTML = table(
      ['Lot', 'Composition', { label: 'mM', right: true }, { label: 'mL', right: true }, { label: 'mg/mL', right: true }, 'Date', 'Status', 'Expiry', 'Freeze–thaw', ''],
      stocks.map((s) => {
        const exp = s.expiry ? (s.expiry < today ? chip('expired', 'warn') : s.expiry <= addDays(today, 7) ? chip('expires ' + fmtDate(s.expiry), 'warn') : chip(fmtDate(s.expiry))) : '';
        return { attrs: `data-stock="${esc(s.id)}"`, cells: [raw(`<a href="#/stocks?id=${s.id}"><b>${s.id}</b></a>`), `#${s.compositionId} ${s.name || ''}`, fmt(s.molarity_mM, 1), fmt(s.volume_mL, 1), fmt(s.lipidMgPerMl, 1), fmtDate(s.date), raw(chip(s.status, s.status === 'made' ? 'ok' : 'info')), raw(exp),
          raw(`${thawChip(s, limit) || '<span class="muted">0</span>'} <button type="button" class="ghost thawRow" data-thaw-stock="${esc(s.id)}" title="Log a freeze–thaw cycle of ${esc(s.id)}, today"${thawedOn(s, today) ? ' disabled' : ''}>${thawedOn(s, today) ? 'thawed today' : 'Thawed today'}</button>`),
          raw(`<a href="#/stocks?id=${s.id}">Open</a>`)] };
      }),
      { empty: 'No stock lots yet. Click "New stock".' });
  }

  /**
   * A note above the form: a new stock was started and not created, with the way back to it. Above a new
   * form (`replaced`), what is typed there becomes the draft in its place, and the note says so.
   */
  function offerDraft(replaced) {
    const d = readDraft(ctx, 'stock'), box = el.querySelector('#stockDraft');
    if (!d?.state || storing.has(d.draftId) || !box) return;
    const st = d.state, comp = ref.compositionById[st.compositionId];
    const keys = Object.keys(st.molPct || {}), weighed = keys.filter((k) => st.actual?.[k] != null).length;
    const what = `#${st.compositionId}${comp?.synonym ? ' ' + comp.synonym : ''} · ${fmt(st.molarity_mM, 1)} mM · ${fmt(st.volume_mL, 1)} mL${weighed ? ` · ${weighed} of ${keys.length} lipids weighed` : ''}`;
    box.innerHTML = `<div class="note" id="stockDraftNote">A new stock you started has not been created yet: ${esc(what)}.${replaced ? ' Anything typed below takes its place.' : ''}
      <a class="btn" href="#/stocks?new=1&draft=1" id="stockDraftOpen">Continue it</a> <button type="button" id="stockDraftDrop">Discard it</button></div>`;
    box.querySelector('#stockDraftDrop').addEventListener('click', () => { dropDraft(ctx, 'stock'); box.innerHTML = ''; });
  }

  /** The form, for a stock on record or a new one. Returns true when it is going on with the draft of a new stock. */
  function renderEditor(stock) {
    const state = stock ? JSON.parse(JSON.stringify(stock)) : {
      compositionId: ref.compositions[ref.compositions.length - 1]?.id, molPct: null, molarity_mM: settings.defaultLipidStock_mM,
      volume_mL: settings.defaultStockVolume_mL, date: todayISO(), operator: settings.operator, actual: {}, lots: {},
      container: '100 mL glass vial', filter: 'PES 0.2 µm syringe filter', notes: '',
    };
    // A formulation record can hand over the recipe it is actually made from — a DoE run that moved the PEG,
    // with the cholesterol rebalanced (calc/composition.js) — and the weigh-in then starts from that rather
    // than from the registry entry it descends from. Saving records it as a custom composition, as an edit by
    // hand would be.
    const handed = !stock ? handedRecipe(ctx.params) : null;
    let fromRecord = !!handed;
    if (handed) {
      if (ref.compositionById[handed.compositionId]) state.compositionId = handed.compositionId;
      state.molPct = handed.molPct;
    }
    // What was typed into a new stock and not created is offered back (usability cycle 5, K6): the note above
    // the form leads here with draft=1, and the form then starts from it.
    const draft = !stock && !handed && ctx.params.draft ? notStoring(readDraft(ctx, 'stock')) : null;
    if (draft?.state) { Object.assign(state, draft.state); fromRecord = !!draft.fromRecord; }
    const recipeHanded = !!handed || !!draft?.fromRecord;
    // A stock on record is stored as it is edited, onto the stock as it is stored (another window may have it
    // open too); a new one is kept as a draft until "Create stock", under this form's own id.
    const shared = stock ? sharedRecord(ctx.store, 'stocks', state) : null;
    const saver = stock ? autoSaver(ctx.store, persist) : null;
    let status = stock?.status;
    const draftId = draft?.draftId || uid();
    const keep = () => writeDraft(ctx, 'stock', { state, fromRecord, draftId });
    let creating = false; // while "Create stock" is being stored
    if (!state.molPct) state.molPct = { ...(ref.compositionById[state.compositionId]?.mol_pct || {}) };
    state.actual = state.actual || {}; state.lots = state.lots || {};
    const sinceNote = draft?.state ? sinceDrafted() : '';
    const box = el.querySelector('#stockEditor');

    /**
     * A draft is continued as it would be made today: a date that has passed becomes today (a typed expiry
     * moves with it, keeping its shelf life), and a lot or a composition that is no longer on record is not
     * stored under its old id while the form shows something else. Returns what it changed, or ''.
     */
    function sinceDrafted() {
      const said = [];
      for (const [k, id] of Object.entries(state.lots)) if (id && !ref.lipidLots.some((x) => x.id === id)) { delete state.lots[k]; said.push('a lipid lot it named is no longer on record and is left out'); }
      if (!ref.compositionById[state.compositionId]) {
        const now = ref.compositions[ref.compositions.length - 1]?.id;
        said.push(`composition #${state.compositionId} is no longer on record, so the weigh-in is for #${now}`);
        fromRecord = false;
        recipe(now);
      }
      const today = todayISO(), was = state.date;
      if (was && was < today) {
        if (state.expiry) state.expiry = addDays(state.expiry, Math.round((Date.parse(today) - Date.parse(was)) / 864e5));
        state.date = today;
        said.push(`its date, ${fmtDate(was)}, has passed and is today now`);
      }
      return said.length ? [...new Set(said)].join('; ').replace(/^./, (c) => c.toUpperCase()) + '.' : '';
    }

    /** Take composition `id` and its recipe; the masses weighed for lipids that are not in it go. */
    function recipe(id) {
      state.compositionId = id;
      state.molPct = { ...(ref.compositionById[id]?.mol_pct || {}) };
      for (const k of Object.keys(state.actual)) if (!(k in state.molPct)) delete state.actual[k];
    }

    function compute() {
      const lipidsIn = Object.fromEntries(Object.keys(state.molPct).map((k) => {
        const l = ref.lipidByKey[k] || { name: k, mw: null };
        // A lot deleted since is read from the copy the stock kept of it, so its purity, and the masses, stay.
        const lot = state.lots[k] ? ref.lipidLots.find((x) => x.id === state.lots[k]) || state.lotRecords?.[state.lots[k]] || null : latestLipidLot(ref, k);
        return [k, { name: l.name, mw: l.mw, lot }];
      }));
      try {
        const plan = planLipidStock({ molPct: state.molPct, lipids: lipidsIn, molarity_mM: state.molarity_mM || 0, volume_mL: state.volume_mL || 0 });
        const rec = reconcileLipidStock(plan, state.actual, state.volume_mL || 0);
        return { plan, rec, lipidsIn, err: null };
      } catch (e) { return { plan: null, rec: null, lipidsIn, err: e.message }; }
    }

    function draw() {
      const comp = ref.compositionById[state.compositionId];
      const { plan, rec, lipidsIn, err } = compute();
      const limit = settings.ftWarnCycles;
      // A composition deleted under Materials since: the stock keeps its mol% and still names it, marked so.
      const compOptions = [...ref.compositions.map((c) => ({ value: c.id, label: compositionLabel(c, ref) })),
        ...(comp ? [] : [{ value: state.compositionId, label: `#${state.compositionId} (deleted; this stock keeps its recipe)` }])];
      // One card per lipid rather than a wide table. At a balance you read one number, weigh it, type what
      // the balance said, and move on; a row of ten columns makes you find that number again each time.
      const cards = plan ? plan.rows.map((r) => {
        const lotsFor = ref.lipidLots.filter((x) => x.lipidKey === r.key);
        const a = rec.rows.find((x) => x.key === r.key);
        const dev = a?.deviationPct;
        const devClass = dev == null ? '' : Math.abs(dev) > 2 ? 'dev warn' : 'dev ok';
        // A lot deleted under Materials since: the copy this stock kept of it (stock.lotRecords).
        const gone = state.lots[r.key] && !lotsFor.some((x) => x.id === state.lots[r.key]) ? state.lotRecords?.[state.lots[r.key]] || null : null;
        // A lot of a lipid kept frozen in aliquots (Materials › Lipids & lots, "track"): weighing from it is a
        // thaw, which the card offers to log, with the count so far.
        const tracked = tracksThaw(ref.lipidByKey[r.key]);
        const chosen = tracked && lipidsIn[r.key].lot && !gone ? ctx.store.get('lipidLots', lipidsIn[r.key].lot.id) : null;
        const lotThaw = chosen ? `<div class="wcThaw" data-lot-thaw-of="${esc(chosen.id)}">${thawChip(chosen, limit) || '<span class="muted">0 F/T</span>'} ${thawedOn(chosen, todayISO())
          ? '<span class="muted">thaw logged today</span>'
          : `<button type="button" class="ghost" data-lotthaw="${esc(chosen.id)}" title="Log a freeze–thaw cycle of lot ${esc(chosen.lot)}: it was thawed for this weigh-in">Log thaw of ${esc(chosen.lot)}</button>`}</div>` : '';
        return `<div class="weighCard" data-key="${r.key}">
          <div class="wcHead"><b>${esc(r.name)}</b><span class="wcClass">${lipidClassChip(ref.lipidByKey[r.key]?.class)}</span></div>
          <div class="wcPct"><input type="number" step="0.1" name="pct_${r.key}" value="${r.pct}" class="advanced"><span class="simpleOnly">${pctText(r.pct)}</span> mol% · ${fmt(r.mw, 2)} g/mol</div>
          <div class="wcTarget">${fmt(r.weighG, 4)}<span>g</span></div>
          <div class="wcMmol">${fmt(r.mmol, 4)} mmol</div>
          <label class="wcActual">weighed
            <input type="number" step="0.00001" name="actual_${r.key}" value="${state.actual[r.key] ?? ''}" placeholder="g">
          </label>
          <div class="${devClass}" data-dev="${r.key}">${dev == null ? '&nbsp;' : `${dev > 0 ? '+' : ''}${fmt(dev, 1)} % · ${fmt(a.mmolActual, 4)} mmol`}</div>
          <div class="wcLot">${lotsFor.length || gone
            ? `<select name="lot_${r.key}"><option value="">no lot recorded</option>${lotsFor.map((x) => `<option value="${x.id}" ${lipidsIn[r.key].lot?.id === x.id ? 'selected' : ''}>${esc(x.lot)}${tracked ? esc(ftTag(ctx.store.get('lipidLots', x.id) || x, limit)) : ''}</option>`).join('')}${gone ? `<option value="${esc(gone.id)}" selected>${esc(gone.lot)} (deleted)</option>` : ''}</select>`
            : '<span class="muted">no lot recorded</span>'}</div>
          ${lotThaw}
        </div>`;
      }).join('') : '';
      // A lipid at 0 mol% (one just added with "Add lipid row") has nothing to weigh, so the plan has no row for
      // it, and it used to get no card: nowhere to type the mol% that would give it one (usability cycle 6, I10).
      // Its card holds only that mol%; once it is above 0 the lipid is weighed like the others.
      const unweighed = plan ? Object.keys(state.molPct).filter((k) => !(state.molPct[k] > 0)).map((k) => `<div class="weighCard advanced" data-key="${esc(k)}">
          <div class="wcHead"><b>${esc(ref.lipidByKey[k]?.name || k)}</b><span class="wcClass">${lipidClassChip(ref.lipidByKey[k]?.class)}</span></div>
          <div class="wcPct"><input type="number" step="0.1" min="0" name="pct_${esc(k)}" value="${state.molPct[k] ?? 0}" aria-label="${esc(ref.lipidByKey[k]?.name || k)} mol%"> mol% · ${fmt(ref.lipidByKey[k]?.mw, 2)} g/mol</div>
          <div class="muted">Give it a mol% to weigh it in. The other lipids keep theirs, so lower one of them to bring the total back to 100 %.</div>
        </div>`).join('') : '';

      const summary = plan ? `
        <div class="wcAfter" id="wcAfter">
          <div class="wcStep"><span class="n">1</span><div><b>Weigh</b><div class="muted">${plan.rows.length} lipids · ${fmt(plan.totalMmol, 4)} mmol · ${fmt(plan.weighTotalG, 4)} g total</div></div></div>
          <div class="wcStep ${rec.complete ? '' : 'pending'}"><span class="n">2</span><div><b>Add ethanol</b><div class="muted">${rec.complete ? `${fmt(rec.ethanolG, 3)} g = ${fmt(rec.ethanolMl, 2)} mL` : 'enter every weighed mass first'}</div></div></div>
          <div class="wcStep ${rec.complete ? '' : 'pending'}"><span class="n">3</span><div><b>Result</b><div class="muted">${rec.complete ? `${fmt(rec.finalVolumeMl, 2)} mL at ${fmt(rec.molarity_mM, 2)} mM · ${fmt(plan.lipidMgPerMl, 2)} mg/mL` : `target ${fmt(plan.lipidMgPerMl, 2)} mg/mL`}</div></div></div>
        </div>
        ${plan.warnings.map((w) => `<div class="note warn">${w}</div>`).join('')}
        <div class="advanced"><h2 style="margin-top:12px">Mass fractions (for HPLC lipid content)</h2>${table(['Lipid', { label: 'w/w %', right: true }], plan.rows.map((r) => ({ cells: [r.name, fmt(massFractions(plan)[r.key] * 100, 2)] })))}</div>` : `<div class="note warn">${err}</div>`;

      // Through swapHtml: the user is usually in a field of this form when it is rebuilt, and must stay there.
      if (!swapHtml(box, html`<div class="card" id="stockForm">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="flex:1">${stock ? 'Stock ' + stock.id : 'New stock'}</h2>
          ${stock ? raw(chip(status, status === 'made' ? 'ok' : 'info')) : ''}</div>
        ${stock ? raw(thawPanel(state, { key: 'stock', limit, operator: settings.operator, title: 'Freeze–thaw of this stock' })) : ''}
        ${draft?.state ? raw(`<div class="note" id="stockDraftOn" style="margin-top:8px">You are going on with the new stock you started${draftTime(draft)}.${sinceNote ? ' ' + esc(sinceNote) : ''} It is created when you press “Create stock”. <button type="button" id="stockDraftFresh">Start afresh</button></div>`) : ''}
        <div class="grid g4">
          ${raw(field({ id: 'compositionId', label: 'Composition', type: 'select', value: state.compositionId, options: compOptions }))}
          ${raw(field({ id: 'molarity_mM', label: 'Total lipid (mM)', value: state.molarity_mM, step: 0.1 }))}
          ${raw(field({ id: 'volume_mL', label: 'Volume (mL)', value: state.volume_mL, step: 0.5 }))}
          ${raw(field({ id: 'date', label: 'Date', type: 'date', value: state.date }))}
          ${raw(field({ id: 'operator', label: 'Operator', type: 'text', value: state.operator }))}
          ${raw(field({ id: 'container', label: 'Container', type: 'text', value: state.container, advanced: true }))}
          ${raw(field({ id: 'filter', label: 'Filtration', type: 'text', value: state.filter, advanced: true }))}
          ${raw(field({ id: 'expiry', label: 'Expiry', type: 'date', value: state.expiry || addDays(state.date || todayISO(), settings.stockExpiryDays), advanced: true }))}
        </div>
        ${recipeHanded && fromRecord ? raw(`<div class="note" style="margin-top:10px">This weigh-in is the recipe a formulation record handed over, not the registry recipe for #${esc(String(state.compositionId))}: ${Object.entries(state.molPct).map(([k, v]) => `${esc(ref.lipidByKey[k]?.name || k)} ${pctText(v)}`).join(' · ')} mol%. It is saved as a custom composition.</div>`) : ''}
        <p class="muted advanced" style="margin:8px 0 0">Advanced: mol% is editable per card; a changed composition is saved with the stock. ${raw(addLipidMenu())}</p>
        <div class="weighGrid">${raw(cards + unweighed)}</div>
        ${raw(summary)}
        ${raw(field({ id: 'notes', label: 'Notes', type: 'textarea', value: state.notes, rows: 2 }))}
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          ${stock ? raw(saver.html()) : raw(`<button class="primary" id="saveStock" ${creating ? 'disabled' : ''}>${creating ? 'Creating …' : 'Create stock'}</button>`)}
          <button id="printStock">Print weigh-in worksheet</button>
          ${stock ? raw('<button id="deleteStock" style="margin-left:auto;color:var(--warn)">Delete</button>') : ''}
        </div>
      </div>`)) return;
      ensureStyle();
      const form = box.querySelector('#stockForm');
      form.addEventListener('input', onInput);
      form.addEventListener('change', onInput);
      form.querySelector('#saveStock')?.addEventListener('click', save);
      form.querySelector('#stockDraftFresh')?.addEventListener('click', () => { dropDraft(ctx, 'stock'); ctx.navigate('stocks', { new: 1 }); });
      form.querySelector('#printStock').addEventListener('click', () => print(comp));
      form.querySelector('#addLipid')?.addEventListener('change', (e) => addLipidRow(e.target.value));
      // Deleting goes to the trash, with an Undo on the note (see Settings › Recently deleted). The formulations
      // that used the stock keep its id, shown as deleted, and their own lipid concentration, so a stock they
      // name is asked about first.
      form.querySelector('#deleteStock')?.addEventListener('click', async () => {
        const users = ctx.store.all('batches').filter((b) => b.stockId === stock.id).map((b) => b.id);
        if (users.length && !(await ask(`${stock.id} is the lipid stock of ${users.length} formulation${users.length === 1 ? '' : 's'} (${users.slice(0, 6).join(', ')}${users.length > 6 ? ` and ${users.length - 6} more` : ''}).\n\nThey keep "${stock.id}" as text, shown as deleted, and the lipid concentration on their own record, so nothing they calculate changes. Delete ${stock.id}?`))) return;
        const entry = ctx.store.moveToTrash([['stocks', stock.id]], { kind: 'stock', label: `${stock.id} · composition #${stock.compositionId ?? '?'}` });
        if (entry) toast(`Deleted ${stock.id}`, '', { action: 'Undo', onAction: () => {
          const r = ctx.store.restoreFromTrash(entry.id);
          if (!r.ok) { toast(`Not restored: ${r.reason}`, 'warn'); return; }
          toast(`Restored ${stock.id}`, 'ok'); ctx.navigate('stocks', { id: stock.id });
        } });
        ctx.navigate('stocks');
      });
    }

    function ensureStyle() {
      if (document.getElementById('simpleOnlyStyle')) return;
      const s = document.createElement('style'); s.id = 'simpleOnlyStyle';
      s.textContent = 'body.mode-advanced .simpleOnly{display:none} input.advanced{display:none} body.mode-advanced input.advanced{display:inline-block;width:70px}';
      document.head.appendChild(s);
    }

    // A change arrives as the user leaves a field, on the way to the next one: redraw once they are there.
    const redraw = () => redrawSoon(box, draw);

    // Stored at once when a field is left, once typing pauses while in it.
    function onInput(e) {
      if (/^thaw_/.test(e.target.name || '')) return; // the freeze–thaw fold's own fields, read when its button is pressed
      if (e.target.name === 'compositionId') { if (e.type === 'change') chooseComposition(e.target); return; }
      apply(e);
      if (!e.target.name) return;
      if (saver) { if (e.type === 'change') saver.now(); else saver.soon(); } else keep();
    }

    /**
     * Another composition chosen. The masses weighed for lipids that are in both recipes stay: they are what the
     * balance said, whatever the stock is called, and choosing the first composition again gives the stock back
     * as it was. Masses of lipids the new recipe lacks would be discarded, and on a stock on record that is
     * stored at once, so that is asked first; the select stays as it was until the answer is yes. Through ask(),
     * since the macOS app's confirm() answers with a promise where a browser's answers at once.
     */
    async function chooseComposition(select) {
      const id = Number(select.value), next = ref.compositionById[id]?.mol_pct || {};
      const lost = Object.keys(state.actual).filter((k) => state.actual[k] != null && !(k in next));
      if (lost.length) {
        select.value = String(state.compositionId);
        const name = (k) => ref.lipidByKey[k]?.name || k;
        const ok = await ask(`Composition #${id} has no ${lost.map(name).join(' or ')}. The ${lost.length === 1 ? 'mass' : 'masses'} weighed for this stock (${lost.map((k) => `${name(k)} ${fmt(state.actual[k], 4)} g`).join(', ')}) would be discarded. Change the composition to #${id}?`);
        if (!ok || !box.isConnected) return;
      }
      fromRecord = false;
      recipe(id);
      redraw();
      if (saver) saver.now(); else keep();
    }

    function apply(e) {
      const t = e.target; if (!t.name) return;
      const v = t.type === 'number' ? (t.value === '' ? null : Number(t.value)) : t.value;
      if (t.name.startsWith('pct_')) { state.molPct[t.name.slice(4)] = v ?? 0; if (e.type === 'change') redraw(); return; }
      if (t.name.startsWith('lot_')) { if (e.type !== 'change') return; const k = t.name.slice(4); state.lots[k] = v || null; redraw(); return; }
      // Entering a mass updates the deviations and the ethanol, but must not rebuild the form: redrawing
      // destroys the field that was just left, and anything quicker than deliberate typing — a paste, an
      // autofill, tabbing fast — can lose the value with it. Patch the derived parts in place instead.
      if (t.name.startsWith('actual_')) { const k = t.name.slice(7); if (v == null) delete state.actual[k]; else state.actual[k] = v; refreshDerived(); return; }
      state[t.name] = v;
      // The date too: an expiry not typed in follows it, and the field should show the one that is stored.
      if (['molarity_mM', 'volume_mL', 'date'].includes(t.name) && e.type === 'change') redraw();
    }

    /** Recompute the deviations and the three steps from the masses entered, leaving every input alone. */
    function refreshDerived() {
      const { plan, rec } = compute();
      if (!plan) return;
      for (const r of plan.rows) {
        const cell = box.querySelector(`[data-dev="${r.key}"]`);
        if (!cell) continue;
        const a = rec.rows.find((x) => x.key === r.key);
        const dev = a?.deviationPct;
        cell.className = dev == null ? '' : Math.abs(dev) > 2 ? 'dev warn' : 'dev ok';
        cell.innerHTML = dev == null ? '&nbsp;' : `${dev > 0 ? '+' : ''}${fmt(dev, 1)} % · ${fmt(a.mmolActual, 4)} mmol`;
      }
      const after = box.querySelector('#wcAfter');
      if (!after) return;
      const steps = after.querySelectorAll('.wcStep');
      if (steps[1]) {
        steps[1].classList.toggle('pending', !rec.complete);
        steps[1].querySelector('.muted').textContent = rec.complete ? `${fmt(rec.ethanolG, 3)} g = ${fmt(rec.ethanolMl, 2)} mL` : 'enter every weighed mass first';
      }
      if (steps[2]) {
        steps[2].classList.toggle('pending', !rec.complete);
        steps[2].querySelector('.muted').textContent = rec.complete
          ? `${fmt(rec.finalVolumeMl, 2)} mL at ${fmt(rec.molarity_mM, 2)} mM · ${fmt(plan.lipidMgPerMl, 2)} mg/mL`
          : `target ${fmt(plan.lipidMgPerMl, 2)} mg/mL`;
      }
    }

    // A menu of the lipids not yet in the recipe, not prompt(): the macOS app's window shows no prompt() and
    // answers null at once, so a lipid could never be added there.
    function addLipidMenu() {
      const free = ref.lipids.filter((l) => !(l.key in state.molPct));
      return free.length ? `<select id="addLipid" aria-label="Add lipid row" style="width:auto"><option value="">Add lipid row …</option>${free.map((l) => `<option value="${esc(l.key)}">${esc(l.name)}</option>`).join('')}</select>` : '';
    }

    function addLipidRow(key) {
      if (!key || !ref.lipidByKey[key] || key in state.molPct) return;
      state.molPct[key] = 0; if (saver) saver.now(); else keep(); redraw();
    }

    /**
     * The stock as it is to be stored; null while the composition cannot be planned. From the state, which every
     * field writes as it is typed, rather than from the form: the state may also hold what another window stored
     * a moment ago, which the form shows only once it is drawn again.
     */
    function record(comp) {
      const { plan, rec } = compute();
      if (!plan) return null;
      return {
        ...state, name: comp?.synonym || '', expiry: state.expiry || addDays(state.date || todayISO(), settings.stockExpiryDays),
        customComposition: JSON.stringify(state.molPct) !== JSON.stringify(comp?.mol_pct || {}),
        rows: plan.rows.map((r) => ({ key: r.key, name: r.name, pct: r.pct, mw: r.mw, lotId: state.lots[r.key] || null, weighG: r.weighG, actualG: state.actual[r.key] ?? null })),
        totalMmol: plan.totalMmol, lipidMgPerMl: plan.lipidMgPerMl,
        ethanolG: rec.complete ? rec.ethanolG : null, ethanolMl: rec.complete ? rec.ethanolMl : null, finalVolumeMl: rec.complete ? rec.finalVolumeMl : null,
        molarityActual_mM: rec.complete ? rec.molarity_mM : null, status: rec.complete ? 'made' : 'planned',
      };
    }

    /** A stock on record, stored as it is edited: what was changed here, over the stock as it is stored now. */
    function persist() {
      if (!shared.take()) return `${stock.id} was moved to the trash, here or in another window`;
      const r = record(ref.compositionById[state.compositionId]);
      if (!r) return 'fix the composition first';
      ctx.store.put('stocks', r);
      shared.stored();
      status = r.status;
      renderList();
    }
    // Another window stored this stock: show it as stored, with anything still being typed here laid over it.
    shared?.watch(() => box.isConnected, (now) => {
      if (!now || !shared.take()) { saver.now(); return; } // says it is not saved, and why
      status = state.status;
      saver.note('Changed in another window: shown as stored there');
      renderList(); redraw();
    });

    /**
     * "Create stock": the new stock is numbered and stored, and then its draft goes and the stock opens. As the
     * experiment wizard does: until the write is stored the button says so and does nothing more, and when the
     * browser refuses it (a full disk) the store undoes it and the form stays, with its draft, to press again.
     */
    function save() {
      if (creating) return;
      const comp = ref.compositionById[state.compositionId];
      const r = record(comp);
      if (!r) { toast('Fix the composition first', 'warn'); return; }
      // Past every stock id still named anywhere: a deleted stock's id stays on the formulations made from it.
      r.id = nextStockId(usedIds(ctx.store, 'stock'));
      busy(true);
      // While it is being stored its draft is not offered back, and the stock opens only for a user still on
      // this form; one who has moved on is told where it is (usability cycle 6, W6).
      storing.add(draftId);
      ctx.store.transaction(() => {
        ctx.store.put('stocks', r);
        raiseCounter(ctx.store, 'stock', r.id);
      }, {
        what: `the new stock ${r.id}`, again: 'Create stock',
        onSaved: () => {
          storing.delete(draftId);
          dropDraft(ctx, 'stock', draftId);
          if (box.isConnected) { toast(`Saved stock ${r.id}`, 'ok'); ctx.navigate('stocks', { id: r.id }); }
          else toast(`Saved stock ${r.id}`, 'ok', { action: 'Open', onAction: () => ctx.navigate('stocks', { id: r.id }) });
        },
        onUndone: () => { storing.delete(draftId); busy(false); return box.isConnected; },
      });
    }
    // Kept in `creating` as well as on the button, which a redraw meanwhile (a field left by pressing it) rebuilds.
    function busy(on) {
      creating = on;
      const b = box.querySelector('#saveStock');
      if (b) { b.disabled = on; b.textContent = on ? 'Creating …' : 'Create stock'; }
    }

    function print(comp) {
      const { plan } = compute();
      if (!plan) return;
      const f = readForm(box);
      const body = `<h1>Lipid stock weigh-in · ${state.id || 'new'}</h1>
        <div class="muted">Composition #${state.compositionId} ${comp?.synonym || ''} · ${fmt(state.molarity_mM, 1)} mM · ${fmt(state.volume_mL, 1)} mL · ${f.date} · operator ${f.operator}</div>
        <h2>Weigh-in</h2><table><tr><th>Lipid</th><th>Lot</th><th class="r">mol%</th><th class="r">MW</th><th class="r">mmol</th><th class="r">Target g</th><th>Actual g</th></tr>
        ${plan.rows.map((r) => `<tr><td>${r.name}</td><td>${state.lots[r.key] ? (ref.lipidLots.find((x) => x.id === state.lots[r.key])?.lot || '') : '<span class="blank"></span>'}</td><td class="r">${pctText(r.pct)}</td><td class="r">${fmt(r.mw, 2)}</td><td class="r">${fmt(r.mmol, 4)}</td><td class="r"><b>${fmt(r.weighG, 4)}</b></td><td><span class="blank" style="min-width:90px"></span></td></tr>`).join('')}
        <tr><th colspan="5">Total</th><th class="r">${fmt(plan.weighTotalG, 4)}</th><th></th></tr></table>
        <h2>Ethanol</h2><p>Pre-warm absolute ethanol in the water bath. Ethanol to add (g) = (Σ actual mmol / ${fmt(plan.totalMmol, 4)} mmol × ${fmt(state.volume_mL, 1)} mL × 0.79 g/mL) − Σ actual g. Add to the lipids and mix 1–3 h at 35 °C.</p>
        <table><tr><th>Ethanol lot</th><th>Ethanol weighed (g)</th><th>Mixing time (h)</th><th>Filtration</th><th>Container</th></tr><tr><td><span class="blank"></span></td><td><span class="blank"></span></td><td><span class="blank"></span></td><td>${f.filter ?? state.filter}</td><td>${f.container ?? state.container}</td></tr></table>
        <p class="muted">Expected lipid content ${fmt(plan.lipidMgPerMl, 1)} mg/mL</p>
        <div class="sig"><div>Date / signature operator</div><div>Date / signature review</div></div>`;
      printHtml(`Weigh-in ${state.id || ''}`, body);
    }

    // The stock's own freeze–thaw panel: a thaw is part of the stock, stored as everything else on it is.
    if (stock) {
      const setThaws = (next) => { state.thaws = next.thaws; saver.now(); toast(`${stock.id}: ${ftWords(state)}`, 'ok'); redraw(); };
      wireThaw(box, 'stock', { get: () => state, set: setThaws, operator: settings.operator });
      thawOpenStock = () => setThaws(withThaw(state, { operator: settings.operator }));
    }
    // A lot of a tracked lipid, thawed for this weigh-in: the thaw is the lot's, stored on it at once.
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-lotthaw]');
      if (!b) return;
      const lot = ctx.store.get('lipidLots', b.dataset.lotthaw);
      if (!lot) return;
      const next = withThaw(lot, { operator: settings.operator, note: stock ? `weighed into ${stock.id}` : 'weighed into a new stock' });
      ctx.store.put('lipidLots', next);
      toast(`Lot ${lot.lot}: ${ftWords(next)}`, 'ok');
      redraw();
    });

    draw();
    box.scrollIntoView({ block: 'start' });
    return !!draft?.state;
  }
}

/** " at 10:42" for a draft started today, "" otherwise (or when the time cannot be read). */
function draftTime(d) {
  const t = new Date(d?.draftAt || '');
  return Number.isNaN(t.getTime()) || t.toDateString() !== new Date().toDateString() ? '' : ` at ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

/**
 * A mol% as the recipe states it: 38.25, not 38.3. A rebalanced run differs from the registry recipe by a
 * quarter of a mol% or less, and rounding that to one decimal would print the recipe it is not.
 */
const pctText = (v) => { const s = fmt(v, 3); return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s; };

/** The recipe a formulation record links here with (`compositionId` and `mol`, a JSON mol% map), or null. */
function handedRecipe(params) {
  if (!params?.mol) return null;
  let mol;
  try { mol = JSON.parse(params.mol); } catch { return null; }
  if (!mol || typeof mol !== 'object') return null;
  const molPct = Object.fromEntries(Object.entries(mol).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v) && v >= 0));
  return Object.keys(molPct).length ? { compositionId: Number(params.compositionId), molPct } : null;
}

const kpiBox = (l, v) => `<div class="kpi"><div class="l">${l}</div><div class="v" style="font-size:15px">${v}</div></div>`;
