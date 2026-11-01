# Local YAMNet setup and worker

Status: approved by the user on 2026-11-01 and implemented on the feature branch. User requested the official model, checkpoint research, setup/run scripts, and confirmed that the run scripts should include both API and inference worker.

## Approach

Use Google's versioned float32 YAMNet TFLite v1 artifact with its embedded labels and a pinned CPU LiteRT runtime in the repository-local virtual environment. This avoids the full TensorFlow/Keras dependency stack. The alternative is the official SavedModel plus full TensorFlow; retain that option for future embedding/training work, but it is unnecessary for this classification worker. Do not download or execute third-party cat checkpoints automatically; document their access, label and evaluation limitations.

## Setup and operations

- Provide cross-platform Python commands and small Windows PowerShell wrappers for setup, run, tests, status and single-WAV analysis. Resolve paths relative to the checkout, not the caller's current directory.
- Setup creates/reuses the local venv, installs pinned runtime dependencies, downloads the model to an ignored project-local cache, verifies SHA-256 and size, then runs a synthetic model smoke check. No system installs or credentials.
- Keep the API independently runnable without inference packages. Run starts the API and worker together, monitors failures and stops both children on Ctrl+C or child failure. Worker-only and API-only modes remain available. Never kill unrelated processes; fail clearly if the configured API port is already occupied.
- Runtime directories, models, audio, SQLite and logs are ignored by Git. Log only bounded operational metadata and stable error codes, never audio contents or lease tokens. Do not silently change the stopped user's database or start the user's main checkout before scripts are reviewed.

## Input and inference

- Worker capture payload uses `audioRef`, a relative path underneath a configurable local audio directory. Reject absolute paths, traversal, resolved symlink escapes and remote URLs. Existing captures without supported audio references fail with a stable error code through bounded queue retries.
- Initial audio support: uncompressed PCM16 WAV, mono or stereo, exactly 16000 Hz, nonempty and at most 30 seconds. Downmix stereo and scale signed samples to float32; reject unsupported formats/rates explicitly rather than introducing unverified resampling. Version preprocessing separately.
- Use the model's 15600-sample windows, 7680-sample hops, and zero-pad the last partial window. Aggregate mean and maximum scores, retaining Cat/Meow/Purr/Hiss/Caterwaul and the top general classes with model/preprocessing versions and model checksum. Scores describe sound classes, not intent.

## Worker reliability

Load and verify the model before claiming work. Use the existing HTTP claim/heartbeat/ack/fail API at 127.0.0.1; no network exposure. Renew leases during inference. Stop committing results if ownership is lost. Retry the same acknowledgment after a lost response without recomputing; preserve at-least-once recovery if the worker terminates. Shutdown leaves unfinished leases recoverable.

## Verification and delivery

Test download integrity/failure handling, WAV validation/windowing, confined audio paths, worker ownership and HTTP retries, and startup/shutdown behavior. Keep unit tests runnable without ML dependencies; run an additional real-model synthetic smoke and temporary-database end-to-end worker check after setup. Test setup from another directory and repeated setup. Record actual runtime pins and model provenance/checksum, update project status, and open a PR targeting main.

No recording, ESP32 integration, Cloudflare, personalized classifier, public dataset redistribution, GPU/system installs, schema migration or production deployment is included. Raspberry Pi/Linux compatibility is a future verification target; report tests not executed.
