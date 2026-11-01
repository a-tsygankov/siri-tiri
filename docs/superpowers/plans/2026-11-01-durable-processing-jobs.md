# Durable Processing Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Durably enqueue capture processing, fence concurrent workers with leases, and recover interrupted work.

**Architecture:** Keep storage transaction boundaries in the existing connection context manager. Add a focused jobs module using SQLite write transactions; wire its methods into versioned localhost routes. No inference or external dependencies.

**Tech Stack:** Python 3.11+, stdlib sqlite3/unittest/http.server.

**Spec:** ../specs/2026-11-01-durable-processing-jobs-design.md (approved by user on 2026-11-01).

## Global Constraints

- Preserve 127.0.0.1 binding, existing envelopes and six tests, owner reviews and existing databases.
- Lease defaults: 60 seconds; allowed 1..900 seconds; five attempts; retries 1..60 seconds with jitter.
- Use one connection per operation; never hold a transaction during inference.
- Additive transactional migration 2; component 0.2.0; protocol 1 unchanged.

## Review Focus

- Competing independent processes must never receive the same live lease.
- Lost acknowledgment responses must remain safely retryable after expiry/restart.
- Migration or enqueue failure must roll back the entire change.
- Malformed JSON, booleans as integers, nonfinite results and oversized values must be rejected.
- An exhausted expired lease must reach terminal failure without blocking other work.

### Task 1: Durable store and migration

Files: create local-service/jobs.py and local-service/tests/test_jobs.py; modify service.py.

Interfaces: jobs.migrate(db), jobs.enqueue(db, event), jobs.list_jobs(connect, limit=100), jobs.claim(connect, body), jobs.heartbeat(connect, job_id, body), jobs.ack(connect, job_id, body), jobs.fail(connect, job_id, body). Clock: jobs.now_ms(); times are epoch milliseconds in storage and ISO UTC at the boundary. Job ID equals immutable capture message ID.

- [x] Write tests for migration/backfill/repeat/newer-schema rejection, atomic enqueue, deduplication/exclusions, ownership, expiry, retries, results and cross-process recovery/concurrency.
- [x] Run tests and observe failures before implementation.
- [x] Implement migrations and job operations with BEGIN IMMEDIATE, fenced tokens, bounded validated inputs and deterministic completion retry semantics.
- [ ] Run the complete suite, inspect output, and commit the storage implementation and tests.

### Task 2: HTTP and contracts

Files: modify service.py; create local-service/tests/test_job_http.py and contracts/jobs.v1.schema.json; update contracts/README.md and local-service/README.md.

Interfaces: GET /v1/jobs, POST /v1/jobs/claim, POST /v1/jobs/{jobId}/{heartbeat,ack,fail}. Request schemaVersion=1 is mandatory. Responses use {schemaVersion:1, job:...}; listing uses {schemaVersion:1, items:[...]}. Empty claim returns job:null. Success is 200; malformed input 400, unknown ID 404, lease conflict 409, invalid body size 413.

- [x] Write failing isolated HTTP tests covering successful lifecycle, rejection codes, legacy routes and token-free inspection.
- [ ] Implement routes, version metadata and JSON Schema request contracts with examples; keep existing endpoints compatible.
- [ ] Run the full suite and an isolated HTTP smoke check; commit API and documentation.

### Task 3: Review and delivery

- [ ] Update approved spec status and PROJECT_PLAN.md to the implemented scope.
- [ ] Run Python syntax, JSON parsing, git diff --check, and the documented Windows test command.
- [ ] Obtain independent whole-branch review; resolve actionable issues with regression tests.
- [ ] Push, update PR #4 title/body to final implementation, mark ready and inspect CI. Report unrun Linux/hardware checks and migration rollback limits.
