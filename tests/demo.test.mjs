// Demo mode: a lab that is complete, reproducible, and strictly beside your own data.
import test from 'node:test';
import assert from 'node:assert/strict';

// The store is localStorage; node has none, so give it one before the modules that use it load.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  get length() { return mem.size; },
  key: (i) => [...mem.keys()][i],
};
const { Store } = await import('../app/store.js');
const { seedDemo, truth, driftPerDay, rng, DEMO_NS, demoSeeded } = await import('../app/demo.js');
const { responsesForBatch } = await import('../app/calc/doe.js');
const { batchDrift, pickCondition } = await import('../app/calc/stability.js');

const fresh = () => { mem.clear(); const s = new Store(DEMO_NS); seedDemo(s); return s; };

test('the demo lab is a lab: every experiment has batches, and the finished ones have results', () => {
  const s = fresh();
  assert.ok(demoSeeded(s));
  const exps = s.all('experiments');
  assert.equal(exps.length, 7);
  assert.deepEqual([...new Set(exps.map((e) => e.type))].sort(),
    ['doe', 'ofat', 'reference', 'single', 'stability'], 'one of every kind the screens can show');
  assert.ok(s.count('batches') > 30, 'enough batches for the optimiser to have a history');

  for (const e of exps.filter((x) => x.status === 'done')) {
    const open = e.expected.filter((x) => x.status !== 'done');
    assert.equal(open.length, 0, `${e.id} has ${open.length} measurements still open while calling itself done`);
    assert.ok(e.expected.every((x) => x.measurementId), `${e.id} has a closed slot with no measurement behind it`);
  }
  const planned = exps.find((e) => e.status === 'planned');
  assert.ok(planned, 'one experiment is left unmeasured, or the screens that show open work show nothing');
  assert.ok(planned.expected.every((x) => x.status === 'open'));
});

test('every run of every design has the responses the design asked for', () => {
  const s = fresh();
  const ms = s.all('measurements');
  for (const e of s.all('experiments').filter((x) => x.type === 'doe')) {
    for (const run of e.design.doe.runs) {
      const { values } = responsesForBatch(ms, run.batchId);
      for (const r of e.design.doe.spec.responses) {
        assert.ok(Number.isFinite(values[r.name]), `${e.id} ${run.run_id} has no ${r.name}`);
      }
    }
  }
});

test('the invented world has the relationships the demo claims it has', () => {
  const plan = (o) => ({ mixing: { frr: 3, totalFlow: 112.5, ...o.mixing }, rna: { np: 6, ...o.rna },
    compositionOverride: { peg_pct: 1.5, ionizable_pct: 47.5, ...o.compositionOverride } });
  const size = (o) => truth(plan(o)).size;
  assert.ok(size({ mixing: { frr: 4 } }) < size({ mixing: { frr: 2 } }), 'more aqueous, smaller particle');
  assert.ok(size({ mixing: { totalFlow: 120 } }) < size({ mixing: { totalFlow: 60 } }), 'faster mixing, smaller particle');
  assert.ok(size({ compositionOverride: { peg_pct: 2.5 } }) < size({ compositionOverride: { peg_pct: 1 } }), 'more PEG, smaller particle');

  const ee = (ion) => truth(plan({ compositionOverride: { ionizable_pct: ion } })).ee;
  assert.ok(ee(55) > ee(47.5) && ee(47.5) > ee(40), 'encapsulation rises with ionizable content');
  assert.ok(Math.abs(ee(47.5) - 93) < 2, `the default composition should encapsulate like a real one, got ${ee(47.5).toFixed(1)}`);
  assert.ok(ee(55) - ee(50) < ee(45) - ee(40), 'and flattens out at the top, which is why it is a titration curve');

  const pdi = (tfr) => truth(plan({ mixing: { totalFlow: tfr } })).pdi;
  assert.ok(pdi(100) < pdi(60) && pdi(100) < pdi(140), 'dispersity is worst at both ends of the flow range');

  // storage: a warm shelf drifts, a cold one barely, and PEG slows both
  assert.ok(driftPerDay(plan({}), '25C') > driftPerDay(plan({}), '4C') * 2);
  assert.ok(driftPerDay(plan({ compositionOverride: { peg_pct: 1 } }), '25C') > driftPerDay(plan({ compositionOverride: { peg_pct: 2.5 } }), '25C'));
});

