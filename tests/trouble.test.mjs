// The troubleshooting assistant (spec 9.4): the context weighs and rules out causes, the lab's similar batches
// add their evidence, and the plan is made of experiments the existing wizard can build.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SYMPTOMS, TROUBLE, troubleSymptom, troubleCauses, weighCauses, similarBatches, compareSimilar, showsSymptom, troublePlan, planLevels, sensibleRange, readPlanParams, troubleParams, readTroubleContext, contextFromRow, classShare, CAUSE_FACTOR } from '../app/calc/advise.js';
import { FACTORS, buildExperiment } from '../app/calc/experiment.js';
import { validateSpec, RESPONSES } from '../app/calc/doe.js';
import { DEFAULT_SETTINGS } from '../app/refdata.js';
import { TOPICS } from '../app/learn/topics.js';

const qc = DEFAULT_SETTINGS.qc;
const keys = FACTORS.map((f) => f.key);

test('every symptom of the assistant has causes with a key, a check and a fix, and topics that exist', () => {
  assert.deepEqual(TROUBLE.map((t) => t.id), ['pdi', 'big', 'small', 'ee', 'drift'], 'the five the spec names');
  for (const t of TROUBLE) {
    const cs = troubleCauses(t.id);
    assert.ok(cs.length >= 4, `${t.id} has ${cs.length} causes`);
    for (const c of cs) {
      assert.ok(c.key && c.cause && c.why && c.check && c.fix, `${t.id}: incomplete cause ${c.cause}`);
      if (c.topic) assert.ok(TOPICS[c.topic], `${t.id}: topic ${c.topic} does not exist`);
      if (CAUSE_FACTOR[c.key]) assert.ok(keys.includes(CAUSE_FACTOR[c.key]), `${c.key} maps to no FACTORS key`);
    }
  }
  // Every cause of the planner's list carries a key now, and the list itself is unchanged in length.
  for (const s of SYMPTOMS) for (const c of s.causes) assert.ok(c.key, `${s.id}: ${c.cause} has no key`);
  assert.equal(troubleSymptom('repro').id, 'drift', 'an older symptom id still lands somewhere');
  assert.equal(troubleSymptom('nope'), null);
});

test('a low FRR moves the ratio up the list for a high PDI, with the reason in words', () => {
  const plain = weighCauses('pdi', {});
  const low = weighCauses('pdi', { frr: 2 });
  const rank = (list, key) => list.findIndex((c) => c.key === key);
  assert.ok(rank(low, 'frr') < rank(plain, 'frr'), 'the ratio rises in the order');
  assert.equal(low[0].key, 'frr');
  assert.equal(low[0].standing, 'likely');
  assert.match(low[0].reasons[0], /FRR 2:1 is below the usual 3:1, which fits a high PDI/);
  // Without context the planner's order stands.
  assert.deepEqual(plain.filter((c) => !c.out).slice(0, 4).map((c) => c.cause), SYMPTOMS.find((s) => s.id === 'pdi').causes.map((c) => c.cause));
});

test('what the context rules out is greyed with the reason, and goes to the end', () => {
  const w = weighCauses('big', { frr: 4, peg: 3 });
  const frr = w.find((c) => c.key === 'frr'), peg = w.find((c) => c.key === 'peg');
  assert.equal(frr.standing, 'ruled out');
  assert.match(frr.out, /FRR 4:1 is already at or above 4:1/);
  assert.match(peg.out, /PEG 3 mol% is already high/);
  assert.ok(w.slice(-2).every((c) => c.out), 'ruled-out causes come last');
  const ee = weighCauses('ee', { np: 6, ph: 4 });
  assert.ok(ee.find((c) => c.key === 'np').out);
  assert.ok(ee.find((c) => c.key === 'ph').out);
  assert.equal(ee.filter((c) => !c.out)[0].key, 'ionizable', 'what is left is in its order');
  // Small particles read the same settings the other way round.
  const small = weighCauses('small', { frr: 5, peg: 1 });
  assert.equal(small[0].key, 'frr');
  assert.ok(small.find((c) => c.key === 'peg').out);
  // A field left empty says nothing either way.
  assert.ok(weighCauses('ee', {}).every((c) => !c.out));
});

