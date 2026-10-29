// Instrument exports as they come off real instruments (tests/fixtures), not as a hand-made CSV: UTF-16 and
// Windows code pages, metadata above the header, German installs, units, statistics rows, blanks and standards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeText, parseCSV, detectColumns, detectTests, detectInstrument, extractDLS, extractSamples, extractTests, matchSample, isoDateTime, dateOrder, controlKind } from '../app/calc/parsers.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} is not ${b}`);
const byName = (samples) => Object.fromEntries(samples.map((s) => [s.sampleName, s]));

test('decodeText: the byte-order mark, then NULs, then UTF-8, then Windows-1252', () => {
  const text = 'Sample Name\tTotal RNA (ng/µL)\nA\t1,5\n';
  const le = Buffer.from(text, 'utf16le'), be = Buffer.from(le).swap16();
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xFF, 0xFE]), le])), text);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xFE, 0xFF]), be])), text);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text)])), text);
  // without a BOM, the NUL in every other byte gives UTF-16 away, and its half gives the byte order
  assert.equal(decodeText(le), text);
  assert.equal(decodeText(be), text);
  // plain UTF-8, as an ArrayBuffer (what File.arrayBuffer() gives) as well as a view
  const u8 = Buffer.from(text);
  assert.equal(decodeText(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length)), text);
  // not valid UTF-8: an "ANSI" export, where µ is the one byte B5
  assert.equal(decodeText(Buffer.from(text, 'latin1')), text);
  // a string keeps its text and loses its BOM
  assert.equal(decodeText('\uFEFF' + text), text);
});

test('a UTF-16 file decoded as UTF-8 (what File.text() does) still yields its ASCII headers and numbers, and only those', () => {
  const bytes = fixture('zetasizer_records_en.txt');
  const garbled = new TextDecoder('utf-8').decode(bytes);
  assert.match(garbled, /^\uFFFD\uFFFDM\0a\0l/); // what the import used to be handed
  const p = parseCSV(garbled);
  assert.equal(detectColumns(p.headers).zave_nm, 'Z-Average (d.nm)');
  near(byName(extractDLS(p))['E3-F1_final'].zave_nm, 82.786666666666667);
  // a letter outside ASCII is gone that way, which is why the import hands over the bytes
  const de = fixture('zetasizer_de.csv');
  assert.equal(extractDLS(parseCSV(new TextDecoder('utf-8').decode(de)), 'dls')[0].attenuator, null);
  assert.equal(extractDLS(parseCSV(de), 'dls')[0].attenuator, 7);
});

test('Zetasizer records export, English install: UTF-16 LE, tabs, metadata above the header, statistics rows below', () => {
  const p = parseCSV(fixture('zetasizer_records_en.txt'));
  assert.equal(p.delimiter, '\t');
  assert.equal(p.decimalComma, false);
  // the four metadata lines and the blank line are not the header; the row with a sample name and a result is
  assert.equal(p.headerRow, 4);
  assert.match(p.metadata.join('\n'), /Zetasizer Software 7\.13[\s\S]*E3_final\.dts/);
  assert.equal(p.headers[0], 'Record Number');
  assert.ok(!p.headers.includes(''), 'the trailing tab on every line is no column');
  // Mean, Standard Deviation and RSD are not records
  assert.equal(p.summaryRows, 3);
  assert.equal(p.rows.length, 9);
  const cols = detectColumns(p.headers);
  assert.equal(cols.sampleName, 'Sample Name');
  assert.equal(cols.pdi, 'PdI', 'not "PdI Width (d.nm)"');
  assert.equal(cols.temp_c, 'T (°C)');
  assert.equal(cols.date, 'Measurement Date and Time');
  assert.deepEqual(detectTests(p.headers, p.rows), ['dls']);
  const s = extractDLS(p);
  assert.deepEqual(s.map((x) => x.sampleName), ['E3-F1_final', 'E3-F2_final', 'E3-F3_final']);
  const a = byName(s)['E3-F1_final'];
  assert.equal(a.n, 3);
  near(a.zave_nm, (82.41 + 83.07 + 82.88) / 3);
  near(a.pdi, (0.081 + 0.077 + 0.084) / 3);
  near(a.countRate_kcps, (312.4 + 309.8 + 311.1) / 3);
  assert.equal(a.temp_c, 25);
  // 10/27/2026 2:02:11 PM, read month first because of the AM/PM, stored as ISO
  assert.equal(a.date, '2026-10-27 14:02:11');
  assert.deepEqual(a.runs.map((r) => r.raw), ['E3-F1_final 1', 'E3-F1_final 2', 'E3-F1_final 3']);
});

