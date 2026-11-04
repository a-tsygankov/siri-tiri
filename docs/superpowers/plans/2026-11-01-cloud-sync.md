# Cloud Sync (Worker + PWA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Captures, their WAV audio and owner reviews recorded in any PWA origin reach a Cloudflare Worker and appear on every other paired PWA origin.

**Architecture:** A Hono + TypeScript Worker (`worker/`) stores messages and a sync log in D1 and WAV objects in R2 behind per-device bearer tokens issued from one-time pairing codes. The PWA (`docs/app/`) gains an IndexedDB v2 upgrade, a `sync.js` module that pushes the outbox, uploads clips, pulls by cursor and downloads clips, and Settings/Today/Events/Review UI for pairing and the Queued/Synced/failed states.

**Tech Stack:** Hono 4, Wrangler 4, D1, R2, vitest 4 with `@cloudflare/vitest-pool-workers`, TypeScript 5; PWA stays dependency-free ES modules tested with `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-01-cloud-sync-design.md`

## Global Constraints

- Never commit to `main`; branch `claude/cloud-sync`, PR to `main`.
- No Cloudflare resource creation and no deploy without the owner's explicit yes. `wrangler.toml` carries placeholder ids; only local D1/R2.
- `worker/.dev.vars.example` committed; `worker/.dev.vars`, `worker/node_modules`, `worker/.wrangler` ignored.
- Message ingest: max 50 items per request, body max 512 KB. Clip upload max 4 MB, `Content-Type: audio/wav`, R2 key `clips/<eventId>/<clipId>.wav`.
- Pairing code: 8 chars from alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, 15 min TTL, single use, deleted after 5 failed attempts, stored as SHA-256 hex. Device token: 32 random bytes base64url, stored as SHA-256 hex.
- Backoff: `nextAttemptAt = now + min(600000, 5000 * 2^attempts)` with ±20 % jitter.
- Owner-facing words: "Saved on this phone", "Queued", "Synced", "Sync failed", "Recorded by you", "Recorded on <label>", "Audio not downloaded yet", "Downloading audio…", "Review conflict", "Not paired", "Paired". Never "Analysis complete", "Detected".
- Logs never contain bodies, audio, tokens or codes.
- `APP_VERSION` becomes `0.2.0` in both `docs/app/version.js` and `docs/app/sw.js`.
- Existing tests must keep passing: `node --test docs/app/tests/*.test.mjs`, `py -3 -m unittest discover -s local-service/tests -v` (local service untouched).

## Review Focus

1. A capture pushed while its clip upload later fails with `clip_mismatch` (phone re-encoded the WAV): the event must show "Sync failed" with the reason, not "Synced" and not "Queued" forever (Task 7 test `clip mismatch marks the event failed`).
2. Two phones save revision 2 of the same review offline, then sync: the second must land in `conflicts` on the Worker and the losing phone must show "Review conflict" with a working "Save again" (Task 3 test `same revision from two devices`, Task 7 test `pulled review colliding with a refused local revision`).
3. A pull page that fails to commit to IndexedDB must not advance the cursor (Task 7 test `cursor advances only after a page is applied`).
4. A revoked device keeps its local data, shows "Not paired", and its outbox stays pending so re-pairing resumes (Task 7 test `401 forgets the token and keeps the outbox`).
5. A tombstone pulled from another phone for an event whose clip was downloaded here must delete the local blob (Task 7 test `remote tombstone deletes the local clip`).

---

### Task 1: Worker scaffold, migration 0001, health route

**Files:**
- Create: `worker/package.json`, `worker/wrangler.toml`, `worker/tsconfig.json`, `worker/vitest.config.ts`, `worker/.dev.vars.example`, `worker/migrations/0001_init.sql`, `worker/src/index.ts`, `worker/src/env.ts`, `worker/src/log.ts`, `worker/test/apply-migrations.ts`, `worker/test/health.test.ts`, `worker/README.md`
- Modify: `.gitignore` (append `worker/node_modules/`, `worker/.wrangler/`, `worker/.dev.vars`, `worker/dist/`)

