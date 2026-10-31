# ML optimizer (optional module)

An optional module that reads the batches already in LNP Lab, fits a surface model per response, says how far
that model can be trusted, and proposes the next runs to put on the bench. Nothing else in the app depends on
it. Turn it off by removing the `ml` entry from `SCREENS` in `app/main.js`; no other screen imports it.

## Why it exists, and why it is shaped this way

The seed paper for this module is Kausas & Schastlivaia, *Advancing targeted nanoparticle mRNA delivery using
machine learning* (ChemRxiv, 2026, doi:10.26434/chemrxiv.15010224/v2). Its practical argument is not that
nanoparticle work needs bigger models, but that it is limited by data: "the development of generalizable
nanoparticle models is limited by the size and quality of the training datasets", and models trained on small
biased datasets "might suffer from poor generalization and overfitting". It then lists the practices that keep
small-data modelling honest, and this module implements them as features rather than as advice:

| The paper says | What the module does |
|---|---|
| Include the simplest possible representations as baselines | A linear model, a quadratic response surface and a predict-the-average baseline are fitted alongside the Gaussian process and cross-validated on the same folds. The baseline is always on screen. |
| Random splits over a combinatorial library overestimate performance; use structure-, property- or temporal splits | The default is leave-one-experiment-out. Leave-one-composition-out and a train-on-the-past split are offered. Leave-one-run-out is available but labelled optimistic. |
| Examine an ensemble of models per task; select empirically | Four learners, compared on one set of held-out groups, best by Q². **Disclosed violation:** the paper names nested cross-validation and cites the selection-bias literature for exactly this, and the winner here is reported on the same groups that chose it, so the headline figure is a maximum over four candidates and runs high. A third split is what honesty would cost, and at eight to twenty runs it cannot be paid for. The verdict text says so in words instead. |
| Include cross-validation to quantify generalizability | Only cross-validated numbers are reported. In-sample R² is never shown, because on 20 runs it is close to 1 whatever the model. |
| Interpretability tools describe features that contribute to predictions, not those that causally determine the outcome | The attribution panel opens with that sentence, in those terms. |
| Validate each new model; be aware of model bias | A null check shuffles the responses and refits, so the user can see what Q² the same procedure gets from noise. |
| Include internal negatives | **Not done.** The paper means experimental negative controls, formulations predicted to be bad and made anyway, which is the only way to find out whether the model is wrong at the bottom as well as right at the top. This module never proposes one, and the shuffle null above is a different thing that was previously mapped to this row by mistake. |

Everything below that is design that goes past the review, and the reasoning for it.

## What the module does

**1. Goals.** Each response is turned into a desirability between 0 (unacceptable) and 1 (ideal) by the
Derringer-Suich construction (Derringer & Suich, *J Qual Technol* 12:214, 1980), with the three standard
shapes: hit a target, as low as possible, as high as possible. The overall score is the weighted geometric
mean, so a single unacceptable response takes the whole batch to zero. That is the property that makes the
method worth using: it stops the optimiser trading away a usable PDI for a prettier encapsulation. Hard limits
are separate from goals: a setting whose predicted result would likely breach one is never proposed.

**0. Where the data comes from.** Every formulation recorded under Experiments, its settings read from its
record and its results from Measurements (`buildRows` in `app/calc/ml/dataset.js`). Nothing is entered here.
The screen opens on a **Data used** card (`dataAccount`) that lists, experiment by experiment, the formulations
used and the results they carry, and every formulation left out with the first reason that holds: its
experiment was switched off on the card, it has no result for a response switched on as a goal, a factor being
modelled is not on its record, or a setting lies outside the limits the optimizer works in at all (the `lo`–`hi`
of each factor in `space.js`). A formulation outside the *search range* typed on the screen is still used,
because it is evidence about the surface near that edge, and the card says so. The model is fitted on exactly
the formulations the card lists as used, and the header says "fitted on N formulations from M experiments".
Switched-off experiments are kept with the setup (`mlSetup.excluded`) and leave the ranges and the factor table
too, so an experiment left out cannot still widen a search range.

