// Reading an .xlsx without a library: every sheet, as raw rows of cell values (read_file, spec 6.3).
//
// An .xlsx is a zip archive of XML files. The zip's central directory says where each entry is; an entry is
// stored (method 0) or deflated (method 8), which node's zlib inflateRawSync undoes. Of the XML, four files
// matter: xl/workbook.xml names the sheets in their order, xl/_rels/workbook.xml.rels says which file holds
// each, xl/sharedStrings.xml holds the text cells point to by index, and xl/styles.xml says which number formats
// are dates. A sheet is <row r="5"><c r="B5" t="s" s="3"><v>12</v></c>…</row>.
//
// What comes out is what the cells hold, nothing interpreted beyond that: a number stays a number, a text stays
// text, a cell formatted as a date becomes YYYY-MM-DD (or with the time when it has one), because a serial number
// such as 45366 is not something Claude should have to guess at. Formulas give their last computed value, which
// Excel stores beside them. Merged cells keep their value in the top-left cell only, as Excel stores them.
import { inflateRawSync } from 'node:zlib';

/** The entries of a zip archive: {name → Buffer}. Only what an .xlsx uses: no zip64, no encryption. */
export function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('not a zip archive (an .xlsx is one); is it an old .xls? Save it as .xlsx or CSV first');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('the zip directory is damaged');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.slice(start, start + csize);
    out.set(name, method === 0 ? data : method === 8 ? inflateRawSync(data) : null);
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unxml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m));
const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unxml(m[1]) : null; };
/** The text of a <si> or <is>: every <t> in it, rich-text runs joined, phonetic runs (<rPh>) left out. */
const textOf = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

/** "B12" → {col: 1, row: 12}. */
export function cellRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref || '');
  if (!m) return null;
  let col = 0; for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) };
}
export const colName = (i) => { let s = ''; i += 1; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };

// Built-in number formats that are dates or times (ECMA-376 18.8.30).
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
/** Which style indexes (the s attribute of a cell) show a date. */
function dateStyles(xml) {
  if (!xml) return new Set();
  const custom = new Map([...xml.matchAll(/<numFmt\b[^>]*>/g)].map((m) => [Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode') || '']));
  // A custom format is a date when it has d, m or y outside quotes and brackets ("[Red]", "\"pcs\"").
  const isDate = (id) => DATE_IDS.has(id) || (custom.has(id) && /[dmyhs]/i.test(custom.get(id).replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')) && !/^[#0.,% ]+$/.test(custom.get(id)));
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] || '';
  const out = new Set();
  [...xfs.matchAll(/<xf\b[^>]*\/?>/g)].forEach((m, i) => { if (isDate(Number(attr(m[0], 'numFmtId')))) out.add(i); });
  return out;
}

/** An Excel serial day (1900 system, with its 29 Feb 1900) as an ISO date, with the time when it has one. */
export function serialDate(v, date1904 = false) {
  const ms = Math.round((v + (date1904 ? 1462 : 0) - 25569) * 864e5);
  const iso = new Date(ms).toISOString();
  return Math.abs(v - Math.round(v)) < 1e-9 ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}

/**
 * Every sheet of a workbook: [{name, rows: [{row, cells: [value…]}]}], rows in order, empty rows left out, each
 * row as long as its last filled cell. `maxRows` stops a sheet early (the rest is counted in `more`).
 */
export function readXlsx(buf, { maxRows = Infinity } = {}) {
  const z = unzip(buf);
  const text = (name) => { const b = z.get(name); return b ? b.toString('utf8') : null; };
  const wb = text('xl/workbook.xml');
  if (!wb) throw new Error('no xl/workbook.xml: this zip is not an Excel workbook');
  const date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(wb);
  const rels = new Map([...(text('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const shared = [...(text('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const dates = dateStyles(text('xl/styles.xml'));
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = attr(m[0], 'name'), rid = attr(m[0], 'r:id');
    let target = rels.get(rid) || '';
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`.replace(/\/\.\//g, '/');
    const xml = text(target);
    if (xml == null) { sheets.push({ name, rows: [], note: 'not a worksheet (a chart sheet?)' }); continue; }
    const rows = [];
    let more = 0;
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
      const rowNo = Number(attr(r[0], 'r')) || rows.length + 1;
      const cells = [];
      for (const c of (r[2] || '').matchAll(/<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const tag = `<c${c[1] ?? c[2]}>`, inner = c[3] || '';
        const at = cellRef(attr(tag, 'r'));
        const t = attr(tag, 't'), s = Number(attr(tag, 's'));
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let val = null;
        if (t === 's') val = v != null ? shared[Number(v)] ?? null : null;
        else if (t === 'inlineStr') val = textOf(inner);
        else if (t === 'str' || t === 'e') val = v != null ? unxml(v) : null;
        else if (t === 'b') val = v === '1';
        else if (v != null) { const n = Number(v); val = Number.isFinite(n) ? (dates.has(s) ? serialDate(n, date1904) : n) : unxml(v); }
        const col = at ? at.col : cells.length;
        while (cells.length < col) cells.push(null);
        cells[col] = val;
      }
      while (cells.length && (cells[cells.length - 1] == null || cells[cells.length - 1] === '')) cells.pop();
      if (!cells.length) continue;
      if (rows.length >= maxRows) { more++; continue; }
      rows.push({ row: rowNo, cells });
    }
    sheets.push({ name, rows, ...(more ? { more } : {}) });
  }
  return sheets;
}
