// Screen: Learn — the browsable index of the reference, and the "?" explainer used from every other screen.
//
// Two jobs in one module because they share the rendering: `info(id)` drops a clickable mark next to a term,
// and `render` lists everything. A term you meet while setting something up explains itself there, without
// losing your place; the index is for reading rather than looking up.
import { raw, header, field, esc, toast } from './kit.js';
import { TOPICS, GROUPS, topicsIn, searchTopics } from '../learn/topics.js';

/**
 * A clickable "?" that opens the explainer for a topic. Put it after the thing it explains.
 * @param {string} id   a key of TOPICS
 * @param {string} [label] optional visible text before the mark
 */
export function info(id, label = '') {
  const t = TOPICS[id];
  if (!t) return label ? esc(label) : '';
  return `${label ? esc(label) + ' ' : ''}<button type="button" class="learn" data-learn="${esc(id)}" aria-label="What is ${esc(t.title)}?" title="${esc(t.title)}">?</button>`;
}

/** The same, as a word that reads as a link: for prose rather than labels. */
export function infoLink(id, text) {
  const t = TOPICS[id];
  if (!t) return esc(text || id);
  return `<button type="button" class="learn-inline" data-learn="${esc(id)}">${esc(text || t.title)}</button>`;
}

/* ---------------- the panel ---------------- */
function panelHtml(id, canGoBack = false) {
  const t = TOPICS[id];
  if (!t) return '';
  const rows = (t.numbers || []).map(([k, v]) => `<tr><td>${esc(k)}</td><td style="text-align:right;font-variant-numeric:tabular-nums">${esc(v)}</td></tr>`).join('');
  const see = (t.see || []).filter((s) => TOPICS[s]);
  return `<div class="learn-card" role="dialog" aria-modal="true" aria-label="${esc(t.title)}">
    <div class="learn-head">${canGoBack ? '<button type="button" id="learnBack" aria-label="Back to the previous entry" title="Back">‹</button>' : ''}
      <div style="flex:1"><div class="learn-group">${esc(t.group)}</div><h2 style="margin:2px 0 0">${esc(t.title)}</h2></div>
      <button type="button" id="learnClose" aria-label="Close">✕</button></div>
    <div class="learn-body">
      <p>${esc(t.what)}</p>
      <h3>Why it matters here</h3><p>${esc(t.why)}</p>
      ${rows ? `<h3>Numbers worth knowing</h3><table class="learn-numbers">${rows}</table>` : ''}
      <h3>At the bench</h3><p>${esc(t.doing)}</p>
      ${t.trap ? `<div class="note warn" style="margin-top:10px"><b>Common trap.</b> ${esc(t.trap)}</div>` : ''}
      ${t.more ? `<p class="muted" style="margin-top:10px">${esc(t.more)}</p>` : ''}
      ${see.length ? `<h3>Related</h3><div style="display:flex;gap:6px;flex-wrap:wrap">${see.map((s) => `<button type="button" class="btn learn-rel" data-learn="${esc(s)}">${esc(TOPICS[s].title)}</button>`).join('')}</div>` : ''}
      <p class="muted" style="margin-top:14px"><a href="#/learn">Everything in the reference</a></p>
    </div></div>`;
}

// Where the reader has been, so following a related link is reversible. One entry leads to another and the
// way back should not be "close it and find the first one again".
let trail = [];
/** Open the explainer for a topic. `push` false replaces the top of the trail rather than adding to it. */
export function openLearn(id, push = true) {
  if (!TOPICS[id]) return;
  let host = document.getElementById('learnHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'learnHost';
    document.body.appendChild(host);
  }
  if (push) trail.push(id); else trail[Math.max(0, trail.length - 1)] = id;
  host.innerHTML = `<div class="learn-backdrop" id="learnBackdrop"></div>${panelHtml(id, trail.length > 1)}`;
  host.querySelector('#learnClose').addEventListener('click', closeLearn);
  host.querySelector('#learnBackdrop').addEventListener('click', closeLearn);
  host.querySelector('#learnBack')?.addEventListener('click', backLearn);
  host.querySelectorAll('.learn-rel').forEach((b) => b.addEventListener('click', () => openLearn(b.dataset.learn)));
  host.querySelector('.learn-card')?.focus?.();
  document.addEventListener('keydown', onKey);
}
/** Back to the entry this one was reached from; closes when there is nothing behind it. */
export function backLearn() {
  trail.pop();
  const prev = trail[trail.length - 1];
  if (!prev) return closeLearn();
  openLearn(prev, false);
}
export function closeLearn() {
  trail = [];
  const host = document.getElementById('learnHost');
  if (host) host.innerHTML = '';
  document.removeEventListener('keydown', onKey);
}
/** Escape closes; Backspace and the left arrow step back through the trail. */
function onKey(e) {
  if (e.key === 'Escape') closeLearn();
  else if ((e.key === 'Backspace' || e.key === 'ArrowLeft') && trail.length > 1 && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
    e.preventDefault(); backLearn();
  }
}
/** The trail, for tests. */
export const learnTrail = () => [...trail];

/**
 * Delegate the "?" clicks for a screen. Attach to an element the redraw replaces, not to a container that
 * survives it, or the handlers accumulate.
 */
export function wireLearn(root) {
  if (!root || root.dataset.learnWired === '1') return;
  root.dataset.learnWired = '1';
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-learn]');
    if (!b || b.classList.contains('learn-rel')) return;
    e.preventDefault();
    closeLearn();
    openLearn(b.dataset.learn);
  });
}

/* ---------------- the index screen ---------------- */
export async function render(el, ctx) {
  const q = ctx.params.q || '';
  const open = ctx.params.topic && TOPICS[ctx.params.topic] ? ctx.params.topic : '';
  const found = searchTopics(q);
  const byGroup = GROUPS.map((g) => ({ g, items: found.filter((t) => t.group === g) })).filter((x) => x.items.length);

  el.innerHTML = header('Reference', 'Reference',
    `<a class="btn" href="#/advisor">Plan an experiment</a>`) +
    `<div id="learnRoot">
      <div class="card"><p class="muted">Everything the app will explain to you, in one place. The same entries open from the <button type="button" class="learn" disabled>?</button> marks beside terms on every other screen, so you rarely need to come here on purpose.</p>
        <div class="grid g3">${field({ id: 'q', label: 'Search', type: 'text', value: q, placeholder: 'pdi, flow rate, overfitting …' })}</div></div>
      ${byGroup.length ? byGroup.map(({ g, items }) => `<div class="card"><h2>${esc(g)}</h2>
        <div class="grid g2">${items.map((t) => `<button type="button" class="learn-tile" data-learn="${esc(t.id)}">
          <div class="learn-tile-title">${esc(t.title)}</div>
          <div class="muted">${esc(t.what.length > 150 ? t.what.slice(0, 147) + '…' : t.what)}</div></button>`).join('')}</div></div>`).join('')
        : `<div class="card"><p class="muted">Nothing matches “${esc(q)}”.</p></div>`}
    </div>`;

  wireLearn(el.querySelector('#learnRoot'));
  el.querySelector('[name=q]')?.addEventListener('input', (e) => {
    clearTimeout(render._t);
    render._t = setTimeout(() => ctx.navigate('learn', { q: e.target.value }), 220);
  });
  if (open) openLearn(open);
}
