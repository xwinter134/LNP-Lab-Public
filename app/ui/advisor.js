// Screen: Plan an experiment — asks what you are trying to do, then says what to run and why.
//
// The point is not to hide the decision but to show it. Every recommendation carries the reasoning that
// produced it, what to expect from the runs, and what commonly goes wrong, with the terms linked to the
// reference. Someone who disagrees with the advice should be able to see exactly where they disagree.
import { header, esc } from './kit.js';
import { getRef } from '../refdata.js';
import { AIMS, SYMPTOMS, BUDGETS, SCOPES, advise } from '../calc/advise.js';
import { ALL_FACTORS } from '../calc/ml/space.js';
import { buildRows } from '../calc/ml/dataset.js';
import { info, infoLink, wireLearn } from './learn.js';
import { ICONS } from './icons.js';
import { TOPICS } from '../learn/topics.js';

const factorName = (key) => ALL_FACTORS.find((f) => f.key === key)?.name || key;

export async function render(el, ctx) {
  const ref = getRef(ctx);
  const rows = buildRows(ctx);
  const measured = rows.filter((r) => r.nResponses > 0);
  const varied = ALL_FACTORS.filter((f) => new Set(measured.map((r) => r.factors[f.key]).filter(Number.isFinite).map((v) => Math.round(v * 1e4))).size >= 3).map((f) => f.key);
  const replicates = (() => {
    const seen = new Map();
    for (const r of measured) {
      const k = ALL_FACTORS.map((f) => Math.round((r.factors[f.key] ?? NaN) * 1e3)).join('|');
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    return [...seen.values()].some((v) => v > 1);
  })();

  const p = ctx.params;
  const state = { aim: p.aim || '', symptom: p.symptom || '', budget: p.budget || '', scope: p.scope || '' };
  // Three questions are the right start for someone who does not know what to run, and the wrong one for
  // someone who already knows they want a Box-Behnken. So the first screen offers a choice of door instead
  // of beginning the interrogation, and `mode=wizard` marks the door having been chosen.
  const started = p.mode === 'wizard' || Object.values(state).some(Boolean);
  const go = (next) => ctx.navigate('advisor', { mode: 'wizard', ...state, ...next });

  if (!started) {
    el.innerHTML = header('Plan', 'Plan an experiment',
      `<span class="chip ${measured.length ? 'info' : ''}">${measured.length} measured run${measured.length === 1 ? '' : 's'}</span><a class="btn" href="#/learn">Reference</a>`) +
      `<div id="advRoot">${doors(measured.length, replicates)}</div>`;
    wireLearn(el.querySelector('#advRoot'));
    return;
  }

  // Which question is still unanswered decides what is on screen.
  const needsSymptom = state.aim === 'trouble' && !state.symptom;
  const needsBudget = state.aim && state.aim !== 'trouble' && !state.budget;
  const needsScope = state.aim && state.aim !== 'trouble' && state.budget && !state.scope
    && !['stability', 'robust'].includes(state.aim);
  const ready = state.aim && (state.aim === 'trouble' ? !!state.symptom : (!!state.budget && (!!state.scope || ['stability', 'robust'].includes(state.aim))));

  const rec = ready ? advise({ aim: state.aim, symptom: state.symptom, budget: state.budget, scope: state.scope || 'fixed',
    measuredRuns: measured.length, hasReplicates: replicates, factorsVaried: varied }) : null;

  const steps = state.aim === 'trouble' ? ['What for', 'Which symptom', 'What to do']
    : ['What for', 'How many batches', 'What can change', 'What to run'].filter((s, i) => !(i === 2 && ['stability', 'robust'].includes(state.aim)));
  const stepIndex = !state.aim ? 0 : needsSymptom ? 1 : needsBudget ? 1 : needsScope ? 2 : steps.length - 1;

  el.innerHTML = header('Plan', 'Plan an experiment',
    `<span class="chip ${measured.length ? 'info' : ''}">${measured.length} measured run${measured.length === 1 ? '' : 's'}</span><a class="btn" href="#/designs">Browse designs</a><a class="btn" href="#/advisor">Other ways in</a>`) +
    `<div id="advRoot">
      <ol class="adv-steps">${steps.map((s, i) => `<li class="chip ${i < stepIndex ? 'ok' : i === stepIndex ? 'info' : ''}">${i + 1} · ${esc(s)}</li>`).join('')}</ol>
      ${chosenSummary(state, go)}
      ${!state.aim ? aimCards()
        : needsSymptom ? symptomCards()
        : needsBudget ? budgetCards(measured.length)
        : needsScope ? scopeCards()
        : recommendation(rec, state, measured, replicates, varied)}
    </div>`;

  wireLearn(el.querySelector('#advRoot'));
  el.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => {
    const [k, v] = b.dataset.set.split('=');
    const next = { [k]: v };
    // Changing an earlier answer clears the later ones, so the advice always matches what is on screen.
    const order = ['aim', 'symptom', 'budget', 'scope'];
    for (const key of order.slice(order.indexOf(k) + 1)) next[key] = '';
    go(next);
  }));
}

