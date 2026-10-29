// Choosing the next runs: what to put on the bench tomorrow, given what the surrogate believes today.
//
// The score is expected improvement in overall desirability. Expected improvement asks "how much better than
// the best run so far do I expect this setting to be, counting only the upside", which is what balances a
// safe small gain against a risky large one. It is computed by sampling each response from its own posterior
// and pushing the samples through the desirability function, because desirability is non-linear: the mean of
// the desirability is not the desirability of the mean, and the difference matters most exactly where the
// model is unsure, which is where suggestions come from.
//
// Several runs at once are picked greedily with the kriging-believer trick (Ginsbourger et al. 2010): take the
// best point, pretend it came back at the predicted value, re-condition, take the next. The second pick then
// sees no remaining uncertainty at the first, so a batch spreads out instead of proposing the same corner
// four times.
import { normCdf, mulberry32, randn } from './linalg.js';
import { extendGP } from './gp.js';
import { overallDesirability, desirability } from './objective.js';
import { fromUnit, snap, toUnit, fitMixture, mixtureAt } from './space.js';

/** Latin hypercube sample in the unit cube: better spread than independent uniforms at the same count. */
export function latinHypercube(n, d, rnd) {
  const out = Array.from({ length: n }, () => new Float64Array(d));
  for (let j = 0; j < d; j++) {
    const perm = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const k = Math.floor(rnd() * (i + 1)); [perm[i], perm[k]] = [perm[k], perm[i]]; }
    for (let i = 0; i < n; i++) out[i][j] = (perm[i] + rnd()) / n;
  }
  return out;
}

/** Candidate settings to score: a space-filling sweep plus a local cloud around the best runs so far. */
export function candidates(space, { n = 1500, rnd, around = [], jitter = 0.08 } = {}) {
  const d = space.length;
  const pts = latinHypercube(n, d, rnd).map((u) => Array.from(u));
  for (const u0 of around) {
    for (let k = 0; k < 40; k++) {
      pts.push(u0.map((v) => Math.max(0, Math.min(1, v + randn(rnd) * jitter))));
    }
  }
  return pts;
}

/**
 * Only settings whose recipe is an ordinary one. A candidate whose lipids leave the balance class outside its band
 * (space.js, mixtureLimits) is moved into it, or dropped when it cannot be, and so is one that would leave it
 * once snapped to the steps the bench sets. This happens before anything is scored: the surrogate knows
 * nothing about the mixture constraint and rates a recipe with negative helper lipid as readily as any other,
 * and a search that scores first and checks afterwards ends up proposing exactly those.
 */
export function feasibleCandidates(cand, space, mixture) {
  if (!mixture) return cand;
  const out = [];
  for (const u of cand) {
    const p = fitMixture(fromUnit(u, space), space, mixture);
    if (!p || !mixtureAt(snap(p, space), mixture).ok) continue;
    out.push(toUnit(p, space));
  }
  return out;
}

/**
 * Predict every response at a point, in real units.
 * models: [{name, gp, yMean, ySd}] — gp trained on standardised y.
 * By default the SD is the surface's uncertainty about the mean, which is what the search weighs. With
 * `noiseless: false` it is what one batch made there should measure, the fitted measurement noise added, and
 * `noise` says how much of it that is.
 */
export function predictAll(models, u, { noiseless = true } = {}) {
  const out = {};
  for (const m of models) {
    const p = m.gp.predict(u, { noiseless });
    out[m.name] = { mean: p.mean * m.ySd + m.yMean, sd: Math.max(1e-9, p.sd * m.ySd) };
    if (!noiseless && Number.isFinite(m.gp.sn2)) out[m.name].noise = Math.sqrt(m.gp.sn2) * m.ySd;
  }
  return out;
}

/** Probability that every hard constraint holds, under the independent-response posterior. */
export function probFeasible(pred, constraints = []) {
  let p = 1;
  for (const c of constraints) {
    const q = pred[c.name];
    if (!q) return 0;
    const z = (c.value - q.mean) / q.sd;
    p *= c.op === '<' ? normCdf(z) : 1 - normCdf(z);
  }
  return p;
}

/**
 * Expected improvement in desirability at one point, by Monte Carlo over the response posteriors.
 * Returns {ei, dMean, pFeasible, pBeatsBest}.
 */
