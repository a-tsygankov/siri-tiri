# Shared contracts (v1)

JSON Schema Draft 2020-12. Event envelopes are immutable and idempotent by `messageId`. Revisions of a review use new message IDs and the same event ID. No raw audio or secrets in payloads or logs. Model output is not a user-provided label.

`event.v1.schema.json` and `log.v1.schema.json` define wire shapes; the local prototype currently validates only required fields and UUID syntax. Full schema validation and version negotiation are follow-up work.
