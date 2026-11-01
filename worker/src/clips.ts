import { sha256Hex, type Device } from './auth';
import type { Env } from './env';
import { log } from './log';

export type PutStatus = 'uploaded' | 'already' | 'not_found' | 'forbidden' | 'mismatch' | 'deleted';

interface ClipRow { clip_id: string; event_id: string; device_id: string; source_id: string; sha256: string; size_bytes: number; r2_key: string; uploaded_at: string | null; deleted_at: string | null }

function clipRow(env: Env, clipId: string) {
  return env.DB.prepare('SELECT clip_id, event_id, device_id, source_id, sha256, size_bytes, r2_key, uploaded_at, deleted_at FROM clips WHERE clip_id = ?').bind(clipId).first<ClipRow>();
}

export async function putClip(env: Env, device: Device, clipId: string, body: ArrayBuffer, now: Date, requestId: string): Promise<{ status: PutStatus; uploadedAt?: string }> {
  const row = await clipRow(env, clipId);
  if (!row) return { status: 'not_found' };
  if (row.deleted_at) return { status: 'deleted' };
  // Ownership is the installation (sourceId), which survives unpair/re-pair; the device row changes.
  if (row.source_id !== device.sourceId) return { status: 'forbidden' };
  if (row.uploaded_at) {
    // A repeat after a partial commit (row updated, log append lost) repairs the log; otherwise no-op.
    await env.DB.prepare(
      "INSERT INTO sync_log (kind, ref_id, device_id, created_at) SELECT 'clip', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM sync_log WHERE kind = 'clip' AND ref_id = ?)",
    ).bind(clipId, device.deviceId, row.uploaded_at, clipId).run();
    return { status: 'already', uploadedAt: row.uploaded_at };
  }
  if (body.byteLength !== row.size_bytes) { log('clip_mismatch', { requestId, clipId, reason: 'size' }); return { status: 'mismatch' }; }
  const hash = await sha256Hex(body);
  if (hash !== row.sha256) { log('clip_mismatch', { requestId, clipId, reason: 'sha256' }); return { status: 'mismatch' }; }
  await env.CLIPS.put(row.r2_key, body, { httpMetadata: { contentType: 'audio/wav' }, customMetadata: { sha256: hash, eventId: row.event_id, clipId } });
  const at = now.toISOString();
  // Row update and sync-log append commit together; the append is conditional on this call's
  // update having won (uploaded_at = at), so a concurrent upload appends nothing.
  const [updated] = await env.DB.batch([
    env.DB.prepare('UPDATE clips SET uploaded_at = ? WHERE clip_id = ? AND uploaded_at IS NULL').bind(at, clipId),
    env.DB.prepare(
      "INSERT INTO sync_log (kind, ref_id, device_id, created_at) SELECT 'clip', ?, ?, ? WHERE EXISTS (SELECT 1 FROM clips WHERE clip_id = ? AND uploaded_at = ?)",
    ).bind(clipId, device.deviceId, at, clipId, at),
  ]);
  if (!updated.meta.changes) { const again = await clipRow(env, clipId); return { status: 'already', uploadedAt: again?.uploaded_at ?? at }; }
  log('clip_uploaded', { requestId, clipId, eventId: row.event_id, sizeBytes: row.size_bytes, deviceId: device.deviceId });
  return { status: 'uploaded', uploadedAt: at };
}

export async function getClip(env: Env, clipId: string): Promise<{ object: R2ObjectBody; sha256: string; sizeBytes: number } | null> {
  const row = await clipRow(env, clipId);
  if (!row || !row.uploaded_at || row.deleted_at) return null;
  const object = await env.CLIPS.get(row.r2_key);
  if (!object) return null;
  return { object, sha256: row.sha256, sizeBytes: row.size_bytes };
}
