// App shell: hash router, Things-style sidebar with search, icons and active experiments, theme and simple/advanced mode.
// Each screen lives in app/ui/<name>.js and exports render(el, ctx).
import { Store, storageProblem, describeFailure } from './store.js';
import { loadReferenceData, describeId, orphanedResults } from './schema.js';
import { toast, dropOldToasts, todayISO, esc, ask, savePending, listDrafts, unsavedWork, leaveQuestion } from './ui/kit.js';
import { ICONS } from './ui/icons.js';
import { experimentProgress, TYPES } from './calc/experiment.js';
import { demoOn, setDemo, storeNamespace, seedDemo, demoSeeded, wipeDemo, DEMO_NS } from './demo.js';
import { migrate } from './migrate.js';
import { keepRetiredTffModules, getSettings } from './refdata.js';
import { mountSearch } from './ui/searchbox.js';
import { feedbackUrl, feedbackMail, openExternal, FEEDBACK_EMAIL } from './ui/feedback.js';
import { mountCrumbs, countStep, wireBackKeys, setTrail, stayStep, currentDepth } from './ui/crumbs.js';
import { anyLayerOn } from './calc/bio.js';

/** Shown in the sidebar footer so the running copy can be matched against the repository (bump on each push). */
export const APP_VERSION = '0.16.0';

// The sidebar is the workflow, in order: plan it, run it, read it, then let the optimizer propose the next
// round. Every group is a step you actually take, so there is one path through the app rather than a menu to
// be interpreted. "Formulations" are the things you make; they are numbered inside the experiment that
// planned them, so Experiments and Formulations are two views of one tree rather than two ideas.
const SCREENS = [
  { id: 'overview', title: 'Overview', icon: 'overview', color: 'var(--c-overview)' },
  { group: 'Plan' },
  { id: 'advisor', title: 'Plan an experiment', icon: 'advisor', color: 'var(--c-advisor)' },
  { id: 'designs', title: 'Design catalogue', icon: 'designs', color: 'var(--c-advisor)' },
  { group: 'Run' },
  { id: 'experiments', title: 'Experiments', icon: 'experiments', color: 'var(--c-experiments)', children: 'experiments' },
  { id: 'formulation', title: 'Formulations', icon: 'batches', color: 'var(--c-batches)' },
  { id: 'calendar', title: 'Calendar', icon: 'calendar', color: 'var(--c-calendar)' },
  { id: 'stocks', title: 'Lipid stocks', icon: 'stocks', color: 'var(--c-stocks)' },
  { id: 'buffers', title: 'Buffers', icon: 'buffers', color: 'var(--c-buffers)' },
  { group: 'Evaluate' },
  { id: 'data', title: 'Data', icon: 'data', color: 'var(--c-insights)', children: 'views' },
  { id: 'measurements', title: 'Measurements', icon: 'measurements', color: 'var(--c-measurements)' },
  // `when`, a function of the store, hides an item until it has something to show (it stays while it is open).
  // Only while an import's refused rows wait there (spec 6.5); `when` is read on every redraw of the sidebar.
  { id: 'quarantine', title: 'Quarantine', icon: 'quarantine', color: 'var(--c-measurements)', when: (st) => st.all('quarantine').some((q) => q?.status === 'open') },
  { id: 'doe', title: 'Design & results', icon: 'doe', color: 'var(--c-doe)' },
  { id: 'insights', title: 'Insights', icon: 'insights', color: 'var(--c-insights)' },
  { id: 'studies', title: 'Studies', icon: 'studies', color: 'var(--c-measurements)', when: () => bioOn() }, // only with a biological layer on (spec 8.5)
  { group: 'Optimize' },
  { id: 'ml', title: 'Optimizer', icon: 'ml', color: 'var(--c-ml)' },
  { group: 'Reference' },
  { id: 'materials', title: 'Materials & lots', icon: 'materials', color: 'var(--c-materials)' },
  { id: 'learn', title: 'Reference', icon: 'learn', color: 'var(--c-learn)' },
  { id: 'settings', title: 'Settings & export', icon: 'settings', color: 'var(--c-settings)' },
];

