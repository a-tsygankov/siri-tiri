# Cloud synchronization through a Cloudflare Worker (first slice)

Status: written on 2026-11-01 from the owner's requirement ("clips recorded in a browser tab, in the installed app or on another phone must be visible, with audio, everywhere; reviews and later trimmed audio sync the same way"). The owner chose the author's defaults for every open choice, so every decision below not marked "owner" is the author's call. Implemented on branch `claude/cloud-sync`.

## Intent and why now

The phone app from PR 12 keeps everything in one browser origin. The owner has already hit the consequence: a Safari tab and the installed app do not see each other's clips, and a second phone sees nothing. Every later step (device captures, episode grouping, analysis results reaching the phone) needs the same transport. This slice builds that transport once: an authenticated Cloudflare Worker with D1 for metadata and sync order and R2 for the WAV bytes, and a PWA outbox/inbox that uses it.

Owner requirements:

1. Raw captured audio is uploaded and stored by the cloud together with the capture metadata, so a clip recorded anywhere is downloadable everywhere.
2. Owner reviews sync the same way, so review can happen from any phone or computer after capture. Trimmed audio (being added by a sibling change as a superseding capture message) must flow through the same path without redesign.
3. Room for episode grouping (PR 13 design): the Worker/D1 tier will run grouping later and `episode.v1` records will be synced like reviews.

## Goals

- A capture saved on phone A appears on phone B with playable audio after both have synced, with no manual export.
- A review saved on B for A's clip appears on A as the next revision of the same review thread.
- Nothing is lost when the phone is offline, restarts, or updates the app between saving and syncing. Upload happens on launch, resume, reconnect, after a save, and on a Sync now tap. Never on iOS background sync.
- At-least-once delivery with `messageId` idempotency; a retried message with a different canonical payload is a conflict, not an overwrite.
- Review revisions keep their `baseRevision` chain on the server; a revision that does not extend the chain is kept and surfaced, never merged silently.
- Per-device revocable credentials. No shared account token in any client. Nothing secret in Git.
- The UI tells the truth: Saved on this phone, Queued, Synced, and "From another device" are distinct, and Synced is shown only after the Worker has acknowledged every message and the audio of that event.
- Local Wrangler development and tests first. No Cloudflare resource is created and nothing is deployed without the owner's explicit yes.

## Non-goals (this slice)

- No inference in the cloud, no job claim/lease API, no `analysis` messages, no "Analysis complete" state (the state is reserved in the UI vocabulary and never shown).
- No episode grouping code. The Worker stores and relays `episode.v1` messages if a client sends them, and nothing more.
- No local-service changes. The localhost `/events` path, the SQLite queue and the manual export bundle keep working unchanged. A local-service cloud client is a later slice.
- No ESP32 client. The pairing and message API is designed so firmware can use it later.
- No admin web dashboard, no log ingestion endpoint, no release manifest endpoint.
- No multi-user or multi-household model. One household, many devices.
- No presigned R2 URLs. Audio goes through the Worker with the device token; clips are at most 30 s of PCM16, under 3 MB.

## Anti-goals

- Showing Synced for anything the Worker has not durably acknowledged, or Queued for a phone that has no sync configured.
- Losing or silently replacing a review the owner wrote on another phone.
- A device token or admin secret in a URL, a log line, a test fixture or a committed file.
- Breaking the sibling trim change: a superseding capture with the same `eventId` must be an ordinary message to the Worker.

## Constraints

- Repository rules (`AGENTS.md`): feature branch, PR to `main`, exact test reporting, ask before cloud resources and deploys.
- Architecture baseline (`docs/ARCHITECTURE_SYNC_UPDATES_LOGGING.md`, `contracts/README.md`): Hono + TypeScript Worker, Wrangler, D1 migrations, `.dev.vars.example` committed and `.dev.vars` ignored, D1 authoritative for metadata and cursors, R2 for audio, structured logs without audio or tokens.
- PWA constraints from PR 12: no build step, plain ES modules served from `docs/app/`, IndexedDB only, iOS Safari first.
- The PWA is served from GitHub Pages (`https://a-tsygankov.github.io`), so the Worker must answer CORS preflights for an allow-listed origin and for local development origins.

