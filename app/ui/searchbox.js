// The search box at the top of the sidebar (usability cycle 2, F6): finding E1-F1's size used to mean
// knowing it was made in experiment 1. Type an id, a sample name, a lot or a name; the hits come up as you
// type, grouped by kind, and ↑/↓/Enter/Esc work as in any launcher. Ctrl+K (⌘K on a Mac) reaches it from
// anywhere. The matching itself is app/calc/search.js; this file is the box and the list under it.
//
// Not a screen: main.js mounts it. The sidebar is rebuilt on every navigation, so the box is made once and
// moved into each new sidebar, keeping what was typed and its listeners. The list is attached to the body
// rather than the sidebar, which scrolls and would clip it, and floats over the page beside it.
import { buildIndex, search, hitHref } from '../calc/search.js';
import { getRef } from '../refdata.js';
import { TYPES } from '../calc/experiment.js';
import { esc, fmtDate } from './kit.js';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.4 10.4L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

let box = null;

/** Put the search box at the top of a freshly built sidebar (after the brand row). */
export function mountSearch(nav, ctx) {
  if (!box) box = createBox(ctx);
  const brand = nav.querySelector('.brand');
  if (brand) brand.after(box); else nav.prepend(box);
}

function createBox(ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'nav-search';
  wrap.setAttribute('role', 'search');
  wrap.innerHTML = `${ICON}<input type="search" id="search" placeholder="Search" autocomplete="off" spellcheck="false"
    aria-label="Search experiments, formulations, samples, stocks, buffers, RNA lots and compositions" role="combobox"
    aria-expanded="false" aria-controls="searchResults" aria-autocomplete="list"><kbd>${MAC ? '⌘K' : 'Ctrl K'}</kbd>`;
  const input = wrap.querySelector('input');
  const pop = document.createElement('div');
  pop.id = 'searchResults'; pop.className = 'search-pop'; pop.setAttribute('role', 'listbox'); pop.hidden = true;
  document.body.appendChild(pop);

  let index = null, hits = [], active = -1;

  // Built when the box is entered, from the records as they are then; nothing changes them while typing.
  const ensureIndex = () => {
    if (index) return index;
    const st = ctx.store, ref = ctx.data ? getRef(ctx) : null;
    index = buildIndex({
      experiments: st.all('experiments'), batches: st.all('batches'), measurements: st.all('measurements'), stocks: st.all('stocks'),
      buffers: st.all('buffers'), rnaLots: st.all('rnaLots'), compositions: ref ? ref.compositions : st.all('compositions'),
    }, {
      fmtDate,
      typeName: (t) => TYPES.find((x) => x.id === t)?.name || t,
      compositionName: (id) => { const c = ref?.compositionById[id]; return `#${id}${c?.synonym ? ' ' + c.synonym : ''}`; },
    });
    return index;
  };

  const place = () => {
    const r = input.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 420), window.innerWidth - 16);
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.width = `${width}px`;
  };
  const close = () => {
    pop.hidden = true; active = -1;
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  };
  const setActive = (i) => {
    const items = pop.querySelectorAll('a.sr-item');
    if (!items.length) { active = -1; return; }
    active = (i + items.length) % items.length;
    items.forEach((a, j) => { a.classList.toggle('on', j === active); a.setAttribute('aria-selected', String(j === active)); });
    input.setAttribute('aria-activedescendant', items[active].id);
    items[active].scrollIntoView({ block: 'nearest' });
  };
  const draw = () => {
    const q = input.value.trim();
    if (!q) { close(); return; }
    const res = search(ensureIndex(), q, { perKind: 5 });
    hits = res.groups.flatMap((g) => g.items);
    let i = 0;
    pop.innerHTML = res.groups.length
      ? res.groups.map((g) => `<div class="sr-group" role="presentation" data-kind="${g.kind}"><div class="sr-head">${esc(g.label)}${g.more ? `<span>${g.items.length + g.more}</span>` : ''}</div>`
        + g.items.map((h) => `<a class="sr-item" role="option" aria-selected="false" id="sr-${i}" data-i="${i++}" data-kind="${h.kind}" data-id="${esc(h.id)}" href="${esc(hitHref(h))}"><span class="sr-title${h.kind === 'sample' ? ' sr-mono' : ''}">${esc(h.title)}</span>${h.sub ? `<span class="sr-sub">${esc(h.sub)}</span>` : ''}</a>`).join('')
        + (g.more ? `<div class="sr-more">and ${g.more} more — type more of the name to narrow it down</div>` : '') + '</div>').join('')
        + '<div class="sr-keys">↑ ↓ to move · Enter to open · Esc to close</div>'
      : `<div class="sr-empty">Nothing found for “${esc(q)}”. Try an id (E3-F2, Stock-001), a sample name (E6-F1_4C_T07) or part of a name.</div>`;
    pop.hidden = false; input.setAttribute('aria-expanded', 'true');
    place();
    setActive(0);
  };
  const open = (i) => {
    const h = hits[i]; if (!h) return;
    input.value = ''; close(); input.blur();
    location.hash = hitHref(h);
  };

  input.addEventListener('focus', () => { index = null; if (input.value.trim()) draw(); });
  input.addEventListener('input', draw);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (pop.hidden) { draw(); return; }
      e.preventDefault(); setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault(); if (!pop.hidden && active >= 0) open(active);
    } else if (e.key === 'Escape') {
      // The first Esc clears what was typed (the browser's own handling of a search field), the next leaves.
      e.preventDefault();
      if (input.value) { input.value = ''; close(); } else input.blur();
    }
  });
  // Leaving the box closes the list, but not before a click on it has landed.
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 150));
  pop.addEventListener('mousedown', (e) => e.preventDefault()); // keep the focus in the box while clicking a hit
  pop.addEventListener('mousemove', (e) => { const a = e.target.closest('a.sr-item'); if (a && Number(a.dataset.i) !== active) setActive(Number(a.dataset.i)); });
  pop.addEventListener('click', (e) => {
    const a = e.target.closest('a.sr-item'); if (!a) return;
    // A plain click opens the hit here; one with a modifier is left to the browser (a new tab).
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault(); open(Number(a.dataset.i));
  });
  // The list is fixed to the window; on a narrow screen the sidebar scrolls away with the page, so follow it.
  window.addEventListener('resize', () => { if (!pop.hidden) place(); });
  window.addEventListener('scroll', (e) => { if (!pop.hidden && !pop.contains(e.target)) place(); }, true);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (!box?.isConnected) return;
      input.focus(); input.select();
    }
  });
  return wrap;
}
