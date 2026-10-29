// The recipe a batch is made from (usability cycle 3, C2). The point of these checks is the bench: every
// record a lipid factor produces must total 100 mol%, say which lipid took up the difference, and agree with
// the run table and the weigh-in, including for batches saved before the rebalancing existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { overriddenComposition, absorbedPhrase, balanceColumn } from '../app/calc/composition.js';
import { overriddenComposition as fromScreen } from '../app/ui/formulation.js';
import { buildExperiment } from '../app/calc/experiment.js';
import { buildDesign } from '../app/calc/doe.js';
import { designTableModel } from '../app/calc/designtable.js';
import { DEFAULT_SETTINGS } from '../app/refdata.js';

const lipids = JSON.parse(readFileSync(new URL('../app/data/lipids.json', import.meta.url)));
const compositions = JSON.parse(readFileSync(new URL('../app/data/compositions.json', import.meta.url)));
const MC3 = compositions.find((c) => c.id === 1);   // MC3 50 / DSPC 10 / Chol 38.5 / DMG-PEG2000 1.5
const TWO_STEROLS = { id: 2, mol_pct: { MC3: 50, DSPC: 10, Chol: 30, Sitosterol: 8.5, DMG0PEG2000: 1.5 }, sum: 100 };
const NO_STEROL = { id: 3, mol_pct: { MC3: 60, DOPE: 38.5, DMG0PEG2000: 1.5 }, sum: 100 };
const ref = { lipidByKey: Object.fromEntries(lipids.map((l) => [l.key, l])), compositionById: { 1: MC3, 2: TWO_STEROLS, 3: NO_STEROL } };
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

test('a PEG override takes the difference from cholesterol and says so', () => {
  const c = overriddenComposition(MC3, { peg_pct: 1.75 }, ref);
  assert.ok(near(sum(c.mol_pct), 100), `the recipe totals ${sum(c.mol_pct)}`);
  assert.equal(c.sum, 100);
  assert.equal(c.mol_pct.DMG0PEG2000, 1.75);
  assert.equal(c.mol_pct.Chol, 38.25);
  assert.equal(c.mol_pct.MC3, 50, 'only the sterol moves');
  assert.deepEqual(c.balancedBy.keys, ['Chol']);
  assert.deepEqual(c.balancedBy.changed, ['peg']);
  assert.equal(absorbedPhrase(c.balancedBy), 'absorbs the PEG change');
});

test('an ionizable override, and both at once, balance the same way', () => {
  const ion = overriddenComposition(MC3, { ionizable_pct: 40 }, ref);
  assert.equal(ion.mol_pct.Chol, 48.5);
  assert.equal(ion.sum, 100);
  const both = overriddenComposition(MC3, { ionizable_pct: 55, peg_pct: 2.5 }, ref);
  assert.equal(both.mol_pct.Chol, 32.5);
  assert.equal(both.sum, 100);
  assert.equal(absorbedPhrase(both.balancedBy), 'absorbs the ionizable lipid and PEG changes');
});

test('two sterols share the change in the proportions they already had', () => {
  const c = overriddenComposition(TWO_STEROLS, { peg_pct: 2.5 }, ref);
  assert.ok(near(sum(c.mol_pct), 100, 1e-3), `the recipe totals ${sum(c.mol_pct)}`);
  assert.ok(near(c.mol_pct.Chol / c.mol_pct.Sitosterol, 30 / 8.5, 1e-3), 'the ratio between the sterols is kept');
  assert.ok(near(c.mol_pct.Chol + c.mol_pct.Sitosterol, 37.5, 1e-3));
  assert.deepEqual(c.balancedBy.keys.sort(), ['Chol', 'Sitosterol']);
});

test('without a sterol nothing is rebalanced, and the total is left for the record to warn about', () => {
  const c = overriddenComposition(NO_STEROL, { peg_pct: 1.75 }, ref);
  assert.equal(c.sum, 100.25);
  assert.equal(c.balancedBy, undefined);
});

test('an override that sets the sterol itself is taken as it is', () => {
  // The optimizer writes every class, already balanced; nothing may move under it.
  const ml = { ionizable: 47.5, helper: 10, peg: 1.8, sterol: 40.7, other: 0 };
  const c = overriddenComposition(MC3, ml, ref);
  assert.deepEqual(c.mol_pct, { MC3: 47.5, DSPC: 10, Chol: 40.7, DMG0PEG2000: 1.8 });
  assert.equal(c.balancedBy, undefined);
});

test('a change the sterol cannot absorb is flagged, not applied', () => {
  const c = overriddenComposition(MC3, { ionizable_pct: 95 }, ref);
  assert.ok(c.balancedBy.impossible);
  assert.equal(c.balancedBy.wouldBe, -6.5);
  assert.equal(c.mol_pct.Chol, 38.5, 'the sterol is not driven negative');
  assert.equal(c.sum, 145);
});

