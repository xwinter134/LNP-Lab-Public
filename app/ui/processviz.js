// The process designer: the schematic of how a formulation is made, and the form that sets it.
//
// One process object (calc/process.js) is drawn and edited here wherever it is planned: the experiment wizard,
// the experiment page (for the formulations still to make) and each formulation's record. The drawing reads
// left to right the way the liquid goes — the pumps or syringes, the mixer, the quench junction, the collected
// raw colloid, each downstream step in order, the final product — so a process can be checked at a glance
// against the bench before anything is weighed out. Like the other charts it is an SVG string that takes its
// colours from the page's tokens (var(--…)), so it follows light and dark mode, and printSvg() (charts.js)
// turns it into the light version for the worksheet and the report.
//
// The form is plain fields named pr_…; the screen that shows it hands every change to applyProcessField() and
// redraws. Nothing here stores anything: the screen owns its record and saves it the way it saves the rest.
import { esc, fmt } from './kit.js';
import { normaliseRoles } from '../calc/buffer.js';
import {
  PROCESS_STEPS, LAB_PROCESS, stepName, deviceOf, mixerOf, entryName, mixersFor, quenchMode, driveOf, chooseDevice, withBuffer, refreshIonic, bufferLine,
} from '../calc/process.js';

/* ---------------- the drawing ---------------- */

const C = { aq: 'var(--s1)', lip: 'var(--s4)', q: 'var(--s3)', prod: 'var(--s7)', ink: 'var(--ink)', ink2: 'var(--ink2)', line: 'var(--line-strong)', card: 'var(--card)', bg: 'var(--bg)' };
const FONT = 'font-family="-apple-system, system-ui, Helvetica, Arial, sans-serif"';
/** Text cut to what fits a slot, with the whole of it as the tooltip. */
const fit = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const text = (x, y, s, { size = 11, fill = C.ink, weight = 400, anchor = 'start', max = 40 } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}">${esc(fit(s, max))}${String(s ?? '').length > max ? `<title>${esc(s)}</title>` : ''}</text>`;
const arrow = (x, y, color, dir = 'right') => {
  const d = dir === 'right' ? `M${x - 7},${y - 4.5} L${x},${y} L${x - 7},${y + 4.5} Z` : dir === 'up' ? `M${x - 4.5},${y + 7} L${x},${y} L${x + 4.5},${y + 7} Z` : `M${x - 4.5},${y - 7} L${x},${y} L${x + 4.5},${y - 7} Z`;
  return `<path d="${d}" fill="${color}"/>`;
};
const pipe = (d, color, w = 2.4) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

/** A pump head (a circle with its rotor) or a syringe (barrel, plunger, liquid in the phase's colour). */
function source(x, y, color, drive) {
  if (drive === 'syringe') {
    return `<g><rect x="${x - 17}" y="${y - 7}" width="30" height="14" rx="2" fill="${C.card}" stroke="${C.ink2}" stroke-width="1.3"/>
      <rect x="${x - 4}" y="${y - 5}" width="15" height="10" fill="${color}" opacity=".55"/>
      <path d="M${x - 4},${y - 6} V${y + 6} M${x - 4},${y} H${x - 25} M${x - 25},${y - 6} V${y + 6}" stroke="${C.ink2}" stroke-width="1.6" fill="none"/>
      <path d="M${x + 13},${y} H${x + 19}" stroke="${C.ink2}" stroke-width="1.6"/></g>`;
  }
  return `<g><circle cx="${x}" cy="${y}" r="13" fill="${C.card}" stroke="${color}" stroke-width="2.2"/>
    <path d="M${x - 6},${y + 5} L${x},${y - 7} L${x + 6},${y + 5} Z" fill="${color}"/></g>`;
}

/**
 * The mixer, drawn by kind, centred on (x, y): its two inlets arrive from above and below (T-mixer, IJM) or from
 * the left (a chip), and the outlet leaves to the right at x + 26. Returns { svg, inA, inB } with the points the
 * aqueous and lipid lines run to.
 */
