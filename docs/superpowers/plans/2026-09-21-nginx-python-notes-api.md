# nginx → Python (WSGI) Notes API Example — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a package-registry example that runs a real server-side
Python web app on Kandelo — nginx reverse-proxying to a standard-library
`wsgiref` WSGI app serving a JSON REST API over stdlib `sqlite3` — wired
into the browser demo gallery like the existing `nginx-php` demo.

**Architecture:** A new composite VFS-image package `nginx-python-vfs`
derives from the shell base image, lays down the CPython interpreter +
Python 3.13 stdlib and the nginx binary, copies a real Python app into
`/srv/notes/`, and boots both under `dinit` (`nginx` depends on
`notes-app`). nginx serves static files at `/` and `proxy_pass`es
`/api/` to the Python WSGI server on loopback `127.0.0.1:8000`. No pip,
no third-party packages — everything rides the SDK/resolver/VFS/kernel
path.

**Tech Stack:** Python 3.13 stdlib (`wsgiref`, `sqlite3`, `json`,
`socketserver`), nginx 1.24, dinit, TypeScript VFS image builders
(`tsx`), Rust `xtask` product validation, Vitest/Playwright evidence
tests.

**Spec:** `docs/superpowers/specs/2026-09-21-nginx-python-notes-api-design.md`
(read it alongside this plan; the plan argues from the spec).

## Global Constraints

- **No third-party Python packages.** Standard library only. If a step
  seems to need pip, stop — the design forbids it.
- **`kernel_abi = 43`** for the new image package's `package.toml`, matching
  the current `ABI_VERSION` in `crates/shared/src/lib.rs:121`. Kandelo
  enforces strict `__abi_version` equality: the consumed `nginx` and
  `cpython` binaries must be built against the same ABI as the booted
  kernel. Rebuilding stale binaries through the normal package path is
  in-scope provisioning, not a blocker; shimming an ABI mismatch is
  forbidden.
- **Build/verify only inside the dev shell:** prefix build and test
  commands with `scripts/dev-shell.sh bash -lc '...'` (or run inside
  `scripts/dev-shell.sh`). Do not rely on ambient host tools.
- **nginx listens on `8080`**; the Python WSGI app listens on
  `127.0.0.1:8000`. The browser demo reaches nginx on `8080` (matches the
  nginx-php demo and `HTTP_PORT` in `live-setup.ts`).
- **Reproducible / canonical projections stay in lockstep.** Every
  hand-maintained `.generated.json` must remain byte-canonical (keys
  sorted, entries sorted by id, trailing newline) and identical to its
  `.toml` source. The check scripts fail otherwise.
- **Commit after every task** (frequent commits). Use the `Area:` prefix
  convention for subjects (e.g. `Packages:`, `Browser:`, `Docs:`).

## File Structure (what gets created / modified)

**New — the Python app (real, reviewable source):**
- `packages/registry/nginx-python-vfs/app/app.py` — WSGI app + server.
- `packages/registry/nginx-python-vfs/app/schema.sql` — table DDL.
- `packages/registry/nginx-python-vfs/app/seed.sql` — seed rows.
- `packages/registry/nginx-python-vfs/app/static/index.html` — docs + live fetch.
- `packages/registry/nginx-python-vfs/app/test_app.py` — unit tests.

**New — the package:**
- `packages/registry/nginx-python-vfs/package.toml`
- `packages/registry/nginx-python-vfs/build.toml`

**New — the builder:**
- `images/vfs/scripts/build-nginx-python-vfs-image.ts`
- `images/vfs/scripts/build-nginx-python-vfs-image.sh`

**New — the product manifest:**
- `images/vfs/products/browser-nginx-python.toml`

**Modified — gallery / registry lockstep:**
- `images/vfs/scripts/staged-product-inputs.ts` (builder map + build case)
- `web-libs/kandelo-session/src/demo-guides.ts` (guide + 2 switch cases)
- `apps/browser-demos/pages/kandelo/presets.ts` (new preset)
- `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml`
- `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json`
- `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json`
- `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` (~8 sites)
- `apps/browser-demos/pages/kandelo/kernel-host/dinit-boot-status.ts` (`REQUIRED_DINIT_SERVICES`)
- `tests/vfs-products.toml`
- `tests/vfs-products.generated.json`
- `run.sh` (`BROWSER_DEPS` + build-target function)

---

## Task 1: De-risk — confirm ABI coherence and the browser HTTP surface

This task writes no product code. It resolves the two unknowns the spec
flagged before we build on assumptions. Its deliverable is a short
findings note committed under `.context/`.

- [ ] **Step 1: Record the current ABI**

Run:
```bash
scripts/dev-shell.sh bash -lc 'grep -n "ABI_VERSION" crates/shared/src/lib.rs | head'
```
Expected: `pub const ABI_VERSION: u32 = 43;` (or a higher number — use
whatever it prints as the value for `kernel_abi` throughout this plan).

- [ ] **Step 2: Determine whether nginx and cpython are ABI-current**

Resolve each dependency and inspect its ABI. Run:
```bash
scripts/dev-shell.sh bash -lc 'cargo run -p xtask --quiet -- build-deps resolve cpython'
scripts/dev-shell.sh bash -lc 'cargo run -p xtask --quiet -- build-deps resolve nginx'
```
Expected: each prints a resolved dependency directory path, OR reports
that the artifact must be built. If resolution reports an ABI mismatch
or the binaries are stale relative to the ABI from Step 1, that is the
signal to rebuild them in Step 3. Note: `cpython/package.toml` currently
declares `kernel_abi = 41` and `nginx/package.toml` declares `7`; if the
resolver treats those as current for ABI 43 the packages are fine as-is,
otherwise they need a rebuild + `kernel_abi` bump.

- [ ] **Step 3: Provision any missing/stale prerequisite artifacts**

If Step 2 shows missing or ABI-stale binaries, build them through the
normal path (this is expected provisioning, per the build contract):
```bash
scripts/dev-shell.sh bash -lc './run.sh setup'
```
Expected: musl sysroot, kernel wasm, nginx, and cpython build to
completion. If cpython or nginx must be rebuilt at ABI 43 and their
`package.toml` `kernel_abi` is stale, record that as a required change
(bump `kernel_abi` to the Step 1 value in that package's `package.toml`
and its `build.toml` `revision`). Do not shim a mismatch.

