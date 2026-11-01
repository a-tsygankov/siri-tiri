from pathlib import Path
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
import csv
import json
import hashlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import review_store as review


class ReviewStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = review.ReviewStore(Path(self.tmp.name))
        main_ref, extra_ref = 'raw/dataset/F_MAG01_EU_FN_FED01_106.wav', 'raw/sequences/F_MAG01_EU_FN_FED01_1SEQ1.wav'
        for reference, content in ((main_ref, b'synthetic-main'), (extra_ref, b'synthetic-extra')):
            path = self.store.root / reference
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        self.main = review.inventory_record(main_ref, hashlib.sha256(b'synthetic-main').hexdigest(), {'MAG01': 'FED01'})
        self.extra = review.inventory_record(extra_ref, hashlib.sha256(b'synthetic-extra').hexdigest(), {'MAG01': 'FED01'})
        self.store.initialize([self.main, self.extra])

    def test_reference_is_not_human_review_and_extras_stay_unreviewed(self):
        data = self.store.snapshot()
        rows = {row['clipId']: row for row in data['clips']}
        self.assertEqual(data['target'], 'audible_meow')
        self.assertEqual(rows[self.main['clipId']]['effectiveLabel'], 'positive')
        self.assertEqual(rows[self.main['clipId']]['labelSource'], 'dataset_reference')
        self.assertEqual(rows[self.main['clipId']]['revision'], 0)
        self.assertIsNone(rows[self.extra['clipId']]['effectiveLabel'])
        self.assertEqual(rows[self.extra['clipId']]['reviewStatus'], 'unreviewed')
        self.assertEqual(self.main['catId'], self.extra['catId'])
        self.assertEqual(self.main['split'], self.extra['split'])

    def test_human_override_history_survives_reinitialization(self):
        self.store.label(self.main['clipId'], 'uncertain', 'reviewer-a', 0, 'ambiguous')
        self.store.label(self.main['clipId'], 'negative', 'reviewer-b', 1)
        self.store.initialize([self.extra, self.main])
        reopened = review.ReviewStore(self.store.root)
        row = next(row for row in reopened.snapshot()['clips'] if row['clipId'] == self.main['clipId'])
        self.assertEqual((row['effectiveLabel'], row['labelSource'], row['revision']), ('negative', 'human', 2))
        self.assertEqual([item['label'] for item in row['history']], ['uncertain', 'negative'])
        self.assertEqual(row['history'][0]['note'], 'ambiguous')
        self.assertEqual(row['referenceLabel'], 'positive')

    def test_conflicting_writers_do_not_overwrite_each_other(self):
        def attempt(label):
            try:
                self.store.label(self.extra['clipId'], label, 'reviewer', 0)
                return 'saved'
            except review.RevisionConflict:
                return 'conflict'
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertCountEqual(list(pool.map(attempt, ['positive', 'negative'])), ['saved', 'conflict'])
        row = next(row for row in self.store.snapshot()['clips'] if row['clipId'] == self.extra['clipId'])
        self.assertEqual(row['revision'], 1)
        self.assertEqual(len(row['history']), 1)

    def test_invalid_reviews_and_inventory_change_preserve_state(self):
        for args in [('bad', 'reviewer', 0, ''), ('positive', '', 0, ''), ('positive', 'r', True, ''),
                     ('positive', 'r', 0, 'x' * 513)]:
            with self.subTest(args=str(args)[:40]), self.assertRaises(ValueError):
                self.store.label(self.main['clipId'], *args)
        with self.assertRaises(ValueError):
            self.store.initialize([self.main])
        self.assertEqual(len(self.store.snapshot()['clips']), 2)
        self.assertTrue(all(row['revision'] == 0 for row in self.store.snapshot()['clips']))

    def test_unknown_group_is_not_assigned_a_split(self):
        unknown = review.inventory_record('raw/other_vocalizations/F_NEW01_EU_FN_FED01_101.wav', '3' * 64, {})
        self.assertFalse(unknown['groupResolved'])
        self.assertIsNone(unknown['split'])

    def test_exports_preserve_raw_json_and_escape_spreadsheet_cells(self):
        from review_artifacts import export_catalog
        self.store.label(self.extra['clipId'], 'uncertain', '=reviewer', 0, 'private local note')
        first = export_catalog(self.store.root / 'exports', self.store.snapshot())
        before = first.read_bytes()
        second = export_catalog(self.store.root / 'exports', self.store.snapshot())
        self.assertNotEqual(first, second)
        self.assertEqual(first.read_bytes(), before)
        rows = json.loads(before)['clips']
        self.assertEqual(next(row for row in rows if row['clipId'] == self.extra['clipId'])['reviewer'], '=reviewer')
        with first.with_suffix('.csv').open(newline='', encoding='utf-8') as source:
            rows = list(csv.DictReader(source))
        self.assertEqual(next(row for row in rows if row['clipId'] == self.extra['clipId'])['reviewer'], "'=reviewer")

    def test_owner_variants_are_preserved_and_flagged_without_splitting_a_cat(self):
        known = {'BAC01': {'SIM01', 'SIM10'}}
        first = review.inventory_record('raw/dataset/B_BAC01_MC_MN_SIM01_101.wav', '4' * 64, known)
        second = review.inventory_record('raw/dataset/I_BAC01_MC_MN_SIM10_101.wav', '5' * 64, known)
        self.assertTrue(first['groupResolved'])
        self.assertTrue(second['groupResolved'])
        self.assertEqual(first['split'], second['split'])
        self.assertIn('owner_id_varies_within_cat', first['metadataNotes'])
        self.assertEqual(second['ownerId'], 'SIM10')
        review.ReviewStore(self.store.root / 'owner-variants').initialize([first, second])

    def test_duplicate_audio_cannot_cross_cat_groups(self):
        duplicate = review.inventory_record('raw/other_vocalizations/B_ANI01_MC_FN_SIM01_101.wav', self.main['sourceSha256'], {'ANI01': 'SIM01'})
        store = review.ReviewStore(self.store.root / 'duplicate-audio')
        with self.assertRaisesRegex(ValueError, 'duplicate audio crosses groups'):
            store.initialize([self.main, duplicate])
        self.assertFalse(store.path.exists())

    def test_review_cannot_bind_a_label_to_changed_audio(self):
        (self.store.root / self.main['sourceRef']).write_bytes(b'changed audio')
        with self.assertRaisesRegex(ValueError, 'review source changed'):
            self.store.label(self.main['clipId'], 'negative', 'reviewer', 0)
        row = next(row for row in self.store.snapshot()['clips'] if row['clipId'] == self.main['clipId'])
        self.assertEqual(row['revision'], 0)
        self.assertEqual(row['effectiveLabel'], 'positive')


if __name__ == '__main__':
    unittest.main()
