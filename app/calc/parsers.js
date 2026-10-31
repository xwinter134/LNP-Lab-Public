// Instrument export parsers: delimited text, as the instrument software exports it or as pasted out of a
// spreadsheet (export XLSX as CSV first). Zetasizer-style tables and RiboGreen plate-reader tables: one row
// per run or well, columns detected by name. Rows are grouped into samples (triplicates) and averaged. Sample
// names are matched to expected measurement slots or batches.
//
// Real exports are messier than a hand-made CSV, and each of these is dealt with here rather than asked of the
// user: UTF-16 or a Windows code page instead of UTF-8, tabs or semicolons, decimal commas, metadata lines
// above the header row, German column names, units in brackets or after a slash, blank columns, "Mean" and
// "Std Dev" rows under the data, dates in the install's locale, and blanks and standards on a plate.
import { parseSampleName } from '../schema.js';

/**
 * Text from the bytes of an instrument file. A file input's text() always decodes UTF-8, and the Zetasizer
 * software writes "Unicode text", which is UTF-16 LE with a byte-order mark. Read as UTF-8 that arrives as two
 * replacement characters and a NUL after every letter, which no header pattern matches, and every letter
 * outside ASCII (µ, °, ä) is gone for good. So the bytes are looked at first:
 * - a byte-order mark names the encoding (UTF-8, UTF-16 LE or BE);
 * - without one, a NUL in every other byte gives UTF-16 away, and which half holds them gives the byte order;
 * - otherwise UTF-8, unless the bytes are not valid UTF-8. Then it is an "ANSI" export from a Windows program
 *   on a Western or German install (µ is the single byte B5), and Windows-1252 is what it is read as.
 * A string (a paste, or text decoded elsewhere) loses its BOM, and, if it is UTF-16 that was decoded as UTF-8,
 * its NULs: the ASCII letters survive that, and headers and numbers are ASCII.
 * @param {ArrayBuffer|ArrayBufferView|string} input
 * @returns {string}
 */
export function decodeText(input) {
  if (typeof input === 'string') {
    const head = input.slice(0, 2000);
    const s = (head.match(/\0/g) || []).length > head.length / 4 ? input.replace(/^\uFFFD{1,2}/, '').replace(/\0/g, '') : input;
    return s.replace(/^\uFEFF/, '');
  }
  const b = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const dec = (enc, fatal = false) => new TextDecoder(enc, { fatal }).decode(b).replace(/^\uFEFF/, '');
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return dec('utf-8');
  if (b[0] === 0xFF && b[1] === 0xFE) return dec('utf-16le');
  if (b[0] === 0xFE && b[1] === 0xFF) return dec('utf-16be');
  // Text is mostly ASCII, so UTF-16 has a zero in nearly every other byte and UTF-8 has none at all.
  const n = Math.min(b.length, 4000) & ~1;
  let even = 0, odd = 0;
  for (let i = 0; i < n; i += 2) { if (b[i] === 0) even++; if (b[i + 1] === 0) odd++; }
  if (n >= 4 && odd > n * 0.15 && even < odd / 10) return dec('utf-16le');
  if (n >= 4 && even > n * 0.15 && odd < even / 10) return dec('utf-16be');
  try { return dec('utf-8', true); } catch { return dec('windows-1252'); }
}

/** How often `d` occurs in one line outside quoted fields. */
function countOutside(line, d) {
  let n = 0, q = false;
  for (const ch of line) { if (ch === '"') q = !q; else if (ch === d && !q) n++; }
  return n;
}

/**
 * The delimiter: the one that splits the most lines into the same number of fields. Reading it off the first
 * line, as this used to, fails on a metadata line above the header ("Malvern Instruments Ltd" has no
 * delimiter at all), and counting characters fails on a German table, whose decimal commas can outnumber its
 * semicolons. Agreement across lines is what a delimiter has and a decimal comma does not. On a tie, tab, then
 * semicolon, then comma: a tab or semicolon table may hold commas as decimals, the other way round is rare.
 */
function sniffDelimiter(text) {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim()).slice(0, 60);
  let best = [',', 0];
  for (const d of ['\t', ';', ',']) {
    const freq = new Map();
    for (const l of lines) { const c = countOutside(l, d); if (c) freq.set(c, (freq.get(c) || 0) + 1); }
    const agree = Math.max(0, ...freq.values());
    if (agree > best[1]) best = [d, agree];
  }
  return best[0];
}

/** Every non-empty row as an array of cells. Quoted fields may hold the delimiter, quotes ("") and line breaks. */
function splitRows(text, delim) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some((c) => c.trim())) rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); if (row.some((c) => c.trim())) rows.push(row); }
  return rows;
}

/** What makes a row the header row, beside a sample-name column: a column holding something an import can store. */
const RESULT_KEYS = ['zave_nm', 'pdi', 'zeta_mV', 'ee_pct', 'total_mg_mL', 'free_mg_mL', 'rna_mg_mL'];

/**
 * Statistics an instrument or a spreadsheet writes under the data. Read as samples they would be a sample
 * called "Mean" in the inbox, or worse, where the row repeats the sample's name beside the label (a "Mean"
 * record per sample), a fourth run of a triplicate that is the average of the other three.
 */
