// The page's own questions in the macOS app (cycle 5 review). tauri-plugin-dialog replaces window.confirm with an
// async function there, so confirm() returns a promise, and a promise read as the answer is always yes: every
// `if (!confirm(…)) return` ran its action whatever was answered, the whole lab deleted included. ask() in
// app/ui/kit.js awaits the answer; these check it, and that no screen asks any other way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { ask } = await import('../app/ui/kit.js');

/** Runs ask() with window.confirm replaced by `confirm`, as the page would see it. */
async function askWith(confirm) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'confirm');
  globalThis.confirm = confirm;
  try { return await ask('Delete ALL data in this browser?'); }
  finally { if (had) Object.defineProperty(globalThis, 'confirm', had); else delete globalThis.confirm; }
}
const later = (v, ms = 20) => new Promise((r) => setTimeout(() => r(v), ms));

test('ask() waits for the dialog plugin\'s answer: Cancel is no, OK is yes', async () => {
  // tauri-plugin-dialog v2, src/init-iife.js: window.confirm = async (m) => 'Ok' === await invoke('plugin:dialog|message', …)
  assert.equal(await askWith(async () => later(false)), false);
  assert.equal(await askWith(async () => later(true)), true);
});

test('ask() takes a browser\'s answer as it is', async () => {
  assert.equal(await askWith(() => false), false);
  assert.equal(await askWith(() => true), true);
});

test('ask() goes ahead only on an explicit yes: no dialog, a failed one or an odd answer is no', async () => {
  assert.equal(await askWith(undefined), false); // no confirm at all
  assert.equal(await askWith(() => undefined), false); // a window that shows nothing
  assert.equal(await askWith(() => { throw new Error('dialog.message not allowed'); }), false);
  assert.equal(await askWith(() => Promise.reject(new Error('dialog.message not allowed'))), false);
  assert.equal(await askWith(() => 'Ok'), false);
});

/* ---------------- every screen asks through ask(), and awaits it ---------------- */

function sources(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
// Comments out, so that the explanations of the bug, which name confirm() and prompt(), are not counted as uses.
// Line comments only where they start a line or follow code after a space, so a URL in a string stays.
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

test('no screen calls confirm() or prompt() itself: questions go through an awaited ask()', () => {
  const found = [];
  for (const file of sources(join(ROOT, 'app'))) {
    const rel = relative(ROOT, file).split(sep).join('/');
    code(readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      const at = `${rel}:${i + 1}: ${line.trim()}`;
      // A bare confirm() reads a promise as yes in the app; prompt() is answered null there at once.
      if (/(^|[^.\w$])(window\.)?(confirm|prompt)\s*\(/.test(line)) found.push(at);
      if (/(^|[^.\w$])ask\s*\(/.test(line) && !/await\s+ask\s*\(/.test(line) && !/function\s+ask\s*\(/.test(line)) found.push(`${at}  (not awaited)`);
    });
  }
  assert.deepEqual(found, []);
});
