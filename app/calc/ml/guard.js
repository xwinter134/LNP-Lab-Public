// Checks on what the user typed into the optimizer's setup, kept apart from the screen so they can be tested:
// goals that cannot mean what they say, search ranges that are backwards or empty, hard limits no result can
// meet, and what a factor that is switched off is held at.
import { ALL_FACTORS, COMPOSITION_FACTORS } from './space.js';
import { FACTORS } from '../experiment.js';

const num = (v) => (v == null || v === '' ? null : Number(v));

/** Limits that cannot mean what they say. Caught here rather than silently degrading the score. */
export function goalProblems(goals) {
  const out = [];
  for (const g of goals.filter((x) => x.on !== false)) {
    const name = g.label || g.name;
    const n = num;
    if (g.goal === 'target') {
      const [lo, t, hi] = [n(g.lo), n(g.target), n(g.hi)];
      if (lo == null || t == null || hi == null) out.push(`${name}: the ideal value and both limits are needed.`);
      else if (!(lo < hi)) out.push(`${name}: the low limit must be below the high limit.`);
      else if (!(lo <= t && t <= hi)) out.push(`${name}: the ideal value ${t} is outside the acceptable range ${lo} to ${hi}.`);
    } else if (g.goal === 'range') {
      const [lo, hi] = [n(g.lo), n(g.hi)];
      if (lo == null || hi == null) out.push(`${name}: both ends of the acceptable band are needed.`);
      else if (!(lo < hi)) out.push(`${name}: the low end of the band must be below the high end.`);
    } else {
      const [best, worst] = [n(g.best), n(g.worst)];
      if (best == null || worst == null) out.push(`${name}: both the ideal and the unacceptable value are needed.`);
      else if (g.goal === 'minimize' && !(best < worst)) out.push(`${name}: for a goal of "as low as possible" the ideal ${best} must be below the unacceptable ${worst}. As entered, every run at or below ${best} scores the same.`);
      else if (g.goal === 'maximize' && !(best > worst)) out.push(`${name}: for a goal of "as high as possible" the ideal ${best} must be above the unacceptable ${worst}. As entered, every run at or above ${best} scores the same.`);
    }
    if ((g.weight ?? 1) < 0) out.push(`${name}: a negative weight is not meaningful; use 0 to switch the goal off.`);
  }
  return out;
}

/**
 * Search ranges that cannot be searched: an empty bound, a low above the high, or the two equal. The suggestions
 * are not computed from such a range (they all sat at the low value, or below anything ever run).
 * @returns {{key:string, name:string, text:string}[]}
 */
export function rangeProblems(space) {
  const out = [];
  for (const s of space || []) {
    const [lo, hi] = [num(s.lo), num(s.hi)];
    const name = s.name || s.key;
    let text = null;
    if (lo == null || !Number.isFinite(lo) || hi == null || !Number.isFinite(hi)) text = `${name}: both ends of the search range are needed.`;
    else if (lo > hi) text = `${name}: the range runs backwards (from ${lo} to ${hi}); the low end must be below the high end.`;
    else if (lo === hi) text = `${name}: the low and high ends are both ${lo}, so there is nothing to search; switch the factor off to hold it there.`;
    if (text) out.push({ key: s.key, name, text });
  }
  return out;
}

/**
 * A hard limit no real result can meet or can fail: PDI below 0.001, a size below 1 nm, an encapsulation above
 * 100 %. With such a limit every setting is predicted to breach it, so the screen must not go on to say the
 * best candidates are confirmed.
 * @param {object[]} constraints active limits {name, op:'<'|'>', value}
 */
