// Screen: ML optimizer — an optional module that reads the batches already recorded, fits a surface model per
// response, says how far that model can be trusted, and proposes the next runs to put on the bench.
//
// Before a run the screen is its setup, in the order of the questions a formulator asks: what am I optimising,
// and what can I change. After a run it leads with the answer the module exists for: whether another round is
// worth its batches, which run to take forward, and what to run next or how to confirm the best instead. The
// setup follows as one line. Everything that lets that answer be judged rather than taken on faith — does the
// model know anything, the map, what drives what, whether the suggestions have earned their batches — follows,
// each folded to the one line that states its conclusion, so a person reads the verdict and opens only the
// evidence they doubt.
import { raw, fmt, field, table, chip, toast, header, kpi, download, todayISO, esc } from './kit.js';
import { getRef, getSettings, compositionLabel } from '../refdata.js';
import { selectionFor } from './data.js';
import { buildRows, responseCounts, RESPONSE_DEFS, dataAccount } from '../calc/ml/dataset.js';
import { ALL_FACTORS, PROCESS_FACTORS, COMPOSITION_FACTORS, suggestSpace, mixtureInfo, pointToPlan, toUnit, compositionFromClasses, sameComposition,
  classPercents, mixtureLimits, mixtureAt, canWeighOut, fromUnit } from '../calc/ml/space.js';
import { DEFAULT_GOALS, desirabilityCurve, overallDesirability, desirability } from '../calc/ml/objective.js';
import { fitModels, score, readinessFor, startingDesign, predictAt } from '../calc/ml/optimizer.js';
import { SPLITS } from '../calc/ml/model.js';
import { MODES } from '../calc/ml/acquire.js';
import { timesRun } from '../calc/ml/stopping.js';
import { partialDependence, desirabilityGrid } from '../calc/ml/explain.js';
import { buildExperiment, productionDate, addDaysISO, nextWorkday as nextWorkdayISO, TYPES } from '../calc/experiment.js';
import { checkSuggestions } from '../calc/ml/feasible.js';
import { makeFormulationAllocator, nextExperimentId, usedIds, describeId, raiseCounter } from '../schema.js';
import { info, wireLearn } from './learn.js';
import { sigfig } from '../calc/diagnostics.js';
import { prepare, fitPrepared, defaultSelection, reproduce } from '../calc/ml/pipeline.js';
import { makeFingerprint, setupOf } from '../calc/ml/fingerprint.js';
import { clampBudget, lipidMixerCombos } from '../calc/ml/select.js';
import { predictionCheck } from '../calc/ml/predcheck.js';
import { biologicalTargets, applyTargets, targetGoals } from '../calc/ml/targets.js';
import { runsNeeded } from '../calc/variables.js';
import { transparencyCard, predictionFold, accountCsv, whyTable } from './mlpanel.js';

// The running version, for the model fingerprint (spec 7.5). As in report.js: main.js starts the app as it
// loads, so it is only imported where the app is already running, and the calculations take the version as an
// argument rather than reaching for it.
let appVersion = '';
if (typeof document !== 'undefined') import('../main.js').then((m) => { appVersion = m.APP_VERSION || ''; }, () => {});
const RESPONSE_TOPIC = { particle_size_nm: 'size', PDI: 'pdi', encapsulation_efficiency: 'ee', zeta_potential_mV: 'zeta', rna_content_mg_mL: 'ee' };

const SETUP_KEY = 'mlSetup';
const pct = (x) => `${Math.round(x * 100)} %`;
/** A mol% as a recipe states it: 5, 37.5, −13.9. */
const molPct = (v) => (Number.isFinite(v) ? String(Math.round(v * 10) / 10).replace('-', '−') : '–');
const LEVEL_KIND = { none: 'warn', weak: 'warn', fair: 'info', good: 'ok', strong: 'ok' };

/**
 * A setting at the precision the factor is set in, from its own step: 113 mL/min, FRR 4.1, PEG 0.6 mol%. A
 * fixed one decimal printed "113.0 mL/min" for a pump that takes whole numbers, and two printed "0.60".
 */
const dpOf = (f) => (f?.step ? Math.max(0, Math.min(4, Math.ceil(-Math.log10(f.step) - 1e-9))) : 2);
const atStep = (v, f) => (Number.isFinite(v) ? Number(v.toFixed(dpOf(f))).toLocaleString('en-US', { maximumFractionDigits: dpOf(f) }) : '–');
/** The same for an input box, which takes no thousands separator. */
const stepValue = (v, f) => (Number.isFinite(v) ? String(Number(v.toFixed(dpOf(f)))) : '');
/** A factor's name without its bracketed gloss, for a sentence: "Flow rate ratio", not "Flow rate ratio (aq : org)". */
const shortName = (f) => String(f?.name || f?.key || '').replace(/\s*\(.*\)\s*$/, '');

/**
 * A section folded to the one line that states its conclusion. Whether it is open is the user's call and
 * lives in `state.open`, so the redraw every edit causes leaves each section as they left it; until they
 * choose, `dflt` decides. A fold nested inside a card passes `frame: false`, so it does not draw a second one.
 */
function fold(state, key, { title, say, body, dflt = false, cls = '', frame = true }) {
  if (!body) return '';
  return `<details class="${frame ? 'card ' : ''}fold ${cls}" id="${key}Fold" data-fold="${key}" ${(state.open[key] ?? dflt) ? 'open' : ''}>
    <summary><h2>${title}</h2><span class="fold-say">${say}</span></summary>${body}</details>`;
}

/** The saved configuration: goals, chosen factors and ranges, split, mode. Survives reloads and is exportable. */
function loadSetup(ctx) {
  const saved = ctx.store.get('settings', SETUP_KEY);
  return saved?.value || null;
}
const saveSetup = (ctx, value) => ctx.store.put('settings', { id: SETUP_KEY, value });
/**
 * The recipe a suggested batch is built on, in registry order, so it is the formulation the wizard offers too.
 * The search reads its class mol% for the lipids it neither varies nor balances, and createExperiment builds
 * on it, so the two must be the same record.
 */
const baseComposition = (ref, state) => ref.compositionById[Number(state.baseCompositionId)] || ref.compositions[0];

export async function render(el, ctx) {
  const ref = getRef(ctx), settings = getSettings(ctx);
  // A selection handed over from the data overview (spec 5.3) is the data basis: only its formulations.
  const handed = ctx.params.data ? selectionFor(ctx, ctx.params.data) : null;
  // Biological targets join only while a biology layer is switched on (spec 7.9, calc/ml/targets.js): with none,
  // there are none, and every row is as buildRows made it.
  const bio = biologicalTargets(ctx, settings);
  const allRows = bio.length ? applyTargets(buildRows(ctx), bio, ctx) : buildRows(ctx);
  const rows = handed ? allRows.filter((r) => handed.ids.has(r.batchId)) : allRows;

  const saved = loadSetup(ctx);
  // Experiments switched off on the Data used card stay off (they are part of the saved setup); the measured
  // formulations the ranges and the factor table are read from leave them out too, so a switched-off
  // experiment cannot still widen a search range.
  let measured = rows.filter((r) => r.nResponses > 0 && !(saved?.excluded || []).includes(r.experimentId || ''));

  const auto = suggestSpace(measured.length ? measured : rows);
  // The planner hands over the factors it recommended, so its advice arrives as a working setup rather than
  // a list to retype. Observed ranges where the data has them, the factor's own sensible band otherwise.
  const handedOver = (ctx.params.factors || '').split(',').map((k) => k.trim()).filter((k) => ALL_FACTORS.some((f) => f.key === k));
  const spaceFrom = (keys) => keys.map((key) => {
    const f = ALL_FACTORS.find((x) => x.key === key);
    const obs = measured.map((r) => r.factors[key]).filter(Number.isFinite);
    const lo = obs.length ? Math.max(f.lo, Math.min(...obs)) : f.lo;
    const hi = obs.length ? Math.min(f.hi, Math.max(...obs)) : f.hi;
    return { key, name: f.name, unit: f.unit, step: f.step, lo: lo === hi ? f.lo : lo, hi: lo === hi ? f.hi : hi };
  });
  // Which lipid and mixer (spec 7.1): the one saved, while the data still has it, else the combination with most
  // measured runs. A selection handed over from Data is the data basis instead, so it filters nothing further.
  const combos = lipidMixerCombos(rows);
  // Only a combination the user chose is kept: one saved because it happened to be the largest when the setup was
  // last stored would otherwise stay selected after the data grew elsewhere (a combination of 1 run of 162).
  const chosen = saved?.comboChosen === true;
  const savedCombo = chosen && combos.some((c) => c.lipid === saved.lipid && c.mixer === saved.mixer) ? { lipid: saved.lipid, mixer: saved.mixer }
    : chosen && saved.lipid === null && saved.mixer === null ? { lipid: null, mixer: null } : null;
  const pick = handed ? { lipid: null, mixer: null } : savedCombo || defaultSelection(rows);
  const goals0 = saved?.goals || DEFAULT_GOALS.map((g) => ({ ...g }));
  for (const g of targetGoals(bio)) if (!goals0.some((x) => x.name === g.name)) goals0.push(g);
  const state = {
    lipid: pick.lipid, mixer: pick.mixer, comboChosen: !handed && !!savedCombo, lipidMode: saved?.lipidMode || 'filter',
    goals: goals0,
    space: handedOver.length ? spaceFrom(handedOver) : saved?.space?.length ? saved.space : auto,
    constraints: saved?.constraints || [{ name: 'PDI', op: '<', value: 0.3, on: false }],
    excluded: saved?.excluded || [],
    strategy: saved?.strategy || 'experiment',
    mode: saved?.mode || 'balanced',
    q: saved?.q || 4,
    seed: saved?.seed || 7,
    pdDim: 0, mapA: 0, mapB: 1, whatIf: {},
    open: {}, // which folds the user opened or closed, by key
    // An experiment from these runs is being written. Its buttons are drawn disabled until the write is stored
    // or undone, through every redraw an edit causes meanwhile: a second press used to make a second round.
    creating: false,
  };
  const persist = () => saveSetup(ctx, { goals: state.goals, space: state.space, constraints: state.constraints, strategy: state.strategy, mode: state.mode, q: state.q, seed: state.seed, excluded: state.excluded,
    ...(handed || !state.comboChosen ? {} : { lipid: state.lipid, mixer: state.mixer, comboChosen: true }), lipidMode: state.lipidMode });
  /** What the model would be fitted on now: every formulation, accounted for (calc/ml/dataset.js). */
  const account = () => dataAccount(rows, { space: state.space, goals: state.goals, excluded: state.excluded, limits: ALL_FACTORS });

  let report = null, fit = null, running = false, drawn = null;
  const activeConstraints = () => state.constraints.filter((c) => c.on && Number.isFinite(c.value));
  const budget = clampBudget(settings.mlBudget);
  // The selection and the modes the data allows (pipeline.js prepare), worked out again only when what it reads
  // changes: the panel shows it before a fit, and choosing it can take a moment on ten thousand formulations.
  let prepCache = null;
  const prepNow = () => {
    const key = JSON.stringify([state.excluded, state.lipid, state.mixer, state.lipidMode, state.space, state.goals.filter((g) => g.on !== false).map((g) => [g.name, g.goal, g.target, g.lo, g.hi, g.best, g.worst, g.weight]), budget, state.seed]);
    const off = new Set(state.excluded);
    if (prepCache?.key !== key) prepCache = { key, prep: prepare(rows.filter((r) => !off.has(r.experimentId || '')), { space: state.space, goals: state.goals, lipid: state.lipid, mixer: state.mixer, lipidMode: state.lipidMode,
      budget, seed: state.seed, descriptorsOn: !!settings.mlDescriptors, lipidByKey: ref.lipidByKey }) };
    return prepCache.prep;
  };

  /** Refit every surface: needed only when the data, the factors, the selection or the split strategy change. */
  function compute() {
    fit = fitPrepared(prepNow(), { space: state.space, goals: state.goals, strategy: state.strategy, seed: state.seed, lipidByKey: ref.lipidByKey });
    rescore();
  }
  /** Re-score the existing surfaces: goals, limits, mode, batch size and seed all land here, in milliseconds. */
  function rescore() {
    if (!fit) return;
    const baseClasses = classPercents(baseComposition(ref, state), ref);
    report = score(fit, { goals: state.goals, constraints: activeConstraints(), q: state.q, mode: state.mode, seed: state.seed, baseClasses });
    // Every analysis carries its fingerprint (spec 7.5), and a round made from it stores it (createExperiment).
    report.fingerprint = makeFingerprint({ report, appVersion,
      setup: setupOf({ ...state, constraints: activeConstraints(), budget, baseClasses }) });
  }

  function draw() {
    const prep = prepNow();
    const sel = prep.sels[prep.tries[0]];
    const counts = responseCounts(sel.target, state.space);
    const usable = report?.n ?? sel.target.length;
    const ready = readinessFor(usable);
    const panel = transparencyCard({ state, prep, report, ref, settings, handed, rows, descriptorsOn: !!settings.mlDescriptors });
    const mlRounds = ctx.store.all('experiments').filter((e) => e.design?.ml?.fingerprint?.hash)
      .sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || ''))).map((e) => ({ id: e.id, name: e.name, fp: e.design.ml.fingerprint }));
    const predFold = predictionFold(state, predictionCheck(allRows), mlRounds);
    // The Data used card (0.15) counts experiments; the panel above it counts what the selection kept of them.
    const acc = account();
    const fromExps = report ? new Set(report.rows.map((r) => r.experimentId || '')).size : acc.usedExperiments;
    const source = `${usable} formulation${usable === 1 ? '' : 's'} from ${fromExps} experiment${fromExps === 1 ? '' : 's'}`;

    // Everything below the header lives inside #mlRoot, and the delegated change listener is attached to that
    // element rather than to #main. A redraw replaces #mlRoot, so its listener goes with it; attaching to
    // #main instead would add one more handler on every redraw and each edit would run all of them.
    el.innerHTML = header('Optimize', 'Optimizer',
      `<button type="button" class="chip linkchip ${ready.stage === 'none' || ready.stage === 'seed' ? 'warn' : 'info'}" id="mlSourceChip" title="Which formulations and experiments, and which were left out: the Data used card">${report ? 'fitted on ' : ''}${source}</button>
       <button class="primary" id="runBtn" ${running ? 'disabled' : ''}>${report ? 'Recalculate' : 'Fit model and suggest runs'}</button>`) +
      `<div id="mlRoot">` +
      (handed ? `<div class="note" id="mlSelection">Data: <b>${esc(handed.sentence)}</b>, chosen in <a href="#/data?${esc(ctx.params.data)}">Data</a>. <a href="#/ml">Use all formulations instead</a>.</div>` : '') +
      (handedOver.length ? `<div class="note">The factors below came from <a href="#/advisor">the planner</a>: ${handedOver.map((k) => esc(ALL_FACTORS.find((f) => f.key === k).name)).join(', ')}. Change anything that does not match your rig.</div>` : '') +
      panel +
      dataCard(acc, state, report) +
      (report
        // The verdict and the runs lead (usability cycle 6, L1); the setup's one line follows them, unless the
        // setup is the next thing to change (a goal to fix, or no suggestions), when it opens and leads.
        ? (setupLeads(state, report) ? setupFold(state, auto, measured, counts, report) : '') +
          lede(report, ready, usable, state, source) +
          suggestionsCard(report, state, ref, { settings, stocks: ctx.store.all('stocks'), baseline: { frr: settings.defaultFRR, tfr: 112.5, quench: settings.defaultQuenchFactor } }) +
          (setupLeads(state, report) ? '' : setupFold(state, auto, measured, counts, report)) +
          modelFold(report, state) +
          mapFold(report, state) +
          driversFold(report, state) +
          progressFold(report, state) +
          predFold +
          dataFold(report, state) +
          fold(state, 'method', { title: 'Method', cls: 'advanced', body: methodText(),
            say: `a Gaussian process per response; runs chosen by expected improvement in the overall score; seed ${esc(report.seed)}` })
        : lede(report, ready, usable, state, source) +
          goalsCard(state) +
          spaceCard(state, auto, measured, counts, usable) +
          predFold +
          `<div class="card advanced"><h2>Method</h2>${methodText()}</div>`) +
      `</div>`;

    wireLearn(el.querySelector('#mlRoot'));
    drawn = el.querySelector('#mlRoot');
    wire(el, ctx, ref, settings, state, report, { draw, compute, rescore, persist, measured, prepNow, allRows, bio: bio.length > 0, usable,
      // an experiment switched on or off: the measured rows change, and so does everything fitted on them
      setExcluded: (ids) => {
        state.excluded = [...new Set(ids)];
        const off = new Set(state.excluded);
        measured = rows.filter((r) => r.nResponses > 0 && !off.has(r.experimentId || ''));
        report = null; fit = null;
      },

      setRunning: (v) => { running = v; },
      // A write that ends after the user has gone elsewhere must not draw this screen over the one now showing.
      // A visit back draws a #mlRoot of its own, so the one this visit drew last is how to tell.
      shown: () => el.querySelector('#mlRoot') === drawn,
      // Changing which factors are modelled invalidates the whole fit. `wire` cannot clear it by assigning to
      // its own parameter, so it asks here: otherwise the screen keeps showing a report for the old factor set
      // and "create an experiment" writes suggestions keyed to factors that are no longer in the space.
      invalidate: () => { report = null; fit = null; } });
  }

  draw();
}

