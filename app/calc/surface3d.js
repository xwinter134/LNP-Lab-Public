// The geometry of the 3D response surface on Design & results: no DOM, no SVG, only numbers, so the parts that
// decide what the picture says (where a point lands on the page, which face hides which, how a face is lit,
// which colour a height gets, where the floor's contour lines run) are tested under node like every other
// calculation. app/ui/doeplots.js (surface3dSvg) turns the scene into markup.
//
// Why by hand: the app has no build step and works offline, so a WebGL or charting library is not on the
// table, and one picture does not justify one. A response surface is a height field (one height per point
// of the floor), which is the case where the painter's algorithm is enough: sort the faces far to near and
// paint them in that order. Faces of a height field never pass through each other, so the only thing that
// can go wrong is two faces at nearly the same depth, and on a 25 × 25 grid those are neighbours whose
// overlap is a hairline.
//
// Coordinates. The floor is the coded design box, x and y from −1 to 1 (low to high of each factor). Height
// is the response scaled to 0 (the bottom of the z axis) … 1 (its top), stretched by Z_SCALE so the box reads
// as a landscape rather than a wall. The view turns the box about its vertical axis (yaw) and tilts it
// towards the viewer (pitch, 0 = level, π/2 = straight down).

/** How tall the box stands against its floor, which is 2 wide. Below ~0.8 a real ridge reads as a flat sheet. */
export const Z_SCALE = 1.25;

/**
 * Round numbers spanning [lo, hi], about `n` of them, as an axis would carry them: 0.05, 0.10, 0.15 rather than
 * 0.0523, 0.1046. The first is at or below lo and the last at or above hi, so the axis encloses every value.
 */
export function niceTicks(lo, hi, n = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi < lo) [lo, hi] = [hi, lo];
  if (lo === hi) { const d = Math.abs(lo) * 0.1 || 1; lo -= d; hi += d; }
  const raw = (hi - lo) / Math.max(1, n - 1), p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw * 0.999) || raw;
  const out = [];
  // whole multiples of the step, rounded so 0.30000000000000004 prints as 0.3
  const dec = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  for (let v = Math.floor(lo / step + 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(dec)));
  if (out[out.length - 1] < hi - step * 1e-9) out.push(Number((out[out.length - 1] + step).toFixed(dec)));
  return out;
}

/**
 * The view: turn by `yaw` about the vertical, tilt by `pitch` towards the viewer. Returns the projection and
 * the direction the viewer looks from, both in the box's own coordinates.
 *
 * Screen X is the turned x; screen Y grows downward, so "further back" and "higher up" both subtract. Depth is
 * the distance along the line of sight, larger = further away: what the painter's algorithm sorts by. It has
 * to count height as well as how far back a point sits, because seen from above a high point is nearer the
 * eye than a low one straight under it.
 */
export function makeView(yaw = 0.7, pitch = 0.5) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const turn = (x, y) => [x * cy - y * sy, x * sy + y * cy];
  return {
    yaw, pitch,
    /** @param {number} x @param {number} y @param {number} h  height 0…1 (scaled by Z_SCALE here) */
    project(x, y, h) {
      const [xr, yr] = turn(x, y), z = h * Z_SCALE;
      return { X: xr, Y: -yr * sp - z * cp, depth: yr * cp - z * sp };
    },
    /** A direction (a normal) in the turned frame, where the viewer sits at (0, −cos p, sin p). */
    turn(v) { const [a, b] = turn(v[0], v[1]); return [a, b, v[2]]; },
    toViewer: [0, -cp, sp],
  };
}

const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The unit normal of a quad of the surface, from its diagonals (a quad of a curved surface is not quite flat;
 * the cross product of the diagonals is the usual average). Heights are scaled as they are drawn.
 * Corners in order (i, j), (i+1, j), (i+1, j+1), (i, j+1): x along i, y along j.
 */
export function quadNormal(c) {
  const p = c.map(([x, y, h]) => [x, y, h * Z_SCALE]);
  const d1 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  const d2 = [p[3][0] - p[1][0], p[3][1] - p[1][1], p[3][2] - p[1][2]];
  const n = [d1[1] * d2[2] - d1[2] * d2[1], d1[2] * d2[0] - d1[0] * d2[2], d1[0] * d2[1] - d1[1] * d2[0]];
  return norm(n[2] < 0 ? n.map((v) => -v) : n); // up, whichever way the corners ran
}

/**
 * How brightly a face is lit: a key light over the viewer's left shoulder, which moves with the view so the
 * surface is never lit from behind whatever way it is turned, plus ambient so a face turned away is dim but
 * never black (black would read as a hole). A face seen from underneath is lit as its underside. 0.42 … 1.
 */
