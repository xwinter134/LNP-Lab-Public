// What an import says, worked out the moment it lands.
//
// Finding F1 of the first usability cycle: eighteen results came in and the screen showed the same
// date-sorted list as before, so whether the runs of a sample agreed, which samples sat outside the QC window,
// which one was unlike the rest and what the experiment was still waiting for all had to be dug out by hand.
// This module works those out from the records an import has just stored; app/ui/importeval.js draws them.
// Pure: records in, numbers out, no DOM and no store.
import { mean, sd } from './stats.js';
import { byId, groupBy } from './indexes.js';

/** Short names for prose ("18 of 18 DLS in"); the long ones in experiment.js are for menus. */
export const TEST_LABEL = {
  dls: 'DLS', zeta: 'zeta', ee: 'EE', content: 'RNA content', potency: 'potency', ph: 'pH', osmolality: 'osmolality',
  integrity: 'RNA integrity', lipid_content: 'lipid content', endotoxin: 'endotoxin',
};
const TEST_ORDER = Object.keys(TEST_LABEL);
const testRank = (t) => (TEST_ORDER.includes(t) ? TEST_ORDER.indexOf(t) : TEST_ORDER.length);

/**
 * The numbers each test is read by, most important first. A test not listed here, or a record that stores
 * something else, falls back to its first numeric value, so a new import type is evaluated before anyone
 * teaches this file about it.
 */
export const METRICS = {
  dls: [{ key: 'zave_nm', label: 'Z-average', unit: 'nm', digits: 1 }, { key: 'pdi', label: 'PDI', unit: '', digits: 3 }],
  // A CV is a spread relative to the level, which means nothing for a value that can sit at zero or change sign.
  zeta: [{ key: 'zeta_mV', label: 'Zeta potential', unit: 'mV', digits: 1, noCv: true }],
  ee: [{ key: 'ee_pct', label: 'Encapsulation', unit: '%', digits: 1 }],
  content: [{ key: 'rna_mg_mL', label: 'RNA content', unit: 'mg/mL', digits: 3 }],
  potency: [{ key: 'pctControl', label: 'Potency', unit: '% of control', digits: 0 }, { key: 'rlu', label: 'Luminescence', unit: 'RLU', digits: 0 }],
  ph: [{ key: 'ph', label: 'pH', unit: '', digits: 2 }],
  osmolality: [{ key: 'mOsm_kg', label: 'Osmolality', unit: 'mOsm/kg', digits: 0 }],
  integrity: [{ key: 'pct', label: 'Integrity', unit: '%', digits: 1 }],
  lipid_content: [{ key: 'total_mg_mL', label: 'Total lipid', unit: 'mg/mL', digits: 3 }],
  endotoxin: [{ key: 'eu_mL', label: 'Endotoxin', unit: 'EU/mL', digits: 2 }],
};

const NO_CV = new Set(Object.values(METRICS).flat().filter((m) => m.noCv).map((m) => m.key));

// Numeric, but settings of the measurement or derived spreads rather than results of it; never a fallback.
const NOT_RESULTS = new Set(['runs', 'attenuator', 'temp_c', 'dilution', 'countRate_kcps', 'zave_sd', 'sd_mV', 'conductivity_mS_cm']);

/** Run-to-run CV of size above which the runs of one sample are said to disagree: the 5 % app/calc/qc.js uses. */
export const RUN_CV_LIMIT = 5;
/** Modified z-score past which a sample is called unlike the rest of its import (Iglewicz & Hoaglin, 1993). */
export const OUTLIER_Z = 3.5;
/** Below this many samples a median and a MAD are too unsteady to call anything unusual. */
export const OUTLIER_MIN_N = 5;

const num = (v) => (v == null || v === '' || typeof v === 'boolean' ? NaN : Number(v));
const fin = (v) => Number.isFinite(num(v));
const fx = (v, d) => Number(v).toFixed(d);
const withUnit = (v, m) => `${fx(v, m.digits)}${m.unit ? (m.unit === '%' ? ' %' : ' ' + m.unit) : ''}`;

