// The optimizer's transparency panel (spec 7.4) and its view of prediction against measurement (spec 7.6).
//
// The panel sits at the top of the Optimizer, before and after a fit, and says what the model rests on: which
// lipid and mixer the data was chosen for (spec 7.1, asked on opening with the combination that has most data
// preselected), which lipid mode and why (7.3), how many formulations of how many and where the rest went
// (7.2), the free factors with their ranges and the runs they need (4.2), a picture of the runs on the two
// factors that matter most, the model's fingerprint with a button that makes the run again (7.5), and "Why
// these data?", the reason for every formulation, one line each. All of it is built from what select.js and
// pipeline.js recorded on the way, never recounted here, so the panel and the model cannot disagree.
import { raw, fmt, table, chip, esc } from './kit.js';
import { selectionAccount, NOT_RECORDED } from '../calc/ml/dataset.js';
import { LIPID_MODES } from '../calc/ml/lipidmode.js';
import { modeSentence } from '../calc/ml/pipeline.js';
import { shortHash } from '../calc/ml/fingerprint.js';
import { runsNeeded } from '../calc/variables.js';
import { hitRateSentence, Z95 } from '../calc/ml/predcheck.js';

/** A setting at the precision its factor is set in (as ml.js atStep): FRR 1.5, flow 45 mL/min. */
const atStep = (v, f) => { const dp = f?.step ? Math.max(0, Math.min(4, Math.ceil(-Math.log10(f.step) - 1e-9))) : 2; return Number.isFinite(v) ? Number(v.toFixed(dp)).toLocaleString('en-US', { maximumFractionDigits: dp }) : '–'; };
const n0 = (v) => Number(v || 0).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${n0(n)} ${n === 1 ? one : many}`;

/** A section folded to one line, as the optimizer's own (ml.js fold): open or closed as the user left it. */
function fold(state, key, { title, say, body, cls = '', frame = true }) {
  if (!body) return '';
  return `<details class="${frame ? 'card ' : ''}fold ${cls}" id="${key}Fold" data-fold="${key}" ${state.open[key] ? 'open' : ''}>
    <summary><h2>${title}</h2><span class="fold-say">${say}</span></summary>${body}</details>`;
}

/** A lipid key ("SM102", or "SM102+MC3") in the names the lab uses. */
export const lipidName = (key, ref) => (key == null ? 'every lipid' : key === NOT_RECORDED ? 'lipid not recorded'
  : String(key).split('+').map((k) => ref.lipidByKey[k]?.name || k).join(' + '));
const mixerName = (m) => (m == null ? 'every mixer' : m === NOT_RECORDED ? 'mixer not recorded' : m);

/** The lines of the data account that are not zero, in the order the formulations met them. */
export function accountLines(steps) {
  const s = steps || {};
  return [
    [s.handed, 'not in the selection from Data', 'not in the Data selection'],
    [s.otherLipid, 'filtered out: other lipid', 'other lipid'],
    [s.otherMixer, 'filtered out: other mixer', 'other mixer'],
    [s.noResponse, 'nothing measured for the goals switched on', 'no result'],
    [s.missingFactor, 'missing a searched factor', 'missing factors'],
    [s.relevance, 'outside the search range plus margin (data budget)', 'out of range'],
    [s.quality, 'a measurement not to be believed (data budget)', 'quality'],
    [s.mergedRuns, `merged into ${plural(s.mergedGroups || 0, 'point')} with their replicates (data budget)`, 'merged replicates'],
    [s.subselected, 'left out by the space-filling subselection (data budget)', 'subselection'],
  ].filter(([v]) => v > 0);
}

/**
 * The panel.
 * @param {object} o {state, prep (pipeline.prepare), report (or null before a fit), ref, settings, handed, rows
 *   (all formulations of the data basis, for the picture), descriptorsOn}
 */
export function transparencyCard(o) {
  const { state, prep, report, ref, handed } = o;
  const mode = report?.lipidChoice?.mode || prep.tries[0];
  const sel = report?.selection || prep.sels[mode];
  const used = report ? report.n + (report.lipidModel?.others || 0) : sel.rows.length;
  const total = prep.total;
  const lines = accountLines(sel.steps);
  // The combination: asked on opening, the one with most data preselected; a hand-over from Data overrides it.
  const combo = handed ? `<span>Data: the selection from the Data overview</span>`
    : `<label for="selCombo" style="margin:0">Lipid and mixer</label>
      <select id="selCombo" name="sel_combo" style="width:auto">${prep.combos.map((c) => `<option value="${esc(`${c.lipid}|${c.mixer}`)}" ${c.lipid === state.lipid && c.mixer === state.mixer ? 'selected' : ''}>${esc(lipidName(c.lipid, ref))} · ${esc(mixerName(c.mixer))} (${n0(c.n)})</option>`).join('')}
        <option value="*|*" ${state.lipid == null && state.mixer == null ? 'selected' : ''}>every lipid and mixer together</option></select>`;
  const avail = prep.avail;
  const modeSel = `<label for="lipidMode" style="margin:0">Lipid mode</label>
    <select id="lipidMode" name="lipidMode" style="width:auto">${['auto', 'filter', 'kernel', ...(o.descriptorsOn ? ['descriptor'] : [])].map((k) => {
      const ok = k === 'auto' || avail[k]?.ok;
      return `<option value="${k}" ${state.lipidMode === k ? 'selected' : ''} ${ok ? '' : 'disabled'}>${k === 'auto' ? 'Auto' : esc(LIPID_MODES[k].label)}${ok ? '' : ' (not available)'}</option>`;
    }).join('')}</select>`;
  const why = ['kernel', ...(o.descriptorsOn ? ['descriptor'] : [])].filter((k) => !avail[k]?.ok).map((k) => `${LIPID_MODES[k].label}: ${avail[k].why}.`).join(' ');
  const modeLine = report ? modeSentence(report) : `${LIPID_MODES[mode].long}${state.lipidMode === 'auto' && prep.tries.length > 1 ? `; Auto will compare ${prep.tries.map((m) => LIPID_MODES[m].label.toLowerCase()).join(' and ')} by cross-validation` : ''}`;
  const k = state.space.length;
  const need = runsNeeded(k, sel.target.length);
  const factors = state.space.map((f) => `${esc(f.name.replace(/\s*\(.*\)\s*$/, ''))} ${atStep(f.lo, f)}–${atStep(f.hi, f)}${f.unit ? ` ${esc(f.unit)}` : ''}`).join(', ') || 'none chosen';
  const fp = report?.fingerprint;
  const budgetNote = sel.over ? ` More than the data budget of ${n0(sel.budget)} remained, so the four budget steps chose these.` : '';
  const accountBody = `<ul class="muted" id="accountLines" style="margin:6px 0">${lines.map(([v, t]) => `<li>${n0(v)} ${esc(t)}</li>`).join('') || '<li>nothing left out</li>'}</ul>
    <p class="muted">${n0(used)} formulation${used === 1 ? '' : 's'} reach the model${report?.lipidModel?.others ? `: ${n0(report.n)} of ${esc(lipidName(state.lipid, ref))} and ${n0(report.lipidModel.others)} of the other lipids` : ''}.${budgetNote}</p>`;
  // Open while the run is being set up, where choosing the lipid and mixer is the question; after a fit, its one
  // line says the mode, the data and the fingerprint, and the rest is a click away (as every fold here).
  const say = `${esc(LIPID_MODES[mode].label)} mode${report?.lipidChoice?.chosenBy === 'auto' ? ' (auto)' : ''} · ${n0(used)} of ${n0(total)} formulations${fp ? ` · fingerprint ${esc(shortHash(fp))}` : ''}`;
  return `<details class="card fold" id="mlPanel" data-fold="panel" style="border-color:var(--c-ml)" ${(state.open.panel ?? !report) ? 'open' : ''}>
    <summary><h2>Data and model</h2><span class="fold-say">${say}</span></summary>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${combo}${modeSel}</div>
    <div class="grid g2" style="margin-top:10px;align-items:start">
      <div>
        <p style="margin:0 0 6px"><b>Mode</b> <span id="mlModeLine">${esc(modeLine)}</span></p>
        ${why ? `<p class="muted" style="margin:0 0 6px;font-size:12.5px">${esc(why)}</p>` : ''}
        <p style="margin:0 0 6px"><b>Data</b> <span id="mlDataLine">${n0(used)} of ${n0(total)} formulation${total === 1 ? '' : 's'}</span></p>
        ${fold(state, 'account', { title: 'Where the rest went', cls: 'sub', frame: false, say: lines.length ? lines.map(([v, , t]) => `${n0(v)} ${esc(t)}`).join(' · ') : 'nothing left out', body: accountBody })}
        <p style="margin:6px 0"><b>Free factors</b> ${factors}</p>
        <p class="muted" id="runsNeeded" style="margin:0 0 6px">${esc(need.sentence)}</p>
        ${fp ? `<p style="margin:6px 0"><b>Fingerprint</b> <code title="${esc(fp.hash)}">${esc(shortHash(fp))}</code> <button id="reproduceNow" data-repro="current" style="padding:2px 10px;margin-left:6px">Reproduce</button> <span id="reproduceOut" class="muted"></span></p>` : ''}
        ${(report?.warnings || []).filter((w) => /points reach the model/.test(w)).map((w) => `<div class="note warn">${esc(w)}</div>`).join('')}
      </div>
      <div>${projectionSvg(o, sel, mode)}</div>
    </div>
    ${whyFold(state, sel, ref)}
  </details>`;
}

/**
 * The runs on the two factors that matter most (by the fitted lengthscales, averaged over the responses; before
 * a fit, the first two chosen): used in colour, left out in grey, suggestions as stars.
 */
function projectionSvg(o, sel, mode) {
  const { state, report, rows } = o;
  const space = state.space;
  if (space.length < 2) return '<p class="muted">Choose two or more factors to see the runs on a map.</p>';
  let order = space.map((_, i) => i);
  const ard = (report?.responses || []).map((r) => r.ard).filter((a) => a?.length);
  if (ard.length) {
    const share = space.map((f) => ard.reduce((s, a) => s + (a.find((x) => x.key === f.key)?.share || 0), 0));
    order = order.sort((a, b) => share[b] - share[a]);
  }
  const [fa, fb] = [space[order[0]], space[order[1]]];
  const W = 300, H = 220, L = 40, B = 34, T = 8, R = 8;
  const pad = (f) => (f.hi - f.lo) * 0.2;
  const sx = (v) => L + Math.max(0, Math.min(1, (v - (fa.lo - pad(fa))) / (fa.hi - fa.lo + 2 * pad(fa)))) * (W - L - R);
  const sy = (v) => H - B - Math.max(0, Math.min(1, (v - (fb.lo - pad(fb))) / (fb.hi - fb.lo + 2 * pad(fb)))) * (H - T - B);
  const usedIds = new Set(sel.rows.map((r) => r.batchId));
  const targetIds = new Set(sel.target.map((r) => r.batchId));
  const ok = (r) => Number.isFinite(r.factors?.[fa.key]) && Number.isFinite(r.factors?.[fb.key]);
  // Grey: every formulation of the data basis that carries both factors and is not in the model, at most 1,500,
  // so ten thousand do not make the page heavy; the count in the caption is the true one.
  const grey = rows.filter((r) => !usedIds.has(r.batchId) && ok(r));
  const greyShown = grey.slice(0, 1500);
  const dots = [
    ...greyShown.map((r) => `<circle cx="${sx(r.factors[fa.key]).toFixed(1)}" cy="${sy(r.factors[fb.key]).toFixed(1)}" r="2.2" fill="var(--ink2)" opacity=".28"/>`),
    ...sel.rows.filter(ok).map((r) => `<circle cx="${sx(r.factors[fa.key]).toFixed(1)}" cy="${sy(r.factors[fb.key]).toFixed(1)}" r="3.2" fill="${targetIds.has(r.batchId) ? 'var(--c-ml)' : 'var(--accent)'}" opacity=".8"><title>${esc(r.batchId)}</title></circle>`),
  ].join('');
  const star = (x, y) => { const pts = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? 3 : 7.5; pts.push(`${(x + rr * Math.cos(a)).toFixed(1)},${(y + rr * Math.sin(a)).toFixed(1)}`); } return pts.join(' '); };
  const stars = (report?.suggestions?.picks || []).map((p, i) => `<polygon points="${star(sx(p.point[fa.key]), sy(p.point[fb.key]))}" fill="var(--warn)" stroke="var(--bg)" stroke-width="1"><title>suggestion ${i + 1}</title></polygon>`).join('');
  const box = `<rect x="${sx(fa.lo).toFixed(1)}" y="${sy(fb.hi).toFixed(1)}" width="${(sx(fa.hi) - sx(fa.lo)).toFixed(1)}" height="${(sy(fb.lo) - sy(fb.hi)).toFixed(1)}" fill="none" class="mn" stroke-dasharray="3 3"/>`;
  const short = (f) => esc(f.name.replace(/\s*\(.*\)\s*$/, ''));
  return `<svg id="mlProjection" viewBox="0 0 ${W} ${H}" role="img" aria-label="runs on ${short(fa)} and ${short(fb)}" style="width:100%;max-width:${W + 40}px;height:auto">
    ${box}${dots}${stars}
    <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="ax"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="ax"/>
    <text x="${(L + W - R) / 2}" y="${H - 8}" class="lb" text-anchor="middle">${short(fa)}</text>
    <text x="12" y="${(T + H - B) / 2}" class="lb" transform="rotate(-90 12 ${(T + H - B) / 2})" text-anchor="middle">${short(fb)}</text></svg>
    <p class="muted" style="font-size:12px;margin:2px 0 0">The two factors that matter most${report ? ', by the fitted lengthscales' : ''}. Purple: in the model${mode !== 'filter' ? ', blue: other lipids sharing the model' : ''}; grey: left out (${n0(grey.length)}); stars: suggestions; dashed: the search range.</p>`;
}

/**
 * "Why these data?": every formulation with its reason, the left-out ones first. The list is drawn when the fold
 * is opened (whyTable, from ml.js), not with every redraw: ten thousand formulations are a long table to build
 * for a fold most visits never open.
 */
function whyFold(state, sel, ref) {
  const acc = selectionAccount(sel);
  return fold(state, 'why', { title: 'Why these data?', cls: 'sub', frame: false,
    say: `${n0(acc.used)} in the model, ${n0(acc.total - acc.used)} left out, a reason for each`,
    body: `<div id="whyBody">${state.open.why ? whyTable(sel, ref) : ''}</div>` });
}

/** The list inside "Why these data?". */
export function whyTable(sel, ref) {
  const acc = selectionAccount(sel);
  const order = { excluded: 0, merged: 1, used: 2 };
  const rows = acc.rows.slice().sort((a, b) => order[a.status] - order[b.status]);
  const cap = 300;
  const kind = { used: 'ok', merged: 'info', excluded: 'warn' };
  const body = `<p class="muted">Every formulation of the data basis and what happened to it, the ones left out first. ${rows.length > cap ? `The first ${cap} of ${n0(rows.length)} are listed; the CSV has them all.` : ''}</p>
    ${table(['Formulation', 'Lipid', 'Mixer', 'In the model', 'Reason', 'Detail'], rows.slice(0, cap).map((r) => ({ cells: [
      raw(`<a href="#/formulation?batch=${esc(r.batchId)}">${esc(r.batchId)}</a>`), lipidName(r.lipid, ref), mixerName(r.mixer),
      raw(chip(r.status === 'used' ? 'yes' : r.status === 'merged' ? 'merged' : 'no', kind[r.status])), r.reason, r.detail] })))}
    <button id="accountCsv" style="margin-top:8px">Export the list (CSV)</button>`;
  return body;
}

/** The account as CSV, for the export button. */
export function accountCsv(sel) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return ['formulation,lipid,mixer,status,reason,detail', ...selectionAccount(sel).rows.map((r) => [r.batchId, r.lipid, r.mixer, r.status, r.reason, r.detail].map(q).join(','))].join('\n') + '\n';
}

/* ---------------- prediction against measurement (spec 7.6) ---------------- */

/** Predicted against measured for one response: the 95 % interval as a bar, the result as a dot. */
function scatter(resp) {
  const pts = resp.points;
  const lo = Math.min(...pts.map((p) => Math.min(p.lo, p.measured))), hi = Math.max(...pts.map((p) => Math.max(p.hi, p.measured)));
  const pad = (hi - lo) * 0.06 || 1;
  const W = 260, H = 220, L = 46, B = 34, T = 8, R = 8;
  const sx = (v) => L + ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (W - L - R);
  const sy = (v) => H - B - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - T - B);
  const dp = resp.name === 'PDI' ? 3 : 1;
  return `<figure style="margin:0"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="predicted against measured, ${esc(resp.label)}" style="width:100%;max-width:${W}px;height:auto">
    <line x1="${sx(lo - pad)}" y1="${sy(lo - pad)}" x2="${sx(hi + pad)}" y2="${sy(hi + pad)}" class="mn" stroke-dasharray="4 3"/>
    ${pts.map((p) => `<line x1="${sx(p.predicted).toFixed(1)}" y1="${sy(p.lo).toFixed(1)}" x2="${sx(p.predicted).toFixed(1)}" y2="${sy(p.hi).toFixed(1)}" stroke="var(--ink2)" opacity=".45"/>
      <circle cx="${sx(p.predicted).toFixed(1)}" cy="${sy(p.measured).toFixed(1)}" r="3.6" fill="${p.inside ? 'var(--c-ml)' : 'var(--warn)'}"><title>${esc(p.batchId)}: predicted ${fmt(p.predicted, dp)} (${fmt(p.lo, dp)} … ${fmt(p.hi, dp)}), measured ${fmt(p.measured, dp)}</title></circle>`).join('')}
    <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="ax"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="ax"/>
    <text x="${(L + W - R) / 2}" y="${H - 8}" class="lb" text-anchor="middle">predicted</text>
    <text x="12" y="${(T + H - B) / 2}" class="lb" transform="rotate(-90 12 ${(T + H - B) / 2})" text-anchor="middle">measured</text></svg>
    <figcaption class="muted" style="font-size:12px"><b>${esc(resp.label)}</b>${resp.unit ? ` (${esc(resp.unit)})` : ''}: ${resp.hits} of ${resp.n} inside (${Math.round(resp.rate * 100)} %)</figcaption></figure>`;
}

/** The share inside the interval, round by round and so far, against the 95 % it should be. */
function course(rounds) {
  if (rounds.length < 2) return '';
  const W = 520, H = 160, L = 40, B = 30, T = 10, R = 10;
  const sx = (i) => L + (i / (rounds.length - 1)) * (W - L - R);
  const sy = (v) => H - B - v * (H - T - B);
  return `<svg id="predCourse" viewBox="0 0 ${W} ${H}" role="img" aria-label="share inside the interval over the rounds" style="width:100%;height:auto">
    <line x1="${L}" y1="${sy(0.95)}" x2="${W - R}" y2="${sy(0.95)}" class="mn" stroke-dasharray="4 3"/><text x="${W - R}" y="${sy(0.95) - 4}" class="lb" text-anchor="end">95 %</text>
    <polyline points="${rounds.map((r, i) => `${sx(i).toFixed(1)},${sy(r.cumulative).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--c-ml)" stroke-width="2"/>
    ${rounds.map((r, i) => `<circle cx="${sx(i).toFixed(1)}" cy="${sy(r.rate).toFixed(1)}" r="3.5" fill="var(--ink2)" opacity=".6"><title>${esc(r.name)}: ${r.hits} of ${r.n} inside</title></circle>`).join('')}
    <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" class="ax"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" class="ax"/>
    <text x="${L - 6}" y="${sy(1) + 4}" class="lb" text-anchor="end">100</text><text x="${L - 6}" y="${sy(0) + 4}" class="lb" text-anchor="end">0</text>
    <text x="${(L + W - R) / 2}" y="${H - 8}" class="lb" text-anchor="middle">ML rounds in order: dots each round, the line all so far</text></svg>`;
}

/**
 * The view over all ML batches (spec 7.6), with the rounds whose fingerprint can be reproduced (7.5).
 * @param {object} check  predcheck.predictionCheck() over every formulation, not just the data basis
 * @param {object[]} rounds  ML experiments carrying a fingerprint: {id, name, fp}
 */
export function predictionFold(state, check, rounds) {
  if (!check.overall.n && !rounds.length) return '';
  const say = check.overall.n ? `${Math.round(check.overall.rate * 100)} % of ${check.overall.n} results inside the 95 % interval (target about 95 %)` : 'no suggested formulation measured yet';
  const body = `<p>${esc(hitRateSentence(check.overall))}</p>
    ${check.responses.length ? `<div class="grid g3">${check.responses.map(scatter).join('')}</div>` : ''}
    ${course(check.rounds)}
    <p class="muted">Each bar is the 95 % interval the optimizer gave for one batch at that setting, its own uncertainty and the measurement scatter together; the dot is what was measured. Purple inside, orange outside.</p>
    ${rounds.length ? `<h2 style="font-size:14px;margin-top:12px">Rounds with a fingerprint</h2>
      ${table(['Experiment', 'Fingerprint', 'Records', 'Mode', ''], rounds.map((r) => ({ cells: [
        raw(`<a href="#/experiments?id=${esc(r.id)}">${esc(r.name || r.id)}</a>`), raw(`<code title="${esc(r.fp.hash)}">${esc(shortHash(r.fp))}</code>`), n0(r.fp.n), r.fp.mode,
        raw(`<button data-repro="${esc(r.id)}" style="padding:2px 10px">Reproduce</button> <span class="muted" data-repro-out="${esc(r.id)}"></span>`)] })))}` : ''}`;
  return fold(state, 'predcheck', { title: 'Prediction against measurement', say, body });
}

export { Z95 };
