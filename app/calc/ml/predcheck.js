// Prediction against measurement (spec 7.6): every formulation the optimizer proposed keeps what it should
// measure (b.ml.predicted: the mean and the standard deviation of one batch made there, measurement noise
// included, as the screen showed it). Once its results are in, the two can be held against each other. Over all
// such formulations this says whether the model's error bars mean what they say: about 95 % of results should
// fall inside the 95 % interval. Far fewer, and the model is over-confident; nearly all with wide bars, and it is
// telling you less than it could. The course over the rounds shows whether it is getting better as data comes in.
import { RESPONSE_DEFS } from './dataset.js';

/** z for a two-sided 95 % interval. */
export const Z95 = 1.959964;

/**
 * @param {object[]} rows  buildRows() output; only rows with mlPredicted and a measured value count
 * @returns {{responses: {name,label,unit,points,n,hits,rate}[], overall: {n,hits,rate}, rounds: {experimentId,
 *   name, date, n, hits, rate, cumulative}[]}}
 */
export function predictionCheck(rows, defs = RESPONSE_DEFS) {
  const ml = rows.filter((r) => r.mlPredicted).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.batchId).localeCompare(String(b.batchId)));
  const responses = [];
  const all = [];
  for (const d of defs) {
    const points = [];
    for (const r of ml) {
      const p = r.mlPredicted[d.name], y = r.values[d.name];
      if (!p || !Number.isFinite(p.mean) || !Number.isFinite(p.sd) || !Number.isFinite(y)) continue;
      const z = p.sd > 0 ? (y - p.mean) / p.sd : (y === p.mean ? 0 : Infinity);
      const pt = { batchId: r.batchId, label: r.label, date: r.date, experimentId: r.experimentId, experimentName: r.experimentName,
        predicted: p.mean, sd: p.sd, lo: p.mean - Z95 * p.sd, hi: p.mean + Z95 * p.sd, measured: y, z, inside: Math.abs(z) <= Z95, response: d.name };
      points.push(pt); all.push(pt);
    }
    if (points.length) {
      const hits = points.filter((p) => p.inside).length;
      responses.push({ name: d.name, label: d.label, unit: d.unit || '', points, n: points.length, hits, rate: hits / points.length });
    }
  }
  const hits = all.filter((p) => p.inside).length;
  // One entry per ML round (its experiment), in the order the rounds were made, with the share so far.
  const byRound = new Map();
  for (const p of all) {
    const k = p.experimentId || p.batchId;
    if (!byRound.has(k)) byRound.set(k, { experimentId: k, name: p.experimentName || k, date: p.date, n: 0, hits: 0 });
    const e = byRound.get(k); e.n++; if (p.inside) e.hits++;
    if (String(p.date || '') < String(e.date || '')) e.date = p.date;
  }
  let cn = 0, ch = 0;
  const rounds = [...byRound.values()].sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).map((e) => {
    cn += e.n; ch += e.hits;
    return { ...e, rate: e.hits / e.n, cumulative: ch / cn };
  });
  return { responses, overall: { n: all.length, hits, rate: all.length ? hits / all.length : null }, rounds };
}

/** The hit rate in words, against the 95 % it should be. */
export function hitRateSentence(o) {
  if (!o?.n) return 'No suggested formulation has a measured result yet.';
  const pct = Math.round(o.rate * 100);
  const judge = o.n < 20 ? `With ${o.n} results this is still a rough figure.`
    : pct < 85 ? 'Well under 95 %: the model has been more sure of itself than it should be.'
      : pct > 99 ? 'Nearly every result inside: the error bars may be wider than they need to be.'
        : 'Close to the 95 % it should be.';
  return `${o.hits} of ${o.n} results (${pct} %) fell inside the 95 % interval the optimizer gave. ${judge}`;
}
