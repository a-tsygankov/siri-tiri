# Follow-on plan: Tiri request model using YAMNet embeddings

**Status:** planned, deferred until the base capture/review/sync system is complete. This document describes the next model phase; it does not authorize or implement background training.

## Objective

After the base system can reliably capture, retain, import, and review events, train a small Tiri-specific model that ranks possible request hypotheses from a meow clip and optional household context. Keep the pretrained YAMNet weights frozen. The system should say what a sound is associated with in Tiri's reviewed history, show its evidence, and abstain when support is weak. It must not present a score as a literal translation, a proven need, or a health diagnosis.

## Why embeddings

YAMNet's TensorFlow Hub interface returns sound-class scores, a log-mel spectrogram, and a 1,024-dimensional embedding for each overlapping audio frame. TensorFlow documents one embedding frame every 0.48 seconds. A small downstream classifier can learn from those features without training the full audio network.

The current Siri-Tiri TFLite artifact returns class scores only. Its input and preprocessing are versioned separately from the official TensorFlow Hub model. Do not silently treat the current detector's score output or its 15,600-sample input contract as the embedding interface. Select one pinned embedding artifact, define its exact waveform/window preprocessing, and validate it against known fixtures before collecting training features.

## Base-system completion gate

Start this phase only when the following are true:

- Captures, short audio, and source hashes persist through restart and offline queue/retry.
- The local service can import/replay phone/device recordings with one documented 16-kHz mono preprocessing path or an explicit, versioned conversion.
- A user can review/edit a sound-event label independently from a request hypothesis.
- Tiri's request hypothesis, observed situation, owner action, outcome, reviewer confidence, and **unsure** can be stored as separate, revisioned fields.
- Household audio retention, export, and deletion behavior is documented and works.
- The current YAMNet detector baseline is reproducible. Maintain a separate reviewed negative/uncertain set for detection evaluation.
- Windows is the active training/development host; the local API and artifact version fields are stable enough to add a second model output.

Cloudflare, Sonos, ESP32 OTA, and Raspberry Pi deployment need not block offline feature experiments. They should not be represented as finished prerequisites if they are still pending.

## What to label

Use event/bout-level examples: a burst of nearby meows is one reviewed example unless it contains clearly different calls. Keep these fields distinct:

| Field | Example | Meaning |
|---|---|---|
| Sound-event label | meow / no meow / uncertain | Whether the clip contains an audible meow; this is the detector task. |
| Observed situation | near food bowl; play ended; at door | Owner-observed context, not model output. |
| Request hypothesis | food/water; social attention; play; access; greeting; handling/avoidance; other; unsure | What the owner thinks Tiri may be asking for. Finalize and simplify this vocabulary with real examples. |
| Owner action | fed; approached; played; opened door; no action | What happened in response. |
| Observed outcome | ate; played; went through door; settled; repeated call; no clear result | What Tiri did afterward. |
| Label confidence | low / medium / high, or unsure | How certain the reviewer is; never substitute for the class label. |

These labels are noisy supervision. The outcome helps assess whether a prediction is useful, but does not establish hidden intent. Do not auto-label unreviewed events as negative, and do not train on the model's own guesses as ground truth. Where practical, ask for the review before revealing the model suggestion to reduce anchoring.

Start with one primary request per event plus **other/unsure**. If evidence shows requests often co-occur, compare a multi-label model later. Treat unusual or distress-like vocalization as an alert for human review, not a “meaning” class or diagnosis. Collect passively and during ordinary benign routines; do not provoke distress to create training examples.

## Data-volume targets

There is no published sample count that guarantees useful accuracy for one household, one cat, this microphone placement, and these labels. Treat these as planning ranges to size collection effort, not statistical guarantees:

| Stage | Tiri reviewed meow bouts per frequent request class | What it supports |
|---|---:|---|
| Pipeline exploration | 10–20 | Validate feature extraction, labels, and train/export flow. Results are anecdotal; do not present a dependable classifier. |
| First pilot | 30–50 for training, plus 10–20 later held-out examples | Decide whether common categories appear distinguishable and whether to continue collecting. |
| More useful evaluation | 50–100 for training, plus 20–30 later held-out examples | Estimate per-class performance more meaningfully if examples span multiple days and situations. Still report uncertainty and sample counts. |

