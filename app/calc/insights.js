// What the Insights screen found, in up to three plain sentences: the strongest difference between the groups
// the chart is coloured by, whether the latest batches drift, and how many points sit outside the control
// limits. The screen used to open on its filters and a chart and leave the reader to find the lot effect in a
// table underneath; this is the sentence that table was implying.
//
// Groups are compared only at matched settings (usability cycle 6, I1). A lab's batches are mostly designed
// experiments, which change FRR, flow and PEG on purpose, so the scatter of every batch in view is mostly the
// design: in the session's lab it was 14.4 nm against a true batch-to-batch noise of 2.5 nm, and a real +4 nm
// stock-lot shift read "within the noise". So a lot is compared with another only on batches made at the same
// recorded settings, and judged against the scatter between batches made the same way.
import { mean, sd, controlLimits, welchTest, anovaOneWay, linearFit, tTestP, pearson } from './stats.js';
import { tCritical } from './diagnostics.js';

/** How each response is spoken of: its noun, the unit a difference is quoted in, its decimals, and its directions. */
export const RESPONSE_WORDS = {
  zave_nm: { noun: 'size', unit: ' nm', dp: 1, lead: 'are', up: 'larger', down: 'smaller', test: 'dls' },
  pdi: { noun: 'PDI', unit: '', dp: 3, lead: 'have a PDI', up: 'higher', down: 'lower', test: 'dls' },
  // a difference of two percentages is in percentage points; "3 % higher" would read as relative
  ee_pct: { noun: 'EE', unit: ' points', dp: 1, lead: 'have an EE', up: 'higher', down: 'lower', test: 'ee' },
  zeta_mV: { noun: 'zeta potential', unit: ' mV', dp: 1, lead: 'have a zeta potential', up: 'higher', down: 'lower', test: 'zeta' },
};

/** What the colour-by groups are called, one and several, and how one group's value is written. */
export const GROUP_WORDS = {
  stockId: { one: 'stock lot', many: 'stock lots' },
  operator: { one: 'operator', many: 'operators' },
  experimentId: { one: 'experiment', many: 'experiments' },
  compositionId: { one: 'composition', many: 'compositions', name: (g) => `#${g}` },
  experimentType: { one: 'experiment type', many: 'experiment types' },
};

const fixed = (x, dp) => { const s = Number(x).toFixed(dp); return /^-0\.?0*$/.test(s) ? s.slice(1) : s; };
// "an operator", "an EE", "a PDI": by the first letter, which is right for every noun used here
const an = (w) => `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : w.endsWith('ch') ? 'es' : 's'}`;

/* ---------------- the setting a batch was made at ---------------- */

// Number(null) is 0, so a value is a number only when something was recorded.
const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));
// Six significant figures: enough to tell any two settings a pump can hold apart, few enough that 3 and
// 2.9999999999 are one setting.
const num = (v) => String(Number(Number(v).toPrecision(6)));
const CLASSES = ['ionizable', 'helper', 'sterol', 'peg', 'other'];

/** A composition override in words: the blend a mixture run names, or the class mol% a factor set. */
function changeText(ov) {
  if (!ov) return '';
  if (ov.mol_pct && Object.keys(ov.mol_pct).length) {
    const parts = Object.entries(ov.mol_pct).filter(([, v]) => isNum(v)).sort(([a], [b]) => a.localeCompare(b));
    return parts.length ? `${parts.map(([k, v]) => `${k} ${num(v)}`).join(' / ')} mol%` : '';
  }
  const parts = CLASSES.map((cls) => [cls, isNum(ov[cls]) ? ov[cls] : isNum(ov[`${cls}_pct`]) ? ov[`${cls}_pct`] : null]).filter(([, v]) => v != null);
  return parts.length ? `${parts.map(([cls, v]) => `${cls === 'peg' ? 'PEG' : cls} ${num(v)}`).join(', ')} mol%` : '';
}

/** "T14 25C" for a stability pull; nothing for the fresh product (the final stage, or day 0). */
const stageText = (m) => (!m?.stage || m.stage === 'final' || m.stage === 'T0' ? '' : `${m.stage}${m.condition ? ` ${m.condition}` : ''}`);

