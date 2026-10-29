// The sidebar search: what a typed query finds, in which order, and what each hit opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokens, matchTier, TIER, buildIndex, search, hitHref } from '../app/calc/search.js';

test('tokens ignore case and punctuation but keep the boundary between letters and digits', () => {
  assert.deepEqual(tokens('E6-F1_4C_T07'), ['e', '6', 'f', '1', '4', 'c', 't', '07']);
  assert.deepEqual(tokens('e6f1'), ['e', '6', 'f', '1']);
  assert.deepEqual(tokens('DLin-MC3-DMA'), ['dlin', 'mc', '3', 'dma']);
  assert.deepEqual(tokens('Zürich µ-test'), ['zurich', 'μ', 'test']);
  assert.deepEqual(tokens(' -- '), []);
  assert.deepEqual(tokens(null), []);
});

test('match tiers: exact, then the start, then a later word, then inside a word', () => {
  const t = (q, k) => matchTier(tokens(q), tokens(k));
  assert.equal(t('e6f1', 'E6-F1'), TIER.exact, 'punctuation and case do not matter');
  assert.equal(t('E6 F1', 'E6-F1'), TIER.exact);
  assert.ok(t('e6f1', 'E6-F1_4C_T07') >= TIER.prefix && t('e6f1', 'E6-F1_4C_T07') < TIER.exact, 'the start of a sample name');
  assert.equal(t('e6f14', 'E6-F1_4C_T07'), 0, 'E6-F14 does not match E6-F1 at 4 °C, which plain stripping would have done');
  assert.equal(t('e6f14', 'E6-F14'), TIER.exact);
  assert.ok(t('e6f1', 'E6-F1_4C_T07') > t('e6f1', 'E6-F14_final'), 'a whole token typed beats one that is only the start of another');
  assert.equal(t('stock 1', 'Stock-001'), TIER.exact, 'numbers compare as numbers');
  assert.equal(t('t7', 'T07'), TIER.exact);
  assert.ok(t('stock-00', 'Stock-001') >= TIER.prefix, 'leading zeros on the way to a number');
  assert.ok(t('exp 3', 'Experiment 3') >= TIER.prefix, 'an earlier word may be abbreviated');
  assert.equal(t('e 3', 'Experiment 31'), TIER.prefix, 'the last number may still be being typed');
  assert.equal(t('e 31', 'Experiment 3'), 0, 'but an earlier number may not be cut short');
  assert.ok(t('f2', 'E3-F2') >= TIER.word && t('f2', 'E3-F2') < TIER.prefix, 'a later word');
  assert.equal(t('lin', 'DLin-MC3'), TIER.inside, 'inside a word');
  assert.equal(t('lin mc3', 'DLin-MC3-DMA'), TIER.inside);
  assert.equal(t('citrate buffer', 'Citrate'), 0, 'more words than the key has');
  assert.equal(t('', 'E3'), 0);
});

// A small lab: two experiments, a stability study with sample names at two shelves, a stock, a buffer, an
// RNA lot and two compositions.
const lab = {
  experiments: [
    { id: 'E3', name: 'Stability MC3 vs ref', type: 'stability', startDate: '2026-10-01', batchIds: ['E3-F1', 'E3-F2'],
      expected: [
        { id: 's1', sampleName: 'E3-F1_4C_T00', batchId: 'E3-F1', test: 'dls', status: 'done', dueDate: '2026-10-01' },
        { id: 's2', sampleName: 'E3-F1_4C_T07', batchId: 'E3-F1', test: 'dls', status: 'open', dueDate: '2026-10-08' },
        { id: 's3', sampleName: 'E3-F1_4C_T07', batchId: 'E3-F1', test: 'ee', status: 'open', dueDate: '2026-10-08' },
        { id: 's4', sampleName: 'E3-F2_25C_T07', batchId: 'E3-F2', test: 'dls', status: 'open', dueDate: '2026-10-09' },
      ] },
    { id: 'E6', name: 'CCD on FRR, flow and PEG', type: 'doe', batchIds: ['E6-F1', 'E6-F4', 'E6-F14'],
      expected: [{ id: 'x1', sampleName: 'E6-F14_final', batchId: 'E6-F14', test: 'dls', status: 'open', dueDate: '2026-10-20' }] },
  ],
  batches: [
    { id: 'E3-F1', experimentId: 'E3', label: 'MC3 reference', status: 'measured' },
    { id: 'E3-F2', experimentId: 'E3', label: 'High PEG', status: 'measured' },
    { id: 'E6-F1', experimentId: 'E6', label: 'run 1', status: 'measured' },
    { id: 'E6-F4', experimentId: 'E6', label: 'run 4', status: 'produced' },
    { id: 'E6-F14', experimentId: 'E6', label: 'run 14', status: 'planned' },
  ],
  measurements: [
    { id: 'm1', sampleName: 'E3-F1_4C_T00', batchId: 'E3-F1', test: 'dls', date: '2026-10-01', values: { zave_nm: 82.44, pdi: 0.081 } },
    { id: 'm2', sampleName: 'E6-F1_final', batchId: 'E6-F1', test: 'dls', date: '2026-10-12', values: { zave_nm: 91, pdi: 0.12 } },
    { id: 'm3', sampleName: 'E6-F1_final', batchId: 'E6-F1', test: 'ee', date: '2026-10-13', values: { ee_pct: 93 } },
  ],
  stocks: [{ id: 'Stock-001', compositionId: 1, molarity_mM: 50, date: '2026-09-30' }, { id: 'Stock-010', compositionId: 12 }],
  buffers: [{ id: 'Buffer-002', lot: 'Buffer-002', name: 'Citrate 50 mM pH 4.0', roles: ['loading'] }],
  rnaLots: [{ id: 'RNA-TEST-01', construct: 'FLuc', conc_mg_mL: 2.06 }],
  compositions: [{ id: 1, synonym: 'MC3 reference (Onpattro-like)', mol_pct: { MC3: 50, DSPC: 10 } }, { id: 12, synonym: 'High PEG' }],
};
const index = buildIndex(lab);
const ids = (q, opts) => search(index, q, opts).groups.map((g) => `${g.kind}: ${g.items.map((h) => h.id).join(' ')}`);
const first = (q) => search(index, q).groups[0]?.items[0];