For five frequent request classes, those ranges imply roughly 200–350 reviewed bouts for a pilot and 350–650 for the larger evaluation, before adding **other**, **unsure**, and detector negatives. If a category is rare, leave it as **other/unsure** or combine it with a neighboring category rather than claiming a class from a handful of examples. More examples from one repetitive session do not replace examples across different days and situations.

## Model and feature plan

### 1. Pin an embedding extractor

Evaluate these implementation paths on Windows:

1. **Official TensorFlow Hub YAMNet** for training-time extraction. It provides embeddings directly and is the simplest reference implementation.
2. **A custom LiteRT/TFLite export exposing embeddings** for a portable local-service runtime. Keep the current score-only detector unchanged until the new artifact passes parity and resource checks.
3. If direct export is brittle, use the official SavedModel/TF Hub artifact in the Windows/Pi service behind the same feature API. Do not change model families merely to avoid making a second, explicitly versioned runtime.

Use normalized mono 16-kHz audio and pin resampling, clipping/padding, patch duration, hop, and end-of-clip handling. Preserve clip-relative frame timestamps. The TensorFlow page currently lists Windows CPU wheels, including Python 3.13; use a separate, hash-locked training environment and verify the selected TensorFlow Hub/LiteRT versions at implementation time. Keep that environment separate from the current inference lock.

### 2. Build a reproducible feature cache

For each eligible clip, save frame embeddings and a compact manifest containing:

- Event/bout ID, source clip SHA-256, reviewed-label revision, split, and time range.
- Base-model name/version/SHA-256 and class-map hash.
- Audio preprocessing and embedding-aggregation versions.
- Embedding frame count, dimensions, extraction status, and generated artifact hash.

Embeddings are derived data. Keep source audio under the household retention policy, and regenerate features when provenance changes. Store bulk audio/cache outside Git; keep scripts, small manifests, schema, and evaluation summaries in Git. Back up promoted artifacts and metadata independently.

### 3. Train simple baselines first

Train and compare these baselines using the same train/evaluation splits:

- Majority-class predictor.
- Context-only baseline (routine/time/observed situation), to check whether audio adds information.
- Current YAMNet class-score features.
- Nearest reviewed-example retrieval using embedding distance.
- Regularized multinomial logistic regression on clip-level pooled embeddings.

For the initial classifier, pool the frame embeddings into a small event-level representation (start with mean; test mean plus standard deviation only if held-out performance improves). Use L2 regularization and class weighting when needed. Keep model dimensionality and classifier complexity low because Tiri's dataset will initially be small. Do not start with a recurrent/transformer head, YAMNet fine-tuning, or LoRA.

First train an audio-only head; then compare a small context-fusion head that adds owner-observed context and time/routine features. Never feed the human request label or post-event outcome into the prediction as if it were known at prediction time. Train these as distinct model variants so their contribution can be measured.

CatMeows remains a separate external benchmark: it can test three recording-context labels and compare feature extractors, but its labels do not map directly to Tiri's household requests. Do not mix its labels into Tiri's request classes without an explicit, reviewed label mapping and separate results.

## Evaluation and promotion

Split by complete meow bout, then by recording session/day. Keep later Tiri examples untouched for a chronological test; never put overlapping frames from one bout in both training and test. Use grouped cross-validation on the training period if enough sessions exist. Record:

- Per-class precision/recall and macro-F1, with the confusion matrix and class counts.
- Top-2 coverage, model abstention rate, and confidence calibration (Brier/log loss only when there is enough held-out data).
- Performance by context and recording period.
- Comparison against majority-class, context-only, YAMNet-score, and retrieval baselines.
- User correction rate and how often the system abstains.

Choose confidence/abstention thresholds on a validation set, then freeze them before the chronological test. If a category has too few held-out examples or the classifier does not beat simple baselines, retain retrieval and **unsure** rather than promoting it. Avoid a single overall “accuracy” number.

