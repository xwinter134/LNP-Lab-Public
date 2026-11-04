// The biological layers (spec 8): normalisation to the reference, statistics with effect sizes, organs,
// tropism, the cross-study hook for the optimizer, imports into measurements, and the agreement measures of
// the BLI test bench. All pure functions of app/calc/bio.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYERS, layerById, DEFAULT_BIO, activeLayers, anyLayerOn, animalPlanEnabled, catalog, catalogRecord, CATALOGS,
  studyId, nextStudyId, newStudy, nextGroupId, studyWarnings, seriesKey, seriesLabel, normaliseStudy, compareToReference,
  effectText, organRatios, tropismShares, normalisedByFormulation, seriesCatalogue, physchemScatter, plannedSubjects,
  suggestAnimals, measurementId, plateToMeasurements, bliToMeasurements, agreement,
} from '../app/calc/bio.js';
import { holm, welchTest } from '../app/calc/stats.js';
import { getSettings, DEFAULT_SETTINGS } from '../app/refdata.js';
import { dataRows } from '../app/calc/facets.js';
import { parsePlate, wellId } from '../app/calc/parsers.js';
import { ANIMAL_STUDY, ANIMAL_WELFARE_NOTICE, animalStudyDraft, CATALOG } from '../app/calc/designs.js';

const study = (over = {}) => ({
  id: 'Study-001', type: 'in vivo', layers: ['invivo', 'biodist'], subtractBackground: true,
  groups: [{ id: 'G1', name: 'Reference', role: 'reference', batchId: 'E1-F1', n: 4 }, { id: 'G2', name: 'Candidate', role: 'test', batchId: 'E2-F3', n: 4 }, { id: 'G3', name: 'PBS', role: 'negative', batchId: null, n: 2 }],
  ...over,
});
const m = (group, subject, value, over = {}) => ({ studyId: 'Study-001', group, subject, value, layer: 'invivo', quantity: 'total_flux', unit: 'p/s', organ: '', population: '', timepoint_h: 6, ...over });

test('every layer is off by default, and with none on nothing of this shows', () => {
  assert.deepEqual(DEFAULT_SETTINGS.bio, DEFAULT_BIO);
  const s = getSettings({ store: { get: () => null } });
  assert.deepEqual(activeLayers(s), []);
  assert.equal(anyLayerOn(s), false);
  assert.equal(animalPlanEnabled(s), false, 'in-vivo planning stays locked');
  const on = getSettings({ store: { get: () => ({ id: 'default', bio: { biodist: true } }) } });
  assert.deepEqual(activeLayers(on).map((l) => l.id), ['biodist']);
  assert.equal(on.bio.invitro, false, 'a stored partial setting keeps the other layers off');
  assert.deepEqual(LAYERS.map((l) => l.no), [1, 2, 3, 4]);
});

test('catalogues: the shipped entries first, the lab\'s own after, each once', () => {
  const own = [catalogRecord('cellLine', ' Huh7 '), catalogRecord('cellLine', 'BJ fibroblasts'), catalogRecord('organ', 'brain')];
  const lines = catalog('cellLine', own);
  assert.equal(lines[0], CATALOGS.cellLine.items[0]);
  assert.equal(lines.filter((x) => x === 'Huh7').length, 1);
  assert.equal(lines[lines.length - 1], 'BJ fibroblasts');
  assert.ok(catalog('organ', own).includes('brain'));
  assert.equal(catalog('organ')[0], 'liver');
});

test('study numbers are never given out twice, the trash counted', () => {
  assert.equal(studyId(7), 'Study-007');
  assert.equal(nextStudyId([{ id: 'Study-002' }], [{ records: [{ col: 'studies', rec: { id: 'Study-009' } }] }]), 'Study-010');
  const s = newStudy({ id: 'Study-001', type: 'in vitro' });
  assert.deepEqual(s.groups.map((g) => g.role), ['reference', 'test']);
  assert.deepEqual(s.context.biodist.organs, ['liver'], 'liver on by default');
  assert.equal(nextGroupId(s), 'G3');
});

