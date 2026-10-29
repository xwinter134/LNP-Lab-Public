// A small PDF writer: enough for a table on a page, with no dependency and no build step.
//
// Why write one at all. "Export as PDF" through the browser's print dialog gives a different result on every
// machine, carries the page's own styling and chrome, and cannot be produced without a human clicking
// through a dialog. A run plan that goes to a bench, into a lab book or into an appendix should be one file,
// the same everywhere, produced by a button. That is worth about two hundred lines.
//
// What this supports: one font (Helvetica, with Bold for headers), A4 in either orientation, a title block,
// a table with left and right aligned columns, automatic page breaks with the header repeated, and a footer
// on every page. What it does not: images, colour beyond greyscale, wrapping inside a cell, or any text the
// WinAnsi encoding cannot represent. Those are not what a run plan needs.

/* ---------------- text ---------------- */

// The characters this app actually puts in a label and their WinAnsiEncoding byte. Anything else outside
// ASCII is transliterated rather than dropped silently, so a degree sign never becomes an invisible gap.
const WIN_ANSI = {
  '°': 0xb0, '±': 0xb1, '²': 0xb2, '³': 0xb3, 'µ': 0xb5, '·': 0xb7, '×': 0xd7, '÷': 0xf7,
  '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '…': 0x85, '€': 0x80,
  'ä': 0xe4, 'ö': 0xf6, 'ü': 0xfc, 'Ä': 0xc4, 'Ö': 0xd6, 'Ü': 0xdc, 'ß': 0xdf, 'é': 0xe9, 'è': 0xe8, 'á': 0xe1,
};
const TRANSLIT = { '≤': '<=', '≥': '>=', '→': '->', '←': '<-', '≈': '~', '×': 'x', '′': "'", '″': '"' };

/** One PDF string literal, escaped and reduced to bytes the font can show. */
export function pdfString(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    if (ch === '(' || ch === ')' || ch === '\\') { out += '\\' + ch; continue; }
    const code = ch.codePointAt(0);
    if (code >= 32 && code < 127) { out += ch; continue; }
    if (WIN_ANSI[ch] != null) { out += '\\' + WIN_ANSI[ch].toString(8).padStart(3, '0'); continue; }
    if (TRANSLIT[ch]) { out += TRANSLIT[ch]; continue; }
    if (code >= 160 && code <= 255) { out += '\\' + code.toString(8).padStart(3, '0'); continue; }
    out += '?';
  }
  return out;
}

// Helvetica advance widths, per 1000 units. Every digit is 556, which is what makes a column of numbers line
// up exactly; the rest is close enough to place and truncate text by.
const W_DIGIT = 556, W_SPACE = 278, W_DOT = 278, W_MINUS = 333, W_UPPER = 690, W_LOWER = 520;
export function textWidth(s, size = 10) {
  let w = 0;
  for (const ch of String(s ?? '')) {
    if (ch >= '0' && ch <= '9') w += W_DIGIT;
    else if (ch === ' ') w += W_SPACE;
    else if (ch === '.' || ch === ',' || ch === ':' || ch === ';' || ch === "'" || ch === '|') w += W_DOT;
    else if (ch === '-' || ch === '(' || ch === ')' || ch === '/') w += W_MINUS;
    else if (ch >= 'A' && ch <= 'Z') w += W_UPPER;
    else w += W_LOWER;
  }
  return (w / 1000) * size;
}

/** Cut a string to fit a width, with an ellipsis when something was removed. */
export function fitText(s, width, size = 10) {
  const str = String(s ?? '');
  if (textWidth(str, size) <= width) return str;
  let cut = str;
  while (cut.length > 1 && textWidth(cut + '…', size) > width) cut = cut.slice(0, -1);
  return cut + '…';
}

/* ---------------- page geometry ---------------- */

const A4 = { portrait: [595.28, 841.89], landscape: [841.89, 595.28] };
const MARGIN = 36; // half an inch

/**
 * A table document.
 *
 * @param {object} o
 * @param {string} o.title        heading on the first page
 * @param {string} [o.subtitle]   one line under it, for the design and the date
 * @param {Array<{label:string, right?:boolean, width?:number, sub?:string}>} o.columns
 *        `sub` is a second header line, which is where a unit belongs so the column stays narrow.
 *        `width` is a weight, not points: the columns share the page in proportion to them.
 * @param {Array<Array<string>>} o.rows
 * @param {string} [o.footer]     repeated on every page, with the page number appended
 * @param {boolean} [o.landscape]
 * @returns {Uint8Array} the file
 */
