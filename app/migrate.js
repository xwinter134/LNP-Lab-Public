// Bring a store written by an earlier version up to the current naming scheme.
//
// Ids used to be a global sequence with a configurable prefix: experiments S-001, formulations and lipid
// stocks sharing one LNP_nn counter. They are now E1 for an experiment, E1-F2 for the second formulation
// inside it, and Stock-001 for a lipid stock. The new names say which experiment a record belongs to, which
// the old ones did not — but a rename is only safe if every reference to the old name moves with it, and
// those references are scattered: a measurement points at a formulation, an expected-measurement slot
// carries the formulation in its own id and in the sample name the importer matches, a design run remembers
// which formulation it became, a calendar event links by hash.
//
// So this runs once per store, builds the whole rename map first, and then rewrites every field that holds
// an id. Anything it does not recognise is left exactly as it is: an id that came from somewhere else is
// better left strange than renamed into a collision.
import { experimentId, formulationId, stockId } from './schema.js';

export const SCHEMA_VERSION = 3;

/** Does this store still use the old names? */
function needsRename(store) {
  return store.all('experiments').some((e) => /^S-\d+$/.test(String(e.id)))
    || store.all('stocks').some((s) => !/^Stock-\d+$/.test(String(s.id)));
}

/**
 * Rename experiments, formulations and lipid stocks in place.
 * @returns {{experiments:object, batches:object, stocks:object}} the maps that were applied
 */
export function renameToNumberedScheme(store) {
  const experiments = store.all('experiments');
  const batches = store.all('batches');
  const stocks = store.all('stocks');

  // Experiments keep the order they were created in, so S-001 becomes E1 rather than E7.
  const expMap = {};
  let expNo = 0;
  for (const e of experiments) {
    const id = String(e.id);
    if (/^E\d+$/.test(id)) { expNo = Math.max(expNo, Number(id.slice(1))); continue; }
    expMap[id] = experimentId(++expNo);
  }
  // A number already taken by an untouched experiment must not be handed out twice.
  const usedExp = new Set(experiments.map((e) => expMap[String(e.id)] || String(e.id)));
  if (usedExp.size !== experiments.length) {
    for (const [oldId, newId] of Object.entries(expMap)) {
      let candidate = newId;
      while (experiments.some((e) => String(e.id) === candidate && String(e.id) !== oldId)) candidate = experimentId(++expNo);
      expMap[oldId] = candidate;
    }
  }

  // Formulations are numbered inside their experiment, in the order the experiment lists them.
  const batchMap = {};
  const byExperiment = new Map();
  for (const b of batches) {
    const key = String(b.experimentId ?? '');
    if (!byExperiment.has(key)) byExperiment.set(key, []);
    byExperiment.get(key).push(b);
  }
  for (const [oldExpId, group] of byExperiment) {
    const exp = experiments.find((e) => String(e.id) === oldExpId);
    if (!exp) continue; // an orphan formulation has no experiment to number it inside; leave it alone
    const newExpId = expMap[oldExpId] || oldExpId;
    const order = (exp.batchIds || []).map(String);
    group.sort((a, b) => {
      const ia = order.indexOf(String(a.id)), ib = order.indexOf(String(b.id));
      return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
    });
    group.forEach((b, i) => { batchMap[String(b.id)] = formulationId(newExpId, i + 1); });
  }

  // Lipid stocks are a plain series of their own, oldest first.
  const stockMap = {};
  let stockNo = 0;
  for (const s of stocks) {
    const id = String(s.id);
    const m = /^Stock-(\d+)$/.exec(id);
    if (m) { stockNo = Math.max(stockNo, Number(m[1])); continue; }
    stockMap[id] = stockId(++stockNo);
  }

  const reExp = (id) => expMap[String(id)] ?? id;
  const reBatch = (id) => batchMap[String(id)] ?? id;
  const reStock = (id) => stockMap[String(id)] ?? id;
  // Slot ids and sample names embed exactly one formulation id. Replace the longest match first, so E1-F1
  // cannot claim a string that belongs to E1-F10, and stop after it: a second pass over already-renamed text
  // could match a new id inside it.
  const batchKeys = Object.keys(batchMap).sort((a, b) => b.length - a.length);
  const reText = (text) => {
    if (!text) return text;
    let out = String(text);
    for (const k of batchKeys) if (out.includes(k)) { out = out.split(k).join(batchMap[k]); break; }
    return out;
  };

  for (const e of experiments) {
    const next = { ...e, id: reExp(e.id), batchIds: (e.batchIds || []).map(reBatch) };
    next.expected = (e.expected || []).map((s) => ({ ...s, id: reText(s.id), batchId: reBatch(s.batchId), sampleName: reText(s.sampleName) }));
    if (e.design?.doe?.runs) {
      next.design = { ...e.design, doe: { ...e.design.doe, runs: e.design.doe.runs.map((r) => ({ ...r, batchId: reBatch(r.batchId) })) } };
    }
    if (e.spec?.stockId) next.spec = { ...e.spec, stockId: reStock(e.spec.stockId) };
    if (String(e.id) !== next.id) store.remove('experiments', e.id);
    store.put('experiments', next);
  }
  for (const b of batches) {
    const next = { ...b, id: reBatch(b.id), experimentId: reExp(b.experimentId), stockId: b.stockId ? reStock(b.stockId) : b.stockId };
    if (String(b.id) !== next.id) store.remove('batches', b.id);
    store.put('batches', next);
  }
  for (const s of stocks) {
    const next = { ...s, id: reStock(s.id) };
    if (String(s.id) !== next.id) store.remove('stocks', s.id);
    store.put('stocks', next);
  }
  for (const m of store.all('measurements')) {
    const next = { ...m, batchId: reBatch(m.batchId), experimentId: reExp(m.experimentId), slotId: reText(m.slotId), sampleName: reText(m.sampleName) };
    store.put('measurements', next);
  }
  // Only the link, never the title: a manual calendar entry's title is the user's own words, and an id that
  // happens to appear in it is a sentence they wrote rather than a reference the app has to keep working.
  for (const ev of store.all('events')) {
    if (!ev.link) continue;
    let link = String(ev.link);
    for (const [oldId, newId] of Object.entries(expMap)) link = link.split(oldId).join(newId);
    link = reText(link);
    if (link !== ev.link) store.put('events', { ...ev, link });
  }

  return { experiments: expMap, batches: batchMap, stocks: stockMap };
}