test('a study without a reference is warned about, never refused', () => {
  const w = studyWarnings({ ...study(), groups: [{ id: 'G2', role: 'test' }], licence: '' }, ['invivo']);
  assert.ok(w.some((x) => /No reference group/.test(x)));
  assert.ok(w.some((x) => /no negative control/.test(x)));
  assert.ok(w.some((x) => /licence/.test(x)));
  assert.ok(w.some((x) => /Biodistribution layer is switched off/.test(x)));
  assert.deepEqual(studyWarnings({ ...study(), licence: 'G-21/123' }, ['invivo', 'biodist']), []);
});

test('normalisation: background subtracted first, then log10 of the value over the reference mean', () => {
  const ms = [m('G3', 'P1', 100), m('G3', 'P2', 300), m('G1', 'A1', 1200), m('G1', 'A2', 2200), m('G2', 'B1', 20200), m('G2', 'B2', 100)];
  const n = normaliseStudy(study(), ms);
  assert.equal(n.series.length, 1);
  const s = n.series[0];
  assert.deepEqual(s.background, { mean: 200, n: 2, subtracted: true });
  assert.equal(s.reference.mean, 1500); // (1000 + 2000) / 2
  const b1 = s.rows.find((r) => r.subject === 'B1');
  assert.ok(Math.abs(b1.log10 - Math.log10(20000 / 1500)) < 1e-12);
  assert.ok(Math.abs(b1.fold - 20000 / 1500) < 1e-9);
  const b2 = s.rows.find((r) => r.subject === 'B2');
  assert.equal(b2.log10, null); assert.equal(b2.flag, 'at or below background');
  assert.equal(b2.raw, 100, 'the raw value is kept');
  // without subtraction the same values normalise to the raw reference mean
  const raw = normaliseStudy(study({ subtractBackground: false }), ms).series[0];
  assert.equal(raw.reference.mean, 1700);
  // no reference group: nothing normalised, and said
  const none = normaliseStudy(study({ groups: [{ id: 'G2', role: 'test' }] }), [m('G2', 'B1', 5)]);
  assert.equal(none.series[0].rows[0].log10, null);
  assert.match(none.warnings[0], /no reference values/);
});

test('series are kept apart by read-out, organ, population, timepoint and view', () => {
  assert.notEqual(seriesKey(m('G1', 'a', 1)), seriesKey(m('G1', 'a', 1, { timepoint_h: 24 })));
  assert.notEqual(seriesKey(m('G1', 'a', 1, { view: 'dorsal' })), seriesKey(m('G1', 'a', 1, { view: 'ventral' })));
  assert.equal(seriesLabel({ layer: 'biodist', quantity: 'organ_flux', organ: 'liver', timepoint_h: 6 }), 'Organ signal (flux) · liver · 6 h');
});

