// Mixture designs. The checks that matter here are the ones with an independent answer to compare against:
// the determinant update against a recomputed determinant, the exchange against exhaustive enumeration, the
// fitted coefficients against a model whose coefficients are known. Anything that only compares the code to
// itself would pass just as happily with the mathematics wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  simplexLattice, simplexCentroid, extremeVertices, toPseudo, fromPseudo, uppersBind,
  mixturePool, mixtureDesign, crossedDesign, poolCentre, processGrid,
  scheffeTerms, processTerms, crossedTerms, designMatrix, fitMixture, logDet, dOptimal, dEfficiency, modelRank,
} from '../app/calc/mixture.js';
import { buildDesign, validateSpec, designSummary, designColumns, modelTermsFor, specMode, toDesignCSV, suggestedBudget } from '../app/calc/doe.js';
import { blendTrace } from '../app/calc/diagnostics.js';
import { cholesky, cholInverse } from '../app/calc/ml/linalg.js';
import { overriddenComposition } from '../app/calc/composition.js';
import { buildExperiment } from '../app/calc/experiment.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);
const molSum = (o, keys) => keys.reduce((a, k) => a + o[k], 0);
const RESP = [{ name: 'particle_size_nm', unit: 'nm', goal: 'target', target: 90, min_valid: 20, max_valid: 500 }];
const C3 = [{ name: 'ALC315', lipidKey: 'ALC315', lo: 40, hi: 60 }, { name: 'Chol', lipidKey: 'Chol', lo: 35, hi: 55 }, { name: 'DMGPEG', lipidKey: 'DMG0PEG2000', lo: 1, hi: 5 }];
const C4 = [...C3, { name: 'DSPC', lipidKey: 'DSPC', lo: 5, hi: 15 }];
const spec = (over = {}) => ({
  mode: 'mixture', model: 'linear', mixtureOrder: 'quadratic', mixtureKind: 'auto',
  components: C3, factors: [], responses: RESP, centerPoints: 3, seed: 42, total: 100, budget: 14, ...over,
});

/* ---------------- geometry ---------------- */

test('simplex designs have the sizes the combinatorics say they do', () => {
  assert.equal(simplexLattice(3, 2).length, 6);     // C(q+m-1, m)
  assert.equal(simplexLattice(4, 3).length, 20);
  assert.equal(simplexCentroid(3).length, 7);       // 2^q - 1
  assert.equal(simplexCentroid(4).length, 15);
  for (const p of [...simplexLattice(4, 3), ...simplexCentroid(4)]) {
    assert.ok(Math.abs(sum(p) - 1) < 1e-12, `a mixture point must sum to one, got ${sum(p)}`);
    assert.ok(p.every((v) => v >= 0), 'no component may be negative');
  }
});

test('extreme vertices of a constrained region satisfy every bound', () => {
  const bounds = [{ lo: 0.2, hi: 0.6 }, { lo: 0.1, hi: 0.5 }, { lo: 0.1, hi: 0.4 }];
  const V = extremeVertices(bounds, 1);
  assert.ok(V.length >= 3, 'a two-dimensional region needs at least three corners');
  for (const v of V) {
    assert.ok(Math.abs(sum(v) - 1) < 1e-9);
    v.forEach((x, i) => assert.ok(x >= bounds[i].lo - 1e-9 && x <= bounds[i].hi + 1e-9, `component ${i} out of bounds at ${x}`));
  }
  // every corner is distinct
  assert.equal(new Set(V.map((v) => v.map((x) => x.toFixed(6)).join(','))).size, V.length);
});

test('a corner of the region is a corner: no feasible point lies beyond it in its own direction', () => {
  const bounds = [{ lo: 0.2, hi: 0.6 }, { lo: 0.1, hi: 0.5 }, { lo: 0.1, hi: 0.4 }];
  const V = extremeVertices(bounds, 1);
  // Sample the region densely; nothing feasible may exceed the vertex set's extent along any component.
  const maxV = [0, 1, 2].map((i) => Math.max(...V.map((v) => v[i])));
  const minV = [0, 1, 2].map((i) => Math.min(...V.map((v) => v[i])));
  for (let a = 0; a <= 1.0001; a += 0.02) for (let b = 0; b <= 1 - a + 1e-9; b += 0.02) {
    const p = [a, b, 1 - a - b];
    if (!p.every((x, i) => x >= bounds[i].lo - 1e-9 && x <= bounds[i].hi + 1e-9)) continue;
    p.forEach((x, i) => assert.ok(x <= maxV[i] + 1e-6 && x >= minV[i] - 1e-6, `a feasible blend reaches ${x} on component ${i}, outside the vertices`));
  }
});

