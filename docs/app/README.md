# Siri-Tiri phone app

An installable phone web app for recording short clips of Tiri and recording the owner's observation about each one. Everything is saved on the phone first. Once the app is paired with the Siri-Tiri Worker (`worker/`), clips, their audio and reviews sync to every other paired phone or browser profile; without pairing nothing leaves the phone except by manual export.

**Live URL (after merge to `main`):** https://a-tsygankov.github.io/siri-tiri/app/

## What it is and is not

- It records clips (up to 30 s) with the phone microphone, stores each as a 16-bit mono WAV in IndexedDB, and lets the owner review it: hypothesized context plus optional observed location, behavior and outcome, with Unsure and quick-save always available.
- Reviews are append-only revisions (save, undo, edit, delete). Nothing is overwritten. A save that does not extend the latest stored revision (for example after another tab saved first) is rejected; the Review screen reloads and asks the owner to check and save again.
- A clip can be trimmed from the start and the end on the Review screen (see Trimming). The untrimmed original stays on the phone; a trim is a new record, never an edit of the original.
- It does **not** run any model, receive device events or claim to detect or interpret meows. User observations are stored as observations; nothing here is inference.
- Cloud sync is opt-in per phone or browser profile through a one-time pairing code (see Cloud sync below). Unpaired, the app is local-only.
- States shown: Saved on this phone, Queued, Synced, Sync failed, Needs review, Reviewed, Update ready. "Analysis complete" does not exist yet.

## Install

The app needs HTTPS for the microphone and service worker.

- **iPhone (Safari):** open the live URL, tap Share, then "Add to Home Screen". Open it from the home screen icon.
- **Android (Chrome):** open the live URL, then menu, "Install app" or "Add to Home screen".

A plain `http://<lan-ip>:8080/app/` link (for example from `python -m http.server` on a laptop) can show the layout, but iOS blocks the microphone and service workers on non-HTTPS origins, so recording and offline use will not work there.

## Updates

Opening the app checks for a new version. When one is ready an "Update ready" row appears on Today and in Settings; tapping it reloads onto the new version. The row is disabled while a recording, a save or an export is in progress. Drafts are stored on every tap; preservation across an update is on the manual checklist. A release must bump `APP_VERSION` in both `docs/app/version.js` and `docs/app/sw.js`; `tests/version.test.mjs` enforces that they match.

## Cloud sync

Settings has a **Cloud sync** card. Unpaired it asks for the **Server URL** (the Worker) and a **Pairing code**. Codes are minted on the owner's machine with `node worker/scripts/pairing-code.mjs --url <server> --label "<phone>"`; a code works once and expires after 15 minutes. Pairing stores a per-device token in IndexedDB (never shown, never in a URL); the owner can revoke it server-side with the admin script and **Unpair** forgets it locally. A Safari tab and the installed app are separate storage, so they pair separately and then see each other's clips through the server.

What syncs, in order, on every run: queued capture, tombstone and review messages (push), the WAV of each accepted capture (upload, verified by size and SHA-256 on the server), everything other devices sent since this phone's cursor (pull, one page at a time), then the audio of up to 20 clips this phone does not have yet (newest first; opening a Review downloads its clip on demand). Runs happen on launch, when the app returns to the foreground, on reconnect, two seconds after a save or delete, and on **Sync now**. Nothing runs in the background on iOS. Failures back off (5 s doubling to 10 min) and are retried on the next run.

| State | Meaning |
| --- | --- |
| Saved on this phone | Written to IndexedDB; sync not configured (or not yet attempted) |
| Queued | Paired; the capture, its audio or a review is still waiting for the server's acknowledgment |
| Synced | The server acknowledged every message of this event and has its audio; for a clip from another device, it was received |
| Sync failed | The server refused something for good (a WAV that no longer matches its capture, or a review revision another device saved first). Settings lists them; the Review screen explains a **Review conflict** and offers **Save again** |
| Recorded on another device | The capture came from another paired phone or profile |
| Audio not downloaded yet / Downloading audio… | A remote clip whose WAV has not arrived on this phone |

Reviews are revision chains per event. If two phones save the same revision number while offline, the server keeps the first, stores the second as a conflict, and the losing phone shows the conflict with the context it tried to save; **Save again** re-applies it as the next revision. Nothing is merged silently and nothing is lost.