test('each group against the reference: Welch on log10 values, Holm-adjusted, fold with its 95 % CI', () => {
  const ref = [1000, 1300, 800, 1100], a = [9000, 12000, 7000, 10000], b = [1100, 900, 1250, 1000];
  const st = study({ groups: [...study().groups.slice(0, 2), { id: 'G4', name: 'Other', role: 'test', batchId: 'E2-F4', n: 4 }], subtractBackground: false });
  const ms = [...ref.map((v, i) => m('G1', `r${i}`, v)), ...a.map((v, i) => m('G2', `a${i}`, v)), ...b.map((v, i) => m('G4', `b${i}`, v))];
  const s = normaliseStudy(st, ms).series[0];
  const cmp = compareToReference(s);
  const ca = cmp.find((c) => c.group === 'G2'), cb = cmp.find((c) => c.group === 'G4');
  const w = welchTest(a.map(Math.log10), ref.map(Math.log10));
  assert.ok(Math.abs(ca.p - w.p) < 1e-12);
  assert.deepEqual([ca.pAdj, cb.pAdj], holm([ca.p, cb.p]));
  assert.ok(Math.abs(ca.fold - 10 ** w.diff) < 1e-9);
  assert.ok(ca.ci[0] > 1 && ca.ci[1] > ca.fold && ca.ci[0] < ca.fold, 'the CI brackets the fold and clears 1');
  assert.ok(ca.star.length >= 1);
  assert.equal(ca.n, 4); assert.equal(ca.nRef, 4);
  assert.equal(cb.star, '', 'no star where the CI reaches 1-fold');
  assert.match(ca.text, /^Candidate: \d+(\.\d+)?-fold over reference \(95 % CI [\d.]+–[\d.]+\), n = 4 vs 4, p \(Holm\) [=<] /);
  // too few for a test: the fold is still shown, with the reason there is no p
  const one = compareToReference(normaliseStudy(st, [...ms.filter((x) => x.group !== 'G4'), m('G4', 'b0', 1000)]).series[0]).find((c) => c.group === 'G4');
  assert.equal(one.p, null); assert.match(one.note, /too few/); assert.equal(one.star, '');
  assert.match(effectText(one), /n = 1 vs 4; too few/);
});

