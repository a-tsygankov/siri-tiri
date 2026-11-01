# Shared contracts (v1)

JSON Schema Draft 2020-12. Event envelopes are immutable and idempotent by `messageId`. Revisions of a review use new message IDs and the same event ID. No raw audio or secrets in payloads or logs. Model output is not a user-provided label.

`event.v1.schema.json` and `log.v1.schema.json` define wire shapes; the local prototype currently validates only required fields and UUID syntax. Full schema validation and version negotiation are follow-up work.

## Local jobs API v1

`jobs.v1.schema.json` describes the additional localhost worker API. Use its `$defs` fragments for each operation:

| Operation | Request fragment | Response fragment |
| --- | --- | --- |
| Claim | `#/$defs/claimRequest` | `#/$defs/claimResponse` |
| Heartbeat | `#/$defs/heartbeatRequest` | `#/$defs/jobResponse` |
| Acknowledge | `#/$defs/ackRequest` | `#/$defs/jobResponse` |
| Fail | `#/$defs/failRequest` | `#/$defs/jobResponse` |
| Inspect | GET query `limit=1..500` | `#/$defs/listResponse` |

The document root validates a mutation job response. `claimedJob` contains the immutable event and lease token; `inspectionJob` excludes both. Error responses are `{error: string}` with the HTTP codes documented in `local-service/README.md`. All job requests require protocol schemaVersion 1; SQLite migration version 2 and component version 0.2.0 are separate.

The service performs explicit validation without a JSON Schema library. Additional operational checks: strings cannot be all whitespace, JSON values must be finite, total request size is 1..65536 bytes, canonical result size is at most 32768 bytes, and ownership/state/expiry must match persisted data. JSON Schema alone cannot express all these checks. The event/log prototype still does not perform full JSON Schema validation.
