// The results grid (spec 9.3): what a typed cell says, where a pasted block goes, what a row stores, and what
// undoing a save puts back. The screen only draws and stores what these return.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCell, parseClipboard, distributePaste, rowResults, cellState, cellSummary, cellTextOf, columnsForTests, undoGridSave, GRID_COLUMNS, cellNumber } from '../app/calc/gridentry.js';
import { DEFAULT_SETTINGS } from '../app/refdata.js';

const qc = DEFAULT_SETTINGS.qc;

test('a cell holds one value or up to three replicates, with decimal commas', () => {
  assert.deepEqual(parseCell('82').values, [82]);
  const c = parseCell('82; 85; 80');
  assert.deepEqual(c.values, [82, 85, 80]);
  assert.equal(c.n, 3);
  assert.ok(Math.abs(c.mean - 82.3333) < 1e-3);
  assert.ok(Math.abs(c.sd - 2.5166) < 1e-3);
  assert.deepEqual(parseCell('82,4; 85,1').values, [82.4, 85.1], 'a comma inside a number is a decimal comma');
  assert.deepEqual(parseCell('82,4 85,1 80,9').values, [82.4, 85.1, 80.9], 'spaces separate too');
  assert.deepEqual(parseCell('82, 85, 80').values, [82, 85, 80], 'a comma and a space separate');
  assert.deepEqual(parseCell('0.12/0.13').values, [0.12, 0.13]);
  assert.deepEqual(parseCell(' 82 nm ').values, [82], 'a unit is noise');
  assert.deepEqual(parseCell('−12,5').values, [-12.5], 'the typographic minus');
  assert.equal(parseCell('').n, 0);
  assert.equal(parseCell('   ').error, null, 'an empty cell is no error');
});

test('a cell that is not numbers, or holds too many, says why', () => {
  assert.match(parseCell('82,85,80').error, /separate replicates with ";"/, 'three numbers run together are not guessed at');
  assert.match(parseCell('abc').error, /"abc" is not a number/);
  assert.match(parseCell('1; 2; 3; 4').error, /up to 3 values/);
  assert.match(parseCell('5; 6', { max: 1 }).error, /up to 1 values/);
  assert.ok(Number.isNaN(cellNumber('1.2.3')));
});

test('a block from Excel is rows of tab-separated cells; one value is not a block', () => {
  assert.equal(parseClipboard('82.4'), null);
  assert.deepEqual(parseClipboard('82\t0.1\r\n85\t0.2\r\n'), [['82', '0.1'], ['85', '0.2']]);
  assert.deepEqual(parseClipboard('82\n85\n\n'), [['82'], ['85']], 'trailing empty lines are dropped');
  assert.deepEqual(parseClipboard('82\t0.1'), [['82', '0.1']], 'one line with a tab is a block');
  assert.deepEqual(parseClipboard('"82; 85\n80"\t0,1\n83\t'), [['82; 85\n80', '0,1'], ['83', '']], 'a quoted cell keeps its line break');
  assert.deepEqual(parseClipboard('"say ""hi"""\tx'), [['say "hi"', 'x']]);
});

test('a pasted block fills from the focused cell, down and to the right, and counts what had nowhere to go', () => {
  const block = [['1', '2'], ['3', '4'], ['5', '6']];
  const r = distributePaste(block, { row: 1, col: 1 }, { rows: 3, cols: 3 });
  assert.deepEqual(r.puts, [{ row: 1, col: 1, text: '1' }, { row: 1, col: 2, text: '2' }, { row: 2, col: 1, text: '3' }, { row: 2, col: 2, text: '4' }]);
  assert.equal(r.lost, 2, 'the third line was past the last row');
  const held = distributePaste([['1'], ['2']], { row: 0, col: 0 }, { rows: 2, cols: 1 }, (row) => row !== 1);
  assert.deepEqual(held.puts, [{ row: 0, col: 0, text: '1' }]);
  assert.equal(held.lost, 1, 'a cell that cannot take a value loses it, and says so');
  assert.equal(distributePaste([['', '']], { row: 5, col: 5 }, { rows: 1, cols: 1 }).lost, 0, 'empty cells are not lost values');
});

test('DLS replicates are stored the way an imported DLS result stores them', () => {
  const r = rowResults({ zave: '82; 85; 80', pdi: '0.10; 0.12; 0.11' }, qc).dls;
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.values.runs, [{ zave_nm: 82, pdi: 0.1 }, { zave_nm: 85, pdi: 0.12 }, { zave_nm: 80, pdi: 0.11 }]);
  assert.ok(Math.abs(r.values.zave_nm - 82.3333) < 1e-3);
  assert.ok(Math.abs(r.values.pdi - 0.11) < 1e-9);
  assert.ok(Math.abs(r.values.zave_sd - 2.5166) < 1e-3);
  // A PDI typed once beside three sizes belongs to the result, not to a run.
  const one = rowResults({ zave: '82; 85; 80', pdi: '0,11' }, qc).dls;
  assert.deepEqual(one.values.runs, [{ zave_nm: 82 }, { zave_nm: 85 }, { zave_nm: 80 }]);
  assert.equal(one.values.pdi, 0.11);
  // Two sizes beside three PDIs cannot be paired.
  const odd = rowResults({ zave: '82; 85', pdi: '0.1; 0.2; 0.3' }, qc).dls;
  assert.equal(odd.values, null);
  assert.match(odd.errors[0].text, /2 values beside 3/);
  // One value each is the single result the grid always stored, with no runs.
  assert.deepEqual(rowResults({ zave: '90', pdi: '0.15' }, qc).dls.values, { zave_nm: 90, pdi: 0.15 });
});

