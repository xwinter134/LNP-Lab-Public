// The design space: which knobs the optimiser may turn, their ranges, and how a suggested setting becomes
// a real batch plan. This is the bridge between the lab's vocabulary and the model's unit cube.
//
// Lipid composition carries a mixture constraint (mol% must sum to 100). Rather than optimising on a simplex,
// one lipid is nominated as the balance component and absorbs whatever the varied lipids leave over. That is
// what formulators do by hand (vary ionizable and PEG, let cholesterol take up the slack), it keeps the search
// space a plain box the surrogate handles natively, and the constraint holds exactly by construction.
import { FACTORS } from '../experiment.js';
import { overriddenComposition } from '../composition.js';
import { VARIABLE_BY_KEY, readVariable } from '../variables.js';

/** Process factors the optimiser can set, with the batch fields they read from and write to. */
export const PROCESS_FACTORS = [
  // Sato et al. 2024 ran 1:1 to 3:1 and found every large effect between 35 and 50 per cent ethanol after
  // mixing. A floor of 2:1 caps ethanol at 33 per cent, which put that whole band out of the optimiser's
  // reach, so the floor is 1:1. Low ratios are legitimate settings, not mistakes, but this edition carries no
  // model of the mixing hardware, so nothing here will tell you a low ratio is one your rig cannot hold.
  { key: 'frr', name: 'Flow rate ratio (aq : org)', unit: '', lo: 1, hi: 6, step: 0.1, read: (b) => b.plan?.mixing?.frr },
  { key: 'tfr', name: 'Total flow rate', unit: 'mL/min', lo: 20, hi: 150, step: 1, read: (b) => b.plan?.mixing?.totalFlow },
  { key: 'np', name: 'N/P ratio', unit: '', lo: 3, hi: 12, step: 0.5, read: (b) => b.plan?.rna?.np },
  { key: 'quench', name: 'Quench factor', unit: '× lipid volume', lo: 1, hi: 10, step: 0.5, read: (b) => b.plan?.mixing?.quenchFactor },
  { key: 'lipid_mM', name: 'Lipid stock molarity', unit: 'mM', lo: 20, hi: 70, step: 0.5, read: (b) => b.plan?.mixing?.lipidStock_mM },
  { key: 'rna_mg_mL', name: 'RNA working concentration', unit: 'mg/mL', lo: 0.1, hi: 0.8, step: 0.02, read: (b) => b.plan?.rna?.working_mg_mL },
  // The aqueous phase as the formulation records it (variables.js, schema 3, role factor). Their default ranges
  // come from the registry, so the form, the importer and the optimizer agree. A lab that never records them
  // never sees them offered: suggestSpace only offers a factor that actually varied.
  ...['loadingPH', 'bufferMolarity_mM'].map((key) => {
    const v = VARIABLE_BY_KEY[key];
    return { key, name: v.name, unit: v.unit === 'pH' ? '' : v.unit, lo: v.lo, hi: v.hi, step: v.stepSize, read: (b) => readVariable(b, key) };
  }),
];

/** Composition factors: mol% of one lipid class. The balance class keeps the total at 100. */
export const COMPOSITION_FACTORS = [
  { key: 'ionizable_pct', cls: 'ionizable', name: 'Ionizable lipid', unit: 'mol%', lo: 35, hi: 60, step: 0.5 },
  { key: 'helper_pct', cls: 'helper', name: 'Helper phospholipid', unit: 'mol%', lo: 5, hi: 20, step: 0.5 },
  { key: 'peg_pct', cls: 'peg', name: 'PEG-lipid', unit: 'mol%', lo: 0.5, hi: 3, step: 0.1 },
  { key: 'sterol_pct', cls: 'sterol', name: 'Cholesterol / sterol', unit: 'mol%', lo: 20, hi: 55, step: 0.5 },
];
export const ALL_FACTORS = [...PROCESS_FACTORS, ...COMPOSITION_FACTORS];
export const factorByKey = (key) => ALL_FACTORS.find((f) => f.key === key);

/** mol% per lipid class for a composition record. */
export function classPercents(comp, ref) {
  const out = { ionizable: 0, helper: 0, peg: 0, sterol: 0, other: 0 };
  if (!comp) return out;
  for (const [k, v] of Object.entries(comp.mol_pct || {})) {
    const cls = ref.lipidByKey[k]?.class || 'other';
    out[cls] = (out[cls] || 0) + Number(v);
  }
  return out;
}

