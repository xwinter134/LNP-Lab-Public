// The catalogue: everything the app can plan, grouped by the question it answers.
//
// The planner asks what you are trying to do and hands down one answer. This is the other half of the same
// idea: the whole shelf, laid out so you can choose yourself and see what each choice costs. Someone who
// already knows they want a Box-Behnken should not have to answer three questions to get one.
//
// Run counts are not written here. They are computed from `codedDesign`, the same generator the DoE screen
// uses, so the number on the catalogue is the number of batches the app will actually produce. A table of
// hand-written run counts drifts from the code within two releases and then quietly lies.
import { DESIGN_TYPES, codedDesign, scheffeTermCount } from './doe.js';
import { TYPES } from './experiment.js';

/**
 * The questions, in the order a project meets them. Simple experiments come first because they are where
 * almost every project starts, and where most of the lab's experiments stay: one recipe, the same recipe
 * again, or a few recipes side by side. They used to sit under "Getting your bearings" between the designs,
 * where a user looking for "the reproducibility one" did not think to look (usability feedback, UX revision).
 * The blurbs are one line on screen; the reasoning lives in each entry's fold and behind its `?`.
 */
export const CATEGORIES = [
  { id: 'simple', title: 'Simple experiments',
    blurb: 'One recipe, the same recipe again, or a few side by side. No factors to choose.' },
  { id: 'screen', title: 'Which factors matter',
    blurb: 'Many candidate factors, two levels each: a cheap first look.' },
  { id: 'surface', title: 'Where the optimum is',
    blurb: 'Two or three factors that matter, three levels each, to find the best combination.' },
  { id: 'sequential', title: 'Learning between rounds',
    blurb: 'A few batches at a time; a model picks the next ones.' },
  { id: 'time', title: 'How it behaves over time',
    blurb: 'Storage over weeks; nothing in the process varies.' },
];

const DOE = (design, rest) => ({ id: design, kind: 'doe', design, name: DESIGN_TYPES[design].name, levels: DESIGN_TYPES[design].levels, ...rest });

/**
 * One entry per thing you can actually set up.
 * `kind` decides where "Set this up" goes: a DoE design opens the wizard with the design chosen, an
 * experiment type opens the wizard at that type, and the two sequential entries open the ML module.
 */