**2. Design space.** Factors come from the batch records themselves. A factor that never varied is listed and
marked as held constant rather than silently dropped, because "this cannot be judged" and "this does not
matter" are different statements. Search ranges default to the span already run, widened by a quarter.

**3. Model.** One Gaussian process per response: Matérn 5/2 kernel, one lengthscale per factor, fitted by
maximising the log marginal likelihood **plus the log prior** (maximum a posteriori, not maximum likelihood)
with analytic gradients checked against finite differences to one part in 10⁷.

- *Matérn 5/2 rather than squared exponential*: the squared exponential assumes an infinitely smooth response
  and is correspondingly over-confident between points. Matérn 5/2 is twice differentiable, which matches a
  physical response with real measurement noise, and its kernel matrices stay better conditioned as runs
  cluster, which matters when the Cholesky is your own rather than a well-tested library's. The standard
  toolbox has recently switched its own default to the squared exponential on the strength of high-dimensional
  benchmarks; at three to eight factors that advantage is undemonstrated, and the conditioning argument stands.
- *Priors rather than plain maximum likelihood*: maximum likelihood has nothing holding the lengthscales up, so
  on 10 to 40 runs it shrinks them, absorbs the noise into the signal, and reports near-zero uncertainty
  everywhere: the model then predicts the mean across most of the space and is confident about it. The priors
  used are the dimension-scaled set of Hvarfner et al. (ICML 2024), now the toolbox default: ln ℓ ~ N(√2 +
  ½ ln D, √3), so expected lengthscales grow as √D. That is deliberate: the distance between two random points
  in the unit cube grows the same way, so the prior means the same thing at three factors and at eight. A floor
  of ℓ ≥ 0.025 is the cheap insurance against collapse.
- *The signal variance is fixed at 1, not fitted*: the outputs are standardised, so 1 is correct by
  construction, and a fitted output scale tends to shrink over a campaign and pull the model toward over-local
  behaviour. One fewer hyperparameter is worth a great deal at this sample size.
- *Noise*: inferred under ln σ² ~ N(−4, 1) with a floor of 10⁻⁴. That prior is the BoTorch default rather
  than anything Hvarfner et al. propose; they put no prior on the noise at all. When repeated settings exist,
  their pooled scatter s² is evidence about the noise and enters the fit as exactly that: the likelihood of σ²
  given s² on its degrees of freedom (df·s²/σ² is χ² on df), added to the prior rather than put in its place.
  Thin evidence of this kind is lopsided. Two batches that happen to agree say little about how far the next
  two may differ, two that differ widely say a good deal, so one agreeing repeat barely lowers the noise, one
  that disagrees raises it, and twenty repeats pin it down either way. Binois et al. (2018, p. 26) warn against
  the empirical replicate variance below about fifty repeats, and a lab that has repeated one recipe three
  times has two degrees of freedom. The estimate used to replace the prior, centred on s² with the
  large-sample width √(2/df). Then the one repeat that "stop and confirm" asks for, landing close to the first,
  set the noise from a single degree of freedom, the surface grew sure of itself around the pick, and about one
  campaign in five that took the advice was told on the next screen to carry on. Plain `fixedNoise` still exists
  for a caller that genuinely knows the noise.
- *Two restarts, not the usual eight to sixteen*: multistart is the standard advice for ARD, and it is advice
  for maximum likelihood, where the surface has several optima. Measured on this module's own data, eight
  starts improved the total log marginal likelihood by 0.01 nat over one across eighteen fits, for thirteen
  times the work. The prior is informative enough to leave one optimum worth finding. The measurement is a
  test, not a claim (`tests/ml.test.mjs`, "multistart").
