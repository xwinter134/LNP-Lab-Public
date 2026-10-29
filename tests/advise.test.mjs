// The planner's advice and the reference behind it. These are checks on the content as much as the code:
// an explainer with a dangling link or a recommendation that cites a topic that does not exist is a defect
// the user meets, not a typo nobody sees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AIMS, SYMPTOMS, BUDGETS, SCOPES, DRIVERS, advise } from '../app/calc/advise.js';
import { TOPICS, GROUPS, topicIds, topicsIn, searchTopics } from '../app/learn/topics.js';
import { ALL_FACTORS } from '../app/calc/ml/space.js';

test('every reference entry is complete, and nothing links to a topic that does not exist', () => {
  const ids = new Set(topicIds());
  assert.ok(ids.size >= 25, `the reference should be worth opening (${ids.size} entries)`);
  for (const [id, t] of Object.entries(TOPICS)) {
    // A title is a label and may be short ("PEG-lipid"); the body fields have to be sentences.
    assert.ok(t.title && t.title.trim().length >= 3, `${id} has no title`);
    for (const field of ['what', 'why', 'doing', 'trap']) {
      assert.ok(t[field] && String(t[field]).trim().length > 20, `${id} has no usable ${field}`);
    }
    assert.ok(GROUPS.includes(t.group), `${id} is in an unknown group "${t.group}"`);
    for (const s of t.see || []) assert.ok(ids.has(s), `${id} links to a topic that does not exist: ${s}`);
    for (const row of t.numbers || []) assert.equal(row.length, 2, `${id} has a malformed numbers row`);
    // the "what" is the one-line summary shown on a tile; it has to stand alone
    assert.ok(!/^(it|this|they)\b/i.test(t.what.trim()), `${id} starts its definition with a pronoun`);
  }
  assert.equal(GROUPS.reduce((n, g) => n + topicsIn(g).length, 0), ids.size, 'every topic belongs to a listed group');
});

