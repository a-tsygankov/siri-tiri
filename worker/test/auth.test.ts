import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { admin, get, mintCode, pairedDevice, post } from './helpers';

const pairBody = (code: string) => ({ code, sourceId: 'pwa-1', component: 'pwa', version: '0.2.0', label: 'phone' });

describe('pairing and device tokens', () => {
  it('pairing with a fresh code returns a token; the same code again is 401', async () => {
    const code = await mintCode('iPhone');
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    const first = await post(null, '/v1/devices/pair', pairBody(code));
    expect(first.status).toBe(201);
    const body = (await first.json()) as { deviceId: string; token: string; protocolVersion: number };
    expect(body.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.token.length).toBeGreaterThanOrEqual(40);
    expect(body.protocolVersion).toBe(1);
    const second = await post(null, '/v1/devices/pair', pairBody(code));
    expect(second.status).toBe(401);
    expect(await second.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('an expired code is 401', async () => {
    const code = await mintCode();
    const later = new Date(Date.now() + 16 * 60 * 1000).toISOString();
    const res = await post(null, '/v1/devices/pair', pairBody(code), { 'X-Test-Now': later });
    expect(res.status).toBe(401);
  });

  it('five wrong-code attempts invalidate every open code', async () => {
    const code = await mintCode();
    for (let i = 0; i < 4; i++) expect((await post(null, '/v1/devices/pair', pairBody('AAAAAAAA'))).status).toBe(401);
    expect((await post(null, '/v1/devices/pair', pairBody(code))).status).toBe(201); // 4 misses are fine
    const code2 = await mintCode();
    for (let i = 0; i < 5; i++) expect((await post(null, '/v1/devices/pair', pairBody('AAAAAAAA'))).status).toBe(401);
    expect((await post(null, '/v1/devices/pair', pairBody(code2))).status).toBe(401);
    const rows = await env.DB.prepare('SELECT count(*) AS n FROM pairing_codes WHERE used_at IS NULL').first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('admin routes reject a missing or wrong secret with 401', async () => {
    const missing = await SELF.fetch('http://x/v1/admin/pairing-codes', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(missing.status).toBe(401);
    const wrong = await SELF.fetch('http://x/v1/admin/devices', { headers: { Authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
  });

  it('GET /v1/whoami needs a valid token and reports the device', async () => {
    const dev = await pairedDevice('A');
    const ok = await get(dev.token, '/v1/whoami');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ deviceId: dev.deviceId, sourceId: dev.sourceId, label: 'A' });
    expect((await get(null, '/v1/whoami')).status).toBe(401);
    expect((await get('bad-token', '/v1/whoami')).status).toBe(401);
  });

  it('a revoked device token is 401 and the device is listed as revoked', async () => {
    const dev = await pairedDevice('B');
    const rev = await admin(`/v1/admin/devices/${dev.deviceId}/revoke`);
    expect(rev.status).toBe(200);
    expect((await get(dev.token, '/v1/whoami')).status).toBe(401);
    const list = await admin('/v1/admin/devices', undefined, 'GET');
    const { devices } = (await list.json()) as { devices: { deviceId: string; revokedAt: string | null; label: string }[] };
    const row = devices.find((d) => d.deviceId === dev.deviceId);
    expect(row?.revokedAt).toBeTruthy();
    expect(row?.label).toBe('B');
    expect(JSON.stringify(devices)).not.toContain(dev.token);
  });

  it('the token hash, not the token, is stored', async () => {
    const dev = await pairedDevice('C');
    const row = await env.DB.prepare('SELECT token_hash FROM devices WHERE device_id = ?').bind(dev.deviceId).first<{ token_hash: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_hash).not.toBe(dev.token);
  });

  it('pairing with a malformed body is 400', async () => {
    const res = await post(null, '/v1/devices/pair', { code: 'ABCDEFGH' });
    expect(res.status).toBe(400);
  });
});
