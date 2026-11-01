from pathlib import Path
import sys
import tempfile
import unittest
import hashlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import dataset_prepare as prepare
import detector_features as features
import detector_rules as rules
import review_store as review
from review_artifacts import read_document


class DetectorRuleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = review.ReviewStore(self.root)
        cats = [f'TST{i:02}' for i in range(100)]
        calibration = [cat for cat in cats if prepare.split_for_cat(cat) == 'calibration'][:4]
        evaluation = [cat for cat in cats if prepare.split_for_cat(cat) == 'evaluation'][:4]
        self.records = []
        for index, cat in enumerate(calibration + evaluation):
            folder = 'dataset' if index % 4 < 2 else 'other_vocalizations'
            reference = f'raw/{folder}/F_{cat}_EU_FN_OWN01_101.wav'
            source = self.root / reference
            source.parent.mkdir(parents=True, exist_ok=True)
            content = ('synthetic fixture ' + str(index)).encode()
            source.write_bytes(content)
            self.records.append(review.inventory_record(reference, hashlib.sha256(content).hexdigest(), {cat: 'OWN01'}))
        self.store.initialize(self.records)
        for index in (2, 3, 6, 7):
            self.store.label(self.records[index]['clipId'], 'negative', 'synthetic-reviewer', 0)
        self.document = dict(schemaVersion=1, artifactType='detectorFeatures', target=review.TARGET,
                             inventoryFingerprint=self.store.snapshot()['inventoryFingerprint'], provenance=features.provenance(),
                             synthetic=True, rows=[dict(clipId=row['clipId'], sourceSha256=row['sourceSha256'],
                                                        status='scored', errorCode=None,
                                                        features=dict(meow_max=value, cat_or_meow_max=value))
                                                   for row, value in zip(self.records, [.8, .2, .7, .1] * 2)])

    def test_calibration_ignores_heldout_scores_and_labels(self):
        first = rules.calibrate(self.store.snapshot(), self.document)
        self.document['rows'][4]['features'] = dict(meow_max=.01, cat_or_meow_max=.01)
        self.store.label(self.records[4]['clipId'], 'uncertain', 'reviewer', 0)
        second = rules.calibrate(self.store.snapshot(), self.document)
        self.assertEqual(first['candidates'], second['candidates'])
        self.assertEqual(first['calibrationFingerprint'], second['calibrationFingerprint'])

    def test_explicit_freeze_and_heldout_confusion_counts(self):
        path = rules.freeze(self.store.snapshot(), self.document, 'meow_max', .5, self.root / 'rules')
        report = rules.evaluate(self.store.snapshot(), self.document, read_document(path))
        self.assertEqual(report['status'], 'evaluated')
        self.assertEqual(report['metrics']['confusion'], dict(tp=1, tn=1, fp=1, fn=1))
        self.assertEqual(report['metrics']['precision'], .5)
        self.assertEqual(report['metrics']['recall'], .5)
        self.assertEqual(report['metrics']['falsePositiveRate'], .5)
        self.assertTrue(report['synthetic'])

    def test_later_calibration_reviews_do_not_rewrite_frozen_evidence(self):
        path = rules.freeze(self.store.snapshot(), self.document, 'meow_max', .5, self.root / 'rules')
        original = path.read_bytes()
        self.store.label(self.records[0]['clipId'], 'uncertain', 'reviewer', 0)
        report = rules.evaluate(self.store.snapshot(), self.document, read_document(path))
        self.assertEqual(report['metrics']['confusion'], dict(tp=1, tn=1, fp=1, fn=1))
        self.assertEqual(path.read_bytes(), original)

    def test_missing_negative_uncertain_and_failed_features_block_freeze(self):
        for index in (2, 3):
            self.store.label(self.records[index]['clipId'], 'uncertain', 'reviewer', 1)
        summary = rules.calibrate(self.store.snapshot(), self.document)
        self.assertIn('negative_calibration_examples_required', summary['reasons'])
        self.assertEqual(summary['coverage']['excludedUncertain'], 2)
        with self.assertRaises(ValueError):
            rules.freeze(self.store.snapshot(), self.document, 'meow_max', .5, self.root / 'rules')
        self.assertFalse((self.root / 'rules').exists())

    def test_rule_corruption_and_leakage_are_rejected(self):
        path = rules.freeze(self.store.snapshot(), self.document, 'meow_max', .5, self.root / 'rules')
        rule = read_document(path)
        rule['threshold'] = .1
        with self.assertRaises(ValueError):
            rules.evaluate(self.store.snapshot(), self.document, rule)
        catalog = self.store.snapshot()
        next(row for row in catalog['clips'] if row['clipId'] == self.records[0]['clipId'])['split'] = 'evaluation'
        with self.assertRaises(ValueError):
            rules.calibrate(catalog, self.document)

    def test_evaluation_requires_class_coverage_and_never_counts_failures_as_negatives(self):
        path = rules.freeze(self.store.snapshot(), self.document, 'meow_max', .5, self.root / 'rules')
        for index in (6, 7):
            self.store.label(self.records[index]['clipId'], 'uncertain', 'reviewer', 1)
        report = rules.evaluate(self.store.snapshot(), self.document, read_document(path))
        self.assertEqual(report['status'], 'insufficient_evaluation_data')
        self.assertIsNone(report['metrics'])
        self.assertEqual(report['coverage']['excludedUncertain'], 2)
        self.document['rows'][4].update(status='failed', features=None, errorCode='source_audio_invalid')
        report = rules.evaluate(self.store.snapshot(), self.document, read_document(path))
        self.assertEqual(report['coverage']['failedEligible'], 1)

    def test_threshold_boundary_and_nonfinite_values(self):
        self.document['rows'][0]['features'] = dict(meow_max=.5, cat_or_meow_max=.5)
        report = rules.calibrate(self.store.snapshot(), self.document)
        at_half = next(item for item in report['candidates'] if item['score'] == 'meow_max' and item['threshold'] == .5)
        self.assertEqual(at_half['metrics']['confusion']['tp'], 1)
        for threshold in (float('nan'), float('inf'), -1, True):
            with self.assertRaises(ValueError):
                rules.freeze(self.store.snapshot(), self.document, 'meow_max', threshold, self.root / 'rules')

    def test_failed_calibration_features_block_freeze_despite_both_classes(self):
        self.document['rows'][0].update(status='failed', features=None, errorCode='source_audio_invalid')
        report = rules.calibrate(self.store.snapshot(), self.document)
        self.assertEqual((report['coverage']['positive'], report['coverage']['negative']), (2, 2))
        self.assertIn('eligible_features_incomplete', report['reasons'])
        self.assertEqual(report['candidates'], [])
        with self.assertRaises(ValueError):
            rules.freeze(self.store.snapshot(), self.document, 'meow_max', .5, self.root / 'rules')

    def test_failed_evaluation_features_block_metrics_despite_both_classes(self):
        path = rules.freeze(self.store.snapshot(), self.document, 'meow_max', .5, self.root / 'rules')
        self.document['rows'][4].update(status='failed', features=None, errorCode='source_audio_invalid')
        report = rules.evaluate(self.store.snapshot(), self.document, read_document(path))
        self.assertEqual((report['coverage']['positive'], report['coverage']['negative']), (2, 2))
        self.assertIn('eligible_features_incomplete', report['reasons'])
        self.assertIsNone(report['metrics'])


if __name__ == '__main__':
    unittest.main()
