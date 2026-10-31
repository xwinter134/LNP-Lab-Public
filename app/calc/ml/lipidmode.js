// What the model knows about the ionizable lipid (spec 7.3): three modes, and the rule that chooses between them.
//
//   filter       nothing. One model per lipid, fitted to that lipid's runs only. Always available, the default,
//                and the only mode that cannot be misled by another lipid behaving differently.
//   kernel       the lipid as a category. k((x,a),(x',b)) = Matérn(x, x') · B[a,b] with B = W Wᵀ + diag(v)
//                (gp.js, rank 1 or 2), fitted with the lengthscales by marginal likelihood. B says, from the
//                results, how alike the lipids behave: a lipid with few runs borrows the shape of the surface
//                from the others as far as B says they agree, and no further. A lipid with no runs at all has no
//                row in B worth the name, so it cannot be predicted, and the screen says so. Available from two
//                lipids with eight or more runs each (KERNEL_MIN), and only for a lipid that has runs itself.
//   descriptor   the lipid as a handful of physical numbers (DESCRIPTORS: pKa, tails, chain length,
//                unsaturation, logP, head group), each a further input with its own lengthscale. Behind a
//                feature flag (Settings, off) and only from about twenty lipids with descriptors entered
//                (DESCRIPTOR_MIN_LIPIDS): the descriptors are constant per lipid, so in descriptor space there
//                are only as many points as lipids, and six lengthscales on ten points is overfitting by
//                construction. Computing them from SMILES needs RDKit.js, a new dependency, so for now they are
//                typed in Materials > Lipids; that is an open point.
//   auto         the rule below; when more than one mode is possible, the one with the higher cross-validated Q²
//                on the chosen lipid's runs, on the same held-out groups (model.js), is used, and the screen
//                quotes both figures. Any available mode can be fixed instead.
//
// Every mode's Gaussian process goes through model.js evaluateResponse as a learner in its own right
// (`learnerMap`), so it is cross-validated, null-checked and given its verdict by the same procedure as the
// plain one, not beside it.
import { fitGP, fixedInputView } from './gp.js';
import { CV_GP, standardise } from './model.js';
import { NOT_RECORDED } from './dataset.js';

export const LIPID_MODES = {
  filter: { label: 'Filter', long: 'Filter: one model per ionizable lipid', note: 'only the chosen lipid\'s runs; nothing is assumed about the others' },
  kernel: { label: 'Categorical lipid kernel', long: 'Categorical lipid kernel', note: 'every lipid\'s runs, with how alike the lipids behave learned from the results' },
  descriptor: { label: 'Lipid descriptors', long: 'Lipid descriptors', note: 'every lipid\'s runs, with each lipid described by a few physical numbers' },
};
export const MODE_CHOICES = ['auto', 'filter', 'kernel', 'descriptor'];

/** The kernel needs this many lipids with this many runs each; other lipids join from `share` runs. */
export const KERNEL_MIN = { lipids: 2, runs: 8, share: 3 };
/** The descriptor mode opens from about this many distinct lipids with descriptors (spec 7.3). */
export const DESCRIPTOR_MIN_LIPIDS = 20;

/**
 * The descriptors a lipid record may carry (lipid.descriptors), entered by hand in Materials > Lipids. pKa is
 * the apparent pKa of the formulated lipid (TNS assay); the rest are read off the structure. The head group
 * enters as a number on a short ordinal scale, which is crude, and is why it is one of six rather than a
 * one-hot block of its own.
 */
export const DESCRIPTORS = [
  { key: 'pKa', name: 'Apparent pKa', unit: '', lo: 5, hi: 8, step: 0.01 },
  { key: 'tails', name: 'Number of tails', unit: '', lo: 1, hi: 6, step: 1 },
  { key: 'chainLength', name: 'Mean chain length', unit: 'C', lo: 8, hi: 24, step: 0.5 },
  { key: 'unsaturation', name: 'Double bonds per tail', unit: '', lo: 0, hi: 4, step: 0.5 },
  { key: 'logP', name: 'logP', unit: '', lo: 5, hi: 25, step: 0.1 },
  { key: 'headGroup', name: 'Head group', kind: 'category', options: ['tertiary amine', 'piperazine or ring amine', 'quaternary ammonium', 'other'] },
];

/** A lipid's descriptors on [0, 1] each, or null when any is missing. */
export function descriptorVector(lipid) {
  const d = lipid?.descriptors;
  if (!d) return null;
  const out = [];
  for (const f of DESCRIPTORS) {
    if (f.kind === 'category') {
      const i = f.options.indexOf(d[f.key]);
      if (i < 0) return null;
      out.push(f.options.length > 1 ? i / (f.options.length - 1) : 0);
    } else {
      const v = Number(d[f.key]);
      if (d[f.key] == null || d[f.key] === '' || !Number.isFinite(v)) return null;
      out.push(Math.max(-0.5, Math.min(1.5, (v - f.lo) / (f.hi - f.lo))));
    }
  }
  return out;
}

/**
 * Which modes the data allows for one lipid, and why not the others.
 * @param {object[]} rows  usable rows after the mixer filter, every lipid (select.js, mode 'kernel')
 * @param {string} target  the chosen lipid
 * @param {object} o  {descriptorsOn: the feature flag, lipidByKey}
 * @returns {{filter, kernel, descriptor}} each {ok, why}
 */