function mixerShape(kind, x, y) {
  if (/chip/i.test(kind || '')) {
    const w = 52, h = 30, l = x - w / 2 - 4;
    // a channel that meanders, which is what a chip's mixing section is, whatever its exact pattern
    const ch = `M${l + 6},${y - 7} H${l + 14} V${y + 7} H${l + 22} V${y - 7} H${l + 30} V${y + 7} H${l + 38} V${y - 7} H${l + 46} V${y} H${l + w + 4}`;
    return { svg: `<rect x="${l}" y="${y - h / 2}" width="${w + 4}" height="${h}" rx="5" fill="${C.card}" stroke="${C.ink2}" stroke-width="1.4"/>${pipe(ch, C.prod, 1.6)}
        ${pipe(`M${l},${y - 7} H${l + 6}`, C.aq, 2)}${pipe(`M${l},${y + 7} H${l + 6}`, C.lip, 2)}`,
      inA: [l, y - 7], inB: [l, y + 7], via: 'left', out: x + 26 };
  }
  if (/IJM|imping/i.test(kind || '')) {
    // a small chamber with the two jets meeting head-on in the middle
    return { svg: `<rect x="${x - 13}" y="${y - 15}" width="26" height="30" rx="4" fill="${C.card}" stroke="${C.ink2}" stroke-width="1.4"/>
        <path d="M${x - 3.5},${y - 15} L${x},${y - 4} L${x + 3.5},${y - 15} Z" fill="${C.aq}"/><path d="M${x - 3.5},${y + 15} L${x},${y + 4} L${x + 3.5},${y + 15} Z" fill="${C.lip}"/>
        <circle cx="${x}" cy="${y}" r="3" fill="${C.prod}"/>${pipe(`M${x + 3},${y} H${x + 26}`, C.prod)}`,
      inA: [x, y - 15], inB: [x, y + 15], via: 'top', out: x + 26 };
  }
  // T-mixer: a tee, the two phases meeting from opposite sides and leaving through the stem
  return { svg: `<path d="M${x - 5},${y - 16} H${x + 5} V${y - 5} H${x + 22} V${y + 5} H${x + 5} V${y + 16} H${x - 5} Z" fill="${C.card}" stroke="${C.ink2}" stroke-width="1.4" stroke-linejoin="round"/>
      ${pipe(`M${x},${y - 15} V${y - 2}`, C.aq, 2)}${pipe(`M${x},${y + 15} V${y + 2}`, C.lip, 2)}${pipe(`M${x},${y} H${x + 26}`, C.prod)}`,
    inA: [x, y - 16], inB: [x, y + 16], via: 'top', out: x + 26 };
}

/** A tube with what is in it: the collected raw colloid, or (vial) the final product. */
function vessel(x, y, vial = false) {
  if (vial) {
    return `<g><rect x="${x - 4}" y="${y - 21}" width="8" height="5" rx="1" fill="${C.ink2}"/>
      <path d="M${x - 10},${y - 15} H${x + 10} V${y + 14} Q${x + 10},${y + 18} ${x + 6},${y + 18} H${x - 6} Q${x - 10},${y + 18} ${x - 10},${y + 14} Z" fill="${C.card}" stroke="${C.ink2}" stroke-width="1.4"/>
      <path d="M${x - 9},${y - 2} H${x + 9} V${y + 14} Q${x + 9},${y + 17} ${x + 6},${y + 17} H${x - 6} Q${x - 9},${y + 17} ${x - 9},${y + 14} Z" fill="${C.prod}" opacity=".5"/></g>`;
  }
  return `<g><path d="M${x - 9},${y - 19} V${y + 9} Q${x - 9},${y + 19} ${x},${y + 19} Q${x + 9},${y + 19} ${x + 9},${y + 9} V${y - 19}" fill="${C.card}" stroke="${C.ink2}" stroke-width="1.4"/>
    <path d="M${x - 8},${y - 4} V${y + 9} Q${x - 8},${y + 18} ${x},${y + 18} Q${x + 8},${y + 18} ${x + 8},${y + 9} V${y - 4} Z" fill="${C.prod}" opacity=".5"/></g>`;
}

