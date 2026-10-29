// The backup reminder (usability cycle 4, m2): when the overview asks for an export, and when it keeps quiet.
import test from 'node:test';
import assert from 'node:assert/strict';

// The store and the reminder's bookkeeping are localStorage; node has none, so give it one before the modules load.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  get length() { return mem.size; },
  key: (i) => [...mem.keys()][i] ?? null,
};
const { Store } = await import('../app/store.js');
const { backupReminder, backupDue, snoozeBackup, BACKUP_DAYS } = await import('../app/ui/backup.js');

const NOW = new Date('2026-10-27T10:00:00Z');
const ago = (days) => new Date(NOW.getTime() - days * 864e5).toISOString();
/** A store as backupReminder reads it: collection name → records. */
const reader = (cols) => (col) => cols[col] || [];
const lab = (updatedAt) => reader({ experiments: [{ id: 'E1', updatedAt: ago(30) }, { id: 'E2', updatedAt }], batches: [{ id: 'E1-F1', updatedAt: ago(30) }] });

test('never exported: a reminder as soon as there is anything to lose, none for an empty app', () => {
  assert.equal(backupReminder({ read: reader({}), now: NOW }), null);
  assert.deepEqual(backupReminder({ read: lab(ago(1)), now: NOW }), { since: null, days: null });
  // Records restored from a file, or written without a time, still count when no export is on record.
  assert.deepEqual(backupReminder({ read: reader({ measurements: [{ id: 'm1' }] }), now: NOW }), { since: null, days: null });
});

test(`an export ${BACKUP_DAYS} days old or more, with records changed after it`, () => {
  assert.equal(backupReminder({ lastExportAt: ago(3), read: lab(ago(1)), now: NOW }), null, 'a recent export is enough');
  assert.equal(backupReminder({ lastExportAt: ago(10), read: lab(ago(12)), now: NOW }), null, 'old, but nothing has changed since: the backup is complete');
  assert.deepEqual(backupReminder({ lastExportAt: ago(10), read: lab(ago(2)), now: NOW }), { since: ago(10), days: 10 });
  assert.deepEqual(backupReminder({ lastExportAt: ago(7), read: lab(ago(2)), now: NOW }), { since: ago(7), days: 7 }, 'a week to the minute counts');
  assert.equal(backupReminder({ lastExportAt: ago(6.9), read: lab(ago(2)), now: NOW }), null);
  // Any collection a person works in counts, an edit as much as an addition, wherever it sits in the list.
  const edited = reader({ settings: [{ id: 'default', updatedAt: ago(1) }], experiments: [{ id: 'E1', updatedAt: ago(30) }] });
  assert.ok(backupReminder({ lastExportAt: ago(9), read: edited, now: NOW }));
  const early = reader({ measurements: [{ id: 'm2', updatedAt: ago(1) }, { id: 'm1', updatedAt: ago(30) }] });
  assert.ok(backupReminder({ lastExportAt: ago(9), read: early, now: NOW }), 'an edited record that is not the last one');
  // createdAt stands in for a record saved without updatedAt; one with neither cannot be dated and is not counted.
  assert.ok(backupReminder({ lastExportAt: ago(9), read: reader({ stocks: [{ id: 'Stock-001', createdAt: ago(1) }] }), now: NOW }));
  assert.equal(backupReminder({ lastExportAt: ago(9), read: reader({ stocks: [{ id: 'Stock-001' }, null] }), now: NOW }), null);
});

test('what does not need a backup: a restore, a delete, the counters, demo mode, a snooze', () => {
  // A restore brings records back with the times they were saved at, before the export.
  assert.equal(backupReminder({ lastExportAt: ago(9), read: lab(ago(40)), now: NOW }), null);
  // Only the trash or the id counters moved: nothing that is not already in the last backup.
  const bookkeeping = reader({ experiments: [{ id: 'E1', updatedAt: ago(30) }], trash: [{ id: 't1', deletedAt: ago(1), updatedAt: ago(1) }], counters: [{ id: 'experiment', top: 3, updatedAt: ago(1) }] });
  assert.equal(backupReminder({ lastExportAt: ago(9), read: bookkeeping, now: NOW }), null);
  assert.equal(backupReminder({ demo: true, read: lab(ago(1)), now: NOW }), null, 'demo mode never reminds');
  assert.equal(backupReminder({ snoozedUntil: ago(-0.5), read: lab(ago(1)), now: NOW }), null, 'snoozed');
  assert.ok(backupReminder({ snoozedUntil: ago(0.01), read: lab(ago(1)), now: NOW }), 'and back once the day is over');
  assert.ok(backupReminder({ lastExportAt: 'last Tuesday', read: lab(ago(1)), now: NOW }), 'a time that does not parse is no export');
});

test('backupDue reads this browser: its namespace, the export time Settings writes, the snooze', () => {
  mem.clear();
  const ctx = { store: new Store('lnp-lab') };
  ctx.store.put('experiments', { id: 'E1', name: 'one', batchIds: [] }); // saved now, by the real clock
  const now = new Date(Date.now() + 864e5);
  assert.deepEqual(backupDue(ctx, now), { since: null, days: null });
  localStorage.setItem('lnp-lab.lastExportAt', new Date(now.getTime() - 1e3).toISOString());
  assert.equal(backupDue(ctx, now), null, 'exported a second ago');
  localStorage.setItem('lnp-lab.lastExportAt', new Date(now.getTime() - 8 * 864e5).toISOString());
  assert.equal(backupDue(ctx, now)?.days, 8);
  snoozeBackup(ctx, now);
  assert.ok(localStorage.getItem('lnp-lab.snooze.backup'), 'the snooze is a dotted key: bookkeeping, never part of a backup');
  assert.deepEqual(Object.keys(ctx.store.exportAll().collections).filter((k) => /snooze|lastExport/.test(k)), [], 'nor is the export time');
  assert.equal(backupDue(ctx, now), null);
  assert.ok(backupDue(ctx, new Date(now.getTime() + 864e5 + 1e3)), 'a day later it is back');
  // The demo lab has its own namespace and never asks, whatever its records.
  const demo = { store: new Store('lnp-demo') };
  demo.store.put('experiments', { id: 'E1', name: 'invented', batchIds: [] });
  assert.equal(backupDue(demo, now), null);
});
