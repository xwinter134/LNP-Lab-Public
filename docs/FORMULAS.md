# Formulas

This edition carries no model of the mixing hardware: there is no fluidics calculator, and nothing here
computes a Reynolds number or a pump pressure.

Tests in `tests/calc.test.mjs` check each formula against values worked out by hand.

## Lipid stock

| Quantity | Formula |
|---|---|
| Total lipid, mmol | V[mL] · C[mM] / 1000 |
| Lipid i, mmol | total · mol%ᵢ / 100 |
| Weigh-in, g | mmolᵢ · MWᵢ / 1000 (no purity correction) |
| Actual mmol | actual g / MW · 1000 |
| Ethanol, g | (Σ actual mmol / Σ target mmol · V · 0.79) − Σ actual g |
| Ethanol, mL | ethanol g / 0.79 |
| Lipid, mg/mL | Σ weigh-in g · 1000 / V |

Compositions: `app/data/compositions.json` (mol% per lipid) and your own under Materials. Lipid MW: `app/data/lipids.json`.

## Batch record

| Step | Quantity | Formula |
|---|---|---|
| 1 | RNA working volume, mL | V_stock / (C_work / C_stock) |
| 1 | Diluent, mL | V_work − V_stock |
| 2 | RNA volume, mL | RNA mg / C_work |
| 2 | Lipid/EtOH volume, mL | RNA volume / FRR (default FRR 3) |
| 2 | Lipid, mmol | stock mM · lipid volume / 1000 |
| 2 | Quench volume, mL | lipid volume · 2 |
| 2 | Quench needed, mL | quench volume · 1.1 |
| 2 | Sum flow at T1 | pump1 + pump2 |
| 2 | Total process flow | pump1 + pump2 + pump3 + pump4 |
| 2 | Primary product RNA conc, mg/mL | C_work · pump1 / total flow |
| 2 | Primary product, mL | RNA mg / primary conc |
| 3 | Dilution factor | V_start / V_end |
| 3 | RNA conc after dialysis | primary conc · DF |
| 3 | DLS dilution 1:x | conc · 1000 / 4 |
| 4 | TFF min / max RNA load, mg | SA/10000/0.5·1000 ; SA/10000/0.32·1000 (SA from the module) |
| 4 | Reduce volume to, mL | V_start / ((C_target / primary conc) · 1.2) |
| 5 | 1st compounding target | 1.33 · final conc |
| 5 | DF1, buffer 1 | C_meas / C1 ; V·DF1 − V |
| 5 | DF2, buffer 2 | C1 / C_final (=1.33) ; V1·DF2 − V1 |
| 5 | Biosafety aliquot buffers | (C·V)/(C_t·1.33) − V ; (V·C)/C_t − V − buffer1 |
| 6 | Fill volume total | count · fill mL |

Four-pump scale table: p1 = total/10, p3 = 4·p1, p2 = (p1+p3)/3, p4 = 2·p2; T-piece ID 1 mm, L 200 mm (V = 0.157 mL).

## Quick mode 

A formulation in quick mode stops at the mixer, and what is entered is the volume to formulate, V: the product
collected at the outlet, aqueous + lipid + inline quench (the record's "primary product"). The pumps split it
FRR : 1 : q, with q the quench factor, or 0 when the process has no quench (`app/calc/process.js`, `quickVolumes`).

| Quantity | Formula |
|---|---|
| mRNA, mg | V · C_work · FRR / (FRR + 1 + q) |
| Aqueous (RNA) phase, mL | V · FRR / (FRR + 1 + q) |
| Lipid/EtOH, mL | V / (FRR + 1 + q) |
| Quench, mL | V · q / (FRR + 1 + q) |
| Product RNA conc., mg/mL | C_work · FRR / (FRR + 1 + q) |

It is step 2 run backwards: that much mRNA gives exactly V of primary product. Example: 5 mL at 0.4 mg/mL,
FRR 3, quench 2 holds 1.000 mg mRNA. Going back to the full process keeps that mRNA as the RNA input; going to
quick keeps the record's mRNA by taking V = m · (FRR + 1 + q) / (C_work · FRR).

## Process buffers 

The ionic strength shown for a buffer on a process (the aqueous phase, the quench, an exchange buffer) is the one
the Buffers screen's designer gives for the same buffer: `designBuffer()` in `app/calc/buffer.js`, asked by
`ionicStrength_mM()` in `app/calc/process.js`. I = ½ Σ cᵢ zᵢ² over the buffer's species at its pH (with the
Davies activity correction below), the counter-ions of the reagents weighed in (Na⁺ of trisodium citrate or of
NaOH, Cl⁻ of HCl) and any NaCl; H⁺ and OH⁻ are included. A prepared lot is worked out from its own recipe (method,
second component). Citrate 50 mM pH 4.0 → 70 mM, PBS pH 7.4 → 163 mM. It can be overwritten on the process.

