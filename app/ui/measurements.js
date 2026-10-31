// Screen: Measurements — what is due, import instrument CSV exports, enter results per stage/timepoint, QC flags,
// unassigned inbox, the results list.
//
// After two weeks of lab work this was the longest page in the app (usability cycle 4, M1): the waiting list,
// the import card, the manual form and 200 results, all open, and what was due today or overdue nowhere near
// the top. So it now leads with what is due across every experiment, one line per experiment and stage; the
// import card and the manual form are one line each until they are used; and the results list is filtered and
// paged, and since cycle 5 one line (how many, how many flagged, the last added) until it is opened.
import { raw, fmt, field, readForm, table, chip, toast, header, todayISO, addDays, fmtDate, sha256Hex, uid, esc, download, ask } from './kit.js';
import { provenanceLine } from '../calc/provenance.js';
import { parseISO } from '../calc/dates.js';
import { getSettings } from '../refdata.js';
import { info, wireLearn } from './learn.js';
import { TESTS } from '../calc/experiment.js';
import { parseCSV, extractTests, matchSample, detectTests, detectInstrument, eeFromRiboGreen, missingFromFile, blankSheet, keptApart, alreadyImported } from '../calc/parsers.js';
import { qcFlags, checkValues, mean, sd, correctResult, describeCorrection } from '../calc/qc.js';
import { TEST_LABEL } from '../calc/evaluate.js';
import { describeId } from '../schema.js';
import { mountImportEval, linkAssignedToImport } from './importeval.js';
import { GRID_FIELDS, cellNumber, saveMeasurement, gridHtml, wireGrid } from './resultgrid.js';

export { saveMeasurement };
import { entryCard, wireEntry, previewCellHtml } from './entrygrid.js';
import { COLUMN_BY_ID, GRID_COLUMNS } from '../calc/gridentry.js';

/**
 * The tests a table can be imported as, and the columns the preview shows for each. The preview used to show
 * Z-ave, PDI, zeta and kcps whatever was being imported, which for an EE sheet meant four dashes and not the
 * one number that was about to be stored. The first column is the result itself and is always shown; the
 * others only when the table has them. Zeta is its own test with its own column group, so the DLS group does
 * not show a zeta it would not store.
 */
const IMPORT_COLS = {
  dls: [{ label: 'Z-ave', sub: 'nm', key: 'zave_nm', d: 1 }, { label: 'PDI', key: 'pdi', d: 3 }, { label: 'kcps', key: 'countRate_kcps', d: 0 }],
  zeta: [{ label: 'Zeta', sub: 'mV', key: 'zeta_mV', d: 1 }],
  ee: [{ label: 'EE', sub: '%', key: 'ee_pct', d: 1 }, { label: 'Total RNA', sub: 'mg/mL', key: 'total_mg_mL', d: 4 }, { label: 'Free RNA', sub: 'mg/mL', key: 'free_mg_mL', d: 4 }],
  content: [{ label: 'RNA', sub: 'mg/mL', key: 'rna_mg_mL', d: 3 }],
};

/**
 * What is stored for one imported sample. DLS keeps its runs and their spread, as it always has; EE and RNA
 * content keep their replicates as well when there was more than one, so a mean can be traced to its wells.
 */
function valuesFor(test, r) {
  if (test === 'dls') return { zave_nm: r.zave_nm, pdi: r.pdi, runs: r.runs.map((x) => ({ zave_nm: x.zave_nm, pdi: x.pdi })), countRate_kcps: r.countRate_kcps, attenuator: r.attenuator, temp_c: r.temp_c, zave_sd: sd(r.runs.map((x) => x.zave_nm)) };
  if (test === 'zeta') return { zeta_mV: r.zeta_mV };
  const keys = IMPORT_COLS[test].map((c) => c.key);
  const v = Object.fromEntries(keys.filter((k) => r[k] != null).map((k) => [k, r[k]]));
  if (r.runs?.length > 1) {
    v.runs = r.runs.map((x) => Object.fromEntries(keys.filter((k) => x[k] != null).map((k) => [k, x[k]])));
    v[test === 'ee' ? 'ee_sd' : 'rna_sd'] = sd(r.runs.map((x) => x[keys[0]]));
  }
  return v;
}

const testName = (id) => TESTS.find((t) => t.id === id)?.name || id;
/** "DLS + EE": the short names, joined the way the preview says what it read. */
const testList = (ts) => ts.map((t) => TEST_LABEL[t] || t).join(' + ');

// Whether the redraw after a manual save keeps the form open. Someone typing results one after another is still
// at it, and folding the form under them would cost a click per result. Used once.
let manualKeep = false;

/** How far ahead "Coming" looks: a week, the span instrument time is booked in. */
const DUE_AHEAD = 7;
/** Lines a due group shows before the rest wait behind "N more": a lab with abandoned studies has hundreds overdue. */
const DUE_LINES = 8;
/** Results per page of the list. Two hundred rows were three quarters of the words on the screen. */
const PAGE = 50;
const DUE_GROUPS = [['overdue', 'Overdue'], ['today', 'Today'], ['coming', `Coming · next ${DUE_AHEAD} days`]];
/** Where a due date falls from today: before it, on it, within the week ahead, or later than that. */
const bucketOf = (due, today, horizon) => (due < today ? 'overdue' : due === today ? 'today' : due <= horizon ? 'coming' : 'later');
const DUE_WORD = { overdue: 'overdue', today: 'due today', coming: `next ${DUE_AHEAD} days`, later: 'later' };
// "Thu 12 Nov": inside a week the weekday is what a lab plans by, and the year is noise.
const dayLabel = (iso) => parseISO(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 864e5);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
// Tests in the order every other screen lists them (DLS, zeta, EE, RNA content, …).
const TEST_ORDER = Object.keys(TEST_LABEL);
const testRank = (t) => (TEST_ORDER.includes(t) ? TEST_ORDER.indexOf(t) : TEST_ORDER.length);
const expNumber = (id) => Number(/^E(\d+)/.exec(String(id || ''))?.[1]) || 0;

const TEST_FIELDS = {
  dls: [['zave_nm', 'Z-average (nm)'], ['pdi', 'PDI'], ['countRate_kcps', 'Count rate (kcps)'], ['attenuator', 'Attenuator'], ['temp_c', 'Temperature (°C)'], ['dispersant', 'Dispersant', 'text'], ['dilution', 'Dilution (1:x)']],
  zeta: [['zeta_mV', 'Zeta potential (mV)'], ['sd_mV', 'SD (mV)'], ['conductivity_mS_cm', 'Conductivity (mS/cm)']],
  ee: [['ee_pct', 'Encapsulation efficiency (%)'], ['total_mg_mL', 'Total RNA (mg/mL)'], ['free_mg_mL', 'Free RNA (mg/mL)']],
  content: [['rna_mg_mL', 'RNA content (mg/mL)'], ['method', 'Method (UV, RiboGreen)', 'text']],
  potency: [['cellLine', 'Cell line', 'text'], ['rlu', 'RLU'], ['pctControl', '% of positive control'], ['serum', 'Serum (+/−)', 'text'], ['viability_pct', 'Viability (%)']],
  ph: [['ph', 'pH']], osmolality: [['mOsm_kg', 'Osmolality (mOsmol/kg)']], integrity: [['pct', 'Integrity (%)'], ['method', 'Method', 'text']],
  lipid_content: [['total_mg_mL', 'Total lipid (mg/mL)'], ['notes', 'Per lipid (free text)', 'text']], endotoxin: [['eu_mL', 'EU/mL']],
};

export function summarize(m) {
  const v = m.values || {};
  // Values under no name this screen knows are listed as they are rather than leaving the cell empty, as a
  // potency stored under another name did (usability cycle 6, I9).
  const other = () => Object.entries(v).filter(([k]) => k !== 'runs').map(([k, x]) => `${k} ${x}`).join(', ');
  switch (m.test) {
    case 'dls': return `${fmt(v.zave_nm, 1)} nm / PDI ${fmt(v.pdi, 3)}${v.runs?.length ? ` (n=${v.runs.length})` : ''}`;
    case 'zeta': return `${fmt(v.zeta_mV, 2)} mV${v.sd_mV != null ? ` ± ${fmt(v.sd_mV, 2)}` : ''}`;
    case 'ee': return `EE ${fmt(v.ee_pct, 1)} %${v.total_mg_mL != null ? ` · ${fmt(v.total_mg_mL, 3)} mg/mL` : ''}`;
    case 'content': return `${fmt(v.rna_mg_mL, 3)} mg/mL${v.method ? ` (${v.method})` : ''}`;
    case 'potency': return v.pctControl != null || v.rlu != null ? `${v.cellLine || ''} ${v.pctControl != null ? fmt(v.pctControl, 0) + ' % of control' : fmt(v.rlu, 0) + ' RLU'}`.trim() : other();
    case 'ph': return `pH ${fmt(v.ph, 2)}`; case 'osmolality': return `${fmt(v.mOsm_kg, 0)} mOsm/kg`; case 'integrity': return `${fmt(v.pct, 1)} %`;
    default: return other();
  }
}

