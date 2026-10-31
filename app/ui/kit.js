// Small UI toolkit shared by all screens. No framework: strings in, DOM out.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Tagged template: interpolations are escaped unless wrapped with raw(). Arrays are joined. */
export function html(strings, ...vals) {
  return strings.reduce((out, s, i) => {
    const v = vals[i - 1];
    const str = v == null ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('') : esc(v);
    return out + str + s;
  });
}
// toString matters: a helper that returns raw() is often interpolated into another raw() template, and
// without it that nests as "[object Object]" in the page instead of the markup it already built.
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s ?? ''));

// toLocaleString() sets up a new formatter on every call, and a screen formats thousands of numbers and dates:
// with a year of records that was the larger part of drawing Insights (usability cycle 4, S2). One formatter
// per number of digits, and one for dates, made once and kept, give the same text.
const numberFormats = new Map();
const numberFormat = (digits) => {
  let f = numberFormats.get(digits);
  if (!f) numberFormats.set(digits, f = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  return f;
};
export function fmt(x, digits = 2) {
  if (x == null || Number.isNaN(x) || !Number.isFinite(x)) return '–';
  return numberFormat(digits).format(Number(x));
}
export function sig(x) {
  if (x == null || !Number.isFinite(x)) return '–';
  const a = Math.abs(x);
  return fmt(x, a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3);
}
export { todayISO, addDays, shiftWeekend as shiftWeekendToMonday, toISODate } from '../calc/dates.js';
import { parseISO } from '../calc/dates.js';
let dateFormat = null;
export function fmtDate(iso) {
  if (!iso) return '–';
  const d = iso.length === 10 ? parseISO(iso) : new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  dateFormat ||= new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  return dateFormat.format(d);
}
export const uid = () => Math.random().toString(36).slice(2, 10);

/** Form field. opts: {id, label, type='number'|'text'|'select'|'date'|'checkbox'|'textarea', value, options:[{value,label}]|string[], step, min, max, hint, advanced, placeholder, width} */
export function field(o) {
  const cls = o.advanced ? 'advanced' : '';
  const hint = o.hint ? html`<div class="muted">${o.hint}</div>` : '';
  let input;
  const common = `id="${esc(o.id)}" name="${esc(o.id)}" ${o.required ? 'required' : ''} ${o.disabled ? 'disabled' : ''}`;
  if (o.type === 'select') {
    const opts = (o.options || []).map((op) => (typeof op === 'string' ? { value: op, label: op } : op));
    input = `<select ${common}>${opts.map((op) => `<option value="${esc(op.value)}" ${String(op.value) === String(o.value) ? 'selected' : ''}>${esc(op.label)}</option>`).join('')}</select>`;
  } else if (o.type === 'textarea') {
    input = `<textarea ${common} rows="${o.rows || 3}">${esc(o.value ?? '')}</textarea>`;
  } else if (o.type === 'checkbox') {
    return `<label class="${cls}" style="display:flex;align-items:center;gap:8px;font-weight:400;color:var(--ink)"><input type="checkbox" ${common} ${o.value ? 'checked' : ''} style="width:auto"> ${esc(o.label)}</label>`;
  } else {
    const t = o.type || 'number';
    input = `<input type="${t}" ${common} value="${esc(o.value ?? '')}" ${o.step != null ? `step="${o.step}"` : t === 'number' ? 'step="any"' : ''} ${o.min != null ? `min="${o.min}"` : ''} ${o.max != null ? `max="${o.max}"` : ''} ${o.placeholder ? `placeholder="${esc(o.placeholder)}"` : ''}>`;
  }
  return `<div class="${cls}" ${o.width ? `style="width:${o.width}"` : ''}><label for="${esc(o.id)}">${esc(o.label)}</label>${input}${hint}</div>`;
}

/** Read all form controls inside root into an object keyed by name; numbers parsed for type=number. */
export function readForm(root) {
  const out = {};
  root.querySelectorAll('input, select, textarea').forEach((el) => {
    if (!el.name) return;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value;
  });
  return out;
}

export function table(headers, rows, opts = {}) {
  // A header may carry a `sub`, which goes on its own line underneath in smaller type. That is where a unit
  // belongs: "Total flow rate" over "mL/min" keeps the column as narrow as its numbers.
  const th = headers.map((h) => {
    const o = typeof h === 'object' ? h : { label: h };
    return `<th ${o.right ? 'style="text-align:right"' : ''}>${esc(o.label)}${o.sub ? `<div class="muted" style="font-weight:400;font-size:11px;margin-top:1px">${esc(o.sub)}</div>` : ''}</th>`;
  }).join('');
  const body = rows.length
    ? rows.map((r) => `<tr ${r.attrs || ''}>${r.cells.map((c, i) => `<td ${typeof headers[i] === 'object' && headers[i].right ? 'style="text-align:right"' : ''}>${c instanceof Raw ? c.s : esc(c)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="muted">${esc(opts.empty || 'Nothing yet')}</td></tr>`;
  return `<div style="overflow-x:auto"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export const chip = (text, kind = '') => `<span class="chip ${kind}">${esc(text)}</span>`;
export const kpi = (label, value, sub = '') => `<div class="kpi"><div class="l">${label instanceof Raw ? label.s : esc(label)}</div><div class="v">${value instanceof Raw ? value.s : esc(value)}</div>${sub ? `<div class="muted">${esc(sub)}</div>` : ''}</div>`;

const TOAST_MAX = 3, TOAST_MS = 3500, TOAST_ACTION_MS = 10000;
const toastTimers = new WeakMap();
/**
 * A short note in the corner. At most three show at once, the oldest giving way, and a message that is already
 * showing counts up on its note ("Result saved ×4") instead of stacking a copy: entering a table of results
 * used to raise a column of identical notes over the right-hand side of the table being typed into.
 *
 * opts.action / opts.onAction put a button on the note ("Undo"). Such a note is never merged into another,
 * since each one undoes its own thing, and never gives way to a newer plain note; it stays for 10 s rather than
 * 3.5 (it takes longer to decide to undo than to read "Saved") and waits while the pointer is on it. It goes
 * to the screen its action leads to ("Deleted Experiment 10" to the list) and no further, as dropOldToasts
 * says. The button runs onAction once and closes the note.
 */
export function toast(msg, kind = '', opts = {}) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:99;display:flex;flex-direction:column;gap:6px'; document.body.appendChild(t); }
  msg = String(msg);
  const action = opts.action && typeof opts.onAction === 'function' ? String(opts.action) : '';
  const ms = action ? TOAST_ACTION_MS : TOAST_MS;
  let n = action ? null : [...t.children].find((x) => x.dataset.msg === msg && x.dataset.kind === kind && !x.dataset.action);
  if (n) {
    n.dataset.count = String(Number(n.dataset.count) + 1);
    n.textContent = `${msg} ×${n.dataset.count}`;
    clearTimeout(toastTimers.get(n));
  } else {
    n = document.createElement('div');
    n.className = 'note ' + kind; n.style.cssText = 'background:var(--card);box-shadow:var(--shadow);min-width:220px';
    Object.assign(n.dataset, { msg, kind, count: '1' });
    if (action) {
      n.dataset.action = action;
      n.style.cssText += ';display:flex;align-items:center;gap:12px';
      const text = document.createElement('span'); text.style.flex = '1'; text.textContent = msg;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'toast-action'; b.dataset.toastAction = action; b.textContent = action;
      b.addEventListener('click', () => { clearTimeout(toastTimers.get(n)); n.remove(); opts.onAction(); }, { once: true });
      n.addEventListener('mouseenter', () => clearTimeout(toastTimers.get(n)));
      n.addEventListener('mouseleave', () => toastTimers.set(n, setTimeout(() => n.remove(), ms)));
      n.append(text, b);
    } else n.textContent = msg;
  }
  t.appendChild(n); // newest at the bottom, a repeat included
  // The oldest plain note gives way first: an Undo pushed out by three "Result saved" would be gone before its time.
  while (t.children.length > TOAST_MAX) ([...t.children].find((x) => !x.dataset.action && x !== n) || t.firstElementChild).remove();
  n.dataset.at = String(performance.now()); delete n.dataset.carried;
  toastTimers.set(n, setTimeout(() => n.remove(), ms));
}

/**
 * On navigation: notes about the screen being left go with it. One raised just before (the "Created
 * Experiment 3" that brought you to Experiment 3, the "Deleted Experiment 10 · Undo" that brought you to the
 * list) is about the screen being opened, and stays. An Undo note used to follow the user to every screen for
 * its 10 s and sit over the charts there (usability cycle 6, I3). Once they have moved on from where the delete
 * left them it goes too; Settings › Recently deleted still puts the record back.
 */
export function dropOldToasts(maxAgeMs = 1500) {
  const t = document.getElementById('toast');
  if (!t) return;
  const now = performance.now();
  for (const n of [...t.children]) {
    // A note goes with one screen change at most, however quickly the next one follows.
    if (n.dataset.carried || now - Number(n.dataset.at || 0) > maxAgeMs) n.remove();
    else n.dataset.carried = '1';
  }
}

/**
 * The yes/no question before something that cannot be taken back, to be awaited. In the macOS app
 * tauri-plugin-dialog replaces window.confirm with an async one (Tauri has no synchronous call into the app), so
 * there confirm() returns a promise, and a promise read as the answer is always yes: every `if (!confirm(…))
 * return` let its action run before the question had even appeared. In a browser confirm() answers at once and
 * awaiting it changes nothing. Only an explicit yes counts; a window that cannot show the question answers no.
 */
export async function ask(message) {
  try { return (await globalThis.confirm(message)) === true; } catch { return false; }
}

/*
 * Redrawing a form while the user is in it.
 *
 * Several forms rebuild themselves from their state when a value changes, and a typed value changes on
 * `change`, which fires on blur: the moment the user is already clicking or tabbing into the next field.
 * Rebuilding right there destroyed the field they were moving to, and the blur that the rebuild itself causes
 * re-entered it halfway ("The node to be removed is no longer a child of this node"). It also swapped the
 * button under the pointer between press and release, and the browser then drops the click: "Save" pressed
 * straight after typing a value did nothing. redrawSoon() waits until the user has got where they were going;
 * swapHtml() then rebuilds without taking the field from under them.
 */

// When a mouse button or finger went down, or 0 while none is.
let pressedAt = 0;
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pointerdown', () => { pressedAt = performance.now(); }, true);
  window.addEventListener('pointerup', () => { pressedAt = 0; }, true);
  window.addEventListener('pointercancel', () => { pressedAt = 0; }, true);
  window.addEventListener('blur', (e) => { if (e.target === window) pressedAt = 0; }); // released outside the window
}
const redrawQueued = new WeakSet(), swapping = new WeakSet();

/**
 * Run draw once the user has arrived: after the event that asked for it, after a pressed pointer is released
 * and its click has landed, and once however many changes asked for it meanwhile. `owner` is the element whose
 * presence means the form is still on screen; if the user has navigated away by then, nothing is drawn.
 */
export function redrawSoon(owner, draw) {
  if (redrawQueued.has(owner)) return;
  redrawQueued.add(owner);
  const run = () => {
    // A press held for seconds is not a click on the way somewhere; stop waiting for a release that may not come.
    if (pressedAt && performance.now() - pressedAt < 2000) { setTimeout(run, 25); return; }
    redrawQueued.delete(owner);
    if (owner.isConnected) draw();
  };
  setTimeout(run, 0);
}

/**
 * Replace box's content and leave the user in the field they were in. `content` is the new markup, or a
 * function that rebuilds box itself (a screen whose draw() writes its markup and wires its listeners).
 * Returns false, and does nothing, when called again while the same box is being rebuilt.
 *
 * The field with focus is found again by name (or id) in the new markup. When it still holds the same value,
 * the very element the user is in is put back in its place, refreshed with the new attributes: the caret, a
 * selection and anything half-typed survive exactly. A fresh number input cannot be given a caret at all, and
 * focused from script puts it at the start, so "20" clicked at its end and typed "5" would have read "520".
 * An element put back keeps the listeners it had and gets none of the new markup's, so listen on the form
 * (delegated), as every screen here does, not on the field itself.
 */
export function swapHtml(box, content) {
  if (swapping.has(box)) return false;
  const was = document.activeElement;
  const keep = was && was !== box && box.contains(was) && fieldKey(was) ? was : null;
  const sel = keep ? caretOf(keep) : null;
  swapping.add(box);
  try { if (typeof content === 'function') content(); else box.innerHTML = content; }
  finally { swapping.delete(box); }
  if (keep && !keep.isConnected) {
    const twin = [...box.querySelectorAll('[name], [id]')].find((x) => fieldKey(x) === fieldKey(keep));
    let target = twin;
    if (twin && sameField(keep, twin)) {
      for (const a of [...keep.attributes]) if (!twin.hasAttribute(a.name) && !UNTOUCHED.has(a.name)) keep.removeAttribute(a.name);
      for (const a of [...twin.attributes]) if (!UNTOUCHED.has(a.name)) keep.setAttribute(a.name, a.value);
      twin.replaceWith(keep);
      target = keep;
    }
    if (target) {
      target.focus({ preventScroll: true });
      if (sel) try { const n = target.value.length; target.setSelectionRange(Math.min(sel[0], n), Math.min(sel[1], n), sel[2]); } catch {}
    }
  }
  return true;
}
// Attributes not copied onto a field put back: its type is the same by then, and writing value can move the caret.
const UNTOUCHED = new Set(['type', 'value']);
const fieldKey = (x) => {
  const name = x.getAttribute('name');
  if (name) return 'name:' + name + (x.type === 'radio' ? '=' + x.value : '');
  return x.id ? 'id:' + x.id : '';
};
// Only a text field can be put back: a select's options or a checkbox's state come from the new markup.
const sameField = (a, b) => a.tagName === b.tagName && a.value === b.value &&
  (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type === b.type && !/^(checkbox|radio|file|button|submit|reset|image)$/.test(a.type)));
const caretOf = (x) => { try { return x.selectionStart == null ? null : [x.selectionStart, x.selectionEnd, x.selectionDirection]; } catch { return null; } };

/*
 * Keeping what is typed (usability cycle 5, K6).
 *
 * A record that exists is stored as it is edited, as the rest of the app always was: a bench record is filled
 * in over a day, between other screens, and one that kept its values only until "Save" lost them to a click on
 * the sidebar. A record that does not exist yet is not stored as it is typed, which would leave half-made
 * records behind; it is kept as a draft instead (below) and offered back when the person returns.
 */

// Saves waiting for typing to pause, run at once when the screen is left or the page goes. Registered here, as
// this module loads, so they run before the router draws the next screen and before main.js writes on pagehide.
const pendingSaves = new Set();
const runPendingSaves = () => { for (const run of [...pendingSaves]) run(); };
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('hashchange', runPendingSaves);
  window.addEventListener('pagehide', runPendingSaves);
}
/** Run the saves still waiting for typing to pause: before this window hands the writing over to another (app/store.js). */
export const savePending = () => runPendingSaves();
let saverCount = 0;

