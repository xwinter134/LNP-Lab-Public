// What should I run next? The reasoning behind the planner.
//
// Kept separate from the screen so the advice can be tested, read and argued with. Every recommendation
// carries its reasons; a planner that hands down an answer without them teaches nothing and cannot be
// corrected when it is wrong about your chemistry.
//
// The factor rankings come from the formulation literature and are deliberately conservative: flow rate
// ratio, ethanol fraction and total flow dominate size and dispersity; N/P, assembly pH and ionizable mol%
// dominate encapsulation. See docs/LEARN.md for the sources.

/** What the user is trying to do. The first question, because everything else depends on it. */
export const AIMS = [
  { id: 'first', title: 'Make a first batch of something new', blurb: 'A new lipid, a new composition, or a new cargo. Nothing measured yet.' },
  { id: 'size', title: 'Hit a particle size target', blurb: 'The particles come out, but not at the size you want.' },
  { id: 'ee', title: 'Raise encapsulation', blurb: 'Too much RNA is staying outside the particles.' },
  { id: 'screen', title: 'Find out which factors matter', blurb: 'Several things could be driving the result and you do not know which.' },
  { id: 'optimise', title: 'Find the best settings', blurb: 'You know which factors matter and want the combination that works best.' },
  { id: 'robust', title: 'Check it is reproducible', blurb: 'It worked once. You need to know it will work again.' },
  { id: 'stability', title: 'Check it stays good', blurb: 'How the material behaves over weeks at a storage temperature.' },
  { id: 'trouble', title: 'Work out what went wrong', blurb: 'A result is off and you want the likely causes in order.' },
];

/** The symptom list for the troubleshooting path, each with ordered causes and the check that settles it. */
export const SYMPTOMS = [
  { id: 'big', title: 'Particles larger than expected',
    causes: [
      { key: 'tfr', cause: 'Mixing is too slow for the particles to nucleate uniformly', why: 'When the two streams blend slowly the ethanol falls slowly, nucleation is sparse and each particle grows larger.', check: 'The total flow rate on these batches against the ones that gave the size you wanted.', fix: 'Raise the total flow rate and hold everything else, then compare.', topic: 'tfr' },
      { key: 'frr', cause: 'Flow rate ratio too low', why: 'A lower aqueous-to-organic ratio leaves more ethanol after mixing, so particles stay fluid longer and keep fusing.', check: 'Compare your ratio with the 3:1 that most protocols use.', fix: 'Raise the ratio toward 4:1 or 5:1 and re-measure.', topic: 'frr' },
      { key: 'peg', cause: 'PEG-lipid too low', why: 'PEG stops particle growth by covering the surface. Less of it means growth runs longer before it is arrested.', check: 'Look at the composition: below about 1.0 mol% is low.', fix: 'Raise PEG by 0.5 mol% and expect roughly 10 to 20 nm off the size.', topic: 'peg' },
      { key: 'quench', cause: 'Quench too late or too small', why: 'Particles rearrange while ethanol is above about 20 per cent. A late dilution lets that continue in the tubing.', check: 'Work out the ethanol fraction after the quench and the volume between the junction and the quench point.', fix: 'Quench sooner, or raise the dilution factor.', topic: 'quench' },
    ] },
  { id: 'pdi', title: 'PDI too high',
    causes: [
      { key: 'tfr', cause: 'Mixing is not uniform across the stream', why: 'When different parts of the stream nucleate at different supersaturations the distribution is wide by construction, whatever the formulation does.', check: 'Whether the wide batches share a low total flow rate.', fix: 'Raise the total flow rate.', topic: 'tfr' },
      { key: 'aggregate', cause: 'Aggregation after formulation', why: 'A second population of fused particles widens the distribution long before it moves the average much.', check: 'Look at the intensity distribution, not just the PDI. A shoulder above 200 nm is aggregation.', fix: 'Check PEG and cholesterol content, and the ionic strength of the final buffer.', topic: 'pdi' },
      { key: 'sampleprep', cause: 'Sample preparation', why: 'Dust and bubbles scatter strongly and are read as very large particles.', check: 'Re-measure a filtered dilution in a clean cuvette.', fix: 'Filter the diluent, not the sample.', topic: 'size' },
      { key: 'quench', cause: 'Quench too late', why: 'Particles that keep growing do not all grow equally.', check: 'Volume and timing between mixing and dilution.', fix: 'Quench sooner.', topic: 'quench' },
    ] },
  { id: 'ee', title: 'Encapsulation too low',
    causes: [
      { key: 'np', cause: 'N/P ratio too low', why: 'Not enough protonatable amine to condense all the RNA, so some never enters a particle.', check: 'Compute N/P from the batch record. Below about 4 is low.', fix: 'Raise N/P to 6 and re-measure. This is the fastest lever.', topic: 'np' },
      { key: 'ph', cause: 'Assembly pH too close to the lipid apparent pKa', why: 'If the amine is only partly protonated it binds RNA weakly.', check: 'Compare the formulation buffer pH with the apparent pKa of the composition.', fix: 'Lower the assembly buffer by half a unit, toward pH 4.', topic: 'bufferph' },
      { key: 'ionizable', cause: 'Ionizable lipid mol% too low', why: 'Fewer binding sites per particle.', check: 'Composition: below about 35 mol% is low for most systems.', fix: 'Raise the ionizable lipid and let cholesterol absorb the change.', topic: 'ionizable' },
      { key: 'assay', cause: 'Assay artefact', why: 'A low total-RNA reading inflates the apparent encapsulation; a high one deflates it.', check: 'Confirm the detergent arm of the RiboGreen assay recovers the expected total.', fix: 'Re-run the assay with a fresh standard curve.', topic: 'ee' },
    ] },
  { id: 'repro', title: 'Results are not reproducible',
    causes: [
      { key: 'noise', cause: 'You have not measured your noise', why: 'Without repeats of one setting there is no way to tell a real difference from the ordinary spread of the method.', check: 'Count how many times you have run the same setting twice.', fix: 'Repeat one standard recipe three times. Everything afterwards is interpretable.', topic: 'noise' },
      { key: 'lot', cause: 'Stock or lot changed between runs', why: 'A new lipid stock or RNA lot shifts concentration and purity, which moves N/P and size together.', check: 'Group your results by stock lot and look for a step.', fix: 'Record the lot on every batch and compare within lots.', topic: 'splits' },
      { key: 'runorder', cause: 'Drifting between morning and afternoon', why: 'Temperature, operator and reagent age all drift, and a run order that follows a factor turns that drift into a fake effect.', check: 'Plot the result against the order the runs were made in.', fix: 'Randomise the run order from now on.', topic: 'randomise' },
      { key: 'threshold', cause: 'Sitting where the process changes behaviour', why: 'Mixing does not respond smoothly everywhere: near a threshold a setting can fall on either side from one day to the next, and the two sides give different particles.', check: 'Whether the runs that disagree share a flow setting close to one another but land far apart.', fix: 'Move the setting away from where the results stop being reproducible.', topic: 'tfr' },
    ] },
  { id: 'aggregate', title: 'Aggregation or visible precipitate',
    causes: [
      { key: 'peg', cause: 'Not enough surface stabiliser', why: 'PEG-lipid is what keeps particles from finding each other.', check: 'PEG mol%, and whether it was below 1.0.', fix: 'Raise PEG to at least 1.5 mol%.', topic: 'peg' },
      { key: 'cryo', cause: 'Frozen without a cryoprotectant', why: 'Ice formation concentrates and crushes the particles.', check: 'Was sucrose present at 5 to 10 per cent before freezing?', fix: 'Add sucrose before freezing, or hold at 4 °C.', topic: 'stability' },
      { key: 'ionic', cause: 'Final buffer ionic strength too high', why: 'Screening the small residual surface charge removes what little electrostatic repulsion there is.', check: 'The dialysis buffer composition.', fix: 'Move to a lower ionic strength final buffer.', topic: 'zeta' },
      { key: 'sterol', cause: 'Cholesterol too low after varying other lipids', why: 'Cholesterol fills packing defects; without it the shell leaks and particles fuse.', check: 'Composition total and the cholesterol share.', fix: 'Keep cholesterol above about 20 mol%.', topic: 'sterol' },
    ] },
  { id: 'potency', title: 'Potency low although size, PDI and encapsulation are fine',
    causes: [
      { key: 'pka', cause: 'Apparent pKa outside the useful window', why: 'The physical measures say the particle formed; the pKa says whether it will release its cargo in the endosome. Potency falls away sharply on both sides of the window, roughly twentyfold by pKa 5.6 and fivefold by 6.9.', check: 'Measure apparent pKa by TNS on the assembled particle, titrating pH 3 to 10. For liver delivery the window is about 6.2 to 6.5.', fix: 'Outside the window, change the ionizable lipid or its mol% and measure again. Inside it, stop here: the right pKa is necessary and not sufficient, and the next suspects are the lipid tails, the linker and endosomal escape rather than anything on this list.', topic: 'pka' },
      { key: 'helper', cause: 'Helper lipid chosen for stability rather than escape', why: 'A saturated helper such as DSPC gives a stable particle that is less willing to fuse with the endosomal membrane.', check: 'Which helper lipid is in the composition.', fix: 'Compare the same formulation with DOPE, accepting the shelf-life cost.', topic: 'helper' },
      { key: 'np_high', cause: 'N/P so high that free lipid dominates', why: 'Excess ionizable lipid forms empty particles that compete for uptake and add toxicity.', check: 'Compute N/P from the batch record. Above about 10 there is more ionizable lipid than the cargo needs.', fix: 'Bring N/P back toward 6 and compare potency at matched RNA dose.', topic: 'np' },
      { key: 'cargo', cause: 'Cargo rather than carrier', why: 'An untranslatable or degraded RNA gives a perfect particle with no effect.', check: 'RNA integrity and a positive control cargo in the same formulation.', fix: 'Re-run with a known-good control RNA.', topic: 'ee' },
    ] },
];

