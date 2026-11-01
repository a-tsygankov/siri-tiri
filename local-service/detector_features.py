"""Finite, version-bound clip features for offline audible-meow rule evaluation."""
import array
import hashlib
import math
from pathlib import Path

import dataset_evaluate
import dataset_prepare
import inference
import model_assets
from review_artifacts import canonical, save_document, utc_now
from review_store import TARGET, validate_catalog

SCORES = ('meow_max', 'cat_or_meow_max')


def provenance():
    return dict(modelVersion=model_assets.MANIFEST['modelVersion'], modelSha256=model_assets.MANIFEST['sha256'],
                classMapSha256=model_assets.MANIFEST['classMapSha256'],
                resamplingVersion=dataset_prepare.VERSION, inferencePreprocessingVersion=inference.PREPROCESSING_VERSION,
                aggregationVersion='window-maximum-meow-and-max-cat-meow-v1')


def finite_score(value):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1


def feature_fingerprint(row, metadata):
    from review_artifacts import fingerprint
    return fingerprint(dict(clipId=row['clipId'], sourceSha256=row['sourceSha256'],
                            features=row['features'], provenance=metadata))


def validate(document, catalog):
    validate_catalog(catalog)
    try:
        canonical(document)
        if (type(document['schemaVersion']) is not int or document['schemaVersion'] != 1
                or document['artifactType'] != 'detectorFeatures' or document['target'] != TARGET
                or document['inventoryFingerprint'] != catalog['inventoryFingerprint']
                or document['provenance'] != provenance() or type(document['synthetic']) is not bool):
            raise ValueError('feature provenance mismatch')
        known = {row['clipId']: row for row in catalog['clips']}
        rows, seen = document['rows'], set()
        if not isinstance(rows, list) or len(rows) > len(known):
            raise ValueError('invalid feature count')
        for row in rows:
            key = row['clipId']
            if key in seen or key not in known or row['sourceSha256'] != known[key]['sourceSha256']:
                raise ValueError('feature source identity mismatch')
            seen.add(key)
            if row['status'] == 'scored':
                values = row['features']
                if (set(values) != set(SCORES) or not all(finite_score(values[key]) for key in SCORES)
                        or values['cat_or_meow_max'] < values['meow_max']):
                    raise ValueError('invalid finite features')
            elif row['status'] != 'failed' or row.get('features') is not None:
                raise ValueError('invalid feature status')
        return {row['clipId']: row for row in rows}
    except (KeyError, TypeError, AttributeError):
        raise ValueError('invalid detector feature artifact') from None


def score_catalog(catalog, root, predictor=None):
    validate_catalog(catalog)
    synthetic = predictor is not None
    if predictor is None:
        predictor = inference.Yamnet()
        label_hash = hashlib.sha256(('\n'.join(predictor.labels) + '\n').encode()).hexdigest()
        if label_hash != provenance()['classMapSha256']:
            raise ValueError('model class map mismatch')
    root, rows = Path(root), []
    for entry in catalog['clips']:
        row = dict(clipId=entry['clipId'], sourceSha256=entry['sourceSha256'], status='failed', features=None, errorCode=None)
        try:
            path = inference.resolve_audio(root, entry['sourceRef'])
            if dataset_prepare.digest(path) != entry['sourceSha256']:
                raise ValueError('source checksum mismatch')
            samples = dataset_prepare.read_source(path)
            if dataset_prepare.digest(path) != entry['sourceSha256']:
                raise ValueError('source changed during read')
        except (OSError, ValueError):
            row['errorCode'] = 'source_audio_invalid'
        else:
            try:
                output, clipped = dataset_prepare.resample_pcm16(samples)
                waveform = array.array('f', (value / 32768 for value in output))
                result = dataset_evaluate.validate_result(predictor.analyze(waveform))
                maxima = {item['label']: item['maximum'] for item in result['catScores']}
                row.update(status='scored', features=dict(meow_max=maxima['Meow'],
                                                        cat_or_meow_max=max(maxima['Cat'], maxima['Meow'])),
                           clippedSamples=clipped, durationSeconds=len(waveform) / 16000)
            except Exception:
                row['errorCode'] = 'feature_inference_failed'
        rows.append(row)
        if len(rows) % 25 == 0 or len(rows) == len(catalog['clips']):
            print('Review features: %d/%d' % (len(rows), len(catalog['clips'])), flush=True)
    document = dict(schemaVersion=1, artifactType='detectorFeatures', target=TARGET,
                    inventoryFingerprint=catalog['inventoryFingerprint'], provenance=provenance(),
                    synthetic=synthetic, generatedAt=utc_now(), rows=rows,
                    scoredCount=sum(row['status'] == 'scored' for row in rows))
    validate(document, catalog)
    return save_document(root / 'reviews' / 'features', 'features', document)
