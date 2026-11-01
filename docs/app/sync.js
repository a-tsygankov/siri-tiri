// Cloud sync: push the outbox, upload clips, pull by cursor, download clips. Pure logic over an
// injected db (db.js) and fetch, so Node tests can drive it. Nothing here touches the DOM.
import { PROTOCOL_VERSION } from './version.js';
import { isRemote } from './records.js';

export const BACKOFF = { baseMs: 5000, maxMs: 600000, jitter: 0.2 };
export const PUSH_BATCH = 50;
export const PULL_LIMIT = 200;
export const DOWNLOADS_PER_RUN = 20;
export const REQUEST_TIMEOUT_MS = 30000;

// Next attempt time: min(maxMs, baseMs * 2^attempts) with ±jitter.
export function backoffAt(attempts, now, random = Math.random) {
  const delay = Math.min(BACKOFF.maxMs, BACKOFF.baseMs * 2 ** attempts);
  const factor = 1 - BACKOFF.jitter + 2 * BACKOFF.jitter * random();
  return Math.round(now + delay * factor);
}

const trimSlash = (u) => String(u || '').replace(/\/+$/, '');

async function request(fetchImpl, url, init, timeoutMs) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try { res = await fetchImpl(url, ctrl ? { ...init, signal: ctrl.signal } : init); } catch (e) {
    const err = new Error('network'); err.cause = e; throw err;
  } finally { if (timer) clearTimeout(timer); }
  return res;
}

