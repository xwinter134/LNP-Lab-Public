# BLI test bench: automatic per-mouse flux against manual values (spec 8.7)

The spec asks for the approach with the best agreement with manual Living Image values, not the most elegant
one. Gholan's own 20–30 folders with his manual ROI values are not available yet, so this first bench uses the
only public set with raw Living Image folders and a published per-mouse flux table. Its numbers say how well the
arithmetic and the segmentation work on these images; they do not yet say how well they work on the lab's.

Run it again with `node scripts/bli-benchmark.mjs <bench-dir> --published <table.xlsx> [--json out.json]`.

## Data

| | |
|---|---|
| Source | BioImage Archive [S-BIAD3647](https://www.ebi.ac.uk/biostudies/BioImages/studies/S-BIAD3647), `Files/Figure 1/1O/`, **CC0** |
| Downloaded | 95 click folders (days 8–57 after implantation), 95 MB, plus `C57 KPC689 IVIS data.xlsx` (18 kB, sheet ROI: flux per mouse and day) |
| Kept | in the session scratchpad, **not** in the repository; one folder (`BMD20230209123405`, 0.8 MB) is the fixture under `tests/fixtures/ivis/` |
| Images | IVIS 200 Spectrum, Living Image 4.5.2, luminescent 240 × 240 at binning 8, f/1, FOV 21.8 cm, 60 s; photograph 480 × 480 at binning 4; C57BL/6 (black) mice, 3–5 per image, shoulder to shoulder under the anaesthesia manifold |
| Mice | 354 mouse images; ids left to right in `Comment1`; 269 published day values; 234–260 pairs per comparison (a folder counts only where the number of ids, ROIs or found mice matches) |
| Signal | orthotopic pancreatic tumours (KPC689-luc): one bright spot per mouse, not liver |
| Second source | Figshare 24970335 (CC BY 4.0, ex vivo organs, Living Image 4.7.4, square ROIs): one folder was parsed (`clickMeta`, `parseRois`); ex vivo segmentation is a later stage of the spec, so it is not benchmarked |

## 1. Conversion: counts to photons, checked on the hand-drawn ROIs

Every `AnalyzedClickInfo.txt` holds the circles the authors drew. Re-measured with this app's conversion
(`app/calc/ivis.js`: dark frame, C-ccd, exposure, unbinned pixel area, 4π, flat field) and compared with the
published flux, this tests the arithmetic without any segmentation.

| Conversion | n | r (log) | Bias | 95 % limits | Median \|diff\| | Within 20 % |
|---|---|---|---|---|---|---|
| with flat field | 234 | 0.951 | 1.06× | 0.36–3.17× | **1.4 %** | **92 %** |
| without flat field | 234 | 0.950 | 0.94× | 0.31–2.83× | 9.3 % | 85 % |
| with flat field, net of stage background | 233 | 0.951 | 1.02× | 0.34–3.07× | 1.6 % | 93 % |
| with flat field, the 215 pairs whose publication is self-consistent* | 215 | 1.000 | 1.01× | 0.95–1.08× | 1.2 % | 100 % |
| without flat field, same 215 pairs | 215 | 0.999 | 0.89× | 0.76–1.06× | 8.5 % | 90 % |

\* 19 of 234 pairs disagree by more than 20 % whatever the conversion: 3 mice of one day-8 image by a factor of
29 (the same factor for all three, so the published value is of another acquisition, probably a 2 s exposure
not in the archive), a few days where the ROI order does not follow the comment order, and mice under 1e5 p/s,
where a residual of one or two counts per pixel between the dark frame and the moment of exposure is a
large share of the signal (under 1e5 p/s: 68 % within 20 %; above: 95 %). These are limits of the reference,
not of the conversion.

**The 3–23 % gap is the flat field.** Without it, the first reconstruction read 0.70–1.11 times the published
value (median 0.92): the further a mouse lies from the optical centre, the lower. `ClickInfo.txt` carries the
lens's radial fall-off as a polynomial per shelf and f-stop (`Shelf Position D FF5 f/1 Coefs: k0…k4, x0, y0`,
r in cm from the optical centre); dividing each pixel by ff(r) takes the median difference from 9 % to 1.2 % and
the limits of agreement on the consistent pairs to 0.95–1.08×. On the fixture: 579G 3.49e5 vs 3.40e5 (+2.6 %),
580G 6.64e5 vs 6.60e5 (+0.7 %), 581G 2.31e6 vs 2.26e6 (+2.1 %); without the flat field −23 %, −9 %, −3 %.

## 2. Segmentation: automatic per-mouse flux

Each method finds the mice on the photograph, numbers them left to right, and sums the flux over each mask
(`app/calc/bli.js`). The count per image came from the comment's ids, as it would from the study plan.
"vs hand ROI" compares with the hand-drawn circles re-measured with the same conversion, which isolates the
segmentation from the reference's own inconsistencies.

