# Phone PWA: short-clip capture and owner review (local-only slice)

Status: draft for user approval, 2026-11-01. Written after a brainstorming conversation; the "Decided by the user" items are theirs, everything marked "builder's call" or "author's call" is not.

## Intent and why now

Every remaining milestone (detector thresholds, a Tiri-specific model, device UX validation) is blocked on one fact: there are zero recordings of Tiri. The phone the owner already carries is the fastest way to get them. This slice turns the existing v5 interaction mockup into a working, installable phone web app that records short clips, stores them durably on the phone together with the owner's observation, and can hand the data to the laptop by export. No server, no sync, no model.

It also fixes the shape of the owner-review data path that device-captured events will later flow through. The review screen built here is the one that will classify events from the ESP32 once sync exists.

## Decided by the user

- The ESP32 device will be the thing that catches individual meows. The PWA does not need to catch meows itself; no rolling buffer, no race to press record.
- The PWA has two jobs: **classify** recorded sounds and behavior (now its own recordings, later device events), and **record** deliberately when something is happening.
- No multi-minute recordings. A typical dinner episode has several repeated parts; the owner records one or a few of those parts as a single short clip and reviews the clip as one episode with one review.
- Review vocabulary and flow follow the v5 mockup (`docs/connected-ui-v5.html`) and the architecture baseline: one required context, optional location, observed behavior and outcome, each skippable; Unsure always available.

## Goals

1. Install from the existing GitHub Pages site onto an iPhone (Safari, Add to Home Screen) and onto Android Chrome, and work with the network off after first load.
2. Record a short clip, save it on the phone, and go straight into review. "Saved on this phone" must be literally true before it is shown.
3. Review and later edit any saved clip. Edits are revisions, never overwrites.
4. Export everything (clips plus records) to the laptop in a documented format. Scoring them with the local service needs a small follow-on there (see Pipeline compatibility); this slice only has to produce files that follow-on can consume.
5. Produce records that already conform to `contracts/event.v1.schema.json` and `contracts/review-v1.schema.json`, so the future sync slice adds transport, not a data migration.

## Non-goals (this slice)

- No Cloudflare Worker, local-service LAN API, or any network call other than loading the app shell.
- No YAMNet or any inference in the browser. No "Meow detected" wording for the owner's own recordings; the event type shown is "Recorded by you".
- No device (ESP32) events yet. The list will contain only the owner's recordings until sync exists.
- No multi-minute or background recording. No Trends tab beyond simple counts on Today.
- No local-service changes. Importing the export bundle and resampling phone audio to 16 kHz is the next local-service task, not this PR.
- No accounts or sign-in.

## Anti-goals (would make it a failure even if it "works")

- Showing a state that implies more than is true: "Synced", "Queued", "Analyzed", or a confidence band for the owner's own clip.
- Losing a clip or a review after the app said it was saved, including across app updates, phone restarts, and the owner locking the screen mid-recording.
- Any audio leaving the phone without an explicit export action by the owner.
- Presenting the owner's context choice as something the system inferred.

## Constraints

- Served from `docs/` by the existing Pages workflow (`.github/workflows/pages.yml`), so merging to `main` publishes it. HTTPS is therefore available, which `getUserMedia` and service workers require.
- No build step and no runtime dependencies. Plain ES modules, HTML and CSS, consistent with the rest of `docs/`.
- iOS Safari is the primary target and the harshest: `AudioContext` must be created inside a user gesture, the microphone sample rate cannot be forced (usually 48 kHz, sometimes 44.1 kHz), the tab may be suspended on screen lock, and storage for sites not installed to the home screen can be evicted after seven days of non-use.
- Mobile-first: bottom tabs, 44 pt minimum targets, safe-area insets, readable at default text size, reduced-motion respected, status never conveyed by color alone (see `docs/UI_HANDOFF.md`).
- Repository rules in `AGENTS.md`: feature branch, PR to `main`, tests actually run, limitations stated.

