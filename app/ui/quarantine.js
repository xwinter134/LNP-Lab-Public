// Screen: Quarantine (spec 6.5). The rows an import refused, each with its raw source, the values it was mapped
// to and the reason in words. Open one, fill in or correct the values, and "Check again" runs it through the same
// check every import uses (app/calc/importcheck.js, through recheckQuarantine in app/calc/importops.js). What
// passes joins the import it came from, under that import's id, so "Undo import" still takes it out with the rest.
//
// Only in the sidebar while something waits here (app/main.js SCREENS, `when`). Nothing is ever deleted from
// quarantine: a row fixed stays as "fixed" with the records it became, one a later import decided as "superseded".
import { esc, table, raw, chip, header, toast, field, fmtDate } from './kit.js';
import { tidySchema } from '../calc/importcheck.js';
import { openQuarantine, recheckQuarantine } from '../calc/importops.js';

const TABLE_WORD = { formulations: 'formulation', measurements: 'measurement', experiments: 'experiment' };
const OPEN_RECORD = (id) => (/^E\d+-F\d+$/.test(id) ? `#/formulation?batch=${encodeURIComponent(id)}` : /^E\d+$/.test(id) ? `#/experiments?id=${encodeURIComponent(id)}` : `#/measurements?id=${encodeURIComponent(id)}`);

export async function render(el, ctx) {
  const id = ctx.params.id;
  if (id && ctx.store.get('quarantine', id)) return detail(el, ctx, ctx.store.get('quarantine', id));
  const all = ctx.store.all('quarantine');
  const only = ctx.params.import || '';
  const open = openQuarantine(ctx.store).filter((q) => !only || q.importId === only);
  const fixed = all.filter((q) => q.status === 'fixed').length, superseded = all.filter((q) => q.status === 'superseded').length;
  el.innerHTML = header('Evaluate', 'Quarantine') +
    `<div class="card"><p id="quarantineSay">${open.length ? `<b>${open.length} row${open.length === 1 ? '' : 's'} an import refused${only ? ` (import ${esc(only)})` : ''}.</b> Open one, correct or fill in what is missing, and check it again.` : '<b>Nothing waits in quarantine.</b>'}
      ${fixed || superseded ? `<span class="muted">${fixed} fixed, ${superseded} decided by a later import.</span>` : ''}</p>
      ${table(['Import', 'Row', 'Reason', ''], open.map((q) => ({
        attrs: `data-q="${esc(q.id)}"`,
        cells: [raw(`${esc(q.importId)}<div class="muted">${esc(TABLE_WORD[q.table] || q.table)}</div>`), raw(`${esc(q.origin?.file?.name || q.file || '')}${q.origin?.sheet ? ` · ${esc(q.origin.sheet)}` : ''} · row ${esc(q.origin?.row ?? q.row)}`),
          q.reason, raw(`<a class="btn" href="#/quarantine?id=${encodeURIComponent(q.id)}">Open</a>`)],
      })), { empty: 'Nothing waits in quarantine.' })}
      <p class="muted">A row lands here when it fails the app's own checks: a lipid name not in the catalogue, mol% not adding up to 100, a value outside what is physically sensible. Nothing here is in your data until it passes.</p></div>`;
}

function detail(el, ctx, q) {
  const fields = tidySchema()[q.table] || [];
  const mapping = q.mapping || {};
  // The fields the row has, and the required ones; the rest of the table's fields fold away until asked for.
  const shown = fields.filter((f) => f.required || (mapping[f.key] != null && mapping[f.key] !== ''));
  const rest = fields.filter((f) => !shown.includes(f));
  const extra = Object.keys(mapping).filter((k) => !fields.some((f) => f.key === k));
  const input = (f) => field({ id: `qf_${f.key}`, label: `${f.key}${f.unit ? ` (${f.unit})` : ''}${f.required ? ' *' : ''}`, type: f.options ? 'select' : 'text',
    value: mapping[f.key] ?? '', options: f.options ? ['', ...f.options] : undefined, hint: f.note || (f.lo != null && f.hi != null ? `${f.lo}–${f.hi}` : '') });
  const source = Array.isArray(q.raw) ? q.raw : q.raw && typeof q.raw === 'object' ? Object.entries(q.raw).map(([k, v]) => `${k}: ${v}`) : null;
  const status = q.status === 'open' ? '' : `<p class="note ${q.status === 'fixed' ? 'ok' : ''}">${q.status === 'fixed' ? `Fixed on ${esc(fmtDate(String(q.fixedAt || '').slice(0, 10)))}: ${(q.recordIds || []).map((r) => `<a href="${OPEN_RECORD(r)}">${esc(r)}</a>`).join(', ')}` : `Decided by a later import: ${esc(q.reason || q.supersededBy || '')}`}</p>`;
  el.innerHTML = header(raw('<a href="#/quarantine">Quarantine</a>'), `Row ${q.origin?.row ?? q.row} of ${q.origin?.file?.name || q.file || 'the import'}`) +
    `<div class="card"><p>${chip(TABLE_WORD[q.table] || q.table)} from import <b>${esc(q.importId)}</b>${q.origin?.sheet ? `, sheet ${esc(q.origin.sheet)}` : ''}</p>
      ${q.status === 'open' ? `<p class="note warn" id="qReason"><b>Refused:</b> ${esc(q.reason)}</p>` : status}
      ${source ? `<details class="fold"><summary><h2>As the sheet had it</h2></summary><p class="muted">${source.map((c) => esc(c ?? '')).join(' · ')}</p></details>` : ''}
      <div class="grid g4" id="qForm">${shown.map(input).join('')}${extra.map((k) => input({ key: k, note: 'not a field of this table; ignored' })).join('')}</div>
      ${rest.length ? `<details class="fold" id="qMore"><summary><h2>More fields</h2><span class="fold-say">${rest.length} the row does not use</span></summary><div class="grid g4">${rest.map(input).join('')}</div></details>` : ''}
      ${q.status === 'open' ? '<div style="margin-top:12px;display:flex;gap:8px"><button class="primary" id="qCheck">Check again</button><a class="btn" href="#/quarantine">Back to the list</a></div>' : ''}
      <p class="muted">Check again runs the same check as the import. When it passes, the ${esc(TABLE_WORD[q.table] || 'row')} joins import ${esc(q.importId)}${q.table === 'formulations' ? ', inside its experiment when that came with the same import' : ''}.</p></div>`;
  el.querySelector('#qCheck')?.addEventListener('click', () => {
    const mapping2 = {};
    el.querySelectorAll('#qForm [name], #qMore [name]').forEach((inp) => { const k = inp.name.replace(/^qf_/, ''); if (inp.value.trim() !== '') mapping2[k] = inp.value.trim(); });
    const r = recheckQuarantine(ctx.store, ctx.data, q.id, mapping2);
    if (r.ok) {
      const first = r.ids.find((x) => /^E\d+-F\d+$/.test(x)) || r.ids[0];
      toast(`Checked and added: ${r.ids.join(', ')}`, 'ok', first ? { action: 'Open', onAction: () => { location.hash = OPEN_RECORD(first); } } : {});
      ctx.navigate('quarantine', {});
      return;
    }
    toast(r.superseded ? `Already in the lab: ${r.reason}` : `Still refused: ${r.reason}`, 'warn');
    detail(el, ctx, ctx.store.get('quarantine', q.id));
  });
}