- *A Gaussian process even when another model cross-validates better*: it is the only learner here that reports
  uncertainty, and suggestions need uncertainty. When the quadratic surface wins the comparison the screen says
  so, and the proposals still come from the process that knows what it does not know.

**4. Suggestions.** Expected improvement in overall desirability, estimated by sampling each response from its
posterior and pushing the samples through the desirability function. Sampling rather than a closed form because
desirability is non-linear: the mean of the desirability is not the desirability of the mean, and the gap is
widest exactly where the model is unsure, which is where suggestions come from. Several runs at once are chosen
greedily under the kriging-believer rule (Ginsbourger, Le Riche & Carraro, 2010): take the best point, pretend
it returned the predicted value, re-condition, take the next.

The fantasy is a draw from the posterior rather than its mean, "randomised kriging believer", because
believing the mean exactly makes the batch over-confident about a result that has not happened yet, while a
draw keeps the spread of plausible outcomes and spaces the batch the way a joint selection would. Unlike the
plain version it also carries regret bounds.

Kriging believer is still not enough on its own. When the surface model is confident, expected improvement
stays high just beside the point already taken and four runs come back as four near-copies. So the module also
requires that no two suggestions sit within 15 % of the searched range of each other on every factor. A batch
is only worth its cost if the runs differ.

**Confirming the incumbent.** Expected improvement assigns no value to repeating a setting already measured, so
an optimiser left to itself never proposes a confirmation, and every suggestion is scored against an incumbent
that may be one lucky measurement. The module raises this itself: when the best run has never been repeated it
offers a repeat as a one-batch experiment. This is a documented gap in the acquisition functions, not a
shortcoming of any particular implementation.

**5. Attribution.** Permutation importance with repeats, model-agnostic so the learners are compared on equal
terms, cross-checked against the fitted lengthscales. Partial dependence curves carry the model's uncertainty
band and tick marks at the settings actually run, so extrapolation is visible.

**6. The map and the what-if box.** A contour of the predicted overall score across any two factors, with the
runs already done, the suggestions and the model's optimum drawn on it, sliced at the settings the best run
used for the other factors. It answers in one picture what a table cannot: whether the good region is a broad
plateau or a knife edge, whether the runs have been circling one corner, and whether a suggestion sits
somewhere never visited. Beside it, a box that takes a setting typed in by hand and returns the predicted
responses with intervals, and says plainly when the setting is outside everything run so far.

deliver. It also flags a suggestion that would mix in a different regime from the runs the model learned from:
one step along the ladder from engulfment to unsteady is a note, because neighbouring regimes shade into one
another, while turbulent mixing is a different process and the surface was never fitted across the change.
Lipid molarities with no matching stock on the shelf are flagged too. No published optimiser does any of this,
because no published optimiser sits inside the software that holds the process model.

**8. Closing the loop.** Suggestions become real planned batches with lot numbers, a production date, expected
measurement slots and calendar entries, through the same code path as any other experiment. Each batch stores
what the model predicted for it and why it was proposed. The prediction is the interval one batch made there
should fall in: the surfaces' uncertainty and their measurement noise together, from the surfaces as fitted.
From the second suggestion of a round on, the search picks on surfaces that pretend the earlier picks already
came back, and their narrower intervals are a device for spreading the round, not a forecast. On the campaign
lab, the surfaces' uncertainty about the mean held 57 % of single results; the stored interval holds 81 %.

The experiment's own page then shows that prediction beside the result, once measured, and marks whether the
result landed inside the stated interval. A run outside the interval is not a failure: it is the model saying
where it was wrong, which makes it the most informative batch of the round. Runs created before the noise was
stored carry only the surfaces' uncertainty about the mean, and the page says so instead of counting the
ordinary scatter of a batch as the model's miss. This is the part no published
tooling does, because the prediction is not stored anywhere once the notebook cell has run, and it is the
reason the module is inside the app rather than beside it: the training set grows, and the model's track
record accumulates, as a side effect of ordinary work.

