import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, detectColumns, extractDLS, extractSamples, matchSample, detectInstrument, eeFromRiboGreen, concFactor, runBase, runSamples } from '../app/calc/parsers.js';
import { readFileSync } from 'node:fs';

const csv = `Sample Name,Measurement Date and Time,T (°C),Z-Average (d.nm),PdI,Derived Count Rate (kcps),Attenuator
S-001_F1_4C_T09 1,2026-10-29 14:02,25,82.4,0.08,312,7
S-001_F1_4C_T09 2,2026-10-29 14:05,25,83.1,0.09,308,7
S-001_F1_4C_T09 3,2026-10-29 14:08,25,82.9,0.08,315,7
LNP_03_final,2026-10-29 14:20,25,96.1,0.12,288,7
Blank PBS,2026-10-29 14:30,25,,,"12",11`;

test('CSV parsing, column detection and triplicate averaging', () => {
  const p = parseCSV(csv);
  assert.equal(p.delimiter, ',');
  const cols = detectColumns(p.headers);
  assert.equal(cols.zave_nm, 'Z-Average (d.nm)'); assert.equal(cols.pdi, 'PdI'); assert.equal(cols.countRate_kcps, 'Derived Count Rate (kcps)');
  assert.equal(detectInstrument(p.headers), 'dls');
  // The runs of a sample the app expects are grouped under its name (an older scheme's name, here).
  const s = extractDLS(p, null, { expected: ['S-001_F1_4C_T09', 'LNP_03_final'] });
  const a = s.find((x) => x.sampleName === 'S-001_F1_4C_T09');
  assert.equal(a.n, 3);
  assert.ok(Math.abs(a.zave_nm - 82.8) < 1e-9);
  assert.ok(Math.abs(a.pdi - 0.0833333) < 1e-6);
  assert.equal(s.find((x) => x.sampleName === 'LNP_03_final').n, 1);
});

test('semicolon + decimal comma exports are read correctly', () => {
  const p = parseCSV('Sample Name;Z-Average (d.nm);PdI\nE1-F1_final 1;82,4;0,08\nE1-F1_final 2;83,0;0,09');
  assert.equal(p.decimalComma, true);
  const s = extractDLS(p);
  assert.ok(Math.abs(s[0].zave_nm - 82.7) < 1e-9);
});

test('sample matching: exact slot, parsed name, batch id fallback', () => {
  const experiments = [{ id: 'S-001', expected: [
    { id: 'a', sampleName: 'S-001_F1_4C_T09', formulation: 'F1', condition: '4C', timepoint: 9, test: 'dls', batchId: 'LNP_01', status: 'open', stage: 'T9' },
    { id: 'b', sampleName: 'LNP_03_final', test: 'dls', batchId: 'LNP_03', status: 'open', stage: 'final' },
    { id: 'c', sampleName: 'LNP_03_final', test: 'ee', batchId: 'LNP_03', status: 'open', stage: 'final' }] }];
  const batches = [{ id: 'LNP_01', experimentId: 'S-001' }, { id: 'LNP_03', experimentId: 'S-001' }];
  assert.equal(matchSample('S-001_F1_4C_T09', { experiments, batches }).confidence, 'exact');
  assert.equal(matchSample('s-001_f1_4c_t09', { experiments, batches }).slot.id, 'a');
  assert.equal(matchSample('LNP_03 PBS 1:40', { experiments, batches }).slot.id, 'b');
  assert.equal(matchSample('LNP_03 PBS', { experiments, batches }, 'ee').slot.id, 'c');
  assert.equal(matchSample('Blank PBS', { experiments, batches }), null);
  // The fallback used to match a hard-coded LNP<n>d<n> pattern, so it broke on any other numbering and on a
  // renamed prefix. It now asks which known batch appears in the name.
  const custom = [{ id: 'MYLAB_07', experimentId: 'S-001' }];
  const customExp = [{ id: 'S-001', expected: [{ id: 'z', sampleName: 'MYLAB_07_final', test: 'dls', batchId: 'MYLAB_07', status: 'open', stage: 'final' }] }];
  assert.equal(matchSample('MYLAB_07 dilution 1:40', { experiments: customExp, batches: custom }).slot.id, 'z');
  // and a longer id must not be claimed by the shorter one it starts with
  const near = [{ id: 'LNP_10', experimentId: 'S-001' }, { id: 'LNP_100', experimentId: 'S-001' }];
  const nearExp = [{ id: 'S-001', expected: [{ id: 'q', sampleName: 'LNP_100_final', test: 'dls', batchId: 'LNP_100', status: 'open', stage: 'final' }] }];
  assert.equal(matchSample('LNP_100 sample', { experiments: nearExp, batches: near }).batchId, 'LNP_100');
});

