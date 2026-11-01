import { sha256Hex, type Device } from './auth';
import type { Env } from './env';
import { log } from './log';
import { validateItem, type Doc, type Kind } from './validate';

export interface ItemResult {
  messageId?: string;
  status: 'accepted' | 'duplicate' | 'conflict' | 'rejected';
  reason?: string;
  latestRevision?: number;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Doc).sort().map((k) => [k, sortKeys((value as Doc)[k])]));
  }
  return value;
}

export function canonicalJson(body: unknown): string {
  return JSON.stringify(sortKeys(body));
}

export function canonicalHash(body: unknown): Promise<string> {
  return sha256Hex(canonicalJson(body));
}

export function r2Key(eventId: string, clipId: string): string {
  return `clips/${eventId}/${clipId}.wav`;
}

type Payload = Doc & { deleted?: unknown; clipId?: unknown; sha256?: unknown; sizeBytes?: unknown };

function clipFromPayload(payload: unknown): { clipId: string; sha256: string; sizeBytes: number } | null {
  const p = payload as Payload | undefined;
  if (!p || p.deleted === true) return null;
  if (typeof p.clipId !== 'string' || typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(p.sha256)) return null;
  if (!Number.isInteger(p.sizeBytes) || (p.sizeBytes as number) <= 0) return null;
  return { clipId: p.clipId, sha256: (p.sha256 as string).toLowerCase(), sizeBytes: p.sizeBytes as number };
}

async function ingestOne(env: Env, device: Device, kind: Kind, body: Doc, at: string, deletedEvents: string[]): Promise<ItemResult> {
  const messageId = body.messageId as string;
  const hash = await canonicalHash(body);
  const existing = await env.DB.prepare('SELECT payload_hash, status, conflict_reason FROM messages WHERE message_id = ?')
    .bind(messageId).first<{ payload_hash: string; status: string; conflict_reason: string | null }>();
  if (existing) {
    if (existing.payload_hash !== hash) return { messageId, status: 'conflict', reason: 'payload_mismatch' };
    if (existing.status === 'conflict') {
      const latest = await latestRevision(env, body.eventId as string);
      return { messageId, status: 'conflict', reason: existing.conflict_reason ?? 'revision_conflict', latestRevision: latest };
    }
    return { messageId, status: 'duplicate' };
  }

  const eventId = kind === 'episode' ? null : (body.eventId as string);
  const correlationKey = kind === 'episode' ? (body.episodeId as string) : (body.eventId as string);
  const createdAt = (kind === 'event' ? body.createdAt : body.editedAt) as string;
  const insert = (status: 'accepted' | 'conflict', reason: string | null) => env.DB.prepare(
    'INSERT INTO messages (message_id, kind, event_id, correlation_key, type, source_id, device_id, created_at, received_at, payload_hash, body, status, conflict_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(messageId, kind, eventId, correlationKey, kind === 'event' ? (body.type as string) : kind, body.sourceId ?? (body.source as string) ?? device.sourceId,
    device.deviceId, createdAt, at, hash, JSON.stringify(body), status, reason);
  const logRow = env.DB.prepare('INSERT INTO sync_log (kind, ref_id, device_id, created_at) VALUES (?, ?, ?, ?)').bind('message', messageId, device.deviceId, at);

  if (kind === 'review') {
    const latest = await latestRevision(env, eventId!);
    const revision = body.revision as number;
    const base = (body.baseRevision as number | null) ?? 0;
    if (revision !== latest + 1 || base !== latest) {
      await env.DB.batch([insert('conflict', 'revision_conflict')]);
      return { messageId, status: 'conflict', reason: 'revision_conflict', latestRevision: latest };
    }
    await env.DB.batch([
      insert('accepted', null),
      env.DB.prepare('INSERT INTO review_chain (event_id, revision, message_id) VALUES (?, ?, ?)').bind(eventId, revision, messageId),
      logRow,
    ]);
    return { messageId, status: 'accepted' };
  }

  const statements = [insert('accepted', null), logRow];
  if (kind === 'event' && body.type === 'capture') {
    const payload = body.payload as Payload | undefined;
    if (payload?.deleted === true) {
      statements.push(env.DB.prepare('UPDATE clips SET deleted_at = ? WHERE event_id = ? AND deleted_at IS NULL').bind(at, eventId));
      deletedEvents.push(eventId!);
    } else {
      const clip = clipFromPayload(payload);
      if (clip) {
        statements.push(env.DB.prepare(
          'INSERT OR IGNORE INTO clips (clip_id, event_id, message_id, device_id, source_id, sha256, size_bytes, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(clip.clipId, eventId, messageId, device.deviceId, device.sourceId, clip.sha256, clip.sizeBytes, r2Key(eventId!, clip.clipId)));
      }
    }
  }
  await env.DB.batch(statements);
  return { messageId, status: 'accepted' };
}

export async function latestRevision(env: Env, eventId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT max(revision) AS r FROM review_chain WHERE event_id = ?').bind(eventId).first<{ r: number | null }>();
  return row?.r ?? 0;
}

export async function deleteEventClips(env: Env, eventId: string): Promise<void> {
  const { results } = await env.DB.prepare('SELECT r2_key FROM clips WHERE event_id = ?').bind(eventId).all<{ r2_key: string }>();
  if (results.length) await env.CLIPS.delete(results.map((r) => r.r2_key));
}

export async function ingest(env: Env, device: Device, items: unknown[], now: Date, requestId: string): Promise<ItemResult[]> {
  const at = now.toISOString();
  const results: ItemResult[] = [];
  const deletedEvents: string[] = [];
  for (const raw of items) {
    const v = validateItem(raw);
    if ('error' in v) { results.push({ messageId: typeof (raw as Doc)?.body === 'object' ? ((raw as { body: Doc }).body?.messageId as string | undefined) : undefined, status: 'rejected', reason: v.error }); continue; }
    results.push(await ingestOne(env, device, v.kind, v.body, at, deletedEvents));
  }
  for (const eventId of deletedEvents) await deleteEventClips(env, eventId);
  const counts = { accepted: 0, duplicate: 0, conflict: 0, rejected: 0 };
  for (const r of results) counts[r.status]++;
  log('messages_ingested', { requestId, deviceId: device.deviceId, items: items.length, ...counts });
  return results;
}
