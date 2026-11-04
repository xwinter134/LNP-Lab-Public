// The historical benchmark (spec 7.7): would the optimizer have found a real campaign's best recipe with fewer
// batches than the lab needed at the time?
//
// The replay starts from the campaign's first 8 runs, in the order they were made, and may only "measure" runs
// that were really made: its candidate set is the campaign's remaining runs, and choosing one reveals the result
// recorded for it. Each round it fits the app's own models (app/calc/ml) to what it has revealed, scores the
// remaining runs by the same expected improvement the Optimizer screen uses, and reveals the best q. It stops
// when the campaign's best recipe (the run with the highest overall score under the app's default goals, as
// measured) has been revealed. The answer is the number of runs that took, against the position of that recipe
// in the historical order.
//
// Restricting the candidates to runs that were made is what makes a replay honest, and also what limits it: the
// optimizer cannot propose the recipe nobody tried, so the benchmark measures how fast it would have walked the
// lab's own path, not how good its own proposals are. That second question is tests/usability/campaign.mjs.
//
//   npm run history -- --db <lnp-lab.db> --campaign E12,E13,E14 [--ns lnp-lab] [--q 4] [--out docs/history-benchmark]
//       a real campaign: the experiments named, from the macOS app's SQLite file (read only)
//   npm run history -- --sim [--seeds 5] [--runs 40] [--q 4] [--out docs/history-benchmark]
//       the simulated lab (tests/usability/lab.mjs): a "historical" campaign of LHS runs in random order, to
//       test the harness until a finished real campaign with its run order is available (an open point)
//
// Writes <out>.md (the table) and <out>.svg (best score so far against runs, history against replay).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fitModels } from '../../app/calc/ml/optimizer.js';
import { suggestRuns, latinHypercube } from '../../app/calc/ml/acquire.js';
import { toUnit, fromUnit, snap, suggestSpace } from '../../app/calc/ml/space.js';
import { overallDesirability, DEFAULT_GOALS } from '../../app/calc/ml/objective.js';
import { buildRows } from '../../app/calc/ml/dataset.js';
import { mulberry32 } from '../../app/calc/ml/linalg.js';
import { truth, rng } from './lab.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => { const i = process.argv.lastIndexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes('--' + k);
const Q = Number(arg('q', '4'));
const START = 8;
const GOALS = DEFAULT_GOALS.filter((g) => g.on !== false);
const OUT = path.resolve(root, arg('out', 'docs/history-benchmark'));
const D = (r) => overallDesirability(r.values, GOALS).D;

/** Replay one campaign. `runs` in historical order, each {batchId, factors, values}. */
export function replay(runs, space, { q = Q, seed = 7 } = {}) {
  const best = runs.reduce((b, r) => (D(r) > D(b) ? r : b), runs[0]);
  const historical = runs.indexOf(best) + 1;
  const known = runs.slice(0, START), pool = runs.slice(START);
  const trace = [];
  const bestSoFar = (xs) => Math.max(...xs.map(D));
  known.forEach((_, i) => trace.push(bestSoFar(known.slice(0, i + 1))));
  let round = 0;
  while (!known.includes(best) && pool.length) {
    round++;
    const fit = fitModels({ rows: known.map((r) => ({ ...r, experimentId: r.experimentId || `round${Math.floor((known.indexOf(r) - START) / q) + 1}` })), space, goals: GOALS, strategy: 'experiment', seed: seed + round });
    const models = fit.models.filter((m) => m.gp);
    let chosen;
    if (models.length) {
      const cand = pool.map((r) => toUnit(r.factors, space));
      const s = suggestRuns({ models, space, goals: GOALS.filter((g) => models.some((m) => m.name === g.name)), observed: known.map((r) => ({ point: r.factors, values: r.values })),
        q: Math.min(q, pool.length), seed: seed + round, candidates: cand, minSeparation: 0 });
      chosen = s.picks.map((p) => pool[cand.indexOf(p.unit)]).filter(Boolean);
    }
    if (!chosen?.length) chosen = pool.slice(0, q); // nothing to model yet: take them in the order they were made
    for (const r of chosen) { pool.splice(pool.indexOf(r), 1); known.push(r); trace.push(bestSoFar(known)); }
  }
  return { n: runs.length, best: best.batchId, bestD: D(best), historical, replay: known.indexOf(best) + 1, rounds: round,
    historyTrace: runs.map((_, i) => bestSoFar(runs.slice(0, i + 1))), replayTrace: trace };
}

