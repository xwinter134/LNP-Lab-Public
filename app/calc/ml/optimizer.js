// One entry point for the screen: data in, a report and a set of suggested runs out.
// Everything here is deterministic given (rows, space, goals, seed), so a suggestion can be reproduced and
// argued with months later — which matters more in a lab notebook than squeezing out the last percent.
import { standardise, evaluateResponse, LEARNERS } from './model.js';
import { toUnit, suggestSpace, snap, fromUnit, mixtureLimits, canWeighOut, fitMixture } from './space.js';
import { mulberry32 } from './linalg.js';
import { suggestRuns, predictedOptimum, predictAll, latinHypercube, confirmAdvice } from './acquire.js';
import { modelsPick, roundVerdict } from './stopping.js';
import { overallDesirability, paretoFront } from './objective.js';
import { permutationImportance, ardImportance, collapseCheck, coverage } from './explain.js';
import { usableRows, noiseFromReplicates, replicateGroups } from './dataset.js';
import { lipidLearner } from './lipidmode.js';
import { BUDGET } from './select.js';

/** How much data before each stage of the module is worth showing. Stated openly rather than hidden in ifs. */
export const READINESS = [
  { stage: 'none', min: 0, label: 'No measured runs yet', can: [] },
  { stage: 'seed', min: 1, label: 'Too few runs to model', can: ['a space-filling starting design'] },
  { stage: 'model', min: 8, label: 'Enough to fit a first model', can: ['a first model with wide error bars', 'suggested next runs'] },
  { stage: 'trust', min: 15, label: 'Enough to test the model honestly', can: ['cross-validated quality', 'factor importance', 'suggested next runs'] },
  { stage: 'rich', min: 25, label: 'Enough for a response surface', can: ['predicted optimum', 'contour maps', 'factor importance', 'suggested next runs'] },
];
export const readinessFor = (n) => READINESS.filter((r) => n >= r.min).pop();

/**
 * The expensive half: fit and cross-validate a model per response. Depends only on the data, the factors and
 * the split strategy — not on the goals, the mode or the number of runs wanted. Kept separate so that
 * adjusting a goal weight or asking for six runs instead of four re-scores in milliseconds instead of
 * refitting every surface.
 */
/**
 * @param {object} a  {rows, space, goals, strategy, seed}; and from the selection (select.js, lipidmode.js):
 *   `noise` replicate scatter per response measured before the data budget merged the replicates, used in place
 *   of what the (merged) rows would give; `lipidModel` {mode: 'kernel'|'descriptor', targetLipid, others: the
 *   other lipids' rows, rank, descOf} to fit the lipid-aware Gaussian process on the chosen lipid's rows plus
 *   the others'. Without either, exactly the fit this function always made.
 */
