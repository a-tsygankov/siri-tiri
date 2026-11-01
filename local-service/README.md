# Siri-Tiri local prototype service

A **dependency-free Python 3.11+** Windows 11 / Raspberry Pi foundation for durable event ingestion and inspection. It is intentionally not yet the YAMNet inference worker. No Cloudflare or ESP32 integration yet.

On Windows PowerShell:

```powershell
cd local-service
py -3 service.py
# second terminal:
py -3 -m unittest discover -s tests -v
```

Service binds **127.0.0.1:8765 only**. State defaults to `local-service/data/siri-tiri.sqlite3` (override with `SIRI_TIRI_DB`). SQLite WAL survives process restarts. Endpoints: `GET /health`, `GET /version`, `GET /events`, `GET /logs`, `POST /events`, `POST /logs`. POST event requires UUID `messageId`/`eventId`, `schemaVersion:1`, `sourceId`, `createdAt`, `type`. POST log accepts log.v1 envelope. Duplicate message IDs are accepted without creating duplicate events. Event listing supports `?limit=100` (max 500).

Example PowerShell:

```powershell
$event = @{schemaVersion=1;messageId=[guid]::NewGuid().ToString();eventId=[guid]::NewGuid().ToString();sourceId='phone-demo';createdAt=[DateTime]::UtcNow.ToString('o');type='review';payload=@{context='Unsure'}} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri http://127.0.0.1:8765/events -Method Post -ContentType 'application/json' -Body $event
Invoke-RestMethod http://127.0.0.1:8765/events
```

**Security boundary:** localhost-only, no authentication; do not expose this prototype to LAN or internet. Add authenticated LAN access, worker leases, audio storage, Cloudflare sync and YAMNet next. Logs are not yet redacted automatically; clients must omit secrets.
