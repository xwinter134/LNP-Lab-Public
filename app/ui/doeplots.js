// The DoE diagnostic plots, as SVG strings.
//
// Hand-drawn SVG rather than a charting library for the same reason the rest of the app has no build step:
// one file, no dependency, and the plot inherits the page's colours so it is right in dark mode without a
// second theme to maintain. Each function takes numbers from app/calc/diagnostics.js and returns markup.

import { esc } from './kit.js';
// A coefficient in the Pareto's column reads to three significant figures whatever its size: a PDI's 0.0052
// was "0.01" at two fixed decimals, and its smallest terms "-0".
import { sigfig } from '../calc/diagnostics.js';
import { surfaceScene, heightColour, rgb, niceTicks, Z_SCALE } from '../calc/surface3d.js';

const W = 420, H = 260, L = 52, R = 14, T = 16, B = 40;
const nice = (v, d = 2) => (Number.isFinite(v) ? (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(d).replace(/\.?0+$/, '')) : '–');
/**
 * The decimals that tell the ends of a range apart: two significant figures of its span. A fixed two decimals
 * read a PDI axis as "0.08, 0.08" and a residual of −0.004 as "-0"; this gives 0.078 to 0.090 for a PDI and
 * 78 to 146 for a size, where 77.84 to 146.18 only made the reader check digits nobody needs.
 */
const dpFor = (lo, hi) => { const s = Math.abs(hi - lo); return s > 0 && Number.isFinite(s) ? Math.max(0, Math.min(6, 1 - Math.floor(Math.log10(s)))) : 2; };
/** A number at those decimals, with a real minus sign and never "−0". */
const at = (v, dp) => { if (!Number.isFinite(v)) return '–'; const r = Number(v.toFixed(dp)); return r === 0 ? '0' : `${r < 0 ? '−' : ''}${Math.abs(r).toFixed(dp)}`; };
const atDp = at; // the same, under a name the 3D view can use beside its own local `at`

