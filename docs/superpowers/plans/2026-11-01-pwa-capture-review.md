# PWA capture and review (local-only slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installable phone web app under `docs/app/` that records clips of up to 30 seconds, stores them with owner reviews in IndexedDB as `event.v1`/`review.v1` records, and exports them to the laptop.

**Architecture:** Plain ES modules with no build step, served by the existing GitHub Pages workflow. Pure modules (`wav.js`, `records.js`, `export.js`, `schema-check.js`) carry all data-shaping logic and are unit-tested with Node's built-in runner; browser-only modules (`db.js`, `recorder.js`, `app.js`, `sw.js`) are thin and verified in a browser harness plus a manual iPhone checklist.

**Tech Stack:** HTML/CSS/ES2022 modules, Web Audio `AudioWorklet`, IndexedDB, Web Share API, Service Worker, `node --test` (Node 20+).

**Spec:** `docs/superpowers/specs/2026-11-01-pwa-capture-review-design.md`

## Global Constraints

- No build step, no npm dependencies, no runtime network calls except loading the shell from `docs/app/`.
- Recording: soft cue at 20 s, hard auto-stop at 30 s. Clips shorter than 300 ms are discarded with the message "Too short to save".
- Audio stored at native sample rate as mono PCM16 WAV; no browser resampling. `captureVersion: "pwa-pcm16-native-v1"`, `encoding: "pcm16-wav"`, `channels: 1`. `sha256` is over the WAV file bytes.
- Records conform to `contracts/event.v1.schema.json` and `contracts/review-v1.schema.json`. `messageId` ≠ `eventId`. `reviewId` stable per event. Nothing is edited in place; delete and undo append.
- Wording: use "Saved on this phone", "Needs review", "Reviewed", "Recorded by you", "Recording was cut short". Never "Synced", "Queued", "Detected", "Analyzed", "Meow detected", or confidence wording.
- Storage limits: warn at 100 clips or 300 MB; block Record at 200 clips or 600 MB. Export chunk size 20 clips.
- Accessibility: 44 px minimum targets, visible focus, every control labeled, status badges carry words, `prefers-reduced-motion` turns the level meter into a numeric level, a live region announces save success/failure.
- App version `0.1.0`, protocol version `1`, both in `version.js`, Settings and export bundles. Service-worker cache name embeds the app version.
- Repository rules: feature branch `claude/pwa-capture-review`, PR to `main`, every test command actually run, unrun checks stated in the PR.

## Review Focus

1. Microphone permission denied or no device: the recording sheet must show "Microphone access is needed to record" with a Retry control and never leave a half-open AudioContext. Test added to Task 6.
2. IndexedDB write fails after Stop: the clip stays in memory, the sheet shows "Could not save. Try again." with Retry and Discard, and nothing is shown as saved. Test added to Task 6 (fault injection in the harness).
3. Share sheet cancelled or rejected: `exportedAt` stays null for every event in that export. Test added to Task 3 (pure) and Task 6 (harness).
4. Review opened for an event whose clip was deleted: header shows "Audio deleted", Play is absent, review choices still work. Test added to Task 6.
5. Latest review revision is `deleted: true`: the event counts as Needs review again and the Review screen opens with no pre-selection. Test added to Task 2.

---

## File structure

| Path | Responsibility |
|---|---|
| `docs/app/version.js` | `APP_VERSION`, `PROTOCOL_VERSION` constants |
| `docs/app/wav.js` | pure: frame merge, Float32→PCM16 with clip count, WAV encode, SHA-256 hex |
| `docs/app/records.js` | pure: enums, capture/tombstone/review/draft builders, review-thread helpers, storage limits |
| `docs/app/schema-check.js` | pure: minimal JSON-Schema subset checker used by tests |
| `docs/app/export.js` | pure selection/bundle/chunk + browser share/download |
| `docs/app/db.js` | IndexedDB open, transactions, queries |
| `docs/app/recorder.js`, `docs/app/recorder-worklet.js` | microphone capture, level, visibility stop |
| `docs/app/app.js`, `docs/app/index.html`, `docs/app/app.css` | screens, routing, state |
| `docs/app/sw.js`, `docs/app/manifest.webmanifest` | shell cache, update prompt, install |
| `docs/app/tests/*.test.mjs` | Node tests for pure modules |
| `docs/app/tests/harness.html` | browser harness for `db.js`, `export.js` browser part, fault injection |
| `docs/app/README.md` | export format, manual checklist, limits |
| `.github/workflows/pwa-ci.yml` | `node --test docs/app/tests` on PRs/pushes touching `docs/app/**` |

