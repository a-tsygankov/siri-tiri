# Siri-Tiri local prototype service

A **dependency-free Python 3.11+ API** for durable event ingestion and inspection, with an optional **Windows x64 Python 3.13 YAMNet worker**. No Cloudflare or ESP32 integration yet.

## Setup and run the local stack (0.3.0)

From the repository root on Windows 11:

```powershell
.\scripts\setup.ps1       # local venv, hash-locked packages, verified model, real-model smoke
.\scripts\test.ps1        # unit + isolated HTTP/process tests
.\scripts\run.ps1         # API + inference worker; Ctrl+C stops both
# second terminal:
.\scripts\status.ps1      # API health/version/instance; does not claim jobs
```

The equivalent Python commands work without activating a venv or changing PowerShell execution policy:

```powershell
py -3.13 local-service/manage.py setup
py -3 local-service/manage.py tests
py -3 local-service/manage.py run
py -3 local-service/manage.py status
```

Scripts resolve default paths from their checkout, so they can also be invoked by absolute path from another directory. Setup is repeatable, does not initialize or migrate SQLite, and installs nothing system-wide. Its hash-locked inference environment currently targets Windows x64 CPython 3.13; it fails explicitly on other platforms/interpreters. The API and dependency-free tests retain Python 3.11+ compatibility. Raspberry Pi/Linux inference needs a separately tested package lock.

Default locations are `.venv/`, `local-service/models/yamnet-1/yamnet.tflite`, `local-service/audio/`, and `local-service/data/siri-tiri.sqlite3`. They are ignored by Git. `SIRI_TIRI_DB` still works when running `service.py` directly; for managed commands, use explicit `--db` (the manager deliberately selects its checkout-local default). `--audio-root` and `--db` accept paths with spaces. Custom relative paths are resolved from the caller's directory.

```powershell
# Isolated database/audio and a different localhost port:
py -3 local-service/manage.py run --port 8766 --db 'C:\Temp\tiri-test.sqlite3' --audio-root 'C:\Temp\test clips'
# Separate foreground components:
py -3 local-service/manage.py api
py -3 local-service/manage.py worker
py -3 local-service/manage.py worker --once
# Classify a WAV without adding an event or touching the database:
py -3 local-service/manage.py analyze 'C:\Temp\test clips\clip.wav'
py -3 local-service/manage.py smoke
```

The combined runner checks port availability before database initialization, verifies the model/runtime before starting the API, identifies its own API instance, monitors both children, and stops only those children on Ctrl+C, startup failure or child failure. It never terminates another service occupying the port. It is a development supervisor, not a Windows service or automatic updater. Child termination may interrupt work; leases provide recovery on the next run.

### Supplying audio

Put a WAV inside the configured audio root, then POST a capture referencing its **relative** path:

```powershell
$capture = @{schemaVersion=1;messageId=[guid]::NewGuid().ToString();eventId=[guid]::NewGuid().ToString();sourceId='manual-wav';createdAt=[DateTime]::UtcNow.ToString('o');type='capture';payload=@{audioRef='clip.wav'}} | ConvertTo-Json -Depth 5
Invoke-RestMethod http://127.0.0.1:8765/events -Method Post -ContentType 'application/json' -Body $capture
Invoke-RestMethod http://127.0.0.1:8765/v1/jobs
```

Input support is deliberately explicit: uncompressed PCM16 WAV, mono/stereo, **16000 Hz**, 1 sample through **30 seconds**. Stereo is averaged and signed samples are divided by 32768. Other sample rates, encodings, excessive duration, missing/truncated files and unsupported references fail with stable error codes through the existing bounded retries. Absolute paths, URLs, traversal and resolved symlink escapes are rejected. On Windows, use `/` for relative subdirectories in `audioRef`. Audio is never uploaded or printed.

YAMNet runs 15600-sample windows with 7680-sample hops, zero-padding only the final necessary window. Results contain mean/max Cat, Meow, Purr, Hiss and Caterwaul scores, five top general classes, duration, window count, model version/checksum and preprocessing version. This TFLite variant emits class scores, not embeddings. It does not infer intent. Aggregation is an unweighted mean over windows, including the padded tail; thresholds and real-world accuracy remain unvalidated.