export function modeAvailability(rows, target, { descriptorsOn = false, lipidByKey = {} } = {}) {
  const per = {};
  for (const r of rows) per[r.lipid || NOT_RECORDED] = (per[r.lipid || NOT_RECORDED] || 0) + 1;
  const own = per[target] || 0;
  const rich = Object.entries(per).filter(([k, n]) => k !== NOT_RECORDED && n >= KERNEL_MIN.runs);
  const kernel = target == null || target === NOT_RECORDED ? { ok: false, why: 'the ionizable lipid of these runs is not recorded' }
    : own === 0 ? { ok: false, why: `${target} has no runs of its own; the lipid kernel cannot predict a lipid it has never seen` }
    : rich.length < KERNEL_MIN.lipids ? { ok: false, why: `needs ${KERNEL_MIN.lipids} lipids with at least ${KERNEL_MIN.runs} runs each; ${rich.length ? `only ${rich.map(([k, n]) => `${k} (${n})`).join(', ')} ${rich.length === 1 ? 'has' : 'have'} that many` : 'none has that many'}` }
    : { ok: true, why: `${rich.length} lipids with ${KERNEL_MIN.runs} or more runs` };
  let descriptor;
  if (!descriptorsOn) descriptor = { ok: false, why: 'switched off in Settings (Optimizer, lipid descriptors)' };
  else {
    const withDesc = Object.keys(per).filter((k) => descriptorVector(lipidByKey[k]));
    descriptor = !descriptorVector(lipidByKey[target]) ? { ok: false, why: `no descriptors entered for ${target} (Materials > Lipids)` }
      : withDesc.length < DESCRIPTOR_MIN_LIPIDS ? { ok: false, why: `needs about ${DESCRIPTOR_MIN_LIPIDS} lipids with descriptors and runs; ${withDesc.length} have both` }
      : { ok: true, why: `${withDesc.length} lipids with descriptors` };
  }
  return { filter: { ok: true, why: 'always available' }, kernel, descriptor };
}

/** The mode to fit: the user's choice when it is available, else filter; 'auto' lists what to compare. */
export function modesToTry(choice, avail) {
  if (choice && choice !== 'auto') return [avail[choice]?.ok ? choice : 'filter'];
  return ['filter', 'kernel', 'descriptor'].filter((m) => avail[m]?.ok);
}

/**
 * The lipid-aware Gaussian process for one response, as a learner model.js can cross-validate (crossValidate
 * hands cvFit the indices of the training rows). `extra` is the other lipids' runs with a value for this
 * response: their unit coordinates, values and experiments. Each lipid's values are standardised on their own,
 * as the chosen lipid's are by crossValidate, so B compares shapes and not levels. In cross-validation the
 * other lipids' runs from an experiment held out are held out with it: an experiment run on two lipids shares
 * its day, its stocks and its operator, and keeping one half in training would leak into the other.
 *
 * @param {object} o  {mode: 'kernel'|'descriptor', targetExp: experiment ids of the chosen lipid's rows,
 *   extra: {X, y, lipid, exp}, targetLipid, rank, descOf: lipid -> descriptor vector (descriptor mode)}
 */
export function lipidLearner(o) {
  const lipids = [o.targetLipid, ...[...new Set(o.extra.lipid)].filter((l) => l !== o.targetLipid).sort()];
  const task = Object.fromEntries(lipids.map((l, i) => [l, i]));
  // Standardised within each lipid, once, over all of that lipid's runs: they are never the ones scored.
  const yStd = new Array(o.extra.y.length);
  for (const l of lipids.slice(1)) {
    const idx = o.extra.lipid.map((x, i) => (x === l ? i : -1)).filter((i) => i >= 0);
    const s = standardise(idx.map((i) => o.extra.y[i]));
    idx.forEach((i, k) => { yStd[i] = s.z[k]; });
  }
  const D = o.extra.X[0]?.length ?? 0;
  const make = (Xt, yt, keep, opts) => {
    const ex = o.extra.X.map((_, i) => i).filter((i) => keep(i));
    if (o.mode === 'descriptor') {
      const dt = o.descOf(o.targetLipid);
      const X = [...Xt.map((x) => [...x, ...dt]), ...ex.map((i) => [...o.extra.X[i], ...o.descOf(o.extra.lipid[i])])];
      const m = fitGP(X, [...yt, ...ex.map((i) => yStd[i])], opts);
      return fixedInputView(m, dt, Xt[0].length);
    }
    const m = fitGP([...Xt, ...ex.map((i) => o.extra.X[i])], [...yt, ...ex.map((i) => yStd[i])],
      { ...opts, tasks: [...Xt.map(() => 0), ...ex.map((i) => task[o.extra.lipid[i]])], nTasks: lipids.length, rank: o.rank || 1 });
    return fixedInputView(m, [0], Xt[0].length);
  };
  return {
    label: o.mode === 'descriptor' ? 'Gaussian process, lipid descriptors' : 'Gaussian process, lipid kernel',
    note: o.mode === 'descriptor' ? 'every lipid\'s runs, each lipid described by its descriptors' : 'every lipid\'s runs, how alike the lipids behave fitted from the results',
    lipids, dims: D,
    fit: (X, y, opts = {}) => make(X, y, () => true, opts),
    cvFit: (X, y, opts = {}, trIdx = null) => {
      const train = new Set(trIdx || []);
      // Only a real experiment id ties runs together; runs without one are not held out with each other.
      const out = new Set(o.targetExp.filter((e, i) => e != null && trIdx && !train.has(i)));
      return make(X, y, (i) => !(o.extra.exp[i] != null && out.has(o.extra.exp[i])), { ...CV_GP, ...opts });
    },
  };
}
