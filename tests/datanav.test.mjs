// The audit's second round on the data overview (spec 5.1, 5.3), the leave guard and the trail (spec 9.1).
import test from 'node:test';
import assert from 'node:assert/strict';

// The Claude report card reads the developer switch for the personal build from localStorage.
globalThis.localStorage = { getItem: (k) => (k === 'lnp-lab.build.personal' ? '1' : null), setItem() {}, removeItem() {} };

const { dataRows, facetDefs, applyFilter, readFilter, writeFilter, describeFilter, columnDefs, toCsv, overlayDistributions, idsHref, chosenLabel } = await import('../app/calc/facets.js');
const { SOURCES, fromInstrumentFile } = await import('../app/calc/provenance.js');
const { registerDirty, unsavedWork, fieldsChanged, leaveQuestion } = await import('../app/ui/kit.js');
const { crumbsFor, designOf, stayStep } = await import('../app/ui/crumbs.js');
const { claudeReportCard } = await import('../app/ui/claudereport.js');

const lipidByKey = { ALC315: { name: 'ALC-0315', class: 'ionizable' }, MC3: { name: 'DLin-MC3-DMA', class: 'ionizable' }, DSPC: { name: 'DSPC', class: 'helper' } };
const compositionById = { 1: { id: 1, mol_pct: { MC3: 50, DSPC: 50 } }, 2: { id: 2, mol_pct: { ALC315: 50, DSPC: 50 } } };
const ref = { lipidByKey, compositionById };
const b = (id, comp, date, prov) => ({ id, experimentId: id.split('-')[0], compositionId: comp, plannedDate: date, plan: { conditions: { loadingPH: 4 } }, provenance: prov });
const src = {
  experiments: [{ id: 'E1' }, { id: 'E2' }],
  batches: [
    b('E1-F1', 1, '2026-01-10'),
    b('E1-F2', 2, '2026-01-12'),
    b('E2-F1', 2, '2026-03-02', { source: 'restore', importId: 'imp-7', file: { name: 'old.xlsx', sha256: 'ab'.repeat(32) }, sheet: 'Formulations', row: 14 }),
    b('E2-F2', 2, '2026-03-03', { source: 'mcp-import', importId: 'imp-8' }),
  ],
  measurements: [
    // typed in by hand
    { batchId: 'E1-F1', test: 'dls', values: { zave_nm: 80, pdi: 0.1 } },
    // read from the Zetasizer's export: the hash in raw (as the importer writes it), or a provenance saying so
    { batchId: 'E1-F2', test: 'dls', values: { zave_nm: 95, pdi: 0.2 }, raw: { fileName: 'zeta.csv', sha256: 'cd'.repeat(32) } },
    { batchId: 'E2-F1', test: 'ee', values: { ee_pct: 90 }, provenance: { source: 'instrument-import', file: { name: 'ribogreen.csv', sha256: 'ef'.repeat(32) } } },
  ],
};
const rows = dataRows(src, ref);
const defs = facetDefs(ref);

test('the Source facet counts a formulation as "Instrument file" when one of its results came from a file', () => {
  assert.ok(fromInstrumentFile(src.measurements[1]) && fromInstrumentFile(src.measurements[2]) && !fromInstrumentFile(src.measurements[0]));
  const { counts } = applyFilter(rows, {}, defs);
  assert.equal(counts.source.get('instrument-import'), 2, 'E1-F2 (raw.sha256) and E2-F1 (provenance)');
  assert.equal(counts.source.get('manual'), 2);
  assert.equal(counts.source.get('restore'), 1, 'the table import keeps its own source too');
  assert.deepEqual(applyFilter(rows, { source: ['instrument-import'] }, defs).rows.map((r) => r.id), ['E1-F2', 'E2-F1']);
  // One wording everywhere: the facet labels are provenance.js's, and a table import is not "a backup restored".
  const label = defs.find((d) => d.key === 'source').label1;
  for (const k of Object.keys(SOURCES)) assert.equal(label(k), SOURCES[k]);
  assert.equal(SOURCES.restore, 'Imported from tables');
  assert.equal(SOURCES['mcp-import'], 'Imported with Claude');
});

