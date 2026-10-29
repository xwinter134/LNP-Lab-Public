// Screen: Design catalogue — every experiment the app can set up, grouped by the question it answers.
//
// The counterpart to the planner. The planner asks three questions and hands down one answer; this lays the
// whole shelf out and lets you pick. The batch counts are computed from the app's own design generator at
// the factor count you choose, so what you read here is what the wizard will produce.
//
// Read by shape first, words second (UX revision: "too much text"). Each entry is a tile: a small figure of
// the design (app/ui/designviz.js, drawn from the same generator), its name, one line saying the question it
// answers, the batch count and "Set up". What it estimates, what it cannot tell you and when to use it are
// one click away in the tile's fold, and the reasoning behind it is behind the `?`. Simple experiments come
// first, because that is where most projects start (app/calc/designs.js, CATEGORIES).
//
// The fold (UX revision 2: "it should get small again when I leave the page and re-enter, and distribute the
// text across the window, so move the arrow to the left"): its arrow sits on the left of its label, at the left
// edge of the tile; opened, the tile takes the whole width of the catalogue and the four parts of the text sit
// side by side rather than in a narrow column under the figure; and every visit starts with all of them closed.
import { header, esc, field, chip } from './kit.js';
import { CATEGORIES, CATALOG, runsFor, fitsFactors, setupLink } from '../calc/designs.js';
import { catalogueFigure, catalogueLegend } from './designviz.js';
import { info, wireLearn } from './learn.js';

const FACTOR_CHOICES = [2, 3, 4, 5];

// Which tiles' "More" folds are open during this visit. Changing the factor count or the budget redraws the
// screen from the URL, and a fold someone opened to compare two designs should still be open afterwards; that
// redraw sets `redrawing`. Any other way onto the screen (the sidebar, a link, the back button from elsewhere)
// is a new visit, and the catalogue opens tidy, every fold closed.
const opened = new Set();
let redrawing = false;

export async function render(el, ctx) {
  if (!redrawing) opened.clear();
  redrawing = false;
  // a redraw of this screen from its own controls keeps the folds; the flag is spent on the render it asked for
  const redraw = (params) => { redrawing = true; ctx.navigate('designs', params); };
  const k = Math.max(2, Math.min(5, Number(ctx.params.k) || 3));
  const budget = Number(ctx.params.budget) > 0 ? Number(ctx.params.budget) : null;
  const factors = (ctx.params.factors || '').split(',').map((s) => s.trim()).filter(Boolean);

  const counted = CATALOG.map((e) => ({ e, runs: runsFor(e, k), fits: fitsFactors(e, k) }));
  const within = counted.filter((x) => x.runs != null && (!budget || x.runs <= budget));

  el.innerHTML = header('Plan', 'Design catalogue',
    `<a class="btn" href="#/advisor">Help me choose</a>`) +
    `<div id="catRoot">
      <div class="card dc-controls">
        <div>
          <div class="lbl">Factors to vary</div>
          <div class="seg" id="kSeg" role="group" aria-label="Number of factors">
            ${FACTOR_CHOICES.map((n) => `<button type="button" data-k="${n}" class="${n === k ? 'on' : ''}">${n}</button>`).join('')}
          </div>
        </div>
        <div class="dc-budget">${field({ id: 'budget', label: 'Batches you can make', type: 'number', value: budget ?? '', placeholder: 'no limit' })}</div>
        <div class="muted dc-fit" title="Each count includes the design’s centre points and one replicate; the wizard shows the new total if you change either. A greyed-out entry is impossible at this factor count (Box-Behnken needs three) or no longer worth it (a three-level factorial above three).">${within.length} of ${counted.length} fit${budget ? ` ${budget} batch${budget === 1 ? '' : 'es'}` : ''} at ${k} factors</div>
        <div class="dc-legend muted">${catalogueLegend()}</div>
        ${factors.length ? `<div class="muted dc-fit">From the planner: ${factors.length} factors, carried into whichever design you set up.</div>` : ''}
      </div>
      ${CATEGORIES.map((c) => section(c, counted, budget, k, factors)).join('')}
    </div>`;

  const root = el.querySelector('#catRoot');
  wireLearn(root);
  root.addEventListener('toggle', (e) => {
    const d = e.target.closest?.('details[data-entry]'); if (!d) return;
    if (d.open) opened.add(d.dataset.entry); else opened.delete(d.dataset.entry);
    // opened, the tile spans the catalogue's width so its text can spread out (CSS: .dc-item.wide)
    d.closest('.dc-item')?.classList.toggle('wide', d.open);
  }, true);
  el.querySelectorAll('#kSeg button').forEach((b) => b.addEventListener('click', () => redraw({ ...ctx.params, k: b.dataset.k })));
  el.querySelector('[name=budget]')?.addEventListener('input', (e) => {
    clearTimeout(render._t);
    const v = e.target.value;
    render._t = setTimeout(() => redraw({ ...ctx.params, k, budget: v }), 300);
  });
}

function section(c, counted, budget, k, factors) {
  const rows = counted.filter((x) => x.e.category === c.id);
  if (!rows.length) return '';
  return `<section class="card dc-group" data-cat="${esc(c.id)}"><h2>${esc(c.title)} <span class="muted dc-blurb">${esc(c.blurb)}</span></h2>
    <div class="dc-grid">${rows.map((x) => tile(x, budget, k, factors)).join('')}</div>
  </section>`;
}

function tile({ e, runs, fits }, budget, k, factors) {
  const over = runs != null && budget && runs > budget;
  const dim = !fits || over;
  const count = runs == null
    ? `<span class="chip warn">not at ${k} factors</span>`
    : `<span class="chip ${over ? 'warn' : 'info'} dc-count">${runs} batch${runs === 1 ? '' : 'es'}${over ? ' · over budget' : ''}</span>`;
  const gives = e.estimates.length ? e.estimates.map((s) => chip(s, 'ok')).join(' ') : '<span class="muted">nothing on its own</span>';
  const open = opened.has(e.id);
  // The fold is the tile's last row, across its whole width, so its arrow is at the tile's left edge and the
  // text it opens is not squeezed into the column beside the figure.
  return `<article class="dc-item${dim ? ' dim' : ''}${open ? ' wide' : ''}" data-entry="${esc(e.id)}">
    <div class="dc-fig">${catalogueFigure(e)}</div>
    <div class="dc-body">
      <div class="dc-name"><b>${esc(e.name)}</b> ${info(e.topic)}</div>
      <div class="dc-ans">${esc(e.answers)}</div>
      <div class="dc-foot">${count}${fits ? `<a class="btn ${dim ? '' : 'primary'}" href="${setupLink(e, factors)}">Set up</a>` : ''}</div>
    </div>
    <details class="dc-more" data-entry="${esc(e.id)}"${open ? ' open' : ''}><summary>More about ${esc(e.name)}</summary>
      <div class="dc-cols">
        <p class="dc-what">${esc(e.what)}</p>
        <p><b>Gives:</b> ${gives}</p>
        <p><b>Will not tell you:</b> ${esc(e.cannot)}</p>
        <p><b>Use it when:</b> ${esc(e.when)}</p>
        ${e.note ? `<p class="muted dc-note">${esc(e.note)}</p>` : ''}
      </div>
    </details>
  </article>`;
}
