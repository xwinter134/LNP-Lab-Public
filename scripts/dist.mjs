// Copies the web app into dist/ for the Tauri bundle (no build step otherwise).
//
//   node scripts/dist.mjs [--personal]
//
// --personal makes Gholan's own build (spec 10): app/build.js in the copy says PERSONAL_BUILD = true, which offers
// the setting "Claude insights". The public build leaves it false.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('index.html', 'dist/index.html');
cpSync('app', 'dist/app', { recursive: true });
if (process.argv.includes('--personal')) {
  const f = 'dist/app/build.js';
  const src = readFileSync(f, 'utf8');
  const out = src.replace(/export const PERSONAL_BUILD = false;/, 'export const PERSONAL_BUILD = true;');
  if (out === src) throw new Error('app/build.js no longer says "export const PERSONAL_BUILD = false;": update scripts/dist.mjs');
  writeFileSync(f, out);
}
console.log(`dist/ ready${process.argv.includes('--personal') ? ' (personal build)' : ''}`);