/** Read every factor value a batch actually has (null where unknown). */
export function readFactors(batch, ref) {
  const row = {};
  for (const f of PROCESS_FACTORS) { const v = f.read(batch); row[f.key] = Number.isFinite(v) ? Number(v) : null; }
  // The recipe as weighed out: a DoE lipid factor has the sterol absorb the change, and the bench record, the
  // weigh-in and this module must all read the same numbers or the optimizer learns from a recipe nobody made.
  const comp = overriddenComposition(ref.compositionById[batch.compositionId], batch.plan?.compositionOverride, ref);
  const cp = classPercents(comp, ref);
  // A composition override may be keyed by class ("ionizable") or by factor key ("ionizable_pct"): the DoE
  // factors write the second form, this module writes the first. Both are accepted so a batch created by one
  // part of the app is readable by the other.
  const ov = batch.plan?.compositionOverride || {};
  for (const cf of COMPOSITION_FACTORS) {
    const v = Number.isFinite(ov[cf.key]) ? ov[cf.key] : Number.isFinite(ov[cf.cls]) ? ov[cf.cls] : cp[cf.cls];
    row[cf.key] = Number.isFinite(v) && v > 0 ? Number(v) : null;
  }
  // DoE batches record their own factor values; a named factor that matches a design key wins.
  for (const [k, v] of Object.entries(batch.plan?.factors || {})) {
    if (row[k] == null && Number.isFinite(v)) row[k] = Number(v);
    const mapped = FACTORS.find((x) => x.key === k);
    if (mapped && Number.isFinite(v)) row[mapped.key] = Number(v);
  }
  return row;
}

/**
 * Suggest a design space from the data that exists: a factor is offered when enough batches carry it and it
 * actually varies. Ranges default to the observed span widened by 25 %, clipped to the factor's sane limits,
 * because extrapolating far outside what has been run is where surrogates embarrass themselves.
 */
export function suggestSpace(rows, { minDistinct = 3, pad = 0.25 } = {}) {
  const out = [];
  for (const f of ALL_FACTORS) {
    const vals = rows.map((r) => r.factors[f.key]).filter(Number.isFinite);
    const distinct = new Set(vals.map((v) => Math.round(v * 1e6) / 1e6));
    if (vals.length < Math.max(3, Math.ceil(rows.length * 0.6)) || distinct.size < minDistinct) continue;
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo;
    out.push({ key: f.key, name: f.name, unit: f.unit, step: f.step,
      lo: Math.max(f.lo, round(lo - span * pad, f.step)), hi: Math.min(f.hi, round(hi + span * pad, f.step)),
      observedLo: lo, observedHi: hi, n: vals.length });
  }
  return out;
}
const round = (v, step) => (step ? Math.round(v / step) * step : v);

/** Composition factors in a space, and which class should balance to 100. */
export function mixtureInfo(space) {
  const used = space.filter((s) => COMPOSITION_FACTORS.some((c) => c.key === s.key));
  if (!used.length) return null;
  const classes = used.map((s) => COMPOSITION_FACTORS.find((c) => c.key === s.key).cls);
  // The balance is the composition class that is NOT being varied; cholesterol by convention, else the largest.
  const candidates = COMPOSITION_FACTORS.filter((c) => !classes.includes(c.cls));
  const balance = candidates.find((c) => c.cls === 'sterol') || candidates[0] || null;
  return { varied: used.map((s) => s.key), classes, balance: balance ? balance.cls : null, balanceKey: balance ? balance.key : null };
}

/** The class mol% pointToPlan starts from when no parent composition is given. */
export const DEFAULT_CLASSES = { ionizable: 47.5, helper: 10, peg: 1.8, sterol: 40.7, other: 0 };

/**
 * How much room the mixture constraint leaves the search, in the lab's terms.
 *
 * The balance class takes whatever the varied lipids leave over, so a box of ranges that each look sensible
 * can still hold recipes nobody can weigh out: vary ionizable, PEG and cholesterol near their tops and the
 * helper lipid would have to be negative. The search has to know this before it scores anything, because
 * the surrogate happily predicts a fine particle at a recipe that does not exist. The search keeps the balance
 * class in its ordinary band (COMPOSITION_FACTORS), widened to take in the parent recipe's own value, since a
 * lab that already runs 3 mol% helper lipid should not be told it cannot. That band is convention: only below 0
 * or above 100 is there no recipe at all (canWeighOut), and the reason given says which of the two it is.
 *
 * In terms of the varied lipids that is a band on their sum, [sumLo, sumHi]. It is drawn in by half a step
 * per varied lipid, so a setting inside it still fits after snap() has rounded each lipid to its step, but only
 * as far as the ranges reach: ranges whose only room is at the band's edge (the helper lipid exactly 5 mol% at
 * their lowest corner) keep that edge, where a full margin refused them as if no recipe were there.
 *
 * @param {object[]} space   the factors searched
 * @param {object} baseClasses class mol% of the parent recipe, which fixes the classes neither varied nor balancing
 * @returns {null | {balance, balanceName, varied, lo, hi, fixed, sumLo, sumHi, room:boolean, reason:string|null}}
 *   null when no lipid is varied
 */
