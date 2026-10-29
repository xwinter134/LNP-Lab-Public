// DoE designs: generation, coding and the CSV exchange format (columns a Python or R analysis can read back).
//
// The design generation is a port of doe_pipeline/design.py and config.py, so the app produces the same coded
// matrices, point types, run ids and real-unit settings as `run_pipeline.py design`. The run order is randomised
// with the app's own seeded generator (numpy's permutation cannot be reproduced in the browser); to adopt the
// pipeline's order and plate wells, import its run_plan.csv. Analysis stays with the pipeline (statsmodels):
// the app exports config YAML + raw_data.csv and imports the result CSVs. A quick in-app fit is in stats.js.

import { batchDrift } from './stability.js';
import { mixtureDesign, crossedDesign, mixturePool, scheffeTerms, processTerms, crossedTerms, toPseudo } from './mixture.js';

export const DESIGN_TYPES = {
  full_factorial: { name: '2-level full factorial', levels: 2, note: 'all corners; linear or interaction model' },
  full_factorial_3: { name: '3-level full factorial', levels: 3, note: 'all 3^k points; quadratic model possible' },
  ccd_faced: { name: 'Central composite, face-centred', levels: 3, note: 'alpha = 1, axial points on the faces' },
  ccd_rotatable: { name: 'Central composite, rotatable', levels: 5, note: 'alpha = (2^k)^¼, axial points outside the box' },
  ccd_inscribed: { name: 'Central composite, inscribed', levels: 5, note: 'rotatable, scaled so axial points sit on low/high' },
  bbd: { name: 'Box-Behnken', levels: 3, note: 'edge midpoints, no corners; needs 3+ factors' },
  plackett_burman: { name: 'Plackett-Burman screening', levels: 2, note: 'main effects only, next multiple of 4 runs' },
};
export const MODEL_TYPES = { linear: 'Main effects', interaction: 'Main effects + interactions', quadratic: 'Quadratic (needs a 3-level design)' };

/**
 * What kind of experiment this is. The three are genuinely different mathematics, not three settings.
 *
 * A process factor can be set anywhere in its range without touching the others. A lipid mol% cannot: the
 * blend sums to 100, so raising one lipid lowers another, and a design and model that ignore that are
 * answering a different question from the one asked. The crossed mode is the one worth having — it is the
 * only one that can tell you whether the blend you optimised still wins at a different flow rate.
 */
export const DOE_MODES = {
  process: { name: 'Process parameters only', note: 'Independent factors — flow rate ratio, N/P, total flow, temperature. A classical response surface.' },
  mixture: { name: 'Lipid mixture only', note: 'Choose the lipids and their mol% ranges. The design lives on the simplex and the model is a Scheffe polynomial, which is what the sum-to-100 constraint requires.' },
  crossed: { name: 'Mixture and process together', note: 'One experiment over both. It answers whether the best blend stays the best blend when the process changes, which two separate experiments cannot.' },
};

export const MIXTURE_KINDS = {
  auto: { name: 'Choose for me', note: 'A centroid design when only lower bounds bind, the constrained region otherwise.' },
  centroid: { name: 'Simplex centroid', note: 'Each lipid at its highest, every pairwise blend, the overall centre. The usual starting design.' },
  lattice: { name: 'Simplex lattice', note: 'An even grid over the blend space; the degree sets how fine.' },
  vertices: { name: 'Constrained region', note: 'Corners, edges and centre of the region your upper bounds leave. Needed when an upper bound bites.' },
};

export const MIXTURE_ORDERS = {
  linear: 'Linear blending only',
  quadratic: 'Quadratic — pairwise blending (usual choice)',
  special_cubic: 'Special cubic — three-way blending terms',
};

/** 'process' unless the spec says otherwise, so every design saved before this existed still reads correctly. */
export const specMode = (spec) => (DOE_MODES[spec?.mode] ? spec.mode : 'process');
export const isMixtureMode = (spec) => specMode(spec) !== 'process';

/** A mixture spec's components, normalised: identifier name, registry lipid key, mol% bounds. */
export function specComponents(spec) {
  return (spec?.components || []).map((c) => ({
    name: String(c.name || c.key || c.lipidKey || '').trim(),
    lipidKey: c.lipidKey || c.key || c.name || '',
    lo: Number(c.lo) || 0,
    hi: Number.isFinite(Number(c.hi)) ? Number(c.hi) : (Number(spec.total) || 100),
    unit: 'mol%',
  }));
}