export function expectedImprovement(pred, goals, constraints, dBest, { samples = 128, rnd, xi = 0.01, sdScale = 1 } = {}) {
  const names = goals.filter((g) => g.on !== false).map((g) => g.name);
  let ei = 0, dSum = 0, beats = 0;
  for (let s = 0; s < samples; s++) {
    const draw = {};
    for (const n of names) { const q = pred[n]; draw[n] = q ? q.mean + randn(rnd) * q.sd * sdScale : NaN; }
    for (const c of constraints) if (!(c.name in draw)) { const q = pred[c.name]; if (q) draw[c.name] = q.mean + randn(rnd) * q.sd * sdScale; }
    const ok = constraints.every((c) => (c.op === '<' ? draw[c.name] < c.value : draw[c.name] > c.value));
    const D = ok ? overallDesirability(draw, goals).D : 0;
    dSum += D;
    const imp = D - dBest - xi;
    if (imp > 0) { ei += imp; beats++; }
  }
  return { ei: ei / samples, dMean: dSum / samples, pBeatsBest: beats / samples, pFeasible: probFeasible(pred, constraints) };
}

/**
 * Chebyshev (max-norm) distance in the unit cube: "the two settings differ by at least this fraction of the
 * range on at least one factor". Used to keep a batch from collapsing onto one recipe.
 */
export const maxNormDistance = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

export const MODES = {
  exploit: { label: 'Mostly exploit', note: 'refine around the best runs; smallest step, least information', xi: 0, sdScale: 0.5 },
  balanced: { label: 'Balanced', note: 'the usual choice: trades a likely small gain against an uncertain large one', xi: 0.01, sdScale: 1 },
  explore: { label: 'Mostly explore', note: 'probe where the model is least sure; worse average result, more learning', xi: 0.02, sdScale: 1.6 },
  split: { label: 'Half and half', note: 'half the runs chase the best predicted result, half go where the model is least sure; the split is visible rather than hidden in a tuning constant', xi: 0.01, sdScale: 1, halves: true },
};

/**
 * Total posterior uncertainty across the modelled responses, each measured against its own spread across the
 * runs. Dividing by the predicted mean instead would look scale-free but is not: a response centred on zero,
 * like zeta potential, makes the ratio diverge wherever the prediction passes through zero, and the explore
 * half of a batch would chase that singularity instead of the places the model is actually least sure.
 */
function totalUncertainty(pred, goals, models) {
  let s = 0;
  for (const g of goals) {
    const q = pred[g.name];
    if (!q) continue;
    const scale = models?.find((m) => m.name === g.name)?.ySd || 1;
    s += (q.sd / (scale || 1)) ** 2;
  }
  return Math.sqrt(s);
}

/**
 * Suggest q settings to run next.
 * @param {object} a  {models, space, goals, constraints, observed:[{point, values}], q, mode, seed, nCandidates, samples,
 *   mixture: what mixtureLimits() says the lipids may do, when the space varies any}
 */
