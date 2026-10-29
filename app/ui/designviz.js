// Drawing a design, so its shape can be seen rather than inferred from a table of numbers.
//
// Everything here is drawn from the design's own coded matrix, never from a stored picture of what a
// Box-Behnken is "supposed" to look like. If the app builds a design with the corners missing, the drawing
// has no corners. A diagram that agrees with the code by construction is worth more than a prettier one that
// agrees by someone having checked once.
//
// Three forms, chosen by how many factors there are, because no single one reads well across the range:
//   2 factors  a square, which is literally the design space
//   3 factors  an isometric cube, where corners, faces and axial arms stay distinguishable
//   4 or more  parallel coordinates, one axis per factor and one line per run, which has no dimension limit
// None of them animate. A moving diagram is read once and then waited through.
//
// A blend is drawn differently, because it is a different space. Three lipids that must add to 100 have two
// degrees of freedom, not three, so their design space is a triangle and not a cube — and the triangle is
// worth drawing properly, with the region your mol% bounds actually leave shaded in, because that region is
// usually a small corner of the simplex and seeing it is what stops a bound being set by accident.

import { esc } from './kit.js';
import { extremeVertices, toPseudo } from '../calc/mixture.js';
import { codedDesign } from '../calc/doe.js';

const TYPE_STYLE = {
  factorial: { fill: 'var(--c-doe, #5E5CE6)', stroke: 'none', r: 4.6, label: 'factorial, a corner of the box' },
  center: { fill: 'var(--card, #fff)', stroke: 'var(--c-doe, #5E5CE6)', r: 4.6, label: 'centre, the middle of every range' },
  axial: { fill: 'var(--c-advisor, #FF9F0A)', stroke: 'none', r: 4.6, label: 'axial, one factor moved on its own' },
  edge: { fill: 'var(--c-ml, #BF5AF2)', stroke: 'none', r: 4.6, label: 'edge midpoint, two factors moved, never the extreme of all' },
  vertex: { fill: 'var(--c-doe, #5E5CE6)', stroke: 'none', r: 4.6, label: 'corner of the blend region' },
  interior: { fill: 'var(--c-advisor, #FF9F0A)', stroke: 'none', r: 4.2, label: 'inside the region' },
  centroid: { fill: 'var(--card, #fff)', stroke: 'var(--c-doe, #5E5CE6)', r: 5, label: 'centre of the region' },
  pure: { fill: 'var(--c-doe, #5E5CE6)', stroke: 'none', r: 4.6, label: 'one lipid at its highest' },
  binary: { fill: 'var(--c-ml, #BF5AF2)', stroke: 'none', r: 4.6, label: 'two lipids blended' },
  ternary: { fill: 'var(--c-advisor, #FF9F0A)', stroke: 'none', r: 4.4, label: 'three lipids blended' },
  blend: { fill: 'var(--c-advisor, #FF9F0A)', stroke: 'none', r: 4.4, label: 'a blend of four or more' },
};
const ORDER = ['factorial', 'vertex', 'pure', 'binary', 'ternary', 'blend', 'edge', 'interior', 'axial', 'centroid', 'center'];

/** How many runs sit at the same place, so a centre point run three times reads as three. */
function groupPoints(points, types) {
  const by = new Map();
  points.forEach((p, i) => {
    const key = p.map((v) => Math.round(v * 1e6)).join(',');
    const g = by.get(key) || { p, type: types[i], n: 0 };
    g.n += 1;
    by.set(key, g);
  });
  return [...by.values()];
}

const svgWrap = (w, h, inner, title) =>
  `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-width:${w}px;height:auto;display:block" role="img" aria-label="${esc(title)}">${inner}</svg>`;

/** A blend has its own words for the same shapes: "two factors moved" means nothing on a simplex. */
const BLEND_LABEL = {
  vertex: 'corner of the blend region', edge: 'midpoint of an edge of the region',
  interior: 'inside the region', centroid: 'centre of the region', center: 'centre, run again for pure error',
  pure: 'one lipid as high as the bounds allow', binary: 'two lipids blended', ternary: 'three lipids blended', blend: 'four or more blended',
};
const legend = (types, labels = null) => {
  const present = ORDER.filter((t) => types.includes(t));
  if (present.length < 2) return '';
  return `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:11.5px" class="muted">${present.map((t) => {
    const s = TYPE_STYLE[t];
    return `<span style="display:inline-flex;align-items:center;gap:5px"><svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true"><circle cx="5.5" cy="5.5" r="4" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.6"/></svg>${esc(labels?.[t] || s.label)}</span>`;
  }).join('')}</div>`;
};