test('pseudo-components invert, and respect the lower bounds', () => {
  const lows = [30, 5, 1], total = 100;
  const real = fromPseudo([0.5, 0.25, 0.25], lows, total);
  assert.ok(Math.abs(sum(real) - total) < 1e-9);
  real.forEach((v, i) => assert.ok(v >= lows[i] - 1e-9));
  toPseudo(real, lows, total).forEach((v, i) => assert.ok(Math.abs(v - [0.5, 0.25, 0.25][i]) < 1e-12));
  assert.equal(uppersBind([{ lo: 30, hi: 100 }, { lo: 5, hi: 100 }, { lo: 1, hi: 100 }], 100), false);
  assert.equal(uppersBind([{ lo: 30, hi: 50 }, { lo: 5, hi: 20 }, { lo: 1, hi: 5 }], 100), true);
});

/* ---------------- designs ---------------- */

test('every run of every design is a blend that could be made', () => {
  for (const comps of [C3, C4]) {
    for (const kind of ['auto', 'centroid', 'lattice', 'vertices']) {
      const d = mixtureDesign(comps.map((c) => ({ key: c.name, lo: c.lo, hi: c.hi })), { kind, budget: 12, replicates: 2 });
      const keys = comps.map((c) => c.name);
      for (const p of d.points) {
        assert.ok(Math.abs(molSum(p.x, keys) - 100) < 1e-4, `${kind}: a run sums to ${molSum(p.x, keys)}`);
        comps.forEach((c) => assert.ok(p.x[c.name] >= c.lo - 1e-4 && p.x[c.name] <= c.hi + 1e-4,
          `${kind}: ${c.name} at ${p.x[c.name]} is outside ${c.lo}-${c.hi}`));
      }
    }
  }
});

test('infeasible bounds are refused with a reason, not silently repaired', () => {
  assert.throws(() => mixturePool([{ key: 'A', lo: 60, hi: 70 }, { key: 'B', lo: 60, hi: 70 }]), /lower bounds add to 120/);
  assert.throws(() => mixturePool([{ key: 'A', lo: 0, hi: 20 }, { key: 'B', lo: 0, hi: 20 }]), /upper bounds only add to 40/);
  assert.throws(() => mixturePool([{ key: 'A', lo: 0, hi: 100 }]), /at least two components/);
});

test('a budget selects runs rather than returning the whole candidate pool', () => {
  const d = mixtureDesign(C4.map((c) => ({ key: c.name, lo: c.lo, hi: c.hi })), { budget: 16, replicates: 3 });
  assert.equal(d.points.length, 19, '16 selected runs plus 3 centre replicates');
  assert.ok(d.pool.length > 50, 'the pool is much larger than the design');
  assert.ok(d.selected);
  // A selected design is more efficient per run than the pool it came from; that is the whole point.
  assert.ok(d.efficiency > d.poolEfficiency, `selection should raise per-run efficiency: ${d.efficiency} vs ${d.poolEfficiency}`);
  assert.equal(d.points.filter((p) => p.type === 'center').length, 3);
});

test('the pool centre is inside the region', () => {
  const pool = mixturePool(C3.map((c) => ({ key: c.name, lo: c.lo, hi: c.hi })));
  const c = poolCentre(pool);
  assert.ok(Math.abs(molSum(c, C3.map((x) => x.name)) - 100) < 1e-4);
  C3.forEach((x) => assert.ok(c[x.name] >= x.lo - 1e-6 && c[x.name] <= x.hi + 1e-6, `${x.name} centre at ${c[x.name]}`));
});

