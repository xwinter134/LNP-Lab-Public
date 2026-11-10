import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anova, lackOfFitSentence } from '../app/calc/anova.js';
import { ols, fTestP } from '../app/calc/stats.js';
import { boxTerms } from '../app/calc/balance.js';

// independent: normal equations by Gauss-Jordan on an augmented matrix, no code shared with stats.js
function lsq(X, y) {
  const p = X[0].length, A = Array.from({ length: p }, (_, i) => [...Array.from({ length: p }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)), X.reduce((s, r, k) => s + r[i] * y[k], 0)]);
  for (let c = 0; c < p; c++) { const d = A[c][c]; for (let k = 0; k <= p; k++) A[c][k] /= d; for (let r = 0; r < p; r++) if (r !== c) { const f = A[r][c]; for (let k = 0; k <= p; k++) A[r][k] -= f * A[c][k]; } }
  return A.map((r) => r[p]);
}
const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) < t, `${a} vs ${b}`);

const names = ['A', 'B'];
const pts = [[-1, -1, 10.2], [1, -1, 14.1], [-1, 1, 11.5], [1, 1, 19.8], [0, 0, 13.0], [0, 0, 13.6], [0, 0, 12.7]];
const runs = pts.map(([A, B]) => ({ coded: { A, B } }));
const y = pts.map((p) => p[2]);
const terms = boxTerms(names, 'interaction');
const X = runs.map((r) => terms.map((t) => t.f(r.coded)));
const fit = ols(X, y);
const t = anova(fit, runs, terms);
const row = (id) => t.rows.find((r) => r.id === id);

test('anova: sums of squares match an independent fit and add up', () => {
  const b = lsq(X, y), yh = X.map((r) => r.reduce((s, v, i) => s + v * b[i], 0));
  const my = y.reduce((a, c) => a + c) / y.length;
  const sse = y.reduce((s, v, i) => s + (v - yh[i]) ** 2, 0), sst = y.reduce((s, v) => s + (v - my) ** 2, 0);
  near(row('residual').ss, sse); near(row('total').ss, sst); near(row('model').ss, sst - sse);
  assert.equal(row('model').df, 3); assert.equal(row('residual').df, 3); assert.equal(row('total').df, 6);
  near(row('model').F, (row('model').ss / 3) / (sse / 3));
});

test('anova: pure error from the three centre points, lack of fit is the remainder', () => {
  const c = [13.0, 13.6, 12.7], m = 39.3 / 3, pe = c.reduce((s, v) => s + (v - m) ** 2, 0);
  near(row('pe').ss, pe); assert.equal(row('pe').df, 2);
  near(row('lof').ss, row('residual').ss - pe); assert.equal(row('lof').df, 1);
  near(row('lof').F, row('lof').ss / (pe / 2));
  near(row('lof').p, fTestP(row('lof').F, 1, 2));
  assert.ok(['significant', 'none'].includes(t.lackOfFit.state));
});

test('anova: no replicates means lack of fit is not testable', () => {
  const r4 = runs.slice(0, 4), f4 = ols(r4.map((r) => boxTerms(names, 'linear').map((tt) => tt.f(r.coded))), y.slice(0, 4));
  const a = anova(f4, r4, boxTerms(names, 'linear'));
  assert.equal(a.lackOfFit.state, 'untestable-replicates');
  assert.ok(!a.rows.some((r) => r.id === 'lof'));
  assert.match(lackOfFitSentence(a.lackOfFit), /add centre points/);
});

test('VIF is 1 for an orthogonal 2^2 + centre design and matches 1/(1-R2) when columns correlate', () => {
  for (const v of t.vif) near(v.vif, 1, 1e-9);
  // 5 points, x and x^2 over {-1,0,1,2,3}: VIF = 1/(1-r^2) with r the correlation of x and x^2
  const xs = [-1, 0, 1, 2, 3], r = (() => { const q = xs.map((x) => x * x), mx = 1, mq = 3.0; let a = 0, b = 0, c = 0; xs.forEach((x, i) => { a += (x - mx) * (q[i] - mq); b += (x - mx) ** 2; c += (q[i] - mq) ** 2; }); return a / Math.sqrt(b * c); })();
  const rs = xs.map((x) => ({ coded: { A: x } })), tq = boxTerms(['A'], 'quadratic'), yy = [1, 2.5, 3, 5.5, 9];
  const f = ols(rs.map((q) => tq.map((tt) => tt.f(q.coded))), yy);
  const a = anova(f, rs, tq);
  near(a.vif[0].vif, 1 / (1 - r * r), 1e-9); near(a.vif[1].vif, 1 / (1 - r * r), 1e-9);
});

test('scaled leverage max is max(h) * n / p', () => {
  near(t.leverage.scaledMax, Math.max(...fit.leverage) * 7 / 4);
  near(fit.leverage.reduce((a, b) => a + b), 4, 1e-9); // trace of the hat matrix = p
});

test('F cdf against a table value: F(3,10) = 3.708 gives p = 0.05; F(1,2)=18.51 gives 0.05', () => {
  near(fTestP(3.7083, 3, 10), 0.05, 5e-4);
  near(fTestP(18.5128, 1, 2), 0.05, 5e-4);
});

test('the lack-of-fit sentence rounds p the way the table does (0.015, not 0.01)', () => {
  assert.match(lackOfFitSentence({ state: 'none', p: 0.015 }), /\(p 0\.015\)/);
  assert.match(lackOfFitSentence({ state: 'significant', p: 0.0004 }), /\(p < 0\.001\)/);
});
