// IndexedDB layer. Append-only events/reviews; mutable: drafts, meta, syncState, outbox state,
// events.exportedAt/acceptedAt and clips.uploadedAt/blob (remote clip download).
// Uses only the `indexedDB` and `crypto` globals.

import { currentCapture, originalCapture } from './records.js';

const DB_VERSION = 2;
const STORES = ['events', 'clips', 'reviews', 'drafts', 'outbox', 'meta', 'syncState', 'conflicts'];
// Cleared by clearAll; meta (pairing) and syncState survive, with the cursor reset.
const DATA_STORES = ['events', 'clips', 'reviews', 'drafts', 'outbox', 'conflicts'];

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Run `fn(stores)` inside one transaction; resolve with fn's result once the tx completes.
// If fn throws/rejects the transaction is aborted so nothing is persisted.
// `options` (e.g. { durability: 'strict' }) is ignored by browsers that do not support it.
function run(db, names, mode, fn, options) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = options ? db.transaction(names, mode, options) : db.transaction(names, mode); } catch (e) { reject(e); return; }
    const stores = {};
    for (const n of names) stores[n] = tx.objectStore(n);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    Promise.resolve().then(() => fn(stores)).then((r) => { result = r; }, (e) => {
      try { tx.abort(); } catch (_) { /* already finished */ }
      reject(e);
    });
  });
}

// Version 1 created the six original stores; version 2 adds syncState and conflicts.
// Nothing is dropped; rows without the v2 fields get defaults on read.
function upgrade(db, oldVersion) {
  if (oldVersion < 1) {
    const events = db.createObjectStore('events', { keyPath: 'messageId' });
    events.createIndex('eventId', 'eventId');
    events.createIndex('createdAt', 'createdAt');
    db.createObjectStore('clips', { keyPath: 'clipId' });
    const reviews = db.createObjectStore('reviews', { keyPath: 'messageId' });
    reviews.createIndex('eventId', 'eventId');
    // Unique: two revisions with the same number for one event can never both be stored.
    reviews.createIndex('eventRevision', 'eventRevision', { unique: true });
    db.createObjectStore('drafts', { keyPath: 'eventId' });
    db.createObjectStore('outbox', { keyPath: 'messageId' });
    db.createObjectStore('meta', { keyPath: 'key' });
  }
  if (oldVersion < 2) {
    db.createObjectStore('syncState', { keyPath: 'key' });
    const conflicts = db.createObjectStore('conflicts', { keyPath: 'messageId' });
    conflicts.createIndex('eventId', 'eventId');
  }
}

const META_DEFAULTS = { persistGranted: false, appVersionAtLastRun: null, syncUrl: null, deviceId: null, deviceToken: null, deviceLabel: null };
const SYNC_DEFAULTS = { cursor: 0, lastSyncAt: null, lastError: null };

function outboxRow(messageId, kind, createdAt) {
  return { messageId, kind, state: 'pending', attempts: 0, createdAt, nextAttemptAt: 0, lastError: null };
}

function stripReview(row) {
  const { eventRevision, acceptedAt, ...doc } = row;
  return doc;
}

function isTombstone(env) {
  return !!env.payload && env.payload.deleted === true;
}

// Capture, review and delete writes are flushed to disk before the transaction completes.
const STRICT = { durability: 'strict' };

// Inside a review-writing transaction: reject with Error('revision_conflict') unless `doc`
// extends the latest stored revision for its event (another tab may have saved meanwhile).
async function assertExtendsLatest(reviews, doc) {
  const rows = await req(reviews.index('eventId').getAll(doc.eventId));
  const latest = rows.reduce((n, r) => Math.max(n, r.revision), 0);
  const base = doc.baseRevision ?? 0;
  if (base !== latest || doc.revision !== latest + 1) throw new Error('revision_conflict');
}

function metaRows(m) {
  return Object.entries(m).map(([key, value]) => ({ key, value }));
}

