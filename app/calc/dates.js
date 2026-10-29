// Calendar-date helpers on ISO strings (YYYY-MM-DD) that do not depend on the timezone.
// Date#toISOString() is UTC: east of Greenwich, local midnight of a day formats as the previous day, which made
// addDays(d, 1) return d itself and the workday loop never end (reported in Safari and Chrome in Germany).

/** Local calendar date of a Date as YYYY-MM-DD. */
export function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const todayISO = () => toISODate(new Date());
/** Parse YYYY-MM-DD as a local date; invalid input gives today so callers never loop on NaN. */
export function parseISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
}
export function addDays(iso, n) { const d = parseISO(iso); d.setDate(d.getDate() + (Number(n) || 0)); return toISODate(d); }
/** 0 = Sunday … 6 = Saturday */
export const weekday = (iso) => parseISO(iso).getDay();
export const isWeekend = (iso) => [0, 6].includes(weekday(iso));
/** Saturday → Monday, Sunday → Monday, else unchanged. */
export function shiftWeekend(iso) { const wd = weekday(iso); return wd === 6 ? addDays(iso, 2) : wd === 0 ? addDays(iso, 1) : iso; }
/** The date itself if a workday, else the following Monday. */
export function nextWorkday(iso) { return shiftWeekend(iso); }