export function mixtureLimits(space, baseClasses = DEFAULT_CLASSES) {
  const mix = mixtureInfo(space);
  if (!mix) return null;
  const base = { ...DEFAULT_CLASSES, ...(baseClasses || {}) };
  const varied = mix.varied.map((k) => space.find((s) => s.key === k));
  const names = varied.map((s) => (COMPOSITION_FACTORS.find((c) => c.key === s.key)?.name || s.key));
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  if (!mix.balance) {
    return { ...mix, balanceName: null, varied: mix.varied, lo: null, hi: null, fixed: base.other || 0, sumLo: null, sumHi: null, room: false,
      reason: `Every lipid class is varied (${list}), so none is left to bring the recipe to 100 mol%, and almost no setting in these ranges totals 100. Switch one composition factor off; it then takes up the rest.` };
  }
  const def = COMPOSITION_FACTORS.find((c) => c.cls === mix.balance);
  const own = Number(base[mix.balance]);
  const lo = Math.max(0, Math.min(def.lo, Number.isFinite(own) ? own : def.lo));
  const hi = Math.min(100, Math.max(def.hi, Number.isFinite(own) ? own : def.hi));
  // Everything that is neither varied nor balancing comes from the parent recipe, unchanged.
  const fixed = Object.entries(base).filter(([cls]) => cls !== mix.balance && !mix.classes.includes(cls)).reduce((s, [, v]) => s + (Number(v) || 0), 0);
  const margin = varied.reduce((s, f) => s + (f.step || 0) / 2, 0);
  const bandLo = 100 - fixed - hi, bandHi = 100 - fixed - lo;
  const boxLo = varied.reduce((s, f) => s + f.lo, 0), boxHi = varied.reduce((s, f) => s + f.hi, 0);
  const room = boxLo <= bandHi && boxHi >= bandLo;
  const sumLo = Math.min(bandLo + margin, Math.max(bandLo, boxHi)), sumHi = Math.max(bandHi - margin, Math.min(bandHi, boxLo));
  const r1 = (v) => String(Math.round(v * 10) / 10).replace('-', '−');
  // What the balance class would come to across the ranges. Below 0 or above 100 everywhere, no recipe exists;
  // otherwise the recipes exist and are only unusual, which pointToPlan words the same way.
  const atLo = 100 - fixed - boxHi, atHi = 100 - fixed - boxLo;
  const reason = room ? null
    : atHi < 0 || atLo > 100
      ? `No recipe in these ranges can be weighed out. With ${list} varied, ${def.name} takes up the rest to reach 100 mol%, and here it would come to ${r1(atLo)} to ${r1(atHi)} mol%, ${atHi < 0 ? 'below 0' : 'above 100'} whatever the setting. Narrow the ranges of the varied lipids, or switch one off.`
      : `No recipe in these ranges keeps ${def.name.toLowerCase()} inside the ${r1(lo)}–${r1(hi)} mol% this module treats as ordinary. With ${list} varied, it takes up the rest to reach 100 mol%, and here it would come to ${r1(atLo)} to ${r1(atHi)} mol%. Such a recipe can be made, just not a common one, and the optimizer proposes only ordinary ones. Narrow the ranges of the varied lipids, or vary ${def.name.toLowerCase()} and switch another off.`;
  return { ...mix, balanceName: def.name, lo, hi, fixed, sumLo, sumHi, room, reason };
}

/** The balance class's mol% at a setting, and whether every class of the recipe stays where it may. */
export function mixtureAt(point, limits) {
  if (!limits) return { ok: true, balance: null };
  const vals = limits.varied.map((k) => Number(point?.[k]));
  if (!vals.every((v) => Number.isFinite(v) && v >= 0)) return { ok: false, balance: null };
  const total = vals.reduce((s, v) => s + v, 0) + limits.fixed;
  if (!limits.balance) return { ok: Math.abs(total - 100) <= 0.05, balance: null };
  const balance = Math.round((100 - total) * 1000) / 1000;
  return { ok: balance >= limits.lo - 1e-9 && balance <= limits.hi + 1e-9, balance };
}

