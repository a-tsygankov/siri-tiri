# Shared contracts (protocol v1)

These files evolve the existing event/log contract used by `local-service/service.py`. They give the PWA, ESP32, local service and Worker a shared vocabulary while allowing each component to release independently.

## Files

- `event.v1.schema.json`: current generic message envelope, with `messageId` idempotency and `eventId` correlation.
- `log.v1.schema.json`: current structured log envelope.
- `review-v1.schema.json`: revisioned owner context, observed behavior and outcome.
- `analysis-v1.schema.json`: model scores with model and preprocessing versions.
- `episode.v1.schema.json`: append-only revision of an episode, the grouping record that links captures of one sound from several devices (design only; see below).
- `local-inference.openapi.yaml`: proposed host-neutral local health, version and WAV classification API.

The last three files add typed review/analysis records and define the next inference API boundary. The current Python prototype still uses unversioned `/health`, `/version`, `/events` and `/logs`; the OpenAPI file is a target contract, not a claim that these routes are already implemented. See `local-service/README.md` for current behavior.

## Delivery and persistence rules

1. Generate stable UUIDs when a record is first created. Keep the same `messageId` for every retry; use a new message ID for a changed review revision.
2. Persist the record in the sender's durable outbox before showing **Saved on this device/phone**. A server response means accepted only if its implementation has committed the record durably.
3. Deliver at least once. Receivers deduplicate by `messageId`; an identical duplicate returns the prior acknowledgement. Reusing an ID with a different canonical payload hash is a conflict.
4. Retry transient failures with bounded exponential backoff and jitter. Keep a record until the receiver acknowledges it; represent permanent failures explicitly so a user can retry or export.
5. Keep capture metadata, audio objects, user reviews and analysis results separate. Analysis must never overwrite a review. A review revision carries its base revision so concurrent edits can be surfaced instead of silently replacing one another.
6. Store sync state (pending, leased, synced, failed) in each component's local queue; it is not a property of the shared event itself. Preserve queued data across application updates.
7. Never put audio bytes, credentials, private notes or raw request bodies in diagnostic logs. Logs include IDs and safe operational metadata only.
8. Audio upload is opt-in for cloud storage. A local service can process a LAN clip while the cloud is unavailable. Each implementation must enforce its configured clip duration/size and retention policy.

## Capture payload clock fields

`event.v1` leaves `payload` as a free object; these optional capture payload fields are documented here so every capture source reports clock quality the same way. They are inputs to episode grouping and do not change the `event.v1` schema.

| Field | Values | Who sets it |
|---|---|---|
| `clockSource` | `"phone"`: PWA capture stamped with the phone's OS clock. `"ntp"`: ESP32 capture after a successful SNTP sync in the current boot. `"unsynced"`: ESP32 capture before sync or after a sync failure. `"host"`: capture created or imported by the local service. | capturing component, never rewritten later |
| `clockOffsetMs` | Signed estimate of device clock minus reference clock at capture, when known | capturing component |
| `clockUncertaintyMs` | Upper bound on the offset error | capturing component |
| `clockSyncedAt` | Last successful time sync, device clock | ESP32 |
| `monotonicMs` | Milliseconds since boot at capture start, so unsynced captures can be placed relative to their upload | ESP32 |

Receivers stamp `receivedAt` when a message is first durably accepted and keep it next to the message (the local service already does so in `messages.received_at`). Captures without `clockSource` are treated as `"phone"` when `sourceKind` is `"pwa-manual"` and as `"unsynced"` otherwise. The PWA should add `clockSource: "phone"` to new captures; that change is not yet made.

## Episodes (multi-device grouping)

Several devices will record the same meow. Captures are never deduplicated; instead an **episode** (`episode.v1.schema.json`) groups captures from different `sourceId`s into one real-world sound, names a `primaryEventId` chosen by a quality score, and records lineage for owner split and merge. Episode records are append-only revisions with `baseRevision` conflict detection, like reviews. `source` is `grouper` (Worker or local service, with `grouperId`, `algorithmVersion` and `parameters`) or `owner`; once an owner revision exists the episode is `ownerLocked` and automatic runs may only add `auto-suggestion` revisions. Grouping runs in the Worker/D1 tier and in the local service, never on the phone or the ESP32. Reviews stay keyed by `eventId` and are written against the primary event. Design, defaults and open questions: [episode grouping design](../docs/superpowers/specs/2026-11-01-episode-grouping-design.md). No grouping code is implemented.

## Model artifact and provenance

YAMNet remains the frozen base model by default. A Tiri-specific model is a separately versioned downstream artifact (for example, a small classifier trained on YAMNet embeddings), with its label map, thresholds, preprocessing version, training-data manifest, code revision and evaluation report. Do not identify that artifact as a YAMNet weight update. Model changes must be reproducible and rollbackable; keep large model/audio files outside normal Git history using an artifact store or Git LFS, and back up artifact metadata and manifests with the source code.

See [Model artifacts, training and backup](../docs/MODEL_ARTIFACTS.md) for the CatMeows-to-Tiri training path and recommended checkpoint strategy.

## Compatibility

Protocol v1 is the initial development contract, not a promise of production stability. Consumers should reject unsupported major schema versions with a clear compatibility error, preserve unknown optional fields where their parser permits it, and report their own component version plus supported protocol range. Add fields compatibly; use a new schema major version for incompatible changes. Update the shared contract and fixtures before implementing each consumer.
