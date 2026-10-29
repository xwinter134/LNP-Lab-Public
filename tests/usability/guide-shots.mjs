// The pictures in the user guide (docs/GUIDE.md), made from the app as it is, the same way every time.
//
//   node tests/usability/guide-shots.mjs [--only <name>] [--quality 70] [--out docs/guide]
//
// Serves the folder with scripts/serve.mjs on a free port and drives Chromium (Playwright) at 1280 px wide, light
// theme, Berlin time, the clock fixed at 27 Oct 2026 10:00. Each picture is a JPEG 1280 px wide, cropped in height
// to the part of the screen the guide talks about, with the sidebar beside it so you can see where you are.
//
// Two fresh browser profiles, so nothing carries over from one run to the next:
//   - an empty lab (your own namespace), for the first start, settings, an RNA lot, a stock weigh-in, a buffer,
//     the planner and the backup reminder;
//   - the demo lab (init script: localStorage lnp-lab.demo = 1), for everything that needs
//     data. The demo lab is seeded, so it is the same lab every run. A German UTF-16 Zetasizer export for E7-F1 is
//     written here and imported, as a person would drop it in.
// navigator.storage.estimate() and persisted() are stubbed, so the storage meter in Settings reads the same on
// every machine; nothing else is faked.
//
// A re-run overwrites the pictures (and removes the folder's old JPEGs first, unless --only is given) and, on an
// unchanged app, gives the same pictures; a file or two may still differ by a few pixels of text antialiasing.
// When the app changes so that a picture's screen or element cannot be found, that picture is reported and skipped
// and the run exits 1, so a stale picture does not go unnoticed. Keep the folder under about 3 MB (the run prints
// the total). Run it after a change to a screen the guide shows, look at the pictures, and commit them with the
// change. Needs the playwright package and its Chromium, as npm run smoke does.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { chromium } = (() => { for (const c of ['playwright', '/opt/node-tools/node_modules/playwright', '/opt/node22/lib/node_modules/playwright']) { try { return req(c); } catch {} } throw new Error('playwright not found'); })();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const ONLY = arg('only', null);
const QUALITY = Number(arg('quality', '70'));
const OUT = path.resolve(root, arg('out', 'docs/guide'));
const W = 1280, H = 900;

fs.mkdirSync(OUT, { recursive: true });
if (!ONLY) for (const f of fs.readdirSync(OUT)) if (f.endsWith('.jpg')) fs.rmSync(path.join(OUT, f));

const { serve } = await import('../../scripts/serve.mjs');
const srv = await serve(root, 0, '127.0.0.1');
const base = `http://127.0.0.1:${srv.address().port}/`;
const browser = await chromium.launch();
const failed = [];
const written = [];

/** A fresh profile on the app, demo lab or an empty one of your own. */
async function open({ demo }) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, timezoneId: 'Europe/Berlin', locale: 'en-GB', colorScheme: 'light', acceptDownloads: true });
  await context.route((url) => !url.href.startsWith(base), (r) => r.abort());
  await context.addInitScript((demo) => {
    window.print = () => {};
    try {
      if (demo) localStorage.setItem('lnp-lab.demo', '1');
      localStorage.setItem('lnp-lab.mode', 'advanced');
      localStorage.setItem('lnp-lab.theme', 'light');
    } catch {}
    try {
      if (navigator.storage) {
        navigator.storage.estimate = async () => ({ quota: 10e9, usage: 150e3 });
        navigator.storage.persisted = async () => true;
        navigator.storage.persist = async () => true;
      }
    } catch {}
  }, demo);
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date('2026-10-27T10:00:00+01:00'));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('download', (d) => d.delete().catch(() => {}));
  page.on('pageerror', (e) => console.log(`  page error: ${e.message}`));
  await page.goto(base + '#/overview');
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 30000 });
  return { context, page };
}