test('the mixer decides whether a TFR is slow', () => {
  const chip = weighCauses('pdi', { mixer: 'Microfluidic chip', tfr: 4 });
  assert.match(chip.find((c) => c.key === 'tfr').reasons[0], /TFR 4 mL\/min is slow for a Microfluidic chip/);
  const tee = weighCauses('pdi', { mixer: 'T-mixer', tfr: 12 });
  assert.equal(tee[0].key, 'tfr');
  assert.match(weighCauses('pdi', { mixer: 'Microfluidic chip', tfr: 12 }).find((c) => c.key === 'tfr').reasons[0], /already fast/);
});

test('similar batches of the lab: same lipid and mixer, nearby settings; their clean median becomes a reason', () => {
  const row = (id, frr, tfr, pdi, extra = {}) => ({ id, ionizable: ['MC3'], mixerType: 'T-mixer', frr, tfr, pdi, size: 90, ee: 92, ...extra });
  const rows = [row('E1-F1', 3.5, 100, 0.12), row('E1-F2', 3, 110, 0.1), row('E1-F3', 2, 100, 0.3), row('E1-F4', 3, 100, 0.11, { ionizable: ['SM102'] }),
    row('E1-F5', 2.2, 90, 0.28, { mixerType: 'Microfluidic chip' }), row('E1-F6', 5, 100, 0.1), row('E1-F7', 3, 100, null, { size: null, ee: null }), row('HERE', 2, 100, 0.3)];
  const c = { batch: 'HERE', lipid: 'MC3', mixer: 'T-mixer', frr: 2, tfr: 100 };
  const sim = similarBatches(rows, c);
  assert.deepEqual(sim.map((r) => r.id).sort(), ['E1-F1', 'E1-F2', 'E1-F3'], 'other lipid, other mixer, far FRR, no results and itself are left out');
  assert.equal(sim[0].id, 'E1-F3', 'closest first');
  const cmp = compareSimilar(sim, c, 'pdi', qc);
  assert.equal(cmp.clean, 2);
  assert.equal(cmp.withIt, 1);
  const hint = cmp.hints.find((h) => h.key === 'frr');
  assert.match(hint.text, /2 similar batches without a high PDI ran at a median FRR of 3.25, against 2 here/);
  const w = weighCauses('pdi', c, cmp);
  assert.ok(w.find((x) => x.key === 'frr').reasons.some((t) => t === hint.text));
  // One clean batch is an anecdote, not a hint.
  assert.equal(compareSimilar(sim.slice(0, 2), c, 'pdi', qc).hints.length, 0);
  assert.equal(showsSymptom({ size: 30 }, 'small', qc), true);
  assert.equal(showsSymptom({}, 'ee', qc), null);
});

test('levels step the way the fix goes, stay in the sensible range, and bracket the control at the edge', () => {
  assert.deepEqual(planLevels('frr', 2, 1), [3, 4, 5]);
  assert.deepEqual(planLevels('frr', 5, 1), [3, 4, 6], 'one step up to 6, then down');
  assert.deepEqual(planLevels('frr', 5, -1), [2, 3, 4]);
  assert.deepEqual(planLevels('peg_pct', 0.5, 1), [1, 1.5, 2]);
  assert.deepEqual(planLevels('tfr', 4, 1, 'Microfluidic chip'), [6, 9, 14]);
  assert.deepEqual(planLevels('tfr', 112.5, 1, 'T-mixer'), [33, 50, 75], 'past 150 the steps go down instead');
  for (const [f, v] of [['np', 3], ['quench', 1], ['ionizable_pct', 30], ['peg_pct', 3]]) {
    const [lo, hi] = sensibleRange(f);
    for (const x of planLevels(f, v, 1)) assert.ok(x >= lo && x <= hi, `${f} ${x} outside ${lo}–${hi}`);
  }
});

