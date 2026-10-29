// What a batch is actually made from: the registry recipe it points at, with the batch's own override applied.
//
// This lives in calc rather than in the formulation screen because more than one place has to give the same
// answer — the bench record, the DoE run table and its exports, the stock weigh-in — and two answers to "what
// goes into the flask" is how a batch gets made from one recipe and analysed as another.
//
// It is computed every time a batch is shown, never stored on the batch. That is deliberate: a batch saved
// before the rebalancing existed, with nothing but `peg_pct: 1.75` on its plan, is read through the same
// function and shows the same balanced recipe as one created today. Old records are fixed without a migration.

/** The lipid classes a class-based override can name, in the order a recipe is written. */
const CLASSES = ['ionizable', 'helper', 'sterol', 'peg', 'other'];

/** How a class reads in a sentence: "absorbs the PEG change". */
export const CLASS_WORD = { ionizable: 'ionizable lipid', helper: 'helper lipid', sterol: 'sterol', peg: 'PEG', other: 'other lipid' };

/** The class that takes up the slack when another class is set: sterol, as the ML optimizer does (ml/space.js). */
export const BALANCE_CLASS = 'sterol';

const r3 = (v) => Math.round(v * 1000) / 1000;
const total = (mol) => r3(Object.values(mol).reduce((a, b) => a + b, 0));

/**
 * A composition with a batch's override applied, keyed by lipid as the registry is.
 *
 * Two kinds of override reach this. A mixture design names every lipid and its mol% outright, in
 * `override.mol_pct`, because that is the whole point of the design — the run *is* the blend. Everything
 * else records class percentages (ionizable, helper, peg, sterol), and the existing proportions between
 * lipids within a class are kept.
 *
 * A class override that moves the ionizable lipid, the helper or the PEG and says nothing about the sterol
 * is rebalanced: the sterol takes up the difference, split across the sterol lipids in the proportions they
 * already had, so the recipe still totals what the registry recipe totals (100 mol%). That is what a
 * formulator does by hand and what the ML optimizer has always done (`pointToPlan` in ml/space.js); a DoE or
 * OFAT factor on PEG or ionizable mol% used to leave it at 100.25 and ask the operator to decide at the
 * bench, for every run (usability cycle 3, C2). Which lipids absorbed it is recorded in `balancedBy`, so the
 * record can say so.
 *
 * Not rebalanced, and left for the warning on the record:
 *   · an override that sets the sterol itself — the optimizer writes every class, already balanced, and
 *     anything else that names the sterol meant that number;
 *   · a recipe with no sterol, where there is nothing conventional to take up the slack;
 *   · a change too large for the sterol to absorb (it would go to zero or below). `balancedBy.impossible`
 *     then says by how much.
 *
 * @param {object} comp      registry entry {id, mol_pct:{lipidKey: mol%}, ...}
 * @param {object} override  a batch's plan.compositionOverride, or null
 * @param {object} ref       {lipidByKey: {key: {class}}}
 * @returns the registry entry unchanged when there is nothing to apply; otherwise a copy with `mol_pct`,
 *   `sum`, `overriddenFrom`, and `fromMixtureDesign` or `balancedBy` when they apply.
 */
export function overriddenComposition(comp, override, ref) {
  if (!comp?.mol_pct || !override) return comp;
  if (override.mol_pct && Object.keys(override.mol_pct).length) {
    const mol_pct = Object.fromEntries(Object.entries(override.mol_pct)
      .map(([k, v]) => [k, r3(Number(v))]).filter(([, v]) => Number.isFinite(v)));
    return { ...comp, mol_pct, sum: total(mol_pct), overriddenFrom: comp.id, fromMixtureDesign: true };
  }
  const want = {};
  for (const cls of CLASSES) {
    const v = Number.isFinite(override[cls]) ? override[cls] : Number.isFinite(override[`${cls}_pct`]) ? override[`${cls}_pct`] : null;
    if (v != null) want[cls] = Number(v);
  }
  if (!Object.keys(want).length) return comp;
  const byClass = {};
  for (const [k, v] of Object.entries(comp.mol_pct)) (byClass[ref?.lipidByKey?.[k]?.class || 'other'] ||= []).push([k, Number(v)]);
  const current = Object.fromEntries(Object.entries(byClass).map(([cls, members]) => [cls, members.reduce((a, [, v]) => a + v, 0)]));

  // How far the classes the override set have moved, in total. Classes the recipe does not contain are not
  // applied below either, so they do not count here.
  const changed = Object.keys(want).filter((cls) => byClass[cls] && Math.abs(want[cls] - current[cls]) > 1e-9);
  const delta = changed.reduce((s, cls) => s + (want[cls] - current[cls]), 0);
  let balancedBy = null;
  if (want[BALANCE_CLASS] == null && changed.length && current[BALANCE_CLASS] > 0) {
    const keys = byClass[BALANCE_CLASS].map(([k]) => k);
    const target = current[BALANCE_CLASS] - delta;
    if (target > 0) {
      want[BALANCE_CLASS] = target;
      balancedBy = { cls: BALANCE_CLASS, keys, changed, delta: r3(-delta) };
    } else {
      balancedBy = { cls: BALANCE_CLASS, keys, changed, delta: r3(-delta), impossible: true, wouldBe: r3(target) };
    }
  }

  const mol_pct = {};
  for (const [cls, members] of Object.entries(byClass)) {
    const target = want[cls] != null ? want[cls] : current[cls];
    for (const [k, v] of members) mol_pct[k] = r3(current[cls] > 0 ? (v / current[cls]) * target : target / members.length);
  }
  return { ...comp, mol_pct, sum: total(mol_pct), overriddenFrom: comp.id, ...(balancedBy ? { balancedBy } : {}) };
}

