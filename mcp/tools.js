// The tools of the LNP Lab MCP server (spec 6.3, 10.1), as plain handlers: createTools(config) gives the tool
// list and call(name, args). mcp/server.js puts them behind the MCP SDK over stdio; tests/mcp.test.mjs calls them
// directly against a database file of its own.
//
// The split is the spec's (6.1): Claude does the fuzzy part, reading the sheets (read_file), mapping columns to the
// fields of get_schema and names to list_catalog; these handlers do the strict part, with the app's own check
// (app/calc/importcheck.js) and the app's own store (app/store.js), so nothing gets into the lab that the app
// itself would refuse, and nothing is written in a way the app would not write it.
//
// Nothing is written without a dry run the person has seen. dry_run_import returns the quality report and an
// approval token. The token is bound to the exact content (a SHA-256 over the mapped rows and the hashes of the
// files they came from), to the lab as it was (the hash of the records the dry run planned), is good once, and for
// TOKEN_MINUTES. commit_import with any other content, a used or an old token, or after the lab changed, is
// refused, and says to run the dry run again.
//
// This server sends nothing over the network. Claude, the client that calls it, reads what the tools return.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, extname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { readLab, writeLab, appRunning, shippedData, emptyLab } from './lab.js';
import { readXlsx } from './xlsx.js';
import { parseCsvRows, lipidMatcher, tidySchema, TESTS, EXPERIMENT_TYPES, reportMarkdown, historicalKey } from '../app/calc/importcheck.js';
import { planImport, applyImport, rollbackImport, listImports, labQuality, openQuarantine } from '../app/calc/importops.js';
import { VARIABLES } from '../app/calc/variables.js';
import { dataRows, facetDefs, readFilter, applyFilter, summary, completeness, describeFilter, tally } from '../app/calc/facets.js';
import { ANALYSES, dataState, latestReport, reportStatus, buildReport } from '../app/calc/insightreport.js';
import { insightSummary, repeatedSettings, RESPONSE_WORDS, GROUP_WORDS } from '../app/calc/insights.js';
import { pearson } from '../app/calc/stats.js';
import { flatRows } from '../app/ui/insights.js';
import { getRef } from '../app/refdata.js';

export const TOKEN_MINUTES = 30;
const MAX_ROWS = 500;

const sha = (s) => createHash('sha256').update(s).digest('hex');
/** JSON with the keys of every object sorted, so the same content always hashes the same. */
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const fail = (message, extra = {}) => ({ ok: false, error: message, ...extra });

/** A data row's columns as the check reads them: strings, numbers and booleans as given, nothing nested. */
const cleanRow = (r) => Object.fromEntries(Object.entries(r || {}).filter(([k, v]) => !k.startsWith('_') && (v == null || ['string', 'number', 'boolean'].includes(typeof v))));

const TABLE_SCHEMA = { type: 'array', items: { type: 'object', additionalProperties: true } };
const IMPORT_INPUT = {
  type: 'object',
  properties: {
    experiments: { ...TABLE_SCHEMA, description: 'Rows of the experiments table (optional). Columns as get_schema lists them.' },
    formulations: { ...TABLE_SCHEMA, description: 'Rows of the formulations table (required). Each row may carry _source: {file, sheet, row}, the file path, sheet name and row number in the original spreadsheet it was read from, and _raw: the original cells, kept with a refused row in quarantine.' },
    measurements: { ...TABLE_SCHEMA, description: 'Rows of the measurements table (optional), one per test result; _source as for formulations.' },
    first_experiment: { type: 'number', description: 'Only for an import file for the browser version, which cannot read the lab: the first E number to give.' },
  },
  required: ['formulations'],
};

/**
 * The server's tools over one lab.
 * @param {object} config
 *   dbPath: the macOS app's database (default: its usual place); ns: the lab's namespace ('lnp-lab');
 *   target: 'auto' (the database file if it exists, else an import file), 'sqlite' or 'file';
 *   outDir: where import files go (default ~/Downloads); baseDir: what relative paths are read against;
 *   running(dbPath): whether the app is running (tests pass a stand-in); personal: the insight tools (spec 10),
 *   on when true, when LNP_LAB_PERSONAL=1, or when the lab's settings have personalBuild switched on;
 *   now(): the clock, for tests.
 */
