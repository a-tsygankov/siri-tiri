# Reviewed detector evaluation implementation plan

> **For agentic workers:** Use superpowers:executing-plans and test-driven development; final independent review required.

**Goal:** Implement the approved local review/catalog and frozen detector-rule workflow.
**Architecture:** Separate ignored SQLite review database, immutable JSON/CSV exports, versioned model features and calibration snapshots; no live-service changes.
**Tech Stack:** stdlib SQLite/JSON/CSV plus existing optional pinned YAMNet/SciPy environment.
**Spec:** ../specs/2026-11-01-reviewed-detector-evaluation-design.md (user approved).

## Constraints/review focus

Target audible_meow. Primary dataset-reference positives are not human reviews. All extras start unlabeled. Human latest revision overrides reference, uncertain excluded. Require reviewer, UTC time and expected revision; never log notes/audio. Immutable rules bind calibration-only evidence; no negative-class claims without both classes. Original audio/database remain unchanged. Reject mismatched source/model/target/provenance and cross-split content leakage.

### 1. Review storage

Files: review_store.py, tests/test_review_store.py.

- [x] Write failing tests for stable inventory, reference/effective labels, CAS conflicts, history/restart, repeat init, source integrity and unknown grouping.
- [x] Implement verified CatMeows inventory and ReviewStore.initialize(inventory), snapshot(), label(clip_id,label,reviewer,expected_revision,note=''); export immutable JSON/CSV snapshots.
- [x] Run store tests and preserve all 440 reference positives/43 unreviewed extras in real catalog.

### 2. Features and rules

Files: detector_features.py, detector_rules.py, review_artifacts.py, tests/test_detector_rules.py and tests/test_detector_features.py.

- [x] Write failing tests with hand-calculated confusion counts, uncertain exclusions, missing-class/feature gates, grouping/provenance rejection, calibration-only rules, freeze snapshot integrity and later reviews.
- [x] Score exact source hashes using existing resampling; store finite meow_max/cat_or_meow_max with model/class-map/preprocessing versions. Every clip has explicit success/failure.
- [x] Implement calibration grid, explicit freeze(score,threshold), and held-out evaluation. Frozen rule embeds calibration rows and hashes; later labels cannot change it. Reports include coverage/provenance and missing-class limitations.
- [x] Run synthetic end-to-end workflow tests; no synthetic reviews written into actual catalog.

### 3. CLI and delivery

Files: manage.py; scripts/review-catmeows.ps1; README/handoff/project docs.

- [x] Add review-init/export/label/score and detector-calibrate/freeze/evaluate commands; defaults checkout-relative under CatMeows/reviews/.
- [x] Initialize/export/score all 483 real clips, verify insufficient-negative gate, and recheck all original hashes. Provision normal checkout too.
- [ ] Run core and full inference suites, static checks and final review. Update PR #10 from design to implementation, mark ready and inspect CI. Report no reviewed-negative/Tiri accuracy and unrun Linux/Pi/hardware work.

## Execution record

- Full pinned Windows suite: 75 passed. Core `py -3 -m unittest discover -s local-service/tests -v`: 75 run, 4 optional numerical tests skipped, remainder passed. Model/resampling smoke and Python/model-manifest syntax checks passed.
- Initial core run hit WinError 10053 in the existing oversized-body HTTP test. Its full upload raced the server's header-based rejection/close. The test now declares oversized Content-Length without uploading the body, preserving early-limit validation; API implementation unchanged. Both suites then passed.
- Independent review found no blocking defects; a minor explicit argv respawn inconsistency was fixed with a failing/passing regression. Final review confirmed source-hash labeling guard, argument forwarding and atomic JSON/CSV bundle publication.
- Synthetic actual CLI label/export/calibrate/freeze/evaluate passed with hand-calculated TP/TN/FP/FN=1/1/1/1, marked synthetic and isolated in temporary files.
- Real worktree and normal-checkout catalog: 483 clips, 440 dataset references, 43 unreviewed, zero human reviews. All 483 scored; all 440 primary maxima exactly agree with earlier derivative-based scoring. All 483 original WAV hashes remained unchanged. Real calibration/freezing correctly blocked without negatives; no real rule or live policy was created.
- Primary queue: CatMeows/reviews/exports/catalog-b76fb65a4a42459581adda4238d06058/catalog.csv. Real feature cache: reviews/features/features-62169ef2e639418996b2f5d76829d700.json. Insufficient-negative report: reviews/reports/detector-calibrate-88a5e200d5bc48688b011395280382d0.json.
- Ruling: retain both SIM01/SIM10 owner codes observed for BAC01, flag owner variation, and keep all sessions grouped by the authors' stable cat ID. No owner correction, label inference or split reassignment.
- Linux/Pi/hardware, Tiri/household accuracy and actual reviewed-negative threshold/evaluation remain unrun. Those require human review/new data, not invented labels.
