# Design: nginx → Python (WSGI) Notes JSON API example

Date: 2026-09-21
Status: Approved design; pending implementation plan
Contract touched: Package And Build; Browser And User (demo wiring);
Host Runtime parity (Node + browser)

## Why

Kandelo ships interpreter packages (cpython) and a working
nginx → PHP-FPM demo, but it has no example of a **server-side Python
web application** running through the normal platform path. Developers
evaluating Kandelo for Python workloads have nothing that shows a real
Python web server serving dynamic requests on the kernel.

This example fills that gap with a genuinely real — not toy — Python
web app: nginx reverse-proxying to a standard-library `wsgiref` WSGI
application that serves a JSON REST API backed by the standard-library
`sqlite3` module. It uses **no third-party packages** (no pip), so the
entire stack rides the SDK, resolver, libc, VFS image, sockets,
fork/exec, and kernel exactly as user software normally does. Its
value is as platform feedback and as a reviewable reference: if a real
stdlib Python web app cannot serve requests through nginx on Kandelo,
that is a platform gap to surface, not to paper over.

## Scope

In scope:

- A new composite VFS-image package `nginx-python-vfs` that boots
  nginx + a Python WSGI app under `dinit`.
- A real, reviewable Python application shipped as source files (not an
  inline string blob): a Notes JSON API over `sqlite3`.
- Full browser-demo wiring (product manifest, gallery preset, demo
  metadata, guide) mirroring the existing `nginx-php-vfs` demo.
- Node + browser parity for the demo.

Out of scope:

- Any change to the existing `cpython`, `nginx`, or `dinit` packages
  beyond consuming them.
- pip / third-party Python packages.
- Durable cross-session persistence of the database.
- A production-grade multi-worker WSGI server; the demo uses the
  single-threaded stdlib server, which is sufficient and honest for a
  demonstration.

## Approach (chosen)

nginx `proxy_pass` → a stdlib `wsgiref.simple_server` Python WSGI app
listening on loopback TCP `127.0.0.1:8000`. This was chosen over two
alternatives:

- **FastCGI (`fastcgi_pass`) to a Python FastCGI responder** — most
  literally mirrors the PHP-FPM demo, but FastCGI is not in the Python
  standard library, so it would require vendoring a FastCGI bridge or
  taking on pip-resolution risk. Rejected to keep the example
  stdlib-only and robust.
- **CGI-style per-request `python3` spawn** — closest to classic CGI,
  but pays cpython cold-start cost on every request and leans hard on
  fork/exec throughput. Rejected as slower and riskier for a demo.

The reverse-proxy-to-WSGI approach is the most robust path through
Kandelo's platform surface and is still an idiomatic, real Python web
app.

## The application: Notes JSON API

A small but real REST API. All responses are JSON; errors return
proper HTTP status codes with JSON bodies.

| Method | Path              | Behavior                                    |
|--------|-------------------|---------------------------------------------|
| GET    | `/api/health`     | `{"status":"ok"}`                           |
| GET    | `/api/notes`      | List all notes (array of note objects)      |
| POST   | `/api/notes`      | Create from JSON `{title, body}`; returns the created row (201) |
| GET    | `/api/notes/{id}` | Return one note; 404 if absent              |
| PUT    | `/api/notes/{id}` | Update `{title, body}`; 404 if absent       |
| DELETE | `/api/notes/{id}` | Delete; 204 on success, 404 if absent       |

A note row: `{id, title, body, created_at}`.

The database is seeded at build time with a couple of sample notes via
`schema.sql`.

A static `/` page (`index.html`) documents the endpoints and performs a
live `fetch` against the API so the browser demo shows real,
inspectable behavior.

## Architecture and data flow

```
browser demo UI ──HTTP──> nginx (:80, /usr/sbin/nginx)
     static /*            proxy_pass /api/ ──> 127.0.0.1:8000
                                              python3 /srv/notes/app.py
                                              (wsgiref.simple_server, WSGI)
                                                     └── sqlite3 → /var/lib/notes/notes.db
```

- **nginx** serves static files under `/` from `/srv/notes/static/`
  and reverse-proxies `/api/` to the Python app via
  `proxy_pass http://127.0.0.1:8000`.
- **Python app** is a single-threaded `wsgiref.simple_server` bound to
  loopback `127.0.0.1:8000` — the proven socket path, analogous to the
  PHP demo's `127.0.0.1:9000` FastCGI listener.
- **dinit** orders services so the Python app is listening before
  nginx starts: `nginx` `dependsOn: ["notes-app"]`, mirroring
  `nginx dependsOn php-fpm` in `build-nginx-php-vfs-image.ts`.
- **Environment**: `PYTHONHOME=/usr` (as the existing python-vfs demo
  relies on) and `PYTHONPATH` as needed for `/usr/lib/python3.13`.

Reference socket status: loopback TCP and AF_UNIX stream sockets are
supported (`docs/posix-status.md`, Socket Operations). Loopback TCP is
chosen because the existing nginx→php-fpm demo proves that exact path.

## File layout