export async function render(el, ctx) {
  const settings = getSettings(ctx);
  if (ctx.params.id) return detail(el, ctx, settings, ctx.params.id);
  const today = todayISO();
  const experiments = ctx.store.all('experiments'), batches = ctx.store.all('batches');
  const stored = ctx.store.all('measurements');
  // The store keeps results in the order they were added; the folded results list names the last of them.
  const added = stored.slice();
  const measurements = stored.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  const filterBatch = ctx.params.batch || '';
  const inbox = ctx.store.all('inbox');
  const openSlots = experiments.flatMap((e) => (e.expected || []).filter((s) => s.status === 'open').map((s) => ({ ...s, experimentId: e.id }))).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const lines = dueLines(experiments, openSlots, today);
  const w = waitingFor(ctx, experiments, openSlots, today);
  // The manual form opens by itself when the address asks for a slot or a formulation (the "Measure" links of
  // an experiment and a formulation record), and stays open over the redraw its own save causes.
  const manualOpen = !!(ctx.params.slot || filterBatch || manualKeep);
  manualKeep = false;
  const filters = readFilters(ctx.params);

  el.innerHTML = header('Evaluate', raw(`Measurements <span style="font-size:13px;font-weight:400;color:var(--ink2);margin-left:6px">${info('size', 'size')} ${info('pdi', 'PDI')} ${info('ee', 'encapsulation')} ${info('zeta', 'zeta')}</span>`)) +
    dueCard(ctx, settings, lines, w, openSlots, today) +
    // The import card is one line until a file comes in or the paste box is opened: the preview, and the date
    // and operator it is stored under, appear with the table they belong to.
    `<div class="card" id="importCard"><div class="foldLine"><h2>Bring the results in</h2>
        <input type="file" id="csvFile" accept=".csv,.txt,text/csv" aria-label="The instrument's export (CSV or text)">
        <select id="importTest" aria-label="What the table holds"><option value="auto">Detect from the columns</option><option value="dls">DLS (Z-ave, PDI)</option><option value="zeta">Zeta potential</option><option value="ee">EE % (RiboGreen)</option><option value="content">RNA content</option></select>
        <details id="pasteFold"><summary>or paste it here</summary>
          <p class="muted">A block straight out of a spreadsheet or the instrument's software: comma, semicolon and tab all work, and a decimal comma is read as one. One row per run; triplicates of the same sample name are averaged. Rows are matched to what an experiment is expecting by their sample name (<code>E3-F2_final</code>, <code>E6-F1_4C_T09</code>). DLS, zeta, RiboGreen (an EE column, or Total and Free RNA in mg/mL or µg/mL) and RNA content are told apart by their column names, and one sheet can hold several. Nothing is stored until you have seen the preview.</p>
          <textarea id="pasteBox" rows="5" placeholder="Sample Name,Z-Average (d.nm),PdI&#10;E3-F2_final,82.4,0.08"></textarea>
          <button id="pasteGo">Read what I pasted</button></details></div>
      <div id="importPreview"></div></div>` +
    // Spec 9.3, behind its setting: the grid of an experiment's formulations, above the one-result form, which
    // stays for what a grid cell cannot hold (potency with its cell line, remarks, a file reference).
    (settings.entryGrid ? entryCard(ctx, settings, experiments, batches, stored) : '') +
    manualCard(ctx, settings, openSlots, batches, filterBatch, manualOpen, today) +
    (inbox.length ? `<div class="card"><h2>Unassigned imports (${inbox.length})</h2>${table(['Sample name in file', 'Values', 'Assign to', ''], inbox.map((r) => ({ cells: [raw(`<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px">${r.sampleName}</span>`), summarize(r), raw(`<select data-assign="${r.id}"><option value="">—</option>${openSlots.map((s) => `<option value="${s.id}">${s.sampleName} · ${s.test}</option>`).join('')}</select>`), raw(`<button data-assignbtn="${r.id}" style="padding:4px 8px">Assign</button> <button data-drop="${r.id}" style="padding:4px 8px">Drop</button>`)] })))}</div>` : '') +
    resultsCard(measurements, experiments, filters, filterBatch, added);
  // The "?" marks in the title. wireLearn guards against wiring the same element twice.
  wireLearn(el);
  // The evaluation of an import (?evaluated=<import id>) and the list of recent imports live in importeval.js.
  mountImportEval(el, ctx);

  // ---- what is due ----
  wireDue(el, ctx, settings, lines, w, openSlots);

  if (settings.entryGrid) wireEntry(el, ctx, settings, experiments, batches, stored, { save: (m) => saveMeasurement(ctx, settings, m), redraw: () => render(el, ctx) });

  // ---- manual entry ----
  const body = el.querySelector('#manualBody');
  const openManual = () => { body.hidden = false; el.querySelector('#manualFree').hidden = true; };
  const drawFields = () => {
    const t = el.querySelector('[name=test]').value;
    const fields = TEST_FIELDS[t] || [['value', 'Value']];
    let h = fields.map(([k, l, ty]) => field({ id: 'v_' + k, label: l, type: ty || 'number', step: 'any' })).join('');
    if (t === 'dls') h = `<div style="grid-column:1/-1"><label>Runs (enter up to 3; the mean is stored)</label><div style="display:flex;gap:8px;flex-wrap:wrap">${[1, 2, 3].map((i) => `<input type="number" step="any" name="run_z${i}" placeholder="Z-ave ${i}" style="width:110px"><input type="number" step="any" name="run_p${i}" placeholder="PDI ${i}" style="width:90px">`).join('')}</div></div>` + h;
    el.querySelector('#testFields').innerHTML = h;
  };
  // Choosing what the result is for fills in its formulation, stage and test. The same runs for ?slot=, which
  // used to leave the test at DLS whatever the slot was for.
  const fromSlot = (id) => {
    const s = openSlots.find((x) => x.id === id); if (!s) return;
    el.querySelector('[name=batchId]').value = s.batchId; el.querySelector('[name=stage]').value = s.stage; el.querySelector('[name=test]').value = s.test;
  };
  if (ctx.params.slot) fromSlot(ctx.params.slot);
  drawFields();
  el.querySelector('[name=test]').addEventListener('change', drawFields);
  // The select is on the folded line itself, so choosing a sample is what opens the form: no extra click.
  el.querySelector('[name=slotId]').addEventListener('change', (e) => { openManual(); fromSlot(e.target.value); drawFields(); });
  el.querySelector('#manualFree').addEventListener('click', () => { openManual(); el.querySelector('[name=batchId]').focus(); });
  el.querySelector('#saveManual').addEventListener('click', () => {
    const f = readForm(el.querySelector('#manualForm'));
    const ff = readForm(el.querySelector('#testFields'));
    const g = readForm(el);
    const values = {};
    for (const [k, v] of Object.entries(ff)) if (k.startsWith('v_') && v !== null && v !== '') values[k.slice(2)] = v;
    if (f.test === 'dls') {
      const runs = [1, 2, 3].map((i) => ({ zave_nm: ff['run_z' + i], pdi: ff['run_p' + i] })).filter((r) => r.zave_nm != null);
      if (runs.length) { values.runs = runs; values.zave_nm ??= mean(runs.map((r) => r.zave_nm)); values.pdi ??= mean(runs.map((r) => r.pdi)); values.zave_sd = sd(runs.map((r) => r.zave_nm)); }
    }
    // The two RiboGreen readings are what the plate reader gives; the percentage is arithmetic, not a third number to type.
    if (f.test === 'ee' && values.ee_pct == null) { const ee = eeFromRiboGreen(values.total_mg_mL, values.free_mg_mL); if (ee != null) values.ee_pct = ee; }
    if (!Object.keys(values).length) { toast('Enter a value first', 'warn'); return; }
    // An impossible value is refused here, with the reason next to the button, and the field it came from marked.
    const check = checkValues(f.test, values);
    const box = el.querySelector('#testFields');
    box.querySelectorAll('input.invalid').forEach((i) => i.classList.remove('invalid'));
    for (const e of check.errors) {
      const name = e.run != null ? { zave_nm: 'run_z', pdi: 'run_p' }[e.key] + (e.run + 1) : 'v_' + e.key;
      box.querySelector(`[name="${name}"]`)?.classList.add('invalid');
    }
    el.querySelector('#manualCheck').innerHTML = check.errors.length ? `<div class="note warn"><b>Not saved.</b> ${check.errors.map((e) => esc(e.text)).join('<br>')}</div>` : '';
    if (check.errors.length) return;
    const slot = openSlots.find((s) => s.id === f.slotId);
    const batchId = slot?.batchId || f.batchId || null;
    if (!batchId && !slot) { toast('Choose an expected measurement or a batch', 'warn'); return; }
    saveMeasurement(ctx, settings, { slot, batchId, experimentId: slot?.experimentId || batches.find((b) => b.id === batchId)?.experimentId || null, stage: slot?.stage || f.stage, test: f.test, values, date: g.date, operator: g.operator, sampleName: slot?.sampleName || (batchId ? `${batchId}_${f.stage}` : ''), remarks: g.remarks, raw: g.fileRef ? { fileName: g.fileRef } : null, condition: slot?.condition, timepoint: slot?.timepoint, formulation: slot?.formulation });
    toast(check.warnings.length ? `Result saved. Worth a look: ${check.warnings.map((w) => w.text).join('; ')}` : 'Result saved', check.warnings.length ? 'warn' : 'ok');
    manualKeep = true; render(el, ctx);
  });

  // ---- the results list ----
  wireResults(el, ctx, measurements, filters, filterBatch);

  // ---- import ----
  // A file and a paste differ only in where the text came from, so the preview is built from text and a name.
  el.querySelector('#csvFile').addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    preview((await import('../calc/parsers.js')).decodeText(await f.arrayBuffer()), f.name); // bytes, not f.text(): a Zetasizer export is UTF-16, which text() reads as UTF-8
  });
  el.querySelector('#pasteGo')?.addEventListener('click', () => {
    const text = el.querySelector('#pasteBox').value.trim();
    if (!text) { toast('Paste the rows first', 'warn'); return; }
    preview(text, 'pasted');
  });
  // The text behind the preview on screen, so that choosing another import type reads the same table again as that type.
  let shown = null;
  // Whether the type on the select was picked by a person. The select also shows the one test it detected, and
  // a type the app put there is no choice: the next table is read by its own columns again.
  let typeByHand = false;
  el.querySelector('#importTest').addEventListener('change', (e) => { typeByHand = e.target.value !== 'auto'; if (shown) preview(shown.text, shown.fileName, true); });

  async function preview(text, fileName, keepTest = false) {
    shown = { text, fileName };
    const file = { name: fileName };
    const hash = await sha256Hex(text);
    const testSel = el.querySelector('#importTest');
    // A number at the end of a name is a run index only under a sample the app expects (parsers.js runSamples).
    const expectedNames = experiments.flatMap((e) => (e.expected || []).map((s) => s.sampleName)).filter(Boolean);
    let parsed, samples, found = [], tests = [];
    try {
      parsed = parseCSV(text);
      // Every test whose result column holds numbers. The blank sheet carries a column for each test still due,
      // and the ones left empty are not part of this import.
      found = detectTests(parsed.headers, parsed.rows);
      // A type picked by hand gives way to the table only when it finds nothing in it: an EE block pasted with DLS
      // still selected is read as EE, while someone who picked Zeta and drops a sheet holding zeta keeps zeta.
      // Choosing a type by hand after the preview is what keepTest is for.
      let chosen = typeByHand ? testSel.value : 'auto';
      if (!keepTest && chosen !== 'auto' && found.length && !found.includes(chosen)) { chosen = 'auto'; typeByHand = false; }
      if (chosen !== 'auto') tests = [chosen];
      else if (found.length) tests = found;
      else {
        // Nothing in any result column (a blank sheet dropped back unfilled): show the columns it has, empty, so
        // the preview says why nothing is ticked rather than refusing the table.
        const one = detectInstrument(parsed.headers);
        tests = detectTests(parsed.headers);
        if (!tests.length && IMPORT_COLS[one]) tests = [one];
        if (!tests.length) throw new Error('no result column found (Z-Average and PdI, Zeta, EE, Total and Free RNA, RNA)');
      }
      // The select says what the table is read as: the one test found, or "Detect from the columns" for several.
      testSel.value = chosen !== 'auto' ? chosen : tests.length === 1 ? tests[0] : 'auto';
      samples = extractTests(parsed, tests, { expected: expectedNames });
    } catch (err) { el.querySelector('#importPreview').innerHTML = `<div class="note warn">Could not parse: ${esc(err.message)}. Columns found: ${esc((parsed?.headers || []).join(', '))}</div>`; return; }

    // One row per sample, and under it what each test read: the values, the slot that test matches (a sample can
    // be expected for DLS and not for EE), and what the checks say. Each test is placed and checked on its own.
    const rows = samples.map((s) => {
      const per = {};
      for (const t of tests) {
        const x = s.tests[t];
        if (!x) continue;
        const values = valuesFor(t, x);
        per[t] = { s: x, values, has: x[IMPORT_COLS[t][0].key] != null, match: matchSample(s.sampleName, { experiments, batches }, t), flags: qcFlags(t, values, settings.qc), check: checkValues(t, values) };
      }
      const withValue = tests.filter((t) => per[t]?.has);
      return {
        sampleName: s.sampleName, n: s.n, per, withValue, names: s.names || [s.sampleName],
        ok: withValue.filter((t) => !per[t].check.errors.length), // what this row will store
        refused: withValue.filter((t) => per[t].check.errors.length),
        matched: tests.some((t) => per[t]?.match?.slot || per[t]?.match?.batchId),
      };
    });
    const matched = rows.filter((r) => r.matched).length;
    const refusedRows = rows.filter((r) => r.refused.length);
    const missing = missingFromFile(experiments, { results: rows.flatMap((r) => tests.filter((t) => r.per[t]).map((t) => ({ sampleName: r.sampleName, test: t, match: r.per[t].match, hasValue: r.per[t].has }))), tests, today: todayISO() });
    // Exactly one sample missing and exactly one row with numbers that matched nothing: that row is almost
    // certainly that sample under a name typed differently on the instrument, so its target is filled in. With
    // two strays and one gap, picking for either would be a guess, and both would land on the same slot.
    const strays = rows.filter((r) => !r.matched && r.withValue.length);
    const guess = missing.length === 1 && strays.length === 1 && strays[0].withValue.some((t) => missing[0].tests.includes(t)) ? { row: strays[0], name: missing[0].sampleName } : null;
    const missingNames = new Set(missing.map((x) => x.sampleName));
    const otherOpen = [...new Set(openSlots.filter((s) => tests.includes(s.test) && !missingNames.has(s.sampleName)).map((s) => s.sampleName))];
    const opt = (name, pick) => `<option value="${esc(name)}" ${name === pick ? 'selected' : ''}>${esc(name)}</option>`;

    const targetCell = (r, i) => {
      // Prefer a test that has a number in this row: that is the result about to be stored.
      const order = [...r.withValue, ...tests.filter((t) => !r.withValue.includes(t))];
      const hit = order.map((t) => r.per[t]?.match).find((m) => m?.slot);
      if (hit) {
        // A test with a number but no open slot for this sample is named, so it does not vanish under "matched".
        const loose = tests.length > 1 ? r.withValue.filter((t) => !r.per[t].match?.slot) : [];
        return `${chip(hit.slot.sampleName, 'info')} <span class="muted">${hit.confidence}${loose.length ? ` · ${esc(testList(loose))}: no open slot` : ''}</span>`;
      }
      const b = order.map((t) => r.per[t]?.match).find((m) => m?.batchId);
      if (b) return `${chip(b.batchId, 'info')} <span class="muted">batch, no open slot</span>`;
      const pick = guess?.row === r ? guess.name : '';
      return `<select data-target="${i}"><option value="">— choose or inbox —</option><option value="__ignore">ignore (blank)</option>
        ${missing.length ? `<optgroup label="Missing from this file">${missing.map((x) => opt(x.sampleName, pick)).join('')}</optgroup>` : ''}
        ${otherOpen.length ? `<optgroup label="${missing.length ? 'Other open samples' : 'Open samples'}">${otherOpen.map((n) => opt(n, pick)).join('')}</optgroup>` : ''}</select>${pick ? ' <span class="muted onlyLeft">only one left</span>' : ''}`;
    };

    // Columns: the result of each test always, its other readings when the table has them; one group per test.
    const groups = tests.map((t) => ({ test: t, cols: IMPORT_COLS[t].filter((c, j) => j === 0 || rows.some((r) => r.per[t]?.s[c.key] != null)) }));
    const multi = tests.length > 1;
    const th = (label, sub, cls = '', right = false) => `<th class="${cls}" ${right ? 'style="text-align:right"' : ''}>${esc(label)}${sub ? `<div class="muted" style="font-weight:400;font-size:11px;margin-top:1px">${esc(sub)}</div>` : ''}</th>`;
    const head = `${multi ? `<tr class="grp"><th colspan="2"></th>${groups.map((g) => `<th class="g0" colspan="${g.cols.length}">${esc(TEST_LABEL[g.test] || g.test)}</th>`).join('')}<th colspan="3"></th></tr>` : ''}
      <tr>${th('Sample name in file')}${th('Target')}${groups.map((g) => g.cols.map((c, j) => th(c.label, c.sub, j === 0 && multi ? 'g0' : '', true)).join('')).join('')}${th('n', '', '', true)}${th('QC')}${th('Import')}</tr>`;
    // The same file again (usability cycle 6, I5): its SHA-256 is on record with the results it stored, and
    // imported twice each of them would be stored twice and counted twice in every mean and fit. So nothing is
    // ticked until the person answers, to a question, that they mean to import it again.
    const dup = alreadyImported(hash, { imports: ctx.store.all('imports'), records: [...measurements, ...inbox], tests });
    const [dupWhat, it] = file.name === 'pasted' ? ['These rows were', 'them'] : ['This file was', 'it'];
    const dupWhen = dup ? (dup.dates.length ? `on ${[...new Set(dup.dates.map(fmtDate))].join(' and ')}` : 'before') : '';
    const againQ = dup && `${dupWhat} imported ${dupWhen}, and ${dup.results === 1 ? '1 result' : `${dup.results} results`} from ${it} ${dup.results === 1 ? 'is' : 'are'} stored. Import ${it} again? Every result is then stored a second time, beside the first.`;
    let again = false;
    // Rows read from several names (E3-F2_final 1, 2 and 3) say so under the name, so a person sees what was averaged.
    const FROM_SHOWN = 6;
    // Spec 9.3: with the results grid on, the preview's numbers are drawn as the grid draws them, replicates and
    // colours included, so a file read in and a sheet typed in look the same. Only the drawing changes: what is
    // matched, ticked, refused and stored is decided above, as before.
    const gridLook = !!settings.entryGrid;
    const gridCell = (test, c, p) => {
      const col = GRID_COLUMNS.find((x) => x.test === test && x.key === c.key);
      if (!col) return esc(fmt(p.s[c.key], c.d));
      const bad = p.check.errors.filter((e) => e.key === c.key).map((e) => e.text);
      const warn = [...p.check.warnings.filter((w) => w.key === c.key).map((w) => w.text),
        ...p.flags.filter((f) => f.level === 'warn' && f.text.toLowerCase().startsWith(COLUMN_BY_ID[col.id].label.toLowerCase())).map((f) => f.text)];
      return previewCellHtml(p.values, col.id, bad.length ? 'bad' : warn.length ? 'warn' : '', bad.length ? bad : warn);
    };
    const fromNames = (r) => (r.names.some((x) => x !== r.sampleName) ? `<div class="muted runsOf" style="font-size:11px">from ${r.names.slice(0, FROM_SHOWN).map(esc).join(', ')}${r.names.length > FROM_SHOWN ? ` and ${r.names.length - FROM_SHOWN} more` : ''}</div>` : '');
    const body = rows.map((r, i) => {
      const cells = groups.map((g) => g.cols.map((c, j) => {
        const p = r.per[g.test];
        const cls = [j === 0 && multi ? 'g0' : '', p?.has && p.check.errors.length ? 'refused' : ''].filter(Boolean).join(' ');
        return `<td class="${cls}" style="text-align:right">${gridLook && p ? gridCell(g.test, c, p) : esc(fmt(p?.s[c.key], c.d))}</td>`;
      }).join('')).join('');
      const qc = r.withValue.flatMap((t) => { const p = r.per[t]; return [...p.check.errors.map((e) => chip(e.text, 'bad')), ...p.check.warnings.map((w) => chip(w.text, 'warn')), ...p.flags.map((f) => chip(f.text, f.level === 'warn' ? 'warn' : 'info'))]; }).join(' ') || chip('ok', 'ok');
      return `<tr ${r.refused.length && !r.ok.length ? 'class="refused"' : ''} data-row="${i}"><td><span style="font-family:ui-monospace,Menlo,monospace;font-size:12px">${esc(r.sampleName)}</span>${fromNames(r)}</td><td>${targetCell(r, i)}</td>${cells}<td style="text-align:right">${r.n}</td><td>${qc}</td><td><input type="checkbox" data-imp="${i}" ${r.ok.length && !dup ? 'checked' : ''} style="width:auto"></td></tr>`;
    }).join('') || `<tr><td colspan="${5 + groups.reduce((a, g) => a + g.cols.length, 0)}" class="muted">No sample names in this table.</td></tr>`;

    // What the file did not bring, for the experiments it matched into: said up front, so a gap is seen before
    // the import and not when the experiment page still shows a sample as open.
    const into = [...new Set(rows.flatMap((r) => r.withValue.map((t) => r.per[t].match).filter((m) => m?.slot && m.experiment).map((m) => m.experiment.id)))];
    const where = into.length === 1 ? describeId(into[0]) : into.length === 2 ? `${describeId(into[0])} and ${describeId(into[1])}` : `${into.length} experiments`;
    const named = (x) => (multi && x.tests.length < tests.length ? `${x.sampleName} (${testList(x.tests)})` : x.sampleName);
    const MISSING_SHOWN = 12;
    const missingHtml = !into.length ? ''
      : missing.length ? `<div class="note warn" id="importMissing">Still missing from this file: ${missing.slice(0, MISSING_SHOWN).map((x) => `<code>${esc(named(x))}</code>`).join(', ')}${missing.length > MISSING_SHOWN ? ` and ${missing.length - MISSING_SHOWN} more` : ''}.${guess ? ` The one row that matched nothing, <code>${esc(guess.row.sampleName)}</code>, is set to it below; change it if that is wrong.` : strays.length ? ' A row that matched nothing can be pointed at one of them below.' : ''}</div>`
      : `<p class="muted" id="importMissing">Nothing missing: every sample of ${esc(where)} due for ${esc(testList(tests))} at this stage is in the file.</p>`;
    const dupHtml = dup ? `<div class="note warn" id="importDup">${dupWhat} imported ${esc(dupWhen)} (${dup.results} result${dup.results === 1 ? '' : 's'}), so nothing below is ticked: imported again, each result would be stored twice. <button id="importAgain">Import ${it} again</button></div>` : '';
    // Names that look like runs but were kept apart (LNP-1, LNP-2, LNP-3), so someone whose runs those were sees why.
    const code = (n) => `<code>${esc(n)}</code>`;
    const few = (g) => (g.length > 4 ? `${g.slice(0, 3).map(code).join(', ')} … ${code(g[g.length - 1])}` : g.map(code).join(', '));
    const apart = keptApart(rows.flatMap((r) => r.names), expectedNames);
    const apartHtml = !apart.length ? '' : `<p class="muted" id="importApart">Read as separate samples: ${apart.slice(0, 3).map(few).join('; ')}${apart.length > 3 ? ` and ${apart.length - 3} more such groups` : ''}. A number at the end of a name is read as a run only after a sample name the app expects (<code>E3-F2_final 1</code>, <code>E3-F2_final 2</code>); for runs to be averaged, name them that way or give every run the same name.</p>`;

    const also = found.filter((t) => !tests.includes(t));
    const readAs = `read as ${esc(testList(tests))}${also.length ? ` (${tests.some((t) => found.includes(t)) ? `it also holds ${esc(testList(also))}; “Detect from the columns” reads every test` : `it looks like ${esc(testList(also))}`})` : ''}`;
    const refusedNote = !refusedRows.length ? ''
      : refusedRows.every((r) => !r.ok.length)
        ? `${refusedRows.length === 1 ? 'One row holds a value' : `${refusedRows.length} rows hold values`} no measurement can have, so ${refusedRows.length === 1 ? 'it is' : 'they are'} left unticked and will not be imported even if ticked. Correct the sheet and read it again.`
        : `Values no measurement can have (marked) are left out even if their row is ticked; the other tests on those rows are imported. Correct the sheet and read it again for the rest.`;
    // The date and operator the results are stored under sit beside the button that stores them. Reading the
    // table again (another import type) keeps what was typed into them.
    const when = el.querySelector('#importDate')?.value || todayISO(), who = el.querySelector('#importOperator')?.value ?? settings.operator ?? '';
    el.querySelector('#importPreview').innerHTML = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0 6px"><b>${esc(file.name)}</b><span class="muted" id="importReadAs">${readAs} · ${parsed.rows.length} row${parsed.rows.length === 1 ? '' : 's'} → ${samples.length} sample${samples.length === 1 ? '' : 's'} · SHA-256 ${hash.slice(0, 8)}…</span>${chip(`${matched} matched`, 'ok')} ${chip(`${rows.length - matched} unmatched`, rows.length - matched ? 'warn' : '')}${refusedRows.length ? ' ' + chip(`${refusedRows.length} refused`, 'bad') : ''}</div>
      ${dupHtml}${missingHtml}${apartHtml}
      <div style="overflow-x:auto"><table class="impTable${multi ? ' multi' : ''}${gridLook ? ' egrid' : ''}"><thead>${head}</thead><tbody>${body}</tbody></table></div>
      ${refusedNote ? `<div class="note warn">${refusedNote}</div>` : ''}
      <div class="impGo"><button class="primary" id="doImport">Import selected</button>
        <label class="inline">measured <input type="date" id="importDate" value="${esc(when)}" aria-label="Date measured, unless the file gives one"></label>
        <label class="inline">by <input type="text" id="importOperator" value="${esc(who)}" aria-label="Operator"></label>
        <span class="muted" id="importKept">${file.name === 'pasted' ? 'The results keep a SHA-256 of the pasted rows, not the rows themselves: keep the instrument’s file.' : 'The results keep the file’s name and SHA-256, not the file itself: keep the instrument file.'} Nothing is overwritten.</span></div>`;
    const sameView = shown;
    el.querySelector('#importAgain')?.addEventListener('click', async () => {
      if (!(await ask(againQ)) || shown !== sameView) return; // awaited: a promise in the macOS app (kit.js)
      again = true;
      rows.forEach((r, i) => { if (r.ok.length) el.querySelector(`[data-imp="${i}"]`).checked = true; });
      el.querySelector('#importDup').textContent = `Importing ${it} again: the ticked results will be stored a second time, beside the first.`;
    });
    el.querySelector('#doImport').addEventListener('click', async () => {
      const date = el.querySelector('#importDate').value, operator = el.querySelector('#importOperator').value;
      const ticked = (i) => el.querySelector(`[data-imp="${i}"]`).checked;
      // A file already imported goes in again only when someone says so, rows ticked by hand included.
      if (dup && !again) {
        if (!rows.some((r, i) => ticked(i))) { toast(`Nothing was imported: ${dupWhat.toLowerCase()} imported before, so nothing is ticked. “Import ${it} again” above stores ${it} a second time.`, 'warn'); return; }
        if (!(await ask(againQ)) || shown !== sameView) return;
        again = true;
      }
      // A refused value stays out even when someone ticks its row again, and the reason is said rather than swallowed.
      const refused = rows.filter((r, i) => r.refused.length && ticked(i));
      if (refused.length) toast(`Not imported: ${refused.map((r) => `${r.sampleName}: ${r.refused.flatMap((t) => r.per[t].check.errors.map((e) => e.text)).join('; ')}`).join(' · ')}`, 'warn');
      let n = 0, boxed = 0;
      const measurementIds = [], inboxIds = []; // kept on the import, so its evaluation can be drawn and reopened
      // The results, the rows for the inbox and the import's own record are one write, stored together or not
      // at all. Only the results used to be undone when the disk was full: the record of an import that stored
      // nothing and its inbox rows were stored later, and importing the file again, as the note says, put the
      // rows in the inbox twice (usability cycle 6, W2). As the experiment wizard does, the screen moves on once
      // it is stored, and keeps the preview when it is not, for "Import selected" to be pressed again.
      // The preview is still showing while its button is (reading a file again replaces it). The record's id is
      // chosen first: with localStorage, onSaved runs before transaction() has returned.
      const go = el.querySelector('#doImport'), impId = uid();
      const busy = (on) => { go.disabled = on; go.textContent = on ? 'Importing …' : 'Import selected'; };
      busy(true); // until it is stored or undone: a second press would import the file twice
      ctx.store.transaction(() => {
        rows.forEach((r, i) => {
          if (!ticked(i)) return;
          const sel = el.querySelector(`[data-target="${i}"]`)?.value;
          if (sel === '__ignore') return;
          // One result per test with a reading, each against its own slot: the size closes the DLS slot and the EE
          // the EE slot, as two imports of the same sheet would have. A test with no reading has nothing to store.
          for (const t of r.ok) {
            const p = r.per[t];
            const slot = p.match?.slot || (sel ? openSlots.find((s) => s.sampleName === sel && s.test === t) : null);
            const batchId = slot?.batchId || p.match?.batchId || (sel ? openSlots.find((s) => s.sampleName === sel)?.batchId : null) || null;
            if (!batchId) { inboxIds.push(ctx.store.put('inbox', { id: uid(), sampleName: r.sampleName, test: t, values: p.values, date, operator, raw: { fileName: file.name, sha256: hash } }).id); boxed++; continue; }
            measurementIds.push(saveMeasurement(ctx, settings, { slot, batchId, experimentId: slot?.experimentId || experiments.find((e) => e.batchIds?.includes(batchId))?.id || null, stage: slot?.stage || (r.sampleName.match(/IPC\d|T\d+|final/i) || ['final'])[0], test: t, values: p.values, date: p.s.date?.slice(0, 10) || date, operator, sampleName: r.sampleName, raw: { fileName: file.name, sha256: hash, parser: ['dls', 'zeta'].includes(t) ? 'csv-dls' : `csv-${t}`, parserVersion: 1 }, condition: slot?.condition, timepoint: slot?.timepoint, formulation: slot?.formulation }).id);
            n++;
          }
        });
        // `samples` is what the evaluation counts against what was stored, so for a sheet of several tests it is the
        // results the file held (a size and an EE per vial), and `rows` the vials. One test: the rows, as always.
        const results = rows.reduce((a, r) => a + r.withValue.length, 0);
        ctx.store.put('imports', { id: impId, fileName: file.name, sha256: hash, importedAt: new Date().toISOString(), tests, samples: multi ? results : rows.length, rows: rows.length, imported: n, inbox: boxed, measurementIds, inboxIds });
      }, {
        what: `the import of ${file.name === 'pasted' ? 'the pasted block' : file.name}`, again: 'Import selected',
        onSaved: () => {
          const said = `Imported ${n} result${n === 1 ? '' : 's'}${boxed ? `, ${boxed} to inbox` : ''}`;
          if (go.isConnected) { toast(said, 'ok'); ctx.navigate('measurements', { evaluated: impId }); }
          else toast(said, 'ok', { action: 'Open', onAction: () => ctx.navigate('measurements', { evaluated: impId }) });
        },
        onUndone: () => { busy(false); return go.isConnected; },
      });
    });
  }

  // ---- inbox ----
  el.querySelectorAll('[data-assignbtn]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.assignbtn, sel = el.querySelector(`[data-assign="${id}"]`).value;
    const r = inbox.find((x) => x.id === id), slot = openSlots.find((s) => s.id === sel);
    if (!slot) { toast('Choose a target', 'warn'); return; }
    // The result, its import's link to it and the row leaving the inbox are one write. Written beside the
    // result's own transaction, the inbox row's removal outlived the undo of a result that could not be stored,
    // and was stored later: the result was then in neither place (usability cycle 6, W2).
    ctx.store.transaction(() => {
      const rec = saveMeasurement(ctx, settings, { slot, batchId: slot.batchId, experimentId: slot.experimentId, stage: slot.stage, test: r.test, values: r.values, date: r.date, operator: r.operator, sampleName: r.sampleName, raw: r.raw, condition: slot.condition, timepoint: slot.timepoint, formulation: slot.formulation });
      linkAssignedToImport(ctx, id, rec.id);
      ctx.store.remove('inbox', id);
    }, { what: `the result for ${r.sampleName}` });
    toast('Assigned', 'ok'); render(el, ctx);
  }));
  el.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', () => { ctx.store.remove('inbox', b.dataset.drop); render(el, ctx); }));
}


function detail(el, ctx, settings, id) {
  const m = ctx.store.get('measurements', id);
  if (!m) { el.innerHTML = header('Measurements', 'Not found'); return; }
  el.innerHTML = header(raw(`<a href="#/measurements">Measurements</a> › ${esc(m.sampleName || m.batchId)}`), `${m.test.toUpperCase()} · ${m.sampleName || m.batchId}`, `${m.batchId ? `<a class="btn" href="#/formulation?batch=${esc(m.batchId)}">The formulation</a>` : ''}${m.experimentId ? `<a class="btn" href="#/experiments?id=${esc(m.experimentId)}">The plan</a>` : ''}<button id="editResult">Edit</button><button id="del" style="color:var(--warn)">Delete</button>`) +
    `<div class="card"><div class="grid g4">${[['Date', fmtDate(m.date)], ['Operator', m.operator || '–'], ['Stage', m.stage || '–'], ['Result', summarize(m)]].map(([l, v]) => `<div class="kpi"><div class="l">${l}</div><div class="v" style="font-size:15px">${v}</div></div>`).join('')}</div>
      ${(m.flags || []).map((f) => `<div class="note ${f.level === 'warn' ? 'warn' : ''}">${f.text}</div>`).join('')}
      <div id="resultValues">${valuesView(m)}</div>
      <p class="muted">Source: ${esc(provenanceLine(m))}</p>
      ${m.raw ? `<p class="muted">Raw: ${m.raw.fileName || ''} ${m.raw.sha256 ? '· SHA-256 ' + m.raw.sha256.slice(0, 16) + '…' : ''} ${m.raw.parser ? '· parser ' + m.raw.parser + ' v' + m.raw.parserVersion : ''}</p>` : ''}
      ${m.remarks ? `<p>${m.remarks}</p>` : ''}</div>`;
  el.querySelector('#editResult').addEventListener('click', () => {
    el.querySelector('#editResult').disabled = true;
    el.querySelector('#resultValues').innerHTML = editForm(m);
    wireEdit(el, ctx, settings, m);
  });
  el.querySelector('#del').addEventListener('click', async () => {
    if (!(await ask('Delete this result? The expected slot is reopened.'))) return; // awaited: a promise in the macOS app (kit.js)
    if (m.slotId && m.experimentId) { const e = ctx.store.get('experiments', m.experimentId); const s = e?.expected.find((x) => x.id === m.slotId); if (s) { s.status = 'open'; s.measurementId = null; ctx.store.put('experiments', e); } }
    ctx.store.remove('measurements', m.id); toast('Deleted'); ctx.navigate('measurements');
  });
}

/** The values of a stored result, its runs, and every correction made to it, newest first. */
function valuesView(m) {
  // A field the source had no column for is stored empty; listing it as "null" told nobody anything.
  const rows = Object.entries(m.values || {}).filter(([k, v]) => k !== 'runs' && v != null).map(([k, v]) => ({ cells: [k, typeof v === 'number' ? fmt(v, 3) : String(v)] }));
  return `<h2 style="margin-top:12px">Values</h2>${table(['Field', 'Value'], rows)}
    ${m.values?.runs ? `<h2 style="margin-top:12px">Runs</h2>${runsTable(m.values.runs)}` : ''}
    ${historyHtml(m)}`;
}

/**
 * "Corrected 27 Oct 2026 by GM: typo — was PDI 0.5". Each history entry holds the values it replaced; what
 * replaced them is the next entry's values, or the values now.
 */
function historyHtml(m) {
  const h = m.history || [];
  if (!h.length) return '';
  const lines = h.map((x, i) => {
    const was = describeCorrection(m.test, x.values || {}, h[i + 1]?.values || m.values || {});
    return `<li>Corrected ${esc(fmtDate(x.at))}${x.by ? ` by ${esc(x.by)}` : ''}: ${esc(x.reason)}${was ? ` — was ${esc(was)}` : ''}</li>`;
  }).reverse();
  return `<div id="resultHistory"><h3>Corrections</h3><ul class="history">${lines.join('')}</ul></div>`;
}

// The replicate fields a run can carry, in the order the runs table shows them.
const RUN_FIELDS = [['zave_nm', 'Z-ave', 'nm'], ['pdi', 'PDI', ''], ['ee_pct', 'EE', '%'], ['total_mg_mL', 'Total RNA', 'mg/mL'], ['free_mg_mL', 'Free RNA', 'mg/mL'], ['rna_mg_mL', 'RNA', 'mg/mL']];
// A number as it goes into a text box: as stored, without the sixteenth digit a mean of three runs carries.
const asTyped = (x) => (x == null ? '' : typeof x === 'number' ? String(+x.toPrecision(10)) : String(x));
// The mean of runs as its box shows it: one decimal past the finest run, rather than 83.14666667 (usability
// cycle 6, I9). Only shown: a mean is worked out from its runs again when they are saved.
const decimalsOf = (x) => { const m = /[.,](\d+)/.exec(asTyped(x)); return m ? m[1].length : 0; };
const meanShown = (x, runs) => (x == null ? '' : String(+Number(x).toFixed(Math.min(6, Math.max(0, ...runs.map(decimalsOf)) + 1))));
// The fields a result's runs carry a number for: their mean is worked out from the runs, not typed.
const runKeys = (v) => RUN_FIELDS.map(([k]) => k).filter((k) => (v.runs || []).some((r) => Number.isFinite(r?.[k])));

/**
 * The values of a stored result as a form, with the reason the correction needs. The fields are text boxes
 * rather than number inputs: a number input hands over an empty string for "0,5", which would have cleared the
 * value without a word, while text is read here and a non-number is refused by name.
 */
function editForm(m) {
  const v = m.values || {};
  const listed = TEST_FIELDS[m.test] || [['value', 'Value']];
  // Anything else the record holds (other than runs and the spreads worked out from them) is editable too.
  const extra = Object.keys(v).filter((k) => k !== 'runs' && !/_sd$/.test(k) && !listed.some(([key]) => key === k)).map((k) => [k, k.replace(/_/g, ' '), typeof v[k] === 'number' ? undefined : 'text']);
  const derived = runKeys(v);
  const input = (name, value, { text = false, readonly = false, label = '', key = '' } = {}) => `<input type="text" ${text ? '' : 'inputmode="decimal"'} autocomplete="off" spellcheck="false" name="${esc(name)}" value="${esc(asTyped(value))}" data-orig="${esc(asTyped(value))}" data-kind="${text ? 'text' : 'number'}" ${key ? `data-key="${esc(key)}"` : ''} ${readonly ? 'readonly' : ''} aria-label="${esc(label)}">`;
  const fields = [...listed, ...extra].map(([k, label, ty]) => `<div><label>${esc(label)}</label>${input('e_' + k, derived.includes(k) ? meanShown(v[k], (v.runs || []).map((r) => r?.[k]).filter(Number.isFinite)) : v[k], { text: ty === 'text', readonly: derived.includes(k), label })}${derived.includes(k) ? '<div class="muted">the mean of the runs</div>' : ''}</div>`).join('');
  const runs = v.runs || [];
  const cols = RUN_FIELDS.filter(([k]) => runs.some((r) => k in (r || {})));
  const runsHtml = runs.length && cols.length ? `<h3>Runs</h3><table class="editRuns"><thead><tr><th>#</th>${cols.map(([, l, u]) => `<th style="text-align:right">${esc(l)}${u ? `<div class="muted" style="font-weight:400;font-size:11px">${esc(u)}</div>` : ''}</th>`).join('')}</tr></thead>
    <tbody>${runs.map((r, i) => `<tr><td>${i + 1}</td>${cols.map(([k, l]) => `<td>${input(`er_${i}_${k}`, r?.[k], { label: `run ${i + 1} ${l}`, key: k })}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <p class="muted">Clear every cell of a run to drop it. The mean follows the runs.</p>` : '';
  return `<div id="editForm"><h2 style="margin-top:12px">Correct this result</h2>
    <div class="grid g4">${fields}</div>${runsHtml}
    <div class="grid g2" style="margin-top:10px"><div><label for="editReason">Why it is corrected (kept with the old values)</label>
      <input type="text" id="editReason" name="editReason" list="editReasons" autocomplete="off" placeholder="typo, re-measured …">
      <datalist id="editReasons"><option value="typo"></option><option value="re-measured"></option><option value="wrong sample"></option><option value="wrong unit"></option></datalist></div></div>
    <div style="margin-top:10px;display:flex;gap:8px"><button class="primary" id="saveEdit">Save the correction</button><button id="cancelEdit">Cancel</button></div>
    <div id="editCheck"></div></div>${historyHtml(m)}`;
}

function wireEdit(el, ctx, settings, m) {
  const form = el.querySelector('#editForm');
  const v = m.values || {};
  const derived = runKeys(v);
  const runInputs = (k) => [...form.querySelectorAll(`.editRuns input[data-key="${k}"]`)];
  // The mean in its box follows the runs while they are typed; with no run left it is a value to type instead.
  form.querySelector('.editRuns')?.addEventListener('input', () => {
    for (const k of derived) {
      const box = form.querySelector(`[name="e_${k}"]`);
      if (!box) continue;
      const typed = runInputs(k).filter((i) => Number.isFinite(cellNumber(i.value)));
      const x = mean(typed.map((i) => cellNumber(i.value)));
      box.readOnly = x != null || !runInputs(k).every((i) => !i.value.trim());
      if (x != null) box.value = meanShown(x, typed.map((i) => i.value.trim()));
    }
  });
  form.addEventListener('input', (e) => e.target.classList?.remove('invalid'));
  el.querySelector('#cancelEdit').addEventListener('click', () => detail(el, ctx, settings, m.id));
  el.querySelector('#saveEdit').addEventListener('click', () => {
    const errors = [];
    // A field left as it was keeps the stored number exactly, not the rounded one the box shows.
    const read = (inp, label, put, drop) => {
      if (inp.value === inp.dataset.orig) return;
      const t = inp.value.trim();
      if (!t) return drop();
      if (inp.dataset.kind === 'text') return put(t);
      const x = cellNumber(t);
      if (Number.isNaN(x)) errors.push({ input: inp, text: `${label} "${t}" is not a number` }); else put(x);
    };
    const values = { ...v };
    delete values.runs;
    for (const inp of form.querySelectorAll('input[name^="e_"]')) {
      if (inp.readOnly) continue; // a mean of runs is worked out from them when they change
      const k = inp.name.slice(2);
      read(inp, inp.closest('div')?.querySelector('label')?.textContent || k, (x) => { values[k] = x; }, () => { delete values[k]; });
    }
    // Runs, with the index each kept run had, so a refusal can point at the box it came from.
    const kept = [];
    if (Array.isArray(v.runs)) {
      values.runs = [];
      v.runs.forEach((r, i) => {
        const run = { ...r };
        for (const inp of form.querySelectorAll(`.editRuns input[name^="er_${i}_"]`)) {
          const k = inp.dataset.key;
          read(inp, inp.getAttribute('aria-label'), (x) => { run[k] = x; }, () => { run[k] = null; });
        }
        if (Object.values(run).some((x) => x != null && x !== '')) { values.runs.push(run); kept.push(i); }
      });
    }
    const res = errors.length ? null : correctResult(m, { values, reason: el.querySelector('#editReason').value, by: settings.operator || '', at: new Date().toISOString() }, settings.qc);
    const all = [...errors, ...(res?.errors || [])];
    form.querySelectorAll('input.invalid').forEach((i) => i.classList.remove('invalid'));
    for (const e of all) {
      const box = e.input || (e.key === 'reason' ? el.querySelector('#editReason') : e.run != null ? form.querySelector(`[name="er_${kept[e.run]}_${e.key}"]`) : e.key ? form.querySelector(`[name="e_${e.key}"]`) : null);
      box?.classList.add('invalid');
    }
    el.querySelector('#editCheck').innerHTML = all.length ? `<div class="note warn"><b>Not saved.</b> ${all.map((e) => esc(e.text)).join('<br>')}</div>` : '';
    if (all.length) return;
    ctx.store.put('measurements', res.record);
    toast(res.warnings.length ? `Corrected. Worth a look: ${res.warnings.map((w) => w.text).join('; ')}` : 'Corrected; the old values are kept with the reason', res.warnings.length ? 'warn' : 'ok');
    detail(el, ctx, settings, m.id);
  });
  el.querySelector('#editReason').focus();
}

/** The replicates behind a stored mean, with the columns they actually have: DLS runs, or RiboGreen wells. */
function runsTable(runs) {
  const known = [['zave_nm', 'Z-ave', 2], ['pdi', 'PDI', 3], ['ee_pct', 'EE %', 1], ['total_mg_mL', 'Total RNA', 4], ['free_mg_mL', 'Free RNA', 4], ['rna_mg_mL', 'RNA mg/mL', 4]];
  // DLS runs keep both columns even when a run has no PDI, as this table always showed them.
  const dls = runs.some((r) => 'zave_nm' in r);
  const cols = known.filter(([k], i) => (dls && i < 2) || runs.some((r) => r[k] != null));
  return table(['#', ...cols.map(([, label]) => ({ label, right: true }))], runs.map((r, i) => ({ cells: [i + 1, ...cols.map(([k, , d]) => fmt(r[k], d))] })));
}

/**
 * What the lab is waiting for, and the two things that make the results come back matchable.
 *
 * Import is only easy when the sample names in the file are the ones the app is expecting, and the moment to
 * get that right is before the instrument runs, not after. So the names are here to copy into the instrument's
 * sample list, and a blank sheet with those names already in it is here to fill in by hand — either way the
 * file that comes back matches every row without anyone mapping anything.
 *
 * The card leads with what is due across every experiment, as Overdue, Today and the coming week, one line per
 * experiment and stage. A line is what one sitting at the instrument covers, and its buttons act on exactly the
 * samples it counts. Under the lines, any experiment can be taken whole (#waitExp): the "What to measure" links
 * of an experiment land there, and its samples are listed.
 */
function dueCard(ctx, settings, lines, w, openSlots, today) {
  let body;
  if (!openSlots.length) body = '<p class="muted" style="margin:0">Nothing is waiting for results. Setting an experiment up puts its measurements here.</p>';
  else if (!lines.length) {
    // Nothing within the week, so the first open slot (they are sorted by due date) is the next thing.
    const n = openSlots[0], exp = w?.choices.find((c) => c.id === n.experimentId)?.exp;
    const count = vials(openSlots.filter((s) => s.experimentId === n.experimentId && s.stage === n.stage && s.dueDate === n.dueDate)).length;
    body = `<p style="margin:0">Nothing is due in the next ${DUE_AHEAD} days. Next: <a href="#/experiments?id=${encodeURIComponent(n.experimentId)}">${esc(n.experimentId)}</a>${exp?.name ? ` · ${esc(exp.name)}` : ''} — ${esc(n.stage)}, ${plural(count, 'sample')}, due ${esc(dayLabel(n.dueDate))} (in ${plural(daysBetween(today, n.dueDate), 'day')}).</p>`;
  } else {
    // The line whose grid is open below is marked, so the grid reads as that line's and not the experiment's.
    const open = ctx.params.grid && w?.scope ? `${w.scope.due}|${w.want.id}|${w.scope.stage}` : '';
    body = DUE_GROUPS.map(([g, label]) => {
      const mine = lines.map((l, i) => [l, i]).filter(([l]) => l.bucket === g);
      if (!mine.length) return '';
      const more = mine.length - DUE_LINES;
      return `<div class="dueGroup ${g}"><h3>${esc(label)}</h3>${mine.map(([l, i], k) => dueLineHtml(l, i, today, k >= DUE_LINES, open === `${l.bucket}|${l.experimentId}|${l.stage}`)).join('')}
        ${more > 0 ? `<button type="button" class="dueMore" data-due-more="${g}">${more} more</button>` : ''}</div>`;
    }).join('');
  }
  return `<div class="card" id="dueCard"><h2>Due</h2>${body}${w ? waitBar(ctx, settings, w, today) : ''}</div>`;
}

/**
 * The lines of the Due card: open slots due before the end of the coming week, one line per group, experiment
 * and stage. A stage whose samples fall due on different days (a DoE made over a week) gets a line in each group
 * it reaches, so something overdue never hides inside "coming". Overdue lists the most recently missed first: a
 * timepoint missed last week is still worth measuring, while one from a study abandoned months ago mostly is
 * not, and should not push the first out of sight.
 */
function dueLines(experiments, openSlots, today) {
  const horizon = addDays(today, DUE_AHEAD);
  const exps = new Map(experiments.map((e) => [e.id, e]));
  const byKey = new Map();
  for (const s of openSlots) {
    const bucket = bucketOf(s.dueDate, today, horizon);
    if (bucket === 'later') continue;
    const key = `${bucket}|${s.experimentId}|${s.stage}`;
    if (!byKey.has(key)) byKey.set(key, { bucket, experimentId: s.experimentId, stage: s.stage, slots: [] });
    byKey.get(key).slots.push(s);
  }
  const lines = [...byKey.values()].map((l) => {
    const dates = l.slots.map((s) => s.dueDate).sort();
    return { ...l, exp: exps.get(l.experimentId), rows: vials(l.slots), first: dates[0], last: dates[dates.length - 1],
      tests: [...new Set(l.slots.map((s) => s.test))].sort((a, b) => testRank(a) - testRank(b)) };
  });
  const order = { overdue: (a, b) => b.last.localeCompare(a.last), today: () => 0, coming: (a, b) => a.first.localeCompare(b.first) };
  return DUE_GROUPS.flatMap(([g]) => lines.filter((l) => l.bucket === g)
    .sort((a, b) => order[g](a, b) || expNumber(a.experimentId) - expNumber(b.experimentId) || stageOrder(a.stage, b.stage)));
}
// T0, T7, T14 in the order of the days, not of the characters; anything else alphabetically.
const stageDay = (s) => Number(/^T(\d+)$/.exec(s)?.[1] ?? NaN);
const stageOrder = (a, b) => stageDay(a) - stageDay(b) || String(a).localeCompare(String(b));

/** "3 days overdue", "due today", "due tomorrow", "due Thu 12 Nov – Mon 16 Nov". */
function dueWhen(l, today) {
  if (l.bucket === 'today') return 'due today';
  if (l.bucket === 'overdue') {
    const most = daysBetween(l.first, today), least = daysBetween(l.last, today);
    return `${most === least ? plural(most, 'day') : `${least}–${most} days`} overdue`;
  }
  const rel = (iso) => (daysBetween(today, iso) === 1 ? 'tomorrow' : dayLabel(iso));
  return l.first === l.last ? `due ${rel(l.first)}` : `due ${rel(l.first)} – ${dayLabel(l.last)}`;
}

/** "E5 · Storage: PEG 1.5 vs 3 — T14, 8 samples (DLS, EE) — due today", and what can be done with them. */
function dueLineHtml(l, i, today, hide, on = false) {
  const gridable = l.rows.some((r) => r.tests.some((t) => GRID_FIELDS[t]));
  const dates = l.first === l.last ? fmtDate(l.first) : `${fmtDate(l.first)} to ${fmtDate(l.last)}`;
  return `<div class="dueLine${on ? ' on' : ''}" data-line="${i}"${on ? ' aria-current="true"' : ''}${hide && !on ? ' hidden' : ''}>
    <span class="dueWhat"><a href="#/experiments?id=${encodeURIComponent(l.experimentId)}">${esc(l.experimentId)}</a>${l.exp?.name ? ` · ${esc(l.exp.name)}` : ''} — ${esc(l.stage)},
      <button type="button" class="dueN" data-due-names="${i}" aria-expanded="false" title="Show the sample names">${plural(l.rows.length, 'sample')}</button>
      (${esc(l.tests.map((t) => TEST_LABEL[t] || t).join(', '))}) — <span class="dueWhen ${l.bucket}" title="Due ${esc(dates)}">${esc(dueWhen(l, today))}</span></span>
    <span class="dueActs"><button type="button" data-due-copy="${i}" title="Copy these sample names, one per line, for the instrument's sample list">Copy names</button><button type="button" data-due-sheet="${i}" title="A CSV with these sample names and a column for every test still due">Blank sheet</button>${gridable ? `<button type="button" data-due-grid="${i}" title="Type these results in as a grid">Grid</button>` : ''}</span>
    <div class="dueNames" data-due-list="${i}" hidden>${l.rows.map((r) => `<code>${esc(r.sampleName)}</code>`).join(' ')}</div></div>`;
}

/**
 * Under the due lines: one experiment taken whole, or the part of it a due line narrowed it to. Its sample names
 * wait behind a button unless the address asked for this experiment (a "What to measure" link), and the grid,
 * when open, takes their place.
 */
function waitBar(ctx, settings, w, today) {
  const { choices, want, rows, scope } = w;
  const grid = !!ctx.params.grid;
  const overdue = rows.filter((r) => r.dueDate < today).length;
  const showNames = !!ctx.params.waiting && !grid;
  const listed = rows.slice(0, 40);
  return `<div class="waitBar"><label class="inline" for="waitExp">Samples of</label>
      <select id="waitExp">${choices.map((c) => `<option value="${esc(c.id)}" ${c.id === want.id ? 'selected' : ''}>${esc(describeId(c.id))} · ${esc(c.exp.name || '')} (${c.n} open)</option>`).join('')}</select>
      ${scope ? `<span class="chip info waitScope">${esc([scope.stage, scope.due && DUE_WORD[scope.due]].filter(Boolean).join(' · '))}<button type="button" id="waitScope" aria-label="Every sample of this experiment" title="Every sample of this experiment">×</button></span>` : ''}
      <button id="copyNames">Copy sample names</button><button id="blankSheet" title="One row per sample, and a column for every test still due">Blank sheet (CSV)</button>${grid ? '' : '<button id="gridOpen">Type results as a grid</button>'}
      ${grid ? '' : `<button type="button" id="waitShow" class="dueN" aria-expanded="${showNames}" aria-controls="waitNames">${showNames ? 'Hide the names' : `Show the ${plural(rows.length, 'name')}`}</button>`}</div>
    ${grid ? gridHtml(rows, settings, overdue) : `<div id="waitNames"${showNames ? '' : ' hidden'}>
      <p class="muted">One row per sample, with every test it is still due. Name the samples on the instrument exactly as below and the export will match every row by itself. ${overdue ? `<b>${overdue}</b> of these ${overdue === 1 ? 'is' : 'are'} past due.` : ''}</p>
      ${table(['Sample name', 'Formulation', 'Stage', 'Tests due', 'Due'], listed.map((r) => ({ cells: [
        raw(`<span data-wait-name="${esc(r.sampleName)}" style="font-family:ui-monospace,Menlo,monospace;font-size:12px">${esc(r.sampleName)}</span>`),
        raw(`<a href="#/formulation?batch=${esc(r.batchId)}">${esc(r.batchId)}</a>`), r.stage, r.tests.join(', '),
        raw(r.dueDate < today ? `<span class="chip warn">${fmtDate(r.dueDate)}</span>` : fmtDate(r.dueDate)),
      ] })))}
      ${rows.length > listed.length ? `<p class="muted">and ${rows.length - listed.length} more; Copy and the blank sheet carry all of them.</p>` : ''}</div>`}`;
}

/**
 * One row per sample, not per test: a sample is a vial, and the vial is what gets a name on the instrument. Each
 * row keeps the open slot of every test it is still due, which is what the grid saves into.
 */
function vials(slots) {
  const byName = new Map();
  for (const s of slots) {
    const r = byName.get(s.sampleName);
    if (r) { if (!r.tests.includes(s.test)) r.tests.push(s.test); r.slots[s.test] ||= s; if (s.dueDate < r.dueDate) r.dueDate = s.dueDate; }
    else byName.set(s.sampleName, { sampleName: s.sampleName, batchId: s.batchId, stage: s.stage, dueDate: s.dueDate, tests: [s.test], slots: { [s.test]: s } });
  }
  return [...byName.values()];
}

/**
 * The experiment the bar shows, the others it could show, and the samples it acts on: all of that experiment's
 * open samples, or the part a due line narrowed it to (?stage=T14&due=today), for the grid, the sheet and Copy
 * alike. Once nothing is left in that part (all of it saved), the experiment's other samples are shown.
 */
function waitingFor(ctx, experiments, openSlots, today) {
  if (!openSlots.length) return null;
  const byExp = new Map();
  for (const s of openSlots) byExp.set(s.experimentId, (byExp.get(s.experimentId) || 0) + 1);
  const choices = [...byExp.keys()].map((id) => ({ id, exp: experiments.find((e) => e.id === id), n: byExp.get(id) }))
    .filter((c) => c.exp)
    .sort((a, b) => String(a.exp.startDate || '').localeCompare(String(b.exp.startDate || '')) * -1);
  if (!choices.length) return null;
  const want = choices.find((c) => c.id === ctx.params.waiting) || choices[0];
  const mine = openSlots.filter((x) => x.experimentId === want.id);
  const all = vials(mine);
  const { stage, due } = want.id === ctx.params.waiting ? ctx.params : {};
  if (stage || due) {
    const horizon = addDays(today, DUE_AHEAD);
    const rows = vials(mine.filter((x) => (!stage || x.stage === stage) && (!due || bucketOf(x.dueDate, today, horizon) === due)));
    if (rows.length) return { choices, want, all, rows, scope: { stage, due } };
  }
  return { choices, want, all, rows: all, scope: null };
}

/** The buttons of the due lines and of the bar under them, and the grid when it is open. */
function wireDue(el, ctx, settings, lines, w, openSlots) {
  const card = el.querySelector('#dueCard');
  card?.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    const d = b?.dataset || {};
    const line = (k) => lines[Number(k)];
    if (d.dueCopy != null) copyNames(line(d.dueCopy).rows);
    else if (d.dueSheet != null) { const l = line(d.dueSheet); sheetFor(l.rows, `${l.experimentId}_${l.stage}_samples.csv`); }
    else if (d.dueGrid != null) { const l = line(d.dueGrid); ctx.navigate('measurements', { ...ctx.params, waiting: l.experimentId, stage: l.stage, due: l.bucket, grid: 1 }); }
    else if (d.dueNames != null) { const list = card.querySelector(`[data-due-list="${d.dueNames}"]`); list.hidden = !list.hidden; b.setAttribute('aria-expanded', String(!list.hidden)); }
    else if (d.dueMore) { card.querySelectorAll(`.dueGroup.${d.dueMore} .dueLine[hidden]`).forEach((x) => { x.hidden = false; }); b.remove(); }
  });
  el.querySelector('#waitExp')?.addEventListener('change', (e) => ctx.navigate('measurements', { ...ctx.params, waiting: e.target.value, stage: undefined, due: undefined }));
  el.querySelector('#waitScope')?.addEventListener('click', () => ctx.navigate('measurements', { ...ctx.params, stage: undefined, due: undefined }));
  el.querySelector('#copyNames')?.addEventListener('click', () => copyNames(w.rows));
  el.querySelector('#blankSheet')?.addEventListener('click', () => sheetFor(w.rows, `${w.want.id}${w.scope?.stage ? '_' + w.scope.stage : ''}_samples.csv`));
  el.querySelector('#waitShow')?.addEventListener('click', (e) => {
    const box = el.querySelector('#waitNames');
    box.hidden = !box.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!box.hidden));
    e.currentTarget.textContent = box.hidden ? `Show the ${plural(w.rows.length, 'name')}` : 'Hide the names';
  });
  el.querySelector('#gridOpen')?.addEventListener('click', () => ctx.navigate('measurements', { ...ctx.params, grid: 1 }));
  // Closing the grid also lets go of the due line it was opened from, which would otherwise linger as a chip.
  el.querySelector('#gridClose')?.addEventListener('click', () => ctx.navigate('measurements', { ...ctx.params, grid: undefined, stage: undefined, due: undefined }));
  wireGrid(el, ctx, settings, openSlots, () => render(el, ctx));
}

/** The sample names onto the clipboard, one per line, the way an instrument's sample list takes them pasted. */
async function copyNames(rows) {
  const names = [...new Set(rows.map((r) => r.sampleName))];
  if (!names.length) return;
  try { await navigator.clipboard.writeText(names.join('\n')); toast(`${plural(names.length, 'sample name')} copied`, 'ok'); }
  catch { toast('Could not reach the clipboard; use the blank sheet instead', 'warn'); }
}

/**
 * A blank sheet for these samples, with a column for every test still due among them: size, PDI and EE go on one
 * sheet and come back in one import. The header names are the ones the parser already knows, so every row
 * matches by construction, without a mapping step.
 */
function sheetFor(rows, fileName) {
  if (!rows.length) return;
  download(fileName, blankSheet(rows.map((r) => r.sampleName), [...new Set(rows.flatMap((r) => r.tests))]), 'text/csv');
}

/**
 * Typing one result in by hand. Folded, the card is one line holding the choice of sample, because that is the
 * first thing the form asks anyway: choosing it opens the rest, filled in for that sample, with no click in
 * between. "Free entry" opens it for a result nothing was expecting (a retest, an in-process sample).
 */
function manualCard(ctx, settings, openSlots, batches, filterBatch, open, today) {
  const horizon = addDays(today, DUE_AHEAD);
  const slots = openSlots.filter((s) => !filterBatch || s.batchId === filterBatch);
  const opt = (s) => `<option value="${esc(s.id)}"${s.id === ctx.params.slot ? ' selected' : ''}>${esc(`${s.sampleName} · ${s.test} · due ${fmtDate(s.dueDate)}`)}</option>`;
  // Grouped as the Due card groups them, and in due-date order inside each group as before.
  const groups = [['overdue', 'Overdue'], ['today', 'Due today'], ['coming', `Next ${DUE_AHEAD} days`], ['later', 'Later']].map(([g, label]) => {
    const xs = slots.filter((s) => bucketOf(s.dueDate, today, horizon) === g);
    return xs.length ? `<optgroup label="${esc(label)}">${xs.map(opt).join('')}</optgroup>` : '';
  }).join('');
  return `<div class="card" id="manualCard"><div id="manualForm">
    <div class="foldLine"><h2>Type one result</h2>
      <select id="slotId" name="slotId" aria-label="Expected measurement (sorted by due date)"><option value="">— choose the sample, or free entry —</option>${groups}</select>
      <button type="button" id="manualFree"${open ? ' hidden' : ''}>Free entry</button></div>
    <div id="manualBody"${open ? '' : ' hidden'}><div class="grid g4" style="margin-top:12px">
      ${field({ id: 'batchId', label: 'Formulation (free entry)', type: 'select', value: filterBatch, options: [{ value: '', label: '—' }, ...batches.map((b) => ({ value: b.id, label: `${b.id} (${b.experimentId})` }))] })}
      ${field({ id: 'stage', label: 'Stage / timepoint', type: 'text', value: 'final', placeholder: 'final, IPC4, T7 …' })}
      ${field({ id: 'test', label: 'Test', type: 'select', value: ctx.params.test || 'dls', options: TESTS.map((t) => ({ value: t.id, label: t.name })).concat([{ value: 'endotoxin', label: 'Endotoxin' }]) })}
      </div><div id="testFields" class="grid g4" style="margin-top:10px"></div>
      <div class="grid g4" style="margin-top:10px">${field({ id: 'date', label: 'Date', type: 'date', value: today })}${field({ id: 'operator', label: 'Operator', type: 'text', value: settings.operator })}${field({ id: 'fileRef', label: 'File / ELN reference', type: 'text', advanced: true })}${field({ id: 'remarks', label: 'Remarks', type: 'text' })}</div>
      <div style="margin-top:10px"><button class="primary" id="saveManual">Save result</button></div><div id="manualCheck"></div></div></div></div>`;
}

// ---- the results list ----
// Filtered by experiment, test, sample name and QC flag, and paged, newest first. Two hundred rows unfiltered
// was the longest thing on the screen and still could not find last month's result.

/**
 * The list's filters, from the address: ?rexp=E5&rtest=dls&rq=t14&rflag=1&rpage=2 ("-" for no experiment), and
 * whether the list was opened (rlist=1) or closed (rlist=0) by hand.
 */
function readFilters(p) {
  return { exp: p.rexp || '', test: p.rtest || '', q: p.rq || '', flag: p.rflag === '1', page: Math.max(1, parseInt(p.rpage, 10) || 1),
    open: p.rlist === '1' ? true : p.rlist === '0' ? false : null };
}

/**
 * The filters go into the address with replaceState, which redraws nothing: typing in the box filters the list
 * under the cursor without the screen being rebuilt around it. A reload or Back keeps them; the screen opened from
 * the sidebar, or after an import, starts unfiltered with the newest results on top, and with the list folded.
 */
function writeFilters(ctx, f) {
  Object.assign(ctx.params, { rexp: f.exp, rtest: f.test, rq: f.q, rflag: f.flag ? '1' : '', rpage: f.page > 1 ? String(f.page) : '',
    rlist: f.open == null ? '' : f.open ? '1' : '0' });
  const q = new URLSearchParams(Object.entries(ctx.params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  try { history.replaceState(history.state, '', `#/measurements${q ? '?' + q : ''}`); } catch { /* the list is filtered either way */ }
}

// "e5 f1 t14" finds E5-F1_4C_T14: every word typed has to be in the name, with case, dashes and underscores ignored.
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function filterResults(list, f) {
  const words = f.q.split(/\s+/).map(squash).filter(Boolean);
  return list.filter((m) => (!f.exp || (f.exp === '-' ? !m.experimentId : m.experimentId === f.exp))
    && (!f.test || m.test === f.test)
    && (!f.flag || (m.flags || []).length > 0)
    && (!words.length || words.every((w) => squash(m.sampleName).includes(w) || squash(m.batchId).includes(w))));
}

function resultsCard(measurements, experiments, f, filterBatch, added = measurements) {
  const names = new Map(experiments.map((e) => [e.id, e.name]));
  const list = filterBatch ? measurements.filter((m) => m.batchId === filterBatch) : measurements;
  // Newest experiment first, as the list is; results with no experiment at the end. A filter from the address
  // is offered even when nothing matches it any more, so the select never claims a filter that is not applied.
  const expIds = [...new Set([...list.map((m) => m.experimentId || '-'), ...(f.exp ? [f.exp] : [])])]
    .sort((a, b) => (a === '-') - (b === '-') || expNumber(b) - expNumber(a) || a.localeCompare(b));
  const tests = [...new Set([...list.map((m) => m.test).filter(Boolean), ...(f.test ? [f.test] : [])])].sort((a, b) => testRank(a) - testRank(b));
  const on = (v, cur) => (v === cur ? ' selected' : '');
  // Fifty rows of results were most of the words on this screen two weeks into a study (usability cycle 5, m1),
  // so the list is one line until it is opened. It opens by itself when the address asks for some of the results
  // (a formulation's "Measure" link, or a filter carried through a reload or Back, which could only have been set
  // with the list open), and a link whose purpose is the list ("show all", the overview's "All results") asks
  // for it open with rlist=1. Opened or closed by hand, it stays so through the redraws a save causes, as the
  // filters do, a formulation's results included.
  const filtered = !!(f.exp || f.test || f.q || f.flag || f.page > 1);
  const open = f.open ?? (!!filterBatch || filtered);
  // The line names the result added last, so a save or an import is seen to have landed without opening the list.
  const flagged = list.filter((m) => (m.flags || []).length).length;
  let last = null;
  for (let i = added.length - 1; i >= 0 && !last; i--) if (!filterBatch || added[i].batchId === filterBatch) last = added[i];
  const say = !last ? 'none stored yet'
    : `${plural(list.length, 'result')} stored, ${flagged ? `${flagged} flagged by a QC check` : 'none flagged by a QC check'}; the last added: ${last.sampleName || last.batchId || '–'}, ${summarize(last).trim() || TEST_LABEL[last.test] || last.test}`;
  return `<details class="card fold" id="resultsList" data-fold="list"${open ? ' open' : ''}>
    <summary><h2>Results${filterBatch ? ` · ${esc(filterBatch)}` : ''}</h2>${filterBatch ? '<a href="#/measurements?rlist=1">show all</a>' : ''}<span class="fold-say" id="resultsSay">${esc(say)}</span></summary>
    <div class="resBar">
      <select id="resExp" aria-label="Experiment"><option value="">Every experiment</option>${expIds.map((id) => `<option value="${esc(id)}"${on(id, f.exp)}>${id === '-' ? 'No experiment' : esc(`${id} · ${names.get(id) ?? 'deleted'}`)}</option>`).join('')}</select>
      <select id="resTest" aria-label="Test"><option value="">Every test</option>${tests.map((t) => `<option value="${esc(t)}"${on(t, f.test)}>${esc(TEST_LABEL[t] || t)}</option>`).join('')}</select>
      <input type="search" id="resQ" value="${esc(f.q)}" placeholder="Sample name" aria-label="Sample name contains" autocomplete="off" spellcheck="false">
      <label class="inline"><input type="checkbox" id="resFlag" style="width:auto"${f.flag ? ' checked' : ''}> flagged only</label></div>
    <div id="resBody">${resultsBody(list, f)}</div></details>`;
}

/** One page of the filtered list, and where it is in the whole. Puts the page it shows back into f. */
function resultsBody(list, f) {
  const rows = filterResults(list, f);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  f.page = Math.min(Math.max(1, f.page), pages);
  const from = (f.page - 1) * PAGE, shown = rows.slice(from, from + PAGE);
  const filtered = !!(f.exp || f.test || f.q || f.flag);
  const count = rows.length > PAGE || filtered ? `<span class="muted">${rows.length ? `${from + 1}–${from + shown.length} of ${rows.length}` : 'None'}${filtered ? ` (${list.length} in all)` : ''}</span>` : '';
  const nav = pages > 1 ? `<button type="button" id="resPrev"${f.page <= 1 ? ' disabled' : ''}>‹ Newer</button><button type="button" id="resNext"${f.page >= pages ? ' disabled' : ''}>Older ›</button>` : '';
  // The date once per day, as in a lab book: a page is mostly one or two days, and "27 Oct 2026" fifty times
  // over was the most repeated thing on the screen. The sample name is the link to the result; a separate
  // "Open" beside it went to the same place.
  return table(['Date', 'Sample / batch', 'Stage', 'Test', 'Result', 'QC'], shown.map((m, i) => ({ cells: [i && shown[i - 1].date === m.date ? '' : fmtDate(m.date), raw(`<a href="#/measurements?id=${m.id}">${esc(m.sampleName || m.batchId || '–')}</a>`), m.stage || '', m.test, raw(`${esc(summarize(m))}${m.history?.length ? ` ${chip('corrected')}` : ''}`), raw((m.flags || []).map((x) => chip(x.text, x.level === 'warn' ? 'warn' : 'info')).join(' ') || chip('ok', 'ok'))] })), { empty: filtered ? 'No result matches these filters.' : 'No results yet.' })
    + (count || nav ? `<div class="resPager">${count}${nav}</div>` : '');
}

function wireResults(el, ctx, measurements, f, filterBatch) {
  const card = el.querySelector('#resultsList');
  const list = filterBatch ? measurements.filter((m) => m.batchId === filterBatch) : measurements;
  const set = (patch) => { Object.assign(f, patch); card.querySelector('#resBody').innerHTML = resultsBody(list, f); writeFilters(ctx, f); };
  // The click runs before the details toggles, so the state it is about to take is the opposite of now; the
  // "show all" link in the line handles its own click.
  card.querySelector('summary').addEventListener('click', (e) => { if (!e.target.closest('a')) { f.open = !card.open; writeFilters(ctx, f); } });
  card.querySelector('#resExp').addEventListener('change', (e) => set({ exp: e.target.value, page: 1 }));
  card.querySelector('#resTest').addEventListener('change', (e) => set({ test: e.target.value, page: 1 }));
  card.querySelector('#resQ').addEventListener('input', (e) => set({ q: e.target.value, page: 1 }));
  card.querySelector('#resFlag').addEventListener('change', (e) => set({ flag: e.target.checked, page: 1 }));
  card.addEventListener('click', (e) => {
    const b = e.target.closest('#resPrev, #resNext');
    if (!b || b.disabled) return;
    set({ page: f.page + (b.id === 'resNext' ? 1 : -1) });
    // The buttons are under the table, so the next page would otherwise open at its oldest row.
    card.scrollIntoView({ block: 'start' });
  });
}
