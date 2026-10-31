// Living Image (IVIS) export folders: the two text files, the calibration they carry, and counts to photons
// (spec 8.7). Pure: no DOM, no store. The image analysis on top of this is app/calc/bli.js.
//
// What a folder holds was checked on the public folders, not taken from a manual (docs/IVIS.md): one folder per
// acquisition ("click"), named after it (BMD20230209123405), with
//   AnalyzedClickInfo.txt   the acquisition settings and, once someone has drawn them, the ROIs
//   ClickInfo.txt           the same settings plus the camera's configuration: the radiance calibration
//                           ("Coef C-ccd at FOV 21.8, f1"), the flat-field polynomials, the saturation level
//   luminescent.TIF         16-bit counts, binned (240 x 240 at binning 8)
//   photograph.TIF          16-bit grey photograph, binned less (480 x 480 at binning 4)
//   readbias.TIF + background.TIF, or readbiasonly.TIF   the dark frames, sometimes stored times a "Data Multiplier"
// Both text files are lines of `Key:<TAB>Value`, grouped in sections that start `*** name:<TAB>value`. The
// camera block in ClickInfo.txt is the instrument's own configuration file pasted in, with # comments.
//
// The parser is written for this project from the files themselves (MIT), following the approach of the MIT
// labdataranger notebook; nothing from GPL tools (radianceQuantifier) is used, only the published idea.

/**
 * Read AnalyzedClickInfo.txt or ClickInfo.txt.
 * @param {string} text
 * @returns {{sections: {name: string, value: string, fields: Object<string,string>}[],
 *   field: (section: string, key: string) => string|null, all: Object<string,string>}}
 *   `field` looks a key up in the first section whose name starts with `section` (case-insensitive);
 *   `all` is every `Key: value` line of the file, the first occurrence of each key
 */