## Where it lives (author's call)

`docs/app/` with its own `index.html`, `manifest.webmanifest`, `sw.js` and ES modules. A separate directory keeps the service-worker scope away from the design mockups, whose shell cache under `docs/` already exists and must not be disturbed. `docs/index.html` gets a link to the app, clearly separated from the mockups.

Suggested files, final split is the builder's call: `index.html`, `app.css`, `app.js` (screens and state), `db.js` (IndexedDB), `recorder.js` (microphone and PCM capture), `wav.js` (WAV encoding, pure), `records.js` (event and review document builders, pure), `export.js`, `sw.js`, `version.js`, plus `tests/` for the pure modules.

## Screens

Four bottom tabs: **Today**, **Events**, **Settings**, and a **Review** screen reached from either of the first two. Trends is deliberately absent in this slice.

**Today.** Tiri avatar and name (reuse `docs/assets/cat-tiri-avatar.png`). A single large **Record** button. Count of clips needing review and a card for the most recent one with a **Review** action. A quiet line "All recordings stay on this phone" under the counts. Nothing about microphone listening state: the app is not listening when idle.

**Recording.** Full-screen sheet: elapsed time, a simple level meter so the owner can see the mic is live, and a large **Stop** button. Soft cue at 20 seconds, automatic stop at 30. The 30-second cap matches the local service's existing per-clip limit (`inference.py` rejects longer WAVs), so no clip recorded here is unusable downstream. On stop the clip and its capture event are written to IndexedDB *first*; only then does the screen move to Review. If the write fails, the owner sees an error with a retry, and the clip is held in memory until retry succeeds or the owner discards it. If the page becomes hidden mid-recording (screen lock, app switch, incoming call, Control Center), the recorder stops immediately on `visibilitychange` and commits whatever was captured as a clip flagged `interrupted: true`. There is no resume: on iOS the audio graph is not reliably alive after the page is hidden, and the clips are short enough that recording again costs little. The Review header shows "Recording was cut short" for such clips.

**Review.** Header shows "Recorded by you", date and time, duration. A **Play** control; playback only on explicit tap. Then the v5 sections in order: **What was happening?** (required: Food, Attention, Play, Door, Greeting, Resting, Handling, Other, Unsure), **Where was Tiri?** (optional), **Observed behavior** (optional), **Outcome** (optional), and an optional free-text note of up to 500 characters. **Save review** is sticky at the bottom; **Later** leaves the clip as "Needs review". Every tap on a choice is written to a draft record immediately, so a crash or update between taps loses nothing. After save, a short confirmation with **Undo** (which writes a further revision restoring the previous one, or marks a first review deleted). Re-opening a reviewed clip shows the latest revision pre-selected and saves a new revision.

**Events.** Newest first. Each row: date and time, duration, status badge **Needs review** or **Reviewed** with the chosen context word, and a Review/Edit action. Filter chips: All, Needs review, Reviewed. Swipe gestures are not used for anything that commits or deletes.

**Settings.** App version and protocol version; storage used and clip count; whether the browser granted persistent storage, with a **Keep my data** button that requests it if not; **Export all** and **Export unreviewed**; **Delete a clip** happens from the Review screen, **Delete everything** here behind a typed confirmation; a short install hint when not running as an installed app; and an **Update** row that shows when a new version is waiting (see Updates).

Wording to use and avoid: use "Saved on this phone", "Needs review", "Reviewed", "Recorded by you". Never use "Synced", "Queued", "Detected", "Analyzed", "Meow detected", or any confidence wording in this slice.

## Audio capture (author's calls)

