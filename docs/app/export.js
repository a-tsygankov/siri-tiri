import { APP_VERSION, PROTOCOL_VERSION } from './version.js';
import { needsReview, LIMITS } from './records.js';

export function selectEvents(rows, reviewsByEvent, mode, tombstones = []) {
  const deleted = new Set(tombstones.map((t) => t.eventId));
  return rows.filter((row) => {
    const id = row.envelope.eventId;
    if (deleted.has(id)) return false;
    if (mode === 'new') return !row.exportedAt;
    if (mode === 'unreviewed') return needsReview(reviewsByEvent.get(id) || []);
    return true;
  });
}

export function buildBundle({ installId, events, tombstones = [], reviewsByEvent, now }) {
  const ids = new Set(events.map((e) => e.envelope.eventId));
  const envelopes = [
    ...events.map((e) => e.envelope),
    ...tombstones.filter((t) => ids.has(t.eventId)),
  ];
  const reviews = [];
  for (const id of [...ids].sort()) {
    const list = [...(reviewsByEvent.get(id) || [])].sort((a, b) => a.revision - b.revision);
    reviews.push(...list);
  }
  const clips = events.map(({ envelope: e }) => ({
    clipId: e.payload.clipId,
    eventId: e.eventId,
    filename: `${e.eventId}.wav`,
    sha256: e.payload.sha256,
    sizeBytes: e.payload.sizeBytes,
    sampleRate: e.payload.sampleRate,
    durationMs: e.payload.durationMs,
  }));
  return {
    exportVersion: 1,
    appVersion: APP_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    installId,
    exportedAt: now(),
    events: envelopes,
    reviews,
    clips,
  };
}

export function bundleFilename(now) {
  const stamp = now().replace(/-|:/g, '').replace(/\.\d+/, '');
  return `siri-tiri-export-${stamp}.json`;
}

export function chunkClips(manifest, size = LIMITS.exportChunk) {
  const out = [];
  for (let i = 0; i < manifest.length; i += size) out.push(manifest.slice(i, i + size));
  return out;
}

// Implemented in Task 6 (browser only; never touch `navigator` at module top level).
export async function shareFiles(_files) {
  throw new Error('not implemented');
}