## Where a suggestion goes

A suggestion that changes the lipid composition becomes a real entry in the composition registry, with its own
number and a synonym naming the composition it came from. It is not left as an annotation on the batch, because
the batch record the operator follows, the weigh-in calculator and the lot number all resolve the composition
by its id: a suggestion stored only as an override would be invisible to every one of them. The operator would
make the registry recipe, the model would later read the override back as though it had been made, and the
training set would quietly fill with compositions that never existed. A different lipid ratio is a different
composition, so it is registered as one.

The batch record itself now applies any composition override a batch carries, so the operator sees the recipe
that will be weighed out rather than the registry entry the batch was derived from. That also covers the DoE
screen, which varies a single lipid's mol% without taking the difference from another: the record says so, and
says what the adjusted percentages total, instead of printing a recipe that does not add up.

A recipe the balance cannot reach, the varied lipids already totalling more than 100, is refused before
anything is written, with the arithmetic shown. One that is merely outside the range this module treats as
ordinary, such as a very low helper lipid, is flagged and created: those bounds are convention, not physics,
and a module that refuses unusual recipes cannot find unusual answers.

## The mixture constraint

Lipid mol% has to total 100, which makes the composition a simplex rather than a box, and a design matrix of
four mol% columns is rank-deficient. Three treatments appear in the literature:

- **Re-parameterise to k−1 free quantities.** Maharjan et al. (*J Pharm Anal* 14:100996, 2024) encode four
  lipids as two ratios plus the PEG percentage, and fit Scheffé mixture terms crossed with the process factors.
- **Mixture-process design plus a virtual candidate library.** Ortiz-Perez et al. (*Digital Discovery* 3:1280,
  2024) sample a constrained library once and score it, so no candidate can violate the constraint.
- **Do not vary composition at all.** Tian et al. (*Nat Biotechnol*, 2026, doi:10.1038/s41587-026-03331-w)
  freeze the clinically precedented lipid ratios on purpose and optimise excipients instead, because changing
  the composition "introduces uncertainty regarding immune responses and safety". They give a second reason
  that matters here as well: excipient optima turn out to be specific to the composition, so each one gets its
  own surrogate rather than a shared model across compositions.

This module uses the first: one lipid class is nominated as the balance and absorbs whatever the varied classes
leave over. That is algebraically the same k−1 free parameters as the ratio encoding, it is what formulators do
by hand (vary ionizable and PEG, let cholesterol take up the slack), the search space stays a box the surrogate
handles natively, and the constraint holds exactly by construction rather than by renormalisation afterwards.
The screen names the balance class and carries the third point as a caution before you let the optimiser roam
over composition at all.

What this module does **not** do, and some published work does: treat lipid molar ratios as independent
factors in a Box-Behnken design and renormalise afterwards. That silently changes the factor you believed you
were holding constant.

The app now also offers the second treatment directly, as a design rather than as a surrogate: the DoE screen
builds simplex and constrained-region designs over lipids you pick by name, crossed with the process factors
where you want both, and fits a Scheffé model to them. `docs/MIXTURE.md` describes it. The two answer
different questions and are worth keeping apart: this module varies composition by *class* to search a space
it can model cheaply, while a blend design varies named lipids to find out what the blending itself does, and
can therefore tell two ionizable lipids apart where this module sees one number.

## Reading the quality figures

Q² is R² measured on held-out groups. The in-sample R² of a flexible model on 20 runs is close to 1 by
construction and is never shown.

Rank correlation is reported next to it, and on modest data it is the more useful number. Published LNP models
report held-out R² around 0.25 to 0.4 on new chemistry while still ranking well enough to find good
formulations, the AGILE work (*Nat Commun* 15:6305, 2024) reports R² 0.249 with Pearson 0.573 on a scaffold
split and calls the scores "modest" itself. The module is used to decide which setting to try next, not to
quote a number, so a model that orders settings correctly while predicting values poorly is still doing its
job. The verdict text says that in words when it applies.