test('RiboGreen tables: EE, total and free RNA, RNA content are recognised by their column names', () => {
  for (const h of ['EE', 'EE (%)', 'Encapsulation', '% encapsulated', 'encapsulation efficiency']) {
    assert.equal(detectColumns(['Sample Name', h]).ee_pct, h, h);
    assert.equal(detectInstrument(['Sample Name', h]), 'ee', h);
  }
  assert.equal(detectInstrument(['Sample', 'Total RNA (µg/mL)', 'Free RNA (µg/mL)']), 'ee');
  for (const h of ['RNA (mg/mL)', 'Concentration', 'RNA content']) {
    assert.equal(detectColumns(['Sample Name', h]).rna_mg_mL, h, h);
    assert.equal(detectInstrument(['Sample Name', h]), 'content', h);
  }
  // DLS and zeta tables are still what they were, and a header merely containing "ee" is not an EE column.
  assert.equal(detectInstrument(['Sample Name', 'Z-Average (d.nm)', 'PdI', 'Speed']), 'dls');
  assert.equal(detectInstrument(['Sample Name', 'Zeta Potential (mV)', 'Conductivity (mS/cm)']), 'zeta');
  assert.equal(detectInstrument(['Sample Name', 'Speed', 'Degree']), 'unknown');
});

test('EE paste: replicates grouped by sample name and averaged, replicates kept', () => {
  const p = parseCSV('Sample Name\tEE (%)\nE2-F1_final 1\t93.0\nE2-F1_final 2\t94,0\nE2-F2_final\t88.5');
  const s = extractSamples(p, 'ee');
  const a = s.find((x) => x.sampleName === 'E2-F1_final');
  assert.equal(a.n, 2);
  assert.ok(Math.abs(a.ee_pct - 93.5) < 1e-9);
  assert.deepEqual(a.runs.map((r) => r.ee_pct), [93, 94]);
  assert.equal(s.find((x) => x.sampleName === 'E2-F2_final').ee_pct, 88.5);
});

test('EE worked out from total and free RNA, with µg/mL converted to mg/mL', () => {
  const p = parseCSV('Sample,Total RNA (µg/mL),Free RNA (µg/mL)\nE1-F1_4C_T07 1,50,2\nE1-F1_4C_T07 2,48,2.4\nE1-F2_4C_T07,n/a,1');
  const s = extractSamples(p, 'ee');
  const a = s.find((x) => x.sampleName === 'E1-F1_4C_T07');
  assert.ok(Math.abs(a.runs[0].ee_pct - 96) < 1e-9); // (1 − 2/50) × 100, per replicate
  assert.ok(Math.abs(a.ee_pct - 95.5) < 1e-9); // then averaged
  assert.ok(Math.abs(a.total_mg_mL - 0.049) < 1e-12);
  // An unreadable well is no reading, not a zero that turns into an EE of 100 % or -Infinity.
  const b = s.find((x) => x.sampleName === 'E1-F2_4C_T07');
  assert.equal(b.total_mg_mL, null);
  assert.equal(b.ee_pct, null);
  assert.equal(eeFromRiboGreen(0.05, 0.002), 96);
  assert.equal(eeFromRiboGreen(0, 0.002), null);
  assert.equal(eeFromRiboGreen(0.05, null), null);
  // An EE column, when there is one, is what was measured.
  const q = extractSamples(parseCSV('Sample Name,Total RNA (mg/mL),Free RNA (mg/mL),EE (%)\nA,0.05,0.002,95.1'), 'ee');
  assert.equal(q[0].ee_pct, 95.1);
  assert.throws(() => extractSamples(parseCSV('Sample Name,Z-Average (d.nm),PdI\nA,80,0.1'), 'ee'), /No EE column/);
});

