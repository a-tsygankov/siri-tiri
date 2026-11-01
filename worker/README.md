# Siri-Tiri Worker (cloud sync)

Cloudflare Worker (Hono + TypeScript) that stores capture, review and episode messages in D1, WAV clips in R2, and serves a cursor-based sync log to paired devices. Design: [`docs/superpowers/specs/2026-11-01-cloud-sync-design.md`](../docs/superpowers/specs/2026-11-01-cloud-sync-design.md).

Component version `0.1.0`, protocol 1, D1 migration 1. **Not deployed**: `wrangler.toml` carries placeholder ids until the owner creates resources.

## Local development

```powershell
cd worker
npm install --legacy-peer-deps      # npm 10.9 trips over vitest's optional peers without the flag
Copy-Item .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev                         # http://127.0.0.1:8787
```

Mint a pairing code for a phone or browser profile (reads `ADMIN_SECRET` from `.dev.vars`, or `SIRI_TIRI_ADMIN_SECRET`):

```powershell
node scripts/pairing-code.mjs --url http://127.0.0.1:8787 --label "Andrey iPhone"
```

Type the code into the app's Settings, Cloud sync card, with the server URL. The code works once and expires after 15 minutes.

## Tests

```powershell
cd worker
npm test            # vitest in the Workers runtime against a local D1 and R2 (migrations applied per test)
npm run typecheck
```

CI: `.github/workflows/worker-ci.yml`.

## API (protocol 1)

| Route | Auth | Purpose |
|---|---|---|
| `GET /v1/health` | none | component, version, protocol, migration |
| `POST /v1/admin/pairing-codes` `{label}` | admin secret | one-time pairing code (15 min, single use) |
| `GET /v1/admin/devices` | admin secret | list devices |
| `POST /v1/admin/devices/:id/revoke` | admin secret | revoke a device token |
| `POST /v1/devices/pair` `{code, sourceId, component, version, label}` | none | exchange a code for a device token (returned once) |
| `GET /v1/whoami` | device | cheap token check |
| `POST /v1/messages` `{messages: [{kind, body}]}` | device | at most 50 items; per-item `accepted`, `duplicate`, `conflict`, `rejected` |
| `PUT /v1/clips/:clipId` (`audio/wav`) | device | upload the WAV declared by an accepted capture; size and SHA-256 verified |
| `GET /v1/clips/:clipId` | device | download a WAV |
| `GET /v1/sync?cursor=&limit=` | device | sync log entries after `cursor` |
| `GET /v1/conflicts?cursor=&limit=` | device | messages kept as conflicts |

Errors are `{error, requestId}`. Every response carries `X-Request-Id`. Logs are one JSON line per request with ids, counts, status and latency; never bodies, audio, tokens or codes.

## Remote deployment (owner only, not run)

```powershell
wrangler d1 create siri-tiri-db          # then put the id into wrangler.toml
wrangler r2 bucket create siri-tiri-clips
wrangler secret put ADMIN_SECRET
npm run db:migrate:remote
npm run deploy
```

Add the GitHub Pages origin to `ALLOWED_ORIGINS` in `wrangler.toml` (already set) and any other origin the app is served from.