/**
 * Store an existing record as it is edited, and say quietly that it is. `put()` writes the record (through
 * the store) and returns false, or a reason, when it cannot be written as it stands. `now()` saves at once (a
 * field left, a box ticked), `soon()` once typing pauses; `html()` is the status for the screen's header,
 * drawn with the rest of the screen, and kept up to date in place.
 */
export function autoSaver(store, put, { delay = 700 } = {}) {
  const key = `s${++saverCount}`;
  let timer = null;
  // In a window that only shows the records, because another window writes them (app/store.js), nothing typed
  // is stored, and the status must never say it is.
  let state = store.readOnly ? { text: 'Changes are not saved in this window', kind: '' } : { text: 'Changes are saved as you go', kind: '' };
  // Styled inline: one small status, not worth a rule in the page's style sheet.
  const style = () => `font-size:12px${state.kind === 'warn' ? ';color:var(--warn-text)' : ''}`;
  const paint = () => {
    const n = document.querySelector(`[data-saver="${key}"]`);
    if (n) { n.textContent = state.text; n.className = `saveState ${state.kind || 'muted'}`; n.style.cssText = style(); }
  };
  const set = (text, kind = '') => { state = { text, kind }; paint(); };
  const now = () => {
    clearTimeout(timer); timer = null; pendingSaves.delete(now);
    let r;
    try { r = put(); } catch (err) { console.error(err); set('Not saved: ' + err.message, 'warn'); return; }
    if (r === false || typeof r === 'string') { set(`Not saved${typeof r === 'string' ? ': ' + r : ''}`, 'warn'); return; }
    // The store refused the put, and the note at the head of the screen says why.
    if (store.readOnly) { set('Not saved: this window only shows your records', 'warn'); return; }
    set('Saving …');
    // The note at the head of the screen says why, when the browser refuses the write.
    store.flush().then((done) => set(done.ok ? 'Saved' : 'Not saved', done.ok ? '' : 'warn'));
  };
  const soon = () => {
    clearTimeout(timer);
    pendingSaves.add(now);
    timer = setTimeout(now, delay);
  };
  const html = () => `<span class="saveState ${state.kind || 'muted'}" data-saver="${key}" id="saveState" role="status" aria-live="polite" style="${style()}">${esc(state.text)}</span>`;
  // `note` says something else in the same place, such as that another window changed the record.
  return { now, soon, html, note: set };
}