**Interfaces:**
- Produces: `app` (Hono) default-exported from `src/index.ts`; `Env` type in `src/env.ts` with `DB: D1Database`, `CLIPS: R2Bucket`, `ADMIN_SECRET: string`, `ALLOWED_ORIGINS: string`, `ENVIRONMENT: string`; `WORKER_VERSION = '0.1.0'`, `PROTOCOL_VERSION = 1`, `MIGRATION = 1` exported from `src/env.ts`; `log(event: string, fields: Record<string, string | number | boolean | null>): void` in `src/log.ts` that `console.log`s one JSON line.
- Tests use `import { env, SELF } from 'cloudflare:test'` and `SELF.fetch('http://x/v1/health')`.

- [ ] **Step 1: Write package.json, wrangler.toml, tsconfig, vitest config**

`package.json`: `"name": "siri-tiri-worker"`, `"version": "0.1.0"`, `"private": true`, `"type": "module"`, scripts `dev: wrangler dev`, `test: vitest run`, `typecheck: tsc --noEmit`, `db:migrate:local: wrangler d1 migrations apply siri-tiri-db --local`, `deploy: wrangler deploy`. Dependencies `hono ^4.13`; devDependencies `wrangler ^4.156`, `vitest ^4.1`, `@cloudflare/vitest-pool-workers ^0.23`, `@cloudflare/workers-types ^4`, `typescript ^5.6`. Run `npm install` inside `worker/` and commit the lockfile.

`wrangler.toml`: `name = "siri-tiri-worker"`, `main = "src/index.ts"`, `compatibility_date = "2026-10-01"`, `compatibility_flags = ["nodejs_compat"]`, `[[d1_databases]] binding = "DB" database_name = "siri-tiri-db" database_id = "00000000-0000-0000-0000-000000000000" migrations_dir = "migrations"`, `[[r2_buckets]] binding = "CLIPS" bucket_name = "siri-tiri-clips"`, `[vars] ENVIRONMENT = "production" ALLOWED_ORIGINS = "https://a-tsygankov.github.io"`, `[observability] enabled = true`, with a comment that ids are placeholders until the owner creates resources.

`vitest.config.ts` uses `defineWorkersConfig` with `readD1Migrations('./migrations')` passed as miniflare binding `TEST_MIGRATIONS`, `setupFiles: ['./test/apply-migrations.ts']`, `wrangler: { configPath: './wrangler.toml' }`, and miniflare `bindings: { ADMIN_SECRET: 'test-admin', ALLOWED_ORIGINS: 'http://localhost:8080', ENVIRONMENT: 'test' }`. `test/apply-migrations.ts` calls `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)`.

- [ ] **Step 2: Write migration 0001_init.sql** with the six tables from the spec (`devices`, `pairing_codes`, `messages`, `review_chain`, `clips`, `sync_log`) and indexes `idx_messages_event (event_id)`, `idx_messages_received (received_at)`, `idx_clips_event (event_id)`, `idx_sync_log_created (created_at)`.

- [ ] **Step 3: Write failing test `test/health.test.ts`**

```ts
it('GET /v1/health reports component, version, protocol and migration', async () => {
  const res = await SELF.fetch('http://x/v1/health');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok', component: 'worker', version: '0.1.0', protocolVersion: 1, migration: 1 });
  expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
});
it('CORS preflight from an allowed origin is accepted and from another is not', ...) // expects access-control-allow-origin echo for http://localhost:8080 and absent for http://evil.test
```

- [ ] **Step 4: Run `npm test` in `worker/`; expected FAIL (no app)**
- [ ] **Step 5: Implement `src/index.ts`**: Hono app, `X-Request-Id` middleware (`crypto.randomUUID()`), `hono/cors` with `origin` callback over `ALLOWED_ORIGINS.split(',')`, `allowHeaders: ['Authorization','Content-Type','X-Request-Id']`, `exposeHeaders: ['X-Request-Id']`; `onError` returning `{error:'internal', requestId}` 500 and logging `event: 'request_error'`; `GET /v1/health`.
- [ ] **Step 6: Run `npm test`; expected PASS. Run `npm run typecheck`; expected no errors.**
- [ ] **Step 7: Write `worker/README.md`** (setup: `npm install`, `cp .dev.vars.example .dev.vars`, `npm run db:migrate:local`, `npm run dev`; test; the owner-only remote steps listed but marked "not run"), `.dev.vars.example`, append `.gitignore`.
- [ ] **Step 8: Commit** `feat(worker): scaffold Hono worker with D1 migration 0001 and health route`