test('RNA content: mg/mL as given, µg/mL and ng/µL converted, RiboGreen total used when it is all there is', () => {
  assert.equal(concFactor('RNA (mg/mL)'), 1);
  assert.equal(concFactor('RNA (µg/mL)'), 1e-3);
  assert.equal(concFactor('RNA (ug/ml)'), 1e-3);
  assert.equal(concFactor('Total RNA (ng/µL)'), 1e-3);
  assert.equal(concFactor('Concentration'), 1);
  const s = extractSamples(parseCSV('Sample Name;RNA (µg/mL)\nA;101,5\nA;99,5'), 'content');
  assert.ok(Math.abs(s[0].rna_mg_mL - 0.1005) < 1e-12);
  assert.equal(s[0].n, 2);
  const t = extractSamples(parseCSV('Sample Name,Total RNA (mg/mL)\nB,0.098'), 'content');
  assert.equal(t[0].rna_mg_mL, 0.098);
});

test('a stability timepoint is not a run index: E6-F1_4C_T09 keeps its 09', () => {
  // Stripping any trailing digits read "T09" as run 9 of "E6-F1_4C_T", so every timepoint of a formulation
  // became one sample and was filed under whichever slot of that batch happened to be open first.
  assert.equal(runBase('E6-F1_4C_T09'), 'E6-F1_4C_T09');
  assert.equal(runBase('E6-F1_25C_T00'), 'E6-F1_25C_T00');
  assert.equal(runBase('E6-F1_4C_T09 1'), 'E6-F1_4C_T09');
  assert.equal(runBase('E6-F1_4C_T09_2'), 'E6-F1_4C_T09');
  assert.equal(runBase('E3-F2_final (3)'), 'E3-F2_final');
  assert.equal(runBase('S-001'), 'S-001');
  const s = extractDLS(parseCSV('Sample Name,Z-Average (d.nm),PdI\nE6-F1_4C_T00,80,0.1\nE6-F1_25C_T00,82,0.1\nE6-F1_4C_T07,81,0.1'));
  assert.deepEqual(s.map((x) => x.sampleName), ['E6-F1_4C_T00', 'E6-F1_25C_T00', 'E6-F1_4C_T07']);
});

test('extractSamples reads DLS and zeta exactly as extractDLS does', () => {
  const p = parseCSV(csv);
  assert.deepEqual(extractSamples(p, 'dls'), extractDLS(p));
  assert.deepEqual(extractSamples(p, 'zeta'), extractDLS(p));
});

test('the blank sheet filled with zeta alone reads as zeta, not as an empty DLS table', async () => {
  const { parseCSV, detectInstrument } = await import('../app/calc/parsers.js');
  const p = parseCSV('Sample Name,Z-Average (d.nm),PdI,Zeta Potential (mV)\nE1-F1_final,,,-4.2\nE1-F2_final,,,-3.9\n');
  assert.equal(detectInstrument(p.headers, p.rows), 'zeta');
  const d = parseCSV('Sample Name,Z-Average (d.nm),PdI,Zeta Potential (mV)\nE1-F1_final,81,0.08,\n');
  assert.equal(detectInstrument(d.headers, d.rows), 'dls');
});

test('a result of a test nobody planned for that sample does not close another test\'s slot', async () => {
  const { matchSample } = await import('../app/calc/parsers.js');
  const exp = { id: 'E1', expected: [{ id: 's1', sampleName: 'E1-F1_final', test: 'dls', batchId: 'E1-F1', status: 'open' }, { id: 's2', sampleName: 'E1-F1_final', test: 'ee', batchId: 'E1-F1', status: 'open' }] };
  const m = matchSample('E1-F1_final', { experiments: [exp], batches: [{ id: 'E1-F1', experimentId: 'E1' }] }, 'content');
  assert.equal(m.slot, null);
  assert.equal(m.batchId, 'E1-F1');
  assert.equal(matchSample('E1-F1_final', { experiments: [exp], batches: [] }, 'ee').slot.id, 's2');
});