test('the same seed gives the same lab, or a demo is not something you can discuss', () => {
  const a = fresh().all('measurements').map((m) => m.values.zave_nm ?? m.values.ee_pct);
  const b = fresh().all('measurements').map((m) => m.values.zave_nm ?? m.values.ee_pct);
  assert.deepEqual(a, b);
  const r1 = rng(1), r2 = rng(1);
  assert.equal(r1(), r2());
  assert.notEqual(rng(1)(), rng(2)());
});

test('the demo writes only into its own namespace', () => {
  mem.clear();
  const real = new Store('lnp-lab');
  real.put('experiments', { id: 'E1', type: 'single', name: 'mine', expected: [], batchIds: [] });
  seedDemo(new Store(DEMO_NS));
  assert.equal(real.count('experiments'), 1, 'the real store still has exactly what was put in it');
  assert.equal(real.get('experiments', 'E1').name, 'mine');
  assert.ok([...mem.keys()].filter((k) => k.startsWith('lnp-demo.')).length >= 4, 'and the demo store has the lab');
});

test('a batch on two shelves gets one drift rate, from the shelf that is the question', () => {
  const s = fresh();
  const ms = s.all('measurements');
  const stab = s.all('experiments').find((e) => e.type === 'stability');
  const batchId = stab.batchIds[0];
  const conds = [...new Set(ms.filter((m) => m.batchId === batchId && m.test === 'dls').map((m) => m.condition))];
  assert.deepEqual(conds.sort(), ['25C', '4C'], 'the demo really does store it on two shelves');

  const d = batchDrift(ms, batchId);
  assert.equal(d.condition, '25C', 'the accelerated shelf is the one a single number should describe');
  assert.equal(d.n, 5, 'and it is fitted on that shelf only, not on both at once');
  const cold = batchDrift(ms, batchId, 'auto', { condition: '4C' });
  assert.ok(cold.value < d.value, 'the cold shelf drifts less, which is the whole point of the study');

  assert.equal(pickCondition([{ condition: '4C' }, { condition: '4C' }]), null, 'one shelf, nothing to choose');
  assert.equal(pickCondition([{ condition: '5C' }, { condition: '37C' }]), '37C');
  assert.equal(pickCondition([{ condition: 'dark' }, { condition: 'light' }, { condition: 'light' }]), 'light',
    'with no temperature to go on, the better covered condition wins');
});

test('the demo has one siRNA experiment, its RNA lots and the buffer lots its processes name', () => {
  const s = fresh();
  const e7 = s.get('experiments', 'E7');
  assert.equal(e7.spec.cargo, 'siRNA');
  const b = s.all('batches').filter((x) => x.experimentId === 'E7');
  assert.ok(b.length && b.every((x) => x.plan.rna.cargo === 'siRNA' && x.plan.rna.lotId === 'siRNA-TTR-001'));
  assert.ok(s.all('batches').filter((x) => x.experimentId !== 'E7').every((x) => x.plan.rna.cargo === 'mRNA'), 'every measured experiment stays mRNA');
  assert.deepEqual(s.all('rnaLots').map((r) => r.cargo).sort(), ['mRNA', 'siRNA']);
  const names = s.all('buffers').map((x) => x.name);
  for (const p of s.all('batches').map((x) => x.plan.process).filter(Boolean)) {
    for (const ph of [p.aqueous, p.quenchBuffer, ...(p.downstream || [])]) assert.ok(names.includes(ph.buffer), `no lot of ${ph.buffer} in the demo`);
  }
});