- [ ] **Step 4: Read exactly how the browser reaches nginx**

Read `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` around
the `LIVE_DEMO_SPECS["nginx-php"]` entry (~lines 381-395) and confirm:
the `web.requiredPorts` value (the `HTTP_PORT` constant), that
`network: true`, and that `requiredServices` comes from
`REQUIRED_DINIT_SERVICES["nginx-php"]` in `dinit-boot-status.ts`. Record
the `HTTP_PORT` numeric value.

- [ ] **Step 5: Write and commit the findings note**

Create `.context/nginx-python-derisk.md` with: the ABI value, whether
nginx/cpython needed a rebuild (and any `kernel_abi` bumps required), and
the confirmed `HTTP_PORT`. Then:
```bash
git add .context/nginx-python-derisk.md
git commit -m "Docs: Record ABI + HTTP-surface de-risking for nginx-python example"
```
Expected: commit succeeds. If ABI work requires package changes, note
them here so later tasks can reference the exact values.

---

## Task 2: The Python WSGI app + failing unit tests (TDD)

Build the real Python app test-first. It runs on host Python during
development (the app is pure stdlib); the authoritative run is in Kandelo
(Task 10).

**Files:**
- Create: `packages/registry/nginx-python-vfs/app/schema.sql`
- Create: `packages/registry/nginx-python-vfs/app/seed.sql`
- Create: `packages/registry/nginx-python-vfs/app/app.py`
- Create: `packages/registry/nginx-python-vfs/app/test_app.py`

**Interfaces:**
- Produces: a WSGI callable `app(environ, start_response) -> Iterable[bytes]`
  in `app.py`; module globals `DB_PATH`, `HOST`, `PORT`; functions
  `ensure_schema()`, `main()`; and a `ThreadingWSGIServer` class. Later
  tasks reference `app.py`'s VFS location `/srv/notes/app.py`, the DB path
  `/var/lib/notes/notes.db`, and the listen address `127.0.0.1:8000`.

- [ ] **Step 1: Write the schema and seed SQL**

`packages/registry/nginx-python-vfs/app/schema.sql`:
```sql
-- Notes table. Idempotent so the app can ensure it on every boot.
CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`packages/registry/nginx-python-vfs/app/seed.sql`:
```sql
-- Sample rows inserted once, on first boot, when the table is empty.
INSERT INTO notes (title, body) VALUES
    ('Welcome to Kandelo',
     'This note is served by Python (wsgiref) behind nginx, all in WebAssembly.'),
    ('Try the API',
     'GET /api/notes, POST {"title","body"} to create, DELETE /api/notes/{id}.');
```

- [ ] **Step 2: Write the failing unit tests**

`packages/registry/nginx-python-vfs/app/test_app.py`:
```python
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run:
```bash
cd packages/registry/nginx-python-vfs/app && python3 -m unittest test_app -v
```
Expected: FAIL / ERROR — `app.py` does not exist yet
(`ModuleNotFoundError: No module named 'app'`).

- [ ] **Step 4: Write the WSGI application**

`packages/registry/nginx-python-vfs/app/app.py`:
```python
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
cd packages/registry/nginx-python-vfs/app && python3 -m unittest test_app -v
```
Expected: all 9 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/registry/nginx-python-vfs/app/
git commit -m "Packages: Add Notes WSGI app for the nginx-python example"
```

---

## Task 3: The static demo page

**Files:**
- Create: `packages/registry/nginx-python-vfs/app/static/index.html`

- [ ] **Step 1: Write the static page (docs + live fetch)**

`packages/registry/nginx-python-vfs/app/static/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kandelo — Python Notes API</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1rem; }
    code { background: #f0f0f3; padding: 0.1rem 0.3rem; border-radius: 3px; }
    pre { background: #1e1e2e; color: #e6e6f0; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    button { font: inherit; padding: 0.4rem 0.8rem; cursor: pointer; }
    li { margin: 0.25rem 0; }
  </style>
</head>
<body>
  <h1>Python Notes API on Kandelo</h1>
  <p>
    This page is served by <strong>nginx</strong>. The
    <code>/api/</code> routes below are reverse-proxied to a
    standard-library <strong>Python <code>wsgiref</code></strong> app
    backed by <strong>SQLite</strong> — all running in WebAssembly.
  </p>
  <ul>
    <li><code>GET /api/health</code> — liveness</li>
    <li><code>GET /api/notes</code> — list notes</li>
    <li><code>POST /api/notes</code> — create <code>{title, body}</code></li>
    <li><code>GET|PUT|DELETE /api/notes/{id}</code></li>
  </ul>
  <p>
    <button id="load">GET /api/notes</button>
    <button id="add">POST a note</button>
  </p>
  <pre id="out">Click a button to call the live API…</pre>
  <script>
    const out = document.getElementById("out");
    const show = (v) => { out.textContent = JSON.stringify(v, null, 2); };
    const fail = (e) => { out.textContent = "Error: " + e; };
    document.getElementById("load").onclick = () =>
      fetch("/api/notes").then((r) => r.json()).then(show).catch(fail);
    document.getElementById("add").onclick = () =>
      fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "From the browser", body: "Created at " + new Date().toISOString() }),
      }).then((r) => r.json()).then(show).catch(fail);
  </script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add packages/registry/nginx-python-vfs/app/static/index.html
git commit -m "Packages: Add static demo page for the nginx-python example"
```

---

## Task 4: Package manifest (`package.toml` + `build.toml`)

**Files:**
- Create: `packages/registry/nginx-python-vfs/package.toml`
- Create: `packages/registry/nginx-python-vfs/build.toml`

**Interfaces:**
- Produces: package `nginx-python-vfs` with output `nginx-python-vfs.vfs.zst`;
  build script `images/vfs/scripts/build-nginx-python-vfs-image.sh`.

- [ ] **Step 1: Write `package.toml`**

Use the ABI value from Task 1 (shown here as `43`). Model on
`packages/registry/nginx-php-vfs/package.toml`:
```toml
kind = "program"
name = "nginx-python-vfs"
version = "0.1.0"
kernel_abi = 43
depends_on = [
  "shell@0.1.0",
  "nginx@1.24.0",
  "cpython@3.13.3",
  "dinit@0.19.4",
]

