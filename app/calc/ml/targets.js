// Biological targets for the optimizer (spec 7.9), the optimizer's side of the biology layers (spec 8, Phase 6).
//
// The layers themselves (in-vitro expression, in-vivo biodistribution, their studies and references) are built
// elsewhere; this file is the hook they plug into, so the optimizer needs no change when they arrive. A layer
// registers a provider; the optimizer asks the providers for targets only when a biology layer is switched on
// in Settings, and with none on, there are none, and the screen is exactly as before.
//
// What the optimizer does with a biological value, whichever layer it comes from:
//   - it models log10(value / reference), the reference being that study's own control formulation. Expression
//     and luminescence span orders of magnitude and scale multiplicatively from plate to plate and animal to
//     animal; the ratio to the reference cancels the day, the log makes the scatter about even across the range
//     (spec 8.2);
//   - it holds out a whole study at a time (model.js SPLITS.study): wells and animals of one study share a cell
//     passage, a cohort, a day;
//   - size and PDI can stop being goals and become hard limits ("in range, then maximise the liver signal"):
//     physchemAsLimits() turns the goals into the limits the acquisition already understands.
//
// In-vivo optimisation stays switched off in this stage (spec 8.6): an in-vivo target is listed, so the user sees
// it exists, but it cannot be switched on as a goal (INVIVO_OPTIMISATION).

/** In-vivo targets are shown but never optimised in this stage (spec 8.6). */
export const INVIVO_OPTIMISATION = false;

const providers = [];

/**
 * Register a provider: (ctx, settings, isOn) => [{name, label, unit, layer: 'invitro'|'invivo', goal, read(row,
 * ctx) => {value, reference, studyId} | null}]. Returns a function that removes it again.
 */
export function registerTargetProvider(fn) {
  providers.push(fn);
  return () => { const i = providers.indexOf(fn); if (i >= 0) providers.splice(i, 1); };
}

/**
 * The biology layers switched on in Settings. The app keeps them as settings.bio = {invitro: true, …} (calc/bio.js);
 * settings.bioLayers is read as well, the shape this module was written against first. None by default.
 */
export const activeLayers = (settings) => Object.entries({ ...(settings?.bioLayers || {}), ...(settings?.bio || {}) }).filter(([, on]) => on === true).map(([k]) => k);
/** In vivo for the optimizer: every layer measured in animals (potency, biodistribution, tropism). */
export const isInVivo = (layer) => layer !== 'invitro';

/** Every target the switched-on layers offer; [] when no layer is on, whatever is registered. */
export function biologicalTargets(ctx, settings, list = providers) {
  const on = new Set(activeLayers(settings));
  if (!on.size) return [];
  const out = [];
  for (const p of list) {
    let ts = [];
    try { ts = p(ctx, settings, (layer) => on.has(layer)) || []; } catch { ts = []; }
    for (const t of ts) if (t && on.has(t.layer) && !out.some((x) => x.name === t.name)) out.push(t);
  }
  return out;
}

/**
 * The value the model sees for a biological target: log10(value / reference). Null when either is missing or not
 * positive, since a ratio to a reference that did not express is no measurement.
 */
export function normalisedLog(value, reference) {
  const v = Number(value), r = Number(reference);
  return Number.isFinite(v) && Number.isFinite(r) && v > 0 && r > 0 ? Math.log10(v / r) : null;
}

/**
 * Copy each target's normalised value onto the rows (values[name]) and the study onto r.studyId, for the split.
 * Rows are not changed in place.
 */
export function applyTargets(rows, targets, ctx = null) {
  if (!targets?.length) return rows;
  return rows.map((r) => {
    const values = { ...r.values };
    let studyId = r.studyId ?? null;
    for (const t of targets) {
      const got = t.read ? t.read(r, ctx) : null;
      const v = got ? normalisedLog(got.value, got.reference) : null;
      if (v != null) { values[t.name] = v; studyId = studyId ?? got.studyId ?? null; }
    }
    return { ...r, values, studyId, nResponses: Object.keys(values).length };
  });
}

/**
 * Goals for the targets, in the shape objective.js reads: maximise the log ratio, from 0 (as good as the
 * reference) to +1 (ten times better). An in-vivo one is marked `locked` and kept off.
 */
export function targetGoals(targets) {
  return targets.map((t) => ({ name: t.name, label: t.label, unit: 'log10 vs reference', goal: t.goal || 'maximize', best: t.best ?? 1, worst: t.worst ?? 0, weight: 1,
    on: false, biology: t.layer, ...(isInVivo(t.layer) && !INVIVO_OPTIMISATION ? { locked: 'In-vivo optimisation is not enabled in this version.' } : {}) }));
}

/**
 * Size and PDI as hard limits instead of goals (spec 7.9): a size goal becomes "above its low end" and "below its
 * high end", a PDI goal "below the unacceptable value"; both are then switched off as goals. Returns
 * {goals, constraints}; nothing else changes.
 */
export function physchemAsLimits(goals, constraints = []) {
  const out = [...constraints];
  const next = goals.map((g) => {
    if (g.on === false) return g;
    if (g.name === 'particle_size_nm') {
      const lo = g.goal === 'target' || g.goal === 'range' ? g.lo : null, hi = g.goal === 'target' || g.goal === 'range' ? g.hi : g.worst;
      if (Number.isFinite(Number(lo))) out.push({ name: g.name, op: '>', value: Number(lo), on: true });
      if (Number.isFinite(Number(hi))) out.push({ name: g.name, op: '<', value: Number(hi), on: true });
      return { ...g, on: false };
    }
    if (g.name === 'PDI' && Number.isFinite(Number(g.worst))) {
      out.push({ name: g.name, op: '<', value: Number(g.worst), on: true });
      return { ...g, on: false };
    }
    return g;
  });
  return { goals: next, constraints: out };
}