/** A real campaign from the macOS app's SQLite file: the named experiments' measured runs, in production order. */
async function fromDb(file, expIds, ns = 'lnp-lab') {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  const cols = {};
  for (const { key, json } of db.prepare('SELECT key, json FROM collections').all()) {
    // One lab's collections: the file also holds the demo lab's, under its own namespace.
    const m = /^([^.]+)\.(.+)$/.exec(key);
    if (m && m[1] === ns && !/\./.test(m[2])) { try { cols[m[2]] = JSON.parse(json); } catch { /* not a collection */ } }
  }
  const list = (c) => (Array.isArray(cols[c]) ? cols[c] : Object.values(cols[c] || {}));
  const store = { all: (c) => list(c), get: (c, id) => list(c).find((x) => x.id === id) || null };
  const data = {};
  for (const f of ['lipids', 'compositions', 'buffers_catalog', 'tff_modules', 'materials', 'pka', 'reagents']) data[f] = JSON.parse(fs.readFileSync(path.join(root, 'app/data', f + '.json'), 'utf8'));
  data.lipidByKey = Object.fromEntries(data.lipids.map((l) => [l.key, l]));
  data.compositionById = Object.fromEntries(data.compositions.map((c) => [c.id, c]));
  const want = new Set(expIds);
  const order = new Map(list('batches').map((b) => [b.id, `${b.plannedDate || ''}|${b.id}`]));
  const rows = buildRows({ store, data }).filter((r) => want.has(r.experimentId) && GOALS.every((g) => Number.isFinite(r.values[g.name])))
    .sort((a, b) => String(order.get(a.batchId)).localeCompare(String(order.get(b.batchId))));
  const space = suggestSpace(rows).map((f) => ({ ...f, lo: Math.min(f.lo, f.observedLo), hi: Math.max(f.hi, f.observedHi) }));
  return { rows: rows.filter((r) => space.every((s) => Number.isFinite(r.factors[s.key]))), space };
}

/** A simulated "historical" campaign: n runs spread over the space, made in random order, measured with noise. */
export function simulated(seed, n = 40) {
  const space = [
    { key: 'frr', name: 'Flow rate ratio', lo: 2, hi: 5, step: 0.1 },
    { key: 'tfr', name: 'Total flow rate', lo: 40, hi: 140, step: 1 },
    { key: 'np', name: 'N/P ratio', lo: 3, hi: 10, step: 0.5 },
    { key: 'peg_pct', name: 'PEG-lipid', lo: 0.5, hi: 3, step: 0.1 },
  ];
  const r = rng(300 + seed);
  const pts = latinHypercube(n, space.length, mulberry32(11 + seed)).map((u) => snap(fromUnit(Array.from(u), space), space));
  const rows = pts.map((p, i) => {
    const t = truth({ frr: p.frr, tfr: p.tfr, np: p.np, peg: p.peg_pct });
    return { batchId: `S${seed}-${i + 1}`, experimentId: `H${Math.floor(i / 4)}`, factors: p,
      values: { particle_size_nm: t.zave_nm + r.g() * 2.5, PDI: Math.max(0.015, t.pdi + r.g() * 0.008), encapsulation_efficiency: Math.min(99.5, t.ee_pct + r.g() * 1.2) } };
  });
  return { rows, space };
}

