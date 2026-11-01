"""Versioned offline CatMeows preparation; never modifies source recordings."""
import array
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile
import wave
import zipfile

import catmeows
import model_assets

VERSION = 'catmeows-pcm16-8k-to16k-polyphase2-kaiser5-v1'
CONTEXTS = {'B': 'brushing', 'F': 'waiting_for_food', 'I': 'isolation_unfamiliar'}
SPLIT_VERSION = 'sha256-cat-v1-20pct-evaluation'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def parse_metadata(filename):
    match = re.fullmatch(r'([BFI])_([A-Z0-9]+)_(MC|EU)_(FI|FN|MI|MN)_([A-Z0-9]+)_([1-9])([0-9]{2})\.wav', filename)
    if match is None or match[7] == '00':
        raise ValueError('invalid CatMeows primary filename')
    context, cat, breed, sex, owner, session, count = match.groups()
    metadata = dict(clipId=filename[:-4], datasetContext=CONTEXTS[context], catId=cat, ownerId=owner,
                    breed=breed, sex=sex, recordingSession=session, sessionId=f'{cat}:{owner}:{session}', vocalization=count)
    if session not in ('1', '2', '3'):
        metadata['metadataNotes'] = ['session_outside_published_1_to_3_range']
    return metadata


def split_for_cat(cat_id):
    bucket = int(hashlib.sha256(cat_id.encode('ascii')).hexdigest()[:8], 16) % 5
    return 'evaluation' if bucket == 0 else 'calibration'


def resample_pcm16(samples):
    import numpy as np
    import scipy
    from scipy.signal import resample_poly
    if np.__version__ != '2.2.6' or scipy.__version__ != '1.15.3':
        raise RuntimeError('resampling runtime mismatch; run pinned inference setup')
    values = np.asarray(samples, dtype=np.float64)
    if (values.ndim != 1 or not 1 <= len(values) <= 240000 or not np.isfinite(values).all()
            or (values < -32768).any() or (values > 32767).any() or (values != np.rint(values)).any()):
        raise ValueError('invalid PCM16 source samples')
    converted = resample_poly(values / 32768, 2, 1, window=('kaiser', 5.0), padtype='constant', cval=0)
    rounded = np.rint(converted * 32768)
    clipped = int(((rounded < -32768) | (rounded > 32767)).sum())
    output = np.clip(rounded, -32768, 32767).astype(np.int16)
    return array.array('h', output.tolist()), clipped


def read_source(path):
    try:
        if Path(path).stat().st_size > 3000000:
            raise ValueError('source too large')
        with wave.open(str(path), 'rb') as source:
            if (source.getnchannels(), source.getsampwidth(), source.getframerate(), source.getcomptype()) != (1, 2, 8000, 'NONE'):
                raise ValueError('source must be mono PCM16 8000 Hz')
            frames = source.getnframes()
            if not 1 <= frames <= 240000:
                raise ValueError('source duration must be 0..30 seconds, nonempty')
            raw = source.readframes(frames)
            if len(raw) != frames * 2:
                raise ValueError('truncated source WAV')
        samples = array.array('h')
        samples.frombytes(raw)
        if sys.byteorder != 'little':
            samples.byteswap()
        return samples
    except (EOFError, wave.Error) as ex:
        raise ValueError('invalid source WAV') from ex


def write_wav(path, samples):
    encoded = array.array('h', samples)
    if sys.byteorder != 'little':
        encoded.byteswap()
    with wave.open(str(path), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(encoded.tobytes())


def prepare_files(paths, destination):
    paths = sorted(map(Path, paths), key=lambda p: p.name)
    if not paths or len(paths) > 10000 or len({p.name.casefold() for p in paths}) != len(paths):
        raise ValueError('primary clips must be nonempty and unique')
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='prepare-', dir=destination.parent) as temporary:
        stage = Path(temporary) / 'prepared'
        (stage / 'audio').mkdir(parents=True)
        rows = []
        for path in paths:
            metadata = parse_metadata(path.name)
            source_hash = digest(path)
            samples = read_source(path)
            output, clipped = resample_pcm16(samples)
            audio_ref = 'audio/' + path.name
            write_wav(stage / audio_ref, output)
            if digest(path) != source_hash:
                raise ValueError('source changed during preparation')
            rows.append(dict(metadata, split=split_for_cat(metadata['catId']), sourceRef='raw/dataset/' + path.name,
                             sourceSha256=source_hash, audioRef=audio_ref, derivedSha256=digest(stage / audio_ref),
                             sourceSampleRate=8000, sampleRate=16000, sourceSamples=len(samples), samples=len(output),
                             durationSeconds=len(output) / 16000, clippedSamples=clipped))
        manifest = dict(schemaVersion=1, dataset='CatMeows', datasetVersion='1.0.2', datasetSource=catmeows.SOURCE,
                        preparationVersion=VERSION, splitVersion=SPLIT_VERSION,
                        dependencies=dict(scipy='1.15.3', numpy='2.2.6'),
                        labelScope='positive primary meows; context is recording metadata, not inferred intent',
                        sampleCount=len(rows), clips=rows)
        (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2, allow_nan=False) + '\n', encoding='utf-8')
        if destination.exists():
            for candidate in stage.rglob('*'):
                if candidate.is_file():
                    existing = destination / candidate.relative_to(stage)
                    if (not existing.is_file() or existing.is_symlink()
                            or not existing.resolve().is_relative_to(destination.resolve())
                            or existing.read_bytes() != candidate.read_bytes()):
                        raise ValueError('prepared dataset differs; preserve it and use a new version/destination')
        else:
            stage.rename(destination)
    return destination / 'manifest.json'


def prepare_catmeows(root=catmeows.DESTINATION):
    root = Path(root)
    paths = [root / 'archives' / item['filename'] for item in catmeows.ARCHIVES]
    for path, item in zip(paths, catmeows.ARCHIVES):
        try:
            model_assets.verify(path, item)  # No implicit network access.
        except ValueError:
            raise ValueError('CatMeows archive missing or invalid; run manage.py catmeows first') from None
    catmeows.extract(paths, root / 'raw')  # Verify every original against pinned archives.
    with zipfile.ZipFile(paths[0]) as archive:
        members = [item.filename for item in archive.infolist() if not item.is_dir()]
    if len(members) != 440 or any(not name.startswith('dataset/') or not name.endswith('.wav') for name in members):
        raise ValueError('unexpected primary CatMeows inventory')
    return prepare_files([root / 'raw' / name for name in members], root / 'derived' / VERSION)