export function parseClickInfo(text) {
  const sections = [];
  const all = {};
  let cur = { name: '', value: '', fields: {} };
  sections.push(cur);
  for (const line of String(text || '').split(/\r\n|\n|\r/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const head = /^\*\*\*\s*([^:]+):\s*(.*)$/.exec(line);
    if (head) { cur = { name: head[1].trim(), value: head[2].trim(), fields: {} }; sections.push(cur); continue; }
    // Key:<TAB>Value. A few camera lines put a second colon in the value ("Version Number:\t:\t1.15").
    const m = /^([^\t:][^\t]*?):\s*\t\s*(.*)$/.exec(line) || /^([^:]+):\s+(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim(), value = m[2].replace(/\s+#.*$/, '').trim();
    if (!(key in cur.fields)) cur.fields[key] = value;
    if (!(key in all)) all[key] = value;
  }
  const field = (section, key) => {
    const s = sections.find((x) => x.name.toLowerCase().startsWith(section.toLowerCase()) && key in x.fields);
    return s ? s.fields[key] : null;
  };
  return { sections: sections.filter((s) => s.name || Object.keys(s.fields).length), field, all };
}

const num = (v) => { const n = Number(String(v ?? '').trim()); return v == null || String(v).trim() === '' || !Number.isFinite(n) ? null : n; };

/**
 * The ROIs drawn in Living Image, from the `*** ROIs:` section (`ROI 1:<TAB>Shape=Circle;Xc=…;Yc=…;…`).
 * Coordinates are in unbinned CCD pixels, as Living Image keeps them; `cmPerPixel` says how big one is.
 * Width and Height are the full extent (a circle's diameter), as the public folders show: the circles drawn
 * around a mouse's tumour are 190 pixels of 0.0114 cm, about 2.2 cm across.
 * @returns {{label: string, shape: string, xc: number, yc: number, width: number, height: number, angle: number,
 *   cmPerPixel: number|null, type: string}[]}
 */
export function parseRois(text) {
  const info = typeof text === 'string' ? parseClickInfo(text) : text;
  const sec = info.sections.find((s) => /^ROIs$/i.test(s.name));
  if (!sec) return [];
  const out = [];
  for (const [key, value] of Object.entries(sec.fields)) {
    if (!/^ROI\b/i.test(key)) continue;
    const kv = Object.fromEntries(value.split(';').map((p) => p.split('=')).filter((p) => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join('=').trim()]));
    const roi = { label: kv.Label || key, shape: String(kv.Shape || 'Square').toLowerCase(), xc: num(kv.Xc), yc: num(kv.Yc), width: num(kv.Width), height: num(kv.Height), angle: num(kv.Angle) || 0, cmPerPixel: num(kv['cm per pixel']), type: kv['ROI Type'] || '' };
    if ([roi.xc, roi.yc, roi.width, roi.height].every(Number.isFinite)) out.push(roi);
  }
  return out;
}

/**
 * The camera calibration in ClickInfo.txt: the radiance coefficient per field of view and f-stop, the
 * flat-field polynomial per shelf position and f-stop, the shelf positions' fields of view, and the CCD's
 * saturation level.
 * @returns {{cccd: {fov: number, f: number, coef: number}[], flatField: {shelf: string, f: number, k: number[], x0: number, y0: number}[],
 *   shelfFov: Object<string, number>, saturation: number|null, units: string|null, instrument: string|null}}
 */
export function parseCalibration(text) {
  const cccd = [], flatField = [], shelfFov = {};
  for (const line of String(text || '').split(/\r\n|\n|\r/)) {
    let m = /^Coef C-ccd at FOV\s*([\d.]+),\s*f\s*([\d.]+):\s*([-+\d.eE]+)/i.exec(line);
    if (m) { cccd.push({ fov: Number(m[1]), f: Number(m[2]), coef: Number(m[3]) }); continue; }
    m = /^Shelf Position\s+(\w+)\s+FF\d*\s+f\/(\d+)\s+Coefs:\s*(.+)$/i.exec(line);
    if (m) {
      const v = m[3].split(',').map((s) => Number(s.trim()));
      if (v.length >= 7 && v.every(Number.isFinite)) flatField.push({ shelf: m[1], f: Number(m[2]), k: v.slice(0, 5), x0: v[5], y0: v[6] });
      continue;
    }
    m = /^Shelf Position\s+(\w+)\s+FOV:\s*([\d.]+)/i.exec(line);
    if (m) shelfFov[m[1]] = Number(m[2]);
  }
  const all = parseClickInfo(text).all;
  return { cccd, flatField, shelfFov, saturation: num(all['CCD Saturation Level']), units: all['C-ccd Calibration units'] || null, instrument: all['System Configuration'] || all['Camera System ID'] || null };
}

/**
 * What an analysis needs to know about one acquisition, from AnalyzedClickInfo.txt (or ClickInfo.txt when that
 * is all there is). Fields missing from the file are null, never guessed.
 */
export function clickMeta(text) {
  const info = parseClickInfo(text);
  const f = (s, k) => info.field(s, k);
  const lumFile = info.sections.find((s) => /^luminescent image$/i.test(s.name))?.value || null;
  const dark = (name) => {
    const s = info.sections.find((x) => x.name.toLowerCase() === name);
    if (!s) return null;
    return { file: s.value || null, multiplier: num(s.fields['Data Multiplier']) || 1, exposure_s: num(s.fields['Background Exposure (Seconds)']), readBias: num(s.fields['Read Bias Level']) };
  };
  const user = info.sections.find((s) => /^User Label Name Set$/i.test(s.name))?.fields || {};
  return {
    clickNumber: info.sections.find((s) => /^ClickNumber$/i.test(s.name))?.value || null,
    version: info.all['Living Image Version'] || null,
    luminescent: lumFile == null ? null : {
      file: lumFile, binning: num(f('luminescent image', 'Binning Factor')), exposure_s: num(f('luminescent image', 'Luminescent Exposure (Seconds)')),
      fNumber: num(f('luminescent image', 'f Number')), fov_cm: num(f('luminescent image', 'Field of View')), readBias: num(f('luminescent image', 'Read Bias Level')),
      units: f('luminescent image', 'Image Units'), backgroundCorrected: num(f('luminescent image', 'Background Corrected')) === 1, flatFieldCorrected: num(f('luminescent image', 'Flat Field Corrected')) === 1,
      cosmicCorrected: num(f('luminescent image', 'Cosmic Corrected')) === 1, date: f('luminescent image', 'Acquisition Date'), time: f('luminescent image', 'Acquisition Time'),
    },
    photograph: info.sections.some((s) => /^photographic image$/i.test(s.name)) ? {
      file: info.sections.find((s) => /^photographic image$/i.test(s.name)).value, binning: num(f('photographic image', 'Binning Factor')),
      exposure_s: num(f('photographic image', 'Exposure Time Sec')), fNumber: num(f('photographic image', 'f Number')), fov_cm: num(f('photographic image', 'Field of View')),
    } : null,
    dark: { readbias: dark('readbias image'), darkcharge: dark('darkcharge image'), readbiasonly: dark('readbiasonly image') },
    labels: Object.fromEntries(Object.entries(user).filter(([, v]) => v)),
    comment: user.Comment1 || '',
    view: user.View || '',
    rois: parseRois(info),
  };
}

/** The radiance coefficient for a field of view and f-stop: the f-stop must match, the nearest FOV is taken. */
export function cccdFor(cal, fov, fNumber) {
  const same = (cal?.cccd || []).filter((c) => c.f === fNumber);
  if (!same.length || !Number.isFinite(fov)) return null;
  return same.reduce((a, b) => (Math.abs(b.fov - fov) < Math.abs(a.fov - fov) ? b : a));
}

/** The flat-field polynomial for a field of view and f-stop, by the shelf position whose FOV is nearest. */
export function flatFieldFor(cal, fov, fNumber) {
  const shelves = Object.entries(cal?.shelfFov || {});
  if (!shelves.length || !Number.isFinite(fov)) return null;
  const [shelf] = shelves.reduce((a, b) => (Math.abs(b[1] - fov) < Math.abs(a[1] - fov) ? b : a));
  return (cal.flatField || []).find((c) => c.shelf === shelf && c.f === fNumber) || null;
}

/**
 * The flat-field factor at a point, ff(r) = k0 + k1 r + k2 r² + k3 r³ + k4 r⁴, r in cm from the optical centre
 * (the image centre moved by x0, y0 cm), as the configuration's comment block defines it. A pixel's counts are
 * divided by it: ff falls towards the edge of the field (vignetting), where the lens collects less light.
 */
export function flatFieldAt(ff, xCm, yCm) {
  if (!ff) return 1;
  const r = Math.hypot(xCm - ff.x0, yCm - ff.y0);
  const [k0, k1, k2, k3, k4] = ff.k;
  const v = k0 + r * (k1 + r * (k2 + r * (k3 + r * k4)));
  return v > 0.05 ? v : 0.05;
}

/**
 * The dark frame to subtract, per luminescent pixel, and what it was. In order of preference: the dark-charge
 * image taken at the same exposure (it holds the read bias as well, as its values show), the read-bias-only
 * frame, the read-bias frame, or the single Read Bias Level number. Frames are divided by their Data Multiplier.
 * @param {object} meta   clickMeta()
 * @param {Object<string, {data: ArrayLike<number>, width: number, height: number}>} images   by lower-case file name
 * @returns {{values: Float64Array|null, level: number|null, source: string}}
 */
export function darkFrame(meta, images, n) {
  const pick = (d) => (d?.file ? images[String(d.file).toLowerCase()] : null);
  const lumExp = meta.luminescent?.exposure_s;
  const tries = [
    [meta.dark.darkcharge, (d) => d.exposure_s == null || lumExp == null || Math.abs(d.exposure_s - lumExp) < 1e-6 * Math.max(1, lumExp), 'dark charge image'],
    [meta.dark.readbiasonly, () => true, 'read-bias image'],
    [meta.dark.readbias, () => true, 'read-bias image'],
  ];
  for (const [d, ok, source] of tries) {
    const img = pick(d);
    if (img && img.data.length === n && ok(d)) {
      const values = new Float64Array(n), mult = d.multiplier || 1;
      for (let i = 0; i < n; i++) values[i] = img.data[i] / mult;
      return { values, level: null, source: `${source} (${d.file}${mult !== 1 ? `, ÷${mult}` : ''})` };
    }
  }
  const level = meta.luminescent?.readBias ?? meta.dark.readbiasonly?.readBias ?? meta.dark.darkcharge?.readBias ?? null;
  return { values: null, level, source: level != null ? `read bias level ${level}` : 'none' };
}

/**
 * Counts to photons. Total flux (p/s) from one binned luminescent pixel holding `c` dark-corrected counts:
 *
 *   flux = c × C_ccd / t × (cm per unbinned pixel)² × 4π / ff
 *
 * C_ccd turns counts per second in one unbinned pixel into radiance (p/s/cm²/sr); a binned pixel gathers b²
 * unbinned ones, so its radiance is c·C/(t·b²), and its area is b² unbinned pixels: the binning cancels, which
 * is why the flux does not depend on it. Times 4π steradians, as Living Image reports "total flux". The
 * exposure divides out too. ff is the flat-field factor at the pixel (flatFieldAt).
 *
 * @param {object} o
 * @param {object} o.meta     clickMeta()
 * @param {object} o.cal      parseCalibration()
 * @param {{width, height, data}} o.lum   the luminescent image
 * @param {object} o.images   every image of the folder by lower-case file name (for the dark frame)
 * @param {boolean} [o.flatField=true]
 * @param {boolean} [o.cosmic=true]   replace isolated hot pixels (cosmic rays) by their neighbours' median
 * @returns {{flux: Float64Array, counts: Float64Array, width, height, cmPerPixel: number, binnedCm: number, factor: number,
 *   cccd: object|null, ff: object|null, dark: string, saturated: Uint8Array, saturation: number|null, notes: string[], cosmicFixed: number}}
 *   `flux` is p/s per binned pixel; `cmPerPixel` is per unbinned pixel, `binnedCm` per luminescent pixel
 */
export function fluxImage({ meta, cal, lum, images = {}, flatField = true, cosmic = true }) {
  const notes = [];
  const L = meta.luminescent;
  if (!L) throw new Error('fluxImage: the folder has no luminescent image settings');
  const { width: w, height: h } = lum;
  const n = w * h;
  const b = L.binning || 1;
  const fov = L.fov_cm;
  const cmPerPixel = fov / (w * b);
  const binnedCm = cmPerPixel * b;
  const c = cccdFor(cal, fov, L.fNumber);
  if (!c) notes.push(`No radiance calibration for FOV ${fov} cm at f/${L.fNumber}: values are counts per second, not photons.`);
  if (L.units && !/counts/i.test(L.units)) notes.push(`The image is in ${L.units}, not counts: it is used as it is.`);
  if (L.backgroundCorrected) notes.push('Living Image had already subtracted the background: no dark frame is subtracted again.');
  const dark = L.backgroundCorrected ? { values: null, level: 0, source: 'already corrected' } : darkFrame(meta, images, n);
  const exposure = L.exposure_s || 1;
  const factor = (c ? c.coef : 1) / exposure * cmPerPixel * cmPerPixel * 4 * Math.PI;
  const ff = flatField && !L.flatFieldCorrected ? flatFieldFor(cal, fov, L.fNumber) : null;
  if (flatField && !ff && !L.flatFieldCorrected) notes.push('No flat-field correction in the camera file: edge pixels read low.');
  const counts = new Float64Array(n);
  const saturated = new Uint8Array(n);
  const sat = cal?.saturation ?? null;
  for (let i = 0; i < n; i++) {
    const raw = lum.data[i];
    if (sat != null && raw >= sat) saturated[i] = 1;
    counts[i] = raw - (dark.values ? dark.values[i] : dark.level || 0);
  }
  let cosmicFixed = 0;
  if (cosmic) cosmicFixed = removeCosmics(counts, w, h);
  const flux = new Float64Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const f = ff ? flatFieldAt(ff, ((x + 0.5) - w / 2) * binnedCm, ((y + 0.5) - h / 2) * binnedCm) : 1;
    flux[i] = counts[i] * factor / f;
  }
  return { flux, counts, width: w, height: h, cmPerPixel, binnedCm, factor, cccd: c, ff, dark: dark.source, saturated, saturation: sat, notes, cosmicFixed };
}

/**
 * Cosmic rays and hot pixels: a single pixel far above all eight neighbours, which no light spread by tissue
 * can make (a real source is blurred over several pixels). Replaced in place by the neighbours' median.
 * "Far above" is 6 noise widths over the neighbours' highest value, the noise taken from the image's
 * darkest half. Returns how many were replaced.
 */
export function removeCosmics(counts, w, h) {
  const sample = [];
  for (let i = 0; i < counts.length; i += 7) sample.push(counts[i]);
  sample.sort((a, b) => a - b);
  const half = sample.slice(0, sample.length >> 1);
  const med = half[half.length >> 1] ?? 0;
  const mad = half.map((v) => Math.abs(v - med)).sort((a, b) => a - b)[half.length >> 1] || 1;
  const noise = 1.4826 * mad;
  const fix = [];
  const nb = new Array(8);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, v = counts[i];
    let k = 0, top = -Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; const u = counts[i + dy * w + dx]; nb[k++] = u; if (u > top) top = u; }
    if (v > top + 6 * noise && v > 2 * Math.max(top, noise)) { nb.sort((a, b) => a - b); fix.push([i, (nb[3] + nb[4]) / 2]); }
  }
  for (const [i, v] of fix) counts[i] = v;
  return fix.length;
}

