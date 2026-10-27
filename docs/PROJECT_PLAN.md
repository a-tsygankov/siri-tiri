# Siri-Tiri Project Plan

## Goal

Build a home-local assistant that helps Andrey understand and respond to Tiri's vocalizations. The system should detect and log likely cat sounds, learn patterns from household context and owner feedback, and support optional replies through owner-recorded audio and Sonos.

This is a personalized pattern-learning tool, not a literal cat-language translator or veterinary diagnostic system. Predictions must be qualified and include an "uncertain" outcome.

## Existing hardware and services

- **Waveshare ESP32-S3 Touch AMOLED 1.75**: ESP32-S3R8, 8 MB PSRAM, dual microphones with ES7210 audio codec, speaker, Wi-Fi, touch display, TF card slot. Use as the room audio endpoint and user interface.
- **Raspberry Pi running Home Assistant**: run the initial audio inference service here, subject to measuring the Pi model and available CPU/RAM.
- **Sonos speakers**: use for optional playback/replies through Home Assistant. Do not plan to use their built-in microphones as audio inputs: Home Assistant exposes microphone state for supported models, not a general audio stream.

## Proposed architecture

1. The ESP32 captures audio locally and detects candidate vocalization windows. It sends short clips or audio frames to a service on the Pi over the home network.
2. The Pi runs YAMNet using TensorFlow Lite to score general audio classes, especially Meow and Cat. YAMNet is an event detector and feature extractor; its classes do not identify Tiri's needs.
3. An inference service stores events and YAMNet embeddings, and later runs a small Tiri-specific classifier trained from reviewed examples.
4. Home Assistant provides context (for example, time, feeder state, or nearby relevant entities), notifications, and optional Sonos playback.
5. The ESP32 display shows recent detections, confidence, and simple feedback controls. Use an explicit mute control and avoid retaining unreviewed audio indefinitely.

Keep the audio service loosely coupled to Home Assistant (for example, a small HTTP API or MQTT events) so inference can be developed and benchmarked independently.

## Phases

### 0. Establish the baseline

- Record exact Raspberry Pi model, RAM, Home Assistant installation type, and available disk space.
- Confirm ESP32 board audio capture format, microphone channel behavior, and speaker playback.
- Select local transport and storage defaults; keep audio processing on the LAN unless explicitly configured otherwise.
- Document audio retention and delete controls.

**Exit criteria:** Pi can receive and save a short test clip from the ESP32; no cloud service is required.

### 1. Detect and inspect sounds

- Deploy YAMNet on the Pi using a compatible TensorFlow Lite runtime.
- Start with recorded WAV files, then process short clips from the ESP32.
- Log timestamps and class scores; show likely Meow/Cat detections on the ESP32 or Home Assistant.
- Include background/no-meow examples and tune thresholds against actual room recordings.
- Measure model startup time, inference latency, CPU, and memory while Home Assistant is running.

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

- **Detection baseline:** YAMNet on the Raspberry Pi, not the ESP32. The standard float model is approximately 14.2 MB and the stock graph has preprocessing/runtime compatibility complications on microcontrollers.
- **Feature learning:** YAMNet audio embeddings plus a small downstream classifier, developed on the Pi or another computer.
- **Audio input:** Waveshare dual microphones first. Sonos microphones are not assumed available through a supported raw-audio API.
- **Output:** Waveshare speaker for local feedback during development; Sonos via Home Assistant for optional room playback.
- **Inference cadence:** analyze candidate clips/windows rather than run expensive inference continuously where possible.

## Risks and constraints

- A meow's meaning is context-dependent. Public labels and model scores cannot prove hunger, distress, or intent.
- Public cat datasets are small and recorded in limited/artificial contexts; they cannot substitute for Tiri-specific examples.
- The Pi's model and HA installation details are unknown. Benchmark resource use before choosing deployment packaging.
- Playback can contaminate microphone input and cause feedback loops; use cooldowns and test echo cancellation.
- Audio contains household privacy information. Prefer local processing, visible listening/mute status, short retention, and user-controlled deletion.

## Research references

- [CatMeows dataset (Zenodo)](https://zenodo.org/records/4008297)
- [YAMNet model and TensorFlow example](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet)
- [TensorFlow Lite real-time Raspberry Pi audio classification example](https://github.com/tensorflow/examples/tree/master/lite/examples/sound_classification/raspberry_pi)
- [AVES animal-vocalization encoder](https://github.com/earthspecies/aves)
- [Home Assistant Sonos integration](https://www.home-assistant.io/integrations/sonos)
