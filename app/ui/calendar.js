// Screen: Calendar — month view of generated events (batch days, timepoints, buffer prep, stock expiry) and manual events.
import { html, raw, field, readForm, table, chip, toast, header, todayISO, addDays, fmtDate, download, uid } from './kit.js';
import { getSettings } from '../refdata.js';
import { toICS } from '../calc/ics.js';

/** All events for the store, generated on the fly plus manual ones. */
export function collectEvents(ctx) {
  const settings = getSettings(ctx);
  const out = [];
  for (const e of ctx.store.all('experiments')) {
    const byDate = {};
    for (const s of e.expected || []) (byDate[s.dueDate] ||= []).push(s);
    for (const [date, slots] of Object.entries(byDate)) {
      const samples = [...new Set(slots.map((s) => s.sampleName))];
      const tests = [...new Set(slots.map((s) => s.test))];
      const stages = [...new Set(slots.map((s) => s.stage))];
      const open = slots.filter((s) => s.status === 'open').length;
      out.push({ id: `${e.id}-${date}-m`, date, kind: 'measurement', experimentId: e.id, title: `${e.id} · ${stages.join('/')} · ${samples.length} sample${samples.length === 1 ? '' : 's'}: ${tests.join(', ')}`, done: open === 0, link: `#/experiments?id=${e.id}`, description: samples.join('\n') });
    }
  }
  const prep = {};
  for (const b of ctx.store.all('batches')) {
    out.push({ id: `${b.id}-prod`, date: b.plannedDate, kind: 'batch', experimentId: b.experimentId, title: `Produce ${b.id} (${b.label})`, done: b.status !== 'planned', link: `#/formulation?batch=${b.id}` });
    if (b.status === 'planned') (prep[addDays(b.plannedDate, -1)] ||= []).push(b);
  }
  for (const [date, bs] of Object.entries(prep)) {
    out.push({ id: `prep-${date}`, date, kind: 'prep', title: bs.length === 1 ? `Prepare buffers and RNA dilution for ${bs[0].id}` : `Prepare buffers and RNA dilutions for ${bs.length} batches`, description: bs.map((b) => b.id).join('\n'), done: false, link: bs.length === 1 ? `#/formulation?batch=${bs[0].id}` : '#/formulation' });
  }
  for (const s of ctx.store.all('stocks')) if (s.expiry) out.push({ id: `${s.id}-exp`, date: s.expiry, kind: 'expiry', title: `Stock ${s.id} expires`, done: false, link: `#/stocks?id=${s.id}` });
  for (const m of ctx.store.all('events')) out.push({ ...m, kind: 'manual', link: m.link || '' });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export async function render(el, ctx) {
  const settings = getSettings(ctx);
  const today = todayISO();
  const month = ctx.params.month || today.slice(0, 7);
  const [y, mo] = month.split('-').map(Number);
  const first = new Date(y, mo - 1, 1), last = new Date(y, mo, 0);
  const prev = new Date(y, mo - 2, 1), next = new Date(y, mo, 1);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const events = collectEvents(ctx);
  const byDate = {};
  for (const e of events) (byDate[e.date] ||= []).push(e);
  const colors = { measurement: 'info', batch: 'ok', prep: '', expiry: 'warn', manual: '' };

  const startWd = (first.getDay() + 6) % 7; // Monday first
  let cells = '';
  for (let i = 0; i < startWd; i++) cells += '<div></div>';
  for (let d = 1; d <= last.getDate(); d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const evs = byDate[date] || [];
    cells += `<div style="min-height:88px;border:1px solid var(--line);border-radius:8px;padding:6px;background:${date === today ? 'var(--accent-soft)' : 'var(--card)'}">
      <div style="font-size:12px;font-weight:600;color:${date === today ? 'var(--accent)' : 'var(--ink2)'}">${d}</div>
      ${evs.map((e) => `<a href="${e.link || '#/calendar'}" class="chip ${colors[e.kind] || ''}" style="display:block;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-decoration:${e.done ? 'line-through' : 'none'};opacity:${e.done ? 0.6 : 1}" title="${e.title}">${e.title}</a>`).join('')}
    </div>`;
  }
  const upcoming = events.filter((e) => !e.done && e.date >= today).slice(0, 12);
  const overdue = events.filter((e) => !e.done && e.date < today && e.kind !== 'expiry');

  el.innerHTML = header('Calendar', `${first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`,
    `<a class="btn" href="#/calendar?month=${iso(prev).slice(0, 7)}">‹ Prev</a><a class="btn" href="#/calendar?month=${today.slice(0, 7)}">Today</a><a class="btn" href="#/calendar?month=${iso(next).slice(0, 7)}">Next ›</a>
     <button id="exportIcs">Export .ics</button><button id="remind">Enable reminders</button>`) +
    `<div class="card"><div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;font-size:12px;color:var(--ink2);margin-bottom:4px">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div>${d}</div>`).join('')}</div>
      <div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px">${cells}</div>
      <div class="muted" style="margin-top:8px">${chip('measurement day', 'info')} ${chip('production', 'ok')} ${chip('preparation')} ${chip('stock expiry', 'warn')} · struck through = done</div></div>
     <div class="grid g2">
      <div class="card"><h2>Upcoming</h2>${table(['Date', 'Event'], upcoming.map((e) => ({ cells: [fmtDate(e.date), raw(`<a href="${e.link || '#/calendar'}">${e.title}</a>`)] })), { empty: 'Nothing scheduled.' })}</div>
      <div class="card"><h2>Overdue (${overdue.length})</h2>${table(['Date', 'Event'], overdue.map((e) => ({ cells: [fmtDate(e.date), raw(`<a href="${e.link || '#/calendar'}">${e.title}</a>`)] })), { empty: 'Nothing overdue.' })}</div>
     </div>
     <div class="card"><h2>Add manual event</h2><div class="grid g4" id="evForm">${field({ id: 'date', label: 'Date', type: 'date', value: today })}${field({ id: 'title', label: 'Title', type: 'text' })}${field({ id: 'link', label: 'Link (optional, e.g. #/experiments?id=E1)', type: 'text', advanced: true })}</div>
      <div style="margin-top:10px"><button class="primary" id="addEv">Add</button></div>
      ${ctx.store.count('events') ? `<div style="margin-top:10px">${table(['Date', 'Title', ''], ctx.store.all('events').map((e) => ({ cells: [fmtDate(e.date), e.title, raw(`<button data-rm="${e.id}" style="padding:3px 8px">✕</button>`)] })))}</div>` : ''}</div>`;

  el.querySelector('#addEv').addEventListener('click', () => {
    const f = readForm(el.querySelector('#evForm'));
    if (!f.title || !f.date) { toast('Date and title required', 'warn'); return; }
    ctx.store.put('events', { id: uid(), date: f.date, title: f.title, link: f.link || '' }); toast('Event added', 'ok'); render(el, ctx);
  });
  el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { ctx.store.remove('events', b.dataset.rm); render(el, ctx); }));
  el.querySelector('#exportIcs').addEventListener('click', () => {
    const [hh, mm] = (settings.reminderTime || '09:00').split(':').map(Number);
    const ics = toICS(events.filter((e) => !e.done).map((e) => ({ id: e.id, title: e.title, description: e.description || '', start: new Date(`${e.date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`), reminderMinutes: 30 })));
    // Said once there is a file: in the macOS app download() answers only after the save dialog, with null if it
    // was cancelled.
    Promise.resolve(download('lnp-lab.ics', ics, 'text/calendar')).then((saved) => saved && toast('Calendar exported', 'ok'));
  });
  el.querySelector('#remind').addEventListener('click', async () => {
    const app = appNotifier();
    if (!app && !('Notification' in window)) { toast('Notifications not supported here', 'warn'); return; }
    const p = app ? ((await app.isPermissionGranted()) ? 'granted' : await app.requestPermission()) : await Notification.requestPermission();
    if (p !== 'granted') { toast('Reminders not allowed', 'warn'); return; }
    localStorage.setItem('lnp-lab.reminders', '1');
    notifyToday(ctx); toast('Reminders on: you get a notification when the app opens on a day with events', 'ok');
  });
}

// WKWebView, the macOS app's window, has no Notification of its own: there tauri-plugin-notification sends them,
// through the API that withGlobalTauri (src-tauri/tauri.conf.json) puts on window.__TAURI__. A browser has none of
// it and uses Notification as before. The plugin is asked for its permission each time, so a reminder at start-up
// does not depend on how soon the page learnt it.
function appNotifier() {
  const n = globalThis.__TAURI__?.notification;
  return n?.sendNotification && n.isPermissionGranted && n.requestPermission ? n : null;
}

/** Called from the shell on load: one notification for today's open events, if the user enabled it. */
export function notifyToday(ctx) {
  try {
    const app = appNotifier();
    if (localStorage.getItem('lnp-lab.reminders') !== '1' || (!app && (!('Notification' in window) || Notification.permission !== 'granted'))) return;
    const today = todayISO();
    const key = 'lnp-lab.notified.' + today;
    if (localStorage.getItem(key)) return;
    const evs = collectEvents(ctx).filter((e) => e.date === today && !e.done);
    if (!evs.length) return;
    const body = evs.map((e) => e.title).join('\n').slice(0, 300);
    if (app) {
      app.isPermissionGranted().then((ok) => { if (ok) { app.sendNotification({ title: 'LNP Lab: due today', body }); localStorage.setItem(key, '1'); } }).catch(() => {});
      return;
    }
    new Notification('LNP Lab: due today', { body });
    localStorage.setItem(key, '1');
  } catch {}
}
