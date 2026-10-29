// Freeze–thaw cycles of what sits in the freezer between uses: lipid stocks (lipids in ethanol at −20 °C) and the
// lots of lipids the lab chooses to track (an ionizable lipid aliquoted in ethanol, say). Pure; no DOM, no store.
//
// A cycle is counted when the material is thawed: each thaw is one entry, {date, operator, note, at, batchId?},
// in the record's own `thaws` list, oldest first. The count is the length of the list, not a number kept beside
// it, so a thaw logged by mistake is taken back by removing its entry and the count cannot drift from the
// history it summarises. The warning threshold is a setting (Settings › Defaults, "Warn after … freeze–thaw
// cycles", 5 to start with): past it, every place the stock or lot is chosen says so.

export const DEFAULT_FT_WARN = 5;

/** The thaws on record, oldest first; [] for a record that has none (every record made before this existed). */
export const thawsOf = (rec) => (Array.isArray(rec?.thaws) ? rec.thaws.filter((t) => t && t.date) : []);

/** How many freeze–thaw cycles a stock or lot has been through. */
export const thawCount = (rec) => thawsOf(rec).length;

/** The record with one thaw more. A new object; the date defaults to today (ISO), the time of logging is kept. */
export function withThaw(rec, { date, operator = '', note = '', batchId = null } = {}, now = new Date()) {
  const t = { date: date || now.toISOString().slice(0, 10), operator: String(operator || ''), note: String(note || ''), at: now.toISOString() };
  if (batchId) t.batchId = batchId;
  // In date order, so the history reads as it happened even when a thaw is logged a day late.
  const thaws = [...thawsOf(rec), t].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.at || '').localeCompare(String(b.at || '')));
  return { ...rec, thaws };
}

/** The record without the thaw at index i (as thawsOf lists them): for one logged by mistake. */
export function withoutThaw(rec, i) {
  const thaws = thawsOf(rec).filter((_, k) => k !== Number(i));
  return { ...rec, thaws };
}

/** Whether a thaw is already logged on that day (ISO date): the "Thawed today" button then says so instead. */
export const thawedOn = (rec, date) => thawsOf(rec).some((t) => t.date === date);

/** The last thaw, or null. */
export const lastThaw = (rec) => { const t = thawsOf(rec); return t.length ? t[t.length - 1] : null; };

/** Past the threshold? A threshold that is not a positive number switches the warning off. */
export function overThaw(rec, limit = DEFAULT_FT_WARN) {
  const n = thawCount(rec), lim = Number(limit);
  return Number.isFinite(lim) && lim > 0 && n > lim;
}

/** " · 3 F/T" for a picker's label, with a warning sign past the threshold; '' for a record never thawed. */
export function ftTag(rec, limit = DEFAULT_FT_WARN) {
  const n = thawCount(rec);
  if (!n) return '';
  return ` · ${n} F/T${overThaw(rec, limit) ? ' ⚠' : ''}`;
}

/** "3 freeze–thaw cycles" / "1 freeze–thaw cycle" / "never thawed". */
export function ftWords(rec) {
  const n = thawCount(rec);
  return n ? `${n} freeze–thaw cycle${n === 1 ? '' : 's'}` : 'not thawed yet';
}

/** Whether a lipid is one whose lots are tracked (Materials › Lipids & lots, "Track freeze–thaw"). */
export const tracksThaw = (lipid) => lipid?.trackFT === true;
