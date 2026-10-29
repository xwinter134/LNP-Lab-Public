// The design table, its three exports, the drawing, and stability as a response.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tablePdf, tableCsv, tableTsv, pdfString, textWidth, fitText } from '../app/calc/pdf.js';
import { designTableModel, designSubtitle, num } from '../app/calc/designtable.js';
import { designSvg, designSvgFromRuns, designCaption } from '../app/ui/designviz.js';
import { dlsSeries, sizeDrift, autoBasis, batchDrift, driftNote, DRIFT_BASES } from '../app/calc/stability.js';
import { buildDesign, RESPONSES, responsesForBatch } from '../app/calc/doe.js';

const spec = (designType, factors, centerPoints = 3) => ({
  designType, model: 'interaction', centerPoints, replicates: 1, seed: 42, alpha: '',
  responses: ['particle_size_nm'],
  factors,
});
const F = [
  { name: 'Total_flow_rate', unit: 'mL/min', low: 2, center: '', high: 20 },
  { name: 'Lipid_stock', unit: 'mM', low: 10, center: '', high: 47 },
];

test('the design table is the one the user asked for: a label, then a column per factor', () => {
  const sp = spec('full_factorial', F);
  const runs = buildDesign(sp);
  const { columns, rows } = designTableModel(sp, runs);

  assert.equal(columns[0].label, 'Label');
  assert.deepEqual(columns.slice(1).map((c) => c.label), ['Total_flow_rate', 'Lipid_stock']);
  assert.deepEqual(columns.slice(1).map((c) => c.sub), ['mL/min', 'mM'], 'the unit goes on its own header line');
  assert.ok(columns.slice(1).every((c) => c.right), 'numbers are right aligned');

  // Exactly the example from the request: four corners then three centre points, in standard order.
  assert.deepEqual(rows.map((r) => r[0]), [
    'R001 (factorial)', 'R002 (factorial)', 'R003 (factorial)', 'R004 (factorial)',
    'R005 (center)', 'R006 (center)', 'R007 (center)',
  ]);
  assert.deepEqual(rows[0].slice(1), ['2', '10']);
  assert.deepEqual(rows[3].slice(1), ['20', '47']);
  assert.deepEqual(rows[4].slice(1), ['11', '28.5'], 'the centre is the midpoint, written as short as it can be');
});

test('a number keeps what it has and no more', () => {
  assert.equal(num(28.5), '28.5');
  assert.equal(num(2), '2');
  assert.equal(num(2.0001, 0.018), '2');
  assert.equal(num(0.0750001, 0.0001), '0.075');
  assert.equal(num(NaN), '');
});

test('the run order is a column in standard order and the sort key in run order', () => {
  const sp = spec('full_factorial', F, 2);
  const runs = buildDesign(sp).map((r, i) => ({ ...r, run_order: 6 - i }));
  const std = designTableModel(sp, runs, { order: 'std' });
  assert.ok(std.columns.some((c) => c.key === 'run_order'), 'standard order shows where each run falls in the sequence');
  assert.deepEqual(std.rows.map((r) => r[0].slice(0, 4)), ['R001', 'R002', 'R003', 'R004', 'R005', 'R006']);

  const byRun = designTableModel(sp, runs, { order: 'run' });
  assert.ok(!byRun.columns.some((c) => c.key === 'run_order'), 'in run order the sequence is the order itself');
  assert.deepEqual(byRun.rows.map((r) => r[0].slice(0, 4)), ['R006', 'R005', 'R004', 'R003', 'R002', 'R001']);
});

