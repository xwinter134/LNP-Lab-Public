// The condensed reference behind every "?" in the app. Each topic is written to be read standing at a bench
// with a pipette in the other hand: what it is, why it matters here, the numbers you actually need, and the
// mistake people make. Longer than a tooltip, far shorter than a review.
//
// `what`    one or two sentences. The definition.
// `why`     why it matters specifically for lipid nanoparticles.
// `numbers` the values worth remembering, as rows.
// `doing`   what to do with it at the bench.
// `trap`    the mistake that costs a batch.
// `more`    where to read further.
// `see`     related topic ids.

export const TOPICS = {

  /* ---------------- the particle ---------------- */
  ionizable: {
    group: 'Formulation', title: 'Ionizable lipid',
    what: 'The lipid that carries a tertiary amine which is positively charged at acidic pH and close to neutral at physiological pH. It is the component that binds the RNA and the component that releases it again.',
    why: 'At the low pH where the particle is assembled, the amine is protonated and condenses the RNA polyanion into the core. Once the particle is dialysed to pH 7.4 the charge largely disappears, which is what makes the particle tolerable in circulation. Inside the endosome the pH falls again, the lipid re-protonates, and that charge is what destabilises the endosomal membrane and lets the RNA escape. Almost all of the delivery potency of an LNP comes from this one molecule.',
    numbers: [['Typical mol%', '35 to 50'], ['Apparent pKa for liver delivery', '6.2 to 6.5'], ['Assembly pH', '4.0 to 5.0'], ['Final pH', '7.0 to 7.4']],
    doing: 'Raising the mol% usually raises encapsulation and potency until the particle starts to destabilise. It is the first factor to vary when encapsulation is the problem.',
    trap: 'Treating two ionizable lipids as interchangeable at the same mol%. Their apparent pKa and their packing differ, so the optimum ratio moves with the lipid.',
    more: 'Hou et al., Lipid nanoparticles for mRNA delivery, Nat Rev Mater 2021.',
    see: ['pka', 'np', 'ee'],
  },
  helper: {
    group: 'Formulation', title: 'Helper phospholipid',
    what: 'A structural phospholipid, usually DSPC or DOPE, that sits in the particle shell alongside cholesterol.',
    why: 'It sets how rigid the bilayer-like shell is. DSPC is saturated and packs tightly, giving a stable particle with a long shelf life. DOPE is unsaturated and cone-shaped, prefers a non-lamellar phase, and promotes membrane fusion, which tends to help endosomal escape at the cost of stability. The choice is a trade between shelf life and potency.',
    numbers: [['Typical mol%', '10 to 20 (not sourced here)'], ['DSPC melting temperature', 'about 54 °C'], ['DSPC shape', 'cylindrical, forms a lamellar phase'], ['DOPE shape', 'conical, adopts an inverted hexagonal phase']],
    doing: 'Hold it constant while optimising the process. Change it when you are deliberately trading stability against potency, and expect size and PDI to move with it.',
    trap: 'Changing the helper lipid and the ratio in the same experiment. You will not know which did what.',
    see: ['sterol', 'stability'],
  },
  sterol: {
    group: 'Formulation', title: 'Cholesterol',
    what: 'The largest component by mole fraction. It fills the space between the other lipids.',
    why: 'Cholesterol modulates membrane fluidity and fills packing defects, which is what stops the particle leaking its cargo. Because it is usually the largest fraction and the least specific, it is the natural component to let absorb changes when the others are varied: that keeps the total at 100 mol% without changing anything you were deliberately setting.',
    numbers: [['Typical mol%', '30 to 50']],
    doing: 'In this app it is the default balance component. When you vary the ionizable lipid and PEG, cholesterol takes up the remainder.',
    trap: 'Cutting it to make room while varying other components. Cholesterol is what gives the particle its rigidity and membrane integrity, so the packing that keeps the cargo in goes with it. No published threshold is quoted here because the reviews this app draws on give none; find out where your own system starts to leak rather than trusting a round number.',
    see: ['mixture', 'ionizable'],
  },
  peg: {
    group: 'Formulation', title: 'PEG-lipid',
    what: 'A lipid with a polyethylene glycol chain, present at a low percentage, that forms a hydrated brush on the particle surface.',
    why: 'PEG-lipid controls particle size more strongly than anything else in the composition: more PEG means the growing particle is stabilised sooner, so it stops growing smaller. It also sets how long the particle circulates, and it desorbs over time, which is part of why the particle is cleared. The amount is a lever on size, stability and biodistribution at once, which is why it is always a small number carefully chosen.',
    numbers: [['Typical mol%', '1.0 to 2.5'], ['Effect on size', 'real, direction and size unquoted: no source here measures it'], ['Below 1 mol%', 'particles grow and aggregate'], ['Above 3 mol%', 'potency falls, the brush blocks uptake']],
    doing: 'Use PEG as a coarse size control and flow rate ratio as the fine one.',
    trap: 'Pushing PEG up to hit a size target and then wondering why potency collapsed.',
    see: ['size', 'frr', 'stability'],
  },
  pka: {
    group: 'Formulation', title: 'Apparent pKa',
    what: 'The pH at which the assembled particle, not the free lipid, is half protonated. Measured with a dye such as TNS.',
    why: 'It is the single most predictive physicochemical parameter for in-vivo potency that the field has found. Particles with an apparent pKa around 6.2 to 6.5 deliver well to liver; the window for other tissues differs. Read it as a steep gradient rather than a cliff: potency falls away sharply on both sides, but inside the window the best and worst lipids still differ roughly thirty-fold, so the right pKa is necessary and nowhere near sufficient. It is a property of the whole particle, so it shifts with composition, not just with the ionizable lipid.',
    numbers: [['Liver delivery optimum', '6.2 to 6.5'], ['Measured by', 'TNS fluorescence, pH 3 to 10 in half-unit steps, on the assembled particle'], ['At pKa 5.6', 'about 20-fold less potent'], ['At pKa 6.9', 'about 5-fold less potent']],
    doing: 'Measure it once per composition, not per batch. If you change the ionizable mol% appreciably, measure it again.',
    trap: 'Quoting the pKa of the free lipid from a supplier sheet. The particle value is what matters and can differ by a full unit.',
    more: 'Jayaraman et al., Angew Chem Int Ed 2012;51:8529-8533, pp. 8530-8533, established the correlation: the best lipid in that series reached an ED50 of 0.005 mg/kg in mice and under 0.03 mg/kg in non-human primates. The cargo there was siRNA with hepatocyte uptake, and the authors say the trend may not carry to other delivery systems, so for mRNA treat 6.2 to 6.5 as a starting point rather than a specification.',
    see: ['ionizable', 'zeta'],
  },
  np: {
    group: 'Formulation', title: 'N/P ratio',
    what: 'The ratio of protonatable nitrogen atoms in the ionizable lipid to phosphate groups in the nucleic acid. A charge ratio at assembly pH, not a mass ratio.',
    why: 'It sets how much excess positive charge is available to condense the RNA. Too low and RNA is left unencapsulated; too high and you are paying in lipid, in toxicity and in free lipid that can form empty particles. It is usually the fastest route to fixing poor encapsulation.',
    numbers: [['Typical range', '4 to 8'], ['Common default', '6'], ['Below 3', 'encapsulation usually suffers'], ['Above 10', 'diminishing returns, rising lipid dose']],
    doing: 'If encapsulation is below about 85 per cent, raise N/P before touching anything else.',
    trap: 'Comparing N/P across different ionizable lipids without recomputing the nitrogen count per molecule.',
    more: 'These bands are common practice rather than a result from the sources behind this reference: the pKa paper never mentions N/P, and the review does not quote a ratio. Treat them as a starting point and let your own encapsulation data move them.',
    see: ['ionizable', 'ee'],
  },

  /* ---------------- the process ---------------- */
  frr: {
    group: 'Process', title: 'Flow rate ratio',
    what: 'The ratio of the aqueous stream to the organic (ethanol) stream at the mixing junction. An FRR of 3 means three parts buffer to one part ethanol.',
    why: 'This is the dominant process lever on particle size. A higher ratio means the ethanol is diluted faster, so the lipids become insoluble sooner, nucleation happens earlier and more particles form from the same material, each one smaller. It also fixes the final ethanol concentration, which decides how long the particles stay able to rearrange.',
    numbers: [['Typical range', '2:1 to 5:1'], ['Common default', '3:1'], ['Ethanol after mixing at 3:1', '25 per cent'], ['Effect on size', 'roughly 5 to 15 nm smaller per unit of ratio']],
    doing: 'Use the ratio as the main size control and total flow rate as the trim.',
    trap: 'Changing the ratio while holding total flow constant and forgetting that both streams changed. The time the two spend together in the channel moved as well.',
    more: 'Sato et al., Chem Pharm Bull 2024;72:529-539, Fig. 5, rank formulation buffer pH first for particle size and ethanol fraction second, with total flow rate far behind both. Their abstract names the trio including total flow, but their own measurements do not support its place there. Buffer pH is not something this app can vary, which is a gap rather than a judgement.',
    see: ['tfr', 'size'],
  },
  tfr: {
    group: 'Process', title: 'Total flow rate',
    what: 'The combined volumetric flow through the mixer, in millilitres per minute.',
    why: 'It sets the mixing speed. Faster flow means a shorter diffusion distance before the streams are blended, so the supersaturation that drives nucleation is reached more uniformly and the size distribution tightens. Above a certain rate the mixing is already faster than the particle assembly and further increases buy nothing but pressure.',
    numbers: [['Typical range', '10 to 150 mL/min, depending on the mixer'], ['Mixing time scale', 'milliseconds'], ['Assembly time scale', 'tens of milliseconds']],
    doing: 'Increase it until size and PDI stop improving, then stay a little above that point for robustness.',
    trap: 'Reporting a total flow rate without the mixer it was run on. The same number mixes differently in a different channel, so the figure alone does not let anyone reproduce the batch.',
    see: ['frr', 'pdi'],
  },
  quench: {
    group: 'Process', title: 'Quench or dilution factor',
    what: 'The volume of buffer added immediately after mixing, expressed as a multiple of the stream it dilutes.',
    why: 'Particles stay able to fuse and grow while ethanol is above roughly 20 per cent by volume. The quench drops the ethanol below that threshold and freezes the size distribution where it is. A late or small quench lets particles keep growing, which is seen as a larger size and a wider distribution.',
    numbers: [['Typical factor', '1 to 3 times the mixed volume'], ['Ethanol threshold for arrest', 'about 20 per cent v/v']],
    doing: 'Quench as soon after the junction as the plumbing allows. If size drifts between the start and end of a run, look here first.',
    trap: 'Leaving the quench out of the comparison when scaling up. Residence time before quench changes with tubing length.',
    see: ['frr', 'size'],
  },
  bufferph: {
    group: 'Process', title: 'Formulation and dialysis pH',
    what: 'Two different pH values: the acidic buffer the RNA is dissolved in during assembly, and the neutral buffer the particle ends up in.',
    why: 'The assembly pH has to be well below the ionizable lipid apparent pKa so the amine is protonated and binds the RNA. The final pH has to be near neutral so the particle is uncharged in circulation. The gap between the two is what makes the whole design work, and the assembly pH is one of the three process parameters that most affects encapsulation.',
    numbers: [['Assembly buffer', 'citrate or acetate, pH 4.0 to 5.0'], ['Final buffer', 'PBS, Tris or HEPES, pH 7.0 to 7.4'], ['Cryoprotectant', 'sucrose or trehalose at 5 per cent (w/v) for freezing']],
    doing: 'If encapsulation is poor and N/P is already high, lower the assembly pH by half a unit.',
    trap: 'Assuming the final pH is what you set. Residual acidic buffer after incomplete dialysis will pull it down.',
    see: ['pka', 'ee', 'np'],
  },

  /* ---------------- what you measure ---------------- */
  size: {
    group: 'Measurement', title: 'Particle size (Z-average)',
    what: 'The intensity-weighted harmonic mean diameter from dynamic light scattering. Not a number-average and not a physical diameter.',
    why: 'Size changes how a particle is taken up and cleared, and it is the number everyone quotes, but it is not what decides which organ the particle reaches. The reviews put that down to lipid structure and the proportions of the components: changing an alkyl chain length switches liver for spleen without any change in size. Treat size as a quality attribute you control, not as a steering wheel for biodistribution. Because the measurement is intensity-weighted, a small number of large particles pulls the value up disproportionately, so the Z-average is a sensitive but blunt instrument.',
    numbers: [['Common working range', '60 to 100 nm'], ['Intensity weighting', 'scattering scales with the sixth power of diameter'], ['Measure at', '25 °C, after dilution into the final buffer']],
    doing: 'Always read the Z-average together with the PDI. One without the other says very little.',
    trap: 'Comparing sizes measured in different buffers or at different dilutions. Both shift the result.',
    see: ['pdi', 'frr', 'peg'],
  },
  pdi: {
    group: 'Measurement', title: 'Polydispersity index',
    what: 'A dimensionless width of the size distribution derived from the cumulants fit, between 0 and 1.',
    why: 'It is the cheapest early warning you have. A rising PDI usually means mixing was too slow, the quench was late, or the particles are beginning to aggregate, all before the Z-average has moved much. It is a process indicator rather than a release criterion: the release panel for a clinical product covers encapsulation, size, charge, sterility, endotoxin, particulate matter and osmolality, and dispersity is not on it.',
    numbers: [['Excellent', 'below 0.1'], ['Acceptable', '0.1 to 0.2'], ['Investigate', 'above 0.2'], ['The fit is unreliable', 'above 0.7']],
    doing: 'Treat a PDI above 0.2 as a process question, not a formulation one, until you have ruled out mixing and quench.',
    trap: 'Averaging the PDI across replicates and losing sight of the one bad run. Look at the spread.',
    see: ['size', 'quench'],
  },
  ee: {
    group: 'Measurement', title: 'Encapsulation efficiency',
    what: 'The fraction of RNA inside particles rather than free in solution. Measured with a fluorescent dye, usually RiboGreen, read with and without a detergent that breaks the particles open.',
    why: 'Free RNA is wasted dose and is degraded quickly in vivo, so encapsulation sets how much of what you made is useful. It is largely decided by the charge balance at assembly: how much ionizable lipid there is, how protonated it is, and how fast the RNA met it.',
    numbers: [['Good', 'above 90 per cent'], ['Acceptable', '85 to 90 per cent'], ['Investigate', 'below 85 per cent'], ['Assay', 'RiboGreen, with and without Triton X-100']],
    doing: 'When it is low, in order: raise N/P, lower the assembly pH, raise the ionizable mol%.',
    trap: 'Reading the value without the total-RNA arm of the assay. A low recovery can look like high encapsulation.',
    see: ['np', 'bufferph', 'ionizable'],
  },
  zeta: {
    group: 'Measurement', title: 'Zeta potential',
    what: 'The electrokinetic potential at the slipping plane of the particle, in millivolts. It is a proxy for surface charge.',
    why: 'A finished LNP should be close to neutral at pH 7.4: a strong positive charge is associated with toxicity and rapid clearance, and a strong negative charge suggests the ionizable lipid is not where you think it is. The value depends heavily on the ionic strength of the buffer it is measured in, so it is comparable only within one method.',
    numbers: [['Target at pH 7.4', 'roughly −10 to +10 mV'], ['Measure in', 'low ionic strength buffer, e.g. 1 mM NaCl or dilute PBS']],
    doing: 'Use it as a check that the particle behaves as designed, not as an optimisation target in its own right.',
    trap: 'Comparing zeta measured in PBS with zeta measured in water. The numbers are not on the same scale.',
    see: ['pka', 'ionizable'],
  },
  stability: {
    group: 'Measurement', title: 'Stability study',
    what: 'Repeated measurement of the same material held at set temperatures over time.',
    why: 'An LNP can be perfect on the day it is made and useless a fortnight later. The things that change are size, which grows as particles fuse, PDI, which widens first, encapsulation, which falls as the cargo leaks, and potency, which usually falls faster than any of the physical measures. Each tells you about a different failure mode.',
    numbers: [['Common conditions', '4 °C, 25 °C, and −20 or −80 °C'], ['Common timepoints', 'day 0, 1, 3, 7, 14, 28'], ['Accelerated', '37 °C for two weeks']],
    doing: 'Always include a day-0 measurement on the same aliquot stream as the later ones, so you are measuring change rather than two different things.',
    trap: 'Freezing without a cryoprotectant and concluding the formulation is unstable. Sucrose or trehalose at 5 per cent (w/v) usually fixes it.',
    see: ['pdi', 'peg'],
  },

  /* ---------------- designing experiments ---------------- */
  doe: {
    group: 'Design', title: 'Why design an experiment',
    what: 'Choosing the set of runs in advance so that each one answers part of a question, rather than changing one thing at a time and hoping.',
    why: 'Changing one factor at a time cannot see interactions, and in formulation almost everything interacts: the best flow rate ratio depends on the PEG content, and the best N/P depends on the pH. A design that moves several factors together costs fewer runs and tells you more, because every run contributes to every estimate rather than to one.',
    numbers: [['Runs for 3 factors, main effects and interactions', '8 plus centre points'], ['Runs for 3 factors with curvature', '15 to 20'], ['Runs to screen 7 factors', '8 to 12']],
    doing: 'Decide first whether you are screening (which factors matter) or optimising (what is the best setting). They need different designs.',
    trap: 'Running a full response surface on seven factors. Screen first, then optimise the two or three that survived.',
    see: ['screening', 'rsm', 'center'],
  },
  screening: {
    group: 'Design', title: 'Screening designs',
    what: 'Small two-level designs that find which of many factors matter, accepting that interactions will be tangled with main effects.',
    why: 'Early on, the expensive mistake is optimising the wrong factor. A screening design spends a few runs to rule most factors out, so the optimisation that follows is over a space small enough to map properly.',
    numbers: [['Plackett-Burman', 'the next multiple of 4 runs after the factor count'], ['Two-level full factorial', '2 to the power of the factor count'], ['Resolution III', 'main effects tangled with two-factor interactions'], ['Resolution IV', 'main effects clean, interactions tangled with each other']],
    doing: 'Screen with wide ranges. A factor that does nothing across a wide range genuinely does nothing.',
    trap: 'Reading an interaction out of a screening design. It was not built to estimate one.',
    see: ['doe', 'rsm'],
  },
  rsm: {
    group: 'Design', title: 'Response surface designs',
    what: 'Three-level designs that can fit curvature: central composite, Box-Behnken, and the three-level factorial.',
    why: 'An optimum is a place where the response curves over. A two-level design can only fit a plane and a twist, so it can tell you which direction is better but never where to stop. Adding a third level lets you fit a quadratic term and locate a turning point.',
    numbers: [['Central composite, 3 factors', '15 to 20 runs'], ['Box-Behnken, 3 factors', '13 to 15 runs'], ['Box-Behnken needs', 'at least 3 factors'], ['Face-centred', 'axial points on the faces, so only 3 levels per factor']],
    doing: 'Use face-centred central composite when your ranges are hard limits, because it never asks for a setting outside the box. Use Box-Behnken when extreme corner combinations are undesirable, because it never visits one.',
    trap: 'Fitting a quadratic model to a two-level design. It cannot be done, and software that appears to do it has dropped terms silently.',
    see: ['doe', 'center', 'screening'],
  },
  center: {
    group: 'Design', title: 'Centre points and replicates',
    what: 'Runs at the middle of every factor range, repeated. They are not there to find the optimum.',
    why: 'Centre points do two jobs that nothing else does. Repeated at the same setting, they measure your pure experimental noise, which is the floor below which no model can predict. And compared with the average of the corner runs, they detect curvature: if the centre sits well off that average, a straight-line model is wrong.',
    numbers: [['Typical number', '3 to 5 per design'], ['Minimum useful', '3'], ['What they estimate', 'pure error, and lack of fit']],
    doing: 'Spread them through the run order, not all at the start. That way they also catch drift over the day.',
    trap: 'Running zero centre points and then being unable to tell a bad model from a noisy process.',
    see: ['rsm', 'noise', 'doe'],
  },
  randomise: {
    group: 'Design', title: 'Randomising the run order',
    what: 'Performing the designed runs in a shuffled order rather than in the order they appear in the table.',
    why: 'Anything that drifts during the session, the operator warming up, a stock settling, the room temperature, will be absorbed into whichever factor happens to be ordered the same way. Randomising turns that bias into noise, which is far less dangerous because it inflates your error estimate rather than faking an effect.',
    numbers: [['Cost', 'nothing but convenience'], ['What it protects against', 'time trends, operator drift, reagent ageing']],
    doing: 'If some factor is genuinely hard to change, say the lipid stock, block on it deliberately and randomise within each block.',
    trap: 'Running all the low-flow conditions in the morning and all the high-flow ones in the afternoon.',
    see: ['center', 'doe'],
  },
  mixture: {
    group: 'Design', title: 'The mixture constraint',
    what: 'Lipid mol% has to total 100, so the components are not free to move independently.',
    why: 'If you raise the ionizable lipid by 5 mol%, 5 mol% has to come from somewhere, and whatever you take it from is now also a variable in your experiment. Treating four lipid percentages as four independent factors produces a design that cannot be fitted and conclusions that silently confound two changes.',
    numbers: [['Degrees of freedom for 4 lipids', '3, not 4'], ['Scheffe terms for 4 lipids, quadratic', '10'], ['Intercept in a mixture model', 'none: the components already sum to a constant']],
    doing: 'Two honest routes, and the app has both. Leave one lipid out and let it absorb the remainder, which is what the ML optimizer does and what most formulators do by hand — cholesterol is the usual balance. Or run a blend design: pick the lipids and their mol% ranges in the DoE wizard, and the design lives on the simplex with a Scheffe model fitted to it. Take the second when the lipids themselves are the question, above all when two of the same class are in play, which a balance cannot express. A blend has no main-effects plot, since raising one lipid lowers the others; "What each lipid does" on Design & results draws Cox traces instead, each lipid moved across its own range with the rest falling in proportion, every point a blend you could make. A steep trace is a direction worth moving in, though not necessarily because of that lipid: its trace carries the effects of the others it pushes down. A flat one is the safe reading: that direction does nothing.',
    trap: 'Varying every component and letting the software renormalise afterwards. The factor you believed you held constant did not stay constant. The second trap is reading a Scheffe coefficient as a slope: it is the predicted response at that lipid\'s corner of the region, so on narrow ranges it is an extrapolation with a standard error to match.',
    see: ['sterol', 'doe'],
  },

  /* ---------------- modelling ---------------- */
  noise: {
    group: 'Modelling', title: 'Experimental noise',
    what: 'The spread you get when you run the same setting twice. The floor below which no model can predict.',
    why: 'Every quality figure you will read is a comparison against this number. A model whose error is close to your repeat-to-repeat spread is as good as it can possibly be; one far above it has something left to learn. Without replicates you have no idea which you are looking at, and will spend runs chasing variation that was never real.',
    numbers: [['DLS Z-average, typical', '1 to 3 per cent'], ['PDI, typical', '±0.01 to 0.02'], ['RiboGreen encapsulation, typical', '2 to 5 per cent']],
    doing: 'Repeat one standard setting every few batches. It costs one run and makes every other number interpretable.',
    trap: 'Treating a 3 nm difference as a result when your repeat spread is 4 nm.',
    see: ['center', 'q2'],
  },
  q2: {
    group: 'Modelling', title: 'Q², and why not R²',
    what: 'R² measured on runs the model has never seen. Also called cross-validated R² or predictive R².',
    why: 'R² measured on the same runs the model was fitted to always rises when you add terms, and on a small dataset a flexible model will reach nearly 1 whatever the data. It tells you how well the model memorised, not how well it predicts. Q² holds runs back, fits without them, and checks the prediction, which is the only version of the question that matters.',
    numbers: [['Useless', 'Q² below 0'], ['Weak, use for ranking only', '0 to 0.3'], ['Useful for steering', '0.3 to 0.6'], ['Predictions usable with intervals', 'above 0.6'], ['Suspiciously high at this scale', 'above 0.9']],
    doing: 'Judge every model on Q² and on rank correlation. A model that orders settings correctly is useful even when its numbers are poor.',
    trap: 'Reporting an R² of 0.99 from twenty runs and fourteen model terms as evidence of anything.',
    see: ['splits', 'noise', 'overfit'],
  },
  splits: {
    group: 'Modelling', title: 'How runs are held back',
    what: 'The rule deciding which runs the model is tested on: at random, by experiment, by composition, or by date.',
    why: 'Batches from one experiment share a lipid stock, an RNA lot, an operator and a day. Holding back a single run leaves its near-twins in the training set, so the model looks far better than it is. Holding back a whole experiment asks the question you actually care about: will this help me on the next experiment, not on a run I already did.',
    numbers: [['Leave one run out', 'optimistic, use only within a single session'], ['Leave one experiment out', 'the honest default'], ['Leave one composition out', 'tests transfer to a new recipe'], ['Train on the past', 'mimics how the model is used']],
    doing: 'Start with leave-one-experiment-out. If the quality drops sharply compared with leave-one-run-out, the model was learning your batches rather than your chemistry.',
    trap: 'Random splits on a designed experiment. They always flatter.',
    see: ['q2', 'overfit'],
  },
  overfit: {
    group: 'Modelling', title: 'Overfitting',
    what: 'A model that has followed the noise in your runs rather than the pattern underneath.',
    why: 'With more model terms than runs, or with a flexible model and few runs, the fit will go through every point exactly and predict nonsense between them. The giveaway is a model that is excellent on its own data and poor on held-out data. In formulation this is the normal situation rather than the exception, because runs are expensive and factors are many.',
    numbers: [['Rule of thumb', 'at least 5 runs per factor for a surface model'], ['Terms in a quadratic model, k factors', '1 + 2k + k(k−1)/2']],
    doing: 'Compare every model against a predict-the-average baseline, and against a null check that shuffles your results and refits. If the shuffle gets close, the fit is flexibility, not signal.',
    trap: 'Adding factors because you can measure them. Each one costs runs you do not have.',
    see: ['q2', 'splits', 'noise'],
  },
  diagnostics: {
    group: 'Modelling', title: 'Reading a fit: the diagnostic plots',
    what: 'The checks that say whether a fitted model is the right shape, as opposed to how much it explains: what is left over at each run (the residual), how those leftovers spread, and whether one run carries the fit.',
    why: 'An R² is reported whether or not the model is right, and reads no less sure of itself for being wrong. A designed experiment has few runs, so one bad batch or one missing term can move the optimum a long way without the coefficients showing it. The residuals do: they are the part of each result the model could not explain, and they should look like noise. Design & results reads them for you and says in one sentence what it found; the plots are there to see it for yourself.',
    numbers: [
      ['Residuals against fitted', 'a shapeless band; a funnel or a curve is a fault'],
      ['Studentised residual beyond ±2', 'about 1 run in 20 by chance'],
      ['A run that stands out', 'beyond what chance allows over all the runs (Bonferroni, p < 0.05)'],
      ['Predicted R² against adjusted R²', 'within 0.2 of each other'],
      ['Leverage above 2 × terms / runs', 'the fit leans on that run'],
      ['Lack of fit', 'needs replicates; p < 0.05 means the model misses something'],
    ],
    doing: 'Residuals against fitted first. A funnel means the scatter grows with the value, common for particle size: fit the log of the response (export the CSV) or read the high end loosely. A curve means a term is missing: try the next model up. Then the normal plot: on the line, the p values hold; an S says they are approximate, a lone point off the end is a run to check. Measured against predicted is the plainest picture, but it is drawn from the runs the model was fitted to, so it flatters; predicted R² is its honest version. In the Pareto, bars are |t|, a coefficient over its own standard error; past the dashed line a term would come up by chance less than one time in twenty. Before dropping a run that stands out, look at its batch record and measurement: a wrong value is a typo to correct, a real one is a finding. The fitted surface and the effect plots are what the model claims rather than a check on it: read numbers off the contour, use the 3D view for the shape (a ridge, a saddle or a dome), and where there are no runs it is the model talking, not the data.',
    trap: 'Trusting a lack-of-fit test whose centre replicates were made from one stock on one morning. Their scatter is then smaller than real batch-to-batch noise, and every model looks as if it misses something. Make replicates as separate batches, spread through the run order.',
    see: ['q2', 'overfit', 'noise', 'center'],
  },
  desirability: {
    group: 'Modelling', title: 'Desirability',
    what: 'A way of combining several goals into one score, by mapping each response onto 0 to 1 and taking the weighted geometric mean.',
    why: 'Optimisation needs one number, but you care about size and PDI and encapsulation at once. A geometric mean has the property you want: if any one response is unacceptable the whole score goes to zero, so the optimiser cannot buy a better encapsulation with an unusable PDI. The shape of each curve is something you can draw and argue with, which an arbitrary weighted sum is not.',
    numbers: [['Each response maps to', '0 unacceptable, 1 ideal'], ['Combined as', 'weighted geometric mean'], ['Published', 'Derringer and Suich, 1980']],
    doing: 'Set the unacceptable limit at the value where you would genuinely discard the batch, not at a value you would merely be disappointed by.',
    trap: 'Setting every weight to 1 without thinking. Weights are how you say which compromise you prefer.',
    see: ['pareto', 'bo'],
  },
  pareto: {
    group: 'Modelling', title: 'The Pareto front',
    what: 'The set of runs that nothing else beats on every goal at once.',
    why: 'It is the honest view of a trade-off, before any weighting is applied. If a run is on the front, choosing against it means you have decided which goal you care about more. If it is not on the front, something else is better in every respect and there is no argument to have.',
    numbers: [['A run is dominated if', 'another is at least as good everywhere and better somewhere']],
    doing: 'Look at the front before you set weights. It often shows that the trade-off you were worried about does not exist.',
    trap: 'Assuming a large front means a hard problem. It can also mean noisy data.',
    see: ['desirability'],
  },
  bo: {
    group: 'Modelling', title: 'Bayesian optimisation',
    what: 'Fitting a model that reports its own uncertainty, then choosing the next runs where the combination of predicted quality and remaining uncertainty is most promising.',
    why: 'With a fixed design you commit all your runs before seeing any results. With this approach each round uses everything learned so far, which matters when runs are expensive. The model being uncertain is the point: a setting that might be excellent is worth trying even if its predicted mean is mediocre, and only a model with error bars can tell you that.',
    numbers: [['Useful from about', '8 runs'], ['Quality testable from about', '15 runs'], ['Typical round size', '4 to 8 runs'], ['Typical campaign', '4 to 6 rounds']],
    doing: 'Run it in rounds. After each round the model is better, so the next suggestions are better.',
    trap: 'Expecting the first round to find the optimum. The first rounds are mostly learning the shape of the surface.',
    see: ['gp', 'explore', 'q2'],
  },
  gp: {
    group: 'Modelling', title: 'Gaussian process',
    what: 'A model that predicts a smooth surface through your runs and, at every point, how sure it is.',
    why: 'It is the standard choice for small, expensive datasets because it interpolates your measurements, widens its error bars as you move away from them, and needs no tuning beyond a few parameters fitted from the data. The uncertainty is not decoration: it is what makes choosing the next experiment possible.',
    numbers: [['Works from about', '8 runs'], ['Comfortable at', '5 or more runs per factor'], ['What it assumes', 'the response changes smoothly, not in steps']],
    doing: 'Read the predicted value and its interval together. A prediction of 85 ± 20 nm is a different statement from 85 ± 3 nm.',
    trap: 'Trusting a prediction far outside the settings you have run. The interval widens there, but it cannot know about a cliff it has never seen.',
    see: ['bo', 'explore', 'q2'],
  },
  explore: {
    group: 'Modelling', title: 'Exploration and exploitation',
    what: 'The choice between refining near your best result and probing where the model is least sure.',
    why: 'Only refining means you polish a local optimum and never find out whether a better region exists. Only probing means you learn the surface beautifully and never make a good batch. Every acquisition rule is some answer to this trade, and the right balance depends on how many rounds you have left: early on, information is worth more than results.',
    numbers: [['Early rounds', 'favour exploring'], ['Final round', 'favour exploiting'], ['A common split', 'half the batch each way']],
    doing: 'Use the half-and-half mode when you want the trade visible rather than hidden in a constant: half the runs are placed to win, half to learn, and the table says which is which.',
    trap: 'Switching to pure exploitation after one good batch. One result is not a trend.',
    see: ['bo', 'gp'],
  },
  attribution: {
    group: 'Modelling', title: 'Factor importance',
    what: 'How much each factor contributes to the model’s ability to predict, measured by scrambling that factor and seeing how much worse the predictions get.',
    why: 'It tells you where to spend your next runs. But it describes the runs you did, not the chemistry: a factor can look unimportant because you never varied it much, and two factors you always changed together will split the credit between them arbitrarily. It is a map of your experiment, not of the mechanism.',
    numbers: [['Shown as', 'share of total predictive contribution'], ['Needs', 'the factor to have genuinely varied']],
    doing: 'Use it to decide what to vary next, and to spot a factor you have been holding constant without meaning to.',
    trap: 'Writing "X drives size" in a report on the strength of an importance bar. You have an association.',
    see: ['doe', 'overfit'],
  },
};

export const GROUPS = ['Formulation', 'Process', 'Measurement', 'Design', 'Modelling'];
export const topicIds = () => Object.keys(TOPICS);
export const topicsIn = (group) => Object.entries(TOPICS).filter(([, t]) => t.group === group).map(([id, t]) => ({ id, ...t }));
/** Free-text search over titles and bodies, for the index screen. */
export function searchTopics(q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return Object.entries(TOPICS).map(([id, t]) => ({ id, ...t }));
  return Object.entries(TOPICS)
    .map(([id, t]) => ({ id, ...t, hit: [t.title, t.what, t.why, t.doing, t.trap].join(' ').toLowerCase().includes(needle) || id.includes(needle) }))
    .filter((t) => t.hit);
}
