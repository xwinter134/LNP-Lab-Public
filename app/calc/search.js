// Search across the lab's records: what the sidebar box finds as you type. Pure: plain records in, ranked
// hits out, each naming the screen that opens it. No DOM, no store.
//
// Matching works on tokens rather than on characters. "E6-F1_4C_T07", "e6f1", "E6 F1" and "e6-f1" have to
// find the same thing, so case and punctuation are ignored; but simply deleting the punctuation would turn
// "E6-F1_4C" into "e6f14c", and a search for E6-F14 would then turn up E6-F1's samples at 4 °C. Splitting
// into runs of letters and runs of digits keeps that boundary: E6-F1_4C_T07 is [e 6 f 1 4 c t 07], E6-F14 is
// [e 6 f 14], and "e6f14" only lines up with the second. Numbers compare as numbers, so "Stock-1" finds
// Stock-001 and "T7" finds T07.

import { cargoLabel } from './cargo.js';
import { thawCount } from './freezethaw.js';

const cargo = (id) => cargoLabel(id);

/** Every kind of record the box finds, in the order its groups are listed when they rank equally. */
export const KINDS = [
  { id: 'experiment', label: 'Experiments' },
  { id: 'formulation', label: 'Formulations' },
  { id: 'sample', label: 'Samples' },
  { id: 'stock', label: 'Lipid stocks' },
  { id: 'buffer', label: 'Buffers' },
  { id: 'rna', label: 'RNA lots' },
  { id: 'composition', label: 'Compositions' },
];
const KIND_ORDER = Object.fromEntries(KINDS.map((k, i) => [k.id, i]));

/** Lower case, accents dropped, split into runs of letters and runs of digits; everything else separates. */
export function tokens(text) {
  return String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/\p{L}+|\p{N}+/gu) || [];
}

const isNum = (t) => /^\p{N}+$/u.test(t);
const noZeros = (t) => t.replace(/^0+(?=\d)/, '');
const same = (q, k) => q === k || (isNum(q) && isNum(k) && noZeros(q) === noZeros(k));
// "0" typed towards "007" is on its way there; so is "7" towards "07".
const startsWith = (k, q) => k.startsWith(q) || (isNum(q) && isNum(k) && noZeros(k).startsWith(noZeros(q)));

// How well a query lines up with one key. The tiers are the ranking the box promises: the whole key, then
// the start of it, then a later word of it, then the middle of a word.
export const TIER = { exact: 3, prefix: 2, word: 1.2, inside: 0.6 };
// Inside a tier, a query whose last token is complete beats one still being typed: for "e6f1", E6-F1's
// samples (E6-F1_4C_T07) come before E6-F14's (E6-F14_final), although both start with what was typed.
const WHOLE = 0.1;

/**
 * The best tier at which the query tokens `q` match the key tokens `k`, or 0. Every query token has to land
 * on consecutive key tokens. The last one may be the start of its token (still being typed); an earlier word
 * may be an abbreviation ("exp 3" for Experiment 3), but an earlier number may not, or "e6f14" would match
 * E6-F1_4C. The first may sit inside its token ("lin" in DLin), which is the weakest kind of match.
 */
export function matchTier(q, k) {
  if (!q.length || !k.length || q.length > k.length) return 0;
  let best = 0;
  for (let s = 0; s + q.length <= k.length; s++) {
    let exact = true, inside = false, ok = true;
    for (let i = 0; i < q.length && ok; i++) {
      const qt = q[i], kt = k[s + i], last = i === q.length - 1;
      if (same(qt, kt)) continue;
      exact = false;
      if (last && startsWith(kt, qt)) continue;
      if (!last && !isNum(qt) && !isNum(kt) && kt.startsWith(qt)) continue;
      if (i === 0 && (last ? kt.includes(qt) : kt.endsWith(qt))) { inside = true; continue; }
      ok = false;
    }
    if (!ok) continue;
    const whole = same(q[q.length - 1], k[s + q.length - 1]) ? WHOLE : 0;
    const tier = inside ? TIER.inside : s > 0 ? TIER.word + whole : exact && q.length === k.length ? TIER.exact : TIER.prefix + whole;
    if (tier > best) best = tier;
    if (best === TIER.exact) break;
  }
  return best;
}

// A key is an id (E3-F2, Stock-001, a sample name, a composition number) or a name. An id that matches
// ranks half a tier above a name that matches as well: E3 itself before an experiment that is called "E3 repeat".
const ID_BONUS = 0.5;
const key = (text, id = false) => ({ text: String(text), id, t: tokens(text) });