---

### Task 1: Branch, scaffold, CI and WAV encoding

**Files:**
- Create: `docs/app/version.js`, `docs/app/wav.js`, `docs/app/tests/wav.test.mjs`, `.github/workflows/pwa-ci.yml`

**Interfaces:**
- Produces: `APP_VERSION = '0.1.0'`, `PROTOCOL_VERSION = 1`; `mergeFrames(frames: Float32Array[]): Float32Array`; `floatToPcm16(samples: Float32Array): {pcm: Int16Array, clipped: number}`; `encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array`; `sha256Hex(bytes: Uint8Array): Promise<string>` (uses `globalThis.crypto.subtle`).

- [ ] **Step 1: Create the branch from updated main**

```bash
git switch main && git pull --ff-only && git switch -c claude/pwa-capture-review
```

- [ ] **Step 2: Write the failing tests** in `docs/app/tests/wav.test.mjs`

```js
import test from 'node:test'; import assert from 'node:assert/strict';
import { mergeFrames, floatToPcm16, encodeWav, sha256Hex } from '../wav.js';
test('mergeFrames concatenates in order', () => {
  const out = mergeFrames([new Float32Array([0.1, 0.2]), new Float32Array([0.3])]);
  assert.deepEqual(Array.from(out), [new Float32Array([0.1])[0], new Float32Array([0.2])[0], new Float32Array([0.3])[0]]);
});
test('floatToPcm16 scales, clamps and counts clipped samples', () => {
  const { pcm, clipped } = floatToPcm16(new Float32Array([0, 0.5, 1.5, -2, -1]));
  assert.deepEqual(Array.from(pcm), [0, 16384, 32767, -32768, -32768]);
  assert.equal(clipped, 2);
});
test('encodeWav writes a 44-byte PCM16 mono header with correct sizes', () => {
  const bytes = encodeWav(new Int16Array([1, -1, 2]), 48000);
  const dv = new DataView(bytes.buffer);
  assert.equal(bytes.length, 50);
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  assert.equal(dv.getUint32(4, true), 42);
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), 'WAVE');
  assert.equal(dv.getUint16(20, true), 1);      // PCM
  assert.equal(dv.getUint16(22, true), 1);      // mono
  assert.equal(dv.getUint32(24, true), 48000);  // sample rate
  assert.equal(dv.getUint32(28, true), 96000);  // byte rate
  assert.equal(dv.getUint16(32, true), 2);      // block align
  assert.equal(dv.getUint16(34, true), 16);     // bits
  assert.equal(dv.getUint32(40, true), 6);      // data size
  assert.equal(dv.getInt16(44, true), 1);
});
test('sha256Hex matches a known vector', async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --test docs/app/tests/`
Expected: FAIL, cannot find module `../wav.js`

- [ ] **Step 4: Implement `version.js` and `wav.js`**

`floatToPcm16`: multiply by 32768, clamp to [-32768, 32767], count samples whose input was outside [-1, 1]. `encodeWav`: little-endian RIFF/WAVE/fmt /data as asserted.

- [ ] **Step 5: Run tests, expect PASS**

Run: `node --test docs/app/tests/`

- [ ] **Step 6: Add CI workflow** `.github/workflows/pwa-ci.yml`: trigger on `push` and `pull_request` with paths `docs/app/**` and the workflow file; `ubuntu-latest`, `actions/setup-node@v4` with `node-version: 20`, run `node --test docs/app/tests/`.

- [ ] **Step 7: Commit**

```bash
git add docs/app .github/workflows/pwa-ci.yml
git commit -m "feat(pwa): scaffold app directory, WAV encoder and Node test CI"
```

---

### Task 2: Record builders and schema checker