/** Axes, frame and a caption line; every plot below shares it so they stack as one family. */
function frame(inner, { xlab, ylab, x0, x1, y0, y1, w = W, h = H, title = '', xLabels = null }) {
  const ticks = (lo, hi) => [lo, (lo + hi) / 2, hi];
  const ydp = dpFor(y0, y1), xdp = dpFor(x0, x1);
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}" style="width:100%;max-width:${w}px;height:auto;display:block">
    <line x1="${L}" y1="${T}" x2="${L}" y2="${h - B}" class="ax"/><line x1="${L}" y1="${h - B}" x2="${w - R}" y2="${h - B}" class="ax"/>
    ${ticks(y0, y1).map((v) => `<text x="${L - 6}" y="${(T + (1 - (v - y0) / ((y1 - y0) || 1)) * (h - T - B)) + 4}" class="lb" text-anchor="end">${at(v, ydp)}</text>`).join('')}
    ${ticks(x0, x1).map((v, i) => `<text x="${L + ((v - x0) / ((x1 - x0) || 1)) * (w - L - R)}" y="${h - B + 15}" class="lb" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}">${xLabels ? esc(xLabels[i]) : at(v, xdp)}</text>`).join('')}
    ${inner}
    <text x="${(L + w - R) / 2}" y="${h - 6}" class="lb" text-anchor="middle">${esc(xlab)}</text>
    <text x="13" y="${(T + h - B) / 2}" class="lb" text-anchor="middle" transform="rotate(-90 13 ${(T + h - B) / 2})">${esc(ylab)}</text>
  </svg>`;
}
const scaler = (lo, hi, from, to) => (v) => from + ((v - lo) / ((hi - lo) || 1)) * (to - from);
/** A little padding, so a point never sits exactly on the axis where it cannot be seen. */
function span(values, pad = 0.08) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return [0, 1];
  let lo = Math.min(...v), hi = Math.max(...v);
  if (lo === hi) { lo -= 1; hi += 1; }
  const m = (hi - lo) * pad;
  return [lo - m, hi + m];
}

/* ---------------- Pareto of the standardised effects ---------------- */

export function paretoSvg({ effects, tCrit }, { max = 10 } = {}) {
  if (!effects.length) return '';
  const rows = effects.slice(0, max);
  const h = 44 + rows.length * 22;
  const xMax = Math.max(...rows.map((e) => e.abs), tCrit || 0) * 1.12 || 1;
  const left = 118, right = 50; // the right strip is the coefficient column, not plot area
  const bw = (v) => ((v / xMax) * (W - left - right));
  const bars = rows.map((e, i) => {
    const y = 20 + i * 22;
    return `<rect x="${left}" y="${y}" width="${bw(e.abs).toFixed(1)}" height="14" rx="3" fill="${e.significant ? 'var(--accent)' : 'var(--ink3)'}" opacity="${e.significant ? 0.9 : 0.5}"><title>${esc(e.name)}: coefficient ${nice(e.coef, 3)}, t ${nice(e.t)}</title></rect>
      <text x="${left - 6}" y="${y + 11}" class="lb" text-anchor="end">${esc(e.name.length > 18 ? e.name.slice(0, 17) + '…' : e.name)}</text>
      <text x="${W - 6}" y="${y + 11}" class="lb" text-anchor="end">${sigfig(e.coef, 3)}</text>`;
  }).join('');
  const limit = tCrit != null && tCrit <= xMax ? `<line x1="${left + bw(tCrit)}" y1="12" x2="${left + bw(tCrit)}" y2="${h - 22}" class="lm" stroke-dasharray="4 3"/>
    <text x="${left + bw(tCrit) + 4}" y="${h - 12}" class="lb">t ${nice(tCrit)} · p 0.05</text>` : '';
  return `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="effects ranked by size against their own error" style="width:100%;max-width:${W}px;height:auto;display:block">
    ${bars}${limit}<line x1="${left}" y1="12" x2="${left}" y2="${h - 22}" class="ax"/>
    <text x="${W - 6}" y="14" class="lb" text-anchor="end" font-size="10">coefficient</text></svg>`;
}

/* ---------------- residuals against fitted ---------------- */

export function residualSvg(points) {
  if (points.length < 3) return '';
  const use = points.filter((p) => p.student != null);
  if (use.length < 3) return '';
  const [x0, x1] = span(use.map((p) => p.fitted));
  const m = Math.max(2.6, ...use.map((p) => Math.abs(p.student))) * 1.1;
  const sx = scaler(x0, x1, L, W - R), sy = scaler(-m, m, H - B, T);
  const band = `<rect x="${L}" y="${sy(2)}" width="${W - R - L}" height="${sy(-2) - sy(2)}" fill="var(--ok)" opacity=".07"/>
    <line x1="${L}" x2="${W - R}" y1="${sy(0)}" y2="${sy(0)}" class="mn" stroke-dasharray="2 4"/>`;
  const dots = use.map((p) => `<circle cx="${sx(p.fitted).toFixed(1)}" cy="${sy(p.student).toFixed(1)}" r="4" fill="${Math.abs(p.student) > 2 ? 'var(--warn-text)' : 'var(--accent)'}" opacity=".85"><title>${esc(p.label)}: fitted ${nice(p.fitted)}, residual ${nice(p.resid)}, studentised ${nice(p.student)}</title></circle>`).join('');
  return frame(band + dots, { xlab: 'fitted value', ylab: 'studentised residual', x0, x1, y0: -m, y1: m, title: 'residuals against fitted values' });
}

/* ---------------- normal plot of the residuals ---------------- */

export function qqSvg(points, line) {
  if (points.length < 3) return '';
  const [x0, x1] = span(points.map((p) => p.theoretical));
  const [y0, y1] = span(points.map((p) => p.sample));
  const sx = scaler(x0, x1, L, W - R), sy = scaler(y0, y1, H - B, T);
  const ref = line ? `<line x1="${sx(x0)}" y1="${sy(line.intercept + line.slope * x0)}" x2="${sx(x1)}" y2="${sy(line.intercept + line.slope * x1)}" class="mn" stroke-dasharray="3 3"/>` : '';
  const dots = points.map((p) => `<circle cx="${sx(p.theoretical).toFixed(1)}" cy="${sy(p.sample).toFixed(1)}" r="3.6" fill="var(--accent)" opacity=".85"/>`).join('');
  return frame(ref + dots, { xlab: 'normal quantile', ylab: 'residual', x0, x1, y0, y1, title: 'normal plot of the residuals' });
}

/* ---------------- measured against predicted ---------------- */

export function obsPredSvg(points) {
  if (points.length < 3) return '';
  const all = [...points.map((p) => p.fitted), ...points.map((p) => p.measured)];
  const [lo, hi] = span(all);
  const sx = scaler(lo, hi, L, W - R), sy = scaler(lo, hi, H - B, T);
  const diag = `<line x1="${sx(lo)}" y1="${sy(lo)}" x2="${sx(hi)}" y2="${sy(hi)}" class="mn" stroke-dasharray="3 3"/>`;
  const dots = points.map((p) => `<circle cx="${sx(p.fitted).toFixed(1)}" cy="${sy(p.measured).toFixed(1)}" r="4" fill="var(--accent)" opacity=".85"><title>${esc(p.label)}: predicted ${nice(p.fitted)}, measured ${nice(p.measured)}</title></circle>`).join('');
  return frame(diag + dots, { xlab: 'predicted', ylab: 'measured', x0: lo, x1: hi, y0: lo, y1: hi, title: 'measured against predicted' });
}

/* ---------------- the fitted surface ---------------- */

/**
 * A filled contour over two factors, with the design points drawn on top.
 * The points matter as much as the colours: they are the only honest answer to "how much of this picture did
 * you actually measure".
 */
export function surfaceSvg(grid, { fa, fb, runs = [], goal = null } = {}) {
  if (!grid) return '';
  // Two caption lines, each with the full width: they used to share one baseline, anchored at either end,
  // and a long legend and a wide predicted range simply ran into each other in the middle.
  const w = 400, h = 336, l = 56, r = 16, t = 14, b = 64;
  const { z, lo, hi, steps } = grid;
  const cw = (w - l - r) / steps, ch = (h - t - b) / steps;
  // Dark means good, and what good is depends on the response: lowest for PDI, highest for encapsulation,
  // nearest the target for size. Shading by the raw value instead would make a small PDI look like a failure.
  const g = goal?.goal || null, target = Number(goal?.target);
  const rangeOf = (hi - lo) || 1;
  const better = g === 'minimize' ? (v) => 1 - (v - lo) / rangeOf
    : g === 'target' && Number.isFinite(target)
      ? (v) => 1 - Math.min(1, Math.abs(v - target) / (Math.max(Math.abs(hi - target), Math.abs(target - lo)) || 1))
      : (v) => (v - lo) / rangeOf;
  const shade = (v) => `rgba(124, 77, 196, ${(0.08 + 0.78 * Math.max(0, Math.min(1, better(v)))).toFixed(3)})`;
  let cells = '';
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      cells += `<rect x="${(l + i * cw).toFixed(1)}" y="${(t + (steps - 1 - j) * ch).toFixed(1)}" width="${(cw + 0.6).toFixed(1)}" height="${(ch + 0.6).toFixed(1)}" fill="${shade(z[j][i])}"/>`;
    }
  }
  const px = (c) => l + ((c + 1) / 2) * (w - l - r), py = (c) => t + (1 - (c + 1) / 2) * (h - t - b);
  const dots = runs.map((p) => `<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="4.5" fill="none" stroke="var(--ink)" stroke-width="1.6" opacity=".8"><title>${esc(p.label || '')}</title></circle>`).join('');
  const real = (f, c) => {
    const centre = f.center != null && f.center !== '' ? Number(f.center) : (Number(f.low) + Number(f.high)) / 2;
    return c < 0 ? Number(f.low) : c > 0 ? Number(f.high) : centre;
  };
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="fitted surface over ${esc(fa.name)} and ${esc(fb.name)}" style="width:100%;max-width:${w}px;height:auto;display:block">
    ${cells}${dots}
    <rect x="${l}" y="${t}" width="${w - l - r}" height="${h - t - b}" fill="none" class="ax"/>
    <text x="${l}" y="${h - b + 15}" class="lb">${nice(real(fa, -1))}</text>
    <text x="${w - r}" y="${h - b + 15}" class="lb" text-anchor="end">${nice(real(fa, 1))}</text>
    <text x="${(l + w - r) / 2}" y="${h - b + 32}" class="lb" text-anchor="middle">${esc(fa.name)}${fa.unit ? ` (${esc(fa.unit)})` : ''}</text>
    <text x="${l - 6}" y="${h - b + 4}" class="lb" text-anchor="end">${nice(real(fb, -1))}</text>
    <text x="${l - 6}" y="${t + 10}" class="lb" text-anchor="end">${nice(real(fb, 1))}</text>
    <text x="14" y="${(t + h - b) / 2}" class="lb" text-anchor="middle" transform="rotate(-90 14 ${(t + h - b) / 2})">${esc(fb.name)}${fb.unit ? ` (${esc(fb.unit)})` : ''}</text>
    <text x="0" y="${h - 17}" class="lb" font-size="10">dark is ${g === 'minimize' ? 'lower' : g === 'target' && Number.isFinite(target) ? 'nearer ' + nice(target) : 'higher'} · circles are the runs you measured</text>
    <text x="0" y="${h - 5}" class="lb" font-size="10">predicted ${at(lo, dpFor(lo, hi))} to ${at(hi, dpFor(lo, hi))}</text></svg>`;
}