test('all three exports carry the same cells as the table', () => {
  const sp = spec('ccd_faced', F, 4);
  const runs = buildDesign(sp);
  const { columns, rows } = designTableModel(sp, runs);

  const csv = tableCsv(columns, rows).split('\n');
  const tsv = tableTsv(columns, rows).split('\n');
  assert.equal(csv.length, rows.length + 1);
  assert.equal(tsv.length, rows.length + 1);
  assert.equal(csv[0], 'Label,Total_flow_rate (mL/min),Lipid_stock (mM)', 'the unit travels with the header');
  assert.equal(tsv[1].split('\t').length, columns.length, 'a tab per column is what a spreadsheet expects');
  assert.ok(csv[1].startsWith('R001 (factorial),'), 'a plain label needs no quoting, and gets none');
  // quoting is for the values that would otherwise break a row apart
  const tricky = tableCsv([{ key: 'a', label: 'Note' }], [['holds, then grows'], ['said "fine"']]).split('\n');
  assert.equal(tricky[1], '"holds, then grows"');
  assert.equal(tricky[2], '"said ""fine"""', 'a quote inside a quoted value is doubled');

  const pdf = tablePdf({ title: 'E1 design', subtitle: designSubtitle(sp, runs, 'Central composite', '2026-10-19'), columns, rows });
  const text = Buffer.from(pdf).toString('latin1');
  assert.equal(text.slice(0, 8), '%PDF-1.4');
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.ok(/\nxref\n/.test(text), 'a cross-reference table, or no reader will open it');
  assert.ok(text.includes('(R001 \\(factorial\\))'), 'the brackets in a label are escaped, not dropped');
  // every offset in the xref must land on an object header, or the file is subtly broken
  const start = Number(/startxref\s+(\d+)/.exec(text)[1]);
  const offsets = [...text.slice(start).matchAll(/^(\d{10}) 00000 n/gm)].map((m) => Number(m[1]));
  assert.ok(offsets.length >= 5);
  for (const off of offsets) assert.match(text.slice(off, off + 12), /^\d+ 0 obj/);
});

test('a pdf string survives the characters a lab label actually contains', () => {
  assert.equal(pdfString('25 °C'), '25 \\260C');
  assert.equal(pdfString('a (b) \\ c'), 'a \\(b\\) \\\\ c');
  assert.equal(pdfString('±2 × 10'), '\\2612 \\327 10');
  assert.equal(pdfString('≤ 0.2'), '<= 0.2', 'what the font cannot show is transliterated, not silently dropped');
  // digits all share one width in Helvetica, which is what makes a column of numbers line up
  assert.equal(textWidth('11111', 10), textWidth('28500', 10));
  assert.ok(fitText('a very long factor name indeed', 40, 9).endsWith('…'));
});

test('the drawing comes from the design, not from a picture of what the design should be', () => {
  const sq = designSvg([[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]], ['factorial', 'factorial', 'factorial', 'factorial', 'center'], ['A', 'B']);
  assert.ok(sq.includes('<svg'), 'two factors draw a square');
  assert.ok(sq.includes('circle'), 'with one mark per distinct setting');

  const runs = buildDesign(spec('bbd', [...F, { name: 'NP', unit: '', low: 3, center: '', high: 9 }], 3));
  const cube = designSvgFromRuns(runs, ['Total_flow_rate', 'Lipid_stock', 'NP']);
  assert.ok(cube.includes('edge midpoint'), 'a Box-Behnken says what its points are, and it has no corners');
  assert.ok(!cube.includes('a corner of the box'), 'so the legend must not claim any');

  const pb = buildDesign(spec('plackett_burman', [...F, { name: 'C', unit: '', low: 0, center: '', high: 1 },
    { name: 'D', unit: '', low: 0, center: '', high: 1 }, { name: 'E', unit: '', low: 0, center: '', high: 1 }], 3));
  const grid = designSvgFromRuns(pb, ['Total_flow_rate', 'Lipid_stock', 'C', 'D', 'E']);
  assert.ok(grid.includes('Filled is the high setting'), 'five factors at two levels read as a grid, not as crossing lines');
  assert.ok(designCaption(5, { factorial: 8, center: 3 }, { grid: true }).includes('One row per run'));
});

