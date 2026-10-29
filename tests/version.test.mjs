// The version is bumped in one place per file set; this keeps package.json, app/main.js, the Tauri config and Cargo.toml in step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
test('version strings agree', () => {
  const pkg = JSON.parse(read('package.json')).version;
  assert.equal(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(read('app/main.js'))[1], pkg, 'app/main.js APP_VERSION');
  assert.equal(JSON.parse(read('src-tauri/tauri.conf.json')).version, pkg, 'src-tauri/tauri.conf.json');
  assert.equal(/^version = "([^"]+)"/m.exec(read('src-tauri/Cargo.toml'))[1], pkg, 'src-tauri/Cargo.toml');
});
