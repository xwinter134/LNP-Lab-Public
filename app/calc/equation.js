// The fitted model written out in the units the factors were set in: "Size = 212.4 − 31.6·FRR + 0.042·flow …".
//
// The coded equation is the one to read effects off (a coefficient is the change per half range, so they
// compare), and the real-unit one is the one to take to the bench or into a spreadsheet: put in an FRR of 3.2
// and a flow of 90 mL/min and out comes the prediction. They are the same model. Each coded factor is
// x = (X − c) / h, with c the centre and h the half range, and substituting that into every term and
// collecting the powers gives the real-unit coefficients.
//
// Two things the real-unit equation cannot do, and the screen says so rather than printing a wrong one:
//
//   A factor whose centre was set off the middle of its range is coded with a different scale on each side
//   (calc/doe.js toReal), so the model is not one polynomial in the real factor; there is no equation to print.
//   A categorical factor (the mixer) has no real value. Its two levels are substituted instead, one equation
//   per mixer, which is how Design-Expert prints it too.
//
// The real-unit coefficients are not comparable with each other: they depend on the units, and their size says
// nothing about importance. Nor can they be rounded as freely: a coefficient on FRR² multiplied by an FRR of 4
// squared amplifies its rounding sixteen times, so they are printed to five significant figures.

import { factorCenter, isCategorical, categoricalName } from './doe.js';

/** A polynomial as a Map from monomial (factor names joined with '*', sorted; '' for the constant) to its coefficient. */
const key = (vars) => vars.slice().sort().join('*');
function mul(a, b) {
  const out = new Map();
  for (const [ka, va] of a) for (const [kb, vb] of b) {
    const k = key([...(ka ? ka.split('*') : []), ...(kb ? kb.split('*') : [])]);
    out.set(k, (out.get(k) || 0) + va * vb);
  }
  return out;
}
function addInto(acc, poly, scale) {
  for (const [k, v] of poly) acc.set(k, (acc.get(k) || 0) + v * scale);
}

/** Whether a numeric factor's centre is the middle of its range, so that one linear coding covers both sides. */
export function symmetricCoding(f) {
  const lo = Number(f.low), hi = Number(f.high), c = factorCenter(f);
  return Math.abs(c - (lo + hi) / 2) <= 1e-9 * Math.max(1, Math.abs(lo), Math.abs(hi));
}

/**
 * The fitted process model in real units, one equation per combination of categorical levels.
 *
 * @param beta     the fitted coefficients, in the order of `terms`
 * @param terms    boxTerms(): each with kind ('intercept' | 'main' | 'interaction' | 'square') and `of`
 * @param factors  the spec's factors [{name, low, high, center?, levels?}]
 * @returns {{ok: true, equations: [{level: string, terms: [{vars: string[], coef}]}]} | {ok: false, why: string}}
 *   `level` names the categorical setting the equation holds at ('' with no categorical factor); `vars` lists
 *   the factor names of a monomial with repeats for powers (['FRR', 'FRR'] is FRR²), [] for the constant.
 */
