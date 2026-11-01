# Siri-Tiri

Personalized cat vocalization event assistant and companion UI prototypes. The design records **owner-observed context**, not literal translations of meows.

## Interactive mockups

- **[Review v5 — round device + phone](https://a-tsygankov.github.io/siri-tiri/connected-ui-v5.html)** — latest: progressive review on 466×466 circular UI; expandable context, location, behavior and outcome on phone.
- [Connected UI v4](https://a-tsygankov.github.io/siri-tiri/connected-ui-v4.html) — earlier combined prototype.
- [Round ESP32 prototype](https://a-tsygankov.github.io/siri-tiri/ui-prototype.html)
- [Phone companion prototype](https://a-tsygankov.github.io/siri-tiri/companion-app-design.html)
- [Mockup gallery](https://a-tsygankov.github.io/siri-tiri/)

Source files live in [docs/](docs/). These are interactive demos with simulated events, not running firmware or a connected service.

## Design documentation

- [UI handoff](docs/UI_HANDOFF.md)
- [Round display safe-area findings](docs/ROUND_UI_SAFE_AREA.md)
- [Project plan](docs/PROJECT_PLAN.md)

GitHub Pages is deployed from `docs/` using [GitHub Actions](.github/workflows/pages.yml).


## Architecture and implementation roadmap

**Approved design baseline; infrastructure not yet implemented.** Prototype first on a Windows 11 laptop, then support Raspberry Pi. ESP32 and PWA retain offline queues; Cloudflare Workers + D1 + R2 provide synchronization and durable job storage. YAMNet runs locally initially; Cloudflare Containers is an optional future experiment.

- [Architecture: offline sync, updates and centralized logging](docs/ARCHITECTURE_SYNC_UPDATES_LOGGING.md)
- [Release manifest example](docs/release-manifest.example.json)
- [Project milestones](docs/PROJECT_PLAN.md)
- [Device/PWA handoff and diagnostic UI requirements](docs/UI_HANDOFF.md)

Planned lifecycle: independently versioned components and schemas, automatic PWA/local-service updates, signed ESP32 OTA with rollback, and structured diagnostics accessible on phone, a Cloudflare-hosted page, and the local service.
