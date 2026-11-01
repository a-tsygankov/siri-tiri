# Multi-device capture grouping (episodes)

Status: design written on 2026-11-01 from the owner's requirement discussion; not yet approved for implementation and no grouping code exists. Contract draft: `contracts/episode.v1.schema.json`. Capture clock fields: `contracts/README.md`.

## Intent

Tiri will be recorded by more than one capture source at once: the owner's phone PWA (PR #12), one or more ESP32 room devices, and possibly future devices. One real meow will therefore arrive as several `event.v1` capture messages with close but not identical timestamps, different volume, different clipping and different sample rates. The owner must see that meow once, review it once, and still be able to open every underlying recording.

The system never deduplicates at capture time. Each device's capture stays an immutable `event.v1` message with its own `eventId`. Instead, a separate, revisable, append-only **episode** record links captures from different `sourceId`s into one real-world sound, chooses one primary clip, carries the owner's review, and can be split or merged by the owner.

## Goals

- Zero loss: every capture from every device is kept and remains reachable from its episode.
- One review per real sound: owner review UI and summaries operate on episodes, not raw captures.
- Deterministic, versioned grouping that can be re-run and audited when the algorithm changes.
- Owner corrections (split, merge, choose primary, confirm) are durable and never silently undone by a later automatic run.
- Works offline-first: the local service groups LAN captures while the cloud is unreachable; the cloud groups everything it has; the phone never groups.
- Honest clock handling: sources with an unsynchronized clock are grouped more conservatively and the UI can show why.

## Non-goals

- Interpreting intent or emotion. Grouping says "these recordings are the same sound", nothing more.
- Speaker identification. One cat profile, no cat-vs-cat discrimination.
- Sample-level alignment or mixing several clips into one. The primary clip is one of the originals, unmodified.
- Grouping on the ESP32 or in the PWA.
- Replacing `event.v1`. Captures are not rewritten, and no capture field becomes required.
- Implementing anything in this PR. This document and the schema are the deliverable.

## Vocabulary

- **Capture**: an `event.v1` message with `type: "capture"`, immutable, one per device recording.
- **Episode**: a group of one or more captures believed to be the same real-world sound, with one `primaryEventId`. A capture with no match forms a singleton episode, so every non-deleted capture belongs to exactly one current episode.
- **Episode revision**: an append-only `episode.v1` record. The current state of an episode is its highest accepted revision.
- **Grouper**: the component that produces automatic revisions (Worker or local service), identified by `grouperId` and `algorithmVersion`.

## Episode record (`episode.v1`)

See `contracts/episode.v1.schema.json`. Summary of fields:

| Field | Meaning |
|---|---|
| `schemaVersion` | `1`. |
| `messageId` | Immutable per revision; retries reuse it, a new revision gets a new one. |
| `episodeId` | Stable UUID for the episode across revisions. |
| `revision`, `baseRevision` | Revision number and the revision the author saw when writing this one (`null` for revision 1). |
| `editedAt` | When the revision was produced, author clock. |
| `source` | `grouper` (automatic) or `owner`. |
| `grouperId`, `algorithmVersion`, `parameters` | Required for grouper revisions: which component, which algorithm version, and the parameter set used. Owner revisions omit them. |
| `reason` | Why this revision exists: `auto-grouped`, `auto-regrouped`, `auto-suggestion`, `owner-merge`, `owner-split`, `owner-confirm`, `owner-primary`, `owner-remove`, `tombstone`. |
| `applied` | `false` only for `auto-suggestion` revisions, which are stored but do not change the current state. |
| `members[]` | Each member: `eventId`, `sourceId`, `startAt`, `endAt`, `clockSource`, optional `clockUncertaintyMs`, `receivedAt`, optional `qualityScore` and `similarityToPrimary`. Members are copied from capture data so a revision is self-describing without joining captures. |
| `primaryEventId` | Must be one of the members. |
| `windowStartAt`, `windowEndAt` | Union of member intervals in reference time. |
| `confidence` | 0..1 grouper confidence that the members are one sound; `1` for owner revisions. |
| `ownerLocked` | `true` once an owner revision exists; the grouper may not change membership of a locked episode. |
| `splitFromEpisodeId`, `mergedIntoEpisodeId`, `absorbedEpisodeIds[]` | Lineage for split and merge. |
| `deleted` | Tombstone; an episode is deleted only when merged into another or when all its captures are deleted. |

