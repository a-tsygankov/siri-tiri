import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pairedDevice, post } from './helpers';
import { capture, episode, item, review, tombstone, trim } from './fixtures';

type Result = { messageId?: string; status: string; reason?: string; latestRevision?: number };
async function send(token: string, items: unknown[]): Promise<Result[]> {
  const res = await post(token, '/v1/messages', { messages: items });
  if (res.status !== 200) throw new Error(`push ${res.status} ${await res.text()}`);
  return ((await res.json()) as { results: Result[] }).results;
}
const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;

describe('POST /v1/messages', () => {
  it('accepts a capture, stores received_at, creates a clips row and one sync_log row', async () => {
    const dev = await pairedDevice();
    const cap = capture();
    const [r] = await send(dev.token, [item('event', cap)]);
    expect(r).toEqual({ messageId: cap.messageId, status: 'accepted' });
    const row = await env.DB.prepare('SELECT * FROM messages WHERE message_id = ?').bind(cap.messageId).first<Record<string, string>>();
    expect(row?.kind).toBe('event'); expect(row?.event_id).toBe(cap.eventId); expect(row?.device_id).toBe(dev.deviceId);
    expect(row?.status).toBe('accepted'); expect(Date.parse(row!.received_at)).toBeGreaterThan(0);
    expect(JSON.parse(row!.body)).toEqual(cap);
    const clip = await env.DB.prepare('SELECT * FROM clips WHERE clip_id = ?').bind(cap.payload.clipId).first<Record<string, string | null>>();
    expect(clip).toMatchObject({ event_id: cap.eventId, device_id: dev.deviceId, sha256: cap.payload.sha256, size_bytes: 1644, uploaded_at: null });
    expect(clip?.r2_key).toBe(`clips/${cap.eventId}/${cap.payload.clipId}.wav`);
    expect(await count("SELECT count(*) AS n FROM sync_log WHERE kind = 'message'")).toBe(1);
  });

  it('same messageId with same body is duplicate and writes nothing new', async () => {
    const dev = await pairedDevice();
    const cap = capture();
    await send(dev.token, [item('event', cap)]);
    const [r] = await send(dev.token, [item('event', { ...cap, payload: { ...cap.payload } })]);
    expect(r).toEqual({ messageId: cap.messageId, status: 'duplicate' });
    expect(await count('SELECT count(*) AS n FROM sync_log')).toBe(1);
  });

  it('same messageId with a different body is conflict payload_mismatch', async () => {
    const dev = await pairedDevice();
    const cap = capture();
    await send(dev.token, [item('event', cap)]);
    const [r] = await send(dev.token, [item('event', { ...cap, payload: { ...cap.payload, durationMs: 51 } })]);
    expect(r).toEqual({ messageId: cap.messageId, status: 'conflict', reason: 'payload_mismatch' });
    expect(await count('SELECT count(*) AS n FROM messages')).toBe(1);
  });

  it('an item missing eventId is rejected and the other items in the batch are accepted', async () => {
    const dev = await pairedDevice();
    const good = capture();
    const { eventId: _drop, ...bad } = capture();
    const results = await send(dev.token, [item('event', bad), item('event', good)]);
    expect(results[0].status).toBe('rejected');
    expect(results[0].reason).toContain('eventId');
    expect(results[1]).toEqual({ messageId: good.messageId, status: 'accepted' });
  });

  it('51 items is 400 and a non-array is 400', async () => {
    const dev = await pairedDevice();
    const many = Array.from({ length: 51 }, () => item('event', capture()));
    expect((await post(dev.token, '/v1/messages', { messages: many })).status).toBe(400);
    expect((await post(dev.token, '/v1/messages', { messages: 'x' })).status).toBe(400);
  });

  it('review revision 1 then 2 are accepted into review_chain', async () => {
    const dev = await pairedDevice();
    const cap = capture();
    const r1 = review({ eventId: cap.eventId, revision: 1, baseRevision: null });
    const r2 = review({ eventId: cap.eventId, revision: 2, baseRevision: 1, reviewId: r1.reviewId, context: 'play' });
    const results = await send(dev.token, [item('event', cap), item('review', r1), item('review', r2)]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted']);
    const chain = await env.DB.prepare('SELECT revision, message_id FROM review_chain WHERE event_id = ? ORDER BY revision').bind(cap.eventId).all<{ revision: number; message_id: string }>();
    expect(chain.results).toEqual([{ revision: 1, message_id: r1.messageId }, { revision: 2, message_id: r2.messageId }]);
  });

  it('a review whose base is stale is revision_conflict with latestRevision, stored as conflict, not logged', async () => {
    const dev = await pairedDevice();
    const cap = capture();
    const r1 = review({ eventId: cap.eventId, revision: 1, baseRevision: null });
    const r2 = review({ eventId: cap.eventId, revision: 2, baseRevision: 1, reviewId: r1.reviewId });
    await send(dev.token, [item('event', cap), item('review', r1), item('review', r2)]);
    const stale = review({ eventId: cap.eventId, revision: 3, baseRevision: 1, reviewId: r1.reviewId });
    const [r] = await send(dev.token, [item('review', stale)]);
    expect(r).toEqual({ messageId: stale.messageId, status: 'conflict', reason: 'revision_conflict', latestRevision: 2 });
    const row = await env.DB.prepare('SELECT status, conflict_reason FROM messages WHERE message_id = ?').bind(stale.messageId).first<{ status: string; conflict_reason: string }>();
    expect(row).toEqual({ status: 'conflict', conflict_reason: 'revision_conflict' });
    expect(await count("SELECT count(*) AS n FROM sync_log WHERE kind = 'message'")).toBe(3);
    // resending the same conflict message is a duplicate of the stored conflict, still reported as conflict
    const [again] = await send(dev.token, [item('review', stale)]);
    expect(again.status).toBe('conflict');
  });

  it('same revision from two devices: the second is revision_conflict', async () => {
    const a = await pairedDevice('A');
    const b = await pairedDevice('B');
    const cap = capture();
    const r1 = review({ eventId: cap.eventId, revision: 1, baseRevision: null });
    await send(a.token, [item('event', cap), item('review', r1)]);
    const fromA = review({ eventId: cap.eventId, revision: 2, baseRevision: 1, reviewId: r1.reviewId, context: 'play' });
    const fromB = review({ eventId: cap.eventId, revision: 2, baseRevision: 1, reviewId: r1.reviewId, context: 'door' });
    expect((await send(a.token, [item('review', fromA)]))[0].status).toBe('accepted');
    const [rb] = await send(b.token, [item('review', fromB)]);
    expect(rb).toMatchObject({ status: 'conflict', reason: 'revision_conflict', latestRevision: 2 });
  });

  it('tombstone marks the event clips deleted', async () => {
    const dev = await pairedDevice();
    const cap = capture();
    const t = tombstone(cap);
    const results = await send(dev.token, [item('event', cap), item('event', t)]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
    const clip = await env.DB.prepare('SELECT deleted_at FROM clips WHERE clip_id = ?').bind(cap.payload.clipId).first<{ deleted_at: string | null }>();
    expect(clip?.deleted_at).toBeTruthy();
    expect(await count('SELECT count(*) AS n FROM clips')).toBe(1); // tombstone creates no clip row
  });

  it('trim capture with the same eventId creates a second clips row', async () => {
    const dev = await pairedDevice();
    const cap = capture();
    const t = trim(cap);
    const results = await send(dev.token, [item('event', cap), item('event', t)]);
    expect(results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
    expect(await count(`SELECT count(*) AS n FROM clips WHERE event_id = '${cap.eventId}'`)).toBe(2);
  });

  it('episode message is accepted and logged without chain checks', async () => {
    const dev = await pairedDevice();
    const cap = capture();
    const ep = episode({ episodeId: crypto.randomUUID(), revision: 5, eventId: cap.eventId });
    const [r] = await send(dev.token, [item('episode', ep)]);
    expect(r).toEqual({ messageId: ep.messageId, status: 'accepted' });
    const row = await env.DB.prepare('SELECT kind, correlation_key FROM messages WHERE message_id = ?').bind(ep.messageId).first<{ kind: string; correlation_key: string }>();
    expect(row).toEqual({ kind: 'episode', correlation_key: ep.episodeId });
    expect(await count("SELECT count(*) AS n FROM sync_log WHERE kind = 'message'")).toBe(1);
  });

  it('a review with an unknown kind value is rejected', async () => {
    const dev = await pairedDevice();
    const [r] = await send(dev.token, [{ kind: 'analysis', body: capture() }]);
    expect(r.status).toBe('rejected');
  });

  describe('logging', () => {
    const lines: string[] = [];
    beforeEach(() => { lines.length = 0; vi.spyOn(console, 'log').mockImplementation((s: string) => { lines.push(String(s)); }); });
    afterEach(() => { vi.restoreAllMocks(); });

    it('ingest log lines carry counts but no body, token or code', async () => {
      const dev = await pairedDevice();
      const cap = capture();
      await send(dev.token, [item('event', cap)]);
      const ingest = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'messages_ingested');
      expect(ingest).toMatchObject({ accepted: 1, duplicate: 0, conflict: 0, rejected: 0, deviceId: dev.deviceId });
      const all = lines.join('\n');
      expect(all).not.toContain(dev.token);
      expect(all).not.toContain(cap.payload.sha256);
      expect(all).not.toContain(cap.messageId);
    });
  });
});