- `getUserMedia({audio: {channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false}})`, then an `AudioContext` created in the tap handler, and an `AudioWorkletNode` that posts Float32 frames to the main thread. A `ScriptProcessorNode` fallback is acceptable if the builder finds a target browser without worklet support, but is not required.
- Frames are accumulated in memory. At 48 kHz mono, a 30-second clip is about 2.9 MB as PCM16, which is well within phone limits, so chunked streaming to IndexedDB is not needed for this slice.
- **Store the clip at the microphone's native sample rate as 16-bit mono PCM WAV.** Do not resample in the browser. The capture payload records `sampleRate`, `channels: 1`, `encoding: "pcm16-wav"`, `durationMs`, `sizeBytes`, `sha256`, and `captureVersion: "pwa-pcm16-native-v1"`. Reason: the local service already owns versioned resampling (`dataset_prepare.py`), and a second resampler in JavaScript would create a second preprocessing version to track for no gain. Keeping the native rate also preserves the most information from the recording. This supersedes an earlier working assumption of 16 kHz WAV in the browser.
- Float32 to PCM16 conversion clamps to [-1, 1] and counts clipped samples into `clippedSamples` in the payload, mirroring what the dataset tooling reports.
- `sha256` in the payload is the hash of the WAV file bytes exactly as exported, so the local-service tooling can verify the file it receives.

### Pipeline compatibility (author's call after builder review)

The local service today accepts only 16 kHz PCM16 WAV up to 30 seconds and 3 MB, and its versioned resampler handles only 8 kHz to 16 kHz for CatMeows. Phone clips at 44.1 or 48 kHz will therefore not score until the local service gains a versioned 44.1/48 kHz to 16 kHz path and a bundle importer. That is deliberately a separate, small local-service PR after this one, so this slice stays phone-only and the resampling stays in the one place that already versions it. The PR for this slice states the `manage.py analyze` check as not run for that reason. The 30-second cap and the hash-of-file-bytes rule above are what make the follow-on straightforward.
- Level meter is computed from the same frames; nothing is drawn from a second analyser path.

## Data model (author's calls, built on the shared contracts)

IndexedDB database `siri-tiri`, version 1, with these object stores:

- `events`: `event.v1` envelopes keyed by `messageId`, indexed by `eventId` and `createdAt`. `messageId` and `eventId` are distinct UUIDs, matching the contract: `messageId` is the idempotency key of this one message, `eventId` is the correlation key for everything about the clip. The capture message has `type: "capture"`, `sourceId` = this installation's id (see `meta`), and `payload` with `clipId`, the audio fields above, `recordedAt`, `interrupted`, and `sourceKind: "pwa-manual"`. A capture message is never modified after it is written. The stored row additionally carries an app-local `exportedAt` (null until the first export that included it) outside the envelope; exports emit clean envelopes.
- `clips`: `{clipId, blob, sha256, sizeBytes}`. The WAV `Blob` lives here, separate from the record, so an export or a future upload can read it without touching records.
- `reviews`: `review.v1` documents keyed by `messageId`, indexed by `eventId` and `[eventId+revision]`. `reviewId` is stable per event: it is created with revision 1 and reused by every later revision of that event's review, so one event has one review thread. Each save appends a new document with a fresh `messageId`, `revision = previous + 1` and `baseRevision = previous` (null for the first). `source: "pwa"`. The current review is the highest revision. Undo and delete also append revisions; nothing is ever updated in place.
- `drafts`: one mutable draft per `eventId`, written on every tap in Review, deleted when a revision is saved.
- `outbox`: one row per event and review `messageId` with `state: "pending"`, `attempts: 0`. Nothing in this slice ever sends it. It exists so the sync slice finds its backlog waiting rather than reconstructing it. The UI does not surface it, and shows "Saved on this phone", not "Queued".
- `meta`: `installId` (UUID, created on first run, prefixed `pwa-` for `sourceId`), `schemaVersion: 1`, `persistGranted`, `appVersionAtLastRun`.

All writes that must be atomic (clip + event + outbox; review + outbox + draft removal) use a single IndexedDB transaction across those stores. `messageId` and `eventId` are `crypto.randomUUID()`. Timestamps are ISO 8601 UTC.