test('Zetasizer on a German install: UTF-16, semicolons, decimal commas, German names, size and zeta records apart', () => {
  const p = parseCSV(fixture('zetasizer_de.csv'));
  assert.equal(p.delimiter, ';');
  assert.equal(p.decimalComma, true);
  assert.equal(p.headerRow, 4);
  assert.match(p.metadata[0], /Malvern Panalytical – Zetasizer/, 'the dash survives: the file was read as UTF-16');
  assert.equal(p.summaryRows, 2, 'Mittelwert and Standardabweichung');
  const cols = detectColumns(p.headers);
  assert.deepEqual([cols.sampleName, cols.zave_nm, cols.pdi, cols.zeta_mV, cols.countRate_kcps, cols.attenuator, cols.temp_c, cols.date],
    ['Probenname', 'Z-Mittelwert (d.nm)', 'PdI', 'Zetapotential (mV)', 'Abgeleitete Zählrate (kcps)', 'Abschwächer', 'Temperatur (°C)', 'Messdatum und -zeit']);
  assert.deepEqual(detectTests(p.headers, p.rows), ['dls', 'zeta']);
  // Each sample has three size records and three zeta records. Read together they were six runs, three of them
  // without a size; each test now reads its own three.
  const dls = byName(extractSamples(p, 'dls')), zeta = byName(extractSamples(p, 'zeta'));
  const f1 = dls['E1-F1_final'];
  assert.equal(f1.n, 3);
  assert.ok(f1.runs.every((r) => r.zave_nm != null && r.zeta_mV == null));
  near(f1.zave_nm, (82.41 + 83.07 + 82.88) / 3);
  near(f1.pdi, (0.081 + 0.077 + 0.084) / 3);
  assert.equal(f1.date, '2026-10-27 14:02:11');
  // "1.204,6" is twelve hundred, not 1.2046
  near(dls['E1-F2_final'].countRate_kcps, (1204.6 + 1198.3 + 1210.9) / 3);
  assert.equal(zeta['E1-F1_final'].n, 3);
  near(zeta['E1-F1_final'].zeta_mV, (-3.42 - 3.87 - 3.15) / 3);
  near(zeta['E1-F3_final'].zeta_mV, -4.19);
  assert.equal(zeta['E1-F1_final'].zave_nm, null);
  // one entry per sample with both tests, as the import shows it
  const both = extractTests(p, ['dls', 'zeta']);
  assert.deepEqual(both.map((x) => [x.sampleName, Object.keys(x.tests).join('+'), x.n]), [['E1-F1_final', 'dls+zeta', 3], ['E1-F2_final', 'dls+zeta', 3], ['E1-F3_final', 'dls+zeta', 3]]);
  // and the names match the slots they were measured for
  const exp = { id: 'E1', expected: ['F1', 'F2', 'F3'].map((f) => ({ id: `s${f}`, sampleName: `E1-${f}_final`, test: 'dls', batchId: `E1-${f}`, status: 'open', stage: 'final' })) };
  for (const x of both) assert.equal(matchSample(x.sampleName, { experiments: [exp], batches: [] }).confidence, 'exact', x.sampleName);
});

