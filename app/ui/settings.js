// Screen: Settings & export — defaults, lot numbering, QC thresholds, JSON export/import, backup, recently deleted.
import { field, readForm, table, toast, header, raw, chip, esc, autoSaver, ask } from './kit.js';
import { getSettings, DEFAULT_SETTINGS } from '../refdata.js';
import { DRIFT_BASES } from '../calc/stability.js';
import { feedbackUrl, feedbackMail, openExternal, FEEDBACK_EMAIL } from './feedback.js';

// The running version, for the feedback text; read as report.js reads it, so this screen does not import the entry.
let appVersion = '';
if (typeof document !== 'undefined') import('../main.js').then((m) => { appVersion = m.APP_VERSION || ''; }, () => {});
import { exportNow } from './backup.js';

// The QC limits: [key in settings.qc, label, step].
const QC_FIELDS = [['pdiMax', 'PDI max', 0.01], ['zaveMin', 'Z-ave min (nm)', 1], ['zaveMax', 'Z-ave max (nm)', 1], ['eeMin', 'EE min (%)', 1], ['countRateMin', 'Count rate min (kcps)', 10]];

/**
 * A QC limit: its number, and beside it the box that switches the check on and off. Off is said by the box, not
 * by an empty number, because a number is emptied on the way to typing another; an off limit shows "off".
 */
function limitField([id, label, step], value) {
  const on = Number.isFinite(value);
  return `<div><label for="${id}">${esc(label)}</label><div style="display:flex;gap:8px;align-items:center">
    <input type="number" id="${id}" name="${id}" step="${step}" value="${on ? value : ''}" placeholder="off"${on ? '' : ' disabled'}>
    <label class="inline" style="margin:0;font-weight:400;white-space:nowrap"><input type="checkbox" data-qcon="${id}" aria-label="Check ${esc(label)}" style="width:auto"${on ? ' checked' : ''}> on</label></div></div>`;
}

