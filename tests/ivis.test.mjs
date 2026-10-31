// IVIS (Living Image) export folders: the TIFF reader, the two text files, the calibration, counts to photons
// (spec 8.7). The fixture is one CC0 folder of S-BIAD3647 (tests/fixtures/ivis/README.md) with published flux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTiff, writeTiff } from '../app/calc/tiff.js';
import { parseClickInfo, clickMeta, parseCalibration, parseRois, cccdFor, flatFieldFor, flatFieldAt, darkFrame, fluxImage, roiFlux, removeCosmics, animalIdsFromComment, viewFrom, groupClickFolders } from '../app/calc/ivis.js';
import * as parsers from '../app/calc/parsers.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ivis', 'BMD20230209123405');
const text = (n) => readFileSync(path.join(dir, n), 'latin1');
const images = Object.fromEntries(readdirSync(dir).filter((n) => /\.tif$/i.test(n)).map((n) => [n.toLowerCase(), readTiff(readFileSync(path.join(dir, n)))]));
const meta = clickMeta(text('AnalyzedClickInfo.txt'));
const cal = parseCalibration(text('ClickInfo.txt'));
// Published total flux of these three mice on day 14 ("C57 KPC689 IVIS data.xlsx", sheet ROI), left to right.
const PUBLISHED = [340200, 659700, 2261000];

test('the TIFF reader reads what Living Image writes: 16-bit, little-endian, uncompressed strips', () => {
  const lum = images['luminescent.tif'], photo = images['photograph.tif'];
  assert.equal(lum.width, 240); assert.equal(lum.height, 240); assert.equal(lum.bits, 16); assert.equal(lum.strips, 15);
  assert.equal(photo.width, 480); assert.equal(photo.height, 480); assert.equal(photo.strips, 60);
  assert.ok(lum.data instanceof Uint16Array);
  // The dark level sits at the read bias (about 748 counts), the brightest pixel well under saturation.
  const sorted = Array.from(lum.data).sort((a, b) => a - b);
  assert.ok(Math.abs(sorted[sorted.length >> 1] - 749) < 5);
  assert.ok(sorted[sorted.length - 1] < 61000);
});

test('the TIFF reader round-trips 8 and 16 bits, both byte orders, one strip or many', () => {
  const w = 7, h = 5;
  for (const bits of [8, 16]) for (const littleEndian of [true, false]) for (const rowsPerStrip of [h, 2]) {
    const data = Array.from({ length: w * h }, (_, i) => (bits === 8 ? (i * 37) % 256 : (i * 4099) % 65536));
    const back = readTiff(writeTiff({ width: w, height: h, bits, data, littleEndian, rowsPerStrip }));
    assert.equal(back.width, w); assert.equal(back.height, h); assert.equal(back.bits, bits);
    assert.deepEqual(Array.from(back.data), data, `${bits} bit, ${littleEndian ? 'LE' : 'BE'}, ${rowsPerStrip} rows per strip`);
  }
});

test('the TIFF reader refuses what it cannot read, with a sentence, instead of reading noise', () => {
  const ok = writeTiff({ width: 2, height: 2, bits: 16, data: [1, 2, 3, 4] });
  const lzw = ok.slice();
  const dv = new DataView(lzw.buffer);
  const ifd = dv.getUint32(4, true);
  for (let i = 0; i < dv.getUint16(ifd, true); i++) { const at = ifd + 2 + 12 * i; if (dv.getUint16(at, true) === 259) dv.setUint16(at + 8, 5, true); }
  assert.throws(() => readTiff(lzw), /compressed \(scheme 5\)/);
  assert.throws(() => readTiff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /not a TIFF/);
  assert.throws(() => readTiff(new Uint8Array(3)), /too short/);
});

test('ClickInfo files: sections, keys, the click number, the version and the comment', () => {
  const info = parseClickInfo(text('AnalyzedClickInfo.txt'));
  assert.equal(info.field('luminescent image', 'Binning Factor'), '8');
  assert.equal(info.field('photographic image', 'Binning Factor'), '4');
  assert.equal(meta.clickNumber, 'BMD20230209123405');
  assert.deepEqual(animalIdsFromComment(meta.comment), ['579G', '580G', '581G']);
  assert.equal(meta.luminescent.exposure_s, 60);
  assert.equal(meta.luminescent.fNumber, 1);
  assert.equal(meta.luminescent.fov_cm, 21.8);
  assert.equal(meta.luminescent.flatFieldCorrected, false);
  assert.equal(meta.photograph.binning, 4);
  assert.equal(meta.dark.darkcharge.file, 'background.TIF');
  assert.equal(meta.dark.darkcharge.multiplier, 10);
  assert.equal(clickMeta(text('ClickInfo.txt')).version, '4.5.2.18424 (Sep 11 2015)');
});

test('the hand-drawn ROIs: circles in unbinned pixels, Width as the diameter', () => {
  const rois = parseRois(text('AnalyzedClickInfo.txt'));
  assert.equal(rois.length, 3);
  assert.equal(rois[0].shape, 'circle');
  assert.ok(Math.abs(rois[0].xc - 923.737) < 0.01);
  assert.ok(Math.abs(rois[0].cmPerPixel - 21.8 / 1920) < 1e-9);
});

