# CatMeows baseline: 2026-11-01

This is a local pipeline measurement, not a validated household detector or an intent model. Dataset: [CatMeows v1.0.2](https://zenodo.org/records/4008297), DOI 10.5281/zenodo.4008297; authors and research/non-commercial terms are acknowledged in README.md.

## Reproduction

Run setup, download, `manage.py prepare-catmeows`, then `manage.py evaluate-catmeows`. No API/database is needed. Full manifests/audio/reports remain local under ignored CatMeows/. The recorded run is `run-20261101T074140Z-232ee0e2f3`; its report is in the normal checkout's CatMeows/reports/ directory.

- Source: 440 primary meows from 21 cats; all 483 primary/supplementary original WAV hashes were unchanged after preparation and scoring.
- Preparation: `catmeows-pcm16-8k-to16k-polyphase2-kaiser5-v1`, SciPy 1.15.3, NumPy 2.2.6. Exactly 2x samples, no saturated samples in this inventory.
- Inference preprocessing: `pcm16-16k-mono-window15600-hop7680-v1`.
- Model: `yamnet-tflite-float32-1`, SHA-256 `4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf`, LiteRT 2.3.0, two CPU interpreter threads.
- Host/runtime: Windows AMD64, Python 3.13.1. Other processes, storage caches and scheduling were uncontrolled; CPU model and native memory were not benchmarked.

## Coverage and latency

440 selected, 440 scored, zero failures. Calibration: 277 clips/14 cats/36 session IDs. Evaluation: 163 clips/7 cats/16 session IDs. These are deterministic cat-exclusive metadata groups; the pretrained model was not fitted or calibrated on either group.

| Measurement | Milliseconds |
| --- | ---: |
| Model construction/load | 85.11 |
| First actual inference | 3.21 |
| First clip read/hash + inference | 5.90 |
| All clips mean inference | 2.51 |
| All clips p50 inference | 2.29 |
| All clips p95 inference | 3.77 |

Inference timings exclude file loading/hashing and source resampling. Percentiles are nearest-rank. These observations are one pass on this host; do not use them as guarantees for Windows, Raspberry Pi or hardware capture.

## Positive-only score diagnostics

The following is the count of primary positive meow clips whose **maximum Meow-class window score** meets each illustrative threshold. It does not combine Cat/Meow scores or measure confidence calibration.

| Illustrative threshold | Positive clips meeting threshold | Rate on scored positives |
| --- | ---: | ---: |
| 0.1 | 345 / 440 | 78.41% |
| 0.3 | 270 / 440 | 61.36% |
| 0.5 | 216 / 440 | 49.09% |

No operating threshold was selected. Precision, specificity and false-positive rate cannot be estimated without suitable negative examples. Tiri accuracy remains untested. Upsampled 8-kHz data do not recreate the original missing high frequencies, and source clips/contexts need not match ordinary household audio.

## Metadata finding and next work

Five `I_BLE01_EU_FN_DEL01_40x.wav` files identify session 4 although the source description lists sessions 1–3. The manifest preserves and flags this discrepancy. Owner/environment overlap is not controlled by the cat-exclusive grouping.

Next add a reviewed negative/uncertain manifest, including household background and other-vocalization cases. Keep CatMeows extras unlabeled until reviewed; add Tiri recordings only when available. Compare candidate detection rules on calibration groups and freeze a rule before assessing evaluation groups. Do not convert dataset recording conditions into inferred intent labels.
