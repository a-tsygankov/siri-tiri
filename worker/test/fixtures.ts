// Contract-shaped documents for tests. Mirrors docs/app/records.js builders.
export const NOW = '2026-11-01T12:00:00.000Z';

export function capture(o: Partial<{ eventId: string; messageId: string; clipId: string; sha256: string; sizeBytes: number; sourceId: string; createdAt: string }> = {}) {
  return {
    schemaVersion: 1,
    messageId: o.messageId ?? crypto.randomUUID(),
    eventId: o.eventId ?? crypto.randomUUID(),
    sourceId: o.sourceId ?? 'pwa-phone-1',
    createdAt: o.createdAt ?? NOW,
    type: 'capture',
    payload: {
      clipId: o.clipId ?? crypto.randomUUID(), sampleRate: 16000, durationMs: 50, sizeBytes: o.sizeBytes ?? 1644,
      sha256: o.sha256 ?? 'ab'.repeat(32), clippedSamples: 0, recordedAt: NOW, interrupted: false,
      encoding: 'pcm16-wav', channels: 1, captureVersion: 'pwa-pcm16-native-v1', sourceKind: 'pwa-manual', clockSource: 'phone',
    },
  };
}

export function tombstone(cap: ReturnType<typeof capture>) {
  return {
    schemaVersion: 1, messageId: crypto.randomUUID(), eventId: cap.eventId, sourceId: cap.sourceId, createdAt: NOW, type: 'capture',
    payload: { deleted: true, clipId: cap.payload.clipId, supersedesMessageId: cap.messageId },
  };
}

export function trim(cap: ReturnType<typeof capture>, o: Partial<{ clipId: string; sha256: string; sizeBytes: number }> = {}) {
  return {
    ...cap, messageId: crypto.randomUUID(),
    payload: {
      ...cap.payload, clipId: o.clipId ?? crypto.randomUUID(), sha256: o.sha256 ?? 'cd'.repeat(32), sizeBytes: o.sizeBytes ?? 844, durationMs: 25,
      supersedesMessageId: cap.messageId,
      trim: { sourceMessageId: cap.messageId, sourceClipId: cap.payload.clipId, sourceSha256: cap.payload.sha256, sourceDurationMs: 50, startMs: 10, endMs: 35, trimVersion: 'pwa-trim-v1' },
    },
  };
}

export function review(o: { eventId: string; revision: number; baseRevision: number | null; reviewId?: string; context?: string; messageId?: string }) {
  return {
    schemaVersion: 1, messageId: o.messageId ?? crypto.randomUUID(), reviewId: o.reviewId ?? crypto.randomUUID(), eventId: o.eventId,
    revision: o.revision, baseRevision: o.baseRevision, editedAt: NOW, source: 'pwa', context: o.context ?? 'food',
  };
}

export function episode(o: { episodeId: string; revision: number; eventId: string }) {
  return {
    schemaVersion: 1, messageId: crypto.randomUUID(), episodeId: o.episodeId, revision: o.revision, baseRevision: o.revision > 1 ? o.revision - 1 : null,
    editedAt: NOW, source: 'owner', reason: 'owner-confirm', members: [{ eventId: o.eventId, sourceId: 'pwa-phone-1', startAt: NOW, endAt: NOW, clockSource: 'phone', receivedAt: NOW }],
    primaryEventId: o.eventId, windowStartAt: NOW, windowEndAt: NOW, ownerLocked: true,
  };
}

export const item = (kind: 'event' | 'review' | 'episode', body: unknown) => ({ kind, body });
