// Demo mode: a complete, invented lab you can press every button in.
//
// The app is single-user and local, so there is no sandbox to try things in: the only data is your data, and
// nobody experiments with that. Demo mode gives the store a second namespace. Switch it on and the app is
// full of a plausible lab that has already run a factorial, a response surface, a stability study and a
// handful of one-offs, with results; switch it off and your own data is exactly where you left it, because
// nothing here ever writes to it.
//
// The numbers come from a fixed truth function with seeded noise, so every run of the demo gives the same
// lab, and the relationships in it are real ones the models can find: size falls with flow rate ratio and
// total flow, PDI is worst at the extremes of flow, encapsulation saturates with ionizable content, and
// particles drift upward in storage faster when PEG is low. That is what makes the DoE → ML path walkable:
// fit the design, read the surface, then let the optimiser use every batch in the house.

import { buildExperiment } from './calc/experiment.js';
import { qcFlags } from './calc/qc.js';
import { addDays, todayISO } from './calc/dates.js';
import { DEFAULT_SETTINGS } from './refdata.js';
import { LAB_PROCESS } from './calc/process.js';
import { raiseCounter } from './schema.js';

export const DEMO_NS = 'lnp-demo';
const FLAG = 'lnp-lab.demo'; // deliberately in the real namespace: the switch is a property of the app, not of a dataset

export function demoOn() { try { return localStorage.getItem(FLAG) === '1'; } catch { return false; } }
export function storeNamespace() { return demoOn() ? DEMO_NS : 'lnp-lab'; }
/** Flip the switch. The caller reloads, because the namespace is chosen once at start-up. */
export function setDemo(on) { if (on) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); }
/**
 * Throw the demo lab away, so the next start builds a fresh one. Through the store, which knows where the
 * collections are kept (IndexedDB, or localStorage before that), and only ever the demo's: a store opened on
 * the real namespace is refused rather than emptied. Resolves once it is gone.
 */
export async function wipeDemo(store) {
  if (store?.ns !== DEMO_NS) throw new Error('wipeDemo is given the demo store, never the real one');
  return store.clear();
}

/* ---------------- the invented truth ---------------- */

/** Deterministic noise, so the demo lab is the same lab every time. */
export function rng(seed = 20261019) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const gauss = (r) => { const u = r() || 1e-9; return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };

/** What a batch plan would produce in this invented world, before measurement noise. */
export function truth(plan) {
  const frr = Number(plan?.mixing?.frr ?? 3);
  const tfr = Number(plan?.mixing?.totalFlow ?? 112.5);
  const peg = Number(plan?.compositionOverride?.peg_pct ?? 1.5);
  const ion = Number(plan?.compositionOverride?.ionizable_pct ?? 47.5);
  const np = Number(plan?.rna?.np ?? 6);
  // Size: more aqueous and more flow give faster mixing and smaller particles; PEG caps growth. The squared
  // terms are what a face-centred design is for — a factorial alone would read this as a plane.
  const size = 112 - 11 * (frr - 3) - 0.22 * (tfr - 90) - 16 * (peg - 1.5)
    + 1.6 * (frr - 3) ** 2 + 0.0013 * (tfr - 90) ** 2 + 0.05 * (frr - 3) * (tfr - 90);
  // Dispersity: worst where mixing is slow, and worst again when there is not enough PEG to stop fusion.
  const pdi = 0.082 + 0.0000215 * (tfr - 100) ** 2 + 0.07 * Math.max(0, 1.2 - peg) + 0.009 * Math.abs(frr - 3);
  // Encapsulation: a titration curve in ionizable content, saturating in N/P, spoiled by very high flow ratio.
  // Calibrated so the default composition sits at ~93 %, 40 mol% ionizable costs twenty points, and 55 mol%
  // is already on the plateau; N/P below about 5 starves it.
  const ee = 97 / (1 + Math.exp(-(ion - 36.2) / 3.6)) * ((1 - 0.55 * Math.exp(-np / 2.2)) / 0.9638)
    - 2 * Math.max(0, frr - 4);
  return { size: Math.max(25, size), pdi: Math.max(0.03, pdi), ee: Math.max(10, Math.min(99.5, ee)) };
}