const dot = (x, y, type, n) => {
  const s = TYPE_STYLE[type] || TYPE_STYLE.factorial;
  const c = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${s.r}" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.8"/>`;
  // A repeated setting is marked with its count rather than drawn on top of itself, which would be invisible.
  return n > 1
    ? `${c}<text x="${(x + 7).toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="9.5" fill="var(--ink2, #666)">${n}x</text>`
    : c;
};

/* ---------------- two factors: the square ---------------- */
function square(points, types, names, size) {
  const pad = 38, w = size, h = size;
  const m = Math.max(1, ...points.flat().map(Math.abs));
  const sx = (v) => pad + ((v / m + 1) / 2) * (w - 2 * pad);
  const sy = (v) => h - pad - ((v / m + 1) / 2) * (h - 2 * pad);
  const box = `<rect x="${sx(-1)}" y="${sy(1)}" width="${sx(1) - sx(-1)}" height="${sy(-1) - sy(1)}" fill="none" stroke="var(--line, #ddd)" stroke-width="1.2"/>`;
  const axes = `<line x1="${sx(-m)}" y1="${sy(0)}" x2="${sx(m)}" y2="${sy(0)}" stroke="var(--line, #ddd)" stroke-dasharray="3 3"/>
    <line x1="${sx(0)}" y1="${sy(-m)}" x2="${sx(0)}" y2="${sy(m)}" stroke="var(--line, #ddd)" stroke-dasharray="3 3"/>`;
  const labels = `<text x="${w / 2}" y="${h - 8}" text-anchor="middle" font-size="11" fill="var(--ink2, #666)">${esc(names[0] || 'factor 1')}</text>
    <text x="12" y="${h / 2}" text-anchor="middle" font-size="11" fill="var(--ink2, #666)" transform="rotate(-90 12 ${h / 2})">${esc(names[1] || 'factor 2')}</text>
    <text x="${sx(-1)}" y="${h - pad + 14}" text-anchor="middle" font-size="10" fill="var(--ink3, #999)">low</text>
    <text x="${sx(1)}" y="${h - pad + 14}" text-anchor="middle" font-size="10" fill="var(--ink3, #999)">high</text>`;
  const dots = groupPoints(points, types).map((g) => dot(sx(g.p[0]), sy(g.p[1]), g.type, g.n)).join('');
  return svgWrap(w, h, box + axes + labels + dots, 'The design as a square: each point is a run.');
}

/* ---------------- three factors: the cube ---------------- */
function cube(points, types, names, size) {
  const w = size, h = size * 1.02, cx = w / 2, cy = h / 2;
  const m = Math.max(1, ...points.flat().map(Math.abs));
  const k = (size * 0.215) / m;
  // Isometric: x goes right and down, z goes left and down, y is straight up.
  const proj = ([x, y, z]) => [cx + (x - z) * 0.866 * k, cy + ((x + z) * 0.5 - y) * k];
  const corners = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push([x, y, z]);
  const edges = [];
  for (let i = 0; i < corners.length; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      const diff = corners[i].reduce((n, v, d) => n + (v !== corners[j][d] ? 1 : 0), 0);
      if (diff === 1) {
        const [x1, y1] = proj(corners[i]), [x2, y2] = proj(corners[j]);
        edges.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="var(--line, #ddd)" stroke-width="1.1"/>`);
      }
    }
  }
  // Far enough out that a label never lands on a corner, which at m + 0.45 it did. The two lower axes point
  // outward past the edge of the box, so a long name centred on them runs off the drawing: keep the whole
  // word inside the viewBox, since half a factor name is worse than a name nudged a few pixels.
  const axisLabel = (vec, name, dy = 0) => {
    const text = name.length > 15 ? name.slice(0, 14) + '…' : name;
    const [x, y] = proj(vec.map((v) => v * (m + 1.05)));
    const half = text.length * 3.2 + 2; // half the rendered width at font-size 11, near enough to clamp by
    const cxs = Math.min(w - half - 1, Math.max(half + 1, x));
    return `<text x="${cxs.toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="middle" font-size="11" fill="var(--ink2, #666)">${esc(text)}</text>`;
  };
  const labels = axisLabel([1, 0, 0], names[0] || 'factor 1', 12) + axisLabel([0, 1, 0], names[1] || 'factor 2', -6) + axisLabel([0, 0, 1], names[2] || 'factor 3', 12);
  // Far points first, so a near one is drawn over a far one rather than under it.
  const dots = groupPoints(points, types)
    .map((g) => ({ g, depth: g.p[0] + g.p[2] - g.p[1] }))
    .sort((a, b) => a.depth - b.depth)
    .map(({ g }) => { const [x, y] = proj(g.p); return dot(x, y, g.type, g.n); }).join('');
  return svgWrap(w, h, edges.join('') + labels + dots, 'The design as a cube: each point is a run.');
}

/* ---------------- four or more at fixed levels: the grid ---------------- */
//
// A screening design puts every factor at its low or its high, and drawn as lines that is a lattice of
// crossings nobody can follow. As a grid it is the thing itself: one row per run, one column per factor,
// filled for high and hollow for low. The pattern that makes the design balanced becomes visible.
function levelGrid(points, types, names, size) {
  const MAX = 24;
  const shown = points.slice(0, MAX);
  const k = names.length;
  const cw = Math.min(42, Math.max(24, (size * 1.25 - 70) / k)), ch = 15;
  const left = 54, top = 62;
  const w = left + k * cw + 10, h = top + shown.length * ch + 16;
  const head = names.map((n, i) => {
    const x = left + i * cw + cw / 2;
    return `<text x="${x}" y="${top - 10}" text-anchor="end" font-size="10" fill="var(--ink2, #666)" transform="rotate(-38 ${x} ${top - 10})">${esc(n.length > 14 ? n.slice(0, 13) + '…' : n)}</text>`;
  }).join('');
  const cells = shown.map((p, r) => {
    const y = top + r * ch + ch / 2;
    const label = `<text x="${left - 8}" y="${y + 3.4}" text-anchor="end" font-size="9.5" fill="var(--ink3, #999)">R${String(r + 1).padStart(3, '0')}</text>`;
    const row = p.slice(0, k).map((v, i) => {
      const x = left + i * cw + cw / 2;
      const s = TYPE_STYLE[types[r]] || TYPE_STYLE.factorial;
      if (Math.abs(v) < 1e-9) return `<line x1="${x - 5}" y1="${y}" x2="${x + 5}" y2="${y}" stroke="${s.stroke === 'none' ? s.fill : s.stroke}" stroke-width="2" stroke-linecap="round"/>`;
      return v > 0
        ? `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" rx="2.5" fill="${s.fill === 'var(--card, #fff)' ? 'var(--c-doe, #5E5CE6)' : s.fill}"/>`
        : `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" rx="2.5" fill="none" stroke="${s.fill === 'var(--card, #fff)' ? 'var(--c-doe, #5E5CE6)' : s.fill}" stroke-width="1.6"/>`;
    }).join('');
    return label + row;
  }).join('');
  const note = points.length > MAX
    ? `<text x="${left}" y="${h - 4}" font-size="9.5" fill="var(--ink3, #999)">first ${MAX} of ${points.length} runs</text>` : '';
  return svgWrap(w, h, head + cells + note, 'The design as a grid: one row per run, one column per factor.') +
    `<div class="muted" style="font-size:11.5px;margin-top:4px">Filled is the high setting, hollow the low one, a line the centre.</div>`;
}

/* ---------------- four or more, continuous: parallel coordinates ---------------- */
function parallel(points, types, names, size) {
  const w = size * 1.25, h = size * 0.8, padX = 40, padY = 26;
  const k = names.length;
  const m = Math.max(1, ...points.flat().map(Math.abs));
  const ax = (i) => padX + (i * (w - 2 * padX)) / Math.max(1, k - 1);
  const ay = (v) => h - padY - ((v / m + 1) / 2) * (h - 2 * padY);
  const axes = names.map((n, i) => `<line x1="${ax(i)}" y1="${ay(m)}" x2="${ax(i)}" y2="${ay(-m)}" stroke="var(--line, #ddd)" stroke-width="1.1"/>
    <text x="${ax(i)}" y="${h - 6}" text-anchor="middle" font-size="10" fill="var(--ink2, #666)">${esc(n)}</text>`).join('');
  const lines = points.map((p, idx) => {
    const s = TYPE_STYLE[types[idx]] || TYPE_STYLE.factorial;
    const d = p.slice(0, k).map((v, i) => `${i ? 'L' : 'M'}${ax(i).toFixed(1)},${ay(v).toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${s.fill === 'var(--card, #fff)' ? 'var(--c-doe, #5E5CE6)' : s.fill}" stroke-width="1.4" stroke-opacity="0.75"${types[idx] === 'center' ? ' stroke-dasharray="4 3"' : ''}/>`;
  }).join('');
  const scale = `<text x="${padX - 8}" y="${ay(1) + 3}" text-anchor="end" font-size="9.5" fill="var(--ink3, #999)">high</text>
    <text x="${padX - 8}" y="${ay(-1) + 3}" text-anchor="end" font-size="9.5" fill="var(--ink3, #999)">low</text>`;
  return svgWrap(w, h, axes + scale + lines, 'The design as parallel coordinates: each line is a run across the factors.');
}

/**
 * Draw a design.
 * @param {Array<Array<number>>} points  the coded matrix, one row per run
 * @param {Array<string>} types          point type per run: factorial | center | axial | edge
 * @param {Array<string>} names          factor names, in the same column order
 * @param {object} [o] {size}
 */
export function designSvg(points, types, names, o = {}) {
  const size = o.size || 260;
  if (!points?.length) return '<p class="muted">Nothing to draw yet.</p>';
  const k = Math.min(names.length || points[0].length, points[0].length);
  const body = k <= 1 ? '<p class="muted">A single factor has no shape worth drawing.</p>'
    : k === 2 ? square(points, types, names, size)
      : k === 3 ? cube(points, types, names, size)
        : points.every((p) => p.slice(0, k).every((v) => Math.abs(Math.abs(v) - 1) < 1e-9 || Math.abs(v) < 1e-9))
          ? levelGrid(points, types, names, size)
          : parallel(points, types, names, size);
  return `<div>${body}${legend(types, o.labels || null)}</div>`;
}

/** The blend wording, for the process half of a crossed design where the point types came from the blend. */
export const blendLabels = () => BLEND_LABEL;

/** The same from a built design: rows as buildDesign returns them. */
export function designSvgFromRuns(runs, factorNames, o = {}) {
  const points = runs.map((r) => factorNames.map((n) => r.coded[n]));
  // o.names: what to write on the axes, when that is not the factor's name (Design & results writes lab words)
  return designSvg(points, runs.map((r) => r.point_type), o.names || factorNames, o);
}

/** One sentence saying what the picture shows, so the drawing is not left to speak for itself. */
export function designCaption(k, byType, o = {}) {
  const parts = Object.entries(byType || {}).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${t}`);
  const form = k === 2 ? 'The square is the space your two factors span.'
    : k === 3 ? 'The cube is the space your three factors span; the wireframe is the box your ranges define.'
      : o.grid ? 'One row per run, one column per factor. The pattern down a column is how that factor is balanced against the others.'
        : 'Each line is one run, crossing an axis per factor. A flat line through the middle is a centre point.';
  return `${form}${parts.length ? ` This design places ${parts.join(', ')}.` : ''}`;
}

/* ---------------- blends: the simplex, not the box ---------------- */

const SQ3 = Math.sqrt(3) / 2;
/** Barycentric to cartesian on the unit triangle: component 0 at the apex, 1 bottom-left, 2 bottom-right. */
const bary = (u) => ({ x: 0.5 * u[0] + u[2], y: SQ3 * (1 - u[0]) });

/** Corners of the feasible region, ordered around their centroid so they can be drawn as one polygon. */
function regionHull(bounds, total, pseudo = null) {
  const V = extremeVertices(bounds, total);
  if (V.length < 3) return [];
  const pts = V.map((v) => bary(pseudo ? toPseudo(v.map((x) => x * total), pseudo.lows, pseudo.total) : v));
  const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  return pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
}

/**
 * Three lipids as a ternary plot, in mol% rather than coded units because that is what gets weighed out.
 *
 * @param {Array<Array<number>>} mol    one row per run, mol% per component
 * @param {Array<string>} types         point type per run
 * @param {Array<string>} names         component names, same column order
 * @param {Array<{lo:number,hi:number}>} bounds  the mol% range each component was allowed
 */
function ternaryPlot(mol, types, names, bounds, total, size, pseudo) {
  const side = size * 1.3, padTop = 40, padBot = 44;
  // The two bottom corner labels hang outside the triangle, so the side margin has to be as wide as the
  // longest of them. A fixed margin clips "DMG-PEG2000" and quietly turns the drawing into a lie.
  const lows0 = bounds.map((b) => b.lo), room0 = total - lows0.reduce((a, b) => a + b, 0);
  const longest = Math.max(...names.map((n, i) => Math.max(n.length * 1.15, `up to ${Math.round((pseudo ? lows0[i] + room0 : total) * 10) / 10} mol%`.length * 0.86)));
  const padX = Math.max(56, 14 + longest * 6.4);
  const w = side + 2 * padX, h = side * SQ3 + padTop + padBot;
  const X = (p) => padX + p.x * side, Y = (p) => padTop + p.y * side;
  const corner = [bary([1, 0, 0]), bary([0, 1, 0]), bary([0, 0, 1])];

  // Pseudo-components when the lower bounds eat most of the simplex. Without them an LNP blend is a sliver in
  // the corner of a mostly empty triangle: technically correct, unreadable, and no help in choosing a run.
  const lows = bounds.map((b) => b.lo);
  const R = total - lows.reduce((a, b) => a + b, 0);
  const toView = (m) => (pseudo ? toPseudo(m, lows, total) : m.map((v) => v / total));
  const cornerBlend = (i) => lows.map((lo, j) => (j === i ? lo + R : lo));

  const frame = `<polygon points="${corner.map((c) => `${X(c).toFixed(1)},${Y(c).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--line, #ddd)" stroke-width="1.2"/>`;

  let grid = '';
  for (let f = 0.2; f < 0.99; f += 0.2) {
    for (let i = 0; i < 3; i++) {
      const [a, b] = [(i + 1) % 3, (i + 2) % 3];
      const p1 = [0, 0, 0], p2 = [0, 0, 0];
      p1[i] = f; p1[a] = 1 - f; p2[i] = f; p2[b] = 1 - f;
      grid += `<line x1="${X(bary(p1)).toFixed(1)}" y1="${Y(bary(p1)).toFixed(1)}" x2="${X(bary(p2)).toFixed(1)}" y2="${Y(bary(p2)).toFixed(1)}" stroke="var(--line, #ddd)" stroke-width="0.5" stroke-opacity="0.5"/>`;
    }
  }

  const hull = regionHull(bounds, total, pseudo ? { lows, total } : null);
  const region = hull.length
    ? `<polygon points="${hull.map((p) => `${X(p).toFixed(1)},${Y(p).toFixed(1)}`).join(' ')}" fill="var(--c-doe, #5E5CE6)" fill-opacity="0.08" stroke="var(--c-doe, #5E5CE6)" stroke-width="1.3" stroke-dasharray="5 3"/>`
    : '';

  // Corner labels sit outside the triangle and say how high that lipid goes there. The full blend is in the
  // tooltip on every point; spelling all three out at each corner only overruns the drawing.
  const labels = names.map((n, i) => {
    const c = corner[i], top = pseudo ? cornerBlend(i)[i] : total;
    const anchor = i === 0 ? 'middle' : i === 1 ? 'end' : 'start';
    const dx = i === 0 ? 0 : i === 1 ? -8 : 8;
    const y0 = i === 0 ? Y(c) - 20 : Y(c) + 17;
    return `<text x="${(X(c) + dx).toFixed(1)}" y="${y0.toFixed(1)}" text-anchor="${anchor}" font-size="11.5" font-weight="600" fill="var(--ink, #222)">${esc(n)}</text>
      <text x="${(X(c) + dx).toFixed(1)}" y="${(y0 + 12).toFixed(1)}" text-anchor="${anchor}" font-size="9" fill="var(--ink3, #999)">up to ${Math.round(top * 10) / 10} mol%</text>`;
  }).join('');

  const groups = groupPoints(mol.map(toView), types);
  const dots = groups.map((g) => {
    const st = TYPE_STYLE[g.type] || TYPE_STYLE.vertex;
    const p = bary(g.p);
    const r = st.r + (g.n > 1 ? Math.min(3.4, 1.1 * Math.log2(g.n + 1)) : 0);
    const real = pseudo ? g.p.map((v, i) => lows[i] + v * R) : g.p.map((v) => v * total);
    const tip = real.map((v, i) => `${names[i]} ${(Math.round(v * 10) / 10)}`).join(', ');
    return `<circle cx="${X(p).toFixed(1)}" cy="${Y(p).toFixed(1)}" r="${r.toFixed(1)}" fill="${st.fill}" stroke="${st.stroke === 'none' ? 'var(--card, #fff)' : st.stroke}" stroke-width="${st.stroke === 'none' ? 0.9 : 1.6}"><title>${esc(tip)} mol%${g.n > 1 ? ` — ${g.n} runs` : ''}</title></circle>`;
  }).join('');

  return svgWrap(w, h, grid + region + frame + labels + dots,
    `Ternary plot of ${names.join(', ')}: each point is one blend, the dashed outline is the region the mol% bounds allow.`);
}

/** Four or more components: parallel coordinates in mol%, with each axis scaled to that lipid's own range. */
function blendParallel(mol, types, names, bounds, size) {
  const k = names.length;
  const w = Math.max(size * 1.3, 90 + k * 64), h = size * 0.86, padX = 52, padY = 30;
  const ax = (i) => padX + (i * (w - 2 * padX)) / Math.max(1, k - 1);
  const span = bounds.map((b) => (b.hi - b.lo) || 1);
  const ay = (v, i) => h - padY - ((v - bounds[i].lo) / span[i]) * (h - 2 * padY);
  const axes = names.map((n, i) => `<line x1="${ax(i)}" y1="${padY}" x2="${ax(i)}" y2="${h - padY}" stroke="var(--line, #ddd)" stroke-width="1.1"/>
    <text x="${ax(i)}" y="${h - 14}" text-anchor="middle" font-size="10" fill="var(--ink2, #666)">${esc(n)}</text>
    <text x="${ax(i)}" y="${h - 3}" text-anchor="middle" font-size="9" fill="var(--ink3, #999)">${bounds[i].lo}–${bounds[i].hi}</text>`).join('');
  const lines = mol.map((m, idx) => {
    const st = TYPE_STYLE[types[idx]] || TYPE_STYLE.vertex;
    const colour = st.fill === 'var(--card, #fff)' ? 'var(--c-doe, #5E5CE6)' : st.fill;
    const d = m.map((v, i) => `${i ? 'L' : 'M'}${ax(i).toFixed(1)},${ay(v, i).toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${colour}" stroke-width="1.4" stroke-opacity="0.7"${types[idx] === 'center' || types[idx] === 'centroid' ? ' stroke-dasharray="4 3"' : ''}><title>${m.map((v, i) => `${esc(names[i])} ${v.toFixed(1)}`).join(', ')}</title></path>`;
  }).join('');
  const scale = `<text x="${padX - 8}" y="${padY + 4}" text-anchor="end" font-size="9.5" fill="var(--ink3, #999)">highest</text>
    <text x="${padX - 8}" y="${h - padY + 4}" text-anchor="end" font-size="9.5" fill="var(--ink3, #999)">lowest</text>`;
  return svgWrap(w, h, axes + scale + lines, `The blends as parallel coordinates: one line per run across ${names.join(', ')}.`);
}

/**
 * Draw the blend side of a design: a ternary plot for three lipids, parallel coordinates above that.
 *
 * @param {Array} runs            rows as buildDesign returns them (real units are mol%)
 * @param {Array} components      [{name, lo, hi}] in column order
 * @param {object} [o] {size, total}
 */
export function blendSvgFromRuns(runs, components, o = {}) {
  const size = o.size || 260, total = o.total || 100;
  if (!runs?.length || components.length < 2) return '<p class="muted">Nothing to draw yet.</p>';
  const names = components.map((c) => c.name);
  const bounds = components.map((c) => ({ lo: Number(c.lo) || 0, hi: Number(c.hi) }));
  const mol = runs.map((r) => names.map((n) => Number(r.real?.[n]) || 0));
  const types = runs.map((r) => r.point_type);
  // Lower bounds that use up most of the blend leave a sliver of the simplex; showing that sliver as if it
  // were the whole triangle is the only way a reader can see the design rather than a cluster of dots.
  const room = total - bounds.reduce((a, b) => a + b.lo, 0);
  const usePseudo = o.pseudo != null ? o.pseudo : room < total * 0.6;
  const body = names.length === 3
    ? ternaryPlot(mol, types, names, bounds, total, size, usePseudo)
    : blendParallel(mol, types, names, bounds, size);
  return `<div>${body}${legend(types, BLEND_LABEL)}</div>`;
}

/** One sentence on what the blend picture shows. */
export function blendCaption(q, byType, o = {}) {
  const parts = Object.entries(byType || {}).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${t}`);
  const form = q === 3
    ? (o.pseudo === false
      ? 'The triangle is every possible blend of the three lipids; each corner is one lipid alone. The dashed outline is the region your mol% bounds leave, and the design sits inside it.'
      : 'The triangle is the room your lower bounds leave, not the whole simplex: each corner is the blend with one lipid as high as those bounds allow, written underneath it. Drawn any other way an LNP blend is a speck in an empty triangle. The dashed outline is where the upper bounds cut the region further.')
    : `One axis per lipid, scaled to its own mol% range, and one line per run. ${q} lipids have ${q - 1} degrees of freedom, so no single picture is the design space — this shows which parts of each range were used.`;
  const dup = o.crossed ? ' A larger dot is one blend made at several process settings.' : '';
  return `${form}${parts.length ? ` This design places ${parts.join(', ')}.` : ''}${dup}`;
}

/* ---------------- the catalogue's small figures ---------------- */
//
// One glyph per catalogue entry, so the shelf can be read by shape before a word of it is: corners for a
// factorial, a star for a central composite, edge midpoints for a Box-Behnken. The designs are drawn from the
// same generator as the full pictures above (codedDesign at three factors, the cube being the one shape where
// corners, faces, edges and axial arms all stay distinct), so a thumbnail cannot show a design the app does
// not build. The simple experiments and the time study have no design space to draw; they get what a bench
// scientist would sketch instead: a vial, the same vial three times, vials of different blends, a time axis.
//
// Everything is in the theme's own variables (lines and labels in --ink3, points in the colours of the full
// figures, text in --ink3), so the glyphs read the same in light and dark and need no second set.

const T_W = 120, T_H = 96;
const thumbWrap = (inner, title) =>
  `<svg class="dc-svg" viewBox="0 0 ${T_W} ${T_H}" width="${T_W}" height="${T_H}" role="img" aria-label="${esc(title)}">${inner}</svg>`;
const LINE = 'var(--ink3, #999)', FAINT = 'var(--ink3, #999)';
const tdot = (x, y, type, r = 3.3) => {
  const s = TYPE_STYLE[type] || TYPE_STYLE.factorial;
  const hollow = s.fill === 'var(--card, #fff)';
  return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${s.fill}" stroke="${hollow ? s.stroke : 'none'}" stroke-width="1.5"/>`;
};

/** The same classification buildDesign gives its rows (pointType in app/calc/doe.js), for a bare coded point. */
function thumbType(p, design) {
  const nz = p.filter((v) => Math.abs(v) > 1e-9);
  if (!nz.length) return 'center';
  if (design.startsWith('ccd') && (Math.max(...p.map(Math.abs)) > 1 + 1e-9 || nz.length === 1)) return 'axial';
  if (design === 'bbd') return 'edge';
  return 'factorial';
}

/** A three-factor design as a small cube: the wireframe is the box your ranges draw. */
function thumbCube(design) {
  const { pts, centers } = codedDesign({ designType: design, factors: [0, 0, 0], centerPoints: 1, replicates: 1 });
  const all = [...pts, ...centers];
  // A fixed scale rather than fit-to-points, so a rotatable design's axial arms visibly leave the box and an
  // inscribed one's corners visibly shrink inside it: that difference is the whole point of the three CCDs.
  const k = 20, cx = T_W / 2 - 4, cy = T_H / 2 + 4;
  // An oblique (cabinet) view, not the isometric one of the full figure: at this size isometry puts two
  // opposite corners on top of the centre point, and a factorial would look like it had a centre it lacks.
  const proj = ([x, y, z]) => [cx + (x + z * 0.45) * k, cy - (y + z * 0.35) * k];
  const corners = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push([x, y, z]);
  let edges = '';
  corners.forEach((a, i) => corners.slice(i + 1).forEach((b) => {
    if (a.filter((v, d) => v !== b[d]).length !== 1) return;
    const [x1, y1] = proj(a), [x2, y2] = proj(b);
    edges += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${LINE}" stroke-width="1"/>`;
  }));
  // A star design's arms are what make it a star; faint spokes keep the shape legible at 120 px.
  const [x0, y0] = proj([0, 0, 0]);
  const arms = design.startsWith('ccd') ? all.filter((p) => thumbType(p, design) === 'axial').map((p) => {
    const [x1, y1] = proj(p);
    return `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${LINE}" stroke-width="1" stroke-dasharray="2 2"/>`;
  }).join('') : '';
  // Far points first, so a near one is drawn over a far one.
  const dots = all.map((p) => ({ p, depth: -p[2] })).sort((a, b) => a.depth - b.depth)
    .map(({ p }) => { const [x, y] = proj(p); return tdot(x, y, thumbType(p, design), design === 'full_factorial_3' ? 2.6 : 3.3); }).join('');
  return edges + arms + dots;
}

/** A simplex-centroid style blend on the triangle: pure corners, binary midpoints, three-way blends, centroid. */
function thumbSimplex(x0, y0, side) {
  const at = (u) => { const p = bary(u); return [x0 + p.x * side, y0 + p.y * side]; };
  const frame = `<polygon points="${[[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((u) => at(u).map((v) => v.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="${LINE}" stroke-width="1"/>`;
  const pts = [[[1, 0, 0], 'pure'], [[0, 1, 0], 'pure'], [[0, 0, 1], 'pure'], [[0.5, 0.5, 0], 'binary'], [[0.5, 0, 0.5], 'binary'], [[0, 0.5, 0.5], 'binary'],
    [[2 / 3, 1 / 6, 1 / 6], 'ternary'], [[1 / 6, 2 / 3, 1 / 6], 'ternary'], [[1 / 6, 1 / 6, 2 / 3], 'ternary'], [[1 / 3, 1 / 3, 1 / 3], 'centroid']];
  return frame + pts.map(([u, type]) => { const [x, y] = at(u); return tdot(x, y, type, 3); }).join('');
}

/**
 * A small vial: the glass, its cap, and the liquid, either one colour or stacked bands ([fraction, colour])
 * for a composition. The bands are clipped by an inner rect rather than a clipPath, so no ids are needed and
 * two figures on one page cannot collide.
 */
function vial(x, y, w, h, fill) {
  const bands = Array.isArray(fill) ? fill : [[1, fill]];
  const liquid = h * 0.62;
  let top = y + h - liquid - 1.5;
  const rects = bands.map(([f, c], i) => {
    const bh = (liquid - 1.5) * f;
    const last = i === bands.length - 1;
    const r = `<rect x="${x + 2}" y="${top.toFixed(1)}" width="${w - 4}" height="${bh.toFixed(1)}" rx="${last ? (w - 4) / 2.6 : 0}" fill="${c}" fill-opacity="0.85"/>`;
    top += bh; return r;
  }).join('');
  return rects + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w / 2.6}" fill="none" stroke="${FAINT}" stroke-width="1.2"/>` +
    `<rect x="${x - 2}" y="${y - 5}" width="${w + 4}" height="6" rx="1.5" fill="${FAINT}"/>`;
}

const tlabel = (x, y, text, anchor = 'middle') => `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="9.5" fill="${FAINT}">${esc(text)}</text>`;
const C1 = 'var(--c-doe, #5E5CE6)', C2 = 'var(--c-advisor, #FF9F0A)', C3 = 'var(--c-ml, #BF5AF2)';

const THUMBS = {
  single: () => vial(51, 18, 18, 58, C1) + tlabel(60, 92, '1 recipe'),
  reference: () => [0, 1, 2].map((i) => vial(24 + i * 27, 18, 18, 58, C1)).join('') + tlabel(60, 92, 'same recipe × n'),
  comparison: () => [[[0.4, C2], [0.15, C3], [0.45, C1]], [[0.3, C2], [0.3, C3], [0.4, C1]], [[0.2, C2], [0.15, C3], [0.65, C1]], [[0.5, C2], [0.08, C3], [0.42, C1]]]
    .map((b, i) => vial(16 + i * 24, 18, 16, 58, b)).join('') + tlabel(60, 92, 'one recipe each'),
  ofat: () => {
    const y = 50;
    return `<line x1="10" y1="${y}" x2="110" y2="${y}" stroke="${LINE}" stroke-width="1.2"/><path d="M105 ${y - 3.5}l5 3.5-5 3.5" fill="none" stroke="${LINE}" stroke-width="1.2"/>` +
      [20, 44, 68, 92].map((x) => tdot(x, y, 'factorial', 4)).join('') + tlabel(60, 30, 'everything else fixed') + tlabel(60, 74, 'one factor, n levels');
  },
  plackett_burman: () => thumbCube('plackett_burman'),
  full_factorial: () => thumbCube('full_factorial'),
  full_factorial_3: () => thumbCube('full_factorial_3'),
  ccd_faced: () => thumbCube('ccd_faced'),
  ccd_rotatable: () => thumbCube('ccd_rotatable'),
  ccd_inscribed: () => thumbCube('ccd_inscribed'),
  bbd: () => thumbCube('bbd'),
  mixture: () => thumbSimplex(22, 12, 76),
  crossed: () => thumbSimplex(4, 26, 54) + tlabel(68, 56, '×') +
    `<rect x="80" y="34" width="30" height="30" fill="none" stroke="${LINE}" stroke-width="1"/>` +
    [[80, 34], [110, 34], [80, 64], [110, 64]].map(([x, y]) => tdot(x, y, 'factorial', 3)).join(''),
  seed: () => {
    // A Latin hypercube of eight: one point in every row and every column, which is what spreads it.
    const perm = [3, 6, 0, 5, 1, 7, 2, 4], x0 = 20, y0 = 8, s = 80, c = s / 8;
    let grid = '';
    for (let i = 1; i < 8; i++) {
      grid += `<line x1="${x0 + i * c}" y1="${y0}" x2="${x0 + i * c}" y2="${y0 + s}" stroke="${LINE}" stroke-width="0.5"/>` +
        `<line x1="${x0}" y1="${y0 + i * c}" x2="${x0 + s}" y2="${y0 + i * c}" stroke="${LINE}" stroke-width="0.5"/>`;
    }
    return grid + `<rect x="${x0}" y="${y0}" width="${s}" height="${s}" fill="none" stroke="${LINE}" stroke-width="1"/>` +
      perm.map((r, i) => tdot(x0 + (i + 0.5) * c, y0 + (r + 0.5) * c, 'interior', 3.2)).join('');
  },
  rounds: () => {
    // What is measured in grey, the model's contours, and the next round where they point, in the optimizer's colour.
    const x0 = 20, y0 = 8, s = 80;
    const old = [[0.15, 0.2], [0.8, 0.12], [0.3, 0.78], [0.86, 0.84], [0.42, 0.42], [0.12, 0.55]];
    const next = [[0.68, 0.36], [0.74, 0.48], [0.6, 0.5]];
    return `<rect x="${x0}" y="${y0}" width="${s}" height="${s}" fill="none" stroke="${LINE}" stroke-width="1"/>` +
      [30, 20, 10].map((r) => `<ellipse cx="${x0 + 0.68 * s}" cy="${y0 + 0.44 * s}" rx="${r}" ry="${r * 0.75}" fill="none" stroke="${C3}" stroke-opacity="0.4" stroke-width="1"/>`).join('') +
      old.map(([u, v]) => `<circle cx="${x0 + u * s}" cy="${y0 + v * s}" r="3" fill="${FAINT}"/>`).join('') +
      next.map(([u, v]) => `<circle cx="${x0 + u * s}" cy="${y0 + v * s}" r="3.4" fill="${C3}"/>`).join('');
  },
  stability: () => {
    const xs = [16, 30, 48, 72, 104];
    return [[30, '4 °C', C1], [58, '25 °C', C2]].map(([y, t, c]) => `<line x1="12" y1="${y}" x2="110" y2="${y}" stroke="${LINE}" stroke-width="1"/>` + tlabel(12, y - 7, t, 'start') +
      xs.map((x) => `<circle cx="${x}" cy="${y}" r="3.3" fill="${c}"/>`).join('')).join('') +
      `<line x1="12" y1="78" x2="110" y2="78" stroke="${LINE}" stroke-width="1.2"/><path d="M105 74.5l5 3.5-5 3.5" fill="none" stroke="${LINE}" stroke-width="1.2"/>` +
      tlabel(60, 92, 'days in storage');
  },
};

/** What the point colours in the catalogue's figures mean, said once above them rather than under each. */
export function catalogueLegend() {
  const item = (type, text) => {
    const s = TYPE_STYLE[type];
    return `<span class="dc-key"><svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true"><circle cx="5.5" cy="5.5" r="4" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1.5"/></svg>${esc(text)}</span>`;
  };
  return item('factorial', 'corner') + item('axial', 'star (axial)') + item('edge', 'edge midpoint') + item('center', 'centre');
}

/** The figure for one catalogue entry (app/calc/designs.js), or '' for an entry without one. */
export function catalogueFigure(e) {
  const make = THUMBS[e.kind === 'doe' ? e.design : e.id];
  if (!make) return '';
  try { return thumbWrap(make(), `${e.name}: what the design looks like`); } catch { return ''; }
}