export const SUMMARY_ROW = /^(?:mean|average|avg|median|std\.?\s*dev\.?|stdev|s\.?d\.?|sem|standard\s+deviation|%?\s*rsd|%?\s*cv|cv\s*%|min(?:imum)?|max(?:imum)?|range|count|sum|variance|statistics|mittelwert|durchschnitt|standardabweichung|stabw|std\.?-?abw\.?|anzahl|summe|varianz|vk|statistik)(?:\s*[:(].*|\s+of\b.*)?$/i;

/**
 * A delimited table, as {headers, rows, delimiter, decimalComma}; rows are objects keyed by header.
 *
 * The header row is the first row with a sample-name column and at least one result column. The lines above it
 * (instrument, file, operator, export date) are metadata and are left out of the rows. A table in which no row
 * qualifies is read from its first row, as it always was, so that the preview can say which columns it found.
 * Blank columns are dropped, a header that repeats keeps its first column, and statistics rows (SUMMARY_ROW in
 * the sample-name or the first column) are left out.
 *
 * @param {string|ArrayBuffer|ArrayBufferView} text  bytes are decoded first (decodeText)
 * @returns {{headers: string[], rows: object[], delimiter: string, decimalComma: boolean, headerRow: number,
 *   metadata: string[], summaryRows: number}}  headerRow counts non-empty rows; metadata is the lines above it
 */
export function parseCSV(text) {
  const src = decodeText(text);
  const delim = sniffDelimiter(src);
  const all = splitRows(src, delim);
  let h = all.slice(0, 100).findIndex((r) => { const m = detectColumns(r.map((c) => c.trim())); return m.sampleName && RESULT_KEYS.some((k) => m[k]); });
  if (h < 0) h = 0;
  const head = (all[h] || []).map((c) => c.trim());
  const cols = head.map((name, i) => [name, i]).filter(([name], i) => name && head.indexOf(name) === i);
  const sampleAt = head.indexOf(detectColumns(head).sampleName);
  const isSummary = (r) => [r[sampleAt], r[0]].some((c) => c != null && SUMMARY_ROW.test(c.trim()));
  const body = all.slice(h + 1);
  const data = body.filter((r) => !isSummary(r));
  const rows = data.map((r) => Object.fromEntries(cols.map(([name, i]) => [name, (r[i] ?? '').trim()])));
  const cells = data.flatMap((r) => r.map((c) => c.trim()));
  const commaNums = cells.filter((c) => /^[-+]?(?:\d{1,3}(?:\.\d{3})+|\d+),\d+$/.test(c)).length;
  const dotNums = cells.filter((c) => /^[-+]?\d+\.\d+$/.test(c)).length;
  // A semicolon table with a decimal comma anywhere is German: the semicolon is there because the comma is
  // taken. A tab table can be either, so there the commoner of the two decides.
  const decimalComma = delim === ';' ? commaNums > 0 : delim === '\t' && commaNums > 0 && commaNums >= dotNums;
  return { headers: cols.map(([name]) => name), rows, delimiter: delim, decimalComma, headerRow: h,
    metadata: all.slice(0, h).map((r) => r.map((c) => c.trim()).filter(Boolean).join(' ')), summaryRows: body.length - data.length };
}

const num = (v, decimalComma) => {
  if (v == null || v === '') return null;
  let s = String(v).trim().replace(/\s/g, '');
  // In a decimal-comma table a dot is a thousands separator, but only beside a comma or between groups of three
  // digits: stripping every dot read a stray "0.08" in a German sheet as 8.
  if (decimalComma) { if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); else if (/^[-+]?\d{1,3}(?:\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); }
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  // A cell with no digit in it ("n/a", "–") is no reading. Stripping it to "" used to give Number("")
  // = 0, which stored a size or an EE of zero for a well the reader could not measure.
  const t = s.replace(/[^\d.eE+-]/g, '');
  if (!/\d/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

// Patterns per field, most specific first. A header is claimed by the first key that wants it, and within a
// key the first pattern that finds a header wins. The German names are those of a Zetasizer on a German
// install. Units may follow in brackets or after a slash ("Size [nm]", "EE / %"); the patterns read the name.
const COLS = {
  // "Well" comes last: a plate export that has a Sample column names its samples there.
  sampleName: [/^sample\s*(?:name|id)?$/i, /^name$/i, /^proben?\s*-?\s*(?:name|bezeichnung|id)?$/i, /sample(?!\s*(?:type|typ|vol|count|number|no\b|nr\b))/i, /probenname/i, /^well\s*(?:name|id)?$/i],
  zave_nm: [/z-?ave(?:rage)?/i, /^size\b.*nm/i, /^z.?average/i, /z-?mittel/i, /^(?:mean\s+)?(?:size|diameter|durchmesser|gr(?:ö|oe)(?:ß|ss)e)\b/i],
  // "PdI Width (d.nm)" sits beside "PdI" in a Zetasizer export, so the exact name is looked for first.
  pdi: [/^pdi$/i, /^pdi\b/i, /polydispers/i],
  // and "Zeta Deviation (mV)" beside "Zeta Potential (mV)"
  zeta_mV: [/zeta\s*-?\s*potential/i, /^zeta(?!.*(?:dev|abw|sd\b|std))/i, /zeta/i],
  countRate_kcps: [/derived count/i, /count ?rate/i, /z(?:ä|ae)hlrate/i, /kcps/i],
  attenuator: [/attenuat/i, /abschw(?:ä|ae)cher/i],
  temp_c: [/^temp/i, /temperature/i, /^t\s*[([]\s*°?\s*c\s*[)\]]/i],
  date: [/measurement date/i, /messdatum/i, /^date/i, /^datum/i, /time/i, /zeit/i],
  pk1_nm: [/peak ?1.*(mean|size)/i, /pk ?1/i],
  intercept: [/intercept/i],
  // RiboGreen. The order matters: a header is claimed by the first key that wants it, so "Total RNA (µg/mL)"
  // goes to total before the looser RNA-content patterns below can take it. With detergent (Triton) the dye
  // reads all the RNA, in TE buffer alone only the free RNA.
  ee_pct: [/^%?\s*ee(?:\b|_)/i, /encapsulat/i, /verkaps/i, /einschluss/i],
  total_mg_mL: [/total\s*rna/i, /^total\b(?!.*lipid)/i, /gesamt/i, /triton|tx-?100/i],
  free_mg_mL: [/(?:free|freie?)\s*rna/i, /^(?:free|freie?)\b/i, /\bte\b/i],
  rna_mg_mL: [/rna\s*(?:content|conc)/i, /^rna\b/i, /^conc(?:entration|\.)?\b/i, /^konz/i],
};

export function detectColumns(headers) {
  const map = {};
  for (const [key, pats] of Object.entries(COLS)) {
    for (const p of pats) { const h = headers.find((x) => p.test(x) && !Object.values(map).includes(x)); if (h) { map[key] = h; break; } }
  }
  return map;
}

/**
 * Which test a table holds, as one of the test ids the importer offers ('dls', 'zeta', 'ee', 'content'), or
 * 'unknown'. The answer preselects the import type, so a pasted EE block is read as EE without a second step.
 */
export function detectInstrument(headers, rows = null) {
  const m = detectColumns(headers);
  // With the rows to hand, a column only counts if something is in it: the app's own blank sheet carries
  // size, PDI and zeta columns, and one filled in with zeta alone is a zeta table, not an empty DLS one.
  const filled = (h) => !rows || rows.some((r) => String(r[h] ?? '').trim() !== '');
  if (m.zave_nm && m.pdi && filled(m.zave_nm)) return 'dls';
  if (m.zeta_mV && filled(m.zeta_mV)) return 'zeta';
  if (rows && m.zave_nm && m.pdi && !m.zeta_mV) return 'dls';
  if (m.ee_pct || (m.total_mg_mL && m.free_mg_mL)) return 'ee';
  if (m.rna_mg_mL || m.total_mg_mL) return 'content';
  // A plate-reader sheet named after the assay but with columns nobody anticipated is still an EE sheet.
  // (This used to test /EE/i against every header, which "Free RNA" and "Speed" both pass.)
  if (headers.some((h) => /ribogreen/i.test(h))) return 'ee';
  return 'unknown';
}

/** The tests a table can be imported as, in the order an import reads and shows them. */
export const IMPORT_TESTS = ['dls', 'zeta', 'ee', 'content'];

/**
 * Every test a table holds results for, in IMPORT_TESTS order. With the rows, a column counts only when a cell in
 * it holds a number: the blank sheet carries a column for every test still due, and one left empty (or holding
 * only "n/a") is not part of this import. Without rows, the columns alone decide.
 *
 * Unlike detectInstrument, which names the one test a table is most likely to be, this is how one sheet with a
 * size, a PDI and an EE filled in is imported in one go instead of twice.
 */
export function detectTests(headers, rows = null) {
  const m = detectColumns(headers);
  const has = (key) => !!m[key] && (!rows || rows.some((r) => /\d/.test(String(r[m[key]] ?? ''))));
  const found = [];
  if (m.pdi && has('zave_nm')) found.push('dls');
  if (has('zeta_mV')) found.push('zeta');
  const ee = has('ee_pct') || (has('total_mg_mL') && has('free_mg_mL'));
  if (ee) found.push('ee');
  // RiboGreen's total alone is what an RNA content assay reads (see extractSamples); beside a free reading it is
  // one half of an EE, and reading it as a content as well would store a second result nobody measured.
  if (has('rna_mg_mL') || (!ee && !m.free_mg_mL && has('total_mg_mL'))) found.push('content');
  return found;
}

/**
 * The header each test's column carries on the blank sheet. They are names detectColumns already reads, so a
 * filled-in sheet comes back in without a mapping step.
 */
export const SHEET_COLUMNS = { dls: ['Z-Average (d.nm)', 'PdI'], zeta: ['Zeta Potential (mV)'], ee: ['EE (%)'], content: ['RNA (mg/mL)'] };

/**
 * The blank sheet: one row per sample name, and a column for each importable test in `tests` (the tests still
 * due). A column for a test nobody is waiting for would only invite a number that has nowhere to go. With none of
 * them due (a pH or a potency only), the size columns, which is what the sheet always carried.
 */
export function blankSheet(names, tests = []) {
  const due = IMPORT_TESTS.filter((t) => tests.includes(t));
  const cols = (due.length ? due : ['dls']).flatMap((t) => SHEET_COLUMNS[t]);
  const cell = (s) => (/[",;\t\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
  return [['Sample Name', ...cols].join(','), ...names.map((n) => [cell(String(n)), ...cols.map(() => '')].join(','))].join('\n') + '\n';
}

/**
 * The sample a run belongs to: its name without a trailing run index (name 1, name_2, name-3, name (3)).
 * The index has to be set off by a space, underscore, dash or brackets. Without that rule the "09" of
 * E6-F1_4C_T09 was read as a run number too: every timepoint at one storage condition became one sample,
 * averaged as if they were replicates, and the batch-id fallback filed it under whichever open slot of that
 * formulation came first, whatever its condition and timepoint.
 */
export const runBase = (raw) => raw.replace(/(?:[\s_-]+\(?\d{1,2}\)?|\s*\(\d{1,2}\))\s*$/, '').trim() || raw;

/**
 * A name in the app's own scheme (E3-F2, E3-F2_final, E6-F1_4C_T09; schema.js sampleName). The app never writes
 * one that ends in a bare number of its own, so a number after it can only be a run index.
 */
const OWN_NAME = /^E\d+-F\d+(?:_[^_]+_T\d+|_[A-Za-z0-9]+)?$/i;

/**
 * The sample each name in a file is read as: the name itself, or its runBase where the names say the trailing
 * number is a run index.
 *
 * Many names that are samples in their own right end in a number: "LNP-1", "LNP-2" and "LNP-3" are three
 * formulations, "Sample 6" and "Sample 9" two, and "MC3_lot_2" carries a lot number. Until cycle 6 every such
 * number was stripped, and those were averaged as the runs of one sample "LNP" (usability cycle 6, I4). So the
 * number is read as a run index only where what is left is a sample the app knows: one of the `expected` names,
 * or a name in the app's own scheme (E3-F2_final 1, E3-F2_final (2), E6-F1_4C_T09_3). A name that is itself
 * expected stays whole. Rows that repeat one name exactly are runs of that sample, which is how a Zetasizer
 * records the repeat runs of one vial; everything else is a sample of its own.
 * @param {string[]} names  the sample names in the file, repeats and all
 * @param {string[]} [expected]  the sample names the app expects (every experiment's slots)
 * @returns {Map<string, string>}  each distinct name to the sample it is read as
 */
export function runSamples(names, expected = []) {
  const known = new Set(expected.map(normName));
  // How many distinct names share each runBase. A base that holds one of the app's formulation ids (E7-F1 MC3)
  // is matched to that formulation's slot whatever follows it, so two or more names on it ("E7-F1 MC3 1",
  // "… 2", "… 3") are runs of that vial: read apart, each became a result of its own on the same slot.
  const sharing = new Map();
  for (const raw of new Set(names)) { const b = runBase(raw); if (b !== raw) sharing.set(b, (sharing.get(b) || 0) + 1); }
  const out = new Map();
  for (const raw of names) {
    if (out.has(raw)) continue;
    const base = runBase(raw);
    const run = base !== raw && !known.has(normName(raw))
      && (known.has(normName(base)) || OWN_NAME.test(base) || (sharing.get(base) >= 2 && HOLDS_BATCH_ID.test(base)));
    out.set(raw, run ? base : raw);
  }
  return out;
}
const HOLDS_BATCH_ID = /(?:^|[^A-Za-z0-9])E\d+-F\d+(?![0-9])/i;

/**
 * Names that differ only in a final number and were kept as separate samples (runSamples), in groups of two or
 * more by what is left without the number: [["LNP-1", "LNP-2", "LNP-3"]]. The preview names them, so a person
 * whose runs were meant to be averaged sees why they were not.
 */
export function keptApart(names, expected = []) {
  const of = runSamples(names, expected), by = new Map();
  for (const [raw, sample] of of) {
    const base = runBase(raw);
    if (sample !== raw || base === raw) continue;
    if (!by.has(base)) by.set(base, []);
    by.get(base).push(raw);
  }
  return [...by.values()].filter((g) => g.length > 1);
}

/** The rows' names read through runSamples, for the extractors below. */
const samplesOf = (parsed, col, expected) => runSamples(parsed.rows.map((r) => r[col]).filter(Boolean), expected);
const avg = (xs) =>{ const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

/**
 * RiboGreen encapsulation from the two readings: the dye sees only free RNA without detergent and all of it
 * with, so the encapsulated share is what the detergent revealed. Null when either is missing or total is not
 * positive, rather than a number that would look like a result.
 */
export function eeFromRiboGreen(total, free) {
  if (total == null || free == null || !(total > 0)) return null;
  return (1 - free / total) * 100;
}

/**
 * mg/mL per unit of a concentration column, read from its header. Plate readers report µg/mL (ng/µL is the
 * same number); the app stores mg/mL. A header without a unit is taken to be in mg/mL already.
 */
export function concFactor(header) {
  const h = String(header).replace(/μ/g, 'µ').toLowerCase();
  if (/(?:µ|u|mc)g\s*\/\s*ml/.test(h) || /ng\s*\/\s*(?:µ|u)l/.test(h)) return 1e-3;
  if (/ng\s*\/\s*ml/.test(h)) return 1e-6;
  return 1;
}

const MONTHS = { jan: 1, jän: 1, feb: 2, mar: 3, mär: 3, mae: 3, apr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, dez: 12 };

/**
 * A measurement date as "YYYY-MM-DD HH:MM[:SS]", whatever the install wrote: ISO, German (27.10.2026 14:02:11),
 * US (10/27/2026 2:02:11 PM), British (27/10/2026 14:02), or the month spelt out in English or German, with a
 * weekday in front or not. Null when it cannot be read. The import keeps the first ten characters as the
 * measurement date, and from "27.10.2026" that is a date no list can sort; with null it uses the date chosen
 * on the screen instead.
 * @param {string} s
 * @param {'dmy'|'mdy'} [order]  how to read 05/10/2026, which only the whole column can tell (dateOrder).
 *   A date with dots is always day first.
 */
export function isoDateTime(s, order = 'dmy') {
  const t = String(s ?? '').trim();
  let y, mo, d, rest, m;
  if ((m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(.*)$/))) [, y, mo, d, rest] = m;
  else if ((m = t.match(/^(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})(?!\d)(.*)$/))) {
    [d, mo] = m[2] === '.' || order !== 'mdy' ? [m[1], m[3]] : [m[3], m[1]];
    [y, rest] = [m[4], m[5]];
  } else {
    const w = t.replace(/^[a-zäöü]+,\s*/i, '');
    const month = (x) => MONTHS[x.toLowerCase().slice(0, 3)] ?? null;
    if ((m = w.match(/^(\d{1,2})\.?\s+([a-zäöü]+)\.?,?\s+(\d{4})(.*)$/i))) [d, mo, y, rest] = [m[1], month(m[2]), m[3], m[4]];
    else if ((m = w.match(/^([a-zäöü]+)\.?\s+(\d{1,2}),?\s+(\d{4})(.*)$/i))) [mo, d, y, rest] = [month(m[1]), m[2], m[3], m[4]];
    else return null;
  }
  [y, mo, d] = [Number(y), Number(mo), Number(d)];
  if (y < 100) y += 2000;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const p2 = (x) => String(x).padStart(2, '0');
  let out = `${y}-${p2(mo)}-${p2(d)}`;
  const tm = String(rest).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?m?\.?/i);
  if (tm) {
    let hh = Number(tm[1]);
    const ap = tm[4]?.toLowerCase();
    if (ap === 'p' && hh < 12) hh += 12;
    if (ap === 'a' && hh === 12) hh = 0;
    if (hh < 24) out += ` ${p2(hh)}:${tm[2]}${tm[3] ? ':' + tm[3] : ''}`;
  }
  return out;
}

/**
 * Day first or month first, for a column of dates written with slashes or dashes. One date with a first number
 * above 12 settles it as day first, one with a second number above 12 as month first. Without either, AM/PM
 * says a US install (month first) and a 24-hour clock says most other places (day first).
 */
export function dateOrder(values) {
  let dmy = false, mdy = false, ampm = false;
  for (const v of values) {
    const m = String(v ?? '').trim().match(/^(\d{1,2})[/-](\d{1,2})[/-]\d{2,4}/);
    if (!m) continue;
    if (Number(m[1]) > 12) dmy = true;
    if (Number(m[2]) > 12) mdy = true;
    if (/\d\s*[ap]\.?m\b/i.test(v)) ampm = true;
  }
  if (dmy !== mdy) return dmy ? 'dmy' : 'mdy';
  return ampm ? 'mdy' : 'dmy';
}

/** The run's date, read with the order its whole column calls for. */
function dateReader(parsed, map) {
  if (!map.date) return () => null;
  const order = dateOrder(parsed.rows.map((r) => r[map.date]));
  return (r) => isoDateTime(r[map.date], order);
}

/**
 * What a plate-reader row that is not a sample is: 'blank' (buffer or dye alone) or 'standard' (a point of the
 * calibration line: "Std 1", "STD", "Standard 3", "Cal 2"), or null for a sample. Their wells carry numbers in
 * the same columns, so read as samples they would be an EE of a standard in the inbox, or a blank averaged into
 * a sample whose name begins the same way.
 */
export function controlKind(name) {
  const s = String(name ?? '').trim();
  if (/\bblank\b|^blk(?![a-z])|^leer(?:wert|probe)?(?![a-zäöü])/i.test(s)) return 'blank';
  if (/^(?:std|standard|calibrat(?:or|ion)|kalibrat(?:or|ion)|kal|cal)(?![a-z])/i.test(s)) return 'standard';
  return null;
}

/**
 * Rows -> samples with averaged runs. Rows of one name are runs of one sample, and so are names that differ in
 * a trailing run index (name 1, name_2, name (3)) where what is left is a sample the app knows (runSamples,
 * which `expected` feeds); dates are read into ISO (isoDateTime).
 *
 * A Zetasizer records export lists a sample's size runs and its zeta runs as separate records, each with the
 * other's cells empty. Grouped together, the size of that sample would count six runs of which three have no
 * size, and the stored runs would carry three empty ones. So in a table made that way (rows with a size and no
 * zeta, rows with a zeta and no size, none with both), `test` ('dls' or 'zeta') leaves out the other test's rows.
 * @param {{expected?: string[]}} [opts]  expected: the sample names the app expects
 */
export function extractDLS(parsed, test = null, { expected = [] } = {}) {
  const map = detectColumns(parsed.headers);
  if (!map.sampleName) throw new Error('No sample name column found');
  const v = (r, key) => (map[key] ? num(r[map[key]], parsed.decimalComma) : null);
  const when = dateReader(parsed, map);
  const sampleOf = samplesOf(parsed, map.sampleName, expected);
  const size = (r) => v(r, 'zave_nm') != null || v(r, 'pdi') != null, zeta = (r) => v(r, 'zeta_mV') != null;
  const split = parsed.rows.some((r) => size(r) && !zeta(r)) && parsed.rows.some((r) => zeta(r) && !size(r)) && !parsed.rows.some((r) => size(r) && zeta(r));
  const other = !split ? () => false : test === 'dls' ? (r) => zeta(r) : test === 'zeta' ? (r) => size(r) : () => false;
  const groups = {};
  for (const r of parsed.rows) {
    const raw = r[map.sampleName]; if (!raw || other(r)) continue;
    const run = { raw, zave_nm: v(r, 'zave_nm'), pdi: v(r, 'pdi'), zeta_mV: v(r, 'zeta_mV'),
      countRate_kcps: v(r, 'countRate_kcps'), attenuator: v(r, 'attenuator'), temp_c: v(r, 'temp_c'), date: when(r) };
    (groups[sampleOf.get(raw)] ||= []).push(run);
  }
  return Object.entries(groups).map(([sampleName, runs]) => ({
    sampleName, runs, n: runs.length,
    zave_nm: avg(runs.map((x) => x.zave_nm)), pdi: avg(runs.map((x) => x.pdi)), zeta_mV: avg(runs.map((x) => x.zeta_mV)),
    countRate_kcps: avg(runs.map((x) => x.countRate_kcps)), attenuator: runs[0].attenuator, temp_c: avg(runs.map((x) => x.temp_c)), date: runs[0].date,
  }));
}

/**
 * Rows -> samples for any test the importer reads: replicate rows of one sample name are grouped and averaged
 * the way extractDLS does it, and the replicates are kept as `runs`. DLS and zeta go through extractDLS
 * itself, whose output the import already stores.
 *
 * EE: the EE column if there is one; otherwise, per replicate, (1 − free/total) × 100 from the Total RNA and
 * Free RNA columns, so a raw RiboGreen sheet needs no spreadsheet step first. RNA content: the RNA column, or
 * RiboGreen's total (with detergent) when that is the only concentration in the table, because that is what
 * an RNA content assay reads. Concentrations are converted to mg/mL from the unit in their header.
 *
 * Blanks and standards (controlKind, by their name or by a Type column) are left out of EE and RNA content: they
 * are how the plate reader drew its calibration line, not results. A DLS table keeps them, as it always has;
 * a "Blank PBS" row there is shown and can be ignored on the preview.
 * @param {{expected?: string[]}} [opts]  expected: the sample names the app expects (runSamples)
 */
export function extractSamples(parsed, test = 'dls', opts = {}) {
  if (test === 'dls' || test === 'zeta') return extractDLS(parsed, test, opts);
  const map = detectColumns(parsed.headers);
  if (!map.sampleName) throw new Error('No sample name column found');
  const dc = parsed.decimalComma;
  const conc = (r, key) => { const h = map[key]; const v = h ? num(r[h], dc) : null; return v == null ? null : v * concFactor(h); };
  let read;
  if (test === 'ee') {
    if (!map.ee_pct && !(map.total_mg_mL && map.free_mg_mL)) throw new Error('No EE column found (EE, EE (%), Encapsulation …), and no Total RNA and Free RNA columns to work it out from');
    read = (r) => {
      const total_mg_mL = conc(r, 'total_mg_mL'), free_mg_mL = conc(r, 'free_mg_mL');
      const given = map.ee_pct ? num(r[map.ee_pct], dc) : null;
      return { ee_pct: given ?? eeFromRiboGreen(total_mg_mL, free_mg_mL), total_mg_mL, free_mg_mL };
    };
  } else if (test === 'content') {
    const key = map.rna_mg_mL ? 'rna_mg_mL' : map.total_mg_mL ? 'total_mg_mL' : null;
    if (!key) throw new Error('No RNA concentration column found (RNA (mg/mL), Concentration, RNA content, Total RNA)');
    read = (r) => ({ rna_mg_mL: conc(r, key) });
  } else throw new Error(`Results for "${test}" cannot be imported from a table yet`);
  const when = dateReader(parsed, map);
  const type = parsed.headers.find((h) => /^(?:sample\s*|well\s*|proben)?typ(?:e)?$/i.test(h));
  const sampleOf = samplesOf(parsed, map.sampleName, opts.expected);
  const groups = {};
  for (const r of parsed.rows) {
    const raw = r[map.sampleName]; if (!raw || controlKind(raw) || (type && controlKind(r[type]))) continue;
    (groups[sampleOf.get(raw)] ||= []).push({ raw, ...read(r), date: when(r) });
  }
  return Object.entries(groups).map(([sampleName, runs]) => {
    const s = { sampleName, runs, n: runs.length, date: runs[0].date };
    for (const k of Object.keys(runs[0])) if (k !== 'raw' && k !== 'date') s[k] = avg(runs.map((x) => x[k]));
    return s;
  });
}

/**
 * Rows -> samples for several tests at once: one entry per sample name, in the order the names first appear,
 * with what extractSamples reads for each test under `tests[test]`. Each test is grouped and averaged on its
 * own, exactly as a one-test import of the same table would be, so a sheet with size and EE gives the same
 * numbers as the two single-test imports it replaces. `names` are the names in the file that were read as the
 * sample, so the preview can show which rows were averaged together.
 * @param {{expected?: string[]}} [opts]  expected: the sample names the app expects (runSamples)
 * @returns {{sampleName: string, n: number, date: string|null, names: string[], tests: Object<string, object>}[]}
 */
export function extractTests(parsed, tests, opts = {}) {
  const out = new Map();
  for (const t of tests) {
    for (const s of extractSamples(parsed, t, opts)) {
      if (!out.has(s.sampleName)) out.set(s.sampleName, { sampleName: s.sampleName, n: s.n, date: s.date, names: [], tests: {} });
      const o = out.get(s.sampleName);
      o.tests[t] = s;
      for (const r of s.runs) if (!o.names.includes(r.raw)) o.names.push(r.raw);
    }
  }
  return [...out.values()];
}

const normName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * What a file was expected to bring and did not: the open measurements, for the tests it was read for, of the
 * experiments its rows matched into, whose sample is not in the file with a number for that test.
 *
 * "Expected" is the round the file belongs to, not everything the experiment will ever want: only the stages it
 * matched (the T7 pulls of a stability study, not T14 and T28), and only what is due by today or by the latest
 * due date among the slots it matched (a DoE formulation made tomorrow is not missing today). A name in the file
 * with that test's cell left empty counts as missing, because the result is.
 *
 * @param {object[]} experiments  all experiments, with their expected slots
 * @param {object} a
 * @param {{sampleName: string, test: string, match: object|null, hasValue: boolean}[]} a.results  one per sample
 *   name and test read: matchSample's answer, and whether the file holds a number for it
 * @param {string[]} a.tests  the tests the file was read for
 * @param {string} [a.today]  ISO date
 * @returns {{sampleName, batchId, experimentId, stage, tests: string[], slots: Object<string, object>}[]}
 *   one per sample, in the order the experiment lists them
 */
export function missingFromFile(experiments, { results = [], tests = [], today = null } = {}) {
  const got = results.filter((r) => r.hasValue && r.match?.slot && r.match.experiment);
  const placed = new Set(got.map((r) => r.match.slot.id));
  const inFile = new Set(results.filter((r) => r.hasValue).map((r) => `${r.test}|${normName(r.sampleName)}`));
  const rounds = new Map();
  for (const r of got) {
    const id = r.match.experiment.id;
    if (!rounds.has(id)) rounds.set(id, { stages: new Set(), due: today || '' });
    const x = rounds.get(id);
    x.stages.add(r.match.slot.stage);
    if (r.match.slot.dueDate && r.match.slot.dueDate > x.due) x.due = r.match.slot.dueDate;
  }
  const out = new Map();
  for (const exp of experiments) {
    const round = rounds.get(exp.id);
    if (!round) continue;
    for (const s of exp.expected || []) {
      if (s.status !== 'open' || !tests.includes(s.test) || placed.has(s.id) || inFile.has(`${s.test}|${normName(s.sampleName)}`)) continue;
      if (!round.stages.has(s.stage) || (round.due && s.dueDate && s.dueDate > round.due)) continue;
      if (!out.has(s.sampleName)) out.set(s.sampleName, { sampleName: s.sampleName, batchId: s.batchId, experimentId: exp.id, stage: s.stage, tests: [], slots: {} });
      const o = out.get(s.sampleName);
      if (!o.slots[s.test]) { o.tests.push(s.test); o.slots[s.test] = s; }
    }
  }
  for (const o of out.values()) o.tests.sort((a, b) => IMPORT_TESTS.indexOf(a) - IMPORT_TESTS.indexOf(b));
  return [...out.values()];
}

/**
 * Whether a file's results are already stored: the results and inbox rows still on record from the same bytes
 * (their SHA-256), for the tests the file is being read for now. Imported again, every one of them would be
 * stored a second time and counted twice in each mean and fit (usability cycle 6, I5). A file read before for
 * another test, or whose results have all been deleted since, is not a repeat. Null when nothing is stored.
 * @param {string} sha256
 * @param {{imports?: object[], records?: object[], tests?: string[]}} a  records: stored results and inbox rows
 * @returns {{results: number, dates: string[]}|null}  dates: when it was imported (ISO), oldest first; for an
 *   import older than the import records, when its results were stored
 */
export function alreadyImported(sha256, { imports = [], records = [], tests = IMPORT_TESTS } = {}) {
  if (!sha256) return null;
  const mine = records.filter((r) => r?.raw?.sha256 === sha256 && tests.includes(r.test));
  if (!mine.length) return null;
  const dates = imports.filter((i) => i?.sha256 === sha256 && i.importedAt).map((i) => i.importedAt).sort();
  const first = mine.map((r) => r.createdAt).filter(Boolean).sort()[0];
  return { results: mine.length, dates: dates.length ? dates : first ? [first] : [] };
}

/** Match a sample name to an expected slot (exact, then parsed, then batch-id substring). */
export function matchSample(sampleName, { experiments, batches }, test = 'dls') {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = norm(sampleName);
  for (const e of experiments) {
    const slot = (e.expected || []).find((s) => s.test === test && norm(s.sampleName) === n);
    if (slot) return { confidence: 'exact', experiment: e, slot, batchId: slot.batchId };
    // The name is right but nothing of this test was planned for it (an RNA content measured on a sample
    // planned for DLS and EE): the batch is known, but closing another test's slot with it would mark a
    // measurement done that never happened.
    const other = (e.expected || []).find((s) => norm(s.sampleName) === n);
    if (other) return { confidence: 'batch-only', experiment: e, slot: null, batchId: other.batchId };
  }
  const p = parseSampleName(sampleName);
  if (p?.experimentId) {
    const e = experiments.find((x) => x.id === p.experimentId);
    const slot = e?.expected.find((s) => s.formulation === p.formulation && norm(s.condition) === norm(p.condition) && s.timepoint === p.timepoint && s.test === test);
    if (slot) return { confidence: 'parsed', experiment: e, slot, batchId: slot.batchId };
  }
  // Look for a lot number the way a lot number is actually found: by asking which of the known batches
  // appears in the name. Matching a pattern instead meant hard-coding both the numbering scheme and the
  // "LNP" prefix, which is a setting, so a lab that renamed it silently lost every batch-id fallback.
  // Longest id first, so LNP_10 cannot claim a sample belonging to LNP_100.
  const hay = sampleName.toLowerCase();
  const b = batches
    .filter((x) => x.id && hay.includes(String(x.id).toLowerCase()))
    .sort((x, y) => String(y.id).length - String(x.id).length)[0];
  {
    if (b) {
      const e = experiments.find((x) => x.id === b.experimentId);
      const stage = p?.stage || (sampleName.match(/IPC\d/i) || ['final'])[0];
      const slot = e?.expected.find((s) => s.batchId === b.id && s.test === test && s.status === 'open' && (norm(s.stage) === norm(stage))) || e?.expected.find((s) => s.batchId === b.id && s.test === test && s.status === 'open');
      return { confidence: slot ? 'batch' : 'batch-only', experiment: e, slot: slot || null, batchId: b.id };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ plate readers (spec 8.3, layer 1) */

/*
 * Plate-reader exports for the in-vitro layer. No real export of the lab's reader was available when this was
 * written (an open point for Gholan), so two generic shapes are read, which between them cover what readers and
 * spreadsheets write:
 *  - the plate grid: a header row 1 … 12 (or 1 … 24), then one row per plate row A … H (or A … P), possibly
 *    several blocks one under the other, each with a label line above it ("Luminescence", "Read 2: 560 nm");
 *  - the long table: one row per well, a Well column (A1, A01, B12) and a value column, optionally a sample name.
 * The same grid read with text in it is the plate layout (which group sits in which well), so a layout pasted
 * from the lab's Excel template maps wells to groups (plateToMeasurements in app/calc/bio.js).
 * Delimiters, decimal commas, encodings and metadata lines are handled as for the instrument files above.
 */

/** "A1", "a01", "H 12" → "A1"; anything else → null. */
export function wellId(s) {
  const m = /^\s*([A-Pa-p])\s*0?(\d{1,2})\s*$/.exec(String(s ?? ''));
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 24 ? `${m[1].toUpperCase()}${Number(m[2])}` : null;
}

/**
 * Read a plate-reader export or a pasted plate layout.
 * @param {string|ArrayBuffer|ArrayBufferView} text
 * @returns {{layout: 'grid'|'long'|null, blocks: {label: string, wells: Object<string, {raw: string, value: number|null}>}[],
 *   samples: Object<string, string>, decimalComma: boolean, wells: number}}
 *   `samples` is the long table's sample name per well, when it has one
 */
export function parsePlate(text) {
  const src = decodeText(text);
  const delim = sniffDelimiter(src);
  const rows = splitRows(src, delim).map((r) => r.map((c) => c.trim()));
  const cells = rows.flat();
  const decimalComma = cells.filter((c) => /^[-+]?\d+,\d+$/.test(c)).length > cells.filter((c) => /^[-+]?\d+\.\d+$/.test(c)).length;
  const blocks = [];
  // A grid header: 1, 2, 3 … in a row; returns the column of the 1.
  const isHeader = (r) => {
    const at = r.indexOf('1');
    if (at < 0) return null;
    let k = 0;
    while (r[at + k] === String(k + 1)) k++;
    return k >= 6 ? at : null;
  };
  for (let i = 0; i < rows.length; i++) {
    const col1 = isHeader(rows[i]);
    if (col1 == null) continue;
    const prev = i > 0 ? rows[i - 1].filter(Boolean) : [];
    const label = (prev.length && !/^[A-Pa-p]$/.test(prev[0]) ? prev.join(' ') : '') || `Block ${blocks.length + 1}`;
    const wells = {};
    let j = i + 1;
    for (; j < rows.length; j++) {
      const r = rows[j];
      const letter = col1 > 0 ? r[col1 - 1] : '';
      if (!/^[A-Pa-p]$/.test(letter || '')) break;
      for (let k = 0; k < 24; k++) {
        const raw = r[col1 + k];
        if (raw == null || raw === '') continue;
        wells[`${letter.toUpperCase()}${k + 1}`] = { raw, value: num(raw, decimalComma) };
      }
    }
    if (Object.keys(wells).length) blocks.push({ label, wells });
    i = j - 1;
  }
  if (blocks.length) return { layout: 'grid', blocks, samples: {}, decimalComma, wells: Object.keys(blocks[0].wells).length };
  // The long table: a header row with a Well column.
  const isWellHead = (c) => /^well(\s*(id|position|pos\.?|name))?$/i.test(c);
  const h = rows.findIndex((r) => r.some(isWellHead));
  if (h >= 0) {
    const head = rows[h];
    const wi = head.findIndex(isWellHead);
    const si = head.findIndex((c, k) => k !== wi && /sample|name|probe|content|group/i.test(c));
    const body = rows.slice(h + 1).filter((r) => wellId(r[wi]));
    let vi = head.findIndex((c, k) => k !== wi && k !== si && /value|rlu|lum|signal|count|od\b|abs|fluor|result|mean|raw|%|mfi/i.test(c));
    if (vi < 0) vi = head.findIndex((c, k) => k !== wi && k !== si && body.some((r) => num(r[k], decimalComma) != null));
    const wells = {}, samples = {};
    for (const r of body) {
      const id = wellId(r[wi]);
      wells[id] = { raw: r[vi] ?? '', value: vi >= 0 ? num(r[vi], decimalComma) : null };
      if (si >= 0 && r[si]) samples[id] = r[si];
    }
    return { layout: 'long', blocks: [{ label: vi >= 0 ? head[vi] : 'Value', wells }], samples, decimalComma, wells: Object.keys(wells).length };
  }
  return { layout: null, blocks: [], samples: {}, decimalComma, wells: 0 };
}

/**
 * An IVIS (Living Image) export folder is read by app/calc/ivis.js (text files, calibration, counts to photons)
 * and app/calc/tiff.js (the images), and analysed by app/calc/bli.js; re-exported here so that every
 * instrument import is found in one place.
 */
export { parseClickInfo, clickMeta, parseCalibration, parseRois, groupClickFolders } from './ivis.js';
export { readTiff } from './tiff.js';