export function median(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const k = v.length >> 1;
  return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
}

/** n, mean, SD, CV % and range of whatever is finite in xs; null when nothing is. `key` names the metric, for whether a CV means anything. */
export function describe(xs, key = null) {
  const v = xs.filter(Number.isFinite);
  if (!v.length) return null;
  const mu = mean(v), s = sd(v);
  return { n: v.length, mean: mu, sd: s, cv: s != null && mu && !NO_CV.has(key) ? (100 * s) / Math.abs(mu) : null, min: Math.min(...v), max: Math.max(...v) };
}

/** Which of a test's metrics these records actually carry. */
export function metricsFor(test, records) {
  const has = (k) => records.some((r) => fin(r.values?.[k]) || (r.values?.runs || []).some((x) => fin(x?.[k])));
  const known = (METRICS[test] || []).filter((m) => has(m.key));
  if (known.length) return known;
  for (const r of records) {
    for (const [k, v] of Object.entries(r.values || {})) {
      if (!NOT_RESULTS.has(k) && !/_sd$/.test(k) && fin(v)) return [{ key: k, label: k.replace(/_/g, ' '), unit: '', digits: 2 }];
    }
  }
  return [];
}

/**
 * One metric of one sample: the stored result, and the spread of the runs behind it.
 * The stored value is the mean, not a recomputed one, because it is what every other screen shows; the runs
 * only supply the spread. A sample measured once has no SD, and saying so is better than inventing one.
 */
export function replicate(values, key) {
  const runs = Array.isArray(values?.runs) ? values.runs.map((r) => num(r?.[key])).filter(Number.isFinite) : [];
  const stored = num(values?.[key]);
  const mu = Number.isFinite(stored) ? stored : mean(runs);
  if (!Number.isFinite(mu)) return null;
  const s = runs.length >= 2 ? sd(runs) : null;
  return { mean: mu, sd: s, cv: s != null && mu && !NO_CV.has(key) ? (100 * s) / Math.abs(mu) : null, n: Math.max(1, runs.length), runs };
}

/**
 * QC findings in words, against the limits in Settings. The thresholds are the ones app/calc/qc.js applies when
 * a record is saved; they are worked out again here because the record's stored flags were written against
 * whatever the limits were then, and because each finding needs to say which number it is about.
 */
export function qcFindings(test, metrics, countRate, qc = {}) {
  const f = [];
  const z = metrics.zave_nm, p = metrics.pdi, e = metrics.ee_pct;
  if (test === 'dls') {
    if (z && Number.isFinite(qc.zaveMax) && z.mean > qc.zaveMax) f.push({ level: 'warn', kind: 'limit', metric: 'zave_nm', text: `Z-average ${fx(z.mean, 1)} nm is above the ${qc.zaveMax} nm limit` });
    else if (z && Number.isFinite(qc.zaveMin) && z.mean < qc.zaveMin) f.push({ level: 'warn', kind: 'limit', metric: 'zave_nm', text: `Z-average ${fx(z.mean, 1)} nm is below the ${qc.zaveMin} nm limit` });
    if (p && Number.isFinite(qc.pdiMax) && p.mean > qc.pdiMax) f.push({ level: 'warn', kind: 'limit', metric: 'pdi', text: `PDI ${fx(p.mean, 3)} is above the ${qc.pdiMax} limit` });
    if (z && z.cv != null && z.cv > RUN_CV_LIMIT) f.push({ level: 'warn', kind: 'cv', metric: 'zave_nm', text: `the ${z.n} runs disagree: size varies ${fx(z.cv, 1)} % between runs (more than ${RUN_CV_LIMIT} %)` });
    if (countRate != null && Number.isFinite(qc.countRateMin) && countRate < qc.countRateMin) f.push({ level: 'warn', kind: 'count', metric: 'countRate_kcps', text: `count rate ${fx(countRate, 0)} kcps is below ${qc.countRateMin}: probably too dilute to trust the size` });
  }
  if (test === 'ee' && e && Number.isFinite(qc.eeMin) && e.mean < qc.eeMin) f.push({ level: 'warn', kind: 'limit', metric: 'ee_pct', text: `encapsulation ${fx(e.mean, 1)} % is below the ${qc.eeMin} % limit` });
  return f;
}

