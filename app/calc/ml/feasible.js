// Can the suggested setting actually be run? A surrogate fitted to size and encapsulation knows nothing about
// the rig, and will happily propose a combination the hardware cannot deliver or a lipid concentration nobody
// has a stock for.
//
// What this checks now is the material side: whether a stock near the proposed lipid concentration exists, and
// whether the proposed settings sit outside the span of what has already been run. It does **not** model the
// mixing hardware. An earlier version checked each suggestion against a fluidics model and refused settings
// that crossed out of the mixing regime the training runs were made in; that model is not part of this edition,
// so that guard is gone. Treat a suggestion near the edge of your flow range as something to sanity-check
// against your own rig before you make it.
import { flowsFromTotal } from '../experiment.js';

const num = (...xs) => { for (const x of xs) if (x !== null && x !== '' && Number.isFinite(Number(x))) return Number(x); return undefined; };

/**
 * Check one suggested setting against the stocks on the shelf and the ground already covered.
 * @param {object} point    suggested factor values
 * @param {object} baseline the plan values a batch would otherwise use (frr, tfr, quench)
 * @param {object} env      {settings, stocks, observed:[{frr, tfr}] already run}
 * @returns {{level:'ok'|'info'|'warn', notes:[{level, text}], summary}}
 */
export function checkSetting(point, baseline, env) {
  const notes = [];
  const settings = env?.settings || {};
  const frr = num(point.frr, baseline?.frr, settings.defaultFRR, 3);
  const tfr = num(point.tfr, baseline?.tfr, 112.5);
  const quench = num(point.quench, baseline?.quench, settings.defaultQuenchFactor, 2);

  let summary = null;
  try {
    const flows = flowsFromTotal(tfr, frr, quench);
    summary = { frr, tfr_mL_min: tfr, quench, flows };
    // A zero flow is an unused pump, which is ordinary; a negative one is a setting that cannot exist.
    for (const [name, v] of Object.entries(flows)) {
      if (!(v >= 0)) notes.push({ level: 'warn', text: `Pump ${name} would have to run at ${v} mL/min, which is not a setting any pump can take.` });
    }
  } catch (e) {
    notes.push({ level: 'warn', text: `The flows for this setting could not be worked out: ${e.message}` });
  }

  // Outside the span already run, the surrogate is extrapolating rather than interpolating, and how far outside
  // is the only warning that can be given without a model of the rig.
  const obs = (env?.observed || []).filter((o) => Number.isFinite(o.frr) && Number.isFinite(o.tfr));
  if (obs.length >= 3) {
    for (const [label, value, key] of [['flow rate ratio', frr, 'frr'], ['total flow rate', tfr, 'tfr']]) {
      const seen = obs.map((o) => o[key]);
      const lo = Math.min(...seen), hi = Math.max(...seen), span = hi - lo;
      if (!(span > 0) || !Number.isFinite(value)) continue;
      const over = value > hi ? (value - hi) / span : value < lo ? (lo - value) / span : 0;
      if (over > 0.25) notes.push({ level: 'warn', text: `The ${label} is ${value.toFixed(2)}, well outside the ${lo.toFixed(2)} to ${hi.toFixed(2)} you have actually run. The model has no data there; check the setting is one your rig can hold before you make it.` });
      else if (over > 0) notes.push({ level: 'info', text: `The ${label} is just outside the ${lo.toFixed(2)} to ${hi.toFixed(2)} you have run.` });
    }
  }

  if (Number.isFinite(point.lipid_mM)) {
    const stocks = (env?.stocks || []).filter((x) => Number.isFinite(x.molarity_mM));
    if (stocks.length) {
      const near = stocks.some((x) => Math.abs(x.molarity_mM - point.lipid_mM) / Math.max(1, point.lipid_mM) < 0.1);
      if (!near) notes.push({ level: 'info', text: `No lipid stock on the shelf is near ${point.lipid_mM.toFixed(1)} mM; one would have to be made for this run.` });
    }
  }

  const level = notes.some((n) => n.level === 'warn') ? 'warn' : notes.length ? 'info' : 'ok';
  return { level, notes, summary };
}

/** Run the check over a whole set of suggestions, against the settings already run. */
export function checkSuggestions(picks, { settings, stocks, rows, baseline }) {
  const observed = (rows || []).map((r) => ({
    frr: Number(r.factors?.frr ?? baseline?.frr),
    tfr: Number(r.factors?.tfr ?? baseline?.tfr),
  })).filter((o) => Number.isFinite(o.frr) && Number.isFinite(o.tfr));
  return picks.map((p) => checkSetting(p.point, baseline, { settings, stocks, observed }));
}
