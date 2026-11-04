// Biological data through the import (spec 8.3: "also fillable through the MCP import"): the studies and
// bioMeasurements tables of docs/HISTORICAL-DATA.md, checked by app/calc/importcheck.js into the records the
// Studies screen reads (app/calc/bio.js), written, deduplicated by file hash and row, quarantined, fixed and
// rolled back like every other table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseCsv, checkTidy, qualityReport, reportMarkdown, tidySchema } from '../app/calc/importcheck.js';
import { planImport, applyImport, rollbackImport, recheckQuarantine, openQuarantine, listImports, labQuality } from '../app/calc/importops.js';
import { normaliseStudy, compareToReference } from '../app/calc/bio.js';
import { Store } from '../app/store.js';

const EX = new URL('../docs/historical-example/', import.meta.url).pathname;
const table = (f) => { const t = readFileSync(EX + f, 'utf8'); return { name: f, sha256: createHash('sha256').update(t).digest('hex'), rows: parseCsv(t) }; };
const all = () => Object.fromEntries(['experiments', 'formulations', 'measurements', 'studies', 'bioMeasurements'].map((t) => [t, table(`${t}.csv`)]));
const data = () => ({ lipids: JSON.parse(readFileSync(new URL('../app/data/lipids.json', import.meta.url))), compositions: JSON.parse(readFileSync(new URL('../app/data/compositions.json', import.meta.url))) });
async function memStore() { const s = new Store('lnp-lab', { backend: { kind: 'memory', load: async () => ({}), write: async () => {}, clear: async () => {} } }); await s.ready(); return s; }

test('the example study: groups with their formulations, context per layer, raw values, two planted mistakes', () => {
  const ref = data();
  const r = checkTidy(all(), { ...ref, topExperiment: 199 }, { importId: 'imp-x', dedupe: true });
  assert.equal(r.studies.length, 1);
  const st = r.studies[0];
  assert.equal(st.id, 'Study-001');
  assert.equal(st.type, 'in vivo');
  assert.deepEqual(st.layers, ['invivo', 'biodist']);
  assert.deepEqual(st.groups.map((g) => [g.id, g.role, g.batchId]), [['G1', 'reference', 'E200-F2'], ['G2', 'test', 'E200-F1'], ['G3', 'negative', null]]);
  assert.equal(st.referenceBatchId, 'E200-F2');
  assert.deepEqual(st.experimentIds, ['E200']);
  assert.deepEqual(st.context.biodist.organs, ['liver', 'spleen']);
  assert.equal(st.context.invivo.route, 'i.v.');
  assert.equal(st.context.invivo.dose_mg_kg, 0.5);
  assert.equal(st.licence, 'EXAMPLE-0001');
  assert.equal(st.provenance.originKeys.length, 3, 'every accepted group row is remembered for dedup');
  assert.equal(r.bioMeasurements.length, 12);
  const m = r.bioMeasurements.find((x) => x.subject === 'M4' && x.layer === 'invivo');
  assert.equal(m.group, 'G2');
  assert.equal(m.batchId, 'E200-F1');
  assert.equal(m.value, 3.4e8);
  assert.equal(m.unit, 'p/s');
  assert.equal(m.provenance.row, 5);
  assert.match(r.quarantine.find((q) => q.table === 'studies').reason, /role "control" is not one of reference, test, negative/);
  assert.match(r.quarantine.find((q) => q.table === 'bioMeasurements').reason, /unit "RLU": total_flux is stored in p\/s/);
  // The values read the way the Studies screen reads them: normalised to the reference, the background subtracted.
  const norm = normaliseStudy(st, r.bioMeasurements);
  const flux = norm.series.find((x) => x.quantity === 'total_flux');
  assert.equal(flux.background.n, 2);
  const cmp = compareToReference(flux).find((c) => c.group === 'G2');
  assert.ok(cmp.fold > 2.5 && cmp.fold < 3.5, `fold ${cmp.fold}`);
  const rep = qualityReport(r);
  assert.deepEqual(rep.counts.studies, { read: 4, importable: 3, refused: 1, duplicates: 0 });
  assert.deepEqual(rep.counts.bioMeasurements, { read: 13, importable: 12, refused: 1, duplicates: 0 });
  assert.match(reportMarkdown(rep), /\| Study groups \| 4 \| 3 \| 1 \| 0 \|[\s\S]*New studies: Study-001/);
  assert.ok(!reportMarkdown(qualityReport(checkTidy({ formulations: table('formulations.csv') }, ref))).includes('Study groups'), 'no bio lines without bio tables');
});