/**
 * Every column a design has, in order, whatever mode it is in: mixture components first, then process
 * factors. The table, the three exports and the plots all read this, so none of them can invent its own idea
 * of what a run looks like.
 */
export function designColumns(spec) {
  const mode = specMode(spec);
  const comps = mode === 'process' ? [] : specComponents(spec).map((c) => ({ name: c.name, unit: 'mol%', low: c.lo, high: c.hi, mixture: true, lipidKey: c.lipidKey }));
  const facs = mode === 'mixture' ? [] : (spec.factors || []).map((f) => ({ ...f, mixture: false }));
  return [...comps, ...facs];
}

/** The model this spec fits, as a list of term names. */
export function modelTermsFor(spec) {
  const mode = specMode(spec);
  if (mode === 'process') return modelTerms(spec);
  const mix = scheffeTerms(specComponents(spec).map((c) => c.name), spec.mixtureOrder || 'quadratic');
  if (mode === 'mixture') return mix.map((t) => t.name);
  return crossedTerms(mix, processTerms((spec.factors || []).map((f) => f.name), processOrderOf(spec))).map((t) => t.name);
}

/** How many Scheffe terms q components give, without building them: q, q(q+1)/2, or that plus C(q,3). */
export function scheffeTermCount(q, order = 'quadratic') {
  if (order === 'linear') return q;
  const quad = (q * (q + 1)) / 2;
  return order === 'special_cubic' ? quad + (q * (q - 1) * (q - 2)) / 6 : quad;
}

/** The process side of a crossed model follows the same choice as a process-only design. */
export const processOrderOf = (spec) => (spec.model === 'quadratic' ? 'quadratic' : spec.model === 'interaction' ? 'interaction' : 'linear');

/**
 * A run budget worth suggesting: enough runs to fit the model and five more.
 *
 * The five spare runs are the point. A design with exactly as many runs as terms fits perfectly and tells you
 * nothing about whether the model is right; five residual degrees of freedom, plus whatever the centre
 * replicates add, is enough to see a lack of fit. Left blank, every candidate point becomes a run, which for
 * a constrained blend can be hundreds — fine as a candidate pool, absurd as an experiment.
 */
export const suggestedBudget = (spec) => modelTermsFor(spec).length + 5;

/**
 * Batch parameters a mixture design already sets itself (the keys in experiment.js FACTORS that write a
 * class override). A process factor claiming one of these in a mixture design would be silently overruled by
 * the explicit blend, which is worse than refusing it.
 */
const BLEND_PARAMS = ['peg_pct', 'ionizable_pct'];

/** Response definitions the pipeline understands; `source` is the app measurement field the value comes from. */
export const RESPONSES = [
  { name: 'particle_size_nm', label: 'Particle size (Z-ave, nm)', source: ['dls', 'zave_nm'], unit: 'nm', min_valid: 20, max_valid: 500, goal: 'target', target: 90 },
  { name: 'PDI', label: 'PDI', source: ['dls', 'pdi'], unit: '', min_valid: 0, max_valid: 1, goal: 'minimize' },
  { name: 'encapsulation_efficiency', label: 'Encapsulation efficiency (%)', source: ['ee', 'ee_pct'], unit: '%', min_valid: 0, max_valid: 100, goal: 'maximize' },
  { name: 'zeta_potential_mV', label: 'Zeta potential (mV)', source: ['zeta', 'zeta_mV'], unit: 'mV', min_valid: -60, max_valid: 60, goal: 'none' },
  { name: 'rna_content_mg_mL', label: 'RNA content (mg/mL)', source: ['content', 'rna_mg_mL'], unit: 'mg/mL', min_valid: 0, max_valid: 10, goal: 'none' },
  // Derived rather than measured: the slope of particle size against time, from the DLS timepoints a batch
  // already has. It turns "it held for four weeks" into a number that can be targeted and predicted like any
  // other response. Its unit depends on how far apart the timepoints are, which `app/calc/stability.js`
  // decides; the label here names the default.
  { name: 'size_drift', label: 'Size drift', source: ['dls', 'zave_nm'], derived: 'size_drift', unit: 'nm/day',
    min_valid: -200, max_valid: 200, goal: 'target', target: 0 },
];

