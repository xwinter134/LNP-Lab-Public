// The data overview's engine (spec 5): one flat row per formulation, facets with counts, filters that live in the
// URL, the numbers above the table, completeness, distributions, and the sentence a selection is handed on with.
//
// Pure: no DOM, no store. The screen (app/ui/data.js) builds the rows once per visit and filters them on every
// click; the optimizer (app/ui/ml.js) builds the same rows to apply a selection handed to it. Tested at 10,000
// formulations against the 200 ms the spec sets (tests/facets.test.mjs).
//
// Counts are shop-style: a facet's counts are what you would get by changing *that* facet, with every other
// filter applied. So ticking ALC-0315 does not make the other lipids' counts drop to zero; it shows how many
// each would add. Computed in one pass: a row that fails no filter counts for every facet, a row that fails
// exactly one counts for that facet alone, a row that fails two counts nowhere.
import { ionizableLipids, isPegFree, readVariable } from './variables.js';
import { provenanceOf, fromInstrumentFile, SOURCES } from './provenance.js';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const meanOf = (xs) => { const v = xs.filter(finite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
export function median(xs) {
  const v = xs.filter(finite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** The lipid keys of one class in a composition, most mol% first. */
function ofClass(comp, lipidByKey, cls) {
  if (!comp?.mol_pct) return [];
  return Object.entries(comp.mol_pct).filter(([k, v]) => v > 0 && lipidByKey[k]?.class === cls).sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/**
 * One row per formulation, everything a facet, a column or a chart reads. `src` = {batches, experiments,
 * measurements, and optionally studies and bioMeasurements}; `ref` = {compositionById, lipidByKey}. Size, PDI and EE are the mean of the formulation's
 * final-stage results (any stage when it has no final one), as the results screens read them.
 */
export function dataRows(src = {}, ref = {}) {
  const exps = new Map((src.experiments || []).map((e) => [e.id, e]));
  const mByBatch = new Map();
  for (const m of src.measurements || []) {
    if (!m?.batchId) continue;
    if (!mByBatch.has(m.batchId)) mByBatch.set(m.batchId, []);
    mByBatch.get(m.batchId).push(m);
  }
  const lipidByKey = ref.lipidByKey || {}, compById = ref.compositionById || {};
  // Formulations with biological data (spec 8): a bioMeasurement names its batch, or its study group does.
  const bio = new Set();
  const groupBatch = new Map();
  for (const st of src.studies || []) for (const g of st?.groups || []) if (g?.batchId) groupBatch.set(`${st.id}|${g.id}`, g.batchId);
  for (const m of src.bioMeasurements || []) { const id = m?.batchId || groupBatch.get(`${m?.studyId}|${m?.group}`); if (id) bio.add(id); }
  const rows = [];
  for (const b of src.batches || []) {
    if (!b?.id) continue;
    const e = exps.get(b.experimentId);
    const ms = mByBatch.get(b.id) || [];
    const pick = (test) => { const all = ms.filter((m) => m.test === test); const fin = all.filter((m) => (m.stage || 'final') === 'final' && !m.timepoint && !m.condition); return fin.length ? fin : all; };
    const dls = pick('dls'), ee = pick('ee'), zeta = pick('zeta');
    const base = compById[b.compositionId];
    const ov = b.plan?.compositionOverride;
    const comp = ov?.mol_pct ? { ...base, mol_pct: ov.mol_pct } : base;
    const vr = (k) => readVariable(b, k, ref);
    const prov = provenanceOf(b);
    const operators = [...new Set([b.actual?.rna_operator, ...ms.map((m) => m.operator)].filter(Boolean))];
    const ionizable = ionizableLipids(comp, lipidByKey);
    // A formulation typed in by hand whose size came off the Zetasizer's export is both: the Source facet lists
    // it under each, so "Instrument file" finds every formulation with a result read from a file.
    const files = [];
    for (const m of ms) if (fromInstrumentFile(m)) { const f = m.provenance?.file || { name: m.raw?.fileName, sha256: m.raw?.sha256 }; if (f?.name && !files.some((x) => x.name === f.name)) files.push(f); }
    const instrument = files.length > 0 || ms.some(fromInstrumentFile);
    const sources = [prov.source, ...(instrument && prov.source !== 'instrument-import' ? ['instrument-import'] : [])];
    rows.push({
      id: b.id, experimentId: b.experimentId || null, experimentName: e?.name || '', label: b.label || '', status: b.status || '',
      date: String(b.plannedDate || e?.startDate || '').slice(0, 10), compositionId: b.compositionId ?? null, synonym: comp?.synonym || '',
      stockId: b.stockId || null, rnaLot: b.plan?.rna?.lotId || null,
      ionizable, helper: ofClass(comp, lipidByKey, 'helper'), sterol: ofClass(comp, lipidByKey, 'sterol'), peg: ofClass(comp, lipidByKey, 'peg'),
      pegFree: isPegFree(comp, lipidByKey),
      bufferSystem: vr('bufferSystem'), loadingPH: finite(vr('loadingPH')) ? vr('loadingPH') : null, bufferMolarity_mM: vr('bufferMolarity_mM'),
      mixerType: vr('mixerType'), mixer: vr('mixer'), postMethod: vr('postMethod'), rnaType: vr('rnaType'),
      cryoprotectant: vr('cryoprotectant'), targetPH: vr('targetPH'),
      frr: b.plan?.mixing?.frr ?? null, tfr: b.plan?.mixing?.totalFlow ?? null, np: b.plan?.rna?.np ?? null,
      quench: b.plan?.mixing?.quenchFactor ?? null, lipid_mM: b.plan?.mixing?.lipidStock_mM ?? null, rna_mg_mL: b.plan?.rna?.working_mg_mL ?? null,
      operators, source: prov.source, sources, importId: prov.importId || null,
      // Where the formulation's own record came from (spec 4.3), for the export's provenance columns.
      file: prov.file?.name || null, sha256: prov.file?.sha256 || null, sheet: prov.sheet ?? null, sourceRow: prov.row ?? null,
      resultFiles: files,
      size: meanOf(dls.map((m) => m.values?.zave_nm)), pdi: meanOf(dls.map((m) => m.values?.pdi)), ee: meanOf(ee.map((m) => m.values?.ee_pct)), zeta: meanOf(zeta.map((m) => m.values?.zeta_mV)),
      has: {
        dls: dls.some((m) => finite(m.values?.zave_nm) || finite(m.values?.pdi)),
        ee: ee.some((m) => finite(m.values?.ee_pct)),
        stability: ms.some((m) => m.timepoint != null || m.condition),
        bio: bio.has(b.id) || ms.some((m) => m.layer || m.study) || false, // the biological layers (spec 8)
      },
      // Every string the formulation names, for the free text over the search index (textMatches)
      names: [b.plan?.rna?.diluent, b.plan?.mixing?.quenchBuffer, b.plan?.downstream?.dialysis?.buffer, b.plan?.downstream?.finalFormulation?.buffer1, b.plan?.downstream?.finalFormulation?.buffer2].filter(Boolean),
      nResults: ms.length,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------------- facets

const lipidName = (ref) => (k) => ref?.lipidByKey?.[k]?.name || k;
const HAS = [['dls', 'DLS'], ['ee', 'RiboGreen (EE)'], ['stability', 'Stability'], ['bio', 'Biological data']];
const SOURCE = SOURCES; // one wording for where a record came from, app/calc/provenance.js

/**
 * The facets, in the order of the panel. `values(row)` gives the row's values as strings (several for a lipid
 * list); `label(value)` how a value reads; `range` facets filter on a number between two bounds instead.
 */
export function facetDefs(ref = {}) {
  const ln = lipidName(ref);
  return [
    { key: 'ionizable', group: 'Composition', label: 'Ionizable lipid', values: (r) => r.ionizable, label1: ln },
    { key: 'helper', group: 'Composition', label: 'Helper lipid', values: (r) => r.helper, label1: ln },
    { key: 'sterol', group: 'Composition', label: 'Sterol', values: (r) => r.sterol, label1: ln },
    { key: 'peg', group: 'Composition', label: 'PEG lipid', values: (r) => (r.pegFree ? ['__pegfree'] : r.peg), label1: (v) => (v === '__pegfree' ? 'PEG-free' : ln(v)) },
    { key: 'bufferSystem', group: 'Process', label: 'Buffer system', values: (r) => [r.bufferSystem] },
    { key: 'loadingPH', group: 'Process', label: 'Loading pH', range: true, num: (r) => r.loadingPH, step: 0.1 },
    { key: 'mixerType', group: 'Process', label: 'Mixer type', values: (r) => [r.mixerType] },
    { key: 'postMethod', group: 'Process', label: 'Downstream', values: (r) => [r.postMethod] },
    { key: 'rnaType', group: 'Context', label: 'Cargo', values: (r) => [r.rnaType] },
    { key: 'experiment', group: 'Context', label: 'Experiment', values: (r) => [r.experimentId], label1: (v, rows) => { const r = rows?.find((x) => x.experimentId === v); return r?.experimentName ? `${v} · ${r.experimentName}` : v; } },
    { key: 'date', group: 'Context', label: 'Period', range: true, dates: true, num: (r) => r.date || null },
    { key: 'operator', group: 'Context', label: 'Operator', values: (r) => r.operators },
    { key: 'source', group: 'Origin', label: 'Source', values: (r) => r.sources || [r.source], label1: (v) => SOURCE[v] || v },
    { key: 'importId', group: 'Origin', label: 'Import', values: (r) => [r.importId] },
    { key: 'has', group: 'Measurements', label: 'Has', values: (r) => HAS.filter(([k]) => r.has[k]).map(([k]) => k), label1: (v) => HAS.find(([k]) => k === v)?.[1] || v, all: true },
    { key: 'size', group: 'Measurements', label: 'Size (nm)', range: true, num: (r) => r.size, step: 1 },
    { key: 'pdi', group: 'Measurements', label: 'PDI', range: true, num: (r) => r.pdi, step: 0.01 },
  ];
}

/**
 * The filter, as the URL holds it: one parameter per facet. A list is joined with "|" (values may hold commas),
 * a range is "lo~hi" with either end open. `q` is free text, `missing` a field whose value is missing (from the
 * completeness table).
 */
export function readFilter(params = {}, defs = facetDefs()) {
  const f = {};
  for (const d of defs) {
    const raw = params[d.key];
    if (raw == null || raw === '') continue;
    if (d.range) {
      const [lo, hi] = String(raw).split('~');
      const conv = d.dates ? (s) => (s ? s : null) : (s) => (s === '' || s == null ? null : Number(s));
      f[d.key] = [conv(lo), conv(hi)];
    } else f[d.key] = String(raw).split('|').filter(Boolean);
  }
  if (params.q) f.q = String(params.q);
  if (params.missing) f.missing = String(params.missing);
  // A set of formulations another screen links in (a finding of Claude's report, a plot's selection): their
  // ids, comma-separated, since an id never holds a comma.
  if (params.ids) { const ids = String(params.ids).split(',').map((x) => x.trim()).filter(Boolean); if (ids.length) f.ids = ids; }
  return f;
}
export function writeFilter(f = {}, defs = facetDefs()) {
  const out = {};
  for (const d of defs) {
    const v = f[d.key];
    if (!v) continue;
    if (d.range) { if (v[0] != null || v[1] != null) out[d.key] = `${v[0] ?? ''}~${v[1] ?? ''}`; }
    else if (v.length) out[d.key] = v.join('|');
  }
  if (f.q) out.q = f.q;
  if (f.missing) out.missing = f.missing;
  if (f.ids?.length) out.ids = f.ids.join(',');
  return out;
}
/** The filter as one query string: what a saved view and a hand-over to the optimizer carry. */
export const filterQuery = (f, defs) => new URLSearchParams(writeFilter(f, defs)).toString();
export const parseFilterQuery = (q, defs) => readFilter(Object.fromEntries(new URLSearchParams(q || '')), defs);

/**
 * The tests a facet makes of a row: a function per active filter, so a row is judged once per filter.
 * `textHits` is the set of formulation ids the free text matched (from the search index), or null.
 */
function predicates(f, defs, textHits) {
  const out = [];
  for (const d of defs) {
    const v = f[d.key];
    if (!v) continue;
    if (d.range) {
      const [lo, hi] = v;
      if (lo == null && hi == null) continue;
      out.push({ key: d.key, test: (r) => { const x = d.num(r); if (x == null) return false; return (lo == null || x >= lo) && (hi == null || x <= hi); } });
    } else if (v.length) {
      const want = new Set(v);
      // "Has DLS and RiboGreen" means both; a lipid facet means any of the ticked ones.
      out.push({ key: d.key, test: d.all ? (r) => v.every((x) => d.values(r).includes(x)) : (r) => d.values(r).some((x) => want.has(String(x))) });
    }
  }
  if (textHits) out.push({ key: 'q', test: (r) => textHits.has(r.id) });
  if (f.missing) out.push({ key: 'missing', test: (r) => missingIn(r, f.missing) });
  if (f.ids?.length) { const ids = new Set(f.ids); out.push({ key: 'ids', test: (r) => ids.has(r.id) }); }
  return out;
}

/**
 * Apply a filter: {rows: the matching rows, counts: {facet: Map(value → n)}, ranges: {facet: [min, max]}}.
 * `textHits` as in predicates. Counts are shop-style (see the top of this file).
 */
export function applyFilter(rows, f = {}, defs = facetDefs(), textHits = null) {
  const preds = predicates(f, defs, textHits);
  const counts = Object.fromEntries(defs.filter((d) => !d.range).map((d) => [d.key, new Map()]));
  const ranges = {};
  const out = [];
  const add = (d, r) => { const c = counts[d.key]; for (const v of d.values(r)) if (v != null && v !== '') c.set(String(v), (c.get(String(v)) || 0) + 1); };
  for (const r of rows) {
    let failed = null, nFail = 0;
    for (const p of preds) if (!p.test(r)) { nFail++; failed = p.key; if (nFail > 1) break; }
    if (nFail === 0) {
      out.push(r);
      for (const d of defs) if (!d.range) add(d, r);
    } else if (nFail === 1) {
      const d = defs.find((x) => x.key === failed);
      if (d && !d.range) add(d, r);
    }
  }
  // The span of each range facet over every row, so the slider's ends do not move as the filter narrows.
  for (const d of defs.filter((x) => x.range)) {
    let lo = null, hi = null;
    for (const r of rows) { const x = d.num(r); if (x == null) continue; if (lo == null || x < lo) lo = x; if (hi == null || x > hi) hi = x; }
    ranges[d.key] = [lo, hi];
  }
  return { rows: out, counts, ranges };
}

/** The numbers above the table: formulations, experiments, period, and median size, PDI and EE. */
export function summary(rows) {
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  return {
    formulations: rows.length,
    experiments: new Set(rows.map((r) => r.experimentId).filter(Boolean)).size,
    from: dates[0] || null, to: dates[dates.length - 1] || null,
    size: median(rows.map((r) => r.size)), pdi: median(rows.map((r) => r.pdi)), ee: median(rows.map((r) => r.ee)),
    nSize: rows.filter((r) => finite(r.size)).length, nPdi: rows.filter((r) => finite(r.pdi)).length, nEe: rows.filter((r) => finite(r.ee)).length,
  };
}

// ---------------------------------------------------------------------------------------------- completeness

/** The fields the completeness table reports (spec 5.2), the same set as the import's quality report. */
export const COMPLETENESS = [
  { key: 'frr', label: 'FRR' }, { key: 'tfr', label: 'Total flow' }, { key: 'np', label: 'N/P' }, { key: 'quench', label: 'Quench factor' },
  { key: 'lipid_mM', label: 'Lipid stock mM' }, { key: 'rna_mg_mL', label: 'RNA mg/mL' },
  { key: 'bufferSystem', label: 'Buffer system' }, { key: 'loadingPH', label: 'Loading pH' }, { key: 'mixerType', label: 'Mixer type' },
  { key: 'postMethod', label: 'Downstream method' }, { key: 'rnaType', label: 'Cargo' },
  { key: 'size', label: 'Size (DLS)' }, { key: 'pdi', label: 'PDI' }, { key: 'ee', label: 'EE' },
];
const present = (v) => v != null && v !== '' && !(typeof v === 'number' && !Number.isFinite(v));
export const missingIn = (r, key) => !present(r[key]);

/** Share of the rows with each field: [{key, label, n, share, level: 'good' | 'warn' | 'bad'}]. */
export function completeness(rows) {
  return COMPLETENESS.map((c) => {
    const n = rows.filter((r) => present(r[c.key])).length;
    const share = rows.length ? n / rows.length : 0;
    return { ...c, n, share, level: share > 0.9 ? 'good' : share >= 0.5 ? 'warn' : 'bad' };
  });
}

// --------------------------------------------------------------------------------------------- distributions

/** Equal-width bins over [lo, hi): [{lo, hi, n}], the last one closed. */
export function histogram(values, { bins = 10, lo = null, hi = null } = {}) {
  const v = values.filter(finite);
  if (!v.length) return [];
  const a = lo ?? Math.min(...v), b = hi ?? Math.max(...v);
  if (a === b) return [{ lo: a, hi: b, n: v.length }];
  const w = (b - a) / bins;
  const out = Array.from({ length: bins }, (_, i) => ({ lo: a + i * w, hi: a + (i + 1) * w, n: 0 }));
  for (const x of v) { const i = Math.min(bins - 1, Math.max(0, Math.floor((x - a) / w))); out[i].n++; }
  return out;
}

/** Runs per value of a list field (a lipid, a buffer), most first. */
export function tally(rows, values) {
  const m = new Map();
  for (const r of rows) for (const v of values(r)) if (v != null && v !== '') m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n }));
}

/** Runs per month, every month from the first to the last present, empty ones included. */
export function perMonth(rows) {
  const ms = rows.map((r) => r.date?.slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m || '')).sort();
  if (!ms.length) return [];
  const out = [];
  let [y, m] = ms[0].split('-').map(Number);
  const [y1, m1] = ms[ms.length - 1].split('-').map(Number);
  const count = new Map(); for (const k of ms) count.set(k, (count.get(k) || 0) + 1);
  while (y < y1 || (y === y1 && m <= m1)) { const k = `${y}-${String(m).padStart(2, '0')}`; out.push({ month: k, n: count.get(k) || 0 }); m++; if (m > 12) { m = 1; y++; } }
  return out.slice(-36); // three years at most on one chart; the period facet narrows further back
}

/**
 * Two selections' distributions over each other (spec 5.3, comparing two saved views): runs per ionizable lipid,
 * size, PDI and runs per month, on one shared axis each. Each bar is the share of its own view, so a view of 40
 * and one of 400 formulations can be read against each other; `a` and `b` are the counts behind the shares.
 * @returns {{lipid, size, pdi, month}} each a list of {key, label, a, b, shareA, shareB}
 */
export function overlayDistributions(ra, rb, { bins = 10 } = {}) {
  const share = (n, of) => (of ? n / of : 0);
  const pack = (items) => items.map((x) => ({ ...x, shareA: share(x.a, ra.length), shareB: share(x.b, rb.length) }));
  const bucketed = (key) => {
    const all = [...ra, ...rb].map((r) => r[key]).filter(finite);
    if (!all.length) return [];
    let lo = all[0], hi = all[0]; for (const x of all) { if (x < lo) lo = x; if (x > hi) hi = x; }
    const ha = histogram(ra.map((r) => r[key]), { bins, lo, hi }), hb = histogram(rb.map((r) => r[key]), { bins, lo, hi });
    // A view with no value for this key has no bins at all; it counts none in each of the other's.
    const edges = ha.length ? ha : hb;
    return pack(edges.map((h, i) => ({ key: i, lo: h.lo, hi: h.hi, a: ha[i]?.n || 0, b: hb[i]?.n || 0 })));
  };
  const ta = new Map(tally(ra, (r) => r.ionizable).map((t) => [t.value, t.n])), tb = new Map(tally(rb, (r) => r.ionizable).map((t) => [t.value, t.n]));
  const lipids = [...new Set([...ta.keys(), ...tb.keys()])].sort((x, y) => ((tb.get(y) || 0) + (ta.get(y) || 0)) - ((tb.get(x) || 0) + (ta.get(x) || 0)));
  // One month axis from the first month of either to the last of either, empty months included.
  const months = perMonth([...ra, ...rb]).map((m) => m.month);
  const ma = new Map(perMonth(ra).map((m) => [m.month, m.n])), mb = new Map(perMonth(rb).map((m) => [m.month, m.n]));
  return {
    lipid: pack(lipids.map((k) => ({ key: k, a: ta.get(k) || 0, b: tb.get(k) || 0 }))),
    size: bucketed('size'),
    pdi: bucketed('pdi'),
    month: pack(months.map((k) => ({ key: k, a: ma.get(k) || 0, b: mb.get(k) || 0 }))),
  };
}

// --------------------------------------------------------------------------------------------------- wording

/**
 * The selection in words, as the optimizer shows it when handed over (spec 5.3):
 * "ALC-0315, Herringbone chip, Citrate, 412 formulations".
 */
export function describeFilter(f, defs, n, rows = []) {
  const bits = [];
  for (const d of defs) {
    const v = f[d.key];
    if (!v) continue;
    if (d.range) {
      const [lo, hi] = v;
      if (lo == null && hi == null) continue;
      bits.push(`${d.label} ${lo != null && hi != null ? `${lo}–${hi}` : lo != null ? `from ${lo}` : `up to ${hi}`}`);
    } else if (v.length) bits.push(v.map((x) => (d.label1 ? d.label1(x, rows) : x)).join(' or '));
  }
  if (f.q) bits.push(`"${f.q}"`);
  if (f.missing) bits.push(`without ${COMPLETENESS.find((c) => c.key === f.missing)?.label || f.missing}`);
  if (f.ids?.length) bits.push(chosenLabel(f.ids.length));
  return [...bits, `${n} formulation${n === 1 ? '' : 's'}`].join(', ');
}

/** How a set of formulations linked in by id reads, on its chip and in the sentence. */
export const chosenLabel = (n) => `${n} chosen formulation${n === 1 ? '' : 's'}`;

/** The address that opens a set of formulations in the data overview. */
export const idsHref = (ids) => `#/data?ids=${encodeURIComponent([...new Set(ids)].join(','))}`;

// ------------------------------------------------------------------------------------------------- the table

/** The table's columns: key, heading, how a row's cell reads, and whether it is shown at first. */
export function columnDefs(ref = {}) {
  const ln = lipidName(ref);
  const n = (k, dp) => (r) => (finite(r[k]) ? Number(r[k].toFixed(dp)) : null);
  return [
    { key: 'id', label: 'Formulation', get: (r) => r.id, on: true },
    { key: 'experiment', label: 'Experiment', get: (r) => (r.experimentName ? `${r.experimentId} · ${r.experimentName}` : r.experimentId), on: true },
    { key: 'date', label: 'Date', get: (r) => r.date, on: true },
    { key: 'ionizable', label: 'Ionizable lipid', get: (r) => r.ionizable.map(ln).join(', '), on: true },
    { key: 'composition', label: 'Composition', get: (r) => (r.compositionId != null ? `#${r.compositionId}${r.synonym ? ' ' + r.synonym : ''}` : ''), on: false },
    { key: 'pegFree', label: 'PEG-free', get: (r) => (r.pegFree == null ? '' : r.pegFree ? 'yes' : 'no'), on: false },
    { key: 'frr', label: 'FRR', get: n('frr', 2), num: true, on: true },
    { key: 'tfr', label: 'TFR', get: n('tfr', 1), num: true, on: true },
    { key: 'np', label: 'N/P', get: n('np', 2), num: true, on: false },
    { key: 'bufferSystem', label: 'Buffer', get: (r) => r.bufferSystem || '', on: true },
    { key: 'loadingPH', label: 'pH', get: n('loadingPH', 2), num: true, on: true },
    { key: 'mixerType', label: 'Mixer', get: (r) => r.mixerType || '', on: true },
    { key: 'postMethod', label: 'Downstream', get: (r) => r.postMethod || '', on: false },
    { key: 'rnaType', label: 'Cargo', get: (r) => r.rnaType || '', on: false },
    { key: 'size', label: 'Size nm', get: n('size', 1), num: true, on: true },
    { key: 'pdi', label: 'PDI', get: n('pdi', 3), num: true, on: true },
    { key: 'ee', label: 'EE %', get: n('ee', 1), num: true, on: true },
    { key: 'zeta', label: 'Zeta mV', get: n('zeta', 1), num: true, on: false },
    { key: 'operator', label: 'Operator', get: (r) => r.operators.join(', '), on: false },
    { key: 'source', label: 'Source', get: (r) => (r.sources || [r.source]).map((x) => SOURCE[x] || x).join('; '), on: false },
    { key: 'importId', label: 'Import', get: (r) => r.importId || '', on: false },
    // The rest of the provenance (spec 5.3: the export carries it whole): the file, sheet and row the record was
    // read from, and the instrument files its results came from.
    { key: 'file', label: 'Source file', get: (r) => r.file || '', on: false },
    { key: 'sha256', label: 'SHA-256', get: (r) => r.sha256 || '', on: false },
    { key: 'sheet', label: 'Sheet', get: (r) => r.sheet ?? '', on: false },
    { key: 'sourceRow', label: 'Row', get: (r) => r.sourceRow ?? '', on: false },
    { key: 'resultFiles', label: 'Result files', get: (r) => (r.resultFiles || []).map((f) => f.name).join('; '), on: false },
    { key: 'resultSha256', label: 'Result files SHA-256', get: (r) => (r.resultFiles || []).map((f) => f.sha256 || '').join('; '), on: false },
  ];
}

/** Sort rows by a column; missing values last whichever way. Stable. */
// One collator for every sort: localeCompare with options builds one per call, which made sorting 10,000 rows by
// date take a third of a second on its own (spec 5.4 allows 200 ms for the whole filter).
const collator = new Intl.Collator(undefined, { numeric: true });
export function sortRows(rows, col, dir = 1) {
  // Each row's cell is read once, not once per comparison.
  return rows.map((r, i) => { const x = col.get(r); return [r, i, x, x == null || x === '']; }).sort(([, i, x, ex], [, j, y, ey]) => {
    if (ex !== ey) return ex ? 1 : -1;
    if (ex) return i - j;
    const c = col.num ? x - y : collator.compare(String(x), String(y));
    return c ? c * dir : i - j;
  }).map(([r]) => r);
}

/** The selection as CSV, with every column (not only the shown ones) and the provenance. */
export function toCsv(rows, cols) {
  const cell = (v) => { const s = v == null ? '' : String(v); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map((c) => cell(c.label)).join(','), ...rows.map((r) => cols.map((c) => cell(c.get(r))).join(','))].join('\n');
}

/**
 * The formulations a free-text query names, through the app's search index (app/calc/search.js): a formulation
 * hit is itself, an experiment its formulations, a sample its formulation, a composition, stock, RNA lot or
 * buffer lot every formulation made with it. Also the formulation's own label. Returns a Set of ids, or null for
 * an empty query.
 */
export function textMatches(query, rows, index, { tokens, scoreEntry }) {
  const q = tokens(query || '');
  if (!q.length) return null;
  const hits = new Set();
  const byExp = new Map(), byComp = new Map(), byStock = new Map(), byRna = new Map(), byName = new Map();
  const push = (m, k, id) => { if (k == null || k === '') return; const key = String(k); if (!m.has(key)) m.set(key, []); m.get(key).push(id); };
  for (const r of rows) { push(byExp, r.experimentId, r.id); push(byComp, r.compositionId, r.id); push(byStock, r.stockId, r.id); push(byRna, r.rnaLot, r.id); for (const n of r.names || []) push(byName, n, r.id); }
  const addAll = (ids) => { for (const id of ids || []) hits.add(id); };
  for (const e of index) {
    if (!scoreEntry(e, q).score) continue;
    if (e.kind === 'formulation') hits.add(e.id);
    else if (e.kind === 'experiment') addAll(byExp.get(e.id));
    else if (e.kind === 'sample') { const m = /^(E\d+-F\d+)/.exec(e.id); if (m) hits.add(m[1]); }
    else if (e.kind === 'composition') addAll(byComp.get(e.id));
    else if (e.kind === 'stock') addAll(byStock.get(e.id));
    else if (e.kind === 'rna') addAll(byRna.get(e.id));
    else if (e.kind === 'buffer') { addAll(byName.get(e.id)); const lot = /^(\S+)/.exec(e.title || '')?.[1]; if (lot) addAll(byName.get(lot)); }
  }
  const words = q.join(' ');
  for (const r of rows) if (r.label && tokens(r.label).join(' ').includes(words)) hits.add(r.id);
  return hits;
}