/**
 * What a batch's record says was set: the recipe, any change a design or the optimizer made to it, and the
 * process. Two batches with the same setting were made the same way on purpose, so what still differs between
 * them is the batch-to-batch noise, a lot, an operator or a day.
 *
 * Left out on purpose: the lipid stock's concentration, unless the experiment varied it. Choosing a stock lot on
 * a record writes that lot's own measured molarity into the plan, so two lots made to the same recipe never read
 * exactly alike, and a lot would never match another. A stability pull is part of the setting: the result of a
 * sample stored four weeks at 25 °C is not a repeat of the fresh product.
 *
 * @param {object} b      the batch (formulation) record
 * @param {object} [exp]  its experiment, for the factors a design records without applying them
 * @param {object} [results] {dls, ee, zeta}: the measurement each response is read from
 * @returns {{recipe: string, change: string, process: string, stage: {dls, ee, zeta}}}
 */
export function batchSetting(b, exp = null, results = {}) {
  const plan = b?.plan || {}, mix = plan.mixing || {}, rna = plan.rna || {};
  const doeFactors = exp?.design?.doe?.spec?.factors || [];
  const lipidVaried = exp?.design?.factor === 'lipid_mM' || doeFactors.some((f) => f.applyTo === 'lipid_mM') || isNum(plan.factors?.lipid_mM);
  // The mixer, by name, where the experiment varied it (an OFAT over mixers, a design with a mixer factor):
  // two batches on different mixers are not repeats of one setting. Named from what the experiment stored.
  const mixF = doeFactors.find((f) => f.applyTo === 'mixer' && Array.isArray(f.levels));
  const mixerId = (exp?.design?.factor === 'mixer' || mixF) ? plan.process?.mixerId ?? plan.factors?.mixer : null;
  const mixerName = mixerId == null ? null
    : exp?.design?.labels?.[mixerId] || (mixF ? mixF.levelNames?.[mixF.levels.indexOf(mixerId)] : null) || String(mixerId);
  const process = [
    ['FRR', mix.frr], ['flow', mix.totalFlow, 'mL/min'], ['N/P', rna.np], ['quench', mix.quenchFactor], ['RNA', rna.working_mg_mL, 'mg/mL'],
    ...(lipidVaried ? [['lipid', mix.lipidStock_mM, 'mM']] : []),
    // a factor recorded but not applied to the plan (a temperature, a pH) is a setting all the same
    ...doeFactors.filter((f) => !f.applyTo && f.name).map((f) => [f.name, plan.factors?.[f.name], f.unit]),
  ].filter(([, v]) => isNum(v)).map(([k, v, u]) => `${k} ${num(v)}${u ? ` ${u}` : ''}`);
  return {
    recipe: b?.compositionId != null ? `#${b.compositionId}` : '',
    change: changeText(plan.compositionOverride),
    process: [...(mixerName ? [`mixer ${mixerName}`] : []), ...process].join(' · '),
    stage: { dls: stageText(results.dls), ee: stageText(results.ee), zeta: stageText(results.zeta) },
  };
}

/**
 * The setting as a key, and as the words the screen shows: "#1 with PEG 1.75 mol% · FRR 3 · flow 90 mL/min".
 * Compared by composition, the composition is the group, so only what was done to it and the process count;
 * the response decides which measurement's stability pull is part of it.
 */
export function settingKey(setting, { colorBy = null, response = 'zave_nm' } = {}) {
  if (!setting) return null;
  const test = RESPONSE_WORDS[response]?.test || 'dls';
  const recipe = colorBy === 'compositionId'
    ? (setting.change ? `with ${setting.change}` : '')
    : `${setting.recipe}${setting.change ? ` with ${setting.change}` : ''}`;
  return [recipe, setting.process, setting.stage?.[test]].filter(Boolean).join(' · ');
}

/**
 * The settings made more than once among the rows: the batches a control chart can put on one set of limits,
 * since their scatter is batch-to-batch and not the design's. First the settings a reference experiment made
 * (that type is the lab's own repeat, "feeds the control chart"), then the most-run, then the most recent; the
 * centre points of one design are repeats too, but of one day.
 * @returns {Array<{key, n, rows, reference}>}
 */
export function repeatedSettings(rows, response) {
  const by = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r[response])) continue;
    const k = settingKey(r.setting, { response });
    if (!k) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const last = (rs) => rs.reduce((m, r) => ((r.date || '') > m ? r.date || '' : m), '');
  return [...by].filter(([, rs]) => rs.length >= 2)
    .map(([key, rs]) => ({ key, n: rs.length, rows: rs, last: last(rs), reference: rs.some((r) => r.experimentType === 'reference') }))
    .sort((a, b) => b.reference - a.reference || b.n - a.n || b.last.localeCompare(a.last));
}