/**
 * Whether a recipe exists at a setting at all: no varied lipid below 0, and the balance class between 0 and 100
 * (with none, a total of 100). mixtureAt's `ok` is the ordinary band the search keeps to; a recipe outside it
 * is unusual, not impossible, and is never to be called one that cannot be weighed out.
 */
export function canWeighOut(point, limits) {
  const at = mixtureAt(point, limits);
  return at.ok || (at.balance != null && at.balance >= 0 && at.balance <= 100);
}

/**
 * Move a setting into the room the mixture leaves, or say it cannot be. A setting that fits is returned as
 * it is. One that does not has its varied lipids moved together, each in proportion to the room it has
 * before its own range ends, until their sum is back inside the band: the smallest change that keeps every
 * lipid inside the range searched. Process factors are never touched. Returns null when no move can fit.
 */
export function fitMixture(point, space, limits) {
  if (!limits) return point;
  if (!limits.balance || !limits.room) return null;
  const varied = limits.varied.map((k) => space.find((s) => s.key === k));
  const sum = varied.reduce((s, f) => s + Number(point[f.key]), 0);
  if (!Number.isFinite(sum)) return null;
  if (sum >= limits.sumLo && sum <= limits.sumHi) return point;
  const down = sum > limits.sumHi;
  const need = down ? sum - limits.sumHi : limits.sumLo - sum;
  const room = varied.map((f) => Math.max(0, down ? point[f.key] - f.lo : f.hi - point[f.key]));
  const total = room.reduce((s, v) => s + v, 0);
  if (total < need - 1e-9) return null;
  const out = { ...point };
  varied.forEach((f, i) => { out[f.key] = point[f.key] + (down ? -1 : 1) * need * (room[i] / total); });
  return out;
}

/**
 * Turn class percentages back into a real composition keyed by lipid, using a parent composition to say which
 * lipid plays each role. Where a class has more than one lipid the existing proportions between them are kept.
 *
 * This is what makes a suggested composition real rather than a note on the batch: the registry, the batch
 * record the operator follows, the weigh-in calculator and the lot number all read the composition by its id.
 * A suggestion stored only as an override would be invisible to every one of them, and the model would later
 * train on a recipe that was never made.
 */
export function compositionFromClasses(base, classPct, ref) {
  if (!base?.mol_pct) return null;
  const byClass = {};
  for (const [key, v] of Object.entries(base.mol_pct)) {
    const cls = ref?.lipidByKey?.[key]?.class || 'other';
    (byClass[cls] ||= []).push([key, Number(v)]);
  }
  const mol_pct = {};
  for (const [cls, members] of Object.entries(byClass)) {
    const target = Number.isFinite(classPct[cls]) ? Number(classPct[cls]) : members.reduce((a, [, v]) => a + v, 0);
    const current = members.reduce((a, [, v]) => a + v, 0);
    for (const [key, v] of members) {
      mol_pct[key] = Math.round((current > 0 ? (v / current) * target : target / members.length) * 1000) / 1000;
    }
  }
  const sum = Object.values(mol_pct).reduce((a, b) => a + b, 0);
  return { mol_pct, sum: Math.round(sum * 1000) / 1000 };
}

/** Do two compositions describe the same recipe, to within a tolerance in mol%? */
export function sameComposition(a, b, tol = 0.05) {
  if (!a?.mol_pct || !b?.mol_pct) return false;
  const keys = new Set([...Object.keys(a.mol_pct), ...Object.keys(b.mol_pct)]);
  for (const k of keys) if (Math.abs((a.mol_pct[k] || 0) - (b.mol_pct[k] || 0)) > tol) return false;
  return true;
}

/** Snap a point to the factors' step sizes and clip it into the space (a pump cannot do 3.1417 mL/min). */
export function snap(point, space) {
  const out = {};
  for (const s of space) {
    const raw = Number(point[s.key]);
    if (!Number.isFinite(raw)) throw new Error(`no value for "${s.key}": a setting cannot be snapped to a factor it does not carry`);
    const v = Math.max(s.lo, Math.min(s.hi, raw));
    out[s.key] = s.step ? Math.round(v / s.step) * s.step : v;
    out[s.key] = Math.round(out[s.key] * 1e6) / 1e6;
  }
  return out;
}
/** Point (real units) → unit cube. */
export const toUnit = (point, space) => space.map((s) => (s.hi > s.lo ? (point[s.key] - s.lo) / (s.hi - s.lo) : 0.5));
/** Unit cube → point (real units). */
export const fromUnit = (u, space) => Object.fromEntries(space.map((s, i) => [s.key, s.lo + u[i] * (s.hi - s.lo)]));

