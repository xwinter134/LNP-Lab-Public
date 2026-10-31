// The MCP server's real approval (spec 6.4, 12.2: "never writes without dry run and approval"), its privacy note
// (11.2), the app's mcpImport switch, a backup file as the browser version's lab (6.2), and biological data
// through it (8.3). The tool handlers are driven directly; the last test runs the real server (mcp/server.js) over
// the SDK's in-memory transport with a client that answers the elicitation, when the SDK is installed in mcp/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTools, CODE_TRIES, PRIVACY_NOTE, formatResult } from '../mcp/tools.js';
import { readLab, readBackup } from '../mcp/lab.js';
import { parseCsv } from '../app/calc/importcheck.js';
import { Store } from '../app/store.js';

const EX = new URL('../docs/historical-example/', import.meta.url).pathname;
const notRunning = () => ({ running: false, why: '' });
const rowsOf = (f) => parseCsv(readFileSync(join(EX, f), 'utf8')).map(({ __row, ...cols }) => ({ ...cols, _source: { file: join(EX, f), row: __row } }));
const exampleArgs = (bio = false) => ({ experiments: rowsOf('experiments.csv'), formulations: rowsOf('formulations.csv'), measurements: rowsOf('measurements.csv'), ...(bio ? { studies: rowsOf('studies.csv'), bioMeasurements: rowsOf('bioMeasurements.csv') } : {}) });
function makeDb(settings = { id: 'default', mcpImport: true }) {
  const dir = mkdtempSync(join(tmpdir(), 'lnp-appr-'));
  const db = join(dir, 'lnp-lab.db');
  const d = new DatabaseSync(db);
  d.exec('CREATE TABLE collections (key TEXT PRIMARY KEY, json TEXT)');
  for (const [k, v] of Object.entries({ settings: settings ? [settings] : [], experiments: [{ id: 'E1', name: 'Typed in', batchIds: [] }] })) d.prepare('INSERT INTO collections VALUES (?, ?)').run(`lnp-lab.${k}`, JSON.stringify(v));
  d.close();
  return { dir, db };
}
const nBatches = (db) => readLab(db).all('batches').length;