/** "absorbs the PEG change", "absorbs the ionizable lipid and PEG changes": what the balancing lipid did. */
export function absorbedPhrase(balancedBy) {
  if (!balancedBy?.changed?.length) return '';
  const names = CLASSES.filter((c) => balancedBy.changed.includes(c)).map((c) => CLASS_WORD[c]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  return `absorbs the ${list} change${names.length > 1 ? 's' : ''}`;
}

/**
 * The batch-parameter keys of experiment.js FACTORS that set a lipid class: a factor applied to one of
 * these writes a class override, which overriddenComposition then rebalances.
 */
export const CLASS_FACTOR_KEYS = { peg_pct: 'peg', ionizable_pct: 'ionizable' };

/**
 * The balancing lipid as a column of a process design's run table: for each run, the mol% the sterol has to
 * be for that run's lipid settings to total 100.
 *
 * A design that varies PEG from 1 to 2.5 mol% is, at the bench, a design whose cholesterol goes from 39 to
 * 37.5, and a run table that shows only the PEG column hides half of what is weighed out. Worked out from the
 * same function as the bench record, from the design's own settings, so it is there for a design created
 * before the rebalancing existed too.
 *
 * @param {object} spec   the DoE spec; only factors with an `applyTo` in CLASS_FACTOR_KEYS matter
 * @param {Array} runs    rows as buildDesign returns them
 * @param {number} compositionId  the registry composition the experiment was made from
 * @param {object} ref    {lipidByKey, compositionById}
 * @returns {null | {label:string, sub:string, keys:string[], values:{[run_id]:number}, note:string}} null when
 *   the design sets no lipid class, or the recipe has no sterol to balance with.
 */
export function balanceColumn(spec, runs, compositionId, ref) {
  const comp = ref?.compositionById?.[compositionId];
  if (!comp?.mol_pct || (spec?.mode && spec.mode !== 'process')) return null;
  const lipidFactors = (spec?.factors || []).filter((f) => CLASS_FACTOR_KEYS[f.applyTo]);
  if (!lipidFactors.length) return null;
  const values = {};
  let keys = null, phrase = '';
  for (const r of runs) {
    const override = Object.fromEntries(lipidFactors.map((f) => [f.applyTo, Number(r.real?.[f.name])]).filter(([, v]) => Number.isFinite(v)));
    const c = overriddenComposition(comp, override, ref);
    const bal = c?.balancedBy;
    if (bal) keys = bal.keys;
    // A run at the registry's own settings changes nothing and so has no `balancedBy`; its sterol is still
    // a number the operator weighs out, so it is read straight from the recipe.
    const sterolKeys = bal?.keys || Object.keys(c?.mol_pct || {}).filter((k) => ref?.lipidByKey?.[k]?.class === BALANCE_CLASS);
    if (!sterolKeys.length) continue;
    // A run the sterol cannot balance gets an empty cell rather than the unbalanced number; its bench record
    // says what went wrong.
    values[r.run_id] = bal?.impossible ? NaN : r3(sterolKeys.reduce((s, k) => s + (c.mol_pct[k] || 0), 0));
    if (bal && !bal.impossible && !phrase) phrase = absorbedPhrase({ ...bal, changed: lipidFactors.map((f) => CLASS_FACTOR_KEYS[f.applyTo]) });
  }
  if (!Object.keys(values).length) return null;
  keys ||= Object.keys(comp.mol_pct).filter((k) => ref?.lipidByKey?.[k]?.class === BALANCE_CLASS);
  const label = keys.length === 1 ? (ref?.lipidByKey?.[keys[0]]?.name || keys[0]) : 'Sterol';
  return { label, sub: 'mol% (balance)', keys, values, note: `${label} ${phrase || 'takes up the difference'}, so every run totals 100 mol%.` };
}