export function suggestRuns(a) {
  const { space, goals, constraints = [], q = 4, mode = 'balanced', seed = 7 } = a;
  const cfg = MODES[mode] || MODES.balanced;
  const rnd = mulberry32(seed);
  const observed = a.observed || [];

  // Best desirability achieved so far: the bar a suggestion has to clear.
  let dBest = 0, bestRun = null;
  for (const o of observed) {
    const ok = constraints.every((c) => (c.op === '<' ? o.values[c.name] < c.value : o.values[c.name] > c.value));
    const D = ok ? overallDesirability(o.values, goals).D : 0;
    if (D > dBest) { dBest = D; bestRun = o; }
  }
  const around = observed
    .map((o) => ({ u: toUnit(o.point, space), D: overallDesirability(o.values, goals).D }))
    .filter((x) => x.u.every(Number.isFinite))
    .sort((x, y) => y.D - x.D).slice(0, 3).map((x) => x.u);

  const cand = feasibleCandidates(candidates(space, { n: a.nCandidates ?? 1200, rnd, around }), space, a.mixture);
  let models = a.models;
  const picks = [];
  const samples = a.samples ?? 128;

  const shortlist = a.shortlist ?? 160;

  // How to pretend a pending run has returned, so the next pick in the batch sees the uncertainty this one
  // would have removed.
  //
  // What the batch really needs is the expected improvement averaged over the posterior of the pending
  // outcomes: Ginsbourger, Le Riche and Carraro (2010) Eq. 6.19, Snoek et al. (2012) Eq. 7, Letham et al.
  // (2019) Eq. 3 all write the same integral. Drawing one outcome from that posterior, which is what
  // happens below, is a one-sample Monte-Carlo estimate of it. It is not the kriging believer, which
  // appends the mean, and it is not the constant liar, which appends a fixed pessimistic value; both are
  // heuristics that avoid the integral rather than estimate it, and Ginsbourger recommends the liar of the
  // two, measuring the believer's improvement as zero at six and at ten points (Table 6.1, p. 154).
  //
  // Their recommendation does not survive contact with this problem. Measured over ten seeds on the closed
  // loop in tests/ml.test.mjs, four rounds of four from eight starting runs, mean best desirability:
  //
  //     one draw from the posterior   0.945      <- the default
  //     constant liar, best observed  0.941
  //     kriging believer (the mean)   0.938
  //     constant liar, mean observed  0.934
  //     constant liar, worst observed 0.924      <- Ginsbourger's own recommendation, worst here
  //
  // Their setting is a deterministic computer experiment with one objective and batches up to ten; this one
  // has three noisy responses, batches of four, and a separation rule that already prevents collapse. The
  // alternatives stay available because the ranking is a property of this benchmark, not a law.
  const liar = a.liar || 'sample';
  const lieFor = (m) => {
    const g = goals.find((x) => x.name === m.name);
    const vals = observed.map((o) => o.values?.[m.name]).filter(Number.isFinite);
    if (!g || !vals.length || !Number.isFinite(m.ySd) || m.ySd <= 0) return null;
    const pick = liar === 'min' ? vals.reduce((w, v) => (desirability(v, g) < desirability(w, g) ? v : w), vals[0])
      : liar === 'max' ? vals.reduce((b, v) => (desirability(v, g) > desirability(b, g) ? v : b), vals[0])
      : liar === 'mean' ? vals.reduce((t, v) => t + v, 0) / vals.length
      : null;
    return pick == null ? null : (pick - m.yMean) / m.ySd; // the GP is fitted on standardised outputs
  };
  for (let k = 0; k < q; k++) {
    // Two stages: an optimistic cheap score over every candidate, then the full Monte Carlo on the shortlist.
    // The cheap score pushes each response to its optimistic edge (mean + 2 sd towards its goal), which cannot
    // rank a genuinely promising setting below a hopeless one, so nothing worth sampling is screened out.
    const screened = [];
    for (const u of cand) {
      const pred = predictAll(models, u);
      const opt = {}, mid = {};
      for (const g of goals) {
        const q2 = pred[g.name];
        if (!q2) continue;
        mid[g.name] = q2.mean;
        opt[g.name] = g.goal === 'maximize' ? q2.mean + 2 * q2.sd : g.goal === 'minimize' ? q2.mean - 2 * q2.sd : q2.mean;
      }
      for (const c of constraints) if (pred[c.name] && !(c.name in opt)) { opt[c.name] = c.op === '<' ? pred[c.name].mean - 2 * pred[c.name].sd : pred[c.name].mean + 2 * pred[c.name].sd; mid[c.name] = pred[c.name].mean; }
      // The screen has to respect hard limits too. Without this the shortlist can consist entirely of settings
      // the limits forbid, every one of them scores zero expected improvement, and the first is picked by
      // accident. Weighting by the probability of feasibility keeps genuinely uncertain settings in play while
      // dropping the ones the model is confident would breach a limit.
      const optimistic = Math.max(overallDesirability(opt, goals).D, overallDesirability(mid, goals).D)
        * (constraints.length ? Math.max(probFeasible(pred, constraints), 1e-4) : 1);
      screened.push({ u, pred, optimistic });
    }
    screened.sort((x, y) => y.optimistic - x.optimistic);
    // One draw per pick is an unbiased but noisy estimate of the integral, so the batch can still collapse
    // when the surface is flat, the step is coarse, or the space is small enough that every candidate is a
    // near neighbour. Averaging over several draws would fix that properly and costs a model refit per
    // draw; this rule is the cheap guarantee in the meantime.
    // A batch is only worth its cost if the runs differ, so candidates too close to an earlier pick are
    // dropped outright. The rule is in the lab's terms: every suggestion differs from every other by at least
    // `minSeparation` of the searched range on at least one factor.
    // Separation is checked on the SNAPPED recipe, not on the unit coordinates. Two candidates can sit the
    // required distance apart in the cube and still round to the same pump settings when the step is coarse
    // relative to the range, and a batch of identical runs is exactly what this rule exists to prevent.
    const sep = a.minSeparation ?? 0.15;
    let usable = screened;
    if (picks.length) {
      const takenPoints = picks.map((p) => p.point);
      const distinct = (c) => {
        const pt = snap(fromUnit(c.u, space), space);
        return takenPoints.every((t) => space.some((f) => pt[f.key] !== t[f.key]));
      };
      const farEnough = (c, s2) => picks.every((p) => maxNormDistance(c.u, p.unit) >= s2);
      const far = screened.filter((c) => distinct(c) && farEnough(c, sep));
      if (far.length >= 5) usable = far;
      else {
        // Too tight for the requested separation. Relax it, but never past "not the same recipe": a duplicate
        // is never the best use of a batch, so if nothing distinct is left the batch simply ends here.
        usable = null;
        for (const relaxed of [sep * 0.66, sep * 0.33, 0]) {
          const f2 = screened.filter((c) => distinct(c) && farEnough(c, relaxed));
          if (f2.length) { usable = f2; break; }
        }
        if (!usable) break;
      }
    }
    const pool = usable.slice(0, Math.min(shortlist, usable.length));
    // In the half-and-half mode the first half of the batch maximises the expected result and the second half
    // maximises uncertainty. Keeping the two visible beats burying the trade-off in an exploration constant:
    // the user can see which runs were placed to win and which were placed to learn.
    const exploring = cfg.halves && k >= Math.ceil(q / 2);
    let best = null, fallback = null;
    for (const s of pool) {
      const sc = expectedImprovement(s.pred, goals, constraints, dBest, { samples, rnd: mulberry32(seed + k * 1009 + 17), xi: cfg.xi, sdScale: cfg.sdScale });
      // dMean is already the expectation of desirability over draws that satisfy the limits: an infeasible
      // draw contributes zero. Multiplying it by the probability of feasibility again counted the limits
      // twice and pushed the optimiser away from settings whose only fault was being near a limit.
      // Uncertainty carries no such weighting of its own, so the exploring score still applies it once.
      const score = exploring ? totalUncertainty(s.pred, goals, models) * sc.pFeasible
        : mode === 'exploit' ? sc.dMean : sc.ei;
      if (score > 0 && (!best || score > best.score)) best = { score, u: s.u, pred: s.pred, sc };
      // When nothing can beat the best run yet, every expected improvement is zero and the choice would be
      // arbitrary. Fall back to the best feasible expected result, which is what a formulator would pick.
      const fb = sc.dMean;
      if (!fallback || fb > fallback.score) fallback = { score: fb, u: s.u, pred: s.pred, sc };
    }
    if (!best) best = fallback;

    if (!best || !Number.isFinite(best.score)) break;
    if (constraints.length && best.sc.pFeasible < 0.02) break; // nothing in the space is likely to satisfy the limits
    const point = snap(fromUnit(best.u, space), space);
    picks.push({ point, unit: best.u, predicted: best.pred, ei: best.sc.ei,
      expectedDesirability: best.sc.dMean, pBeatsBest: best.sc.pBeatsBest, pFeasible: best.sc.pFeasible,
      purpose: exploring ? 'learn' : 'win',
      rationale: exploring ? `placed to learn: the model is least sure here, so the result pins down part of the surface it is currently guessing at`
        : rationale(best, dBest, space, bestRun) });
    // Condition on the lie, so the next pick sees the uncertainty this run would have removed.
    const fantasyRnd = mulberry32(seed + k * 7919 + 101);
    models = models.map((m) => {
      const p = m.gp.predict(best.u);
      const lie = lieFor(m);
      const value = lie != null ? lie
        : liar === 'believer' ? p.mean
        : liar === 'sample' ? p.mean + randn(fantasyRnd) * p.sd
        : p.mean;
      return { ...m, gp: extendGP(m.gp, [best.u], [value]) };
    });
  }
  return { picks, dBest, bestRun, mode: cfg, confirm: confirmAdvice(observed, space, bestRun) };
}