export function fitModels({ rows, space, goals, strategy = 'experiment', seed = 7, noise: noiseIn = null, lipidModel = null }) {
  const active = goals.filter((g) => g.on !== false);
  const names = active.map((g) => g.name);
  const used = usableRows(rows, space, names);
  const out = { n: used.length, rows: used, space, strategy, seed, responses: [], models: [], warnings: [],
    coverage: coverage(used, space), replicates: replicateGroups(used, space).length, readiness: readinessFor(used.length) };
  if (used.length < 4 || !space.length) {
    out.warnings.push(`${used.length} run${used.length === 1 ? '' : 's'} have every chosen factor and at least one measured response. A model needs at least 8, and 15 before its quality can be tested.`);
    return out;
  }
  const X = used.map((r) => toUnit(r.factors, space));
  const others = lipidModel ? usableRows(lipidModel.others || [], space, names) : [];
  if (lipidModel) out.lipidModel = { mode: lipidModel.mode, targetLipid: lipidModel.targetLipid, others: others.length, rank: lipidModel.rank || 1 };
  // Spec 7.8: the fit is O(n³) per optimiser step and was built for a few hundred runs at most.
  if (used.length + others.length > BUDGET.warnAbove) {
    out.warnings.push(`${used.length + others.length} points reach the model. Above ${BUDGET.warnAbove} each fit takes noticeably longer; a lower data budget in Settings keeps it quick.`);
  }
  for (const g of active) {
    const idx = used.map((r, i) => (Number.isFinite(r.values[g.name]) ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 4) { out.responses.push({ name: g.name, label: g.label, n: idx.length, skipped: 'fewer than four measured runs' }); continue; }
    const Xr = idx.map((i) => X[i]), yr = idx.map((i) => used[i].values[g.name]);
    const noise = noiseIn?.[g.name] || noiseFromReplicates(used, space, g.name);
    let learnerMap;
    if (lipidModel) {
      const ox = others.filter((r) => Number.isFinite(r.values[g.name]));
      if (ox.length) {
        learnerMap = { ...LEARNERS, gp: lipidLearner({ mode: lipidModel.mode, targetLipid: lipidModel.targetLipid, rank: lipidModel.rank, descOf: lipidModel.descOf,
          targetExp: idx.map((i) => used[i].experimentId ?? null),
          extra: { X: ox.map((r) => toUnit(r.factors, space)), y: ox.map((r) => r.values[g.name]), lipid: ox.map((r) => r.lipid), exp: ox.map((r) => r.experimentId ?? null) } }) };
      }
    }
    const ev = evaluateResponse({ X: Xr, y: yr, rows: idx.map((i) => used[i]), strategy, noiseSd: noise?.sd ?? null, noiseDf: noise?.df ?? null, ...(learnerMap ? { learnerMap } : {}) });
    const imp = ev.model ? permutationImportance(ev.model, Xr, standardise(yr).z, space, { seed: seed + 3 }) : [];
    out.responses.push({ name: g.name, label: g.label, unit: g.unit, n: idx.length, ...ev, noise,
      importance: imp, ard: ev.gp ? ardImportance(ev.gp, space) : [], collapse: ev.gp ? collapseCheck(ev.gp, space, { seed: seed + 11 }) : null,
      measured: yr, observed: { lo: Math.min(...yr), hi: Math.max(...yr) } });
    if (ev.gp) out.models.push({ name: g.name, gp: ev.gp, yMean: ev.yMean, ySd: ev.ySd, kind: 'gp', X: Xr, intervalScale: ev.intervalScale ?? 1 });
  }
  return out;
}

/**
 * The cheap half: score the fitted surfaces against the current goals and propose runs.
 * @param {object} fit  what fitModels returned
 * @param {object} o  goals, constraints, q, mode, seed, and baseClasses: class mol% of the recipe a suggested
 *   batch is built on, which fixes the lipid classes the space neither varies nor balances
 */
export function score(fit, { goals, constraints = [], q = 4, mode = 'balanced', seed = 7, baseClasses = undefined }) {
  const active = goals.filter((g) => g.on !== false);
  const names = active.map((g) => g.name);
  const { rows: used, space, models } = fit;
  const out = { ...fit, goals: active, constraints, seed, q, mode, warnings: [...fit.warnings] };
  if (!used.length || !space.length) return out;
  // What the lipids may do: every setting proposed below keeps each class in the band this module treats as
  // ordinary; a run is taken forward as long as its recipe can be weighed out at all.
  out.mixture = mixtureLimits(space, baseClasses);
  const canMake = (p) => canWeighOut(p, out.mixture);

  const observed = used.filter((r) => names.every((n) => Number.isFinite(r.values[n])))
    .map((r) => ({ point: r.factors, values: r.values, batchId: r.batchId, label: r.label }));
  out.observed = observed;
  out.scored = observed.map((o) => ({ ...o, D: overallDesirability(o.values, active).D })).sort((x, y) => y.D - x.D);
  out.pareto = paretoFront(used.map((r) => ({ ...r.values, batchId: r.batchId, label: r.label })), active);
  out.progress = progressSeries(used, active, (r) => !!r.suggestedByMl);

  const haveGP = models.filter((m) => m.gp?.kind === 'gp' && names.includes(m.name));
  const modelledNames = new Set(haveGP.map((m) => m.name));
  if (haveGP.length && haveGP.length < active.length) {
    out.warnings.push(`No surface could be fitted for ${active.filter((g) => !modelledNames.has(g.name)).map((g) => g.label || g.name).join(', ')}; that goal has too few measured runs. Suggestions below ignore it.`);
  }
  if (haveGP.length && used.length >= 8) {
    const sg = active.filter((g) => modelledNames.has(g.name));
    out.suggestionGoals = sg;
    const sc = constraints.filter((c) => modelledNames.has(c.name));
    const obsForGoals = used.filter((r) => sg.every((g) => Number.isFinite(r.values[g.name])))
      .map((r) => ({ point: r.factors, values: r.values, batchId: r.batchId, label: r.label, experimentId: r.experimentId, date: r.date }));
    if (out.mixture && !out.mixture.room) {
      // Nothing to propose, and the reason is the factor choice rather than the data, so say which.
      out.warnings.push(out.mixture.reason);
      return out;
    }
    out.suggestions = suggestRuns({ models: haveGP, space, goals: sg, constraints: sc, observed: obsForGoals, q, mode, seed, mixture: out.mixture });
    if (used.length >= 20) out.optimum = predictedOptimum({ models: haveGP, space, goals: sg, constraints: sc, seed, mixture: out.mixture });
    // The run to take forward and whether another round is worth it (stopping.js). The confirmation offered
    // is then about the model's pick and the optimum rather than the luckiest single result. A run whose
    // repeat could not be weighed out on today's parent recipe is not offered as the one to take forward.
    out.pick = modelsPick({ observed: obsForGoals, models: haveGP, space, goals: sg, constraints: sc, feasible: canMake });
    if (out.pick) out.suggestions.confirm = confirmAdvice(obsForGoals, space, out.suggestions.bestRun, { pick: out.pick, optimum: out.optimum });
    // What one batch at each proposed setting should measure: these surfaces, not the ones the later picks of a
    // batch were chosen on, which pretend the earlier picks already came back at a random draw, and with the
    // measurement noise in. It is what the screen shows and the batch stores to be checked against its result.
    // On the campaign lab the surface's uncertainty about the mean held 57 % of the single results that came
    // back, and a correct model read as wrong nearly half the time; this held 81 % (usability cycle 5), 85 % with
    // the present noise prior, and 97 % once widened by the cross-validated calibration (model.js, intervalScale).
    const forecast = (point) => predictAt(haveGP, space, point, { run: true });
    for (const p of out.suggestions.picks) p.forecast = forecast(p.point);
    for (const r of out.suggestions.confirm?.runs || []) r.forecast = forecast(r.point);
    const picks = out.suggestions.picks;
    if (picks.length) {
      out.verdict = roundVerdict({ pBeats: Math.max(...picks.map((p) => p.pBeatsBest ?? 0)), gain: out.pick?.lastRound?.gain ?? null,
        q: picks.length, confirmBatches: out.suggestions.confirm?.batches || 0 });
    }
  } else if (used.length >= 8) {
    out.warnings.push('No surface model could be fitted at all. Usually every response has fewer than four measured runs that also carry the chosen factors.');
  }
  return out;
}

/**
 * Both halves in one call. Used by the tests and by anything that does not need to cache the fit.
 * @param {object} a {rows, space, goals, constraints, strategy, q, mode, seed}
 */
export function analyse(a) {
  return score(fitModels(a), a);
}

/**
 * A starting design for when there is nothing to learn from yet: a Latin hypercube improved by a few maximin
 * swaps, so the first runs cover the space instead of clustering. These are exactly the runs a first model
 * needs, which is why the module offers them before it can offer anything else.
 */
export function startingDesign(space, n = 8, seed = 5, mixture = null) {
  const rnd = mulberry32(seed);
  let best = null;
  // With lipids in the space, each point is moved to where its recipe can be weighed out before the spread is
  // judged (space.js, fitMixture), so the design that wins is the best spread among recipes that exist.
  const fit = (u) => { const p = fitMixture(fromUnit(u, space), space, mixture); return p ? toUnit(p, space) : u; };
  for (let t = 0; t < 30; t++) {
    const pts = latinHypercube(n, space.length, rnd).map((u) => fit(Array.from(u)));
    let worst = Infinity;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let d = 0; for (let k = 0; k < space.length; k++) d += (pts[i][k] - pts[j][k]) ** 2;
      worst = Math.min(worst, d);
    }
    if (!best || worst > best.worst) best = { worst, pts };
  }
  return best.pts.map((u) => snap(fromUnit(u, space), space));
}

