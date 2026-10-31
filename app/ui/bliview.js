// IVIS images in a study (spec 8.7): pick a Living Image export folder, see the mice the app found, numbered
// left to right with their masks and liver ROIs over the photograph, check and correct, assign each mouse to
// an animal and group of the study (suggested from the comment or the plan, confirmed in one click), save.
//
// The folder is read in the browser (a directory picker: <input type=file webkitdirectory>, which the macOS
// app's web view offers as its file dialog). Nothing is uploaded anywhere. The images themselves are not copied
// into the database, which would grow by a megabyte per acquisition: each file is recorded by its path inside
// the picked folder and its SHA-256, so the original can be found and proven unchanged; the record keeps what
// the spec asks to keep per mouse (crop, mask, ROI values, algorithm version) and every correction made here.
import { esc, raw, table, toast, chip, field } from './kit.js';
import { readTiff } from '../calc/tiff.js';
import { clickMeta, parseCalibration, groupClickFolders, animalIdsFromComment, viewFrom } from '../calc/ivis.js';
import { analyseClick, METHODS, DEFAULT_METHOD, moveLiver, logCorrection, decodeMask } from '../calc/bli.js';
import { suggestAnimals, bliToMeasurements } from '../calc/bio.js';
import { sha256 } from '../calc/sha256.js';
import { provenance } from '../calc/provenance.js';
import { getSettings } from '../refdata.js';

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sci = (x) => (Number.isFinite(x) ? x.toExponential(2) : '–');
const latin1 = (bytes) => new TextDecoder('windows-1252').decode(bytes);

/** Read and analyse one click folder: {folder, files: {name: File}} → everything the card needs. */
export async function readClick({ folder, files }, { method = DEFAULT_METHOD, expected = null } = {}) {
  const images = {}, recs = [];
  let analyzed = '', click = '';
  for (const [name, f] of Object.entries(files)) {
    if (!/\.(tif|tiff|txt)$/i.test(name)) continue;
    const bytes = new Uint8Array(await f.arrayBuffer());
    recs.push({ name: f.name || name, size: bytes.length, sha256: hex(sha256(bytes)) });
    if (/\.tiff?$/i.test(name)) { try { images[name] = readTiff(bytes); } catch (err) { recs[recs.length - 1].error = err.message; } }
    else if (name === 'analyzedclickinfo.txt') analyzed = latin1(bytes);
    else if (name === 'clickinfo.txt') click = latin1(bytes);
  }
  const meta = clickMeta(analyzed || click);
  const cal = parseCalibration(click);
  const ids = animalIdsFromComment(meta.comment);
  const analysis = analyseClick({ meta, cal, images, method, expected: expected ?? (ids.length || null) });
  // Files picked one by one have no folder: the click number names the acquisition then.
  const name = folder === '(files)' && meta.clickNumber ? meta.clickNumber : folder;
  return { folder: name, files: recs, meta, cal, ids, images, analysis, view: viewFrom(meta.view, meta.comment, folder) };
}

