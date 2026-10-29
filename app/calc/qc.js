// QC rules applied to measurements. Thresholds come from settings.qc; flags are advisory, never blocking.
// A limit that is not a number is off: Settings stores a check switched off as null, and every screen reads it
// so. Compared as it stands, null would be 0, and every result would be flagged "PDI 0.12 > null".
const isSet = (x) => Number.isFinite(x);
export function qcFlags(test, values, qc = {}) {
  const f = [];
  if (!values) return f;
  if (test === 'dls') {
    if (values.pdi != null && isSet(qc.pdiMax) && values.pdi > qc.pdiMax) f.push({ level: 'warn', text: `PDI ${values.pdi.toFixed(2)} > ${qc.pdiMax}` });
    const z = values.zave_nm, lo = isSet(qc.zaveMin), hi = isSet(qc.zaveMax);
    if (z != null && ((lo && z < qc.zaveMin) || (hi && z > qc.zaveMax))) {
      f.push({ level: 'warn', text: lo && hi ? `Z-ave ${z.toFixed(1)} nm outside ${qc.zaveMin}–${qc.zaveMax}` : hi ? `Z-ave ${z.toFixed(1)} nm > ${qc.zaveMax}` : `Z-ave ${z.toFixed(1)} nm < ${qc.zaveMin}` });
    }
    if (values.countRate_kcps != null && isSet(qc.countRateMin) && values.countRate_kcps < qc.countRateMin) f.push({ level: 'warn', text: `count rate ${values.countRate_kcps} kcps low` });
    if (values.runs && values.runs.length >= 2) {
      const z = values.runs.map((r) => r.zave_nm).filter((x) => x != null);
      if (z.length >= 2) { const m = z.reduce((a, b) => a + b, 0) / z.length; const sd = Math.sqrt(z.reduce((a, b) => a + (b - m) ** 2, 0) / (z.length - 1)); if (sd / m > 0.05) f.push({ level: 'info', text: `run-to-run CV ${(100 * sd / m).toFixed(1)} %` }); }
    }
  }
  if (test === 'ee' && values.ee_pct != null && isSet(qc.eeMin) && values.ee_pct < qc.eeMin) f.push({ level: 'warn', text: `EE ${values.ee_pct.toFixed(1)} % < ${qc.eeMin} %` });
  if (test === 'ph' && values.ph != null && (values.ph < 6.8 || values.ph > 7.8)) f.push({ level: 'info', text: `pH ${values.ph} outside 6.8–7.8` });
  if (test === 'osmolality' && values.mOsm_kg != null && (values.mOsm_kg < 250 || values.mOsm_kg > 400)) f.push({ level: 'info', text: `osmolality ${values.mOsm_kg} mOsm/kg outside 250–400` });
  if (test === 'endotoxin' && values.eu_mL != null && values.eu_mL > 5) f.push({ level: 'warn', text: `endotoxin ${values.eu_mL} EU/mL` });
  return f;
}

export const mean = (xs) => { const v = xs.filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
export const sd = (xs) => { const v = xs.filter((x) => x != null && Number.isFinite(x)); if (v.length < 2) return null; const m = mean(v); return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); };

/**
 * What a result physically cannot be, per test and field. These are not quality thresholds (those are settings
 * and only flag): a PDI of 5 or an EE of 925 % is a typing slip, and once stored it is averaged into fits and
 * handed to the optimizer as if someone had measured it. `typical` is where a real value of that field usually
 * lies, and serves only to guess which slip it was. Zeta keeps its sign in that guess; nothing else has one.
 */
