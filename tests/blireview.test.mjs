// Reviewing a BLI analysis (spec 8.7): standardised crops (body axis up, one scale, photograph and luminescence),
// picking a mouse by a click, correcting a mask with a brush and measuring it again, and reopening a saved record
// over the same files, proven the same by SHA-256. On the CC0 fixture folder (tests/fixtures/ivis/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readTiff } from '../app/calc/tiff.js';
import { clickMeta, parseCalibration } from '../app/calc/ivis.js';
import { analyseClick, cropFrame, CROP, mouseAt, editMask, maskPixels, matchFiles, restoreMice, logCorrection, decodeMask, ALGORITHM } from '../app/calc/bli.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ivis', 'BMD20230209123405');
const names = readdirSync(dir);
const images = Object.fromEntries(names.filter((n) => /\.tif$/i.test(n)).map((n) => [n.toLowerCase(), readTiff(readFileSync(path.join(dir, n)))]));
const meta = clickMeta(readFileSync(path.join(dir, 'AnalyzedClickInfo.txt'), 'latin1'));
const cal = parseCalibration(readFileSync(path.join(dir, 'ClickInfo.txt'), 'latin1'));
const files = names.map((n) => ({ name: n, sha256: createHash('sha256').update(readFileSync(path.join(dir, n))).digest('hex') }));
const analyse = () => analyseClick({ meta, cal, images, expected: 3 });
const unb64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));

test('the crop frame: centred on the mouse, head up, CROP.pxPerCm whatever the photograph\'s scale', () => {
  // A mouse lying with its head to the right: the top of the crop is the right of the photograph.
  const fr = cropFrame({ cx: 100, cy: 50, head: [140, 50], tail: [60, 50] }, 0.05);
  assert.equal(fr.width, CROP.widthCm * CROP.pxPerCm);
  assert.equal(fr.height, CROP.heightCm * CROP.pxPerCm);
  const [tx] = fr.point(fr.width / 2, 0), [bx] = fr.point(fr.width / 2, fr.height - 1);
  assert.ok(tx > 100 + 80 && bx < 100 - 80, 'top row at the head end, bottom at the tail end, 5.5 cm each way');
  const [, ly] = fr.point(0, fr.height / 2), [, ry] = fr.point(fr.width - 1, fr.height / 2);
  assert.ok(ly < ry, 'and the crop\'s right is the mouse\'s side below the axis');
  // One crop pixel is 1/8 cm: 2.5 photograph pixels at 0.05 cm each.
  const a = fr.point(0, 0), b = fr.point(1, 0);
  assert.ok(Math.abs(Math.hypot(a[0] - b[0], a[1] - b[1]) - 2.5) < 1e-9);
});

test('every mouse gets a standardised photograph crop and a luminescence crop in the same frame', () => {
  const r = analyse();
  assert.equal(r.algorithm.version, ALGORITHM.version);
  for (const m of r.mice) {
    for (const c of [m.crop, m.lumCrop]) {
      assert.equal(c.width, 40); assert.equal(c.height, 88); assert.equal(c.pxPerCm, 8); assert.equal(c.orientation, 'head up');
      assert.equal(unb64(c.data).length, 40 * 88);
    }
    assert.equal(m.lumCrop.scale, 'sqrt');
    assert.ok(m.lumCrop.max > 0);
    // The light is on the mouse: most of the luminescence crop's signal lies in its middle half across.
    const lum = unb64(m.lumCrop.data);
    let mid = 0, all = 0;
    for (let j = 0; j < 88; j++) for (let i = 0; i < 40; i++) { const v = (lum[j * 40 + i] / 255) ** 2; all += v; if (i >= 10 && i < 30) mid += v; }
    assert.ok(mid / all > 0.6, `mouse ${m.n}: ${(mid / all).toFixed(2)} of the light in the middle`);
  }
});

