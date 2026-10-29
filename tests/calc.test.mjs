// Run with: node --test tests/
// Reference values are worked out by hand from the formulas in docs/FORMULAS.md, and from CurTiPot's published examples.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planLipidStock, reconcileLipidStock } from '../app/calc/lipid_stock.js';
import { rnaDilution, mixingPlan, dialysisPlan, finalFormulationPlan, biosafetyAliquot, tffPlan } from '../app/calc/batch_record.js';
import { solvePH, designTwoReagentBuffer } from '../app/calc/buffer.js';
import { flowsFromTotal } from '../app/calc/experiment.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} ± ${tol}`);

test('lipid stock: a weigh-in is mmol x MW, with no purity correction', () => {
  // The expectations are worked out here rather than copied from the module's own output, so the test would
  // catch the module agreeing with itself. Purity is deliberately absent: a supplier figure is not specific
  // to the vial in hand, and correcting by it moves every weigh-in in a way nobody can reconstruct later.
  const MW = { ALC315: 766.27, DSPC: 790.15, Chol: 386.65, ALC159: 2500 };
  const PCT = { ALC315: 46.3, DSPC: 9.4, Chol: 42.7, ALC159: 1.6 };
  const lipids = Object.fromEntries(Object.entries(MW).map(([k, mw]) => [k, { mw }]));
  const molarity_mM = 50, volume_mL = 20;

  const plan = planLipidStock({ molPct: PCT, lipids, molarity_mM, volume_mL });
  const totalMmol = (volume_mL * molarity_mM) / 1000;
  close(plan.totalMmol, totalMmol, 1e-12, 'total mmol');
  for (const [k, pct] of Object.entries(PCT)) {
    const row = plan.rows.find((r) => r.key === k);
    close(row.mmol, (totalMmol * pct) / 100, 1e-12, `${k} mmol`);
    close(row.weighG, ((totalMmol * pct) / 100) * MW[k] / 1000, 1e-12, `${k} weigh-in g`);
    assert.equal(row.purityPct, undefined, `${k} carries no purity`);
  }
  // A purity figure on the lipid must not change the answer, even if one is supplied.
  const withPurity = planLipidStock({ molPct: PCT, lipids: Object.fromEntries(Object.entries(MW).map(([k, mw]) => [k, { mw, purityPct: 90 }])), molarity_mM, volume_mL });
  close(withPurity.weighTotalG, plan.weighTotalG, 1e-12, 'a purity field is ignored');

  const sumG = Object.entries(PCT).reduce((a, [k, pct]) => a + ((totalMmol * pct) / 100) * MW[k] / 1000, 0);
  close(plan.lipidMgPerMl, (sumG * 1000) / volume_mL, 1e-9, 'lipid mg/mL');

  // What the balance said, slightly off target in both directions.
  const actual = { ALC315: 0.3371, DSPC: 0.0699, Chol: 0.1572, ALC159: 0.0381 };
  const rec = reconcileLipidStock(plan, actual, volume_mL);
  const mmolActual = Object.entries(actual).reduce((a, [k, g]) => a + (g / MW[k]) * 1000, 0);
  const vFinal = (mmolActual * volume_mL) / totalMmol;
  const actualG = Object.values(actual).reduce((a, b) => a + b, 0);
  close(rec.mmolActualTotal, mmolActual, 1e-12, 'actual mmol');
  close(rec.finalVolumeMl, vFinal, 1e-12, 'volume scaled to hold the molarity');
  close(rec.ethanolG, vFinal * 0.79 - actualG, 1e-12, 'ethanol g');
  close(rec.ethanolMl, (vFinal * 0.79 - actualG) / 0.79, 1e-12, 'ethanol mL');
  close(rec.molarity_mM, molarity_mM, 1e-9, 'the resulting stock is at the molarity that was asked for');
});


