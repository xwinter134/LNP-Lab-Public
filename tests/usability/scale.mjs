// How the app holds up after months of use: seeds a lab of a given size straight into the store, times the
// screens a person opens every day against a budget, and (with --quota) finds where browser storage runs out
// and what the user sees then.
//
//   npm run scale                         6 months, fails when a screen takes longer than its budget
//   node tests/usability/scale.mjs [--months 12] [--budget 800] [--runs 3] [--out docs/usability/scale.json] [--quota]
//
// Six months was the default because it was what fit in localStorage; a year did not (usability cycle 4, S1),
// and since the move to IndexedDB it does. The store is written through `window.lnpDb.write` when the app has
// it (IndexedDB) and straight into localStorage when it does not. When localStorage is too small for every
// measurement, the newest that fit are stored, and the output says how many: the timings are then for that many.
//
// Each screen is opened `--runs` times, round robin, and judged on the median; the first opening, which also
// loads the screen's module, is printed beside it. The run fails (exit 1) when a median is over the budget,
// or when a screen throws.
//
// Volumes are a busy but ordinary lab: ~10 experiments a week of 5 formulations, DLS + EE on each, a stability
// study a month with 2 shelves x 6 timepoints. Records are shaped like the app's own (see tests/usability/
// session.mjs truth.json and an export) so the numbers are the app's, not a toy's.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { chromium } = (() => { for (const c of ['playwright', '/opt/node-tools/node_modules/playwright', '/opt/node22/lib/node_modules/playwright']) { try { return req(c); } catch {} } throw new Error('playwright not found'); })();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes('--' + k);
const months = Number(arg('months', '6'));
const budget = Number(arg('budget', '800'));
const runs = Math.max(1, Number(arg('runs', '3')));
const outFile = arg('out', null) ? path.resolve(root, arg('out')) : null;

const { serve } = await import('../../scripts/serve.mjs');
const srv = await serve(root, 0, '127.0.0.1');
const base = `http://127.0.0.1:${srv.address().port}/`;
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.clock.setFixedTime(new Date('2026-10-27T09:30:00+01:00'));
// Started means the store is open (window.lnpDb, where there is one, is there to write through).
const started = () => page.waitForFunction(() => window.__lnpStarted, null, { timeout: 30000 }).catch(() => {});
await page.goto(base + '#/overview'); await started(); await page.waitForTimeout(300);

