// Does following the optimizer find the optimum? A closed-loop campaign against the simulated lab, run with the
// app's own modelling code (app/calc/ml), the way a person would use the Optimizer screen: an 8-run starting
// design, then rounds of suggested runs, each made and measured (with batch and instrument noise) before the
// next round is asked for. Repeated over several seeds, and compared on the same budget with two ways of
// working that need no optimizer: runs picked at random (a Latin hypercube), and a classic face-centred CCD
// with a quadratic fit, whose predicted optimum is then made.
//
//   node tests/usability/campaign.mjs [--seeds 10] [--rounds 6] [--q 4] [--mode balanced] [--lab standard|hard]
//                                     [--out docs/usability/campaign.json]
//   npm run campaign                    5 seeds, 4 rounds: about a minute; flags after "--" override it, so
//                                       npm run campaign -- --seeds 30 --rounds 6 is the run the verdict was set on
//
// --lab standard is the session's lab (tests/usability/lab.mjs): smooth and nearly quadratic, which suits a CCD
// with a quadratic fit exactly. --lab hard is less kind and closer to what LNPs do: encapsulation falls off a
// cliff below N/P ~5, size saturates with PEG and goes as a power of FRR, and above ~115 mL/min the mixing turns
// unstable and PDI jumps. Same noise.
//
// Scored by the truth the app never sees: the desirability of a setting's noise-free responses under the app's
// default goals (size 80 nm in 40–120, PDI as low as possible, EE as high as possible). What counts is the run a
// person would pick as best from what they measured, not the best run made: a lucky measurement that is not
// really better is exactly the mistake the noise invites.
//
// It also scores the screen's verdict on whether another round is worth its batches (app/calc/ml/stopping.js):
// what a campaign that stops the first time the screen says stop, and makes the confirmation runs offered
// instead, saves in runs and gives up in true score against the same campaign run to the end. The table it
// prints last is the calibration the verdict's thresholds rest on, so a change to the optimizer can be checked
// against them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { truth as standardTruth, rng } from './lab.mjs';
import { fitModels, score, startingDesign } from '../../app/calc/ml/optimizer.js';
import { latinHypercube, predictAll } from '../../app/calc/ml/acquire.js';
import { fromUnit, snap, toUnit } from '../../app/calc/ml/space.js';
import { overallDesirability, DEFAULT_GOALS } from '../../app/calc/ml/objective.js';
import { fitQuadratic } from '../../app/calc/ml/model.js';
import { mulberry32 } from '../../app/calc/ml/linalg.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The last occurrence wins, so flags given after the npm script's own defaults override them.
const arg = (k, d) => { const i = process.argv.lastIndexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SEEDS = Number(arg('seeds', '10'));
const ROUNDS = Number(arg('rounds', '6'));
const Q = Number(arg('q', '4'));
const MODE = arg('mode', 'balanced');
const LAB = arg('lab', 'standard');
const outFile = arg('out', null) ? path.resolve(root, arg('out')) : null;

// The ranges a formulator would open up for a first campaign on this rig.
const SPACE = [
  { key: 'frr', name: 'Flow rate ratio', unit: '', lo: 2, hi: 5, step: 0.1 },
  { key: 'tfr', name: 'Total flow rate', unit: 'mL/min', lo: 40, hi: 140, step: 1 },
  { key: 'np', name: 'N/P ratio', unit: '', lo: 3, hi: 10, step: 0.5 },
  { key: 'peg_pct', name: 'PEG-lipid', unit: 'mol%', lo: 0.5, hi: 3, step: 0.1 },
];
const GOALS = DEFAULT_GOALS.filter((g) => g.on !== false);
const params = (p) => ({ frr: p.frr, tfr: p.tfr, np: p.np, peg: p.peg_pct });
const asValues = (t) => ({ particle_size_nm: t.zave_nm, PDI: t.pdi, encapsulation_efficiency: t.ee_pct });
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** The hard lab: cliffs, saturation and a flow instability that no quadratic follows. */
function hardTruth({ frr, tfr, np, peg }) {
  const size = 20 + (160 / frr ** 0.8) * (0.75 + 0.6 * Math.exp(-1.4 * (peg - 0.5))) * (100 / (tfr + 20)) ** 0.35 + 3 * Math.tanh(np - 6);
  const pdi = 0.055 + 0.12 * sigmoid((tfr - 115) / 5) + 0.07 * (frr - 3.4) ** 2 + 0.07 * Math.exp(-3 * (peg - 0.5)) + 0.0004 * (np - 7.5) ** 4;
  const ee = 96 * sigmoid((np - 4.8) * 2.5) - 6 * Math.max(0, frr - 4) ** 1.5 - 4 * Math.max(0, peg - 2) ** 2 - 6 * Math.max(0, 2.9 - frr) ** 2;
  return { zave_nm: size, pdi: Math.max(0.02, pdi), ee_pct: Math.max(5, Math.min(99, ee)) };
}
const truth = LAB === 'hard' ? hardTruth : standardTruth;
/** The truth's score for a setting: what the app's goals make of its noise-free responses. */
const trueD = (p) => overallDesirability(asValues(truth(params(p))), GOALS).D;

/** One batch, measured: the session lab's noise (batch-to-batch scatter, then three DLS runs averaged). */
function measure(prm, r) {
  const t = truth(prm);
  const batch = { zave_nm: t.zave_nm + r.g() * 2.5, pdi: t.pdi + r.g() * 0.008, ee_pct: t.ee_pct + r.g() * 1.2 };
  const runs = Array.from({ length: 3 }, () => ({ zave_nm: batch.zave_nm + r.g() * 0.9 }));
  return { ...batch, pdi: Math.max(0.015, batch.pdi), ee_pct: Math.max(1, Math.min(99.5, batch.ee_pct)), runs };
}

/** The best setting there is inside the space, by a fine grid. */
function trueOptimum() {
  let best = null;
  for (let frr = 2; frr <= 5.0001; frr += 0.05) for (let tfr = 40; tfr <= 140.001; tfr += 2)
    for (let np = 3; np <= 10.001; np += 0.5) for (let peg = 0.5; peg <= 3.0001; peg += 0.05) {
      const p = { frr, tfr, np, peg_pct: peg };
      const d = trueD(p);
      if (!best || d > best.D) best = { point: p, D: d };
    }
  return best;
}

/** Make and measure a setting: one batch, three DLS runs averaged, as the session does. */
function makeAndMeasure(point, r) {
  const m = measure(params(point), r);
  const size = m.runs.reduce((s, x) => s + x.zave_nm, 0) / m.runs.length;
  return { particle_size_nm: size, PDI: m.pdi, encapsulation_efficiency: m.ee_pct };
}

/** The run a person would call the best: highest desirability of what was measured. Its true score. */
function pickedBest(rows) {
  let best = null;
  for (const row of rows) {
    const d = overallDesirability(row.values, GOALS).D;
    if (!best || d > best.measuredD) best = { measuredD: d, point: row.factors, batchId: row.batchId };
  }
  return { ...best, trueD: trueD(best.point) };
}

/**
 * The run the model would call the best: highest desirability of the surface's prediction at each setting made,
 * which averages a lucky measurement with its neighbours. Its true score.
 */
function smoothedBest(rows, models) {
  if (!models?.length) return null;
  let best = null;
  for (const r of rows) {
    const pred = predictAll(models, toUnit(r.factors, SPACE));
    const d = overallDesirability(Object.fromEntries(Object.entries(pred).map(([k, v]) => [k, v.mean])), GOALS).D;
    if (!best || d > best.predictedD) best = { predictedD: d, point: r.factors, batchId: r.batchId };
  }
  return { ...best, trueD: trueD(best.point) };
}

const row = (point, values, round, i, suggested) => ({
  batchId: `R${round}-${i + 1}`, experimentId: `R${round}`, factors: point, values,
  date: `2026-${String(1 + Math.floor(round / 2)).padStart(2, '0')}-${String(1 + (round % 2) * 14 + i).padStart(2, '0')}`,
  suggestedByMl: suggested,
});

/**
 * Taking the verdict's advice: stop before this round, make the confirmation runs the screen offers instead
 * (a repeat of the model's pick, the predicted optimum twice), and take forward the model's pick on everything
 * measured. Its own noise stream, so the campaign that carries on regardless gets exactly the batches it
 * would have had without this branch, and the two can be compared run for run.
 */
function stopHere(rows, res, round, seed) {
  const r = rng(7000 + seed);
  const extra = [];
  for (const c of res.suggestions?.confirm?.runs || []) {
    for (let k = 0; k < c.copies; k++) extra.push({ ...row(c.point, makeAndMeasure(c.point, r), round, extra.length, true), batchId: `C${round}-${extra.length + 1}`, experimentId: `C${round}` });
  }
  let confirmed = res.pick, verdictAfter = null;
  if (extra.length) {
    const all = [...rows, ...extra];
    const f = fitModels({ rows: all, space: SPACE, goals: GOALS, strategy: 'experiment', seed: 7 + round });
    // A full round's suggestions, so what the screen says next is read too: a campaign that took the advice
    // should still be told to stop once it has confirmed. The first repeat used to set the noise from one degree
    // of freedom and turn about one stop in five into "another round" (gp.js, fitGP).
    const after = score(f, { goals: GOALS, q: Q, mode: MODE, seed: 7 + round });
    confirmed = after.pick || confirmed;
    verdictAfter = after.verdict?.level ?? null;
  }
  return { round, runs: rows.length, pickTrueD: trueD(res.pick.point), confirmRuns: extra.length, confirmedTrueD: trueD(confirmed.point),
    measuredBestTrueD: pickedBest(rows).trueD, verdictAfter };
}

/** One campaign: starting design, then ROUNDS rounds of Q suggestions. */
function optimizerCampaign(seed) {
  const r = rng(1000 + seed);
  const rows = startingDesign(SPACE, 8, 5 + seed).map((p, i) => row(p, makeAndMeasure(p, r), 0, i, false));
  const trace = [{ round: 0, runs: rows.length, picked: pickedBest(rows), optimumTrueD: null }];
  let stop = null;
  for (let round = 1; round <= ROUNDS; round++) {
    const fit = fitModels({ rows, space: SPACE, goals: GOALS, strategy: 'experiment', seed: 7 + round });
    const res = score(fit, { goals: GOALS, q: Q, mode: MODE, seed: 7 + round });
    const picks = res.suggestions?.picks || [];
    if (!picks.length) throw new Error(`seed ${seed} round ${round}: no suggestions (${res.warnings.join(' ')})`);
    // What the screen says before this round is made. The first time it says stop, the stopped branch is
    // played out on the side; the campaign itself makes every round, so stopping can be scored against it.
    if (res.verdict?.stop && !stop) stop = stopHere(rows, res, round, seed);
    const before = { verdict: res.verdict?.level ?? null, lastGain: res.pick?.lastRound?.gain ?? null,
      pickBefore: res.pick ? { batchId: res.pick.batchId, predictedD: res.pick.predictedD, trueD: trueD(res.pick.point) } : null,
      confirmBatches: res.suggestions.confirm?.batches ?? 0 };
    picks.forEach((p, i) => rows.push(row(p.point, makeAndMeasure(p.point, r), round, i, true)));
    // The model's own best guess, once the screen would show it (20 runs or more).
    const afterFit = fitModels({ rows, space: SPACE, goals: GOALS, strategy: 'experiment', seed: 7 + round });
    const after = score(afterFit, { goals: GOALS, q: 1, mode: MODE, seed: 7 + round });
    trace.push({ round, runs: rows.length, picked: pickedBest(rows), smoothed: smoothedBest(rows, afterFit.models),
      suggestionsTrueD: picks.map((p) => trueD(p.point)),
      // What the screen could have said before these runs were made: the best chance one of them beats the best
      // run so far, and the expected gains summed. Kept to calibrate a "stop here" sentence against what came of it.
      pBeatsMax: Math.max(...picks.map((p) => p.pBeatsBest ?? 0)), eiSum: picks.reduce((a, p) => a + (p.ei || 0), 0),
      dBestMeasured: res.suggestions.dBest, ...before,
      optimumTrueD: after.optimum ? trueD(after.optimum.point) : null, optimumPoint: after.optimum?.point || null,
      q2: Object.fromEntries((fit.responses || []).map((x) => [x.name, x.best?.q2 ?? x.q2 ?? null])) });
  }
  return { trace, stop };
}

/** Random runs with the same budget: a Latin hypercube, the best measured one picked. */
function randomCampaign(seed, n) {
  const r = rng(5000 + seed);
  const pts = latinHypercube(n, SPACE.length, mulberry32(77 + seed)).map((u) => snap(fromUnit(Array.from(u), SPACE), SPACE));
  const rows = pts.map((p, i) => row(p, makeAndMeasure(p, r), 0, i, false));
  return pickedBest(rows);
}

/**
 * The textbook route: a face-centred CCD (16 corners, 8 axial points, centre points to fill the budget), a full
 * quadratic per response, and the setting that maximises the predicted desirability made once more. Scored on
 * that predicted optimum, and on the best measured run, whichever the person would trust.
 */
function ccdCampaign(seed, n) {
  const r = rng(9000 + seed);
  const units = [];
  for (let k = 0; k < 16; k++) units.push([0, 1, 2, 3].map((b) => ((k >> b) & 1 ? 1 : 0)));
  for (let d = 0; d < 4; d++) for (const v of [0, 1]) units.push([0, 1, 2, 3].map((b) => (b === d ? v : 0.5)));
  while (units.length < n - 1) units.push([0.5, 0.5, 0.5, 0.5]); // one run kept back to confirm the optimum
  const rows = units.map((u, i) => { const p = snap(fromUnit(u, SPACE), SPACE); return row(p, makeAndMeasure(p, r), 0, i, false); });
  const X = rows.map((x) => toUnit(x.factors, SPACE));
  const models = Object.fromEntries(GOALS.map((g) => [g.name, fitQuadratic(X, rows.map((x) => x.values[g.name]))]));
  const rnd = mulberry32(31 + seed);
  let best = null;
  for (let t = 0; t < 6000; t++) {
    const u = [rnd(), rnd(), rnd(), rnd()];
    const pred = Object.fromEntries(GOALS.map((g) => [g.name, models[g.name].predict(u).mean]));
    const D = overallDesirability(pred, GOALS).D;
    if (!best || D > best.D) best = { D, u };
  }
  const opt = snap(fromUnit(best.u, SPACE), SPACE);
  rows.push(row(opt, makeAndMeasure(opt, r), 1, 0, false));
  return { optimumTrueD: trueD(opt), optimumPoint: opt, picked: pickedBest(rows) };
}

const median = (a) => { const s = a.filter(Number.isFinite).slice().sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const q25 = (a) => { const s = a.filter(Number.isFinite).slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * 0.25)] : null; };
const q75 = (a) => { const s = a.filter(Number.isFinite).slice().sort((x, y) => x - y); return s.length ? s[Math.ceil((s.length - 1) * 0.75)] : null; };
const f3 = (v) => (v == null ? '  —  ' : v.toFixed(3));

