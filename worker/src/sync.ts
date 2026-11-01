import type { Env } from './env';

export type SyncEntry =
  | { seq: number; kind: 'message'; messageKind: 'event' | 'review' | 'episode'; body: unknown; receivedAt: string; deviceId: string }
  | { seq: number; kind: 'clip'; clipId: string; eventId: string; sha256: string; sizeBytes: number; deviceId: string };

export interface Page<T> { entries: T[]; cursor: number; more: boolean }

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

interface LogRow { seq: number; kind: 'message' | 'clip'; ref_id: string; device_id: string; m_kind: string | null; body: string | null; received_at: string | null; event_id: string | null; sha256: string | null; size_bytes: number | null }

export async function pull(env: Env, cursor: number, limit: number): Promise<Page<SyncEntry>> {
  const { results } = await env.DB.prepare(
    `SELECT l.seq, l.kind, l.ref_id, l.device_id, m.kind AS m_kind, m.body, m.received_at, c.event_id, c.sha256, c.size_bytes
     FROM sync_log l
     LEFT JOIN messages m ON l.kind = 'message' AND m.message_id = l.ref_id
     LEFT JOIN clips c ON l.kind = 'clip' AND c.clip_id = l.ref_id
     WHERE l.seq > ? ORDER BY l.seq LIMIT ?`,
  ).bind(cursor, limit + 1).all<LogRow>();
  const more = results.length > limit;
  const rows = more ? results.slice(0, limit) : results;
  const entries: SyncEntry[] = rows.map((r) => (r.kind === 'message'
    ? { seq: r.seq, kind: 'message', messageKind: r.m_kind as 'event' | 'review' | 'episode', body: JSON.parse(r.body!), receivedAt: r.received_at!, deviceId: r.device_id }
    : { seq: r.seq, kind: 'clip', clipId: r.ref_id, eventId: r.event_id!, sha256: r.sha256!, sizeBytes: r.size_bytes!, deviceId: r.device_id }));
  return { entries, cursor: rows.length ? rows[rows.length - 1].seq : cursor, more };
}

export interface ConflictEntry { seq: number; messageId: string; messageKind: string; reason: string; body: unknown; receivedAt: string; deviceId: string }

export async function conflicts(env: Env, cursor: number, limit: number): Promise<Page<ConflictEntry>> {
  const { results } = await env.DB.prepare(
    `SELECT rowid AS seq, message_id, kind, conflict_reason, body, received_at, device_id FROM messages
     WHERE status = 'conflict' AND rowid > ? ORDER BY rowid LIMIT ?`,
  ).bind(cursor, limit + 1).all<{ seq: number; message_id: string; kind: string; conflict_reason: string; body: string; received_at: string; device_id: string }>();
  const more = results.length > limit;
  const rows = more ? results.slice(0, limit) : results;
  return {
    entries: rows.map((r) => ({ seq: r.seq, messageId: r.message_id, messageKind: r.kind, reason: r.conflict_reason, body: JSON.parse(r.body), receivedAt: r.received_at, deviceId: r.device_id })),
    cursor: rows.length ? rows[rows.length - 1].seq : cursor,
    more,
  };
}

// Parses ?cursor= and ?limit=; null when either is malformed or out of range.
export function pageParams(q: { cursor?: string; limit?: string }): { cursor: number; limit: number } | null {
  const cursor = q.cursor === undefined ? 0 : Number(q.cursor);
  const limit = q.limit === undefined ? DEFAULT_LIMIT : Number(q.limit);
  if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return null;
  return { cursor, limit };
}
