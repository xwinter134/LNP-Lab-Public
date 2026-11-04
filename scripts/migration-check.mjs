#!/usr/bin/env node
// Gate of spec phase 2: run the schema migration on a COPY of a real lab database and check it lost nothing.
//
//   node scripts/migration-check.mjs path/to/lnp-lab.db [--ns lnp-lab]
//
// The file is copied first and only the copy is opened, through the same SQLite backend the macOS app uses
// (app/store.js sqliteBackend, with node:sqlite standing in for tauri-plugin-sql). The check:
//   1. every field of every record before the migration is still there, with the same value, afterwards;
//   2. what was added is only provenance, plan.conditions and the pre-migration copy;
//   3. the pre-migration copy equals the records before;
//   4. a second run changes nothing (idempotent);
//   5. export, then restore into an empty lab, gives back the same records (round trip).
// It prints counts and field paths only, never record contents, so its output can be shared.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
const ns = args.includes('--ns') ? args[args.indexOf('--ns') + 1] : 'lnp-lab';
if (!src) { console.error('usage: node scripts/migration-check.mjs <lnp-lab.db> [--ns lnp-lab]'); process.exit(2); }

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
const { Store, sqliteBackend } = await import('../app/store.js');
const { migrate, SCHEMA_VERSION } = await import('../app/migrate.js');

function backendOn(file) {
  const db = new DatabaseSync(file);
  const sql = (q) => q.replace(/\$(\d+)/g, '?$1');
  const invoke = async (cmd, a) => {
    if (cmd === 'plugin:sql|load') return a.db;
    if (cmd === 'plugin:sql|execute') { const r = db.prepare(sql(a.query)).run(...a.values); return [r.changes, r.lastInsertRowid]; }
    if (cmd === 'plugin:sql|select') return db.prepare(sql(a.query)).all(...a.values);
    throw new Error('unknown command ' + cmd);
  };
  return sqliteBackend(invoke);
}

const dir = mkdtempSync(join(tmpdir(), 'lnp-migcheck-'));
const copy = join(dir, 'copy.db');
copyFileSync(src, copy);
const store = new Store(ns, { backend: backendOn(copy) });
await store.ready();
const before = store.exportAll().collections;
const ADDED = new Set(['provenance', 'conditions']);

// Every leaf path of `a` must be in `b` with the same value; returns the paths that are not.
function lost(a, b, path = '', out = []) {
  if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object') { out.push(path || '(root)'); return out; }
    for (const k of Object.keys(a)) lost(a[k], b[k], `${path}.${k}`, out);
  } else if (!Object.is(a, b)) out.push(path);
  return out;
}
// Leaf paths of `b` that `a` does not have, other than the fields the migration adds.
function added(a, b, path = '', out = []) {
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    for (const k of Object.keys(b)) {
      if (!(a && typeof a === 'object' && k in a)) { if (!ADDED.has(k)) out.push(`${path}.${k}`); continue; }
      added(a[k], b[k], `${path}.${k}`, out);
    }
  }
  return out;
}
const generic = (p) => p.replace(/\[\d+\]|\.\d+(?=\.|$)/g, '[]');

let fail = 0;
const say = (ok, line) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${line}`); if (!ok) fail++; };
console.log(`Database copy: ${Object.entries(before).map(([c, r]) => `${c} ${r.length}`).join(', ')}`);

const res = migrate(store);
await store.flush();
console.log(`Migration to schema ${SCHEMA_VERSION}: ${res ? JSON.stringify(res.result?.added ?? res.added ?? res) : 'nothing to do'}`);
const after = store.exportAll().collections;

const lostPaths = new Set(), addedPaths = new Set();
for (const [col, rows] of Object.entries(before)) {
  const byId = new Map((after[col] || []).map((r) => [r.id, r]));
  for (const r of rows) {
    const a = byId.get(r.id);
    if (!a) { lostPaths.add(`${col}: record missing`); continue; }
    lost(r, a).forEach((p) => lostPaths.add(`${col}${generic(p)}`));
    added(r, a).forEach((p) => addedPaths.add(`${col}${generic(p)}`));
  }
  if ((after[col] || []).length !== rows.length) lostPaths.add(`${col}: ${rows.length} records before, ${(after[col] || []).length} after`);
}
say(!lostPaths.size, `nothing lost${lostPaths.size ? ': ' + [...lostPaths].join('; ') : ''}`);
say(!addedPaths.size, `nothing added but provenance and plan.conditions${addedPaths.size ? ': ' + [...addedPaths].join('; ') : ''}`);
const prov = ['batches', 'measurements', 'compositions'].map((c) => [c, (after[c] || []).filter((r) => r.provenance?.source).length, (after[c] || []).length]);
say(prov.every(([, n, t]) => n === t), `provenance on every record: ${prov.map(([c, n, t]) => `${c} ${n}/${t}`).join(', ')}`);

const pre = store.all('preMigration');
const copyOk = pre.length >= 1 && Object.entries(before).every(([c, rows]) => JSON.stringify(pre.at(-1).data[c] || []) === JSON.stringify(rows));
say(copyOk, `a copy of the records before the migration is kept (${pre.length})`);

mem.delete(`${ns}.schemaVersion`);
const again = JSON.stringify(store.exportAll().collections);
migrate(store); await store.flush();
const twice = store.exportAll().collections;
say(JSON.stringify(Object.fromEntries(Object.entries(twice))) === again, 'a second run changes no record');

const blank = join(dir, 'blank.db');
const fresh = new Store(ns, { backend: backendOn(blank) });
await fresh.ready();
fresh.importAll({ collections: twice }, { merge: false });
await fresh.flush();
const back = new Store(ns, { backend: backendOn(blank) });
await back.ready();
say(JSON.stringify(back.exportAll().collections) === JSON.stringify(twice), 'export, restore into an empty lab and reopen: the same records');

console.log(fail ? `\n${fail} check(s) failed` : '\nAll checks passed. The original file was not opened for writing.');
process.exit(fail ? 1 : 0);