test('one sheet, several tests: every result column with numbers in it is read', async () => {
  const { parseCSV, detectTests } = await import('../app/calc/parsers.js');
  const p = parseCSV('Sample Name,Z-Average (d.nm),PdI,Zeta Potential (mV),EE (%),RNA (mg/mL)\nE1-F1_final,81,0.08,,93.4,\nE1-F2_final,84,0.11,,n/a,\n');
  // zeta and RNA were left empty, and "n/a" is not a reading: two tests in this sheet, not four
  assert.deepEqual(detectTests(p.headers, p.rows), ['dls', 'ee']);
  // without the rows, the columns alone decide
  assert.deepEqual(detectTests(p.headers), ['dls', 'zeta', 'ee', 'content']);
  // a one-test instrument export is still one test, as detectInstrument says
  for (const [h, want] of [[['Sample Name', 'Z-Average (d.nm)', 'PdI', 'Derived Count Rate (kcps)'], ['dls']], [['Sample Name', 'Zeta Potential (mV)', 'Conductivity (mS/cm)'], ['zeta']],
    [['Sample', 'Total RNA (µg/mL)', 'Free RNA (µg/mL)'], ['ee']], [['Sample Name', 'RNA (mg/mL)'], ['content']], [['Sample Name', 'Total RNA (mg/mL)'], ['content']], [['Sample Name', 'Speed'], []]]) {
    assert.deepEqual(detectTests(h), want, h.join(','));
  }
  // RiboGreen's total beside its free reading is half of an EE, not a second result
  assert.deepEqual(detectTests(['Sample', 'Total RNA (mg/mL)', 'Free RNA (mg/mL)', 'EE (%)']), ['ee']);
  // the blank sheet with only zeta filled is a zeta sheet
  const z = parseCSV('Sample Name,Z-Average (d.nm),PdI,Zeta Potential (mV)\nE1-F1_final,,,-4.2\n');
  assert.deepEqual(detectTests(z.headers, z.rows), ['zeta']);
});

test('the blank sheet carries a column for each test still due, named so the parser reads it back', async () => {
  const { blankSheet, parseCSV, detectColumns, detectTests, SHEET_COLUMNS } = await import('../app/calc/parsers.js');
  assert.equal(blankSheet(['E1-F1_final', 'E1-F2_final'], ['ee', 'dls', 'potency']), 'Sample Name,Z-Average (d.nm),PdI,EE (%)\nE1-F1_final,,,\nE1-F2_final,,,\n');
  assert.equal(blankSheet(['A'], ['zeta', 'content']).split('\n')[0], 'Sample Name,Zeta Potential (mV),RNA (mg/mL)');
  // nothing importable due: the size columns, rather than a sheet of names alone
  assert.equal(blankSheet(['A'], ['ph']).split('\n')[0], 'Sample Name,Z-Average (d.nm),PdI');
  // every header lands on the field it is meant for
  const want = { 'Z-Average (d.nm)': 'zave_nm', PdI: 'pdi', 'Zeta Potential (mV)': 'zeta_mV', 'EE (%)': 'ee_pct', 'RNA (mg/mL)': 'rna_mg_mL' };
  const all = Object.values(SHEET_COLUMNS).flat();
  const cols = detectColumns(['Sample Name', ...all]);
  for (const h of all) assert.equal(cols[want[h]], h, h);
  // filled in and read back: every test comes back
  const filled = blankSheet(['E1-F1_final'], ['dls', 'zeta', 'ee', 'content']).replace('E1-F1_final,,,,,', 'E1-F1_final,81,0.08,-3.9,93,0.1');
  const p = parseCSV(filled);
  assert.deepEqual(detectTests(p.headers, p.rows), ['dls', 'zeta', 'ee', 'content']);
});

test('extractTests: one entry per sample, each test read and averaged as a one-test import would', async () => {
  const { parseCSV, extractTests, extractSamples } = await import('../app/calc/parsers.js');
  const p = parseCSV('Sample Name,Z-Average (d.nm),PdI,EE (%)\nE2-F1_final 1,80,0.08,93\nE2-F1_final 2,82,0.10,95\nE2-F2_final,90,0.12,\n');
  const s = extractTests(p, ['dls', 'ee']);
  assert.deepEqual(s.map((x) => x.sampleName), ['E2-F1_final', 'E2-F2_final']);
  assert.equal(s[0].n, 2);
  assert.deepEqual(s[0].tests.dls, extractSamples(p, 'dls')[0]);
  assert.deepEqual(s[0].tests.ee, extractSamples(p, 'ee')[0]);
  assert.equal(s[0].tests.ee.ee_pct, 94);
  assert.equal(s[1].tests.dls.zave_nm, 90);
  assert.equal(s[1].tests.ee.ee_pct, null); // the EE cell was left empty: no reading, not zero
});