**Deletion.** Deleting a clip removes the `clips` row and appends a new `capture` message with a fresh `messageId`, the same `eventId`, and `payload: {deleted: true, clipId, supersedesMessageId}`; the original capture message is left untouched, because the contracts forbid changing a message's payload under an existing `messageId`. If a review exists, a review revision with `deleted: true` is appended too. Both new messages get outbox rows. The original capture's outbox row stays pending; a future sync delivers the capture and its tombstone in order, which is the normal at-least-once shape. Deleted events are hidden by default. "Delete everything" clears all stores after a typed confirmation, then recreates `meta` with the same `installId`.

**Storage durability.** On first run and whenever Settings opens, call `navigator.storage.persist()` where it exists (Safari does not implement it; show "not available on this browser" rather than an error) and record the answer. Recommend installing to the home screen and exporting regularly. The seven-day eviction risk on iOS applies to Safari-tab use, not installed apps; say so in the hint rather than hiding it.

**Safari tab versus installed app.** On iOS the installed home-screen app and the Safari tab have separate storage; clips recorded in one are invisible in the other. When the app detects it is not running installed (`display-mode: standalone` is false) it shows a banner on Today: "Install to the home screen before recording. Clips recorded here will not appear in the installed app." Recording is still allowed, and Export is the way to carry such clips across. The manual test installs first for this reason.

**Bounded storage.** Settings shows clip count and bytes used. At 100 clips or 300 MB, whichever first, Today shows a persistent "Export and clear" prompt and Record still works; at 200 clips or 600 MB, Record is disabled until the owner exports or deletes. These limits are the author's starting values and are plain constants.

## Export (author's call)

Three export actions in Settings: **Export new** (events not yet exported, the default and the one Today points at), **Export unreviewed**, and **Export all**. Each produces a JSON bundle `siri-tiri-export-<UTC timestamp>.json` containing `exportVersion: 1`, `installId`, app and protocol versions, the selected capture messages (including tombstones for selected events), the full review history for those events, and a clip manifest (`clipId`, `eventId`, filename, `sha256`, `sizeBytes`, `sampleRate`, `durationMs`), plus one WAV file per clip named `<eventId>.wav`. After the share or download completes without error, `exportedAt` is written on each included event. A failed or cancelled share leaves `exportedAt` unchanged. Exports are chunked at 20 clips per share-sheet invocation so the iOS share sheet stays usable; the bundle JSON is included with the first chunk and names every file across chunks.

**Delete exported clips** in Settings removes the audio of events already exported (writing tombstones as above) while keeping their records and reviews on the phone. This is the retention mechanism for this slice.

Delivery uses the Web Share API with files when `navigator.canShare({files})` is true, which on iOS opens the share sheet (AirDrop to the laptop, Files, Mail). Otherwise it falls back to download links, one per file. No zip, since that would need a dependency or a hand-written archive writer; the bundle plus loose WAVs is enough for the local-service tooling, which already verifies clips by SHA-256.

Importing the bundle into the local service is the follow-on local-service task named above and is out of scope here; the export format is documented in the app's README section so that task can start from it.

## Service worker and updates (author's call)

Precache the app shell under a cache name that includes the app version from `version.js`. Navigation falls back to the cached shell when offline. The worker is registered with scope `./` relative to `docs/app/` and never caches or intercepts anything outside it. The existing mockup worker at `docs/sw.js` has scope `docs/`, which would otherwise control `docs/app/` on a first visit; the builder must confirm the app's own registration wins for its scope (a more specific scope takes precedence once registered) and that the mockup worker's navigation fallback cannot serve the mockup shell for `docs/app/` URLs. If it can, narrow the mockup worker's handling rather than the app's.

