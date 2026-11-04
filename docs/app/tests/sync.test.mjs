import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { backoffAt, createApi, pair, runSync, deriveCounts, BACKOFF } from '../sync.js';
import { buildCapture, buildReview } from '../records.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const T0 = Date.parse('2026-11-01T12:00:00.000Z');
const nowIso = () => new Date(T0).toISOString();
let n = 0;
const uuid = () => `0000000${++n}`.slice(-8) + '-0000-4000-8000-000000000000';
const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 5, 6, 7, 8]);
async function sha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// In-memory stand-in for db.js exposing the Task 6 methods the sync module uses.
function fakeDb({ paired = true } = {}) {
  const db = {
    meta: { installId: 'pwa-me', syncUrl: 'http://w', deviceToken: paired ? 'tok' : null, deviceId: paired ? 'dev' : null, deviceLabel: 'me' },
    events: new Map(), reviews: new Map(), clips: new Map(), outbox: new Map(), conflicts: new Map(),
    syncState: { cursor: 0, lastSyncAt: null, lastError: null }, applied: [], applyFail: null,
    async getMeta() { return { ...this.meta }; },
    async setMeta(p) { Object.assign(this.meta, p); },
    async getSyncState() { return { ...this.syncState }; },
    async setSyncState(p) { Object.assign(this.syncState, p); },
    async listOutbox({ states = ['pending'], before = null } = {}) {
      return [...this.outbox.values()].filter((r) => states.includes(r.state) && (before === null || (r.nextAttemptAt || 0) <= before))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    },
    async updateOutbox(id, p) { const r = this.outbox.get(id); if (r) this.outbox.set(id, { ...r, ...p }); },
    async putOutbox(row) { this.outbox.set(row.messageId, row); },
    async deleteOutbox(id) { this.outbox.delete(id); },
    async markAccepted(kind, id, when) { const m = kind === 'review' ? this.reviews : this.events; const r = m.get(id); if (r) r.acceptedAt = when; },
    async listClipsToUpload() {
      return [...this.clips.values()].filter((c) => c.origin === 'local' && c.blob && !c.uploadedAt && !c.uploadError && [...this.events.values()].some((e) => e.acceptedAt && e.envelope.payload.clipId === c.clipId))
        .map((c) => ({ clipId: c.clipId, eventId: c.eventId, messageId: c.messageId, blob: c.blob, sha256: c.sha256, sizeBytes: c.blob.size }));
    },
    async markUploaded(id, when) { this.clips.get(id).uploadedAt = when; },
    async markUploadFailed(id, reason) { this.clips.get(id).uploadError = reason; },
    async applyRemote(entries, cursor) {
      if (this.applyFail && this.applyFail(entries)) throw new Error('apply failed');
      this.applied.push({ entries, cursor });
      for (const e of entries) if (e.kind === 'clip') this.clips.set(e.clipId, { clipId: e.clipId, eventId: e.eventId, blob: null, origin: 'remote', sha256: e.sha256, remoteAvailable: true });
      this.syncState.cursor = cursor;
    },
    async listClipStubs(limit) { return [...this.clips.values()].filter((c) => !c.blob && c.remoteAvailable).slice(0, limit); },
    async storeRemoteClip(id, blob) { this.clips.get(id).blob = blob; },
    async listConflicts() { return [...this.conflicts.values()]; },
    async getEvent(eventId) { return [...this.events.values()].find((e) => e.eventId === eventId) ?? null; },
  };
  db.outboxOf = (id) => db.outbox.get(id);
  db.addCapture = (clipBytes = WAV, createdAt = nowIso()) => {
    const env = buildCapture({ installId: 'pwa-me', clipId: uuid(), sampleRate: 16000, durationMs: 50, sizeBytes: clipBytes.length, sha256: 'ab'.repeat(32), clippedSamples: 0, recordedAt: createdAt, interrupted: false, uuid, now: () => createdAt });
    db.events.set(env.messageId, { messageId: env.messageId, eventId: env.eventId, createdAt, acceptedAt: null, envelope: env });
    db.clips.set(env.payload.clipId, { clipId: env.payload.clipId, eventId: env.eventId, messageId: env.messageId, blob: new Blob([clipBytes]), origin: 'local', sha256: env.payload.sha256, uploadedAt: null });
    db.outbox.set(env.messageId, { messageId: env.messageId, kind: 'event', state: 'pending', attempts: 0, createdAt, nextAttemptAt: 0 });
    return env;
  };
  db.addReview = (eventId, previous, editedAt = nowIso()) => {
    const doc = buildReview({ eventId, reviewId: previous?.reviewId ?? uuid(), previous, fields: { context: 'food' }, uuid, now: () => editedAt });
    db.reviews.set(doc.messageId, { ...doc, acceptedAt: null });
    db.outbox.set(doc.messageId, { messageId: doc.messageId, kind: 'review', state: 'pending', attempts: 0, createdAt: editedAt, nextAttemptAt: 0 });
    return doc;
  };
  return db;
}