/**
 * Which factors move which response, strongest first, with the reason a formulator would give.
 *
 * The bands follow the gradient-boosted importances in Sato et al. 2024 (Chem Pharm Bull 72:529-539, Fig. 5)
 * where that study measured the factor, and the formulation literature otherwise. One finding of theirs the
 * app cannot act on: formulation buffer pH is their single strongest driver of particle size, above ethanol
 * fraction, and this app has no per-batch field for it, so it cannot be varied, ranked or suggested here.
 * That gap is named in docs/literature/sato-2024.md rather than papered over with a factor that would read
 * as missing from every run on file.
 */
export const DRIVERS = {
  particle_size_nm: [
    { key: 'frr', strength: 'strong', why: 'sets how fast the ethanol is diluted, and so how early nucleation starts' },
    { key: 'peg_pct', strength: 'strong', why: 'stops particle growth, so more of it gives smaller particles' },
    { key: 'tfr', strength: 'weak', why: 'sets mixing speed, though measured importance for size is low next to the ethanol fraction' },
    { key: 'lipid_mM', strength: 'weak', why: 'changes the amount of material available per nucleus' },
  ],
  PDI: [
    { key: 'tfr', strength: 'moderate', why: 'uniform mixing is what makes a narrow distribution, though it measures far below the ethanol fraction' },
    { key: 'frr', strength: 'moderate', why: 'changes the residence time during which particles can still rearrange' },
    { key: 'quench', strength: 'moderate', why: 'decides when growth is arrested' },
    { key: 'peg_pct', strength: 'moderate', why: 'too little and a second, larger population appears' },
  ],
  encapsulation_efficiency: [
    { key: 'np', strength: 'strong', why: 'sets how much positive charge is available to condense the RNA' },
    { key: 'ionizable_pct', strength: 'strong', why: 'sets how many binding sites each particle carries' },
    { key: 'frr', strength: 'strong', why: 'changes how quickly the RNA and the lipid meet, and measures as the dominant process lever on encapsulation' },
    { key: 'rna_mg_mL', strength: 'weak', why: 'changes the local concentration at the junction' },
  ],
  zeta_potential_mV: [
    { key: 'ionizable_pct', strength: 'strong', why: 'the ionizable lipid is what carries residual charge' },
    { key: 'peg_pct', strength: 'moderate', why: 'the PEG brush shields whatever charge is there' },
  ],
};

/** Budget bands, because the right design is mostly a function of how many batches you can run. */
export const BUDGETS = [
  { id: 'tiny', title: '1 to 3 batches', n: 3 },
  { id: 'small', title: '4 to 8 batches', n: 8 },
  { id: 'medium', title: '9 to 16 batches', n: 16 },
  { id: 'large', title: '17 to 30 batches', n: 30 },
  { id: 'campaign', title: 'More than 30, over several rounds', n: 48 },
];

export const SCOPES = [
  { id: 'process', title: 'Process only', blurb: 'Flow rates, ratios, quench. Nothing about the recipe changes.' },
  { id: 'composition', title: 'Process and composition', blurb: 'Lipid mol% as well. More to explore, and a different regulatory conversation later.' },
  { id: 'fixed', title: 'Nothing: the recipe is fixed', blurb: 'You are running a known formulation and want to confirm or monitor it.' },
];

const F = (key, why, strength) => ({ key, why, strength });

/** The factors that change the recipe rather than the process. Out of scope unless composition is on the table. */
const COMPOSITION = ['peg_pct', 'ionizable_pct', 'helper_pct', 'sterol_pct'];

/** Why a factor matters, wherever it is listed as a driver. Falls back to the one thing that is always true. */
const reasonFor = (key) => Object.values(DRIVERS).flat().find((d) => d.key === key)?.why
  || 'varied across your batches, so the model has something to learn from it';

/**
 * The recommendation.
 * @param {object} a {aim, symptom, budget, scope, measuredRuns, hasReplicates, factorsVaried, worstResponse}
 * @returns {{headline, plan, runs, factors, type, screen, because:[], expect:[], watch:[], topics:[], alternatives:[]}}
 */
