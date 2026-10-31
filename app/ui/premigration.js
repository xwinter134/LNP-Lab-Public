// Settings › Before updates (spec 4.4, 12.1): the copies of the records that a migration keeps before it changes
// anything (app/migrate.js backupBeforeMigration), with the date, the versions, and two ways back: Download hands
// one out as a backup file (the same shape as "Export everything", so Import can read it too), and Restore puts it
// back over the records as they are now, after a question (migrate.js restorePreMigration).
//
// Shown only while a copy is kept, so a lab that never had an update to migrate sees nothing new.
import { esc, table, raw, toast, download, ask } from './kit.js';
import { preMigrationFile, restorePreMigration } from '../migrate.js';

const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso || '–') : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const recordsIn = (rec) => Object.values(rec?.data || {}).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0);
const copies = (ctx) => ctx.store.all('preMigration').filter((r) => r?.id).sort((a, b) => String(b.at).localeCompare(String(a.at)));

/** The card, or nothing when no copy is kept. */
export function preMigrationCard(ctx) {
  const list = copies(ctx);
  if (!list.length) return '';
  return `<div class="card" id="preMigrationCard"><h2>Before updates</h2>
    <p class="muted" style="margin-top:0">When an update changes how records are stored, a copy of every record is kept first. The two newest are kept here, in this lab.</p>
    ${table(['Made', 'Schema', { label: 'Records', right: true }, ''], list.map((r) => ({
      attrs: `data-premigration="${esc(r.id)}"`,
      cells: [when(r.at), `version ${r.from} to ${r.to}`, recordsIn(r), raw(`<button type="button" data-pm-download="${esc(r.id)}" style="padding:4px 10px">Download</button> <button type="button" data-pm-restore="${esc(r.id)}" style="padding:4px 10px">Restore</button>`)],
    })))}</div>`;
}

/** Download and Restore. `redraw` draws the Settings screen again. */
export function wirePreMigration(el, ctx, redraw) {
  el.querySelectorAll('[data-pm-download]').forEach((b) => b.addEventListener('click', () => {
    const rec = ctx.store.get('preMigration', b.dataset.pmDownload);
    if (!rec) { toast('That copy is no longer kept', 'warn'); return; }
    download(`lnp-lab-before-update-v${rec.from}-${String(rec.at).slice(0, 10)}.json`, JSON.stringify(preMigrationFile(rec, ctx.store.ns), null, 2));
  }));
  el.querySelectorAll('[data-pm-restore]').forEach((b) => b.addEventListener('click', async () => {
    const rec = ctx.store.get('preMigration', b.dataset.pmRestore);
    if (!rec) { toast('That copy is no longer kept', 'warn'); return; }
    if (!(await ask(`Restore the records as they were before the update of ${when(rec.at)}?\n\nEvery list the copy holds replaces the one you have now, so what was entered or changed since is gone (export a backup first to keep it). The records are then brought up to this version again. Restore?`))) return;
    const r = restorePreMigration(ctx.store, rec.id);
    if (!r.ok) { toast(`Not restored: ${r.reason}`, 'warn'); return; }
    toast(`Restored ${r.restored.records} record${r.restored.records === 1 ? '' : 's'} from before the update`, 'ok');
    redraw();
  }));
}
