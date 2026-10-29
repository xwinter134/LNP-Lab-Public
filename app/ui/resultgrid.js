// The results grid: the samples of an experiment as rows and the numbers each is due as columns, typed or pasted
// out of a spreadsheet the way a lab sheet is filled in. Measurements opens it on what is due; Design & results
// opens it on the whole experiment, with what is already stored in its cells, so typing a result and seeing
// what it does to the figures and the model happen on one screen.
import { fmt, toast, todayISO, uid, esc, fmtDate } from './kit.js';
import { qcFlags, checkValues, mean, sd } from '../calc/qc.js';
import { TESTS } from '../calc/experiment.js';

const testName = (id) => TESTS.find((t) => t.id === id)?.name || id;

/**
 * The fields the results grid asks for, per test: the number a test is judged by, not every field it can hold.
 * Potency is left out on purpose, because one number without the cell line and the serum condition is not a
 * result anyone could use later.
 */
export const GRID_FIELDS = {
  dls: [['zave_nm', 'Z-ave', 'nm'], ['pdi', 'PDI', '']],
  zeta: [['zeta_mV', 'Zeta', 'mV']],
  ee: [['ee_pct', 'EE', '%']],
  content: [['rna_mg_mL', 'RNA content', 'mg/mL']],
  ph: [['ph', 'pH', '']],
  osmolality: [['mOsm_kg', 'Osmolality', 'mOsm/kg']],
  integrity: [['pct', 'Integrity', '%']],
  lipid_content: [['total_mg_mL', 'Total lipid', 'mg/mL']],
  endotoxin: [['eu_mL', 'Endotoxin', 'EU/mL']],
};

// A typed cell: a decimal comma is a decimal point, the typographic minus some spreadsheets copy out is a
// minus, and a trailing unit is noise; anything else is a mistake, and NaN says so rather than storing it as 0.
export const cellNumber = (s) => {
  const t = String(s).trim().replace(/−/g, '-').replace(',', '.').replace(/\s*(%|nm|mv|mg\/ml)$/i, '');
  return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t) ? Number(t) : NaN;
};

// What a grid save leaves for the grid that is drawn after it: the cells it refused, with what was typed in
// them, and what it did. The screen is rebuilt after saving, and the refused values must survive that.
let gridCarry = null;
// Whether the grid shows three DLS runs per sample. Kept for the session, as gridCarry is, so the redraw a save
// causes leaves the run columns where the user put them.
let gridRuns = false;
// How many DLS runs a grid row takes when the runs are shown: the three the manual form takes.
const GRID_RUNS = 3;

export function saveMeasurement(ctx, settings, m) {
  const rec = { id: uid(), ...m, slotId: m.slot?.id || null, flags: qcFlags(m.test, m.values, settings.qc) };
  delete rec.slot;
  // The result, the slot it closes and the formulation's status are one write: stored together, or undone
  // together and said so, never a result whose slot still reads as open (usability cycle 4, S1).
  return ctx.store.transaction(() => {
    ctx.store.put('measurements', rec);
    if (m.slot) {
      const e = ctx.store.get('experiments', m.slot.experimentId || m.experimentId);
      if (e) { const s = e.expected.find((x) => x.id === m.slot.id); if (s) { s.status = 'done'; s.measurementId = rec.id; } ctx.store.put('experiments', e); }
    }
    const b = m.batchId ? ctx.store.get('batches', m.batchId) : null;
    if (b && ['planned', 'produced'].includes(b.status)) { b.status = 'measured'; ctx.store.put('batches', b); }
    return rec;
  }, { what: `the result for ${rec.sampleName || rec.batchId || 'the sample'}` });
}

/**
 * Every waiting sample of the experiment (or of the due line it was opened from) as a row, with one cell per
 * number still due. This is for the results
 * that come off an instrument without an export worth the name (a plate reader's EE, a pH meter): typing 58
 * EE values one form at a time was three actions each. The columns are typed one test at a time, so Tab and
 * Enter go down a column, and a column copied out of Excel lands in one paste.
 */
