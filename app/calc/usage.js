// Where a component is used, and whether it may be deleted or only archived (spec 9.5).
//
// One helper for every screen, instead of a check per screen: a lipid, a lipid lot, a composition, an RNA lot or
// a buffer lot is "used" when a record that has to stay readable names it. Such a component cannot be deleted
// (its old batches would point at nothing); it can be archived: hidden from lists and pickers, kept whole for the
// records that name it, and restorable. A component nothing names goes to the trash like any record, with Undo.
//
// Archiving is kept in its own small collection, `archive` ({id: 'lipid:DLin-MC3', kind, itemId, at}), rather
// than as a flag on each record: the shipped lipids and compositions are reference data, not records in the store,
// and an archive list covers them the same way as the lab's own.

export const ARCHIVE = 'archive';
export const KINDS = {
  lipid: { label: 'lipid', collection: 'lipids' },
  lipidLot: { label: 'lipid lot', collection: 'lipidLots' },
  composition: { label: 'composition', collection: 'compositions' },
  rnaLot: { label: 'RNA lot', collection: 'rnaLots' },
  buffer: { label: 'buffer lot', collection: 'buffers' },
  mixer: { label: 'mixer', collection: 'mixers' },
};

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

/**
 * The records that name a component, as [{collection, id, label}], each once. Read from the store as it is, so a
 * deleted record (in the trash) does not count: restoring it would bring the reference back, and the trash entry
 * carries its own copy of the record anyway.
 */
export function whereUsed(store, kind, id) {
  const key = String(id), out = [], seen = new Set();
  const hit = (collection, rec, label) => {
    const k = `${collection}:${rec.id}`;
    if (seen.has(k)) return; seen.add(k);
    out.push({ collection, id: rec.id, label: label || String(rec.id) });
  };
  const batches = store.all('batches'), stocks = store.all('stocks');
  if (kind === 'lipid') {
    for (const c of store.all('compositions')) if (c?.mol_pct && key in c.mol_pct) hit('compositions', c, `composition #${c.id}`);
    for (const s of stocks) if ((s?.molPct && key in s.molPct) || (s?.lots && key in s.lots)) hit('stocks', s);
    for (const l of store.all('lipidLots')) if (l?.lipidKey === key) hit('lipidLots', l, `lot ${l.lot || l.id}`);
    for (const b of batches) if (b?.plan?.compositionOverride && key in (b.plan.compositionOverride.mol_pct || b.plan.compositionOverride)) hit('batches', b);
  } else if (kind === 'lipidLot') {
    for (const s of stocks) if (s?.lots && Object.values(s.lots).map(String).includes(key)) hit('stocks', s);
  } else if (kind === 'composition') {
    for (const s of stocks) if (String(s?.compositionId) === key) hit('stocks', s);
    for (const b of batches) if (String(b?.compositionId) === key) hit('batches', b);
    for (const e of store.all('experiments')) if (String(e?.compositionId) === key) hit('experiments', e);
  } else if (kind === 'rnaLot') {
    for (const b of batches) if (String(b?.plan?.rna?.lotId ?? '') === key) hit('batches', b);
    for (const e of store.all('experiments')) if (String(e?.rnaLotId ?? '') === key) hit('experiments', e);
  } else if (kind === 'buffer') {
    const buf = store.get('buffers', id);
    const names = new Set([key, buf?.lot, ...(buf?.aliases || [])].filter(Boolean).map(String));
    const names1 = (v) => { if (typeof v === 'string') return names.has(v); if (v && typeof v === 'object') for (const k in v) if (names1(v[k])) return true; return false; };
    for (const b of batches) if (names1(b?.plan) || names1(b?.actual)) hit('batches', b);
  } else if (kind === 'mixer') {
    const m = store.get('mixers', id), name = String(m?.name ?? key);
    for (const b of batches) if (String(b?.plan?.process?.mixer ?? '') === name) hit('batches', b);
  } else throw new Error(`whereUsed: no kind "${kind}"`);
  return out;
}

/** One sentence for the delete dialog: where it is used, and what will happen instead. */
export function usageSentence(kind, name, used) {
  const what = KINDS[kind]?.label || kind;
  if (!used.length) return `${name} is not used anywhere. Delete it? It goes to Recently deleted, where it can be restored.`;
  const shown = used.slice(0, 4).map((u) => u.label).join(', ') + (used.length > 4 ? ` and ${used.length - 4} more` : '');
  return `${name} is used by ${shown}, so it cannot be deleted: those records would lose it. Archive the ${what} instead? It is hidden from lists and pickers, the old records keep it, and it can be restored.`;
}
