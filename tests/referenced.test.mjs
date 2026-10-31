// Nothing still referenced is ever hard-deleted (spec 9.5, 12.2), and what goes with it: every kind of component
// asks the one helper where it is used, the trash keeps an entry something still names, buffer lots carry what
// their overview shows, the provenance symbol has its details, and a pre-migration copy can be put back (4.4).
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  get length() { return mem.size; },
  key: (i) => [...mem.keys()][i] ?? null,
};
const { Store, TRASH_DAYS } = await import('../app/store.js');
const { whereUsed, trashEntryUses, bufferUseCounter, experimentBioUses, archive, KINDS, kindOfCollection } = await import('../app/calc/usage.js');
const { lotFacts, checkBufferCode } = await import('../app/calc/buffer.js');
const { getRef, catalogWithCodes } = await import('../app/refdata.js');
const { provenanceDetails } = await import('../app/calc/provenance.js');
const { backupBeforeMigration, restorePreMigration, preMigrationFile, SCHEMA_VERSION } = await import('../app/migrate.js');

const ids = (used) => used.map((u) => `${u.collection}:${u.id}`).sort();

/** A small lab where every kind of component is named by something, and one of each is not. */
function lab() {
  mem.clear();
  const s = new Store('lnp-lab');
  s.replace('lipids', [{ id: 'MY-ION', key: 'MY-ION', name: 'My ionizable', class: 'ionizable', mw: 700 }, { id: 'SPARE', key: 'SPARE', name: 'Spare', class: 'helper', mw: 500 }]);
  s.replace('lipidLots', [{ id: 'lot-a', lipidKey: 'MY-ION', lot: 'A1' }, { id: 'lot-b', lipidKey: 'MY-ION', lot: 'B1' }]);
  s.replace('compositions', [{ id: 101, mol_pct: { 'MY-ION': 50, DSPC: 10, Chol: 38.5, 'DMG-PEG2000': 1.5 } }, { id: 102, mol_pct: { DSPC: 100 } }, { id: 103, mol_pct: { Chol: 100 } }]);
  s.replace('stocks', [{ id: 'Stock-001', compositionId: 102, rows: [{ key: 'MY-ION', lotId: 'lot-a' }] }]);
  s.replace('rnaLots', [{ id: 'RNA-1' }, { id: 'RNA-2' }]);
  s.replace('buffers', [{ id: 'Buffer-001', lot: 'CIT50-pH4.0-20261031' }, { id: 'Buffer-002', lot: 'PBS1X-pH7.4-20261031' }]);
  s.replace('devices', [{ id: 'my-rig', name: 'My rig' }]);
  s.replace('tffModules', [{ id: 'MY-TFF', part: 'MY-TFF', surface_cm2: 20 }]);
  s.replace('dialysis', [{ id: 'mini', name: 'Mini 3.5K' }]);
  s.replace('experiments', [{ id: 'E1', batchIds: ['E1-F1'], spec: { rnaLotId: 'RNA-1', compositionId: 101 } }]);
  s.replace('batches', [{ id: 'E1-F1', experimentId: 'E1', compositionId: 101, stockId: 'Stock-001', status: 'made',
    // Buffer-001 is named twice, by its lot name and by its Buffer number: one formulation all the same.
    plan: { rna: { lotId: 'RNA-1', diluent: 'Buffer-001' }, process: { deviceId: 'my-rig', mixerId: 't-mixer', aqueous: { buffer: 'CIT50-pH4.0-20261031' },
      downstream: [{ step: 'tff', device: 'MY-TFF' }, { step: 'dialysis', device: 'Mini 3.5K' }, { step: 'filtration', device: 'Sartorius 0.2 µm PES' }] } } }]);
  s.replace('studies', [{ id: 'Study-001', groups: [{ id: 'G1', batchId: 'E1-F1' }], experimentIds: [] }]);
  s.replace('bioMeasurements', [{ id: 'bm1', studyId: 'Study-001', batchId: 'E1-F1', value: 1 }]);
  s.replace('measurements', []);
  return s;
}

