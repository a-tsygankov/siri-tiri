import array
import hashlib
from importlib.metadata import PackageNotFoundError, version
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dataset_prepare as prepare


class DatasetMetadataTests(unittest.TestCase):
    def test_filename_metadata_remains_dataset_context(self):
        metadata = prepare.parse_metadata('F_MAG01_EU_FN_FED01_106.wav')
        self.assertEqual(metadata, dict(clipId='F_MAG01_EU_FN_FED01_106', datasetContext='waiting_for_food',
                                      catId='MAG01', ownerId='FED01', breed='EU', sex='FN',
                                      recordingSession='1', sessionId='MAG01:FED01:1', vocalization='06'))
        self.assertNotIn('intent', metadata)
        for name in ('../F_MAG01_EU_FN_FED01_106.wav', 'bad.wav', 'X_MAG01_EU_FN_FED01_106.wav',
                     'F_MAG01_EU_FN_FED01_006.wav', 'F_MAG01_EU_FN_FED01_100.wav'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                prepare.parse_metadata(name)

    def test_group_split_keeps_every_session_of_each_cat_together(self):
        first = prepare.parse_metadata('F_MAG01_EU_FN_FED01_106.wav')
        second = prepare.parse_metadata('B_MAG01_EU_FN_FED01_201.wav')
        self.assertEqual(prepare.split_for_cat(first['catId']), prepare.split_for_cat(second['catId']))
        self.assertIn(prepare.split_for_cat('MAG01'), ('calibration', 'evaluation'))

    def test_observed_session_four_is_preserved_and_flagged(self):
        metadata = prepare.parse_metadata('I_BLE01_EU_FN_DEL01_401.wav')
        self.assertEqual(metadata['recordingSession'], '4')
        self.assertEqual(metadata['sessionId'], 'BLE01:DEL01:4')
        self.assertEqual(metadata['metadataNotes'], ['session_outside_published_1_to_3_range'])


def pinned_runtime_available():
    try:
        return version('scipy') == '1.15.3' and version('numpy') == '2.2.6'
    except PackageNotFoundError:
        return False


@unittest.skipUnless(pinned_runtime_available(), 'optional pinned SciPy/NumPy required; run inference setup')
class DatasetPreparationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def wav(self, name='F_MAG01_EU_FN_FED01_106.wav', rate=8000):
        path = self.root / name
        values = array.array('h', [int(12000 * math.sin(2 * math.pi * 1000 * i / rate)) for i in range(800)])
        if sys.byteorder != 'little':
            values.byteswap()
        with wave.open(str(path), 'wb') as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(rate)
            output.writeframes(values.tobytes())
        return path

    def test_resampling_preserves_duration_tone_and_amplitude(self):
        source = array.array('h', [int(16384 * math.sin(2 * math.pi * 1000 * i / 8000)) for i in range(8000)])
        output, clipped = prepare.resample_pcm16(source)
        self.assertEqual(len(output), 16000)
        self.assertEqual(clipped, 0)
        errors = [abs(output[i] / 32768 - .5 * math.sin(2 * math.pi * 1000 * i / 16000))
                  for i in range(40, len(output) - 40)]
        self.assertLess(max(errors), .005)
        silence, clipped = prepare.resample_pcm16(array.array('h', [0] * 8))
        self.assertEqual(list(silence), [0] * 16)
        self.assertEqual(clipped, 0)

    def test_saturation_is_counted_without_integer_wraparound(self):
        output, clipped = prepare.resample_pcm16(array.array('h', [32767] * 100 + [-32768] * 100))
        self.assertEqual(len(output), 400)
        self.assertGreater(clipped, 0)
        self.assertEqual(max(output), 32767)
        self.assertEqual(min(output), -32768)

    def test_prepare_preserves_original_and_verifies_repeat_and_derived_integrity(self):
        source = self.wav()
        before = source.read_bytes()
        target = self.root / 'derived'
        manifest_path = prepare.prepare_files([source], target)
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        row = manifest['clips'][0]
        self.assertEqual(row['sourceSha256'], hashlib.sha256(before).hexdigest())
        self.assertEqual(row['sourceSampleRate'], 8000)
        self.assertEqual(row['sampleRate'], 16000)
        self.assertEqual(row['samples'], 1600)
        self.assertEqual(row['datasetContext'], 'waiting_for_food')
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(prepare.prepare_files([source], target), manifest_path)
        derived = target / row['audioRef']
        with wave.open(str(derived), 'rb') as output:
            self.assertEqual((output.getframerate(), output.getsampwidth(), output.getnchannels()), (16000, 2, 1))
        derived.write_bytes(b'modified')
        with self.assertRaisesRegex(ValueError, 'differs'):
            prepare.prepare_files([source], target)
        self.assertEqual(derived.read_bytes(), b'modified')

    def test_invalid_input_leaves_no_partial_output(self):
        source = self.wav(rate=16000)
        target = self.root / 'derived'
        with self.assertRaises(ValueError):
            prepare.prepare_files([source], target)
        self.assertFalse(target.exists())


if __name__ == '__main__':
    unittest.main()
