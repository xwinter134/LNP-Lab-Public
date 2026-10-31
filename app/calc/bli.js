// Automatic BLI image analysis (spec 8.7): find the mice on the photograph, number them left to right, and
// measure each one's total flux, a liver ROI and the background, from one Living Image click folder.
//
// "Start simple, measure, escalate only if needed." Everything here is classical image processing that can
// be followed step by step and checked in the overlay; there is no trained model and no dependency. The test
// bench (scripts/bli-benchmark.mjs, docs/BLI-BENCHMARK.md) decides between the methods below by agreement
// with published manual values, not by elegance. A learned segmenter (SAM 2, YOLO) is the next step only if
// real images defeat this: touching animals the column split cannot part, or a pose it misreads.
//
// The steps:
//  1. The photograph's stage is modelled as a smooth surface (a quadratic in x and y fitted robustly to
//     log brightness), so lens vignetting and uneven light do not decide what is a mouse.
//  2. Every pixel's distance from that surface, |log photo − log stage|, is thresholded with Otsu's method.
//     Distance, not brightness: the C57BL/6 mice of the public set are black fur on a grey stage with a shaved
//     white patch, so a mouse is both darker and brighter than the stage. (threshold)
//  3. Optionally cleaned: closing (fur texture), holes filled, an opening that removes tails, wires and
//     divider edges. (morph)  And grown by a margin, as BLI has almost no background and light spreads past
//     the skin's edge in the photograph. (morph+margin)
//  4. Connected components, small ones dropped. Animals lying side by side touch; when the expected number of
//     mice is known (the ids in the click's comment, or the study plan), joined animals are parted at the
//     deepest valley of the mask's column profile until the count is right. Numbered left to right.
//  5. Per mouse: long axis from the mask's second moments; the tail end is where the thin parts removed in
//     step 3 lie (the head is assumed at the top when no tail is found, and the overlay says so); a liver
//     ROI as an ellipse on the axis in the upper trunk, 5.5 cm up from the tail base (LIVER), a background
//     level from the stage away from every mouse, and a saturation check against the CCD's level.
//  6. Flux in p/s from app/calc/ivis.js (calibrated, dark-subtracted, flat-field corrected), summed over each
//     mask with every luminescent pixel weighted by the share of it the mask covers.
//
// What is stored per mouse (spec: "crop, mask and ROI values with the algorithm version"): the bounding box,
// the mask as run lengths, a small 8-bit crop of the photograph, the ROI geometry and values, and
// ALGORITHM.version, so a value can be traced to the code that made it after the code has changed.
import { solve } from './stats.js';
import { fluxImage } from './ivis.js';

export const ALGORITHM = { name: 'lnp-lab-bli', version: '1.0.0' };

/** The methods the test bench compares; `id` is stored with every result. */
export const METHODS = [
  { id: 'threshold', label: 'Otsu threshold only', rule: 'otsu', morph: false, marginCm: 0 },
  { id: 'morph', label: 'Otsu threshold + morphological cleanup', rule: 'otsu', morph: true, marginCm: 0 },
  { id: 'noise+morph', label: 'Stage-noise threshold + cleanup', rule: 'noise', morph: true, marginCm: 0 },
  { id: 'noise+morph+margin', label: 'Stage-noise threshold + cleanup + 0.3 cm margin', rule: 'noise', morph: true, marginCm: 0.3 },
];
export const DEFAULT_METHOD = 'noise+morph+margin';

// Physical sizes the steps need, in cm, so they hold at any binning or field of view.
const MIN_MOUSE_CM2 = 4, MIN_WIDTH_CM = 1.2; // a component smaller or narrower than this is debris, not a mouse
const MOUSE_SPAN_CM = 4; // how wide an adult mouse lying prone is with its legs, for counting joined mice without a count
const CLOSE_CM = 0.12, OPEN_CM = 0.25; // closing fills fur texture; opening removes tails (about 0.2 cm wide)
// The liver ROI: its centre 5.5 cm up from the tail base (an adult mouse is about 8.5 cm nose to tail base, and
// the liver sits under the lower ribs, about two thirds of the way up), or at 35 % of the length from the head
// when no tail was found; radii 1 cm along the body and 35 % of its width across. Measured from the tail base
// because the head is the end the holder cut may have taken (holderRows).
const LIVER = { fromTailCm: 5.5, at: 0.35, alongCm: 1, across: 0.35 };
const BG_CLEAR_CM = 1; // the background is read at least this far from every mouse