/*
 * One record open in two windows. Each window holds its own copy of the record, and a save used to write that
 * copy whole: the window opened first put back what the other had stored since, and both said "Saved". A
 * screen now stores only what was changed on it, laid over the record as it is stored at that moment, and it
 * hears when another window stores the record (Store.watchOtherWindows), so it can show what is stored.
 */

/**
 * The record `mine` (a screen's copy, or the state it is built from) as stored in `col`. take() lays what this
 * screen changed since it last read or stored the record over the record as stored now, and puts the result
 * into `mine`, in place; it returns false, and changes nothing, when the record is no longer stored (moved to
 * the trash, here or in another window), which a save must not undo. stored() is called once `mine` has been
 * written. watch(shown, fn) calls fn with the stored record, or null once it is gone, each time another window
 * changes it, for as long as shown() says the screen is still there.
 */
export function sharedRecord(store, col, mine) {
  const id = mine.id;
  let base = store.get(col, id); // the record as this screen last read or stored it
  let seen = JSON.stringify(base);
  const take = () => {
    const now = store.get(col, id);
    if (!now) return false;
    adopt(mine, layOver(store.get(col, id), base || {}, mine));
    base = now; seen = JSON.stringify(now);
    return true;
  };
  const stored = () => { base = copyOf(mine); seen = JSON.stringify(store.get(col, id)); };
  const watch = (shown, fn) => {
    const stop = store.watchOtherWindows?.((cols) => {
      if (!shown()) { stop(); return; }
      if (!cols.includes(col)) return;
      const now = store.get(col, id);
      if (JSON.stringify(now) !== seen) fn(now);
    });
  };
  return { take, stored, watch };
}
const copyOf = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** Lay over `onto` each field that differs between `base` and `mine`: objects field by field, anything else whole. */
function layOver(onto, base, mine) {
  for (const k of new Set([...Object.keys(base), ...Object.keys(mine)])) {
    const b = base[k], m = mine[k];
    if (JSON.stringify(b) === JSON.stringify(m)) continue;
    if (isPlain(b) && isPlain(m) && isPlain(onto[k])) layOver(onto[k], b, m);
    else if (m === undefined) delete onto[k];
    else onto[k] = copyOf(m);
  }
  return onto;
}
/** Make `target` hold what `src` holds, in place. Objects in both stay the same objects, so a screen holding one sees the new values. */
function adopt(target, src) {
  for (const k of Object.keys(target)) if (!(k in src)) delete target[k];
  for (const [k, v] of Object.entries(src)) {
    if (isPlain(v) && isPlain(target[k])) adopt(target[k], v);
    else target[k] = copyOf(v);
  }
  return target;
}