// Scripted fetch: `routes` maps "METHOD path" to a handler(req) → {status, body}; records calls.
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    calls.push({ key, url: u, init });
    const handler = routes[key] ?? routes[Object.keys(routes).find((k) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))];
    if (!handler) throw new TypeError('no route ' + key);
    const r = await handler({ url: u, init, json: () => JSON.parse(init.body) });
    if (r instanceof Error) throw r;
    const body = r.body instanceof Uint8Array ? r.body : JSON.stringify(r.body ?? {});
    return new Response(body, { status: r.status, headers: { 'Content-Type': r.body instanceof Uint8Array ? 'audio/wav' : 'application/json' } });
  };
  f.calls = calls;
  return f;
}
const api = (db, fetchImpl) => createApi({ baseUrl: db.meta.syncUrl, token: db.meta.deviceToken, fetchImpl });
const emptyPull = () => ({ status: 200, body: { entries: [], cursor: 0, more: false } });
const acceptAll = (req) => ({ status: 200, body: { results: req.json().messages.map((m) => ({ messageId: m.body.messageId, status: 'accepted' })) } });

test('backoffAt follows min(10 min, 5 s * 2^attempts) with ±20% jitter', () => {
  assert.equal(BACKOFF.baseMs, 5000); assert.equal(BACKOFF.maxMs, 600000);
  assert.equal(backoffAt(0, T0, () => 0.5), T0 + 5000);
  assert.equal(backoffAt(3, T0, () => 0.5), T0 + 40000);
  assert.equal(backoffAt(0, T0, () => 0), T0 + 4000);
  assert.equal(backoffAt(0, T0, () => 1), T0 + 6000);
  assert.equal(backoffAt(20, T0, () => 0.5), T0 + 600000);
});

test('pushes pending rows in createdAt order, events before reviews, 50 per batch; accepted rows are removed and acceptedAt set', async () => {
  const db = fakeDb();
  const caps = [];
  for (let i = 0; i < 60; i++) caps.push(db.addCapture(WAV, new Date(T0 + i * 1000).toISOString()));
  const rev = db.addReview(caps[0].eventId, null, new Date(T0).toISOString()); // older than most events, still after them
  const batches = [];
  const fetchImpl = fakeFetch({
    'POST /v1/messages': (req) => { batches.push(req.json().messages); return acceptAll(req); },
    'PUT /v1/clips/*': () => ({ status: 201, body: {} }),
    'GET /v1/sync': emptyPull,
  });
  const res = await runSync(db, api(db, fetchImpl), { now: () => T0 });
  assert.equal(res.outcome, 'ok');
  assert.equal(res.pushed, 61);
  assert.deepEqual(batches.map((b) => b.length), [50, 11]);
  const ids = batches.flat().map((m) => m.body.messageId);
  assert.deepEqual(ids.slice(0, 60), caps.map((c) => c.messageId));
  assert.equal(ids[60], rev.messageId);
  assert.equal(batches.flat()[0].kind, 'event'); assert.equal(batches.flat()[60].kind, 'review');
  assert.equal(db.outbox.size, 0);
  assert.equal(db.events.get(caps[5].messageId).acceptedAt, nowIso());
  assert.equal(db.reviews.get(rev.messageId).acceptedAt, nowIso());
});

test('duplicate counts as accepted', async () => {
  const db = fakeDb();
  const cap = db.addCapture();
  const fetchImpl = fakeFetch({
    'POST /v1/messages': () => ({ status: 200, body: { results: [{ messageId: cap.messageId, status: 'duplicate' }] } }),
    'PUT /v1/clips/*': () => ({ status: 200, body: {} }),
    'GET /v1/sync': emptyPull,
  });
  const res = await runSync(db, api(db, fetchImpl), { now: () => T0 });
  assert.equal(res.pushed, 1); assert.equal(db.outbox.size, 0); assert.ok(db.events.get(cap.messageId).acceptedAt);
});