/* ---------------- groups compared at matched settings ---------------- */

/**
 * The clearest difference between two groups (stock lots, operators …) among batches made at the same settings.
 *
 * Batches are put in cells by setting and group. Two groups are compared only within the settings both ran: at
 * each such setting the difference of their means, weighted by n_a·n_b/(n_a + n_b), which is the least-squares
 * estimate of a constant group effect with the setting as a block. Its standard error comes from the
 * batch-to-batch SD, pooled within every cell in view that has two batches or more: the scatter between batches
 * made the same way, by the same group. The design's own changes enter neither the difference nor the SD.
 *
 * With more than two groups, the pair whose difference is largest against its own error is the one reported,
 * with a Šidák-adjusted interval over all the pairs that could be compared, so picking the most striking pair
 * does not make it look surer than it is.
 *
 * Verdicts: 'clear' when the 95 % interval excludes zero; 'noise' when the whole interval lies within one
 * batch-to-batch SD of zero, so any difference there is smaller than the scatter of one batch; otherwise 'few':
 * more batches at matched settings would be needed to tell. An interval that merely includes zero is not
 * "noise": called so, ten repeats a lot in the simulated lab put a true 4 nm shift down to noise one time in 15.
 * Batches with nothing recorded for the grouping are a mix, not a group, and are left out; so are batches
 * without a recorded setting.
 *
 * @returns {{kind: 'none'|'one'|'unmatched'|'effect', ...}}
 */
export function matchedEffect(rows, response, colorBy, { alpha = 0.05 } = {}) {
  const cells = new Map();   // setting → group → values
  const counts = new Map();  // group → batches in view
  for (const r of rows) {
    const g = r[colorBy], v = r[response];
    if (g == null || g === '' || g === '–' || !Number.isFinite(v)) continue;
    counts.set(g, (counts.get(g) || 0) + 1);
    const k = settingKey(r.setting, { colorBy, response });
    if (!k) continue;
    if (!cells.has(k)) cells.set(k, new Map());
    const at = cells.get(k);
    if (!at.has(g)) at.set(g, []);
    at.get(g).push(v);
  }
  if (!counts.size) return { kind: 'none' };
  const names = [...counts.keys()];
  if (names.length === 1) return { kind: 'one', group: { g: names[0], n: counts.get(names[0]) } };

  // the batch-to-batch SD: scatter within each cell of two batches or more, pooled
  let ss = 0, df = 0, nNoise = 0;
  for (const at of cells.values()) for (const v of at.values()) {
    if (v.length < 2) continue;
    const m = mean(v);
    ss += v.reduce((s, x) => s + (x - m) ** 2, 0); df += v.length - 1; nNoise += v.length;
  }
  // repeats that agree to the last digit are typed copies, not a measure of noise
  const noise = df > 0 && ss > 1e-20 ? Math.sqrt(ss / df) : null;

  // Each setting adds to the pairs of groups it holds, rather than every pair looking through every setting:
  // coloured by experiment, a year of records is hundreds of groups and most never share a setting.
  const order = new Map(names.map((g, i) => [g, i]));
  const acc = new Map();
  for (const at of cells.values()) {
    if (at.size < 2) continue;
    const gs = [...at.keys()].sort((x, y) => order.get(x) - order.get(y));
    for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) {
      const a = gs[i], b = gs[j], A = at.get(a), B = at.get(b);
      const key = `${order.get(a)}|${order.get(b)}`;
      if (!acc.has(key)) acc.set(key, { a, b, W: 0, D: 0, na: 0, nb: 0, k: 0 });
      const p = acc.get(key), w = (A.length * B.length) / (A.length + B.length);
      p.D += w * (mean(B) - mean(A)); p.W += w; p.na += A.length; p.nb += B.length; p.k++;
    }
  }
  const pairs = [...acc.values()].map((p) => ({ ...p, diff: p.D / p.W }));
  if (!pairs.length) return { kind: 'unmatched', groups: names.length, names };
  // |diff|·√W is |t| up to the common SD, so this ranks pairs by their evidence even before there is an SD
  const best = pairs.reduce((x, y) => (Math.abs(y.diff) * Math.sqrt(y.W) > Math.abs(x.diff) * Math.sqrt(x.W) ? y : x));
  const up = best.diff >= 0;
  const hi = up ? { g: best.b, n: best.nb } : { g: best.a, n: best.na };
  const lo = up ? { g: best.a, n: best.na } : { g: best.b, n: best.nb };
  const diff = Math.abs(best.diff);
  const se = noise != null ? noise / Math.sqrt(best.W) : null;
  const level = 1 - (1 - alpha) ** (1 / pairs.length);
  const half = se != null ? tCritical(df, level) * se : null;
  const ci = half != null ? [diff - half, diff + half] : null;
  const verdict = !ci ? 'few' : ci[0] > 0 ? 'clear' : ci[1] < noise ? 'noise' : 'few';
  return { kind: 'effect', hi, lo, diff, se, ci, df, sd: noise, nNoise, settings: best.k, ratio: noise ? diff / noise : null,
    verdict, groups: names.length, pairs: pairs.length };
}

