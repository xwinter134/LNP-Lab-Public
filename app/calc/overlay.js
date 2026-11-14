// The graphical optimisation overlay: where in the factor space every response meets its specification at once.
//
// Desirability (balance.js) answers "which one setting is best"; the overlay answers the question a lab more
// often has: "where can I work?". Each response gets a window (size 40 to 150 nm, PDI at most 0.2, EE at least
// 85 %: the QC limits from Settings, unless changed on the screen), and every point of a two-factor slice is
// coloured by whether all the fitted models say it meets them. The coloured region is the sweet spot; the lines
// around it are each response's own limit, so the picture also says which response closes it from which side.
//
// Three ways to read "meets the specification", as Design-Expert offers them:
//   mean  the predicted value is inside the window: where the average batch would pass
//   ci    the whole 95 % confidence interval of the mean is inside: where the model is sure the average passes
//   pi    the whole 95 % prediction interval is inside: where a single batch should pass, which is the design
//         space in the sense of ICH Q8, and always the smallest of the three
//
// Everything is in coded units over the region the design covered; the screen turns it into real units.

import { predictionAt } from './stats.js';

/**
 * A window per response from the QC limits in Settings: size between its minimum and maximum, PDI at most its
 * maximum, EE at least its minimum. Responses with no QC limit get no window and are left out of the overlay.
 * @param responses  the design's responses [{name}]
 * @param qc         settings.qc {zaveMin, zaveMax, pdiMax, eeMin}
 */
export function defaultSpecs(responses, qc = {}) {
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const by = {
    particle_size_nm: { lo: num(qc.zaveMin), hi: num(qc.zaveMax) },
    PDI: { lo: null, hi: num(qc.pdiMax) },
    encapsulation_efficiency: { lo: num(qc.eeMin), hi: null },
  };
  return (responses || []).map((r) => ({ name: r.name, lo: by[r.name]?.lo ?? null, hi: by[r.name]?.hi ?? null }))
    .filter((s) => s.lo != null || s.hi != null);
}

/**
 * The overlay over two factors.
 * @param o.fits     {response: ols() fit}
 * @param o.termsOf  (response) => its terms (balance.js boxTerms, or a reduced model's)
 * @param o.names    every factor name, in column order
 * @param o.a, o.b   the two factor names on the axes
 * @param o.base     coded values of the other factors
 * @param o.ext      {name: half width of the axis in coded units} (1 for the cube, more for CCD axial points)
 * @param o.specs    [{name, lo, hi}]; a response without a fit is skipped and listed in `missing`
 * @param o.interval 'mean' | 'ci' | 'pi'
 * @returns {{steps, a, b, ext: [ea, eb], ok: boolean[][], fails: string[][][], values: {name: number[][]}, share, used, missing}}
 *   rows j run along b, columns i along a; `share` is the fraction of the grid that passes everything
 */
export function overlayGrid({ fits, termsOf, names, a, b, base = {}, ext = {}, specs = [], interval = 'mean', steps = 41 }) {
  const used = specs.filter((s) => fits[s.name]?.beta);
  const missing = specs.filter((s) => !fits[s.name]?.beta).map((s) => s.name);
  const ea = ext[a] ?? 1, eb = ext[b] ?? 1;
  const at = (e, k) => -e + (2 * e * k) / (steps - 1);
  const ok = [], fails = [], values = Object.fromEntries(used.map((s) => [s.name, []]));
  let pass = 0;
  for (let j = 0; j < steps; j++) {
    const okRow = [], failRow = [];
    for (const s of used) values[s.name].push([]);
    for (let i = 0; i < steps; i++) {
      const c = { ...Object.fromEntries(names.map((n) => [n, base[n] ?? 0])), [a]: at(ea, i), [b]: at(eb, j) };
      const why = [];
      for (const s of used) {
        const x = termsOf(s.name).map((t) => t.f(c));
        const fit = fits[s.name];
        let lo, hi, mean;
        if (interval === 'mean') { mean = x.reduce((acc, v, k) => acc + v * fit.beta[k], 0); lo = hi = mean; }
        else {
          const p = predictionAt(fit, x);
          mean = p.mean;
          const iv = interval === 'ci' ? p.ci : p.pi;
          [lo, hi] = iv || [mean, mean];
        }
        values[s.name][j].push(mean);
        if ((s.lo != null && lo < s.lo) || (s.hi != null && hi > s.hi)) why.push(s.name);
      }
      okRow.push(!why.length);
      failRow.push(why);
      if (!why.length) pass++;
    }
    ok.push(okRow);
    fails.push(failRow);
  }
  return { steps, a, b, ext: [ea, eb], ok, fails, values, share: pass / (steps * steps), used: used.map((s) => s.name), missing, interval };
}