test('an axis label stays inside the drawing however long the factor is called', () => {
  const long = ['residence_temperature', 'Total_flow_rate', 'buffer_molarity_mM'];
  const runs = buildDesign(spec('ccd_faced', long.map((name) => ({ name, unit: '', low: 1, center: '', high: 9 })), 2));
  const svg = designSvgFromRuns(runs, long, { size: 260 });
  const w = Number(/viewBox="0 0 ([\d.]+)/.exec(svg)[1]);
  const xs = [...svg.matchAll(/<text x="([-\d.]+)"[^>]*>([^<]*)</g)];
  assert.ok(xs.length >= 3);
  for (const [, x, text] of xs) {
    const half = text.replace(/&#\d+;|&\w+;/g, 'x').length * 3.4; // generous: the clamp uses a tighter estimate
    assert.ok(Number(x) - half > -1, `"${text}" starts off the left edge at x=${x}`);
    assert.ok(Number(x) + half < w + 1, `"${text}" runs off the right edge at x=${x} of ${w}`);
  }
});

/* ---------------- stability as a response ---------------- */

const dls = (batchId, points) => points.map(([date, nm], i) => ({
  id: `M${i}`, batchId, test: 'dls', date, stage: `T${i}`, values: { zave_nm: nm },
}));

test('size drift is a rate with a unit chosen from the timepoints', () => {
  const ms = dls('B1', [['2026-01-01', 80], ['2026-01-03', 82], ['2026-01-05', 84], ['2026-01-07', 86]]);
  const s = dlsSeries(ms, 'B1');
  assert.deepEqual(s.map((p) => p.day), [0, 2, 4, 6]);

  const d = sizeDrift(s);
  assert.ok(Math.abs(d.perDay - 1) < 1e-9, 'two nanometres every two days is one a day');
  assert.equal(d.basis, 'day', 'a week-long study is expressed per day');
  assert.equal(d.unit, 'nm/day');
  assert.ok(Math.abs(d.value - 1) < 1e-9);
  assert.ok(d.r2 > 0.999, 'a straight line is reported as one');
  assert.equal(d.spanDays, 6);

  // the same data asked for in other units
  assert.ok(Math.abs(sizeDrift(s, 'week').value - 7) < 1e-9);
  assert.ok(Math.abs(sizeDrift(s, 'window').value - 6) < 1e-9, 'six nanometres over the six days observed');
  assert.ok(sizeDrift(s, 'window').unit.includes('over 6 days'));
});

test('the basis follows the study, and a user can override it', () => {
  assert.equal(autoBasis(6), 'day');
  assert.equal(autoBasis(28), 'week');
  assert.equal(autoBasis(180), 'window');
  assert.ok(DRIFT_BASES.every((b) => b.id && b.label));
  const ms = dls('B2', [['2026-01-01', 90], ['2026-02-01', 97], ['2026-03-01', 104]]);
  const d = batchDrift(ms, 'B2');
  assert.equal(d.basis, 'week', 'two months of timepoints are a per-week story');
  assert.ok(Math.abs(d.value - 1.63) < 0.05, `about 1.6 nm a week, got ${d.value}`);
  assert.equal(batchDrift(ms, 'B2', 'day').unit, 'nm/day');
});

test('a drift that cannot be computed says so instead of returning a number', () => {
  assert.equal(sizeDrift([]), null);
  assert.equal(sizeDrift([{ day: 0, nm: 80 }]), null, 'one point is not a trend');
  assert.equal(sizeDrift([{ day: 3, nm: 80 }, { day: 3, nm: 84 }]), null, 'two readings at one timepoint are a repeat, not a trend');
  assert.ok(driftNote(null).includes('two or more timepoints'));
  const noisy = sizeDrift([{ day: 0, nm: 80 }, { day: 7, nm: 95 }, { day: 14, nm: 78 }, { day: 21, nm: 99 }]);
  assert.ok(driftNote(noisy).includes('not evidence of a trend'), 'a slope through scatter is not sold as a rate');
});

test('stability is a response the rest of the app can use', () => {
  const drift = RESPONSES.find((r) => r.name === 'size_drift');
  assert.ok(drift, 'it is in the shared response list');
  assert.equal(drift.derived, 'size_drift');
  assert.equal(drift.goal, 'target');

  const ms = [
    ...dls('B3', [['2026-01-01', 80], ['2026-01-08', 87]]),
    { id: 'E1', batchId: 'B3', test: 'ee', date: '2026-01-01', stage: 'final', values: { ee_pct: 93 } },
  ];
  const { values, sources } = responsesForBatch(ms, 'B3');
  assert.ok(Math.abs(values.size_drift - 1) < 1e-9, 'seven nanometres in seven days');
  assert.equal(values.encapsulation_efficiency, 93, 'the measured responses still come through');
  assert.equal(sources.size_drift.derived, true, 'and the derived one says it was derived');
  assert.equal(sources.size_drift.n, 2);
  assert.equal(responsesForBatch(ms, 'B3', { driftBasis: 'week' }).values.size_drift, 7);
  assert.equal(responsesForBatch([], 'B3').values.size_drift, undefined, 'no timepoints, no number');
});