export function advise(a) {
  const budget = BUDGETS.find((b) => b.id === a.budget) || BUDGETS[1];
  const n = a.measuredRuns ?? 0;
  const scope = a.scope || 'process';
  const canComposition = scope === 'composition';
  const out = { because: [], expect: [], watch: [], topics: [], alternatives: [] };

  /* ---- paths that do not depend on budget ---- */
  if (a.aim === 'stability') {
    return { ...out, headline: 'A stability study, not an optimisation',
      plan: 'One batch per formulation you want to follow, split across storage conditions, measured on a timepoint schedule.',
      type: 'stability', screen: 'experiments?new=1&type=stability', runs: Math.min(budget.n, Math.max(1, Math.min(4, budget.n))),
      factors: [],
      because: ['Stability is a question about time, not about settings. Varying the process at the same time would make it impossible to say which caused a change.',
        'Day 0 has to be measured on the same aliquot stream as the later points, or you are comparing two different things rather than measuring a change.'],
      expect: ['PDI widens before the average size moves. Encapsulation falls as cargo leaks. Potency usually falls fastest of all.',
        'Reminders and a measurement schedule appear in the calendar once the experiment is created.'],
      watch: ['Freezing without a cryoprotectant will look like an unstable formulation. Sucrose at 5 to 10 per cent usually fixes it.'],
      topics: ['stability', 'pdi', 'peg'] };
  }

  if (a.aim === 'trouble') {
    const sym = SYMPTOMS.find((s) => s.id === a.symptom);
    return { ...out, headline: sym ? `Likely causes of ${sym.title.toLowerCase()}, in order` : 'Pick a symptom',
      plan: sym ? 'Work down the list. Each one names the check that settles it before you spend a batch.' : '',
      type: 'diagnose', screen: '', runs: 0, factors: [], symptom: sym || null,
      because: sym ? ['The order is by how often each cause turns out to be the one, and by how cheap the check is.'] : [],
      expect: sym ? ['Most of these are answered by looking at a record you already have, not by running anything.'] : [],
      watch: sym ? ['If the first two checks come back clean, stop guessing and measure your noise. An effect smaller than your repeat spread is not an effect.'] : [],
      topics: sym ? [...new Set(sym.causes.map((c) => c.topic))] : [] };
  }

  if (a.aim === 'robust') {
    const runs = Math.min(budget.n, Math.max(3, Math.min(6, budget.n)));
    return { ...out, headline: `Repeat a recipe ${runs} times`,
      plan: 'The same formulation and settings, on at least two different days. With five or more batches, split them over two recipes rather than one.',
      type: 'reference', screen: 'experiments?new=1&type=reference', runs, factors: [],
      because: ['The spread across identical runs is your measurement noise, and every other number you will ever quote is a comparison against it.',
        'Spreading the repeats across days catches the drift that repeats on one afternoon will hide.'],
      expect: [`A standard deviation for each response. For DLS size expect 1 to 3 per cent, for PDI about 0.01 to 0.02, for encapsulation 2 to 5 per cent.`,
        'The app then anchors the noise floor in every model it fits on this figure, which makes its quality figures honest.'],
      watch: ['Running all the repeats back to back understates the noise you will actually see between sessions.',
        `An estimate from ${runs} batches rests on ${runs - 1} degree${runs === 2 ? '' : 's'} of freedom and runs high, which is why the app treats it as a starting point the model may argue with rather than as a measured constant.`],
      topics: ['noise', 'center', 'splits'] };
  }

  /* ---- the optimisation family ---- */
  const target = a.aim === 'ee' ? 'encapsulation_efficiency' : a.aim === 'size' ? 'particle_size_nm' : null;
  const RANK = { strong: 3, moderate: 2, weak: 1 };
  let pool;
  if (target) pool = DRIVERS[target].map((d) => F(d.key, d.why, d.strength));
  else {
    // No single target, so every response counts. A factor that is strong for one and moderate for another is
    // strong: keeping the first mention instead would rank a factor by whichever response happened to come
    // first in the list, which is an accident of how this file is written rather than a fact about chemistry.
    const best = new Map();
    for (const d of [...DRIVERS.particle_size_nm, ...DRIVERS.encapsulation_efficiency, ...DRIVERS.PDI]) {
      const prev = best.get(d.key);
      if (!prev || RANK[d.strength] > RANK[prev.strength]) best.set(d.key, d);
    }
    pool = [...best.values()].map((d) => F(d.key, d.why, d.strength));
  }
  if (!canComposition) pool = pool.filter((f) => !COMPOSITION.includes(f.key));
  pool = pool.sort((x, y) => RANK[y.strength] - RANK[x.strength]);
  const strong = pool.filter((f) => f.strength === 'strong');

  // What the budget can actually support. A design shrunk below its minimum does not answer a smaller
  // version of the question, it answers nothing: a two-level screen needs its four corners and a couple of
  // centre points, and the smallest response surface worth fitting is about thirteen runs. Below each
  // threshold the honest answer is the best thing the budget can buy, not a design with the runs removed.
  const canScreen = budget.n >= 6;
  const canSurface = budget.n >= 13;

  // Order matters here. A screening design is a legitimate starting point with no data at all — better than a
  // space-filling set when there are four or more candidate factors — so an explicit request to screen is
  // honoured before the "you have nothing yet" branch, not after it.
  if (a.aim === 'screen' && canScreen) {
    // A screen needs roughly twice as many runs as factors plus centre points. With a small budget the
    // answer is fewer factors, not a design that cannot separate them.
    const runs = Math.min(budget.n, Math.max(8, Math.min(12, budget.n)));
    const affordable = Math.max(2, Math.min(5, Math.floor((runs - 2) / 2)));
    const factors = pool.slice(0, Math.min(affordable, pool.length));
    return { ...out, headline: `Screen ${factors.length} factor${factors.length === 1 ? '' : 's'} in ${runs} runs`,
      plan: 'A two-level design at the edges of each range, plus centre points.',
      type: 'screen', screen: 'experiments?new=1&type=doe', runs, factors,
      because: ['The expensive early mistake is optimising the wrong factor. A screen rules most of them out cheaply.',
        'Two levels per factor is enough to say whether a factor matters. It is not enough to find an optimum, and it is not meant to be.',
        'Wide ranges are deliberate: a factor that does nothing across a wide range genuinely does nothing.',
        runs < 8 ? `${runs} batches is below what a screen comfortably needs, so this one covers ${factors.length} factor${factors.length === 1 ? '' : 's'} rather than all the candidates. Expect a ranking rather than numbers.` : ''].filter(Boolean),
      expect: ['A ranking of the factors with a rough effect size for each. Usually two or three matter and the rest do not.',
        'Curvature will show up as the centre points sitting off the average of the corners. That is your signal to move to a response surface next.'],
      watch: ['Do not read interactions out of a screening design. It was not built to estimate them.'],
      topics: ['screening', 'doe', 'center'] };
  }

  // Reached by an explicit request to screen on a budget that cannot carry one, as well as by a first batch
  // and by any budget too small for a response surface. A spread-out set feeds the same model a design would
  // and costs what the budget has.
  if (a.aim === 'first' || (n < 8 && !canSurface)) {
    // Never propose more runs than the budget allows. Below four there is no design worth the name, so the
    // honest advice is to make one at a standard setting and come back, not to shrink a design until it
    // cannot answer anything.
    const runs = Math.min(budget.n, Math.max(4, Math.min(8, budget.n)));
    const tooFew = runs < 4;
    const factors = pool.slice(0, tooFew ? 1 : Math.min(3, Math.max(2, pool.length)));
    if (tooFew) {
      return { ...out, headline: `Make ${runs === 1 ? 'one batch' : `${runs} batches`} at a standard setting first`,
        plan: 'One recipe, run as written, measured properly. No factors varied yet.',
        type: 'baseline', screen: 'experiments?new=1&type=single', runs, factors: [],
        because: [`${runs} batch${runs === 1 ? '' : 'es'} cannot support a design: the smallest thing that tells you anything about a factor needs four, and the smallest thing that tells you about several needs eight.`,
          'What a first batch does tell you is whether the system works at all, and roughly where the result lands. That is what the next design needs in order to set its ranges.',
          'It also gives the model its first row, which is worth more than a design too small to fit.'],
        expect: ['A size, a PDI and an encapsulation figure for one recipe, and a sense of whether anything is obviously wrong.',
          'Come back here with that result and a larger budget, and the planner will have something to work from.'],
        watch: [`With ${runs} batch${runs === 1 ? '' : 'es'} there is no way to tell a real effect from the ordinary spread of the method. Treat anything you see as provisional until a setting has been run twice.`],
        topics: ['noise', 'size', 'ee'] };
    }
    return { ...out, headline: `A spread-out set of ${runs} runs to ${n ? 'extend what you have' : 'find out how your system behaves'}`,
      plan: 'Settings chosen to cover the space rather than to cluster around one guess, so the first model has something to learn from.',
      type: 'seed', screen: 'ml', runs, factors,
      because: [n
        ? `${n} measured run${n === 1 ? '' : 's'} is not yet enough for a model to lead, and ${budget.n} batches is below the thirteen or so a response surface needs. Spreading these across the space is what gets you to both.`
        : 'With nothing measured, any single setting is a guess, and a run next to it tells you almost nothing new.',
        a.aim === 'screen' ? `A formal screen needs at least four corner runs and a centre point before it can separate anything, which this budget cannot cover. A spread-out set costs what you have and the model reads it factor by factor, which answers the same question less formally.` : '',
        'A space-filling set answers the first question worth asking: over the range you can actually run, how much does the result move at all?',
        factors.length ? `The factors chosen are the ones that move these responses most: ${factors.map((f) => f.key).join(', ')}.` : ''].filter(Boolean),
      expect: ['A wide range of results, including some you would not want to make. That is the point.',
        `After these, the app can fit a ${n ? 'better' : 'first'} model and start proposing runs rather than guessing.`],
      watch: ['Resist narrowing the ranges before you have seen a result. Narrow ranges early is how a campaign ends up polishing a local optimum.'],
      topics: ['doe', 'bo', 'gp'],
      alternatives: [{ title: 'A classical design instead', screen: 'experiments?new=1&type=doe', why: 'If you would rather have a protocol, a worksheet and a formal analysis, the DoE screen builds one. The runs feed the same model afterwards.' }] };
  }

  if (n >= 8) {
    const runs = Math.min(budget.n, Math.max(2, Math.min(8, Math.floor(budget.n / 2) || budget.n)));
    // Factors you have already moved are the ones the model can learn from, so they lead. They still carry the
    // reason they matter: "already varied" says where the row came from, not what the factor does, and a table
    // that answers the second question is worth more than one that repeats the first five times. A factor
    // outside the chosen scope is dropped here too, or a process-only plan would quietly list the recipe.
    const varied = (a.factorsVaried || []).filter((k) => canComposition || !COMPOSITION.includes(k));
    const factors = (varied.length ? varied.map((k) => F(k, reasonFor(k), 'known')) : strong.length ? strong : pool).slice(0, 5);
    return { ...out, headline: `Let the model propose the next ${runs} runs`,
      plan: `You already have ${n} measured runs. Fit a surface to them and choose the next batch where the combination of predicted quality and remaining uncertainty is most promising.`,
      type: 'ml', screen: 'ml', runs, factors,
      because: [`${n} runs is enough to fit a model per response and, at ${n >= 15 ? 'this size, to test its quality honestly on held-out experiments' : '15 runs, to start testing its quality honestly'}.`,
        // only reachable for an explicit screen when the budget cannot carry one, since a screen that fits is offered first
        a.aim === 'screen' ? 'You asked which factors matter, and a formal screen does not fit in this budget. The attribution the model reports over the runs you already have answers the same question without spending a batch on it.' : '',
        'Choosing a few runs at a time beats committing a whole design up front, because each round uses everything learned so far.',
        'The model reports how far it can be trusted before it proposes anything, so you can see whether to believe it.'].filter(Boolean),
      expect: ['A table of settings with predicted results, their intervals, and the odds of beating your best run so far.',
        'The largest single jump usually comes from the first model-led round. Later rounds tend to tighten the batch rather than move the best result, which is what the published campaigns show: one went from a 4.8-fold to a 14.4-fold result in its first guided round and then to 14.5 in its second.',
        a.hasReplicates ? '' : 'The module will also offer a repeat of your best run, because no optimiser proposes one and your incumbent may be a single lucky measurement.'].filter(Boolean),
      watch: ['Check the model quality card before acting on the numbers. A model that cannot beat predicting the average is a space-filling plan, not a prediction.'],
      topics: ['bo', 'gp', 'q2', 'explore'],
      alternatives: budget.n >= 15 ? [{ title: 'A response surface instead', screen: 'experiments?new=1&type=doe', why: 'If you need a single formal design with a protocol, a face-centred central composite over your two or three strongest factors does it in about 15 to 20 runs.' }] : [] };
  }

  // Enough batches for one formal design, but not enough measured runs for a model to lead: a response surface
  // covers its own space and brings its own centre points, so it does not need a seed round first.
  // Three factors is the practical ceiling for one response-surface design at this budget, and two is the
  // floor: with one there is no surface to speak of, only a curve.
  const factors = (strong.length >= 3 ? strong : pool).slice(0, 3);
  const runs = Math.min(budget.n, Math.max(13, Math.min(20, budget.n)));
  return { ...out, headline: `A response surface over ${factors.length} factors in about ${runs} runs`,
    plan: 'A three-level design, face-centred central composite or Box-Behnken, with centre points.',
    type: 'rsm', screen: 'experiments?new=1&type=doe', runs, factors,
    because: ['An optimum is a place where the response curves over. Two levels can only fit a plane, so they can say which direction is better but never where to stop.',
      'Face-centred keeps every run inside the ranges you set, which matters when those ranges are hardware limits rather than preferences.',
      `Three factors is the practical limit for one design at this budget: a fourth roughly doubles the runs.`],
    expect: ['A fitted surface with an optimum, a map of the region around it, and an honest statement of how well the model predicts runs it has not seen.',
      'Confirmation runs at the predicted optimum are part of the method, not an afterthought.'],
    watch: ['If the optimum lands on the edge of your range, the real one is probably outside it. Move the range and run again rather than trusting an extrapolation.'],
    topics: ['rsm', 'center', 'doe', 'q2'] };
}