### Task 2: Pairing codes, device tokens, admin routes

**Files:**
- Create: `worker/src/auth.ts`, `worker/scripts/pairing-code.mjs`, `worker/test/auth.test.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- Produces in `src/auth.ts`: `sha256Hex(input: string | ArrayBuffer): Promise<string>`; `generateCode(): string` (8 chars, alphabet above); `createPairingCode(env, label: string, now: Date): Promise<{code: string, expiresAt: string}>`; `pairDevice(env, {code, sourceId, component, version, label}, now): Promise<{deviceId, token} | null>`; `authenticate(env, authorization: string | undefined, now): Promise<Device | null>` where `Device = {deviceId, sourceId, label, component}`; Hono middleware `requireDevice` setting `c.var.device`, and `requireAdmin` (constant-time compare of bearer with `ADMIN_SECRET`).
- Routes: `POST /v1/admin/pairing-codes` `{label}` → 201 `{code, expiresAt}`; `GET /v1/admin/devices` → `{devices: [{deviceId, sourceId, label, component, pairedAt, lastSeenAt, revokedAt}]}`; `POST /v1/admin/devices/:id/revoke` → 200 `{deviceId, revokedAt}`; `POST /v1/devices/pair` → 201 `{deviceId, token, protocolVersion}` or 401 `{error:'unauthorized'}`.

- [ ] **Step 1: Write failing tests** in `test/auth.test.ts` with a helper `admin(path, body)` sending `Authorization: Bearer test-admin`:
  - `pairing with a fresh code returns a token; the same code again is 401`
  - `an expired code is 401` (create, then pair with a request whose server clock is advanced: expose `now` through a test-only header `X-Test-Now` honored only when `ENVIRONMENT === 'test'`)
  - `five wrong attempts delete the code` (five 401s with wrong code `AAAAAAAA`, then the right code is 401 too)
  - `admin routes reject a missing or wrong secret with 401`
  - `revoked device token is 401 on /v1/sync` (route exists in Task 5; here assert on a stub `GET /v1/whoami` returning `{deviceId}` that stays in the API as a cheap auth check)
  - `token hash, not token, is stored` (query `env.DB` for `token_hash` and assert it is 64 hex chars and not equal to the token)
- [ ] **Step 2: Run tests; expected FAIL**
- [ ] **Step 3: Implement `src/auth.ts` and wire routes in `src/index.ts`**, including `GET /v1/whoami`. Failed attempts counted in a `attempts` column: add it to the `pairing_codes` table in migration 0001 (migration still unreleased, so edit in place).
- [ ] **Step 4: Run tests; expected PASS; typecheck clean**
- [ ] **Step 5: Write `scripts/pairing-code.mjs`**: `node scripts/pairing-code.mjs --url http://127.0.0.1:8787 --label "Andrey iPhone"` reads `ADMIN_SECRET` from `worker/.dev.vars` (or `SIRI_TIRI_ADMIN_SECRET` env) and prints the code and expiry once. Document in `worker/README.md`.
- [ ] **Step 6: Commit** `feat(worker): one-time pairing codes and hashed per-device tokens`

### Task 3: Message ingest with idempotency, review chain and sync log

**Files:**
- Create: `worker/src/messages.ts`, `worker/src/validate.ts`, `worker/test/messages.test.ts`, `worker/test/fixtures.ts`
- Modify: `worker/src/index.ts`