/**
 * Two settings are the same recipe when every factor agrees exactly, to the 1e-4 that dataset.js replicateGroups
 * rounds to, so a run counted as made twice here is also a replicate to the noise estimate. Settings a step apart
 * are neighbours, not repeats: counting them as one recipe called a run measured once "made twice", and let the
 * verdict say the best candidates were confirmed already when nobody had repeated anything.
 */
export function sameSetting(a, b, space) {
  return space.every((s) => {
    const va = a?.[s.key], vb = b?.[s.key];
    return Number.isFinite(va) && Number.isFinite(vb) && Math.round(va * 1e4) === Math.round(vb * 1e4);
  });
}

/**
 * Expected improvement gives no value to repeating a setting that has already been run, so an optimiser left
 * to itself never proposes a confirmation — and the run it is chasing may be a single lucky measurement.
 * The module raises that itself rather than waiting to be asked.
 *
 * Given the model's pick and the predicted optimum (score() passes both), the advice is about those two
 * instead, because they are the settings worth taking forward; the best single measurement is the run most
 * likely to owe its place to luck. Each is brought to two measurements: the pick by one repeat, and the
 * optimum, which has usually never been made, by two runs. After that the two stand on the same footing and
 * the model's pick on everything measured is the setting to take forward. The optimum is left out when the
 * surface rates it no higher than the pick, since then there is nothing to settle.
 */