test('without elicitation the person types a code Claude does not get: missing or wrong codes are refused, three wrong void it', async () => {
  const { db } = makeDb();
  const t = createTools({ dbPath: db, running: notRunning, showCode: () => false });
  const args = exampleArgs();
  const dr = await t.call('dry_run_import', args);
  assert.match(dr.forPerson.confirmationCode, /^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
  assert.match(dr.approval, /type that code/);
  // Claude's part of the answer: the JSON block, without the code; the code only in the block for the person.
  const out = formatResult(dr);
  const forClaude = out.content.filter((c) => !c.annotations?.audience?.includes('user')).map((c) => c.text).join('\n');
  assert.ok(!forClaude.includes(dr.forPerson.confirmationCode), 'the code is not in what Claude reads');
  const mine = out.content.find((c) => c.annotations?.audience?.includes('user'));
  assert.ok(mine.text.includes(dr.forPerson.confirmationCode));
  assert.equal(out.content[0].text, PRIVACY_NOTE, 'the first answer of the session starts with the privacy note');

  const none = await t.call('commit_import', { ...args, token: dr.approvalToken });
  assert.equal(none.code, 'NEEDS_CONFIRMATION');
  assert.equal(nBatches(db), 0);
  for (let i = 1; i < CODE_TRIES; i++) assert.match((await t.call('commit_import', { ...args, token: dr.approvalToken, confirmation: 'AAA-AAA' })).error, /not the confirmation code/);
  assert.match((await t.call('commit_import', { ...args, token: dr.approvalToken, confirmation: 'AAA-AAA' })).error, /wrong 3 times: this approval is void/);
  assert.match((await t.call('commit_import', { ...args, token: dr.approvalToken, confirmation: dr.forPerson.confirmationCode })).error, /used already/, 'the right code after that is too late');
  assert.equal(nBatches(db), 0);

  const dr2 = await t.call('dry_run_import', args);
  const ok = await t.call('commit_import', { ...args, token: dr2.approvalToken, confirmation: dr2.forPerson.confirmationCode.toLowerCase().replace('-', ' ') });
  assert.equal(ok.ok, true, ok.error);
  assert.match(ok.approvedBy, /confirmation code/);
  assert.equal(nBatches(db), 5);
});

test('a code shown in a notification is not in the answer at all', async () => {
  const { db } = makeDb();
  let seen = null;
  const t = createTools({ dbPath: db, running: notRunning, showCode: (code, text) => { seen = { code, text }; return true; } });
  const args = exampleArgs();
  const dr = await t.call('dry_run_import', args);
  assert.equal(dr.forPerson, undefined);
  assert.ok(!JSON.stringify(dr).includes(seen.code));
  assert.match(seen.text, new RegExp(`${dr.importId}: 5 formulations, 7 measurements, 3 rows to quarantine`));
  assert.match(dr.approval, /notification/);
  const ok = await t.call('commit_import', { ...args, token: dr.approvalToken, confirmation: seen.code });
  assert.equal(ok.ok, true, ok.error);
});

test('with elicitation the client asks the person: decline voids, cancel waits, a failed ask falls back to the code', async () => {
  const { db } = makeDb();
  let answer = { action: 'decline' };
  const asked = [];
  const t = createTools({ dbPath: db, running: notRunning, showCode: () => false, canConfirm: () => true, confirm: async (p) => { asked.push(p); if (answer === 'throw') throw new Error('timed out'); return answer; } });
  const args = exampleArgs();
  const dr = await t.call('dry_run_import', args);
  assert.equal(dr.forPerson, undefined, 'no code while the client can ask');
  assert.match(dr.approval, /dialog of their own/);
  assert.equal((await t.call('commit_import', { ...args, token: dr.approvalToken })).code, 'DECLINED');
  assert.match(asked[0].message, new RegExp(`Write import ${dr.importId} into LNP Lab\\? 5 formulations`));
  assert.deepEqual(asked[0].requestedSchema.required, ['approve']);
  assert.match((await t.call('commit_import', { ...args, token: dr.approvalToken })).error, /used already/);
  const dr2 = await t.call('dry_run_import', args);
  answer = { action: 'cancel' };
  assert.equal((await t.call('commit_import', { ...args, token: dr2.approvalToken })).code, 'CANCELLED');
  answer = { action: 'accept', content: { approve: false } };
  assert.equal((await t.call('commit_import', { ...args, token: dr2.approvalToken })).code, 'DECLINED', 'accepting without ticking approve is a no');
  const dr3 = await t.call('dry_run_import', args);
  assert.equal((await t.call('commit_import', { ...args, token: dr3.approvalToken, confirmation: 'ABC-DEF' })).code, 'NO_CODE', 'a code nobody was given is not taken');
  answer = 'throw';
  const failed = await t.call('commit_import', { ...args, token: dr3.approvalToken });
  assert.equal(failed.code, 'ASK_FAILED');
  assert.ok(!failed.error.includes(failed.forPerson.confirmationCode), 'the code goes to the person, not into the error Claude reads');
  const ok = await t.call('commit_import', { ...args, token: dr3.approvalToken, confirmation: failed.forPerson.confirmationCode });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(nBatches(db), 5);
  answer = { action: 'accept', content: { approve: true } };
  const { db: db2 } = makeDb();
  const t2 = createTools({ dbPath: db2, running: notRunning, canConfirm: () => true, confirm: async () => answer });
  const d = await t2.call('dry_run_import', args);
  const c = await t2.call('commit_import', { ...args, token: d.approvalToken });
  assert.equal(c.ok, true, c.error);
  assert.match(c.approvedBy, /confirmation dialog/);
});

test('the privacy note comes with the first answer of a session only, whatever the tool', async () => {
  const t = createTools({ dbPath: makeDb().db, running: notRunning });
  const a = await t.call('get_schema');
  assert.equal(a.privacy, PRIVACY_NOTE);
  assert.match(a.privacy, /Claude reads your lab data[\s\S]*sent to Anthropic[\s\S]*sends nothing over the network/);
  assert.equal((await t.call('list_catalog')).privacy, undefined);
  const t2 = createTools({ dbPath: makeDb().db });
  assert.equal((await t2.call('no_such_tool')).privacy, PRIVACY_NOTE, 'even an error carries it, if it comes first');
});

test('the app\'s mcpImport setting: off, the write tools refuse unless the server was started to allow it', async () => {
  const args = exampleArgs();
  for (const settings of [null, { id: 'default', mcpImport: false }]) {
    const { db } = makeDb(settings);
    const t = createTools({ dbPath: db, running: notRunning, canConfirm: () => true, confirm: async () => ({ action: 'accept', content: { approve: true } }) });
    const dr = await t.call('dry_run_import', args);
    assert.equal(dr.ok, true, 'a dry run reads only');
    assert.match(dr.importModule, /^off: Import with Claude is switched off in LNP Lab/);
    const c = await t.call('commit_import', { ...args, token: dr.approvalToken });
    assert.equal(c.code, 'IMPORT_OFF');
    assert.match(c.error, /Settings › Claude › Import with Claude[\s\S]*LNP_LAB_ALLOW_IMPORT=1/);
    assert.equal((await t.call('rollback_import', { importId: 'imp-x' })).code, 'IMPORT_OFF');
    assert.equal(nBatches(db), 0);
    const allowed = createTools({ dbPath: db, running: notRunning, allowImport: true, canConfirm: () => true, confirm: async () => ({ action: 'accept', content: { approve: true } }) });
    const d2 = await allowed.call('dry_run_import', args);
    assert.equal(d2.importModule, undefined);
    assert.equal((await allowed.call('commit_import', { ...args, token: d2.approvalToken })).ok, true);
  }
});

test('a backup file is the browser version\'s lab for quality_report and list_imports, and numbers a dry run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lnp-bak-'));
  // A browser lab with one import in it, saved with Settings › Export everything.
  const first = createTools({ dbPath: join(dir, 'none.db'), outDir: dir, running: notRunning, canConfirm: () => true, confirm: async () => ({ action: 'accept', content: { approve: true } }) });
  const args = exampleArgs();
  const dr = await first.call('dry_run_import', { ...args, first_experiment: 7 });
  const c = await first.call('commit_import', { ...args, first_experiment: 7, token: dr.approvalToken });
  const s = new Store('lnp-lab', { backend: { kind: 'memory', load: async () => ({}), write: async () => {}, clear: async () => {} } });
  await s.ready();
  s.importAll(JSON.parse(readFileSync(c.written, 'utf8')), { merge: true });
  s.put('settings', { id: 'default', mcpImport: true });
  const backup = join(dir, 'lnp-lab-backup.json');
  writeFileSync(backup, JSON.stringify(s.exportAll()));
  assert.equal(readBackup(backup).all('batches').length, 5);

  const t = createTools({ dbPath: join(dir, 'none.db'), outDir: dir, running: notRunning });
  const empty = await t.call('list_imports');
  assert.equal(empty.imports.length, 0);
  assert.match(empty.note, /Pass backup/);
  const li = await t.call('list_imports', { backup });
  assert.equal(li.lab, 'backup');
  assert.equal(li.imports[0].id, dr.importId);
  assert.equal(li.imports[0].quarantineOpen, 3);
  const q = await t.call('quality_report', { backup, importId: dr.importId });
  assert.equal(q.ok, true, q.error);
  assert.equal(q.counts.formulations, 5);
  assert.match((await t.call('quality_report', { backup: join(dir, 'gone.json') })).error, /not there/);
  // Started with the backup as its lab, a dry run numbers after it without being told, and sees the duplicates.
  const tb = createTools({ dbPath: join(dir, 'none.db'), outDir: dir, backupPath: backup, running: notRunning });
  const again = await tb.call('dry_run_import', args);
  assert.equal(again.ok, true, again.error);
  assert.equal(again.report.counts.formulations.duplicates, 5);
  assert.equal((await tb.call('list_imports')).lab, 'backup');
});

