// Experiment templates: the type chosen first generates batches, expected measurement slots and sample names.
// Pure functions; the Experiments screen collects the spec and stores what comes back.
import { buildDesign, randomizeRuns, specMode, specComponents, isCategorical, categoricalLevel } from './doe.js';
import { makeFormulationAllocator, sampleName } from '../schema.js';
import { addDays as addDaysISO, shiftWeekend, nextWorkday } from './dates.js';
import { effectiveQuench, syncQuick, QUICK_VOLUME_mL } from './process.js';
import { cargoInfo } from './cargo.js';

export const TYPES = [
  { id: 'single', name: 'Single formulation', desc: '1 batch · DLS, EE%, optional potency' },
  { id: 'stability', name: 'Stability study', desc: 'n formulations × storage conditions × timepoints · reminders' },
  { id: 'ofat', name: 'Optimization · one factor (OFAT)', desc: '1 parameter at n levels, rest fixed · e.g. N/P 3, 6, 9, 12' },
  { id: 'doe', name: 'Optimization · DoE (2 to n factors)', desc: 'choose a design, runs become batches' },
  { id: 'comparison', name: 'Compare compositions', desc: 'several compositions, same process' },
  { id: 'reference', name: 'Reference reproducibility', desc: 'same recipe n times · feeds the control chart' },
];

export const TESTS = [
  { id: 'dls', name: 'DLS (Z-ave, PDI)' }, { id: 'zeta', name: 'Zeta potential' }, { id: 'ee', name: 'EE % (RiboGreen)' },
  { id: 'content', name: 'RNA content' }, { id: 'potency', name: 'Potency (in vitro)' }, { id: 'ph', name: 'pH' },
  { id: 'osmolality', name: 'Osmolality' }, { id: 'integrity', name: 'RNA integrity' }, { id: 'lipid_content', name: 'Lipid content (HPLC)' },
];

