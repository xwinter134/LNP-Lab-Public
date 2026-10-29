// The results of one experiment, read the way a lab reads them in GraphPad: a data table first (one row per
// formulation, or per formulation × storage condition × day in a stability study, one column per response),
// then the statistics the experiment type asks for. Pure: the Experiments screen hands in the records and
// draws what comes back, and the sentences are built here so the wording is tested with the numbers.
//
// Two kinds of replicate meet on this page and they must not be confused. The instrument's repeat runs on one
// sample (`values.runs` of a DLS result) are technical replicates: they say how precisely that one batch was
// measured. Separate batches of the same recipe are the replicates that say whether a recipe is reproducible.
// Every mean ± SD below says which of the two it is, and a p value between arms is only ever computed from
// the second kind: runs on one sample would make any two batches look different.
//
// A stability study is read for one number above all: how fast each formulation drifts on each shelf, and
// when, at that rate, it leaves the QC limits. That is a least-squares slope with its confidence interval,
// and the day its line crosses the limit.
import { mean, sd, linearFit, welchTest, anovaOneWay, pairwiseAfterAnova } from './stats.js';
import { tCritical } from './diagnostics.js';
import { FACTORS, isCategoricalFactor, levelText } from './experiment.js';
import { parseSampleName } from '../schema.js';
import { groupBy } from './indexes.js';

/** The responses an experiment page summarises, in column order. `field` is the key in a measurement's values. */
export const RESULT_RESPONSES = [
  { key: 'zave', test: 'dls', field: 'zave_nm', label: 'Z-ave', unit: 'nm', dp: 1 },
  { key: 'pdi', test: 'dls', field: 'pdi', label: 'PDI', unit: '', dp: 3 },
  // EE is itself a percentage, so a difference in it is in percentage points, not a percent of a percent.
  { key: 'ee', test: 'ee', field: 'ee_pct', label: 'EE', unit: '%', dp: 1, points: true },
  // Zeta potential sits either side of zero, so a CV of it is an artefact of how close to zero it is: none given.
  { key: 'zeta', test: 'zeta', field: 'zeta_mV', label: 'Zeta', unit: 'mV', dp: 1, noCv: true },
  { key: 'content', test: 'content', field: 'rna_mg_mL', label: 'RNA content', unit: 'mg/mL', dp: 3 },
];
export const responseByKey = Object.fromEntries(RESULT_RESPONSES.map((r) => [r.key, r]));

const num = (v) => (v === '' || v == null ? NaN : Number(v));
const finite = (v) => Number.isFinite(v);

/**
 * mean, SD, n and CV % of a list of numbers. SD and CV need two values; CV is undefined around a zero mean,
 * and is left out for a response (`resp.noCv`) whose zero is not the bottom of its scale.
 */
export function describe(values, resp = null) {
  const v = values.filter(finite);
  const m = mean(v), s = sd(v);
  return { mean: m, sd: s, n: v.length, cv: s != null && m && !resp?.noCv ? (100 * s) / Math.abs(m) : null, points: v };
}

/**
 * One response of one measurement. With replicate runs the cell is their mean ± SD; without, it is the stored
 * value with n = 1. The runs win over a stored mean because the mean of the runs is what the SD belongs to.
 */
export function cellOf(m, resp) {
  if (!m) return null;
  const v = m.values || {};
  const runs = Array.isArray(v.runs) ? v.runs.map((r) => num(r?.[resp.field])).filter(finite) : [];
  const pts = runs.length ? runs : [num(v[resp.field])].filter(finite);
  if (!pts.length) return null;
  return { ...describe(pts, resp), basis: runs.length ? 'runs' : 'single', measurementId: m.id ?? null, stage: m.stage || '' };
}