/**
 * Every response for one batch, measured or derived, in one place so the DoE screen and the model's training
 * set cannot read them differently.
 * @param {Array} measurements  the whole measurement store
 * @param {string} batchId
 * @param {object} [o] {driftBasis} one of the ids in DRIFT_BASES
 * @returns {{values: object, sources: object}}
 */
export function responsesForBatch(measurements, batchId, o = {}) {
  const values = {}, sources = {};
  for (const r of RESPONSES) {
    if (r.derived === 'size_drift') {
      const d = batchDrift(measurements, batchId, o.driftBasis || 'auto', o.condition ? { condition: o.condition } : {});
      if (d) { values[r.name] = d.value; sources[r.name] = { derived: true, n: d.n, spanDays: d.spanDays, r2: d.r2, unit: d.unit, basis: d.basis, condition: d.condition || '' }; }
      continue;
    }
    const [test, key] = r.source;
    const ms = measurements.filter((m) => m.batchId === batchId && m.test === test && Number.isFinite(Number(m.values?.[key])))
      .sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')));
    const m = ms.find((x) => x.stage === 'final') || ms[0];
    if (m) { values[r.name] = Number(m.values[key]); sources[r.name] = { id: m.id, date: m.date, stage: m.stage }; }
  }
  return { values, sources };
}

/* ---------------- factors ---------------- */
export function factorCenter(f) { return f.center != null && f.center !== '' ? Number(f.center) : (Number(f.low) + Number(f.high)) / 2; }
/** Coded -> real units, anchored on the centre point; each side scaled separately (config.py Factor.to_real). */
export function toReal(f, coded) {
  const c = factorCenter(f), lo = Number(f.low), hi = Number(f.high);
  const step = coded >= 0 ? hi - c : c - lo;
  return c + coded * step;
}
export function toCoded(f, real) {
  const c = factorCenter(f), lo = Number(f.low), hi = Number(f.high);
  const step = real >= c ? hi - c : c - lo;
  return step > 0 ? (real - c) / step : 0;
}
export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/*
 * A categorical factor: one whose two levels are things, not amounts. The mixer is the one the app has (two
 * mixers, e.g. KNAUER IJM 1 against IJM 3). The factor carries `levels` (the two mixer ids, low first) and
 * `levelNames` (what to call them), and is coded −1 for the first and +1 for the second, with low −1 and high
 * +1, so that its "real" value is its code and every numeric part of the app (the model, the exports, the
 * design figure) works on it unchanged. A fitted coefficient is then half the difference between the two
 * mixers, and an interaction FRR × mixer is how much the FRR effect differs between them: the questions a
 * second mixer raises.
 *
 * What does not carry over is "in between". There is no mixer halfway between IJM 1 and IJM 3, so:
 *   - a design with a middle level (3-level factorial, CCD, Box-Behnken) is refused when a factor is
 *     categorical: only the 2-level full factorial and Plackett-Burman are offered (validateSpec);
 *   - centre points are split between the two levels (codedDesign): the other factors at their centre, half
 *     the centre runs on each mixer, so each mixer gets its own replicates and the curvature check still works.
 *     A centre point "on no mixer" cannot be made, and dropping them would leave no pure error;
 *   - the optimum and the plots never place it at a fraction: surfaces are drawn over two numeric factors at
 *     one mixer (a slice), effect plots split by the mixer as two lines, and an optimum is searched at −1
 *     and +1 only (calc/balance.js).
 */
export const isCategorical = (f) => Array.isArray(f?.levels) && f.levels.length >= 2;
/** The level (a mixer id) a coded value stands for: the first for −1, the second for +1. */
export const categoricalLevel = (f, coded) => (isCategorical(f) ? f.levels[Number(coded) > 0 ? 1 : 0] : coded);
/** The name a person reads for a coded value of a categorical factor: "KNAUER IJM 3". */
export const categoricalName = (f, coded) => {
  const i = Number(coded) > 0 ? 1 : 0;
  return String(f?.levelNames?.[i] || f?.levels?.[i] || '');
};
/** The 2-level designs, the only ones a categorical factor can be in (it has no middle setting). */
export const TWO_LEVEL_DESIGNS = ['full_factorial', 'plackett_burman'];