test('a crossed design varies the blend and the process in the same runs', () => {
  const d = crossedDesign(C3.map((c) => ({ key: c.name, lo: c.lo, hi: c.hi })), ['FRR', 'flow'], { budget: 22, replicates: 3 });
  const keys = C3.map((c) => c.name);
  assert.ok(d.points.every((p) => Math.abs(molSum(p.x, keys) - 100) < 1e-4));
  assert.ok(d.points.every((p) => Math.abs(p.x.FRR) <= 1 + 1e-9 && Math.abs(p.x.flow) <= 1 + 1e-9));
  const blends = new Set(d.points.map((p) => keys.map((k) => p.x[k]).join('/')));
  const settings = new Set(d.points.map((p) => `${p.x.FRR}/${p.x.flow}`));
  assert.ok(blends.size > 1 && settings.size > 1, 'both sides must actually vary');
  // and the blends alone must be able to carry the blending model
  assert.ok(blends.size >= d.mixTerms.length, `${blends.size} blends cannot identify ${d.mixTerms.length} blending terms`);
  assert.throws(() => crossedDesign(C3.map((c) => ({ key: c.name, lo: c.lo, hi: c.hi })), []), /at least one process factor/);
});

test('processGrid covers the levels asked for', () => {
  assert.equal(processGrid(['a', 'b'], 3).length, 9);
  assert.equal(processGrid(['a', 'b', 'c'], 2).length, 8);
  assert.deepEqual([...new Set(processGrid(['a'], 3).map((g) => g.a))].sort((x, y) => x - y), [-1, 0, 1]);
});

/* ---------------- models ---------------- */

test('Scheffe models have the canonical number of terms and no intercept', () => {
  assert.equal(scheffeTerms(['A', 'B', 'C'], 'linear').length, 3);
  assert.equal(scheffeTerms(['A', 'B', 'C'], 'quadratic').length, 6);        // q(q+1)/2
  assert.equal(scheffeTerms(['A', 'B', 'C'], 'special_cubic').length, 7);
  assert.equal(scheffeTerms(['A', 'B', 'C', 'D'], 'quadratic').length, 10);
  for (const t of scheffeTerms(['A', 'B', 'C'], 'special_cubic')) {
    assert.notEqual(t.name, 'Intercept');
    // every term vanishes when every component does, which is what having no constant means
    assert.equal(t.f({ A: 0, B: 0, C: 0 }), 0);
  }
  const cr = crossedTerms(scheffeTerms(['A', 'B', 'C'], 'quadratic'), processTerms(['T', 'F'], 'linear'));
  assert.equal(cr.length, 6 * (1 + 2));
});

test('the fit recovers coefficients of a model it is given exactly', () => {
  const terms = scheffeTerms(['A', 'B', 'C'], 'quadratic');
  const runs = simplexLattice(3, 3).map((p) => ({ A: p[0], B: p[1], C: p[2] }));
  const want = { A: 10, B: 20, C: 30, 'A·B': 40, 'A·C': 0, 'B·C': 0 };
  const y = runs.map((r) => 10 * r.A + 20 * r.B + 30 * r.C + 40 * r.A * r.B);
  const fit = fitMixture(runs, y, terms);
  terms.forEach((t, i) => assert.ok(Math.abs(fit.beta[i] - want[t.name]) < 1e-6, `${t.name}: ${fit.beta[i]} should be ${want[t.name]}`));
  assert.ok(Math.abs(fit.r2 - 1) < 1e-9);
  assert.equal(fit.df, fit.n - terms.length, 'no degree of freedom is spent on an intercept');
  assert.ok(fit.stdErr && fit.pValues, 'the fit reports its own uncertainty');
});

test('a crossed fit separates a blend-by-process interaction from the rest', () => {
  const terms = crossedTerms(scheffeTerms(['A', 'B', 'C'], 'quadratic'), processTerms(['T'], 'linear'));
  const runs = [];
  for (const T of [-1, 0, 1]) for (const p of simplexLattice(3, 2)) runs.push({ A: p[0], B: p[1], C: p[2], T });
  const y = runs.map((r) => 10 * r.A + 20 * r.B + 30 * r.C + 40 * r.A * r.B + 5 * r.A * r.T);
  const fit = fitMixture(runs, y, terms);
  const at = terms.findIndex((t) => t.name === 'A × T');
  assert.ok(Math.abs(fit.beta[at] - 5) < 1e-6, `A × T should be 5, got ${fit.beta[at]}`);
  terms.forEach((t, i) => { if (t.name.includes('×') && t.name !== 'A × T') assert.ok(Math.abs(fit.beta[i]) < 1e-6, `${t.name} should be zero`); });
});

