// Screen: Experiments — type-first wizard (new, or filled in from an earlier experiment), list, and detail
// view with overview card and the Results card.
import { html, raw, fmt, field, readForm, table, chip, toast, header, todayISO, fmtDate, kpi, download, esc, swapHtml, redrawSoon, readDraft, writeDraft, dropDraft, listDrafts, draftsStoring, uid, ask } from './kit.js';
import { experimentBioUses } from '../calc/usage.js';
import { getRef, getSettings, compositionLabel, lipidLabel } from '../refdata.js';
import { TYPES, TESTS, FACTORS, buildExperiment, experimentProgress, parseNumberList, stabilityTimepoints, flowsFromTotal } from '../calc/experiment.js';
import { DESIGN_TYPES, MODEL_TYPES, RESPONSES, IDENT, validateSpec, buildDesign, designSummary, DOE_MODES, MIXTURE_KINDS, MIXTURE_ORDERS, specMode, mixtureDesignFor, suggestedBudget } from '../calc/doe.js';
import { mixingPlan } from '../calc/batch_record.js';
import { info, wireLearn } from './learn.js';
import { COMPOSITION_FACTORS } from '../calc/ml/space.js';
import { nextExperimentId, usedIds, describeId, raiseCounter } from '../schema.js';
import { experimentResults, resultsCsv, progressStage, predictionSummary } from '../calc/results.js';
import { resultsCard, nextStepStrip, wireResults, shortDate, foldOpen } from './resultsview.js';
import { wireFigures } from './charts.js';
import { openReport } from './report.js';
import { batchIndex, measurementIndex, pageOf } from '../calc/indexes.js';
import { PAGE_ROWS, moreLine, focusFirstNew } from './pager.js';
import { defaultProcess, defaultModeFor, processOf, adoptProcess, processSummary, quickVolumes, effectiveQuench, syncQuick, modeOf, deviceOf, mixersFor, QUICK_VOLUME_mL } from '../calc/process.js';
import { processSvg, processEditor, applyProcessField, wireProcessButtons } from './processviz.js';
import { designSvgFromRuns, designCaption, blendSvgFromRuns, blendCaption } from './designviz.js';
import { specComponents, factorLabel, isCategorical, TWO_LEVEL_DESIGNS } from '../calc/doe.js';
import { CARGO_TYPES, cargoInfo, cargoLabel, cargoOf, massPerPhosphate } from '../calc/cargo.js';
import { ftTag } from '../calc/freezethaw.js';
import { readPlanParams } from '../calc/advise.js';
import { layerTab, layerTabBar, renderLayerTab } from './biolayers.js';

/** What "Repeat as new" carries over, by type, for the note at the top of the filled-in wizard. */
const CARRIED = {
  single: 'its composition, process settings and tests',
  stability: 'its formulations, storage conditions, timepoints, process settings and tests',
  ofat: 'its factor and levels, composition, process settings and tests',
  doe: 'its design (factors and ranges, model, centre points, responses, seed), composition and process settings',
  comparison: 'its compositions, process settings and tests',
  reference: 'its recipe, number of repeats, process settings and tests',
};

/** The short names of the factors in an experiment's Formulations table, as Insights heads its columns. */
const FACTOR_SHORT = { np: 'N/P', frr: 'FRR', tfr: 'TFR', quench: 'quench', peg_pct: 'PEG mol%', ionizable_pct: 'ionizable mol%',
  helper_pct: 'helper mol%', sterol_pct: 'sterol mol%', lipid_mM: 'lipid mM', rna_mg_mL: 'RNA mg/mL', aq_pH: 'aqueous pH', aq_ionic: 'ionic strength', mixer: 'mixer' };

/**
 * A DoE factor row prefilled from an app batch parameter (name is the pipeline identifier). The mixer is a
 * categorical factor (calc/doe.js isCategorical): its low and high are two mixers, coded −1 and +1, offered
 * from the mixers the process's device takes (`mixers`), the first two to start with. N/P has the cargo's range:
 * siRNA LNPs are made around N/P 3, mRNA ones around 6 (calc/cargo.js).
 */
function factorFrom(key, mixers = [], cargo) {
  const f = FACTORS.find((x) => x.key === key);
  if (f.categorical) {
    const two = mixers.slice(0, 2);
    return { name: f.doeName, unit: '', low: -1, center: '', high: 1, applyTo: f.key, levels: two.map((m) => m.id), levelNames: two.map((m) => m.name) };
  }
  const range = key === 'np' ? cargoInfo(cargo).npRange : f.range;
  return { name: f.doeName, unit: f.unit || '', low: range[0], center: '', high: range[1], applyTo: f.key };
}

/** The cargo a new experiment starts with: the last one planned, which is what the lab is most likely making. */
function lastCargo(ctx) {
  const last = ctx.store.all('experiments').filter((e) => e.spec?.cargo)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
  return cargoInfo(last?.spec?.cargo).id;
}

export async function render(el, ctx) {
  const ref = getRef(ctx), settings = getSettings(ctx);
  if (ctx.params.id) return detail(el, ctx, ref, settings, ctx.params.id);
  if (ctx.params.new) return wizard(el, ctx, ref, settings, ctx.params.type);
  return list(el, ctx, ref, settings);
}

/*
 * The list: every experiment, grouped by where it stands, one line each, opening to its formulations.
 *
 * It was one table, newest first, while the sidebar listed only the open ones; with six finished demo
 * experiments under one planned one, the user read "Experiments" as holding just the one (UX revision). Now the
 * groups say how many there are before anything is read: In progress, Planned, Done, in the order a working day
 * asks about them, with Done open as well, because a finished experiment is still an experiment. A line opens
 * to its formulations (what each one is, its status, what is measured), so "where is E4 at" needs no page
 * change; the experiment page is one click on its name. "Expand all" and "Collapse all" do what they say.
 *
 * What is open is kept for the session (`listFolds`, module-level, as the other folds of the app keep theirs),
 * because the list is drawn again on every visit and a line someone opened should still be open when they come
 * back from the experiment it belongs to. A line's formulation table is built only when it is opened, so a year
 * of experiments costs a line each, and each group lists a page at a time (app/ui/pager.js).
 */
const listFolds = new Map();
let rowsOpenByDefault = false;
const LIST_GROUPS = [
  { id: 'running', title: 'In progress' },
  { id: 'planned', title: 'Planned' },
  { id: 'done', title: 'Done' },
];

/*
 * Above the groups: the experiments started in the wizard and not created yet (drafts, kit.js). The user asked
 * that one left half-way "plop into the experiment section, highlighted that it's pending", so they are a
 * group of their own, first and set apart by a dashed outline, each saying what it is, what it holds so far and
 * when it was started, with Continue (back into the wizard as it was left) and Discard (undone from its notice).
 */
function pendingLine(d, ref) {
  const t = TYPES.find((x) => x.id === d.type);
  const name = String(d.state?.name || '').trim();
  const what = draftSummary(d, ref);
  const when = whenText(d.startedAt || d.draftAt);
  return `<div class="xpend" data-draft-id="${esc(d.draftId)}">
    <span class="xp-tag"><span class="chip draftChip">not created</span></span>
    <span class="xp-name"><b>${name ? esc(name) : '<i>no name yet</i>'}</b><span class="muted"> · ${esc(t?.name || d.type)}</span>${what ? `<span class="xp-what muted">${esc(what)}</span>` : ''}</span>
    <span class="xp-when muted">${when ? `started ${esc(when)}` : ''}</span>
    <span class="xp-acts"><a class="btn primary" href="#/experiments?new=1&type=${esc(d.type)}&draft=${esc(d.draftId)}">Continue</a><button type="button" data-dropdraft="${esc(d.kind)}">Discard</button></span>
  </div>`;
}

function list(el, ctx, ref) {
  const exps = ctx.store.all('experiments').sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
  let drafts = experimentDrafts(ctx);
  const today = todayISO();
  // The same derived stage the experiment page shows, so the list does not say "planned" about an experiment
  // whose every result is in. A status the user set to done still wins. Each experiment's formulations come
  // out of one index of them, not a pass over all of them per row.
  const forms = batchIndex(ctx.store.all('batches'));
  const where = new Map(exps.map((e) => {
    const st = progressStage(e, forms.forExperiment(e.id), today);
    const group = e.status === 'done' || st.stage === 'all measured' ? 'done' : st.stage === 'planned' ? 'planned' : 'running';
    return [e.id, { st, group, p: experimentProgress(e, today) }];
  }));
  const stageChip = (e) => {
    if (e.status === 'done') return chip('done', 'ok');
    const st = where.get(e.id).st.stage;
    return chip(st, st === 'all measured' ? 'ok' : st === 'planned' ? '' : 'info');
  };
  const typeName = (e) => TYPES.find((t) => t.id === e.type)?.name || e.type;
  const rowOpen = (id) => listFolds.get(`row:${id}`) ?? rowsOpenByDefault;
  const groupOpen = (id) => listFolds.get(`group:${id}`) ?? true;

  // The opened line: its formulations, each with what sets it apart, its status and its measurements.
  const compLabel = (cid) => { const c = ref.compositionById?.[cid]; return c ? `#${c.id}${c.synonym ? ` ${c.synonym}` : ''}` : (cid != null ? `#${cid}` : '–'); };
  const what = (b) => {
    const fs = Object.entries(b.plan?.factors || {});
    // A design stores its factors under their pipeline names (PEG_mol_pct, flow_rate); the bench says PEG mol%, TFR.
    const short = (k) => FACTOR_SHORT[k] || FACTOR_SHORT[FACTORS.find((f) => f.doeName === k)?.key] || k.replace(/_/g, ' ');
    const val = (k, v) => (k === 'mixer' ? ref.mixers?.find((m) => m.id === v)?.name || v : v);
    return fs.length ? fs.map(([k, v]) => `${short(k)} ${val(k, v)}`).join(', ') : compLabel(b.compositionId);
  };
  const body = (e) => {
    const counts = new Map();
    for (const s of e.expected || []) {
      const c = counts.get(s.batchId) || { done: 0, total: 0 };
      c.total += 1; if (s.status === 'done') c.done += 1;
      counts.set(s.batchId, c);
    }
    const rows = forms.forExperiment(e.id).map((b) => {
      const c = counts.get(b.id) || { done: 0, total: 0 };
      return { cells: [raw(`<a href="#/formulation?batch=${esc(b.id)}"><b>${esc(b.id)}</b></a>`), b.label || '–', what(b), fmtDate(b.plannedDate),
        raw(chip(b.status, b.status === 'planned' ? '' : b.status === 'produced' ? 'info' : 'ok')), `${c.done} / ${c.total}`] };
    });
    return table(['Formulation', 'Label', 'Composition or settings', 'Planned', 'Status', 'Measured'], rows, { empty: 'No formulations.' }) +
      `<div class="xr-acts"><a class="btn" href="#/experiments?id=${esc(e.id)}">Open experiment</a></div>`;
  };

  // One line: what it is, how far it has got (a bar, and the count it stands for), and what is due next.
  const line = (e) => {
    const { p } = where.get(e.id);
    const n = (e.batchIds || []).length;
    const pct = p.total ? Math.round((100 * p.done) / p.total) : 0;
    const open = rowOpen(e.id);
    return `<details class="xrow" data-exp="${esc(e.id)}"${open ? ' open' : ''}>
      <summary>
        <span class="xr-id"><a href="#/experiments?id=${esc(e.id)}">${esc(describeId(e.id))}</a></span>
        <span class="xr-name"><a href="#/experiments?id=${esc(e.id)}">${esc(e.name)}</a><span class="muted"> · ${esc(typeName(e))} · ${n} formulation${n === 1 ? '' : 's'}</span></span>
        <span class="xr-prog" title="${p.done} of ${p.total} measurements done"><span class="xr-bar"><i style="width:${pct}%"></i></span><span class="xr-n">${p.done} / ${p.total}</span>${p.overdue ? ` <span class="xr-late">${p.overdue} overdue</span>` : ''}</span>
        <span class="xr-due muted">${p.nextDue ? `next due ${esc(fmtDate(p.nextDue))}` : `started ${esc(fmtDate(e.startDate))}`}</span>
        <span class="xr-st">${stageChip(e)}</span>
      </summary>
      <div class="xr-body">${open ? body(e) : ''}</div>
    </details>`;
  };

  el.innerHTML = header('Run', 'Experiments', `<a class="btn primary" href="#/experiments?new=1">New experiment</a>`) +
    `<div class="card" id="expAccordion"></div>`;
  const box = el.querySelector('#expAccordion');
  const limits = new Map();
  const draw = () => {
    drafts = experimentDrafts(ctx);
    const pending = !drafts.length ? '' : `<details class="xgroup xpending" data-group="pending"${groupOpen('pending') ? ' open' : ''}>
        <summary><h2>Not created yet</h2><span class="chip warn">${drafts.length}</span><span class="muted xg-say">started and left before “Create experiment”; nothing is planned until it is</span></summary>
        <div class="xg-rows">${drafts.map((d) => pendingLine(d, ref)).join('')}</div>
      </details>`;
    if (!exps.length) {
      box.innerHTML = pending + '<p class="muted">No experiments yet. Start with "New experiment".</p>';
      wirePending();
      return;
    }
    box.innerHTML = `<div class="xl-tools"><span class="muted">${exps.length} experiment${exps.length === 1 ? '' : 's'}${drafts.length ? ` · ${drafts.length} not created yet` : ''}</span>
        <span class="xl-btns"><button type="button" id="expandAll">Expand all</button><button type="button" id="collapseAll">Collapse all</button></span></div>` + pending +
      LIST_GROUPS.map((g) => {
        const items = exps.filter((e) => where.get(e.id).group === g.id);
        if (!items.length) return '';
        const { shown, total } = pageOf(items, limits.get(g.id) || PAGE_ROWS);
        return `<details class="xgroup" data-group="${g.id}"${groupOpen(g.id) ? ' open' : ''}>
          <summary><h2>${esc(g.title)}</h2><span class="chip">${items.length}</span></summary>
          <div class="xg-rows">${shown.map(line).join('')}</div>
          ${moreLine({ id: `expMore-${g.id}`, shown: shown.length, total, noun: 'experiments' })}
        </details>`;
      }).join('');
    for (const g of LIST_GROUPS) {
      box.querySelector(`#expMore-${g.id}`)?.addEventListener('click', () => {
        const from = limits.get(g.id) || PAGE_ROWS;
        limits.set(g.id, from + PAGE_ROWS); draw();
        focusFirstNew(box.querySelectorAll(`[data-group="${g.id}"] details.xrow > summary`), from);
      });
    }
    // Every line and every group, opened or closed. A line someone opened by hand after this is still theirs.
    const all = (open) => {
      rowsOpenByDefault = open;
      for (const k of [...listFolds.keys()]) if (k.startsWith('row:')) listFolds.delete(k);
      for (const g of LIST_GROUPS) listFolds.set(`group:${g.id}`, open);
      draw();
    };
    box.querySelector('#expandAll').addEventListener('click', () => all(true));
    box.querySelector('#collapseAll').addEventListener('click', () => all(false));
    wirePending();
  };
  function wirePending() {
    box.querySelectorAll('[data-dropdraft]').forEach((b) => b.addEventListener('click', () => discardDraft(ctx, b.dataset.dropdraft, () => { if (box.isConnected) draw(); })));
  }
  // 'toggle' does not bubble, so it is heard on the way down. A line's formulations are built on first opening.
  box.addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (d.matches?.('details.xrow')) {
      listFolds.set(`row:${d.dataset.exp}`, d.open);
      const b = d.querySelector('.xr-body');
      if (d.open && !b.childElementCount) { const e = exps.find((x) => x.id === d.dataset.exp); if (e) b.innerHTML = body(e); }
    } else if (d.matches?.('details.xgroup')) listFolds.set(`group:${d.dataset.group}`, d.open);
  }, true);
  draw();
}

