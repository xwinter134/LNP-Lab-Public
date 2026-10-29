// A long list renders a page at a time (usability cycle 4, S2). A year of a busy lab is some 500 experiments
// and 2,500 formulations, and a table of every one of them is seconds of layout for rows nobody scrolls to:
// the newest page is what is read. The line under the list says how much it is showing, so a list cut short
// never reads as records gone missing, and one click lists the next page.
import { esc } from './kit.js';

/** How many rows a long table lists at a time. */
export const PAGE_ROWS = 200;

/**
 * The line under a list that is cut short: "200 of 520 experiments listed" and the button that lists the next
 * page. `id` names the button, which the screen wires. Empty when everything is listed.
 */
export function moreLine({ id, shown, total, step = PAGE_ROWS, noun = 'rows' }) {
  if (shown >= total) return '';
  const next = Math.min(step, total - shown);
  return `<div class="pager" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-top:10px">
    <span class="muted" data-pager-count>${shown} of ${total} ${esc(noun)} listed</span>
    <button type="button" id="${esc(id)}">Show ${next} more</button></div>`;
}

const FOCUSABLE = 'a[href], button, input';

/**
 * After the next page is drawn, the keyboard goes on from the first new row rather than back to the top of
 * the page, where the button it pressed has gone. `rows` are the drawn rows (or their controls); `from` is
 * how many were listed before.
 */
export function focusFirstNew(rows, from) {
  const row = rows[from];
  const target = row?.matches?.(FOCUSABLE) ? row : row?.querySelector(FOCUSABLE);
  target?.focus({ preventScroll: true });
}
