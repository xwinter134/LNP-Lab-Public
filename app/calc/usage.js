// Where a component is used, and whether it may be deleted or only archived (spec 9.5, 12.2).
//
// One helper for every screen, instead of a check per screen: a lipid, a lipid lot, a composition, an RNA lot, a
// buffer lot, an instrument, a mixer, a TFF module, a dialysis device or a filter is "used" when a record that has
// to stay readable names it. Such a component is never removed from the store: its old records would point at
// nothing, or at a copy of it that no list can show again. It can be archived instead: hidden from lists and
// pickers, kept whole for the records that name it, and restorable. A component nothing names goes to the trash
// like any record, with Undo. The screens used to ask this each in their own way (materials.js had lipidUse,
// compositionUse, rnaLotUse, stocksUsing and a usedBy per catalogue); they now all ask whereUsed(), and keep
// their own sentences for the dialogs.
//
// Archiving is kept in its own small collection, `archive` ({id: 'lipid:DLin-MC3', kind, itemId, at}), rather
// than as a flag on each record: the shipped lipids, compositions, devices and filters are reference data, not
// records in the store, and an archive list covers them the same way as the lab's own.
//
// The same question decides what the trash may let go of (app/store.js): an entry whose records something still
// names is kept past its 30 days and through "Empty trash" (trashEntryUses), because erasing it would be a hard
// delete of a referenced record by another road. Records, formulations and stocks are not components, but they
// are in that list too: a deleted experiment's formulations that a study or a measurement names stay restorable.
import { devicesUsed } from './process.js';

export const ARCHIVE = 'archive';
/**
 * Every kind whereUsed() knows. `collection` is where the lab's own records of it live (null: only shipped);
 * `archivable` kinds can be archived from a screen; `key` is the field a record is named by when it is not `id`.
 */
export const KINDS = {
  lipid: { label: 'lipid', collection: 'lipids', key: 'key', archivable: true },
  lipidLot: { label: 'lipid lot', collection: 'lipidLots', archivable: true },
  composition: { label: 'composition', collection: 'compositions', archivable: true },
  rnaLot: { label: 'RNA lot', collection: 'rnaLots', archivable: true },
  buffer: { label: 'buffer lot', collection: 'buffers', archivable: true },
  device: { label: 'instrument', collection: 'devices', archivable: true },
  mixer: { label: 'mixer', collection: 'mixers', archivable: true },
  tffModule: { label: 'TFF module', collection: 'tffModules', archivable: true },
  dialysis: { label: 'dialysis device', collection: 'dialysis', archivable: true },
  filter: { label: 'filter', collection: null, archivable: true },
  stock: { label: 'lipid stock', collection: 'stocks' },
  batch: { label: 'formulation', collection: 'batches' },
  experiment: { label: 'experiment', collection: 'experiments' },
  study: { label: 'study', collection: 'studies' },
};
/** The kind whose records live in a collection, or null. */
export const kindOfCollection = (col) => Object.keys(KINDS).find((k) => KINDS[k].collection === col) || null;

const archiveId = (kind, id) => `${kind}:${id}`;

/** The archived ids of one kind, as a Set of strings. */
export function archivedSet(store, kind) {
  return new Set(store.all(ARCHIVE).filter((a) => a?.kind === kind).map((a) => String(a.itemId)));
}
export const isArchived = (store, kind, id) => archivedSet(store, kind).has(String(id));

/** Archive a component; returns the archive record. */
export function archive(store, kind, id, now = new Date()) {
  const rec = { id: archiveId(kind, id), kind, itemId: String(id), at: now.toISOString() };
  store.put(ARCHIVE, rec);
  return rec;
}
/** Bring an archived component back into the lists and pickers. */
export function unarchive(store, kind, id) { store.remove(ARCHIVE, archiveId(kind, id)); }

/** Items of a list that may be offered in a picker: not archived, unless it is the value already chosen. */
export function selectable(store, kind, list, idOf = (x) => x.id, keep = []) {
  const gone = archivedSet(store, kind), kept = new Set(keep.filter((k) => k != null && k !== '').map(String));
  return list.filter((x) => !gone.has(String(idOf(x))) || kept.has(String(idOf(x))));
}