# Composite VFS image for the nginx + Python (wsgiref) browser demo. nginx
# reverse-proxies /api/ to a standard-library Python WSGI app backed by SQLite.
[source]
url = "https://github.com/Automattic/kandelo"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
provider = "repository"

[license]
spdx = "GPL-2.0-or-later"
url = "https://github.com/Automattic/kandelo/blob/main/COPYING"

[build]
script_path = "images/vfs/scripts/build-nginx-python-vfs-image.sh"

[[outputs]]
name = "nginx-python-vfs"
wasm = "nginx-python-vfs.vfs.zst"
# This output is a VFS image, not a Wasm executable.
fork_instrumentation = "disabled"
```
Note: unlike nginx-php, there is no kernel dependency here — the Python
image needs no opcache prewarm (which was the only consumer of the kernel
in the PHP builder). If Task 1 found nginx/cpython need a `kernel_abi`
bump, apply those bumps in their own `package.toml`/`build.toml` as part
of Task 1's follow-up, not here.

- [ ] **Step 2: Write `build.toml`**

Model on `packages/registry/nginx-php-vfs/build.toml`, but list this
example's own builder + app sources and drop the php-specific
`opcache-prewarm.ts`:
```toml
script_path = "images/vfs/scripts/build-nginx-python-vfs-image.sh"
inputs = [
  "images/vfs/scripts/build-nginx-python-vfs-image.sh",
  "images/vfs/scripts/build-nginx-python-vfs-image.ts",
  "images/vfs/scripts/dinit-image-helpers.ts",
  "images/vfs/scripts/kandelo-demo-config.ts",
  "images/vfs/scripts/kandelo-demo-guides.ts",
  "images/vfs/scripts/package-shell-vfs-build.ts",
  "images/vfs/scripts/shell-lazy-archives.ts",
  "images/vfs/scripts/source-rootfs-shell-overlay.ts",
  "images/vfs/scripts/vfs-image-helpers.ts",
  "images/vfs/lib/init/shell-binaries.ts",
  "images/rootfs/etc/services",
  "packages/registry/nginx-python-vfs/app",
  # The image builder reaches shared VFS modules transitively; track the
  # whole tree so cache identity cannot outlive either contract.
  "host/src",
  "web-libs/kandelo-session/src/demo-config.ts",
  "web-libs/kandelo-session/src/demo-guides.ts",
  "web-libs/kandelo-session/src/vfs-capacity.ts",
]
repo_url = "https://github.com/Automattic/kandelo.git"
commit = "UNPUBLISHED"
revision = 1
```

- [ ] **Step 3: Verify the manifests parse**

Run:
```bash
scripts/dev-shell.sh bash -lc 'cargo run -p xtask --quiet -- build-deps resolve nginx-python-vfs --dry-run 2>&1 | head -40'
```
Expected: the resolver recognizes the package and its dependencies (it may
report that the output needs building — that is fine; a parse/identity
error is not). If `--dry-run` is unsupported, instead run the resolve and
confirm it reaches the build step rather than failing on manifest parse.

- [ ] **Step 4: Commit**

```bash
git add packages/registry/nginx-python-vfs/package.toml packages/registry/nginx-python-vfs/build.toml
git commit -m "Packages: Declare the nginx-python-vfs composite image package"
```

---

## Task 5: The demo guide

Add a `nginxPythonGuide()` alongside `nginxPhpGuide()` and wire its
dispatch cases. This is consumed by the builder (Task 6) and the gallery.

**Files:**
- Modify: `web-libs/kandelo-session/src/demo-guides.ts`
- Modify: `images/vfs/scripts/kandelo-demo-guides.ts` (re-export)

**Interfaces:**
- Produces: `export function nginxPythonGuide(): DemoGuideConfig`, and
  `"nginx-python"` cases in `builtinDemoGuide` / `builtinDemoPresentation`.

- [ ] **Step 1: Add the script constant + guide function**

In `web-libs/kandelo-session/src/demo-guides.ts`, after the
`nginxPhpScript` constant (~line 49) and the `nginxPhpGuide` function
(~line 213), add:
```typescript
const nginxPythonScript = `curl -i http://127.0.0.1:8080/ | head -40
echo "--- list notes (JSON via Python) ---"
curl -s http://127.0.0.1:8080/api/notes
echo
echo "--- create a note ---"
curl -s -X POST http://127.0.0.1:8080/api/notes \\
  -H 'Content-Type: application/json' \\
  -d '{"title":"Hello","body":"from curl"}'
echo`;

export function nginxPythonGuide(): DemoGuideConfig {
  return scriptGuide(
    "nginx + Python demo",
    "Call a real Python (wsgiref) JSON API over SQLite, proxied by nginx.",
    [
      actionGroup("Service", [
        action("curl-home", "Fetch page", "Fetch the static page through nginx.", "terminal.run", "curl -i http://127.0.0.1:8080/ | head -40"),
        action("list-notes", "List notes", "GET the JSON notes list from Python.", "terminal.run", "curl -s http://127.0.0.1:8080/api/notes; echo"),
        action("create-note", "Create note", "POST a new note as JSON.", "terminal.run", "curl -s -X POST http://127.0.0.1:8080/api/notes -H 'Content-Type: application/json' -d '{\\"title\\":\\"Hello\\",\\"body\\":\\"from curl\\"}'; echo"),
        action("py-version", "Python", "Print the Python version.", "terminal.run", "PYTHONHOME=/usr /usr/bin/python3 --version"),
      ]),
    ],
    {
      title: "Service check",
      language: "sh",
      initialText: nginxPythonScript,
    },
  );
}
```

- [ ] **Step 2: Add the dispatch cases**

In the same file, `builtinDemoGuide` switch (~line 59) add:
```typescript
    case "nginx-python":
      return nginxPythonGuide();
