// Clicks everything. The scripted session walks the paths a person usually takes; this walks the rest. Every
// screen of the demo lab (lists, each kind of experiment, a formulation, a stock, a buffer, the DoE and optimizer
// screens), every distinct control on it, and odd values in every input: a negative number, zero, 1e9, letters,
// nothing. What it records is what a person would hit: a page error, a console error, an "Error:" toast, or a
// screen that went blank.
//
//   node tests/usability/crawl.mjs [--max 70] [--out docs/usability/crawl.json] [--only experiments]
//
// Each screen starts from a fresh browser profile with the demo lab built, so a delete on one screen cannot
// hide a fault on the next. Confirm dialogs are accepted (the destructive paths are paths too), printing does
// nothing, downloads are taken and dropped. Exit 1 when anything was found.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { chromium } = (() => { for (const c of ['playwright', '/opt/node-tools/node_modules/playwright', '/opt/node22/lib/node_modules/playwright']) { try { return req(c); } catch {} } throw new Error('playwright not found'); })();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const MAX = Number(arg('max', '70'));
const ONLY = arg('only', null);
const outFile = arg('out', null) ? path.resolve(root, arg('out')) : null;

const { serve } = await import('../../scripts/serve.mjs');
const srv = await serve(root, 0, '127.0.0.1');
const base = `http://127.0.0.1:${srv.address().port}/`;
const browser = await chromium.launch();

const found = [];
const visited = [];

/** A fresh profile with the demo lab in it, open on `hash`. */
async function freshPage(hash) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true, timezoneId: 'Europe/Berlin' });
  await context.route((url) => !url.href.startsWith(base), (r) => r.abort());
  await context.addInitScript(() => { window.print = () => {}; try { localStorage.setItem('lnp-lab.demo', '1'); localStorage.setItem('lnp-lab.mode', 'advanced'); } catch {} });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date('2026-10-27T10:00:00+01:00'));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  page.on('download', (d) => d.delete().catch(() => {}));
  page.__errs = [];
  page.on('pageerror', (e) => page.__errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.__errs.push(`console: ${m.text()}`); });
  await page.goto(base + '#/' + hash);
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  return { page, context };
}

/** Controls in #main, one per distinct (kind, id, name, label): forty identical "Open" buttons are one control. */
async function controls(page) {
  return page.evaluate((max) => {
    const sel = 'button:not([disabled]), summary, a[href^="#"], input[type=checkbox]:not([disabled]), input[type=radio]:not([disabled]), select:not([disabled])';
    const seen = new Set(), out = [];
    for (const el of document.querySelectorAll('#main ' + sel.split(', ').join(', #main '))) {
      if (!el.offsetParent && el.tagName !== 'SUMMARY') continue;
      const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const sig = [el.tagName.toLowerCase(), el.id, el.name || '', el.getAttribute('href') ? el.getAttribute('href').replace(/=[^&]*/g, '=') : '', label.replace(/\d+/g, '#')].join('|');
      if (seen.has(sig)) continue;
      seen.add(sig); out.push({ sig, label });
      if (out.length >= max) break;
    }
    return out;
  }, MAX);
}