export function createTools(config = {}) {
  const ns = config.ns || 'lnp-lab';
  const dbPath = config.dbPath;
  const outDir = config.outDir || process.env.LNP_LAB_OUT || join(homedir(), 'Downloads');
  const baseDir = config.baseDir || process.cwd();
  const running = config.running || appRunning;
  const now = config.now || (() => new Date());
  const data = shippedData();
  const tokens = new Map();

  const target = () => (config.target && config.target !== 'auto' ? config.target : dbPath && existsSync(dbPath) ? 'sqlite' : 'file');
  const lab = () => (dbPath && existsSync(dbPath) ? readLab(dbPath, ns) : emptyLab(ns));
  const personalOn = () => config.personal ?? (process.env.LNP_LAB_PERSONAL === '1' || lab().all('settings').some((s) => s.id === 'default' && s.personalBuild === true));

  /** Read a source file once, for its hash (and, in read_file, its rows). */
  const fileCache = new Map();
  const source = (p) => {
    const path = resolve(baseDir, String(p));
    if (!fileCache.has(path)) {
      if (!existsSync(path)) throw new Error(`cannot read the source file ${p}: it is not there (give the path read_file was given)`);
      const buf = readFileSync(path);
      fileCache.set(path, { path, name: basename(path), sha256: sha(buf), buf });
    }
    return fileCache.get(path);
  };

  /** The tables as the check takes them, with each row's origin fingerprinted by the server itself. */
  const tablesOf = (args) => {
    const out = {};
    for (const t of ['experiments', 'formulations', 'measurements']) {
      const rows = args[t];
      if (rows == null) continue;
      if (!Array.isArray(rows)) throw new Error(`${t} must be a list of rows`);
      out[t] = { name: t, rows: rows.map((r, i) => {
        const s = r?._source;
        const row = { __row: Number(s?.row) || i + 1, ...cleanRow(r) };
        if (s?.file) { const f = source(s.file); row.__origin = { file: { name: f.name, sha256: f.sha256 }, ...(s.sheet ? { sheet: String(s.sheet) } : {}), ...(s.row != null ? { row: Number(s.row) } : {}) }; }
        if (r?._raw != null) row._raw = r._raw;
        return row;
      }) };
    }
    if (!out.formulations) throw new Error('formulations is required: the import is built around the formulations table');
    return out;
  };
  const filesOf = (tables) => [...new Map(Object.values(tables).flatMap((t) => t.rows).filter((r) => r.__origin?.file).map((r) => [r.__origin.file.sha256, r.__origin.file])).values()];

  /** The plan of an import against the lab as it is now; `fixed` = {importId, importedAt} to plan it again exactly. */
  const plan = (theLab, tables, fixed) => planImport(theLab, data, tables, { importId: fixed.importId, importedAt: fixed.importedAt, source: 'mcp-import' });
  // The browser version's lab cannot be read from here: with first_experiment, numbering starts at that E number.
  const numberedFrom = (L, first) => (first ? { ...L, all: (c) => (c === 'counters' ? [...L.all('counters').filter((x) => x.id !== 'experiment'), { id: 'experiment', top: first - 1 }] : L.all(c)) } : L);
  const resultHash = (result) => sha(canon({ e: result.experiments, u: result.experimentUpdates, b: result.batches, m: result.measurements, c: result.compositions, x: result.mixers, q: result.quarantine }));

  const brief = (result) => ({
    quarantine: result.quarantine.slice(0, 50).map((q) => ({ table: q.table, row: q.origin?.row ?? q.row, sheet: q.origin?.sheet, file: q.origin?.file?.name, reason: q.reason })),
    duplicates: result.duplicates.slice(0, 50).map((d) => ({ table: d.table, row: d.origin?.row ?? d.row, sheet: d.origin?.sheet, file: d.origin?.file?.name, reason: d.reason })),
    newExperiments: result.experiments.map((e) => ({ id: e.id, name: e.name })),
    newFormulations: result.batches.length, newMeasurements: result.measurements.length,
    newCompositions: result.compositions.map((c) => ({ id: c.id, mol_pct: c.mol_pct })),
  });

  // ----------------------------------------------------------------------------------------------- handlers
  const handlers = {
    get_schema() {
      return {
        tables: tidySchema(),
        processVariables: VARIABLES.filter((v) => v.kind !== 'derived').map((v) => ({ key: v.key, step: v.step, name: v.name, kind: v.kind, unit: v.unit, min: v.min, max: v.max, options: v.kind === 'category' && !v.addable ? v.options : undefined, addable: !!v.addable })),
        tests: Object.fromEntries(Object.entries(TESTS).map(([t, vals]) => [t, Object.fromEntries(Object.entries(vals).map(([k, [lo, hi]]) => [k, { min: lo, max: hi }]))])),
        experimentTypes: EXPERIMENT_TYPES,
        rows: 'One object per row, keyed by the column names above. Add _source: {file, sheet, row} with the path of the original file (as given to read_file), its sheet and row, so the import can be traced and is never brought in twice; add _raw with the original cells. Leave a value out when the sheet does not say it: never fill one in.',
        refused: ['a required column is empty, or a key appears twice', 'a lipid name is not in the catalogue (list_catalog)', 'mol% do not add up to 100 (± 0.5)', 'a number outside its sense limits (PDI over 1, EE over 100 %, size under 10 nm, pH outside 0–14 …)', 'a category that is not one of its words', 'a measurement whose formulation is not in the import or the lab', 'the same formulation, test, stage and timepoint twice without a replicate number', 'a formulation whose experiment came with an earlier import'],
        duplicates: 'A row whose source (file SHA-256, sheet, row, table, and for a measurement its test) is already in the lab is not imported again; the dry run lists it under duplicates.',
        requiredFields: 'Open point for the lab: which fields make a record usable is still to be decided (docs/HISTORICAL-DATA.md); today only exp_key, form_key and a composition are required.',
        dates: 'YYYY-MM-DD.',
      };
    },

    list_catalog() {
      const L = lab();
      const ref = getRef({ store: L, data });
      return {
        lipids: ref.lipids.map((l) => ({ key: l.key, name: l.name, class: l.class })),
        compositions: ref.compositions.map((c) => ({ id: c.id, synonym: c.synonym || null, mol_pct: c.mol_pct })),
        buffers: { lab: L.all('buffers').map((b) => ({ id: b.id, name: b.name || b.recipe || null, role: b.role || null })), catalogue: (data.buffers_catalog || []).map((b) => ({ code: b.code, name: b.name, roles: b.roles })) },
        experiments: L.all('experiments').slice(-300).map((e) => ({ id: e.id, name: e.name, type: e.type, startDate: e.startDate || null, historicalKey: historicalKey(e), importId: e.provenance?.importId || null })),
        mixers: L.all('mixers').map((m) => ({ id: m.id, name: m.name, type: m.type || null })),
        target: target(),
      };
    },

    read_file({ path, maxRows = MAX_ROWS, sheet = null } = {}) {
      if (!path) return fail('path is required');
      const f = source(path);
      const ext = extname(f.path).toLowerCase();
      const cap = Math.max(1, Math.min(5000, Number(maxRows) || MAX_ROWS));
      let sheets;
      if (ext === '.xlsx' || ext === '.xlsm') sheets = readXlsx(f.buf, { maxRows: cap });
      else if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
        const rows = parseCsvRows(f.buf.toString('utf8')).filter((r) => r.cells.some((c) => String(c).trim() !== ''));
        sheets = [{ name: null, rows: rows.slice(0, cap), ...(rows.length > cap ? { more: rows.length - cap } : {}) }];
      } else if (ext === '.xls') return fail('an .xls (Excel 97–2003) file cannot be read here: open it in Excel or Numbers and save it as .xlsx or CSV');
      else return fail(`a ${ext || 'file without extension'} cannot be read here: give a .xlsx or .csv file`);
      if (sheet != null) sheets = sheets.filter((s) => s.name === sheet);
      return { ok: true, file: f.name, path: f.path, sha256: f.sha256, sheets: sheets.map((s) => ({ ...s, nRows: s.rows.length + (s.more || 0) })) };
    },

    dry_run_import(args = {}) {
      let tables;
      try { tables = tablesOf(args); } catch (err) { return fail(err.message); }
      const at = now();
      const fixed = { importId: `imp-${at.toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`, importedAt: at.toISOString() };
      const L = lab();
      const first = target() === 'file' && Number(args.first_experiment) > 0 ? Number(args.first_experiment) : null;
      // An import file is merged by id: numbered over experiments the browser lab already has, it would replace them.
      if (target() === 'file' && !L.all('experiments').length && !first) return fail('there is no database file here (the browser version keeps its records in the browser), so the server cannot see which experiment numbers are taken: pass first_experiment, the number after the newest experiment in the lab (shown under Experiments), e.g. 42 when the newest is E41');
      const { result, report } = plan(numberedFrom(L, first), tables, fixed);
      const token = randomBytes(16).toString('hex');
      const inputHash = sha(canon({ tables, first }));
      tokens.set(token, { inputHash, resultHash: resultHash(result), ...fixed, first, expires: at.getTime() + TOKEN_MINUTES * 60e3, used: false });
      return {
        ok: true, importId: fixed.importId, target: target(), report, ...brief(result),
        markdown: reportMarkdown(report, { title: 'Import quality report (dry run, nothing written)' }),
        approvalToken: token, tokenExpires: new Date(at.getTime() + TOKEN_MINUTES * 60e3).toISOString(),
        next: 'Show this report to the person. Only once they approve it, call commit_import with exactly the same rows and this approvalToken. Any change to the rows needs a new dry run.',
      };
    },

    async commit_import(args = {}) {
      const t = tokens.get(String(args.token || args.approvalToken || ''));
      if (!t) return fail('no valid approval token: run dry_run_import first, show the report, and pass the approvalToken it returns');
      if (t.used) return fail('this approval token was used already: each dry run approves one commit');
      if (now().getTime() > t.expires) { tokens.delete(args.token); return fail(`this approval token has expired (after ${TOKEN_MINUTES} minutes): run dry_run_import again`); }
      let tables;
      try { tables = tablesOf(args); } catch (err) { return fail(err.message); }
      if (sha(canon({ tables, first: t.first })) !== t.inputHash) return fail('these rows are not the ones the dry run checked (or a source file changed since): run dry_run_import again with them and show the new report');
      const files = filesOf(tables);
      const fixed = { importId: t.importId, importedAt: t.importedAt };
      if (target() === 'file') {
        const { result } = plan(numberedFrom(lab(), t.first), tables, fixed);
        if (resultHash(result) !== t.resultHash) return fail('the lab changed since the dry run: run dry_run_import again');
        t.used = true;
        const file = writeImportFile(result, files);
        return { ok: true, importId: t.importId, written: file, target: 'file', counts: { experiments: result.experiments.length, formulations: result.batches.length, measurements: result.measurements.length, quarantine: result.quarantine.length },
          next: `In LNP Lab: Settings & export › Backup & restore › Import JSON, choose ${basename(file)}, with "replace instead of merge" left unticked. Every record carries importId ${t.importId}; Settings › Imports can undo it whole.` };
      }
      try {
        const out = await writeLab(dbPath, ns, (store) => {
          const { result } = plan(store, tables, fixed);
          if (resultHash(result) !== t.resultHash) throw Object.assign(new Error('the lab changed since the dry run (records were added or changed in the app): run dry_run_import again'), { code: 'STALE' });
          const w = applyImport(store, result, { kind: 'mcp', source: 'mcp-import', files });
          if (!w.ok) throw new Error(w.reason);
          return { counts: w.written, experiments: result.experiments.map((e) => e.id) };
        }, { running, stampWith: { importId: t.importId } });
        t.used = true;
        return { ok: true, importId: t.importId, target: 'sqlite', ...out, next: 'Open LNP Lab: the import is under Data (filter Origin › Import), its refused rows under Quarantine, and Settings › Imports can undo it.' };
      } catch (err) {
        if (err.code === 'STALE') t.used = true;
        return fail(err.message, err.code ? { code: err.code } : {});
      }
    },

    quality_report({ importId = null } = {}) {
      const L = lab();
      if (importId && !L.all('imports').some((i) => i.id === importId)) return fail(`there is no import ${importId} (list_imports names them)`);
      return { ok: true, ...labQuality(L, data, importId || null), openQuarantine: openQuarantine(L).filter((e) => !importId || e.importId === importId).slice(0, 50).map((e) => ({ id: e.id, importId: e.importId, table: e.table, row: e.origin?.row ?? e.row, reason: e.reason })) };
    },

    async rollback_import({ importId } = {}) {
      if (!importId) return fail('importId is required (list_imports names them)');
      if (target() !== 'sqlite') return fail('the lab is not a database file this server can reach (the browser version): undo the import in LNP Lab, Settings & export › Imports › Undo import');
      try {
        const r = await writeLab(dbPath, ns, (store) => rollbackImport(store, importId), { running, stampWith: { rollback: importId } });
        if (!r.ok) return fail(r.reason);
        return { ok: true, importId, trashEntry: r.entry.id, moved: r.counts, others: r.others,
          note: `Everything of ${importId} is in the trash now${r.others ? `, with ${r.others} record${r.others === 1 ? '' : 's'} of other origin that hung on it` : ''}. In LNP Lab, Settings & export › Recently deleted puts it back (for 30 days).` };
      } catch (err) { return fail(err.message, err.code ? { code: err.code } : {}); }
    },

    list_imports() {
      const L = lab();
      return { ok: true, target: target(), imports: listImports(L).map((i) => ({ id: i.id, kind: i.kind, files: i.files || i.fileName, importedAt: i.importedAt, imported: i.imported, inLab: i.state.inLab, live: i.state.live, inTrash: i.state.trash.length > 0, quarantineOpen: i.quarantineOpen })) };
    },

    // ------------------------------------------------------------------- insights (spec 10, personal build)
    summarize_database() {
      const L = lab();
      const ref = getRef({ store: L, data });
      const rows = dataRows({ batches: L.all('batches'), experiments: L.all('experiments'), measurements: L.all('measurements') }, ref);
      const lipid = (k) => ref.lipidByKey[k]?.name || k;
      const rep = latestReport(L);
      return {
        ok: true, analysis: 'summary', dataState: dataState(L), summary: summary(rows),
        counts: { experiments: L.count?.('experiments') ?? L.all('experiments').length, formulations: rows.length, measurements: L.all('measurements').length, quarantineOpen: openQuarantine(L).length },
        coverage: { ionizable: tally(rows, (r) => r.ionizable).slice(0, 10).map((x) => ({ ...x, value: lipid(x.value) })), bufferSystem: tally(rows, (r) => [r.bufferSystem]), mixerType: tally(rows, (r) => [r.mixerType]), source: tally(rows, (r) => [r.source]) },
        completeness: completeness(rows).map((c) => ({ key: c.key, label: c.label, n: c.n, share: Math.round(c.share * 100) })),
        latestReport: rep ? { id: rep.id, createdAt: rep.createdAt, dataState: rep.dataState, ...reportStatus(rep, L) } : null,
        analyses: ANALYSES,
      };
    },

    query_formulations({ query = '', filter = {}, ids = null, limit = 50, offset = 0 } = {}) {
      const L = lab();
      const ref = getRef({ store: L, data });
      const rows = dataRows({ batches: L.all('batches'), experiments: L.all('experiments'), measurements: L.all('measurements') }, ref);
      const defs = facetDefs(ref);
      const params = { ...Object.fromEntries(new URLSearchParams(String(query || ''))), ...Object.fromEntries(Object.entries(filter || {}).map(([k, v]) => [k, Array.isArray(v) ? v.join('|') : String(v)])) };
      // Lipids may be named as the app shows them (ALC-0315) or by their catalogue key (ALC315).
      const lipidKey = lipidMatcher(ref.lipids);
      for (const k of ['ionizable', 'helper', 'sterol', 'peg']) if (params[k]) params[k] = params[k].split('|').map((v) => lipidKey(v) || v).join('|');
      const f = readFilter(params, defs);
      let hit = applyFilter(rows, f, defs).rows;
      if (Array.isArray(ids) && ids.length) { const want = new Set(ids.map(String)); hit = hit.filter((r) => want.has(r.id)); }
      const lim = Math.max(1, Math.min(500, Number(limit) || 50)), off = Math.max(0, Number(offset) || 0);
      return {
        ok: true, analysis: 'summary', description: describeFilter(f, defs, hit.length, rows), total: hit.length, summary: summary(hit),
        completeness: completeness(hit).map((c) => ({ key: c.key, n: c.n, share: Math.round(c.share * 100) })),
        rows: hit.slice(off, off + lim).map((r) => ({ id: r.id, experimentId: r.experimentId, experimentName: r.experimentName, date: r.date, compositionId: r.compositionId, ionizable: r.ionizable, peg: r.peg, pegFree: r.pegFree,
          frr: r.frr, tfr: r.tfr, np: r.np, bufferSystem: r.bufferSystem, loadingPH: r.loadingPH, mixerType: r.mixerType, mixer: r.mixer, postMethod: r.postMethod, size: r.size, pdi: r.pdi, ee: r.ee, zeta: r.zeta, source: r.source, importId: r.importId })),
        filterKeys: defs.map((d) => ({ key: d.key, label: d.label, range: !!d.range })),
        note: 'Filters use the Data overview\'s keys: a list as "a|b", a range as "lo~hi" with either end open, q for free text.',
      };
    },

    get_trends({ responses = ['zave_nm', 'pdi', 'ee_pct'], colorBy = ['stockId', 'operator', 'compositionId'], comp = null } = {}) {
      const L = lab();
      const all = flatRows({ store: L, data }).filter((r) => comp == null || r.compositionId === Number(comp)).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
      const out = [];
      for (const response of [].concat(responses).filter((r) => RESPONSE_WORDS[r])) {
        const rows = all.filter((r) => Number.isFinite(r[response]));
        const rep = repeatedSettings(rows, response);
        const chart = rep[0]?.rows || rows;
        const corr = [['np', 'N/P'], ['frr', 'FRR'], ['tfr', 'Total flow'], ['quench', 'Quench factor'], ['peg_pct', 'PEG mol%'], ['ionizable_pct', 'Ionizable mol%'], ['lipid_mM', 'Lipid stock mM'], ['rna_mg_mL', 'RNA working mg/mL']]
          .map(([k, label]) => ({ factor: k, label, ...pearson(rows.map((r) => r[k]), rows.map((r) => r[response])) })).filter((c) => c.r != null).sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
        for (const g of [].concat(colorBy).filter((c) => GROUP_WORDS[c])) {
          const s = insightSummary(rows, { response, colorBy: g, chart });
          out.push({ response, colorBy: g, n: s.n, sentences: s.sentences,
            groupEffect: s.effect ? { analysis: 'groupEffect', ...s.effect, ...(s.effect.names ? { names: s.effect.names.slice(0, 20) } : {}) } : null,
            drift: s.drift ? { analysis: 'drift', ...s.drift, formulationIds: chart.slice(-(s.drift.recent || 5)).map((r) => r.batchId) } : null,
            outside: s.outside ? { analysis: 'controlLimits', formulationIds: s.outside.map((r) => r.batchId) } : null });
        }
        out.push({ response, analysis: 'correlation', correlations: corr, chartSetting: rep[0] ? { key: rep[0].key, n: rep[0].n, formulationIds: rep[0].rows.map((r) => r.batchId) } : null, note: 'Pearson r across all batches with this response: direction only.' });
      }
      return { ok: true, trends: out, analyses: ANALYSES, note: 'These are the app\'s own analyses (the Insights screen). Interpret them; do not compute new statistics. Every finding of a report names its analysis key and its formulation ids.' };
    },

    get_optimizer_state() {
      const L = lab();
      const ref = getRef({ store: L, data });
      const setup = L.all('settings').find((s) => s.id === 'mlSetup')?.value || null;
      const rows = new Map(dataRows({ batches: L.all('batches'), experiments: L.all('experiments'), measurements: L.all('measurements') }, ref).map((r) => [r.id, r]));
      const rounds = L.all('experiments').filter((e) => e.design?.ml).sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || ''))).slice(0, 3);
      const measured = { particle_size_nm: 'size', PDI: 'pdi', encapsulation_efficiency: 'ee', zeta_potential_mV: 'zeta' };
      return {
        ok: true, analysis: 'optimizer', setup,
        rounds: rounds.map((e) => ({ id: e.id, name: e.name, startDate: e.startDate, mode: e.design.ml.mode, seed: e.design.ml.seed, goals: e.design.ml.goals, factors: Object.keys(e.design.ml.space || {}),
          runs: (e.batchIds || []).map((id) => { const b = L.all('batches').find((x) => x.id === id); const r = rows.get(id) || {};
            return { id, predicted: b?.ml?.predicted || null, measured: Object.fromEntries(Object.entries(measured).map(([k, f]) => [k, r[f] ?? null])), pBeatsBest: b?.ml?.pBeatsBest ?? null }; }) })),
        note: 'The app fits its models when the Optimizer opens and stores no model summary, so length scales are not available here; the saved setup and each round\'s predictions against what was measured are.',
      };
    },

    async save_insight_report(args = {}) {
      const L = lab();
      const built = buildReport(args, L, now());
      if (!built.ok) return fail('the report was not saved', { problems: built.problems });
      if (target() === 'file') {
        mkdirSync(outDir, { recursive: true });
        const file = join(outDir, `lnp-lab-insights-${built.record.createdAt.slice(0, 10)}.json`);
        writeFileSync(file, JSON.stringify({ exportedAt: built.record.createdAt, ns, collections: { insightReports: [built.record] } }, null, 1));
        return { ok: true, id: built.record.id, written: file, next: `In LNP Lab: Settings & export › Import JSON, choose ${basename(file)} (merge). The Insights screen then shows it.` };
      }
      try {
        await writeLab(dbPath, ns, (store) => { store.put('insightReports', built.record); }, { running, stampWith: { insightReport: built.record.id } });
        return { ok: true, id: built.record.id, dataState: built.record.dataState, next: 'The Insights screen of LNP Lab shows it at the top.' };
      } catch (err) { return fail(err.message, err.code ? { code: err.code } : {}); }
    },
  };

  /** An import file for the browser version: the backup format, merged in by Settings › Import JSON. */
  function writeImportFile(result, files) {
    mkdirSync(outDir, { recursive: true });
    const q = result.quarantine.map((x, i) => ({ id: `${result.importId}-q${i + 1}`, importId: result.importId, table: x.table, file: x.file, row: x.row, raw: x.source, mapping: x.raw, reason: x.reason, origin: x.origin, originKey: x.originKey, status: 'open', createdAt: result.importedAt }));
    const collections = { experiments: result.experiments, batches: result.batches, measurements: result.measurements, compositions: result.compositions, mixers: result.mixers, quarantine: q,
      imports: [{ id: result.importId, kind: 'mcp', source: 'mcp-import', fileName: files.map((f) => f.name).join(', '), sha256: files[0]?.sha256 || null, files, importedAt: result.importedAt, imported: result.batches.length + result.measurements.length,
        experimentIds: result.experiments.map((e) => e.id), batchIds: result.batches.map((b) => b.id), measurementIds: result.measurements.map((m) => m.id), compositionIds: result.compositions.map((c) => c.id), quarantineIds: q.map((x) => x.id) }] };
    const file = join(outDir, `lnp-lab-import-${result.importId}.json`);
    writeFileSync(file, JSON.stringify({ exportedAt: result.importedAt, ns, importId: result.importId, collections }, null, 1));
    return file;
  }

  const RO = { readOnlyHint: true, openWorldHint: false };
  const defs = [
    { name: 'get_schema', description: 'The fields an import takes: the three tidy tables (experiments, formulations, measurements) with types, units, allowed categories and sense limits, the process variables, and the rules a row is refused by. Read it before mapping a spreadsheet.', inputSchema: { type: 'object', properties: {} }, annotations: RO },
    { name: 'list_catalog', description: 'What the lab already has: lipids (map lipid names to these), compositions, buffers, experiments (with the historical key of an earlier import), mixers.', inputSchema: { type: 'object', properties: {} }, annotations: RO },
    { name: 'read_file', description: 'Read a local .xlsx or .csv file: every sheet as raw rows of cell values with their row numbers, and the file\'s SHA-256. Nothing is interpreted beyond dates.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path of the file' }, sheet: { type: 'string', description: 'Only this sheet' }, maxRows: { type: 'number', description: `Rows per sheet, default ${MAX_ROWS}` } }, required: ['path'] }, annotations: RO },
    { name: 'dry_run_import', description: 'Check mapped rows with the app\'s own rules, against the lab, without writing anything. Returns the quality report (counts, importable, quarantine with reasons, duplicates, completeness) and an approval token for commit_import. Show the report to the person before any commit.', inputSchema: IMPORT_INPUT, annotations: RO },
    { name: 'commit_import', description: 'Write a checked import, after the person approved its dry-run report. Needs the approvalToken of that dry run and exactly the same rows; refused otherwise. Writes to the macOS app\'s database (only while the app is closed), or for the browser version an import file to read in under Settings › Import JSON.', inputSchema: { ...IMPORT_INPUT, properties: { ...IMPORT_INPUT.properties, token: { type: 'string', description: 'approvalToken from dry_run_import' } }, required: ['token', 'formulations'] }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
    { name: 'quality_report', description: 'The quality of one import (importId) or of the whole lab: counts, completeness per field as the Data overview shows it, open quarantine by reason.', inputSchema: { type: 'object', properties: { importId: { type: 'string' } } }, annotations: RO },
    { name: 'rollback_import', description: 'Move every record of an import into the lab\'s trash, from where Settings › Recently deleted restores it. Only while the app is closed.', inputSchema: { type: 'object', properties: { importId: { type: 'string' } }, required: ['importId'] }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
    { name: 'list_imports', description: 'The import history with counts: what each import brought, what of it is in the lab or in the trash, and how many of its rows wait in quarantine.', inputSchema: { type: 'object', properties: {} }, annotations: RO },
  ];
  const personalDefs = [
    { name: 'summarize_database', description: 'An overview of the lab for insights: counts, period, medians of size, PDI and EE, coverage by lipid, buffer and mixer, completeness, and the date and data state of the latest saved insight report.', inputSchema: { type: 'object', properties: {} }, annotations: RO },
    { name: 'query_formulations', description: 'Formulations filtered as in the Data overview (keys from filterKeys, e.g. {"ionizable": "ALC-0315", "size": "~150"}), with the summary of the selection and its rows.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'A Data overview address query, e.g. "ionizable=ALC-0315&mixerType=T-junction"' }, filter: { type: 'object', additionalProperties: true }, ids: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' }, offset: { type: 'number' } } }, annotations: RO },
    { name: 'get_trends', description: 'The app\'s own analyses per response (size, PDI, EE): groups compared at matched settings (lots, operators, compositions), drift of the latest batches, points outside the control limits, and correlations. Each carries its analysis key and formulation ids.', inputSchema: { type: 'object', properties: { responses: { type: 'array', items: { type: 'string' } }, colorBy: { type: 'array', items: { type: 'string' } }, comp: { type: 'number' } } }, annotations: RO },
    { name: 'get_optimizer_state', description: 'The optimizer\'s saved setup and its latest rounds, each run\'s prediction against what was measured.', inputSchema: { type: 'object', properties: {} }, annotations: RO },
    { name: 'save_insight_report', description: 'Save an insights report into the lab, shown on the Insights screen. At most five findings, each with its text, the analysis key it came from (as the read tools give them), the formulation ids it rests on, and optionally a value; plus drivers, anomalies and openQuestions in the same form. The server adds the date and the data state.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, findings: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, analysis: { type: 'string', enum: Object.keys(ANALYSES) }, formulationIds: { type: 'array', items: { type: 'string' } }, value: { type: 'string' }, response: { type: 'string' } }, required: ['text', 'analysis', 'formulationIds'] } }, drivers: { type: 'array', items: { type: 'object' } }, anomalies: { type: 'array', items: { type: 'object' } }, openQuestions: { type: 'array', items: { type: 'object' } } }, required: ['findings'] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  ];
  const personalNames = new Set(personalDefs.map((d) => d.name));

  return {
    list: () => (personalOn() ? [...defs, ...personalDefs] : defs),
    async call(name, args = {}) {
      if (!handlers[name]) return fail(`no tool ${name}`);
      if (personalNames.has(name) && !personalOn()) return fail(`${name} is part of the insights module, which is off: switch on Settings › Claude insights in a personal build of LNP Lab, or start the server with LNP_LAB_PERSONAL=1`);
      try { return await handlers[name](args || {}); } catch (err) { return fail(err.message); }
    },
    tokens, // for tests
  };
}