test('the plan: one factor per likely setting cause, a 2 × 2 over the two leading ones, all buildable', () => {
  const c = { symptom: 'pdi', frr: 2, tfr: 20, mixer: 'T-mixer', peg: 0.8, quench: 2, compositionId: 1 };
  const w = weighCauses('pdi', c);
  const { plans, checks } = troublePlan(w, c, FACTORS);
  const ofat = plans.filter((p) => p.kind === 'ofat');
  assert.ok(ofat.length >= 2 && ofat.length <= 3);
  assert.deepEqual(ofat.map((p) => p.factor).slice(0, 2).sort(), ['frr', 'tfr'].sort());
  const frr = ofat.find((p) => p.factor === 'frr');
  assert.deepEqual(frr.levels, [2, 3, 4, 5], 'three levels plus the batch\'s own 2:1 as control');
  assert.match(frr.title, /FRR at 3 levels, with 2:1 as control/);
  assert.ok(frr.why.some((t) => /FRR 2:1 is below the usual 3:1/.test(t)));
  assert.ok(frr.expect);
  const settings = { ...DEFAULT_SETTINGS };
  for (const p of ofat) {
    assert.ok(keys.includes(p.factor), `${p.factor} is not a FACTORS key`);
    const [lo, hi] = sensibleRange(p.factor, c.mixer);
    for (const v of p.levels) assert.ok(v >= Math.min(lo, p.control) && v <= Math.max(hi, p.control), `${p.factor} ${v}`);
    // What the wizard will read back from the address builds an experiment.
    const read = readPlanParams(p.params, keys);
    assert.equal(read.factor, p.factor);
    assert.deepEqual(read.levels, p.levels);
    const { batches } = buildExperiment({ type: 'ofat', name: read.name, startDate: '2026-11-02', compositionId: read.comp, ofat: { factor: read.factor, levels: read.levels }, frr: read.base.frr, totalFlow: read.base.tfr, quenchFactor: read.base.quench },
      { settings, experimentId: 'E9', takenFormulations: [] });
    assert.equal(batches.length, p.levels.length);
    if (p.factor === 'frr') assert.deepEqual(batches.map((b) => b.plan.mixing.frr), p.levels);
    if (p.factor !== 'tfr') assert.equal(batches[0].plan.mixing.totalFlow, 20, 'the other settings start at the batch\'s own');
  }
  const doe = plans.find((p) => p.kind === 'doe');
  assert.ok(doe, 'two setting causes lead, so a factorial over both');
  const read = readPlanParams(doe.params, keys);
  const spec = { mode: 'process', designType: doe.params.design, model: doe.params.model, centerPoints: Number(doe.params.center), replicates: 1, seed: 42,
    factors: doe.factors.map((k) => { const f = FACTORS.find((x) => x.key === k); return { name: f.doeName, unit: f.unit, low: read.ranges[k][0], high: read.ranges[k][1], applyTo: k }; }),
    responses: RESPONSES.filter((r) => r.name === 'PDI').map((r) => ({ name: r.name, goal: r.goal })) };
  assert.deepEqual(validateSpec(spec), []);
  const built = buildExperiment({ type: 'doe', name: 'x', startDate: '2026-11-02', compositionId: 1, doe: spec }, { settings, experimentId: 'E9', takenFormulations: [] });
  assert.equal(built.batches.length, doe.runs, '2 × 2 plus a centre point');
  assert.ok(checks.some((x) => x.key === 'sampleprep' || x.key === 'aggregate'), 'what is not a setting is a check');
});

