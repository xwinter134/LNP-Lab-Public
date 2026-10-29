// General-purpose result charts, as SVG strings: bars with error bars and the individual points, lines over
// time or dose, and scatter. The DoE diagnostics keep their own plots in doeplots.js; these are for reading
// any set of results the way a lab reads them in GraphPad — every point visible, mean and SD on top.
//
// Colours come from the page (--s1 … --s8, a categorical order validated for colour-blind separation in both
// themes), so a chart follows light and dark mode. figure() wraps a chart with a title, a caption and SVG/PNG
// download buttons; wireFigures() makes those buttons work, inlining the theme colours so the saved file looks
// the same outside the app.
import { esc, saveBlob } from './kit.js';

export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
export const seriesColor = (i) => SERIES[i % SERIES.length];

const fmtTick = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? String(Math.round(v * 10) / 10) : String(Math.round(v * 1000) / 1000));

/** Round tick values covering [lo, hi]: 1, 2, 2.5 or 5 times a power of ten. */
export function niceTicks(lo, hi, n = 4) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) { lo -= Math.abs(lo) * 0.1 || 1; hi += Math.abs(hi) * 0.1 || 1; }
  const raw = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  if (out[0] > lo) out.unshift(out[0] - step);
  if (out[out.length - 1] < hi) out.push(out[out.length - 1] + step);
  return out;
}

