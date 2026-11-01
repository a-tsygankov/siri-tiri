import array
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import uuid
import wave
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import jobs
import service
import worker


class StoreClient:
    """Real job store with controllable loss of an HTTP response after commit."""
    def __init__(self, lose_ack=False):
        self.lose_ack = lose_ack

    def post(self, path, body):
        try:
            if path.endswith('/claim'):
                job = jobs.claim(service.connect, body)
            else:
                _, _, _, job_id, action = path.split('/')
                job = getattr(jobs, action)(service.connect, job_id, body)
            if path.endswith('/ack') and self.lose_ack:
                self.lose_ack = False
                raise worker.TransportError()
            return dict(schemaVersion=1, job=job)
        except jobs.Conflict:
            raise worker.LeaseLost() from None


class Model:
    def analyze(self, samples):
        return dict(modelVersion='test-model', preprocessingVersion='test-pcm', samples=len(samples))


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        old = service.DB_PATH
        self.addCleanup(setattr, service, 'DB_PATH', old)
        service.DB_PATH = self.root / 'test.db'
        service.init_db()
        with wave.open(str(self.root / 'test.wav'), 'wb') as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(16000)
            out.writeframes(array.array('h', [0] * 16000).tobytes())

    def capture(self, ref='test.wav'):
        event = dict(schemaVersion=1, messageId=str(uuid.uuid4()), eventId=str(uuid.uuid4()), sourceId='test',
                     createdAt='2026-11-01T00:00:00Z', type='capture', payload={'audioRef': ref})
        service.insert_event(event)

    def test_real_job_completes_after_lost_ack_response(self):
        self.capture()
        run = worker.Worker(StoreClient(lose_ack=True), Model(), self.root, retry_seconds=0)
        self.assertTrue(run.run_once())
        row = jobs.list_jobs(service.connect)[0]
        self.assertEqual(row['state'], 'completed')
        self.assertEqual(row['result']['samples'], 16000)
        self.assertEqual(row['attempts'], 1)

    def test_bad_audio_is_retried_with_stable_error_code(self):
        self.capture('../private.wav')
        run = worker.Worker(StoreClient(), Model(), self.root)
        self.assertTrue(run.run_once())
        row = jobs.list_jobs(service.connect)[0]
        self.assertEqual(row['state'], 'pending')
        self.assertEqual(row['errorCode'], 'audio_reference_invalid')
        self.assertIsNone(row['result'])

    def test_reclaimed_job_rejects_stale_inference_result(self):
        self.capture()
        clock = patch('jobs.now_ms', return_value=1000000)
        now = clock.start()
        self.addCleanup(clock.stop)
        with service.connect() as db:
            db.execute('UPDATE jobs SET available_at=0')
        class SlowModel:
            def analyze(self, samples):
                now.return_value += 60000
                jobs.claim(service.connect, dict(schemaVersion=1, workerId='replacement'))
                return Model().analyze(samples)
        run = worker.Worker(StoreClient(), SlowModel(), self.root)
        self.assertTrue(run.run_once())
        row = jobs.list_jobs(service.connect)[0]
        self.assertEqual(row['workerId'], 'replacement')
        self.assertEqual(row['state'], 'leased')
        self.assertIsNone(row['result'])

    def test_client_refuses_nonloopback_addresses(self):
        for host in ('example.com', '0.0.0.0', '192.168.1.1'):
            with self.assertRaises(ValueError):
                worker.Client(host=host)

    def test_renewal_extends_persisted_lease_for_current_worker(self):
        self.capture()
        run = worker.Worker(StoreClient(), Model(), self.root)
        with patch('jobs.now_ms', return_value=1000000) as now:
            with service.connect() as db:
                db.execute('UPDATE jobs SET available_at=0')
            job = jobs.claim(service.connect, dict(schemaVersion=1, workerId=run.worker_id))
            now.return_value += 10000
            class Finished:
                calls = 0
                def wait(self, seconds):
                    self.calls += 1
                    return self.calls > 1
            lost = threading.Event()
            run.renew(job, Finished(), lost)
            self.assertFalse(lost.is_set())
            self.assertEqual(jobs.list_jobs(service.connect)[0]['leaseExpiresAt'], '1970-01-01T00:17:50.000Z')


if __name__ == '__main__':
    unittest.main()