const t0 = Date.now();
const opt = trueOptimum();
const budget = 8 + ROUNDS * Q;
console.log(`${LAB} lab. True optimum inside the space: D ${opt.D.toFixed(3)} at FRR ${opt.point.frr.toFixed(2)}, flow ${opt.point.tfr.toFixed(0)}, N/P ${opt.point.np}, PEG ${opt.point.peg_pct.toFixed(2)} mol%`);
console.log(`${SEEDS} campaigns: 8 starting runs + ${ROUNDS} rounds × ${Q} (${MODE}) = ${budget} runs each\n`);

const campaigns = [];
for (let s = 0; s < SEEDS; s++) {
  const c0 = Date.now();
  const { trace, stop } = optimizerCampaign(s);
  campaigns.push({ seed: s, trace, stop, random: randomCampaign(s, budget), ccd: ccdCampaign(s, budget) });
  const last = trace[trace.length - 1];
  console.log(`seed ${s}: picked best ${trace.map((t) => t.picked.trueD.toFixed(3)).join(' → ')}; model's optimum ${f3(last.optimumTrueD)}; ${stop ? `says stop before round ${stop.round}` : 'never says stop'}  (${((Date.now() - c0) / 1000).toFixed(1)} s)`);
}

const perRound = Array.from({ length: ROUNDS + 1 }, (_, k) => {
  const picked = campaigns.map((c) => c.trace[k].picked.trueD);
  const optimum = campaigns.map((c) => c.trace[k].optimumTrueD);
  return { round: k, runs: 8 + k * Q, pickedMedian: median(picked), pickedQ25: q25(picked), pickedQ75: q75(picked),
    optimumMedian: median(optimum), smoothedMedian: median(campaigns.map((c) => c.trace[k].smoothed?.trueD)),
    within95: picked.filter((d) => d >= 0.95 * opt.D).length };
});
const baselines = {
  random: { pickedMedian: median(campaigns.map((c) => c.random.trueD)), pickedQ25: q25(campaigns.map((c) => c.random.trueD)), pickedQ75: q75(campaigns.map((c) => c.random.trueD)),
    within95: campaigns.filter((c) => c.random.trueD >= 0.95 * opt.D).length },
  ccd: { optimumMedian: median(campaigns.map((c) => c.ccd.optimumTrueD)), pickedMedian: median(campaigns.map((c) => c.ccd.picked.trueD)),
    within95: campaigns.filter((c) => Math.max(c.ccd.optimumTrueD, c.ccd.picked.trueD) >= 0.95 * opt.D).length },
};