/**
 * A design names its factors as identifiers (IDENT: FRR, flow_rate, PEG_mol_pct), because the CSV that goes to
 * an external analysis and back names them as columns. A person reads the words the rest of the app uses for the same
 * knobs, as the bench record, Insights and the optimizer write them, so the screen and the printed report say
 * those (usability cycle 6, I2); only the CSV exports keep the identifiers. Keyed by each knob's `doeName` in
 * experiment.js FACTORS. A name the user chose is kept, its underscores read as spaces.
 */
export const LAB_WORDS = { FRR: 'FRR', flow_rate: 'total flow', NP_ratio: 'N/P', quench_factor: 'quench factor', PEG_mol_pct: 'PEG mol%',
  ionizable_mol_pct: 'ionizable mol%', lipid_mM: 'lipid stock mM', RNA_mg_mL: 'RNA working mg/mL',
  aqueous_pH: 'aqueous pH', ionic_strength_mM: 'aqueous ionic strength mM', mixer: 'mixer' };
export function factorLabel(f) {
  const name = String((typeof f === 'string' ? f : f?.name) ?? '');
  return LAB_WORDS[name] || name.replace(/_/g, ' ');
}

/**
 * A model term in the same words: "FRR × total flow", "(PEG mol%)²". Only the process factors in `names` are
 * renamed; a lipid in a blend term is already called what it is.
 */
export function termLabel(term, names = []) {
  const known = new Set(names);
  const word = (t) => (known.has(t) ? factorLabel(t) : t);
  return String(term).split(' x ').map((part) => {
    const sq = /^([A-Za-z0-9_]+)\^2$/.exec(part);
    if (sq) { const w = word(sq[1]); return `${/[^A-Za-z0-9]/.test(w) ? `(${w})` : w}²`; }
    return part.split(/([^A-Za-z0-9_]+)/).map(word).join('');
  }).join(' × ');
}

/** Validation mirroring config.py, extended for the mixture modes; returns a list of messages (empty = valid). */
export function validateSpec(spec) {
  const e = [];
  const mode = specMode(spec);
  const f = spec.factors || [];
  const comps = mode === 'process' ? [] : specComponents(spec);
  const total = Number(spec.total) || 100;

  if (!MODEL_TYPES[spec.model]) e.push(`unknown model ${spec.model}`);
  if (!(spec.responses || []).length) e.push('choose at least one response');
  if (spec.plateFormat && ![96, 384].includes(Number(spec.plateFormat))) e.push('plate format must be 96 or 384');

  // Names become column headers and pipeline identifiers, so they must be distinct across both sides.
  const allNames = [...comps.map((c) => c.name), ...f.map((x) => x.name)];
  if (new Set(allNames).size !== allNames.length) e.push('component and factor names must all be different');
  for (const n of allNames) if (!IDENT.test(n || '')) e.push(`name "${n}" must be a plain identifier (letters, digits, underscore) to be a column and a model term`);

  if (mode !== 'mixture') {
    for (const x of f) {
      if (isCategorical(x)) {
        // its low and high are its codes; what can go wrong is the two things it compares (see isCategorical)
        if (x.levels.length !== 2 || x.levels.some((l) => !l) || x.levels[0] === x.levels[1]) e.push(`${factorLabel(x)}: choose two different ${factorLabel(x)}s to compare`);
        if (mode !== 'process') e.push(`${factorLabel(x)}: a ${factorLabel(x)} can be a factor in a process design only; run the blend design once with each ${factorLabel(x)} instead`);
        else if (!TWO_LEVEL_DESIGNS.includes(spec.designType)) e.push(`${factorLabel(x)} has no setting halfway between two ${factorLabel(x)}s, so it needs a 2-level design: the 2-level full factorial or Plackett-Burman (centre points are split between the two)`);
        continue;
      }
      if (!(Number(x.high) > Number(x.low))) e.push(`factor ${x.name}: high must exceed low`);
      if (x.center != null && x.center !== '' && !(Number(x.low) < Number(x.center) && Number(x.center) < Number(x.high))) e.push(`factor ${x.name}: centre must lie strictly between low and high`);
    }
  }

  if (mode === 'process') {
    if (!DESIGN_TYPES[spec.designType]) e.push(`unknown design type ${spec.designType}`);
    if (f.length < 2) e.push('at least two factors are required');
    if (spec.designType === 'bbd' && f.length < 3) e.push('Box-Behnken needs at least three factors');
    if (spec.designType === 'plackett_burman' && f.length > PB_MAX_FACTORS) e.push(`Plackett-Burman is built here for up to ${PB_MAX_FACTORS} factors`);
    if (spec.model === 'quadratic' && ['full_factorial', 'plackett_burman'].includes(spec.designType)) e.push('a 2-level design cannot fit a quadratic model: use interaction/linear or a 3-level design');
  } else {
    if (!MIXTURE_ORDERS[spec.mixtureOrder || 'quadratic']) e.push(`unknown mixture model ${spec.mixtureOrder}`);
    if (spec.mixtureKind && !MIXTURE_KINDS[spec.mixtureKind]) e.push(`unknown mixture design ${spec.mixtureKind}`);
    if (comps.length < 2) e.push('a mixture needs at least two lipids; three or more is the usual case');
    if (!(total > 0)) e.push('the mol% the blend adds up to must be positive');
    for (const c of comps) {
      if (!(c.hi > c.lo)) e.push(`${c.name}: the upper mol% must exceed the lower`);
      if (c.lo < 0) e.push(`${c.name}: a mol% cannot be negative`);
      if (c.hi > total) e.push(`${c.name}: ${c.hi} mol% is more than the ${total} the blend adds up to`);
    }
    const sumLo = comps.reduce((a, c) => a + c.lo, 0), sumHi = comps.reduce((a, c) => a + c.hi, 0);
    if (sumLo > total + 1e-9) e.push(`the lower bounds add to ${+sumLo.toFixed(2)} mol%, more than ${total}: no blend can satisfy them`);
    if (sumHi < total - 1e-9) e.push(`the upper bounds only add to ${+sumHi.toFixed(2)} mol%, less than ${total}: no blend can reach the total`);
    if (spec.mixtureOrder === 'special_cubic' && comps.length < 3) e.push('a special cubic model needs at least three components');
    if (mode === 'crossed' && !f.length) e.push('a crossed design needs at least one process factor');
    for (const x of f) if (BLEND_PARAMS.includes(x.applyTo)) e.push(`factor ${x.name} sets a lipid mol% that this design already chooses: give it a different batch parameter, or drop that lipid from the blend`);
    const budget = spec.budget == null || spec.budget === '' ? null : Number(spec.budget);
    if (budget != null) {
      if (!(budget > 0)) e.push('the run budget must be a positive number of runs');
      else if (!e.length) {
        const nTerms = modelTermsFor(spec).length;
        if (budget < nTerms) e.push(`a budget of ${budget} runs cannot determine the ${nTerms} terms of this model: raise the budget or simplify the model`);
      }
    }
  }
  return e;
}