### Revision rules

1. Append-only. A revision is never edited or removed; corrections are new revisions. Receivers deduplicate by `messageId` exactly as for events and reviews.
2. Each revision carries `baseRevision`. A revision whose base is not the current highest applied revision is a conflict. Conflicts are stored, flagged and surfaced, never merged automatically.
3. Owner over grouper. If an owner revision and a grouper revision conflict, the owner revision becomes current and the grouper revision is kept as history. Once `ownerLocked` is true, a grouper may not change `members` or `primaryEventId`. If a newer algorithm would group differently, the grouper writes an `auto-suggestion` revision with `applied: false`; the UI can show it as "the grouper would now split this" and the owner may accept it with an owner revision.
4. A grouper emits an applied revision only when membership, primary or confidence class actually changes under the current algorithm version. Re-running the same version over the same inputs must be a no-op.
5. Membership exclusivity. An `eventId` is a member of at most one non-deleted current episode. A grouper that moves an event between episodes writes revisions for both episodes in one transaction (D1 batch or SQLite transaction).
6. Captures that are tombstoned (`payload.deleted: true`) are removed from membership by a grouper revision with `reason: "auto-regrouped"`; if nothing remains the episode is tombstoned.

### Owner reviews and episodes

`review-v1` keys reviews by `eventId`, and that stays unchanged in this design. Rules:

- The review UI writes new reviews against the episode's `primaryEventId`. A review therefore always has a concrete event, and the phone can keep writing reviews before any grouping has happened, because its own capture is then the primary of a singleton episode.
- An episode's reviews are the union of reviews on all its members. When a merge brings together two members that both carry reviews, both histories are kept and the UI shows them as a conflict for the owner to resolve by writing one new review with the chosen one as `baseRevision`. Nothing is auto-resolved.
- When the owner splits an episode, reviews stay with the event they were written against. The UI should offer to copy the review to the split-off episode's primary; the copy is a new review with a new `reviewId`, not a move.
- A later review schema may add an optional `episodeId` hint; that is an additive change and is listed under open questions.

## Grouping algorithm

### Inputs per capture

From the capture envelope and payload:

- `eventId`, `sourceId`, `createdAt`.
- `recordedAt` and `durationMs` from the payload, giving `[startAt, endAt]` in the source's own clock.
- `clockSource` and optional `clockOffsetMs`, `clockUncertaintyMs`, `monotonicMs` (see clock fields below).
- `receivedAt`, stamped by the receiving service when the message was first accepted (already a column in the local service `messages` table; D1 must store it too).
- `sampleRate`, `clippedSamples`, `sizeBytes`, `sha256`, `channels`.
- An acoustic signature computed by the grouper from the audio when it is available: the YAMNet 1,024-d mean embedding when the inference artifact exposes it, otherwise a normalized loudness envelope at 50 ms hops. Captures whose audio is absent (metadata-only cloud sync) can only be grouped on time.

### Reference time and tolerance

Each member's interval is translated into reference time (receiver UTC):

- `phone`, `ntp` and `host` sources: `startAt - clockOffsetMs` with uncertainty `clockUncertaintyMs` (defaults when not reported: 1,000 ms for `phone`, 500 ms for `ntp`, 500 ms for `host`).
- `unsynced` sources: the device clock is not trusted. Reference time is estimated from `receivedAt` minus the device's reported age of the capture (`monotonicMs` at send minus `monotonicMs` at capture) when available, and uncertainty is set to a configured ceiling (default 30 s). Such captures are grouped only when acoustic similarity also passes.
- Unknown (`clockSource` absent on legacy captures): treated as `phone` for payloads with `sourceKind: "pwa-manual"`, otherwise as `unsynced`.

Two captures are **time-compatible** when their reference intervals overlap after each is widened by its own uncertainty plus the base tolerance (default 1,500 ms).

### Candidate pairing and scoring