export async function render(el, ctx) {
  const s = getSettings(ctx);
  // Stored as they are typed, as the rest of the app is (usability cycle 5, K6): initials typed and left for
  // another screen before "Save settings" were lost.
  let forms = null; // the two forms, once drawn; read even after the screen is left, as the last save may be
  const saver = autoSaver(ctx.store, () => {
    if (!forms) return false;
    // A number field emptied to be retyped, or holding something that is not a number, keeps the value stored
    // before it: an empty default would reach every new record and wizard, and an empty limit would switch its
    // check off unasked, while the person had only gone to look at their results. A check is switched off with
    // its box, and is then stored as null, which every screen reads as no limit.
    const was = getSettings(ctx);
    const typed = (vals, old) => Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v === null || Number.isNaN(v) ? old[k] : v]));
    const qc = typed(readForm(forms[1]), was.qc);
    for (const box of forms[1].querySelectorAll('[data-qcon]')) if (!box.checked) qc[box.dataset.qcon] = null;
    ctx.store.put('settings', { id: 'default', ...typed(readForm(forms[0]), was), qc });
  });
  const counts = ['experiments', 'batches', 'stocks', 'buffers', 'measurements', 'rnaLots', 'lipidLots', 'compositions', 'events', 'inbox', 'imports', 'trash'].map((c) => ({ cells: [c, ctx.store.count(c)] }));
  el.innerHTML = header('Reference', 'Settings & export') +
    `<div class="card"><h2>Defaults</h2><div class="grid g4" id="setForm">
      ${field({ id: 'operator', label: 'Operator initials', type: 'text', value: s.operator })}
      ${field({ id: 'defaultFRR', label: 'Default FRR', value: s.defaultFRR, step: 0.5 })}
      ${field({ id: 'defaultQuenchFactor', label: 'Default quench factor', value: s.defaultQuenchFactor, step: 0.5 })}
      ${field({ id: 'defaultWorking_mg_mL', label: 'RNA working conc. (mg/mL)', value: s.defaultWorking_mg_mL, step: 0.05 })}
      ${field({ id: 'defaultFinal_mg_mL', label: 'Final RNA conc. (mg/mL)', value: s.defaultFinal_mg_mL, step: 0.01 })}
      ${field({ id: 'defaultLipidStock_mM', label: 'Lipid stock (mM)', value: s.defaultLipidStock_mM, step: 0.1 })}
      ${field({ id: 'defaultStockVolume_mL', label: 'Stock volume (mL)', value: s.defaultStockVolume_mL, step: 1 })}
      ${field({ id: 'stockExpiryDays', label: 'Stock expiry (days)', value: s.stockExpiryDays, step: 1 })}
      ${field({ id: 'ftWarnCycles', label: 'Warn after freeze–thaw cycles', value: s.ftWarnCycles, step: 1, min: 0, hint: 'Lipid stocks and tracked lipid lots; 0 switches the warning off' })}
      ${field({ id: 'driftBasis', label: 'Size drift expressed as', type: 'select', value: s.driftBasis || 'auto', options: DRIFT_BASES.map((b) => ({ value: b.id, label: b.label })) })}
      ${field({ id: 'reminderTime', label: 'Reminder time', type: 'text', value: s.reminderTime })}
      <div>${field({ id: 'weekendShift', label: 'Move weekend timepoints to Monday', type: 'checkbox', value: s.weekendShift })}</div>
    </div>
    <h2 style="margin-top:14px">QC thresholds</h2><div class="grid g4" id="qcForm">
      ${QC_FIELDS.map((q) => limitField(q, s.qc[q[0]])).join('')}
    </div>
    <div style="margin-top:12px;display:flex;gap:8px;align-items:center">${saver.html()}<button id="resetSettings">Reset to defaults</button></div></div>
    <div class="grid g2">
      <div class="card"><h2>Data</h2>${storageMeter(ctx)}${table(['Collection', { label: 'Records', right: true }], counts)}</div>
      <div class="card"><h2>Backup & restore</h2>
        <p><button class="primary" id="exportAll">Export everything (JSON)</button></p>
        <p><label>Import JSON</label><input type="file" id="importFile" accept="application/json,.json" style="width:auto"> <label style="display:inline-flex;gap:6px;align-items:center;font-weight:400"><input type="checkbox" id="importReplace" style="width:auto"> replace instead of merge</label></p>
        <p class="advanced"><button id="clearAll" style="color:var(--warn)">Delete all data in this browser</button></p>
        <p class="muted">Last export: ${esc(lastExport(ctx)?.text || 'never')}</p></div>
    </div>
    ${trashCard(ctx)}`;
  // Feedback here as well as in the sidebar's foot, which a narrow window hides.
  el.insertAdjacentHTML('beforeend', `<div class="card" id="feedbackCard"><h2>Feedback</h2>
    <p class="muted" style="margin-top:0">A problem or an idea goes to the project as a GitHub issue${FEEDBACK_EMAIL ? ', or by e-mail if you have no GitHub account' : ''}. The screen and the version are filled in; nothing from your lab goes with it.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button data-fb="bug">Report a problem</button><button data-fb="idea">Suggest an idea</button>${FEEDBACK_EMAIL ? '<button data-fb="bug" data-mail="1">Report by e-mail</button>' : ''}</div></div>`);
  el.querySelectorAll('#feedbackCard [data-fb]').forEach((b) => b.addEventListener('click', () => {
    const where = { screen: 'settings', title: 'Settings & export', version: appVersion, app: !!globalThis.__TAURI__ };
    openExternal(b.dataset.mail ? feedbackMail(b.dataset.fb, where) : feedbackUrl(b.dataset.fb, where));
  }));
  forms = [el.querySelector('#setForm'), el.querySelector('#qcForm')];
  // A limit's box, on its own field before the form stores the change: off empties the number, and on gives back
  // the one it had, or the shipped limit, to start from.
  forms[1].querySelectorAll('[data-qcon]').forEach((box) => box.addEventListener('change', () => {
    const input = forms[1].querySelector(`[name="${box.dataset.qcon}"]`);
    input.disabled = !box.checked;
    if (!box.checked) { input.dataset.was = input.value; input.value = ''; } else if (input.value === '') input.value = input.dataset.was || DEFAULT_SETTINGS.qc[box.dataset.qcon];
  }));
  for (const form of forms) {
    form.addEventListener('input', saver.soon);
    form.addEventListener('change', saver.now);
  }
  // Each question is awaited (ask() in ./kit.js): in the macOS app the answer comes back as a promise.
  el.querySelector('#resetSettings').addEventListener('click', async () => { if (await ask('Reset all settings to defaults?')) { ctx.store.put('settings', { ...DEFAULT_SETTINGS }); render(el, ctx); } });
  // The one export routine (./backup.js), which notes the export under the open lab's namespace: written here as
  // 'lnp-lab.lastExport', an export of the demo counted as the real lab's backup (usability cycle 6, I9). In the
  // macOS app the file goes through a save dialog, and one that was cancelled is no backup.
  el.querySelector('#exportAll').addEventListener('click', () => { exportNow(ctx).then((path) => path && render(el, ctx)); });
  el.querySelector('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      if (!obj.collections) throw new Error('not an LNP Lab export');
      const replace = el.querySelector('#importReplace').checked;
      // After a No the chooser is cleared, or choosing the same file again would not count as a change.
      if (replace && !(await ask('Replace all current data with the file contents?'))) { e.target.value = ''; return; }
      const done = ctx.store.importAll(obj, { merge: !replace });
      toast(`Imported ${done.records} record${done.records === 1 ? '' : 's'} in ${done.collections} collection${done.collections === 1 ? '' : 's'}` +
        (done.skipped.length ? ` (skipped: ${done.skipped.join(', ')})` : ''), 'ok');
      render(el, ctx);
    } catch (err) { toast('Import failed: ' + err.message, 'warn'); }
  });
  el.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => {
    const r = ctx.store.restoreFromTrash(b.dataset.restore);
    if (!r.ok) { toast(`Not restored: ${r.reason}`, 'warn'); return; }
    const first = r.entry.records[0], open = OPEN[first?.col], tab = OPEN_TAB[first?.col];
    toast(`Restored ${r.entry.label}`, 'ok', open ? { action: 'Open', onAction: () => ctx.navigate(open, { id: first.rec.id }) }
      : tab ? { action: 'Open', onAction: () => ctx.navigate('materials', { tab }) } : {});
    render(el, ctx);
  }));
  el.querySelector('#emptyTrash')?.addEventListener('click', async () => {
    const n = ctx.store.count('trash');
    if (!(await ask(`Erase the ${n} deleted item${n === 1 ? '' : 's'} for good? This cannot be undone.`))) return;
    ctx.store.emptyTrash(); toast('Trash emptied'); render(el, ctx);
  });
  el.querySelector('#clearAll').addEventListener('click', async () => {
    if (!(await ask('Delete ALL data in this browser? Export first.')) || !(await ask('Really delete everything?'))) return;
    // the namespace on screen, which in demo mode is the demo one: this button must never reach past it
    ctx.store.clear().then((r) => { toast(r.ok ? 'All data deleted' : 'Not everything could be deleted: ' + (r.error?.message || 'unknown'), r.ok ? '' : 'warn'); render(el, ctx); });
  });
  fillStorageMeter(el, ctx);
}