test('missingFromFile: the samples of this round the file did not bring, per test', async () => {
  const { matchSample, missingFromFile } = await import('../app/calc/parsers.js');
  const slot = (f, test, extra = {}) => ({ id: `E6-${f}_final_${test}`, batchId: `E6-${f}`, sampleName: `E6-${f}_final`, stage: 'final', test, status: 'open', dueDate: '2026-10-20', ...extra });
  const exp = { id: 'E6', expected: ['F1', 'F2', 'F3', 'F4'].flatMap((f) => [slot(f, 'dls'), slot(f, 'ee')]) };
  exp.expected.push(slot('F5', 'dls', { dueDate: '2026-11-03' })); // made next week: not missing today
  exp.expected.push(slot('F6', 'dls', { status: 'done' })); // already in
  const other = { id: 'E7', expected: [{ id: 'x', batchId: 'E7-F1', sampleName: 'E7-F1_final', stage: 'final', test: 'dls', status: 'open', dueDate: '2026-10-19' }] };
  const experiments = [exp, other];
  const batches = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'].map((f) => ({ id: `E6-${f}`, experimentId: 'E6' })).concat([{ id: 'E7-F1', experimentId: 'E7' }]);
  const row = (name, test, hasValue = true) => ({ sampleName: name, test, hasValue, match: matchSample(name, { experiments, batches }, test) });
  // DLS for F1, F2 and a mistyped F4; EE for F1 only, with F2's EE cell left empty
  const results = [row('E6-F1_final', 'dls'), row('E6-F2_final', 'dls'), row('Sample 4', 'dls'), row('E6-F1_final', 'ee'), row('E6-F2_final', 'ee', false)];
  const missing = missingFromFile(experiments, { results, tests: ['dls', 'ee'], today: '2026-10-17' });
  assert.deepEqual(missing.map((m) => [m.sampleName, m.tests]), [['E6-F2_final', ['ee']], ['E6-F3_final', ['dls', 'ee']], ['E6-F4_final', ['dls', 'ee']]]);
  assert.equal(missing[1].slots.dls.id, 'E6-F3_final_dls');
  // read for DLS alone, EE is not asked for, and an experiment the file never matched (E7) is not listed
  assert.deepEqual(missingFromFile(experiments, { results: results.filter((r) => r.test === 'dls'), tests: ['dls'], today: '2026-10-17' }).map((m) => m.sampleName), ['E6-F3_final', 'E6-F4_final']);
  // by the time F5 is due it is missing too
  assert.ok(missingFromFile(experiments, { results, tests: ['dls'], today: '2026-11-04' }).some((m) => m.sampleName === 'E6-F5_final'));
  // a file that matched nothing has nothing missing
  assert.deepEqual(missingFromFile(experiments, { results: [row('Blank PBS', 'dls')], tests: ['dls'], today: '2026-10-17' }), []);
});

test('missingFromFile: a stability pull is its own round, so later timepoints are not missing', async () => {
  const { matchSample, missingFromFile } = await import('../app/calc/parsers.js');
  const exp = { id: 'E1', expected: [] };
  for (const f of ['F1', 'F2']) for (const c of ['4C', '25C']) for (const [t, due] of [[0, '2026-10-17'], [7, '2026-10-24']]) {
    exp.expected.push({ id: `E1-${f}_T${t}_dls_${c}`, batchId: `E1-${f}`, sampleName: `E1-${f}_${c}_T${String(t).padStart(2, '0')}`, stage: `T${t}`, test: 'dls', condition: c, timepoint: t, status: 'open', dueDate: due });
  }
  const batches = [{ id: 'E1-F1', experimentId: 'E1' }, { id: 'E1-F2', experimentId: 'E1' }];
  const results = ['E1-F1_4C_T00', 'E1-F2_25C_T00'].map((n) => ({ sampleName: n, test: 'dls', hasValue: true, match: matchSample(n, { experiments: [exp], batches }, 'dls') }));
  const missing = missingFromFile([exp], { results, tests: ['dls'], today: '2026-10-30' });
  // T7 is past due by then, but it is not what this T0 file was for
  assert.deepEqual(missing.map((m) => m.sampleName), ['E1-F1_25C_T00', 'E1-F2_4C_T00']);
});

