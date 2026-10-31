# Third-party material

LNP Lab is released under the MIT License (`LICENSE`). The following material inside it comes from others and keeps
its own terms.

## CurTiPot (pKa database and the pH calculation)

- `app/data/pka.json` — the pKa database (263 entries; HEPES and MOPS added by hand) is taken from **CurTiPot**,
  the pH and acid–base titration spreadsheet by **Ivano G. R. Gutz**, Instituto de Química, Universidade de São
  Paulo (USP): <https://www.iq.usp.br/gutz/Curtipot_.html>.
- `app/calc/buffer.js` — a JavaScript re-implementation of CurTiPot's pH_calc approach (charge balance over
  polyprotic systems, Davies activity correction). The code is new; the method and the reference example used in
  the tests are CurTiPot's.

CurTiPot is distributed free of charge by its author. Its pKa data are **not** covered by the MIT License of this
repository. If you reuse them, credit CurTiPot and its author, and check the terms on the CurTiPot site.

## Published reference data

- Lipid molecular weights: supplier catalogues and PubChem.
- The reference composition (DLin-MC3-DMA / DSPC / cholesterol / DMG-PEG2000, 50 / 10 / 38.5 / 1.5 mol%) is the
  published Onpattro-like molar ratio.
- Buffer recipes: standard formulations from the literature.

None of the shipped data comes from a particular laboratory.

## Published methods the code implements

No code was taken from them; the methods were implemented from the papers. Where each is used, with the
licence and patent check, is in `docs/LICENSE-CHECK.md`.

- Hvarfner C, Hellsten E O, Nardi L. Vanilla Bayesian optimization performs great in high dimensions. ICML 2024.
- Binois M, Gramacy R B, Ludkovski M. Practical heteroskedastic Gaussian process modeling for large simulation experiments. J Comput Graph Stat 2018;27(4):808-821.
- Rasmussen C E, Williams C K I. Gaussian Processes for Machine Learning. MIT Press, 2006.
- Ginsbourger D, Le Riche R, Carraro L. Kriging is well-suited to parallelize optimization. In: Computational Intelligence in Expensive Optimization Problems, Springer 2010.
- Snoek J, Larochelle H, Adams R P. Practical Bayesian optimization of machine learning algorithms. NeurIPS 2012.
- Letham B, Karrer B, Ottoni G, Bakshy E. Constrained Bayesian optimization with noisy experiments. Bayesian Anal 2019;14(2):495-519.
- Eriksson D, Jankowiak M. High-dimensional Bayesian optimization with sparse axis-aligned subspaces. UAI 2021.
- Derringer G, Suich R. Simultaneous optimization of several response variables. J Qual Technol 1980;12(4):214-219.
- Plackett R L, Burman J P. The design of optimum multifactorial experiments. Biometrika 1946;33(4):305-325.
- Ryan T A, Joiner B L. Normal probability plots and tests for normality. Penn State, 1976.
- Maharjan R, et al. Machine learning-driven optimization of mRNA-lipid nanoparticle vaccine quality. J Pharm Anal 2024;14(11):100996.
- Sato S, et al. Understanding the manufacturing process of lipid nanoparticles for mRNA delivery using machine learning. Chem Pharm Bull 2024;72(6):529-539.

## Data

- Test fixtures from BioImage Archive S-BIAD3647 are CC0 (see tests/fixtures/ivis/ when present).
