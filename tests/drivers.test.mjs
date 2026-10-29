// What drives each response, in words: the sentence the DoE screen leads with, and the numbers in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sigfig, processDrivers, blendDrivers, driverSentence } from '../app/calc/diagnostics.js';
import { boxTerms } from '../app/calc/balance.js';
import { buildDesign, factorLabel, termLabel, LAB_WORDS } from '../app/calc/doe.js';
import { FACTORS } from '../app/calc/experiment.js';
import { scheffeTerms, fitMixture } from '../app/calc/mixture.js';
import { ols } from '../app/calc/stats.js';

test('a number read on its own is as short as it can be without losing anything', () => {
  assert.equal(sigfig(80), '80', 'a whole number reads as a whole number, not 80.00');
  assert.equal(sigfig(63), '63');
  assert.equal(sigfig(0.064), '0.064', 'a small value keeps its significant digits');
  assert.equal(sigfig(82.549), '82.5');
  assert.equal(sigfig(1234.5), '1,235', 'large values are not rounded into zeros');
  assert.equal(sigfig(0.0912, 3, { maxDp: 3 }), '0.091', 'a PDI stops at the third decimal the instrument gives');
  assert.equal(sigfig(-0.35, 2), '−0.35', 'a true minus sign');
  assert.equal(sigfig(12.4, 2, { sign: true }), '+12', 'a change says which way it goes');
  assert.equal(sigfig(-0.0001, 2, { maxDp: 3, sign: true }), '0', 'what rounds to nothing is 0, not -0 or +0');
  assert.equal(sigfig(null), '–');
  assert.equal(sigfig(''), '–', 'an empty box is not zero');
});

/* A face-centred CCD over three factors with a known truth, in coded units:
   size = 100 - 12 FRR + 3 flow + 0 PEG + 4 FRR·flow + 6 FRR², with a little fixed noise. */
const spec = {
  mode: 'process', designType: 'ccd_faced', model: 'quadratic', centerPoints: 3, replicates: 1, seed: 1,
  factors: [{ name: 'FRR', unit: '', low: 2, center: null, high: 4 }, { name: 'flow_rate', unit: 'mL/min', low: 60, center: null, high: 120 },
    { name: 'PEG_mol_pct', unit: 'mol%', low: 1, center: null, high: 2.5 }],
  responses: [{ name: 'particle_size_nm', goal: 'target', target: 80 }],
};
const runs = buildDesign(spec);
const names = spec.factors.map((f) => f.name);
const terms = boxTerms(names, 'quadratic');
const noise = (i) => 0.25 * Math.sin(1.7 * i + 0.3);
const truth = (c) => 100 - 12 * c.FRR + 3 * c.flow_rate + 4 * c.FRR * c.flow_rate + 6 * c.FRR ** 2;
const fitOn = (f, scale = 1) => ols(runs.map((r) => terms.map((t) => t.f(r.coded))), runs.map((r, i) => f(r.coded) + scale * noise(i)));

test('every process term is told apart by kind, and a main effect becomes its change across the range run', () => {
  const d = processDrivers(fitOn(truth), terms, spec.factors);
  assert.equal(d.kind, 'process');
  assert.deepEqual(d.main.map((e) => e.factor), ['FRR', 'flow_rate', 'PEG_mol_pct'], 'main effects in order of |t|');
  const frr = d.main[0];
  assert.ok(Math.abs(frr.change + 24) < 0.5, `FRR from low to high is twice its coded coefficient, about -24: ${frr.change}`);
  assert.equal(frr.from, 2); assert.equal(frr.to, 4);
  assert.ok(Math.abs(d.main[1].change - 6) < 0.5, 'flow about +6 from 60 to 120');
  assert.equal(d.main[1].unit, 'mL/min');
  assert.ok(!d.main[2].significant, 'PEG does nothing in this truth');
  assert.deepEqual(d.interactions.filter((e) => e.significant).map((e) => e.factors), [['FRR', 'flow_rate']]);
  assert.deepEqual(d.curvature.filter((e) => e.significant).map((e) => e.factor), ['FRR']);
});

test('the sentence names what matters, which way, by how much, and in the units of the bench', () => {
  const s = driverSentence('Size', processDrivers(fitOn(truth), terms, spec.factors), { unit: 'nm' });
  // flow is real but under a third of FRR's change, so it "matters less"; two significant figures for a change
  assert.equal(s, 'Size falls with FRR (−24 nm from 2 to 4); flow_rate matters less (+5.8 nm); no clear effect of PEG_mol_pct; FRR and flow_rate interact; curvature in FRR.');
  // names and free text go through the caller's formatting, so the screen can mark names up and escape units
  const marked = driverSentence('<b>Size</b>', processDrivers(fitOn(truth), terms, spec.factors), { unit: 'nm', term: (n) => `[${n}]`, text: (t) => t.toUpperCase() });
  assert.ok(marked.startsWith('<b>Size</b> falls with [FRR]'), marked);
  assert.ok(marked.includes('NM'), 'the unit goes through text()');
});

test('two strong effects in opposite directions are grouped by direction, the strongest group first', () => {
  const s = driverSentence('PDI', processDrivers(fitOn((c) => 0.1 + 0.03 * c.PEG_mol_pct - 0.025 * c.FRR, 0.001), terms, spec.factors));
  assert.match(s, /^PDI rises with PEG_mol_pct \(\+0\.06 from 1 to 2\.5 mol%\) and falls with FRR \(−0\.05 from 2 to 4\)/);
});