/** The overlay: photograph, luminescence as a warm tint, every mouse's outline and number, liver ROIs. */
export function drawOverlay(canvas, item, selected = null) {
  const { images, analysis: a, meta } = item;
  const photo = images[String(meta.photograph?.file || 'photograph.tif').toLowerCase()] || images['photograph.tif'];
  const w = photo.width, h = photo.height;
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  const img = g.createImageData(w, h);
  const sorted = Array.from(photo.data).sort((x, y) => x - y);
  const hi = sorted[Math.floor(sorted.length * 0.995)] || 1;
  const f = a.fluxImg, geo = a.geo;
  let mx = 0;
  for (const v of f.flux) if (v > mx) mx = v;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, gr = Math.min(255, Math.round(255 * photo.data[i] / hi));
    let r = gr, gg = gr, b = gr;
    const lx = Math.floor((x - geo.ox) / geo.kx), ly = Math.floor((y - geo.oy) / geo.kx);
    if (lx >= 0 && ly >= 0 && lx < f.width && ly < f.height && mx > 0) {
      const v = Math.sqrt(Math.max(0, f.flux[ly * f.width + lx]) / mx);
      if (v > 0.06) { r = Math.min(255, gr * (1 - v) + 255 * v); gg = Math.min(255, gr * (1 - v) + 200 * v * v); b = gr * (1 - v); }
    }
    img.data.set([r, gg, b, 255], 4 * i);
  }
  g.putImageData(img, 0, 0);
  const colours = ['#2a78d6', '#1baf7a', '#eda100', '#e87ba4', '#6250d6', '#eb6834', '#008300', '#e34948'];
  for (const m of a.mice) {
    const c = colours[(m.n - 1) % colours.length];
    const mk = decodeMask(m.mask, m.bbox), bw = m.bbox.x1 - m.bbox.x0 + 1, bh = m.bbox.y1 - m.bbox.y0 + 1;
    g.fillStyle = c;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      if (!mk[y * bw + x]) continue;
      const edge = x === 0 || y === 0 || x === bw - 1 || y === bh - 1 || !mk[y * bw + x - 1] || !mk[y * bw + x + 1] || !mk[(y - 1) * bw + x] || !mk[(y + 1) * bw + x];
      if (edge) g.fillRect(m.bbox.x0 + x, m.bbox.y0 + y, 1, 1);
    }
    const L = m.liver;
    g.strokeStyle = m.n === selected ? '#ffffff' : 'rgba(255,255,255,.75)';
    g.lineWidth = m.n === selected ? 2.5 : 1.2;
    g.setLineDash(L.source === 'auto' ? [4, 3] : []);
    g.beginPath(); g.ellipse(L.cx, L.cy, Math.max(1, L.rx), Math.max(1, L.ry), L.angle, 0, 2 * Math.PI); g.stroke();
    g.setLineDash([]);
    const tx = (m.bbox.x0 + m.bbox.x1) / 2, ty = Math.max(14, m.bbox.y0 - 4);
    g.font = 'bold 16px -apple-system, system-ui, sans-serif'; g.textAlign = 'center';
    g.lineWidth = 3; g.strokeStyle = '#000'; g.strokeText(String(m.n), tx, ty); g.fillStyle = c; g.fillText(String(m.n), tx, ty);
    if (m.n === selected) { g.strokeStyle = c; g.lineWidth = 2; g.strokeRect(m.bbox.x0 - 2, m.bbox.y0 - 2, bw + 4, bh + 4); }
  }
}

/**
 * Mount the IVIS part of a study.
 * @param {HTMLElement} body
 * @param {object} ctx
 * @param {object} st   the study
 * @param {() => void} redraw
 */