/** A lab of `m` months, generated in the page so the records come out exactly as the browser stores them. */
async function seed(m) {
  return page.evaluate(async (m) => {
    let s = 7; const u = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const exps = [], batches = [], meas = [], d0 = new Date('2026-10-27');
    const iso = (d) => d.toISOString().slice(0, 10);
    let e = 0;
    const weeks = Math.round(m * 4.33);
    for (let w = 0; w < weeks; w++) {
      for (let k = 0; k < 10; k++) {
        const id = `E${++e}`, date = iso(new Date(d0.getTime() - (weeks - w) * 7 * 864e5 + k * 864e5));
        const stab = k === 0 && w % 4 === 0;
        const n = stab ? 2 : 5;
        const ids = [];
        const expected = [];
        for (let f = 1; f <= n; f++) {
          const b = `${id}-F${f}`; ids.push(b);
          batches.push({ id: b, experimentId: id, label: `F${f}`, compositionId: 1, stockId: 'Stock-001', plannedDate: date, status: 'measured',
            plan: { rna: { lotId: 'RNA-1', stock_mg_mL: 1, working_mg_mL: 0.4, mass_mg: 3, np: 6 }, mixing: { frr: 3 + u(), quenchFactor: 2, totalFlow: 100 + 20 * u(), lipidStock_mM: 50, flows: null },
              factors: {}, downstream: { dialysis: { cassette: 'Slide-A-Lyzer 10K', buffer: 'PBS', volume_L: 2.5, hours: 16 } } }, actual: { rna_operator: 'GM', rna_date: date } });
          const shelves = stab ? [['4C', [0, 7, 14, 28, 56, 84]], ['25C', [0, 7, 14, 28, 56, 84]]] : [[null, [null]]];
          for (const [cond, tps] of shelves) for (const tp of tps) for (const test of ['dls', 'ee']) {
            const sample = cond ? `${b}_${cond}_T${String(tp).padStart(2, '0')}` : `${b}_final`;
            const slot = `${b}|${cond || 'final'}|${tp ?? ''}|${test}`;
            expected.push({ id: slot, batchId: b, sampleName: sample, test, stage: cond ? `T${tp}` : 'final', condition: cond, timepoint: tp, dueDate: date, status: 'done' });
            const z = 80 + 10 * u();
            meas.push({ id: `M${meas.length}`, batchId: b, experimentId: id, slotId: slot, test, stage: cond ? `T${tp}` : 'final', sampleName: sample, date, operator: 'GM',
              condition: cond, timepoint: tp, values: test === 'dls' ? { zave_nm: z, pdi: 0.08 + 0.04 * u(), zave_sd: 0.8, countRate_kcps: 300, runs: [0, 1, 2].map(() => ({ zave_nm: z + u() - 0.5, pdi: 0.1 })) } : { ee_pct: 90 + 5 * u() },
              flags: [], raw: { fileName: 'export.csv', sha256: 'x'.repeat(64), parser: 'csv-dls', parserVersion: 1 }, createdAt: date + 'T12:00:00.000Z', updatedAt: date + 'T12:00:00.000Z' });
          }
        }
        exps.push({ id, type: stab ? 'stability' : 'comparison', name: `Week ${w + 1} run ${k + 1}`, startDate: date, compositionId: 1, status: w < weeks - 2 ? 'done' : 'running',
          spec: {}, design: stab ? { stability: { formulations: ids.map((b, i) => ({ compositionId: 1, label: `F${i + 1}` })), conditions: ['4C', '25C'], timepoints: [0, 7, 14, 28, 56, 84], tests: ['dls', 'ee'] } } : {},
          batchIds: ids, expected });
      }
    }
    const errs = [];
    let stored = meas.length, engine;
    if (window.lnpDb) {
      // The app's own store (IndexedDB, app/store.js): the screens read what it holds after the reload below.
      engine = 'lnpDb';
      for (const [col, rows] of [['experiments', exps], ['batches', batches], ['measurements', meas]]) {
        try { await window.lnpDb.write(col, rows, 'lnp-lab'); } catch (err) { errs.push(`${col}: ${err.name}: ${err.message}`); if (col === 'measurements') stored = 0; }
      }
    } else {
      engine = 'localStorage';
      const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return null; } catch (err) { return err.name + ': ' + err.message; } };
      for (const [col, rows] of [['experiments', exps], ['batches', batches]]) { const err = put(`lnp-lab.${col}`, rows); if (err) errs.push(err); }
      const err = put('lnp-lab.measurements', meas);
      if (err) {
        // The measurements do not fit: keep the newest that do (they were made in date order), so the screens
        // are still timed with as many results as this browser can hold, and say how many that was.
        errs.push(err);
        let lo = 0, hi = meas.length;
        while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (put('lnp-lab.measurements', meas.slice(meas.length - mid))) hi = mid - 1; else lo = mid; }
        if (put('lnp-lab.measurements', meas.slice(meas.length - lo))) lo = 0;
        stored = lo;
      }
    }
    let bytes = 0; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); bytes += (k.length + localStorage.getItem(k).length) * 2; }
    return { engine, experiments: exps.length, batches: batches.length, measurements: meas.length, measurementsStored: stored, chars: JSON.stringify([exps, batches, meas]).length, localStorageBytesUtf16: bytes, errs };
  }, m);
}

/**
 * Open a screen and time until its heading is there and the main thread is free again. The placeholder is the
 * whole text of #main while a screen's file loads; matching the word alone waited out the timeout on a screen
 * that says "Loading pH" (the data overview).
 */
async function time(hash) {
  const t = Date.now();
  await page.goto(base + '#/' + hash);
  await page.waitForFunction(() => document.querySelector('#main h1, #main .note') && document.querySelector('#main').innerText.trim() !== 'Loading …', null, { timeout: 60000 }).catch(() => {});
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
  const ms = Date.now() - t;
  // A screen that threw renders its error note quickly; that is a failure, not a fast screen.
  const failed = await page.evaluate(() => /^Screen "[^"]*" failed/.test(document.querySelector('#main')?.innerText || ''));
  if (failed) errors.push(`#/${hash}: ${(await page.locator('#main').innerText()).slice(0, 200)}`);
  return ms;
}

