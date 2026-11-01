"""Durable local job ledger. Callers supply the service connection context manager."""
import json
import random
import re
import time
import uuid
from datetime import datetime, timezone

SCHEMA_VERSION = 2
MAX_ATTEMPTS = 5


class NotFound(Exception):
    pass


class Conflict(Exception):
    pass


def now_ms():
    return time.time_ns() // 1000000


def timestamp(value):
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def migrate(db):
    """Called within init_db's single migration transaction."""
    db.execute('''CREATE TABLE jobs (
        job_id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
        event_id TEXT NOT NULL, correlation_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending','leased','completed','failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
        available_at INTEGER NOT NULL, worker_id TEXT, lease_token TEXT, lease_expires_at INTEGER,
        result TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        completed_at INTEGER
    )''')
    db.execute('CREATE INDEX idx_jobs_claim ON jobs(state, available_at, lease_expires_at, created_at)')
    for row in db.execute("SELECT body FROM messages WHERE type='capture'").fetchall():
        enqueue(db, json.loads(row['body']))
    db.execute('INSERT INTO schema_migrations VALUES (?,?)', (SCHEMA_VERSION, timestamp(now_ms())))


def enqueue(db, event):
    if event['type'] != 'capture':
        return
    now = now_ms()
    db.execute('''INSERT INTO jobs
        (job_id,message_id,event_id,correlation_id,state,available_at,created_at,updated_at)
        VALUES (?,?,?,?,'pending',?,?,?) ON CONFLICT(message_id) DO NOTHING''',
        (event['messageId'], event['messageId'], event['eventId'], event.get('correlationId'), now, now, now))


def view(row, include_token=False):
    result = dict(jobId=row['job_id'], messageId=row['message_id'], eventId=row['event_id'],
                  correlationId=row['correlation_id'], state=row['state'], attempts=row['attempts'],
                  workerId=row['worker_id'], leaseExpiresAt=timestamp(row['lease_expires_at']),
                  availableAt=timestamp(row['available_at']), createdAt=timestamp(row['created_at']),
                  updatedAt=timestamp(row['updated_at']), completedAt=timestamp(row['completed_at']),
                  errorCode=row['error_code'], result=json.loads(row['result']) if row['result'] else None)
    if include_token:
        result['leaseToken'] = row['lease_token']
    return result


def list_jobs(connect, limit=100):
    if type(limit) is not int or not 1 <= limit <= 500:
        raise ValueError('limit must be 1..500')
    with connect() as db:
        return [view(row) for row in db.execute('SELECT * FROM jobs ORDER BY created_at DESC, job_id LIMIT ?', (limit,))]


def text_field(body, name, maximum=128):
    value = body.get(name)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(name + ' must be a nonempty bounded string')
    return value


def identifier(value):
    if not isinstance(value, str):
        raise ValueError('invalid UUID')
    try:
        uuid.UUID(value)
    except ValueError:
        raise ValueError('invalid UUID') from None
    return value


def request(body, allowed, owned=False):
    if not isinstance(body, dict) or type(body.get('schemaVersion')) is not int or body['schemaVersion'] != 1:
        raise ValueError('schemaVersion must be 1')
    if set(body) - {'schemaVersion', 'workerId'} - set(allowed):
        raise ValueError('unknown job request field')
    text_field(body, 'workerId')
    if owned:
        identifier(body.get('leaseToken'))


def lease_seconds(body):
    value = body.get('leaseSeconds', 60)
    if type(value) is not int or not 1 <= value <= 900:
        raise ValueError('leaseSeconds must be 1..900')
    return value