/**
 * Whether the latest `recent` batches have moved away from the ones before them: Welch's t on the two sets, so
 * a shift counts only when it is larger than the scatter of either explains. Needs three batches before the
 * recent ones, or there is no "before" to speak of.
 */
export function drift(values, recent = 5) {
  const v = values.filter(Number.isFinite);
  if (v.length < recent + 3) return { enough: false, need: recent + 3, n: v.length };
  const last = v.slice(-recent), before = v.slice(0, -recent);
  const w = welchTest(last, before);
  return { enough: true, recent, before: before.length, diff: mean(last) - mean(before), p: w?.p ?? null, drifting: !!w && w.p < 0.05 };
}

/**
 * The summary card's sentences: the group comparison over every batch in view, at matched settings, then drift
 * and the control limits over the batches on the chart, which are the batches of one setting unless the user
 * widened it (the screen's "On the chart").
 * @param {object[]} rows  one per batch in view, in time order, with the response, the colour-by field and the
 *   batch's `setting` (batchSetting)
 * @param {object} o
 * @param {string} o.response   'zave_nm' | 'pdi' | 'ee_pct' | 'zeta_mV'
 * @param {string} o.colorBy    the field the chart is coloured by (GROUP_WORDS)
 * @param {object[]} [o.chart]  the batches on the chart, in time order; all the rows when not given
 * @param {object} [o.limits]   the chart's control limits ({lcl, ucl}); worked out from the chart if not given
 * @param {number} [o.recent]   how many of the latest batches are checked for drift
 * @returns {{sentences: string[], n: number, effect: object|null, drift: object|null, outside: object[]|null}}
 */
