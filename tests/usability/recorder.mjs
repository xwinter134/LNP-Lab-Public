// Records a usability session: every click, keystroke batch, navigation and read, with how long it took the
// robot and how long it would take a person (a keystroke-level estimate), plus the observations made along
// the way and the feature probes that score the session. Writes actions.jsonl, summary.json and screenshots.
import fs from 'node:fs';
import path from 'node:path';

// Keystroke-level estimates for a person at the bench computer, in seconds. Deliberately plain: pointing and
// clicking a target ~1.5 s with the decision folded in, typing 0.3 s a character after 1.2 s to find the
// field, opening a dropdown and choosing ~2.5 s, landing on a new screen and reading it ~4 s.
const KLM = { click: 1.5, fillBase: 1.2, perChar: 0.3, select: 2.5, nav: 4, read: 3, upload: 8, paste: 6, download: 3, check: 1.2, wait: 0 };

export class Recorder {
  constructor(page, outDir, meta = {}) {
    this.page = page; this.out = outDir; this.meta = meta;
    this.t0 = Date.now(); this.log = []; this.notes = []; this.probes = []; this.tasks = [];
    this.task = null; this.shotN = 0; this.pageErrors = [];
    fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });
    this.stream = fs.createWriteStream(path.join(outDir, 'actions.jsonl'));
    page.on('pageerror', (e) => this.pageErrors.push({ task: this.task?.id, text: 'pageerror: ' + e.message }));
    page.on('console', (m) => { if (m.type() === 'error') this.pageErrors.push({ task: this.task?.id, text: 'console: ' + m.text() }); });
    page.on('dialog', async (d) => { this.write({ action: 'dialog', target: d.type(), label: d.message().slice(0, 160), est_s: 2.5, ok: true, dur_ms: 0 }); await d.accept(); });
  }

  hash() { try { return decodeURIComponent(new URL(this.page.url()).hash); } catch { return ''; } }

  write(rec) {
    const r = { i: this.log.length + 1, t_ms: Date.now() - this.t0, task: this.task?.id || null, hash: this.hash(), ...rec };
    this.log.push(r); this.stream.write(JSON.stringify(r) + '\n');
    if (this.task) { this.task.actions++; this.task.est_s += r.est_s || 0; if (!r.ok) this.task.errors++; }
    return r;
  }

  /** Run one logged action. `fn` does the work; a failure is logged and rethrown so the task can decide. */
  async act(action, target, label, value, fn, est_s) {
    const t = Date.now();
    try {
      const res = await fn();
      this.write({ action, target, label, value, ok: true, dur_ms: Date.now() - t, est_s });
      return res;
    } catch (err) {
      this.write({ action, target, label, value, ok: false, dur_ms: Date.now() - t, est_s, err: String(err.message || err).split('\n')[0].slice(0, 300) });
      throw err;
    }
  }

  // ---- the vocabulary a session is written in ----
  async go(hash, label = '') { return this.act('nav', '#/' + hash, label || hash, null, async () => { await this.page.goto(this.meta.base + '#/' + hash); await this.settle(); }, KLM.nav); }
  async menu(id, label) { return this.act('nav', `nav a[href="#/${id}"]`, label || id, null, async () => { await this.page.click(`nav a[href="#/${id}"]`); await this.settle(); }, KLM.nav); }
  async click(sel, label, opts = {}) { return this.act('click', sel, label, null, async () => { await this.page.locator(sel).first().click({ timeout: 4000 }); await this.settle(opts.wait ?? 250); }, KLM.click); }
  async clickText(text, label, scope = '#main') { return this.act('click', `text=${text}`, label || text, null, async () => { await this.page.locator(scope).getByText(text, { exact: false }).first().click({ timeout: 4000 }); await this.settle(); }, KLM.click); }
  async fill(sel, value, label) {
    return this.act('fill', sel, label, String(value), async () => {
      const loc = this.page.locator(sel).first();
      await loc.fill(String(value), { timeout: 4000 });
      await loc.dispatchEvent('change');
      await this.page.waitForTimeout(60);
    }, KLM.fillBase + KLM.perChar * String(value).length);
  }
  async select(sel, value, label) { return this.act('select', sel, label, String(value), async () => { await this.page.selectOption(sel, String(value), { timeout: 4000 }); await this.page.locator(sel).first().dispatchEvent('change'); await this.settle(150); }, KLM.select); }
  /** Choose a dropdown entry by the text a person would read in it. */
  async selectByText(sel, text, label) {
    return this.act('select', sel, label, text, async () => {
      const v = await this.page.locator(`${sel} option`, { hasText: text }).first().getAttribute('value', { timeout: 4000 });
      await this.page.selectOption(sel, v); await this.page.locator(sel).first().dispatchEvent('change'); await this.settle(150);
    }, KLM.select);
  }
  async check(sel, on, label) { return this.act('check', sel, label, String(on), async () => { const l = this.page.locator(sel).first(); if (on) await l.check(); else await l.uncheck(); await this.settle(120); }, KLM.check); }
  async upload(sel, file, label) { return this.act('upload', sel, label, file.name, async () => { await this.page.setInputFiles(sel, file); await this.settle(500); }, KLM.upload); }
  async paste(sel, text, label) { return this.act('paste', sel, label, `${text.split('\n').length} lines`, async () => { await this.page.fill(sel, text); await this.settle(80); }, KLM.paste); }
  async download(sel, label) {
    return this.act('download', sel, label, null, async () => {
      const [dl] = await Promise.all([this.page.waitForEvent('download', { timeout: 5000 }), this.page.locator(sel).first().click()]);
      const p = path.join(this.out, 'downloads', dl.suggestedFilename());
      fs.mkdirSync(path.dirname(p), { recursive: true }); await dl.saveAs(p); return p;
    }, KLM.download);
  }
  /** Reading the screen to find something out. Returns the text; costs a person a few seconds. */
  async read(sel = '#main', label = 'read') {
    // Reading costs what is on the screen: skimming about a third of it at 250 words a minute, 3 s minimum,
    // a minute at most. A dense results page costs a person far more than a short form does.
    const t = Date.now();
    try {
      const text = await this.page.locator(sel).first().innerText({ timeout: 4000 });
      const words = text.split(/\s+/).length;
      this.write({ action: 'read', target: sel, label, value: `${words} words`, ok: true, dur_ms: Date.now() - t, est_s: Math.min(60, Math.max(KLM.read, (words * 0.33 / 250) * 60)) });
      return text;
    } catch (err) {
      this.write({ action: 'read', target: sel, label, ok: false, dur_ms: Date.now() - t, est_s: KLM.read, err: String(err.message || err).split('\n')[0].slice(0, 300) });
      throw err;
    }
  }
  async exists(sel) { return (await this.page.locator(sel).count()) > 0; }
  async settle(ms = 250) { await this.page.waitForTimeout(ms); }

  async shot(name, { full = false } = {}) {
    const file = `${String(++this.shotN).padStart(2, '0')}-${name}.jpg`;
    await this.page.screenshot({ path: path.join(this.out, 'shots', file), type: 'jpeg', quality: 55, fullPage: full });
    this.write({ action: 'screenshot', target: file, label: name, ok: true, dur_ms: 0, est_s: 0 });
    return file;
  }

  /** An observation a person would make: friction, bug, calc check, wish or something that worked well. */
  note(kind, text, severity = 'minor') { this.notes.push({ task: this.task?.id, kind, severity, text }); }

  /** A feature expectation, scored pass/fail every cycle so improvement is measurable. */
  probe(id, text, pass, detail = '') { this.probes.push({ id, task: this.task?.id, text, pass: !!pass, detail }); }

  async runTask(id, title, persona, fn) {
    this.task = { id, title, persona, actions: 0, errors: 0, est_s: 0, ok: true, err: null, t_ms: 0 };
    const t = Date.now(); const errsBefore = this.pageErrors.length;
    try { await fn(); }
    catch (err) {
      this.task.ok = false; this.task.err = String(err.message || err).split('\n')[0].slice(0, 300);
      try { await this.shot(`${id}-FAILED`); } catch {}
    }
    this.task.t_ms = Date.now() - t;
    this.task.pageErrors = this.pageErrors.slice(errsBefore).map((e) => e.text);
    this.tasks.push(this.task);
    const tag = this.task.ok ? 'ok ' : 'FAIL';
    console.log(`${tag} ${id} ${title} · ${this.task.actions} actions · ~${Math.round(this.task.est_s / 60 * 10) / 10} min${this.task.err ? ' · ' + this.task.err : ''}`);
    this.task = null;
  }

  finish(extra = {}) {
    this.stream.end();
    const count = (a) => this.log.filter((r) => r.action === a).length;
    // A probe checked several times (every import, say) passes only if it passed every time.
    const byId = new Map();
    for (const p of this.probes) { const q = byId.get(p.id); byId.set(p.id, q ? { ...q, pass: q.pass && p.pass, detail: [q.detail, p.detail].filter(Boolean).join('; '), checks: q.checks + 1 } : { ...p, checks: 1 }); }
    const probes = [...byId.values()];
    const summary = {
      ...this.meta, finishedAt: new Date().toISOString(), wall_s: Math.round((Date.now() - this.t0) / 1000),
      est_human_min: Math.round(this.log.reduce((s, r) => s + (r.est_s || 0), 0) / 6) / 10,
      actions: this.log.length, clicks: count('click'), fills: count('fill'), selects: count('select'), navs: count('nav'), reads: count('read'),
      chars_typed: this.log.filter((r) => r.action === 'fill').reduce((s, r) => s + (r.value || '').length, 0),
      failed_actions: this.log.filter((r) => !r.ok).length,
      tasks: this.tasks, tasks_ok: this.tasks.filter((t) => t.ok).length, tasks_total: this.tasks.length,
      probes, probes_pass: probes.filter((p) => p.pass).length, probes_total: probes.length,
      notes: this.notes, pageErrors: this.pageErrors, ...extra,
    };
    fs.writeFileSync(path.join(this.out, 'summary.json'), JSON.stringify(summary, null, 2));
    return summary;
  }
}