/** A short reading list for whatever was recommended. */
export const topicsFor = (rec) => [...new Set(rec.topics || [])];

// ------------------------------------------------------------------------------------------------------------
// The troubleshooting assistant (spec 9.4): context, a diagnosis weighed by it, and a small experiment plan.
//
// The list above gives the causes of a symptom in the order they usually turn out to be the one. That order is
// right on average and wrong for a batch whose record already says otherwise: a PEG of 3 mol% is not too little
// PEG, and an FRR of 2:1 makes the ratio the first suspect for a wide distribution. So the assistant asks for
// the batch's context first (or reads it off a chosen formulation), moves each cause up or down by rules that
// say why, greys out the ones the context rules out, compares with the lab's own similar batches where there
// are any, and turns the two or three likeliest causes that are settings into experiments the existing wizard
// can create. Rule-based, offline and with every reason in words, as the rest of this file is.

/** What the assistant asks about, and the cause lists it weighs. */
export const TROUBLE = [
  { id: 'pdi', title: 'PDI too high', what: 'a high PDI', from: 'pdi',
    extra: [
      { key: 'frr', cause: 'Flow rate ratio too low', why: 'At a low aqueous-to-organic ratio the ethanol stays high for longer after mixing, and particles that keep fusing do not all fuse equally.', check: 'Your ratio against the 3:1 most protocols use.', fix: 'Raise the ratio toward 3:1 or 4:1 and compare the PDI.', topic: 'frr' },
      { key: 'peg', cause: 'Too little PEG-lipid for one population', why: 'With too little PEG on the surface a second, larger population forms beside the first, and the distribution widens before the mean moves.', check: 'PEG mol% in the composition: below about 1.0 is low.', fix: 'Raise PEG by 0.5 mol% and compare.', topic: 'peg' },
    ] },
  { id: 'big', title: 'Particles too large', what: 'large particles', from: 'big', extra: [] },
  { id: 'small', title: 'Particles too small', what: 'small particles',
    causes: [
      { key: 'frr', cause: 'Flow rate ratio higher than the target needs', why: 'A high aqueous-to-organic ratio drops the ethanol fast, nucleation is dense, and many small particles form.', check: 'Your ratio against the 3:1 most protocols use.', fix: 'Lower the ratio toward 3:1 and compare the size.', topic: 'frr' },
      { key: 'peg', cause: 'More PEG-lipid than the target needs', why: 'PEG stops growth early: the more of it, the sooner particles stop growing.', check: 'PEG mol% in the composition: above about 2.5 is high.', fix: 'Lower PEG by 0.5 mol% and compare.', topic: 'peg' },
      { key: 'tfr', cause: 'Mixing faster than the target needs', why: 'Faster mixing nucleates more particles from the same lipid, so each one is smaller.', check: 'The total flow rate against the batches that gave the size you wanted.', fix: 'Lower the total flow rate and hold everything else.', topic: 'tfr' },
      { key: 'sampleprep', cause: 'Empty micelles or the dilution in the cuvette', why: 'Free PEG-lipid micelles and an over-diluted sample both pull an intensity average down.', check: 'The intensity distribution: a peak below 20 nm is micelles, not particles.', fix: 'Measure at the usual dilution, and after dialysis rather than straight after mixing.', topic: 'size' },
    ] },
  { id: 'ee', title: 'Encapsulation too low', what: 'low encapsulation', from: 'ee',
    extra: [
      { key: 'frr', cause: 'Flow rate ratio off the usual 3:1', why: 'The ratio changes how fast RNA and lipid meet at the junction, and measures as the strongest process lever on encapsulation.', check: 'Your ratio against 3:1.', fix: 'Bring the ratio back to 3:1 and compare.', topic: 'frr' },
    ] },
  { id: 'drift', title: 'Drift between batches or in storage', what: 'drift', from: 'repro',
    extra: [
      { key: 'cryo', cause: 'Stored without what keeps it stable', why: 'Frozen without a cryoprotectant, or kept with little PEG, particles fuse over days and the size creeps up.', check: 'Cryoprotectant and storage temperature of the batches that drifted.', fix: 'Add sucrose at 5 to 10 per cent before freezing, or hold at 4 °C, and follow one batch over a week.', topic: 'stability' },
    ] },
];
// The old wizard's symptoms that have a place here, for an address that names one of them.
const TROUBLE_ALIAS = { repro: 'drift', aggregate: 'pdi' };
export const troubleSymptom = (id) => TROUBLE.find((t) => t.id === (TROUBLE_ALIAS[id] || id)) || null;

