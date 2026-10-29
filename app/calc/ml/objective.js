// Turning several lab goals into one number the optimiser can chase, without hiding the trade-off.
//
// Derringer-Suich desirability: each response is mapped to 0 (unacceptable) … 1 (ideal) and the overall score
// is the weighted geometric mean. The geometric mean is the point of the method: one unacceptable response
// drives the whole score to zero, so the optimiser cannot buy a great encapsulation with an unusable PDI.
// Published in 1980 for exactly this job (simultaneous optimisation of several response variables) and still
// the standard in formulation work because the shape of each desirability curve is something a formulator can
// read off a plot and argue with.

/** goal: 'target' | 'range' | 'minimize' | 'maximize'. s/t are the curve exponents: 1 linear, >1 strict near the ideal. */
export function desirability(y, g) { return clamp01(rawDesirability(y, g)); }
const clamp01 = (d) => (Number.isFinite(d) ? Math.min(1, Math.max(0, d)) + 0 : 0); // the + 0 turns -0 into 0
function rawDesirability(y, g) {
  if (!Number.isFinite(y)) return 0;
  const s = g.weightLow ?? g.exponent ?? 1, t = g.weightHigh ?? g.exponent ?? 1;
  if (g.goal === 'minimize') {
    const L = g.best ?? g.lo, U = g.worst ?? g.hi;
    if (!(U > L)) return y <= L ? 1 : 0;
    if (y <= L) return 1;
    if (y >= U) return 0;
    return Math.pow((U - y) / (U - L), s);
  }
  if (g.goal === 'maximize') {
    const L = g.worst ?? g.lo, U = g.best ?? g.hi;
    if (!(U > L)) return y >= U ? 1 : 0;
    if (y <= L) return 0;
    if (y >= U) return 1;
    return Math.pow((y - L) / (U - L), s);
  }
  if (g.goal === 'range') {
    // An acceptance band, which is the shape a release specification actually has: everything inside is
    // equally acceptable and there is no reward for sitting in the middle. Maharjan et al. 2024 specify
    // particle size exactly this way, and a target curve cannot express it: it would prefer 80 nm over
    // 60 nm when the study treats both as passing. Outside the band the score falls away over a slack
    // width rather than off a cliff, so a near miss still beats a wild one.
    const L = Number(g.lo), U = Number(g.hi);
    if (!(U > L)) return 0;
    if (y >= L && y <= U) return 1;
    const slack = Number.isFinite(Number(g.slack)) && Number(g.slack) > 0 ? Number(g.slack) : (U - L) * 0.25;
    const off = y < L ? L - y : y - U;
    if (off >= slack) return 0;
    return Math.pow(1 - off / slack, y < L ? s : t);
  }
  // two-sided target
  const T = g.target, L = g.lo, U = g.hi;
  if (!(L < T && T < U)) return Math.abs(y - T) < 1e-9 ? 1 : 0;
  if (y < L || y > U) return 0;
  return y <= T ? Math.pow((y - L) / (T - L), s) : Math.pow((y - U) / (T - U), t);
}

/** Weighted geometric mean of the individual desirabilities. values: {responseName: y}. */
export function overallDesirability(values, goals) {
  const act = goals.filter((g) => g.on !== false && (g.weight ?? 1) > 0);
  if (!act.length) return { D: 0, parts: [] };
  let logSum = 0, wSum = 0, anyZero = false;
  const parts = [];
  for (const g of act) {
    const d = desirability(values[g.name], g);
    const w = g.weight ?? 1;
    parts.push({ name: g.name, value: Number.isFinite(values[g.name]) ? values[g.name] : null, d, weight: w, measured: Number.isFinite(values[g.name]) });
    if (d <= 0) anyZero = true;
    logSum += w * Math.log(Math.max(d, 1e-12));
    wSum += w;
  }
  return { D: anyZero ? 0 : Math.exp(logSum / wSum), parts };
}

/** Does a point satisfy every hard constraint? constraints: [{name, op:'<'|'>', value}] */
export function feasible(values, constraints = []) {
  return constraints.every((c) => {
    const v = values[c.name];
    if (!Number.isFinite(v)) return false;
    return c.op === '<' ? v < c.value : v > c.value;
  });
}

