# LNP Lab MCP server

An optional, local server that lets Claude (Claude Desktop or Claude Code) bring old Excel and CSV data into
LNP Lab, and, in the personal build, read the lab for an insights report. LNP Lab works fully without it.

## Privacy

*Draft wording, to be replaced by the lab's own text (spec 11.2).*

With this server, **Claude reads your lab data**: the files you give it and what the LNP Lab tools return from
your lab. That data is **sent to Anthropic**, which runs Claude, as part of your conversation, under the terms of
your Claude account. **The server itself sends nothing over the network**: it is only a local bridge that reads
and writes the LNP Lab database on this Mac and the files you name. Many labs treat formulation data as
confidential, and some do not allow AI tools at all: check before you use it. Both modules (the import and Claude
insights) are off in the app until switched on in Settings › Claude, and the app is fully usable without them.

## What it does

Claude does the fuzzy part, the server the strict part (spec 6.1):

1. **Claude reads** your files (`read_file`: every sheet of an .xlsx or a .csv, raw rows with row numbers), looks
   up the fields (`get_schema`) and what the lab already has (`list_catalog`), and maps the columns.
2. **`dry_run_import`** checks every mapped row with the app's own rules (`app/calc/importcheck.js`, the same code
   the app and `scripts/import-tidy.mjs` use) and returns a **quality report**: rows read, importable, refused with
   the reason ("lipid name … is unknown", "pdi 8.5 is outside 0–1, probably a typing slip"), duplicates, and the
   completeness of each field as the Data overview shows it. Nothing is written.
3. **You read the report** and tell Claude to go ahead.
4. **`commit_import`** writes it, only with the approval token of that dry run: bound to the exact rows and the
   hashes of their files, good once, for 30 minutes, and void if the lab changed in between. Every record carries
   its provenance: `source: 'mcp-import'`, file name and SHA-256, sheet, row, import id and time.
5. Refused rows go to the app's **Quarantine**, where you fill in what is missing and check them again. Every
   import is listed under **Settings › Imports**, where **Undo import** moves it whole into the trash, from where
   Restore puts it back (`rollback_import` does the same from Claude). The same row of the same file is never
   imported twice.

Other tools: `quality_report` (one import or the whole lab), `list_imports`. In the personal build (Settings ›
Claude insights, or `LNP_LAB_PERSONAL=1`): `summarize_database`, `query_formulations` (the Data overview's
filters), `get_trends` (the Insights screen's analyses), `get_optimizer_state`, and `save_insight_report`, which
stores a report the Insights screen shows with its date and data state. Each finding must name the analysis it
came from and the formulations it rests on; Claude interprets, the app computes.

## When it writes, and where

- **macOS app**: into its database, `~/Library/Application Support/org.lnplab.app/lnp-lab.db`, **only while LNP
  Lab is closed**. The app holds every record in memory while it runs and saves whole lists, so anything written
  under it would be lost with its next save. The server tells it is running by the lock file the app keeps beside
  the database (`lnp-lab.app.lock`, with its process id) and, on macOS, the process list; it asks you to quit the
  app (Cmd+Q) and try again. The write is one SQLite transaction, so an app started meanwhile waits for it and
  then reads the finished import. As a last line, the app makes each of its saves conditional on the database not
  having been changed by the server since it opened it; if that ever happens, it stores nothing and asks for a
  reload instead of writing over the import.
- **Browser version**: its records live in the browser, out of reach. `commit_import` writes an import file into
  your Downloads folder (or `LNP_LAB_OUT`); read it in under **Settings & export › Backup & restore › Import
  JSON**, with "replace instead of merge" left unticked. Give `first_experiment`, the number after your newest
  experiment, so the new numbers do not collide with yours.

## Install

Needs Node.js 22.13 or later (it uses `node:sqlite`). Claude Desktop brings its own Node; for Claude Code, use the
one on your Mac.

### From the repository (first testers)

```bash
git clone https://github.com/xwinter134/LNP-LAB.git
cd LNP-LAB/mcp && npm install
```

**Claude Desktop**: Settings › Developer › Edit Config, and add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lnp-lab": {
      "command": "node",
      "args": ["--no-warnings", "/Users/you/LNP-LAB/mcp/server.js"]
    }
  }
}
```

Restart Claude Desktop. Options as environment variables (`"env": { … }` beside `"args"`): `LNP_LAB_DB` (another
database file), `LNP_LAB_OUT` (folder for import files), `LNP_LAB_TARGET` (`sqlite` or `file`),
`LNP_LAB_PERSONAL=1` (the insights tools).

**Claude Code**:

```bash
claude mcp add lnp-lab -- node --no-warnings /Users/you/LNP-LAB/mcp/server.js
# with options:
claude mcp add lnp-lab -e LNP_LAB_PERSONAL=1 -- node --no-warnings /Users/you/LNP-LAB/mcp/server.js
```

### As a Claude Desktop extension (wider beta)

Claude Desktop installs local servers as **MCP Bundles** (`.mcpb`, formerly `.dxt`): a zip of the server and a
`manifest.json`, installed with a double click
([format](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md),
[Claude docs](https://claude.com/docs/connectors/building/mcpb)). To build one:

```bash
cd mcp && npm install && node build-mcpb.mjs
```

It writes `mcp/dist/lnp-lab-<version>.mcpb`, packed with the official CLI (`npx @anthropic-ai/mcpb pack`) when
it can be reached. Double-click it, or drag it into Claude Desktop, or Settings › Extensions › Advanced settings ›
Install Extension. The install dialog shows the privacy text above and asks for the database file (the usual place
is filled in), the folder for import files, and whether to add the insights tools.

## Ask Claude

> Here are my old formulation sheets: `/Users/me/Lab/FRR screen 2024.xlsx`. Read every sheet, tell me which
> columns you would map to which LNP Lab field and what is unclear, then run a dry run and show me the report.
> Do not fill in any value the sheet does not give. Commit only after I say so.

## Tests

`node --test tests/mcp.test.mjs` from the repository root drives every tool against a database made for the test.
The MCP SDK is only needed to run the server itself.
