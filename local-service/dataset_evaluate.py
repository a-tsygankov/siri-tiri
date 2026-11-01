"""Positive-only CatMeows batch scoring and latency reporting; no threshold selection."""
import csv
import hashlib
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
import json
import math
from pathlib import Path
import platform
import re
import statistics
import tempfile
import time
import uuid

import dataset_prepare as prepare
import inference
import model_assets


def load_manifest(path):
    path = Path(path)
    if path.stat().st_size > 10000000:
        raise ValueError('manifest too large')
    raw = path.read_bytes()
    data = json.loads(raw)
    json.dumps(data, allow_nan=False)  # Reject nonfinite values even in optional metadata.
    if (not isinstance(data, dict) or type(data.get('schemaVersion')) is not int or data['schemaVersion'] != 1
            or data.get('preparationVersion') != prepare.VERSION or data.get('splitVersion') != prepare.SPLIT_VERSION
            or data.get('dataset') != 'CatMeows' or data.get('datasetVersion') != '1.0.2'
            or data.get('datasetSource') != prepare.catmeows.SOURCE
            or data.get('dependencies') != dict(scipy='1.15.3', numpy='2.2.6')):
        raise ValueError('unsupported preparation manifest')
    rows = data.get('clips')
    if (not isinstance(rows, list) or not 1 <= len(rows) <= 10000
            or type(data.get('sampleCount')) is not int or data['sampleCount'] != len(rows)):
        raise ValueError('manifest clip count invalid')
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('clipId'), str):
            raise ValueError('invalid clip metadata')
        metadata = prepare.parse_metadata(row['clipId'] + '.wav')
        if any(row.get(key) != value for key, value in metadata.items()):
            raise ValueError('clip metadata does not match source filename')
        if row['clipId'] in seen:
            raise ValueError('duplicate clip ID')
        seen.add(row['clipId'])
        if (row.get('split') != prepare.split_for_cat(row['catId'])
                or row.get('audioRef') != 'audio/' + row['clipId'] + '.wav'
                or row.get('sourceRef') != 'raw/dataset/' + row['clipId'] + '.wav'):
            raise ValueError('invalid clip path or split')
        if any(not isinstance(row.get(key), str) or not re.fullmatch('[0-9a-f]{64}', row[key])
               for key in ('sourceSha256', 'derivedSha256')):
            raise ValueError('invalid clip checksum')
        if (row.get('sourceSampleRate') != 8000 or row.get('sampleRate') != 16000
                or type(row.get('sourceSamples')) is not int or not 1 <= row['sourceSamples'] <= 240000
                or type(row.get('samples')) is not int or row['samples'] != 2 * row['sourceSamples']
                or type(row.get('durationSeconds')) not in (int, float) or row['durationSeconds'] != row['samples'] / 16000
                or type(row.get('clippedSamples')) is not int or not 0 <= row['clippedSamples'] <= row['samples']):
            raise ValueError('invalid clip sample metadata')
    return data, hashlib.sha256(raw).hexdigest()


def validate_result(result):
    try:
        if (result['modelVersion'] != model_assets.MANIFEST['modelVersion']
                or result['modelSha256'] != model_assets.MANIFEST['sha256']
                or result['preprocessingVersion'] != inference.PREPROCESSING_VERSION):
            raise ValueError()
        scores = result['catScores']
        if len(scores) != 5 or {item['label'] for item in scores} != set(inference.CAT_LABELS):
            raise ValueError()
        if not 1 <= len(result['topClasses']) <= 5:
            raise ValueError()
        for item in scores + result['topClasses']:
            if not isinstance(item['label'], str) or not 1 <= len(item['label']) <= 128:
                raise ValueError()
            for key in ('mean', 'maximum'):
                if type(item[key]) not in (int, float) or not math.isfinite(item[key]) or not 0 <= item[key] <= 1:
                    raise ValueError()
        json.dumps(result, allow_nan=False)
        return result
    except (KeyError, TypeError, ValueError, AttributeError):
        raise ValueError('inference_result_invalid') from None


