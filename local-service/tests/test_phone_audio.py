import array
import hashlib
import io
import math
from pathlib import Path
import struct
import sys
import unittest
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import phone_audio
from test_dataset_prepare import pinned_runtime_available


def wav_bytes(rate=16000, samples=None):
    samples = [0] * (rate // 10) if samples is None else samples
    out = io.BytesIO()
    with wave.open(out, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack('<%dh' % len(samples), *samples))
    return out.getvalue()


class PhoneAudioTests(unittest.TestCase):
    def test_identity_preserves_samples_and_records_source_hash(self):
        data = wav_bytes(samples=[-32768, -1, 0, 1, 32767])
        output, meta = phone_audio.prepare(data)
        self.assertEqual(phone_audio.read_pcm(output), (16000, array.array('h', [-32768, -1, 0, 1, 32767])))
        self.assertEqual(meta['sourceSha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(meta['derivedSha256'], hashlib.sha256(output).hexdigest())
        self.assertEqual(meta['samples'], 5)
        self.assertEqual(meta['clippedSamples'], 0)

    def test_invalid_rate_empty_truncated_and_excess_duration_are_rejected(self):
        for data in (b'bad', wav_bytes(8000), wav_bytes(samples=[]), wav_bytes()[:-2],
                     wav_bytes(samples=[0] * 480001)):
            with self.subTest(size=len(data)), self.assertRaises(ValueError):
                phone_audio.read_pcm(data)

    def test_header_size_and_alignment_are_verified(self):
        for offset, fmt, value in ((4, '<I', 30), (28, '<I', 1), (32, '<H', 4), (40, '<I', 3199)):
            data = bytearray(wav_bytes())
            struct.pack_into(fmt, data, offset, value)
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                phone_audio.read_pcm(bytes(data))

    @unittest.skipUnless(pinned_runtime_available(), 'optional pinned numerical runtime')
    def test_native_rates_preserve_tone_duration_and_silence(self):
        for rate in (44100, 48000):
            with self.subTest(rate=rate):
                src = [round(12000 * math.sin(2 * math.pi * 1000 * i / rate)) for i in range(rate)]
                result, meta = phone_audio.prepare(wav_bytes(rate, src))
                _, samples = phone_audio.read_pcm(result)
                self.assertEqual(len(samples), 16000)
                error = max(abs(samples[i] - 12000 * math.sin(2 * math.pi * 1000 * i / 16000))
                            for i in range(40, 15960))
                self.assertLess(error, 80)
                self.assertEqual(meta['sourceSampleRate'], rate)
                output, _ = phone_audio.prepare(wav_bytes(rate, [0] * 441))
                self.assertTrue(all(x == 0 for x in phone_audio.read_pcm(output)[1]))

    @unittest.skipUnless(pinned_runtime_available(), 'optional pinned numerical runtime')
    def test_downsampling_suppresses_aliases_and_counts_clipping(self):
        rate = 48000
        src = [round(16000 * math.sin(2 * math.pi * 12000 * i / rate)) for i in range(rate)]
        output, _ = phone_audio.prepare(wav_bytes(rate, src))
        samples = phone_audio.read_pcm(output)[1]
        self.assertLess(max(abs(x) for x in samples[100:-100]), 100)
        output, meta = phone_audio.prepare(wav_bytes(rate, [32767] * 1000 + [-32768] * 1000))
        self.assertGreater(meta['clippedSamples'], 0)
        self.assertEqual(max(phone_audio.read_pcm(output)[1]), 32767)
