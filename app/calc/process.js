// The process a formulation is made by, and the quick mode that stops at the mixer. Pure: plain data in, plain
// data out; the designer that edits it is app/ui/processviz.js, which also draws it.
//
// A plan carries the process as one object (plan.process), so the record, the worksheet, the experiment page,
// the report and the drawing all read the same thing:
//
//   { deviceId, mixerId, quench: true|false,
//     aqueous:      { buffer, pH, mM, ionicStrength_mM },   the RNA phase, pump 1
//     quenchBuffer: { buffer, pH, mM, ionicStrength_mM },   pump 3, only used when quench is on
//     downstream:   [{ step: 'dialysis'|'tff'|'dilution'|'filtration', device, buffer, pH, mM, ionicStrength_mM }] }
//
// What the process describes is kept here and nowhere else. Records made before it existed wrote some of the same
// things elsewhere: the RNA dilution buffer (plan.rna.diluent, which is the aqueous phase), the quench buffer
// (plan.mixing.quenchBuffer), the dialysis cassette and buffer (plan.downstream.dialysis.cassette/.buffer) and
// whether TFF runs and on which module (plan.downstream.tff.enabled/.module). processOf() reads an old record's
// process from those fields; adoptProcess() moves them into plan.process and takes them off, so a record never
// holds two answers to "which dialysis buffer". The quantities stay where they were (dialysis volume and hours,
// the TFF target, the final formulation): they are the batch's numbers, not the shape of the process.
import { designBuffer } from './buffer.js';

/** Downstream steps the designer offers, in the order a process usually runs them. `what` names the consumable. */
export const PROCESS_STEPS = [
  { id: 'dialysis', name: 'Dialysis', what: 'Cassette', exchange: true },
  { id: 'tff', name: 'TFF', what: 'Module', exchange: true },
  { id: 'dilution', name: 'Dilution', what: 'Vessel', exchange: true },
  { id: 'filtration', name: 'Filtration', what: 'Filter', exchange: false },
];
export const stepName = (id) => PROCESS_STEPS.find((s) => s.id === id)?.name || id;

/**
 * The lab's own layout, which every record assumed before devices were listed: three pumps into a T-mixer with
 * inline quench, citrate pH 4.0 as the aqueous phase and the quench, dialysis into PBS. The ionic strengths are
 * what ionicStrength_mM() estimates for these buffers (a unit test keeps them in step), written out so a plan can
 * be made without the reference tables at hand (buildExperiment, the demo lab).
 */
export const LAB_PROCESS = Object.freeze({
  deviceId: 'pumps-3', mixerId: 't-mixer', quench: true,
  aqueous: { buffer: 'Citrate 50 mM, pH 4.0', pH: 4, mM: 50, ionicStrength_mM: 70 },
  quenchBuffer: { buffer: 'Citrate 50 mM, pH 4.0', pH: 4, mM: 50, ionicStrength_mM: 70 },
  downstream: [{ step: 'dialysis', device: '10K G3 3-12 ml', buffer: 'PBS, pH 7.4', pH: 7.4, mM: 10, ionicStrength_mM: 163 }],
});

/** Quick mode's volume to formulate when nothing else says: 5 mL, which at 0.4 mg/mL, FRR 3 and quench ×2 is 1 mg mRNA. */
export const QUICK_VOLUME_mL = 5;

/**
 * Which mode a new experiment of a type starts in. Quick (stop at the mixer) for the screening types, where many
 * small batches are compared on size, PDI and EE straight from the mixer and the downstream would be the same
 * for all of them; the full process for a single candidate, a stability study and a reproducibility series,
 * whose product is stored, dosed or charted and so has to be made the way the product is made. Only a default:
 * the wizard and every record can switch.
 */
export function defaultModeFor(type) { return ['ofat', 'doe', 'comparison'].includes(type) ? 'quick' : 'full'; }

const clone = (x) => JSON.parse(JSON.stringify(x));
const num = (v) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** The default process, checked against the devices on record: the lab layout, or the first device when that is gone. */
export function defaultProcess(ref) {
  const p = clone(LAB_PROCESS);
  if (ref?.devices?.length && !ref.devices.some((d) => d.id === p.deviceId)) return chooseDevice(p, ref.devices[0].id, ref);
  return p;
}