test('CSV and XLSX carry the whole provenance: source, file, SHA-256, sheet, row, import, and the result files', () => {
  const cols = columnDefs(ref);
  for (const k of ['source', 'importId', 'file', 'sha256', 'sheet', 'sourceRow', 'resultFiles', 'resultSha256']) assert.ok(cols.some((c) => c.key === k), k);
  const csv = toCsv(rows, cols).split('\n');
  const head = csv[0].split(',');
  const unq = (s) => (s?.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s); // a cell with a semicolon is quoted
  const line = (id) => { const cells = csv.find((l) => l.startsWith(id + ',')).split(','); return Object.fromEntries(head.map((h, i) => [h, unq(cells[i])])); };
  const t = line('E2-F1');
  assert.equal(t.Source, 'Imported from tables; Instrument file');
  assert.equal(t.Import, 'imp-7');
  assert.equal(t['Source file'], 'old.xlsx');
  assert.equal(t['SHA-256'], 'ab'.repeat(32));
  assert.equal(t.Sheet, 'Formulations');
  assert.equal(t.Row, '14');
  assert.equal(t['Result files'], 'ribogreen.csv');
  assert.equal(line('E1-F2')['Result files SHA-256'], 'cd'.repeat(32));
  assert.equal(line('E1-F1').Source, 'Typed in');
});

test('an ids filter: a set of formulations linked in from another screen, in the URL and in words', () => {
  const f = readFilter({ ids: 'E1-F2,E2-F2, E9-F9' }, defs);
  assert.deepEqual(f.ids, ['E1-F2', 'E2-F2', 'E9-F9']);
  assert.deepEqual(readFilter(writeFilter(f, defs), defs), f);
  assert.deepEqual(applyFilter(rows, f, defs).rows.map((r) => r.id), ['E1-F2', 'E2-F2']);
  assert.deepEqual(applyFilter(rows, { ...f, ionizable: ['ALC315'] }, defs).rows.map((r) => r.id), ['E1-F2', 'E2-F2'], 'combined with the facets');
  assert.equal(describeFilter(f, defs, 2), '3 chosen formulations, 2 formulations');
  assert.equal(chosenLabel(1), '1 chosen formulation');
  const href = idsHref(['E1-F2', 'E2-F2', 'E1-F2']);
  assert.equal(href, '#/data?ids=E1-F2%2CE2-F2');
  assert.deepEqual(readFilter(Object.fromEntries(new URLSearchParams(href.split('?')[1])), defs).ids, ['E1-F2', 'E2-F2']);
});

test('two views compared: runs per lipid, size, PDI and runs per month on shared axes, as shares of each view', () => {
  const a = rows.filter((r) => r.experimentId === 'E1'), c = rows.filter((r) => r.experimentId === 'E2');
  const o = overlayDistributions(a, c, { bins: 3 });
  assert.deepEqual(o.lipid.map((x) => [x.key, x.a, x.b]), [['ALC315', 1, 2], ['MC3', 1, 0]]);
  assert.equal(o.lipid[0].shareA, 0.5); assert.equal(o.lipid[0].shareB, 1);
  assert.equal(o.size.length, 3, 'one axis for both');
  assert.equal(o.size.reduce((s, x) => s + x.a, 0), 2);
  assert.equal(o.size.reduce((s, x) => s + x.b, 0), 0, 'a view without sizes counts none');
  assert.deepEqual(o.month.map((x) => [x.key, x.a, x.b]), [['2026-01', 2, 0], ['2026-02', 0, 0], ['2026-03', 0, 2]]);
  assert.deepEqual(overlayDistributions([], []).size, []);
});