/**
 * The flux inside a Living Image ROI (ellipse for Circle/Ellipse, rectangle otherwise; rotation ignored, as
 * every public ROI has Angle 0). Each luminescent pixel counts with the share of it inside the ROI, sampled
 * 4 × 4, so a ROI edge through a pixel takes part of it, as Living Image does.
 * @param {{flux: Float64Array, width: number, height: number}} img   fluxImage()
 * @param {object} roi   parseRois() entry, in unbinned pixels
 * @param {number} binning   of the luminescent image
 */
export function roiFlux(img, roi, binning) {
  const { flux, width: w, height: h } = img;
  const cx = roi.xc / binning, cy = roi.yc / binning, rx = roi.width / 2 / binning, ry = roi.height / 2 / binning;
  const ellipse = /circle|ellipse|oval/.test(roi.shape);
  const inside = (x, y) => (ellipse ? ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1 : Math.abs(x - cx) <= rx && Math.abs(y - cy) <= ry);
  let sum = 0, area = 0;
  const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(w - 1, Math.ceil(cx + rx)), y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(h - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    let k = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) k++;
    if (!k) continue;
    sum += flux[y * w + x] * k / 16; area += k / 16;
  }
  return { flux: sum, pixels: area };
}

/** The animal ids written in a click's Comment1 ("579G 580G 581G"), in the order written. */
export function animalIdsFromComment(comment) {
  return String(comment || '').split(/[\s,;/]+/).map((s) => s.trim()).filter(Boolean);
}