/**
 * The draft of a record not yet created: what was typed into a "New …" form, kept in this window's
 * sessionStorage (an experiment's in localStorage, below) under the store's namespace (so the demo lab has its own, and Store.clear() takes it with the
 * rest of the lab). Not a collection: a draft is not data, does not belong in a backup, and must still be kept
 * when the database is full, which is when a create fails. It survives a reload and goes with the window.
 * Reads and writes never throw.
 *
 * Each form writes its draft under its own `draftId` (a continued draft keeps the one it had), so that creating
 * the record drops that draft and no other: a form left untouched must not take with it the draft offered above
 * it, nor one typed into another form while its record was being stored.
 */
const draftKey = (ctx, kind) => `${ctx.store.ns}.draft.${kind}`;
/*
 * An experiment not created yet is kept in localStorage, not this window's sessionStorage: it is listed as
 * pending under Experiments and in the sidebar, and the user asked that it survive closing the tab ("if I start
 * an experiment and leave the page it should plop into the experiment section"). The other forms (a stock, a
 * buffer lot) keep theirs for the window, as before. localStorage is per browser, so a second window on the same
 * lab sees the same pending experiments, which is what a list of them should do.
 */
const persistent = (kind) => String(kind).startsWith('experiment.');
const draftStore = (kind) => (persistent(kind) ? localStorage : sessionStorage);
/** Tell the sidebar and any list of drafts that one came or went (not on every keystroke into one). */
const draftsChanged = () => { try { window.dispatchEvent(new CustomEvent('lnp:drafts')); } catch {} };
export function readDraft(ctx, kind) {
  try {
    let raw = draftStore(kind).getItem(draftKey(ctx, kind));
    // an experiment draft kept by an earlier version, in this window only: moved to where it now lives
    if (raw == null && persistent(kind)) {
      raw = sessionStorage.getItem(draftKey(ctx, kind));
      if (raw != null) { localStorage.setItem(draftKey(ctx, kind), raw); sessionStorage.removeItem(draftKey(ctx, kind)); }
    }
    const d = JSON.parse(raw || 'null');
    if (!d || typeof d !== 'object') return null;
    d.draftId ??= d.draftAt; // written before drafts had an id
    return d;
  } catch { return null; }
}
/** Keep a draft. `keepTime` keeps the `draftAt` the value carries (an undone discard puts a draft back as it was). */
export function writeDraft(ctx, kind, value, { keepTime = false } = {}) {
  try {
    const key = draftKey(ctx, kind), st = draftStore(kind);
    const isNew = st.getItem(key) == null;
    st.setItem(key, JSON.stringify({ ...value, draftAt: keepTime && value?.draftAt ? value.draftAt : new Date().toISOString() }));
    if (isNew) draftsChanged();
  } catch { /* a draft is a convenience */ }
}
/** Drop the draft of `kind`; given `draftId`, only while the draft there is that one. */
export function dropDraft(ctx, kind, draftId) {
  try {
    if (draftId !== undefined && readDraft(ctx, kind)?.draftId !== draftId) return;
    const key = draftKey(ctx, kind);
    if (draftStore(kind).getItem(key) == null) return;
    draftStore(kind).removeItem(key);
    draftsChanged();
  } catch {}
}
/**
 * Every draft whose kind starts with `prefix` ('experiment.'), newest first: [{kind, ...draft}]. Reads the
 * keys, so it costs a pass over this origin's localStorage, which holds a few dozen keys.
 */