test('studies and biological values through the MCP server: dry run, commit, list, and a study number for an import file', async () => {
  const { db } = makeDb();
  const t = createTools({ dbPath: db, running: notRunning, canConfirm: () => true, confirm: async () => ({ action: 'accept', content: { approve: true } }) });
  const args = exampleArgs(true);
  const schema = await t.call('get_schema');
  assert.ok(schema.tables.studies && schema.tables.bioMeasurements && schema.layers.length === 4);
  const dr = await t.call('dry_run_import', args);
  assert.deepEqual(dr.report.counts.studies, { read: 4, importable: 3, refused: 1, duplicates: 0 });
  assert.deepEqual(dr.newStudies.map((x) => x.id), ['Study-001']);
  assert.equal(dr.newBioMeasurements, 12);
  assert.match(dr.markdown, /Biological values \| 13 \| 12 \| 1 \| 0/);
  const c = await t.call('commit_import', { ...args, token: dr.approvalToken });
  assert.equal(c.ok, true, c.error);
  assert.deepEqual(c.studies, ['Study-001']);
  const L = readLab(db);
  assert.equal(L.all('bioMeasurements').length, 12);
  assert.equal(L.all('studies')[0].groups[0].batchId, 'E2-F2');
  assert.equal(L.all('quarantine').length, 5);
  assert.equal((await t.call('list_imports')).imports[0].live.bioMeasurements, 12);
  // Biological rows alone are an import too; for an import file the study number has to be given.
  const dir = mkdtempSync(join(tmpdir(), 'lnp-biof-'));
  const f = createTools({ dbPath: join(dir, 'none.db'), outDir: dir, running: notRunning, canConfirm: () => true, confirm: async () => ({ action: 'accept', content: { approve: true } }) });
  const bio = { studies: [{ study_key: 'S1', group: 'R', role: 'reference', formulation_id: 'E4-F1' }], bioMeasurements: [] };
  assert.match((await f.call('dry_run_import', bio)).error, /pass first_study/);
  const d = await f.call('dry_run_import', { ...bio, first_study: 12 });
  assert.equal(d.ok, true, d.error);
  assert.match(d.quarantine[0].reason, /formulation_id E4-F1 is not in the lab/, 'without the lab, a formulation id cannot be checked');
});

