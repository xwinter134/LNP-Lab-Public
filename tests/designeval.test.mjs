// Evaluating a design before it is run: power, FDS, correlation, aliases and D-efficiency, each against a
// number known independently (a simulation, a textbook design property).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDesign, noncentralFUpper, designEvalSentences, inverseXtX } from '../app/calc/designeval.js';
import { buildDesign } from '../app/calc/doe.js';
import { boxTerms } from '../app/calc/balance.js';
import { ols } from '../app/calc/stats.js';
import { fQuantile } from '../app/calc/diagnostics.js';

let seed = 17;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
const factors = (k) => Array.from({ length: k }, (_, i) => ({ name: `F${i}`, low: 0, high: 1 }));
const design = (designType, k, centerPoints = 0) => buildDesign({ designType, model: 'linear', centerPoints, responses: [{ name: 'y' }], factors: factors(k) });

test('the noncentral F tail matches its central case and a simulation', () => {
  // lambda 0 is the central F
  const f = fQuantile(0.05, 1, 10);
  assert.ok(Math.abs(noncentralFUpper(f, 1, 10, 0) - 0.05) < 1e-6);
  // simulate t² with a shifted normal: t = (z + √λ) / √(χ²/df)
  const df = 8, lambda = 6, N = 20000;
  let hit = 0;
  const fc = fQuantile(0.05, 1, df);
  for (let s = 0; s < N; s++) {
    const z = gauss() + Math.sqrt(lambda);
    let chi = 0; for (let i = 0; i < df; i++) chi += gauss() ** 2;
    if ((z * z) / (chi / df) > fc) hit++;
  }
  assert.ok(Math.abs(noncentralFUpper(fc, 1, df, lambda) - hit / N) < 0.015, `${noncentralFUpper(fc, 1, df, lambda)} vs ${hit / N}`);
});

test('power matches a simulation of the fitted design', () => {
  const runs = design('full_factorial', 3, 3);
  const ev = evaluateDesign(runs, ['F0', 'F1', 'F2'], 'linear', { snr: 2 });
  const terms = boxTerms(['F0', 'F1', 'F2'], 'linear');
  const X = runs.map((r) => terms.map((t) => t.f(r.coded)));
  let found = 0;
  const N = 3000;
  for (let s = 0; s < N; s++) {
    const fit = ols(X, runs.map((r) => 1 * r.coded.F0 + gauss())); // coefficient 1 SD = 2 SD across the range
    if (fit.pValues[1] < 0.05) found++;
  }
  const main = ev.power.find((x) => x.term === 'F0').power;
  assert.ok(Math.abs(main - found / N) < 0.03, `${main} vs ${found / N}`);
});

test('a full two-level factorial is D-efficient and orthogonal for the main effects', () => {
  const ev = evaluateDesign(design('full_factorial', 3), ['F0', 'F1', 'F2'], 'linear');
  assert.ok(Math.abs(ev.dEfficiency - 1) < 1e-9, String(ev.dEfficiency));
  assert.ok(ev.maxCorrelation < 1e-9);
  assert.ok(ev.vif.every((v) => Math.abs(v.vif - 1) < 1e-9));
  // its main effects are not aliased with any two-factor interaction
  assert.equal(ev.aliases.length, 0);
});

test('a 12-run Plackett-Burman carries a third of the interactions on each main effect', () => {
  const runs = design('plackett_burman', 8);
  assert.equal(runs.length, 12);
  const ev = evaluateDesign(runs, factors(8).map((f) => f.name), 'linear');
  assert.ok(ev.aliases.length > 0);
  assert.ok(ev.aliases.every((a) => Math.abs(Math.abs(a.coef) - 1 / 3) < 1e-9), ev.aliases.map((a) => a.coef).join());
  assert.match(designEvalSentences(ev).join(' '), /lean on the ones in it/);
  // with 5 factors the design has 8 runs, a quarter fraction: main effects fully aliased with interactions
  const eight = evaluateDesign(design('plackett_burman', 5), factors(5).map((f) => f.name), 'linear');
  assert.ok(eight.aliases.every((a) => Math.abs(Math.abs(a.coef) - 1) < 1e-9));
  assert.match(designEvalSentences(eight).join(' '), /fully aliased/);
});

test('FDS rises with centre points and runs, and an unfittable design says why', () => {
  const ccd = (cp) => buildDesign({ designType: 'ccd_faced', model: 'quadratic', centerPoints: cp, responses: [{ name: 'y' }], factors: factors(3) });
  const a = evaluateDesign(ccd(1), ['F0', 'F1', 'F2'], 'quadratic', { samples: 800 });
  const b = evaluateDesign(ccd(6), ['F0', 'F1', 'F2'], 'quadratic', { samples: 800 });
  assert.ok(b.fds >= a.fds, `${a.fds} → ${b.fds}`);
  assert.ok(b.fdsCurve.every((q, i, xs) => i === 0 || q.halfWidth >= xs[i - 1].halfWidth), 'the curve rises');
  const tiny = evaluateDesign(design('full_factorial', 2), ['F0', 'F1'], 'quadratic');
  assert.equal(tiny.ok, false);
  assert.match(designEvalSentences(tiny)[0], /cannot/);
});

test('the inverse of a small X\'X is exact', () => {
  const X = [[1, -1], [1, 1], [1, 0]];
  const inv = inverseXtX(X);
  assert.deepEqual(inv.map((r) => r.map((v) => Math.round(v * 1e12) / 1e12)), [[1 / 3, 0].map((v) => Math.round(v * 1e12) / 1e12), [0, 0.5]]);
});