export const CATALOG = [
  /* ---- simple experiments ---- */
  { id: 'single', kind: 'type', type: 'single', category: 'simple', name: 'Single formulation', runs: () => 1,
    answers: 'Does this recipe work, and where does it land?',
    what: 'One recipe, run as written and measured properly.',
    estimates: [], cannot: 'Nothing about any factor. One point is one point.',
    when: 'A new lipid, a new cargo, or a new rig. Find out whether the thing works at all and roughly where the result lands before you spend a design on it.',
    note: 'Also the fastest way to give a model its first row.', topic: 'doe',
    screen: 'experiments?new=1&type=single' },

  { id: 'reference', kind: 'type', type: 'reference', category: 'simple', name: 'Reference reproducibility', runs: () => 3,
    answers: 'How much do identical batches differ?',
    what: 'The same recipe three or more times, ideally on different days.',
    estimates: ['measurement noise'], cannot: 'Anything about factors you did not vary.',
    when: 'Before you believe any difference between two batches. The spread across identical runs is the yardstick every later comparison is measured against.',
    note: 'The most skipped and most valuable experiment in the catalogue. Without it, no effect size means anything, and the app has to guess your noise floor.',
    topic: 'noise', screen: 'experiments?new=1&type=reference' },

  { id: 'comparison', kind: 'type', type: 'comparison', category: 'simple', name: 'Compare compositions', runs: () => 4,
    answers: 'Which of these recipes is best?',
    what: 'Several compositions made through one identical process.',
    estimates: ['differences between recipes'], cannot: 'Why a recipe is better, or how it would behave at other settings.',
    when: 'Choosing between candidate formulations, or qualifying a new lipid lot against the incumbent.',
    note: 'Holding the process fixed is the whole point. A comparison with a drifting process compares nothing.',
    topic: 'randomise', screen: 'experiments?new=1&type=comparison' },

  /* ---- which factors matter ---- */
  DOE('plackett_burman', { category: 'screen', model: 'linear', center: 3, minFactors: 2, maxFactors: 11,
    answers: 'Which of many factors matter?',
    what: 'A two-level design that spends every run on separating main effects, in the next multiple of four runs.',
    estimates: ['main effects'], cannot: 'Interactions. They are deliberately confounded with the main effects, which is how it stays this cheap.',
    when: 'Five or more candidate factors and a budget that cannot cover a factorial. The classic first design.',
    note: 'Add centre points and the design also tells you whether the response is curved, which is your signal to move to a surface.',
    topic: 'screening', screen: 'experiments?new=1&type=doe&design=plackett_burman&model=linear&center=3' }),

  DOE('full_factorial', { category: 'screen', model: 'interaction', center: 3, minFactors: 2, maxFactors: 5,
    answers: 'Which factors matter, and do they interact?',
    what: 'Every corner of the box: two levels for each factor, all combinations.',
    estimates: ['main effects', 'all interactions'], cannot: 'Curvature. Two levels can only fit a plane through each axis.',
    when: 'Two to four factors you already suspect matter, and you need to know whether they interact. For lipid nanoparticles they usually do: flow rate ratio and total flow are not independent.',
    note: 'Doubles with every factor added, so five factors is sixteen runs plus centres and four is usually the practical ceiling.',
    topic: 'doe', screen: 'experiments?new=1&type=doe&design=full_factorial&model=interaction&center=3' }),

  { id: 'ofat', kind: 'type', type: 'ofat', category: 'screen', name: 'One factor at a time (OFAT)', runs: (k, levels = 4) => levels,
    answers: 'How does one factor shape the result?',
    what: 'One parameter walked through several levels while everything else is held fixed.',
    estimates: ['the shape of one factor'], cannot: 'Any interaction, and therefore the optimum of anything but a perfectly separable system.',
    when: 'Mapping one parameter you already know dominates, or when a factor has to be explored on its own for a protocol reason.',
    note: 'Honest warning: this is the least efficient way to spend batches, and the one most likely to leave you at a local optimum. An N/P scan is a reasonable use; a campaign built from scans is not.',
    topic: 'doe', screen: 'experiments?new=1&type=ofat' },

  /* ---- where the optimum is ---- */
  DOE('ccd_faced', { category: 'surface', model: 'quadratic', center: 4, minFactors: 2, maxFactors: 4,
    answers: 'Where is the optimum, inside hard limits?',
    what: 'A factorial box plus axial points sitting on the faces, so every run stays inside the ranges you set.',
    estimates: ['main effects', 'interactions', 'curvature'], cannot: 'Anything outside the box you drew.',
    when: 'The default response surface when your ranges are hardware limits rather than preferences. Flow rates your pump cannot exceed, for instance.',
    note: 'Three levels per factor, which is what makes the quadratic term estimable.',
    topic: 'rsm', screen: 'experiments?new=1&type=doe&design=ccd_faced&model=quadratic&center=4' }),

  DOE('ccd_rotatable', { category: 'surface', model: 'quadratic', center: 4, minFactors: 2, maxFactors: 4,
    answers: 'Where is the optimum, trusted equally in every direction?',
    what: 'The same box, with axial points pushed outside it so the prediction variance depends only on distance from the centre.',
    estimates: ['main effects', 'interactions', 'curvature'], cannot: 'Runs you cannot physically make: the axial points sit beyond your stated low and high.',
    when: 'Ranges that are preferences rather than limits, and you want the model equally trustworthy in every direction.',
    note: 'Check the axial settings before you commit. At five factors the axial points sit well outside the box and are often not makeable.',
    topic: 'rsm', screen: 'experiments?new=1&type=doe&design=ccd_rotatable&model=quadratic&center=4' }),

  DOE('ccd_inscribed', { category: 'surface', model: 'quadratic', center: 4, minFactors: 2, maxFactors: 4,
    answers: 'Where is the optimum, rotatable yet inside your range?',
    what: 'A rotatable design scaled down so the axial points land exactly on your low and high.',
    estimates: ['main effects', 'interactions', 'curvature'], cannot: 'Say much about the corners, which now sit well inside your range.',
    when: 'You want rotatability but cannot leave the box. The compromise is that the factorial corners are no longer at the extremes.',
    note: 'The region actually explored is smaller than the range you typed, which matters when you report what was covered.',
    topic: 'rsm', screen: 'experiments?new=1&type=doe&design=ccd_inscribed&model=quadratic&center=4' }),

  DOE('bbd', { category: 'surface', model: 'quadratic', center: 3, minFactors: 3, maxFactors: 5,
    answers: 'Where is the optimum, without the extreme corners?',
    what: 'Edge midpoints of the box, with no corner runs at all.',
    estimates: ['main effects', 'interactions', 'curvature'], cannot: 'Predict the corners, because it never visits them.',
    when: 'Three or more factors where the extreme combination is a bad idea. Highest flow with lowest PEG and highest lipid at once is often exactly the batch you do not want to make.',
    note: 'Cheaper than a central composite at three factors and keeps every run at a moderate setting.',
    topic: 'rsm', screen: 'experiments?new=1&type=doe&design=bbd&model=quadratic&center=3' }),

  DOE('full_factorial_3', { category: 'surface', model: 'quadratic', center: 2, minFactors: 2, maxFactors: 3,
    answers: 'What does the whole surface look like?',
    what: 'Every combination of three levels per factor.',
    estimates: ['main effects', 'interactions', 'curvature'], cannot: 'Stay affordable: it grows as three to the power of the factor count.',
    when: 'Two factors, or three with a generous budget, where you want the surface mapped evenly rather than efficiently.',
    note: 'Twenty-seven runs for three factors against fifteen for a Box-Behnken. Choose it when coverage matters more than cost.',
    topic: 'rsm', screen: 'experiments?new=1&type=doe&design=full_factorial_3&model=quadratic&center=2' }),

  /* ---- the blend itself ---- */
  { id: 'mixture', kind: 'blend', category: 'surface', name: 'Lipid blend (mixture design)',
    runs: (k) => scheffeTermCount(k || 3, 'quadratic') + 5 + 3,
    answers: 'Which lipid blend works best?',
    what: 'The lipids you name, each over a mol% range, as compositions that span the region those ranges leave.',
    estimates: ['what each lipid contributes', 'whether two lipids blend better or worse than their average'],
    cannot: 'Separate a lipid from what it displaces. On a simplex nothing is held constant, so every effect is a direction, not a culprit.',
    when: 'The lipids are the question. Above all when two of the same class are in play — two ionizable lipids, or a second PEG — which a class-based factor cannot tell apart.',
    note: 'The design lives on a simplex and the model is a Scheffé polynomial with no intercept, because four mol% that sum to 100 have three degrees of freedom and a constant column would be a combination of them.',
    topic: 'mixture', screen: 'experiments?new=1&type=doe&mode=mixture' },

  { id: 'crossed', kind: 'blend', category: 'surface', name: 'Blend and process together',
    runs: (k) => (scheffeTermCount(k || 3, 'quadratic') * 3) + 5 + 3,
    answers: 'Does the best blend change with the process?',
    what: 'One experiment over both: every run has a composition and a process setting, chosen together.',
    estimates: ['everything a blend design does', 'whether the best blend changes when the process does'],
    cannot: 'Stay small. The candidates are the product of the two sides, so a run budget and a D-optimal selection are doing the real work.',
    when: 'You suspect the blend you optimised at one flow rate will not be the best blend at another. Two separate experiments cannot answer that, because neither has runs where both differ.',
    note: 'The crossed model multiplies every blending term by every process term. That is what lets it say the shape of the blend response depends on the setting.',
    topic: 'mixture', screen: 'experiments?new=1&type=doe&mode=crossed' },

  /* ---- learning between rounds ---- */
  { id: 'seed', kind: 'ml', category: 'sequential', name: 'Space-filling starting set', runs: (k) => Math.max(4, Math.min(8, 3 * (k || 2))),
    answers: 'Where to start when nothing is measured?',
    what: 'Settings chosen to cover the space rather than to cluster around one guess.',
    estimates: ['the rough shape of the response'], cannot: 'Give you a formal effect table with p-values.',
    when: 'Nothing measured yet and you would rather spread the first batches than commit to a classical design.',
    note: 'This is the first round of a model-led campaign. The runs feed the same model a design would.',
    topic: 'bo', screen: 'ml' },

  { id: 'rounds', kind: 'ml', category: 'sequential', name: 'Model-led rounds', runs: () => 4,
    answers: 'Which batches should come next?',
    what: 'Fit a surface to everything measured so far, then pick the next few runs where predicted quality and remaining uncertainty are most promising together.',
    estimates: ['a predicted optimum', 'how far the model can be trusted'], cannot: 'Work from nothing. It needs about eight measured runs before it says anything useful, and about fifteen before its quality can be tested honestly.',
    when: 'Eight or more runs already on file, several goals at once, and the freedom to run in small batches.',
    note: 'Each round uses everything learned so far, which is why it beats committing a whole design up front when you can afford to wait between rounds.',
    topic: 'bo', screen: 'ml' },

  /* ---- over time ---- */
  { id: 'stability', kind: 'type', type: 'stability', category: 'time', name: 'Stability study', runs: () => 2,
    answers: 'How long does it stay good, and where?',
    what: 'One batch per formulation you want to follow, split across storage conditions and measured on a timepoint schedule.',
    estimates: ['change over time per condition'], cannot: 'Tell you why something degraded, if the process varied at the same time.',
    when: 'Shelf life, shipping conditions, or a formulation change you need to defend later.',
    note: 'Day zero has to come off the same aliquot stream as the later points. Reminders and the measurement schedule appear in the calendar once it is created.',
    topic: 'stability', screen: 'experiments?new=1&type=stability' },
];

