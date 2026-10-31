// The provenance symbol of a detail view (spec 4.3): a small mark beside the title of a formulation, a
// measurement or a composition that says at a glance whether it was typed in or came from a file, and opens, on a
// click, every detail the record keeps of where it came from (calc/provenance.js provenanceDetails).
//
// A <details> element rather than a popup with its own script: it opens and closes with a click or the keyboard,
// needs no wiring on screens that are drawn again and again, and prints as what it shows.
import { esc } from './kit.js';
import { provenanceOf, provenanceDetails, SOURCES } from '../calc/provenance.js';

// A sheet of paper with a corner folded: "where this record came from". Shaded when it came from a file.
const icon = (filled) => `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px"><path d="M5 2.8h6.5L15 6.3v10.9H5z"${filled ? ' fill="currentColor" fill-opacity=".22"' : ''}/><path d="M11.5 2.8v3.5H15"/></svg>`;

/** The symbol and its panel, for a record that may carry `provenance`. */
export function provenanceBadge(rec, { id = '' } = {}) {
  const p = provenanceOf(rec), word = SOURCES[p.source] || p.source;
  const rows = provenanceDetails(rec).map((d) => `<tr data-prov="${esc(d.key)}"><th style="text-align:left;font-weight:500;padding:2px 10px 2px 0;white-space:nowrap">${esc(d.label)}</th><td style="padding:2px 0;${d.key === 'sha256' ? 'font-family:ui-monospace,monospace;font-size:11px;word-break:break-all' : ''}">${d.value == null ? '<span class="muted">–</span>' : esc(d.value)}</td></tr>`).join('');
  return `<details class="provBadge"${id ? ` id="${esc(id)}"` : ''} style="display:inline-block;position:relative;vertical-align:middle">
    <summary title="Where this record came from: ${esc(word)}" aria-label="Provenance: ${esc(word)}" style="list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:400;color:var(--ink2);padding:2px 7px;border:1px solid var(--line);border-radius:999px">${icon(p.source !== 'manual')}<span>${esc(word)}</span></summary>
    <div class="provPanel" style="position:absolute;z-index:20;left:0;top:calc(100% + 4px);min-width:260px;max-width:min(420px,80vw);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;box-shadow:0 4px 16px rgba(0,0,0,.12);font-size:12.5px;font-weight:400;text-align:left">
      <table style="width:100%;border-collapse:collapse;margin:0">${rows}</table></div></details>`;
}