const LIMITS = {
  dls: [
    { key: 'zave_nm', label: 'Z-ave', unit: 'nm', min: 0, minOpen: true, max: 10000, typical: [20, 500] },
    { key: 'pdi', label: 'PDI', unit: '', min: 0, max: 1, typical: [0.01, 0.5] },
  ],
  zeta: [{ key: 'zeta_mV', label: 'Zeta', unit: 'mV', min: -200, max: 200, range: '±200', signed: true, typical: [0.5, 60] }],
  ee: [
    { key: 'ee_pct', label: 'EE', unit: '%', min: 0, max: 100, typical: [30, 100] },
    { key: 'total_mg_mL', label: 'Total RNA', unit: 'mg/mL', min: 0 },
    { key: 'free_mg_mL', label: 'Free RNA', unit: 'mg/mL', min: 0 },
  ],
  content: [{ key: 'rna_mg_mL', label: 'RNA content', unit: 'mg/mL', min: 0 }],
  lipid_content: [{ key: 'total_mg_mL', label: 'Total lipid', unit: 'mg/mL', min: 0 }],
  ph: [{ key: 'ph', label: 'pH', unit: '', min: 0, max: 14, typical: [3, 10] }],
  osmolality: [{ key: 'mOsm_kg', label: 'Osmolality', unit: 'mOsm/kg', min: 0 }],
  integrity: [{ key: 'pct', label: 'Integrity', unit: '%', min: 0, max: 100 }],
  endotoxin: [{ key: 'eu_mL', label: 'Endotoxin', unit: 'EU/mL', min: 0 }],
};

// Numbers in a message read as typed: 5 stays "5", and a mean of three runs does not print sixteen digits.
const show = (x) => String(+x.toPrecision(5));

/** The likeliest intended value: the same digits with the decimal point moved left, or the sign dropped. */
function meant(rule, x) {
  if (!rule.typical) return null;
  const [lo, hi] = rule.typical;
  for (let k = 0, v = Math.abs(x); k <= 4; k++, v /= 10) {
    if (v >= lo && v < hi) return (rule.signed && x < 0 ? -1 : 1) * +v.toPrecision(4);
  }
  return null;
}

/** Why x cannot be a value of this field, or null when it can. `guess` adds what was probably meant. */
function refuse(rule, x, guess = true) {
  if (x == null || x === '') return null;
  if (typeof x !== 'number' || !Number.isFinite(x)) return `${rule.label} "${x}" is not a number`;
  const u = rule.unit ? ' ' + rule.unit : '';
  const range = `${rule.range || `${rule.min}–${rule.max}`}${u}`;
  let why = null;
  if (rule.minOpen ? x <= rule.min : x < rule.min) why = rule.max == null ? 'cannot be negative' : rule.minOpen ? `must be above ${rule.min}${u}` : `is outside ${range}`;
  else if (rule.max != null && x > rule.max) why = rule.minOpen ? `is above ${rule.max}${u}` : `is outside ${range}`;
  if (!why) return null;
  const m = guess ? meant(rule, x) : null;
  return `${rule.label} ${show(x)}${u} ${why}${m != null && m !== x ? ` — did you mean ${m}?` : ''}`;
}

// An EE that arrives with its total and free RNA was worked out from them, not typed, so there is no slip of
// the decimal point to guess at: a negative one means the free reading came out above the total.
const typed = (rule, o) => !(rule.key === 'ee_pct' && o?.total_mg_mL != null && o?.free_mg_mL != null);

const CONC_LABEL = { rna_mg_mL: 'RNA content', total_mg_mL: 'Total RNA', free_mg_mL: 'Free RNA' };

/**
 * Values no measurement can have, checked before anything is stored.
 * @returns {{errors: {key, text, run?}[], warnings: {key, text}[]}} errors refuse the result (PDI outside 0–1,
 *   EE outside 0–100 %, Z-ave ≤ 0 or above 10 000 nm, |zeta| above 200 mV, a negative concentration, …);
 *   warnings are probable unit slips worth a second look and refuse nothing. `run` is the 0-based replicate an
 *   error was found in, when it came from `values.runs`.
 */