test('each test on a row is its own result; EE and RNA keep their replicates and spread', () => {
  const r = rowResults({ zave: '90', ee: '91; 93', rna: '0.1', zeta: '-3; -5' }, qc);
  assert.deepEqual(Object.keys(r).sort(), ['content', 'dls', 'ee', 'zeta']);
  assert.equal(r.ee.values.ee_pct, 92);
  assert.ok(Math.abs(r.ee.values.ee_sd - Math.SQRT2) < 1e-9);
  assert.deepEqual(r.ee.values.runs, [{ ee_pct: 91 }, { ee_pct: 93 }]);
  assert.equal(r.zeta.values.zeta_mV, -4);
  assert.ok(r.zeta.values.sd_mV > 0);
  assert.deepEqual(rowResults({}, qc), {}, 'an empty row stores nothing');
});

test('impossible values refuse their result and are marked on their own cell; unlikely ones only warn', () => {
  const pdi = rowResults({ zave: '82', pdi: '1.4' }, qc);
  assert.equal(pdi.dls.values, null, 'a PDI above 1 is refused, as the form and the importer refuse it');
  assert.equal(cellState(pdi, 'pdi').state, 'bad');
  assert.equal(cellState(pdi, 'zave').state, '', 'the Z-ave beside it is not marked');
  const ee = rowResults({ ee: '105' }, qc);
  assert.equal(cellState(ee, 'ee').state, 'bad');
  assert.match(cellState(ee, 'ee').reasons[0], /outside 0–100/);
  // A run that is impossible refuses the result too.
  assert.equal(rowResults({ zave: '82; 85', pdi: '0.1; 1.2' }, qc).dls.values, null);
  // Below 10 nm is not an LNP, but not impossible either: stored, in the warning colour.
  const tiny = rowResults({ zave: '8' }, qc);
  assert.ok(tiny.dls.values, 'stored');
  assert.equal(cellState(tiny, 'zave').state, 'warn');
  assert.ok(cellState(tiny, 'zave').reasons.some((t) => /below 10 nm/.test(t)));
  // The QC limits of Settings warn on the column they are about.
  const wide = rowResults({ zave: '90', pdi: '0.35' }, qc);
  assert.equal(cellState(wide, 'pdi').state, 'warn');
  assert.equal(cellState(wide, 'zave').state, '');
  assert.equal(cellState(rowResults({ ee: '70' }, qc), 'ee').state, 'warn');
  assert.equal(cellState(rowResults({ ee: '0.9' }, qc), 'ee').state, 'warn', 'an EE that looks like a fraction');
  // A limit switched off (null) warns about nothing.
  assert.equal(cellState(rowResults({ pdi: '0.35' }, { ...qc, pdiMax: null }), 'pdi').state, '');
  // Not a number refuses with the text.
  assert.match(cellState(rowResults({ zave: 'x' }, qc), 'zave').reasons[0], /"x" is not a number/);
});

test('the summary under a cell, a stored result as cell text, and the columns a test asks for', () => {
  assert.equal(cellSummary(parseCell('82; 85; 80')), '82.3 ± 2.5 (n = 3)');
  assert.equal(cellSummary(parseCell('82')), '');
  assert.equal(cellTextOf({ zave_nm: 82.333, runs: [{ zave_nm: 82 }, { zave_nm: 85 }, { zave_nm: 80 }] }, 'zave'), '82; 85; 80');
  assert.equal(cellTextOf({ zave_nm: 82.4, pdi: 0.123 }, 'pdi'), '0.123');
  assert.equal(cellTextOf({}, 'ee'), '');
  assert.deepEqual(columnsForTests(['dls', 'ee']), ['zave', 'pdi', 'ee']);
  assert.deepEqual(columnsForTests(['potency']), ['zave', 'pdi', 'ee'], 'nothing the grid takes: the usual three');
  assert.equal(new Set(GRID_COLUMNS.map((c) => c.id)).size, GRID_COLUMNS.length);
});

test('undoing a save takes its results out, reopens their slots and puts the status back', () => {
  const now = {
    measurements: [{ id: 'm1', batchId: 'E1-F1' }, { id: 'm2', batchId: 'E1-F2' }, { id: 'old', batchId: 'E1-F2' }],
    experiments: [{ id: 'E1', expected: [{ id: 's1', status: 'done', measurementId: 'm1' }, { id: 's2', status: 'done', measurementId: 'm2' }, { id: 's3', status: 'done', measurementId: 'other' }] }],
    batches: [{ id: 'E1-F1', status: 'measured' }, { id: 'E1-F2', status: 'measured' }],
  };
  const receipt = { measurementIds: ['m1', 'm2', 'gone-already'], slots: [{ experimentId: 'E1', slotId: 's1' }, { experimentId: 'E1', slotId: 's2' }, { experimentId: 'E1', slotId: 's3' }], batches: [{ id: 'E1-F1', status: 'produced' }, { id: 'E1-F2', status: 'planned' }] };
  const u = undoGridSave(receipt, now);
  assert.deepEqual(u.removeMeasurements, ['m1', 'm2']);
  const slots = u.experiments[0].expected;
  assert.deepEqual(slots.map((s) => s.status), ['open', 'open', 'done'], 'a slot closed by something else since stays closed');
  assert.equal(slots[0].measurementId, null);
  assert.deepEqual(u.batches, [{ id: 'E1-F1', status: 'produced' }], 'E1-F2 still has an older result, so it stays measured');
  assert.equal(now.experiments[0].expected[0].status, 'done', 'what is stored now is not changed in place');
});