/* ------------------------------------------------------------------ binary image helpers */

/** Otsu's threshold of a list of values: the cut that best separates two classes (maximum between-class variance). */
export function otsu(values, bins = 256) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!(hi > lo)) return lo;
  const hist = new Float64Array(bins), step = (hi - lo) / bins;
  for (const v of values) hist[Math.min(bins - 1, Math.floor((v - lo) / step))]++;
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = 0, cut = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; cut = i; }
  }
  return lo + (cut + 1) * step;
}

/** Square dilation (grow = true) or erosion of a 0/1 mask by radius r pixels, separable running sums. */
function morph1(mask, w, h, r, grow) {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const pass = (src, dst, len, count, at) => {
    for (let line = 0; line < count; line++) {
      let s = 0;
      const get = (k) => (k < 0 || k >= len ? (grow ? 0 : 1) : src[at(line, k)]);
      for (let k = -r; k <= r; k++) s += get(k);
      for (let k = 0; k < len; k++) {
        dst[at(line, k)] = grow ? (s > 0 ? 1 : 0) : (s === 2 * r + 1 ? 1 : 0);
        s += get(k + r + 1) - get(k - r);
      }
    }
  };
  pass(mask, tmp, w, h, (y, x) => y * w + x);
  pass(tmp, out, h, w, (x, y) => y * w + x);
  return out;
}
export const dilate = (m, w, h, r) => morph1(m, w, h, r, true);
export const erode = (m, w, h, r) => morph1(m, w, h, r, false);
export const closeMask = (m, w, h, r) => erode(dilate(m, w, h, r), w, h, r);
export const openMask = (m, w, h, r) => dilate(erode(m, w, h, r), w, h, r);

/** Fill the holes of a mask: everything not reachable from the border through background. */
export function fillHoles(mask, w, h) {
  const seen = new Uint8Array(w * h), stack = [];
  const push = (i) => { if (!mask[i] && !seen[i]) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i - x) / w;
    if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] || !seen[i] ? 1 : 0;
  return out;
}

/** 8-connected components: a label per pixel (0 = background) and each component's pixel count and box. */
export function components(mask, w, h) {
  const labels = new Int32Array(w * h), comps = [];
  const stack = [];
  for (let start = 0; start < labels.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = comps.length + 1;
    const c = { id, area: 0, x0: w, y0: h, x1: -1, y1: -1, sx: 0, sy: 0 };
    labels[start] = id; stack.push(start);
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      c.area++; c.sx += x; c.sy += y;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((dx || dy) && nx >= 0 && nx < w && ny >= 0 && ny < h) { const j = ny * w + nx; if (mask[j] && !labels[j]) { labels[j] = id; stack.push(j); } }
      }
    }
    c.cx = c.sx / c.area; c.cy = c.sy / c.area;
    comps.push(c);
  }
  return { labels, comps };
}

/* ------------------------------------------------------------------ the stage model */

