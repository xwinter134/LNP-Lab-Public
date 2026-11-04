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

The same note comes with the **first answer of every session**, whichever tool Claude calls first, and Claude is
told to pass it on before it goes further. It is also in the install dialog of the Claude Desktop extension.

**The app's switch is honoured.** While **Import with Claude** is off in the lab (Settings › Claude (optional), the
`mcpImport` setting, off by default), `commit_import` and `rollback_import` refuse with a message that says where
to switch it on; reading and dry runs still work. To allow writing regardless, start the server explicitly with
`LNP_LAB_ALLOW_IMPORT=1` (or `--allow-import`). When there is no lab to read the setting from (the browser version
without a backup file), the import file is allowed: you read it in yourself.

## What it does

Claude does the fuzzy part, the server the strict part (spec 6.1):

1. **Claude reads** your files (`read_file`: every sheet of an .xlsx or a .csv, raw rows with row numbers), looks
   up the fields (`get_schema`) and what the lab already has (`list_catalog`), and maps the columns.
2. **`dry_run_import`** checks every mapped row with the app's own rules (`app/calc/importcheck.js`, the same code
   the app and `scripts/import-tidy.mjs` use) and returns a **quality report**: rows read, importable, refused with
   the reason ("lipid name … is unknown", "pdi 8.5 is outside 0–1, probably a typing slip"), duplicates, and the
   completeness of each field as the Data overview shows it. Nothing is written.
3. **You read the report** and approve it yourself (see "Approval" below): Claude cannot approve for you.
4. **`commit_import`** writes it, only with the approval token of that dry run: bound to the exact rows and the
   hashes of their files, good once, for 30 minutes, and void if the lab changed in between. Every record carries
   its provenance: `source: 'mcp-import'`, file name and SHA-256, sheet, row, import id and time.
5. Refused rows go to the app's **Quarantine**, where you fill in what is missing and check them again. Every
   import is listed under **Settings › Imports**, where **Undo import** moves it whole into the trash, from where
   Restore puts it back (`rollback_import` does the same from Claude). The same row of the same file is never
   imported twice.

Biological data (spec 8.3) comes the same way, in two more tables, `studies` (one row per group, with its role
reference, test or negative and its formulation) and `bioMeasurements` (raw values per animal or well); see
`docs/HISTORICAL-DATA.md`.

Other tools: `quality_report` (one import or the whole lab), `list_imports`. For the browser version, whose lab
the server cannot reach, both take `backup`: the path of a file saved with **Settings & export › Export
everything**; or start the server with `LNP_LAB_BACKUP=<that file>` (`--backup`), and the dry run then also numbers
after that lab and sees its duplicates (export a fresh one before each import). In the personal build (Settings ›
Claude insights, or `LNP_LAB_PERSONAL=1`): `summarize_database`, `query_formulations` (the Data overview's
filters), `get_trends` (the Insights screen's analyses), `get_optimizer_state`, and `save_insight_report`, which
stores a report the Insights screen shows with its date and data state. Each finding must name the analysis it
came from and the formulations it rests on; Claude interprets, the app computes.

## Approval

A dry run returns an approval token, but a token only proves that a dry run happened: Claude holds it and could
commit the moment the report comes back. So `commit_import` also needs **you**, by the strongest way your client
offers (spec 6.4 and 12.2, "never writes without dry run and approval"):

1. **The client asks you.** When the client supports MCP elicitation (it declares the `elicitation`
   capability), the server asks it to put the question to you in a dialog of its own: "Write import imp-… into
   LNP Lab? 5 formulations, 7 measurements, 3 rows to quarantine". Only **accept** with **Yes, write this import**
   ticked writes; decline voids the dry run, closing the dialog writes nothing and can be asked again. Claude does
   not see or answer this dialog.
2. **You type a code.** Otherwise the dry run makes a random confirmation code (like `K7Q-M3X`) that you type to
   Claude, and Claude passes it on. On a Mac the code appears in a **notification** and is not in anything Claude
   reads. Where no notification can be shown, it comes with the report in a part of the answer marked for you
   (MCP annotation `audience: ["user"]`) and is left out of the part for Claude. Claude is told never to copy or
   guess it, and three wrong codes void the dry run. This second path is weaker: a client may still show the part
   marked for you to the model, and then only Claude's instructions stand between it and the code. Use a client
   with elicitation, or the Mac notification, where it matters.

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
database file), `LNP_LAB_OUT` (folder for import files), `LNP_LAB_BACKUP` (a backup file of the browser version, read
as its lab), `LNP_LAB_TARGET` (`sqlite` or `file`), `LNP_LAB_PERSONAL=1` (the insights tools),
`LNP_LAB_ALLOW_IMPORT=1` (write even while Import with Claude is off in the app).

**Claude Code**:

```bash
claude mcp add lnp-lab -- node --no-warnings /Users/you/LNP-LAB/mcp/server.js
# with options:
claude mcp add lnp-lab -e LNP_LAB_PERSONAL=1 -- node --no-warnings /Users/you/LNP-LAB/mcp/server.js
```

### As an npm package (`npx`)

The server is also an npm package, `lnp-lab-mcp`, whose command `lnp-lab-mcp` starts it. It is not published
yet; build the package file from the repository:

```bash
cd mcp && npm install && npm run pack:npm      # writes mcp/dist/lnp-lab-mcp-<version>.tgz
npx -y ./dist/lnp-lab-mcp-0.1.0.tgz             # runs it once, to try (it waits for a client on stdin)
```

The package holds `mcp/` and a copy of `app/` side by side, because the server checks with the app's own code
(`mcp/build-npm.mjs` says why `npm pack` straight in `mcp/` is stopped). Once it is published (`npm publish
mcp/dist/lnp-lab-mcp-<version>.tgz`, a decision for the lab), Claude Code takes it as

```bash
claude mcp add lnp-lab -- npx -y lnp-lab-mcp
```

and Claude Desktop as `"command": "npx", "args": ["-y", "lnp-lab-mcp"]` in `claude_desktop_config.json`. Until
then, put the path of the .tgz file in place of `lnp-lab-mcp`. Options as above, as environment variables or as
`--db`, `--out`, `--backup`, `--target`, `--personal`, `--allow-import`.

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

## Why insights go through this server, and not a Claude sign-in in the app

Spec 10.1 asks first whether LNP Lab could sign in with the person's own Claude account instead of an API key. It
cannot. Anthropic's legal and compliance page for Claude Code
(<https://code.claude.com/docs/en/legal-and-compliance>, section "Authentication and credential use", read on
2026-10-31) says:

> "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to
> route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users."

So the insights run the other way round: the person asks Claude Desktop or Claude Code, signed in to their own
account by Anthropic's own flow, and Claude reads the lab through these tools. The app holds no Claude credential.

## Ask Claude

> Here are my old formulation sheets: `/Users/me/Lab/FRR screen 2024.xlsx`. Read every sheet, tell me which
> columns you would map to which LNP Lab field and what is unclear, then run a dry run and show me the report.
> Do not fill in any value the sheet does not give. Commit only after I say so.

## Tests

`node --test tests/mcp.test.mjs tests/mcpapproval.test.mjs tests/mcppackage.test.mjs` from the repository root
drives every tool against a database made for the test, the approval paths, the privacy note, the app's switch and
a backup file. The MCP SDK is only needed to run the server itself; with it installed in `mcp/`, one test also runs
the real server over the SDK's in-memory transport, with a client that answers the confirmation dialog.