export function mountBli(body, ctx, st, redraw) {
  const saved = ctx.store.all('bliImages').filter((b) => b.studyId === st.id);
  const tp = st.context?.invivo?.timepoint_h ?? '';
  body.innerHTML = `<div class="card" id="bliCard"><h2>IVIS images</h2>
    <p class="muted" style="margin-top:0">Pick the Living Image export folder (one folder per acquisition, or a folder holding several): the app finds the mice on the photograph, numbers them left to right, measures the total flux over each mouse and a liver ROI, and checks for saturation. Check the overlay, correct what is wrong (click a mouse's row, then click on the image to move its liver ROI), confirm the animals and save. The files stay where they are; the study records their names and SHA-256.</p>
    <div class="grid g4">
      <div><label for="bliDir">Export folder</label><input type="file" id="bliDir" webkitdirectory directory multiple></div>
      <div><label for="bliFiles">or the files of one folder</label><input type="file" id="bliFiles" multiple accept=".tif,.TIF,.txt"></div>
      ${field({ id: 'bliTp', label: 'Timepoint (h)', type: 'number', value: tp })}
      ${field({ id: 'bliMethod', label: 'Method', type: 'select', value: DEFAULT_METHOD, options: METHODS.map((m) => ({ value: m.id, label: m.label })) })}
      ${field({ id: 'bliCount', label: 'Mice per image', type: 'number', value: '', placeholder: 'from the comment', hint: 'Blank: the ids in the Living Image comment, or an estimate from size.' })}
    </div>
    <div id="bliItems"></div></div>
    <div class="card"><h2>Images saved in this study</h2>${table(['Folder', 'Acquired', 'View', { label: 'Mice', right: true }, 'Algorithm', { label: 'Corrections', right: true }],
      saved.map((b) => ({ cells: [b.folder, b.meta?.date || '–', b.view || '–', (b.mice || []).length, b.algorithm ? `${b.algorithm.version} ${b.algorithm.method}` : '–', (b.corrections || []).length] })), { empty: 'None yet.' })}</div>`;
  const itemsBox = body.querySelector('#bliItems');
  const load = async (fileList) => {
    const files = [...fileList].map((f) => ({ path: f.webkitRelativePath || f.name, name: f.name, file: f }));
    const groups = groupClickFolders(files).map((g) => ({ folder: g.folder || '(files)', files: Object.fromEntries(Object.entries(g.files).map(([k, v]) => [k, v.file])) }));
    if (!groups.length) { itemsBox.innerHTML = '<div class="note warn">No acquisition found: a folder needs luminescent.TIF and AnalyzedClickInfo.txt or ClickInfo.txt.</div>'; return; }
    itemsBox.innerHTML = `<p class="muted">Reading ${groups.length} acquisition${groups.length === 1 ? '' : 's'} …</p>`;
    const method = body.querySelector('#bliMethod').value;
    const count = Number(body.querySelector('#bliCount').value) || null;
    const items = [];
    for (const gr of groups) {
      try { items.push(await readClick(gr, { method, expected: count })); } catch (err) { items.push({ folder: gr.folder, error: err.message }); }
    }
    itemsBox.innerHTML = '';
    items.forEach((it, k) => itemCard(itemsBox, ctx, st, it, k, () => body.querySelector('#bliTp').value, redraw));
  };
  body.querySelector('#bliDir').addEventListener('change', (e) => e.target.files?.length && load(e.target.files));
  body.querySelector('#bliFiles').addEventListener('change', (e) => e.target.files?.length && load(e.target.files));
}