test('a trailing number is a run index only where the names say so (usability cycle 6, I4)', async () => {
  const { runSamples, keptApart } = await import('../app/calc/parsers.js');
  const read = (rows, expected) => extractDLS(parseCSV(`Sample Name,Z-Average (d.nm),PdI\n${rows}`), null, { expected }).map((s) => [s.sampleName, s.n]);
  // Three formulations, two samples, a lot number: each its own sample, never averaged into "LNP" or "Sample".
  assert.deepEqual(read('LNP-1,80,0.1\nLNP-2,120,0.2\nLNP-3,160,0.3'), [['LNP-1', 1], ['LNP-2', 1], ['LNP-3', 1]]);
  assert.deepEqual(read('Sample 6,80,0.1\nSample 9,120,0.2'), [['Sample 6', 1], ['Sample 9', 1]]);
  assert.deepEqual(read('Batch_12,80,0.1'), [['Batch_12', 1]]);
  assert.deepEqual(read('MC3_lot_2,80,0.1\nMC3_lot_3,90,0.1'), [['MC3_lot_2', 1], ['MC3_lot_3', 1]]);
  // The app's own names, with the instrument's run number after them.
  assert.deepEqual(read('E3-F2_final 1,80,0.1\nE3-F2_final 2,82,0.1\nE3-F2_final 3,84,0.1'), [['E3-F2_final', 3]]);
  assert.deepEqual(read('E3-F2_final (1),80,0.1\nE3-F2_final (2),82,0.1\nE3-F3_final,90,0.1'), [['E3-F2_final', 2], ['E3-F3_final', 1]]);
  assert.deepEqual(read('E6-F1_4C_T09_1,80,0.1\nE6-F1_4C_T09_2,82,0.1\nE6-F1_25C_T09 1,85,0.1'), [['E6-F1_4C_T09', 2], ['E6-F1_25C_T09', 1]]);
  // A name of the lab's own is grouped when the app expects it; one it expects as it stands stays whole.
  assert.deepEqual(read('MC3 ref 1,80,0.1\nMC3 ref 2,82,0.1', ['MC3 ref']), [['MC3 ref', 2]]);
  assert.deepEqual(read('LNP-1,80,0.1\nLNP-2,82,0.1', ['LNP', 'LNP-1', 'LNP-2']), [['LNP-1', 1], ['LNP-2', 1]]);
  assert.deepEqual(read('LNP-1,80,0.1\nLNP-2,82,0.1'), read('LNP-1,80,0.1\nLNP-2,82,0.1', ['E1-F1_final']));
  // Repeat records of one name are its runs, which is how a Zetasizer writes a vial measured three times.
  assert.deepEqual(read('MyLNP,80,0.1\nMyLNP,82,0.1\nMyLNP,84,0.1\nOther,120,0.2'), [['MyLNP', 3], ['Other', 1]]);
  // The other tests read names the same way.
  assert.deepEqual(extractSamples(parseCSV('Sample,EE (%)\nLNP-1,90\nLNP-2,60'), 'ee').map((s) => [s.sampleName, s.ee_pct]), [['LNP-1', 90], ['LNP-2', 60]]);
  assert.deepEqual(extractSamples(parseCSV('Sample,EE (%)\nE2-F1_final_1,90\nE2-F1_final_2,92'), 'ee').map((s) => [s.sampleName, s.n]), [['E2-F1_final', 2]]);
  // What the preview shows: the map itself, and the names that were kept apart although they look like runs.
  assert.deepEqual([...runSamples(['LNP-1', 'E3-F2_final 1', 'E3-F2_final 1', 'Sample 6'])], [['LNP-1', 'LNP-1'], ['E3-F2_final 1', 'E3-F2_final'], ['Sample 6', 'Sample 6']]);
  assert.deepEqual(keptApart(['LNP-1', 'LNP-2', 'LNP-3', 'Sample 6', 'E3-F2_final 1', 'E3-F2_final 2', 'Blank PBS']), [['LNP-1', 'LNP-2', 'LNP-3']]);
  assert.deepEqual(keptApart(['MC3 ref 1', 'MC3 ref 2'], ['MC3 ref']), []);
});

test('extractTests names the rows each sample was read from', async () => {
  const { extractTests } = await import('../app/calc/parsers.js');
  const p = parseCSV('Sample Name,Z-Average (d.nm),PdI,EE (%)\nE3-F2_final 1,80,0.1,\nE3-F2_final 2,82,0.1,\nE3-F2_final,,,93\nLNP-1,90,0.2,88\n');
  const s = extractTests(p, ['dls', 'ee']);
  assert.deepEqual(s.map((x) => [x.sampleName, x.names]), [['E3-F2_final', ['E3-F2_final 1', 'E3-F2_final 2', 'E3-F2_final']], ['LNP-1', ['LNP-1']]]);
});