export function listDrafts(ctx, prefix) {
  const head = `${ctx.store.ns}.draft.${prefix}`;
  const kinds = new Set();
  for (const st of [localStorage, sessionStorage]) {
    try { for (let i = 0; i < st.length; i++) { const k = st.key(i); if (k?.startsWith(head)) kinds.add(k.slice(`${ctx.store.ns}.draft.`.length)); } } catch {}
  }
  return [...kinds].map((kind) => { const d = readDraft(ctx, kind); return d?.state ? { ...d, kind } : null; })
    .filter((d) => d && !draftsStoring.has(d.draftId))
    .sort((a, b) => String(b.draftAt || '').localeCompare(String(a.draftAt || '')));
}
/**
 * The drafts whose "Create experiment" is being stored. Until the write is stored or undone such a draft is
 * not listed as one not created: continued and created again, it was a second experiment (usability cycle 6,
 * W6). Kept here, not in the wizard, because the sidebar lists drafts too.
 */
export const draftsStoring = new Set();

/*
 * Leaving a form with typed, unsaved input (spec 9.1). The drafts above keep the experiment wizard and the buffer
 * designer; the forms that save with a button of their own (the results grid, the manual result and the
 * correction of a stored one, the Materials editors, a study's value grid) lost what was typed when a link, the
 * sidebar, Back or a crumb took the screen away. Each such form registers a check here; the router (app/main.js)
 * asks every check before it draws the next screen, and when one says "unsaved", asks the user first, and puts
 * the address back if they stay. In a browser the same checks answer `beforeunload`.
 *
 * A check belongs to an element of the form: once that element has left the page (the screen was drawn again,
 * after a save or a Cancel), the check is dropped, so a form never has to say it is gone.
 */