/** log(photo) minus a quadratic surface fitted to the stage, with iterative exclusion of everything that is not stage. */
export function stageDeviation(photo) {
  const { width: w, height: h, data } = photo;
  const lg = new Float64Array(w * h);
  for (let i = 0; i < lg.length; i++) lg[i] = Math.log(data[i] + 1);
  const step = Math.max(1, Math.round(Math.min(w, h) / 120));
  const pts = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) pts.push([(2 * x) / w - 1, (2 * y) / h - 1, lg[y * w + x]]);
  const terms = (u, v) => [1, u, v, u * u, u * v, v * v];
  let beta = null, keep = pts;
  // Start from the median level: the first fit would otherwise lean towards the mice.
  const med = [...pts.map((p) => p[2])].sort((a, b) => a - b)[pts.length >> 1];
  let resid = pts.map((p) => p[2] - med);
  let sigma = null;
  for (let it = 0; it < 6; it++) {
    // The spread of the points still taken as stage (all of them at first); each round drops what is not.
    const abs = resid.filter((_, i) => it === 0 || Math.abs(resid[i]) < Math.min(2.5 * sigma, 0.2)).map(Math.abs).sort((a, b) => a - b);
    const s = 1.4826 * (abs[abs.length >> 1] || 1e-3);
    sigma = s;
    // Never wider than ±0.2 (about 20 % in brightness): with mice over a fifth of the picture the first spread
    // is inflated by their fur, and a clip that wide would fit the stage through them.
    keep = pts.filter((_, i) => Math.abs(resid[i]) < Math.min(2.5 * s, 0.2));
    if (keep.length < 20) break;
    const A = Array.from({ length: 6 }, () => new Array(6).fill(0)), b = new Array(6).fill(0);
    for (const [u, v, z] of keep) { const t = terms(u, v); for (let i = 0; i < 6; i++) { b[i] += t[i] * z; for (let j = 0; j < 6; j++) A[i][j] += t[i] * t[j]; } }
    beta = solve(A, b) || beta;
    if (!beta) break;
    resid = pts.map(([u, v, z]) => z - terms(u, v).reduce((s2, t, i) => s2 + t * beta[i], 0));
  }
  const dev = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (2 * x) / w - 1, v = (2 * y) / h - 1;
    const base = beta ? terms(u, v).reduce((s2, t, i) => s2 + t * beta[i], 0) : med;
    dev[y * w + x] = lg[y * w + x] - base;
  }
  dev.sigma = sigma; // the stage's own robust spread, for noiseThreshold
  return dev;
}

/**
 * The threshold from the stage's own noise: 4 robust standard deviations of the stage pixels around the fitted
 * surface (stageDeviation keeps them as `sigma`), never below
 * 0.08 (8 % in brightness). Otsu splits the deviations into the two classes that are most different, and on
 * black mice with a bright shaved patch that is "white patch" against everything else, so the black fur falls
 * below it; the noise rule asks only "is this not the stage?".
 */
export function noiseThreshold(dev) {
  return Math.max(0.08, 4 * (dev.sigma ?? 0.05));
}

/**
 * The anaesthesia manifold of an IVIS stage lies across the top of the picture and touches every mouse's nose.
 * Its rows are recognised as the rows in the top third whose mask covers 70 % or more of the picture's width;
 * returns the first row below the last of them (0 when there is none). Mice lying shoulder to shoulder can
 * cover as much of a row, so their heads may go with it: harmless for a tumour or whole-body signal, but the
 * overlay shows the cut, and a liver ROI that ends up too high is moved by hand. Stopping at the first narrow
 * row instead kept the heads but joined the mice through the manifold, and agreed worse on the test bench
 * (docs/BLI-BENCHMARK.md). Without this every mouse would grow a strip of
 * manifold, its long axis would be too long and the liver ROI would land on the head.
 */
export function holderRows(mask, w, h) {
  let last = -1;
  for (let y = 0; y < Math.floor(h / 3); y++) {
    let n = 0;
    for (let x = 0; x < w; x++) n += mask[y * w + x];
    if (n >= 0.7 * w) last = y;
  }
  return last < 0 ? 0 : last + 1;
}

/* ------------------------------------------------------------------ separating the mice */

/**
 * The mice as arrays of pixel indices, left to right. Components smaller than `minArea` or narrower than
 * `minWidth` pixels (debris, a divider plate seen edge on) are dropped first. Animals lying side by side touch,
 * so a component may hold several: with the expected count known (the ids in the click's comment, or the study
 * plan), the count is shared out over the components by width, and a component given k mice is cut k − 1
 * times, each cut at the lowest point of its column profile within a third of a mouse width of where an
 * even split would put it. Without a count, a component wider than 1.6 times the median is cut the same way,
 * into as many as its width holds. More components than expected: the smallest are left out, and said so.
 */
