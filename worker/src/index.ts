import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { MIGRATION, PROTOCOL_VERSION, WORKER_VERSION, type Env } from './env';
import { log } from './log';

export type Vars = { requestId: string };
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

app.notFound((c) => c.json({ error: 'not_found', requestId: c.get('requestId') }, 404));

app.onError((err, c) => {
  const requestId = c.get('requestId');
  log('request_error', { requestId, path: c.req.path, name: err.name, message: err.message });
  return c.json({ error: 'internal', requestId }, 500);
});

export default app;
