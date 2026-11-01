from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import detector_features as features
import review_store as review


class DetectorFeatureTests(unittest.TestCase):
    def test_provenance_and_source_identity_are_required(self):
        row = review.inventory_record('raw/dataset/F_MAG01_EU_FN_FED01_106.wav', '1' * 64, {'MAG01': 'FED01'})
        with tempfile.TemporaryDirectory() as tmp:
            store = review.ReviewStore(tmp)
            store.initialize([row])
            catalog = store.snapshot()
            document = dict(schemaVersion=1, artifactType='detectorFeatures', target=review.TARGET,
                            inventoryFingerprint=catalog['inventoryFingerprint'], provenance=features.provenance(),
                            synthetic=True, rows=[dict(clipId=row['clipId'], sourceSha256='1' * 64, status='scored',
                                                       features=dict(meow_max=.2, cat_or_meow_max=.4), errorCode=None)])
            features.validate(document, catalog)
            document['rows'][0]['sourceSha256'] = '2' * 64
            with self.assertRaises(ValueError):
                features.validate(document, catalog)
            document['rows'][0]['sourceSha256'] = '1' * 64
            document['provenance']['classMapSha256'] = '0' * 64
            with self.assertRaises(ValueError):
                features.validate(document, catalog)

    def test_bad_audio_is_explicit_failure_without_optional_runtime(self):
        row = review.inventory_record('raw/dataset/F_MAG01_EU_FN_FED01_106.wav', '1' * 64, {'MAG01': 'FED01'})
        with tempfile.TemporaryDirectory() as tmp:
            store = review.ReviewStore(tmp)
            store.initialize([row])
            path = features.score_catalog(store.snapshot(), Path(tmp), predictor=object())
            from review_artifacts import read_document
            data = read_document(path)
            self.assertEqual(data['rows'][0]['status'], 'failed')
            self.assertEqual(data['rows'][0]['errorCode'], 'source_audio_invalid')
            self.assertTrue(data['synthetic'])


if __name__ == '__main__':
    unittest.main()
