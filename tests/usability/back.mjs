// Spec 9.1: "a run through every assistant, with Back after each step". Each assistant is walked one step at a
// time, and after each step the on-screen Back arrow (#crumbBack) is pressed: the address must be the step
// before, and that step's own controls must be on screen again; then the step is taken again and the walk goes on.
//
//   - the planner ("Plan an experiment"): every aim, through each of its questions (budget, what can change, or
//     the symptom), to the recommendation
//   - the troubleshooting assistant (Work out what went wrong, its setting on): context, diagnosis, plan, with
//     what was typed into the context still there after Back
//   - the experiment wizard: each type from the type chooser
//   - the DoE wizard: each design of the catalogue that opens it, the trail reading
//     "Plan › Design catalogue › <design>", Back returning to the catalogue
//
//   npm run back            node tests/usability/back.mjs
//
// The walk itself is `walkBack`, which tests/scenarios.mjs also runs inside `npm run smoke`; run as a script, this
// file serves the app, opens it in a fresh profile and exits 1 on the first step that does not come back.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const AIM_IDS = ['first', 'size', 'ee', 'screen', 'optimise', 'robust', 'stability', 'trouble'];
const TYPE_IDS = ['single', 'stability', 'ofat', 'doe', 'comparison', 'reference'];

/**
 * Walk every assistant with Back after each step. `open(hash)` opens a route the way the smoke run does; the
 * page must be on the app. The troubleshooting assistant's setting is switched on for its part and put back.
 * Returns the number of steps walked; throws on the first that did not come back.
 */
