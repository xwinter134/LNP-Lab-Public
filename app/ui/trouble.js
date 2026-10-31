// "Work out what went wrong" as an assistant (spec 9.4), on when Settings › "Troubleshooting assistant" is.
//
// Three steps, each in the address so Back and the breadcrumbs walk them: the context (read off a chosen
// formulation when there is one, every field editable), the diagnosis (the causes of the symptom weighed by that
// context, the ruled-out ones greyed with the reason, and the lab's own similar batches beside it), and the plan
// (a small experiment per likely cause, handed to the existing wizard to confirm). The reasoning is all in
// app/calc/advise.js, where it is tested; this file asks, draws and links.
import { header, esc, chip, fmt } from './kit.js';
import { getRef, getSettings, lipidLabel } from '../refdata.js';
import { TROUBLE, troubleSymptom, weighCauses, similarBatches, compareSimilar, showsSymptom, troublePlan, contextFromRow, readTroubleContext, troubleParams } from '../calc/advise.js';
import { dataRows } from '../calc/facets.js';
import { overriddenComposition } from '../calc/composition.js';
import { FACTORS } from '../calc/experiment.js';
import { MIXER_TYPES, BUFFER_SYSTEMS, POST_METHODS, CRYOPROTECTANTS } from '../calc/variables.js';
import { info, wireLearn } from './learn.js';

const STEPS = [['', 'Context'], ['diagnose', 'Diagnosis'], ['plan', 'Experiment plan']];

/** The fields of step 1: [context key, label, kind, options?]. */
const FIELDS = [
  ['lipid', 'Ionizable lipid', 'lipid'], ['mixer', 'Mixer type', 'select', MIXER_TYPES], ['buffer', 'Buffer system', 'select', BUFFER_SYSTEMS],
  ['ph', 'Loading pH', 'number', null, 0.1], ['frr', 'FRR (aq : org)', 'number', null, 0.5], ['tfr', 'TFR (mL/min)', 'number', null, 1],
  ['peg', 'PEG-lipid (mol%)', 'number', null, 0.1], ['ionizable', 'Ionizable lipid (mol%)', 'number', null, 0.5], ['np', 'N/P', 'number', null, 0.5],
  ['quench', 'Quench factor', 'number', null, 0.5], ['post', 'Downstream', 'select', POST_METHODS], ['cryo', 'Cryoprotectant', 'select', CRYOPROTECTANTS],
];

/** Every formulation as a data overview row, with its composition (overrides applied) for the PEG share. */
function lab(ctx, ref) {
  const batches = ctx.store.all('batches');
  const rows = dataRows({ batches, experiments: ctx.store.all('experiments'), measurements: ctx.store.all('measurements') }, ref);
  const byId = new Map(batches.map((b) => [b.id, b]));
  const ctxOf = (row) => {
    const b = byId.get(row.id);
    const comp = overriddenComposition(ref.compositionById[b?.compositionId], b?.plan?.compositionOverride, ref);
    return contextFromRow(row, comp, ref.lipidByKey);
  };
  return { rows, ctxOf };
}

