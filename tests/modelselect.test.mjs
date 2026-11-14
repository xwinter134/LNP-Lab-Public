// The fit summary, the AICc reduction and the Box-Cox check, on responses made from known surfaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitSummary, reduceTerms, boxCox, aicc, termsForResponses, REDUCED } from '../app/calc/modelselect.js';
import { boxTerms, balancedOptimum } from '../app/calc/balance.js';
import { buildDesign, randomizeRuns } from '../app/calc/doe.js';
import { ols, fTestP } from '../app/calc/stats.js';

let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
const names = ['A', 'B', 'C'];
const ccd = buildDesign({ designType: 'ccd_faced', model: 'quadratic', centerPoints: 4, responses: [{ name: 'y' }], factors: names.map((name) => ({ name, low: 0, high: 1 })) });

test('the fit summary suggests the order the response was made from', () => {
  const make = (f) => ccd.map((r) => ({ coded: r.coded, y: f(r.coded) + 0.5 * gauss() }));
  assert.equal(fitSummary(make((c) => 10 + 4 * c.A - 3 * c.B), names).suggested, 'linear');
  assert.equal(fitSummary(make((c) => 10 + 4 * c.A - 3 * c.B + 3 * c.A * c.B + 2 * c.B * c.C), names).suggested, 'interaction');
  assert.equal(fitSummary(make((c) => 10 + 4 * c.A + 5 * c.A * c.A - 4 * c.C * c.C), names).suggested, 'quadratic');
});

test('the sequential test is the extra-sum-of-squares F of each order over the one below', () => {
  const rows = ccd.map((r) => ({ coded: r.coded, y: 5 + r.coded.A + 0.8 * r.coded.A * r.coded.B + gauss() }));
  const fs = fitSummary(rows, names);
  const fitOf = (m) => ols(rows.map((r) => boxTerms(names, m).map((t) => t.f(r.coded))), rows.map((r) => r.y));
  const sse = (f) => f.residuals.reduce((a, e) => a + e * e, 0);
  const lin = fitOf('linear'), tfi = fitOf('interaction');
  const F = ((sse(lin) - sse(tfi)) / 3) / (sse(tfi) / (tfi.n - tfi.p));
  const row = fs.rows.find((r) => r.model === 'interaction');
  assert.ok(Math.abs(row.seqF - F) < 1e-9);
  assert.ok(Math.abs(row.seqP - fTestP(F, 3, tfi.n - tfi.p)) < 1e-12);
});

test('a two-level design cannot be offered squares', () => {
  const ff = buildDesign({ designType: 'full_factorial', model: 'interaction', centerPoints: 3, responses: [{ name: 'y' }], factors: names.map((name) => ({ name, low: 0, high: 1 })) });
  const fs = fitSummary(ff.map((r) => ({ coded: r.coded, y: r.coded.A + gauss() })), names, { levels: 2 });
  const q = fs.rows.find((r) => r.model === 'quadratic');
  assert.equal(q.aliased, true);
  assert.notEqual(fs.suggested, 'quadratic');
});

test('reduction drops the terms that are not there, lowers AICc, and keeps the model hierarchical', () => {
  const rows = ccd.map((r) => ({ coded: r.coded, y: 50 + 5 * r.coded.A - 3 * r.coded.B + 2 * r.coded.A * r.coded.B + 4 * r.coded.A ** 2 + 0.6 * gauss() }));
  const full = boxTerms(names, 'quadratic');
  const red = reduceTerms(rows, full);
  const kept = red.terms.map((t) => t.name);
  for (const must of ['Intercept', 'A', 'B', 'A x B', 'A^2']) assert.ok(kept.includes(must), `${must} kept: ${kept}`);
  assert.ok(red.aicc < red.start);
  assert.ok(red.removed.length >= 3);
  // hierarchy: every factor of a kept interaction or square is kept as a main effect
  for (const t of red.terms) if (t.kind !== 'main' && t.kind !== 'intercept') for (const f of t.of) assert.ok(kept.includes(f), `${t.name} without ${f}`);
  // and the terms stay in the model's own order
  assert.deepEqual(kept, full.filter((t) => kept.includes(t.name)).map((t) => t.name));
});

test('AICc is the small-sample formula', () => {
  const X = ccd.map((r) => [1, r.coded.A]);
  const fit = ols(X, ccd.map((r) => r.coded.A + gauss()));
  const n = fit.n, k = 3, s = fit.residuals.reduce((a, e) => a + e * e, 0);
  assert.ok(Math.abs(aicc(fit) - (n * Math.log(s / n) + 2 * k + (2 * k * (k + 1)) / (n - k - 1))) < 1e-12);
});

test('Box-Cox finds the log in a lognormal response and nothing in a normal one', () => {
  const terms = boxTerms(names, 'interaction');
  const X = ccd.map((r) => terms.map((t) => t.f(r.coded)));
  const logn = boxCox(X, ccd.map((r) => Math.exp(3 + 0.8 * r.coded.A + 0.5 * r.coded.B + 0.15 * gauss())));
  assert.equal(logn.advice.name, 'log');
  assert.ok(logn.ci[0] <= 0 && logn.ci[1] >= 0 && logn.ci[1] < 1);
  const flat = boxCox(X, ccd.map((r) => 100 + 10 * r.coded.A + 5 * r.coded.B + 2 * gauss()));
  assert.equal(flat.advice.name, 'none');
  assert.equal(boxCox(X, ccd.map((r, i) => (i === 0 ? -1 : 5))), null, 'not for a response that is not positive');
});

test('a reduced model gives each response its own terms, through to the balanced optimum', () => {
  const spec = { designType: 'ccd_faced', model: 'quadratic', centerPoints: 4, seed: 2,
    factors: [{ name: 'FRR', low: 2, high: 4 }, { name: 'flow_rate', low: 60, high: 120 }],
    responses: [{ name: 'particle_size_nm', goal: 'target', target: 90 }, { name: 'PDI', goal: 'minimize' }] };
  const runs = randomizeRuns(spec, buildDesign(spec));
  const vals = Object.fromEntries(runs.map((r) => [r.run_id, {
    particle_size_nm: 100 - 8 * r.coded.FRR + 5 * r.coded.FRR ** 2 + gauss(),
    PDI: 0.15 + 0.03 * r.coded.flow_rate + 0.005 * gauss() }]));
  const plan = termsForResponses(spec, runs, vals, REDUCED);
  const size = plan.of.particle_size_nm.terms.map((t) => t.name), pdi = plan.of.PDI.terms.map((t) => t.name);
  assert.ok(size.includes('FRR^2') && !size.includes('flow_rate^2'), size.join());
  assert.ok(pdi.includes('flow_rate') && !pdi.includes('FRR^2'), pdi.join());
  const b = balancedOptimum(spec, runs, vals, { model: spec.model, termsFor: (n) => plan.of[n].terms });
  assert.deepEqual(b.terms.PDI.map((t) => t.name), pdi);
  assert.equal(b.fits.PDI.p, pdi.length);
  // the design's own model is the same for every response
  const same = termsForResponses(spec, runs, vals, 'quadratic');
  assert.equal(same.of.PDI.terms, same.of.particle_size_nm.terms);
});
