// Browser smoke test: serves the app, opens every screen, runs scenario scripts, fails on console/page errors.
// Run: node tests/smoke.mjs   (needs the playwright package and a Chromium; the cloud session has both)
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
function loadPlaywright() {
  for (const c of ['playwright', '/opt/node-tools/node_modules/playwright', '/opt/node22/lib/node_modules/playwright']) { try { return req(c); } catch {} }
  throw new Error('playwright not found: npm i -D playwright');
}
const { chromium } = loadPlaywright();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { serve } = await import('../scripts/serve.mjs');
const srv = await serve(root, 0, '127.0.0.1'); // the app's own dev server (no-cache headers), random free port
const port = srv.address().port;

const screens = ['overview', 'advisor', 'designs', 'experiments', 'formulation', 'stocks', 'buffers', 'measurements', 'data', 'calendar', 'doe', 'ml', 'insights', 'materials', 'learn', 'settings', 'quarantine', 'studies'];
const errors = [];
const browser = await chromium.launch();
// Berlin time on a Saturday: the date helpers must not depend on the timezone (local midnight is the previous day in UTC)
const context = await browser.newContext({ timezoneId: 'Europe/Berlin', acceptDownloads: true });
const page = await context.newPage();
await page.clock.setFixedTime(new Date('2026-10-17T10:00:00+02:00'));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
const base = `http://127.0.0.1:${port}/`;

async function open(hash) {
  await page.goto(base + '#/' + hash);
  await page.waitForFunction(() => document.querySelector('#main h1, #main .note'), null, { timeout: 5000 }).catch(() => errors.push(`no heading on ${hash}`));
  await page.waitForTimeout(150);
}

for (const s of screens) await open(s);
// Variants with parameters: a screen that renders from the list but throws when the planner hands it a
// factor list is a screen the sweep above cannot see.
for (const s of ['experiments?new=1', 'experiments?new=1&type=doe', 'experiments?new=1&type=stability',
  'experiments?new=1&type=ofat', 'experiments?new=1&type=doe&factors=frr,tfr,peg_pct&design=ccd_faced&model=quadratic&center=4',
  'ml?factors=frr,tfr', 'advisor?aim=size&budget=medium&scope=composition', 'advisor?aim=trouble&symptom=pdi',
  'advisor?mode=wizard', 'designs?k=2', 'designs?k=5&budget=12', 'designs?factors=frr,tfr,peg_pct',
  'learn?q=flow+rate', 'learn?topic=frr']) await open(s);

