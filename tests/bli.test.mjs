// Automatic BLI image analysis (spec 8.7): the building blocks, a synthetic scene with known answers, and the
// CC0 fixture folder against its published per-mouse flux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTiff } from '../app/calc/tiff.js';
import { clickMeta, parseCalibration } from '../app/calc/ivis.js';
import { otsu, dilate, erode, fillHoles, components, encodeMask, decodeMask, longAxis, holderRows, analyseClick, moveLiver, logCorrection, METHODS, DEFAULT_METHOD, ALGORITHM } from '../app/calc/bli.js';

test('Otsu splits two clear classes between them', () => {
  const v = [...Array(500).fill(10), ...Array(300).fill(50)].map((x, i) => x + (i % 5));
  const t = otsu(v);
  assert.ok(t > 14 && t < 50, `threshold ${t}`);
});

test('dilation, erosion, holes and components on a small mask', () => {
  const w = 12, h = 8, m = new Uint8Array(w * h);
  for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) m[y * w + x] = 1;
  m[3 * w + 3] = 0; // a hole
  m[2 * w + 9] = 1; // a second object
  const filled = fillHoles(m, w, h);
  assert.equal(filled[3 * w + 3], 1);
  assert.equal(erode(filled, w, h, 1).reduce((a, b) => a + b, 0), 9, 'a 5 × 5 square eroded by 1 is 3 × 3');
  assert.ok(dilate(m, w, h, 1)[0] === 1);
  const { comps } = components(filled, w, h);
  assert.equal(comps.length, 2);
  assert.deepEqual([comps[0].area, comps[1].area], [25, 1]);
});

test('a mask survives its run-length encoding', () => {
  const w = 10, px = [11, 12, 13, 22, 23, 35];
  const box = { x0: 1, y0: 1, x1: 5, y1: 3 };
  const back = decodeMask(encodeMask(px, w, box), box);
  const got = [];
  back.forEach((v, i) => { if (v) got.push((box.y0 + Math.floor(i / 5)) * w + box.x0 + (i % 5)); });
  assert.deepEqual(got, px);
});

test('the long axis of an upright ellipse is vertical, its length about the ellipse height', () => {
  const w = 60, px = [];
  for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) if (((x - 30) / 8) ** 2 + ((y - 30) / 25) ** 2 <= 1) px.push(y * w + x);
  const a = longAxis(px, w);
  assert.ok(Math.abs(Math.abs(a.uy) - 1) < 0.01);
  assert.ok(Math.abs(a.length - 51) <= 2);
  assert.ok(Math.abs(a.width - 17) <= 2);
});

test('the holder: a wide band at the top is found, the rows of mice below it are not', () => {
  const w = 50, h = 60, m = new Uint8Array(w * h);
  for (let y = 2; y < 8; y++) for (let x = 2; x < 48; x++) m[y * w + x] = 1; // 92 % wide
  for (let y = 10; y < 40; y++) for (let x = 5; x < 20; x++) m[y * w + x] = 1; // a mouse, 30 % wide
  assert.equal(holderRows(m, w, h), 8);
  assert.equal(holderRows(new Uint8Array(w * h), w, h), 0);
});

/**
 * A synthetic click: a grey stage with a brightness gradient (vignetting), three dark "mice" (ellipses of fur
 * with a bright shaved patch, each with a thin tail below), and luminescent sources of known strength.
 */
function scene({ touching = false } = {}) {
  const W = 240, H = 240, pw = 480; // luminescent 240 at binning 8, photograph 480 at binning 4, FOV 21.8 cm
  const photo = new Uint16Array(pw * pw);
  const xs = touching ? [150, 240, 330] : [110, 240, 370];
  for (let y = 0; y < pw; y++) for (let x = 0; x < pw; x++) {
    let v = 420 * (1 - 0.25 * (((x - 240) / 240) ** 2 + ((y - 240) / 240) ** 2)) + ((x * 31 + y * 17) % 11) - 5;
    for (const cx of xs) {
      const e = ((x - cx) / 42) ** 2 + ((y - 220) / 95) ** 2;
      if (e <= 1) v = e < 0.12 ? 1500 : 230 + ((x + y) % 7);
      if (Math.abs(x - cx) <= 3 && y > 315 && y < 430) v = 1300; // a tail
    }
    photo[y * pw + x] = Math.max(0, Math.round(v));
  }
  const lum = new Uint16Array(W * H).fill(750);
  const strengths = [200, 1000, 5000]; // counts per luminescent pixel at the peak
  xs.forEach((cx, k) => {
    const lx = cx / 2, ly = 200 / 2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) lum[y * W + x] += Math.round(strengths[k] * Math.exp(-(((x - lx) ** 2 + (y - ly) ** 2) / (2 * 4 ** 2))));
  });
  const meta = { clickNumber: 'SYN', luminescent: { file: 'luminescent.TIF', binning: 8, exposure_s: 10, fNumber: 1, fov_cm: 21.8, readBias: 750, units: 'counts' }, photograph: { file: 'photograph.TIF', binning: 4, fov_cm: 21.8 }, dark: {}, rois: [], comment: '' };
  const cal = { cccd: [{ fov: 21.8, f: 1, coef: 1e6 }], flatField: [], shelfFov: {}, saturation: 61000 };
  const images = { 'luminescent.tif': { width: W, height: H, data: lum }, 'photograph.tif': { width: pw, height: pw, data: photo } };
  // The true flux of each source: the sum of its counts × the conversion factor.
  const factor = 1e6 / 10 * (21.8 / 1920) ** 2 * 4 * Math.PI;
  const truth = strengths.map((s) => s * 2 * Math.PI * 16 * factor);
  return { meta, cal, images, truth, xs };
}

