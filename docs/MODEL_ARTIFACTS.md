# Model artifacts, training and backup

## What CatMeows changes

Using CatMeows as training data does **not** change the pretrained YAMNet weights by itself. YAMNet stays the frozen feature extractor: each audio patch produces its normal 1,024-value embedding and 521 AudioSet class scores. A separate small classifier can be trained from those embeddings.

CatMeows is a **provisional baseline dataset while Tiri-specific recordings are being collected**, not merely a pipeline smoke test. Its 440 primary clips are meows from 21 cats recorded in three elicitation contexts (brushing, waiting for food, unfamiliar-environment isolation). We can use the pretrained YAMNet Meow score to measure positive-clip coverage and latency, and use the three context labels for an explicitly experimental context-classification baseline. The labels describe recording conditions; they are not validated translations of meow meaning and must not be presented as Tiri's needs.

The current local TFLite artifact returns 521 AudioSet class scores but does **not** expose YAMNet's 1,024-value embeddings. Therefore the already-runnable baseline is the frozen Meow-score detector. A context head can initially use those scores, or we can add a YAMNet artifact that exposes embeddings for the preferred feature-head experiment. Do not describe the score-only baseline as an embedding model.

The first CatMeows batch run scored all 440 primary clips. The maximum-window Meow score met illustrative thresholds 0.1, 0.3 and 0.5 on 345/440 (78.41%), 270/440 (61.36%) and 216/440 (49.09%), respectively. These are positive-only hit rates—not calibrated probabilities, accuracy, or a selected operating threshold. The dataset has no suitable reviewed household negatives for measuring false positives. Reproduce and inspect the run in [CATMEOWS_BASELINE.md](../local-service/CATMEOWS_BASELINE.md). Keep cat-exclusive splits: the current deterministic split puts 14 cats in calibration and 7 held-out cats in evaluation. Then collect Tiri and household background examples and evaluate separately before choosing thresholds or claiming household performance.

## Recommended model stages

1. **Frozen detector baseline:** keep the downloaded YAMNet model immutable; record its upstream revision and file SHA-256. The current local TFLite variant gives 521 class scores and can already be evaluated on CatMeows positive clips.
2. **Establish a detection benchmark:** report positive hit rate and latency by cat-exclusive split. Add reviewed household background/other-sound negatives before measuring precision, specificity, false-positive rate or selecting a threshold. The CatMeows-only score report is not an accuracy benchmark.
3. **Experimental context baseline:** train a separate three-context classifier from CatMeows labels. First record which feature representation it uses: the current 521 YAMNet class scores, or 1,024-dimensional embeddings from a model variant that exposes them. Keep this classifier separate from sound detection and clearly label its output as recording-context prediction.
4. **Feature cache and small head:** if using embeddings, cache them with source clip hash, base-model version, preprocessing version, frame/time range and split. Train a regularized logistic-regression or similarly small classifier. Save the artifact plus label map, thresholds/calibration, training config, seed, code revision and evaluation metrics. A scikit-learn head can be stored as `.joblib`; a Keras head as `.keras` or SavedModel.
5. **Tiri evaluation/personalization:** add Tiri-labeled recordings and household negatives, compare the frozen detector and CatMeows context baseline with any Tiri-trained model, and hold out Tiri sessions for final evaluation. Use explicit **uncertain**/abstain behavior when data are sparse or a score is weak.
6. **Fine-tuning (later, only with evidence):** changing YAMNet itself means training some or all backbone weights and saving a new complete set of weights/checkpoint. With only 440 non-Tiri clips, this is likely to overfit and makes deployment, comparison and rollback harder.

## Checkpoints, LoRA and deployment artifacts

A **training checkpoint** is a resumable snapshot of optimizer/model state during training. Keep it for interrupted experiments, but it is not automatically the production model. Promote a selected checkpoint only after evaluation; export a separate, immutable inference artifact.

**LoRA is not the expected format here.** It is most associated with low-rank adapters for large transformer layers. YAMNet is a compact convolutional audio classifier/embedding model; a small conventional classifier head is simpler to train, inspect, version and run on the Pi. If we later experiment with backbone adaptation, save complete fine-tuned weights or a clearly specified adapter plus the exact base-model hash and loader. Do not make an adapter the only copy of a deployable model.

For each promoted release, keep:

- Frozen base model identity and SHA-256.
- Classifier artifact and SHA-256.
- Label map, score calibration/thresholds, and explicit unknown behavior.
- Audio preprocessing and embedding aggregation versions.
- Training script/config, dependency lock, random seed, data manifest with source/license and file hashes, and train/validation/test split IDs.
- Evaluation report with per-class metrics, confusion matrix, data counts and limitations.
- A release manifest linking all of the above to component version/build SHA.

The analysis response records `model.version`, `preprocessingVersion` and optional `personalClassifierVersion` in [analysis-v1.schema.json](../contracts/analysis-v1.schema.json). That lets us trace old results and roll back the classifier without replacing YAMNet.

## Backup and retention

Keep source code, configs, schemas and small manifests in Git. Keep large audio, embedding caches, checkpoints and model binaries in a versioned artifact store or Git LFS, not regular Git history. Maintain at least two independent copies of every promoted artifact and its manifest; periodically restore a copy and verify hashes. Preserve CatMeows source archives with attribution/license metadata. Back up Tiri recordings only according to the chosen household retention policy, with raw audio kept local by default and encrypted backups if copied off-device.

Never overwrite a promoted artifact in place. Give every experiment and release a unique ID, record its input hashes, and retain the previous known-good release until the new one has passed the same evaluation and runtime checks on Windows and later Raspberry Pi.

## CatMeows license and scope

The dataset record identifies the public release as CC BY 4.0; retain attribution and the record's citation with any derived research artifact. Check the current record and the accompanying research-use terms before redistribution or commercial use. The sample is small and deliberately elicited, so report generalization limits clearly.

Sources:

- [CatMeows dataset record (Zenodo)](https://zenodo.org/records/4008297)
- [CatMeows dataset paper (University of Milan repository)](https://air.unimi.it/handle/2434/911765)
- [TensorFlow YAMNet model README](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet)
- [TensorFlow transfer learning with YAMNet](https://www.tensorflow.org/tutorials/audio/transfer_learning_audio)


## Deferred implementation plan

The post-base-system hosting, data collection, feature extraction, training, evaluation, and rollout sequence is in [YAMNet embedding personal-model implementation plan](YAMNET_EMBEDDING_IMPLEMENTATION_PLAN.md).