export function tablePdf({ title, subtitle = '', columns, rows, footer = '', landscape = true }) {
  const [pw, ph] = landscape ? A4.landscape : A4.portrait;
  const usable = pw - 2 * MARGIN;
  const weights = columns.map((c) => c.width || Math.max(1, (c.label || '').length / 8));
  const total = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / total) * usable);
  const x0 = columns.map((_, i) => MARGIN + widths.slice(0, i).reduce((a, b) => a + b, 0));

  const SIZE = 9, HEAD = 9, TITLE = 15, SUB = 9.5;
  const ROW = 14, HEADER_H = columns.some((c) => c.sub) ? 26 : 16;

  const pages = [];
  let y = 0, cur = null;
  const newPage = (first) => {
    cur = { ops: [] };
    pages.push(cur);
    y = ph - MARGIN;
    if (first) {
      cur.ops.push(txt(MARGIN, y - TITLE, title, TITLE, true));
      y -= TITLE + 6;
      if (subtitle) { cur.ops.push(txt(MARGIN, y - SUB, subtitle, SUB, false, 0.35)); y -= SUB + 10; }
      else y -= 6;
    } else {
      cur.ops.push(txt(MARGIN, y - SUB, `${title} (continued)`, SUB, true, 0.35));
      y -= SUB + 10;
    }
    // column headers, with the unit on its own line underneath
    for (let i = 0; i < columns.length; i++) {
      const c = columns[i];
      const w = widths[i] - 6;
      const label = fitText(c.label, w, HEAD);
      cur.ops.push(c.right ? txtRight(x0[i] + widths[i] - 4, y - HEAD, label, HEAD, true) : txt(x0[i] + 2, y - HEAD, label, HEAD, true));
      if (c.sub) {
        const sub = fitText(c.sub, w, HEAD - 1);
        cur.ops.push(c.right ? txtRight(x0[i] + widths[i] - 4, y - HEAD - 10, sub, HEAD - 1, false, 0.4) : txt(x0[i] + 2, y - HEAD - 10, sub, HEAD - 1, false, 0.4));
      }
    }
    y -= HEADER_H;
    cur.ops.push(line(MARGIN, y + 4, pw - MARGIN, y + 4));
    y -= 4;
  };

  newPage(true);
  for (const r of rows) {
    if (y - ROW < MARGIN + 24) { newPage(false); }
    for (let i = 0; i < columns.length && i < r.length; i++) {
      const cell = r[i] == null ? '' : String(r[i]);
      if (cell === '') continue;
      const w = widths[i] - 6;
      const t = fitText(cell, w, SIZE);
      cur.ops.push(columns[i].right ? txtRight(x0[i] + widths[i] - 4, y - SIZE, t, SIZE) : txt(x0[i] + 2, y - SIZE, t, SIZE));
    }
    y -= ROW;
  }

  // footer on every page, with the page number
  pages.forEach((p, i) => {
    const note = [footer, `Page ${i + 1} of ${pages.length}`].filter(Boolean).join('   ·   ');
    p.ops.push(txt(MARGIN, MARGIN - 10, note, 8, false, 0.45));
  });

  return assemble(pages, pw, ph);
}

/* ---------------- content stream pieces ---------------- */

const g = (v) => (v == null ? '' : `${v.toFixed(2)} ${v.toFixed(2)} ${v.toFixed(2)} rg\n`);
const txt = (x, y, s, size, bold = false, grey = null) =>
  `${grey != null ? g(grey) : '0 0 0 rg\n'}BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${pdfString(s)}) Tj ET\n`;
const txtRight = (xRight, y, s, size, bold = false, grey = null) =>
  txt(xRight - textWidth(s, size), y, s, size, bold, grey);
const line = (x1, y1, x2, y2) =>
  `0.75 0.75 0.75 RG 0.6 w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S\n`;

/* ---------------- file assembly ---------------- */

function assemble(pages, pw, ph) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; }; // 1-based object numbers

  const catalog = add('');            // 1, filled once the pages object is known
  const pagesObj = add('');           // 2
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const kids = [];
  for (const p of pages) {
    const stream = p.ops.join('');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    const page = add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] ` +
      `/Resources << /Font << /F1 ${font} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${content} 0 R >>`);
    kids.push(page);
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  // Every byte emitted above is below 256 by construction, so one character is one byte and the offsets
  // recorded as string indices are the byte offsets the xref table has to give.
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/* ---------------- the other two formats ---------------- */

/** Rows as tab-separated text: what a spreadsheet and a word processor both accept from the clipboard. */
export function tableTsv(columns, rows) {
  const head = columns.map((c) => (c.sub ? `${c.label} (${c.sub})` : c.label)).join('\t');
  return [head, ...rows.map((r) => r.map((c) => String(c ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t'))].join('\n');
}

/** The same as comma-separated values, quoted where a value needs it. */
export function tableCsv(columns, rows) {
  const q = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => q(c.sub ? `${c.label} (${c.sub})` : c.label)).join(',');
  return [head, ...rows.map((r) => r.map(q).join(','))].join('\n');
}
