"""Unit tests for the Notes WSGI app. Standard library only.

Run from the app/ directory: python3 -m unittest test_app -v
"""
import importlib
import json
import os
import tempfile
import unittest
from io import BytesIO

import app as notes_app


def call(method, path, body=b""):
    """Invoke the WSGI app directly and return (status, parsed-or-bytes)."""
    captured = {}

    def start_response(status, headers):
        captured["status"] = status
        captured["headers"] = headers

    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "CONTENT_LENGTH": str(len(body)),
        "wsgi.input": BytesIO(body),
    }
    chunks = notes_app.app(environ, start_response)
    raw = b"".join(chunks)
    try:
        return captured["status"], json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return captured["status"], raw


class NotesApiTest(unittest.TestCase):
    def setUp(self):
        fd, self.db = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        notes_app.DB_PATH = self.db
        notes_app.ensure_schema()  # creates table + seeds when empty

    def tearDown(self):
        os.unlink(self.db)

    def test_health(self):
        status, payload = call("GET", "/api/health")
        self.assertEqual(status, "200 OK")
        self.assertEqual(payload, {"status": "ok"})

    def test_list_is_seeded(self):
        status, payload = call("GET", "/api/notes")
        self.assertEqual(status, "200 OK")
        self.assertGreaterEqual(len(payload), 2)

    def test_create_then_get(self):
        status, note = call(
            "POST", "/api/notes",
            json.dumps({"title": "T", "body": "B"}).encode(),
        )
        self.assertEqual(status, "201 Created")
        self.assertEqual(note["title"], "T")
        status, fetched = call("GET", f"/api/notes/{note['id']}")
        self.assertEqual(status, "200 OK")
        self.assertEqual(fetched["id"], note["id"])

    def test_create_requires_title(self):
        status, _ = call(
            "POST", "/api/notes", json.dumps({"body": "no title"}).encode()
        )
        self.assertEqual(status, "400 Bad Request")

    def test_update(self):
        _, note = call(
            "POST", "/api/notes", json.dumps({"title": "old"}).encode()
        )
        status, updated = call(
            "PUT", f"/api/notes/{note['id']}",
            json.dumps({"title": "new", "body": "x"}).encode(),
        )
        self.assertEqual(status, "200 OK")
        self.assertEqual(updated["title"], "new")

    def test_get_missing_is_404(self):
        status, _ = call("GET", "/api/notes/999999")
        self.assertEqual(status, "404 Not Found")

    def test_delete(self):
        _, note = call(
            "POST", "/api/notes", json.dumps({"title": "gone"}).encode()
        )
        status, _ = call("DELETE", f"/api/notes/{note['id']}")
        self.assertEqual(status, "204 No Content")
        status, _ = call("GET", f"/api/notes/{note['id']}")
        self.assertEqual(status, "404 Not Found")

    def test_bad_json_is_400(self):
        status, _ = call("POST", "/api/notes", b"{ not json")
        self.assertEqual(status, "400 Bad Request")

    def test_unknown_method_is_405(self):
        status, _ = call("PATCH", "/api/notes")
        self.assertEqual(status, "405 Method Not Allowed")


if __name__ == "__main__":
    unittest.main()
