#!/usr/bin/env node
// Pack the server as an npm package (spec 6.6, "alternatively as an npm package"): mcp/dist/lnp-lab-mcp-<version>.tgz,
// which `npx` runs as `lnp-lab-mcp` and `npm publish <tgz>` would publish. Nothing is published from here.
//
//   cd mcp && npm install && npm run pack:npm
//
// Why a staged folder and not `npm pack` in mcp/: the server imports the app's own check from ../app/ (spec 6.2,
// "app and import never run apart"), and an npm package cannot carry files from outside its folder. So the
// package holds the repository's layout, mcp/ and app/ side by side, the same relative paths and the same code
// as the app it ships with, as the Claude Desktop bundle does (build-mcpb.mjs). mcp/package.json is the source
// of its name, version, bin, files and dependency; `npm pack` straight in mcp/ is stopped by its prepack script,
// because that package would lack app/.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

if (process.argv.includes('--refuse')) {
  if (process.env.LNP_LAB_STAGED === '1') process.exit(0);
  console.error('Do not pack mcp/ directly: the package needs the app\'s code beside it. Run: npm run pack:npm');
  process.exit(1);
}

const out = join(here, 'dist');
const stage = join(out, 'npm');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'mcp'), { recursive: true });
// package.json too: the server reads its version from it, and it says the folder's .js files are ES modules.
for (const f of [...pkg.files, 'package.json']) cpSync(join(here, f), join(stage, 'mcp', f));
// The app's modules the server reads (app/calc, app/data, the store and its neighbours), without the screens' assets.
cpSync(join(repo, 'app'), join(stage, 'app'), { recursive: true, filter: (p) => !/[\\/]app[\\/](assets|learn)([\\/]|$)/.test(p) });
for (const f of ['LICENSE', 'NOTICE.md']) if (existsSync(join(repo, f))) cpSync(join(repo, f), join(stage, f));
cpSync(join(here, 'README.md'), join(stage, 'README.md'));
const staged = {
  name: pkg.name, version: pkg.version, description: pkg.description, license: pkg.license, type: 'module',
  bin: Object.fromEntries(Object.entries(pkg.bin).map(([k, v]) => [k, `mcp/${v}`])),
  files: [...pkg.files.map((f) => `mcp/${f}`), 'mcp/package.json', 'app/', 'LICENSE', 'NOTICE.md', 'README.md'],
  engines: pkg.engines, dependencies: pkg.dependencies, repository: pkg.repository, keywords: pkg.keywords,
};
writeFileSync(join(stage, 'package.json'), JSON.stringify(staged, null, 2) + '\n');
const file = execFileSync('npm', ['pack', '--pack-destination', out], { cwd: stage, encoding: 'utf8', env: { ...process.env, LNP_LAB_STAGED: '1' } }).trim().split('\n').pop();
console.log(`Wrote ${relative(repo, join(out, file))}. Try it: npx -y ${relative(process.cwd(), join(out, file))} (it waits for a client on stdin).`);