test('revision_conflict marks the outbox row conflict and the review is reported failed', async () => {
  const db = fakeDb();
  const cap = db.addCapture();
  const rev = db.addReview(cap.eventId, null);
  const fetchImpl = fakeFetch({
    'POST /v1/messages': (req) => ({ status: 200, body: { results: req.json().messages.map((m) => (m.kind === 'review'
      ? { messageId: m.body.messageId, status: 'conflict', reason: 'revision_conflict', latestRevision: 1 }
      : { messageId: m.body.messageId, status: 'accepted' })) } }),
    'PUT /v1/clips/*': () => ({ status: 201, body: {} }),
    'GET /v1/sync': emptyPull,
  });
  const res = await runSync(db, api(db, fetchImpl), { now: () => T0 });
  assert.equal(res.failed, 1);
  assert.deepEqual(db.outboxOf(rev.messageId), { ...db.outboxOf(rev.messageId), state: 'conflict', lastError: 'revision_conflict' });
  assert.equal(db.reviews.get(rev.messageId).acceptedAt, null);
});

test('payload_mismatch and rejected mark the row failed with the reason and never retry', async () => {
  const db = fakeDb();
  const a = db.addCapture(); const b = db.addCapture();
  const fetchImpl = fakeFetch({
    'POST /v1/messages': () => ({ status: 200, body: { results: [
      { messageId: a.messageId, status: 'conflict', reason: 'payload_mismatch' },
      { messageId: b.messageId, status: 'rejected', reason: '$.eventId: required property missing' },
    ] } }),
    'GET /v1/sync': emptyPull,
  });
  await runSync(db, api(db, fetchImpl), { now: () => T0 });
  assert.equal(db.outboxOf(a.messageId).state, 'failed'); assert.equal(db.outboxOf(a.messageId).lastError, 'payload_mismatch');
  assert.equal(db.outboxOf(b.messageId).state, 'failed'); assert.match(db.outboxOf(b.messageId).lastError, /eventId/);
  const again = await runSync(db, api(db, fetchImpl), { now: () => T0 + 1 });
  assert.equal(again.pushed, 0);
  assert.equal(fetchImpl.calls.filter((c) => c.key === 'POST /v1/messages').length, 1);
});

test('network failure increments attempts, sets nextAttemptAt inside the backoff window and stops the run', async () => {
  const db = fakeDb();
  const cap = db.addCapture();
  const fetchImpl = fakeFetch({ 'POST /v1/messages': () => new TypeError('fetch failed') });
  const res = await runSync(db, api(db, fetchImpl), { now: () => T0 });
  assert.equal(res.outcome, 'offline');
  const row = db.outboxOf(cap.messageId);
  assert.equal(row.state, 'pending'); assert.equal(row.attempts, 1); assert.equal(row.lastError, 'network');
  assert.ok(row.nextAttemptAt >= T0 + 4000 && row.nextAttemptAt <= T0 + 6000, String(row.nextAttemptAt - T0));
  assert.equal(fetchImpl.calls.length, 1, 'no pull after a failed push');
  assert.equal(db.syncState.lastError, 'network');
});

test('rows whose nextAttemptAt is in the future are skipped', async () => {
  const db = fakeDb();
  const cap = db.addCapture();
  db.outboxOf(cap.messageId).nextAttemptAt = T0 + 60000;
  const fetchImpl = fakeFetch({ 'POST /v1/messages': acceptAll, 'GET /v1/sync': emptyPull });
  const res = await runSync(db, api(db, fetchImpl), { now: () => T0 });
  assert.equal(res.pushed, 0);
  assert.equal(fetchImpl.calls.filter((c) => c.key === 'POST /v1/messages').length, 0);
});

test('a 5xx on push is retried with backoff like a network error', async () => {
  const db = fakeDb();
  const cap = db.addCapture();
  const fetchImpl = fakeFetch({ 'POST /v1/messages': () => ({ status: 500, body: { error: 'internal' } }) });
  const res = await runSync(db, api(db, fetchImpl), { now: () => T0 });
  assert.equal(res.outcome, 'error');
  assert.equal(db.outboxOf(cap.messageId).attempts, 1);
  assert.equal(db.outboxOf(cap.messageId).lastError, 'http_500');
});