/**
 * The process as an SVG string.
 * @param {object} proc   a whole process (processOf)
 * @param {object} ref    getRef(): devices and mixers
 * @param {object} [o]    { quick: stop at the collected product; flows: {p1,p2,p3} mL/min; lipid_mM;
 *                          product: words under the collected product (e.g. "5.00 mL · 0.20 mg/mL"); title }
 */
export function processSvg(proc, ref, o = {}) {
  if (!proc) return '';
  const dev = deviceOf(proc, ref), mix = mixerOf(proc, ref), drive = driveOf(dev);
  const quench = proc.quench !== false;
  const flow = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? `${fmt(Number(v), Number(v) < 10 ? 2 : 1)} mL/min` : '');
  const f = o.flows || {};
  const yA = 46, yL = 126, my = 86, yQ = 190;
  const mx = 300, qx = 380;
  const cx = quench ? 446 : 376;
  const steps = o.quick ? [] : (proc.downstream || []);
  const bw = 138, gap = 30, b0 = cx + 46;
  const fx = b0 + steps.length * (bw + gap) + (steps.length ? 6 : -16);
  const W = Math.max(fx + 120, 560), H = quench ? 236 : 172;
  const box = (dev ? dev.name : proc.deviceId) || 'Formulation device';
  const parts = [];
  // the instrument, around what it does: the sources, the mixer and the quench junction
  parts.push(`<rect x="4" y="6" width="${(quench ? qx : mx + 30) + 26}" height="${H - 12}" rx="10" fill="none" stroke="${C.line}" stroke-dasharray="4 4"/>`);
  parts.push(text(14, 21, `${box}${dev?.vendor ? ` · ${dev.vendor}` : ''}`, { size: 11, fill: C.ink2, weight: 600, max: 48 }));
  const src = (y, color, title, sub, fl) => source(30, y, color, drive) + text(54, y - 4, title, { weight: 600, max: 26 }) + text(54, y + 12, sub, { size: 10.5, fill: C.ink2, max: 42 })
    + (fl ? text(mx - 12, y - 6, fl, { size: 10.5, fill: color, anchor: 'end', weight: 600 }) : '');
  // the two phases into the mixer
  const m = mixerShape(mix?.kind, mx, my);
  const aqPath = m.via === 'left' ? `M48,${yA} H${m.inA[0] - 12} V${m.inA[1]} H${m.inA[0]}` : `M48,${yA} H${mx} V${m.inA[1]}`;
  const lipPath = m.via === 'left' ? `M48,${yL} H${m.inB[0] - 12} V${m.inB[1]} H${m.inB[0]}` : `M48,${yL} H${mx} V${m.inB[1]}`;
  parts.push(pipe(aqPath, C.aq), pipe(lipPath, C.lip));
  parts.push(src(yA, C.aq, 'Aqueous · RNA', bufferLine(proc.aqueous, ref) || 'buffer not set', flow(f.p1)));
  parts.push(src(yL, C.lip, 'Lipid · ethanol', o.lipid_mM ? `${fmt(o.lipid_mM, 1)} mM lipid stock` : 'lipid stock', flow(f.p2)));
  parts.push(m.svg);
  // named above the outlet, to the right of the mixer, where no line runs
  parts.push(text(mx + (m.via === 'left' ? 4 : 10), my - (m.via === 'left' ? 21 : 10), mix ? mix.name : 'mixer', { size: 10.5, fill: C.ink2, max: quench ? 13 : 20 }));
  // quench: its own line, joining the product after the mixer
  if (quench) {
    parts.push(pipe(`M48,${yQ} H${qx} V${my + 6}`, C.q));
    parts.push(src(yQ, C.q, 'Quench', bufferLine(proc.quenchBuffer, ref) || 'buffer not set', flow(f.p3)));
    parts.push(pipe(`M${m.out},${my} H${cx - 18}`, C.prod));
    parts.push(`<circle cx="${qx}" cy="${my}" r="6" fill="${C.card}" stroke="${C.q}" stroke-width="2"/>${pipe(`M${qx - 3},${my} H${qx + 3} M${qx},${my - 3} V${my + 3}`, C.q, 1.6)}`);
  } else {
    parts.push(pipe(`M${m.out},${my} H${cx - 18}`, C.prod));
  }
  parts.push(arrow(cx - 14, my, C.prod));
  parts.push(vessel(cx, my));
  parts.push(text(cx, my + 36, o.quick ? 'LNP product' : 'Raw LNP', { size: 11, weight: 600, anchor: 'middle' }));
  if (o.product) parts.push(text(cx, my + 50, o.product, { size: 10, fill: C.ink2, anchor: 'middle', max: 26 }));
  // downstream, each step a box with what it is done in and into
  steps.forEach((s, i) => {
    const x = b0 + i * (bw + gap), top = my - 38;
    const from = i === 0 ? cx + 14 : x - gap + 2;
    parts.push(pipe(`M${from},${my} H${x - 4}`, C.prod, 2), arrow(x - 1, my, C.prod));
    const info = PROCESS_STEPS.find((p) => p.id === s.step);
    const buf = [s.buffer, s.pH != null && s.pH !== '' && !/pH/.test(s.buffer || '') ? `pH ${fmt(Number(s.pH), 1)}` : ''].filter(Boolean).join(', ');
    const nums = [s.mM && !/mM/.test(s.buffer || '') ? `${fmt(Number(s.mM), 0)} mM` : '', s.ionicStrength_mM != null && s.ionicStrength_mM !== '' ? `I ≈ ${fmt(Number(s.ionicStrength_mM), 0)} mM` : ''].filter(Boolean).join(' · ');
    parts.push(`<rect x="${x}" y="${top}" width="${bw}" height="76" rx="9" fill="${C.card}" stroke="${C.line}" stroke-width="1.4"/>`);
    parts.push(`<rect x="${x}" y="${top}" width="5" height="76" rx="2" fill="${C.prod}" opacity=".7"/>`);
    parts.push(text(x + 13, top + 17, `${i + 1} · ${stepName(s.step)}`, { weight: 650, max: 21 }));
    parts.push(text(x + 13, top + 33, s.device || `${info?.what || 'device'} not set`, { size: 10.5, fill: C.ink2, max: 22 }));
    if (info?.exchange !== false) {
      parts.push(text(x + 13, top + 50, buf || 'buffer not set', { size: 10.5, max: 22 }));
      if (nums) parts.push(text(x + 13, top + 64, nums, { size: 10, fill: C.ink2, max: 23 }));
    }
  });
  if (steps.length) {
    const last = b0 + (steps.length - 1) * (bw + gap) + bw;
    parts.push(pipe(`M${last + 2},${my} H${fx - 18}`, C.prod, 2), arrow(fx - 14, my, C.prod));
    parts.push(vessel(fx, my, true));
    parts.push(text(fx, my + 36, 'Final product', { size: 11, weight: 600, anchor: 'middle' }));
  }
  const label = o.title || `Process: ${box}, ${mix ? mix.name : ''}${quench ? ', inline quench' : ''}${steps.length ? `, then ${steps.map((s) => stepName(s.step)).join(', ')}` : ''}`;
  return `<svg class="processViz" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" ${FONT} style="width:100%;max-width:${W}px;height:auto;display:block">${parts.join('')}</svg>`;
}

