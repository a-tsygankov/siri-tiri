import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, pairedDevice, post } from './helpers';
import { capture, item, tombstone } from './fixtures';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function wavBytes(n = 1644): Uint8Array {
  const b = new Uint8Array(n);
  b.set([0x52, 0x49, 0x46, 0x46]); // "RIFF"
  for (let i = 44; i < n; i++) b[i] = (i * 7) & 0xff;
  return b;
}

async function acceptedCapture(token: string, bytes: Uint8Array) {
  const cap = capture({ sha256: await sha256Hex(bytes), sizeBytes: bytes.length });
  const res = await post(token, '/v1/messages', { messages: [item('event', cap)] });
  expect(res.status).toBe(200);
  return cap;
}

function put(token: string | null, clipId: string, body: BodyInit, contentType = 'audio/wav') {
  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (token) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch(`http://x/v1/clips/${clipId}`, { method: 'PUT', headers, body });
}

describe('clips', () => {
  it('upload after an accepted capture stores the object and appends a clip sync_log row', async () => {
    const dev = await pairedDevice();
    const bytes = wavBytes();
    const cap = await acceptedCapture(dev.token, bytes);
    const res = await put(dev.token, cap.payload.clipId, bytes);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ clipId: cap.payload.clipId });
    const obj = await env.CLIPS.get(`clips/${cap.eventId}/${cap.payload.clipId}.wav`);
    expect(obj).not.toBeNull();
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(bytes);
    expect(obj!.customMetadata?.sha256).toBe(cap.payload.sha256);
    const row = await env.DB.prepare("SELECT count(*) AS n FROM sync_log WHERE kind = 'clip' AND ref_id = ?").bind(cap.payload.clipId).first<{ n: number }>();
    expect(row?.n).toBe(1);
    const clip = await env.DB.prepare('SELECT uploaded_at FROM clips WHERE clip_id = ?').bind(cap.payload.clipId).first<{ uploaded_at: string | null }>();
    expect(clip?.uploaded_at).toBeTruthy();
  });

  it('size mismatch is 409 and nothing is stored', async () => {
    const dev = await pairedDevice();
    const bytes = wavBytes();
    const cap = await acceptedCapture(dev.token, bytes);
    const res = await put(dev.token, cap.payload.clipId, bytes.slice(0, 1000));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'clip_mismatch' });
    expect(await env.CLIPS.get(`clips/${cap.eventId}/${cap.payload.clipId}.wav`)).toBeNull();
  });

  it('hash mismatch is 409', async () => {
    const dev = await pairedDevice();
    const bytes = wavBytes();
    const cap = await acceptedCapture(dev.token, bytes);
    const other = wavBytes(); other[100] ^= 0xff;
    const res = await put(dev.token, cap.payload.clipId, other);
    expect(res.status).toBe(409);
  });

  it('another device cannot upload this clip (403)', async () => {
    const a = await pairedDevice('A');
    const b = await pairedDevice('B');
    const bytes = wavBytes();
    const cap = await acceptedCapture(a.token, bytes);
    expect((await put(b.token, cap.payload.clipId, bytes)).status).toBe(403);
  });

  it('repeat upload is 200 and appends no sync_log row', async () => {
    const dev = await pairedDevice();
    const bytes = wavBytes();
    const cap = await acceptedCapture(dev.token, bytes);
    expect((await put(dev.token, cap.payload.clipId, bytes)).status).toBe(201);
    expect((await put(dev.token, cap.payload.clipId, bytes)).status).toBe(200);
    const row = await env.DB.prepare("SELECT count(*) AS n FROM sync_log WHERE kind = 'clip'").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('download returns the bytes to any paired device with the sha256 as ETag', async () => {
    const a = await pairedDevice('A');
    const b = await pairedDevice('B');
    const bytes = wavBytes();
    const cap = await acceptedCapture(a.token, bytes);
    await put(a.token, cap.payload.clipId, bytes);
    const res = await get(b.token, `/v1/clips/${cap.payload.clipId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('etag')).toContain(cap.payload.sha256);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect((await get(null, `/v1/clips/${cap.payload.clipId}`)).status).toBe(401);
  });

  it('tombstone deletes the R2 objects of the event and later download is 404', async () => {
    const dev = await pairedDevice();
    const bytes = wavBytes();
    const cap = await acceptedCapture(dev.token, bytes);
    await put(dev.token, cap.payload.clipId, bytes);
    const res = await post(dev.token, '/v1/messages', { messages: [item('event', tombstone(cap))] });
    expect(res.status).toBe(200);
    expect(await env.CLIPS.get(`clips/${cap.eventId}/${cap.payload.clipId}.wav`)).toBeNull();
    expect((await get(dev.token, `/v1/clips/${cap.payload.clipId}`)).status).toBe(404);
    expect((await put(dev.token, cap.payload.clipId, bytes)).status).toBe(410);
  });

  it('unknown clipId is 404 on upload and download; not-yet-uploaded is 404 on download', async () => {
    const dev = await pairedDevice();
    expect((await put(dev.token, crypto.randomUUID(), wavBytes())).status).toBe(404);
    expect((await get(dev.token, `/v1/clips/${crypto.randomUUID()}`)).status).toBe(404);
    const cap = await acceptedCapture(dev.token, wavBytes());
    expect((await get(dev.token, `/v1/clips/${cap.payload.clipId}`)).status).toBe(404);
  });

  it('wrong content type is 415 and an oversized body is 413', async () => {
    const dev = await pairedDevice();
    const bytes = wavBytes();
    const cap = await acceptedCapture(dev.token, bytes);
    expect((await put(dev.token, cap.payload.clipId, bytes, 'application/octet-stream')).status).toBe(415);
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    expect((await put(dev.token, cap.payload.clipId, big)).status).toBe(413);
  });
});
