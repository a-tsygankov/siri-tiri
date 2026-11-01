import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { MAX_CLIP_BYTES, MAX_MESSAGES_BODY_BYTES, MAX_MESSAGES_PER_REQUEST, MIGRATION, PROTOCOL_VERSION, WORKER_VERSION, type Env } from './env';
import { ingest } from './messages';
import { getClip, putClip } from './clips';
import { conflicts, pageParams, pull } from './sync';
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

app.post('/v1/messages', requireDevice, async (c) => {
  const length = Number(c.req.header('Content-Length') ?? '0');
  if (length > MAX_MESSAGES_BODY_BYTES) return c.json({ error: 'too_large', requestId: c.get('requestId') }, 413);
  const text = await c.req.text();
  if (text.length > MAX_MESSAGES_BODY_BYTES) return c.json({ error: 'too_large', requestId: c.get('requestId') }, 413);
  let body: { messages?: unknown };
  try { body = JSON.parse(text); } catch { return c.json({ error: 'bad_request', requestId: c.get('requestId') }, 400); }
  const items = body?.messages;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_MESSAGES_PER_REQUEST) {
    return c.json({ error: 'bad_request', requestId: c.get('requestId') }, 400);
  }
  const results = await ingest(c.env, c.get('device'), items, requestNow(c), c.get('requestId'));
  return c.json({ results });
});

const PUT_STATUS: Record<string, [number, string]> = {
  not_found: [404, 'not_found'], deleted: [410, 'clip_deleted'], forbidden: [403, 'forbidden'], mismatch: [409, 'clip_mismatch'],
};

app.put('/v1/clips/:clipId', requireDevice, async (c) => {
  const requestId = c.get('requestId');
  const type = (c.req.header('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'audio/wav' && type !== 'audio/x-wav') return c.json({ error: 'unsupported_media_type', requestId }, 415);
  const length = Number(c.req.header('Content-Length') ?? '0');
  if (length > MAX_CLIP_BYTES) return c.json({ error: 'too_large', requestId }, 413);
  const body = await c.req.arrayBuffer();
  if (body.byteLength > MAX_CLIP_BYTES) return c.json({ error: 'too_large', requestId }, 413);
  const clipId = c.req.param('clipId');
  const result = await putClip(c.env, c.get('device'), clipId, body, requestNow(c), requestId);
  if (result.status === 'uploaded') return c.json({ clipId, uploadedAt: result.uploadedAt }, 201);
  if (result.status === 'already') return c.json({ clipId, uploadedAt: result.uploadedAt }, 200);
  const [status, error] = PUT_STATUS[result.status];
  return c.json({ error, requestId }, status as 404);
});

app.get('/v1/clips/:clipId', requireDevice, async (c) => {
  const found = await getClip(c.env, c.req.param('clipId'));
  if (!found) return c.json({ error: 'not_found', requestId: c.get('requestId') }, 404);
  return new Response(found.object.body, {
    headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(found.sizeBytes), ETag: `"${found.sha256}"`, 'Cache-Control': 'private, max-age=0' },
  });
});

app.get('/v1/sync', requireDevice, async (c) => {
  const params = pageParams({ cursor: c.req.query('cursor'), limit: c.req.query('limit') });
  if (!params) return c.json({ error: 'bad_request', requestId: c.get('requestId') }, 400);
  return c.json(await pull(c.env, params.cursor, params.limit));
});

app.get('/v1/conflicts', requireDevice, async (c) => {
  const params = pageParams({ cursor: c.req.query('cursor'), limit: c.req.query('limit') });
  if (!params) return c.json({ error: 'bad_request', requestId: c.get('requestId') }, 400);
  return c.json(await conflicts(c.env, params.cursor, params.limit));
});

app.notFound((c) => c.json({ error: 'not_found', requestId: c.get('requestId') }, 404));

app.onError((err, c) => {
  const requestId = c.get('requestId');
  log('request_error', { requestId, path: c.req.path, name: err.name, message: err.message });
  return c.json({ error: 'internal', requestId }, 500);
});

export default app;
