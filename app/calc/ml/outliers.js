// Results worth a second look before the model learns from them (ml-b ML-03). The import check ("far from the
// others in this import") needs five samples and an optimizer round has four, so on the optimizer's own loop
// it could never fire; a typo such as 258 nm for 80 nm went into the fit unseen and bent every surface.
//
// Two independent tests, both about one formulation's own result, never about a whole experiment:
//   fit       leave-one-out. The fitted surface, refitted without this run (closed form, gp.js looPredictions),
//             expected something else: |measured - expected| / its predictive sd >= FIT_Z (3.5). The sd already
//             holds the measurement noise the fit estimated, so a noisy lab is not flagged for being noisy.
//   forecast  the optimizer gave this formulation a forecast when it proposed it (b.ml.predicted, a 95 %
//             interval of one batch there). A result >= FORECAST_Z (4) standard deviations from it is flagged.
// A flag also needs the miss to be large against the other runs (>= 3 robust spreads of all leave-one-out
// errors of that response), so a response whose every run is off a little does not flag its largest.
// 3.5 and 4 robust spreads, found on synthetic data (tests/mloutliers.test.mjs): no flag in 120 clean sets of 16
// to 40 runs, and a result at three times its value found in all 120 sets with one planted. A plain 4 SD missed it
// in 16 of 40 sets of 16 runs, because the outlier itself raises the noise the fit believes in.
export const FIT_Z = 3.5, FORECAST_Z = 4, SPREAD_K = 4;
import { looPredictions } from './gp.js';

const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };

/**
 * @param {object} fit  fitModels/score output: rows (used), models [{name, gp, yMean, ySd}], goals or responses
 * @param {object[]} [forecastRows]  buildRows() rows of the same formulations, for their stored forecasts
 * @returns {{batchId, ids (the formulations behind it: more than one when the data budget merged replicates), name, label, measured, expected, sd, z, source:'fit'|'forecast'}[]} one per formulation,
 *   the most extreme result first
 */
export function flagOutliers(fit, forecastRows = []) {
  const found = new Map();
  const keep = (f) => { const was = found.get(f.batchId); if (!was || Math.abs(f.z) > Math.abs(was.z)) found.set(f.batchId, f); };
  const used = fit?.rows || [];
  const label = new Map((fit?.responses || []).map((r) => [r.name, r.label || r.name]));
  for (const m of fit?.models || []) {
    if (!m.gp || m.gp.X?.length < 8) continue;
    const idx = used.map((r, i) => (Number.isFinite(r.values?.[m.name]) ? i : -1)).filter((i) => i >= 0);
    if (idx.length !== m.gp.X.length) continue; // the model was not fitted on these rows: nothing to compare
    let loo;
    try { loo = looPredictions(m.gp); } catch { continue; }
    const err = loo.map((p, i) => m.gp.y[i] - p.mean);
    const spread = 1.4826 * median(err.map((e) => Math.abs(e - median(err))));
    err.forEach((e, i) => {
      const sd = Math.sqrt(loo[i].variance);
      const z = e / sd;
      if (!(Math.abs(z) >= FIT_Z) || !(spread > 0 ? Math.abs(e - median(err)) >= SPREAD_K * spread : true)) return;
      const r = used[idx[i]];
      keep({ batchId: r.batchId, ids: r.mergedFrom || [r.batchId], name: m.name, label: label.get(m.name) || m.name, measured: r.values[m.name], expected: m.yMean + (m.gp.y[i] - e) * m.ySd, sd: sd * m.ySd, z, source: 'fit' });
    });
  }
  const inFit = new Set(used.map((r) => r.batchId));
  for (const r of forecastRows) {
    if (!r.mlPredicted || (inFit.size && !inFit.has(r.batchId) && !(r.mergedFrom || []).some((x) => inFit.has(x)))) continue;
    for (const [name, p] of Object.entries(r.mlPredicted)) {
      const y = r.values?.[name];
      if (!p || !Number.isFinite(p.mean) || !(p.sd > 0) || !Number.isFinite(y)) continue;
      const z = (y - p.mean) / p.sd;
      if (Math.abs(z) >= FORECAST_Z) keep({ batchId: r.batchId, ids: [r.batchId], name, label: label.get(name) || name, measured: y, expected: p.mean, sd: p.sd, z, source: 'forecast' });
    }
  }
  return [...found.values()].sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}