async function parse(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

// Every method resolves {ok, status, body} and rejects with Error('network') on fetch failure or timeout.
export function createApi({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const base = trimSlash(baseUrl);
  const auth = () => (token ? { Authorization: `Bearer ${token}` } : {});
  const json = async (method, path, body, extra = {}) => {
    const res = await request(fetchImpl, base + path, {
      method, headers: { 'Content-Type': 'application/json', ...auth(), ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
    }, timeoutMs);
    return { ok: res.ok, status: res.status, body: await parse(res) };
  };
  return {
    health: () => json('GET', '/v1/health'),
    pushMessages: (items) => json('POST', '/v1/messages', { messages: items }),
    pull: (cursor, limit = PULL_LIMIT) => json('GET', `/v1/sync?cursor=${cursor}&limit=${limit}`),
    putClip: async (clipId, blob) => {
      const res = await request(fetchImpl, `${base}/v1/clips/${clipId}`, { method: 'PUT', headers: { 'Content-Type': 'audio/wav', ...auth() }, body: blob }, timeoutMs * 2);
      return { ok: res.ok, status: res.status, body: await parse(res) };
    },
    getClip: async (clipId) => {
      const res = await request(fetchImpl, `${base}/v1/clips/${clipId}`, { method: 'GET', headers: auth() }, timeoutMs * 2);
      if (!res.ok) return { ok: false, status: res.status, body: await parse(res) };
      return { ok: true, status: res.status, bytes: await res.arrayBuffer() };
    },
  };
}

// Exchange a pairing code for a device token. Resolves {ok: true, deviceId, token} or
// {ok: false, reason: 'rejected' | 'network' | 'protocol'}.
export async function pair({ baseUrl, code, sourceId, version, label, fetchImpl = globalThis.fetch }) {
  const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  let res;
  try {
    res = await request(fetchImpl, `${trimSlash(baseUrl)}/v1/devices/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: normalized, sourceId, component: 'pwa', version, label }),
    }, REQUEST_TIMEOUT_MS);
  } catch { return { ok: false, reason: 'network' }; }
  if (res.status === 201) {
    const body = await parse(res);
    if (body.protocolVersion !== PROTOCOL_VERSION) return { ok: false, reason: 'protocol' };
    return { ok: true, deviceId: body.deviceId, token: body.token };
  }
  return { ok: false, reason: res.status === 401 ? 'rejected' : 'network' };
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

class Stop extends Error { constructor(outcome, error) { super(outcome); this.outcome = outcome; this.error = error; } }

let running = null;
let rerun = false;

// One sync run. Serialized: a call during a run returns {outcome: 'busy'} and makes the current
// run go once more when it finishes. Outcomes: ok | busy | unpaired | offline | unauthorized | error.
export async function runSync(db, api, opts = {}) {
  if (running) { rerun = true; return { outcome: 'busy', pushed: 0, uploaded: 0, pulled: 0, downloaded: 0, failed: 0 }; }
  running = (async () => {
    let result = await runOnce(db, api, opts);
    while (rerun) { rerun = false; result = await runOnce(db, api, opts); }
    return result;
  })();
  try { return await running; } finally { running = null; }
}

async function runOnce(db, api, { now = () => Date.now(), onProgress = () => {}, canDownload = () => true, random = Math.random } = {}) {
  const stats = { outcome: 'ok', pushed: 0, uploaded: 0, pulled: 0, downloaded: 0, failed: 0 };
  const meta = await db.getMeta();
  if (!meta.deviceToken || !meta.syncUrl) return { ...stats, outcome: 'unpaired' };
  const t = () => new Date(now()).toISOString();
  const unauthorized = async () => { await db.setMeta({ deviceToken: null, deviceId: null }); throw new Stop('unauthorized'); };
  const fail = async (rows, reason) => {
    for (const r of rows) await db.updateOutbox(r.messageId, { attempts: (r.attempts || 0) + 1, nextAttemptAt: backoffAt(r.attempts || 0, now(), random), lastError: reason });
    throw new Stop(reason === 'network' ? 'offline' : 'error', reason);
  };

  try {
    // 1. Push messages: events (captures, tombstones) before reviews, each by creation time.
    const pending = await db.listOutbox({ states: ['pending'], before: now() });
    const ordered = [...pending.filter((r) => r.kind !== 'review'), ...pending.filter((r) => r.kind === 'review')];
    for (let i = 0; i < ordered.length; i += PUSH_BATCH) {
      const rows = ordered.slice(i, i + PUSH_BATCH);
      const items = [];
      for (const r of rows) {
        const doc = r.kind === 'review' ? await docOf(db, 'review', r.messageId) : await docOf(db, 'event', r.messageId);
        if (!doc) { await db.deleteOutbox(r.messageId); continue; }
        items.push({ kind: r.kind === 'review' ? 'review' : 'event', body: doc, _row: r });
      }
      if (!items.length) continue;
      let res;
      try { res = await api.pushMessages(items.map(({ kind, body }) => ({ kind, body }))); } catch { await fail(rows, 'network'); }
      if (res.status === 401) await unauthorized();
      if (!res.ok) await fail(rows, `http_${res.status}`);
      const byId = new Map((res.body.results || []).map((x) => [x.messageId, x]));
      for (const it of items) {
        const r = byId.get(it.body.messageId) || { status: 'rejected', reason: 'no_result' };
        if (r.status === 'accepted' || r.status === 'duplicate') {
          await db.markAccepted(it.kind, it.body.messageId, t());
          await db.deleteOutbox(it.body.messageId);
          stats.pushed++;
        } else {
          const state = r.reason === 'revision_conflict' ? 'conflict' : 'failed';
          await db.updateOutbox(it.body.messageId, { state, lastError: r.reason || r.status });
          stats.failed++;
        }
      }
      onProgress({ phase: 'push', ...stats });
    }

    // 2. Upload clips of accepted captures.
    for (const clip of await db.listClipsToUpload()) {
      let res;
      try { res = await api.putClip(clip.clipId, clip.blob); } catch { await fail([], 'network'); }
      if (res.status === 401) await unauthorized();
      if (res.ok) { await db.markUploaded(clip.clipId, t()); stats.uploaded++; continue; }
      if (res.status === 409 || res.status === 404 || res.status === 410 || res.status === 403) {
        // Terminal: the Worker will never take this WAV. Surface it on the capture message.
        const reason = res.body?.error || `http_${res.status}`;
        await db.markUploadFailed(clip.clipId, reason);
        await db.putOutbox({ messageId: clip.messageId, kind: 'event', state: 'failed', attempts: 0, createdAt: t(), nextAttemptAt: 0, lastError: reason });
        stats.failed++;
        continue;
      }
      await fail([], `http_${res.status}`);
    }
    onProgress({ phase: 'upload', ...stats });

    // 3. Pull by cursor, one page at a time; the cursor moves only with an applied page.
    let { cursor } = await db.getSyncState();
    for (;;) {
      let res;
      try { res = await api.pull(cursor); } catch { throw new Stop('offline', 'network'); }
      if (res.status === 401) await unauthorized();
      if (!res.ok) throw new Stop('error', `http_${res.status}`);
      const { entries = [], cursor: next = cursor, more = false } = res.body;
      if (entries.length) {
        try { await db.applyRemote(entries, next); } catch (e) { throw new Stop('error', 'apply_failed'); }
        stats.pulled += entries.length;
        cursor = next;
      }
      onProgress({ phase: 'pull', ...stats });
      if (!more || !entries.length) break;
    }

    // 4. Download missing remote clips, newest first, bounded per run.
    if (canDownload()) {
      for (const stub of await db.listClipStubs(DOWNLOADS_PER_RUN)) {
        const r = await downloadClip(db, api, stub);
        if (r === 'unauthorized') await unauthorized();
        if (r === 'network') throw new Stop('offline', 'network');
        if (r === 'ok') stats.downloaded++; else stats.failed++;
        onProgress({ phase: 'download', ...stats });
      }
    }

    await db.setSyncState({ lastSyncAt: t(), lastError: null });
    return stats;
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    await db.setSyncState({ lastError: e.error || e.outcome }).catch(() => {});
    return { ...stats, outcome: e.outcome };
  }
}

// Fetches one remote clip, verifies its SHA-256 against the clip row and stores it.
// Resolves 'ok' | 'network' | 'unauthorized' | 'missing' | 'mismatch'.
export async function downloadClip(db, api, stub) {
  let res;
  try { res = await api.getClip(stub.clipId); } catch { return 'network'; }
  if (res.status === 401) return 'unauthorized';
  if (!res.ok) return 'missing';
  const hash = await sha256Hex(res.bytes);
  if (stub.sha256 && hash !== stub.sha256.toLowerCase()) return 'mismatch';
  await db.storeRemoteClip(stub.clipId, new Blob([res.bytes], { type: 'audio/wav' }));
  return 'ok';
}

async function docOf(db, kind, messageId) {
  if (kind === 'review') {
    const all = await db.allReviews?.();
    if (all) { for (const list of all.values()) { const d = list.find((x) => x.messageId === messageId); if (d) return d; } }
    return db.reviews?.get?.(messageId) ? stripLocal(db.reviews.get(messageId)) : null;
  }
  const rows = await db.listEvents?.({ includeDeleted: true });
  if (rows) {
    const hit = rows.find((r) => r.envelope.messageId === messageId);
    if (hit) return hit.envelope;
    const tomb = (await db.listTombstones()).find((tb) => tb.messageId === messageId);
    if (tomb) return tomb;
    return null;
  }
  return db.events?.get?.(messageId)?.envelope ?? null;
}

function stripLocal(row) {
  const { eventRevision, acceptedAt, ...doc } = row;
  return doc;
}

// Per-event sync counts for Today. `clips` is a Map clipId → clip row (blob omitted).
export function deriveCounts({ events, outbox, clips, installId, paired }) {
  const out = { local: 0, queued: 0, synced: 0, failed: 0 };
  if (!paired) { out.local = events.length; return out; }
  const byEvent = new Map();
  for (const r of outbox) {
    const eventId = r.eventId || eventIdOf(events, r.messageId);
    if (!byEvent.has(eventId)) byEvent.set(eventId, []);
    byEvent.get(eventId).push(r);
  }
  for (const ev of events) {
    const rows = byEvent.get(ev.envelope.eventId) || [];
    if (rows.some((r) => r.state === 'failed' || r.state === 'conflict')) { out.failed++; continue; }
    if (rows.some((r) => r.state === 'pending' || r.state === 'sent')) { out.queued++; continue; }
    if (isRemote(ev.envelope, installId)) { out.synced++; continue; }
    const clip = clips.get(ev.envelope.payload?.clipId);
    if (!ev.acceptedAt || (!ev.deleted && clip && clip.origin !== 'remote' && !clip.uploadedAt)) out.queued++;
    else out.synced++;
  }
  return out;
}

function eventIdOf(events, messageId) {
  const hit = events.find((e) => e.envelope.messageId === messageId);
  return hit ? hit.envelope.eventId : null;
}
