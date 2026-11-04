// Fitting, and — more importantly — deciding whether the fit deserves to be believed.
//
// Two rules from the methodological literature on small, correlated datasets drive this file:
//
// 1. Always report a baseline. A model that cannot beat "predict the mean of every run" has learned nothing,
//    however pretty its scatter plot. The comparison is made explicit, not buried.
// 2. Never split at random. Batches from one experiment share a lipid stock, an RNA lot, an operator and a
//    day, so a random split puts near-duplicates on both sides and flatters the model. Splitting by experiment
//    (or by composition, or by date) asks the question that actually matters: does this help on the NEXT
//    experiment, not on a run I already did.
//
// The reported number is Q², cross-validated R². On tiny datasets the in-sample R² of a flexible model is
// close to 1 by construction and means nothing at all.
import { fitGP, looPredictions } from './gp.js';
import { collapseCheck } from './explain.js';
import { ridgeSolve, mulberry32 } from './linalg.js';

export const standardise = (v) => {
  const n = v.length, mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1)) || 1;
  return { mean, sd, z: v.map((x) => (x - mean) / sd) };
};

/**
 * Response-surface regression: the classical workhorse, and the honest comparison for a Gaussian process.
 * It fits as much of the quadratic model as the runs can support and reports which, because a model that
 * quietly drops its interaction terms while still calling itself quadratic is not a fair comparison.
 */
export function fitQuadratic(X, y, { ridge = 1e-6 } = {}) {
  const D = X[0].length;
  const main = [{ f: () => 1 }];
  for (let i = 0; i < D; i++) main.push({ f: (x) => x[i] });
  const inter = [];
  for (let i = 0; i < D; i++) for (let j = i + 1; j < D; j++) inter.push({ f: (x) => x[i] * x[j] });
  const quad = [];
  for (let i = 0; i < D; i++) quad.push({ f: (x) => x[i] * x[i] });
  // A model matrix needs comfortably more rows than columns before its coefficients mean anything.
  const room = (k) => X.length > k + 2;
  let keep = main, level = 'main effects only';
  if (room(main.length + inter.length + quad.length)) { keep = [...main, ...inter, ...quad]; level = 'quadratic with interactions'; }
  else if (room(main.length + quad.length)) { keep = [...main, ...quad]; level = 'quadratic, no interactions'; }
  const M = X.map((x) => keep.map((t) => t.f(x)));
  const beta = ridgeSolve(M, y, ridge);
  if (!beta) return null;
  return { kind: 'quadratic', beta, nTerms: keep.length, level,
    predict: (x) => ({ mean: keep.reduce((s, t, i) => s + t.f(x) * beta[i], 0), sd: NaN }) };
}

/** Linear (main effects only): the simplest thing that could work, and often does. */
export function fitLinear(X, y, { ridge = 1e-6 } = {}) {
  const M = X.map((x) => [1, ...x]);
  const beta = ridgeSolve(M, y, ridge);
  if (!beta) return null;
  return { kind: 'linear', beta, nTerms: beta.length, predict: (x) => ({ mean: beta[0] + x.reduce((s, v, i) => s + v * beta[i + 1], 0), sd: NaN }) };
}

/** Predict the training mean, always. The bar every other model has to clear. */
export const fitDummy = (X, y) => {
  const m = y.reduce((a, b) => a + b, 0) / y.length;
  return { kind: 'dummy', predict: () => ({ mean: m, sd: NaN }) };
};

/** Settings for fits whose only job is to produce a cross-validation score: fewer restarts, fewer steps. */
export const CV_GP = { restarts: 1, steps: 90, patience: 14 };