/* ---------------- coded matrices (design.py) ---------------- */
export function fullFactorial(k, levels = 2) {
  const vals = levels === 2 ? [-1, 1] : [-1, 0, 1];
  const rows = [];
  const rec = (prefix) => { if (prefix.length === k) { rows.push(prefix); return; } for (const v of vals) rec([...prefix, v]); };
  rec([]);
  return rows;
}
export function boxBehnken(k) {
  const rows = [];
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) for (const a of [-1, 1]) for (const b of [-1, 1]) { const r = new Array(k).fill(0); r[i] = a; r[j] = b; rows.push(r); }
  return rows;
}
export const ccdAlpha = (k, kind) => (kind === 'ccd_faced' ? 1 : Math.pow(2 ** k, 0.25));
export function centralComposite(k, alpha) {
  const rows = fullFactorial(k, 2);
  for (let i = 0; i < k; i++) for (const s of [-1, 1]) { const r = new Array(k).fill(0); r[i] = s * alpha; rows.push(r); }
  return rows;
}
function hadamard(size) { // Sylvester construction, as scipy.linalg.hadamard
  let h = [[1]];
  while (h.length < size) h = [...h.map((r) => [...r, ...r]), ...h.map((r) => [...r, ...r.map((x) => -x)])];
  return h;
}
/**
 * Plackett & Burman (1946): the first row of each cyclic design. The next N−2 rows are the same row shifted
 * one place to the right each time, and the last row has every factor low.
 */
const PB_GENERATORS = {
  8: '+++-+--',
  12: '++-+++---+-',
  20: '++--++++-+-+----++-',
  24: '+++++-+-++--++--+-+----',
};
export const PB_MAX_FACTORS = 23;