/* ---------------- the storage meter ---------------- */

// A busy lab fills localStorage's 5 MB in about six months (usability cycle 4, S1). The records now live in
// IndexedDB, where the browser allows a share of the disk; this card says how much the records take, what the
// browser allows, whether it has agreed to keep them, and when the last backup was made, in one plain sentence
// first. The browser's own figures arrive asynchronously, so the card is drawn with what is known and filled in.
const LS_LIMIT = 5e6; // localStorage: about 5 million characters per site in Chrome and Safari

const mb = (bytes) => (bytes >= 1e9 ? `${fmtNum(bytes / 1e9)} GB` : bytes >= 1e6 ? `${fmtNum(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`);
const fmtNum = (x) => (x >= 100 ? Math.round(x).toString() : x >= 10 ? x.toFixed(0) : x.toFixed(1));

function storageMeter(ctx) {
  const u = ctx.store.usage();
  const where = { sqlite: 'the app\'s database file, lnp-lab.db in ~/Library/Application Support/org.lnplab.app/', indexeddb: 'this browser\'s database (IndexedDB)', localStorage: 'this browser\'s localStorage, which holds about 5 MB, because its database could not be opened', memory: 'memory only: nothing is kept after this window closes', none: 'nowhere: this browser is not letting the page store anything' }[ctx.store.engine] || ctx.store.engine;
  const last = lastExport(ctx);
  return `<div id="storageMeter">
    <p id="storageVerdict"><b>${esc(verdict(ctx, null))}</b></p>
    <div class="meterBar" style="height:8px;border-radius:4px;background:var(--bg2);border:1px solid var(--line);overflow:hidden;margin:6px 0"><div id="storageBar" style="height:100%;width:0;background:var(--accent)"></div></div>
    <p class="muted" id="storageFacts">Your records take ${mb(u.chars)} in ${u.collections.length} list${u.collections.length === 1 ? '' : 's'}, kept in ${esc(where)}.
      <span id="storageQuota"></span> <span id="storagePersist"></span> Last export: ${esc(last ? last.text : 'never')}.</p>
  </div>`;
}

