import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { get, pairedDevice, post } from './helpers';
import { capture, item, review } from './fixtures';

type Entry = { seq: number; kind: string; body?: { messageId: string }; messageKind?: string; deviceId?: string; receivedAt?: string; clipId?: string; eventId?: string; sha256?: string; sizeBytes?: number };
type Page = { entries: Entry[]; cursor: number; more: boolean };

const pull = async (token: string, cursor = 0, limit?: number): Promise<Page> => {
  const res = await get(token, `/v1/sync?cursor=${cursor}${limit ? `&limit=${limit}` : ''}`);
  expect(res.status).toBe(200);
  return res.json() as Promise<Page>;
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('GET /v1/sync', () => {
  it('entries come back in seq order with the cursor at the last seq, own messages included', async () => {
    const dev = await pairedDevice();
    const c1 = capture(); const c2 = capture();
    await post(dev.token, '/v1/messages', { messages: [item('event', c1), item('event', c2)] });
    const page = await pull(dev.token);
    expect(page.entries.map((e) => e.body?.messageId)).toEqual([c1.messageId, c2.messageId]);
    expect(page.entries[0]).toMatchObject({ seq: 1, kind: 'message', messageKind: 'event', deviceId: dev.deviceId });
    expect(Date.parse(page.entries[0].receivedAt!)).toBeGreaterThan(0);
    expect(page.cursor).toBe(2);
    expect(page.more).toBe(false);
  });

  it('limit 2 returns more:true and the next page continues from the cursor', async () => {
    const dev = await pairedDevice();
    const caps = [capture(), capture(), capture()];
    await post(dev.token, '/v1/messages', { messages: caps.map((c) => item('event', c)) });
    const first = await pull(dev.token, 0, 2);
    expect(first.entries).toHaveLength(2); expect(first.more).toBe(true); expect(first.cursor).toBe(2);
    const second = await pull(dev.token, first.cursor, 2);
    expect(second.entries.map((e) => e.body?.messageId)).toEqual([caps[2].messageId]);
    expect(second.more).toBe(false); expect(second.cursor).toBe(3);
  });

  it('another device sees the first device messages and a clip entry after its upload', async () => {
    const a = await pairedDevice('A');
    const b = await pairedDevice('B');
    const bytes = new Uint8Array(1644); bytes.set([0x52, 0x49, 0x46, 0x46]);
    const cap = capture({ sha256: await sha256Hex(bytes), sizeBytes: bytes.length });
    await post(a.token, '/v1/messages', { messages: [item('event', cap)] });
    const before = await pull(b.token);
    expect(before.entries.map((e) => e.kind)).toEqual(['message']);
    const up = await SELF.fetch(`http://x/v1/clips/${cap.payload.clipId}`, { method: 'PUT', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'audio/wav' }, body: bytes });
    expect(up.status).toBe(201);
    const after = await pull(b.token, before.cursor);
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]).toMatchObject({ seq: 2, kind: 'clip', clipId: cap.payload.clipId, eventId: cap.eventId, sha256: cap.payload.sha256, sizeBytes: 1644 });
  });

  it('conflict reviews are not in /v1/sync but are in /v1/conflicts', async () => {
    const dev = await pairedDevice();
    const cap = capture();
    const r1 = review({ eventId: cap.eventId, revision: 1, baseRevision: null });
    const stale = review({ eventId: cap.eventId, revision: 5, baseRevision: 3, reviewId: r1.reviewId });
    await post(dev.token, '/v1/messages', { messages: [item('event', cap), item('review', r1), item('review', stale)] });
    const page = await pull(dev.token);
    expect(page.entries.map((e) => e.body?.messageId)).toEqual([cap.messageId, r1.messageId]);
    const res = await get(dev.token, '/v1/conflicts?cursor=0');
    expect(res.status).toBe(200);
    const conflicts = (await res.json()) as { entries: { messageId: string; reason: string; body: { messageId: string } }[]; cursor: number; more: boolean };
    expect(conflicts.entries).toHaveLength(1);
    expect(conflicts.entries[0]).toMatchObject({ messageId: stale.messageId, reason: 'revision_conflict' });
    expect(conflicts.entries[0].body.messageId).toBe(stale.messageId);
  });

  it('cursor beyond the end returns no entries and the same cursor; bad params are 400', async () => {
    const dev = await pairedDevice();
    const page = await pull(dev.token, 99);
    expect(page).toEqual({ entries: [], cursor: 99, more: false });
    expect((await get(dev.token, '/v1/sync?cursor=abc')).status).toBe(400);
    expect((await get(dev.token, '/v1/sync?cursor=0&limit=0')).status).toBe(400);
    expect((await get(null, '/v1/sync?cursor=0')).status).toBe(401);
  });

  it('limit is capped at 500', async () => {
    const dev = await pairedDevice();
    expect((await get(dev.token, '/v1/sync?cursor=0&limit=501')).status).toBe(400);
  });
});
