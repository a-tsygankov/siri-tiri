import array
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import wave
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import model_assets
import inference


class InferenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def wav(self, values, channels=1, rate=16000, width=2):
        path = self.root / 'clip.wav'
        with wave.open(str(path), 'wb') as out:
            out.setnchannels(channels)
            out.setsampwidth(width)
            out.setframerate(rate)
            samples = array.array('h', values)
            if sys.byteorder != 'little':
                samples.byteswap()
            out.writeframes(samples.tobytes())
        return path

    def test_pcm_normalization_and_stereo_downmix(self):
        samples = inference.load_wav(self.wav([-32768, 32767, 0]))
        self.assertEqual(samples[0], -1)
        self.assertAlmostEqual(samples[1], 32767 / 32768)
        self.assertEqual(samples[2], 0)
        stereo = inference.load_wav(self.wav([-32768, 32767, 16384, 16384], channels=2))
        self.assertAlmostEqual(stereo[0], -1 / 65536)
        self.assertEqual(stereo[1], 0.5)

    def test_rejects_unsupported_empty_long_and_truncated_wav(self):
        for kwargs, values in (({'rate': 8000}, [0]), ({'width': 1}, [0]), ({}, []),
                               ({}, [0] * 480001)):
            with self.subTest(kwargs=kwargs, size=len(values)), self.assertRaises(inference.AudioError):
                inference.load_wav(self.wav(values, **kwargs))
        path = self.wav([1] * 100)
        path.write_bytes(path.read_bytes()[:-10])
        with self.assertRaises(inference.AudioError):
            inference.load_wav(path)

    def test_windows_cover_tail_without_extra_fully_covered_windows(self):
        self.assertEqual([len(x) for x in inference.windows([1.0])], [15600])
        self.assertEqual(len(list(inference.windows([0.] * 15600))), 1)
        result = list(inference.windows([1.] * 16000))
        self.assertEqual(len(result), 2)
        self.assertEqual(result[-1][8319], 1)
        self.assertEqual(result[-1][8320], 0)
        self.assertEqual(len(list(inference.windows([0.] * 23280))), 2)

    def test_audio_ref_is_confined_and_must_exist(self):
        path = self.wav([0])
        self.assertEqual(inference.resolve_audio(self.root, 'clip.wav'), path.resolve())
        for ref in ('../clip.wav', str(path.resolve()), 'https://example.com/a.wav', '', None, 'missing.wav'):
            with self.subTest(ref=ref), self.assertRaises(inference.AudioError):
                inference.resolve_audio(self.root, ref)
        # A resolved root escape must be caught even when spelled as a child path.
        with patch('inference.Path.resolve', side_effect=[self.root, self.root.parent / 'escape.wav']):
            with self.assertRaises(inference.AudioError):
                inference.resolve_audio(self.root, 'clip.wav')

    def test_model_download_is_verified_atomic_and_cached(self):
        data = b'TEST-MODEL'
        manifest = dict(url='https://example.com/model', size=len(data), sha256=hashlib.sha256(data).hexdigest())
        destination = self.root / 'model.tflite'
        response = io.BytesIO(data)
        response.geturl = lambda: manifest['url']
        with patch('model_assets.urlopen', return_value=response) as opener:
            model_assets.download(destination, manifest)
            self.assertEqual(destination.read_bytes(), data)
            model_assets.download(destination, manifest)
            self.assertEqual(opener.call_count, 1)
        destination.write_bytes(b'old-corrupt')
        bad = io.BytesIO(b'Z' * len(data))
        bad.geturl = lambda: manifest['url']
        with patch('model_assets.urlopen', return_value=bad), self.assertRaisesRegex(ValueError, 'checksum'):
            model_assets.download(destination, manifest)
        self.assertEqual(destination.read_bytes(), b'old-corrupt')
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['model.tflite'])


if __name__ == '__main__':
    unittest.main()