/** Nanometres per day in storage: low PEG and a warm shelf drift, a cold shelf barely does. */
export function driftPerDay(plan, condition) {
  const peg = Number(plan?.compositionOverride?.peg_pct ?? 1.5);
  const base = 0.95 - 0.3 * (peg - 1);
  return Math.max(0.02, base) * (condition === '25C' ? 1 : condition === '37C' ? 2.2 : 0.3);
}

/* ---------------- writing the lab ---------------- */

function measurement(store, settings, b, slot, expId, values, r) {
  const rec = {
    id: `DM${Math.abs(Math.round(r() * 1e9)).toString(36)}${slot.id.length}`,
    batchId: b.id, experimentId: expId, test: slot.test, stage: slot.stage,
    condition: slot.condition || '', timepoint: slot.timepoint ?? null, date: slot.dueDate,
    sampleName: slot.sampleName || `${b.id}_${slot.stage}`, slotId: slot.id, values,
    flags: qcFlags(slot.test, values, settings.qc), operator: settings.operator, notes: '',
  };
  store.put('measurements', rec);
  slot.status = 'done'; slot.measurementId = rec.id;
  return rec;
}

/** Values for one test on one batch, at a storage timepoint if it has one. */
function valuesFor(test, plan, slot, r) {
  const t = truth(plan);
  const day = Number(slot.timepoint ?? 0);
  const grown = t.size + (day > 0 ? driftPerDay(plan, slot.condition) * day : 0);
  switch (test) {
    case 'dls': return { zave_nm: round(grown + gauss(r) * 1.9, 1), pdi: round(t.pdi + gauss(r) * 0.007, 3), count_rate_kcps: round(180 + gauss(r) * 25, 0) };
    case 'ee': return { ee_pct: round(Math.min(99.5, t.ee - day * 0.05 + gauss(r) * 1.2), 1) };
    case 'zeta': return { zeta_mV: round(-1.5 + gauss(r) * 2.2, 1) };
    case 'content': return { rna_mg_mL: round(0.1 + gauss(r) * 0.004, 3) };
    // pctControl, the field the result form and the evaluation read: as potency_pct it showed nowhere (cycle 6, I9).
    case 'potency': return { pctControl: round(100 - day * 0.4 + gauss(r) * 6, 0) };
    case 'ph': return { ph: round(7.4 + gauss(r) * 0.05, 2) };
    default: return {};
  }
}
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** One experiment, its batches, and every measurement it expected — built by the app's own planner. */
function addExperiment(store, settings, id, spec, r, { measure = true } = {}) {
  const taken = store.all('batches').filter((b) => b.experimentId === id).map((b) => b.id);
  const { experiment, batches } = buildExperiment(spec, { settings, takenFormulations: taken, experimentId: id });
  // An experiment that has not been run yet has nothing produced: saying otherwise makes the demo's one open
  // experiment look finished, which is the opposite of what it is there to show.
  for (const b of batches) { if (measure) b.status = 'produced'; store.put('batches', b); }
  if (measure) {
    for (const slot of experiment.expected) {
      const b = batches.find((x) => x.id === slot.batchId);
      if (!b) continue;
      // the slot object itself, so marking it done lands on the experiment that is about to be stored
      measurement(store, settings, b, slot, id, valuesFor(slot.test, b.plan, slot, r), r);
      if (b.status !== 'measured') { b.status = 'measured'; store.put('batches', b); }
    }
    experiment.status = 'done';
  }
  store.put('experiments', experiment);
  return { experiment, batches };
}

/** The demo's RNA lots: the mRNA every finished experiment was made with, and the siRNA of the planned one. */
export const DEMO_RNA_LOTS = [
  { id: 'RNA-FLuc-001', cargo: 'mRNA', construct: 'FLuc mRNA', variant: 'N1-methyl-pseudouridine, CleanCap AG', conc_mg_mL: 1.0, method: 'UV A260', supplier: 'in-house IVT', length_nt: 1929 },
  { id: 'siRNA-TTR-001', cargo: 'siRNA', construct: 'TTR siRNA', variant: '21/21-nt duplex, 2′-OMe', conc_mg_mL: 2.0, method: 'UV A260', supplier: 'custom synthesis', length_nt: 21 },
];