test('a synthetic scene: three mice found, numbered left to right, each with its own flux', () => {
  const { meta, cal, images, truth, xs } = scene();
  for (const method of ['morph', 'noise+morph', 'noise+morph+margin']) {
    const r = analyseClick({ meta, cal, images, method, expected: 3, flatField: false });
    assert.equal(r.mice.length, 3, method);
    r.mice.forEach((m, i) => {
      assert.equal(m.n, i + 1);
      assert.ok(Math.abs((m.bbox.x0 + m.bbox.x1) / 2 - xs[i]) < 20, `${method}: mouse ${i + 1} at ${m.bbox.x0}–${m.bbox.x1}`);
      assert.ok(Math.abs(m.totalFlux / truth[i] - 1) < 0.1, `${method}: mouse ${i + 1} ${m.totalFlux.toExponential(3)} vs ${truth[i].toExponential(3)}`);
      assert.equal(m.axis.headFrom, 'opposite the tail', 'the tail below says where the head is');
      assert.ok(m.liver.cy < m.axis.cy, 'the liver ROI lies in the upper trunk');
    });
    assert.equal(r.algorithm.version, ALGORITHM.version);
    assert.equal(r.algorithm.method, method);
  }
});

test('touching mice are parted, and without a count their number is estimated from their size', () => {
  const { meta, cal, images, truth } = scene({ touching: true });
  const r = analyseClick({ meta, cal, images, expected: 3, flatField: false });
  assert.equal(r.mice.length, 3);
  r.mice.forEach((m, i) => assert.ok(Math.abs(m.totalFlux / truth[i] - 1) < 0.15, `mouse ${i + 1}`));
  const guess = analyseClick({ meta, cal, images, flatField: false });
  assert.equal(guess.mice.length, 3);
  assert.ok(guess.notes.some((n) => /No count of mice was given/.test(n)));
});

test('saturated pixels are flagged, not corrected', () => {
  const { meta, cal, images } = scene();
  const lum = images['luminescent.tif'];
  lum.data[100 * 240 + 185] = 65000; // inside the right mouse
  const r = analyseClick({ meta, cal, images, expected: 3, flatField: false });
  assert.ok(r.mice[2].saturatedPixels >= 1);
  assert.ok(r.mice[2].warnings.some((w) => /saturation/.test(w)));
  assert.equal(r.mice[0].saturatedPixels, 0);
});

test('moving a liver ROI measures it again, and the correction is logged with the algorithm version', () => {
  const { meta, cal, images } = scene();
  const r = analyseClick({ meta, cal, images, expected: 3, flatField: false });
  const m = r.mice[2];
  const onSource = moveLiver(r, 3, 370, 200);
  const offSource = moveLiver(r, 3, 370, 300);
  assert.ok(onSource.flux > 10 * Math.max(1, offSource.flux));
  assert.equal(onSource.source, 'moved by hand');
  const c = logCorrection({ mouse: m.n, field: 'liver', from: m.liver.flux, to: onSource.flux, by: 'GM', algorithm: r.algorithm, at: '2026-10-31T10:00:00Z' });
  assert.deepEqual(c, { mouse: 3, field: 'liver', from: m.liver.flux, to: onSource.flux, by: 'GM', at: '2026-10-31T10:00:00Z', algorithm: `lnp-lab-bli ${ALGORITHM.version} ${DEFAULT_METHOD}` });
});

test('the fixture folder: three mice, numbered as the comment lists them, flux within 15 % of the published values', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ivis', 'BMD20230209123405');
  const images = Object.fromEntries(readdirSync(dir).filter((n) => /\.tif$/i.test(n)).map((n) => [n.toLowerCase(), readTiff(readFileSync(path.join(dir, n)))]));
  const meta = clickMeta(readFileSync(path.join(dir, 'AnalyzedClickInfo.txt'), 'latin1'));
  const cal = parseCalibration(readFileSync(path.join(dir, 'ClickInfo.txt'), 'latin1'));
  const published = [340200, 659700, 2261000];
  const r = analyseClick({ meta, cal, images, expected: 3 });
  assert.equal(r.algorithm.method, DEFAULT_METHOD);
  assert.equal(r.mice.length, 3);
  r.mice.forEach((m, i) => assert.ok(Math.abs(m.totalFlux / published[i] - 1) < 0.15, `mouse ${i + 1}: ${m.totalFlux.toExponential(3)} vs ${published[i]}`));
  assert.ok(r.mice.every((m) => m.saturatedPixels === 0));
  assert.ok(r.mice.every((m) => m.crop.width <= 64 && m.crop.data.length > 0));
  assert.match(r.conversion.dark, /dark charge/);
  assert.equal(r.conversion.flatField, 'D f/1');
  // Otsu on its own, the first method tried, misses the black fur: the reason the cleanup and the noise rule exist
  const plain = analyseClick({ meta, cal, images, method: 'threshold', expected: 3 });
  assert.ok(plain.mice.some((m, i) => Math.abs(m.totalFlux / published[i] - 1) > 0.5));
  assert.deepEqual(METHODS.map((m) => m.id), ['threshold', 'morph', 'noise+morph', 'noise+morph+margin']);
});