/** Find a control again by its signature (the screen may have been redrawn) and act on it. */
async function act(page, sig) {
  return page.evaluate((sig) => {
    const sel = 'button:not([disabled]), summary, a[href^="#"], input[type=checkbox]:not([disabled]), input[type=radio]:not([disabled]), select:not([disabled])';
    for (const el of document.querySelectorAll('#main ' + sel.split(', ').join(', #main '))) {
      const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      const s = [el.tagName.toLowerCase(), el.id, el.name || '', el.getAttribute('href') ? el.getAttribute('href').replace(/=[^&]*/g, '=') : '', label.replace(/\d+/g, '#')].join('|');
      if (s !== sig) continue;
      if (el.tagName === 'SELECT') {
        const opts = [...el.options].filter((o) => !o.disabled);
        if (opts.length) { el.value = opts[opts.length - 1].value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
      } else el.click();
      return true;
    }
    return false;
  }, sig);
}

async function screenState(page) {
  return page.evaluate(() => ({
    hash: location.hash,
    text: (document.querySelector('#main')?.innerText || '').trim().length,
    toast: document.querySelector('#toast')?.innerText || '',
  }));
}

function record(where, what, detail) {
  found.push({ where, what, detail });
  console.log(`  ✗ ${where} — ${what}: ${String(detail).slice(0, 220)}`);
}

async function drainErrors(page, where, what) {
  const errs = page.__errs.splice(0);
  for (const e of [...new Set(errs)]) record(where, what, e);
  const st = await screenState(page).catch(() => null);
  // A toast stays up a while: report it once, against the action that raised it, not every action after.
  if (st && st.toast !== page.__toast && /\bError\b|Uncaught|undefined|NaN|\[object Object\]/.test(st.toast)) record(where, what, `toast: ${st.toast}`);
  if (st) page.__toast = st.toast;
  return st;
}

/** Every control on a screen, then odd values in every input. */
async function crawl(hash) {
  const { page, context } = await freshPage(hash);
  const where = '#/' + hash;
  try {
    await drainErrors(page, where, 'open');
    const st0 = await screenState(page);
    if (st0.text < 20) record(where, 'open', 'blank screen');
    const list = await controls(page);
    let clicks = 0;
    for (const c of list) {
      const before = await screenState(page);
      if (before.hash !== '#/' + hash) { await page.goto(base + '#/' + hash); await page.waitForTimeout(300); }
      const ok = await act(page, c.sig).catch(() => false);
      if (!ok) continue;
      clicks++;
      await page.waitForTimeout(c.sig.includes('runBtn') ? 4000 : 250);
      const st = await drainErrors(page, where, `click "${c.label || c.sig}"`);
      if (st && st.text < 20) record(where, `click "${c.label || c.sig}"`, `blank screen at ${st.hash}`);
    }
    // Odd values, back on the screen as it opens.
    await page.goto(base + '#/' + hash); await page.waitForTimeout(300);
    const inputs = await page.evaluate(() => {
      const seen = new Set(), out = [];
      for (const el of document.querySelectorAll('#main input:not([type]), #main input[type=number], #main input[type=text], #main textarea')) {
        if (!el.offsetParent || el.disabled || el.readOnly) continue;
        const key = el.id || el.name || el.placeholder;
        if (!key || seen.has(key)) continue;
        seen.add(key); out.push({ id: el.id, name: el.name, placeholder: el.placeholder });
        if (out.length >= 40) break;
      }
      return out;
    });
    let fuzzed = 0;
    for (const inp of inputs) {
      for (const v of ['-1', '0', '1e9', 'abc', '']) {
        const done = await page.evaluate(([inp, v]) => {
          const el = (inp.id && document.getElementById(inp.id)) || (inp.name && document.querySelector(`#main [name="${CSS.escape(inp.name)}"]`)) || (inp.placeholder && document.querySelector(`#main [placeholder="${CSS.escape(inp.placeholder)}"]`));
          if (!el) return false;
          el.focus(); el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.blur();
          return true;
        }, [inp, v]).catch(() => false);
        if (!done) continue;
        fuzzed++;
        await page.waitForTimeout(60);
        await drainErrors(page, where, `type "${v}" into ${inp.id || inp.name || inp.placeholder}`);
      }
    }
    visited.push({ hash, controls: list.length, clicks, inputs: inputs.length, values: fuzzed });
    console.log(`${where}: ${clicks} controls clicked, ${inputs.length} inputs × odd values`);
  } catch (err) {
    record(where, 'crawler', err.message);
  } finally {
    await context.close();
  }
}

// The screens, then a record of every kind the demo holds.
const screens = ['overview', 'advisor', 'designs', 'experiments', 'formulation', 'stocks', 'buffers', 'measurements', 'calendar', 'doe', 'ml', 'insights', 'materials', 'learn', 'settings',
  'experiments?new=1', 'experiments?new=1&type=doe', 'experiments?new=1&type=stability', 'experiments?new=1&type=ofat', 'experiments?new=1&type=comparison',
  'stocks?new=1', 'buffers?new=1'];
const { page: p0, context: c0 } = await freshPage('overview');
const records = await p0.evaluate(async () => {
  const r = async (c) => (await window.lnpDb.read(c, 'lnp-demo')) || [];
  const exps = await r('experiments'), batches = await r('batches'), stocks = await r('stocks'), buffers = await r('buffers');
  return {
    experiments: exps.map((e) => e.id),
    doe: exps.filter((e) => e.type === 'doe').map((e) => e.id),
    // one formulation per state it can be in: planned, made, measured, ...
    batches: [...new Map(batches.map((b) => [b.status, b.id])).values()],
    stocks: stocks.slice(0, 1).map((s) => s.id), buffers: buffers.slice(0, 1).map((b) => b.id),
  };
});
await c0.close();
screens.push(...records.experiments.map((id) => `experiments?id=${id}`), ...records.doe.map((id) => `doe?id=${id}`),
  ...records.batches.map((id) => `formulation?batch=${id}`), 'measurements?grid=1', ...records.stocks.map((id) => `stocks?id=${id}`), ...records.buffers.map((id) => `buffers?id=${id}`));

const t0 = Date.now();
for (const hash of screens.filter((h) => !ONLY || h.startsWith(ONLY))) await crawl(hash);
await browser.close(); srv.close();

const totals = visited.reduce((a, v) => ({ clicks: a.clicks + v.clicks, values: a.values + v.values }), { clicks: 0, values: 0 });
console.log(`\n${visited.length} screens, ${totals.clicks} controls clicked, ${totals.values} odd values typed, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
if (outFile) { fs.mkdirSync(path.dirname(outFile), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify({ visited, found }, null, 1)); console.log(`written to ${path.relative(root, outFile)}`); }
if (found.length) { console.error(`\nCRAWL FOUND ${found.length} problem${found.length === 1 ? '' : 's'}`); process.exit(1); }
console.log('crawl ok: nothing found');