/** Newest first, by measurement date and then by when it was stored: a re-import adds a record, never edits one. */
const newestFirst = (a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

/**
 * Where a measurement sits in a stability study. The slot it was matched to is the authority; a result that
 * reached its formulation without a slot (an import whose slot was never generated) still names its
 * condition and day in the sample name, E6-F1_4C_T09, so it is read from there rather than dropped.
 */
export function whereOf(m, slotsById = {}) {
  const slot = m.slotId ? slotsById[m.slotId] : null;
  let timepoint = finite(num(m.timepoint)) ? num(m.timepoint) : finite(num(slot?.timepoint)) ? num(slot.timepoint) : null;
  let condition = m.condition || slot?.condition || '';
  const parsed = m.sampleName ? parseSampleName(m.sampleName) : null;
  if (timepoint == null) {
    const t = /^T(\d+)$/i.exec(m.stage || '');
    if (t) timepoint = Number(t[1]);
    else if (parsed && finite(parsed.timepoint)) timepoint = parsed.timepoint;
  }
  if (!condition && parsed?.condition) condition = parsed.condition;
  return { timepoint, condition };
}

/** The latest result of one test among one formulation's records, preferring the final product over an in-process sample. */
function latestFinal(own, test) {
  const mine = own.filter((m) => m.test === test).sort(newestFirst);
  return mine.find((m) => !m.stage || m.stage === 'final') || mine[0] || null;
}

// Each formulation reads its own records out of `byBatch` (its measurements, grouped once in
// experimentResults) rather than filtering the experiment's for every row.
function batchRows(exp, batches, byBatch, slotsById) {
  const factor = exp.type === 'ofat' ? exp.design?.factor : null;
  return batches.map((b) => {
    // A result taken during storage belongs to the stability table, not to the formulation's release values.
    const release = (byBatch.get(b.id) || []).filter((m) => whereOf(m, slotsById).timepoint == null);
    const cells = {};
    for (const r of RESULT_RESPONSES) cells[r.key] = cellOf(latestFinal(release, r.test), r);
    // A mixer level is a mixer id and stays one; `levelText` is its name for the table and the sentences.
    if (factor != null && isCategoricalFactor(factor)) {
      const id = b.plan?.factors?.[factor];
      return { batchId: b.id, label: b.label || '', compositionId: b.compositionId ?? null, level: id ?? null, levelText: id == null ? null : levelText(factor, id, exp.design?.labels), cells };
    }
    const level = factor != null ? num(b.plan?.factors?.[factor]) : NaN;
    return { batchId: b.id, label: b.label || '', compositionId: b.compositionId ?? null, level: finite(level) ? level : null, cells };
  });
}

function stabilityRows(exp, batches, byBatch, slotsById) {
  const st = exp.design?.stability || {};
  const rows = [];
  for (const b of batches) {
    const own = (byBatch.get(b.id) || []).map((m) => ({ m, w: whereOf(m, slotsById) })).filter((x) => x.w.timepoint != null);
    // The planned grid, plus anything measured off it: a sample pulled on an extra day is still data.
    const conditions = [...new Set([...(st.conditions || []), ...own.map((x) => x.w.condition).filter(Boolean)])];
    for (const c of conditions) {
      const here = own.filter((x) => x.w.condition === c);
      const days = [...new Set([...(st.timepoints || []), ...here.map((x) => x.w.timepoint)])].sort((a, z) => a - z);
      for (const t of days) {
        const at = here.filter((x) => x.w.timepoint === t).map((x) => x.m).sort(newestFirst);
        const cells = {};
        for (const r of RESULT_RESPONSES) cells[r.key] = cellOf(at.find((m) => m.test === r.test), r);
        rows.push({ batchId: b.id, label: b.label || '', compositionId: b.compositionId ?? null, condition: c, timepoint: t, cells });
      }
    }
  }
  // Change from T0, per formulation and condition. Day 0 is before storage, so where one shelf's T0 was not
  // measured the formulation's T0 from another shelf is the same sample and serves as the baseline.
  const dayZero = groupBy(rows.filter((x) => x.timepoint === 0), (x) => x.batchId);
  for (const row of rows) {
    row.change = {};
    for (const r of RESULT_RESPONSES) {
      const c = row.cells[r.key];
      if (!c || row.timepoint === 0) continue;
      const t0 = dayZero.get(row.batchId) || [];
      const base = t0.find((x) => x.condition === row.condition && x.cells[r.key])?.cells[r.key]
        || t0.find((x) => x.cells[r.key])?.cells[r.key];
      if (!base) continue;
      const abs = c.mean - base.mean;
      row.change[r.key] = { abs, pct: base.mean ? (100 * abs) / Math.abs(base.mean) : null, base: base.mean };
    }
  }
  return rows;
}

/**
 * Several batches pooled into one group (an arm, a level, the repeats of a reference). One batch: its own
 * runs' mean ± SD, which is a technical SD. Two or more: the mean of the batch means ± their SD, which is the
 * batch-to-batch spread, with n counting batches.
 */
export function groupStats(cells, resp = null) {
  const ok = cells.filter(Boolean);
  if (!ok.length) return null;
  if (ok.length === 1) return { ...ok[0], basis: ok[0].n > 1 ? 'runs' : 'single', batches: 1 };
  return { ...describe(ok.map((c) => c.mean), resp), basis: 'batches', batches: ok.length };
}

/** Pooled within-sample SD of the replicate runs: the measurement's own noise, for comparison with batches. */
export function pooledRunSd(cells) {
  let ss = 0, df = 0, runs = 0, k = 0;
  for (const c of cells) if (c && c.n >= 2 && c.sd != null) { ss += (c.n - 1) * c.sd ** 2; df += c.n - 1; runs += c.n; k++; }
  return df ? { sd: Math.sqrt(ss / df), meanRuns: runs / k } : null;
}

/* ---------- wording ---------- */

const MINUS = '−';
// The sign is decided on the rounded number, so a change too small to show reads "0.000" and not "+0.000".
const f = (x, dp) => (finite(x) ? (Number(x.toFixed(dp)) < 0 ? MINUS : '') + Math.abs(x).toFixed(dp) : '–');
const signed = (x, dp) => { if (!finite(x)) return '–'; const v = Number(x.toFixed(dp)); return (v > 0 ? '+' : v < 0 ? MINUS : '') + Math.abs(x).toFixed(dp); };
const withUnit = (r, s) => (r.unit === '%' ? `${s} %` : r.unit ? `${s} ${r.unit}` : s);
/** "82.8 ± 0.5 nm (CV 0.6 %)" — or just the value when there is nothing to take an SD of. */
function msd(r, s, { cv = true } = {}) {
  if (!s) return '–';
  const core = s.sd != null ? `${f(s.mean, r.dp)} ± ${f(s.sd, r.dp)}` : f(s.mean, r.dp);
  return withUnit(r, core) + (cv && s.cv != null ? ` (CV ${s.cv.toFixed(1)} %)` : '');
}
/** A difference, absolute and relative; EE in percentage points, because a relative change of a % misleads. */
function diffText(r, d) {
  if (!d || !finite(d.abs)) return null;
  if (r.points) return `${r.label} ${signed(d.abs, r.dp)} percentage points`;
  return `${r.label} ${withUnit(r, signed(d.abs, r.dp))}${finite(d.pct) ? ` (${signed(d.pct, 1)} %)` : ''}`;
}
const condName = (c) => String(c || '').replace(/^(-?\d+)C$/i, '$1 °C');
const list = (xs, and = 'and') => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${and} ${xs[xs.length - 1]}`);
/** A p value the way Prism prints it: "= 0.0024", "= 0.015", "= 0.41", and "< 0.0001" below that. */
export const pText = (p) => (!finite(p) ? '= –' : p < 0.0001 ? '< 0.0001' : `= ${p.toFixed(p < 0.01 ? 4 : p < 0.1 ? 3 : 2)}`);
/**
 * Decimals for a slope and its interval: two significant figures of the slope or of the interval's
 * half-width, whichever needs fewer, so a size drift reads "0.48 (0.31–0.65)" and a PDI drift
 * "0.0041 (0.0040–0.0042)", and a slope of nearly nothing is not printed to six places.
 */
const slopeDp = (tr, key) => {
  const dp = (x) => (x > 0 && finite(x) ? 1 - Math.floor(Math.log10(x)) : Infinity);
  const d = Math.min(dp(Math.abs(tr.slope)), tr.ci ? dp((tr.ci[1] - tr.ci[0]) / 2) : Infinity);
  // a slope of exactly nothing, with no interval to go by: the response's own scale
  return finite(d) ? Math.min(6, Math.max(0, d)) : key === 'pdi' ? 4 : 2;
};
/** "0.31–0.65", but "−0.08 to 0.12" once a bound is negative, where a dash would read as a minus sign. */
export const ciText = (ci, dp) => (ci[0] < 0 || ci[1] < 0 ? `${f(ci[0], dp)} to ${f(ci[1], dp)}` : `${f(ci[0], dp)}–${f(ci[1], dp)}`);
/** A projected day is a straight line carried forward, so it is said as roughly as it is known. */
export const aroundDay = (d) => (d < 20 ? Math.round(d) : d < 100 ? 5 * Math.round(d / 5) : d < 1000 ? 10 * Math.round(d / 10) : 100 * Math.round(d / 100));

/** QC limit checks on the release values. Advisory, as everywhere else in the app. */
export function qcIssues(rows, qc) {
  if (!qc) return [];
  const out = [];
  for (const row of rows) {
    const z = row.cells.zave, p = row.cells.pdi, e = row.cells.ee;
    if (z && finite(qc.zaveMax) && z.mean > qc.zaveMax) out.push({ batchId: row.batchId, key: 'zave', text: `${row.batchId} Z-ave ${f(z.mean, 1)} nm (max ${qc.zaveMax})` });
    if (z && finite(qc.zaveMin) && z.mean < qc.zaveMin) out.push({ batchId: row.batchId, key: 'zave', text: `${row.batchId} Z-ave ${f(z.mean, 1)} nm (min ${qc.zaveMin})` });
    if (p && finite(qc.pdiMax) && p.mean > qc.pdiMax) out.push({ batchId: row.batchId, key: 'pdi', text: `${row.batchId} PDI ${f(p.mean, 3)} (max ${qc.pdiMax})` });
    if (e && finite(qc.eeMin) && e.mean < qc.eeMin) out.push({ batchId: row.batchId, key: 'ee', text: `${row.batchId} EE ${f(e.mean, 1)} % (min ${qc.eeMin})` });
  }
  return out;
}

/** Is this cell outside a QC limit? The screen marks the value; same rule as qcIssues. */
export function outsideQc(key, value, qc) {
  if (!qc || !finite(value)) return false;
  if (key === 'zave') return (finite(qc.zaveMax) && value > qc.zaveMax) || (finite(qc.zaveMin) && value < qc.zaveMin);
  if (key === 'pdi') return finite(qc.pdiMax) && value > qc.pdiMax;
  if (key === 'ee') return finite(qc.eeMin) && value < qc.eeMin;
  return false;
}

/**
 * A response's QC limit as set in Settings, "≤ 0.2", "≥ 85 %", "40–150 nm", or null when none is set. Only the
 * limits that are set: a cleared limit in Settings is off, and must not read as "null".
 */
function qcLimit(key, qc) {
  if (!qc) return null;
  const lo = finite(qc.zaveMin), hi = finite(qc.zaveMax);
  if (key === 'zave') return lo && hi ? `${qc.zaveMin}–${qc.zaveMax} nm` : hi ? `≤ ${qc.zaveMax} nm` : lo ? `≥ ${qc.zaveMin} nm` : null;
  if (key === 'pdi') return finite(qc.pdiMax) ? `≤ ${qc.pdiMax}` : null;
  if (key === 'ee') return finite(qc.eeMin) ? `≥ ${qc.eeMin} %` : null;
  return null;
}

function qcSentence(rows, qc, responses) {
  if (!qc) return null;
  const issues = qcIssues(rows, qc);
  if (issues.length) return `Outside the QC limits: ${list(issues.map((i) => i.text))}.`;
  const limits = responses.filter((r) => qcLimit(r.key, qc)).map((r) => `${r.label} ${qcLimit(r.key, qc)}`);
  return limits.length ? `Every measured value is inside the QC limits (${list(limits)}).` : null;
}

const TECHNICAL = 'The ± SD of a single batch is the spread of the instrument’s repeat runs on that one sample (technical replicates): '
  + 'how precisely the batch was measured, not how much another batch of the same recipe would differ. So a difference here is not a test of batch-to-batch difference; '
  + 'for that, make each recipe at least three times and compare the batch means.';

/* ---------- a test between arms ---------- */

/**
 * Welch's t test for two groups, one-way ANOVA with Holm–Šídák pairs for more, on the batch means: only
 * where every group was made and measured at least twice for that response, because a group of one batch
 * has no batch-to-batch spread to test against. Adds its sentences to `out` and returns the tests by
 * response key, or null when no response qualifies (and then the technical-replicate caveat stands).
 * @param groups  [{byResponse: {key: groupStats}}], the first is the reference arm
 * @param name    (group) => what to call it in a sentence
 * @param noun    'arms' or 'levels'
 */
function betweenGroups(out, groups, name, noun) {
  if (groups.length < 2) return null;
  const tests = {};
  for (const r of out.responses) {
    const gs = groups.map((g) => g.byResponse[r.key]);
    if (gs.some((g) => !g || g.basis !== 'batches' || g.n < 2)) continue;
    if (groups.length === 2) {
      // second against first, so the sign agrees with "difference from the first arm"
      const w = welchTest(gs[1].points, gs[0].points);
      if (w) tests[r.key] = { kind: 'welch', ...w };
    } else {
      const a = anovaOneWay(gs.map((g) => g.points));
      if (a) tests[r.key] = { kind: 'anova', ...a, pairs: pairwiseAfterAnova(gs.map((g) => g.points), a) };
    }
  }
  const tested = out.responses.filter((r) => tests[r.key]);
  if (!tested.length) return null;
  const sig = tested.filter((r) => tests[r.key].p < 0.05), not = tested.filter((r) => !(tests[r.key].p < 0.05));
  const pOnly = (r) => `${r.label} (p ${pText(tests[r.key].p)})`;
  if (groups.length === 2) {
    const [A, B] = groups, k = tested[0].key;
    const head = `Welch’s t-test on the batch means (n = ${A.byResponse[k].n} and ${B.byResponse[k].n} batches)`;
    const full = (r) => { const t = tests[r.key]; return `${r.label} (t = ${f(t.t, 2)}, df = ${t.df.toFixed(1)}, p ${pText(t.p)})`; };
    out.sentences.push(sig.length
      ? `${head}: ${name(B)} differs from ${name(A)} in ${list(sig.map(full))}${not.length ? `; not in ${list(not.map(pOnly), 'or')}` : ''}.`
      : `${head}: ${name(B)} and ${name(A)} do not differ at p < 0.05 in ${list(not.map(pOnly), 'or')}.`);
  } else {
    const fText = (r) => { const t = tests[r.key]; return `F(${t.df1}, ${t.df2}) = ${f(t.F, t.F < 100 ? 2 : 1)}, p ${pText(t.p)}`; };
    const head = `One-way ANOVA on the batch means (${groups.length} ${noun})`;
    out.sentences.push(sig.length
      ? `${head}: ${list(sig.map((r) => `${r.label} differs between the ${noun} (${fText(r)})`))}${not.length ? `; ${list(not.map(pOnly))} ${not.length === 1 ? 'does' : 'do'} not` : ''}.`
      : `${head}: no difference between the ${noun} at p < 0.05 in ${list(not.map((r) => `${r.label} (${fText(r)})`), 'or')}.`);
    // Which ones differ. Prism's multiple comparisons: every pair, on the ANOVA's pooled SD, Holm–Šídák adjusted.
    for (const r of tested) {
      const t = tests[r.key], hit = t.pairs.filter((x) => x.pAdj < 0.05);
      if (hit.length) {
        out.sentences.push(`${r.label}, pair by pair (Holm–Šídák): ${list(hit.map((x) => `${name(groups[x.i])} and ${name(groups[x.j])} differ (p ${pText(x.pAdj)})`))}${hit.length < t.pairs.length ? '; no other pair does' : ''}.`);
      } else if (t.p < 0.05) {
        out.sentences.push(`${r.label}, pair by pair (Holm–Šídák): no single pair differs at p < 0.05 once all ${t.pairs.length} comparisons are allowed for.`);
      }
    }
  }
  return tests;
}

/* ---------- drift over time ---------- */

/** How far past the last timepoint a stability line is carried before the app stops projecting it. */
export const PROJECTION_HORIZON_DAYS = 365;

/**
 * A straight line through one formulation's values on one shelf, against days in storage: the slope with
 * its 95 % confidence interval (t distribution on n − 2 df), and where that line meets a QC upper limit.
 * Each point is one day's mean, so n counts timepoints, not instrument runs: repeat runs on one vial say
 * nothing about where the next week's vial will be.
 * @param points  [{t: day, y: value}], one per timepoint
 * @param opts.limit  the QC upper limit (Z-ave max, PDI max), or null for none
 * @returns {{slope, intercept, seSlope, df, n, r2, timepoints, ci:[lo,hi]|null, limit, horizonDays,
 *            projection: {status: 'ahead'|'beyond'|'passed'|'away', day?}|null}|null}
 */
export function driftTrend(points, { limit = null, horizonDays = PROJECTION_HORIZON_DAYS, alpha = 0.05 } = {}) {
  const pts = points.filter((p) => finite(p.t) && finite(p.y));
  const fit = linearFit(pts.map((p) => p.t), pts.map((p) => p.y));
  if (!fit) return null;
  const timepoints = new Set(pts.map((p) => p.t)).size;
  const tc = fit.df > 0 && fit.seSlope != null ? tCritical(fit.df, alpha) : null;
  const ci = tc != null ? [fit.slope - tc * fit.seSlope, fit.slope + tc * fit.seSlope] : null;
  const out = { ...fit, timepoints, ci, limit: finite(limit) ? limit : null, horizonDays, projection: null };
  // A line through two days goes through both exactly: it cannot be checked, so it is not carried forward.
  if (timepoints < 3 || out.limit == null) return out;
  if (!(fit.slope > 0)) { out.projection = { status: 'away' }; return out; }
  const day = (out.limit - fit.intercept) / fit.slope;
  out.projection = { day, status: day <= fit.xMax ? 'passed' : day <= fit.xMax + horizonDays ? 'ahead' : 'beyond' };
  return out;
}

/**
 * One shelf's day means of one response, as its drift line is drawn through them: [{t, y}]. Day 0 is before
 * storage, so a shelf whose own T0 was not measured starts from the formulation's T0 on another shelf, as the
 * change from T0 does. The slopes in the table and the line under the folded figures both fit these points, so
 * they cannot disagree about a drift.
 * @param series  every shelf of the study (res.stats.series), where that T0 is looked for
 */
function shelfPoints(series, s, key) {
  const pts = s.points.filter((p) => p.cells[key]).map((p) => ({ t: p.t, y: p.cells[key].mean }));
  if (pts.length && !pts.some((p) => p.t === 0)) {
    const base = series.filter((o) => o.batchId === s.batchId).flatMap((o) => o.points).find((p) => p.t === 0 && p.cells[key]);
    if (base) pts.unshift({ t: 0, y: base.cells[key].mean });
  }
  return pts;
}

const RATE = {
  zave: { up: 'grows', down: 'shrinks', unit: ' nm/day', limit: (v) => `${v} nm` },
  pdi: { up: 'rises', down: 'falls', unit: '/day', limit: (v) => `a PDI of ${v}` },
};
/** "grows 0.48 nm/day (95 % CI 0.31–0.65)", and a word when the interval takes in no change at all. */
function rateText(key, tr) {
  const w = RATE[key], dp = slopeDp(tr, key);
  const verb = Number(tr.slope.toFixed(dp)) === 0 ? 'changes' : tr.slope > 0 ? w.up : w.down;
  const ci = tr.ci ? ` (95 % CI ${ciText(tr.ci, dp)}${tr.ci[0] <= 0 && tr.ci[1] >= 0 ? ', so no clear trend' : ''})` : '';
  return `${verb} ${f(Math.abs(tr.slope), dp)}${w.unit}${ci}`;
}
/** Where the line meets the QC limit, said plainly; '' when there is no limit or too few timepoints. */
function projectionText(key, tr) {
  const pr = tr.projection;
  if (!pr) return '';
  const lim = RATE[key].limit(tr.limit);
  if (pr.status === 'away') return `it is not heading for the ${key === 'zave' ? `${tr.limit} nm` : `PDI ${tr.limit}`} limit`;
  if (pr.status === 'beyond') return `at that rate it does not reach ${lim} within the next ${tr.horizonDays} days`;
  if (pr.status === 'passed') return pr.day <= tr.xMin ? `the line is above ${lim} from the first day measured` : `the line crossed ${lim} around day ${aroundDay(pr.day)}, within the days measured`;
  return `at that rate it reaches ${lim} around day ${aroundDay(pr.day)}`;
}
const crosses = (tr) => tr?.projection && ['ahead', 'passed'].includes(tr.projection.status);

/**
 * One sentence per formulation and shelf: the size drift, its interval and the day it meets the limit. PDI
 * joins the sentence only when it is the response that reaches its limit first, because then it, not the
 * size, is what ends the shelf life.
 */
function trendSentence(s) {
  const z = s.trend.zave?.timepoints >= 3 ? s.trend.zave : null;
  const p = s.trend.pdi?.timepoints >= 3 ? s.trend.pdi : null;
  const where = `At ${condName(s.condition)}, ${s.batchId}`;
  if (!z) return `${where}: PDI ${rateText('pdi', p)}${projectionText('pdi', p) ? `; ${projectionText('pdi', p)}` : ''}.`;
  let text = `${where} ${rateText('zave', z)}${projectionText('zave', z) ? `; ${projectionText('zave', z)}` : ''}.`;
  if (p && crosses(p) && (!crosses(z) || p.projection.day < z.projection.day)) {
    text += ` Its PDI ${rateText('pdi', p)}: ${projectionText('pdi', p)}${crosses(z) ? ', before the size limit' : ''}.`;
  }
  return text;
}

/**
 * The same trend in table shorthand, for the stability table's last column:
 * {rate: "+0.48 nm/day", ci: "95 % CI 0.31–0.65", projection: "150 nm ≈ day 140"}.
 */
export function trendSummary(key, tr) {
  if (!tr) return null;
  const dp = slopeDp(tr, key), pr = tr.projection;
  const lim = key === 'zave' ? `${tr.limit} nm` : `PDI ${tr.limit}`;
  const projection = tr.timepoints < 3 ? 'a projection needs 3 timepoints'
    : !pr ? ''
      : pr.status === 'ahead' ? `${lim} ≈ day ${aroundDay(pr.day)}`
        : pr.status === 'passed' ? `past ${lim} ≈ day ${aroundDay(Math.max(pr.day, tr.xMin))}`
          : pr.status === 'beyond' ? `${lim} not within ${tr.horizonDays} days`
            : `not heading for ${lim}`;
  return { rate: `${signed(tr.slope, dp)}${RATE[key].unit}`, ci: tr.ci ? `95 % CI ${ciText(tr.ci, dp)}` : 'no CI from 2 days', projection };
}

/**
 * The line a stability page shows in place of the figures it folds away (PDI, EE …): per response, the span of
 * its day means and the shelves where it clearly drifts, then whether any day mean is outside a QC limit. A
 * drift is called only where a straight line through three days or more has a 95 % CI that leaves out zero,
 * the same test, through the same points, as the slopes in the table; with fewer days nothing is said about
 * drift at all. The QC clause names the limits it checked, which are those set for these responses: Z-ave has
 * its own figure, open above, and a limit cleared in Settings checks nothing.
 * "PDI 0.103–0.144, no clear drift on any shelf; EE 87.3–94.6 %, falling on E5-F1 at 25 °C; every day mean inside the QC limits for PDI (≤ 0.2) and EE (≥ 85 %)."
 */
export function stabilityFigureLine(res, keys, qc = null) {
  const series = res?.stats?.series || [];
  const parts = [], checked = [];
  let outside = 0;
  for (const key of keys) {
    const r = responseByKey[key];
    // The span and the QC count are of each shelf's own day means; a T0 borrowed for the fit would count twice.
    const lines = series.map((s) => ({ s, own: s.points.filter((p) => p.cells[key]).map((p) => p.cells[key].mean) }))
      .filter((x) => x.own.length);
    if (!r || !lines.length) continue;
    const ys = lines.flatMap((x) => x.own);
    const limit = qcLimit(key, qc);
    if (limit) { checked.push(`${r.label} (${limit})`); outside += ys.filter((y) => outsideQc(key, y, qc)).length; }
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const span = withUnit(r, f(lo, r.dp) === f(hi, r.dp) ? f(lo, r.dp) : ciText([lo, hi], r.dp));
    const fits = lines.map((x) => ({ s: x.s, tr: driftTrend(shelfPoints(series, x.s, key)) })).filter((x) => x.tr?.ci);
    const shelf = (x) => `${x.s.batchId} at ${condName(x.s.condition)}`;
    const way = (word, xs) => (!xs.length ? '' : `${word} ${xs.length === lines.length && lines.length > 1 ? 'on every shelf' : `on ${list(xs.map(shelf))}`}`);
    const drift = [way('rising', fits.filter((x) => x.tr.ci[0] > 0)), way('falling', fits.filter((x) => x.tr.ci[1] < 0))].filter(Boolean).join(' and ');
    parts.push(`${r.label} ${span}${drift ? `, ${drift}` : fits.length ? ', no clear drift on any shelf' : ''}`);
  }
  if (!parts.length) return '';
  const which = `the QC limit${checked.length === 1 ? '' : 's'} for ${list(checked)}`;
  const limits = !checked.length ? '' : outside ? `; ${outside} day mean${outside === 1 ? '' : 's'} outside ${which}` : `; every day mean inside ${which}`;
  return `${parts.join('; ')}${limits}.`;
}

/* ---------- by experiment type ---------- */

function repeats(out, rows) {
  const by = {};
  for (const r of out.responses) {
    const cells = rows.map((x) => x.cells[r.key]).filter(Boolean);
    if (!cells.length) continue;
    const g = describe(cells.map((c) => c.mean), r);
    by[r.key] = { ...g, min: Math.min(...g.points), max: Math.max(...g.points), batchIds: rows.filter((x) => x.cells[r.key]).map((x) => x.batchId), run: pooledRunSd(cells) };
  }
  out.stats = { kind: 'repeats', byResponse: by };
  const n = Math.max(0, ...Object.values(by).map((s) => s.n));
  const parts = out.responses.filter((r) => by[r.key]).map((r) => `${r.label} ${msd(r, by[r.key])}`);
  out.sentences.push(n >= 2 ? `Batch to batch, over ${n} batches: ${list(parts)}.` : `Only one batch is measured so far: ${list(parts)}. The batch-to-batch spread needs a second.`);
  // Whether the batches differ by more than the measurement alone would make them: a batch mean of k runs
  // scatters by run SD / √k even if every batch were identical.
  const z = by.zave;
  if (z && z.n >= 2 && z.run && z.sd != null) {
    const alone = z.run.sd / Math.sqrt(z.run.meanRuns);
    out.sentences.push(z.sd > 2 * alone
      ? `Repeat runs on one batch vary by ${f(z.run.sd, 1)} nm (pooled SD), so a batch mean is good to about ${f(alone, 1)} nm; the batches differ by ${f(z.sd, 1)} nm, which is more than the measurement explains: the spread comes from making them.`
      : `Repeat runs on one batch vary by ${f(z.run.sd, 1)} nm (pooled SD), so a batch mean is good to about ${f(alone, 1)} nm; the batches differ by ${f(z.sd, 1)} nm, no more than the measurement alone would give. They are as alike as this instrument can tell.`);
  }
  if (n === 2) out.sentences.push('Two batches give a rough SD; with three or more the CV is worth quoting.');
}

function comparison(out, rows) {
  // Arms are compositions: the same recipe added twice is one arm made twice, and then its SD is between batches.
  const keyOf = (row) => (row.compositionId != null ? `c${row.compositionId}` : row.batchId);
  const arms = [];
  for (const row of rows) {
    let a = arms.find((x) => x.key === keyOf(row));
    if (!a) arms.push(a = { key: keyOf(row), compositionId: row.compositionId, label: row.label, batchIds: [], rows: [] });
    a.batchIds.push(row.batchId); a.rows.push(row);
  }
  for (const a of arms) {
    a.byResponse = {};
    for (const r of out.responses) { const g = groupStats(a.rows.map((x) => x.cells[r.key]), r); if (g) a.byResponse[r.key] = g; }
  }
  const first = arms.find((a) => Object.keys(a.byResponse).length) || arms[0];
  for (const a of arms) {
    a.diff = {};
    if (a === first) continue;
    for (const r of out.responses) {
      const x = a.byResponse[r.key], y = first.byResponse[r.key];
      if (x && y) a.diff[r.key] = { abs: x.mean - y.mean, pct: y.mean ? (100 * (x.mean - y.mean)) / Math.abs(y.mean) : null };
    }
  }
  out.stats = { kind: 'comparison', arms, first: first?.key };
  const name = (a) => (a.compositionId != null ? `#${a.compositionId}` : a.batchIds[0]);
  for (const a of arms) {
    if (a === first) continue;
    const parts = out.responses.map((r) => diffText(r, a.diff[r.key])).filter(Boolean);
    if (parts.length) out.sentences.push(`${name(a)} (${a.batchIds.join(', ')}) against ${name(first)}: ${list(parts)}.`);
  }
  if (arms.length < 2 || out.sentences.length === 0) out.sentences.push('Each arm needs a result before the arms can be set side by side.');
  out.stats.tests = betweenGroups(out, [first, ...arms.filter((a) => a !== first)], name, 'arms');
  // Judged on what was measured, not on what was planned: an arm made twice with one batch measured so far has
  // only its run-to-run SD, and saying "between batches" about it would pass a technical SD off as reproducibility.
  const technical = (g) => Object.values(g.byResponse).some((x) => x.basis !== 'batches');
  out.caveat = arms.some(technical) ? TECHNICAL
    : `Every arm was made more than once, so each ± SD is the spread between its batches (n counts batches)${out.stats.tests ? ', and the tests compare batch means: each batch counts once, however many runs it had' : ''}.`;
}

