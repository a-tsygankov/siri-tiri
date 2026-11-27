# Import and analyze phone exports

Export **all** from the phone app, then put the JSON (or `.json.txt`) and every WAV from every share part into a local folder. The importer reads existing files; it does not fetch from the cloud or contact the running API.

```powershell
# Once per checkout: pinned Windows x64 Python 3.13 inference environment/model
py -3.13 local-service/manage.py setup

# Paths may be absolute; collect all export parts before running this.
py -3 local-service/manage.py import-bundle C:\Recordings\bundle.json --audio-dir C:\Recordings
# Or: .\scripts\import-phone-bundle.ps1 -Bundle C:\Recordings\bundle.json -AudioDir C:\Recordings

# Use the manifest path printed by import-bundle:
py -3 local-service/manage.py analyze-import local-service\imports\<bundle-sha256>\manifest.json

# Analyze one original native-rate phone WAV directly:
py -3 local-service/manage.py analyze C:\Recordings\clip.wav
```

`--archive-root PATH` changes the import destination. The default is checkout-relative `local-service/imports/`, ignored by Git. Use a short local destination if Windows reports `archive_path_too_long`. Complete snapshots use the full original bundle SHA-256 as directory name; incomplete attempts use a 16-character hash prefix and random UUID, retaining the full hash in their manifest. Reports are new files in the archive root's `reports/` directory, outside snapshots.

## Results and retries

| Command | Exit 0 | Exit 2 | Exit 1 |
| --- | --- | --- | --- |
| `import-bundle` | Complete metadata/archive | Missing declared WAVs or unresolved/conflicting history; evidence saved in an incomplete attempt | Invalid metadata/audio, unsafe paths, modified archive or runtime failure; no new snapshot |
| `analyze-import` | All eligible events analyzed, at least one result | Missing audio, unresolved/conflicting events or no eligible recordings | Inference/runtime failure or archive integrity error |

After a partial share, keep the original folder and collect missing files, then rerun the same command. Available verified WAVs and the exact JSON survive in the incomplete attempt too. A complete retry creates a separate snapshot. An exact complete reimport verifies archived contents and returns the existing manifest; it does not overwrite evidence. If archived files were edited, preserve them and investigate rather than replacing them silently.

An **Export new** bundle can legitimately contain records only: reviews, tombstones or captures whose WAV left in an earlier export. Its metadata can be completely archived while analysis reports missing audio. This first importer does not merge snapshots or silently borrow another export's files. Use Export all for a self-contained analysis input. A declared but missing historical WAV makes the import incomplete even if the current clip can be analyzed.

Each snapshot has byte-exact `bundle.json`, hash-addressed `originals/`, 16-kHz `derived/` files and `manifest.json`. The manifest records received filenames, per-clip hashes, rates, sample counts, preprocessing versions, clipping and event coverage. Receipts distinguish missing filenames even when two clips have identical WAV bytes. Integrity checks detect inconsistency; they do not authenticate who created the original export or make the local archive tamper-proof.

## History, trims and deletion

Capture messages, owner-review revisions and tombstones remain in the original JSON. Duplicate message IDs with changed content are rejected. Missing predecessors and forks are preserved with explicit coverage; they cannot select an analysis input. No label, history revision or model score is invented.

Only WAVs listed by the export manifest are required. Older superseded trim recordings may be absent. Current trims keep their original source identifiers/hash/cut range. If the original WAV is supplied, its sample-aligned slice must match the trim; otherwise reports state `original_audio_not_supplied`. That limitation permits analysis of the verified trim without claiming its source cut was checked. Restores resolve to original audio. Tombstoned events are excluded from analysis.

Import is archival: tombstones do **not** erase previously imported audio. This tool does not implement secure deletion, retention, live-service migration or cloud deletion propagation. Keep personal exports, archives and analysis reports out of Git and public hosting. Owner-observed context stays separate from sound-class scores; no need or intent is inferred.

## Audio and verification limits

Phone input must be uncompressed mono PCM16 WAV at 16,000, 44,100 or 48,000 Hz, nonempty and at most 30 seconds. Files are bounded to 3 MiB, the original JSON to 16 MiB, generated manifests to 64 MiB, each metadata array to 10,000 entries and supplied audio to 600 MiB. The source WAV header, length, duration and SHA-256 must agree with the export. Unsupported formats/rates require an explicit future conversion policy.

`phone-pcm16-to16k-polyphase-kaiser5-v1` uses the existing pinned NumPy 2.2.6/SciPy 1.15.3, rational polyphase conversion (160/441 or 1/3), Kaiser 5 window, zero padding and nearest-even PCM16 quantization. At 16 kHz the samples are unchanged. Existing 16-kHz stereo direct analysis retains its averaging behavior. CatMeows conversion and live worker input requirements are unchanged.

Reports bind original/derived hashes, the archive manifest hash, model/class-map hashes and both conversion and inference preprocessing versions. `synthetic: true` identifies an injected test predictor; `false` means the real model ran, **not** that the input is a real cat recording. Synthetic tones generated through the shipping PWA export/trim functions were imported and scored with real YAMNet. This checks interoperability, not detection accuracy. Real phone export/share behavior, Tiri recordings and Linux/Pi remain unverified.
