// One description of the design table, used by the screen and by all three exports.
//
// The point of putting it here rather than building the table inside the screen is that what you read and
// what you export cannot drift apart. A CSV that has different columns from the table above it is a quiet
// way to lose an afternoon, and it is exactly what happens when two pieces of code each decide for
// themselves what a run looks like.
//
// The shape follows how a run plan is read at a bench: one row per run, labelled with its id and what kind
// of point it is, then one column per factor with the name and its unit stacked in the header so the column
// stays narrow enough to scan down.
import { isCategorical, categoricalName } from './doe.js';

/** A number as short as it can be without losing anything: 2, 28.5, 0.075. */
export function num(v, step) {
  if (!Number.isFinite(v)) return '';
  // The step the factor is set in decides how many decimals are meaningful; without one, four is plenty and
  // trailing zeros come off anyway.
  const dp = step ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(step)) + 1)) : 4;
  const s = Number(v).toFixed(dp);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

const POINT_LABEL = { factorial: 'factorial', center: 'center', axial: 'axial', edge: 'edge', vertex: 'vertex', interior: 'interior', centroid: 'centroid', pure: 'pure', binary: 'binary', ternary: 'ternary', blend: 'blend' };

/**
 * @param {object} spec    the DoE spec: factors [{name, unit, low, high, center}], designType, responses
 * @param {Array} runs     what buildDesign produced, optionally with run_order, well and batchId attached
 * @param {object} [o]
 * @param {object} [o.batches]   {batchId: batchRecord} to fill the lot and date columns
 * @param {object} [o.values]    {run_id: {responseName: value}} to fill the measured columns
 * @param {Array}  [o.responses] [{name, label, unit}] which measured columns to include
 * @param {'std'|'run'} [o.order] standard order, as the design is built, or the randomised order it is run in
 * @param {boolean} [o.full]     include lot, date, status and measured values; false gives the plain design
 * @param {object} [o.balance]   the lipid that keeps each run at 100 mol% when the design varies a lipid class,
 *                               as composition.js balanceColumn gives it: {label, sub, values: {run_id: mol%}}
 * @param {Function} [o.label]   a process factor's column heading; its name unless given (the screen and the
 *                               report pass the lab's words for it, doe.js factorLabel)
 * @returns {{columns: Array, rows: Array<Array<string>>, meta: object}}
 */
export function designTableModel(spec, runs, o = {}) {
  const { batches = {}, values = null, responses = [], order = 'std', full = false, balance = null, label = (f) => f.name } = o;
  // A mixture design's columns are its lipids; a crossed design has both. Reading them off the spec the same
  // way the exports do is what keeps the table and the CSV from disagreeing.
  const mix = spec.mode && spec.mode !== 'process' ? (spec.components || []).map((c) => ({ name: c.name || c.key, unit: 'mol%', low: c.lo, high: c.hi })) : [];
  const factors = [...mix, ...(spec.mode === 'mixture' ? [] : spec.factors || [])];
  const stepOf = (f) => {
    const span = Math.abs(Number(f.high) - Number(f.low));
    return span > 0 ? span / 1000 : null;
  };

  const sorted = [...runs].sort((a, b) => (order === 'run'
    ? (a.run_order ?? a.std_order ?? 0) - (b.run_order ?? b.std_order ?? 0)
    : (a.std_order ?? 0) - (b.std_order ?? 0)));

  const hasOrder = runs.some((r) => r.run_order != null);
  const hasWell = runs.some((r) => r.well);
  const hasBatch = full && runs.some((r) => r.batchId && batches[r.batchId]);
  const hasDate = hasBatch && runs.some((r) => batches[r.batchId]?.plannedDate);

  const columns = [
    { key: 'label', label: 'Label', width: 1.9 },
    ...(hasOrder && order === 'std' ? [{ key: 'run_order', label: 'Run order', right: true, width: 0.8 }] : []),
    ...(hasWell && full ? [{ key: 'well', label: 'Well', width: 0.6 }] : []),
    ...factors.map((f) => {
      const head = mix.includes(f) ? f.name : label(f);
      // "PEG mol%" carries its unit already; a second line of "mol%" under it says nothing
      return { key: f.name, label: head, sub: f.unit && !head.endsWith(f.unit) ? f.unit : '', right: true, width: 1.15, factor: true };
    }),
    // Not a factor: what the sterol has to be for that run's PEG or ionizable setting to total 100. It sits
    // beside the factors because it is weighed out like them, and a table without it hides half the recipe.
    ...(balance ? [{ key: 'balance', label: balance.label, sub: balance.sub || 'mol%', right: true, width: 1.15, derived: true }] : []),
    ...(hasBatch ? [{ key: 'lot', label: 'Lot', width: 1.1 }] : []),
    ...(hasDate ? [{ key: 'planned', label: 'Planned', width: 0.9 }] : []),
    ...(full ? responses.map((r) => ({ key: r.name, label: r.label || r.name, sub: r.unit || '', right: true, width: 0.9, response: true })) : []),
  ];

  const rows = sorted.map((r) => {
    const b = r.batchId ? batches[r.batchId] : null;
    const v = values?.[r.run_id] || {};
    return [
      `${r.run_id} (${POINT_LABEL[r.point_type] || r.point_type})`,
      ...(hasOrder && order === 'std' ? [r.run_order == null ? '' : String(r.run_order)] : []),
      ...(hasWell && full ? [r.well || ''] : []),
      // a mixer is read by its name, not by its −1/+1 code
      ...factors.map((f) => (isCategorical(f) ? categoricalName(f, r.coded?.[f.name] ?? r.real?.[f.name]) : num(r.real?.[f.name], stepOf(f)))),
      ...(balance ? [num(balance.values?.[r.run_id], 0.001)] : []),
      ...(hasBatch ? [b?.id || ''] : []),
      ...(hasDate ? [b?.plannedDate || ''] : []),
      ...(full ? responses.map((x) => num(v[x.name], x.name === 'PDI' ? 0.001 : 0.1)) : []),
    ];
  });

  return {
    columns,
    rows,
    meta: {
      runs: sorted.length,
      factors: factors.length,
      order,
      byType: sorted.reduce((acc, r) => ({ ...acc, [r.point_type]: (acc[r.point_type] || 0) + 1 }), {}),
    },
  };
}

/** The one-line description that goes under the title of an export. */
export function designSubtitle(spec, runs, designName, dateISO) {
  const byType = runs.reduce((acc, r) => ({ ...acc, [r.point_type]: (acc[r.point_type] || 0) + 1 }), {});
  const parts = Object.entries(byType).map(([k, n]) => `${n} ${k}`);
  return [designName, `${runs.length} runs (${parts.join(', ')})`,
    `${(spec.factors || []).length} factors`, dateISO].filter(Boolean).join(' · ');
}
