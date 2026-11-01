from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import catmeows
import manage


class CatMeowsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def archive(self, entries):
        path = self.root / 'test.zip'
        with zipfile.ZipFile(path, 'w') as archive:
            for name, content in entries:
                if isinstance(name, str):
                    member = zipfile.ZipInfo(name)
                    member.filename = name  # Preserve hostile backslashes on Windows.
                    name = member
                archive.writestr(name, content)
        return path

    def test_extract_preserves_archive_paths_and_is_repeatable(self):
        path = self.archive([('dataset/clip.wav', b'example'), ('extras/clip.wav', b'other')])
        target = self.root / 'raw'
        catmeows.extract([path], target)
        self.assertEqual((target / 'dataset/clip.wav').read_bytes(), b'example')
        catmeows.extract([path], target)
        (target / 'dataset/clip.wav').write_bytes(b'modified')
        with self.assertRaisesRegex(ValueError, 'differs'):
            catmeows.extract([path], target)
        self.assertEqual((target / 'dataset/clip.wav').read_bytes(), b'modified')

    def test_rejects_unsafe_archives_without_partial_destination(self):
        for name in ('../escape.wav', '/absolute.wav', 'C:/drive.wav', 'a\\escape.wav'):
            with self.subTest(name=name):
                path = self.archive([('dataset/okay.wav', b'okay'), (name, b'bad')])
                target = self.root / 'raw'
                with self.assertRaises(ValueError):
                    catmeows.extract([path], target)
                self.assertFalse(target.exists())
                self.assertFalse((self.root / 'escape.wav').exists())

    def test_rejects_symlinks_and_duplicate_members(self):
        link = zipfile.ZipInfo('dataset/link.wav')
        link.create_system = 3
        link.external_attr = 0o120777 << 16
        path = self.archive([(link, b'../outside')])
        with self.assertRaises(ValueError):
            catmeows.extract([path], self.root / 'raw')
        path = self.archive([('dataset/a.wav', b'a'), ('dataset/A.wav', b'b')])
        with self.assertRaises(ValueError):
            catmeows.extract([path], self.root / 'raw')

    def test_command_resolves_default_destination_from_checkout(self):
        self.assertEqual(catmeows.DESTINATION, manage.REPO / 'CatMeows')


if __name__ == '__main__':
    unittest.main()
