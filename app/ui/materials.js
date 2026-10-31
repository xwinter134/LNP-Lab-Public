// Screen: Materials & lots — lipids and their lots, the composition registry, RNA lots, the buffer catalog,
// formulation devices, TFF modules, dialysis devices and the other consumables.
//
// Everything here is reference data that records point at, and most of it needs correcting now and then: a lot
// number typed wrongly, a CoA that arrived later, a recipe registered with the wrong PEG, the instrument the lab
// actually has. So a row opens in place when it is clicked, with one Save and one Cancel, and anything other
// records depend on is said in the editor before it changes, not discovered afterwards.
//
// What the shipped lists hold is never changed. An edit of a shipped device, module or cassette is the user's own
// record under the same id, laid over it (refdata.js, mergeById); hiding one is that record with `deleted: true`;
// "Back to the shipped version" removes the record. A shipped composition is not edited at all — #1 has to mean
// the same recipe in every lab — but it can be copied and the copy edited. What the user added themselves is
// deleted to the trash, with Undo on the note and Settings › Recently deleted as for experiments and stocks.
//
// Unless something still names it (spec 9.5, 12.2): then it is never removed from the store, and Delete (or Hide,
// for a shipped entry) says where it is used and offers to archive it instead. Where a component is used is asked
// of one helper for every tab, calc/usage.js whereUsed(); the sentences that say it stay here, in each tab's words.
// Archived components leave these tables and every picker, and are listed in the Archived card with Restore.
import { esc, fmt, field, readForm, chip, toast, header, todayISO, fmtDate, uid, ask, raw, table, redrawSoon } from './kit.js';
import { DESCRIPTORS } from '../calc/ml/lipidmode.js';
import { getRef, getSettings } from '../refdata.js';
import { archive, unarchive, archivedSet, whereUsed, usesBy, KINDS } from '../calc/usage.js';
import { provenance } from '../calc/provenance.js';
import { provenanceBadge } from './provenance.js';
import { CARGO_TYPES, cargoInfo, cargoLabel, lotMassPerPhosphate } from '../calc/cargo.js';
import { tracksThaw, ftWords } from '../calc/freezethaw.js';
import { thawPanel, thawChip, wireThaw } from './thaw.js';
import { lipidClassChip, lipidClassInfo, lipidNameMarked, compositionBar, lipidClassLegend } from './lipidclass.js';
import { checkBufferCode, normaliseRoles, roleLabel } from '../calc/buffer.js';

// The ids are what links and bookmarks name (?tab=tff), so they stay as they are; only the order and labels move.
const TABS = [['lipids', 'Lipids & lots'], ['compositions', 'Compositions'], ['rna', 'RNA lots'], ['buffers', 'Buffer catalog'],
  ['devices', 'Formulation devices'], ['tff', 'TFF modules'], ['dialysis', 'Dialysis'], ['consumables', 'Consumables']];

const wiredArchive = new WeakSet();

export async function render(el, ctx) {
  // A link or a bookmark can name a tab that no longer exists; fall back rather than throw.
  const PANELS = { lipids, compositions, rna, buffers, devices, tff, dialysis, consumables };
  const tab = PANELS[ctx.params.tab] ? ctx.params.tab : 'lipids';
  el.innerHTML = header('Reference', 'Materials & lots') +
    `<div style="display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:14px;flex-wrap:wrap">${TABS.map(([id, t]) => `<a href="#/materials?tab=${id}" style="padding:8px 12px;text-decoration:none;color:${id === tab ? 'var(--ink)' : 'var(--ink2)'};border-bottom:2px solid ${id === tab ? 'var(--accent)' : 'transparent'};font-weight:${id === tab ? 600 : 400}">${t}</a>`).join('')}</div>
     ${archivedCard(ctx)}<div id="tabBody"></div>`;
  // Listened on the screen, so a card drawn again after an archive (redrawArchived) is wired too; once per
  // element, since #main stays from one visit to the next.
  if (!wiredArchive.has(el)) wiredArchive.add(el), el.addEventListener('click', (e) => {
    const b = e.target.closest('#archivedCard [data-unarchive]'); if (!b) return;
    const [kind, id] = b.dataset.unarchive.split('|');
    unarchive(ctx.store, kind, id); toast('Restored', 'ok');
    window.dispatchEvent(new HashChangeEvent('hashchange')); // drawn again from the address as it is now
  });
  PANELS[tab](el.querySelector('#tabBody'), ctx);
  // The optimizer's lipid descriptors (spec 7.3.2), only with the descriptor mode switched on in Settings.
  if (tab === 'lipids' && getSettings(ctx).mlDescriptors) {
    el.querySelector('#tabBody').insertAdjacentHTML('beforeend', descriptorCard(getRef(ctx)));
    wireDescriptors(el.querySelector('#tabBody'), ctx, getRef(ctx));
  }
}

/* ---------------- shared pieces ---------------- */

/**
 * A table whose rows open an editor underneath them. kit.js table() cannot hold a row that spans every column,
 * which is what the editor is, so this one can: a row is {cells, attrs} or {full, attrs}. A cell made with raw()
 * (an object) is markup; anything else is text and escaped.
 */
function editTable(headers, rows, empty = 'Nothing yet') {
  const right = headers.map((h) => typeof h === 'object' && h.right);
  const th = headers.map((h, i) => `<th${right[i] ? ' style="text-align:right"' : ''}>${esc(typeof h === 'object' ? h.label : h)}</th>`).join('');
  const cell = (c) => (c !== null && typeof c === 'object' ? String(c) : esc(c));
  const body = rows.length ? rows.map((r) => (r.full != null
    ? `<tr ${r.attrs || ''}><td colspan="${headers.length}">${r.full}</td></tr>`
    : `<tr ${r.attrs || ''}>${r.cells.map((c, i) => `<td${right[i] ? ' style="text-align:right"' : ''}>${cell(c)}</td>`).join('')}</tr>`)).join('')
    : `<tr><td colspan="${headers.length}" class="muted">${esc(empty)}</td></tr>`;
  return `<div style="overflow-x:auto"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}
// Markup for editTable, without importing kit's Raw class: any object with a toString is taken as markup.
const m = (s) => ({ toString: () => String(s ?? '') });

/** The editor's fields carry a prefix, so they never share an id with the "Add" form further down the page. */
const P = 'e_';
const efield = (o) => field({ ...o, id: P + o.id });
const readEditor = (root) => Object.fromEntries(Object.entries(readForm(root)).filter(([k]) => k.startsWith(P)).map(([k, v]) => [k.slice(P.length), v]));
const wide = (s) => `<div style="grid-column:1/-1">${s}</div>`;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const listIds = (ids, max = 6) => ids.slice(0, max).join(', ') + (ids.length > max ? ` and ${ids.length - max} more` : '');

/** The Save / Cancel row, with whatever removing the record means for it on the far side. */
const actionsRow = (saveLabel, extra = '') => `<div class="mat-actions"><button class="primary" data-act="save">${esc(saveLabel)}</button><button data-act="cancel">Cancel</button><span class="push"></span>${extra}</div>`;

/** Put the cursor in the editor that has just opened, without scrolling the page under the reader. */
function focusEditor(box, prefer = '') {
  (prefer && box.querySelector(`.mat-editor ${prefer}`) || box.querySelector('.mat-editor input:not([disabled]), .mat-editor select:not([disabled]), .mat-editor textarea'))?.focus({ preventScroll: true });
}

/**
 * Wire a box whose content draw() rebuilds: clicks on [data-act] go to actions[act], a click elsewhere on a
 * clickable row (tr.mat-row) to onRow(id), Escape to actions.cancel, Enter in a one-line field to actions.save.
 * Listened on the box itself, once, since draw() replaces everything inside it.
 */
function wire(box, actions, onRow) {
  box.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    if (a && box.contains(a)) { e.preventDefault(); actions[a.dataset.act]?.(a); return; }
    const row = e.target.closest('tr.mat-row');
    if (row && onRow && !e.target.closest('a, input, select, textarea')) onRow(row.dataset.open);
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && box.querySelector('.mat-editor')) { e.preventDefault(); actions.cancel?.(); return; }
    if (e.key !== 'Enter') return;
    if (e.target.matches?.('tr.mat-row')) { e.preventDefault(); onRow?.(e.target.dataset.open); return; }
    if (e.target.matches?.('.mat-editor input') && !/^(checkbox|radio)$/.test(e.target.type)) { e.preventDefault(); actions.save?.(); }
  });
}

/** A delete to the trash, with Undo on the note. `after` redraws. */
function trashWithUndo(ctx, col, id, kind, label, after) {
  const entry = ctx.store.moveToTrash([[col, id]], { kind, label });
  if (!entry) return;
  toast(`Deleted ${label}`, '', { action: 'Undo', onAction: () => {
    const r = ctx.store.restoreFromTrash(entry.id);
    if (!r.ok) { toast(`Not restored: ${r.reason}`, 'warn'); return; }
    toast(`Restored ${label}`, 'ok'); after();
  } });
  after();
}

/**
 * The question that replaces a delete when something names the component: `who` says where it is used, in the
 * tab's own words ("is the recipe of 2 formulations (E1-F1, E1-F2)").
 */
const archiveQuestion = (name, who) => `${name} ${who}, so it cannot be deleted. Archive it instead? It is hidden from lists and pickers, those records keep it, and it can be restored.`;

/** Ask, then archive with Undo. Returns whether it was archived. */
async function offerArchive(ctx, kind, id, label, question, after) {
  if (!(await ask(question))) return false;
  archiveWithUndo(ctx, kind, id, label, after);
  return true;
}

/** Archive instead of delete (spec 9.5), with Undo on the note. `after` redraws. */
function archiveWithUndo(ctx, kind, id, label, after) {
  archive(ctx.store, kind, id);
  toast(`Archived ${label}`, '', { action: 'Undo', onAction: () => { unarchive(ctx.store, kind, id); after(); redrawArchived(ctx); } });
  after();
  redrawArchived(ctx);
}

/** The Archived card above the tabs, drawn again after an archive or a restore (a tab redraws only itself). */
function redrawArchived(ctx) {
  const body = document.querySelector('#tabBody');
  if (!body) return;
  document.querySelector('#archivedCard')?.remove();
  body.insertAdjacentHTML('beforebegin', archivedCard(ctx));
}

/**
 * What is archived, with Restore (spec 9.5): above every tab, only while something is. Archived components leave
 * the pickers (refdata.js `pick`), so this is where they are found again.
 */
function archivedCard(ctx) {
  const ref = getRef(ctx), rows = ctx.store.all('archive');
  if (!rows.length) return '';
  const byId = (list, id) => list.find((x) => String(x.id) === id);
  const name = (a) => a.kind === 'lipid' ? ref.lipidByKey[a.itemId]?.name || a.itemId
    : a.kind === 'composition' ? `#${a.itemId}${ref.compositionById[a.itemId]?.synonym ? ' ' + ref.compositionById[a.itemId].synonym : ''}`
      : a.kind === 'lipidLot' ? `lot ${byId(ref.lipidLots, a.itemId)?.lot || a.itemId}`
        : a.kind === 'buffer' ? byId(ref.buffers, a.itemId)?.lot || a.itemId
          : a.kind === 'device' ? byId(ref.devices, a.itemId)?.name || a.itemId
            : a.kind === 'mixer' ? byId(ref.mixers, a.itemId)?.name || a.itemId
              : a.kind === 'tffModule' ? byId(ref.tffModules, a.itemId)?.part || a.itemId
                : a.kind === 'dialysis' ? byId(ref.dialysis, a.itemId)?.name || a.itemId : a.itemId;
  return `<details class="card" id="archivedCard"><summary><b>Archived</b> <span class="muted">${rows.length}: hidden from lists and pickers, kept for the records that use them</span></summary>
    <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">${rows.map((a) => `<div>${esc(KINDS[a.kind]?.label || a.kind)} <b>${esc(name(a))}</b> <button type="button" data-unarchive="${esc(a.kind)}|${esc(a.itemId)}">Restore</button></div>`).join('')}</div></details>`;
}

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';