console.log(`\nRound  runs  picked best (median, IQR)   model's pick  model's optimum  within 95 % of the optimum`);
for (const r of perRound) console.log(`${String(r.round).padStart(5)}  ${String(r.runs).padStart(4)}  ${f3(r.pickedMedian)} (${f3(r.pickedQ25)}–${f3(r.pickedQ75)})       ${f3(r.smoothedMedian)}        ${f3(r.optimumMedian)}           ${r.within95}/${SEEDS}`);
console.log(`\nSame budget (${budget} runs), no optimizer:`);
console.log(`  random runs, best measured picked   ${f3(baselines.random.pickedMedian)} (${f3(baselines.random.pickedQ25)}–${f3(baselines.random.pickedQ75)})   within 95 %: ${baselines.random.within95}/${SEEDS}`);
console.log(`  CCD + quadratic, its optimum made   ${f3(baselines.ccd.optimumMedian)}  (best measured ${f3(baselines.ccd.pickedMedian)})   within 95 %: ${baselines.ccd.within95}/${SEEDS}`);

// What the verdict buys (app/calc/ml/stopping.js): a campaign that stops the first time the screen says stop,
// against the same campaign run to the end. Both are scored on the run a person takes forward, the model's
// pick, by its true score. Runs saved are counted before and after the confirmation runs the screen offers.
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const endPick = (c) => c.trace[ROUNDS].smoothed.trueD;
const stopped = campaigns.filter((c) => c.stop);
const stopping = {
  campaigns: SEEDS, stopped: stopped.length, stopRounds: stopped.map((c) => c.stop.round),
  runsSaved: mean(campaigns.map((c) => (c.stop ? budget - c.stop.runs : 0))),
  runsSavedAfterConfirm: mean(campaigns.map((c) => (c.stop ? budget - c.stop.runs - c.stop.confirmRuns : 0))),
  givenUp: mean(campaigns.map((c) => (c.stop ? endPick(c) - c.stop.pickTrueD : 0))),
  givenUpAfterConfirm: mean(campaigns.map((c) => (c.stop ? endPick(c) - c.stop.confirmedTrueD : 0))),
  givenUpStoppedOnly: mean(stopped.map((c) => endPick(c) - c.stop.pickTrueD)),
  givenUpStoppedOnlyAfterConfirm: mean(stopped.map((c) => endPick(c) - c.stop.confirmedTrueD)),
  worst: stopped.length ? Math.max(...stopped.map((c) => endPick(c) - c.stop.confirmedTrueD)) : null,
  endPick: mean(campaigns.map(endPick)),
  stoppedPick: mean(campaigns.map((c) => (c.stop ? c.stop.confirmedTrueD : endPick(c)))),
  // What the screen said once the confirmation runs were in; none when there was nothing to confirm.
  afterConfirm: Object.fromEntries(['stop', 'maybe', 'go', 'none'].map((l) => [l, stopped.filter((c) => (c.stop.verdictAfter ?? 'none') === l).length])),
};
const sg = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`);
console.log(`\nStopping when the screen says stop (model's pick, true score; ${budget} runs if every round is made):`);
console.log(`  ${stopped.length}/${SEEDS} campaigns were told to stop${stopped.length ? `, before round ${stopping.stopRounds.join(', ')}` : ''}`);
console.log(`  runs saved, mean over all campaigns     ${stopping.runsSaved.toFixed(1)}  (${stopping.runsSavedAfterConfirm.toFixed(1)} after the confirmation runs)`);
console.log(`  true score given up, mean               ${sg(stopping.givenUp)}  (${sg(stopping.givenUpAfterConfirm)} after the confirmation runs)`);
console.log(`  given up, mean over the stopped ones    ${sg(stopping.givenUpStoppedOnly)}  (${sg(stopping.givenUpStoppedOnlyAfterConfirm)} after confirming; worst ${sg(stopping.worst)})`);
console.log(`  model's pick: every round ${f3(stopping.endPick)}, stopping on the verdict and confirming ${f3(stopping.stoppedPick)}`);
const ac = stopping.afterConfirm;
console.log(`  after the confirmation runs the screen said: stop ${ac.stop}, maybe ${ac.maybe}, go ${ac.go}${ac.none ? `; ${ac.none} had nothing to confirm` : ''}`);

// The calibration behind the verdict: the best suggestion's chance to beat the best run, and what the screen
// said before the round, against what that round then added to the model's pick. Rounds 2 onward, the way
// BENCHMARK and LEVELS in stopping.js were counted, so a run of 30 seeds and 6 rounds reproduces both.
const bands = [[0, 0.05, '< 5 %'], [0.05, 0.10, '5–10 %'], [0.10, 0.20, '10–20 %'], [0.20, 0.35, '20–35 %'], [0.35, 1.0001, '≥ 35 %']];
const gains = campaigns.flatMap((c) => c.trace.slice(2).map((t, i) => ({ p: t.pBeatsMax, level: t.verdict, gain: t.smoothed.trueD - c.trace[i + 1].smoothed.trueD })));
const tally = (label, g) => ({ band: label, rounds: g.length, real: g.length ? g.filter((x) => x.gain > 0.01).length / g.length : null, mean: g.length ? mean(g.map((x) => x.gain)) : null });
const calibration = {
  byChance: bands.map(([lo, hi, label]) => tally(label, gains.filter((x) => x.p >= lo && x.p < hi))),
  byVerdict: ['stop', 'maybe', 'go'].map((level) => tally(level, gains.filter((x) => x.level === level))),
};
const line = (b) => console.log(`  ${b.band.padEnd(8)} ${String(b.rounds).padStart(4)} rounds   gains > 0.01: ${b.real == null ? '  —' : `${Math.round(b.real * 100)} %`.padStart(5)}   mean ${sg(b.mean)}`);
console.log(`\nWhat a round added to the model's pick (rounds 2–${ROUNDS}), by the best suggestion's chance to beat the best run:`);
calibration.byChance.forEach(line);
console.log('and by what the screen said before it:');
calibration.byVerdict.forEach(line);
console.log(`\n${((Date.now() - t0) / 1000).toFixed(0)} s`);

if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ lab: LAB, space: SPACE, goals: GOALS.map((g) => g.name), mode: MODE, q: Q, rounds: ROUNDS, seeds: SEEDS, budget,
    trueOptimum: opt, perRound, baselines, stopping, calibration, campaigns }, null, 1));
  console.log(`written to ${path.relative(root, outFile)}`);
}