test('a click picks the mouse under it; a brush corrects its mask and the mouse is measured again', () => {
  const r = analyse();
  const w = r.photo.width;
  for (const m of r.mice) {
    const px = maskPixels(m, w);
    const i = px[px.length >> 1];
    assert.equal(mouseAt(r, i % w, Math.floor(i / w)), m.n);
  }
  assert.equal(mouseAt(r, 1, 1), null, 'the corner of the stage is no mouse');
  // Erase a disc over the brightest part of mouse 3: its flux drops, the area too, the liver ROI stays put.
  const m3 = r.mice[2];
  const f = r.fluxImg, geo = r.geo;
  let best = -1, bx = 0, by = 0;
  for (const i of maskPixels(m3, w)) { const x = i % w, y = Math.floor(i / w); const lx = Math.floor((x - geo.ox) / geo.kx), ly = Math.floor((y - geo.oy) / geo.kx); const v = f.flux[ly * f.width + lx]; if (v > best) { best = v; bx = x; by = y; } }
  const erased = editMask(r, 3, { x: bx, y: by, r: 12, mode: 'erase' });
  assert.ok(erased.areaCm2 < m3.areaCm2);
  assert.ok(erased.totalFlux < 0.9 * m3.totalFlux, `${erased.totalFlux} vs ${m3.totalFlux}`);
  assert.equal(erased.edited, true);
  assert.deepEqual([erased.liver.cx, erased.liver.cy], [m3.liver.cx, m3.liver.cy]);
  assert.ok(erased.maskEdit.pixelsAfter < erased.maskEdit.pixelsBefore);
  assert.equal(erased.crop.width, 40, 'the crops follow the new mask');
  // Adding never takes a neighbour's pixels; adding where the mouse already is changes nothing.
  const m2px = new Set(maskPixels(r.mice[1], w));
  const i2 = [...m2px][m2px.size >> 1];
  assert.equal(editMask(r, 3, { x: i2 % w, y: Math.floor(i2 / w), r: 3, mode: 'add' }), null);
  const inside = maskPixels(m3, w)[maskPixels(m3, w).length >> 1];
  assert.equal(editMask(r, 3, { x: inside % w, y: Math.floor(inside / w), r: 2, mode: 'add' }), null);
  // Growing it out onto the stage beside it adds area.
  const grown = editMask(r, 3, { x: m3.bbox.x1 + 4, y: (m3.bbox.y0 + m3.bbox.y1) / 2, r: 6, mode: 'add' });
  assert.ok(grown.areaCm2 > m3.areaCm2);
  assert.ok(decodeMask(grown.mask, grown.bbox).some((v) => v));
  const c = logCorrection({ mouse: 3, field: 'mask', from: { areaCm2: m3.areaCm2, totalFlux: m3.totalFlux }, to: { areaCm2: erased.areaCm2, totalFlux: erased.totalFlux, mode: 'erase' }, by: 'GM', algorithm: r.algorithm, at: '2026-10-31T10:00:00Z' });
  assert.equal(c.algorithm, `lnp-lab-bli ${ALGORITHM.version} ${r.algorithm.method}`);
});

test('a saved record reopens over the same files (by SHA-256) with its own masks and values; other files are refused', () => {
  const r = analyse();
  const edited = editMask(r, 1, { x: r.mice[0].bbox.x0 + 3, y: (r.mice[0].bbox.y0 + r.mice[0].bbox.y1) / 2, r: 5, mode: 'erase' });
  const record = { algorithm: r.algorithm, background: r.background, files, mice: r.mice.map((m) => (m.n === 1 ? { ...edited, subject: '579G', group: 'G1' } : { ...m, subject: `x${m.n}`, group: 'G2' })) };
  assert.equal(matchFiles(record.files, files).ok, true);
  assert.equal(matchFiles(record.files, [...files].reverse().map((f) => ({ ...f, name: f.name.toUpperCase() }))).ok, true, 'names may differ in case: the hash decides');
  const other = files.map((f) => (f.name === 'luminescent.TIF' ? { ...f, sha256: 'f'.repeat(64) } : f));
  const no = matchFiles(record.files, other);
  assert.equal(no.ok, false);
  assert.deepEqual(no.changed.map((c) => c.name), ['luminescent.TIF']);
  assert.match(no.message, /not the files the record was made from[\s\S]*luminescent\.TIF differs \(SHA-256 [0-9a-f]{12}… saved, ffffffffffff… picked\)/);
  const gone = matchFiles(record.files, files.filter((f) => f.name !== 'photograph.TIF'));
  assert.match(gone.message, /missing: photograph\.TIF/);
  // Opened again: the saved mice, not those found now; the files' flux image to go on correcting with.
  const back = restoreMice(analyse(), record);
  assert.equal(back.mice[0].mask, edited.mask);
  assert.equal(back.mice[0].totalFlux, edited.totalFlux);
  assert.equal(back.mice[0].subject, '579G');
  assert.ok(back.fluxImg && back.geo);
  assert.equal(mouseAt(back, 1, 1), null);
  // A 1.0.0 record (no axis ends, no luminescence crop) still opens, with its axis from its mask and a note.
  const old = { ...record, algorithm: { name: 'lnp-lab-bli', version: '1.0.0', method: r.algorithm.method }, mice: record.mice.map(({ lumCrop, ...m }) => ({ ...m, axis: { angle: m.axis.angle, lengthCm: m.axis.lengthCm, widthCm: m.axis.widthCm, headFrom: m.axis.headFrom } })) };
  const o = restoreMice(analyse(), old);
  assert.ok(o.mice.every((m) => m.axis.head && m.axis.tail));
  assert.match(o.notes[0], /Saved with lnp-lab-bli 1\.0\.0/);
  const p2 = maskPixels(o.mice[1], o.photo.width)[0];
  assert.ok(editMask(o, 2, { x: p2 % o.photo.width, y: Math.floor(p2 / o.photo.width), r: 4, mode: 'erase' }).lumCrop, 'and can be corrected, gaining its crops');
});