/* ---------------- the one-line answer at the top ---------------- */
function lede(report, ready, usable, state, source) {
  if (!report) {
    if (usable < 8) return `<div class="card" style="border-color:var(--c-ml)"><h2>Start here</h2>
      <p>${usable === 0 ? 'No formulation yet carries both a measured result for a goal and every factor chosen below.' : `${esc(source[0].toUpperCase() + source.slice(1))} ${usable === 1 ? 'has' : 'have'} a measured result and every factor chosen below (the Data used card above lists them).`}
      A surface model needs about <b>8 runs</b> before it says anything, and about <b>15</b> before its quality can be tested honestly.</p>
      <p class="muted">The fastest way there is a spread-out starting design rather than runs clustered around one recipe. Choose the factors below, then take the starting design: a Latin hypercube improved by maximin swaps, which spreads runs through the interior where a surface model learns most. If you would rather have a classical design with a protocol and a worksheet, the <a href="#/doe">DoE screen</a> builds central composite and Box-Behnken designs and its runs feed this module just the same.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button id="seedBtn" data-n="${Math.max(8 - usable, 4)}" ${state.creating ? 'disabled' : ''}>Propose ${Math.max(8 - usable, 4)} starting runs</button><a class="btn" href="#/experiments?new=1&type=doe">Design a formal DoE instead</a></div></div>`;
    return `<div class="card" style="border-color:var(--c-ml)"><h2>Ready</h2><p>${esc(source[0].toUpperCase() + source.slice(1))} can be used: the Data used card above lists them, and what was left out and why. Press <b>Fit model and suggest runs</b> to fit the model on them and get proposals.</p></div>`;
  }
  const s = report.suggestions;
  const best = report.scored?.[0];
  if (!s?.picks?.length) return `<div class="card" style="border-color:var(--c-ml)"><h2>No suggestions yet</h2>${(report.warnings || []).map((w) => `<div class="note warn">${esc(w)}</div>`).join('') || '<p class="muted">Not enough measured runs for every active goal.</p>'}</div>`;
  // Model quality as numbers in the value and names in the line under it: with three responses the names in
  // the value ran to four lines of headline type, and the verdict in words is one fold further down anyway.
  const fitted = report.responses.filter((r) => r.best);
  // The card opens on whether another round is worth its batches (stopping.js), then on the run to take
  // forward. "Best so far" stays, because every suggestion is measured against it, but it says how often it
  // was made and what the model makes of it: a single batch at the top of twenty is the luckiest as much as
  // the best. When the verdict is to stop, the confirmation it offers sits here rather than under the table.
  const v = report.verdict, pick = report.pick;
  const goals = report.suggestionGoals || report.goals;
  const made = (n) => (n === 1 ? 'made once' : n === 2 ? 'made twice' : `made ${n} times`);
  const observed = report.observed || [];
  const bestRuns = best ? timesRun(best.point, observed, report.space) : 0;
  const bestRated = best && pick && best.batchId !== pick.batchId ? predictedScore(report, best.point, goals) : null;
  const pBeats = Math.max(...s.picks.map((p) => p.pBeatsBest ?? 0));
  const opt = report.optimum, optRuns = opt ? timesRun(opt.point, observed, report.space) : 0;
  return `<div class="card" style="border-color:var(--c-ml)" id="mlLede">
    ${v ? `<p class="note verdict ${v.level === 'stop' ? 'ok' : ''}" id="roundVerdict" data-level="${v.level}">${esc(v.sentence)}<br><span class="muted" style="font-size:12.5px">${esc(v.evidence)}</span></p>` : ''}
    <div class="grid g4">
      ${pick ? kpi('Take forward', raw(`<a href="#/formulation?batch=${esc(pick.batchId)}">${esc(pick.batchId || '–')}</a>`), `the model's pick: predicted ${fmt(pick.predictedD, 2)}, ${made(pick.runs.length)}`)
        : kpi('Run next', `${s.picks.length} setting${s.picks.length === 1 ? '' : 's'}`, MODES[state.mode].label.toLowerCase())}
      ${opt ? kpi('Predicted optimum', fmt(opt.desirability, 2), `${settingText(opt.point, report.space)}; ${optRuns ? made(optRuns) : 'never made'}`)
        : kpi('Best suggestion beats it', pBeats < 0.005 ? '< 1 %' : pct(pBeats), 'in simulated outcomes')}
      ${kpi('Best so far', best ? fmt(best.D, 2) : '–', best ? `${best.batchId}, ${made(bestRuns)}${bestRated != null ? `; the model expects ${fmt(bestRated, 2)}` : ''}` : '')}
      ${kpi('Model quality (Q²)', fitted.map((r) => fmt(r.best.q2, 2)).join(' · ') || '–',
        // the split labels carry their own preposition ("By experiment …", "Leave one run out")
        `${fitted.map((r) => r.label || r.name).join(' · ')}${fitted.length ? '; ' : ''}held out ${SPLITS[report.strategy].label.toLowerCase()}`)}
    </div>
    ${v?.stop ? confirmNote(report, state) : ''}</div>`;
}

/**
 * What one batch at a proposed setting should measure: score() puts it on each suggestion and confirmation run
 * (optimizer.js, `forecast`). The table shows it and the batch stores it, so the two agree with each other and
 * with the result they will be held against. `predicted` stands in for a report made without it.
 */
const expected = (p) => p.forecast || p.predicted || {};

/** A setting in a sentence, at the precision each factor is set in: "Flow rate ratio 3.3, Total flow rate 48 mL/min". */
const settingText = (point, space) => space.map((f) => `${shortName(f)} ${atStep(point[f.key], f)}${f.unit ? ` ${f.unit}` : ''}`).join(', ');

/** The overall score the fitted surfaces predict at a setting, for a run whose measured score may be luck. */
function predictedScore(report, point, goals) {
  const pred = predictAt(report.models.filter((m) => m.gp?.kind === 'gp'), report.space, point);
  return pred ? overallDesirability(Object.fromEntries(Object.entries(pred).map(([k, q]) => [k, q.mean])), goals).D : null;
}

/**
 * The confirmation runs: a repeat of the model's pick and the predicted optimum made twice (acquire.js,
 * confirmAdvice). One note and one button wherever it appears: in the lede when the verdict is to stop, under
 * the suggestions otherwise. The optimum's settings are in the lede's tile beside the pick, so they are not
 * repeated here.
 */
function confirmNote(report, state) {
  const c = report.suggestions?.confirm;
  if (!c) return '';
  const label = c.batches === 1 && c.batchId ? `Add a repeat of ${c.batchId}` : `Add the ${c.batches} confirmation runs`;
  // When the verdict is to stop, confirming is the recommended next step, so its button takes the primary look
  // and the one that makes another round gives it up.
  return `<div class="note" id="confirmNote">${esc(c.reason)}
    <button id="addConfirm" ${report.verdict?.stop ? 'class="primary" ' : ''}${state.creating ? 'disabled ' : ''}style="padding:3px 10px;margin-left:6px">${esc(label)}</button></div>`;
}

/* ---------------- where the data comes from ---------------- */
const LEFT_OUT = {
  excluded: 'In an experiment you switched off',
  noResult: 'No result yet for a response switched on as a goal',
  missingFactor: 'A factor being modelled is not on the record',
  outside: 'A setting outside the limits the optimizer works in',
};
/**
 * Data used: which formulations the model is (or would be) fitted on, experiment by experiment, and every
 * formulation left out with the reason. Each experiment can be switched off, which is remembered with the
 * setup. Open before a fit, folded to its line after one, unless the user chose: where the numbers come from is the first thing to know about them, and
 * "it says it has discovered runs" was the complaint that put this card here.
 */
function dataCard(acc, state, report) {
  const goals = new Set(state.goals.filter((g) => g.on !== false).map((g) => g.name));
  const SHORT_RESP = { particle_size_nm: 'Size', PDI: 'PDI', encapsulation_efficiency: 'EE', zeta_potential_mV: 'Zeta', rna_content_mg_mL: 'RNA content', size_drift: 'Size drift' };
  const label = (n) => SHORT_RESP[n] || RESPONSE_DEFS.find((r) => r.name === n)?.label?.replace(/\s*\(.*\)\s*$/, '') || n;
  const typeName = (t) => TYPES.find((x) => x.id === t)?.name || t || '';
  const used = acc.used.length, nLeft = acc.left.length;
  const say = `${report ? 'fitted on' : 'would be fitted on'} ${used} formulation${used === 1 ? '' : 's'} from ${acc.usedExperiments} experiment${acc.usedExperiments === 1 ? '' : 's'}${nLeft ? ` · ${nLeft} left out` : ''}${state.excluded.length ? ` · ${state.excluded.length} experiment${state.excluded.length === 1 ? '' : 's'} switched off` : ''}`;
  const rows = acc.experiments.map((e) => {
    const key = e.id || '_none';
    const leftWords = Object.entries(e.left).filter(([k, n]) => n && k !== 'excluded').map(([k, n]) =>
      `${n} ${k === 'noResult' ? 'without a goal result' : k === 'missingFactor' ? 'missing a factor' : 'outside the limits'}`);
    return { attrs: `class="${e.excluded ? 'excluded' : ''}" data-exp="${esc(e.id)}"`, cells: [
      raw(`<input type="checkbox" name="x_exp_${esc(key)}" ${e.excluded ? '' : 'checked'} style="width:auto" aria-label="use ${esc(e.id || 'formulations outside any experiment')}">`),
      raw(e.id ? `<a href="#/experiments?id=${esc(e.id)}"><b>${esc(e.id)}</b></a> ${esc(e.name)}<br><a class="muted small" href="#/doe?id=${esc(e.id)}">results on Design &amp; results</a>` : '<span class="muted">Not in an experiment</span>'),
      typeName(e.type),
      raw(e.excluded ? `<span class="muted">switched off (${e.total})</span>` : `<b>${e.used}</b> <span class="muted">of ${e.total}${e.measured !== e.total ? `, ${e.measured} measured` : ''}</span>`),
      raw(Object.keys(e.responses).length ? Object.entries(e.responses).map(([n, k]) => `<span class="resp${goals.has(n) ? ' on' : ''}" title="${k} formulation${k === 1 ? '' : 's'} with ${esc(label(n))}${goals.has(n) ? '; a goal' : '; not a goal now'}">${esc(label(n))} ${k}</span>`).join('') : '<span class="muted">no results yet</span>'),
      raw(e.excluded ? '<span class="why">all, switched off</span>' : leftWords.length ? `<span class="why">${esc(leftWords.join(', '))}</span>` : '<span class="muted">none</span>'),
    ] };
  });
  // Every formulation left out, grouped by why, so a missing one can be found and fixed at its record.
  const groups = Object.keys(LEFT_OUT).map((k) => [k, acc.left.filter((x) => x.reason === k)]).filter(([, xs]) => xs.length);
  const list = (xs) => {
    const shown = xs.slice(0, 14).map((x) => `<a href="#/formulation?batch=${esc(x.batchId)}" title="${esc(x.detail)}">${esc(x.batchId)}</a>`).join(', ');
    return `${shown}${xs.length > 14 ? ` and ${xs.length - 14} more` : ''}`;
  };
  const detailOf = (k, xs) => {
    if (k === 'missingFactor' || k === 'outside') return ` <span class="why">(${esc([...new Set(xs.map((x) => x.detail))].slice(0, 3).join('; '))})</span>`;
    if (k === 'noResult') { const notMade = xs.filter((x) => x.detail === 'not made yet').length; return notMade ? ` <span class="why">(${notMade} not made yet)</span>` : ''; }
    return '';
  };
  const outsideSearch = acc.used.filter((r) => r.outsideSearch).length;
  const body = `<p class="muted" style="margin-top:0">The optimizer reads every formulation recorded under <a href="#/experiments">Experiments</a>: its settings from the formulation record and its results from <a href="#/measurements">Measurements</a>, the same numbers <a href="#/doe">Design &amp; results</a> shows. Nothing is typed in here. Untick an experiment to leave it out of the model; the choice is kept.${goals.size ? ` Highlighted results are the goals switched on below: ${[...goals].map((n) => esc(label(n))).join(', ')}.` : ''}</p>
    ${table(['Use', 'Experiment', 'Type', { label: 'Formulations used', right: false }, 'Results recorded', 'Left out'], rows, { empty: 'No experiments yet.' })}
    ${state.excluded.length ? `<button type="button" id="mlUseAll" style="margin-top:8px;padding:4px 10px">Use every experiment again</button>` : ''}
    ${groups.length ? `<h2 style="font-size:13px;margin-top:12px">Left out (${nLeft})</h2><ul class="muted" id="mlLeftOut" style="margin:4px 0 0;padding-left:18px">${groups.map(([k, xs]) =>
      `<li data-reason="${k}"><b>${esc(LEFT_OUT[k])}</b> (${xs.length}): ${list(xs)}${detailOf(k, xs)}</li>`).join('')}</ul>` : '<p class="muted" id="mlLeftOut">Nothing left out: every formulation on record is used.</p>'}
    ${outsideSearch ? `<p class="muted">${outsideSearch} of the formulations used lie outside the search range set under Goals and factors. They still inform the model about that edge; suggestions stay inside the range.</p>` : ''}`;
  // Open until there is an answer to lead with; then it folds to its line, which still says what was fitted on.
  return fold(state, 'source', { title: 'Data used', say: esc(say), dflt: !report, cls: 'mlData', body });
}

/* ---------------- the setup, folded once there is a run to lead with ---------------- */
/**
 * Goals and factors after a run: one line that says what was optimised over what, which is all most visits
 * need of it, and the full forms one click away. Open by default when something in it needs fixing, or when
 * the run produced no suggestions, because then the setup is the next thing to change.
 */
function setupFold(state, auto, measured, counts, report) {
  const goalWord = (g) => {
    const unit = g.unit ? ` ${g.unit}` : '';
    return g.goal === 'target' ? `target ${sigfig(g.target)}${unit}`
      : g.goal === 'range' ? `${sigfig(g.lo)} to ${sigfig(g.hi)}${unit}`
      : g.goal === 'minimize' ? 'as low as possible' : 'as high as possible';
  };
  const goals = state.goals.filter((g) => g.on !== false);
  const problems = goalProblems(state.goals);
  const say = `${goals.map((g) => `${esc(g.label || g.name)} ${esc(goalWord(g))}`).join(', ') || 'no goal switched on'}
    · over ${state.space.map((f) => `${esc(shortName(f))} ${atStep(f.lo, f)}–${atStep(f.hi, f)}${f.unit ? ` ${esc(f.unit)}` : ''}`).join(', ') || 'no factor'}
    ${problems.length ? `· <b>${problems.length} goal${problems.length === 1 ? ' needs' : 's need'} fixing</b>` : '· open to change'}`;
  return fold(state, 'setup', { title: 'Goals and factors', say, dflt: setupLeads(state, report),
    body: goalsCard(state) + spaceCard(state, auto, measured, counts, report?.n) });
}
/** Whether the setup is the next thing to change: a goal that needs fixing, or a run that produced no suggestions. */
const setupLeads = (state, report) => goalProblems(state.goals).length > 0 || !report.suggestions?.picks?.length;

/* ---------------- goals ---------------- */
/** Limits that cannot mean what they say. Caught here rather than silently degrading the score. */
export function goalProblems(goals) {
  const out = [];
  for (const g of goals.filter((x) => x.on !== false)) {
    const name = g.label || g.name;
    const n = (v) => (v == null || v === '' ? null : Number(v));
    if (g.goal === 'target') {
      const [lo, t, hi] = [n(g.lo), n(g.target), n(g.hi)];
      if (lo == null || t == null || hi == null) out.push(`${name}: the ideal value and both limits are needed.`);
      else if (!(lo < hi)) out.push(`${name}: the low limit must be below the high limit.`);
      else if (!(lo <= t && t <= hi)) out.push(`${name}: the ideal value ${t} is outside the acceptable range ${lo} to ${hi}.`);
    } else if (g.goal === 'range') {
      const [lo, hi] = [n(g.lo), n(g.hi)];
      if (lo == null || hi == null) out.push(`${name}: both ends of the acceptable band are needed.`);
      else if (!(lo < hi)) out.push(`${name}: the low end of the band must be below the high end.`);
    } else {
      const [best, worst] = [n(g.best), n(g.worst)];
      if (best == null || worst == null) out.push(`${name}: both the ideal and the unacceptable value are needed.`);
      else if (g.goal === 'minimize' && !(best < worst)) out.push(`${name}: for a goal of "as low as possible" the ideal ${best} must be below the unacceptable ${worst}. As entered, every run at or below ${best} scores the same.`);
      else if (g.goal === 'maximize' && !(best > worst)) out.push(`${name}: for a goal of "as high as possible" the ideal ${best} must be above the unacceptable ${worst}. As entered, every run at or above ${best} scores the same.`);
    }
    if ((g.weight ?? 1) < 0) out.push(`${name}: a negative weight is not meaningful; use 0 to switch the goal off.`);
  }
  return out;
}

function goalsCard(state) {
  const rows = state.goals.map((g, i) => {
    const on = g.on !== false;
    const fields = g.goal === 'target'
      ? `<input type="number" step="any" name="g_target_${i}" value="${g.target ?? ''}" style="width:78px" title="ideal value"> <span class="muted">ideal</span>
         <input type="number" step="any" name="g_lo_${i}" value="${g.lo ?? ''}" style="width:72px" title="still acceptable, low end">–<input type="number" step="any" name="g_hi_${i}" value="${g.hi ?? ''}" style="width:72px" title="still acceptable, high end">`
      : g.goal === 'range'
      ? `<input type="number" step="any" name="g_lo_${i}" value="${g.lo ?? ''}" style="width:78px" title="anything from here"><span class="muted">to</span><input type="number" step="any" name="g_hi_${i}" value="${g.hi ?? ''}" style="width:78px" title="… to here is equally acceptable"> <span class="muted">all equally good</span>`
      : g.goal === 'minimize'
        ? `<input type="number" step="any" name="g_best_${i}" value="${g.best ?? ''}" style="width:78px" title="as good as it needs to get"> <span class="muted">ideal or below</span>
           <input type="number" step="any" name="g_worst_${i}" value="${g.worst ?? ''}" style="width:78px" title="unacceptable at or above"> <span class="muted">unacceptable</span>`
        : `<input type="number" step="any" name="g_best_${i}" value="${g.best ?? ''}" style="width:78px" title="as good as it needs to get"> <span class="muted">ideal or above</span>
           <input type="number" step="any" name="g_worst_${i}" value="${g.worst ?? ''}" style="width:78px" title="unacceptable at or below"> <span class="muted">unacceptable</span>`;
    return { cells: [
      // An in-vivo target is listed but cannot be switched on in this stage (spec 8.6, calc/ml/targets.js).
      raw(`<input type="checkbox" name="g_on_${i}" ${on && !g.locked ? 'checked' : ''} ${g.locked ? `disabled title="${esc(g.locked)}"` : ''} style="width:auto">`),
      raw(`<b>${esc(g.label || g.name)}</b>${g.unit ? ` <span class="muted">${esc(g.unit)}</span>` : ''} ${RESPONSE_TOPIC[g.name] ? info(RESPONSE_TOPIC[g.name]) : ''}`),
      raw(`<select name="g_goal_${i}" style="width:110px">${['target', 'range', 'minimize', 'maximize'].map((x) => `<option value="${x}" ${g.goal === x ? 'selected' : ''}>${x === 'target' ? 'hit a target' : x === 'range' ? 'stay in a band' : x === 'minimize' ? 'as low as possible' : 'as high as possible'}</option>`).join('')}</select>`),
      raw(`<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${fields}</div>`),
      raw(`<input type="number" step="0.5" min="0" name="g_weight_${i}" value="${g.weight ?? 1}" style="width:66px">`),
      raw(on ? curveSvg(g) : '<span class="muted">off</span>'),
    ] };
  });
  return `<div class="card"><h2>What counts as a good batch ${info('desirability')}</h2>
    <p class="muted">Each goal becomes a score from 0 (unacceptable) to 1 (ideal). The overall score is their weighted geometric mean, so a single unacceptable result sinks the batch however good the rest is. That is deliberate: it stops the optimiser trading away a usable PDI for a prettier encapsulation.</p>
    ${table(['Use', 'Response', 'Goal', 'Range', 'Weight', 'Shape'], rows)}
    ${goalProblems(state.goals).map((p) => `<div class="note warn">${esc(p)}</div>`).join('')}
    <div class="advanced" style="margin-top:10px"><h2>Hard limits</h2>
      <p class="muted">A hard limit is different from a goal: settings whose predicted result is likely to breach it are not proposed at all.</p>
      ${table(['Use', 'Response', 'Must be', 'Value'], state.constraints.map((c, i) => ({ cells: [
        raw(`<input type="checkbox" name="c_on_${i}" ${c.on ? 'checked' : ''} style="width:auto">`),
        raw(`<select name="c_name_${i}">${RESPONSE_DEFS.map((r) => `<option value="${r.name}" ${c.name === r.name ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select>`),
        raw(`<select name="c_op_${i}" style="width:90px"><option value="<" ${c.op === '<' ? 'selected' : ''}>below</option><option value=">" ${c.op === '>' ? 'selected' : ''}>above</option></select>`),
        raw(`<input type="number" step="any" name="c_value_${i}" value="${c.value ?? ''}" style="width:90px">`)] })))}
      <button id="addConstraint" style="margin-top:6px;padding:4px 10px">+ Add limit</button></div></div>`;
}

/** A small plot of one desirability curve, so the shape is visible rather than implied. */
function curveSvg(g) {
  const pts = desirabilityCurve(g, 48);
  if (!pts.length) return '<span class="muted" title="one of this goal\'s limits is empty">limits incomplete</span>';
  const W = 150, H = 34, lo = pts[0].y, hi = pts[pts.length - 1].y;
  const sx = (y) => (hi > lo ? ((y - lo) / (hi - lo)) * (W - 2) + 1 : W / 2);
  const sy = (d) => H - 2 - d * (H - 6);
  return `<svg viewBox="0 0 ${W} ${H}" style="width:${W}px;height:${H}px" role="img" aria-label="desirability curve for ${esc(g.label || g.name)}">
    <polyline points="${pts.map((p) => `${sx(p.y).toFixed(1)},${sy(p.d).toFixed(1)}`).join(' ')}" fill="none" class="ac" stroke-width="1.8"/>
    <line x1="1" y1="${H - 2}" x2="${W - 1}" y2="${H - 2}" class="ax"/>
    <text x="1" y="10" class="lb">${fmt(lo, lo < 1 ? 2 : 0)}</text><text x="${W - 1}" y="10" class="lb" text-anchor="end">${fmt(hi, hi < 1 ? 2 : 0)}</text></svg>`;
}

/* ---------------- design space ---------------- */
function spaceCard(state, auto, rows, counts, usable = null) {
  const inSpace = (k) => state.space.find((s) => s.key === k);
  const cov = {};
  for (const f of ALL_FACTORS) {
    const vals = rows.map((r) => r.factors[f.key]).filter(Number.isFinite);
    const distinct = new Set(vals.map((v) => Math.round(v * 1e4) / 1e4));
    cov[f.key] = { n: vals.length, distinct: distinct.size, lo: vals.length ? Math.min(...vals) : null, hi: vals.length ? Math.max(...vals) : null };
  }
  const mix = mixtureInfo(state.space);
  const row = (f) => {
    const s = inSpace(f.key), c = cov[f.key];
    const status = !c.n ? chip('never recorded', 'warn') : c.distinct < 2 ? chip('held constant', 'warn') : c.distinct === 2 ? chip('two levels', 'info') : chip(`${c.distinct} levels`, 'ok');
    return { cells: [
      raw(`<input type="checkbox" name="s_on_${f.key}" ${s ? 'checked' : ''} style="width:auto" ${c.n ? '' : 'title="no batch records a value for this"'}>`),
      raw(`${esc(f.name)}${f.unit ? ` <span class="muted">${esc(f.unit)}</span>` : ''}`),
      raw(status),
      raw(c.n ? `<span class="muted">${atStep(c.lo, f)} – ${atStep(c.hi, f)}</span>` : '<span class="muted">–</span>'),
      raw(s ? `<input type="number" step="any" name="s_lo_${f.key}" value="${stepValue(s.lo, f)}" style="width:84px">` : ''),
      raw(s ? `<input type="number" step="any" name="s_hi_${f.key}" value="${stepValue(s.hi, f)}" style="width:84px">` : ''),
    ] };
  };
  return `<div class="card"><h2>What you are willing to change ${info('doe')}</h2>
    <p class="muted">Only factors that actually varied across your batches can be judged. A factor held constant is listed so you can see it was excluded for that reason, not because it does not matter.</p>
    <p id="spaceNeed" class="note">${esc(runsNeeded(state.space.length, usable ?? rows.length).sentence)}</p>
    <h2 style="font-size:13px;margin-top:10px">Process</h2>${table(['Use', 'Factor', 'In your data', 'Observed', 'Search from', 'to'], PROCESS_FACTORS.map(row))}
    <h2 style="font-size:13px;margin-top:10px">Composition</h2>${table(['Use', 'Factor', 'In your data', 'Observed', 'Search from', 'to'], COMPOSITION_FACTORS.map(row))}
    ${mix ? `<div class="note">${info('mixture')} Varying lipid mol% is a different kind of change from varying the process: it moves you away from a composition with clinical precedent, and immune response and safety do not follow from particle size and encapsulation. Recent work on thermostable formulations deliberately froze the lipid ratios for that reason and optimised excipients instead. One case deserves naming: the reviews put organ targeting down to PEG content, PEG molecular weight and PEG tail length, so raising PEG to tidy up a dispersity figure can move where the particle ends up, and nothing on this screen would show it. Worth a thought before you let the optimiser roam here.<br><br>Lipid mol% has to total 100, so <b>${esc(mix.balance || 'no class')}</b> is left free to take up the slack while the others are varied. ${mix.balance ? '' : 'With every class varied there is nothing left to balance, so switch one off.'}</div>` : ''}
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button id="autoSpace">Suggest from my data</button><span class="muted" style="align-self:center">search ranges default to the span you have already run, widened by a quarter</span></div></div>`;
}

/* ---------------- does the model know anything ---------------- */
/** The verdict per response in a word, as the trust report gives it, so the folded line agrees with the notes inside. */
const VERDICT = { weak: 'weak', fair: 'fair', good: 'good', strong: 'strong' };
function modelFold(report, state) {
  if (!report.responses.length) return '';
  const say = report.responses.map((r) => {
    const name = esc(r.label || r.name);
    if (r.skipped) return `${name} skipped`;
    const q = r.best?.q2;
    const word = r.trust?.level === 'none' ? (q == null ? 'not testable yet' : 'worse than the average') : VERDICT[r.trust?.level] || r.trust?.level || '–';
    return `${word} for ${name}${q != null ? ` (Q² ${fmt(q, 2)})` : ''}`;
  }).join(', ');
  return fold(state, 'model', { title: 'Model quality', say, body: modelCard(report, state) });
}

function modelCard(report, state) {
  if (!report.responses.length) return '';
  const blocks = report.responses.map((r) => {
    if (r.skipped) return `<div class="note warn"><b>${esc(r.label || r.name)}</b>: skipped, ${esc(r.skipped)}.</div>`;
    const t = r.trust;
    const cmp = table(['Model', { label: 'Q² (held out)', right: true }, { label: 'Rank ρ', right: true }, { label: 'RMSE', right: true }, 'What it is'],
      r.results.map((x) => ({ attrs: x.key === r.best?.key ? 'style="font-weight:600"' : '',
        cells: [raw(`${esc(x.label)}${x.key === 'quadratic' && r.quadLevel ? ` <span class="muted">(${esc(r.quadLevel)})</span>` : ''}`),
          fmt(x.q2, 3), fmt(x.rho, 2), fmt(x.rmse, r.name === 'PDI' ? 3 : 2), raw(`<span class="muted">${esc(x.note)}</span>`)] })));
    const gpLost = r.best && r.best.key !== 'gp' && r.gpQ2 != null && r.best.q2 != null && r.best.q2 - r.gpQ2 > 0.05;
    const beatsDummy = r.best && r.dummy && r.best.rmse != null && r.dummy.rmse != null ? (1 - r.best.rmse / r.dummy.rmse) : null;
    return `<div style="margin-top:12px"><h2 style="font-size:14px">${esc(r.label || r.name)} <span class="muted">${r.n} runs</span></h2>
      <div class="note ${LEVEL_KIND[t.level]}"><b>${esc(t.headline)}</b><br>${esc(t.detail)}</div>
      ${beatsDummy != null ? `<p class="muted">Error is ${beatsDummy > 0 ? `${pct(beatsDummy)} lower than` : `${pct(-beatsDummy)} higher than`} simply predicting the average of every run.${r.noise ? ` Repeat runs put the measurement noise at about ± ${fmt(r.noise.sd, r.name === 'PDI' ? 3 : 1)} ${esc(r.unit || '')} on ${r.noise.df} degree${r.noise.df === 1 ? '' : 's'} of freedom, which the fit weighs as evidence of the floor no model can beat.${r.noise.df < 5 ? ' That few degrees of freedom is weak evidence: repeats that happen to agree barely lower the noise, ones that differ widely raise it.' : ''} ${info('noise')}` : ''}</p>` : ''}
      ${r.hit ? `<p class="muted">Of the ${r.hit.k} held-out runs it rated best, <b>${r.hit.hits}</b> really were in the best ${r.hit.k}; picking at random would average ${fmt(r.hit.byChance * r.hit.k, 1)}. Ranking is what the suggestions rely on, so this matters more than the error figures when Q² is modest.</p>` : ''}
      ${r.null ? `<p class="muted">Null check: shuffling the results and refitting the same way reaches Q² ${fmt(r.null.median, 2)} typically and ${fmt(r.null.high, 2)} at ${r.null.isMax ? 'best' : 'the ninth decile'}, over ${r.null.n} shuffles. ${r.best && r.best.q2 > r.null.high + 0.1 ? 'The real fit is clearly above that.' : 'The real fit is not clearly above that, so treat it as unproven.'}</p>` : ''}
      ${gpLost ? `<div class="note">The ${esc(r.results.find((x) => x.key === r.best.key).label.toLowerCase())} predicts this response better than the Gaussian process here (Q² ${fmt(r.best.q2, 2)} against ${fmt(r.gpQ2, 2)}), which usually means the surface is simple enough that a polynomial captures it. The suggestions still come from the Gaussian process, because it is the only one of the two that reports how sure it is, and a suggestion without an error bar is a guess.</div>` : ''}
      ${r.n < (report.space.length || 1) * 5 ? `<div class="note">Fewer than five runs per factor. ${info('overfit')} A flexible model will follow the noise here, which is why the comparison above is against runs it has not seen rather than the ones it was fitted to.</div>` : ''}
      ${r.ofat ? '<div class="note warn">These runs look like one-factor-at-a-time: each changes a single setting from the one before. That pattern cannot separate interactions between factors, so any interaction the model reports is an artefact of the design, not a finding. A few runs that move two factors at once would fix this.</div>' : ''}
      <div class="grid g2"><div>${cmp}</div><div>${fitPlot(r)}</div></div></div>`;
  }).join('');
  return `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="flex:1">Does the model know anything ${info('q2')}</h2>
      <label for="strategy" style="margin:0">Held out</label>
      <select id="strategy" name="strategy" style="width:auto">${Object.entries(SPLITS).filter(([k, v]) => !v.biology || k === state.strategy || report.goals.some((g) => g.biology)).map(([k, v]) => `<option value="${k}" ${state.strategy === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>
    <p class="muted">${esc(SPLITS[report.strategy].note)} ${info('splits')} Q² is R² measured on runs the model never saw; the in-sample R² of a flexible model is close to 1 by construction and would tell you nothing.</p>
    ${blocks}`;
}

/** Measured against predicted, for held-out runs only: the plot that shows whether Q² is real or lucky. */
function fitPlot(r) {
  const pred = r.foldPredictions || [];
  const pairs = pred.map((p, i) => ({ p, i })).filter((x) => x.p != null && Number.isFinite(r.measured?.[x.i]));
  if (pairs.length < 3) return '<p class="muted">Too few held-out predictions to plot.</p>';
  const xs = pairs.map((x) => x.p), ys = pairs.map((x) => r.measured[x.i]);
  const lo = Math.min(...xs, ...ys), hi = Math.max(...xs, ...ys), pad = (hi - lo) * 0.1 || 1;
  const W = 300, H = 220, L = 46, B = 34, T = 10, R = 10;
  const sx = (v) => L + ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * (W - L - R);
  const sy = (v) => T + (1 - (v - (lo - pad)) / ((hi + pad) - (lo - pad))) * (H - T - B);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="measured versus predicted for ${esc(r.label || r.name)}" style="width:100%;max-width:320px;height:auto">
    <line x1="${sx(lo - pad)}" y1="${sy(lo - pad)}" x2="${sx(hi + pad)}" y2="${sy(hi + pad)}" class="mn" stroke-dasharray="4 3"/>
    <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="ax"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="ax"/>
    ${pairs.map((x, i) => `<circle cx="${sx(xs[i]).toFixed(1)}" cy="${sy(ys[i]).toFixed(1)}" r="4" class="af" opacity=".75"><title>predicted ${fmt(xs[i], 2)}, measured ${fmt(ys[i], 2)}</title></circle>`).join('')}
    <text x="${(L + W - R) / 2}" y="${H - 6}" class="lb" text-anchor="middle">predicted</text>
    <text x="12" y="${(T + H - B) / 2}" class="lb" transform="rotate(-90 12 ${(T + H - B) / 2})" text-anchor="middle">measured</text></svg>`;
}

/* ---------------- what to run next: the answer, so it leads ---------------- */
function suggestionsCard(report, state, ref, env) {
  const s = report.suggestions;
  if (!s?.picks?.length) return '';
  // Cross-check every suggestion against the shelf and against the ground already covered. This edition
  // carries no model of the mixing hardware, so a setting far outside what has been run is flagged as
  // extrapolation rather than judged against the rig.
  let checks = [];
  try { checks = checkSuggestions(s.picks, { settings: env.settings, stocks: env.stocks, rows: report.rows, baseline: env.baseline }); } catch { checks = []; }
  const goals = report.suggestionGoals || report.goals;
  const anyPurpose = s.picks.some((p) => p.purpose === 'learn'); // only meaningful when the mode actually splits the batch
  // The lipid that takes up the rest is a column of its own: it is part of the recipe the bench weighs out, and
  // the one number that showed whether a suggestion could be made at all when the search did not yet know.
  const mx = report.mixture?.balance ? report.mixture : null;
  const anyWarn = checks.some((c) => c?.level === 'warn');
  // Why each run was placed where it is reads under the table, folded with the rest of how to read it: four
  // sentences in a column made this the longest card on the page (usability cycle 6, L1). A run flagged against
  // the rig or the shelf says so in the table itself.
  const head = ['#', ...(anyPurpose ? ['Placed to'] : []), ...report.space.map((f) => ({ label: `${f.name}${f.unit ? ` (${f.unit})` : ''}`, right: true })),
    ...(mx ? [{ label: `${mx.balanceName} (mol%, balance)`, right: true }] : []),
    ...goals.map((g) => ({ label: g.label || g.name, right: true })), { label: 'Beats best', right: true }, ...(anyWarn ? ['Check'] : [])];
  const body = s.picks.map((p, i) => ({ cells: [
    raw(`<b>${i + 1}</b>`),
    ...(anyPurpose ? [raw(chip(p.purpose === 'learn' ? 'learn' : 'win', p.purpose === 'learn' ? 'info' : 'ok'))] : []),
    ...report.space.map((f) => atStep(p.point[f.key], f)),
    ...(mx ? [raw(`<span data-balance="${mixtureAt(p.point, mx).balance}">${fmt(mixtureAt(p.point, mx).balance, 1)}</span>`)] : []),
    ...goals.map((g) => { const q = expected(p)[g.name]; return raw(q ? `${fmt(q.mean, g.name === 'PDI' ? 3 : 1)} <span class="muted">± ${fmt(1.96 * q.sd, g.name === 'PDI' ? 3 : 1)}</span>` : '–'); }),
    raw(`<span class="chip ${p.pBeatsBest > 0.5 ? 'ok' : p.pBeatsBest > 0.2 ? 'info' : ''}" style="white-space:nowrap">${pct(p.pBeatsBest)}</span>`),
    ...(anyWarn ? [raw(checks[i]?.level === 'warn' ? checks[i].notes.filter((x) => x.level === 'warn').map((x) => `<span class="chip warn">${esc(x.text)}</span>`).join(' ') : '')] : []),
  ] }));
  return `<div class="card" style="border-color:var(--c-ml)"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <h2 style="flex:1">What to run next ${info('bo')}</h2>
      <select name="mode" style="width:auto">${Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${state.mode === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
      <input type="number" name="q" min="1" max="12" step="1" value="${state.q}" style="width:68px" title="how many runs"> <span class="muted">runs</span></div>
    <p class="muted">${esc(MODES[state.mode].note)} ${info('explore')}.${mx ? ` Each suggestion keeps lipid mol% at 100 by adjusting ${esc(mx.balanceName.toLowerCase())}, which stays within ${molPct(mx.lo)}–${molPct(mx.hi)} mol%.` : ''}</p>
    ${table(head, body)}
    ${fold(state, 'reading', { title: 'Reading the table', cls: 'sub', frame: false,
      say: `why each run, what the ± means, and why no two runs sit close together`,
      body: `<ol class="muted" id="whyRuns">${s.picks.map((p) => `<li>${esc(p.rationale)}</li>`).join('')}</ol>
      <p class="muted">The ± is where 95 % of single batches made at that setting should land, by the model: its own uncertainty and the measurement scatter together, which is what each result will be held against. No two suggestions sit within 15 % of the searched range of each other on every factor, so the batch buys four answers rather than one answer four times.${mx ? ` ${molPct(mx.lo)}–${molPct(mx.hi)} mol% ${esc(mx.balanceName.toLowerCase())} is the band this module treats as ordinary.` : ''}</p>` })}
    ${anyWarn ? '<div class="note warn">The flagged runs sit outside the settings you have actually run, or need a lipid stock you do not have. The model has no data out there and this program carries no model of your mixing hardware, so check those settings against the rig before you make them, or narrow the search range.</div>' : ''}
    ${report.verdict?.stop ? '' : confirmNote(report, state)}
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button ${report.verdict?.stop ? '' : 'class="primary" '}id="makeExp" ${state.creating ? 'disabled' : ''}>Create an experiment from these ${s.picks.length} runs</button>
      <button id="exportCsv">Export CSV</button>
      <button id="reseed">Different proposals</button></div>
    ${report.optimum ? fold(state, 'optimum', { title: 'Where the model thinks the optimum is', cls: 'sub', frame: false,
      // Its setting is in the opening card's "Predicted optimum" tile; the line does not say it a second time.
      say: `score ${fmt(report.optimum.desirability, 2)}, with what the model expects of each response there; a prediction, not a plan`,
      body: `<p class="muted">Ignoring uncertainty, this is the best setting the fitted surface can find. It is a prediction, not a plan: it is often just outside what you have actually run, which is exactly where a model is least reliable. The suggestions above account for that; this does not.</p>
      ${table([...report.space.map((f) => ({ label: `${f.name}${f.unit ? ` (${f.unit})` : ''}`, right: true })), ...goals.map((g) => ({ label: g.label || g.name, right: true })), { label: 'Score', right: true }],
        [{ cells: [...report.space.map((f) => atStep(report.optimum.point[f.key], f)),
          ...goals.map((g) => { const q = report.optimum.predicted[g.name]; return raw(q ? `${fmt(q.mean, g.name === 'PDI' ? 3 : 1)} <span class="muted">± ${fmt(1.96 * q.sd, g.name === 'PDI' ? 3 : 1)}</span>` : '–'); }),
          fmt(report.optimum.desirability, 3)] }])}` }) : ''}</div>`;
}

/* ---------------- the map and the what-if box ---------------- */
/**
 * A contour of the overall score across two factors, with the runs already done, the suggestions, and the
 * model's optimum on top. One picture answers the questions a table cannot: is the good region a broad plateau
 * or a knife edge, have I been circling one corner, and is the optimiser proposing somewhere I have never been?
 */
function mapFold(report, state) {
  const gp = report.models.filter((m) => m.gp?.kind === 'gp');
  if (gp.length < 1 || report.space.length < 2) return '';
  const goals = report.suggestionGoals || report.goals;
  const a = Math.min(state.mapA ?? 0, report.space.length - 1);
  let b = Math.min(state.mapB ?? 1, report.space.length - 1);
  if (b === a) b = (a + 1) % report.space.length;
  // the other factors sit where the best run so far had them, not at the midpoint: a slice through a real recipe
  const best = report.scored?.[0];
  const base = report.space.map((f, i) => {
    if (i === a || i === b) return 0.5;
    const v = best?.point?.[f.key];
    return Number.isFinite(v) && f.hi > f.lo ? Math.max(0, Math.min(1, (v - f.lo) / (f.hi - f.lo))) : 0.5;
  });
  const n = 26;
  // Only the limits on responses that actually have a surface: a limit on an unmodelled response would make
  // every cell infeasible and blank the whole map, while the suggestions beside it ignored that same limit.
  const modelled = new Set(gp.map((m) => m.name));
  const limits = (report.constraints || []).filter((c) => modelled.has(c.name));
  const mx = report.mixture;
  const { grid } = desirabilityGrid(gp, report.space, a, b, goals.filter((g) => modelled.has(g.name)), { n, base, constraints: limits,
    feasible: mx ? (u) => mixtureAt(fromUnit(u, report.space), mx).ok : null });
  const anyUnmade = grid.some((row) => row.some((c) => !c.made));
  const fa = report.space[a], fb = report.space[b];
  const W = 460, H = 380, L = 56, B = 52, T = 14, R = 16;
  const px = (u) => L + u * (W - L - R), py = (u) => H - B - u * (H - T - B);
  const cw = (W - L - R) / (n - 1), chh = (H - T - B) / (n - 1);
  // One hue, lightness by score: readable in both themes and safe for colour-blind viewers. The gamma spreads
  // the top of the range, where a flat dark field would otherwise hide the difference between good and best.
  // A recipe that cannot be weighed out is drawn in the page's neutral grey, whatever the surface predicts there.
  const hi = Math.max(0.05, ...grid.flat().filter((c) => c.made).map((c) => c.D));
  const cell = (c) => (c.made ? `hsl(283 70% ${92 - Math.pow(Math.max(0, Math.min(1, c.D / hi)), 0.65) * 50}%)` : 'var(--bg2)');
  const cells = grid.map((row, i) => row.map((c, j) =>
    `<rect x="${(px(i / (n - 1)) - cw / 2).toFixed(1)}" y="${(py(j / (n - 1)) - chh / 2).toFixed(1)}" width="${(cw + 0.6).toFixed(1)}" height="${(chh + 0.6).toFixed(1)}" fill="${cell(c)}"/>`).join('')).join('');
  const dot = (p, cls, title, r = 4.5) => {
    const ua = (p[fa.key] - fa.lo) / (fa.hi - fa.lo), ub = (p[fb.key] - fb.lo) / (fb.hi - fb.lo);
    if (!Number.isFinite(ua) || !Number.isFinite(ub)) return '';
    return `<circle cx="${px(Math.max(0, Math.min(1, ua))).toFixed(1)}" cy="${py(Math.max(0, Math.min(1, ub))).toFixed(1)}" r="${r}" ${cls}><title>${esc(title)}</title></circle>`;
  };
  const runs = (report.scored || []).map((o) => dot(o.point, `fill="none" stroke="var(--ink)" stroke-width="1.6" opacity=".75"`, `${o.batchId}: score ${fmt(o.D, 3)}`, 4)).join('');
  const sugg = (report.suggestions?.picks || []).map((p, i) => dot(p.point, `fill="var(--accent)" stroke="#fff" stroke-width="1.5"`, `suggestion ${i + 1}`, 6)).join('');
  const opt = report.optimum ? dot(report.optimum.point, `fill="none" stroke="var(--warn-text)" stroke-width="2.5"`, 'model optimum', 8) : '';
  const fixed = report.space.filter((_, i) => i !== a && i !== b)
    .map((f) => { const i = report.space.indexOf(f); return `${f.name} ${atStep(f.lo + base[i] * (f.hi - f.lo), f)}`; }).join(' · ');
  // The folded line says where the slice peaks: the one thing the picture is usually opened to find out.
  let peak = null;
  grid.forEach((row, i) => row.forEach((c, j) => { if (c.made && (!peak || c.D > peak.D)) peak = { D: c.D, u: i / (n - 1), v: j / (n - 1) }; }));
  const at = (f, u) => `${esc(shortName(f))} ${atStep(f.lo + u * (f.hi - f.lo), f)}${f.unit ? ` ${esc(f.unit)}` : ''}`;
  const say = peak && peak.D > 0
    ? `the predicted score peaks at ${fmt(peak.D, 2)} near ${at(fa, peak.u)} and ${at(fb, peak.v)}${fixed ? ' (the other factors as in your best run)' : ''} · try a setting beside it`
    : `no setting on this slice of ${esc(shortName(fa))} against ${esc(shortName(fb))} scores above 0 · try a setting beside it`;
  return fold(state, 'map', { title: 'The map', say, body: `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="flex:1"></span>
      <select name="mapA" style="width:auto">${report.space.map((f, i) => `<option value="${i}" ${i === a ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>
      <span class="muted">against</span>
      <select name="mapB" style="width:auto">${report.space.map((f, i) => `<option value="${i}" ${i === b ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></div>
    <p class="muted">Predicted overall score across these two factors${fixed ? `, with the others held where your best run had them (${esc(fixed)})` : ''}. Darker is better. Open circles are runs you have done, filled circles are the suggestions${report.optimum ? ', the ring is where the model puts the optimum' : ''}.${anyUnmade ? ` Grey is ${mx.balance ? `where ${esc(mx.balanceName.toLowerCase())} would have to fall outside ${molPct(mx.lo)}–${molPct(mx.hi)} mol% to reach 100, the band the optimizer keeps its suggestions in` : 'where the lipids would not total 100 mol%: every class is varied, so none is left to take up the rest'}.` : ''} Where the map is pale there is nothing worth running; where your circles cluster, the model is guessing everywhere else. Every point is placed by these two factors alone, so a suggestion can sit on a pale patch because its other settings differ from this slice.</p>
    <div class="grid g2" style="align-items:start">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="predicted score across ${esc(fa.name)} and ${esc(fb.name)}" style="width:100%;max-width:${W}px;height:auto">
        ${cells}${runs}${sugg}${opt}
        <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="ax"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="ax"/>
        <text x="${L}" y="${H - B + 16}" class="lb">${atStep(fa.lo, fa)}</text><text x="${W - R}" y="${H - B + 16}" class="lb" text-anchor="end">${atStep(fa.hi, fa)}</text>
        <text x="${(L + W - R) / 2}" y="${H - 18}" class="lb" text-anchor="middle">${esc(fa.name)}${fa.unit ? ` (${esc(fa.unit)})` : ''}</text>
        <text x="${L - 8}" y="${H - B + 4}" class="lb" text-anchor="end">${atStep(fb.lo, fb)}</text><text x="${L - 8}" y="${T + 10}" class="lb" text-anchor="end">${atStep(fb.hi, fb)}</text>
        <text x="16" y="${(T + H - B) / 2}" class="lb" transform="rotate(-90 16 ${(T + H - B) / 2})" text-anchor="middle">${esc(fb.name)}${fb.unit ? ` (${esc(fb.unit)})` : ''}</text></svg>
      ${whatIf(report, state)}
    </div>` });
}

/** Type a setting in, read the prediction out. The question everyone asks a model first. */
function whatIf(report, state) {
  const gp = report.models.filter((m) => m.gp?.kind === 'gp');
  const point = {};
  const best = report.scored?.[0];
  for (const f of report.space) {
    const v = state.whatIf?.[f.key];
    point[f.key] = Number.isFinite(v) ? v : Number.isFinite(best?.point?.[f.key]) ? best.point[f.key] : (f.lo + f.hi) / 2;
  }
  const pred = predictAt(gp, report.space, point);
  const goals = report.suggestionGoals || report.goals;
  const vals = pred ? Object.fromEntries(Object.entries(pred).map(([k, q]) => [k, q.mean])) : {};
  const D = pred ? overallDesirability(vals, goals) : null;
  const outside = report.space.filter((f) => {
    const obs = report.rows.map((r) => r.factors[f.key]).filter(Number.isFinite);
    return obs.length && (point[f.key] < Math.min(...obs) || point[f.key] > Math.max(...obs));
  });
  return `<div><h2 style="font-size:14px">Try a setting</h2>
    <div class="grid g2" id="whatIfForm">${report.space.map((f) => field({ id: `wi_${f.key}`, label: `${f.name}${f.unit ? ` (${f.unit})` : ''}`, value: stepValue(point[f.key], f), step: f.step })).join('')}</div>
    ${pred ? `<div style="margin-top:10px">${table(['Response', { label: 'Predicted', right: true }, { label: '95 % interval', right: true }],
      goals.map((g) => { const q = pred[g.name]; const dg = q ? ` · score ${fmt(desirabilityOf(q.mean, g), 2)}` : '';
        return { cells: [raw(`${esc(g.label || g.name)}<span class="muted">${dg}</span>`), q ? fmt(q.mean, g.name === 'PDI' ? 3 : 1) : '–',
          q ? raw(`<span class="muted">${fmt(q.mean - 1.96 * q.sd, g.name === 'PDI' ? 3 : 1)} … ${fmt(q.mean + 1.96 * q.sd, g.name === 'PDI' ? 3 : 1)}</span>`) : '–'] }; }))}
      <p>Overall score <b>${fmt(D.D, 3)}</b>${report.scored?.length ? ` · best run so far ${fmt(report.scored[0].D, 3)}` : ''}</p>
      ${outside.length ? `<div class="note warn">${outside.map((f) => esc(f.name)).join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside anything you have actually run, so this is extrapolation. The interval widens but it cannot know what it has never seen.</div>` : ''}
      ${mixNote(point, report.mixture)}</div>`
      : '<p class="muted">No fitted surface yet.</p>'}</div>`;
}
const desirabilityOf = (y, g) => { try { return desirability(y, g); } catch { return NaN; } };

/**
 * A typed setting is predicted whatever its recipe, so the box says when there is none: a lipid below 0, or a
 * total that cannot reach 100. A recipe outside the ordinary band is unusual, not impossible, and is called
 * that, as pointToPlan calls it when a batch is made.
 */
function mixNote(point, mx) {
  const at = mixtureAt(point, mx);
  if (!mx || at.ok) return '';
  const name = mx.balanceName?.toLowerCase();
  if (canWeighOut(point, mx)) {
    return `<div class="note" id="mixNote">${esc(`An unusual recipe: ${name} would have to be ${molPct(at.balance)} mol% to reach 100, outside the ${molPct(mx.lo)}–${molPct(mx.hi)} mol% this module treats as ordinary. That is a formulation, just not a common one, and not one the optimizer proposes.`)}</div>`;
  }
  const text = !mx.balance ? mx.reason
    : at.balance == null ? 'This recipe cannot be weighed out: a lipid in it would be below 0 mol%. The prediction above is for a formulation that does not exist.'
      : `This recipe cannot be weighed out: ${name} would have to be ${molPct(at.balance)} mol% to reach 100. The prediction above is for a formulation that does not exist.`;
  return `<div class="note warn" id="mixNote">${esc(text)}</div>`;
}

/* ---------------- 5. drivers ---------------- */
function driversFold(report, state) {
  const withModel = report.responses.filter((r) => r.importance?.length && r.best);
  if (!withModel.length) return '';
  // The folded line names, per response, the factors that carry most of it: the top ones until they cover
  // three fifths of the share, two at most, which is as far as shuffle importances deserve to be read.
  const lead = (r) => {
    const top = [...r.importance].sort((x, y) => y.share - x.share);
    const out = [];
    let sum = 0;
    for (const x of top) { if (out.length === 2 || (out.length && sum >= 0.6)) break; out.push(x); sum += x.share; }
    return `${esc(r.label || r.name)} mostly ${out.map((x) => `${esc(shortName(x))} (${pct(x.share)})`).join(' and ')}`;
  };
  const say = `${withModel.map(lead).join(' · ')} — associations in your runs, not causes`;
  const blocks = withModel.map((r) => {
    const max = Math.max(...r.importance.map((x) => x.importance), 1e-9);
    // When the surface has reverted to its prior the lengthscales are noise, so the column that reads them
    // is withheld rather than printed as if it meant something.
    const gone = r.collapse?.collapsed;
    const bars = table(['Factor', { label: 'Share', right: true }, '', 'Lengthscale check'],
      r.importance.map((x) => {
        const ard = r.ard?.find((a) => a.key === x.key);
        return { cells: [x.name, pct(x.share),
          raw(`<div style="height:8px;width:${Math.max(2, (x.importance / max) * 130)}px;background:var(--c-ml);border-radius:4px" title="drop in accuracy when this factor is shuffled"></div>`),
          raw(gone ? '<span class="muted">n/a</span>' : ard ? `<span class="muted">${pct(ard.share)}</span>` : '<span class="muted">–</span>')] };
      }));
    return `<div><h2 style="font-size:14px">${esc(r.label || r.name)}</h2>${bars}${gone
      ? `<div class="note warn" style="margin-top:6px">The surface for this response has fallen back on its prior, so its lengthscales say nothing and the check above is withheld. The shares on the left come from shuffling factors in the data and still stand.</div>` : ''}</div>`;
  }).join('');
  const pdResp = withModel[0];
  const dim = Math.min(state.pdDim || 0, report.space.length - 1);
  return fold(state, 'drivers', { title: `What drives what ${info('attribution')}`, say, body: `
    <div class="note">These are associations in the runs you did, not causes. A factor can look unimportant because it never varied much, and two factors that were changed together will split the credit between them arbitrarily. Use this to decide what to vary next, not to explain a mechanism.</div>
    <div class="grid g2" style="margin-top:10px">${blocks}</div>
    <div style="margin-top:14px"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="font-size:14px;flex:1">How ${esc(pdResp.label || pdResp.name)} moves with one factor</h2>
      <select name="pdDim" style="width:auto">${report.space.map((f, i) => `<option value="${i}" ${i === dim ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></div>
      ${pdPlot(report, pdResp, dim)}</div>` });
}

function pdPlot(report, r, dim) {
  const model = report.models.find((m) => m.name === r.name);
  if (!model?.gp || !model.X) return '<p class="muted">No fitted surface for this response.</p>';
  const pts = partialDependence(model.gp, model.X, report.space, dim, { n: 36 })
    .map((p) => ({ ...p, mean: p.mean * model.ySd + model.yMean, sd: p.sd != null ? p.sd * model.ySd : null }));
  const f = report.space[dim];
  const los = pts.map((p) => p.mean - 1.96 * (p.sd || 0)), his = pts.map((p) => p.mean + 1.96 * (p.sd || 0));
  const lo = Math.min(...los), hi = Math.max(...his), pad = (hi - lo) * 0.08 || 1;
  const W = 620, H = 220, L = 54, B = 36, T = 12, R = 14;
  const sx = (u) => L + u * (W - L - R);
  const sy = (v) => T + (1 - (v - (lo - pad)) / ((hi + pad) - (lo - pad))) * (H - T - B);
  const band = `${pts.map((p, i) => `${sx(p.u).toFixed(1)},${sy(his[i]).toFixed(1)}`).join(' ')} ${pts.slice().reverse().map((p, i) => `${sx(p.u).toFixed(1)},${sy(los[pts.length - 1 - i]).toFixed(1)}`).join(' ')}`;
  const obs = report.rows.map((row) => row.factors[f.key]).filter(Number.isFinite);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="partial dependence of ${esc(r.label || r.name)} on ${esc(f.name)}" style="width:100%;height:auto">
    <polygon points="${band}" fill="var(--c-ml)" opacity=".13"/>
    <polyline points="${pts.map((p) => `${sx(p.u).toFixed(1)},${sy(p.mean).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--c-ml)" stroke-width="2"/>
    <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="ax"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="ax"/>
    ${obs.map((v) => `<line x1="${sx((v - f.lo) / (f.hi - f.lo)).toFixed(1)}" y1="${H - B}" x2="${sx((v - f.lo) / (f.hi - f.lo)).toFixed(1)}" y2="${H - B - 6}" class="mn" opacity=".6"/>`).join('')}
    <text x="${L}" y="${H - 6}" class="lb">${atStep(f.lo, f)}</text><text x="${W - R}" y="${H - 6}" class="lb" text-anchor="end">${atStep(f.hi, f)}</text>
    <text x="${(L + W - R) / 2}" y="${H - 6}" class="lb" text-anchor="middle">${esc(f.name)}${f.unit ? ` (${esc(f.unit)})` : ''} — ticks mark the settings you have run</text>
    <text x="${L - 6}" y="${sy(hi) + 4}" class="lb" text-anchor="end">${sigfig(hi, 3, { maxDp: 3 })}</text><text x="${L - 6}" y="${sy(lo) + 4}" class="lb" text-anchor="end">${sigfig(lo, 3, { maxDp: 3 })}</text></svg>`;
}

/* ---------------- 6. the data behind it ---------------- */
/** Is the module earning the batches it costs? Shown rather than assumed. */
function progressFold(report, state) {
  const p = report.progress;
  if (!p || p.points.length < 4) return '';
  const record = p.points[p.points.length - 1].best;
  const say = p.suggestedRuns === 0
    ? `best score ${fmt(record, 2)} after ${p.points.length} runs; none came from the optimizer yet, so there is nothing to compare`
    : p.improvedBySuggested != null && p.improvedByOwn != null
      ? `${pct(p.improvedBySuggested)} of the ${p.suggestedRuns} suggested runs set a new best, against ${pct(p.improvedByOwn)} of yours: ${p.improvedBySuggested > p.improvedByOwn ? 'they are earning their place' : 'not yet better than your own choices'}`
      : `best score ${fmt(record, 2)}; ${p.suggestedRuns} suggested run${p.suggestedRuns === 1 ? '' : 's'} so far, too few of your own to compare`;
  const W = 620, H = 180, L = 46, B = 34, T = 12, R = 14;
  const n = p.points.length;
  const sx = (i) => L + (n > 1 ? i / (n - 1) : 0.5) * (W - L - R);
  const sy = (d) => T + (1 - d) * (H - T - B);
  const line = p.points.map((q, i) => `${sx(i).toFixed(1)},${sy(q.best).toFixed(1)}`).join(' ');
  const verdictLine = p.suggestedRuns === 0
    ? 'No run here came from the optimizer yet, so there is nothing to compare. Once a suggested batch has results, this chart says whether the suggestions were the ones that moved the record.'
    : p.improvedBySuggested != null && p.improvedByOwn != null
      ? `${pct(p.improvedBySuggested)} of the ${p.suggestedRuns} suggested runs set a new best, against ${pct(p.improvedByOwn)} of the ${p.ownRuns} you chose yourself. ${p.improvedBySuggested > p.improvedByOwn ? 'On this record the suggestions are earning their place.' : 'On this record they are not yet beating your own choices, which is worth knowing before you spend more batches on them.'}`
      : `${p.suggestedRuns} suggested run${p.suggestedRuns === 1 ? '' : 's'} so far; too few of your own runs to compare against.`;
  return fold(state, 'progress', { title: 'Is this worth the batches?', say, body: `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="best score over time" style="width:100%;height:auto">
      <polyline points="${line}" fill="none" stroke="var(--c-ml)" stroke-width="2"/>
      ${p.points.map((q, i) => `<circle cx="${sx(i).toFixed(1)}" cy="${sy(q.D).toFixed(1)}" r="${q.suggested ? 4.5 : 3}" fill="${q.suggested ? 'var(--c-ml)' : 'var(--ink2)'}" opacity="${q.improved ? 1 : 0.45}"><title>${esc(q.batchId)}: score ${fmt(q.D, 3)}${q.suggested ? ' (suggested)' : ''}</title></circle>`).join('')}
      <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="ax"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="ax"/>
      <text x="${L - 6}" y="${sy(1) + 4}" class="lb" text-anchor="end">1.0</text><text x="${L - 6}" y="${sy(0) + 4}" class="lb" text-anchor="end">0</text>
      <text x="${(L + W - R) / 2}" y="${H - 6}" class="lb" text-anchor="middle">runs in order — the line is the best score so far, filled dots are runs the optimizer proposed</text></svg>
    <p class="muted">${esc(verdictLine)}</p>` });
}

function dataFold(report, state) {
  const g = report.goals;
  if (!report.scored?.length) return '';
  const best = report.scored[0];
  const rows = report.scored.slice(0, 14).map((o) => ({ cells: [
    raw(`<a href="#/formulation?batch=${esc(o.batchId)}"><b>${esc(o.batchId)}</b></a> <span class="muted">${esc(o.label || '')}</span>`),
    ...report.space.map((f) => atStep(o.point[f.key], f)),
    ...g.map((x) => fmt(o.values[x.name], x.name === 'PDI' ? 3 : 1)),
    raw(`<b>${fmt(o.D, 3)}</b>`),
    raw(report.pareto.some((p) => p.batchId === o.batchId) ? chip('on the front', 'ok') : ''),
  ] }));
  return fold(state, 'data', { title: 'The runs behind all of this', cls: 'advanced',
    say: `${report.scored.length} runs ranked by overall score, best ${esc(best.batchId)} at ${fmt(best.D, 2)}; ${report.pareto.length} on the Pareto front`, body: `
    <p class="muted">Ranked by overall score. "On the front" ${info('pareto')} marks a run that nothing else beats on every goal at once, which is the honest way to look at a trade-off before the weights are applied.</p>
    ${table(['Formulation', ...report.space.map((f) => ({ label: f.name, right: true })), ...g.map((x) => ({ label: x.label || x.name, right: true })), { label: 'Score', right: true }, ''], rows)}
    ${report.replicates
      ? `<p class="muted">${report.replicates} repeated setting${report.replicates === 1 ? '' : 's'} found; their scatter is evidence of the noise floor used above, not a fixed value, and it counts for as many degrees of freedom as it has: a setting run twice gives one, run three times gives two. Two batches that happen to agree say little about how far the next two may differ, so a couple of repeats barely lower the noise; ones that differ widely raise it.</p>`
      : '<p class="muted">No repeated settings yet. Repeating a setting pins down how much of the scatter is measurement noise, which makes every quality figure above more meaningful. Two different settings run twice each are worth more than one setting run three times: the degrees of freedom add up and the estimate stops depending on one recipe.</p>'}` });
}

function methodText() {
  return `<p class="muted">Each response is modelled on its own with a Gaussian process (Matérn 5/2 kernel, one lengthscale per factor,
    hyperparameters fitted by maximising the marginal likelihood under weakly informative priors). A quadratic response surface, a
    linear model and a predict-the-average baseline are fitted alongside it and cross-validated on the same held-out groups; the one
    with the best Q² is reported. Suggestions maximise expected improvement in overall desirability, estimated by sampling each
    response from its posterior, with several runs chosen greedily under the kriging-believer rule so a batch spreads out instead of
    repeating itself. Hard limits enter as a probability of feasibility. Everything is deterministic given the seed, so a suggestion
    can be reproduced later. See <code>docs/ML.md</code> for the reasoning and sources.</p>`;
}

/* ---------------- events ---------------- */
function wire(el, ctx, ref, settings, state, report, h) {
  const root = el.querySelector('#mlRoot') || el;
  el.querySelector('#runBtn')?.addEventListener('click', async () => {
    // A fresh run is a request for the answer, so the setup folds away again even if it was opened to edit;
    // the other sections stay as the user left them.
    delete state.open.setup;
    h.setRunning(true); h.draw();
    await new Promise((r) => setTimeout(r, 30)); // let the disabled button paint before the blocking fit
    try { h.compute(); } catch (e) { toast('Model fit failed: ' + e.message, 'warn'); }
    h.setRunning(false); h.persist(); h.draw();
  });
  root.querySelector('#autoSpace')?.addEventListener('click', () => {
    const s = suggestSpace(h.measured);
    if (!s.length) { toast('No factor varies enough across your batches yet', 'warn'); return; }
    state.space = s; h.persist(); h.draw(); toast(`${s.length} factor${s.length === 1 ? '' : 's'} taken from your data`, 'ok');
  });
  // The three buttons that create an experiment are disabled while one is being written, and drawn so by any
  // redraw meanwhile (state.creating). Returns whether this visit to the optimizer is still the one showing.
  const busy = (on) => {
    state.creating = on;
    if (!h.shown()) return false;
    el.querySelectorAll('#makeExp, #seedBtn, #addConfirm').forEach((b) => { b.disabled = on; });
    return true;
  };
  root.querySelector('#seedBtn')?.addEventListener('click', (e) => {
    if (!state.space.length) { toast('Choose at least one factor first', 'warn'); return; }
    const n = Number(e.currentTarget.dataset.n) || 8; // exactly the number the button offered
    const mixture = mixtureLimits(state.space, classPercents(baseComposition(ref, state), ref));
    if (mixture && !mixture.room) { toast(mixture.reason, 'warn'); return; }
    const pts = startingDesign(state.space, n, state.seed, mixture);
    createExperiment(ctx, ref, settings, state, pts.map((p) => ({ point: p })), 'Starting design (ML)', 'A spread-out set of runs so the optimiser has something to learn from.', busy);
  });
  root.querySelector('#reseed')?.addEventListener('click', () => { state.seed = (state.seed * 7 + 13) % 100000; h.rescore(); h.persist(); h.draw(); });
  root.querySelector('#makeExp')?.addEventListener('click', () => {
    createExperiment(ctx, ref, settings, state, report.suggestions.picks, `ML round ${roundNumber(ctx)}`, `Proposed by the ML optimizer (${MODES[state.mode].label.toLowerCase()}, seed ${state.seed}).`, busy, report.fingerprint);
  });
  root.querySelector('#addConfirm')?.addEventListener('click', () => {
    const c = report.suggestions.confirm;
    // One formulation per batch the note counted: the optimum made twice is two formulations of one recipe.
    const picks = c.runs.flatMap((r) => Array.from({ length: r.copies }, (_, k) => ({ point: r.point, predicted: r.predicted, forecast: r.forecast, purpose: 'confirm',
      label: r.kind === 'optimum' ? `predicted optimum${r.copies > 1 ? ` ${k + 1}` : ''}` : `repeat of ${r.batchId}`,
      rationale: r.kind === 'optimum' ? 'the predicted optimum, made to see whether it holds what the model promises'
        : `repeat of ${r.batchId}${r.kind === 'pick' ? ", the model's pick," : ''} to confirm it was not a lucky measurement` })));
    const pickRun = c.runs.find((r) => r.kind !== 'optimum');
    const name = pickRun && c.runs.length === 1 ? `Confirm ${pickRun.batchId}` : pickRun ? `Confirm ${pickRun.batchId} and the optimum` : 'Confirm the predicted optimum';
    createExperiment(ctx, ref, settings, state, picks, name, c.reason, busy, report.fingerprint);
  });
  root.querySelector('#exportCsv')?.addEventListener('click', () => {
    const head = ['run', ...report.space.map((f) => f.key), ...report.goals.flatMap((g) => [`${g.name}_predicted`, `${g.name}_sd`]), 'p_beats_best', 'expected_desirability'];
    const lines = [head.join(',')];
    report.suggestions.picks.forEach((p, i) => lines.push([i + 1, ...report.space.map((f) => p.point[f.key]),
      ...report.goals.flatMap((g) => [expected(p)[g.name]?.mean ?? '', expected(p)[g.name]?.sd ?? '']), p.pBeatsBest, p.expectedDesirability].join(',')));
    // In the macOS app the file goes through a save dialog, and download() returns a promise of the path, or of
    // null when the dialog is cancelled; the toast waits for it, so a cancelled export does not say "exported".
    Promise.resolve(download(`ml-suggestions-${todayISO()}.csv`, lines.join('\n') + '\n', 'text/csv'))
      .then((path) => path && toast('Suggestions exported', 'ok'));
  });
  // Reproduce (spec 7.5): the run on screen, or a stored round, made again from its fingerprint on today's records.
  root.querySelectorAll('[data-repro]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.repro;
    const fp = id === 'current' ? report?.fingerprint : ctx.store.get('experiments', id)?.design?.ml?.fingerprint;
    const out = id === 'current' ? root.querySelector('#reproduceOut') : root.querySelector(`[data-repro-out="${CSS.escape(id)}"]`);
    if (!fp || !out) return;
    b.disabled = true; out.textContent = 'Fitting again…';
    setTimeout(() => {
      let res;
      try { res = reproduce(fp, h.allRows, { lipidByKey: ref.lipidByKey, appVersion }); } catch (err) { res = { match: false, sentence: `Could not refit: ${err.message}` }; }
      out.textContent = res.sentence; out.style.color = res.match ? 'var(--ok-text)' : 'var(--warn-text)'; out.dataset.match = res.match ? '1' : '0';
      b.disabled = false;
    }, 30);
  }));
  const currentSel = () => { const p = h.prepNow(); return report?.selection || p.sels[p.tries[0]]; };
  const wireCsv = () => root.querySelector('#accountCsv')?.addEventListener('click', () => download(`ml-data-account-${todayISO()}.csv`, accountCsv(currentSel()), 'text/csv'));
  wireCsv();
  // The per-formulation list is drawn on first opening (mlpanel.js whyFold).
  root.querySelector('#whyFold')?.addEventListener('toggle', (e) => {
    const body = root.querySelector('#whyBody');
    if (!e.currentTarget.open || !body || body.childElementCount) return;
    body.innerHTML = whyTable(currentSel(), ref);
    wireCsv();
  });
  root.querySelector('#addConstraint')?.addEventListener('click', () => { state.constraints.push({ name: 'particle_size_nm', op: '<', value: 150, on: true }); h.persist(); h.draw(); });
  // Only a click on a fold's line is recorded, never its default: the click runs before the details toggles,
  // so the state it is about to take is the opposite of now. A click on a control in the line (the "?" beside
  // a heading) does not toggle anything, because that control's own handler cancels it, so it is not recorded.
  root.querySelectorAll('details[data-fold] > summary').forEach((s) => s.addEventListener('click', (e) => {
    if (e.target.closest('button, a, select, input')) return;
    state.open[s.parentElement.dataset.fold] = !s.parentElement.open;
  }));

  // The count in the header opens the Data used card and brings it into view: where those numbers come from.
  el.querySelector('#mlSourceChip')?.addEventListener('click', () => {
    const d = root.querySelector('#sourceFold');
    if (!d) return;
    d.open = true; state.open.source = true;
    d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  root.querySelector('#mlUseAll')?.addEventListener('click', () => { h.setExcluded([]); h.persist(); h.draw(); toast('Every experiment is used again', 'ok'); });
  root.addEventListener('change', (e) => {
    const t = e.target, n = t.name;
    if (!n) return;
    // An experiment switched on or off on the Data used card: a different data set, so any fit is gone.
    const xm = n.match(/^x_exp_(.*)$/);
    if (xm) {
      const id = xm[1] === '_none' ? '' : xm[1];
      h.setExcluded(t.checked ? state.excluded.filter((x) => x !== id) : [...state.excluded, id]);
      h.persist(); h.draw();
      return;
    }
    const v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? (t.value === '' ? null : Number(t.value)) : t.value;
    let redraw = false, recompute = false;
    let m;
    let refit = false;
    if ((m = n.match(/^g_(on|goal|target|lo|hi|best|worst|weight)_(\d+)$/))) { state.goals[+m[2]][m[1]] = v; redraw = true; recompute = !!report; refit = m[1] === 'on'; }
    else if ((m = n.match(/^c_(on|name|op|value)_(\d+)$/))) { state.constraints[+m[2]][m[1]] = v; redraw = true; recompute = !!report; }
    else if ((m = n.match(/^s_on_(.+)$/))) {
      const key = m[1];
      if (v) { const f = ALL_FACTORS.find((x) => x.key === key); const obs = h.measured.map((r) => r.factors[key]).filter(Number.isFinite);
        const lo = obs.length ? Math.max(f.lo, Math.min(...obs)) : f.lo, hi = obs.length ? Math.min(f.hi, Math.max(...obs)) : f.hi;
        state.space = [...state.space, { key, name: f.name, unit: f.unit, step: f.step, lo: lo === hi ? f.lo : lo, hi: lo === hi ? f.hi : hi }]
          .sort((a, b) => ALL_FACTORS.findIndex((x) => x.key === a.key) - ALL_FACTORS.findIndex((x) => x.key === b.key));
      } else state.space = state.space.filter((s) => s.key !== key);
      h.invalidate(); report = null; redraw = true;
    }
    else if ((m = n.match(/^s_(lo|hi)_(.+)$/))) { const s = state.space.find((x) => x.key === m[2]); if (s) s[m[1]] = v; recompute = !!report; refit = true; redraw = true; }
    else if (n === 'sel_combo') {
      // Another lipid or mixer is another data basis, so the fit and its fingerprint no longer apply.
      const [l, mx] = String(v).split('|');
      state.lipid = l === '*' ? null : l; state.mixer = mx === '*' ? null : mx; state.comboChosen = true;
      h.invalidate(); report = null; redraw = true;
    }
    else if (n === 'lipidMode') { state.lipidMode = v; h.invalidate(); report = null; redraw = true; }
    else if (n === 'strategy') { state.strategy = v; recompute = !!report; refit = true; redraw = true; }
    else if (n === 'mode') { state.mode = v; recompute = !!report; redraw = true; }
    else if (n === 'q') { state.q = Math.max(1, Math.min(12, v || 4)); recompute = !!report; redraw = true; }
    else if (n === 'pdDim') { state.pdDim = Number(v); redraw = true; }
    else if (n === 'mapA') { state.mapA = Number(v); redraw = true; }
    else if (n === 'mapB') { state.mapB = Number(v); redraw = true; }
    else if ((m = n.match(/^wi_(.+)$/))) { state.whatIf = { ...state.whatIf, [m[1]]: v }; redraw = true; }
    if (recompute) { try { (refit ? h.compute : h.rescore)(); } catch (err) { toast('Model fit failed: ' + err.message, 'warn'); } }
    if (redraw) { h.persist(); h.draw(); }
  });
}

const roundNumber = (ctx) => ctx.store.all('experiments').filter((e) => /^ML round/.test(e.name || '')).length + 1;

/**
 * Turn suggested settings into a real experiment with real batches: the loop closes here.
 *
 * A suggestion that changes the lipid composition becomes a real entry in the composition registry, not a note
 * on the batch. The batch record the operator follows, the weigh-in calculator and the lot number all resolve
 * the composition by its id, so a suggestion recorded only as an override would be invisible to every one of
 * them: the operator would make the registry recipe, and the model would later train on a composition that was
 * never produced.
 */
function createExperiment(ctx, ref, settings, state, picks, name, note, busy, fingerprint = null) {
  if (state.creating) return; // one is being written already; a second would be a second round of the same runs
  // The same after leaving the optimizer and coming back while the write is pending: that visit's buttons are
  // drawn enabled, but the round is the same one (usability cycle 6, W6).
  if (storingRound) { toast(`${describeId(storingRound)} is still being stored; it is listed under Experiments once it is.`, 'warn'); return; }
  // Registry order, so a suggested batch is based on the same formulation the wizard offers. Reversed, this
  // silently based every ML run on whichever entry happened to be numbered highest.
  const base = baseComposition(ref, state);
  // Never a number used before: not a deleted experiment's, nor one its results still name (see usedIds).
  const id = nextExperimentId(usedIds(ctx.store, 'experiment'));
  const nextFormulation = makeFormulationAllocator(id, usedIds(ctx.store, 'formulation'));
  const perDay = settings.batchesPerDay || 4;
  const spec = { type: 'single', name, startDate: todayISO(), tests: ['dls', 'ee'], batchesPerDay: perDay };
  const batches = [], warnings = new Set(), newComps = [];
  let nextCompId = Math.max(0, ...ref.compositions.map((c) => c.id)) + 1;

  picks.forEach((p, i) => {
    let plan, composition, w = [];
    try { ({ plan, composition, warnings: w } = pointToPlan(p.point, state.space, { baseComposition: base, ref })); }
    catch (err) { warnings.add({ level: 'impossible', text: err.message }); return; }
    w.forEach((x) => warnings.add(typeof x === 'string' ? { level: 'unusual', text: x } : x));

    // Resolve the composition: reuse the parent when nothing moved, an existing registry entry when one
    // matches, and otherwise register a new one so the recipe exists where the rest of the app looks for it.
    let compositionId = base?.id ?? null;
    if (composition) {
      const built = compositionFromClasses(base, composition, ref);
      if (built) {
        const match = [...ref.compositions, ...newComps].find((c) => sameComposition(c, built));
        if (match) compositionId = match.id;
        else {
          const rec = { id: nextCompId++, synonym: `${name} · from #${base?.id ?? '?'}`, mol_pct: built.mol_pct, sum: built.sum, source: 'ml' };
          newComps.push(rec);
          compositionId = rec.id;
        }
      }
    }

    const b = buildExperiment({ ...spec, compositionId, name: `${name} run ${i + 1}`,
      frr: plan.frr, totalFlow: plan.tfr, quenchFactor: plan.quench, lipidStock_mM: plan.lipid_mM, working_mg_mL: plan.rna_mg_mL },
      { settings, experimentId: id, nextFormulation }).batches[0];
    b.label = p.label || `suggestion ${i + 1}`;
    b.plannedDate = productionDate(spec.startDate, batches.length, perDay); // one buildExperiment per pick cannot spread them itself
    b.plan.factors = { ...p.point };
    if (plan.np != null) b.plan.rna.np = plan.np;
    // The aqueous-phase factors live with the other process details (variables.js), where the form reads them.
    for (const k of ['loadingPH', 'bufferMolarity_mM']) if (plan[k] != null) b.plan.process = { ...(b.plan.process || {}), [k]: plan[k] };
    if (composition) b.plan.compositionOverride = composition;
    // The prediction kept with the batch is what one batch there should measure, with `noise` the measurement
    // scatter in it (expected(), above), so the result is held against the interval it can be expected to fall in.
    const pred = p.forecast || p.predicted;
    b.ml = { suggestedAt: todayISO(), mode: state.mode, seed: state.seed, rationale: p.rationale || '', purpose: p.purpose || null,
      predicted: pred ? Object.fromEntries(Object.entries(pred).map(([k, q]) => [k, { mean: q.mean, sd: q.sd, ...(Number.isFinite(q.noise) ? { noise: q.noise } : {}) }])) : null,
      pBeatsBest: p.pBeatsBest ?? null, ...(fingerprint ? { fingerprint: fingerprint.hash } : {}) };
    batches.push(b);
  });

  const notes = [...warnings];
  if (!batches.length) { toast(notes.length ? notes[0].text : 'Nothing could be turned into a batch', 'warn'); return; }
  // A recipe that cannot be formulated as stated must not be written as if it could, not even on request:
  // accepting the old "create anyway?" stored a helper lipid at −13.9 mol%. The search keeps its suggestions
  // inside the mixture, so this only catches a setting from elsewhere. One that is merely unusual is the
  // user's call to make, and a toast is enough.
  const blocking = notes.filter((x) => x.level === 'impossible');
  if (blocking.length) { toast(`Not created: ${blocking[0].text}`, 'warn'); return; }

  const expected = [];
  for (const b of batches) {
    const due = nextWorkdayISO(addDaysISO(b.plannedDate, 1));
    for (const t of spec.tests) expected.push({ id: `${b.id}_final_${t}`, batchId: b.id, stage: 'final', test: t, dueDate: due, status: 'open', measurementId: null, sampleName: `${b.id}_final` });
  }
  const experiment = { id, type: 'single', name, startDate: todayISO(), compositionId: batches[0].compositionId, status: 'planned',
    spec, design: { ml: { space: state.space, goals: state.goals.filter((g) => g.on !== false), mode: state.mode, seed: state.seed, note, newCompositions: newComps.map((c) => c.id),
      ...(fingerprint ? { fingerprint } : {}) } },
    batchIds: batches.map((b) => b.id), expected, notes: note };
  // One write: compositions, formulations and the experiment are stored together or not at all. The screen
  // moves on once they are stored; if the browser refuses the write, the change is undone and the optimizer
  // stays where it is, its suggestions still there to turn into runs again (usability cycle 5, K4). Until one
  // or the other, the buttons that create stay disabled.
  busy(true);
  storingRound = id;
  ctx.store.transaction(() => {
    newComps.forEach((c) => ctx.store.put('compositions', c));
    batches.forEach((b) => ctx.store.put('batches', b));
    ctx.store.put('experiments', experiment);
    raiseCounter(ctx.store, 'experiment', id);
  }, { what: `${describeId(id)} with the suggested runs`, onUndone: () => { storingRound = null; return busy(false); }, onSaved: () => {
    storingRound = null;
    // The new experiment opens for a user still on this visit to the optimizer; one who has moved on is told.
    const here = busy(false);
    if (notes.length) toast(notes[0].text, 'warn');
    const said = `Created ${describeId(id)} with ${batches.length} formulation${batches.length === 1 ? '' : 's'}${newComps.length ? ` and ${newComps.length} new composition${newComps.length === 1 ? '' : 's'} (#${newComps.map((c) => c.id).join(', #')})` : ''}`;
    if (here) { toast(said, 'ok'); ctx.navigate('experiments', { id }); }
    else toast(said, 'ok', { action: 'Open', onAction: () => ctx.navigate('experiments', { id }) });
  } });
}
// The id of the round being stored, for every visit to the optimizer (state.creating is one visit's).
let storingRound = null;
