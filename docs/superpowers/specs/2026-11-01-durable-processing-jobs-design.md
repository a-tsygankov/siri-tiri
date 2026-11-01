# Durable local processing jobs

Status: approved by the user on 2026-11-01; implemented and independently reviewed on PR #4. CI/delivery status is recorded on that PR. Implements the next incremental task in CODEX_HANDOFF.md; no inference runtime is included. API and operational details are recorded in local-service/README.md and contracts/jobs.v1.schema.json.

## Intent and scope

Make accepted capture messages recoverable processing work across service and worker crashes. Preserve the dependency-free Python service, localhost-only binding, immutable event envelopes, and one connection per database operation. Owner reviews remain independent of processing results.

## Approaches

The proposed approach is a SQLite job ledger alongside the existing message store. It supports atomic acceptance and durable claims without another service. An in-memory queue cannot meet restart recovery requirements. An external broker adds deployment work and still requires a durable ledger. The existing approved architecture therefore leaves SQLite as the appropriate choice for this increment; this recommendation is the implementer's proposal.

## Storage and acceptance

- Add an ordered, transactional SQLite migration 2 with a jobs table and claim indexes. Preserve existing messages and logs. Refuse unsupported newer schema versions rather than mutating them.
- Each capture message has one job, keyed uniquely by its immutable message ID. Event ingestion and job creation commit together. Duplicate delivery never resets a job or creates a second one. Review, analysis, heartbeat and update messages do not enqueue processing jobs.
- Migration backfills jobs for existing captures with no matching job. This is explicitly at-least-once processing, since there was no prior job completion ledger.
- Store job ID, source message/event/correlation IDs, state, attempts, availability time, lease token/worker/expiry, completion result, and timestamps. Results never rewrite owner reviews.

## Local API and worker lifecycle

Keep the current endpoints compatible. Add versioned local job routes:

- `GET /v1/jobs?limit=100`: bounded inspection; do not expose lease tokens in listings.
- `POST /v1/jobs/claim`: worker ID and lease duration; returns one eligible job, its immutable source event envelope, and a fresh lease token, or no job. Read the source envelope within the claim transaction so even old captures remain processable. Claim atomically using a SQLite write transaction, across processes as well as HTTP threads.
- `POST /v1/jobs/{id}/heartbeat`: extend an unexpired lease only with its current worker ID and token.
- `POST /v1/jobs/{id}/ack`: atomically save a bounded JSON result and mark completed only for the current unexpired lease. Require model and preprocessing versions with the result. Check completed state first: exact retries from the stored completing worker/token with canonically equal results succeed even after the original lease expires; conflicting retries fail. Retain completion ownership fields for this check.
- `POST /v1/jobs/{id}/fail`: release an unexpired owned lease into persisted exponential retry with jitter, or terminal failed state after a bounded attempt count. Accept a bounded error code, without private payloads or exception dumps.

Use UTC epoch milliseconds internally and timezone-qualified timestamps in responses. Proposal defaults: 60-second leases, configurable per request from 1 to 900 seconds; five attempts; retry delay from 1 to 60 seconds with bounded jitter. Validate IDs, types, sizes and bounds. Invalid requests return 400, missing jobs 404, and stale/expired/conflicting lease operations 409. Claiming no work returns 200 with a null job.

## Recovery and invariants

Expired leases become eligible for reclaim without relying on an in-memory timer or startup reset. Each claim increments attempts and changes the token. Expired jobs at the attempt limit become terminal failures. A stale worker can neither renew nor complete a reclaimed job. Never hold a transaction during audio processing or other external work. Acknowledgment means a result is durably stored; accepting an event alone never means analysis completed.

Every claim transaction first marks expired leases at the attempt limit failed, then selects eligible work. Inspection is read-only and may show an expired lease until a claim sweeps it; include expiry timestamps so this is visible. A lease is expired when now is greater than or equal to its expiry for all operations. Recovery never grants an expired worker new ownership without a new claim token.

This increment provides the queue and local API, not automatic inference, audio handling, LAN authentication, Cloudflare, a connection pool, or a UI. Lease tokens are ownership fences within the localhost prototype, not network authentication.

## Verification and delivery

Write regression tests before implementation. Cover migration/backfill and repeat migration, atomic enqueue/deduplication, exclusion of reviews, concurrent claims across independent processes, lease renewal/expiry/reclaim, stale worker rejection, idempotent acknowledgments, result persistence, retry limits/backoff, restart/crash recovery, and HTTP validation/status codes. Use controlled clocks instead of sleeps for lease tests. Preserve the six existing tests.

Run the Windows unit suite, relevant static checks and isolated HTTP smoke tests without touching the user's running service or real database. Publish event/job contracts and examples, bump the local component version and reported SQLite schema version, and update PROJECT_PLAN.md to implemented status only after tests pass. Open a PR against main; report Windows CI and explicitly identify unrun Linux/hardware tests.

Migration is additive. Back up existing databases before real adoption; reverting code does not reverse migration 2. No database reset, merge, deployment, or device flashing is part of this task.
