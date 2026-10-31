# Licence and patent check of the methods in LNP Lab (spec 11.1)

An overview to support the open-source release, not legal advice. Ideas and algorithms are not protected by
copyright, code and text are; patents are a separate question. Where a row says "check", it needs a person to
look, and where a patent is possible, specialist advice.

**Status:** pre-filled from the publications the code itself cites. Gholan's own list of the five to ten LNP-ML
papers whose methods went into the app is still to come; each one gets a row here.

**Licence:** the repository is MIT-licensed (`LICENSE`). Third-party material it contains, the CurTiPot pKa data
first, keeps its own terms (`NOTICE.md`).

| Paper | Where in the code | Method only, or code too? | Licence of the original code | Patent or application? | Cited in comment and NOTICE? |
|---|---|---|---|---|---|
| CurTiPot (Gutz, USP): pKa database and the pH calculation method | `app/data/pka.json`, `app/calc/buffer.js` | Data taken; method re-implemented | free of charge, own terms (not MIT) | no | NOTICE yes |
| Hvarfner, Hellsten, Nardi: *Vanilla Bayesian optimization performs great in high dimensions*, ICML 2024 | `app/calc/ml/gp.js` (lengthscale prior) | Method: the prior's two numbers, as used by BoTorch; no code taken | BoTorch: MIT (numbers only, no code copied) | none known; check | comment yes, NOTICE yes |
| Binois, Gramacy, Ludkovski: *Practical heteroskedastic Gaussian process modeling*, JCGS 2018 | `app/calc/ml/gp.js` (replicate noise) | Method (a caution about replicate variance) | hetGP: LGPL; not used | none known | yes / yes |
| Rasmussen & Williams: *Gaussian Processes for Machine Learning*, MIT Press 2006 | `app/calc/ml/gp.js` (GP, LOO eq. 5.12) | Textbook method | book text CC BY-NC-ND online; no code taken | no | yes / yes |
| Ginsbourger, Le Riche, Carraro: *Kriging is well-suited to parallelize optimization*, 2010 | `app/calc/ml/acquire.js` (batch suggestions) | Method | none | none known | yes / yes |
| Snoek, Larochelle, Adams: *Practical Bayesian optimization of machine learning algorithms*, NeurIPS 2012 | `app/calc/ml/acquire.js` | Method (expected improvement over pending runs) | Spearmint: academic licence; not used | none known; check | yes / yes |
| Letham et al.: *Constrained Bayesian optimization with noisy experiments*, Bayesian Analysis 2019 | `app/calc/ml/acquire.js` | Method | BoTorch/Ax: MIT; not used | none known | yes / yes |
| Eriksson & Jankowiak: *High-dimensional Bayesian optimization with sparse axis-aligned subspaces*, UAI 2021 | `app/calc/ml/explain.js` (collapse check) | Method (a failure description) | none used | none known | yes / yes |
| Derringer & Suich: *Simultaneous optimization of several response variables*, J Qual Technol 1980 | `app/calc/ml/objective.js`, `app/calc/balance.js` | Method | none | expired if any (1980) | yes / yes |
| Plackett & Burman: *The design of optimum multifactorial experiments*, Biometrika 1946 | `app/calc/doe.js` | Method (generator rows) | none | no (1946) | yes / yes |
| Ryan & Joiner 1976 (normal probability plot correlation) | `app/calc/diagnostics.js` | Method, in Minitab's published polynomial form | none | no | yes / yes |
| Maharjan et al.: *Machine learning-driven optimization of mRNA-lipid nanoparticle vaccine quality*, J Pharm Anal 2024 | `app/calc/ml/objective.js` (goal limits) | Numbers (quality limits) | none used | check | yes / yes |
| Sato et al.: *Understanding the manufacturing process of LNPs for mRNA delivery using machine learning*, Chem Pharm Bull 2024 | `app/calc/advise.js`, `app/calc/ml/space.js` | Findings (factor ranking, ranges) | none used | check | yes / yes |
| Klose et al. (InVivoPLOT), Nat Commun 2018 | not implemented on purpose (spec 8.7) | none | n/a | **patented per the maker**: the app does not build the holder plus organ atlas | n/a |
| (Gholan's list) | | | | | |

Rules that follow (spec 11.1):
- Code under GPL may not go into an MIT project; code under MIT or BSD only with its copyright notice. None is
  copied today, as far as the code's comments and history show; this is to be confirmed when the paper list comes.
- Published does not mean patent-free, and non-commercial use does not protect from infringement by itself. Any
  hit: specialist advice.
- Suggestion: a short note to each paper's authors that their method is in the tool.