/**
 * The three ways in. They end in the same place, an experiment set up and ready to run, but they start from
 * what the person already knows: nothing, a design, or a symptom.
 */
function doors(n, hasReplicates) {
  const door = (href, icon, title, blurb, action) => `<a class="adv-card adv-door" href="${href}">
    <span class="ico">${ICONS[icon] || ''}</span>
    <span class="adv-card-title">${esc(title)}</span>
    <span class="muted">${esc(blurb)}</span>
    <span class="adv-door-go">${esc(action)}</span></a>`;
  const standing = !n
    ? 'Nothing is measured yet, so whichever door you take will start you with a batch at a standard setting and a repeat to measure your noise.'
    : !hasReplicates
      ? `${n} measured run${n === 1 ? '' : 's'} on file, but no setting has been run twice, so your measurement noise is still unknown and every difference you have seen is uncalibrated.`
      : `${n} measured runs on file, with repeats, so the planner and the model both have something to work from.`;
  return `<div class="card"><h2>How do you want to start?</h2>
    <p class="muted">${esc(standing)}</p>
    <div class="grid g3">
      ${door('#/advisor?mode=wizard', 'advisor', 'Answer three questions',
        'What you are trying to do, how many batches you can run, and what you are allowed to change. You get one recommendation with the reasoning attached, and a button that sets it up.',
        'Start the questions')}
      ${door('#/designs', 'designs', 'Choose a design yourself',
        'The whole shelf, grouped by the question each design answers, with the batch count for every one of them at the number of factors you pick.',
        'Open the catalogue')}
      ${door('#/advisor?mode=wizard&aim=trouble', 'measurements', 'Work out what went wrong',
        'Start from a symptom rather than a goal. The likely causes in order, each with the check that settles it before you spend a batch on it.',
        'Pick a symptom')}
    </div></div>`;
}

function chosenSummary(state, go) {
  const bits = [];
  if (state.aim) bits.push(['aim', AIMS.find((a) => a.id === state.aim)?.title]);
  if (state.symptom) bits.push(['symptom', SYMPTOMS.find((s) => s.id === state.symptom)?.title]);
  if (state.budget) bits.push(['budget', BUDGETS.find((b) => b.id === state.budget)?.title]);
  if (state.scope) bits.push(['scope', SCOPES.find((s) => s.id === state.scope)?.title]);
  if (!bits.length) return '';
  return `<div class="card" style="padding:10px 14px"><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    ${bits.map(([k, v]) => `<button type="button" class="btn" data-set="${k}=" title="change this">${esc(v || '')} ✕</button>`).join('')}
    <span class="muted">click to change</span></div></div>`;
}

const cardGrid = (items) => `<div class="grid g2">${items.join('')}</div>`;
const choiceCard = (set, title, blurb, extra = '') => `<button type="button" class="adv-card" data-set="${esc(set)}">
  <div class="adv-card-title">${esc(title)}</div><div class="muted">${esc(blurb)}</div>${extra}</button>`;

function aimCards() {
  return `<div class="card"><h2>What are you trying to do?</h2>
    <p class="muted">Pick the closest. The answer decides the kind of experiment, and the kind of experiment decides almost everything else.</p>
    ${cardGrid(AIMS.map((a) => choiceCard(`aim=${a.id}`, a.title, a.blurb)))}</div>`;
}
function symptomCards() {
  return `<div class="card"><h2>What is wrong?</h2>
    <p class="muted">Each one leads to a list of likely causes in order, with the check that settles each before you spend a batch on it.</p>
    ${cardGrid(SYMPTOMS.map((s) => choiceCard(`symptom=${s.id}`, s.title, `${s.causes.length} likely causes, most common first`)))}</div>`;
}
function budgetCards(n) {
  return `<div class="card"><h2>How many batches can you run on this?</h2>
    <p class="muted">Be honest rather than hopeful. The right design is mostly a function of this number, and a design that runs out of batches halfway answers nothing.${n ? ` You already have ${n} measured run${n === 1 ? '' : 's'}, which count toward what a model can do but not toward this.` : ''}</p>
    ${cardGrid(BUDGETS.map((b) => choiceCard(`budget=${b.id}`, b.title, b.id === 'tiny' ? 'Enough to confirm or to fix one thing, not to map anything.'
      : b.id === 'small' ? 'Enough for a screen, or a first spread-out set.'
      : b.id === 'medium' ? 'Enough for a small response surface, or two rounds of suggestions.'
      : b.id === 'large' ? 'Enough for a full response surface over three factors.'
      : 'Enough to run in rounds, learning between them.')))}</div>`;
}
function scopeCards() {
  return `<div class="card"><h2>What are you allowed to change?</h2>
    <p class="muted">Composition and process are different kinds of change. The process is yours to tune; the recipe carries more consequence, because immune response and safety do not follow from size and encapsulation. ${infoLink('mixture', 'The mixture constraint')} applies as soon as lipid percentages move.</p>
    ${cardGrid(SCOPES.map((s) => choiceCard(`scope=${s.id}`, s.title, s.blurb)))}</div>`;
}