test('batch record: RNA dilution, mixing, dialysis, final formulation, worked by hand', () => {
  const d = rnaDilution({ stock_mg_mL: 2.06, stock_mL: 1.75, working_mg_mL: 0.4 });
  close(d.total_mL, 9.0125, 1e-6, 'working volume');
  close(d.diluent_mL, 7.2625, 1e-6, 'diluent');
  const m = mixingPlan({ rna_mg: 3, working_mg_mL: 0.4, lipidStock_mM: 50, flows: { p1: 56.25, p2: 18.75, p3: 37.5 } });
  close(m.rna_mL, 7.5, 1e-9, 'RNA volume'); close(m.lipid_mL, 2.5, 1e-9, 'lipid volume'); close(m.lipid_mmol, 0.125, 1e-9, 'lipid mmol');
  close(m.quench_mL, 5, 1e-9, 'quench volume'); close(m.quenchNeeded_mL, 5.5, 1e-9, 'quench to prepare');
  close(m.sumFlowT1, 75, 1e-9, 'flow at T1'); close(m.totalFlow, 112.5, 1e-9, 'total flow');
  close(m.primary_mg_mL, 0.2, 1e-9, 'primary concentration'); close(m.primary_mL, 15, 1e-9, 'primary volume');
  assert.equal(m.checks.length, 0);
  const dia = dialysisPlan({ start_mL: 10, end_mL: 14, primary_mg_mL: 0.2 });
  close(dia.dilutionFactor, 0.714286, 1e-5, 'dialysis dilution factor'); close(dia.rna_mg_mL_est, 0.142857, 1e-5, 'concentration after dialysis'); close(dia.dlsDilution, 35.714, 1e-2, 'DLS dilution');
  const c = finalFormulationPlan({ volume_mL: 12.5, measured_mg_mL: 0.142, final_mg_mL: 0.1 });
  close(c.c1, 0.133, 1e-9, 'first compounding target'); close(c.df1, 1.067669, 1e-5, 'DF1'); close(c.buffer1_mL, 0.845865, 1e-5, 'buffer 1');
  close(c.v1, 13.345865, 1e-5, 'volume after buffer 1'); close(c.buffer2_mL, 4.404135, 1e-5, 'buffer 2'); close(c.vFinal_mL, 17.75, 1e-5, 'final volume');
  const b = biosafetyAliquot({ v_mL: 0.5, c_meas: 0.142, c_target: 0.05 });
  close(b.buffer1_mL, 0.567669, 1e-5, 'aliquot buffer 1'); close(b.buffer2_mL, 0.352331, 1e-5, 'aliquot buffer 2');
  const t = tffPlan({ module: { surface_cm2: 20 }, start_mL: 10, target_mg_mL: 0.133, primary_mg_mL: 0.2 });
  close(t.minLoad_mg, 4, 1e-9, 'TFF min load'); close(t.maxLoad_mg, 6.25, 1e-9, 'TFF max load'); close(t.reduceTo_mL, 12.5313, 1e-3, 'reduce to');
});

