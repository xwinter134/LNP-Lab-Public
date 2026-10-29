// The design catalogue. These are checks on the content as much as the code: a catalogue that omits a design
// the wizard can build, or quotes a batch count the wizard will not produce, is worse than no catalogue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, CATALOG, runsFor, fitsFactors, catalogIn, catalogEntry, affordable, catalogGaps } from '../app/calc/designs.js';
import { DESIGN_TYPES, buildDesign } from '../app/calc/doe.js';
import { TYPES } from '../app/calc/experiment.js';
import { TOPICS } from '../app/learn/topics.js';

test('the catalogue covers everything the app can actually build', () => {
  const gaps = catalogGaps();
  assert.deepEqual(gaps.designs, [], `designs the DoE screen offers but the catalogue omits: ${gaps.designs.join(', ')}`);
  assert.deepEqual(gaps.types, [], `experiment types the catalogue omits: ${gaps.types.join(', ')}`);
  // and nothing in it points at a design or type that does not exist
  for (const e of CATALOG) {
    if (e.kind === 'doe') assert.ok(DESIGN_TYPES[e.design], `${e.id} names a design the app cannot build: ${e.design}`);
    if (e.kind === 'type') assert.ok(TYPES.some((t) => t.id === e.type), `${e.id} names an experiment type that does not exist: ${e.type}`);
  }
  assert.equal(new Set(CATALOG.map((e) => e.id)).size, CATALOG.length, 'catalogue ids must be unique');
});

test('every entry says what it gives you, what it will not, and where to read more', () => {
  for (const e of CATALOG) {
    assert.ok(e.name && e.name.length > 3, `${e.id} has no name`);
    assert.ok(CATEGORIES.some((c) => c.id === e.category), `${e.id} is in an unknown category "${e.category}"`);
    for (const field of ['what', 'when', 'cannot']) {
      assert.ok(e[field] && e[field].length > 25, `${e.id} has no usable ${field}`);
    }
    assert.ok(Array.isArray(e.estimates), `${e.id} has no estimates list`);
    assert.ok(TOPICS[e.topic], `${e.id} links to a reference entry that does not exist: ${e.topic}`);
    assert.ok(/^(experiments|ml)(\?|$)/.test(e.screen), `${e.id} points at an unknown screen: ${e.screen}`);
    assert.ok(typeof e.runs === 'function' || e.kind === 'doe', `${e.id} cannot say what it costs`);
  }
  for (const c of CATEGORIES) {
    assert.ok(catalogIn(c.id).length, `category "${c.id}" is empty`);
    assert.ok(c.blurb && c.blurb.length > 30, `category "${c.id}" does not explain itself`);
  }
});

test('the batch count is the one the wizard will produce', () => {
  // The catalogue computes from the same generator the DoE screen uses. If it ever stops agreeing with a
  // full build, the number on screen is a promise the wizard breaks.
  const spec = (design, k, centerPoints) => ({
    designType: design, model: DESIGN_TYPES[design].levels >= 3 ? 'quadratic' : 'interaction',
    centerPoints, replicates: 1, seed: 42, alpha: '', responses: ['particle_size_nm'],
    factors: Array.from({ length: k }, (_, i) => ({ name: `X${i + 1}`, unit: '', low: 0, center: '', high: 1 })),
  });
  for (const e of CATALOG.filter((x) => x.kind === 'doe')) {
    for (const k of [2, 3, 4, 5]) {
      const claimed = runsFor(e, k);
      if (claimed == null) { assert.ok(!fitsFactors(e, k), `${e.id} refuses ${k} factors but claims to support them`); continue; }
      const built = buildDesign(spec(e.design, k, e.center || 0)).length;
      assert.equal(claimed, built, `${e.id} at ${k} factors: catalogue says ${claimed}, the builder produces ${built}`);
    }
  }
});