| Method | vs | n | r (log) | Bias | 95 % limits | Median \|diff\| | Within 20 % |
|---|---|---|---|---|---|---|---|
| Otsu threshold only | published | 200 | 0.404 | 0.09× | 0.00–6.7× | 93 % | 11 % |
| Otsu + morphological cleanup | published | 261 | 0.890 | 1.17× | 0.22–6.1× | 12.7 % | 62 % |
| Stage-noise threshold + cleanup | published | 260 | 0.879 | 1.10× | 0.20–6.2× | 11.8 % | 63 % |
| **Stage-noise threshold + cleanup + 0.3 cm margin** | published | 260 | **0.896** | 1.21× | 0.25–5.9× | **10.3 %** | **65 %** |
| Otsu threshold only | hand ROI | 241 | 0.439 | 0.08× | 0.00–5.6× | 93 % | 12 % |
| Otsu + morphological cleanup | hand ROI | 312 | 0.930 | 1.11× | 0.29–4.3× | 10.2 % | 66 % |
| Stage-noise threshold + cleanup | hand ROI | 313 | 0.946 | 1.10× | 0.33–3.6× | 8.9 % | 68 % |
| **Stage-noise threshold + cleanup + 0.3 cm margin** | hand ROI | 313 | **0.961** | 1.19× | 0.43–3.3× | **7.9 %** | **71 %** |

On the 215 self-consistent pairs the winner reaches r = 0.942, median 9.1 %, 71 % within 20 %; above 1e5 p/s
73 % within 20 %.

**Winner: stage-noise threshold + cleanup + 0.3 cm margin**, the app's default (`DEFAULT_METHOD`). Every
result stores the method and the algorithm version.

What each step bought, and why:

- *Otsu on its own fails here.* The mice are black on a grey stage with a shaved white patch; Otsu splits
  "white patch" from everything else and drops the fur. The photograph is therefore compared with a fitted
  stage surface (a robust quadratic in log brightness, so vignetting does not count), and pixels that differ
  from it in either direction are object.
- *The noise rule* (4 robust standard deviations of the stage, at least 8 %) asks only "is this not stage?",
  and catches the fur.
- *Cleanup*: closing (fur texture), the manifold across the top removed (rows of the top third covering 70 %
  of the width), holes filled, an opening that removes tails and divider edges.
- *Joined mice* are shared out by the expected count, cut at the valley of the mask's column profile nearest an
  even split. A marker-based split (erode to cores, grow back) was tried and agreed no better; it was dropped
  for the simpler cut.
- *The margin*: light leaves the skin a little outside the photographed outline, and BLI has almost no
  background, so a generous mask costs little. It raises the bias slightly (1.19× against the circles,
  which only cover the tumour) and tightens the limits.
- *Net of background*: a residual of 1–2 counts per pixel after the dark frame, read on the stage away from
  every mouse, is subtracted over each mask. It mattered for whole-mouse sums: within 20 % of the published values went from 52 % to 66 % in an
  earlier round of the bench.

Where it still fails, from the overlays of the worst pairs:

1. **A very bright neighbour.** Next to a mouse at 5e7–7e7 p/s, the halo of scattered light reaches the
   neighbour's mask, and a cut a few pixels off moves a large share of flux between them (ratios of 0.1–0.2 and
   5–20 on adjacent pairs). Hand ROIs avoid this by staying small. This is optics, not segmentation: a better
   mask does not remove light that has spread into the neighbour. Remedies: image bright animals apart, or
   report a tumour/organ ROI beside the whole-mouse sum (the liver ROI is that for LNP studies).
2. **Whole mouse against a tumour circle.** Where the signal spreads past the drawn circle (metastases,
   ascites), the whole mask reads 1.3–2× the circle. That is a difference of definition, not an error; which
   one the lab wants is a question for Gholan.
3. **Heads under the manifold.** With mice shoulder to shoulder, the manifold cut can take heads and necks
   (this kept agreement best; stopping the cut at the first narrow row joined the mice through the manifold and
   agreed worse). The liver ROI is therefore placed 5.5 cm up from the tail base, not from the head, and the
   overlay shows where it is; it can be moved by hand and the move is logged.
4. **Low signal** (under 1e5 p/s): the dark-frame residual dominates (section 1).

## 3. When a learned model would be needed

SAM 2 or a YOLO detector are **not** added (a heavy new dependency, spec 12). They would be worth it when:

- the lab's images have touching animals in poses the column cut cannot part (curled, overlapping,
  head to tail), so that the mask partition, not the optics, causes the disagreements;
- white or nude mice on a light stage, where neither threshold rule separates animal from stage;
- ex vivo organs on a plate (spec: a later stage): liver, spleen and lung must be told apart, which no
  threshold does; a detector trained on the lab's own annotated images (CVAT) is the plan there.

None of these is shown by this set: the failures above are optical (scatter between neighbours) or
definitional (whole mouse against tumour circle). The corrections logged in the overlay (`bliImages.corrections`,
with the algorithm version) are the training data if the lab's images call for it.

## 4. What Gholan's folders must decide

- 20–30 of the lab's folders with the manual Living Image values (and how the ROIs were drawn: whole mouse,
  liver, or tumour), so the bench runs on the lab's mice, strain, coat colour, holder and instrument.
- Whether the comparison value is total flux over the whole mouse or over an organ ROI.
- The Living Image version and instrument, to check the calibration block and flat-field lines are the same.
