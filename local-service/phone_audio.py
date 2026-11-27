"""Versioned phone PCM conversion, independent of CatMeows and live-worker input."""
import array
import hashlib
import io
import math
import struct
import sys
import wave

VERSION = 'phone-pcm16-to16k-polyphase-kaiser5-v1'
RATES = (16000, 44100, 48000)
MAX_BYTES = 3 * 1024 * 1024


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_pcm(data):
    """Strict RIFF bounds and PCM format validation; returns mono native samples."""
    if not isinstance(data, bytes) or not 44 <= len(data) <= MAX_BYTES:
        raise ValueError('phone_audio_size_invalid')
    if data[:4] != b'RIFF' or data[8:12] != b'WAVE' or struct.unpack_from('<I', data, 4)[0] != len(data) - 8:
        raise ValueError('phone_wav_header_invalid')
    offset, fmt, pcm = 12, None, None
    while offset < len(data):
        if offset + 8 > len(data):
            raise ValueError('phone_wav_truncated')
        tag, size = struct.unpack_from('<4sI', data, offset)
        start, end = offset + 8, offset + 8 + size
        if end + (size % 2) > len(data):
            raise ValueError('phone_wav_truncated')
        if tag == b'fmt ':
            if fmt is not None or size < 16:
                raise ValueError('phone_wav_format_invalid')
            fmt = struct.unpack_from('<HHIIHH', data, start)
        elif tag == b'data':
            if pcm is not None or fmt is None:
                raise ValueError('phone_wav_data_invalid')
            pcm = data[start:end]
        offset = end + (size % 2)
    if fmt is None or pcm is None:
        raise ValueError('phone_wav_data_missing')
    encoding, channels, rate, byte_rate, align, bits = fmt
    if (encoding, channels, bits, align) != (1, 1, 16, 2) or rate not in RATES or byte_rate != rate * 2:
        raise ValueError('phone_audio_format_unsupported')
    if len(pcm) % 2 or not 1 <= len(pcm) // 2 <= rate * 30:
        raise ValueError('phone_audio_duration_invalid')
    samples = array.array('h')
    samples.frombytes(pcm)
    if sys.byteorder != 'little':
        samples.byteswap()
    return rate, samples


def convert(samples, rate):
    if rate not in RATES or not 1 <= len(samples) <= rate * 30:
        raise ValueError('phone_audio_duration_invalid')
    dependencies, clipped = {}, 0
    if rate == 16000:
        result = array.array('h', samples)
    else:
        import numpy as np
        import scipy
        from scipy.signal import resample_poly
        if np.__version__ != '2.2.6' or scipy.__version__ != '1.15.3':
            raise RuntimeError('phone_resampling_runtime_mismatch; run pinned setup')
        factor = math.gcd(rate, 16000)
        values = np.asarray(samples, dtype=np.float64)
        if (values.ndim != 1 or not np.isfinite(values).all() or (values < -32768).any()
                or (values > 32767).any() or (values != np.rint(values)).any()):
            raise ValueError('phone_samples_invalid')
        filtered = resample_poly(values / 32768, 16000 // factor, rate // factor,
                                 window=('kaiser', 5.0), padtype='constant', cval=0)
        rounded = np.rint(filtered * 32768)
        clipped = int(((rounded < -32768) | (rounded > 32767)).sum())
        result = array.array('h', np.clip(rounded, -32768, 32767).astype(np.int16).tolist())
        dependencies = dict(numpy=np.__version__, scipy=scipy.__version__)
    return result, dict(preparationVersion=VERSION, sourceSampleRate=rate, sourceSamples=len(samples),
                        sampleRate=16000, samples=len(result), clippedSamples=clipped, dependencies=dependencies)


def encode(samples):
    pcm = array.array('h', samples)
    if sys.byteorder != 'little':
        pcm.byteswap()
    out = io.BytesIO()
    with wave.open(out, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm.tobytes())
    return out.getvalue()


def prepare(data):
    rate, samples = read_pcm(data)
    converted, provenance = convert(samples, rate)
    output = encode(converted)
    provenance.update(sourceSha256=sha256(data), derivedSha256=sha256(output))
    return output, provenance
