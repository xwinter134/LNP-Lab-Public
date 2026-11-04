// Delete or archive (spec 9.5): one helper says where a component is used; used ones are archived, not deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { whereUsed, usageSentence, archive, unarchive, isArchived, selectable } from '../app/calc/usage.js';

function memStore(cols) {
  const c = structuredClone(cols);
  return {
    all: (k) => c[k] || [], get: (k, id) => (c[k] || []).find((r) => r.id === id) || null,
    put: (k, r) => { c[k] ||= []; const i = c[k].findIndex((x) => x.id === r.id); if (i >= 0) c[k][i] = r; else c[k].push(r); },
    remove: (k, id) => { c[k] = (c[k] || []).filter((r) => r.id !== id); },
  };
}
const store = () => memStore({
  compositions: [{ id: 101, mol_pct: { 'ALC-0315': 50, DSPC: 10, Chol: 38.5, 'DMG-PEG2000': 1.5 } }],
  stocks: [{ id: 'Stock-001', compositionId: 101, lots: { DSPC: 'lot-a' } }],
  batches: [{ id: 'E1-F1', compositionId: 101, plan: { rna: { lotId: 'RNA-1', diluent: 'Buffer-002' }, downstream: { dialysis: { buffer: 'PBS1X-pH7.4-20261031' } } } }],
  experiments: [{ id: 'E1', compositionId: 101, rnaLotId: 'RNA-1' }],
  lipidLots: [{ id: 'lot-a', lipidKey: 'DSPC', lot: 'A1' }, { id: 'lot-b', lipidKey: 'DSPC', lot: 'B1' }],
  buffers: [{ id: 'Buffer-002', lot: 'Buffer-002' }, { id: 'Buffer-003', lot: 'PBS1X-pH7.4-20261031' }, { id: 'Buffer-004', lot: 'CIT50-pH4.0-20261031' }],
  rnaLots: [{ id: 'RNA-1' }, { id: 'RNA-2' }],
});

test('every kind of component is found where it is used, and not where it is not', () => {
  const s = store();
  assert.deepEqual(whereUsed(s, 'lipid', 'ALC-0315').map((u) => u.id), [101]);
  assert.ok(whereUsed(s, 'lipid', 'DSPC').some((u) => u.collection === 'lipidLots'), 'a lipid with lots is in use');
  assert.equal(whereUsed(s, 'lipid', 'SM-102').length, 0);
  assert.deepEqual(whereUsed(s, 'lipidLot', 'lot-a').map((u) => u.id), ['Stock-001']);
  assert.equal(whereUsed(s, 'lipidLot', 'lot-b').length, 0);
  assert.deepEqual(whereUsed(s, 'composition', 101).map((u) => u.collection).sort(), ['batches', 'experiments', 'stocks']);
  assert.equal(whereUsed(s, 'rnaLot', 'RNA-2').length, 0);
  assert.equal(whereUsed(s, 'rnaLot', 'RNA-1').length, 2);
  assert.equal(whereUsed(s, 'buffer', 'Buffer-002').length, 1, 'an old lot by its number');
  assert.equal(whereUsed(s, 'buffer', 'Buffer-003').length, 1, 'a new lot by its name');
  assert.equal(whereUsed(s, 'buffer', 'Buffer-004').length, 0);
});

test('the dialog says where it is used and offers archiving; unused ones may be deleted', () => {
  const s = store();
  assert.match(usageSentence('composition', '#101', whereUsed(s, 'composition', 101)), /cannot be deleted[\s\S]*Archive the composition/);
  assert.match(usageSentence('rnaLot', 'RNA-2', []), /not used anywhere\. Delete it\?/);
});

test('archived components leave the pickers but stay readable, and the chosen one is kept', () => {
  const s = store();
  archive(s, 'rnaLot', 'RNA-1');
  assert.ok(isArchived(s, 'rnaLot', 'RNA-1'));
  assert.deepEqual(selectable(s, 'rnaLot', s.all('rnaLots')).map((r) => r.id), ['RNA-2']);
  assert.deepEqual(selectable(s, 'rnaLot', s.all('rnaLots'), (r) => r.id, ['RNA-1']).map((r) => r.id), ['RNA-1', 'RNA-2'], 'the value already chosen stays');
  assert.ok(s.get('rnaLots', 'RNA-1'), 'the record itself is untouched');
  unarchive(s, 'rnaLot', 'RNA-1');
  assert.ok(!isArchived(s, 'rnaLot', 'RNA-1'));
});