**Interfaces:**
- `src/validate.ts`: `checkSchema(doc: unknown, schema: Schema): string[]` (TypeScript port of `docs/app/schema-check.js`, same error strings) and `validateItem(item: unknown): {kind: 'event'|'review'|'episode', body: Record<string, unknown>} | {error: string}` using `import eventSchema from '../../contracts/event.v1.schema.json'` etc.
- `src/messages.ts`: `canonicalHash(body): Promise<string>` (JSON with recursively sorted keys, then sha256Hex); `ingest(env, device: Device, items: unknown[], now: Date): Promise<ItemResult[]>` where `ItemResult = {messageId?: string, status: 'accepted'|'duplicate'|'conflict'|'rejected', reason?: string, latestRevision?: number}`.
- Route: `POST /v1/messages` `{messages: [...]}` → 200 `{results: ItemResult[]}`; 400 `{error:'bad_request'}` if not an array or > 50; 413 if body > 512 KB.
- `test/fixtures.ts`: `capture({eventId?, clipId?, sha256?, sizeBytes?, sourceId?})`, `tombstone(capture)`, `trim(capture)` (same `eventId`, `payload.supersedesMessageId`, new `clipId`, `payload.trim`), `review({eventId, revision, baseRevision, reviewId?})`, `episode({episodeId, revision})`, `pairedDevice(label)` returning `{token, deviceId, sourceId}`, `post(token, path, body)`.

- [ ] **Step 1: Write failing tests** in `test/messages.test.ts`:
  - `accepts a capture, stores received_at, creates a clips row and one sync_log row`
  - `same messageId with same body is duplicate and writes nothing new`
  - `same messageId with different body is conflict payload_mismatch`
  - `an item missing eventId is rejected and the other items in the batch are accepted`
  - `51 items is 400`
  - `review revision 1 then 2 are accepted into review_chain`
  - `review revision 3 with base 1 when latest is 2 is conflict revision_conflict with latestRevision 2, stored with status conflict and not in sync_log`
  - `same revision from two devices: second is revision_conflict`
  - `tombstone marks the event's clips deleted`
  - `trim capture with the same eventId creates a second clips row`
  - `episode message is accepted and logged without chain checks`
  - `log lines for ingest contain counts but no body, token or code` (spy `console.log`)
- [ ] **Step 2: Run; expected FAIL**
- [ ] **Step 3: Implement `validate.ts`, `messages.ts`, route**. Use `env.DB.batch([...])` per item so message insert, chain/clips rows and sync_log append commit together. Kind detection: `reviewId` present → review, `episodeId` → episode, else event.
- [ ] **Step 4: Run; expected PASS; typecheck clean**
- [ ] **Step 5: Commit** `feat(worker): idempotent message ingest with review chain and sync log`

### Task 4: Clip upload, download and tombstone deletion

**Files:**
- Create: `worker/src/clips.ts`, `worker/test/clips.test.ts`
- Modify: `worker/src/index.ts`, `worker/src/messages.ts` (tombstone → R2 delete after commit)

**Interfaces:**
- `src/clips.ts`: `r2Key(eventId, clipId): string`; `putClip(env, device, clipId, body: ArrayBuffer, now): Promise<{status: 'uploaded'|'already'|'not_found'|'forbidden'|'mismatch'}>`; `getClip(env, clipId): Promise<R2ObjectBody | null>`; `deleteEventClips(env, eventId): Promise<void>`.
- Routes: `PUT /v1/clips/:clipId` → 201 `{clipId, uploadedAt}` / 200 (already) / 404 / 403 / 409 `{error:'clip_mismatch'}` / 413 (> 4 MB) / 415 (not `audio/wav`); `GET /v1/clips/:clipId` → 200 `audio/wav` stream with `ETag` sha256 / 404.

- [ ] **Step 1: Write failing tests**: `upload after accepted capture stores the object at clips/<eventId>/<clipId>.wav and appends a clip sync_log row`; `size mismatch is 409 and nothing stored`; `hash mismatch is 409`; `another device cannot upload this clip (403)`; `repeat upload is 200 and appends no sync_log row`; `download returns the bytes to any paired device`; `tombstone deletes R2 objects of the event and later download is 404`; `unknown clipId is 404`; `wrong content type is 415`.
- [ ] **Step 2: Run; expected FAIL**
- [ ] **Step 3: Implement**. Hash with `crypto.subtle.digest('SHA-256', body)`. Tombstone deletion in `ingest` after the batch resolves, via `deleteEventClips`.
- [ ] **Step 4: Run; expected PASS**
- [ ] **Step 5: Commit** `feat(worker): verified WAV upload to R2 and authenticated download`

### Task 5: Cursor pull and conflicts listing

