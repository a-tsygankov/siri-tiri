import contextlib
import array
import io
import json
from pathlib import Path
import sys
import tempfile
import shutil
import subprocess
import unittest
import wave
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import manage
import phone_analysis
import phone_bundle
from test_phone_bundle import bundle, capture, manifest_row, uid
from test_phone_audio import wav_bytes
from test_dataset_prepare import pinned_runtime_available


class Predictor:
    def analyze(self, samples):
        return dict(sampleRate=16000, samples=len(samples), catScores=[dict(label='Meow', mean=.2, maximum=.4)])


class PhoneAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data = wav_bytes()
        (self.root / 'clip.wav').write_bytes(self.data)
        self.doc = bundle(self.data)

    def archive(self):
        source = self.root / 'bundle.json'
        source.write_text(json.dumps(self.doc))
        return phone_bundle.import_bundle(source, self.root, self.root / 'imports')

    def test_analysis_creates_unique_reports_without_changing_archive(self):
        path = self.archive()
        before = path.read_bytes()
        report_path = phone_analysis.analyze_import(path, Predictor())
        report = json.loads(report_path.read_text())
        self.assertEqual(report['status'], 'complete')
        self.assertTrue(report['synthetic'])
        self.assertEqual(report['events'][0]['scores']['samples'], 1600)
        self.assertEqual(path.read_bytes(), before)
        self.assertNotEqual(report_path, phone_analysis.analyze_import(path, Predictor()))
        phone_bundle.verify_archive(path)

    def test_missing_audio_has_no_scores_and_insufficient_coverage(self):
        self.doc['clips'] = []
        report = json.loads(phone_analysis.analyze_import(self.archive(), Predictor()).read_text())
        self.assertEqual(report['status'], 'insufficient_data')
        self.assertEqual(report['events'][0]['status'], 'missing_audio')
        self.assertNotIn('scores', report['events'][0])

    def test_deleted_events_are_excluded_and_never_scored(self):
        from test_phone_bundle import STAMP
        tomb = dict(schemaVersion=1, messageId=uid(2), eventId=uid(100), sourceId=uid(200), createdAt=STAMP,
                    type='capture', payload=dict(deleted=True, clipId=uid(301), supersedesMessageId=uid(1)))
        self.doc['events'].append(tomb)
        report = json.loads(phone_analysis.analyze_import(self.archive(), Predictor()).read_text())
        self.assertEqual(report['deletedCount'], 1)
        self.assertEqual(report['analyzedCount'], 0)
        self.assertNotIn('scores', report['events'][0])

    def test_direct_16k_stereo_analysis_keeps_existing_averaging(self):
        source = self.root / 'stereo.wav'
        with wave.open(str(source), 'wb') as wav:
            wav.setnchannels(2)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            pcm = array.array('h', [16384, -16384] * 160)
            if sys.byteorder != 'little':
                pcm.byteswap()
            wav.writeframes(pcm.tobytes())
        class Inspect:
            def analyze(self, samples):
                return dict(samples=len(samples), maximum=max(samples), minimum=min(samples))
        report = phone_analysis.analyze_phone(source, Inspect())
        self.assertEqual((report['samples'], report['minimum'], report['maximum']), (160, 0, 0))
        self.assertEqual(report['sourceAudio']['sourceChannels'], 2)

    def test_inference_failure_is_explicit_and_tampering_blocks_analysis(self):
        path = self.archive()
        class Broken:
            def analyze(self, samples):
                raise RuntimeError('private path / do not log this')
        report = json.loads(phone_analysis.analyze_import(path, Broken()).read_text())
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(report['events'][0]['errorCode'], 'inference_failed')
        doc = json.loads(path.read_text())
        (path.parent / doc['clips'][0]['derivedRef']).write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            phone_analysis.analyze_import(path, Predictor())

    def test_cli_exit_codes_and_explicit_arguments_survive_respawn(self):
        source = self.root / 'bundle.json.txt'
        source.write_text(json.dumps(self.doc))
        args = ['import-bundle', str(source), '--audio-dir', str(self.root), '--archive-root', str(self.root / 'archive')]
        with patch('manage.PYTHON', Path(sys.executable)), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(manage.main(args), 0)
            self.doc['clips'].append(manifest_row(dict(capture(self.data, 2), eventId=uid(101)), 'absent.wav'))
            self.doc['events'].append(dict(capture(self.data, 2), eventId=uid(101)))
            source.write_text(json.dumps(self.doc))
            self.assertEqual(manage.main(args), 2)
        interpreter = self.root / 'python.exe'
        interpreter.write_bytes(b'placeholder')
        with patch('manage.PYTHON', interpreter), patch('manage.subprocess.call', side_effect=lambda cmd, **kw: 0 if cmd[3:] == args else 91):
            self.assertEqual(manage.main(args), 0)

    @unittest.skipUnless(pinned_runtime_available(), 'optional pinned numerical runtime')
    def test_native_rate_analysis_reports_source_conversion(self):
        source = self.root / 'phone.wav'
        source.write_bytes(wav_bytes(48000, [0] * 48000))
        report = phone_analysis.analyze_phone(source, Predictor())
        self.assertEqual(report['samples'], 16000)
        self.assertEqual(report['sourceAudio']['sourceSampleRate'], 48000)
        self.assertEqual(report['sourceAudio']['sourceSamples'], 48000)

    @unittest.skipUnless(pinned_runtime_available() and shutil.which('node'), 'Node and pinned numerical runtime required')
    def test_shipping_pwa_export_trim_and_audio_interoperate(self):
        source = Path(__file__).with_name('generate_phone_fixture.mjs')
        subprocess.run(['node', str(source), str(self.root)], check=True, capture_output=True)
        path = phone_bundle.import_bundle(self.root / 'bundle.json', self.root, self.root / 'imports')
        archive = phone_bundle.verify_archive(path)
        self.assertEqual(archive['status'], 'complete')
        self.assertEqual(len(archive['clips']), 4)
        self.assertEqual([r.get('trimVerification') for r in archive['clips'] if '.trimmed.' in r['filename']],
                         ['verified', 'verified'])
        result = json.loads(phone_analysis.analyze_import(path, Predictor()).read_text())
        self.assertEqual(result['analyzedCount'], 2)
        self.assertTrue(all(e['scores']['samples'] == 9600 for e in result['events']))