test('batch record: the "At the bench" numbers for two formulations, worked by hand from docs/FORMULAS.md', () => {
  // The record's bench card reads these off the same calls (app/ui/formulation.js, compute()); the smoke
  // scenario benchCardFollowsInputs checks the card shows them. Pump flows split the total FRR : 1 : quench.
  const bench = ({ mass, stock, working, frr, quench, total }) => {
    const stock_mL = mass / stock, d = rnaDilution({ stock_mg_mL: stock, stock_mL, working_mg_mL: working });
    const flows = flowsFromTotal(total, frr, quench);
    const m = mixingPlan({ rna_mg: mass, working_mg_mL: working, lipidStock_mM: 50, frr, quenchFactor: quench, flows });
    return { stock_mL, buffer_mL: d.diluent_mL, ...m, ...flows };
  };
  // 3 mg at 0.4 mg/mL from a 1.02 mg/mL stock, FRR 3, quench 2, 112.5 mL/min
  let b = bench({ mass: 3, stock: 1.02, working: 0.4, frr: 3, quench: 2, total: 112.5 });
  close(b.stock_mL, 3 / 1.02, 1e-12, 'RNA stock to pipette'); close(b.buffer_mL, 7.5 - 3 / 1.02, 1e-12, 'buffer to add');
  close(b.rna_mL, 7.5, 1e-12, 'RNA phase'); close(b.lipid_mL, 2.5, 1e-12, 'lipid/ethanol'); close(b.quench_mL, 5, 1e-12, 'quench');
  close(b.p1, 56.25, 1e-12, 'pump 1'); close(b.p2, 18.75, 1e-12, 'pump 2'); close(b.p3, 37.5, 1e-12, 'pump 3'); close(b.totalFlow, 112.5, 1e-12, 'total');
  close(b.primary_mL, 15, 1e-9, 'dialysis start: 3 mg at 0.4 x 56.25/112.5 = 0.2 mg/mL');
  assert.equal(b.checks.length, 0, 'the split pumps agree with the FRR and quench factor');
  // 1.5 mg at 0.2 mg/mL from a 2.06 mg/mL stock, FRR 4, quench 1.5, 60 mL/min
  b = bench({ mass: 1.5, stock: 2.06, working: 0.2, frr: 4, quench: 1.5, total: 60 });
  close(b.stock_mL, 0.728155, 1e-6, 'RNA stock to pipette'); close(b.buffer_mL, 6.771845, 1e-6, 'buffer to add');
  close(b.rna_mL, 7.5, 1e-12, 'RNA phase'); close(b.lipid_mL, 1.875, 1e-12, 'lipid/ethanol'); close(b.quench_mL, 2.8125, 1e-12, 'quench');
  close(b.p1, 240 / 6.5, 1e-9, 'pump 1'); close(b.p2, 60 / 6.5, 1e-9, 'pump 2'); close(b.p3, 90 / 6.5, 1e-9, 'pump 3'); close(b.totalFlow, 60, 1e-9, 'total');
  close(b.primary_mL, 12.1875, 1e-9, 'dialysis start: 1.5 mg at 0.2 x (240/6.5)/60 mg/mL');
  assert.equal(b.checks.length, 0);
});

test('buffer: CurTiPot pH_calc example (26.5 mM Na2HPO4 + 20 mM NaH2PO4) gives p[H] 6.89 / pH 7.00 with activity', () => {
  // CurTiPot's pH_calc example: [HB] = 0.0265 (HPO4 2-), [H2B] = 0.020 (H2PO4 -), Na+ = 0.073 (B15); results B23 pH 7.0006, B24 p[H] 6.8938, E26 I 0.0995
  const r = solvePH({
    systems: [{ pka: [2.148, 7.199, 12.35], chargeOfBase: -3, conc: 0.0465 }],
    ions: [{ z: 1, conc: 2 * 0.0265 + 0.02 }],
    activity: true,
  });
  close(r.pH, 6.894, 0.02, 'p[H] concentration scale (B24)');
  close(r.pH_activity, 7.001, 0.02, 'pH activity scale (B23)');
  close(r.ionicStrength, 0.0995, 0.005, 'ionic strength (E26)');
  const r0 = solvePH({ systems: [{ pka: [2.148, 7.199, 12.35], chargeOfBase: -3, conc: 0.0465 }], ions: [{ z: 1, conc: 0.073 }], activity: false });
  close(r0.pH, 7.321, 0.02, 'thermodynamic "pH" without activity (B25)');
  // acetate 50 mM pH 5.5 design (lab buffer B73)
  const acet = designTwoReagentBuffer({
    system: { pka: [4.757], charge_of_base: -1 },
    acidReagent: { name: 'HAc', mw: 60.05, counterIons: [] },
    baseReagent: { name: 'NaAc', mw: 82.03, counterIons: [{ z: 1, perMol: 1 }] },
    targetPH: 5.5, conc_M: 0.05, volume_mL: 1000,
  });
  close(acet.predictedPH, 5.5, 0.01, 'designed pH');
  assert.ok(acet.xBase > 0.8 && acet.xBase < 0.9, `base fraction plausible: ${acet.xBase}`);
});