```
And in `builtinDemoPresentation` where `"nginx-php"` is grouped under
`genericDemoPresentation("web")` (~lines 77-82), add `"nginx-python"` to
the same group (extend the case list so it returns
`genericDemoPresentation("web")`).

- [ ] **Step 3: Re-export from the scripts-side module**

In `images/vfs/scripts/kandelo-demo-guides.ts`, add `nginxPythonGuide` to
the re-export list next to `nginxPhpGuide`.

- [ ] **Step 4: Typecheck the web-libs + scripts**

Run:
```bash
scripts/dev-shell.sh bash -lc 'npx tsc -p web-libs/kandelo-session/tsconfig.json --noEmit 2>&1 | head -30 || true'
```
Expected: no new type errors referencing `nginxPythonGuide` /
`nginx-python`. (If that tsconfig path differs, use the repo's standard
typecheck command; the point is: the new symbol resolves and the switch is
exhaustive.)

- [ ] **Step 5: Commit**

```bash
git add web-libs/kandelo-session/src/demo-guides.ts images/vfs/scripts/kandelo-demo-guides.ts
git commit -m "Browser: Add nginx-python demo guide"
```

---

## Task 6: The VFS image builder (`.ts` + `.sh`)

The crux. Derive from the shell base, lay down the interpreter + stdlib +
nginx + the app, write nginx.conf, wire dinit, write the demo config, and
save the image.

**Files:**
- Create: `images/vfs/scripts/build-nginx-python-vfs-image.ts`
- Create: `images/vfs/scripts/build-nginx-python-vfs-image.sh`

**Interfaces:**
- Consumes: `loadShellBaseFileSystem`, `loadShellBaseFileSystemFromImage`,
  `saveShellDerivedVfsImage` (`package-shell-vfs-build.ts`);
  `ensureDirRecursive`, `writeVfsFile`, `writeVfsBinary`, `symlink`
  (`host/src/vfs/image-helpers`); `addDinitInit`, `DinitBinaryInputs`
  (`dinit-image-helpers`); `webPresentation`, `writeKandeloDemoConfig`
  (`kandelo-demo-config`); `nginxPythonGuide` (`kandelo-demo-guides`);
  `resolveBinary`, `findRepoRoot` (`host/src/binary-resolver`);
  `SHELL_DERIVED_VFS_PROFILE_MAX_BYTES` (`web-libs/.../vfs-capacity`).
- Produces: `export interface NginxPythonVfsImageBuildInputs` and
  `export async function buildNginxPythonVfsImage(inputs): Promise<void>`,
  consumed by `staged-product-inputs.ts` (Task 7).

- [ ] **Step 1: Write the builder module**

`images/vfs/scripts/build-nginx-python-vfs-image.ts`:
```ts
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsFile,
  writeVfsBinary,
  symlink,
} from "../../../host/src/vfs/image-helpers";
import { resolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import { addDinitInit, type DinitBinaryInputs } from "./dinit-image-helpers";
import {
  loadShellBaseFileSystem,
  loadShellBaseFileSystemFromImage,
  saveShellDerivedVfsImage,
} from "./package-shell-vfs-build";
import { SHELL_DERIVED_VFS_PROFILE_MAX_BYTES } from "../../../web-libs/kandelo-session/src/vfs-capacity";
import { webPresentation, writeKandeloDemoConfig } from "./kandelo-demo-config";
import { nginxPythonGuide } from "./kandelo-demo-guides";

const PYTHON_STDLIB = "python3.13";
const APP_DIR = join(
  findRepoRoot(),
  "packages",
  "registry",
  "nginx-python-vfs",
  "app",
);
const OUT_FILE = join(
  findRepoRoot(),
  "apps",
  "browser-demos",
  "public",
  "nginx-python-vfs.vfs.zst",
);
const DEMO_UID = 1000;
const DEMO_GID = 1000;

// nginx serves the static app root and reverse-proxies /api/ to the Python
// WSGI server on 127.0.0.1:8000.
const NGINX_CONF = `user root;
daemon off;
master_process on;
worker_processes 2;
error_log stderr info;
pid /tmp/nginx.pid;

events {
    worker_connections 64;
    use poll;
}

http {
    access_log /dev/stderr;
    client_body_temp_path /tmp/nginx_client_temp;
    proxy_temp_path /tmp/nginx_proxy_temp;

    types {
        text/html   html htm;
        text/css    css;
        text/javascript js;
        application/json json;
        image/svg+xml svg;
    }
    default_type application/octet-stream;

    server {
        listen 8080;
        server_name localhost;
        root /srv/notes/static;
        index index.html;

        location / {
        }

        location /api/ {
            proxy_pass http://127.0.0.1:8000;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $remote_addr;
        }
    }
}
`;

// Recursively copy a host directory tree into the VFS, sorted for
// reproducibility, rejecting symlinks. Returns the file count.
function copyTreeSorted(
  fs: MemoryFileSystem,
  hostDir: string,
  vfsDir: string,
): number {
  ensureDirRecursive(fs, vfsDir);
  let count = 0;
  const entries = readdirSync(hostDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`unexpected symlink in tree: ${join(hostDir, entry.name)}`);
    }
    const hostPath = join(hostDir, entry.name);
    const vfsPath = `${vfsDir}/${entry.name}`;
    if (entry.isDirectory()) {
      count += copyTreeSorted(fs, hostPath, vfsPath);
    } else {
      writeVfsBinary(fs, vfsPath, new Uint8Array(readFileSync(hostPath)), 0o644);
      count += 1;
    }
  }
  return count;
}

export interface NginxPythonVfsImageBuildInputs {
  shellImage?: Uint8Array;
  nginx: Uint8Array;
  python: Uint8Array;
  // Host directory holding the extracted CPython runtime closure: expects
  // <runtimeRoot>/lib/python3.13 and <runtimeRoot>/share/licenses/cpython/LICENSE.
  runtimeRoot: string;
  dinit?: DinitBinaryInputs;
  outputPath: string;
}