/** Open a screen and let it draw. */
async function go(page, hash, settle = 500) {
  await page.goto(base + '#/' + hash);
  await page.waitForFunction(() => document.querySelector('#main h1, #main .note'), null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(settle);
}

const clearToasts = (page) => page.evaluate(() => document.getElementById('toast')?.replaceChildren());

/** No focus ring on the last field typed in, and no hover on whatever the pointer last touched. */
async function settle(page) {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.mouse.move(W - 4, 4);
}

/**
 * One picture: from the top of `from` to the bottom of `to` (selectors; `to` defaults to `from`), the full 1280 px
 * across. The window is scrolled so `from` sits near its top, and made taller when the part is taller than it.
 */
async function shot(page, name, from, to = from, { pad = 14, maxH = 1500, toasts = false, focus = false } = {}) {
  if (ONLY && name !== ONLY) return;
  const file = path.join(OUT, name + '.jpg');
  try {
    if (!focus) await settle(page);
    if (!toasts) await clearToasts(page);
    const a = page.locator(from).first();
    const b = to === from ? a : page.locator(to).first();
    await a.waitFor({ state: 'visible', timeout: 10000 });
    await b.waitFor({ state: 'visible', timeout: 10000 });
    const place = () => a.evaluate((el) => { const fixed = getComputedStyle(el).position === 'fixed' || el.closest('#toast, .search-pop'); if (!fixed) window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 18)); });
    const boxOf = async () => {
      const [ra, rb] = [await a.boundingBox(), await b.boundingBox()];
      return { top: Math.min(ra.y, rb.y), bottom: Math.max(ra.y + ra.height, rb.y + rb.height) };
    };
    await place(); await page.waitForTimeout(150);
    let box = await boxOf();
    if (box.bottom + pad > H) {
      await page.setViewportSize({ width: W, height: Math.min(maxH, Math.ceil(box.bottom - box.top + 2 * pad + 40)) });
      await place(); await page.waitForTimeout(200);
      box = await boxOf();
    }
    const vh = page.viewportSize().height;
    const top = box.top - pad < 48 ? 0 : Math.floor(box.top - pad);
    const bottom = Math.min(vh, Math.ceil(box.bottom + pad));
    await page.screenshot({ path: file, type: 'jpeg', quality: QUALITY, animations: 'disabled', caret: 'hide', clip: { x: 0, y: top, width: W, height: bottom - top } });
    written.push(name);
    console.log(`  ${name}.jpg  ${W}×${bottom - top}  ${(fs.statSync(file).size / 1024).toFixed(0)} kB`);
  } catch (err) {
    failed.push(`${name}: ${err.message.split('\n')[0]}`);
    console.log(`  ✗ ${name}: ${err.message.split('\n')[0]}`);
  } finally {
    await page.setViewportSize({ width: W, height: H }).catch(() => {});
  }
}

/** Do a step of the walk; a step that fails is reported and the walk goes on. */
async function step(label, fn) {
  try { await fn(); } catch (err) { failed.push(`${label}: ${err.message.split('\n')[0]}`); console.log(`  ✗ ${label}: ${err.message.split('\n')[0]}`); }
}

/** A German Zetasizer export, as Zetasizer software writes it: UTF-16 with a BOM, semicolons, decimal commas. */
function zetasizerGerman(sample, runs) {
  const lines = [
    'Malvern Panalytical – Zetasizer Software 8.02',
    'Datei:;C:\\Daten\\LNP\\E7_Freigabe.dts',
    'Exportiert am:;30.10.2026 11:12:40',
    'Bediener:;AB',
    '',
    'Datensatznummer;Messtyp;Probenname;Messdatum und -zeit;Temperatur (°C);Z-Mittelwert (d.nm);PdI;Abgeleitete Zählrate (kcps);Abschwächer',
    ...runs.map(([z, p, c], i) => `${i + 1};Größe;${sample} ${i + 1};30.10.2026 11:0${i * 2}:15;25,0;${String(z).replace('.', ',')};${String(p).replace('.', ',')};${String(c).replace('.', ',')};7`),
    `;;Mittelwert;;25,0;${(runs.reduce((s, r) => s + r[0], 0) / runs.length).toFixed(2).replace('.', ',')};;;`,
  ];
  return Buffer.from('\ufeff' + lines.join('\r\n') + '\r\n', 'utf16le');
}