export function lambert(normal, view) {
  const n = view.turn(normal);
  const [vx, vy, vz] = view.toViewer;
  const light = norm([-0.45 + vx, vy, vz + 0.6]);
  const facing = dot(n, view.toViewer) >= 0 ? 1 : -1;
  const d = Math.max(0, facing * dot(n, light));
  return 0.42 + 0.58 * d;
}

/**
 * A sequential colour scale for height, dark blue-violet at the bottom to yellow at the top (the stops of
 * viridis): ordered in lightness, so it still reads in grey and to a colour-blind eye, and dark and light ends
 * both stand out on a white card and on a dark one. Returns [r, g, b], 0–255.
 */
const STOPS = [[68, 1, 84], [65, 68, 135], [42, 120, 142], [34, 168, 132], [122, 209, 81], [253, 231, 37]];
export function heightColour(t) {
  const u = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(u)), f = u - i;
  return STOPS[i].map((a, k) => Math.round(a + (STOPS[i + 1][k] - a) * f));
}
export const rgb = (c, k = 1) => `rgb(${c.map((v) => Math.max(0, Math.min(255, Math.round(v * k)))).join(',')})`;

/** The surface's value at a coded point, interpolated between the four grid nodes around it. */
export function bilinear(grid, x, y) {
  const { z, steps } = grid;
  const fi = ((x + 1) / 2) * (steps - 1), fj = ((y + 1) / 2) * (steps - 1);
  const i0 = Math.max(0, Math.min(steps - 2, Math.floor(fi))), j0 = Math.max(0, Math.min(steps - 2, Math.floor(fj)));
  const tx = Math.max(0, Math.min(1, fi - i0)), ty = Math.max(0, Math.min(1, fj - j0));
  return z[j0][i0] * (1 - tx) * (1 - ty) + z[j0][i0 + 1] * tx * (1 - ty) + z[j0 + 1][i0] * (1 - tx) * ty + z[j0 + 1][i0 + 1] * tx * ty;
}

/**
 * Contour lines of the grid at the given levels, by marching squares: for each level, the segments where the
 * surface crosses it, in coded floor coordinates. Drawn on the floor of the box they are the contour map the
 * other view shows, under the surface they come from.
 * @returns {Array<{level, segments: Array<[[x, y], [x, y]]>}>}
 */
export function contourSegments(grid, levels) {
  const { z, steps } = grid;
  const at = (k) => -1 + (2 * k) / (steps - 1);
  const out = [];
  for (const level of levels) {
    const segments = [];
    for (let j = 0; j < steps - 1; j++) {
      for (let i = 0; i < steps - 1; i++) {
        // corners counter-clockwise from (i, j), and the edge between each pair
        const c = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([a, b]) => ({ x: at(a), y: at(b), v: z[b][a] }));
        const cross = [];
        for (let e = 0; e < 4; e++) {
          const p = c[e], q = c[(e + 1) % 4];
          if ((p.v < level) !== (q.v < level)) {
            const t = (level - p.v) / (q.v - p.v);
            cross.push([p.x + t * (q.x - p.x), p.y + t * (q.y - p.y)]);
          }
        }
        // two crossings is one segment; four is a saddle, joined in pairs the way round the cell they come
        if (cross.length === 2) segments.push([cross[0], cross[1]]);
        else if (cross.length === 4) { segments.push([cross[0], cross[1]]); segments.push([cross[2], cross[3]]); }
      }
    }
    out.push({ level, segments });
  }
  return out;
}

/**
 * The piecewise-linear map from a factor's real value to coded, as calc/doe.js toCoded has it (a centre that is
 * not halfway between low and high has two half-scales). Written out so this module imports nothing.
 */
export function codedOf(f, real) {
  const lo = Number(f.low), hi = Number(f.high);
  const c = f.center != null && f.center !== '' && Number.isFinite(Number(f.center)) ? Number(f.center) : (lo + hi) / 2;
  const step = real >= c ? hi - c : c - lo;
  return step > 0 ? (real - c) / step : 0;
}

/**
 * Everything the picture needs, worked out once per view: the faces in the order to paint them, each with its
 * colour and light; the runs at their measured height with where the surface is under or over them; the box,
 * its ticks and which of its walls are at the back; and the floor's contours.
 *
 * @param {object} grid  {z, lo, hi, steps} from surfaceGrid() (z[j][i]: i along x, j along y, both −1 → 1)
 * @param {object} o
 * @param {Array<{x, y, value, label}>} [o.runs]  measured runs, coded x and y, value in response units
 * @param {number} [o.yaw]  @param {number} [o.pitch]
 * @param {number} [o.mesh]  quads per side (the grid is resampled; default the grid's own)
 * @param {object} [o.fa]  @param {object} [o.fb]  the two factors ({low, high, center}) for the floor's ticks
 * @param {number} [o.contours]  how many contour levels on the floor (0 for none)
 */