test('every kind of component is found where it is used, through the one helper', () => {
  const s = lab();
  assert.deepEqual(ids(whereUsed(s, 'lipid', 'MY-ION')), ['compositions:101', 'lipidLots:lot-a', 'lipidLots:lot-b', 'stocks:Stock-001']);
  assert.deepEqual(whereUsed(s, 'lipid', 'SPARE'), []);
  assert.deepEqual(ids(whereUsed(s, 'lipid', 'DSPC', { compositions: [{ id: 1, mol_pct: { DSPC: 10 } }] })), ['compositions:1'], 'the shipped recipes when given');
  assert.deepEqual(ids(whereUsed(s, 'lipidLot', 'lot-a')), ['stocks:Stock-001'], 'a stock row names its lot by id');
  assert.deepEqual(whereUsed(s, 'lipidLot', 'lot-b'), []);
  assert.deepEqual(ids(whereUsed(s, 'composition', 101)), ['batches:E1-F1', 'experiments:E1']);
  assert.deepEqual(ids(whereUsed(s, 'composition', 102)), ['stocks:Stock-001'], 'a recipe only a stock uses is used');
  assert.deepEqual(whereUsed(s, 'composition', 103), []);
  assert.deepEqual(ids(whereUsed(s, 'rnaLot', 'RNA-1')), ['batches:E1-F1', 'experiments:E1'], 'the wizard\'s spec.rnaLotId too');
  assert.deepEqual(whereUsed(s, 'rnaLot', 'RNA-2'), []);
  assert.equal(whereUsed(s, 'buffer', 'Buffer-001').length, 1, 'named twice, used once');
  assert.deepEqual(whereUsed(s, 'buffer', 'Buffer-002'), []);
  assert.deepEqual(ids(whereUsed(s, 'device', 'my-rig')), ['batches:E1-F1']);
  assert.deepEqual(whereUsed(s, 'device', 'nanoscaler'), []);
  assert.deepEqual(ids(whereUsed(s, 'mixer', 't-mixer')), ['batches:E1-F1']);
  assert.deepEqual(ids(whereUsed(s, 'tffModule', 'MY-TFF')), ['batches:E1-F1']);
  assert.deepEqual(ids(whereUsed(s, 'dialysis', 'mini')), ['batches:E1-F1'], 'by its name, read from the record');
  assert.deepEqual(ids(whereUsed(s, 'dialysis', 'shipped-x', { rec: { id: 'shipped-x', name: 'Mini 3.5K' } })), ['batches:E1-F1'], 'a shipped one passed in');
  assert.deepEqual(ids(whereUsed(s, 'filter', 'Sartorius 0.2 µm PES')), ['batches:E1-F1']);
  assert.deepEqual(whereUsed(s, 'filter', 'None'), []);
  assert.deepEqual(ids(whereUsed(s, 'stock', 'Stock-001')), ['batches:E1-F1']);
  assert.deepEqual(ids(whereUsed(s, 'batch', 'E1-F1')), ['bioMeasurements:bm1', 'studies:Study-001']);
  assert.throws(() => whereUsed(s, 'reagent', 'x'), /no kind "reagent"/);
  assert.equal(kindOfCollection('tffModules'), 'tffModule');
  assert.ok(Object.values(KINDS).filter((k) => k.archivable).length >= 10);
});

test('a batch naming a lot by its name and by its number counts once in the overview', () => {
  const s = lab();
  const count = bufferUseCounter(s);
  assert.equal(count(s.get('buffers', 'Buffer-001')), 1);
  assert.equal(count(s.get('buffers', 'Buffer-002')), 0);
  assert.equal(count({ id: 'Buffer-009', lot: 'X', aliases: ['CIT50-pH4.0-20261031'] }), 1, 'an alias counts as a name');
});

test('deleting an experiment a study names says so', () => {
  const s = lab();
  assert.deepEqual(experimentBioUses(s, s.get('experiments', 'E1'), s.all('batches')), ['study Study-001', '1 study value']);
  assert.deepEqual(experimentBioUses(s, { id: 'E9' }, []), []);
});

