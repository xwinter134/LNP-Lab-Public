// The biological layers (spec 8): what each layer records, the studies and measurements they live in, the
// normalisation to a reference that makes studies comparable, and the statistics and summaries the Studies
// screen draws. Pure: no DOM, no store; the screens pass records in.
//
// The data model (spec 8.3), two collections:
//   studies         {id: 'Study-001', name, type: 'in vitro'|'in vivo', layers: ['invitro', …], date, licence,
//                    context: {invitro: {…}, invivo: {…}, biodist: {organs: […]}, tropism: {…}},
//                    groups: [{id: 'G1', name, batchId|null, role: 'test'|'reference'|'negative', n}],
//                    referenceBatchId, subtractBackground, experimentIds: [], notes, provenance}
//   bioMeasurements {id, studyId, batchId, group, subject (animal or well id), layer, organ, population,
//                    quantity, value, unit, timepoint_h, view, file: {path, sha256}, imageId, mouse,
//                    algorithm, provenance}
// Raw values are always what is stored (8.2). Everything normalised is worked out here, on every read, so a
// changed reference or a corrected value never leaves a stale fold change behind.
//
// Why log10(value / reference mean): biological read-outs (luciferase, flux, MFI) span orders of magnitude and
// their spread grows with their size, so ratios and log values are what behave; the reference running in the
// same study takes out the day-to-day drift of cells, animals, substrate and instrument, which is larger than
// most formulation effects. Only these normalised values are compared across studies or handed to the
// optimizer (normalisedByFormulation).
import { mean, sd, welchTest, pearson, holm } from './stats.js';
import { tCritical } from './diagnostics.js';

/** The four layers, in the order the UI shows them (spec 8.1). Layer 0, the core, is always on and not listed. */
export const LAYERS = [
  { id: 'invitro', no: 1, name: 'In vitro', what: 'Transfection in cells',
    context: [['cellLine', 'Cell line', 'catalog:cellLine'], ['cargo', 'Cargo type', 'text'], ['reporter', 'Reporter gene or protein', 'text'], ['dose_ng', 'RNA dose per well (ng)', 'number'], ['cells', 'Cells per well', 'number'], ['timepoint_h', 'Timepoint (h)', 'number'], ['serum', 'Serum conditions', 'text']],
    quantities: [{ key: 'luciferase', label: 'Luciferase signal', unit: 'RLU' }, { key: 'positive_pct', label: 'Positive cells', unit: '%' }, { key: 'mfi', label: 'MFI', unit: 'a.u.' }, { key: 'viability_pct', label: 'Viability', unit: '%' }],
    subject: 'well' },
  { id: 'invivo', no: 2, name: 'In vivo potency', what: 'Overall effect in the animal',
    context: [['species', 'Species', 'text'], ['strain', 'Strain', 'catalog:strain'], ['sex', 'Sex', 'text'], ['age', 'Age', 'text'], ['route', 'Route', 'select:i.v.,i.m.,s.c.,i.p.,intranasal,other'], ['dose_mg_kg', 'Dose (mg/kg)', 'number'], ['timepoint_h', 'Timepoint (h)', 'number'], ['animalsPerGroup', 'Animals per group', 'number']],
    quantities: [{ key: 'total_flux', label: 'Total bioluminescence', unit: 'p/s' }, { key: 'serum_titer', label: 'Serum protein titre', unit: 'ng/mL' }],
    subject: 'animal' },
  { id: 'biodist', no: 3, name: 'Biodistribution', what: 'Organ by organ',
    context: [['organs', 'Organs', 'organs']],
    quantities: [{ key: 'organ_flux', label: 'Organ signal (flux)', unit: 'p/s' }, { key: 'organ_signal', label: 'Organ signal (other)', unit: 'a.u.' }, { key: 'invivo_roi_flux', label: 'In vivo ROI flux', unit: 'p/s' }],
    subject: 'animal', byOrgan: true },
  { id: 'tropism', no: 4, name: 'Cell tropism', what: 'Cell populations in an organ',
    context: [['organ', 'Organ', 'catalog:organ'], ['method', 'Method', 'select:flow cytometry,imaging'], ['markers', 'Marker panel', 'text']],
    quantities: [{ key: 'positive_pct', label: 'Positive cells', unit: '%' }, { key: 'mfi', label: 'MFI', unit: 'a.u.' }],
    subject: 'animal', byPopulation: true },
];
export const layerById = Object.fromEntries(LAYERS.map((l) => [l.id, l]));

