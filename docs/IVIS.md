# IVIS bioluminescence images: what exists to build on (spec 8.7)

Research for the automatic BLI image analysis in phase 6, done before any of Gholan's own IVIS folders were
available. Each source below was opened; licences are as stated by the source. Searched 2026-10-31.

## Short answer

- **No annotated public IVIS dataset was found** (no mouse masks or labelled ROIs on IVIS photographs). The
  own dataset will have to be built from the corrected masks, as the spec foresees.
- **Two openly licensed sets hold untouched Living Image export folders**, one of them with whole mice and a
  per-mouse flux table: good as parser fixtures and as a first check of the counts-to-flux conversion.
- **The simplest planned approach is also what the closest open tool does**: threshold the photograph, take
  connected components, number the mice left to right.

## 1. Datasets

| Source | Licence | What it is | Use here |
|---|---|---|---|
| [BioImage Archive S-BIAD3647](https://www.ebi.ac.uk/biostudies/BioImages/studies/S-BIAD3647) | CC0 | 190 raw Living Image click folders (`AnalyzedClickInfo.txt`, `ClickInfo.txt`, `luminescent.TIF`, `photograph.TIF`, dark/bias frames), in vivo mice, about 3 per image, IVIS 200 / Living Image 4.5.2. Mouse ids in `Comment1`, hand-drawn circle ROIs in the ROI section, flux per mouse in `Figure 1/1O/C57 KPC689 IVIS data.xlsx`. Files under `https://ftp.ebi.ac.uk/biostudies/fire/S-BIAD/647/S-BIAD3647/Files/` | First parser fixture and flux check |
| [Figshare 24970335](https://figshare.com/articles/dataset/Supplemental_data_to_Electrostatic_adsorption_of_polyanions_onto_lipid_nanoparticles_controls_uptake_trafficking_and_transfection_of_RNA_and_DNA_therapies_/24970335) (PNAS, LNP biodistribution) | CC BY 4.0 | 12 raw folders inside a 1.85 GB zip, ex vivo organs, Living Image 4.7.4, square ROIs | Second fixture; ex vivo stage later |
| [Zenodo 1021607](https://zenodo.org/record/1021607) | CC BY 4.0 | 209 exported 8-bit RGB overlays of mice, dorsal and ventral | Segmentation tests on photos only, no counts |
| [Figshare 29984677](https://figshare.com/articles/dataset/Cardiac_Lysosomal_Organisation_During_Ageing_IVIS_Imaging_qPCR_Analysis_and_R-Based_Statistical_Models/29984677) | CC BY 4.0 | PNGs plus Living Image ROI tables (fluorescence) | Little |
| [DAMM mouse detection](https://huggingface.co/datasets/gauravkaul/DAMM_mouse_detection) | CC BY 4.0 | about 8.5k top-view frames with boxes and polygon masks | Only if a trained detector is needed; behaviour arenas, large domain gap |

Not found: anything on IDR; two HKU DataHub sets that mention `AnalyzedClickInfo` are embargoed.

## 2. Tools and models

| Tool | Licence | Note |
|---|---|---|
| [radianceQuantifier / maRQup](https://github.com/soorajachar/radianceQuantifier) ([eLife](https://elifesciences.org/articles/106470)) | GPL-3.0 | Finds mice by thresholding the brightfield, crops each, removes tails; reads radiance from the colour bar of RGB overlays. Closest to the planned first stage. GPL: ideas only, no code into this MIT project |
| [labdataranger](https://github.com/ki-preclinical-imaging-and-testing/labdataranger) | MIT | Small Python parser for ClickInfo files (`sandbox/IVIS_Filetree_Parse.ipynb`). Permissive, can be followed with attribution |
| [PIXI XNAT plugin](https://github.com/preclinical-imaging/pixi-plugin) | none stated | Java parsers for ClickInfo / AnalyzedClickInfo; useful as a field list only |
| [bioluminescence_roi_detector](https://github.com/luissanduc/bioluminescence_roi_detector) | none stated | Roboflow model on `photograph.TIF`, writes ROIs back into AnalyzedClickInfo; shows the ROI syntax Living Image accepts. No licence: do not reuse |
| [SAM 2](https://github.com/facebookresearch/sam2) | Apache 2.0 | Cleanest licence if touching mice or tails need a learned mask |
| [DeepLabCut SuperAnimal-TopViewMouse](https://huggingface.co/mwmathis/DeepLabCutModelZoo-SuperAnimal-TopViewMouse) | modified MIT, non-commercial | Detector and keypoints; licence excludes commercial use |

No Fiji/ImageJ macro or napari plugin for IVIS was found.

## 3. The export folder

From the downloaded folders and the [Living Image 4.5 manual](https://www.biotech.cornell.edu/sites/default/files/2020-06/IVIS%20Spectrum%20software%20manual.pdf):

- One folder per acquisition ("click"), often inside a `*_SEQ/` folder with `SequenceInfo.txt`.
- `luminescent.TIF`: 16-bit counts (240×240 at binning 8). `photograph.TIF`: 16-bit (480×480 at binning 4).
  Dark/bias frames: `readbiasonly.TIF`, or `readbias.TIF` plus `background.TIF`, with a `Data Multiplier`.
- `AnalyzedClickInfo.txt` and `ClickInfo.txt`: tab-separated `Key:\tValue` lines in sections starting
  `*** name:`. Luminescent: `Binning Factor`, `Luminescent Exposure (Seconds)`, `f Number`, `Field of View`
  (cm), `Read Bias Level`, `Image Units: counts`, `Background Corrected`, `Flat Field Corrected`. Photograph:
  `Exposure Time Sec`, `Binning Factor`, `f Number`, `Field of View`. `ClickInfo.txt` adds the instrument,
  `CCD Saturation Level: 61000` and the radiance calibration `Coef C-ccd at FOV 21.8, f1: 1.049E+06`
  (p/s/cm²/sr per count/s), one per field of view and f-stop. ROIs are in unbinned pixels.
- Total flux (manual): radiance summed over the ROI area × 4π. A first reconstruction,
  flux ≈ Σ (counts − dark) × C_ccd / t_exp × (cm per unbinned pixel)² × 4π, matched the published flux of one
  S-BIAD3647 image to 3 % and 10 % for two mice and was 23 % low for the third (mouse-to-ROI mapping assumed, flat
  field not applied). **Not to be trusted for absolute numbers until checked against Gholan's own Living Image
  ROI exports**; the flat-field correction is the most likely gap.
- Update (phase 6): it was. With the flat-field polynomial from `ClickInfo.txt` applied, the hand-drawn ROIs of
  95 folders re-measure to a median 1.4 % of the published flux (see `docs/BLI-BENCHMARK.md`).

## 4. Plan this leads to

1. Write an own parser for the two text files (MIT, following labdataranger's approach) and the TIFFs, with
   S-BIAD3647 folders as fixtures (CC0, so they may be committed).
2. Radiance from counts with the `C-ccd` coefficient; saturation check against `CCD Saturation Level`.
3. Mice: Otsu threshold on `photograph.TIF`, connected components, numbering left to right, long axis from the
   mask. SAM 2 only if touching animals or tails spoil this on real images.
4. The test bench of the spec (20–30 of Gholan's folders with manual Living Image values) decides; until then
   S-BIAD3647's published flux table is the only external check.

What is still needed from Gholan: 20–30 export folders with the manual ROI values from Living Image, and which
Living Image version and instrument they come from.
