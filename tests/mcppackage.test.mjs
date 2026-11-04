// The MCP server as an npm package (spec 6.6): a bin that npx runs, the files it ships, and the manifest of the
// Claude Desktop bundle in step with it. Packing itself (mcp/build-npm.mjs) needs npm and the SDK; this checks
// what the package is made of.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const mcp = new URL('../mcp/', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', mcp), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('manifest.json', mcp), 'utf8'));

test('mcp/package.json is a package npx can run: no private, a bin to server.js, its files, Node 22.13', () => {
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.name, 'lnp-lab-mcp');
  assert.deepEqual(pkg.bin, { 'lnp-lab-mcp': 'server.js' });
  for (const f of pkg.files) assert.ok(existsSync(new URL(f, mcp)), `${f} is listed and there`);
  assert.ok(pkg.files.includes('server.js') && pkg.files.includes('tools.js') && pkg.files.includes('lab.js'));
  assert.match(readFileSync(new URL('server.js', mcp), 'utf8'), /^#!\/usr\/bin\/env node\n/);
  assert.equal(pkg.engines.node, '>=22.13.0');
  assert.equal(manifest.version, pkg.version, 'the bundle and the package carry one version');
  assert.match(pkg.scripts.prepack, /--refuse/, 'packing mcp/ alone, without the app beside it, is stopped');
  // Every import of the app the server makes resolves inside the repository's app/, which the package carries.
  for (const f of ['tools.js', 'lab.js', 'server.js']) {
    for (const [, p] of readFileSync(new URL(f, mcp), 'utf8').matchAll(/from '(\.\.\/app\/[^']+)'/g)) assert.ok(existsSync(new URL(p, mcp)), `${f} imports ${p}`);
  }
});