/**
 * Starting goals for LNP work; the user edits these.
 *
 * The limits follow Maharjan et al. 2024 (J Pharm Anal 14:100996), which optimises the same quality
 * attributes from a designed study, rather than the round numbers that were here before: particle size
 * acceptable from 40 nm, not 50; encapsulation acceptable from 75 per cent, not 70; dispersity below 0.3,
 * which already agreed. The size target of 80 nm is this app's own choice and not theirs, because most
 * people arrive wanting a size rather than a band; switch the goal to "in range" to get the study's shape.
 * Zeta potential is a band around neutral: the study requires a small non-zero magnitude, 1 to 4 mV, which
 * no single band can express, so the band here accepts neutral and the lower bound is not imposed.
 */
export const DEFAULT_GOALS = [
  { name: 'particle_size_nm', label: 'Particle size', unit: 'nm', goal: 'target', target: 80, lo: 40, hi: 120, weight: 1, exponent: 1, on: true },
  { name: 'PDI', label: 'PDI', unit: '', goal: 'minimize', best: 0.05, worst: 0.3, weight: 1, exponent: 1, on: true },
  { name: 'encapsulation_efficiency', label: 'Encapsulation efficiency', unit: '%', goal: 'maximize', worst: 75, best: 96.5, weight: 1, exponent: 1, on: true },
  { name: 'zeta_potential_mV', label: 'Zeta potential', unit: 'mV', goal: 'range', lo: -4, hi: 4, weight: 0.5, exponent: 1, on: false },
  { name: 'rna_content_mg_mL', label: 'RNA content', unit: 'mg/mL', goal: 'maximize', worst: 0.05, best: 0.12, weight: 0.5, exponent: 1, on: false },
  // Derived from the DLS timepoints rather than measured once, so it is off until a batch has been followed
  // over time. A band rather than a target: a formulation that shrinks is no better than one that holds, and
  // the limits are in whatever unit the drift basis gives, which the settings screen decides.
  { name: 'size_drift', label: 'Size drift', unit: 'nm per period', goal: 'range', lo: -1, hi: 1, weight: 0.75, exponent: 1, on: false },
];

/** A curve for plotting a desirability function across its range. */
export function desirabilityCurve(g, n = 60) {
  const slack = g.goal === 'range'
    ? (Number.isFinite(Number(g.slack)) && Number(g.slack) > 0 ? Number(g.slack) : (Number(g.hi) - Number(g.lo)) * 0.25)
    : 0;
  const lo = Number(g.goal === 'minimize' ? (g.best ?? g.lo) : g.goal === 'maximize' ? (g.worst ?? g.lo) : g.lo) - slack;
  const hi = Number(g.goal === 'minimize' ? (g.worst ?? g.hi) : g.goal === 'maximize' ? (g.best ?? g.hi) : g.hi) + slack;
  // A cleared limit leaves nothing to plot. Returning an empty curve lets the caller draw nothing, rather
  // than a line through a range of NaN that looks like a shape.
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [];
  const pad = (hi - lo) * 0.12;
  const pts = [];
  for (let i = 0; i <= n; i++) { const y = lo - pad + ((hi - lo + 2 * pad) * i) / n; pts.push({ y, d: desirability(y, g) }); }
  return pts;
}

/** Pareto front of observed points: those not beaten on every active objective at once. */
export function paretoFront(rows, goals) {
  const act = goals.filter((g) => g.on !== false);
  // Every goal is compared on one key: lower is better for minimise, higher for maximise, and for a target it
  // is the distance from that target. Ties have to be judged on the same key — comparing raw values there
  // leaves two runs equidistant from a target neither better nor equal, so neither can dominate the other and
  // both sit on the front however badly one loses on every other goal.
  const key = (r, g) => {
    const v = r[g.name];
    if (!Number.isFinite(v)) return NaN;
    if (g.goal === 'minimize') return v;
    if (g.goal === 'maximize') return -v;
    if (g.goal === 'range') { const L = Number(g.lo), U = Number(g.hi); return v < L ? L - v : v > U ? v - U : 0; }
    return Math.abs(v - Number(g.target));
  };
  const better = (a, b, g) => key(a, g) < key(b, g) - 1e-12;
  const eq = (a, b, g) => Math.abs(key(a, g) - key(b, g)) <= 1e-12;
  const dominates = (a, b) => act.every((g) => better(a, b, g) || eq(a, b, g)) && act.some((g) => better(a, b, g));
  const usable = rows.filter((r) => act.every((g) => Number.isFinite(r[g.name])));
  return usable.filter((r) => !usable.some((o) => o !== r && dominates(o, r)));
}
