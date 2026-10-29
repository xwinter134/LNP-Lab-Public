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
