// Screen: Buffers — design a buffer (grams of reagents for a target pH), keep a shelf of common recipes, save prepared lots.
//
// The page reads top to bottom as the work goes: the lots on the shelf, then the common buffers grouped by what
// they are for in the process (loading, quench, dialysis, formulation), each a click from its recipe, and the
// designer when one is open. The recipe, the pH it comes to and its ionic strength are worked out in one place,
// calc/buffer.js designBuffer(), which the process designer asks too, so a buffer has the same ionic strength
// on every screen.
import { html, raw, fmt, field, readForm, table, chip, toast, printHtml, header, todayISO, fmtDate, esc, swapHtml, redrawSoon, autoSaver, sharedRecord, readDraft, writeDraft, dropDraft, uid, ask } from './kit.js';
import { getRef, getSettings } from '../refdata.js';
import { designBuffer, bufferMethods, speciesAt, nextBufferLot, BUFFER_ROLES, normaliseRoles, roleLabel, bufferCode, bufferLotName } from '../calc/buffer.js';
import { ionicStrength_mM, bufferFacts } from '../calc/process.js';
import { usedIds, raiseCounter } from '../schema.js';
import { whereUsed, usageSentence, archive, unarchive, archivedSet } from '../calc/usage.js';

// The systems a lab buffer is usually made of, offered first; the whole pKa database follows in the same menu.
const COMMON = ['Acetic acid', 'Citric acid', 'Phosphoric acid', 'Triphosphate (3P)', 'HEPES', 'Histidine', 'Tris(hydroxymethyl)- aminomethane (tris)', '2-(N-morpholino)ethanesulfonic acid - MES', 'MOPS', 'PIPES', 'TES', 'Bicine', 'Tricine', 'Succinic acid'];
const SHORT = { 'Tris(hydroxymethyl)- aminomethane (tris)': 'Tris', '2-(N-morpholino)ethanesulfonic acid - MES': 'MES', 'Acetic acid': 'Acetate', 'Citric acid': 'Citrate', 'Phosphoric acid': 'Phosphate', 'Succinic acid': 'Succinate', 'Triphosphate (3P)': '3P' };
const shortName = (n) => SHORT[n] || n;
// The menu's words: the buffer's everyday name, and the acid it is made from where that differs. The long
// database names ("Tris(hydroxymethyl)- aminomethane (tris)") used to be cut at the first space, which gave
// "Tris (Tris(hydroxymethyl)-)" and "MES (2-(N-morpholino)ethanesulfonic)".
const SYSTEM_LABEL = { 'Acetic acid': 'Acetate (acetic acid)', 'Citric acid': 'Citrate (citric acid)', 'Phosphoric acid': 'Phosphate (phosphoric acid)',
  'Succinic acid': 'Succinate (succinic acid)', 'Triphosphate (3P)': 'Triphosphate (3P)', 'Tris(hydroxymethyl)- aminomethane (tris)': 'Tris', '2-(N-morpholino)ethanesulfonic acid - MES': 'MES' };
const systemLabel = (n) => SYSTEM_LABEL[n] || n;


// The fields a buffer's name describes: changing one makes a common buffer's name wrong for the lot.
const RECIPE_FIELDS = ['system', 'method', 'targetPH', 'conc_mM', 'nacl_mM', 'sucrose_mM', 'system2', 'conc2_mM', 'reagent2'];
const listIds = (ids, max = 6) => ids.slice(0, max).join(', ') + (ids.length > max ? ` and ${ids.length - max} more` : '');

/** Formulations whose process names a buffer lot (by its lot or id): what a delete has to say first. */
export function formulationsNamingBuffer(store, lot) {
  const names = new Set([lot.lot, lot.id].filter(Boolean));
  return store.all('batches').filter((b) => {
    const p = b?.plan?.process;
    if (!p) return false;
    return [p.aqueous, p.quenchBuffer, ...(p.downstream || [])].some((x) => x && names.has(String(x.buffer || '').trim()));
  }).map((b) => b.id);
}

// The drafts whose "Save lot" is being stored: not a lot still to save, so not offered back meanwhile.
const storing = new Set();
const notStoring = (d) => (d && storing.has(d.draftId) ? null : d);