export async function walkBack({ page, open }) {
  let steps = 0;
  const hashNow = () => page.evaluate(() => location.hash);
  const waitHash = async (want, label) => {
    await page.waitForFunction((w) => location.hash === w, want, { timeout: 4000 })
      .catch(async () => { throw new Error(`${label}: the address is ${await hashNow()}, expected ${want}`); });
  };
  const visible = async (selector, label) => {
    await page.waitForSelector(selector, { timeout: 4000 }).catch(async () => { throw new Error(`${label}: ${selector} is not on screen at ${await hashNow()}: "${(await page.locator('#main').innerText()).slice(0, 200).replace(/\s+/g, ' ')}"`); });
  };
  /** Take a step (do), check where it went (ready), press Back, check the step before is back, take it again. */
  const step = async (label, { before, beforeReady, act, ready }) => {
    await act();
    await page.waitForFunction((b) => location.hash !== b, before, { timeout: 4000 }).catch(() => { throw new Error(`${label}: the step did not change the address`); });
    await visible(ready, label);
    const after = await hashNow();
    await page.click('#crumbBack');
    await waitHash(before, `${label}, Back`);
    await visible(beforeReady, `${label}, Back`);
    await act();
    await waitHash(after, `${label}, again`);
    await visible(ready, `${label}, again`);
    steps++;
    return after;
  };

  // ---- the planner, every aim through its questions
  const settings = await page.evaluate(() => window.lnpDb.read('settings'));
  const withSetting = async (patch) => {
    const was = settings.find((s) => s.id === 'default') || { id: 'default' };
    await page.evaluate((rows) => window.lnpDb.write('settings', rows), [...settings.filter((s) => s.id !== 'default'), { ...was, ...patch }]);
  };
  try {
    await withSetting({ troubleAssistant: false });
    for (const aim of AIM_IDS) {
      await open('advisor?mode=wizard');
      await visible('.adv-card[data-set^="aim="]', `aim ${aim}`);
      let before = await step(`${aim}: the aim`, { before: '#/advisor?mode=wizard', beforeReady: '.adv-card[data-set^="aim="]', act: () => page.click(`[data-set="aim=${aim}"]`), ready: '#advRoot' });
      let ready = '.adv-card[data-set^="aim="]';
      // Then each question this aim asks, in turn, until the recommendation (or the diagnosis) is on screen.
      for (const q of ['symptom', 'budget', 'scope']) {
        const card = page.locator(`.adv-card[data-set^="${q}="]`).first();
        if (!(await card.count())) continue;
        const pick = await card.getAttribute('data-set');
        ready = `.adv-card[data-set^="${q}="]`;
        before = await step(`${aim}: ${q}`, { before, beforeReady: ready, act: () => page.click(`[data-set="${pick}"]`), ready: '#advRoot' });
      }
      if (await page.locator('.adv-card[data-set^="budget="], .adv-card[data-set^="scope="], .adv-card[data-set^="symptom="]').count()) throw new Error(`${aim}: a question is still open at the end of the walk (${await hashNow()})`);
    }

    // ---- the troubleshooting assistant: context, diagnosis, plan
    await withSetting({ troubleAssistant: true });
    await open('advisor?mode=wizard');
    await step('troubleshooter: into the context', { before: '#/advisor?mode=wizard', beforeReady: '[data-set="aim=trouble"]', act: () => page.click('[data-set="aim=trouble"]'), ready: '#tsForm' });
    const context = await hashNow();
    await page.fill('#ts_frr', '2');
    await page.check('input[name=ts_symptom][value=pdi]');
    await page.click('#tsDiagnose');
    await page.waitForFunction(() => /step=diagnose/.test(location.hash), null, { timeout: 4000 }).catch(() => { throw new Error('troubleshooter: Diagnose did not move on'); });
    await visible('.tsCause', 'troubleshooter: the diagnosis');
    const diagnosis = await hashNow();
    await page.click('#crumbBack');
    // The context is put back in the address as it was sent, so Back lands on the entry with the typed values.
    await page.waitForFunction(() => /aim=trouble/.test(location.hash) && !/step=/.test(location.hash), null, { timeout: 4000 })
      .catch(async () => { throw new Error(`troubleshooter: Back from the diagnosis went to ${await hashNow()}`); });
    await visible('#tsForm', 'troubleshooter: Back to the context');
    if (await page.inputValue('#ts_frr') !== '2') throw new Error('troubleshooter: Back to the context lost the FRR typed');
    if (!(await page.isChecked('input[name=ts_symptom][value=pdi]'))) throw new Error('troubleshooter: Back to the context lost the symptom');
    if ((await hashNow()) === context) throw new Error('troubleshooter: the context step kept no record of what was typed');
    await page.click('#tsDiagnose');
    await waitHash(diagnosis, 'troubleshooter: the diagnosis again');
    steps++;
    await step('troubleshooter: the plan', { before: diagnosis, beforeReady: '#tsToPlan', act: () => page.click('#tsToPlan'), ready: '.tsPlan' });

    // ---- the experiment wizard: each type from the chooser
    for (const type of TYPE_IDS) {
      await open('experiments?new=1');
      await step(`wizard: ${type}`, { before: '#/experiments?new=1', beforeReady: `a[href="#/experiments?new=1&type=${type}"]`, act: () => page.click(`a[href="#/experiments?new=1&type=${type}"]`), ready: '#createExp' });
    }

    // ---- the DoE wizard: every design of the catalogue that opens it
    await open('designs?k=3');
    const links = await page.$$eval('#main a.btn[href*="type=doe"]', (as) => [...new Set(as.map((a) => a.getAttribute('href')))]);
    if (links.length < 5) throw new Error(`the catalogue offers ${links.length} DoE designs to set up`);
    for (const href of links) {
      await open('designs?k=3');
      await step(`DoE wizard: ${href}`, { before: '#/designs?k=3', beforeReady: '#main a.btn[href*="type=doe"]', act: () => page.click(`#main a.btn[href="${href}"]`), ready: '#createExp' });
      const trail = await page.locator('#crumbs').innerText();
      if (!/Plan[\s\S]*Design catalogue[\s\S]*\S/.test(trail) || /Experiments/.test(trail)) throw new Error(`DoE wizard ${href}: the trail reads "${trail.replace(/\s+/g, ' ')}"`);
      const last = await page.locator('#crumbs [aria-current="page"]').innerText();
      if (!last.trim() || /^New/.test(last)) throw new Error(`DoE wizard ${href}: the last crumb is "${last}", not the design`);
    }
  } finally {
    await page.evaluate((rows) => window.lnpDb.write('settings', rows), settings);
  }
  return steps;
}

// ---- run as a script
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const req = createRequire(import.meta.url);
  const { chromium } = (() => { for (const c of ['playwright', '/opt/node-tools/node_modules/playwright', '/opt/node22/lib/node_modules/playwright']) { try { return req(c); } catch {} } throw new Error('playwright not found'); })();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const { serve } = await import('../../scripts/serve.mjs');
  const srv = await serve(root, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, timezoneId: 'Europe/Berlin' })).newPage();
  await page.clock.setFixedTime(new Date('2026-10-27T10:00:00+01:00'));
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const open = async (hash) => {
    await page.goto(base + '#/' + hash);
    await page.waitForFunction(() => document.querySelector('#main h1, #main .note'), null, { timeout: 8000 }).catch(() => errors.push(`no heading on ${hash}`));
    await page.waitForTimeout(100);
  };
  await page.goto(base + '#/overview');
  await page.waitForFunction(() => window.__lnpStarted, null, { timeout: 20000 });
  let n = 0;
  try { n = await walkBack({ page, open }); } catch (e) { errors.push(e.message); }
  await browser.close(); srv.close();
  if (errors.length) { console.error('BACK FAILED\n' + errors.map((e) => ' - ' + e).join('\n')); process.exit(1); }
  console.log(`back ok: ${n} steps, Back after each returned to the step before`);
}
