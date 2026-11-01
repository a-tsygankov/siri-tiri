import { SELF } from 'cloudflare:test';

export const ADMIN = 'test-admin';

export function admin(path: string, body?: unknown, method = 'POST') {
  return SELF.fetch('http://x' + path, {
    method,
    headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function post(token: string | null, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch('http://x' + path, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

export function get(token: string | null, path: string, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch('http://x' + path, { headers });
}

export async function mintCode(label = 'test phone'): Promise<string> {
  const res = await admin('/v1/admin/pairing-codes', { label });
  if (res.status !== 201) throw new Error('mint failed ' + res.status);
  return ((await res.json()) as { code: string }).code;
}

let n = 0;
export async function pairedDevice(label = 'phone') {
  const code = await mintCode(label);
  const sourceId = `pwa-${label}-${++n}`;
  const res = await post(null, '/v1/devices/pair', { code, sourceId, component: 'pwa', version: '0.2.0', label });
  if (res.status !== 201) throw new Error('pair failed ' + res.status);
  const body = (await res.json()) as { deviceId: string; token: string };
  return { ...body, sourceId, label };
}
