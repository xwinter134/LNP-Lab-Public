// The BLI test bench (spec 8.7): automatic per-mouse flux against published manual values.
//
//   node scripts/bli-benchmark.mjs <bench-dir> [--published <file.xlsx>] [--json out.json]
//
// <bench-dir> holds Living Image click folders (any depth), e.g. the S-BIAD3647 "Figure 1/1O/IVIS data" tree
// (CC0, https://www.ebi.ac.uk/biostudies/BioImages/studies/S-BIAD3647). The published table there
// ("C57 KPC689 IVIS data.xlsx", sheet ROI) has one row per mouse id and one column per day; the folders name
// their mice in Comment1, left to right ("579G 580G 581G"), and sit in "Day <n>" folders. The large set is not
// in the repository; tests/fixtures/ivis holds one folder.
//
// Two comparisons, kept apart so a disagreement can be traced:
//   1. conversion: the hand-drawn ROIs stored in each AnalyzedClickInfo.txt, re-measured with this app's
//      counts-to-photons conversion, against the published flux. Tests the arithmetic (calibration, dark
//      frame, flat field) without any segmentation.
//   2. segmentation: the automatic per-mouse flux (whole mask) of each method in app/calc/bli.js against the
//      published flux.
// Reported per comparison: n, Pearson r of log10 values, Bland–Altman bias and 95 % limits of the log10
// ratio (shown as fold), median absolute % difference, and the share within 20 %.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readTiff } from '../app/calc/tiff.js';
import { clickMeta, parseCalibration, fluxImage, roiFlux, animalIdsFromComment } from '../app/calc/ivis.js';
import { analyseClick, METHODS } from '../app/calc/bli.js';
import { agreement } from '../app/calc/bio.js';

const args = process.argv.slice(2);
const dir = args[0];
if (!dir) { console.error('usage: node scripts/bli-benchmark.mjs <bench-dir> [--published file.xlsx] [--json out.json]'); process.exit(2); }
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

/* ---------------- a minimal .xlsx reader (stored or deflated entries, shared strings, first sheet) ---------------- */
function unzip(buf) {
  const out = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(lStart, lStart + size);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    p += 46 + nameLen + extra + comment;
  }
  return out;
}
function readXlsx(file) {
  const z = unzip(readFileSync(file));
  const xml = (k) => (z[k] ? z[k].toString('utf8') : '');
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const shared = [...xml('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const rows = [];
  for (const r of xml('xl/worksheets/sheet1.xml').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = [...c[1]].reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const v = /<v>([\s\S]*?)<\/v>/.exec(c[3] || '')?.[1];
      const isS = /t="s"/.test(c[2]);
      const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(c[3] || '')?.[1];
      row[col] = isS ? shared[Number(v)] : inline != null ? unesc(inline) : v != null ? (Number.isFinite(Number(v)) ? Number(v) : unesc(v)) : null;
    }
    rows.push(row);
  }
  return rows;
}

/** {`${mouse}|${day}`: flux} from the S-BIAD3647 table: a header row with "Mouse ID" and the days. */
function publishedTable(file) {
  const rows = readXlsx(file);
  const h = rows.findIndex((r) => r && /mouse id/i.test(String(r[0] ?? '')));
  const days = rows[h].map((v) => (Number.isFinite(Number(v)) ? Number(v) : null));
  const out = new Map();
  for (const r of rows.slice(h + 1)) {
    if (!r || !r[0] || !/\d/.test(String(r[0]))) continue;
    days.forEach((d, j) => { if (d != null && j >= 2 && Number.isFinite(r[j]) && r[j] > 0) out.set(`${String(r[0]).trim()}|${d}`, r[j]); });
  }
  return out;
}

/* ---------------- the folders ---------------- */
function clickDirs(root) {
  const out = [];
  const walk = (d) => {
    const names = readdirSync(d);
    if (names.some((n) => /^luminescent\.tif$/i.test(n)) && names.some((n) => /clickinfo\.txt$/i.test(n))) out.push(d);
    for (const n of names) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); }
  };
  walk(root);
  return out.sort();
}
function loadFolder(d) {
  const names = readdirSync(d);
  const get = (re) => names.find((n) => re.test(n));
  const text = (n) => (n ? readFileSync(path.join(d, n), 'latin1') : '');
  const analyzed = text(get(/^analyzedclickinfo\.txt$/i)), click = text(get(/^clickinfo\.txt$/i));
  const images = {};
  for (const n of names.filter((x) => /\.tiff?$/i.test(x))) images[n.toLowerCase()] = readTiff(readFileSync(path.join(d, n)));
  return { analyzed, click, images };
}

