// The MCP server's door to the lab: the macOS app's SQLite file, read through the app's own store (app/store.js),
// and written only while the app is closed (spec 6.2).
//
// Why closed, and not a lock shared with the open app. The app's window holds every collection in memory and
// stores whole collections (one row per collection, `<ns>.<collection>` → its JSON). Any record written into the
// file under an open window is overwritten by the window's next save of that collection, whatever lock is held
// while writing; the window would have to read back and merge, which is what the one-writer-window logic in
// store.js does between browser windows, and the macOS app has no second window to take part in it. So the rule
// is the simplest one that cannot lose data: the server writes only when no app process is running, and the
// write itself is one SQLite transaction (BEGIN IMMEDIATE … COMMIT), so an app started in the middle of it waits
// for it and then reads the finished import, never half of one.
//
// How "the app is running" is told, most certain first:
//   1. lnp-lab.app.lock beside the database, written by the app at start with its process id and removed at quit
//      (src-tauri/src/lib.rs). The process id is checked, so a lock left behind by a crash does not block.
//   2. On macOS, the process list: any process running from "LNP Lab.app" (an app version without the lock file).
// And should both miss, the app still does not lose the import: the server stamps `_app.changed` in the same
// transaction, and the app's SQLite backend makes every write conditional on that stamp being the one it read at
// start (app/store.js sqliteBackend). Its next save then stores nothing and says to reload, instead of writing
// its older copy over the import.
//
// The browser version keeps its records in IndexedDB, which nothing outside the browser can reach: there the
// server writes an import file, read in through Settings › Import JSON (merge), as scripts/import-tidy.mjs does.
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store, sqliteBackend, CHANGED_KEY } from '../app/store.js';

export const APP_ID = 'org.lnplab.app';
export const LOCK_FILE = 'lnp-lab.app.lock';

/** Where the macOS app keeps its database (tauri-plugin-sql's "sqlite:lnp-lab.db" in the app's data folder). */
export function defaultDbPath() {
  if (process.env.LNP_LAB_DB) return process.env.LNP_LAB_DB;
  return join(homedir(), 'Library', 'Application Support', APP_ID, 'lnp-lab.db');
}

/** The shipped reference data the app merges the lab's own over (app/data/*.json). */
export function shippedData() {
  const read = (f) => JSON.parse(readFileSync(new URL(`../app/data/${f}.json`, import.meta.url), 'utf8'));
  const out = {};
  for (const f of ['lipids', 'compositions', 'buffers_catalog', 'tff_modules', 'materials', 'pka', 'reagents']) { try { out[f] = read(f); } catch { out[f] = []; } }
  out.lipidByKey = Object.fromEntries(out.lipids.map((l) => [l.key, l]));
  out.compositionById = Object.fromEntries(out.compositions.map((c) => [c.id, c]));
  return out;
}

/** tauri-plugin-sql's three commands over a node:sqlite connection; sqlx binds $1, $2 … as SQLite's ?1, ?2 …. */
export function invokeOn(db) {
  const sql = (q) => q.replace(/\$(\d+)/g, '?$1');
  return async (cmd, a) => {
    if (cmd === 'plugin:sql|load') return a.db;
    if (cmd === 'plugin:sql|execute') { const r = db.prepare(sql(a.query)).run(...a.values); return [r.changes, r.lastInsertRowid]; }
    if (cmd === 'plugin:sql|select') return db.prepare(sql(a.query)).all(...a.values);
    throw new Error('unknown command ' + cmd);
  };
}

/**
 * A read-only view of the lab: {ns, all(col)}, each collection parsed once. Opened and closed per call, so the
 * server never holds the file open between tool calls.
 */
