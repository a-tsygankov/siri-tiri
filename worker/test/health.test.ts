import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('health and CORS', () => {
  it('GET /v1/health reports component, version, protocol and migration', async () => {
    const res = await SELF.fetch('http://x/v1/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', component: 'worker', version: '0.1.0', protocolVersion: 1, migration: 1 });
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('CORS preflight from an allowed origin is accepted and from another is not', async () => {
    const preflight = (origin: string) => SELF.fetch('http://x/v1/messages', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });
    const ok = await preflight('http://localhost:8080');
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:8080');
    expect(ok.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
    const bad = await preflight('http://evil.test');
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('unknown routes are 404 with an error code and request id', async () => {
    const res = await SELF.fetch('http://x/nope');
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string; requestId: string };
    expect(body.error).toBe('not_found');
    expect(body.requestId).toBe(res.headers.get('x-request-id'));
  });
});