/**
 * What qcFindings can check for these tests with the limits as they are set: the readings that have a limit
 * ('size', 'PDI', 'count rate', 'encapsulation'), and the tests Settings has limits for with every one of them
 * switched off. A limit switched off is null, and a sentence that vouched for it would claim a check nobody made
 * (usability cycle 6, Q1). Zeta and RNA content have no limits in Settings, so they are in neither list.
 * With the evaluated `samples`, a limit counts only for a reading one of them carries: a pasted size and PDI has
 * no count rate to be inside a count-rate limit.
 */
export function qcChecked(tests, qc = {}, samples = null) {
  const on = (k) => Number.isFinite(qc?.[k]);
  const has = (test, key) => !samples || samples.some((s) => s.test === test && (key === 'countRate' ? Number.isFinite(s.countRate) : !!s.metrics?.[key]));
  const checked = [], off = [];
  if (tests.includes('dls')) {
    if (!['zaveMin', 'zaveMax', 'pdiMax', 'countRateMin'].some(on)) off.push('dls');
    if ((on('zaveMin') || on('zaveMax')) && has('dls', 'zave_nm')) checked.push('size');
    if (on('pdiMax') && has('dls', 'pdi')) checked.push('PDI');
    if (on('countRateMin') && has('dls', 'countRate')) checked.push('count rate');
  }
  if (tests.includes('ee')) { if (!on('eeMin')) off.push('ee'); else if (has('ee', 'ee_pct')) checked.push('encapsulation'); }
  return { checked, off };
}

/**
 * Modified z-scores, 0.6745·(x − median)/MAD. A mean and SD are pulled towards the very point being tested, so
 * one wild sample hides itself; the median and the median absolute deviation are not, which is why this is the
 * score to use on a dozen samples. When more than half the values are identical the MAD is zero, and the mean
 * absolute deviation stands in (scaled to the same footing). Too few values gives nulls rather than a verdict.
 */
export function robustZ(xs) {
  const v = xs.filter(Number.isFinite);
  if (v.length < OUTLIER_MIN_N) return xs.map(() => null);
  const med = median(v);
  const dev = v.map((x) => Math.abs(x - med));
  const mad = median(dev);
  const scale = mad > 0 ? mad / 0.6745 : 1.253314 * mean(dev);
  return xs.map((x) => (!Number.isFinite(x) ? null : scale > 0 ? (x - med) / scale : 0));
}

/** "E3-F2_final" sorts before "E3-F10_final", and experiment 10 after experiment 9. */
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
const expNo = (id) => { const m = /^E(\d+)$/.exec(String(id || '')); return m ? Number(m[1]) : Infinity; };

/**
 * Shorter names for a chart axis. When every sample belongs to one experiment its "E3-" says nothing, and
 * "_final" is the stage almost everything is at; what is left (F2, F1_4C_T07) is the part that differs. A name
 * that never had the prefix (an inbox row called "Sample 6") is left as it is. If dropping them would make two
 * names the same, the full names stay. Returns the labels and what was dropped, for the caption.
 */
export function shortLabels(names) {
  const full = names.map(String);
  const pre = new Set(full.map((n) => (/^(E\d+-)/.exec(n) || [])[1]).filter(Boolean));
  const prefix = pre.size === 1 ? [...pre][0] : '';
  const suffix = full.some((n) => /_final$/i.test(n)) ? '_final' : '';
  const labels = full.map((n) => (prefix && n.startsWith(prefix) ? n.slice(prefix.length) : n).replace(/_final$/i, '') || n);
  return new Set(labels).size === labels.length ? { labels, prefix, suffix } : { labels: full, prefix: '', suffix: '' };
}

const stamp = (m) => String(m.createdAt || m.date || '');
const isFinal = (m) => !m.stage || /^final$/i.test(m.stage);

