import array
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dataset_evaluate as evaluate
import dataset_prepare as prepare
import inference
import model_assets


class Predictor:
    def analyze(self, samples):
        value = .8 if samples[0] == 0 else .2
        return dict(modelVersion=model_assets.MANIFEST['modelVersion'], modelSha256=model_assets.MANIFEST['sha256'],
                    preprocessingVersion=inference.PREPROCESSING_VERSION,
                    catScores=[dict(label=label, mean=value / 2, maximum=value) for label in inference.CAT_LABELS],
                    topClasses=[dict(label='Meow', mean=value / 2, maximum=value)])


class DatasetEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.derived = self.root / 'derived'
        (self.derived / 'audio').mkdir(parents=True)
        rows = []
        for name, value in [('F_MAG01_EU_FN_FED01_106.wav', 0), ('B_ANI01_MC_FN_SIM01_101.wav', 16384)]:
            path = self.derived / 'audio' / name
            prepare.write_wav(path, array.array('h', [value] * 160))
            metadata = prepare.parse_metadata(name)
            rows.append(dict(metadata, split=prepare.split_for_cat(metadata['catId']), sourceRef='raw/dataset/' + name,
                             sourceSha256='0' * 64, audioRef='audio/' + name, derivedSha256=prepare.digest(path),
                             sourceSampleRate=8000, sampleRate=16000, sourceSamples=80, samples=160,
                             durationSeconds=.01, clippedSamples=0))
        self.data = dict(schemaVersion=1, dataset='CatMeows', datasetVersion='1.0.2', datasetSource='https://zenodo.org/records/4008297',
                         preparationVersion=prepare.VERSION, splitVersion=prepare.SPLIT_VERSION,
                         dependencies=dict(scipy='1.15.3', numpy='2.2.6'), sampleCount=2, clips=rows)
        self.manifest = self.derived / 'manifest.json'
        self.save()

    def save(self):
        self.manifest.write_text(json.dumps(self.data), encoding='utf-8')

    def report(self, predictor=None, limit=None):
        path = evaluate.evaluate(self.manifest, self.root / 'reports', predictor or Predictor(), limit)
        return path, json.loads(path.read_text(encoding='utf-8'))

    def test_scores_report_positive_detection_without_negative_metrics(self):
        path, report = self.report()
        self.assertEqual((report['selectedCount'], report['scoredCount'], report['failedCount']), (2, 2, 0))
        self.assertEqual(report['diagnosticThresholds']['0.5']['detected'], 1)
        self.assertEqual(report['diagnosticThresholds']['0.5']['positiveDetectionRateOnScored'], .5)
        self.assertIsNone(report['falsePositiveRate'])
        self.assertIsNone(report['precision'])
        self.assertIsNone(report['selectedThreshold'])
        self.assertTrue((path.parent / 'clips.csv').is_file())
        self.assertEqual(report['sourcePreparationVersion'], prepare.VERSION)
        self.assertEqual(report['inferencePreprocessingVersion'], inference.PREPROCESSING_VERSION)
        self.assertEqual(len(report['clips']), 2)
        self.assertEqual(report['clips'][0]['datasetContext'], 'waiting_for_food')
        self.assertGreaterEqual(report['latencyMs']['all']['minimum'], 0)

    def test_corrupt_clip_is_counted_not_silently_omitted(self):
        row = self.data['clips'][0]
        (self.derived / row['audioRef']).write_bytes(b'corrupt')
        _, report = self.report()
        self.assertEqual((report['scoredCount'], report['failedCount']), (1, 1))
        self.assertEqual(report['clips'][0]['errorCode'], 'derived_checksum_mismatch')
        self.assertEqual(report['diagnosticThresholds']['0.5']['scoredPositiveClips'], 1)
        self.assertFalse(report['complete'])
        self.assertEqual(report['latencyMs']['firstInference']['clipId'], self.data['clips'][1]['clipId'])
        self.assertIsNone(report['latencyMs']['afterFirst'])

    def test_manifest_rejects_escapes_duplicates_inconsistent_metadata_and_versions(self):
        for mutation in ('path', 'duplicate', 'split', 'context', 'version', 'count'):
            original = json.loads(json.dumps(self.data))
            if mutation == 'path':
                self.data['clips'][0]['audioRef'] = '../private.wav'
            elif mutation == 'duplicate':
                self.data['clips'][1] = self.data['clips'][0]
            elif mutation == 'split':
                self.data['clips'][0]['split'] = 'other'
            elif mutation == 'context':
                self.data['clips'][0]['datasetContext'] = 'hungry'
            elif mutation == 'version':
                self.data['preparationVersion'] = 'unknown'
            else:
                self.data['sampleCount'] = True
            self.save()
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.report()
            self.assertFalse((self.root / 'reports').exists())
            self.data = original

    def test_invalid_predictor_result_is_failure_and_reports_are_not_overwritten(self):
        class BadPredictor:
            def analyze(self, samples):
                result = Predictor().analyze(samples)
                result['catScores'][0]['maximum'] = float('nan')
                return result
        path, report = self.report(BadPredictor())
        self.assertEqual(report['failedCount'], 2)
        self.assertEqual(report['clips'][0]['errorCode'], 'inference_result_invalid')
        self.assertIsNone(report['latencyMs']['all'])
        next_path, _ = self.report()
        self.assertNotEqual(path, next_path)
        self.assertTrue(path.is_file())

    def test_limit_is_labeled_and_invalid_limits_are_rejected(self):
        _, report = self.report(limit=1)
        self.assertEqual((report['manifestCount'], report['selectedCount']), (2, 1))
        self.assertTrue(report['subset'])
        for limit in (0, -1, True):
            with self.assertRaises(ValueError):
                self.report(limit=limit)

    def test_manifest_checksum_identifies_the_snapshot_actually_used(self):
        before = prepare.digest(self.manifest)
        path = self.manifest
        class UpdatingPredictor:
            def analyze(self, samples):
                path.write_text('{"edited": true}', encoding='utf-8')
                return Predictor().analyze(samples)
        _, report = self.report(UpdatingPredictor())
        self.assertEqual(report['manifestSha256'], before)
        self.assertEqual(report['scoredCount'], 2)


if __name__ == '__main__':
    unittest.main()
