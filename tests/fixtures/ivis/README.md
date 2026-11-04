# IVIS fixture: one Living Image export folder

`BMD20230209123405/` is one acquisition ("click") from the BioImage Archive study
[S-BIAD3647](https://www.ebi.ac.uk/biostudies/BioImages/studies/S-BIAD3647), published under
**CC0 1.0** (public domain dedication). Source path:
`https://ftp.ebi.ac.uk/biostudies/fire/S-BIAD/647/S-BIAD3647/Files/Figure 1/1O/IVIS data/Day 14/BMD20230209123405/`

What it is: three C57BL/6 mice (ids 579G, 580G, 581G in `Comment1`, left to right) with orthotopic KPC689
pancreatic tumours, imaged on an IVIS 200 Spectrum with Living Image 4.5.2, day 14 after implantation; a 60 s
luminescent image at binning 8 and f/1, a photograph at binning 4, read-bias and dark-charge frames, and three
hand-drawn circular ROIs. The published per-mouse total flux for day 14 ("C57 KPC689 IVIS data.xlsx", sheet
ROI) is 579G 3.402e5, 580G 6.597e5, 581G 2.261e6 p/s.

Changes from the archive: the folder's PNG overlay was left out, and two software licence keys that the
instrument's configuration block in `ClickInfo.txt` carried in a comment were replaced by
`[licence key removed]`. Nothing else was changed.

Used by `tests/ivis.test.mjs` and `tests/bli.test.mjs`. The larger test bench (95 folders, about 90 MB) is not
in the repository; see `docs/BLI-BENCHMARK.md` and `scripts/bli-benchmark.mjs`.