/**
 * Plackett-Burman screening design: N runs, N the next multiple of 4 above k, every column half high and
 * half low, every pair of columns orthogonal.
 *
 * Taking rows 1…N−1 of a Sylvester Hadamard (dropping its all-high row) is not that design: it loses a run,
 * leaves each column with one more low than high so the main effects are no longer orthogonal to the
 * intercept, and since Sylvester only makes powers of two, 8–11 factors came out at 15 runs instead of 12.
 * So 8, 12, 20 and 24 runs use the published cyclic generators, and 4 and 16 runs, where Sylvester is the
 * right size, use the whole Hadamard matrix without its first column. Mirrored in design.py.
 */
export function plackettBurman(k) {
  if (k > PB_MAX_FACTORS) throw new Error(`Plackett-Burman is built here for up to ${PB_MAX_FACTORS} factors (24 runs); ${k} factors need a larger screening design`);
  const n = k <= 3 ? 4 : [8, 12, 16, 20, 24].find((x) => x > k);
  if (!PB_GENERATORS[n]) return hadamard(n).map((r) => r.slice(1, k + 1));
  const g = [...PB_GENERATORS[n]].map((c) => (c === '+' ? 1 : -1));
  const m = g.length; // n − 1
  const rows = Array.from({ length: m }, (_, i) => Array.from({ length: k }, (_, j) => g[(j - i + m) % m]));
  rows.push(new Array(k).fill(-1));
  return rows;
}

export function codedDesign(spec) {
  const k = spec.factors.length, dt = spec.designType;
  let pts;
  if (dt === 'full_factorial') pts = fullFactorial(k, 2);
  else if (dt === 'full_factorial_3') pts = fullFactorial(k, 3).filter((r) => !r.every((v) => v === 0));
  else if (dt === 'bbd') pts = boxBehnken(k);
  else if (dt.startsWith('ccd')) {
    const alpha = spec.alpha != null && spec.alpha !== '' ? Number(spec.alpha) : ccdAlpha(k, dt);
    pts = centralComposite(k, alpha);
    if (dt === 'ccd_inscribed' && (spec.alpha == null || spec.alpha === '')) pts = pts.map((r) => r.map((v) => v / alpha));
  } else if (dt === 'plackett_burman') pts = plackettBurman(k);
  else throw new Error('unhandled design type ' + dt);
  const rep = Math.max(1, Number(spec.replicates) || 1);
  if (rep > 1) pts = pts.flatMap((r) => Array.from({ length: rep }, () => [...r]));
  // A categorical factor has no centre (see isCategorical): its centre points take its two levels in turn,
  // −1, +1, −1 …; with two categorical factors they walk all four combinations. The other factors sit at 0.
  const cats = spec.factors.map((f, j) => (isCategorical(f) ? j : -1)).filter((j) => j >= 0);
  const centers = Array.from({ length: Math.max(0, Number(spec.centerPoints) || 0) }, (_, i) => {
    const row = new Array(k).fill(0);
    cats.forEach((j, c) => { row[j] = (i >> c) & 1 ? 1 : -1; });
    return row;
  });
  return { pts, centers };
}

function pointType(row, dt) {
  if (row.every((v) => Math.abs(v) < 1e-9)) return 'center';
  const absmax = Math.max(...row.map(Math.abs));
  if (dt.startsWith('ccd') && absmax > 1 + 1e-9) return 'axial';
  if (dt.startsWith('ccd') && row.filter((v) => Math.abs(v) > 1e-9).length === 1) return 'axial';
  if (dt === 'bbd') return 'edge';
  return 'factorial';
}

/**
 * A mixture or crossed design is a search, not a formula, and the wizard rebuilds its preview on every
 * keystroke. Caching on the fields the design actually depends on keeps that preview instant; without it
 * typing in an unrelated box would re-run a D-optimal exchange.
 */
const designCache = new Map();
const CACHE_MAX = 12;
function cached(key, make) {
  if (designCache.has(key)) return designCache.get(key);
  const v = make();
  designCache.set(key, v);
  if (designCache.size > CACHE_MAX) designCache.delete(designCache.keys().next().value);
  return v;
}