def claim(connect, body):
    request(body, {'leaseSeconds'})
    seconds = lease_seconds(body)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        now = now_ms()
        db.execute('''UPDATE jobs SET state='failed', error_code='lease_expired', updated_at=?,
            worker_id=NULL, lease_token=NULL, lease_expires_at=NULL
            WHERE state='leased' AND lease_expires_at<=? AND attempts>=?''', (now, now, MAX_ATTEMPTS))
        row = db.execute('''SELECT * FROM jobs WHERE attempts<? AND
            ((state='pending' AND available_at<=?) OR (state='leased' AND lease_expires_at<=?))
            ORDER BY created_at, job_id LIMIT 1''', (MAX_ATTEMPTS, now, now)).fetchone()
        if row is None:
            return None
        db.execute('''UPDATE jobs SET state='leased', attempts=attempts+1, worker_id=?,
            lease_token=?, lease_expires_at=?, updated_at=? WHERE job_id=?''',
            (body['workerId'], str(uuid.uuid4()), now + seconds * 1000, now, row['job_id']))
        updated = db.execute('SELECT * FROM jobs WHERE job_id=?', (row['job_id'],)).fetchone()
        result = view(updated, include_token=True)
        result['event'] = json.loads(db.execute('SELECT body FROM messages WHERE message_id=?',
                                              (row['message_id'],)).fetchone()['body'])
        return result


def load_owned(db, job_id, body):
    row = db.execute('SELECT * FROM jobs WHERE job_id=?', (job_id,)).fetchone()
    if row is None:
        raise NotFound('job not found')
    if row['worker_id'] != body['workerId'] or row['lease_token'] != body['leaseToken']:
        raise Conflict('lease ownership conflict')
    return row


def require_live(row, now):
    if row['state'] != 'leased' or now >= row['lease_expires_at']:
        raise Conflict('lease is not active')


def heartbeat(connect, job_id, body):
    identifier(job_id)
    request(body, {'leaseToken', 'leaseSeconds'}, owned=True)
    seconds = lease_seconds(body)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = load_owned(db, job_id, body)
        now = now_ms()
        require_live(row, now)
        expiry = max(row['lease_expires_at'], now + seconds * 1000)
        db.execute('UPDATE jobs SET lease_expires_at=?, updated_at=? WHERE job_id=?', (expiry, now, job_id))
        return view(db.execute('SELECT * FROM jobs WHERE job_id=?', (job_id,)).fetchone())


def encode_result(body):
    result = body.get('result')
    if not isinstance(result, dict):
        raise ValueError('result must be an object')
    text_field(result, 'modelVersion')
    text_field(result, 'preprocessingVersion')
    try:
        encoded = json.dumps(result, sort_keys=True, separators=(',', ':'), allow_nan=False)
    except (ValueError, TypeError, RecursionError):
        raise ValueError('result must be finite JSON') from None
    if len(encoded.encode('utf-8')) > 32768:
        raise ValueError('result exceeds 32768 bytes')
    return encoded


def ack(connect, job_id, body):
    identifier(job_id)
    request(body, {'leaseToken', 'result'}, owned=True)
    encoded = encode_result(body)
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = load_owned(db, job_id, body)
        if row['state'] == 'completed':
            if row['result'] != encoded:
                raise Conflict('completed result differs')
            return view(row)
        now = now_ms()
        require_live(row, now)
        db.execute("UPDATE jobs SET state='completed', result=?, completed_at=?, updated_at=?, error_code=NULL WHERE job_id=?",
                   (encoded, now, now, job_id))
        return view(db.execute('SELECT * FROM jobs WHERE job_id=?', (job_id,)).fetchone())


def fail(connect, job_id, body):
    identifier(job_id)
    request(body, {'leaseToken', 'errorCode'}, owned=True)
    code = text_field(body, 'errorCode', 64)
    if not re.fullmatch(r'[a-zA-Z0-9_.-]+', code):
        raise ValueError('errorCode must contain only letters, digits, underscore, dot or hyphen')
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row = load_owned(db, job_id, body)
        now = now_ms()
        require_live(row, now)
        terminal = row['attempts'] >= MAX_ATTEMPTS
        delay = min(60000, 1000 * 2 ** (row['attempts'] - 1) + random.randint(0, 1000))
        db.execute('''UPDATE jobs SET state=?, available_at=?, error_code=?, updated_at=?,
            worker_id=NULL, lease_token=NULL, lease_expires_at=NULL WHERE job_id=?''',
            ('failed' if terminal else 'pending', now + delay, code, now, job_id))
        return view(db.execute('SELECT * FROM jobs WHERE job_id=?', (job_id,)).fetchone())