const published = opt('--published') ? publishedTable(opt('--published')) : new Map();
const dayOf = (d) => Number(/Day\s*(\d+)/i.exec(d)?.[1]);
const pairs = { conversion: [], conversionNoFF: [], conversionNet: [] };
for (const m of METHODS) { pairs[m.id] = []; pairs[`${m.id} vs hand ROI`] = []; }
const perFolder = [];
const dirs = clickDirs(dir);
for (const d of dirs) {
  const f = loadFolder(d);
  const meta = clickMeta(f.analyzed || f.click);
  const cal = parseCalibration(f.click);
  const ids = animalIdsFromComment(meta.comment);
  const day = dayOf(d);
  const lum = f.images['luminescent.tif'];
  let handNet = null;
  const rec = { folder: path.relative(dir, d), ids, rois: meta.rois.length, methods: {} };
  // 1. the hand-drawn ROIs, ordered left to right as the ids are
  for (const ff of [true, false]) {
    const img = fluxImage({ meta, cal, lum, images: f.images, flatField: ff });
    const rois = [...meta.rois].sort((a, b) => a.xc - b.xc);
    if (rois.length === ids.length) rois.forEach((r, i) => {
      const pub = published.get(`${ids[i]}|${day}`);
      if (pub) pairs[ff ? 'conversion' : 'conversionNoFF'].push({ auto: roiFlux(img, r, meta.luminescent.binning).flux, manual: pub, id: `${ids[i]} d${day}` });
    });
  }
  // and the same ROIs net of the stage background, as the automatic method measures it
  {
    const res = analyseClick({ meta, cal, images: f.images, expected: ids.length || null });
    const img = res.fluxImg, bg = res.background.perLumPixel;
    const rois = [...meta.rois].sort((a, b) => a.xc - b.xc);
    handNet = rois.length === ids.length ? rois.map((r) => { const m = roiFlux(img, r, meta.luminescent.binning); return m.flux - bg * m.pixels; }) : null;
    if (rois.length === ids.length) rois.forEach((r, i) => {
      const pub = published.get(`${ids[i]}|${day}`);
      const m = roiFlux(img, r, meta.luminescent.binning);
      if (pub) pairs.conversionNet.push({ auto: m.flux - bg * m.pixels, manual: pub, id: `${ids[i]} d${day}` });
    });
  }
  // 2. the automatic per-mouse flux
  for (const m of METHODS) {
    const res = analyseClick({ meta, cal, images: f.images, method: m.id, expected: ids.length || null });
    rec.methods[m.id] = res.mice.length;
    if (res.mice.length !== ids.length) continue; // a miscount is reported, not matched by guesswork
    if (handNet) res.mice.forEach((mouse, i) => pairs[`${m.id} vs hand ROI`].push({ auto: mouse.totalFlux, manual: handNet[i], id: `${ids[i]} d${day}` }));
    res.mice.forEach((mouse, i) => {
      const pub = published.get(`${ids[i]}|${day}`);
      if (pub) pairs[m.id].push({ auto: mouse.totalFlux, manual: pub, id: `${ids[i]} d${day}` });
    });
  }
  perFolder.push(rec);
}

const report = { folders: dirs.length, mice: perFolder.reduce((s, r) => s + r.ids.length, 0), published: published.size, results: {} };
for (const [k, ps] of Object.entries(pairs)) report.results[k] = agreement(ps.map((p) => p.auto), ps.map((p) => p.manual));
report.counted = Object.fromEntries(METHODS.map((m) => [m.id, perFolder.filter((r) => r.methods[m.id] === r.ids.length).length]));
console.log(JSON.stringify(report, null, 2));
if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify({ report, pairs, perFolder }, null, 2));
