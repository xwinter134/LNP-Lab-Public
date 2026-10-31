// What an import does to a lab, on top of the check in ./importcheck.js: plan it against the lab's own records,
// write it as one transaction, list the imports, take one out again whole, and check a quarantined row again.
//
// Shared by the MCP server (mcp/tools.js, on the macOS app's SQLite file) and the app (Settings › Imports, the
// Quarantine screen), so an import made with Claude and one restored from a file are listed, undone and fixed
// the same way. `lab` is anything with all(col) (the Store, or a read-only view of the database file); a write
// needs the Store itself (transaction, replace, moveToTrash).
//
// An import is recognised by its id alone: every record it wrote carries provenance.importId, and the `imports`
// collection holds one record per import (kind 'historical' from scripts/import-tidy.mjs, 'mcp' from the MCP
// server) with the files it read and what it wrote. Whether its records are in the lab or in the trash is read off
// the records each time, never stored, so a restore from the trash needs no bookkeeping.
import { checkTidy, labIndex, quarantineRecords, qualityReport, groupReasons, importCompleteness } from './importcheck.js';
import { usedIds, raiseCounter } from '../schema.js';
import { dataRows, completeness } from './facets.js';

/** The collections an import writes records into, in the order a rollback lists them. */
export const IMPORT_COLLECTIONS = ['experiments', 'batches', 'measurements', 'compositions', 'quarantine'];

const highestE = (ids) => Math.max(0, ...ids.map((id) => Number(/^E(\d+)$/.exec(String(id))?.[1] || 0)));

/**
 * The reference the check needs, from the lab and the shipped data (`data` = {lipids, compositions}, as
 * app/data/*.json): the lab's lipids over the shipped ones by key (as app/refdata.js getRef), every composition,
 * the numbers in use, and the lab's index of earlier imports.
 */
export function importRef(lab, data = {}) {
  const lipids = [...(data.lipids || [])];
  for (const l of lab.all('lipids')) { const i = lipids.findIndex((x) => x.key === l.key); if (i >= 0) lipids[i] = { ...lipids[i], ...l }; else lipids.push(l); }
  const shipped = data.compositions || [];
  const compositions = [...shipped, ...lab.all('compositions').filter((c) => !shipped.some((x) => x.id === c.id))];
  return {
    lipids, compositions, mixers: lab.all('mixers'),
    topExperiment: highestE(usedIds(lab, 'experiment')),
    takenFormulations: usedIds(lab, 'formulation'),
    lab: labIndex(lab),
    lipidByKey: Object.fromEntries(lipids.map((l) => [l.key, l])),
    compositionById: Object.fromEntries(compositions.map((c) => [c.id, c])),
  };
}

/**
 * How many measurement ids `<importId>-m<n>` are taken, in the lab or its trash: a row fixed from quarantine
 * joins its import, and must not take a number a result of the same import already has.
 */
export function measurementsTaken(lab, importId) {
  const re = new RegExp(`^${String(importId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-m(\\d+)$`);
  let n = 0;
  const see = (id) => { const m = re.exec(String(id)); if (m) n = Math.max(n, Number(m[1])); };
  for (const m of lab.all('measurements')) see(m?.id);
  for (const t of lab.all('trash')) for (const r of t?.records || []) if (r?.col === 'measurements') see(r.rec?.id);
  return n;
}

/** Check tables against the lab: the records they become, and the quality report (spec 6.4). Writes nothing. */
export function planImport(lab, data, tables, opts = {}) {
  const ref = importRef(lab, data);
  const result = checkTidy(tables, ref, { dedupe: true, attachMeasurements: true, ...opts });
  return { result, report: qualityReport(result, ref) };
}

const stamp = (rows, now) => rows.map((r) => ({ ...r, createdAt: r.createdAt || now, updatedAt: now }));

/**
 * Write a planned import into the store as one transaction: the new records, the formulations an experiment of
 * the same import gained, the quarantine, the import's own record, and the experiment counter. Older open
 * quarantine entries of the same source rows give way to this import's outcome (status 'superseded'), so a file
 * imported again after fixing it does not leave its old refusals behind.
 *
 * `meta` = {kind: 'mcp' | 'historical', source, files: [{name, sha256}], fixedFrom?}; `fixedFrom` (a quarantine
 * id) adds the records to the import they came from instead of recording a new one.
 * Returns {ok, importId, written: {collection: n}}; ok false with `reason` when the store refuses the write.
 */
