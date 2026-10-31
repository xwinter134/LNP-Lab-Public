// The biological targets the optimizer can take (spec 7.9), read from the studies of the biology layers.
//
// One target per series a formulation has values for (a layer, a quantity, an organ or population, a timepoint:
// calc/bio.js seriesCatalogue), each the formulation's mean log10 fold over its study's reference
// (normalisedByFormulation). Only normalised values reach the model, so studies with different absolute levels
// can be pooled; the study of each value travels with it, for the leave-one-study-out split. Registered with
// targets.js when this module loads; targets.js still offers nothing while no layer is switched on.
import { registerTargetProvider } from './targets.js';
import { normalisedByFormulation, seriesCatalogue } from '../bio.js';

/** Targets for a lab's studies; `on(layer)` says whether that layer is switched on. Pure apart from reading the store. */
export function studyTargets(ctx, settings, on) {
  const studies = ctx?.store?.all('studies') || [], ms = ctx?.store?.all('bioMeasurements') || [];
  if (!studies.length || !ms.length) return [];
  const by = normalisedByFormulation(studies, ms);
  return seriesCatalogue(by).filter((s) => on(s.key.split('|')[0])).map((s) => ({
    name: `bio:${s.key}`, label: s.label, unit: 'log10 vs reference', layer: s.key.split('|')[0], goal: 'maximize',
    // already a log10 fold: handed on as value / reference = 10^fold / 1, which applyTargets turns back into it
    read: (row) => {
      const e = by.get(row.batchId)?.[s.key];
      if (!e || !Number.isFinite(e.mean)) return null;
      const studyIds = Object.keys(e.studies || {});
      return { value: 10 ** e.mean, reference: 1, studyId: studyIds.length === 1 ? studyIds[0] : studyIds.sort().join('+') };
    },
  }));
}

registerTargetProvider(studyTargets);