export async function buildNginxPythonVfsImage(
  inputs: NginxPythonVfsImageBuildInputs,
): Promise<void> {
  const fs = inputs.shellImage
    ? await loadShellBaseFileSystemFromImage(
        inputs.shellImage,
        SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
      )
    : await loadShellBaseFileSystem(SHELL_DERIVED_VFS_PROFILE_MAX_BYTES);

  fs.chmod("/tmp", 0o777);
  ensureDirRecursive(fs, "/usr/sbin");
  ensureDirRecursive(fs, "/usr/bin");
  ensureDirRecursive(fs, `/usr/lib/${PYTHON_STDLIB}`);
  ensureDirRecursive(fs, "/usr/share/licenses/cpython");
  ensureDirRecursive(fs, "/etc/nginx");
  ensureDirRecursive(fs, "/srv/notes");
  ensureDirRecursive(fs, "/var/lib/notes");
  ensureDirRecursive(fs, "/var/log");
  ensureDirRecursive(fs, "/tmp/nginx_client_temp");
  ensureDirRecursive(fs, "/tmp/nginx_proxy_temp");

  // nginx binary.
  writeVfsBinary(fs, "/usr/sbin/nginx", inputs.nginx, 0o755);

  // CPython interpreter + aliases + standard library + license.
  writeVfsBinary(fs, "/usr/bin/python3", inputs.python, 0o755);
  symlink(fs, "/usr/bin/python3", "/usr/bin/python");
  symlink(fs, "/usr/bin/python3", "/usr/bin/cpython");
  const stdlibRoot = join(inputs.runtimeRoot, "lib", PYTHON_STDLIB);
  const stdlibCount = copyTreeSorted(fs, stdlibRoot, `/usr/lib/${PYTHON_STDLIB}`);
  const license = join(
    inputs.runtimeRoot, "share", "licenses", "cpython", "LICENSE",
  );
  writeVfsBinary(
    fs, "/usr/share/licenses/cpython/LICENSE",
    new Uint8Array(readFileSync(license)), 0o644,
  );

  // The Python app (app.py, schema.sql, seed.sql, static/index.html).
  const appCount = copyTreeSorted(fs, APP_DIR, "/srv/notes");

  // nginx config.
  writeVfsFile(fs, "/etc/nginx/nginx.conf", NGINX_CONF);

  // Make the app tree and its writable data dir owned by the demo user.
  fs.chown("/srv/notes", DEMO_UID, DEMO_GID);
  fs.chown("/var/lib/notes", DEMO_UID, DEMO_GID);
  fs.chmod("/var/lib/notes", 0o755);

  // dinit: nginx depends on notes-app so the WSGI port is up first.
  addDinitInit(fs, [
    {
      name: "notes-app",
      type: "process",
      command: "/usr/bin/python3 /srv/notes/app.py",
      logfile: "/var/log/notes-app.log",
      restart: false,
    },
    {
      name: "nginx",
      type: "process",
      command: "/usr/sbin/nginx -c /etc/nginx/nginx.conf",
      dependsOn: ["notes-app"],
      logfile: "/var/log/nginx.log",
      restart: false,
    },
  ], { binaries: inputs.dinit });

  writeKandeloDemoConfig(fs, {
    version: 1,
    profiles: {
      "nginx-python": {
        presentation: webPresentation(),
        guide: nginxPythonGuide(),
      },
    },
  });

  await saveShellDerivedVfsImage(fs, inputs.outputPath);
  console.log(
    `nginx-python VFS: interpreter + ${stdlibCount} stdlib files + ${appCount} app files`,
  );
}