Until UX revision 2 the process designer had its own estimate without activity correction (58 mM for that
citrate) while the Buffers screen said 76.6 mM. The difference was the activity correction (it lowers the apparent
pKa values, so more citrate is charged at the same pH), and the designer then aimed its recipe at p[H] 4.0, which a
meter reads as about pH 4.1 (see "Design" below); aimed at the meter's pH 4.0 it is 70 mM.

## N/P and the cargo 

N/P = (lipid mmol · ionizable mol% / 100) / (RNA mg / M_P), with M_P the mass of RNA per phosphate in g/mol
(`app/calc/cargo.js`, used by `mixingPlan()` and the N/P target on a formulation record).

| Cargo | M_P, g/mol per phosphate | Why |
|---|---|
| mRNA | 330 | One phosphate per nucleotide. The average ribonucleotide residue of an mRNA is 320–340 g/mol (A 329, C 305, G 345, U 306 as the free acid; more as sodium salt; N1-methyl-pseudouridine 320). 330 is the usual convention and what the app always used, so no older record's N/P moves. |
| siRNA | 333 | A 21/21-nt duplex with 2-nt 3′ overhangs is about 13.3 kDa (13.3–13.9 kDa with 2′-F/2′-OMe modifications; patisiran ≈ 13.4 kDa as the free acid) and carries 40 phosphodiester phosphates (20 per strand; 5′-hydroxyl ends): 13,300 / 40 ≈ 333. Counted with 5′-phosphorylated strands (42 phosphates) it is ≈ 317. |

The two differ by 1 %, which for an N/P is effectively nothing; the number is still kept per cargo and can be set
on each RNA lot (Materials › RNA lots, "Mass per phosphate") for a lot whose molecular weight and phosphate count
are known. Order of precedence: the formulation's own number, its lot's, the cargo's default. A formulation keeps
its cargo (`plan.rna.cargo`; a record from before the choice is mRNA) and, when its lot is deleted, the lot's
concentration and mass per phosphate. Typical N/P to start from: about 6 for mRNA, about 3 for siRNA (Onpattro is
made at N/P ≈ 3); the OFAT levels and DoE range the wizard proposes follow the cargo (mRNA 3, 6, 9, 12 and 3–9;
siRNA 1.5, 3, 4.5, 6 and 2–6).

## Buffers (CurTiPot pH_calc)

- Speciation of an n-protic system at [H⁺]: term for k protons = [H]ᵏ · Ka₁ … Ka₍ₙ₋ₖ₎, fractions = term / Σ terms; charge of the k-proton species = charge of fully deprotonated base + k.
- pH from charge balance: [H⁺] − [OH⁻] + Σ strong ions z·c + Σ systems c · Σₖ αₖ · zₖ = 0, solved by bisection on pH.
- Activity: Davies, log γ = −A z² (√I/(1+√I) − 0.3 I), A = 0.509 at 25 °C; apparent pKaʹ = pKa + 2·A·f(I)·z_base per step; iterated to self-consistent ionic strength. pH reported on both scales: p[H] (concentration) and pH = p[H] − log γ_H (activity), as CurTiPot does.
- Buffer capacity: numeric, Δ(strong base) / ΔpH.
- Design: bisection on the base-form fraction (two reagents) or on the titrant amount (one reagent + NaOH/HCl) until the target pH is met. With activity on, the target is the pH a meter reads (activity scale); p[H] is shown beside it. A system without reagents on record is taken as its neutral form titrated with NaOH or HCl, which gives its pH and ionic strength but no grams.
- Reference check: 0.0265 M HPO₄²⁻ + 0.020 M H₂PO₄⁻, Na⁺ 0.073 M → p[H] 6.894, pH 7.001, I 0.0995 (CurTiPot's own pH_calc example).