The null check exists because on 20 runs a flexible model can reach a respectable Q² from pure noise. The
module shuffles the responses, refits the whole procedure, and reports the Q² that chance alone produces. If
the real fit is not clearly above it, the verdict says so and downgrades itself.

One-factor-at-a-time run histories are detected and flagged, because that pattern cannot separate interactions
and any interaction a model then reports is an artefact of the design.

## Is it earning its keep?

The most persuasive published result in this area is simply that optimisation beat picking at random with the
same number of runs. The module keeps that question visible: the progress panel plots the best score over time,
marks which runs it proposed, and states the share of suggested runs that set a new record against the share of
the user's own runs that did. If the suggestions are not winning, the user sees that before spending more
batches on them.

The test suite runs the same comparison against a synthetic but LNP-shaped truth. With four rounds of four runs
on top of an eight-run starting design, the optimiser beat random search with the identical budget in every
repeat (`tests/ml.test.mjs`, "closed loop").

`npm run campaign` (`tests/usability/campaign.mjs`) asks the same question at scale, with the app's own code against
a simulated lab whose optimum is known. Thirty campaigns of an eight-run start plus six rounds of four
(`docs/usability/campaign-standard-*.json`): the run a person would pick was within 95 % of the true optimum in
27 of 30 at 32 runs, against 11 of 30 for 32 random runs; a face-centred CCD with a quadratic fit did as well, on a
simulated lab that is nearly quadratic. Gains flatten after about 20 runs, and the model's pick (the run made whose
predicted score is highest) beats the single best measurement in every mode.

**Against 0.15.** The next stage (0.16) changed the noise prior, the speed of the fit and the interval reported
with a run, and added the selection, the lipid modes and the fingerprint around the same core. On the campaign
lab, 15 seeds, an eight-run start plus four rounds of four (`node tests/usability/campaign.mjs --seeds 15
--rounds 4`), at 24 runs:

| | 0.15 | 0.16 |
|---|---|---|
| Run a person would pick, median true score | 0.919 | 0.922 |
| Model's pick, median | 0.931 | 0.930 |
| Model's optimum, median | 0.923 | 0.933 |
| Within 95 % of the true optimum | 10 of 15 | 10 of 15 |
| Campaigns told to stop before round 4 | 4 of 15 | 4 of 15 |
| Suggested runs inside the 95 % interval stored with them | 78 % (562 of 720) | 97 % (699 of 720) |

The runs a person and the model would take forward are as good as they were; the predicted optimum moved up a
little with the new noise prior; and the intervals now hold what they promise (85 % with the new noise prior
alone, 97 % with the cross-validated calibration, `model.js`, `intervalScale`). The history
replay (`npm run history`, `docs/history-benchmark.md`) is on the simulated lab until a finished campaign of
the lab's own is available.

## When to stop