/** The demo's prepared buffer lots: the two buffers every demo process names, as the Buffers screen saves them. */
const DEMO_BUFFERS = [
  { name: 'Citrate 50 mM, pH 4.0', system: 'Citric acid', method: 'auto', targetPH: 4, conc_mM: 50, volume_mL: 1000, nacl_mM: 0, sucrose_mM: 0, activity: true,
    system2: '', conc2_mM: 0, reagent2: '', roles: ['loading', 'quench'], notes: 'Measured pH 4.01. Filtered 0.2 µm.' },
  { name: 'PBS, pH 7.4', system: 'Phosphoric acid', method: 'auto', targetPH: 7.4, conc_mM: 10, volume_mL: 2000, nacl_mM: 137, sucrose_mM: 0, activity: true,
    system2: '', conc2_mM: 0, reagent2: '', roles: ['quench', 'dialysis'], notes: 'Without KCl. Measured pH 7.39.' },
];

const doeFactor = (name, unit, low, high, applyTo) => ({ name, unit, low, center: '', high, applyTo });
const RESP3 = [
  { name: 'particle_size_nm', unit: 'nm', min_valid: 10, max_valid: 500, goal: 'target', target: 80 },
  { name: 'PDI', unit: '', min_valid: 0, max_valid: 1, goal: 'minimize', target: null },
  { name: 'encapsulation_efficiency', unit: '%', min_valid: 0, max_valid: 100, goal: 'maximize', target: null },
];

/**
 * Fill an empty demo namespace with a lab that has already done the work.
 * @param {Store} store a store already pointed at DEMO_NS
 * @param {number} compositionId which formulation the demo runs
 */