/** The browser's own figures, once it gives them: what the site may use, and whether it will be kept. */
async function fillStorageMeter(el, ctx) {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  const box = el.querySelector('#storageMeter');
  if (!box || !box.isConnected) return;
  if (est?.quota && ctx.store.engine === 'indexeddb') box.querySelector('#storageQuota').textContent = `This browser lets the site use up to ${mb(est.quota)}; ${mb(est.usage || 0)} of it is in use.`;
  if (persisted != null && ctx.store.engine === 'indexeddb') box.querySelector('#storagePersist').textContent = persisted ? 'The browser has agreed to keep it when the disk runs low.' : 'The browser may clear it if the disk runs low, which is one more reason to export.';
  box.querySelector('#storageVerdict b').textContent = verdict(ctx, est);
  box.querySelector('#storageBar').style.width = `${Math.min(100, Math.max(0.5, 100 * fraction(ctx, est)))}%`;
}

/** How full the place the records are kept is, 0–1. */
function fraction(ctx, est) {
  const chars = ctx.store.usage().chars;
  if (ctx.store.engine === 'localStorage') return chars / LS_LIMIT;
  if (est?.quota) return (est.usage || chars) / est.quota;
  return 0;
}

/** One sentence: is there room, and what to do about it. */
function verdict(ctx, est) {
  if (ctx.store.problem) return 'Saving is failing right now: the note at the top of the screen says why and what to do.';
  const f = fraction(ctx, est), pct = Math.round(f * 100);
  const backup = lastExport(ctx)?.old !== false ? ' Export a backup now and then: everything lives in this one browser.' : '';
  if (ctx.store.engine === 'none' || ctx.store.engine === 'memory') return 'Nothing is being kept: export a backup before you close this window.';
  if (ctx.store.engine === 'localStorage') {
    if (f >= 0.85) return `Nearly full: ${pct} % of the ~5 MB this browser allows is used. Export a backup, then free space (empty the trash).`;
    if (f >= 0.5) return `Over half full: ${pct} % of the ~5 MB this browser allows is used.${backup}`;
    return `Room to spare: ${pct} % of the ~5 MB this browser allows is used.${backup}`;
  }
  if (!est?.quota) return `Stored in this browser's database, which grows with the disk.${backup}`;
  if (f >= 0.85) return `Nearly full: ${pct} % of what this browser allows is used. Export a backup, then free disk space.`;
  return `Room to spare: ${pct < 1 ? 'under 1' : pct} % of what this browser allows is in use.${backup}`;
}

/**
 * The last export of the lab that is open (the demo has its own), as written by the button above ("27/10/2026,
 * 10:12:03" before, or an ISO time), and whether it is a week old.
 */
function lastExport(ctx) {
  let v = null;
  try { v = localStorage.getItem(`${ctx.store.ns}.lastExport`); } catch {}
  if (!v) return null;
  const t = Date.parse(v);
  return { text: v, old: Number.isNaN(t) ? null : Date.now() - t > 7 * 864e5 };
}

// The screen a restored record opens on, by the collection its first record came from.
const OPEN = { experiments: 'experiments', stocks: 'stocks', buffers: 'buffers' };
// Materials restored are opened on their tab (materials?tab=…), not as a record of their own.
const OPEN_TAB = { rnaLots: 'rna', lipidLots: 'lipids', lipids: 'lipids', compositions: 'compositions', devices: 'devices', mixers: 'devices', tffModules: 'tff', dialysis: 'dialysis' };
const KIND = { experiment: 'experiment', stock: 'lipid stock', buffer: 'buffer' };
const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso || '–') : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };

/**
 * What was deleted in the last 30 days, each with a Restore. Deleting asks no question any more (the note it
 * raises carries an Undo), so this list is where a delete noticed too late is put right. Emptying the trash
 * is the one step here that cannot be taken back, so that one still asks.
 */
function trashCard(ctx) {
  const trash = ctx.store.recentTrash();
  return `<div class="card" id="trashCard"><div style="display:flex;align-items:center;gap:10px"><h2 style="flex:1">Recently deleted</h2>${ctx.store.count('trash') ? '<button id="emptyTrash">Empty trash</button>' : ''}</div>
    ${trash.length ? `<div id="trashList">${table(['Deleted', 'What', { label: 'Records', right: true }, ''], trash.map((t) => ({
      attrs: `data-trash="${esc(t.id)}"`,
      cells: [when(t.deletedAt), raw(`${chip(KIND[t.kind] || t.kind)} ${esc(t.label)}`), t.records.length, raw(`<button type="button" data-restore="${esc(t.id)}" style="padding:4px 10px">Restore</button>`)],
    })))}</div>` : '<p class="muted" id="trashList">Nothing deleted in the last 30 days.</p>'}
    <p class="muted">Deleted experiments (with their formulations), lipid stocks, buffers and materials (RNA and lipid lots, lipids, compositions, devices) stay here for 30 days. Restore puts back exactly what was removed, where it was. Measurements are never deleted with an experiment. The trash is part of the backup.</p></div>`;
}
