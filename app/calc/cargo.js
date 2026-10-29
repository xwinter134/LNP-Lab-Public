// What a formulation carries: the nucleic acid cargo (mRNA, siRNA), and what the calculations need to know about
// it. Pure; no DOM, no store.
//
// The app was written for mRNA and said so on every label. A lab that also makes siRNA LNPs (Onpattro, the
// reference composition #1, is one) needs three things to differ, and nothing else: the word on the labels, the
// mass of RNA per phosphate the N/P ratio is worked out with, and the N/P a new plan starts from.
//
// Where the cargo is kept, in the order it is read:
//   1. a formulation's own plan, plan.rna.cargo (written when the experiment is created, copied from the wizard);
//   2. its RNA lot, rnaLot.cargo (Materials › RNA lots), where it is said once per lot;
//   3. mRNA, for every record made before there was a choice, which is what all of them were.
// The mass per phosphate follows the same order (plan.rna.massPerPhosphate, the lot's, the cargo's default), so a
// lot whose sequence is known exactly can carry its own number, and a record keeps the number it was made with
// even after its lot is edited or deleted (Materials copies it onto the records then).
//
// The values (docs/FORMULAS.md, "N/P and the cargo"):
//   mRNA  330 g/mol per phosphate. One phosphate per nucleotide; the average ribonucleotide residue in an
//         mRNA is 320–340 g/mol depending on base composition, sodium form and modified uridine. 330 is the
//         usual convention and what the app always used, so no record's N/P moves.
//   siRNA 333 g/mol per phosphate. A 21/21-nt duplex with 2-nt 3' overhangs is about 13.3 kDa (13.3–13.9 kDa
//         with 2'-F/2'-OMe modifications, as sodium salt toward the top) and carries 40 phosphodiester
//         phosphates (20 per strand; the 5' ends are hydroxyls), so 13,300 / 40 ≈ 333. Counting 42 phosphates
//         (5'-phosphorylated strands) gives ~317.
// The two are within 1 %: for the N/P they are effectively the same, and the separate number is kept so that a
// lot with a known molecular weight and phosphate count can say exactly what it is.

/** The cargo types, in the order a menu offers them. Extensible: add an entry here and every screen offers it. */
export const CARGO_TYPES = [
  { id: 'mRNA', label: 'mRNA', massPerPhosphate: 330, defaultNP: 6, npLevels: [3, 6, 9, 12], npRange: [3, 9],
    note: 'single-stranded messenger RNA, usually 1–5 kb' },
  { id: 'siRNA', label: 'siRNA', massPerPhosphate: 333, defaultNP: 3, npLevels: [1.5, 3, 4.5, 6], npRange: [2, 6],
    note: 'a ~21-bp double-stranded small interfering RNA, ~13.3 kDa' },
];
export const DEFAULT_CARGO = 'mRNA';

/** The entry for a cargo id; mRNA for anything unknown or missing (records made before there was a choice). */
export function cargoInfo(id) {
  return CARGO_TYPES.find((c) => c.id === id) || CARGO_TYPES.find((c) => c.id === DEFAULT_CARGO);
}

/** The cargo of a plan, its lot standing in where the plan says nothing; mRNA for an older record. */
export function cargoOf(plan, lot = null) {
  return cargoInfo(plan?.rna?.cargo || lot?.cargo).id;
}

/** The word on the labels: "mRNA", "siRNA". */
export const cargoLabel = (id) => cargoInfo(id).label;

const pos = (v) => (v != null && v !== '' && Number(v) > 0 ? Number(v) : null);

/**
 * g/mol of RNA per phosphate for a plan: its own number, its lot's, or its cargo's default. The N/P is
 *   N/P = (ionizable lipid mmol) / (RNA mg ÷ mass per phosphate).
 */
export function massPerPhosphate(plan, lot = null) {
  return pos(plan?.rna?.massPerPhosphate) ?? pos(lot?.massPerPhosphate) ?? cargoInfo(cargoOf(plan, lot)).massPerPhosphate;
}

/** The mass per phosphate a lot is worked out with: its own, or its cargo's default. */
export function lotMassPerPhosphate(lot) {
  return pos(lot?.massPerPhosphate) ?? cargoInfo(lot?.cargo).massPerPhosphate;
}

/** "3 mg siRNA". For one line on a record or a report. */
export function cargoAmount(mg, id, digits = 3) {
  const x = Number(mg);
  return Number.isFinite(x) ? `${Math.round(x * 10 ** digits) / 10 ** digits} mg ${cargoLabel(id)}` : `– mg ${cargoLabel(id)}`;
}