export function checkValues(test, values) {
  const errors = [], warnings = [];
  if (!values) return { errors, warnings };
  const runs = Array.isArray(values.runs) ? values.runs : [];
  for (const rule of LIMITS[test] || []) {
    const inRuns = [];
    runs.forEach((r, i) => { const why = refuse(rule, r?.[rule.key], typed(rule, r)); if (why) inRuns.push({ key: rule.key, run: i, text: `run ${i + 1}: ${why}` }); });
    errors.push(...inRuns);
    // The mean of runs already refused would only say the same thing again, less precisely.
    const why = inRuns.length ? null : refuse(rule, values[rule.key], typed(rule, values));
    if (why) errors.push({ key: rule.key, text: why });
  }
  if (test === 'ee') {
    const { ee_pct: ee, total_mg_mL: total, free_mg_mL: free } = values;
    if (ee > 0 && ee <= 1) warnings.push({ key: 'ee_pct', text: `EE ${show(ee)} % looks like a fraction — was it ${show(ee * 100)} %?` });
    if (total > 0 && free != null && free > total) warnings.push({ key: 'free_mg_mL', text: `Free RNA ${show(free)} is above total RNA ${show(total)} mg/mL` });
  }
  // An LNP prep carries well under 10 mg/mL of RNA, so a number that size was almost certainly read in µg/mL.
  for (const key of test === 'ee' ? ['total_mg_mL', 'free_mg_mL'] : test === 'content' ? ['rna_mg_mL'] : []) {
    const x = values[key];
    if (Number.isFinite(x) && x > 10) warnings.push({ key, text: `${CONC_LABEL[key]} ${show(x)} mg/mL is more than an LNP carries — was it µg/mL (${show(x / 1000)} mg/mL)?` });
  }
  return { errors, warnings };
}

// Field names a correction can name that are not in LIMITS, as a person would say them.
const FIELD_LABEL = {
  countRate_kcps: 'count rate', attenuator: 'attenuator', temp_c: 'temperature', dispersant: 'dispersant', dilution: 'dilution',
  sd_mV: 'zeta SD', conductivity_mS_cm: 'conductivity', method: 'method', cellLine: 'cell line', rlu: 'RLU',
  pctControl: '% of control', serum: 'serum', viability_pct: 'viability', notes: 'notes', value: 'value',
};
// The spread a test keeps beside the mean of its replicates, and the field it is the spread of.
const SPREAD = { dls: ['zave_sd', 'zave_nm'], ee: ['ee_sd', 'ee_pct'], content: ['rna_sd', 'rna_mg_mL'] };
// A spread is worked out from the runs, never typed, so a correction does not list it as a change of its own.
// (Zeta's SD is typed off the instrument's report, so it is a value like any other.)
const isSpread = (k) => /_sd$/.test(k);

/** Equal as stored values: a field that is absent, undefined or null is the same empty field. */
function same(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => same(a[k] ?? null, b[k] ?? null));
  return a === b;
}

const fieldOf = (test, key) => {
  const rule = (LIMITS[test] || []).find((r) => r.key === key);
  return { label: rule?.label || FIELD_LABEL[key] || key.replace(/_/g, ' '), unit: rule?.unit || '' };
};

/**
 * A stored result corrected. The new values are checked as any entry is (checkValues refuses a PDI of 5 here
 * too), a mean whose runs were edited is worked out again from them, the QC flags follow the new numbers, and the
 * values replaced go into `history` with when, by whom and why. `values` stays the latest, so nothing that reads
 * a result has to know it was ever corrected; the record of why is what deleting and re-entering used to lose.
 *
 * @param {object} m     the stored measurement
 * @param {object} edit  {values, reason, by, at}: the values as edited (runs included), and why
 * @param {object} qc    settings.qc, for the flags
 * @returns {{errors: {key, text, run?}[], warnings: {key, text}[], record: object|null}} record is the
 *   measurement to store, or null when the correction is refused
 */
