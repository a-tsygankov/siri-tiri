"""Lease-aware, localhost-only inference worker. No recording or audio upload."""
import argparse
import http.client
import json
from pathlib import Path
import threading
import uuid
from datetime import datetime, timezone

from inference import AudioError, Yamnet, load_wav, resolve_audio


class TransportError(Exception):
    pass


class LeaseLost(Exception):
    pass


class ServiceError(Exception):
    pass


def log(event, job_id=None, code=None):
    print(json.dumps(dict(schemaVersion=1, timestamp=datetime.now(timezone.utc).isoformat(),
                          level='WARN' if code else 'INFO', component='local', version='0.3.0',
                          eventName=event, message=event,
                          attributes=dict(role='inference-worker', jobId=job_id, errorCode=code))), flush=True)


class Client:
    def __init__(self, port=8765, host='127.0.0.1'):
        if host != '127.0.0.1' or type(port) is not int or not 1 <= port <= 65535:
            raise ValueError('worker requires 127.0.0.1 and a valid port')
        self.host, self.port = host, port

    def post(self, path, body):
        connection = http.client.HTTPConnection(self.host, self.port, timeout=5)
        try:
            connection.request('POST', path, body=json.dumps(body), headers={'Content-Type': 'application/json'})
            response = connection.getresponse()
            raw = response.read(131073)
            if response.status == 409:
                raise LeaseLost()
            if response.status >= 500:
                raise TransportError()
            if response.status != 200 or len(raw) > 131072:
                raise ServiceError('worker_api_rejected')
            try:
                result = json.loads(raw)
                if type(result.get('schemaVersion')) is not int or result['schemaVersion'] != 1 or 'job' not in result:
                    raise ValueError()
                return result
            except (ValueError, AttributeError):
                raise ServiceError('worker_api_invalid_response') from None
        except (OSError, http.client.HTTPException):
            raise TransportError() from None
        finally:
            connection.close()


class Worker:
    def __init__(self, client, model, audio_root, retry_seconds=1):
        self.client, self.model, self.audio_root = client, model, Path(audio_root)
        self.worker_id = 'yamnet-' + str(uuid.uuid4())
        self.stop = threading.Event()
        self.retry_seconds = retry_seconds

    def renew(self, job, finished, lost):
        body = dict(schemaVersion=1, workerId=self.worker_id, leaseToken=job['leaseToken'], leaseSeconds=60)
        while not finished.wait(10):
            try:
                self.client.post('/v1/jobs/' + job['jobId'] + '/heartbeat', body)
            except LeaseLost:
                lost.set()
                return
            except TransportError:
                continue  # The acknowledgment still has to pass the server's expiry check.
            except ServiceError:
                lost.set()
                return

    def submit(self, path, body):
        # Retain the exact result and token across lost responses; never recompute here.
        while not self.stop.is_set():
            try:
                return self.client.post(path, body)
            except TransportError:
                if self.stop.wait(self.retry_seconds):
                    return None
        return None

    def run_once(self):
        job = self.client.post('/v1/jobs/claim', dict(schemaVersion=1, workerId=self.worker_id, leaseSeconds=60))['job']
        if job is None:
            return False
        finished, lost = threading.Event(), threading.Event()
        renewer = threading.Thread(target=self.renew, args=(job, finished, lost), daemon=True)
        renewer.start()
        result, error = None, None
        try:
            payload = job['event'].get('payload', {})
            if not isinstance(payload, dict):
                raise AudioError('audio_reference_invalid')
            path = resolve_audio(self.audio_root, payload.get('audioRef'))
            result = self.model.analyze(load_wav(path))
        except AudioError as ex:
            error = str(ex)
        except Exception:
            error = 'inference_failed'
        finally:
            finished.set()
            renewer.join(timeout=6)
        if lost.is_set() or self.stop.is_set() or renewer.is_alive():
            log('job.abandoned', job['jobId'], 'lease_lost')
            return True
        body = dict(schemaVersion=1, workerId=self.worker_id, leaseToken=job['leaseToken'])
        if error:
            body['errorCode'] = error
            operation = 'fail'
        else:
            body['result'] = result
            operation = 'ack'
        try:
            response = self.submit('/v1/jobs/' + job['jobId'] + '/' + operation, body)
            if response is not None:
                log('job.' + ('failed' if error else 'completed'), job['jobId'], error)
        except LeaseLost:
            log('job.abandoned', job['jobId'], 'lease_lost')
        return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--audio-root', type=Path, default=Path(__file__).resolve().parent / 'audio')
    parser.add_argument('--once', action='store_true', help='Process at most one eligible job, then exit')
    args = parser.parse_args()
    try:
        model = Yamnet()  # Verify dependencies and model before claiming any work.
        run = Worker(Client(args.port), model, args.audio_root)
        log('worker.ready')
        while not run.stop.is_set():
            try:
                worked = run.run_once()
                if args.once:
                    return 0
                if not worked:
                    run.stop.wait(1)
            except TransportError:
                if args.once:
                    return 1
                run.stop.wait(2)
    except KeyboardInterrupt:
        if 'run' in locals():
            run.stop.set()
        return 0
    except Exception:
        log('worker.stopped', code='worker_startup_or_api_failed')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