test('the trash keeps an entry something still names, past 30 days and through Empty trash', () => {
  const s = lab();
  const t0 = new Date('2026-08-01T10:00:00Z');
  const exp = s.moveToTrash([['experiments', 'E1'], ['batches', 'E1-F1']], { kind: 'experiment' }, t0);
  const lot = s.moveToTrash([['lipidLots', 'lot-b']], { kind: 'lipid lot' }, t0);
  assert.deepEqual(ids(trashEntryUses(s, exp)), ['bioMeasurements:bm1', 'studies:Study-001']);
  assert.deepEqual(trashEntryUses(s, lot), [], 'nothing names lot B1');
  // A record in the same entry does not keep it: the experiment names its own formulation.
  const later = new Date(t0.getTime() + (TRASH_DAYS + 1) * 864e5);
  s.moveToTrash([['rnaLots', 'RNA-2']], {}, later);
  const kept = s.all('trash').map((t) => t.id);
  assert.ok(kept.includes(exp.id), 'the experiment a study names stays past its days');
  assert.ok(!kept.includes(lot.id), 'the lot nothing names expires');
  assert.ok(s.recentTrash({ now: later }).some((t) => t.id === exp.id), 'and is listed, so it can still be restored');
  assert.deepEqual(s.emptyTrash(), { erased: 1, kept: 1 });
  assert.deepEqual(s.all('trash').map((t) => t.id), [exp.id]);
  // Once nothing names it, it can go.
  s.replace('studies', []); s.replace('bioMeasurements', []);
  assert.deepEqual(s.emptyTrash(), { erased: 1, kept: 0 });
  assert.equal(s.count('trash'), 0);
});

test('a referenced component stays in the store, archived, readable and out of the pickers', () => {
  const s = lab();
  archive(s, 'device', 'my-rig'); archive(s, 'tffModule', 'MY-TFF'); archive(s, 'filter', 'Sartorius 0.2 µm PES'); archive(s, 'dialysis', 'mini');
  const data = { lipids: [], compositions: [], compositionById: {}, materials: { filters: ['None', 'Sartorius 0.2 µm PES', 'Other 0.2 µm'], dialysis_cassettes: [] }, devices: { instruments: [], mixers: [] }, tff_modules: [], buffers_catalog: [], pka: [], reagents: [] };
  const ref = getRef({ data, store: s });
  assert.ok(ref.devices.some((d) => d.id === 'my-rig'), 'lookups keep it');
  assert.ok(!ref.active.devices.some((d) => d.id === 'my-rig'), 'pickers do not');
  assert.deepEqual(ref.pick('devices', 'my-rig').map((d) => d.id), ['my-rig'], 'except on the record that has it');
  assert.deepEqual(ref.active.filters, ['None', 'Other 0.2 µm']);
  assert.deepEqual(ref.pick('filters', 'Sartorius 0.2 µm PES'), ['None', 'Sartorius 0.2 µm PES', 'Other 0.2 µm']);
  assert.deepEqual(ref.pick('tffModules', 'MY-TFF').map((m) => m.part), ['MY-TFF']);
  assert.deepEqual(ref.active.tffModules, []);
  assert.deepEqual(ref.active.dialysis, []);
  assert.ok(ref.archived.device.has('my-rig'));
});

test('buffer lots carry the measured pH, what is left and the expiry; the overview reads them', () => {
  assert.deepEqual(lotFacts({ targetPH: 4, measuredPH: 4.06, volume_mL: 500, remaining_mL: 120, expiry: '2026-10-01' }, '2026-10-31'),
    { pH: 4.06, pHMeasured: true, volume_mL: 500, remaining_mL: 120, expiry: '2026-10-01', expired: true });
  const f = lotFacts({ targetPH: 7.4, volume_mL: 1000 }, '2026-10-31');
  assert.equal(f.pH, 7.4); assert.equal(f.pHMeasured, false, 'not measured: the target, said so');
  assert.equal(f.remaining_mL, null); assert.equal(f.expiry, null); assert.equal(f.expired, false);
  assert.equal(lotFacts({ measuredPH: '' , targetPH: 5 }).pH, 5, 'an emptied field is no measurement');
});