test('drift with no repeats plans repeats; nothing to vary gives no factor plan', () => {
  const c = { symptom: 'drift' };
  const { plans, checks } = troublePlan(weighCauses('drift', c), c, FACTORS);
  assert.ok(plans.some((p) => p.kind === 'reference' && p.params.type === 'reference'));
  assert.ok(checks.length >= 2);
  const none = troublePlan(weighCauses('pdi', { frr: 4, peg: 3 }), { symptom: 'pdi', frr: 4, peg: 3 }, FACTORS);
  assert.ok(none.plans.every((p) => p.factor !== 'frr' && p.factor !== 'peg_pct'), 'a ruled-out cause gets no experiment');
});

test('the context goes into the address and comes back; the plan address reads back safely', () => {
  const c = { batch: 'E3-F2', lipid: 'MC3', mixer: 'T-mixer', buffer: 'Citrate', ph: 4, frr: 2, tfr: 60, peg: 1.5, np: 6, quench: 2, ionizable: 50, post: 'Dialysis', cryo: '', symptom: 'pdi' };
  const back = readTroubleContext(troubleParams(c));
  for (const k of Object.keys(c)) assert.equal(back[k], c[k] === '' ? '' : c[k], k);
  assert.equal(readTroubleContext({ frr: 'abc' }).frr, null);
  const p = readPlanParams({ factor: 'frr', levels: '2, 3,x,4', ranges: 'frr:2-4,tfr:90-60,bogus:1-2', base: 'frr:2,tfr:,zzz:3', comp: '7', name: 'n' }, keys);
  assert.deepEqual(p.levels, [2, 3, 4]);
  assert.deepEqual(p.ranges, { frr: [2, 4] }, 'a reversed range and an unknown factor are left out');
  assert.deepEqual(p.base, { frr: 2 });
  assert.equal(p.comp, 7);
  assert.equal(readPlanParams({ factor: 'nope' }, keys).factor, '');
});

test('a formulation\'s context: lipid, mixer, settings and the class shares of its composition', () => {
  const lipidByKey = { MC3: { class: 'ionizable' }, DSPC: { class: 'helper' }, Chol: { class: 'sterol' }, PEG: { class: 'peg' } };
  const comp = { id: 1, mol_pct: { MC3: 50, DSPC: 10, Chol: 38.5, PEG: 1.5 } };
  assert.equal(classShare(comp, lipidByKey, 'peg'), 1.5);
  assert.equal(classShare(null, lipidByKey, 'peg'), null);
  const c = contextFromRow({ id: 'E1-F1', ionizable: ['MC3'], mixerType: 'T-mixer', bufferSystem: 'Citrate', loadingPH: 4, frr: 3, tfr: 12, np: null, quench: 2, postMethod: 'Dialysis', compositionId: 1, pdi: 0.3 }, comp, lipidByKey);
  assert.deepEqual([c.lipid, c.mixer, c.buffer, c.ph, c.frr, c.tfr, c.peg, c.ionizable, c.post, c.pdi], ['MC3', 'T-mixer', 'Citrate', 4, 3, 12, 1.5, 50, 'Dialysis', 0.3]);
});

test('clean similar batches at the very same setting count against that setting as the cause', () => {
  const row = (id, frr) => ({ id, ionizable: ['MC3'], mixerType: 'T-mixer', frr, tfr: 60, pdi: 0.12, size: 120, ee: 92 });
  const c = { batch: 'HERE', lipid: 'MC3', mixer: 'T-mixer', frr: 2, tfr: 60 };
  const cmp = compareSimilar(similarBatches([row('A', 2), row('B', 2), row('C', 2.2)], c), c, 'pdi', qc);
  const h = cmp.hints.find((x) => x.key === 'frr');
  assert.equal(h.weight, -0.5);
  assert.match(h.text, /3 similar batches at about the same FRR \(median 2\) do not show a high PDI/);
  const plain = weighCauses('pdi', c).find((x) => x.key === 'frr');
  const weighed = weighCauses('pdi', c, cmp).find((x) => x.key === 'frr');
  assert.equal(weighed.score, plain.score - 0.5);
  assert.ok(weighed.reasons.includes(h.text));
});