## Vocabulary

- **Device**: one paired client installation: a PWA origin (Safari tab and installed app are two devices), later an ESP32 or the local service. Identified by `deviceId` (Worker-assigned UUID) and the client's own `sourceId` (the PWA `installId`).
- **Message**: one immutable `event.v1`, `review-v1` or `episode.v1` document, keyed by `messageId`.
- **Clip**: one WAV object, keyed by `clipId`, declared by a capture message's payload (`clipId`, `sha256`, `sizeBytes`).
- **Sync log**: the Worker's single append-only sequence of things a client may need: accepted messages and completed clip uploads. A client's cursor is the last `seq` it applied.

## Worker

### Package layout (author's call)

```
worker/
  package.json           hono, wrangler, vitest + @cloudflare/vitest-pool-workers, typescript
  wrangler.toml          D1 binding DB, R2 binding CLIPS, vars; placeholder ids until resources exist
  .dev.vars.example      ADMIN_SECRET=change-me, ALLOWED_ORIGINS=http://localhost:8080,http://127.0.0.1:8080
  migrations/0001_init.sql
  src/index.ts           Hono app, CORS, error shape, request id
  src/auth.ts            pairing codes, device tokens, revocation
  src/messages.ts        validation, canonical hash, idempotent insert, review chain
  src/clips.ts           upload verification, R2 keys, download
  src/sync.ts            cursor pull
  src/log.ts             structured JSON log helper (never bodies, never tokens)
  test/*.test.ts         vitest-pool-workers against local D1 and R2
  scripts/pairing-code.mjs   calls the admin endpoint against a local or remote Worker
```

`worker/` is its own npm package with its own version (`0.1.0`) reported by `GET /v1/health`. Protocol version is 1, shared with the contracts.

### D1 schema (migration 0001)

- `devices(device_id TEXT PK, source_id TEXT, label TEXT, component TEXT, token_hash TEXT UNIQUE, paired_at, last_seen_at, revoked_at)`.
- `pairing_codes(code_hash TEXT PK, label TEXT, created_at, expires_at, used_at, used_by_device_id)`.
- `messages(message_id TEXT PK, kind TEXT CHECK(kind IN ('event','review','episode')), event_id TEXT, correlation_key TEXT, type TEXT, source_id TEXT, device_id TEXT, created_at TEXT, received_at TEXT, payload_hash TEXT, body TEXT, status TEXT CHECK(status IN ('accepted','conflict')), conflict_reason TEXT)`. `correlation_key` is `eventId` for events and reviews and `episodeId` for episodes. Index on `(event_id)`, `(received_at)`.
- `review_chain(event_id TEXT, revision INTEGER, message_id TEXT, PRIMARY KEY(event_id, revision))`: the accepted revision chain per event.
- `clips(clip_id TEXT PK, event_id TEXT, message_id TEXT, device_id TEXT, sha256 TEXT, size_bytes INTEGER, r2_key TEXT, uploaded_at TEXT, deleted_at TEXT)`.
- `sync_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT CHECK(kind IN ('message','clip')), ref_id TEXT, device_id TEXT, created_at TEXT)`.

Migration IDs are independent from the SQLite ones in `local-service/`.

### Authentication

