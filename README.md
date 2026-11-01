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


## First executable prototype: Windows local service

The [local service](local-service/README.md) is a Python 3.11+ localhost-only HTTP API backed by SQLite WAL, with durable event ingestion, idempotent message IDs and structured log storage. Run `py -3 local-service/service.py` on Windows 11 and open `http://127.0.0.1:8765/health`. [Windows CI tests](.github/workflows/local-service-ci.yml) cover persistence, deduplication, validation and logs. [Versioned contracts](contracts/) describe event/log envelopes.

**Current limitations:** no audio capture, authenticated LAN access, Cloudflare integration, OTA or auto-update yet. Do not expose the prototype port beyond localhost. YAMNet supports explicitly supplied local WAV clips; accuracy on Tiri recordings remains unvalidated.

Local service **0.2.0** adds a durable SQLite processing queue with atomic capture enqueue, worker claim leases, heartbeats, result acknowledgment, retry limits and crash recovery. See the [worker API and migration notes](local-service/README.md#durable-processing-jobs-020) before upgrading an existing database. The queue does not run inference automatically.

Local service **0.3.0** adds an optional Windows CPU YAMNet worker and repeatable setup/run/test/status scripts. Start with `.\scripts\setup.ps1`, then `.\scripts\run.ps1` for API plus worker. See [setup and audio requirements](local-service/README.md#setup-and-run-the-local-stack-030) and [checkpoint research](local-service/MODEL_RESEARCH.md).

## CatMeows research dataset

Start recorded-clip experiments with the authors' [CatMeows v1.0.2 download and terms](https://zenodo.org/records/4008297), DOI [10.5281/zenodo.4008297](https://doi.org/10.5281/zenodo.4008297). It contains 440 meows from 21 cats in brushing, waiting-for-food and unfamiliar-isolation recording conditions. No Tiri recordings are available yet; these context labels are not interpretations of Tiri's intent.

```powershell
.\scripts\download-catmeows.ps1  # dataset only; no ML installation required
# Or include it with model/runtime setup:
.\scripts\setup.ps1 -CatMeows
# Python equivalents:
py -3 local-service/manage.py catmeows
py -3.13 local-service/manage.py setup --catmeows
```

Files go to ignored, checkout-relative **`CatMeows/`**: verified source ZIPs in `archives/`, original files in `raw/`, and download provenance in `provenance.json`. The primary 440 WAVs are under `CatMeows/raw/dataset/`; the supplementary archive adds 43 other-vocalization/sequence WAVs. Repeated downloads verify cached archives and extracted contents; local raw-file modifications are preserved and cause an explicit error rather than being overwritten. Never commit or upload the dataset automatically.

The authors permit **scientific research and non-commercial use**, require acknowledgment, and request citation of their work; see the source record for full terms and references. The supplementary files are not an automatically labeled household-background test set.

The downloaded originals are **8-kHz mono PCM16**. The worker currently accepts 16 kHz only, so use a separately versioned resampling/preprocessing step before inference. Originals remain unchanged; this download task does not evaluate accuracy or choose thresholds. See the [local setup notes](local-service/README.md#catmeows-download) for links and limits.
