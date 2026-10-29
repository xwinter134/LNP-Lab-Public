// The latest results at a glance (usability cycle 2, F9): the last formulations measured by DLS, each one
// judged against the QC limits, and the sentence that says how today's work stands. Pure; the overview draws it.

const byNewest = (a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

/**
 * The last `n` formulations with a DLS result, oldest first (so a chart reads left to right in time). A
 * formulation counts once, with its most recent result: a stability study measures the same formulation
 * every week, and twenty points of one study would hide everything else made since.
 * Returns [{batchId, measurementId, sampleName, date, zave, pdi}].
 */
export function latestMeasured(measurements = [], n = 20) {
  const seen = new Set(), out = [];
  for (const m of measurements.filter((x) => x && x.test === 'dls' && x.batchId && Number.isFinite(x.values?.zave_nm)).sort(byNewest)) {
    if (seen.has(m.batchId)) continue;
    seen.add(m.batchId);
    out.push({ batchId: m.batchId, measurementId: m.id, sampleName: m.sampleName || m.batchId, date: m.date || '', zave: m.values.zave_nm, pdi: Number.isFinite(m.values.pdi) ? m.values.pdi : null });
    if (out.length >= n) break;
  }
  return out.reverse();
}

/** Where a result sits against the QC limits: {size: 'low'|'high'|null, pdi: bool, ok}. A missing PDI is not judged. */
export function qcOf(row, qc = {}) {
  const size = Number.isFinite(qc.zaveMin) && row.zave < qc.zaveMin ? 'low' : Number.isFinite(qc.zaveMax) && row.zave > qc.zaveMax ? 'high' : null;
  const pdi = Number.isFinite(qc.pdiMax) && Number.isFinite(row.pdi) && row.pdi > qc.pdiMax;
  return { size, pdi, ok: !size && !pdi };
}

/** "E6-F4", "E6-F4 and E6-F14", "E6-F4, E6-F9 and E6-F14", "E6-F4, E6-F9, E6-F14 and 3 more". */
export function nameList(ids, max = 4) {
  if (ids.length <= 1) return ids.join('');
  if (ids.length <= max) return `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
  return `${ids.slice(0, max - 1).join(', ')} and ${ids.length - (max - 1)} more`;
}

/**
 * One sentence on the rows from latestMeasured(): "18 of the last 20 inside the QC limits for size and PDI;
 * E6-F4 and E6-F14 are outside on PDI." A formulation outside on both says so once ("on size and PDI")
 * rather than appearing in two lists. `n` is the window asked for, so a lab with only seven results reads
 * "of the 7 measured so far" rather than "of the last 7", which would suggest there were more.
 */
export function latestSentence(rows, qc = {}, n = 20) {
  if (!rows.length) return '';
  // The card judges what it draws, size and PDI; an EE below its limit is flagged under "Needs attention", so
  // "inside the QC limits" says which limits it means rather than vouching for the EE as well. A limit switched
  // off in Settings judges nothing, so it is not named either (usability cycle 6, Q1).
  const set = [(Number.isFinite(qc.zaveMin) || Number.isFinite(qc.zaveMax)) && 'size', Number.isFinite(qc.pdiMax) && 'PDI'].filter(Boolean);
  if (!set.length) return 'No QC limit for size or PDI is switched on in Settings, so these results are not judged against one.';
  const FOR = `for ${set.join(' and ')}`;
  const judged = rows.map((r) => ({ id: r.batchId, ...qcOf(r, qc) }));
  const inside = judged.filter((r) => r.ok).length;
  const groups = [
    ['size and PDI', judged.filter((r) => r.size && r.pdi)],
    ['PDI', judged.filter((r) => !r.size && r.pdi)],
    ['size', judged.filter((r) => r.size && !r.pdi)],
  ].filter(([, g]) => g.length);
  const out = groups.map(([what, g]) => `${nameList(g.map((r) => r.id))} ${g.length === 1 ? 'is' : 'are'} outside on ${what}`).join('; ');
  if (rows.length === 1) return `${rows[0].batchId}, the only formulation measured so far, ${judged[0].ok ? `is inside the QC limits ${FOR}` : out.replace(/^\S+ is /, 'is ')}.`;
  const full = rows.length >= n;
  if (inside === rows.length) return full ? `All of the last ${rows.length} inside the QC limits ${FOR}.` : `All ${rows.length} formulations measured so far inside the QC limits ${FOR}.`;
  return `${inside} of ${full ? 'the last' : 'the'} ${rows.length}${full ? '' : ' measured so far'} inside the QC limits ${FOR}; ${out}.`;
}