/* ---------------- buffers ---------------- */

/**
 * What the app knows about a buffer named on a plan: a lot made on the Buffers screen (by its lot, Buffer-003,
 * or its name) or a catalogue entry (by its name, with or without "(code)"). {system, pH, mM, nacl_mM} or null.
 */
export function bufferFacts(name, ref) {
  const s = String(name ?? '').trim();
  if (!s) return null;
  const bare = s.replace(/\s*\([^)]*\)\s*$/, '');
  const made = (ref?.buffers || []).find((b) => b.lot === s || b.id === s || b.name === s);
  const cat = (ref?.buffersCatalog || []).find((b) => b.name === s || b.name === bare || (b.code && `${b.name} (${b.code})` === s));
  const b = made || cat;
  if (!b) return null;
  // A prepared lot also says how it was made (the reagents, a second component), which its ionic strength
  // depends on; a catalogue entry is made the recommended way.
  return { system: b.system || null, pH: num(b.targetPH), mM: num(b.conc_mM), nacl_mM: num(b.nacl_mM) || 0,
    ...(made ? { method: made.method || 'auto', system2: made.system2 || '', conc2_mM: num(made.conc2_mM) || 0, reagent2: made.reagent2 || '', activity: made.activity !== false } : {}) };
}

// designBuffer runs a pH solve inside a bisection, some milliseconds each; a list of old records asks for the
// same few buffers again and again.
const ionicMemo = new Map();

/**
 * Ionic strength of a buffer, mM: what the Buffers screen's designer gives for the same buffer (calc/buffer.js,
 * designBuffer), so every screen agrees. The species at the pH with Davies activity correction, the counter-ions
 * of the reagents weighed in (Na⁺ of trisodium citrate, of NaOH; Cl⁻ of HCl) and any NaCl. Null when the buffer
 * system is not in the pKa table. `tables` is the reference data ({pka, reagents}, getRef's), or the pKa table
 * alone with the reagents as the third argument; without reagents the buffer is taken as its neutral form
 * titrated to the pH, which gives the same species and very nearly the same counter-ions.
 *
 * Until this version the process designer worked this out on its own, without activity correction, and said
 * 58 mM for citrate 50 mM pH 4.0 where the Buffers screen said 76.6 mM.
 */
export function ionicStrength_mM(facts, tables, reagentsArg) {
  const pka = Array.isArray(tables) ? tables : tables?.pka;
  const reagents = Array.isArray(tables) ? reagentsArg : tables?.reagents;
  const c = Number(facts?.mM), ph = Number(facts?.pH);
  if (!facts?.system || !(c > 0) || facts.pH == null || facts.pH === '' || !Number.isFinite(ph)) return null;
  if (!(pka || []).some((p) => p.name === facts.system)) return null;
  const spec = { system: facts.system, method: facts.method || 'auto', targetPH: ph, conc_mM: c, volume_mL: 1000, nacl_mM: Number(facts.nacl_mM) || 0,
    system2: facts.system2 || '', conc2_mM: Number(facts.conc2_mM) || 0, reagent2: facts.reagent2 || '', activity: facts.activity !== false };
  const key = JSON.stringify([spec, (reagents || []).length, (pka || []).length]);
  if (!ionicMemo.has(key)) {
    const d = designBuffer(spec, { pka, reagents: reagents || [] });
    if (ionicMemo.size > 500) ionicMemo.clear();
    ionicMemo.set(key, d.err ? null : d.I * 1000);
  }
  return ionicMemo.get(key);
}

/**
 * A phase or an exchange buffer given a new buffer name: pH and concentration from what the app knows about it,
 * and the ionic strength worked out from those. A name the app does not know keeps the numbers already typed.
 */