/** One record per expected measurement: a slot measured twice counts once, with its latest result. */
function latest(ms) {
  const by = new Map();
  for (const m of ms) {
    const k = m.slotId || [m.batchId, m.test, m.stage, m.condition ?? ''].join('|');
    const prev = by.get(k);
    if (!prev || stamp(m) >= stamp(prev)) by.set(k, m);
  }
  return [...by.values()];
}

/** The spread of one value per batch across a set of batches (the centre points, or the repeats). */
function spreadAcross(batchIds, ms, test, metricList) {
  const perBatch = new Map();
  for (const m of latest(ms.filter((x) => x.test === test && batchIds.has(x.batchId) && isFinal(x)))) {
    const prev = perBatch.get(m.batchId);
    if (!prev || stamp(m) >= stamp(prev)) perBatch.set(m.batchId, m);
  }
  const recs = [...perBatch.values()];
  return { measured: recs.length, metrics: metricList.map((mt) => ({ ...mt, ...(describe(recs.map((r) => replicate(r.values, mt.key)?.mean ?? NaN), mt.key) || { n: 0 }) })) };
}

/** Stability: one row per storage condition and timepoint, and one line per formulation on each shelf. */
function stabilityGroup(exp, ms, test, metricList) {
  const recs = latest(ms.filter((m) => m.test === test && m.condition != null && m.condition !== '' && Number.isFinite(Number(m.timepoint))));
  if (!recs.length) return null;
  const condOrder = exp.design?.stability?.conditions || [];
  const conds = [...new Set(recs.map((m) => m.condition))].sort((a, b) => {
    const ia = condOrder.indexOf(a), ib = condOrder.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || natural(a, b);
  });
  const rows = [];
  for (const c of conds) {
    const mine = recs.filter((m) => m.condition === c);
    const tps = [...new Set(mine.map((m) => Number(m.timepoint)))].sort((a, b) => a - b);
    // Each formulation's own first reading on this shelf. The change is worked out per formulation and then
    // averaged, so a day with only some formulations measured is compared with those same formulations, not
    // with the average of all of them on day 0 (one 120 nm arm missing would read as everything shrinking).
    const firstOf = new Map();
    for (const m of [...mine].sort((a, b) => Number(a.timepoint) - Number(b.timepoint))) if (!firstOf.has(m.batchId)) firstOf.set(m.batchId, m);
    for (const t of tps) {
      const here = mine.filter((m) => Number(m.timepoint) === t);
      const metrics = Object.fromEntries(metricList.map((mt) => [mt.key, describe(here.map((r) => replicate(r.values, mt.key)?.mean ?? NaN), mt.key)]));
      const change = Object.fromEntries(metricList.map((mt) => {
        const d = here.map((m) => {
          const f = firstOf.get(m.batchId);
          if (!f || Number(f.timepoint) >= t) return NaN;
          return (replicate(m.values, mt.key)?.mean ?? NaN) - (replicate(f.values, mt.key)?.mean ?? NaN);
        }).filter(Number.isFinite);
        return [mt.key, d.length ? d.reduce((a, b) => a + b, 0) / d.length : null];
      }));
      rows.push({ condition: c, timepoint: t, n: here.length, metrics, change });
    }
  }
  const arms = new Map();
  for (const m of recs) {
    const k = `${m.batchId}|${m.condition}`;
    if (!arms.has(k)) arms.set(k, { batchId: m.batchId, condition: m.condition, points: [] });
    arms.get(k).points.push({ x: Number(m.timepoint), values: Object.fromEntries(metricList.map((mt) => [mt.key, replicate(m.values, mt.key)])) });
  }
  const lines = [...arms.values()].sort((a, b) => natural(a.batchId, b.batchId) || conds.indexOf(a.condition) - conds.indexOf(b.condition));
  lines.forEach((l) => l.points.sort((a, b) => a.x - b.x));
  return { kind: 'stability', test, metrics: metricList, rows, lines, timepoints: [...new Set(recs.map((m) => Number(m.timepoint)))].sort((a, b) => a - b) };
}