The same campaigns calibrate the sentence that opens the results (`app/calc/ml/stopping.js`, `roundVerdict`). It
reads two things: the best suggestion's chance of beating the best run so far, and whether the latest round raised
the model's pick. Below a 10 % chance after a round that did not raise the pick, the next round improved the true
result by more than 0.01 in 9 % of the simulated rounds, and the screen says to stop and confirm the best
candidates instead (a repeat of the model's pick and the predicted optimum made twice). From 35 % it says another
round is worth its batches (49 % of such rounds paid); in between, that it may still pay. Stopping where it says
saved 7 of 32 runs on average and gave up 0.006 in true desirability. Once the confirmation runs were in, 21 of
the 23 campaigns told to stop were told so again and none that another round was worth it; the other two read
"may still pay" at 11 and 16 %, as they do with the repeat's scatter left out of the noise altogether. Before a
single repeat entered the noise as the weak evidence it is (see *Noise* above), four in 21 were told to carry on.
The calibration rests on one simulated lab in balanced mode: treat the thresholds as a reasoned default, not a law.

## Readiness

| Runs with the chosen factors and a measured response | What the module offers |
|---|---|
| 0 to 7 | A space-filling starting design; no model |
| 8 to 14 | A first model with wide error bars, and suggestions |
| 15 to 24 | Cross-validated quality, attribution, suggestions |
| 25 and up | A predicted optimum as well |

These thresholds are stated in `READINESS` in `app/calc/ml/optimizer.js` rather than hidden in conditionals.

## Files

```
app/calc/ml/linalg.js     Cholesky with a jitter ladder, triangular solves, normal CDF and its inverse, seeded RNG
app/calc/ml/gp.js         Matérn 5/2 and squared-exponential kernels, marginal likelihood with analytic
                          gradients, Adam with early stopping, posterior mean/variance, fantasy conditioning
app/calc/ml/objective.js  Derringer-Suich desirability, weighted geometric mean, Pareto front
app/calc/ml/space.js      Factor definitions, unit-cube mapping, step snapping, the mixture balance
app/calc/ml/model.js      Learner zoo, grouped folds, Q², rank correlation, hit rate, null check, trust verdict
app/calc/ml/acquire.js    Latin hypercube, expected improvement by sampling, kriging-believer batches,
                          minimum separation, feasibility probability, predicted optimum
app/calc/ml/explain.js    Permutation importance, ARD cross-check, partial dependence, score grid, coverage
app/calc/ml/dataset.js    Batches and measurements to training rows; replicate noise
app/calc/ml/optimizer.js  One entry point: data in, report and suggestions out; readiness; progress tracking
app/ui/ml.js              The screen
tests/ml.test.mjs         Unit tests plus the closed-loop benchmark against random search
```

Everything is deterministic given the data, the goals and the seed, so a suggestion can be reproduced and
argued with months later. In a lab notebook that matters more than the last percent of performance.

## What this module does not model

Three things it can move but cannot measure, each of which could make a formulation worse while every number
on screen improves.

**Where the particle goes.** The five responses are physicochemical: size, dispersity, encapsulation, zeta
potential, RNA content. None of them is biodistribution, potency or tolerability. The seed paper's whole
subject is extrahepatic targeting, and it names PEG mol per cent, PEG molecular weight and PEG tail length as
what distinguishes liver from lung and heart uptake. PEG mol per cent is a factor this module varies. So
optimising dispersity by raising PEG can move the organ the particle reaches, invisibly, and no quality figure
here will notice. Treat a composition change found by this module as a candidate for a biological comparison,
not as an improvement already demonstrated.

**Immune response and safety.** Changing the lipid ratios changes both, which is exactly why Tian et al.
freeze the composition and optimise excipients instead. This module lets you vary composition because
formulators do; it has no way to tell you what it cost.

**Formulation buffer pH.** Sato et al. measure it as the strongest single driver of particle size, above
ethanol fraction. The app has no per-batch field for it, so it cannot be recorded, varied or suggested, and
every model here is conditional on whatever pH was used being constant. If it was not, the models are
attributing its effect to whatever else moved.

## Sources

Every identifier below was checked against public records on 2026-10-19, except where the entry says
otherwise. Two could not be confirmed and are marked. Nothing here was read in full text while the module was
written, apart from the seed paper, so treat the one-line role after each citation as this project's reading
of the work, not a quotation from it.

- Kausas M, Schastlivaia V. *Advancing targeted nanoparticle mRNA delivery using machine learning.* ChemRxiv 2026. doi:10.26434/chemrxiv.15010224/v2, posted 14 October 2026, CC-BY 4.0, not peer reviewed; the seed paper; best-practice rules above. The DOI matches the preprint's own title page character for character and still does not resolve in public search, which is a fact about the ChemRxiv record rather than a transcription error. It is a narrative review with no data of its own, so no benchmark can be inherited from it.
- Derringer G, Suich R. *Simultaneous optimization of several response variables.* J Qual Technol 1980;12(4):214-219, the desirability construction. **Unconfirmed:** no DOI found for this article.
- Ginsbourger D, Le Riche R, Carraro L. *Kriging is well-suited to parallelize optimization.* In: Tenne Y, Goh C-K, eds. Computational Intelligence in Expensive Optimization Problems. Springer 2010:131-162. doi:10.1007/978-3-642-10701-6_6; the q-point expected improvement a batch really needs (Eq. 6.19), and the two heuristics that avoid computing it. They recommend the constant liar and measure the kriging believer's improvement as zero at six and ten points (Table 6.1). This module uses neither: it draws one outcome from the posterior, which is a one-sample estimate of their integral. Measured on the closed loop in `tests/ml.test.mjs` that beats both heuristics here, and their own recommendation comes last. Author preprint free on HAL (emse-00436126).
- Maharjan R, Kim K H, Lee K, Han H-K, Jeong S H. *Machine learning-driven optimization of mRNA-lipid nanoparticle vaccine quality with XGBoost/Bayesian method and ensemble model approaches.* J Pharm Anal 2024;14(11):100996. doi:10.1016/j.jpha.2024.100996. Open access (PMC11696778); I-optimal design over lipid ratios and process variables; ratio re-parameterisation with Scheffé terms; desirability for multiple responses.
- *Accelerated discovery of thermostable mRNA-lipid nanoparticle vaccines using data-efficient AI.* Nat Biotechnol 2026. doi:10.1038/s41587-026-03331-w. The framework is called AGENT, from Jaklenec's group at MIT; a preprint is free on bioRxiv; Gaussian process with expected improvement over a small excipient space; random search as the baseline; the argument for freezing lipid composition.
- Sato S, Sano S, et al. *Understanding the manufacturing process of lipid nanoparticles for mRNA delivery using machine learning.* Chem Pharm Bull 2024;72(6):529-539. doi:10.1248/cpb.c24-00089. Free on J-STAGE; their Fig. 5 ranks formulation buffer pH first for particle size and ethanol fraction second, with total flow rate far behind both; the trio named in their abstract overstates total flow against their own measurements. Buffer pH is not a factor this module can vary, which is the largest gap in the factor list. XGBoost on sixteen formulations, then Bayesian optimisation on ten of them.
- Xu Y, Li B, et al. *AGILE platform: a deep learning powered approach to accelerate LNP development for mRNA delivery.* Nat Commun 2024;15:6305. doi:10.1038/s41467-024-50619-z. Open access (PMC11282250); one scaffold-grouped 80/10/10 split of 1200 lipids, not grouped cross-validation, and R² 0.249 with **Pearson** 0.573, not a rank correlation. The "modest scores, usable ranking" position is their practice, shown as a percentile precision matrix, rather than a principle they state. Their risk-averse ensemble mean minus standard deviation is a selection rule over virtual candidates; this module screens on the optimistic edge instead and does not implement it. Their scale, roughly 960 training points plus 60,000 pre-training molecules, says nothing about this module's readiness thresholds.
- Ortiz-Perez A, van Tilborg D, van der Meel R, Grisoni F, Albertazzi L. *Machine learning-guided high throughput nanoparticle design.* Digital Discovery 2024;3:1280-1291. doi:10.1039/d4dd00104d. Open access. The particles there are PLGA-PEG rather than lipid nanoparticles, so the method transfers but the chemistry does not; two guided rounds of ten from a fixed virtual library, with Dirichlet sampling over all four components and no balance class, so it does not support the balance-lipid device used here. Their quality filter is a separate model with a hard threshold applied before scoring, which this module does not have; its feasibility term is a probability from the same posterior. They explicitly decline to give a rule for switching from exploring to exploiting, which is why that remains a choice on screen. Their own numbers show the first guided round moving the result and the second barely at all.
- Hvarfner C, Hellsten E O, Nardi L. *Vanilla Bayesian optimization performs great in high dimensions.* ICML 2024, PMLR 235:20793-20817. arXiv:2402.02229; the dimension-scaled lengthscale prior, ln ℓ ~ N(√2 + ½ ln D, √3), and the fixed unit signal variance, both used here exactly as published. Two things attributed to them are not theirs: the noise prior is the BoTorch default and the lengthscale floor is this module's. Their demonstrated range starts at six dimensions and the degeneracy they fix begins around eighteen to twenty, so at two to six factors this module has their rationale without their evidence, and no evidence of harm either.
- Snoek J, Larochelle H, Adams R P. *Practical Bayesian optimization of machine learning algorithms.* NeurIPS 25, 2012. arXiv:1206.2944; the argument for Matérn 5/2 over the squared exponential, which is about smoothness; the conditioning argument once given here is not in the paper. They also integrate the acquisition over the hyperparameters rather than using a point estimate, which is what this module does, and their Fig. 1b shows the cost: the maximum of expected improvement moves with the lengthscale, so a point estimate aims the next run at the wrong place rather than merely with the wrong error bar. The informative prior and fixed amplitude narrow that gap. Slice sampling over the hyperparameters on the shortlist is the clearest remaining improvement to this module.
- Eriksson D, Jankowiak M. *High-dimensional Bayesian optimization with sparse axis-aligned subspaces.* UAI 2021, PMLR 161:493-503. arXiv:2103.00349; what the collapse looks like: short lengthscales send the posterior back to the prior, so the model predicts the average with intervals spanning the output range. It is empty rather than overconfident, which is why `collapseCheck` measures the share of prior variance left rather than looking for small error bars. Their regime is data scarce relative to dimension, a hundred points over hundreds of factors; at two to six factors this module is far outside it, and its own test shows the prior preventing the collapse on pure noise.
- Binois M, Gramacy R B, Ludkovski M. *Practical heteroskedastic Gaussian process modeling for large simulation experiments.* J Comput Graph Stat 2018. arXiv:1611.05902. **Unconfirmed:** the journal DOI 10.1080/10618600.2018.1458625 could not be verified; the preprint identifier can; the paper argues against the plug-in replicate variance it was once cited for here, and finds it biased high below about fifty repeats (p. 26). That finding is why the pooled estimate now anchors the noise prior instead of fixing it. Their heteroskedastic treatment starts paying off from around a hundred points and is sold on thousands, so not fitting input-dependent noise at eight to forty runs is sound, but the judgement is this module's rather than a sentence of theirs.
- Letham B, Karrer B, Ottoni G, Bakshy E. *Constrained Bayesian optimization with noisy experiments.* Bayesian Anal 2019;14(2):495-519. doi:10.1214/18-BA1110. Free on Project Euclid; the sentence about replication is theirs (p. 8), the conclusion drawn from it was not: they argue replicates are unnecessary in a continuous space because the acquisition samples near the incumbent instead, and call a replication strategy future work. Their noisy expected improvement also integrates over the latent values at the observed points, where this module fixes the incumbent at its raw measurement, which is the plug-in baseline they beat. Their trigger is noise on the order of the effect size; lab size and encapsulation sit below that, so the simpler form is defensible here.
- Lemkus T, Gotwalt C, Ramsey P, Weese M L. *Self-validated ensemble models for design of experiments.* Chemom Intell Lab Syst 2021;219:104439. doi:10.1016/j.chemolab.2021.104439. Preprint arXiv:2103.09303; the problem they name is estimability in a saturated design, where holding out a run makes model terms inestimable, which is not this module's problem: there are enough rows to hold out and the question is how to split them. Self-validated ensembles are not adopted. Their fractional weights are drawn per row, so twin batches of one composition would land on opposite sides of a split and leak, and the method carries no performance claim against an honest held-out score.
