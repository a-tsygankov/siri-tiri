#!/usr/bin/env node
// Mint a one-time pairing code: node scripts/pairing-code.mjs --url http://127.0.0.1:8787 --label "Andrey iPhone"
// ADMIN_SECRET comes from SIRI_TIRI_ADMIN_SECRET or from worker/.dev.vars. The code prints once.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const url = opt('--url', 'http://127.0.0.1:8787').replace(/\/$/, '');
const label = opt('--label', 'device');

function secretFromDevVars() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.dev.vars');
    const line = readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.startsWith('ADMIN_SECRET='));
    return line ? line.slice('ADMIN_SECRET='.length).trim() : null;
  } catch { return null; }
}
const secret = process.env.SIRI_TIRI_ADMIN_SECRET || secretFromDevVars();
if (!secret) { console.error('No admin secret: set SIRI_TIRI_ADMIN_SECRET or create worker/.dev.vars'); process.exit(2); }

const res = await fetch(`${url}/v1/admin/pairing-codes`, {
  method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
});
if (res.status !== 201) { console.error(`Request failed: ${res.status} ${await res.text()}`); process.exit(1); }
const { code, expiresAt } = await res.json();
console.log(`Pairing code for "${label}": ${code}\nExpires: ${expiresAt}\nServer: ${url}\nEnter both in the app: Settings, Cloud sync.`);