/** The organs of layer 3: liver is on by default, the rest are switched on per study (spec 8.1). */
export const DEFAULT_ORGANS = ['liver'];

/**
 * The catalogues, as shipped. A lab adds its own (Studies › Catalogues), stored as records of the `bioCatalog`
 * collection {id: 'cellLine:Huh7', kind: 'cellLine', name: 'Huh7'}; nothing shipped is ever removed, so a
 * study that names one still reads.
 */
export const CATALOGS = {
  cellLine: { label: 'Cell lines', items: ['HEK293T', 'HeLa', 'HepG2', 'Huh7', 'A549', 'Jurkat', 'DC2.4', 'RAW 264.7'] },
  strain: { label: 'Strains', items: ['C57BL/6', 'BALB/c', 'CD-1', 'Nude (Foxn1nu)', 'NSG'] },
  organ: { label: 'Organs', items: ['liver', 'spleen', 'lung', 'kidney', 'heart', 'lymph nodes', 'injection site'] },
  population: { label: 'Cell populations', items: ['hepatocytes', 'endothelial cells (LSEC)', 'Kupffer cells', 'B cells', 'T cells', 'dendritic cells', 'macrophages', 'monocytes'] },
};

/** A catalogue's entries: the shipped ones, then the lab's own, each once, in that order. */
export function catalog(kind, userRecords = []) {
  const base = CATALOGS[kind]?.items || [];
  const own = userRecords.filter((r) => r?.kind === kind && r.name).map((r) => String(r.name).trim());
  return [...new Set([...base, ...own])];
}

/** A user catalogue record for `bioCatalog`. */
export const catalogRecord = (kind, name) => ({ id: `${kind}:${String(name).trim()}`, kind, name: String(name).trim() });

/* ------------------------------------------------------------------ settings */

/** Which layers are on. Settings keep {bio: {invitro: bool, …}}; all off by default (spec 8.5). */
export const DEFAULT_BIO = { invitro: false, invivo: false, biodist: false, tropism: false };
export const activeLayers = (settings) => LAYERS.filter((l) => settings?.bio?.[l.id] === true);
export const anyLayerOn = (settings) => activeLayers(settings).length > 0;

/**
 * The feature flag of the in-vivo planning module (spec 8.6): the "Create plan" action stays disabled until
 * this is true. There is no switch for it in Settings on purpose: turning it on is a decision for the lab,
 * after the animal-welfare text (11.3) and a biometric review exist. Stored as settings.flags.animalStudyPlan.
 */
export const animalPlanEnabled = (settings) => settings?.flags?.animalStudyPlan === true;

/* ------------------------------------------------------------------ ids and records */

export const studyId = (no) => `Study-${String(Math.max(1, Math.floor(no) || 1)).padStart(3, '0')}`;

/**
 * The next free study number, past every study on record and in the trash, so a number is never given out
 * twice (the rule the experiment series follows, app/schema.js).
 */
export function nextStudyId(studies = [], trash = []) {
  let top = 0;
  const take = (id) => { const m = /^Study-(\d+)$/.exec(String(id || '')); if (m) top = Math.max(top, Number(m[1])); };
  for (const s of studies) take(s?.id);
  for (const t of trash) for (const r of t?.records || []) if (r?.col === 'studies') take(r.rec?.id);
  return studyId(top + 1);
}

