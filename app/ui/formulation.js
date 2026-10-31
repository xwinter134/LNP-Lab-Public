// Screen: Formulations — the list, grouped by the experiment that planned them, and one formulation's record:
// the six steps with calculated targets beside the actuals the operator enters.
import { raw, fmt, field, table, chip, toast, printHtml, header, todayISO, fmtDate, esc, redrawSoon, swapHtml, autoSaver, sharedRecord, ask } from './kit.js';
import { getRef, getSettings, compositionLabel, lipidLabel } from '../refdata.js';
import { rnaDilution, mixingPlan, dialysisPlan, tffPlan, finalFormulationPlan, biosafetyAliquot, fillFinish, IPC_STAGES } from '../calc/batch_record.js';
import { normaliseRoles, bufferAnswersTo } from '../calc/buffer.js';
import { archivedSet } from '../calc/usage.js';
import { VARIABLES, TYPED_VARIABLES, VARIABLE_STEPS, readVariable, sourceOf, checkVariable } from '../calc/variables.js';
import { provenanceLine } from '../calc/provenance.js';
import { bufferCode } from '../calc/buffer.js';
import { flowsFromTotal, TYPES, experimentProgress } from '../calc/experiment.js';
import { describeId } from '../schema.js';
import { batchIndex, measurementIndex, batchResults, pageOf } from '../calc/indexes.js';
import { moreLine, focusFirstNew } from './pager.js';

import { overriddenComposition, absorbedPhrase } from '../calc/composition.js';
import { adoptProcess, stepOf, effectiveQuench, modeOf, quickVolumes, quickVolumeFor, syncQuick, processSummary, bufferLine, deviceOf, mixerOf, QUICK_VOLUME_mL } from '../calc/process.js';
import { processSvg, processEditor, applyProcessField, wireProcessButtons, newStep, processRows } from './processviz.js';
import { printSvg } from './charts.js';
import { fingerprintBlock } from './report.js';
import { customDefs, customCard, setCustom } from './customparams.js';
import { cargoOf, cargoLabel, cargoInfo, massPerPhosphate } from '../calc/cargo.js';
import { withThaw, thawedOn, thawsOf, overThaw, ftTag, ftWords } from '../calc/freezethaw.js';
import { thawLine } from './thaw.js';
import { layerTab, layerTabBar, renderLayerTab, formulationCrumb } from './biolayers.js';

/** The record field a `ds_<step>_…` input writes to, where the step's short name is not the field's name. */
const DS_STEP = { final: 'finalFormulation' };

// The recipe a batch is made from is worked out in calc/composition.js, where the DoE run table and the stock
// weigh-in read it too. Re-exported under its old name for anything that imported it from this screen.
export { overriddenComposition };

/** What this batch will actually be made from, when that differs from the registry entry it points at. */
function compositionNote(comp, registryComp, overridden, ref) {
  if (!overridden || !comp) return '';
  // The lipid that took up the difference says so in the list itself, where the operator reads the number.
  const bal = comp.balancedBy && !comp.balancedBy.impossible ? comp.balancedBy : null;
  const list = Object.entries(comp.mol_pct)
    .map(([k, v]) => `${lipidLabel(ref, k)} ${fmt(v, 2)}${bal?.keys.includes(k) ? ` (${absorbedPhrase(bal)})` : ''}`).join(' · ');
  const off = Math.abs((comp.sum ?? 100) - 100) > 0.05;
  const why = comp.fromMixtureDesign
    ? 'This run <b>is</b> the blend: a mixture design set every lipid directly, so weigh out what is listed here and not the registry recipe.'
    : `It is made from ${list}, not the ${registryComp?.synonym ? `"${esc(registryComp.synonym)}" ` : ''}registry recipe for #${registryComp?.id ?? '?'}.`;
  const sterolWord = (b) => (b.keys.length === 1 ? lipidLabel(ref, b.keys[0]) : 'the sterol');
  const total = !off
    ? 'The total is 100 mol%.'
    : comp.balancedBy?.impossible
      ? `The adjusted mol% totals <b>${fmt(comp.sum, 2)}</b>, not 100. The change is larger than ${esc(sterolWord(comp.balancedBy))} can absorb (it would have to be ${fmt(comp.balancedBy.wouldBe, 2)} mol%), so this run cannot be made as planned. Narrow the range in the experiment.`
      : `The adjusted mol% totals <b>${fmt(comp.sum, 2)}</b>, not 100, and no lipid was left free to take up the difference (the recipe has no sterol, or the experiment set it too). Decide which lipid absorbs it before weighing out.`;
  // The weigh-in starts from this recipe rather than the registry one, which is what the stock needs to be.
  const stock = registryComp?.id != null
    ? ` <a href="#/stocks?new=1&compositionId=${encodeURIComponent(registryComp.id)}&mol=${encodeURIComponent(JSON.stringify(comp.mol_pct))}">Weigh out a lipid stock of this recipe</a>`
    : '';
  return `<div class="note ${off ? 'warn' : ''}"><b>This batch varies the composition.</b> ${comp.fromMixtureDesign ? `${why} ${list}.` : why}
    ${total}${stock}</div>`;
}

/** A number as it is typed into an input: 3 and 112.5, not 3.00 and 112.50. For the "worked out from" lines. */
const asTyped = (x, digits = 3) => { const s = fmt(x, digits); return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s; };

/**
 * "At the bench": the handful of numbers an operator measures out or sets, in the order the bench needs them —
 * make up the RNA working solution, fill the syringes, set the pumps, load the dialysis cassette.
 *
 * Usability cycle 2 (F3): these sat in steps 1 and 2 of the record among some 850 words of targets, lots and
 * checkboxes, to be found again for every batch with gloves on. Every value here is read off compute()'s result,
 * the same object the step tables and the worksheet are printed from, and nothing is worked out a second time,
 * so the card and the steps cannot disagree; the decimals follow the step tables for the same reason. Each value
 * carries the inputs it was worked out from (shown on hover), named as the Inputs card names them, and a value
 * that cannot be worked out yet says what it is waiting for instead of showing a number.
 *
 * Returns [{ title, note, items: [{ key, label, v, unit, digits, sub, from, wait }] }] in bench order.
 */
function benchNumbers(c, batch) {
  const plan = batch.plan, ds = plan.downstream, m = c.mix, lot = plan.rna.lotId, proc = plan.process || {};
  const waitFor = (...why) => [...new Set(why.filter(Boolean))].join(' and ') || null;
  const noMass = c.mass > 0 ? null : 'enter the RNA input (mg)';
  const noStock = c.stock_mg_mL > 0 ? null : 'choose an RNA lot';
  // A stock weaker than the working solution cannot be diluted to it; step 1 would show a negative buffer volume.
  const weak = !noStock && c.stock_mg_mL < c.working
    ? `the RNA stock (${asTyped(c.stock_mg_mL)} mg/mL) is weaker than the working conc. (${asTyped(c.working)} mg/mL)` : null;
  const noMix = m ? null : c.err || 'check the inputs';
  const rnaIn = `RNA input ${asTyped(c.mass)} mg`;

  const working = {
    title: '1 · RNA working solution',
    note: c.dil && !noMass && !weak ? `makes ${fmt(c.dil.total_mL, 3)} mL at ${asTyped(c.working)} mg/mL` : '',
    items: [
      { key: 'rna_stock_mL', label: 'RNA stock to pipette', v: c.rnaStock_mL, unit: 'mL', digits: 3,
        sub: lot ? `${lot} · ${asTyped(c.stock_mg_mL)} mg/mL` : noStock ? '' : `stock at ${asTyped(c.stock_mg_mL)} mg/mL`,
        from: `${rnaIn} ÷ RNA stock conc. ${asTyped(c.stock_mg_mL)} mg/mL${lot ? ` (RNA lot ${lot})` : ''}`,
        wait: waitFor(noStock, noMass) },
      { key: 'rna_buffer_mL', label: 'Buffer to add', v: c.dil?.diluent_mL, unit: 'mL', digits: 3,
        sub: proc.aqueous?.buffer || 'dilution buffer',
        from: c.dil ? `Working solution ${fmt(c.dil.total_mL, 3)} mL (${rnaIn} ÷ RNA working conc. ${asTyped(c.working)} mg/mL) − RNA stock ${fmt(c.rnaStock_mL, 3)} mL` : '',
        wait: waitFor(noStock, noMass, weak) },
    ],
  };

  const npNote = c.npLipid_mL ? `N/P target: ${fmt(c.npLipid_mL, 2)} mL → FRR ${fmt(c.npFrr, 2)}` : '';
  // Quick mode starts from the volume to formulate, and the mRNA it holds is the first number at the bench.
  const noVolume = c.quick && !c.qv ? 'enter the volume to formulate' : null;
  const parts = `${asTyped(c.frr)} + 1${c.quench ? ` + ${asTyped(c.quench)}` : ''}`;
  const syringes = {
    title: c.quick ? '1 · At the mixer' : '2 · Syringes',
    note: c.quick && c.qv ? `${fmt(c.qv.volume_mL, 2)} mL of product at ${fmt(c.qv.product_mg_mL, 3)} mg/mL ${c.cargoName}` : '',
    items: [
      ...(c.quick ? [{ key: 'quick_rna_mg', label: c.cargoName, v: c.qv?.rna_mg, unit: 'mg', digits: 3, sub: c.qv ? `in ${asTyped(c.qv.volume_mL)} mL` : '',
        from: `Volume ${asTyped(plan.volume_mL)} mL × RNA working conc. ${asTyped(c.working)} mg/mL × FRR ${asTyped(c.frr)} ÷ (${parts})`, wait: noVolume }] : []),
      { key: 'rna_mL', label: c.quick ? 'Aqueous (RNA) phase' : 'RNA phase', v: m?.rna_mL, unit: 'mL', digits: 2, sub: `at ${asTyped(c.working)} mg/mL`,
        from: `${rnaIn} ÷ RNA working conc. ${asTyped(c.working)} mg/mL`, wait: waitFor(noVolume, noMix, noMass) },
      { key: 'lipid_mL', label: 'Lipid / ethanol', v: m?.lipid_mL, unit: 'mL', digits: 2,
        sub: npNote || (batch.stockId ? `${batch.stockId} · ${asTyped(c.lipid_mM, 1)} mM` : 'lipid stock lot not chosen'),
        from: m ? `RNA phase ${fmt(m.rna_mL, 2)} mL ÷ FRR (aq : org) ${asTyped(c.frr)}` : '', wait: waitFor(noVolume, noMix, noMass) },
      // a process without quench has no quench to prepare
      ...(c.quench ? [{ key: 'quench_mL', label: 'Quench', v: m?.quench_mL, unit: 'mL', digits: 2,
        sub: m ? `prepare ${fmt(m.quenchNeeded_mL, 2)} mL${proc.quenchBuffer?.buffer ? ` · ${proc.quenchBuffer.buffer}` : ''}` : '',
        from: m ? `Lipid / ethanol ${fmt(m.lipid_mL, 2)} mL × Quench factor ${asTyped(c.quench)}; prepare 10 % more` : '', wait: waitFor(noVolume, noMix, noMass) }] : []),
    ],
  };

  // The pumps split the total flow FRR : 1 : quench factor (flowsFromTotal). A plan can also carry its own pump
  // flows, and then the hover must not claim they came from the total.
  const f = c.flows, split = flowsFromTotal(c.total, c.frr, c.quench);
  const fromTotal = ['p1', 'p2', 'p3'].every((k) => Math.abs((f[k] ?? 0) - split[k]) < 1e-6 * Math.max(1, c.total));
  const own = 'pump flow stored on this formulation\'s plan';
  const pumps = {
    title: '2 · Pumps',
    note: '',
    items: [
      { key: 'p1', label: 'Pump 1 · RNA', v: f.p1, unit: 'mL/min', digits: 2,
        from: fromTotal ? `Total flow ${asTyped(c.total)} mL/min × FRR ${asTyped(c.frr)} ÷ (${parts})` : own },
      { key: 'p2', label: 'Pump 2 · lipid', v: f.p2, unit: 'mL/min', digits: 2,
        from: fromTotal ? `Total flow ${asTyped(c.total)} mL/min ÷ (${parts}), from FRR (aq : org) and Quench factor` : own },
      ...(c.quench || f.p3 > 0 ? [{ key: 'p3', label: 'Pump 3 · quench', v: f.p3, unit: 'mL/min', digits: 2,
        from: fromTotal ? `Total flow ${asTyped(c.total)} mL/min × Quench factor ${asTyped(c.quench)} ÷ (${parts})` : own }] : []),
      ...(f.p4 > 0 ? [{ key: 'p4', label: 'Pump 4', v: f.p4, unit: 'mL/min', digits: 2, from: own }] : []),
      { key: 'totalFlow', label: 'Total', v: m?.totalFlow, unit: 'mL/min', digits: 2, total: true,
        from: `Sum of the pumps${fromTotal ? `; Total flow (mL/min) is ${asTyped(c.total)}` : ''}`, wait: noMix },
    ],
  };

  const typedStart = Boolean(ds.dialysis?.start_mL);
  const dialysis = {
    title: '3 · Dialysis',
    note: '',
    items: [
      { key: 'dialysis_start_mL', label: 'Start volume', v: c.startDia, unit: 'mL', digits: 2,
        sub: typedStart ? 'as entered in step 3' : '',
        from: typedStart ? 'Start volume (mL), entered in step 3'
          : m ? `Primary product: ${rnaIn} ÷ ${fmt(m.primary_mg_mL, 3)} mg/mL (RNA working conc. × pump 1 ÷ total flow)` : '',
        wait: typedStart ? null : waitFor(noMix, noMass) },
    ],
  };
  if (c.quick) return [syringes, pumps];
  return [working, syringes, pumps, ...(stepOf(proc, 'dialysis') ? [dialysis] : [])];
}

