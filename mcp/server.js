#!/usr/bin/env node
// LNP Lab's MCP server: lets Claude (Desktop or Code) read old spreadsheets, check them with the app's own rules and,
// after the person approved the quality report, write them into the lab (spec 6). Optional: the app works fully
// without it. Runs locally over stdio and sends nothing over the network itself; Claude, which calls it, reads
// what it returns (see README.md, "Privacy").
//
//   node mcp/server.js [--db <path to lnp-lab.db>] [--out <folder for import files>] [--target auto|sqlite|file] [--personal]
//
// The tools are in ./tools.js; this file only connects them to the MCP SDK.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { createTools } from './tools.js';
import { defaultDbPath } from './lab.js';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
// Claude Desktop passes the settings of the install dialog as environment variables (manifest.json, user_config);
// an empty one means "not set".
const env = (k) => (process.env[k] && process.env[k].trim() ? process.env[k].trim() : undefined);
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

const tools = createTools({
  dbPath: opt('--db', env('LNP_LAB_DB') || defaultDbPath()),
  outDir: opt('--out', env('LNP_LAB_OUT')),
  target: opt('--target', env('LNP_LAB_TARGET') || 'auto'),
  personal: args.includes('--personal') || env('LNP_LAB_PERSONAL') === '1' || env('LNP_LAB_PERSONAL') === 'true' ? true : undefined,
});

const server = new Server({ name: 'lnp-lab', version }, {
  capabilities: { tools: {} },
  instructions: 'LNP Lab import. Read files with read_file, map them to the tables of get_schema and the names of list_catalog, then dry_run_import. Show the quality report to the person and wait for their approval before commit_import. Never fill in a value a sheet does not give. The lab data you read here is sent to Anthropic as part of the conversation.',
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.list() }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const out = await tools.call(req.params.name, req.params.arguments || {});
  const text = out?.markdown ? `${out.markdown}\n\n${JSON.stringify({ ...out, markdown: undefined }, null, 1)}` : JSON.stringify(out, null, 1);
  return { content: [{ type: 'text', text }], isError: out?.ok === false };
});

await server.connect(new StdioServerTransport());