test('clips of accepted captures are uploaded with the WAV body; a clip mismatch marks the event failed without retry', async () => {
  const db = fakeDb();
  const good = db.addCapture(WAV);
  const bad = db.addCapture(new Uint8Array([9, 9, 9, 9]));
  const puts = [];
  const fetchImpl = fakeFetch({
    'POST /v1/messages': acceptAll,
    'PUT /v1/clips/*': async (req) => {
      puts.push({ id: req.url.pathname.split('/').pop(), type: req.init.headers['Content-Type'], len: req.init.body.byteLength ?? req.init.body.size });
      return req.url.pathname.endsWith(bad.payload.clipId) ? { status: 409, body: { error: 'clip_mismatch' } } : { status: 201, body: {} };
    },
    'GET /v1/sync': emptyPull,
  });
  const res = await runSync(db, api(db, fetchImpl), { now: () => T0 });
  assert.equal(res.uploaded, 1); assert.equal(res.failed, 1);
  assert.deepEqual(puts.map((p) => p.type), ['audio/wav', 'audio/wav']);
  assert.equal(db.clips.get(good.payload.clipId).uploadedAt, nowIso());
  assert.equal(db.clips.get(bad.payload.clipId).uploadedAt, null);
  const failed = db.outboxOf(bad.messageId);
  assert.equal(failed.state, 'failed'); assert.equal(failed.lastError, 'clip_mismatch'); assert.equal(failed.kind, 'event');
  const again = await runSync(db, api(db, fetchImpl), { now: () => T0 + 1 });
  assert.equal(again.uploaded, 0);
  assert.equal(puts.length, 2, 'mismatched clip must not be re-sent');
});

test('pulls pages until more is false, applying each page before requesting the next; the cursor only advances with an applied page', async () => {
  const db = fakeDb();
  const pages = {
    0: { entries: [{ seq: 1, kind: 'message', messageKind: 'event', body: { messageId: 'm1' } }, { seq: 2, kind: 'message', messageKind: 'event', body: { messageId: 'm2' } }], cursor: 2, more: true },
    2: { entries: [{ seq: 3, kind: 'message', messageKind: 'review', body: { messageId: 'm3' } }], cursor: 3, more: true },
    3: { entries: [{ seq: 4, kind: 'clip', clipId: 'c4', eventId: 'e4', sha256: 'x', sizeBytes: 1 }], cursor: 4, more: false },
  };
  const fetchImpl = fakeFetch({ 'GET /v1/sync': (req) => ({ status: 200, body: pages[Number(req.url.searchParams.get('cursor'))] }), 'GET /v1/clips/*': () => ({ status: 404, body: {} }) });
  db.applyFail = (entries) => entries.some((e) => e.seq === 3);
  const res = await runSync(db, api(db, fetchImpl), { now: () => T0 });
  assert.equal(res.outcome, 'error');
  assert.equal(db.syncState.cursor, 2);
  assert.deepEqual(fetchImpl.calls.filter((c) => c.key === 'GET /v1/sync').map((c) => c.url.searchParams.get('cursor')), ['0', '2']);
  db.applyFail = null;
  const res2 = await runSync(db, api(db, fetchImpl), { now: () => T0 });
  assert.equal(res2.outcome, 'ok'); assert.equal(res2.pulled, 2); assert.equal(db.syncState.cursor, 4);
  assert.deepEqual(db.applied.map((a) => a.cursor), [2, 3, 4]);
  assert.equal(db.syncState.lastSyncAt, nowIso());
});

test('downloads at most 20 clip stubs per run, verifying sha256 before storing; a hash mismatch is skipped and reported', async () => {
  const db = fakeDb();
  const goodHash = await sha256(WAV);
  const entries = [];
  for (let i = 0; i < 25; i++) entries.push({ seq: i + 1, kind: 'clip', clipId: 'c' + i, eventId: 'e' + i, sha256: i === 0 ? 'ff'.repeat(32) : goodHash, sizeBytes: WAV.length });
  const fetchImpl = fakeFetch({
    'GET /v1/sync': (req) => (Number(req.url.searchParams.get('cursor')) === 0 ? { status: 200, body: { entries, cursor: 25, more: false } } : emptyPull()),
    'GET /v1/clips/*': () => ({ status: 200, body: WAV }),
  });
  const res = await runSync(db, api(db, fetchImpl), { now: () => T0 });
  assert.equal(res.downloaded, 19); assert.equal(res.failed, 1);
  assert.equal(fetchImpl.calls.filter((c) => c.key.startsWith('GET /v1/clips/')).length, 20);
  assert.equal(db.clips.get('c0').blob, null, 'mismatched clip must not be stored');
  assert.ok(db.clips.get('c1').blob);
  assert.equal([...db.clips.values()].filter((c) => c.blob).length, 19);
});