Deleting a clip writes a tombstone that syncs like any message; the server deletes the audio object and other phones drop their copy. Records and reviews stay everywhere. "Delete everything" keeps the pairing and re-pulls on the next sync.

## Trimming

On the Review screen, **Trim clip** (or **Change trim** on an already trimmed clip) opens an editor under the Play control with a Start and an End slider over the original recording, a **Play selection** button that plays only the chosen range, **Save trim** and **Cancel**. **Restore original** puts the untrimmed recording back. The review itself (context, details, note, draft and revisions) is not touched by any of these; Unsure, quick-save and Later work as before.

- Cut points move in 50 ms steps; the kept range is at least 300 ms (the other handle gives way); a cut that keeps the whole clip cannot be saved.
- The trim is always taken from the original recording, even when changing an earlier trim, so a second trim never compounds the first.
- The original WAV is kept on the phone until the clip is deleted. Only the previous trimmed WAV is removed when a trim is changed or restored. Storage counts a trimmed event as one clip (its bytes include both files).
- **Delete clip** removes every WAV of the event (original and trimmed); the records stay.

### Trim record format

A trim is an `event.v1` message of `type: "capture"` with the **same `eventId`** as the recording, a fresh `messageId`, and `sourceId` of this phone. Its payload has the same audio fields as a capture, describing the trimmed WAV, plus:

| Field | Meaning |
| --- | --- |
| `supersedesMessageId` | The capture message this one replaces as the current clip (the original, or the previous trim or restore). |
| `trim.sourceMessageId` | `messageId` of the original capture. |
| `trim.sourceClipId`, `trim.sourceSha256`, `trim.sourceDurationMs` | The original clip the cut was taken from. |
| `trim.startMs`, `trim.endMs` | The kept range on the original, in milliseconds (`endMs` exclusive). |
| `trim.trimVersion` | `pwa-trim-v1`: sample-exact cut of the PCM16 data at the native rate, no fades or resampling. |

`clipId`, `sha256`, `sizeBytes`, `durationMs` and `clippedSamples` describe the trimmed file (`clippedSamples` counts full-scale samples in the kept range). `recordedAt` is the original `recordedAt` plus `startMs`, so the trimmed audio keeps its real start time; `sampleRate`, `interrupted`, `encoding`, `channels`, `captureVersion` and `sourceKind` are carried over from the original.

A **restore** is the same kind of message with the original's payload fields (same `clipId` and `sha256` as the original) plus `supersedesMessageId` (the trim it replaces) and `restoresMessageId` (the original capture). It has no `trim` field.

The **current clip** of an event is the live capture message (not a tombstone) that no other live capture message supersedes; the original is the one with no `supersedesMessageId`. A delete tombstone supersedes whichever message was current. Consumers that only know the original capture message can ignore messages carrying `supersedesMessageId`; everything they already had stays valid.

## Export bundle

Settings offers Export new, Export unreviewed and Export all. Export produces one JSON bundle plus one WAV per clip, handed to the share sheet (or downloaded when sharing files is unsupported).

- Export new selects events never exported, plus exported events with a review revision or a tombstone written after their last export.

- Bundle filename: `siri-tiri-export-<YYYYMMDDTHHMMSSZ>.json`
- Clip filename: `<eventId>.wav` for the original recording; `<eventId>.trimmed.wav` for the current trimmed clip of a trimmed event.
- Bundle fields: `exportVersion` (1), `appVersion`, `protocolVersion`, `installId`, `exportedAt`, `events` (every capture message of each event: original, trims, restores and tombstones), `reviews` (every revision, ordered by revision), `clips` (manifest, one entry per WAV file: `clipId`, `eventId`, `filename`, `sha256`, `sizeBytes`, `sampleRate`, `durationMs`).
- A trimmed event contributes its trimmed WAV, and its original WAV too when the original never left the phone (always in Export all). The manifest keys both by `sha256`, so an importer can match the trimmed file to its `trim.sourceSha256`.
- A trim or restore counts as a change for Export new: the event is selected again and its new message goes out (with the trimmed WAV; the original WAV only if it was never exported).
- Chunking: at most 20 WAVs per share; the bundle rides in the first chunk. Every chunk, the first included, waits for a "Share export" / "Share part N of M" tap so each share runs inside a fresh tap (iOS needs user activation for each share). A share rejected with `NotAllowedError` asks for another tap.
- If the browser will not share the `application/json` bundle, it is retried as `siri-tiri-export-<stamp>.json.txt` (`text/plain`) before falling back to downloads.
- Export all always includes audio: every selected event that still has a clip gets its WAV and manifest entry, even if it was exported before. It is the full backup, and the way to recover after a wrong "Yes" on the download prompt.
- Export new and Export unreviewed carry records only (capture envelope, tombstone, review history; no WAV and no manifest entry) for clips that already left the phone. Later revisions or a tombstone for an already-exported event therefore leave through Export new as records only.
- Deleted events are exported as records only in every mode.
- After a share completes, every included event is marked exported. A download cannot be observed, so after a download the app asks "Did all N files download?" and marks the events exported only on Yes; No leaves them unexported. A cancelled or rejected share leaves them unexported.