const dirtyChecks = new Set();
/**
 * Register `check()` (true while the form holds typed input not saved) for the form `owner`; `what` names it in
 * the question ("results typed into the grid"). Returns a function that unregisters it.
 */
export function registerDirty(owner, what, check) {
  for (const e of dirtyChecks) if (e.owner && !e.owner.isConnected) dirtyChecks.delete(e);
  const e = { owner, what, check };
  dirtyChecks.add(e);
  return () => dirtyChecks.delete(e);
}
/** What on screen holds unsaved input now: the `what` of every check that says so, each once. */
export function unsavedWork() {
  const out = [];
  for (const e of [...dirtyChecks]) {
    if (e.owner && !e.owner.isConnected) { dirtyChecks.delete(e); continue; }
    let dirty = false;
    try { dirty = !!e.check(); } catch { /* a check that throws says nothing */ }
    if (dirty && !out.includes(e.what)) out.push(e.what);
  }
  return out;
}
/** The question asked before leaving them. */
export const leaveQuestion = (whats) => `Not saved yet: ${whats.join('; ')}. Leave this screen anyway?`;

/**
 * Whether any field under `root` differs from what was drawn: a text box from its value attribute, a box from its
 * checked attribute, a select from the option the markup selected. That is "typed and not saved" for a form drawn
 * from its record and drawn again after each save, with no state of its own to compare. `selector` narrows it.
 */