function stability(out, rows, { qc = null, horizonDays = PROJECTION_HORIZON_DAYS } = {}) {
  const series = [], byShelf = new Map();
  for (const row of rows) {
    const k = `${row.batchId}\u0001${row.condition}`;
    let s = byShelf.get(k);
    if (!s) { series.push(s = { batchId: row.batchId, label: row.label, compositionId: row.compositionId, condition: row.condition, points: [] }); byShelf.set(k, s); }
    if (out.responses.some((r) => row.cells[r.key])) s.points.push({ t: row.timepoint, cells: row.cells, change: row.change });
  }
  out.stats = { kind: 'stability', series: series.filter((s) => s.points.length), horizonDays };
  // The drift line per series, through the day means, T0 borrowed from another shelf where need be.
  const limits = { zave: qc?.zaveMax, pdi: qc?.pdiMax };
  for (const s of out.stats.series) {
    s.trend = {};
    for (const key of ['zave', 'pdi']) {
      const tr = driftTrend(shelfPoints(out.stats.series, s, key), { limit: limits[key], horizonDays });
      if (tr) s.trend[key] = tr;
    }
  }
  const days = [...new Set(rows.filter((x) => out.responses.some((r) => x.cells[r.key])).map((x) => x.timepoint))];
  if (!days.some((t) => t > 0)) {
    out.sentences.push('Only day 0 is measured so far. The change over time appears here once a later timepoint is in.');
    return;
  }
  // Three timepoints or more: the slope sentence. Fewer: the change from T0, which is all two days can say.
  const sloped = out.stats.series.filter((s) => s.trend.zave?.timepoints >= 3 || s.trend.pdi?.timepoints >= 3);
  for (const s of sloped) out.sentences.push(trendSentence(s));
  if (sloped.length > 1 && sloped.some((s) => s.trend.zave?.projection || s.trend.pdi?.projection)) {
    const hits = sloped.flatMap((s) => ['zave', 'pdi'].filter((k) => crosses(s.trend[k])).map((k) => ({ s, k, day: s.trend[k].projection.day })));
    const soon = hits.sort((a, b) => a.day - b.day)[0];
    out.sentences.push(soon
      ? `Soonest to a QC limit: ${soon.s.batchId} at ${condName(soon.s.condition)}, ${soon.k === 'zave' ? 'Z-ave' : 'PDI'} around day ${aroundDay(soon.day)}.`
      : `No formulation on any shelf is projected to reach a QC limit within ${horizonDays} days of its last timepoint.`);
  }
  if (sloped.length) {
    out.caveat = 'Each slope is a least-squares line through the day means, with its 95 % confidence interval from the t distribution on n − 2 degrees of freedom, '
      + 'so it needs three timepoints. A projected day carries that straight line past the last day measured: it holds only as long as the drift stays linear.';
  }
  let worst = null, changed = 0;
  for (const s of out.stats.series) {
    if (sloped.includes(s)) continue;
    const last = s.points.filter((p) => p.t > 0 && (p.change.zave || p.change.pdi)).pop();
    if (!last) continue;
    const bits = [];
    for (const key of ['zave', 'pdi', 'ee']) {
      const r = responseByKey[key], ch = last.change[key];
      if (!ch) continue;
      bits.push(`${r.label} ${withUnit(r, `${f(ch.base, r.dp)} → ${f(last.cells[key].mean, r.dp)}`)} (${r.points ? `${signed(ch.abs, r.dp)} points` : `${signed(ch.pct, 1)} %`})`);
    }
    out.sentences.push(`${s.batchId} at ${condName(s.condition)}, day ${last.t}: ${list(bits)}.`);
    changed++;
    const z = last.change.zave;
    if (z && finite(z.pct) && (!worst || Math.abs(z.pct) > Math.abs(worst.pct))) worst = { ...z, s, t: last.t };
  }
  if (worst && changed > 1) out.sentences.push(`The largest size change is ${worst.s.batchId} at ${condName(worst.s.condition)}: ${signed(worst.pct, 1)} % by day ${worst.t}.`);
}