test('"e6f1" finds E6-F1 first, then its samples, without dragging in E6-F14 ahead of them', () => {
  const r = search(index, 'e6f1');
  assert.equal(r.groups[0].kind, 'formulation');
  assert.deepEqual(r.groups[0].items.map((h) => h.id), ['E6-F1', 'E6-F14'], 'exact before prefix');
  const samples = r.groups.find((g) => g.kind === 'sample').items.map((h) => h.id);
  assert.deepEqual(samples, ['E6-F1_final', 'E6-F14_final']);
  assert.ok(!r.groups.some((g) => g.kind === 'experiment'), 'an experiment id is shorter than the query');
});

test('experiments by id, by "Experiment n" and by name; formulations by label', () => {
  assert.equal(first('E3').id, 'E3');
  assert.equal(first('experiment 3').id, 'E3');
  assert.equal(first('Exp 6').id, 'E6');
  assert.deepEqual(ids('stability mc3'), ['experiment: E3']);
  assert.equal(first('high peg').kind, 'formulation', 'the formulation, then the composition of the same name');
  assert.deepEqual(ids('high peg'), ['formulation: E3-F2', 'composition: 12']);
  assert.match(first('E3').sub, /stability · started 2026-10-01 · 2 formulations/);
});

test('a sample name opens its latest result when it has one, else the entry form on its earliest open slot', () => {
  const measured = first('E6-F1_final');
  assert.equal(measured.kind, 'sample');
  assert.equal(hitHref(measured), '#/measurements?id=m3');
  assert.match(measured.sub, /E6-F1 · 91\.0 nm \/ 0\.12/);
  const due = first('e3 f1 4c t7');
  assert.equal(due.id, 'E3-F1_4C_T07', 'found typed loosely, with T7 for T07');
  assert.equal(hitHref(due), '#/measurements?slot=s2');
  assert.match(due.sub, /DLS, EE due 2026-10-08/);
  const listed = search(index, 'E3-F1_4C').groups.find((g) => g.kind === 'sample').items.map((h) => h.id);
  assert.deepEqual(listed, ['E3-F1_4C_T00', 'E3-F1_4C_T07'], 'one entry per sample name, however many tests it has, in natural order');
});

test('stocks, buffers, RNA lots and compositions', () => {
  assert.equal(first('stock 1').id, 'Stock-001');
  assert.equal(hitHref(first('stock 1')), '#/stocks?id=Stock-001');
  assert.deepEqual(ids('stock'), ['stock: Stock-001 Stock-010'], 'natural order among equals');
  assert.equal(first('buffer 2').id, 'Buffer-002');
  assert.equal(first('citrate').kind, 'buffer');
  assert.equal(hitHref(first('citrate')), '#/buffers?id=Buffer-002');
  assert.equal(first('fluc').id, 'RNA-TEST-01');
  assert.equal(hitHref(first('rna-test')), '#/materials?tab=rna');
  assert.equal(first('12').kind, 'composition', 'a bare number is a composition number');
  assert.equal(first('onpattro').id, '1');
  assert.equal(hitHref(first('onpattro')), '#/materials?tab=compositions');
});

test('groups follow their best hit, and each group is capped with a count of the rest', () => {
  assert.equal(search(index, 'Stock-001').groups[0].kind, 'stock');
  const r = search(index, 'e', { perKind: 2 });
  const forms = r.groups.find((g) => g.kind === 'formulation');
  assert.equal(forms.items.length, 2);
  assert.equal(forms.more, 3);
  assert.equal(r.total, r.groups.reduce((s, g) => s + g.items.length + g.more, 0));
  assert.deepEqual(search(index, '').groups, []);
  assert.deepEqual(search(index, ' _-_ ').groups, []);
  assert.deepEqual(search(index, 'nothing like this').groups, []);
});

test('an empty or damaged store builds an empty index rather than throwing', () => {
  assert.deepEqual(buildIndex({}), []);
  assert.doesNotThrow(() => buildIndex({ experiments: [null, { name: 'no id' }, { id: 'E1', expected: [null, {}] }], batches: [{}], measurements: [{ sampleName: 'x' }, null], compositions: [{ id: null }] }));
  assert.equal(hitHref({ screen: 'experiments', params: { id: 'E1', empty: '' } }), '#/experiments?id=E1');
});
