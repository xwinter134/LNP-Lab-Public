// Settings › Claude (optional) and Settings › Imports: the switches for the two modules that let Claude read the
// lab (the MCP import, spec 6, and Claude insights, spec 10, the latter only in the personal build), what they
// mean for privacy (spec 11.2), and the list of table imports, each with "Undo import" (spec 6.5).
//
// Both modules are off by default, and with both off and no import on record nothing here is drawn: the
// Settings screen looks as it did. The import list also shows with the module off once an import is on record
// (one read in with scripts/import-tidy.mjs's file, say), since undoing it must stay possible.
import { esc, table, raw, chip, toast, ask, fmtDate } from './kit.js';
import { getSettings } from '../refdata.js';
import { personalBuildAvailable } from '../build.js';
import { listImports, rollbackImport } from '../calc/importops.js';

/*
 * DRAFT WORDING. Gholan writes the final text of this notice (spec 11.2); it is shown in Settings, the first time
 * a module is switched on, and repeated in mcp/README.md and mcp/manifest.json. Keep the three saying the same.
 */
export const PRIVACY_NOTE = 'With this switched on, Claude reads your lab data: the files you give it and what the LNP Lab tools return from this lab. That data is sent to Anthropic, which runs Claude, as part of your conversation, under the terms of your Claude account. The LNP Lab server itself sends nothing over the network: it is only a local bridge between Claude and this app\'s records. Many labs treat formulation data as confidential, and some do not allow AI tools: check before you use it. LNP Lab works fully without it.';

const MODULES = [
  { key: 'mcpImport', label: 'Import with Claude (MCP server)', say: 'Claude Desktop or Claude Code reads old spreadsheets and, after you approve its quality report, adds them to this lab. Set up the server as mcp/README.md says.' },
  { key: 'personalBuild', label: 'Claude insights', say: 'Claude reads the lab through the same server and writes a report of the main findings, shown on Insights.', personal: true },
];

/** The "Claude (optional)" card and the imports card, as HTML for the Settings screen. */
export function claudeCards(ctx) {
  const s = getSettings(ctx);
  const mods = MODULES.filter((m) => !m.personal || personalBuildAvailable());
  const anyOn = mods.some((m) => s[m.key] === true);
  const imports = listImports(ctx.store);
  const card = `<div class="card" id="claudeCard"><h2>Claude (optional)</h2>
    ${mods.map((m) => `<div style="margin:6px 0"><label style="display:flex;align-items:center;gap:8px;font-weight:500;color:var(--ink)"><input type="checkbox" data-module="${m.key}" style="width:auto"${s[m.key] === true ? ' checked' : ''}> ${esc(m.label)}</label>
      <p class="muted small" style="margin:2px 0 0 26px">${esc(m.say)}</p></div>`).join('')}
    ${anyOn ? `<p class="note" id="privacyNote">${esc(PRIVACY_NOTE)}</p>` : '<p class="muted">Off unless you switch it on. Nothing in LNP Lab needs it.</p>'}</div>`;
  const showImports = s.mcpImport === true || imports.length > 0;
  return card + (showImports ? importsCard(imports) : '');
}

function importsCard(imports) {
  const rows = imports.map((i) => {
    const n = i.state.live;
    const where = i.state.inLab ? chip('in the lab', 'ok') : i.state.trash.length ? chip('in the trash', 'warn') : chip('empty');
    const files = Array.isArray(i.files) && i.files.length ? i.files.map((f) => f.name).join(', ') : i.fileName || '–';
    return {
      attrs: `data-import="${esc(i.id)}"`,
      cells: [fmtDate(String(i.importedAt || '').slice(0, 10)), raw(`<b>${esc(i.id)}</b><div class="muted">${esc(files)} · ${i.kind === 'mcp' ? 'with Claude' : 'from tables'}</div>`),
        `${n.batches} formulations, ${n.measurements} results`, raw(i.quarantineOpen ? `<a href="#/quarantine?import=${encodeURIComponent(i.id)}">${i.quarantineOpen} open</a>` : '–'), raw(where),
        raw(i.state.inLab ? `<button type="button" data-undo-import="${esc(i.id)}" style="padding:4px 10px">Undo import</button>` : '')],
    };
  });
  return `<div class="card" id="importsCard"><h2>Imports</h2>
    ${table(['Imported', 'Import', 'In the lab now', 'Quarantine', 'Where', ''], rows, { empty: 'No imports of tables yet.' })}
    <p class="muted">Undo import moves every record of the import into Recently deleted below, from where Restore puts it all back. A result or formulation added later to an imported record goes with it.</p></div>`;
}

/** Wire the cards drawn by claudeCards. `redraw()` draws the Settings screen again. */
export function wireClaudeCards(el, ctx, redraw) {
  el.querySelectorAll('[data-module]').forEach((box) => box.addEventListener('change', async () => {
    const key = box.dataset.module;
    const s = getSettings(ctx);
    if (box.checked && !s.claudeNoticeSeen) {
      // The first time either is switched on, the notice is a question: nothing is switched on without it read.
      if (!(await ask(`${PRIVACY_NOTE}\n\nSwitch it on?`))) { box.checked = false; return; }
    }
    const stored = ctx.store.get('settings', 'default') || { id: 'default' };
    ctx.store.put('settings', { ...stored, id: 'default', [key]: box.checked, ...(box.checked && !s.claudeNoticeSeen ? { claudeNoticeSeen: new Date().toISOString() } : {}) });
    redraw();
  }));
  el.querySelectorAll('[data-undo-import]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.undoImport;
    const imp = listImports(ctx.store).find((i) => i.id === id);
    const n = imp?.state.live || { batches: 0, measurements: 0 };
    if (!(await ask(`Undo import ${id}? Its ${n.batches} formulations and ${n.measurements} results go to Recently deleted, from where Restore puts them back.`))) return;
    const r = rollbackImport(ctx.store, id);
    if (!r.ok) { toast(`Not undone: ${r.reason}`, 'warn'); return; }
    toast(`Import ${id} moved to the trash${r.others ? `, with ${r.others} record${r.others === 1 ? '' : 's'} added to it later` : ''}`, 'ok', {
      action: 'Restore', onAction: () => { const back = ctx.store.restoreFromTrash(r.entry.id); toast(back.ok ? `Restored ${id}` : `Not restored: ${back.reason}`, back.ok ? 'ok' : 'warn'); redraw(); },
    });
    redraw();
  }));
}