1. Only captures from different `sourceId`s are paired automatically. Two captures from the same device are never grouped by the grouper; overlapping same-device captures indicate a device bug and are logged.
2. Among time-compatible pairs, compute acoustic similarity: cosine similarity of embeddings, or normalized cross-correlation peak of envelopes within the time tolerance. Missing audio gives similarity `null`.
3. A pair links when similarity is at least `similarityThreshold` (default 0.80 for embedding cosine, 0.60 for envelope correlation), or when similarity is `null` and both sources are `phone`/`ntp`/`host` with overlap of at least 50% of the shorter clip.
4. Episodes are connected components of linked pairs, subject to one member per `sourceId`. When a component would violate that, the weakest link is cut and the component re-evaluated.
5. `confidence` is the minimum link similarity in the component (or 0.5 for a `null`-similarity link), scaled by 0.5 when any member is `unsynced`. Singleton episodes have confidence `1`.

### Versioning

- `algorithmVersion` is a string such as `episode-grouper-v1`. Any change to the rules above, to defaults, or to the acoustic signature source (for example switching from envelopes to embeddings) bumps it.
- `parameters` records the effective thresholds so a revision can be reproduced.
- When a new version is deployed, the grouper re-runs over a bounded recent window (default 30 days). Unlocked episodes may be regrouped; locked episodes only receive suggestions (revision rule 3). Older episodes are regrouped only on explicit admin request.
- The grouper's own component version is logged separately from `algorithmVersion`.

## Clock-quality fields on captures

`event.v1` is unchanged structurally; `payload` is a free object. The documented capture payload gains optional fields:

| Field | Values | Set by |
|---|---|---|
| `clockSource` | `"phone"` (PWA: OS clock of the phone), `"ntp"` (ESP32 with a successful SNTP sync in this boot), `"unsynced"` (ESP32 before sync or after a sync failure), `"host"` (local service manual or imported captures) | capturing component |
| `clockOffsetMs` | Signed estimate of device clock minus reference clock at capture, when known | capturing component |
| `clockUncertaintyMs` | Upper bound on the offset error | capturing component |
| `clockSyncedAt` | When the device last synchronized, device clock | ESP32 |
| `monotonicMs` | Milliseconds since boot at capture start, for unsynced devices | ESP32 |
| `receivedAt` | First durable acceptance time, receiver clock | receiver, stored alongside the message rather than in the payload |

The PWA sets `clockSource: "phone"` on new captures; existing exported captures without it are treated as `phone`. ESP32 firmware writes `"unsynced"` until SNTP has succeeded in the current boot and switches newly created captures to `"ntp"` afterwards without rewriting earlier ones.

## Primary clip selection

The grouper computes a `qualityScore` in 0..1 per member and chooses the highest; ties break by lower `sourceId` string, then lower `eventId`, so selection is deterministic.

| Component | Weight | Measure |
|---|---|---|
| Clipping | 0.30 | `1 - min(1, 100 × clippedSamples / totalSamples)`; more than 1% clipped samples scores zero here |
| Signal-to-noise | 0.25 | Estimated SNR from the envelope (loudest 10% vs quietest 20%), mapped 0 dB to 0 and 30 dB to 1; `0.5` when audio is unavailable |
| Sample rate | 0.15 | 8 kHz 0.2, 16 kHz 0.6, 44.1 kHz and above 1.0, linear between |
| Coverage | 0.15 | Fraction of the episode window covered by this member |
| Source preference | 0.15 | `phone` 1.0 (the owner was present and pressed record), `ntp` 0.7, `host` 0.6, `unsynced` 0.4 |

An owner revision with `reason: "owner-primary"` overrides the computed primary and locks the episode. The weights are part of `parameters`, so changing them bumps `algorithmVersion`.

## Owner split and merge

All owner operations produce `source: "owner"` revisions, set `ownerLocked: true`, and are written by the UI through the same at-least-once outbox as reviews. Each operation is one logical transaction and the receiver applies the set atomically.

- **Confirm**: new revision, same members, `reason: "owner-confirm"`. Prevents future regrouping.
- **Choose primary**: `reason: "owner-primary"`, new `primaryEventId` among existing members.
- **Remove a member**: `reason: "owner-remove"`; the removed event becomes a singleton episode created in the same transaction with `splitFromEpisodeId`.
- **Split**: `reason: "owner-split"` on the original with the remaining members; a new episode (new `episodeId`, revision 1, `splitFromEpisodeId`) holds the moved members and its own primary. The members must partition exactly.
- **Merge**: the owner picks a surviving episode. It gets a revision with `reason: "owner-merge"`, the union of members and `absorbedEpisodeIds`; each absorbed episode gets a tombstone revision with `mergedIntoEpisodeId`. The owner may merge two episodes that both contain a capture from the same `sourceId` (a device may have split one long meow into two clips); the one-member-per-source rule applies to the grouper only.
- **Undo** is a further owner revision, never deletion of history.

