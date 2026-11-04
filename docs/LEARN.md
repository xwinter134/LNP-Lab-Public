# The reference and the planner

Two things that make the app teach rather than only compute. Both are optional in the sense that nothing else
depends on them, and neither hides a decision: the planner shows its reasoning, and the reference says where
its numbers come from.

## The reference

`app/learn/topics.js` holds 32 entries across five groups: formulation, process, measurement, design and
modelling. Each one is written to be read standing at a bench with a pipette in the other hand:

| Field | What it is for |
|---|---|
| `what` | The definition, in one or two sentences, with no pronoun at the front so it stands alone on a tile. |
| `why` | Why it matters for lipid nanoparticles specifically, not in general. |
| `numbers` | The values worth remembering, as rows. Typical ranges, thresholds, assay conditions. |
| `doing` | What to do with it at the bench. |
| `trap` | The mistake that costs a batch. |
| `more` | A paper, where one entry rests on a particular result. |
| `see` | Related entries. |

They surface in two ways. A `?` next to a term on any screen opens that entry in place, so a word you meet
while setting something up explains itself without losing your position; the Reference screen lists and
searches all of them, for reading rather than looking up. The explainer stacks, so following a related link
and coming back works, and closes on Escape.

Adding one is a matter of adding a key to `TOPICS` and dropping `info('key')` beside the term. The test suite
then checks it: every entry must have all its fields, belong to a listed group, start its definition with
something other than a pronoun, and link only to entries that exist.

## The planner

`app/calc/advise.js` is the reasoning; `app/ui/advisor.js` is the three questions. The questions are what
actually determines the answer:

1. **What are you trying to do?** Eight aims, including "work out what went wrong", which takes a different
   path entirely.
2. **How many batches can you run?** The right design is mostly a function of this number. A design that runs
   out of batches halfway answers nothing.
3. **What are you allowed to change?** Process only, process and composition, or nothing. Composition is a
   different kind of change with a different consequence, and the planner says so before you choose it.

It then recommends one of eight things, with the reasoning attached:

| Recommendation | When |
|---|---|
| One batch at a standard setting | Fewer than four batches, and nothing on file for a model to use |
| A spread-out starting set | A new system, or a budget below what a response surface needs |
| A screening design | You asked which factors matter, and six or more batches to find out in |
| A response surface | Thirteen or more batches, and not enough runs yet for a model to lead |
| Model-led rounds | Eight or more measured runs already on file |
| Repeat one recipe | You need to know your own noise before anything else is interpretable |
| A stability study | The question is about time, not about settings |
| A diagnosis | Something is off and you want the likely causes in order |

The batch budget is a hard constraint, not a preference. A design shrunk below its minimum does not answer a
smaller version of the question, it answers nothing, so each design has a floor the planner will not go under:
four corner runs and a centre point before a two-level screen can separate anything, about thirteen runs
before a response surface is worth fitting, and two runs per factor at the very least. Below a floor the
planner substitutes the best thing the budget can buy and says what it substituted and why, an explicit
request to screen on three batches becomes a plain batch with nothing varied, or, if eight runs are already on
file, the attribution the model reports over those, which answers the same question without spending a batch.

Every recommendation carries four things the screen shows separately: **why this and not something else**,
**what will happen**, **what usually goes wrong**, and **where you are starting from**, the last computed
from your own records, including whether you have ever repeated a setting.

### Which factors it proposes

`DRIVERS` ranks the factors that move each response, strongest first, with the reason a formulator would give.
The rankings are deliberately conservative and follow the process literature: flow rate ratio, ethanol fraction
and total flow dominate size and dispersity; N/P, assembly pH and ionizable mol% dominate encapsulation. A
factor that is strong for one response and moderate for another counts as strong, because ranking it by
whichever response happens to come first in the file would be an accident of how the file is written.

Factors outside the chosen scope are filtered out before ranking, so a process-only plan never proposes a
composition change it has been told not to make.

### Handing the plan over

A recommendation that has to be retyped is advice, not a setup. The "Set this up" button carries the
recommended factors, and for a design the design type, model and centre-point count, into the target screen
as parameters. The ML optimizer opens with those factors selected and their ranges taken from your own runs
where it has them; the DoE wizard opens with the factors named and the design chosen. Both say at the top
where the setup came from, with a link back, and everything stays editable.

### The diagnostic path

Six symptoms, each with three to five causes in order of how often they turn out to be the one, and each cause
carrying the check that settles it before a batch is spent. Most of those checks are answered by a record you
already have rather than by running anything, which is the point: the cheapest experiment is the one you do
not have to do.

## Sources for the content

The formulation and process entries follow the standard reviews and the process-parameter studies the ML
module also cites. Every one of these was then read in full against the entries, and the result was
uncomfortable: most of the numbers were not in the sources they appeared to come from.