/* ---------------- wizard ---------------- */

/**
 * The process the last experiment was planned with (the newest one that has one), as a starting point for the
 * next: a lab runs the same rig most days. The lab's default layout when nothing has been planned with one yet.
 */
function lastProcess(ctx, ref) {
  const last = ctx.store.all('experiments').filter((e) => e.spec?.process)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
  const p = last ? processOf({ process: last.spec.process }, ref) : null;
  // a device deleted since is not offered back: the select could not show it
  return p && (!ref.devices?.length || deviceOf(p, ref)) ? p : defaultProcess(ref);
}
function wizard(el, ctx, ref, settings, type) {
  const stepBar = (n) => `<ol style="list-style:none;margin:0 0 14px;padding:0;display:flex;gap:6px;flex-wrap:wrap;font-size:13px">${['Type', 'Structure', 'Create'].map((s, i) => `<li class="chip ${i < n ? 'ok' : i === n ? 'info' : ''}" style="padding:6px 12px">${i + 1} · ${s}</li>`).join('')}</ol>`;
  if (!type) {
    // A wizard filled in and left without "Create experiment" is offered back here, one note per draft.
    const offers = experimentDrafts(ctx).map((d) => draftOffer(ctx, d)).join('');
    el.innerHTML = header('Experiments › New', 'New experiment') + stepBar(0) + offers +
      `<p class="muted">The type defines what gets created: the formulations, the measurements they are due, their sample names and the calendar entries.</p>
       <div class="grid g2">${TYPES.map((t) => `<a href="#/experiments?new=1&type=${t.id}" class="card" style="text-decoration:none;color:inherit;display:block"><div style="font-size:15px;font-weight:600">${t.name}</div><div class="muted">${t.desc}</div></a>`).join('')}</div>`;
    wireDraftOffers(el, ctx);
    return;
  }
  const T = TYPES.find((t) => t.id === type);
  // The planner can hand over the factors and the design it recommended, so its advice arrives as a filled-in
  // wizard rather than a list to retype. Anything it sends is a starting point and is editable below.
  const fromPlanner = {
    factors: (ctx.params.factors || '').split(',').map((k) => k.trim()).filter((k) => FACTORS.some((f) => f.key === k)),
    design: DESIGN_TYPES[ctx.params.design] ? ctx.params.design : '',
    model: MODEL_TYPES[ctx.params.model] ? ctx.params.model : '',
    mode: DOE_MODES[ctx.params.mode] ? ctx.params.mode : '',
    center: Number.isFinite(Number(ctx.params.center)) && ctx.params.center !== '' ? Number(ctx.params.center) : null,
    // The troubleshooting assistant (spec 9.4) also hands over an OFAT factor and its levels, DoE ranges, the
    // composition and process settings of the batch it started from, and a name (readPlanParams in advise.js).
    ...readPlanParams(ctx.params, FACTORS.map((f) => f.key)),
  };
  // In registry order, so a fresh install opens on the first example rather than whichever entry
  // happens to have the highest number.
  const comps = ref.active.compositions.slice();
  const defaultComp = comps[0]?.id;
  // The cargo (mRNA, siRNA) starts as the last experiment's; choosing an RNA lot sets it to the lot's.
  const cargo0 = lastCargo(ctx);
  const state = { type, name: '', startDate: todayISO(), compositionId: defaultComp, stockId: '', rnaLotId: '', cargo: cargo0, rna_mg: 3, working_mg_mL: settings.defaultWorking_mg_mL,
    frr: settings.defaultFRR, quenchFactor: settings.defaultQuenchFactor, totalFlow: 112.5, lipidStock_mM: settings.defaultLipidStock_mM, tests: ['dls', 'ee'], batchesPerDay: 4, weekendShift: true,
    stability: { formulations: [{ compositionId: defaultComp }], conditions: ['4C', '25C'], durationDays: 28, intervalDays: 3, timepointsText: '', tests: ['dls', 'ee'], potencyAtText: '0, 28' },
    ofat: { factor: 'np', levelsText: cargoInfo(cargo0).npLevels.join(', '), mixers: [] },
    doe: { mode: fromPlanner.mode || 'process', designType: fromPlanner.design || 'full_factorial',
      // A crossed design multiplies the two models, so the process-only default would ask for forty terms
      // before the user has seen a run count.
      model: fromPlanner.model || (fromPlanner.mode === 'crossed' ? 'linear' : 'interaction'),
      centerPoints: fromPlanner.center ?? 3, replicates: 1, seed: 42, alpha: '', plateFormat: '', plateStartWell: 'A1',
      components: fromPlanner.mode && fromPlanner.mode !== 'process' ? componentsFromComposition(defaultComp) : [],
      mixtureKind: 'auto', mixtureOrder: 'quadratic', degree: 2, budget: '', total: 100,
      factors: (fromPlanner.factors.length ? fromPlanner.factors : ['frr', 'tfr']).map((k) => factorFrom(k, [], cargo0)),
      responses: Object.fromEntries(RESPONSES.map((r) => [r.name, { on: ['particle_size_nm', 'PDI', 'encapsulation_efficiency'].includes(r.name), goal: r.goal, target: r.target ?? null }])) },
    comparison: { compositionIds: [defaultComp] }, reference: { n: 3 },
    // How far each formulation goes (quick: up to the mixer, by volume; full: the whole record, by mRNA), and
    // the process every formulation is made by. The mode starts from the type (calc/process.js says why), the
    // process from the last experiment planned, so a lab that always runs the same rig sets it up once.
    mode: defaultModeFor(type), volume_mL: settings.defaultQuickVolume_mL ?? QUICK_VOLUME_mL, process: lastProcess(ctx, ref) };

  // What the troubleshooting assistant handed over goes on top of the defaults: the batch's own composition and
  // settings, so the plan changes only what it means to, and the factor with its levels or ranges. A draft and
  // "Repeat as new" are applied after this and still win.
  if (fromPlanner.name) state.name = fromPlanner.name;
  if (fromPlanner.comp != null && ref.compositionById[fromPlanner.comp]) state.compositionId = fromPlanner.comp;
  if (fromPlanner.base.frr != null) state.frr = fromPlanner.base.frr;
  if (fromPlanner.base.tfr != null) state.totalFlow = fromPlanner.base.tfr;
  if (fromPlanner.base.quench != null) state.quenchFactor = fromPlanner.base.quench;
  if (fromPlanner.factor) state.ofat = { factor: fromPlanner.factor, levelsText: fromPlanner.levels.length ? fromPlanner.levels.join(', ') : state.ofat.levelsText };
  for (const f of state.doe.factors) { const r = fromPlanner.ranges[f.applyTo]; if (r) { f.low = r[0]; f.high = r[1]; } }

  // Whether the run budget is still the app's suggestion or a number the user typed.
  let budgetTouched = false;

  // Opened straight into a blend mode from the catalogue, the budget has to be there before the first draw,
  // or the preview offers every candidate in the region as a batch to make.
  if (state.doe.mode !== 'process') state.doe.budget = budgetSuggestion() ?? '';

  // "Repeat as new" hands over an earlier experiment, the way the planner hands over a design: its stored spec
  // fills the wizard, so a repeat with one change costs that one change rather than every setting typed again.
  const fromExp = ctx.params.from ? ctx.store.get('experiments', ctx.params.from) : null;
  if (fromExp) prefillFrom(fromExp);

  // What was typed into the wizard and not created is kept as a draft (usability cycle 5, K6), and listed as
  // "Not created yet" at the top of Experiments and in the sidebar until it is created or discarded. Each wizard
  // that is typed into is a draft of its own, under its own id: starting a second DoE no longer writes over the
  // first one left half-done, and nothing typed is lost to a click on the sidebar, the back button or a closed
  // tab (kit.js keeps experiment drafts in localStorage). "Continue" opens one with draft=<its id> (draft=1, as
  // links made before, takes the newest of the type), and the wizard starts from it.
  const ofType = experimentDrafts(ctx).filter((d) => d.type === type);
  const draft = ctx.params.draft ? (ofType.find((d) => d.draftId === ctx.params.draft) || (ctx.params.draft === '1' ? ofType[0] : null) || null) : null;
  let sinceNote = ''; // what changed in a continued draft because time has passed, for the note above the form
  if (draft?.state) {
    // One level deep, so a setting this version added keeps its default rather than going missing.
    for (const [k, v] of Object.entries(draft.state)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && state[k] && typeof state[k] === 'object' && !Array.isArray(state[k])) Object.assign(state[k], v);
      else state[k] = v;
    }
    state.type = type;
    budgetTouched = !!draft.budgetTouched;
    sinceNote = sinceDrafted();
  }
  // The draft this wizard goes on with, or writes once something is typed: creating the experiment drops that
  // one, and not another offered above an untouched wizard.
  const draftId = draft?.draftId || uid();
  // A draft kept by an earlier version has the type alone as its kind; it goes on under that.
  const draftKind = draft?.kind || `experiment.${type}.${draftId}`;
  let startedAt = draft?.startedAt || draft?.draftAt || null;
  // The other drafts of this type, offered above a fresh wizard; typing below starts a new one beside them.
  const offered = draft ? [] : ofType;
  const opened = JSON.stringify(state);
  const keepDraft = () => {
    if (!draft && JSON.stringify(state) === opened) return;
    startedAt ||= new Date().toISOString();
    writeDraft(ctx, draftKind, { state, budgetTouched, draftId, startedAt });
  };
  // Set while "Create experiment" is being stored, so a redraw meanwhile does not offer the button again.
  let creating = false;

  /**
   * A draft is continued as it would be made today. What it names may have gone since it was typed (a stock
   * deleted, a lot or a composition gone with the demo's "Start over"), and the select would then read "choose
   * later" while the experiment was created with the old id; such a choice is left to make again. A start date
   * that has passed becomes today. Returns what it changed, in a sentence or two, or ''.
   */
  function sinceDrafted() {
    const gone = [];
    const known = (id) => !!ref.compositionById[Number(id)];
    if (state.stockId && !ctx.store.get('stocks', state.stockId)) { gone.push(`lipid stock ${state.stockId}`); state.stockId = ''; }
    if (state.rnaLotId && !ref.rnaLots.some((r) => r.id === state.rnaLotId)) { gone.push(`RNA lot ${state.rnaLotId}`); state.rnaLotId = ''; }
    const comps = [state.compositionId, ...state.stability.formulations.map((f) => f.compositionId), ...state.comparison.compositionIds];
    for (const id of new Set(comps.filter((c) => !known(c)).map(String))) gone.push(`composition #${id}`);
    if (!known(state.compositionId)) state.compositionId = defaultComp;
    state.stability.formulations = state.stability.formulations.filter((f) => known(f.compositionId));
    if (!state.stability.formulations.length) state.stability.formulations = [{ compositionId: defaultComp }];
    state.comparison.compositionIds = state.comparison.compositionIds.filter(known);
    if (!state.comparison.compositionIds.length) state.comparison.compositionIds = [defaultComp];
    const today = todayISO(), was = state.startDate;
    if (!was || was < today) state.startDate = today;
    return [
      gone.length ? `It named ${gone.join(', ')}, no longer on record, which the form below leaves out.` : '',
      was && was < today ? `Its start date, ${fmtDate(was)}, has passed: it starts today.` : '',
    ].filter(Boolean).join(' ');
  }

  /**
   * Copy an experiment's settings into the wizard: name, composition(s), process settings, tests and the
   * type's own plan. Not the start date (a repeat is made on a new day) and not the lots (it is usually made
   * from fresh stock); a composition no longer in the registry is left at the default rather than kept unseen.
   */
  function prefillFrom(e) {
    const src = e.spec || {};
    const given = (v) => v !== undefined && v !== null && v !== '';
    const known = (id) => given(id) && !!ref.compositionById[Number(id)];
    state.name = `${e.name || describeId(e.id)} (repeat)`;
    for (const k of ['rna_mg', 'working_mg_mL', 'frr', 'quenchFactor', 'totalFlow', 'lipidStock_mM', 'batchesPerDay']) {
      if (given(src[k]) && Number.isFinite(Number(src[k]))) state[k] = Number(src[k]);
    }
    if (typeof src.weekendShift === 'boolean') state.weekendShift = src.weekendShift;
    if (src.cargo) state.cargo = cargoInfo(src.cargo).id; // a repeat carries what the original carried
    // The mode, the volume and the process are the repeat's too; an experiment from before they existed was
    // the full process on the lab's own layout, and repeats as that.
    state.mode = src.mode === 'quick' ? 'quick' : 'full';
    if (given(src.volume_mL) && Number(src.volume_mL) > 0) state.volume_mL = Number(src.volume_mL);
    state.process = processOf({ process: src.process || null }, ref);
    if (Array.isArray(src.tests) && src.tests.length) state.tests = [...src.tests];
    const comp = src.compositionId ?? e.compositionId;
    if (known(comp)) state.compositionId = Number(comp);

    const st = src.stability?.formulations ? src.stability : e.design?.stability;
    if (st) {
      const forms = (st.formulations || []).filter((f) => known(f.compositionId)).map((f) => ({ compositionId: Number(f.compositionId) }));
      if (forms.length) state.stability.formulations = forms;
      if (st.conditions?.length) state.stability.conditions = [...st.conditions];
      if (st.tests?.length) state.stability.tests = st.tests.filter((t) => t !== 'potency');
      state.stability.potencyAtText = (st.potencyAt || []).join(', ');
      // A plan that is a plain every-n-days grid comes back as duration and interval, which every user sees;
      // anything else as the custom list, which is what it was.
      const tps = (st.timepoints || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      if (tps.length) {
        const last = tps[tps.length - 1], step = Math.max(1, tps.length > 1 ? tps[1] - tps[0] : last);
        if (stabilityTimepoints({ durationDays: last, intervalDays: step }).join() === tps.join()) Object.assign(state.stability, { durationDays: last, intervalDays: step, timepointsText: '' });
        else state.stability.timepointsText = tps.join(', ');
      }
    }
    const of = src.ofat?.factor ? src.ofat : e.design?.factor ? { factor: e.design.factor, levels: e.design.levels } : null;
    if (of && FACTORS.some((f) => f.key === of.factor)) {
      state.ofat = FACTORS.find((f) => f.key === of.factor).categorical
        ? { factor: of.factor, levelsText: state.ofat.levelsText, mixers: (of.levels || []).map(String) }
        : { factor: of.factor, levelsText: (of.levels || []).join(', '), mixers: [] };
    }
    if (src.comparison?.compositionIds?.length) {
      const ids = src.comparison.compositionIds.filter(known).map(Number);
      if (ids.length) state.comparison.compositionIds = ids;
    }
    if (given(src.reference?.n)) state.reference.n = Number(src.reference.n);
    else if (e.type === 'reference') state.reference.n = e.batchIds?.length || state.reference.n;

    const d = src.doe?.factors || src.doe?.components ? src.doe : e.design?.doe?.spec;
    if (d) {
      Object.assign(state.doe, {
        mode: DOE_MODES[d.mode] ? d.mode : 'process',
        designType: DESIGN_TYPES[d.designType] ? d.designType : state.doe.designType,
        model: MODEL_TYPES[d.model] ? d.model : state.doe.model,
        centerPoints: d.centerPoints ?? state.doe.centerPoints, replicates: d.replicates ?? 1, seed: d.seed ?? state.doe.seed,
        alpha: d.alpha ?? '', plateFormat: d.plateFormat ? String(d.plateFormat) : '', plateStartWell: d.plateStartWell || 'A1',
        mixtureKind: MIXTURE_KINDS[d.mixtureKind] ? d.mixtureKind : 'auto', mixtureOrder: MIXTURE_ORDERS[d.mixtureOrder] ? d.mixtureOrder : 'quadratic',
        degree: d.degree ?? 2, budget: d.budget ?? '', total: d.total ?? 100,
        components: (d.components || []).map((c) => ({ lipidKey: c.lipidKey || c.name || '', lo: c.lo ?? '', hi: c.hi ?? '' })),
        factors: (d.factors || []).map((f) => ({ name: f.name || '', unit: f.unit || '', low: f.low ?? '', center: f.center ?? '', high: f.high ?? '', applyTo: f.applyTo || '',
          ...(isCategorical(f) ? { levels: [...f.levels], levelNames: [...(f.levelNames || f.levels)] } : {}) })),
      });
      if (Array.isArray(d.responses)) {
        for (const name of Object.keys(state.doe.responses)) {
          const r = d.responses.find((x) => x.name === name);
          state.doe.responses[name] = r ? { on: true, goal: r.goal || state.doe.responses[name].goal, target: r.target ?? null } : { ...state.doe.responses[name], on: false };
        }
      }
      // the earlier experiment's budget was somebody's decision, so it is kept rather than re-suggested
      budgetTouched = given(d.budget);
    }
  }

  /** Under the volume: the mRNA it holds at the settings above, and the formula, so the number can be checked by hand. */
  function quickHint() {
    const q = state.process.quench !== false ? Number(state.quenchFactor) || 0 : 0;
    const v = quickVolumes({ volume_mL: state.volume_mL, working_mg_mL: state.working_mg_mL, frr: state.frr, quenchFactor: q });
    return v ? `= ${fmt(v.rna_mg, 3)} mg ${cargoLabel(state.cargo)} per formulation: volume × RNA working conc. × FRR ÷ (FRR + 1${q ? ' + quench' : ''})` : 'the volume of product collected after the mixer';
  }

  // The same reading the calc tests cover, so an empty custom box falls back to duration and interval.
  function timepoints() { return stabilityTimepoints(state.stability); }
  /** The mixers the chosen device takes, in its own order (calc/process.js mixersFor): what a mixer factor offers. */
  function deviceMixers() { return mixersFor(deviceOf(state.process, ref), ref); }
  const mixerName = (id) => ref.mixers?.find((m) => m.id === id)?.name || '';
  /**
   * An OFAT over mixers: the ticked mixers the device takes, in the device's order; null for a numeric factor.
   * A mixer ticked on another device is kept in the state, so switching the device back brings it back.
   */
  function ofatMixers() {
    if (!FACTORS.find((f) => f.key === state.ofat.factor)?.categorical) return null;
    const ticked = new Set(state.ofat.mixers || []);
    return deviceMixers().filter((m) => ticked.has(m.id));
  }
  function spec() {
    const s = { ...state };
    s.stability = { formulations: state.stability.formulations.map((f, i) => ({ compositionId: Number(f.compositionId), label: `F${i + 1}` })), conditions: state.stability.conditions, timepoints: timepoints(), tests: state.stability.tests, potencyAt: parseNumberList(state.stability.potencyAtText) };
    s.ofat = ofatMixers() ? { factor: state.ofat.factor, levels: ofatMixers().map((m) => m.id), labels: Object.fromEntries(ofatMixers().map((m) => [m.id, m.name])) }
      : { factor: state.ofat.factor, levels: parseNumberList(state.ofat.levelsText) };
    s.doe = doeSpec();
    if (type === 'doe') s.tests = [...new Set([...state.tests, ...s.doe.responses.map((r) => RESPONSES.find((x) => x.name === r.name)?.source[0]).filter(Boolean)])];
    s.comparison = { compositionIds: state.comparison.compositionIds.map(Number) };
    s.compositionId = type === 'stability' ? Number(state.stability.formulations[0]?.compositionId) : type === 'comparison' ? Number(state.comparison.compositionIds[0]) : Number(state.compositionId);
    s.rnaStock_mg_mL = ref.rnaLots.find((r) => r.id === state.rnaLotId)?.conc_mg_mL ?? null;
    return s;
  }
  function doeSpec() {
    const d = state.doe;
    const num = (v) => (v === '' || v == null ? null : Number(v));
    const mode = DOE_MODES[d.mode] ? d.mode : 'process';
    return { mode, designType: d.designType, model: d.model, centerPoints: Number(d.centerPoints) || 0, replicates: Math.max(1, Number(d.replicates) || 1), seed: Number(d.seed) || 42, alpha: num(d.alpha),
      plateFormat: d.plateFormat ? Number(d.plateFormat) : null, plateStartWell: d.plateStartWell || 'A1',
      total: Number(d.total) || 100, mixtureKind: d.mixtureKind || 'auto', mixtureOrder: d.mixtureOrder || 'quadratic',
      degree: Math.max(1, Number(d.degree) || 2), budget: num(d.budget),
      components: mode === 'process' ? [] : d.components.map((c) => ({ name: c.lipidKey || '', lipidKey: c.lipidKey || '', lo: num(c.lo), hi: num(c.hi) })),
      factors: (mode === 'mixture' ? [] : d.factors).map((f) => (isCategorical(f)
        // a mixer: two mixers coded −1/+1, no centre (calc/doe.js isCategorical); its names are kept with the spec
        ? { name: (f.name || '').trim(), unit: '', low: -1, center: null, high: 1, applyTo: f.applyTo || 'mixer', levels: [...f.levels], levelNames: f.levels.map((id, i) => mixerName(id) || f.levelNames?.[i] || id) }
        : { name: (f.name || '').trim(), unit: f.unit || '', low: num(f.low), center: num(f.center), high: num(f.high), applyTo: f.applyTo || null })),
      responses: RESPONSES.filter((r) => d.responses[r.name]?.on).map((r) => ({ name: r.name, unit: r.unit, min_valid: r.min_valid, max_valid: r.max_valid, goal: d.responses[r.name].goal || r.goal, target: num(d.responses[r.name].target) ?? r.target ?? null })) };
  }
  // The preview names its samples with the number the experiment will get, not E0 (usability cycle 6, I9).
  // Worked out once per wizard: it walks the whole store, and the preview is redrawn as factors are typed.
  let previewId = null;
  function preview() {
    previewId ||= nextExperimentId(usedIds(ctx.store, 'experiment'));
    try { return { ok: buildExperiment(spec(), { settings, takenFormulations: [], experimentId: previewId }) }; }
    catch (e) { return { err: e.message }; }
  }

  /** The mRNA the formulations take: one number, or the range when a factor (FRR, RNA conc.) moves it. */
  function mrnaKpi(batches) {
    const ms = batches.map((b) => b.plan.rna.mass_mg).filter(Number.isFinite);
    if (!ms.length) return '–';
    const lo = Math.min(...ms), hi = Math.max(...ms);
    return Math.abs(hi - lo) < 1e-9 ? `${fmt(lo, 3)} mg` : `${fmt(lo, 3)}–${fmt(hi, 3)} mg`;
  }

  function previewHtml(pv) {
    if (pv.err) return `<div class="note warn">${pv.err}</div>`;
    const { experiment, batches } = pv.ok;
    const dates = [...new Set(batches.map((b) => b.plannedDate))].sort();
    const dueDates = [...new Set(experiment.expected.map((s) => s.dueDate))].sort();
    return `<div class="grid g4">${kpi('Formulations', batches.length, dates.length > 1 ? `${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}` : fmtDate(dates[0]))}
      ${kpi(`${cargoLabel(state.cargo)} per formulation`, mrnaKpi(batches), state.mode === 'quick' ? `in ${fmt(state.volume_mL, 2)} mL each, from the volume` : 'full process, by RNA input')}
      ${kpi('Expected measurements', experiment.expected.length)}
      ${kpi('Measurement days', dueDates.length, dueDates.length ? `last ${fmtDate(dueDates[dueDates.length - 1])}` : '')}
      ${kpi('Sample name example', raw(`<span style="font-family:ui-monospace,Menlo,monospace;font-size:13px">${experiment.expected[0]?.sampleName || '–'}</span>`))}</div>
      ${type === 'stability' ? `<div class="muted" style="margin-top:6px">${batches.length} formulation${batches.length === 1 ? '' : 's'} × ${experiment.design.stability.conditions.length} conditions = ${batches.length * experiment.design.stability.conditions.length} storage samples.</div>` : ''}`;
  }
  /**
   * The lipids of a registry composition as a starting blend, each free to move ±30 % of where it sits now.
   * Relative ranges rather than fixed ones because a 1.8 mol% PEG and a 47 mol% ionizable lipid are not
   * usefully given the same window, and ±30 % always leaves a feasible region: the lower bounds then add to
   * 70 and the upper to 130, which straddles 100.
   */
  function componentsFromComposition(compId) {
    const c = ref.compositionById[Number(compId)];
    if (!c?.mol_pct) return [];
    const r1 = (v) => Math.round(v * 10) / 10;
    // In the order a recipe is written, not the order the JSON happens to store.
    const ORDER = ['ionizable', 'helper', 'sterol', 'peg', 'other'];
    return Object.entries(c.mol_pct)
      .filter(([, v]) => Number(v) > 0)
      .sort((a, b) => ORDER.indexOf(ref.lipidByKey?.[a[0]]?.class || 'other') - ORDER.indexOf(ref.lipidByKey?.[b[0]]?.class || 'other'))
      .map(([k, v]) => ({ lipidKey: k, lo: r1(Math.max(0, Number(v) * 0.7)), hi: r1(Number(v) * 1.3) }));
  }

  /**
   * Keep the run budget sensible as the model changes.
   *
   * Until the budget has been typed in, it is the app's own suggestion and follows the model in both
   * directions — otherwise dropping a lipid leaves the field reading 35 next to a label saying 23 fits, and
   * the design quietly runs twelve batches nobody asked for. Once it has been typed in it is the user's
   * number and is only ever raised, and only as far as the model needs to be fittable at all.
   */
  function bumpBudget() {
    const sug = budgetSuggestion();
    if (sug == null) return;
    if (!budgetTouched) state.doe.budget = sug;
    else if (!state.doe.budget || Number(state.doe.budget) < sug) state.doe.budget = sug;
  }

  /** The suggested budget for the design as it stands, or null when the spec is not yet valid enough to ask. */
  function budgetSuggestion() {
    try { const ds = doeSpec(); return specMode(ds) === 'process' ? null : suggestedBudget(ds); } catch { return null; }
  }

  /** DoE: validation messages and the run count / model summary for the current design. */
  function doeSummaryHtml() {
    const d = state.doe, ds = doeSpec();
    const errs = validateSpec(ds);
    if (errs.length) return `<div class="note warn" style="margin-top:8px">${errs.join('<br>')}</div>`;
    let sm;
    try { sm = designSummary(ds, buildDesign(ds)); }
    catch (err) { return `<div class="note warn" style="margin-top:8px">${esc(err.message)}</div>`; }
    const mix = specMode(ds) !== 'process';
    const blends = mix ? ` over <b>${sm.distinctBlends}</b> distinct blend${sm.distinctBlends === 1 ? '' : 's'}` : '';
    const chosen = mix && sm.selected ? ` chosen from ${sm.poolSize} candidates` : '';
    const modelName = mix ? `${MIXTURE_ORDERS[ds.mixtureOrder].replace(/:.*/, '')}${specMode(ds) === 'crossed' ? ` × ${MODEL_TYPES[ds.model].toLowerCase()}` : ''}` : MODEL_TYPES[ds.model];
    return `<div class="muted" style="margin-top:8px"><b>${sm.runs} runs</b>${chosen}${blends}: ${Object.entries(sm.byType).map(([k, v]) => `${v} ${k}`).join(' · ')}${!mix && d.replicates > 1 ? ` (×${d.replicates} replicates)` : ''}, model "${modelName}": ${sm.terms} terms, ${sm.residualDf} residual df${sm.alpha != null ? ` · α = ${fmt(sm.alpha, 3)}` : ''}</div>
      ${mix && sm.note ? `<div class="muted" style="margin-top:4px">${esc(sm.note)}</div>` : ''}
      ${sm.residualDf < 3 ? `<div class="note warn">Fewer than 3 residual degrees of freedom: ${mix ? 'raise the run budget, add centre replicates, or drop to a linear blending model' : 'add centre points or replicates'} before running.</div>` : ''}
      ${mix && sm.distinctBlends < sm.mixTerms ? `<div class="note warn">Only ${sm.distinctBlends} distinct blends, and the blending model has ${sm.mixTerms} terms. The blend effects cannot be separated: widen the mol% ranges, raise the budget, or drop to a linear blending model.</div>`
        : mix && sm.distinctBlends < sm.mixTerms + 2 ? `<div class="muted" style="margin-top:4px">${sm.distinctBlends} distinct blends for a ${sm.mixTerms}-term blending model, just enough. Another blend or two would give the blend effects some room.</div>` : ''}
      ${mix && !ds.budget && sm.runs > 40 ? `<div class="note warn">No run budget set, so every one of the ${sm.poolSize} candidate blends becomes a batch. That is a candidate pool, not an experiment, set a budget (${suggestedBudget(ds)} would fit this model with 5 runs to spare).</div>` : ''}`;
  }
  /**
   * The design as a picture, pinned beside the wizard while it is filled in: the cube, square or triangle of
   * runs the factors and the design chosen make, redrawn as they change. It is the same drawing Design & results
   * pins once the runs exist, so the shape of the experiment stays in sight from setting it up to reading it.
   */
  function designPinHtml() {
    let ds, runs;
    try { ds = doeSpec(); if (validateSpec(ds).length) throw new Error(); runs = buildDesign(ds); }
    catch { return '<h3 style="margin:0 0 6px">The design</h3><p class="muted wsp-cap">Drawn here once the factors and their ranges are filled in.</p>'; }
    const sm = designSummary(ds, runs);
    const names = (ds.factors || []).map((f) => f.name);
    const fig = specMode(ds) === 'process'
      ? `${designSvgFromRuns(runs, names, { size: 250, names: (ds.factors || []).map(factorLabel) })}<p class="muted wsp-cap">${designCaption(names.length, sm.byType, { grid: names.length > 3 })}</p>`
      : `${blendSvgFromRuns(runs, specComponents(ds), { size: 250, total: Number(ds.total) || 100 })}<p class="muted wsp-cap">${blendCaption(specComponents(ds).length, sm.byType, { crossed: specMode(ds) === 'crossed' })}</p>`;
    return `<h3 style="margin:0 0 6px">The design · ${sm.runs} runs</h3>${fig}`;
  }

  /** Light refresh after typing in a DoE factor cell: summary and preview only, the form keeps focus and tab order. */
  function refresh() {
    const ds = el.querySelector('#doeSummary'); if (ds) ds.innerHTML = doeSummaryHtml();
    const pin = el.querySelector('#wizPin'); if (pin) pin.innerHTML = designPinHtml();
    const pv = preview();
    const body = el.querySelector('#previewBody'); if (body) body.innerHTML = previewHtml(pv);
    const btn = el.querySelector('#createExp'); if (btn) btn.disabled = creating || !!pv.err;
    for (const inp of el.querySelectorAll('input[name^="doe_f_name_"]')) inp.classList.toggle('invalid', !!inp.value && !IDENT.test(inp.value));
  }

  function draw() {
    const compOpts = comps.map((c) => ({ value: c.id, label: compositionLabel(c, ref) }));
    const stocks = ctx.store.all('stocks');
    const common = `
      <div class="grid g4">
        ${field({ id: 'name', label: 'Name', type: 'text', value: state.name, placeholder: `${T.name} …` })}
        ${field({ id: 'startDate', label: 'Start (day 0 = production)', type: 'date', value: state.startDate })}
        ${!['comparison', 'stability'].includes(type) ? field({ id: 'compositionId', label: 'Composition', type: 'select', value: state.compositionId, options: compOpts }) : ''}
        ${field({ id: 'stockId', label: 'Lipid stock lot', type: 'select', value: state.stockId, options: [{ value: '', label: 'Choose later' }, ...stocks.map((s) => ({ value: s.id, label: `${s.id} (#${s.compositionId}, ${fmt(s.molarity_mM, 1)} mM)${ftTag(s, settings.ftWarnCycles)}` }))] })}
        ${field({ id: 'cargo', label: 'Cargo', type: 'select', value: state.cargo, options: CARGO_TYPES.map((c) => ({ value: c.id, label: c.label })),
          hint: `N/P with ${cargoInfo(state.cargo).massPerPhosphate} g/mol per phosphate; typical N/P about ${cargoInfo(state.cargo).defaultNP}` })}
        ${field({ id: 'rnaLotId', label: `${cargoLabel(state.cargo)} lot`, type: 'select', value: state.rnaLotId, options: [{ value: '', label: 'Choose later' }, ...ref.pick('rnaLots', state.rnaLotId).map((r) => ({ value: r.id, label: `${r.id} · ${cargoLabel(r.cargo)} · ${r.construct || ''} · ${fmt(r.conc_mg_mL, 2)} mg/mL` }))] })}
        ${state.mode === 'quick'
          ? field({ id: 'volume_mL', label: 'Volume to formulate (mL)', value: state.volume_mL, step: 0.5, min: 0, hint: quickHint() })
          : field({ id: 'rna_mg', label: 'RNA per batch (mg)', value: state.rna_mg, step: 0.1 })}
        ${field({ id: 'working_mg_mL', label: 'RNA working conc. (mg/mL)', value: state.working_mg_mL, step: 0.05, advanced: true })}
        ${field({ id: 'frr', label: 'FRR (aq : org)', value: state.frr, step: 0.5, advanced: true })}
        ${field({ id: 'quenchFactor', label: 'Quench factor', value: state.quenchFactor, step: 0.5, advanced: true })}
        ${field({ id: 'totalFlow', label: 'Total flow (mL/min)', value: state.totalFlow, step: 0.5, advanced: true })}
        ${field({ id: 'lipidStock_mM', label: 'Lipid stock (mM)', value: state.lipidStock_mM, step: 0.1, advanced: true })}
        ${field({ id: 'batchesPerDay', label: 'Formulations per day', value: state.batchesPerDay, step: 1, advanced: true })}
      </div>
      ${type !== 'stability' ? `<div style="margin-top:10px"><label>Measurements per batch (${state.mode === 'quick' ? 'of the product from the mixer' : 'after dialysis'})</label><div style="display:flex;gap:14px;flex-wrap:wrap">${TESTS.slice(0, 5).map((t) => `<label style="display:flex;gap:6px;align-items:center;font-weight:400;color:var(--ink)"><input type="checkbox" name="test_${t.id}" ${state.tests.includes(t.id) ? 'checked' : ''} style="width:auto">${t.name}</label>`).join('')}</div></div>` : ''}`;

    // Quick or full, first: it decides what the fields above ask for.
    const modeCard = `<div class="modeRow" id="wizMode"><div class="seg modeSeg" role="group" aria-label="How far each formulation goes">
        <button type="button" data-wmode="quick" class="${state.mode === 'quick' ? 'on' : ''}" aria-pressed="${state.mode === 'quick'}">Quick · mixing only</button>
        <button type="button" data-wmode="full" class="${state.mode === 'quick' ? '' : 'on'}" aria-pressed="${state.mode !== 'quick'}">Full process</button></div>
      <span class="muted">${state.mode === 'quick' ? `Each formulation stops at the mixer: say how much to make, and the ${cargoLabel(state.cargo)}, the phases and the pump flows follow. Each record can switch to the full process.` : 'Each formulation goes through the whole record: RNA dilution, mixing, dialysis, TFF, final formulation and fill. Each record can switch to quick.'}</span></div>`;
    // The process, drawn and set here once for every formulation; each record can change its own afterwards.
    const q = state.process.quench !== false ? Number(state.quenchFactor) || 0 : 0;
    const processCard = `<div class="card" id="wizProcess"><h2>Process</h2>
      <p class="muted" style="margin:-4px 0 8px">${esc(processSummary(state.process, ref, { quick: state.mode === 'quick' }))}. Copied onto every formulation, where it can be changed one by one.</p>
      <div class="processDraw">${processSvg(state.process, ref, { quick: state.mode === 'quick', flows: flowsFromTotal(Number(state.totalFlow) || 112.5, Number(state.frr) || 3, q), lipid_mM: state.lipidStock_mM })}</div>
      ${processEditor(state.process, ref, { quick: state.mode === 'quick', uid: 'wiz' })}</div>`;

    let specific = '';
    if (type === 'stability') {
      const st = state.stability;
      specific = `<h2 style="margin-top:14px">Stability design ${info('stability')}</h2>
        <div><label>Formulations</label><div id="formList" style="display:flex;flex-direction:column;gap:6px">${st.formulations.map((f, i) => `<div style="display:flex;gap:8px;align-items:center"><span class="chip">F${i + 1}</span><select name="form_${i}" style="flex:1">${compOpts.map((o) => `<option value="${o.value}" ${String(o.value) === String(f.compositionId) ? 'selected' : ''}>${o.label}</option>`).join('')}</select><button data-rmform="${i}" class="ghost" style="padding:4px 8px">✕</button></div>`).join('')}</div>
        <button id="addForm" style="margin-top:6px">+ Add formulation</button></div>
        <div class="grid g4" style="margin-top:10px">
          <div><label>Storage conditions</label><div style="display:flex;gap:10px;flex-wrap:wrap">${['4C', '25C', '-20C', '37C', 'RT'].map((c) => `<label style="display:flex;gap:4px;align-items:center;font-weight:400;color:var(--ink)"><input type="checkbox" name="cond_${c}" ${st.conditions.includes(c) ? 'checked' : ''} style="width:auto">${c.replace('C', ' °C')}</label>`).join('')}</div></div>
          ${field({ id: 'st_durationDays', label: 'Duration (days)', value: st.durationDays, step: 1 })}
          ${field({ id: 'st_intervalDays', label: 'Every n days', value: st.intervalDays, step: 1 })}
          ${field({ id: 'st_timepointsText', label: 'Custom timepoints (days, overrides interval)', type: 'text', value: st.timepointsText, placeholder: '0, 1, 3, 7, 14, 28', advanced: true })}
          ${field({ id: 'st_potencyAtText', label: 'Potency at timepoints', type: 'text', value: st.potencyAtText })}
          <div>${field({ id: 'weekendShift', label: 'Move weekend timepoints to Monday', type: 'checkbox', value: state.weekendShift })}</div>
        </div>
        <div style="margin-top:8px"><label>Measurements per timepoint</label><div style="display:flex;gap:14px;flex-wrap:wrap">${TESTS.filter((t) => ['dls', 'zeta', 'ee', 'content', 'ph'].includes(t.id)).map((t) => `<label style="display:flex;gap:6px;align-items:center;font-weight:400;color:var(--ink)"><input type="checkbox" name="sttest_${t.id}" ${st.tests.includes(t.id) ? 'checked' : ''} style="width:auto">${t.name}</label>`).join('')}</div></div>
        <div class="muted" style="margin-top:6px">Timepoints: ${timepoints().map((t) => 'T' + t).join(' · ')}</div>`;
    } else if (type === 'ofat') {
      // The mixer is compared by ticking mixers, not by typing numbers: one formulation per ticked mixer, the
      // rest of the process as set below. The list is the mixers the chosen device takes, so a NanoScaler offers
      // the KNAUER IJM 1 to 5; another device, its own.
      const isMixer = !!FACTORS.find((f) => f.key === state.ofat.factor)?.categorical;
      const dm = deviceMixers(), dev = deviceOf(state.process, ref);
      const ticked = new Set(state.ofat.mixers || []);
      const knauer = ref.devices?.find((d) => d.id === 'nanoscaler');
      specific = `<h2 style="margin-top:14px">One factor at a time</h2><div class="grid g3">
        ${field({ id: 'ofat_factor', label: 'Factor', type: 'select', value: state.ofat.factor, options: FACTORS.map((f) => ({ value: f.key, label: f.name + (f.unit ? ` (${f.unit})` : '') })) })}
        ${isMixer ? '' : field({ id: 'ofat_levelsText', label: 'Levels (comma separated)', type: 'text', value: state.ofat.levelsText })}
        <div class="muted" style="align-self:end">Other parameters stay at the values above.</div></div>
        ${!isMixer ? '' : `<div id="ofatMixers" class="mixPick"><label>Mixers to compare <span class="muted" style="font-weight:400">· one formulation each, on the ${esc(dev?.name || 'device chosen under Process')}</span></label>
          <div class="mixPickList">${dm.map((m) => `<label class="mixPickItem"><input type="checkbox" name="ofat_mix_${esc(m.id)}" ${ticked.has(m.id) ? 'checked' : ''} style="width:auto"> ${esc(m.name)}${m.kind && m.kind !== m.name ? ` <span class="muted">${esc(m.kind)}</span>` : ''}</label>`).join('') || '<span class="muted">This device lists no mixers.</span>'}</div>
          ${knauer && dev?.id !== knauer.id ? `<p class="muted" style="margin:6px 0 0">To compare the KNAUER IJM 1 to 5, choose the ${esc(knauer.name)} as the device under Process below.</p>` : ''}</div>`}`;
    } else if (type === 'doe') {
      const d = state.doe;
      const mode = DOE_MODES[d.mode] ? d.mode : 'process';
      const isMix = mode !== 'process';
      // A lipid mol% the blend already chooses must not also be driven by a process factor, so those batch
      // parameters come off the list in a mixture design rather than being offered and then refused.
      const applyOpts = [{ value: '', label: 'record only (set by hand)' },
        ...FACTORS.filter((f) => !f.categorical && !(isMix && COMPOSITION_FACTORS.some((c) => c.key === f.key))).map((f) => ({ value: f.key, label: f.name + (f.unit ? ` (${f.unit})` : '') }))];
      // A mixer row: low and high are two mixers the device takes, and there is no centre (calc/doe.js isCategorical).
      const mixOpts = (cur) => [...deviceMixers(), ...(cur && !deviceMixers().some((m) => m.id === cur) ? [{ id: cur, name: mixerName(cur) || cur }] : [])];
      const mixSel = (f, i, j) => `<select name="doe_f_level${j}_${i}" style="width:150px" aria-label="${j ? 'High' : 'Low'}: mixer">${mixOpts(f.levels[j]).map((m) => `<option value="${esc(m.id)}" ${m.id === f.levels[j] ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`;
      const fRow = (f, i) => isCategorical(f) ? { attrs: 'class="catRow"', cells: [
        raw(`<input type="text" name="doe_f_name_${i}" value="${esc(f.name ?? '')}" style="width:130px;font-family:ui-monospace,Menlo,monospace">`),
        raw('<span class="muted">–</span>'),
        raw(mixSel(f, i, 0)),
        raw('<span class="muted" title="A mixer has no setting in between: centre points are split between the two mixers">none · split</span>'),
        raw(mixSel(f, i, 1)),
        raw('<span>Mixer</span>'),
        raw(`<button data-rmf="${i}" class="ghost" style="padding:4px 8px" title="remove">✕</button>`)] } : ({ cells: [
        raw(`<input type="text" name="doe_f_name_${i}" value="${f.name ?? ''}" placeholder="identifier" style="width:130px;font-family:ui-monospace,Menlo,monospace" ${f.name && !IDENT.test(f.name) ? 'class="invalid" title="letters, digits and underscore only"' : ''}>`),
        raw(`<input type="text" name="doe_f_unit_${i}" value="${f.unit ?? ''}" style="width:70px">`),
        raw(`<input type="number" step="any" name="doe_f_low_${i}" value="${f.low ?? ''}" style="width:84px">`),
        raw(`<input type="number" step="any" name="doe_f_center_${i}" value="${f.center ?? ''}" placeholder="mid" style="width:84px" title="optional: asymmetric ranges are coded per side">`),
        raw(`<input type="number" step="any" name="doe_f_high_${i}" value="${f.high ?? ''}" style="width:84px">`),
        raw(`<select name="doe_f_applyTo_${i}">${applyOpts.map((o) => `<option value="${o.value}" ${o.value === (f.applyTo || '') ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`),
        raw(`<button data-rmf="${i}" class="ghost" style="padding:4px 8px" title="remove">✕</button>`)] });

      const lipidOpts = ref.active.lipids.map((l) => ({ value: l.key, label: `${l.name} · ${l.class}` }));
      const cRow = (c, i) => {
        const lip = ref.lipidByKey?.[c.lipidKey];
        return { cells: [
          raw(`<select name="doe_c_lipidKey_${i}" style="min-width:210px">${c.lipidKey ? '' : '<option value="">Choose a lipid…</option>'}${lipidOpts.map((o) => `<option value="${o.value}" ${o.value === c.lipidKey ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`),
          raw(lip ? `<span class="chip">${esc(lip.class)}</span>` : '<span class="muted">–</span>'),
          raw(`<input type="number" step="any" min="0" name="doe_c_lo_${i}" value="${c.lo ?? ''}" style="width:84px">`),
          raw(`<input type="number" step="any" min="0" name="doe_c_hi_${i}" value="${c.hi ?? ''}" style="width:84px">`),
          raw(`<button data-rmc="${i}" class="ghost" style="padding:4px 8px" title="remove">✕</button>`)] };
      };
      const sumLo = d.components.reduce((a, c) => a + (Number(c.lo) || 0), 0);
      const sumHi = d.components.reduce((a, c) => a + (Number(c.hi) || 0), 0);
      const total = Number(d.total) || 100;
      const straddles = sumLo <= total + 1e-9 && sumHi >= total - 1e-9;

      const modeCard = `<h2 style="margin-top:14px">What are you optimizing?</h2>
        <div class="grid g3">${field({ id: 'doe_mode', label: 'Experiment', type: 'select', value: mode, options: Object.entries(DOE_MODES).map(([id, x]) => ({ value: id, label: x.name })) })}</div>
        <div class="muted" style="margin-top:4px">${DOE_MODES[mode].note}</div>`;

      const lipidCard = !isMix ? '' : `<h2 style="margin-top:14px">Lipids in the blend ${info('mixture')}</h2>
        <p class="muted">Pick the lipids and the mol% range each may take. Any number from two upwards, and more
          than one lipid of the same class is fine, a blend of two ionizable lipids is a question this design
          can answer and a class-based factor cannot. The blend always adds up to ${fmt(total, 0)} mol%, so the
          runs below are the compositions that span your ranges, not every combination of them.</p>
        ${table(['Lipid', 'Class', `Lowest (mol%)`, 'Highest (mol%)', ''], d.components.map(cRow), { empty: 'Add at least two lipids.' })}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center">
          <button id="addComp" style="padding:4px 10px">+ Add lipid</button>
          <button id="fromComposition" style="padding:4px 10px" title="take the lipids and ±30 % ranges from the composition chosen above">From composition #${state.compositionId}</button>
          <span class="muted">Lower bounds add to <b>${fmt(sumLo, 1)}</b>, upper to <b>${fmt(sumHi, 1)}</b>${straddles ? '' : `, they must straddle ${fmt(total, 0)}`}</span>
        </div>
        <div class="grid g4" style="margin-top:10px">
          ${field({ id: 'doe_mixtureKind', label: 'Blend design', type: 'select', value: d.mixtureKind, options: Object.entries(MIXTURE_KINDS).map(([id, x]) => ({ value: id, label: x.name })) })}
          ${field({ id: 'doe_mixtureOrder', label: 'Blending model', type: 'select', value: d.mixtureOrder, options: Object.entries(MIXTURE_ORDERS).map(([id, l]) => ({ value: id, label: l })) })}
          ${field({ id: 'doe_budget', label: `Run budget${budgetSuggestion() != null ? ` (${budgetSuggestion()} fits this model)` : ''}`, value: d.budget, step: 1, min: 1, placeholder: 'blank = every candidate' })}
          ${d.mixtureKind === 'lattice' ? field({ id: 'doe_degree', label: 'Lattice degree', value: d.degree, step: 1, min: 1 }) : field({ id: 'doe_total', label: 'Blend adds up to (mol%)', value: d.total, step: 1, min: 1, advanced: true })}
        </div>
        <div class="muted" style="margin-top:4px">${MIXTURE_KINDS[d.mixtureKind]?.note || ''} A budget picks the runs that pin down the model best (D-optimal), which is what keeps a crossed design to a size you can actually make.</div>`;

      const factorCard = mode === 'mixture' ? '' : `<h2 style="margin-top:14px">${isMix ? 'Process factors' : 'Factors'} ${info('doe')} ${!isMix && COMPOSITION_FACTORS.some((c) => d.factors.some((f) => f.applyTo === c.key)) ? info('mixture') : ''}</h2>
        ${isMix ? '<p class="muted">These vary alongside the blend. Every run gets both a composition and a process setting.</p>' : ''}
        ${table(['Name (pipeline identifier)', 'Unit', 'Low', 'Centre', 'High', 'Applies to batch parameter', ''], d.factors.map(fRow), { empty: isMix ? 'Add at least one process factor.' : 'Add at least two factors.' })}
        ${d.factors.some(isCategorical) ? '<p class="muted" style="margin:6px 0 0">The mixer is compared at two mixers, low and high. With no mixer in between, it takes a 2-level design, its centre points are split between the two mixers, and the surface plots show one mixer at a time.</p>' : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;align-items:center"><span class="muted">Add:</span>${FACTORS.filter((f) => !d.factors.some((x) => x.applyTo === f.key) && !(isMix && (COMPOSITION_FACTORS.some((c) => c.key === f.key) || f.categorical))).map((f) => `<button data-addf="${f.key}" style="padding:4px 10px">+ ${f.name}</button>`).join('')}<button id="addCustomF" style="padding:4px 10px">+ custom (e.g. temperature, pH)</button></div>`;

      const designCard = `<h2 style="margin-top:14px">Design ${info('rsm')} ${info('center')}</h2>
        <div class="grid g4">
          ${mode === 'process' ? field({ id: 'doe_designType', label: 'Design', type: 'select', value: d.designType, options: Object.entries(DESIGN_TYPES).map(([id, x]) => ({ value: id, label: x.name })) }) : ''}
          ${field({ id: 'doe_model', label: isMix ? 'Process model to fit' : 'Model to fit', type: 'select', value: d.model, options: Object.entries(MODEL_TYPES).map(([id, l]) => ({ value: id, label: l })) })}
          ${field({ id: 'doe_centerPoints', label: isMix ? 'Replicates at the centre' : 'Centre points', value: d.centerPoints, step: 1, min: 0 })}
          ${mode === 'process' ? field({ id: 'doe_replicates', label: 'Replicates of each design point', value: d.replicates, step: 1, min: 1, advanced: true }) : ''}
        </div>
        <div class="muted" style="margin-top:4px">${mode === 'process' ? DESIGN_TYPES[d.designType]?.note || '' : isMix && mode === 'crossed' ? 'The process model also sets how the blend is allowed to change with the process: a linear process model asks whether the whole response surface shifts, an interaction model whether the blending itself changes.' : ''}</div>
        <details class="wizMore"${d.plateFormat || d.alpha ? ' open' : ''}><summary>More settings: randomisation seed${mode === 'process' && d.designType.startsWith('ccd') ? ', axial distance α' : ''}, plate wells</summary><div class="grid g4">
          ${field({ id: 'doe_seed', label: 'Randomisation seed', value: d.seed, step: 1, advanced: true })}
          ${mode === 'process' && d.designType.startsWith('ccd') ? field({ id: 'doe_alpha', label: 'Axial distance α (blank = default)', value: d.alpha, step: 0.01, advanced: true }) : ''}
          ${field({ id: 'doe_plateFormat', label: 'Plate wells for samples', type: 'select', value: d.plateFormat, options: [{ value: '', label: 'none' }, { value: '96', label: '96-well' }, { value: '384', label: '384-well' }], advanced: true })}
          ${d.plateFormat ? field({ id: 'doe_plateStartWell', label: 'First well', type: 'text', value: d.plateStartWell, advanced: true }) : ''}
        </div></details>
        <div id="doeSummary">${doeSummaryHtml()}</div>`;

      specific = `${modeCard}${lipidCard}${factorCard}${designCard}
        <h2 style="margin-top:14px">Responses</h2>
        ${table(['Use', 'Response', 'Goal', 'Target'], RESPONSES.map((r) => { const st = d.responses[r.name]; return { cells: [raw(`<input type="checkbox" name="doe_r_on_${r.name}" ${st.on ? 'checked' : ''} style="width:auto">`), raw(`${r.label} <span class="muted" style="font-family:ui-monospace,Menlo,monospace;font-size:11px">${r.name}</span>`),
          raw(`<select name="doe_r_goal_${r.name}" style="width:130px">${['none', 'minimize', 'maximize', 'target'].map((g) => `<option value="${g}" ${st.goal === g ? 'selected' : ''}>${g}</option>`).join('')}</select>`),
          raw(st.goal === 'target' ? `<input type="number" step="any" name="doe_r_target_${r.name}" value="${st.target ?? ''}" style="width:90px">` : '<span class="muted">–</span>')] }; }))}
        <div class="muted" style="margin-top:6px">Runs become formulations in the randomised order, and are numbered in it: F1 is the first run to make. The fit, the diagnostics and the optimum are on Design &amp; results once the measurements are in.</div>`;
    } else if (type === 'comparison') {
      specific = `<h2 style="margin-top:14px">Compositions to compare</h2><div id="cmpList" style="display:flex;flex-direction:column;gap:6px">${state.comparison.compositionIds.map((cid, i) => `<div style="display:flex;gap:8px;align-items:center"><span class="chip">F${i + 1}</span><select name="cmp_${i}" style="flex:1">${compOpts.map((o) => `<option value="${o.value}" ${String(o.value) === String(cid) ? 'selected' : ''}>${o.label}</option>`).join('')}</select><button data-rmcmp="${i}" style="padding:4px 8px">✕</button></div>`).join('')}</div><button id="addCmp" style="margin-top:6px">+ Add composition</button>`;
    } else if (type === 'reference') {
      specific = `<h2 style="margin-top:14px">Repeats</h2><div class="grid g3">${field({ id: 'ref_n', label: 'Number of repeats', value: state.reference.n, step: 1 })}</div>`;
    }

    const pv = preview();
    el.innerHTML = header('Experiments › New', T.name) + stepBar(1) +
      (fromExp ? `<div class="note" id="fromNote">Filled in from <a href="#/experiments?id=${esc(fromExp.id)}">${esc(describeId(fromExp.id))}</a>, “${esc(fromExp.name || '')}”: ${esc(CARRIED[fromExp.type] || CARRIED.single)}. The start date is today and the lots are left to choose. Change what this repeat is for, then create it.</div>`
        : ctx.params.from ? `<div class="note warn" id="fromNote">${esc(describeId(ctx.params.from))} is not on record, so nothing was filled in.</div>` : '') +
      (draft?.state ? `<div class="note" id="draftOn">You are going on with the experiment you started${startedAt ? ` ${esc(whenText(startedAt))}` : ''} and did not create.${sinceNote ? ' ' + esc(sinceNote) : ''} It is created when you press “Create experiment”; until then it waits under Experiments as not created yet. <button type="button" id="draftFresh">Start afresh</button></div>`
        : offered.map((d) => draftOffer(ctx, d, ' Anything typed below is kept as a new one beside it.')).join('')) +
      (fromPlanner.factors.length || fromPlanner.design ? `<div class="note">Filled in from <a href="#/advisor">the planner</a>${fromPlanner.design ? `: a ${esc(DESIGN_TYPES[fromPlanner.design]?.name.toLowerCase() || fromPlanner.design)}` : ''}${fromPlanner.factors.length ? ` over ${fromPlanner.factors.map((k) => esc(FACTORS.find((f) => f.key === k).name)).join(', ')}` : ''}. Everything below is editable.</div>` : '') +
      (type === 'doe' ? '<div class="wsp"><div class="wsp-main">' : '') +
      `<div class="card" id="wizForm">${modeCard}${common}${specific}</div>${processCard}
       <div class="card" style="border-color:var(--accent)"><h2>What will be created</h2><div id="previewBody">${previewHtml(pv)}</div>
         <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><a class="btn" href="#/experiments?new=1">Back</a><button class="primary" id="createExp" data-form="${esc(draftId)}" ${creating || pv.err ? 'disabled' : ''}>${creating ? 'Creating …' : 'Create experiment'}</button></div></div>` +
      (type === 'doe' ? `</div><aside class="wsp-pin" id="wizPin">${designPinHtml()}</aside></div>` : '');

    wireLearn(el);
    wireDraftOffers(el, ctx);
    el.querySelector('#draftFresh')?.addEventListener('click', () => { dropDraft(ctx, draftKind); ctx.navigate('experiments', { new: 1, type }); });
    const form = el.querySelector('#wizForm');
    form.addEventListener('input', onInput); form.addEventListener('change', onInput);
    const procBox = el.querySelector('#wizProcess');
    procBox.addEventListener('input', onInput); procBox.addEventListener('change', onInput);
    wireProcessButtons(procBox, () => state.process, (next) => { state.process = next; keepDraft(); draw(); }, ref);
    form.querySelectorAll('[data-wmode]').forEach((b) => b.addEventListener('click', () => { state.mode = b.dataset.wmode; keepDraft(); draw(); }));
    // The buttons that add or remove a row change the plan too; their own listeners have run by now.
    form.addEventListener('click', (e) => { if (e.target.closest('button')) keepDraft(); });
    form.querySelector('#addForm')?.addEventListener('click', () => { state.stability.formulations.push({ compositionId: state.compositionId }); draw(); });
    form.querySelectorAll('[data-rmform]').forEach((b) => b.addEventListener('click', () => { state.stability.formulations.splice(Number(b.dataset.rmform), 1); if (!state.stability.formulations.length) state.stability.formulations.push({ compositionId: state.compositionId }); draw(); }));
    form.querySelectorAll('[data-addf]').forEach((b) => b.addEventListener('click', () => {
      const f = factorFrom(b.dataset.addf, deviceMixers(), state.cargo);
      state.doe.factors.push(f);
      // A mixer has no middle setting: a 3-level design cannot hold it, so the design steps down to the 2-level
      // factorial, and says so, rather than leave a refusal to read.
      if (isCategorical(f) && !TWO_LEVEL_DESIGNS.includes(state.doe.designType)) {
        state.doe.designType = 'full_factorial';
        if (state.doe.model === 'quadratic') state.doe.model = 'interaction';
        toast('Design set to the 2-level full factorial: a mixer has no setting in between', 'info');
      }
      draw();
    }));
    form.querySelector('#addCustomF')?.addEventListener('click', () => { state.doe.factors.push({ name: '', unit: '', low: '', center: '', high: '', applyTo: '' }); draw(); el.querySelector(`[name="doe_f_name_${state.doe.factors.length - 1}"]`)?.focus(); });
    form.querySelector('#addComp')?.addEventListener('click', () => {
      const taken = new Set(state.doe.components.map((c) => c.lipidKey));
      const next = ref.active.lipids.find((l) => !taken.has(l.key));
      state.doe.components.push({ lipidKey: next?.key || '', lo: '', hi: '' });
      bumpBudget(); draw(); el.querySelector(`[name="doe_c_lipidKey_${state.doe.components.length - 1}"]`)?.focus();
    });
    form.querySelector('#fromComposition')?.addEventListener('click', () => { state.doe.components = componentsFromComposition(state.compositionId); bumpBudget(); draw(); });
    form.querySelectorAll('[data-rmc]').forEach((b) => b.addEventListener('click', () => { state.doe.components.splice(Number(b.dataset.rmc), 1); bumpBudget(); draw(); }));
    form.querySelectorAll('[data-rmf]').forEach((b) => b.addEventListener('click', () => { state.doe.factors.splice(Number(b.dataset.rmf), 1); draw(); }));
    form.querySelector('#addCmp')?.addEventListener('click', () => { state.comparison.compositionIds.push(state.compositionId); draw(); });
    form.querySelectorAll('[data-rmcmp]').forEach((b) => b.addEventListener('click', () => { state.comparison.compositionIds.splice(Number(b.dataset.rmcmp), 1); if (!state.comparison.compositionIds.length) state.comparison.compositionIds.push(state.compositionId); draw(); }));
    el.querySelector('#createExp').addEventListener('click', create);
  }

  function onInput(e) {
    apply(e);
    if (e.target.name) keepDraft();
  }

  function apply(e) {
    const t = e.target; if (!t.name) return;
    const v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? (t.value === '' ? null : Number(t.value)) : t.value;
    const n = t.name;
    if (n.startsWith('test_')) { const id = n.slice(5); state.tests = state.tests.filter((x) => x !== id); if (v) state.tests.push(id); }
    else if (n.startsWith('sttest_')) { const id = n.slice(7); state.stability.tests = state.stability.tests.filter((x) => x !== id); if (v) state.stability.tests.push(id); }
    else if (n.startsWith('cond_')) { const c = n.slice(5); state.stability.conditions = state.stability.conditions.filter((x) => x !== c); if (v) state.stability.conditions.push(c); }
    else if (n.startsWith('form_')) state.stability.formulations[Number(n.slice(5))].compositionId = v;
    else if (n.startsWith('cmp_')) state.comparison.compositionIds[Number(n.slice(4))] = v;
    else if (n.startsWith('st_')) state.stability[n.slice(3)] = v;
    else if (n.startsWith('ofat_mix_')) { const id = n.slice(9); state.ofat.mixers = (state.ofat.mixers || []).filter((x) => x !== id); if (v) state.ofat.mixers.push(id); }
    else if (n.startsWith('ofat_')) {
      state.ofat[n.slice(5)] = v;
      // Choosing the mixer as the factor starts with the mixer the process already uses ticked.
      if (n === 'ofat_factor' && FACTORS.find((f) => f.key === v)?.categorical && !(state.ofat.mixers || []).length) state.ofat.mixers = [state.process.mixerId].filter(Boolean);
    }
    else if (/^doe_f_level[01]_\d+$/.test(n)) {
      const [, j, i] = n.match(/^doe_f_level([01])_(\d+)$/);
      const f = state.doe.factors[Number(i)];
      if (f?.levels) { f.levels[Number(j)] = v; f.levelNames = f.levels.map((id) => mixerName(id) || id); }
    }
    else if (n.startsWith('doe_f_')) { const m = n.match(/^doe_f_(\w+?)_(\d+)$/); if (m && state.doe.factors[Number(m[2])]) state.doe.factors[Number(m[2])][m[1]] = v; }
    else if (n.startsWith('doe_c_')) { const m = n.match(/^doe_c_(\w+?)_(\d+)$/); if (m && state.doe.components[Number(m[2])]) state.doe.components[Number(m[2])][m[1]] = v; }
    else if (n.startsWith('doe_r_')) { const m = n.match(/^doe_r_(on|goal|target)_(.+)$/); if (m && state.doe.responses[m[2]]) state.doe.responses[m[2]][m[1]] = v; }
    else if (n.startsWith('doe_')) state.doe[n.slice(4)] = v;
    else if (n === 'ref_n') state.reference.n = v;
    else if (n.startsWith('pr_')) { const next = applyProcessField(state.process, n, v, ref); if (next) state.process = next; }
    else if (n === 'cargo') setCargo(v);
    else state[n] = v;
    // An RNA lot says what it is: choosing an siRNA lot makes the experiment an siRNA one.
    if (n === 'rnaLotId' && v) { const lot = ref.rnaLots.find((r) => r.id === v); if (lot) setCargo(cargoInfo(lot.cargo).id); }
    // Switching to a blend design with nothing picked yet starts from the composition chosen above, which is
    // nearly always what you want and saves retyping a recipe the app already knows.
    if (n === 'doe_mode' && v !== 'process') {
      if (!state.doe.components.length) state.doe.components = componentsFromComposition(state.compositionId);
      // A crossed design multiplies the two models together, so the ambitious process model the process-only
      // default carries would ask for forty terms before the user has seen a single run count.
      if (v === 'crossed' && state.doe.model !== 'linear') state.doe.model = 'linear';
      bumpBudget();
    }
    if (n === 'doe_budget') budgetTouched = v !== '' && v != null;
    // Changing the lipids or either model changes the number of terms, and with it what a budget has to be.
    if (/^doe_(c_lipidKey|mixtureOrder|model)/.test(n)) bumpBudget();
    if (/^doe_f_(name|unit|low|center|high)_/.test(n)) { refresh(); return; } // typing in the factor table: no redraw, keep tab order
    if (/^doe_c_(lo|hi)_/.test(n) || ['doe_budget', 'doe_total', 'doe_degree'].includes(n)) { refresh(); return; }
    // `change` fires as the user leaves a field, on the way to the next one. Redraw once they are there, and
    // keep them there: not back on the field just left, which is where focus was when this event fired.
    if (e.type === 'change' && n !== 'name') redrawSoon(e.currentTarget, () => swapHtml(el, draw));
  }

  /**
   * Another cargo. The N/P levels and ranges that are still the old cargo's defaults move to the new one's
   * (mRNA 3–12, siRNA 1.5–6); numbers typed in by hand stay as they are.
   */
  function setCargo(id) {
    const was = cargoInfo(state.cargo), now = cargoInfo(id);
    state.cargo = now.id;
    if (was.id === now.id) return;
    if (state.ofat.factor === 'np' && parseNumberList(state.ofat.levelsText).join() === was.npLevels.join()) state.ofat.levelsText = now.npLevels.join(', ');
    for (const f of state.doe.factors) if (f.applyTo === 'np' && Number(f.low) === was.npRange[0] && Number(f.high) === was.npRange[1]) { f.low = now.npRange[0]; f.high = now.npRange[1]; }
  }

  function create() {
    if (creating) return; // pressed again while the first press is being stored: that would be a second experiment
    const s = spec();
    if (!s.name) { toast('Give the experiment a name', 'warn'); el.querySelector('[name=name]').focus(); return; }
    // Numbered past every id still on record anywhere, the trash and the results of a deleted experiment
    // included: a number given out twice hands the old results to the new formulations (see usedIds).
    const id = nextExperimentId(usedIds(ctx.store, 'experiment'));
    const { experiment, batches } = buildExperiment(s, { settings, takenFormulations: usedIds(ctx.store, 'formulation'), experimentId: id });
    // The wizard moves on to the new experiment only once it is stored. When the browser refuses the write
    // (a full disk), the store undoes it, and the wizard stays as it is with everything typed into it, for the
    // button to be pressed again once there is room (usability cycle 5, K4). It used to move on at once, and the
    // undo then left "No experiment E…" where the wizard had been.
    // The button says so until then. Leaving a field by pressing it redraws the form after the click (the field's
    // change event), so the state is kept in `creating`, which draw() and refresh() read, not only on the button.
    const busy = (on) => {
      creating = on;
      const b = el.querySelector('#createExp');
      if (b) { b.disabled = on || !!preview().err; b.textContent = on ? 'Creating …' : 'Create experiment'; }
    };
    busy(true);
    // Until the write is stored or undone, its draft is not offered back as one not created: continued and
    // created again, it was a second experiment (usability cycle 6, W6). And the user may have moved on by
    // then: this wizard is still showing only while its own button is.
    draftsStoring.add(draftId);
    const still = () => el.querySelector('#createExp')?.dataset.form === draftId;
    // One write: formulations without their experiment (or the other way round) are never stored.
    ctx.store.transaction(() => {
      batches.forEach((b) => ctx.store.put('batches', b));
      ctx.store.put('experiments', experiment);
      raiseCounter(ctx.store, 'experiment', id); // so the number stays taken after the trash forgets it
    }, {
      what: `the new ${describeId(id)}`, again: 'Create experiment',
      onSaved: () => {
        draftsStoring.delete(draftId);
        dropDraft(ctx, draftKind, draftId);
        const said = `Created ${describeId(id)} with ${batches.length} formulation${batches.length === 1 ? '' : 's'}`;
        // Moving on is for the user still waiting on the wizard; one who has gone elsewhere is told where it is.
        if (still()) { toast(said, 'ok'); ctx.navigate('experiments', { id }); }
        else toast(said, 'ok', { action: 'Open', onAction: () => ctx.navigate('experiments', { id }) });
      },
      onUndone: () => { draftsStoring.delete(draftId); busy(false); return still(); },
    });
  }
  draw();
}

/**
 * Every experiment started in the wizard and not created, newest first: [{kind, type, draftId, state,
 * startedAt, draftAt}]. One being created right now is not among them (kit.js draftsStoring).
 */
export function experimentDrafts(ctx) {
  return listDrafts(ctx, 'experiment.').map((d) => ({ ...d, type: d.state?.type || d.kind.split('.')[1] }))
    .filter((d) => TYPES.some((t) => t.id === d.type));
}

/** "today at 14:05", "yesterday at 09:12", "on 21 Oct 2026": when a draft was started or last changed. */
export function whenText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.toISOString().slice(0, 10), today = todayISO();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const yest = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  return day === today ? `today at ${hm}` : day === yest ? `yesterday at ${hm}` : `on ${fmtDate(day)}`;
}

/**
 * What a draft holds so far, in a line: what it is made of and what it varies, so two DoE drafts can be told
 * apart without opening them. Only what was typed or chosen; the defaults every wizard starts with are said
 * too where they decide what the experiment is (its composition, the factor of an OFAT).
 */
export function draftSummary(d, ref) {
  const st = d.state || {};
  const comp = (id) => { const c = ref.compositionById?.[Number(id)]; return c ? `#${c.id}${c.synonym ? ` ${c.synonym}` : ''}` : id != null && id !== '' ? `#${id}` : ''; };
  const mixer = (id) => ref.mixers?.find((m) => m.id === id)?.name || id;
  const fac = (key) => FACTORS.find((f) => f.key === key);
  const parts = [];
  if (d.type === 'stability') {
    const n = (st.stability?.formulations || []).length;
    parts.push(`${n} formulation${n === 1 ? '' : 's'} × ${(st.stability?.conditions || []).map((c) => c.replace('C', ' °C')).join(', ') || 'no condition'}`);
  } else if (d.type === 'comparison') parts.push(`compositions ${(st.comparison?.compositionIds || []).map(comp).join(', ')}`);
  else if (st.compositionId != null) parts.push(`composition ${comp(st.compositionId)}`);
  if (d.type === 'ofat' && st.ofat) {
    const f = fac(st.ofat.factor);
    parts.push(f?.categorical ? `${f.name.toLowerCase()}s ${(st.ofat.mixers || []).map(mixer).join(', ') || 'none ticked yet'}` : `${f?.name || st.ofat.factor} at ${st.ofat.levelsText || '–'}`);
  }
  if (d.type === 'doe' && st.doe) {
    const names = (st.doe.factors || []).map((f) => factorLabel(f)).filter(Boolean);
    if (st.doe.mode && st.doe.mode !== 'process') parts.push(DOE_MODES[st.doe.mode]?.name.toLowerCase() || st.doe.mode);
    if (names.length) parts.push(`${DESIGN_TYPES[st.doe.designType]?.name || 'design'} over ${names.join(', ')}`);
  }
  if (d.type === 'reference' && st.reference?.n) parts.push(`${st.reference.n} repeats`);
  if (st.mode) parts.push(st.mode === 'quick' ? 'quick' : 'full process');
  if (st.process?.mixerId && !(d.type === 'ofat' && fac(st.ofat?.factor)?.categorical)) parts.push(mixer(st.process.mixerId));
  return parts.filter(Boolean).join(' · ');
}

/**
 * The note offering back a wizard left without "Create experiment": its type, its name if it had one, when it
 * was started, and the way back to it. `more` is said after it.
 */
function draftOffer(ctx, d, more = '') {
  if (!d?.state || draftsStoring.has(d.draftId)) return '';
  const t = TYPES.find((x) => x.id === d.type);
  const name = String(d.state.name || '').trim();
  const when = whenText(d.startedAt || d.draftAt);
  return `<div class="note draftNote" data-draft="${esc(d.type)}" data-draft-id="${esc(d.draftId)}">You started a new experiment${when ? ` ${esc(when)}` : ''}, ${esc(t?.name || d.type)}${name ? ` “${esc(name)}”` : ''}, and did not create it.${more}
    <a class="btn" href="#/experiments?new=1&type=${esc(d.type)}&draft=${esc(d.draftId)}">Continue it</a> <button type="button" data-dropdraft="${esc(d.kind)}">Discard it</button></div>`;
}

/**
 * "Discard": the draft goes at once, and the notice can bring it back, as every delete in the app can be
 * undone from its notice. `after` redraws whatever listed it; a lone note is simply removed.
 */
export function discardDraft(ctx, kind, after) {
  const d = readDraft(ctx, kind);
  if (!d) { after?.(); return; }
  dropDraft(ctx, kind);
  const t = TYPES.find((x) => x.id === (d.state?.type || kind.split('.')[1]));
  const name = String(d.state?.name || '').trim();
  toast(`Discarded the ${t ? t.name : 'experiment'} not created${name ? ` “${name}”` : ''}`, 'ok', {
    action: 'Undo', onAction: () => { writeDraft(ctx, kind, d, { keepTime: true }); after?.(); },
  });
  after?.();
}
function wireDraftOffers(el, ctx) {
  el.querySelectorAll('[data-dropdraft]').forEach((b) => b.addEventListener('click', () => {
    const note = b.closest('[data-draft]');
    discardDraft(ctx, b.dataset.dropdraft, () => {
      // put back by Undo while this screen is still open: draw the screen again, so the note comes back
      if (readDraft(ctx, b.dataset.dropdraft)) { if (note?.isConnected) return; window.dispatchEvent(new HashChangeEvent('hashchange')); }
      else note?.remove();
    });
  }));
}

/* ---------------- detail ---------------- */
function detail(el, ctx, ref, settings, id) {
  const exp = ctx.store.get('experiments', id);
  if (!exp) { el.innerHTML = header('Experiments', 'Not found') + `<div class="note warn">No experiment ${esc(id)}</div>`; return; }
  const today = todayISO();
  // The records are read once and looked up from maps: the formulations by id, this experiment's results by
  // formulation. A lookup per row over the whole store is what made a year of data slow (cycle 4, S2).
  const batches = batchIndex(ctx.store.all('batches')).of(exp);
  // A biological layer's tab (spec 8.5): every formulation of the experiment, in the studies that ran them.
  const tabHref = (t) => `#/experiments?id=${encodeURIComponent(exp.id)}${t ? `&tab=${t}` : ''}`;
  const onLayer = layerTab(ctx);
  if (onLayer) return renderLayerTab(el, ctx, { layer: onLayer, batchIds: batches.map((b) => b.id), crumb: raw(`<a href="#/experiments">Experiments</a> › ${esc(describeId(exp.id))}`), title: exp.name, bar: layerTabBar(ctx, onLayer, tabHref, 'Experiment'), what: `the formulations of ${describeId(exp.id)}` });
  const ids = new Set(batches.map((b) => b.id));
  const measurements = ctx.store.all('measurements').filter((m) => m.experimentId === id || ids.has(m.batchId));
  const results = measurementIndex(measurements);
  const latest = (batchId, test) => results.latest(batchId, test);
  const p = experimentProgress(exp, today);
  const T = TYPES.find((t) => t.id === exp.type);
  const first = batches[0];
  const comp = ref.compositionById[exp.compositionId];
  const ionizablePct = comp ? Object.entries(comp.mol_pct).filter(([k]) => ref.lipidByKey[k]?.class === 'ionizable').reduce((s, [, v]) => s + v, 0) : null;
  const rna = first?.plan?.rna?.lotId ? ref.rnaLots.find((r) => r.id === first.plan.rna.lotId) : null;
  // The cargo is the formulations' (each carries its own); an experiment from before there was a choice is mRNA.
  const cargo = cargoLabel(first ? cargoOf(first.plan, rna) : exp.spec?.cargo);
  let np = first?.plan?.rna?.np ?? null;
  if (np == null && first && ionizablePct) {
    try { np = mixingPlan({ rna_mg: first.plan.rna.mass_mg, working_mg_mL: first.plan.rna.working_mg_mL, lipidStock_mM: first.plan.mixing.lipidStock_mM, frr: first.plan.mixing.frr, quenchFactor: first.plan.mixing.quenchFactor, flows: first.plan.mixing.flows, ionizableMolPct: ionizablePct, massPerPhosphate: massPerPhosphate(first.plan, rna) }).np; } catch {}
  }
  const stock = first?.stockId ? ctx.store.get('stocks', first.stockId) : null;
  const res = experimentResults(exp, batches, measurements, { qc: settings.qc });
  const stage = progressStage(exp, batches, today);
  const compLabel = (cid) => { const c = ref.compositionById[cid]; return c ? `#${c.id}${c.synonym ? ` ${c.synonym}` : ''}` : `#${cid}`; };
  const stocks = ctx.store.all('stocks');

  const overview = `<div class="grid g4">
    ${kpi('Composition', comp ? `#${comp.id} ${comp.synonym || ''}` : '–', comp ? Object.entries(comp.mol_pct).map(([k, v]) => `${lipidLabel(ref, k)} ${v}`).join(' / ') : '')}
    ${kpi('Lipid stock', stock ? stock.id : first?.stockId ? `${first.stockId} (deleted)` : 'not chosen', stock ? `${fmt(stock.molarity_mM, 1)} mM · ${stock.status}${ftTag(stock, settings.ftWarnCycles)}` : stage.planned && !first?.stockId ? 'set it below for every formulation, or on a record' : '')}
    ${kpi(`RNA · ${cargo}`, rna ? rna.id : first?.plan?.rna?.lotId ? `${first.plan.rna.lotId} (deleted)` : 'not chosen', rna ? `${rna.construct || ''} · ${fmt(rna.conc_mg_mL, 2)} mg/mL` : '')}
    ${kpi('N/P', np != null ? fmt(np, 1) : '–', ionizablePct ? `ionizable ${fmt(ionizablePct, 1)} mol% · ${cargo} usually about ${cargoInfo(cargo).defaultNP}` : 'needs ionizable class in composition')}
    ${kpi('Mixing', first ? `${fmt(first.plan.mixing.totalFlow, 1)} mL/min` : '–', first ? `FRR ${fmt(first.plan.mixing.frr, 1)} : 1 · quench ×${first.plan.mixing.quenchFactor}` : '')}
    ${kpi('Progress', `${p.done} / ${p.total}`, p.overdue ? `${p.overdue} overdue` : p.dueToday.length ? `${p.dueToday.length} due today` : '')}
    ${kpi('Next due', p.nextDue ? fmtDate(p.nextDue) : 'nothing open', '')}
  </div>`;

  // A factor by the short name the bench uses (FRR, TFR, PEG mol%): a run of an optimizer round or a design varies
  // four of them, and their full names made the column the longest thing on the page. The full names are the
  // cell's title.
  const factorName = (k) => FACTORS.find((f) => f.key === k)?.name || COMPOSITION_FACTORS.find((f) => f.key === k)?.name || k;
  const factorCell = (factors) => {
    const fs = Object.entries(factors || {});
    if (!fs.length) return '–';
    // a mixer by its name, never its id
    const val = (k, v) => (k === 'mixer' ? ref.mixers?.find((m) => m.id === v)?.name || exp.design?.labels?.[v] || v : v);
    const say = (name) => fs.map(([k, v]) => `${name(k)} = ${val(k, v)}`).join(', ');
    return raw(`<span title="${esc(say(factorName))}">${esc(say((k) => FACTOR_SHORT[k] || factorName(k)))}</span>`);
  };
  const batchRows = batches.map((b) => {
    const d = latest(b.id, 'dls'), e = latest(b.id, 'ee');
    return { cells: [raw(`<a href="#/formulation?batch=${b.id}"><b>${b.id}</b></a>`), b.doe ? raw(`${b.label}${b.doe.well ? ` <span class="chip">${b.doe.well}</span>` : ''}`) : b.label, factorCell(b.plan.factors), fmtDate(b.plannedDate), raw(chip(b.status, b.status === 'planned' ? '' : b.status === 'produced' ? 'info' : 'ok')),
      d ? `${fmt(d.values.zave_nm, 1)} / ${fmt(d.values.pdi, 2)}` : '–', e ? fmt(e.values.ee_pct, 1) : '–', raw(`<a href="#/formulation?batch=${b.id}">Record</a> · <a href="#/measurements?batch=${b.id}">Measure</a>`)] };
  });

  // An experiment the ML optimizer proposed carries what the model expected from each run. Showing that next
  // to what came back is the only way the user finds out whether to believe it next time, and it is the one
  // comparison a notebook-based optimiser never makes because the prediction is not stored anywhere. The card
  // is one line saying how the predictions did; the run-by-run table opens under it.
  let mlPanel = '';
  if (exp.design?.ml || batches.some((b) => b.ml)) {
    const RESP = [['dls', 'zave_nm', 'particle_size_nm', 'Particle size (nm)', 1, 'Z-ave'], ['dls', 'pdi', 'PDI', 'PDI', 3, 'PDI'], ['ee', 'ee_pct', 'encapsulation_efficiency', 'EE (%)', 1, 'EE']];
    const scored = [];
    const rows = batches.filter((b) => b.ml?.predicted).map((b) => {
      const cells = [raw(`<a href="#/formulation?batch=${b.id}"><b>${b.id}</b></a> <span class="muted">${b.label}</span>`)];
      for (const [test, key, name, , dp, short] of RESP) {
        const p = b.ml.predicted[name];
        const m = latest(b.id, test)?.values?.[key];
        if (!p) { cells.push('–'); continue; }
        scored.push({ batchId: b.id, label: short, mean: p.mean, sd: p.sd, noise: p.noise, measured: Number.isFinite(m) ? m : null });
        const within = Number.isFinite(m) && Math.abs(m - p.mean) <= 1.96 * p.sd;
        cells.push(raw(`${fmt(p.mean, dp)} <span class="muted">± ${fmt(1.96 * p.sd, dp)}</span>`
          + (Number.isFinite(m) ? `<br><b>${fmt(m, dp)}</b> ${chip(within ? 'as predicted' : 'outside the interval', within ? 'ok' : 'warn')}` : '<br><span class="muted">not measured yet</span>')));
      }
      cells.push(raw(`<span class="muted">${b.ml.rationale || ''}</span>`));
      return { cells };
    });
    const verdict = predictionSummary(scored);
    const key = `${exp.id}:ml`;
    mlPanel = `<details class="card fold" id="mlFold" data-resfold="${esc(key)}" ${foldOpen(key) ? 'open' : ''}>
      <summary><h2>What the model expected</h2><span class="fold-say" id="mlVerdict">${esc(verdict.sentence || 'No prediction was stored with these runs.')}</span></summary>
      <p class="muted">Proposed by the ML optimizer on ${fmtDate(batches.find((b) => b.ml)?.ml?.suggestedAt)} in ${esc(batches.find((b) => b.ml)?.ml?.mode || 'balanced')} mode, seed ${esc(String(batches.find((b) => b.ml)?.ml?.seed ?? ''))}.
      Each cell shows the prediction with its 95 % interval and, once measured, the result. A result outside the interval is not a failure: it is the model telling you where it was wrong, which is the most useful run in the batch.</p>
      ${table(['Formulation', 'Particle size (nm)', 'PDI', 'EE (%)', 'Why it was proposed'], rows)}
      <div style="margin-top:8px"><a class="btn" href="#/ml">Back to the optimizer</a></div></details>`;
  }

  // A stability study has no matrix card of its own: the Results card's table has the days across and says
  // in each cell what is due, so the plan and the data are one table instead of two.

  // Every expected measurement, folded into one line: the counts are what is read, the rows only looked up.
  const slotSummary = [`${p.total} expected`, `${p.done} done`, `${p.open} open${p.nextDue ? `, next due ${shortDate(p.nextDue, today)}` : ''}`, p.overdue ? `${p.overdue} overdue` : ''].filter(Boolean).join(' · ');
  const slotsTable = `<div class="card advanced" id="expectedCard"><details id="expectedDetails"><summary><h2>Expected measurements</h2> <span class="muted" id="expectedSummary">${esc(slotSummary)}</span></summary>
    ${table(['Sample name', 'Formulation', 'Stage', 'Test', 'Due', 'Status'],
    exp.expected.slice().sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((s) => ({ cells: [raw(`<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px">${s.sampleName}</span>`), s.batchId, s.stage, s.test, fmtDate(s.dueDate), raw(chip(s.status, s.status === 'done' ? 'ok' : s.dueDate < today ? 'warn' : ''))] })))}</details></div>`;

  // Bench day: one choice for every formulation of the experiment, instead of one record visit each. Stocks
  // of the experiment's own composition come first, as on the record. A select opens on the choice the
  // formulations already share, so an applied choice reads back as applied.
  const shared = (get) => { const v = [...new Set(batches.map(get))]; return v.length === 1 ? v[0] || '' : ''; };
  const stockChoice = shared((b) => b.stockId), rnaChoice = shared((b) => b.plan?.rna?.lotId);
  const stockOpts = [...stocks.filter((s) => s.compositionId === exp.compositionId), ...stocks.filter((s) => s.compositionId !== exp.compositionId)]
    .map((s) => `<option value="${esc(s.id)}" ${s.id === stockChoice ? 'selected' : ''}>${esc(s.id)}${s.compositionId !== exp.compositionId ? ` (#${esc(String(s.compositionId))})` : ''} · ${fmt(s.molarityActual_mM || s.molarity_mM, 1)} mM${s.status ? ` · ${esc(s.status)}` : ''}${esc(ftTag(s, settings.ftWarnCycles))}</option>`).join('');
  const rnaOpts = ref.pick('rnaLots', rnaChoice).map((r) => `<option value="${esc(r.id)}" ${r.id === rnaChoice ? 'selected' : ''}>${esc(r.id)} · ${esc(cargoLabel(r.cargo))} · ${esc(r.construct || '')} · ${fmt(r.conc_mg_mL, 2)} mg/mL</option>`).join('');
  // Bulk inputs go only on what is still to be made (wireBench), so once nothing is planned the bar has nothing
  // left to act on and is not shown.
  const bulkBar = stage.planned ? `<div class="bulkbar" id="bulkBench">
      <button id="markAllProduced" data-bulk="produced" ${stage.planned ? '' : 'disabled'} title="${stage.planned ? `Set the ${stage.planned} planned formulation${stage.planned === 1 ? '' : 's'} to produced` : 'Nothing is still planned'}">Mark all produced</button>
      <span class="bulk-group"><label class="inline" for="bulkStock">Lipid stock for all</label><select id="bulkStock"><option value="">Choose…</option>${stockOpts}</select><button id="applyStock">Apply</button></span>
      <span class="bulk-group"><label class="inline" for="bulkRna">RNA lot for all</label><select id="bulkRna"><option value="">Choose…</option>${rnaOpts}</select><button id="applyRna">Apply</button></span>
    </div>` : '';

  // Repeating opens the wizard filled in from this experiment, to change what the repeat is for before
  // anything is created. An optimizer round has no wizard to come back to: its runs came from a model.
  const repeatLink = T && !exp.design?.ml
    ? `<a class="btn" id="repeatExp" href="#/experiments?new=1&type=${esc(exp.type)}&from=${esc(exp.id)}" title="A new experiment with this one's settings, opened in the wizard so you can change one thing first">Repeat as new</a>`
    : '';
  // The stored status only says what someone last set; until it is "done", the chip says where the records are.
  const shownStatus = exp.status === 'done' ? 'done' : stage.stage;
  const statusKind = shownStatus === 'done' || shownStatus === 'all measured' ? 'ok' : shownStatus === 'planned' ? '' : 'info';
  el.innerHTML = header(raw(`<a href="#/experiments">Experiments</a> › ${esc(describeId(exp.id))}`), exp.name,
      `<span class="chip info">${T?.name || exp.type}</span><span class="chip cargoChip" id="expCargo" title="The cargo the formulations carry">${esc(cargo)}</span><span class="chip ${statusKind}" id="expStage" title="${exp.status === 'done' ? 'Marked done' : 'From the formulations and results on record'}">${esc(shownStatus)}</span>${repeatLink}
      ${['doe', 'ofat'].includes(exp.type) ? `<a class="btn" href="#/doe?id=${exp.id}">Design &amp; results</a>` : ''}<button id="reportExp" title="A page for the lab notebook: the plan, the data table, the statistics and the figures, to print or save as PDF">Report</button><a class="btn" href="#/calendar?month=${exp.startDate.slice(0, 7)}">Calendar</a><button id="setStatus">${exp.status === 'done' ? 'Reopen' : 'Mark done'}</button><button id="delExp" style="color:var(--warn)">Delete</button>`) +
    layerTabBar(ctx, 'core', tabHref, 'Experiment') +
    nextStepStrip(exp, stage, res) +
    `<div class="card">${overview}</div>
     <div id="expProcess"></div>
     <div class="card"><h2>Formulations</h2>${bulkBar}${table(['Formulation', 'What it is', 'Factors', 'Planned', 'Status', 'Z-ave / PDI', 'EE %', ''], batchRows)}</div>
     ${mlPanel}
     ${resultsCard(exp, res, { qc: settings.qc, compLabel, today })}
     ${slotsTable}`;

  wireLearn(el);
  wireFigures(el);
  wireResults(el);
  wireBench(el, ctx, exp, batches, stocks, ref);
  processPanel(el, ctx, exp, batches, ref);
  el.querySelectorAll('#nextShowResults').forEach((b) => b.addEventListener('click', () => el.querySelector('#resultsCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
  // Built from the records, not from this page: the folds and links here mean nothing on paper.
  el.querySelector('#reportExp').addEventListener('click', () => openReport(ctx, exp.id));
  el.querySelector('#exportResults')?.addEventListener('click', () => {
    download(`${exp.id}_results.csv`, resultsCsv(res, { experimentId: exp.id, compositionName: (cid) => (cid != null ? compLabel(cid) : '') }), 'text/csv');
  });
  el.querySelector('#delExp').addEventListener('click', async () => {
    // No "are you sure?" first: the experiment and its formulations go to the trash, and the note that says
    // so puts them back (as does Settings › Recently deleted, for 30 days). An undo costs one click when it is
    // needed; a confirmation costs one every time and is clicked through without being read. Measurements
    // stay where they are, as they always have. The one question: when a study or its values name these
    // formulations (spec 9.5), which then point at records in the trash; the entry is kept there for them.
    const bio = experimentBioUses(ctx.store, exp, batches);
    if (bio.length && !(await ask(`${describeId(exp.id)}: its formulations are named by ${bio.join(' and ')}.\n\nThey keep pointing at them, and the deleted experiment stays in Recently deleted, also past 30 days, until nothing names it. Delete ${describeId(exp.id)}?`))) return;
    const what = `${describeId(exp.id)}${batches.length ? ` and its ${batches.length} formulation${batches.length === 1 ? '' : 's'}` : ''}`;
    const entry = ctx.store.moveToTrash([['experiments', exp.id], ...batches.map((b) => ['batches', b.id])], { kind: 'experiment', label: `${describeId(exp.id)} · ${exp.name || 'untitled'}${batches.length ? ` · ${batches.length} formulation${batches.length === 1 ? '' : 's'}` : ''}` });
    if (entry) toast(`Deleted ${what}`, '', { action: 'Undo', onAction: () => {
      const r = ctx.store.restoreFromTrash(entry.id);
      if (!r.ok) { toast(`Not restored: ${r.reason}`, 'warn'); return; }
      toast(`Restored ${what}`, 'ok'); ctx.navigate('experiments', { id: exp.id });
    } });
    ctx.navigate('experiments');
  });
  el.querySelector('#setStatus').addEventListener('click', () => { exp.status = exp.status === 'done' ? 'running' : 'done'; ctx.store.put('experiments', exp); render(el, ctx); });
  el.querySelector('#copyNames')?.addEventListener('click', () => {
    const next = p.nextDue; if (!next) return;
    const names = [...new Set(exp.expected.filter((s) => s.status === 'open' && s.dueDate === next).map((s) => s.sampleName))].join('\n');
    (navigator.clipboard?.writeText(names) ?? Promise.reject(new Error('no clipboard'))).then(() => toast(`Copied ${names.split('\n').length} sample names for ${fmtDate(next)}`, 'ok'), () => download('sample-names.txt', names, 'text/plain'));
  });
}

/**
 * The experiment's process (app/ui/processviz.js): drawn from its first formulation, with the mode and how many
 * formulations differ from it, and a fold that changes it for every formulation still to make, the way the
 * bulk bench actions set a stock on all of them. A formulation already made keeps the process it was made by,
 * and each record can still change its own.
 */
function processPanel(el, ctx, exp, batches, ref) {
  const box = el.querySelector('#expProcess');
  if (!box || !batches.length) return;
  const open = batches.filter((b) => b.status === 'planned');
  const procs = batches.map((b) => processOf(b.plan, ref));
  const first = procs[0], same = (p) => JSON.stringify(p) === JSON.stringify(first);
  const differ = procs.filter((p) => !same(p)).length;
  let work = JSON.parse(JSON.stringify(open.length ? processOf(open[0].plan, ref) : first));
  let editing = false;
  const quickN = batches.filter((b) => modeOf(b.plan) === 'quick').length;
  const vols = [...new Set(batches.filter((b) => modeOf(b.plan) === 'quick').map((b) => Number(b.plan.volume_mL)).filter(Number.isFinite))].sort((a, b) => a - b);
  const volText = vols.length === 1 ? `${fmt(vols[0], 2)} mL each` : vols.length ? `${fmt(vols[0], 2)}–${fmt(vols[vols.length - 1], 2)} mL` : '';
  const mode = quickN === batches.length ? `Quick: mixing only${volText ? `, ${volText}` : ''}` : quickN ? `${quickN} of ${batches.length} quick (mixing only), the rest the full process` : 'Full process';
  const fb = batches[0];
  const draw = () => {
    const quick = quickN === batches.length;
    box.innerHTML = `<div class="card" id="processCard"><div class="benchHead"><h2>Process</h2>${chip(mode, 'info')}<span class="muted">${esc(processSummary(first, ref, { quick }))}</span></div>
      <div class="processDraw">${processSvg(first, ref, { quick, flows: fb.plan?.mixing?.flows, lipid_mM: fb.plan?.mixing?.lipidStock_mM })}</div>
      ${differ ? `<p class="muted" style="margin:6px 0 0">Drawn from ${esc(fb.id)}; ${differ} formulation${differ === 1 ? ' has' : 's have'} a process of ${differ === 1 ? 'its' : 'their'} own, shown on ${differ === 1 ? 'its' : 'their'} record.</p>` : ''}
      ${open.length ? `<details class="fold sub" id="expProcessEdit" ${editing ? 'open' : ''}><summary><h2>Change the process for the ${open.length} formulation${open.length === 1 ? '' : 's'} still to make</h2></summary>
        ${processEditor(work, ref, { quick, uid: 'exp' })}
        <div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap"><button class="primary" id="applyProcess">Apply to ${open.length} formulation${open.length === 1 ? '' : 's'}</button>
        <span class="muted">Formulations already made keep the process they were made by.</span></div></details>` : ''}</div>`;
    const ed = box.querySelector('#expProcessEdit');
    ed?.querySelector('summary').addEventListener('click', () => { editing = !ed.open; });
    const take = (e) => { const next = applyProcessField(work, e.target.name, e.target.type === 'checkbox' ? e.target.checked : e.target.value, ref); if (next) work = next; return !!next; };
    ed?.addEventListener('input', (e) => { if (e.target.type !== 'checkbox' && e.target.tagName !== 'SELECT') take(e); });
    ed?.addEventListener('change', (e) => { if (take(e)) redrawSoon(ed, () => { editing = true; draw(); }); });
    if (ed) wireProcessButtons(ed, () => work, (next) => { work = next; editing = true; draw(); }, ref);
    box.querySelector('#applyProcess')?.addEventListener('click', () => {
      for (const b of open) {
        b.plan ||= {}; b.plan.mixing ||= {};
        b.plan.process = JSON.parse(JSON.stringify(work));
        adoptProcess(b.plan, ref); // the record's older copies of the same choices go
        b.plan.mixing.flows = flowsFromTotal(b.plan.mixing.totalFlow || 112.5, b.plan.mixing.frr || 3, effectiveQuench(b.plan));
        syncQuick(b.plan);
        ctx.store.put('batches', b);
      }
      toast(`Process set on ${open.length} formulation${open.length === 1 ? '' : 's'}`, 'ok');
      render(el, ctx);
    });
  };
  draw();
}

/**
 * The bulk bench actions of an experiment page: mark every planned formulation produced, and set one lipid
 * stock or one RNA lot on all of them. Each writes exactly what choosing it on every record would have
 * written, so a record opened afterwards cannot tell the difference.
 */
function wireBench(el, ctx, exp, batches, stocks, ref) {
  const plural = (n) => `${n} formulation${n === 1 ? '' : 's'}`;
  // Only "planned" moves: a formulation already measured or analysed must not be sent back to "produced".
  const markProduced = () => {
    const todo = batches.filter((b) => b.status === 'planned');
    if (!todo.length) { toast('Nothing is still planned'); return; }
    for (const b of todo) { b.status = 'produced'; ctx.store.put('batches', b); }
    toast(`Marked ${plural(todo.length)} produced`, 'ok');
    render(el, ctx);
  };
  el.querySelectorAll('[data-bulk="produced"]').forEach((b) => b.addEventListener('click', markProduced));

  // Choosing a stock on a record also sets the lipid concentration the mixing plan is worked out from. The
  // bulk choice does the same, except where that concentration is a factor the experiment varies: a DoE or
  // OFAT factor, or an optimizer round whose runs carry their own lipid_mM.
  const lipidVaried = exp.design?.factor === 'lipid_mM' || (exp.design?.doe?.spec?.factors || []).some((f) => f.applyTo === 'lipid_mM')
    || batches.some((b) => Number.isFinite(Number(b.plan?.factors?.lipid_mM)));
  // Bulk inputs go only on what is still to be made. A formulation already produced was made from whatever its
  // record says, and rewriting that afterwards would leave a record of a stock it never saw.
  const open = batches.filter((b) => b.status === 'planned');
  const left = (n, why) => (n ? ` · ${n} left as recorded (${why})` : '');
  el.querySelector('#applyStock')?.addEventListener('click', () => {
    const s = stocks.find((x) => x.id === el.querySelector('#bulkStock').value);
    if (!s) { toast('Choose a lipid stock first', 'warn'); return; }
    // and only on formulations of the stock's own recipe: arm 2 of a comparison is not mixed from arm 1's lipids
    const fits = open.filter((b) => s.compositionId == null || Number(b.compositionId) === Number(s.compositionId));
    for (const b of fits) {
      b.stockId = s.id;
      const mM = s.molarityActual_mM || s.molarity_mM;
      if (!lipidVaried && Number.isFinite(mM)) { b.plan ||= {}; b.plan.mixing ||= {}; b.plan.mixing.lipidStock_mM = mM; }
      ctx.store.put('batches', b);
    }
    const otherRecipe = open.length - fits.length, made = batches.length - open.length;
    toast(`Lipid stock ${s.id} set on ${plural(fits.length)}${left(otherRecipe, `another composition than #${s.compositionId}`)}${left(made, 'already made')}`, fits.length ? 'ok' : 'warn');
    render(el, ctx);
  });
  el.querySelector('#applyRna')?.addEventListener('click', () => {
    const r = ref.rnaLots.find((x) => x.id === el.querySelector('#bulkRna').value);
    if (!r) { toast('Choose an RNA lot first', 'warn'); return; }
    for (const b of open) {
      b.plan ||= {}; b.plan.rna ||= {};
      b.plan.rna.lotId = r.id;
      if (Number.isFinite(r.conc_mg_mL)) b.plan.rna.stock_mg_mL = r.conc_mg_mL;
      b.plan.rna.cargo = cargoInfo(r.cargo).id; // the formulation carries what its lot carries
      ctx.store.put('batches', b);
    }
    toast(`RNA lot ${r.id} set on ${plural(open.length)}${left(batches.length - open.length, 'already made')}`, open.length ? 'ok' : 'warn');
    render(el, ctx);
  });
}