/**
 * Where an experiment stands now that these results are in: per test, how many of the measurements it
 * expected are done and how many are still open, and, where the design has one, the summary it was built to
 * give — the spread of the centre points of a DoE (the pure error every effect is judged against), the
 * batch-to-batch spread of a reference series, and a stability study by shelf and timepoint.
 */
export function experimentStatus(exp, { batches = [], measurements = [], importRecords = [], tests = [], metricsByTest = {}, today = null } = {}) {
  const slots = exp.expected || [];
  const fromImport = new Set(importRecords.filter((m) => m.slotId).map((m) => m.slotId));
  const byTest = [...new Set(slots.map((s) => s.test))].sort((a, b) => testRank(a) - testRank(b)).map((test) => {
    const mine = slots.filter((s) => s.test === test);
    const open = mine.filter((s) => s.status === 'open');
    return {
      test, label: TEST_LABEL[test] || test, total: mine.length, done: mine.filter((s) => s.status === 'done').length, open: open.length,
      fromImport: mine.filter((s) => fromImport.has(s.id)).length,
      overdue: today ? open.filter((s) => s.dueDate && s.dueDate < today).length : 0,
      nextDue: open.map((s) => s.dueDate).filter(Boolean).sort()[0] || null,
    };
  });
  const expMs = measurements.filter((m) => m.experimentId === exp.id);
  const expBatches = batches.filter((b) => b.experimentId === exp.id);
  const groups = [];
  for (const test of tests) {
    const metricList = metricsByTest[test] || [];
    if (!metricList.length) continue;
    if (exp.type === 'doe') {
      const centre = new Set(expBatches.filter((b) => b.doe?.point_type === 'center').map((b) => b.id));
      if (centre.size >= 2) groups.push({ kind: 'centre', test, planned: centre.size, ...spreadAcross(centre, expMs, test, metricList) });
    } else if (exp.type === 'reference') {
      const reps = new Set(expBatches.map((b) => b.id));
      if (reps.size >= 2) groups.push({ kind: 'repeats', test, planned: reps.size, ...spreadAcross(reps, expMs, test, metricList) });
    } else if (exp.type === 'stability') {
      const g = stabilityGroup(exp, expMs, test, metricList);
      if (g) groups.push(g);
    }
  }
  const total = slots.length, done = slots.filter((s) => s.status === 'done').length;
  return { id: exp.id, name: exp.name || '', type: exp.type, total, done, open: slots.filter((s) => s.status === 'open').length, byTest, groups };
}

/**
 * The evaluation of one import.
 * @param {object} a
 * @param {object[]} a.records       the measurement records the import stored (and any assigned from its inbox rows since)
 * @param {object[]} a.inbox         its rows still waiting in the inbox (they carry values but no formulation)
 * @param {object[]} a.experiments   all experiments, as stored now
 * @param {object[]} a.batches       all formulations
 * @param {object[]} [a.measurements] every measurement on record, for the experiment summaries; defaults to records
 * @param {object}   a.qc            getSettings(ctx).qc: zaveMin, zaveMax, pdiMax, eeMin, countRateMin
 * @param {object}   [a.info]        the imports record: samples (rows in the file), imported, inbox
 * @param {string}   [a.today]       ISO date, for what is past due
 * @returns {{tests:string[], metrics:object, samples:object[], experiments:object[], headline:object}}
 */