function separate(mask, w, h, minArea, minWidth, expected, notes, spanPx = Infinity) {
  const { labels, comps } = components(mask, w, h);
  let parts = comps.filter((c) => c.area >= minArea && c.x1 - c.x0 + 1 >= minWidth).map((c) => {
    const px = [];
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) { const i = y * w + x; if (labels[i] === c.id) px.push(i); }
    return px;
  });
  const want = expected && expected > 0 ? expected : null;
  if (want && parts.length > 1) {
    // A part under a third of an average mouse's share of the area is not a mouse (a divider, a reflection).
    const per = parts.reduce((a, p) => a + p.length, 0) / want;
    const kept = parts.filter((p) => p.length >= per / 3);
    if (kept.length < parts.length) notes.push(`Left out ${parts.length - kept.length} small object${parts.length - kept.length === 1 ? '' : 's'} beside the mice.`);
    parts = kept;
  }
  const widthOf = (px) => { let x0 = w, x1 = -1; for (const i of px) { const x = i % w; if (x < x0) x0 = x; if (x > x1) x1 = x; } return x1 - x0 + 1; };
  const widths = parts.map(widthOf);
  let shares;
  if (want) {
    if (parts.length > want) {
      notes.push(`Found ${parts.length} objects for ${want} mice: the ${parts.length - want} smallest were left out.`);
      const keep = parts.map((p, i) => [p.length, i]).sort((a, b) => b[0] - a[0]).slice(0, want).map(([, i]) => i).sort((a, b) => a - b);
      parts = keep.map((i) => parts[i]);
      shares = parts.map(() => 1);
    } else {
      // Largest-remainder allocation of the expected count by width, at least one each.
      const total = widths.reduce((a, b) => a + b, 0) || 1;
      const exact = widths.map((wd) => (wd / total) * want);
      shares = exact.map((e) => Math.max(1, Math.floor(e)));
      let left = want - shares.reduce((a, b) => a + b, 0);
      const order = exact.map((e, i) => [e - Math.floor(e), i]).sort((a, b) => b[0] - a[0]);
      for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) shares[order[k][1]]++;
    }
  } else {
    // The typical width is the median part's, but never more than an adult mouse lying prone spans with its
    // legs (MOUSE_SPAN_CM): three mice shoulder to shoulder are one part, and its own width is no yardstick.
    const typical = Math.min([...widths].sort((a, b) => a - b)[widths.length >> 1] || 1, spanPx);
    shares = widths.map((wd) => (wd > 1.6 * typical ? Math.max(1, Math.round(wd / typical)) : 1));
  }
  const out = [];
  parts.forEach((p, i) => out.push(...(shares[i] > 1 ? cutInto(p, w, shares[i]) : [p])));
  if (want && out.length < want) notes.push(`Found ${out.length} mice where ${want} were expected: check the overlay.`);
  const cx = (px) => px.reduce((s2, i) => s2 + (i % w), 0) / px.length;
  return out.filter((p) => p.length).sort((a, b) => cx(a) - cx(b));
}

/** Cut a set of pixels into k column bands at the valleys of its column profile nearest an even split. */
function cutInto(px, w, k) {
  let x0 = Infinity, x1 = -1;
  for (const i of px) { const x = i % w; if (x < x0) x0 = x; if (x > x1) x1 = x; }
  const width = x1 - x0 + 1;
  if (width < 2 * k) return [px];
  const prof = new Float64Array(width);
  for (const i of px) prof[(i % w) - x0]++;
  // smoothed over 5 columns, so one pixel's notch is not a valley
  const sm = prof.map((_, j) => { let s = 0, n = 0; for (let d = -2; d <= 2; d++) if (j + d >= 0 && j + d < width) { s += prof[j + d]; n++; } return s / n; });
  const step = width / k, reach = step / 3;
  const cuts = [];
  for (let j = 1; j < k; j++) {
    const aim = j * step;
    let best = Math.round(aim), low = Infinity;
    for (let c = Math.max(1, Math.round(aim - reach)); c <= Math.min(width - 2, Math.round(aim + reach)); c++) if (sm[c] < low) { low = sm[c]; best = c; }
    cuts.push(x0 + best);
  }
  const bands = Array.from({ length: k }, () => []);
  for (const i of px) { const x = i % w; let b = 0; while (b < cuts.length && x >= cuts[b]) b++; bands[b].push(i); }
  return bands;
}