test('an underdetermined fit refuses rather than inventing coefficients', () => {
  const terms = scheffeTerms(['A', 'B', 'C'], 'quadratic');
  const runs = simplexLattice(3, 2).slice(0, 4).map((p) => ({ A: p[0], B: p[1], C: p[2] }));
  const fit = fitMixture(runs, [1, 2, 3, 4], terms);
  assert.equal(fit.beta, null);
  assert.match(fit.note, /needs more than|cannot separate/);
});

/* ---------------- the exchange, against independent answers ---------------- */

test('the Fedorov update equals a recomputed determinant', () => {
  const terms = scheffeTerms(['A', 'B', 'C'], 'quadratic');
  const cand = [];
  for (const T of [-1, 0, 1]) for (const p of simplexLattice(3, 3)) cand.push({ A: p[0], B: p[1], C: p[2], T });
  const row = cand.map((c) => terms.map((t) => t.f(c)));
  const k = terms.length, picked = [0, 1, 2, 3, 4, 5, 6, 7];
  const M = Array.from({ length: k }, (_, a) => Array.from({ length: k }, (_, b) => picked.reduce((s, i) => s + row[i][a] * row[i][b], 0)));
  const inv = cholInverse(cholesky(M, { absolute: false }).L);
  const q = (x, y) => { let s = 0; for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) s += x[a] * inv[a][b] * y[b]; return s; };
  const ld0 = logDet(picked.map((i) => row[i]));
  let checked = 0;
  for (let pos = 0; pos < picked.length; pos++) for (let j = 0; j < cand.length; j++) {
    if (picked.includes(j)) continue;
    const xi = row[picked[pos]], xj = row[j];
    const predicted = (1 + q(xj, xj)) * (1 - q(xi, xi)) + q(xi, xj) ** 2;
    const trial = [...picked]; trial[pos] = j;
    const actual = Math.exp(logDet(trial.map((i) => row[i])) - ld0);
    if (predicted < 1e-10 || actual < 1e-10) continue;
    assert.ok(Math.abs(predicted - actual) / actual < 1e-5,
      `exchange ${pos}->${j}: formula says ${predicted}, recomputing says ${actual}`);
    checked += 1;
  }
  assert.ok(checked > 50, `only ${checked} exchanges were comparable; the check is not exercising the formula`);
});

test('the exchange finds the optimum an exhaustive search finds', () => {
  const cand = [];
  for (const T of [-1, 1]) for (const p of simplexLattice(3, 2)) cand.push({ A: p[0], B: p[1], C: p[2], T });
  for (const [terms, n] of [[scheffeTerms(['A', 'B', 'C'], 'linear'), 5], [scheffeTerms(['A', 'B', 'C'], 'quadratic'), 8]]) {
    const row = cand.map((c) => terms.map((t) => t.f(c)));
    let best = -Infinity, seen = 0;
    const walk = (start, acc) => {
      if (acc.length === n) { seen += 1; best = Math.max(best, logDet(acc.map((i) => row[i]))); return; }
      for (let i = start; i < cand.length; i++) { acc.push(i); walk(i + 1, acc); acc.pop(); }
    };
    walk(0, []);
    const found = dOptimal(cand, terms, n, { starts: 8 });
    assert.ok(seen > 100, 'the exhaustive search should have real work to do');
    assert.ok(found.logdet >= best - 1e-9, `${terms.length} terms: exchange found ${found.logdet}, exhaustive found ${best} over ${seen} subsets`);
    assert.equal(found.picked.length, n);
    assert.equal(new Set(found.picked).size, n, 'a run must not be selected twice');
  }
});

test('D-optimal selection refuses what it cannot fit, and takes everything when asked for more than exists', () => {
  const cand = simplexCentroid(3).map((p) => ({ A: p[0], B: p[1], C: p[2] }));
  const terms = scheffeTerms(['A', 'B', 'C'], 'quadratic');
  assert.throws(() => dOptimal(cand, terms, 4), /4 runs cannot determine 6 model terms/);
  assert.equal(dOptimal(cand, terms, 50).picked.length, cand.length);
  assert.equal(dEfficiency(-Infinity, 6, 10), 0);
});

/* ---------------- the default design can be fitted (usability cycle 3, C3) ---------------- */