/* ---------------- the form ---------------- */

/**
 * Buffers to offer for a role, as a datalist: the lots made on the Buffers screen first, then the catalogue. A
 * datalist rather than a select, so a buffer the app does not list can be typed in as it is written on the bottle.
 */
function bufferList(id, role, ref) {
  // An archived lot is not offered (spec 9.5); one a record already names is still found by the record itself.
  const gone = ref.archived?.buffer || new Set();
  const made = (ref.buffers || []).filter((b) => !gone.has(String(b.id))).filter((b) => !role || !(b.roles || []).length || normaliseRoles(b.roles).includes(role)).map((b) => [b.lot, `${b.name} · prepared lot${b.date ? ` of ${b.date}` : ''}`]);
  const cat = (ref.buffersCatalog || []).filter((b) => !role || normaliseRoles(b.roles).includes(role)).map((b) => [b.name, 'catalogue']);
  return `<datalist id="${id}">${[...made, ...cat].map(([v, l]) => `<option value="${esc(v)}">${esc(l || '')}</option>`).join('')}</datalist>`;
}

const numIn = (name, v, label, step = 'any', w = '') => `<label class="prNum">${esc(label)}<input type="number" step="${step}" name="${name}" value="${v ?? ''}"${w ? ` style="width:${w}"` : ''}></label>`;