function axes({ w, h, L, R, T, B, yt, sy, xlab, ylab, title }) {
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title || ylab || 'chart')}" style="width:100%;max-width:${w}px;height:auto;display:block">
    ${yt.map((v) => `<line x1="${L}" x2="${w - R}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}" class="ax" opacity=".45"/><text x="${L - 6}" y="${(sy(v) + 4).toFixed(1)}" class="lb" text-anchor="end">${fmtTick(v)}</text>`).join('')}
    <line x1="${L}" y1="${T}" x2="${L}" y2="${h - B}" class="ax"/><line x1="${L}" y1="${h - B}" x2="${w - R}" y2="${h - B}" class="ax"/>
    ${xlab ? `<text x="${(L + w - R) / 2}" y="${h - 4}" class="lb" text-anchor="middle">${esc(xlab)}</text>` : ''}
    ${ylab ? `<text x="12" y="${(T + h - B) / 2}" class="lb" text-anchor="middle" transform="rotate(-90 12 ${(T + h - B) / 2})">${esc(ylab)}</text>` : ''}`;
}

/** Deterministic horizontal jitter, so the same data always draws the same picture. */
const jitter = (i, n, width) => (n <= 1 ? 0 : ((i / (n - 1)) - 0.5) * width);

/**
 * Bars with mean ± SD and every point on top.
 * bars: [{label, mean, sd, n, points:[number], color, flag}] · ref: [{y, label}] reference lines (a QC limit).
 */
export function barChart({ bars, ylab = '', xlab = '', title = '', ref = [], fromZero = true, w = 460, h = 250 }) {
  const ok = bars.filter((b) => Number.isFinite(b.mean));
  if (!ok.length) return '';
  const L = 50, R = 12, T = 14, B = bars.some((b) => String(b.label).length > 7) ? 58 : 40;
  const vals = ok.flatMap((b) => [b.mean + (b.sd || 0), b.mean - (b.sd || 0), ...(b.points || [])]).concat(ref.map((r) => r.y)).filter(Number.isFinite);
  const yt = niceTicks(fromZero ? Math.min(0, ...vals) : Math.min(...vals), Math.max(...vals));
  const y0 = yt[0], y1 = yt[yt.length - 1];
  const sy = (v) => T + (1 - (v - y0) / ((y1 - y0) || 1)) * (h - T - B);
  const slot = (w - L - R) / bars.length, bw = Math.min(46, slot * 0.6);
  const body = bars.map((b, i) => {
    const cx = L + slot * (i + 0.5), c = b.color || seriesColor(0);
    const lab = String(b.label);
    const tick = lab.length > 7
      ? `<text x="${cx}" y="${h - B + 12}" class="lb" text-anchor="end" transform="rotate(-35 ${cx} ${h - B + 12})">${esc(lab.length > 14 ? lab.slice(0, 13) + '…' : lab)}</text>`
      : `<text x="${cx}" y="${h - B + 15}" class="lb" text-anchor="middle">${esc(lab)}</text>`;
    if (!Number.isFinite(b.mean)) return tick;
    const top = sy(b.mean), base = sy(Math.max(y0, Math.min(0, y1)));
    const tip = `${lab}: ${fmtTick(b.mean)}${Number.isFinite(b.sd) ? ` ± ${fmtTick(b.sd)} SD` : ''}${b.n ? `, n = ${b.n}` : ''}${b.flag ? ` · ${b.flag}` : ''}`;
    const err = Number.isFinite(b.sd) && b.sd > 0 ? `<line x1="${cx}" x2="${cx}" y1="${sy(b.mean + b.sd).toFixed(1)}" y2="${sy(b.mean - b.sd).toFixed(1)}" stroke="var(--ink)" stroke-width="1.4"/>
      <line x1="${cx - 7}" x2="${cx + 7}" y1="${sy(b.mean + b.sd).toFixed(1)}" y2="${sy(b.mean + b.sd).toFixed(1)}" stroke="var(--ink)" stroke-width="1.4"/><line x1="${cx - 7}" x2="${cx + 7}" y1="${sy(b.mean - b.sd).toFixed(1)}" y2="${sy(b.mean - b.sd).toFixed(1)}" stroke="var(--ink)" stroke-width="1.4"/>` : '';
    const pts = (b.points || []).filter(Number.isFinite).map((p, j, a) => `<circle cx="${(cx + jitter(j, a.length, bw * 0.55)).toFixed(1)}" cy="${sy(p).toFixed(1)}" r="3.2" fill="var(--card)" stroke="var(--ink)" stroke-width="1.1"><title>${esc(lab)}: ${fmtTick(p)}</title></circle>`).join('');
    return `<g><title>${esc(tip)}</title><rect x="${(cx - bw / 2).toFixed(1)}" y="${Math.min(top, base).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(base - top)).toFixed(1)}" rx="3" fill="${c}" opacity="${b.flag ? 0.45 : 0.85}"/>
      <rect x="${(cx - slot / 2).toFixed(1)}" y="${T}" width="${slot.toFixed(1)}" height="${h - T - B}" fill="transparent"/></g>${err}${pts}${tick}`;
  }).join('');
  const refs = ref.filter((r) => r.y >= y0 && r.y <= y1).map((r) => `<line x1="${L}" x2="${w - R}" y1="${sy(r.y).toFixed(1)}" y2="${sy(r.y).toFixed(1)}" stroke="var(--warn)" stroke-width="1.2" stroke-dasharray="5 4"/><text x="${w - R}" y="${(sy(r.y) - 4).toFixed(1)}" class="lb" text-anchor="end">${esc(r.label)}</text>`).join('');
  return axes({ w, h, L, R, T, B, yt, sy, xlab, ylab, title }) + refs + body + '</svg>';
}

/**
 * Lines over a numeric x (days, dose, level): one per series, points marked, optional ± SD whiskers.
 * series: [{name, color, points:[{x, y, sd, label}]}]
 */
export function lineChart({ series, xlab = '', ylab = '', title = '', ref = [], w = 460, h = 250, xTicks = null }) {
  const all = series.flatMap((s) => s.points).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!all.length) return '';
  const L = 50, R = 14, T = 14, B = 40;
  const ys = all.flatMap((p) => [p.y + (p.sd || 0), p.y - (p.sd || 0)]).concat(ref.map((r) => r.y));
  const yt = niceTicks(Math.min(...ys), Math.max(...ys));
  const y0 = yt[0], y1 = yt[yt.length - 1];
  const xs = all.map((p) => p.x), xa = Math.min(...xs), xb = Math.max(...xs);
  const sx = (v) => L + (xb === xa ? 0.5 : (v - xa) / (xb - xa)) * (w - L - R);
  const sy = (v) => T + (1 - (v - y0) / ((y1 - y0) || 1)) * (h - T - B);
  const xt = xTicks || [...new Set(xs)].sort((a, b) => a - b);
  const xtEvery = Math.ceil(xt.length / 8);
  const lines = series.map((s, i) => {
    const c = s.color || seriesColor(i);
    const pts = s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
    if (!pts.length) return '';
    const d = pts.map((p, j) => `${j ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ');
    const whisk = pts.filter((p) => Number.isFinite(p.sd) && p.sd > 0).map((p) => `<line x1="${sx(p.x).toFixed(1)}" x2="${sx(p.x).toFixed(1)}" y1="${sy(p.y + p.sd).toFixed(1)}" y2="${sy(p.y - p.sd).toFixed(1)}" stroke="${c}" stroke-width="1.2"/>`).join('');
    const dots = pts.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4" fill="${c}" stroke="var(--card)" stroke-width="2"><title>${esc(s.name)} · ${esc(p.label ?? fmtTick(p.x))}: ${fmtTick(p.y)}${Number.isFinite(p.sd) ? ` ± ${fmtTick(p.sd)}` : ''}</title></circle>`).join('');
    return `<path d="${d}" fill="none" stroke="${c}" stroke-width="2"/>${whisk}${dots}`;
  }).join('');
  const refs = ref.filter((r) => r.y >= y0 && r.y <= y1).map((r) => `<line x1="${L}" x2="${w - R}" y1="${sy(r.y).toFixed(1)}" y2="${sy(r.y).toFixed(1)}" stroke="var(--warn)" stroke-width="1.2" stroke-dasharray="5 4"/><text x="${w - R}" y="${(sy(r.y) - 4).toFixed(1)}" class="lb" text-anchor="end">${esc(r.label)}</text>`).join('');
  const xl = xt.filter((_, i) => i % xtEvery === 0).map((v) => `<text x="${sx(v).toFixed(1)}" y="${h - B + 15}" class="lb" text-anchor="middle">${fmtTick(v)}</text>`).join('');
  return axes({ w, h, L, R, T, B, yt, sy, xlab, ylab, title }) + refs + lines + xl + '</svg>';
}