/** Every string anywhere inside a value. */
function strings(v, out = new Set()) {
  if (typeof v === 'string') out.add(v.trim());
  else if (v && typeof v === 'object') for (const k in v) strings(v[k], out);
  return out;
}
/** The filters a formulation names: the filtration step of its process, and the older record's two menus. */
function filtersOf(plan) {
  const steps = Array.isArray(plan?.process?.downstream) ? plan.process.downstream : [];
  const f = plan?.downstream?.filtration || {};
  return [...steps.filter((s) => s.step === 'filtration' && s.device).map((s) => s.device), f.prefilter, f.sterile].filter((x) => x && x !== 'None');
}

/**
 * The records that name a component, as [{collection, id, label}], each once. Read from the store as it is, so a
 * deleted record (in the trash) does not count: restoring it would bring the reference back, and the trash entry
 * carries its own copy of the record anyway.
 *
 * `opts.rec` is the component itself where it is not in the store (a shipped device, a record in the trash): a
 * buffer lot is named by its lot name and aliases, a TFF module by its part number, a dialysis device by its
 * name, so those are read from it. `opts.compositions` is the list of recipes to look through for a lipid, the
 * shipped ones included (getRef().compositions); the store's own by default.
 */
export function whereUsed(store, kind, id, opts = {}) {
  const key = String(id), out = [], seen = new Set();
  const hit = (collection, rec, label) => {
    const k = `${collection}:${rec.id}`;
    if (seen.has(k)) return; seen.add(k);
    out.push({ collection, id: rec.id, label: label || String(rec.id) });
  };
  const col = KINDS[kind]?.collection;
  const self = opts.rec || (col ? store.get(col, id) || (kind === 'lipid' ? store.all('lipids').find((l) => l?.key === key) : null) : null);
  const batches = store.all('batches'), stocks = store.all('stocks');
  const plans = (fn) => { for (const b of batches) if (b && fn(b)) hit('batches', b); };
  if (kind === 'lipid') {
    for (const c of opts.compositions || store.all('compositions')) if (c?.mol_pct && key in c.mol_pct) hit('compositions', c, `#${c.id}`);
    for (const s of stocks) if ((s?.molPct && key in s.molPct) || (s?.lots && key in s.lots) || (s?.rows || []).some((r) => r?.key === key)) hit('stocks', s);
    for (const l of store.all('lipidLots')) if (l?.lipidKey === key) hit('lipidLots', l, `lot ${l.lot || l.id}`);
    plans((b) => { const o = b.plan?.compositionOverride; return o && key in (o.mol_pct || o); });
  } else if (kind === 'lipidLot') {
    // Stocks point at the lot record by its id (stocks.js), never by its number.
    for (const s of stocks) if ((s?.rows || []).some((r) => String(r?.lotId) === key) || Object.values(s?.lots || {}).map(String).includes(key)) hit('stocks', s);
  } else if (kind === 'composition') {
    for (const s of stocks) if (String(s?.compositionId) === key) hit('stocks', s);
    plans((b) => String(b.compositionId) === key);
    for (const e of store.all('experiments')) if (String(e?.compositionId ?? e?.spec?.compositionId) === key) hit('experiments', e);
  } else if (kind === 'rnaLot') {
    plans((b) => String(b.plan?.rna?.lotId ?? '') === key);
    for (const e of store.all('experiments')) if (String(e?.rnaLotId ?? e?.spec?.rnaLotId ?? '') === key) hit('experiments', e);
  } else if (kind === 'buffer') {
    // A batch names a lot by its lot name, its Buffer number or an alias; counted once however many it uses.
    const names = bufferNames(self || { id: key });
    plans((b) => namesAny(batchStrings(b), names));
  } else if (kind === 'device') {
    plans((b) => b.plan?.process && devicesUsed(b.plan).deviceId === key);
  } else if (kind === 'mixer') {
    plans((b) => b.plan?.process && devicesUsed(b.plan).mixerId === key);
  } else if (kind === 'tffModule') {
    const part = String(self?.part ?? key);
    plans((b) => devicesUsed(b.plan).tff.includes(part));
  } else if (kind === 'dialysis') {
    const name = String(self?.name ?? key);
    plans((b) => devicesUsed(b.plan).dialysis.includes(name));
  } else if (kind === 'filter') {
    plans((b) => filtersOf(b.plan).includes(key));
  } else if (kind === 'stock') {
    plans((b) => String(b.stockId ?? '') === key);
    for (const e of store.all('experiments')) if (String(e?.spec?.stockId ?? '') === key) hit('experiments', e);
  } else if (kind === 'batch') {
    for (const m of store.all('measurements')) if (String(m?.batchId ?? '') === key) hit('measurements', m, `measurement ${m.sampleName || m.id}`);
    for (const st of store.all('studies')) if (String(st?.referenceBatchId ?? '') === key || (st?.groups || []).some((g) => String(g?.batchId ?? '') === key)) hit('studies', st, `study ${st.id}`);
    for (const m of store.all('bioMeasurements')) if (String(m?.batchId ?? '') === key) hit('bioMeasurements', m, `a value of ${m.studyId || 'a study'}`);
  } else if (kind === 'experiment') {
    for (const st of store.all('studies')) if ((st?.experimentIds || []).map(String).includes(key)) hit('studies', st, `study ${st.id}`);
  } else if (kind === 'study') {
    for (const m of store.all('bioMeasurements')) if (String(m?.studyId ?? '') === key) hit('bioMeasurements', m, `a value of ${key}`);
  } else throw new Error(`whereUsed: no kind "${kind}"`);
  return out;
}