/** The causes of a symptom: the planner's list for it, then the ones only the assistant adds. */
export function troubleCauses(id) {
  const t = troubleSymptom(id);
  if (!t) return [];
  const base = t.causes || SYMPTOMS.find((s) => s.id === t.from)?.causes || [];
  return [...base, ...(t.extra || [])];
}

/** The cause keys that are a setting an experiment can vary, as FACTORS keys (app/calc/experiment.js). */
export const CAUSE_FACTOR = { frr: 'frr', tfr: 'tfr', peg: 'peg_pct', quench: 'quench', np: 'np', ionizable: 'ionizable_pct' };

/** Where a mixer runs slow and fast, in mL/min. A chip runs at a tenth of what a T-junction on pumps does. */
export function tfrBand(mixer) {
  return mixer === 'Microfluidic chip' ? { slow: 6, fast: 12, lo: 2, hi: 20 } : { slow: 30, fast: 80, lo: 10, hi: 150 };
}

/** The mol% of one lipid class in a composition, with a class override (peg_pct, ionizable_pct) applied. */
export function classShare(comp, lipidByKey = {}, cls) {
  if (!comp?.mol_pct) return null;
  const v = Object.entries(comp.mol_pct).filter(([k]) => lipidByKey[k]?.class === cls).reduce((a, [, x]) => a + Number(x || 0), 0);
  return Math.round(v * 100) / 100;
}

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const num = (x) => (x === '' || x == null ? null : Number.isFinite(Number(x)) ? Number(x) : null);
const r2 = (x) => Math.round(x * 100) / 100;
const fmtN = (x) => String(r2(x));

/**
 * The context of a formulation, from its row in the data overview (app/calc/facets.js dataRows) and its
 * composition with any override applied (overriddenComposition): the fields the assistant asks about.
 */
export function contextFromRow(row, comp, lipidByKey = {}) {
  if (!row) return {};
  return {
    batch: row.id, lipid: row.ionizable?.[0] || '', mixer: row.mixerType || '', buffer: row.bufferSystem || '',
    ph: row.loadingPH ?? null, frr: row.frr ?? null, tfr: row.tfr ?? null, np: row.np ?? null, quench: row.quench ?? null,
    peg: classShare(comp, lipidByKey, 'peg'), ionizable: classShare(comp, lipidByKey, 'ionizable'),
    post: row.postMethod || '', cryo: row.cryoprotectant || '', compositionId: row.compositionId ?? null,
    size: row.size ?? null, pdi: row.pdi ?? null, ee: row.ee ?? null,
  };
}

/** The context as the address carries it, numbers read as numbers and empty fields as null. */
export function readTroubleContext(p = {}) {
  return { batch: p.batch || '', lipid: p.lipid || '', mixer: p.mixer || '', buffer: p.buffer || '', ph: num(p.ph), frr: num(p.frr), tfr: num(p.tfr),
    peg: num(p.peg), np: num(p.np), quench: num(p.quench), ionizable: num(p.ion), post: p.post || '', cryo: p.cryo || '', symptom: p.symptom || '' };
}
/** And back: only what is set, under the address's names. */
export function troubleParams(c = {}) {
  const out = {};
  for (const [k, n] of [['batch', 'batch'], ['lipid', 'lipid'], ['mixer', 'mixer'], ['buffer', 'buffer'], ['ph', 'ph'], ['frr', 'frr'], ['tfr', 'tfr'], ['peg', 'peg'], ['np', 'np'], ['quench', 'quench'], ['ionizable', 'ion'], ['post', 'post'], ['cryo', 'cryo'], ['symptom', 'symptom']]) {
    if (c[k] !== '' && c[k] != null) out[n] = String(c[k]);
  }
  return out;
}