export function surfaceScene(grid, { runs = [], yaw = 0.7, pitch = 0.5, mesh = null, fa = null, fb = null, contours = 6 } = {}) {
  if (!grid) return null;
  const { z, steps } = grid;
  const view = makeView(yaw, pitch);
  // The z axis encloses the surface and every run, on round numbers, so a run above the predicted top is
  // still inside the box rather than floating over it.
  const measured = runs.map((r) => r.value).filter(Number.isFinite);
  const zTicks = niceTicks(Math.min(grid.lo, ...measured), Math.max(grid.hi, ...measured), 5);
  const z0 = zTicks[0], z1 = zTicks[zTicks.length - 1], zs = (z1 - z0) || 1;
  const hOf = (v) => (v - z0) / zs;

  const N = Math.max(2, Math.min(steps, mesh || steps));
  const node = (k) => (N === steps ? k : Math.round((k * (steps - 1)) / (N - 1)));
  const at = (k) => -1 + (2 * k) / (N - 1);
  const val = (i, j) => z[node(j)][node(i)];

  const faces = [];
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]].map(([a, b]) => [at(a), at(b), hOf(val(a, b))]);
      const v = (val(i, j) + val(i + 1, j) + val(i + 1, j + 1) + val(i, j + 1)) / 4;
      const pts = corners.map(([x, y, h]) => view.project(x, y, h));
      faces.push({
        pts, value: v, t: (v - grid.lo) / ((grid.hi - grid.lo) || 1),
        depth: pts.reduce((s, p) => s + p.depth, 0) / 4,
        light: lambert(quadNormal(corners), view),
      });
    }
  }
  // Painter's algorithm: the furthest face first, so every nearer one is painted over it.
  faces.sort((a, b) => b.depth - a.depth);

  // A run at its measured height, and the surface straight under (or over) it: the gap between the two is
  // the run's residual, which is what makes a fitted surface believable or not.
  const points = runs.filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.value)).map((r) => {
    const fitted = bilinear(grid, r.x, r.y);
    return { ...r, fitted, above: r.value >= fitted,
      at: view.project(r.x, r.y, hOf(r.value)), onSurface: view.project(r.x, r.y, hOf(fitted)), floor: view.project(r.x, r.y, 0) };
  });

  // The box. Of each pair of walls, the one further from the viewer is the back wall that carries grid lines;
  // the floor edges nearest the viewer carry the x and y axes, and the vertical edge furthest to the left on
  // the page carries z.
  const corner = (x, y, h) => ({ x, y, h, ...view.project(x, y, h) });
  const floor = [corner(-1, -1, 0), corner(1, -1, 0), corner(1, 1, 0), corner(-1, 1, 0)];
  const top = floor.map((c) => corner(c.x, c.y, 1));
  const backX = view.project(1, 0, 0.5).depth > view.project(-1, 0, 0.5).depth ? 1 : -1;
  const backY = view.project(0, 1, 0.5).depth > view.project(0, -1, 0.5).depth ? 1 : -1;
  const frontX = -backX, frontY = -backY;
  // z goes on a side corner: of the two corners that are neither nearest nor furthest, the one on the left
  const side = floor.filter((c) => !(c.x === frontX && c.y === frontY) && !(c.x === backX && c.y === backY));
  const zCorner = side[0].X <= side[1].X ? side[0] : side[1];

  const tick = (f, lo, hi) => {
    if (!f) return niceTicks(-1, 1, 5).filter((c) => c >= -1 && c <= 1).map((c) => ({ coded: c, value: c }));
    const real = niceTicks(Number(f.low), Number(f.high), 5).filter((v) => v >= Math.min(lo, hi) - 1e-9 && v <= Math.max(lo, hi) + 1e-9);
    return real.map((v) => ({ coded: codedOf(f, v), value: v }));
  };
  const xTicks = tick(fa, Number(fa?.low), Number(fa?.high));
  const yTicks = tick(fb, Number(fb?.low), Number(fb?.high));

  const levels = contours > 0 ? niceTicks(grid.lo, grid.hi, contours + 1).filter((v) => v > grid.lo && v < grid.hi) : [];
  const floorContours = contourSegments(grid, levels).map((c) => ({
    level: c.level, t: (c.level - grid.lo) / ((grid.hi - grid.lo) || 1),
    segments: c.segments.map(([a, b]) => [view.project(a[0], a[1], 0), view.project(b[0], b[1], 0)]),
  }));

  return { view, faces, points, floor, top, backX, backY, frontX, frontY, zCorner, zTicks, z0, z1, hOf, xTicks, yTicks, floorContours,
    project: (x, y, h) => view.project(x, y, h) };
}
