// Reference data as seen by the screens: the extracted JSON merged with the user's own records in the store.
import { devicesUsed } from './calc/process.js';

export const DEFAULT_SETTINGS = {
  id: 'default', operator: '', defaultFRR: 3, defaultQuenchFactor: 2,
  defaultWorking_mg_mL: 0.4, defaultLipidStock_mM: 50, defaultStockVolume_mL: 20, defaultFinal_mg_mL: 0.1,
  reminderTime: '09:00', weekendShift: true, stockExpiryDays: 30,
  ftWarnCycles: 5, // freeze–thaw cycles of a stock or a tracked lipid lot before the pickers warn (calc/freezethaw.js)
  driftBasis: 'auto', // how the size-drift response is expressed; 'auto' reads it off your own timepoints
  qc: { pdiMax: 0.2, zaveMin: 40, zaveMax: 150, eeMin: 85, countRateMin: 50 },
};

export function getSettings(ctx) {
  const s = ctx.store.get('settings', 'default') || {};
  // An empty default is no default: one stored as null (a field cleared before Settings kept the last number
  // typed, or an import) gives way to the shipped value rather than reaching new records and wizards empty. A
  // QC limit stored as null is different: that is a check switched off, which every screen reads as no limit.
  const kept = Object.fromEntries(Object.entries(s).filter(([k, v]) => !(v == null && typeof DEFAULT_SETTINGS[k] === 'number')));
  return { ...DEFAULT_SETTINGS, ...kept, qc: { ...DEFAULT_SETTINGS.qc, ...(s.qc || {}) } };
}

export function getRef(ctx) {
  const d = ctx.data, st = ctx.store;
  const lipids = [...d.lipids];
  for (const c of st.all('lipids')) { const i = lipids.findIndex((l) => l.key === c.key); if (i >= 0) lipids[i] = { ...lipids[i], ...c }; else lipids.push(c); }
  const lipidByKey = Object.fromEntries(lipids.map((l) => [l.key, l]));
  const lipidLots = st.all('lipidLots');
  const compositions = [...d.compositions, ...st.all('compositions').filter((c) => !d.compositionById[c.id])].sort((a, b) => a.id - b.id);
  const compositionById = Object.fromEntries(compositions.map((c) => [c.id, c]));
  const dialysis = mergeById(d.materials?.dialysis_devices || [], st.all('dialysis'));
  return {
    lipids, lipidByKey, lipidLots, compositions, compositionById,
    rnaLots: st.all('rnaLots'),
    buffersCatalog: d.buffers_catalog, buffers: st.all('buffers'),
    // TFF modules and dialysis devices: one or a few shipped examples, with the user's own added, edited or hidden
    // under Materials, as for the devices below. A shipped module has no id of its own; its part number is its id.
    tffModules: mergeById((d.tff_modules || []).map((m) => ({ id: m.part, ...m })), st.all('tffModules')),
    dialysis, materials: { ...d.materials, dialysis_cassettes: dialysisMenu(d.materials?.dialysis_cassettes || [], dialysis) },
    // Formulation devices and mixers: the shipped list, with the user's own added or edited under Materials.
    devices: mergeById(d.devices?.instruments || [], st.all('devices')), mixers: mergeById(d.devices?.mixers || [], st.all('mixers')),
    pka: d.pka, reagents: d.reagents,
  };
}

export function lipidLabel(ref, key) { const l = ref.lipidByKey[key]; return l ? l.name : key; }
export function compositionLabel(c, ref) {
  const parts = Object.entries(c.mol_pct).map(([k, v]) => `${lipidLabel(ref, k)} ${v}`).join(' / ');
  return `#${c.id}${c.synonym ? ' ' + c.synonym : ''} — ${parts}`;
}

/** Latest lot (by received date) with a purity for a lipid key, if the user recorded any. */
export function latestLipidLot(ref, key) {
  return ref.lipidLots.filter((l) => l.lipidKey === key).sort((a, b) => (b.received || '').localeCompare(a.received || ''))[0] || null;
}

/**
 * The formulation record's cassette menu, which is a list of names and is stored as the name chosen. The names
 * earlier versions shipped come first and stay, in their order: older records name them, and the record's
 * default is the fourth of them. The dialysis devices listed under Materials follow, shipped and the user's own.
 */
function dialysisMenu(legacy, devices) {
  const names = devices.map((x) => x.name).filter(Boolean);
  return [...legacy, ...names.filter((n) => !legacy.includes(n))];
}

/**
 * TFF modules that are no longer shipped, but that a formulation record with TFF switched on still names, are
 * copied into the user's own list (the `tffModules` collection) once, at start-up: the record keeps calculating
 * its load window and volume with the module it was planned with, instead of quietly falling back to whichever
 * module is listed first. Materials refuses to delete a module a record names, so a copy is never put back
 * against the user's wish. Returns the part numbers copied.
 */
export function keepRetiredTffModules(store, data) {
  const retired = data?.tff_modules_retired || [];
  if (!retired.length) return [];
  const have = new Set([...(data.tff_modules || []).map((m) => m.part), ...store.all('tffModules').map((m) => m.part)]);
  const named = new Set(store.all('batches').flatMap((b) => devicesUsed(b?.plan).tff));
  const copied = [];
  for (const m of retired) {
    if (!named.has(m.part) || have.has(m.part)) continue;
    store.put('tffModules', { id: m.part, ...m, notes: 'Was shipped with earlier versions; kept because a formulation record names it.' });
    copied.push(m.part);
  }
  return copied;
}

/** Shipped entries with the user's records laid over them by id; the user's own new ones after. */
function mergeById(shipped, own) {
  const out = shipped.map((s) => ({ ...s, ...(own.find((o) => o.id === s.id) || {}) }));
  for (const o of own) if (!shipped.some((s) => s.id === o.id)) out.push(o);
  return out.filter((x) => !x.deleted);
}