test('the fixtures group as they did, with the expected names passed in or not', () => {
  const read = (file, test, expected) => extractSamples(parseCSV(new Uint8Array(readFileSync(new URL(`./fixtures/${file}`, import.meta.url)))), test, { expected }).map((s) => [s.sampleName, s.n]);
  const en = [['E3-F1_final', 3], ['E3-F2_final', 3], ['E3-F3_final', 3]];
  assert.deepEqual(read('zetasizer_records_en.txt', 'dls'), en);
  assert.deepEqual(read('zetasizer_records_en.txt', 'dls', ['E3-F1_final', 'E3-F2_final', 'E3-F3_final', 'E9-F1_final']), en);
  const de = [['E1-F1_final', 3], ['E1-F2_final', 3], ['E1-F3_final', 3]];
  for (const t of ['dls', 'zeta']) assert.deepEqual(read('zetasizer_de.csv', t), de, t);
  assert.deepEqual(read('ribogreen_plate.csv', 'ee'), [['E2-F1_final', 3], ['E2-F2_final', 3], ['E2-F3_final', 3]]);
  assert.deepEqual(read('results_sheet.csv', 'dls'), [['E2-F1_final', 1], ['E2-F2_final', 1], ['E2-F3_final', 1]]);
});

test('alreadyImported: the results still stored from the same file, for the tests read now (usability cycle 6, I5)', async () => {
  const { alreadyImported } = await import('../app/calc/parsers.js');
  const raw = { fileName: 'E3.csv', sha256: 'abc' };
  const records = [
    { id: 'm1', test: 'dls', raw, createdAt: '2026-10-27T14:05:00Z' },
    { id: 'm2', test: 'dls', raw, createdAt: '2026-10-27T14:05:00Z' },
    { id: 'i1', test: 'dls', raw, createdAt: '2026-10-27T14:05:00Z' }, // an inbox row
    { id: 'm3', test: 'ee', raw: { sha256: 'abc' } },
    { id: 'm4', test: 'dls', raw: { sha256: 'other' } },
    { id: 'm5', test: 'dls', raw: null },
  ];
  const imports = [{ id: 'b', sha256: 'abc', importedAt: '2026-10-28T09:00:00Z' }, { id: 'a', sha256: 'abc', importedAt: '2026-10-27T14:05:00Z' }, { id: 'c', sha256: 'zzz', importedAt: '2026-10-29T09:00:00Z' }];
  assert.deepEqual(alreadyImported('abc', { imports, records, tests: ['dls'] }), { results: 3, dates: ['2026-10-27T14:05:00Z', '2026-10-28T09:00:00Z'] });
  assert.equal(alreadyImported('abc', { imports, records, tests: ['dls', 'ee'] }).results, 4);
  // read now for a test it was never imported for, or with its results deleted since: not a repeat
  assert.equal(alreadyImported('abc', { imports, records, tests: ['zeta'] }), null);
  assert.equal(alreadyImported('zzz', { imports, records, tests: ['dls'] }), null);
  assert.equal(alreadyImported('', { imports, records }), null);
  // an import from before imports were recorded is dated by its results
  assert.deepEqual(alreadyImported('abc', { imports: [], records, tests: ['dls'] }).dates, ['2026-10-27T14:05:00Z']);
});

test('runs named with a formulation id and a word ("E7-F1 MC3 1..3") are one sample; LNP-1/LNP-2 stay apart', () => {
  const m = runSamples(['E7-F1 MC3 1', 'E7-F1 MC3 2', 'E7-F1 MC3 3', 'LNP-1', 'LNP-2']);
  assert.deepEqual(['E7-F1 MC3 1', 'E7-F1 MC3 2', 'E7-F1 MC3 3'].map((n) => m.get(n)), ['E7-F1 MC3', 'E7-F1 MC3', 'E7-F1 MC3']);
  assert.equal(m.get('LNP-1'), 'LNP-1');
  assert.equal(m.get('LNP-2'), 'LNP-2');
  // one such name alone is a sample, not a run
  assert.equal(runSamples(['E7-F1 MC3 1']).get('E7-F1 MC3 1'), 'E7-F1 MC3 1');
});