/*
 * Schema 3 (spec 4.4): provenance on every formulation, measurement and composition, and room for the new process
 * variables on each formulation (plan.conditions, app/calc/variables.js).
 *
 * What it writes is only what is known: `provenance.source` is 'manual' on records that were typed in, and
 * 'instrument-import' with the file name and hash on a measurement that carries them in `raw`. The new process
 * variables are left empty (an empty plan.conditions), because a buffer's pH or a mixer that was never recorded
 * is not something to fill in for the user. The ionizable lipid and "PEG-free" need no field at all: they are
 * read from the composition whenever they are needed.
 *
 * Idempotent: a record that already has a provenance, or a plan.conditions, is left exactly as it is, so running
 * it twice changes nothing the second time.
 */
export function addProvenanceAndProcess(store) {
  const counts = { batches: 0, measurements: 0, compositions: 0 };
  // Whole collections through replace(), in their order, rather than put() record by record: put() stamps
  // updatedAt, and a migration is not an edit. Every formulation would otherwise read as changed on the day of
  // the update, which the "last changed" lists and the backup reminder would then report.
  const each = (col, fix) => {
    const rows = store.all(col);
    let changed = false;
    const next = rows.map((r) => { const n = r && typeof r === 'object' ? fix(r) : r; if (n !== r) { changed = true; counts[col]++; } return n; });
    if (changed) store.replace(col, next);
  };
  each('batches', (b) => {
    let next = b;
    if (!b.provenance) next = { ...next, provenance: { source: 'manual' } };
    if (b.plan && typeof b.plan === 'object' && !b.plan.conditions) next = { ...next, plan: { ...next.plan, conditions: {} } };
    return next;
  });
  each('measurements', (m) => (m.provenance ? m : { ...m, provenance: m.raw?.sha256 ? { source: 'instrument-import', file: { name: m.raw.fileName || null, sha256: m.raw.sha256 } } : { source: 'manual' } }));
  each('compositions', (c) => (c.provenance ? c : { ...c, provenance: { source: 'manual' } }));
  return counts;
}