export default async function openDb(name = 'siri-tiri') {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open(name, DB_VERSION);
    r.onupgradeneeded = (e) => upgrade(r.result, e.oldVersion);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('database open blocked'));
  });

  async function getMeta() {
    return run(db, ['meta'], 'readwrite', async ({ meta }) => {
      const rows = await req(meta.getAll());
      const m = {};
      for (const row of rows) m[row.key] = row.value;
      if (!m.installId) {
        const fresh = { installId: 'pwa-' + crypto.randomUUID(), schemaVersion: 1, ...META_DEFAULTS };
        for (const r of metaRows(fresh)) meta.put(r);
        return fresh;
      }
      const out = { installId: m.installId, schemaVersion: m.schemaVersion ?? 1 };
      for (const [k, d] of Object.entries(META_DEFAULTS)) out[k] = m[k] ?? d;
      return out;
    });
  }

  async function setMeta(patch) {
    await getMeta();
    await run(db, ['meta'], 'readwrite', ({ meta }) => {
      for (const r of metaRows(patch)) meta.put(r);
    });
  }

  async function saveCapture(envelope, wavBlob) {
    const clipId = envelope.payload.clipId;
    await run(db, ['events', 'clips', 'outbox'], 'readwrite', (s) => {
      s.events.put({
        messageId: envelope.messageId, eventId: envelope.eventId,
        createdAt: envelope.createdAt, exportedAt: null, acceptedAt: null, envelope,
      });
      s.clips.put({
        clipId, blob: wavBlob, size: wavBlob.size, eventId: envelope.eventId,
        origin: 'local', sha256: envelope.payload.sha256, uploadedAt: null, remoteAvailable: false,
      });
      s.outbox.put(outboxRow(envelope.messageId, 'event', envelope.createdAt));
    }, STRICT);
  }

  function loadEventRows() {
    return run(db, ['events'], 'readonly', ({ events }) => req(events.getAll()));
  }

  // One stored event from all of its message rows (captures, trims, restores, tombstones).
  // `envelope` is the current live capture (the latest trim or restore, else the original),
  // `original` the root capture, `envelopes` every live capture oldest first. Never a tombstone.
  function toStored(rows) {
    const live = rows.filter((r) => !isTombstone(r.envelope))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    if (!live.length) return null;
    const envelopes = live.map((r) => r.envelope);
    const current = currentCapture(envelopes) || envelopes[envelopes.length - 1];
    const original = originalCapture(envelopes) || envelopes[0];
    const rowOf = (env) => live.find((r) => r.messageId === env.messageId);
    return {
      envelope: current,
      original,
      envelopes,
      exportedAt: rowOf(current)?.exportedAt ?? null,
      acceptedAt: rowOf(current)?.acceptedAt ?? null,
      originalExportedAt: rowOf(original)?.exportedAt ?? null,
      deleted: rows.some((r) => isTombstone(r.envelope)),
    };
  }

  function groupByEvent(rows) {
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.eventId)) map.set(r.eventId, []);
      map.get(r.eventId).push(r);
    }
    return map;
  }

  // Deleted events are hidden unless includeDeleted; then they carry deleted: true
  // and the last live capture envelope (never the tombstone). Newest recording first.
  async function listEvents({ includeDeleted = false } = {}) {
    const rows = await loadEventRows();
    return [...groupByEvent(rows).values()]
      .map(toStored)
      .filter((ev) => ev && (includeDeleted || !ev.deleted))
      .sort((a, b) => (a.original.createdAt < b.original.createdAt ? 1 : a.original.createdAt > b.original.createdAt ? -1 : 0));
  }

  async function listTombstones() {
    const rows = await loadEventRows();
    return rows.map((r) => r.envelope).filter(isTombstone);
  }

  async function getEvent(eventId) {
    const rows = await run(db, ['events'], 'readonly', ({ events }) =>
      req(events.index('eventId').getAll(eventId)));
    return toStored(rows);
  }

  // Appends a trim (with its WAV) or a restore (wavBlob null) capture message for an existing
  // event and removes the blobs of superseded trims in the same transaction. The original
  // recording's blob is never among `removeClipIds`; only deleteClip removes it.
  async function saveTrim(envelope, wavBlob, { removeClipIds = [] } = {}) {
    await run(db, ['events', 'clips', 'outbox'], 'readwrite', (s) => {
      s.events.put({
        messageId: envelope.messageId, eventId: envelope.eventId,
        createdAt: envelope.createdAt, exportedAt: null, acceptedAt: null, envelope,
      });
      if (wavBlob) {
        s.clips.put({
          clipId: envelope.payload.clipId, blob: wavBlob, size: wavBlob.size, eventId: envelope.eventId,
          origin: 'local', sha256: envelope.payload.sha256, uploadedAt: null, remoteAvailable: false,
        });
      }
      for (const id of removeClipIds) if (id !== envelope.payload.clipId) s.clips.delete(id);
      s.outbox.put(outboxRow(envelope.messageId, 'event', envelope.createdAt));
    }, STRICT);
  }

  async function getClip(clipId) {
    const row = await run(db, ['clips'], 'readonly', ({ clips }) => req(clips.get(clipId)));
    return row && row.blob ? row.blob : null;
  }

  // Every clips row without its blob, as a Map by clipId.
  async function listClipRows() {
    const rows = await run(db, ['clips'], 'readonly', ({ clips }) => req(clips.getAll()));
    return new Map(rows.map((r) => [r.clipId, clipMeta(r)]));
  }

  // The clips row without its blob: {clipId, eventId, size, sha256, origin, uploadedAt, remoteAvailable, hasBlob}.
  async function getClipRow(clipId) {
    const row = await run(db, ['clips'], 'readonly', ({ clips }) => req(clips.get(clipId)));
    return row ? clipMeta(row) : null;
  }

  function clipMeta(row) {
    const { blob, ...rest } = row;
    return { origin: 'local', uploadedAt: null, remoteAvailable: false, sha256: null, ...rest, blob: blob ? undefined : null, hasBlob: !!blob };
  }

  async function listReviews(eventId) {
    const rows = await run(db, ['reviews'], 'readonly', ({ reviews }) =>
      req(reviews.index('eventId').getAll(eventId)));
    return rows.sort((a, b) => a.revision - b.revision).map(stripReview);
  }

  async function allReviews() {
    const rows = await run(db, ['reviews'], 'readonly', ({ reviews }) => req(reviews.getAll()));
    const map = new Map();
    for (const row of rows.sort((a, b) => a.revision - b.revision)) {
      if (!map.has(row.eventId)) map.set(row.eventId, []);
      map.get(row.eventId).push(stripReview(row));
    }
    return map;
  }

  // Rejects with Error('revision_conflict') (nothing written, draft kept) when `doc.baseRevision`
  // is not the latest stored revision for the event.
  async function saveReview(doc) {
    await run(db, ['reviews', 'outbox', 'drafts'], 'readwrite', async (s) => {
      await assertExtendsLatest(s.reviews, doc);
      s.reviews.put({ ...doc, eventRevision: [doc.eventId, doc.revision] });
      s.outbox.put(outboxRow(doc.messageId, 'review', doc.editedAt));
      s.drafts.delete(doc.eventId);
    }, STRICT);
  }

  async function getDraft(eventId) {
    const row = await run(db, ['drafts'], 'readonly', ({ drafts }) => req(drafts.get(eventId)));
    return row ? row.fields : null;
  }

  async function putDraft(eventId, fields) {
    await run(db, ['drafts'], 'readwrite', ({ drafts }) => {
      drafts.put({ eventId, fields, updatedAt: new Date().toISOString() });
    });
  }

  // `clipIds`: every clip of the event (original and current trim); the tombstone's own
  // clipId is always removed.
  async function deleteClip({ tombstone, reviewTombstone = null, clipIds = [] }) {
    await run(db, ['clips', 'events', 'reviews', 'outbox'], 'readwrite', async (s) => {
      if (reviewTombstone) await assertExtendsLatest(s.reviews, reviewTombstone);
      for (const id of new Set([tombstone.payload.clipId, ...clipIds])) s.clips.delete(id);
      s.events.put({
        messageId: tombstone.messageId, eventId: tombstone.eventId,
        createdAt: tombstone.createdAt, exportedAt: null, acceptedAt: null, envelope: tombstone,
      });
      s.outbox.put(outboxRow(tombstone.messageId, 'event', tombstone.createdAt));
      if (reviewTombstone) {
        s.reviews.put({ ...reviewTombstone, eventRevision: [reviewTombstone.eventId, reviewTombstone.revision] });
        s.outbox.put(outboxRow(reviewTombstone.messageId, 'review', reviewTombstone.editedAt));
      }
    }, STRICT);
  }

  async function markExported(eventIds, when) {
    await run(db, ['events'], 'readwrite', async ({ events }) => {
      for (const id of eventIds) {
        const rows = await req(events.index('eventId').getAll(id));
        for (const row of rows) {
          if (isTombstone(row.envelope)) continue;
          events.put({ ...row, exportedAt: when });
        }
      }
    });
  }

  async function usage() {
    const rows = await run(db, ['clips'], 'readonly', ({ clips }) => req(clips.getAll()));
    // Remote stubs without audio do not count; a trimmed event keeps two blobs but counts as one clip.
    const stored = rows.filter((r) => r.blob);
    const events = new Set(stored.map((r) => r.eventId || r.clipId));
    return { clips: events.size, bytes: stored.reduce((n, r) => n + (r.size || 0), 0) };
  }

  // Clears every data store. The pairing (meta) survives and the sync cursor resets to 0 so the
  // phone pulls everything again.
  async function clearAll() {
    await getMeta();
    await run(db, [...DATA_STORES, 'syncState'], 'readwrite', (s) => {
      for (const n of DATA_STORES) s[n].clear();
      s.syncState.put({ key: 'cursor', value: 0 });
    });
  }

  // ---- sync support -------------------------------------------------------

  async function getSyncState() {
    const rows = await run(db, ['syncState'], 'readonly', ({ syncState }) => req(syncState.getAll()));
    const out = { ...SYNC_DEFAULTS };
    for (const row of rows) out[row.key] = row.value;
    return out;
  }

  async function setSyncState(patch) {
    await run(db, ['syncState'], 'readwrite', ({ syncState }) => {
      for (const r of metaRows(patch)) syncState.put(r);
    });
  }

  // Outbox rows in `states` (default pending) whose nextAttemptAt is not after `before`, by createdAt.
  async function listOutbox({ states = ['pending'], before = null } = {}) {
    const rows = await run(db, ['outbox'], 'readonly', ({ outbox }) => req(outbox.getAll()));
    return rows
      .map((r) => ({ attempts: 0, nextAttemptAt: 0, lastError: null, ...r }))
      .filter((r) => states.includes(r.state) && (before === null || (r.nextAttemptAt || 0) <= before))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async function updateOutbox(messageId, patch) {
    await run(db, ['outbox'], 'readwrite', async ({ outbox }) => {
      const row = await req(outbox.get(messageId));
      if (row) outbox.put({ ...row, ...patch });
    });
  }

  // Writes a full outbox row (used to surface a terminal clip failure after acceptance).
  async function putOutbox(row) {
    await run(db, ['outbox'], 'readwrite', ({ outbox }) => { outbox.put(row); });
  }

  async function deleteOutbox(messageId) {
    await run(db, ['outbox'], 'readwrite', ({ outbox }) => { outbox.delete(messageId); });
  }

  // Records the Worker's acknowledgment on the events or reviews row.
  async function markAccepted(kind, messageId, when) {
    const store = kind === 'review' ? 'reviews' : 'events';
    await run(db, [store], 'readwrite', async (s) => {
      const row = await req(s[store].get(messageId));
      if (row) s[store].put({ ...row, acceptedAt: when });
    });
  }

  // Local clips whose capture message the Worker accepted and whose WAV is not uploaded yet.
  async function listClipsToUpload() {
    const [clips, events] = await run(db, ['clips', 'events'], 'readonly', (s) =>
      Promise.all([req(s.clips.getAll()), req(s.events.getAll())]));
    const acceptedByClip = new Map();
    for (const e of events) {
      if (isTombstone(e.envelope) || !e.acceptedAt || !e.envelope.payload?.clipId) continue;
      acceptedByClip.set(e.envelope.payload.clipId, e);
    }
    return clips
      .filter((c) => (c.origin ?? 'local') === 'local' && c.blob && !c.uploadedAt && !c.uploadError && acceptedByClip.has(c.clipId))
      .map((c) => {
        const e = acceptedByClip.get(c.clipId);
        return { clipId: c.clipId, eventId: e.eventId, messageId: e.messageId, blob: c.blob, sha256: e.envelope.payload.sha256, sizeBytes: c.size };
      });
  }

  // A terminal upload refusal (size/hash mismatch): the clip is never offered for upload again.
  async function markUploadFailed(clipId, reason) {
    await run(db, ['clips'], 'readwrite', async ({ clips }) => {
      const row = await req(clips.get(clipId));
      if (row) clips.put({ ...row, uploadError: reason });
    });
  }

  async function markUploaded(clipId, when) {
    await run(db, ['clips'], 'readwrite', async ({ clips }) => {
      const row = await req(clips.get(clipId));
      if (row) clips.put({ ...row, uploadedAt: when, remoteAvailable: true });
    });
  }

  // Applies one page of sync entries in a single transaction, then writes the cursor. Every
  // write is idempotent. A review whose [eventId, revision] collides with a different local
  // messageId replaces that local row, which moves to `conflicts` (with its outbox row marked
  // conflict). A tombstone from elsewhere deletes the local clip row.
  async function applyRemote(entries, cursor) {
    const when = new Date().toISOString();
    await run(db, ['events', 'clips', 'reviews', 'outbox', 'conflicts', 'syncState'], 'readwrite', async (s) => {
      for (const entry of entries) {
        if (entry.kind === 'clip') {
          const existing = await req(s.clips.get(entry.clipId));
          if (existing) s.clips.put({ ...existing, remoteAvailable: true, sha256: existing.sha256 ?? entry.sha256 });
          else s.clips.put({ clipId: entry.clipId, eventId: entry.eventId, blob: null, size: entry.sizeBytes, sha256: entry.sha256, origin: 'remote', uploadedAt: when, remoteAvailable: true });
          continue;
        }
        if (entry.kind !== 'message' || !entry.body || typeof entry.body !== 'object') throw new Error('malformed sync entry');
        const body = entry.body;
        if (entry.messageKind === 'event') {
          const row = await req(s.events.get(body.messageId));
          if (row) { if (!row.acceptedAt) s.events.put({ ...row, acceptedAt: entry.receivedAt ?? when }); }
          else s.events.put({ messageId: body.messageId, eventId: body.eventId, createdAt: body.createdAt, exportedAt: null, acceptedAt: entry.receivedAt ?? when, envelope: body });
          if (isTombstone(body)) {
            const rows = await req(s.clips.getAll());
            for (const c of rows) if (c.eventId === body.eventId) s.clips.delete(c.clipId);
          }
        } else if (entry.messageKind === 'review') {
          const row = await req(s.reviews.get(body.messageId));
          if (row) { if (!row.acceptedAt) s.reviews.put({ ...row, acceptedAt: entry.receivedAt ?? when }); continue; }
          const clash = await req(s.reviews.index('eventRevision').get([body.eventId, body.revision]));
          if (clash) {
            const { eventRevision, acceptedAt, ...doc } = clash;
            s.reviews.delete(clash.messageId);
            s.conflicts.put({ messageId: clash.messageId, eventId: clash.eventId, kind: 'review', reason: 'revision_conflict', doc, recordedAt: when });
            const ob = await req(s.outbox.get(clash.messageId));
            if (ob) s.outbox.put({ ...ob, state: 'conflict', lastError: 'revision_conflict' });
          }
          s.reviews.put({ ...body, eventRevision: [body.eventId, body.revision], acceptedAt: entry.receivedAt ?? when });
        }
        // episode and unknown kinds are preserved for later slices: ignored here.
      }
      s.syncState.put({ key: 'cursor', value: cursor });
    }, STRICT);
  }

  // Remote clip rows that still have no audio, newest event first.
  async function listClipStubs(limit = 20) {
    const [clips, events] = await run(db, ['clips', 'events'], 'readonly', (s) =>
      Promise.all([req(s.clips.getAll()), req(s.events.getAll())]));
    const dead = new Set(events.filter((e) => isTombstone(e.envelope)).map((e) => e.eventId));
    const createdAt = new Map(events.filter((e) => !isTombstone(e.envelope)).map((e) => [e.eventId, e.createdAt]));
    return clips
      .filter((c) => !c.blob && c.remoteAvailable && !dead.has(c.eventId))
      .sort((a, b) => ((createdAt.get(a.eventId) || '') < (createdAt.get(b.eventId) || '') ? 1 : -1))
      .slice(0, limit)
      .map(clipMeta);
  }

  async function storeRemoteClip(clipId, blob) {
    await run(db, ['clips'], 'readwrite', async ({ clips }) => {
      const row = await req(clips.get(clipId));
      if (!row) throw new Error('clip_row_missing');
      clips.put({ ...row, blob, size: blob.size, origin: row.origin ?? 'remote' });
    }, STRICT);
  }

  async function listConflicts(eventId) {
    return run(db, ['conflicts'], 'readonly', ({ conflicts }) =>
      req(eventId ? conflicts.index('eventId').getAll(eventId) : conflicts.getAll()));
  }

  async function deleteConflict(messageId) {
    await run(db, ['conflicts', 'outbox'], 'readwrite', (s) => { s.conflicts.delete(messageId); s.outbox.delete(messageId); });
  }

  function close() { db.close(); }

  return {
    getMeta, setMeta, saveCapture, saveTrim, listEvents, listTombstones, getEvent, getClip, getClipRow, listClipRows,
    listReviews, allReviews, saveReview, getDraft, putDraft, deleteClip,
    markExported, usage, clearAll, close,
    getSyncState, setSyncState, listOutbox, updateOutbox, putOutbox, deleteOutbox, markAccepted,
    listClipsToUpload, markUploaded, markUploadFailed, applyRemote, listClipStubs, storeRemoteClip, listConflicts, deleteConflict,
  };
}