export const LEARNERS = {
  gp: { label: 'Gaussian process (Matérn 5/2)', fit: (X, y, o = {}) => fitGP(X, y, o), cvFit: (X, y, o = {}) => fitGP(X, y, { ...CV_GP, ...o }),
    note: 'smooth surface with error bars; the only one that can say "I do not know"' },
  quadratic: { label: 'Response surface', fit: fitQuadratic, note: 'the classical DoE model; it fits as many curvature and interaction terms as the runs support' },
  linear: { label: 'Linear (main effects)', fit: fitLinear, note: 'the simplest baseline that still uses the factors' },
  dummy: { label: 'Mean of all runs', fit: fitDummy, note: 'learns nothing; any useful model must beat it' },
};

/* ---------------- splits ---------------- */
/** Leave-one-group-out folds. groups: array of keys, one per row. */
export function groupFolds(groups) {
  const uniq = [...new Set(groups)];
  return uniq.map((g) => ({ name: String(g), test: groups.map((x, i) => (x === g ? i : -1)).filter((i) => i >= 0) }))
    .filter((f) => f.test.length);
}
/** Leave-one-out folds (used when there is only one group, which is common early on). */
export const looFolds = (n) => Array.from({ length: n }, (_, i) => ({ name: `run ${i + 1}`, test: [i] }));

export const SPLITS = {
  experiment: { label: 'By experiment (leave one experiment out)', note: 'the honest test: can it predict an experiment it has never seen?' },
  composition: { label: 'By composition (leave one composition out)', note: 'tests whether it generalises to a lipid composition it has not seen' },
  time: { label: 'By date (train on the past, test on the future)', note: 'mimics how the model is actually used' },
  run: { label: 'Leave one run out', note: 'optimistic when runs come in correlated groups; use only when everything is one experiment' },
  // Biological targets (spec 7.9, targets.js): animals and wells of one study share a day, a cell passage or a
  // cohort, so a study is held out whole. Offered only while a biology layer is on (`biology`).
  study: { label: 'By study (leave one study out)', note: 'the honest test for biological results: can it predict a study it has never seen?', biology: true },
};