- `ADMIN_SECRET` is a Worker secret (`.dev.vars` locally, `wrangler secret put` remotely). It is used only by the owner's scripts to mint pairing codes and manage devices. It never goes into a client.
- **Pairing code**: `POST /v1/admin/pairing-codes` with `Authorization: Bearer <ADMIN_SECRET>` and `{label}` returns a one-time code: 8 characters from a 32-symbol alphabet without confusable letters (about 40 bits), valid for 15 minutes, single use. Only its SHA-256 is stored. The code is shown once by `scripts/pairing-code.mjs`.
- **Pairing**: `POST /v1/devices/pair` (no auth) with `{code, sourceId, component: "pwa", version, label}` returns `{deviceId, token, protocolVersion}` once. The token is 32 random bytes in base64url; the Worker stores only its SHA-256. A wrong, expired or used code gets the same 401. A code is deleted after 5 failed attempts.
- **Requests**: `Authorization: Bearer <token>`. Lookup by token hash. A revoked or unknown token gets 401 `{error: "unauthorized"}`; the PWA then forgets its token and shows "Not paired". `last_seen_at` is updated at most once a minute.
- **Admin**: `GET /v1/admin/devices`, `POST /v1/admin/devices/{deviceId}/revoke`. Admin routes also accept only the admin secret. There is no admin UI in this slice.

Tokens live in the PWA's IndexedDB `meta` store, like every other PWA credential; the app never puts them in a URL or in a log.

### Message ingest

`POST /v1/messages` with `{messages: [{kind, body}, ...]}`, at most 50 per request, body at most 512 KB. Each item is validated against the contract subset (required fields, enums, uuid formats, `schemaVersion: 1`), using the same minimal checker approach as `docs/app/schema-check.js` ported to TypeScript. Per-item result: `{messageId, status: "accepted" | "duplicate" | "conflict" | "rejected", reason?}`. The HTTP status is 200 whenever the request itself was well-formed; a client acts per item.

Rules:

1. Idempotency: an existing `messageId` with the same canonical payload hash (JSON with sorted keys, no whitespace) is `duplicate`; with a different hash it is `conflict` with reason `payload_mismatch` and nothing is written. `duplicate` counts as success for the client.
2. Events (`kind: "event"`): any `type` the contract allows. A capture payload with `clipId`, `sha256` and `sizeBytes` and without `deleted: true` creates a `clips` row owned by the sending device if none exists for that `clipId`. A tombstone (`payload.deleted: true`) marks every clip of that `eventId` deleted and deletes their R2 objects after the message is committed. A superseding capture (the sibling's trim or restore message) is an ordinary capture: new `clipId` for a trim; a restore names an existing `clipId`, which is fine because the clip row already exists.
3. Reviews (`kind: "review"`): accepted into `review_chain` only if `revision` equals the current highest accepted revision for the event plus one and `baseRevision` equals that highest (or both are 1 and null for the first). Otherwise the message is stored with `status: "conflict"` and reason `revision_conflict`, and the item result is `conflict` with the current `latestRevision` so the client can rebase. Conflict messages are kept forever and visible through `GET /v1/conflicts`; they are not in the sync log.
4. Episodes (`kind: "episode"`): stored with the same idempotency rule and appended to the sync log without chain checks. Grouping and chain enforcement for episodes are the PR 13 implementation's job.
5. Accepted messages get one `sync_log` row in the same D1 batch as the insert, so a message is never visible without being durable and never durable without being visible.
6. `received_at` is the Worker's clock at acceptance, stored next to the message (episode grouping input).

### Clips

- `PUT /v1/clips/{clipId}` with `Content-Type: audio/wav` and the raw WAV body. The Worker checks: the clip row exists and belongs to the calling device (or the device sent the capture message in the same sync run, which is the same thing: the capture must be accepted first), the body length equals `sizeBytes`, the SHA-256 of the body equals the declared `sha256`. Mismatch is 409 `{error: "clip_mismatch"}` with nothing stored. Success writes the object at `clips/<eventId>/<clipId>.wav` with the sha256 as custom metadata, sets `uploaded_at` and appends a `sync_log` row `{kind: "clip", ref_id: clipId}`. A repeat upload of an already uploaded clip is 200 and appends nothing. Maximum body 4 MB.
- `GET /v1/clips/{clipId}` streams the object to any paired device; 404 if not uploaded or deleted.
- A clip deleted by a tombstone is gone from R2. Trimmed audio does not delete the original clip: both clip rows stay and both objects stay until the event is tombstoned. The owner's "keep the original" rule from the sibling change is honored by the Worker doing nothing special.

### Pull

`GET /v1/sync?cursor=<seq>&limit=<n>` (default 100, max 500) returns `{entries: [...], cursor: <last seq>, more: boolean}`. Each entry is `{seq, kind: "message", body: {...}, messageKind: "event"|"review"|"episode", receivedAt, deviceId}` or `{seq, kind: "clip", clipId, eventId, sha256, sizeBytes}`. The requesting device's own entries are included (cheap, and it confirms acknowledgment); clients apply entries idempotently. Cursor 0 is the start.

`GET /v1/conflicts?cursor=` lists conflict messages the same way, for a later UI; the PWA in this slice uses only the per-item push result.

### Other routes

- `GET /v1/health` (no auth): `{status, component: "worker", version, protocolVersion, migration}`.
- CORS: `ALLOWED_ORIGINS` var (comma-separated). Preflight allows `Authorization`, `Content-Type`, `X-Request-Id`. The GitHub Pages origin is added when the owner deploys.
- Errors: `{error: <code>, requestId}`; 400 validation, 401 auth, 404, 409 conflicts, 413 too large, 429 reserved, 500 with request id. Every response carries `X-Request-Id`.
- Logging: one JSON line per request with method, route, status, latency, `deviceId`, request id, and for ingest the counts per status. Never bodies, never tokens, never codes.

### Worker tests (vitest-pool-workers, local D1 and R2)

Pairing (good code, reused code, expired code, five bad attempts), auth (missing, bad, revoked token), ingest (accept, duplicate, payload mismatch, invalid envelope rejected per item, batch limit), review chain (first, next, gap, stale base, same revision from two devices), clip upload (ownership, size mismatch, hash mismatch, idempotent repeat, download, tombstone deletes objects), sync (cursor order, own entries included, clip entry after upload, limit and `more`), and that logs never contain a token or a body.

## PWA

### Storage (IndexedDB version 2, additive upgrade)

- `clips` rows gain `origin: "local" | "remote"`; existing rows are treated as local.
- `outbox` rows gain `state` values `pending | sent | conflict | failed`, `attempts`, `nextAttemptAt`, `lastError`. Existing rows stay `pending`. A row is deleted once accepted or duplicate; `conflict` and `failed` rows stay for the Settings list and for retry.
- New store `syncState` keyed by `key`: `cursor`, `lastSyncAt`, `lastError`. Kept separate from `meta` so "Delete everything" can clear data and keep the pairing.
- `meta` gains `syncUrl`, `deviceId`, `deviceToken`, `deviceLabel`.
- New store `conflicts` keyed by `messageId`: a local review revision the Worker refused (`revision_conflict`), with its `eventId`, so the Review screen can show it.
- `events` rows gain `acceptedAt` (Worker acknowledgment time, null until then); `clips` rows gain `uploadedAt`. These are app-local, outside the envelope, like `exportedAt`.
- `saveCapture` keeps writing capture + clip + outbox atomically. Remote captures arrive through `applyRemote` writes (below).

Migration is `onupgradeneeded` from 1 to 2: create the two stores, nothing dropped. Rows without the new fields get defaults on read.

### Sync run (`docs/app/sync.js`)

One function `runSync(db, api, opts)` that is safe to call at any time and is serialized by a lock (a second call while one runs returns `busy`; a call that arrives during a run sets a "run again" flag so a save during sync is not missed). Steps, each independently retried on the next run:

1. **Push messages.** Read outbox rows with `state` in `pending` and `nextAttemptAt <= now`, order events by `createdAt` then reviews by `editedAt`, batch 50. Per item result: `accepted`/`duplicate` → delete outbox row, set `acceptedAt` on the event or review; `conflict` with `revision_conflict` → outbox row `conflict`, review copied to `conflicts`; `conflict` with `payload_mismatch` or `rejected` → outbox `failed` with reason (surfaced in Settings; the owner can retry after an app update). Network or 5xx → `attempts + 1`, `nextAttemptAt = now + min(10 min, 5 s × 2^attempts) ± 20 % jitter`, stop this run.
2. **Upload clips.** For every local clip whose capture is accepted and `uploadedAt` is null, `PUT` the WAV. 200/201 → `uploadedAt`. 409 `clip_mismatch` → mark the event `failed` in the outbox sense (a `failed` outbox row with reason) so the UI can say so. Network error → stop with backoff as above.
3. **Pull.** `GET /v1/sync?cursor=` in pages until `more` is false. Apply each entry in one IndexedDB transaction per page: event messages are put into `events` (idempotent by `messageId`; a tombstone from elsewhere deletes the local clip row; a review message goes into `reviews` unless already present). A pulled review whose `[eventId, revision]` collides with a different local `messageId` replaces the local row and moves the local one to `conflicts` (this can only happen for a revision the Worker already refused). Clip entries set `remoteAvailable` on the matching clip row or create a stub clip row (`origin: "remote"`, no blob). Cursor advances only after the page is committed.
4. **Download clips.** For stub clip rows of non-deleted events, newest first, at most 20 per run and only while storage is not blocked: `GET` the WAV, verify its SHA-256 against the capture payload, store the blob with `origin: "remote"`. The Review screen also fetches on demand when it opens an event whose clip is a stub ("Downloading audio…").

Triggers: `init()` after the first render, `visibilitychange` to visible, `online`, after `saveCapture`, `saveReview` and `deleteClip` (debounced 2 s), and the Sync now button. None of these waits on the UI; sync runs in the page's main thread but never blocks recording (a running recorder skips the clip-download step until the next run).

Transport: `fetch` with a 30 s timeout per request. The sync module takes `fetch` and `now` as injectable parameters so Node tests can drive it with fakes; the IndexedDB side is exercised in the browser harness.

### Settings: Cloud sync card

- Not paired: a **Server URL** field (prefilled with the last used value), a **Pairing code** field and a **Pair** button. Pairing calls `/v1/devices/pair`, stores `deviceId` and `deviceToken`, then runs a first sync. Errors: wrong or expired code, cannot reach the server.
- Paired: "Paired as <label> with <server host>", last sync time, counts of queued messages and clips, failed items with their reason and a **Retry failed** button, **Sync now**, and **Unpair** (forgets the token locally; the owner revokes server-side with the admin script). "Delete everything" leaves the pairing in place and resets the cursor so the phone re-pulls.
- The URL and code fields are ordinary inputs; the token is never shown.

### UI states (owner-facing words)

| Where | State | When |
|---|---|---|
| Event row and Review header | **Saved on this phone** | capture written locally; sync not configured, or configured and not yet attempted |
| | **Queued** | sync configured and the capture or its clip is still in the outbox (pending or retrying) |
| | **Synced** | the capture message is accepted and its clip is uploaded; for a remote event, as soon as it was pulled |
| | **Sync failed** | an outbox row for this event is `failed` or `conflict` (with the reason on the Review screen) |
| Review header | **Recorded by you** / **Recorded on <device label>** | by `sourceId` versus this install's `installId` |
| Review header | **Audio not downloaded yet** / **Downloading audio…** | remote clip stub without a blob |
| Review badge | **Needs review** / **Reviewed · <context>** | unchanged |
| Review screen | **Review conflict** | a `conflicts` row exists for this event: shows the refused context and offers "Save again" which rebases on the latest synced revision |
| Today | counts: Needs review, Saved on this phone, Queued, Synced | computed from the stores; "All recordings stay on this phone" becomes "Syncing to <host>" when paired |
| Settings | **Not paired** / **Paired** / last sync / failures | as above |

"Analysis complete" is not shown anywhere; it is reserved.

### Records

`buildCapture` adds `clockSource: "phone"` (contracts README, PR 13 rule). Nothing else in the envelopes changes. Reviews written on a phone for a remote event use the same `buildReview`, with `previous` being the latest synced revision; the per-event write guard and the `[eventId, revision]` unique index stay.

### Export

Unchanged. Remote events and their downloaded clips are exported like local ones (they are records and WAVs on this phone). The bundle gains nothing in this slice.

### Service worker

Precache gains `./sync.js`. `APP_VERSION` becomes `0.2.0` in both files. Sync requests go to another origin and are never intercepted by the worker (it already ignores cross-origin requests).

### PWA tests

Node (`node --test docs/app/tests/*.test.mjs`): sync planning and backoff schedule, per-item result handling against a fake db and fake fetch, pull application rules (idempotent put, tombstone removes clip, review collision goes to conflicts, cursor advances per page), clip verification before storing, state derivation for the badges, `clockSource` in `buildCapture`, version test. Browser harness: IndexedDB v2 upgrade from a v1 database keeps rows, `conflicts` and `syncState` stores work, outbox state transitions.

## End-to-end verification (done means)

Locally: `wrangler dev` with local D1 and R2, the PWA served by `python -m http.server 8080` from `docs/`, and two browser origins that are two devices (`http://localhost:8080/app/` and `http://127.0.0.1:8080/app/`, whose IndexedDB are separate). Pair each with its own code, record (or inject a WAV through the harness where no microphone exists) on one, sync both, and confirm the other lists the event as Synced, plays the audio, and that a review saved on the second appears on the first as revision 2. Record the exact steps and results in the PR.

Remote: only after the owner says yes to `wrangler d1 create`, `wrangler r2 bucket create`, `wrangler secret put ADMIN_SECRET` and `wrangler deploy`. The PR describes those commands and leaves them to the owner.

## Security notes

- Device tokens: 256-bit random, stored hashed, revocable; one per browser origin. Pairing codes: single use, 15 minutes, hashed, attempt-limited.
- The admin secret is used only from the owner's machine through the script; it is never required by the PWA.
- The Worker validates every message against the contracts and every clip against its declared size and hash, so a device can only ever add well-formed records and the audio it promised.
- CORS is allow-listed. No cookies.
- Logs: ids, counts, status, latency. No bodies, no audio, no tokens, no codes.
- Retention: none in this slice; everything is kept until tombstoned. A retention rule is a follow-up.

## Interaction with sibling and future work

- **Trim (sibling session):** a trim is a capture message with `supersedesMessageId` and a new `clipId`; a restore names the original `clipId`. The Worker and the pull path treat both as captures; the PWA's "current capture" logic for display is the sibling's and is merged, not redesigned, here. Where both changes touch `db.js`, `records.js` or `app.js` the second PR to merge resolves the conflict.
- **Episodes (PR 13):** `kind: "episode"` is accepted and relayed now. The grouper, `review_chain`-like checks for episodes, and the PWA episode store are the implementation PR's job; the D1 tables it needs are additive.
- **Local service:** a later slice gives `local-service/` a device token and the same push/pull client to become a cloud peer and the inference worker over R2 audio.
- **Analysis:** `analysis` messages will ride the same sync log; the PWA then shows "Analysis complete" and never overwrites a review with it.

## Left to the builder

- Exact Hono middleware layout, zod versus the ported minimal checker (either is fine; zod is already in the feedme2 pattern).
- Whether the sync module exposes a tiny event emitter for UI progress or the UI polls counts after each run.
- How the two-origin desktop test injects a WAV where no microphone exists (harness or a console helper).
- Copy for error messages, within the vocabulary above.