/** Every name a buffer lot answers to: its record id (Buffer-NNN), its lot name and its former names. */
const bufferNames = (lot) => new Set([lot?.id, lot?.lot, ...(lot?.aliases || [])].filter((x) => x != null && x !== '').map(String));
const batchStrings = (b) => strings(b?.actual, strings(b?.plan));
const namesAny = (set, names) => { for (const n of names) if (set.has(n)) return true; return false; };

/**
 * How many formulations name each buffer lot, for a list of lots: `count(lot)`. Each batch is read once, and a
 * batch that names a lot by both its lot name and its Buffer number counts once (it used to count twice).
 */
export function bufferUseCounter(store) {
  const sets = store.all('batches').filter(Boolean).map(batchStrings);
  return (lot) => { const names = bufferNames(lot); let n = 0; for (const s of sets) if (namesAny(s, names)) n++; return n; };
}

/** Each use once, by collection: {batches: ['E1-F1', …], stocks: […]}. What the dialogs put in their own words. */
export function usesBy(used) {
  const by = {};
  for (const u of used) (by[u.collection] ||= []).push(u.label);
  return by;
}

/**
 * What still names the records of a trash entry, from outside the entry: [{collection, id, label, of}]. An entry
 * with uses is kept past its days and through "Empty trash" (app/store.js), since erasing it would hard-delete a
 * record that something still points at. A record of a collection no kind covers names nothing anyone reads.
 */
export function trashEntryUses(store, entry) {
  const inside = new Set((entry?.records || []).map((r) => `${r?.col}:${r?.rec?.id}`));
  const out = [];
  for (const r of entry?.records || []) {
    const kind = kindOfCollection(r?.col);
    if (!kind || r.rec?.id == null) continue;
    const id = KINDS[kind].key ? r.rec[KINDS[kind].key] ?? r.rec.id : r.rec.id;
    for (const u of whereUsed(store, kind, id, { rec: r.rec })) if (!inside.has(`${u.collection}:${u.id}`)) out.push({ ...u, of: `${r.col}:${r.rec.id}` });
  }
  return out;
}

/**
 * What a study names of an experiment about to be deleted: its formulations as a study group, a reference or a
 * study value, or the experiment itself. Words for the question, e.g. ['study Study-001', '3 study values'].
 */
export function experimentBioUses(store, exp, batches = []) {
  const studies = new Set(), values = new Set();
  const take = (u) => { if (u.collection === 'studies') studies.add(u.id); else if (u.collection === 'bioMeasurements') values.add(u.id); };
  whereUsed(store, 'experiment', exp.id).forEach(take);
  for (const b of batches) whereUsed(store, 'batch', b.id).forEach(take);
  return [studies.size ? `${studies.size === 1 ? 'study' : 'studies'} ${[...studies].join(', ')}` : '', values.size ? `${values.size} study value${values.size === 1 ? '' : 's'}` : ''].filter(Boolean);
}

/** One sentence for the delete dialog: where it is used, and what will happen instead. */
export function usageSentence(kind, name, used) {
  const what = KINDS[kind]?.label || kind;
  if (!used.length) return `${name} is not used anywhere. Delete it? It goes to Recently deleted, where it can be restored.`;
  const shown = used.slice(0, 4).map((u) => u.label).join(', ') + (used.length > 4 ? ` and ${used.length - 4} more` : '');
  return `${name} is used by ${shown}, so it cannot be deleted: those records would lose it. Archive the ${what} instead? It is hidden from lists and pickers, the old records keep it, and it can be restored.`;
}