**Files:**
- Create: `docs/app/records.js`, `docs/app/schema-check.js`, `docs/app/tests/records.test.mjs`, `docs/app/tests/schema-check.test.mjs`

**Interfaces:**
- Consumes: nothing from Task 1 except `PROTOCOL_VERSION`.
- Produces in `records.js`:
  - `CONTEXTS`, `LOCATIONS`, `BEHAVIORS`, `OUTCOMES`: arrays of `{value, label}` where `value` is the schema enum string and `label` the v5 display word (e.g. `{value:'living-room', label:'Living room'}`, `{value:'looking-at-owner', label:'Looking at me'}`, `{value:'door-opened', label:'Opened door'}`).
  - `LIMITS = {softCueMs: 20000, maxMs: 30000, minMs: 300, warnClips: 100, warnBytes: 300e6, blockClips: 200, blockBytes: 600e6, exportChunk: 20}`.
  - `buildCapture({installId, clipId, sampleRate, durationMs, sizeBytes, sha256, clippedSamples, recordedAt, interrupted, uuid, now}): EventEnvelope` with `type:'capture'`, `sourceId: installId`, `payload` fields per spec plus `encoding`, `channels`, `captureVersion`, `sourceKind:'pwa-manual'`.
  - `buildTombstone({installId, eventId, clipId, supersedesMessageId, uuid, now}): EventEnvelope` with `payload: {deleted:true, clipId, supersedesMessageId}`.
  - `buildReview({eventId, reviewId, previous, fields, uuid, now}): ReviewDoc` where `previous` is the latest review doc or null; sets `revision`, `baseRevision`, `source:'pwa'`, copies `context`, optional `location`/`observedBehavior`/`outcome`/`note` only when present, `deleted` only when `fields.deleted === true`.
  - `latestReview(reviews: ReviewDoc[]): ReviewDoc|null` (highest revision), `needsReview(reviews): boolean` (true when none or latest `deleted`), `storageState({clips, bytes}): 'ok'|'warn'|'blocked'`.
- Produces in `schema-check.js`: `checkSchema(doc, schema): string[]` returning human-readable violations for `required`, `const`, `enum`, `type` (string/integer/boolean/object/array/null unions), `additionalProperties: false`, `minLength`, `maxLength`, `minimum`, and `format: 'uuid'` (regex). Empty array means valid.

- [ ] **Step 1: Write failing schema-check tests** in `schema-check.test.mjs`: valid doc returns `[]`; missing required field named; wrong enum value named; extra property rejected when `additionalProperties:false`; `format: uuid` rejects `'not-a-uuid'`; `type: ['integer','null']` accepts both.

- [ ] **Step 2: Run, expect FAIL (module missing)**

- [ ] **Step 3: Implement `schema-check.js`**, then run tests, expect PASS.

- [ ] **Step 4: Write failing records tests** in `records.test.mjs`, loading both contract schemas with `fs.readFileSync` relative to the test file (`../../../contracts/...`):

```js
const fixedUuid = () => '11111111-1111-4111-8111-111111111111';
const now = () => '2026-11-01T12:00:00.000Z';
test('buildCapture conforms to event.v1 and separates messageId from eventId', () => {
  let n = 0; const uuid = () => `0000000${++n}-0000-4000-8000-000000000000`;
  const env = buildCapture({installId:'pwa-abc', clipId:'c1', sampleRate:48000, durationMs:1200, sizeBytes:115244, sha256:'ab'.repeat(32), clippedSamples:0, recordedAt:now(), interrupted:false, uuid, now});
  assert.deepEqual(checkSchema(env, eventSchema), []);
  assert.notEqual(env.messageId, env.eventId);
  assert.equal(env.type, 'capture'); assert.equal(env.sourceId, 'pwa-abc');
  assert.equal(env.payload.captureVersion, 'pwa-pcm16-native-v1');
  assert.equal(env.payload.encoding, 'pcm16-wav'); assert.equal(env.payload.channels, 1);
});
test('buildTombstone reuses eventId with a new messageId', ...);  // checkSchema [] ; payload.deleted true ; supersedesMessageId set
test('buildReview first revision', () => { /* revision 1, baseRevision null, reviewId as given, checkSchema [] */ });
test('buildReview next revision keeps reviewId, new messageId, baseRevision = previous.revision', ...);
test('buildReview omits optional fields that are empty and rejects nothing silently', () => { /* no location key when fields.location undefined */ });
test('buildReview note longer than 500 chars throws', ...);
test('latestReview picks highest revision; needsReview true when latest deleted', ...);
test('storageState thresholds', () => {
  assert.equal(storageState({clips:99, bytes:0}), 'ok');
  assert.equal(storageState({clips:100, bytes:0}), 'warn');
  assert.equal(storageState({clips:0, bytes:300e6}), 'warn');
  assert.equal(storageState({clips:200, bytes:0}), 'blocked');
  assert.equal(storageState({clips:0, bytes:600e6}), 'blocked');
});
test('every CONTEXTS/LOCATIONS/BEHAVIORS/OUTCOMES value is in the review schema enum', ...);
```