/** Factors an OFAT or DoE experiment can vary. `apply` writes the level into a batch plan. */
export const FACTORS = [
  { key: 'np', name: 'N/P ratio', unit: '', default: 6, doeName: 'NP_ratio', range: [3, 9], apply: (plan, v) => { plan.rna.np = v; } },
  { key: 'frr', name: 'Flow rate ratio (aq : org)', unit: '', default: 3, doeName: 'FRR', range: [2, 4], apply: (plan, v) => { plan.mixing.frr = v; } },
  { key: 'tfr', name: 'Total flow rate', unit: 'mL/min', default: 112.5, doeName: 'flow_rate', range: [60, 120], apply: (plan, v) => { plan.mixing.totalFlow = v; } },
  { key: 'quench', name: 'Quench factor (× lipid volume)', unit: '', default: 2, doeName: 'quench_factor', range: [1, 3], apply: (plan, v) => { plan.mixing.quenchFactor = v; } },
  // The two lipid factors write only the class they set. The sterol that keeps the recipe at 100 mol% is worked
  // out where the recipe is read (overriddenComposition in composition.js), not written here, so a batch saved
  // before that existed reads back balanced too, and the optimizer's own overrides (which set every class) are
  // left as they are.
  { key: 'peg_pct', name: 'PEG-lipid', unit: 'mol%', default: 1.5, doeName: 'PEG_mol_pct', range: [1, 2.5], apply: (plan, v) => { plan.compositionOverride = { ...(plan.compositionOverride || {}), peg_pct: v }; } },
  { key: 'ionizable_pct', name: 'Ionizable lipid', unit: 'mol%', default: 47.5, doeName: 'ionizable_mol_pct', range: [40, 55], apply: (plan, v) => { plan.compositionOverride = { ...(plan.compositionOverride || {}), ionizable_pct: v }; } },
  { key: 'lipid_mM', name: 'Lipid stock molarity', unit: 'mM', default: 50, doeName: 'lipid_mM', range: [30, 60], apply: (plan, v) => { plan.mixing.lipidStock_mM = v; } },
  { key: 'rna_mg_mL', name: 'RNA working concentration', unit: 'mg/mL', default: 0.4, doeName: 'RNA_mg_mL', range: [0.2, 0.6], apply: (plan, v) => { plan.rna.working_mg_mL = v; } },
  // The aqueous phase the RNA is in (plan.process.aqueous, see calc/process.js). Written as a part of the
  // process, so the rest of the aqueous phase (the buffer named, its concentration) stays as planned; a level
  // set here is the record's own, and the designer does not work it out again from the buffer's name.
  { key: 'aq_pH', name: 'Aqueous buffer pH', unit: '', default: 4, doeName: 'aqueous_pH', range: [3, 6], apply: (plan, v) => { aqueous(plan).pH = v; } },
  { key: 'aq_ionic', name: 'Aqueous ionic strength', unit: 'mM', default: 50, doeName: 'ionic_strength_mM', range: [10, 150], apply: (plan, v) => { aqueous(plan).ionicStrength_mM = v; } },
  // The mixer, the one factor whose levels are not numbers: each level is a mixer id from the device list
  // (app/data/devices.json and Materials › Formulation devices), e.g. the KNAUER IJM 1 to 5. `categorical`
  // tells every reader not to treat a level as a quantity: OFAT ticks the mixers instead of typing numbers, a
  // design codes two mixers as −1/+1 with no middle (calc/doe.js isCategorical), and results read a level by
  // its name. It writes only the mixer, so the device and the rest of the process stay as planned.
  { key: 'mixer', name: 'Mixer', unit: '', categorical: true, default: null, doeName: 'mixer', range: [-1, 1], apply: (plan, v) => { plan.process = { ...(plan.process || {}), mixerId: String(v) }; } },
];
/** Whether a factor key (or a FACTORS entry) takes named levels rather than numbers: the mixer. */
export const isCategoricalFactor = (f) => !!(typeof f === 'string' ? FACTORS.find((x) => x.key === f) : f)?.categorical;
/**
 * A level as a person reads it: a mixer by its name, a number as it is. `labels` is what the experiment stored
 * when it was created ({id: name}, spec.ofat.labels or a design factor's levelNames), so a record keeps saying
 * "KNAUER IJM 3" after the mixer list changes; an id it does not know is shown as it is.
 */
export function levelText(key, value, labels = null) {
  if (value == null || value === '') return '';
  if (!isCategoricalFactor(key)) return String(value);
  return labels?.[value] || String(value);
}
/** The plan's aqueous phase, made where a plan has none yet (processOf() fills in the rest when it is read). */
function aqueous(plan) { plan.process ||= {}; plan.process.aqueous = { ...(plan.process.aqueous || {}) }; return plan.process.aqueous; }

/** Pump flows from total flow, FRR and quench factor (three-pump layout). T = p2·(frr + 1 + quench). */
export function flowsFromTotal(total, frr, quench) {
  const p2 = total / (frr + 1 + quench);
  return { p1: p2 * frr, p2, p3: p2 * quench, p4: 0 };
}

export { addDays as addDaysISO, shiftWeekend, nextWorkday, todayISO } from './dates.js';
/** Production date of the i-th batch (0-based) with `perDay` batches per workday from startDate. */
export function productionDate(startDate, i, perDay = 4) { let d = startDate; for (let k = 0; k < Math.floor(i / Math.max(1, perDay)); k++) d = nextWorkday(addDaysISO(d, 1)); return nextWorkday(d); }

/**
 * The numbers typed into one box: "0, 7, 14", "3 6 9", or "0,5; 1,5" with decimal commas.
 *
 * Empty tokens are dropped before they become numbers, because Number('') is 0: an empty box, or a trailing
 * comma or space, otherwise turns into a 0 nobody typed. An empty custom-timepoints box read that way became
 * [0] and replaced the whole duration/interval schedule with T0 alone.
 *
 * A comma separates, unless the list is separated by semicolons; only then is it read as a decimal comma.
 * "0,5" in a box of days is far more often T0 and T5 than half a day, and guessing between the two would make
 * the same text mean different things in different boxes.
 */
