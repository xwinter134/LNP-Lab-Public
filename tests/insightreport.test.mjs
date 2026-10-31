// The report Claude writes back (spec 10.2): every finding carries its number, and every item that names
// formulations links into the Data overview showing exactly those (`#/data?ids=…`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, dataLink } from '../app/calc/insightreport.js';

const lab = { all: (c) => (c === 'batches' ? [{ id: 'E1-F1', plannedDate: '2026-01-02' }, { id: 'E1-F2' }, { id: 'E2-F1' }] : []) };

test('a finding without its value is refused; with it, it links into the Data overview', () => {
  const bad = buildReport({ findings: [{ text: 'FRR drives size', analysis: 'correlation', formulationIds: ['E1-F1'] }] }, lab);
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => /finding 1 has no value/.test(p)));
  const blank = buildReport({ findings: [{ text: 'x', analysis: 'drift', formulationIds: ['E1-F1'], value: '  ' }] }, lab);
  assert.equal(blank.ok, false, 'a blank value is no value');
  const ok = buildReport({
    findings: [{ text: 'Higher FRR, smaller particles', analysis: 'correlation', formulationIds: ['E1-F1', 'E1-F2', 'E1-F1'], value: 'r = -0.91, n = 3' }],
    openQuestions: [{ text: 'No data above FRR 5', analysis: 'coverage', formulationIds: [] }],
  }, lab, new Date('2026-10-31T10:00:00Z'));
  assert.equal(ok.ok, true, ok.problems?.join('; '));
  assert.equal(ok.record.findings[0].value, 'r = -0.91, n = 3');
  assert.equal(ok.record.findings[0].link, '#/data?ids=E1-F1,E1-F2');
  assert.equal(ok.record.openQuestions[0].link, undefined, 'an open question may name no formulation, and no value');
});

test('dataLink: each id once, in order, encoded, null for none', () => {
  assert.equal(dataLink(['E2-F1', ' E1-F1 ', 'E2-F1']), '#/data?ids=E2-F1,E1-F1');
  assert.equal(dataLink(['E 1']), '#/data?ids=E%201');
  assert.equal(dataLink([]), null);
});
