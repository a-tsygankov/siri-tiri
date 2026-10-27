# Siri-Tiri Project Plan

## Goal

Build a home-local assistant that helps Andrey understand and respond to Tiri's vocalizations. The system should detect and log likely cat sounds, learn patterns from household context and owner feedback, and support optional replies through owner-recorded audio and Sonos.

This is a personalized pattern-learning tool, not a literal cat-language translator or veterinary diagnostic system. Predictions must be qualified and include an "uncertain" outcome.

## Existing hardware and services

- **Waveshare ESP32-S3 Touch AMOLED 1.75**: ESP32-S3R8, 8 MB PSRAM, dual microphones with ES7210 audio codec, speaker, Wi-Fi, touch display, TF card slot. Use as the room audio endpoint and user interface.
- **Raspberry Pi running Home Assistant**: later always-on inference target, subject to confirming Pi model, Home Assistant installation type, CPU, and RAM. Use the Windows 11 laptop as the first YAMNet development and batch-analysis host.
- **Sonos speakers**: use for optional playback/replies through Home Assistant. Do not plan to use their built-in microphones as audio inputs: Home Assistant exposes microphone state for supported models, not a general audio stream.

## Enclosure findings

- No standalone retail enclosure for the standard ESP32-S3-Touch-AMOLED-1.75 board was found in the reviewed sources. Waveshare's 1.75C product is a separate board variant with a CNC-machined aluminum enclosure, not a separately sold case confirmed compatible with this board.
- A potentially suitable **free 3D-printable case** is listed on [MakerWorld](https://makerworld.com/en/models/2477655). Its listing identifies the Waveshare ESP32-S3-Touch-AMOLED-1.75 and describes a speaker opening plus a 40 × 40 × 10 mm battery space. This is a printable model, not a retail case.
- A [Printables simple case](https://www.printables.com/model/1614880-waveshare_esp32-s3-touch-amoled-175-g-simple-case/related) is listed for the 1.75-G/GPS variant; its listing does not establish a battery compartment.
- The supplied battery is labeled 1100 mAh, 3.7 V (4.07 Wh). The photos do not provide a reliable scale for its physical dimensions, so fit in the MakerWorld 40 × 40 × 10 mm cavity is unconfirmed.
- Board reference information is available in the [Waveshare hardware reference](https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.75/blob/main/HARDWARE_REFERENCE.md). The reviewed reference has electronic connection data but no dimensioned mechanical drawing sufficient to verify a custom enclosure's fit.
- **Enclosure next step:** measure the battery (length, width, thickness) and compare it with the printable model before printing. If it does not fit or the case does not provide the needed port/microphone/speaker access, create a parametric Onshape enclosure. Use the official board reference, the attached board/case photos, and physical measurements of the board, screen rim, connectors, battery, and speaker. Do not finalize fit-critical geometry from perspective photos alone.

## Proposed architecture

1. The ESP32 captures audio locally and detects candidate vocalization windows. It sends short clips or audio frames over the home LAN to a configurable inference service.
2. Run the first YAMNet service on the Windows 11 laptop for recorded-clip experiments, dataset preparation, and live ESP32 trials. Keep the service contract and model interface independent of the host so the same role can move to the Raspberry Pi later.
3. The local service runs YAMNet/TensorFlow Lite to score general audio classes, especially Meow and Cat, and returns scores/embeddings. YAMNet detects sound classes; it does not identify Tiri's needs.
4. A Cloudflare Worker provides the internet-facing API and control plane: device pairing/authentication, configuration, event metadata and feedback sync, health/version endpoints, and optional access to explicitly retained clips. D1 stores structured event/configuration data; R2 is optional for user-approved audio objects.
5. Home Assistant provides household context, notifications, and optional Sonos playback. Keep this integration optional and independent of the YAMNet service.
6. The ESP32 screen shows local detections and sync status. It should remain usable when the laptop/Pi or internet is offline, and queued event metadata should sync later.

Keep inference behind a versioned local HTTP API, separate from the Cloudflare API. Configure the local inference URL independently of the device firmware build (for example, a stable LAN hostname or settings value), so moving the service from Windows to the Pi is a host/configuration change, not a product redesign.

## Phases

### 0. Establish the baseline

- Record Windows 11 laptop CPU/RAM/GPU and Python environment; also record exact Raspberry Pi model, RAM, Home Assistant installation type, and available disk space.
- Confirm ESP32 board audio capture format, microphone channel behavior, and speaker playback.
- Define separate versioned contracts for local inference and Cloudflare device/event APIs; define a config switch for the inference host.
- Set up Cloudflare development variables and CI secrets using the feedme2 pattern; do not commit real secrets.
- Select local audio retention defaults and document delete controls. Keep raw audio on the LAN by default.

**Exit criteria:** Windows laptop can receive a short test clip from the ESP32 through the local inference API; Cloudflare is not required for local capture/classification.

### 1. Detect and inspect sounds

- First run YAMNet on Windows 11 using a pinned CPU TensorFlow/TFLite environment; begin with recorded WAV files and batch resource-data analysis, then process short clips from the ESP32.
- Log timestamps and class scores; show likely Meow/Cat detections on the ESP32 or Home Assistant.
- Include background/no-meow examples and tune thresholds against actual room recordings.
- Measure model startup time, inference latency, CPU, and memory on the laptop. Later deploy the same API/model artifact to the Pi using its compatible Linux ARM64 TFLite runtime and benchmark alongside Home Assistant.

**Exit criteria:** detection works on Tiri's real clips and ordinary household sounds, with measured resource use and a tunable false-positive rate.

### 2. Build Tiri's labeled sound log

- Provide one-tap feedback categories based on observable situations: food, greeting, attention, play, door, brushing/handling, other, and unsure.
- Optionally record what happened next (ate, approached, settled, repeated vocalization, no clear response).
- Save only selected/accepted clips or use a configurable short retention period.
- Keep one cat profile (Tiri); no speaker identity model is needed.

**Exit criteria:** event, clip, label, timestamp, and optional Home Assistant context can be reviewed and corrected.

### 3. Train a personal pattern model

- Use YAMNet embeddings as input features for a small classifier; keep YAMNet frozen initially.
- Use the public CatMeows dataset only for pipeline experiments: 440 clips from 21 cats with brushing, food-waiting, and unfamiliar-isolation contexts. Its record restricts use to scientific research and non-commercial purposes; verify terms before bundling or redistributing it.
- Treat public context labels as a limited research vocabulary, not reliable labels for Tiri.
- Train/evaluate with splits grouped by recording session or cat to avoid leakage; evaluate Tiri's model on held-out Tiri data.
- Compare the personalized classifier with a simple context/rule baseline.
- Return qualified predictions and abstain when confidence or training coverage is low.

**Exit criteria:** model improves over a documented baseline on held-out Tiri data and supports an explicit unknown result.

### 4. Add communication and Home Assistant actions

- Make replies opt-in and user-configurable: notification, on-screen suggestion, or owner-recorded short phrase played through Sonos.
- Add a cooldown during playback so the system does not classify its own reply as Tiri's vocalization; validate echo handling in the room.
- Do not automatically play recorded cat meows or distress sounds.
- Use Home Assistant for relevant context and automations, but avoid interpreting a vocalization as a need solely from one sound.

**Exit criteria:** user can review the reason for a suggestion, dismiss it, and disable all playback.

### 5. Refine and consider on-device inference

- Collect performance and false-positive feedback during ordinary use.
- Consider a smaller Tiri-specific ESP32 classifier only after the Pi pipeline and labels are useful.
- Compare YAMNet and other embeddings (such as AVES) on the same held-out clips before changing the baseline model.
- Keep the Pi as the default inference target unless ESP32 measurements show a clear benefit.

**Exit criteria:** a documented decision based on accuracy, latency, memory, privacy, and maintenance cost.

## Initial technical choices

- **Detection baseline:** YAMNet on a general-purpose host, not the ESP32. Start on Windows 11 CPU for development and move the inference service to the Pi once the pipeline is useful. The standard float model is approximately 14.2 MB and the stock graph has preprocessing/runtime compatibility complications on microcontrollers.
- **Feature learning:** YAMNet audio embeddings plus a small downstream classifier, developed and evaluated on the Windows laptop; deploy runtime inference on the Pi later if desired.
- **Audio input:** Waveshare dual microphones first. Sonos microphones are not assumed available through a supported raw-audio API.
- **Output:** Waveshare speaker for local feedback during development; Sonos via Home Assistant for optional room playback.
- **Inference cadence:** analyze candidate clips/windows rather than run expensive inference continuously where possible.

## Risks and constraints

- A meow's meaning is context-dependent. Public labels and model scores cannot prove hunger, distress, or intent.
- Public cat datasets are small and recorded in limited/artificial contexts; they cannot substitute for Tiri-specific examples.
- The Pi model and HA installation type are unknown. Benchmark laptop and Pi resource use before choosing deployment packaging. Windows TensorFlow CPU packages are available, while native-Windows GPU support has version constraints; keep the first baseline CPU-focused.
- Playback can contaminate microphone input and cause feedback loops; use cooldowns and test echo cancellation.
- Audio contains household privacy information. Prefer local processing, visible listening/mute status, short retention, and user-controlled deletion.
- Enclosure fit is not confirmed until the supplied battery and physical board dimensions are measured; treat public printable models as prototypes until test-fitted.

## Research references

- [CatMeows dataset (Zenodo)](https://zenodo.org/records/4008297)
- [YAMNet model and TensorFlow example](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet)
- [TensorFlow Lite real-time Raspberry Pi audio classification example](https://github.com/tensorflow/examples/tree/master/lite/examples/sound_classification/raspberry_pi)
- [AVES animal-vocalization encoder](https://github.com/earthspecies/aves)
- [Home Assistant Sonos integration](https://www.home-assistant.io/integrations/sonos)
- [Waveshare board hardware reference](https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.75/blob/main/HARDWARE_REFERENCE.md)
- [MakerWorld battery-space case model](https://makerworld.com/en/models/2477655)
- [Printables case for 1.75-G variant](https://www.printables.com/model/1614880-waveshare_esp32-s3-touch-amoled-175-g-simple-case/related)


## Proposed host and cloud deployment

### Responsibilities

| Component | Runs where | Responsibility |
|---|---|---|
| **YAMNet inference service** | Windows 11 laptop first; Raspberry Pi later | Receives short LAN audio clips, runs YAMNet, and returns sound-class scores plus optional embeddings. Keep the HTTP contract stable across hosts. |
| **Cloud API / control plane** | Cloudflare Worker | Device pairing and authentication, configuration, event metadata/label sync, health/version endpoints, and optional controlled clip access. |
| **Structured data** | Cloudflare D1 | Event metadata, labels/outcomes, device records, settings, and sync state. |
| **Audio objects** | Local disk by default; optional Cloudflare R2 | Keep raw audio local unless retention/upload is explicitly enabled. R2 can store user-approved clips; metadata-only cloud sync is the privacy-first default. |
| **Home automation** | Raspberry Pi / Home Assistant | Optional context, notifications, and Sonos playback; do not make this a dependency of audio classification. |

### Laptop-to-Pi portability

- Make the inference service a small standalone application with a versioned local endpoint such as POST /v1/classify and GET /health; do not couple the YAMNet adapter to Home Assistant or Cloudflare Worker code.
- Keep model input/output normalization, label mapping, and response schema in shared documentation/fixtures. Host-specific packaging may differ: Windows can use the TensorFlow Lite interpreter included with TensorFlow; Raspberry Pi can use its compatible TFLite runtime.
- Start CPU-only on Windows. TensorFlow's current install guidance says native Windows GPU support stopped after TensorFlow 2.10; CPU is sufficient for initial clip analysis and avoids tying the design to one GPU/runtime.
- Store the inference base URL in device configuration (or a stable LAN DNS/DHCP name). Moving from Windows to Pi should require changing that endpoint and deploying the same service contract, not reflashing for model behavior changes.
- Keep a bounded local clip/metadata queue so classification and review can continue if Cloudflare is unavailable. Upload/sync should retry independently of local inference.

### Cloudflare implementation pattern

Use feedme2 as the implementation reference for the cloud tier, not as a requirement to use identical product logic:

- TypeScript Worker API with Hono, D1 migrations, Wrangler local development, and environment-specific configuration.
- GitHub Actions for tests, deployment, and required version bumps. Reuse the tier/version approach where it fits (firmware, Worker API, and schema).
- .dev.vars.example plus ignored local .dev.vars; GitHub Actions secrets for deploy credentials; Cloudflare Worker secrets for runtime signing keys and external API credentials.
- Structured logs and a debug/status endpoint should record event IDs, request IDs, versions, latency, and error codes—but never raw audio, passwords, or token values.
- Use per-device credentials that can be revoked/rotated. Never embed a Cloudflare account API token or one shared administrative key in ESP32 firmware. Store only a hash of device tokens server-side if the chosen auth design supports it.
- Keep versioned API contracts and sample payload fixtures shared between firmware, local inference client, simulator, and Worker tests. Add an inference-service version separately from the firmware/UI version.
- Treat Cloudflare as the cloud data/API tier, not the initial YAMNet runtime. Cloudflare Workers AI exposes its own managed model catalog, while YAMNet's documented path uses TensorFlow/TensorFlow Hub. Keep YAMNet on the local Windows/Pi service for this first version. This is an architecture recommendation based on the current runtimes, not a claim that custom model serving on Cloudflare is impossible.

### Development and deployment sequence

1. **Windows prototype:** install the pinned TensorFlow/YAMNet dependencies; run a local API against the public sample set and Tiri recordings; measure inference and resource use.
2. **ESP32 LAN integration:** send candidate clips to the Windows service, receive scores, and display/log the candidate event without Cloudflare.
3. **Cloud API:** add pairing/device auth, event metadata and feedback sync, D1 migrations, runtime secrets, structured logging, and CI/deployment modeled on feedme2.
4. **Pi migration:** deploy the same inference API on the Pi, change the configured base URL, and compare latency/CPU/memory while Home Assistant is active. Keep local inference and cloud sync independently testable.
5. **Optional clips in cloud:** only after retention/deletion behavior is implemented; store reviewed/explicitly retained clips in R2 and keep IDs/metadata in D1.

### Deployment references

- [feedme2 README](https://github.com/a-tsygankov/feedme2/blob/main/README.md) — Hono Worker + D1, local Wrangler workflow, workspace layout, and versioning.
- [feedme2 version check workflow](https://github.com/a-tsygankov/feedme2/blob/main/.github/workflows/version-check.yml) — CI-enforced version bumps.
- [feedme2 Worker configuration](https://github.com/a-tsygankov/feedme2/blob/main/backend/wrangler.toml) — D1/R2 bindings, cron, observability, and runtime variable pattern.
- [TensorFlow on Windows](https://www.tensorflow.org/install/pip#install_tensorflow_with_pip) — current Windows CPU/GPU installation constraints.
- [TensorFlow YAMNet transfer-learning guide](https://www.tensorflow.org/tutorials/audio/transfer_learning_audio) — YAMNet embeddings and downstream classifier workflow.
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