export function renderTrouble(el, ctx) {
  const ref = getRef(ctx), settings = getSettings(ctx);
  const p = ctx.params;
  const step = p.step === 'diagnose' || p.step === 'plan' ? p.step : '';
  const { rows, ctxOf } = lab(ctx, ref);
  // The context: what the address says; on step 1, fields it does not name are read off the chosen formulation,
  // until the form has been sent once (given=1), after which an emptied field stays empty.
  const given = readTroubleContext(p);
  const fromBatch = p.batch ? rows.find((r) => r.id === p.batch) : null;
  const c = { ...given };
  if (fromBatch && p.given !== '1') {
    const auto = ctxOf(fromBatch);
    for (const k of Object.keys(auto)) if ((c[k] === '' || c[k] == null) && auto[k] != null && auto[k] !== '') c[k] = auto[k];
  }
  if (fromBatch) Object.assign(c, { compositionId: fromBatch.compositionId, size: fromBatch.size, pdi: fromBatch.pdi, ee: fromBatch.ee });
  const sym = troubleSymptom(c.symptom);
  const base = { mode: 'wizard', aim: 'trouble' };
  const go = (next) => ctx.navigate('advisor', { ...base, ...next });
  const at = STEPS.findIndex(([s]) => s === step);

  el.innerHTML = header('Plan', 'Work out what went wrong',
    `<a class="btn" href="#/advisor">Other ways in</a>`) +
    `<div id="advRoot"><ol class="adv-steps">${STEPS.map(([, s], i) => `<li class="chip ${i < at ? 'ok' : i === at ? 'info' : ''}">${i + 1} · ${esc(s)}</li>`).join('')}</ol>
      ${step === '' || !sym ? contextStep(c, ctx, ref, rows, settings, !sym && step) : step === 'diagnose' ? diagnoseStep(c, sym, rows, ctxOf, settings, ref) : planStep(c, sym, rows, ctxOf, settings, ref)}</div>`;
  wireLearn(el.querySelector('#advRoot'));

  const form = el.querySelector('#tsForm');
  if (form) {
    form.querySelector('#tsBatch').addEventListener('change', (e) => go({ batch: e.target.value }));
    const read = () => {
      const out = { batch: c.batch || '' };
      for (const [k, , kind] of FIELDS) {
        const v = form.querySelector(`[name="ts_${k}"]`).value.trim();
        out[k] = kind === 'number' ? (v === '' ? null : Number(v)) : v;
      }
      out.symptom = form.querySelector('[name=ts_symptom]:checked')?.value || '';
      return out;
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const next = read();
      if (!next.symptom) { form.querySelector('#tsSymptomNote').hidden = false; return; }
      // This step is put back in the address as it was sent, so Back from the diagnosis returns to these
      // fields and not to the formulation's values read in again.
      const here = { ...base, ...troubleParams(next), given: '1' };
      const q = new URLSearchParams(here).toString();
      try { history.replaceState(history.state, '', `#/advisor?${q}`); } catch { /* Back then reads the batch again */ }
      go({ ...troubleParams(next), given: '1', step: 'diagnose' });
    });
  }
}

/* ---------------- step 1: the context ---------------- */
function contextStep(c, ctx, ref, rows, settings, lost) {
  const ionizables = ref.lipids.filter((l) => l.class === 'ionizable');
  const batches = rows.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.id).localeCompare(String(a.id)));
  const fieldHtml = ([k, label, kind, options, step]) => {
    const v = c[k] ?? '';
    const id = `ts_${k}`;
    if (kind === 'lipid') return `<div><label for="${id}">${esc(label)}</label><select id="${id}" name="${id}"><option value="">not known</option>${ionizables.map((l) => `<option value="${esc(l.key)}"${l.key === v ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}${v && !ionizables.some((l) => l.key === v) ? `<option value="${esc(v)}" selected>${esc(v)}</option>` : ''}</select></div>`;
    if (kind === 'select') return `<div><label for="${id}">${esc(label)}</label><select id="${id}" name="${id}"><option value="">not known</option>${options.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
    return `<div><label for="${id}">${esc(label)}</label><input type="number" id="${id}" name="${id}" step="${step}" value="${esc(v)}" placeholder="not known"></div>`;
  };
  return `<form id="tsForm" class="card"><h2>What happened, and to what</h2>
      <p class="muted">Start from a formulation and its record fills the fields in; change anything that is not right, and leave empty what you do not know. An empty field counts neither for nor against a cause.</p>
      ${lost ? '<div class="note warn">Choose what is wrong first.</div>' : ''}
      <div class="grid g4"><div style="grid-column:span 2"><label for="tsBatch">Formulation</label><select id="tsBatch"><option value="">none, I will type it in</option>${batches.map((b) => `<option value="${esc(b.id)}"${b.id === c.batch ? ' selected' : ''}>${esc(`${b.id}${b.experimentName ? ' · ' + b.experimentName : ''}${b.label ? ' · ' + b.label : ''}`)}</option>`).join('')}</select></div></div>
      <div class="grid g4" style="margin-top:10px">${FIELDS.map(fieldHtml).join('')}</div>
      <h2 style="margin-top:16px">What is wrong?</h2>
      <div class="grid g3 tsSymptoms">${TROUBLE.map((t) => `<label class="adv-card tsSym"><input type="radio" name="ts_symptom" value="${t.id}" style="width:auto"${t.id === troubleSymptom(c.symptom)?.id ? ' checked' : ''}> <span class="adv-card-title">${esc(t.title)}</span></label>`).join('')}</div>
      <div class="note warn" id="tsSymptomNote" hidden>Choose what is wrong.</div>
      ${c.batch ? measuredLine(c, settings) : ''}
      <div style="margin-top:14px"><button class="primary" id="tsDiagnose" type="submit">Diagnose</button></div></form>`;
}

