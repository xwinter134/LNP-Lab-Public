// Backups: the one export routine, and when the overview should remind you to run it (usability cycle 4, m2).
//
// Everything the app holds lives in one browser profile. A cleared history, a new laptop or a profile that
// will not open takes all of it, and nothing in the app said so: Settings showed "Last export: …" to whoever
// went looking. The overview now says it, once a week at most, and only when there is something new to lose.
import { download, todayISO, toast } from './kit.js';
import { DEMO_NS } from '../demo.js';

/** Days after an export before the overview asks for another. */
export const BACKUP_DAYS = 7;
/** How long "Remind me tomorrow" keeps the reminder away. */
export const SNOOZE_MS = 864e5;

// The collections a person's own work lands in, which a backup exists to keep. Not the trash (a delete adds
// nothing a backup lacks) and not the counters (they only move when a record does). A collection added later and
// left off this list is still exported; only its changes alone would not bring the reminder up.
const DATA = ['experiments', 'batches', 'measurements', 'stocks', 'buffers', 'events', 'inbox', 'imports',
  'rnaLots', 'lipidLots', 'lipids', 'compositions', 'devices', 'mixers', 'tffModules', 'dialysis', 'settings', 'archive', 'views',
  'quarantine', 'insightReports',
  'studies', 'bioMeasurements', 'bioCatalog', 'bliImages']; // the biological layers (spec 8)

// Preferences of this browser, beside the data under the namespace. `lastExport` is the text Settings shows;
// `lastExportAt` is the same moment as an ISO time, for arithmetic. The snooze is bookkeeping (a dotted key),
// so it is never part of a backup.
const keyOf = (ctx, k) => `${ctx.store.ns}.${k}`;
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

/**
 * Export everything as a JSON download and note when, exactly as Settings' "Export everything" does. Returns a
 * promise of where the file went (a name in a browser, a path in the app) or of null when nothing was saved, so
 * that a screen showing the reminder redraws once the export is on record and not before.
 */
export function exportNow(ctx) {
  const saved = download(`lnp-lab-export-${todayISO()}.json`, JSON.stringify(ctx.store.exportAll(), null, 2));
  const now = new Date();
  const note = () => {
    lsSet(keyOf(ctx, 'lastExport'), now.toLocaleString());
    lsSet(keyOf(ctx, 'lastExportAt'), now.toISOString());
    toast('Exported', 'ok');
  };
  // In the macOS app the file goes through a save dialog, and one that was cancelled is no backup.
  return Promise.resolve(saved).then((path) => { if (path) note(); return path || null; });
}

/** Keep the reminder away for a day. */
export function snoozeBackup(ctx, now = new Date()) {
  lsSet(keyOf(ctx, 'snooze.backup'), new Date(now.getTime() + SNOOZE_MS).toISOString());
}

/**
 * Whether to remind, as a pure function of what the browser remembers and what the store holds. Null for no
 * reminder; otherwise `{since}`, the time of the last export (null when there is none on record), and `days`.
 *
 * It reminds when the last export is BACKUP_DAYS old or more, or there is none, and something has been added or
 * changed after it: a record whose `updatedAt` is later (the Store stamps every save). A backup that is old but
 * still complete is left alone, and so is an empty app. Records restored from a backup keep the times they were
 * saved with, so a restore does not ask for the backup it came from. Demo mode never reminds: its data is
 * invented and rebuilt at will.
 *
 * @param {object} o
 * @param {string|null} o.lastExportAt   ISO time of the last export from this browser
 * @param {string|null} o.snoozedUntil   ISO time before which nothing is said
 * @param {(col: string) => object[]} o.read   reads a collection (ctx.store.all)
 * @param {boolean} o.demo
 * @param {Date} o.now
 * @returns {{since: string|null, days: number|null}|null}
 */
export function backupReminder({ lastExportAt = null, snoozedUntil = null, read, demo = false, now = new Date() }) {
  if (demo) return null;
  const t = now.getTime();
  if (Date.parse(snoozedUntil) > t) return null;
  const last = Date.parse(lastExportAt);
  const known = Number.isFinite(last);
  if (known && t - last < BACKUP_DAYS * 864e5) return null;
  // Newest records sit at the end of a collection (a save appends; an edit stays in place), so the scan is
  // backwards and stops at the first record newer than the export.
  const newer = (r) => !known || Date.parse(r?.updatedAt ?? r?.createdAt) > last;
  let changed = false;
  for (const col of DATA) {
    const rows = read(col) || [];
    for (let i = rows.length - 1; i >= 0 && !changed; i--) changed = !!rows[i] && typeof rows[i] === 'object' && newer(rows[i]);
    if (changed) break;
  }
  if (!changed) return null;
  return { since: known ? new Date(last).toISOString() : null, days: known ? Math.floor((t - last) / 864e5) : null };
}

/** The reminder for this browser and store, now (see backupReminder). */
export function backupDue(ctx, now = new Date()) {
  return backupReminder({
    lastExportAt: lsGet(keyOf(ctx, 'lastExportAt')),
    snoozedUntil: lsGet(keyOf(ctx, 'snooze.backup')),
    read: (col) => ctx.store.all(col),
    demo: ctx.store.ns === DEMO_NS,
    now,
  });
}