**Files:**
- Create: `worker/src/sync.ts`, `worker/test/sync.test.ts`
- Modify: `worker/src/index.ts`, `worker/README.md` (API table)

**Interfaces:**
- `src/sync.ts`: `pull(env, cursor: number, limit: number): Promise<{entries: SyncEntry[], cursor: number, more: boolean}>` with `SyncEntry = {seq, kind:'message', messageKind, body, receivedAt, deviceId} | {seq, kind:'clip', clipId, eventId, sha256, sizeBytes}`; `conflicts(env, cursor, limit)` paging `messages WHERE status='conflict'` by rowid-ordered `received_at`.
- Routes: `GET /v1/sync?cursor=&limit=` (default 100, max 500, 400 on non-integer), `GET /v1/conflicts?cursor=&limit=`.

- [ ] **Step 1: Write failing tests**: `entries come back in seq order with the cursor at the last seq`; `limit 2 returns more:true and the next page continues`; `the caller's own messages are included`; `a clip entry appears after upload, after its capture entry`; `conflict reviews are not in /v1/sync but are in /v1/conflicts`; `cursor beyond the end returns no entries and the same cursor`.
- [ ] **Step 2: Run; expected FAIL**
- [ ] **Step 3: Implement** with one SQL joining `sync_log` to `messages` and `clips`.
- [ ] **Step 4: Run; expected PASS. Run `npm run dev` once and `curl http://127.0.0.1:8787/v1/health`; expected the health JSON.**
- [ ] **Step 5: Add `.github/workflows/worker-ci.yml`** (Node 20, `npm ci`, `npm run typecheck`, `npm test` in `worker/`, on paths `worker/**` and `contracts/**`).
- [ ] **Step 6: Commit** `feat(worker): cursor sync pull, conflicts listing and CI`

### Task 6: PWA storage v2 and `clockSource`

**Files:**
- Modify: `docs/app/db.js`, `docs/app/records.js`, `docs/app/tests/records.test.mjs`, `docs/app/tests/harness.html`

**Interfaces:**
- `db.js` (`DB_VERSION = 2`): new stores `syncState` (keyPath `key`) and `conflicts` (keyPath `messageId`, index `eventId`). New methods: `listOutbox({states = ['pending'], before = null} = {})` → rows sorted by `createdAt`; `updateOutbox(messageId, patch)`; `deleteOutbox(messageId)`; `markAccepted(kind, messageId, when)` (sets `acceptedAt` on the events or reviews row); `listClipsToUpload()` → `[{clipId, eventId, messageId, blob, sha256, sizeBytes}]` for local clips with accepted capture and null `uploadedAt`; `markUploaded(clipId, when)`; `applyRemote(entries, cursor)` (one transaction: puts events/reviews idempotently, moves colliding local review to `conflicts`, remote tombstone deletes the clip row, clip entries create `{clipId, eventId, origin:'remote', blob:null, size, sha256, remoteAvailable:true}` stubs when no row exists, then writes `syncState.cursor`); `listClipStubs(limit)`; `storeRemoteClip(clipId, blob)`; `getSyncState()` → `{cursor, lastSyncAt, lastError}`; `setSyncState(patch)`; `listConflicts(eventId?)`; `deleteConflict(messageId)`; `counts()` → `{needsReview, local, queued, synced, failed}` is computed in `sync.js` from lists, not here.
- `meta` gains `syncUrl, deviceId, deviceToken, deviceLabel` (all default null). `clearAll()` keeps `meta` and `syncState` but sets `cursor` to 0.
- `records.js`: `buildCapture` payload gains `clockSource: 'phone'`; new `syncBadge({event, outboxRows, clip, paired})` → `'Saved on this phone' | 'Queued' | 'Synced' | 'Sync failed'` per the spec table; `isRemote(event, installId)`.