/** One buffer: its name (with the list to pick from), pH, concentration and ionic strength. */
function bufferFields(key, b, role, ref, uid) {
  const list = `${uid}-${key}`;
  return `<div class="prBuffer">
      <label class="prName">Buffer<input type="text" name="pr_${key}_buffer" list="${list}" value="${esc(b?.buffer || '')}" placeholder="e.g. Citrate 50 mM, pH 4.0" autocomplete="off"></label>${bufferList(list, role, ref)}
      ${numIn(`pr_${key}_pH`, b?.pH, 'pH', 0.1)}${numIn(`pr_${key}_mM`, b?.mM, 'mM', 1)}${numIn(`pr_${key}_ionicStrength_mM`, b?.ionicStrength_mM, 'Ionic strength (mM)', 1)}
    </div>`;
}

/** What a downstream step is done in: the cassettes, the TFF modules, the filters on record; none archived. */
function deviceChoices(step, ref) {
  const gone = ref.archived || {};
  // materials.dialysis_cassettes already holds the earlier cassette names and then every device under Materials.
  if (step === 'dialysis') {
    const off = new Set((ref.dialysis || []).filter((x) => gone.dialysis?.has(String(x.id))).map((x) => x.name));
    return [...new Set(ref.materials?.dialysis_cassettes || [])].filter((n) => !off.has(n));
  }
  if (step === 'tff') return (ref.tffModules || []).filter((m) => !gone.tffModule?.has(String(m.id))).map((m) => m.part);
  if (step === 'filtration') return (ref.materials?.filters || []).filter((f) => f !== 'None' && !gone.filter?.has(f));
  return [];
}

/**
 * The designer's form. `opts.quick` hides the downstream (quick mode stops at the mixer); `opts.uid` keeps the
 * datalist ids apart when two designers are on one page.
 */