function ofat(out, rows, exp) {
  const key = exp.design?.factor;
  const fac = FACTORS.find((x) => x.key === key);
  const levels = [];
  for (const row of rows) {
    if (row.level == null) continue;
    let l = levels.find((x) => x.level === row.level);
    if (!l) levels.push(l = { level: row.level, text: row.levelText ?? String(row.level), batchIds: [], rows: [] });
    l.batchIds.push(row.batchId); l.rows.push(row);
  }
  // Numbers in order of size; mixers in the order the experiment listed them, which is the order they were ticked.
  const categorical = isCategoricalFactor(key);
  const order = (exp.design?.levels || []).map(String);
  levels.sort((a, b) => (categorical ? order.indexOf(String(a.level)) - order.indexOf(String(b.level)) : a.level - b.level));
  for (const l of levels) {
    l.byResponse = {};
    for (const r of out.responses) { const g = groupStats(l.rows.map((x) => x.cells[r.key]), r); if (g) l.byResponse[r.key] = g; }
  }
  const factorName = fac?.name || key || 'level';
  out.stats = { kind: 'ofat', factor: key, factorName, unit: fac?.unit || '', levels, categorical };
  const at = (l) => `${factorName} ${l.text}`;
  for (const r of out.responses) {
    const have = levels.filter((l) => l.byResponse[r.key]);
    if (have.length < 2) continue;
    const lo = have.reduce((a, b) => (b.byResponse[r.key].mean < a.byResponse[r.key].mean ? b : a));
    const hi = have.reduce((a, b) => (b.byResponse[r.key].mean > a.byResponse[r.key].mean ? b : a));
    const v = (l) => withUnit(r, f(l.byResponse[r.key].mean, r.dp));
    if (v(lo) === v(hi)) out.sentences.push(`${r.label} is the same at every level (${v(lo)}).`);
    else if (r.key === 'ee') out.sentences.push(`Highest EE at ${at(hi)} (${v(hi)}), lowest at ${at(lo)} (${v(lo)}).`);
    else out.sentences.push(`${r.label} is lowest at ${at(lo)} (${v(lo)}) and highest at ${at(hi)} (${v(hi)}).`);
  }
  if (!out.sentences.length) out.sentences.push('The response against the level needs two measured levels.');
  out.stats.tests = betweenGroups(out, levels, at, 'levels');
  out.caveat = levels.some((l) => Object.values(l.byResponse).some((x) => x.basis !== 'batches')) ? TECHNICAL
    : out.stats.tests ? 'Every level was made more than once, so each ± SD is the spread between its batches, and the tests compare batch means: each batch counts once, however many runs it had.' : '';
}