def meow_max(row):
    return next(item['maximum'] for item in row['result']['catScores'] if item['label'] == 'Meow')


def latency_summary(values):
    if not values:
        return None
    ordered = sorted(values)
    return dict(minimum=ordered[0], maximum=ordered[-1], mean=statistics.fmean(ordered),
                p50=ordered[math.ceil(.5 * len(ordered)) - 1], p95=ordered[math.ceil(.95 * len(ordered)) - 1])


def group_summary(rows):
    scored = [row for row in rows if row['status'] == 'scored']
    return dict(clips=len(rows), scored=len(scored), failed=len(rows) - len(scored),
                cats=len({row['catId'] for row in rows}), sessions=len({row['sessionId'] for row in rows}),
                meanMeowMaximum=statistics.fmean(map(meow_max, scored)) if scored else None)


def installed(package):
    try:
        return version(package)
    except PackageNotFoundError:
        return None


def write_report(report, root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    name = datetime.now(timezone.utc).strftime('run-%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:10]
    with tempfile.TemporaryDirectory(prefix='report-', dir=root) as temporary:
        stage = Path(temporary) / 'output'
        stage.mkdir()
        (stage / 'report.json').write_text(json.dumps(report, indent=2, allow_nan=False) + '\n', encoding='utf-8')
        fields = ['clipId', 'datasetContext', 'catId', 'ownerId', 'sessionId', 'split', 'status', 'errorCode',
                  'durationSeconds', 'sourceSha256', 'derivedSha256', 'sourceSampleRate', 'sampleRate', 'samples',
                  'clippedSamples', 'modelVersion', 'modelSha256', 'sourcePreparationVersion',
                  'inferencePreprocessingVersion', 'inferenceMs', 'totalMs', 'topClass']
        fields += [label + '_' + key for label in inference.CAT_LABELS for key in ('mean', 'maximum')]
        with (stage / 'clips.csv').open('w', newline='', encoding='utf-8') as output:
            writer = csv.DictWriter(output, fieldnames=fields)
            writer.writeheader()
            for row in report['clips']:
                values = {key: row.get(key) for key in fields}
                for key in ('modelVersion', 'modelSha256', 'sourcePreparationVersion', 'inferencePreprocessingVersion'):
                    values[key] = report[key]
                if row['status'] == 'scored':
                    values.update(inferenceMs=row['latencyMs']['inference'], totalMs=row['latencyMs']['total'],
                                  topClass=row['result']['topClasses'][0]['label'])
                    for item in row['result']['catScores']:
                        for key in ('mean', 'maximum'):
                            values[item['label'] + '_' + key] = item[key]
                writer.writerow(values)
        stage.rename(root / name)
    return root / name / 'report.json'


def evaluate(manifest_path, report_root, predictor=None, limit=None):
    manifest_path = Path(manifest_path)
    manifest, manifest_hash = load_manifest(manifest_path)  # Snapshot structural/path validation before loading a model.
    if limit is not None and (type(limit) is not int or limit < 1):
        raise ValueError('limit must be a positive integer')
    selected = manifest['clips'][:limit] if limit is not None else manifest['clips']
    provided = predictor is not None
    started = time.perf_counter()
    if predictor is None:
        predictor = inference.Yamnet()
    model_load_ms = (time.perf_counter() - started) * 1000
    rows = []
    invocation_count = 0
    for index, entry in enumerate(selected):
        row = dict(entry, status='failed', errorCode=None)
        started = time.perf_counter()
        try:
            path = inference.resolve_audio(manifest_path.parent, entry['audioRef'])
            if prepare.digest(path) != entry['derivedSha256']:
                row['errorCode'] = 'derived_checksum_mismatch'
            else:
                samples = inference.load_wav(path)
                if prepare.digest(path) != entry['derivedSha256']:
                    raise ValueError('derived_checksum_mismatch')
                if len(samples) != entry['samples']:
                    raise ValueError('derived_sample_count_mismatch')
                ready = time.perf_counter()
                invocation_count += 1
                row['inferenceSequence'] = invocation_count
                try:
                    prediction = predictor.analyze(samples)
                finally:
                    ended = time.perf_counter()
                    row['latencyMs'] = dict(readAndVerify=(ready - started) * 1000,
                                           inference=(ended - ready) * 1000, total=(ended - started) * 1000)
                row.update(status='scored', result=validate_result(prediction))
        except inference.AudioError:
            row['errorCode'] = 'derived_audio_unreadable'
        except OSError:
            row['errorCode'] = 'derived_audio_unreadable'
        except ValueError as error:
            row['errorCode'] = str(error) if str(error) in ('derived_checksum_mismatch', 'derived_sample_count_mismatch', 'inference_result_invalid') else 'inference_failed'
        except Exception:
            row['errorCode'] = 'inference_failed'
        rows.append(row)
        if (index + 1) % 25 == 0 or index + 1 == len(selected):
            print(json.dumps(dict(eventName='batch.progress', processed=index + 1, total=len(selected))), flush=True)
    scored = [row for row in rows if row['status'] == 'scored']
    first_inference = next((dict(clipId=row['clipId'], status=row['status'], **row['latencyMs'])
                            for row in rows if row.get('inferenceSequence') == 1), None)
    thresholds = {}
    for threshold in (.1, .3, .5):
        detected = sum(meow_max(row) >= threshold for row in scored)
        thresholds[str(threshold)] = dict(detected=detected, scoredPositiveClips=len(scored),
                                          positiveDetectionRateOnScored=detected / len(scored) if scored else None)
    report = dict(schemaVersion=1, generatedAt=datetime.now(timezone.utc).isoformat(),
                  dataset='CatMeows', datasetVersion='1.0.2', datasetSource=manifest['datasetSource'],
                  manifestSha256=manifest_hash, sourcePreparationVersion=prepare.VERSION,
                  inferencePreprocessingVersion=inference.PREPROCESSING_VERSION,
                  modelVersion=model_assets.MANIFEST['modelVersion'], modelSha256=model_assets.MANIFEST['sha256'],
                  splitVersion=prepare.SPLIT_VERSION, manifestCount=len(manifest['clips']), selectedCount=len(rows),
                  subset=len(rows) != len(manifest['clips']), scoredCount=len(scored), failedCount=len(rows) - len(scored),
                  complete=len(scored) == len(rows), negativeClipCount=0,
                  diagnosticThresholds=thresholds, selectedThreshold=None, precision=None, falsePositiveRate=None,
                  modelLoadMs=model_load_ms, providedPredictor=provided,
                  latencyMs=dict(method='nearest-rank percentiles; read/hash time excluded from inference',
                                 all=latency_summary([row['latencyMs']['inference'] for row in scored]),
                                 afterFirst=latency_summary([row['latencyMs']['inference'] for row in scored if row['inferenceSequence'] > 1]),
                                 firstInference=first_inference),
                  splits={name: group_summary([row for row in rows if row['split'] == name]) for name in ('calibration', 'evaluation')},
                  recordingConditions={name: group_summary([row for row in rows if row['datasetContext'] == name]) for name in prepare.CONTEXTS.values()},
                  metadataNotesCount=sum(bool(row.get('metadataNotes')) for row in rows),
                  runtime=dict(system=platform.system(), architecture=platform.machine(), python=platform.python_version(),
                               numpy=installed('numpy'), scipy=installed('scipy'), litert=installed('ai-edge-litert'), cpuThreads=2),
                  limitations=['Positive-only primary meows; no precision, specificity or household false-positive estimate.',
                               'No threshold selected; cat-exclusive split is metadata grouping, not model training.',
                               'Owner/environment overlap across cats is not controlled; Tiri accuracy is untested.',
                               'Upsampling does not restore frequencies above the original 4-kHz Nyquist limit.',
                               'Latency is one sequential CPU pass; memory/native allocation and hardware benchmarks not measured.'],
                  clips=rows)
    return write_report(report, report_root)
