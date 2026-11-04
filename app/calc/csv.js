// One CSV cell, the same way in every export the app writes (Data, results, design tables, the blank sample
// sheet, the optimizer's account, Insights).
//
// Quoted when it holds a separator, a quote or a line break (comma, semicolon and tab included, since a German
// Excel splits on the semicolon). And kept from running as a formula: text from a record (a sample name, a
// remark, a label, all of which an imported file or a backup can bring) that starts with = + - @ would be a live
// formula once the CSV is opened in Excel or Numbers (CSV injection, OWASP). Such a cell is written with a
// leading apostrophe, which the spreadsheet shows as text. A number stays a number: -35 or +1.5e3 is left alone.

const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** A value as one CSV cell. */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (FORMULA_START.test(s) && !NUMBER.test(s.trim())) s = `'${s}`;
  return /[",;\t\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A row of values as one CSV line. */
export const csvLine = (values) => values.map(csvCell).join(',');