test('the real server over MCP: the client is asked to confirm (elicitation), and the privacy note opens the session', async (t) => {
  const sdk = new URL('../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url);
  if (!existsSync(sdk)) { t.skip('the MCP SDK is not installed in mcp/ (cd mcp && npm install)'); return; }
  const { Client } = await import(new URL('client/index.js', sdk));
  const { InMemoryTransport } = await import(new URL('inMemory.js', sdk));
  const { ElicitRequestSchema } = await import(new URL('types.js', sdk));
  const { makeServer } = await import('../mcp/server.js');
  const { db } = makeDb();
  const { server } = makeServer({ dbPath: db, running: notRunning, showCode: () => false });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: { elicitation: {} } });
  const asked = [];
  client.setRequestHandler(ElicitRequestSchema, async (req) => { asked.push(req.params); return { action: 'accept', content: { approve: true } }; });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const args = exampleArgs();
  const dr = await client.callTool({ name: 'dry_run_import', arguments: args });
  assert.equal(dr.content[0].text, PRIVACY_NOTE);
  const body = JSON.parse(dr.content[dr.content.length - 1].text);
  assert.equal(body.forPerson, undefined);
  const c = await client.callTool({ name: 'commit_import', arguments: { ...args, token: body.approvalToken } });
  assert.equal(c.isError, false, c.content.map((x) => x.text).join('\n'));
  assert.equal(asked.length, 1);
  assert.match(asked[0].message, /Write import imp-/);
  assert.equal(nBatches(db), 5);
  await client.close();
});
