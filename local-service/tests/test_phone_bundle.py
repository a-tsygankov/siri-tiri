import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import phone_bundle
from test_phone_audio import wav_bytes

STAMP = '2026-11-26T12:00:00.000Z'


def uid(n):
    return str(uuid.UUID(int=n))


def capture(data, n=1):
    return dict(schemaVersion=1, messageId=uid(n), eventId=uid(100), sourceId=uid(200), createdAt=STAMP,
                type='capture', payload=dict(clipId=uid(n + 300), sampleRate=16000, durationMs=100,
                sizeBytes=len(data), sha256=hashlib.sha256(data).hexdigest(), clippedSamples=0,
                recordedAt=STAMP, interrupted=False, encoding='pcm16-wav', channels=1,
                captureVersion='pwa-pcm16-native-v1', sourceKind='pwa-manual', clockSource='phone'))


def manifest_row(e, name='clip.wav'):
    return dict(eventId=e['eventId'], filename=name, **{k: e['payload'][k] for k in
                ('clipId', 'sha256', 'sizeBytes', 'sampleRate', 'durationMs')})


def bundle(data):
    e = capture(data)
    return dict(exportVersion=1, protocolVersion=1, appVersion='0.2.0', installId=uid(200), exportedAt=STAMP,
                events=[e], reviews=[], clips=[manifest_row(e)])


class PhoneBundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.audio = self.root / 'audio'
        self.audio.mkdir()
        self.data = wav_bytes()
        (self.audio / 'clip.wav').write_bytes(self.data)
        self.doc = bundle(self.data)
        self.source = self.root / 'bundle.json.txt'
        self.archive = self.root / 'imports'

    def run_import(self):
        self.source.write_text(json.dumps(self.doc), encoding='utf-8')
        path = phone_bundle.import_bundle(self.source, self.audio, self.archive)
        return path, json.loads(path.read_text())

    def test_import_repeat_and_original_bytes_are_preserved(self):
        path, doc = self.run_import()
        self.assertEqual(doc['status'], 'complete')
        self.assertEqual(doc['events'][0]['status'], 'ready')
        self.assertEqual((path.parent / 'bundle.json').read_bytes(), self.source.read_bytes())
        self.assertEqual((path.parent / doc['clips'][0]['sourceRef']).read_bytes(), self.data)
        self.assertEqual(self.run_import()[0], path)
        self.assertEqual((self.audio / 'clip.wav').read_bytes(), self.data)

    def test_partial_share_preserves_available_evidence_and_retry_succeeds(self):
        second = capture(self.data, 2)
        second['eventId'] = uid(101)
        self.doc['events'].append(second)
        self.doc['clips'].append(manifest_row(second, 'second.wav'))
        path, doc = self.run_import()
        self.assertEqual(doc['status'], 'incomplete')
        self.assertEqual(doc['clips'][1]['status'], 'missing_audio')
        self.assertTrue((path.parent / doc['clips'][0]['sourceRef']).exists())
        self.assertEqual(phone_bundle.verify_archive(path)['status'], 'incomplete')
        (self.audio / 'second.wav').write_bytes(self.data)
        complete, doc = self.run_import()
        self.assertEqual(doc['status'], 'complete')
        self.assertNotEqual(path, complete)
        self.assertTrue(path.exists())

    def test_records_only_reviews_and_tombstones_are_retained(self):
        self.doc['clips'] = []
        self.doc['reviews'] = [dict(schemaVersion=1, messageId=uid(20), reviewId=uid(21), eventId=uid(100),
                                   revision=1, baseRevision=None, editedAt=STAMP, source='pwa', context='unsure', deleted=True)]
        _, doc = self.run_import()
        self.assertEqual(doc['status'], 'complete')
        self.assertEqual(doc['events'][0]['status'], 'missing_audio')
        tomb = dict(schemaVersion=1, messageId=uid(2), eventId=uid(100), sourceId=uid(200), createdAt=STAMP,
                    type='capture', payload=dict(deleted=True, clipId=uid(301), supersedesMessageId=uid(1)))
        self.doc['events'].append(tomb)
        _, doc = self.run_import()
        self.assertEqual(doc['events'][0]['status'], 'deleted')

    def test_unsafe_names_and_case_collisions_are_rejected_before_publication(self):
        for name in ('../clip.wav', '/clip.wav', 'C:clip.wav', 'clip.wav:secret', 'CON.wav', 'clip.wav.', 'a\\clip.wav'):
            self.doc['clips'][0]['filename'] = name
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.run_import()
        self.assertFalse(self.archive.exists())

    def test_hash_metadata_and_versions_are_validated(self):
        cases = []
        for keys, value in [(('exportVersion',), True), (('protocolVersion',), 2),
                            (('events', 0, 'payload', 'durationMs'), 200),
                            (('clips', 0, 'sampleRate'), 48000), (('events', 0, 'messageId'), 'bad'),
                            (('events', 0, 'payload', 'sha256'), '0' * 64)]:
            doc = copy.deepcopy(self.doc)
            parent = doc
            for key in keys[:-1]:
                parent = parent[key]
            parent[keys[-1]] = value
            cases.append(doc)
        for doc in cases:
            self.doc = doc
            with self.subTest(doc=doc), self.assertRaises(ValueError):
                self.run_import()
        self.assertFalse(self.archive.exists())

    def test_duplicate_id_with_changed_content_and_duplicate_json_keys_rejected(self):
        changed = copy.deepcopy(self.doc['events'][0])
        changed['payload']['interrupted'] = True
        self.doc['events'].append(changed)
        with self.assertRaises(ValueError):
            self.run_import()
        self.source.write_text('{"exportVersion":1,"exportVersion":2}')
        with self.assertRaises(ValueError):
            phone_bundle.import_bundle(self.source, self.audio, self.archive)

    def test_forks_and_missing_ancestors_are_durable_but_excluded(self):
        fork = capture(self.data, 2)
        self.doc['events'].append(fork)
        _, doc = self.run_import()
        self.assertEqual(doc['status'], 'incomplete')
        self.assertEqual(doc['events'][0]['status'], 'conflict')
        self.doc['events'] = [fork]
        self.doc['clips'] = [manifest_row(fork)]
        fork['payload']['supersedesMessageId'] = uid(999)
        _, doc = self.run_import()
        self.assertEqual(doc['events'][0]['status'], 'unresolved_history')

    def test_cycles_and_cross_event_supersession_rejected(self):
        one = self.doc['events'][0]
        one['payload']['supersedesMessageId'] = one['messageId']
        with self.assertRaises(ValueError):
            self.run_import()
        other = capture(self.data, 2)
        other['eventId'] = uid(101)
        one['payload']['supersedesMessageId'] = other['messageId']
        self.doc['events'].append(other)
        with self.assertRaises(ValueError):
            self.run_import()

    def test_repeat_detects_edited_derivative_and_manifest(self):
        path, doc = self.run_import()
        derived = path.parent / doc['clips'][0]['derivedRef']
        derived.write_bytes(b'changed')
        with self.assertRaises(ValueError):
            self.run_import()

    def test_repeat_detects_edited_manifest(self):
        path, doc = self.run_import()
        doc['events'][0]['status'] = 'deleted'
        path.write_text(json.dumps(doc))
        with self.assertRaises(ValueError):
            self.run_import()

    def test_case_collisions_nonfinite_and_resource_bounds_are_rejected(self):
        self.doc['clips'].append(dict(self.doc['clips'][0], filename='CLIP.WAV'))
        with self.assertRaises(ValueError):
            self.run_import()
        self.doc['clips'].pop()
        with patch('phone_bundle.MAX_TOTAL', len(self.data) - 1), self.assertRaises(ValueError):
            self.run_import()
        with patch('bundle_validation.MAX_ROWS', 0), self.assertRaises(ValueError):
            self.run_import()
        with patch('bundle_validation.MAX_JSON', 10), self.assertRaises(ValueError):
            self.run_import()
        self.source.write_text('{"value":1e999}')
        with self.assertRaises(ValueError):
            phone_bundle.import_bundle(self.source, self.audio, self.archive)

    def test_escaping_audio_link_is_rejected(self):
        outside = self.root / 'outside.wav'
        outside.write_bytes(self.data)
        link = self.audio / 'link.wav'
        try:
            link.symlink_to(outside)
        except OSError as ex:
            if os.name == 'nt' and getattr(ex, 'winerror', None) == 1314:
                self.skipTest('Windows symlink creation privilege unavailable')
            raise
        self.doc['clips'][0]['filename'] = 'link.wav'
        with self.assertRaises(ValueError):
            self.run_import()

    def test_restore_selects_original_without_historical_trim_audio(self):
        original = self.doc['events'][0]
        superseded = capture(self.data, 2)
        superseded['payload']['supersedesMessageId'] = uid(1)
        restored = copy.deepcopy(original)
        restored['messageId'] = uid(3)
        restored['payload'].update(supersedesMessageId=uid(2), restoresMessageId=uid(1))
        self.doc['events'] += [superseded, restored]
        _, doc = self.run_import()
        self.assertEqual(doc['status'], 'complete')
        self.assertEqual(doc['events'][0]['messageId'], uid(3))

    def test_trim_source_pcm_is_checked_and_original_can_be_absent(self):
        original = self.doc['events'][0]
        cut_data = wav_bytes(samples=[0] * 800)
        cut = capture(cut_data, 2)
        cut['payload'].update(durationMs=50, supersedesMessageId=uid(1), trim=dict(sourceMessageId=uid(1),
            sourceClipId=uid(301), sourceSha256=original['payload']['sha256'], sourceDurationMs=100,
            startMs=25, endMs=75, trimVersion='pwa-trim-v1'))
        self.doc['events'].append(cut)
        self.doc['clips'].append(manifest_row(cut, 'cut.wav'))
        (self.audio / 'cut.wav').write_bytes(cut_data)
        _, doc = self.run_import()
        self.assertEqual(doc['events'][0]['messageId'], uid(2))
        self.assertEqual(doc['events'][0]['status'], 'ready')
        self.assertEqual(doc['clips'][1]['trimVerification'], 'verified')
        self.doc['clips'] = [manifest_row(cut, 'cut.wav')]
        _, doc = self.run_import()
        self.assertEqual(doc['clips'][0]['trimVerification'], 'original_audio_not_supplied')
        self.doc['clips'].insert(0, manifest_row(original))
        (self.audio / 'cut.wav').write_bytes(wav_bytes(samples=[1] * 800))
        cut['payload']['sha256'] = hashlib.sha256((self.audio / 'cut.wav').read_bytes()).hexdigest()
        self.doc['clips'][1] = manifest_row(cut, 'cut.wav')
        with self.assertRaises(ValueError):
            self.run_import()

    def test_review_gap_and_fork_are_reported_not_silently_resolved(self):
        review = dict(schemaVersion=1, messageId=uid(20), reviewId=uid(21), eventId=uid(100), revision=2,
                      baseRevision=1, editedAt=STAMP, source='pwa', context='food')
        self.doc['reviews'] = [review]
        _, doc = self.run_import()
        self.assertEqual(doc['events'][0]['status'], 'unresolved_history')
        first = dict(review, messageId=uid(22), revision=1, baseRevision=None)
        competing = dict(first, messageId=uid(23), context='attention')
        self.doc['reviews'] = [first, competing]
        _, doc = self.run_import()
        self.assertEqual(doc['events'][0]['status'], 'conflict')