test('a catalogue code is the lab\'s own, checked, and laid over the shipped one', () => {
  const cat = [{ name: 'Citrate 50 mM, pH 4.0', code: 'CIT50' }, { name: 'PBS', code: 'PBS1X' }];
  assert.deepEqual(checkBufferCode(' cit 50x ', 'Citrate 50 mM, pH 4.0', cat), { code: 'CIT50X' });
  assert.deepEqual(checkBufferCode('', 'PBS', cat), { code: '' }, 'empty: back to the shipped one');
  assert.match(checkBufferCode('PBS1X', 'Citrate 50 mM, pH 4.0', cat).error, /code of PBS/);
  assert.match(checkBufferCode('CIT_50', 'Citrate 50 mM, pH 4.0', cat).error, /Letters and digits/);
  const merged = catalogWithCodes(cat, [{ id: 'Citrate 50 mM, pH 4.0', code: 'LABCIT' }]);
  assert.equal(merged[0].code, 'LABCIT'); assert.equal(merged[0].shippedCode, 'CIT50');
  assert.equal(merged[1], cat[1], 'the others as shipped');
});

test('the provenance symbol opens every detail, in order, empty where the record does not say', () => {
  const d = provenanceDetails({ provenance: { source: 'mcp-import', file: { name: 'campaign.xlsx', sha256: 'ab'.repeat(32) }, sheet: 'Runs', row: 7, importId: 'imp-1', importedAt: '2026-10-30T09:15:00Z', importedBy: 'GH' } });
  assert.deepEqual(d.map((x) => x.key), ['source', 'file', 'sha256', 'sheet', 'row', 'importId', 'importedAt', 'importedBy']);
  assert.deepEqual(d.map((x) => x.value), ['Imported with Claude', 'campaign.xlsx', 'ab'.repeat(32), 'Runs', '7', 'imp-1', '2026-10-30 09:15', 'GH']);
  const manual = provenanceDetails({});
  assert.equal(manual[0].value, 'Typed in');
  assert.ok(manual.slice(1).every((x) => x.value === null));
  assert.equal(provenanceDetails({ raw: { fileName: 'dls.csv', sha256: 'ff' } })[1].value, 'dls.csv', 'an older measurement names its file');
});

test('a pre-migration copy downloads as a backup file and restores over the records, brought up to date again', () => {
  const s = lab();
  s.replace('compositions', [{ id: 500, mol_pct: { DSPC: 100 } }]);
  const copy = backupBeforeMigration(s, 2, SCHEMA_VERSION, new Date('2026-10-01T08:00:00Z'), ['compositions', 'batches']);
  // Changed after the update: a composition edited, one added.
  s.replace('compositions', [{ id: 500, mol_pct: { Chol: 100 } }, { id: 501, mol_pct: { DSPC: 100 } }]);
  const file = preMigrationFile(copy, 'lnp-lab');
  assert.deepEqual(Object.keys(file.collections).sort(), ['batches', 'compositions']);
  assert.equal(file.preMigration.from, 2);
  localStorage.setItem('lnp-lab.schemaVersion', String(SCHEMA_VERSION));
  const r = restorePreMigration(s, copy.id);
  assert.equal(r.ok, true);
  assert.deepEqual(s.all('compositions').map((c) => [c.id, Object.keys(c.mol_pct)[0]]), [[500, 'DSPC']], 'the copy replaces the list');
  assert.equal(s.all('compositions')[0].provenance?.source, 'manual', 'and is migrated again');
  assert.equal(localStorage.getItem('lnp-lab.schemaVersion'), String(SCHEMA_VERSION));
  assert.equal(s.all('preMigration').length, 1, 'no second copy of the same records');
  assert.ok(s.get('rnaLots', 'RNA-1'), 'a list the copy does not hold stays');
  assert.equal(restorePreMigration(s, 'nope').ok, false);
});