## Limits

| Limit | Value |
| --- | --- |
| Maximum clip length | 30 s (cue at 20 s, auto-stop at 30 s) |
| Minimum clip length | 300 ms (shorter is rejected) |
| Storage warning | 100 clips or 300 MB |
| Storage block (no new recording) | 200 clips or 600 MB |
| WAVs per share | 20 |

Clips are recorded at the phone's native rate (commonly 44.1 or 48 kHz), not 16 kHz.

## Tests

- `node --test docs/app/tests/*.test.mjs` (Node 20+): WAV, schema checker, records (including sync badges and `clockSource`), export, sync (push, backoff, upload, pull, download, 401 handling against a fake server) and version tests. Runs in CI via `.github/workflows/pwa-ci.yml`.
- `docs/app/tests/harness.html`: open in a browser (served over HTTP or localhost) for IndexedDB, fault-injection, revision-conflict, unique-index, export tap/confirmation, export-lock, clip trim/restore/delete, trimmed-event export, recorder trim/timer and sync-storage (v2 stores, outbox, remote apply, conflicts, remote tombstone, cursor) checks; four groups each end with ALL PASS. The Record buttons need a microphone (or a stubbed `getUserMedia`).
- Two-device check on one machine: run the Worker locally (`worker/README.md`), serve `docs/` with `python -m http.server 8090 --directory docs`, and open `http://localhost:8090/app/` and `http://127.0.0.1:8090/app/`. They are separate origins with separate IndexedDB, so they behave as two phones. Pair each with its own code, record (or inject a WAV through the console using `db.js`), and watch the other side list the clip as Synced with playable audio.

## Manual iPhone checklist (pending a real device)

- [ ] Install to the home screen and open in standalone mode
- [ ] Grant the microphone; record, stop, and see the review screen
- [ ] Lock the screen mid-recording; a flagged partial clip exists
- [ ] Review, save, undo, edit; revisions appear in the export
- [ ] Airplane mode: relaunch and confirm the app and saved data load
- [ ] Export through the share sheet (including more than 20 clips) to the laptop
- [ ] A WAV plays and its SHA-256 matches the manifest
- [ ] Update row appears after a version bump and the update preserves a draft
- [ ] Trim a clip (sliders by touch, Play selection, Save trim), relaunch, confirm the trimmed clip plays and the export has both WAVs; Restore original
- [ ] VoiceOver reads controls and states sensibly (including the Start/End sliders)
- [ ] Persistent-storage prompt behavior noted
- [ ] Quick desktop Chrome pass for the download fallback (real files, then the "Did all N files download?" prompt)

## Known gaps

- Nothing here has been run on a real iPhone or Android device. Microphone, install, share sheet (including user-activation timing for the first `navigator.share`), multi-chunk export, standalone mode and VoiceOver are unverified.
- `manage.py analyze` has not been run on exported clips; the local service cannot yet resample 44.1/48 kHz input.
- iOS may evict site storage after a long period of disuse. Behavior over time is untested; export regularly.
- The `?v=`-free update path on Safari is unverified.
- The unique `[eventId, revision]` index exists only in databases created by version 1 or later of the store; a pre-release test database from an earlier build keeps the non-unique index (the in-transaction revision check still applies). Clear site data on test phones before real use.
- Sync has been verified only between two browser origins on one Windows machine against a local Worker; no real phone, no deployed Worker. The Worker has not been deployed and `wrangler.toml` still carries placeholder resource ids.
- The service worker precaches `sync.js`; the sync requests themselves go to the Worker origin and are never cached.
- Follow-ups: local-service bundle importer with versioned 44.1/48 kHz to 16 kHz resampling and a local-service cloud client; episode records in the pull stream; splitting `app.js` into review, recording, settings and sync modules.