test('nothing to apply returns the registry entry itself; a blend is taken as the design set it', () => {
  assert.equal(overriddenComposition(MC3, null, ref), MC3);
  assert.equal(overriddenComposition(MC3, {}, ref), MC3);
  const blend = overriddenComposition(MC3, { mol_pct: { ALC315: 46, Chol: 41.5, DSPC: 10, DMG0PEG2000: 2.5 } }, ref);
  assert.ok(blend.fromMixtureDesign);
  assert.equal(blend.balancedBy, undefined);
  assert.equal(blend.sum, 100);
});

test('the formulation screen still exports the same function under its old name', () => {
  assert.equal(fromScreen, overriddenComposition);
});

/* ---------------- from the design to the bench ---------------- */

const ccdOnPeg = () => ({
  type: 'doe', name: 'PEG and flow', startDate: '2026-10-27', compositionId: 1, tests: ['dls'],
  doe: { designType: 'ccd_faced', model: 'quadratic', centerPoints: 3, replicates: 1, seed: 42,
    factors: [{ name: 'PEG_mol_pct', unit: 'mol%', low: 1, high: 2.5, applyTo: 'peg_pct' }, { name: 'flow_rate', unit: 'mL/min', low: 60, high: 120, applyTo: 'tfr' }],
    responses: [{ name: 'particle_size_nm', unit: 'nm', goal: 'target', target: 90 }] },
});

test('every batch of a CCD on PEG mol% totals 100, with cholesterol taking up the difference', () => {
  const { batches } = buildExperiment(ccdOnPeg(), { settings: DEFAULT_SETTINGS, takenFormulations: [], experimentId: 'E7' });
  assert.equal(batches.length, 11);
  const pegs = new Set();
  for (const b of batches) {
    const c = overriddenComposition(MC3, b.plan.compositionOverride, ref);
    pegs.add(c.mol_pct.DMG0PEG2000);
    assert.ok(near(sum(c.mol_pct), 100, 1e-3), `${b.id} totals ${sum(c.mol_pct)}`);
    assert.ok(near(c.mol_pct.Chol + c.mol_pct.DMG0PEG2000, 40, 1e-3), `${b.id}: cholesterol and PEG share the 40 mol% the registry gives them`);
  }
  assert.deepEqual([...pegs].sort(), [1, 1.75, 2.5], 'the design really did vary the PEG');
});

test('a batch saved before the rebalancing reads back balanced: it is computed, not stored', () => {
  // Exactly what an earlier version wrote onto the plan of a PEG run, and nothing else.
  const saved = { compositionId: 1, plan: { compositionOverride: { peg_pct: 2.5 }, factors: { PEG_mol_pct: 2.5 } } };
  const c = overriddenComposition(MC3, saved.plan.compositionOverride, ref);
  assert.equal(c.sum, 100);
  assert.equal(c.mol_pct.Chol, 37.5);
  assert.deepEqual(saved.plan.compositionOverride, { peg_pct: 2.5 }, 'and reading it changed nothing on the record');
});

test('the run table shows the cholesterol each run is weighed out with', () => {
  const spec = ccdOnPeg().doe;
  const runs = buildDesign(spec);
  const bal = balanceColumn(spec, runs, 1, ref);
  assert.equal(bal.label, 'Cholesterol');
  for (const r of runs) assert.ok(near(bal.values[r.run_id] + r.real.PEG_mol_pct, 40, 1e-6), `${r.run_id}: Chol ${bal.values[r.run_id]} with PEG ${r.real.PEG_mol_pct}`);
  assert.match(bal.note, /Cholesterol absorbs the PEG change/);
  const dt = designTableModel(spec, runs, { balance: bal });
  const col = dt.columns.findIndex((c) => c.key === 'balance');
  assert.ok(col > 0, 'the table has the column');
  assert.equal(dt.columns[col].label, 'Cholesterol');
  const peg = dt.columns.findIndex((c) => c.key === 'PEG_mol_pct');
  for (const row of dt.rows) assert.ok(near(Number(row[col]) + Number(row[peg]), 40, 1e-6), `row ${row[0]}: ${row[col]} + ${row[peg]}`);
  // a design that sets no lipid has no such column
  const process = { ...spec, factors: [{ name: 'FRR', low: 2, high: 4, applyTo: 'frr' }, { name: 'flow_rate', low: 60, high: 120, applyTo: 'tfr' }] };
  assert.equal(balanceColumn(process, buildDesign(process), 1, ref), null);
  assert.equal(designTableModel(process, buildDesign(process)).columns.some((c) => c.key === 'balance'), false);
});