export function withBuffer(phase, name, ref) {
  const out = { ...(phase || {}), buffer: name || '' };
  const f = bufferFacts(name, ref);
  if (f) {
    if (f.pH != null) out.pH = f.pH;
    if (f.mM != null) out.mM = f.mM;
    out.ionicStrength_mM = roundI(ionicStrength_mM({ ...f, pH: out.pH, mM: out.mM }, ref)) ?? out.ionicStrength_mM ?? null;
  }
  return out;
}

/** After the pH or the concentration of a known buffer is changed, its ionic strength follows. */
export function refreshIonic(phase, ref) {
  const f = bufferFacts(phase?.buffer, ref);
  if (!f) return phase;
  const I = roundI(ionicStrength_mM({ ...f, pH: phase.pH, mM: phase.mM }, ref));
  return I == null ? phase : { ...phase, ionicStrength_mM: I };
}
const roundI = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v));

/* ---------------- devices and mixers ---------------- */

// A record whose instrument or mixer was deleted under Materials keeps a copy of it (deviceRecord, mixerRecord),
// so it is drawn and run as it was planned, shown with `deleted` set; a listed entry of that id always wins.
const keptCopy = (rec, id) => (rec && rec.id === id ? { ...rec, deleted: true } : null);
export const deviceOf = (proc, ref) => (ref?.devices || []).find((d) => d.id === proc?.deviceId) || keptCopy(proc?.deviceRecord, proc?.deviceId);
export const mixerOf = (proc, ref) => (ref?.mixers || []).find((m) => m.id === proc?.mixerId) || keptCopy(proc?.mixerRecord, proc?.mixerId);
/** A device's or mixer's name, with "(deleted)" when only the record's own copy of it is left. */
export const entryName = (x) => (x ? `${x.name}${x.deleted ? ' (deleted)' : ''}` : '');
/** The mixers a device takes, as listed on the device; every mixer for a device that lists none. */
export function mixersFor(device, ref) {
  const all = ref?.mixers || [];
  const ids = device?.mixers;
  // in the device's own order: the first it lists is the one it is usually run with
  return ids?.length ? ids.map((id) => all.find((m) => m.id === id)).filter(Boolean) : all;
}
/** Whether the device can quench: 'inline' (it has the pump, on by default), 'optional', or 'none' (it cannot). */
export const quenchMode = (device) => device?.quench || 'optional';
/** Pumps or syringes: what to draw and call the sources. A device may say so itself (`drive`). */
export const driveOf = (device) => device?.drive || (/syringe|ignite|nanoassemblr/i.test(`${device?.id} ${device?.name}`) ? 'syringe' : 'pump');

/**
 * A process moved to another device: its first mixer when the one chosen does not fit it, and quench as the
 * device has it (on for an inline quench pump, off for one without, off to start with where it is optional).
 */
export function chooseDevice(proc, deviceId, ref) {
  const out = { ...proc, deviceId };
  const dev = (ref?.devices || []).find((d) => d.id === deviceId);
  if (!dev) return out;
  const fits = mixersFor(dev, ref);
  if (fits.length && !fits.some((m) => m.id === out.mixerId)) out.mixerId = fits[0].id;
  const q = quenchMode(dev);
  out.quench = q === 'inline';
  return out;
}

/* ---------------- the process of a plan ---------------- */

/**
 * The process of a plan, whole: plan.process with anything missing filled from the lab default, or, on a record
 * made before plan.process existed, the process its own fields describe (see the header). Never changes the plan.
 */