- [ ] **Step 1: Write failing Node tests** in `records.test.mjs`: `buildCapture sets clockSource phone`; `syncBadge` cases: not paired → Saved on this phone; paired with a pending outbox row → Queued; accepted and uploaded → Synced; remote event → Synced; a failed/conflict row → Sync failed; paired but capture never attempted (acceptedAt null, no outbox row because it is from before pairing? no: outbox rows always exist) → Queued.
- [ ] **Step 2: Run `node --test docs/app/tests/records.test.mjs`; expected FAIL**
- [ ] **Step 3: Implement records.js changes**
- [ ] **Step 4: Run; expected PASS**
- [ ] **Step 5: Add harness checks** in `tests/harness.html` group "sync storage": v1 → v2 upgrade keeps rows (open a v1 db by writing with the old upgrade shape under a temp name is impractical; instead assert the stores exist and `getMeta` returns null sync fields), `applyRemote` idempotent re-apply, review collision lands in `conflicts`, remote tombstone deletes the clip row, cursor written only with the page, `storeRemoteClip` then `getClip`, `clearAll` keeps the token and resets the cursor.
- [ ] **Step 6: Implement db.js v2**
- [ ] **Step 7: Serve `docs/` with `python -m http.server 8080` and open `http://localhost:8080/app/tests/harness.html` in the built-in browser; expected every group ends with ALL PASS.**
- [ ] **Step 8: Commit** `feat(pwa): IndexedDB v2 sync stores and clockSource on captures`

### Task 7: `sync.js` push, upload, pull, download

**Files:**
- Create: `docs/app/sync.js`, `docs/app/tests/sync.test.mjs`

**Interfaces:**
- `export function backoffAt(attempts, now, random = Math.random)` → ms timestamp per the Global Constraints formula.
- `export function createApi({ baseUrl, token, fetchImpl = fetch, timeoutMs = 30000 })` → `{ pair(code, body), pushMessages(items), putClip(clipId, blob), getClip(clipId), pull(cursor, limit), health() }`, each resolving `{ok, status, body}` and rejecting with `Error('network')` on fetch failure or timeout; `pair` is static: `export async function pair({baseUrl, code, sourceId, version, label, fetchImpl})`.
- `export async function runSync(db, api, { now = () => Date.now(), onProgress, canDownload = () => true } = {})` → `{ outcome: 'ok'|'busy'|'offline'|'unauthorized'|'error', pushed, uploaded, pulled, downloaded, failed }`. Serialized by a module-level lock with a rerun flag. On any 401: `db.setMeta({deviceToken: null, deviceId: null})` and outcome `unauthorized`, nothing else changed.
- `export function deriveCounts({events, outbox, clips, installId, paired})` → `{local, queued, synced, failed}`.