/**
 * The overlay in a sentence: how much of the slice meets every window, and when little or none does, which
 * response closes it most often.
 * @param g      overlayGrid()
 * @param label  (response) => its name for a reader
 */
export function overlaySentence(g, { label = (n) => n } = {}) {
  if (!g.used.length) return 'No response has both a fitted model and a specification, so there is nothing to overlay.';
  const pct = Math.round(g.share * 100);
  const what = g.interval === 'pi' ? 'a single batch should meet' : g.interval === 'ci' ? 'the model is sure the average batch meets' : 'the predicted value meets';
  const count = Object.fromEntries(g.used.map((n) => [n, 0]));
  for (const row of g.fails) for (const cell of row) for (const n of cell) count[n]++;
  const worst = Object.entries(count).sort((x, y) => y[1] - x[1]).filter(([, k]) => k > 0);
  const total = g.steps * g.steps;
  const limiting = worst.length ? `${label(worst[0][0])} is what fails most (${Math.round((worst[0][1] / total) * 100)} % of the slice)` : '';
  if (pct === 0) return `Nowhere in this slice does ${what} every specification: ${limiting}. Relax that limit, move the factors held fixed, or look outside the ranges run.`;
  if (pct === 100) return `The whole slice is inside every specification (${what} them all): the specifications do not constrain these two factors here.`;
  return `${pct < 1 ? 'Less than 1' : pct} % of this slice is the sweet spot, where ${what} every specification${limiting ? `; ${limiting}` : ''}.`;
}

/**
 * Marching squares: the line segments where a gridded surface crosses `level`, in grid coordinates (i along
 * columns, j along rows, both 0 … steps − 1). Saddle cells are split by the cell's centre value.
 * @returns {Array<[[i, j], [i, j]]>}
 */
export function isoSegments(z, level) {
  const segs = [];
  const ny = z.length, nx = z[0]?.length || 0;
  const lerp = (a, b) => (Math.abs(b - a) < 1e-300 ? 0.5 : (level - a) / (b - a));
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const v = [z[j][i], z[j][i + 1], z[j + 1][i + 1], z[j + 1][i]];
    if (v.some((x) => !Number.isFinite(x))) continue;
    const idx = (v[0] > level ? 1 : 0) | (v[1] > level ? 2 : 0) | (v[2] > level ? 4 : 0) | (v[3] > level ? 8 : 0);
    if (idx === 0 || idx === 15) continue;
    // edge points: bottom (0-1), right (1-2), top (3-2), left (0-3)
    const e = {
      b: [i + lerp(v[0], v[1]), j], r: [i + 1, j + lerp(v[1], v[2])],
      t: [i + lerp(v[3], v[2]), j + 1], l: [i, j + lerp(v[0], v[3])],
    };
    const centre = (v[0] + v[1] + v[2] + v[3]) / 4 > level;
    const table = {
      1: [['l', 'b']], 2: [['b', 'r']], 3: [['l', 'r']], 4: [['r', 't']], 6: [['b', 't']], 7: [['l', 't']],
      8: [['t', 'l']], 9: [['t', 'b']], 11: [['t', 'r']], 12: [['r', 'l']], 13: [['r', 'b']], 14: [['b', 'l']],
      5: centre ? [['l', 't'], ['b', 'r']] : [['l', 'b'], ['r', 't']],
      10: centre ? [['b', 'l'], ['t', 'r']] : [['b', 'r'], ['t', 'l']],
    };
    for (const [p, q] of table[idx]) segs.push([e[p], e[q]]);
  }
  return segs;
}
