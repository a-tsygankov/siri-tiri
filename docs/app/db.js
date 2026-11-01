// IndexedDB layer. Append-only events/reviews; mutable: drafts, meta, events.exportedAt.
// Uses only the `indexedDB` and `crypto` globals plus the pure helpers in records.js.

import { currentCapture, originalCapture } from './records.js';

const DB_VERSION = 1;
const STORES = ['events', 'clips', 'reviews', 'drafts', 'outbox', 'meta'];

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

function upgrade(db) {
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

function stripReview(row) {
  const { eventRevision, ...doc } = row;
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
    r.onupgradeneeded = () => upgrade(r.result);
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
        const fresh = {
          installId: 'pwa-' + crypto.randomUUID(),
          schemaVersion: 1,
          persistGranted: false,
          appVersionAtLastRun: null,
        };
        for (const r of metaRows(fresh)) meta.put(r);
        return fresh;
      }
      return {
        installId: m.installId,
        schemaVersion: m.schemaVersion ?? 1,
        persistGranted: m.persistGranted ?? false,
        appVersionAtLastRun: m.appVersionAtLastRun ?? null,
      };
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
        createdAt: envelope.createdAt, exportedAt: null, envelope,
      });
      s.clips.put({ clipId, blob: wavBlob, size: wavBlob.size, eventId: envelope.eventId });
      s.outbox.put({
        messageId: envelope.messageId, kind: 'event', state: 'pending',
        attempts: 0, createdAt: envelope.createdAt,
      });
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
        createdAt: envelope.createdAt, exportedAt: null, envelope,
      });
      if (wavBlob) s.clips.put({ clipId: envelope.payload.clipId, blob: wavBlob, size: wavBlob.size, eventId: envelope.eventId });
      for (const id of removeClipIds) if (id !== envelope.payload.clipId) s.clips.delete(id);
      s.outbox.put({
        messageId: envelope.messageId, kind: 'event', state: 'pending',
        attempts: 0, createdAt: envelope.createdAt,
      });
    }, STRICT);
  }

  async function getClip(clipId) {
    const row = await run(db, ['clips'], 'readonly', ({ clips }) => req(clips.get(clipId)));
    return row ? row.blob : null;
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
      s.outbox.put({
        messageId: doc.messageId, kind: 'review', state: 'pending',
        attempts: 0, createdAt: doc.editedAt,
      });
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
        createdAt: tombstone.createdAt, exportedAt: null, envelope: tombstone,
      });
      s.outbox.put({
        messageId: tombstone.messageId, kind: 'event', state: 'pending',
        attempts: 0, createdAt: tombstone.createdAt,
      });
      if (reviewTombstone) {
        s.reviews.put({ ...reviewTombstone, eventRevision: [reviewTombstone.eventId, reviewTombstone.revision] });
        s.outbox.put({
          messageId: reviewTombstone.messageId, kind: 'review', state: 'pending',
          attempts: 0, createdAt: reviewTombstone.editedAt,
        });
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
    // A trimmed event keeps two blobs (original and trimmed) but counts as one clip.
    const events = new Set(rows.map((r) => r.eventId || r.clipId));
    return { clips: events.size, bytes: rows.reduce((n, r) => n + (r.size || 0), 0) };
  }

  async function clearAll() {
    const m = await getMeta();
    await run(db, STORES, 'readwrite', (s) => {
      for (const n of STORES) s[n].clear();
      for (const r of metaRows({ ...m, schemaVersion: 1 })) s.meta.put(r);
    });
  }

  function close() { db.close(); }

  return {
    getMeta, setMeta, saveCapture, saveTrim, listEvents, listTombstones, getEvent, getClip,
    listReviews, allReviews, saveReview, getDraft, putDraft, deleteClip,
    markExported, usage, clearAll, close,
  };
}
