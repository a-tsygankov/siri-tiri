"""Siri-Tiri Windows/Pi localhost-only durable event prototype (stdlib Python 3.11+)."""
import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import jobs

VERSION = "0.2.0"
DB_PATH = Path(os.environ.get("SIRI_TIRI_DB", Path(__file__).parent / "data" / "siri-tiri.sqlite3"))
LOCK = threading.RLock()
TYPES = {"capture", "review", "analysis", "heartbeat", "update_status"}
LEVELS = {"DEBUG", "INFO", "WARN", "ERROR"}
COMPONENTS = {"pwa", "device", "local", "worker", "cloud-inference"}


@contextmanager
def connect():
    """Commit or roll back each operation, then always release its connection."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=15)
    try:
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=15000")
        db.execute("PRAGMA foreign_keys=ON")
        with db:
            yield db
    finally:
        db.close()


def init_db():
    with LOCK, connect() as db:
        db.execute('BEGIN IMMEDIATE')
        exists = db.execute("SELECT name FROM sqlite_master WHERE name='schema_migrations'").fetchone()
        version = db.execute('SELECT coalesce(max(version),0) FROM schema_migrations').fetchone()[0] if exists else 0
        if version > jobs.SCHEMA_VERSION:
            raise RuntimeError('database schema is newer than this service supports')
        baseline = """
        CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (
          message_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, source_id TEXT NOT NULL,
          created_at TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL,
          received_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_event ON messages(event_id);
        CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at);
        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
          level TEXT NOT NULL, component TEXT NOT NULL, event_name TEXT NOT NULL,
          body TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(timestamp);
        INSERT OR IGNORE INTO schema_migrations(version,applied_at)
        VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
        """
        if version < 1:
            for statement in baseline.split(';'):
                if statement.strip():
                    db.execute(statement)
        if version < 2:
            jobs.migrate(db)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def valid_time(value):
    if not isinstance(value, str):
        return False
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return dt.tzinfo is not None
    except ValueError:
        return False


def validate_event(e):
    if not isinstance(e, dict) or e.get("schemaVersion") != 1:
        raise ValueError("schemaVersion must be 1")
    for field in ("messageId", "eventId"):
        try:
            if not isinstance(e.get(field), str):
                raise ValueError()
            uuid.UUID(e[field])
        except ValueError:
            raise ValueError(field + " must be a UUID") from None
    if not isinstance(e.get("sourceId"), str) or not 1 <= len(e["sourceId"]) <= 128:
        raise ValueError("sourceId must be 1..128 characters")
    if not valid_time(e.get("createdAt")):
        raise ValueError("createdAt must include timezone")
    if e.get("type") not in TYPES:
        raise ValueError("unsupported event type")
    if "payload" in e and not isinstance(e["payload"], dict):
        raise ValueError("payload must be an object")
    return e


def validate_log(e):
    if not isinstance(e, dict) or e.get("schemaVersion") != 1:
        raise ValueError("schemaVersion must be 1")
    if not valid_time(e.get("timestamp")) or e.get("level") not in LEVELS or e.get("component") not in COMPONENTS:
        raise ValueError("invalid timestamp, level or component")
    if not all(isinstance(e.get(k), str) and e[k] for k in ("eventName", "message")):
        raise ValueError("eventName and message required")
    return e


def insert_event(event):
    validate_event(event)
    with LOCK, connect() as db:
        cur = db.execute("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?,?)",
                         (event["messageId"], event["eventId"], event["sourceId"],
                          event["createdAt"], event["type"], json.dumps(event), utc_now()))
        if cur.rowcount == 0:
            existing = db.execute("SELECT body FROM messages WHERE message_id=?", (event["messageId"],)).fetchone()
            if json.loads(existing["body"]) != event:
                raise ValueError("messageId collision with different content")
        else:
            jobs.enqueue(db, event)
        return cur.rowcount == 1


def insert_log(log):
    validate_log(log)
    with LOCK, connect() as db:
        db.execute("INSERT INTO logs(timestamp,level,component,event_name,body) VALUES(?,?,?,?,?)",
                   (log["timestamp"], log["level"], log["component"], log["eventName"], json.dumps(log)))


def list_rows(table, limit=100):
    if table not in ("messages", "logs"):
        raise ValueError("invalid table")
    with connect() as db:
        order = "received_at" if table == "messages" else "id"
        rows = db.execute(f"SELECT body FROM {table} ORDER BY {order} DESC LIMIT ?", (limit,)).fetchall()
        return [json.loads(r["body"]) for r in rows]


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, body):
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = urlparse(self.path)
        if path.path == "/health":
            return self.respond(200, {"status": "ok", "component": "local", "version": VERSION})
        if path.path == "/version":
            return self.respond(200, {"version": VERSION, "protocol": 1, "sqliteSchema": jobs.SCHEMA_VERSION})
        if path.path == '/v1/jobs':
            try:
                limit = int(parse_qs(path.query).get('limit', ['100'])[0])
                return self.respond(200, {'schemaVersion': 1, 'items': jobs.list_jobs(connect, limit)})
            except ValueError:
                return self.respond(400, {'error': 'limit must be 1..500'})
        if path.path in ("/events", "/logs"):
            try:
                limit = max(1, min(500, int(parse_qs(path.query).get("limit", ["100"])[0])))
            except ValueError:
                return self.respond(400, {"error": "invalid limit"})
            return self.respond(200, {"items": list_rows("messages" if path.path == "/events" else "logs", limit)})
        self.respond(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        parts = path.strip('/').split('/')
        operation = None
        if len(parts) == 4 and parts[:2] == ['v1', 'jobs']:
            operation = {'heartbeat': jobs.heartbeat, 'ack': jobs.ack, 'fail': jobs.fail}.get(parts[3])
        if path not in ("/events", "/logs", '/v1/jobs/claim') and operation is None:
            return self.respond(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 65536:
                return self.respond(413, {"error": "body must be 1..65536 bytes"})
            def reject_constant(value):
                raise ValueError('nonfinite JSON value')
            body = json.loads(self.rfile.read(length), parse_constant=reject_constant)
            if path == '/v1/jobs/claim':
                return self.respond(200, {'schemaVersion': 1, 'job': jobs.claim(connect, body)})
            if operation is not None:
                return self.respond(200, {'schemaVersion': 1, 'job': operation(connect, parts[2], body)})
            if path == "/events":
                inserted = insert_event(body)
                return self.respond(201 if inserted else 200, {"accepted": True, "duplicate": not inserted})
            insert_log(body)
            return self.respond(201, {"accepted": True})
        except jobs.NotFound:
            return self.respond(404, {'error': 'job not found'})
        except jobs.Conflict as ex:
            return self.respond(409, {'error': str(ex)})
        except RecursionError:
            return self.respond(400, {'error': 'JSON nesting too deep'})
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as ex:
            return self.respond(400, {"error": str(ex)})

    def log_message(self, fmt, *args):
        print("%s %s" % (self.log_date_time_string(), fmt % args))


if __name__ == "__main__":
    init_db()
    print("Siri-Tiri local prototype http://127.0.0.1:8765 (localhost only)")
    ThreadingHTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
