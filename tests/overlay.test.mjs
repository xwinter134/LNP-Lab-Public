// The sweet-spot overlay: which points pass, how the three readings nest, and the contour lines around them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSpecs, overlayGrid, overlaySentence, isoSegments } from '../app/calc/overlay.js';
import { boxTerms } from '../app/calc/balance.js';
import { buildDesign } from '../app/calc/doe.js';
import { ols } from '../app/calc/stats.js';

let seed = 5;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());

const names = ['FRR', 'flow_rate'];
const runs = buildDesign({ designType: 'ccd_faced', model: 'quadratic', centerPoints: 5, responses: [{ name: 'y' }], factors: names.map((name) => ({ name, low: 0, high: 1 })) });
const terms = boxTerms(names, 'quadratic');
const fitOf = (f, sd) => ols(runs.map((r) => terms.map((t) => t.f(r.coded))), runs.map((r) => f(r.coded) + sd * gauss()));
// size falls with FRR, PDI rises with flow
const fits = { particle_size_nm: fitOf((c) => 100 - 20 * c.FRR, 2), PDI: fitOf((c) => 0.18 + 0.04 * c.flow_rate, 0.005) };
const specs = [{ name: 'particle_size_nm', lo: null, hi: 100 }, { name: 'PDI', lo: null, hi: 0.2 }];

test('the QC limits become the default windows', () => {
  const s = defaultSpecs([{ name: 'particle_size_nm' }, { name: 'PDI' }, { name: 'encapsulation_efficiency' }, { name: 'zeta_potential_mV' }],
    { zaveMin: 40, zaveMax: 150, pdiMax: 0.2, eeMin: 85 });
  assert.deepEqual(s, [{ name: 'particle_size_nm', lo: 40, hi: 150 }, { name: 'PDI', lo: null, hi: 0.2 }, { name: 'encapsulation_efficiency', lo: 85, hi: null }]);
});

test('the sweet spot is where both models pass, and it sits where the surfaces say', () => {
  const g = overlayGrid({ fits, termsOf: () => terms, names, a: 'FRR', b: 'flow_rate', specs, interval: 'mean', steps: 21 });
  // size < 100 needs FRR > 0, PDI < 0.2 needs flow < 0.5: about the quadrant FRR > 0, flow < 0.5
  assert.ok(g.share > 0.25 && g.share < 0.5, `share ${g.share}`);
  assert.equal(g.ok[0][20], true, 'low flow, high FRR passes');
  assert.equal(g.ok[20][0], false, 'high flow, low FRR fails');
  assert.deepEqual(g.fails[20][0].sort(), ['PDI', 'particle_size_nm']);
  assert.match(overlaySentence(g, { label: (n) => n }), /^\d+ % of this slice is the sweet spot, where the predicted value meets every specification; /);
});

test('the PI region sits inside the CI region, which sits inside the mean region', () => {
  const g = (interval) => overlayGrid({ fits, termsOf: () => terms, names, a: 'FRR', b: 'flow_rate', specs, interval, steps: 21 });
  const m = g('mean'), c = g('ci'), p = g('pi');
  assert.ok(p.share < c.share && c.share < m.share, `${p.share} ${c.share} ${m.share}`);
  for (let j = 0; j < 21; j++) for (let i = 0; i < 21; i++) {
    if (p.ok[j][i]) assert.ok(c.ok[j][i]);
    if (c.ok[j][i]) assert.ok(m.ok[j][i]);
  }
});

test('a response without a fit is left out and said to be', () => {
  const g = overlayGrid({ fits, termsOf: () => terms, names, a: 'FRR', b: 'flow_rate', specs: [...specs, { name: 'encapsulation_efficiency', lo: 85, hi: null }], steps: 5 });
  assert.deepEqual(g.missing, ['encapsulation_efficiency']);
  const none = overlayGrid({ fits, termsOf: () => terms, names, a: 'FRR', b: 'flow_rate', specs: [{ name: 'particle_size_nm', lo: null, hi: 10 }], steps: 5 });
  assert.equal(none.share, 0);
  assert.match(overlaySentence(none), /^Nowhere in this slice/);
});

test('the iso-line of a plane is a straight line at the right place', () => {
  // z = i: the level 2.5 crosses every row between columns 2 and 3
  const z = Array.from({ length: 5 }, () => [0, 1, 2, 3, 4]);
  const segs = isoSegments(z, 2.5);
  assert.equal(segs.length, 4);
  for (const [p, q] of segs) { assert.ok(Math.abs(p[0] - 2.5) < 1e-12 && Math.abs(q[0] - 2.5) < 1e-12); }
  assert.equal(isoSegments(z, 10).length, 0);
});