test('a spreadsheet saved as CSV: units in brackets and after a slash, blank columns, quoted commas, statistics rows', () => {
  const p = parseCSV(fixture('results_sheet.csv'));
  assert.equal(p.delimiter, ',');
  assert.deepEqual(p.headers, ['Sample', 'Size [nm]', 'PDI', 'EE / %', 'Total RNA (ng/µL)', 'Comment']);
  assert.equal(p.summaryRows, 2);
  assert.equal(p.rows[1].Comment, 'aggregates at 2 µm, filtered (0.45 µm)', 'a comma inside quotes is not a delimiter');
  const cols = detectColumns(p.headers);
  assert.deepEqual([cols.zave_nm, cols.pdi, cols.ee_pct, cols.total_mg_mL], ['Size [nm]', 'PDI', 'EE / %', 'Total RNA (ng/µL)']);
  assert.deepEqual(detectTests(p.headers, p.rows), ['dls', 'ee']);
  const s = extractTests(p, ['dls', 'ee']);
  assert.deepEqual(s.map((x) => x.sampleName), ['E2-F1_final', 'E2-F2_final', 'E2-F3_final'], 'no "Mean" or "Std Dev" sample');
  assert.equal(s[1].tests.dls.zave_nm, 88.3);
  assert.equal(s[1].tests.ee.ee_pct, 91.7);
  near(s[0].tests.ee.total_mg_mL, 0.0482, 1e-12); // ng/µL is µg/mL, stored as mg/mL
});

test('a RiboGreen plate export: Windows-1252, metadata, blanks and standards left out, EE from total and free per well', () => {
  const p = parseCSV(fixture('ribogreen_plate.csv'));
  assert.equal(p.headerRow, 8);
  assert.ok(p.headers.includes('Total RNA (ng/µL)'), 'µ read from the code page');
  const cols = detectColumns(p.headers);
  assert.equal(cols.sampleName, 'Sample', 'the Sample column, not the Well');
  assert.deepEqual([cols.total_mg_mL, cols.free_mg_mL], ['Total RNA (ng/µL)', 'Free RNA (ng/µL)'], 'not the raw fluorescence beside them');
  assert.equal(detectInstrument(p.headers, p.rows), 'ee');
  assert.deepEqual(detectTests(p.headers, p.rows), ['ee']);
  const s = byName(extractSamples(p, 'ee'));
  // Blank, Std 1 … Std 4, STD by name and S6 by its Type column: none is a sample
  assert.deepEqual(Object.keys(s), ['E2-F1_final', 'E2-F2_final', 'E2-F3_final']);
  const f1 = s['E2-F1_final'];
  assert.equal(f1.n, 3);
  near(f1.runs[0].ee_pct, (1 - 4.1 / 98.4) * 100);
  near(f1.ee_pct, [[98.4, 4.1], [97.1, 3.9], [99.2, 4.3]].reduce((a, [t, f]) => a + (1 - f / t) * 100, 0) / 3);
  near(f1.total_mg_mL, (98.4 + 97.1 + 99.2) / 3 / 1000);
  // the overflowing well has no total, so no EE, and the other two wells carry the mean
  const f3 = s['E2-F3_final'];
  assert.equal(f3.runs[2].ee_pct, null);
  near(f3.ee_pct, ((1 - 3.2 / 101.3) + (1 - 3.4 / 100.6)) * 50);
  // a DLS table keeps its "Blank PBS" row, which the preview offers to ignore
  assert.ok(extractDLS(parseCSV('Sample Name,Z-Average (d.nm),PdI\nE1-F1_final,80,0.1\nBlank PBS,,\n')).some((x) => x.sampleName === 'Blank PBS'));
});

