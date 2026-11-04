// One CSV cell for every export (app/calc/csv.js): quoted where it must be, and never a live formula.
import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, csvLine } from '../app/calc/csv.js';
import { toCsv } from '../app/calc/facets.js';

test('text that would run as a formula in a spreadsheet is written as text', () => {
  assert.equal(csvCell('=HYPERLINK("https://x.example","click")'), `"'=HYPERLINK(""https://x.example"",""click"")"`);
  assert.equal(csvCell('+cmd|"/c calc"!A1'), `"'+cmd|""/c calc""!A1"`);
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('@SUM(A1:A3)'), "'@SUM(A1:A3)");
});

test('numbers, dates and ordinary text are left as they are', () => {
  for (const v of [-35, '-35', '-0.12', '+1.5e3', 0, '0.088', '2026-10-31', 'E3-F2_final', 'PDI', '']) assert.equal(csvCell(v), String(v));
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
});

test('a separator, a quote or a line break is quoted', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('a\tb'), '"a\tb"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvLine(['x', 1, '=1+1']), "x,1,'=1+1");
});

test('the Data export goes through it', () => {
  const out = toCsv([{ s: '=1+1' }], [{ label: 'Sample', get: (r) => r.s }]);
  assert.equal(out, "Sample\n'=1+1");
});