/** How many batches this entry costs at k factors, or null when k is outside what the design supports. */
export function runsFor(e, k, centerPoints) {
  if (e.kind !== 'doe') return e.runs(k);
  if (!fitsFactors(e, k)) return null;
  const centers = centerPoints == null ? (e.center || 0) : centerPoints;
  try {
    const { pts, centers: c } = codedDesign({ designType: e.design, factors: new Array(k).fill(0), centerPoints: centers, replicates: 1 });
    return pts.length + c.length;
  } catch { return null; }
}

/** Whether a design can be run at all with k factors. */
export function fitsFactors(e, k) {
  if (e.kind !== 'doe') return true;
  return k >= (e.minFactors || 2) && k <= (e.maxFactors || 8);
}

export const catalogIn = (categoryId) => CATALOG.filter((e) => e.category === categoryId);
export const catalogEntry = (id) => CATALOG.find((e) => e.id === id) || null;

/** The hash the "Set this up" button points at, carrying the factors when the caller has them. */
export function setupLink(e, factorKeys = []) {
  const keys = factorKeys.filter(Boolean).join(',');
  if (!keys) return `#/${e.screen}`;
  return `#/${e.screen}${e.screen.includes('?') ? '&' : '?'}factors=${encodeURIComponent(keys)}`;
}

/** Everything in the catalogue that fits a budget of n batches at k factors, cheapest first. */
export function affordable(n, k) {
  return CATALOG.map((e) => ({ e, runs: runsFor(e, k) }))
    .filter((x) => x.runs != null && x.runs <= n)
    .sort((a, b) => a.runs - b.runs);
}

/** Cross-check: every design the DoE screen offers, and every experiment type, has a catalogue entry. */
export function catalogGaps() {
  const designs = Object.keys(DESIGN_TYPES).filter((d) => !CATALOG.some((e) => e.kind === 'doe' && e.design === d));
  const types = TYPES.map((t) => t.id).filter((t) => t !== 'doe' && !CATALOG.some((e) => e.kind === 'type' && e.type === t));
  return { designs, types };
}