function single(out, rows) {
  out.stats = { kind: 'single' };
  // One formulation, or a handful, is read value by value. An optimizer round of six or eight is not: a
  // sentence per formulation repeats the table, so it says where each response ranges from and to instead.
  const measured = rows.filter((x) => out.responses.some((r) => x.cells[r.key]));
  if (measured.length > 3) {
    out.sentences.push(`${measured.length} formulations measured.`);
    for (const r of out.responses) {
      const have = measured.filter((x) => x.cells[r.key]);
      if (have.length < 2) continue;
      const lo = have.reduce((a, b) => (b.cells[r.key].mean < a.cells[r.key].mean ? b : a));
      const hi = have.reduce((a, b) => (b.cells[r.key].mean > a.cells[r.key].mean ? b : a));
      out.sentences.push(`${r.label} from ${withUnit(r, f(lo.cells[r.key].mean, r.dp))} (${lo.batchId}) to ${withUnit(r, f(hi.cells[r.key].mean, r.dp))} (${hi.batchId}).`);
    }
    return;
  }
  for (const row of rows) {
    const parts = out.responses.filter((r) => row.cells[r.key]).map((r) => {
      const c = row.cells[r.key];
      return `${r.label} ${msd(r, c, { cv: false })} (${c.n > 1 ? `${c.n} runs, CV ${finite(c.cv) ? c.cv.toFixed(1) : '–'} %` : 'n = 1'})`;
    });
    if (parts.length) out.sentences.push(`${row.batchId}: ${list(parts)}.`);
  }
}