export function processEditor(proc, ref, { quick = false, uid = 'pr' } = {}) {
  const dev = deviceOf(proc, ref);
  const mixers = mixersFor(dev, ref);
  const qm = quenchMode(dev);
  const opt = (v, l, sel) => `<option value="${esc(v)}" ${sel ? 'selected' : ''}>${esc(l)}</option>`;
  // A device or mixer deleted under Materials stays offered on the record that keeps a copy of it, marked so.
  // An archived one (spec 9.5) is offered only on the record that already has it.
  const gone = ref.archived || {};
  const devices = [...(ref.devices || []).filter((d) => !gone.device?.has(String(d.id)) || d.id === proc.deviceId), ...(dev?.deleted ? [dev] : [])].map((d) => opt(d.id, `${entryName(d)}${d.vendor ? ` (${d.vendor})` : ''}`, d.id === proc.deviceId)).join('');
  const keptMixer = mixerOf(proc, ref);
  const mixerSel = [...mixers.filter((m) => !gone.mixer?.has(String(m.id)) || m.id === proc.mixerId), ...(keptMixer?.deleted ? [keptMixer] : [])].map((m) => opt(m.id, m.name === m.kind ? entryName(m) : `${entryName(m)} · ${m.kind}`, m.id === proc.mixerId)).join('');
  const quenchBox = qm === 'none'
    ? `<span class="muted">This device has no quench pump: dilute offline after mixing.</span>`
    : `<label class="inline prCheck"><input type="checkbox" name="pr_quench" ${proc.quench !== false ? 'checked' : ''} style="width:auto"> Inline quench after the mixer${qm === 'inline' ? '' : ' (a third pump or syringe)'}</label>`;
  const ds = proc.downstream || [];
  const stepRow = (s, i) => {
    const info = PROCESS_STEPS.find((p) => p.id === s.step);
    const choices = deviceChoices(s.step, ref), list = `${uid}-dev-${i}`;
    return `<div class="prStep" data-pr-step="${i}">
      <div class="prStepHead"><b>${i + 1} · ${esc(stepName(s.step))}</b>
        <label class="prName">${esc(info?.what || 'Device')}<input type="text" name="pr_ds_${i}_device" list="${list}" value="${esc(s.device || '')}" autocomplete="off"></label>
        <datalist id="${list}">${choices.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        <span class="prStepBtns"><button type="button" class="ghost" data-pr-up="${i}" ${i ? '' : 'disabled'} title="Earlier" aria-label="Move ${esc(stepName(s.step))} earlier">↑</button><button type="button" class="ghost" data-pr-down="${i}" ${i < ds.length - 1 ? '' : 'disabled'} title="Later" aria-label="Move ${esc(stepName(s.step))} later">↓</button><button type="button" class="ghost" data-pr-rm="${i}" title="Remove this step" aria-label="Remove ${esc(stepName(s.step))}">✕</button></span>
      </div>
      ${info?.exchange === false ? '' : `<div class="prSub">${s.step === 'dilution' ? 'Diluted with' : 'Exchanged into'}</div>${bufferFields(`ds_${i}`, s, s.step === 'dilution' ? 'final' : 'dialysis', ref, uid)}`}
    </div>`;
  };
  return `<div class="prEditor">
    <div class="prGroup"><h3>Upstream · making the raw colloid</h3>
      <div class="prRow">
        <label class="prName">Formulation device<select name="pr_deviceId">${devices}</select></label>
        <label class="prName">Mixer<select name="pr_mixerId">${mixerSel || opt('', 'none listed for this device', true)}</select></label>
        <div class="prQuench">${quenchBox}</div>
      </div>
      ${dev?.notes ? `<div class="muted prNote">${esc(dev.notes)}</div>` : ''}
      <div class="prSub">Aqueous phase (RNA, pump 1)</div>${bufferFields('aq', proc.aqueous, 'loading', ref, uid)}
      ${proc.quench !== false && qm !== 'none' ? `<div class="prSub">Quench buffer (pump 3)</div>${bufferFields('qb', proc.quenchBuffer, 'quench', ref, uid)}` : ''}
    </div>
    ${quick ? '<div class="prGroup"><h3>Downstream</h3><p class="muted" style="margin:0">Quick mode stops at the mixer. Switch the formulation to the full process to plan dialysis, TFF and the rest.</p></div>'
      : `<div class="prGroup"><h3>Downstream · in this order</h3>
      ${ds.map(stepRow).join('') || '<p class="muted" style="margin:0 0 6px">No downstream step: the raw colloid is the product.</p>'}
      <div class="prAdd"><span class="muted">Add a step:</span>${PROCESS_STEPS.map((p) => `<button type="button" data-pr-add="${p.id}">+ ${esc(p.name)}</button>`).join('')}</div>
    </div>`}
  </div>`;
}

/**
 * Put one field of the form into the process. Returns the process to keep (a new object where the device moved
 * the mixer or the quench with it), or null for a field that is not the designer's.
 */
