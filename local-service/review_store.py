"""Offline audible-meow reference labels and transactional human review history."""
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path, PurePosixPath
import json
import re
import sqlite3
import zipfile

import catmeows
import dataset_prepare as prepare
import model_assets
from review_artifacts import canonical, fingerprint, utc_now

TARGET = 'audible_meow'
LABELS = {'positive', 'negative', 'uncertain'}
INVENTORY_FIELDS = ('clipId', 'sourceRef', 'sourceSha256', 'sourceName', 'catId', 'ownerId', 'sessionId',
                    'datasetContext', 'metadataNotes', 'groupResolved', 'split', 'referenceLabel')


class RevisionConflict(ValueError):
    pass


def inventory_record(source_ref, source_sha, known_cats):
    path = PurePosixPath(source_ref)
    if (path.is_absolute() or '..' in path.parts or ':' in source_ref or '\\' in source_ref
            or len(path.parts) != 3 or path.parts[0] != 'raw'
            or path.parts[1] not in ('dataset', 'other_vocalizations', 'sequences')
            or not re.fullmatch('[0-9a-f]{64}', source_sha)):
        raise ValueError('invalid review source identity')
    parsed_name = re.sub(r'_([1-9])SEQ[0-9]+\.wav$', r'_\g<1>01.wav', path.name)
    try:
        metadata = prepare.parse_metadata(parsed_name)
        owners = known_cats.get(metadata['catId'], ())
        owners = {owners} if isinstance(owners, str) else set(owners)
        resolved = metadata['ownerId'] in owners
        if len(owners) > 1:
            metadata.setdefault('metadataNotes', []).append('owner_id_varies_within_cat')
    except ValueError:
        metadata, resolved = {}, False
    return dict(clipId='cm-' + fingerprint([source_ref, source_sha])[:24], sourceRef=source_ref,
                sourceSha256=source_sha, sourceName=path.name, catId=metadata.get('catId'),
                ownerId=metadata.get('ownerId'), sessionId=metadata.get('sessionId'),
                datasetContext=metadata.get('datasetContext'), metadataNotes=metadata.get('metadataNotes', []),
                groupResolved=resolved, split=prepare.split_for_cat(metadata['catId']) if resolved else None,
                referenceLabel='positive' if path.parts[1] == 'dataset' else None)


def validate_inventory(rows):
    if not isinstance(rows, list) or not 1 <= len(rows) <= 10000:
        raise ValueError('invalid review inventory')
    ids, references, contents = set(), set(), {}
    known_cats = {}
    for row in rows:
        if isinstance(row, dict) and row.get('groupResolved') is True:
            known_cats.setdefault(row.get('catId'), set()).add(row.get('ownerId'))
    for row in rows:
        if (not isinstance(row, dict) or not isinstance(row.get('sourceRef'), str)
                or not isinstance(row.get('sourceSha256'), str) or type(row.get('groupResolved')) is not bool):
            raise ValueError('invalid review inventory record')
        known = known_cats if row['groupResolved'] else {}
        expected = inventory_record(row['sourceRef'], row['sourceSha256'], known)
        if any(row.get(key) != expected[key] for key in INVENTORY_FIELDS):
            raise ValueError('review source metadata mismatch')
        if (row.get('clipId') != 'cm-' + fingerprint([row.get('sourceRef'), row.get('sourceSha256')])[:24]
                or row['clipId'] in ids or row.get('sourceRef') in references
                or not isinstance(row.get('sourceSha256'), str) or not re.fullmatch('[0-9a-f]{64}', row['sourceSha256'])):
            raise ValueError('duplicate or invalid review identity')
        ids.add(row['clipId'])
        references.add(row['sourceRef'])
        if row.get('referenceLabel') not in (None, 'positive'):
            raise ValueError('invalid reference label')
        if row.get('groupResolved'):
            if not row.get('catId') or not row.get('sessionId') or row.get('split') != prepare.split_for_cat(row['catId']):
                raise ValueError('invalid review group')
        elif row.get('split') is not None:
            raise ValueError('unresolved group cannot have split')
        group = (row.get('catId'), row.get('split'))
        if row['sourceSha256'] in contents and contents[row['sourceSha256']] != group:
            raise ValueError('duplicate audio crosses groups')
        contents[row['sourceSha256']] = group
    return sorted(rows, key=lambda row: row['clipId'])


def validate_catalog(data):
    try:
        if (type(data['schemaVersion']) is not int or data['schemaVersion'] != 1
                or data['artifactType'] != 'reviewCatalog' or data['target'] != TARGET):
            raise ValueError('unsupported review catalog')
        base = [{key: row[key] for key in INVENTORY_FIELDS} for row in data['clips']]
        if fingerprint(validate_inventory(base)) != data['inventoryFingerprint']:
            raise ValueError('review inventory integrity failure')
        for row in data['clips']:
            history = row['history']
            if not isinstance(history, list):
                raise ValueError('invalid review history')
            for number, item in enumerate(history, 1):
                if (type(item['revision']) is not int or item['revision'] != number
                        or item['label'] not in LABELS or not isinstance(item['reviewer'], str)
                        or not item['reviewer'].strip() or len(item['reviewer']) > 128
                        or not isinstance(item['note'], str) or len(item['note']) > 512
                        or not isinstance(item['reviewedAt'], str)):
                    raise ValueError('invalid review history')
                if datetime.fromisoformat(item['reviewedAt']).utcoffset() != timedelta(0):
                    raise ValueError('review timestamp must be UTC')
            latest = history[-1] if history else None
            expected = dict(revision=len(history), effectiveLabel=latest['label'] if latest else row['referenceLabel'],
                            labelSource='human' if latest else 'dataset_reference' if row['referenceLabel'] else None,
                            reviewStatus='reviewed' if latest else 'dataset_reference' if row['referenceLabel'] else 'unreviewed',
                            reviewer=latest['reviewer'] if latest else None, reviewedAt=latest['reviewedAt'] if latest else None)
            if type(row['revision']) is not int or any(row.get(key) != value for key, value in expected.items()):
                raise ValueError('effective label does not match review history')
        return data
    except (KeyError, TypeError, AttributeError):
        raise ValueError('invalid review catalog') from None


