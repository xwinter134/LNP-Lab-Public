// Every recipe the optimizer proposes can be weighed out. With ionizable lipid, PEG-lipid and cholesterol all
// varied, the helper lipid takes up the rest, and in the demo lab all four suggestions needed it negative
// (−13.9 mol% for the first) while the table showed nothing. The search now keeps the balance class inside its
// band before it scores anything (space.js mixtureLimits / fitMixture, acquire.js feasibleCandidates).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mixtureLimits, mixtureAt, canWeighOut, fitMixture, pointToPlan, snap, toUnit, fromUnit, COMPOSITION_FACTORS } from '../app/calc/ml/space.js';
import { desirabilityGrid } from '../app/calc/ml/explain.js';
import { suggestRuns, predictedOptimum } from '../app/calc/ml/acquire.js';
import { analyse, startingDesign } from '../app/calc/ml/optimizer.js';
import { fitGP } from '../app/calc/ml/gp.js';
import { standardise } from '../app/calc/ml/model.js';
import { mulberry32 } from '../app/calc/ml/linalg.js';

const def = (key) => COMPOSITION_FACTORS.find((c) => c.key === key);
const lipid = (key, lo, hi) => ({ key, name: def(key).name, unit: 'mol%', step: def(key).step, lo, hi });
// The demo lab's default factors: cholesterol is ticked, so the helper lipid balances.
const demo = [{ key: 'frr', name: 'Flow rate ratio', unit: '', step: 0.1, lo: 1.1, hi: 6 },
  lipid('ionizable_pct', 35, 60), lipid('peg_pct', 0.5, 3), lipid('sterol_pct', 25.5, 54)];
const mc3 = { ionizable: 50, helper: 10, peg: 1.5, sterol: 38.5, other: 0 };
const ref = { lipidByKey: { MC3: { class: 'ionizable' }, DSPC: { class: 'helper' }, Chol: { class: 'sterol' }, PEG: { class: 'peg' } } };
const base = { id: 1, mol_pct: { MC3: 50, DSPC: 10, Chol: 38.5, PEG: 1.5 } };

test('the room the mixture leaves: the balance class, its band, and a recipe that does not fit', () => {
  const m = mixtureLimits(demo, mc3);
  assert.equal(m.balance, 'helper');
  assert.equal(m.balanceName, 'Helper phospholipid');
  assert.deepEqual([m.lo, m.hi, m.fixed], [5, 20, 0]);
  assert.equal(m.room, true);
  // the coordinator's case, near enough: every varied lipid high, the helper lipid far below zero
  const bad = { frr: 4, ionizable_pct: 56, peg_pct: 2.6, sterol_pct: 54.5 };
  assert.deepEqual(mixtureAt(bad, m), { ok: false, balance: -13.1 });
  assert.deepEqual(mixtureAt({ ionizable_pct: 50, peg_pct: 1.5, sterol_pct: 38.5 }, m), { ok: true, balance: 10 });
  // moved into the band: process factors untouched, every lipid still inside its range, and it survives the snap
  const moved = fitMixture({ ...bad, sterol_pct: 54 }, demo, m);
  assert.equal(moved.frr, 4);
  for (const f of demo.slice(1)) assert.ok(moved[f.key] >= f.lo - 1e-9 && moved[f.key] <= f.hi + 1e-9, `${f.key} ${moved[f.key]}`);
  const snapped = snap(moved, demo);
  assert.ok(mixtureAt(snapped, m).ok, `balance after snapping ${mixtureAt(snapped, m).balance}`);
  assert.deepEqual(pointToPlan(snapped, demo, { baseComposition: base, ref }).warnings, [], 'and the batch plan raises nothing');
  const fine = { frr: 2, ionizable_pct: 50, peg_pct: 1.5, sterol_pct: 38.5 };
  assert.equal(fitMixture(fine, demo, m), fine, 'a recipe that fits is left alone');
  // a parent recipe already outside the usual band widens it rather than locking the lab out
  assert.equal(mixtureLimits(demo, { ...mc3, helper: 2, sterol: 46.5 }).lo, 2);
  assert.equal(mixtureLimits([demo[0]], mc3), null, 'no lipid varied, nothing to keep');
  // and a recipe from anywhere else is refused when it cannot be made, a negative varied lipid included
  const plan = (p) => pointToPlan(p, demo, { baseComposition: base, ref }).warnings.filter((w) => w.level === 'impossible').map((w) => w.text);
  assert.deepEqual(plan(bad), ['the varied lipids already total 113.1 mol%, so helper would have to be -13.1 mol%, which cannot be formulated']);
  assert.match(plan({ frr: 2, ionizable_pct: -2, peg_pct: 1.5, sterol_pct: 38.5 })[0], /^Ionizable lipid would be -2 mol%, which cannot be formulated/);
});