/** A bench value as shown: the number, or "—" with what it is waiting for. Shared by the card and the worksheet. */
const benchValue = (it) => {
  const ok = !it.wait && it.v != null && Number.isFinite(it.v);
  return { ok, num: ok ? fmt(it.v, it.digits) : '—', sub: ok ? it.sub || '' : it.wait || 'check the inputs' };
};

/** The card at the top of the record. Display only: no inputs, so the record's change handling is untouched. */
function benchCard(groups) {
  const tile = (it) => {
    const v = benchValue(it);
    const hover = v.ok ? `${it.label}: ${fmt(it.v, it.digits)} ${it.unit}. From ${it.from}.` : `${it.label}: ${v.sub}.`;
    return `<div class="benchTile${it.total ? ' total' : ''}${v.ok ? '' : ' waiting'}" data-bench="${it.key}" title="${esc(hover)}">
      <div class="bl">${esc(it.label)}</div>
      <div class="bv">${v.num}${v.ok ? `<span class="bu"> ${it.unit}</span>` : ''}</div>
      ${v.sub ? `<div class="bs">${esc(v.sub)}</div>` : ''}</div>`;
  };
  return `<div class="card benchCard" id="atBench">
    <div class="benchHead"><h2>At the bench</h2><span class="muted">In bench order. Hover a number for what it was worked out from.</span></div>
    <div class="benchSteps">${groups.map((g) => `<section class="benchStep" style="--n:${g.items.length}"><h3>${esc(g.title)}</h3>
      <div class="benchTiles">${g.items.map(tile).join('')}</div>${g.note ? `<div class="muted benchNote">${esc(g.note)}</div>` : ''}</section>`).join('')}</div>
  </div>`;
}

/**
 * The same block at the top of the printed worksheet. printHtml() owns the page's style sheet, so this carries
 * its own few rules; the numbers are large because the sheet is read from arm's length beside the pumps.
 */
function benchPrint(groups) {
  const css = `<style>.bench{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 10px}.bench .bg{border:1px solid #999;padding:4px 7px 6px;flex:1 1 auto}
    .bench .bt{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#444;margin-bottom:3px}.bench .bis{display:flex;gap:12px}
    .bench .bl{font-size:10.5px;color:#333}.bench .bv{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}.bench .bv span{font-size:10.5px;font-weight:400}
    .bench .bs{font-size:9.5px;color:#555}.bench .wait{color:#8a4b00}</style>`;
  const item = (it) => {
    const v = benchValue(it);
    return `<div><div class="bl">${esc(it.label)}</div><div class="bv">${v.num}${v.ok ? `<span> ${it.unit}</span>` : ''}</div>${v.sub ? `<div class="bs${v.ok ? '' : ' wait'}">${esc(v.sub)}</div>` : ''}</div>`;
  };
  return `${css}<h2>At the bench</h2><div class="bench">${groups.map((g) => `<div class="bg"><div class="bt">${esc(g.title)}</div><div class="bis">${g.items.map(item).join('')}</div>${g.note ? `<div class="bs">${esc(g.note)}</div>` : ''}</div>`).join('')}</div>`;
}

/*
 * The steps of the record fold to one line each — "Step 3 · Dialysis — not started · start volume 15.00 mL" — and
 * the step the batch is at opens (usability cycle 3, F1). With all six laid out whatever the batch's state the
 * record ran to some 950 words: planning a batch meant reading past the dialysis log, and recording one meant
 * scrolling past the RNA dilution finished the day before.
 */

/** Whether an actual has been entered: a cleared number is null, a cleared text '', an unticked box false. */
const entered = (x) => x != null && x !== '' && x !== false;

/**
 * The actuals each step records, and the ones that close it. A step is done by what is written at its end — the
 * sign-off, the volume that comes out of it, the sample taken after it — not by any entry, because a lot number
 * or a ticked pre-test is written while the step is still going on.
 */
const STEP_RECORDS = [
  { n: 1, keys: ['rna_stock_mL', 'rna_total_mL', 'rna_diluent_lot', 'rna_operator', 'rna_date'],
    closed: (a) => entered(a.rna_date) || (entered(a.rna_stock_mL) && entered(a.rna_total_mL)) },
  { n: 2, keys: ['quench_lot', 'p1', 'p2', 'p3', 'primary_mL', 'pretest'], closed: (a) => entered(a.primary_mL) },
  { n: 3, keys: ['dialysis_lot', 'dialysis_start', 'dialysis_exchange', 'dialysis_end', 'dialysis_end_mL', 'ipc4', 'dialysis_remarks'],
    closed: (a) => entered(a.dialysis_end_mL) || entered(a.dialysis_end) || entered(a.ipc4) },
  { n: 4, keys: ['tff_lot', 'tff_end_mL', 'tff_sanitized', 'tff_flushed', 'ipc5'], closed: (a) => entered(a.tff_end_mL) || entered(a.ipc5) },
  { n: 5, keys: ['compounded', 'prefilter_lot', 'sterile_lot', 'filtered', 'ipc6'], closed: (a) => entered(a.filtered) },
  { n: 6, keys: ['storage', 'filled'], closed: (a) => entered(a.filled) },
];

/**
 * Where each step stands, and the one to open: the first step that is neither closed nor followed by a step
 * with something recorded in it. Dialysis cannot have started before the mixing, so a record further on means
 * the earlier steps were done, whether or not anyone wrote them down; opening the RNA dilution then would be
 * opening the wrong step. Such a step, and every open step of a batch already made, reads "not recorded"
 * rather than "not started". A batch with its results in has no step to be at, so nothing opens. A step the
 * process does not have (no dialysis, no TFF) is skipped and never opens, and quick mode has the mixing alone.
 *
 * Returns { steps: [{ n, state }], current: n | null }.
 */
function stepProgress(batch) {
  const a = batch.actual || {};
  const proc = batch.plan?.process, quick = modeOf(batch.plan) === 'quick';
  const steps = STEP_RECORDS.map((s) => ({
    n: s.n, skipped: (quick && s.n !== 2) || (s.n === 3 && !!proc && !stepOf(proc, 'dialysis')) || (s.n === 4 && !(proc ? stepOf(proc, 'tff') : batch.plan?.downstream?.tff?.enabled)),
    recorded: s.keys.some((k) => entered(a[k])), closed: s.closed(a),
  }));
  const made = batch.status !== 'planned', finished = FINISHED.has(batch.status);
  let current = null;
  steps.forEach((s, i) => {
    const later = steps.slice(i + 1).some((t) => !t.skipped && (t.recorded || t.closed));
    const passed = made || later;
    s.state = s.skipped ? 'skipped' : s.closed ? 'done'
      : s.recorded ? (passed ? 'part recorded' : 'in progress')
      : passed ? 'not recorded' : 'not started';
    if (current == null && !finished && !s.skipped && !s.closed && !later) current = s.n;
  });
  return { steps, current };
}

