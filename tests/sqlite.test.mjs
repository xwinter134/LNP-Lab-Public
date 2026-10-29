// The macOS app's SQLite backend (app/store.js sqliteBackend), run against a real SQLite database: node:sqlite stands
// in for tauri-plugin-sql's load / execute / select commands, so the SQL itself is what is tested.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Store, sqliteBackend } from '../app/store.js';

/** tauri-plugin-sql's commands over one in-memory database; sqlx binds $1, $2 … as SQLite's ?1, ?2 …. */
function fakeInvoke({ failWrites = false } = {}) {
  const db = new DatabaseSync(':memory:');
  const sql = (q) => q.replace(/\$(\d+)/g, '?$1');
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'plugin:sql|load') return args.db;
    if (cmd === 'plugin:sql|execute') {
      if (failWrites && /^INSERT/.test(args.query)) throw new Error('database or disk is full');
      const r = db.prepare(sql(args.query)).run(...args.values);
      return [r.changes, r.lastInsertRowid];
    }
    if (cmd === 'plugin:sql|select') return db.prepare(sql(args.query)).all(...args.values);
    throw new Error('unknown command ' + cmd);
  };
  return { invoke, db, calls };
}

test('records stored by one start of the app are there at the next, in order, and per lab', async () => {
  const f = fakeInvoke();
  const a = new Store('lnp-lab', { backend: sqliteBackend(f.invoke) });
  await a.ready();
  a.put('experiments', { id: 'E1', name: 'First' });
  a.put('experiments', { id: 'E2', name: 'Second' });
  a.put('batches', { id: 'E1-F1', experimentId: 'E1' });
  await a.flush();
  const demo = new Store('lnp-demo', { backend: sqliteBackend(f.invoke) });
  await demo.ready();
  demo.put('experiments', { id: 'E9', name: 'Demo' });
  await demo.flush();

  const b = new Store('lnp-lab', { backend: sqliteBackend(f.invoke) });
  await b.ready();
  assert.equal(b.engine, 'sqlite');
  assert.deepEqual(b.all('experiments').map((e) => e.id), ['E1', 'E2']);
  assert.equal(b.all('batches').length, 1);
  assert.equal(b.all('experiments').some((e) => e.id === 'E9'), false, 'the demo lab is kept apart');
});

test('one save of several collections is one statement; a refused write stores none of it', async () => {
  const f = fakeInvoke();
  const s = new Store('lnp-lab', { backend: sqliteBackend(f.invoke) });
  await s.ready();
  s.transaction(() => { s.put('experiments', { id: 'E1' }); s.put('batches', { id: 'E1-F1' }); }, { what: 'the new experiment' });
  await s.flush();
  const rows = f.db.prepare('SELECT key FROM collections ORDER BY key').all().map((r) => r.key);
  assert.deepEqual(rows, ['lnp-lab.batches', 'lnp-lab.experiments']);

  const g = fakeInvoke({ failWrites: true });
  const t = new Store('lnp-lab', { backend: sqliteBackend(g.invoke) });
  await t.ready();
  t.transaction(() => { t.put('experiments', { id: 'E1' }); t.put('batches', { id: 'E1-F1' }); }, { what: 'the new experiment' });
  const done = await t.flush();
  assert.equal(done.ok, false);
  assert.equal(g.db.prepare('SELECT count(*) AS n FROM collections').get().n, 0);
  assert.match(t.problem?.message || '', /Not saved/);
});

test('"Delete all data" empties only its own lab', async () => {
  const f = fakeInvoke();
  const lab = new Store('lnp-lab', { backend: sqliteBackend(f.invoke) });
  const demo = new Store('lnp-demo', { backend: sqliteBackend(f.invoke) });
  await lab.ready(); await demo.ready();
  lab.put('experiments', { id: 'E1' }); demo.put('experiments', { id: 'E1' });
  await lab.flush(); await demo.flush();
  await lab.clear();
  const keys = f.db.prepare('SELECT key FROM collections WHERE json IS NOT NULL').all().map((r) => r.key);
  assert.deepEqual(keys, ['lnp-demo.experiments']);
});
