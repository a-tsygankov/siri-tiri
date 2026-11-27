# Phone Bundle Import Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task, with tests first and one final independent review.

**Goal:** Preserve PWA exports offline and analyze native-rate recordings.
**Architecture:** Immutable snapshot directories, strict bounded validation, versioned numerical conversion, separate analysis reports. No live database access.
**Tech stack:** Python 3.11+ stdlib, optional pinned NumPy 2.2.6/SciPy 1.15.3 and existing LiteRT model.
**Spec:** ../specs/2026-11-26-phone-bundle-import-design.md (approved by user).

## Global constraints

JSON <=16 MiB; WAV <=3 MiB; <=10,000 entries per metadata array; supplied audio <=600 MiB. Mono PCM16 at 16,000/44,100/48,000 Hz, <=30 seconds. Keep CatMeows and live-worker behavior unchanged. No source modifications, invented labels or automatic merges.

## Review focus

- Partial shares and records-only revisions must remain durable and retryable.
- Capture forks, missing predecessors and tombstones cannot silently choose analysis input.
- Reimports must detect edited archived files, including derivative/manifest edits.
- Trim sample rounding must match JavaScript Math.round for positive cut points.
- Unsafe Windows names and symlinks cannot escape source/archive boundaries.

## Task 1: Phone audio pipeline

Files: `local-service/phone_audio.py`, `local-service/tests/test_phone_audio.py`.
Interface: `read_pcm(data: bytes) -> (rate, array('h'))`; `convert(samples, rate) -> (array('h'), provenance)`; `prepare(data) -> (derived_wav_bytes, provenance)`.
- [x] Write failing length/silence/tone/alias/format/truncation tests; run targeted unittest and observe failure.
- [x] Implement bounded PCM parsing and versioned rational polyphase resampling; 16-kHz identity avoids optional dependencies.
- [x] Run new and existing Python suites with the installed inference Python and core Python; commit audio task.

## Task 2: Archive validation and publication

Files: `local-service/phone_bundle.py`, `local-service/bundle_validation.py`, `local-service/tests/test_phone_bundle.py`.
Interfaces: `validate_bundle(doc) -> normalized metadata plus event coverage`; `import_bundle(bundle_path, audio_dir, archive_root) -> manifest_path`.
- [x] Write failing tests using valid PWA-shaped fixtures: complete/repeat, partial/retry, records-only, deletion/reviews, unsafe names/links, ID conflicts, version/type bounds, trim/restore/forks/missing ancestors.
- [x] Implement stdlib schema subset for existing event/review contracts, strict payload/manifests and chain validation, preserving exact original JSON. Reject altered identity; retain unresolved history/forks as incomplete coverage.
- [x] Stage verified audio and derivatives, then manifest and atomic directory rename. Complete snapshots use bundle hash, incomplete attempts hash+UUID. Verify deterministic expected contents on repeated complete imports. Test edits and failed publication.
- [x] Run full Python suites; commit archive task.

## Task 3: CLI, analysis and documentation

Files: `local-service/phone_analysis.py`, `local-service/manage.py`, `local-service/tests/test_phone_analysis.py`, `scripts/import-phone-bundle.ps1`, `.gitignore`, root/service/PWA READMEs, handoff/project plan.
Interface: `analyze_import(manifest_path, predictor=None) -> report_path`; `analyze_phone(path, predictor=None) -> scores with source provenance`.
- [x] Write failing CLI exit/reexec tests and analysis coverage/tampering tests; run to observe failure.
- [x] Add import-bundle, analyze-import and native-rate analyze support while preserving 16-kHz stereo behavior. Bind artifacts/model/preprocessing hashes and emit immutable per-event reports with explicit exclusions and failures.
- [x] Generate synthetic bundle with real PWA buildBundle/encodeWav/buildTrim, import and run pinned YAMNet. Run full Python/PWA suites, diff checks; update docs with exact executed results and pending phone validation.
- [x] Final independent code review, fix important findings with regression tests, commit/push, update PR #17 and monitor CI. Do not merge. CI outcomes are recorded on the PR.

## Execution record

Baseline on updated main: 75 inference Python tests, 78 PWA Node tests, 41 Worker tests and typecheck passed (Worker used existing cloud-sync worktree). Implementation proceeds inline under the user's explicit approval; no additional plan approval needed.

- Task 1 complete: tests first failed for the missing module, then five audio tests passed. Full suite: 80 tests OK in pinned runtime; core 80 OK with six optional skips. Commit 1ea9adf.
- Task 2 complete: failing archive tests preceded implementation. Full suite: 95 tests OK with one Windows symlink privilege skip; core 95 OK with seven skips. Commit 719e8ed. Partial receipts also received a failing verification regression before correction.
- Task 3 implemented: CLI, immutable reports, direct native-rate analysis, stereo preservation, synthetic shipping-PWA fixture and documentation. Real pinned setup/smoke and two-current-clip YAMNet analysis succeeded. No physical-phone recordings used.
- Ruling: incomplete snapshot names retain only 16 hash characters plus full UUID; full hash remains inside. Reproduced Windows path >259 characters falsely appeared missing after rename. Shorter names and prepublication path checks prevent unreadable artifacts; unusually long destinations require a shorter archive root.
- Final review: one important finding, expanded generated manifests exceeded the source JSON cap. A 10,000-clip regression reproduced it. Separate 64-MiB manifest bounds now apply before publication and on verification, while input remains capped at 16 MiB. No deferred findings.
- Final local verification: `.venv/Scripts/python.exe -B -m unittest discover -s local-service/tests -q` ran 104 tests, OK with one Windows symlink privilege skip (88.637 s). `py -3 -B -m unittest discover -s local-service/tests -q` ran 104 tests, OK with nine skips (eight optional numerical/interoperability checks and the symlink test; 86.524 s). `node --test docs/app/tests/*.test.mjs` passed all 78 tests. Pinned setup/smoke, pip check, 17 Python modules parsed and git diff checks passed. The wrapper and automatic interpreter switching also completed real-model synthetic import/analysis. Live DB, CatMeows originals and user `.claude/` contents were not changed.