console.log(`Writing to ${path.relative(root, OUT)}/`);

/* ---------------- an empty lab of your own ---------------- */
{
  const { context, page } = await open({ demo: false });

  await go(page, 'overview');
  await shot(page, 'first-start', '#main .crumb', '#main .card:has(h2:text-is("Getting started"))');

  await step('settings', async () => {
    await go(page, 'settings');
    await page.fill('#operator', 'AB');
    await page.locator('#operator').blur(); // settings are stored as each field is left
    await page.waitForTimeout(300);
  });
  await shot(page, 'settings', '#main .card:has(#setForm)');

  await step('RNA lot', async () => {
    await go(page, 'materials?tab=rna');
    // RNA lots open in place (0.15): "+ Add RNA lot", then the editor's fields, the cargo among them
    await page.click('#tabBody [data-act=new]');
    await page.fill('[data-editor] [name=e_id]', 'RNA-2026-014');
    await page.selectOption('[data-editor] [name=e_cargo]', 'mRNA');
    await page.fill('[data-editor] [name=e_construct]', 'FLuc mRNA');
    await page.fill('[data-editor] [name=e_conc_mg_mL]', '1.02');
    await page.click('[data-editor] [data-act=save]');
    await page.waitForTimeout(400);
  });
  await shot(page, 'materials-rna', '#main .crumb', '#tabBody');

  await step('lipid lot', async () => {
    // A registered lot, so the weigh-in below offers it on the MC3 card.
    await go(page, 'materials?tab=lipids');
    await page.selectOption('#lotForm #lipidKey', 'MC3');
    await page.fill('#lotForm #lot', 'MC3-2409-117');
    await page.fill('#lotForm #supplier', 'supplier A');
    await page.fill('#lotForm #purityPct', '98.2');
    await page.click('#addLot');
    await page.waitForTimeout(400);
  });

  await step('stock weigh-in', async () => {
    await go(page, 'stocks?new=1');
    const masses = await page.$$eval('#main .weighCard', (cards) => cards.map((c) => c.dataset.key));
    const actual = [0.3049, 0.0751, 0.1414, 0.0356];
    for (const [i, key] of masses.entries()) await page.fill(`[name="actual_${key}"]`, String(actual[i] ?? 0.1));
    await page.locator('#main #stockForm h2').first().click();
    await page.waitForTimeout(400);
  });
  await shot(page, 'stock-weigh-in', '#main #stockForm h2', '#main #wcAfter');

  await step('buffer', async () => {
    // "Prepare" on the shelf fills in the name and roles; the system, pH and concentration are set here, as the
    // guide tells the reader to check.
    await go(page, 'buffers?new=1&from=1');
    await page.selectOption('#system', 'Citric acid');
    await page.waitForTimeout(300);
    await page.fill('#targetPH', '4');
    await page.fill('#conc_mM', '25');
    await page.locator('#main #bufferForm h2').first().click();
    await page.waitForTimeout(500);
  });
  await shot(page, 'buffer', '#main #bufferForm h2', '#main #bufferForm h2:text-is("Speciation at the designed pH"), #main :text("Speciation at the designed pH")', { pad: 4 });
  await step('save buffer', async () => { await page.click('#saveBuffer'); await page.waitForTimeout(500); });

  await step('planner', async () => { await go(page, 'advisor?aim=size&budget=medium&scope=process', 700); });
  await shot(page, 'planner', '#main .crumb', '#main .card:has(h2:text-is("What will happen"))');

  await go(page, 'overview');
  await shot(page, 'backup-reminder', '#main .card:has(#backupDue)');
  await go(page, 'settings', 900);
  await shot(page, 'settings-data', '#main .card:has(#storageMeter)', '#main .card:has(#exportAll)');

  await context.close();
}