export function readLab(dbPath, ns = 'lnp-lab') {
  if (!existsSync(dbPath)) return emptyLab(ns);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'collections'").get();
    const cols = {};
    if (has) for (const r of db.prepare('SELECT key, json FROM collections WHERE key >= ? AND key < ? AND json IS NOT NULL').all(`${ns}.`, `${ns}.￿`)) cols[r.key.slice(ns.length + 1)] = r.json;
    const parsed = new Map();
    const all = (col) => { if (!parsed.has(col)) { let v = []; try { v = cols[col] ? JSON.parse(cols[col]) : []; } catch {} parsed.set(col, Array.isArray(v) ? v : []); } return parsed.get(col).map((r) => r); };
    // get and count as the app's Store has them: the app's readers (insights, the custom parameters) ask for both.
    return { ns, all, get: (col, id) => all(col).find((r) => r?.id === id) ?? null, count: (col) => all(col).length };
  } finally { db.close(); }
}
export const emptyLab = (ns = 'lnp-lab') => ({ ns, all: () => [], get: () => null, count: () => 0 });

/**
 * A backup file of the browser version (Settings › Export everything: {exportedAt, ns, collections}) as a
 * read-only lab, the same {ns, all, get, count} as readLab. The browser keeps its lab where nothing outside it can
 * read, so for quality_report and list_imports a fresh backup is the browser version's lab (spec 6.2). Read once
 * per call, never written: a backup is evidence, and the import file goes beside it.
 */
export function readBackup(path, ns = 'lnp-lab') {
  let obj;
  try { obj = JSON.parse(readFileSync(path, 'utf8')); } catch (err) { throw new Error(`cannot read the backup file ${path}: ${err.message}`); }
  const cols = obj && typeof obj.collections === 'object' && obj.collections ? obj.collections : null;
  if (!cols) throw new Error(`${path} is not an LNP Lab backup (Settings › Export everything writes one)`);
  const all = (col) => (Array.isArray(cols[col]) ? cols[col].filter((r) => r && typeof r === 'object').map((r) => r) : []);
  return { ns: obj.ns || ns, all, get: (col, id) => all(col).find((r) => r?.id === id) ?? null, count: (col) => all(col).length, exportedAt: obj.exportedAt || null };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

/**
 * Whether the macOS app is running on this database: {running, why}. `why` is said to the person, so it names
 * what was found.
 */
export function appRunning(dbPath) {
  const lock = join(dirname(dbPath), LOCK_FILE);
  if (existsSync(lock)) {
    let pid = null;
    try { pid = Number(JSON.parse(readFileSync(lock, 'utf8')).pid); } catch {}
    if (pid && alive(pid)) return { running: true, why: `LNP Lab is open (process ${pid}, from ${LOCK_FILE})` };
  }
  if (platform() === 'darwin') {
    try {
      const ps = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 3000 });
      const hit = ps.split('\n').find((l) => /\/LNP Lab\.app\/Contents\/MacOS\//.test(l));
      if (hit) return { running: true, why: `LNP Lab is open (process ${hit.trim().split(/\s+/)[0]})` };
    } catch { /* no process list: the lock file and the app's own stamp check still stand */ }
  }
  return { running: false, why: '' };
}

/**
 * Run `fn(store)` against the database as one transaction, through the app's own Store and SQLite backend, so the
 * records are written exactly as the app writes them. Refused while the app is running. `fn` changes the store
 * synchronously or returns a promise; whatever it changed is flushed, the `_app.changed` stamp set, and the whole
 * committed together, or rolled back together on any error.
 */
export async function writeLab(dbPath, ns, fn, { running = appRunning, stampWith = {} } = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE'); // from here no other connection writes until COMMIT
    try {
      const r = running(dbPath);
      if (r.running) throw Object.assign(new Error(`${r.why}. Quit LNP Lab (Cmd+Q), then ask again: the app keeps your records in memory while it runs and would write over anything added under it.`), { code: 'APP_RUNNING' });
      const store = new Store(ns, { backend: sqliteBackend(invokeOn(db)) });
      await store.ready();
      const out = await fn(store);
      const done = await store.flush();
      if (!done.ok) throw done.error || new Error('the records could not be stored');
      db.prepare('INSERT INTO collections (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json')
        .run(CHANGED_KEY, JSON.stringify({ by: 'lnp-lab-mcp', at: new Date().toISOString(), ...stampWith }));
      db.exec('COMMIT');
      return out;
    } catch (err) { try { db.exec('ROLLBACK'); } catch {} throw err; }
  } finally { db.close(); }
}