function svg(results, title) {
  const W = 640, H = 300, L = 50, B = 40, T = 30, R = 16;
  const n = Math.max(...results.map((x) => x.n));
  const sx = (i) => L + (i / Math.max(1, n - 1)) * (W - L - R), sy = (d) => H - B - d * (H - T - B);
  const line = (tr, colour, dash = '') => `<polyline points="${tr.map((d, i) => `${sx(i).toFixed(1)},${sy(d).toFixed(1)}`).join(' ')}" fill="none" stroke="${colour}" stroke-width="1.6" opacity=".8" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" font-size="11">
  <rect width="${W}" height="${H}" fill="#fff"/>
  <text x="${L}" y="18" font-size="13" font-weight="600">${title}</text>
  ${results.map((x) => line(x.historyTrace, '#888', '4 3') + line(x.replayTrace, '#BF5AF2')).join('\n  ')}
  <line x1="${sx(START - 1)}" y1="${T}" x2="${sx(START - 1)}" y2="${H - B}" stroke="#bbb"/><text x="${sx(START - 1) + 4}" y="${T + 10}" fill="#666">first ${START} runs</text>
  <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}" stroke="#333"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#333"/>
  <text x="${L - 6}" y="${sy(1) + 4}" text-anchor="end">1.0</text><text x="${L - 6}" y="${sy(0) + 4}" text-anchor="end">0</text>
  <text x="${(L + W - R) / 2}" y="${H - 10}" text-anchor="middle">runs made; best overall score so far (grey dashed: as it happened; purple: optimizer replay)</text>
</svg>\n`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const results = [];
  let source;
  if (arg('db', null)) {
    const ids = String(arg('campaign', '')).split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) throw new Error('--campaign <experiment ids, comma separated> is needed with --db');
    const { rows, space } = await fromDb(path.resolve(arg('db')), ids, arg('ns', 'lnp-lab'));
    if (rows.length <= START) throw new Error(`the campaign has ${rows.length} runs with every goal measured; a replay needs more than ${START}`);
    source = `real campaign ${ids.join(', ')} (${rows.length} runs, factors ${space.map((s) => s.key).join(', ')})`;
    results.push({ label: ids.join(','), ...replay(rows, space) });
  } else {
    const seeds = Number(arg('seeds', '5')), n = Number(arg('runs', '40'));
    source = `simulated lab (tests/usability/lab.mjs), ${seeds} campaigns of ${n} runs in random order; NOT real data`;
    for (let s = 0; s < seeds; s++) { const { rows, space } = simulated(s, n); results.push({ label: `sim ${s}`, ...replay(rows, space) }); }
  }
  const lines = results.map((x) => `| ${x.label} | ${x.n} | ${x.best} | ${x.bestD.toFixed(3)} | ${x.historical} | ${x.replay} | ${x.historical - x.replay > 0 ? `${x.historical - x.replay} fewer` : x.historical === x.replay ? 'same' : `${x.replay - x.historical} more`} |`);
  const fewer = results.filter((x) => x.replay < x.historical).length;
  const md = `# Historical benchmark (spec 7.7)\n\nSource: ${source}.\n\nThe optimizer starts from the first ${START} runs in the order they were made and may only reveal runs that were really made, ${Q} per round. Counted: runs until the campaign's best recipe (highest overall score under the default goals, as measured) was revealed, against its position in the historical order.\n\n| Campaign | Runs | Best recipe | Score | Found at, historically | Found at, replay | Difference |\n|---|---|---|---|---|---|---|\n${lines.join('\n')}\n\nThe replay found the best recipe sooner in ${fewer} of ${results.length}.\n\n![Best score so far](${path.basename(OUT)}.svg)\n\nGenerated by \`npm run history\`. Until a finished historical campaign with its run order is available, this runs on the simulated lab only, and the stop rule's thresholds (app/calc/ml/stopping.js) stay as calibrated there.\n`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT + '.md', md);
  fs.writeFileSync(OUT + '.svg', svg(results, arg('db', null) ? 'Historical benchmark' : 'Historical benchmark, simulated lab'));
  console.log(md);
  console.log(`written to ${path.relative(root, OUT)}.md and .svg`);
}
