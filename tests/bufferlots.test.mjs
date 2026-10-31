// Buffer roles and lot names (spec 9.2): the new words, the code-pH-date lot name, and old lots still found.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseRoles, roleLabel, bufferCode, bufferLotName, bufferAnswersTo, BUFFER_ROLES } from '../app/calc/buffer.js';
import catalog from '../app/data/buffers_catalog.json' with { type: 'json' };

test('the old "formulation" role reads as Final / Storage, once, in the usual order', () => {
  assert.deepEqual(normaliseRoles(['formulation', 'loading', 'final']), ['loading', 'final']);
  assert.equal(roleLabel('formulation'), 'Final / Storage');
  assert.equal(roleLabel('dialysis'), 'Dialysis / TFF');
  assert.deepEqual(normaliseRoles(undefined), []);
  assert.deepEqual(BUFFER_ROLES.map((r) => r.id), ['loading', 'quench', 'dialysis', 'final']);
  assert.ok(catalog.every((b) => !b.roles.includes('formulation')), 'the catalog uses the new word');
});

test('a lot code says the buffer system, its strength and the cryoprotectant', () => {
  assert.equal(bufferCode({ system: 'Citric acid', conc_mM: 50 }), 'CIT50');
  assert.equal(bufferCode({ system: 'Acetic acid', conc_mM: 25 }), 'ACE25');
  assert.equal(bufferCode({ system: 'Phosphoric acid', conc_mM: 10, nacl_mM: 137 }), 'PBS1X');
  assert.equal(bufferCode({ system: 'Tris(hydroxymethyl)- aminomethane (tris)', conc_mM: 20, sucrose_mM: 292 }), 'TRIS20-SUC10');
  assert.ok(catalog.every((b) => typeof b.code === 'string' && b.code.length > 1), 'every catalog entry has a code');
});

test('lot names are code-pH-date, numbered on when the same buffer is made twice in a day', () => {
  const lot = { code: 'CIT50', targetPH: 4, date: '2026-10-31' };
  assert.equal(bufferLotName(lot, []), 'CIT50-pH4.0-20261031');
  assert.equal(bufferLotName(lot, ['CIT50-pH4.0-20261031']), 'CIT50-pH4.0-20261031-2');
  assert.equal(bufferLotName(lot, ['CIT50-pH4.0-20261031', 'CIT50-pH4.0-20261031-2']), 'CIT50-pH4.0-20261031-3');
  assert.equal(bufferLotName({ code: 'cit 50', targetPH: 4.04, date: '2026-10-31' }), 'CIT50-pH4.0-20261031');
});

test('a lot answers to its new name and to the Buffer number older records carry', () => {
  const b = { id: 'Buffer-014', lot: 'CIT50-pH4.0-20261031' };
  assert.ok(bufferAnswersTo(b, 'Buffer-014'));
  assert.ok(bufferAnswersTo(b, 'CIT50-pH4.0-20261031'));
  assert.ok(!bufferAnswersTo(b, 'Buffer-015'));
  assert.ok(bufferAnswersTo({ id: 'Buffer-003', lot: 'Buffer-003' }, 'Buffer-003'), 'an old lot keeps its old name');
});
