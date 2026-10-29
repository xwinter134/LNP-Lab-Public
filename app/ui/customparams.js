// Custom parameters: things a lab records that the app has no field for (a lipid mix number, the room
// temperature, an extruder pass count, who weighed the cholesterol), defined once and then entered per
// formulation, on its record or in bulk on Insights, where they can be plotted and compared like any other
// parameter.
//
// The definitions are one record in the settings collection, so a backup carries them; each formulation keeps
// its values in `batch.custom`, keyed by the parameter's id (not its name, so renaming one keeps its values).
// A value is a number for a numeric parameter and text for a category; an empty box removes it.
import { esc } from './kit.js';

export const CUSTOM_KEY = 'customParams';
/** The definitions, in the order they were made: [{id, name, unit, kind: 'numeric'|'category'}]. */
export function customDefs(store) {
  const rec = store.get('settings', CUSTOM_KEY);
  return Array.isArray(rec?.value) ? rec.value.filter((d) => d && d.id && d.name) : [];
}
export function saveCustomDefs(store, defs) { store.put('settings', { id: CUSTOM_KEY, value: defs }); }

/** A new id that no definition has had: cp1, cp2 … (an id is never reused, so old values cannot attach to a new parameter). */
export function newCustomId(defs, store) {
  const rec = store.get('settings', CUSTOM_KEY);
  const top = Math.max(0, Number(rec?.top) || 0, ...defs.map((d) => Number(/^cp(\d+)$/.exec(d.id)?.[1]) || 0));
  return `cp${top + 1}`;
}

/** What a typed value is stored as: a number for a numeric parameter (decimal comma accepted), text otherwise, null for nothing. */
export function parseCustom(def, raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (def.kind !== 'numeric') return s;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined; // undefined: not a number, refused
}

/** The row field a custom parameter appears under in Insights. */
export const customField = (def) => `cp_${def.id}`;

/** An input for one parameter of one formulation; `name` tells the change handler which. */
export function customInput(def, value, name, { width = 110 } = {}) {
  const v = value == null ? '' : String(value);
  return def.kind === 'numeric'
    ? `<input type="text" inputmode="decimal" name="${esc(name)}" value="${esc(v)}" style="width:${width}px" aria-label="${esc(def.name)}" autocomplete="off">`
    : `<input type="text" name="${esc(name)}" value="${esc(v)}" style="width:${width + 30}px" aria-label="${esc(def.name)}" autocomplete="off" list="cpList_${esc(def.id)}">`;
}

/**
 * The card on a formulation record: one box per custom parameter, stored as it is left (the record's own
 * saver does that, since the inputs sit inside its form and are named cp_<id>). With none defined it says
 * where they are made, in one line, rather than show an empty card.
 */
export function customCard(defs, batch) {
  if (!defs.length) {
    return `<div class="card" id="customCard"><h2>Custom parameters</h2><p class="muted" style="margin:0">Record anything the app has no field for (a lipid mix number, a room temperature, an extruder pass count): define it once under <a href="#/insights?custom=1">Insights › Custom parameters</a>, then fill it in here or for a whole experiment at once there. It can then be plotted against size, PDI and EE.</p></div>`;
  }
  const vals = batch.custom || {};
  return `<div class="card" id="customCard"><h2>Custom parameters</h2><div class="grid g4">${defs.map((d) =>
    `<label>${esc(d.name)}${d.unit ? ` <span class="muted">(${esc(d.unit)})</span>` : ''}<br>${customInput(d, vals[d.id], `cp_${d.id}`, { width: 140 })}</label>`).join('')}</div>
    <p class="muted small" style="margin:6px 0 0">Defined under <a href="#/insights?custom=1">Insights › Custom parameters</a>, where they are plotted and compared like any other parameter.</p></div>`;
}

/**
 * Store one typed value on a batch record. Returns false when a numeric parameter was given text, so the
 * caller can say so instead of storing it.
 */
export function setCustom(batch, def, raw) {
  const v = parseCustom(def, raw);
  if (v === undefined) return false;
  const next = { ...(batch.custom || {}) };
  if (v == null) delete next[def.id]; else next[def.id] = v;
  batch.custom = next;
  return true;
}
