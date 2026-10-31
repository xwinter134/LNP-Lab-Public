// The data overview's engine (spec 5): rows, shop-style facet counts, the URL filter, completeness, and speed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataRows, facetDefs, applyFilter, readFilter, writeFilter, filterQuery, parseFilterQuery, summary, completeness, histogram, perMonth, tally, describeFilter, columnDefs, sortRows, toCsv, median } from '../app/calc/facets.js';
import { xlsxBytes, crc32 } from '../app/calc/xlsx.js';

const lipidByKey = { ALC315: { name: 'ALC-0315', class: 'ionizable' }, MC3: { name: 'DLin-MC3-DMA', class: 'ionizable' }, DSPC: { name: 'DSPC', class: 'helper' }, Chol: { name: 'Cholesterol', class: 'sterol' }, DMG0PEG2000: { name: 'DMG-PEG2000', class: 'peg' } };
const compositionById = {
  1: { id: 1, mol_pct: { MC3: 50, DSPC: 10, Chol: 38.5, DMG0PEG2000: 1.5 } },
  2: { id: 2, mol_pct: { ALC315: 46.3, DSPC: 9.4, Chol: 42.7, DMG0PEG2000: 1.6 } },
  3: { id: 3, mol_pct: { ALC315: 50, DSPC: 10, Chol: 40 } },
};
const ref = { lipidByKey, compositionById };
const b = (id, comp, proc = {}, extra = {}) => ({ id, experimentId: id.split('-')[0], compositionId: comp, plannedDate: extra.date || '2026-03-01', plan: { mixing: { frr: 3, totalFlow: 12 }, rna: { np: 6 }, conditions: proc }, provenance: extra.prov });
const src = {
  experiments: [{ id: 'E1', name: 'FRR screen' }, { id: 'E2', name: 'Buffers' }],
  batches: [
    b('E1-F1', 2, { bufferSystem: 'Citrate', loadingPH: 4, mixerType: 'Microfluidic chip' }),
    b('E1-F2', 2, { bufferSystem: 'Citrate', loadingPH: 4, mixerType: 'T-mixer' }),
    b('E2-F1', 1, { bufferSystem: 'Acetate', loadingPH: 5, mixerType: 'T-mixer' }, { date: '2026-05-10', prov: { source: 'restore', importId: 'imp-1' } }),
    b('E2-F2', 3, { bufferSystem: 'Citrate', loadingPH: 4.2 }, { date: '2026-05-11' }),
  ],
  measurements: [
    { batchId: 'E1-F1', test: 'dls', stage: 'final', values: { zave_nm: 80, pdi: 0.1 }, operator: 'GoHa' },
    { batchId: 'E1-F1', test: 'ee', stage: 'final', values: { ee_pct: 95 } },
    { batchId: 'E1-F2', test: 'dls', stage: 'final', values: { zave_nm: 100, pdi: 0.2 } },
    { batchId: 'E1-F2', test: 'dls', stage: 'final', timepoint: 28, condition: '4C', values: { zave_nm: 140, pdi: 0.3 } },
    { batchId: 'E2-F1', test: 'dls', stage: 'final', values: { zave_nm: 70, pdi: 0.15 } },
  ],
};
const rows = dataRows(src, ref);
const defs = facetDefs(ref);

test('a row per formulation, with the lipids by class, PEG-free, the process and the final results', () => {
  assert.equal(rows.length, 4);
  const r = rows.find((x) => x.id === 'E1-F2');
  assert.deepEqual(r.ionizable, ['ALC315']);
  assert.equal(r.size, 100, 'the stability pull is not the final size');
  assert.ok(r.has.stability && r.has.dls && !r.has.ee);
  assert.equal(rows.find((x) => x.id === 'E2-F2').pegFree, true);
  assert.equal(rows.find((x) => x.id === 'E2-F1').importId, 'imp-1');
  assert.deepEqual(rows.find((x) => x.id === 'E1-F1').operators, ['GoHa']);
});

test('"all formulations with ALC-0315", "citrate pH 4", "PEG-free" in one click each', () => {
  assert.deepEqual(applyFilter(rows, { ionizable: ['ALC315'] }, defs).rows.map((r) => r.id), ['E1-F1', 'E1-F2', 'E2-F2']);
  assert.deepEqual(applyFilter(rows, { bufferSystem: ['Citrate'], loadingPH: [4, 4] }, defs).rows.map((r) => r.id), ['E1-F1', 'E1-F2']);
  assert.deepEqual(applyFilter(rows, { peg: ['__pegfree'] }, defs).rows.map((r) => r.id), ['E2-F2']);
  assert.deepEqual(applyFilter(rows, { has: ['dls', 'ee'] }, defs).rows.map((r) => r.id), ['E1-F1'], '"has" means all ticked');
  assert.deepEqual(applyFilter(rows, { missing: 'mixerType' }, defs).rows.map((r) => r.id), ['E2-F2']);
});

test('counts are shop-style: a facet counts what changing it would give, with the other filters applied', () => {
  const { counts } = applyFilter(rows, { ionizable: ['ALC315'], bufferSystem: ['Citrate'] }, defs);
  assert.equal(counts.ionizable.get('ALC315'), 3);
  assert.equal(counts.ionizable.get('MC3') ?? 0, 0, 'MC3 is acetate here, so with citrate it would add none');
  assert.equal(counts.bufferSystem.get('Citrate'), 3);
  assert.equal(counts.bufferSystem.get('Acetate') ?? 0, 0);
  const all = applyFilter(rows, { mixerType: ['T-mixer'] }, defs).counts;
  assert.equal(all.mixerType.get('Microfluidic chip'), 1, 'the other mixer still shows what it would add');
});