export function applyProcessField(proc, name, value, ref) {
  if (!name?.startsWith('pr_')) return null;
  const n = name.slice(3);
  const p = { ...proc, aqueous: { ...proc.aqueous }, quenchBuffer: { ...proc.quenchBuffer }, downstream: (proc.downstream || []).map((s) => ({ ...s })) };
  const numOf = (v) => (v === '' || v == null ? null : Number(v));
  if (n === 'deviceId') return chooseDevice(p, value, ref);
  if (n === 'mixerId') { p.mixerId = value; return p; }
  if (n === 'quench') { p.quench = !!value; return p; }
  const m = n.match(/^(aq|qb|ds_(\d+))_(\w+)$/);
  if (!m) return null;
  const at = m[1] === 'aq' ? 'aqueous' : m[1] === 'qb' ? 'quenchBuffer' : null;
  const get = () => (at ? p[at] : p.downstream[Number(m[2])]);
  const set = (v) => { if (at) p[at] = v; else p.downstream[Number(m[2])] = v; };
  const cur = get();
  if (!cur) return p;
  const field = m[3];
  if (field === 'buffer') set(withBuffer(cur, value, ref));
  else if (field === 'device') set({ ...cur, device: value });
  else if (field === 'pH' || field === 'mM') set(refreshIonic({ ...cur, [field]: numOf(value) }, ref));
  else if (field === 'ionicStrength_mM') set({ ...cur, ionicStrength_mM: numOf(value) });
  return p;
}

/** A new downstream step of a kind, with what such a step usually is: the first device listed, PBS for an exchange. */
export function newStep(kind, ref) {
  const choices = deviceChoices(kind, ref);
  const dev = kind === 'dialysis' && choices.includes(LAB_PROCESS.downstream[0].device) ? LAB_PROCESS.downstream[0].device : choices[0] ?? '';
  const s = { step: kind, device: dev, buffer: '', pH: null, mM: null, ionicStrength_mM: null };
  return PROCESS_STEPS.find((p) => p.id === kind)?.exchange === false ? s : withBuffer(s, kind === 'dilution' ? 'PBS, 300 mM sucrose, pH 7.4' : 'PBS, pH 7.4', ref);
}

/**
 * The designer's buttons (add, remove, move a step), on `root`. `get()` returns the process as it is now and
 * `put(next)` keeps the changed one and redraws; the screen decides what keeping means.
 */
export function wireProcessButtons(root, get, put, ref) {
  root.querySelectorAll('[data-pr-add]').forEach((b) => b.addEventListener('click', () => {
    const p = get(); put({ ...p, downstream: [...(p.downstream || []), newStep(b.dataset.prAdd, ref)] });
  }));
  root.querySelectorAll('[data-pr-rm]').forEach((b) => b.addEventListener('click', () => {
    const p = get(); put({ ...p, downstream: (p.downstream || []).filter((_, i) => i !== Number(b.dataset.prRm)) });
  }));
  const move = (i, by) => {
    const p = get(), ds = (p.downstream || []).slice(), j = i + by;
    if (j < 0 || j >= ds.length) return;
    [ds[i], ds[j]] = [ds[j], ds[i]];
    put({ ...p, downstream: ds });
  };
  root.querySelectorAll('[data-pr-up]').forEach((b) => b.addEventListener('click', () => move(Number(b.dataset.prUp), -1)));
  root.querySelectorAll('[data-pr-down]').forEach((b) => b.addEventListener('click', () => move(Number(b.dataset.prDown), 1)));
}

/** The process as rows of a worksheet table: [label, value] pairs, the same words the drawing uses. */
export function processRows(proc, ref, { quick = false } = {}) {
  const dev = deviceOf(proc, ref), mix = mixerOf(proc, ref);
  const rows = [
    ['Formulation device', dev ? `${entryName(dev)}${dev.vendor ? ` (${dev.vendor})` : ''}` : proc.deviceId || '–'],
    ['Mixer', mix ? `${entryName(mix)} (${mix.kind})` : proc.mixerId || '–'],
    ['Aqueous phase', bufferLine(proc.aqueous, ref) || '–'],
    ['Quench', proc.quench !== false ? `inline · ${bufferLine(proc.quenchBuffer, ref) || 'buffer not set'}` : 'none'],
  ];
  if (!quick) (proc.downstream || []).forEach((s, i) => rows.push([`${i + 1} · ${stepName(s.step)}`, [s.device, bufferLine(s, ref)].filter(Boolean).join(' · ') || '–']));
  return rows;
}
