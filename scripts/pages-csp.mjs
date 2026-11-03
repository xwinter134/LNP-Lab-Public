#!/usr/bin/env node
// Hardens the copy of the app that GitHub Pages publishes (.github/workflows/pages.yml), by rewriting its index.html:
//
//   - a Content-Security-Policy that lets only the page's own scripts run: the module files from this site and
//     the two inline scripts in index.html, named by their SHA-256. Script put into a record (a name, a label, a
//     sample name typed or imported) can then not run even where an escaping slip let it into the page, and the
//     page can talk to no other host, so nothing in a lab could be sent anywhere from it;
//   - no referrer sent with a link that leaves the site.
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
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  if (hashes.length < 2) throw new Error(`expected the theme script and the start-up watchdog inline, found ${hashes.length}`);
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
  if (!/<meta charset=[^>]*>\n?/i.test(html)) throw new Error('no <meta charset> to put the policy after');
  return html.replace(/(<meta charset=[^>]*>\n?)/i, `$1${meta}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scripts/pages-csp.mjs <folder>'); process.exit(2); }
  const file = path.join(dir, 'index.html');
  writeFileSync(file, harden(readFileSync(file, 'utf8')));
  console.log(`${file}: Content-Security-Policy added`);
}