On `updatefound`, the app shows a non-blocking "Update ready" row on Today and in Settings. Reload is offered only when no recording is in progress and the current Review draft has been written (it always is, by design). The waiting worker activates on the owner's tap, never automatically during a recording. IndexedDB is untouched by updates; a schema upgrade, when one is ever needed, runs in `onupgradeneeded` with a migration and never drops stores.

## Versioning

`version.js` exports `APP_VERSION` (SemVer, starting `0.1.0`) and `PROTOCOL_VERSION: 1`. Both appear in Settings and in every export bundle. The service-worker cache name embeds `APP_VERSION`, so bumping it is what ships an update. Build SHA injection is out of scope without a build step; the PR records the commit.

## Accessibility and interaction rules

Follow `docs/UI_HANDOFF.md` and `docs/ARCHITECTURE_SYNC_UPDATES_LOGGING.md`: 44 pt targets, visible focus, labels on every control, status badges carry words not just color, `prefers-reduced-motion` disables the level meter animation in favor of a numeric level, VoiceOver announces save success and failure via a live region, and no action that commits or deletes is behind a swipe.

## Testing

**Automated, run in CI.** Pure modules (`wav.js`, `records.js`, the export bundle builder, the draft/revision logic if factored as pure functions) get tests with Node's built-in test runner (`node --test`), no dependencies. Tests check the WAV header bytes and lengths, PCM16 clamping and clipped-sample counting, that built events and reviews satisfy the required fields and enums of the two contract schemas (a small in-repo checker that reads the schema JSON; a full JSON Schema validator is not required), distinct `messageId` and `eventId`, stable `reviewId` across revisions, revision and `baseRevision` sequencing, undo and delete as appended messages, tombstone shape, export selection (new, unreviewed, all) and chunking, and bundle contents. Node 20 or newer; the dev machine has Node 23. A new workflow `.github/workflows/pwa-ci.yml` runs them on pushes and PRs touching `docs/app/**`.

**Manual, on a real iPhone, recorded in the PR.** Install to home screen; record, stop, see review; lock the screen mid-recording and confirm a flagged partial clip exists; review, save, undo, edit, confirm revisions in the export; turn on Airplane mode and relaunch; export via the share sheet to the laptop and verify a WAV plays and its SHA-256 matches the manifest; the `manage.py analyze` check is **not run** in this slice, because the local service cannot yet resample 44.1/48 kHz input; the PR says so and names the follow-on. Also a quick desktop pass in Chrome for the fallback download path.

What cannot be verified in this slice and must be stated in the PR: Android behavior if no Android device is available, long-term iOS eviction behavior, and anything about device-originated events.

## Delivery

Feature branch, PR to `main` with the standard sections from `AGENTS.md`. Documentation updates in the same PR: README section "Phone app (local-only)", a short `docs/app/README.md` covering the export format and the manual test checklist, `docs/UI_HANDOFF.md` gains a section pointing at the real app and listing which handoff states are now implemented, `docs/PROJECT_PLAN.md` progress list gains a checked item for this slice and keeps sync unchecked, `docs/index.html` links the app, and `docs/CODEX_HANDOFF.md` names the next task (Worker + D1 ingest, then PWA outbox delivery).

Merging publishes to GitHub Pages automatically. That is intended; it is how the owner installs it.

## Left to the builder

- Exact module split, CSS, and whether to reuse any markup from `connected-ui-v5.html`.
- AudioWorklet buffer sizes, meter smoothing, and whether a `ScriptProcessorNode` fallback is worth including.
- The in-repo schema checker's scope beyond required fields and enums.
- Whether `Undo` after a first save appends a `deleted: true` review revision or a revision restoring the pre-save draft; either keeps the append-only rule.
- How "Needs review" treats an event whose latest review revision is `deleted: true` (the author's suggestion: it needs review again).
- How the recording sheet handles a denied microphone permission (must show a clear message and a way to retry; the exact copy is theirs).
- Playback implementation (an `<audio>` element over an object URL is fine).