test('the map leaves out the recipes that cannot be weighed out', () => {
  const m = mixtureLimits(demo, mc3);
  const models = [{ name: 'ee', yMean: 90, ySd: 5, gp: { predict: () => ({ mean: 0, sd: 0.1 }) } }];
  const goals = [{ name: 'ee', goal: 'maximize', worst: 70, best: 96, weight: 1, on: true }];
  // ionizable against cholesterol, PEG and FRR held mid-range: the corner where both are high cannot be made
  const { grid } = desirabilityGrid(models, demo, 1, 3, goals, { n: 5, feasible: (u) => mixtureAt(fromUnit(u, demo), m).ok });
  assert.equal(grid[4][4].made, false, 'ionizable 60 and cholesterol 54 leave the helper lipid negative');
  assert.equal(grid[2][2].made, true);
  assert.equal(desirabilityGrid(models, demo, 1, 3, goals, { n: 3 }).grid.flat().every((c) => c.made), true, 'without the test, every cell counts');
});

test('ranges that leave no recipe to weigh out are named for what they are', () => {
  const tight = [lipid('ionizable_pct', 55, 60), lipid('peg_pct', 2, 3), lipid('sterol_pct', 45, 54)];
  const m = mixtureLimits(tight, mc3);
  assert.equal(m.room, false);
  assert.equal(m.reason, 'No recipe in these ranges can be weighed out. With Ionizable lipid, PEG-lipid and Cholesterol / sterol varied, Helper phospholipid takes up the rest to reach 100 mol%, and here it would come to −17 to −2 mol%, below 0 whatever the setting. Narrow the ranges of the varied lipids, or switch one off.');
  assert.equal(fitMixture({ ionizable_pct: 58, peg_pct: 2.5, sterol_pct: 50 }, tight, m), null);
  const all = mixtureLimits([...tight, lipid('helper_pct', 5, 20)], mc3);
  assert.equal(all.balance, null);
  assert.equal(all.room, false);
  assert.match(all.reason, /^Every lipid class is varied .*Switch one composition factor off/);
});

test('a recipe outside the ordinary band is unusual, not impossible, and ranges that reach the band only at its edge have room', () => {
  // The review's case: ionizable 55–60, PEG 2–3, cholesterol 38–40 on the MC3 recipe. The helper lipid comes to
  // −3 to 5 mol%, and 55 / 2 / 38 gives exactly 5. Half a step of margin per lipid used to refuse these ranges
  // outright, with a reason that said no recipe in them could be weighed out.
  const edge = [lipid('ionizable_pct', 55, 60), lipid('peg_pct', 2, 3), lipid('sterol_pct', 38, 40)];
  const m = mixtureLimits(edge, mc3);
  assert.equal(m.room, true);
  const corner = { ionizable_pct: 55, peg_pct: 2, sterol_pct: 38 };
  assert.deepEqual(mixtureAt(corner, m), { ok: true, balance: 5 });
  assert.equal(fitMixture({ ionizable_pct: 58, peg_pct: 2.5, sterol_pct: 39 }, edge, m).ionizable_pct, 55, 'a setting is moved to that corner');
  for (const p of startingDesign(edge, 4, 5, m)) assert.ok(mixtureAt(p, m).ok, `starting run with the helper lipid at ${mixtureAt(p, m).balance}`);

  // Below the band but above 0 is a formulation, just not a common one (pointToPlan says "unusual"), and the
  // reason for proposing nothing says so; only below 0 is there no recipe.
  const low = mixtureLimits([lipid('ionizable_pct', 56, 60), lipid('peg_pct', 2, 3), lipid('sterol_pct', 38, 40)], mc3);
  assert.equal(low.room, false);
  assert.equal(low.reason, 'No recipe in these ranges keeps helper phospholipid inside the 5–20 mol% this module treats as ordinary. With Ionizable lipid, PEG-lipid and Cholesterol / sterol varied, it takes up the rest to reach 100 mol%, and here it would come to −3 to 4 mol%. Such a recipe can be made, just not a common one, and the optimizer proposes only ordinary ones. Narrow the ranges of the varied lipids, or vary helper phospholipid and switch another off.');
  const d = mixtureLimits(demo, mc3);
  const h35 = { frr: 2, ionizable_pct: 55, peg_pct: 2, sterol_pct: 39.5 };
  assert.deepEqual(mixtureAt(h35, d), { ok: false, balance: 3.5 }, 'outside the band the search keeps to');
  assert.equal(canWeighOut(h35, d), true, 'but a recipe all the same');
  assert.deepEqual(pointToPlan(h35, demo, { baseComposition: base, ref }).warnings.map((w) => w.level), ['unusual']);
  assert.equal(canWeighOut({ frr: 2, ionizable_pct: 60, peg_pct: 2, sterol_pct: 40 }, d), false, 'the helper lipid at −2 mol% is no recipe');
  assert.equal(canWeighOut({ frr: 2, ionizable_pct: -1, peg_pct: 2, sterol_pct: 40 }, d), false, 'nor is a negative varied lipid');
  const all = mixtureLimits([...edge, lipid('helper_pct', 5, 20)], mc3);
  assert.equal(canWeighOut({ ionizable_pct: 50, peg_pct: 1.5, sterol_pct: 38.5, helper_pct: 10 }, all), true, 'every class varied: a total of 100 is a recipe');
  assert.equal(canWeighOut({ ionizable_pct: 50, peg_pct: 1.5, sterol_pct: 38.5, helper_pct: 12 }, all), false, 'and one of 102 is not');
});

