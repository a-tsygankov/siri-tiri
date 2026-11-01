# Switch Siri-Tiri development to Codex

**Status:** handoff guide. Creating this document does not install Codex or change any local machine permissions.

## Repository and immediate context

Repository: https://github.com/a-tsygankov/siri-tiri

- `main` currently contains documentation and interactive mockups under `docs/`, shared v1 JSON Schemas under `contracts/`, and a minimal Python SQLite localhost service under `local-service/`.
- Mockup entry point: `docs/connected-ui-v5.html`; README links to GitHub Pages, but actual deployment/device rendering must be verified.
- Local service is **not** YAMNet-enabled yet and has no Cloudflare synchronization, authentication, OTA or production PWA.
- The service listens on `127.0.0.1:8765`, persists SQLite in `local-service/data/`, and exposes health/version/events/logs. It is a foundation, not a production server.
- **Mandatory:** all future repository modifications through feature branches and PRs; no direct commits to `main`. See root `AGENTS.md`.

## Setup on Windows 11

1. Install Codex using the official OpenAI Codex documentation or ChatGPT desktop Codex interface; sign in and grant repository-scoped access. Confirm current install instructions on https://developers.openai.com/codex/ .
2. Install Git and Python 3.11+ if missing. Prefer least-privilege local installation. Optional: VS Code or IntelliJ for reviewing diffs.
3. In PowerShell:

```powershell
git clone https://github.com/a-tsygankov/siri-tiri.git
cd siri-tiri
git switch main
git pull --ff-only
py -3 -m unittest discover -s local-service/tests -v
py -3 local-service/service.py
```

4. In a second PowerShell window: `Invoke-RestMethod http://127.0.0.1:8765/health`. Stop with Ctrl+C.
5. Open the repository in Codex. Ask it to read `AGENTS.md` and the architecture/handoff documents before modifying code.
6. Keep permission prompts for privileged installs, hardware flashing, production deployments and destructive database changes.

## Suggested first Codex task

> Read AGENTS.md, docs/ARCHITECTURE_SYNC_UPDATES_LOGGING.md, docs/PROJECT_PLAN.md, contracts/, and local-service/. Create a feature branch from current main. Verify existing Windows tests. Implement the next incremental step: durable SQLite processing jobs with claim/lease/ack and crash recovery, plus tests. Keep the HTTP server localhost-only. Update documentation, open a PR, report actual tests and known limitations. Do not commit to main or merge without review.

Follow-up tasks: YAMNet preprocessing/inference with pinned model checksum and test clips; authenticated LAN API; Cloudflare Worker + D1/R2 sync; PWA IndexedDB outbox and update checks; ESP32 OTA; centralized diagnostics.

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