/** The mixture design behind a spec, with the note and efficiency the screen reports. Cached. */
export function mixtureDesignFor(spec) {
  const mode = specMode(spec);
  const comps = specComponents(spec);
  const total = Number(spec.total) || 100;
  const order = spec.mixtureOrder || 'quadratic';
  const budget = spec.budget == null || spec.budget === '' ? null : Number(spec.budget);
  const common = {
    total, kind: spec.mixtureKind || 'auto', degree: Math.max(1, Number(spec.degree) || 2),
    budget, replicates: Math.max(0, Number(spec.centerPoints) || 0), seed: Number(spec.seed) || 42,
  };
  const procNames = (spec.factors || []).map((f) => f.name);
  const key = JSON.stringify([mode, comps.map((c) => [c.name, c.lo, c.hi]), common, procNames, order, processOrderOf(spec)]);
  return cached(key, () => (mode === 'mixture'
    ? mixtureDesign(comps.map((c) => ({ key: c.name, lo: c.lo, hi: c.hi })), { ...common, order })
    : crossedDesign(comps.map((c) => ({ key: c.name, lo: c.lo, hi: c.hi })), procNames,
        { ...common, mixtureOrder: order, processOrder: processOrderOf(spec) })));
}

/**
 * Full design table in standard order: [{run_id, std_order, point_type, coded:{name:v}, real:{name:v}}].
 *
 * For a mixture, `real` is mol% and `coded` is the L-pseudo-component — the fraction of the room the lower
 * bounds leave. That is the coded unit the mixture literature works in, and unlike a plain ±1 scaling it
 * still sums to one, so a Scheffe model fitted on the coded values means what it says.
 */
export function buildDesign(spec) {
  const errs = validateSpec(spec);
  if (errs.length) throw new Error(errs[0]);
  const mode = specMode(spec);

  if (mode === 'process') {
    const { pts, centers } = codedDesign(spec);
    const matrix = [...pts, ...centers];
    // A centre point split onto a mixer is still a centre point of the numeric factors: its type is read off them.
    const numeric = spec.factors.map((f, j) => (isCategorical(f) ? -1 : j)).filter((j) => j >= 0);
    const typeOf = (row) => (numeric.length < row.length && numeric.length && numeric.every((j) => Math.abs(row[j]) < 1e-9) ? 'center' : pointType(row, spec.designType));
    return matrix.map((row, i) => ({
      run_id: 'R' + String(i + 1).padStart(3, '0'), std_order: i + 1, point_type: typeOf(row),
      coded: Object.fromEntries(spec.factors.map((f, j) => [f.name, row[j]])),
      real: Object.fromEntries(spec.factors.map((f, j) => [f.name, Math.round(toReal(f, row[j]) * 1e10) / 1e10])),
    }));
  }

  const d = mixtureDesignFor(spec);
  const comps = specComponents(spec);
  const total = Number(spec.total) || 100;
  const lows = comps.map((c) => c.lo);
  const facs = mode === 'crossed' ? (spec.factors || []) : [];
  const r10 = (v) => Math.round(v * 1e10) / 1e10;

  return d.points.map((p, i) => {
    const mol = comps.map((c) => Number(p.x[c.name]) || 0);
    const pseudo = toPseudo(mol, lows, total);
    return {
      run_id: 'R' + String(i + 1).padStart(3, '0'), std_order: i + 1, point_type: p.type,
      coded: {
        ...Object.fromEntries(comps.map((c, j) => [c.name, r10(pseudo[j])])),
        ...Object.fromEntries(facs.map((f) => [f.name, r10(Number(p.x[f.name]) || 0)])),
      },
      real: {
        ...Object.fromEntries(comps.map((c, j) => [c.name, r10(mol[j])])),
        ...Object.fromEntries(facs.map((f) => [f.name, r10(toReal(f, Number(p.x[f.name]) || 0))])),
      },
    };
  });
}

export function modelTerms(spec) {
  const names = spec.factors.map((f) => f.name);
  const terms = [...names];
  if (spec.model !== 'linear') for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) terms.push(`${names[i]} x ${names[j]}`);
  if (spec.model === 'quadratic') for (const n of names) terms.push(`${n}^2`);
  return terms;
}