/* ------------------------------------------------------------------ per mouse */

/** Long axis from second moments: angle, length and width along it (in pixels), and the two ends. */
export function longAxis(px, w) {
  const n = px.length;
  let sx = 0, sy = 0;
  for (const i of px) { sx += i % w; sy += Math.floor(i / w); }
  const cx = sx / n, cy = sy / n;
  let xx = 0, yy = 0, xy = 0;
  for (const i of px) { const dx = (i % w) - cx, dy = Math.floor(i / w) - cy; xx += dx * dx; yy += dy * dy; xy += dx * dy; }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy); // of the major axis, from +x
  const ux = Math.cos(angle), uy = Math.sin(angle);
  let lo = Infinity, hi = -Infinity, wlo = Infinity, whi = -Infinity;
  for (const i of px) {
    const dx = (i % w) - cx, dy = Math.floor(i / w) - cy;
    const t = dx * ux + dy * uy, s = -dx * uy + dy * ux;
    if (t < lo) lo = t; if (t > hi) hi = t; if (s < wlo) wlo = s; if (s > whi) whi = s;
  }
  return { cx, cy, angle, ux, uy, length: hi - lo + 1, width: whi - wlo + 1, ends: [[cx + lo * ux, cy + lo * uy], [cx + hi * ux, cy + hi * uy]] };
}

/** Run lengths of a mask inside a box, row by row, starting with a run of 0s: "3,5,2,…". */
export function encodeMask(px, w, box) {
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  const m = new Uint8Array(bw * bh);
  for (const i of px) { const x = i % w, y = Math.floor(i / w); if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) m[(y - box.y0) * bw + (x - box.x0)] = 1; }
  const runs = [];
  let cur = 0, len = 0;
  for (const v of m) { if (v === cur) len++; else { runs.push(len); cur = v; len = 1; } }
  runs.push(len);
  return runs.join(',');
}

/** The mask back from its run lengths, as a 0/1 array of the box's size. */
export function decodeMask(rle, box) {
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  const m = new Uint8Array(bw * bh);
  let at = 0, v = 0;
  for (const r of String(rle).split(',').map(Number)) { if (v) m.fill(1, at, at + r); at += r; v ^= 1; }
  return m;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    s += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)] + (b == null ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]) + (c == null ? '=' : B64[c & 63]);
  }
  return s;
}

/** A small 8-bit crop of the photograph (at most `max` pixels on its long side), base64, for the record. */
function photoCrop(photo, box, max = 64) {
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  const k = Math.max(1, Math.ceil(Math.max(bw, bh) / max));
  const cw = Math.ceil(bw / k), ch = Math.ceil(bh / k);
  let hi = 1;
  for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) hi = Math.max(hi, photo.data[y * photo.width + x]);
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = Math.min(255, Math.round(255 * photo.data[(box.y0 + y * k) * photo.width + box.x0 + x * k] / hi));
  return { width: cw, height: ch, step: k, data: base64(out) };
}

/**
 * Weighted sum of a flux image over photograph pixels. Each luminescent pixel is split 4 × 4; each sub-sample
 * is mapped to the photograph by physical position (both images share the field of view and its centre) and
 * counts if `inside(xp, yp)` holds there.
 */
function sumFlux(fimg, geo, inside, bbox = null) {
  const { flux, width: wl, height: hl } = fimg;
  let sum = 0, area = 0, saturated = 0;
  const { kx, ox, oy } = geo; // photo px = lum px * kx + offset
  const lx0 = bbox ? Math.max(0, Math.floor((bbox.x0 - ox) / kx) - 1) : 0, lx1 = bbox ? Math.min(wl - 1, Math.ceil((bbox.x1 + 1 - ox) / kx) + 1) : wl - 1;
  const ly0 = bbox ? Math.max(0, Math.floor((bbox.y0 - oy) / kx) - 1) : 0, ly1 = bbox ? Math.min(hl - 1, Math.ceil((bbox.y1 + 1 - oy) / kx) + 1) : hl - 1;
  for (let y = ly0; y <= ly1; y++) for (let x = lx0; x <= lx1; x++) {
    let k = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside((x + (sx + 0.5) / 4) * kx + ox, (y + (sy + 0.5) / 4) * kx + oy)) k++;
    if (!k) continue;
    const i = y * wl + x;
    sum += flux[i] * k / 16; area += k / 16;
    if (fimg.saturated[i]) saturated++;
  }
  return { flux: sum, lumPixels: area, saturated };
}

