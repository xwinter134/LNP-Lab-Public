// From the lab's records to a fitted, scored optimizer run, in the order the transparency panel reports it
// (spec 7.4): which formulations (select.js), which lipid mode (lipidmode.js), the fit (optimizer.js), and the
// fingerprint that lets the run be made again (fingerprint.js). The screen and "Reproduce" both go through here,
// so a reproduction takes exactly the path the original did.
import { selectData, lipidMixerCombos, mergeRows, BUDGET, clampBudget } from './select.js';
import { modeAvailability, modesToTry, descriptorVector, KERNEL_MIN, LIPID_MODES } from './lipidmode.js';
import { NOT_RECORDED, usableRows } from './dataset.js';
import { fitModels, score } from './optimizer.js';
import { makeFingerprint, compareFingerprints, setupOf } from './fingerprint.js';
import { classPercents } from './space.js';

/** The combination preselected when the optimizer opens: the lipid and mixer type with most measured runs. */
export function defaultSelection(rows) {
  const c = lipidMixerCombos(rows)[0];
  return c ? { lipid: c.lipid, mixer: c.mixer } : { lipid: null, mixer: null };
}

/**
 * The selection and the modes the data allows, before anything is fitted: cheap, so the panel can show it while
 * the user is still choosing.
 * @param {object[]} rows  buildRows() output (already narrowed to a hand-over from Data, if any)
 * @param {object} o  {space, goals, lipid, mixer, lipidMode: 'auto'|'filter'|'kernel'|'descriptor', budget, seed,
 *   descriptorsOn, lipidByKey, handedIds}
 */
export function prepare(rows, o) {
  const names = o.goals.filter((g) => g.on !== false).map((g) => g.name);
  const sameMixer = o.mixer == null ? rows : rows.filter((r) => (r.mixerType || NOT_RECORDED) === o.mixer);
  const usable = usableRows(o.handedIds ? sameMixer.filter((r) => o.handedIds.has(r.batchId)) : sameMixer, o.space, names);
  const avail = modeAvailability(usable, o.lipid, { descriptorsOn: !!o.descriptorsOn, lipidByKey: o.lipidByKey || {} });
  const tries = modesToTry(o.lipidMode || 'filter', avail);
  const per = {};
  for (const r of usable) per[r.lipid || NOT_RECORDED] = (per[r.lipid || NOT_RECORDED] || 0) + 1;
  const lipidOk = {
    kernel: (l) => (l === NOT_RECORDED ? 'lipid not recorded' : per[l] >= KERNEL_MIN.share ? true : `fewer than ${KERNEL_MIN.share} runs to share`),
    descriptor: (l) => (descriptorVector(o.lipidByKey?.[l]) ? true : 'no descriptors entered'),
  };
  const sels = Object.fromEntries(tries.map((m) => [m, selectData(rows, { ...o, mode: m, lipidOk: lipidOk[m], budget: clampBudget(o.budget ?? BUDGET.default) })]));
  return { avail, tries, sels, choice: o.lipidMode || 'filter', lipid: o.lipid ?? null, mixer: o.mixer ?? null, combos: lipidMixerCombos(rows), total: rows.length };
}

/** The mean cross-validated Q² of the Gaussian processes over the responses that have one: what auto compares. */
export const meanGpQ2 = (fit) => {
  const q = (fit.responses || []).map((r) => r.gpQ2).filter(Number.isFinite);
  return q.length ? q.reduce((a, b) => a + b, 0) / q.length : null;
};

/**
 * Fit every mode prepare() said to try, and keep the one with the higher Q² (filter on a tie or when neither can
 * be scored: the mode that assumes least). The fit carries how it was chosen (`lipidChoice`) and its selection.
 */
export function fitPrepared(prep, { space, goals, strategy = 'experiment', seed = 7, lipidByKey = {}, rank = 1 }) {
  const fits = {};
  for (const m of prep.tries) {
    const sel = prep.sels[m];
    fits[m] = fitModels({ rows: sel.target, space, goals, strategy, seed, noise: sel.noise,
      lipidModel: m === 'filter' ? null : { mode: m, targetLipid: prep.lipid, others: sel.others, rank, descOf: (l) => descriptorVector(lipidByKey[l]) } });
  }
  const compared = prep.tries.map((m) => ({ mode: m, q2: meanGpQ2(fits[m]) }));
  let chosen = compared[0];
  for (const c of compared.slice(1)) if (c.q2 != null && (chosen.q2 == null || c.q2 > chosen.q2)) chosen = c;
  const fit = fits[chosen.mode];
  fit.lipidChoice = { mode: chosen.mode, chosenBy: prep.choice === 'auto' ? 'auto' : 'user', compared, availability: prep.avail, requested: prep.choice, rank: chosen.mode === 'kernel' ? rank : 1 };
  fit.selection = prep.sels[chosen.mode];
  if (chosen.mode === 'descriptor') fit.lipidDescriptors = descriptorsUsed(fit.selection, prep.lipid, (l) => descriptorVector(lipidByKey[l]));
  return fit;
}