/**
 * What the context says about one cause: a weight to add, the reason in words, or why it is ruled out. Each rule
 * reads only what was given; a field left empty says nothing, in either direction.
 * @returns {{delta: number, reasons: string[], out: string|null}}
 */
function rule(key, sym, c) {
  const r = { delta: 0, reasons: [], out: null };
  const say = (d, text) => { r.delta += d; r.reasons.push(text); };
  const what = troubleSymptom(sym)?.what || 'it';
  const growth = sym === 'big' || sym === 'pdi';
  const band = tfrBand(c.mixer);
  const mixer = c.mixer || 'mixer';
  switch (key) {
    case 'frr':
      if (!finite(c.frr)) break;
      if (growth || sym === 'ee') {
        if (c.frr < 3) say(2, `FRR ${fmtN(c.frr)}:1 is below the usual 3:1, which fits ${what}.`);
        else if (c.frr >= 4 && growth) r.out = `FRR ${fmtN(c.frr)}:1 is already at or above 4:1, so a low ratio is not the cause.`;
        else if (c.frr <= 5) say(-0.5, `FRR ${fmtN(c.frr)}:1 is in the usual range.`);
      } else if (sym === 'small') {
        if (c.frr >= 5) say(2, `FRR ${fmtN(c.frr)}:1 is high, and a high ratio makes small particles.`);
        else if (c.frr <= 3) r.out = `FRR ${fmtN(c.frr)}:1 is not high, so the ratio is not what makes them small.`;
      }
      break;
    case 'tfr':
      if (!finite(c.tfr)) break;
      if (growth) {
        if (c.tfr < band.slow) say(2, `TFR ${fmtN(c.tfr)} mL/min is slow for a ${mixer}, which fits ${what}.`);
        else if (c.tfr >= band.fast) say(-1, `TFR ${fmtN(c.tfr)} mL/min is already fast for a ${mixer}.`);
      } else if (sym === 'small') {
        if (c.tfr >= band.fast) say(1, `TFR ${fmtN(c.tfr)} mL/min is fast for a ${mixer}, which fits small particles.`);
        else if (c.tfr < band.slow) r.out = `TFR ${fmtN(c.tfr)} mL/min is slow for a ${mixer}, so mixing speed is not what makes them small.`;
      }
      break;
    case 'peg':
      if (!finite(c.peg)) break;
      if (growth || sym === 'drift') {
        if (c.peg === 0) say(3, `The composition has no PEG-lipid, so nothing stops the particles growing.`);
        else if (c.peg < 1) say(2, `PEG ${fmtN(c.peg)} mol% is below 1, which fits ${what}.`);
        else if (c.peg >= 2.5 && growth) r.out = `PEG ${fmtN(c.peg)} mol% is already high, so too little PEG is not the cause.`;
      } else if (sym === 'small') {
        if (c.peg >= 2.5) say(2, `PEG ${fmtN(c.peg)} mol% is high, and much PEG stops growth early.`);
        else if (c.peg <= 1.5) r.out = `PEG ${fmtN(c.peg)} mol% is not high, so PEG is not what makes them small.`;
      }
      break;
    case 'quench':
      if (!finite(c.quench)) break;
      if (c.quench < 1.5) say(1, `A quench factor of ${fmtN(c.quench)} leaves the ethanol high after mixing, which fits ${what}.`);
      else if (c.quench >= 3) say(-1, `A quench factor of ${fmtN(c.quench)} already dilutes the ethanol well.`);
      break;
    case 'aggregate':
      if (finite(c.peg) && c.peg < 1.5) say(1, `PEG ${fmtN(c.peg)} mol% leaves little to keep particles apart.`);
      if (c.post === 'TFF') say(0.5, 'TFF concentrates the particles and shears them, both of which favour aggregation.');
      break;
    case 'np':
      if (!finite(c.np)) break;
      if (c.np < 4) say(2, `N/P ${fmtN(c.np)} is below 4, which fits ${what}.`);
      else if (c.np >= 6) r.out = `N/P ${fmtN(c.np)} is already at or above 6, so too little amine is not the cause.`;
      break;
    case 'ph':
      if (c.buffer === 'Phosphate') say(1, 'A phosphate buffer usually sits near neutral pH, where an ionizable lipid is barely charged.');
      if (!finite(c.ph)) break;
      if (c.ph > 5) say(2, `Loading pH ${fmtN(c.ph)} is close to the apparent pKa of most ionizable lipids (about 6 to 7).`);
      else if (c.ph <= 4.5) r.out = `Loading pH ${fmtN(c.ph)} is well below any usual apparent pKa, so the amine is charged.`;
      break;
    case 'ionizable':
      if (!finite(c.ionizable)) break;
      if (c.ionizable < 35) say(2, `Ionizable lipid ${fmtN(c.ionizable)} mol% is below 35, which fits ${what}.`);
      else if (c.ionizable >= 45) r.out = `Ionizable lipid ${fmtN(c.ionizable)} mol% is already in the usual range.`;
      break;
    case 'cryo':
      if (c.cryo === 'None') say(1, 'No cryoprotectant is recorded: frozen, the particles fuse.');
      else if (c.cryo === 'Sucrose' || c.cryo === 'Trehalose') say(-0.5, `${c.cryo} is recorded as cryoprotectant.`);
      break;
    default: break;
  }
  return r;
}

