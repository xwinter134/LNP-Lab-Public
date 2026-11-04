#!/usr/bin/env node
// Hardens the copy of the app that GitHub Pages publishes (.github/workflows/pages.yml), by rewriting its index.html:
//
//   - a Content-Security-Policy that lets only the page's own scripts run: the module files from this site and
//     the inline scripts in index.html (and the frame guard below), named by their SHA-256. Script put into a record (a name, a label, a
//     sample name typed or imported) can then not run even where an escaping slip let it into the page, and the
//     page can talk to no other host, so nothing in a lab could be sent anywhere from it;
//   - no referrer sent with a link that leaves the site;
//   - the page hides itself when another site puts it in a frame (clickjacking: a visitor's clicks landing on
//     "Delete all data" under someone else's buttons). frame-ancestors would say this, but a policy given in a
//     <meta> tag cannot carry it, and GitHub Pages sends no headers of a site's choosing.
//
// Only the published copy: the Mac app loads the same index.html, and its IPC goes through Tauri's own protocol,
// which this policy would block. `npm start` serves the file unchanged.
//
//   node scripts/pages-csp.mjs <folder>     rewrites <folder>/index.html in place (the checkout on the runner)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function harden(html) {
  // The flag this handler sets is read by nothing (the start-up watchdog checks the files itself), and an inline
  // handler would need 'unsafe-hashes'.
  html = html.replace(' onerror="window.__lnpLoadError = true"', '');
  if (!/<meta charset=[^>]*>\n?/i.test(html)) throw new Error('no <meta charset> to put the policy after');
  html = html.replace(/(<meta charset=[^>]*>\n?)/i, `$1${FRAME_GUARD}\n`);
  const inline = inlineScripts(html);
  if (inline.length < 3) throw new Error(`expected the frame guard, the theme script and the start-up watchdog inline, found ${inline.length}`);
  const hashes = inline.map((code) => `'sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}'`);
  if (/\son[a-z]+="/i.test(html)) throw new Error('index.html has an inline event handler, which this policy would block');
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`,
    "style-src 'self' 'unsafe-inline'", // the screens set style="" throughout
    "img-src 'self' data: blob:", // charts saved as images, IVIS images read from the disk
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">\n<meta name="referrer" content="no-referrer">\n`;
  return html.replace(/(<meta charset=[^>]*>\n?)/i, `$1${meta}`);
}

/** Hides the page inside a frame of another site; runs before anything is drawn. */
export const FRAME_GUARD = "<script>if (window.top !== window.self) document.documentElement.style.display = 'none';</script>";

/**
 * The code of every inline script, whatever its attributes (type, id, nonce): a script with a src is a file of
 * this site, which 'self' allows; every other one has to be named by its hash or the policy blocks it.
 */
export function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc\s*=/i.test(m[1])).map((m) => m[2]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scripts/pages-csp.mjs <folder>'); process.exit(2); }
  const file = path.join(dir, 'index.html');
  writeFileSync(file, harden(readFileSync(file, 'utf8')));
  console.log(`${file}: Content-Security-Policy added`);
}
