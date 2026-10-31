// The MCP import server (mcp/tools.js, spec 6) and the insights bridge (spec 10), driven through its tool handlers
// directly, not over stdio, against a database file this test makes in a temporary folder (never the real one).
// The MCP SDK is not needed for these: mcp/server.js only wires the same handlers to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createTools, TOKEN_MINUTES } from '../mcp/tools.js';
import { invokeOn, readLab } from '../mcp/lab.js';
import { readXlsx, serialDate } from '../mcp/xlsx.js';
import { Store, sqliteBackend, failureKind } from '../app/store.js';
import { parseCsv } from '../app/calc/importcheck.js';
import { recheckQuarantine, openQuarantine, listImports, rollbackImport, importRecords } from '../app/calc/importops.js';
import { reportStatus, latestReport, STALE_AFTER } from '../app/calc/insightreport.js';
import { crc32 } from '../app/calc/xlsx.js';

const EX = new URL('../docs/historical-example/', import.meta.url).pathname;
const notRunning = () => ({ running: false, why: '' });

/** A lab database like the app's: one row per collection. E1 exists, so the import numbers after it. */
function makeDb(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lnp-mcp-'));
  const db = join(dir, 'lnp-lab.db');
  const d = new DatabaseSync(db);
  d.exec('CREATE TABLE collections (key TEXT PRIMARY KEY, json TEXT)');
  const cols = { experiments: [{ id: 'E1', name: 'Typed in', type: 'single', batchIds: ['E1-F1'] }], batches: [{ id: 'E1-F1', experimentId: 'E1', compositionId: 1, plan: { conditions: {} }, provenance: { source: 'manual' } }], ...extra };
  for (const [k, v] of Object.entries(cols)) d.prepare('INSERT INTO collections VALUES (?, ?)').run(`lnp-lab.${k}`, JSON.stringify(v));
  d.close();
  return { dir, db };
}
/** The example tables as Claude would pass them: columns, plus where each row came from. */
const rowsOf = (f) => parseCsv(readFileSync(join(EX, f), 'utf8')).map(({ __row, ...cols }) => ({ ...cols, _source: { file: join(EX, f), row: __row } }));
const exampleArgs = () => ({ experiments: rowsOf('experiments.csv'), formulations: rowsOf('formulations.csv'), measurements: rowsOf('measurements.csv') });
const count = (db, col) => readLab(db).all(col).length;
const shipped = () => ({ lipids: JSON.parse(readFileSync(new URL('../app/data/lipids.json', import.meta.url))), compositions: JSON.parse(readFileSync(new URL('../app/data/compositions.json', import.meta.url))) });
/** The app's own store on the file, as the macOS window opens it. */
async function appStore(db) { const s = new Store('lnp-lab', { backend: sqliteBackend(invokeOn(new DatabaseSync(db))) }); await s.ready(); return s; }