// The wizard's default blend × process design: the registry's MC3 reference recipe, each lipid free to move
// ±30 % of where it sits (rounded to 0.1 mol%, as componentsFromComposition in app/ui/experiments.js does),
// crossed with FRR and total flow under a linear process model, at the suggested budget with 3 centre runs.
const DEFAULT_RECIPE = { MC3: 50, DSPC: 10, Chol: 38.5, DMG0PEG2000: 1.5 };
const r1 = (v) => Math.round(v * 10) / 10;
const defaultCrossed = (over = {}) => {
  const s = spec({
    mode: 'crossed', model: 'linear', mixtureOrder: 'quadratic', centerPoints: 3, seed: 42, budget: null,
    components: Object.entries(DEFAULT_RECIPE).map(([k, v]) => ({ name: k, lipidKey: k, lo: r1(v * 0.7), hi: r1(v * 1.3) })),
    factors: [{ name: 'FRR', unit: '', low: 2, high: 4, applyTo: 'frr' }, { name: 'flow_rate', unit: 'mL/min', low: 60, high: 120, applyTo: 'tfr' }],
    ...over,
  });
  return { ...s, budget: over.budget ?? suggestedBudget(s) };
};
const modelOf = (s) => crossedTerms(scheffeTerms(s.components.map((c) => c.name), s.mixtureOrder), processTerms(s.factors.map((f) => f.name), s.model));

test('the default blend × process design has a model matrix of full column rank, and fits', () => {
  const s = defaultCrossed();
  const runs = buildDesign(s);
  const terms = modelOf(s);
  assert.equal(terms.length, 30, 'four lipids, quadratic blending, crossed with two linear process terms');
  assert.equal(runs.length, 38, 'the suggested 35 runs and 3 centre replicates');
  // In the units the DoE screen fits in: pseudo-components and coded process settings.
  const X = designMatrix(runs.map((r) => r.coded), terms);
  assert.equal(modelRank(X), terms.length, 'every one of the 30 terms must be separable');
  assert.ok(Number.isFinite(logDet(X)), 'and the information matrix is not singular');
  // The independent check: the fit the screen runs, on a response that uses every kind of term.
  const y = runs.map((r) => 90 + 20 * r.coded.DMG0PEG2000 - 8 * r.coded.MC3 * r.coded.Chol + 3 * r.coded.MC3 * r.coded.FRR + Math.sin(r.std_order));
  const fit = fitMixture(runs.map((r) => r.coded), y, terms);
  assert.ok(fit.beta, `the default design must be fittable, got: ${fit.note}`);
});

test('every default-sized crossed design stays fittable, whatever the seed or model', () => {
  const cases = [
    ...[1, 7, 123].map((seed) => ({ seed })),
    { model: 'interaction' }, { mixtureOrder: 'linear' }, { mixtureOrder: 'linear', model: 'interaction' },
  ];
  for (const over of cases) {
    const s = defaultCrossed(over);
    const { seed, model, mixtureOrder } = s;
    const runs = buildDesign(s);
    const terms = modelOf(s);
    assert.equal(modelRank(designMatrix(runs.map((r) => r.coded), terms)), terms.length, `seed ${seed}, ${mixtureOrder} × ${model}`);
  }
});

test('the exchange keeps full rank on badly scaled candidates', () => {
  // The cause of C3: in mol% a pairwise term of two major lipids is in the thousands and a PEG term near one.
  // The old exchange worked in those units and returned a design of rank 28 for this 30-term model.
  const comps = Object.entries(DEFAULT_RECIPE).map(([k, v]) => ({ key: k, lo: r1(v * 0.7), hi: r1(v * 1.3) }));
  const d = crossedDesign(comps, ['FRR', 'flow'], { budget: 35, seed: 42 });
  const pool = d.pool.map((p) => p.x); // mol%, the raw units
  const terms = crossedTerms(scheffeTerms(comps.map((c) => c.key), 'quadratic'), processTerms(['FRR', 'flow'], 'linear'));
  const pick = dOptimal(pool, terms, 35, { seed: 42 });
  assert.equal(pick.poolRank, 30);
  assert.equal(pick.rank, 30, `the selection separates only ${pick.rank} of 30 terms`);
  assert.equal(modelRank(designMatrix(pick.picked.map((i) => pool[i]), terms)), 30);
});