- [ ] **Step 5: Run, expect FAIL**

- [ ] **Step 6: Implement `records.js`**, run tests, expect PASS.

- [ ] **Step 7: Commit**

```bash
git add docs/app/records.js docs/app/schema-check.js docs/app/tests
git commit -m "feat(pwa): event/review record builders validated against v1 contracts"
```

---

### Task 3: Export selection, bundle and chunking (pure)

**Files:**
- Create: `docs/app/export.js`, `docs/app/tests/export.test.mjs`

**Interfaces:**
- Consumes: `latestReview`, `needsReview`, `LIMITS.exportChunk` from Task 2; `APP_VERSION`, `PROTOCOL_VERSION`.
- Produces (pure): `selectEvents(rows: StoredEvent[], reviewsByEvent: Map<string, ReviewDoc[]>, mode: 'new'|'unreviewed'|'all'): StoredEvent[]` where `StoredEvent = {envelope, exportedAt: string|null}` and only non-deleted captures (no tombstone for that `eventId`) are candidates; `buildBundle({installId, events: StoredEvent[], tombstones: EventEnvelope[], reviewsByEvent, now}): Bundle` with `exportVersion: 1`, `appVersion`, `protocolVersion`, `events` (clean envelopes, including tombstones for selected eventIds), `reviews` (full history), `clips` manifest `[{clipId, eventId, filename: eventId + '.wav', sha256, sizeBytes, sampleRate, durationMs}]`; `bundleFilename(now): string` = `siri-tiri-export-<YYYYMMDDTHHMMSSZ>.json`; `chunkClips(manifest, size = LIMITS.exportChunk): Array<Array>`.
- Produces (browser, implemented in Task 6, exported from the same file): `shareFiles(files: File[]): Promise<'shared'|'downloaded'>` which uses `navigator.share` when `navigator.canShare({files})` else creates download anchors; throws on cancel/rejection.

- [ ] **Step 1: Write failing tests**: `'new'` excludes events with `exportedAt`; `'unreviewed'` uses `needsReview`; `'all'` includes everything non-deleted; deleted events never selected but their tombstone appears in `bundle.events` when their eventId is selected via an earlier export mode (i.e. `tombstones` filter by selected eventIds); bundle has `exportVersion 1`, versions, manifest filename `<eventId>.wav`; `chunkClips` splits 45 items into 20/20/5; `bundleFilename(() => '2026-11-01T12:34:56.000Z')` equals `siri-tiri-export-20261101T123456Z.json`.

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement the pure functions** in `export.js`; leave `shareFiles` as a stub that throws `'not implemented'` so Node import stays clean (guard any `navigator` access inside the function body).

- [ ] **Step 4: Run tests, expect PASS; commit**

```bash
git add docs/app/export.js docs/app/tests/export.test.mjs
git commit -m "feat(pwa): export selection, bundle and chunking"
```

---

### Task 4: IndexedDB layer and browser harness

**Files:**
- Create: `docs/app/db.js`, `docs/app/tests/harness.html`