/** A median that ignores what is missing. */
function med(xs) {
  const v = xs.filter(finite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * The lab's own formulations most like this one: the same ionizable lipid and mixer type where those are known,
 * and settings nearby (FRR within 1.5, TFR within a factor of two). Closest first. `rows` are data overview rows
 * (app/calc/facets.js dataRows), each with `peg` added as its PEG mol% where known (`pegPct`).
 */
export function similarBatches(rows = [], c = {}, { max = 8 } = {}) {
  const near = rows.filter((r) => r.id !== c.batch
    && (!c.lipid || (r.ionizable || []).includes(c.lipid))
    && (!c.mixer || !r.mixerType || r.mixerType === c.mixer)
    && (!finite(c.frr) || !finite(r.frr) || Math.abs(r.frr - c.frr) <= 1.5)
    && (!finite(c.tfr) || !finite(r.tfr) || (r.tfr <= c.tfr * 2 && r.tfr >= c.tfr / 2))
    && (finite(r.size) || finite(r.pdi) || finite(r.ee)));
  const dist = (r) => (finite(c.frr) && finite(r.frr) ? Math.abs(r.frr - c.frr) : 0.5) + (finite(c.tfr) && finite(r.tfr) ? Math.abs(Math.log(r.tfr / c.tfr)) : 0.5);
  return near.sort((a, b) => dist(a) - dist(b) || String(a.id).localeCompare(String(b.id))).slice(0, max);
}

/** Whether a row shows the symptom, read against the QC limits of Settings; null when it cannot tell. */
export function showsSymptom(row, sym, qc = {}) {
  const lim = (k, d) => (finite(qc[k]) ? qc[k] : d);
  if (sym === 'pdi') return finite(row.pdi) ? row.pdi > lim('pdiMax', 0.2) : null;
  if (sym === 'big') return finite(row.size) ? row.size > lim('zaveMax', 150) : null;
  if (sym === 'small') return finite(row.size) ? row.size < lim('zaveMin', 40) : null;
  if (sym === 'ee') return finite(row.ee) ? row.ee < lim('eeMin', 85) : null;
  return null;
}

// How far a setting has to differ before the similar batches are said to have run elsewhere.
const APART = { frr: (a, b) => Math.abs(a - b) >= 0.5, tfr: (a, b) => Math.abs(a - b) >= 0.2 * Math.max(a, b), peg: (a, b) => Math.abs(a - b) >= 0.3, np: (a, b) => Math.abs(a - b) >= 1, quench: (a, b) => Math.abs(a - b) >= 0.5 };
const SETTING_NAME = { frr: 'FRR', tfr: 'TFR', peg: 'PEG mol%', np: 'N/P', quench: 'quench factor' };

/**
 * The similar batches without the symptom, set against this one: for each setting where they ran clearly
 * elsewhere, a hint the diagnosis weighs. Only when at least two of them are without the symptom: one batch is
 * an anecdote. A hint either points away from this setting (weight 1) or finds the clean batches at it, with
 * none at it showing the symptom (weight -0.5).
 * @returns {{n, clean, withIt, hints: {key, text, toward, weight}[]}}
 */
export function compareSimilar(similar = [], c = {}, sym = '', qc = {}) {
  const clean = similar.filter((r) => showsSymptom(r, sym, qc) === false);
  const withIt = similar.filter((r) => showsSymptom(r, sym, qc) === true);
  const hints = [];
  if (clean.length >= 2) {
    for (const key of Object.keys(APART)) {
      const here = c[key], there = med(clean.map((r) => r[key]));
      if (finite(here) && finite(there) && APART[key](here, there)) {
        hints.push({ key, text: `Your ${clean.length} similar batches without ${troubleSymptom(sym)?.what || 'the problem'} ran at a median ${SETTING_NAME[key]} of ${fmtN(there)}, against ${fmtN(here)} here.`, toward: there, weight: 1 });
      } else if (finite(here) && finite(there) && !withIt.some((r) => finite(r[key]) && !APART[key](here, r[key]))) {
        // The other way round: batches at this very setting came out fine, and none at it shows the symptom, so
        // the setting alone is less likely to be the cause. A smaller weight: the setting may still matter here.
        hints.push({ key, text: `Your ${clean.length} similar batches at about the same ${SETTING_NAME[key]} (median ${fmtN(there)}) do not show ${troubleSymptom(sym)?.what || 'the problem'}.`, toward: there, weight: -0.5 });
      }
    }
  }
  return { n: similar.length, clean: clean.length, withIt: withIt.length, hints };
}

/**
 * The diagnosis: every cause of the symptom with a score, its reasons, and its standing. The planner's order is
 * the starting weight (the first cause 1, each next one a little less), the context moves it, and a hint from the
 * lab's own similar batches adds one. A cause the context rules out goes to the end, greyed, with the reason.
 * @returns {{key, cause, why, check, fix, topic, factor: string|null, score: number, reasons: string[], out: string|null, standing: 'likely'|'possible'|'ruled out'}[]}
 */
export function weighCauses(sym, c = {}, compare = null) {
  const causes = troubleCauses(sym);
  const out = causes.map((cause, i) => {
    const r = rule(cause.key, troubleSymptom(sym).id, c);
    const reasons = [...r.reasons];
    let score = 1 - 0.15 * i + r.delta;
    const factorKey = { frr: 'frr', tfr: 'tfr', peg: 'peg', np: 'np', quench: 'quench' }[cause.key];
    const hint = factorKey && compare?.hints?.find((h) => h.key === factorKey);
    if (hint && !r.out) { score += hint.weight ?? 1; reasons.push(hint.text); }
    return { ...cause, factor: CAUSE_FACTOR[cause.key] || null, score: r2(score), reasons, out: r.out,
      standing: r.out ? 'ruled out' : score >= 2 ? 'likely' : 'possible' };
  });
  return out.sort((a, b) => (!!a.out - !!b.out) || b.score - a.score);
}

/**
 * The ranges the plan keeps a factor in: what a formulation lab would still call sensible, narrower than what the
 * wizard lets anyone type. TFR depends on the mixer.
 */
export function sensibleRange(factor, mixer = '') {
  const b = tfrBand(mixer);
  return { frr: [1.5, 6], tfr: [b.lo, b.hi], peg_pct: [0.5, 3], quench: [1, 4], np: [3, 12], ionizable_pct: [30, 60] }[factor] || null;
}
const STEP = { frr: 1, peg_pct: 0.5, quench: 0.5, np: 2, ionizable_pct: 5 };
// Which way the fix moves a factor, for each symptom; raising is the usual fix, lowering where the symptom is
// "too much" of what the factor does.
const DIRECTION = { small: { frr: -1, peg_pct: -1, tfr: -1 } };

/** Where a factor starts from: the context's value, or the wizard's default when the context does not say. */
function startOf(factor, c, factorsList) {
  const v = { frr: c.frr, tfr: c.tfr, peg_pct: c.peg, quench: c.quench, np: c.np, ionizable_pct: c.ionizable }[factor];
  return finite(v) ? v : factorsList.find((f) => f.key === factor)?.default ?? null;
}

/**
 * Three levels beside the control, stepping the way the fix goes and kept inside the sensible range. When the
 * range ends before three steps, the rest go the other way, so the control is bracketed rather than the plan
 * cut short. TFR steps by half again each time, the others by a fixed amount.
 */
export function planLevels(factor, control, dir = 1, mixer = '') {
  const [lo, hi] = sensibleRange(factor, mixer) || [-Infinity, Infinity];
  const next = (v, d) => (factor === 'tfr' ? (d > 0 ? v * 1.5 : v / 1.5) : v + d * STEP[factor]);
  const round = (v) => (factor === 'tfr' ? Math.round(v) : r2(v));
  const out = [];
  for (const d of [dir, -dir]) {
    let v = control;
    while (out.length < 3) {
      v = next(v, d);
      const x = round(v);
      if (x < lo || x > hi) break;
      if (x !== control && !out.includes(x)) out.push(x);
    }
  }
  return out.sort((a, b) => a - b);
}

const EXPECT = {
  frr: { pdi: 'A narrower distribution as the ratio rises toward 3:1 to 4:1.', big: 'Smaller particles as the ratio rises, typically by tens of nanometres from 2:1 to 4:1.', small: 'Larger particles as the ratio comes down toward 3:1.', ee: 'Encapsulation highest near 3:1; far from it, lower.' },
  tfr: { pdi: 'A narrower distribution as the flow rises, levelling off once mixing is fast enough.', big: 'Smaller particles as the flow rises, until mixing stops being the limit.', small: 'Larger particles as the flow comes down.' },
  peg_pct: { pdi: 'One population instead of two as PEG rises; the PDI falls before the mean moves.', big: 'Roughly 10 to 20 nm off the size per 0.5 mol% PEG.', small: 'Larger particles as PEG comes down; watch the PDI, which rises if it goes too low.', drift: 'Less growth over storage with more PEG.' },
  quench: { pdi: 'A narrower distribution with a larger, earlier quench.', big: 'Smaller particles with a larger quench, as growth stops sooner.' },
  np: { ee: 'Encapsulation rising with N/P and levelling off around 6.' },
  ionizable_pct: { ee: 'Encapsulation rising with the ionizable lipid, levelling off near 50 mol%.' },
};
const FACTOR_WORD = { frr: 'FRR', tfr: 'TFR', peg_pct: 'PEG', quench: 'Quench factor', np: 'N/P', ionizable_pct: 'Ionizable lipid' };
const unitOf = (f) => ({ tfr: ' mL/min', peg_pct: ' mol%', ionizable_pct: ' mol%' }[f] || '');
const showLevel = (f, v) => (f === 'frr' ? `${fmtN(v)}:1` : `${fmtN(v)}${unitOf(f)}`);

/**
 * The plan: for the two or three likeliest causes that are a setting, one factor at three levels beside the
 * batch's own setting as control; when two such causes lead, also a 2 × 2 factorial over both with a centre
 * point, which says whether they act together. Causes that are not a setting go in `checks`, to settle before a
 * batch is spent; "you have not measured your noise" becomes a set of repeats.
 * @param {Array} weighed     weighCauses()
 * @param {object} c          the context
 * @param {Array} factorsList FACTORS of app/calc/experiment.js (passed in, so this file keeps no import of it)
 * @returns {{plans: object[], checks: {cause, check}[]}} each plan: {kind: 'ofat'|'doe'|'reference', title,
 *   why: string[], expect, factor?, levels?, control?, factors?, ranges?, runs, params}
 */
export function troublePlan(weighed, c = {}, factorsList = [], { max = 3 } = {}) {
  const sym = troubleSymptom(c.symptom)?.id || '';
  const live = weighed.filter((w) => !w.out);
  const seen = new Set();
  const settings = [];
  for (const w of live) if (w.factor && factorsList.some((f) => f.key === w.factor) && !seen.has(w.factor)) { seen.add(w.factor); settings.push(w); }
  const top = settings.slice(0, max);
  const plans = [];
  const base = {};
  if (finite(c.frr)) base.frr = c.frr;
  if (finite(c.tfr)) base.tfr = c.tfr;
  if (finite(c.quench)) base.quench = c.quench;
  const common = { ...(c.compositionId != null ? { comp: String(c.compositionId) } : {}), ...(Object.keys(base).length ? { base: Object.entries(base).map(([k, v]) => `${k}:${v}`).join(',') } : {}) };
  for (const w of top) {
    const control = startOf(w.factor, c, factorsList);
    if (!finite(control)) continue;
    const dir = DIRECTION[sym]?.[w.factor] ?? 1;
    const levels = planLevels(w.factor, control, dir, c.mixer);
    if (levels.length < 2) continue;
    const all = [...new Set([control, ...levels])].sort((a, b) => a - b);
    plans.push({ kind: 'ofat', factor: w.factor, control, levels: all, runs: all.length,
      title: `${FACTOR_WORD[w.factor]} at ${levels.length} levels, with ${showLevel(w.factor, control)} as control`,
      cause: w.cause, why: [w.why, ...w.reasons], expect: EXPECT[w.factor]?.[sym] || 'The response should move with the factor if this is the cause; if it stays flat, cross the cause off.',
      params: { new: '1', type: 'ofat', factor: w.factor, levels: all.join(','), name: `Troubleshoot: ${FACTOR_WORD[w.factor]} ${all.map((v) => fmtN(v)).join(', ')}`, ...common } });
  }
  const ofat = plans.filter((p) => p.kind === 'ofat');
  if (ofat.length >= 2) {
    const [a, b] = ofat;
    // Low and high: the control and the level two steps along the fix (or the furthest one there is).
    const span = (p) => {
      const along = p.levels.filter((v) => (DIRECTION[sym]?.[p.factor] ?? 1) > 0 ? v > p.control : v < p.control);
      const far = along.length ? along[Math.min(1, along.length - 1)] : p.levels.find((v) => v !== p.control);
      return [Math.min(p.control, far), Math.max(p.control, far)];
    };
    const ra = span(a), rb = span(b);
    plans.push({ kind: 'doe', factors: [a.factor, b.factor], ranges: { [a.factor]: ra, [b.factor]: rb }, runs: 5,
      title: `${FACTOR_WORD[a.factor]} × ${FACTOR_WORD[b.factor]}: a 2 × 2 factorial with a centre point`,
      cause: `${a.cause}; ${b.cause}`, why: ['Two causes lead, and they are not independent: a factorial over both says which one it is, and whether it takes both, in five batches instead of eight.'],
      expect: `If one of the two is the cause, its main effect is large and the other's small; a large interaction means it takes both.`,
      params: { new: '1', type: 'doe', factors: `${a.factor},${b.factor}`, design: 'full_factorial', model: 'interaction', center: '1',
        ranges: `${a.factor}:${ra[0]}-${ra[1]},${b.factor}:${rb[0]}-${rb[1]}`, name: `Troubleshoot: ${FACTOR_WORD[a.factor]} × ${FACTOR_WORD[b.factor]}`, ...common } });
  }
  const checks = live.filter((w) => !w.factor).slice(0, 4).map((w) => ({ key: w.key, cause: w.cause, check: w.check }));
  if (live.slice(0, 3).some((w) => w.key === 'noise')) {
    plans.push({ kind: 'reference', runs: 3, title: 'The same recipe three times, on two days', cause: 'You have not measured your noise',
      why: ['Without repeats of one setting there is no telling drift from the ordinary spread of the method.'],
      expect: 'A standard deviation for size, PDI and encapsulation that every later comparison is held against.',
      params: { new: '1', type: 'reference', name: 'Troubleshoot: repeats', ...common } });
  }
  return { plans, checks };
}

/**
 * What the experiment wizard reads from an address the assistant made (and the planner may make): the OFAT
 * factor and levels, DoE ranges, the composition, the process settings to start from, and a name. Anything that
 * does not read as a number, or names no known factor, is left out rather than guessed at.
 */
export function readPlanParams(p = {}, factorKeys = []) {
  const known = (k) => !factorKeys.length || factorKeys.includes(k);
  const pairs = (text) => String(text || '').split(',').map((x) => x.split(':')).filter(([k, v]) => k && v != null);
  const ranges = {};
  for (const [k, v] of pairs(p.ranges)) {
    const m = /^(-?[\d.]+)-(-?[\d.]+)$/.exec(v.trim());
    if (known(k) && m && Number(m[2]) > Number(m[1])) ranges[k] = [Number(m[1]), Number(m[2])];
  }
  const base = {};
  for (const [k, v] of pairs(p.base)) if (['frr', 'tfr', 'quench'].includes(k) && Number.isFinite(Number(v)) && v !== '') base[k] = Number(v);
  const levels = String(p.levels || '').split(',').map((x) => x.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
  return { factor: p.factor && known(p.factor) ? p.factor : '', levels, ranges, base,
    comp: Number.isFinite(Number(p.comp)) && p.comp !== '' && p.comp != null ? Number(p.comp) : null, name: p.name ? String(p.name).slice(0, 120) : '' };
}