export function fieldsChanged(root, selector = 'input, select, textarea') {
  if (!root) return false;
  for (const f of root.querySelectorAll(selector)) {
    if (f.disabled || f.readOnly || /^(hidden|file|button|submit)$/.test(f.type || '')) continue;
    if (f.type === 'checkbox' || f.type === 'radio') { if (f.checked !== f.defaultChecked) return true; continue; }
    if (f.options && !f.multiple) {
      const opts = [...f.options];
      const was = Math.max(0, opts.findIndex((o) => o.defaultSelected));
      if (opts.length && f.selectedIndex !== was) return true;
      continue;
    }
    if (f.value !== f.defaultValue) return true;
  }
  return false;
}

export function on(root, selector, event, handler) {
  root.querySelectorAll(selector).forEach((el) => el.addEventListener(event, handler));
}

export function download(filename, text, mime = 'application/json') {
  return saveBlob(filename, new Blob([text], { type: mime }));
}

/**
 * Hands a file to the user: a download in a browser. The macOS app's window (WKWebView) does nothing with a download
 * link on a blob, so there the file goes through the app's save dialog and file plugin instead (tauri-plugin-dialog
 * and -fs, which withGlobalTauri in src-tauri/tauri.conf.json puts on window.__TAURI__; a browser has no such
 * object). Returns the file name in a browser, which saves without asking; in the app, a promise of the path saved
 * to, or of null if the dialog was cancelled or the file could not be written.
 */
