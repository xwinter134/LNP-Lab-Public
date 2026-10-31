// The results grid of the Measurements screen (spec 9.3), on when Settings › "Enter results as a grid" is.
//
// One row per formulation of the chosen experiment, one column per quantity, typed in as in a spreadsheet: Tab
// goes right, Enter goes down, a block copied out of Excel lands from the cell it is pasted into. A cell takes up
// to three replicates ("82; 85; 80"), and says as it is typed what they come to and whether the number is
// worth a second look. One "Save all" stores the whole grid as one write, and "Undo" takes that write back.
//
// What a cell says and what a row stores are worked out in app/calc/gridentry.js, so the rules can be tested
// without a browser, and the import preview draws its cells with the same functions.
import { esc, toast, todayISO } from './kit.js';
import { TEST_LABEL } from '../calc/evaluate.js';
import { describeId, sampleName } from '../schema.js';
import { GRID_COLUMNS, COLUMN_BY_ID, columnsForTests, parseCell, parseClipboard, distributePaste, rowResults, cellState, cellSummary, cellTextOf, undoGridSave } from '../calc/gridentry.js';

// What was typed, kept across the redraws a save, a column change or another experiment causes: a value typed
// and not yet saved is not lost because the screen was drawn again. Keyed by experiment, stage, row and column.
const typed = new Map();
// The last save, for its Undo; and whether the card was open, so a redraw leaves it as the user left it.
let lastSave = null;
let cardOpen = null;
// The columns chosen per experiment for this session; the address carries them too (egcols).
const chosenCols = new Map();

const keyOf = (expId, stage, rowKey, colId) => `${expId}|${stage}|${rowKey}|${colId}`;
const stageDay = (s) => Number(/^T(\d+)$/.exec(s)?.[1] ?? NaN);
const stageOrder = (a, b) => (a === 'final' ? -1 : b === 'final' ? 1 : 0) || stageDay(a) - stageDay(b) || String(a).localeCompare(String(b));

/**
 * The rows of the grid for one experiment and stage: each formulation once, or once per storage condition when
 * the stage is a stability pull. A row keeps the open slot of every test it is still due at that stage (which a
 * save closes) and the results already stored there (shown faintly in their cells).
 */
export function gridRows(exp, stage, batches, measurements) {
  const slots = (exp.expected || []).filter((s) => s.stage === stage);
  const rows = new Map();
  const add = (batchId, condition, slot) => {
    const key = condition ? `${batchId}|${condition}` : batchId;
    if (!rows.has(key)) rows.set(key, { key, batchId, condition: condition || null, timepoint: slot?.timepoint ?? null, sampleName: slot?.sampleName || sampleName({ batchId, stage }), open: {}, stored: {} });
    const r = rows.get(key);
    if (slot?.status === 'open') r.open[slot.test] ||= slot;
    return r;
  };
  for (const id of exp.batchIds || []) {
    const mine = slots.filter((s) => s.batchId === id);
    if (mine.length) mine.forEach((s) => add(id, s.condition, s));
    else if (batches.some((b) => b.id === id)) add(id, null, null);
  }
  for (const m of measurements) {
    if (m.experimentId !== exp.id || (m.stage || 'final') !== stage) continue;
    const r = rows.get(m.condition ? `${m.batchId}|${m.condition}` : m.batchId);
    if (r) r.stored[m.test] = m;
  }
  return [...rows.values()];
}

/** The stage the grid opens on: the one with the earliest open slot, else "final". */
function defaultStage(exp) {
  const open = (exp.expected || []).filter((s) => s.status === 'open').sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  return open[0]?.stage || ((exp.expected || []).some((s) => s.stage === 'final') ? 'final' : (exp.expected || [])[0]?.stage || 'final');
}