test('modelRank sees a dependency whatever the scale of the columns', () => {
  const X = [[1, 2000, 2001], [2, 3000, 3002], [3, 1000, 1003], [4, 7000, 7004]];   // third column = first + second
  assert.equal(modelRank(X), 2);
  assert.equal(logDet(X), -Infinity);
  assert.equal(modelRank([[1, 0], [0, 1e-3], [1, 1e-3]]), 2, 'a small column is not a missing one');
});

test('a design its model cannot be fitted to is refused before it is built, with the reason', () => {
  // A {3, 1} lattice is the three pure blends: three points cannot carry six quadratic blending terms. (Lower
  // bounds only, or the binding upper bounds would turn it into a constrained region with a richer pool.)
  const open = [{ name: 'A', lo: 30, hi: 100 }, { name: 'B', lo: 5, hi: 100 }, { name: 'C', lo: 1, hi: 100 }];
  const s = spec({ components: open, mixtureKind: 'lattice', degree: 1, budget: null, centerPoints: 0 });
  assert.deepEqual(validateSpec(s), []);
  assert.throws(() => buildDesign(s), /can only separate 3 of the 6 terms/);
});

/* ---------------- the spec: three modes ---------------- */

test('a spec with no mode is still a process design, exactly as before', () => {
  const ps = { designType: 'ccd_faced', model: 'quadratic', centerPoints: 3, replicates: 1, seed: 42, responses: RESP,
    factors: [{ name: 'FRR', low: 2, high: 4 }, { name: 'flow_rate', low: 60, high: 120 }] };
  assert.equal(specMode(ps), 'process');
  assert.deepEqual(validateSpec(ps), []);
  const runs = buildDesign(ps);
  assert.equal(runs.length, 11);
  assert.deepEqual(designColumns(ps).map((c) => c.name), ['FRR', 'flow_rate']);
});

test('buildDesign gives a mixture run its mol% and its pseudo-components', () => {
  const s = spec();
  const runs = buildDesign(s);
  const keys = C3.map((c) => c.name);
  for (const r of runs) {
    assert.ok(Math.abs(molSum(r.real, keys) - 100) < 1e-6, `real mol% sum ${molSum(r.real, keys)}`);
    assert.ok(Math.abs(molSum(r.coded, keys) - 1) < 1e-6, 'pseudo-components must sum to one');
    C3.forEach((c) => assert.ok(r.real[c.name] >= c.lo - 1e-6 && r.real[c.name] <= c.hi + 1e-6));
  }
  assert.equal(new Set(runs.map((r) => r.run_id)).size, runs.length, 'run ids are unique');
  assert.deepEqual(runs.map((r) => r.std_order), runs.map((_, i) => i + 1));
});

test('a crossed spec carries both sides into every run and into the exports', () => {
  const s = spec({ mode: 'crossed', budget: 22, factors: [{ name: 'FRR', unit: '', low: 2, high: 4 }, { name: 'flow_rate', unit: 'mL/min', low: 60, high: 120 }] });
  assert.deepEqual(validateSpec(s), []);
  const runs = buildDesign(s);
  assert.deepEqual(designColumns(s).map((c) => c.name), ['ALC315', 'Chol', 'DMGPEG', 'FRR', 'flow_rate']);
  for (const r of runs) {
    assert.ok(r.real.FRR >= 2 - 1e-9 && r.real.FRR <= 4 + 1e-9, `FRR ${r.real.FRR} outside its range`);
    assert.ok(r.real.flow_rate >= 60 - 1e-9 && r.real.flow_rate <= 120 + 1e-9);
    assert.ok(Math.abs(molSum(r.real, C3.map((c) => c.name)) - 100) < 1e-6);
  }
  const head = toDesignCSV(s, runs).split('\n')[0].split(',');
  for (const n of ['ALC315', 'Chol', 'DMGPEG', 'FRR', 'flow_rate']) {
    assert.ok(head.includes(n) && head.includes(n + '_coded'), `the CSV must carry ${n} in both units`);
  }
});