/* ---------------- Lipids & lots ---------------- */

function lipids(body, ctx) {
  // Which lot is open: {lot: id} to edit one, {add: lipidKey} for a new lot on that lipid's row; null for none.
  let open = null;

  /** Stocks weighed from this lot (calc/usage.js; they point at the lot record by its id, never by its number). */
  const stocksUsing = (id) => whereUsed(ctx.store, 'lipidLot', id).map((u) => u.id);

  function draw() {
    const ref = getRef(ctx), today = todayISO(), limit = getSettings(ctx).ftWarnCycles;
    const lotsByKey = {};
    // Archived lipids and lots leave the table (spec 9.5); the Archived card above the tabs lists them.
    for (const l of ref.active.lipidLots) (lotsByKey[l.lipidKey] ||= []).push(l);
    const rows = [];
    for (const l of ref.active.lipids) {
      // Newest first: the lot most likely to be on the shelf, and the one a stock weigh-in picks by default.
      const lots = (lotsByKey[l.key] || []).sort((a, b) => (b.received || '').localeCompare(a.received || ''));
      const here = open && (open.add === l.key || open.lipid === l.key || lots.some((x) => x.id === open.lot));
      const tracked = tracksThaw(l);
      const lotButtons = lots.map((x) => {
        const expired = x.expiry && x.expiry < today;
        return `<button type="button" class="mat-pick${open?.lot === x.id ? ' on' : ''}" data-act="lot" data-id="${esc(x.id)}" title="Edit lot ${esc(x.lot)}">${esc(x.lot)} <span class="muted">${esc(x.purityPct ?? '?')} %${x.expiry ? ` · ${expired ? 'expired' : 'exp'} ${esc(fmtDate(x.expiry))}` : ''}</span>${tracked ? ` ${thawChip(x, limit) || '<span class="muted">0 F/T</span>'}` : ''}</button>`;
      }).join('');
      rows.push({ attrs: `data-key="${esc(l.key)}"${here ? ' class="mat-open"' : ''}`, cells: [
        m(`<b>${lipidNameMarked(ref, l.key)}</b>${shippedLipid(l.key) ? ` <button type="button" class="mat-add" data-act="archlipid" data-key="${esc(l.key)}" title="Archive ${esc(l.name)}: it ships with the app, so it is hidden rather than deleted">archive</button>` : ` <button type="button" class="mat-add" data-act="lipid" data-key="${esc(l.key)}" title="Edit or delete ${esc(l.name)}, a lipid you added">edit</button>`}`),
        m(`<span class="muted">${esc(l.key)}</span>`), m(lipidClassChip(l.class)), fmt(l.mw, 2),
        m(`<label class="mat-track" title="Count the freeze–thaw cycles of this lipid's lots, and offer to log a thaw when a stock is weighed from one"><input type="checkbox" data-act="track" data-key="${esc(l.key)}" ${tracked ? 'checked' : ''} aria-label="Track freeze–thaw of ${esc(l.name)} lots"> track</label>`),
        m(`${lotButtons}<button type="button" class="mat-add" data-act="addlot" data-key="${esc(l.key)}" title="Add a lot of ${esc(l.name)}">+ lot</button>`)] });
      if (here) rows.push({ attrs: 'class="mat-editor"', full: open.lipid ? lipidEditor(ref, l) : lotEditor(ref) });
    }
    body.innerHTML = `<div class="card"><h2>Lipids (${ref.active.lipids.length})</h2>
      <p class="muted small">Click a lot to correct its number, supplier, purity, dates or CoA; <b>+ lot</b> adds one to that lipid. Tick <b>track</b> for a lipid kept frozen in aliquots: its lots then count their freeze–thaw cycles.</p>
      ${lipidClassLegend()}
      ${editTable(['Name', 'Key', 'Class', { label: 'MW g/mol', right: true }, 'Freeze–thaw', 'Lots'], rows)}</div>
    <div class="card"><h2>Add lipid lot</h2><div class="grid g4" id="lotForm">
      ${field({ id: 'lipidKey', label: 'Lipid', type: 'select', options: ref.active.lipids.map((l) => ({ value: l.key, label: `${l.name} · ${lipidClassInfo(l.class).label}` })) })}
      ${field({ id: 'lot', label: 'Lot number', type: 'text' })}
      ${field({ id: 'supplier', label: 'Supplier', type: 'text' })}
      ${field({ id: 'purityPct', label: 'Purity %', value: 100, step: 0.01 })}
      ${field({ id: 'method', label: 'Purity method', type: 'text', placeholder: 'HPLC-CAD, ELSD, GC …', advanced: true })}
      ${field({ id: 'received', label: 'Received', type: 'date', value: todayISO() })}
      ${field({ id: 'expiry', label: 'Expiry', type: 'date' })}
      ${field({ id: 'coa', label: 'CoA link or path', type: 'text', advanced: true })}
    </div><div style="margin-top:10px"><button class="primary" id="addLot">Add lot</button></div></div>
    <div class="card advanced"><h2>Add lipid</h2><div class="grid g4" id="lipidForm">
      ${field({ id: 'key', label: 'Key (no spaces)', type: 'text' })}${field({ id: 'name', label: 'Display name', type: 'text' })}
      ${field({ id: 'class', label: 'Class', type: 'select', options: ['ionizable', 'helper', 'sterol', 'peg', 'other'].map((c) => ({ value: c, label: `${lipidClassInfo(c).letter} · ${lipidClassInfo(c).label}` })) })}${field({ id: 'mw', label: 'MW g/mol', step: 0.001 })}
    </div><div style="margin-top:10px"><button id="addLipid">Add lipid</button></div></div>`;
    body.querySelector('#addLot').addEventListener('click', addLot);
    body.querySelector('#addLipid').addEventListener('click', addLipid);
  }

  function lotEditor(ref) {
    const lot = open.lot ? ref.lipidLots.find((x) => x.id === open.lot) : { lipidKey: open.add, purityPct: 100, received: todayISO() };
    const used = open.lot ? stocksUsing(open.lot) : [];
    const name = ref.lipidByKey[lot.lipidKey]?.name || lot.lipidKey;
    // Method and CoA are "advanced" in the Add form; here they are always shown, since correcting them is
    // exactly what this editor is for.
    return `<div class="mat-editor" data-editor><h3>${open.lot ? `Lot ${esc(lot.lot)} of ${esc(name)}` : `New lot of ${esc(name)}`}</h3>
      ${used.length ? `<div class="note">Weighed into ${esc(listIds(used))}. ${used.length === 1 ? 'That stock points' : 'Those stocks point'} at this lot's record, not at its number, so a corrected number, purity or date shows there too. It stays on the same lipid.</div>` : ''}
      <div class="grid g4">
        ${efield({ id: 'lipidKey', label: 'Lipid', type: 'select', value: lot.lipidKey, disabled: used.length > 0, options: ref.pick('lipids', lot.lipidKey).map((l) => ({ value: l.key, label: l.name })) })}
        ${efield({ id: 'lot', label: 'Lot number', type: 'text', value: lot.lot || '' })}
        ${efield({ id: 'supplier', label: 'Supplier', type: 'text', value: lot.supplier || '' })}
        ${efield({ id: 'purityPct', label: 'Purity %', value: lot.purityPct ?? '', step: 0.01 })}
        ${efield({ id: 'method', label: 'Purity method', type: 'text', value: lot.method || '', placeholder: 'HPLC-CAD, ELSD, GC …' })}
        ${efield({ id: 'received', label: 'Received', type: 'date', value: lot.received || '' })}
        ${efield({ id: 'expiry', label: 'Expiry', type: 'date', value: lot.expiry || '' })}
        ${efield({ id: 'coa', label: 'CoA link or path', type: 'text', value: lot.coa || '' })}
        ${wide(efield({ id: 'notes', label: 'Notes', type: 'text', value: lot.notes || '' }))}
      </div>
      ${open.lot && tracksThaw(ref.lipidByKey[lot.lipidKey]) ? thawPanel(lot, { key: 'lot', limit: getSettings(ctx).ftWarnCycles, operator: getSettings(ctx).operator, title: `Freeze–thaw of lot ${lot.lot}` }) : ''}
      ${actionsRow(open.lot ? 'Save' : 'Add lot', open.lot ? '<button class="mat-danger" data-act="delete">Delete lot</button>' : '')}</div>`;
  }

  /**
   * What a lipid is used in (calc/usage.js): the recipes in the registry, shipped ones included, the stocks
   * weighed with it, the formulations whose own recipe names it, and its lots.
   */
  function lipidUse(key) {
    const ref = getRef(ctx), by = usesBy(whereUsed(ctx.store, 'lipid', key, { compositions: ref.compositions }));
    return { comps: by.compositions || [], stocks: by.stocks || [], batches: by.batches || [], lots: ref.lipidLots.filter((x) => x.lipidKey === key) };
  }
  const lipidUsers = (u) => [...u.comps, ...u.stocks, ...u.batches];

  /** A lipid the user added: its name, class and MW, and Delete. A shipped lipid has no editor. */
  function lipidEditor(ref, l) {
    const u = lipidUse(l.key), used = lipidUsers(u).length;
    return `<div class="mat-editor" data-editor><h3>${esc(l.name)} <span class="muted" style="font-weight:400">· a lipid you added</span></h3>
      ${used ? `<div class="note">In ${[u.comps.length ? `${plural(u.comps.length, 'composition')} (${esc(listIds(u.comps))})` : '', u.stocks.length ? `${plural(u.stocks.length, 'stock')} (${esc(listIds(u.stocks))})` : ''].filter(Boolean).join(' and ')}. Their amounts are worked out from its molecular weight, so the MW and the class stay as they are and it cannot be deleted while they use it.</div>` : ''}
      <div class="grid g4">
        ${efield({ id: 'name', label: 'Display name', type: 'text', value: l.name || '' })}
        ${efield({ id: 'class', label: 'Class', type: 'select', value: l.class, disabled: !!used, options: ['ionizable', 'helper', 'sterol', 'peg', 'other'].map((c) => ({ value: c, label: `${lipidClassInfo(c).letter} · ${lipidClassInfo(c).label}` })) })}
        ${efield({ id: 'mw', label: 'MW g/mol', value: l.mw ?? '', step: 0.001, disabled: !!used })}
      </div>
      ${actionsRow('Save', '<button class="mat-danger" data-act="dellipid">Delete lipid</button>')}</div>`;
  }

  function saveLipid() {
    const ed = body.querySelector('[data-editor]'), key = open?.lipid;
    const rec = key && ctx.store.all('lipids').find((x) => x.key === key);
    if (!ed || !rec) return;
    const f = readEditor(ed), u = lipidUse(key), used = lipidUsers(u).length;
    if (!used && !(Number(f.mw) > 0)) { toast('MW required', 'warn'); return; }
    ctx.store.put('lipids', { ...rec, name: String(f.name || '').trim() || rec.name, ...(used ? {} : { class: f.class, mw: Number(f.mw) }) });
    toast(`${f.name || rec.name} saved`, 'ok'); open = null; draw();
  }

  /**
   * Delete a lipid the user added. Refused while a recipe or a stock uses it: their masses and mol amounts are
   * worked out from its MW, and without the lipid they would silently lose it. Its lots go with it, in the same
   * trash entry, so Undo brings both back.
   */
  async function deleteLipid() {
    const key = open?.lipid, rec = key && ctx.store.all('lipids').find((x) => x.key === key);
    if (!rec) return;
    const u = lipidUse(key), users = lipidUsers(u);
    if (users.length) {
      // Not deletable while used (their amounts are worked out from its MW), but it can be archived (spec 9.5).
      if (!(await ask(archiveQuestion(rec.name, `is used by ${listIds(users)}`)))) return;
      open = null;
      archiveWithUndo(ctx, 'lipid', key, rec.name, draw);
      return;
    }
    if (u.lots.length && !(await ask(`${rec.name} has ${plural(u.lots.length, 'lot')} on record (${u.lots.map((x) => x.lot).join(', ')}). They are deleted with it. Delete ${rec.name}?`))) return;
    open = null;
    const entry = ctx.store.moveToTrash([['lipids', rec.id], ...u.lots.map((x) => ['lipidLots', x.id])], { kind: 'lipid', label: `lipid ${rec.name}${u.lots.length ? ` and ${plural(u.lots.length, 'lot')}` : ''}` });
    if (entry) toast(`Deleted ${rec.name}`, '', { action: 'Undo', onAction: () => {
      const r = ctx.store.restoreFromTrash(entry.id);
      if (!r.ok) { toast(`Not restored: ${r.reason}`, 'warn'); return; }
      toast(`Restored ${rec.name}`, 'ok'); draw();
    } });
    draw();
  }

  /**
   * Archive a shipped lipid (spec 9.5): it is reference data, so it is never deleted, but a lab that does not use
   * it can take it out of its lists and pickers. The question says where it is used first.
   */
  async function archiveShipped(key) {
    const l = getRef(ctx).lipidByKey[key];
    if (!l) return;
    const users = lipidUsers(lipidUse(key));
    const q = `${users.length ? `${l.name} is used by ${listIds(users)}. ` : ''}It ships with the app, so it is not deleted. Archive it? It is hidden from lists and pickers${users.length ? ', those records keep it' : ''}, and it can be restored.`;
    await offerArchive(ctx, 'lipid', key, l.name, q, draw);
  }

  /** Track freeze–thaw for a lipid: kept on the user's record of it, laid over a shipped lipid by key. */
  function toggleTrack(key, on) {
    const own = ctx.store.all('lipids').find((x) => x.key === key);
    ctx.store.put('lipids', { ...(own || { id: key, key }), trackFT: !!on });
    const name = getRef(ctx).lipidByKey[key]?.name || key;
    toast(on ? `${name}: freeze–thaw cycles of its lots are counted` : `${name}: freeze–thaw no longer tracked`, 'ok');
    draw();
  }

  async function saveLot() {
    const ref = getRef(ctx), ed = body.querySelector('[data-editor]');
    if (!ed || !open) return;
    const f = readEditor(ed);
    f.lot = (f.lot || '').trim();
    if (!f.lot) { toast('Lot number required', 'warn'); return; }
    const id = open.lot || uid();
    const twin = ref.lipidLots.find((x) => x.id !== id && x.lipidKey === f.lipidKey && x.lot === f.lot);
    if (twin && !(await ask(`${ref.lipidByKey[f.lipidKey]?.name || f.lipidKey} already has a lot ${f.lot}. Keep a second record with the same number?`))) return;
    const before = open.lot ? ctx.store.get('lipidLots', id) : null;
    ctx.store.put('lipidLots', { ...(before || {}), ...f, id });
    toast(before ? `Lot ${f.lot} saved` : 'Lot added', 'ok');
    open = null; draw();
  }

  /**
   * Delete a lot. One that stocks were weighed from stays in the store (spec 9.5): their purity correction, and
   * with it every planned mass, is read from it. It is archived instead, after a question that names them. (0.15
   * deleted it and left a copy on each stock, stock.lotRecords; stocks.js still reads such a copy.)
   */
  async function deleteLot() {
    const lot = ctx.store.get('lipidLots', open?.lot);
    if (!lot) return;
    const used = stocksUsing(lot.id);
    if (used.length) {
      if (!(await ask(archiveQuestion(`Lot ${lot.lot}`, `was weighed into ${plural(used.length, 'stock')} (${listIds(used)}), which read its purity (${lot.purityPct ?? '?'} %) from it`)))) return;
      open = null;
      archiveWithUndo(ctx, 'lipidLot', lot.id, `lot ${lot.lot}`, draw);
      return;
    }
    open = null;
    const entry = ctx.store.moveToTrash([['lipidLots', lot.id]], { kind: 'lipid lot', label: `lot ${lot.lot} of ${getRef(ctx).lipidByKey[lot.lipidKey]?.name || lot.lipidKey}` });
    if (entry) toast(`Deleted lot ${lot.lot}`, '', { action: 'Undo', onAction: () => {
      const r = ctx.store.restoreFromTrash(entry.id);
      if (!r.ok) { toast(`Not restored: ${r.reason}`, 'warn'); return; }
      toast(`Restored lot ${lot.lot}`, 'ok'); draw();
    } });
    draw();
  }

  function addLot() {
    const f = readForm(body.querySelector('#lotForm'));
    if (!f.lot) { toast('Lot number required', 'warn'); return; }
    ctx.store.put('lipidLots', { id: uid(), ...f });
    toast('Lot added', 'ok'); draw();
  }
  function addLipid() {
    const f = readForm(body.querySelector('#lipidForm'));
    if (!f.key || !f.mw) { toast('Key and MW required', 'warn'); return; }
    ctx.store.put('lipids', { id: f.key, key: f.key.replace(/\s+/g, ''), name: f.name || f.key, class: f.class, mw: f.mw });
    toast('Lipid added', 'ok'); draw();
  }

  const reopen = (o) => { open = o; draw(); focusEditor(body, '[name=e_lot]'); };
  const shippedLipid = (key) => (ctx.data.lipids || []).some((l) => l.key === key);
  wire(body, {
    lot: (b) => reopen(open?.lot === b.dataset.id ? null : { lot: b.dataset.id }),
    addlot: (b) => reopen(open?.add === b.dataset.key ? null : { add: b.dataset.key }),
    lipid: (b) => { open = open?.lipid === b.dataset.key ? null : { lipid: b.dataset.key }; draw(); focusEditor(body); },
    archlipid: (b) => archiveShipped(b.dataset.key),
    track: (b) => toggleTrack(b.dataset.key, !tracksThaw(getRef(ctx).lipidByKey[b.dataset.key])),
    save: () => (open?.lipid ? saveLipid() : saveLot()), delete: deleteLot, dellipid: deleteLipid,
    cancel: () => { open = null; draw(); },
  });
  // A thaw of the open lot is stored at once, on the lot as it is stored (not on what is typed in the editor).
  wireThaw(body, 'lot', {
    get: () => ctx.store.get('lipidLots', open?.lot),
    set: (next) => { ctx.store.put('lipidLots', next); toast(`Lot ${next.lot}: ${ftWords(next)}`, 'ok'); draw(); },
    operator: getSettings(ctx).operator,
  });
  draw();
}

/* ---------------- Compositions ---------------- */

/**
 * Who uses a composition (calc/usage.js): the formulations (and how many of them are past planning), the lipid
 * stocks, and the experiments planned from it.
 */
function compositionUse(ctx, id) {
  const by = usesBy(whereUsed(ctx.store, 'composition', id));
  const u = { batches: by.batches || [], made: 0, exps: new Set(), stocks: by.stocks || [], experiments: by.experiments || [] };
  for (const bid of u.batches) {
    const b = ctx.store.get('batches', bid);
    if (b?.status && b.status !== 'planned') u.made++;
    if (b?.experimentId) u.exps.add(b.experimentId);
  }
  return u;
}
const usedAtAll = (u) => !!(u && (u.batches.length || u.stocks.length || u.experiments.length));
const useSummary = (u) => (usedAtAll(u)
  ? [u.batches.length ? plural(u.batches.length, 'formulation') : '', u.stocks.length ? plural(u.stocks.length, 'stock') : '', !u.batches.length && u.experiments.length ? plural(u.experiments.length, 'experiment') : ''].filter(Boolean).join(' · ') : '');

/**
 * What changing a recipe does to the records that use it. Formulations hold only `compositionId`: their recipe
 * is read from the registry each time they are shown (calc/composition.js, overriddenComposition, with a run's
 * own class override laid over it), so they follow the edit, made ones included. A lipid stock stores the mol%
 * and the amounts it was weighed with, so it keeps them.
 */
function useConsequence(id, u, nextId) {
  const parts = [];
  const one = u.batches.length === 1;
  if (u.batches.length) parts.push(`${plural(u.batches.length, 'formulation')} (in ${listIds([...u.exps])}) ${one ? 'reads its' : 'read their'} recipe from #${id}: from now on ${one ? 'it shows' : 'they show'} and ${one ? 'calculates' : 'calculate'} with the new mol%${u.made ? (one ? ', although it is already made or under way' : `, including the ${u.made} already made or under way`) : ''}.`);
  if (u.stocks.length) parts.push(`${plural(u.stocks.length, 'lipid stock')} (${listIds(u.stocks)}) ${u.stocks.length === 1 ? 'keeps the recipe and amounts it was' : 'keep the recipe and amounts they were'} weighed with.`);
  if (u.batches.length) parts.push(`To leave ${one ? 'that formulation' : 'the formulations'} as ${one ? 'it is' : 'they are'}, use "Save as new composition #${nextId}" instead.`);
  return parts;
}

const sumOf = (mol) => Math.round(Object.values(mol || {}).reduce((a, b) => a + Number(b || 0), 0) * 1000) / 1000;
const sameRecipe = (a, b) => { const k = (o) => JSON.stringify(Object.entries(o || {}).map(([x, v]) => [x, Number(v)]).sort()); return k(a) === k(b); };

function compositions(body, ctx) {
  // The composition open in the editor (its id), or {copyOf: id} for an edited copy of a shipped one; `edit`
  // holds what is typed in it, so adding a lipid row keeps the rest.
  let open = null, edit = null;
  const shipped = (id) => !!ctx.data.compositionById[id];
  // Above every number ever given out, the trash included: a deleted composition restored later must not find
  // its number taken by a newer one.
  const nextId = (ref) => {
    const trashed = ctx.store.all('trash').flatMap((t) => (t.records || []).filter((r) => r.col === 'compositions').map((r) => Number(r.rec?.id) || 0));
    return Math.max(0, ...ref.compositions.map((c) => Number(c.id) || 0), ...trashed) + 1;
  };
  // The active lipids, and one already in the recipe even when it has been archived since.
  const lipidOptions = (ref, chosen) => [{ value: '', label: '—' }, ...ref.pick('lipids', chosen).map((l) => ({ value: l.key, label: `${l.name} · ${lipidClassInfo(l.class).label}` }))];

  function draw() {
    const ref = getRef(ctx), next = nextId(ref);
    const rows = [];
    // Archived ones leave the registry (spec 9.5); the Archived card above the tabs lists them.
    for (const c of ref.active.compositions.slice().reverse()) {
      const here = open === c.id || open?.copyOf === c.id, sum = sumOf(c.mol_pct);
      rows.push({ attrs: `class="mat-row${here ? ' mat-open' : ''}" data-open="${esc(c.id)}" tabindex="0" aria-expanded="${here}" title="${shipped(c.id) ? 'Shipped reference: click to copy it' : 'Click to edit'}"`, cells: [
        m(`<b>${esc(c.id)}</b>`), c.synonym || '', m(compositionBar(c.mol_pct, ref)),
        m(`${fmt(sum, 1)}${Math.abs(sum - 100) > 0.05 ? ' ' + chip('not 100', 'warn') : ''}`),
        m(shipped(c.id) ? chip('reference, read-only') : chip(c.history?.length ? 'yours, edited' : 'yours', 'info')),
        m(useSummary(compositionUse(ctx, c.id)) || '<span class="muted">—</span>')] });
      if (here) rows.push({ attrs: 'class="mat-editor"', full: shipped(c.id) && open === c.id ? shippedNote(c) : compEditor(ref, c, compositionUse(ctx, c.id), next) });
    }
    body.innerHTML = `<div class="card"><h2>Composition registry (${ref.active.compositions.length})</h2>
      <p class="muted small">Click a composition to change its name, lipids or mol%. The shipped reference recipes stay as they are; open one to edit a copy.</p>
      ${lipidClassLegend()}
      ${editTable(['#', 'Synonym', 'Composition (mol%)', 'Sum', 'Source', 'Used by'], rows)}</div>
    <div class="card"><h2>New composition #${next}</h2><div id="compForm">
      <div class="grid g3">${field({ id: 'id', label: 'Number', value: next, step: 1 })}${field({ id: 'synonym', label: 'Synonym', type: 'text' })}</div>
      <div class="grid g4" style="margin-top:8px">
      ${[0, 1, 2, 3, 4, 5].map((i) => `<div style="display:flex;gap:6px;align-items:end">${field({ id: 'k' + i, label: i === 0 ? 'Lipid' : '', type: 'select', options: lipidOptions(ref) })}${field({ id: 'p' + i, label: i === 0 ? 'mol%' : '', step: 0.1, width: '90px' })}</div>`).join('')}
      </div><div id="compPreview" style="margin-top:10px"></div></div><div style="margin-top:10px"><button class="primary" id="addComp">Add composition</button> <span class="muted" id="compSum"></span></div></div>`;
    body.querySelector('#compForm').addEventListener('input', () => {
      const f = readForm(body.querySelector('#compForm'));
      const p = recipeOf({ rows: [0, 1, 2, 3, 4, 5].map((i) => ({ k: f['k' + i], p: f['p' + i] })) });
      body.querySelector('#compSum').textContent = `sum ${fmt(p.sum, 1)} %${p.twice.length ? ` · listed twice: ${p.twice.join(', ')}` : ''}`;
      body.querySelector('#compPreview').innerHTML = Object.keys(p.mol_pct).length ? compositionBar(p.mol_pct, ref) : '';
    });
    body.querySelector('#addComp').addEventListener('click', addComp);
  }

  function shippedNote(c) {
    return `<div class="mat-editor"><h3>#${esc(c.id)}${c.synonym ? ' ' + esc(c.synonym) : ''}: shipped reference, read-only</h3>
      <p class="muted" style="margin:0">The recipes that ship with the app stay as they are, so #${esc(c.id)} means the same recipe in every lab and every export. Edit a copy instead: it gets the next free number and is yours to change.</p>
      <div class="mat-actions"><button class="primary" data-act="copy" data-id="${esc(c.id)}">Edit a copy</button><button data-act="cancel">Close</button></div></div>`;
  }

  function compEditor(ref, c, u, next) {
    const copy = open?.copyOf != null;
    const used = !copy && u && (u.batches.length || u.stocks.length);
    const prov = copy ? '' : ` ${provenanceBadge(c, { id: 'provComposition' })}`;
    const preview = recipeOf(edit);
    const rows = edit.rows.map((r, i) => `<div style="display:flex;gap:6px;align-items:center">
        <select name="c_k${i}" aria-label="Lipid ${i + 1}" style="flex:1 1 auto;min-width:0">${lipidOptions(ref, r.k).map((o) => `<option value="${esc(o.value)}"${o.value === r.k ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
        <input type="number" name="c_p${i}" step="0.1" value="${esc(r.p ?? '')}" aria-label="mol% of lipid ${i + 1}" style="width:84px;flex:none">
        <button type="button" data-act="droprow" data-i="${i}" title="Remove this lipid" aria-label="Remove lipid ${i + 1}" style="padding:2px 8px;min-height:0">×</button></div>`).join('');
    const history = !copy && c.history?.length ? `<details style="margin-top:10px"><summary class="muted">Earlier recipes of #${esc(c.id)} (${c.history.length})</summary>
        ${c.history.slice().reverse().map((h) => `<div style="margin:6px 0"><span class="muted">until ${esc(fmtDate(h.changedAt?.slice(0, 10)))}</span>${compositionBar(h.mol_pct, ref)}</div>`).join('')}</details>` : '';
    return `<div class="mat-editor" data-editor><h3>${copy ? `New composition #${next}, a copy of #${esc(open.copyOf)}` : `Composition #${esc(c.id)}`}${prov}</h3>
      ${used ? `<div class="note warn">${useConsequence(c.id, u, next).map(esc).join(' ')}</div>` : ''}
      <div class="grid g3"><div><label for="c_synonym">Name / synonym</label><input type="text" id="c_synonym" name="c_synonym" value="${esc(edit.synonym)}"></div></div>
      <div class="mat-comp-rows">${rows}</div>
      <div style="margin-top:6px"><button type="button" class="mat-add" data-act="addrow">+ Add a lipid</button></div>
      <div id="compEditPreview" style="margin-top:10px">${previewHtml(preview, ref)}</div>
      ${history}
      ${actionsRow(copy ? `Save as #${next}` : 'Save', copy ? '' : `<button data-act="savenew">Save as new composition #${next}</button><button class="mat-danger" data-act="delete">Delete</button>`)}</div>`;
  }
  const previewHtml = (p, ref) => (Object.keys(p.mol_pct).length ? `${compositionBar(p.mol_pct, ref)}<div class="muted" style="margin-top:4px">sum ${fmt(p.sum, 1)} %${p.twice.length ? ` · listed twice: ${esc(p.twice.join(', '))}` : ''}</div>` : '<span class="muted">No lipids yet.</span>');

  /** The recipe typed into the editor: lipids with mol% above 0; a lipid named twice is flagged, not added up. */
  function recipeOf(e) {
    const mol_pct = {}, twice = [];
    for (const r of e.rows) if (r.k && Number(r.p) > 0) { if (r.k in mol_pct) twice.push(r.k); else mol_pct[r.k] = Number(r.p); }
    return { mol_pct, sum: sumOf(mol_pct), twice };
  }
  function readEdit() {
    const ed = body.querySelector('[data-editor]');
    if (!ed || !edit) return;
    edit.synonym = ed.querySelector('[name=c_synonym]').value;
    edit.rows = edit.rows.map((r, i) => {
      const p = ed.querySelector(`[name=c_p${i}]`).value;
      return { k: ed.querySelector(`[name=c_k${i}]`).value, p: p === '' ? null : Number(p) };
    });
  }
  function startEdit(c, copyOf = null) {
    edit = { synonym: copyOf != null ? `${c.synonym || '#' + c.id} (copy)` : c.synonym || '', rows: [...Object.entries(c.mol_pct || {}).map(([k, p]) => ({ k, p })), { k: '', p: null }] };
    open = copyOf != null ? { copyOf } : c.id;
    draw(); focusEditor(body);
  }

  /** The checks the Add form has always made, so a recipe is held to the same rule however it was entered. */
  async function checked(p) {
    if (p.twice.length) { toast(`${p.twice.map((k) => getRef(ctx).lipidByKey[k]?.name || k).join(', ')} is listed twice`, 'warn'); return false; }
    if (!Object.keys(p.mol_pct).length) { toast('Add at least one lipid', 'warn'); return false; }
    // Awaited: in the macOS app the answer comes back as a promise (ask() in ./kit.js).
    if (Math.abs(p.sum - 100) > 0.05 && !(await ask(`Sum is ${p.sum.toFixed(1)} %, not 100 %. Save anyway?`))) return false;
    return true;
  }

  async function save(asNew) {
    readEdit();
    const ref = getRef(ctx), p = recipeOf(edit), synonym = edit.synonym.trim() || null;
    if (!(await checked(p))) return;
    if (asNew || open?.copyOf != null) {
      const id = nextId(ref), from = open?.copyOf ?? open;
      // Typed in here (spec 4.3): written as such, so the provenance symbol says so without guessing.
      ctx.store.put('compositions', { id, synonym, mol_pct: p.mol_pct, sum: p.sum, copiedFrom: from, provenance: provenance('manual') });
      toast(`Composition #${id} added`, 'ok');
    } else {
      const old = ctx.store.get('compositions', open);
      if (!old) { toast(`#${open} is no longer on record`, 'warn'); open = null; draw(); return; }
      const changed = !sameRecipe(old.mol_pct, p.mol_pct);
      const u = compositionUse(ctx, old.id);
      if (changed && u && (u.batches.length || u.stocks.length)
        && !(await ask(`Change the recipe of composition #${old.id}?\n\n${useConsequence(old.id, u, nextId(ref)).join('\n\n')}`))) return;
      // The recipe it had is kept on the record, so what an older formulation was planned with can still be read.
      const history = changed ? [...(old.history || []), { changedAt: new Date().toISOString(), mol_pct: old.mol_pct, sum: old.sum ?? sumOf(old.mol_pct) }] : old.history;
      ctx.store.put('compositions', { ...old, synonym, mol_pct: p.mol_pct, sum: p.sum, ...(history ? { history } : {}) });
      toast(`Composition #${old.id} saved`, 'ok');
    }
    open = null; edit = null; draw();
  }

  async function del() {
    const c = ctx.store.get('compositions', open);
    if (!c) return;
    const u = compositionUse(ctx, c.id);
    // A recipe anything names stays in the store (spec 9.5): a formulation holds only the composition's number and
    // reads its mol% from here, so without it the record could no longer say what went into it, nor work out its
    // N/P, its lipid amounts or its place in a model; a lipid stock and an experiment name it as their recipe too.
    // It can be archived instead. (0.15 let a recipe only stocks used go, since a stock keeps its own mol%.)
    if (usedAtAll(u)) {
      const who = [u.batches.length ? `${plural(u.batches.length, 'formulation')} (${listIds(u.batches)})` : '', u.stocks.length ? `${plural(u.stocks.length, 'lipid stock')} (${listIds(u.stocks)})` : '',
        !u.batches.length && u.experiments.length ? `${plural(u.experiments.length, 'experiment')} (${listIds(u.experiments)})` : ''].filter(Boolean).join(' and ');
      if (!(await ask(archiveQuestion(`#${c.id}`, `is the recipe of ${who}`)))) return;
      open = null; edit = null;
      archiveWithUndo(ctx, 'composition', c.id, `composition #${c.id}`, draw);
      return;
    }
    open = null; edit = null;
    trashWithUndo(ctx, 'compositions', c.id, 'composition', `composition #${c.id}${c.synonym ? ' ' + c.synonym : ''}`, draw);
  }

  async function addComp() {
    const ref = getRef(ctx);
    const f = readForm(body.querySelector('#compForm'));
    const rows = [0, 1, 2, 3, 4, 5].map((i) => ({ k: f['k' + i], p: f['p' + i] }));
    const p = recipeOf({ rows });
    if (!Number.isInteger(f.id) || f.id < 1) { toast('The number must be a whole number above 0', 'warn'); return; }
    if (ref.compositionById[f.id]) { toast(`#${f.id} is taken; the next free number is ${nextId(ref)}`, 'warn'); return; }
    if (!(await checked(p))) return;
    ctx.store.put('compositions', { id: f.id, synonym: f.synonym || null, mol_pct: p.mol_pct, sum: p.sum, provenance: provenance('manual') });
    toast(`Composition #${f.id} added`, 'ok'); draw();
  }

  body.addEventListener('input', (e) => {
    if (!/^c_/.test(e.target.name || '')) return;
    readEdit();
    const box = body.querySelector('#compEditPreview');
    if (box) box.innerHTML = previewHtml(recipeOf(edit), getRef(ctx));
  });
  body.addEventListener('change', (e) => { if (/^c_/.test(e.target.name || '')) readEdit(); });
  wire(body, {
    save: () => save(false), savenew: () => save(true), delete: del,
    cancel: () => { open = null; edit = null; draw(); },
    copy: (b) => { const c = getRef(ctx).compositionById[b.dataset.id]; if (c) startEdit(c, c.id); },
    addrow: () => { readEdit(); edit.rows.push({ k: '', p: null }); draw(); body.querySelector(`[name=c_k${edit.rows.length - 1}]`)?.focus({ preventScroll: true }); },
    droprow: (b) => { readEdit(); edit.rows.splice(Number(b.dataset.i), 1); if (!edit.rows.length) edit.rows.push({ k: '', p: null }); draw(); },
  }, (id) => {
    const c = getRef(ctx).compositionById[id];
    if (!c || open === c.id || open?.copyOf === c.id) { open = null; edit = null; draw(); return; }
    if (shipped(c.id)) { open = c.id; edit = null; draw(); focusEditor(body); return; }
    startEdit(c);
  });
  draw();
}

/* ---------------- RNA lots, buffer catalog ---------------- */

/**
 * The formulations and experiments that name an RNA lot (plan.rna.lotId, the wizard's spec.rnaLotId), from
 * calc/usage.js, in the two lists this tab words its notes with.
 */
export function rnaLotUse(store, id) {
  const by = usesBy(whereUsed(store, 'rnaLot', id));
  return { batches: by.batches || [], exps: by.experiments || [] };
}

function rna(body, ctx) {
  // Which lot is open: its id, NEW for a new one, null for none.
  const NEW = '\u0000new';
  let open = null;

  function draw() {
    const ref = getRef(ctx), rows = [];
    // Archived lots leave the table (spec 9.5); the Archived card above the tabs lists them.
    for (const r of ref.active.rnaLots) {
      const here = open === r.id, u = rnaLotUse(ctx.store, r.id);
      rows.push({ attrs: `class="mat-row${here ? ' mat-open' : ''}" data-open="${esc(r.id)}" tabindex="0" aria-expanded="${here}" title="Click to edit"`, cells: [
        m(`<b>${esc(r.id)}</b>`), m(chip(cargoLabel(r.cargo), r.cargo === 'siRNA' ? 'info' : '')), r.construct || '', r.variant || '', fmt(r.conc_mg_mL, 2),
        fmt(lotMassPerPhosphate(r), 0), r.method || '', fmtDate(r.received),
        m(u.batches.length ? plural(u.batches.length, 'formulation') : '<span class="muted">—</span>')] });
      if (here) rows.push({ attrs: 'class="mat-editor"', full: editor(r, ref) });
    }
    if (open === NEW) rows.push({ attrs: 'class="mat-editor"', full: editor(null, ref) });
    body.innerHTML = `<div class="card"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
        <h2 style="margin:0;flex:1 1 auto">RNA lots (${ref.active.rnaLots.length})</h2><button type="button" data-act="new"${open === NEW ? ' disabled' : ''}>+ Add RNA lot</button></div>
      <p class="muted small" style="margin:0 0 8px">Each lot says its cargo, mRNA or siRNA: an experiment made from it is labelled with it, and its N/P is worked out with the cargo's mass per phosphate. Click a lot to correct it.</p>
      ${editTable(['Lot', 'Cargo', 'Construct', 'Variant / notes', { label: 'mg/mL', right: true }, { label: 'g/mol per P', right: true }, 'Method', 'Received', 'Used by'], rows, 'No RNA lots yet. Add one with "+ Add RNA lot".')}</div>`;
  }

  /** The cargo a new lot starts with: the one the lab entered last, which is the one it is most likely making. */
  const lastCargo = () => { const lots = ctx.store.all('rnaLots'); return cargoInfo(lots[lots.length - 1]?.cargo).id; };

  function editor(r, ref) {
    const u = r ? rnaLotUse(ctx.store, r.id) : { batches: [], exps: [] };
    const used = u.batches.length + u.exps.length > 0;
    const cargo = cargoInfo(r?.cargo || (r ? null : lastCargo()));
    return `<div class="mat-editor" data-editor><h3>${r ? `RNA lot ${esc(r.id)}` : 'New RNA lot'}</h3>
      ${used ? `<div class="note">Chosen on ${u.batches.length ? `${plural(u.batches.length, 'formulation')} (${esc(listIds(u.batches))})` : ''}${u.batches.length && u.exps.length ? ' and ' : ''}${u.exps.length ? `${plural(u.exps.length, 'experiment')} (${esc(listIds(u.exps))})` : ''}. They name it by its lot number, which therefore stays. A corrected concentration shows on the formulations that take theirs from the lot; each keeps the cargo it was planned with.</div>` : ''}
      <div class="grid g4">
        ${efield({ id: 'id', label: 'Lot number', type: 'text', value: r?.id || '', placeholder: 'RNA-001', disabled: used })}
        ${efield({ id: 'cargo', label: 'Cargo', type: 'select', value: cargo.id, options: CARGO_TYPES.map((c) => ({ value: c.id, label: `${c.label} · ${c.note}` })) })}
        ${efield({ id: 'construct', label: 'Construct / target', type: 'text', value: r?.construct || '', placeholder: 'FLuc, eGFP, TTR …' })}
        ${efield({ id: 'conc_mg_mL', label: 'Stock concentration (mg/mL)', value: r?.conc_mg_mL ?? '', step: 0.01 })}
        ${efield({ id: 'method', label: 'Concentration method', type: 'text', value: r?.method || '', placeholder: 'UV, RiboGreen' })}
        ${efield({ id: 'massPerPhosphate', label: 'Mass per phosphate (g/mol)', value: r?.massPerPhosphate ?? '', step: 0.1, placeholder: String(cargo.massPerPhosphate), hint: `For the N/P. Empty: ${cargo.massPerPhosphate} g/mol, the ${cargo.label} default (see Reference)` })}
        ${efield({ id: 'length_nt', label: cargo.id === 'siRNA' ? 'Length (bp)' : 'Length (nt)', value: r?.length_nt ?? '', step: 1 })}
        ${efield({ id: 'received', label: 'Received', type: 'date', value: r?.received || todayISO() })}
        ${efield({ id: 'variant', label: 'Variant / description', type: 'text', value: r?.variant || '' })}
        ${efield({ id: 'supplier', label: 'Supplier', type: 'text', value: r?.supplier || '' })}
        ${wide(efield({ id: 'notes', label: 'Notes', type: 'text', value: r?.notes || '' }))}
      </div>
      ${actionsRow(r ? 'Save' : 'Add RNA lot', r ? '<button class="mat-danger" data-act="delete">Delete lot</button>' : '')}</div>`;
  }

  function save() {
    const ed = body.querySelector('[data-editor]');
    if (!ed) return;
    const f = readEditor(ed);
    const before = open !== NEW ? ctx.store.get('rnaLots', open) : null;
    const id = before ? before.id : String(f.id || '').trim();
    if (!id) { toast('Lot number required', 'warn'); return; }
    if (!(Number(f.conc_mg_mL) > 0)) { toast('Stock concentration required', 'warn'); return; }
    if (!before && ctx.store.get('rnaLots', id)) { toast(`${id} is on record already`, 'warn'); return; }
    // A lot not yet used can still have its number corrected: the record moves to the new id.
    const renamed = before && f.id && String(f.id).trim() !== before.id && !(rnaLotUse(ctx.store, before.id).batches.length + rnaLotUse(ctx.store, before.id).exps.length);
    const newId = renamed ? String(f.id).trim() : id;
    if (renamed && ctx.store.get('rnaLots', newId)) { toast(`${newId} is on record already`, 'warn'); return; }
    const rec = { ...(before || {}), ...f, id: newId, cargo: cargoInfo(f.cargo).id, massPerPhosphate: Number(f.massPerPhosphate) > 0 ? Number(f.massPerPhosphate) : null };
    if (renamed) ctx.store.transaction(() => { ctx.store.remove('rnaLots', before.id); ctx.store.put('rnaLots', rec); }, { what: `RNA lot ${newId}` });
    else ctx.store.put('rnaLots', rec);
    toast(before ? `RNA lot ${newId} saved` : 'RNA lot added', 'ok');
    open = null; draw();
  }

  async function del() {
    const lot = ctx.store.get('rnaLots', open);
    if (!lot) return;
    const u = rnaLotUse(ctx.store, lot.id);
    // A lot a formulation or an experiment names stays in the store (spec 9.5): they take its concentration
    // (the dilution), its cargo and its mass per phosphate (the N/P) from it. It is archived instead. (0.15
    // deleted it and copied those onto each plan; such a record still reads its own copy.)
    if (u.batches.length + u.exps.length) {
      const who = [u.batches.length ? `${plural(u.batches.length, 'formulation')} (${listIds(u.batches)})` : '', u.exps.length ? `${plural(u.exps.length, 'experiment')} (${listIds(u.exps)})` : ''].filter(Boolean).join(' and ');
      if (!(await ask(archiveQuestion(`RNA lot ${lot.id}`, `is chosen on ${who}, which take its concentration (${fmt(lot.conc_mg_mL, 2)} mg/mL) and cargo (${cargoLabel(lot.cargo)}) from it`)))) return;
      open = null;
      archiveWithUndo(ctx, 'rnaLot', lot.id, `RNA lot ${lot.id}`, draw);
      return;
    }
    open = null;
    const entry = ctx.store.moveToTrash([['rnaLots', lot.id]], { kind: 'RNA lot', label: `RNA lot ${lot.id}${lot.construct ? ' · ' + lot.construct : ''}` });
    if (!entry) { draw(); return; }
    toast(`Deleted RNA lot ${lot.id}`, '', { action: 'Undo', onAction: () => {
      const r = ctx.store.restoreFromTrash(entry.id);
      if (!r.ok) { toast(`Not restored: ${r.reason}`, 'warn'); return; }
      toast(`Restored RNA lot ${lot.id}`, 'ok'); draw();
    } });
    draw();
  }

  wire(body, {
    new: () => { open = NEW; draw(); focusEditor(body); },
    cancel: () => { open = null; draw(); },
    save, delete: del,
  }, (id) => { open = open === id ? null : id; draw(); if (open) focusEditor(body); });
  // The default mass per phosphate follows the cargo chosen, in the placeholder and the hint.
  body.addEventListener('change', (e) => {
    if (e.target.name !== P + 'cargo') return;
    const c = cargoInfo(e.target.value), mpp = body.querySelector(`[name=${P}massPerPhosphate]`);
    if (mpp) { mpp.placeholder = String(c.massPerPhosphate); const h = mpp.parentElement.querySelector('.muted'); if (h) h.textContent = `For the N/P. Empty: ${c.massPerPhosphate} g/mol, the ${c.label} default (see Reference)`; }
  });
  draw();
}

/**
 * The common buffers, with the lot code each one's lots are named with (spec 9.2: the code is kept per buffer in
 * the catalogue and can be edited). The shipped code stays in the shipped list; the lab's own is a record of its
 * own (collection `bufferCatalog`, {id: the buffer's name, code}), laid over it by refdata.js as 0.15 lays an
 * edited device over a shipped one. Emptied, the shipped code is back. A lot already made keeps the name it was
 * given: that name is on the bottle.
 */
function buffers(body, ctx) {
  function draw() {
    const ref = getRef(ctx), today = todayISO();
    const lotsOf = (b) => ref.buffers.filter((x) => x.name === b.name || (x.code && x.code === b.code)).sort((a, c) => String(c.date || '').localeCompare(String(a.date || '')));
    body.innerHTML = `<div class="card"><h2>Buffer catalog</h2><p class="muted">Standard recipes to start from. A buffer you actually make is recorded on the <a href="#/buffers">Buffers</a> screen and gets a lot name there: <b>code-pH-date</b>, with the code below. Change a code to your lab's own; a lot already made keeps its name.</p>
      ${editTable(['Name', 'Code', 'For', 'Prepared lots'], ref.buffersCatalog.map((b, i) => {
        const lots = lotsOf(b);
        return { attrs: `data-buffer="${esc(b.name)}"`, cells: [m(`<a href="#/buffers?new=1&from=${i}">${esc(b.name)}</a>`),
          m(`<input type="text" data-code="${esc(b.name)}" value="${esc(b.code || '')}" aria-label="Lot code of ${esc(b.name)}" style="width:130px;text-transform:uppercase">${b.shippedCode ? ` <span class="muted small">shipped: ${esc(b.shippedCode)}</span>` : ''}`),
          normaliseRoles(b.roles).map(roleLabel).join(', '),
          m(lots.length ? `${plural(lots.length, 'lot')} · newest <a href="#/buffers?id=${encodeURIComponent(lots[0].id)}">${esc(lots[0].lot)}</a>${lots[0].expiry && lots[0].expiry < today ? ' ' + chip('expired', 'warn') : ''}` : '<span class="muted">–</span>')] };
      }))}</div>`;
  }
  // A change arrives as the field is left, on the way to the next one: the table is drawn again once the user is
  // there (redrawSoon), not under the field being left.
  body.addEventListener('change', (e) => {
    const t = e.target.closest('input[data-code]');
    if (!t) return;
    const ref = getRef(ctx), name = t.dataset.code, shipped = (ctx.data.buffers_catalog || []).find((b) => b.name === name);
    const r = checkBufferCode(t.value, name, ref.buffersCatalog);
    if (r.error) toast(r.error, 'warn');
    else if (!r.code || r.code === shipped?.code) { ctx.store.remove('bufferCatalog', name); toast(`${name}: code ${shipped?.code || ''} as shipped`, 'ok'); }
    else { ctx.store.put('bufferCatalog', { id: name, code: r.code }); toast(`${name}: new lots are named ${r.code}-pH…`, 'ok'); }
    redrawSoon(body, draw);
  });
  draw();
}

/* ---------------- devices, TFF modules, dialysis: lists the user can extend ---------------- */

/**
 * One editable list of shipped entries and the user's own, in its own card: devices, mixers, TFF modules,
 * dialysis devices. `spec`:
 *   col        the store collection the user's records go to (refdata.js merges it by id)
 *   shipped    the shipped entries, with ids
 *   items(ref) the merged list, as every other screen sees it
 *   title, noun, intro, footer(ref)
 *   headers, cells(x, ref)       the table
 *   form(x, ref, use)            the editor's fields (efield), x = null for a new one
 *   read(f, x, ref)              the fields to store, or a string saying what is wrong
 *   label(x)                     how the entry is named in notes
 *   kind                         its kind in calc/usage.js, which says which records name it
 *   usedBy(x, ref, ids)          {text, locked: [field names], keep: reason} for the editor and the question,
 *                                given the formulation records that name it (ids), or null
 *
 * An entry records name is never removed from the store (spec 9.5): Delete (one's own) and Hide (a shipped one)
 * say where it is used and offer to archive it instead. 0.15 deleted or hid it and wrote a copy onto each record
 * (plan.process.deviceRecord, mixerRecord, a TFF step's moduleRecord); calc/process.js still reads those copies
 * on the records that have one.
 */
function catalogue(box, ctx, spec) {
  const NEW = '\u0000new';
  let open = null;
  const shippedIds = new Set(spec.shipped.map((s) => s.id));
  /** What names an entry: the formulation records (from calc/usage.js), worded by the tab. */
  const useOf = (x, ref) => {
    const ids = whereUsed(ctx.store, spec.kind, x.id, { rec: x }).map((u) => u.id);
    const use = spec.usedBy?.(x, ref, ids) || null;
    return use || ids.length ? { ...(use || {}), ids } : null;
  };

  function draw() {
    const ref = getRef(ctx), gone = archivedSet(ctx.store, spec.kind), items = spec.items(ref).filter((x) => !gone.has(String(x.id)));
    const own = new Map(ctx.store.all(spec.col).map((o) => [o.id, o]));
    const hidden = spec.shipped.filter((s) => own.get(s.id)?.deleted);
    const rows = [];
    for (const x of items) {
      const here = open === x.id;
      const source = shippedIds.has(x.id) ? (own.has(x.id) ? chip('shipped, edited', 'info') : chip('shipped')) : chip('yours', 'ok');
      rows.push({ attrs: `class="mat-row${here ? ' mat-open' : ''}" data-open="${esc(x.id)}" tabindex="0" aria-expanded="${here}" title="Click to edit"`, cells: [...spec.cells(x, ref), m(source)] });
      if (here) rows.push({ attrs: 'class="mat-editor"', full: editor(x, ref, own) });
    }
    if (open === NEW) rows.push({ attrs: 'class="mat-editor"', full: editor(null, ref, own) });
    box.innerHTML = `<div class="card"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
        <h2 style="margin:0;flex:1 1 auto">${esc(spec.title)} (${items.length})</h2><button type="button" data-act="new"${open === NEW ? ' disabled' : ''}>+ Add ${esc(spec.noun)}</button></div>
      ${spec.intro ? `<p class="muted small" style="margin:0 0 8px">${spec.intro}</p>` : ''}
      ${editTable([...spec.headers, 'Source'], rows, `No ${spec.noun}s listed. Add your own with "+ Add ${spec.noun}".`)}
      ${hidden.length ? `<p class="muted" style="margin:8px 0 0">Hidden: ${hidden.map((h) => `${esc(spec.label(h))} <button type="button" class="mat-pick" data-act="unhide" data-id="${esc(h.id)}">Show again</button>`).join(' ')}</p>` : ''}
      ${spec.footer ? spec.footer(ref) : ''}</div>`;
  }

  function editor(x, ref, own) {
    const use = x ? useOf(x, ref) : null;
    const isShipped = x && shippedIds.has(x.id);
    const extra = !x ? '' : isShipped
      ? `${own.has(x.id) ? '<button type="button" data-act="revert">Back to the shipped version</button>' : ''}<button type="button" data-act="hide">Hide from the lists</button>`
      : `<button type="button" class="mat-danger" data-act="delete">Delete</button>`;
    return `<div class="mat-editor" data-editor><h3>${x ? esc(spec.label(x)) : `New ${esc(spec.noun)}`}${isShipped ? ' <span class="muted" style="font-weight:400">· shipped; your changes are kept as your own version of it</span>' : ''}</h3>
      ${use?.text ? `<div class="note">${use.text}</div>` : ''}
      <div class="grid g4">${spec.form(x, ref, use)}</div>
      ${actionsRow(x ? 'Save' : `Add ${spec.noun}`, extra)}</div>`;
  }

  const current = () => (open && open !== NEW ? spec.items(getRef(ctx)).find((i) => i.id === open) || null : null);

  function save() {
    const ed = box.querySelector('[data-editor]');
    if (!ed) return;
    const ref = getRef(ctx), x = current();
    const f = readEditor(ed);
    const r = spec.read(f, x, ref);
    if (typeof r === 'string') { toast(r, 'warn'); return; }
    let id = x?.id;
    if (!id) {
      // A readable id from the name, unique among shipped, own and hidden entries alike.
      const taken = new Set([...shippedIds, ...ctx.store.all(spec.col).map((o) => o.id), ...ctx.store.all('trash').flatMap((t) => (t.records || []).filter((q) => q.col === spec.col).map((q) => q.rec?.id))]);
      const base = slug(spec.label(r));
      id = base; for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    }
    const stored = ctx.store.get(spec.col, id);
    ctx.store.put(spec.col, { ...(stored || {}), ...r, id });
    toast(`${x ? 'Saved' : 'Added'} ${spec.label(r)}`, 'ok');
    open = null; draw();
  }

  /** Put back what the store held for `id` before (nothing, or the earlier record). */
  const putBack = (id, before) => { if (before) ctx.store.put(spec.col, before); else ctx.store.remove(spec.col, id); draw(); };

  /** An entry records name: archived after a question that says which (spec 9.5). True when it was handled so. */
  async function archiveInstead(x) {
    const use = useOf(x, getRef(ctx));
    if (!use?.ids?.length) return false;
    if (await ask(archiveQuestion(spec.label(x), `is used by ${plural(use.ids.length, 'formulation record')} (${listIds(use.ids)})`))) { open = null; archiveWithUndo(ctx, spec.kind, x.id, spec.label(x), draw); }
    return true;
  }

  const actions = {
    new: () => { open = NEW; draw(); focusEditor(box); },
    cancel: () => { open = null; draw(); },
    save,
    // Hiding a shipped entry, or deleting one's own, that records still name is not done: it is archived instead,
    // after a question that names them, and stays in the store for them. One nothing names is hidden or deleted
    // as before, with Undo.
    hide: async () => {
      const x = current(); if (!x) return;
      if (await archiveInstead(x)) return;
      const before = ctx.store.get(spec.col, x.id);
      ctx.store.put(spec.col, { ...(before || { id: x.id }), deleted: true });
      open = null; draw();
      toast(`Hidden ${spec.label(x)}`, '', { action: 'Undo', onAction: () => putBack(x.id, before) });
    },
    revert: () => {
      const x = current(); if (!x) return;
      const use = useOf(x, getRef(ctx));
      if (use?.keep && use.locked?.some((k) => x[k] !== spec.shipped.find((s) => s.id === x.id)?.[k])) { toast(`${spec.label(x)} stays as it is: ${use.keep}`, 'warn'); return; }
      const before = ctx.store.get(spec.col, x.id);
      ctx.store.remove(spec.col, x.id);
      open = null; draw();
      toast(`${spec.label(x)} is back to the shipped version`, '', { action: 'Undo', onAction: () => putBack(x.id, before) });
    },
    delete: async () => {
      const x = current(); if (!x) return;
      if (await archiveInstead(x)) return;
      open = null;
      const entry = ctx.store.moveToTrash([[spec.col, x.id]], { kind: spec.noun, label: spec.label(x) });
      if (entry) toast(`Deleted ${spec.label(x)}`, '', { action: 'Undo', onAction: () => {
        const r = ctx.store.restoreFromTrash(entry.id);
        if (!r.ok) { toast(`Not restored: ${r.reason}`, 'warn'); return; }
        toast(`Restored ${spec.label(x)}`, 'ok'); draw();
      } });
      draw();
    },
    unhide: (b) => {
      const s = ctx.store.get(spec.col, b.dataset.id); if (!s) return;
      const { deleted, ...rest } = s;
      // A record that only ever hid the entry goes; one that also held edits keeps them.
      const edits = Object.keys(rest).filter((k) => !['id', 'createdAt', 'updatedAt'].includes(k));
      if (edits.length) ctx.store.put(spec.col, rest); else ctx.store.remove(spec.col, s.id);
      toast(`${spec.label({ ...spec.shipped.find((x) => x.id === s.id), ...rest })} is listed again`, 'ok'); draw();
    },
  };
  wire(box, actions, (id) => { open = open === id ? null : id; draw(); if (open) focusEditor(box); });
  draw();
}

/** The editor's note and the question's words for an entry `ids` (formulation records) name. */
const usedWords = (ids, verb) => ({ text: `${verb === 'names' ? 'Named by' : 'Used by'} ${plural(ids.length, 'formulation record')} (${esc(listIds(ids))}).`, keep: `${listIds(ids)} ${ids.length === 1 ? verb : verb.replace(/s$/, '')} it` });
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const req = (s) => String(s ?? '').trim();

const QUENCH = { inline: 'inline (third pump)', none: 'none (diluted offline)', optional: 'optional' };

function devices(body, ctx) {
  body.innerHTML = `<p class="muted small" style="margin:0 0 12px">The instruments and mixers the lab formulates with. Click one to change it, add your own, or hide a shipped one you do not have. Edits of a shipped entry are kept as your own version of it.</p>
    <div id="instrumentList"></div><div id="mixerList"></div>`;
  const shippedMixers = ctx.data.devices?.mixers || [];
  catalogue(body.querySelector('#instrumentList'), ctx, {
    col: 'devices', kind: 'device', shipped: ctx.data.devices?.instruments || [], items: (ref) => ref.devices,
    // A formulation names its instrument by id (plan.process.deviceId); the id never changes, so an edit is safe,
    // but a hidden or deleted instrument would leave those records naming one the designer cannot show.
    usedBy: (x, ref, ids) => (ids.length ? usedWords(ids, 'uses') : null),
    title: 'Instruments', noun: 'instrument', label: (x) => x.name || x.id,
    headers: ['Name', 'Vendor', { label: 'Pumps', right: true }, 'Mixers it takes', 'Quench', 'Notes'],
    cells: (x, ref) => [m(`<b>${esc(x.name)}</b>`), x.vendor || '', x.pumps ?? '–',
      m((x.mixers || []).map((id) => ref.mixers.find((q) => q.id === id)).filter(Boolean).map((q) => chip(q.name)).join(' ') || '<span class="muted">—</span>'),
      QUENCH[x.quench] || x.quench || '–', m(`<span class="muted">${esc(x.notes || '')}</span>`)],
    form: (x, ref) => {
      const takes = new Set(x?.mixers || []);
      return `${efield({ id: 'name', label: 'Name', type: 'text', value: x?.name || '' })}
        ${efield({ id: 'vendor', label: 'Vendor', type: 'text', value: x?.vendor || '' })}
        ${efield({ id: 'pumps', label: 'Pumps', value: x?.pumps ?? 2, step: 1, min: 1 })}
        ${efield({ id: 'quench', label: 'Quench', type: 'select', value: x?.quench || 'optional', options: Object.entries(QUENCH).map(([value, label]) => ({ value, label })) })}
        ${wide(`<label>Mixers it takes</label><div class="mat-checks">${ref.mixers.map((q) => `<label><input type="checkbox" name="${P}mixer_${esc(q.id)}" ${takes.has(q.id) ? 'checked' : ''}> ${esc(q.name)}</label>`).join('') || '<span class="muted">No mixers listed.</span>'}</div>`)}
        ${wide(efield({ id: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: x?.notes || '' }))}`;
    },
    read: (f, x, ref) => {
      if (!req(f.name)) return 'Name required';
      const pumps = num(f.pumps);
      if (pumps != null && (pumps < 1 || !Number.isInteger(pumps))) return 'Pumps: a whole number, 1 or more';
      const listed = new Set(ref.mixers.map((q) => q.id));
      // A mixer this instrument took that is hidden now stays on it, so showing the mixer again restores the pair.
      const mixers = [...ref.mixers.filter((q) => f['mixer_' + q.id]).map((q) => q.id), ...(x?.mixers || []).filter((id) => !listed.has(id))];
      return { name: req(f.name), vendor: req(f.vendor), pumps, quench: f.quench, mixers, notes: req(f.notes) };
    },
  });
  catalogue(body.querySelector('#mixerList'), ctx, {
    col: 'mixers', kind: 'mixer', shipped: shippedMixers, items: (ref) => ref.mixers,
    title: 'Mixers', noun: 'mixer', label: (x) => x.name || x.id,
    headers: ['Name', 'Kind', { label: 'Inlets', right: true }, 'Taken by', 'Notes'],
    cells: (x, ref) => [m(`<b>${esc(x.name)}</b>`), x.kind || '', x.inlets ?? '–',
      m(ref.devices.filter((d) => (d.mixers || []).includes(x.id)).map((d) => esc(d.name)).join(', ') || '<span class="muted">—</span>'), m(`<span class="muted">${esc(x.notes || '')}</span>`)],
    form: (x) => `${efield({ id: 'name', label: 'Name', type: 'text', value: x?.name || '' })}
      ${efield({ id: 'kind', label: 'Kind', type: 'text', value: x?.kind || '', placeholder: 'T-mixer, IJM, microfluidic chip …' })}
      ${efield({ id: 'inlets', label: 'Inlets', value: x?.inlets ?? 2, step: 1, min: 1 })}
      ${wide(efield({ id: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: x?.notes || '' }))}`,
    read: (f) => {
      if (!req(f.name)) return 'Name required';
      const inlets = num(f.inlets);
      if (inlets != null && (inlets < 1 || !Number.isInteger(inlets))) return 'Inlets: a whole number, 1 or more';
      return { name: req(f.name), kind: req(f.kind), inlets, notes: req(f.notes) };
    },
    // An instrument that takes a mixer is not a record that needs it: hidden or deleted, the mixer only leaves
    // that instrument's list, and is back on it when shown again.
    usedBy: (x, ref, ids) => {
      const by = ref.devices.filter((d) => (d.mixers || []).includes(x.id)).map((d) => d.name);
      if (ids.length) { const w = usedWords(ids, 'uses'); return { ...w, text: w.text.replace(/\.$/, by.length ? `; taken by ${esc(by.join(', '))}.` : '.') }; }
      return by.length ? { text: `Taken by ${esc(by.join(', '))}. Hidden or deleted, it no longer shows on ${by.length === 1 ? 'that instrument' : 'those instruments'}; shown again, it is back on them.` } : null;
    },
  });
}

const loadWindow = (sa) => `${fmt((sa / 10000 / 0.5) * 1000, 1)} – ${fmt((sa / 10000 / 0.32) * 1000, 1)}`;

function tff(body, ctx) {
  body.innerHTML = '<div id="tffList"></div>';
  catalogue(body.querySelector('#tffList'), ctx, {
    col: 'tffModules', kind: 'tffModule', shipped: (ctx.data.tff_modules || []).map((x) => ({ id: x.part, ...x })), items: (ref) => ref.tffModules,
    title: 'TFF hollow-fiber modules', noun: 'TFF module', label: (x) => x.part || x.id,
    intro: 'One representative module ships; add the ones your lab uses. A formulation record chooses from this list.',
    headers: ['Part', 'Family', 'MWCO', 'Membrane', 'Fiber ID', 'Length cm', 'Fibers', { label: 'SA cm²', right: true }, { label: 'RNA load mg (min–max)', right: true }],
    cells: (x) => [m(`<b>${esc(x.part)}</b>${x.notes ? `<div class="muted">${esc(x.notes)}</div>` : ''}`), x.family || '', x.mwco || '', x.membrane || '', x.fiber_id || '', x.length_cm ?? '', x.fibers ?? '', fmt(x.surface_cm2, 0), Number(x.surface_cm2) > 0 ? loadWindow(x.surface_cm2) : '–'],
    form: (x, ref, use) => `${efield({ id: 'part', label: 'Part number', type: 'text', value: x?.part || '', disabled: !!use?.locked?.includes('part') })}
      ${efield({ id: 'family', label: 'Family', type: 'text', value: x?.family || '' })}
      ${efield({ id: 'mwco', label: 'MWCO', type: 'text', value: x?.mwco || '100 kD' })}
      ${efield({ id: 'membrane', label: 'Membrane', type: 'text', value: x?.membrane || 'mPES' })}
      ${efield({ id: 'fiber_id', label: 'Fiber ID', type: 'text', value: x?.fiber_id || '' })}
      ${efield({ id: 'length_cm', label: 'Length cm', value: x?.length_cm ?? '', step: 0.1 })}
      ${efield({ id: 'fibers', label: 'Fibers', value: x?.fibers ?? '', step: 1 })}
      ${efield({ id: 'surface_cm2', label: 'Surface area cm²', value: x?.surface_cm2 ?? '', step: 1, hint: 'Sets the RNA load window' })}
      ${efield({ id: 'inlet', label: 'Inlet', type: 'text', value: x?.inlet || '' })}
      ${efield({ id: 'permeate', label: 'Permeate', type: 'text', value: x?.permeate || '' })}
      ${wide(efield({ id: 'notes', label: 'Notes', type: 'text', value: x?.notes || '' }))}`,
    read: (f, x, ref) => {
      if (!req(f.part)) return 'Part number required';
      if (!(num(f.surface_cm2) > 0)) return 'Surface area required: the load window is worked out from it';
      if (ref.tffModules.some((q) => q.id !== x?.id && q.part === req(f.part))) return `${req(f.part)} is listed already`;
      return { part: req(f.part), family: req(f.family), mwco: req(f.mwco), membrane: req(f.membrane), fiber_id: req(f.fiber_id), length_cm: num(f.length_cm), fibers: num(f.fibers), surface_cm2: num(f.surface_cm2), inlet: req(f.inlet), permeate: req(f.permeate), notes: req(f.notes) };
    },
    // A formulation names its module by part number (its TFF step in plan.process), so that number stays put while
    // any record with TFF switched on names it; the record would otherwise fall back to the first module listed.
    usedBy: (x, ref, ids) => (ids.length ? { ...usedWords(ids, 'names'), text: `${usedWords(ids, 'names').text} The part number stays as they name it; a changed surface area changes their load window.`, locked: ['part'] } : null),
    footer: () => '<p class="muted" style="margin:8px 0 0">Load window from the record: min = SA/10000/0.5·1000 mg, max = SA/10000/0.32·1000 mg.</p>',
  });
}

const DIALYSIS_KINDS = ['cassette', 'float device', 'tubing', 'other'];

function dialysis(body, ctx) {
  body.innerHTML = '<div id="dialysisList"></div>';
  const legacy = ctx.data.materials?.dialysis_cassettes || [];
  catalogue(body.querySelector('#dialysisList'), ctx, {
    col: 'dialysis', kind: 'dialysis', shipped: ctx.data.materials?.dialysis_devices || [], items: (ref) => ref.dialysis,
    title: 'Dialysis devices', noun: 'dialysis device', label: (x) => x.name || x.id,
    intro: 'Cassettes, float devices and tubing for buffer exchange. A formulation record chooses its cassette by name from this list.',
    headers: ['Name', 'Kind', { label: 'MWCO kD', right: true }, { label: 'Volume mL', right: true }, 'Vendor', 'Notes'],
    cells: (x) => [m(`<b>${esc(x.name)}</b>`), x.kind || '', x.mwco_kDa ?? '–',
      x.volume_min_mL != null || x.volume_max_mL != null ? `${x.volume_min_mL ?? '?'} – ${x.volume_max_mL ?? '?'}` : '–', x.vendor || '', m(`<span class="muted">${esc(x.notes || '')}</span>`)],
    form: (x, ref, use) => `${efield({ id: 'name', label: 'Name', type: 'text', value: x?.name || '', disabled: !!use?.locked?.includes('name') })}
      ${efield({ id: 'kind', label: 'Kind', type: 'select', value: x?.kind || 'cassette', options: DIALYSIS_KINDS })}
      ${efield({ id: 'mwco_kDa', label: 'MWCO kD', value: x?.mwco_kDa ?? '', step: 1 })}
      ${efield({ id: 'vendor', label: 'Vendor', type: 'text', value: x?.vendor || '' })}
      ${efield({ id: 'volume_min_mL', label: 'Volume from mL', value: x?.volume_min_mL ?? '', step: 0.1 })}
      ${efield({ id: 'volume_max_mL', label: 'Volume to mL', value: x?.volume_max_mL ?? '', step: 0.1 })}
      ${wide(efield({ id: 'notes', label: 'Notes', type: 'text', value: x?.notes || '' }))}`,
    read: (f, x, ref) => {
      const name = req(f.name);
      if (!name) return 'Name required';
      // The record stores the name it chose, so two entries must not share one.
      if (ref.dialysis.some((q) => q.id !== x?.id && q.name === name) || legacy.includes(name)) return `"${name}" is listed already`;
      const lo = num(f.volume_min_mL), hi = num(f.volume_max_mL);
      if (lo != null && hi != null && lo > hi) return 'The volume range runs from the smaller to the larger number';
      return { name, kind: f.kind, mwco_kDa: num(f.mwco_kDa), vendor: req(f.vendor), volume_min_mL: lo, volume_max_mL: hi, notes: req(f.notes) };
    },
    usedBy: (x, ref, ids) => (ids.length ? { text: `Chosen on ${plural(ids.length, 'formulation record')} (${esc(listIds(ids))}), which name it, so the name stays.`, locked: ['name'], keep: usedWords(ids, 'names').keep } : null),
    footer: () => (legacy.length ? `<p class="muted" style="margin:8px 0 0">The cassette menu on a formulation record also keeps the cassettes earlier versions listed, for the records that name them: ${esc(legacy.join(', '))}.</p>` : ''),
  });
}

/**
 * The filters the record's filtration step offers. They ship with the app and the lab cannot add its own yet, so
 * there is nothing to delete; a filter the lab does not use can be archived (spec 9.5), which takes it out of the
 * formulation record's menus while the records that name it keep it. "None" is a choice, not a filter.
 */
function consumables(body, ctx) {
  function draw() {
    const ref = getRef(ctx), gone = archivedSet(ctx.store, 'filter');
    const rows = ref.materials.filters.filter((c) => c !== 'None' && !gone.has(c)).map((c) => {
      const n = whereUsed(ctx.store, 'filter', c).length;
      return { attrs: `data-filter="${esc(c)}"`, cells: [c, m(n ? plural(n, 'formulation') : '<span class="muted">–</span>'), m(`<button type="button" class="mat-add" data-act="archfilter" data-id="${esc(c)}">archive</button>`)] };
    });
    body.innerHTML = `<div class="card"><h2>Filters</h2><p class="muted small" style="margin:0 0 8px">Offered by the filtration step of a formulation record. Archive one your lab does not use: it leaves the menus, and the records that name it keep it.</p>
      ${editTable(['Filter', 'Used by', ''], rows, 'Every filter is archived.')}
      <p class="muted" style="margin:8px 0 0">Dialysis devices have their own tab now: <a href="#/materials?tab=dialysis">Dialysis</a>.</p></div>`;
  }
  wire(body, {
    archfilter: async (b) => {
      const f = b.dataset.id, used = whereUsed(ctx.store, 'filter', f).map((u) => u.id);
      await offerArchive(ctx, 'filter', f, f, `${used.length ? `${f} is chosen on ${plural(used.length, 'formulation')} (${listIds(used)}). ` : ''}It ships with the app, so it is not deleted. Archive it? It leaves the filter menus${used.length ? ', those records keep it' : ''}, and it can be restored.`, draw);
    },
  });
  draw();
}

/**
 * The optimizer's lipid descriptors (spec 7.3.2), one row per ionizable lipid, typed in. Shown only with the
 * descriptor mode switched on in Settings. Computing them from a SMILES string would need RDKit.js, which this
 * version does not ship (an open point), so they are entered from the literature or a supplier's data sheet.
 */
function descriptorCard(ref) {
  const ion = ref.lipids.filter((l) => l.class === 'ionizable');
  const cell = (l, f) => {
    const v = l.descriptors?.[f.key];
    return f.kind === 'category'
      ? raw(`<select data-desc="${esc(l.key)}" name="${esc(f.key)}" style="width:auto"><option value=""></option>${f.options.map((o) => `<option ${v === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`)
      : raw(`<input type="number" data-desc="${esc(l.key)}" name="${esc(f.key)}" step="${f.step}" value="${v ?? ''}" style="width:78px">`);
  };
  return `<div class="card" id="descriptorCard"><h2>Lipid descriptors for the optimizer</h2>
    <p class="muted">The descriptor mode describes each ionizable lipid by these numbers. It opens from about 20 lipids with descriptors and runs. Computing them from a SMILES string needs RDKit.js, which is not part of this version; enter them from the literature or the supplier.</p>
    ${table(['Lipid', ...DESCRIPTORS.map((f) => `${f.name}${f.unit ? ` (${f.unit})` : ''}`)], ion.map((l) => ({ cells: [raw(`<b>${esc(l.name)}</b>`), ...DESCRIPTORS.map((f) => cell(l, f))] })))}</div>`;
}

function wireDescriptors(body, ctx, ref) {
  body.querySelector('#descriptorCard')?.addEventListener('change', (e) => {
    const t = e.target.closest('[data-desc]');
    if (!t) return;
    const key = t.dataset.desc, l = ref.lipidByKey[key];
    const stored = ctx.store.get('lipids', key) || ctx.store.all('lipids').find((x) => x.key === key) || { id: key, key };
    const v = t.type === 'number' ? (t.value === '' ? null : Number(t.value)) : t.value || null;
    const descriptors = { ...(l?.descriptors || {}), ...(stored.descriptors || {}), [t.name]: v };
    ctx.store.put('lipids', { ...stored, descriptors });
    toast(`${l?.name || key}: descriptors saved`, 'ok');
  });
}