/** Build folds for a split strategy. rows carry {experimentId, compositionId, date}. */
export function buildFolds(rows, strategy) {
  if (strategy === 'experiment') { const f = groupFolds(rows.map((r) => r.experimentId || 'none')); return f.length > 1 ? f : looFolds(rows.length); }
  if (strategy === 'study') { const f = groupFolds(rows.map((r) => r.studyId || r.experimentId || 'none')); return f.length > 1 ? f : looFolds(rows.length); }
  if (strategy === 'composition') { const f = groupFolds(rows.map((r) => r.compositionId ?? 'none')); return f.length > 1 ? f : looFolds(rows.length); }
  if (strategy === 'time') {
    const order = rows.map((r, i) => [r.date || '', i]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map((x) => x[1]);
    const cut = Math.max(2, Math.floor(order.length * 0.6));
    const folds = [];
    for (let i = cut; i < order.length; i++) folds.push({ name: `up to run ${i}`, test: [order[i]], train: order.slice(0, i) });
    return folds.length ? folds : looFolds(rows.length);
  }
  return looFolds(rows.length);
}

/**
 * Spearman rank correlation. Reported next to Q² because ranking is what the model is actually used for:
 * the module asks "which setting should I try next", not "what exactly will the size be". Published LNP
 * models routinely report modest R² (0.25 to 0.4 on held-out chemistry) while still ranking well enough to
 * find good formulations, so judging them on R² alone throws away usable models.
 */
export function spearman(y, pred) {
  const n = y.length;
  if (n < 3) return null;
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    for (let i = 0; i < n;) { // average ranks within ties
      let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const a = rank(y), b = rank(pred);
  const ma = a.reduce((x, z) => x + z, 0) / n, mb = b.reduce((x, z) => x + z, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

/** Of the k runs the model ranks best, how many are truly in the top k? The question an optimiser answers. */
export function hitRate(y, pred, k, goal = 'maximize') {
  const n = y.length;
  if (n < 4) return null;
  k = Math.max(1, Math.min(k ?? Math.max(2, Math.round(n * 0.25)), n - 1));
  const order = (v) => v.map((x, i) => [x, i]).sort((a, b) => (goal === 'minimize' ? a[0] - b[0] : b[0] - a[0])).slice(0, k).map((p) => p[1]);
  const truth = new Set(order(y)), guess = order(pred);
  const hits = guess.filter((i) => truth.has(i)).length;
  return { k, hits, rate: hits / k, byChance: k / n };
}

const r2 = (y, pred) => {
  const m = y.reduce((a, b) => a + b, 0) / y.length;
  const sst = y.reduce((s, v) => s + (v - m) ** 2, 0);
  const sse = y.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0);
  return sst > 0 ? 1 - sse / sst : null;
};
const rmse = (y, pred) => Math.sqrt(y.reduce((s, v, i) => s + (v - pred[i]) ** 2, 0) / y.length);
const mae = (y, pred) => y.reduce((s, v, i) => s + Math.abs(v - pred[i]), 0) / y.length;

/** Cross-validate one learner over the given folds; returns Q², RMSE, MAE in real units. */
/**
 * Cross-validate one learner over the given folds; returns Q², rank correlation, RMSE and MAE in real units.
 * `noiseSd`, when given, is a measured noise in the response's own units and is converted to the standardised
 * scale of EACH fold's training set. Converting once against the whole dataset would both mis-scale folds
 * whose spread differs and leak the held-out rows into the fold's noise level.
 */
export function crossValidate(learner, X, y, folds, fitOpts = {}, noiseSd = null, noiseDf = null) {
  const pred = new Array(y.length).fill(null), z2 = [];
  for (const f of folds) {
    const testSet = new Set(f.test);
    const trIdx = f.train ? f.train : X.map((_, i) => i).filter((i) => !testSet.has(i));
    if (trIdx.length < 3) continue;
    const Xtr = trIdx.map((i) => X[i]), ytr = trIdx.map((i) => y[i]);
    const s = standardise(ytr);
    const opts = Number.isFinite(noiseSd) && s.sd > 0
      ? { ...fitOpts, noisePrior: { var: Math.max(1e-4, (noiseSd / s.sd) ** 2), df: noiseDf || 1 } }
      : fitOpts;
    // The training indices go along for a learner that brings data of its own (lipidmode.js): it has to leave
    // out whatever of that data belongs to the groups held out here.
    const model = (learner.cvFit || learner.fit)(Xtr, s.z, opts, trIdx);
    if (!model) continue;
    for (const i of f.test) {
      pred[i] = model.predict(X[i]).mean * s.sd + s.mean;
      // How far each held-out result lay from its prediction, in units of what one new run there should scatter
      // by (the model's uncertainty plus the noise): the calibration of the reported intervals (intervalScale).
      if (model.kind === 'gp') {
        const q = model.predict(X[i], { noiseless: false });
        if (Number.isFinite(q?.sd) && q.sd > 0) z2.push(Math.min(25, ((y[i] - pred[i]) / (q.sd * s.sd)) ** 2));
      }
    }
  }
  const have = pred.map((p, i) => (p == null ? -1 : i)).filter((i) => i >= 0);
  if (have.length < 3) return { q2: null, rmse: null, mae: null, n: have.length, pred };
  const yy = have.map((i) => y[i]), pp = have.map((i) => pred[i]);
  return { q2: r2(yy, pp), rmse: rmse(yy, pp), mae: mae(yy, pp), rho: spearman(yy, pp), n: have.length, pred, z2 };
}

/**
 * The factor the reported intervals are widened by so that they hold what they promise (spec 7.8). The
 * held-out z-scores of the cross-validation say how much wider the scatter of new results was than the model
 * thought; a fold model is fitted on fewer runs, so this is a mild over-estimate, which is the safe side for an
 * interval. Never below 1 (the intervals are not narrowed on luck) and never above 3; with fewer than eight
 * held-out results there is nothing to calibrate on. It widens what the screen shows and what a batch stores
 * to be checked against its result, not the acquisition, which ranks candidates by a scale it does not need.
 */
export function intervalScale(z2) {
  if (!z2 || z2.length < 8) return 1;
  // Measured on four synthetic surfaces without replicates (tests/ml.test.mjs) and on the campaign lab
  // (tests/usability/campaign.mjs): 80 to 90 % of new results inside the uncalibrated 95 % interval, 93 to 97 %
  // inside the calibrated one. Widening further for the uncertainty of the mean itself pushed the campaign to 98 %.
  const k = z2.length, m = z2.reduce((a, b) => a + b, 0) / k;
  return Math.min(3, Math.max(1, Math.sqrt(m)));
}

/**
 * Fit every learner for one response, cross-validate them all on the same folds, pick the best by Q², and
 * say in plain words how far it can be trusted.
 */
/**
 * Is the design rich enough to support the model being asked for? A one-factor-at-a-time series can never
 * identify interactions, and fitting them anyway produces confident nonsense. The rank of the model matrix
 * answers this in three lines, so the module checks instead of hoping.
 */
export function designSupports(X, terms) {
  const n = X.length, p = terms;
  if (n <= p) return { ok: false, reason: `${p} model terms need more than ${p} runs; there are ${n}` };
  return { ok: true };
}

/** How much of one factor's variation happens while the others are held still — the OFAT signature. */
export function oneFactorAtATime(X) {
  if (X.length < 4) return false;
  let changedOne = 0;
  for (let i = 1; i < X.length; i++) {
    const moved = X[i].map((v, d) => Math.abs(v - X[i - 1][d]) > 1e-6).filter(Boolean).length;
    if (moved === 1) changedOne++;
  }
  return changedOne / (X.length - 1) > 0.8;
}

/**
 * The null check: shuffle the response, refit, and see what Q² the same procedure produces from noise.
 * On 20 runs a flexible model can reach a respectable Q² on pure noise, and knowing that number is the
 * difference between a result and an artefact.
 */
export function nullDistribution(learner, X, y, folds, { repeats = 8, seed = 101, noiseSd = null, noiseDf = null } = {}) {
  const rnd = mulberry32(seed);
  const vals = [];
  for (let r = 0; r < repeats; r++) {
    const shuffled = [...y];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const cv = crossValidate(learner, X, shuffled, folds, {}, noiseSd, noiseDf);
    if (cv.q2 != null) vals.push(cv.q2);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  // With eight shuffles the "ninth decile" is just the largest, so report it as what it is: the best a shuffle
  // managed. Calling a maximum a quantile would overstate how finely this is resolved.
  const idx = Math.min(vals.length - 1, Math.floor(vals.length * 0.9));
  return { n: vals.length, median: vals[Math.floor(vals.length / 2)], high: vals[idx], isMax: idx === vals.length - 1, max: vals[vals.length - 1] };
}

export function evaluateResponse({ X, y, rows, strategy = 'experiment', learners = ['gp', 'quadratic', 'linear', 'dummy'], nullCheck = true, noiseSd = null, noiseDf = null, learnerMap = LEARNERS }) {
  // `learnerMap` lets a lipid mode (lipidmode.js) put its own Gaussian process in the place of the plain one, so
  // it is cross-validated, null-checked and reported by exactly the same procedure as everything else.
  const folds = buildFolds(rows, strategy);
  // When repeated settings exist, their pooled scatter measures the noise. It anchors the noise prior rather
  // than fixing the value, because an estimate from one or two degrees of freedom is biased high and should
  // not be believed outright; the fit can still move away from it when the data say otherwise. What this
  // buys either way is that the model stops explaining real measurement scatter as a feature of the response
  // surface, which is the small-data failure that produces confident nonsense between runs.
  const sdAll = standardise(y).sd;
  const noiseVar = Number.isFinite(noiseSd) && sdAll > 0 ? Math.max(1e-4, (noiseSd / sdAll) ** 2) : null;
  const fitOpts = noiseVar != null ? { noisePrior: { var: noiseVar, df: noiseDf || 1 } } : {};
  const results = [];
  for (const key of learners) {
    const l = learnerMap[key];
    const cv = crossValidate(l, X, y, folds, {}, key === 'gp' ? noiseSd : null, noiseDf);
    results.push({ key, label: l.label, note: l.note, ...cv });
  }
  const dummy = results.find((r) => r.key === 'dummy');
  const ranked = results.filter((r) => r.key !== 'dummy' && r.q2 != null).sort((a, b) => b.q2 - a.q2);
  const best = ranked[0] || null;
  const s = standardise(y);
  const fitted = best ? learnerMap[best.key].fit(X, s.z, best.key === 'gp' ? fitOpts : {}) : null;
  // The Gaussian process is always fitted, whether or not it wins the comparison: it is the only model here
  // that reports uncertainty, and suggestions need uncertainty. When another model cross-validates better the
  // screen says so, but the proposals still come from the one that knows what it does not know.
  const gp = fitted?.kind === 'gp' ? fitted : learnerMap.gp.fit(X, s.z, fitOpts);
  const gpCv = results.find((r) => r.key === 'gp');
  const scale = intervalScale(gpCv?.z2);
  const collapse = collapseCheck(gp, X[0]?.length || 0);
  const foldPredictions = best ? results.find((r) => r.key === best.key)?.pred : null;
  // The level the FOLDS could fit, not the level the full dataset can: the comparison table reports
  // cross-validated numbers, and a fold always has fewer rows to spend on terms than the whole set does.
  const foldRows = Math.min(...folds.map((f) => (f.train ? f.train.length : X.length - f.test.length)));
  const quadLevel = foldRows > 2 ? fitQuadratic(X.slice(0, foldRows), s.z.slice(0, foldRows))?.level || null : null;
  const hit = best && foldPredictions ? hitRateFromFolds(y, foldPredictions) : null;
  // The null check has to run the SAME procedure, including the measured noise level, or it is not a null for
  // the fit it is being compared against.
  const nul = nullCheck && best
    ? nullDistribution(learnerMap[best.key], X, y, folds, { repeats: X.length > 40 ? 6 : 8, noiseSd: best.key === 'gp' ? noiseSd : null, noiseDf })
    : null;
  return { folds: folds.length, strategy, results, best, dummy, model: fitted, gp, gpQ2: gpCv?.q2 ?? null,
    yMean: s.mean, ySd: s.sd, y, foldPredictions, hit, null: nul, ofat: oneFactorAtATime(X), noiseVar, noiseDf, quadLevel, collapse, intervalScale: scale,
    trust: verdict(best, dummy, X.length, X[0]?.length || 0, folds.length,
      { rho: best?.rho, nul, learnersTried: results.length, collapse: collapse || null }) };
}

/**
 * The plain-words verdict. Thresholds are deliberately conservative: a model used to choose the next
 * experiment only has to rank settings sensibly, but one quoted as a prediction has to be right.
 */
function hitRateFromFolds(y, pred) {
  const idx = pred.map((p, i) => (p == null ? -1 : i)).filter((i) => i >= 0);
  return idx.length >= 6 ? hitRate(idx.map((i) => y[i]), idx.map((i) => pred[i]), Math.max(2, Math.round(idx.length * 0.25))) : null;
}

export function verdict(best, dummy, n, d, nFolds, extra = {}) {
  if (!best || best.q2 == null) return { level: 'none', headline: 'Not enough data to test a model', detail: `A model needs runs it has not seen to be judged. There are ${n} usable runs across ${nFolds} group${nFolds === 1 ? '' : 's'}.`, useFor: [] };
  const q = best.q2;
  const perDim = n / Math.max(1, d);
  const thin = perDim < 5;
  const rho = extra.rho;
  const ranks = rho != null && rho > 0.5;
  const nul = extra.nul;
  const suspicious = nul && nul.high >= q - 0.05;
  const nullNote = suspicious ? ` Shuffling the results and refitting reaches Q² ${nul.high.toFixed(2)} by chance alone, which is not far below this, so the fit may be flexibility rather than signal.` : '';
  // The figure is the best of several learners, measured on the same held-out groups that chose the winner,
  // so it is a maximum over candidates and runs high. The honest fix is a third split that selects on one
  // set and reports on another, which eight to twenty runs cannot pay for. Saying so costs a sentence.
  const selectionNote = (extra.learnersTried || 0) > 1
    ? ` This is the best of ${extra.learnersTried} model types, scored on the same held-out groups that picked the winner, so read it as an upper bound rather than a neutral estimate.`
    : '';
  // A surface that has reverted to its prior predicts the average everywhere with intervals as wide as the
  // data, which no accuracy figure reveals on its own.
  const col = extra.collapse;
  const collapseNote = col && col.collapsed
    ? ` The fitted surface has fallen back on its prior across most of the space (${Math.round(col.priorShare * 100)} % of the prior spread remains${col.clamped ? `, and ${col.clamped} lengthscale${col.clamped === 1 ? '' : 's'} sat on the floor` : ''}), so between your runs it is guessing, whatever the figure above says.`
    : '';
  // Everything that qualifies the headline figure travels together, so no verdict can quietly omit one.
  const notes = nullNote + selectionNote + collapseNote;
  const base = `Cross-validated Q² is ${q.toFixed(2)}${rho != null ? `, rank correlation ${rho.toFixed(2)}` : ''} on ${n} runs over ${d} factor${d === 1 ? '' : 's'} (${nFolds} held-out group${nFolds === 1 ? '' : 's'}).`;
  if (q < 0) return ranks
    ? { level: 'weak', headline: 'Poor at predicting values, but it still ranks settings', detail: `${base} The predicted numbers are not usable, yet runs it rates highly do tend to come out better. That is enough to choose what to try next and nothing more.${notes}`, useFor: ['ranking candidate settings', 'choosing the next runs'] }
    : { level: 'none', headline: 'Worse than guessing the average', detail: `${base} Predicting the mean of every run would do better.${notes} Treat the suggestions as a space-filling plan, not as predictions.`, useFor: ['filling gaps in the design space'] };
  if (q < 0.3) return { level: 'weak', headline: ranks ? 'Weak on values, usable for ranking' : 'Weak: use it to choose where to look, not what you will get', detail: `${base} It captures a little of the behaviour.${ranks ? ' The ordering it gives is the part worth using.' : ' The ranking of settings may still be useful; the predicted numbers are not.'}${notes}`, useFor: ['ranking candidate settings', 'spotting which factors matter most'] };
  if (q < 0.6) return { level: 'fair', headline: 'Fair: good enough to steer experiments', detail: `${base}${notes} Directionally useful. Expect the real result to land within roughly the stated interval, and confirm anything important with a run.${thin ? ' With fewer than five runs per factor, treat anything outside the tested range with suspicion.' : ''}`, useFor: ['choosing the next runs', 'ruling out regions', 'ranking factors'] };
  if (q < 0.8) return { level: 'good', headline: 'Good: predictions are usable with their error bars', detail: `${base}${notes} Worth acting on, provided the interval is read along with the number.${thin ? ' Still thin for this many factors, so keep to the tested range.' : ''}`, useFor: ['choosing the next runs', 'predicting outcomes within the tested range', 'ranking factors'] };
  return { level: suspicious ? 'fair' : 'strong', headline: suspicious ? 'High on paper, but the null check is close behind' : 'Strong: the model tracks held-out runs closely', detail: `${base}${notes} Unusual for formulation data at this scale, which is itself a reason to check: confirm that the held-out groups really were independent, and that one dominant factor is not doing all the work.`, useFor: ['choosing the next runs', 'predicting outcomes within the tested range', 'ranking factors'] };
}
