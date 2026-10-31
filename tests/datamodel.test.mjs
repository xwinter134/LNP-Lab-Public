// Phase 2, the data model (spec 4): process variables with roles, provenance, and the migration to schema 3.
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage ??= { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
const { VARIABLES, VARIABLE_BY_KEY, readVariable, checkVariable, ionizableLipids, isPegFree, roleOf, runsNeeded } = await import('../app/calc/variables.js');
const { provenance, provenanceOf, provenanceLine } = await import('../app/calc/provenance.js');
const { addProvenanceAndProcess, backupBeforeMigration, migrate, SCHEMA_VERSION } = await import('../app/migrate.js');

const lipidByKey = { 'ALC-0315': { class: 'ionizable' }, 'SM-102': { class: 'ionizable' }, DSPC: { class: 'helper' }, Chol: { class: 'sterol' }, 'DMG-PEG2000': { class: 'peg' } };
const comp = { id: 1, mol_pct: { 'ALC-0315': 50, DSPC: 10, Chol: 38.5, 'DMG-PEG2000': 1.5 } };

test('every variable of spec 4.1 is there, with a role, and mixer and lipid filter by default', () => {
  for (const k of ['bufferSystem', 'loadingPH', 'bufferMolarity_mM', 'ethanolPct', 'mixTemp_C', 'mixerType', 'mixer', 'postMethod', 'targetBuffer', 'targetPH', 'finalRna_mg_mL', 'cryoprotectant', 'cryo_pct', 'sterileFiltered', 'ionizableLipid', 'pegFree', 'rnaType'])
    assert.ok(VARIABLE_BY_KEY[k], `missing ${k}`);
  assert.ok(VARIABLES.every((v) => ['factor', 'context'].includes(v.role)));
  assert.deepEqual(VARIABLES.filter((v) => v.role === 'factor').map((v) => v.key), ['loadingPH', 'bufferMolarity_mM']);
  assert.ok(VARIABLE_BY_KEY.mixerType.filter && VARIABLE_BY_KEY.ionizableLipid.filter);
  assert.ok(VARIABLE_BY_KEY.mixer.from === 'process', 'the mixer is the process designer\'s, not typed again');
  assert.equal(roleOf('mixTemp_C', { roles: { mixTemp_C: 'factor' } }), 'factor', 'a campaign can free a context variable');
  assert.match(runsNeeded(3, 12).sentence, /about 15 runs .* 12 are on file/);
});

test('the ionizable lipid and PEG-free are read from the composition, a list when there are two', () => {
  assert.deepEqual(ionizableLipids(comp, lipidByKey), ['ALC-0315']);
  assert.deepEqual(ionizableLipids({ mol_pct: { 'SM-102': 20, 'ALC-0315': 30, DSPC: 10 } }, lipidByKey), ['ALC-0315', 'SM-102']);
  assert.equal(isPegFree(comp, lipidByKey), false);
  assert.equal(isPegFree({ mol_pct: { 'ALC-0315': 50, DSPC: 10, Chol: 40, 'DMG-PEG2000': 0 } }, lipidByKey), true);
  const ref = { compositionById: { 1: comp }, lipidByKey };
  assert.deepEqual(readVariable({ compositionId: 1 }, 'ionizableLipid', ref), ['ALC-0315']);
  assert.equal(readVariable({ compositionId: 99 }, 'pegFree', ref), null, 'unknown composition: unknown, not guessed');
  assert.equal(readVariable({ plan: { conditions: { loadingPH: 4 } } }, 'loadingPH'), 4);
  assert.equal(readVariable({ plan: {} }, 'loadingPH'), null);
});

test('values are checked the same way everywhere: numbers in range, categories from the list', () => {
  assert.deepEqual(checkVariable('loadingPH', 4.0), []);
  assert.match(checkVariable('loadingPH', 15)[0], /above 14/);
  assert.match(checkVariable('ethanolPct', 'lots')[0], /not a number/);
  assert.match(checkVariable('mixerType', 'Blender')[0], /not one of/);
  assert.deepEqual(checkVariable('mixer', 'NanoAssemblr Ignite NxGen'), [], 'a chip of the lab\'s own is accepted');
  assert.match(checkVariable('pegFree', true)[0], /worked out from the composition/);
  assert.match(checkVariable('nonsense', 1)[0], /unknown variable/);
});

test('provenance: what a record says, or what it is read as', () => {
  assert.deepEqual(provenance('mcp-import', { importId: 'imp-1', sheet: '', row: 4 }), { source: 'mcp-import', importId: 'imp-1', row: 4 });
  assert.throws(() => provenance('guess'));
  assert.equal(provenanceOf({}).source, 'manual');
  assert.equal(provenanceOf({ raw: { fileName: 'z.csv', sha256: 'abcdef0123' } }).source, 'instrument-import');
  assert.match(provenanceLine({ provenance: { source: 'mcp-import', file: { name: 'old.xlsx', sha256: '0123456789' }, sheet: 'DLS', row: 12 } }), /Imported with Claude · old\.xlsx \(SHA-256 01234567…\) · sheet DLS, row 12/);
});

function memStore(cols) {
  const c = structuredClone(cols);
  return { ns: 'mig', all: (k) => structuredClone(c[k] || []), replace: (k, rows) => { c[k] = structuredClone(rows); }, put: (k, r) => { c[k] ||= []; c[k].push({ ...r, updatedAt: 'now' }); },
    get: (k, id) => (c[k] || []).find((r) => r.id === id) || null, remove: (k, id) => { c[k] = (c[k] || []).filter((r) => r.id !== id); },
    exportAll: () => ({ collections: structuredClone(c) }), transaction: (fn, o) => { const r = fn(); o?.onSaved?.(); return r; }, raw: c };
}
const OLD = {
  experiments: [{ id: 'E1', batchIds: ['E1-F1'] }],
  batches: [{ id: 'E1-F1', experimentId: 'E1', compositionId: 1, plan: { rna: { np: 6 }, mixing: { frr: 3 } }, updatedAt: '2026-10-01T00:00:00Z' }],
  measurements: [{ id: 'm1', batchId: 'E1-F1', raw: { fileName: 'dls.csv', sha256: 'ff00' }, updatedAt: '2026-10-02T00:00:00Z' }, { id: 'm2', batchId: 'E1-F1', raw: null }],
  compositions: [{ id: 500, mol_pct: { DSPC: 100 } }],
};

test('migration to schema 3: provenance and an empty plan.conditions, nothing guessed, nothing re-stamped, idempotent', () => {
  const s = memStore(OLD);
  const n = addProvenanceAndProcess(s);
  assert.deepEqual(n, { batches: 1, measurements: 2, compositions: 1 });
  const b = s.all('batches')[0];
  assert.deepEqual(b.provenance, { source: 'manual' });
  assert.deepEqual(b.plan.conditions, {}, 'the new variables start empty');
  assert.equal(b.updatedAt, '2026-10-01T00:00:00Z', 'a migration is not an edit');
  assert.deepEqual(b.plan.mixing, { frr: 3 });
  assert.equal(s.all('measurements')[0].provenance.source, 'instrument-import');
  assert.equal(s.all('measurements')[0].provenance.file.name, 'dls.csv');
  assert.equal(s.all('measurements')[1].provenance.source, 'manual');
  const once = JSON.stringify(s.raw);
  assert.deepEqual(addProvenanceAndProcess(s), { batches: 0, measurements: 0, compositions: 0 });
  assert.equal(JSON.stringify(s.raw), once, 'a second run changes nothing');
});

test('the migration keeps a copy of every record first, and records the version only once stored', () => {
  const s = memStore(OLD);
  mem.delete('mig.schemaVersion');
  migrate(s);
  const pre = s.all('preMigration');
  assert.equal(pre.length, 1);
  assert.deepEqual(pre[0].data.batches, OLD.batches, 'the copy is of the records as they were');
  assert.equal(mem.get('mig.schemaVersion'), String(SCHEMA_VERSION));
  for (let i = 0; i < 3; i++) backupBeforeMigration(s, 2, 3, new Date(2026, 0, i + 1));
  assert.equal(s.all('preMigration').length, 2, 'only the two newest copies are kept');
});
