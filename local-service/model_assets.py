"""Pinned official model provisioning; inference never downloads implicitly."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import urlsplit
from urllib.request import urlopen
import zipfile

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / 'model-manifest.json').read_text(encoding='utf-8'))
MODEL_PATH = ROOT / 'models' / 'yamnet-1' / 'yamnet.tflite'


def verify(path, manifest=MANIFEST):
    path = Path(path)
    if not path.is_file() or path.stat().st_size != manifest['size']:
        raise ValueError('model_size_mismatch')
    if hashlib.sha256(path.read_bytes()).hexdigest() != manifest['sha256']:
        raise ValueError('model_checksum_mismatch')


def download(path=MODEL_PATH, manifest=MANIFEST):
    path = Path(path)
    if path.exists():
        try:
            verify(path, manifest)
            return path
        except ValueError:
            pass
    if urlsplit(manifest['url']).scheme != 'https':
        raise ValueError('model_requires_https')
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with urlopen(manifest['url'], timeout=60) as response:
            if urlsplit(response.geturl()).scheme != 'https':
                raise ValueError('model_redirect_requires_https')
            with tempfile.NamedTemporaryFile(dir=path.parent, suffix='.part', delete=False) as output:
                temporary = Path(output.name)
                remaining = manifest['size'] + 1
                while remaining:
                    chunk = response.read(min(65536, remaining))
                    if not chunk:
                        break
                    output.write(chunk)
                    remaining -= len(chunk)
        verify(temporary, manifest)
        os.replace(temporary, path)
        return path
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def labels(path=MODEL_PATH):
    verify(path)
    with zipfile.ZipFile(path) as archive:
        names = archive.read(MANIFEST['labelFile']).decode('utf-8').splitlines()
    if len(names) != MANIFEST['labelCount'] or len(set(names)) != len(names):
        raise ValueError('model_labels_invalid')
    return names