export function realEquation(beta, terms, factors) {
  if (!beta || !terms?.length || beta.length !== terms.length) return { ok: false, why: 'no fit' };
  const byName = Object.fromEntries(factors.map((f) => [f.name, f]));
  const off = factors.filter((f) => !isCategorical(f) && !symmetricCoding(f));
  if (off.length) {
    return { ok: false, why: `${off.map((f) => f.name).join(' and ')} ${off.length === 1 ? 'has its' : 'have their'} centre off the middle of the range, so the coded model is not one polynomial in real units; read the coded equation instead` };
  }
  if (terms.some((t) => !['intercept', 'main', 'interaction', 'square'].includes(t.kind))) return { ok: false, why: 'only a process model can be written in real units' };
  const cats = factors.filter(isCategorical);
  // every combination of categorical levels, −1/+1 each
  const combos = cats.reduce((acc, f) => acc.flatMap((c) => [-1, 1].map((v) => ({ ...c, [f.name]: v }))), [{}]);
  const equations = combos.map((combo) => {
    // each factor as a polynomial in its real value: a categorical one is a constant at this level
    const coded = (n) => {
      if (n in combo) return new Map([['', combo[n]]]);
      const f = byName[n];
      const lo = Number(f.low), hi = Number(f.high), c = factorCenter(f), h = (hi - lo) / 2;
      return new Map([['', -c / h], [n, 1 / h]]);
    };
    const acc = new Map();
    terms.forEach((t, i) => {
      const parts = t.kind === 'intercept' ? [] : t.kind === 'square' ? [t.of[0], t.of[0]] : t.of;
      const poly = parts.reduce((p, n) => mul(p, coded(n)), new Map([['', 1]]));
      addInto(acc, poly, beta[i]);
    });
    const rank = (vars) => (vars.length === 0 ? 0 : vars.length === 1 ? 1 : new Set(vars).size === 1 ? 3 : 2);
    const order = factors.map((f) => f.name);
    const list = [...acc].map(([k, coef]) => ({ vars: k ? k.split('*').sort((a, b) => order.indexOf(a) - order.indexOf(b)) : [], coef }))
      // a term that only existed through a categorical factor folds into the others; drop what is numerically nothing
      .filter((x) => x.vars.length === 0 || Math.abs(x.coef) > 1e-12 * Math.max(1, ...[...acc.values()].map(Math.abs)))
      .sort((a, b) => rank(a.vars) - rank(b.vars) || order.indexOf(a.vars[0]) - order.indexOf(b.vars[0]) || order.indexOf(a.vars[1]) - order.indexOf(b.vars[1]));
    return { level: cats.map((f) => `${f.name} = ${categoricalName(f, combo[f.name])}`).join(', '), terms: list };
  });
  return { ok: true, equations };
}

/**
 * An equation as text: "Size = 212.4 − 31.6·FRR + 0.0421·flow_rate − 1.2e-4·flow_rate²". Coefficients to `sig`
 * significant figures (five by default, see the head of this file). `label` names a factor, `lhs` the response.
 */
export function equationText(eq, { lhs = 'y', label = (n) => n, sig = 5, times = '·' } = {}) {
  const num = (v) => {
    const a = Math.abs(v);
    if (a === 0) return '0';
    if (a >= 1e-3 && a < 1e6) return String(Number(a.toPrecision(sig)));
    return a.toExponential(sig - 1).replace('e+', 'e');
  };
  const mono = (vars) => {
    const counts = new Map();
    for (const v of vars) counts.set(v, (counts.get(v) || 0) + 1);
    // a name of more than one word is bracketed where a power follows it: (total flow)², not total flow²
    return [...counts].map(([v, k]) => { const w = label(v); return k > 1 ? `${/\s/.test(w) ? `(${w})` : w}${k === 2 ? '²' : k === 3 ? '³' : `^${k}`}` : w; }).join(times);
  };
  const parts = eq.terms.map((t, i) => {
    const sign = t.coef < 0 ? '−' : '+';
    const body = t.vars.length ? `${num(t.coef)}${times}${mono(t.vars)}` : num(t.coef);
    return i === 0 ? `${t.coef < 0 ? '−' : ''}${body}` : `${sign} ${body}`;
  });
  return `${lhs} = ${parts.join(' ')}`;
}

/** The coded equation as text, from the same terms: "Size = 101.2 − 12.3·FRR + 4.1·FRR·flow …" in coded units. */
export function codedEquationText(beta, terms, { lhs = 'y', label = (n) => n, sig = 4, times = '·' } = {}) {
  const eq = { terms: terms.map((t, i) => ({ vars: t.kind === 'intercept' ? [] : t.kind === 'square' ? [t.of[0], t.of[0]] : t.of || [t.name], coef: beta[i] })) };
  return equationText(eq, { lhs, label, sig, times });
}
