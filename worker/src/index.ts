import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { MIGRATION, PROTOCOL_VERSION, WORKER_VERSION, type Env } from './env';
import { log } from './log';
import { createPairingCode, listDevices, pairDevice, requestNow, requireAdmin, requireDevice, revokeDevice, type AuthVars } from './auth';

export type Vars = AuthVars;
export type App = Hono<{ Bindings: Env; Variables: Vars }>;

const app: App = new Hono();

app.use('*', async (c, next) => {
  const requestId = c.req.header('X-Request-Id')?.match(/^[0-9a-f-]{36}$/i) ? c.req.header('X-Request-Id')! : crypto.randomUUID();
  c.set('requestId', requestId);
  const started = Date.now();
  await next();
  c.header('X-Request-Id', requestId);
  if (c.req.method !== 'OPTIONS') {
    log('request', { method: c.req.method, path: c.req.path, status: c.res.status, latencyMs: Date.now() - started, requestId });
  }
});

app.use('*', (c, next) => cors({
  origin: (origin) => (c.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(origin) ? origin : null),
  allowHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Test-Now'],
  allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  exposeHeaders: ['X-Request-Id', 'ETag'],
  maxAge: 600,
})(c, next));

app.get('/v1/health', (c) => c.json({ status: 'ok', component: 'worker', version: WORKER_VERSION, protocolVersion: PROTOCOL_VERSION, migration: MIGRATION }));

const str = (v: unknown, max = 128) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

app.post('/v1/admin/pairing-codes', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({})) as { label?: unknown };
  const label = str(body.label) ?? 'device';
  return c.json(await createPairingCode(c.env, label, requestNow(c)), 201);
});

app.get('/v1/admin/devices', requireAdmin, async (c) => c.json({ devices: await listDevices(c.env) }));

app.post('/v1/admin/devices/:id/revoke', requireAdmin, async (c) => {
  const revokedAt = await revokeDevice(c.env, c.req.param('id'), requestNow(c));
  if (!revokedAt) return c.json({ error: 'not_found', requestId: c.get('requestId') }, 404);
  return c.json({ deviceId: c.req.param('id'), revokedAt });
});

app.post('/v1/devices/pair', async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const code = body && str(body.code, 32);
  const sourceId = body && str(body.sourceId);
  const component = body && str(body.component, 32);
  if (!code || !sourceId || !component) return c.json({ error: 'bad_request', requestId: c.get('requestId') }, 400);
  const paired = await pairDevice(c.env, { code, sourceId, component, version: str(body!.version, 64) ?? '', label: str(body!.label) ?? '' }, requestNow(c));
  if (!paired) return c.json({ error: 'unauthorized', requestId: c.get('requestId') }, 401);
  return c.json({ ...paired, protocolVersion: PROTOCOL_VERSION }, 201);
});

app.get('/v1/whoami', requireDevice, (c) => c.json(c.get('device')));

app.notFound((c) => c.json({ error: 'not_found', requestId: c.get('requestId') }, 404));

app.onError((err, c) => {
  const requestId = c.get('requestId');
  log('request_error', { requestId, path: c.req.path, name: err.name, message: err.message });
  return c.json({ error: 'internal', requestId }, 500);
});

export default app;
