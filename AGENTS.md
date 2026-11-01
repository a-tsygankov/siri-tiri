# Siri-Tiri — Codex development instructions

This file is intentionally named **AGENTS.md** (the standard Codex project-instructions filename), not `agent.md`. Apply these rules throughout the repository.

## Mission and architecture

Siri-Tiri is an offline-first cat-vocalization event assistant for Tiri, not a literal translator. Target a 466×466 circular Waveshare ESP32-S3 AMOLED touchscreen, a mobile-first phone PWA (including iOS Safari), a Windows 11 prototype local service, later Raspberry Pi, and Cloudflare Workers/D1/R2. YAMNet is the initial sound-analysis model; do not claim that YAMNet interprets intent. User-provided observations must remain distinct from model inference.

Read these before changes:
- `README.md`
- `docs/ARCHITECTURE_SYNC_UPDATES_LOGGING.md`
- `docs/PROJECT_PLAN.md`
- `docs/UI_HANDOFF.md`
- `docs/ROUND_UI_SAFE_AREA.md` for device UI changes
- `contracts/` for event/log envelopes

## Mandatory Git workflow

- **Never commit or push directly to `main`.**
- Start from updated `main` and create a descriptively named feature branch (or isolated worktree).
- Make scoped commits on the feature branch; open a PR targeting `main` for **every** code, documentation, infrastructure or mockup change.
- Include motivation, file summary, tests actually executed, limitations and rollback concerns in the PR description.
- Do not merge without confirming checks and reviewing the diff. Do not bypass branch protection. Request user approval before destructive operations, database resets, flashing devices, production deploys or merging when approval is not already explicit.
- Avoid rewriting shared history, force-pushing or modifying unrelated user changes.

## Environment and verification

- Primary development host: **Windows 11**. Prefer PowerShell-compatible commands and cross-platform implementations for future Raspberry Pi/Linux.
- Install missing project-local dependencies when permitted; pin versions and checksums for downloaded models and firmware artifacts. Ask before system-wide installs, driver changes, privileged commands or firmware flashing.
- Existing prototype: `py -3 local-service/service.py`; tests: `py -3 -m unittest discover -s local-service/tests -v`.
- Run relevant tests and static checks after changes. Add regression tests for bugs. Report exact commands/results; never state a test passed if it was not run.
- CI: `.github/workflows/local-service-ci.yml` runs Python tests on Windows. CI status is not a substitute for hardware verification.
- Keep secrets out of Git, logs and test fixtures. Never expose the localhost-only prototype to LAN/internet without authentication.

## Reliability and data contracts

- Every captured event, user review and log batch should survive relevant app/device restarts. PWA uses IndexedDB; local service SQLite; ESP32 persistent storage. No reliance on iOS background sync.
- Cloudflare D1 is authoritative for durable cloud job state; R2 stores optional short audio and archived logs. Queues can accelerate processing but must not be the sole backlog for long-offline local workers.
- Use at-least-once delivery, immutable message IDs, idempotency, retry/backoff, claim leases, correlation IDs and conflict-safe review revisions.
- Maintain independent component SemVer/build SHAs, migration versions, protocol versions and model/preprocessing versions. Do not break supported clients silently.
- PWA update must preserve unsent drafts; ESP32 signed dual-partition OTA must preserve event queues and support rollback; Windows/Pi updater must be supervised and health-checked.
- Structured logs must omit raw audio, tokens and private payloads; bound local queues and retention. Diagnostics on phone, cloud-hosted admin and local service.

## UI/UX

- Preserve conservative safe-area geometry on round display; validate clipped controls, scroll, touch targets and reduced motion.
- Review UI separates hypothesized context from optional observed location, behavior and outcome; Unsure and quick-save paths must remain available.
- Show distinct states for saved locally, queued, synced and analyzed; never imply a demo's local flag is cloud acknowledgment.
- Prioritize phone-first PWA and accessible labels/contrast/keyboard behavior.

## Work handoff

At task completion provide: branch/PR URL, changes, executed test results, any skipped tests, unresolved risks and the next concrete step. Keep `docs/PROJECT_PLAN.md` aligned with implemented status, not aspirations.
