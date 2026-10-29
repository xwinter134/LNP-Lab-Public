// Batch record calculations for one LNP formulation, step by step:
// 1 RNA dilution, 2 mixing, 3 dialysis, 4 TFF, 5 final formulation + filtration, 6 fill & finish.
// docs/FORMULAS.md lists every formula; tests/calc.test.mjs checks them against values worked out by hand.

/** Step 1: dilute an RNA stock to the working concentration. V_work = V_stock / (C_work / C_stock); diluent = V_work − V_stock */
export function rnaDilution({ stock_mg_mL, stock_mL, working_mg_mL }) {
  const total_mL = stock_mL / (working_mg_mL / stock_mg_mL);
  return { total_mL, diluent_mL: total_mL - stock_mL, rna_mg: stock_mL * stock_mg_mL };
}

/** Step 1 with two RNAs mixed by mass portion, e.g. Luc:eGFP 1:9. */
export function rnaMixture(parts) {
  // parts: [{name, stock_mg_mL, portion}], working_mg_mL, total_rna_mg
  return parts; // placeholder: not used yet; each RNA would be diluted as in rnaDilution()
}

/**
 * Step 2: mixing plan for a T-mixer run with up to four pumps.
 * Defaults: FRR 3:1 (lipid volume = RNA volume / 3), quench = 2 × lipid volume.
 * @param {object} p
 * @param {number} p.rna_mg            RNA input
 * @param {number} p.working_mg_mL     RNA working concentration
 * @param {number} p.lipidStock_mM     lipid stock molarity
 * @param {number} [p.frr=3]           aqueous : organic flow rate ratio
 * @param {number} [p.quenchFactor=2]  quench volume as multiple of lipid volume
 * @param {{p1:number,p2:number,p3:number,p4?:number}} p.flows  pump flows mL/min
 * @param {number} [p.ionizableMolPct] mol% of the ionizable lipid, for N/P
 * @param {number} [p.massPerPhosphate=330] g/mol of RNA per phosphate, for the phosphate moles of N/P (not in the
 *                                         sheet): the cargo's (calc/cargo.js, 330 mRNA, 333 siRNA) or its lot's.
 *                                         `nucleotideMw` is the older name and still read.
 */
export function mixingPlan(p) {
  const frr = p.frr ?? 3;
  const quenchFactor = p.quenchFactor ?? 2;
  const rna_mL = p.rna_mg / p.working_mg_mL;
  const lipid_mL = rna_mL / frr;
  const lipid_mmol = p.lipidStock_mM * (lipid_mL / 1000);
  const quench_mL = lipid_mL * quenchFactor;
  const { p1, p2, p3, p4 = 0 } = p.flows;
  const sumFlowT1 = p1 + p2;
  const totalFlow = p1 + p2 + p3 + p4;
  const primary_mg_mL = (p.working_mg_mL * p1) / totalFlow;
  const primary_mL = p.rna_mg / primary_mg_mL;
  const quenchNeeded_mL = quench_mL * 1.1; // 10 % overage
  const lipidRnaWw = (lipid_mmol * (p.lipidAvgMw ?? 0)) / p.rna_mg; // only if an average MW is supplied
  let np = null;
  if (p.ionizableMolPct != null) {
    const phosphate_mmol = p.rna_mg / (p.massPerPhosphate ?? p.nucleotideMw ?? 330);
    np = (lipid_mmol * (p.ionizableMolPct / 100)) / phosphate_mmol;
  }
  const checks = [];
  if (Math.abs(p1 / p2 - frr) > 0.01) checks.push(`Pump flows give FRR ${(p1 / p2).toFixed(2)}:1, plan says ${frr}:1`);
  if (p3 > 0 && Math.abs(p3 / p2 - quenchFactor) > 0.01) checks.push(`Pump 3 / pump 2 = ${(p3 / p2).toFixed(2)}, quench factor is ${quenchFactor}`);
  return { rna_mL, lipid_mL, lipid_mmol, quench_mL, quenchNeeded_mL, sumFlowT1, totalFlow, primary_mg_mL, primary_mL,
    runTime_min: (rna_mL + lipid_mL + quench_mL) / totalFlow, np, lipidRnaWw: p.lipidAvgMw ? lipidRnaWw : null, checks };
}

/**
 * Pump flows from a total flow, following a four-pump scale table.
 * Four-pump layout: pump 1 RNA, pump 3 citrate pre-dilution into the RNA mixing chamber,
 * pump 2 lipid at T1, pump 4 citrate quench at T2.  p1 = total/10, p3 = 4·p1, p2 = (p1+p3)/3, p4 = 2·p2.
 */