export function correctResult(m, { values = {}, reason = '', by = '', at = new Date().toISOString() } = {}, qc = {}) {
  const before = m.values || {};
  const next = { ...values };
  if (Array.isArray(next.runs) && !next.runs.length) delete next.runs;
  const sp = SPREAD[m.test];
  if (!same(next.runs ?? [], before.runs ?? [])) {
    // The mean follows its runs: a run corrected by hand beside a mean left as it was would disagree in the record.
    // A field no run has a number for (a PDI typed once beside three sizes, or every run of it cleared) keeps the
    // value it was given, which is what the form showed.
    // Only a field whose runs changed is worked out again: a PDI left alone keeps its stored mean to the last digit
    // rather than coming back from a new sum one rounding step away, and listed as a change nobody made.
    const runs = next.runs || [];
    const col = (rs, k) => rs.map((r) => r?.[k] ?? null);
    const moved = (k) => !same(col(runs, k), col(before.runs || [], k));
    for (const k of new Set(runs.flatMap((r) => Object.keys(r || {})))) {
      const x = moved(k) ? mean(runs.map((r) => r[k])) : null;
      if (x != null) next[k] = x;
    }
    if (sp && moved(sp[1])) { const s = sd(runs.map((r) => r[sp[1]])); if (s != null) next[sp[0]] = s; else delete next[sp[0]]; }
  }
  const errors = [], warnings = [];
  const why = String(reason ?? '').trim();
  if (!why) errors.push({ key: 'reason', text: 'Say why it is corrected (a typo, re-measured …): the record keeps the reason beside the old values.' });
  if (same(next, before)) errors.push({ key: null, text: 'Nothing was changed.' });
  else if (!Object.keys(next).some((k) => k !== 'runs' && !isSpread(k) && next[k] != null && next[k] !== '')) errors.push({ key: null, text: 'A result needs at least one value; to take it out altogether, delete it.' });
  const check = checkValues(m.test, next);
  errors.push(...check.errors); warnings.push(...check.warnings);
  if (errors.length) return { errors, warnings, record: null };
  const record = { ...m, values: next, flags: qcFlags(m.test, next, qc), history: [...(m.history || []), { at, by, reason: why, values: before }] };
  return { errors, warnings, record };
}

/**
 * What a correction changed, field by field, with the value before and after. Runs are listed one by one only
 * when there was more than one: a single run is the value itself, and "PDI 0.5, run 1 PDI 0.5" says it twice.
 * @returns {{key, label, unit, run?: number, before, after}[]}
 */
export function correctionChanges(test, before = {}, after = {}) {
  const out = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === 'runs' || isSpread(k) || same(before[k] ?? null, after[k] ?? null)) continue;
    out.push({ key: k, ...fieldOf(test, k), before: before[k] ?? null, after: after[k] ?? null });
  }
  const a = before.runs || [], b = after.runs || [];
  if (a.length > 1 || b.length > 1) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      for (const k of new Set([...Object.keys(a[i] || {}), ...Object.keys(b[i] || {})])) {
        if (!same(a[i]?.[k] ?? null, b[i]?.[k] ?? null)) out.push({ key: k, run: i, ...fieldOf(test, k), before: a[i]?.[k] ?? null, after: b[i]?.[k] ?? null });
      }
    }
  }
  return out;
}

/** "PDI 0.5" or "Z-ave 812 nm, run 2 PDI 0.5": what a correction replaced, as the record read before it. */
export function describeCorrection(test, before, after) {
  return correctionChanges(test, before, after).map((c) => {
    const was = c.before == null || c.before === '' ? 'empty' : typeof c.before === 'number' ? `${show(c.before)}${c.unit ? ' ' + c.unit : ''}` : `"${c.before}"`;
    return `${c.run != null ? `run ${c.run + 1} ` : ''}${c.label} ${was}`;
  }).join(', ');
}
