# Blend designs: choosing the lipids, not just the process

A process factor can be set anywhere in its range without touching the others. Raise the flow rate and the
N/P ratio is where you left it. Lipid mol% does not work that way: the blend adds up to 100, so raising the
ionizable lipid has lowered something else, and a design that pretends otherwise cannot tell you which of the
two did the work.

That is the whole of the difference, and everything below follows from it.

## The three modes

The DoE wizard asks what you are optimizing before it asks anything else.

| Mode | What varies | The model |
|---|---|---|
| **Process parameters only** | flow rate ratio, total flow, N/P, temperature | ordinary polynomial, as before |
| **Lipid mixture only** | the mol% of lipids you pick | Scheffé canonical polynomial |
| **Mixture and process together** | both, in the same runs | the two crossed |

The third is the one worth having. Running a blend design at one fixed flow rate and a process design at one
fixed blend answers two smaller questions and misses the one that matters: whether the blend you optimised is
still the best blend once the process changes. Only a crossed design can answer that, because only a crossed
design has runs where both differ.

## Picking the lipids

Any lipid in the registry, any number from two upwards, and more than one of the same class is fine. That last
point is why this exists alongside the ML optimizer: the optimizer varies composition by *class*, ionizable,
helper, sterol, PEG, so two ionizable lipids in one recipe are a single number to it, and a blend of the two
is a question it cannot pose. Here they are separate components with separate coefficients.

Each lipid gets a lowest and a highest mol%. Switching into a blend mode fills the table from the composition
you chose, with each lipid free to move ±30 % of where it sits now; ±30 % always leaves a feasible region,
since the lower bounds then add to 70 and the upper to 130, which straddles 100.

Two ways to get this wrong, both caught before you can build the design:

- lower bounds adding to more than 100, no blend satisfies them
- upper bounds adding to less than 100, no blend reaches the total

## Why the design is not a grid

With lower bounds alone, the feasible blends are still a simplex and the classical designs apply: a
**simplex centroid** (each lipid as high as the bounds allow, every pairwise blend, the overall centre) or a
**simplex lattice** at whatever degree you ask for. Both are built on **L-pseudo-components**, the transform
`x' = (x − L) / (total − ΣL)`, so every point respects the lower bounds exactly rather than most of the design
landing outside the region and being thrown away.

Once an upper bound bites, the region is a polytope inside the simplex and the corners are no longer the pure
components. The app enumerates them by the McLean–Anderson construction: fix every component but one at a
bound, solve for the last, keep it if it lands inside its own bounds. Corners, edge midpoints, interior
centroids and the overall centre make the **candidate pool**.

The pool is not the design. Four lipids with real bounds give a few hundred candidates, and a crossed design
multiplies that by the process grid, 2 500 is ordinary. These are blends worth considering, not batches worth
making.

## Choosing the runs

A **run budget** turns the pool into an experiment: the app keeps the runs that determine your model best, by
D-optimal exchange, the subset whose information matrix has the largest determinant. The wizard suggests
`terms + 5`, because a design with exactly as many runs as terms fits perfectly and tells you nothing about
whether the model is right, and five spare runs plus the centre replicates is enough to see a lack of fit.