export function gridHtml(all, settings, overdue = 0, { done = false } = {}) {
  // With `done`, a row also carries the results already stored for it (r.done[test], a measurement), shown in
  // their cells as they are, so the table reads as the experiment's whole data sheet and not only what is left.
  const due = new Set(all.flatMap((r) => [...r.tests, ...(done ? Object.keys(r.done || {}) : [])]));
  // DLS takes its runs (usability cycle 3, F2): typed as one number, a result had n = 1 and no SD on the
  // Results card, while an instrument file keeps every run. Its Z-ave and PDI each get a column per run, the
  // first of which is the single value the grid always took and the others hidden until "+ runs" shows them, so
  // typing one number per sample is what it was and nothing typed is lost by showing or hiding the runs.
  const cols = Object.entries(GRID_FIELDS).filter(([t]) => due.has(t))
    .flatMap(([test, fs]) => fs.flatMap(([key, label, unit]) => (test === 'dls'
      ? Array.from({ length: GRID_RUNS }, (_, k) => ({ test, key, label, unit, run: k + 1 }))
      : [{ test, key, label, unit }])));
  const left = [...due].filter((t) => !GRID_FIELDS[t]);
  // A sample waiting only for something the grid does not take would be a row of dashes.
  const rows = all.filter((r) => [...r.tests, ...(done ? Object.keys(r.done || {}) : [])].some((t) => GRID_FIELDS[t]));
  const today = todayISO();
  // The run columns are classed on every cell, header and dash alike, so that one class on the grid shows or
  // hides them; kit.table() cannot class a cell, so the grid writes its own table.
  const runCls = (c) => (c.run > 1 ? 'xrun' : c.run === 1 ? 'run1' : '');
  const th = (c) => `<th class="${runCls(c)}" style="text-align:right">${esc(c.label)}${c.run === 1 ? '<span class="runNo"> 1</span>' : c.run ? ` ${c.run}` : ''}${c.unit ? `<div class="muted" style="font-weight:400;font-size:11px;margin-top:1px">${esc(c.unit)}</div>` : ''}</th>`;
  const label = (r, c) => `${r.sampleName} ${c.label}${c.run > 1 || (c.run === 1 && gridRuns) ? ` run ${c.run}` : ''}`;
  const td = (r, i, c, j) => `<td class="${runCls(c)}" style="text-align:right">${r.slots[c.test]?.status === 'done' || (!r.slots[c.test] && r.done?.[c.test])
    ? storedCell(r.done?.[c.test], c)
    : r.slots[c.test]
    ? `<input class="gcell" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-row="${i}" data-col="${j}" data-test="${c.test}" data-key="${c.key}"${c.run ? ` data-run="${c.run}"` : ''} data-slot="${esc(r.slots[c.test].id)}" aria-label="${esc(label(r, c))}">`
    : '<span class="muted" title="not due for this sample">–</span>'}</td>`;
  const body = rows.map((r, i) => `<tr data-sample="${esc(r.sampleName)}">
    <td><span data-wait-name="${esc(r.sampleName)}" style="font-family:ui-monospace,Menlo,monospace;font-size:12px">${esc(r.sampleName)}</span></td>
    <td>${!r.tests.length ? `<span class="muted" title="measured">${fmtDate(Object.values(r.done || {})[0]?.date || '')}</span>` : r.dueDate < today ? `<span class="chip warn">${fmtDate(r.dueDate)}</span>` : fmtDate(r.dueDate)}</td>
    ${cols.map((c, j) => td(r, i, c, j)).join('')}</tr>`).join('');
  const runsTool = cols.some((c) => c.run) ? `<div class="gridTools"><button type="button" id="gridRuns" aria-pressed="${gridRuns}">${gridRuns ? '− runs' : '+ runs'}</button>
    <span class="muted">DLS: up to ${GRID_RUNS} runs per sample, stored with their mean and SD.</span></div>` : '';
  // A sheet with every result in is read, not typed into: no instructions, no run columns, no Save.
  const typing = rows.some((r) => r.tests.some((t) => GRID_FIELDS[t]));
  if (!typing) return rows.length ? `<div class="rgrid" id="resultGrid"><div style="overflow-x:auto"><table>
      <thead><tr><th>Sample name</th><th>Measured</th>${cols.filter((c) => !(c.run > 1)).map((c) => th({ ...c, run: undefined })).join('')}</tr></thead><tbody>${rows.map((r, i) => `<tr data-sample="${esc(r.sampleName)}">
    <td><span style="font-family:ui-monospace,Menlo,monospace;font-size:12px">${esc(r.sampleName)}</span></td>
    <td><span class="muted">${fmtDate(Object.values(r.done || {})[0]?.date || '')}</span></td>
    ${cols.filter((c) => !(c.run > 1)).map((c, j) => td(r, i, { ...c, run: undefined }, j)).join('')}</tr>`).join('')}</tbody></table></div></div>` : '';
  return `<p class="muted">Type the numbers in, or paste a column straight out of Excel into its first cell and it fills down, one line per sample in the order shown. Tab and Enter go down the column. Empty cells are skipped, and nothing is stored until <b>Save all</b>. ${overdue ? `<b>${overdue}</b> of these ${overdue === 1 ? 'is' : 'are'} past due.` : ''}</p>
    ${rows.length ? `${runsTool}<div class="rgrid${gridRuns ? ' runsOn' : ''}" id="resultGrid"><div style="overflow-x:auto"><table>
      <thead><tr><th>Sample name</th><th>${done ? 'Due / measured' : 'Due'}</th>${cols.map(th).join('')}</tr></thead><tbody>${body}</tbody></table></div></div>` : '<div class="note">Nothing this experiment is waiting for is a single number.</div>'}
    ${left.length ? `<p class="muted">${esc(left.map(testName).join(', '))} ${left.length === 1 ? 'is' : 'are'} not in the grid: a single number without the cell line and conditions is not a result. Enter ${left.length === 1 ? 'it' : 'them'} under <i>Type one result</i>.</p>` : ''}
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">
      ${rows.length ? '<button class="primary" id="gridSave">Save all</button>' : ''}
      <input type="date" id="gridDate" value="${today}" style="width:auto" aria-label="Date measured"><input type="text" id="gridOperator" value="${esc(settings.operator)}" style="width:80px" aria-label="Operator">
      ${done ? '' : '<button id="gridClose">Close the grid</button>'}</div>
    <div id="gridMsg"></div>`;
}