export function insightSummary(rows, { response = 'zave_nm', colorBy = 'stockId', chart = null, limits = null, recent = 5 } = {}) {
  const R = RESPONSE_WORDS[response] || { noun: response, unit: '', dp: 2, lead: 'have a value', up: 'higher', down: 'lower' };
  const G = GROUP_WORDS[colorBy] || { one: colorBy, many: `${colorBy} groups` };
  const name = (g) => (G.name ? G.name(g) : String(g));
  const pts = rows.filter((r) => Number.isFinite(r[response]));
  const on = (chart || rows).filter((r) => Number.isFinite(r[response]));
  const n = pts.length, nc = on.length;
  // A difference that rounds to nothing at the response's decimals is still quoted, to one significant figure,
  // rather than as "0.000 higher".
  const amount = (x) => { const a = Math.abs(x); return `${a > 0 && Number(fixed(a, R.dp)) === 0 ? String(Number(a.toPrecision(1))) : fixed(a, R.dp)}${R.unit}`; };
  // an interval may start below zero, and a minus sign reads as one only when it is one
  const signed = (x) => { const s = fixed(x, R.dp); return s.startsWith('-') ? `−${s.slice(1)}` : s; };
  if (n < 3) return { sentences: [`Not enough batches to say yet: ${n || 'none'} with ${an(R.noun)} result in this view, and it takes three.`], n, effect: null, drift: null, outside: null };

  const effect = matchedEffect(pts, response, colorBy);
  const d = drift(on.map((r) => r[response]), recent);
  const lim = limits?.ucl != null ? limits : controlLimits(on.map((r) => r[response]));
  const outside = lim.ucl == null ? null : on.filter((r) => r[response] > lim.ucl || r[response] < lim.lcl);
  const s = [];

  if (effect.kind === 'effect') {
    const { hi, lo, ci } = effect;
    const of = effect.groups > 2 ? `Of ${effect.groups} ${G.many}, ` : '';
    const ns = `n ${hi.n} vs ${lo.n}${effect.settings > 1 ? ` over ${effect.settings} settings both ran` : ''}`;
    const interval = ci ? `95 % CI ${signed(ci[0])} to ${signed(ci[1])}${R.unit}` : '';
    const matched = `${of ? `${of}at` : 'At'} the same settings, ${name(hi.g)} batches ${R.lead} ${amount(effect.diff)} ${R.up} than ${name(lo.g)} (${ns}; ${interval})`;
    // Too few at matched settings is said as what there is, so it cannot be read as a finding either way.
    const few = `${of}${name(hi.g)} has ${plural(hi.n, 'batch')} at ${effect.settings === 1 ? 'a setting' : `${effect.settings} settings`} ${name(lo.g)} also ran: ${R.noun} ${amount(effect.diff)} ${R.up} (n ${hi.n} vs ${lo.n}), too few to tell`;
    s.push(effect.verdict === 'clear' ? `${matched}, about ${fixed(effect.ratio, 1)} × the batch-to-batch SD of ${amount(effect.sd)}.`
      : effect.verdict === 'noise' ? `${matched}: within the batch-to-batch noise (SD ${amount(effect.sd)}).`
        : ci ? `${few} (${interval}).`
          : `${few}: no setting was made twice with one ${G.one}, so there is no batch-to-batch SD to judge it by.`);
  } else if (effect.kind === 'unmatched') {
    s.push(effect.groups === 2
      ? `${name(effect.names[0])} and ${name(effect.names[1])} batches were never made at the same settings, so a difference between them cannot be told apart from what their settings do.`
      : `No two of the ${effect.groups} ${G.many} have batches made at the same settings, so a difference between them cannot be told apart from what their settings do.`);
  } else if (effect.kind === 'one') s.push(`All ${effect.group.n} batches share one ${G.one} (${name(effect.group.g)}), so there is no ${G.one} effect to see.`);
  else s.push(`No batch in this view has ${an(G.one)} recorded, so ${G.many} cannot be compared.`);

  s.push(!d.enough ? `Not enough batches on the chart to say whether the latest drift: ${d.n} so far, and it takes ${d.need}.`
    : d.drifting ? `The latest ${d.recent} batches on the chart drift ${d.diff > 0 ? 'up' : 'down'}: ${amount(d.diff)} ${d.diff > 0 ? R.up : R.down} than the ${d.before} before them, more than batch-to-batch scatter explains.`
      : `No drift: the latest ${d.recent} batches on the chart are within ${amount(d.diff)} of the ${d.before} before them.`);

  if (outside) {
    const k = outside.length;
    // "-9.0–2.4" reads as a minus sign stuck to a dash, so a range that starts below zero says "to"
    const range = `${fixed(lim.lcl, R.dp)}${lim.lcl < 0 ? ' to ' : '–'}${fixed(lim.ucl, R.dp)}${R.unit === ' points' ? ' %' : R.unit}`;
    const named = outside.slice(0, 3).map((r) => `${r.batchId} (${fixed(r[response], R.dp)})`).join(', ') + (k > 3 ? ` and ${k - 3} more` : '');
    // At ± 2 SD about one point in twenty lands outside by chance; one such point is not news.
    const chance = k <= Math.max(1, Math.round(nc * 0.05)) ? ', about what chance alone gives at ± 2 SD' : '';
    s.push(k ? `${k} of ${nc} points on the chart ${k === 1 ? 'sits' : 'sit'} outside the control limits (${range})${chance}: ${named}.` : `All ${nc} points on the chart sit inside the control limits (${range}).`);
  }
  return { sentences: s.slice(0, 3), n, effect, drift: d, outside };
}

/* ================ the explorer: any response against any parameter ================ */
//
// The summary above answers one question (is there a lot or operator effect at matched settings). The explorer
// answers the ones a formulator asks next, about whatever they recorded: does EE fall with flow, is size worse
// on Mondays, does one RNA lot run larger, did the new ionizable lot change anything. Each row is one
// formulation, flattened (app/ui/insights.js, flatRows); this part only knows which columns exist, what kind
// each is, and the statistics, so it is tested under node.

