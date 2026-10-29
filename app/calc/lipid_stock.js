// Lipid stock planning: turn a composition and a target molarity into grams on a balance, then reconcile
// what the balance actually said and work out the ethanol to add.
//
// The weigh-in is taken at face value: grams = mmol x MW. Nothing here corrects for supplier purity. A
// correction only helps when the certificate's number is both current and specific to the vial in hand, and
// when it is not, it silently moves every weigh-in by a percent or two in a direction nobody can reconstruct
// later. Record the lot against the stock instead, and let the HPLC lipid content be the check.

export const ETOH_DENSITY_G_PER_ML = 0.79;

/**
 * Plan the weigh-in for a lipid stock in ethanol.
 * @param {object} p
 * @param {Record<string, number>} p.molPct   lipid key -> mol%
 * @param {Record<string, {mw:number}>} p.lipids  lipid key -> molecular weight
 * @param {number} p.molarity_mM  target total lipid molarity of the stock
 * @param {number} p.volume_mL    stock volume
 */
export function planLipidStock({ molPct, lipids, molarity_mM, volume_mL }) {
  const totalMmol = (volume_mL * molarity_mM) / 1000;
  const rows = Object.entries(molPct)
    .filter(([, pct]) => pct > 0)
    .map(([key, pct]) => {
      const lip = lipids[key];
      if (!lip || !lip.mw) throw new Error(`No molecular weight for lipid "${key}"`);
      const mmol = (totalMmol * pct) / 100;
      const weighG = (mmol * lip.mw) / 1000;
      return { key, name: lip.name ?? key, pct, mw: lip.mw, mmol, weighG };
    });
  const sumPct = rows.reduce((s, r) => s + r.pct, 0);
  const weighTotalG = rows.reduce((s, r) => s + r.weighG, 0);
  return {
    totalMmol,
    sumPct,
    rows,
    weighTotalG,
    lipidMgPerMl: (weighTotalG * 1000) / volume_mL,
    warnings: Math.abs(sumPct - 100) > 0.05 ? [`Composition sums to ${sumPct.toFixed(2)} %, not 100 %`] : [],
  };
}

/**
 * Reconcile actual weigh-ins and compute the ethanol to add.
 * The solution volume is scaled by actual/target mmol so the molarity is hit exactly, the total solution mass
 * is taken as that volume x 0.79 g/mL, and the lipid mass is subtracted. That treats lipid mass as displacing
 * ethanol mass one for one, which is close enough at these concentrations and is what a bench sheet assumes.
 * @param {ReturnType<typeof planLipidStock>} plan
 * @param {Record<string, number>} actualG  lipid key -> actually weighed grams
 * @param {number} volume_mL
 */
export function reconcileLipidStock(plan, actualG, volume_mL) {
  const rows = plan.rows.map((r) => {
    const g = actualG[r.key];
    const mmolActual = g != null ? (g / r.mw) * 1000 : null;
    return { ...r, actualG: g ?? null, mmolActual, deviationPct: g != null ? ((g - r.weighG) / r.weighG) * 100 : null };
  });
  const complete = rows.every((r) => r.actualG != null);
  if (!complete) return { rows, complete, ethanolG: null, ethanolMl: null, finalVolumeMl: null };
  const actualLipidG = rows.reduce((s, r) => s + r.actualG, 0);
  const mmolActualTotal = rows.reduce((s, r) => s + r.mmolActual, 0);
  const finalVolumeMl = (mmolActualTotal * volume_mL) / plan.totalMmol;
  const ethanolG = finalVolumeMl * ETOH_DENSITY_G_PER_ML - actualLipidG;
  return {
    rows,
    complete,
    actualLipidG,
    mmolActualTotal,
    finalVolumeMl,
    ethanolG,
    ethanolMl: ethanolG / ETOH_DENSITY_G_PER_ML,
    molarity_mM: (mmolActualTotal / finalVolumeMl) * 1000,
  };
}

/** Mass fraction of each lipid in the dry mix, handy for HPLC lipid-content checks. */
export function massFractions(plan) {
  const total = plan.rows.reduce((s, r) => s + r.mmol * r.mw, 0);
  return Object.fromEntries(plan.rows.map((r) => [r.key, (r.mmol * r.mw) / total]));
}
