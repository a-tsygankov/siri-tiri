"""Explicit analysis of offline phone archives, separate from owner observations."""
import array
import io
import json
from pathlib import Path
import wave

import bundle_validation as validation
import inference
import model_assets
import phone_audio
import phone_bundle
from review_artifacts import save_document, utc_now


def analyze_phone(path, predictor=None):
    data = phone_bundle.read_bounded(path, phone_audio.MAX_BYTES)
    # Preserve the established 16-kHz stereo averaging path exactly.
    try:
        with wave.open(io.BytesIO(data), 'rb') as wav:
            stereo = wav.getframerate() == 16000 and wav.getnchannels() == 2
    except (wave.Error, EOFError):
        stereo = False
    if stereo:
        samples = inference.load_wav(path)
        provenance = dict(sourceSha256=phone_audio.sha256(data), sourceSampleRate=16000,
                          sourceChannels=2, preparationVersion=inference.PREPROCESSING_VERSION)
        validation.require(phone_bundle.read_bounded(path, phone_audio.MAX_BYTES) == data, 'audio_changed_during_read')
    else:
        converted, provenance = phone_audio.prepare(data)
        _, pcm = phone_audio.read_pcm(converted)
        samples = array.array('f', (x / 32768 for x in pcm))
    model = predictor if predictor is not None else inference.Yamnet()
    result = model.analyze(samples)
    validation.canonical(result)
    return dict(result, sourceAudio=provenance, synthetic=predictor is not None)


def analyze_import(manifest_path, predictor=None):
    manifest_path = Path(manifest_path)
    manifest = phone_bundle.verify_archive(manifest_path)
    manifest_hash = phone_audio.sha256(manifest_path.read_bytes())
    clips = {row['clipId']: row for row in manifest['clips'] if row['status'] == 'ready'}
    events, model = [], predictor
    for event in manifest['events']:
        row = dict(event)
        if event['status'] == 'ready':
            clip = clips[event['clipId']]
            data = phone_bundle.read_bounded(phone_bundle.confined(manifest_path.parent, clip['derivedRef']), phone_audio.MAX_BYTES)
            validation.require(phone_audio.sha256(data) == clip['preprocessing']['derivedSha256'], 'archive_audio_modified')
            _, pcm = phone_audio.read_pcm(data)
            try:
                if model is None:
                    model = inference.Yamnet()
                scores = model.analyze(array.array('f', (x / 32768 for x in pcm)))
                validation.canonical(scores)
                row.update(status='analyzed', scores=scores, sourceAudio=clip['preprocessing'])
                if 'trimVerification' in clip:
                    row['trimVerification'] = clip['trimVerification']
            except Exception:
                # Exception text may include private paths; persist only a bounded code.
                row.update(status='failed', errorCode='inference_failed')
        events.append(row)
    failed = sum(e['status'] == 'failed' for e in events)
    analyzed = sum(e['status'] == 'analyzed' for e in events)
    excluded = sum(e['status'] not in ('analyzed', 'deleted', 'failed') for e in events)
    status = 'failed' if failed else 'insufficient_data' if excluded or not analyzed else 'complete'
    report = dict(schemaVersion=1, createdAt=utc_now(), analysisVersion='phone-archive-analysis-v1',
                  status=status, synthetic=predictor is not None, manifestSha256=manifest_hash,
                  bundleSha256=manifest['bundleSha256'], modelVersion=model_assets.MANIFEST['modelVersion'],
                  modelSha256=model_assets.MANIFEST['sha256'], classMapSha256=model_assets.MANIFEST['classMapSha256'],
                  preprocessingVersion=inference.PREPROCESSING_VERSION, preparationVersion=phone_audio.VERSION,
                  totalCount=len(events), analyzedCount=analyzed, failedCount=failed, excludedCount=excluded,
                  deletedCount=sum(e['status'] == 'deleted' for e in events), events=events)
    # Recheck archive evidence after scoring before publishing a result.
    validation.require(phone_audio.sha256(manifest_path.read_bytes()) == manifest_hash, 'archive_manifest_changed')
    phone_bundle.verify_archive(manifest_path)
    return save_document(manifest_path.parent.parent / 'reports', 'phone-analysis', report)