test('a design is offered only where it can be run', () => {
  assert.equal(runsFor(catalogEntry('bbd'), 2), null, 'Box-Behnken needs three factors');
  assert.ok(runsFor(catalogEntry('bbd'), 3) > 0);
  assert.equal(runsFor(catalogEntry('full_factorial_3'), 4), null, 'a three-level factorial is past the point of being worth it above three factors');
  assert.ok(runsFor(catalogEntry('plackett_burman'), 5) > 0);
  // and a screening design is always cheaper than a surface over the same factors
  for (const k of [3, 4]) {
    assert.ok(runsFor(catalogEntry('plackett_burman'), k) < runsFor(catalogEntry('ccd_faced'), k),
      `at ${k} factors a screen should cost less than a response surface`);
  }
});

test('the budget filter keeps what fits and drops what does not', () => {
  const small = affordable(8, 3).map((x) => x.e.id);
  assert.ok(small.includes('single'), 'one batch fits any budget');
  assert.ok(!small.includes('ccd_faced'), 'a face-centred composite over three factors does not fit eight batches');
  const large = affordable(30, 3).map((x) => x.e.id);
  assert.ok(large.includes('ccd_faced'), 'it does fit thirty');
  assert.ok(large.length > small.length, 'a larger budget opens more options');
  // cheapest first, so the list reads as a ladder
  const runs = affordable(30, 3).map((x) => x.runs);
  assert.deepEqual(runs, [...runs].sort((a, b) => a - b), 'the affordable list should be ordered by cost');
});

test('every entry hands itself over with the design already chosen', () => {
  for (const e of CATALOG.filter((x) => x.kind === 'doe')) {
    assert.ok(e.screen.includes(`design=${e.design}`), `${e.id} does not carry its design into the wizard`);
    assert.ok(/model=(linear|interaction|quadratic)/.test(e.screen), `${e.id} does not carry a model`);
    // a two-level design cannot fit a quadratic model, which validateSpec rejects outright
    if (DESIGN_TYPES[e.design].levels === 2) assert.ok(!/model=quadratic/.test(e.screen), `${e.id} asks the wizard for a model its design cannot fit`);
  }
});

test('the simple experiments come first, and every entry says in one line what it answers', () => {
  // UX revision: a newcomer looks for "the reproducibility one" at the top, and reads one line per entry.
  assert.equal(CATEGORIES[0].id, 'simple');
  assert.deepEqual(catalogIn('simple').map((e) => e.type), ['single', 'reference', 'comparison']);
  for (const e of CATALOG) {
    assert.ok(e.answers && e.answers.length <= 70, `${e.id} needs a one-line "answers" (at most 70 characters): ${e.answers}`);
    assert.ok(e.answers.endsWith('?'), `${e.id}'s "answers" should be the question: ${e.answers}`);
  }
});

test('every catalogue entry has a figure, drawn from the generator for a design', async () => {
  const { catalogueFigure } = await import('../app/ui/designviz.js');
  for (const e of CATALOG) {
    const svg = catalogueFigure(e);
    assert.match(svg, /^<svg [^>]*viewBox="0 0 120 96"/, `${e.id} has no figure`);
    assert.doesNotMatch(svg, /NaN|undefined/, `${e.id}'s figure has a broken coordinate`);
    // theme-safe: colours come from the theme's variables, never a bare hex the dark theme cannot change
    assert.doesNotMatch(svg.replace(/var\([^)]*\)/g, ''), /#[0-9a-f]{3,6}\b/i, `${e.id}'s figure hard-codes a colour`);
  }
  // a Box-Behnken has no corner runs, a 2-level factorial has all eight, and the figure shows exactly that
  const dots = (id) => (catalogueFigure(catalogEntry(id)).match(/<circle /g) || []).length;
  assert.equal(dots('full_factorial'), 8 + 1, 'eight corners and a centre');
  assert.equal(dots('bbd'), 12 + 1, 'twelve edge midpoints and a centre');
  assert.equal(dots('ccd_faced'), 8 + 6 + 1, 'corners, six face points, a centre');
});