export function parseNumberList(text) {
  const s = String(text ?? '');
  const tokens = s.includes(';') ? s.split(/[;\s]+/).map((t) => t.replace(',', '.')) : s.split(/[,\s]+/);
  return tokens.filter((t) => t !== '').map(Number).filter(Number.isFinite);
}

/**
 * Stability timepoints in days, from the wizard's fields: the custom list when one was typed, otherwise every
 * `intervalDays` from 0 to `durationDays`, with the duration itself always the last pull even when the
 * interval does not land on it.
 */
export function stabilityTimepoints({ timepointsText = '', durationDays = 28, intervalDays = 3 } = {}) {
  const custom = parseNumberList(timepointsText).filter((x) => x >= 0);
  if (custom.length) return [...new Set(custom)].sort((a, b) => a - b);
  const dur = Math.max(0, Math.min(3650, Number(durationDays) || 0)), step = Math.max(1, Number(intervalDays) || 1); // guards: a 0 interval must not loop forever
  const out = []; for (let t = 0; t <= dur; t += step) out.push(t); if (out[out.length - 1] !== dur) out.push(dur); return out;
}

/**
 * Build everything an experiment needs from a spec.
 * @param {object} spec  {type, name, startDate, compositionId, stockId, rnaLotId, cargo ('mRNA'|'siRNA'), rna_mg, working_mg_mL, lipidStock_mM,
 *                        frr, quenchFactor, totalFlow, tests:[test ids], batchesPerDay, weekendShift,
 *                        mode:'quick'|'full', volume_mL (quick: the volume to formulate, mRNA follows from it),
 *                        process (calc/process.js; copied onto every formulation, each then its own),
 *                        stability:{formulations:[{compositionId,label}], conditions:[], timepoints:[days], tests:[], potencyAt:[days], replicates},
 *                        ofat:{factor, levels:[]},
 *                        doe:{designType, model, centerPoints, replicates, seed, plateFormat?, factors:[{name, unit, low, center?, high, applyTo?}], responses:[{name, goal, target?}]},
 *                        comparison:{compositionIds:[]}, reference:{n}}
 * @param {object} env   {settings, experimentId, takenFormulations:[ids in use] | nextFormulation:()=>id}
 */