/**
 * Best score achieved over time, marking the runs the optimiser proposed. This is the module's own report
 * card: if the proposed runs keep setting new highs, it is earning the batches it costs; if they do not, the
 * user can see that too. The leading published comparison of this kind is simply "did it beat picking at
 * random with the same budget", and that question deserves to be visible in the app rather than only in a paper.
 */
export function progressSeries(rows, goals, batchIsSuggested) {
  const act = goals.filter((g) => g.on !== false);
  const usable = rows.filter((r) => act.every((g) => Number.isFinite(r.values[g.name])))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  let best = 0;
  const out = [];
  for (const r of usable) {
    const D = overallDesirability(r.values, act).D;
    const improved = D > best;
    best = Math.max(best, D);
    out.push({ batchId: r.batchId, date: r.date, D, best, improved, suggested: !!batchIsSuggested?.(r) });
  }
  const sug = out.filter((p) => p.suggested), own = out.filter((p) => !p.suggested);
  const rate = (xs) => (xs.length ? xs.filter((p) => p.improved).length / xs.length : null);
  return { points: out, suggestedRuns: sug.length, ownRuns: own.length,
    improvedBySuggested: rate(sug), improvedByOwn: rate(own),
    bestSuggested: sug.length ? Math.max(...sug.map((p) => p.D)) : null,
    bestOwn: own.length ? Math.max(...own.map((p) => p.D)) : null };
}

/**
 * Predicted responses at an arbitrary setting, for the "what if" box. `run: true` gives what one batch made
 * there should measure, measurement noise included (acquire.js, predictAll).
 */
export function predictAt(models, space, point, { run = false } = {}) {
  if (!models?.length) return null;
  const u = toUnit(point, space);
  if (!u.every(Number.isFinite)) return null;
  const gps = models.filter((m) => m.gp?.kind === 'gp');
  const out = predictAll(gps, u, { noiseless: !run });
  // A run's forecast is widened by the cross-validated calibration (model.js, intervalScale), so its 95 %
  // interval holds about 95 % of the results that come back.
  if (run) for (const m of gps) if (out[m.name] && m.intervalScale > 1) { out[m.name].sd *= m.intervalScale; out[m.name].calibrated = m.intervalScale; }
  return out;
}