test('the rules of a study row and a value', () => {
  const lab = { batchIds: new Set(['E5-F1']), studyIds: ['Study-004'] };
  const rows = (t, xs) => ({ name: `${t}.csv`, rows: xs.map((x, i) => ({ __row: i + 2, ...x })) });
  const r = checkTidy({
    studies: rows('studies', [
      { study_key: 'S', group: 'R', role: 'Reference', formulation_id: 'E5-F1', layers: 'In vitro', cellLine: 'Huh7', dose_ng: '100' },
      { study_key: 'S', group: 'X', role: 'test', formulation_id: 'E9-F9' },
      { study_key: 'S', group: 'Y', role: 'test', layers: 'invivo' },
      { study_key: 'S', group: 'R', role: 'test' },
      { study_key: 'S', group: 'Z', role: 'test', n: '2.5' },
    ]),
    bioMeasurements: rows('bioMeasurements', [
      { study_key: 'S', group: 'R', subject: 'A1', layer: 'invitro', quantity: 'luciferase', value: '1520' },
      { study_key: 'S', group: 'R', subject: 'A1', layer: 'invitro', quantity: 'luciferase', value: '1600' },
      { study_key: 'S', group: 'R', subject: 'A2', layer: 'invitro', quantity: 'flux', value: '1' },
      { study_key: 'S', group: 'Q', subject: 'A3', layer: 'invitro', quantity: 'luciferase', value: 'n.d.' },
      { study_key: 'T', group: 'R', subject: 'A4', layer: 'invitro', quantity: 'luciferase', value: '1' },
      { study_key: 'S', group: 'R', subject: 'A5', layer: 'biodist', quantity: 'organ_flux', value: '1' },
    ]),
  }, { lab });
  assert.equal(r.studies[0].id, 'Study-005', 'numbered past the lab');
  assert.equal(r.studies[0].type, 'in vitro');
  assert.deepEqual(r.studies[0].context.invitro, { cellLine: 'Huh7', dose_ng: 100 });
  const why = r.quarantine.map((q) => `${q.table} ${q.row}: ${q.reason}`);
  assert.ok(why.some((w) => /studies 3: formulation_id E9-F9 is not in the lab/.test(w)), why.join('\n'));
  assert.ok(why.some((w) => /studies 4: layers "invivo" differs from an earlier row of S \(invitro\)/.test(w)));
  assert.ok(why.some((w) => /studies 5: group R appears twice in S/.test(w)));
  assert.ok(why.some((w) => /studies 6: n "2\.5" is not a whole number/.test(w)));
  assert.ok(why.some((w) => /bioMeasurements 3: the same study, group read-out and subject A1 appear twice/.test(w)));
  assert.ok(why.some((w) => /bioMeasurements 4: quantity "flux" is not one of invitro's/.test(w)));
  assert.ok(why.some((w) => /bioMeasurements 5: group Q is not a group of S; value "n\.d\." is not a number/.test(w)));
  assert.ok(why.some((w) => /bioMeasurements 6: no study T/.test(w)));
  assert.ok(why.some((w) => /bioMeasurements 7: organ is empty: biodist values are per organ/.test(w)));
  assert.ok(r.warnings.some((w) => /No test group yet/.test(w.text)), 'the Studies screen\'s warnings, in the report');
  const s = tidySchema();
  assert.ok(s.studies.some((f) => f.key === 'role' && f.required && f.options.includes('negative')));
  assert.ok(s.bioMeasurements.some((f) => f.key === 'quantity' && f.options.includes('total_flux')));
});

test('written, listed, deduplicated by file hash and row, fixed from quarantine into its study, and rolled back whole', async () => {
  const s = await memStore();
  const ref = data();
  const { result } = planImport(s, ref, all(), { importId: 'imp-bio', importedAt: '2026-10-31T10:00:00Z' });
  const w = applyImport(s, result, { kind: 'historical', source: 'restore', files: [{ name: 'studies.csv' }] });
  assert.equal(w.ok, true, w.reason);
  assert.equal(w.written.studies, 1);
  assert.equal(w.written.bioMeasurements, 12);
  assert.equal(s.all('bioMeasurements').length, 12);
  assert.deepEqual(s.get('imports', 'imp-bio').studyIds, [result.studies[0].id]);
  assert.equal(labQuality(s, ref, 'imp-bio').counts.bioMeasurements, 12);
  // The same files again: every row a duplicate.
  const again = planImport(s, ref, all(), { importId: 'imp-bio2' });
  assert.equal(again.report.counts.studies.duplicates, 3);
  assert.equal(again.report.counts.bioMeasurements.duplicates, 12);
  assert.equal(again.result.studies.length, 0);
  // The refused group, fixed: it joins the study of its import; then the refused value finds its unit.
  const g = openQuarantine(s).find((q) => q.table === 'studies');
  const fixed = recheckQuarantine(s, ref, g.id, { ...g.mapping, role: 'test' });
  assert.equal(fixed.ok, true, fixed.reason);
  const st = s.get('studies', result.studies[0].id);
  assert.deepEqual(st.groups.map((x) => x.id), ['G1', 'G2', 'G3', 'G4']);
  assert.equal(st.groups[3].batchId, 'E2-F1', 'the acetate formulation of the same import');
  assert.equal(st.groups[3].provenance.fixedFrom, g.id);
  const v = openQuarantine(s).find((q) => q.table === 'bioMeasurements');
  const fv = recheckQuarantine(s, ref, v.id, { ...v.mapping, unit: 'p/s' });
  assert.equal(fv.ok, true, fv.reason);
  assert.equal(s.all('bioMeasurements').length, 13);
  assert.equal(s.get('bioMeasurements', fv.ids[0]).provenance.importId, 'imp-bio');
  // A value typed in later on the Studies screen goes with the study, and is counted.
  s.put('bioMeasurements', { id: 'bm:typed', studyId: st.id, group: 'G1', subject: 'M9', layer: 'invivo', quantity: 'total_flux', value: 1e8 });
  const rb = rollbackImport(s, 'imp-bio');
  assert.equal(rb.ok, true, rb.reason);
  assert.equal(rb.counts.studies, 1);
  assert.equal(rb.counts.bioMeasurements, 14);
  assert.equal(rb.others, 1);
  assert.equal(s.all('studies').length, 0);
  assert.equal(s.all('bioMeasurements').length, 0);
  assert.equal(listImports(s)[0].state.inLab, false);
  assert.equal(s.restoreFromTrash(rb.entry.id).ok, true);
  assert.equal(s.all('bioMeasurements').length, 14);
});