/**
 * Everything the Results card shows.
 * @param exp           the experiment record (type, design, expected slots)
 * @param batches       its formulations, in the order to list them
 * @param measurements  any measurements; those of other formulations are ignored
 * @param opts.qc       QC limits from the settings, for the QC sentence and the stability projections
 * @param opts.horizonDays  how far past its last timepoint a stability line is projected
 * @returns {{type, responses, rows, measuredRows, totalRows, stats, sentences, caveat}}
 */
export function experimentResults(exp, batches, measurements, { qc = null, horizonDays = PROJECTION_HORIZON_DAYS } = {}) {
  const type = exp?.type || 'single';
  const ids = new Set(batches.map((b) => b.id));
  const slotsById = Object.fromEntries((exp?.expected || []).map((s) => [s.id, s]));
  const byBatch = groupBy((measurements || []).filter((m) => ids.has(m.batchId)), (m) => m.batchId);
  const rows = type === 'stability' ? stabilityRows(exp, batches, byBatch, slotsById) : batchRows(exp, batches, byBatch, slotsById);
  const responses = RESULT_RESPONSES.filter((r) => rows.some((x) => x.cells[r.key]));
  const measured = rows.filter((x) => responses.some((r) => x.cells[r.key]));
  const out = { type, responses, rows, measuredRows: measured.length, totalRows: rows.length, stats: null, sentences: [], caveat: '' };
  if (!measured.length) return out;
  if (type === 'reference') repeats(out, rows);
  else if (type === 'comparison') comparison(out, rows);
  else if (type === 'stability') stability(out, rows, { qc, horizonDays });
  else if (type === 'ofat') ofat(out, rows, exp);
  else if (type === 'doe') {
    out.stats = { kind: 'doe' };
    out.sentences.push(`${measured.length} of ${rows.length} runs measured. The fitted model, its diagnostics and the optimum are on Design & results.`);
  } else single(out, rows);
  if (['single', 'reference', 'comparison', 'ofat'].includes(type)) { const q = qcSentence(rows, qc, responses); if (q) out.sentences.push(q); }
  return out;
}

