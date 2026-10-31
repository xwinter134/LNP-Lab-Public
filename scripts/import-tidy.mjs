#!/usr/bin/env node
// Historical data into LNP Lab: tidy CSV tables in, a restore file and a quality report out (docs/HISTORICAL-DATA.md).
//
//   node scripts/import-tidy.mjs <folder> [--db path/to/lnp-lab.db] [--first 100] [--out <folder>]
//
// <folder> holds experiments.csv, formulations.csv and measurements.csv (see the guide for the columns). The
// script checks every row with the app's own rules and writes:
//   import.json        a backup-format file: Settings › Restore, "merge", adds it to the lab
//   quality-report.md  counts, what was refused and why, completeness per column
//   quarantine.csv     every refused row with its reason, to be fixed and run again
// Nothing is written to any database. Each record carries provenance (source 'mcp-import' is reserved for the
// MCP server; this is 'restore' with the file, sheet and row it came from), and the whole import shares one
// importId, so it can be found and taken out again as one (Settings › Imports › Undo import).
//
// The point of the split (spec 6.1): whoever prepares the tables, a person or Claude in a separate session, does
// the fuzzy part (which column is which, units, names); this script does the strict part, and what does not pass
// it does not go in. The strict part itself lives in app/calc/importcheck.js, shared with the MCP server
// (mcp/tools.js) and the app's Quarantine screen, so the three never accept different things. This file only
// reads the folder and the database and writes the three files.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parseCsv, checkTidy, qualityReport, reportMarkdown, quarantineRecords, labIndex } from '../app/calc/importcheck.js';

export { parseCsv };

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const dir = args.find((a, i) => !a.startsWith('--') && !['--db', '--first', '--out'].includes(args[i - 1]));
if (!dir) { console.error('usage: node scripts/import-tidy.mjs <folder> [--db lnp-lab.db] [--first 100] [--out folder]'); process.exit(2); }
const out = opt('--out', dir);
const read = (f) => { const p = join(dir, f); if (!existsSync(p)) return null; const t = readFileSync(p, 'utf8'); return { rows: parseCsv(t), sha256: createHash('sha256').update(t).digest('hex'), name: f }; };

// ---- reference data: the shipped lipids and compositions, plus the lab's own when --db is given
const lipids = JSON.parse(readFileSync(new URL('../app/data/lipids.json', import.meta.url)));
let compositions = JSON.parse(readFileSync(new URL('../app/data/compositions.json', import.meta.url)));
let topExperiment = Number(opt('--first', 0)) - 1;
let lab, mixers = [];
const dbPath = opt('--db');
if (dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const col = (k) => { const r = db.prepare('SELECT json FROM collections WHERE key = ?').get(`lnp-lab.${k}`); return r?.json ? JSON.parse(r.json) : []; };
  for (const l of col('lipids')) if (!lipids.some((x) => x.key === l.key)) lipids.push(l);
  compositions = [...compositions, ...col('compositions').filter((c) => !compositions.some((x) => x.id === c.id))];
  const used = [...col('experiments'), ...col('counters').filter((c) => c.id === 'experiment').map((c) => ({ id: `E${c.top}` }))]
    .map((e) => Number(/^E(\d+)$/.exec(String(e.id))?.[1] || 0));
  topExperiment = Math.max(topExperiment, ...used);
  // An experiment imported before (recognised by its exp_key in its notes) is not imported again.
  lab = labIndex({ all: col });
  mixers = col('mixers');
}
if (topExperiment < 0) topExperiment = 99; // without --db or --first: start at E100, far from a new lab's numbers

const exF = read('experiments.csv'), foF = read('formulations.csv'), meF = read('measurements.csv');
if (!foF) { console.error(`${dir}/formulations.csv is missing; it is the one table that is required`); process.exit(2); }

const importedAt = new Date().toISOString();
const importId = `imp-${importedAt.slice(0, 10)}-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 6)}`;
const result = checkTidy({ experiments: exF, formulations: foF, measurements: meF }, { lipids, compositions, topExperiment, lab, mixers }, { importId, importedAt, source: 'restore' });

// ---- outputs
mkdirSync(out, { recursive: true });
const quarantine = quarantineRecords(result);
const files = [exF, foF, meF].filter(Boolean);
const collections = { experiments: result.experiments, batches: result.batches, measurements: result.measurements, compositions: result.compositions, mixers: result.mixers, quarantine,
  imports: [{ id: importId, fileName: files.map((f) => f.name).join(', '), sha256: foF.sha256, importedAt, kind: 'historical', source: 'restore', imported: result.batches.length + result.measurements.length,
    files: files.map((f) => ({ name: f.name, sha256: f.sha256 })), measurementIds: result.measurements.map((m) => m.id), batchIds: result.batches.map((b) => b.id),
    experimentIds: result.experiments.map((e) => e.id), compositionIds: result.compositions.map((c) => c.id), quarantineIds: quarantine.map((q) => q.id) }] };
writeFileSync(join(out, 'import.json'), JSON.stringify({ exportedAt: importedAt, ns: 'lnp-lab', importId, collections }, null, 1));
const csvCell = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
writeFileSync(join(out, 'quarantine.csv'), ['file,row,reason,raw', ...result.quarantine.map((q) => [q.file, q.row, q.reason, JSON.stringify(q.raw)].map(csvCell).join(','))].join('\n'));

const compositionById = Object.fromEntries(compositions.map((c) => [c.id, c]));
const lipidByKey = Object.fromEntries(lipids.map((l) => [l.key, l]));
const rep = qualityReport(result, { compositionById, lipidByKey });
const report = reportMarkdown(rep, {
  from: `${importedAt.slice(0, 16).replace('T', ' ')} · from ${basename(dir)}${dbPath ? ` · numbered after the lab in ${basename(dbPath)}` : ''}`,
  next: `Read this report. Then in LNP Lab, Settings & export › Import JSON, choose import.json, with "replace" left unticked. Every record carries
importId ${importId} in its provenance. The refused rows come along into the app's Quarantine, where they can be fixed and checked again;
quarantine.csv lists them too, to fix in the tables and run again: the import is built new each time, so nothing lands twice.`,
});
writeFileSync(join(out, 'quality-report.md'), report);
console.log(report.split('## Completeness')[0]);
console.log(`Wrote ${join(out, 'import.json')}, quality-report.md, quarantine.csv`);