test('401 forgets the token and keeps the outbox', async () => {
  const db = fakeDb();
  const cap = db.addCapture();
  const fetchImpl = fakeFetch({ 'POST /v1/messages': () => ({ status: 401, body: { error: 'unauthorized' } }) });
  const res = await runSync(db, api(db, fetchImpl), { now: () => T0 });
  assert.equal(res.outcome, 'unauthorized');
  assert.equal(db.meta.deviceToken, null); assert.equal(db.meta.deviceId, null);
  assert.equal(db.meta.syncUrl, 'http://w', 'server URL is kept for re-pairing');
  assert.equal(db.outboxOf(cap.messageId).state, 'pending');
});

test('not paired returns unpaired without any request', async () => {
  const db = fakeDb({ paired: false });
  db.addCapture();
  const fetchImpl = fakeFetch({});
  const res = await runSync(db, api(db, fetchImpl), { now: () => T0 });
  assert.equal(res.outcome, 'unpaired'); assert.equal(fetchImpl.calls.length, 0);
});

test('a second runSync while one runs returns busy and the first run reruns once', async () => {
  const db = fakeDb();
  let release;
  const gate = new Promise((r) => { release = r; });
  let pulls = 0;
  const fetchImpl = fakeFetch({ 'GET /v1/sync': async () => { pulls++; if (pulls === 1) await gate; return emptyPull(); } });
  const first = runSync(db, api(db, fetchImpl), { now: () => T0 });
  const second = await runSync(db, api(db, fetchImpl), { now: () => T0 });
  assert.equal(second.outcome, 'busy');
  release();
  const res = await first;
  assert.equal(res.outcome, 'ok');
  assert.equal(pulls, 2, 'the queued request causes exactly one rerun');
});

test('pair exchanges a code for a token and reports failures by kind', async () => {
  const fetchImpl = fakeFetch({ 'POST /v1/devices/pair': (req) => (req.json().code === 'GOODCODE' ? { status: 201, body: { deviceId: 'd1', token: 't1', protocolVersion: 1 } } : { status: 401, body: { error: 'unauthorized' } }) });
  const ok = await pair({ baseUrl: 'http://w/', code: 'good code', sourceId: 'pwa-me', version: '0.2.0', label: 'L', fetchImpl });
  assert.deepEqual(ok, { ok: true, deviceId: 'd1', token: 't1' });
  assert.equal(fetchImpl.calls[0].url.href, 'http://w/v1/devices/pair');
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).code, 'GOODCODE');
  const bad = await pair({ baseUrl: 'http://w', code: 'nope', sourceId: 'pwa-me', version: '0.2.0', label: 'L', fetchImpl });
  assert.deepEqual(bad, { ok: false, reason: 'rejected' });
  const down = await pair({ baseUrl: 'http://w', code: 'x', sourceId: 'pwa-me', version: '0.2.0', label: 'L', fetchImpl: async () => { throw new TypeError('x'); } });
  assert.deepEqual(down, { ok: false, reason: 'network' });
});

test('deriveCounts splits events into local, queued, synced and failed', () => {
  const ev = (messageId, sourceId, acceptedAt, clipId) => ({ envelope: { messageId, eventId: 'e-' + messageId, sourceId, payload: { clipId } }, acceptedAt, deleted: false });
  const events = [ev('a', 'pwa-me', null, 'ca'), ev('b', 'pwa-me', '2026', 'cb'), ev('c', 'pwa-other', null, 'cc'), ev('d', 'pwa-me', '2026', 'cd')];
  const outbox = [{ messageId: 'a', state: 'pending' }, { messageId: 'd', state: 'failed' }];
  const clips = new Map([['cb', { uploadedAt: '2026', origin: 'local' }], ['cc', { origin: 'remote' }], ['cd', { uploadedAt: '2026', origin: 'local' }]]);
  assert.deepEqual(deriveCounts({ events, outbox, clips, installId: 'pwa-me', paired: true }), { local: 0, queued: 1, synced: 2, failed: 1 });
  assert.deepEqual(deriveCounts({ events, outbox, clips, installId: 'pwa-me', paired: false }), { local: 4, queued: 0, synced: 0, failed: 0 });
});