/**
 * Turn a suggested setting into the composition and plan fields a batch needs.
 * @returns {{plan:object, composition:object|null, warnings:{level:'impossible'|'unusual', text:string}[], balanceClass:string|null}}
 *   `impossible` means the recipe cannot be made as stated; `unusual` means it can, but sits outside the range
 *   this module treats as ordinary. The caller decides what to do with each.
 */
export function pointToPlan(point, space, { baseComposition = null, ref = null } = {}) {
  const warnings = [];
  const plan = {};
  for (const f of PROCESS_FACTORS) if (point[f.key] != null && space.some((s) => s.key === f.key)) plan[f.key] = point[f.key];
  const mix = mixtureInfo(space);
  let composition = null;
  if (mix) {
    const base = baseComposition && ref ? classPercents(baseComposition, ref) : { ...DEFAULT_CLASSES };
    composition = { ...base };
    for (const key of mix.varied) {
      const cf = COMPOSITION_FACTORS.find((c) => c.key === key);
      composition[cf.cls] = point[key];
    }
    for (const key of mix.varied) if (!Number.isFinite(composition[COMPOSITION_FACTORS.find((c) => c.key === key).cls])) {
      warnings.push({ level: 'impossible', text: `no value for ${key}: the setting does not carry every composition factor in the space` });
      return { plan, composition: null, warnings, balanceClass: mix.balance };
    }
    for (const key of mix.varied) {
      const cf = COMPOSITION_FACTORS.find((c) => c.key === key);
      if (composition[cf.cls] < 0) warnings.push({ level: 'impossible', text: `${cf.name} would be ${composition[cf.cls]} mol%, which cannot be formulated` });
    }
    const fixedSum = Object.entries(composition).filter(([k]) => k !== mix.balance).reduce((s, [, v]) => s + v, 0);
    if (mix.balance) {
      const bal = Math.round((100 - fixedSum) * 100) / 100;
      composition[mix.balance] = bal;
      const limits = COMPOSITION_FACTORS.find((c) => c.cls === mix.balance);
      if (!Number.isFinite(bal)) warnings.push({ level: 'impossible', text: `${mix.balance} could not be balanced: one of the varied lipids has no value` });
      else if (bal < 0) warnings.push({ level: 'impossible', text: `the varied lipids already total ${fixedSum.toFixed(1)} mol%, so ${mix.balance} would have to be ${bal.toFixed(1)} mol%, which cannot be formulated` });
      // The balance class absorbs whatever is left, which can push it outside anything anyone formulates.
      // Saying so matters because nothing else in the chain checks it: nothing else knows it was derived.
      // A small excursion past a soft bound is worth a note; a large one is worth stopping for.
      else if (bal > 100) warnings.push({ level: 'impossible', text: `${mix.balance} would have to be ${bal.toFixed(1)} mol%, which cannot be formulated` });
      else if (limits && (bal < limits.lo || bal > limits.hi)) {
        // Outside the band this module treats as ordinary, but a formulation all the same: some LNPs really do
        // run a very low helper lipid. Worth saying, never worth blocking — the bounds are convention, not
        // physics, and a module that refuses unusual recipes is a module that cannot find unusual answers.
        warnings.push({ level: 'unusual',
          text: `${mix.balance} would have to be ${bal.toFixed(1)} mol% to reach 100, outside the ${limits.lo}–${limits.hi} mol% this module treats as ordinary. That is a formulation, just not a common one. To avoid it, narrow the ranges of the varied lipids or vary ${mix.balance} instead and let another class balance.` });
      }
    } else {
      const total = fixedSum;
      if (Math.abs(total - 100) > 0.05) warnings.push({ level: 'impossible', text: `mol% sums to ${total.toFixed(2)}, not 100, and no class is free to balance. Switch one composition factor off so it can absorb the remainder.` });
    }
    // Write the same numbers under the factor-key spelling too, so both readers in the app find them.
    for (const cf of COMPOSITION_FACTORS) if (Number.isFinite(composition[cf.cls])) composition[cf.key] = composition[cf.cls];
  }
  return { plan, composition, warnings, balanceClass: mix?.balance || null };
}