/** The responses a row can carry, as the explorer's Y. `key` is the row's field. */
export const RESPONSE_PARAMS = [
  { key: 'zave_nm', label: 'Z-average size', unit: 'nm', kind: 'numeric', role: 'response' },
  { key: 'pdi', label: 'PDI', unit: '', kind: 'numeric', role: 'response' },
  { key: 'ee_pct', label: 'Encapsulation efficiency', unit: '%', kind: 'numeric', role: 'response' },
  { key: 'zeta_mV', label: 'Zeta potential', unit: 'mV', kind: 'numeric', role: 'response' },
  { key: 'rna_content', label: 'RNA content', unit: 'mg/mL', kind: 'numeric', role: 'response' },
  { key: 'size_drift', label: 'Size drift', unit: 'nm per period', kind: 'numeric', role: 'response' },
];

/**
 * The parameters every record has a place for: the process, the recipe, the materials and who and when.
 * Numbers can be an X; categories can be an X (one strip per value) or the colour. Anything else on a record
 * (a cargo, a freeze–thaw count, a mixer set as a factor) is found by discoverFields() below, and the user's
 * own custom parameters are added by the screen, so a new field shows up here without anyone listing it.
 */
export const KNOWN_PARAMS = [
  { key: 'frr', label: 'Flow rate ratio (aq : org)', unit: '', kind: 'numeric' },
  { key: 'tfr', label: 'Total flow rate', unit: 'mL/min', kind: 'numeric' },
  { key: 'np', label: 'N/P ratio', unit: '', kind: 'numeric' },
  { key: 'quench', label: 'Quench factor', unit: '× lipid volume', kind: 'numeric' },
  { key: 'lipid_mM', label: 'Lipid stock concentration', unit: 'mM', kind: 'numeric' },
  { key: 'rna_mg_mL', label: 'RNA working concentration', unit: 'mg/mL', kind: 'numeric' },
  { key: 'rna_mass_mg', label: 'RNA input', unit: 'mg', kind: 'numeric' },
  { key: 'volume_mL', label: 'Volume made (quick)', unit: 'mL', kind: 'numeric' },
  { key: 'ionizable_pct', label: 'Ionizable lipid', unit: 'mol%', kind: 'numeric' },
  { key: 'helper_pct', label: 'Helper lipid', unit: 'mol%', kind: 'numeric' },
  { key: 'sterol_pct', label: 'Cholesterol / sterol', unit: 'mol%', kind: 'numeric' },
  { key: 'peg_pct', label: 'PEG-lipid', unit: 'mol%', kind: 'numeric' },
  { key: 'aq_pH', label: 'Aqueous buffer pH', unit: '', kind: 'numeric' },
  { key: 'aq_ionic', label: 'Aqueous ionic strength', unit: 'mM', kind: 'numeric' },
  { key: 'date', label: 'Date made or measured', unit: '', kind: 'date' },
  { key: 'stockId', label: 'Lipid stock lot', kind: 'category' },
  { key: 'lot_ionizable', label: 'Ionizable lipid lot', kind: 'category' },
  { key: 'lot_helper', label: 'Helper lipid lot', kind: 'category' },
  { key: 'lot_sterol', label: 'Cholesterol lot', kind: 'category' },
  { key: 'lot_peg', label: 'PEG-lipid lot', kind: 'category' },
  { key: 'lipidLots', label: 'Lipid lots (all four)', kind: 'category' },
  { key: 'compositionId', label: 'Composition #', kind: 'category' },
  { key: 'rnaLot', label: 'RNA lot', kind: 'category' },
  { key: 'operator', label: 'Operator', kind: 'category' },
  { key: 'deviceId', label: 'Formulation device', kind: 'category' },
  { key: 'mixerId', label: 'Mixer', kind: 'category' },
  { key: 'aqBuffer', label: 'Aqueous buffer', kind: 'category' },
  { key: 'experimentId', label: 'Experiment', kind: 'category' },
  { key: 'experimentType', label: 'Experiment type', kind: 'category' },
  { key: 'weekday', label: 'Production weekday', kind: 'category' },
  { key: 'status', label: 'Status', kind: 'category' },
];

/**
 * Fields the known parameters already read, by their place on the record, so discoverFields() does not offer
 * them twice under a second name. A DoE or OFAT factor that writes one of the known settings is also left
 * out (its value is already there as FRR, N/P …); `factorNames` names those.
 */