/* ---------- an optimizer round: predicted against measured ---------- */

/**
 * How the optimizer's predictions for one round did, in a line: how many measured values fell inside the 95 %
 * interval the model gave (mean ± 1.96 SD), and which fell outside, by response and in which direction.
 *
 * A result is one batch, so the interval has to be one a single batch should fall in: the surface's uncertainty
 * and its measurement noise together, which a run stores along with `noise` since usability cycle 5. A run stored
 * before then holds only the surface's uncertainty about the mean, which a single batch misses about half the
 * time even when the model is right. Its noise was not kept, so that interval is not widened by a guess; the
 * line says what it is instead.
 * @param items  [{batchId, label, mean, sd, noise, measured}], one per run and response with a prediction;
 *               `noise` is the measurement scatter included in `sd`, absent when `sd` is the surface's alone;
 *               `measured` is the result, or null while it is still to come
 * @returns {{total, measured, inside, outside: [{batchId, label, dir}], sentence}}
 */
export function predictionSummary(items) {
  const all = (items || []).filter((x) => finite(x?.mean) && finite(x?.sd));
  const done = all.filter((x) => finite(x.measured));
  const ofMean = all.some((x) => !finite(x.noise));
  const interval = `the model’s 95 % interval${ofMean ? ' for the mean' : ''}`;
  const outside = done.filter((x) => Math.abs(x.measured - x.mean) > 1.96 * x.sd)
    .map((x) => ({ batchId: x.batchId, label: x.label, dir: x.measured > x.mean ? 'higher' : 'lower' }));
  const out = { total: all.length, measured: done.length, inside: done.length - outside.length, outside, sentence: '' };
  if (!all.length) return out;
  if (!done.length) {
    const runs = new Set(all.map((x) => x.batchId)).size;
    out.sentence = `Nothing measured yet: the predictions for ${runs} run${runs === 1 ? '' : 's'} wait for their results.`;
    return out;
  }
  const left = done.length < all.length ? `; ${all.length - done.length} still to measure` : '';
  if (!outside.length) {
    out.sentence = `${done.length === 1 ? 'The one' : `All ${done.length}`} measured value${done.length === 1 ? '' : 's'} fell inside ${interval}${left}.`;
    return out;
  }
  // Grouped by response and direction, in the order the table lists them, so a model that is off the same way
  // on every run (EE always higher than predicted) reads as one bias rather than as a list of misses.
  const groups = [];
  for (const o of outside) {
    let g = groups.find((x) => x.label === o.label && x.dir === o.dir);
    if (!g) groups.push(g = { label: o.label, dir: o.dir, ids: [] });
    g.ids.push(o.batchId);
  }
  const oneWay = new Set(groups.map((g) => g.dir)).size === 1;
  const named = groups.map((g) => `${g.label} on ${list(g.ids)}${oneWay ? '' : ` (${g.dir} than predicted)`}`).join('; ');
  const share = out.inside ? `${out.inside} of ${done.length} measured values fell inside`
    : done.length === 1 ? 'The one measured value fell outside' : `None of the ${done.length} measured values fell inside`;
  const scatter = ofMean ? ', which leaves out the scatter between batches, so a single result can fall outside it even when the model is right' : '';
  out.sentence = `${share} ${interval}${scatter}${left}. `
    + `Outside it: ${named}${oneWay ? `, ${outside.length > 1 ? 'all ' : ''}${groups[0].dir} than predicted` : ''}.`;
  return out;
}