/* ---------------- the answer ---------------- */
function recommendation(rec, state, measured, replicates, varied) {
  if (!rec) return '';
  if (rec.type === 'diagnose') return diagnosis(rec);

  // Hand the recommendation over rather than describing it: the target screen opens already set up.
  const keys = rec.factors.map((f) => f.key).join(',');
  const extra = rec.type === 'screen' ? `&design=plackett_burman&model=linear&center=3`
    : rec.type === 'rsm' ? `&design=ccd_faced&model=quadratic&center=4` : '';
  const link = rec.screen ? `#/${rec.screen}${keys ? (rec.screen.includes('?') ? '&' : '?') + 'factors=' + encodeURIComponent(keys) + extra : ''}` : '';
  return `<div class="card" style="border-color:var(--c-advisor)">
      <div class="adv-verdict"><div><div class="muted" style="font-size:12px;text-transform:uppercase;letter-spacing:.05em">Recommendation</div>
        <h2 style="margin:2px 0 6px;font-size:20px">${esc(rec.headline)}</h2>
        <p style="margin:0">${esc(rec.plan)}</p></div></div>
      ${link ? `<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap"><a class="btn primary" href="${link}">Set this up</a>
        ${(rec.alternatives || []).map((alt) => `<a class="btn" href="#/${esc(alt.screen)}" title="${esc(alt.why)}">${esc(alt.title)}</a>`).join('')}</div>` : ''}</div>

    <div class="grid g2">
      <div class="card"><h2>Why this and not something else</h2>
        <ul class="adv-list">${rec.because.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>
      <div class="card"><h2>What will happen</h2>
        <ul class="adv-list">${rec.expect.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>
    </div>

    ${rec.watch.length ? `<div class="card"><h2>What usually goes wrong</h2>
      ${rec.watch.map((w) => `<div class="note warn">${esc(w)}</div>`).join('')}</div>` : ''}

    ${context(rec, measured, replicates, varied)}
    ${reading(rec)}`;
}

/** What the app already knows about your data, and what that implies for the advice above. */
function context(rec, measured, replicates, varied) {
  const notes = [];
  if (!measured.length) notes.push('Nothing is measured yet, so none of this is tuned to your system. It will be after the first round.');
  else notes.push(`${measured.length} measured run${measured.length === 1 ? '' : 's'} are on file. ${measured.length >= 15 ? 'That is enough for a model to be tested honestly on held-out experiments.' : measured.length >= 8 ? 'That is enough for a first model, though not yet enough to test its quality properly: about 15 is.' : 'A model needs about 8 before it says anything useful.'}`);
  if (!replicates && measured.length >= 4) notes.push('No setting has been run twice, so your measurement noise is unknown and every difference you see is uncalibrated. Repeating settings fixes this for everything that follows, and spreading the repeats over two or three recipes beats piling them on one: the degrees of freedom add up and the estimate stops depending on a single setting.');
  if (varied.length) notes.push(`Factors that have genuinely varied across your batches: ${varied.map(factorName).join(', ')}. Anything else cannot be judged from the data you have, however much it matters in principle.`);
  return `<div class="card"><h2>Where you are starting from</h2><ul class="adv-list">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>`;
}

function diagnosis(rec) {
  const sym = rec.symptom;
  if (!sym) return '';
  return `<div class="card" style="border-color:var(--c-advisor)"><h2 style="font-size:20px">${esc(rec.headline)}</h2>
      <p class="muted">${esc(rec.plan)}</p></div>
    ${sym.causes.map((c, i) => `<div class="card"><div style="display:flex;gap:10px;align-items:baseline">
        <span class="chip ${i === 0 ? 'info' : ''}">${i + 1}</span>
        <div style="flex:1"><h2 style="margin:0;font-size:16px">${esc(c.cause)} ${c.topic ? info(c.topic) : ''}</h2>
          <p class="muted" style="margin:4px 0 0">${esc(c.why)}</p>
          <div style="margin-top:8px"><b>Check:</b> ${esc(c.check)}</div>
          <div style="margin-top:2px"><b>If that is it:</b> ${esc(c.fix)}</div></div></div></div>`).join('')}
    ${rec.watch.length ? `<div class="card">${rec.watch.map((w) => `<div class="note warn">${esc(w)}</div>`).join('')}</div>` : ''}
    ${reading(rec)}`;
}

function reading(rec) {
  const ids = (rec.topics || []).filter((t) => TOPICS[t]);
  if (!ids.length) return '';
  return `<div class="card"><h2>Worth reading first</h2>
    <div class="grid g2">${ids.map((id) => `<button type="button" class="learn-tile" data-learn="${esc(id)}">
      <div class="learn-tile-title">${esc(TOPICS[id].title)}</div>
      <div class="muted">${esc(TOPICS[id].what.length > 130 ? TOPICS[id].what.slice(0, 127) + '…' : TOPICS[id].what)}</div></button>`).join('')}</div></div>`;
}