test('the filter lives in the URL and reads back the same; a saved view is that query', () => {
  const f = { ionizable: ['ALC315', 'MC3'], loadingPH: [3.8, null], date: ['2026-01-01', '2026-06-30'], q: 'screen', missing: 'ee' };
  assert.deepEqual(readFilter(writeFilter(f, defs), defs), f);
  assert.deepEqual(parseFilterQuery(filterQuery(f, defs), defs), f);
  assert.equal(writeFilter(f, defs).ionizable, 'ALC315|MC3');
  assert.equal(writeFilter(f, defs).loadingPH, '3.8~');
});

test('summary, completeness, distributions and the sentence the optimizer is handed', () => {
  const s = summary(rows);
  assert.deepEqual([s.formulations, s.experiments, s.from, s.to], [4, 2, '2026-03-01', '2026-05-11']);
  assert.equal(s.size, 80);
  assert.equal(median([3, 1, 2, 10]), 2.5);
  const c = Object.fromEntries(completeness(rows).map((x) => [x.key, x]));
  assert.equal(c.frr.level, 'good');
  assert.equal(c.mixerType.share, 0.75); assert.equal(c.mixerType.level, 'warn');
  assert.equal(c.ee.level, 'bad');
  assert.equal(histogram([1, 2, 3, 4], { bins: 2 }).map((h) => h.n).join(), '2,2');
  assert.deepEqual(perMonth(rows).map((m) => m.n), [2, 0, 2], 'empty months are shown');
  assert.equal(tally(rows, (r) => r.ionizable)[0].value, 'ALC315');
  assert.equal(describeFilter({ ionizable: ['ALC315'], mixerType: ['Microfluidic chip'], bufferSystem: ['Citrate'] }, defs, 412), 'ALC-0315, Citrate, Microfluidic chip, 412 formulations');
});

test('the table sorts with missing values last, and exports to CSV and to an xlsx a zip reader opens', () => {
  const cols = columnDefs(ref), size = cols.find((c) => c.key === 'size');
  assert.deepEqual(sortRows(rows, size, 1).map((r) => r.id), ['E2-F1', 'E1-F1', 'E1-F2', 'E2-F2']);
  assert.deepEqual(sortRows(rows, size, -1).map((r) => r.id), ['E1-F2', 'E1-F1', 'E2-F1', 'E2-F2']);
  const csv = toCsv(rows, cols);
  assert.match(csv.split('\n')[0], /^Formulation,Experiment,Date,Ionizable lipid/);
  assert.match(csv, /Imported from tables,imp-1/);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'CRC-32 check value');
  const bytes = xlsxBytes(cols.map((c) => c.label), rows.map((r) => cols.map((c) => c.get(r))));
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-')), f = join(dir, 'd.xlsx');
  writeFileSync(f, bytes);
  const list = execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; s=z.read("xl/worksheets/sheet1.xml").decode(); print(len(z.namelist()), "E1-F1" in s, "<v>80</v>" in s)', f]).toString().trim();
  assert.equal(list, '5 True True');
});

test('10,000 formulations filter in under 200 ms, counts included', () => {
  const lip = ['ALC315', 'MC3'], buf = ['Citrate', 'Acetate', 'Malate', 'Phosphate'], mix = ['T-mixer', 'Microfluidic chip', 'Impinging jet'];
  const big = { experiments: [], measurements: [], batches: [] };
  for (let i = 0; i < 10000; i++) {
    const id = `E${1 + (i >> 4)}-F${1 + (i % 16)}`;
    big.batches.push(b(id, 1 + (i % 3), { bufferSystem: buf[i % 4], loadingPH: 3.5 + (i % 30) / 10, mixerType: mix[i % 3], rnaType: 'mRNA' }, { date: `202${4 + (i % 3)}-${String(1 + (i % 12)).padStart(2, '0')}-15` }));
    big.measurements.push({ batchId: id, test: 'dls', stage: 'final', values: { zave_nm: 60 + (i % 80), pdi: (i % 30) / 100 } });
  }
  const t0 = performance.now();
  const many = dataRows(big, ref);
  const built = performance.now() - t0;
  const filters = [{ ionizable: ['ALC315'] }, { ionizable: ['ALC315'], bufferSystem: ['Citrate'], loadingPH: [3.8, 4.2] }, { peg: ['__pegfree'], mixerType: ['Microfluidic chip'], date: ['2025-01-01', '2025-12-31'] }, { size: [70, 90], pdi: [null, 0.2] }];
  let worst = 0, n = 0;
  for (const f of filters) { const t = performance.now(); n = applyFilter(many, f, defs).rows.length; worst = Math.max(worst, performance.now() - t); }
  assert.equal(many.length, 10000);
  assert.ok(worst < 200, `the slowest filter took ${worst.toFixed(0)} ms`);
  assert.ok(built < 2000, `building the rows took ${built.toFixed(0)} ms`);
  assert.ok(n > 0);
  console.log(`# 10,000 formulations: rows built in ${built.toFixed(0)} ms, slowest filter ${worst.toFixed(1)} ms`);
});