/** The descriptor vector of every lipid a descriptor-mode fit read, keyed by lipid, for the fingerprint. */
function descriptorsUsed(sel, target, descOf) {
  const out = {};
  for (const l of new Set([target, ...(sel?.others || []).map((r) => r.lipid)])) if (l != null) out[l] = descOf(l) || null;
  return out;
}

/** The mode in a sentence, as the panel's first line says it (spec 7.4). */
export function modeSentence(fit) {
  const c = fit?.lipidChoice;
  if (!c) return LIPID_MODES.filter.long;
  const name = LIPID_MODES[c.mode]?.label || c.mode;
  const q = (v) => (v == null ? 'not testable' : v.toFixed(2));
  if (c.chosenBy === 'auto' && c.compared.length > 1) {
    const rest = c.compared.filter((x) => x.mode !== c.mode).map((x) => `${q(x.q2)} in ${(LIPID_MODES[x.mode]?.label || x.mode).toLowerCase()} mode`).join(', ');
    return `${name} (chosen automatically, Q² ${q(c.compared.find((x) => x.mode === c.mode).q2)} against ${rest})`;
  }
  if (c.chosenBy === 'auto') return `${name} (chosen automatically: the only mode these data allow)`;
  if (c.requested !== c.mode) return `${name} (${LIPID_MODES[c.requested]?.label || c.requested} is not available for these data)`;
  return `${name} (fixed by you)`;
}

/**
 * The whole run: select, fit, score, fingerprint. `o` is the screen's setup plus {rows, ref, appVersion,
 * descriptorsOn, handedIds, baseComposition}.
 */
export function runOptimizer(rows, o) {
  const prep = prepare(rows, o);
  const fit = fitPrepared(prep, o);
  const baseClasses = o.baseComposition && o.ref ? classPercents(o.baseComposition, o.ref) : undefined;
  const report = score(fit, { goals: o.goals, constraints: o.constraints || [], q: o.q ?? 4, mode: o.mode || 'balanced', seed: o.seed ?? 7, baseClasses });
  report.prep = prep;
  report.fingerprint = makeFingerprint({ report, setup: setupOf({ ...o, baseClasses }), appVersion: o.appVersion || '' });
  return report;
}

/**
 * Make a fingerprinted run again on today's records and say whether it comes out the same (spec 7.5). The
 * training points are rebuilt from the recorded ids, a merged point from its runs in their recorded order, so
 * neither the data budget nor the lipid mode is chosen again; the recorded mode, setup and replicate noise are
 * used as they were.
 * @param {object} fp    a fingerprint (makeFingerprint)
 * @param {object[]} rows  buildRows() output now
 * @param {object} o     {lipidByKey, ref, baseComposition, appVersion}
 */
export function reproduce(fp, rows, o = {}) {
  const byId = new Map(rows.map((r) => [r.batchId, r]));
  const missing = [];
  const rebuilt = [];
  for (const id of fp.ids) {
    const ids = Array.isArray(id) ? id : [id];
    const g = ids.map((x) => byId.get(x)).filter(Boolean);
    if (g.length !== ids.length) { missing.push(...ids.filter((x) => !byId.has(x))); continue; }
    rebuilt.push(g.length > 1 ? mergeRows(g) : g[0]);
  }
  if (missing.length) {
    return { match: false, data: false, missing, sentence: `Not reproduced: ${missing.length} formulation${missing.length === 1 ? ' it used is' : 's it used are'} no longer in the records (${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ', …' : ''}).` };
  }
  const s = fp.setup;
  const target = rebuilt.slice(0, fp.nTarget), others = rebuilt.slice(fp.nTarget);
  const fit = fitModels({ rows: target, space: s.space, goals: s.goals, strategy: s.strategy, seed: s.seed, noise: fp.noise || null,
    lipidModel: fp.mode === 'filter' ? null : { mode: fp.mode, targetLipid: s.lipid, others, rank: fp.rank ?? 1,
      // the descriptors as recorded; a fingerprint older than that field reads today's
      descOf: (l) => (fp.descriptors ? fp.descriptors[l] ?? null : descriptorVector(o.lipidByKey?.[l])) } });
  fit.lipidChoice = { mode: fp.mode, chosenBy: fp.chosenBy, compared: fp.compared, requested: s.lipidMode, rank: fp.rank ?? 1 };
  fit.selection = { others, noise: fp.noise || null };
  if (fp.descriptors) fit.lipidDescriptors = fp.descriptors;
  const report = score(fit, { goals: s.goals, constraints: s.constraints, q: s.q, mode: s.acquisition, seed: s.seed, baseClasses: s.baseClasses || undefined });
  const now = makeFingerprint({ report, setup: s, appVersion: o.appVersion ?? fp.appVersion });
  return { ...compareFingerprints(fp, now), now, report };
}