The UI shows per episode: member count and sources, which clip is primary and why (score components), confidence, lock state, and any pending suggestion.

## Where grouping runs

| Tier | Runs grouping | Scope | Authority |
|---|---|---|---|
| Phone PWA | No | Displays episodes it has synced; writes owner revisions | None |
| ESP32 | No | Captures only | None |
| Local service (Windows/Pi) | Yes, `grouperId: "local-service"` | Captures received over LAN or imported from PWA bundles | Provisional |
| Cloudflare Worker + D1 | Yes, `grouperId: "worker"` | Everything synced to the cloud | Authoritative |

Both groupers run the same algorithm version against shared fixtures. Because the local service may see captures before the cloud and vice versa, their revisions can disagree. Resolution: when the cloud receives a local-service revision whose base matches its current state, it accepts it; when both have produced the same revision number for one episode from different inputs, the Worker revision wins, the local one is kept as a conflict record, and the local service adopts the cloud state on its next sync. Owner revisions always win over either grouper. When the cloud is absent for a long time, the local service remains the only grouper and nothing is lost; the eventual cloud run starts from the local revisions rather than from scratch.

Grouping runs as a job in the existing job ledger (local `jobs` table, D1 jobs), triggered by capture acceptance and by algorithm version change, with the same claim, lease and retry semantics as inference jobs. A grouping job waits a settle delay (default 60 s after `receivedAt`) so sibling captures that arrive a little later are grouped in one pass instead of forcing an immediate regroup.

## Migration implications

### Local service (SQLite)

- Migration 3, additive and repeatable like migration 2: `episode_revisions` (one row per `episode.v1` message, unique on `message_id`, indexed on `episode_id, revision`), `episode_members` (derived index of `episode_id`, `event_id`, `revision`; one current non-deleted episode per `event_id`, enforced in application code) and `episode_conflicts`.
- `messages.received_at` already exists and becomes the `receivedAt` input.
- Backfill: one grouping job per existing capture at `episode-grouper-v1`. Existing captures without `clockSource` follow the legacy rule above. Running the backfill twice is a no-op by revision rule 4.
- Reverting code does not reverse migration 3; back up the database first, as for migration 2.

### Cloudflare D1

- New tables mirroring the above, plus `received_at` on the capture index if it is not already present. Migration IDs stay independent from SQLite's.
- Sync: `episode.v1` becomes a new synced record type alongside events and reviews, with its own cursor. Clients that do not understand it preserve and forward it unchanged, per the compatibility rule in `contracts/README.md`.
- R2 is not involved; episodes hold no audio.

### PWA

- Stores synced episode revisions in a new IndexedDB object store when sync lands; until then the PWA's local list is a list of singleton episodes by construction. Export bundles gain an `episodes` array in a later `exportVersion`.
- Owner revisions join the existing outbox.

## Diagnostics

Grouper logs carry `episodeId`, member `eventId`s, `algorithmVersion`, similarity and timing numbers, never audio. Metrics for the local diagnostics page and the hosted admin: episodes per day, multi-member share, mean members per episode, owner split and merge counts (a proxy for grouping error), outstanding conflicts and suggestions, `unsynced` capture share.

## Open questions

1. Should `review-v1` gain an optional `episodeId` so a review survives primary changes without re-resolution? Proposed yes, as a compatible addition in a follow-up.
2. Embedding availability: the current TFLite YAMNet artifact returns class scores, not embeddings. Until an embedding-exposing artifact is pinned, `episode-grouper-v1` would use envelope cross-correlation only. Confirm this is acceptable for v1.
3. Settle delay and the 30-day regroup window need measurement once two devices exist.
4. How should the UI present `unsynced` captures that could not be grouped confidently: as separate episodes with a hint, or as pending members of the nearest episode?
5. Should the grouper ever merge consecutive clips from one device that look like a continued meow? Proposed no for v1; only the owner can.
6. Cross-grouper determinism: identical code (a shared Python module and a TypeScript port validated against the same fixtures), or a specification plus golden fixtures only?
