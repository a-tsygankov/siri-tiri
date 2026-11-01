# Siri-Tiri Architecture: Offline Sync, Updates and Observability

**Status:** approved design baseline; not implemented. **Primary prototype host:** Windows 11. **Future local host:** Raspberry Pi. **Cloud:** Cloudflare Workers, D1, R2; optional Queues and Containers.

## System boundaries

- **ESP32-S3:** detect/capture candidate vocalizations, store event metadata and short audio locally, allow review, enqueue outgoing messages and log records. No inference or cloud availability assumed.
- **Phone PWA:** review, browse events, health/diagnostics, update status; persist edits and outbox in IndexedDB. iOS background synchronization is opportunistic; flush on app launch/resume.
- **Local service (Windows/Pi):** SQLite durable jobs/results, YAMNet inference, local API, log viewer, cloud pull/sync and update supervisor. Same protocol on both OSes.
- **Cloudflare Worker:** authenticated API, version manifest, sync cursors, claim/lease API, log ingestion and admin API. D1 indexes event metadata, revisions, jobs, leases and recent logs; R2 holds optional short audio clips, historical compressed logs and release artifacts.
- **Cloudflare Containers:** optional future CPU inference; benchmark model preprocessing/runtime/cost before adopting. Do not assume Workers AI hosts YAMNet.

## Message flow and delivery

1. Capture an event locally with stable UUIDv7/ULID `eventId` and immutable `messageId`, origin, timestamp, schema version and payload hash. Queue metadata and audio reference separately.
2. Prefer authenticated LAN sync to the local service when reachable; use authenticated Cloudflare API as fallback or remote relay. A successful HTTP response means accepted durably, not analyzed.
3. Cloudflare stores metadata in D1 and audio in R2, then creates a D1 job record. Optional Cloudflare Queues only accelerate processing; D1 is the authoritative durable backlog for offline laptops.
4. Local service polls for work, atomically claims with an expiring lease, downloads needed audio, performs YAMNet inference and posts a result with model/preprocessing version. Renew leases for long jobs.
5. Phone and device fetch changes using cursors and reconcile their local stores. User reviews can arrive before or after analysis and must never be overwritten by inference.

**Semantics:** at-least-once transport, idempotent processing keyed by message ID, bounded exponential retry/jitter, deduplication, tombstones, dead-letter/error state and explicit delivery/analysis status. Separate `capture`, `review`, `analysis`, `ack`, `log_batch`, `heartbeat` and `update_status` message types. Use server-side access control, per-device revocable credentials, short-lived upload URLs, TLS and retention policies. Keep audio opt-in for cloud upload; do not store raw audio or secrets in logs.

**Review schema:** owner-selected context/hypothesis, optional observed location, behavior and outcome. Preserve review revision history and source; conflict resolution should avoid silently overwriting later edits. Keep audio metadata independent of user annotations.

## Versioning and release contracts

Independent SemVer + Git SHA for PWA, ESP32 firmware, local service and Cloudflare Worker. Monotonically increasing migration IDs for D1 and SQLite, and separately versioned event/API protocols, model and preprocessing pipeline. A global release ID records tested compatible component versions but does not force simultaneous deployment.

Publish a signed or authenticated channel-specific manifest (`dev`, `beta`, `stable`) with component versions, min/max supported protocols, hardware board ID, firmware image SHA-256/signature/size, platform-specific service artifacts, migration requirements, rollout percentage and emergency pause. Never embed secrets in the manifest. Validate backward/forward compatibility; reject incompatible requests with actionable version metadata.

- **PWA:** version check at launch, foreground resume and while open. Service Worker stages assets; activate after persisting unsaved edits, then prompt to reload. Offline sessions remain usable. Never depend on iOS background execution.
- **ESP32:** check at boot and periodically; download signed image to inactive OTA slot; verify board identity/signature/checksum, reboot, self-test and mark valid, otherwise roll back. Preserve audio, queues, config and credentials in separate data partitions. Defer updates during recording.
- **Windows/Pi:** external updater/supervisor fetches verified architecture-specific artifact, drains jobs, snapshots SQLite, swaps version, restarts, checks health and rolls back executable if needed. Keep DB and logs outside install directory; schema rollback is not assumed.
- **Worker and schemas:** GitHub Actions CI deploys Worker, applies ordered D1 migrations with expand/migrate/contract sequencing, publishes manifest only after checks. Keep local SQLite migrations transactional where possible and forward-compatible.

## Centralized logs and diagnostics

Use a common JSON envelope: `timestamp` (UTC), `level`, `component`, `instanceId`, `version`, `eventName`, `message`, `correlationId`, optional `eventId`/`jobId`, retry state and sanitized structured attributes. Propagate correlation IDs across capture → upload → claim → inference → review. Never log audio content, tokens, passwords or full private payloads.

- ESP32: bounded persistent log ring with severity-based eviction, batching and dropped-count metrics; logs never evict unsynced user events.
- PWA: IndexedDB log buffer and error handlers, upload on foreground/reconnect; no assumption of background delivery.
- Local service: rotating local JSON logs + queryable recent index, batch forward to cloud, inspect offline.
- Cloudflare: ingest authenticated batches; D1 indexed recent errors/diagnostics; R2 compressed older archives. Apply retention, redaction, quotas and rate limits. Use native Worker logging for platform troubleshooting.
- Viewer surfaces: phone Diagnostics page (health, recent errors, updates, retry); authenticated Cloudflare-hosted admin dashboard (search/filter/export); local service web dashboard (live logs and queue inspection); round device only actionable health warnings.
- Filters: time, severity, source, instance, release, correlation/event/job ID; link errors to update and sync state. Never expose log APIs publicly without authorization.

## Suggested interfaces

`POST /v1/events`, `POST /v1/reviews`, `POST /v1/audio/upload-intent`, `GET /v1/sync?cursor=...`, `POST /v1/jobs/claim`, `POST /v1/jobs/{id}/heartbeat`, `POST /v1/jobs/{id}/result`, `GET /v1/releases/manifest`, `POST /v1/logs/batch`, `GET /v1/admin/logs`, `GET /v1/health`. These are proposals; finalize authentication, pagination, replay and error contracts before implementation.

## Delivery milestones

1. Contracts and migrations: versioned event/review/analysis/log schemas, compatibility matrix, D1 and SQLite schema, release manifest.
2. Windows local service: SQLite inbox/outbox, YAMNet pipeline, LAN API, structured logs and diagnostics.
3. Cloudflare relay: Worker, D1/R2, durable claims, authenticated sync and log ingestion, online dashboard.
4. PWA: IndexedDB outbox, retry/conflict handling, update checks, diagnostics and review sync.
5. ESP32: persistent outbox/audio, OTA with signature and rollback, sync and health indicators.
6. CI/release: independent component builds, staged rollouts, automated migrations, release manifests, rollback drills.
7. Optional Cloudflare Containers: CPU inference benchmarks and cost measurements.

## Acceptance tests

- Power-cycle ESP32 and restart phone/local service while offline; no accepted event or user review is lost.
- Laptop offline for longer than Queue retention: jobs remain claimable in D1.
- Duplicate/reordered delivery and concurrent review edits do not corrupt state.
- Interrupted audio upload, inference crash, expired lease and reconnect recover automatically.
- PWA update does not discard unsent drafts; Windows service rolls back after failed health check; ESP32 invalid OTA rolls back.
- Old and new supported protocol versions coexist during staged releases.
- Cross-component correlation ID traces a single event; logs redact secrets and obey retention.
- Cloud admin, phone and local diagnostics show consistent records with offline-state indicators.