export function applyImport(store, result, meta = {}) {
  const now = new Date().toISOString();
  const quarantine = meta.fixedFrom ? [] : quarantineRecords(result, { at: now });
  const keys = new Set([...result.quarantine.map((q) => q.originKey), ...[...result.batches, ...result.measurements, ...result.experiments].map((r) => r.provenance?.originKey)].filter(Boolean));
  let done = null;
  store.transaction(() => {
    const add = (col, rows) => {
      if (!rows.length) return;
      const have = store.all(col);
      // Never two records under one id: the check numbers past every id in use, and this says so if it did not.
      const ids = new Set(have.map((r) => String(r?.id)));
      const clash = rows.find((r) => ids.has(String(r.id)));
      if (clash) throw new Error(`${col} ${clash.id} is in the lab already; nothing was written`);
      store.replace(col, [...have, ...stamp(rows, now)]);
    };
    add('experiments', result.experiments);
    if (result.experimentUpdates.length) {
      const up = new Map(result.experimentUpdates.map((u) => [u.id, u.batchIds]));
      store.replace('experiments', store.all('experiments').map((e) => (up.has(e.id) ? { ...e, batchIds: up.get(e.id), updatedAt: now } : e)));
    }
    add('batches', result.batches);
    add('measurements', result.measurements);
    add('compositions', result.compositions);
    add('mixers', result.mixers);
    // Older open entries of the same source rows: this import has decided them, one way or the other.
    const q = store.all('quarantine').map((e) => (e.status === 'open' && keys.has(e.originKey) && e.id !== meta.fixedFrom ? { ...e, status: 'superseded', supersededBy: result.importId, updatedAt: now } : e));
    store.replace('quarantine', [...q, ...quarantine]);
    const ids = {
      experimentIds: result.experiments.map((e) => e.id), batchIds: result.batches.map((b) => b.id), measurementIds: result.measurements.map((m) => m.id),
      compositionIds: result.compositions.map((c) => c.id), quarantineIds: quarantine.map((x) => x.id),
    };
    const imp = store.get('imports', result.importId);
    if (imp) {
      const merged = Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, [...(imp[k] || []), ...v]]));
      store.put('imports', { ...imp, ...merged, imported: (imp.imported || 0) + result.batches.length + result.measurements.length });
    } else {
      const files = meta.files || [];
      store.put('imports', { id: result.importId, kind: meta.kind || 'mcp', source: meta.source || 'mcp-import', fileName: files.map((f) => f.name).join(', '), sha256: files[0]?.sha256 || null, files,
        importedAt: result.importedAt, imported: result.batches.length + result.measurements.length, ...ids, duplicates: result.duplicates.length });
    }
    const last = result.experiments[result.experiments.length - 1];
    if (last) raiseCounter(store, 'experiment', last.id);
    done = { experiments: result.experiments.length, batches: result.batches.length, measurements: result.measurements.length, compositions: result.compositions.length, mixers: result.mixers.length, quarantine: quarantine.length };
  }, { what: `the import ${result.importId}` });
  if (store.readOnly) return { ok: false, importId: result.importId, reason: 'LNP Lab is open in another window, and this one only shows your records' };
  return { ok: true, importId: result.importId, written: done };
}

const ofImport = (r, id) => r?.provenance?.importId === id;

/**
 * Every record an import wrote that is still in the lab, as [[collection, id]], and the records of other origin
 * that hang on them (a result typed in later for an imported formulation, a formulation added to an imported
 * experiment). Those go with them on a rollback, in the same trash entry, so nothing is left pointing at a record
 * in the trash; `others` says how many, so the person is told. A composition the import made is left in the lab
 * when a formulation of other origin uses it.
 */
export function importRecords(lab, importId) {
  const exps = lab.all('experiments').filter((e) => ofImport(e, importId));
  const expIds = new Set(exps.map((e) => e.id));
  const batches = lab.all('batches').filter((b) => ofImport(b, importId) || expIds.has(b.experimentId));
  const batchIds = new Set(batches.map((b) => b.id));
  const ms = lab.all('measurements').filter((m) => ofImport(m, importId) || batchIds.has(m.batchId));
  const comps = lab.all('compositions').filter((c) => ofImport(c, importId))
    .filter((c) => !lab.all('batches').some((b) => b.compositionId === c.id && !batchIds.has(b.id)));
  const q = lab.all('quarantine').filter((e) => e.importId === importId);
  const refs = [...exps.map((r) => ['experiments', r.id]), ...batches.map((r) => ['batches', r.id]), ...ms.map((r) => ['measurements', r.id]), ...comps.map((r) => ['compositions', r.id]), ...q.map((r) => ['quarantine', r.id])];
  const others = [...batches, ...ms].filter((r) => !ofImport(r, importId)).length;
  return { refs, others, counts: { experiments: exps.length, batches: batches.length, measurements: ms.length, compositions: comps.length, quarantine: q.length } };
}

/**
 * Take an import out of the lab whole: every record of it into the trash as one entry ("import imp-…"), from where
 * Settings › Recently deleted puts it all back (spec 6.5). Returns {ok, entry, counts, others} or {ok: false, reason}.
 */
export function rollbackImport(store, importId) {
  const imp = store.get('imports', importId);
  const { refs, others, counts } = importRecords(store, importId);
  if (!refs.length) return { ok: false, reason: imp ? `nothing of ${importId} is in the lab any more (it may be in the trash already)` : `there is no import ${importId}` };
  const entry = store.moveToTrash(refs, { kind: 'import', label: `import ${importId}${imp?.fileName ? ` (${imp.fileName})` : ''}` });
  if (!entry) return { ok: false, reason: 'the lab could not be changed from this window' };
  return { ok: true, entry, counts, others };
}