export function saveBlob(filename, blob) {
  if (inApp()) return saveInApp(filename, blob);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  return filename;
}
const inApp = () => !!(globalThis.__TAURI__?.dialog?.save && globalThis.__TAURI__?.fs?.writeFile);
// The dialog adds the path it returns to what the file plugin may write (with fs:allow-write-file granted in
// src-tauri/capabilities/default.json), and the bytes are the blob's, so the file is the one a browser would save.
async function saveInApp(filename, blob) {
  const { dialog, fs } = globalThis.__TAURI__;
  try {
    const ext = /\.(\w+)$/.exec(filename)?.[1];
    const path = await dialog.save({ defaultPath: filename, ...(ext ? { filters: [{ name: ext.toUpperCase(), extensions: [ext] }] } : {}) });
    if (!path) return null;
    await fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    return path;
  } catch (err) {
    toast(`Not saved: ${filename} could not be written (${err?.message || err})`, 'warn');
    return null;
  }
}

/** Opens a print window with the given HTML body (worksheets, reports). */
export function printHtml(title, body) {
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
  <style>body{font-family:system-ui,sans-serif;font-size:12px;color:#111;margin:18mm 16mm}h1{font-size:18px;margin:0 0 4px}h2{font-size:13px;margin:16px 0 6px;border-bottom:1px solid #999;padding-bottom:2px}
  table{border-collapse:collapse;width:100%;margin:4px 0 8px}th,td{border:1px solid #bbb;padding:4px 6px;text-align:left;font-size:11.5px}th{background:#eee}.r{text-align:right}.blank{min-width:70px;display:inline-block;border-bottom:1px solid #333;height:12px}
  .sig{margin-top:18px;display:flex;gap:40px}.sig div{flex:1;border-top:1px solid #333;padding-top:4px;font-size:11px}.muted{color:#555}</style></head><body>${body}</body></html>`;
  // The macOS app's window opens no second window to print from, so there the sheet is saved as a page of its own,
  // to open in Safari and print (or save as PDF) from there.
  if (inApp()) {
    saveInApp(`${title.replace(/[\\/:*?"<>|]+/g, '-')}.html`, new Blob([page], { type: 'text/html' }))
      .then((path) => path && toast(`Saved ${path.split('/').pop()}: open it in Safari and print it from there (⌘P).`, 'ok'));
    return;
  }
  const w = window.open('', '_blank');
  if (!w) { toast('Pop-up blocked: allow pop-ups to print', 'warn'); return; }
  w.document.write(page);
  w.document.close(); w.focus();
  setTimeout(() => w.print(), 300);
}

// crypto.subtle is there only in a secure context, which the macOS app's tauri:// page may not be; the same
// digest then comes from plain JavaScript, so an import never fails for want of its fingerprint.
export const sha256Hex = async (text) => {
  const bytes = new TextEncoder().encode(text);
  const buf = (await globalThis.crypto?.subtle?.digest('SHA-256', bytes).catch(() => null)) || (await import('../calc/sha256.js')).sha256(bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Page header: breadcrumb, title and optional actions (html string). Either the crumb or the title may be
 * raw() when it needs markup — a crumb whose parts link back up the tree, a title with a "?" explainer.
 */
export const header = (crumb, title, actions = '') => `<div class="crumb">${crumb instanceof Raw ? crumb.s : esc(crumb)}</div>
  <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:14px"><h1 style="flex:1 1 auto;margin:0">${title instanceof Raw ? title.s : esc(title)}</h1>${actions}</div>`;
