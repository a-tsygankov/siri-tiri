# Audible-meow review and detector rules

This offline research workflow labels **whether an audible meow occurs anywhere in a clip**. Positive means at least one audible meow; negative means no audible meow; uncertain leaves the decision open. Other cat sounds or mixed sequences require listening and judgment. Dataset recording conditions remain metadata, not inferred intent.

The separate `CatMeows/reviews/annotations.sqlite3` store does not update the service database, owner-context reviews, the live worker, or its detection policy. All audio, review data, notes, exports, features and rule reports remain local under ignored `CatMeows/`.

## 1. Initialize and export the review queue

After dataset/model setup:

```powershell
py -3 local-service/manage.py review-init
py -3 local-service/manage.py review-export
# Equivalent PowerShell wrapper, callable by absolute path from another CWD:
.\scripts\review-catmeows.ps1 review-export
```

Every command accepts `--dataset-root 'C:\Workspaces\siri-tiri\CatMeows'`; defaults resolve from the scripts' checkout. `review-init` verifies the pinned archives and originals before importing. Repeating it preserves existing human reviews and refuses changed inventories.

The initial catalog has 483 clips: 440 primary `positive` labels from the authors (`dataset_reference`, revision 0) and 43 supplementary clips with no label (`unreviewed`, revision 0). Dataset references are **not human reviews**. No supplementary file is labeled negative from its folder name or model prediction. The queue contains no model scores.

Each export gets a new `reviews/exports/catalog-<id>/catalog.json` plus `catalog.csv` bundle. JSON includes full review history; CSV includes source path/hash, current effective label/provenance, cat/session/split and revision. Paths are relative to the dataset root. Spreadsheet-active text cells are escaped in CSV; raw values/history are preserved in JSON. Editing an export does not update the authoritative store.

## 2. Listen, then record your label

Open the referenced original audio locally. After deciding a label, use the ID and current revision from the export:

```powershell
py -3 local-service/manage.py review-label --clip-id CLIP_ID_FROM_EXPORT --label uncertain --reviewer YOUR_ALIAS --expected-revision 0
# Choose positive/negative/uncertain based on listening; optional --note is local, max 512 characters.
```

Successful commands print only clip ID, new revision and saved status. Reviewer aliases are nonempty strings up to 128 characters. Updates check the original audio hash, serialize in a SQLite transaction and require the expected revision. A conflict leaves the earlier update intact; export again before deciding whether to submit a new revision. Source changes must be resolved before labeling.

The latest human review supersedes the dataset reference. Human uncertain excludes the clip from metrics; human negative replaces a positive reference without deleting it. Immutable history retains reviewer, UTC timestamp, label, revision and note. A reviewer alias is a local assertion, not authenticated identity or proof of listening.

Prioritize **unreviewed calibration** clips first (23 in the initial inventory). Keep evaluation reviews independent of rule choice; there are 20 unreviewed supplementary evaluation clips. Do not force uncertain clips into a class just to satisfy coverage requirements.

Cat grouping uses the existing deterministic cat split and retains source session IDs, including flagged anomalies. One `BAC01` primary file uses owner ID SIM10 while 24 use SIM01; both are preserved and the cat stays together. Unknown/ambiguous cat/session assignments are excluded until resolved; this increment does not add a grouping-repair or new-recording-import command. Original group metadata is never silently corrected.

## 3. Score source clips without assigning labels

```powershell
py -3 local-service/manage.py review-score
```

This uses the pinned inference environment, verifies source hashes, resamples in memory using the existing versioned PCM16 pipeline, and writes a new `reviews/features/features-<id>.json`. Both real and synthetic runs are explicitly marked. Missing/corrupt/unsupported clips have explicit failed status; a failure is not a negative label. Scoring never creates a human review.