const latestFirst = (a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

/**
 * Everything searchable, built once per search session from the records.
 * src: {experiments, batches, measurements, stocks, buffers, rnaLots, compositions}
 * opts: {typeName(typeId), fmtDate(iso), compositionName(id)} for the second line of each hit.
 * Each entry: {kind, id, title, sub, keys, screen, params}; `screen` and `params` are what to open.
 */
export function buildIndex(src = {}, opts = {}) {
  const fmtDate = opts.fmtDate || ((d) => d || '');
  const typeName = opts.typeName || ((t) => t || '');
  const compName = opts.compositionName || ((id) => (id != null ? `#${id}` : ''));
  const experiments = src.experiments || [], batches = src.batches || [], measurements = src.measurements || [];
  const out = [];
  const expById = new Map(experiments.filter((e) => e?.id).map((e) => [e.id, e]));

  for (const e of experiments) {
    if (!e?.id) continue;
    const no = /^E(\d+)$/.exec(e.id)?.[1];
    const n = (e.batchIds || []).length || batches.filter((b) => b.experimentId === e.id).length;
    out.push({
      kind: 'experiment', id: e.id, title: `${e.id} · ${e.name || 'untitled'}`,
      // The cargo is said when it is not the usual mRNA, and found either way ("siRNA" lists the siRNA experiments).
      sub: [typeName(e.type), cargo(e.spec?.cargo) !== 'mRNA' ? cargo(e.spec?.cargo) : '', e.startDate ? `started ${fmtDate(e.startDate)}` : '', `${n} formulation${n === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
      keys: [key(e.id, true), ...(no ? [key(`Experiment ${no}`, true)] : []), ...(e.name ? [key(e.name)] : []), key(cargo(e.spec?.cargo))],
      screen: 'experiments', params: { id: e.id },
    });
  }

  for (const b of batches) {
    if (!b?.id) continue;
    const e = expById.get(b.experimentId);
    out.push({
      kind: 'formulation', id: b.id, title: b.label ? `${b.id} · ${b.label}` : b.id,
      sub: [e ? `${e.id} · ${e.name || ''}` : b.experimentId, b.status].filter(Boolean).join(' · '),
      keys: [key(b.id, true), ...(b.label ? [key(b.label)] : [])],
      screen: 'formulation', params: { batch: b.id },
    });
  }

  // A sample name is what is written on the tube and in the instrument export. It may be expected (an open
  // slot), measured (a stored result) or both, once per test; it is listed once. A measured sample opens its
  // latest result, one still to measure opens the entry form on its earliest open slot.
  const samples = new Map();
  const sampleOf = (name, batchId, experimentId) => {
    if (!samples.has(name)) samples.set(name, { name, batchId, experimentId, open: [], done: [] });
    return samples.get(name);
  };
  for (const e of experiments) {
    for (const s of e?.expected || []) {
      if (!s?.sampleName) continue;
      const x = sampleOf(s.sampleName, s.batchId, e.id);
      if (s.status === 'open') x.open.push(s);
    }
  }
  for (const m of measurements) {
    if (!m?.sampleName) continue;
    sampleOf(m.sampleName, m.batchId, m.experimentId).done.push(m);
  }
  for (const x of samples.values()) {
    const latest = x.done.slice().sort(latestFirst)[0];
    const nextOpen = x.open.slice().sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')))[0];
    const dls = x.done.filter((m) => m.test === 'dls' && Number.isFinite(m.values?.zave_nm)).sort(latestFirst)[0];
    const tests = (list) => [...new Set(list.map((s) => String(s.test || '').toUpperCase()).filter(Boolean))].join(', ');
    const state = [
      dls ? `${round(dls.values.zave_nm, 1)} nm${Number.isFinite(dls.values.pdi) ? ` / ${round(dls.values.pdi, 2)}` : ''}` : x.done.length ? `${tests(x.done)} measured` : '',
      nextOpen ? `${tests(x.open)} due ${fmtDate(nextOpen.dueDate)}` : '',
    ].filter(Boolean).join(' · ');
    out.push({
      kind: 'sample', id: x.name, title: x.name, sub: [x.batchId, state].filter(Boolean).join(' · '),
      keys: [key(x.name, true)],
      ...(latest ? { screen: 'measurements', params: { id: latest.id } }
        : nextOpen ? { screen: 'measurements', params: { slot: nextOpen.id } }
          : { screen: 'experiments', params: { id: x.experimentId || '' } }),
    });
  }

  for (const s of src.stocks || []) {
    if (!s?.id) continue;
    const mM = s.molarityActual_mM || s.molarity_mM;
    out.push({
      kind: 'stock', id: s.id, title: `${s.id} · ${compName(s.compositionId)}`,
      sub: [Number.isFinite(mM) ? `${round(mM, 1)} mM` : '', s.date ? `made ${fmtDate(s.date)}` : '', s.expiry ? `expires ${fmtDate(s.expiry)}` : '', s.status, thawCount(s) ? `${thawCount(s)} F/T` : ''].filter(Boolean).join(' · '),
      keys: [key(s.id, true), ...(s.lot && s.lot !== s.id ? [key(s.lot, true)] : [])],
      screen: 'stocks', params: { id: s.id },
    });
  }

  for (const b of src.buffers || []) {
    if (!b?.id) continue;
    const lot = b.lot || b.id;
    out.push({
      kind: 'buffer', id: b.id, title: b.name ? `${lot} · ${b.name}` : lot,
      sub: [b.date ? `prepared ${fmtDate(b.date)}` : '', (b.roles || []).join(', ')].filter(Boolean).join(' · '),
      keys: [key(lot, true), ...(b.id !== lot ? [key(b.id, true)] : []), ...(b.name ? [key(b.name)] : [])],
      screen: 'buffers', params: { id: b.id },
    });
  }

  for (const r of src.rnaLots || []) {
    if (!r?.id) continue;
    out.push({
      kind: 'rna', id: r.id, title: r.construct ? `${r.id} · ${r.construct}` : r.id,
      sub: [cargo(r.cargo), Number.isFinite(r.conc_mg_mL) ? `${round(r.conc_mg_mL, 2)} mg/mL` : '', r.supplier].filter(Boolean).join(' · '),
      keys: [key(r.id, true), ...(r.construct ? [key(r.construct)] : []), key(cargo(r.cargo))],
      screen: 'materials', params: { tab: 'rna' },
    });
  }

  for (const c of src.compositions || []) {
    if (c?.id == null) continue;
    const name = c.synonym || c.name || '';
    out.push({
      kind: 'composition', id: String(c.id), title: `#${c.id}${name ? ' · ' + name : ''}`,
      sub: Object.entries(c.mol_pct || {}).map(([k, v]) => `${k} ${v}`).join(' / '),
      keys: [key(String(c.id), true), ...(name ? [key(name)] : []), ...(c.name && c.name !== name ? [key(c.name)] : [])],
      screen: 'materials', params: { tab: 'compositions' },
    });
  }
  return out;
}

function round(x, d) { const p = 10 ** d; return (Math.round(x * p) / p).toFixed(d); }

// Natural order for ties, so E2 comes before E10 and Stock-002 before Stock-010.
const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

/** How well one entry matches, 0 when it does not: the best of its keys. */
export function scoreEntry(entry, q) {
  let best = 0, len = Infinity;
  for (const k of entry.keys) {
    const tier = matchTier(q, k.t);
    if (!tier) continue;
    const s = tier + (k.id ? ID_BONUS : 0);
    if (s > best || (s === best && k.t.length < len)) { best = s; len = k.t.length; }
  }
  return { score: best, len };
}

/**
 * Ranked hits for a query, grouped by kind. Groups are ordered by their best hit (a query that is a stock id
 * lists stocks first), and inside a group by score, then the closer match (fewer tokens left over), then
 * natural id order. `perKind` caps each group; `more` says how many it left out.
 * Returns {groups: [{kind, label, items, more}], total}.
 */
export function search(index, query, { perKind = 5 } = {}) {
  const q = tokens(query);
  if (!q.length) return { groups: [], total: 0 };
  const byKind = new Map();
  for (const e of index) {
    const { score, len } = scoreEntry(e, q);
    if (!score) continue;
    if (!byKind.has(e.kind)) byKind.set(e.kind, []);
    byKind.get(e.kind).push({ ...e, score, len });
  }
  const groups = [...byKind.entries()].map(([kind, hits]) => {
    hits.sort((a, b) => b.score - a.score || a.len - b.len || natural(a.id, b.id));
    return { kind, label: KINDS.find((k) => k.id === kind)?.label || kind, items: hits.slice(0, perKind), more: Math.max(0, hits.length - perKind), best: hits[0].score };
  });
  groups.sort((a, b) => b.best - a.best || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  return { groups: groups.map(({ best, ...g }) => g), total: groups.reduce((s, g) => s + g.items.length + g.more, 0) };
}

/** The hash a hit opens, as the router reads it: `#/formulation?batch=E3-F2`. */
export function hitHref(hit) {
  const q = new URLSearchParams(Object.entries(hit.params || {}).filter(([, v]) => v != null && v !== '')).toString();
  return `#/${hit.screen}${q ? '?' + q : ''}`;
}
