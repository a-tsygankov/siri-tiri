# CatMeows setup implementation plan

> **For agentic workers:** Use superpowers:executing-plans. User explicitly requested the download, ignored folder and setup/README/handoff instructions; no new product design is needed.

**Goal:** Download authors' CatMeows archives locally and make provisioning reproducible.
**Architecture:** Reuse the existing verified HTTPS download helper with pinned archive hashes; stage safe ZIP extraction atomically. Keep dataset optional and entirely ignored.
**Tech Stack:** Python stdlib and PowerShell.
**Spec:** User request: download CatMeows to repo folder, ignore CatMeows, and add link/instructions to setup, README and handoff.

## Constraints and review focus

Only local non-commercial research use; acknowledge creators and cite record. Never commit archives or audio. Do not claim context labels are intent or extras are ground-truth negatives. Extraction must reject path escapes, links and duplicate members, preserve modified local files and avoid partial output.

- [x] Verify Zenodo v1.0.2 record and published checksums; download archives and calculate SHA-256 pins.
- [x] Add /CatMeows/ to .gitignore and write failing extraction/repeatability/path tests.
- [x] Implement local-service/catmeows.py, manage.py catmeows/setup --catmeows, PowerShell wrappers.
- [x] Extract and inventory the actual dataset; provision the normal checkout without changing main source or the existing database.
- [ ] Update root/local READMEs, handoff and project status; run suite/static checks, independent review, commit, PR and CI.

## Execution record

Downloaded both archives from the version-specific Zenodo record. Published MD5 and locally pinned SHA-256 verified. Extracted 440 primary and 43 supplementary WAVs; all inventoried as mono PCM16 at 8000 Hz. Originals unchanged, no resampling or accuracy evaluation performed. The current worker requires 16000 Hz; docs/handoff explicitly identify that next step.

Provisioned ignored CatMeows folders in the feature worktree and C:/Workspaces/siri-tiri. No primary-checkout source/database changes. Repeated dataset-only and optional full setup commands passed from another CWD. `py -3 -m unittest discover -s local-service/tests -v`: 41 passed on Windows Python 3.13.1. Syntax/provenance parsing, diff and Git ignore checks passed. Independent review found no actionable issues. Linux/hardware not run; CI result belongs in the PR.

Ruling: preserve both authors' archives and original relative file paths, including supplementary recordings; they are not automatically labeled household negatives. Dataset setup is opt-in so regular setup/CI remain dataset-free. Reuse the existing atomic verified download helper instead of a second network implementation.
