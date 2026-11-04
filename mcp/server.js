#!/usr/bin/env node
// LNP Lab's MCP server: lets Claude (Desktop or Code) read old spreadsheets, check them with the app's own rules and,
// after the person approved the quality report, write them into the lab (spec 6). Optional: the app works fully
// without it. Runs locally over stdio and sends nothing over the network itself; Claude, which calls it, reads
// what it returns (see README.md, "Privacy").
//
//   node mcp/server.js [--db <path to lnp-lab.db>] [--out <folder for import files>] [--backup <backup .json>]
//                      [--target auto|sqlite|file] [--personal] [--allow-import]
//   npx lnp-lab-mcp …   (the same, from the npm package; its bin)
//
// The tools are in ./tools.js; this file connects them to the MCP SDK, and gives them the two things only the
// SDK side has: asking the person through the client (elicitation, for commit_import's approval), and a place to
// show a confirmation code out of Claude's sight when the client cannot ask (a macOS notification).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTools, formatResult } from './tools.js';
import { defaultDbPath } from './lab.js';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

/**
 * A confirmation code shown where the person sees it and Claude does not: a notification of macOS (osascript,
 * local, no network). Elsewhere, or when it fails, false: the code then goes with the dry run's answer, in the
 * part addressed to the person (tools.js says how much weaker that is).
 */
export function notify(code, text) {
  if (platform() !== 'darwin') return false;
  try {
    const say = (s) => JSON.stringify(String(s)); // AppleScript string literals take JSON's escaping of " and \
    execFileSync('/usr/bin/osascript', ['-e', `display notification ${say(text)} with title "LNP Lab import" subtitle ${say(`Confirmation code ${code}`)}`], { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/**
 * The MCP server over the tools. `config` as createTools takes it; `showCode` defaults to notify. The client's
 * capabilities are known once it has connected, so whether it can ask the person is asked at each dry run.
 */
export function makeServer(config = {}) {
  let server;
  const tools = createTools({
    showCode: notify,
    ...config,
    canConfirm: () => !!server.getClientCapabilities()?.elicitation,
    confirm: (params) => server.elicitInput({ mode: 'form', ...params }, { timeout: 10 * 60e3 }),
  });
  server = new Server({ name: 'lnp-lab', version }, {
    capabilities: { tools: {} },
    instructions: 'LNP Lab import. Read files with read_file, map them to the tables of get_schema and the names of list_catalog, then dry_run_import. Show the quality report to the person and wait for their approval before commit_import: the server then asks them itself, or needs the confirmation code shown to them, which only they can type. Never fill in a value a sheet does not give. The lab data you read here is sent to Anthropic as part of the conversation; tell the person so at the start.',
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => formatResult(await tools.call(req.params.name, req.params.arguments || {})));
  return { server, tools };
}

// Run when started as a program (node server.js, or the npm bin, which is a link to this file).
const self = fileURLToPath(import.meta.url);
let started = false;
try { started = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self); } catch {}
if (started) {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  // Claude Desktop passes the settings of the install dialog as environment variables (manifest.json, user_config);
  // an empty one means "not set".
  const env = (k) => (process.env[k] && process.env[k].trim() ? process.env[k].trim() : undefined);
  const on = (k) => env(k) === '1' || env(k) === 'true';
  const { server } = makeServer({
    dbPath: opt('--db', env('LNP_LAB_DB') || defaultDbPath()),
    outDir: opt('--out', env('LNP_LAB_OUT')),
    backupPath: opt('--backup', env('LNP_LAB_BACKUP')),
    target: opt('--target', env('LNP_LAB_TARGET') || 'auto'),
    personal: args.includes('--personal') || on('LNP_LAB_PERSONAL') ? true : undefined,
    allowImport: args.includes('--allow-import') || on('LNP_LAB_ALLOW_IMPORT') ? true : undefined,
  });
  await server.connect(new StdioServerTransport());
}