/* ---------------- main effects and interactions ---------------- */

export function effectSvg(lines, { factor, against = null, response = '', spec = null, label = (s) => s, levelNames = null } = {}) {
  if (!lines.length) return '';
  const ys = lines.flatMap((l) => l.points.map((p) => p.y));
  const [y0, y1] = span(ys);
  const sx = scaler(-1, 1, L, W - R), sy = scaler(y0, y1, H - B, T);
  const colour = ['var(--ink3)', 'var(--accent)', 'var(--c-stocks, #7c4dc4)'];
  const paths = lines.map((l, i) => {
    const d = l.points.map((p, k) => `${k ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${against ? colour[i % 3] : 'var(--accent)'}" stroke-width="2"/>`;
  }).join('');
  // a split by a mixer names its two lines (levelNames); a numeric split is low / centre / high
  // each name in its line's colour, so the key says which line is which mixer
  const names = levelNames ? levelNames.map((n, i) => `<tspan style="fill:${colour[i % 3]};font-weight:600">${esc(n)}</tspan>`).join(' / ') : 'low / centre / high';
  const key = against ? `<text x="${W - R}" y="${T + 10}" class="lb" text-anchor="end">${esc(label(against))}: ${names}</text>` : '';
  // Coded units are the model's; the bench works in the factor's own, so label the axis in those.
  const f = spec?.factors?.find((x) => x.name === factor);
  const centre = f ? (f.center != null && f.center !== '' ? Number(f.center) : (Number(f.low) + Number(f.high)) / 2) : null;
  const xLabels = f ? [nice(Number(f.low)), nice(centre), nice(Number(f.high))] : null;
  // the factor is found by its name and shown by its label (the lab's word for it, doe.js factorLabel)
  const [fl, al] = [label(factor), against ? label(against) : null];
  return frame(paths + key, { xlab: f?.unit ? `${fl} (${f.unit})` : fl, ylab: response || 'predicted', x0: -1, x1: 1, y0, y1, xLabels,
    title: against ? `interaction of ${fl} and ${al}` : `main effect of ${fl}` });
}

/**
 * The Cox response traces, one line per lipid on a shared axis.
 *
 * All the lines cross at the reference blend, which is the point: what separates them afterwards is how much
 * each lipid moves the response, and a line that stays flat is a lipid this model says you can stop varying.
 */
export function traceSvg(lines, { response = '' } = {}) {
  if (!lines.length) return '';
  const ys = lines.flatMap((l) => l.points.map((p) => p.y));
  const [y0, y1] = span(ys);
  const sx = scaler(-1, 1, L, W - R), sy = scaler(y0, y1, H - B, T);
  const colour = ['var(--accent)', 'var(--c-ml, #BF5AF2)', 'var(--c-advisor, #FF9F0A)', 'var(--c-stocks, #7c4dc4)', 'var(--c-doe, #5E5CE6)', 'var(--ink3)'];
  const paths = lines.map((l, i) => {
    const d = l.points.map((p, k) => `${k ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join(' ');
    const end = l.points[l.points.length - 1];
    return `<path d="${d}" fill="none" stroke="${colour[i % colour.length]}" stroke-width="2"><title>${esc(l.name)}: ${l.points[0].mol.toFixed(1)} to ${end.mol.toFixed(1)} mol%</title></path>`;
  }).join('');
  // Each lipid's own mol% range in the key, because "highest" means a different number on every line. The key
  // sits on a backdrop so it stays readable where a line runs underneath it.
  const keyText = lines.map((l) => `${l.name} ${nice(l.from, 1)}\u2013${nice(l.to, 1)} mol%`);
  const keyW = Math.max(...keyText.map((t) => t.length)) * 5.6 + 12;
  const key = `<rect x="${L + 3}" y="${T + 1}" width="${keyW.toFixed(0)}" height="${lines.length * 12 + 6}" fill="var(--card, #fff)" fill-opacity="0.82" rx="3"/>`
    + lines.map((l, i) => `<text x="${L + 9}" y="${T + 12 + i * 12}" class="lb" text-anchor="start" fill="${colour[i % colour.length]}">${esc(keyText[i])}</text>`).join('');
  const mid = `<line x1="${sx(0).toFixed(1)}" y1="${T}" x2="${sx(0).toFixed(1)}" y2="${H - B}" class="ax" stroke-dasharray="3 3" stroke-opacity="0.6"/>`;
  return frame(mid + paths + key, {
    xlab: 'along the Cox direction: less of that lipid, the reference blend, more of it',
    ylab: response || 'predicted', x0: -1, x1: 1, y0, y1,
    xLabels: ['lowest', 'reference blend', 'highest'],
    title: 'response trace: what each lipid does, moving away from the reference blend',
  });
}

/* ---------------- the same surface, as a solid in a box ---------------- */

/**
 * Which way round to open the picture.
 *
 * A tilted plane seen along its own slope looks flat: the climb up the surface and the fall away into the
 * distance cancel on the page, and a screening model — which is usually close to a plane — then draws as a
 * flat sheet, which is the one thing this view exists not to do. So the opening angle is taken from the data:
 * turn the surface until its steepest direction runs across the page, where the whole of it is visible, and
 * then back off a little so it is still seen in three-quarter view rather than edge-on.
 */
export function surface3dOpeningYaw(grid) {
  if (!grid) return 0.7;
  const { z, steps } = grid;
  let dx = 0, dy = 0;
  for (let j = 0; j < steps; j++) dx += z[j][steps - 1] - z[j][0];
  for (let i = 0; i < steps; i++) dy += z[steps - 1][i] - z[0][i];
  dx /= steps; dy /= steps;
  const scale = Math.max(...z.map((r) => Math.max(...r))) - Math.min(...z.map((r) => Math.min(...r)));
  // A response that barely moves has no steepest direction worth pointing at; any angle will do.
  if (!(Math.hypot(dx, dy) > 0.02 * (scale || 1))) return 0.7;
  return -Math.atan2(dy, dx) + 0.4;
}
/** The angle the picture opens at, and goes back to on "Reset view". */
export const SURFACE3D_PITCH = 0.6;

/**
 * The fitted surface as a solid in a box: height is the predicted response, on a z axis with its own ticks and
 * unit, and the measured runs stand at their measured height, so the gap between a run and the surface under
 * it is there to see.
 *
 * The contour view is the one to read settings off: it has no perspective. This one is for the shape (a ridge,
 * a saddle, a dome) and for the runs against it, which a heatmap cannot show at all. What is drawn, and why:
 *
 *   colour    by height, on a sequential scale with its legend, the same colour for the same value anywhere
 *             (a single hue by "better" made a flat surface and a steep one look alike);
 *   light     each face shaded by how it faces a light over the viewer's shoulder, which is what makes a curve
 *             read as a curve; without it a coloured mesh looks like a printed map laid on a slope;
 *   order     the painter's algorithm, far faces first (calc/surface3d.js);
 *   the box   back walls and floor with grid lines at the ticks, x and y on the nearest floor edges, z on a
 *             side corner, each labelled with its factor or response and unit;
 *   runs      a dot at the measured value: filled above the surface, open below it; a line from the dot to the
 *             surface (the residual) and a faint one down to the floor, where a small mark places it on the
 *             contour map that is drawn there.
 *
 * @param {object} grid  {z, lo, hi, steps} from surfaceGrid()
 * @param {object} o  {fa, fb} the factors (name, unit, low, high, center); `runs` [{x, y, value, label}] coded
 *   x, y and the measured value; `zlab` the response with its unit; `goal` its goal; `yaw`, `pitch`;
 *   `contours` whether the floor carries the contour map
 */
export function surface3dSvg(grid, { fa, fb, runs = [], goal = null, yaw = null, pitch = SURFACE3D_PITCH, zlab = 'predicted', contours = true } = {}) {
  if (!grid) return '';
  const w = 440, h = 390;
  const plotR = 372; // the box lives left of the colour legend
  // A run made at another level of a factor held at the centre is not a point of this slice: its height says
  // as much about that factor as about the surface, so the solid shows only the runs made on the slice.
  const onSlice = runs.filter((r) => !r.offSlice);
  const scene = surfaceScene(grid, { runs: onSlice, yaw: yaw == null ? surface3dOpeningYaw(grid) : yaw, pitch, fa, fb, contours: contours ? 6 : 0 });
  const { faces, points, floor, top, backX, backY, frontX, frontY, zCorner, zTicks, hOf, xTicks, yTicks, floorContours, project } = scene;

  // One scale for every angle: the box's bounding sphere fits the plot area, so turning it never makes it
  // grow, shrink or jump on the page, as fitting to whatever is drawn did.
  const R = Math.hypot(1, 1, Z_SCALE / 2);
  const padX = 34, padTop = 30, padBottom = 40;
  const k = Math.min((plotR - 2 * padX) / (2 * R), (h - padTop - padBottom) / (2 * R));
  const c0 = project(0, 0, 0.5);
  const ox = plotR / 2 - c0.X * k, oy = padTop + (h - padTop - padBottom) / 2 - c0.Y * k;
  const S = (p) => ({ x: ox + p.X * k, y: oy + p.Y * k });
  const P = (x, y, hh) => S(project(x, y, hh));
  const f1 = (v) => v.toFixed(1);
  const line = (a, b, attrs) => `<line x1="${f1(a.x)}" y1="${f1(a.y)}" x2="${f1(b.x)}" y2="${f1(b.y)}" ${attrs}/>`;
  const poly = (pts, attrs) => `<polygon points="${pts.map((p) => `${f1(p.x)},${f1(p.y)}`).join(' ')}" ${attrs}/>`;

  // The back walls and the floor, with grid lines at the ticks: the frame the eye measures heights against.
  const wallX = [[backX, -1, 0], [backX, 1, 0], [backX, 1, 1], [backX, -1, 1]].map(([x, y, hh]) => P(x, y, hh));
  const wallY = [[-1, backY, 0], [1, backY, 0], [1, backY, 1], [-1, backY, 1]].map(([x, y, hh]) => P(x, y, hh));
  const floorS = floor.map(S);
  const grid3 = [
    ...zTicks.map((v) => hOf(v)).flatMap((hh) => [line(P(backX, -1, hh), P(backX, 1, hh), 'class="ax" opacity=".5"'), line(P(-1, backY, hh), P(1, backY, hh), 'class="ax" opacity=".5"')]),
    ...xTicks.flatMap((t) => [line(P(t.coded, -1, 0), P(t.coded, 1, 0), 'class="ax" opacity=".4"'), line(P(t.coded, backY, 0), P(t.coded, backY, 1), 'class="ax" opacity=".4"')]),
    ...yTicks.flatMap((t) => [line(P(-1, t.coded, 0), P(1, t.coded, 0), 'class="ax" opacity=".4"'), line(P(backX, t.coded, 0), P(backX, t.coded, 1), 'class="ax" opacity=".4"')]),
  ].join('');
  const walls = `${poly(wallX, 'fill="var(--bg2)" fill-opacity=".55" class="ax"')}${poly(wallY, 'fill="var(--bg2)" fill-opacity=".55" class="ax"')}${poly(floorS, 'fill="var(--bg2)" fill-opacity=".35" class="ax"')}`;

  // The contour map, laid on the floor under the surface it comes from, in the surface's own colours.
  const contourLines = floorContours.map((c) => {
    const col = rgb(heightColour(c.t), 0.9);
    return c.segments.map(([a, b]) => line(S(a), S(b), `stroke="${col}" stroke-width="1.1" opacity=".9"`)).join('');
  }).join('');

  // Where each run stands on the floor, drawn under the surface so the surface hides the ones it covers.
  const feet = points.map((p) => { const f = S(p.floor); return `<circle cx="${f1(f.x)}" cy="${f1(f.y)}" r="1.8" fill="var(--ink2)" opacity=".7"/>`; }).join('');

  const shapes = faces.map((q) => {
    const col = heightColour(q.t);
    return poly(q.pts.map(S), `fill="${rgb(col, q.light)}" stroke="${rgb(col, q.light * 0.82)}" stroke-width=".45" stroke-linejoin="round"`);
  }).join('');

  // The z axis on its corner, x and y on the nearest floor edges, each tick labelled outside the box.
  const fc = { x: floorS.reduce((a, p) => a + p.x, 0) / 4, y: floorS.reduce((a, p) => a + p.y, 0) / 4 };
  const outward = (pt, d) => { const v = { x: pt.x - fc.x, y: pt.y - fc.y }, l = Math.hypot(v.x, v.y) || 1; return { x: pt.x + (v.x / l) * d, y: pt.y + (v.y / l) * d }; };
  const zdp = dpFor(zTicks[0], zTicks[zTicks.length - 1]);
  const xdp = dpFor(Number(fa?.low), Number(fa?.high)), ydp = dpFor(Number(fb?.low), Number(fb?.high));
  const label = (pt, text, anchor = 'middle', extra = '') => `<text x="${f1(pt.x)}" y="${f1(pt.y + 4)}" class="lb" text-anchor="${anchor}"${extra}>${esc(text)}</text>`;
  // Tick labels that would land on one already placed are left out (at a corner, the first x tick and the
  // bottom z tick fall on the same spot): the z axis is placed first, then x, then y.
  const placed = [];
  const tickLabel = (pt, text, anchor = 'middle') => {
    const wd = String(text).length * 6 + 4, x0 = anchor === 'end' ? pt.x - wd : anchor === 'start' ? pt.x : pt.x - wd / 2;
    const box = { x0, x1: x0 + wd, y0: pt.y - 6, y1: pt.y + 6 };
    if (placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0)) return '';
    placed.push(box);
    return label(pt, text, anchor);
  };
  // An axis title sits off the middle of its edge, away from the box, and runs away from it too: centred, a
  // title on a steep edge reached back across the floor.
  const title = (mid, text) => {
    const o = outward(mid, 30), dx = o.x - mid.x, dy = o.y - mid.y;
    const anchor = Math.abs(dx) > Math.abs(dy) * 0.8 ? (dx > 0 ? 'start' : 'end') : 'middle';
    const at = anchor === 'middle' ? o : outward(mid, 22);
    // kept inside the picture: a title that ran off its edge was cut off in the saved file as well
    const wd = String(text).length * 6.3;
    const x = anchor === 'end' ? Math.max(at.x, wd + 2) : anchor === 'start' ? Math.min(at.x, plotR - wd) : Math.max(wd / 2 + 2, Math.min(plotR - wd / 2, at.x));
    return label({ x, y: at.y }, text, anchor, ' font-weight="600"');
  };
  const axisTicks = (ticks, at, dp) => ticks.map((t) => { const a = at(t.coded), o = outward(a, 13); return line(a, outward(a, 4), 'class="ax"') + tickLabel(o, atDp(t.value, dp)); }).join('');
  const zBase = P(zCorner.x, zCorner.y, 0), zTop = P(zCorner.x, zCorner.y, 1);
  // the z labels go on the side of the corner away from the box
  const zSide = zBase.x <= fc.x ? -1 : 1;
  const zAxis = line(zBase, zTop, 'class="mn" stroke-width="1"')
    + zTicks.map((v) => { const a = P(zCorner.x, zCorner.y, hOf(v)); return line(a, { x: a.x + zSide * 4, y: a.y }, 'class="ax"') + tickLabel({ x: a.x + zSide * 7, y: a.y }, atDp(v, zdp), zSide < 0 ? 'end' : 'start'); }).join('')
    + label({ x: zTop.x, y: zTop.y - 16 }, zlab, 'middle', ' font-weight="600"');
  const xAxis = line(P(-1, frontY, 0), P(1, frontY, 0), 'class="mn" stroke-width="1"')
    + axisTicks(xTicks, (c) => P(c, frontY, 0), xdp)
    + title(P(0, frontY, 0), `${fa?.name || ''}${fa?.unit ? ` (${fa.unit})` : ''}`);
  const yAxis = line(P(frontX, -1, 0), P(frontX, 1, 0), 'class="mn" stroke-width="1"')
    + axisTicks(yTicks, (c) => P(frontX, c, 0), ydp)
    + title(P(frontX, 0, 0), `${fb?.name || ''}${fb?.unit ? ` (${fb.unit})` : ''}`);
  // the upper edges of the back walls, so the box closes
  const topEdges = [[backX, -1], [backX, 1]].map(([x, y]) => P(x, y, 1));
  const topY = [[-1, backY], [1, backY]].map(([x, y]) => P(x, y, 1));
  const box = line(topEdges[0], topEdges[1], 'class="ax"') + line(topY[0], topY[1], 'class="ax"')
    + line(P(backX, backY, 0), P(backX, backY, 1), 'class="ax"');

  // The runs, on top: a dot at the measured value, the residual to the surface, and a faint line to the floor.
  const dots = points.map((p) => {
    const a = S(p.at), s = S(p.onSurface), f = S(p.floor);
    const low = a.y > s.y ? a : s; // the lower of the two on the page is nearer the floor
    const resid = p.value - p.fitted;
    return `<g class="run3d">${line(low, f, 'class="mn" stroke-dasharray="2 3" opacity=".45"')}${line(a, s, 'stroke="var(--ink)" stroke-width="1.3"')}
      <circle cx="${f1(a.x)}" cy="${f1(a.y)}" r="3.8" fill="${p.above ? 'var(--ink)' : 'var(--card)'}" stroke="${p.above ? 'var(--card)' : 'var(--ink)'}" stroke-width="1.4"><title>${esc(p.label || 'run')}: measured ${atDp(p.value, zdp + 1)}, the surface ${atDp(p.fitted, zdp + 1)} (${resid >= 0 ? 'above' : 'below'} it by ${atDp(Math.abs(resid), zdp + 1)})</title></circle></g>`;
  }).join('');

  const g = goal?.goal || null, target = Number(goal?.target);
  const goalWord = g === 'minimize' ? 'lower is better' : g === 'maximize' ? 'higher is better' : g === 'target' && Number.isFinite(target) ? `aim ${nice(target)}` : '';
  // The colour legend: the surface's own range, low at the bottom, so a colour can be read back as a value.
  const lx = plotR + 8, ly0 = 48, ly1 = h - 80, bands = 40;
  const legendBar = Array.from({ length: bands }, (_, i) => {
    const t0 = i / bands, y = ly1 - (i + 1) * (ly1 - ly0) / bands;
    return `<rect x="${lx}" y="${f1(y)}" width="14" height="${f1((ly1 - ly0) / bands + 0.6)}" fill="${rgb(heightColour(t0 + 0.5 / bands))}"/>`;
  }).join('');
  const lticks = niceTicks(grid.lo, grid.hi, 5).filter((v) => v >= grid.lo - 1e-9 && v <= grid.hi + 1e-9);
  const lspan = (grid.hi - grid.lo) || 1;
  const legendTicks = lticks.map((v) => { const y = ly1 - ((v - grid.lo) / lspan) * (ly1 - ly0); return `<line x1="${lx + 14}" x2="${lx + 18}" y1="${f1(y)}" y2="${f1(y)}" class="ax"/><text x="${lx + 20}" y="${f1(y + 4)}" class="lb">${atDp(v, dpFor(grid.lo, grid.hi))}</text>`; }).join('');
  const legend = `<g class="legend3d"><text x="${lx - 4}" y="${ly0 - 22}" class="lb" font-weight="600">${esc(zlab)}</text><text x="${lx - 4}" y="${ly0 - 9}" class="lb" font-size="10">${goalWord ? esc(goalWord) : 'predicted'}</text>
    ${legendBar}<rect x="${lx}" y="${ly0}" width="14" height="${ly1 - ly0}" fill="none" class="ax"/>${legendTicks}</g>`;

  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="3D response surface of ${esc(zlab)} over ${esc(fa?.name || '')} and ${esc(fb?.name || '')}" data-yaw="${scene.view.yaw.toFixed(3)}" data-pitch="${scene.view.pitch.toFixed(3)}" style="width:100%;max-width:${w}px;height:auto;display:block;touch-action:none;cursor:grab" tabindex="0">
    ${walls}${grid3}${contours ? contourLines : ''}${feet}${shapes}${box}<g class="lbHalo">${xAxis}${yAxis}${zAxis}</g>${dots}${legend}
    <text x="0" y="${h - 19}" class="lb" font-size="10">dots: measured runs, filled above the surface, open below; the line is the gap to it</text>
    <text x="0" y="${h - 6}" class="lb" font-size="10">drag or use the arrow keys to turn · double-click to reset</text></svg>`;
}