test('Holm\'s adjustment: step-down, monotone, nulls left alone', () => {
  assert.deepEqual(holm([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06]);
  assert.deepEqual(holm([null, 0.02]), [null, 0.02]);
});

test('organ ratios per animal, as a geometric mean; tropism as stacked shares', () => {
  const st = study({ subtractBackground: false });
  const ms = [
    m('G1', 'A1', 1000, { layer: 'biodist', quantity: 'organ_flux', organ: 'liver' }), m('G1', 'A1', 100, { layer: 'biodist', quantity: 'organ_flux', organ: 'spleen' }),
    m('G1', 'A2', 4000, { layer: 'biodist', quantity: 'organ_flux', organ: 'liver' }), m('G1', 'A2', 100, { layer: 'biodist', quantity: 'organ_flux', organ: 'spleen' }),
  ];
  const r = organRatios(normaliseStudy(st, ms), { num: 'liver', den: 'spleen' });
  assert.equal(r.length, 1); assert.equal(r[0].n, 2);
  assert.ok(Math.abs(r[0].ratio - 20) < 1e-9, 'the geometric mean of 10 and 40');
  const t = [
    m('G2', 'B1', 30, { layer: 'tropism', quantity: 'positive_pct', organ: 'liver', population: 'hepatocytes' }),
    m('G2', 'B1', 10, { layer: 'tropism', quantity: 'positive_pct', organ: 'liver', population: 'Kupffer cells' }),
  ];
  const sh = tropismShares(normaliseStudy(st, t));
  assert.deepEqual(sh[0].parts.map((p) => p.share), [0.75, 0.25]);
});

test('the optimizer hook: per formulation, the normalised values by series and study (spec 7.9)', () => {
  const s1 = study({ subtractBackground: false });
  const s2 = { ...study({ subtractBackground: false }), id: 'Study-002', groups: [{ id: 'G1', role: 'reference', batchId: 'E1-F1' }, { id: 'G2', role: 'test', batchId: 'E2-F3' }] };
  const ms = [
    m('G1', 'a', 100), m('G1', 'b', 100), m('G2', 'c', 1000), m('G2', 'd', 1000), m('G3', 'p', 1),
    { ...m('G1', 'a', 50), studyId: 'Study-002' }, { ...m('G2', 'c', 50), studyId: 'Study-002' },
  ];
  const by = normalisedByFormulation([s1, s2], ms);
  const key = seriesKey(ms[0]);
  const e = by.get('E2-F3')[key];
  assert.equal(e.n, 3);
  assert.ok(Math.abs(e.mean - 2 / 3) < 1e-12, '10-fold twice and 1-fold once, on the log scale');
  assert.deepEqual(Object.keys(e.studies), ['Study-001', 'Study-002']);
  assert.ok(Math.abs(by.get('E1-F1')[key].mean) < 1e-12, 'the reference sits at 1-fold');
  assert.ok(!by.has(null) && ![...by.keys()].includes(undefined), 'a negative control is no formulation');
  assert.equal(seriesCatalogue(by)[0].key, key);
  // against physicochemistry across studies
  const rows = [{ id: 'E2-F3', size: 80 }, { id: 'E1-F1', size: 95 }, { id: 'E9-F1', size: 70 }];
  const sc = physchemScatter(rows, by, { x: 'size', key });
  assert.equal(sc.n, 2);
  assert.ok(sc.points.find((p) => p.x === 80).fold > 4);
});

test('the data overview marks formulations with biological data', () => {
  const rows = dataRows({ batches: [{ id: 'E1-F1' }, { id: 'E2-F3' }, { id: 'E3-F1' }], studies: [study()], bioMeasurements: [m('G2', 'x', 5), { ...m('G1', 'y', 5), batchId: 'E1-F1' }] });
  assert.deepEqual(rows.map((r) => r.has.bio), [true, true, false]);
});

test('animals suggested for the mice of an image: the comment\'s ids first, else the plan in order', () => {
  const st = study();
  assert.equal(plannedSubjects(st).length, 10);
  const fromPlan = suggestAnimals(st, 3, { taken: new Set(['G1-1']) });
  assert.deepEqual(fromPlan.map((s) => s.subject), ['G1-2', 'G1-3', 'G1-4']);
  const fromComment = suggestAnimals(st, 2, { ids: ['579G', '580G'], known: new Map([['580G', 'G2']]) });
  assert.deepEqual(fromComment, [{ subject: '579G', group: '', from: 'comment' }, { subject: '580G', group: 'G2', from: 'comment' }]);
});

test('a plate and its layout become measurements; unknown names are listed back, empty wells skipped', () => {
  const values = { A1: { value: 10 }, A2: { value: 20 }, A3: { value: 30 }, B1: { value: 5 }, B2: { value: null } };
  const layout = { A1: 'Reference', A2: 'reference', A3: 'E2-F3', B1: 'Mystery', B2: 'G2', C1: 'empty' };
  const st = study({ type: 'in vitro' });
  const r = plateToMeasurements({ values, layout, study: st, series: { layer: 'invitro', quantity: 'luciferase', unit: 'RLU', timepoint_h: 24 } });
  assert.deepEqual(r.measurements.map((x) => [x.subject, x.group, x.value]), [['A1', 'G1', 10], ['A2', 'G1', 20], ['A3', 'G2', 30]]);
  assert.deepEqual(r.unmatched, ['Mystery']);
  assert.equal(r.skipped, 1);
  assert.equal(r.measurements[0].id, measurementId('Study-001', r.measurements[0]), 'the same well imported again replaces its value');
  assert.equal(r.measurements[2].batchId, 'E2-F3');
});

test('an analysed image becomes two values per assigned mouse, naming the file, the mouse and the algorithm', () => {
  const image = { id: 'bli:Study-001:X', folder: 'Day 8/X', files: [{ name: 'luminescent.TIF', sha256: 'ab12' }], view: 'ventral', timepoint_h: 6, algorithm: { name: 'lnp-lab-bli', version: '1.0.0', method: 'noise+morph+margin' },
    mice: [{ n: 1, totalFlux: 1e6, liver: { flux: 2e5 }, subject: 'A1', group: 'G1' }, { n: 2, totalFlux: 3e6, totalFluxManual: 2.5e6, liver: { flux: 1e5 }, subject: 'B1', group: 'G2' }, { n: 3, totalFlux: 1, liver: { flux: 1 }, excluded: true, subject: 'x', group: 'G2' }] };
  const out = bliToMeasurements({ study: study(), image });
  assert.equal(out.length, 4);
  const total = out.filter((x) => x.quantity === 'total_flux');
  assert.deepEqual(total.map((x) => x.value), [1e6, 2.5e6], 'a hand-corrected flux is the one stored');
  assert.deepEqual(total[0].file, { path: 'Day 8/X/luminescent.TIF', sha256: 'ab12' });
  assert.equal(total[1].batchId, 'E2-F3');
  assert.equal(out.find((x) => x.quantity === 'invivo_roi_flux').organ, 'liver');
  assert.equal(total[0].view, 'ventral');
  assert.equal(total[0].algorithm.version, '1.0.0');
});

test('agreement on the log scale: r, Bland–Altman bias and limits, median % difference, share within 20 %', () => {
  const manual = [100, 1000, 10000, 100000];
  const a = agreement(manual.map((x) => x * 1.1), manual);
  assert.ok(Math.abs(a.r - 1) < 1e-12);
  assert.ok(Math.abs(a.biasFold - 1.1) < 1e-9);
  assert.ok(Math.abs(a.medianAbsPct - 10) < 1e-9);
  assert.equal(a.within20, 1);
  const b = agreement([100, 2000, -5], [100, 1000, 10]);
  assert.equal(b.n, 2, 'a non-positive value has no logarithm and is left out');
  assert.equal(b.within20, 0.5);
});

test('plate reader exports: a grid with two reads, decimal commas, a long table, a layout of names', () => {
  const grid = 'Reader X, plate 1\nLuminescence\n;1;2;3;4;5;6;7;8;9;10;11;12\nA;1520,5;1610;1700;;;;;;;;;\nB;12;14;13;;;;;;;;;\n\nRead 2: 560 nm\n;1;2;3;4;5;6;7;8;9;10;11;12\nA;0,5;0,6;0,7;;;;;;;;;\n';
  const g = parsePlate(grid);
  assert.equal(g.layout, 'grid');
  assert.equal(g.blocks.length, 2);
  assert.equal(g.blocks[0].label, 'Luminescence');
  assert.equal(g.blocks[0].wells.A1.value, 1520.5);
  assert.equal(g.blocks[1].wells.A2.value, 0.6);
  const long = parsePlate('Well,Sample,RLU\nA01,Reference,1000\nA02,G2,2500\nH12,,7\n');
  assert.equal(long.layout, 'long');
  assert.equal(long.blocks[0].wells.A2.value, 2500);
  assert.deepEqual(long.samples, { A1: 'Reference', A2: 'G2' });
  const layout = parsePlate('\t1\t2\t3\t4\t5\t6\t7\t8\t9\t10\t11\t12\nA\tReference\tReference\tE2-F3\nB\tPBS\n');
  assert.equal(layout.blocks[0].wells.A3.raw, 'E2-F3');
  assert.equal(layout.blocks[0].wells.B1.raw, 'PBS');
  assert.equal(parsePlate('nothing here').layout, null);
  assert.equal(wellId('h 07'), 'H7'); assert.equal(wellId('Z1'), null);
});

test('the animal study is in the catalogue as a locked module with a placeholder welfare notice', () => {
  assert.equal(ANIMAL_STUDY.locked, true);
  assert.ok(ANIMAL_STUDY.structure.some(([k]) => k === 'Reference group'));
  assert.equal(ANIMAL_WELFARE_NOTICE.placeholder, true);
  assert.deepEqual(ANIMAL_WELFARE_NOTICE.points.map(([k]) => k), ['3R principle', 'Licence obligation', 'Responsibility', 'No planning without review']);
  assert.ok(!CATALOG.some((e) => e.id === 'animal_study'), 'it has no run count and no wizard');
  assert.equal(animalStudyDraft().groups.length, 6, 'about five candidates and the reference');
  assert.ok(layerById.invivo.quantities.some((q) => q.key === 'total_flux'));
});
