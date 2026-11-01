# Reviewed labels and frozen detector evaluation

Status: proposed for approval after the user authorized merging PR #9 and working on the next handoff task. PR #9 was merged as 94d91281b1b1604cbb89ed1afa756273271b1440.

## Goal and boundaries

Provide a local review workflow and reproducible calibration/evaluation of clip-level sound-detector rules. Preserve original audio, existing source/derived manifests, owner observations and the live service/database. No Tiri recordings or reviewed household negatives exist yet; building tools must not manufacture those labels or claim performance on them.

User-confirmed initial target: **an audible meow anywhere in the clip**. A positive contains that target, a negative contains none, and uncertain means the reviewer cannot decide. The target is explicit and immutable within a review catalog. Supporting a separate `cat_vocalization` catalog is possible later; labels must not silently change meaning.

## Approach

Use a separate SQLite review store under ignored `CatMeows/reviews/`, with JSON/CSV snapshot exports for inspection. Existing stdlib SQLite provides transactional revisions and restart durability without new services or dependencies. Plain editable JSON/CSV as the authoritative store would need additional concurrency/locking and history machinery; exports stay snapshots rather than being accepted as evidence of a human review automatically.

## Inventory and provenance

- Initialize a catalog from the two pinned, verified CatMeows archives and unchanged originals: 440 primary and 43 supplementary WAVs. Stable IDs bind a source namespace/path and SHA-256, with duplicate-content checks preventing cross-split leakage.
- Primary clips can carry the authors' `positive` reference label with provenance `dataset_reference`. This is explicitly not a human review. Supplementary clips start `unreviewed` with no label; folder names and YAMNet predictions cannot assign negative ground truth.
- Retain cat/owner/session IDs, recording condition, source checksum and the existing cat-exclusive split policy. Sequence filenames use their source session prefix; preserve metadata anomalies rather than renumbering them.
- Human reviews record positive/negative/uncertain, reviewer alias, timestamp, optional bounded note and revision. Each update requires the expected prior revision. Conflicting writers fail without overwriting; immutable history survives restart. A human review can explicitly override a dataset reference label.
- Revision 0 means no human review. Primary dataset-reference positives qualify as eligible positives, but the latest human review always supersedes the reference: uncertain excludes, negative replaces it, and positive confirms it. Negatives require explicit human review. Exports show reference and effective labels separately; reports count their provenance separately. Notes are bounded to 512 characters and timestamps are UTC.
- Review notes, audio, SQLite, snapshots, feature scores and rule reports remain ignored and local. Operational logs contain only stable IDs/status/error codes, not notes or raw audio.
- Supplementary clips reuse their known cat/session metadata and the same cat split as primary clips. Unknown/ambiguous grouping must be resolved before calibration/evaluation eligibility; never assign independent per-clip splits.

## CLI workflow

Proposed manage.py commands, usable from another working directory:

1. `review-init`: verify/import the catalog without changing existing reviews; return inventory/status counts.
2. `review-export`: JSON/CSV queue including relative local audio paths, reference-label provenance, current review/revision and group IDs. No automatic playback or server/UI in this increment.
3. `review-label --clip-id ... --label ... --reviewer ... --expected-revision ...`: transactionally record the user's review. Never treat the annotation command itself as proof of listening or authenticated identity.
4. `review-score`: run the pinned model on catalog clips using the established 8-to-16-kHz preprocessing in memory. Store features with exact source/model/preprocessing hashes; explicit per-clip failures. Originals and prior baseline artifacts remain unchanged.
5. `detector-calibrate`: consume eligible calibration labels/features only and export a grid of candidate thresholds. Initial score candidates: Meow maximum, and maximum of Cat/Meow maximum scores. Thresholds and feature definitions are explicit/versioned; do not select a household operating policy automatically.
6. `detector-freeze --score ... --threshold ...`: require reviewed negative and eligible positive calibration examples, then write a new immutable rule artifact with target, score definition, threshold, model/preprocessing versions, calibration-data fingerprint and timestamp. Freeze is an explicit user choice following calibration inspection, not a production deployment.
7. `detector-evaluate --rule ...`: assess only held-out evaluation examples after validating the frozen rule. Report confusion counts and defined precision/recall/FPR with denominators, uncertain/unreviewed exclusions, failures, groups and limitations. If either evaluation class is missing, produce coverage/insufficient-data status rather than a headline accuracy claim.

Existing positive-only reports remain available and are not relabeled as reviewed detector evaluation. Additional local household audio import, an annotation web UI, training/personalization and live detector activation are future increments.

## Calibration/evaluation separation

Calibration code must not optimize against evaluation labels or scores. Freeze retains an immutable calibration snapshot: IDs, effective labels/provenance/revisions and audio/feature hashes, with an integrity fingerprint. Later reviews cannot rewrite that evidence; a new calibration creates a new rule. Evaluation uses the original frozen evidence after artifact validation, never silently rebinds it to newer calibration labels, and records the evaluation-label snapshot/revisions separately. The tool must reject target/version mismatches, score/audio mismatches, duplicate identities and content leaking across splits. Owners/environments can still overlap across cats and must remain a reported limitation.

Features and thresholds must be finite and in [0,1]; detection means score >= threshold. Combined score means max(Cat maximum, Meow maximum). Bind class-map hash, aggregation version, model hash, resampling version and inference preprocessing version. Only complete, compatible calibration feature sets can be frozen. Failed eligible clips remain explicit failures and are never counted as negatives.

The earlier baseline already exposed descriptive scores and threshold diagnostics for both groups. This new evaluation is held out from the new calibration code, not a claim that humans have never inspected those data. Record that prior exposure as a limitation; truly independent future validation needs new recordings.

The current inventory has no reviewed negatives. Initial real-data verification should therefore demonstrate catalog creation, exports, scoring and the insufficient-negative gate; it must not produce a deployable threshold or invented negative-class metrics. Synthetic labeled fixtures test the full calibration/freeze/evaluation path separately and must be identified as synthetic.

## Verification and delivery

Test catalog repeatability, source integrity, revision conflict/rollback/history/restart, human-versus-reference provenance, uncertain exclusions, filename/session parsing, target consistency, score/hash/version checks, calibration-only selection, immutable rule artifacts, group/content leakage rejection and hand-calculated confusion metrics. Core tests remain dependency-free; real scoring uses the existing pinned inference environment.

Verify the 483-clip real catalog and unlabeled supplementary count, export files locally, run synthetic end-to-end rule tests, and recheck original hashes. Update handoff/project/README documentation and open a feature-branch PR targeting main. Do not merge the next PR without authorization. Linux/Pi/hardware and Tiri/household accuracy not exercised must be reported.
