// Where a record came from (spec 4.3).
//
// Every formulation, measurement and composition can carry `provenance`:
//   {source: 'manual' | 'instrument-import' | 'mcp-import' | 'restore', file?: {name, sha256}, sheet?, row?,
//    importId?, importedAt?, importedBy?}
// It is optional on read: a record without it is treated as typed in by hand, which is what the migration to
// schema 3 writes on every older record (app/migrate.js), since that is what they were. Nothing is guessed: an
// older measurement that names its instrument file in `raw` is the one exception, because the file name and its
// hash are written on it.

export const SOURCES = { manual: 'Typed in', 'instrument-import': 'Instrument file', 'mcp-import': 'Imported with Claude', restore: 'Restored from a backup' };

/** A provenance record, with only the fields that have a value. */
export function provenance(source, extra = {}) {
  if (!SOURCES[source]) throw new Error(`provenance: unknown source "${source}"`);
  const out = { source };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

/** The provenance a record already has, or the one it is read as. */
export function provenanceOf(rec) {
  if (rec?.provenance?.source) return rec.provenance;
  if (rec?.raw?.sha256) return provenance('instrument-import', { file: { name: rec.raw.fileName, sha256: rec.raw.sha256 } });
  return { source: 'manual' };
}

/** One line for the detail views: "Instrument file zetasizer.csv (SHA-256 1a2b3c4d…), imported 28 Oct 2026". */
export function provenanceLine(rec) {
  const p = provenanceOf(rec);
  const bits = [SOURCES[p.source]];
  if (p.file?.name) bits.push(p.file.name + (p.file.sha256 ? ` (SHA-256 ${p.file.sha256.slice(0, 8)}…)` : ''));
  if (p.sheet) bits.push(`sheet ${p.sheet}${p.row != null ? `, row ${p.row}` : ''}`);
  if (p.importId) bits.push(`import ${p.importId}`);
  if (p.importedAt) bits.push(`on ${String(p.importedAt).slice(0, 10)}`);
  if (p.importedBy) bits.push(`by ${p.importedBy}`);
  return bits.join(' · ');
}