/** Scatter of y against x. points: [{x, y, label, color}] */
export function scatterChart({ points, xlab = '', ylab = '', title = '', refX = [], refY = [], w = 460, h = 250 }) {
  const ok = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!ok.length) return '';
  const L = 50, R = 14, T = 14, B = 40;
  const yt = niceTicks(Math.min(...ok.map((p) => p.y), ...refY.map((r) => r.y)), Math.max(...ok.map((p) => p.y), ...refY.map((r) => r.y)));
  const xt = niceTicks(Math.min(...ok.map((p) => p.x), ...refX.map((r) => r.x)), Math.max(...ok.map((p) => p.x), ...refX.map((r) => r.x)));
  const y0 = yt[0], y1 = yt[yt.length - 1], x0 = xt[0], x1 = xt[xt.length - 1];
  const sx = (v) => L + ((v - x0) / ((x1 - x0) || 1)) * (w - L - R);
  const sy = (v) => T + (1 - (v - y0) / ((y1 - y0) || 1)) * (h - T - B);
  const refs = refY.map((r) => `<line x1="${L}" x2="${w - R}" y1="${sy(r.y).toFixed(1)}" y2="${sy(r.y).toFixed(1)}" stroke="var(--warn)" stroke-width="1.2" stroke-dasharray="5 4"/><text x="${w - R}" y="${(sy(r.y) - 4).toFixed(1)}" class="lb" text-anchor="end">${esc(r.label)}</text>`).join('')
    + refX.map((r) => `<line y1="${T}" y2="${h - B}" x1="${sx(r.x).toFixed(1)}" x2="${sx(r.x).toFixed(1)}" stroke="var(--warn)" stroke-width="1.2" stroke-dasharray="5 4"/><text x="${(sx(r.x) + 4).toFixed(1)}" y="${T + 10}" class="lb">${esc(r.label)}</text>`).join('');
  const dots = ok.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4.5" fill="${p.color || seriesColor(0)}" stroke="var(--card)" stroke-width="2"><title>${esc(p.label || '')}: ${fmtTick(p.x)}, ${fmtTick(p.y)}</title></circle>`).join('');
  const xl = xt.map((v) => `<text x="${sx(v).toFixed(1)}" y="${h - B + 15}" class="lb" text-anchor="middle">${fmtTick(v)}</text>`).join('');
  return axes({ w, h, L, R, T, B, yt, sy, xlab, ylab, title }) + refs + dots + xl + '</svg>';
}

/** A legend row: identity is never colour alone, so every series is named next to its swatch. */
export const legend = (items) => `<div class="fig-legend">${items.map((it, i) => `<span><i style="background:${it.color || seriesColor(i)}"></i>${esc(it.name)}</span>`).join('')}</div>`;

/** Title, the chart, a caption, and SVG / PNG buttons. `name` becomes the file name. */
export function figure(svg, { title = '', caption = '', name = 'figure', legendItems = null } = {}) {
  if (!svg) return '';
  return `<figure class="fig" data-fig="${esc(name)}"><div class="fig-head"><b>${esc(title)}</b><span class="fig-dl"><button type="button" data-fig-dl="svg" title="Save this graph as SVG (editable in Illustrator, Inkscape, PowerPoint)">SVG</button><button type="button" data-fig-dl="png" title="Save this graph as a PNG image for a slide">PNG</button></span></div>
    ${legendItems ? legend(legendItems) : ''}${svg}${caption ? `<figcaption class="muted">${esc(caption)}</figcaption>` : ''}</figure>`;
}