What changed as a result. The review is qualitative on formulation and prints no mol per cent, N/P, size,
dispersity, encapsulation, zeta or pKa value anywhere, so the entries no longer imply it does. The
cryoprotectant figure is 5 per cent (w/v) sucrose or trehalose, not 5 to 10 per cent. The DSPC melting point
is about 54 °C, not 55. The claim that an extra half mol per cent of PEG takes 10 to 20 nm off the size is
supported by nothing here and now says so. The cholesterol threshold of 20 mol per cent is likewise
unsupported and has been replaced by the mechanism. Size does not govern biodistribution the way the entry
said: the reviews attribute organ tropism to lipid structure, and an alkyl chain length switches liver for
spleen at constant size. Dispersity is not on the release panel the review lists. The pKa window of 6.2 to
6.5 is confirmed verbatim, three times, but it is a steep gradient rather than a cliff, the titration runs
pH 3 to 10 on the assembled particle, and that paper never mentions N/P, so the N/P bands are now marked as
common practice rather than sourced to it.

Numbers that remain unsourced are labelled as such in the entry rather than quietly left to look
authoritative. The per-paper notes are in `docs/literature/`.

- Hou X, Zaks T, Langer R, Dong Y. *Lipid nanoparticles for mRNA delivery.* Nat Rev Mater 2021;6(12):1078-1094. doi:10.1038/s41578-021-00358-0. Free (PMC8353930); composition roles, size and biodistribution.
- Jayaraman M, et al. *Maximizing the potency of siRNA lipid nanoparticles for hepatic gene silencing in vivo.* Angew Chem Int Ed 2012;51(34):8529-8533. doi:10.1002/anie.201203263. Free (PMC3470698); apparent pKa and the 6.2 to 6.5 window.
- Sato S, Sano S, et al. *Understanding the manufacturing process of lipid nanoparticles for mRNA delivery using machine learning.* Chem Pharm Bull 2024;72(6):529-539. doi:10.1248/cpb.c24-00089; ethanol fraction, buffer pH and total flow as the dominant process parameters.
- Maharjan R, Kim K H, Lee K, Han H-K, Jeong S H. *Machine learning-driven optimization of mRNA-lipid nanoparticle vaccine quality.* J Pharm Anal 2024;14(11):100996. doi:10.1016/j.jpha.2024.100996; the response set and the desirability goals a formulation study actually uses.
- Derringer G, Suich R. *Simultaneous optimization of several response variables.* J Qual Technol 1980;12(4):214-219, desirability. No DOI found for this article.

The design and modelling entries follow the same sources as the ML module; see `docs/ML.md`.

### What the code itself cites

The methods the app computes with are cited where they are used and listed, with their licence and patent
check, in `docs/LICENSE-CHECK.md` and `NOTICE.md`. For the reader of this reference, the same list in one place:

- Optimizer and models: Hvarfner, Hellsten, Nardi (ICML 2024); Binois, Gramacy, Ludkovski (JCGS 2018); Rasmussen and Williams, *Gaussian Processes for Machine Learning* (2006); Ginsbourger, Le Riche, Carraro (2010); Snoek, Larochelle, Adams (NeurIPS 2012); Letham et al. (Bayesian Anal 2019); Eriksson and Jankowiak (UAI 2021); Derringer and Suich (1980).
- Designs and diagnostics: Plackett and Burman (Biometrika 1946); Ryan and Joiner (1976).
- Buffers: CurTiPot by I. G. R. Gutz (USP), pKa data and the pH method with the Davies activity correction.
- Statistics of groups and studies: Welch (Biometrika 1947), Holm (Scand J Stat 1979), Šidák (JASA 1967); agreement of the automatic and manual BLI values: Bland and Altman (Lancet 1986).
- BLI images: Otsu (IEEE Trans Syst Man Cybern 1979) for the threshold; the Living Image file parsing follows labdataranger (MIT, KI Preclinical Imaging and Testing); radianceQuantifier (GPL-3.0) for the idea of finding mice on the photograph, no code; test data from BioImage Archive S-BIAD3647 (CC0). InVivoPLOT (Klose et al., Nat Commun 2018) is deliberately not rebuilt (spec 8.7).

## Testing

`tests/advise.test.mjs` checks the content as well as the code, because an explainer with a dangling link or a
recommendation citing a topic that does not exist is a defect the user meets. It asserts that every aim,
budget and scope combination produces a recommendation with reasons, expectations and a caution; that no
recommendation asks for more batches than you said you had or varies more factors than its runs can separate;
that every factor named is one the app can actually set; that scope is respected; that factors come out ranked
by strength; and that every symptom offers ordered causes with a check and a fix.

A browser scenario walks the planner from the first question to a recommendation, changes an earlier answer to
confirm the later ones are cleared rather than left stale, follows both hand-over links to the screen they set
up, follows the diagnostic path, opens an explainer, follows a related link, steps back by button and by key,
closes on Escape, checks the explainer does not survive a navigation, and searches the reference index.