export function designSummary(spec, rows) {
  const byType = {};
  for (const r of rows) byType[r.point_type] = (byType[r.point_type] || 0) + 1;
  const mode = specMode(spec);
  const terms = modelTermsFor(spec).length;
  const k = (spec.factors || []).length;
  // A Scheffe model has no intercept — the components already sum to a constant, so a constant column would
  // be a linear combination of them. One more residual degree of freedom than the process case, not one less.
  const residualDf = rows.length - terms - (mode === 'process' ? 1 : 0);
  const out = { runs: rows.length, byType, terms, residualDf, mode,
    alpha: mode === 'process' && spec.designType?.startsWith('ccd') ? (spec.alpha != null && spec.alpha !== '' ? Number(spec.alpha) : ccdAlpha(k, spec.designType)) : null };
  if (mode !== 'process') {
    try {
      const d = mixtureDesignFor(spec);
      out.poolSize = d.pool.length; out.selected = d.selected; out.efficiency = d.efficiency;
      out.poolEfficiency = d.poolEfficiency; out.note = d.note; out.kind = d.kind; out.constrained = d.constrained;
      out.distinctBlends = new Set(rows.map((r) => specComponents(spec).map((c) => r.real[c.name]).join('/'))).size;
      // What the blends alone have to carry is the blending model, not the crossed one: the process settings
      // supply the rest of the columns. So the floor on distinct blends is the number of Scheffe terms.
      out.mixTerms = (d.mixTerms || d.terms).length;
    } catch { /* validateSpec already reported why; the summary simply has less to say */ }
  }
  return out;
}

/* ---------------- randomisation and wells (randomize.py; app's own seeded RNG) ---------------- */
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const PLATE = { 96: [8, 12], 384: [16, 24] };
export function wellNames(format, start = 'A1') {
  const [rows, cols] = PLATE[format];
  const labels = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) labels.push(String.fromCharCode(65 + r) + (c + 1));
  const i = labels.indexOf(start);
  if (i < 0) throw new Error(`start well ${start} is not on a ${format}-well plate`);
  return [...labels.slice(i), ...labels.slice(0, i)];
}
export function randomizeRuns(spec, rows) {
  const rnd = mulberry32(Number(spec.seed) || 42);
  const idx = rows.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const out = rows.map((r) => ({ ...r }));
  idx.forEach((rowIndex, order) => { out[rowIndex].run_order = order + 1; });
  if (spec.plateFormat) {
    const wells = wellNames(Number(spec.plateFormat), spec.plateStartWell || 'A1');
    if (out.length > wells.length) throw new Error(`${out.length} runs do not fit on one ${spec.plateFormat}-well plate`);
    for (const r of out) { r.well = wells[r.run_order - 1]; r.plate = 1; }
  }
  return out.sort((a, b) => a.run_order - b.run_order);
}

/* ---------------- exports to take elsewhere ---------------- */
/** design/run-plan CSV with the pipeline's column layout (run_id, std_order, point_type, coded, real, run_order, well, plate). */
export function toDesignCSV(spec, runs) {
  const cols = designColumns(spec);
  const names = cols.map((c) => c.name);
  const head = ['run_id', 'std_order', 'point_type', ...names.map((n) => n + '_coded'), ...names, 'run_order', 'well', 'plate'];
  const lines = [head.join(',')];
  // A categorical factor's setting is the mixer it names, in the column of real settings; its code stays numeric.
  const realOf = (r, c) => (isCategorical(c) ? categoricalName(c, r.coded[c.name]).replace(/,/g, ' ') : r.real[c.name]);
  for (const r of runs) lines.push([r.run_id, r.std_order, r.point_type, ...names.map((n) => r.coded[n]), ...cols.map((c) => realOf(r, c)), r.run_order ?? '', r.well ?? '', r.plate ?? ''].join(','));
  return lines.join('\n') + '\n';
}

/** raw_data.csv rows for `run_pipeline.py analyze --data`: run_id + one column per response. */
export function toRawDataCSV(spec, runs, valueOf) {
  const head = ['run_id', ...spec.responses.map((r) => r.name)];
  const lines = [head.join(',')];
  for (const run of runs) lines.push([run.run_id, ...spec.responses.map((r) => { const v = valueOf(run, r); return v == null ? '' : v; })].join(','));
  return lines.join('\n') + '\n';
}

/** Parse a CSV written by pandas (comma, header row, optional unnamed index column). */
export function parsePandasCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { columns: [], rows: [] };
  const split = (l) => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
  const columns = split(lines[0]).map((c, i) => (c === '' ? (i === 0 ? 'term' : `col${i}`) : c));
  const rows = lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [columns[i], v === '' ? null : /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v) ? Number(v) : v === 'True' ? true : v === 'False' ? false : v])));
  return { columns, rows };
}