The exchange is driven by the determinant *ratio* rather than the determinant. Swapping run *i* out and
candidate *j* in multiplies |X'X| by

    (1 + x_j' M⁻¹ x_j)(1 − x_i' M⁻¹ x_i) + (x_i' M⁻¹ x_j)²

so one matrix inverse per accepted swap costs O(k) per candidate pair instead of a fresh Cholesky. That is the
difference between a wizard that answers and one that hangs: a four-lipid crossed design went from 7.2 seconds
to 160 milliseconds, which is what lets the preview rebuild while you type. `tests/mixture.test.mjs` checks the
ratio against a recomputed determinant, and the exchange against an exhaustive search over every subset.

Points are never selected twice. Replication is a deliberate choice at the centre of the region, not something
the search does on its own, and those replicates are what give an independent estimate of pure error.

**The search works in a basis where every term counts equally.** On a realistic LNP region the model columns
differ by three orders of magnitude in mol% (a pairwise term of two major lipids is in the thousands, a PEG term
near one), and PEG held between 1 and 2 mol% spans only 0–0.03 in pseudo-components. Run in those units, the
exchange could not see the PEG directions at all: the default four-lipid blend × process design came out with
rank 28 for its 30 terms, and the fit said "singular design" only after all 38 batches had been made. The
candidates are now expressed in an orthonormal basis of their own model space before the exchange (which changes
no determinant ratio, so the D-optimal choice is the same), the selection is made in the pseudo-components the fit
uses, and the first start is built one independent run at a time, so whenever the candidates can fit the model the
selected design can too. A region the model cannot be fitted on at all is refused while the wizard is still open,
with the reason, rather than discovered afterwards.

## The model

Scheffé canonical polynomials, with **no intercept**. On a simplex the components already sum to a constant, so
a constant column is a linear combination of them and the normal equations are singular. Dropping it is not a
trick; it is what makes the model fittable.

| Order | Terms | Reads as |
|---|---|---|
| linear | `Σ βᵢ xᵢ` | each lipid contributes in proportion |
| quadratic | `+ Σ βᵢⱼ xᵢxⱼ` | pairs blend better or worse than their average |
| special cubic | `+ Σ βᵢⱼₖ xᵢxⱼxₖ` | three-way blending |

A crossed model is every blending term on its own and multiplied by every process term. That is what says the
*shape* of the blend response may itself depend on the process setting, the question the design was built to
ask.

**The coefficients are predictions, not slopes.** A lipid's own coefficient is what the response would be at
that lipid's corner of the region; comparing two of them compares two corners. A pairwise coefficient is how
far the blend departs from the straight line between those two corners: positive means blending them beats the
average, negative means it falls short.

One consequence worth knowing before it surprises you: on a narrow region, a PEG held between 1 and 2 mol%,
say, a corner of the region sits far outside where the data is, so that lipid's coefficient is an
extrapolation with a standard error to match. A coefficient of −2 968 ± 3 639 is not a bug. It is the model
saying it has no idea what a blend of nothing but PEG would do, which is correct, and the reason to read the
response trace rather than the coefficient table when the ranges are tight.

## Reading the result

**The ternary plot** (three lipids) draws the design on the triangle, with the feasible region outlined. It is
drawn in pseudo-components by default, because with realistic LNP bounds the region is a sliver in the corner
of a mostly empty simplex: technically correct, unreadable, and no help in choosing a run. Each corner is
labelled with how high that lipid goes there. Above three lipids there is no single picture of the design
space, so the fallback is parallel coordinates with each axis on its own mol% range.

**The response trace** is the mixture answer to a main-effects plot, which a blend cannot have: raising one
lipid has to lower the others. Cox's construction moves one lipid along the line from a reference blend toward
its own vertex, letting the rest fall in proportion. Two things have to be right or it misleads:

- *The reference blend must be inside the region.* The centre of the simplex is not: with PEG between 1 and
  2 mol%, the equal-parts blend puts it at thirteen. The app traces from the centre of the **region**, which
  is the blend the centre replicates already run.
- *The line must stop at the bounds.* Run it to the vertex and the far end of every trace is the model
  extrapolating to blends the design never approached.

Read a flat line confidently: that direction does nothing. Read a steep line as a direction worth moving in,
not as a culprit: raising one lipid pushes the others down, so its trace carries their effects too.

**The Pareto, residual, normal and measured-against-predicted plots** mean the same here as anywhere; they are
about the fit, not the factor space. The fitted-surface and single-factor-effect plots are *not* shown for a
blend, because they hold the other factors at zero, and on a simplex zero for every other component is not a
blend at all.

**The predicted optimum** searches the candidate blends the design was chosen from, rather than walking a
grid. Every point it considers is a composition you could weigh out. Anything outside that region is
extrapolation and the model has no business being believed there.

## What reaches the bench

A blend run names every lipid outright, so it cannot travel as a class override: there is no "ionizable mol%"
to set when the design is choosing between two ionizable lipids. The batch carries an explicit mol% map, and
the formulation screen says so at the top of the record: *this run is the blend; weigh out what is listed here
and not the registry recipe.* Lipids the design does not include are not in the blend, even when the registry
entry it descends from has them.

Process factors in a crossed design still drive the plan the way they always did.

## What this does not do

**The Python pipeline has no mixture designs.** It builds the factorial, central-composite and Box-Behnken
family and fits an ordinary polynomial, so there is no config to export for a blend. The app refuses rather
than writing a file the pipeline would reject three steps later. The design CSV and the measured-data CSV
still export, and the in-app fit and diagnostics are where a blend is analysed.

**No lack-of-fit test yet.** The centre replicates give pure error and the residual degrees of freedom are
reported, but the formal test is not implemented. The replicate scatter against the residual spread is the
manual version.

**The ML optimizer is still class-based.** It varies ionizable, helper, sterol and PEG as classes with one
absorbing the remainder, which is described in `docs/ML.md`. A blend design and the optimizer therefore answer
different questions, and a blend design's runs feed the optimizer only through those class totals.

**No ratio or component-amount designs.** Everything here holds the total fixed at 100 mol%. Designs in which
the total itself varies, an amount-of-mixture design, are a different construction and are not implemented.

## Where the code is

| File | What is in it |
|---|---|
| `app/calc/mixture.js` | the geometry, the Scheffé terms, the fit, the D-optimal exchange |
| `app/calc/doe.js` | the three modes, validation, `buildDesign`, the design cache |
| `app/calc/diagnostics.js` | `blendTrace`, the Cox response trace |
| `app/ui/designviz.js` | the ternary plot and the parallel-coordinates fallback |
| `app/ui/doeplots.js` | `traceSvg` |
| `app/ui/experiments.js` | the wizard: mode, lipid picker, budget |
| `app/ui/doe.js` | the design table, the Scheffé fit, the diagnostics, the optimum |
| `tests/mixture.test.mjs` | 32 checks, including the two against independent answers and the default design's rank |

## Reading

Cornell, *Experiments with Mixtures*, 3rd ed. (Wiley, 2002) is the standard reference for everything above:
Scheffé polynomials, simplex lattice and centroid designs, pseudo-components, response traces. McLean &
Anderson, *Technometrics* 8:447 (1966) is the extreme-vertices construction. Fedorov, *Theory of Optimal
Experiments* (Academic Press, 1972) is the exchange algorithm and the determinant update.

For the LNP context, `docs/ML.md` § "The mixture constraint" collects what the recent literature does about
the sum-to-100 problem, and why this app now offers both the class-based treatment the optimizer uses and the
Scheffé treatment described here.