const KNOWN_PATHS = new Set([
  'plan.rna.lotId', 'plan.rna.stock_mg_mL', 'plan.rna.working_mg_mL', 'plan.rna.mass_mg', 'plan.rna.np', 'plan.rna.construct', 'plan.rna.diluent',
  'plan.mixing.frr', 'plan.mixing.quenchFactor', 'plan.mixing.totalFlow', 'plan.mixing.lipidStock_mM', 'plan.mixing.quenchBuffer', 'plan.mixing.mixer',
  'plan.mode', 'plan.volume_mL',
  'id', 'experimentId', 'label', 'compositionId', 'stockId', 'plannedDate', 'status', 'notes', 'updatedAt', 'createdAt', 'producedAt',
]);

/** "freezeThawCycles" → "Freeze thaw cycles", "rna_cargo" → "Rna cargo": a field's name read as words. */
export function humanise(name) {
  const words = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : String(name);
}

/** The value at a dotted path of a record, or undefined. */
export const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/**
 * Every other plain field the formulation records carry, found rather than listed: the scalar fields of the
 * batch, of its plan, and of plan.rna, plan.mixing and plan.factors. A field whose values are all numbers is
 * numeric, one with any text (or true/false) a category. This is how a field another part of the app adds
 * later (a cargo type, a freeze–thaw count, a mixer varied as a factor) reaches Insights without anyone
 * listing it here.
 * @param {object[]} batches
 * @param {object} [o]
 * @param {string[]} [o.factorNames]  factor keys and DoE names already read as known parameters
 * @returns {Array<{key, path, label, kind}>}  key = 'x.' + path
 */
export function discoverFields(batches, { factorNames = [] } = {}) {
  const skipFactor = new Set(factorNames);
  const seen = new Map(); // path → {numbers, other}
  const note = (path, v) => {
    if (v == null || v === '' || typeof v === 'object' || typeof v === 'function') return;
    if (KNOWN_PATHS.has(path)) return;
    if (!seen.has(path)) seen.set(path, { numbers: 0, other: 0 });
    const s = seen.get(path);
    if (typeof v === 'number' && Number.isFinite(v)) s.numbers++; else s.other++;
  };
  for (const b of batches) {
    if (!b) continue;
    for (const [k, v] of Object.entries(b)) note(k, v);
    const plan = b.plan || {};
    for (const [k, v] of Object.entries(plan)) note(`plan.${k}`, v);
    for (const part of ['rna', 'mixing']) for (const [k, v] of Object.entries(plan[part] || {})) note(`plan.${part}.${k}`, v);
    for (const [k, v] of Object.entries(plan.factors || {})) if (!skipFactor.has(k)) note(`plan.factors.${k}`, v);
  }
  return [...seen].map(([path, s]) => ({
    key: `x.${path}`, path, label: humanise(path.split('.').pop()) + (path.startsWith('plan.factors.') ? ' (factor)' : ''),
    kind: s.other ? 'category' : 'numeric',
  })).sort((a, b) => a.label.localeCompare(b.label));
}

/** "Mon" … "Sun" for an ISO date (read as a calendar date, not a moment, so no time zone can shift it). */
export function weekdayOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
}
/** Days since 1970 for an ISO date, so a date can be an axis. */
export function dayNumber(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null;
}

/**
 * Which chart answers "Y against X": a scatter with a trend line for a number, a strip of points per group with
 * mean ± SD for a category, a time series for a date. Chosen, not asked, so the user picks what to look at
 * and never how to draw it.
 */
export function chartKind(xParam) {
  return xParam?.kind === 'date' ? 'time' : xParam?.kind === 'category' ? 'strip' : 'scatter';
}

/**
 * Y against a numeric X: the least-squares line, its slope with a p value (t on n − 2 df, two-sided), and
 * Pearson's r. Null below three points with two distinct x.
 */
export function trend(rows, x, y) {
  const pts = rows.map((r) => [Number(r[x]), Number(r[y])]).filter(([a, b]) => isNum(a) && isNum(b));
  const f = linearFit(pts.map((p) => p[0]), pts.map((p) => p[1]));
  if (!f || pts.length < 3) return null;
  const t = f.seSlope > 0 ? f.slope / f.seSlope : null;
  const { r } = pearson(pts.map((p) => p[0]), pts.map((p) => p[1]));
  return { ...f, r, p: t == null ? (f.r2 === 1 ? 0 : null) : tTestP(t, f.df) };
}

