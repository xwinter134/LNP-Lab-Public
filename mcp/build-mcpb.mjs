#!/usr/bin/env node
// Pack the server as a Claude Desktop extension: an MCP Bundle (.mcpb), the format Claude Desktop installs with a
// double click (https://claude.com/docs/connectors/building/mcpb; the format was called .dxt before). A bundle is a
// zip of manifest.json, the server and everything it needs.
//
//   cd mcp && npm install && node build-mcpb.mjs        → mcp/dist/lnp-lab-<version>.mcpb
//
// The server imports the app's own check from ../app/, so the bundle holds the server under server/ and a copy of
// app/ beside it: the same relative paths as in the repository, and the same code as the app it ships with.
// Packing goes through the official CLI (npx @anthropic-ai/mcpb pack, which also validates the manifest) when it
// can be reached; without a network the zip is written here, deflated, with the same layout.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../app/calc/xlsx.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`manifest.json says ${manifest.version}, package.json ${pkg.version}: make them the same`);
if (!existsSync(join(here, 'node_modules', '@modelcontextprotocol', 'sdk'))) throw new Error('run npm install in mcp/ first: the bundle carries its dependencies');

const out = join(here, 'dist');
const stage = join(out, 'lnp-lab');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });
cpSync(join(here, 'manifest.json'), join(stage, 'manifest.json'));
for (const f of ['server.js', 'tools.js', 'lab.js', 'xlsx.js', 'package.json', 'README.md']) cpSync(join(here, f), join(stage, 'server', f));
cpSync(join(here, 'node_modules'), join(stage, 'server', 'node_modules'), { recursive: true });
cpSync(join(repo, 'app'), join(stage, 'app'), { recursive: true });
// The app's modules are ES modules; without a package.json saying so above them, node would read them as CommonJS.
writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'lnp-lab-mcpb', private: true, type: 'module' }, null, 1));
const icon = join(repo, 'src-tauri', 'icons', 'icon.png');
if (existsSync(icon)) { cpSync(icon, join(stage, 'icon.png')); manifest.icon = 'icon.png'; writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2)); }

const file = join(out, `lnp-lab-${manifest.version}.mcpb`);
let packed = false;
try {
  execFileSync('npx', ['-y', '@anthropic-ai/mcpb', 'pack', stage, file], { stdio: 'inherit', timeout: 180000 });
  packed = existsSync(file);
} catch { console.warn('The MCPB CLI could not be run (no network?); writing the zip here instead.'); }
if (!packed) {
  const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const local = [], central = [];
  let off = 0;
  for (const p of walk(stage)) {
    const raw = readFileSync(p), data = deflateRawSync(raw), name = Buffer.from(relative(stage, p).split('\\').join('/'), 'utf8'), crc = crc32(raw);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    local.push(h, name, data); central.push(c, name); off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  writeFileSync(file, Buffer.concat([...local, cd, end]));
}
console.log(`Wrote ${relative(repo, file)}: double-click it to install in Claude Desktop.`);
