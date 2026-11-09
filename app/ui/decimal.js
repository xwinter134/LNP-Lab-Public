// A comma typed as the decimal mark. A number field in a browser whose own mark is the point throws a typed comma
// away, so "88,5" arrived as 885 and passed every check. A browser whose mark is the comma takes the point as well
// (checked in Chromium with a German interface), so the comma can always become a point, whatever the language says:
// the language of the page does not tell which one the number field itself works in.

/** True when a typed key is a comma in a number field. */
export function isCommaInNumber(e) {
  return e.key === ',' && !e.ctrlKey && !e.metaKey && !e.altKey && !!e.target?.matches?.('input[type="number"]');
}

/** Install it once, on the document. Safe to call twice. */
export function installCommaDecimal(doc = document) {
  if (doc.__commaDecimal) return;
  doc.__commaDecimal = true;
  doc.addEventListener('keydown', (e) => {
    if (!isCommaInNumber(e)) return;
    e.preventDefault();
    // insertText puts the point where the cursor is and fires the usual input event.
    if (!doc.execCommand('insertText', false, '.')) {
      const t = e.target; // a browser without it: append, which is where a decimal mark is typed almost always
      t.value = `${t.value}.`;
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, true);
}