async function main(): Promise<void> {
  const shellRoot = process.env.WASM_POSIX_DEP_SHELL_DIR;
  const nginxRoot = process.env.WASM_POSIX_DEP_NGINX_DIR;
  const dinitRoot = process.env.WASM_POSIX_DEP_DINIT_DIR;
  const runtimeRoot = process.env.KANDELO_PYTHON_RUNTIME_ROOT;
  const pythonWasm = process.env.KANDELO_PYTHON_WASM;
  if (!runtimeRoot || !pythonWasm) {
    throw new Error(
      "KANDELO_PYTHON_RUNTIME_ROOT and KANDELO_PYTHON_WASM are required",
    );
  }
  await buildNginxPythonVfsImage({
    shellImage: shellRoot
      ? new Uint8Array(readFileSync(join(shellRoot, "shell.vfs.zst")))
      : undefined,
    nginx: new Uint8Array(
      readFileSync(
        nginxRoot ? join(nginxRoot, "nginx.wasm") : resolveBinary("programs/nginx.wasm"),
      ),
    ),
    python: new Uint8Array(readFileSync(pythonWasm)),
    runtimeRoot,
    dinit: dinitRoot
      ? {
          dinit: new Uint8Array(readFileSync(join(dinitRoot, "dinit.wasm"))),
          dinitctl: new Uint8Array(readFileSync(join(dinitRoot, "dinitctl.wasm"))),
        }
      : undefined,
    outputPath: process.argv[2] ?? OUT_FILE,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  void main();
}
```

- [ ] **Step 2: Write the shell wrapper**

`images/vfs/scripts/build-nginx-python-vfs-image.sh` (mirrors the
python-vfs wrapper's cpython resolution + unzip, plus nginx/dinit dirs;
mirrors the nginx-php wrapper's product-manifest short-circuit and local
mirror install):
```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

if [ "$#" -ne 0 ] && [ "${1:-}" = "--vfs-product-manifest" ]; then
  exec node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" \
    "$SCRIPT_DIR/staged-product-inputs.ts" browser-nginx-python "$@"
fi

echo "==> Building nginx + Python VFS image..."

WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$(mktemp -d /tmp/kandelo-nginx-python.XXXXXX)}"
VFS_DIR="$REPO_ROOT/apps/browser-demos/public"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  : "${WASM_POSIX_DEP_WORK_DIR:?resolver VFS builds require WASM_POSIX_DEP_WORK_DIR}"
  VFS_DIR="$WASM_POSIX_DEP_WORK_DIR"
fi
VFS="$VFS_DIR/nginx-python-vfs.vfs.zst"

# Resolve CPython (interpreter + runtime zip).
CPYTHON_DIR="${WASM_POSIX_DEP_CPYTHON_DIR:-}"
if [ -z "$CPYTHON_DIR" ]; then
  HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
  CPYTHON_DIR="$(cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve cpython)"
fi
PYTHON_WASM="$CPYTHON_DIR/python.wasm"
PYTHON_RUNTIME="$CPYTHON_DIR/python-runtime.zip"
[ -f "$PYTHON_WASM" ] && [ -f "$PYTHON_RUNTIME" ] || {
  echo "ERROR: cpython must provide python.wasm and python-runtime.zip: $CPYTHON_DIR" >&2
  exit 1
}
RUNTIME_ROOT="$WORK_DIR/python-runtime"
rm -rf "$RUNTIME_ROOT"; mkdir -p "$RUNTIME_ROOT"
unzip -q "$PYTHON_RUNTIME" -d "$RUNTIME_ROOT"

KANDELO_PYTHON_RUNTIME_ROOT="$RUNTIME_ROOT" \
KANDELO_PYTHON_WASM="$PYTHON_WASM" \
  npx tsx "$SCRIPT_DIR/build-nginx-python-vfs-image.ts" "$VFS"

[ -f "$VFS" ] || { echo "ERROR: $VFS not produced" >&2; exit 1; }
echo "==> Done."; ls -lh "$VFS"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
  export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary nginx-python-vfs "$VFS"
```
Then `chmod +x images/vfs/scripts/build-nginx-python-vfs-image.sh`.

- [ ] **Step 3: Typecheck the builder**

Run:
```bash
scripts/dev-shell.sh bash -lc 'npx tsc --noEmit images/vfs/scripts/build-nginx-python-vfs-image.ts 2>&1 | head -30 || true'
```
Expected: no type errors from the new file (use the repo's standard
scripts typecheck if a bare `tsc` complains about config; the goal is that
every imported symbol resolves with the signatures in the Interfaces
block).

- [ ] **Step 4: Commit**

```bash
git add images/vfs/scripts/build-nginx-python-vfs-image.ts images/vfs/scripts/build-nginx-python-vfs-image.sh
git commit -m "Browser: Add nginx-python VFS image builder"
```

---

## Task 7: Staged product build wiring

Register the product in the canonical (resolver) build path so
`--vfs-product-manifest` builds work.

**Files:**
- Modify: `images/vfs/scripts/staged-product-inputs.ts`

- [ ] **Step 1: Add the builder-map entry**

In `SERVICE_PRODUCT_BUILDERS` (~lines 205-211), add:
```typescript
  ["browser-nginx-python", "images/vfs/scripts/build-nginx-python-vfs-image.sh"],
```

- [ ] **Step 2: Import the builder**

Add near the other `buildXxxVfsImage` imports:
```typescript
import { buildNginxPythonVfsImage } from "./build-nginx-python-vfs-image";
```

- [ ] **Step 3: Add the build case**

In the `switch (productId)` inside `buildStagedBrowserService` (~lines
342-355), mirror the browser-python extraction (materialize the runtime
zip in-process) combined with the nginx-php service inputs:
```typescript
    case "browser-nginx-python": {
      const runtimeRoot = join(work, "python-runtime");
      materializeArchiveContents(
        packageBytes("cpython", "python-runtime"),
        runtimeRoot,
        "browser-nginx-python runtime",
      );
      await buildNginxPythonVfsImage({
        shellImage,
        nginx: packageBytes("nginx", "nginx"),
        python: packageBytes("cpython", "cpython"),
        runtimeRoot,
        dinit: dinit(),
        outputPath: invocation.outputPath,
      });
      break;
    }
```
Note: confirm the local `work` temp-dir variable name used by
`buildStagedBrowserService` (the browser-python case uses `work` in
`buildStagedStandaloneProduct`); if the browser-service function exposes a
different scratch-dir binding, use that name. `materializeArchiveContents`
and `packageBytes`/`dinit` are already in scope in this module.

- [ ] **Step 4: Typecheck**

Run:
```bash
scripts/dev-shell.sh bash -lc 'npx tsc --noEmit images/vfs/scripts/staged-product-inputs.ts 2>&1 | head -30 || true'
```
Expected: no new type errors; `ServiceProductId` now includes
`"browser-nginx-python"`.

- [ ] **Step 5: Commit**

```bash
git add images/vfs/scripts/staged-product-inputs.ts
git commit -m "Browser: Wire nginx-python into the staged product build"
```

---

## Task 8: The product manifest

**Files:**
- Create: `images/vfs/products/browser-nginx-python.toml`

- [ ] **Step 1: Write the manifest**

Model on `images/vfs/products/browser-nginx-php.toml`, swapping the php
package for cpython, adding `PYTHONHOME`, and renaming outputs + evidence:
```toml
schema = 1
id = "browser-nginx-python"
architecture = "wasm32"
output = "nginx-python-vfs.vfs.zst"
builder = "images/vfs/scripts/build-nginx-python-vfs-image.sh"

[[composition.product]]
id = "browser-main-shell"
materialization = "embedded"

[[software.package]]
name = "nginx"
outputs = ["nginx"]
source_roles = []
role = "runtime"
materialization = "embedded"

[[software.package]]
name = "cpython"
outputs = ["cpython", "python-runtime"]
source_roles = []
role = "runtime"
materialization = "embedded"

[[software.package]]
name = "dinit"
outputs = ["dinit", "dinitctl"]
source_roles = []
role = "runtime"
materialization = "embedded"

[[mounts]]
path = "/"
source = "built-image"
readonly = false

[[mounts]]
path = "/tmp"
source = "scratch"
mode = "1777"
uid = 0
gid = 0
ephemeral = true

[boot]
argv = ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl", "nginx"]
cwd = "/root"
uid = 0
gid = 0

[boot.env]
HOME = "/root"
LOGNAME = "root"
PATH = "/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin"
PYTHONHOME = "/usr"
PYTHONDONTWRITEBYTECODE = "1"
TMPDIR = "/tmp"
USER = "root"

[evidence.node]
test = "nginx-python-vfs-node-startup"

[evidence.browser]
test = "nginx-python-vfs-browser-startup"
```
Note: no `[[software.toolchain]]` kernel-wasm entry (that existed only for
PHP opcache prewarm). Confirm `cpython`'s `python-runtime` selector is the
correct output name the manifest validator expects for the runtime zip
(it matches `packageBytes("cpython", "python-runtime")` in Task 7 and the
browser-python product); if the validator names it differently, use that
name consistently in both places.

- [ ] **Step 2: Regenerate + validate the product catalog**

Run:
```bash
scripts/dev-shell.sh bash -lc 'cargo run -p xtask --quiet -- vfs products generate'
scripts/dev-shell.sh bash -lc 'cargo run -p xtask --quiet -- vfs products check --source images/vfs/products --generated images/vfs/products/generated/catalog.json'
```
Expected: generate rewrites the (gitignored) catalog; check passes with
`browser-nginx-python` present and package-backed.

- [ ] **Step 3: Commit**

```bash
git add images/vfs/products/browser-nginx-python.toml
git commit -m "Browser: Add browser-nginx-python product manifest"
```

---

## Task 9: Gallery + registry lockstep wiring

Add the preset and every canonical projection the check scripts enforce
together. Do all edits, then run the checks once.

**Files:**
- Modify: `apps/browser-demos/pages/kandelo/presets.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/dinit-boot-status.ts`
- Modify: `run.sh`

- [ ] **Step 1: Add the preset**

In `apps/browser-demos/pages/kandelo/presets.ts`, add to `PRESET_LIBRARY`
(keep the load-bearing 4-space indentation on the `id:` line):
```typescript
  {
    id: "nginx-python",
    title: "nginx + Python",
    summary: "nginx reverse-proxying to a Python (wsgiref) JSON API over SQLite.",
    base: SHELL_BASE,
    packages: ["dinit@local", "nginx@local", "cpython@local", "bash@local", "coreutils@local"],
    accent: "#4b8bbe",
    glyph: "python",
    bootCommand: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl", "nginx"],
    estimatedUrlBytes: 944,
  },
```

- [ ] **Step 2: Add the Pages registry entries (source + generated)**

In `pages-vfs-products.toml` add (products are sorted by id):
```toml
[[products]]
id = "browser-nginx-python"
load = "lazy"
```
In `pages-vfs-products.generated.json` add `{"id":"browser-nginx-python","load":"lazy"}`
in sorted-by-id position, keeping the file byte-canonical (no spaces,
sorted, trailing newline). It must equal the canonical projection of the
`.toml`.

- [ ] **Step 3: Add the gallery entry**

In `pages-vfs-product-gallery.json` add, in sorted position:
```json
{"gallery_entries":["nginx-python"],"id":"browser-nginx-python","vfs_image":"nginx-python"}
```

- [ ] **Step 4: Wire `live-setup.ts` (all sites)**

Mirror every `nginx-php`/`browser-nginx-php` reference with an
`nginx-python`/`browser-nginx-python` sibling:
1. `OPTIONAL_BINARY_URLS` — add the two `import.meta.glob(...)` pairs for
   `local-binaries/programs/wasm32/nginx-python-vfs.vfs.zst` and
   `binaries/programs/wasm32/nginx-python-vfs.vfs.zst`.
2. `LiveVfsImage` union — add `"nginx-python"`.
3. `PagesVfsProductId` union — add `"browser-nginx-python"`.
4. `VFS_SOURCES` — add an `"nginx-python"` entry (kind `optional-binary`,
   label `nginx-python-vfs.vfs.zst`, `productId: "browser-nginx-python"`,
   the two relPaths).
5. `LIVE_DEMO_IDS` tuple — add `"nginx-python"`.
6. `LIVE_DEMO_SPECS` — add `"nginx-python"` mirroring the nginx-php spec
   (`image: "nginx-python"`, `network: true`, `init.argv: DINIT_NGINX_ARGV`,
   `env: "service"`, `web.requiredPorts: [HTTP_PORT]`,
   `requiredServices: [...REQUIRED_DINIT_SERVICES["nginx-python"]]`).
7. `DEFAULT_DEMO_FOR_VFS_IMAGE` — add `"nginx-python": "nginx-python"`.
8. `WEB_BOOT_LOG_DEMO_IDS` — add `"nginx-python"`.
Do NOT copy the php-fpm-specific staging block (`/etc/php-fpm.conf` +
`/var/cache/opcache`); the Python image needs none of it.

- [ ] **Step 5: Add the required-services entry**

In `dinit-boot-status.ts`, add `REQUIRED_DINIT_SERVICES["nginx-python"]`
listing the services that must be up: `["notes-app", "nginx"]` (match the
existing nginx-php shape/order).

- [ ] **Step 6: Add the build target to `run.sh`**

Add `nginx-python-vfs` to the `BROWSER_DEPS` array and a build-target
function mirroring the `nginx-php-vfs` one (so
`checkBrowserDependencies` in `check-pages-vfs-product-registry.mjs`
passes). Follow the exact pattern of the sibling entry already in
`run.sh`.

- [ ] **Step 7: Run the registry checks**

Run:
```bash
scripts/dev-shell.sh bash -lc 'node scripts/check-pages-vfs-product-registry.mjs'
```
Expected: PASS — preset/gallery/registry parity holds, load↔import
coupling is satisfied (lazy + glob present), and canonical JSON matches.
Fix any reported mismatch (usually canonical ordering or a missing glob)
and re-run until green.

- [ ] **Step 8: Commit**

```bash
git add apps/browser-demos/pages/kandelo/presets.ts \
  apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml \
  apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json \
  apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json \
  apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts \
  apps/browser-demos/pages/kandelo/kernel-host/dinit-boot-status.ts \
  run.sh
git commit -m "Browser: Wire nginx-python demo into the gallery and registry"
```

---

## Task 10: Test registration (evidence)

**Files:**
- Modify: `tests/vfs-products.toml`
- Modify: `tests/vfs-products.generated.json`

- [ ] **Step 1: Add the registration (source)**

In `tests/vfs-products.toml`, add (matching the manifest evidence names
from Task 8):
```toml
[[registrations]]
product = "browser-nginx-python"
node = ["nginx-python-vfs-node-startup"]
browser = ["nginx-python-vfs-browser-startup"]

[registrations.applicability]
abi = "required"
kernel = "required"
host = "required"
```

- [ ] **Step 2: Update the canonical projection**

Regenerate or hand-edit `tests/vfs-products.generated.json` so it is the
byte-canonical projection of the `.toml` (sorted, trailing newline),
including the new registration.

- [ ] **Step 3: Validate**

Run:
```bash
scripts/dev-shell.sh bash -lc 'cargo run -p xtask --quiet -- vfs products check --source images/vfs/products --generated images/vfs/products/generated/catalog.json'
scripts/dev-shell.sh bash -lc 'node scripts/check-pages-vfs-product-registry.mjs'
```
Expected: both PASS with the new test registration recognized.

- [ ] **Step 4: Commit**

```bash
git add tests/vfs-products.toml tests/vfs-products.generated.json
git commit -m "Browser: Register nginx-python startup evidence tests"
```

---

## Task 11: Build the image and verify in-Kandelo

**Files:** none (build + verification only).

- [ ] **Step 1: Build the composite image through the resolver**

Run:
```bash
scripts/dev-shell.sh bash -lc 'cargo run -p xtask --quiet -- build-deps build nginx-python-vfs'
```
Expected: resolves shell/nginx/cpython/dinit, unzips the runtime, runs the
`.ts` builder, and produces `nginx-python-vfs.vfs.zst` (path printed by
`ls -lh`). If a prerequisite is missing, build it (Task 1, Step 3) and
retry. (If the exact `build-deps` subcommand differs, use the repo's
standard single-package build invocation — the goal is producing the
`.vfs.zst` through the normal path.)

- [ ] **Step 2: Boot the image on the Node host and curl the API**

Boot the built image under the Node host (mirror how an nginx-php
node-startup test or the demo `serve.ts` boots a VFS image) and exercise
every endpoint. The concrete checks, whatever harness runs them:
```bash
# Against the booted image's nginx on 8080:
curl -sf http://127.0.0.1:8080/            | head -5          # static page
curl -sf http://127.0.0.1:8080/api/health                     # {"status":"ok"}
curl -sf http://127.0.0.1:8080/api/notes                      # seeded array
curl -sf -X POST http://127.0.0.1:8080/api/notes \
  -H 'Content-Type: application/json' -d '{"title":"t","body":"b"}'  # 201
curl -sf http://127.0.0.1:8080/api/notes/1                    # one note
curl -s  -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/notes/999999  # 404
```
Expected: health returns `{"status":"ok"}`; list returns the two seeded
notes; POST returns 201 with the created row; missing id returns 404.
Record the actual output. If nginx returns 502, the Python service did not
come up — check `/var/log/notes-app.log` and the dinit ordering before
proceeding (do not mask a 502).

- [ ] **Step 3: Add/confirm the node-startup evidence test**

Ensure a Node evidence test named `nginx-python-vfs-node-startup` exists
(mirror the `nginx-php-vfs-node-startup` test file/location). It should
boot the image and assert the health + list endpoints respond. Run it:
```bash
scripts/dev-shell.sh bash -lc 'npx vitest run -t "nginx-python-vfs-node-startup" 2>&1 | tail -30'
```
Expected: the test passes. Commit the test file:
```bash
git add -A && git commit -m "Browser: Add nginx-python node-startup evidence test"
```

---

## Task 12: Browser verification

**Files:** possibly the `nginx-python-vfs-browser-startup` test.

- [ ] **Step 1: Build browser deps and launch**

Run:
```bash
scripts/dev-shell.sh bash -lc './run.sh browser'
```
Expected: the browser demo app builds (including the new
`nginx-python-vfs` dependency) and serves. Use a unique `--port N
--strictPort` if the default is taken (do not kill another agent's
server).

- [ ] **Step 2: Load the demo and confirm the live API in-browser**

Open the `nginx-python` demo (via the gallery preset or
`/?demo=nginx-python` equivalent). Confirm:
- the static page renders,
- the "GET /api/notes" button shows the seeded JSON,
- the "POST a note" button returns a 201 JSON body.
Confirm via a browser evidence test where possible
(`nginx-python-vfs-browser-startup`, mirroring the nginx-php browser
test). Per the browser contract, code reasoning is not sufficient — this
must actually run in-browser.

- [ ] **Step 3: Run the browser evidence test**

Run the Playwright/browser evidence test:
```bash
scripts/dev-shell.sh bash -lc 'npx playwright test nginx-python-vfs-browser-startup 2>&1 | tail -30'
```
Expected: PASS. (Use the repo's actual browser-evidence command if it
differs; the point is a real in-browser assertion.)

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Browser: Add nginx-python browser-startup evidence test"
```

---

## Task 13: Documentation + final report

**Files:**
- Modify: relevant doc under `docs/` if the example warrants a mention
  (e.g. a demos/gallery listing). Do not describe aspirational behavior.

- [ ] **Step 1: Document the example**

If there is a demo/gallery index or `docs/browser-support.md` section
listing demos, add the `nginx + Python` example truthfully: what it is
(stdlib wsgiref JSON API behind nginx), its ephemeral SQLite persistence,
and the single-request-serialization note is not needed (it is threaded).
Skip if no such index exists.

- [ ] **Step 2: Final validation sweep**

Run the full check set and record exact results:
```bash
scripts/dev-shell.sh bash -lc 'cargo run -p xtask --quiet -- vfs products check --source images/vfs/products --generated images/vfs/products/generated/catalog.json'
scripts/dev-shell.sh bash -lc 'node scripts/check-pages-vfs-product-registry.mjs'
cd packages/registry/nginx-python-vfs/app && python3 -m unittest test_app -v
```
Expected: all green.

- [ ] **Step 3: Commit and report**

```bash
git add -A
git commit -m "Docs: Note the nginx-python example in the demo docs"
```
Report exactly what was built and run (image build, in-Kandelo curl
output, node + browser evidence, registry checks), and anything not run.

---

## Notes on tricky spots (read before implementing)

- **The two build paths must both work.** The `.sh` wrapper + `.ts`
  `main()` path (env `WASM_POSIX_DEP_*_DIR` + `KANDELO_PYTHON_*`) is used
  by direct/local builds; the `staged-product-inputs.ts` case (in-process
  `materializeArchiveContents` + `packageBytes`) is used by the canonical
  resolver/product build. Task 6 covers the first, Task 7 the second.
  Keep the `buildNginxPythonVfsImage` inputs identical across both.
- **nginx↔Python startup race.** `dependsOn` orders start but does not
  wait for the socket to listen. `wsgiref` binds at process start so the
  window is tiny, but if the in-Kandelo run shows an intermittent 502,
  add a readiness gate: `dinit-image-helpers` exports
  `addPathReadinessService` — insert a service that waits for the app's
  port/socket and make `nginx` `dependsOn` it. Prefer the simple form
  first; only add readiness if a race actually appears (truthful failure,
  then fix).
- **SQLite threading.** The app opens a fresh connection per request
  (`_connect()`), which is the safe pattern under `ThreadingWSGIServer`.
  Do not switch to a shared module-level connection.
- **`/var/lib/notes` must be writable at runtime.** The manifest mounts
  `/` as `built-image` with `readonly = false`, so runtime writes land in
  the image overlay and reset on reload — this is the intended ephemeral
  behavior. Verify POST actually persists within a session in Task 11.
- **ABI.** If Task 1 found nginx/cpython stale at the current ABI, their
  rebuild (and any `kernel_abi` bump in their manifests) is a prerequisite
  for Task 11 — do it before claiming the build works, and never shim.