/**
 * Keys, paste and Save all for the results grid, when it is open. `redraw` draws the screen again after a
 * save; the cells it refused come back with what was typed in them.
 */
export function wireGrid(el, ctx, settings, openSlots, redraw) {
  const grid = el.querySelector('#resultGrid');
  if (!grid) { gridCarry = null; return; }
  const cells = [...grid.querySelectorAll('input.gcell')];
  const msg = (h) => { el.querySelector('#gridMsg').innerHTML = h; };
  // Tab and a paste go past a hidden run column. What was typed into one before it was hidden is still saved,
  // and hiding it says so: a run dropped without a word because a column was folded away is a run lost.
  const shown = (c) => !(+c.dataset.run > 1) || grid.classList.contains('runsOn');
  const column = (j) => cells.filter((c) => +c.dataset.col === j && shown(c));
  const ncols = cells.reduce((m, c) => Math.max(m, +c.dataset.col + 1), 0);
  const runsBtn = el.querySelector('#gridRuns');
  runsBtn?.addEventListener('click', () => {
    gridRuns = !grid.classList.contains('runsOn');
    grid.classList.toggle('runsOn', gridRuns);
    runsBtn.textContent = gridRuns ? '− runs' : '+ runs';
    runsBtn.setAttribute('aria-pressed', String(gridRuns));
    // With the runs shown, the first Z-ave and PDI cells are run 1 and are read out as such.
    for (const c of cells) if (c.dataset.run === '1') c.setAttribute('aria-label', c.getAttribute('aria-label').replace(/ run 1$/, '') + (gridRuns ? ' run 1' : ''));
    const held = new Set(cells.filter((c) => !shown(c) && c.value.trim()).map((c) => c.dataset.slot)).size;
    msg(held ? `<div class="note warn" id="gridHeld">The hidden runs still hold values for ${held} sample${held === 1 ? '' : 's'}, and <b>Save all</b> saves them. Show the runs to see or clear them.</div>` : '');
  });
  // Down the column, and from its foot to the head of the next: a column is one test, and a test's results
  // arrive together. The cell after the last one is Save all.
  const step = (from, dir) => {
    const col = column(+from.dataset.col), i = col.indexOf(from);
    if (col[i + dir]) return col[i + dir];
    for (let j = +from.dataset.col + dir; j >= 0 && j < ncols; j += dir) { const c = column(j); if (c.length) return dir > 0 ? c[0] : c[c.length - 1]; }
    return null;
  };
  grid.addEventListener('keydown', (e) => {
    if (!e.target.classList?.contains('gcell')) return;
    const dir = e.key === 'Enter' || e.key === 'Tab' ? (e.shiftKey ? -1 : 1) : e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    const next = step(e.target, dir);
    if (next) { e.preventDefault(); next.focus(); next.select(); }
    else if (dir > 0 && e.key !== 'ArrowDown') { e.preventDefault(); el.querySelector('#gridSave').focus(); }
  });
  grid.addEventListener('input', (e) => e.target.classList?.remove('invalid'));
  // A block copied out of Excel arrives as lines (and tabs, for more than one column). It goes in one line per
  // sample from the cell it was pasted into, and to the right for further columns, so a column typed in the
  // spreadsheet in the order "Copy sample names" gave lands on the right rows. A single value pastes as usual.
  grid.addEventListener('paste', (e) => {
    const t = e.target;
    if (!t.classList?.contains('gcell')) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
    if (lines.length < 2 && !lines[0].includes('\t')) return;
    e.preventDefault();
    const r0 = +t.dataset.row;
    // Further columns of the block go into the next columns on screen, past any run columns that are hidden.
    const onScreen = [...new Set(cells.filter(shown).map((c) => +c.dataset.col))].sort((p, q) => p - q);
    const at = onScreen.indexOf(+t.dataset.col);
    let put = 0, lost = 0;
    lines.forEach((line, dr) => line.split('\t').forEach((v, dc) => {
      const col = onScreen[at + dc];
      const cell = col == null ? null : grid.querySelector(`input.gcell[data-row="${r0 + dr}"][data-col="${col}"]`);
      if (cell) { cell.value = v.trim(); cell.classList.remove('invalid'); put++; } else if (v.trim()) lost++;
    }));
    msg(lost ? `<div class="note warn">${lost} of the pasted values had no cell to go into (past the last sample, or a test that sample is not due) and were left out.</div>` : '');
  });

  el.querySelector('#gridSave')?.addEventListener('click', () => {
    const date = el.querySelector('#gridDate').value || todayISO(), operator = el.querySelector('#gridOperator').value;
    // One result per sample and test: a Z-ave and a PDI typed on the same row, in one run or three, are one DLS
    // measurement.
    const bySlot = new Map();
    for (const c of cells) if (c.value.trim()) { if (!bySlot.has(c.dataset.slot)) bySlot.set(c.dataset.slot, []); bySlot.get(c.dataset.slot).push(c); }
    if (!bySlot.size) { msg('<div class="note warn">Type a value first.</div>'); return; }
    let saved = 0;
    const savedFor = new Set();
    const refused = [];
    for (const [slotId, inputs] of bySlot) {
      const slot = openSlots.find((s) => s.id === slotId);
      if (!slot) continue;
      // A row typed in more than its first run is stored as runs; one typed in the first run alone is the
      // single value the grid always stored, so showing the run columns changes nothing until they are used.
      const asRuns = inputs.some((c) => +c.dataset.run > 1);
      const values = {}, errors = [], runs = new Map();
      for (const c of inputs) {
        const x = cellNumber(c.value), run = asRuns ? +c.dataset.run || null : null;
        if (Number.isNaN(x)) errors.push({ key: c.dataset.key, run, text: `${run ? `run ${run}: ` : ''}"${c.value.trim()}" is not a number` });
        else if (run) { if (!runs.has(run)) runs.set(run, {}); runs.get(run)[c.dataset.key] = x; }
        else values[c.dataset.key] = x;
      }
      if (asRuns) {
        // As the manual form stores them (render(), "Runs"): the runs with a Z-ave, their mean as the value,
        // and the SD of the Z-ave. A PDI typed without its run's Z-ave would be dropped there; here it is refused.
        const nums = [...runs.keys()].sort((p, q) => p - q);
        for (const k of nums) if (runs.get(k).zave_nm == null && !errors.some((e) => e.run === k)) errors.push({ key: 'pdi', run: k, text: `run ${k}: a PDI without its Z-ave` });
        const kept = nums.filter((k) => runs.get(k).zave_nm != null);
        values.runs = kept.map((k) => ({ zave_nm: runs.get(k).zave_nm, pdi: runs.get(k).pdi ?? null }));
        values.zave_nm = mean(values.runs.map((r) => r.zave_nm));
        values.pdi = mean(values.runs.map((r) => r.pdi));
        values.zave_sd = sd(values.runs.map((r) => r.zave_nm));
        // checkValues counts the runs it was given; the grid names them by the column they were typed in.
        errors.push(...checkValues(slot.test, values).errors.map((e) => (e.run == null ? e
          : { ...e, run: kept[e.run], text: e.text.replace(/^run \d+/, `run ${kept[e.run]}`) })));
      } else errors.push(...checkValues(slot.test, values).errors);
      if (errors.length) { refused.push({ slot, inputs, errors }); continue; }
      saveMeasurement(ctx, settings, { slot, batchId: slot.batchId, experimentId: slot.experimentId, stage: slot.stage, test: slot.test, values, date, operator, sampleName: slot.sampleName, raw: null, condition: slot.condition, timepoint: slot.timepoint, formulation: slot.formulation });
      saved++;
      if (slot.experimentId) savedFor.add(slot.experimentId);
    }
    // Saved rows leave the grid when it is drawn again; refused ones stay, with what was typed and why.
    gridCarry = {
      saved, savedFor: [...savedFor],
      cells: refused.flatMap((r) => r.inputs.map((c) => ({ slot: c.dataset.slot, key: c.dataset.key, run: c.dataset.run || '', value: c.value,
        invalid: r.errors.some((e) => e.key === c.dataset.key && (e.run == null || e.run === +c.dataset.run)) }))),
      reasons: refused.flatMap((r) => r.errors.map((e) => `${r.slot.sampleName}: ${e.text}`)),
    };
    const elsewhere = saved && !location.hash.startsWith('#/doe') && savedFor.size === 1;
    toast(`Saved ${saved} result${saved === 1 ? '' : 's'}${refused.length ? `; ${refused.length} refused` : ''}`, refused.length ? 'warn' : 'ok',
      elsewhere ? { action: 'See the results', onAction: () => { location.hash = `#/doe?id=${encodeURIComponent([...savedFor][0])}`; } } : {});
    redraw();
  });

  if (gridCarry) {
    const c = gridCarry; gridCarry = null;
    for (const v of c.cells) {
      const inp = cells.find((x) => x.dataset.slot === v.slot && x.dataset.key === v.key && (x.dataset.run || '') === v.run);
      if (inp) { inp.value = v.value; inp.classList.toggle('invalid', v.invalid); }
    }
    // A refused run is shown, whether or not the runs were when Save all was pressed.
    if (c.cells.some((v) => +v.run > 1 && v.invalid) && !grid.classList.contains('runsOn')) runsBtn?.click();
    msg(`<div class="note ${c.reasons.length ? 'warn' : 'ok'}" id="gridReport">Saved ${c.saved} result${c.saved === 1 ? '' : 's'}.${
      // Where they show: on Measurements the figures are a screen away, so the way there is in the message. On
      // Design & results the figures are beside the grid and have already redrawn.
      c.saved && !location.hash.startsWith('#/doe') ? ` ${c.savedFor.map((id) => `<a href="#/doe?id=${encodeURIComponent(id)}">See the results of ${esc(id)}</a>`).join(' · ')}` : ''}${c.reasons.length ? ` <b>Not saved</b>, still in the grid:<br>${c.reasons.map(esc).join('<br>')}` : ''}</div>`);
  }
}


/**
 * A stored result in its grid cell: the number, as the results list shows it, linked to the result itself,
 * where it can be corrected with a reason. A cell that could be typed over would make a correction look like an
 * entry, and an entry is never a correction (the history of a result is kept, README "Data and backups").
 */
function storedCell(m, c) {
  if (!m) return '<span class="muted">–</span>';
  const v = m.values || {};
  const x = c.run ? (c.run === 1 && !(v.runs || []).length ? v[c.key] : v.runs?.[c.run - 1]?.[c.key]) : v[c.key];
  const dp = c.key === 'pdi' ? 3 : c.key === 'rna_mg_mL' || c.key === 'total_mg_mL' ? 3 : 1;
  const shown = x == null ? '–' : fmt(x, dp);
  const flagged = (m.flags || []).length;
  return `<a class="gstored${flagged ? ' flagged' : ''}" href="#/measurements?id=${esc(m.id)}" title="Stored ${esc(fmtDate(m.date))}${flagged ? ' · ' + esc(m.flags.join(', ')) : ''} — open to correct it">${shown}</a>`;
}