/** What the chosen formulation measured, so the symptom is picked against the numbers. */
function measuredLine(c, settings) {
  const bits = [c.size != null && `Z-ave ${fmt(c.size, 1)} nm`, c.pdi != null && `PDI ${fmt(c.pdi, 3)}`, c.ee != null && `EE ${fmt(c.ee, 1)} %`].filter(Boolean);
  if (!bits.length) return `<p class="muted">${esc(c.batch)} has no results yet.</p>`;
  const off = TROUBLE.filter((t) => showsSymptom({ size: c.size, pdi: c.pdi, ee: c.ee }, t.id, settings.qc)).map((t) => t.title.toLowerCase());
  return `<p class="muted" id="tsMeasured">${esc(c.batch)} measured ${esc(bits.join(', '))}${off.length ? `: against your QC limits, ${esc(off.join(' and '))}` : ''}.</p>`;
}

/* ---------------- step 2: the diagnosis ---------------- */
function contextChips(c, ref) {
  const name = (k, v) => (k === 'lipid' ? lipidLabel(ref, v) : v);
  const shown = FIELDS.filter(([k]) => c[k] !== '' && c[k] != null).map(([k, label]) => `${label} ${name(k, c[k])}`);
  return `<div class="card" style="padding:10px 14px" id="tsContext"><div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
    ${c.batch ? chip(c.batch, 'info') : ''}${chip(troubleSymptom(c.symptom)?.title || '', 'warn')}${shown.map((s) => chip(s)).join('')}
    ${shown.length ? '' : '<span class="muted">No context given: the causes are in their usual order.</span>'}</div></div>`;
}

function evidence(c, sym, rows, ctxOf, settings) {
  const sim = similarBatches(rows.map((r) => ({ ...r, peg: ctxOf(r).peg })), c);
  return { sim, cmp: compareSimilar(sim, c, sym.id, settings.qc) };
}

