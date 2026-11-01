# Local YAMNet Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Execute in session, test first, with final independent review.

**Goal:** Provision the official pinned model and run the local API plus a durable inference worker.
**Architecture:** Optional inference dependencies in the checkout venv; stdlib control tooling; confined local WAV inputs; worker uses the existing leased HTTP API.
**Tech Stack:** Python, PowerShell, LiteRT CPU, NumPy, SQLite.
**Spec:** ../specs/2026-11-01-local-yamnet-tooling-design.md (approved).

## Global constraints

- No system installs, secrets, network exposure, real audio uploads or modification of the user's stopped database.
- PCM16 mono/stereo 16000 Hz only; maximum 30 seconds; model windows 15600/hop 7680; versioned preprocessing.
- Model and runtime downloads pinned and verified. Initial tested inference environment is Windows x64 Python 3.13; core service stays Python 3.11+.

## Review focus

- Corrupt/partial downloads must not replace a verified model.
- File paths must remain under the configured audio root after resolution.
- Lease loss must prevent completion; lost ack responses must reuse the same result/token.
- Run must clean up only its own API/worker children, including on startup failure.
- CWD, spaces in paths and repeat setup must not change data locations or break commands.

### Task 1: Provisioning and inference

Files: model-manifest.json, requirements-inference-win-py313.lock, model_assets.py, inference.py, tests/test_inference.py.

- [x] Record downloaded official artifact size/SHA and runtime lock; write failing checksum, WAV, paths and window tests.
- [x] Implement bounded atomic model download and verification, PCM preprocessing and CPU scoring.
- [x] Run unit tests and real-model silence/tone smoke; document checkpoint findings and provenance.

### Task 2: Worker and operations

Files: worker.py, manage.py, scripts/{setup,run,test,status}.ps1, tests/test_worker.py, tests/test_manage.py.

- [x] Write failing worker HTTP retry/ownership and orchestration tests.
- [x] Implement loopback-only client, renewable leases, retained ack retries, stable failures and scoped shutdown.
- [x] Implement root-relative setup/run/API/worker/test/status/analyze commands, local-only configuration and script wrappers.
- [x] Test repeated setup, alternate working directory, isolated end-to-end inference and child cleanup.

### Task 3: Review and delivery

- [x] Update docs/version/status and model/checkpoint research. Run full suite/static checks and obtain independent review.
- [ ] Push feature branch, open PR, inspect Windows CI; report model smoke and unrun Linux/hardware verification.

## Execution notes

Official TFLite v1 downloaded: 4126810 bytes, SHA256 4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf. Embedded labels: Cat 76, Purr 77, Meow 78, Hiss 79, Caterwaul 80.

`py -3 -m unittest discover -s local-service/tests -v`: 37 passed on Windows Python 3.13.1 without global inference packages. Real-model silence/tone smoke passed in the pinned venv. Repeated setup from another CWD and fresh setup in a path with spaces passed. Supervised API/worker completed a synthetic WAV capture; Ctrl+C closed the socket and left no API/worker Python child. Syntax, manifest parsing and diff checks passed. Linux, Raspberry Pi, hardware and real-cat accuracy tests not run.

Independent review found a clean-checkout test assumption about venv existence. Added an explicit missing-venv regression, observed failure, then moved the busy-port check ahead of environment requirements. Re-review found no remaining actionable findings.

Ruling: use the LiteRT backward-compatible Interpreter interface verified on this pinned Windows wheel; no GPU DLL/driver changes. Runtime lock is Windows x64 Python 3.13 only, while API/tests retain Python 3.11+.

Local provisioning also copied verified model bytes and installed the lock in the user's C:/Workspaces/siri-tiri venv. Added local Git exclusions for runtime artifacts; main source and the stopped database were unchanged. Source changes ship through the PR.