test('an EE change is in percentage points, not per cent', () => {
  const s = driverSentence('EE', processDrivers(fitOn((c) => 90 + 3 * c.FRR), terms, spec.factors), { unit: '%' });
  assert.match(s, /\+6 points from 2 to 4/);
});

test('a change is never quoted finer than the response is measured', () => {
  const d = processDrivers(fitOn((c) => 0.1 + 0.03 * c.PEG_mol_pct + 0.0029 * c.FRR, 0.0001), terms, spec.factors);
  assert.match(driverSentence('PDI', d), /FRR matters less \(\+0\.0058\)/, 'unbounded: two significant figures');
  assert.match(driverSentence('PDI', d, { maxDp: 3 }), /FRR matters less \(\+0\.006\)/, 'a PDI stops at three decimals');
});

test('a response nothing moves says so instead of listing noise', () => {
  const flat = processDrivers(fitOn(() => 50), terms, spec.factors);
  assert.ok(flat.main.every((e) => !e.significant), 'pure noise passes no test');
  assert.match(driverSentence('Zeta', flat, { unit: 'mV' }), /^Zeta: nothing in the ranges run moves it clearly \(no term passes p < 0\.05\)\.$/);
});

test('with no residual degrees of freedom the sentence refuses to rank anything', () => {
  // a saturated design: as many runs as terms, so the fit passes through every point and leaves no error
  const exact = { ...fitOn(truth), n: terms.length, p: terms.length };
  assert.match(driverSentence('Size', processDrivers(exact, terms, spec.factors)), /no residual degrees of freedom/);
});

/* A three-lipid blend where PEG does the work: more PEG, smaller particles. */
const C3 = [{ name: 'ALC315', lipidKey: 'ALC315', lo: 40, hi: 60 }, { name: 'Chol', lipidKey: 'Chol', lo: 35, hi: 55 }, { name: 'DMGPEG', lipidKey: 'DMG0PEG2000', lo: 1, hi: 5 }];
const mix = { mode: 'mixture', model: 'linear', mixtureOrder: 'quadratic', mixtureKind: 'auto', components: C3, factors: [],
  responses: [{ name: 'particle_size_nm', unit: 'nm', goal: 'target', target: 90, min_valid: 20, max_valid: 500 }], centerPoints: 3, seed: 42, total: 100, budget: 14 };

test('a blend is read along its Cox traces, not by testing corner predictions against zero', () => {
  const mruns = buildDesign(mix);
  const mterms = scheffeTerms(C3.map((c) => c.name), 'quadratic');
  const y = mruns.map((r, i) => 140 - 9 * r.real.DMGPEG + 0.25 * (r.real.ALC315 - 50) + 0.2 * Math.sin(i));
  const fit = fitMixture(mruns.map((r) => r.coded), y, mterms);
  const centre = mruns.find((r) => r.point_type === 'center');
  const d = blendDrivers(fit, mterms, C3, { total: 100, reference: C3.map((c) => centre.real[c.name]) });
  assert.equal(d.kind, 'blend');
  assert.equal(d.main[0].factor, 'DMGPEG', 'PEG moves the response most');
  assert.ok(d.main[0].change < 0 && d.main[0].lipid, 'and more of it makes the particles smaller');
  assert.ok(d.main[0].from >= 1 - 1e-9 && d.main[0].to <= 5 + 1e-9, 'within the mol% the region allows');
  assert.ok(d.blending.every((b) => b.factors.length === 2), 'only the pairwise terms are tested');
  const s = driverSentence('Size', d, { unit: 'nm' });
  assert.match(s, /^Size falls with more DMGPEG \(−\d+ nm from [\d.]+ to [\d.]+ mol%\)/);
  assert.ok(!/no clear effect/.test(s), 'an untested trace is never called "no clear effect"');
});

test('a factor is read in the lab\'s words, not its identifier (cycle 6, I2)', () => {
  // the words the bench record, Insights and the optimizer use, for every knob a design can turn
  assert.deepEqual(FACTORS.map((f) => factorLabel(f.doeName)), ['N/P', 'FRR', 'total flow', 'quench factor', 'PEG mol%', 'ionizable mol%', 'lipid stock mM', 'RNA working mg/mL', 'aqueous pH', 'aqueous ionic strength mM', 'mixer']);
  assert.ok(FACTORS.every((f) => LAB_WORDS[f.doeName]), 'a new knob needs its words here too');
  assert.equal(factorLabel({ name: 'temperature', unit: '°C' }), 'temperature', 'a name the user chose is kept');
  assert.equal(factorLabel('buffer_molarity'), 'buffer molarity', 'its underscores read as spaces');
  // model terms: interactions with ×, squares with ², a several-word name in brackets; lipids left alone
  assert.equal(termLabel('FRR x flow_rate', names), 'FRR × total flow');
  assert.equal(termLabel('FRR^2', names), 'FRR²');
  assert.equal(termLabel('PEG_mol_pct^2', names), '(PEG mol%)²');
  assert.equal(termLabel('Intercept', names), 'Intercept');
  assert.equal(termLabel('ALC315·Chol × flow_rate', ['flow_rate']), 'ALC315·Chol × total flow');
  // the sentence the screen and the report lead with, through the same words
  const s = driverSentence('Size', processDrivers(fitOn(truth), terms, spec.factors), { unit: 'nm', term: (n) => (names.includes(n) ? factorLabel(n) : n) });
  assert.equal(s, 'Size falls with FRR (−24 nm from 2 to 4); total flow matters less (+5.8 nm); no clear effect of PEG mol%; FRR and total flow interact; curvature in FRR.');
});