/** Where an import's records are now: in the lab, in the trash (with the entry to restore), or both. */
export function importState(lab, importId) {
  const live = importRecords(lab, importId).counts;
  const nLive = live.experiments + live.batches + live.measurements;
  const trash = lab.all('trash').filter((t) => t?.kind === 'import' && (t.records || []).some((r) => r.rec?.provenance?.importId === importId || r.rec?.importId === importId));
  return { live, inLab: nLive > 0, trash: trash.map((t) => ({ id: t.id, deletedAt: t.deletedAt, records: t.records.length })) };
}

/**
 * The imports of tables (by the script or the MCP server), newest first, each with what is in the lab now and
 * how many of its rows still wait in quarantine. Instrument-file imports (the Measurements screen's) are not
 * listed: they have their own history there.
 */
export function listImports(lab) {
  const q = lab.all('quarantine');
  return lab.all('imports').filter((i) => i && (i.kind === 'mcp' || i.kind === 'historical'))
    .map((i) => ({ ...i, state: importState(lab, i.id), quarantineOpen: q.filter((e) => e.importId === i.id && e.status === 'open').length }))
    .sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
}

/**
 * The quality of one import, or of the whole lab when `importId` is null (quality_report): counts, the
 * completeness matrix of its formulations as the Data overview shows it, the open quarantine grouped by reason,
 * and the results that sit outside the sense limits are already kept out by the check, so not repeated here.
 */
export function labQuality(lab, data, importId = null) {
  const ref = importRef(lab, data);
  const pick = (col) => lab.all(col).filter((r) => !importId || ofImport(r, importId));
  const batches = pick('batches');
  const rows = dataRows({ batches, experiments: lab.all('experiments'), measurements: lab.all('measurements') }, ref);
  const open = lab.all('quarantine').filter((e) => e.status === 'open' && (!importId || e.importId === importId));
  return {
    scope: importId || 'the whole lab',
    counts: { experiments: pick('experiments').length, formulations: batches.length, measurements: pick('measurements').length, quarantineOpen: open.length },
    completeness: completeness(rows).map((c) => ({ key: c.key, label: c.label, n: c.n, share: Math.round(c.share * 100), level: c.level })),
    quarantine: groupReasons(open.map((e) => ({ file: e.file || e.table, reason: e.reason || '' }))),
    sources: Object.entries(rows.reduce((m, r) => { m[r.source] = (m[r.source] || 0) + 1; return m; }, {})).map(([source, n]) => ({ source, n })),
  };
}

/**
 * Check a quarantined row again, with the values the person filled in (`mapping`, the row's columns), through
 * the same check as every import. When it passes, its records join the import it came from, under that import's
 * id (a formulation joins its experiment when the experiment came with the same import), and the entry is closed;
 * when it does not, the entry keeps the new values and the new reason. Returns {ok, reason?, written?}.
 */
export function recheckQuarantine(store, data, qid, mapping) {
  const entry = store.get('quarantine', qid);
  if (!entry) return { ok: false, reason: 'it is no longer in quarantine' };
  if (entry.status !== 'open') return { ok: false, reason: `it was ${entry.status} already` };
  const imp = store.get('imports', entry.importId);
  const row = { ...mapping, __row: entry.row, ...(entry.origin ? { __origin: entry.origin } : {}) };
  const tables = { [entry.table]: { name: entry.file, rows: [row] } };
  const ref = { ...importRef(store, data), measurementStart: measurementsTaken(store, entry.importId) };
  const result = checkTidy(tables, ref, {
    importId: entry.importId, importedAt: new Date().toISOString(), source: imp?.source || (imp?.kind === 'mcp' ? 'mcp-import' : 'restore'),
    attachTo: (exp) => exp.provenance?.importId === entry.importId, attachMeasurements: true, dedupe: true,
  });
  const now = new Date().toISOString();
  if (result.duplicates.length) {
    store.put('quarantine', { ...entry, mapping, status: 'superseded', reason: result.duplicates[0].reason, updatedAt: now });
    return { ok: false, superseded: true, reason: result.duplicates[0].reason };
  }
  if (result.quarantine.length) {
    store.put('quarantine', { ...entry, mapping, reason: result.quarantine[0].reason, checkedAt: now });
    return { ok: false, reason: result.quarantine[0].reason };
  }
  // The records keep the original row's origin; the provenance says they were fixed by hand from quarantine.
  for (const col of ['experiments', 'batches', 'measurements', 'compositions']) for (const r of result[col]) r.provenance = { ...r.provenance, fixedFrom: qid };
  // The origin key goes with the entry's own, so the same row imported again later is recognised.
  const written = applyImport(store, result, { fixedFrom: qid });
  if (!written.ok) return written;
  const ids = [...result.experiments, ...result.batches, ...result.measurements].map((r) => r.id);
  store.put('quarantine', { ...store.get('quarantine', qid), mapping, status: 'fixed', reason: '', fixedAt: now, recordIds: ids });
  return { ok: true, written: written.written, ids };
}

/** The open quarantine, newest first. */
export const openQuarantine = (lab) => lab.all('quarantine').filter((e) => e?.status === 'open').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

export { importCompleteness };