/** One acquisition: overlay, mice table with suggestions, corrections, and Save. */
function itemCard(box, ctx, st, it, k, timepoint, redraw) {
  const wrap = document.createElement('div');
  wrap.className = 'bliItem';
  wrap.style.cssText = 'border-top:1px solid var(--line);margin-top:12px;padding-top:12px';
  box.appendChild(wrap);
  if (it.error) { wrap.innerHTML = `<div class="note warn"><b>${esc(it.folder)}</b>: ${esc(it.error)}</div>`; return; }
  const a = it.analysis;
  const corrections = [];
  const operator = getSettings(ctx).operator || '';
  // Suggestions: the comment's ids left to right, else the next animals of the plan without a value yet.
  const ms = ctx.store.all('bioMeasurements').filter((m) => m.studyId === st.id);
  const known = new Map(ms.filter((m) => m.subject).map((m) => [m.subject, m.group]));
  const taken = new Set(ms.filter((m) => m.quantity === 'total_flux').map((m) => m.subject));
  const sugg = suggestAnimals(st, a.mice.length, { ids: it.ids, taken, known });
  a.mice.forEach((m, i) => { m.subject = sugg[i].subject; m.group = sugg[i].group; m.suggested = { ...sugg[i] }; });
  let view = it.view || '';
  let selected = a.mice[0]?.n ?? null;
  const groupOpts = (cur) => `<option value="">–</option>` + (st.groups || []).map((g) => `<option value="${esc(g.id)}" ${g.id === cur ? 'selected' : ''}>${esc(g.name || g.id)}</option>`).join('');
  const draw = () => {
    const L = it.meta.luminescent || {};
    const warns = a.mice.flatMap((m) => m.warnings.map((w) => `Mouse ${m.n}: ${w}`));
    wrap.innerHTML = `<h3 style="margin:0 0 6px">${esc(it.folder)} <span class="muted" style="font-weight:400">· ${esc(L.date || '')} ${esc(L.time || '')} · ${a.mice.length} mice · exposure ${esc(L.exposure_s ?? '–')} s, binning ${esc(L.binning ?? '–')}, f/${esc(L.fNumber ?? '–')}, FOV ${esc(L.fov_cm ?? '–')} cm${it.meta.version ? ` · Living Image ${esc(it.meta.version.split(' ')[0])}` : ''}</span></h3>
      <div class="grid g2"><div><canvas class="bliCanvas" style="width:100%;max-width:480px;cursor:crosshair;border-radius:8px;display:block" aria-label="Photograph with the mice found, numbered left to right"></canvas>
        <p class="muted" style="font-size:12px">Outlines: the masks the flux is summed over. Ellipses: liver ROIs (dashed as found, solid when moved). Warm tint: luminescence. Click a row, then the image, to move that mouse's liver ROI.</p></div>
      <div>
        <div class="grid g2">${field({ id: `bliView${k}`, label: 'View', type: 'select', value: view, options: [{ value: '', label: 'not stated' }, 'dorsal', 'ventral'] })}
          <div><label>Found by</label><div class="muted">${esc(a.algorithm.name)} ${esc(a.algorithm.version)}, ${esc(a.algorithm.method)}; ${esc(a.conversion.dark)}; flat field ${esc(a.conversion.flatField)}</div></div></div>
        ${table(['', '#', 'Animal', 'Group', { label: 'Total flux (p/s)', right: true }, { label: 'Liver ROI (p/s)', right: true }, 'Correct flux', 'Leave out'], a.mice.map((m) => ({
          attrs: `data-mouse="${m.n}"${m.n === selected ? ' class="sel"' : ''}`,
          cells: [
            raw(`<input type="radio" name="bliSel${k}" value="${m.n}" ${m.n === selected ? 'checked' : ''} aria-label="Select mouse ${m.n}" style="width:auto">`),
            m.n,
            raw(`<input type="text" data-f="subject" value="${esc(m.subject || '')}" aria-label="Animal of mouse ${m.n}" style="width:90px">${m.suggested.from === 'comment' ? ' <span class="muted" title="From the comment in Living Image">c</span>' : ''}`),
            raw(`<select data-f="group" aria-label="Group of mouse ${m.n}">${groupOpts(m.group)}</select>`),
            raw(`${sci(m.totalFluxManual ?? m.totalFlux)}${m.totalFluxManual != null ? ' ' + chip('corrected', 'info') : ''}${m.saturatedPixels ? ' ' + chip('saturated', 'warn') : ''}`),
            sci(m.liver.flux),
            raw(`<input type="number" step="any" data-f="manual" value="${esc(m.totalFluxManual ?? '')}" placeholder="p/s" aria-label="Corrected flux of mouse ${m.n}" style="width:100px">`),
            raw(`<input type="checkbox" data-f="excluded" ${m.excluded ? 'checked' : ''} aria-label="Leave mouse ${m.n} out" style="width:auto">`),
          ] })))}
        ${warns.length || a.notes.length ? `<div class="note ${warns.length ? 'warn' : ''}" style="margin-top:8px">${[...warns, ...a.notes].map((w) => `<div>${esc(w)}</div>`).join('')}</div>` : ''}
        <p style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="primary" data-bli-save>Confirm and save</button><span class="muted">${corrections.length ? `${corrections.length} correction${corrections.length === 1 ? '' : 's'} logged` : 'Suggested from ' + (it.ids.length === a.mice.length ? 'the comment in Living Image' : 'the study plan, by position')}</span></p>
      </div></div>`;
    const canvas = wrap.querySelector('canvas');
    drawOverlay(canvas, it, selected);
    canvas.addEventListener('click', (e) => {
      if (selected == null) return;
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) * canvas.width / r.width, y = (e.clientY - r.top) * canvas.height / r.height;
      const m = a.mice.find((q) => q.n === selected);
      const moved = moveLiver(a, selected, x, y);
      if (!m || !moved) return;
      corrections.push(logCorrection({ mouse: m.n, field: 'liver', from: { cx: Math.round(m.liver.cx), cy: Math.round(m.liver.cy), flux: m.liver.flux }, to: { cx: Math.round(x), cy: Math.round(y), flux: moved.flux }, by: operator, algorithm: a.algorithm }));
      m.liver = moved;
      draw();
    });
    wrap.querySelectorAll(`[name="bliSel${k}"]`).forEach((r) => r.addEventListener('change', () => { selected = Number(r.value); draw(); }));
    wrap.querySelector(`[name="bliView${k}"]`).addEventListener('change', (e) => { view = e.target.value; });
    wrap.querySelectorAll('tr[data-mouse]').forEach((tr) => tr.addEventListener('change', (e) => {
      const m = a.mice.find((q) => q.n === Number(tr.dataset.mouse));
      const f = e.target.dataset.f;
      if (!m || !f) return;
      const before = f === 'manual' ? m.totalFluxManual ?? null : f === 'excluded' ? !!m.excluded : m[f];
      const v = f === 'excluded' ? e.target.checked : f === 'manual' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value.trim();
      if (f === 'manual') m.totalFluxManual = v; else m[f] = v;
      corrections.push(logCorrection({ mouse: m.n, field: f === 'manual' ? 'totalFlux' : f, from: f === 'manual' ? (before ?? m.totalFlux) : before, to: v, by: operator, algorithm: a.algorithm }));
      if (f === 'manual' || f === 'excluded') draw();
    }));
    wrap.querySelector('[data-bli-save]').addEventListener('click', () => save());
  };
  const save = () => {
    const tpv = timepoint();
    const lumFile = it.files.find((f) => /^luminescent\.tif$/i.test(f.name));
    const image = {
      id: `bli:${st.id}:${it.meta.clickNumber || it.folder}`, studyId: st.id, folder: it.folder, clickNumber: it.meta.clickNumber,
      files: it.files, view, timepoint_h: tpv === '' || tpv == null ? null : Number(tpv),
      meta: { date: it.meta.luminescent?.date || '', time: it.meta.luminescent?.time || '', exposure_s: it.meta.luminescent?.exposure_s, binning: it.meta.luminescent?.binning, fNumber: it.meta.luminescent?.fNumber, fov_cm: it.meta.luminescent?.fov_cm, version: it.meta.version, instrument: it.cal.instrument, comment: it.meta.comment },
      algorithm: a.algorithm, conversion: a.conversion, background: a.background, threshold: a.threshold, notes: a.notes,
      photo: a.photo,
      mice: a.mice.map((m) => ({ n: m.n, bbox: m.bbox, areaCm2: m.areaCm2, mask: m.mask, crop: m.crop, axis: { angle: m.axis.angle, lengthCm: m.axis.lengthCm, widthCm: m.axis.widthCm, headFrom: m.axis.headFrom }, totalFlux: m.totalFlux, grossFlux: m.grossFlux, totalFluxManual: m.totalFluxManual ?? null, liver: m.liver, backgroundOverMouse: m.backgroundOverMouse, saturatedPixels: m.saturatedPixels, warnings: m.warnings, subject: m.subject, group: m.group, suggested: m.suggested, excluded: !!m.excluded })),
      // Every correction made here, with the algorithm version it corrected, kept for later training data.
      corrections: [...(ctx.store.get('bliImages', `bli:${st.id}:${it.meta.clickNumber || it.folder}`)?.corrections || []), ...corrections],
      provenance: provenance('instrument-import', lumFile ? { file: { name: `${it.folder}/${lumFile.name}`, sha256: lumFile.sha256 } } : {}),
    };
    const missing = image.mice.filter((m) => !m.excluded && (!m.subject || !m.group));
    if (missing.length) { toast(`Mouse ${missing.map((m) => m.n).join(', ')}: give an animal and a group, or leave it out`, 'warn'); return; }
    const out = bliToMeasurements({ study: st, image, provenance: image.provenance });
    ctx.store.transaction(() => {
      ctx.store.put('bliImages', image);
      for (const m of out) ctx.store.put('bioMeasurements', m);
    }, { what: `the image ${it.folder}` });
    toast(`Saved ${out.length} values from ${it.folder}`, 'ok');
    wrap.innerHTML = `<p class="muted">${esc(it.folder)}: saved, ${out.length} values${corrections.length ? `, ${corrections.length} corrections logged` : ''}.</p>`;
  };
  draw();
}