test('dry run, approval token, commit, list, rollback into the trash, and restore from it', async () => {
  const { db } = makeDb();
  const t = createTools({ dbPath: db, running: notRunning });
  const args = exampleArgs();
  const dr = await t.call('dry_run_import', args);
  assert.equal(dr.ok, true);
  assert.equal(count(db, 'batches'), 1, 'a dry run writes nothing');
  assert.deepEqual(dr.report.counts.formulations, { read: 6, importable: 5, refused: 1, duplicates: 0 });
  assert.deepEqual(dr.report.counts.measurements, { read: 9, importable: 7, refused: 2, duplicates: 0 });
  assert.deepEqual(dr.newExperiments.map((e) => e.id), ['E2', 'E3'], 'numbered after the lab');
  assert.ok(dr.quarantine.some((q) => /Lipid-X/.test(q.reason)));
  assert.ok(dr.quarantine.some((q) => /PDI 8\.5 is outside 0–1, probably a typing slip/.test(q.reason)));
  assert.equal(dr.report.completeness.find((c) => c.key === 'frr').share, 100, 'the completeness matrix of the Data overview');
  assert.match(dr.markdown, /\| Formulations \| 6 \| 5 \| 1 \| 0 \|/);
  assert.match(dr.approvalToken, /^[0-9a-f]{32}$/);

  const c = await t.call('commit_import', { ...args, token: dr.approvalToken });
  assert.equal(c.ok, true, c.error);
  assert.equal(c.importId, dr.importId);
  const L = readLab(db);
  assert.equal(L.all('batches').length, 6);
  const b = L.all('batches').find((x) => x.id === 'E2-F1');
  assert.equal(b.provenance.source, 'mcp-import');
  assert.equal(b.provenance.importId, dr.importId);
  assert.equal(b.provenance.file.name, 'formulations.csv');
  assert.match(b.provenance.file.sha256, /^[0-9a-f]{64}$/);
  assert.equal(b.provenance.row, 2);
  assert.ok(b.provenance.importedAt);
  assert.equal(L.all('quarantine').length, 3, 'refused rows are kept, with their reason');
  assert.ok(L.all('quarantine').every((q) => q.status === 'open' && q.reason && q.mapping && q.importId === dr.importId));
  assert.equal(L.all('counters').find((x) => x.id === 'experiment').top, 3);
  const stamp = new DatabaseSync(db, { readOnly: true }).prepare("SELECT json FROM collections WHERE key = '_app.changed'").get();
  assert.equal(JSON.parse(stamp.json).importId, dr.importId, 'the commit stamps the file for the app');

  const list = await t.call('list_imports');
  assert.equal(list.imports.length, 1);
  assert.equal(list.imports[0].inLab, true);
  assert.equal(list.imports[0].quarantineOpen, 3);
  assert.equal(list.imports[0].live.batches, 5);

  const q = await t.call('quality_report', { importId: dr.importId });
  assert.equal(q.counts.formulations, 5);
  assert.equal(q.openQuarantine.length, 3);

  const r = await t.call('rollback_import', { importId: dr.importId });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.moved, { experiments: 2, batches: 5, measurements: 7, compositions: 1, studies: 0, bioMeasurements: 0, quarantine: 3 });
  const after = readLab(db);
  assert.deepEqual(after.all('batches').map((x) => x.id), ['E1-F1'], 'only what was typed in is left');
  assert.equal(after.all('trash').length, 1);
  assert.equal((await t.call('list_imports')).imports[0].inTrash, true);

  // Restored the way Settings › Recently deleted does it, through the app's store on the file.
  const s = await appStore(db);
  const back = s.restoreFromTrash(after.all('trash')[0].id);
  assert.equal(back.ok, true, back.reason);
  assert.equal((await s.flush()).ok, true);
  assert.equal(count(db, 'batches'), 6);
  assert.equal(count(db, 'measurements'), 7);
  assert.equal((await t.call('list_imports')).imports[0].inLab, true);
});

test('a commit without a token, with a used, expired or foreign token, or with other rows is refused and writes nothing', async () => {
  const { db } = makeDb();
  let clock = new Date('2026-10-31T10:00:00Z');
  const t = createTools({ dbPath: db, running: notRunning, now: () => clock });
  const args = exampleArgs();
  assert.match((await t.call('commit_import', args)).error, /no valid approval token/);
  assert.match((await t.call('commit_import', { ...args, token: 'f'.repeat(32) })).error, /no valid approval token/);
  const dr = await t.call('dry_run_import', args);
  const changed = { ...args, formulations: args.formulations.map((r, i) => (i === 0 ? { ...r, frr: '9' } : r)) };
  assert.match((await t.call('commit_import', { ...changed, token: dr.approvalToken })).error, /not the ones the dry run checked/);
  clock = new Date(clock.getTime() + (TOKEN_MINUTES + 1) * 60e3);
  assert.match((await t.call('commit_import', { ...args, token: dr.approvalToken })).error, /expired/);
  assert.equal(count(db, 'batches'), 1);

  const dr2 = await t.call('dry_run_import', args);
  assert.equal((await t.call('commit_import', { ...args, token: dr2.approvalToken })).ok, true);
  assert.match((await t.call('commit_import', { ...args, token: dr2.approvalToken })).error, /used already/);
  // A token of another server process (another lab) is not known here.
  const other = createTools({ dbPath: makeDb().db, running: notRunning });
  assert.match((await other.call('commit_import', { ...args, token: dr2.approvalToken })).error, /no valid approval token/);
});

