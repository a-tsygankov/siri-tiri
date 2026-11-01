import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import manage


class ManageTests(unittest.TestCase):
    def test_paths_do_not_depend_on_caller_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = subprocess.run([sys.executable, '-B', str(manage.ROOT / 'manage.py'), 'paths'],
                                 cwd=tmp, capture_output=True, text=True, timeout=10)
            self.assertEqual(run.returncode, 0, run.stderr)
            paths = json.loads(run.stdout)
            self.assertEqual(Path(paths['root']), manage.ROOT)
            self.assertTrue(Path(paths['python']).is_absolute())

    def test_busy_port_does_not_initialize_or_change_database(self):
        with tempfile.TemporaryDirectory() as tmp, socket.socket() as held:
            held.bind(('127.0.0.1', 0))
            held.listen()
            database = Path(tmp) / 'untouched.db'
            with patch('manage.PYTHON', Path(tmp) / 'missing.exe'), self.assertRaisesRegex(RuntimeError, 'port_in_use'):
                manage.run_stack(held.getsockname()[1], database, Path(tmp))
            self.assertFalse(database.exists())

    def test_child_cleanup_does_not_kill_unrelated_process(self):
        owned = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        try:
            manage.stop_children([owned])
            self.assertIsNotNone(owned.poll())
            self.assertIsNone(unrelated.poll())
        finally:
            manage.stop_children([owned, unrelated])


if __name__ == '__main__':
    unittest.main()
