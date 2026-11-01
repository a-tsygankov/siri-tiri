import json
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import service


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        service.DB_PATH = Path(self.tmp.name) / "test.db"
        service.init_db()

    def tearDown(self):
        self.tmp.cleanup()

    def event(self):
        return dict(schemaVersion=1, messageId=str(uuid.uuid4()), eventId=str(uuid.uuid4()),
                    sourceId="test", createdAt=datetime.now(timezone.utc).isoformat(),
                    type="review", payload={"context": "Unsure"})

    def test_deduplication_and_persistence(self):
        e = self.event()
        self.assertTrue(service.insert_event(e))
        self.assertFalse(service.insert_event(e))
        self.assertEqual(service.list_rows("messages"), [e])
        service.init_db()
        self.assertEqual(service.list_rows("messages"), [e])

    def test_reject_conflicting_duplicate(self):
        e = self.event()
        service.insert_event(e)
        e["payload"] = {"context": "Food"}
        with self.assertRaises(ValueError):
            service.insert_event(e)

    def test_validation(self):
        e = self.event()
        e["createdAt"] = "2026-11-01T10:00:00"
        with self.assertRaises(ValueError):
            service.insert_event(e)

    def test_logs(self):
        log = dict(schemaVersion=1, timestamp=datetime.now(timezone.utc).isoformat(),
                   level="WARN", component="local", eventName="sync.retry", message="Offline")
        service.insert_log(log)
        self.assertEqual(service.list_rows("logs"), [log])


if __name__ == "__main__":
    unittest.main()
