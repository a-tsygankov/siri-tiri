import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import service


class QuietHandler(service.Handler):
    def log_message(self, *args):
        pass


class JobHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_path = service.DB_PATH
        service.DB_PATH = Path(self.tmp.name) / 'http.db'
        service.init_db()
        self.server = service.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        service.DB_PATH = self.old_path
        self.tmp.cleanup()

    def send(self, method, path, body=None, raw=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            data = raw if raw is not None else json.dumps(body) if body is not None else None
            connection.request(method, path, body=data, headers=headers or {'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def capture(self):
        event = dict(schemaVersion=1, messageId=str(uuid.uuid4()), eventId=str(uuid.uuid4()),
                     sourceId='http-test', createdAt='2026-11-01T00:00:00Z', type='capture', payload={})
        self.assertEqual(self.send('POST', '/events', event)[0], 201)
        return event

    def claim(self):
        status, body = self.send('POST', '/v1/jobs/claim', dict(schemaVersion=1, workerId='http-worker'))
        self.assertEqual(status, 200)
        self.assertEqual(body['schemaVersion'], 1)
        return body['job']

    def test_http_lifecycle_and_legacy_endpoints(self):
        self.assertIsNone(self.claim())
        event = self.capture()
        job = self.claim()
        self.assertEqual(job['event'], event)
        path = '/v1/jobs/' + job['jobId']
        owned = dict(schemaVersion=1, workerId='http-worker', leaseToken=job['leaseToken'])
        status, body = self.send('POST', path + '/heartbeat', dict(owned, leaseSeconds=120))
        self.assertEqual(status, 200)
        self.assertEqual(body['job']['state'], 'leased')
        result = dict(modelVersion='synthetic-1', preprocessingVersion='test-1', scores={'Cat': 0.8})
        ack = dict(owned, result=result)
        status, completed = self.send('POST', path + '/ack', ack)
        self.assertEqual(status, 200)
        self.assertEqual(completed['job']['result'], result)
        self.assertEqual(self.send('POST', path + '/ack', ack), (status, completed))
        listing = self.send('GET', '/v1/jobs?limit=1')[1]['items']
        self.assertNotIn('leaseToken', listing[0])
        self.assertNotIn('event', listing[0])
        self.assertEqual(self.send('GET', '/events')[1]['items'], [event])
        self.assertEqual(self.send('GET', '/health')[1]['status'], 'ok')
        self.assertEqual(self.send('GET', '/version')[1], dict(version='0.2.0', protocol=1, sqliteSchema=2))

    def test_http_rejects_invalid_missing_and_conflicting_requests(self):
        self.capture()
        job = self.claim()
        path = '/v1/jobs/' + job['jobId']
        owned = dict(schemaVersion=1, workerId='http-worker', leaseToken=job['leaseToken'])
        self.assertEqual(self.send('POST', path + '/heartbeat', dict(owned, workerId='other'))[0], 409)
        self.assertEqual(self.send('POST', '/v1/jobs/' + str(uuid.uuid4()) + '/heartbeat', owned)[0], 404)
        for body in ([], {}, dict(schemaVersion=True, workerId='x'),
                     dict(schemaVersion=1, workerId='x', leaseSeconds=0),
                     dict(schemaVersion=1, workerId='x', extra='unsupported')):
            with self.subTest(body=body):
                self.assertEqual(self.send('POST', '/v1/jobs/claim', body)[0], 400)
        for raw in ('{', '{"schemaVersion":1,"workerId":"x","leaseSeconds":NaN}', '[' * 2000):
            self.assertEqual(self.send('POST', '/v1/jobs/claim', raw=raw)[0], 400)
        self.assertEqual(self.send('POST', path + '/ack', dict(owned, result={}))[0], 400)
        self.assertEqual(self.send('POST', path + '/fail', dict(owned, errorCode='private exception text'))[0], 400)
        self.assertEqual(self.send('POST', path + '/heartbeat', raw='x' * 65537)[0], 413)
        self.assertEqual(self.send('POST', '/v1/jobs/not-a-uuid/heartbeat', owned)[0], 400)
        self.assertEqual(self.send('POST', path + '/unknown', owned)[0], 404)
        for limit in ('0', '501', 'bad'):
            self.assertEqual(self.send('GET', '/v1/jobs?limit=' + limit)[0], 400)

    def test_http_fail_retry_and_expired_ownership(self):
        with patch('jobs.now_ms', return_value=1000000) as clock:
            self.capture()
            job = self.claim()
            path = '/v1/jobs/' + job['jobId']
            owned = dict(schemaVersion=1, workerId='http-worker', leaseToken=job['leaseToken'])
            status, failed = self.send('POST', path + '/fail', dict(owned, errorCode='worker_error'))
            self.assertEqual(status, 200)
            self.assertEqual(failed['job']['state'], 'pending')
            self.assertIsNone(self.claim())
            clock.return_value += 60000
            reclaimed = self.claim()
            self.assertEqual(reclaimed['attempts'], 2)
            self.assertEqual(self.send('POST', path + '/heartbeat', owned)[0], 409)
            clock.return_value += 60000
            new_owned = dict(owned, leaseToken=reclaimed['leaseToken'])
            self.assertEqual(self.send('POST', path + '/heartbeat', new_owned)[0], 409)


if __name__ == '__main__':
    unittest.main()