test('the model term count is the one the summary reports', () => {
  for (const s of [spec(), spec({ mixtureOrder: 'linear' }), spec({ mixtureOrder: 'special_cubic', budget: 16 }),
    spec({ mode: 'crossed', budget: 22, factors: [{ name: 'FRR', low: 2, high: 4 }, { name: 'flow_rate', low: 60, high: 120 }] })]) {
    const runs = buildDesign(s);
    const sm = designSummary(s, runs);
    assert.equal(sm.terms, modelTermsFor(s).length);
    assert.equal(sm.residualDf, runs.length - sm.terms, 'a Scheffe model spends no degree of freedom on an intercept');
    assert.ok(sm.distinctBlends >= sm.mixTerms, `${sm.distinctBlends} blends cannot identify ${sm.mixTerms} blending terms`);
    assert.ok(sm.runs > sm.terms, 'the suggested design must leave something to check the fit with');
  }
});

test('validation catches the mistakes a blend invites', () => {
  const bad = (over, re) => {
    const errs = validateSpec(spec(over));
    assert.ok(errs.length, `expected an error for ${JSON.stringify(Object.keys(over))}`);
    assert.match(errs.join(' | '), re);
  };
  bad({ components: [{ name: 'A', lo: 60, hi: 70 }, { name: 'B', lo: 60, hi: 70 }] }, /lower bounds add to/);
  bad({ components: [{ name: 'A', lo: 0, hi: 20 }, { name: 'B', lo: 0, hi: 20 }] }, /upper bounds only add to/);
  bad({ components: [{ name: 'A', lo: 40, hi: 60 }] }, /at least two lipids/);
  bad({ components: [{ name: 'ALC-0315', lo: 40, hi: 60 }, { name: 'Chol', lo: 35, hi: 60 }] }, /plain identifier/);
  bad({ components: [...C3, { name: 'FRR', lo: 0, hi: 10 }], mode: 'crossed', factors: [{ name: 'FRR', low: 2, high: 4 }] }, /must all be different/);
  bad({ budget: 3 }, /cannot determine the 6 terms/);
  bad({ mode: 'crossed', factors: [] }, /at least one process factor/);
  bad({ components: [{ name: 'A', lo: 40, hi: 30 }, { name: 'B', lo: 35, hi: 80 }] }, /upper mol% must exceed/);
  // A process factor cannot drive a lipid the blend is already choosing.
  bad({ mode: 'crossed', budget: 22, factors: [{ name: 'PEG_mol_pct', low: 1, high: 3, applyTo: 'peg_pct' }] }, /already chooses/);
  assert.ok(suggestedBudget(spec()) > modelTermsFor(spec()).length, 'the suggestion must leave residual degrees of freedom');
});

test('the design is stable: the same spec gives the same runs', () => {
  const s = spec({ mode: 'crossed', budget: 22, factors: [{ name: 'FRR', low: 2, high: 4 }, { name: 'flow_rate', low: 60, high: 120 }] });
  const a = buildDesign(s), b = buildDesign({ ...s, components: s.components.map((c) => ({ ...c })) });
  assert.deepEqual(a.map((r) => r.real), b.map((r) => r.real), 'an identical spec must give an identical design');
});

/* ---------------- the blend reaches the bench ---------------- */

test('a mixture run becomes a batch whose record names every lipid', () => {
  const s = {
    type: 'doe', name: 'blend', startDate: '2026-10-24', compositionId: 1, tests: ['dls'],
    doe: spec({ mode: 'crossed', budget: 22, factors: [{ name: 'FRR', unit: '', low: 2, high: 4, applyTo: 'frr' }, { name: 'flow_rate', unit: 'mL/min', low: 60, high: 120, applyTo: 'tfr' }] }),
    rna_mg: 3, working_mg_mL: 0.4, lipidStock_mM: 50, frr: 3, quenchFactor: 2, totalFlow: 112.5,
  };
  const { experiment, batches } = buildExperiment(s, { settings: { defaultWorking_mg_mL: 0.4, defaultFRR: 3, defaultQuenchFactor: 2, defaultLipidStock_mM: 50 }, takenFormulations: [], experimentId: 'E99' });
  assert.equal(batches.length, experiment.design.doe.runs.length);

  const ref = { lipidByKey: { MC3: { class: 'ionizable' }, Chol: { class: 'sterol' }, DMG0PEG2000: { class: 'peg' }, DSPC: { class: 'helper' } } };
  const registry = { id: 1, synonym: 'MC3 reference (Onpattro-like)', mol_pct: { MC3: 50, DSPC: 10, Chol: 38.5, DMG0PEG2000: 1.5 }, sum: 100 };
  for (const b of batches) {
    const over = b.plan.compositionOverride;
    assert.ok(over?.mol_pct, 'every mixture batch carries its own blend');
    const comp = overriddenComposition(registry, over, ref);
    assert.ok(comp.fromMixtureDesign);
    assert.ok(Math.abs(comp.sum - 100) < 1e-3, `the recipe on the batch record sums to ${comp.sum}`);
    // the design chose these three lipids, so DSPC is not in this blend even though the registry entry has it
    assert.deepEqual(Object.keys(comp.mol_pct).sort(), ['ALC315', 'Chol', 'DMG0PEG2000'].sort());
    // and the process factors still drove the plan
    assert.ok(b.plan.mixing.frr >= 2 && b.plan.mixing.frr <= 4);
  }
  // the class-based override path is untouched
  const cls = overriddenComposition(registry, { peg_pct: 3 }, ref);
  assert.equal(cls.mol_pct.DMG0PEG2000, 3);
  assert.equal(overriddenComposition(registry, null, ref), registry);
});