```
packages/registry/nginx-python-vfs/
  package.toml          # composite image: kernel_abi=41,
                        #   fork_instrumentation="disabled",
                        #   depends_on=[shell,nginx,cpython@3.13.3,dinit,kernel],
                        #   output nginx-python-vfs.vfs.zst
  build.toml            # script_path -> images/vfs/scripts/build-nginx-python-vfs-image.sh
  app/
    app.py              # the WSGI application (real, reviewable source)
    schema.sql          # table definition + seed rows
    static/
      index.html        # static docs + live fetch demo

images/vfs/scripts/
  build-nginx-python-vfs-image.ts   # builder, mirrors build-nginx-php-vfs-image.ts

images/vfs/products/
  browser-nginx-python.toml         # product manifest
```

Rationale for shipping `app.py` as a real file: the PHP demo embeds its
router as an inline string in the builder. For a Python *example* whose
purpose is to be a readable, real reference, the source must be an
actual file that can be reviewed and unit-tested in isolation. The
builder copies `app/` into the image at `/srv/notes/`.

## VFS layout inside the image

| Path                      | Contents                              |
|---------------------------|---------------------------------------|
| `/usr/sbin/nginx`         | nginx binary (from nginx package)     |
| `/usr/bin/python3`        | cpython interpreter                   |
| `/usr/lib/python3.13`     | Python stdlib                         |
| `/srv/notes/app.py`       | WSGI application                      |
| `/srv/notes/static/`      | `index.html` and any static assets    |
| `/var/lib/notes/notes.db` | SQLite database (seeded at build)     |
| `/etc/nginx/nginx.conf`   | nginx config                          |
| `/etc/kandelo/demo.json`  | demo presentation metadata            |
| dinit service dir         | `notes-app` and `nginx` services      |

## Browser-demo wiring

Mirror every layer the nginx-php demo uses:

1. **Product manifest** `images/vfs/products/browser-nginx-python.toml`:
   `id`, `output`, `builder`, base composition
   `browser-main-shell`, `[[software.package]]` entries for nginx +
   cpython, `[[mounts]]`, `[boot] argv` (`dinit --container ... nginx`),
   `[boot.env]` (`PYTHONHOME=/usr`), and `[evidence.node]` /
   `[evidence.browser]` test names.
2. **Demo metadata inside the image**: builder calls
   `writeKandeloDemoConfig(...)` → writes `/etc/kandelo/demo.json`
   (`KANDELO_DEMO_CONFIG_PATH`), with a guide describing the Notes API.
3. **Gallery preset**: entry in
   `apps/browser-demos/pages/kandelo/presets.ts`, registration in
   `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json`
   and `live-setup.ts`, and a guide case in
   `web-libs/kandelo-session/src/demo-guides.ts`.
4. **xtask fixture** coverage for the new product manifest under
   `tools/xtask/tests/fixtures/vfs-products/` as needed.

## Persistence honesty

The SQLite database is seeded at build and lives on a writable path.
Writes persist within a running session but reset when the image
reloads. The demo presents this truthfully as an ephemeral in-image
database, not a durable or private store (Browser And User contract).

## Error handling

- Python app: `400` on malformed JSON, `404` on missing id, `405` on
  unsupported method, `500` on unexpected errors — each with a JSON
  error body.
- nginx: upstream failures surface as real `502`/`504`; if the Python
  app is down, the demo shows a genuine gateway error rather than a
  faked page. No special-casing to disguise a failed upstream.

## Testing and validation

This is browser-facing and introduces a new platform path, so "done"
requires all of the following, with each claim backed by the exact
command run:

1. **Python app unit tests** — the WSGI app tested in isolation against
   a temporary SQLite database (host Python during development; the
   authoritative run is in Kandelo).
2. **Package build through the resolver** — build `nginx-python-vfs`
   via the normal path (`scripts/dev-shell.sh` + `./run.sh setup` /
   build-deps) producing `nginx-python-vfs.vfs.zst`. Build any missing
   prerequisite artifacts (musl sysroot, kernel wasm, nginx, cpython)
   rather than treating them as blockers.
3. **In-Kandelo run** — boot the image and curl each API endpoint
   through nginx, confirming real responses (create, read, update,
   delete, health, and error cases).
4. **Browser verification** — `./run.sh browser`, load the demo,
   confirm the static page and live API calls work in-browser. Code
   reasoning is not sufficient for the browser claim.
5. **xtask fixture / product-manifest tests** — run the relevant xtask
   tests for the new product manifest.

The final report will state exactly what was built and run, and what
was not.

## Risks and open questions

- **Single-threaded WSGI server**: `wsgiref.simple_server` handles one
  request at a time. Acceptable and honest for a demo; documented as a
  limitation, not hidden. If concurrency becomes necessary, revisit
  with `ThreadingWSGIServer` (depends on Kandelo pthread behavior).
- **cpython cold start**: the Python app process starts once at boot
  (long-lived), so per-request cold start is not on the hot path —
  this is a benefit of the reverse-proxy approach over CGI.
- **HTTP surfacing in the browser demo**: reaching nginx from the
  browser UI reuses whatever mechanism the existing nginx-php demo
  uses; this design mirrors it and verification confirms it in-browser.
- **ABI**: declare `kernel_abi = 41` to match cpython / python-vfs and
  the modern image packages. No ABI change is introduced.