/** Flux inside an ellipse given in photograph pixels {cx, cy, rx, ry, angle}. */
export function ellipseFlux(fimg, geo, e) {
  const c = Math.cos(e.angle), s = Math.sin(e.angle);
  const r = Math.max(e.rx, e.ry);
  return sumFlux(fimg, geo, (x, y) => { const dx = x - e.cx, dy = y - e.cy; const a = (dx * c + dy * s) / e.rx, b = (-dx * s + dy * c) / e.ry; return a * a + b * b <= 1; },
    { x0: e.cx - r, x1: e.cx + r, y0: e.cy - r, y1: e.cy + r });
}

/**
 * The liver ROI of a mouse from its axis, as an ellipse in photograph pixels {cx, cy, rx, ry, angle}: LIVER.fromTailCm
 * up from the tail end when the tail was found (never closer than 1.5 cm to the head end), else LIVER.at of
 * the length from the head end.
 */
export function liverRoi(axis, headEnd, tailEnd, cmP, tailFound) {
  const [hx, hy] = headEnd, [tx, ty] = tailEnd;
  const d = Math.hypot(hx - tx, hy - ty) || 1;
  const ux = (hx - tx) / d, uy = (hy - ty) / d; // from the tail base towards the head
  const up = tailFound ? Math.max(0, Math.min(LIVER.fromTailCm / cmP, d - 1.5 / cmP)) : (1 - LIVER.at) * d;
  return { cx: tx + ux * up, cy: ty + uy * up, rx: LIVER.alongCm / cmP, ry: LIVER.across * axis.width, angle: Math.atan2(uy, ux) };
}

/**
 * Analyse one click folder.
 * @param {object} o
 * @param {object} o.meta      clickMeta() of AnalyzedClickInfo.txt
 * @param {object} o.cal       parseCalibration() of ClickInfo.txt
 * @param {Object<string, {width, height, data}>} o.images   readTiff() results by lower-case file name
 * @param {string} [o.method]  one of METHODS
 * @param {number|null} [o.expected]   how many mice the image holds, when known
 * @param {boolean} [o.flatField=true]
 * @returns {object} {algorithm, method, threshold, photo:{width,height}, geo, fluxImg, mice:[…], background, notes}
 *   `fluxImg` and `deviation` are for the overlay and corrections in this session; they are not stored
 */
