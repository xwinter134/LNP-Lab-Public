// The Insights screen's card for the report Claude wrote back (spec 10, personal build only; app/calc/insightreport.js).
//
// The newest report, with when it was written and from how much data, its findings each with the analysis it came
// from and links to the formulations it rests on. More than STALE_AFTER formulations added since, and it says so:
// a new report is made in Claude, never by the app (spec 10.3). Nothing is drawn unless the module is on.
import { esc, chip, fmtDate } from './kit.js';
import { getSettings } from '../refdata.js';
import { insightsOn } from '../build.js';
import { ANALYSES, latestReport, reportStatus } from '../calc/insightreport.js';
import { idsHref } from '../calc/facets.js';

const SHOW_IDS = 6;

// A finding's formulations open together in Data (the `ids` filter, app/calc/facets.js), where they can be read
// side by side, exported or handed to the optimizer. One link per id opened one record at a time.
function item(f) {
  const ids = [...new Set((f.formulationIds || []).map(String).filter(Boolean))];
  const names = ids.slice(0, SHOW_IDS).map(esc).join(', ') + (ids.length > SHOW_IDS ? ` and ${ids.length - SHOW_IDS} more` : '');
  return `<li>${esc(f.text)}${f.value ? ` ${chip(f.value, 'info')}` : ''}
    <div class="muted">${esc(ANALYSES[f.analysis] || f.analysis)}${ids.length ? ` · <a class="reportIds" href="${esc(idsHref(ids))}" title="Open ${ids.length === 1 ? 'it' : `these ${ids.length}`} in Data">${names}</a>` : ''}</div></li>`;
}

/** The card, as HTML; '' when Claude insights are off. */
export function claudeReportCard(ctx) {
  if (!insightsOn(getSettings(ctx))) return '';
  const rep = latestReport(ctx.store);
  if (!rep) {
    return `<div class="card" id="claudeReport"><h2>Report from Claude</h2><p class="muted">No report yet. In Claude Desktop, with the LNP Lab extension installed, ask: "What are the most important findings in my data? Save them as a report." It appears here.</p></div>`;
  }
  const st = reportStatus(rep, ctx.store);
  const ds = rep.dataState || {};
  const list = (title, xs) => (xs?.length ? `<h3>${title}</h3><ul class="drivers">${xs.map(item).join('')}</ul>` : '');
  return `<div class="card" id="claudeReport"><h2>${esc(rep.title || 'Report from Claude')}</h2>
    <p class="muted" id="claudeReportState">Written by Claude on ${esc(fmtDate(String(rep.createdAt).slice(0, 10)))}, from ${ds.formulations ?? '–'} formulations${ds.lastDate ? ` up to ${esc(fmtDate(ds.lastDate))}` : ''}. Claude put the app's own analyses into words; each finding names the analysis it came from.</p>
    ${st.stale ? `<p class="note warn" id="claudeReportStale">Report out of date, regenerate it in Claude. ${st.added} formulations were added since it was written.</p>` : ''}
    ${list('Findings', rep.findings)}${list('Drivers', rep.drivers)}${list('Anomalies', rep.anomalies)}${list('Open questions', rep.openQuestions)}</div>`;
}