test('the same rows twice are recognised by file hash and row, and the lab changing after the dry run voids it', async () => {
  const { db } = makeDb();
  const t = createTools({ dbPath: db, running: notRunning });
  const args = exampleArgs();
  const first = await t.call('dry_run_import', args);
  await t.call('commit_import', { ...args, token: first.approvalToken });
  const again = await t.call('dry_run_import', args);
  assert.deepEqual(again.report.counts.formulations, { read: 6, importable: 0, refused: 1, duplicates: 5 });
  assert.equal(again.report.counts.measurements.duplicates, 7);
  assert.match(again.duplicates[0].reason, new RegExp(`already imported in ${first.importId}`));
  // A row named twice in one import is a duplicate too.
  const twice = await t.call('dry_run_import', { formulations: [args.formulations[0], args.formulations[0]].map((r) => ({ ...r, exp_key: 'NEW-1' })) });
  assert.equal(twice.report.counts.formulations.duplicates, 2, 'both are already in from the first import');

  // Rows of a new file, then the lab changes in the app before the commit: the token no longer fits.
  const fresh = { formulations: [{ exp_key: 'GH-2025-01', form_key: 'F1', composition_id: 1, frr: 3, _source: { file: join(EX, 'formulations.csv'), sheet: 'other', row: 99 } }] };
  const dr = await t.call('dry_run_import', fresh);
  assert.equal(dr.report.counts.formulations.importable, 1);
  const s = await appStore(db);
  s.put('experiments', { id: 'E4', name: 'made in the app meanwhile', batchIds: [] });
  await s.flush();
  const c = await t.call('commit_import', { ...fresh, token: dr.approvalToken });
  assert.match(c.error, /the lab changed since the dry run/);
  assert.equal(count(db, 'experiments'), 4);
});