function diagnoseStep(c, sym, rows, ctxOf, settings, ref) {
  const { sim, cmp } = evidence(c, sym, rows, ctxOf, settings);
  const weighed = weighCauses(sym.id, c, cmp);
  const causeCard = (w, i) => `<div class="card tsCause${w.out ? ' tsOut' : ''}" data-cause="${esc(w.key)}"><div style="display:flex;gap:10px;align-items:baseline">
      <span class="chip ${w.out ? '' : i === 0 ? 'info' : ''}">${w.out ? '–' : i + 1}</span>
      <div style="flex:1"><h2 style="margin:0;font-size:16px">${esc(w.cause)} ${w.topic ? info(w.topic) : ''} <span class="chip ${w.standing === 'likely' ? 'warn' : ''} tsStanding">${esc(w.standing)}</span></h2>
        ${w.out ? `<p class="tsWhyOut" style="margin:4px 0 0">${esc(w.out)}</p>` : `${w.reasons.length ? `<ul class="adv-list tsReasons" style="margin-top:6px">${w.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        <p class="muted" style="margin:4px 0 0">${esc(w.why)}</p>
        <div style="margin-top:8px"><b>Check:</b> ${esc(w.check)}</div>
        <div style="margin-top:2px"><b>If that is it:</b> ${esc(w.fix)}</div>`}</div></div></div>`;
  const live = weighed.filter((w) => !w.out);
  return `${contextChips(c, ref)}
    <div class="card" style="border-color:var(--c-advisor)"><h2 style="font-size:20px">Likely causes of ${esc(sym.what)}, weighed by what you told me</h2>
      <p class="muted">${live.length} cause${live.length === 1 ? '' : 's'} in play${weighed.length > live.length ? `, ${weighed.length - live.length} ruled out by the context (greyed, at the end)` : ''}. Each says why it moved, and the check that settles it before a batch is spent.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn primary" id="tsToPlan" href="#/advisor?${esc(new URLSearchParams({ mode: 'wizard', aim: 'trouble', ...troubleParams(c), given: '1', step: 'plan' }).toString())}">Plan experiments for the likeliest causes</a></div></div>
    ${similarCard(c, sym, sim, cmp)}
    ${weighed.map(causeCard).join('')}`;
}

function similarCard(c, sym, sim, cmp) {
  if (!sim.length) return `<div class="card" id="tsSimilar"><h2>Your similar batches</h2><p class="muted" style="margin:0">None on file${c.lipid || c.mixer ? ' with the same lipid and mixer at nearby settings' : ''}: the diagnosis rests on the rules alone.</p></div>`;
  const cell = (r, k, d) => (r[k] == null ? '–' : fmt(r[k], d));
  return `<div class="card" id="tsSimilar"><h2>Your similar batches</h2>
    <p class="muted">${sim.length} formulation${sim.length === 1 ? '' : 's'} with ${c.lipid ? 'the same ionizable lipid' : 'any lipid'}${c.mixer ? ` on a ${esc(c.mixer)}` : ''} at nearby settings; ${cmp.withIt} show${cmp.withIt === 1 ? 's' : ''} ${esc(sym.what)} too, ${cmp.clean} do${cmp.clean === 1 ? 'es' : ''} not (against your QC limits).</p>
    ${cmp.hints.length ? `<ul class="adv-list" id="tsHints">${cmp.hints.map((h) => `<li>${esc(h.text)}</li>`).join('')}</ul>` : ''}
    <div style="overflow-x:auto"><table><thead><tr><th>Formulation</th><th style="text-align:right">FRR</th><th style="text-align:right">TFR</th><th style="text-align:right">PEG mol%</th><th style="text-align:right">Z-ave</th><th style="text-align:right">PDI</th><th style="text-align:right">EE %</th></tr></thead>
    <tbody>${sim.map((r) => `<tr><td><a href="#/formulation?batch=${esc(r.id)}">${esc(r.id)}</a></td><td style="text-align:right">${cell(r, 'frr', 1)}</td><td style="text-align:right">${cell(r, 'tfr', 0)}</td><td style="text-align:right">${cell(r, 'peg', 1)}</td><td style="text-align:right">${cell(r, 'size', 1)}</td><td style="text-align:right">${cell(r, 'pdi', 3)}</td><td style="text-align:right">${cell(r, 'ee', 1)}</td></tr>`).join('')}</tbody></table></div></div>`;
}

/* ---------------- step 3: the plan ---------------- */
function planStep(c, sym, rows, ctxOf, settings, ref) {
  const { cmp } = evidence(c, sym, rows, ctxOf, settings);
  const weighed = weighCauses(sym.id, c, cmp);
  const { plans, checks } = troublePlan(weighed, { ...c, symptom: sym.id }, FACTORS);
  const fname = (k) => FACTORS.find((f) => f.key === k)?.name || k;
  const link = (pl) => `#/experiments?${new URLSearchParams(pl.params).toString()}`;
  const levelsHtml = (pl) => (pl.kind === 'ofat'
    ? `<p style="margin:6px 0 0"><b>${esc(fname(pl.factor))}:</b> ${pl.levels.map((v) => (v === pl.control ? `<span class="chip info" title="your setting, the control">${esc(String(v))} control</span>` : `<span class="chip">${esc(String(v))}</span>`)).join(' ')}</p>`
    : pl.kind === 'doe' ? `<p style="margin:6px 0 0">${pl.factors.map((k) => `<b>${esc(fname(k))}</b> ${esc(String(pl.ranges[k][0]))} to ${esc(String(pl.ranges[k][1]))}`).join(' · ')} · four corners and a centre point</p>` : '');
  const card = (pl, i) => `<div class="card tsPlan" data-plan="${esc(pl.kind)}${pl.factor ? ':' + esc(pl.factor) : ''}"><div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
      <span class="chip ${i === 0 ? 'info' : ''}">${i + 1}</span><h2 style="margin:0;font-size:16px;flex:1">${esc(pl.title)}</h2><span class="muted">${pl.runs} batch${pl.runs === 1 ? '' : 'es'}</span></div>
      <p class="muted" style="margin:4px 0 0">For: ${esc(pl.cause)}</p>
      ${levelsHtml(pl)}
      <ul class="adv-list" style="margin-top:8px">${pl.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
      <p style="margin:4px 0 0"><b>Expect:</b> ${esc(pl.expect)}</p>
      <div style="margin-top:10px"><a class="btn primary" data-create="${i}" href="${esc(link(pl))}">Create as experiment</a> <span class="muted">opens the experiment wizard filled in, to check before anything is created</span></div></div>`;
  return `${contextChips(c, ref)}
    <div class="card" style="border-color:var(--c-advisor)"><h2 style="font-size:20px">${plans.length ? `${plans.length} small experiment${plans.length === 1 ? '' : 's'} for ${esc(sym.what)}` : 'Nothing to vary yet'}</h2>
      <p class="muted">${plans.length ? 'For the likeliest causes that are a setting: the factor at three levels beside your own setting as control, and a factorial where two causes lead. Each keeps everything else at your batch\'s settings.' : 'None of the likely causes is a setting an experiment can vary. Settle the checks below first.'}</p></div>
    ${plans.map(card).join('')}
    ${checks.length ? `<div class="card" id="tsChecks"><h2>Check first, no batch needed</h2><ul class="adv-list">${checks.map((x) => `<li><b>${esc(x.cause)}:</b> ${esc(x.check)}</li>`).join('')}</ul></div>` : ''}`;
}