**Interfaces:**
- Consumes: builders from Task 2.
- Produces `db.js` (all async, default export `openDb(name = 'siri-tiri'): Promise<Db>`), where `Db` has:
  - `getMeta(): Promise<{installId, schemaVersion, persistGranted, appVersionAtLastRun}>` (creates on first run with `installId = 'pwa-' + crypto.randomUUID()`), `setMeta(patch)`.
  - `saveCapture(envelope, wavBlob): Promise<void>` — one transaction over `events`, `clips`, `outbox`.
  - `listEvents(): Promise<StoredEvent[]>` newest first, excluding eventIds that have a tombstone; `getEvent(eventId)`; `getClip(clipId): Promise<Blob|null>`.
  - `listReviews(eventId): Promise<ReviewDoc[]>`, `allReviews(): Promise<Map<string, ReviewDoc[]>>`.
  - `saveReview(doc): Promise<void>` — transaction over `reviews`, `outbox`, `drafts` (deletes draft).
  - `getDraft(eventId)`, `putDraft(eventId, fields)`.
  - `deleteClip({tombstone, reviewTombstone|null}): Promise<void>` — removes `clips` row, appends messages and outbox rows in one transaction.
  - `markExported(eventIds: string[], when: string)`.
  - `usage(): Promise<{clips: number, bytes: number}>`.
  - `clearAll(): Promise<void>` preserving `installId`.
- Stores and indexes exactly as the spec's Data model section: `events` keyed `messageId` with indexes `eventId`, `createdAt`; `clips` keyed `clipId`; `reviews` keyed `messageId` with indexes `eventId`, `[eventId+revision]` (store as `eventRevision` compound key array); `drafts` keyed `eventId`; `outbox` keyed `messageId`; `meta` keyed `key`.

- [ ] **Step 1: Write the harness** `docs/app/tests/harness.html`: a page that imports `db.js` and `records.js`, opens a throwaway database name (`'siri-tiri-harness-' + Date.now()`), and runs named checks writing PASS/FAIL lines into a `<pre id="out">`: meta created with `pwa-` prefix; `saveCapture` then `listEvents` returns 1 and `getClip` returns a Blob of the same size; `saveReview` twice yields revisions 1 and 2 with same `reviewId`; `putDraft`/`getDraft`/draft removed after `saveReview`; `deleteClip` hides the event from `listEvents` and `getClip` returns null; `markExported` sets `exportedAt`; `usage` counts; `clearAll` keeps `installId`; a fault-injection check that wraps `IDBObjectStore.prototype.put` to throw once and asserts `saveCapture` rejects and `listEvents` is unchanged. Delete the throwaway database at the end.

- [ ] **Step 2: Serve and open the harness, confirm every check FAILS with module missing**

Run (PowerShell, from repo root): `py -3 -m http.server 8080 --directory docs` then open `http://127.0.0.1:8080/app/tests/harness.html` in the built-in browser.

- [ ] **Step 3: Implement `db.js`**

- [ ] **Step 4: Reload harness, expect all PASS**

- [ ] **Step 5: Commit**

```bash
git add docs/app/db.js docs/app/tests/harness.html
git commit -m "feat(pwa): IndexedDB store with append-only events, reviews, drafts and outbox"
```

---

### Task 5: Microphone recorder

**Files:**
- Create: `docs/app/recorder.js`, `docs/app/recorder-worklet.js`

**Interfaces:**
- Consumes: `LIMITS` from Task 2, `mergeFrames`/`floatToPcm16`/`encodeWav`/`sha256Hex` from Task 1.
- Produces `class Recorder` with `static async requestPermission(): Promise<MediaStream>` (constraints: `{audio: {channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false}}`); `constructor({onLevel: (rms: number) => void, onTick: (elapsedMs) => void, onAutoStop: () => void})`; `async start(stream): Promise<void>` creating the `AudioContext` and `AudioWorkletNode('pcm-capture')` from `recorder-worklet.js`, wiring `visibilitychange` → `stop({interrupted: true})` and a 30 s timer → `onAutoStop` then `stop()`; `async stop({interrupted = false} = {}): Promise<Clip>` where `Clip = {wavBytes: Uint8Array, blob: Blob (type 'audio/wav'), sampleRate, durationMs, sizeBytes, sha256, clippedSamples, interrupted}`; `stop` tears down tracks, node and context every time, including on error. Throws `Error('too_short')` when `durationMs < LIMITS.minMs`.
- `recorder-worklet.js`: `AudioWorkletProcessor` registered as `'pcm-capture'` that posts a copy of `inputs[0][0]` per `process` call.

