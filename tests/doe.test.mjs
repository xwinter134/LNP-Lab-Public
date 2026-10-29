// The JS design port must reproduce the Python pipeline's design.csv files for the two example experiments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { buildDesign, randomizeRuns, designSummary, parsePandasCSV, plackettBurman, validateSpec, wellNames } from '../app/calc/doe.js';

// The design.csv files the Python DoE pipeline wrote for two example experiments, kept here as fixtures.
const root = new URL('./fixtures/pipeline/', import.meta.url).pathname;
const ccdSpec = { designType: 'ccd_faced', model: 'quadratic', centerPoints: 4, replicates: 1, seed: 42, plateFormat: 96,
  factors: [{ name: 'flow_rate', unit: 'mL/min', low: 1, center: 2, high: 3 }, { name: 'FRR', unit: 'v/v', low: 1, center: 3, high: 5 }, { name: 'temperature', unit: 'degC', low: 4, center: 21, high: 37 }],
  responses: [{ name: 'particle_size_nm', goal: 'target', target: 90 }, { name: 'PDI', goal: 'minimize' }, { name: 'encapsulation_efficiency', goal: 'maximize' }] };
const bbdSpec = { designType: 'bbd', model: 'quadratic', centerPoints: 3, replicates: 1, seed: 7, plateFormat: 96,
  factors: [{ name: 'pH', low: 4, center: 5.5, high: 7 }, { name: 'ionic_strength', low: 10, center: 55, high: 100 }, { name: 'sucrose', low: 0, center: 5, high: 10 }],
  responses: [{ name: 'particle_size_nm', goal: 'target', target: 90 }, { name: 'PDI', goal: 'minimize' }] };

function compare(spec, file) {
  const path = root + file;
  if (!existsSync(path)) return; // pipeline folder not present
  const { rows } = parsePandasCSV(readFileSync(path, 'utf8'));
  const ours = buildDesign(spec);
  assert.equal(ours.length, rows.length, 'run count');
  rows.forEach((py, i) => {
    const js = ours[i];
    assert.equal(js.run_id, py.run_id); assert.equal(js.std_order, py.std_order); assert.equal(js.point_type, py.point_type, `point type of ${py.run_id}`);
    for (const f of spec.factors) {
      assert.ok(Math.abs(js.coded[f.name] - py[f.name + '_coded']) < 1e-9, `${py.run_id} ${f.name} coded`);
      assert.ok(Math.abs(js.real[f.name] - py[f.name]) < 1e-6, `${py.run_id} ${f.name} real: ${js.real[f.name]} vs ${py[f.name]}`);
    }
  });
}

test('CCD face-centred with asymmetric temperature reproduces LNP_ccd_process_2026-08/design.csv', () => {
  compare(ccdSpec, 'LNP_ccd_process_2026-08/design.csv');
  const s = designSummary(ccdSpec, buildDesign(ccdSpec));
  assert.equal(s.runs, 18); assert.deepEqual(s.byType, { factorial: 8, axial: 6, center: 4 }); assert.equal(s.terms, 9); assert.equal(s.residualDf, 8);
});

test('Box-Behnken reproduces LNP_buffer_screen_2026-09/design.csv', () => {
  compare(bbdSpec, 'LNP_buffer_screen_2026-09/design.csv');
  assert.equal(buildDesign(bbdSpec).length, 15);
});

test('randomisation gives a permutation with wells; validation catches the pipeline rules', () => {
  const r = randomizeRuns(ccdSpec, buildDesign(ccdSpec));
  assert.deepEqual(r.map((x) => x.run_order), Array.from({ length: 18 }, (_, i) => i + 1));
  assert.equal(r[0].well, 'A1'); assert.equal(r[8].well, 'A2');
  assert.deepEqual(wellNames(96, 'H1').slice(0, 2), ['H1', 'A2']);
  assert.ok(validateSpec({ ...ccdSpec, designType: 'full_factorial' }).some((m) => /quadratic/.test(m)));
  assert.ok(validateSpec({ ...bbdSpec, factors: bbdSpec.factors.slice(0, 2) }).some((m) => /Box-Behnken/.test(m)));
  assert.ok(validateSpec({ ...ccdSpec, factors: [{ name: 'N/P', low: 3, high: 9 }, ccdSpec.factors[1]] }).some((m) => /identifier/.test(m)));
  assert.equal(plackettBurman(5).length, 8); assert.equal(plackettBurman(5)[0].length, 5);
});

test('Plackett-Burman: N the next multiple of 4, every column balanced, every pair of columns orthogonal', () => {
  // Rows 1…N−1 of a Sylvester Hadamard lost a run (7 for five factors), left four lows against three highs in
  // every column, and could only make powers of two (15 runs for 8–11 factors).
  const runsFor = (k) => (k <= 3 ? 4 : k <= 7 ? 8 : k <= 11 ? 12 : k <= 15 ? 16 : k <= 19 ? 20 : 24);
  for (let k = 2; k <= 23; k++) {
    const d = plackettBurman(k);
    assert.equal(d.length, runsFor(k), `${k} factors: ${d.length} runs`);
    assert.ok(d.every((r) => r.length === k && r.every((v) => v === 1 || v === -1)), `${k} factors: two levels, k columns`);
    for (let a = 0; a < k; a++) {
      assert.equal(d.reduce((s, r) => s + r[a], 0), 0, `${k} factors: column ${a} is not half high, half low`);
      for (let b = a + 1; b < k; b++) assert.equal(d.reduce((s, r) => s + r[a] * r[b], 0), 0, `${k} factors: columns ${a} and ${b} are not orthogonal`);
    }
  }
  assert.throws(() => plackettBurman(24), /23 factors/);
  // the first 12-run row is the published generator
  assert.deepEqual(plackettBurman(11)[0], [1, 1, -1, 1, 1, 1, -1, -1, -1, 1, -1]);
});
