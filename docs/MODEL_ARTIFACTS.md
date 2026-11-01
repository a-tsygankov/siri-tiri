# Model artifacts, training and backup

## What CatMeows changes

Using CatMeows as training data does **not** change the pretrained YAMNet weights by itself. YAMNet stays the frozen feature extractor: each audio patch produces its normal 1,024-value embedding and 521 AudioSet class scores. A separate small classifier can be trained from those embeddings.

That downstream classifier is the first recommended experiment. CatMeows contains 440 meows from 21 cats in three elicitation contexts (brushing, waiting for food, unfamiliar-environment isolation). Those labels describe the recording setup; they are not validated translations of meow meaning and should not be treated as Tiri labels. Use it to validate ingestion, embedding extraction and an experimental context classifier. Evaluate by held-out cat/session to avoid leakage, then collect and label Tiri's own examples for any personal model.

## Recommended model stages

1. **Baseline:** keep the downloaded YAMNet model immutable and record its upstream revision/file SHA-256.
2. **Feature cache:** optionally store embeddings with source clip hash, YAMNet version, preprocessing version, frame/time range and dataset split. These are derived data, regenerable from original clips.
3. **Small head:** train a regularized logistic-regression or similarly small classifier over pooled YAMNet embeddings. Save a compact artifact plus label map, thresholds/calibration, training config, seed, code revision and evaluation metrics. A scikit-learn head can be stored as `.joblib`; a Keras head as `.keras` or SavedModel. Choose the format after the local service implementation settles.
4. **Personalization:** add Tiri-labeled examples and compare against a no-personal-model baseline. Use explicit **uncertain**/abstain behavior when data are sparse or a score is weak.
5. **Fine-tuning (later, only with evidence):** changing YAMNet itself means training some or all backbone weights and saving a new complete set of weights/checkpoint. With only 440 non-Tiri clips, this is likely to overfit and makes deployment, comparison and rollback harder.

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