/* ---------------- the demo lab ---------------- */
{
  const { context, page } = await open({ demo: true });

  await go(page, 'overview', 800);
  await shot(page, 'demo-overview', '#main .crumb', '#main .card:has(h2:text-is("Latest results")), #main .card:has(:text("Latest results"))');

  await go(page, 'experiments?new=1');
  await shot(page, 'new-experiment', '#main .crumb', '#main a[href*="type=reference"]');

  await go(page, 'experiments?new=1&type=stability', 700);
  await shot(page, 'wizard-stability', '#main h2:has-text("Stability design")', '#main .card:has(h2:text-is("What will be created")), #main :text("Sample name example")');

  await go(page, 'experiments?new=1&type=doe&factors=frr,tfr,peg_pct&design=ccd_faced&model=quadratic&center=4', 900);
  await shot(page, 'wizard-doe', '#main :text("What are you optimizing?")', '#main :text("Runs become formulations")', { pad: 20 });

  await go(page, 'experiments?id=E7', 700);
  await shot(page, 'experiment-planned', '#main .crumb', '#main #nextStep ~ div, #main .card >> nth=0');

  await step('bench record', async () => {
    await go(page, 'formulation?batch=E7-F1', 800);
    await page.fill('#rna_stock_mg_mL', '1.02');
    await page.locator('#rna_mass_mg').click();
    await page.waitForTimeout(500);
  });
  await shot(page, 'bench-record', '#main .crumb', '#main .card:has(h2:text-is("Inputs")), #main .card:has(:text-is("Inputs"))');
  await step('bench steps', async () => { await page.evaluate(() => window.scrollTo(0, 0)); });
  await shot(page, 'bench-steps', '#main details:has(summary:has-text("Step 1")), #main :text("Step 1 ·")', '#main :text("Step 6 ·")');

  // Before E7 is measured below, so its production day and measurement day are still open on the calendar.
  await go(page, 'calendar', 600);
  await shot(page, 'calendar', '#main .crumb', '#main .card >> nth=0');

  await go(page, 'measurements', 700);
  await shot(page, 'measurements-due', '#main .crumb', '#main #dueCard');

  await step('import a file', async () => {
    await go(page, 'measurements', 600);
    const file = zetasizerGerman('E7-F1_final', [[83.12, 0.088, 296.4], [82.47, 0.091, 301.2], [83.85, 0.085, 298.7]]);
    await page.setInputFiles('#csvFile', { name: 'E7_Freigabe.csv', mimeType: 'text/csv', buffer: file });
    await page.waitForSelector('#doImport', { timeout: 10000 });
    await page.waitForTimeout(400);
  });
  await shot(page, 'import-preview', '#main #importCard');
  await step('import', async () => { await page.click('#doImport'); await page.waitForSelector('#importEval', { timeout: 10000 }); await page.waitForTimeout(700); });
  await shot(page, 'import-evaluation', '#main #importEval');

  await step('grid', async () => {
    await go(page, 'measurements', 600);
    await page.click('#main [data-due-grid="0"]');
    await page.waitForSelector('#resultGrid input.gcell', { timeout: 10000 });
    await page.fill('#resultGrid input.gcell[data-key="ee_pct"]', '93.4');
    await page.waitForTimeout(300);
  });
  await shot(page, 'results-grid', '#main .card:has(#resultGrid)');
  await step('save grid', async () => { await page.click('#gridSave'); await page.waitForTimeout(500); });

  await step('correction', async () => {
    const id = await page.evaluate(async () => (await window.lnpDb.read('measurements', 'lnp-demo')).find((m) => m.batchId === 'E7-F1' && m.test === 'dls')?.id);
    if (!id) throw new Error('no DLS result for E7-F1');
    await go(page, `measurements?id=${encodeURIComponent(id)}`, 600);
    await page.click('#editResult');
    await page.waitForSelector('#editForm');
    await page.fill('#editReason', 're-measured');
    await page.waitForTimeout(200);
  });
  await shot(page, 'correction', '#main .crumb', '#main #editForm');

  await go(page, 'experiments?id=E1', 800);
  await shot(page, 'results-reference', '#main #resultsCard', '#main #resultsCard .figs, #main #resultsCard svg >> nth=0', { pad: 40 });

  await go(page, 'experiments?id=E6', 800);
  await shot(page, 'results-stability', '#main #resultsCard', '#main #stabTable');

  await step('report', async () => {
    await go(page, 'experiments?id=E1', 600);
    const [popup] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }), page.click('#reportExp')]);
    await popup.waitForLoadState();
    await popup.setViewportSize({ width: W, height: 1100 });
    await popup.waitForTimeout(500);
    if (!ONLY || ONLY === 'report') {
      await popup.screenshot({ path: path.join(OUT, 'report.jpg'), type: 'jpeg', quality: QUALITY, animations: 'disabled', caret: 'hide', clip: { x: 0, y: 0, width: W, height: 1100 } });
      written.push('report');
      console.log(`  report.jpg  ${W}×1100  ${(fs.statSync(path.join(OUT, 'report.jpg')).size / 1024).toFixed(0)} kB`);
    }
    await popup.close();
  });

  await go(page, 'doe?id=E4', 1000);
  await shot(page, 'doe-balance', '#main .crumb', '#main #balanceCard');
  await shot(page, 'doe-fit', '#main #fitCard', '#main #fitVerdict ~ *, #main #plotsFold', { maxH: 1100 });

  await step('optimizer', async () => {
    await go(page, 'ml', 800);
    // Leave cholesterol free to take up the slack, as a formulator would; the demo's DoE varied it only as a
    // balance, and with it chosen as a factor the helper lipid has to balance instead.
    const sterol = page.locator('input[name="s_on_sterol_pct"]');
    if (await sterol.count() && await sterol.isChecked()) { await sterol.uncheck(); await page.waitForTimeout(300); }
    await page.click('#runBtn');
    await page.waitForSelector('#makeExp', { timeout: 120000 });
    await page.waitForTimeout(800);
  });
  await shot(page, 'optimizer', '#main .crumb', '#main #makeExp');

  await go(page, 'insights', 900);
  await shot(page, 'insights', '#main .crumb', '#main .card:has(h2:has-text("Control chart")), #main :text("Limits mean")');

  await step('search', async () => {
    await go(page, 'overview', 600);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('E4-F14', { delay: 20 });
    await page.waitForSelector('#searchResults:not([hidden])', { timeout: 5000 });
    await page.waitForTimeout(300);
  });
  await shot(page, 'search', '#search', '#searchResults', { focus: true });
  await page.keyboard.press('Escape').catch(() => {});

  await step('delete', async () => {
    await go(page, 'experiments?id=E3', 600);
    await clearToasts(page);
    await page.click('#delExp');
    await page.waitForSelector('#toast [data-toast-action="Undo"]', { timeout: 5000 });
    await page.waitForTimeout(200);
  });
  await shot(page, 'undo', '#toast', '#toast', { toasts: true, focus: true, pad: 120 });

  await go(page, 'settings', 700);
  await shot(page, 'trash', '#main #trashCard');

  await context.close();
}

await browser.close();
srv.close();
const total = fs.readdirSync(OUT).filter((f) => f.endsWith('.jpg')).reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`\n${written.length} pictures, ${(total / 1024 / 1024).toFixed(2)} MB in ${path.relative(root, OUT)}/`);
if (failed.length) { console.error(`\n${failed.length} not made:\n` + failed.map((f) => ' - ' + f).join('\n')); process.exit(1); }
