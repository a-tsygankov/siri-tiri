/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Context, MiddlewareHandler } from 'hono';
import { PAIRING_CODE_MAX_ATTEMPTS, PAIRING_CODE_TTL_MS, type Env } from './env';
import { log } from './log';

export interface Device {
  deviceId: string;
  sourceId: string;
  label: string;
  component: string;
}

export type AuthVars = { device: Device; requestId: string };

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function createPairingCode(env: Env, label: string, now: Date): Promise<{ code: string; expiresAt: string }> {
  const code = generateCode();
  const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString();
  await env.DB.prepare('INSERT INTO pairing_codes (code_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(code), label, now.toISOString(), expiresAt).run();
  log('pairing_code_created', { expiresAt });
  return { code, expiresAt };
}

export interface PairRequest { code: string; sourceId: string; component: string; version: string; label: string }

// Consecutive failed pairing attempts (any code) are counted; at the limit every open code is
// deleted so a brute-force run cannot keep guessing against a live code.
async function recordPairingFailure(env: Env): Promise<void> {
  const row = await env.DB.prepare(
    "INSERT INTO counters (key, value) VALUES ('pairing_failures', 1) ON CONFLICT(key) DO UPDATE SET value = value + 1 RETURNING value",
  ).first<{ value: number }>();
  if ((row?.value ?? 0) >= PAIRING_CODE_MAX_ATTEMPTS) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM pairing_codes WHERE used_at IS NULL'),
      env.DB.prepare("DELETE FROM counters WHERE key = 'pairing_failures'"),
    ]);
    log('pairing_codes_invalidated', { reason: 'too_many_failures' });
  }
}

export async function pairDevice(env: Env, req: PairRequest, now: Date): Promise<{ deviceId: string; token: string } | null> {
  const codeHash = await sha256Hex(normalizeCode(req.code));
  const row = await env.DB.prepare('SELECT label, expires_at, used_at FROM pairing_codes WHERE code_hash = ?')
    .bind(codeHash).first<{ label: string; expires_at: string; used_at: string | null }>();
  const usable = row && row.used_at === null && Date.parse(row.expires_at) > now.getTime();
  if (!usable) {
    await recordPairingFailure(env);
    log('pairing_failed', { reason: !row ? 'unknown_code' : row.used_at ? 'used_code' : 'expired_code' });
    return null;
  }
  const deviceId = crypto.randomUUID();
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const at = now.toISOString();
  const used = await env.DB.prepare('UPDATE pairing_codes SET used_at = ?, used_by_device_id = ? WHERE code_hash = ? AND used_at IS NULL')
    .bind(at, deviceId, codeHash).run();
  if (!used.meta.changes) { await recordPairingFailure(env); return null; } // raced with another pair
  await env.DB.batch([
    env.DB.prepare('INSERT INTO devices (device_id, source_id, label, component, version, token_hash, paired_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(deviceId, req.sourceId, req.label || row.label, req.component, req.version, tokenHash, at, at),
    env.DB.prepare("DELETE FROM counters WHERE key = 'pairing_failures'"),
  ]);
  log('device_paired', { deviceId, component: req.component });
  return { deviceId, token };
}

export async function authenticate(env: Env, authorization: string | undefined, now: Date): Promise<Device | null> {
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return null;
  const row = await env.DB.prepare('SELECT device_id, source_id, label, component, last_seen_at FROM devices WHERE token_hash = ? AND revoked_at IS NULL')
    .bind(await sha256Hex(token)).first<{ device_id: string; source_id: string; label: string; component: string; last_seen_at: string | null }>();
  if (!row) return null;
  if (!row.last_seen_at || now.getTime() - Date.parse(row.last_seen_at) > 60_000) {
    await env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE device_id = ?').bind(now.toISOString(), row.device_id).run();
  }
  return { deviceId: row.device_id, sourceId: row.source_id, label: row.label, component: row.component };
}

export async function listDevices(env: Env) {
  const { results } = await env.DB.prepare('SELECT device_id, source_id, label, component, version, paired_at, last_seen_at, revoked_at FROM devices ORDER BY paired_at').all<Record<string, string | null>>();
  return results.map((r) => ({
    deviceId: r.device_id, sourceId: r.source_id, label: r.label, component: r.component, version: r.version,
    pairedAt: r.paired_at, lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at,
  }));
}

export async function revokeDevice(env: Env, deviceId: string, now: Date): Promise<string | null> {
  const at = now.toISOString();
  const res = await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').bind(at, deviceId).run();
  if (!res.meta.changes) {
    const exists = await env.DB.prepare('SELECT revoked_at FROM devices WHERE device_id = ?').bind(deviceId).first<{ revoked_at: string }>();
    return exists ? exists.revoked_at : null;
  }
  log('device_revoked', { deviceId });
  return at;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

// Request clock: real time, except under ENVIRONMENT=test where X-Test-Now may override it.
export function requestNow(c: Context<any>): Date {
  const override = c.env.ENVIRONMENT === 'test' ? c.req.header('X-Test-Now') : undefined;
  const t = override ? Date.parse(override) : NaN;
  return Number.isFinite(t) ? new Date(t) : new Date();
}

export const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: { requestId: string } }> = async (c, next) => {
  const token = c.req.header('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
  if (!c.env.ADMIN_SECRET || !timingSafeEqual(token, c.env.ADMIN_SECRET)) {
    return c.json({ error: 'unauthorized', requestId: c.get('requestId') }, 401);
  }
  await next();
};

export const requireDevice: MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> = async (c, next) => {
  const device = await authenticate(c.env, c.req.header('Authorization'), requestNow(c));
  if (!device) return c.json({ error: 'unauthorized', requestId: c.get('requestId') }, 401);
  c.set('device', device);
  await next();
};
