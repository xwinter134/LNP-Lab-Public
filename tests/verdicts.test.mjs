import test from 'node:test';
import assert from 'node:assert/strict';
import { verdictsFor, VERDICT_LIMITS } from '../app/calc/results.js';

const by = (n, cvs) => ({ n, cv: null, ...cvs });
const cell = (cv, n = 3) => ({ n, cv, mean: 100, sd: cv });
const ref = (n, cvs) => ({ type: 'reference', stats: { byResponse: Object.fromEntries(Object.entries(cvs).map(([k, cv]) => [k, cell(cv, n)])) } });

test('a reference set: reproducible when every CV is inside its limit, not yet when one is over, no verdict under three batches', () => {
  const ok = verdictsFor(ref(3, { zave: 1.7, pdi: 11.2, ee: 1.0 }));
  assert.equal(ok[0].tone, 'ok');
  assert.match(ok[0].text, /^Reproducible: Z-ave CV 1\.7 %, PDI CV 11\.2 % and EE CV 1\.0 % over 3 batches \(limits 5 \/ 15 \/ 5 % CV, defaults\)\.$/);
  const bad = verdictsFor(ref(4, { zave: 6.2, pdi: 3, ee: 1 }));
  assert.equal(bad[0].tone, 'warn');
  assert.match(bad[0].text, /Z-ave CV 6\.2 % is above 5 %/);
  const few = verdictsFor(ref(2, { zave: 1, pdi: 1, ee: 1 }));
  assert.equal(few[0].tone, 'info');
  assert.match(few[0].text, /three batches for a verdict; 2 are measured/);
});

const lv = (text, ee, pdi) => ({ text, level: text, byResponse: { ee: { mean: ee }, pdi: { mean: pdi } } });
test('one factor at a time: the best level, and a tie is named as a tie instead of a winner', () => {
  const out = { type: 'ofat', stats: { factorName: 'N/P ratio', levels: [lv('3', 80, 0.12), lv('6', 94.2, 0.07), lv('9', 95.3, 0.064), lv('12', 95.3, 0.09)] } };
  const v = verdictsFor(out);
  assert.equal(v.length, 1);
  assert.match(v[0].text, /Best EE: N\/P ratio 9 and 12 tie at 95\.3 %/);
  assert.match(v[0].text, /lowest PDI at N\/P ratio 9 \(0\.064\)/);
  const same = { type: 'ofat', stats: { factorName: 'FRR', levels: [lv('2', 90, 0.1), lv('3', 90, 0.1)] } };
  assert.deepEqual(verdictsFor(same), [], 'the same at every level says nothing about a best');
});

const pt = (t, base, mean) => ({ t, cells: { zave: { mean } }, change: t > 0 ? { zave: { base, pct: ((mean - base) / base) * 100 } } : {} });
test('stability: the first timepoint where the size moves more than 10 % from day 0, per storage condition', () => {
  const out = { type: 'stability', stats: { series: [
    { batchId: 'E6-F1', condition: '25C', points: [pt(0, 100, 100), pt(7, 100, 105), pt(14, 100, 111.5), pt(28, 100, 120)] },
    { batchId: 'E6-F1', condition: '4C', points: [pt(0, 100, 100), pt(7, 100, 101), pt(28, 100, 103)] },
  ] } };
  const v = verdictsFor(out);
  const hot = v.find((x) => /25 °C/.test(x.text)), cold = v.find((x) => /^4 °C/.test(x.text));
  assert.equal(hot.tone, 'warn');
  assert.match(hot.text, /first moves more than 10 % from day 0 at day 14 \(100\.0 → 111\.5 nm, \+11\.5 %\)/);
  assert.equal(cold.tone, 'ok');
  assert.match(cold.text, /stays within 10 % of day 0 through day 28 \(largest change \+3\.0 %\)/);
  assert.equal(VERDICT_LIMITS.sizeDriftPct, 10);
});

test('a verdict never throws: a result with no statistics gives no lines', () => {
  assert.deepEqual(verdictsFor({ type: 'reference', stats: null }), []);
  assert.deepEqual(verdictsFor({ type: 'stability' }), []);
  assert.deepEqual(verdictsFor({ type: 'doe' }), []);
});
