# YAMNet and cat/meow checkpoint review

Checked 2026-11-01. Download and runtime checks were performed on Windows x64 Python 3.13.1. No claims about Tiri's needs or emotions follow from these models.

## Selected baseline

Google's [MediaPipe Audio Classifier documentation](https://developers.google.com/edge/mediapipe/solutions/audio/audio_classifier) recommends YAMNet and links its model and [521 labels](https://storage.googleapis.com/mediapipe-tasks/audio_classifier/yamnet_label_list.txt). We use the versioned artifact, not the mutable latest alias:

- Model: `yamnet-tflite-float32-1`.
- URL: `https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite`.
- Downloaded size: **4126810 bytes**.
- SHA-256: `4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf`.
- Embedded label file: `yamnet_label_list.txt`; Cat index 76, Purr 77, Meow 78, Hiss 79, Caterwaul 80 (zero-based).
- Verified runtime interface: float32 input `[15600]`, float32 output `[1,521]`. Classification output only; this variant does not expose embeddings.
- Detector feature/rule provenance also binds normalized class-map SHA-256 `8e1267a120c1932b7273c0d0e0c5529edbb9a35512b437b1c8982baa59047051` (UTF-8 label names joined with LF plus a final LF), pinned in model-manifest.json.

The checksum was calculated from the initial HTTPS download and pinned in the repository; it is not a publisher signature or independently published checksum. Setup fails closed on future size/hash mismatches and atomically installs only verified bytes. We do not redistribute model binaries or datasets in Git. Keep the upstream model card/terms with any future redistribution; Google's source code is available in the [official YAMNet repository](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet).

[LiteRT](https://developers.google.com/edge/litert/overview) provides CPU execution without installing full TensorFlow. We pin `ai-edge-litert==2.3.0`, `numpy==2.2.6`, and all resolved dependencies with wheel hashes in `requirements-inference-win-py313.lock`. The backward-compatible Interpreter API was verified with this artifact on Windows. The newer CompiledModel API is a future runtime option, not required by this worker.

## Available alternatives

| Checkpoint | What is actually available | Assessment for Siri-Tiri |
| --- | --- | --- |
| Official YAMNet v1 | Downloadable pretrained model; Cat/Meow and other feline sound classes already included | Selected baseline; validate false positives on household audio before tuning thresholds |
| [dima806/cat_dog_sounds_classification](https://huggingface.co/dima806/cat_dog_sounds_classification) | Public Wav2Vec2 checkpoint with `model.safetensors`; config labels are only `cat` and `dog`; card declares Apache-2.0 | Candidate for comparison, not a meow-versus-background detector or personalized context model. Sparse model card does not establish household/Tiri accuracy; not downloaded or executed |
| [IsolaHGVIS/Cat-Meow-Classification](https://huggingface.co/IsolaHGVIS/Cat-Meow-Classification) | Gated `best_model_fold_2.h5`; card lists brushing, waiting for food and unfamiliar-environment isolation, using mel-spectrogram inputs; card declares MIT | Context labels describe limited recording situations. Access requires agreeing to share account information; no access terms accepted, no checkpoint downloaded. Dataset terms/evaluation need separate review |

These are concrete candidate checkpoints, not an exhaustive registry survey or proof that a cat-specific model outperforms YAMNet. We did not find sufficient evidence in these cards to replace the baseline. Generic cat/dog discrimination and narrow context classification answer different questions from detecting a likely meow among household sounds.

## What was verified and what remains

Verified: downloaded bytes/hash, label count and feline labels, real CPU inference on synthetic silence and 440 Hz tone, and capture-to-durable-result processing through the local worker. This verifies the pipeline, not accuracy on real cat recordings.

Next: opt-in Tiri/background WAV fixtures, preprocessing agreement, session-separated evaluation, false-positive measurements, latency/memory benchmarks and calibrated thresholds. Do not infer emotion/intent from model class scores or the training labels of a third-party context classifier. Do not bundle public cat datasets before checking their licenses and attribution requirements.