export function seedDemo(store, compositionId = 1) {
  const r = rng();
  const settings = { ...DEFAULT_SETTINGS, id: 'default', operator: 'Demo' };
  store.put('settings', settings);

  const today = todayISO();
  const back = (d) => addDays(today, -d);
  // Every experiment is made on the lab's own rig: three pumps into a T-mixer with an inline quench, the RNA in
  // citrate 50 mM pH 4.0, dialysed into PBS pH 7.4 (calc/process.js). The full process, except the first
  // screen, which is run quick (stopped at the mixer, 5 mL each), the way a screen usually is.
  const base = { rna_mg: 3, working_mg_mL: 0.4, frr: 3, quenchFactor: 2, totalFlow: 112.5, lipidStock_mM: 50,
    stockId: '', rnaLotId: '', rnaStock_mg_mL: null, batchesPerDay: 4, weekendShift: true,
    mode: 'full', process: JSON.parse(JSON.stringify(LAB_PROCESS)),
    stability: {}, ofat: {}, comparison: {}, reference: {}, doe: {} };

  // 1 · three reference batches: the control chart needs a baseline before anything else means much.
  addExperiment(store, settings, 'E1', { ...base, type: 'reference', name: 'Reference reproducibility',
    startDate: back(96), compositionId, tests: ['dls', 'ee', 'zeta'], reference: { n: 3 } }, r);

  // 2 · one factor at a time, the way most people actually start.
  addExperiment(store, settings, 'E2', { ...base, type: 'ofat', name: 'N/P scan',
    startDate: back(82), compositionId, tests: ['dls', 'ee'], ofat: { factor: 'np', levels: [3, 6, 9, 12] } }, r);

  // 3 · the screening factorial: two factors, four corners, three centre points. The example everyone is shown.
  addExperiment(store, settings, 'E3', { ...base, mode: 'quick', volume_mL: 5, type: 'doe', name: 'FRR x flow rate screen',
    startDate: back(68), compositionId, tests: ['dls', 'ee'],
    doe: { designType: 'full_factorial', model: 'interaction', centerPoints: 3, replicates: 1, seed: 42, alpha: null,
      plateFormat: null, plateStartWell: 'A1',
      factors: [doeFactor('FRR', '', 2, 4, 'frr'), doeFactor('flow_rate', 'mL/min', 60, 120, 'tfr')], responses: RESP3 } }, r);

  // 4 · the response surface: three factors face-centred, which is where the curvature above becomes visible
  //     and where the contour plot has something to show.
  addExperiment(store, settings, 'E4', { ...base, type: 'doe', name: 'Response surface FRR x flow x PEG',
    startDate: back(44), compositionId, tests: ['dls', 'ee'],
    doe: { designType: 'ccd_faced', model: 'quadratic', centerPoints: 4, replicates: 1, seed: 7, alpha: null,
      plateFormat: null, plateStartWell: 'A1',
      factors: [doeFactor('FRR', '', 2, 4, 'frr'), doeFactor('flow_rate', 'mL/min', 60, 120, 'tfr'),
        doeFactor('PEG_mol_pct', 'mol%', 1, 2.5, 'peg_pct')], responses: RESP3 } }, r);

  // 5 · a composition screen, so the ML optimiser sees ionizable content vary as well as the process.
  addExperiment(store, settings, 'E5', { ...base, type: 'doe', name: 'Ionizable x PEG screen',
    startDate: back(26), compositionId, tests: ['dls', 'ee'],
    doe: { designType: 'full_factorial', model: 'interaction', centerPoints: 2, replicates: 1, seed: 11, alpha: null,
      plateFormat: null, plateStartWell: 'A1',
      factors: [doeFactor('ionizable_mol_pct', 'mol%', 40, 55, 'ionizable_pct'),
        doeFactor('PEG_mol_pct', 'mol%', 1, 2.5, 'peg_pct')], responses: RESP3 } }, r);

  // 6 · the stability study: five timepoints on two shelves, which is what turns size drift into a response.
  addExperiment(store, settings, 'E6', { ...base, type: 'stability', name: 'Stability 4 °C vs 25 °C',
    startDate: back(30), compositionId, tests: ['dls', 'ee'],
    stability: { formulations: [{ compositionId }], conditions: ['4C', '25C'],
      timepoints: [0, 7, 14, 21, 28], tests: ['dls', 'ee'], potencyAt: [0, 28] } }, r);

  // 7 · one planned experiment with nothing measured yet, so the screens that show open work have some. It is
  //     the lab's first siRNA run (the reference composition is Onpattro's, an siRNA product), made from the
  //     siRNA lot below: the cargo shows on every screen it reaches. Nothing is measured, so the invented truth
  //     above, and with it every other number in the demo, is untouched.
  addExperiment(store, settings, 'E7', { ...base, type: 'single', name: 'Next candidate: siRNA (not run yet)',
    startDate: addDays(today, 2), compositionId, tests: ['dls', 'ee'], cargo: 'siRNA',
    rnaLotId: DEMO_RNA_LOTS[1].id, rnaStock_mg_mL: DEMO_RNA_LOTS[1].conc_mg_mL }, r, { measure: false });

  // The materials the experiments above are made with: the RNA lots, and the buffers every process names
  // (citrate 50 mM pH 4.0 in, PBS pH 7.4 out), prepared as lots, so the Buffers screen, the process designer's
  // menus and Materials have something on the shelf. Seeded after the experiments: no random number is drawn.
  for (const lot of DEMO_RNA_LOTS) store.put('rnaLots', { ...lot, received: back(120) });
  DEMO_BUFFERS.forEach((b, i) => store.put('buffers', { ...b, id: `Buffer-00${i + 1}`, lot: `Buffer-00${i + 1}`, date: back(100 - i), operator: settings.operator }));
  raiseCounter(store, 'buffer', `Buffer-00${DEMO_BUFFERS.length}`);

  store.put('demo', { id: 'meta', seededAt: new Date().toISOString(), version: 1 });
  return store;
}

/** True once a demo namespace has something in it. */
export function demoSeeded(store) { return store.count('experiments') > 0; }