/**
 * Y by group (lot, stock, operator …): mean ± SD and n per group, each group's difference from all the
 * others together with Welch's t for that difference, and one test across the groups: Welch's t for two,
 * one-way ANOVA for more. Rows without the group or the value are left out; a group of one batch is listed
 * but cannot be tested. Groups are in order of their first appearance unless `order` is given.
 *
 * These comparisons are over every batch in view, whatever its settings: a lot used only for a screen's
 * corners will differ for that reason alone. The summary sentence at the top compares at matched settings,
 * and the screen says so beside this table.
 * @returns {{groups: Array<{g, n, mean, sd, diff, p}>, test: {kind, p, F?, t?, df?}|null, n}}
 */
export function groupCompare(rows, y, g, { order = null } = {}) {
  const by = new Map();
  for (const r of rows) {
    const k = r[g], v = Number(r[y]);
    if (k == null || k === '' || !isNum(r[y])) continue;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(v);
  }
  const keys = order ? order.filter((k) => by.has(k)) : [...by.keys()];
  const all = keys.flatMap((k) => by.get(k));
  const groups = keys.map((k) => {
    const v = by.get(k), rest = keys.filter((o) => o !== k).flatMap((o) => by.get(o));
    const w = rest.length ? welchTest(v, rest) : null;
    return { g: k, n: v.length, mean: mean(v), sd: sd(v), diff: rest.length ? mean(v) - mean(rest) : null, p: w?.p ?? null };
  });
  let test = null;
  if (keys.length === 2) {
    const w = welchTest(by.get(keys[0]), by.get(keys[1]));
    if (w) test = { kind: 'welch', p: w.p, t: w.t, df: w.df };
  } else if (keys.length > 2) {
    const a = anovaOneWay(keys.map((k) => by.get(k)));
    if (a) test = { kind: 'anova', p: a.p, F: a.F, df: [a.df1, a.df2] };
  }
  return { groups, test, n: all.length };
}

/**
 * Pearson r of every numeric parameter against every response, over the rows that have both. A pair with
 * fewer than `min` such rows, or no spread in either, has r null and is drawn empty.
 * @returns {Array<{x, y, r, n}>}
 */
export function correlationMatrix(rows, xKeys, yKeys, { min = 3 } = {}) {
  const out = [];
  for (const x of xKeys) for (const y of yKeys) {
    const xs = rows.map((r) => (isNum(r[x]) ? Number(r[x]) : null)), ys = rows.map((r) => (isNum(r[y]) ? Number(r[y]) : null));
    const { r, n } = pearson(xs, ys);
    out.push({ x, y, r: n >= min ? r : null, n });
  }
  return out;
}

/** The QC limits in Settings that apply to a response, as specification limits; null when none is on. */
export function qcLimits(key, qc = {}) {
  const v = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
  const lim = key === 'zave_nm' ? { lsl: v(qc.zaveMin), usl: v(qc.zaveMax) }
    : key === 'pdi' ? { lsl: null, usl: v(qc.pdiMax) }
      : key === 'ee_pct' ? { lsl: v(qc.eeMin), usl: null } : { lsl: null, usl: null };
  return lim.lsl == null && lim.usl == null ? null : lim;
}

/**
 * Process capability against the QC limits: how many standard deviations of batch-to-batch scatter fit between
 * the mean and the nearer limit, over three. Cpk ≥ 1.33 is the usual "capable", 1 means about 0.3 % of batches
 * outside a limit if the scatter is normal, below 1 means batches outside the limits are to be expected.
 * One-sided limits (PDI only has a maximum) give Cpk from that side; Cp needs both.
 * @returns {{n, mean, sd, cp, cpk, cpl, cpu, outside, verdict}|null}  null below 3 values or with no spread
 */
export function capability(values, { lsl = null, usl = null } = {}) {
  const v = values.map(Number).filter(Number.isFinite);
  if (v.length < 3 || (lsl == null && usl == null)) return null;
  const m = mean(v), s = sd(v);
  if (!(s > 0)) return null;
  const cpl = lsl != null ? (m - lsl) / (3 * s) : null, cpu = usl != null ? (usl - m) / (3 * s) : null;
  const cpk = Math.min(...[cpl, cpu].filter((x) => x != null));
  const cp = lsl != null && usl != null ? (usl - lsl) / (6 * s) : null;
  const outside = v.filter((x) => (lsl != null && x < lsl) || (usl != null && x > usl)).length;
  const verdict = cpk >= 1.33 ? 'capable' : cpk >= 1 ? 'marginal' : 'not capable';
  return { n: v.length, mean: m, sd: s, cp, cpk, cpl, cpu, outside, verdict };
}
