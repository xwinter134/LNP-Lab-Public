// The single most urgent thing to do, from the records alone (pure: no store, no DOM). The Overview shows it as
// one card, so a person opening the app does not have to work out from five lists what comes next.
//
// Order of urgency: a formulation that is made but not measured (its results are due; the sample is ageing)
// comes before one that is still to be made; both before planning something new. Within a kind the earliest
// date wins, then the id, so the choice is stable between redraws.

const num = (id) => Number(String(id).match(/\d+/g)?.pop()) || 0;
const byDateThenId = (key) => (a, b) => String(a[key] || '9999').localeCompare(String(b[key] || '9999')) || num(a.id) - num(b.id) || String(a.id).localeCompare(String(b.id));

/**
 * @param {object[]} experiments  with .status and .expected [{batchId,status,dueDate}]
 * @param {object[]} batches      with .id, .experimentId, .status (planned | produced | measured | analyzed), .plannedDate
 * @param {object[]} measurements with .batchId
 * @returns {{kind:string, text:string, label:string, href:string}}
 */
export function nextStep(experiments = [], batches = [], measurements = []) {
  const active = new Set(experiments.filter((e) => e.status !== 'done').map((e) => e.id));
  const measured = new Set(measurements.map((m) => m.batchId));
  const mine = batches.filter((b) => active.has(b.experimentId));

  // Results due: made, and a measurement slot still open for it (or, with no slots on record, no result at all).
  const openFor = new Map();
  for (const e of experiments) {
    if (!active.has(e.id)) continue;
    for (const s of e.expected || []) if (s.status === 'open') {
      const cur = openFor.get(s.batchId);
      if (!cur || String(s.dueDate || '9999') < cur) openFor.set(s.batchId, String(s.dueDate || '9999'));
    }
  }
  const due = mine.filter((b) => b.status === 'produced' && (openFor.has(b.id) || !measured.has(b.id)))
    .map((b) => ({ id: b.id, date: openFor.get(b.id) || b.plannedDate }))
    .sort(byDateThenId('date'));
  if (due.length) {
    return { kind: 'measure', text: `Enter results for ${due[0].id}${due.length > 1 ? ` (and ${due.length - 1} more waiting)` : ''}`, label: 'Measure', href: `#/measurements?batch=${encodeURIComponent(due[0].id)}` };
  }
  const planned = mine.filter((b) => b.status === 'planned').map((b) => ({ id: b.id, date: b.plannedDate })).sort(byDateThenId('date'));
  if (planned.length) {
    return { kind: 'make', text: `Make ${planned[0].id}${planned.length > 1 ? ` (and ${planned.length - 1} more planned)` : ''}`, label: 'Open record', href: `#/formulation?batch=${encodeURIComponent(planned[0].id)}` };
  }
  if (!experiments.length) return { kind: 'plan', text: 'Plan an experiment', label: 'Plan an experiment', href: '#/advisor' };
  return { kind: 'plan', text: 'Everything planned is made and measured. Plan the next experiment', label: 'Plan an experiment', href: '#/advisor' };
}
