// The tests between groups and the straight line through time (app/calc/stats.js), against values worked out
// by hand or published with their data: the textbook one-way ANOVA example and Welch's own worked examples.
// Where a p value has no closed form, the reference was computed independently, by integrating the t density
// numerically, not with the incomplete beta the app uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { linearFit, welchTest, anovaOneWay, holmSidak, pairwiseAfterAnova, fTestP } from '../app/calc/stats.js';
import { tCritical } from '../app/calc/diagnostics.js';

const close = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) < eps, `${msg} expected ${b}, got ${a}`);

test('Welch t test: two pairs whose p value has a closed form (df = 2)', () => {
  // [1, 3] and [5, 7]: both variances 2, so se = √(1 + 1) and df = (1 + 1)² / (1 + 1) = 2 exactly.
  // With two degrees of freedom the two-sided p is 1 − |t| / √(t² + 2).
  const w = welchTest([5, 7], [1, 3]);
  close(w.t, 4 / Math.SQRT2, 1e-12, 't');
  close(w.df, 2, 1e-12, 'df');
  close(w.p, 1 - w.t / Math.sqrt(w.t ** 2 + 2), 1e-9, 'p');
  close(w.p, 0.105573, 1e-6, 'p');
  assert.equal(w.diff, 4);
  assert.deepEqual(w.n, [2, 2]);
});

test('Welch t test: the unequal-variance worked example (t −1.57, df 9.9, p 0.149)', () => {
  const a = [17.2, 20.9, 22.6, 18.1, 21.7, 21.4, 23.5, 24.2, 14.7, 21.8];
  const b = [21.5, 22.8, 21.0, 23.0, 21.6, 23.6, 22.5, 20.7, 23.4, 21.8, 20.7, 21.7, 21.5, 22.5, 23.6, 21.5, 22.5, 23.5, 21.5, 21.8];
  const w = welchTest(a, b);
  close(w.t, -1.565434, 1e-5, 't');
  close(w.df, 9.904741, 1e-5, 'df');
  close(w.p, 0.148842, 1e-5, 'p');
});

test('Welch t test refuses what it cannot test: one value in a group, or no spread at all', () => {
  assert.equal(welchTest([1], [2, 3]), null);
  assert.equal(welchTest([2, 2], [2, 2]), null);
  assert.equal(welchTest([1, NaN], [2, 3]), null, 'a missing value is not a value');
  // six times 0.1 sums to 0.6000000000000001: the leftover variance is rounding, not a spread to divide by
  const same = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
  assert.equal(welchTest(same, same.slice(0, 3)), null);
  assert.equal(anovaOneWay([same, same.slice(0, 3), same.slice(0, 2)]), null);
});

test('one-way ANOVA: the textbook example, F(2, 15) = 9.26, p = 0.0024', () => {
  // Group means 5, 9 and 10 about a grand mean of 8: SSB = 6 · (9 + 1 + 4) = 84, SSW = 16 + 24 + 28 = 68.
  const groups = [[6, 8, 4, 5, 3, 4], [8, 12, 9, 11, 6, 8], [13, 9, 11, 8, 7, 12]];
  const a = anovaOneWay(groups);
  close(a.ssb, 84, 1e-9, 'SSB'); close(a.ssw, 68, 1e-9, 'SSW');
  assert.equal(a.df1, 2); assert.equal(a.df2, 15);
  close(a.F, 42 / (68 / 15), 1e-9, 'F');
  // With two numerator degrees of freedom the F tail is closed form: (df2 / (df2 + 2F))^(df2/2).
  close(a.p, (15 / (15 + 2 * a.F)) ** 7.5, 1e-9, 'p');
  close(a.p, 0.0023988, 1e-6, 'p');
  assert.deepEqual(a.means, [5, 9, 10]);
});

test('pairs after the ANOVA: t on the pooled variance, Holm–Šídák adjusted', () => {
  const groups = [[6, 8, 4, 5, 3, 4], [8, 12, 9, 11, 6, 8], [13, 9, 11, 8, 7, 12]];
  const pairs = pairwiseAfterAnova(groups, anovaOneWay(groups));
  assert.deepEqual(pairs.map((x) => [x.i, x.j]), [[0, 1], [0, 2], [1, 2]]);
  // se of a difference = √(MSW · (1/6 + 1/6)) = √(68/15 / 3)
  const se = Math.sqrt((68 / 15) / 3);
  close(pairs[0].t, -4 / se, 1e-9); close(pairs[1].t, -5 / se, 1e-9); close(pairs[2].t, -1 / se, 1e-9);
  close(pairs[0].p, 0.0053398, 1e-6); close(pairs[1].p, 0.0010109, 1e-6); close(pairs[2].p, 0.4286623, 1e-6);
  // smallest against 3 comparisons, the next against 2, the last against 1
  close(pairs[1].pAdj, 1 - (1 - pairs[1].p) ** 3, 1e-12); close(pairs[1].pAdj, 0.0030295, 1e-6);
  close(pairs[0].pAdj, 0.0106512, 1e-6);
  close(pairs[2].pAdj, 0.4286623, 1e-6);
});

test('Holm–Šídák never lets a larger p value come out smaller than the one before it', () => {
  const adj = holmSidak([0.04, 0.01, 0.03]);
  close(adj[1], 1 - 0.99 ** 3, 1e-12);
  close(adj[2], 1 - 0.97 ** 2, 1e-12);
  close(adj[0], adj[2], 1e-12, 'raw 0.04 against one comparison would be 0.04, below 0.0591 before it');
  assert.deepEqual(holmSidak([]), []);
});

test('F tail: no evidence at F = 0, nothing for impossible degrees of freedom', () => {
  assert.equal(fTestP(0, 2, 10), 1);
  assert.equal(fTestP(3, 0, 10), null);
  close(fTestP(4, 2, 10), (10 / 18) ** 5, 1e-9);
});

test('a straight line through five timepoints, worked by hand', () => {
  // x 0…28 by 7, Sxx = 490; y 80, 82, 85, 86, 90 about 84.6, Sxy = 168: slope 168/490, intercept 79.8.
  // Residuals 0.2, −0.2, 0.4, −1.0, 0.6: SSE 1.6 on 3 df, se(slope) = √(1.6/3/490).
  const fit = linearFit([0, 7, 14, 21, 28], [80, 82, 85, 86, 90]);
  close(fit.slope, 168 / 490, 1e-12, 'slope');
  close(fit.intercept, 79.8, 1e-9, 'intercept');
  assert.equal(fit.df, 3); assert.equal(fit.n, 5);
  close(fit.seSlope, Math.sqrt(1.6 / 3 / 490), 1e-12, 'se');
  close(fit.r2, 1 - 1.6 / 59.2, 1e-12, 'r²');
  assert.equal(fit.xMin, 0); assert.equal(fit.xMax, 28);
  close(tCritical(3), 3.182446, 1e-5, 'the t table value for 3 df');
  assert.equal(linearFit([7, 7], [1, 2]), null, 'one x value is not a line');
  assert.equal(linearFit([0, 7], [80, 84]).seSlope, null, 'two points leave no degrees of freedom for an error');
});