The worker loads and verifies the model before claiming jobs, renews 60-second leases every 10 seconds during inference, and retries the **same** result acknowledgment if its response is lost. Stale/expired ownership cannot complete a job. Captures without supported `audioRef` values also use bounded retries; inspect failed jobs rather than assuming every old capture has audio. Existing owner reviews remain independent.

Model provenance, checksum and alternative checkpoint findings are in [MODEL_RESEARCH.md](MODEL_RESEARCH.md). The model is downloaded only during explicit setup; ordinary inference works offline. Setup needs internet for any missing packages/model; it is not an offline installer bundle. Unit tests do not download models or require ML dependencies. Real-model smoke uses synthetic silence and a tone, not evidence of accuracy on Tiri.

### CatMeows download

The authors provide [CatMeows v1.0.2](https://zenodo.org/records/4008297), DOI [10.5281/zenodo.4008297](https://doi.org/10.5281/zenodo.4008297), for scientific research and non-commercial purposes with acknowledgment/citation. Start here while Tiri recordings are unavailable; narrow experimental context labels do not establish intent or transfer accuracy to Tiri.

Acknowledgment: Luca Andrea Ludovico, Stavros Ntalampiras, Giorgio Presti, Simona Cannas, Monica Battini and Silvana Mattiello. Dataset reference: *CatMeows: A Publicly-Available Dataset of Cat Vocalizations*, MMM 2021, LNCS 12573, pp. 230–243. The Zenodo record also supplies the related 2019 study and full citation details.

```powershell
.\scripts\download-catmeows.ps1
.\scripts\setup.ps1 -CatMeows
# Or, without PowerShell wrappers:
py -3 local-service/manage.py catmeows
py -3.13 local-service/manage.py setup --catmeows
```

Dataset-only download uses the standard library and does not require the inference venv. Default model/runtime setup stays unchanged; the dataset is opt-in and never downloaded by ordinary unit tests/CI. Invocation from any CWD resolves `CatMeows/` at the scripts' checkout root.

| Archive | Authors' download | Bytes | Pinned SHA-256 |
| --- | --- | --- | --- |
| Main 440 clips | [dataset.zip](https://zenodo.org/records/4008297/files/dataset.zip?download=1) | 8861099 | `214000280e6ef33b10e39ef063ccc1f2f83d789ab57f2a5d111da63b06f659ae` |
| Supplementary 43 WAVs | [extras.zip](https://zenodo.org/records/4008297/files/extras.zip?download=1) | 4142654 | `81d1206a632f5d5052bcd9f804be10a02a6f7a2b8ab9a35858d105483159b4f2` |

The initial downloads matched the record's published MD5 values, respectively `b5fa911bcd6514e39dfef6876f747df4` and `7663bb5e1de2c808beeb202a52dc99ab`. SHA-256 values were calculated locally from those verified bytes and are now pinned in `catmeows.py`; they are not publisher signatures.

Layout: `CatMeows/archives/*.zip`, `CatMeows/raw/dataset/*.wav` and supplementary original folders beneath `raw/`; `provenance.json` records source/version/terms/hashes. ZIP extraction rejects absolute/traversal paths, links, case-insensitive duplicate filenames and excessive expansion. New extraction is staged before installation. Repeated runs compare expected raw files and fail if local changes differ, leaving them intact; move a modified `raw` directory aside explicitly before requesting fresh extraction. Keep annotations and derived/resampled files separate from originals.

All **483 downloaded WAVs are mono PCM16 at 8000 Hz**. Do not submit these originals directly to the current 16000-Hz worker: they will be rejected as unsupported audio. Resampling with a documented preprocessing version and dataset evaluation are next tasks. The extras include other cat vocalizations and uncut sequences; do not treat all extras as ground-truth non-meow/background negatives. No dataset or source audio is committed.

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

Each accepted `capture` creates exactly one pending job in the same SQLite transaction as its immutable message. Repeated delivery does not requeue a completed job. Reviews and other event types do not create jobs. Inference results are stored on the job and never replace owner observations. The optional worker processes supported local audio references; the API alone does not run inference.

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
