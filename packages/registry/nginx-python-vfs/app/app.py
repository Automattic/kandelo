#!/usr/bin/env python3
"""A small real Notes JSON API, served by Python behind nginx on Kandelo.

Standard library only: wsgiref (HTTP/WSGI), sqlite3 (storage), json,
socketserver (threading). No third-party packages.

nginx reverse-proxies /api/ to this server on 127.0.0.1:8000.
"""
import json
import os
import re
import sqlite3
from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIServer, make_server

DB_PATH = os.environ.get("NOTES_DB", "/var/lib/notes/notes.db")
HOST = os.environ.get("NOTES_HOST", "127.0.0.1")
PORT = int(os.environ.get("NOTES_PORT", "8000"))

_HERE = os.path.dirname(os.path.abspath(__file__))
_NOTE_ID_RE = re.compile(r"^/api/notes/(\d+)$")


class ThreadingWSGIServer(ThreadingMixIn, WSGIServer):
    """Serve each request on its own thread so concurrent fetches from the
    demo page do not serialize."""
    daemon_threads = True


def _connect():
    # A fresh connection per request keeps SQLite access thread-safe under
    # ThreadingWSGIServer without sharing one connection across threads.
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def ensure_schema():
    """Create the table if needed and seed sample rows once when empty."""
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    with open(os.path.join(_HERE, "schema.sql"), encoding="utf-8") as fh:
        schema_sql = fh.read()
    with _connect() as conn:
        conn.executescript(schema_sql)
        (count,) = conn.execute("SELECT COUNT(*) FROM notes").fetchone()
        if count == 0:
            with open(os.path.join(_HERE, "seed.sql"), encoding="utf-8") as fh:
                conn.executescript(fh.read())


def _note(row):
    return {
        "id": row["id"],
        "title": row["title"],
        "body": row["body"],
        "created_at": row["created_at"],
    }


def _json(start_response, status, payload):
    body = json.dumps(payload).encode("utf-8")
    start_response(status, [
        ("Content-Type", "application/json"),
        ("Content-Length", str(len(body))),
    ])
    return [body]


def _read_json(environ):
    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except ValueError:
        length = 0
    raw = environ["wsgi.input"].read(length) if length else b""
    return json.loads(raw.decode("utf-8")) if raw else {}


def app(environ, start_response):
    method = environ["REQUEST_METHOD"]
    path = environ.get("PATH_INFO", "")
    try:
        if path == "/api/health":
            if method != "GET":
                return _json(start_response, "405 Method Not Allowed",
                             {"error": "method not allowed"})
            return _json(start_response, "200 OK", {"status": "ok"})

        if path == "/api/notes":
            if method == "GET":
                with _connect() as conn:
                    rows = conn.execute(
                        "SELECT id, title, body, created_at FROM notes ORDER BY id"
                    ).fetchall()
                return _json(start_response, "200 OK", [_note(r) for r in rows])
            if method == "POST":
                data = _read_json(environ)
                title = (data.get("title") or "").strip()
                if not title:
                    return _json(start_response, "400 Bad Request",
                                 {"error": "title is required"})
                body = data.get("body") or ""
                with _connect() as conn:
                    cur = conn.execute(
                        "INSERT INTO notes (title, body) VALUES (?, ?)",
                        (title, body),
                    )
                    row = conn.execute(
                        "SELECT id, title, body, created_at FROM notes WHERE id = ?",
                        (cur.lastrowid,),
                    ).fetchone()
                return _json(start_response, "201 Created", _note(row))
            return _json(start_response, "405 Method Not Allowed",
                         {"error": "method not allowed"})

        match = _NOTE_ID_RE.match(path)
        if match:
            note_id = int(match.group(1))
            if method == "GET":
                with _connect() as conn:
                    row = conn.execute(
                        "SELECT id, title, body, created_at FROM notes WHERE id = ?",
                        (note_id,),
                    ).fetchone()
                if row is None:
                    return _json(start_response, "404 Not Found",
                                 {"error": "note not found"})
                return _json(start_response, "200 OK", _note(row))
            if method == "PUT":
                data = _read_json(environ)
                title = (data.get("title") or "").strip()
                if not title:
                    return _json(start_response, "400 Bad Request",
                                 {"error": "title is required"})
                body = data.get("body") or ""
                with _connect() as conn:
                    cur = conn.execute(
                        "UPDATE notes SET title = ?, body = ? WHERE id = ?",
                        (title, body, note_id),
                    )
                    if cur.rowcount == 0:
                        return _json(start_response, "404 Not Found",
                                     {"error": "note not found"})
                    row = conn.execute(
                        "SELECT id, title, body, created_at FROM notes WHERE id = ?",
                        (note_id,),
                    ).fetchone()
                return _json(start_response, "200 OK", _note(row))
            if method == "DELETE":
                with _connect() as conn:
                    cur = conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
                if cur.rowcount == 0:
                    return _json(start_response, "404 Not Found",
                                 {"error": "note not found"})
                start_response("204 No Content", [("Content-Length", "0")])
                return [b""]
            return _json(start_response, "405 Method Not Allowed",
                         {"error": "method not allowed"})

        return _json(start_response, "404 Not Found", {"error": "not found"})
    except json.JSONDecodeError:
        return _json(start_response, "400 Bad Request", {"error": "invalid JSON"})
    except Exception:  # noqa: BLE001 - never leak a stack trace to the client
        return _json(start_response, "500 Internal Server Error",
                     {"error": "internal error"})


def main():
    ensure_schema()
    with make_server(HOST, PORT, app, server_class=ThreadingWSGIServer) as httpd:
        print(f"notes-app listening on http://{HOST}:{PORT}", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
