// The breadcrumb bar and the Back arrow at the head of every screen (spec 9.1).
//
// The router already puts each screen and most of its inner states in the hash (#/advisor?mode=wizard&aim=trouble),
// so the browser's own Back, the mouse's back button and the trackpad swipe walk through them. What was missing is
// something on screen that says where you are and leads back, which matters most in the macOS app: its window has
// no Back button and, depending on the WebView, may not pass the swipe through. So:
//
// - `crumbsFor` turns a route into a trail of links, from the sidebar group down to the record or wizard step.
//   It is pure (no DOM) so the trail of every screen can be tested.
// - `mountCrumbs` draws it, with a Back arrow: one step back in this window's history when there is one inside
//   the app, else up one crumb, so the arrow never leaves the app or does nothing.
// - Cmd+[ / Cmd+] (Ctrl on other systems) and the mouse's back and forward buttons go back and forward, for the
//   WebViews that do not do so themselves.
import { esc } from './kit.js';
import { describeId } from '../schema.js';
import { AIMS, SYMPTOMS, BUDGETS, SCOPES } from '../calc/advise.js';
import { roleLabel } from '../calc/buffer.js';

const href = (id, params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return '#/' + id + (q ? '?' + q : '');
};

const titleOf = (list, id) => list.find((x) => x.id === id)?.title || id;
const MATERIAL_TABS = { lipids: 'Lipids & lots', compositions: 'Compositions', rna: 'RNA lots', buffers: 'Buffer catalog', tff: 'TFF modules', consumables: 'Consumables' };

/**
 * The trail for one route: [{label, href}], the last one being where you are (its href is the route itself).
 * @param {string} id        the screen id (the part of the hash before "?")
 * @param {object} params    the hash parameters
 * @param {Array} screens    the sidebar's SCREENS list ({id, title} and {group} entries, in order)
 */
export function crumbsFor(id, params = {}, screens = []) {
  const out = [];
  let group = null;
  for (const s of screens) { if (s.group) group = s.group; else if (s.id === id) break; }
  const screen = screens.find((s) => s.id === id);
  if (!screen) return [{ label: id || 'Overview', href: href(id || 'overview', params) }];
  if (group && id !== 'overview') out.push({ label: group, href: null }); // a heading in the sidebar, not a page
  out.push({ label: screen.title, href: href(id) });
  const add = (label, p) => out.push({ label, href: href(id, p) });

  if (id === 'advisor') {
    // The wizard: each answer is one step deeper, and each crumb keeps the answers before it.
    if (params.mode === 'wizard' || params.aim) {
      const p = { mode: 'wizard' };
      add('Questions', { ...p });
      for (const [key, list] of [['aim', AIMS], ['symptom', SYMPTOMS], ['budget', BUDGETS], ['scope', SCOPES]]) {
        if (!params[key] || (params.step && key === 'symptom')) continue;
        p[key] = params[key];
        add(titleOf(list, params[key]), { ...p });
      }
      // The troubleshooting assistant (spec 9.4): its context, diagnosis and plan are steps of their own, each
      // keeping what was typed into the context, so Back and the trail return to the fields as they were sent.
      if (params.step === 'diagnose' || params.step === 'plan') {
        const { step, ...context } = params;
        add('Context', context);
        add('Diagnosis', { ...context, step: 'diagnose' });
        if (step === 'plan') add('Experiment plan', params);
      }
    }
  } else if (id === 'materials' && params.tab) {
    add(MATERIAL_TABS[params.tab] || params.tab, { tab: params.tab });
  } else if (id === 'buffers' && params.role && !params.id) {
    add(roleLabel(params.role), { role: params.role });
  } else if (id === 'formulation' && params.batch) {
    const exp = /^(E\d+)-F\d+/.exec(params.batch)?.[1];
    if (exp) out.push({ label: describeId(exp), href: href('experiments', { id: exp }) });
    add(describeId(params.batch), { batch: params.batch });
  } else if (id === 'learn' && params.topic) {
    add(params.topic, { topic: params.topic });
  }
  if (params.id) add(describeId(params.id), { id: params.id });
  if (params.new || params.from != null && id !== 'experiments') add('New', params);
  else if (id === 'experiments' && (params.new || params.from)) add('New experiment', params);
  // The last crumb is the page itself, whatever else its route carries.
  out[out.length - 1].href = href(id, params);
  return out;
}

/** The crumb Back goes to when there is no history inside the app: the last one before the current with a link. */
export function parentCrumb(trail) {
  for (let i = trail.length - 2; i >= 0; i--) if (trail[i].href) return trail[i];
  return null;
}

// How many navigations this window has made inside the app, so Back knows whether history.back() stays in it.
let depth = 0, wired = false;

/** Called by the router on every route: counts the step and draws the bar at the head of `main`. */
export function mountCrumbs(main, id, params, screens) {
  const trail = crumbsFor(id, params, screens);
  const bar = document.createElement('div');
  bar.className = 'crumbs';
  bar.id = 'crumbs';
  bar.setAttribute('aria-label', 'You are here');
  const parent = parentCrumb(trail);
  const canBack = depth > 0 || !!parent;
  bar.innerHTML = `<button type="button" class="crumbBack" id="crumbBack" title="Back (${isMac() ? '⌘' : 'Ctrl'}+[)" aria-label="Back" ${canBack ? '' : 'disabled'}>‹</button>` +
    `<ol>${trail.map((c, i) => `<li>${i === trail.length - 1 || !c.href ? `<span${i === trail.length - 1 ? ' aria-current="page"' : ' class="muted"'}>${esc(c.label)}</span>` : `<a href="${esc(c.href)}">${esc(c.label)}</a>`}</li>`).join('')}</ol>`;
  bar.querySelector('#crumbBack').addEventListener('click', () => goBack(trail));
  main.prepend(bar);
  return trail;
}

function goBack(trail) {
  if (depth > 0) { history.back(); return; }
  const p = parentCrumb(trail || []);
  if (p) location.hash = p.href;
}

/**
 * Where this history entry sits among the app's own: 0 for the page as opened, one more for each entry after it.
 * A new entry (a link, a navigate()) has no state yet and is numbered one past the entry it came from; an entry
 * returned to by Back or Forward still carries its number. So Back knows whether history.back() stays in the app.
 */
let lastDepth = -1;
export function countStep() {
  let st = null;
  try { st = history.state; } catch {}
  if (st && Number.isInteger(st.lnpDepth)) depth = st.lnpDepth;
  else { depth = lastDepth + 1; try { history.replaceState({ ...(st || {}), lnpDepth: depth }, ''); } catch {} }
  lastDepth = depth;
}

const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');

/** The keyboard and mouse ways back and forward, wired once. */
export function wireBackKeys() {
  if (wired) return; wired = true;
  window.addEventListener('keydown', (e) => {
    const mod = isMac() ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey || e.shiftKey) return;
    if (e.key === '[') { e.preventDefault(); goBack(lastTrail()); }
    else if (e.key === ']') { e.preventDefault(); history.forward(); }
  });
  // Mouse buttons 3 and 4 are back and forward on most mice; browsers act on them, some WebViews do not.
  window.addEventListener('mouseup', (e) => {
    if (e.button === 3) { e.preventDefault(); goBack(lastTrail()); }
    else if (e.button === 4) { e.preventDefault(); history.forward(); }
  });
}
let trailNow = [];
const lastTrail = () => trailNow;
export function setTrail(t) { trailNow = t; }
