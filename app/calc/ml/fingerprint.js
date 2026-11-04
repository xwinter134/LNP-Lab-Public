// The model fingerprint (spec 7.5): what a suggestion or an analysis was made from, written down precisely enough
// to make it again. A paper's methods section or a patent's example has to say which data and which model gave a
// proposed formulation, and "the optimizer in March" is not an answer once the database has grown.
//
// It holds the formulations used (their ids, and for a point the data budget merged, the ids of the runs merged
// into it, in order) and a SHA-256 of their values, so a later edit to one result shows; the selection (lipid,
// mixer, budget), the lipid mode and how it was chosen, the free factors and their ranges, the goals and their
// weights, the limits, the split, the acquisition mode, the batch size and the seed; the app's version and this
// module's (ML_CODE_VERSION, raised whenever a change here can move a suggestion); the replicate noise measured
// before merging; and what the fit came to (lengthscales, noise, the lipid matrix) with the settings proposed.
// One more SHA-256 over all of that is the fingerprint's own name, short enough to quote.
//
// Reproducing (pipeline.js, reproduce) rebuilds the training points from the ids, checks their hash, refits with
// everything as recorded and compares: the data, the fitted hyperparameters and the proposed settings. The fit is
// deterministic, so on unchanged data and code the three agree exactly; a newer app version that changed the
// mathematics says so instead of failing silently.
import { sha256 } from '../sha256.js';
import { hyperparameters } from './gp.js';

/** Raised with any change to app/calc/ml that can move a fit or a suggestion. */
export const ML_CODE_VERSION = '4.1.0';

/** Numbers to 12 significant digits, keys sorted: the same object gives the same text on every platform. */
export function canonical(v) {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return 'null';
  if (typeof v === 'number') return JSON.stringify(Number(v.toPrecision(12)));
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return `[${Array.from(v).map(canonical).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return 'null';
}
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
export const hashOf = (v) => hex(sha256(new TextEncoder().encode(canonical(v))));

/** The training records as the hash sees them: id(s), lipid, the searched factors, the goals' values. */
export function records(rows, space, goalNames) {
  return rows.map((r) => ({ id: r.mergedFrom ? [...r.mergedFrom] : r.batchId, lipid: r.lipid ?? null,
    factors: Object.fromEntries(space.map((s) => [s.key, r.factors[s.key] ?? null])),
    values: Object.fromEntries(goalNames.map((n) => [n, Number.isFinite(r.values[n]) ? r.values[n] : null])) }));
}

/** The setup a fingerprint records, from the screen's state, in a fixed shape. */
export function setupOf(s) {
  return {
    space: s.space.map((f) => ({ key: f.key, lo: f.lo, hi: f.hi, step: f.step ?? null })),
    goals: s.goals.filter((g) => g.on !== false).map((g) => ({ name: g.name, goal: g.goal, target: g.target ?? null, lo: g.lo ?? null, hi: g.hi ?? null, best: g.best ?? null, worst: g.worst ?? null, weight: g.weight ?? 1 })),
    constraints: (s.constraints || []).map((c) => ({ name: c.name, op: c.op, value: c.value })),
    strategy: s.strategy || 'experiment', acquisition: s.mode || 'balanced', q: s.q ?? 4, seed: s.seed ?? 7,
    lipidMode: s.lipidMode || 'filter', lipid: s.lipid ?? null, mixer: s.mixer ?? null, budget: s.budget ?? null,
    // The parent recipe's class mol%, which fixes the lipids the space neither varies nor balances.
    baseClasses: s.baseClasses || null,
  };
}

/**
 * Build the fingerprint of one run of the optimizer.
 * @param {object} o  {report: score() output (or fitModels'), setup: setupOf(...), appVersion}
 */
export function makeFingerprint({ report, setup, appVersion = '' }) {
  const goalNames = setup.goals.map((g) => g.name);
  const target = report.rows || [];
  const others = report.selection?.others || [];
  const recs = records([...target, ...others], setup.space, goalNames);
  const body = {
    schema: 1, mlVersion: ML_CODE_VERSION, appVersion: appVersion || '',
    setup, mode: report.lipidChoice?.mode || 'filter', chosenBy: report.lipidChoice?.chosenBy || 'user',
    compared: (report.lipidChoice?.compared || []).map((c) => ({ mode: c.mode, q2: c.q2 })),
    n: recs.length, nTarget: target.length, ids: recs.map((r) => r.id), dataHash: hashOf(recs),
    noise: report.selection?.noise || null,
    // The lipid kernel's rank and, in descriptor mode, the descriptors as they were read: reproducing uses these,
    // so a descriptor corrected since does not make an old round irreproducible.
    rank: report.lipidChoice?.rank ?? 1,
    ...(report.lipidDescriptors ? { descriptors: report.lipidDescriptors } : {}),
    hyper: Object.fromEntries((report.models || []).map((m) => [m.name, hyperparameters(m.gp)])),
    suggestions: (report.suggestions?.picks || []).map((p) => p.point),
  };
  return { ...body, hash: hashOf(body) };
}

/** A short name for a fingerprint, as the screen and the printed record quote it. */
export const shortHash = (fp) => (fp?.hash ? fp.hash.slice(0, 12) : '');

/**
 * Compare a fingerprint with one made again (pipeline.js, reproduce). Hyperparameters and settings are compared
 * as recorded, to 12 significant digits, which is where canonical() rounds.
 */
export function compareFingerprints(was, now) {
  const same = (a, b) => canonical(a) === canonical(b);
  const data = was.dataHash === now.dataHash;
  const model = same(was.hyper, now.hyper);
  const suggestions = same(was.suggestions, now.suggestions);
  const code = was.mlVersion === now.mlVersion;
  const all = data && model && suggestions;
  const sentence = all
    ? `Reproduced: the same ${was.n} records, the same fitted model and the same ${was.suggestions.length} suggested setting${was.suggestions.length === 1 ? '' : 's'}.`
    : !data ? 'Not reproduced: the records have changed since (a result edited, or a formulation corrected), so the data hash differs.'
      : !code ? `Not reproduced: the data is the same, but this app's optimizer (${now.mlVersion}) is not the one that made it (${was.mlVersion}).`
        : !model ? 'Not reproduced: the same data gave a different fitted model.'
          : 'Not reproduced: the same model proposed different settings.';
  return { data, model, suggestions, code, match: all, sentence };
}