// Demo mode is a second namespace, chosen once here. Everything downstream goes through ctx.store, so no
// screen can reach your real records while the demo is on, and none of them had to be told about it.
// One window writes each lab (usability cycle 6, W1, app/store.js): another window or tab on the same lab only
// shows the records, and says so at the head of every screen. The macOS app has one window and leaves this off.
const store = new Store(storeNamespace(), { windows: !globalThis.__TAURI__ });
// Opened now, alongside the reference data; nothing reads it before the startup below has awaited it.
store.onProblem = storageNote;
store.onRole = roleChanged;
store.onRefused = refused;
store.beforeYield = savePending;
const opened = store.ready();
// One view for everyone (UX review, October 2026): the simple/advanced switch hid fields people needed and showed
// nothing they did not, so it is gone. What is rarely touched is folded where it sits instead (the DoE wizard's
// seed, axial distance and plate wells). `mode` stays 'advanced' for the screens that still read it.
const ctx = { store, data: null, mode: 'advanced', navigate };
try { localStorage.removeItem('lnp-lab.mode'); } catch {}

function navigate(id, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  location.hash = '#/' + id + (q ? '?' + q : '');
}

function themeGet() { return localStorage.getItem('lnp-lab.theme') || 'auto'; }
function themeSet(t) {
  localStorage.setItem('lnp-lab.theme', t);
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  document.querySelectorAll('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === t));
}

function ring(done, total, color) {
  const r = 5.5, c = 2 * Math.PI * r, f = total ? done / total : 0;
  return `<svg class="ring" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="${r}" fill="none" stroke="${color}" stroke-opacity=".3" stroke-width="2"/><circle cx="7" cy="7" r="${r}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="${(c * f).toFixed(2)} ${c.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 7 7)"/></svg>`;
}

/** Whether a biological layer is switched on: the Studies screen is in the sidebar only then (spec 8.5). */
const bioOn = () => { try { return anyLayerOn(getSettings(ctx)); } catch { return false; } };

let navArgs = [];
function renderNav(active, activeId, activeDraft) {
  navArgs = [active, activeId, activeDraft];
  const nav = document.getElementById('nav');
  const today = todayISO();
  const exps = store.all('experiments').filter((e) => e.status !== 'done').sort((a, b) => (b.startDate || '').localeCompare(a.startDate || '')).slice(0, 6);
  // Experiments started in the wizard and not created (kit.js drafts), listed first under Experiments with a
  // dashed outline and a "draft" chip, each opening the wizard where it was left (UX: "plop into the experiment
  // section, highlighted that it's pending"). The Experiments list has the same, with what each holds.
  const drafts = listDrafts(ctx, 'experiment.').map((d) => ({ ...d, type: d.state?.type || d.kind.split('.')[1] })).filter((d) => TYPES.some((t) => t.id === d.type));
  const nKids = exps.length + drafts.length;
  const allExps = store.count('experiments');
  let dueToday = 0;
  for (const e of store.all('experiments')) dueToday += (e.expected || []).filter((s) => s.status === 'open' && s.dueDate === today).length ? 1 : 0;
  dueToday += store.all('batches').filter((b) => b.plannedDate === today && b.status === 'planned').length;
  const inbox = store.count('inbox');
  // The experiment list under "Experiments" folds away. A lab with twenty open experiments should not have to
  // scroll past all of them to reach the rest of the menu, and the choice is remembered.
  const expOpen = localStorage.getItem('lnp-lab.navExperiments') !== 'closed';
  const item = (s) => `<a class="item ${s.id === active ? 'active' : ''}" href="#/${s.id}"><span class="ico" style="color:${s.color}">${ICONS[s.icon] || ''}</span><span class="lbl">${s.title}</span>${s.id === 'calendar' && dueToday ? `<span class="badge hot">${dueToday}</span>` : ''}${s.id === 'measurements' && inbox ? `<span class="badge">${inbox}</span>` : ''}${s.children === 'experiments' && nKids ? `<button type="button" class="disclose ${expOpen ? 'open' : ''}" id="expToggle" aria-expanded="${expOpen}" aria-controls="expList" title="${expOpen ? 'Hide' : 'Show'} the ${exps.length} open experiments${drafts.length ? ` and ${drafts.length} not created yet` : ''}">${nKids}<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4l2.5 2.5L7.5 4"/></svg></button>` : ''}</a>`;
  nav.innerHTML = `<div class="brand"><span class="logo">${ICONS.logo}</span>LNP Lab${demoOn() ? '<span class="demo-chip">DEMO</span>' : ''}</div>` +
    SCREENS.map((s) => {
      if (s.group) return `<div class="group">${s.group}</div>`;
      if (s.when && s.id !== active && !s.when(store)) return '';
      let h = item(s);
      if (s.children === 'views') {
        // Saved views of the data overview (spec 5.3), each a link to its filter.
        const views = store.all('views').sort((a, b) => String(a.name).localeCompare(String(b.name)));
        if (views.length) h += `<div class="subList">${views.map((v) => `<a class="item sub ${s.id === active && location.hash === '#/data?' + v.query ? 'active' : ''}" href="#/data?${esc(v.query)}" title="${esc(v.name)}"><span class="lbl">${esc(v.name)}</span></a>`).join('')}${views.length > 1 ? `<a class="item sub" href="#/data?compare=${esc(views[0].id)},${esc(views[1].id)}"><span class="lbl muted">Compare two views</span></a>` : ''}</div>`;
      }
      if (s.children === 'experiments' && nKids) {
        h += `<div id="expList" class="subList${expOpen ? '' : ' closed'}">` +
          drafts.map((d) => {
            const t = TYPES.find((x) => x.id === d.type);
            const name = String(d.state?.name || '').trim() || `New ${t.name.replace(/^Optimization · /, '')}`;
            return `<a class="item sub navDraft ${s.id === active && activeDraft === d.draftId ? 'active' : ''}" href="#/experiments?new=1&type=${esc(d.type)}&draft=${esc(d.draftId)}" title="Not created yet: ${esc(t.name)}${d.state?.name ? ` “${esc(d.state.name)}”` : ''}. Opens the wizard where it was left." data-draft-id="${esc(d.draftId)}"><span class="ring"></span><span class="lbl">${esc(name)}</span><span class="draftTag">draft</span></a>`;
          }).join('') + exps.map((e) => { const p = experimentProgress(e, today); return `<a class="item sub ${s.id === active && activeId === e.id ? 'active' : ''}" href="#/experiments?id=${esc(e.id)}" title="${esc(e.name)}">${ring(p.done, p.total, s.color)}<span class="lbl">${esc(describeId(e.id))} · ${esc(e.name)}</span></a>`; }).join('') +
          // Only the open ones are listed here, so the list ends by saying how many there are in all: with six
          // finished experiments and one planned, a lone child read as "the lab has one experiment" (UX revision).
          (allExps > exps.length ? `<a class="item sub" href="#/experiments"><span class="ring"></span><span class="lbl muted">All ${allExps} experiments</span></a>` : '') + '</div>';
      }
      return h;
    }).join('') +
    `<div class="foot">
      <div class="seg" id="themeSeg" role="group" aria-label="Appearance">${['auto', 'light', 'dark'].map((t) => `<button type="button" data-theme="${t}" class="${themeGet() === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      <details class="feedback" id="feedbackBox"><summary>Feedback</summary>
        <button type="button" data-feedback="bug">Report a problem</button><button type="button" data-feedback="idea">Suggest an idea</button>
        ${FEEDBACK_EMAIL ? '<label class="inline feedbackBy"><input type="checkbox" id="feedbackMail" style="width:auto"> by e-mail (no GitHub account needed)</label>' : ''}
        <p>Opens ${FEEDBACK_EMAIL ? 'a GitHub issue, or an e-mail,' : 'a new GitHub issue'} with this screen and the version filled in. Nothing from your lab goes with it.</p></details>
      <label class="switch"><input type="checkbox" id="demoToggle" ${demoOn() ? 'checked' : ''}> Demo mode</label>
      ${demoOn() ? '<div class="demo-note">Invented data in a separate store. Your own records are untouched and come back when you switch this off. <button type="button" id="demoReset">Start over</button></div>' : ''}
      <div class="stats" id="footStats"></div>
    </div>`;
  // The search box is made once and carried into each rebuilt sidebar, so what was typed survives a redraw.
  mountSearch(nav, ctx);
  nav.querySelector('#demoToggle').addEventListener('change', (e) => {
    // The namespace is read at start-up, so the switch reloads rather than trying to re-point a live screen.
    setDemo(e.target.checked);
    location.reload();
  });
  nav.querySelector('#demoReset')?.addEventListener('click', async () => {
    // Awaited: in the macOS app the answer comes back as a promise (ask() in ./ui/kit.js).
    if (!(await ask('Throw away the demo lab and build a fresh one? Your own records are not affected.'))) return;
    wipeDemo(store).finally(() => location.reload());
  });
  nav.querySelector('#expToggle')?.addEventListener('click', (e) => {
    // It sits inside the link to Experiments, so it must not navigate as well as fold.
    e.preventDefault(); e.stopPropagation();
    const list = nav.querySelector('#expList'); if (!list) return;
    const open = list.classList.toggle('closed') === false;
    e.currentTarget.classList.toggle('open', open);
    e.currentTarget.setAttribute('aria-expanded', String(open));
    localStorage.setItem('lnp-lab.navExperiments', open ? 'open' : 'closed');
  });
  nav.querySelectorAll('#themeSeg button').forEach((b) => b.addEventListener('click', () => themeSet(b.dataset.theme)));
  nav.querySelectorAll('[data-feedback]').forEach((b) => b.addEventListener('click', () => {
    const screen = SCREENS.find((x) => x.id === active);
    const where = { screen: active, title: screen?.title || active, version: APP_VERSION, app: !!globalThis.__TAURI__ };
    openExternal(nav.querySelector('#feedbackMail')?.checked ? feedbackMail(b.dataset.feedback, where) : feedbackUrl(b.dataset.feedback, where));
    nav.querySelector('#feedbackBox').open = false;
  }));
  document.body.classList.add('mode-advanced');
  nav.querySelector('#footStats').textContent = `${store.count('experiments')} experiments · ${store.count('batches')} formulations · ${store.count('measurements')} measurements · v${APP_VERSION}`;
}

// Navigations can overlap: a click or a search hit can change the hash while the previous screen is still
// loading its module. Each route takes a number, and only the newest may write the screen; an older one that
// resumes after an await stops there instead of painting a screen the user has already left.
let routeSeq = 0;

// Screen modules once loaded, and the explainer's. import() resolves in a later task even for a module loaded
// long ago, so every navigation used to show "Loading …" for a moment while the hash already named the new
// screen. A check made in that moment read the placeholder: the "stuck Loading …" of usability cycles 3 and 5
// (K7) was never stuck. A screen opened before is now drawn in the same task as the hash change, and
// "Loading …" shows only while a screen's file is fetched for the first time.
const screens = new Map();
let learnModule = null;
// Set once the records and the reference data are in. A hash change before then is left to the first route,
// which reads the hash as it is by then: drawn earlier, a screen would have no reference data to draw from.
let booted = false;

/** The address parts that name what is on screen; any other parameter only changes how it is shown. */
const PLACE_PARAMS = ['id', 'batch', 'new', 'type', 'tab', 'evaluated', 'slot'];
let lastPlace = '';

async function route() {
  if (!booted) return;
  const seq = ++routeSeq;
  heard = false; keptInput = false;
  // Notes about the screen being left go with it ("Result saved" ×5 used to follow you to the next screen);
  // one raised just now, like "Created Experiment 3" on the way to it, is about the screen being opened.
  dropOldToasts(1500);
  // An explainer left open belongs to the screen it was opened from, so navigating closes it. It lives on the
  // body rather than inside #main, so replacing the screen would otherwise leave it floating over the new one.
  if (!learnModule) {
    try { learnModule = await import('./ui/learn.js'); } catch {}
    if (seq !== routeSeq) return;
  }
  try { learnModule?.closeLearn(); } catch {}
  // A note that says "Everything on this screen is still here … press “Create experiment” again" is about the
  // screen that kept its input. It followed the user to Settings, where it sends them, and there named a
  // button that is not on it (usability cycle 6, W5); from the next screen on it says what is true anywhere.
  if (store.problem?.kept) {
    const p = store.problem;
    store.problem = { ...p, kept: false, message: describeFailure({ kind: p.kind, undone: p.undone, what: p.what, reason: p.error?.message }) };
    storageNote(store.problem, { redraw: false });
  }
  const hash = location.hash.replace(/^#\/?/, '') || 'overview';
  const [id, query] = hash.split('?');
  const params = Object.fromEntries(new URLSearchParams(query || ''));
  const main = document.getElementById('main');
  countStep();
  wireBackKeys();
  try { renderNav(id, params.id, params.draft); } catch (err) {
    // A broken stored record must not leave the page blank: say what failed and where to look.
    main.innerHTML = `<div class="note warn"><b>The sidebar could not be built:</b> ${esc(err.message)}<br><span class="muted">${esc((err.stack || '').split('\n').slice(0, 3).join(' · '))}</span><br>Usually a damaged experiment or batch record; export the data under Settings (if reachable) and send the error.</div>`;
    console.error(err); return;
  }
  try {
    let mod = screens.get(id);
    if (!mod) {
      main.innerHTML = '<p class="muted">Loading …</p>';
      mod = await import(`./ui/${id}.js`);
      screens.set(id, mod);
      if (seq !== routeSeq) return;
    }
    main.innerHTML = '';
    drawing = true;
    try { await mod.render(main, { ...ctx, params }); } finally { drawing = false; }
    lockRecordFields(main);
    // The page scrolls, not #main, so a new screen used to open at whatever height the last one was left
    // (the Optimizer and a formulation record halfway down). A new screen, record or tab opens at the top; a
    // redraw of the same one (a save, a select that only changes the view) stays where the reader is.
    const place = [id, ...PLACE_PARAMS.map((k) => params[k] ?? '')].join('|');
    if (place !== lastPlace) window.scrollTo(0, 0);
    lastPlace = place;
    // The trail and the Back arrow (spec 9.1), drawn after the screen so no screen has to know about it.
    if (seq === routeSeq && main.isConnected) setTrail(mountCrumbs(main, id, params, SCREENS));
  } catch (err) {
    if (seq !== routeSeq) return;
    main.innerHTML = `<div class="note warn"><b>Screen "${id}" failed:</b> ${err.message}<br><span class="muted">${(err.stack || '').split('\n').slice(0, 3).join(' · ')}</span></div>`;
    console.error(err);
  }
}

// Errors thrown inside event handlers would otherwise only reach the console; show them so they can be reported.
// A full or blocked storage is not a programming error and is not reported as one (a preference written to a
// full localStorage still throws): it gets the same plain note as a save the store could not keep.
window.addEventListener('error', (e) => { const p = storageProblem(e.error || e); if (p) { storageNote(p); return; } toast('Error: ' + (e.message || e.error?.message || 'unknown'), 'warn'); });
window.addEventListener('unhandledrejection', (e) => { const p = storageProblem(e.reason); if (p) { storageNote(p); return; } toast('Error: ' + (e.reason?.message || e.reason || 'unknown'), 'warn'); });

/**
 * The note a failed save leaves at the head of the screen (usability cycle 4, S1). It stays, on every screen,
 * until a later write gets through, because a toast that fades would let the user go on working on changes
 * that are not kept.
 * When the store undid a change it could not keep, the screen is drawn again from what is stored, so it does
 * not go on showing a result or an experiment that does not exist; unless the screen that made the change
 * kept it, input and all (the experiment wizard, usability cycle 5, K4), and only needs its button pressed again.
 * A screen left while its write was pending has kept nothing on view: whatever the user moved to is drawn again,
 * so a list or the sidebar stops showing an experiment that was undone (cycle 6, W5).
 * "Try again" writes what is waiting to be written, so it is offered only while something is: after an undone
 * change there is nothing, and the button would retry nothing. `redraw: false` only rewrites the note.
 */
let noteWatch = null;
function storageNote(problem, { redraw = true } = {}) {
  const main = document.getElementById('main');
  let n = document.getElementById('storageNote');
  if (!problem) {
    if (n) { n.remove(); noteWatch?.disconnect(); noteWatch = null; toast('Saved: storage is working again', 'ok'); }
    return;
  }
  if (!n) {
    n = document.createElement('div');
    n.id = 'storageNote'; n.className = 'note warn'; n.setAttribute('role', 'alert');
    // At the head of the screen, in the flow rather than over its heading, and still in view when scrolling.
    n.style.cssText = 'position:sticky;top:8px;z-index:50;margin:0 0 14px;box-shadow:var(--shadow);display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap';
  }
  // Every navigation replaces the screen, so the note puts itself back at its head each time.
  const keep = () => { if (main.firstChild !== n) main.prepend(n); };
  keep();
  if (!noteWatch) { noteWatch = new MutationObserver(keep); noteWatch.observe(main, { childList: true }); }
  const reload = problem.kind === 'unopened';
  const retry = !reload && store.unsaved();
  n.innerHTML = `<span style="flex:1 1 260px">${esc(problem.message)}</span><span style="display:flex;gap:6px">${reload ? '' : '<a class="btn" href="#/settings">Settings</a>'}${reload || retry ? `<button type="button" id="storageRetry">${reload ? 'Reload' : 'Try again'}</button>` : ''}</span>`;
  n.querySelector('#storageRetry')?.addEventListener('click', () => { if (reload) location.reload(); else store.flush(); });
  if (redraw && problem.undone && !problem.kept && window.__lnpStarted) {
    // "Result saved" or "Created Experiment 3" went up before the write failed; they are no longer true.
    dropOldToasts(-1);
    // After the code that made the change has finished: with localStorage the failure is reported inside
    // the put, and a screen drawn from there would be drawn over by the rest of that screen's handler.
    setTimeout(route);
  }
}

/*
 * A window that only shows the records (usability cycle 6, W1). LNP Lab is open in another window or tab on the
 * same lab, which writes them (app/store.js): this one says so in a banner at the head of every screen, kept
 * there as the storage note is (below it when both show), with the button that makes this window the one that
 * writes. A change tried here is refused whole; the banner then says it was not saved, and the screen is drawn
 * again from what is stored, so it shows no change that was not made.
 */
const ONLY_SHOWS = 'LNP Lab is open in another window. This one only shows your records, so the two cannot write over each other.';
let windowWatch = null, refusedAt = -Infinity, drawing = false, redrawQueued = false, heard = false, keptInput = false;
function windowNote(notSaved = false) {
  const main = document.getElementById('main');
  let n = document.getElementById('windowNote');
  document.body.classList.toggle('read-only', store.readOnly);
  if (!store.readOnly) {
    if (n) { n.remove(); windowWatch?.disconnect(); windowWatch = null; }
    return;
  }
  if (!n) {
    n = document.createElement('div');
    n.id = 'windowNote'; n.className = 'note windowNote'; n.setAttribute('role', 'status');
    n.innerHTML = '<span></span><button type="button" id="takeOver">Use this window instead</button>';
    n.querySelector('#takeOver').addEventListener('click', takeOver);
  }
  if (notSaved) refusedAt = performance.now();
  n.querySelector('span').textContent = notSaved ? `Not saved: ${ONLY_SHOWS} To make the change here, press “Use this window instead”.` : ONLY_SHOWS;
  n.classList.toggle('warn', notSaved);
  const keep = () => {
    const first = main.firstChild?.id === 'storageNote' ? main.firstChild : null;
    if ((first ? first.nextSibling : main.firstChild) !== n) { if (first) first.after(n); else main.prepend(n); }
  };
  keep();
  if (!windowWatch) { windowWatch = new MutationObserver(keep); windowWatch.observe(main, { childList: true }); }
}
async function takeOver() {
  const b = document.getElementById('takeOver');
  if (b) { b.disabled = true; b.textContent = 'Switching …'; }
  await store.takeOver();
  // Once this window writes, roleChanged() takes the banner away; if it does not (another window claimed first), the button is there to press again.
  if (store.readOnly && b) { b.disabled = false; b.textContent = 'Use this window instead'; }
}
/** This window took over, or another window did: the screen is drawn again in its new state, from what is stored. */
function roleChanged(readOnly) {
  windowNote();
  if (!booted) return; // the first screen is drawn once the role is settled
  if (!readOnly) toast('Changes are saved in this window now', 'ok');
  // A screen that kept what was typed, for its button to be pressed again (the wizard), keeps it.
  if (!readOnly && keptInput) return;
  setTimeout(route);
}
/**
 * In a window that only shows the records, the fields of a record that stores as it is typed (a bench record, a
 * stock or buffer lot on record, the settings: the screens with a save status) cannot be typed into. Typing there
 * could only be refused, and the screen, drawn again from what is stored, would wipe it (usability cycle 6). The
 * banner says why, and "Use this window instead" draws the screen again with the fields open.
 */
function lockRecordFields(main) {
  if (!store.readOnly || !main.querySelector('[data-saver]')) return;
  main.querySelectorAll('input, textarea, select').forEach((f) => { if (f.type !== 'search') f.disabled = true; });
}
function refused({ kept }) {
  // A screen that writes on its own as it draws (the overview sets up the id counters of an older store) is not
  // the user changing anything: the window that writes does that, and nothing is said here.
  if (drawing || !booted) return;
  windowNote(true);
  keptInput ||= kept;
  // A screen that keeps its input to be sent again (the wizard) stays as it is. Otherwise, once the handler that
  // made the change has finished, its notes ("Saved", "Imported 12 results") go, as they are not true, and the
  // screen is drawn again from what is stored.
  if (kept || redrawQueued) return;
  redrawQueued = true;
  setTimeout(() => { redrawQueued = false; dropOldToasts(-1); route(); });
}
// A new screen says it again plainly, unless the change it refused was just now (a save on the way out of the last one).
window.addEventListener('hashchange', () => { if (store.readOnly && performance.now() - refusedAt > 1000) windowNote(); });
// The records read back from the other window are drawn once the window is looked at again, not under the user's eyes.
store.watchOtherWindows(() => { if (store.readOnly) heard = true; });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && heard && store.readOnly) route(); });

// Pages get closed: whatever is still waiting to be written goes now rather than a moment later, and another
// window on this lab may take the writing over at once.
window.addEventListener('pagehide', () => { store.flush(); store.leave(); });
// Back from the browser's page cache: which window writes is settled again.
window.addEventListener('pageshow', (e) => { if (e.persisted) store.rejoin().then((did) => { if (did) { windowNote(); route(); } }); });

/**
 * The test door: browser scenarios and the usability harness read and write the data through here, never
 * through a storage engine, so they keep working whatever the store keeps its records in. `ns` defaults to the
 * real lab, as the old `localStorage.getItem('lnp-lab.…')` calls did; write() resolves once the rows are stored.
 * failWrites('QuotaExceededError') makes every write fail as that error until failWrites(null).
 */
let realBackend = null;
window.lnpDb = {
  read: (col, ns = 'lnp-lab') => store.peek(ns, col),
  write: (col, rows, ns = 'lnp-lab') => store.poke(ns, col, rows),
  flush: async () => { await opened; return store.flush(); },
  failWrites(name = 'QuotaExceededError') {
    if (!name) { if (realBackend) store.backend = realBackend; realBackend = null; return; }
    realBackend ||= store.backend;
    const fail = () => { throw new DOMException(`Simulated failure (${name})`, name); };
    store.backend = Object.create(realBackend, { write: { value: async () => fail() }, writeSync: { value: fail } });
  },
  engine: () => store.engine,
};

// Spec 9.1: a form holding typed, unsaved input (kit.js registerDirty) is asked about before the next screen is
// drawn, whichever way the user is leaving: a link, the sidebar, a crumb, Back. Staying puts the address back
// the way it came (crumbs.js stayStep), and that hash change is not routed: the screen never left.
let stayingAt = null, askingLeave = false;
window.addEventListener('hashchange', async (e) => {
  if (stayingAt != null && location.hash === stayingAt) { stayingAt = null; return; }
  stayingAt = null;
  if (askingLeave) return;
  const was = (() => { try { return new URL(e.oldURL).hash; } catch { return ''; } })();
  const unsaved = booted && e.oldURL && was !== location.hash ? unsavedWork() : []; // a redraw dispatched by a screen has no oldURL
  if (unsaved.length) {
    const entry = (() => { try { return history.state; } catch { return null; } })();
    askingLeave = true;
    let leave = false;
    try { leave = await ask(leaveQuestion(unsaved)); } finally { askingLeave = false; }
    if (!leave) {
      stayingAt = was || '#/overview';
      if (stayStep(entry, currentDepth()) === 'forward') history.forward(); else history.back();
      // Should the browser not move (no entry that way), the address is put back in place.
      setTimeout(() => { if (stayingAt != null && location.hash !== stayingAt) { try { history.replaceState(history.state, '', stayingAt); } catch {} stayingAt = null; } }, 400);
      return;
    }
  }
  route();
});
if (!globalThis.__TAURI__) window.addEventListener('beforeunload', (e) => { if (unsavedWork().length) { e.preventDefault(); e.returnValue = ''; } });
// A draft started or discarded while a screen stays open (the first keystroke into the wizard, a Discard) is
// shown in the sidebar at once, not only after the next navigation.
window.addEventListener('lnp:drafts', () => { if (booted) { try { renderNav(...navArgs); } catch (err) { console.error(err); } } });
(async () => {
  try { ctx.data = await loadReferenceData(); }
  catch (err) { document.getElementById('main').innerHTML = `<div class="note warn"><b>Reference data could not be loaded:</b> ${esc(err.message)}. Serve the folder over http (npm start), do not open index.html directly.</div>`; return; }
  // Every collection is in memory from here on, moved out of localStorage first if an earlier version left it
  // there; every screen after this reads synchronously, as it always has.
  await opened;
  windowNote(); // with the role settled, before the first screen
  // Records written by an earlier version are renamed before any screen reads them, so no screen ever has
  // to understand two naming schemes at once. By the window that writes; another one reads them back.
  if (!store.readOnly) try {
    // {renamed, added}: what was renumbered (stores from before 0.6) and what got provenance (schema 3).
    const done = migrate(store);
    const n = done?.renamed?.batches ? Object.keys(done.renamed.batches).length : 0;
    if (n) toast(`Renumbered ${n} formulation${n === 1 ? '' : 's'} to the experiment they belong to`, 'ok');
  } catch (err) { console.error(err); toast('Existing records could not be renumbered: ' + err.message, 'warn'); }
  // A TFF module the shipped list no longer has stays with the records that name it (refdata.js).
  if (!store.readOnly) try { keepRetiredTffModules(store, ctx.data); } catch (err) { console.warn('Retired TFF modules could not be kept', err); }
  // Results whose formulation is gone, or whose number an earlier version gave out again (usability cycle 3,
  // C1). Looked for once per start, one pass over the measurements, and reported on the overview; nothing is
  // changed, because whether such a result is kept, deleted or moved is the user's call.
  try { ctx.orphans = orphanedResults(store); } catch (err) { console.warn('The check for orphaned results failed', err); }
  // An empty demo store is filled before the first screen renders, so demo mode is never an empty app.
  // Decided from the namespace the store was opened in, not by reading the switch again: the switch is only
  // ever flipped with a reload, and asking twice could pair the demo switch with the real store.
  const demo = store.ns === DEMO_NS;
  document.body.classList.toggle('demo', demo);
  if (demo && !demoSeeded(store) && !store.readOnly) {
    // The first entry is the example formulation the rest of the app opens on; seed the demo from the same one.
    const comp = ctx.data.compositions[0];
    try { seedDemo(store, comp?.id ?? 1); }
    catch (err) { console.error(err); toast('The demo lab could not be built: ' + err.message, 'warn'); }
  }
  booted = true;
  await route();
  window.__lnpStarted = true; // read by the startup watchdog in index.html
})();
