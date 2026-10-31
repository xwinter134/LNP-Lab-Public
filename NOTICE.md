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

## labdataranger (Living Image file parsing)

`app/calc/ivis.js` reads Living Image's `ClickInfo.txt` and `AnalyzedClickInfo.txt` following the approach of the
`sandbox/IVIS_Filetree_Parse.ipynb` notebook of **labdataranger**
(<https://github.com/ki-preclinical-imaging-and-testing/labdataranger>), released under the MIT License:

> Copyright (c) 2024 KI Preclinical Imaging and Testing
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without
> limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
> Software, and to permit persons to whom the Software is furnished to do so, subject to the following
> conditions: The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

The parser in LNP Lab is new code written from the files themselves; the notice is kept because the approach was
followed.

**radianceQuantifier / maRQup** (<https://github.com/soorajachar/radianceQuantifier>, GPL-3.0) describes finding
mice on the brightfield image and cropping each. Only that published idea informs `app/calc/bli.js`; no code of it
is in this repository, as GPL code cannot be in an MIT project.

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
- Otsu N. A threshold selection method from gray-level histograms. IEEE Trans Syst Man Cybern 1979;9(1):62-66. (`app/calc/bli.js`)
- Welch B L. The generalization of "Student's" problem when several different population variances are involved. Biometrika 1947;34(1-2):28-35.
- Holm S. A simple sequentially rejective multiple test procedure. Scand J Stat 1979;6(2):65-70.
- Šidák Z. Rectangular confidence regions for the means of multivariate normal distributions. J Am Stat Assoc 1967;62(318):626-633.
- Bland J M, Altman D G. Statistical methods for assessing agreement between two methods of clinical measurement. Lancet 1986;327(8476):307-310.

## Data

- `tests/fixtures/ivis/BMD20230209123405/` and the published flux values the BLI test bench compares with come from
  the BioImage Archive study **S-BIAD3647** (<https://www.ebi.ac.uk/biostudies/BioImages/studies/S-BIAD3647>),
  released under **CC0 1.0**; what was changed is in `tests/fixtures/ivis/README.md`.
