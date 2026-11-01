"""Canonical local snapshot helpers; artifacts are new files, never edits of old runs."""
import csv
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import uuid


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def read_document(path):
    path = Path(path)
    if path.stat().st_size > 30000000:
        raise ValueError('review artifact too large')
    value = json.loads(path.read_bytes())
    canonical(value)
    return value


def save_document(root, prefix, value):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    destination = root / (prefix + '-' + uuid.uuid4().hex + '.json')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=root, suffix='.part', mode='w', encoding='utf-8', delete=False) as output:
            temporary = Path(output.name)
            output.write(json.dumps(value, indent=2, allow_nan=False) + '\n')
            output.flush()
            os.fsync(output.fileno())
        temporary.rename(destination)
        return destination
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def csv_safe(value):
    if isinstance(value, str) and value[:1] in ('=', '+', '-', '@', '\t', '\r', '\n'):
        return "'" + value
    return value


def export_catalog(root, snapshot):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    destination = root / ('catalog-' + uuid.uuid4().hex)
    fields = ['clipId', 'sourceRef', 'sourceSha256', 'catId', 'sessionId', 'split', 'groupResolved',
              'referenceLabel', 'effectiveLabel', 'labelSource', 'reviewStatus', 'revision', 'reviewer', 'reviewedAt']
    with tempfile.TemporaryDirectory(prefix='export-', dir=root) as temporary:
        stage = Path(temporary) / 'snapshot'
        stage.mkdir()
        (stage / 'catalog.json').write_text(json.dumps(snapshot, indent=2, allow_nan=False) + '\n', encoding='utf-8')
        with (stage / 'catalog.csv').open('x', newline='', encoding='utf-8') as output:
            writer = csv.DictWriter(output, fieldnames=fields)
            writer.writeheader()
            for row in snapshot['clips']:
                writer.writerow({field: csv_safe(row.get(field)) for field in fields})
        stage.rename(destination)
    return destination / 'catalog.json'
