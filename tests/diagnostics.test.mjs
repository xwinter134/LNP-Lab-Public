// The numbers behind the DoE diagnostic plots, and the plots' own refusal to draw what they cannot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tCritical, invNorm, paretoEffects, residualPoints, qqPoints, qqLine, surfaceGrid, effectLines, predictAt } from '../app/calc/diagnostics.js';
import { paretoSvg, residualSvg, qqSvg, obsPredSvg, surfaceSvg, effectSvg } from '../app/ui/doeplots.js';
import { ols } from '../app/calc/stats.js';

test('the significance line is where a table of t says it is', () => {
  // the values anyone would look up: two-sided, alpha 0.05
  assert.ok(Math.abs(tCritical(5) - 2.571) < 0.002, `df 5 -> ${tCritical(5)}`);
  assert.ok(Math.abs(tCritical(10) - 2.228) < 0.002, `df 10 -> ${tCritical(10)}`);
  assert.ok(Math.abs(tCritical(30) - 2.042) < 0.002, `df 30 -> ${tCritical(30)}`);
  assert.ok(tCritical(8, 0.01) > tCritical(8, 0.05), 'a stricter alpha sits further out');
  assert.equal(tCritical(0), null, 'no residual degrees of freedom, no line to draw');
});

test('the normal quantiles are the normal quantiles', () => {
  assert.ok(Math.abs(invNorm(0.975) - 1.959964) < 1e-4);
  assert.ok(Math.abs(invNorm(0.5)) < 1e-9);
  assert.ok(Math.abs(invNorm(0.025) + 1.959964) < 1e-4);
  assert.ok(Number.isNaN(invNorm(0)) && Number.isNaN(invNorm(1)), 'the ends are not numbers, and are not faked');
});

/* A tiny design with a known answer: y = 10 + 3a - 2b + 1.5ab, measured without noise. */
const names = ['a', 'b'];
const terms = [
  { name: 'Intercept', f: () => 1 }, { name: 'a', f: (c) => c.a }, { name: 'b', f: (c) => c.b },
  { name: 'a x b', f: (c) => c.a * c.b },
];
const coded = [{ a: -1, b: -1 }, { a: 1, b: -1 }, { a: -1, b: 1 }, { a: 1, b: 1 }, { a: 0, b: 0 }, { a: 0, b: 0 }, { a: 0, b: 0 }];
const yTrue = (c) => 10 + 3 * c.a - 2 * c.b + 1.5 * c.a * c.b;
const noise = [0.2, -0.1, 0.15, -0.25, 0.05, -0.05, 0.1];
const y = coded.map((c, i) => yTrue(c) + noise[i]);
const fit = ols(coded.map((c) => terms.map((t) => t.f(c))), y);
const rows = coded.map((c, i) => ({ label: `R${i + 1}`, pointType: c.a === 0 && c.b === 0 ? 'center' : 'factorial' }));

test('the Pareto ranks terms by size against their own error, and leaves the mean out of it', () => {
  const { effects, tCrit, df } = paretoEffects(fit, terms);
  assert.equal(df, 3);
  assert.ok(!effects.some((e) => e.name === 'Intercept'), 'the grand mean is not an effect');
  assert.deepEqual(effects.map((e) => e.name), ['a', 'b', 'a x b'], 'sorted by |t|, which here is sorted by size');
  assert.ok(Math.abs(effects[0].coef - 3) < 0.2, `a should come back near 3, got ${effects[0].coef}`);
  assert.ok(effects.every((e) => e.significant), 'with this little noise every term clears the line');
  assert.ok(tCrit > 3 && tCrit < 3.3, `t critical for 3 df is 3.182, got ${tCrit}`);
});

test('a residual is measured minus fitted, and the studentised one accounts for leverage', () => {
  const pts = residualPoints(fit, rows);
  assert.equal(pts.length, 7);
  for (const p of pts) assert.ok(Math.abs(p.measured - (p.fitted + p.resid)) < 1e-9, 'the three numbers agree');
  const corner = pts[0], centre = pts[4];
  assert.ok(corner.leverage > centre.leverage, 'a corner run constrains the fit more than a centre point does');
  // same raw residual, different leverage, so the studentised values must differ
  assert.ok(Math.abs(corner.student) !== Math.abs(centre.student));
  assert.ok(pts.every((p) => Math.abs(p.student) < 4), 'nothing here is an outlier');
});

test('the normal plot is sorted residuals against the quantiles they should have had', () => {
  const pts = qqPoints(fit.residuals);
  assert.equal(pts.length, 7);
  assert.deepEqual(pts.map((p) => p.sample), [...pts.map((p) => p.sample)].sort((a, b) => a - b), 'sorted');
  assert.ok(pts[0].theoretical < 0 && pts[6].theoretical > 0, 'the quantiles straddle zero');
  assert.ok(Math.abs(pts[3].theoretical) < 1e-9, 'the middle point of an odd count sits at zero');
  const line = qqLine(pts);
  assert.ok(line.slope > 0, 'a positive slope, because the residuals are in increasing order');
  assert.equal(qqPoints([1, 2]).length, 0, 'two residuals are not a distribution');
});