/** A new study, with a reference group and an empty test group to fill in. */
export function newStudy({ id, name = '', type = 'in vivo', layers = [], date = '' } = {}) {
  return {
    id, name, type, layers, date, licence: '', notes: '',
    context: { biodist: { organs: [...DEFAULT_ORGANS] } },
    groups: [{ id: 'G1', name: 'Reference', batchId: null, role: 'reference', n: type === 'in vitro' ? 3 : 5 }, { id: 'G2', name: 'Group 2', batchId: null, role: 'test', n: type === 'in vitro' ? 3 : 5 }],
    referenceBatchId: null, subtractBackground: true, experimentIds: [],
  };
}

/** The next group id inside a study (G1, G2 …), past every one used. */
export function nextGroupId(study) {
  let top = 0;
  for (const g of study?.groups || []) { const m = /^G(\d+)$/.exec(g.id); if (m) top = Math.max(top, Number(m[1])); }
  return `G${top + 1}`;
}

/**
 * What is not right with a study, as sentences. Warnings, never a refusal (8.2: "without a reference the app
 * warns, but saves"). `layersOn` is the ids of the layers switched on in Settings.
 */
export function studyWarnings(study, layersOn = null) {
  const out = [];
  const ref = (study.groups || []).filter((g) => g.role === 'reference');
  if (!ref.length) out.push('No reference group: values are stored, but nothing can be normalised or compared across studies until one is named.');
  else if (!ref.some((g) => g.batchId)) out.push('The reference group names no formulation: say which batch ran as the reference (the lab standard).');
  if (ref.length > 1) out.push('More than one reference group: the first is used.');
  if (!(study.groups || []).some((g) => g.role === 'test')) out.push('No test group yet.');
  const neg = (study.groups || []).some((g) => g.role === 'negative');
  if (study.subtractBackground && !neg) out.push('Background subtraction is on, but there is no negative control group (PBS, empty LNP): nothing is subtracted.');
  if (study.type === 'in vivo' && !String(study.licence || '').trim()) out.push('No animal licence number recorded.');
  if (layersOn) for (const l of study.layers || []) if (!layersOn.includes(l)) out.push(`The ${layerById[l]?.name || l} layer is switched off in Settings: its data are kept but not shown.`);
  return out;
}

/* ------------------------------------------------------------------ normalisation (8.2) */

/** The series a measurement belongs to: one read-out at one place and time. Only values of one series are compared. */
export const seriesKey = (m) => [m.layer || '', m.quantity || '', m.organ || '', m.population || '', m.timepoint_h ?? '', m.view || ''].join('|');