test('the leave guard: a check per form, dropped with its form; fields compared with what was drawn', () => {
  const owner = { isConnected: true };
  let dirty = true;
  const off = registerDirty(owner, 'results typed into the grid', () => dirty);
  registerDirty(owner, 'results typed into the grid', () => true); // the same form twice is named once
  registerDirty({ isConnected: true }, 'a check that throws', () => { throw new Error('x'); });
  assert.deepEqual(unsavedWork(), ['results typed into the grid']);
  assert.match(leaveQuestion(unsavedWork()), /^Not saved yet: results typed into the grid\. Leave this screen anyway\?$/);
  dirty = false; off();
  owner.isConnected = false; // the screen was drawn again
  assert.deepEqual(unsavedWork(), []);
  const field = (o) => ({ disabled: false, readOnly: false, type: 'text', ...o });
  const root = (fs) => ({ querySelectorAll: () => fs });
  assert.equal(fieldsChanged(root([field({ value: '82', defaultValue: '82' })])), false);
  assert.equal(fieldsChanged(root([field({ value: '83', defaultValue: '82' })])), true);
  assert.equal(fieldsChanged(root([field({ value: '83', defaultValue: '82', readOnly: true })])), false, 'a box the app fills is not typing');
  assert.equal(fieldsChanged(root([field({ type: 'checkbox', checked: true, defaultChecked: false })])), true);
  const opts = (sel, def) => [0, 1, 2].map((i) => ({ selected: i === sel, defaultSelected: i === def }));
  assert.equal(fieldsChanged(root([field({ type: 'select-one', options: opts(0, -1), selectedIndex: 0 })])), false, 'no option marked: the first is what was drawn');
  assert.equal(fieldsChanged(root([field({ type: 'select-one', options: opts(2, 1), selectedIndex: 2 })])), true);
  assert.equal(fieldsChanged(null), false);
});

test('staying puts the address back the way it came: Forward after Back, Back after a link', () => {
  assert.equal(stayStep({ lnpDepth: 2 }, 3), 'forward', 'reached with Back');
  assert.equal(stayStep(null, 3), 'back', 'a new entry: a link, the sidebar, navigate()');
  assert.equal(stayStep({ lnpDepth: 4 }, 3), 'back', 'reached with Forward');
});

test('the wizard opened from the design catalogue reads "Plan › Design catalogue › <design>"', () => {
  const SCREENS = [{ group: 'Plan' }, { id: 'advisor', title: 'Plan an experiment' }, { id: 'designs', title: 'Design catalogue' }, { group: 'Run' }, { id: 'experiments', title: 'Experiments' }];
  const t = crumbsFor('experiments', { new: '1', type: 'doe', design: 'bbd', model: 'quadratic', center: '3', factors: 'frr,tfr,np' }, SCREENS);
  assert.deepEqual(t.map((c) => c.label), ['Plan', 'Design catalogue', 'Box-Behnken']);
  assert.equal(t[1].href, '#/designs');
  assert.equal(t[2].href, '#/experiments?new=1&type=doe&design=bbd&model=quadratic&center=3&factors=frr%2Ctfr%2Cnp');
  assert.equal(designOf({ design: 'full_factorial' }), '2-level full factorial', 'not the three-level one, whose id starts the same');
  assert.equal(designOf({ type: 'doe', mode: 'mixture' }), 'Lipid blend (mixture design)');
  assert.equal(designOf({ type: 'single' }), null);
  assert.deepEqual(crumbsFor('experiments', { new: '1', type: 'single' }, SCREENS).map((c) => c.label), ['Run', 'Experiments', 'New'], 'without a design, as before');
});

test("a finding of Claude's report opens its formulations in Data, together", () => {
  const report = { id: 'r1', createdAt: '2026-10-01T10:00:00.000Z', dataState: { formulations: 4 }, findings: [{ text: 'Higher FRR, smaller particles', analysis: 'correlation', formulationIds: ['E1-F1', 'E1-F2', 'E1-F1'] }] };
  const store = { get: (col, id) => (col === 'settings' && id === 'default' ? { id: 'default', personalBuild: true } : null), all: (col) => (col === 'insightReports' ? [report] : col === 'batches' ? src.batches : []) };
  const html = claudeReportCard({ store });
  assert.match(html, /<a class="reportIds" data-report-link href="#\/data\?ids=E1-F1%2CE1-F2"[^>]*>E1-F1, E1-F2<\/a>/);
  assert.doesNotMatch(html, /#\/formulation\?batch=/);
});