test('the surface is the fitted model, evaluated', () => {
  const g = surfaceGrid(fit, terms, names, { steps: 11 });
  assert.equal(g.z.length, 11);
  assert.equal(g.z[0].length, 11);
  // corners of the grid are the corners of the design, so they must match the model there
  assert.ok(Math.abs(g.z[0][0] - predictAt(fit, terms, { a: -1, b: -1 })) < 1e-9);
  assert.ok(Math.abs(g.z[10][10] - predictAt(fit, terms, { a: 1, b: 1 })) < 1e-9);
  assert.ok(g.hi > g.lo);
  assert.equal(surfaceGrid(fit, terms, ['a']), null, 'one factor is not a surface');
  // a third factor is held, and holding it somewhere else gives a different slice
  const t3 = [...terms, { name: 'c', f: (c) => c.c }];
  const f3 = { ...fit, beta: [...fit.beta, 5] };
  const mid = surfaceGrid(f3, t3, ['a', 'b', 'c'], { steps: 5 });
  const high = surfaceGrid(f3, t3, ['a', 'b', 'c'], { steps: 5, base: { c: 1 } });
  assert.ok(Math.abs(high.z[0][0] - mid.z[0][0] - 5) < 1e-9, 'the held factor moves the whole slice');
});

test('effect lines are parallel exactly when the terms say there is no interaction', () => {
  const noInt = { ...fit, beta: [10, 3, -2, 0] };
  const lines = effectLines(noInt, terms, names, 'a', 'b');
  const gaps = lines[0].points.map((p, i) => lines[2].points[i].y - p.y);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) < 1e-9, 'with no interaction term the lines never converge');

  const withInt = effectLines(fit, terms, names, 'a', 'b');
  const g2 = withInt[0].points.map((p, i) => withInt[2].points[i].y - p.y);
  assert.ok(Math.max(...g2) - Math.min(...g2) > 1, 'with one, they fan out');
  assert.equal(effectLines(fit, terms, names, 'a').length, 1, 'a main effect is one line');
});

test('a plot that has nothing to show draws nothing rather than an empty frame', () => {
  assert.equal(residualSvg([]), '');
  assert.equal(qqSvg([]), '');
  assert.equal(obsPredSvg([{ fitted: 1, measured: 1 }]), '');
  assert.equal(paretoSvg({ effects: [], tCrit: null }), '');
  assert.equal(surfaceSvg(null, {}), '');
  assert.equal(effectSvg([]), '');
});

test('the plots draw the things their captions promise', () => {
  const pareto = paretoSvg(paretoEffects(fit, terms));
  assert.ok(pareto.includes('<svg') && pareto.includes('p 0.05'), 'the significance line is labelled');
  assert.ok((pareto.match(/<rect/g) || []).length === 3, 'one bar per term, intercept excluded');

  const pts = residualPoints(fit, rows);
  assert.ok(residualSvg(pts).includes('studentised residual'));
  assert.ok(obsPredSvg(pts).includes('predicted') && obsPredSvg(pts).includes('measured'));

  const spec = { factors: [{ name: 'a', unit: 'mL/min', low: 60, center: '', high: 120 }, { name: 'b', unit: '', low: 1, center: '', high: 3 }] };
  const sfc = surfaceSvg(surfaceGrid(fit, terms, names), { fa: spec.factors[0], fb: spec.factors[1], runs: [{ x: 1, y: -1, label: 'R2' }], goal: { goal: 'minimize' } });
  assert.ok(sfc.includes('dark is lower'), 'the colour direction follows the goal');
  assert.ok(sfc.includes('60') && sfc.includes('120'), 'the axis is in the factor\'s own units, not coded');
  assert.ok(sfc.includes('predicted'), 'and it says what range the colours cover');
  const target = surfaceSvg(surfaceGrid(fit, terms, names), { fa: spec.factors[0], fb: spec.factors[1], goal: { goal: 'target', target: 9 } });
  assert.ok(target.includes('nearer 9'), 'a target goal shades by distance from the target');

  const eff = effectSvg(effectLines(fit, terms, names, 'a'), { factor: 'a', response: 'Size (nm)', spec });
  assert.ok(eff.includes('a (mL/min)') && eff.includes('60') && eff.includes('120'), 'the effect axis is in real units too');
});

test('a PDI-sized plot labels its numbers so they can be told apart, and never as "-0"', () => {
  // A PDI coefficient is a few thousandths and its residuals smaller still: two fixed decimals read them as
  // "-0.01", "0" and "-0", and an axis from 0.078 to 0.090 as "0.08, 0.08".
  const pareto = paretoSvg({ effects: [{ name: 'flow', coef: -0.0052, t: 4, abs: 4, significant: true }, { name: 'FRR', coef: -0.0004, t: 0.3, abs: 0.3, significant: false }], tCrit: 2.3 });
  assert.ok(pareto.includes('>−0.0052<') && pareto.includes('>−0.0004<'), 'coefficients to their significant figures');
  const qq = qqPoints([-0.011, -0.006, -0.003, -0.001, 0.0005, 0.002, 0.004, 0.007, 0.010]);
  const svg = qqSvg(qq, qqLine(qq));
  assert.ok(!/>[-−]0</.test(svg), 'no label reads minus nought');
  const yTicks = [...svg.matchAll(/<text x="46" [^>]*text-anchor="end">([^<]+)</g)].map((m) => m[1]); // the y axis sits at x 46
  assert.equal(new Set(yTicks).size, 3, `three different labels on the residual axis: ${yTicks.join(', ')}`);
  // and a size axis is not quoted to hundredths of a nanometre
  const big = obsPredSvg([{ fitted: 77.84, measured: 78.1 }, { fitted: 112.01, measured: 111.2 }, { fitted: 146.18, measured: 146.9 }]);
  assert.ok(!/\d\.\d\d</.test(big), 'whole nanometres on a 70 nm span');
});