const IMPOSSIBLE = { PDI: { below: 0.001, above: 1 }, particle_size_nm: { below: 1 }, encapsulation_efficiency: { above: 100 } };
export function limitProblems(constraints) {
  const out = [];
  for (const c of constraints || []) {
    if (c.on === false) continue;
    const v = num(c.value), lim = IMPOSSIBLE[c.name];
    if (v == null || !Number.isFinite(v) || !lim) continue;
    const label = c.name === 'PDI' ? 'PDI' : c.name === 'particle_size_nm' ? 'Particle size' : c.name === 'encapsulation_efficiency' ? 'Encapsulation efficiency' : c.name;
    if (c.op === '<' && lim.below != null && v < lim.below) out.push(`${label} must be below ${v}, which no measurement can reach.`);
    else if (c.op === '>' && lim.above != null && v >= lim.above) out.push(`${label} must be above ${v}, which no measurement can reach.`);
  }
  return out;
}

/**
 * What each switched-off factor is held at when a batch is made, and where that value comes from, so the screen
 * can say it. The process factors are the batch defaults (calc/experiment.js FACTORS, the lab's Settings where
 * they have one); a lipid is the parent recipe's share. N/P has no default: it follows from the RNA mass.
 * @param {object} a {space, settings, baseClasses: class mol% of the parent recipe}
 * @returns {Object<string,{value:number|null, unit:string, source:string}>}
 */
export function heldValues({ space, settings = {}, baseClasses = null }) {
  const on = new Set((space || []).map((s) => s.key));
  const fromSettings = { frr: settings.defaultFRR, quench: settings.defaultQuenchFactor, lipid_mM: settings.defaultLipidStock_mM, rna_mg_mL: settings.defaultWorking_mg_mL };
  const out = {};
  for (const f of ALL_FACTORS) {
    if (on.has(f.key)) continue;
    const comp = COMPOSITION_FACTORS.find((c) => c.key === f.key);
    if (comp) {
      const v = baseClasses?.[comp.cls];
      out[f.key] = { value: Number.isFinite(v) ? v : null, unit: f.unit, source: 'the parent recipe' };
      continue;
    }
    const dflt = FACTORS.find((x) => x.key === f.key)?.default;
    const own = fromSettings[f.key];
    if (Number.isFinite(own)) out[f.key] = { value: Number(own), unit: f.unit, source: 'your Settings default' };
    else if (Number.isFinite(dflt) && f.key !== 'np') out[f.key] = { value: dflt, unit: f.unit, source: 'app default' };
    else out[f.key] = { value: null, unit: f.unit, source: 'no fixed default' };
  }
  return out;
}

const short = (f) => String(f.name || f.key).replace(/\s*\(.*\)\s*$/, '');
const trimNum = (v) => String(Number(Number(v).toFixed(3)));

/**
 * The note for each factor that is switched off and that the earlier runs recorded: what it is held at, and,
 * when those runs varied it, that the model will read their differences as noise.
 * @param {object} a {space, held: heldValues(), observed: {key:{n, distinct, lo, hi}}}
 * @returns {{key:string, varied:boolean, text:string}[]}
 */
export function heldNotes({ space, held, observed }) {
  const on = new Set((space || []).map((s) => s.key));
  const out = [];
  for (const f of ALL_FACTORS) {
    const o = observed?.[f.key];
    if (on.has(f.key) || !o?.n) continue;
    const h = held[f.key];
    const unit = f.unit ? ` ${f.unit}` : '';
    const at = h?.value != null ? `${trimNum(h.value)}${unit} (${h.source})` : 'whatever each batch record carries (no fixed default)';
    const varied = o.distinct >= 2;
    // a lipid that is simply not being varied is the ordinary case: only worth a line when the runs varied it
    if (!varied && COMPOSITION_FACTORS.some((c) => c.key === f.key)) continue;
    out.push({ key: f.key, varied, text: varied
      ? `${short(f)} held at ${at}, not the value your earlier runs varied (${trimNum(o.lo)} to ${trimNum(o.hi)}${unit}). The model treats those differences as noise. Switch it on to let the optimizer set it.`
      : `${short(f)} held at ${at}.` });
  }
  return out;
}