- [ ] **Step 1: Write failing tests** with a fake db (in-memory object implementing the Task 6 methods) and a fake fetch:
  - `pushes pending outbox rows in createdAt order, events before reviews, 50 per batch, deletes accepted rows and sets acceptedAt`
  - `duplicate counts as accepted`
  - `revision_conflict moves the review to conflicts and marks the outbox row conflict`
  - `payload_mismatch marks the row failed with the reason`
  - `network failure increments attempts and sets nextAttemptAt within the backoff window, then stops the run`
  - `rows with nextAttemptAt in the future are skipped`
  - `clip mismatch marks the event failed` (409 on PUT → outbox-style failed row for the capture messageId with reason `clip_mismatch`, no retry)
  - `pulls pages until more is false, applying each page before requesting the next; cursor advances only after a page is applied` (db.applyRemote throws on page 2 → cursor stays at page 1's value)
  - `pulled review colliding with a refused local revision goes to conflicts` (delegated to db.applyRemote; assert the entries passed through unchanged)
  - `remote tombstone deletes the local clip` (same delegation; assert the call)
  - `downloads at most 20 clip stubs per run, newest first, verifying sha256 before storing; a hash mismatch is skipped and reported`
  - `401 forgets the token and keeps the outbox`
  - `a second runSync while one runs returns busy and the first run reruns once`
- [ ] **Step 2: Run `node --test docs/app/tests/sync.test.mjs`; expected FAIL**
- [ ] **Step 3: Implement `sync.js`**. SHA-256 of a Blob via `crypto.subtle.digest` on `await blob.arrayBuffer()`; hex compare with the capture payload.
- [ ] **Step 4: Run all PWA tests `node --test docs/app/tests/*.test.mjs`; expected PASS**
- [ ] **Step 5: Commit** `feat(pwa): sync module with outbox push, clip upload, cursor pull and clip download`

### Task 8: PWA UI: pairing, states, triggers, version bump

**Files:**
- Modify: `docs/app/app.js`, `docs/app/index.html` (nothing structural; Settings is rendered by JS), `docs/app/app.css` (badge styles for Queued/Synced/failed, a `.sync-row`), `docs/app/sw.js` (precache `./sync.js`, `APP_VERSION = '0.2.0'`), `docs/app/version.js` (`0.2.0`), `docs/app/tests/version.test.mjs` unchanged

**Interfaces:**
- `app.js` state gains `sync: { running: false, last: null }` and `paired()` helper reading `state.meta.deviceToken`.
- Settings "Cloud sync" card per spec; actions `pair`, `sync-now`, `unpair`, `retry-failed` (sets `failed`/`conflict` outbox rows back to `pending` with `attempts: 0` except `clip_mismatch`, which stays until the clip is deleted).
- `scheduleSync(reason)` debounced 2 s; called after `saveClip`, `saveReviewAction`, `undoAction`, `deleteClipAction`, `init`, `visibilitychange` visible, `online`.
- `eventRow` badge uses `syncBadge`; Review header uses `isRemote` and clip stub state; Review screen shows the conflicts banner with "Save again" (rebases: `previous = latestReview(synced reviews)`, fields from the conflict doc, then `appendReview`, then `db.deleteConflict`).
- Today shows the four counts and "Syncing to <host>" when paired.

- [ ] **Step 1: Implement the UI** (no new Node tests; `app.js` is DOM code). Keep every new string from the Global Constraints list.
- [ ] **Step 2: Run `node --test docs/app/tests/*.test.mjs`; expected PASS (version test included)**
- [ ] **Step 3: Manual desktop pass in the built-in browser** against `wrangler dev` (Task 9 covers the full two-origin walk-through): pair, see "Paired", Sync now with an empty outbox returns without error, unpair shows "Not paired".
- [ ] **Step 4: Commit** `feat(pwa): cloud sync settings, Queued/Synced states and sync triggers`

### Task 9: Two-origin end-to-end verification, docs, PR

**Files:**
- Modify: `docs/app/README.md` (sync section, states table, limits, test commands, two-origin test), `docs/PROJECT_PLAN.md` (progress list: Worker sync implemented locally, not deployed; local-service cloud client, episodes, analysis still unchecked), `README.md` (Worker paragraph), `docs/CODEX_HANDOFF.md` (next task), `contracts/README.md` (one line: the PWA now sets `clockSource: "phone"`)

- [ ] **Step 1: Run the full local stack**: `worker/`: `npm run db:migrate:local` then `npm run dev` (background); repo root: `python -m http.server 8080 --directory docs` (background). Mint two codes with `scripts/pairing-code.mjs`.
- [ ] **Step 2: In the built-in browser**, open `http://localhost:8080/app/` and `http://127.0.0.1:8080/app/` as two devices. Pair each. On the first, create a capture: if no microphone, run in the console the harness-style helper (import `db.js`, `records.js`, `wav.js`, build a 1 s 16 kHz tone WAV, `saveCapture`), then Sync now. On the second, Sync now; expected: the event is listed as Synced, "Recorded on <label>", audio plays. Save a review on the second; Sync now on both; expected the first shows "Reviewed · <context>" and revision 2 on edit. Delete the clip on the first; sync both; expected the second hides it and its clip row is gone. Record outcomes.
- [ ] **Step 3: Run every test suite and record exact output**: `cd worker && npm test && npm run typecheck`; `node --test docs/app/tests/*.test.mjs`; `py -3 -m unittest discover -s local-service/tests -v`; harness in the browser.
- [ ] **Step 4: Update docs** listed above.
- [ ] **Step 5: Commit** `docs: cloud sync status, PWA sync section and worker handoff`
- [ ] **Step 6: Push `claude/cloud-sync`, open the PR to `main`** with motivation, files, exact tests run, the two-origin walk-through, limitations (not deployed; no real device; placeholder ids; no retention; episode/analysis relay only), rollback (revert PR; IndexedDB v2 stores are additive; D1 not created), and the owner-only deploy commands.