export function processOf(plan, ref) {
  const base = defaultProcess(ref);
  const p = plan?.process;
  if (p) {
    return {
      deviceId: p.deviceId || base.deviceId, mixerId: p.mixerId || base.mixerId, quench: p.quench !== false,
      aqueous: { ...base.aqueous, ...(p.aqueous || {}) }, quenchBuffer: { ...base.quenchBuffer, ...(p.quenchBuffer || {}) },
      downstream: Array.isArray(p.downstream) ? p.downstream.map((s) => ({ ...s })) : base.downstream,
      // the copies a deleted instrument or mixer left on the record (see deviceOf)
      ...(p.deviceRecord ? { deviceRecord: p.deviceRecord } : {}), ...(p.mixerRecord ? { mixerRecord: p.mixerRecord } : {}),
    };
  }
  // An old record: the three-pump T-mixer layout with quench, which is what every record then was.
  const ds = plan?.downstream || {};
  const out = { ...base, deviceId: 'pumps-3', mixerId: plan?.mixing?.mixer || 't-mixer', quench: true };
  if (plan?.rna?.diluent) out.aqueous = withBuffer({}, plan.rna.diluent, ref);
  if (plan?.mixing?.quenchBuffer) out.quenchBuffer = withBuffer({}, plan.mixing.quenchBuffer, ref);
  const dia = { ...base.downstream[0] };
  if (ds.dialysis?.cassette) dia.device = ds.dialysis.cassette;
  if (ds.dialysis?.buffer) Object.assign(dia, withBuffer({}, ds.dialysis.buffer, ref));
  else if (ds.dialysis) Object.assign(dia, { buffer: '', pH: null, mM: null, ionicStrength_mM: null }); // a record with dialysis but no buffer named says nothing about one
  out.downstream = [dia];
  if (ds.tff?.enabled) out.downstream.push({ step: 'tff', device: ds.tff.module || '', buffer: '', pH: null, mM: null, ionicStrength_mM: null });
  return out;
}

/** Put the process on the plan (plan.process) and take the old copies of it off, so there is one answer. */
export function adoptProcess(plan, ref) {
  if (!plan) return plan;
  plan.process = processOf(plan, ref);
  if (plan.rna) delete plan.rna.diluent;
  if (plan.mixing) { delete plan.mixing.quenchBuffer; delete plan.mixing.mixer; }
  const ds = plan.downstream;
  if (ds?.dialysis) { delete ds.dialysis.cassette; delete ds.dialysis.buffer; }
  if (ds?.tff) { delete ds.tff.enabled; delete ds.tff.module; }
  return plan;
}

/**
 * What a formulation is made with, by name or id, whichever shape its record has: the instrument and mixer,
 * and the dialysis cassettes and TFF modules of its downstream steps. A record moved onto plan.process keeps
 * them there; an older one still has them in plan.mixing / plan.downstream until it is next opened. Materials
 * reads this to keep an entry a record names from being renamed or deleted under it.
 */
export function devicesUsed(plan) {
  const p = plan?.process, ds = plan?.downstream || {};
  const steps = Array.isArray(p?.downstream) ? p.downstream : [];
  const of = (kind) => steps.filter((s) => s.step === kind && s.device).map((s) => s.device);
  return {
    deviceId: p?.deviceId || (plan ? 'pumps-3' : null),
    mixerId: p?.mixerId || plan?.mixing?.mixer || (plan ? 't-mixer' : null),
    dialysis: [...of('dialysis'), ...(ds.dialysis?.cassette ? [ds.dialysis.cassette] : [])],
    tff: [...of('tff'), ...(ds.tff?.enabled && ds.tff.module ? [ds.tff.module] : [])],
  };
}

/** The first downstream step of a kind, or null. */
export const stepOf = (proc, kind) => (proc?.downstream || []).find((s) => s.step === kind) || null;

/** The quench factor the pumps run at: the plan's own, or 0 when the process has no quench. */
export function effectiveQuench(plan, fallback = 2) {
  if (plan?.process?.quench === false) return 0;
  const q = plan?.mixing?.quenchFactor;
  return q == null || !Number.isFinite(Number(q)) ? fallback : Number(q);
}

/* ---------------- quick mode ---------------- */

/** A plan's mode. Records made before modes existed are the full process. */
export const modeOf = (plan) => (plan?.mode === 'quick' ? 'quick' : 'full');

/**
 * Quick mode: what a volume of product out of the mixer holds and needs.
 *
 * V is the volume collected at the outlet: aqueous + lipid + (inline) quench, the "primary product" of the full
 * record. The pumps split it FRR : 1 : q, so
 *   aqueous = V·FRR/(FRR+1+q), lipid = V/(FRR+1+q), quench = V·q/(FRR+1+q),
 *   mRNA (mg) = aqueous × C_work = V × C_work × FRR / (FRR + 1 + q),
 * with q the quench factor, 0 when the process has no quench. It is mixingPlan() run backwards: a plan with this
 * much mRNA gives exactly V of primary product.
 */