const result = { months, budget, runs, date: new Date().toISOString() };
result.seed = await seed(months);
// A fresh start reads the seeded store; it opens on the overview, so the timing starts from a screen that is
// not in the list (the same address twice is no hash change, and the first overview would not be drawn).
await page.reload(); await started();
await page.goto(base + '#/learn'); await page.waitForTimeout(500);
const hashes = ['overview', 'experiments', 'formulation', 'measurements', 'insights', 'data', 'data?ionizable=ALC315&bufferSystem=Citrate', 'calendar', `experiments?id=E${result.seed.experiments}`, 'experiments?id=E1', 'ml'];
// Round robin, so no screen is opened twice in a row.
const times = Object.fromEntries(hashes.map((h) => [h, []]));
for (let r = 0; r < runs; r++) for (const h of hashes) times[h].push(await time(h));
const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2); };
result.screens = Object.fromEntries(hashes.map((h) => [h, median(times[h])]));
result.firstOpen = Object.fromEntries(hashes.map((h) => [h, times[h][0]]));
result.overBudget = hashes.filter((h) => result.screens[h] > budget);

// A save on a full store: what happens, and what does the person see? Only asked for. With IndexedDB the
// browser's real limit is far away (a share of the disk), so the app's own hook makes every write fail as
// QuotaExceededError would; without it (an older app) localStorage is filled to the brim instead.
if (flag('quota')) {
  result.quota = await page.evaluate(() => {
    if (window.lnpDb?.failWrites) { window.lnpDb.failWrites('QuotaExceededError'); return { how: 'failWrites' }; }
    let filler = 0; const chunk = 'x'.repeat(256 * 1024);
    try { for (; filler < 400; filler++) localStorage.setItem(`lnp-lab.zz_filler_${filler}`, chunk); } catch {}
    return { how: 'filler', fillerChunks: filler };
  });
  const count = () => page.evaluate(async () => (window.lnpDb ? await window.lnpDb.read('experiments', 'lnp-lab') : JSON.parse(localStorage.getItem('lnp-lab.experiments') || '[]')).length);
  await page.goto(base + '#/experiments?new=1&type=single'); await page.waitForTimeout(600);
  await page.fill('input[name=name]', 'Saved on a full disk'); await page.locator('input[name=name]').dispatchEvent('change');
  const before = await count();
  await page.click('#createExp'); await page.waitForTimeout(1200);
  result.quota.afterCreate = {
    stored: (await count()) - before,
    screen: (await page.locator('#main').innerText()).slice(0, 160),
    toast: await page.locator('#toast').innerText().catch(() => ''),
    hash: await page.evaluate(() => location.hash),
  };
  await page.evaluate(() => {
    if (window.lnpDb?.failWrites) window.lnpDb.failWrites(null);
    for (let i = 0; i < 400; i++) localStorage.removeItem(`lnp-lab.zz_filler_${i}`);
  });
}
result.pageErrors = [...new Set(errors)].slice(0, 10);
if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
}
await browser.close(); srv.close();

const s = result.seed;
console.log(`${months} months: ${s.experiments} experiments, ${s.batches} formulations, ${s.measurementsStored} of ${s.measurements} measurements stored (${s.engine})`);
for (const e of s.errs) console.log(`  storage: ${e}`);
const w = Math.max(...hashes.map((h) => h.length));
console.log(`\n${'Screen'.padEnd(w)}  ${'first'.padStart(6)}  ${'median'.padStart(6)}  budget`);
for (const h of hashes) console.log(`${h.padEnd(w)}  ${String(result.firstOpen[h]).padStart(6)}  ${String(result.screens[h]).padStart(6)}  ${result.screens[h] > budget ? `OVER ${budget}` : `≤ ${budget}`}`);
if (result.quota) console.log(`\nquota: ${JSON.stringify(result.quota)}`);
if (outFile) console.log(`\nwritten to ${path.relative(root, outFile)}`);
const failures = [...result.overBudget.map((h) => `#/${h} took ${result.screens[h]} ms (median of ${runs}), over the ${budget} ms budget`), ...result.pageErrors.map((e) => `page error: ${e}`)];
if (failures.length) { console.error('\nSCALE FAILED\n' + failures.map((f) => ' - ' + f).join('\n')); process.exit(1); }
console.log(`\nscale ok: every screen within ${budget} ms at ${months} months`);