export function confirmAdvice(observed, space, bestRun, { pick = null, optimum = null } = {}) {
  if (!bestRun || observed.length < 6) return null;
  const times = (p) => observed.filter((o) => sameSetting(o.point, p, space)).length;
  if (!pick) {
    if (times(bestRun.point) > 1) return null;
    return { point: { ...bestRun.point }, batchId: bestRun.batchId, batches: 1,
      runs: [{ point: { ...bestRun.point }, batchId: bestRun.batchId, copies: 1, kind: 'best' }],
      reason: `${bestRun.batchId || 'the best run'} has never been repeated, and every suggestion is measured against it. If that one result was a lucky measurement the whole round is chasing it. One repeat settles the question and costs a single batch.` };
  }
  const runs = [];
  if (times(pick.point) < 2) runs.push({ point: { ...pick.point }, batchId: pick.batchId, copies: 1, kind: 'pick', predicted: pick.predicted });
  if (optimum && optimum.desirability > pick.predictedD && !sameSetting(optimum.point, pick.point, space)) {
    const copies = 2 - times(optimum.point);
    if (copies > 0) runs.push({ point: { ...optimum.point }, batchId: null, copies, kind: 'optimum', predicted: optimum.predicted });
  }
  if (!runs.length) return null;
  const batches = runs.reduce((s, r) => s + r.copies, 0);
  const what = runs.map((r) => (r.kind === 'pick' ? `a repeat of ${r.batchId || 'its run'} (the model's pick)`
    : r.copies === 2 ? 'the predicted optimum made twice' : 'a repeat of the predicted optimum'));
  const lucky = bestRun.batchId && bestRun.batchId !== pick.batchId && times(bestRun.point) === 1
    ? ` ${bestRun.batchId}, the best single result, was made once, and the model rates its setting lower than ${pick.batchId || 'its pick'}'s.` : '';
  return { point: runs[0].point, batchId: runs[0].batchId, runs, batches,
    reason: `Confirm before you take a setting forward, ${batches} batch${batches === 1 ? '' : 'es'}: ${what.join(' and ')}. Then each candidate has two results, and the model's pick on everything measured is the one to keep.${lucky}` };
}

/** A sentence saying why this setting was proposed, in the lab's terms. */
function rationale(best, dBest, space, bestRun) {
  const unsure = Object.entries(best.pred).sort((a, b) => (b[1].sd / Math.abs(b[1].mean || 1)) - (a[1].sd / Math.abs(a[1].mean || 1)))[0];
  const gain = best.sc.dMean - dBest;
  if (best.sc.pFeasible < 0.6) return `the best setting that still has a fair chance (${Math.round(best.sc.pFeasible * 100)} %) of staying inside your hard limits`;
  if (best.sc.pBeatsBest > 0.6) return `likely better than the best run so far (${Math.round(best.sc.pBeatsBest * 100)} % of simulated outcomes beat it)`;
  if (gain > 0) return `a modest expected gain with real upside; ${Math.round(best.sc.pBeatsBest * 100)} % of simulated outcomes beat the best run so far`;
  return `mainly information: ${unsure ? unsure[0].replace(/_/g, ' ') : 'the response'} is still uncertain here, so the run sharpens the model`;
}

/**
 * Where does the model think the optimum is, ignoring uncertainty? The "best guess" setting, which is what a
 * response-surface optimiser would report. Shown next to the suggestions so the difference is visible.
 */
export function predictedOptimum({ models, space, goals, constraints = [], seed = 3, nCandidates = 4000, mixture = null }) {
  const rnd = mulberry32(seed);
  const cand = feasibleCandidates(candidates(space, { n: nCandidates, rnd }), space, mixture);
  let best = null;
  for (const u of cand) {
    const pred = predictAll(models, u);
    const means = Object.fromEntries(Object.entries(pred).map(([k, v]) => [k, v.mean]));
    const ok = constraints.every((c) => (c.op === '<' ? means[c.name] < c.value : means[c.name] > c.value));
    const D = ok ? overallDesirability(means, goals).D : 0;
    if (!best || D > best.D) best = { D, u, pred, means };
  }
  if (!best) return null;
  return { point: snap(fromUnit(best.u, space), space), unit: best.u, predicted: best.pred, desirability: best.D };
}
