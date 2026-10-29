// The simulated lab behind the usability sessions: a hidden ground truth that turns what a formulation record
// says was made into what the instruments would read. The sessions type these numbers into the app by hand
// (or drop them in as an instrument export), and because the truth is known, the app's fitted models,
// predicted optima and optimizer suggestions can be scored against where the optimum really is.
//
// Nothing in the app reads this file. It plays the bench and the Zetasizer, nothing else.

/** Seeded PRNG (Park-Miller) and a Gaussian from it, so a session is reproducible run to run. */
export function rng(seed = 1) {
  let s = seed % 2147483647; if (s <= 0) s += 2147483646;
  const u = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const g = () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
  return { u, g };
}

const sq = (x) => x * x;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * Noise-free response of a formulation. Inputs are what the batch record says: flow rate ratio, total flow
 * (mL/min), N/P, PEG-lipid mol%, plus an optional stock-lot offset (a lot effect the control chart should
 * find). Shapes follow the usual microfluidic picture: higher FRR, faster flow and more PEG give smaller
 * particles; EE collapses below N/P ~5 and suffers at extreme FRR; PDI has a sweet spot in FRR and flow.
 */
export function truth({ frr = 3, tfr = 112.5, np = 6, peg = 1.5, lotShift_nm = 0 }) {
  const size = 80 + 11 * (3.7 - frr) + 3 * sq(frr - 3.7) - 0.12 * (tfr - 80) + 0.001 * sq(tfr - 80) - 16 * (peg - 1.8) + 0.6 * (np - 6) + lotShift_nm;
  const pdi = 0.065 + 0.03 * sq(frr - 3.7) + 0.00003 * sq(tfr - 80) + 0.06 * Math.max(0, 1.6 - peg) + 0.0015 * sq(np - 6);
  const ee = 95 - 3 * sq(frr - 3.5) - 3.5 * sq(Math.max(0, 5.5 - np)) - 5 * Math.max(0, peg - 2.1) - 0.0005 * sq(tfr - 80);
  const zeta = -3 + 0.6 * (np - 6) - 1.5 * (peg - 1.5);
  return { zave_nm: size, pdi: Math.max(0.02, pdi), ee_pct: clamp(ee, 5, 99), zeta_mV: zeta };
}

/** Storage drift: size and PDI creep up with time, much faster warm than cold. */
export function drift(base, condition, days) {
  const k = { '4C': 0.0008, '25C': 0.004, '37C': 0.009, '-20C': 0.0003, RT: 0.004 }[condition] ?? 0.002;
  return { ...base, zave_nm: base.zave_nm * (1 + k * days), pdi: base.pdi + 0.25 * k * days, ee_pct: base.ee_pct - 20 * k * days };
}

/** One instrument reading of a formulation, with run-to-run and batch-to-batch noise. */
export function measure(params, r, { condition = null, days = 0, runs = 3 } = {}) {
  let t = truth(params);
  if (condition) t = drift(t, condition, days);
  // batch-to-batch scatter, then the instrument's own repeatability on top for each run
  const batch = { zave_nm: t.zave_nm + r.g() * 2.5, pdi: t.pdi + r.g() * 0.008, ee_pct: t.ee_pct + r.g() * 1.2, zeta_mV: t.zeta_mV + r.g() * 0.8 };
  const reps = Array.from({ length: runs }, () => ({ zave_nm: batch.zave_nm + r.g() * 0.9, pdi: Math.max(0.01, batch.pdi + r.g() * 0.006), countRate_kcps: 280 + r.g() * 25 }));
  return { ...batch, pdi: Math.max(0.015, batch.pdi), ee_pct: clamp(batch.ee_pct, 1, 99.5), runs: reps };
}

/**
 * The score a formulation scientist would use here: about 80 nm, PDI as low as possible, EE as high as
 * possible. Desirability in 0..1 (geometric mean of three), so "best" has one meaning across the sessions.
 */
export function desirability({ zave_nm, pdi, ee_pct }) {
  const dSize = clamp(1 - Math.abs(zave_nm - 80) / 25, 0, 1);
  const dPdi = clamp((0.25 - pdi) / (0.25 - 0.05), 0, 1);
  const dEe = clamp((ee_pct - 70) / (98 - 70), 0, 1);
  return Math.cbrt(dSize * dPdi * dEe);
}

/** Where the optimum really is, inside the ranges the app offers (FRR 2-4, flow 60-120, PEG 1-2.5, N/P 3-9). */
export function trueOptimum() {
  let best = null;
  for (let frr = 2; frr <= 4.0001; frr += 0.05) for (let tfr = 60; tfr <= 120.001; tfr += 1)
    for (let peg = 1; peg <= 2.5001; peg += 0.05) for (const np of [6]) {
      const t = truth({ frr, tfr, np, peg });
      const d = desirability(t);
      if (!best || d > best.d) best = { frr, tfr, peg, np, d, ...t };
    }
  return best;
}

/** A Zetasizer-style CSV export (one row per run), as the instrument software writes it. */
export function zetasizerCsv(samples, date = '27/10/2026 14:02:11') {
  const head = 'Sample Name,Z-Average (d.nm),PdI,Derived Count Rate (kcps),Measurement Date and Time';
  const lines = [head];
  for (const s of samples) s.runs.forEach((x, i) => lines.push(`${s.name} ${i + 1},${x.zave_nm.toFixed(2)},${x.pdi.toFixed(3)},${x.countRate_kcps.toFixed(0)},${date}`));
  return lines.join('\r\n') + '\r\n';
}
