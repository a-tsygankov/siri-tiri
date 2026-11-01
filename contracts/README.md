# Shared contracts (protocol v1)

These files evolve the existing event/log contract used by `local-service/service.py`. They give the PWA, ESP32, local service and Worker a shared vocabulary while allowing each component to release independently.

## Files

- `event.v1.schema.json`: current generic message envelope, with `messageId` idempotency and `eventId` correlation.
- `log.v1.schema.json`: current structured log envelope.
- `review-v1.schema.json`: revisioned owner context, observed behavior and outcome.
- `analysis-v1.schema.json`: model scores with model and preprocessing versions.
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

## Model artifact and provenance

YAMNet remains the frozen base model by default. A Tiri-specific model is a separately versioned downstream artifact (for example, a small classifier trained on YAMNet embeddings), with its label map, thresholds, preprocessing version, training-data manifest, code revision and evaluation report. Do not identify that artifact as a YAMNet weight update. Model changes must be reproducible and rollbackable; keep large model/audio files outside normal Git history using an artifact store or Git LFS, and back up artifact metadata and manifests with the source code.

See [Model artifacts, training and backup](../docs/MODEL_ARTIFACTS.md) for the CatMeows-to-Tiri training path and recommended checkpoint strategy.

## Compatibility

Protocol v1 is the initial development contract, not a promise of production stability. Consumers should reject unsupported major schema versions with a clear compatibility error, preserve unknown optional fields where their parser permits it, and report their own component version plus supported protocol range. Add fields compatibly; use a new schema major version for incompatible changes. Update the shared contract and fixtures before implementing each consumer.