test('the calibration: C-ccd per FOV and f-stop, flat-field polynomials, shelves, saturation', () => {
  assert.equal(cal.cccd.length, 16);
  assert.equal(cccdFor(cal, 21.8, 1).coef, 1.049e6);
  assert.equal(cccdFor(cal, 21.9, 1).coef, 1.049e6, 'nearest field of view');
  assert.equal(cccdFor(cal, 21.8, 3), null, 'an f-stop without calibration has none');
  assert.equal(cal.saturation, 61000);
  assert.deepEqual(cal.shelfFov, { A: 4, B: 6.6, C: 13, D: 21.8 });
  const ff = flatFieldFor(cal, 21.8, 1);
  assert.equal(ff.shelf, 'D');
  assert.ok(Math.abs(flatFieldAt(ff, ff.x0, ff.y0) - 1.000147) < 1e-9, 'k0 at the optical centre');
  assert.ok(flatFieldAt(ff, 8, 0) < 0.9, 'vignetting: the field falls off towards the edge');
  assert.equal(cal.instrument, 'IVIS 200 Spectrum');
});

test('the dark frame: the dark-charge image divided by its multiplier, else a read-bias frame, else the level', () => {
  const n = 240 * 240;
  const d = darkFrame(meta, images, n);
  assert.match(d.source, /background\.TIF, ÷10/);
  assert.ok(Math.abs(d.values[0] - images['background.tif'].data[0] / 10) < 1e-9);
  const onlyLevel = darkFrame(meta, {}, n);
  assert.equal(onlyLevel.values, null); assert.equal(onlyLevel.level, 747.94);
});

test('counts to photons agree with the published flux within a few per cent once the flat field is applied', () => {
  const rois = [...meta.rois].sort((a, b) => a.xc - b.xc); // left to right, as the comment lists the mice
  const withFF = fluxImage({ meta, cal, lum: images['luminescent.tif'], images });
  const noFF = fluxImage({ meta, cal, lum: images['luminescent.tif'], images, flatField: false });
  rois.forEach((r, i) => {
    const a = roiFlux(withFF, r, 8).flux, b = roiFlux(noFF, r, 8).flux;
    assert.ok(Math.abs(a / PUBLISHED[i] - 1) < 0.05, `mouse ${i + 1}: ${a.toExponential(3)} against ${PUBLISHED[i]}`);
    // without it the off-centre mice read low: the 3–23 % gap of the first reconstruction
    assert.ok(b < a);
  });
  assert.ok(roiFlux(noFF, rois[0], 8).flux / PUBLISHED[0] < 0.8, 'the left mouse, far from the centre, read 20 % low without the flat field');
  // binning cancels: the factor per binned pixel is C/t × (cm per unbinned pixel)² × 4π
  assert.ok(Math.abs(withFF.factor - 1.049e6 / 60 * (21.8 / 1920) ** 2 * 4 * Math.PI) < 1e-9);
});

test('flux does not depend on exposure or binning: the same light in a 2 × 2 binned, half-length exposure', () => {
  // A synthetic click: a 64 x 64 frame at binning 2, then the same scene at binning 4 and half the exposure.
  const mk = (bin, exp) => {
    const w = 128 / bin, data = new Uint16Array(w * w).fill(500);
    // a source of 1000 counts per unbinned pixel per second over 16 x 16 unbinned pixels
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) if (x * bin >= 56 && x * bin < 72 && y * bin >= 56 && y * bin < 72) data[y * w + x] += 1000 * bin * bin * exp;
    const m = { luminescent: { binning: bin, exposure_s: exp, fNumber: 1, fov_cm: 12.8, readBias: 500, units: 'counts' }, dark: {} };
    return fluxImage({ meta: m, cal: { cccd: [{ fov: 12.8, f: 1, coef: 1e6 }] }, lum: { width: w, height: w, data }, flatField: false, cosmic: false });
  };
  const sum = (img) => img.flux.reduce((a, b) => a + b, 0);
  const a = sum(mk(2, 1)), b = sum(mk(4, 0.5));
  assert.ok(Math.abs(a / b - 1) < 1e-9);
  // 256 unbinned pixels × 1000 counts/s × 1e6 × (0.1 cm)² × 4π
  assert.ok(Math.abs(a - 256 * 1000 * 1e6 * 0.01 * 4 * Math.PI) / a < 1e-9);
});

test('a cosmic ray (one hot pixel) is replaced; a real source spread over several pixels is not', () => {
  const w = 20, h = 20, c = new Float64Array(w * h).fill(0);
  for (let i = 0; i < c.length; i++) c[i] = (i * 7919) % 5 - 2; // noise of a few counts
  c[5 * w + 5] = 3000; // a single hot pixel
  for (let y = 12; y < 16; y++) for (let x = 12; x < 16; x++) c[y * w + x] = 800; // a source
  assert.equal(removeCosmics(c, w, h), 1);
  assert.ok(c[5 * w + 5] < 10);
  assert.equal(c[13 * w + 13], 800);
});

test('view from the label, the comment or the folder name; folders grouped from a directory upload', () => {
  assert.equal(viewFrom('', 'mouse 3 ventral'), 'ventral');
  assert.equal(viewFrom('Dorsal'), 'dorsal');
  assert.equal(viewFrom('', '', 'Day 8/BMD2023'), null);
  const files = ['exp/BMD1/luminescent.TIF', 'exp/BMD1/AnalyzedClickInfo.txt', 'exp/BMD1/photograph.TIF', 'exp/BMD2/ClickInfo.txt', 'exp/BMD2/luminescent.TIF', 'exp/notes.txt'].map((p) => ({ path: p }));
  const g = groupClickFolders(files);
  assert.deepEqual(g.map((x) => x.folder), ['exp/BMD1', 'exp/BMD2']);
  assert.ok(g[0].files['analyzedclickinfo.txt']);
});

test('the IVIS readers are found among the instrument parsers', () => {
  assert.equal(typeof parsers.clickMeta, 'function');
  assert.equal(typeof parsers.readTiff, 'function');
});