A device/PWA suggestion should include the ranked hypothesis, confidence tier, supporting count, and a few similar reviewed events with their outcomes. Use cautious templated language such as “Often followed by…” or “Possibly asking for…”. The model should return structured scores; any later language model may phrase only those scores and retrieved evidence, not invent a reason from raw audio.

## Hosting and runtime

| Stage | Recommended host | Reason |
|---|---|---|
| Data review and embedding extraction | Windows 11 laptop, CPU first | Fits the current prototyping workflow; extraction/training are batch tasks. Use WSL2/Linux only if a GPU path is needed and Windows CPU throughput proves insufficient. |
| Classifier training and evaluation | Windows 11 laptop | Logistic regression and similar small heads are inexpensive compared with audio-model inference. Training stays offline and local. |
| Live inference after promotion | Windows local service first; benchmark Raspberry Pi later | Keep YAMNet/embedding extraction and the small head behind the existing host-neutral local service boundary. Deploy the same pinned artifact bundle only after checking Pi latency, memory, and runtime compatibility. |
| ESP32 | Capture, queue, review/status UI | Do not train or run YAMNet embeddings on the ESP32. It sends/queues audio and displays local-service results. |
| Cloudflare | Optional sync, metadata, release manifest, encrypted/opt-in artifact backup | Do not use a Worker as the YAMNet runtime for this plan. Keep household audio local by default. |

Native Windows TensorFlow GPU support has different constraints from Windows CPU packages; start CPU-only and pin a compatible dependency set. Train on the laptop even after Pi deployment unless Pi-side training proves useful. The model artifact should be small and portable; keep the feature extractor on the local server.

## Versioned model bundle and rollback

Promote an immutable bundle with:

- Embedding extractor artifact and hash.
- Frozen YAMNet base-model identity/hash.
- Feature preprocessing and pooling versions.
- Classifier weights, class map, calibration/abstention thresholds.
- Training-code revision, dependency lock, seed, dataset-manifest fingerprint, split IDs, and evaluation report.
- Model version and minimum compatible local-service/protocol version.

Keep the last known-good detector and personal classifier available. A model update must be independently deployable from firmware and service updates; if embedding extraction or classifier health checks fail, fall back to the prior model and keep event capture/review working.

## Implementation milestones and exit criteria

1. **Gate:** base capture, durable review revisions, import, retention/deletion, and stable v1 service API meet the prerequisites above.
2. **Embedding parity:** run pinned official YAMNet and the candidate portable extractor over the same fixtures; confirm finite outputs, timestamps, shapes, and score consistency. Record latency/memory on Windows.
3. **Tiri annotation export:** generate a versioned, auditable dataset manifest from reviewed bouts; maintain separate context, request-hypothesis, action, and outcome columns.
4. **Feature cache:** extract/hash embeddings once and regenerate deterministically from unchanged inputs.
5. **Offline baseline comparison:** run majority/context/YAMNet-score/retrieval/logistic-regression baselines with group and chronological evaluation; document per-class uncertainty.
6. **Promotion decision:** promote only if common classes beat simple baselines on the held-out Tiri period and abstention works; otherwise keep this as an assisted review tool and collect more examples.
7. **Local integration:** load the immutable bundle in the Windows service, include model/preprocessing versions in analysis records, and display evidence-backed suggestions in the PWA/device.
8. **Pi portability:** deploy the same feature API/artifact to the Pi and benchmark it alongside Home Assistant. Record CPU, peak memory, startup, per-clip latency, and dropped/queued-event behavior before changing the default host.

## References

- [TensorFlow YAMNet transfer-learning tutorial](https://www.tensorflow.org/tutorials/audio/transfer_learning_audio) — 1,024-dimensional frame embeddings and small downstream classifier.
- [TensorFlow YAMNet model repository](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet) — model outputs and reference implementation.
- [TensorFlow pip installation matrix](https://www.tensorflow.org/install/pip) — check supported Windows/Python combinations when pinning the separate training environment.
- [CatMeows dataset](https://zenodo.org/records/4008297) — external three-context dataset and terms.
- [Automatic Classification of Cat Vocalizations Emitted in Different Contexts](https://www.mdpi.com/2076-2615/9/8/543) — acoustic-feature context-classification precedent.
