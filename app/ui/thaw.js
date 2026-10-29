// The freeze–thaw panel and badge, shared by the lipid stocks, the lipid lots under Materials, the stock weigh-in
// and the formulation record. The counting and the threshold are calc/freezethaw.js; this is the markup and the
// buttons. "Thawed today" is one click, as it is done at the freezer with gloves on; another day, an operator or
// a note go under a fold, and a thaw logged by mistake is taken back from the history.
import { esc, fmtDate, todayISO, chip } from './kit.js';
import { thawsOf, thawCount, withThaw, withoutThaw, thawedOn, lastThaw, overThaw, ftWords } from '../calc/freezethaw.js';

/** A small chip with the count, warning-coloured past the threshold; '' for a record never thawed. */
export function thawChip(rec, limit) {
  const n = thawCount(rec);
  if (!n) return '';
  return chip(`${n} F/T`, overThaw(rec, limit) ? 'warn' : '');
}

/** The line a picker or a list shows beside a stock or lot, as words: "3 freeze–thaw cycles, last 20 Oct". */
export function thawLine(rec, limit) {
  const last = lastThaw(rec);
  return `${ftWords(rec)}${last ? `, last ${fmtDate(last.date)}` : ''}${overThaw(rec, limit) ? ` (more than ${limit}: check it before use)` : ''}`;
}

/**
 * The panel: the count, the warning, "Thawed today", the fold for another day or a note, and the history.
 * `key` names the panel's buttons (data-thaw-key), so two panels on one page are told apart.
 */
export function thawPanel(rec, { key, limit, title = 'Freeze–thaw', operator = '', compact = false } = {}) {
  const today = todayISO(), list = thawsOf(rec), n = list.length, done = thawedOn(rec, today);
  const warn = overThaw(rec, limit);
  const k = esc(key);
  return `<div class="thawPanel${warn ? ' over' : ''}" data-thaw-key="${k}">
    <div class="thawHead"><b>${esc(title)}</b> <span class="thawCount" data-thaw-count="${n}">${esc(ftWords(rec))}</span>${n ? `<span class="muted"> · last ${esc(fmtDate(list[n - 1].date))}${list[n - 1].operator ? ` (${esc(list[n - 1].operator)})` : ''}</span>` : ''}
      ${warn ? `<span class="chip warn">more than ${esc(limit)}: check it before use</span>` : ''}
      <button type="button" class="${done ? '' : 'primary '}thawToday" data-thaw-act="today" data-thaw-key="${k}" title="${done ? 'A thaw is already logged today; this logs another' : 'Log one freeze–thaw cycle, today'}">${done ? 'Thawed again today' : 'Thawed today'}</button></div>
    ${compact ? '' : `<details class="thawMore"><summary class="muted">Another day, or with a note${n ? ` · history (${n})` : ''}</summary>
      <div class="thawForm"><label>Date<input type="date" name="thaw_date" data-thaw-key="${k}" value="${esc(today)}"></label>
        <label>By<input type="text" name="thaw_operator" data-thaw-key="${k}" value="${esc(operator)}" style="width:90px"></label>
        <label style="flex:1 1 160px">Note<input type="text" name="thaw_note" data-thaw-key="${k}" placeholder="optional"></label>
        <button type="button" data-thaw-act="log" data-thaw-key="${k}">Log thaw</button></div>
      ${n ? `<ol class="thawList">${list.map((t, i) => `<li>${esc(fmtDate(t.date))}${t.operator ? ` · ${esc(t.operator)}` : ''}${t.batchId ? ` · for ${esc(t.batchId)}` : ''}${t.note ? ` · <span class="muted">${esc(t.note)}</span>` : ''} <button type="button" class="ghost" data-thaw-act="remove" data-thaw-i="${i}" data-thaw-key="${k}" title="Remove this thaw (logged by mistake)" aria-label="Remove the thaw of ${esc(fmtDate(t.date))}">×</button></li>`).join('')}</ol>` : ''}
    </details>`}
  </div>`;
}

/**
 * Wire the panels with this key inside `root` (once; the listener is on root and reads the key off the button).
 * `get()` returns the record as it is now, `set(next)` keeps the record with its new thaws (stores it, redraws).
 */
export function wireThaw(root, key, { get, set, operator = '' }) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-thaw-act]');
    if (!b || b.dataset.thawKey !== String(key) || !root.contains(b)) return;
    e.preventDefault();
    const rec = get();
    if (!rec) return;
    if (b.dataset.thawAct === 'today') set(withThaw(rec, { date: todayISO(), operator }));
    else if (b.dataset.thawAct === 'log') {
      const val = (n) => root.querySelector(`[name="${n}"][data-thaw-key="${CSS.escape(String(key))}"]`)?.value || '';
      set(withThaw(rec, { date: val('thaw_date') || todayISO(), operator: val('thaw_operator') || operator, note: val('thaw_note') }));
    } else if (b.dataset.thawAct === 'remove') set(withoutThaw(rec, b.dataset.thawI));
  });
}
