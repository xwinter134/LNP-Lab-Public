// A one-sheet .xlsx, without a library (spec 5.3: export as CSV and XLSX).
//
// An .xlsx is a zip of a few XML files. This writes the five a spreadsheet needs, stored uncompressed (zip
// method 0), so the only arithmetic is the CRC-32 each entry carries. Strings go in as inline strings, numbers
// as numbers, so Excel, Numbers and LibreOffice sort and sum them as numbers.

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** A zip archive of {name: string} entries, stored, as a Uint8Array. */
export function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const [name, text] of Object.entries(files)) {
    const data = enc.encode(text), nm = enc.encode(name), crc = crc32(data);
    // version 20, flag 0x0800 (names are UTF-8), method 0, a fixed 1980-01-01 time so the file is the same each run
    const head = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nm.length), ...u16(0)];
    const local = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...head, ...nm]);
    parts.push(local, data);
    central.push(new Uint8Array([0x50, 0x4b, 0x01, 0x02, ...u16(20), ...head, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...nm]));
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const n = Object.keys(files).length;
  const end = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, ...u16(n), ...u16(n), ...u32(cdSize), ...u32(offset), 0, 0]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let at = 0; for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

/** A workbook with one sheet: `header` is a list of strings, `rows` lists of strings, numbers or null. */
export function xlsxBytes(header, rows, sheetName = 'Data') {
  const cell = (v, r, c) => {
    const ref = `${colName(c)}${r}`;
    if (v == null || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
  };
  const line = (vals, r) => `<row r="${r}">${vals.map((v, c) => cell(v, r, c)).join('')}</row>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${[line(header, 1), ...rows.map((r, i) => line(r, i + 2))].join('')}</sheetData></worksheet>`;
  return zipStore({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
  });
}