/** Copy the computed colours and type onto a clone, so the saved file does not depend on the page's CSS. */
function standalone(svg) {
  const clone = svg.cloneNode(true);
  const src = [svg, ...svg.querySelectorAll('*')], dst = [clone, ...clone.querySelectorAll('*')];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el), d = dst[i];
    for (const p of ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-size', 'font-family', 'font-weight']) {
      const v = cs.getPropertyValue(p); if (v) d.style.setProperty(p, v);
    }
  });
  const vb = svg.viewBox.baseVal;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', vb.width); clone.setAttribute('height', vb.height);
  clone.removeAttribute('style');
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', getComputedStyle(document.body).getPropertyValue('--card') || '#fff');
  clone.insertBefore(bg, clone.firstChild);
  return { text: new XMLSerializer().serializeToString(clone), w: vb.width, h: vb.height };
}

// A download in a browser, the save dialog in the macOS app (kit.js).
const save = (name, blob) => saveBlob(name, blob);

/** One delegated listener per root: the SVG and PNG buttons of every figure inside it. */
export function wireFigures(root) {
  if (!root || root.__figWired) return;
  root.__figWired = true;
  root.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-fig-dl]'); if (!b) return;
    // Screens wire their own root and a card inside it may wire itself too; one click saves one file.
    if (e.__figSaved) return; e.__figSaved = true;
    // the visible one: a figure can hold two views of the same plot (contour and 3D) with one hidden
    const fig = b.closest('.fig'); const svg = [...(fig?.querySelectorAll('svg') || [])].find((x) => x.getBoundingClientRect().width > 0); if (!svg) return;
    const name = (fig.dataset.fig || 'figure').replace(/[^\w.-]+/g, '_');
    const { text, w, h } = standalone(svg);
    if (b.dataset.figDl === 'svg') { save(`${name}.svg`, new Blob([text], { type: 'image/svg+xml' })); return; }
    const img = new Image(), scale = 3;
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = w * scale; c.height = h * scale;
      const g = c.getContext('2d'); g.scale(scale, scale); g.drawImage(img, 0, 0);
      c.toBlob((blob) => blob && save(`${name}.png`, blob), 'image/png');
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
  });
}

/*
 * Print. A report goes on white paper whatever theme the screen is in, so its charts cannot borrow the page's
 * colours the way the screen's do: in dark mode that would print light grey ink on white. printSvg() is the
 * idea of standalone() above — write the colours into the SVG so it needs no style sheet — applied to the
 * chart's markup with the light palette, rather than to a drawn element with whatever the screen computed.
 * Working on the string means a report is assembled, and tested, without drawing anything first.
 */

/**
 * The light theme's tokens as index.html sets them on :root (a test keeps the two in step), with one change:
 * the page colour is white, because the paper is. A label halo drawn in the screen's off-white would show.
 */
export const PRINT_COLOURS = {
  bg: '#FFFFFF', card: '#FFFFFF', line: 'rgba(0,0,0,0.09)', 'line-strong': 'rgba(0,0,0,0.16)',
  ink: '#1C1C1E', ink2: '#6E6E73', ink3: '#AEAEB2', accent: '#0A7AFF',
  ok: '#34C759', 'ok-text': '#1E7B3A', warn: '#FF9500', 'warn-text': '#8A4B00',
  'c-doe': '#5856D6', 'c-ml': '#BF5AF2', 'c-advisor': '#FF9F0A', 'c-stocks': '#AF52DE',
  s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', s4: '#eda100', s5: '#e87ba4', s6: '#008300', s7: '#6250d6', s8: '#e34948',
};

/**
 * A chart SVG (from this file, doeplots.js or designviz.js) that prints the same in any theme: every
 * var(--token) replaced by its light colour (or the fallback the chart named), and the `svg .class` rules of
 * index.html carried inside it, resolved, so axes and labels keep their colour on a page without that sheet.
 */
export function printSvg(svg, colours = PRINT_COLOURS) {
  if (!svg) return '';
  const c = (k) => colours[k] || colours.ink;
  const css = `.ax{stroke:${c('line-strong')}}.lb{fill:${c('ink2')};font-size:11px}.mn{stroke:${c('ink2')}}.lm{stroke:${c('warn')}}`
    + `.ol{stroke:${c('warn-text')}}.ac{stroke:${c('accent')}}.af{fill:${c('accent')}}`
    + `.lbHalo text{paint-order:stroke;stroke:${c('bg')};stroke-width:3px;stroke-linejoin:round}`;
  return String(svg)
    .replace(/var\(--([\w-]+)\s*(?:,\s*([^()]*?))?\s*\)/g, (m, name, fallback) => colours[name] || (fallback ? fallback.trim() : colours.ink))
    .replace(/<svg\b([^>]*)>/, (m, attrs) => `<svg${/\sxmlns=/.test(attrs) ? '' : ' xmlns="http://www.w3.org/2000/svg"'}${attrs}><style>${css}</style>`);
}