export function quickVolumes({ volume_mL, working_mg_mL, frr, quenchFactor = 0 }) {
  const V = Number(volume_mL), c = Number(working_mg_mL), f = Number(frr), q = Math.max(0, Number(quenchFactor) || 0);
  if (!(V > 0) || !(c > 0) || !(f > 0)) return null;
  const parts = f + 1 + q;
  return { volume_mL: V, aqueous_mL: (V * f) / parts, lipid_mL: V / parts, quench_mL: (V * q) / parts, rna_mg: (V * c * f) / parts, product_mg_mL: (c * f) / parts };
}

/** The volume that holds a given mRNA mass: the formula above solved for V. For switching a record to quick mode. */
export function quickVolumeFor({ rna_mg, working_mg_mL, frr, quenchFactor = 0 }) {
  const m = Number(rna_mg), c = Number(working_mg_mL), f = Number(frr), q = Math.max(0, Number(quenchFactor) || 0);
  return m > 0 && c > 0 && f > 0 ? (m * (f + 1 + q)) / (c * f) : null;
}

/**
 * In quick mode the volume is what was chosen and the mRNA follows from it: plan.rna.mass_mg is written from the
 * volume, so every screen that reads a batch's mRNA (the experiment page, the report, the optimizer) reads the
 * mass that volume holds. Call after anything in the formula changes. Returns the plan.
 */
export function syncQuick(plan) {
  if (modeOf(plan) !== 'quick') return plan;
  const v = quickVolumes({ volume_mL: plan.volume_mL, working_mg_mL: plan.rna?.working_mg_mL, frr: plan.mixing?.frr, quenchFactor: effectiveQuench(plan) });
  if (v) { plan.rna ||= {}; plan.rna.mass_mg = Math.round(v.rna_mg * 1e6) / 1e6; }
  return plan;
}

/* ---------------- words ---------------- */

const n1 = (v, dp = 1) => { const x = Number(v); return Number.isFinite(x) ? String(Math.round(x * 10 ** dp) / 10 ** dp) : ''; };
/** "Citrate 50 mM, pH 4.0 · I ≈ 70 mM", or the numbers alone when no buffer is named. */
export function bufferLine(b, ref = null) {
  if (!b) return '';
  // A prepared lot deleted from the Buffers screen keeps its number on the record, with what it was.
  const lot = String(b.buffer || '').trim();
  const gone = ref && /^Buffer-\d+$/.test(lot) && !(ref.buffers || []).some((x) => x.lot === lot || x.id === lot);
  const named = gone ? `${lot} (deleted lot)` : lot;
  const nums = [named && /pH/.test(named) ? '' : b.pH != null && b.pH !== '' ? `pH ${n1(b.pH)}` : '', named && /mM/.test(named) ? '' : b.mM ? `${n1(b.mM, 0)} mM` : ''].filter(Boolean).join(', ');
  const I = b.ionicStrength_mM != null && b.ionicStrength_mM !== '' ? `I ≈ ${n1(b.ionicStrength_mM, 0)} mM` : '';
  return [named, nums, I].filter(Boolean).join(' · ');
}

/** One line for the whole process: device, mixer, quench, the aqueous phase, then each downstream step. */
export function processSummary(proc, ref, { quick = false } = {}) {
  const dev = deviceOf(proc, ref), mix = mixerOf(proc, ref);
  const up = [dev ? entryName(dev) : proc.deviceId, mix ? entryName(mix) : proc.mixerId, proc.quench ? 'inline quench' : 'no quench'].filter(Boolean).join(' · ');
  const aq = proc.aqueous?.buffer ? `aqueous ${proc.aqueous.buffer}` : '';
  const down = quick ? 'stops at the mixer (quick)' : (proc.downstream || []).map((s) => `${stepName(s.step).toLowerCase()}${s.buffer ? ` into ${s.buffer}` : ''}`).join(', then ');
  return [up, aq, down].filter(Boolean).join('; ');
}