export function analyseClick({ meta, cal, images, method = DEFAULT_METHOD, expected = null, flatField = true }) {
  const M = METHODS.find((m) => m.id === method) || METHODS.find((m) => m.id === DEFAULT_METHOD);
  const notes = [];
  const photo = images[String(meta.photograph?.file || 'photograph.tif').toLowerCase()] || images['photograph.tif'];
  const lum = images[String(meta.luminescent?.file || 'luminescent.tif').toLowerCase()] || images['luminescent.tif'];
  if (!lum) throw new Error('analyseClick: no luminescent image in the folder');
  if (!photo) throw new Error('analyseClick: no photograph in the folder; mice are found on the photograph');
  const fimg = fluxImage({ meta, cal, lum, images, flatField });
  notes.push(...fimg.notes);
  const w = photo.width, h = photo.height;
  // Photograph pixel size and the mapping from luminescent pixels (same field of view, same centre).
  const fovP = meta.photograph?.fov_cm || meta.luminescent.fov_cm;
  const cmP = fovP / w;
  const kx = fimg.binnedCm / cmP;
  const geo = { kx, ox: w / 2 - (fimg.width / 2) * kx, oy: h / 2 - (fimg.height / 2) * kx, cmP };
  const px = (cm) => Math.max(1, Math.round(cm / cmP));

  const dev = stageDeviation(photo);
  const absdev = new Float64Array(dev.length);
  for (let i = 0; i < dev.length; i++) absdev[i] = Math.abs(dev[i]);
  const sample = [];
  for (let i = 0; i < absdev.length; i += 3) sample.push(absdev[i]);
  const threshold = M.rule === 'noise' ? noiseThreshold(dev) : otsu(sample);
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = absdev[i] > threshold ? 1 : 0;
  const raw = mask;
  let cut = 0;
  if (M.morph) {
    mask = closeMask(mask, w, h, px(CLOSE_CM));
    cut = holderRows(mask, w, h);
    if (cut > 0) { mask.fill(0, 0, cut * w); notes.push(`The holder across the top (rows 0–${cut}) is not counted as part of any mouse.`); }
    mask = fillHoles(mask, w, h);
    mask = openMask(mask, w, h, px(OPEN_CM));
  }
  const minArea = MIN_MOUSE_CM2 / (cmP * cmP);
  const parts = separate(mask, w, h, minArea, MIN_WIDTH_CM / cmP, expected, notes, MOUSE_SPAN_CM / cmP);
  if (!expected && parts.length) notes.push(`No count of mice was given: ${parts.length} found from their size. Give the count if that is wrong.`);
  // What the cleanup took away (tails, wires), below the holder: the holder is not a tail.
  const thin = M.morph ? raw.map((v, i) => (v && !mask[i] && i >= cut * w ? 1 : 0)) : null;

  // The union of every mouse, grown, marks where the background must not be read.
  const all = new Uint8Array(w * h);
  for (const p of parts) for (const i of p) all[i] = 1;
  const clear = dilate(all, w, h, px(BG_CLEAR_CM));
  const bgVals = [];
  for (let y = 0; y < fimg.height; y++) for (let x = 0; x < fimg.width; x++) {
    const xp = Math.floor((x + 0.5) * kx + geo.ox), yp = Math.floor((y + 0.5) * kx + geo.oy);
    if (xp < 0 || yp < 0 || xp >= w || yp >= h || clear[yp * w + xp]) continue;
    const i = y * fimg.width + x;
    if (!fimg.saturated[i]) bgVals.push(fimg.flux[i]);
  }
  bgVals.sort((a, b) => a - b);
  const bgPerPixel = bgVals.length ? bgVals[bgVals.length >> 1] : 0;
  const background = { perLumPixel: bgPerPixel, pixels: bgVals.length, perCm2: bgPerPixel / (fimg.binnedCm ** 2) };

  const mice = parts.map((p, k) => {
    // Grown by the margin, but never into a neighbour.
    let mpx = p;
    if (M.marginCm > 0) {
      const own = new Uint8Array(w * h);
      for (const i of p) own[i] = 1;
      const grown = dilate(own, w, h, px(M.marginCm));
      const others = new Uint8Array(w * h);
      parts.forEach((q, j) => { if (j !== k) for (const i of q) others[i] = 1; });
      const othersGrown = dilate(others, w, h, 1);
      mpx = [];
      for (let i = 0; i < grown.length; i++) if (grown[i] && (own[i] || !othersGrown[i])) mpx.push(i);
    }
    const inMask = new Uint8Array(w * h);
    let bx0 = w, bx1 = -1, by0 = h, by1 = -1;
    for (const i of mpx) { inMask[i] = 1; const x = i % w, y = (i - x) / w; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    const bbox = { x0: bx0, y0: by0, x1: bx1, y1: by1 };
    const total = sumFlux(fimg, geo, (x, y) => { const xi = Math.floor(x), yi = Math.floor(y); return xi >= 0 && yi >= 0 && xi < w && yi < h && inMask[yi * w + xi] === 1; }, bbox);
    const axis = longAxis(p, w);
    // The tail end: the side of the axis where the thin parts the opening removed lie, within this mouse's columns.
    let head = null, headFrom = 'assumed: top of the image';
    if (thin) {
      // Only what lies beyond the body's box, above or below it, within its columns: the fringe of fur the
      // opening shaved off all round would otherwise pull the answer to the middle.
      let s = 0, n = 0;
      for (let y = Math.max(0, by0 - px(3)); y <= Math.min(h - 1, by1 + px(3)); y++) {
        if (y >= by0 && y <= by1) continue;
        for (let x = bx0; x <= bx1; x++) {
          const i = y * w + x;
          if (thin[i]) { const t = (x - axis.cx) * axis.ux + (y - axis.cy) * axis.uy; s += t; n++; }
        }
      }
      // At least a quarter of a square centimetre of it, clearly to one side.
      if (n * cmP * cmP > 0.25 && Math.abs(s / n) > axis.length * 0.25) { head = s / n > 0 ? axis.ends[0] : axis.ends[1]; headFrom = 'opposite the tail'; }
    }
    if (!head) head = axis.ends[0][1] <= axis.ends[1][1] ? axis.ends[0] : axis.ends[1];
    const tail = head === axis.ends[0] ? axis.ends[1] : axis.ends[0];
    const liver = liverRoi(axis, head, tail, cmP, headFrom === 'opposite the tail');
    const liverM = ellipseFlux(fimg, geo, liver);
    liverM.flux -= bgPerPixel * liverM.lumPixels;
    const areaCm2 = mpx.length * cmP * cmP;
    const bgOver = bgPerPixel * total.lumPixels;
    const warn = [];
    if (total.saturated) warn.push(`${total.saturated} luminescent pixel${total.saturated === 1 ? '' : 's'} at or above the CCD saturation level (${fimg.saturation}): the flux reads low. Image again with a shorter exposure or more binning.`);
    if (total.flux > 0 && bgOver > 0.1 * total.flux) warn.push(`The background over this mouse's area is ${Math.round(100 * bgOver / total.flux)} % of its flux: the signal is close to the floor.`);
    return {
      n: k + 1,
      bbox, areaCm2,
      mask: encodeMask(mpx, w, bbox),
      crop: photoCrop(photo, bbox),
      axis: { angle: axis.angle, lengthCm: axis.length * cmP, widthCm: axis.width * cmP, head, tail, headFrom, cx: axis.cx, cy: axis.cy, length: axis.length, width: axis.width },
      // Net of the stage background (the dark frame never matches the moment of exposure to the last count, and
      // the residual, one or two counts a pixel, adds up over a whole mouse); the gross sum is kept beside it.
      totalFlux: total.flux - bgOver,
      grossFlux: total.flux,
      liver: { ...liver, flux: liverM.flux, source: 'auto' },
      backgroundOverMouse: bgOver,
      saturatedPixels: total.saturated,
      warnings: warn,
    };
  });
  if (fimg.cosmicFixed) notes.push(`${fimg.cosmicFixed} isolated hot pixel${fimg.cosmicFixed === 1 ? '' : 's'} (cosmic rays) replaced by their neighbours.`);
  return { algorithm: { ...ALGORITHM, method: M.id }, threshold, photo: { width: w, height: h, cmPerPixel: cmP }, geo, fluxImg: fimg, deviation: dev, mice, background, notes,
    conversion: { cccd: fimg.cccd?.coef ?? null, factor: fimg.factor, dark: fimg.dark, flatField: fimg.ff ? `${fimg.ff.shelf} f/${fimg.ff.f}` : 'none' } };
}

/**
 * Move a mouse's liver ROI (a correction from the overlay) and measure it again. Returns the new liver record;
 * the caller logs the change (see logCorrection).
 */
export function moveLiver(analysis, mouseNo, cx, cy) {
  const m = analysis.mice.find((x) => x.n === mouseNo);
  if (!m) return null;
  const e = { ...m.liver, cx, cy };
  return { ...e, flux: ellipseFlux(analysis.fluxImg, analysis.geo, e).flux, source: 'moved by hand' };
}

/**
 * A correction as it is logged for later training data: what was changed, from what to what, by whom and
 * when, against which algorithm version. Kept on the image record (bliImages.corrections).
 */
export function logCorrection({ mouse, field, from, to, by = '', at = new Date().toISOString(), algorithm = ALGORITHM }) {
  return { mouse, field, from, to, by, at, algorithm: `${algorithm.name} ${algorithm.version}${algorithm.method ? ` ${algorithm.method}` : ''}` };
}
