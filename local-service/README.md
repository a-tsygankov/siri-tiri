# Siri-Tiri local prototype service

A **dependency-free Python 3.11+** Windows 11 / Raspberry Pi foundation for durable event ingestion and inspection. It is intentionally not yet the YAMNet inference worker. No Cloudflare or ESP32 integration yet.

On Windows PowerShell:

```powershell
cd local-service
py -3 service.py
# second terminal:
py -3 -m unittest discover -s tests -v
```

Service binds **127.0.0.1:8765 only**. State defaults to `local-service/data/siri-tiri.sqlite3` (override with `SIRI_TIRI_DB`). SQLite WAL survives process restarts. Endpoints: `GET /health`, `GET /version`, `GET /events`, `GET /logs`, `POST /events`, `POST /logs`. POST event requires UUID `messageId`/`eventId`, `schemaVersion:1`, `sourceId`, `createdAt`, `type`. POST log accepts log.v1 envelope. Duplicate message IDs are accepted without creating duplicate events. Event listing supports `?limit=100` (max 500).

Example PowerShell:

```powershell
$event = @{schemaVersion=1;messageId=[guid]::NewGuid().ToString();eventId=[guid]::NewGuid().ToString();sourceId='phone-demo';createdAt=[DateTime]::UtcNow.ToString('o');type='review';payload=@{context='Unsure'}} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri http://127.0.0.1:8765/events -Method Post -ContentType 'application/json' -Body $event
Invoke-RestMethod http://127.0.0.1:8765/events
```

**Security boundary:** localhost-only, no authentication; do not expose this prototype to LAN or internet. Add authenticated LAN access, audio storage, Cloudflare sync and YAMNet next. Logs are not yet redacted automatically; clients must omit secrets.

## Durable processing jobs (0.2.0)

Each accepted `capture` creates exactly one pending job in the same SQLite transaction as its immutable message. Repeated delivery does not requeue a completed job. Reviews and other event types do not create jobs. Inference results are stored on the job and never replace owner observations. No inference runs automatically yet.

The service migrates SQLite to schema **2** on startup and backfills existing capture messages. Migration is transactional and repeatable, preserves events/logs, and rejects newer unsupported database versions. Backfilled captures may already have been processed outside this prototype: the ledger guarantees at-least-once work, not exactly-once external side effects.

New events reject malformed optional `correlationId` values (UUID required when present). Version 0.1 could accept these values: migration retains such legacy envelopes byte-for-byte, but uses null for their job correlation metadata. A claimed legacy envelope can therefore predate full contract compliance; consumers should use the validated job metadata for correlation.

Before adopting a new service version, stop the old service and back up its database. Do not copy an actively written SQLite file alone; use SQLite backup tooling or copy only after a clean shutdown. Do not run the old binary against schema 2. Rolling back code does not downgrade the database; keep the upgraded database or restore a pre-upgrade backup with an explicit decision about events accepted after that backup. No reset is needed.

### Worker API

All job POST bodies require `schemaVersion: 1` and a nonempty `workerId` (maximum 128 characters). The claim response includes the full original event, so old captures remain processable. Job IDs equal capture message IDs. Ownership operations also require the `leaseToken` issued by claim. Tokens fence workers on localhost; they are not network authentication. Never log them.

| Route | Additional request fields | Success |
| --- | --- | --- |
| `GET /v1/jobs?limit=100` | Limit 1..500 | `{schemaVersion:1, items:[...]}` without lease tokens or event payloads |
| `POST /v1/jobs/claim` | Optional `leaseSeconds` (default 60, integer 1..900) | `{schemaVersion:1, job:...}` with token and event; `job:null` when no work is available |
| `POST /v1/jobs/{id}/heartbeat` | `leaseToken`; optional `leaseSeconds` | Renewed job; a renewal never shortens a lease |
| `POST /v1/jobs/{id}/ack` | `leaseToken`, `result` | Completed job with durable result |
| `POST /v1/jobs/{id}/fail` | `leaseToken`, `errorCode` | Pending retry or terminal failed job |

Mutation responses use `{schemaVersion:1, job:...}` and HTTP 200. Unknown fields or invalid values return 400; unknown jobs/routes 404; stale, expired or conflicting ownership/results 409; empty or greater-than-65536-byte request bodies 413. JSON must be finite. Unknown job IDs must still be syntactically valid UUIDs. Nonempty string fields must contain a non-whitespace character. Existing event/log endpoints remain unversioned and keep their previous response shapes.

`result` is a JSON object requiring nonempty `modelVersion` and `preprocessingVersion` strings (maximum 128 characters each), with additional model evidence allowed. Its canonical JSON encoding (`sort_keys=True`, compact separators, ASCII escaping) must fit 32768 UTF-8 bytes. Model class scores are evidence, not interpreted intent or owner labels. Exact completed acknowledgment retries from the completing worker/token succeed even after lease expiry. Canonically different results or different owners return 409. Completion ownership is retained for retry checks but not exposed by inspection.

Each claim increments attempts and issues a new token. Expired leases can be reclaimed across worker/service restarts. All ownership checks treat `now >= expiry` as expired. Every claim sweeps exhausted expired leases into `failed`; inspection is read-only and can show an expired lease until a claim sweeps it. Clients can inspect the UTC expiry timestamp.

Explicit failures persist a retry time with exponential delay: `min(60000, 1000 * 2**(attempts-1) + random_integer(0,1000))` milliseconds. Five attempts is the limit; the fifth failure or an expired fifth lease is terminal. `errorCode` is 1..64 characters matching `[a-zA-Z0-9_.-]+`; supply stable categories, not private exception messages. There is no automatic terminal-job reset endpoint in this increment.

SQLite transactions finish before workers process audio. Renew leases during long processing and acknowledge only with the latest token. A worker crash before acknowledgment may cause duplicate processing; downstream external side effects must be idempotent. Host wall-clock adjustments can affect lease timing; ownership tokens prevent a reclaimed worker from committing results.

### PowerShell example (synthetic result only)

First POST a `capture` event to `/events`; a `review` does not enqueue work. Then:

```powershell
$base = 'http://127.0.0.1:8765'
$claim = @{schemaVersion=1;workerId='manual-test';leaseSeconds=60} | ConvertTo-Json
$job = (Invoke-RestMethod "$base/v1/jobs/claim" -Method Post -ContentType 'application/json' -Body $claim).job
if ($null -ne $job) {
    # Inspect $job.event; this example does not run YAMNet.
    $ack = @{schemaVersion=1;workerId='manual-test';leaseToken=$job.leaseToken;result=@{
        modelVersion='synthetic-test';preprocessingVersion='none';synthetic=$true
    }} | ConvertTo-Json -Depth 5
    Invoke-RestMethod "$base/v1/jobs/$($job.jobId)/ack" -Method Post -ContentType 'application/json' -Body $ack
}
```

Do not acknowledge real captures with synthetic results. Use a separate `SIRI_TIRI_DB` for experiments. Request/response schemas live in `contracts/jobs.v1.schema.json`; schema fragments and operational constraints are described in `contracts/README.md`.

### Verification

From the repository root: `py -3 -m unittest discover -s local-service/tests -v`. HTTP tests bind an ephemeral **127.0.0.1** port and use temporary databases, leaving any running service on port 8765 untouched. Tests include independent competing processes, abrupt worker exit, an abrupt process crash before enqueue commit, migration rollback, ownership fencing and result retry semantics. They require permission for loopback sockets and subprocesses when run inside a sandbox.
