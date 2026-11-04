// Breadcrumbs (spec 9.1): every route gets a trail that says where you are and leads back up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crumbsFor, parentCrumb } from '../app/ui/crumbs.js';

const SCREENS = [
  { id: 'overview', title: 'Overview' }, { group: 'Plan' },
  { id: 'advisor', title: 'Plan an experiment' }, { id: 'designs', title: 'Design catalogue' },
  { group: 'Run' }, { id: 'experiments', title: 'Experiments' }, { id: 'formulation', title: 'Formulations' }, { id: 'buffers', title: 'Buffers' },
  { group: 'Reference' }, { id: 'materials', title: 'Materials & lots' },
];
const labels = (t) => t.map((c) => c.label);

test('the wizard trail keeps each answer, and each crumb returns to that step', () => {
  const t = crumbsFor('advisor', { mode: 'wizard', aim: 'trouble', symptom: 'high_pdi' }, SCREENS);
  assert.deepEqual(labels(t).slice(0, 3), ['Plan', 'Plan an experiment', 'Questions']);
  assert.equal(t.length, 5);
  assert.equal(t[3].href, '#/advisor?mode=wizard&aim=trouble');
  assert.equal(t.at(-1).href, '#/advisor?mode=wizard&aim=trouble&symptom=high_pdi');
  assert.equal(parentCrumb(t).href, '#/advisor?mode=wizard&aim=trouble', 'Back without history goes up one step');
});

test('a group heading is shown but is not a link; the screen itself is', () => {
  const t = crumbsFor('designs', {}, SCREENS);
  assert.deepEqual(labels(t), ['Plan', 'Design catalogue']);
  assert.equal(t[0].href, null);
  assert.equal(parentCrumb(t), null, 'a top-level screen has nowhere further up');
});

test('a formulation sits under its experiment, a record under its screen', () => {
  const t = crumbsFor('formulation', { batch: 'E3-F2' }, SCREENS);
  assert.deepEqual(labels(t), ['Run', 'Formulations', 'Experiment 3', 'Experiment 3 · formulation 2']);
  assert.equal(t[2].href, '#/experiments?id=E3');
  assert.deepEqual(labels(crumbsFor('buffers', { id: 'Buffer-004' }, SCREENS)), ['Run', 'Buffers', 'Buffer-004']);
  assert.deepEqual(labels(crumbsFor('buffers', { role: 'formulation' }, SCREENS)), ['Run', 'Buffers', 'Final / Storage']);
  assert.deepEqual(labels(crumbsFor('materials', { tab: 'compositions' }, SCREENS)), ['Reference', 'Materials & lots', 'Compositions']);
  assert.deepEqual(labels(crumbsFor('experiments', { new: '1' }, SCREENS)), ['Run', 'Experiments', 'New']);
});

test('an unknown screen still gets a trail of one', () => {
  assert.equal(crumbsFor('nowhere', {}, SCREENS).length, 1);
});

test('the troubleshooting assistant: context, diagnosis and plan are steps, each keeping the context (spec 9.4)', () => {
  const ctx = { mode: 'wizard', aim: 'trouble', batch: 'E3-F2', frr: '2', symptom: 'pdi', given: '1' };
  const t = crumbsFor('advisor', { ...ctx, step: 'plan' }, SCREENS);
  assert.deepEqual(labels(t), ['Plan', 'Plan an experiment', 'Questions', 'Work out what went wrong', 'Context', 'Diagnosis', 'Experiment plan']);
  assert.equal(t[4].href, '#/advisor?mode=wizard&aim=trouble&batch=E3-F2&frr=2&symptom=pdi&given=1', 'Context keeps what was typed');
  assert.equal(t[5].href, '#/advisor?mode=wizard&aim=trouble&batch=E3-F2&frr=2&symptom=pdi&given=1&step=diagnose');
  assert.equal(parentCrumb(t).href, t[5].href, 'Back without history goes from the plan to the diagnosis');
  const d = crumbsFor('advisor', { ...ctx, step: 'diagnose' }, SCREENS);
  assert.equal(d.at(-1).label, 'Diagnosis');
  assert.equal(parentCrumb(d).href, t[4].href);
  // Without a step the trail is the planner's, as before.
  assert.deepEqual(labels(crumbsFor('advisor', { mode: 'wizard', aim: 'trouble', symptom: 'pdi' }, SCREENS)).slice(-1), ['PDI too high']);
});
