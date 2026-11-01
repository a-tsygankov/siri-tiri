# CatMeows preprocessing and evaluation implementation plan

> **For agentic workers:** Use superpowers:executing-plans with test-driven development and final independent review.

**Goal:** Execute the handoff task the user authorized with “merged. Proceed”: preserve original CatMeows clips, create versioned 16-kHz derivatives, and run local batch scoring/latency reports.
**Architecture:** Offline preparation and batch tools, independent of the live API/database. Source archives and extracted originals are verified. Stage derived datasets/reports atomically; refuse to overwrite changed artifacts.
**Tech Stack:** Python stdlib, existing NumPy/LiteRT environment, pinned SciPy 1.15.3.
**Spec:** docs/CODEX_HANDOFF.md suggested next task; user authorization in this chat. Algorithm, reporting and grouping details below are implementer choices within that scope.

## Global constraints

- Keep 8-kHz originals byte-identical. All derived audio/manifests/reports stay under ignored CatMeows/.
- Source PCM16 mono 8000 Hz, 1..240000 frames. Polyphase 2:1 resampling, Kaiser beta 5, zero boundary padding; float64 calculation, round-to-nearest-even PCM16 quantization and saturation; record clipping count. Pin dependency versions and preprocessing version.
- Do not change the 16-kHz live worker contract, database, model, or service port.
- Preserve dataset context as recording metadata, separate from model sound scores and household observations. Exclude extras from labeled evaluation.
- Cat-exclusive split via SHA256(catId), 20% hash buckets evaluation; retain cat/owner/session IDs. No threshold selection, precision or household false-positive claims from positive-only data.

## Review focus

- Repeated preparation must verify source/derived integrity and preserve local changes.
- Manifest paths must stay inside the derived audio root; duplicate IDs, metadata inconsistencies and mixed versions must fail.
- Invalid clips must be visible in reports with explicit coverage/failure counts.
- Model loading/first inference and per-clip latency must be distinguishable; no memory metric that excludes native runtime.
- Full real-data run must preserve all 440 original checksums; synthetic tests cannot establish cat accuracy.

### Task 1: Preparation

Files: local-service/dataset_prepare.py, tests/test_dataset_prepare.py, inference requirements lock.

- [x] Write failing filename/grouping, original preservation, resampling fidelity/length, invalid format, repeatability and integrity tests. Numerical tests require optional SciPy; core tests remain stdlib-only.
- [x] Add pinned SciPy wheel; implement parse_metadata(filename), split_for_cat(cat_id), resample_pcm16(samples), prepare_files(paths, destination), and prepare_catmeows(root).
- [x] Verify archives/raw files against existing CatMeows pins, select only primary archive members, emit deterministic versioned manifest and derived WAVs atomically, and rerun tests.

### Task 2: Batch reporting

Files: local-service/dataset_evaluate.py, tests/test_dataset_evaluate.py, manage.py and scripts/evaluate-catmeows.ps1.

- [x] Write failing manifest/path/checksum validation, failure coverage, cat-exclusive grouping, metrics and atomic report tests with a controllable predictor.
- [x] Implement evaluate(manifest_path, report_root, predictor=None, limit=None) with per-clip JSON/CSV, provenance, latency percentiles, split/condition summaries, diagnostic Meow maximum-score thresholds 0.1/0.3/0.5 and null unavailable negative-class metrics.
- [x] Add prepare-catmeows/evaluate-catmeows CLI commands with checkout-relative defaults. --limit explicitly labels subset reports. Numerical/model imports remain optional until commands run.

### Task 3: Verify and deliver

- [x] Run all 440 clips with real pinned YAMNet; recheck source hashes and repeat preparation; provision verified derivatives/reports in normal checkout without changing originals/database.
- [x] Update README/handoff/project status and measured limitations. Run full suite/static checks and add synthetic resampling smoke to existing inference CI.
- [ ] Independent review, scoped commits, PR and Windows CI. Report unrun Linux/Pi/hardware/Tiri/background validation.

## Execution record

- Both worktree and normal checkout were prepared; repeated preparation and wrappers from a different CWD passed. All 483 original WAV SHA-256 values remained unchanged. No service/database changes.
- Full primary-checkout run: 440/440 scored, no failures; report run-20261101T074140Z-232ee0e2f3. Meow max-score positive detection counts at illustrative thresholds .1/.3/.5: 345/270/216. No threshold or negative-class metric selected.
- Single-pass CPU model load 85.11 ms, inference p50 2.29 ms/p95 3.77 ms; these are host observations, not guarantees or memory/hardware benchmarks.
- scripts/test.ps1 (from another CWD): 54 passed in pinned inference environment. Core `py -3 -m unittest discover -s local-service/tests -v`: 54 run, 4 optional numerical tests skipped, others passed. Model/resampling smoke, syntax, report/group integrity and diff checks passed.
- Review identified first-inference accounting after an invalid first clip. A regression reproduced it; invocation sequence now controls cold/after-first reporting, including failed predictor calls. Re-review found no remaining actionable issues.
- Ruling: preserve and flag five observed session-4 source names even though published metadata lists sessions 1..3. Do not renumber recordings. Hash buckets yield 14 calibration/7 evaluation cats; no exact 80/20 quota is promised.
- Ruling: keep live worker input/preprocessing unchanged and add offline derivatives. Upsampling cannot restore absent high-frequency information; evaluation is positive-only. Linux/Pi/hardware/native memory/Tiri/background accuracy remain unrun.