/** A readable name for a series: "Organ signal (flux) · liver · 6 h". */
export function seriesLabel(s) {
  const q = layerById[s.layer]?.quantities.find((x) => x.key === s.quantity)?.label || s.quantity;
  return [q, s.organ, s.population, s.timepoint_h != null && s.timepoint_h !== '' ? `${s.timepoint_h} h` : '', s.view].filter(Boolean).join(' · ');
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Normalise every series of one study (8.2). Per series:
 *   background  the mean of the negative-control group's values, subtracted first when the study says so;
 *   reference   the mean of the reference group's (background-corrected) values;
 *   each value  log10(corrected / reference mean) and the fold 10^that.
 * A value at or below the background has no logarithm: it is kept, flagged, and left out of the statistics.
 * @param {object} study
 * @param {object[]} measurements   the study's bioMeasurements
 * @returns {{series: object[], warnings: string[]}}
 */
export function normaliseStudy(study, measurements) {
  const groups = study.groups || [];
  const gById = new Map(groups.map((g) => [g.id, g]));
  const refGroup = groups.find((g) => g.role === 'reference') || null;
  const negIds = new Set(groups.filter((g) => g.role === 'negative').map((g) => g.id));
  const byKey = new Map();
  for (const m of measurements) {
    if (m?.studyId !== study.id || !finite(m.value)) continue;
    const k = seriesKey(m);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(m);
  }
  const warnings = [];
  const series = [];
  for (const [key, ms] of byKey) {
    const first = ms[0];
    const negVals = ms.filter((m) => negIds.has(m.group)).map((m) => m.value);
    const bg = study.subtractBackground && negVals.length ? mean(negVals) : 0;
    const corr = (v) => v - bg;
    const refVals = refGroup ? ms.filter((m) => m.group === refGroup.id).map((m) => corr(m.value)).filter((v) => v > 0) : [];
    const refMean = refVals.length ? mean(refVals) : null;
    const rows = ms.map((m) => {
      const c = corr(m.value);
      const log10 = refMean && c > 0 ? Math.log10(c / refMean) : null;
      const flag = c <= 0 ? 'at or below background' : !refMean ? 'no reference' : '';
      return { id: m.id, group: m.group, subject: m.subject || '', batchId: m.batchId || gById.get(m.group)?.batchId || null, raw: m.value, corrected: c, log10, fold: log10 == null ? null : 10 ** log10, flag, unit: m.unit || '' };
    });
    const gs = groups.filter((g) => rows.some((r) => r.group === g.id)).map((g) => {
      const mine = rows.filter((r) => r.group === g.id);
      const logs = mine.map((r) => r.log10).filter(finite);
      const m = mean(logs), s = sd(logs);
      return { group: g.id, name: g.name || g.id, role: g.role, batchId: g.batchId || null, n: mine.length, nLog: logs.length, logs, meanLog: m, sdLog: s, fold: m == null ? null : 10 ** m, rawMean: mean(mine.map((r) => r.raw)), rawSd: sd(mine.map((r) => r.raw)) };
    });
    // Groups the plan has no entry for (a typo in a pasted plate map) are still shown, under their own name.
    for (const r of rows) if (!gById.has(r.group) && !gs.some((g) => g.group === r.group)) {
      const mine = rows.filter((x) => x.group === r.group), logs = mine.map((x) => x.log10).filter(finite);
      gs.push({ group: r.group, name: r.group, role: 'unknown', batchId: null, n: mine.length, nLog: logs.length, logs, meanLog: mean(logs), sdLog: sd(logs), fold: mean(logs) == null ? null : 10 ** mean(logs), rawMean: mean(mine.map((x) => x.raw)), rawSd: sd(mine.map((x) => x.raw)) });
    }
    series.push({ key, layer: first.layer, quantity: first.quantity, organ: first.organ || '', population: first.population || '', timepoint_h: first.timepoint_h ?? null, view: first.view || '', unit: first.unit || '',
      background: negVals.length ? { mean: mean(negVals), n: negVals.length, subtracted: !!study.subtractBackground } : null,
      reference: refMean == null ? null : { mean: refMean, n: refVals.length, group: refGroup.id },
      rows, groups: gs });
    if (refMean == null) warnings.push(`${seriesLabel(series[series.length - 1])}: no reference values, so nothing is normalised.`);
  }
  series.sort((a, b) => (layerById[a.layer]?.no ?? 9) - (layerById[b.layer]?.no ?? 9) || a.key.localeCompare(b.key));
  return { series, warnings };
}

/* ------------------------------------------------------------------ statistics (8.4) */

/**
 * Each group against the reference, on log10 values: Welch's t test (no equal-variance assumption, the
 * groups need not spread alike), Holm-adjusted across the groups of the series. The effect size is always
 * there: the fold change over the reference with its 95 % confidence interval, from the same t distribution.
 * A star is only given with an effect size beside it, and never when the interval reaches 1-fold (spec 8.4:
 * "no star without effect size").
 * @returns {{group, name, n, nRef, fold, ci: [lo, hi]|null, p, pAdj, star: string, text: string}[]}
 */
export function compareToReference(series) {
  const ref = series.groups.find((g) => g.role === 'reference');
  const tests = series.groups.filter((g) => g.role !== 'reference' && g.role !== 'negative');
  const out = tests.map((g) => {
    const base = { group: g.group, name: g.name, n: g.nLog, nRef: ref?.nLog || 0, fold: g.fold, ci: null, p: null, pAdj: null, star: '' };
    if (!ref || g.nLog < 2 || ref.nLog < 2) return { ...base, note: !ref ? 'no reference group' : 'too few values for a test (need 2 per group)' };
    const t = welchTest(g.logs, ref.logs);
    if (!t) return { ...base, note: 'no spread in the values: no test' };
    const tc = tCritical(t.df);
    const lo = t.diff - tc * t.se, hi = t.diff + tc * t.se;
    return { ...base, fold: 10 ** t.diff, ci: [10 ** lo, 10 ** hi], p: t.p, df: t.df };
  });
  const adj = holm(out.map((o) => o.p));
  out.forEach((o, i) => {
    o.pAdj = adj[i];
    if (o.ci && o.pAdj != null) {
      const clear = o.ci[0] > 1 || o.ci[1] < 1;
      o.star = !clear ? '' : o.pAdj < 0.001 ? '***' : o.pAdj < 0.01 ? '**' : o.pAdj < 0.05 ? '*' : '';
    }
    o.text = effectText(o);
  });
  return out;
}

const fmtFold = (f) => (!finite(f) ? '–' : f >= 100 ? f.toFixed(0) : f >= 10 ? f.toFixed(1) : f >= 0.1 ? f.toFixed(2) : f.toPrecision(2));
export { fmtFold };

/** "3.2-fold over reference (95 % CI 1.4–7.1), n = 5 vs 5, p (Holm) = 0.012 *" */
export function effectText(o) {
  if (!finite(o.fold)) return `${o.name}: no normalised values${o.note ? ` (${o.note})` : ''}.`;
  const dir = o.fold >= 1 ? `${fmtFold(o.fold)}-fold over reference` : `${fmtFold(1 / o.fold)}-fold below reference`;
  if (!o.ci) return `${o.name}: ${dir}, n = ${o.n} vs ${o.nRef}${o.note ? `; ${o.note}` : ''}.`;
  const p = o.pAdj < 0.0001 ? '< 0.0001' : `= ${o.pAdj.toFixed(o.pAdj < 0.01 ? 4 : 3)}`;
  return `${o.name}: ${dir} (95 % CI ${fmtFold(o.ci[0])}–${fmtFold(o.ci[1])}), n = ${o.n} vs ${o.nRef}, p (Holm) ${p}${o.star ? ` ${o.star}` : ''}.`;
}

/**
 * Organ ratios (8.4: "derived ratios, e.g. liver to spleen"): per group, the ratio of two organs in the same
 * animal, averaged on the log scale (a geometric mean), so one animal's high liver does not swamp the others.
 * Background-corrected values, as normalised; animals missing either organ are left out.
 */
export function organRatios(norm, { num, den, layer = 'biodist', quantity = null }) {
  const pick = (organ) => norm.series.find((s) => s.layer === layer && s.organ === organ && (!quantity || s.quantity === quantity));
  const a = pick(num), b = pick(den);
  if (!a || !b) return [];
  const groups = new Map();
  for (const r of a.rows) {
    const o = b.rows.find((x) => x.group === r.group && x.subject && x.subject === r.subject);
    if (!o || !(r.corrected > 0) || !(o.corrected > 0)) continue;
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(Math.log10(r.corrected / o.corrected));
  }
  return [...groups].map(([group, logs]) => ({ group, name: a.groups.find((g) => g.group === group)?.name || group, n: logs.length, ratio: 10 ** mean(logs), sdLog: sd(logs) }));
}

/**
 * Cell tropism as stacked shares (8.4): per group, each population's share of the positive cells over all
 * populations measured, from the mean % positive per population. The shares add to 100 % per group.
 */
export function tropismShares(norm, { quantity = 'positive_pct', organ = null } = {}) {
  const ss = norm.series.filter((s) => s.layer === 'tropism' && s.quantity === quantity && (!organ || s.organ === organ) && s.population);
  const pops = [...new Set(ss.map((s) => s.population))];
  const gids = [...new Set(ss.flatMap((s) => s.groups.map((g) => g.group)))];
  return gids.map((g) => {
    const vals = pops.map((p) => { const s = ss.find((x) => x.population === p); const gg = s?.groups.find((x) => x.group === g); return Math.max(0, gg?.rawMean ?? 0); });
    const sum = vals.reduce((a, b) => a + b, 0);
    const name = ss.flatMap((s) => s.groups).find((x) => x.group === g)?.name || g;
    return { group: g, name, parts: pops.map((p, i) => ({ population: p, value: vals[i], share: sum > 0 ? vals[i] / sum : 0 })) };
  });
}

/* ------------------------------------------------------------------ across studies, and the optimizer hook (7.9) */

/**
 * Per formulation, its normalised values by series and study: the hook the optimizer's biological targets
 * will be wired to (spec 7.9). Only normalised values leave a study (8.2). Negative controls are not
 * formulations and are left out; the reference batch is in (at about 0 in its own study, which is information
 * when it is a test group elsewhere). Keys are `layer|quantity|organ|population|timepoint|view`, as seriesKey.
 *
 * @param {object[]} studies
 * @param {object[]} measurements   every bioMeasurement
 * @returns {Map<string, Object<string, {mean: number, n: number, sd: number|null, studies: Object<string, {mean, n}>}>>}
 *   formulation (batch) id → series key → the mean log10 fold over reference across its studies (each study
 *   weighted by its number of animals or wells), the count, and the per-study means
 */
export function normalisedByFormulation(studies, measurements) {
  const out = new Map();
  for (const st of studies) {
    const norm = normaliseStudy(st, measurements.filter((m) => m.studyId === st.id));
    for (const s of norm.series) for (const g of s.groups) {
      if (g.role === 'negative' || !g.batchId || !g.nLog) continue;
      if (!out.has(g.batchId)) out.set(g.batchId, {});
      const per = out.get(g.batchId);
      per[s.key] ||= { studies: {}, logs: [] };
      per[s.key].studies[st.id] = { mean: g.meanLog, n: g.nLog };
      per[s.key].logs.push(...g.logs);
    }
  }
  for (const per of out.values()) for (const k of Object.keys(per)) {
    const e = per[k];
    per[k] = { mean: mean(e.logs), n: e.logs.length, sd: sd(e.logs), studies: e.studies };
  }
  return out;
}

/** The series keys present across studies, with a readable label each, for the cross-study scatter's picker. */
export function seriesCatalogue(byFormulation) {
  const keys = new Set();
  for (const per of byFormulation.values()) for (const k of Object.keys(per)) keys.add(k);
  return [...keys].sort().map((key) => { const [layer, quantity, organ, population, tp, view] = key.split('|'); return { key, label: `${layerById[layer]?.name || layer}: ${seriesLabel({ layer, quantity, organ, population, timepoint_h: tp, view })}` }; });
}

/**
 * Physicochemistry against the normalised biological signal across studies (8.4: "size against liver signal"):
 * one point per formulation that has both. `rows` are the data overview's rows (app/calc/facets.js dataRows).
 */
export function physchemScatter(rows, byFormulation, { x = 'size', key }) {
  const pts = [];
  for (const r of rows) {
    const e = byFormulation.get(r.id)?.[key];
    if (!e || !finite(e.mean) || !finite(r[x])) continue;
    pts.push({ x: r[x], y: e.mean, fold: 10 ** e.mean, n: e.n, label: `${r.id}${r.label ? ' ' + r.label : ''} (n = ${e.n}, ${Object.keys(e.studies).length} stud${Object.keys(e.studies).length === 1 ? 'y' : 'ies'})` });
  }
  const r = pearson(pts.map((p) => p.x), pts.map((p) => p.y));
  return { points: pts, r: r.r, n: pts.length };
}

/* ------------------------------------------------------------------ the study plan and the animals */

/**
 * Every subject the plan foresees, in order: group by group, n each, named G1-1, G1-2 … unless the
 * measurements already name them. For suggesting which mouse in an image is which animal (8.7).
 */
export function plannedSubjects(study) {
  const out = [];
  for (const g of study.groups || []) for (let i = 1; i <= Math.max(0, Number(g.n) || 0); i++) out.push({ group: g.id, subject: `${g.id}-${i}` });
  return out;
}

/**
 * Suggest an animal and group for each mouse of an image, left to right (8.7: "suggested from the study plan by
 * position, confirmed in one click"). Ids written in the click's comment come first (Living Image's Comment1
 * often lists them left to right); a known id keeps the group it has in earlier measurements. Otherwise the
 * next animals of the plan that have no value for this series yet are taken in order.
 * @param {object} study
 * @param {number} count   mice in the image
 * @param {{ids?: string[], taken?: Set<string>, known?: Map<string, string>}} o   ids from the comment; subjects
 *   already measured in this series; subject → group from earlier measurements
 */
export function suggestAnimals(study, count, { ids = [], taken = new Set(), known = new Map() } = {}) {
  const plan = plannedSubjects(study).filter((s) => !taken.has(s.subject));
  const out = [];
  let k = 0;
  for (let i = 0; i < count; i++) {
    if (ids.length === count) {
      const id = ids[i];
      out.push({ subject: id, group: known.get(id) || plannedSubjects(study).find((s) => s.subject === id)?.group || '', from: 'comment' });
    } else {
      const s = plan[k++];
      out.push(s ? { ...s, from: 'plan' } : { subject: '', group: '', from: 'none' });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ records from imports */

/**
 * The id of a measurement: one value per subject and series in a study, so importing the same plate or image
 * again replaces its values instead of adding them twice.
 */
export const measurementId = (studyId, m) => `bm:${studyId}:${seriesKey(m)}:${m.subject || ''}`;

const SKIP_WELL = /^(?:|-|–|empty|leer|blank|none|n\/a|x)$/i;

/**
 * Plate values to bioMeasurements, through the plate layout (which name sits in which well). A name is matched
 * to a group by the group's name, its id (G2) or the formulation it names (E3-F2), ignoring case; names that
 * match nothing are listed back, and their wells are not stored. Wells without a value or marked empty are skipped.
 * @param {object} o
 * @param {Object<string, {value: number|null}>} o.values   parsePlate().blocks[i].wells
 * @param {Object<string, string>} o.layout                 well → name (a layout grid, or the export's sample column)
 * @param {object} o.study
 * @param {{layer, quantity, unit, organ?, population?, timepoint_h?}} o.series
 * @param {object} [o.provenance]
 */
export function plateToMeasurements({ values, layout, study, series, provenance = null }) {
  const groups = study.groups || [];
  const find = (name) => {
    const n = String(name || '').trim().toLowerCase();
    return groups.find((g) => String(g.name || '').trim().toLowerCase() === n || String(g.id).toLowerCase() === n || (g.batchId && String(g.batchId).toLowerCase() === n)) || null;
  };
  const out = [], unmatched = new Set();
  let skipped = 0;
  for (const [well, cell] of Object.entries(values || {})) {
    const name = layout?.[well];
    if (name == null || SKIP_WELL.test(String(name).trim())) { skipped++; continue; }
    if (!finite(cell?.value)) { skipped++; continue; }
    const g = find(name);
    if (!g) { unmatched.add(String(name).trim()); continue; }
    const m = { studyId: study.id, batchId: g.batchId || null, group: g.id, subject: well, layer: series.layer, organ: series.organ || '', population: series.population || '', quantity: series.quantity, value: cell.value, unit: series.unit || '', timepoint_h: series.timepoint_h ?? null };
    if (provenance) m.provenance = provenance;
    out.push({ ...m, id: measurementId(study.id, m) });
  }
  return { measurements: out, unmatched: [...unmatched], skipped };
}

/**
 * The measurements one analysed IVIS image gives, per mouse assigned to an animal and group: the total flux
 * over the mouse (layer 2) and the in-vivo liver ROI (layer 3, kept apart from ex vivo organ values as its own
 * quantity). Each names the image (path and SHA-256 of the luminescent file), the mouse's number and the
 * algorithm and method that measured it.
 * @param {object} o
 * @param {object} o.study
 * @param {object} o.image   the bliImages record: {id, folder, files, view, timepoint_h, algorithm, mice: [{n, totalFlux, liver: {flux}, subject, group, excluded}]}
 */
export function bliToMeasurements({ study, image, provenance = null }) {
  const lum = (image.files || []).find((f) => /luminescent\.tif$/i.test(f.name)) || null;
  const out = [];
  for (const m of image.mice || []) {
    if (m.excluded || !m.subject || !m.group) continue;
    const g = (study.groups || []).find((x) => x.id === m.group);
    const base = { studyId: study.id, batchId: g?.batchId || null, group: m.group, subject: m.subject, timepoint_h: image.timepoint_h ?? null, view: image.view || '',
      file: lum ? { path: `${image.folder}/${lum.name}`, sha256: lum.sha256 } : null, imageId: image.id, mouse: m.n, algorithm: image.algorithm };
    if (provenance) base.provenance = provenance;
    const total = { ...base, layer: 'invivo', organ: '', population: '', quantity: 'total_flux', value: m.totalFluxManual ?? m.totalFlux, unit: 'p/s' };
    const liver = { ...base, layer: 'biodist', organ: 'liver', population: '', quantity: 'invivo_roi_flux', value: m.liver?.flux, unit: 'p/s' };
    for (const x of [total, liver]) if (finite(x.value)) out.push({ ...x, id: measurementId(study.id, x) });
  }
  return out;
}

/* ------------------------------------------------------------------ agreement (the BLI test bench) */

/**
 * Agreement of automatic values with manual ones, on the log scale (spec 8.7): Pearson r of log10 values,
 * Bland–Altman bias and 95 % limits of agreement of log10(auto / manual) (also as fold), the median absolute
 * percent difference, and the share of pairs within 20 %. Pairs where either value is not positive are left out.
 */
export function agreement(auto, manual) {
  const pairs = auto.map((a, i) => [a, manual[i]]).filter(([a, m]) => a > 0 && m > 0);
  const n = pairs.length;
  if (!n) return { n: 0 };
  const la = pairs.map(([a]) => Math.log10(a)), lm = pairs.map(([, m]) => Math.log10(m));
  const d = pairs.map(([a, m]) => Math.log10(a / m));
  const bias = mean(d), s = sd(d);
  const pct = pairs.map(([a, m]) => Math.abs(a / m - 1)).sort((x, y) => x - y);
  const within = pairs.filter(([a, m]) => Math.abs(a / m - 1) <= 0.2).length;
  return {
    n, r: pearson(la, lm).r,
    bias, sdDiff: s, limits: s == null ? null : [bias - 1.96 * s, bias + 1.96 * s],
    biasFold: 10 ** bias, limitsFold: s == null ? null : [10 ** (bias - 1.96 * s), 10 ** (bias + 1.96 * s)],
    medianAbsPct: 100 * (n % 2 ? pct[n >> 1] : (pct[n / 2 - 1] + pct[n / 2]) / 2),
    within20: within / n,
  };
}
