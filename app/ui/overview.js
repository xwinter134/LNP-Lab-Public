// Screen: Overview — what is due, the latest results against the QC band, what needs attention, recent batches. All from the store.
import { raw, fmt, table, chip, header, todayISO, addDays, fmtDate, kpi, esc, listDrafts } from './kit.js';
import { getSettings } from '../refdata.js';
import { collectEvents, notifyToday } from './calendar.js';
import { summarize } from './measurements.js';
import { TYPES } from '../calc/experiment.js';
import { readinessFor } from '../calc/ml/optimizer.js';
import { ICONS } from './icons.js';
import { describeId, seedCounters } from '../schema.js';
import { niceTicks, figure, wireFigures } from './charts.js';
import { latestMeasured, latestSentence, qcOf } from '../calc/latest.js';
import { backupDue, exportNow, snoozeBackup } from './backup.js';

const LATEST_N = 20;

/**
 * "Is today's work OK?" in one look (usability cycle 2, F9): the last formulations measured, size above and
 * PDI below on one x axis, against the QC band from Settings, with the sentence that says the same in words.
 * Every point opens its formulation. Nothing is drawn until something has been measured.
 */
function latestCard(measurements, qc) {
  const rows = latestMeasured(measurements, LATEST_N);
  if (!rows.length) return '';
  const w = 920, L = 54, R = 96, gap = 24, H1 = 136, H2 = 66, T1 = 12, T2 = T1 + H1 + gap;
  const long = rows.some((r) => r.batchId.length > 5) || rows.length > 12;
  const B = long ? 60 : 30, h = T2 + H2 + B;
  const slot = (w - L - R) / rows.length, cx = (i) => L + slot * (i + 0.5);
  const fin = (x) => Number.isFinite(x);
  const zt = niceTicks(Math.min(...rows.map((r) => r.zave), ...[qc.zaveMin].filter(fin)), Math.max(...rows.map((r) => r.zave), ...[qc.zaveMax].filter(fin)), 4);
  const pt = niceTicks(0, Math.max(...rows.map((r) => r.pdi).filter(fin), ...[qc.pdiMax].filter(fin), 0.1), 2);
  const scale = (t, top, H) => (v) => top + (1 - (v - t[0]) / ((t[t.length - 1] - t[0]) || 1)) * H;
  const sz = scale(zt, T1, H1), sp = scale(pt, T2, H2);
  const tick = (v) => (Math.abs(v) >= 10 ? String(Math.round(v)) : String(Math.round(v * 100) / 100));
  const grid = (t, s) => t.map((v) => `<line x1="${L}" x2="${w - R}" y1="${s(v).toFixed(1)}" y2="${s(v).toFixed(1)}" class="ax" opacity=".45"/><text x="${L - 6}" y="${(s(v) + 4).toFixed(1)}" class="lb" text-anchor="end">${tick(v)}</text>`).join('');
  // The QC band: the range a good batch sits in, shaded, with its edges dashed and named on the right.
  const band = (lo, hi, s, t, label) => {
    const a = s(Math.min(hi, t[t.length - 1])), b = s(Math.max(lo, t[0]));
    if (!(b > a)) return '';
    return `<rect x="${L}" y="${a.toFixed(1)}" width="${w - L - R}" height="${(b - a).toFixed(1)}" fill="var(--ok)" opacity=".13"/>`
      + [lo, hi].filter((v) => fin(v) && v > t[0] && v < t[t.length - 1]).map((v) => `<line x1="${L}" x2="${w - R}" y1="${s(v).toFixed(1)}" y2="${s(v).toFixed(1)}" stroke="var(--ok-text)" stroke-width="1" stroke-dasharray="4 4" opacity=".7"/>`).join('')
      + `<text x="${w - R + 6}" y="${((a + b) / 2 + 4).toFixed(1)}" class="lb">${esc(label)}</text>`;
  };
  // Inside the limits a round dot; outside, an orange diamond, so the two differ in shape and not only colour.
  const mark = (x, y, out) => (out
    ? `<path d="M${x.toFixed(1)},${(y - 6).toFixed(1)} l6,6 l-6,6 l-6,-6 z" fill="var(--warn)" stroke="var(--card)" stroke-width="1.5"/>`
    : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="var(--s1)" stroke="var(--card)" stroke-width="2"/>`);
  const pts = rows.map((r, i) => {
    const q = qcOf(r, qc), x = cx(i), href = `#/formulation?batch=${encodeURIComponent(r.batchId)}`;
    const tip = `${r.batchId} · ${r.sampleName} · ${r.date}\nZ-average ${r.zave.toFixed(1)} nm${fin(r.pdi) ? ` · PDI ${r.pdi.toFixed(2)}` : ''}${q.ok ? '' : ` · outside on ${[q.size && 'size', q.pdi && 'PDI'].filter(Boolean).join(' and ')}`}`;
    const lab = long
      ? `<text x="${x.toFixed(1)}" y="${T2 + H2 + 14}" class="lb" text-anchor="end" transform="rotate(-40 ${x.toFixed(1)} ${T2 + H2 + 14})">${esc(r.batchId)}</text>`
      : `<text x="${x.toFixed(1)}" y="${T2 + H2 + 16}" class="lb" text-anchor="middle">${esc(r.batchId)}</text>`;
    return `<a href="${esc(href)}" class="lr-pt" data-batch="${esc(r.batchId)}"><title>${esc(tip)}</title>`
      + `<rect x="${(x - slot / 2).toFixed(1)}" y="${T1}" width="${slot.toFixed(1)}" height="${T2 + H2 - T1}" fill="transparent"/>`
      + mark(x, sz(r.zave), !!q.size) + (fin(r.pdi) ? mark(x, sp(r.pdi), q.pdi) : '') + lab + '</a>';
  }).join('');
  const sizeBand = fin(qc.zaveMin) || fin(qc.zaveMax) ? band(fin(qc.zaveMin) ? qc.zaveMin : -Infinity, fin(qc.zaveMax) ? qc.zaveMax : Infinity, sz, zt, `QC ${fin(qc.zaveMin) ? qc.zaveMin : ''}–${fin(qc.zaveMax) ? qc.zaveMax : ''} nm`) : '';
  const pdiBand = fin(qc.pdiMax) ? band(0, qc.pdiMax, sp, pt, `QC ≤ ${qc.pdiMax}`) : '';
  const yl = (y, text) => `<text x="12" y="${y}" class="lb" text-anchor="middle" transform="rotate(-90 12 ${y})">${esc(text)}</text>`;
  const svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Z-average and PDI of the last ${rows.length} formulations measured" style="width:100%;max-width:${w}px;height:auto;display:block">
    ${grid(zt, sz)}${grid(pt, sp)}${sizeBand}${pdiBand}
    <line x1="${L}" y1="${T1}" x2="${L}" y2="${T1 + H1}" class="ax"/><line x1="${L}" y1="${T1 + H1}" x2="${w - R}" y2="${T1 + H1}" class="ax"/>
    <line x1="${L}" y1="${T2}" x2="${L}" y2="${T2 + H2}" class="ax"/><line x1="${L}" y1="${T2 + H2}" x2="${w - R}" y2="${T2 + H2}" class="ax"/>
    ${yl(T1 + H1 / 2, 'Z-average (nm)')}${yl(T2 + H2 / 2, 'PDI')}${pts}</svg>`;
  const sentence = esc(latestSentence(rows, qc, LATEST_N)).replace(/\bE\d+-F\d+\b/g, (id) => `<a href="#/formulation?batch=${id}">${id}</a>`);
  return `<div class="card" id="latestCard"><div style="display:flex;align-items:center;gap:10px"><h2 style="flex:1">Latest results</h2><a href="#/measurements?rlist=1">All results</a></div>
    <p id="latestSentence" style="margin:0 0 10px">${sentence}</p>
    ${figure(svg, { title: `Z-average and PDI · last ${rows.length} formulation${rows.length === 1 ? '' : 's'} measured`, name: 'latest-results',
    caption: `Each formulation once, with its most recent DLS result, oldest on the left.${[qc.zaveMin, qc.zaveMax, qc.pdiMax].some(fin) ? ' The shaded band is the QC range set under Settings; a diamond is outside it.' : ''} A point opens its formulation.` })}</div>`;
}

// The set of orphaned results last hidden from the overview, by measurement id. A dotted key, so it is
// bookkeeping of this browser and never part of a backup (see Store.exportAll).
const hiddenKey = (ctx) => `${ctx.store.ns}.hidden.orphans`;
const hiddenGet = (ctx) => { try { return localStorage.getItem(hiddenKey(ctx)) || ''; } catch { return ''; } };
const hiddenSet = (ctx, v) => { try { localStorage.setItem(hiddenKey(ctx), v); } catch {} };

/**
 * What the start-up check found (ctx.orphans, app/main.js; usability cycle 3, C1): results that name a
 * formulation which is gone, or whose number an earlier version gave to a newer formulation. Each formulation
 * named opens the Measurements screen filtered to it, where every result can be read and kept or deleted; the
 * app moves nothing itself. Results deleted since start-up drop out of the note. Hiding it lasts until a
 * different set turns up, because a result kept on purpose should not be reported every morning.
 */
function orphanNotes(ctx, measurements) {
  const found = ctx.orphans;
  if (!found) return [];
  const now = new Map(measurements.map((m) => [m.id, m.batchId]));
  const still = (list) => (list || []).filter((x) => now.get(x.id) === x.batchId);
  const missing = still(found.missing), reused = still(found.reused);
  const sig = [...missing, ...reused].map((x) => x.id).sort().join(',');
  if (!sig || hiddenGet(ctx) === sig) return [];
  const SHOWN = 6;
  const links = (list) => {
    const ids = [...new Set(list.map((x) => x.batchId))];
    return ids.slice(0, SHOWN).map((b) => `<a href="#/measurements?batch=${encodeURIComponent(b)}">${esc(b)}</a>`).join(', ')
      + (ids.length > SHOWN ? ` and ${ids.length - SHOWN} more` : '');
  };
  const many = (n, one, more) => (n === 1 ? one : more);
  const hide = `<button type="button" data-hide-orphans="${esc(sig)}" style="padding:2px 8px;min-height:0;margin-left:6px">Hide</button>`;
  const out = [];
  if (missing.length) {
    const forms = new Set(missing.map((x) => x.batchId)).size;
    out.push({ level: 'warn', id: 'orphansMissing', html: `<b>${missing.length} ${many(missing.length, 'result belongs', 'results belong')}</b> to ${many(forms, 'a formulation that no longer exists', 'formulations that no longer exist')}, ${links(missing)}. Nothing has been changed: open ${many(forms, 'it', 'each')} to keep or delete the results.${hide}` });
  }
  if (reused.length) {
    const forms = new Set(reused.map((x) => x.batchId)).size;
    out.push({ level: 'warn', id: 'orphansReused', html: `<b>${reused.length} ${many(reused.length, 'result names', 'results name')}</b> ${links(reused)}, ${many(forms, 'a number', 'numbers')} an earlier version gave to a new formulation after the first was deleted, so ${many(reused.length, 'it', 'they')} may belong to either. Check the dates before relying on ${many(reused.length, 'it', 'them')}.${hide}` });
  }
  return out;
}

/**
 * The backup reminder (usability cycle 4, m2): one line when the last export is a week old or there is none,
 * and something has changed since (see backupReminder in ./backup.js). "Export now" downloads the same file as
 * Settings; "Remind me tomorrow" puts it away for a day.
 */
function backupNote(ctx) {
  const due = backupDue(ctx);
  if (!due) return [];
  const btn = 'padding:2px 8px;min-height:0;margin-left:6px';
  const what = due.since ? `<b>No backup for ${due.days} day${due.days === 1 ? '' : 's'}</b> (last ${esc(fmtDate(due.since))}), and records have changed since.` : '<b>No backup on record.</b>';
  return [{ level: '', id: 'backupDue', html: `${what} Everything is stored in this browser only.<button type="button" class="primary" id="exportNow" style="${btn}">Export now</button><button type="button" id="snoozeBackup" style="${btn}">Remind me tomorrow</button>` }];
}

export async function render(el, ctx) {
  // A store from before there were id counters starts them from what it still names (see seedCounters), here
  // because the overview is where the app opens. Bookkeeping: a failure must not cost the user the screen.
  try { seedCounters(ctx.store); } catch (err) { console.warn('The id counters could not be set up', err); }
  const settings = getSettings(ctx);
  const today = todayISO();
  const events = collectEvents(ctx);
  const dueToday = events.filter((e) => e.date === today && !e.done);
  const overdue = events.filter((e) => e.date < today && !e.done && e.kind !== 'expiry');
  const experiments = ctx.store.all('experiments'), batches = ctx.store.all('batches'), measurements = ctx.store.all('measurements');
  const openSlots = experiments.reduce((s, e) => s + (e.expected || []).filter((x) => x.status === 'open').length, 0);
  const stocks = ctx.store.all('stocks');
  const expiring = stocks.filter((s) => s.expiry && s.expiry <= addDays(today, 7));
  const active = experiments.filter((e) => e.status !== 'done');
  const inbox = ctx.store.count('inbox');
  const flagged = measurements.filter((m) => (m.flags || []).some((f) => f.level === 'warn')).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 5);

  // One line about the optional ML module: how close it is to being useful, or what it is waiting for.
  const measured = batches.filter((b) => measurements.some((m) => m.batchId === b.id && Number.isFinite(m.values?.zave_nm)));
  const awaitingMl = batches.filter((b) => b.ml && !measurements.some((m) => m.batchId === b.id));
  const mlReady = readinessFor(measured.length);
  const mlLine = measured.length === 0 ? '' : `<div class="card"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span class="ico" style="color:var(--c-ml)">${ICONS.ml}</span>
      <div style="flex:1 1 320px"><b>Optimizer</b> <span class="muted">optional</span><br>
      <span class="muted">${measured.length} measured run${measured.length === 1 ? '' : 's'}. ${
        awaitingMl.length ? `${awaitingMl.length} suggested formulation${awaitingMl.length === 1 ? '' : 's'} still waiting on results.`
        : mlReady.stage === 'seed' ? `A first model needs about 8; ${8 - measured.length} more would do it.`
        : mlReady.stage === 'model' ? 'Enough for a first model and suggested runs; its quality cannot be tested honestly until about 15.'
        : mlReady.stage === 'trust' ? 'Enough to fit a model, test it on held-out experiments and propose the next runs.'
        : 'Enough for a response surface, a predicted optimum and contour maps.'}</span></div>
      <a class="btn" href="#/ml">Open</a></div></div>`;
  const latePlanned = batches.filter((b) => b.status === 'planned' && b.plannedDate < today);
  const latest = (batchId, test) => measurements.filter((m) => m.batchId === batchId && m.test === test).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
  const recent = batches.slice().sort((a, b) => (b.plannedDate || '').localeCompare(a.plannedDate || '')).slice(0, 8);
  notifyToday(ctx);

  const attention = [
    ...orphanNotes(ctx, measurements),
    // experiments started in the wizard and left before "Create experiment" (kit.js drafts): nothing is planned
    // for them until they are created, which is easy to forget
    ...draftNotes(ctx),
    ...expiring.map((s) => ({ level: 'warn', html: `<b>Stock ${s.id}</b> ${s.expiry < today ? 'expired' : 'expires'} ${fmtDate(s.expiry)}. <a href="#/stocks?id=${s.id}">Open</a>` })),
    ...flagged.map((m) => ({ level: 'warn', html: `<b>${m.sampleName || m.batchId}</b>: ${m.flags.filter((f) => f.level === 'warn').map((f) => f.text).join(', ')}. <a href="#/measurements?id=${m.id}">Open</a>` })),
    ...(inbox ? [{ level: '', html: `<b>${inbox} imported result${inbox === 1 ? '' : 's'}</b> not assigned. <a href="#/measurements">Assign</a>` }] : []),
    ...latePlanned.map((b) => ({ level: '', html: `<b>${b.id}</b> was planned for ${fmtDate(b.plannedDate)} and is still "planned". <a href="#/formulation?batch=${b.id}">Record</a>` })),
    ...(overdue.length ? [{ level: 'warn', html: `<b>${overdue.length} overdue item${overdue.length === 1 ? '' : 's'}</b> on the calendar. <a href="#/calendar">Open calendar</a>` }] : []),
    ...backupNote(ctx),
  ];

  const empty = !experiments.length && !stocks.length && !ctx.store.count('buffers');
  el.innerHTML = header('Home', 'Overview', `<a class="btn primary" href="#/experiments?new=1">+ New experiment</a>`) +
    `<div class="grid g4" style="margin-bottom:14px">
      ${kpi('Due today', dueToday.length, overdue.length ? `${overdue.length} overdue` : '')}
      ${kpi('Measurements open', openSlots, `${measurements.length} recorded`)}
      ${kpi('Stocks expiring', raw(`<span style="color:${expiring.length ? 'var(--warn)' : 'inherit'}">${expiring.length}</span>`), 'within 7 days')}
      ${kpi('Active experiments', active.length, active.slice(0, 2).map((e) => describeId(e.id) + ' ' + (TYPES.find((t) => t.id === e.type)?.name.split(' ')[0] || '')).join(' · '))}
    </div>
    ${latestCard(measurements, settings.qc)}
    ${empty ? `<div class="card" id="tryDemo" style="border-color:var(--accent)"><h2>New here? Look around the demo lab first</h2>
      <p style="margin:0 0 10px">An invented lab with seven experiments and about 40 formulations with results: a reference set, an N/P scan, two designs, a composition screen, a stability study and one experiment still to run. It is kept apart from your own records, which stay empty until you start, and the switch at the foot of the sidebar turns it off again.</p>
      <button class="primary" id="tryDemoBtn">Try the demo lab</button></div>
    <div class="card"><h2>Getting started</h2><ol style="margin:0;padding-left:18px;line-height:1.8">
      <li><a href="#/advisor">Say what you are trying to find out</a> and the planner will name a design, or <a href="#/designs">browse the catalogue</a> if you already know.</li>
      <li><a href="#/experiments?new=1">Set the experiment up</a>: it creates the formulations, the measurements they are due, their sample names and the calendar entries.</li>
      <li><a href="#/stocks?new=1">Weigh out a lipid stock</a> and <a href="#/buffers?new=1">make up the buffers</a> the runs need.</li>
      <li>Work through each <a href="#/formulation">formulation record</a> at the bench, then <a href="#/measurements">import the instrument export</a>.</li>
      <li>Read the fit and its diagnostics on <a href="#/doe">Design &amp; results</a>, and let the <a href="#/ml">optimizer</a> propose the next round.</li></ol>
      <p class="muted" style="margin-top:8px">Every term in the app carries a <button type="button" class="learn" disabled>?</button> that explains it in a paragraph, with the numbers worth knowing and the mistake that costs a batch. They are all collected under <a href="#/learn">Reference</a>.</p>
      <p class="muted">Data stays on this computer until you export it (Settings).</p></div>` : ''}
    <div class="grid g2">
      <div class="card"><h2>Due today</h2>${table(['Item', ''], dueToday.map((e) => ({ cells: [raw(`<span class="chip ${e.kind === 'batch' ? 'ok' : e.kind === 'measurement' ? 'info' : ''}">${e.kind}</span> ${e.title}`), raw(`<a href="${e.link || '#/calendar'}">Open</a>`)] })), { empty: 'Nothing due today.' })}
        ${overdue.length ? `<p class="muted"><a href="#/calendar">${overdue.length} overdue on the calendar</a></p>` : ''}</div>
      <div class="card"><h2>Needs attention</h2>${attention.length ? attention.map((a) => `<div class="note ${a.level}"${a.id ? ` id="${a.id}"` : ''}>${a.html}</div>`).join('') : '<p class="muted">All clear.</p>'}</div>
    </div>
    <div class="card" style="border-color:var(--c-advisor)"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span class="ico" style="color:var(--c-advisor)">${ICONS.advisor}</span>
      <div style="flex:1 1 300px"><b>Not sure what to run next?</b><br><span class="muted">Answer three questions and the app will say what to run, why that and not something else, what to expect, and what usually goes wrong. It also works backwards from a symptom when a result is off.</span></div>
      <a class="btn" href="#/advisor">Plan an experiment</a></div></div>
    ${mlLine}
    <div class="card"><div style="display:flex;align-items:center;gap:10px"><h2 style="flex:1">Recent formulations</h2><a href="#/formulation">All formulations</a></div>
      ${table(['Formulation', 'Experiment', 'What it is', 'Planned', 'Z-ave / PDI', 'EE %', 'Zeta', 'Status'], recent.map((b) => { const d = latest(b.id, 'dls'), e = latest(b.id, 'ee'), z = latest(b.id, 'zeta'); return { cells: [raw(`<a href="#/formulation?batch=${b.id}"><b>${b.id}</b></a>`), raw(`<a href="#/experiments?id=${b.experimentId}">${b.experimentId}</a>`), b.label, fmtDate(b.plannedDate), d ? `${fmt(d.values.zave_nm, 1)} / ${fmt(d.values.pdi, 2)}` : '–', e ? fmt(e.values.ee_pct, 1) : '–', z ? fmt(z.values.zeta_mV, 1) : '–', raw(chip(b.status, b.status === 'planned' ? '' : b.status === 'produced' ? 'info' : 'ok'))] }; }), { empty: 'Nothing made yet.' })}</div>`;
  wireFigures(el);
  // The demo's own switch does the rest (main.js): another namespace, seeded on its first start.
  el.querySelector('#tryDemoBtn')?.addEventListener('click', () => document.getElementById('demoToggle')?.click());
  el.querySelectorAll('[data-hide-orphans]').forEach((b) => b.addEventListener('click', () => { hiddenSet(ctx, b.dataset.hideOrphans); render(el, ctx); }));
  // Redrawn once the export is on record: in the macOS app that is after the save dialog, and a redraw straight
  // away still found no backup and kept the reminder up. Only while the reminder is still on screen, so never
  // over a screen opened meanwhile.
  el.querySelector('#exportNow')?.addEventListener('click', () => exportNow(ctx).then(() => { if (el.querySelector('#exportNow')) render(el, ctx); }));
  el.querySelector('#snoozeBackup')?.addEventListener('click', () => { snoozeBackup(ctx); render(el, ctx); });
}

/** One line per experiment started and not created, with the way back into the wizard. */
function draftNotes(ctx) {
  return listDrafts(ctx, 'experiment.').map((d) => {
    const type = d.state?.type || d.kind.split('.')[1];
    const t = TYPES.find((x) => x.id === type);
    if (!t) return null;
    const name = String(d.state?.name || '').trim();
    return { level: '', id: `draftNote-${d.draftId}`, html: `<b>${esc(t.name)}${name ? ` “${esc(name)}”` : ''}</b> was started and not created yet. <a href="#/experiments?new=1&type=${esc(type)}&draft=${esc(d.draftId)}">Continue</a>` };
  }).filter(Boolean);
}