- [ ] **Step 1: Add a manual check to the harness**: a "Record 2 s" button (user gesture) that calls `requestPermission`, `start`, waits 2000 ms, `stop`, then prints `sampleRate`, `durationMs` within ±150 ms of 2000, `sizeBytes === 44 + 2 * round(sampleRate * durationMs / 1000)` within one frame block, `sha256Hex(wavBytes) === clip.sha256`, and that `AudioContext` state is `closed` afterwards. A second button "Record then hide" starts, then calls `document.dispatchEvent(new Event('visibilitychange'))` with `document.hidden` stubbed true via `Object.defineProperty`, and prints `interrupted === true`. A third button "Stop at 100 ms" expects `too_short`.

- [ ] **Step 2: Implement `recorder.js` and `recorder-worklet.js`**

- [ ] **Step 3: Run the harness in desktop Chrome with a microphone (the built-in browser if it grants mic access; otherwise the user's Chrome), record results in the PR**

- [ ] **Step 4: Commit**

```bash
git add docs/app/recorder.js docs/app/recorder-worklet.js docs/app/tests/harness.html
git commit -m "feat(pwa): AudioWorklet recorder with 30 s cap and visibility stop"
```

---

### Task 6: Screens and application flow

**Files:**
- Create: `docs/app/index.html`, `docs/app/app.css`, `docs/app/app.js`
- Modify: `docs/app/export.js` (implement `shareFiles`)

**Interfaces:**
- Consumes everything above.
- Produces: hash routes `#today` (default), `#events`, `#review/<eventId>`, `#settings`; recording sheet as a `<dialog>`; a `<div role="status" aria-live="polite" id="live">` for announcements. Exported pure helpers `formatDuration(ms): string`, `eventBadge(storedEvent, reviews): string`, `undoFields(previous: ReviewDoc|null, saved: ReviewDoc): object`, and `runExport(db, mode): Promise<'shared'|'downloaded'>` which selects, builds, shares, and only then calls `db.markExported`.

Screen behavior to implement, exactly per the spec's Screens section:

- **Today**: avatar `../assets/cat-tiri-avatar.png` + "Tiri"; Record button (disabled with text "Storage full. Export or delete clips to record." when `storageState === 'blocked'`); counts of clips needing review; latest needs-review card with Review; line "All recordings stay on this phone"; install banner when `!matchMedia('(display-mode: standalone)').matches` with the spec's exact copy; "Export and clear" prompt when `storageState === 'warn'`; "Update ready" row when the SW reports a waiting worker (Task 7).
- **Recording sheet**: elapsed `m:ss`, level meter (`<meter>` element; under reduced motion show numeric dB-ish level text only), Stop button; soft cue text "20 s — wrap up soon" at 20 s; on `onAutoStop` show "Stopped at 30 s". On stop: build `Clip` → `buildCapture` → `db.saveCapture` → navigate to `#review/<eventId>`; on save error show "Could not save. Try again." with Retry (re-run save with same clip) and Discard; on `too_short` show "Too short to save" and return to Today; on permission error show "Microphone access is needed to record" with Retry.
- **Review**: header "Recorded by you", local date/time, duration, "Recording was cut short" when `interrupted`; "Audio deleted" and no Play when `getClip` is null; Play via `<audio controls>` over `URL.createObjectURL(blob)`, revoked on leave; four sections with the v5 titles ("What was happening?", "Where was Tiri?", "Observed behavior", "Outcome") rendering buttons from the Task 2 enums with `aria-pressed`; note `<textarea maxlength="500">`; every change → `putDraft`; Save review → `buildReview` → `saveReview` → announce "Saved on this phone" and show Undo for 6 s; Undo appends a `deleted: true` revision when the saved one was revision 1, otherwise a revision copying the previous fields; Later → `#events`; Delete clip (secondary, confirm dialog) → `deleteClip`.
- **Events**: newest first; row shows date/time, duration, badge "Needs review" or "Reviewed · <context label>", button Review/Edit; filter chips All / Needs review / Reviewed as `role="radiogroup"`.
- **Settings**: `APP_VERSION`, `PROTOCOL_VERSION`; usage; persistent-storage row (call `navigator.storage?.persist?.()`; show "Not available on this browser" when missing; button "Keep my data" when available and not granted); Export new / Export unreviewed / Export all; Delete exported clips; Delete everything behind an `<input>` that must equal `DELETE`; install hint when not standalone; Update row.
- `shareFiles` in `export.js`: build `File` objects (bundle JSON as `application/json`, WAVs as `audio/wav`), chunk by `LIMITS.exportChunk` with the bundle in the first chunk, `await navigator.share({files})` per chunk when `navigator.canShare?.({files})`, else append and click temporary `<a download>` anchors; resolve `'shared'|'downloaded'`; any throw propagates and the caller does **not** call `markExported`.

- [ ] **Step 1: Extend the harness with flow checks that import `app.js` helpers** (`app.js` must export `formatDuration(ms)`, `eventBadge(storedEvent, reviews)`, `undoFields(previous, saved)` as pure functions): `formatDuration(1200) === '0:01'`, `formatDuration(29500) === '0:29'`; `eventBadge` returns `'Needs review'` with no reviews and after a deleted latest revision, `'Reviewed · Food'` for context `food`; `undoFields(null, rev1)` returns `{deleted: true}` and `undoFields(rev1, rev2)` returns rev1's fields. Add fault-injection checks: stub `navigator.share` to reject → assert `exportedAt` remains null for the harness event after calling the exported `runExport(db, 'all')`.

- [ ] **Step 2: Run harness, expect new checks FAIL**

- [ ] **Step 3: Implement `index.html`, `app.css`, `app.js`, and `shareFiles`**

Layout: `<main>` with the four screens as `<section hidden>` toggled by route; bottom `<nav>` with three tab buttons (Today, Events, Settings) using `aria-current`; body uses `env(safe-area-inset-*)` padding; colors from the v5 phone palette (`#fbfaf7` background, `#225c50` primary, `#213334` text); all buttons `min-height: 44px`.

- [ ] **Step 4: Run harness, expect PASS; run a desktop walk-through in the built-in browser at mobile viewport**: record (if mic available), review, save, undo, edit, events filter, settings export via download fallback. Note what could not be exercised.

- [ ] **Step 5: Commit**

```bash
git add docs/app
git commit -m "feat(pwa): Today, Recording, Review, Events and Settings screens"
```

---

### Task 7: Service worker, manifest, install and update flow

**Files:**
- Create: `docs/app/sw.js`, `docs/app/manifest.webmanifest`
- Modify: `docs/app/index.html` (manifest link, theme-color, apple-mobile-web-app meta, SW registration), `docs/app/app.js` (update row)
- Modify: `docs/sw.js` only if Step 3 shows the mockup worker intercepting `app/` navigations

**Interfaces:**
- `sw.js`: `CACHE = 'siri-tiri-app-' + APP_VERSION` (import `version.js` via `importScripts` is unavailable for modules; instead the SW reads the version from a `?v=` query on its registration URL that `index.html` sets from `version.js`); precache `./`, `./index.html`, `./app.css`, `./app.js`, `./db.js`, `./records.js`, `./wav.js`, `./export.js`, `./recorder.js`, `./recorder-worklet.js`, `./version.js`, `./manifest.webmanifest`, `../assets/cat-tiri-avatar.png`; cache-first for same-scope GETs, navigation falls back to `./index.html`; on `activate` delete other `siri-tiri-app-*` caches; **no** `skipWaiting` on install; listen for `{type: 'SKIP_WAITING'}` message.
- `manifest.webmanifest`: `id: './'`, `name: 'Siri-Tiri Recorder'`, `short_name: 'Siri-Tiri'`, `start_url: './'`, `scope: './'`, `display: 'standalone'`, `orientation: 'portrait'`, `background_color: '#fbfaf7'`, `theme_color: '#225c50'`, icon `../assets/cat-tiri-avatar.png` 256×256.
- `app.js`: register `./sw.js?v=<APP_VERSION>` with `{scope: './'}`; on `registration.waiting` or `updatefound`→`installed`, set `updateReady = true` and render the Update row; the row's button posts `SKIP_WAITING` and reloads on `controllerchange`, and is disabled while the recording sheet is open.

- [ ] **Step 1: Implement `sw.js`, `manifest.webmanifest`, and the registration/update code**

- [ ] **Step 2: Verify offline in the built-in browser**: load `http://127.0.0.1:8080/app/` twice, stop the server, reload, expect the app shell still renders. Restart server.

- [ ] **Step 3: Verify scope isolation**: open `http://127.0.0.1:8080/companion-app-design.html` first (registers the mockup worker at scope `/`), then open `http://127.0.0.1:8080/app/` in a fresh tab; in DevTools Application → Service Workers confirm the `/app/` client is controlled by `/app/sw.js`. If the mockup worker serves `companion-app-design.html` for `/app/` when offline, change `docs/sw.js` navigate handler to ignore requests whose path starts with `/app/` (one-line `return` guard) and commit that with a note.

- [ ] **Step 4: Verify update prompt**: bump `APP_VERSION` locally to `0.1.1`, reload, expect the Update row; click it, expect reload onto the new cache; revert the version bump before committing.

- [ ] **Step 5: Commit**

```bash
git add docs/app/sw.js docs/app/manifest.webmanifest docs/app/index.html docs/app/app.js docs/sw.js
git commit -m "feat(pwa): installable shell with versioned cache and explicit update"
```

---

### Task 8: Documentation, Pages link, PR

**Files:**
- Create: `docs/app/README.md`
- Modify: `README.md`, `docs/index.html`, `docs/UI_HANDOFF.md`, `docs/PROJECT_PLAN.md`, `docs/CODEX_HANDOFF.md`, `docs/superpowers/specs/2026-11-01-pwa-capture-review-design.md` (status line)

- [ ] **Step 1: Write `docs/app/README.md`**: what it is and is not (local-only, no sync, no inference); install steps for iPhone and Android; the export bundle format (field list from Task 3, filename pattern, chunking); limits table (30 s, 300 ms, 100/300 MB warn, 200/600 MB block, 20 per share); the manual iPhone checklist from the spec's Testing section as checkboxes; known gaps (Android untested if so, iOS eviction, `analyze` not run, follow-on local-service importer).

- [ ] **Step 2: Update the other documents**: README gets a "Phone app (local-only)" section with the Pages URL `https://a-tsygankov.github.io/siri-tiri/app/`; `docs/index.html` gets a clearly separated "Working app" link above the mockups; `UI_HANDOFF.md` gets a short section "Implemented PWA slice (November 2026)" listing which handoff states now exist (Saved on this phone, Needs review, Reviewed, Update ready) and which do not (Queued, Synced, Analysis complete); `PROJECT_PLAN.md` progress list gets `- [x] Phone PWA local-only capture and review: ...` and keeps the sync item unchecked; `CODEX_HANDOFF.md` names the next task: local-service bundle importer with versioned 44.1/48 kHz to 16 kHz resampling, then Worker + D1 ingest; spec status line becomes "approved by the user on 2026-11-01; implemented on PR <n>".

- [ ] **Step 3: Run everything once more**

Run: `node --test docs/app/tests/` → all pass. Run: `py -3 -m unittest discover -s local-service/tests` → unchanged (75, 4 skipped). Open the harness → all PASS.

- [ ] **Step 4: Commit and push**

```bash
git add -A && git commit -m "docs(pwa): app README, handoff, plan and Pages link"
git push -u origin claude/pwa-capture-review
```

- [ ] **Step 5: Open the PR** to `main` titled "Add local-only phone PWA for clip capture and owner review", body with Motivation, Changes, Tests executed (exact commands and harness results, desktop walk-through notes), Not run (iPhone manual checklist pending the user's device, Android, `manage.py analyze`), Limitations (from spec anti-goals and the pipeline-compatibility note), Rollback (revert; Pages republishes; phone data is unaffected and remains exportable), and the attribution footer. Then run the iPhone checklist with the user once Pages serves the branch content after merge, or from a local HTTPS tunnel if they prefer to test before merge; record results on the PR.