test('every reference entry is reachable from the app, not only from the index', async () => {
  // An explainer nobody can find is a document, not a feature. Each entry has to be reachable either from a
  // "?" on a screen or from something the planner recommends.
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../app/ui/', import.meta.url).pathname;
  const src = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(dir + f, 'utf8')).join('\n');
  const fromScreens = new Set([...src.matchAll(/info\(['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]));
  const fromPlanner = new Set(SYMPTOMS.flatMap((s) => s.causes.map((c) => c.topic)).filter(Boolean));
  for (const aim of AIMS.map((a) => a.id)) {
    for (const budget of BUDGETS.map((b) => b.id)) {
      for (const scope of SCOPES.map((s) => s.id)) {
        for (const measuredRuns of [0, 10, 20]) {
          advise({ aim, symptom: 'pdi', budget, scope, measuredRuns }).topics.forEach((t) => fromPlanner.add(t));
        }
      }
    }
  }
  const reachable = new Set([...fromScreens, ...fromPlanner]);
  const orphans = topicIds().filter((t) => !reachable.has(t));
  assert.deepEqual(orphans, [], `these entries can only be found by browsing the index: ${orphans.join(', ')}`);
  // and nothing points at an entry that was renamed or removed
  const unknown = [...fromScreens].filter((t) => !TOPICS[t]);
  assert.deepEqual(unknown, [], `a screen opens an explainer that does not exist: ${unknown.join(', ')}`);
});

test('the reference is searchable by word and by id', () => {
  assert.ok(searchTopics('').length === topicIds().length, 'an empty search returns everything');
  assert.ok(searchTopics('flow rate').some((t) => t.id === 'tfr'));
  assert.ok(searchTopics('polydispersity').some((t) => t.id === 'pdi'), 'found by a word in the body, not only the title');
  assert.ok(searchTopics('encapsulation').length >= 2, 'a common word reaches several entries');
  assert.equal(searchTopics('zzzznotathing').length, 0);
});

test('every aim produces a recommendation with reasons, expectations and a caution', () => {
  for (const aim of AIMS.map((a) => a.id)) {
    for (const budget of BUDGETS.map((b) => b.id)) {
      for (const scope of SCOPES.map((s) => s.id)) {
        for (const measuredRuns of [0, 6, 14, 30]) {
          const rec = advise({ aim, symptom: aim === 'trouble' ? 'pdi' : '', budget, scope, measuredRuns });
          assert.ok(rec.headline && rec.headline.length > 10, `${aim}/${budget}/${scope}/${measuredRuns} has no headline`);
          assert.ok(Array.isArray(rec.because) && rec.because.length, `${aim} gives no reasons`);
          assert.ok(Array.isArray(rec.expect) && rec.expect.length, `${aim} says nothing about what will happen`);
          assert.ok(Array.isArray(rec.watch) && rec.watch.length, `${aim} warns about nothing`);
          assert.ok(rec.topics.every((t) => TOPICS[t]), `${aim} cites a reference entry that does not exist`);
          assert.ok(rec.factors.every((f) => ALL_FACTORS.some((x) => x.key === f.key)), `${aim} names a factor the app cannot set`);
          assert.ok(rec.because.every((b) => typeof b === 'string' && b.length > 20), `${aim} has a reason too short to be one`);
        }
      }
    }
  }
});

test('no recommendation spends more batches than you said you had, or fewer than its design needs', () => {
  // Both halves matter. Advice over budget is advice you cannot follow; a design with the runs quietly
  // removed answers nothing while looking like it answers something.
  for (const b of BUDGETS) {
    for (const aim of AIMS.map((a) => a.id)) {
      for (const scope of SCOPES.map((s) => s.id)) {
        for (const measuredRuns of [0, 2, 3, 6, 7, 8, 14, 30]) {
          const where = `${aim}/${b.id}/${scope}/${measuredRuns} runs`;
          const rec = advise({ aim, symptom: aim === 'trouble' ? 'pdi' : '', budget: b.id, scope, measuredRuns });
          assert.ok(rec.runs <= b.n, `${where}: asks for ${rec.runs} batches on a budget of ${b.n}`);
          assert.ok(rec.runs >= 0 && Number.isInteger(rec.runs), `${where}: ${rec.runs} is not a number of batches`);
          // a design has to be able to separate what it varies: two levels per factor at the very least
          if (rec.factors.length && !['ml', 'stability', 'diagnose'].includes(rec.type)) {
            assert.ok(rec.runs >= 2 * rec.factors.length,
              `${where}: a ${rec.type} varying ${rec.factors.length} factors in ${rec.runs} runs cannot separate them`);
          }
        }
      }
    }
  }
  // the smallest budget cannot carry a design at all, and says so rather than shrinking one
  for (const aim of ['first', 'size', 'ee', 'screen', 'optimise']) {
    const rec = advise({ aim, budget: 'tiny', scope: 'composition', measuredRuns: 0 });
    assert.equal(rec.type, 'baseline', `${aim} on three batches should fall back to a plain batch`);
    assert.deepEqual(rec.factors, [], `${aim} on three batches should vary nothing`);
  }
  // an explicit screen that does not fit is substituted, and says what it substituted and why
  const squeezed = advise({ aim: 'screen', budget: 'tiny', scope: 'process', measuredRuns: 14 });
  assert.equal(squeezed.type, 'ml');
  assert.ok(/formal screen does not fit/.test(squeezed.because.join(' ')), 'it should say the screen did not fit');
  // and runs already on file are not described as a blank slate
  const extend = advise({ aim: 'size', budget: 'small', scope: 'process', measuredRuns: 6 });
  assert.equal(extend.type, 'seed');
  assert.ok(/6 measured runs/.test(extend.because.join(' ')), 'it should count what is already there');
});

test('the advice changes with the answers, in the directions a formulator would expect', () => {
  const base = { budget: 'medium', scope: 'process', measuredRuns: 0 };
  // nothing measured and a small budget: spread out first
  assert.equal(advise({ ...base, aim: 'first', budget: 'small' }).type, 'seed');
  // asked to screen: screen, even with no data, because a screen is a legitimate starting point
  assert.equal(advise({ ...base, aim: 'screen' }).type, 'screen');
  assert.equal(advise({ ...base, aim: 'screen', measuredRuns: 0, budget: 'small' }).type, 'screen');
  // enough batches for one formal design but nothing measured: a response surface brings its own coverage
  assert.equal(advise({ ...base, aim: 'optimise', budget: 'large' }).type, 'rsm');
  // enough measured runs: let the model lead
  assert.equal(advise({ ...base, aim: 'optimise', budget: 'large', measuredRuns: 22 }).type, 'ml');
  assert.equal(advise({ ...base, aim: 'size', measuredRuns: 14 }).type, 'ml');
  // these aims never become an optimisation
  assert.equal(advise({ ...base, aim: 'stability' }).type, 'stability');
  assert.equal(advise({ ...base, aim: 'robust' }).type, 'reference');
  assert.equal(advise({ ...base, aim: 'trouble', symptom: 'big' }).type, 'diagnose');
});

test('scope decides whether the recipe is on the table', () => {
  const comp = ['peg_pct', 'ionizable_pct', 'helper_pct', 'sterol_pct'];
  for (const aim of ['size', 'ee', 'optimise', 'screen']) {
    const process = advise({ aim, budget: 'large', scope: 'process', measuredRuns: 0 });
    assert.ok(process.factors.every((f) => !comp.includes(f.key)), `${aim} proposed a composition factor under a process-only scope`);
    const both = advise({ aim, budget: 'large', scope: 'composition', measuredRuns: 0 });
    assert.ok(both.factors.length >= process.factors.length - 1, `${aim} offered fewer options with more freedom`);
  }
  assert.ok(advise({ aim: 'size', budget: 'large', scope: 'composition', measuredRuns: 0 }).factors.some((f) => f.key === 'peg_pct'),
    'PEG is the strongest composition lever on size and should be offered when composition is in scope');
  // and the scope still holds once there are runs on file, where the factors come from the data rather than the list
  const led = advise({ aim: 'size', budget: 'medium', scope: 'process', measuredRuns: 20, factorsVaried: ['frr', 'tfr', 'peg_pct', 'ionizable_pct'] });
  assert.equal(led.type, 'ml');
  assert.ok(led.factors.every((f) => !comp.includes(f.key)), 'a model-led round under a process-only scope proposed a composition factor');
  assert.ok(led.factors.every((f) => f.why && f.why.length > 15), 'every factor says what it does, not only that it was varied');
});

test('factors are ranked by how strongly they move the response, not by list order', () => {
  const size = advise({ aim: 'size', budget: 'large', scope: 'composition', measuredRuns: 0 }).factors;
  assert.equal(size[0].key, 'frr', 'flow rate ratio is the dominant lever on size');
  const ee = advise({ aim: 'ee', budget: 'large', scope: 'composition', measuredRuns: 0 }).factors;
  assert.ok(['np', 'ionizable_pct'].includes(ee[0].key), 'encapsulation is a charge-balance problem first');
  // with no single target a factor keeps its strongest role across responses
  const any = advise({ aim: 'optimise', budget: 'large', scope: 'process', measuredRuns: 0 }).factors;
  const order = any.map((f) => f.strength);
  assert.deepEqual(order, [...order].sort((a, b) => ({ strong: 3, moderate: 2, weak: 1 })[b] - ({ strong: 3, moderate: 2, weak: 1 })[a]),
    'the strongest levers come first');
  assert.ok(any.every((f) => f.why && f.why.length > 15), 'every factor says why it is on the list');
});

test('every symptom offers ordered causes, each with a check and a fix', () => {
  assert.ok(SYMPTOMS.length >= 5);
  for (const s of SYMPTOMS) {
    assert.ok(s.causes.length >= 3, `${s.id} offers too few causes to be a diagnosis`);
    for (const c of s.causes) {
      // `cause` is a headline ("Quench too late"); the rest have to explain themselves.
      assert.ok(c.cause && c.cause.length >= 8, `${s.id} has a cause with no headline`);
      for (const field of ['why', 'check']) {
        assert.ok(c[field] && c[field].length > 20, `${s.id} / "${c.cause}" has no usable ${field}`);
      }
      // a fix is allowed to be terse ("Quench sooner."), but it has to be an instruction
      assert.ok(c.fix && c.fix.length >= 10 && /^[A-Z]/.test(c.fix), `${s.id} / "${c.cause}" has no usable fix`);
      if (c.topic) assert.ok(TOPICS[c.topic], `${s.id} links to a reference entry that does not exist: ${c.topic}`);
    }
    const rec = advise({ aim: 'trouble', symptom: s.id, budget: 'tiny', scope: 'process', measuredRuns: 5 });
    assert.equal(rec.type, 'diagnose');
    assert.equal(rec.symptom.id, s.id);
    assert.equal(rec.runs, 0, 'a diagnosis costs no batches until a check says otherwise');
  }
});

test('every driver names a factor the app can actually set, and explains itself', () => {
  for (const [response, list] of Object.entries(DRIVERS)) {
    assert.ok(list.length >= 2, `${response} has too few drivers listed`);
    for (const d of list) {
      assert.ok(ALL_FACTORS.some((f) => f.key === d.key), `${response} lists a factor the app cannot set: ${d.key}`);
      assert.ok(['strong', 'moderate', 'weak'].includes(d.strength), `${response}/${d.key} has an unknown strength`);
      assert.ok(d.why && d.why.length > 15, `${response}/${d.key} has no explanation`);
    }
  }
});

test('the advice adapts to what is already on file', () => {
  const little = advise({ aim: 'optimise', budget: 'campaign', scope: 'process', measuredRuns: 10 });
  const plenty = advise({ aim: 'optimise', budget: 'campaign', scope: 'process', measuredRuns: 30 });
  assert.equal(little.type, 'ml');
  assert.equal(plenty.type, 'ml');
  assert.ok(/15 runs/.test(little.because.join(' ')), 'below 15 runs it says so');
  assert.ok(/held-out experiments/.test(plenty.because.join(' ')), 'above 15 it says the quality can be tested');
  const noRepeats = advise({ aim: 'optimise', budget: 'campaign', scope: 'process', measuredRuns: 20, hasReplicates: false });
  assert.ok(/lucky measurement/.test(noRepeats.expect.join(' ')), 'with no repeats it offers to confirm the incumbent');
  const withRepeats = advise({ aim: 'optimise', budget: 'campaign', scope: 'process', measuredRuns: 20, hasReplicates: true });
  assert.ok(!/lucky measurement/.test(withRepeats.expect.join(' ')), 'and stops offering once a repeat exists');
});
