"""Immutable offline phone archives. Never reads or writes the live service DB."""
import json
import math
import os
from pathlib import Path
import tempfile
import uuid

import bundle_validation as validation
from bundle_validation import require
import phone_audio as audio

VERSION = 'phone-export-archive-v1'
MAX_TOTAL = 600 * 1024 * 1024
MAX_MANIFEST = 64 * 1024 * 1024


def read_bounded(path, limit):
    with Path(path).open('rb') as stream:
        data = stream.read(limit + 1)
    require(len(data) <= limit, 'archive_input_too_large')
    return data


def confined(base, relative):
    base = Path(base).resolve()
    path = base / relative
    require(not path.is_symlink() and path.resolve().is_relative_to(base), 'archive_path_escape')
    return path


def manifest_for(raw, fetch, save=None):
    """Derive all archive metadata from original evidence, not from stored claims."""
    doc = validation.read_json(raw)
    captures, events = validation.validate_bundle(doc)
    rows, total = [], 0
    for entry in doc['clips']:
        data = fetch(entry)
        row = dict(entry)
        if data is None:
            row['status'] = 'missing_audio'
        else:
            total += len(data)
            require(total <= MAX_TOTAL, 'bundle_audio_total_exceeded')
            require(len(data) == entry['sizeBytes'] and audio.sha256(data) == entry['sha256'], 'bundle_audio_hash_or_size_mismatch')
            rate, pcm = audio.read_pcm(data)
            require(rate == entry['sampleRate'] and abs(len(pcm) * 1000 / rate - entry['durationMs']) <= 1,
                    'bundle_audio_metadata_mismatch')
            derived, provenance = audio.prepare(data)
            source_ref = 'originals/' + entry['sha256'] + '.wav'
            derived_ref = 'derived/' + provenance['derivedSha256'] + '.wav'
            row.update(status='ready', sourceRef=source_ref, derivedRef=derived_ref, preprocessing=provenance)
            if save:
                save(source_ref, data)
                save(derived_ref, derived)
        rows.append(row)
    available = {r['clipId']: r for r in rows if r['status'] == 'ready'}
    trims = {e['payload']['clipId']: e['payload']['trim'] for e in captures.values() if 'trim' in e['payload']}
    for row in rows:
        if row['status'] != 'ready' or row['clipId'] not in trims:
            continue
        t = trims[row['clipId']]
        original = available.get(t['sourceClipId'])
        row['trimVerification'] = 'original_audio_not_supplied'
        if original:
            _, source = audio.read_pcm(fetch(original))
            _, cut = audio.read_pcm(fetch(row))
            start = math.floor(t['startMs'] * row['sampleRate'] / 1000 + .5)
            end = min(len(source), math.floor(t['endMs'] * row['sampleRate'] / 1000 + .5))
            require(source[start:end] == cut, 'bundle_trim_pcm_mismatch')
            row['trimVerification'] = 'verified'
    for event in events:
        if event['status'] == 'pending':
            event['status'] = 'ready' if event['clipId'] in available else 'missing_audio'
    incomplete = any(r['status'] == 'missing_audio' for r in rows) or any(e['issues'] for e in events)
    return dict(schemaVersion=1, archiveVersion=VERSION, bundleSha256=audio.sha256(raw),
                preparationVersion=audio.VERSION, status='incomplete' if incomplete else 'complete',
                receivedFilenames=[r['filename'] for r in rows if r['status'] == 'ready'],
                events=events, clips=rows)


def verify_archive(manifest_path):
    manifest_path = Path(manifest_path)
    require(manifest_path.name == 'manifest.json' and not manifest_path.is_symlink(), 'archive_manifest_path_invalid')
    root = manifest_path.parent
    stored = validation.read_json(read_bounded(manifest_path, MAX_MANIFEST), limit=MAX_MANIFEST)
    raw = read_bounded(confined(root, 'bundle.json'), validation.MAX_JSON)
    require(type(stored) is dict and type(stored.get('receivedFilenames')) is list
            and all(type(name) is str for name in stored['receivedFilenames']), 'archive_receipt_invalid')
    received = set(stored['receivedFilenames'])
    def fetch(row):
        if row['filename'] not in received:
            return None
        path = confined(root, 'originals/' + row['sha256'] + '.wav')
        return read_bounded(path, audio.MAX_BYTES) if path.is_file() else None
    expected = manifest_for(raw, fetch)
    require(validation.canonical(stored) == validation.canonical(expected), 'archive_manifest_modified')
    wanted = {'bundle.json', 'manifest.json'}
    for row in expected['clips']:
        if row['status'] != 'ready':
            continue
        for key, digest_key in [('sourceRef', 'sourceSha256'), ('derivedRef', 'derivedSha256')]:
            ref = row[key]
            data = read_bounded(confined(root, ref), audio.MAX_BYTES)
            require(audio.sha256(data) == row['preprocessing'][digest_key], 'archive_audio_modified')
            wanted.add(ref)
    actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file()}
    require(actual == wanted and not any(p.is_symlink() for p in root.rglob('*')), 'archive_contents_modified')
    return stored


def import_bundle(bundle_path, audio_dir, archive_root):
    raw = read_bounded(bundle_path, validation.MAX_JSON)
    # Validate paths/metadata before creating any destination artifacts.
    validation.validate_bundle(validation.read_json(raw))
    archive_root = Path(archive_root)
    require(not archive_root.is_symlink(), 'archive_root_symlink')
    complete = archive_root / audio.sha256(raw)
    if complete.exists():
        require(not complete.is_symlink(), 'archive_snapshot_symlink')
        verify_archive(complete / 'manifest.json')
        require((complete / 'bundle.json').read_bytes() == raw, 'archive_bundle_modified')
        return complete / 'manifest.json'
    # Cache only paths, not audio, and fail before publication if any input is bad.
    def fetch(row):
        path = confined(audio_dir, row['filename'])
        return read_bounded(path, audio.MAX_BYTES) if path.is_file() else None
    # Keep metadata/PCM/hash validation ahead of the archive-root mutation.
    manifest = manifest_for(raw, fetch)
    archive_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.import-', dir=archive_root) as temporary:
        stage = Path(temporary) / 'snapshot'
        stage.mkdir()
        def save(ref, data):
            target = stage / ref
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                require(target.read_bytes() == data, 'archive_hash_collision')
            else:
                target.write_bytes(data)
        # Read again into staging, then compare manifests to detect changed sources.
        staged_manifest = manifest_for(raw, fetch, save)
        require(staged_manifest == manifest, 'bundle_audio_changed_during_import')
        (stage / 'bundle.json').write_bytes(raw)
        manifest_bytes = (json.dumps(manifest, indent=2, allow_nan=False) + '\n').encode('utf-8')
        require(len(manifest_bytes) <= MAX_MANIFEST, 'archive_manifest_too_large')
        (stage / 'manifest.json').write_bytes(manifest_bytes)
        target = complete if manifest['status'] == 'complete' else archive_root / (audio.sha256(raw)[:16] + '-' + uuid.uuid4().hex)
        if os.name == 'nt':
            require(all(len(str(target.resolve() / p.relative_to(stage))) < 260 for p in stage.rglob('*')),
                    'archive_path_too_long; choose a shorter archive root')
        try:
            stage.rename(target)
        except FileExistsError:
            verify_archive(target / 'manifest.json')
    return target / 'manifest.json'
