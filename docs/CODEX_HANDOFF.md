# Switch Siri-Tiri development to Codex

**Status:** handoff guide. Creating this document does not install Codex or change any local machine permissions.

## Repository and immediate context

Repository: https://github.com/a-tsygankov/siri-tiri

- `main` contains documentation and interactive mockups under `docs/`, shared v1 JSON Schemas under `contracts/`, and a durable Python SQLite localhost service with an optional YAMNet worker under `local-service/`.
- Mockup entry point: `docs/connected-ui-v5.html`; README links to GitHub Pages, but actual deployment/device rendering must be verified.
- Local service 0.3.0 has a pinned CPU YAMNet worker for local PCM16/16-kHz WAVs, plus setup/run/test/status tooling. Cloudflare synchronization, authentication, OTA and production PWA are not implemented.
- The service listens on `127.0.0.1:8765`, persists SQLite schema 2 in `local-service/data/`, and exposes health/version/events/logs and leased job APIs. It is a foundation, not a production server.
- **Mandatory:** all future repository modifications through feature branches and PRs; no direct commits to `main`. See root `AGENTS.md`.

## Setup on Windows 11

1. Install Codex using the official OpenAI Codex documentation or ChatGPT desktop Codex interface; sign in and grant repository-scoped access. Confirm current install instructions on https://developers.openai.com/codex/ .
2. Install Git and Python 3.11+ for the API; optional inference setup currently requires Windows x64 Python 3.13. Prefer least-privilege local installation. Optional: VS Code or IntelliJ for reviewing diffs.
3. In PowerShell:

```powershell
git clone https://github.com/a-tsygankov/siri-tiri.git
cd siri-tiri
git switch main
git pull --ff-only
py -3 -m unittest discover -s local-service/tests -v
py -3.13 local-service/manage.py setup --catmeows
py -3 local-service/manage.py run
```

4. In a second PowerShell window: `Invoke-RestMethod http://127.0.0.1:8765/health`. Stop with Ctrl+C.
5. Open the repository in Codex. Ask it to read `AGENTS.md` and the architecture/handoff documents before modifying code.
6. Keep permission prompts for privileged installs, hardware flashing, production deployments and destructive database changes.

## CatMeows starting dataset

No Tiri recordings are available yet. Use the authors' [CatMeows v1.0.2 record/download](https://zenodo.org/records/4008297), DOI [10.5281/zenodo.4008297](https://doi.org/10.5281/zenodo.4008297), for initial research pipeline experiments. The source provides 440 meows from 21 cats and a supplementary archive of 43 WAVs. Terms permit scientific research and non-commercial use and require acknowledgment/citation; retain the authors' references from the record. Never commit dataset/audio files or assume its context labels are Tiri's needs.

Dataset-only setup: `.\scripts\download-catmeows.ps1` or `py -3 local-service/manage.py catmeows`. Full model/runtime setup can include it with `.\scripts\setup.ps1 -CatMeows` or `py -3.13 local-service/manage.py setup --catmeows`. Default setup remains dataset-free. Commands resolve the destination from the checkout root even when launched from another directory.

`/CatMeows/` is ignored by Git. `archives/` retains verified source ZIPs; `raw/dataset/` contains the primary clips and `raw/` also retains supplementary original folders. `provenance.json` records version, source, terms and pinned SHA-256 values. Repeated setup verifies existing files and will not overwrite changed raw data. Direct links and checksums are documented in [local-service/README.md](../local-service/README.md#catmeows-download).

**Audio preprocessing:** originals are 8-kHz mono PCM16; the live worker still requires 16 kHz. `.\scripts\prepare-catmeows.ps1` creates versioned 16-kHz derivatives and a source/hash/grouping manifest without changing originals. `.\scripts\evaluate-catmeows.ps1` writes uniquely named JSON/CSV batch reports under ignored CatMeows/reports/. Run setup again to install the pinned SciPy dependency. Python commands: `py -3 local-service/manage.py prepare-catmeows` and `py -3 local-service/manage.py evaluate-catmeows`.

The initial run scored 440/440 primary clips and verified all 483 original WAV hashes unchanged. Metadata splitting keeps each cat's sessions together: 277 clips/14 cats calibration, 163 clips/7 cats evaluation. Five source filenames identify session 4 outside the published range; preserve the flagged values. See [baseline measurements/limits](../local-service/CATMEOWS_BASELINE.md) and [batch operation details](../local-service/README.md#catmeows-preparation-and-batch-scoring).

These positive-only diagnostics do not establish precision, household false-positive rate, a selected threshold, or accuracy on Tiri. Extras contain other cat vocalizations and uncut sequences; keep them unlabeled until reviewed. Source context remains recording metadata, separate from inference and owner observations. Batch tools do not access the service database or start the service.

## Suggested next Codex task

> Read AGENTS.md and the architecture/project/handoff documents. From updated main, add a reviewed positive/negative/uncertain annotation manifest and evaluation support for detector rules on local recordings, keeping cat/session grouping and provenance. CatMeows extras require review; do not silently assign them all negative labels. Preserve a calibration/evaluation separation and freeze a rule before reporting evaluation metrics. No Tiri recordings are available yet, so do not claim Tiri accuracy. Keep originals/private audio ignored, preserve the localhost service and tests, document actual results/limitations, and open a feature-branch PR.

Follow-up tasks: Tiri/background recordings and thresholds; authenticated LAN API; Cloudflare Worker + D1/R2 sync; PWA IndexedDB outbox and update checks; ESP32 OTA; centralized diagnostics.

## Working modes

- **Codex local:** best for installing dependencies, running Windows tests, developing the service and interacting with a connected ESP32 (with explicit approval for flashing).
- **Codex cloud:** useful for repository-only changes and PRs; it cannot be assumed to access the laptop or ESP32.
- **ChatGPT:** architecture, research, PR review and documentation coordination; GitHub connector access alone does not grant a Windows terminal.
- **GitHub Actions:** automated PR validation. Consider self-hosted Windows runner only for hardware-specific tests, with strict workflow/permission isolation.

## Acceptance and security rules

- Check changes on Windows and Linux where appropriate; report unrun hardware tests.
- Never commit credentials, personal audio, or database contents.
- Do not expose port 8765 to the network before authentication.
- Ensure PR CI runs before merge and preserve `main` protection.
- Do not treat GitHub Pages URLs, CI results, YAMNet model execution or hardware tests as verified unless checked.
