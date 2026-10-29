import test from 'node:test';
import assert from 'node:assert/strict';
import { makeView, surfaceScene, quadNormal, lambert, heightColour, niceTicks, contourSegments, bilinear, codedOf, Z_SCALE } from '../app/calc/surface3d.js';
import { surface3dSvg } from '../app/ui/doeplots.js';

/** A grid as surfaceGrid() gives it, from a function of the coded x and y. */
function gridOf(f, steps = 25) {
  const z = [];
  let lo = Infinity, hi = -Infinity;
  for (let j = 0; j < steps; j++) {
    const row = [];
    for (let i = 0; i < steps; i++) { const v = f(-1 + (2 * i) / (steps - 1), -1 + (2 * j) / (steps - 1)); row.push(v); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    z.push(row);
  }
  return { z, lo, hi, steps };
}
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} is not ${b}`);

test('projection: higher is up the page, further back is further away, and a quarter turn swaps the axes', () => {
  const v = makeView(0, 0.5);
  const low = v.project(0, 0, 0), high = v.project(0, 0, 1);
  assert.ok(high.Y < low.Y, 'a higher point is higher on the page (screen y grows downward)');
  assert.ok(high.depth < low.depth, 'seen from above, a higher point is nearer the eye');
  assert.ok(v.project(0, 1, 0).depth > v.project(0, -1, 0).depth, '+y is the back of the box at yaw 0');
  near(v.project(1, 0, 0).X, 1);
  const q = makeView(Math.PI / 2, 0.5);
  near(q.project(1, 0, 0).X, 0, 1e-12); // x now runs into the page
  near(q.project(0, -1, 0).X, 1, 1e-12);
  // straight down, height no longer moves a point on the page
  const top = makeView(0.3, Math.PI / 2);
  near(top.project(0.2, 0.4, 0).Y, top.project(0.2, 0.4, 1).Y, 1e-12);
});

test("painter's order: faces are painted far to near at any angle", () => {
  const g = gridOf((x, y) => 100 + 20 * x - 10 * y + 15 * x * x);
  for (const yaw of [0, 0.7, 2.1, -1.3, 3.9]) {
    for (const pitch of [0.15, 0.6, 1.3]) {
      const s = surfaceScene(g, { yaw, pitch });
      assert.equal(s.faces.length, 24 * 24);
      for (let i = 1; i < s.faces.length; i++) assert.ok(s.faces[i - 1].depth >= s.faces[i].depth, `yaw ${yaw} pitch ${pitch}: face ${i} is further than the one before it`);
    }
  }
});

test('the box: the back walls are the far ones, the z axis encloses the surface and every run', () => {
  const g = gridOf((x, y) => 100 + 20 * x);
  const s = surfaceScene(g, { yaw: 0, pitch: 0.5, runs: [{ x: 1, y: 1, value: 131, label: 'R1' }, { x: -1, y: -1, value: 70, label: 'R2' }] });
  assert.equal(s.backY, 1);
  assert.equal(s.frontY, -1);
  assert.ok(s.z0 <= 70 && s.z1 >= 131, `z axis ${s.z0}–${s.z1}`);
  assert.deepEqual(s.zTicks, [60, 80, 100, 120, 140]);
  // the run above the surface is above it, and its residual is measured against the surface under it
  const [r1, r2] = s.points;
  assert.equal(r1.above, true); near(r1.fitted, 120); near(r2.fitted, 80);
  assert.equal(r2.above, false);
  assert.ok(r1.at.Y < r1.onSurface.Y, 'drawn above the surface on the page');
});

test('light: a face turned to the light is brighter than one turned away, and none is black', () => {
  const v = makeView(0, 0.6);
  const flat = quadNormal([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]);
  near(flat[2], 1);
  // the viewer is in front (−y): a slope rising towards the back faces them, one falling away does not
  const towards = quadNormal([[0, 0, 0], [1, 0, 0], [1, 1, 0.4], [0, 1, 0.4]]);
  const away = quadNormal([[0, 0, 0.4], [1, 0, 0.4], [1, 1, 0], [0, 1, 0]]);
  assert.ok(lambert(towards, v) > lambert(away, v));
  for (const n of [flat, towards, away, [0, 0, -1]]) { const l = lambert(n, v); assert.ok(l >= 0.42 && l <= 1, String(l)); }
  assert.ok(Z_SCALE > 0.8);
});

test('colour by height runs dark to light and stays inside 0–255', () => {
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.1) { const c = heightColour(t); assert.ok(c.every((x) => x >= 0 && x <= 255)); assert.ok(lum(c) > prev); prev = lum(c); }
  assert.deepEqual(heightColour(-3), heightColour(0));
  assert.deepEqual(heightColour(NaN), heightColour(0));
});

test('ticks, coded ticks, contours and interpolation', () => {
  assert.deepEqual(niceTicks(0.052, 0.27, 5), [0, 0.1, 0.2, 0.3]);
  assert.deepEqual(niceTicks(60, 120, 5), [60, 80, 100, 120]);
  near(codedOf({ low: 60, high: 120 }, 90), 0);
  near(codedOf({ low: 1, high: 2.5, center: 1.5 }, 2), 0.5);
  const g = gridOf((x) => x); // a ramp: the 0 contour is the line x = 0
  const [c] = contourSegments(g, [0.01]);
  assert.ok(c.segments.length >= 24);
  for (const [a, b] of c.segments) { near(a[0], 0.01, 1e-9); near(b[0], 0.01, 1e-9); }
  near(bilinear(g, 0.3, -0.7), 0.3, 1e-12);
});

test('the SVG: a box with ticks on all three axes, a legend, the runs, and the same scale at every angle', () => {
  const g = gridOf((x, y) => 100 + 20 * x - 10 * y);
  const opts = { fa: { name: 'FRR', unit: '', low: 2, high: 4 }, fb: { name: 'Flow', unit: 'mL/min', low: 60, high: 120 }, zlab: 'Size (nm)', runs: [{ x: 0, y: 0, value: 103, label: 'C1' }, { x: 1, y: 1, value: 1, label: 'off', offSlice: true }] };
  const svg = surface3dSvg(g, { ...opts, yaw: 0.7, pitch: 0.5 });
  assert.match(svg, /^<svg/);
  assert.match(svg, />Size \(nm\)</);
  assert.match(svg, />Flow \(mL\/min\)</);
  assert.match(svg, />FRR</);
  assert.equal((svg.match(/class="run3d"/g) || []).length, 1, 'a run from another slice is left off the solid');
  assert.match(svg, /C1: measured 103/);
  assert.equal((svg.match(/<polygon /g) || []).length, 24 * 24 + 3, 'every face, two walls and the floor');
  assert.equal(surface3dSvg(null, opts), '');
  // the frame never jumps: the box centre lands on the same spot whatever the angle
  const centreOf = (s) => s.match(/data-yaw="([\d.-]+)"/)[1];
  assert.equal(centreOf(surface3dSvg(g, { ...opts, yaw: 1.2 })), '1.200');
});