export function buildExperiment(spec, env) {
  const { settings } = env;
  const expId = env.experimentId;
  const nextFormulation = env.nextFormulation || makeFormulationAllocator(expId, env.takenFormulations || []);
  // A spec without a mode is one made before modes existed (or by code that never asks): the full process.
  // Quick mode sets the volume once for the experiment; each formulation can change its own on the record.
  const quick = spec.mode === 'quick';
  const basePlan = () => ({
    mode: quick ? 'quick' : 'full', ...(quick ? { volume_mL: Number(spec.volume_mL) > 0 ? Number(spec.volume_mL) : settings.defaultQuickVolume_mL ?? QUICK_VOLUME_mL } : {}),
    rna: { lotId: spec.rnaLotId || null, stock_mg_mL: spec.rnaStock_mg_mL ?? null, working_mg_mL: spec.working_mg_mL ?? settings.defaultWorking_mg_mL, mass_mg: spec.rna_mg ?? 3, np: null,
      // The cargo (mRNA, siRNA; calc/cargo.js), chosen in the wizard and copied onto every formulation: a spec without
      // one is mRNA, which every experiment was before there was a choice.
      cargo: cargoInfo(spec.cargo).id },
    mixing: { frr: spec.frr ?? settings.defaultFRR, quenchFactor: spec.quenchFactor ?? settings.defaultQuenchFactor, totalFlow: spec.totalFlow ?? 112.5, lipidStock_mM: spec.lipidStock_mM ?? settings.defaultLipidStock_mM, flows: null },
    // A copy for each formulation: changing one record's process must not change its siblings'. A spec with
    // no process leaves it off, and the plan reads as the lab layout (processOf in calc/process.js).
    ...(spec.process ? { process: JSON.parse(JSON.stringify(spec.process)) } : {}),
    downstream: {}, factors: {}, conditions: {},
  });
  const batches = [];
  const slots = [];
  const perDay = spec.batchesPerDay || 4;
  const dateFor = (i) => productionDate(spec.startDate, i, perDay);
  // `factors` is recorded on the plan (and shown as the batch's factor settings); `applied` maps FACTORS keys to values written into the plan.
  const mkBatch = (label, compositionId, factors = {}, i = batches.length, applied = factors) => {
    const plan = basePlan();
    for (const [k, v] of Object.entries(applied)) FACTORS.find((f) => f.key === k)?.apply(plan, v);
    plan.factors = factors;
    // A process without quench runs no quench pump, whatever the quench factor says.
    plan.mixing.flows = flowsFromTotal(plan.mixing.totalFlow, plan.mixing.frr, effectiveQuench(plan));
    syncQuick(plan); // quick mode: the mRNA in the chosen volume, after any factor that changes it (FRR, quench, RNA conc.)
    const b = { id: nextFormulation(), experimentId: expId, label, compositionId, stockId: spec.stockId || null, plannedDate: dateFor(i), status: 'planned', plan, actual: {}, notes: '', provenance: { source: 'manual' } };
    batches.push(b);
    return b;
  };
  const slotFor = (b, test, stage, dueDate, extra = {}) => slots.push({ id: `${b.id}_${stage}_${test}${extra.condition ? '_' + extra.condition : ''}`, batchId: b.id, stage, test, dueDate, status: 'open', measurementId: null, sampleName: extra.sampleName || sampleName({ batchId: b.id, stage }), ...extra });
  const tests = spec.tests?.length ? spec.tests : ['dls', 'ee'];
  const finalSlots = (b) => { const due = nextWorkday(addDaysISO(b.plannedDate, 1)); for (const t of tests) slotFor(b, t, 'final', due); };

  const design = {};
  switch (spec.type) {
    case 'single': { finalSlots(mkBatch('the formulation', spec.compositionId)); break; }
    case 'reference': { const n = spec.reference?.n || 3; for (let i = 0; i < n; i++) finalSlots(mkBatch(`rep ${i + 1}`, spec.compositionId)); break; }
    case 'comparison': { (spec.comparison?.compositionIds || [spec.compositionId]).forEach((cid) => finalSlots(mkBatch(`composition #${cid}`, cid))); break; }
    case 'ofat': {
      const f = FACTORS.find((x) => x.key === spec.ofat.factor);
      // Refused rather than created empty: an experiment with no formulations has nothing to make or measure.
      if (!spec.ofat.levels?.length) throw new Error(f?.categorical ? `tick at least one ${f.name.toLowerCase()} to compare` : 'type at least one level for the factor, e.g. 3, 6, 9, 12');
      // A mixer level is labelled by its name ("Mixer KNAUER IJM 3"), from the names the wizard stored with the spec.
      (spec.ofat.levels || []).forEach((lv) => finalSlots(mkBatch(`${f?.name || spec.ofat.factor} ${levelText(spec.ofat.factor, lv, spec.ofat.labels)}`, spec.compositionId, { [spec.ofat.factor]: lv })));
      design.factor = spec.ofat.factor; design.levels = spec.ofat.levels;
      if (spec.ofat.labels) design.labels = { ...spec.ofat.labels };
      break;
    }
    case 'doe': {
      // Design matrix as the DoE pipeline builds it, run order from the app's seeded shuffle; one batch per run in run order.
      const d = spec.doe;
      const runs = randomizeRuns(d, buildDesign(d));
      // A mixture run names every lipid outright, which the class-based factor overrides cannot express: there
      // is no "ionizable mol%" to set when the design is choosing between two ionizable lipids. So the blend
      // goes on the plan as an explicit mol% map and the batch record weighs out exactly that.
      const mixComps = specMode(d) === 'process' ? [] : specComponents(d);
      runs.forEach((r) => {
        const applied = {}, recorded = { ...r.real };
        for (const f of d.factors || []) {
          // A categorical factor (the mixer) is coded −1/+1 in the design; the batch gets the mixer itself, and
          // its record says which one, so nothing downstream has to know the coding.
          const v = isCategorical(f) ? categoricalLevel(f, r.coded[f.name]) : r.real[f.name];
          if (isCategorical(f)) recorded[f.name] = v;
          if (f.applyTo) applied[f.applyTo] = v;
        }
        const b = mkBatch(`${r.run_id} (${r.point_type})`, spec.compositionId, recorded, batches.length, applied);
        if (mixComps.length) {
          const mol_pct = {};
          for (const c of mixComps) if (Number.isFinite(r.real[c.name])) mol_pct[c.lipidKey || c.name] = r.real[c.name];
          b.plan.compositionOverride = { ...(b.plan.compositionOverride || {}), mol_pct };
        }
        b.doe = { run_id: r.run_id, run_order: r.run_order, std_order: r.std_order, point_type: r.point_type, well: r.well ?? null, coded: r.coded };
        r.batchId = b.id;
        finalSlots(b);
      });
      design.doe = { spec: d, runs }; break;
    }
    case 'stability': {
      const st = spec.stability;
      const forms = st.formulations?.length ? st.formulations : [{ compositionId: spec.compositionId, label: 'F1' }];
      const tps = st.timepoints?.length ? st.timepoints : [0, 3, 7, 14, 28];
      const stTests = st.tests?.length ? st.tests : ['dls', 'ee'];
      forms.forEach((f, i) => {
        const b = mkBatch(f.label || `arm ${i + 1}`, f.compositionId, {}, 0);
        b.plannedDate = spec.startDate;
        for (const cond of st.conditions || ['4C']) {
          for (const t of tps) {
            let due = addDaysISO(spec.startDate, t);
            if (spec.weekendShift !== false && t > 0) due = shiftWeekend(due);
            const testsHere = [...stTests, ...((st.potencyAt || []).includes(t) ? ['potency'] : [])];
            for (const test of testsHere) {
              slotFor(b, test, `T${t}`, due, { condition: cond, timepoint: t, formulation: b.label,
                sampleName: sampleName({ batchId: b.id, condition: cond, timepoint: t }) });
            }
          }
        }
      });
      design.stability = { formulations: forms.map((f, i) => ({ ...f, label: f.label || `arm ${i + 1}` })), conditions: st.conditions || ['4C'], timepoints: tps, tests: stTests, potencyAt: st.potencyAt || [] };
      break;
    }
    default: throw new Error('Unknown experiment type ' + spec.type);
  }
  const experiment = { id: expId, type: spec.type, name: spec.name, startDate: spec.startDate, compositionId: spec.compositionId, status: 'planned', spec, design, batchIds: batches.map((b) => b.id), expected: slots };
  return { experiment, batches };
}

/** Progress and next due items for an experiment. */
export function experimentProgress(exp, today) {
  const slots = exp.expected || [];
  const done = slots.filter((s) => s.status === 'done').length;
  const open = slots.filter((s) => s.status === 'open');
  const overdue = open.filter((s) => s.dueDate < today);
  const nextDue = open.map((s) => s.dueDate).sort()[0] || null;
  return { total: slots.length, done, open: open.length, overdue: overdue.length, nextDue, dueToday: open.filter((s) => s.dueDate === today) };
}