test('nothing is written while the app is running, and an app that was open after all does not write over the import', async () => {
  const { db, dir } = makeDb();
  const args = exampleArgs();
  const busy = createTools({ dbPath: db, running: () => ({ running: true, why: 'LNP Lab is open (process 4242)' }) });
  const dr = await busy.call('dry_run_import', args);
  assert.equal(dr.ok, true, 'reading is fine while it runs');
  const c = await busy.call('commit_import', { ...args, token: dr.approvalToken });
  assert.equal(c.code, 'APP_RUNNING');
  assert.match(c.error, /Quit LNP Lab/);
  assert.equal(count(db, 'batches'), 1);
  // The lock file the app writes (src-tauri/src/lib.rs) names a live process: this test's own.
  writeFileSync(join(dir, 'lnp-lab.app.lock'), JSON.stringify({ pid: process.pid, startedAt: 0 }));
  const real = createTools({ dbPath: db });
  const dr0 = await real.call('dry_run_import', args);
  assert.match((await real.call('commit_import', { ...args, token: dr0.approvalToken })).error, /LNP Lab is open \(process \d+/);
  // A lock left by a crash (its process is gone) does not block.
  writeFileSync(join(dir, 'lnp-lab.app.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 0 }));

  // The window opened before the import and was missed by every check: its next save stores nothing, says why,
  // and the import stays.
  const win = await appStore(db);
  const t = createTools({ dbPath: db, running: notRunning });
  const dr2 = await t.call('dry_run_import', args);
  assert.equal((await t.call('commit_import', { ...args, token: dr2.approvalToken })).ok, true);
  win.put('batches', { id: 'E1-F2', experimentId: 'E1' });
  const w = await win.flush();
  assert.equal(w.ok, false);
  assert.equal(failureKind(w.error), 'outside');
  assert.match(win.problem.message, /changed by the import tool \(MCP\) while this window was open\. Reload/);
  assert.equal(count(db, 'batches'), 6, 'the import is still there');
  const reopened = await appStore(db);
  reopened.put('batches', { id: 'E1-F2', experimentId: 'E1' });
  assert.equal((await reopened.flush()).ok, true, 'after a reload the window writes again');
});

test('read_file reads every sheet of an .xlsx: shared strings, deflated entries, dates, empty cells', () => {
  const enc = (s) => Buffer.from(s, 'utf8');
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Formulations" sheetId="1" r:id="rId1"/><sheet name="DLS &amp; EE" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Sample</t></si><si><r><t>Date</t></r><r><t xml:space="preserve"> made</t></r></si><si><t>ALC-0315 &lt;new&gt;</t></si></sst>',
    'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="2"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="3"><c r="A3" t="s"><v>2</v></c><c r="C3" s="1"><v>45366</v></c><c r="D3" s="2"><v>0.125</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>PDI</t></is></c><c r="C2" t="b"><v>1</v></c><c r="D2" t="str"><v>=A1</v></c></row></sheetData></worksheet>',
  };
  // A zip with every entry deflated (method 8), as Excel writes them.
  const local = [], central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc(text), data = deflateRawSync(raw), nb = enc(name), crc = crc32(raw);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nb.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    local.push(h, nb, data); central.push(c, nb); off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  const buf = Buffer.concat([...local, cd, end]);
  const sheets = readXlsx(buf);
  assert.deepEqual(sheets.map((s) => s.name), ['Formulations', 'DLS & EE']);
  assert.deepEqual(sheets[0].rows, [{ row: 1, cells: ['Sample', 'Date made'] }, { row: 3, cells: ['ALC-0315 <new>', null, '2024-03-15', 0.125] }]);
  assert.deepEqual(sheets[1].rows, [{ row: 2, cells: [null, 'PDI', true, '=A1'] }]);
  assert.equal(serialDate(45366.5), '2024-03-15 12:00');

  const dir = mkdtempSync(join(tmpdir(), 'lnp-xlsx-'));
  writeFileSync(join(dir, 'old.xlsx'), buf);
  const t = createTools({ dbPath: join(dir, 'none.db') });
  return t.call('read_file', { path: join(dir, 'old.xlsx') }).then((r) => {
    assert.equal(r.ok, true);
    assert.equal(r.sheets.length, 2);
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
  });
});

test('the browser version gets an import file, merged in by Settings › Import JSON, quarantine included', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lnp-file-'));
  const t = createTools({ dbPath: join(dir, 'missing.db'), outDir: dir, running: notRunning });
  const args = exampleArgs();
  assert.match((await t.call('dry_run_import', args)).error, /pass first_experiment/);
  const dr = await t.call('dry_run_import', { ...args, first_experiment: 42 });
  assert.equal(dr.target, 'file');
  assert.deepEqual(dr.newExperiments.map((e) => e.id), ['E42', 'E43']);
  const c = await t.call('commit_import', { ...args, first_experiment: 42, token: dr.approvalToken });
  assert.equal(c.ok, true, c.error);
  assert.ok(existsSync(c.written));
  const s = new Store('lnp-lab', { backend: { kind: 'memory', load: async () => ({}), write: async () => {}, clear: async () => {} } });
  await s.ready();
  const done = s.importAll(JSON.parse(readFileSync(c.written, 'utf8')), { merge: true });
  assert.ok(done.records > 10);
  assert.equal(s.all('quarantine').length, 3);
  assert.equal(listImports(s)[0].id, dr.importId);
  // And undone from the app, whole (Settings › Imports › Undo import).
  const r = rollbackImport(s, dr.importId);
  assert.equal(r.ok, true);
  assert.equal(s.all('batches').length, 0);
  assert.match((await t.call('rollback_import', { importId: dr.importId })).error, /Undo import/);
});

test('a quarantined row, fixed and checked again, joins its import; a measurement then finds its formulation', async () => {
  const { db } = makeDb();
  const t = createTools({ dbPath: db, running: notRunning });
  const args = exampleArgs();
  const dr = await t.call('dry_run_import', args);
  await t.call('commit_import', { ...args, token: dr.approvalToken });
  const s = await appStore(db);
  const data = shipped();
  const form = openQuarantine(s).find((q) => q.table === 'formulations');
  // Still wrong: the same reason comes back, and the entry keeps the typed values.
  const still = recheckQuarantine(s, data, form.id, { ...form.mapping, ionizable_lipid: 'Lipid-Y' });
  assert.equal(still.ok, false);
  assert.match(still.reason, /Lipid-Y/);
  assert.equal(s.get('quarantine', form.id).mapping.ionizable_lipid, 'Lipid-Y');
  const fixed = recheckQuarantine(s, data, form.id, { ...form.mapping, ionizable_lipid: 'DLin-MC3-DMA' });
  assert.equal(fixed.ok, true, fixed.reason);
  const b = s.get('batches', fixed.ids.find((id) => /-F\d+$/.test(id)));
  assert.equal(b.experimentId, 'E3', 'it joins the experiment of its own import');
  assert.equal(b.provenance.importId, dr.importId);
  assert.equal(b.provenance.fixedFrom, form.id);
  assert.ok(s.get('experiments', 'E3').batchIds.includes(b.id));
  assert.equal(s.get('quarantine', form.id).status, 'fixed');
  const meas = openQuarantine(s).find((q) => /no formulation GH-2024-05\/C/.test(q.reason));
  const m = recheckQuarantine(s, data, meas.id, meas.mapping);
  assert.equal(m.ok, true, m.reason);
  assert.equal(s.get('measurements', m.ids[0]).batchId, b.id);
  assert.equal((await s.flush()).ok, true);
  // The whole import, the fixed rows with it, goes in one rollback; a result typed in later goes along and is said.
  s.put('measurements', { id: 'M-hand', batchId: 'E2-F1', test: 'zeta', values: { zeta_mV: -2 } });
  const recs = importRecords(s, dr.importId);
  assert.equal(recs.others, 1);
  assert.equal(recs.counts.batches, 6);
});

test('the insight tools are off unless the personal build is on; a report must name its analyses and formulations', async () => {
  const { db } = makeDb();
  const off = createTools({ dbPath: db, running: notRunning });
  assert.equal(off.list().some((d) => d.name === 'summarize_database'), false);
  assert.match((await off.call('summarize_database')).error, /insights module, which is off/);
  // Switched on in the lab's settings (Settings › Claude insights, in a personal build).
  const on0 = createTools({ dbPath: makeDb({ settings: [{ id: 'default', personalBuild: true }] }).db, running: notRunning });
  assert.equal(on0.list().some((d) => d.name === 'save_insight_report'), true);

  const t = createTools({ dbPath: db, running: notRunning, personal: true });
  const args = exampleArgs();
  await t.call('commit_import', { ...args, token: (await t.call('dry_run_import', args)).approvalToken });
  const sum = await t.call('summarize_database');
  assert.equal(sum.counts.formulations, 6);
  assert.equal(sum.dataState.formulations, 6);
  const q = await t.call('query_formulations', { filter: { ionizable: 'ALC-0315' } });
  assert.equal(q.total, 3);
  assert.match(q.description, /3 formulations/);
  const tr = await t.call('get_trends', { responses: ['zave_nm'], colorBy: ['compositionId'] });
  assert.equal(tr.ok, true);
  assert.ok(tr.trends.some((x) => x.analysis === 'correlation'));
  assert.equal((await t.call('get_optimizer_state')).ok, true);

  const bad = await t.call('save_insight_report', { findings: [{ text: 'FRR drives size', analysis: 'my own regression', formulationIds: ['E2-F1', 'E99-F1'] }] });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => /use one of/.test(p)));
  assert.ok(bad.problems.some((p) => /E99-F1/.test(p)));
  const good = await t.call('save_insight_report', { findings: [{ text: 'Higher FRR, smaller particles', analysis: 'correlation', formulationIds: ['E2-F1', 'E2-F2', 'E2-F3'], value: 'r −0.99' }] });
  assert.equal(good.ok, true, good.error);
  const L = readLab(db);
  const rep = latestReport(L);
  assert.deepEqual(rep.dataState, { formulations: 6, lastDate: '2024-05-03' });
  assert.equal(reportStatus(rep, L).stale, false);
  const more = { ...L, all: (c) => (c === 'batches' ? [...L.all('batches'), ...Array.from({ length: STALE_AFTER + 1 }, (_, i) => ({ id: `E9-F${i + 1}` }))] : L.all(c)) };
  assert.deepEqual(reportStatus(rep, more), { added: STALE_AFTER + 1, stale: true });
});
