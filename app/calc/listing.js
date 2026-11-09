// Small text rules for the Experiments list (pure, so they are tested): which name is worth showing next to the
// type, and a verdict short enough for one line.
import { TYPES, typeShort } from './experiment.js';

/**
 * Whether an experiment's name only repeats its type ("Reference reproducibility", "DoE · 2026-11-09",
 * "Optimization · DoE (2 to n factors) 3"): then the list shows the type once and no name.
 */
export function nameRepeatsType(name, type) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return true;
  const labels = [TYPES.find((t) => t.id === type)?.name, typeShort(type)].filter(Boolean).map((s) => s.toLowerCase());
  for (const l of labels) {
    if (n.startsWith(l)) {
      const rest = n.slice(l.length);
      // what is left is only a separator, a number or a date
      if (/^[\s·.\-–—\d:/#]*$/.test(rest)) return true;
    }
  }
  return false;
}

/** A verdict cut at a word to fit one line, with an ellipsis; its first sentence only. */
export function shortVerdict(text, max = 90) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  const dot = t.search(/[.!?](\s|$)/);
  if (dot > 0) t = t.slice(0, dot);
  if (t.length > max) { const paren = t.indexOf(' ('); if (paren >= 20) t = t.slice(0, paren); } // a bracketed aside goes first
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)).replace(/[\s,;:·-]+$/, '') + '…';
}