/** Dorsal or ventral, from the View label, the comment or the folder name; null when nothing says. */
export function viewFrom(...texts) {
  for (const t of texts) {
    const s = String(t || '');
    if (/\bventr|\bvent\b|\bbauch|\bsupine\b/i.test(s)) return 'ventral';
    if (/\bdors|\bback\b|\brücken|\bprone\b/i.test(s)) return 'dorsal';
  }
  return null;
}

/**
 * Group the files of an upload (a folder picked with webkitdirectory, or files dropped) into acquisitions: one
 * per folder that holds a luminescent.TIF and an AnalyzedClickInfo.txt or ClickInfo.txt.
 * @param {{path: string, name?: string}[]} files   `path` is the relative path (webkitRelativePath) or the name
 * @returns {{folder: string, files: Object<string, object>}[]}   files keyed by lower-case base name
 */
export function groupClickFolders(files) {
  const by = new Map();
  for (const f of files) {
    const p = String(f.path || f.name || '').replace(/\\/g, '/');
    const i = p.lastIndexOf('/');
    const dir = i >= 0 ? p.slice(0, i) : '';
    const base = (i >= 0 ? p.slice(i + 1) : p).toLowerCase();
    if (!by.has(dir)) by.set(dir, {});
    by.get(dir)[base] = f;
  }
  return [...by.entries()]
    .filter(([, fs]) => fs['luminescent.tif'] && (fs['analyzedclickinfo.txt'] || fs['clickinfo.txt']))
    .map(([folder, fs]) => ({ folder, files: fs }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
}