export function evaluateImport({ records = [], inbox = [], experiments = [], batches = [], measurements = null, qc = {}, info = null, today = null } = {}) {
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const all = [...records.map((r) => ({ r, source: 'measurement' })), ...inbox.map((r) => ({ r, source: 'inbox' }))];
  const tests = [...new Set(all.map(({ r }) => r.test).filter(Boolean))].sort((a, b) => testRank(a) - testRank(b));
  const metricsByTest = Object.fromEntries(tests.map((t) => [t, metricsFor(t, all.filter(({ r }) => r.test === t).map(({ r }) => r))]));

  const samples = all.map(({ r, source }) => {
    const v = r.values || {};
    const metrics = {};
    for (const mt of metricsByTest[r.test] || []) { const x = replicate(v, mt.key); if (x) metrics[mt.key] = x; }
    const countRate = fin(v.countRate_kcps) ? num(v.countRate_kcps) : null;
    return {
      id: r.id, source, sampleName: r.sampleName || r.batchId || '', batchId: r.batchId || null,
      experimentId: source === 'inbox' ? null : (r.experimentId || batchById.get(r.batchId)?.experimentId || null),
      test: r.test, stage: r.stage || '', condition: r.condition ?? null, timepoint: r.timepoint ?? null,
      metrics, countRate, flags: qcFindings(r.test, metrics, countRate, qc), outliers: [],
    };
  });

  // Unlike the rest: judged within one test and one metric, across everything this import brought in.
  for (const t of tests) {
    const group = samples.filter((s) => s.test === t);
    for (const mt of metricsByTest[t]) {
      const zs = robustZ(group.map((s) => s.metrics[mt.key]?.mean ?? NaN));
      group.forEach((s, i) => {
        if (zs[i] == null || Math.abs(zs[i]) <= OUTLIER_Z) return;
        s.outliers.push({ metric: mt.key, z: zs[i] });
        s.flags.push({ level: 'info', kind: 'outlier', metric: mt.key, text: `${mt.label} ${withUnit(s.metrics[mt.key].mean, mt)} is far ${zs[i] > 0 ? 'above' : 'below'} the rest of this import (robust z ${fx(zs[i], 1)})` });
      });
    }
  }

  // Experiment by experiment, then in the order a person reads sample names; the inbox rows come last.
  samples.sort((a, b) => (a.source === 'inbox') - (b.source === 'inbox') || expNo(a.experimentId) - expNo(b.experimentId)
    || natural(a.experimentId || '', b.experimentId || '') || natural(a.sampleName, b.sampleName) || testRank(a.test) - testRank(b.test));

  const touched = [...new Set(samples.map((s) => s.experimentId).filter(Boolean))].sort((a, b) => expNo(a) - expNo(b) || natural(a, b));
  // An import can touch many experiments, and each summary needs only its own records: they are grouped by
  // experiment once here, so a summary never passes over the whole measurement store (cycle 4, S2).
  const expById = byId(experiments);
  const msByExp = groupBy(measurements || records, (m) => m.experimentId);
  const batchesByExp = groupBy(batches, (b) => b.experimentId);
  const testsOf = groupBy(samples, (s) => s.experimentId);
  const exps = touched.map((id) => expById.get(id)).filter(Boolean).map((exp) => experimentStatus(exp, {
    batches: batchesByExp.get(exp.id) || [], measurements: msByExp.get(exp.id) || [], importRecords: records,
    tests: tests.filter((t) => (testsOf.get(exp.id) || []).some((s) => s.test === t)), metricsByTest, today,
  }));

  const byTest = Object.fromEntries(tests.map((t) => {
    const mine = samples.filter((s) => s.test === t);
    return [t, { n: mine.length, metrics: metricsByTest[t].map((mt) => ({ ...mt, ...(describe(mine.map((s) => s.metrics[mt.key]?.mean ?? NaN), mt.key) || { n: 0 }) })) }];
  }));
  // Rows in the file that went nowhere: unticked in the preview, or marked as a blank.
  const samplesInFile = Number.isFinite(info?.samples) ? info.samples : records.length + inbox.length;
  const placed = Number.isFinite(info?.imported) && Number.isFinite(info?.inbox) ? info.imported + info.inbox : records.length + inbox.length;
  const headline = {
    samples: samplesInFile,
    stored: records.length,
    inbox: inbox.length,
    skipped: Math.max(0, samplesInFile - placed),
    flagged: samples.filter((s) => s.flags.length).length,
    warned: samples.filter((s) => s.flags.some((f) => f.level === 'warn')).length,
    singleRun: samples.filter((s) => Object.values(s.metrics).some((m) => m.n < 2)).length,
    experiments: exps.length,
    tests, byTest,
  };
  return { tests, metrics: metricsByTest, samples, experiments: exps, headline };
}