Features are `meow_max` (maximum Meow window score) and `cat_or_meow_max` (maximum of Cat and Meow maxima). Every artifact binds source audio, inventory identity, model/version/SHA, normalized class-map SHA, resampling version, inference preprocessing version and aggregation version. Feature caches remain usable after label changes because labels are separate; model/source/provenance mismatches are rejected. There is no automatic latest-cache selection: supply the printed path explicitly in subsequent commands.

## 4. Inspect calibration, then explicitly freeze a rule

```powershell
py -3 local-service/manage.py detector-calibrate --features 'PATH_PRINTED_BY_REVIEW_SCORE'
# Only after inspecting sufficient calibration data and choosing the rule:
py -3 local-service/manage.py detector-freeze --features 'PATH_PRINTED_BY_REVIEW_SCORE' --score meow_max --threshold 0.5
```

The freeze threshold shown above is an example, **not a recommended operating value**. Supported scores are `meow_max` and `cat_or_meow_max`. Thresholds must be finite in [0,1]; detection uses score >= threshold. Calibration exports the .1/.2/.../.9 grid for each feature using calibration labels/features only, without selecting a rule automatically.

Calibration needs eligible positives and explicitly human-reviewed negatives with complete compatible features. Unreviewed, uncertain and unresolved examples are excluded and counted separately. Dataset-reference positive and human-positive counts remain distinct. Missing features or class coverage produce an `insufficient_calibration_data` report and exit code 2; freeze refuses to create a rule. Currently no human negatives exist, so this gate is expected.

A successful explicit freeze creates a new `reviews/rules/rule-<id>.json` with the selected feature/threshold, model/provenance, calibration metrics and an immutable calibration snapshot: IDs, source hashes, labels/provenance/revisions/reviewers/timestamps and feature fingerprints. Later reviews cannot rewrite that evidence. A new calibration/freeze creates a new artifact. Rule fingerprints detect accidental changes; these local artifacts are not publisher signatures or authentication.

## 5. Evaluate the frozen rule on held-out examples

```powershell
py -3 local-service/manage.py detector-evaluate --features 'PATH_PRINTED_BY_REVIEW_SCORE' --rule 'PATH_PRINTED_BY_DETECTOR_FREEZE'
```

The command verifies the frozen snapshot against the retained historical review revisions, then uses evaluation-partition labels/features only. Updated calibration labels do not replace the frozen evidence. It rejects inventory, target, source, model, class-map, preprocessing or aggregation mismatches and cat/content leakage across groups.

Both evaluation classes and all eligible features are required for metrics. Otherwise, status is `insufficient_evaluation_data`, metrics are null, coverage/failures are exported, and exit code is 2. Complete reports contain TP/TN/FP/FN, denominators, precision/recall/FPR/accuracy/F1 where defined, effective-label provenance counts and exclusions. Precision stays null when no positives are predicted. All reports get new files under `reviews/reports/`.

The earlier CatMeows baseline already exposed descriptive scores/threshold diagnostics from both groups. This evaluation is held out from the new calibration code, not a never-inspected dataset. Owner/environment overlap across cats remains possible, and no Tiri or household-generalization claim follows. Truly independent validation needs new reviewed recordings.

## Verified initial state

The real catalog/scorer were exercised in both the worktree and normal checkout: 483 clips, 440 dataset references, 43 unreviewed extras, zero human reviews, all 483 successfully scored. Calibration reports 277 reference-positive calibration clips and 23 excluded unreviewed clips, with `negative_calibration_examples_required`. No real rule was frozen or detector activated. All 483 original WAV hashes stayed unchanged.

Synthetic fixtures separately verify revisions/conflicts/restart, human override/history, source-change rejection, missing-class/failed-feature gates, finite threshold boundaries, immutable freeze evidence, calibration/evaluation separation and hand-calculated confusion counts. Their reports/rules are marked synthetic and are not CatMeows performance measurements. Linux/Pi/hardware and Tiri/household accuracy remain unverified.

Reverting code does not remove the ignored review database or snapshots. Preserve those files; no service-schema migration or data reset is needed.