// The collections a pre-migration backup holds: every one a backup file would, read from the store itself.
const BACKUP_SKIP = new Set(['trash', 'preMigration']);

/**
 * A copy of every collection, kept in the store before a migration writes (spec 4.4): {id: 'v2-<time>', from,
 * to, at, data: {collection: rows}}. In the store rather than a download because the migration runs at start-up
 * without asking, and a dialog then would be in the way. Settings › Before updates lists them (app/ui/
 * premigration.js): Download hands one out as a backup file, and Restore puts it back with restorePreMigration()
 * below. Only the most recent two are kept, so a lab that updates often does not carry every one. Not part of a
 * backup file (Store.exportAll leaves `preMigration` out): it would carry the same records twice.
 */
export function backupBeforeMigration(store, from, to, now = new Date(), collections = null) {
  const cols = collections || (typeof store.exportAll === 'function' ? Object.keys(store.exportAll().collections) : []);
  const data = {};
  for (const c of cols) if (!BACKUP_SKIP.has(c)) data[c] = store.all(c);
  const rec = { id: `v${from}-${now.toISOString()}`, from, to, at: now.toISOString(), data };
  const kept = store.all('preMigration').sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 1);
  store.replace('preMigration', [...kept, rec]);
  return rec;
}

/** A pre-migration copy as a backup file, the same shape as Settings' "Export everything" writes. */
export function preMigrationFile(rec, ns = '') {
  return { exportedAt: new Date().toISOString(), ns, preMigration: { id: rec.id, from: rec.from, to: rec.to, at: rec.at }, collections: rec.data || {} };
}

/**
 * Put a pre-migration copy back (spec 4.4): every collection it holds replaces the one in the store, through
 * Store.importAll with merge off, exactly as a backup file restored with "replace" would. Lists the copy does not
 * hold (the trash, the copies themselves, a list that came with a later version) stay as they are.
 *
 * The copy holds the records as an earlier version wrote them, so the recorded schema version goes back to the
 * copy's `from` and the migration runs on them again at once: this version reads only records it understands,
 * and the lab is as it was just after that update, with what was entered since replaced. Whoever wants the
 * records exactly as the earlier version left them downloads the copy instead (preMigrationFile).
 * Returns {ok, restored: importAll's count, migrated} or {ok: false, reason}.
 */
export function restorePreMigration(store, id) {
  const rec = store.get('preMigration', id);
  if (!rec?.data || typeof rec.data !== 'object') return { ok: false, reason: 'that copy is no longer kept' };
  const restored = store.importAll({ collections: rec.data }, { merge: false });
  try { localStorage.setItem(`${store.ns}.schemaVersion`, String(rec.from || 1)); } catch {}
  // No second copy: the one restored from is still in the list, and it holds these very records.
  const migrated = migrate(store, { backup: false });
  return { ok: true, restored, migrated };
}

/**
 * Run whatever this store still needs. Safe to call on every load: it checks before it writes, and a store
 * already at the current version is untouched.
 *
 * Each step is one transaction, and the version is recorded only once its records are stored. The store writes
 * in the background: a migration that cannot be stored is undone, and recording the version regardless would
 * leave the old records in place for good, with nothing ever trying again. Before anything is changed, a copy of
 * every collection is kept in the same transaction (backupBeforeMigration).
 */
export function migrate(store, { backup = true } = {}) {
  const key = `${store.ns}.schemaVersion`;
  let at = 0;
  try { at = Number(localStorage.getItem(key)) || 0; } catch {}
  if (at >= SCHEMA_VERSION) return null;
  const done = () => { try { localStorage.setItem(key, String(SCHEMA_VERSION)); } catch {} };
  const empty = !store.all('batches').length && !store.all('measurements').length && !store.all('compositions').length && !store.all('experiments').length;
  if (empty) { done(); return null; }
  return store.transaction(() => {
    if (backup) backupBeforeMigration(store, at || 1, SCHEMA_VERSION);
    const renamed = needsRename(store) ? renameToNumberedScheme(store) : null;
    const added = addProvenanceAndProcess(store);
    return { renamed, added };
  }, { what: 'the update of older records', onSaved: done });
}