// scenarios: exercised only when the screen has real controls (ids below); skipped silently otherwise
// A scenarios file that does not load is a failure, not "no scenarios": a broken merge once left the smoke run
// reporting "ok" with 0 scenarios.
const scenarios = (await import('./scenarios.mjs').catch((e) => { errors.push(`tests/scenarios.mjs does not load: ${e.message}`); return { scenarios: [] }; })).scenarios || [];
// SMOKE_ONLY=name1,name2 runs only those scenarios (after the screen sweep), for working on one: a scenario that
// builds on an earlier one's records needs that one named too.
const only = (process.env.SMOKE_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
for (const sc of only.length ? scenarios.filter((x) => only.includes(x.name)) : scenarios) {
  try { await sc({ page, open, base, errors }); console.log('scenario ok:', sc.name); }
  catch (e) { errors.push(`scenario ${sc.name}: ${e.message}`); }
}

if (process.env.SCREENSHOTS) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(path.join(root, 'docs', 'screenshots'), { recursive: true });
  await page.setViewportSize({ width: 1380, height: 900 });
  // A string is named after its hash; a pair gives the file a readable name where the hash carries parameters.
  for (const s of ['overview', 'experiments?id=E1', 'stocks?id=Stock-001', 'buffers', ['formulation', 'batches'], 'formulation?batch=E2-F1', 'measurements', 'calendar', 'doe', 'insights', 'experiments?new=1&type=doe', 'ml',
    ['advisor', 'advisor_start'], ['advisor?aim=size&budget=medium&scope=composition', 'advisor'],
    ['advisor?aim=trouble&symptom=pdi', 'advisor_diagnose'], ['designs?k=3', 'designs'], 'learn']) {
    const [hash, name] = Array.isArray(s) ? s : [s, s.replace(/[?=&]/g, '_')];
    await open(hash);
    await page.screenshot({ path: path.join(root, 'docs', 'screenshots', name + '.png'), fullPage: ['doe', 'ml', 'advisor', 'designs', 'batches'].includes(name) });
  }
  await page.click('#themeSeg button[data-theme="dark"]');
  await page.reload(); await page.waitForTimeout(300);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (theme !== 'dark') errors.push('dark theme did not persist across reload: ' + theme);
  for (const s of ['overview', 'experiments?id=E1', 'buffers?new=1']) {
    await open(s);
    await page.screenshot({ path: path.join(root, 'docs', 'screenshots', 'dark_' + s.replace(/[?=]/g, '_') + '.png'), fullPage: false });
  }
  await page.click('#themeSeg button[data-theme="auto"]');
  // The demo lab, which is what the documentation can show without putting anyone's real data in a picture.
  await open('overview');
  await page.click('#demoToggle');
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  for (const [hash, name] of [['doe?id=E4&response=particle_size_nm', 'demo_doe'], ['formulation', 'demo_batches']]) {
    await open(hash);
    await page.screenshot({ path: path.join(root, 'docs', 'screenshots', name + '.png'), fullPage: true });
  }
  await open('overview');
  await page.click('#demoToggle');
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 15000 });
  console.log('screenshots written to docs/screenshots');
}
// Startup watchdog (index.html): serve damaged copies of the folder and check the message; a slow but healthy start must not be overwritten.
{
  const { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync, unlinkSync } = await import('node:fs');
  const os = await import('node:os');
  const copyApp = (sabotage) => { const d = mkdtempSync(path.join(os.tmpdir(), 'lnp-wd-')); for (const f of ['index.html', 'app']) cpSync(path.join(root, f), path.join(d, f), { recursive: true }); sabotage(d); return d; };
  const cases = [
    { name: 'conflict markers', expect: /app\/calc\/dates\.js: contains git merge-conflict markers/, sabotage: (d) => { const f = path.join(d, 'app/calc/dates.js'); writeFileSync(f, readFileSync(f, 'utf8').replace('export const todayISO', '<<<<<<< HEAD\nexport const todayISO2\n=======\nexport const todayISO\n>>>>>>> origin/main\nexport const todayISO')); } },
    { name: 'missing module', expect: /app\/calc\/dates\.js: HTTP 404/, sabotage: (d) => unlinkSync(path.join(d, 'app/calc/dates.js')) },
    { name: 'syntax error', expect: /SyntaxError[\s\S]*app\/ui\/kit\.js:\d+/, sabotage: (d) => { const f = path.join(d, 'app/ui/kit.js'); writeFileSync(f, readFileSync(f, 'utf8') + '\nconst oops = ;\n'); } },
    { name: 'broken data file', expect: /app\/data\/lipids\.json is not valid JSON[\s\S]*merge-conflict/, sabotage: (d) => { const f = path.join(d, 'app/data/lipids.json'); writeFileSync(f, '<<<<<<< HEAD\n' + readFileSync(f, 'utf8')); } },
  ];
  for (const c of cases) {
    const dir = copyApp(c.sabotage);
    const s2 = await serve(dir, 0, '127.0.0.1');
    const p2 = await context.newPage();
    await p2.goto(`http://127.0.0.1:${s2.address().port}/`); await p2.waitForTimeout(4200);
    const text = await p2.locator('#main').innerText();
    if (!c.expect.test(text)) errors.push(`watchdog ${c.name}: expected ${c.expect} in "${text.slice(0, 300)}"`);
    if (/hard reload/.test(text)) errors.push(`watchdog ${c.name}: a damaged file must not be blamed on the browser cache`);
    await p2.close(); s2.close(); rmSync(dir, { recursive: true, force: true });
  }
  // stale browser cache after a pull: an old module imports a name the new module no longer exports (link error, files on disk intact)
  const p4 = await context.newPage();
  await p4.route('**/app/calc/experiment.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: "import { generateDesign } from './doe.js';\nexport function experimentProgress() { return generateDesign; }\n" }));
  await p4.goto(base + '#/overview'); await p4.waitForTimeout(4200);
  const stale = await p4.locator('#main').innerText();
  if (!/did not start[\s\S]*hard reload/.test(stale) || /git reset/.test(stale)) errors.push(`watchdog stale-cache case: "${stale.slice(0, 300)}"`);
  await p4.close();
  // healthy but slow start (reference data delayed past the 3 s timer): the rendered screen must survive
  const p3 = await context.newPage();
  await p3.route('**/app/data/lipids.json', async (route) => { await new Promise((r) => setTimeout(r, 3600)); await route.continue(); });
  await p3.goto(base + '#/overview'); await p3.waitForTimeout(6000);
  const slow = await p3.locator('#main').innerText();
  if (!/Overview/.test(slow) || /did not start/.test(slow)) errors.push(`watchdog overwrote a slow start: "${slow.slice(0, 200)}"`);
  await p3.close();
  console.log('watchdog cases ok');
}

await browser.close();
srv.close();
if (errors.length) { console.error('SMOKE FAILED\n' + errors.map((e) => ' - ' + e).join('\n')); process.exit(1); }
console.log(`smoke ok: ${screens.length} screens, ${scenarios.length} scenarios`);