/* ---------- export ---------- */

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const round = (x, dp) => (finite(x) ? String(Math.round(x * 10 ** dp) / 10 ** dp) : '');

/**
 * The data table as CSV, one row per table row and four columns per response (mean, SD, n, CV %), plus the
 * change from T0 in a stability study. Plain numbers with a dot, so GraphPad, R or a spreadsheet read it as is.
 */
export function resultsCsv(res, { experimentId = '', compositionName = (id) => (id != null ? `#${id}` : '') } = {}) {
  const stab = res.type === 'stability';
  const head = ['experiment', 'formulation', 'label', 'composition'];
  if (stab) head.push('condition', 'day');
  if (res.type === 'ofat') head.push('level');
  for (const r of res.responses) {
    const u = r.unit ? ` (${r.unit})` : '';
    head.push(`${r.label}${u} mean`, `${r.label}${u} SD`, `${r.label} n`, `${r.label} CV %`);
    if (stab) head.push(`${r.label}${u} change from T0`, `${r.label} change from T0 %`);
  }
  // A stability grid is mostly days still to come; the export is what was measured.
  const rows = stab ? res.rows.filter((x) => res.responses.some((r) => x.cells[r.key])) : res.rows;
  const lines = rows.map((x) => {
    const cells = [experimentId, x.batchId, x.label, compositionName(x.compositionId)];
    if (stab) cells.push(x.condition, x.timepoint);
    if (res.type === 'ofat') cells.push(x.levelText ?? x.level ?? '');
    for (const r of res.responses) {
      const c = x.cells[r.key];
      cells.push(round(c?.mean, r.dp + 2), round(c?.sd, r.dp + 2), c ? c.n : '', round(c?.cv, 2));
      if (stab) { const ch = x.change?.[r.key]; cells.push(round(ch?.abs, r.dp + 2), round(ch?.pct, 2)); }
    }
    return cells.map(csvCell).join(',');
  });
  return [head.map(csvCell).join(','), ...lines].join('\n') + '\n';
}

/* ---------- progress ---------- */

/**
 * Where an experiment is, from its records rather than from a status someone has to remember to set:
 * planned (nothing made), in production (some made), measuring (all made, results still due), all measured.
 */
export function progressStage(exp, batches, today = null) {
  const planned = batches.filter((b) => b.status === 'planned');
  const slots = exp?.expected || [];
  const open = slots.filter((s) => s.status === 'open');
  const overdue = today ? open.filter((s) => s.dueDate && s.dueDate < today).length : 0;
  const done = slots.length - open.length;
  const stage = planned.length && planned.length === batches.length && !done ? 'planned'
    : planned.length ? 'in production'
      : open.length ? 'measuring' : 'all measured';
  const nextDue = open.map((s) => s.dueDate).filter(Boolean).sort()[0] || null;
  return { stage, planned: planned.length, firstPlanned: planned[0]?.id || null, open: open.length, overdue, done, total: slots.length, nextDue };
}