def catmeows_inventory(root):
    root = Path(root)
    paths = [root / 'archives' / item['filename'] for item in catmeows.ARCHIVES]
    for path, manifest in zip(paths, catmeows.ARCHIVES):
        model_assets.verify(path, manifest)
    catmeows.extract(paths, root / 'raw')
    members = []
    for path in paths:
        with zipfile.ZipFile(path) as archive:
            members.extend(item.filename for item in archive.infolist() if not item.is_dir())
    known = {}
    for name in members:
        if name.startswith('dataset/'):
            item = prepare.parse_metadata(PurePosixPath(name).name)
            known.setdefault(item['catId'], set()).add(item['ownerId'])
    return validate_inventory([inventory_record('raw/' + name, prepare.digest(root / 'raw' / name), known) for name in members])


class ReviewStore:
    def __init__(self, root):
        self.root = Path(root)
        self.path = self.root / 'reviews' / 'annotations.sqlite3'

    @contextmanager
    def connect(self, create=False):
        if not create and not self.path.is_file():
            raise ValueError('review catalog missing; run review-init')
        if create:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('PRAGMA journal_mode=WAL')
            if db.execute('PRAGMA user_version').fetchone()[0] > 1:
                raise ValueError('review database schema is newer than supported')
            with db:
                yield db
        finally:
            db.close()

    def initialize(self, inventory):
        rows = validate_inventory(inventory)
        identity = fingerprint(rows)
        with self.connect(create=True) as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('CREATE TABLE IF NOT EXISTS catalog (id INTEGER PRIMARY KEY CHECK(id=1), target TEXT NOT NULL, inventory_hash TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS clips (clip_id TEXT PRIMARY KEY, body TEXT NOT NULL)')
            db.execute('''CREATE TABLE IF NOT EXISTS reviews (
                clip_id TEXT NOT NULL REFERENCES clips(clip_id), revision INTEGER NOT NULL,
                label TEXT NOT NULL, reviewer TEXT NOT NULL, reviewed_at TEXT NOT NULL, note TEXT NOT NULL,
                PRIMARY KEY(clip_id,revision))''')
            existing = db.execute('SELECT * FROM catalog WHERE id=1').fetchone()
            if existing:
                if existing['target'] != TARGET or existing['inventory_hash'] != identity:
                    raise ValueError('review inventory changed; preserve existing catalog')
            else:
                db.execute('INSERT INTO catalog VALUES (1,?,?)', (TARGET, identity))
                db.executemany('INSERT INTO clips VALUES (?,?)', [(row['clipId'], canonical(row)) for row in rows])
            db.execute('PRAGMA user_version=1')
        return self.snapshot()

    def label(self, clip_id, label, reviewer, expected_revision, note=''):
        if (not isinstance(label, str) or label not in LABELS or not isinstance(reviewer, str) or not reviewer.strip() or len(reviewer) > 128
                or type(expected_revision) is not int or expected_revision < 0
                or not isinstance(note, str) or len(note) > 512):
            raise ValueError('invalid label, reviewer, revision or note')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            stored = db.execute('SELECT body FROM clips WHERE clip_id=?', (clip_id,)).fetchone()
            if stored is None:
                raise ValueError('review clip not found')
            current = db.execute('SELECT coalesce(max(revision),0) FROM reviews WHERE clip_id=?', (clip_id,)).fetchone()[0]
            if current != expected_revision:
                raise RevisionConflict('review revision conflict')
            from inference import resolve_audio
            record = json.loads(stored['body'])
            source = resolve_audio(self.root, record['sourceRef'])
            if prepare.digest(source) != record['sourceSha256']:
                raise ValueError('review source changed; restore the catalog audio before labeling')
            db.execute('INSERT INTO reviews VALUES (?,?,?,?,?,?)',
                       (clip_id, current + 1, label, reviewer.strip(), utc_now(), note))
        return current + 1

    def snapshot(self):
        with self.connect() as db:
            db.execute('BEGIN')
            meta = db.execute('SELECT * FROM catalog WHERE id=1').fetchone()
            rows = [json.loads(row['body']) for row in db.execute('SELECT body FROM clips ORDER BY clip_id')]
            if meta is None or meta['target'] != TARGET or fingerprint(validate_inventory(rows)) != meta['inventory_hash']:
                raise ValueError('review inventory integrity failure')
            for row in rows:
                history = [dict(revision=item['revision'], label=item['label'], reviewer=item['reviewer'],
                                reviewedAt=item['reviewed_at'], note=item['note'])
                           for item in db.execute('SELECT * FROM reviews WHERE clip_id=? ORDER BY revision', (row['clipId'],))]
                latest = history[-1] if history else None
                row.update(history=history, revision=latest['revision'] if latest else 0,
                           effectiveLabel=latest['label'] if latest else row['referenceLabel'],
                           labelSource='human' if latest else 'dataset_reference' if row['referenceLabel'] else None,
                           reviewStatus='reviewed' if latest else 'dataset_reference' if row['referenceLabel'] else 'unreviewed',
                           reviewer=latest['reviewer'] if latest else None, reviewedAt=latest['reviewedAt'] if latest else None)
        return dict(schemaVersion=1, artifactType='reviewCatalog', target=TARGET,
                    inventoryFingerprint=meta['inventory_hash'], generatedAt=utc_now(), clips=rows)