/** The experiment, stage and columns the grid shows, from the address and what the session chose. */
function choice(ctx, experiments) {
  const p = ctx.params;
  const withOpen = experiments.filter((e) => (e.expected || []).some((s) => s.status === 'open'));
  const exp = experiments.find((e) => e.id === p.egexp) || experiments.find((e) => e.id === p.waiting) || withOpen[0] || experiments[0] || null;
  if (!exp) return null;
  const stages = [...new Set((exp.expected || []).map((s) => s.stage))].sort(stageOrder);
  if (!stages.length) stages.push('final');
  const stage = stages.includes(p.egstage) ? p.egstage : defaultStage(exp);
  const fromHash = String(p.egcols || '').split(',').filter((c) => COLUMN_BY_ID[c]);
  const cols = fromHash.length ? fromHash : chosenCols.get(exp.id) || columnsForTests([...new Set((exp.expected || []).map((s) => s.test))]);
  return { exp, stages, stage, cols };
}

/** The card. `open` comes from the address (a link that asks for the grid) or the session. */
export function entryCard(ctx, settings, experiments, batches, measurements) {
  const c = choice(ctx, experiments);
  if (!c) return `<div class="card" id="entryCard"><h2>Enter results</h2><p class="muted" style="margin:0">Set an experiment up first: its formulations are the rows of the grid.</p></div>`;
  const open = cardOpen ?? !!(ctx.params.egexp || ctx.params.eg);
  const rows = gridRows(c.exp, c.stage, batches, measurements);
  const cols = c.cols.map((id) => COLUMN_BY_ID[id]);
  const exps = experiments.slice().sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')));
  const th = (col) => `<th style="text-align:right">${esc(col.label)}${col.unit ? `<div class="muted" style="font-weight:400;font-size:11px;margin-top:1px">${esc(col.unit)}</div>` : ''}</th>`;
  const td = (r, i, col, j) => {
    const stored = r.stored[col.test];
    const was = stored ? cellTextOf(stored.values, col.id) : '';
    const v = typed.get(keyOf(c.exp.id, c.stage, r.key, col.id)) ?? '';
    return `<td class="egTd"><input class="ecell" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-row="${i}" data-col="${j}" data-colid="${col.id}" value="${esc(v)}"${was ? ` placeholder="${esc(was)}" data-stored="1"` : ''} aria-label="${esc(`${r.sampleName} ${col.label}`)}"><div class="egSum" aria-live="polite"></div></td>`;
  };
  const body = rows.map((r, i) => `<tr data-key="${esc(r.key)}" data-sample="${esc(r.sampleName)}"><td><a href="#/formulation?batch=${esc(r.batchId)}">${esc(r.batchId)}</a></td>
    <td><span style="font-family:ui-monospace,Menlo,monospace;font-size:12px">${esc(r.sampleName)}</span>${Object.keys(r.open).length ? '' : ` <span class="muted" title="nothing open at this stage: a result is stored beside the plan">${Object.keys(r.stored).length ? 'stored' : 'not planned'}</span>`}</td>
    ${cols.map((col, j) => td(r, i, col, j)).join('')}<td class="egRowMsg muted"></td></tr>`).join('');
  return `<details class="card fold" id="entryCard" data-fold="entry"${open ? ' open' : ''}>
    <summary><h2>Enter results</h2><span class="fold-say">${esc(`${describeId(c.exp.id)} · ${c.stage} · ${rows.length} formulation${rows.length === 1 ? '' : 's'}`)}</span></summary>
    <div class="egBar">
      <select id="egExp" aria-label="Experiment">${exps.map((e) => `<option value="${esc(e.id)}"${e.id === c.exp.id ? ' selected' : ''}>${esc(`${e.id} · ${e.name || ''}`)}</option>`).join('')}</select>
      <select id="egStage" aria-label="Stage or timepoint">${c.stages.map((s) => `<option value="${esc(s)}"${s === c.stage ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <span class="egCols" role="group" aria-label="Columns">${GRID_COLUMNS.map((col) => `<label class="inline"><input type="checkbox" data-egcol="${col.id}" style="width:auto"${c.cols.includes(col.id) ? ' checked' : ''}> ${esc(col.label)}</label>`).join('')}</span></div>
    <p class="muted">Type as in a spreadsheet: Tab goes right, Enter goes down, and a block copied out of Excel fills from the cell you paste it into. Up to three replicates in one cell (<code>82; 85; 80</code>, decimal commas welcome): the mean and SD are stored with the runs. Orange is worth a second look and is stored; red is a value no measurement can have and is not. A faint number is a result already stored. Nothing is stored until <b>Save all</b>.</p>
    ${rows.length ? `<div style="overflow-x:auto"><table class="egrid" id="entryGrid"><thead><tr><th>Formulation</th><th>Sample name</th>${cols.map(th).join('')}<th></th></tr></thead><tbody>${body}</tbody></table></div>` : '<div class="note">This experiment has no formulations.</div>'}
    <div class="egGo">${rows.length && cols.length ? '<button class="primary" id="egSave">Save all</button>' : ''}
      <label class="inline">measured <input type="date" id="egDate" value="${esc(todayISO())}" style="width:auto" aria-label="Date measured"></label>
      <label class="inline">by <input type="text" id="egOperator" value="${esc(settings.operator || '')}" style="width:80px" aria-label="Operator"></label>
      <button type="button" id="egClear">Clear the grid</button></div>
    <div id="egMsg">${lastSave && !lastSave.undone ? savedNote(lastSave) : ''}</div></details>`;
}

const savedNote = (s) => `<div class="note ok" id="egSaved">Saved ${s.n} result${s.n === 1 ? '' : 's'}${s.refused ? `; ${s.refused} not saved, still in the grid and marked red` : ''}. <button type="button" id="egUndo">Undo</button></div>`;

/**
 * Keys, paste, live checks, Save all and Undo. `save(m)` stores one result (saveMeasurement of the screen),
 * `redraw()` draws the screen again.
 */
export function wireEntry(el, ctx, settings, experiments, batches, measurements, { save, redraw }) {
  const card = el.querySelector('#entryCard');
  if (!card) return;
  const c = choice(ctx, experiments);
  const writeHash = (patch) => {
    Object.assign(ctx.params, patch);
    const q = new URLSearchParams(Object.entries(ctx.params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
    try { history.replaceState(history.state, '', `#/measurements${q ? '?' + q : ''}`); } catch { /* the grid shows it either way */ }
  };
  card.querySelector('summary').addEventListener('click', () => { cardOpen = !card.open; });
  if (!c) return;
  card.querySelector('#egExp').addEventListener('change', (e) => { cardOpen = true; writeHash({ egexp: e.target.value, egstage: '', egcols: '' }); redraw(); });
  card.querySelector('#egStage').addEventListener('change', (e) => { cardOpen = true; writeHash({ egexp: c.exp.id, egstage: e.target.value }); redraw(); });
  card.querySelectorAll('[data-egcol]').forEach((b) => b.addEventListener('change', () => {
    const cols = [...card.querySelectorAll('[data-egcol]:checked')].map((x) => x.dataset.egcol);
    chosenCols.set(c.exp.id, cols);
    cardOpen = true; writeHash({ egexp: c.exp.id, egcols: cols.join(',') }); redraw();
  }));
  const grid = card.querySelector('#entryGrid');
  const rows = gridRows(c.exp, c.stage, batches, measurements);
  const msg = (h) => { card.querySelector('#egMsg').innerHTML = h; wireUndo(); };
  const wireUndo = () => card.querySelector('#egUndo')?.addEventListener('click', () => undo());
  wireUndo();
  card.querySelector('#egClear').addEventListener('click', () => {
    for (const k of [...typed.keys()]) if (k.startsWith(`${c.exp.id}|${c.stage}|`)) typed.delete(k);
    card.querySelectorAll('input.ecell').forEach((i) => { i.value = ''; });
    rows.forEach((_, i) => check(i));
  });
  if (!grid) return;
  const cells = [...grid.querySelectorAll('input.ecell')];
  const nCols = c.cols.length;
  const cellAt = (row, col) => cells[row * nCols + col] || null;

  /** The live check of one row: colours, the summary under each cell, and the reasons on hover. */
  function check(i) {
    const r = rows[i];
    const texts = {};
    for (let j = 0; j < nCols; j++) { const inp = cellAt(i, j); texts[inp.dataset.colid] = inp.value; }
    const res = rowResults(texts, settings.qc);
    const notes = [];
    for (let j = 0; j < nCols; j++) {
      const inp = cellAt(i, j), col = COLUMN_BY_ID[inp.dataset.colid];
      let { state, reasons } = cellState(res, col.id);
      if (inp.value.trim() && r.stored[col.test] && state !== 'bad') { state ||= 'warn'; reasons = [...reasons, `a ${TEST_LABEL[col.test] || col.test} result is already stored for ${r.sampleName}; this one is added beside it`]; }
      inp.classList.toggle('egWarn', state === 'warn');
      inp.classList.toggle('egBad', state === 'bad');
      inp.title = reasons.join('\n');
      const p = inp.value.trim() ? parseCell(inp.value, { max: col.single ? 1 : 3 }) : null;
      inp.nextElementSibling.textContent = p && !p.error ? cellSummary(p, col.d) : '';
      notes.push(...reasons);
    }
    const out = grid.querySelectorAll('tbody tr')[i].querySelector('.egRowMsg');
    out.textContent = [...new Set(notes)].join(' · ');
    return res;
  }
  rows.forEach((_, i) => { if (cells.slice(i * nCols, (i + 1) * nCols).some((x) => x.value.trim())) check(i); });

  grid.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.classList?.contains('ecell')) return;
    typed.set(keyOf(c.exp.id, c.stage, rows[+t.dataset.row].key, t.dataset.colid), t.value);
    check(+t.dataset.row);
  });
  // Enter goes down the column, as in a spreadsheet, and from its foot to the head of the next one; Tab goes
  // right on its own, through the row and on to the next. Up and down arrows move in the column.
  grid.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!t.classList?.contains('ecell')) return;
    const row = +t.dataset.row, col = +t.dataset.col;
    let next = null;
    if (e.key === 'Enter') next = e.shiftKey ? cellAt(row - 1, col) || cellAt(rows.length - 1, col - 1) : cellAt(row + 1, col) || cellAt(0, col + 1);
    else if (e.key === 'ArrowDown') next = cellAt(row + 1, col);
    else if (e.key === 'ArrowUp') next = cellAt(row - 1, col);
    else return;
    if (next) { e.preventDefault(); next.focus(); next.select(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); card.querySelector('#egSave')?.focus(); }
  });
  // A block out of Excel is spread over the cells from the one it was pasted into; a single value pastes as usual.
  grid.addEventListener('paste', (e) => {
    const t = e.target;
    if (!t.classList?.contains('ecell')) return;
    const block = parseClipboard(e.clipboardData?.getData('text/plain') ?? '');
    if (!block) return;
    e.preventDefault();
    const { puts, lost } = distributePaste(block, { row: +t.dataset.row, col: +t.dataset.col }, { rows: rows.length, cols: nCols });
    const touched = new Set();
    for (const p of puts) {
      const inp = cellAt(p.row, p.col);
      inp.value = p.text;
      typed.set(keyOf(c.exp.id, c.stage, rows[p.row].key, inp.dataset.colid), p.text);
      touched.add(p.row);
    }
    touched.forEach(check);
    msg(lost ? `<div class="note warn" id="egLost">${lost} pasted value${lost === 1 ? '' : 's'} had no cell to go into (past the last formulation or the last column) and ${lost === 1 ? 'was' : 'were'} left out.</div>` : '');
  });

  card.querySelector('#egSave')?.addEventListener('click', () => {
    const date = card.querySelector('#egDate').value || todayISO(), operator = card.querySelector('#egOperator').value;
    const todo = [];
    rows.forEach((r, i) => {
      if (!cells.slice(i * nCols, (i + 1) * nCols).some((x) => x.value.trim())) return;
      const res = check(i);
      for (const [test, out] of Object.entries(res)) todo.push({ r, i, test, out });
    });
    if (!todo.length) { msg('<div class="note warn">Type a value first.</div>'); return; }
    const ok = todo.filter((x) => x.out.values), refused = todo.filter((x) => !x.out.values);
    if (!ok.length) { msg(`<div class="note warn" id="egRefused"><b>Nothing saved.</b> ${refused.map((x) => esc(`${x.r.sampleName}: ${x.out.errors.map((e) => e.text).join('; ')}`)).join('<br>')}</div>`); return; }
    // The receipt is what Undo puts back: the results, the slots they closed, and each formulation's status
    // before this save moved it to "measured".
    const receipt = { measurementIds: [], slots: [], batches: [] };
    const before = new Map(batches.map((b) => [b.id, b.status]));
    ctx.store.transaction(() => {
      for (const { r, test, out } of ok) {
        const slot = r.open[test] ? { ...r.open[test], experimentId: c.exp.id } : null;
        const rec = save({ slot, batchId: r.batchId, experimentId: c.exp.id, stage: c.stage, test, values: out.values, date, operator, sampleName: slot?.sampleName || r.sampleName, raw: null, condition: slot?.condition ?? r.condition ?? undefined, timepoint: slot?.timepoint ?? r.timepoint ?? undefined, formulation: slot?.formulation });
        receipt.measurementIds.push(rec.id);
        if (slot) receipt.slots.push({ experimentId: c.exp.id, slotId: slot.id });
        if (['planned', 'produced'].includes(before.get(r.batchId)) && !receipt.batches.some((b) => b.id === r.batchId)) receipt.batches.push({ id: r.batchId, status: before.get(r.batchId) });
      }
    }, { what: `the ${ok.length} results of the grid` });
    // Saved cells leave the grid; the cells of a refused result stay, with what was typed.
    const savedCols = new Set(ok.map((x) => `${x.r.key}|${x.test}`));
    for (const r of rows) for (const id of c.cols) if (savedCols.has(`${r.key}|${COLUMN_BY_ID[id].test}`)) typed.delete(keyOf(c.exp.id, c.stage, r.key, id));
    lastSave = { receipt, n: ok.length, refused: refused.length, undone: false };
    cardOpen = true;
    toast(`Saved ${ok.length} result${ok.length === 1 ? '' : 's'}${refused.length ? `; ${refused.length} not saved` : ''}`, refused.length ? 'warn' : 'ok', { action: 'Undo', onAction: () => undo() });
    redraw();
  });

  /** The save taken back as one write: its results out, their slots open again, the statuses as they were. */
  function undo() {
    const s = lastSave;
    if (!s || s.undone) return;
    const u = undoGridSave(s.receipt, { measurements: ctx.store.all('measurements'), experiments: ctx.store.all('experiments'), batches: ctx.store.all('batches') });
    ctx.store.transaction(() => {
      for (const id of u.removeMeasurements) ctx.store.remove('measurements', id);
      for (const e of u.experiments) ctx.store.put('experiments', e);
      for (const b of u.batches) ctx.store.put('batches', b);
    }, { what: 'the undo of the grid save' });
    s.undone = true;
    toast(`Undone: ${u.removeMeasurements.length} result${u.removeMeasurements.length === 1 ? '' : 's'} taken out`, 'ok');
    redraw();
  }
}

/**
 * One cell of the import preview drawn as the grid draws it: the replicates as they would have been typed, the
 * mean and SD under them, and the colour of what the checks say. `state` is 'bad', 'warn' or ''.
 */
export function previewCellHtml(values, colId, state = '', reasons = []) {
  const col = COLUMN_BY_ID[colId];
  const text = cellTextOf(values, colId);
  const p = text ? parseCell(text) : null;
  return `<span class="ecell ro${state === 'bad' ? ' egBad' : state === 'warn' ? ' egWarn' : ''}"${reasons.length ? ` title="${esc(reasons.join('\n'))}"` : ''}>${esc(text || '–')}</span>${p && p.n > 1 ? `<div class="egSum">${esc(cellSummary(p, col.d))}</div>` : ''}`;
}