test('the delimiter is the one the lines agree on, not the commonest character on the first line', () => {
  // decimal commas outnumber the semicolons on every data line
  const de = parseCSV('Probenname;Z-Mittelwert (d.nm);PdI\nE1-F1_final 1;82,41;0,081\nE1-F1_final 2;83,07;0,077\n');
  assert.equal(de.delimiter, ';');
  near(extractDLS(de)[0].zave_nm, 82.74);
  // a metadata line with no delimiter in it above the header
  const meta = parseCSV('Malvern Instruments Ltd\nSample Name\tZ-Average (d.nm)\tPdI\nA\t80.1\t0.07\n');
  assert.equal(meta.delimiter, '\t');
  assert.equal(meta.headerRow, 1);
  // a tab table with decimal commas
  const tab = parseCSV('Probenname\tZ-Mittelwert (d.nm)\tPdI\tAbgeleitete Zählrate (kcps)\nA\t82,4\t0,08\t1.204,6\n');
  assert.equal(tab.decimalComma, true);
  near(extractDLS(tab)[0].countRate_kcps, 1204.6);
  // a dot in a decimal-comma table is only a thousands separator between groups of three
  const mixed = parseCSV('Sample Name;Z-Average (d.nm);PdI\nA;82,4;0.08\n');
  near(extractDLS(mixed)[0].pdi, 0.08);
});

test('header row: the first with a sample name and a result column; without one, the first row as before', () => {
  const p = parseCSV('Report,LNP,2026\nSample Name,Operator\nOperator,AbCd\n\nSample Name,Measurement Date,EE (%)\nE1-F1_final,2026-10-27,93.4\n');
  assert.equal(p.headerRow, 3);
  assert.deepEqual(p.headers, ['Sample Name', 'Measurement Date', 'EE (%)']);
  assert.equal(p.rows.length, 1);
  const none = parseCSV('Name,Speed\nA,3\n');
  assert.equal(none.headerRow, 0);
  assert.deepEqual(none.headers, ['Name', 'Speed']);
  // a statistics row that repeats the sample name beside its label is not a fourth run
  const rep = parseCSV('Record,Sample Name,Z-Average (d.nm),PdI\n1,A,80,0.1\n2,A,82,0.1\n3,A,84,0.1\nMean,A,82,0.1\n');
  assert.equal(extractDLS(rep)[0].n, 3);
});

test('measurement dates: ISO from any locale, day or month first decided by the column', () => {
  assert.equal(isoDateTime('2026-10-29 14:02'), '2026-10-29 14:02');
  assert.equal(isoDateTime('27.10.2026 14:02:11'), '2026-10-27 14:02:11');
  assert.equal(isoDateTime('05.10.2026', 'mdy'), '2026-10-05', 'dots are always day first');
  assert.equal(isoDateTime('10/27/2026 2:02:11 PM', 'mdy'), '2026-10-27 14:02:11');
  assert.equal(isoDateTime('12/1/26 12:05 AM', 'mdy'), '2026-12-01 00:05');
  assert.equal(isoDateTime('27/10/2026 14:02'), '2026-10-27 14:02');
  assert.equal(isoDateTime('Dienstag, 27. Oktober 2026 14:02:11'), '2026-10-27 14:02:11');
  assert.equal(isoDateTime('Tuesday, October 27, 2026 2:02:11 PM'), '2026-10-27 14:02:11');
  assert.equal(isoDateTime('3 März 2026'), '2026-03-03');
  for (const bad of ['', 'n/a', '14:02', '13/13/2026']) assert.equal(isoDateTime(bad, 'dmy'), null, bad);
  assert.equal(dateOrder(['10/27/2026 2:02 PM']), 'mdy');
  assert.equal(dateOrder(['05/10/2026 14:00', '27/10/2026 15:00']), 'dmy');
  assert.equal(dateOrder(['05/10/2026 2:00 PM', '13/10/2026 2:00 PM']), 'dmy', 'a day above 12 outweighs the AM/PM');
  assert.equal(dateOrder(['05/10/2026 14:00']), 'dmy');
});

test('blanks and standards are recognised by name, and a sample whose name only starts alike is not', () => {
  for (const n of ['Blank', 'Blank 2', 'PBS blank', 'BLK', 'Leerwert']) assert.equal(controlKind(n), 'blank', n);
  for (const n of ['Std 1', 'STD', 'Std1', 'Standard 5', 'Cal 3', 'Calibrator']) assert.equal(controlKind(n), 'standard', n);
  for (const n of ['E1-F1_final', 'Standardised LNP', 'Calu-3 lysate', 'Stdy-1', '']) assert.equal(controlKind(n), null, n);
});
