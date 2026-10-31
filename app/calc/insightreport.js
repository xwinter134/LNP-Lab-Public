// Insights with Claude (spec 10, personal build only): the report Claude writes back through the MCP server's
// save_insight_report, and what the Insights screen says about it.
//
// The division of labour is the import's again (spec 6.1): the app's own analyses do the arithmetic, Claude only
// reads their output (get_trends, summarize_database, query_formulations, get_optimizer_state) and puts it in
// words. So a finding must name the analysis it came from, one of ANALYSES, and the formulations it rests on,
// which must exist; the server refuses a report that does neither. Claude interprets, it does not compute anew
// (spec 10.2).
//
// A report carries the state of the data it was written from, {formulations, lastDate}. Once more than
// STALE_AFTER formulations have been added since, the screen says it is out of date (spec 10.3). The app never
// runs Claude itself: a fresh report is made in Claude, by hand or by a scheduled task there.

/** The analyses a finding may come from: the key a finding names, and what it is, in words. */
export const ANALYSES = {
  groupEffect: 'Groups compared at matched settings (Insights, app/calc/insights.js matchedEffect)',
  drift: 'Drift of the latest batches (Insights, app/calc/insights.js drift)',
  controlLimits: 'Control limits, mean ± 2 SD (Insights control chart, app/calc/stats.js controlLimits)',
  correlation: 'Pearson correlation of a factor with a response (Insights, direction only)',
  completeness: 'Completeness of the records (Data overview, app/calc/facets.js completeness)',
  summary: 'Counts, period and medians (Data overview, app/calc/facets.js summary)',
  coverage: 'How the formulations spread over lipids, buffers and mixers (Data overview facets)',
  optimizer: 'The optimizer\'s saved setup and its predictions against the measurements (get_optimizer_state)',
  quarantine: 'Rows waiting in quarantine, by reason (quality_report)',
};

/** How many new formulations make a report out of date. */
export const STALE_AFTER = 20;

/** The data a report is written from: how many formulations, and the latest date on any of them or their results. */
export function dataState(lab) {
  const batches = lab.all('batches');
  let last = '';
  for (const b of batches) { const d = String(b.plannedDate || '').slice(0, 10); if (d > last) last = d; }
  for (const m of lab.all('measurements')) { const d = String(m.date || '').slice(0, 10); if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d > last) last = d; }
  return { formulations: batches.length, lastDate: last || null };
}

/** The newest report, or null. */
export function latestReport(lab) {
  const all = lab.all('insightReports').filter((r) => r && r.createdAt);
  return all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
}

/** Whether a report still describes the lab: {added, stale}. */
export function reportStatus(report, lab) {
  if (!report) return { added: 0, stale: false };
  const added = Math.max(0, dataState(lab).formulations - (Number(report.dataState?.formulations) || 0));
  return { added, stale: added > STALE_AFTER };
}

/**
 * A report as save_insight_report receives it, checked and made into the record that is stored:
 * {id, createdAt, title, dataState, findings: [{text, analysis, formulationIds, value?, response?}], drivers?,
 * anomalies?, openQuestions?, model?}. The data state is the server's, never the caller's. Returns
 * {ok, record} or {ok: false, problems}.
 */
export function buildReport(input = {}, lab, now = new Date()) {
  const problems = [];
  const ids = new Set(lab.all('batches').map((b) => b.id));
  const clean = (list, kind, { needIds = false } = {}) => (Array.isArray(list) ? list : []).map((f, i) => {
    const where = `${kind} ${i + 1}`;
    const text = String(f?.text || '').trim();
    if (!text) problems.push(`${where} has no text`);
    const analysis = String(f?.analysis || '');
    if (!ANALYSES[analysis]) problems.push(`${where} names the analysis "${analysis}"; use one of ${Object.keys(ANALYSES).join(', ')}`);
    const fids = (Array.isArray(f?.formulationIds) ? f.formulationIds : []).map(String);
    const unknown = fids.filter((id) => !ids.has(id));
    if (unknown.length) problems.push(`${where} names formulations that are not in the lab: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ' …' : ''}`);
    if (needIds && !fids.length) problems.push(`${where} names no formulation it rests on`);
    const out = { text, analysis, formulationIds: fids };
    if (f?.value != null && f.value !== '') out.value = String(f.value);
    if (f?.response) out.response = String(f.response);
    return out;
  });
  const findings = clean(input.findings, 'finding', { needIds: true });
  if (!findings.length) problems.push('a report needs at least one finding');
  if (findings.length > 5) problems.push(`${findings.length} findings; the report holds the five most important (spec 10.2)`);
  const record = {
    id: `report-${now.toISOString().replace(/[:.]/g, '-')}`, createdAt: now.toISOString(), title: String(input.title || 'Insights from Claude').slice(0, 120),
    dataState: dataState(lab), findings,
    drivers: clean(input.drivers, 'driver'), anomalies: clean(input.anomalies, 'anomaly'), openQuestions: clean(input.openQuestions, 'open question'),
    by: 'Claude, through the LNP Lab MCP server',
  };
  return problems.length ? { ok: false, problems } : { ok: true, record };
}
