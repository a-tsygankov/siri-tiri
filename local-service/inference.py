"""Local PCM WAV preprocessing and optional CPU YAMNet classification."""
import array
from pathlib import Path
import sys
import wave

import model_assets

PREPROCESSING_VERSION = 'pcm16-16k-mono-window15600-hop7680-v1'
WINDOW = 15600
HOP = 7680
CAT_LABELS = ('Cat', 'Meow', 'Purr', 'Hiss', 'Caterwaul')


class AudioError(ValueError):
    pass


def resolve_audio(root, reference):
    if not isinstance(reference, str) or not reference or ':' in reference or '\\' in reference:
        raise AudioError('audio_reference_invalid')
    relative = Path(reference)
    if relative.is_absolute() or '..' in relative.parts:
        raise AudioError('audio_reference_invalid')
    base = Path(root).resolve()
    path = (base / relative).resolve()
    if path == base or not path.is_relative_to(base) or path.suffix.lower() != '.wav':
        raise AudioError('audio_reference_invalid')
    if not path.is_file():
        raise AudioError('audio_not_found')
    return path


def load_wav(path):
    try:
        if Path(path).stat().st_size > 3000000:
            raise AudioError('audio_too_large')
        with wave.open(str(path), 'rb') as source:
            channels, width, rate, frames = source.getnchannels(), source.getsampwidth(), source.getframerate(), source.getnframes()
            if channels not in (1, 2) or width != 2 or rate != 16000 or source.getcomptype() != 'NONE':
                raise AudioError('audio_format_unsupported')
            if not 1 <= frames <= 480000:
                raise AudioError('audio_duration_invalid')
            raw = source.readframes(frames)
            if len(raw) != frames * channels * 2:
                raise AudioError('audio_truncated')
        integers = array.array('h')
        integers.frombytes(raw)
        if sys.byteorder != 'little':
            integers.byteswap()
        if channels == 1:
            return array.array('f', (value / 32768 for value in integers))
        return array.array('f', ((integers[i] + integers[i + 1]) / 65536 for i in range(0, len(integers), 2)))
    except AudioError:
        raise
    except (OSError, EOFError, wave.Error, ValueError):
        raise AudioError('audio_unreadable') from None


def windows(samples):
    if not len(samples):
        raise AudioError('audio_duration_invalid')
    offset = 0
    while True:
        window = array.array('f', samples[offset:offset + WINDOW])
        window.extend([0.] * (WINDOW - len(window)))
        yield window
        if offset + WINDOW >= len(samples):
            break
        offset += HOP


class Yamnet:
    def __init__(self, model_path=model_assets.MODEL_PATH):
        model_assets.verify(model_path)
        self.labels = model_assets.labels(model_path)
        # Optional dependencies: the API and ordinary unit tests do not import them.
        import numpy as np
        from ai_edge_litert.interpreter import Interpreter
        self.np = np
        self.model = Interpreter(model_path=str(model_path), num_threads=2)
        self.model.allocate_tensors()
        inputs, outputs = self.model.get_input_details(), self.model.get_output_details()
        if len(inputs) != 1 or inputs[0]['shape'].tolist() != [WINDOW] or inputs[0]['dtype'] != np.float32:
            raise ValueError('model_input_invalid')
        if len(outputs) != 1 or outputs[0]['shape'].tolist() != [1, 521]:
            raise ValueError('model_output_invalid')
        self.input_index, self.output_index = inputs[0]['index'], outputs[0]['index']

    def analyze(self, samples):
        np = self.np
        scores = []
        for window in windows(samples):
            self.model.set_tensor(self.input_index, np.asarray(window, dtype=np.float32))
            self.model.invoke()
            scores.append(self.model.get_tensor(self.output_index)[0].copy())
        values = np.stack(scores)
        if not np.isfinite(values).all() or (values < 0).any() or (values > 1).any():
            raise ValueError('model_scores_invalid')
        mean, maximum = values.mean(axis=0), values.max(axis=0)
        def score(index):
            return dict(label=self.labels[index], mean=float(mean[index]), maximum=float(maximum[index]))
        return dict(modelVersion=model_assets.MANIFEST['modelVersion'], preprocessingVersion=PREPROCESSING_VERSION,
                    modelSha256=model_assets.MANIFEST['sha256'], sampleRate=16000,
                    durationSeconds=len(samples) / 16000, windows=len(scores),
                    catScores=[score(self.labels.index(label)) for label in CAT_LABELS],
                    topClasses=[score(int(i)) for i in np.argsort(mean)[-5:][::-1]])