export function scaleFlowsFourPump(total_mL_min) {
  const p1 = total_mL_min / 10;
  const p3 = 4 * p1;
  const p2 = (p1 + p3) / 3;
  const p4 = 2 * p2;
  return { p1, p2, p3, p4, rnaChamber: p1 + p3, t1: p1 + p3 + p2, t2: total_mL_min };
}

/** Step 3: dialysis bookkeeping. DF = V_start / V_end, conc after = primary conc · DF, DLS dilution 1:(conc · 1000 / 4) */
export function dialysisPlan({ start_mL, end_mL, primary_mg_mL }) {
  const dilutionFactor = start_mL / end_mL;
  const rna_mg_mL_est = primary_mg_mL * dilutionFactor;
  return { dilutionFactor, rna_mg_mL_est, dlsDilution: (rna_mg_mL_est * 1000) / 4 };
}

/** Step 4: TFF module load window (SA/10000/0.5·1000 to SA/10000/0.32·1000 mg) and the volume to reduce to */
export function tffPlan({ module, start_mL, target_mg_mL, primary_mg_mL, rna_mg }) {
  const sa = module.surface_cm2;
  const minLoad_mg = (sa / 10000 / 0.5) * 1000;
  const maxLoad_mg = (sa / 10000 / 0.32) * 1000;
  const reduceTo_mL = start_mL / ((target_mg_mL / primary_mg_mL) * 1.2);
  const checks = [];
  if (rna_mg != null && (rna_mg < minLoad_mg || rna_mg > maxLoad_mg))
    checks.push(`RNA load ${rna_mg.toFixed(1)} mg outside module window ${minLoad_mg.toFixed(1)}–${maxLoad_mg.toFixed(1)} mg`);
  return { minLoad_mg, maxLoad_mg, reduceTo_mL, checks };
}

/**
 * Step 5: two-step final formulation. First to 1.33 × final target with the dialysis buffer,
 * then 1:1.33 with the high-sucrose buffer, giving the final concentration and tonicity.
 */
export function finalFormulationPlan({ volume_mL, measured_mg_mL, final_mg_mL, step1Factor = 1.33 }) {
  const c1 = step1Factor * final_mg_mL;
  const df1 = measured_mg_mL / c1;
  const buffer1_mL = volume_mL * df1 - volume_mL;
  const v1 = volume_mL + buffer1_mL;
  const df2 = c1 / final_mg_mL;
  const buffer2_mL = v1 * df2 - v1;
  return { c1, df1, buffer1_mL, v1, df2, buffer2_mL, vFinal_mL: v1 + buffer2_mL, rna_mg: volume_mL * measured_mg_mL };
}

/** Biosafety aliquot: dilute a small volume of IPC5 material to c_target with both buffers in the same ratio. */
export function biosafetyAliquot({ v_mL, c_meas, c_target = 0.05, step1Factor = 1.33 }) {
  const buffer1_mL = (c_meas * v_mL) / (c_target * step1Factor) - v_mL;
  const buffer2_mL = (v_mL * c_meas) / c_target - v_mL - buffer1_mL;
  return { buffer1_mL, buffer2_mL, total_mL: v_mL + buffer1_mL + buffer2_mL };
}

/** Step 6: fill & finish volumes. total = count · fill volume */
export function fillFinish(containers) {
  const rows = containers.map((c) => ({ ...c, total_mL: c.count * c.fill_mL }));
  return { rows, total_mL: rows.reduce((s, r) => s + r.total_mL, 0) };
}

/** In-process controls as used in the record: which measurement belongs to which process stage. */
export const IPC_STAGES = [
  { id: 'IPC4', after: 'dialysis', tests: ['DLS size/PDI (n=3)', 'RNA content', 'EE'] },
  { id: 'IPC5', after: 'TFF concentration', tests: ['DLS size/PDI (n=3)', 'RNA content', 'EE'] },
  { id: 'IPC6', after: 'final formulation + filtration', tests: ['DLS', 'RNA integrity', 'LMS', 'RNA content', 'EE', 'pH', 'osmolality'] },
  { id: 'Release', after: 'fill & finish', tests: ['appearance', 'DLS', 'integrity', 'RiboGreen content/EE', 'lipid content HPLC-CAD',
    'potency (HepG2 / Hek293, ± serum)', 'endotoxin', 'zeta potential', 'NTA', 'bioburden'] },
];
