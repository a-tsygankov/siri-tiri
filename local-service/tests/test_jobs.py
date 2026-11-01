import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import service
import jobs


class JobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        old_path = service.DB_PATH
        self.addCleanup(setattr, service, 'DB_PATH', old_path)
        service.DB_PATH = Path(self.tmp.name) / 'jobs.db'
        self.clock = patch('jobs.now_ms', return_value=1000000)
        self.now = self.clock.start()
        self.addCleanup(self.clock.stop)
        service.init_db()

    def capture(self, kind='capture'):
        event = dict(schemaVersion=1, messageId=str(uuid.uuid4()), eventId=str(uuid.uuid4()),
                     correlationId=str(uuid.uuid4()), sourceId='test-device',
                     createdAt=datetime.now(timezone.utc).isoformat(), type=kind,
                     payload={'audioRef': 'local-test-clip'})
        service.insert_event(event)
        return event

    def claim(self, worker='worker-a', seconds=60):
        return jobs.claim(service.connect, dict(schemaVersion=1, workerId=worker, leaseSeconds=seconds))

    def owned(self, job, **extra):
        return dict(schemaVersion=1, workerId=job['workerId'], leaseToken=job['leaseToken'], **extra)

    def result(self):
        return dict(modelVersion='synthetic-1', preprocessingVersion='test-1', scores={'Cat': 0.7})

    def test_capture_enqueue_is_durable_and_idempotent(self):
        event = self.capture()
        self.assertFalse(service.insert_event(event))
        for kind in ('review', 'analysis', 'heartbeat', 'update_status'):
            self.capture(kind)
        service.init_db()
        listing = jobs.list_jobs(service.connect)
        self.assertEqual(len(listing), 1)
        self.assertEqual(listing[0]['jobId'], event['messageId'])
        self.assertEqual(listing[0]['state'], 'pending')
        self.assertNotIn('leaseToken', listing[0])
        claimed = self.claim()
        self.assertEqual(claimed['event'], event)
        self.assertEqual(claimed['attempts'], 1)
        self.assertIsNone(self.claim('worker-b'))

    def test_enqueue_failure_rolls_back_accepted_message(self):
        with service.connect() as db:
            db.execute("CREATE TRIGGER reject_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'test'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.capture()
        self.assertEqual(service.list_rows('messages'), [])

    def test_migration_backfills_existing_captures_once(self):
        event = self.capture()
        self.capture('review')
        with service.connect() as db:
            db.execute('DROP TABLE jobs')
            db.execute('DELETE FROM schema_migrations WHERE version=2')
        service.init_db()
        self.assertEqual(self.claim()['event'], event)
        service.init_db()
        self.assertEqual(jobs.list_jobs(service.connect)[0]['attempts'], 1)
        with service.connect() as db:
            self.assertEqual([r[0] for r in db.execute('SELECT version FROM schema_migrations ORDER BY version')], [1, 2])

    def test_newer_schema_is_rejected_without_modification(self):
        with service.connect() as db:
            db.execute("INSERT INTO schema_migrations VALUES (99, 'future')")
        with self.assertRaisesRegex(RuntimeError, 'newer'):
            service.init_db()
        with service.connect() as db:
            self.assertEqual(db.execute('SELECT max(version) FROM schema_migrations').fetchone()[0], 99)

    def test_failed_migration_rolls_back_ddl(self):
        with service.connect() as db:
            db.execute('DROP TABLE jobs')
            db.execute('DELETE FROM schema_migrations WHERE version=2')
        with patch('jobs.enqueue', side_effect=RuntimeError('migration failure')):
            # A legacy capture to exercise the backfill inside the migration.
            event = dict(schemaVersion=1, messageId=str(uuid.uuid4()), eventId=str(uuid.uuid4()),
                         sourceId='old', createdAt='2026-11-01T00:00:00Z', type='capture')
            with service.connect() as db:
                db.execute('INSERT INTO messages VALUES (?,?,?,?,?,?,?)',
                           (event['messageId'], event['eventId'], 'old', event['createdAt'],
                            'capture', json.dumps(event), event['createdAt']))
            with self.assertRaisesRegex(RuntimeError, 'migration failure'):
                service.init_db()
        with service.connect() as db:
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='jobs'").fetchone())
            self.assertEqual(db.execute('SELECT max(version) FROM schema_migrations').fetchone()[0], 1)
        service.init_db()
        self.assertEqual(self.claim()['event'], event)

    def test_heartbeat_extends_lease_and_stale_owner_is_rejected(self):
        self.capture()
        job = self.claim(seconds=1)
        self.now.return_value += 500
        updated = jobs.heartbeat(service.connect, job['jobId'], self.owned(job, leaseSeconds=2))
        self.assertEqual(updated['leaseExpiresAt'], '1970-01-01T00:16:42.500Z')
        self.now.return_value = 1002500
        with self.assertRaises(jobs.Conflict):
            jobs.heartbeat(service.connect, job['jobId'], self.owned(job))
        reclaimed = self.claim('worker-b')
        self.assertNotEqual(reclaimed['leaseToken'], job['leaseToken'])
        self.assertEqual(reclaimed['attempts'], 2)
        for operation, extra in ((jobs.heartbeat, {}), (jobs.ack, {'result': self.result()}),
                                 (jobs.fail, {'errorCode': 'inference_failed'})):
            with self.subTest(operation=operation.__name__), self.assertRaises(jobs.Conflict):
                operation(service.connect, job['jobId'], self.owned(job, **extra))

    def test_ack_is_durable_idempotent_and_preserves_reviews(self):
        self.capture()
        review = self.capture('review')
        job = self.claim()
        body = self.owned(job, result=self.result())
        completed = jobs.ack(service.connect, job['jobId'], body)
        self.assertEqual(completed['state'], 'completed')
        service.init_db()
        self.now.return_value += 1000000
        self.assertEqual(jobs.ack(service.connect, job['jobId'], body), completed)
        body['result']['scores']['Cat'] = 0.2
        with self.assertRaises(jobs.Conflict):
            jobs.ack(service.connect, job['jobId'], body)
        self.assertIsNone(self.claim())
        self.assertIn(review, service.list_rows('messages'))
        self.assertEqual(jobs.list_jobs(service.connect)[0]['result']['scores']['Cat'], 0.7)

    def test_expired_lease_cannot_ack_before_reclaim(self):
        self.capture()
        job = self.claim(seconds=1)
        self.now.return_value += 1000
        with self.assertRaises(jobs.Conflict):
            jobs.ack(service.connect, job['jobId'], self.owned(job, result=self.result()))

    def test_fail_backoff_and_attempt_limit_survive_restart(self):
        self.capture()
        for attempt in range(1, 6):
            job = self.claim()
            self.assertEqual(job['attempts'], attempt)
            before = self.now.return_value
            failed = jobs.fail(service.connect, job['jobId'], self.owned(job, errorCode='test_error'))
            self.assertEqual(failed['errorCode'], 'test_error')
            service.init_db()
            self.assertIsNone(self.claim())
            if attempt < 5:
                with service.connect() as db:
                    available = db.execute('SELECT available_at FROM jobs').fetchone()[0]
                self.assertGreaterEqual(available - before, 1000)
                self.assertLessEqual(available - before, 60000)
                self.now.return_value = available
            else:
                self.assertEqual(failed['state'], 'failed')

    def test_exhausted_expired_job_is_swept_without_blocking_other_work(self):
        self.capture()
        for _ in range(5):
            job = self.claim(seconds=1)
            self.now.return_value += 1000
        other = self.capture()
        self.assertEqual(self.claim()['jobId'], other['messageId'])
        states = {j['jobId']: j['state'] for j in jobs.list_jobs(service.connect)}
        self.assertEqual(states[job['jobId']], 'failed')

    def test_validation_rejects_bad_types_bounds_results_and_unknown_jobs(self):
        for body in ([], {}, {'schemaVersion': True, 'workerId': 'x'},
                     {'schemaVersion': 1, 'workerId': ''}, {'schemaVersion': 1, 'workerId': 3},
                     {'schemaVersion': 1, 'workerId': 'x', 'leaseSeconds': True},
                     {'schemaVersion': 1, 'workerId': 'x', 'leaseSeconds': 901}):
            with self.subTest(body=body), self.assertRaises(ValueError):
                jobs.claim(service.connect, body)
        self.capture()
        job = self.claim()
        for result in ({}, {'modelVersion': 'x', 'preprocessingVersion': 'y', 'x': float('nan')},
                       {'modelVersion': 'x', 'preprocessingVersion': 'y', 'x': 'a' * 33000}):
            with self.subTest(result=str(result)[:80]), self.assertRaises(ValueError):
                jobs.ack(service.connect, job['jobId'], self.owned(job, result=result))
        with self.assertRaises(jobs.NotFound):
            jobs.heartbeat(service.connect, str(uuid.uuid4()), self.owned(job))

    def test_independent_processes_claim_once_and_recover_after_worker_exit(self):
        event = self.capture()
        script = '''import json, os, sys
from pathlib import Path
import service, jobs
service.DB_PATH = Path(sys.argv[1])
jobs.now_ms = lambda: 1000000
job = jobs.claim(service.connect, dict(schemaVersion=1, workerId=sys.argv[2], leaseSeconds=1))
print(json.dumps(job), flush=True)
os._exit(0)
'''
        def run(worker):
            completed = subprocess.run([sys.executable, '-B', '-c', script, str(service.DB_PATH), worker],
                                       cwd=Path(service.__file__).parent, capture_output=True, text=True, timeout=20)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            return json.loads(completed.stdout)
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(run, ['a', 'b', 'c', 'd']))
        claimed = [job for job in results if job is not None]
        self.assertEqual(len(claimed), 1)
        self.assertEqual(claimed[0]['jobId'], event['messageId'])
        service.init_db()
        self.assertIsNone(self.claim())
        self.now.return_value += 1000
        recovered = self.claim()
        self.assertEqual(recovered['attempts'], 2)
        self.assertNotEqual(recovered['leaseToken'], claimed[0]['leaseToken'])


if __name__ == '__main__':
    unittest.main()