test('suggestions and the predicted optimum stay inside the mixture where the surface pulls out of it', () => {
  // A surface that rewards ionizable lipid and cholesterol together: left alone, the search heads for the
  // corner where both are high, which is exactly where the helper lipid would go negative.
  const rnd = mulberry32(5);
  const m = mixtureLimits(demo, mc3);
  const pts = [];
  while (pts.length < 18) {
    const p = { frr: 1.1 + rnd() * 4.9, ionizable_pct: 35 + rnd() * 25, peg_pct: 0.5 + rnd() * 2.5, sterol_pct: 25.5 + rnd() * 28.5 };
    const f = fitMixture(p, demo, m);
    if (f) pts.push(snap(f, demo)); // the runs made so far were real recipes
  }
  const y = pts.map((p) => 30 + 0.5 * p.ionizable_pct + 0.5 * p.sterol_pct - 2 * (p.frr - 3) ** 2);
  const s = standardise(y);
  const models = [{ name: 'ee', gp: fitGP(pts.map((p) => toUnit(p, demo)), s.z, {}), yMean: s.mean, ySd: s.sd }];
  const goals = [{ name: 'ee', goal: 'maximize', worst: 40, best: 99, weight: 1, on: true }];
  const observed = pts.map((point, i) => ({ point, values: { ee: y[i] }, batchId: `B${i}` }));
  const ask = (mixture) => suggestRuns({ models, space: demo, goals, observed, q: 4, mode: 'balanced', seed: 3, nCandidates: 600, samples: 48, mixture });

  const free = ask(null);
  assert.ok(free.picks.some((p) => !mixtureAt(p.point, m).ok), 'without the constraint the search proposes a recipe that cannot be made');
  const kept = ask(m);
  assert.equal(kept.picks.length, 4);
  for (const p of kept.picks) {
    const at = mixtureAt(p.point, m);
    assert.ok(at.ok, `helper lipid at ${at.balance} mol%`);
    const plan = pointToPlan(p.point, demo, { baseComposition: base, ref });
    assert.deepEqual(plan.warnings, [], 'nothing impossible, nothing unusual');
    assert.ok(plan.composition.helper >= 5 && plan.composition.helper <= 20);
  }
  const opt = predictedOptimum({ models, space: demo, goals, seed: 3, nCandidates: 1500, mixture: m });
  assert.ok(mixtureAt(opt.point, m).ok, `the optimum's helper lipid at ${mixtureAt(opt.point, m).balance} mol%`);
  assert.ok(mixtureAt(opt.point, m).balance < 6, 'and it sits at the edge the surface pulls towards, not somewhere timid');
  // the starting design too
  for (const p of startingDesign(demo, 8, 5, m)) assert.ok(mixtureAt(p, m).ok, `starting run with helper at ${mixtureAt(p, m).balance}`);
});

test('the report says so when the factor choice leaves no recipe, and proposes nothing', () => {
  const rnd = mulberry32(8);
  const tight = [{ key: 'frr', name: 'Flow rate ratio', unit: '', step: 0.1, lo: 2, hi: 5 }, lipid('ionizable_pct', 55, 60), lipid('peg_pct', 2, 3), lipid('sterol_pct', 45, 54)];
  const rows = Array.from({ length: 12 }, (_, i) => {
    const factors = { frr: 2 + rnd() * 3, ionizable_pct: 55 + rnd() * 5, peg_pct: 2 + rnd(), sterol_pct: 45 + rnd() * 9 };
    return { batchId: `B${i}`, experimentId: i < 6 ? 'E1' : 'E2', date: i < 6 ? '2026-01-01' : '2026-02-01', factors,
      values: { encapsulation_efficiency: 80 + 3 * factors.frr + rnd() } };
  });
  const out = analyse({ rows, space: tight, goals: [{ name: 'encapsulation_efficiency', goal: 'maximize', worst: 70, best: 96, weight: 1, on: true }], q: 2, baseClasses: mc3 });
  assert.equal(out.mixture.room, false);
  assert.ok(!out.suggestions, 'no suggestions');
  assert.ok(out.warnings.includes(out.mixture.reason), 'and the reason is among the warnings the screen shows');
});
