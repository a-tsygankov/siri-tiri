import { PROTOCOL_VERSION } from './version.js';

export const CONTEXTS = [
  { value: 'food', label: 'Food' }, { value: 'attention', label: 'Attention' },
  { value: 'play', label: 'Play' }, { value: 'door', label: 'Door' },
  { value: 'greeting', label: 'Greeting' }, { value: 'resting', label: 'Resting' },
  { value: 'handling', label: 'Handling' }, { value: 'other', label: 'Other' },
  { value: 'unsure', label: 'Unsure' },
];
export const LOCATIONS = [
  { value: 'kitchen', label: 'Kitchen' }, { value: 'living-room', label: 'Living room' },
  { value: 'bedroom', label: 'Bedroom' }, { value: 'hallway', label: 'Hallway' },
  { value: 'outside', label: 'Outside' }, { value: 'other', label: 'Other' },
];
export const BEHAVIORS = [
  { value: 'approaching', label: 'Approaching' }, { value: 'walking', label: 'Walking' },
  { value: 'sitting', label: 'Sitting' }, { value: 'looking-at-owner', label: 'Looking at me' },
  { value: 'hiding', label: 'Hiding' }, { value: 'eating', label: 'Eating' },
  { value: 'other', label: 'Other' },
];
export const OUTCOMES = [
  { value: 'fed', label: 'Fed' }, { value: 'played', label: 'Played' },
  { value: 'door-opened', label: 'Opened door' }, { value: 'no-action', label: 'No action' },
  { value: 'other', label: 'Other' },
];

export const LIMITS = {
  softCueMs: 20000, maxMs: 30000, minMs: 300,
  warnClips: 100, warnBytes: 300e6, blockClips: 200, blockBytes: 600e6,
  exportChunk: 20,
};

const NOTE_MAX = 500;

export function buildCapture({ installId, clipId, sampleRate, durationMs, sizeBytes, sha256, clippedSamples, recordedAt, interrupted, uuid, now }) {
  return {
    schemaVersion: PROTOCOL_VERSION,
    messageId: uuid(),
    eventId: uuid(),
    sourceId: installId,
    createdAt: now(),
    type: 'capture',
    payload: {
      clipId, sampleRate, durationMs, sizeBytes, sha256, clippedSamples, recordedAt, interrupted,
      encoding: 'pcm16-wav', channels: 1,
      captureVersion: 'pwa-pcm16-native-v1', sourceKind: 'pwa-manual',
    },
  };
}

export function buildTombstone({ installId, eventId, clipId, supersedesMessageId, uuid, now }) {
  return {
    schemaVersion: PROTOCOL_VERSION,
    messageId: uuid(),
    eventId,
    sourceId: installId,
    createdAt: now(),
    type: 'capture',
    payload: { deleted: true, clipId, supersedesMessageId },
  };
}

export function buildReview({ eventId, reviewId, previous, fields, uuid, now }) {
  const f = fields || {};
  const context = f.context ?? previous?.context;
  if (!context) throw new Error('review requires a context');
  if (typeof f.note === 'string' && f.note.length > NOTE_MAX) throw new Error(`note exceeds ${NOTE_MAX} characters`);
  const doc = {
    schemaVersion: PROTOCOL_VERSION,
    messageId: uuid(),
    reviewId,
    eventId,
    revision: previous ? previous.revision + 1 : 1,
    baseRevision: previous ? previous.revision : null,
    editedAt: now(),
    source: 'pwa',
    context,
  };
  if (f.location) doc.location = f.location;
  if (f.observedBehavior) doc.observedBehavior = f.observedBehavior;
  if (f.outcome) doc.outcome = f.outcome;
  if (f.note) doc.note = f.note;
  if (f.deleted === true) doc.deleted = true;
  return doc;
}

export function latestReview(reviews) {
  let best = null;
  for (const r of reviews || []) if (!best || r.revision > best.revision) best = r;
  return best;
}

export function needsReview(reviews) {
  const latest = latestReview(reviews);
  return !latest || latest.deleted === true;
}

export function storageState({ clips, bytes }) {
  if (clips >= LIMITS.blockClips || bytes >= LIMITS.blockBytes) return 'blocked';
  if (clips >= LIMITS.warnClips || bytes >= LIMITS.warnBytes) return 'warn';
  return 'ok';
}