export async function render(el, ctx) {
  const ref = getRef(ctx), settings = getSettings(ctx);
  const batch = ctx.params.batch ? ctx.store.get('batches', ctx.params.batch) : null;
  if (!batch) return list(el, ctx);
  const exp = ctx.store.get('experiments', batch.experimentId);
  // A biological layer's tab (spec 8.5) is its own view; the bench record below is the "Formulation" tab.
  const tabHref = (t) => `#/formulation?batch=${encodeURIComponent(batch.id)}${t ? `&tab=${t}` : ''}`;
  const onLayer = layerTab(ctx);
  if (onLayer) return renderLayerTab(el, ctx, { layer: onLayer, batchIds: [batch.id], crumb: formulationCrumb(batch), title: describeId(batch.id), bar: layerTabBar(ctx, onLayer, tabHref), what: batch.id });
  // A batch may carry a composition override: the DoE and ML modules write one when a run varies lipid mol%.
  // The operator follows this screen, so it has to show the recipe that will actually be weighed out, not the
  // registry entry the batch was derived from.
  const registryComp = ref.compositionById[batch.compositionId];
  const comp = overriddenComposition(registryComp, batch.plan?.compositionOverride, ref);
  const overridden = comp !== registryComp;
  const stocks = ctx.store.all('stocks');
  // Archived lots are not offered (spec 9.5), but the lot a batch already names always is, under whichever name
  // it was written with (a lot saved before 0.14 is Buffer-NNN, a newer one is code-pH-date).
  const goneBuffers = archivedSet(ctx.store, 'buffer');
  const bufferOpts = (role, current) => {
    const made = ref.buffers.filter((b) => bufferAnswersTo(b, current) || (!goneBuffers.has(String(b.id)) && (!role || normaliseRoles(b.roles).includes(role) || !(b.roles || []).length)))
      .map((b) => ({ value: bufferAnswersTo(b, current) ? current : b.lot, label: `${b.lot}${bufferAnswersTo(b, current) && current !== b.lot ? ` (${current})` : ''} · ${b.name}` }));
    const cat = ref.buffersCatalog.filter((b) => !role || normaliseRoles(b.roles).includes(role)).map((b) => ({ value: b.name + (b.code ? ` (${b.code})` : ''), label: `${b.name} (common buffer)` }));
    return [{ value: '', label: '—' }, ...made, ...cat];
  };
  // The parts of the record the screen works on, with what an older record lacks filled in. Again whenever the
  // record is brought up to date with what another window stored (below), which may have put new objects in.
  let plan, ds, a;
  const settle = () => {
    plan = batch.plan; plan.rna ||= {}; plan.mixing ||= {}; plan.downstream ||= {}; batch.actual ||= {};
    // The process (device, mixer, buffers, downstream steps) lives on plan.process; an older record's own
    // fields for it move there, so the record holds one answer (calc/process.js).
    adoptProcess(plan, ref);
    ds = plan.downstream; ds.dialysis ||= { volume_L: 2.5, hours: 16 }; ds.tff ||= { target_mg_mL: 0.133 };
    ds.finalFormulation ||= { measured_mg_mL: null, final_mg_mL: settings.defaultFinal_mg_mL, buffer1: '', buffer2: '' }; ds.filtration ||= { prefilter: 'None', sterile: ref.materials.filters[2] || '' }; ds.fill ||= [{ container: '2R glass', count: 20, fill_mL: 0.5 }];
    a = batch.actual;
  };
  settle();
  // Which steps are open. One the user opened or closed stays as they left it through every redraw; one they
  // have not touched is open when the batch has been at it during this visit, so closing a step's last entry
  // opens the next one below it without folding away the step still being written in.
  const stepOpen = new Map(), reached = new Set();
  let editOpen = false; // the process designer's fold, as the user left it
  let conditionsOpen = false; // the process conditions card, folded until opened, and kept as left through redraws
  // Stored as it is filled in (usability cycle 5, K6). The record used to keep its values until "Save", and a
  // value typed before a click on the sidebar was gone when the record was opened again; the rest of the app
  // stores as you go, and a bench record is filled in over a day, between other screens. What is stored is what
  // was changed here, over the record as it is stored now: the same record may be open in another window too.
  const shared = sharedRecord(ctx.store, 'batches', batch);
  const saver = autoSaver(ctx.store, () => {
    if (!shared.take()) return `${batch.id} was moved to the trash, here or in another window`;
    settle();
    ctx.store.put('batches', batch);
    shared.stored();
  });
  let formEl = null; // the form as last drawn
  // Another window stored this record: show it as stored, with anything still being typed here laid over it.
  shared.watch(() => !!formEl?.isConnected, (now) => {
    if (!now || !shared.take()) { saver.now(); return; } // says it is not saved, and why
    settle();
    saver.note('Changed in another window: shown as stored there');
    redrawSoon(formEl, () => swapHtml(el, draw));
  });

  function compute() {
    const stock = stocks.find((s) => s.id === batch.stockId);
    const rnaLot = ref.rnaLots.find((r) => r.id === plan.rna.lotId);
    const stock_mg_mL = plan.rna.stock_mg_mL ?? rnaLot?.conc_mg_mL ?? null;
    const working = plan.rna.working_mg_mL || settings.defaultWorking_mg_mL;
    const lipid_mM = plan.mixing.lipidStock_mM || stock?.molarityActual_mM || stock?.molarity_mM || settings.defaultLipidStock_mM;
    // The quench the pumps run: 0 when the process has none, whatever the factor field says.
    const frr = plan.mixing.frr || settings.defaultFRR, quench = effectiveQuench(plan, settings.defaultQuenchFactor), total = plan.mixing.totalFlow || 112.5;
    const flows = plan.mixing.flows || flowsFromTotal(total, frr, quench);
    // Quick mode: the volume is the input and the mRNA follows from it (calc/process.js, docs/FORMULAS.md).
    const quick = modeOf(plan) === 'quick';
    const qv = quick ? quickVolumes({ volume_mL: plan.volume_mL, working_mg_mL: working, frr, quenchFactor: quench }) : null;
    const mass = quick ? qv?.rna_mg || 0 : plan.rna.mass_mg || 0;
    const ionizablePct = comp ? Object.entries(comp.mol_pct).filter(([k]) => ref.lipidByKey[k]?.class === 'ionizable').reduce((s, [, v]) => s + v, 0) : null;
    // The cargo (mRNA, siRNA) names what the record carries, and its mass per phosphate is the N/P's (calc/cargo.js).
    const cargo = cargoOf(plan, rnaLot), mpp = massPerPhosphate(plan, rnaLot);
    const out = { stock, rnaLot, stock_mg_mL, working, mass, lipid_mM, frr, quench, total, flows, quick, qv, cargo, cargoName: cargoLabel(cargo), mpp };
    try {
      // The stock volume and the dialysis start volume are kept on the result, not worked out again where they
      // are shown: step 1, step 3, the worksheet and the "At the bench" card all read these same two numbers.
      out.rnaStock_mL = stock_mg_mL ? mass / stock_mg_mL : null;
      out.dil = stock_mg_mL ? rnaDilution({ stock_mg_mL, stock_mL: out.rnaStock_mL, working_mg_mL: working }) : null;
      out.mix = mixingPlan({ rna_mg: mass, working_mg_mL: working, lipidStock_mM: lipid_mM, frr, quenchFactor: quench, flows, ionizableMolPct: ionizablePct || undefined, massPerPhosphate: mpp });
      if (plan.rna.np && ionizablePct) { // N/P as a set target: derive the lipid volume from it instead of FRR
        const phosphate_mmol = mass / mpp; const lipid_mmol = (plan.rna.np * phosphate_mmol) / (ionizablePct / 100);
        out.npLipid_mL = (lipid_mmol / lipid_mM) * 1000; out.npFrr = out.mix.rna_mL / out.npLipid_mL;
      }
      const startDia = ds.dialysis.start_mL || out.mix.primary_mL;
      out.startDia = startDia;
      out.dia = dialysisPlan({ start_mL: startDia, end_mL: a.dialysis_end_mL || startDia, primary_mg_mL: out.mix.primary_mg_mL });
      // A module deleted under Materials is kept on the step (moduleRecord), so the load window stays its own.
      const tffAt = stepOf(plan.process, 'tff');
      const mod = ref.tffModules.find((m) => m.part === tffAt?.device) || (tffAt?.moduleRecord && tffAt.moduleRecord.part === tffAt.device ? tffAt.moduleRecord : null) || ref.tffModules[0];
      out.tff = mod ? tffPlan({ module: mod, start_mL: a.dialysis_end_mL || startDia, target_mg_mL: ds.tff.target_mg_mL || 0.133, primary_mg_mL: out.mix.primary_mg_mL, rna_mg: mass }) : null;
      const measured = ds.finalFormulation.measured_mg_mL ?? out.dia.rna_mg_mL_est;
      const vol = a.tff_end_mL || a.dialysis_end_mL || startDia;
      out.comp = finalFormulationPlan({ volume_mL: vol, measured_mg_mL: measured, final_mg_mL: ds.finalFormulation.final_mg_mL || settings.defaultFinal_mg_mL });
      out.bio = biosafetyAliquot({ v_mL: 0.5, c_meas: measured, c_target: 0.05 });
      out.fill = fillFinish(ds.fill);
    } catch (e) { out.err = e.message; }
    return out;
  }

  /**
   * A step's key numbers, for its folded line: what to measure out or set, read off the same bench values the
   * card above shows (so the line cannot disagree with the card or the table), and, for dialysis and TFF, the
   * volume recorded at the end, because the later steps are worked out from it. A warning the step's table
   * carries is counted on the line, so folding the table does not fold the warning away with it. Returns HTML.
   */
  function stepSay(n, c, groups) {
    const bench = Object.fromEntries(groups.flatMap((g) => g.items).map((it) => [it.key, benchValue(it)]));
    const warn = (xs) => (xs?.length ? ` <span class="chip warn">${xs.length} warning${xs.length === 1 ? '' : 's'}</span>` : '');
    const m = c.mix;
    switch (n) {
      case 1: {
        const s = bench.rna_stock_mL, b = bench.rna_buffer_mL;
        return esc(!s.ok ? s.sub : !b.ok ? b.sub : `${s.num} mL stock + ${b.num} mL buffer`);
      }
      case 2: {
        const pumps = `pumps ${[bench.p1, bench.p2, bench.p3].filter(Boolean).map((x) => x.num).join(' / ')} mL/min`;
        return esc(m && c.mass > 0 ? `${pumps} · primary product ${fmt(m.primary_mL, 2)} mL` : `${pumps} · ${c.err || 'enter the RNA input (mg)'}`) + warn(m?.checks);
      }
      case 3: {
        if (!stepOf(plan.process, 'dialysis')) return 'no dialysis in this process';
        const s = bench.dialysis_start_mL;
        return esc(!s.ok ? s.sub : `start volume ${s.num} mL${entered(a.dialysis_end_mL)
          ? ` → ${asTyped(a.dialysis_end_mL, 2)} mL after` : ` · ${asTyped(ds.dialysis.volume_L)} L for ${asTyped(ds.dialysis.hours)} h`}`);
      }
      case 4:
        if (!stepOf(plan.process, 'tff')) return 'concentrate by TFF is off';
        return esc(c.tff ? `reduce to ${fmt(c.tff.reduceTo_mL, 2)} mL${entered(a.tff_end_mL) ? ` → ${asTyped(a.tff_end_mL, 2)} mL after` : ` · ${stepOf(plan.process, 'tff').device || ''}`}`
          : c.err || 'choose a TFF module') + warn(c.tff?.checks);
      case 5:
        return esc(c.comp ? `${fmt(c.comp.vFinal_mL, 2)} mL at ${asTyped(ds.finalFormulation.final_mg_mL || settings.defaultFinal_mg_mL)} mg/mL` : c.err || 'check the inputs');
      case 6:
        return esc(ds.fill.map((f) => `${asTyped(f.count, 0)} × ${asTyped(f.fill_mL)} mL ${f.container || ''}`.trim()).join(' + ') + (c.fill ? ` · ${fmt(c.fill.total_mL, 2)} mL` : ''));
      default: return '';
    }
  }

  /**
   * Under the inputs: the lipid stock's freeze–thaw count, and the offer to log the thaw it took to make this
   * formulation, one click. Read from the store, not from the list taken when the record opened: a thaw logged
   * a moment ago, here or on the stock, counts.
   */
  function stockThawHtml() {
    const s = batch.stockId ? ctx.store.get('stocks', batch.stockId) : null;
    if (!s) return '';
    const today = todayISO(), mine = thawsOf(s).some((t) => t.batchId === batch.id);
    return `<div class="stockThaw${overThaw(s, settings.ftWarnCycles) ? ' over' : ''}" id="stockThaw"><span><b>${esc(s.id)}</b>: ${esc(thawLine(s, settings.ftWarnCycles))}.</span>
      ${mine ? `<span class="muted">The thaw for ${esc(batch.id)} is logged.</span>`
        : `<button type="button" id="stockThawToday" class="${thawedOn(s, today) ? '' : 'primary'}" title="Log one freeze–thaw cycle of ${esc(s.id)}, today, for ${esc(batch.id)}">Thawed for this formulation</button>${thawedOn(s, today) ? '<span class="muted">(a thaw is already logged today: only if it was thawed again)</span>' : ''}`}</div>`;
  }
  /** Log a thaw of the stock for this formulation. Stored on the stock at once; the record is redrawn. */
  function logStockThaw() {
    const s = batch.stockId ? ctx.store.get('stocks', batch.stockId) : null;
    if (!s) return;
    const next = withThaw(s, { operator: settings.operator, batchId: batch.id });
    ctx.store.put('stocks', next);
    toast(`${s.id}: ${ftWords(next)}`, 'ok');
    if (formEl?.isConnected) swapHtml(el, draw);
  }

  function draw() {
    const c = compute();
    // Each stock with its freeze–thaw count (" · 3 F/T", "⚠" past the threshold in Settings); a stock or an RNA
    // lot deleted since stays named, marked so, rather than the menu falling back to "choose".
    const ft = (s) => ftTag(s, settings.ftWarnCycles);
    const shelf = ctx.store.all('stocks'); // as stored now: a thaw logged since the record opened counts
    const stockOpts = [{ value: '', label: '— choose —' }, ...shelf.filter((s) => s.compositionId === batch.compositionId).map((s) => ({ value: s.id, label: `${s.id} · ${fmt(s.molarity_mM, 1)} mM · ${s.status}${ft(s)}` })), ...shelf.filter((s) => s.compositionId !== batch.compositionId).map((s) => ({ value: s.id, label: `${s.id} (#${s.compositionId}) · ${fmt(s.molarity_mM, 1)} mM${ft(s)}` })),
      ...(batch.stockId && !c.stock ? [{ value: batch.stockId, label: `${batch.stockId} (deleted)` }] : [])];
    const rnaOpts = [{ value: '', label: '—' }, ...ref.rnaLots.map((r) => ({ value: r.id, label: `${r.id} · ${cargoLabel(r.cargo)} · ${r.construct || ''} · ${fmt(r.conc_mg_mL, 2)} mg/mL` })),
      ...(plan.rna.lotId && !c.rnaLot ? [{ value: plan.rna.lotId, label: `${plan.rna.lotId} (deleted)` }] : [])];
    const groups = benchNumbers(c, batch), progress = stepProgress(batch);
    if (progress.current) reached.add(progress.current);
    // Quick mode has one step, the mixing, and calls it that rather than "Step 2".
    const stepBox = (n, title, body) => {
      const { state } = progress.steps[n - 1], open = stepOpen.get(n) ?? reached.has(n);
      return `<details class="card fold step" id="step${n}" data-step="${n}" ${open ? 'open' : ''}>
        <summary><h2>${c.quick ? '' : `Step ${n} · `}${title}<span class="stepSay"> — <span class="stepState st-${state.replace(/ /g, '-')}">${state}</span> · ${stepSay(n, c, groups)}</span></h2></summary>${body}</details>`;
    };
    const tr = (label,target, actualHtml = '') => `<tr><td>${label}</td><td style="text-align:right"><b>${target}</b></td><td>${actualHtml}</td></tr>`;
    const tbl = (rows) => `<table><thead><tr><th>Parameter</th><th style="text-align:right">Target</th><th>Actual / record</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
    const inp = (name, val, w = 110, step = 'any') => `<input type="number" step="${step}" name="${name}" value="${val ?? ''}" style="width:${w}px">`;
    const txt = (name, val, w = 160) => `<input type="text" name="${name}" value="${val ?? ''}" style="width:${w}px">`;

    // The mode first: it decides which of the inputs below there are. Quick asks for a volume and works out the
    // mRNA; the full process asks for the mRNA and works out everything from the dilution to the vials.
    const expVolume = Number(exp?.spec?.volume_mL) > 0 ? Number(exp.spec.volume_mL) : null;
    const quickHint = c.qv
      ? `= ${fmt(c.qv.rna_mg, 3)} mg ${c.cargoName}: volume × RNA working conc. × FRR ÷ (FRR + 1${c.quench ? ' + quench' : ''})${expVolume != null && Math.abs(expVolume - plan.volume_mL) > 1e-9 ? ` · the experiment plans ${asTyped(expVolume)} mL` : ''}`
      : 'the volume of product collected after the mixer';
    const modeSeg = `<div class="modeRow"><div class="seg modeSeg" role="group" aria-label="How far this formulation goes">
        <button type="button" data-mode="quick" class="${c.quick ? 'on' : ''}" aria-pressed="${c.quick}">Quick · mixing only</button>
        <button type="button" data-mode="full" class="${c.quick ? '' : 'on'}" aria-pressed="${!c.quick}">Full process</button></div>
      <span class="muted">${c.quick ? `Set the volume to make; the ${c.cargoName}, the phases and the pumps follow. No dilution, dialysis, TFF or final formulation.` : 'RNA dilution, mixing, dialysis, TFF, final formulation and fill, with targets and actuals.'}</span></div>`;
    const inputs = `<div class="card" id="inputsCard"><h2>Inputs</h2>${modeSeg}<div class="grid g4">
      ${field({ id: 'compositionId', label: 'Composition', type: 'select', value: batch.compositionId, options: ref.pick('compositions', batch.compositionId).map((x) => ({ value: x.id, label: compositionLabel(x, ref) })) })}
      ${field({ id: 'stockId', label: 'Lipid stock lot', type: 'select', value: batch.stockId || '', options: stockOpts })}
      ${field({ id: 'rna_lotId', label: `RNA lot · ${c.cargoName}`, type: 'select', value: plan.rna.lotId || '', options: rnaOpts })}
      ${c.quick ? field({ id: 'quick_volume_mL', label: 'Volume to formulate (mL)', value: plan.volume_mL, step: 0.5, min: 0, hint: quickHint })
        : `${field({ id: 'rna_stock_mg_mL', label: 'RNA stock conc. (mg/mL)', value: c.stock_mg_mL, step: 0.01 })}
      ${field({ id: 'rna_mass_mg', label: 'RNA input (mg)', value: c.mass, step: 0.1 })}`}
      ${field({ id: 'rna_working_mg_mL', label: 'RNA working conc. (mg/mL)', value: c.working, step: 0.05 })}
      ${field({ id: 'mixing_lipidStock_mM', label: 'Lipid stock (mM)', value: c.lipid_mM, step: 0.1 })}
      ${field({ id: 'mixing_frr', label: 'FRR (aq : org)', value: c.frr, step: 0.5 })}
      ${plan.process?.quench !== false ? field({ id: 'mixing_quenchFactor', label: 'Quench factor', value: plan.mixing.quenchFactor ?? settings.defaultQuenchFactor, step: 0.5 }) : ''}
      ${field({ id: 'mixing_totalFlow', label: 'Total flow (mL/min)', value: plan.mixing.totalFlow || 112.5, step: 0.5 })}
      ${field({ id: 'rna_np', label: 'N/P target (optional, overrides FRR for lipid volume)', value: plan.rna.np, step: 0.5, advanced: true })}
      ${field({ id: 'plannedDate', label: 'Production date', type: 'date', value: batch.plannedDate })}
    </div>${stockThawHtml()}<p class="muted" style="margin:8px 0 0">The buffers, the device and the downstream steps are set in the process above.</p></div>`;

    // The process: drawn, summed up in a line, and changed in the fold under the drawing (app/ui/processviz.js).
    const proc = plan.process;
    const productNote = c.mix ? `${fmt(c.mix.primary_mL, 2)} mL · ${fmt(c.mix.primary_mg_mL, 3)} mg/mL` : '';
    const processCard = `<div class="card processCard" id="processCard"><div class="benchHead"><h2>Process</h2><span class="muted" id="processSay">${esc(processSummary(proc, ref, { quick: c.quick }))}</span></div>
      <div class="processDraw">${processSvg(proc, ref, { quick: c.quick, flows: c.flows, lipid_mM: c.lipid_mM, product: productNote })}</div>
      <details class="fold sub" id="processEdit" ${editOpen ? 'open' : ''}><summary><h2>Change the process</h2><span class="fold-say">device, mixer, quench, buffers${c.quick ? '' : ', downstream steps'}</span></summary>
        ${processEditor(proc, ref, { quick: c.quick, uid: 'rec' })}</details></div>`;
    const dia = stepOf(proc, 'dialysis'), tffStep = stepOf(proc, 'tff');
    const editLink = '<button type="button" class="linkish" data-edit-process>change in the process</button>';

    const step1 = c.dil ? tbl([
      tr('RNA stock volume (mL)', fmt(c.rnaStock_mL, 3), inp('a_rna_stock_mL', a.rna_stock_mL)),
      tr('Working solution total (mL)', fmt(c.dil.total_mL, 3), inp('a_rna_total_mL', a.rna_total_mL)),
      tr('Dilution buffer (mL)', fmt(c.dil.diluent_mL, 3), `${txt('a_rna_diluent_lot', esc(a.rna_diluent_lot || proc.aqueous?.buffer || ''), 220)} <span class="muted">lot</span>`),
      tr('Prepared by / date', '—', `${txt('a_rna_operator', a.rna_operator || settings.operator, 70)} <input type="date" name="a_rna_date" value="${a.rna_date || ''}" style="width:150px">`),
    ]) : '<div class="note">Set the RNA stock concentration (or choose an RNA lot) to compute the dilution.</div>';

    const m = c.mix;
    // The set-up first, from the process, so the mixing step says what it is run on and with what.
    const dev = deviceOf(proc, ref), mixer = mixerOf(proc, ref);
    const setup = [
      tr('Device / mixer', esc([dev?.name || proc.deviceId, mixer ? `${mixer.name} (${mixer.kind})` : proc.mixerId].filter(Boolean).join(' · ')), editLink),
      tr('Aqueous phase (pump 1)', esc(bufferLine(proc.aqueous) || 'not set'), ''),
      tr('Quench (pump 3)', esc(proc.quench !== false ? bufferLine(proc.quenchBuffer) || 'buffer not set' : 'none in this process'), ''),
    ];
    const step2 = m ? `${tbl([
      ...setup,
      ...(c.quick ? [tr(`${c.cargoName} in the volume (mg)`, fmt(c.mass, 3), '')] : []),
      tr('RNA volume (mL)', fmt(m.rna_mL, 2), ''), tr('Lipid/EtOH volume (mL)', fmt(m.lipid_mL, 2) + (c.npLipid_mL ? ` <span class="muted">(N/P target: ${fmt(c.npLipid_mL, 2)} mL → FRR ${fmt(c.npFrr, 2)})</span>` : ''), ''),
      tr('Lipid (mmol)', fmt(m.lipid_mmol, 4), ''),
      ...(c.quench ? [tr('Quench buffer volume (mL)', `${fmt(m.quench_mL, 2)} <span class="muted">prepare ${fmt(m.quenchNeeded_mL, 2)}</span>`, `${txt('a_quench_lot', esc(a.quench_lot || proc.quenchBuffer?.buffer || ''), 220)} <span class="muted">lot</span>`)] : []),
      tr('Pump 1 RNA (mL/min)', fmt(c.flows.p1, 2), inp('a_p1', a.p1)), tr('Pump 2 lipid (mL/min)', fmt(c.flows.p2, 2), inp('a_p2', a.p2)),
      ...(c.quench || c.flows.p3 > 0 ? [tr('Pump 3 quench (mL/min)', fmt(c.flows.p3, 2), inp('a_p3', a.p3))] : []),
      tr('Sum flow at T1 (mL/min)', fmt(m.sumFlowT1, 2), ''), tr('Total process flow (mL/min)', fmt(m.totalFlow, 2), ''),
      tr('Primary product RNA conc. (mg/mL)', fmt(m.primary_mg_mL, 3), ''), tr('Primary product volume (mL)', fmt(m.primary_mL, 2), inp('a_primary_mL', a.primary_mL)),
      tr('Run time (min)', fmt(m.runTime_min, 2), ''), tr('N/P', m.np != null ? fmt(m.np, 1) : '– (no ionizable class in composition)', ''),
      tr('Pre-test program', 'Cetoni 50 mL: buffer / water / ethanol', `<label style="font-weight:400"><input type="checkbox" name="a_pretest" ${a.pretest ? 'checked' : ''} style="width:auto"> done</label>`),
    ])}
    ${m.checks.map((x) => `<div class="note warn">${x}</div>`).join('')}
` : `<div class="note warn">${c.err || (c.quick ? 'Enter the volume to formulate to compute the mixing plan.' : 'Enter RNA input to compute the mixing plan.')}</div>`;

    // Cassette and buffer are the process's (one place to change them, the designer above); the step records
    // what was done with them.
    const step3 = !dia ? `<p class="muted">No dialysis in this process. ${editLink} to add one.</p>` : `${tbl([
      tr('Cassette', esc(dia.device || 'not set'), editLink),
      tr('Dialysis buffer', esc(bufferLine(dia) || 'not set'), `${txt('a_dialysis_lot', esc(a.dialysis_lot || ''), 200)} <span class="muted">lot</span>`),
      tr('Start volume (mL)', inp('ds_dialysis_start_mL', ds.dialysis.start_mL ?? (m ? m.primary_mL.toFixed(2) : '')), ''), tr('Dialysis volume (L)', inp('ds_dialysis_volume_L', ds.dialysis.volume_L), ''), tr('Duration (h)', inp('ds_dialysis_hours', ds.dialysis.hours), `start <input type="datetime-local" name="a_dialysis_start" value="${a.dialysis_start || ''}"> exchange <input type="datetime-local" name="a_dialysis_exchange" value="${a.dialysis_exchange || ''}"> end <input type="datetime-local" name="a_dialysis_end" value="${a.dialysis_end || ''}">`),
      tr('End volume after dialysis (mL)', '', inp('a_dialysis_end_mL', a.dialysis_end_mL)),
      tr('Dilution factor / RNA conc. estimate', c.dia ? `${fmt(c.dia.dilutionFactor, 3)} / ${fmt(c.dia.rna_mg_mL_est, 3)} mg/mL` : '–', c.dia ? `<span class="muted">DLS dilution 1 : ${fmt(c.dia.dlsDilution, 0)}</span>` : ''),
      tr('IPC4 sample taken (do not freeze)', '', `<label style="font-weight:400"><input type="checkbox" name="a_ipc4" ${a.ipc4 ? 'checked' : ''} style="width:auto"> taken</label> ${txt('a_dialysis_remarks', a.dialysis_remarks, 260)}`),
    ])}`;

    // Ticking TFF adds a TFF step to the process (after the dialysis), unticking takes it out: the same as doing
    // it in the designer, so the drawing and this step cannot disagree.
    const step4 = `<label style="font-weight:400"><input type="checkbox" name="proc_tff" ${tffStep ? 'checked' : ''} style="width:auto"> Concentrate by TFF</label>
      ${tffStep ? tbl([
        tr('Module', `<select name="proc_tffModule" style="width:220px">${(tffStep.device && !ref.tffModules.some((x) => x.part === tffStep.device) ? [tffStep.moduleRecord?.part === tffStep.device ? { ...tffStep.moduleRecord, family: `${tffStep.moduleRecord.family || ''} (deleted)` } : { part: tffStep.device, family: 'as written', surface_cm2: NaN }] : []).concat(ref.tffModules).map((x) => `<option value="${esc(x.part)}" ${x.part === tffStep.device ? 'selected' : ''}>${esc(x.part)} · ${esc(x.family)}${Number.isFinite(x.surface_cm2) ? ` · ${fmt(x.surface_cm2, 0)} cm²` : ''}</option>`).join('')}</select>`, `${txt('a_tff_lot', a.tff_lot, 160)} <span class="muted">module lot</span>`),
        tr('Exchange buffer', esc(bufferLine(tffStep) || 'not set'), editLink),
        tr('RNA load window (mg)', c.tff ? `${fmt(c.tff.minLoad_mg, 1)} – ${fmt(c.tff.maxLoad_mg, 1)}` : '–', c.tff?.checks.map((x) => `<span class="chip warn">${x}</span>`).join('') || ''),
        tr('Target conc. after TFF (mg/mL)', inp('ds_tff_target_mg_mL', ds.tff.target_mg_mL), ''), tr('Reduce volume to at least (mL)', c.tff ? fmt(c.tff.reduceTo_mL, 2) : '–', inp('a_tff_end_mL', a.tff_end_mL)),
        tr('Module sanitized / flushed', '', `<label style="font-weight:400"><input type="checkbox" name="a_tff_sanitized" ${a.tff_sanitized ? 'checked' : ''} style="width:auto"> sanitized</label> <label style="font-weight:400"><input type="checkbox" name="a_tff_flushed" ${a.tff_flushed ? 'checked' : ''} style="width:auto"> flushed</label> <label style="font-weight:400"><input type="checkbox" name="a_ipc5" ${a.ipc5 ? 'checked' : ''} style="width:auto"> IPC5 taken</label>`),
      ]) : `<p class="muted">Skipped: ${dia ? 'dialysis volume goes' : 'the product goes'} straight to final formulation.</p>`}`;

    const cp = c.comp;
    const step5 = tbl([
      tr('Measured RNA conc. (mg/mL, IPC5 or dialysis estimate)', inp('ds_final_measured_mg_mL', ds.finalFormulation.measured_mg_mL ?? (c.dia ? c.dia.rna_mg_mL_est.toFixed(3) : '')), ''),
      tr('Final target (mg/mL)', inp('ds_final_final_mg_mL', ds.finalFormulation.final_mg_mL), ''),
      tr('1st final formulation target (1.33 × final)', cp ? fmt(cp.c1, 3) + ' mg/mL' : '–', ''),
      tr('1st dilution buffer', `<select name="ds_final_buffer1" style="width:260px">${bufferOpts('dialysis', ds.finalFormulation.buffer1).map((o) => `<option value="${o.value}" ${o.value === ds.finalFormulation.buffer1 ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`, cp ? `add <b>${fmt(cp.buffer1_mL, 2)} mL</b> → ${fmt(cp.v1, 2)} mL (DF ${fmt(cp.df1, 3)})` : ''),
      tr('2nd dilution buffer (cryoprotectant)', `<select name="ds_final_buffer2" style="width:260px">${bufferOpts('final', ds.finalFormulation.buffer2).map((o) => `<option value="${o.value}" ${o.value === ds.finalFormulation.buffer2 ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`, cp ? `add <b>${fmt(cp.buffer2_mL, 2)} mL</b> → ${fmt(cp.vFinal_mL, 2)} mL (DF ${fmt(cp.df2, 2)})` : ''),
      tr('Final volume (mL) / RNA (mg)', cp ? `${fmt(cp.vFinal_mL, 2)} / ${fmt(cp.rna_mg, 2)}` : '–', `<label style="font-weight:400"><input type="checkbox" name="a_compounded" ${a.compounded ? 'checked' : ''} style="width:auto"> done</label>`),
      tr('Pre-filter', `<select name="ds_filtration_prefilter" style="width:220px">${ref.materials.filters.map((x) => `<option ${x === ds.filtration.prefilter ? 'selected' : ''}>${x}</option>`).join('')}</select>`, txt('a_prefilter_lot', a.prefilter_lot, 140)),
      tr('Sterile filter 0.2 µm', `<select name="ds_filtration_sterile" style="width:220px">${ref.materials.filters.map((x) => `<option ${x === ds.filtration.sterile ? 'selected' : ''}>${x}</option>`).join('')}</select>`, `${txt('a_sterile_lot', a.sterile_lot, 140)} <label style="font-weight:400"><input type="checkbox" name="a_filtered" ${a.filtered ? 'checked' : ''} style="width:auto"> filtered</label> <label style="font-weight:400"><input type="checkbox" name="a_ipc6" ${a.ipc6 ? 'checked' : ''} style="width:auto"> IPC6 / pH / osmolality samples</label>`),
      `<tr class="advanced"><td>Biosafety aliquot (0.5 mL → 0.05 mg/mL)</td><td style="text-align:right">${c.bio ? `buffer 1 ${fmt(c.bio.buffer1_mL, 3)} mL, buffer 2 ${fmt(c.bio.buffer2_mL, 3)} mL` : '–'}</td><td></td></tr>`,
    ]);

    const step6 = `${table(['Container', 'Count', 'Fill (mL)', { label: 'Total (mL)', right: true }, ''], ds.fill.map((f, i) => ({ cells: [raw(txt(`fill_container_${i}`, f.container, 140)), raw(inp(`fill_count_${i}`, f.count, 80, 1)), raw(inp(`fill_mL_${i}`, f.fill_mL, 80)), fmt(f.count * f.fill_mL, 2), raw(`<button data-rmfill="${i}" style="padding:3px 8px">✕</button>`)] })))}
      <div style="display:flex;gap:10px;align-items:center;margin-top:6px"><button id="addFill" style="padding:5px 10px">+ Container</button><span class="muted">Total ${fmt(c.fill?.total_mL, 2)} mL of ${cp ? fmt(cp.vFinal_mL, 2) : '–'} mL available</span>
      <label style="font-weight:400;margin-left:auto">Storage ${txt('a_storage', a.storage || '5 °C', 90)}</label><label style="font-weight:400"><input type="checkbox" name="a_filled" ${a.filled ? 'checked' : ''} style="width:auto"> fill & finish done</label></div>`;

    const ipc = `<div class="card advanced"><h2>In-process controls</h2>${table(['Stage', 'After', 'Tests'], IPC_STAGES.map((s) => ({ cells: [raw(`<b>${s.id}</b>`), s.after, s.tests.join(', ')] })))}<p class="muted"><a href="#/measurements?batch=${batch.id}">Enter or import measurements for this batch</a></p></div>`;

    el.innerHTML = header(raw(`<a href="#/formulation">Formulations</a> › <a href="#/experiments?id=${esc(batch.experimentId)}">${esc(describeId(batch.experimentId))}</a>`),
      `${describeId(batch.id)}`,
      // The status is a small labelled control among the actions. As a bare select it took the global
      // width:100% and wrapped onto a line of its own, a page-wide dropdown under the title.
      `<span class="chip ${batch.status === 'planned' ? '' : 'info'}">${batch.status}</span><span class="chip cargoChip" title="The cargo: what this formulation encapsulates">${esc(c.cargoName)}</span><span class="muted">${esc(batch.id)} · ${esc(batch.label || '')} · ${esc(exp?.name || '')}</span>
       <label class="inline" style="margin:0">Status <select id="statusSel" style="width:auto">${['planned', 'produced', 'measured', 'analyzed'].map((s) => `<option ${s === batch.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
       ${saver.html()}<button id="printBatch">Print worksheet</button>`) +
      layerTabBar(ctx, 'core', tabHref) +
      compositionNote(comp, registryComp, overridden, ref) +
      benchCard(groups) +
      `<div id="batchForm">${processCard}${inputs}${conditionsCard()}
        ${c.quick ? stepBox(2, 'LNP mixing', step2) : `${stepBox(1, 'RNA dilution', step1)}${stepBox(2, 'LNP mixing', step2)}${stepBox(3, 'Dialysis', step3)}
        ${stepBox(4, 'TFF concentration', step4)}
        ${stepBox(5, 'Final formulation & filtration', step5)}${stepBox(6, 'Fill & finish', step6)}`}
        ${field({ id: 'notes', label: 'Remarks', type: 'textarea', value: batch.notes, rows: 2 })}${customCard(customDefs(ctx.store), batch)}${c.quick ? '' : ipc}</div>` +
      finishCard();

    const form = formEl = el.querySelector('#batchForm');
    form.addEventListener('change', onChange);
    form.addEventListener('input', onInput);
    form.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    // The designer's own buttons (add, remove, move a step) change the process whole.
    wireProcessButtons(form, () => plan.process, (next) => { plan.process = next; reflow(); saver.now(); swapHtml(el, draw); }, ref);
    form.querySelector('#processEdit > summary')?.addEventListener('click', (e) => { editOpen = !e.currentTarget.parentElement.open; });
    form.querySelectorAll('[data-edit-process]').forEach((b) => b.addEventListener('click', () => {
      const d = form.querySelector('#processEdit'); editOpen = true; d.open = true;
      form.querySelector('#processCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    wireFinish();
    form.querySelector('#stockThawToday')?.addEventListener('click', logStockThaw);
    // computed at the click: a value typed just before it is in the plan, but the redraw has not run yet
    el.querySelector('#printBatch').addEventListener('click', () => print(compute()));
    el.querySelector('#statusSel').addEventListener('change', (e) => { batch.status = e.target.value; saver.now(); draw(); });
    form.querySelector('#addFill')?.addEventListener('click', () => { ds.fill.push({ container: '2R glass', count: 10, fill_mL: 0.5 }); saver.now(); draw(); });
    form.querySelectorAll('[data-rmfill]').forEach((b) => b.addEventListener('click', () => { ds.fill.splice(Number(b.dataset.rmfill), 1); if (!ds.fill.length) ds.fill.push({ container: '2R glass', count: 10, fill_mL: 0.5 }); saver.now(); draw(); }));
    // Only a click on a step's line is the user's choice, recorded as on the other folded screens: it runs
    // before the details toggles, so the state it is about to take is the opposite of now. A value typed just
    // before the click redraws only once the click has landed (redrawSoon), and that redraw reads this choice.
    form.querySelector('#conditionsCard > summary')?.addEventListener('click', () => { conditionsOpen = !form.querySelector('#conditionsCard').open; });
    form.querySelectorAll('details[data-step] > summary').forEach((s) => s.addEventListener('click', () => {
      stepOpen.set(Number(s.parentElement.dataset.step), !s.parentElement.open);
    }));
  }

  /** The pump flows again from the total, FRR and quench (0 without quench), and quick mode's mRNA from its volume. */
  function reflow() {
    plan.mixing.flows = flowsFromTotal(plan.mixing.totalFlow || 112.5, plan.mixing.frr || settings.defaultFRR, effectiveQuench(plan, settings.defaultQuenchFactor));
    syncQuick(plan);
  }

  /**
   * Quick (mixing only) or the full process. Going quick keeps the mRNA the record had: the volume is the one
   * that holds it (or the experiment's volume, when the record never had an mRNA input). Going full keeps the
   * mRNA quick mode worked out, now as the RNA input to change. Nothing recorded is lost either way: the steps
   * quick mode leaves out are only not shown.
   */
  function setMode(mode) {
    if (modeOf(plan) === mode) return;
    if (mode === 'quick' && !(Number(plan.volume_mL) > 0)) {
      const v = quickVolumeFor({ rna_mg: plan.rna.mass_mg, working_mg_mL: plan.rna.working_mg_mL || settings.defaultWorking_mg_mL, frr: plan.mixing.frr || settings.defaultFRR, quenchFactor: effectiveQuench(plan, settings.defaultQuenchFactor) });
      plan.volume_mL = v ? Math.round(v * 100) / 100 : Number(exp?.spec?.volume_mL) || settings.defaultQuickVolume_mL || QUICK_VOLUME_mL;
    }
    plan.mode = mode;
    syncQuick(plan);
    saver.now();
    swapHtml(el, draw);
  }

  /** The other formulations of this experiment still to make, in the order they were planned. */
  function nextPlanned() {
    const ids = exp?.batchIds || [];
    const at = ids.indexOf(batch.id);
    const order = [...ids.slice(at + 1), ...ids.slice(0, Math.max(0, at))];
    return order.map((id) => ctx.store.get('batches', id)).find((b) => b && b.status === 'planned') || null;
  }

  /**
   * The end of the record: "Finish formulation" while it is still planned, which marks it produced and stores
   * it, and then the way on: the next formulation of the experiment still to make, or back to the experiment.
   * The status at the top says the same; this is where a bench day ends a record, at the bottom of it.
   */
  function finishCard() {
    if (batch.status === 'planned') {
      return `<div class="card finishCard" id="finishCard"><div class="finishRow">
        <button type="button" class="primary finishBtn" id="finishBatch">Finish formulation</button>
        <span class="muted">Marks ${esc(batch.id)} produced and saves it. Its results are entered next, under <a href="#/measurements?batch=${esc(batch.id)}">Measurements</a>.</span></div></div>`;
    }
    const next = nextPlanned();
    return `<div class="card finishCard done" id="finishCard"><div class="finishRow">
      <span class="finishTick" aria-hidden="true">✓</span><span><b>${esc(batch.id)} is ${esc(batch.status)}.</b> ${next ? `Next still to make: <b>${esc(next.id)}</b>${next.label ? ` · ${esc(next.label)}` : ''}.` : exp ? 'Every formulation of this experiment is made.' : ''}</span></div>
      <div class="finishRow">${next ? `<a class="btn primary" id="finishNext" href="#/formulation?batch=${esc(next.id)}">Go to ${esc(next.id)}</a>` : ''}
        ${exp ? `<a class="btn${next ? '' : ' primary'}" id="finishBack" href="#/experiments?id=${esc(exp.id)}">Back to ${esc(describeId(exp.id))}</a>` : ''}
        <a class="btn" href="#/doe?id=${esc(batch.experimentId)}" title="The data sheet of this experiment, beside its figures">Enter results</a></div></div>`;
  }
  function wireFinish() {
    el.querySelector('#finishBatch')?.addEventListener('click', () => {
      if (batch.status !== 'planned') return;
      batch.status = 'produced';
      saver.now();
      // Made from a stock whose thaw for it is not logged yet: the note offers it, one click.
      const s = batch.stockId ? ctx.store.get('stocks', batch.stockId) : null;
      if (s && !thawsOf(s).some((t) => t.batchId === batch.id)) toast(`${batch.id} finished: marked produced and saved. Was ${s.id} thawed for it?`, 'ok', { action: `Log thaw of ${s.id}`, onAction: logStockThaw });
      else toast(`${batch.id} finished: marked produced and saved`, 'ok');
      swapHtml(el, draw);
      el.querySelector('#finishCard')?.scrollIntoView({ block: 'nearest' });
      el.querySelector('#finishNext, #finishBack')?.focus({ preventScroll: true });
    });
  }

  /**
   * The process variables of spec 4.1 that the plan above does not already hold, along the process. A value that
   * fails the shared check (app/calc/variables.js) is kept and shown with a warning, not refused, as elsewhere on
   * this screen. What the process designer, the RNA lot and the composition already record is shown with its
   * source and not asked again (calc/variables.js `from`); the fields are named cond_*, since the process
   * designer's own are proc_*.
   */
  function conditionsCard() {
    const cond = plan.conditions || {};
    const SRC = { process: 'from the process above', cargo: 'from the RNA lot', composition: 'from the composition', conditions: 'typed here' };
    const shown = (v, val) => (val == null ? '<span class="muted">not recorded</span>'
      : esc(Array.isArray(val) ? val.map((k) => ref.lipidByKey[k]?.name || k).join(', ') : val === true ? 'yes' : val === false ? 'no' : String(val)));
    const one = (v) => {
      const id = 'cond_' + v.key, label = v.name + (v.unit ? ` (${v.unit})` : '');
      // Recorded elsewhere in 0.15 (the process designer, the RNA lot, the composition): shown, with where from.
      if (v.from) {
        const val = readVariable(batch, v.key, ref), src = sourceOf(batch, v.key, ref);
        return `<div><label>${esc(label)}</label><div class="ro" id="${id}">${shown(v, val)}${src ? ` <span class="muted">· ${esc(SRC[src])}</span>` : ''}</div></div>`;
      }
      const val = readVariable(batch, v.key, ref);
      const warn = checkVariable(v.key, cond[v.key]);
      let input;
      if (v.kind === 'number') input = `<input type="number" step="any" name="${id}" id="${id}" value="${esc(cond[v.key] ?? '')}" placeholder="${val != null && cond[v.key] == null ? esc(String(val)) : ''}">`;
      else if (v.kind === 'bool') input = `<select name="${id}" id="${id}" data-kind="bool">${[['', 'not recorded'], ['yes', 'yes'], ['no', 'no']].map(([o, l]) => `<option value="${o}" ${(val === true && o === 'yes') || (val === false && o === 'no') || (val == null && o === '') ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
      else input = `<select name="${id}" id="${id}">${['', ...v.options].map((o) => `<option value="${esc(o)}" ${String(cond[v.key] ?? '') === o ? 'selected' : ''}>${o ? esc(o) : 'not recorded'}</option>`).join('')}</select>`;
      return `<div><label for="${id}">${esc(label)}</label>${input}${warn.length ? `<div class="muted" style="color:var(--warn-text, var(--warn))">${esc(warn[0])}</div>` : ''}</div>`;
    };
    const filled = TYPED_VARIABLES.filter((v) => cond[v.key] != null).length;
    return `<details class="card" id="conditionsCard" ${conditionsOpen ? 'open' : ''}><summary><h2 style="display:inline">Process conditions</h2> <span class="muted">${filled} of ${TYPED_VARIABLES.length} recorded · ${esc(provenanceLine(batch))}</span></summary>
      ${VARIABLE_STEPS.map((st) => { const vs = VARIABLES.filter((v) => v.step === st); return vs.length ? `<h3 style="margin:10px 0 4px">${esc(st)}</h3><div class="grid g4">${vs.map(one).join('')}</div>` : ''; }).join('')}
      <p class="muted" style="margin-top:8px">What the process designer, the RNA lot and the composition already say is shown, not asked again. The rest is typed here. All of it is filterable under Data and chooses which runs a model learns from; loading buffer pH and molarity can be freed as factors in the optimizer.</p></details>`;
  }


  /** Put a field's value into the record. False for a control that is not one of its fields. */
  function assign(t) {
    if (!t.name) return false;
    const v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? (t.value === '' ? null : Number(t.value)) : t.value;
    const n = t.name;
    if (n === 'compositionId') batch.compositionId = Number(v);
    else if (n === 'stockId') {
      const was = stocks.find((x) => x.id === batch.stockId), s = stocks.find((x) => x.id === v);
      batch.stockId = v || null;
      // A lipid concentration the design varies is this run's own, whatever it reads.
      const varied = Number.isFinite(Number(plan.factors?.lipid_mM));
      if (s) lotValue(plan.mixing, 'lipidStock_mM', molarity(s), varied ? [] : [molarity(was), exp?.spec?.lipidStock_mM ?? settings.defaultLipidStock_mM], 'Lipid stock', s.id, 'mM');
    }
    else if (n === 'plannedDate') batch.plannedDate = v;
    else if (n === 'notes') batch.notes = v;
    else if (n === 'rna_lotId') {
      const was = ref.rnaLots.find((x) => x.id === plan.rna.lotId), r = ref.rnaLots.find((x) => x.id === v);
      plan.rna.lotId = v || null;
      // The record carries what its lot carries: an siRNA lot makes it an siRNA formulation.
      if (r) plan.rna.cargo = cargoInfo(r.cargo).id;
      if (r) lotValue(plan.rna, 'stock_mg_mL', r.conc_mg_mL, [was?.conc_mg_mL], 'RNA stock conc.', r.id, 'mg/mL');
    }
    else if (n.startsWith('rna_')) plan.rna[n.slice(4)] = v;
    else if (n.startsWith('mixing_')) { plan.mixing[n.slice(7)] = v; if (['frr', 'quenchFactor', 'totalFlow'].includes(n.slice(7))) reflow(); }
    else if (n === 'quick_volume_mL') plan.volume_mL = v;
    // The process designer's fields (pr_...), and the TFF tick and module of step 4, which are the process's too.
    else if (n.startsWith('pr_')) {
      const next = applyProcessField(plan.process, n, v, ref);
      if (!next) return false;
      const quenchWas = effectiveQuench(plan);
      plan.process = next;
      if (effectiveQuench(plan) !== quenchWas) reflow();
    }
    else if (n === 'proc_tff') {
      const p = plan.process;
      if (!v) p.downstream = p.downstream.filter((x) => x.step !== 'tff');
      else if (!stepOf(p, 'tff')) p.downstream.splice(p.downstream.findIndex((x) => x.step === 'dialysis') + 1, 0, newStep('tff', ref)); // after the dialysis, or first
    }
    else if (n === 'proc_tffModule') { const t = stepOf(plan.process, 'tff'); if (t) t.device = v; }
    // ds_<step>_<field>; the final formulation step's fields are named ds_final_…, its record ds.finalFormulation.
    // Writing to ds.final threw on every keystroke there, so the measured RNA concentration was never stored.
    else if (n.startsWith('ds_')) { const [, step, ...rest] = n.split('_'); ds[DS_STEP[step] || step][rest.join('_')] = v; }
    else if (n.startsWith('fill_')) { const [, k, i] = n.split('_'); ds.fill[Number(i)][k === 'mL' ? 'fill_mL' : k] = v; }
    else if (n.startsWith('a_')) { a[n.slice(2)] = v; }
    // A custom parameter (customparams.js): text that is not a number in a numeric one is refused, said once on leaving it.
    else if (n.startsWith('cp_')) {
      const def = customDefs(ctx.store).find((d) => `cp_${d.id}` === n);
      if (!def || !setCustom(batch, def, t.value)) return false;
    }
    else if (n.startsWith('cond_')) {
      const key = n.slice(5);
      plan.conditions ||= {};
      if (v === '' || v === null) delete plan.conditions[key];
      else plan.conditions[key] = t.dataset.kind === 'bool' ? v === 'yes' : v;
    }
    else return false;
    syncQuick(plan); // quick mode: the mRNA follows the volume, the RNA conc., FRR and quench
    return true;
  }

  /**
   * A lot chosen sets the value the plan is worked out from (a stock's molarity, an RNA lot's concentration),
   * as it always did, while the record holds the earlier lot's value or the planned one. A value of the record's
   * own (an RNA concentration measured on the day, a lipid concentration the design varies) is not replaced
   * unasked, since the choice is stored at once: the lot is chosen either way, and its value taken on a yes.
   * Asked through ask() (kit.js), since the macOS app's confirm() answers with a promise where a browser's answers at once.
   */
  async function lotValue(on, key, value, given, label, lot, unit) {
    const cur = on[key];
    if (!Number.isFinite(value) || cur === value) return;
    if (cur == null || given.includes(cur)) { on[key] = value; return; }
    if (!(await ask(`${label} on this record is ${asTyped(cur)} ${unit}, not ${lot}'s ${asTyped(value)} ${unit}. Use ${asTyped(value)} ${unit}?`))) return;
    if (!formEl?.isConnected) return;
    on[key] = value;
    saver.now();
    redrawSoon(formEl, () => swapHtml(el, draw));
  }
  const molarity = (s) => (s ? s.molarityActual_mM || s.molarity_mM : undefined);

  // A field left (or a box ticked, a lot chosen) is stored at once and the record redrawn from it.
  function onChange(e) {
    const t = e.target;
    if (!assign(t)) return;
    saver.now();
    if (t.name === 'notes') return; // nothing on the record is worked out from the remarks
    // After the focus has moved, and keeping it where it went: the same fix the stock and buffer forms got.
    // Keyed to this record's form, not to #main: if the user navigates away before the redraw runs, the form
    // has left the page and the redraw is dropped instead of painting this record over the next screen.
    redrawSoon(e.currentTarget, () => swapHtml(el, draw));
  }

  // Typing is stored once it pauses, or when the screen is left with the cursor still in the field (the
  // browser's Back button, a link opened from the keyboard), where no change event comes. No redraw while
  // typing: the record is worked out again when the field is left.
  function onInput(e) {
    const t = e.target;
    if (t.tagName === 'SELECT' || t.type === 'checkbox' || t.type === 'radio') return; // these send change as well
    if (assign(t)) saver.soon();
  }

  function print(c) {
    const m = c.mix, cp = c.comp, proc = plan.process, dia = stepOf(proc, 'dialysis'), tffStep = stepOf(proc, 'tff');
    const row = (l, t) => `<tr><td>${l}</td><td class="r">${t}</td><td><span class="blank" style="min-width:120px"></span></td></tr>`;
    const blank = '<span class="blank"></span>';
    // The process as drawn on the record, in the light colours whatever the screen's theme, and as a table
    // beside it for what the drawing has to shorten.
    const process = `<h2>Process</h2><div class="proc">${printSvg(processSvg(proc, ref, { quick: c.quick, flows: c.flows, lipid_mM: c.lipid_mM, product: m ? `${fmt(m.primary_mL, 2)} mL · ${fmt(m.primary_mg_mL, 3)} mg/mL` : '' }))}</div>
      <style>.proc svg{width:100%;height:auto;max-height:62mm}</style>
      <table>${processRows(proc, ref, { quick: c.quick }).map(([k, v]) => `<tr><td style="width:32%">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
    const mixing = m ? `<table><tr><th>Parameter</th><th class="r">Target</th><th>Actual</th></tr>${c.quick ? row(`Volume to formulate (mL) / ${c.cargoName} (mg)`, `${fmt(plan.volume_mL, 2)} / ${fmt(c.mass, 3)}`) : ''}${row('RNA volume (mL)', fmt(m.rna_mL, 2))}${row('Lipid/EtOH volume (mL)', fmt(m.lipid_mL, 2))}${c.quench ? row('Quench buffer (mL), prepare', fmt(m.quenchNeeded_mL, 2)) : ''}${row('Pump 1 RNA (mL/min)', fmt(c.flows.p1, 2))}${row('Pump 2 lipid (mL/min)', fmt(c.flows.p2, 2))}${c.quench ? row('Pump 3 quench (mL/min)', fmt(c.flows.p3, 2)) : ''}${row('Total flow (mL/min)', fmt(m.totalFlow, 2))}${row('Primary product RNA conc. (mg/mL)', fmt(m.primary_mg_mL, 3))}${row('Primary product (mL)', fmt(m.primary_mL, 2))}${row('Pre-test program run', '')}</table>` : '';
    const mixer = mixerOf(proc, ref);
    const head = `<h1>${describeId(batch.id)} · ${batch.id}</h1><div class="muted">${esc(exp?.name || '')} · ${esc(batch.label || '')} · ${esc(c.cargoName)} · composition #${batch.compositionId} ${esc(comp?.synonym || '')}${overridden ? ' (adjusted for this batch)' : ''} · planned ${fmtDate(batch.plannedDate)} · operator ${esc(settings.operator)}${c.quick ? ' · quick: mixing only' : ''}</div>
      ${benchPrint(benchNumbers(c, batch))}`;
    const inputs = `<h2>Inputs</h2><table><tr><th>Lipid stock</th><th>RNA lot</th>${c.quick ? '<th>Volume</th>' : '<th>RNA stock</th>'}<th>Working conc.</th><th>RNA input</th><th>Aqueous buffer</th><th>Quench buffer</th></tr>
      <tr><td>${esc(batch.stockId) || blank} (${fmt(c.lipid_mM, 1)} mM)</td><td>${esc(plan.rna.lotId) || blank}</td><td>${c.quick ? `${fmt(plan.volume_mL, 2)} mL` : `${fmt(c.stock_mg_mL, 2)} mg/mL`}</td><td>${fmt(c.working, 2)} mg/mL</td><td>${fmt(c.mass, c.quick ? 3 : 2)} mg</td><td>${esc(bufferLine(proc.aqueous)) || blank}</td><td>${c.quench ? esc(bufferLine(proc.quenchBuffer)) || blank : 'no quench'}</td></tr></table>`;
    // A formulation the optimizer proposed prints the fingerprint it was proposed from (spec 7.5), so the paper
    // record says which data and which model gave this setting; the predicted values sit beside it.
    const fpBlock = batch.ml?.fingerprint && exp?.design?.ml?.fingerprint?.hash === batch.ml.fingerprint ? fingerprintBlock(exp)
      : batch.ml?.fingerprint ? `<h2>Model fingerprint</h2><p><code>${esc(batch.ml.fingerprint)}</code></p>` : '';
    const predicted = batch.ml?.predicted && Object.keys(batch.ml.predicted).length
      ? `<table><tr><th>Predicted for this batch</th><th class="r">Mean</th><th class="r">95 % interval</th></tr>${Object.entries(batch.ml.predicted).map(([k, p]) => `<tr><td>${esc(k)}</td><td class="r">${fmt(p.mean, 3)}</td><td class="r">${Number.isFinite(p.sd) ? `${fmt(p.mean - 1.96 * p.sd, 3)} to ${fmt(p.mean + 1.96 * p.sd, 3)}` : ''}</td></tr>`).join('')}</table>` : '';
    const sig = `${fpBlock}${fpBlock ? predicted : ''}<div class="sig"><div>Date / signature operator</div><div>Date / signature review</div></div>`;
    if (c.quick) {
      printHtml(`${describeId(batch.id)} (${batch.id})`, `${head}${process}${inputs}<h2>LNP mixing${mixer ? ` (${esc(mixer.name)})` : ''}</h2>${mixing}${sig}`);
      return;
    }
    const body = `${head}${process}${inputs}
      <h2>Step 1 · RNA dilution</h2><table><tr><th>Parameter</th><th class="r">Target</th><th>Actual</th></tr>${c.dil ? row('RNA stock volume (mL)', fmt(c.rnaStock_mL, 3)) + row('Working solution total (mL)', fmt(c.dil.total_mL, 3)) + row(`Dilution buffer (mL)${proc.aqueous?.buffer ? `, ${esc(proc.aqueous.buffer)}` : ''}`, fmt(c.dil.diluent_mL, 3)) : ''}</table>
      <h2>Step 2 · LNP mixing${mixer ? ` (${esc(mixer.name)})` : ''}</h2>${mixing}
      ${dia ? `<h2>Step 3 · Dialysis</h2><table><tr><th>Parameter</th><th class="r">Target</th><th>Actual</th></tr>${row('Cassette', esc(dia.device || ''))}${row('Buffer', esc(bufferLine(dia)))}${row('Start volume (mL)', fmt(c.startDia, 2))}${row('Dialysis volume (L) / duration (h)', `${fmt(ds.dialysis.volume_L, 1)} / ${fmt(ds.dialysis.hours, 0)}`)}${row('Start / exchange / end (date, time)', '')}${row('End volume (mL)', '')}${row('IPC4 sample (do not freeze)', '')}</table>` : ''}
      ${tffStep ? `<h2>Step 4 · TFF</h2><table><tr><th>Parameter</th><th class="r">Target</th><th>Actual</th></tr>${row('Module', esc(tffStep.device || ''))}${row('Exchange buffer', esc(bufferLine(tffStep)))}${row('RNA load window (mg)', c.tff ? `${fmt(c.tff.minLoad_mg, 1)} – ${fmt(c.tff.maxLoad_mg, 1)}` : '')}${row('Reduce volume to (mL)', c.tff ? fmt(c.tff.reduceTo_mL, 2) : '')}${row('IPC5 sample', '')}</table>` : ''}
      <h2>Step 5 · Final formulation & filtration</h2><table><tr><th>Parameter</th><th class="r">Target</th><th>Actual</th></tr>${row('Measured RNA conc. (mg/mL)', '')}${cp ? row('1st finalFormulation: ' + esc(ds.finalFormulation.buffer1 || 'buffer 1') + ' (mL)', fmt(cp.buffer1_mL, 2)) + row('2nd finalFormulation: ' + esc(ds.finalFormulation.buffer2 || 'buffer 2') + ' (mL)', fmt(cp.buffer2_mL, 2)) + row('Final volume (mL) at ' + fmt(ds.finalFormulation.final_mg_mL, 2) + ' mg/mL', fmt(cp.vFinal_mL, 2)) : ''}${row('Pre-filter / sterile filter lots', `${esc(ds.filtration.prefilter)} / ${esc(ds.filtration.sterile)}`)}${row('IPC6, pH, osmolality samples', '')}</table>
      <h2>Step 6 · Fill & finish</h2><table><tr><th>Container</th><th class="r">Count</th><th class="r">Fill (mL)</th><th>Storage</th></tr>${ds.fill.map((f) => `<tr><td>${esc(f.container)}</td><td class="r">${f.count}</td><td class="r">${fmt(f.fill_mL, 2)}</td><td>${blank}</td></tr>`).join('')}</table>
      ${sig}`;
    printHtml(`${describeId(batch.id)} (${batch.id})`, body);
  }

  draw();
}

/*
 * The Formulations list: one group per experiment, folded when there is nothing left to do in it, and a filter
 * for what the day is about (usability cycle 2, F10). It used to be every formulation of every experiment
 * at once, some 750 words, and finding today's runs meant reading past every finished study.
 */

/** What the list can be asked to show. "Waiting for results" is made and not measured yet. */
const LIST_SHOW = [
  { id: 'todo', label: 'Still to make', has: (s) => s === 'planned', none: 'Nothing is still to make.' },
  { id: 'waiting', label: 'Waiting for results', has: (s) => s === 'produced', none: 'Nothing is waiting for results.' },
  { id: 'all', label: 'All', has: () => true, none: 'No formulations.' },
];
/** A group is finished, and folded by default, when every formulation in it has its results. */
const FINISHED = new Set(['measured', 'analyzed']);
const STATUS_COUNTS = [['planned', 'to make', ''], ['produced', 'waiting for results', 'info'], ['measured', 'measured', 'ok'], ['analyzed', 'analyzed', 'ok']];

/*
 * The view is remembered in this browser: which formulations to show, and the groups the user opened or closed
 * by hand (a group nobody touched follows the default above, so it folds by itself once it is finished). The
 * key sits under the store's own prefix, because the demo lab's Experiment 4 is not yours; being dotted, it is
 * bookkeeping (app/store.js) and never travels in an export. The text filter is not kept: a list that comes
 * back hiding most of its rows behind yesterday's search reads as records gone missing.
 */
const listPrefsKey = (ctx) => `${ctx.store.ns}.ui.formulations`;
function readListPrefs(ctx) {
  try {
    const p = JSON.parse(localStorage.getItem(listPrefsKey(ctx)) || '{}') || {};
    return { show: LIST_SHOW.some((s) => s.id === p.show) ? p.show : 'all', open: p.open && typeof p.open === 'object' ? p.open : {} };
  } catch { return { show: 'all', open: {} }; }
}
function writeListPrefs(ctx, p) { try { localStorage.setItem(listPrefsKey(ctx), JSON.stringify(p)); } catch { /* private window or full: the view just is not remembered */ } }

const CHEVRON = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3"/></svg>';

/*
 * A year of a busy lab is some 500 experiments and 2,500 formulations (usability cycle 4, S2), and this list
 * took ten seconds to open: every row looked up its formulation and its results with a pass over the whole
 * store. The rows now read maps built once per draw (app/calc/indexes.js), and the list draws only what can
 * be seen: a folded group is its header until it is opened, and the groups come a page at a time. What is
 * shown is decided from the records, not from the page, so the counts, the filter and the selection cover
 * groups whose rows were never drawn.
 */

/** How many experiment groups the list draws at a time; the rest are a "Show more" away. */
const GROUP_PAGE = 40;

/**
 * Every formulation, under the experiment that planned it.
 *
 * This screen used to lead with a card per designed experiment — the design diagram, the run counts, a link
 * to the analysis — which meant the list of things to make was mostly links to somewhere else, and following
 * one landed you back in Experiments wondering what you had clicked. The design belongs to the experiment and
 * is shown there. Here a formulation is a thing to make, and the only link on its row opens its record.
 * `query` carries the text filter across a redraw of the list (after "Mark selected produced").
 */
function list(el, ctx, query = '') {
  const exps = ctx.store.all('experiments'), batches = ctx.store.all('batches');
  const forms = batchIndex(batches);
  const results = measurementIndex(ctx.store.all('measurements'));
  const prefs = readListPrefs(ctx);

  // The experiment with something still to make comes first; within an experiment, formulation order is the
  // order they are numbered in, which is the order they were planned to be produced.
  const groups = exps
    .map((e) => {
      const fs = forms.of(e);
      return { key: e.id, e, forms: fs, left: fs.filter((b) => b.status === 'planned').length };
    })
    .filter((g) => g.forms.length)
    .sort((a, b) => (a.left ? 0 : 1) - (b.left ? 0 : 1) || String(b.e.startDate || '').localeCompare(String(a.e.startDate || '')));

  const seen = new Set(groups.flatMap((g) => g.forms.map((b) => b.id)));
  const orphans = batches.filter((b) => !seen.has(b.id));
  if (orphans.length) groups.push({ key: 'orphans', e: null, forms: orphans, left: 0 });
  for (const g of groups) {
    g.finished = g.forms.every((b) => FINISHED.has(b.status));
    g.find = g.e ? findText(g.e.id, describeId(g.e.id), g.e.name) : '';
  }
  const everything = groups.flatMap((g) => g.forms);

  const any = groups.length > 0;
  const nShow = Object.fromEntries(LIST_SHOW.map((s) => [s.id, everything.filter((b) => s.has(b.status)).length]));
  el.innerHTML = header('Run', 'Formulations',
    `<a class="btn primary" href="#/experiments?new=1">Plan an experiment</a>`) +
    `<p class="muted" style="margin:-4px 0 14px">A formulation is numbered inside the experiment that planned it: <b>E3-F2</b> is the second formulation of experiment 3. Open one to work through its record at the bench.</p>` +
    (any ? `<div class="bulkbar sticky" id="formBulk">
      <div class="seg listShow" id="formShow" role="group" aria-label="Show">${LIST_SHOW.map((s) => `<button type="button" data-show="${s.id}" aria-pressed="${s.id === prefs.show}" class="${s.id === prefs.show ? 'on' : ''}">${esc(s.label)} <span class="segN">${nShow[s.id]}</span></button>`).join('')}</div>
      <input type="search" id="formFilter" value="${esc(query)}" placeholder="Filter by id or label" aria-label="Filter formulations by id or label" autocomplete="off">
      <span class="muted" id="formShown"></span>
      <span class="bulk-group"><label class="inline"><input type="checkbox" id="selAllForms" style="width:auto"> Select all</label>
      <button id="markSelectedProduced" disabled>Mark selected produced</button><span class="muted" id="selCount">Tick the formulations you have made.</span></span></div>
      <div class="note" id="formNone" hidden><span></span> <button type="button" id="formShowAll">Show all</button></div>
      <div id="formGroups"></div>`
      : `<div class="card"><h2>Nothing to make yet</h2><p class="muted">Formulations come from an experiment. <a href="#/advisor">Say what you are trying to find out</a> and the planner will name a design, or <a href="#/experiments?new=1">set one up yourself</a>.</p></div>`);
  if (any) wireList(el, ctx, prefs, groups, results);
}

// What the text filter looks in: the id (also in words, "experiment 3 · formulation 2") and the label.
const findText = (...parts) => parts.filter(Boolean).join(' ').toLowerCase();

/** The settings this formulation was given, where they differ from the rest of its experiment. */
function settingsOf(b) {
  const f = b.plan?.factors || {};
  const parts = Object.entries(f).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => `${k} ${fmt(v, 2)}`);
  if (parts.length) return parts.join(' · ');
  const m = b.plan?.mixing || {};
  return [m.frr != null ? `FRR ${fmt(m.frr, 2)}` : null, m.totalFlow != null ? `${fmt(m.totalFlow, 0)} mL/min` : null]
    .filter(Boolean).join(' · ');
}

/**
 * The rows of one group, as a table. The first column is a checkbox, so a bench day of eighteen runs is one
 * action rather than eighteen record visits; it is drawn ticked when the formulation is selected, because a
 * group folded and opened again draws its rows anew.
 */
function formTable(rows, results, sel) {
  return table(
    ['', 'Formulation', 'What it is', 'Settings', 'Planned', 'Status', { label: 'Z-ave', right: true }, { label: 'PDI', right: true }, { label: 'EE %', right: true }],
    rows.map((b) => {
      const r = batchResults(results, b.id);
      return {
        attrs: `data-row="${esc(b.id)}" data-status="${esc(b.status || '')}"`,
        cells: [
          raw(`<input type="checkbox" data-sel="${esc(b.id)}" data-status="${esc(b.status || '')}" aria-label="Select ${esc(b.id)}" style="width:auto"${sel.has(b.id) ? ' checked' : ''}>`),
          raw(`<a href="#/formulation?batch=${esc(b.id)}"><b>${esc(b.id)}</b></a>`),
          b.label || '—',
          raw(`<span class="muted">${esc(settingsOf(b)) || '—'}</span>`),
          fmtDate(b.plannedDate),
          raw(chip(b.status, b.status === 'planned' ? '' : 'info')),
          fmt(r.dls?.values?.zave_nm, 1), fmt(r.dls?.values?.pdi, 3), fmt(r.ee?.values?.ee_pct, 1),
        ],
      };
    }), { empty: 'Nothing planned.' });
}

const ORPHAN_INTRO = '<p class="muted" style="margin:0 0 6px">These formulations have no experiment to be numbered inside — usually imported records, or an experiment that was deleted.</p>';

/**
 * One experiment (or the orphans): a header that folds the table away, with counts by status and its
 * select-all, which works on the group's shown formulations whether or not the group is open. The counts are
 * of the whole group, whatever the filter shows. A folded group draws no rows at all.
 */
function groupCard({ g, rows, open }, results, sel, today) {
  const n = {}; for (const b of g.forms) n[b.status] = (n[b.status] || 0) + 1;
  const counts = STATUS_COUNTS.filter(([s]) => n[s]).map(([s, words, kind]) => chip(`${n[s]} ${words}`, kind)).join('');
  let title = 'Not part of an experiment', sub = '', extra = '';
  if (g.e) {
    const type = TYPES.find((t) => t.id === g.e.type);
    const hasDesign = Boolean(g.e.design?.doe?.runs?.length || g.e.design?.factor);
    const progress = experimentProgress(g.e, today);
    title = describeId(g.e.id); sub = g.e.name || '';
    extra = `${chip(type?.name || g.e.type, 'info')}<span class="muted">${progress.done} of ${progress.total} measurements in</span>
        <span class="fgLinks">${hasDesign ? `<a class="btn" href="#/doe?id=${esc(g.e.id)}">Design &amp; results</a>` : ''}
        <a class="btn" href="#/experiments?id=${esc(g.e.id)}">The plan</a></span>`;
  }
  return `<div class="card formGroup" data-group="${esc(g.key)}" data-finished="${g.finished ? 1 : 0}">
      <div class="fgHead">
        <input type="checkbox" data-selall="${esc(g.key)}" aria-label="Select every formulation shown in ${esc(title)}" style="width:auto">
        <h2 class="fgTitle"><button type="button" class="fgToggle" aria-expanded="${open}" aria-controls="fgBody-${esc(g.key)}">${CHEVRON}<span>${esc(title)}</span>${sub ? `<span class="muted" title="${esc(sub)}">· ${esc(sub)}</span>` : ''}</button></h2>
        <span class="fgCounts">${counts}</span>${extra}
      </div>
      <div class="fgBody" id="fgBody-${esc(g.key)}"${open ? '' : ' hidden'}>${open ? groupBody(g, rows, results, sel) : ''}</div></div>`;
}
const groupBody = (g, rows, results, sel) => (g.e ? '' : ORPHAN_INTRO) + formTable(rows, results, sel);

/**
 * The filter, the folding, the pages and the selection, over the records rather than the page. Typing in the
 * filter redraws the groups below the bar, never the bar, so the text box keeps its caret. A formulation the
 * filter hides is also unselected: "Mark selected produced" must only ever act on what can be seen. A folded
 * group's rows count as shown — its header says how many there are and carries their select-all — and every
 * group with a match for the text filter opens. Groups past the drawn pages are not shown, and "Select all"
 * leaves them alone.
 */
function wireList(el, ctx, prefs, groups, results) {
  const box = el.querySelector('#formGroups');
  const filterBox = el.querySelector('#formFilter'), shownNote = el.querySelector('#formShown'), none = el.querySelector('#formNone');
  const btn = el.querySelector('#markSelectedProduced'), count = el.querySelector('#selCount'), all = el.querySelector('#selAllForms');
  const today = todayISO();
  const keys = new Set(groups.map((g) => g.key));
  const total = groups.reduce((s, g) => s + g.forms.length, 0);
  const finds = new Map();
  const findOf = (b) => { let f = finds.get(b.id); if (f == null) finds.set(b.id, f = findText(b.id, describeId(b.id), b.label)); return f; };
  const openByDefault = (g) => prefs.open[g.key] ?? !g.finished;
  const sel = new Set();
  let limit = GROUP_PAGE;
  // What the last draw listed: the groups with their shown rows, and every shown formulation by id.
  let listed = [], shown = new Map();

  const draw = () => {
    const show = LIST_SHOW.find((s) => s.id === prefs.show);
    const q = filterBox.value.trim().toLowerCase();
    const hits = [];
    let matching = 0;
    for (const g of groups) {
      const groupHit = Boolean(q) && g.find.includes(q);
      const rows = g.forms.filter((b) => show.has(b.status) && (!q || groupHit || findOf(b).includes(q)));
      if (!rows.length) continue;
      matching += rows.length;
      hits.push({ g, rows, open: q ? true : openByDefault(g) });
    }
    listed = pageOf(hits, limit).shown;
    shown = new Map(listed.flatMap((h) => h.rows.map((b) => [b.id, b])));
    for (const id of [...sel]) if (!shown.has(id)) sel.delete(id);
    box.innerHTML = listed.map((h) => groupCard(h, results, sel, today)).join('')
      + moreLine({ id: 'formMore', shown: listed.length, total: hits.length, step: GROUP_PAGE, noun: 'experiments' });
    box.querySelector('#formMore')?.addEventListener('click', () => {
      const from = listed.length;
      limit += GROUP_PAGE; draw();
      focusFirstNew(box.querySelectorAll('.fgToggle'), from);
    });
    shownNote.textContent = matching === total ? `${total} formulation${total === 1 ? '' : 's'}` : `${matching} of ${total} shown`;
    none.hidden = matching > 0;
    none.firstElementChild.textContent = q ? `No formulation ${show.id === 'all' ? '' : `${show.label.toLowerCase()} `}matches "${filterBox.value.trim()}".` : show.none;
    el.querySelectorAll('#formShow [data-show]').forEach((b) => {
      const on = b.dataset.show === prefs.show;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    });
    update();
  };

  /** Recount the selection, and set the select-alls from it. */
  const update = () => {
    const picked = [...sel];
    const planned = picked.filter((id) => shown.get(id)?.status === 'planned').length;
    btn.disabled = !planned;
    count.textContent = picked.length
      ? `${picked.length} selected${planned === picked.length ? '' : `, ${planned} of them still planned`}`
      : 'Tick the formulations you have made.';
    all.checked = picked.length > 0 && picked.length === shown.size;
    all.indeterminate = picked.length > 0 && !all.checked;
    for (const h of listed) {
      const head = box.querySelector(`[data-selall="${CSS.escape(h.g.key)}"]`);
      if (!head) continue;
      head.checked = h.rows.every((b) => sel.has(b.id));
      head.indeterminate = !head.checked && h.rows.some((b) => sel.has(b.id));
    }
  };
  /** Select or unselect formulations, drawn or not, and tick the boxes of those that are drawn. */
  const pick = (rows, on) => {
    const ids = new Set(rows.map((b) => b.id));
    for (const id of ids) { if (on) sel.add(id); else sel.delete(id); }
    for (const x of box.querySelectorAll('input[data-sel]')) if (ids.has(x.dataset.sel)) x.checked = on;
    update();
  };

  // A remembered group that is gone (its experiment deleted) is dropped, so a later one given the same number
  // does not inherit it.
  const remember = () => {
    prefs.open = Object.fromEntries(Object.entries(prefs.open).filter(([k]) => keys.has(k)));
    writeListPrefs(ctx, prefs);
  };

  // Listeners go on the bar's controls and on the box the groups are drawn into, not on `el`: that element
  // outlives this screen, and a listener left on it would pile up with every redraw. The box is drawn anew
  // by each visit to the list, so its listeners go with it.
  el.querySelectorAll('#formShow [data-show]').forEach((b) => b.addEventListener('click', () => {
    prefs.show = b.dataset.show; remember(); draw();
  }));
  el.querySelector('#formShowAll').addEventListener('click', () => {
    prefs.show = 'all'; remember(); filterBox.value = ''; draw();
  });
  filterBox.addEventListener('input', draw);
  all.addEventListener('change', () => pick([...shown.values()], all.checked));
  box.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('input[data-sel]')) { if (t.checked) sel.add(t.dataset.sel); else sel.delete(t.dataset.sel); update(); }
    else if (t.matches('input[data-selall]')) pick(listed.find((h) => h.g.key === t.dataset.selall)?.rows || [], t.checked);
  });
  // Opening a group draws its rows into it, and folding it takes them out again; only that group changes,
  // so the button keeps the focus.
  box.addEventListener('click', (e) => {
    const toggle = e.target.closest('.fgToggle');
    if (!toggle) return;
    const card = toggle.closest('[data-group]'), h = listed.find((x) => x.g.key === card.dataset.group);
    if (!h) return;
    h.open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(h.open));
    const body = card.querySelector('.fgBody');
    body.innerHTML = h.open ? groupBody(h.g, h.rows, results, sel) : '';
    body.hidden = !h.open;
    prefs.open[h.g.key] = h.open; remember();
  });
  btn.addEventListener('click', () => {
    // Only planned formulations move; one already measured keeps its later status.
    const ids = [...sel].filter((id) => shown.get(id)?.status === 'planned');
    let n = 0;
    for (const id of ids) { const b = ctx.store.get('batches', id); if (b?.status === 'planned') { b.status = 'produced'; ctx.store.put('batches', b); n++; } }
    toast(`Marked ${n} formulation${n === 1 ? '' : 's'} produced`, 'ok');
    list(el, ctx, filterBox.value);
  });
  draw();
}
