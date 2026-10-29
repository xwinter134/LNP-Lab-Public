// Lipid classes in colour: one colour per class, the same on every screen, and never the colour alone.
//
// The palette is Okabe–Ito, chosen to stay apart for the common forms of colour blindness (red–green above all):
// ionizable blue, helper orange, sterol bluish green, PEG reddish purple, anything else grey. Even so, a colour is
// only a second cue. Every mark carries the class's letter as well (I, H, S, P, O), and a chip spells the class
// out, so a printout in black and white, a screen reader or a reader who cannot tell orange from green loses
// nothing.
//
// Contrast: the fills are the same in light and dark theme, and the letter or word on a fill is dark or white,
// whichever reads better on that fill (white on the blue, near-black on the others, all at 4.5:1 or more). The
// mark's contrast is with itself, so it does not depend on the page behind it. The CSS for the marks is the
// "Materials: lipid classes" block at the end of the style sheet in index.html; the colours are also here, for
// the inline SVG bar, which cannot read a class name.

import { esc } from './kit.js';

/** class → {color, ink (text on the fill), letter, label}. `other` covers a missing or unknown class. */
export const LIPID_CLASSES = {
  ionizable: { color: '#0072B2', ink: '#FFFFFF', letter: 'I', label: 'ionizable' },
  helper: { color: '#E69F00', ink: '#1C1C1E', letter: 'H', label: 'helper' },
  sterol: { color: '#009E73', ink: '#1C1C1E', letter: 'S', label: 'sterol' },
  peg: { color: '#CC79A7', ink: '#1C1C1E', letter: 'P', label: 'PEG-lipid' },
  other: { color: '#A3A3A8', ink: '#1C1C1E', letter: 'O', label: 'other' },
};
/** The order a recipe is written in, and the order of the bar's segments. */
export const CLASS_ORDER = ['ionizable', 'helper', 'sterol', 'peg', 'other'];

const known = (cls) => (LIPID_CLASSES[cls] ? cls : 'other');
export const lipidClassColor = (cls) => LIPID_CLASSES[known(cls)].color;
export const lipidClassInfo = (cls) => LIPID_CLASSES[known(cls)];

/** "I · ionizable" on the class colour: for a table column that names the class. */
export function lipidClassChip(cls) {
  const k = known(cls), c = LIPID_CLASSES[k];
  return `<span class="lc lc-${k}" title="Lipid class: ${esc(c.label)}">${c.letter} · ${esc(c.label)}</span>`;
}

/** The letter alone in a small square of the class colour, before a lipid's name. */
export function lipidClassMark(cls) {
  const k = known(cls), c = LIPID_CLASSES[k];
  return `<span class="lc-mark lc-${k}" title="${esc(c.label)}" aria-label="${esc(c.label)}">${c.letter}</span>`;
}

/** A lipid's name with its class mark: "[I] DLin-MC3-DMA". `ref` is getRef(ctx). */
export function lipidNameMarked(ref, key, suffix = '') {
  const l = ref.lipidByKey?.[key];
  return `<span class="lc-name">${lipidClassMark(l?.class)}${esc(l?.name || key)}${suffix ? ' ' + esc(suffix) : ''}</span>`;
}

/**
 * A recipe as one bar, mol% coloured by class with each class's letter on its segment, and the lipids named
 * underneath with their marks: "[I] MC3 50 · [H] DSPC 10 · …". Classes keep the order a recipe is written in, so
 * two recipes compare at a glance. A segment too narrow for its letter leaves it out; the names below still say it.
 */
export function compositionBar(molPct, ref, { names = true } = {}) {
  const entries = Object.entries(molPct || {}).filter(([, v]) => Number(v) > 0);
  const sum = entries.reduce((s, [, v]) => s + Number(v), 0);
  if (!entries.length || !(sum > 0)) return '<span class="muted">no lipids</span>';
  const clsOf = (k) => known(ref.lipidByKey?.[k]?.class);
  const sorted = entries.slice().sort((a, b) => CLASS_ORDER.indexOf(clsOf(a[0])) - CLASS_ORDER.indexOf(clsOf(b[0])));
  // Scaled to the recipe's own total, so a recipe at 98 % still fills the bar; the sum is shown beside it anyway.
  const segs = sorted.map(([k, v]) => {
    const cls = clsOf(k), c = LIPID_CLASSES[cls], w = (Number(v) / sum) * 100;
    const name = ref.lipidByKey?.[k]?.name || k;
    return `<span class="lc-seg lc-${cls}" style="width:${w.toFixed(2)}%" title="${esc(name)} ${esc(String(v))} mol% (${esc(c.label)})">${w >= 6 ? c.letter : ''}</span>`;
  }).join('');
  const list = names ? `<div class="lc-names">${sorted.map(([k, v]) => lipidNameMarked(ref, k, String(v))).join('<span class="lc-sep">·</span>')}</div>` : '';
  return `<div class="lc-bar" role="img" aria-label="${esc(sorted.map(([k, v]) => `${ref.lipidByKey?.[k]?.name || k} ${v} mol%`).join(', '))}">${segs}</div>${list}`;
}

/** The legend for a screen that uses the marks: one chip per class. */
export const lipidClassLegend = () => `<div class="lc-legend">${CLASS_ORDER.map(lipidClassChip).join('')}</div>`;