export async function render(el, ctx) {
  const ref = getRef(ctx), settings = getSettings(ctx);
  const pkaByName = {};
  for (const p of ref.pka) if (!pkaByName[p.name]) pkaByName[p.name] = p;
  // Every system in the database, the common ones first: since the one-view change the screens no longer have a
  // simple mode, and the menu used to drop the common ones in among 265 entries in database order.
  const common = COMMON.filter((n) => pkaByName[n]);
  const others = Object.keys(pkaByName).filter((n) => !common.includes(n)).sort((a, b) => a.localeCompare(b));
  const editing = ctx.params.id ? ctx.store.get('buffers', ctx.params.id) : null;
  const prefill = ctx.params.from != null ? ref.buffersCatalog[Number(ctx.params.from)] : null;
  const showForm = !!(ctx.params.new || editing || prefill);

  el.innerHTML = header('Run', 'Buffers', `<a class="btn primary" href="#/buffers?new=1">New buffer</a>`) +
    `<div id="bufferDraft"></div><div id="bufferEditor"></div>
     <div class="card"><h2>Prepared buffer lots</h2><div id="bufferList"></div></div>
     <div class="card" id="commonBuffers"><h2>Common buffers</h2><p class="muted" style="margin-top:-4px">Starting points from the literature, by where they go in the process. Click one to open its recipe; everything stays editable before you save it as a lot.</p><div id="catalogList"></div></div>`;

  const listBox = el.querySelector('#bufferList');
  renderLists();
  // The draft of a new buffer is offered back wherever the form is not already showing it.
  if (!(showForm && renderEditor(editing, prefill))) offerDraft(showForm && !editing);

  function renderLists() {
    if (!listBox.isConnected) return; // a buffer on record is stored as it is edited, also after the screen is left
    listBox.innerHTML = lotOverview(ctx, ctx.params.role || '');
    // The common buffers by role: a buffer used for two roles is listed under both, which is where someone
    // looking for a quench buffer or a dialysis buffer looks.
    const made = ctx.store.all('buffers');
    const lotsOf = (b) => made.filter((x) => x.name === b.name || (x.code && x.code === b.code));
    el.querySelector('#catalogList').innerHTML = `<div class="bufGroups">${BUFFER_ROLES.map(({ id: role, label: title, what }) => {
      const items = ref.buffersCatalog.map((b, i) => [b, i]).filter(([b]) => normaliseRoles(b.roles).includes(role));
      return `<div class="bufGroup" data-role="${role}"><h3>${esc(title)}</h3><div class="muted small">${esc(what)}</div>
        <ul>${items.map(([b, i]) => { const lots = lotsOf(b); return `<li><a class="bufPrep" data-from="${i}" href="#/buffers?new=1&from=${i}" title="Open the recipe of ${esc(b.name)}">${esc(b.name)}</a>${lots.length ? ` <span class="chip ok" title="Prepared lots of this buffer">${esc(lots.map((x) => x.lot).join(', '))}</span>` : ''}</li>`; }).join('')}</ul></div>`;
    }).join('')}</div>`;
  }

  /**
   * A note above the form: a new buffer was started and not saved as a lot, with the way back to it. Above a
   * new form (`replaced`), what is typed there becomes the draft in its place, and the note says so.
   */
  function offerDraft(replaced) {
    const d = readDraft(ctx, 'buffer'), box = el.querySelector('#bufferDraft');
    if (!d?.state || storing.has(d.draftId) || !box) return;
    const st = d.state;
    const what = st.name || `${shortName(st.system)} ${fmt(st.conc_mM, 0)} mM pH ${fmt(st.targetPH, 1)}, ${fmt(st.volume_mL, 0)} mL`;
    box.innerHTML = `<div class="note" id="bufferDraftNote">A new buffer you started has not been saved as a lot yet: ${esc(what)}.${replaced ? ' Anything typed below takes its place.' : ''}
      <a class="btn" href="#/buffers?new=1&draft=1" id="bufferDraftOpen">Continue it</a> <button type="button" id="bufferDraftDrop">Discard it</button></div>`;
    box.querySelector('#bufferDraftDrop').addEventListener('click', () => { dropDraft(ctx, 'buffer'); box.innerHTML = ''; });
  }

  /** The form, for a lot on record or a new one. Returns true when it is going on with the draft of a new buffer. */
  function renderEditor(buffer, pre) {
    const state = buffer ? JSON.parse(JSON.stringify(buffer)) : {
      system: 'Acetic acid', method: 'auto', targetPH: 5.5, conc_mM: 50, volume_mL: 1000, nacl_mM: 0, sucrose_mM: 0, activity: true, system2: '', conc2_mM: 0, reagent2: '',
      name: '', roles: normaliseRoles(pre?.roles), code: pre?.code || '', date: todayISO(), operator: settings.operator, notes: pre?.notes || '',
    };
    // A common buffer opens with its own recipe: its system, pH, concentration and additives, as its name says
    // (usability cycle 6, I7). Before, only the name was taken, so "Citrate 25 mM, pH 4.0" opened as acetate.
    if (!buffer && pre) for (const k of ['system', 'targetPH', 'conc_mM', 'nacl_mM', 'sucrose_mM']) if (pre[k] != null) state[k] = pre[k];
    // Its name is kept only while the recipe is the one it names: changed to 25 mM, "Citrate 50 mM, pH 4.0" would
    // be saved on a lot that is not (the name used to stay whatever was changed). `givenName` is that name.
    if (!buffer && pre) state.givenName = pre.name;
    state.roles = normaliseRoles(state.roles); // "formulation" is "final" now; stored so on the next save
    const box = el.querySelector('#bufferEditor');
    // What was typed into a new buffer and not saved as a lot is offered back (usability cycle 5, K6): the note
    // above the form leads here with draft=1, and the form then starts from it.
    const draft = !buffer && !pre && ctx.params.draft ? notStoring(readDraft(ctx, 'buffer')) : null;
    if (draft?.state) Object.assign(state, draft.state);
    // A draft is continued as it would be made today: a preparation date that has passed becomes today.
    const drafted = draft?.state && state.date && state.date < todayISO() ? state.date : null;
    if (drafted) state.date = todayISO();
    // A lot on record is stored as it is edited, onto the lot as it is stored (another window may have it open
    // too); a new one is kept as a draft until "Save lot", under this form's own id.
    const shared = buffer ? sharedRecord(ctx.store, 'buffers', state) : null;
    const saver = buffer ? autoSaver(ctx.store, persist) : null;
    const draftId = draft?.draftId || uid();
    const keep = () => writeDraft(ctx, 'buffer', { state, draftId });
    let creating = false; // while "Save lot" is being stored
    let secondOpen = false; // the second-component fold, as the user left it

    const methods = (system) => bufferMethods(system, ref.reagents);
    /** Above a common buffer's recipe: the lots of it already on the shelf, which may be all that is needed. */
    function shelfNote(name) {
      const lots = ctx.store.all('buffers').filter((b) => b.name === name).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return lots.length ? `<div class="note" id="bufferOnShelf">Already prepared: ${lots.map((b) => `<a href="#/buffers?id=${esc(b.id)}">${esc(b.lot)}</a>${b.date ? ` (${esc(fmtDate(b.date))})` : ''}`).join(', ')}. Save this as a new lot only for a fresh batch.</div>` : '';
    }
    /** Under the roles of a lot on record: the formulations whose process names it, so its use is in sight. */
    function usedNote() {
      const users = formulationsNamingBuffer(ctx.store, buffer);
      return users.length ? `<div class="muted" style="margin-top:6px" id="bufferUsedBy">Named in the process of ${users.length} formulation${users.length === 1 ? '' : 's'}: ${users.slice(0, 8).map((id) => `<a href="#/formulation?batch=${esc(id)}">${esc(id)}</a>`).join(', ')}${users.length > 8 ? ` and ${users.length - 8} more` : ''}.</div>` : '';
    }

    // The recipe, its pH and its ionic strength: calc/buffer.js, the same function the process designer asks.
    function compute() {
      if (!pkaByName[state.system]) return { err: 'Unknown system' };
      return designBuffer(state, { pka: ref.pka, reagents: ref.reagents });
    }

    // The species at the designed pH. It used to be worked out at the pH of the acid alone in water (pH ~2.6 for
    // citric acid), so citrate "at pH 4.0" was shown as 75 % fully protonated where it is about 10 %.
    function speciationTable(res) {
      const sp = speciesAt(res.sys, res.pcH ?? res.pH, state.activity ? res.I : 0);
      return table(['Species (protons attached)', 'Charge', { label: 'fraction %', right: true }], sp.map((s) => ({ cells: [`H${s.protons}B`, s.charge, fmt(s.fraction * 100, 2)] })));
    }

    // What the form says now. The click handlers call this rather than reuse what the last redraw computed:
    // the redraw waits until focus has moved, so a value typed just before pressing Save is in the state but
    // not yet in a closure from the previous draw.
    function derive() {
      const res = compute();
      // Written the way the common buffers are ("Citrate 50 mM, 150 mM NaCl, pH 4.0"), or the common buffer's own
      // name while the recipe is still the one it names.
      const made = `${shortName(state.system)} ${fmt(state.conc_mM, 0)} mM${state.system2 && state.conc2_mM > 0 ? ` + ${shortName(state.system2)} ${fmt(state.conc2_mM, 0)} mM` : ''}${state.nacl_mM ? `, ${fmt(state.nacl_mM, 0)} mM NaCl` : ''}${state.sucrose_mM ? `, ${fmt(state.sucrose_mM, 0)} mM sucrose` : ''}, pH ${fmt(state.targetPH, 1)}`;
      const autoName = state.givenName || made;
      const sucroseG = state.sucrose_mM > 0 ? (state.sucrose_mM / 1000) * (state.volume_mL / 1000) * 342.3 : 0;
      const naclG = state.nacl_mM > 0 ? (state.nacl_mM / 1000) * (state.volume_mL / 1000) * 58.44 : 0;
      return { res, autoName, sucroseG, naclG };
    }

    function draw() {
      const { res, autoName, sucroseG, naclG } = derive();
      const reagents2 = state.system2 ? ref.reagents.filter((x) => x.system === state.system2) : [];
      const result = res.err ? `<div class="note warn">${res.err}</div>` : `
        <div id="bufferResult">
          <div class="weighGrid">
            ${[
              ...res.reagents.map((r) => ({ name: r.name, big: r.grams != null ? fmt(r.grams, 3) : fmt(r.mL, 2), unit: r.grams != null ? 'g' : 'mL', sub: r.mmol != null ? `${fmt(r.mmol, 2)} mmol` : '&nbsp;' })),
              ...(naclG ? [{ name: 'Sodium chloride', big: fmt(naclG, 3), unit: 'g', sub: `${fmt(state.nacl_mM, 0)} mM` }] : []),
              ...(sucroseG ? [{ name: 'Sucrose', big: fmt(sucroseG, 2), unit: 'g', sub: `${fmt(state.sucrose_mM, 0)} mM` }] : []),
            ].map((x) => `<div class="weighCard">
              <div class="wcHead"><b>${esc(x.name)}</b></div>
              <div class="wcTarget">${x.big}<span>${x.unit}</span></div>
              <div class="wcMmol">${x.sub}</div>
            </div>`).join('')}
          </div>
          <div class="wcAfter">
            <div class="wcStep"><span class="n">1</span><div><b>Dissolve</b><div class="muted">in roughly ${fmt(state.volume_mL * 0.8, 0)} mL of water</div></div></div>
            <div class="wcStep"><span class="n">2</span><div><b>Make up</b><div class="muted">water ad ${fmt(state.volume_mL, 0)} mL</div></div></div>
            <div class="wcStep"><span class="n">3</span><div><b>Check</b><div class="muted">predicted pH ${fmt(res.pH, 2)} — measure and adjust</div></div></div>
          </div>
          <div class="grid g3" style="margin-top:12px">
            <div class="kpi"><div class="l">Predicted pH</div><div class="v">${fmt(res.pH, 2)}</div><div class="muted">${state.activity ? `what the meter reads (activity, Davies), 25 °C · p[H] ${fmt(res.pcH, 2)}` : 'concentration scale, 25 °C'}</div></div>
            <div class="kpi"><div class="l">Ionic strength</div><div class="v">${fmt(res.I * 1000, 1)} mM</div><div class="muted">${res.I > 0.3 ? 'above the Davies validity range' : 'buffer, its counter-ions and NaCl; the process designer uses this number'}</div></div>
            <div class="kpi"><div class="l">Buffer capacity</div><div class="v">${fmt(res.bc * 1000, 1)}</div><div class="muted">mmol·L⁻¹·pH⁻¹</div></div>
          </div>
          ${res.reachable === false && res.reagents.length ? '<div class="note warn">Target pH is outside what this reagent pair can reach. Choose another method or system.</div>' : ''}
          ${res.note ? `<div class="note">${esc(res.note)}</div>` : ''}
          ${Math.abs(res.pH - state.targetPH) > 0.05 && res.reagents.length ? `<div class="note warn">Predicted pH differs from target by ${fmt(res.pH - state.targetPH, 2)}; check the pH meter and adjust with titrant.</div>` : ''}
          <details class="fold" style="margin-top:10px"><summary class="muted">Speciation at the designed pH, and the pKa values</summary>${speciationTable(res)}
            <p class="muted">pKa (${esc(res.sys.name)}): ${res.sys.pka.map((p) => fmt(p, 3)).join(', ')} · charge of fully deprotonated form ${res.sys.charge_of_base} · ${esc(res.sys.source || 'CurTiPot database, I = 0, 25 °C')}</p></details>
        </div>`;
      const sysOptions = (sel, none) => `${none ? `<option value="">${none}</option>` : ''}<optgroup label="Common">${common.map((n) => `<option value="${esc(n)}"${n === sel ? ' selected' : ''}>${esc(systemLabel(n))}</option>`).join('')}</optgroup>
        <optgroup label="All systems (pKa database)">${others.map((n) => `<option value="${esc(n)}"${n === sel ? ' selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>`;
      const second = !!(state.system2 && state.conc2_mM > 0), secondShown = second || !!state.system2 || secondOpen;

      // Through swapHtml: the user is usually in a field of this form when it is rebuilt, and must stay there.
      if (!swapHtml(box, html`<div class="card" id="bufferForm">
        <h2>${buffer ? 'Buffer lot ' + buffer.lot : 'New buffer'}</h2>
        ${!buffer && state.givenName ? raw(shelfNote(state.givenName)) : ''}
        ${draft?.state ? raw(`<div class="note" id="bufferDraftOn">You are going on with the new buffer you started.${drafted ? ` Its date, ${esc(fmtDate(drafted))}, has passed and is today now.` : ''} It is stored when you press “Save lot”. <button type="button" id="bufferDraftFresh">Start afresh</button></div>`) : ''}
        <div class="grid g4">
          <div><label for="system">Buffer system</label><select id="system" name="system">${raw(sysOptions(state.system))}</select></div>
          ${raw(field({ id: 'method', label: 'Prepare with', type: 'select', value: state.method, options: [{ value: 'auto', label: 'Recommended' }, ...methods(state.system)] }))}
          ${raw(field({ id: 'targetPH', label: 'Target pH', value: state.targetPH, step: 0.05 }))}
          ${raw(field({ id: 'conc_mM', label: 'Buffer concentration (mM)', value: state.conc_mM, step: 1 }))}
          ${raw(field({ id: 'volume_mL', label: 'Volume (mL)', value: state.volume_mL, step: 10 }))}
          ${raw(field({ id: 'nacl_mM', label: 'NaCl (mM)', value: state.nacl_mM, step: 1 }))}
          ${raw(field({ id: 'sucrose_mM', label: 'Sucrose (mM)', value: state.sucrose_mM, step: 10 }))}
          <div style="align-self:end">${raw(field({ id: 'activity', label: 'Activity correction (Davies)', type: 'checkbox', value: state.activity }))}</div>
        </div>
        <details class="fold bufSecond" style="margin-top:10px"${secondShown ? ' open' : ''}><summary class="muted">${second ? `Second component: ${shortName(state.system2)} ${fmt(state.conc2_mM, 0)} mM` : 'Add a second buffer component (e.g. 3P with HEPES)'}</summary>
        <div class="grid g4" style="margin-top:6px">
          <div><label for="system2">Second component</label><select id="system2" name="system2">${raw(sysOptions(state.system2, '— none —'))}</select></div>
          ${raw(field({ id: 'conc2_mM', label: 'Second component (mM)', value: state.conc2_mM, step: 1 }))}
          ${raw(field({ id: 'reagent2', label: 'Added as', type: 'select', value: state.reagent2, options: reagents2.length ? reagents2.map((x) => ({ value: x.name, label: x.name })) : [{ value: '', label: '—' }] }))}
          <div class="muted" style="align-self:end">Included in the pH solution and the recipe; the first system is adjusted to hit the target pH.</div>
        </div></details>
        <h2 style="margin-top:14px">Recipe</h2>
        ${raw(result)}
        <h2 style="margin-top:14px">Record</h2>
        <div class="grid g4">
          ${raw(field({ id: 'name', label: 'Name', type: 'text', value: state.name || autoName, placeholder: autoName }))}
          ${raw(field({ id: 'date', label: 'Date prepared', type: 'date', value: state.date }))}
          ${raw(field({ id: 'operator', label: 'Prepared by', type: 'text', value: state.operator }))}
        </div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px">
          <span class="muted" style="align-self:center">Used for</span>${raw(BUFFER_ROLES.map(({ id: r, label: title, what }) => `<span title="${esc(what)}">${field({ id: 'role_' + r, label: title, type: 'checkbox', value: (state.roles || []).includes(r) })}</span>`).join(''))}
        </div>
        ${buffer ? raw(usedNote()) : ''}
        <div class="grid g4" style="margin-top:8px">
          ${raw(field({ id: 'code', label: 'Code (lot name prefix)', type: 'text', value: state.code || '', placeholder: bufferCode(state) }))}
        </div>
        <div class="muted" style="margin-top:6px">${buffer ? raw(`Lot: <b>${esc(buffer.lot)}</b>${buffer.id !== buffer.lot ? ` · also ${esc(buffer.id)}` : ''}`) : raw(`Lot: <b>${esc(lotNameFor())}</b> · also ${esc(nextBufferLot(usedIds(ctx.store, 'buffer')))}`)}. The name is code, pH and date; the Buffer number stays with it so older records keep finding it.</div>
        ${raw(field({ id: 'notes', label: 'Notes (measured pH, osmolality, adjustments)', type: 'textarea', value: state.notes, rows: 2 }))}
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          ${buffer ? raw(saver.html()) : raw(`<button class="primary" id="saveBuffer" ${creating ? 'disabled' : ''}>${creating ? 'Saving …' : 'Save lot'}</button>`)}
          <button id="printBuffer">Print recipe</button>
          ${buffer ? raw(archivedSet(ctx.store, 'buffer').has(String(buffer.id)) ? '<span class="chip" style="margin-left:auto">archived</span><button id="restoreBuffer">Restore</button>' : '<button id="deleteBuffer" style="margin-left:auto;color:var(--warn)">Delete</button>') : ''}
        </div>
      </div>`)) return;
      const form = box.querySelector('#bufferForm');
      form.addEventListener('input', onInput);
      form.addEventListener('change', onInput);
      form.querySelector('#saveBuffer')?.addEventListener('click', () => { const d = derive(); save(d.res, d.autoName); });
      form.querySelector('#bufferDraftFresh')?.addEventListener('click', () => { dropDraft(ctx, 'buffer'); ctx.navigate('buffers', { new: 1 }); });
      form.querySelector('#printBuffer').addEventListener('click', () => { const d = derive(); print(d.res, d.autoName, d.naclG, d.sucroseG); });
      form.querySelector('.bufSecond > summary')?.addEventListener('click', (e) => { secondOpen = !e.currentTarget.parentElement.open; });
      // Deleting goes to the trash, with an Undo on the note instead of a confirmation first (see Settings ›
      // Recently deleted).
      form.querySelector('#restoreBuffer')?.addEventListener('click', () => { unarchive(ctx.store, 'buffer', buffer.id); toast(`${buffer.lot || buffer.id} restored`, 'ok'); ctx.navigate('buffers', { id: buffer.id }); });
      form.querySelector('#deleteBuffer')?.addEventListener('click', async () => {
        const lot = buffer.lot || buffer.id;
        // A lot that formulations name is archived instead (spec 9.5): hidden from the pickers, kept for them.
        const used = whereUsed(ctx.store, 'buffer', buffer.id);
        if (used.length) {
          if (!(await ask(usageSentence('buffer', lot, used)))) return;
          archive(ctx.store, 'buffer', buffer.id);
          toast(`${lot} archived`, '', { action: 'Undo', onAction: () => { unarchive(ctx.store, 'buffer', buffer.id); renderLists(); } });
          ctx.navigate('buffers');
          return;
        }
        const entry = ctx.store.moveToTrash([['buffers', buffer.id]], { kind: 'buffer', label: `${lot}${buffer.id !== lot ? ` (${buffer.id})` : ''}${buffer.name ? ' · ' + buffer.name : ''}` });
        if (entry) toast(`Deleted ${lot}`, '', { action: 'Undo', onAction: () => {
          const r = ctx.store.restoreFromTrash(entry.id);
          if (!r.ok) { toast(`Not restored: ${r.reason}`, 'warn'); return; }
          toast(`Restored ${lot}`, 'ok'); ctx.navigate('buffers', { id: buffer.id });
        } });
        ctx.navigate('buffers');
      });
    }

    // Stored at once when a field is left, once typing pauses while in it.
    function onInput(e) {
      apply(e);
      if (!e.target.name) return;
      if (saver) { if (e.type === 'change') saver.now(); else saver.soon(); } else keep();
    }

    function apply(e) {
      const t = e.target; if (!t.name) return;
      const v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? (t.value === '' ? null : Number(t.value)) : t.value;
      if (t.name.startsWith('role_')) { const r = t.name.slice(5); state.roles = (state.roles || []).filter((x) => x !== r); if (v) state.roles.push(r); return; }
      state[t.name] = v;
      if (t.name === 'system') state.method = 'auto';
      if (t.name === 'system2') state.reagent2 = '';
      // The common buffer's name goes with the first change to the recipe it names.
      if (state.givenName && RECIPE_FIELDS.includes(t.name)) delete state.givenName;
      if (t.name === 'name' || t.name === 'notes') return;
      if (t.name === 'code') state.code = String(v || '').trim().toUpperCase();
      // A change arrives as the user leaves a field, on the way to the next one: redraw once they are there.
      if (e.type === 'change') redrawSoon(box, draw);
    }

    /**
     * The lot as it is to be stored. From the state, which every field writes as it is typed, rather than from the
     * form: the state may also hold what another window stored a moment ago, which the form shows only once it
     * is drawn again.
     */
    function record(res, autoName) {
      // The id is still the Buffer-NNN series, numbered past every lot still named anywhere, a deleted one's
      // included: the formulations made with it keep its number. A lot on record keeps the name it was saved
      // with, even when its pH or date is edited later, because that name is what is written on the bottle.
      const id = state.id || nextBufferLot(usedIds(ctx.store, 'buffer'));
      const lot = state.lot || lotNameFor();
      const { givenName, ...kept } = state;
      return { ...kept, roles: normaliseRoles(state.roles), id, name: state.name || autoName,
        lot, recipe: { method: res.method, reagents: res.reagents, nacl_mM: state.nacl_mM, sucrose_mM: state.sucrose_mM, predictedPH: res.pH, ionicStrength: res.I, bufferCapacity: res.bc } };
    }

    /** A lot on record, stored as it is edited: what was changed here, over the lot as it is stored now. */
    function persist() {
      if (!shared.take()) return `${buffer.lot || buffer.id} was moved to the trash, here or in another window`;
      const d = derive();
      if (d.res.err) return d.res.err;
      ctx.store.put('buffers', record(d.res, d.autoName));
      shared.stored();
      renderLists();
    }
    // Another window stored this lot: show it as stored, with anything still being typed here laid over it.
    shared?.watch(() => box.isConnected, (now) => {
      if (!now || !shared.take()) { saver.now(); return; } // says it is not saved, and why
      saver.note('Changed in another window: shown as stored there');
      renderLists(); redrawSoon(box, draw);
    });

    /**
     * "Save lot": the new buffer is numbered and stored, and then its draft goes and the lot opens. As the
     * experiment wizard does: until the write is stored the button says so and does nothing more, and when the
     * browser refuses it (a full disk) the store undoes it and the form stays, with its draft, to press again.
     */
    function save(res, autoName) {
      if (creating) return;
      if (res.err) { toast(res.err, 'warn'); return; }
      const rec = record(res, autoName);
      busy(true);
      // While it is being stored its draft is not offered back, and the lot opens only for a user still on
      // this form; one who has moved on is told where it is (usability cycle 6, W6).
      storing.add(draftId);
      ctx.store.transaction(() => {
        ctx.store.put('buffers', rec);
        raiseCounter(ctx.store, 'buffer', rec.id);
      }, {
        what: `the new lot ${rec.lot} (${rec.id})`, again: 'Save lot',
        onSaved: () => {
          storing.delete(draftId);
          dropDraft(ctx, 'buffer', draftId);
          if (box.isConnected) { toast(`Saved ${rec.lot}`, 'ok'); ctx.navigate('buffers', { id: rec.id }); }
          else toast(`Saved ${rec.lot}`, 'ok', { action: 'Open', onAction: () => ctx.navigate('buffers', { id: rec.id }) });
        },
        onUndone: () => { storing.delete(draftId); busy(false); return box.isConnected; },
      });
    }
    // Kept in `creating` as well as on the button, which a redraw meanwhile (a field left by pressing it) rebuilds.
    function busy(on) {
      creating = on;
      const b = box.querySelector('#saveBuffer');
      if (b) { b.disabled = on; b.textContent = on ? 'Saving …' : 'Save lot'; }
    }

    /** The name a new lot would be saved under: code, pH and date, numbered on past the lots of that day. */
    function lotNameFor() {
      const taken = ctx.store.all('buffers').map((b) => b.lot);
      return bufferLotName({ code: state.code || bufferCode(state), targetPH: state.targetPH, date: state.date }, taken);
    }

    function print(res, autoName, naclG, sucroseG) {
      if (res.err) return;
      const f = readForm(box);
      const body = `<h1>Buffer preparation · ${f.name || autoName}</h1><div class="muted">${esc(state.lot || lotNameFor())} · ${fmt(state.volume_mL, 0)} mL · target pH ${fmt(state.targetPH, 2)} · ${f.date} · ${f.operator}</div>
        <h2>Reagents</h2><table><tr><th>Reagent</th><th class="r">Amount</th><th>Lot</th><th>Weighed</th></tr>
        ${res.reagents.map((r) => `<tr><td>${r.name}</td><td class="r">${r.grams != null ? fmt(r.grams, 3) + ' g' : fmt(r.mL, 2) + ' mL'}</td><td><span class="blank"></span></td><td><span class="blank"></span></td></tr>`).join('')}
        ${naclG ? `<tr><td>Sodium chloride</td><td class="r">${fmt(naclG, 3)} g</td><td><span class="blank"></span></td><td><span class="blank"></span></td></tr>` : ''}
        ${sucroseG ? `<tr><td>Sucrose</td><td class="r">${fmt(sucroseG, 2)} g</td><td><span class="blank"></span></td><td><span class="blank"></span></td></tr>` : ''}
        <tr><td>Water for injection</td><td class="r">ad ${fmt(state.volume_mL, 0)} mL</td><td><span class="blank"></span></td><td></td></tr></table>
        <h2>Checks</h2><table><tr><th>Predicted pH</th><th>Measured pH</th><th>Adjusted with</th><th>Osmolality</th><th>Filtered 0.2 µm</th></tr><tr><td>${fmt(res.pH, 2)}</td><td><span class="blank"></span></td><td><span class="blank"></span></td><td><span class="blank"></span></td><td><span class="blank"></span></td></tr></table>
        <p class="muted">Ionic strength ${fmt(res.I * 1000, 1)} mM · buffer capacity ${fmt(res.bc * 1000, 1)} mmol·L⁻¹·pH⁻¹ · pKa at 25 °C, I = 0 (CurTiPot)</p>
        <div class="sig"><div>Date / signature</div><div>Storage / expiry</div></div>`;
      printHtml(`Buffer ${f.name || autoName}`, body);
    }

    draw();
    box.scrollIntoView({ block: 'start' });
    return !!draft?.state;
  }
}

/**
 * The prepared lots, one row per kind of buffer (spec 9.2): how many lots, the newest, and a small table of all
 * of them on opening the row. A chip per lot behind every buffer stopped being readable after a few lots. The tabs
 * above it filter by role; `role` is in the hash, so Back returns to the tab.
 */
export function lotOverview(ctx, role) {
  const gone = archivedSet(ctx.store, 'buffer'), showArchived = ctx.params?.archived === '1';
  const lots = ctx.store.all('buffers').map((b) => ({ ...b, roles: normaliseRoles(b.roles), archived: gone.has(String(b.id)) }))
    .filter((b) => (!role || b.roles.includes(role)) && (showArchived || !b.archived))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(b.id).localeCompare(String(a.id)));
  const used = usage(ctx);
  const tabs = [{ id: '', label: 'All' }, ...BUFFER_ROLES].map((r) => `<a class="chip${r.id === role ? ' on' : ''}" href="#/buffers${r.id ? '?role=' + r.id : ''}">${esc(r.label)}</a>`).join(' ');
  const groups = new Map();
  for (const b of lots) {
    const key = b.code || bufferCode(b) || b.name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const rows = [...groups.entries()].map(([key, list]) => {
    const newest = list[0];
    const detail = table(['Lot', 'Date', { label: 'pH', right: true }, { label: 'mL', right: true }, { label: 'Left mL', right: true }, 'Expires', { label: 'Used in', right: true }, ''],
      list.map((b) => ({ cells: [raw(`<a href="#/buffers?id=${encodeURIComponent(b.id)}"><b>${esc(b.lot)}</b></a>${b.lot !== b.id ? ` <span class="muted">${esc(b.id)}</span>` : ''}${b.archived ? ' <span class="chip">archived</span>' : ''}`),
        fmtDate(b.date), fmt(b.measuredPH ?? b.targetPH, 2), fmt(b.volume_mL, 0), b.remaining_mL != null ? fmt(b.remaining_mL, 0) : '–', b.expiry ? fmtDate(b.expiry) : '–',
        `${used(b)} batch${used(b) === 1 ? '' : 'es'}`, raw(`<a href="#/buffers?id=${encodeURIComponent(b.id)}">Open</a>`)] })));
    return `<details class="lotgroup"><summary><b>${esc(key)}</b> · ${esc(newest.name || '')} · ${list.length} lot${list.length === 1 ? '' : 's'} · newest <a href="#/buffers?id=${encodeURIComponent(newest.id)}">${esc(newest.lot)}</a> (${esc(fmtDate(newest.date))}) <span class="muted">${esc(newest.roles.map(roleLabel).join(', '))}</span></summary>${detail}</details>`;
  });
  const toggle = gone.size ? ` <a style="margin-left:12px" href="#/buffers?${new URLSearchParams({ ...(role ? { role } : {}), ...(showArchived ? {} : { archived: '1' }) })}">${showArchived ? 'Hide archived' : `Show archived (${gone.size})`}</a>` : '';
  return `<div class="tabs" style="margin-bottom:8px">${tabs}${toggle}</div>${rows.join('') || '<p class="muted">No prepared buffers yet.</p>'}`;
}

/** How many batches name a lot, by any name it answers to. Counted once per screen draw. */
function usage(ctx) {
  const counts = new Map();
  const seen = (s) => counts.set(s, (counts.get(s) || 0) + 1);
  const visit = (v, out) => { if (typeof v === 'string') out.add(v); else if (v && typeof v === 'object') for (const k in v) visit(v[k], out); };
  for (const batch of ctx.store.all('batches')) { const strs = new Set(); visit(batch.plan, strs); visit(batch.actual, strs); strs.forEach(seen); }
  return (b) => { const names = new Set([b.lot, b.id, ...(b.aliases || [])]); let n = 0; for (const x of names) n += counts.get(x) || 0; return n; };
}