/* ---------------- the response trace ---------------- */

test('a response trace never leaves the region, and passes through the reference blend', () => {
  const s = spec({ budget: 14 });
  const runs = buildDesign(s);
  const terms = scheffeTerms(C3.map((c) => c.name), 'quadratic');
  const y = runs.map((r) => 140 - 9 * r.real.DMGPEG + 0.25 * (r.real.ALC315 - 50));
  const fit = fitMixture(runs.map((r) => r.coded), y, terms);
  const centre = runs.find((r) => r.point_type === 'center');
  const reference = C3.map((c) => centre.real[c.name]);
  const lines = blendTrace(fit, terms, C3, { total: 100, reference });

  assert.equal(lines.length, C3.length, 'one trace per lipid');
  for (const l of lines) {
    const c = C3.find((x) => x.name === l.name);
    for (const p of l.points) {
      assert.ok(p.mol >= c.lo - 1e-6 && p.mol <= c.hi + 1e-6, `${l.name} traced to ${p.mol} mol%, outside ${c.lo}-${c.hi}`);
      assert.ok(Number.isFinite(p.y), 'a trace point must have a prediction');
    }
    const mid = l.points[(l.points.length - 1) / 2];
    assert.ok(Math.abs(mid.mol - centre.real[l.name]) < 1e-6, `${l.name} should pass through the reference blend at x = 0`);
  }
  // PEG was given a strong effect and cholesterol none, so PEG's trace must be the steepest. Cholesterol's is
  // not flat, and should not be: moving it along the Cox direction pushes PEG down with it, so its trace
  // carries PEG's effect. Nothing is held constant on a simplex, which is the whole reason these designs
  // exist and the reason a steep trace names a direction rather than a culprit.
  const range = (n) => { const l = lines.find((x) => x.name === n); return Math.abs(l.points[l.points.length - 1].y - l.points[0].y); };
  assert.ok(range('DMGPEG') > range('Chol'), `PEG should move the response most: ${range('DMGPEG')} vs ${range('Chol')}`);
  assert.ok(range('Chol') > 1, 'and cholesterol is not flat, because moving it displaces the PEG that does the work');
});

test('a reference blend outside the region is refused rather than traced from', () => {
  const terms = scheffeTerms(C3.map((c) => c.name), 'quadratic');
  const runs = buildDesign(spec());
  const fit = fitMixture(runs.map((r) => r.coded), runs.map(() => 100), terms);
  // 90 mol% PEG is not a blend this design allows
  assert.deepEqual(blendTrace(fit, terms, C3, { total: 100, reference: [5, 5, 90] }), []);
});

/* ---------------- speed, because the wizard redraws on every keystroke ---------------- */

test('building a design stays fast enough for a live preview', () => {
  const s = spec({ mode: 'crossed', budget: 34, components: C4, factors: [{ name: 'FRR', low: 2, high: 4 }, { name: 'flow_rate', low: 60, high: 120 }] });
  const t0 = Date.now();
  buildDesign(s);
  const first = Date.now() - t0;
  const t1 = Date.now();
  for (let i = 0; i < 20; i++) buildDesign(s);
  const cached = Date.now() - t1;
  assert.ok(first < 4000, `a four-lipid crossed design took ${first} ms to build`);
  assert.ok(cached < 100, `20 cached rebuilds took ${cached} ms; the wizard would stutter on every keystroke`);
});
