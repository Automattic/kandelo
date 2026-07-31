#!/usr/bin/env python3
"""Contract tests for the bounded public browser-proof runtime handoff."""

from __future__ import annotations

import copy
import hashlib
import http.client
import http.server
import json
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Callable
import urllib.parse

import homebrew_browser_proof_runtime_handoff as handoff


PRODUCT_REF = "0123456789abcdef0123456789abcdef01234567"


def run(*arguments: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(arguments),
        cwd=cwd,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def write(path: Path, data: bytes | str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        path.write_text(data, encoding="utf-8")
    else:
        path.write_bytes(data)


def fixture(*, transport: str = "public") -> bytes:
    bottle_mirror: dict[str, Any] = {
        "plan": {
            "url": "https://example.test/mirror-plan.json",
            "sha256": "5" * 64,
            "bytes": 5,
        },
    }
    if transport == "closed":
        bottle_mirror["payloads"] = []
    value = {
        "schema": 1,
        "allowLiveNetwork": True,
        "transportMode": transport,
        "image": {
            "url": "https://example.test/main-shell.vfs.zst",
            "sha256": "1" * 64,
            "bytes": 1,
        },
        "bootstrap": {
            "spec": {
                "url": "https://example.test/package-tree.json",
                "sha256": "2" * 64,
                "bytes": 2,
            },
            "archive": {
                "url": "https://example.test/bootstrap.zip",
                "sha256": "3" * 64,
                "bytes": 3,
            },
            "environment": {
                "url": "https://example.test/brew.env",
                "sha256": "4" * 64,
                "bytes": 4,
            },
        },
        "bottleMirror": bottle_mirror,
        "revisions": {
            "coreRevision": "6" * 40,
            "canaryRevision": "7" * 40,
        },
        "timeoutMs": 120_000,
    }
    return (json.dumps(value, sort_keys=True) + "\n").encode()


def create_source(repo_root: Path, root: Path) -> str:
    for relative in handoff.SOURCE_FILE_MAP:
        source = repo_root / relative
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    dist = root / "apps/browser-demos/dist"
    write(dist / "index.html", "<!doctype html><title>proof</title>\n")
    write(
        dist / "pages/homebrew-vfs-test/index.html",
        "<!doctype html><title>lifecycle</title>\n",
    )
    write(dist / "service-worker.js", "self.addEventListener('fetch',()=>{});\n")
    write(dist / "assets/runtime.js", "globalThis.__runtime = true;\n")
    write(root / "tracked-source.txt", "source\n")
    run("git", "init", "-q", cwd=root)
    run("git", "add", ".", cwd=root)
    run(
        "git",
        "-c",
        "user.name=Kandelo Test",
        "-c",
        "user.email=kandelo-test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-qm",
        "fixture",
        cwd=root,
    )
    return run("git", "rev-parse", "HEAD", cwd=root).stdout.strip()


def create_valid(
    repo_root: Path,
    temporary: Path,
) -> tuple[Path, Path, Path, str]:
    source = temporary / "source"
    source.mkdir()
    runtime_ref = create_source(repo_root, source)
    fixture_path = temporary / "public-fixture.json"
    fixture_path.write_bytes(fixture())
    output = temporary / "valid"
    run(
        "bash",
        str(
            repo_root
            / "scripts/create-homebrew-browser-proof-runtime-handoff.sh"
        ),
        "--source-root",
        str(source),
        "--dist",
        str(source / "apps/browser-demos/dist"),
        "--fixture",
        str(fixture_path),
        "--product-kandelo-ref",
        PRODUCT_REF,
        "--runtime-source-ref",
        runtime_ref,
        "--out",
        str(output),
    )
    return output, source, fixture_path, runtime_ref


def clone(root: Path, destination: Path) -> Path:
    shutil.copytree(root, destination)
    return destination


def load_manifest(root: Path) -> dict[str, Any]:
    return json.loads((root / "handoff.json").read_text(encoding="utf-8"))


def save_manifest(root: Path, manifest: dict[str, Any]) -> None:
    path = root / "handoff.json"
    path.write_bytes(handoff._canonical_json(manifest))
    path.chmod(handoff.PAYLOAD_MODE)


def refresh_record(root: Path, relative: str) -> None:
    manifest = load_manifest(root)
    record = next(
        value for value in manifest["files"] if value["path"] == relative
    )
    old_size = record["bytes"]
    path = root / relative
    record["bytes"] = path.stat().st_size
    record["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    record["mode"] = f"{stat.S_IMODE(path.stat().st_mode):04o}"
    manifest["total_bytes"] += record["bytes"] - old_size
    save_manifest(root, manifest)


def expect_rejected(
    root: Path,
    runtime_ref: str,
    label: str,
    *,
    product_ref: str = PRODUCT_REF,
) -> None:
    try:
        handoff.verify_handoff(
            root=root,
            product_kandelo_ref=product_ref,
            runtime_source_ref=runtime_ref,
        )
    except handoff.HandoffError:
        return
    raise AssertionError(f"verifier accepted invalid handoff: {label}")


def expect_create_rejected(
    *,
    source: Path,
    fixture_path: Path,
    runtime_ref: str,
    output: Path,
    label: str,
    message_contains: str | None = None,
) -> None:
    try:
        handoff.create_handoff(
            source_root=source,
            dist=source / "apps/browser-demos/dist",
            fixture=fixture_path,
            product_kandelo_ref=PRODUCT_REF,
            runtime_source_ref=runtime_ref,
            output=output,
        )
    except handoff.HandoffError as error:
        if message_contains is not None:
            assert message_contains in str(error)
        return
    raise AssertionError(f"builder accepted invalid input: {label}")


def mutate_manifest(
    root: Path,
    mutation: Callable[[dict[str, Any]], None],
) -> None:
    manifest = load_manifest(root)
    mutation(manifest)
    save_manifest(root, manifest)


def tree_identity(root: Path) -> list[tuple[str, int, str]]:
    result = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            result.append(
                (
                    path.relative_to(root).as_posix(),
                    stat.S_IMODE(path.stat().st_mode),
                    hashlib.sha256(path.read_bytes()).hexdigest(),
                )
            )
    return result


def http_request(
    port: int,
    method: str,
    path: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
) -> tuple[int, dict[str, str], bytes]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request(
            method,
            path,
            body=body,
            headers=headers or {},
        )
        response = connection.getresponse()
        return (
            response.status,
            {name.lower(): value for name, value in response.getheaders()},
            response.read(),
        )
    finally:
        connection.close()


def proxy_path(target: str) -> str:
    return "/__kandelo_cors_proxy?" + urllib.parse.urlencode({"url": target})


def test_static_server(root: Path) -> None:
    upstream_requests: list[
        tuple[str, str, dict[str, str], bytes]
    ] = []
    cross_origin_port = 0

    class UpstreamHandler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:
            self.serve_request(include_body=True)

        def do_HEAD(self) -> None:
            self.serve_request(include_body=False)

        def do_POST(self) -> None:
            self.serve_request(include_body=True)

        def end_headers(self) -> None:
            self.send_header("Connection", "close")
            super().end_headers()

        def serve_request(self, *, include_body: bool) -> None:
            headers = {
                name.lower(): value for name, value in self.headers.items()
            }
            request_bytes = b""
            if self.command == "POST":
                request_bytes = self.rfile.read(
                    int(headers.get("content-length", "0"))
                )
            upstream_requests.append(
                (self.command, self.path, headers, request_bytes)
            )
            if self.path == "/ok":
                body = b"public bottle bytes"
                self.send_response(200)
                self.send_header("Cache-Control", "public, max-age=60")
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("ETag", '"proof"')
                self.send_header("Set-Cookie", "upstream=secret")
                self.send_header("X-Upstream-Secret", "do-not-forward")
                self.end_headers()
                if include_body:
                    midpoint = len(body) // 2
                    self.wfile.write(body[:midpoint])
                    self.wfile.flush()
                    time.sleep(0.01)
                    self.wfile.write(body[midpoint:])
                return
            if self.path == "/git-upload-pack":
                body = b"001eapplication/x-git-result"
                self.send_response(200)
                self.send_header(
                    "Content-Type",
                    "application/x-git-upload-pack-result",
                )
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if include_body:
                    self.wfile.write(body)
                return
            if self.path == "/ghcr":
                body = b"oci manifest"
                self.send_response(200)
                self.send_header(
                    "Content-Type",
                    "application/vnd.oci.image.manifest.v1+json",
                )
                self.send_header(
                    "Docker-Content-Digest",
                    f"sha256:{'1' * 64}",
                )
                self.send_header(
                    "WWW-Authenticate",
                    'Bearer realm="https://ghcr.io/token"',
                )
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if include_body:
                    self.wfile.write(body)
                return
            if self.path == "/not-modified":
                self.send_response(304)
                # A 304 may describe the selected representation's length
                # even though the response itself never carries that body.
                self.send_header("Content-Length", "123")
                self.send_header("ETag", '"still-current"')
                self.end_headers()
                return
            if self.path == "/no-content":
                self.send_response(204)
                self.send_header("ETag", '"empty"')
                self.end_headers()
                return
            if self.path == "/redirect":
                self.send_response(302)
                self.send_header("Content-Length", "0")
                self.send_header("Location", "/ok")
                self.end_headers()
                return
            if self.path == "/post-redirect-307":
                self.send_response(307)
                self.send_header("Content-Length", "0")
                self.send_header("Location", "/git-upload-pack")
                self.end_headers()
                return
            if self.path == "/post-redirect-303":
                self.send_response(303)
                self.send_header("Content-Length", "0")
                self.send_header("Location", "/ok")
                self.end_headers()
                return
            if self.path == "/cross-origin-redirect":
                self.send_response(307)
                self.send_header("Content-Length", "0")
                self.send_header(
                    "Location",
                    f"http://127.0.0.1:{cross_origin_port}/auth-check",
                )
                self.end_headers()
                return
            if self.path == "/auth-check":
                body = b"cross-origin"
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if include_body:
                    self.wfile.write(body)
                return
            if self.path.startswith("/redirect-loop/"):
                redirect = int(self.path.rsplit("/", 1)[1]) + 1
                self.send_response(302)
                self.send_header("Content-Length", "0")
                self.send_header("Location", f"/redirect-loop/{redirect}")
                self.end_headers()
                return
            if self.path == "/oversize-declared":
                self.send_response(200)
                self.send_header("Content-Length", "65")
                self.end_headers()
                return
            if self.path == "/oversize-stream":
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.end_headers()
                self.close_connection = True
                if include_body:
                    self.wfile.write(b"x" * 65)
                return
            if self.path == "/slow":
                time.sleep(0.25)
                body = b"too late"
                try:
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    if include_body:
                        self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            if self.path == "/error":
                self.close_connection = True
                self.connection.close()
                return
            body = b"upstream missing"
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if include_body:
                self.wfile.write(body)

        def log_message(self, _format: str, *args: object) -> None:
            del args

    cross_origin = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        UpstreamHandler,
    )
    cross_origin.daemon_threads = True
    cross_origin_port = cross_origin.server_address[1]
    cross_origin_thread = threading.Thread(
        target=cross_origin.serve_forever,
        daemon=True,
    )
    cross_origin_thread.start()

    upstream = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0),
        UpstreamHandler,
    )
    upstream.daemon_threads = True
    upstream_thread = threading.Thread(
        target=upstream.serve_forever,
        daemon=True,
    )
    upstream_thread.start()
    upstream_port = upstream.server_address[1]

    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    process = subprocess.Popen(
        [
            "node",
            str(root / "browser/serve-sealed-dist.mjs"),
            "--root",
            str(root / "browser/apps/browser-demos/dist"),
            "--port",
            str(port),
            "--allow-test-loopback-proxy",
            "--proxy-max-request-bytes",
            "32",
            "--proxy-max-response-bytes",
            "64",
            "--proxy-timeout-ms",
            "100",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    production_process: subprocess.Popen[str] | None = None
    try:
        deadline = time.monotonic() + 5
        while True:
            if process.poll() is not None:
                _stdout, stderr = process.communicate()
                raise AssertionError(f"sealed-dist server exited: {stderr}")
            try:
                connection = http.client.HTTPConnection(
                    "127.0.0.1",
                    port,
                    timeout=1,
                )
                connection.request("GET", "/")
                response = connection.getresponse()
                body = response.read()
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise AssertionError("sealed-dist server did not start")
                time.sleep(0.05)
            finally:
                if "connection" in locals():
                    connection.close()
        assert response.status == 200
        assert b"<title>proof</title>" in body
        assert (
            response.getheader("Cross-Origin-Embedder-Policy")
            == "require-corp"
        )
        assert (
            response.getheader("Cross-Origin-Opener-Policy")
            == "same-origin"
        )
        assert (
            response.getheader("Cross-Origin-Resource-Policy")
            == "same-origin"
        )
        assert response.getheader("Service-Worker-Allowed") == "/"
        assert response.getheader("Access-Control-Allow-Origin") == "*"

        status, _headers, _body = http_request(
            port,
            "GET",
            "/%2e%2e/package.json",
        )
        assert status == 400
        status, headers, _body = http_request(port, "POST", "/")
        assert status == 405
        assert headers["allow"] == "GET, HEAD"

        target = f"http://127.0.0.1:{upstream_port}/ok"
        status, headers, body = http_request(
            port,
            "GET",
            proxy_path(target),
            headers={
                "Accept": "application/octet-stream",
                "Authorization": "Bearer QQ==",
                "Cookie": "session=secret",
                "Proxy-Authorization": "Basic secret",
                "Referer": "https://secret.example/",
                "X-GitHub-Token": "github-secret",
                "X-Test-Secret": "do-not-forward",
            },
        )
        assert status == 200
        assert body == b"public bottle bytes"
        assert headers["cache-control"] == "public, max-age=60"
        assert headers["content-type"] == "application/octet-stream"
        assert headers["etag"] == '"proof"'
        assert headers["access-control-allow-origin"] == "*"
        assert headers["cross-origin-embedder-policy"] == "require-corp"
        assert headers["cross-origin-opener-policy"] == "same-origin"
        assert headers["cross-origin-resource-policy"] == "same-origin"
        assert "set-cookie" not in headers
        assert "x-upstream-secret" not in headers
        forwarded = upstream_requests[-1][2]
        assert forwarded["accept"] == "application/octet-stream"
        assert forwarded["authorization"] == "Bearer QQ=="
        for forbidden in (
            "cookie",
            "proxy-authorization",
            "referer",
            "x-github-token",
            "x-test-secret",
        ):
            assert forbidden not in forwarded

        status, headers, body = http_request(
            port,
            "HEAD",
            proxy_path(target),
        )
        assert status == 200
        assert body == b""
        assert headers["content-length"] == str(len(b"public bottle bytes"))
        assert upstream_requests[-1][0] == "HEAD"

        status, headers, body = http_request(
            port,
            "HEAD",
            proxy_path(
                f"http://127.0.0.1:{upstream_port}/oversize-declared"
            ),
        )
        assert status == 200
        assert body == b""
        assert headers["content-length"] == "65"

        git_body = b"\x1f\x8bencoded-git-request"
        git_headers = {
            "Accept": "application/x-git-upload-pack-result",
            "Authorization": "Bearer QQ==",
            "Content-Encoding": "gzip",
            "Content-Type": "application/x-git-upload-pack-request",
            "Cookie": "session=secret",
            "Git-Protocol": "version=2",
            "Proxy-Authorization": "Basic secret",
            "Referer": "https://secret.example/",
            "User-Agent": "git/2.test",
            "X-GitHub-Token": "github-secret",
        }
        status, headers, body = http_request(
            port,
            "POST",
            proxy_path(
                f"http://127.0.0.1:{upstream_port}/git-upload-pack"
            ),
            headers=git_headers,
            body=git_body,
        )
        assert status == 200
        assert body == b"001eapplication/x-git-result"
        assert (
            headers["content-type"]
            == "application/x-git-upload-pack-result"
        )
        method, _path, forwarded, forwarded_body = upstream_requests[-1]
        assert method == "POST"
        assert forwarded_body == git_body
        assert forwarded["accept"] == git_headers["Accept"]
        assert forwarded["authorization"] == "Bearer QQ=="
        assert forwarded["content-encoding"] == "gzip"
        assert forwarded["content-length"] == str(len(git_body))
        assert forwarded["content-type"] == git_headers["Content-Type"]
        assert forwarded["git-protocol"] == "version=2"
        assert forwarded["user-agent"] == "git/2.test"
        for forbidden in (
            "cookie",
            "proxy-authorization",
            "referer",
            "x-github-token",
        ):
            assert forbidden not in forwarded

        oci_accept = "application/vnd.oci.image.manifest.v1+json"
        status, headers, body = http_request(
            port,
            "GET",
            proxy_path(f"http://127.0.0.1:{upstream_port}/ghcr"),
            headers={
                "Accept": oci_accept,
                "Authorization": "Bearer QQ==",
                "Cookie": "session=secret",
            },
        )
        assert status == 200
        assert body == b"oci manifest"
        assert headers["content-type"] == oci_accept
        assert headers["docker-content-digest"] == f"sha256:{'1' * 64}"
        assert headers["www-authenticate"].startswith("Bearer realm=")
        forwarded = upstream_requests[-1][2]
        assert forwarded["accept"] == oci_accept
        assert forwarded["authorization"] == "Bearer QQ=="
        assert "cookie" not in forwarded

        status, _headers, body = http_request(
            port,
            "GET",
            proxy_path(f"http://127.0.0.1:{upstream_port}/redirect"),
            headers={"Authorization": "Bearer QQ=="},
        )
        assert status == 200
        assert body == b"public bottle bytes"
        assert "authorization" not in upstream_requests[-1][2]

        status, _headers, body = http_request(
            port,
            "POST",
            proxy_path(
                f"http://127.0.0.1:{upstream_port}/post-redirect-307"
            ),
            headers=git_headers,
            body=git_body,
        )
        assert status == 200
        assert body == b"001eapplication/x-git-result"
        method, path, forwarded, forwarded_body = upstream_requests[-1]
        assert (method, path, forwarded_body) == (
            "POST",
            "/git-upload-pack",
            git_body,
        )
        assert "authorization" not in forwarded
        assert forwarded["content-encoding"] == "gzip"
        assert forwarded["content-type"] == git_headers["Content-Type"]
        assert forwarded["git-protocol"] == "version=2"

        status, _headers, body = http_request(
            port,
            "POST",
            proxy_path(
                f"http://127.0.0.1:{upstream_port}/post-redirect-303"
            ),
            headers=git_headers,
            body=git_body,
        )
        assert status == 200
        assert body == b"public bottle bytes"
        method, path, forwarded, forwarded_body = upstream_requests[-1]
        assert (method, path, forwarded_body) == ("GET", "/ok", b"")
        assert "authorization" not in forwarded
        assert "content-encoding" not in forwarded
        assert "content-length" not in forwarded
        assert "content-type" not in forwarded

        status, _headers, body = http_request(
            port,
            "GET",
            proxy_path(
                f"http://127.0.0.1:{upstream_port}/"
                "cross-origin-redirect"
            ),
            headers={
                "Accept": "application/octet-stream",
                "Authorization": "Bearer QQ==",
                "Cache-Control": "no-cache",
                "Git-Protocol": "version=2",
                "If-None-Match": '"part"',
                "Range": "bytes=1024-",
                "User-Agent": "Homebrew test",
            },
        )
        assert status == 200
        assert body == b"cross-origin"
        method, path, forwarded, _forwarded_body = upstream_requests[-1]
        assert (method, path) == ("GET", "/auth-check")
        assert forwarded["accept"] == "application/octet-stream"
        assert forwarded["cache-control"] == "no-cache"
        assert forwarded["if-none-match"] == '"part"'
        assert forwarded["range"] == "bytes=1024-"
        assert forwarded["user-agent"] == "Homebrew test"
        assert "authorization" not in forwarded
        assert "git-protocol" not in forwarded

        for endpoint, expected_status, expected_length in (
            ("not-modified", 304, "123"),
            ("no-content", 204, None),
        ):
            status, headers, body = http_request(
                port,
                "GET",
                proxy_path(
                    f"http://127.0.0.1:{upstream_port}/{endpoint}"
                ),
            )
            assert status == expected_status, (
                endpoint,
                status,
                headers,
                body,
            )
            assert body == b""
            if expected_length is not None:
                assert headers["content-length"] == expected_length

        bad_paths = [
            "/__kandelo_cors_proxy",
            (
                "/__kandelo_cors_proxy?"
                f"url={urllib.parse.quote(target)}&"
                f"url={urllib.parse.quote(target)}"
            ),
            proxy_path(
                f"http://user:password@127.0.0.1:{upstream_port}/ok"
            ),
            proxy_path("file:///tmp/not-public"),
            "/__kandelo_cors_proxy?url=%",
            proxy_path(f"{target}#fragment"),
            proxy_path(f"http://127.0.0.1:{upstream_port}"),
            proxy_path(target) + "&extra=1",
        ]
        for path in bad_paths:
            status, _headers, _body = http_request(port, "GET", path)
            assert status == 400, path

        status, headers, _body = http_request(
            port,
            "PUT",
            proxy_path(target),
        )
        assert status == 405
        assert headers["allow"] == "GET, HEAD, POST"

        request_count = len(upstream_requests)
        status, _headers, _body = http_request(
            port,
            "POST",
            proxy_path(
                f"http://127.0.0.1:{upstream_port}/git-upload-pack"
            ),
            body=b"x" * 33,
        )
        assert status == 413
        assert len(upstream_requests) == request_count

        status, _headers, _body = http_request(
            port,
            "GET",
            proxy_path(
                f"http://127.0.0.1:{upstream_port}/redirect-loop/0"
            ),
        )
        assert status == 502

        for endpoint in ("oversize-declared", "oversize-stream"):
            status, _headers, _body = http_request(
                port,
                "GET",
                proxy_path(f"http://127.0.0.1:{upstream_port}/{endpoint}"),
            )
            assert status == 413, endpoint

        status, _headers, _body = http_request(
            port,
            "GET",
            proxy_path(f"http://127.0.0.1:{upstream_port}/slow"),
        )
        assert status == 504

        status, _headers, _body = http_request(
            port,
            "GET",
            proxy_path(f"http://127.0.0.1:{upstream_port}/error"),
        )
        assert status == 502

        status, headers, body = http_request(
            port,
            "GET",
            proxy_path(f"http://127.0.0.1:{upstream_port}/missing"),
        )
        assert status == 404
        assert headers["content-type"] == "text/plain"
        assert body == b"upstream missing"

        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            production_port = reservation.getsockname()[1]
        production_process = subprocess.Popen(
            [
                "node",
                str(root / "browser/serve-sealed-dist.mjs"),
                "--root",
                str(root / "browser/apps/browser-demos/dist"),
                "--port",
                str(production_port),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        deadline = time.monotonic() + 5
        while True:
            if production_process.poll() is not None:
                _stdout, stderr = production_process.communicate()
                raise AssertionError(
                    f"production sealed-dist server exited: {stderr}"
                )
            try:
                status, _headers, _body = http_request(
                    production_port,
                    "GET",
                    "/",
                )
                if status == 200:
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    raise AssertionError(
                        "production sealed-dist server did not start"
                    )
                time.sleep(0.05)
        status, _headers, _body = http_request(
            production_port,
            "GET",
            proxy_path(target),
        )
        assert status == 400
    finally:
        if production_process is not None:
            production_process.terminate()
            try:
                production_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                production_process.kill()
                production_process.wait(timeout=5)
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        upstream.shutdown()
        upstream.server_close()
        upstream_thread.join(timeout=5)
        cross_origin.shutdown()
        cross_origin.server_close()
        cross_origin_thread.join(timeout=5)


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory() as temporary_name:
        temporary = Path(temporary_name)
        valid, source, fixture_path, runtime_ref = create_valid(
            repo_root,
            temporary,
        )
        handoff.verify_handoff(
            root=valid,
            product_kandelo_ref=PRODUCT_REF,
            runtime_source_ref=runtime_ref,
        )
        run(
            "bash",
            str(
                repo_root
                / "scripts/verify-homebrew-browser-proof-runtime-handoff.sh"
            ),
            "--root",
            str(valid),
            "--product-kandelo-ref",
            PRODUCT_REF,
            "--runtime-source-ref",
            runtime_ref,
        )
        assert (
            valid / handoff.FIXTURE_DESTINATION.as_posix()
        ).read_bytes() == fixture_path.read_bytes()
        test_static_server(valid)

        second = temporary / "deterministic"
        handoff.create_handoff(
            source_root=source,
            dist=source / "apps/browser-demos/dist",
            fixture=fixture_path,
            product_kandelo_ref=PRODUCT_REF,
            runtime_source_ref=runtime_ref,
            output=second,
        )
        assert tree_identity(valid) == tree_identity(second)

        tampered = clone(valid, temporary / "tampered")
        with (tampered / "browser/apps/browser-demos/dist/index.html").open(
            "ab"
        ) as stream:
            stream.write(b"tampered")
        expect_rejected(tampered, runtime_ref, "tampered payload")

        missing = clone(valid, temporary / "missing")
        (missing / "browser/apps/browser-demos/dist/index.html").unlink()
        expect_rejected(missing, runtime_ref, "missing payload")

        extra = clone(valid, temporary / "extra")
        write(extra / "extra.txt", "extra\n")
        expect_rejected(extra, runtime_ref, "extra payload")

        extra_directory = clone(valid, temporary / "extra-directory")
        (extra_directory / "empty").mkdir()
        expect_rejected(extra_directory, runtime_ref, "extra directory")

        symlinked = clone(valid, temporary / "symlinked")
        link = symlinked / "browser/apps/browser-demos/dist/index.html"
        link.unlink()
        link.symlink_to("service-worker.js")
        expect_rejected(symlinked, runtime_ref, "symlinked payload")

        symlinked_directory = clone(valid, temporary / "symlinked-directory")
        fixture_directory = symlinked_directory / "browser/fixture"
        shutil.rmtree(fixture_directory)
        fixture_directory.symlink_to(valid / "browser/fixture")
        expect_rejected(
            symlinked_directory,
            runtime_ref,
            "symlinked directory",
        )

        wrong_mode = clone(valid, temporary / "wrong-mode")
        (wrong_mode / "browser/package.json").chmod(0o600)
        expect_rejected(wrong_mode, runtime_ref, "wrong file mode")

        expect_rejected(
            valid,
            runtime_ref,
            "wrong product authority",
            product_ref="f" * 40,
        )

        wrong_authority = clone(valid, temporary / "wrong-authority")
        mutate_manifest(
            wrong_authority,
            lambda value: value["authorities"].update(
                product_kandelo_ref="f" * 40
            ),
        )
        expect_rejected(wrong_authority, runtime_ref, "manifest authority")

        traversal = clone(valid, temporary / "traversal")
        mutate_manifest(
            traversal,
            lambda value: value["files"][0].update(path="../escape"),
        )
        expect_rejected(traversal, runtime_ref, "traversal path")

        absolute = clone(valid, temporary / "absolute")
        mutate_manifest(
            absolute,
            lambda value: value["files"][0].update(path="/escape"),
        )
        expect_rejected(absolute, runtime_ref, "absolute path")

        backslash = clone(valid, temporary / "backslash")
        mutate_manifest(
            backslash,
            lambda value: value["files"][0].update(path="browser\\escape"),
        )
        expect_rejected(backslash, runtime_ref, "backslash path")

        duplicate = clone(valid, temporary / "duplicate")
        mutate_manifest(
            duplicate,
            lambda value: value["files"].append(
                copy.deepcopy(value["files"][0])
            ),
        )
        expect_rejected(duplicate, runtime_ref, "duplicate path")

        wrong_size = clone(valid, temporary / "wrong-size")
        mutate_manifest(
            wrong_size,
            lambda value: value["files"][0].update(
                bytes=value["files"][0]["bytes"] + 1
            ),
        )
        expect_rejected(wrong_size, runtime_ref, "wrong declared size")

        wrong_hash = clone(valid, temporary / "wrong-hash")
        mutate_manifest(
            wrong_hash,
            lambda value: value["files"][0].update(sha256="f" * 64),
        )
        expect_rejected(wrong_hash, runtime_ref, "wrong declared hash")

        wrong_declared_mode = clone(valid, temporary / "declared-mode")
        mutate_manifest(
            wrong_declared_mode,
            lambda value: value["files"][0].update(mode="0600"),
        )
        expect_rejected(
            wrong_declared_mode,
            runtime_ref,
            "wrong declared mode",
        )

        per_file_cap = clone(valid, temporary / "per-file-cap")
        original_bytes = load_manifest(per_file_cap)["files"][0]["bytes"]

        def exceed_file_cap(value: dict[str, Any]) -> None:
            value["files"][0]["bytes"] = handoff.MAX_FILE_BYTES + 1
            value["total_bytes"] += (
                handoff.MAX_FILE_BYTES + 1 - original_bytes
            )

        mutate_manifest(per_file_cap, exceed_file_cap)
        expect_rejected(per_file_cap, runtime_ref, "per-file cap")

        total_cap = clone(valid, temporary / "total-cap")
        mutate_manifest(
            total_cap,
            lambda value: value.update(
                total_bytes=handoff.MAX_TOTAL_BYTES + 1
            ),
        )
        expect_rejected(total_cap, runtime_ref, "total cap")

        file_count_cap = clone(valid, temporary / "file-count-cap")

        def exceed_file_count(value: dict[str, Any]) -> None:
            value["files"] = [
                copy.deepcopy(value["files"][0])
                for _ in range(handoff.MAX_FILE_COUNT + 1)
            ]

        mutate_manifest(file_count_cap, exceed_file_count)
        expect_rejected(file_count_cap, runtime_ref, "file-count cap")

        wrong_limits = clone(valid, temporary / "wrong-limits")
        mutate_manifest(
            wrong_limits,
            lambda value: value["limits"].update(max_file_count=5_000),
        )
        expect_rejected(wrong_limits, runtime_ref, "relaxed limits")

        noncanonical = clone(valid, temporary / "noncanonical")
        manifest = load_manifest(noncanonical)
        (noncanonical / "handoff.json").write_text(
            json.dumps(manifest, indent=2),
            encoding="utf-8",
        )
        expect_rejected(noncanonical, runtime_ref, "noncanonical manifest")

        duplicate_key = clone(valid, temporary / "duplicate-key")
        data = (duplicate_key / "handoff.json").read_text(encoding="utf-8")
        data = data.replace('{"authorities":', '{"schema":1,"authorities":', 1)
        (duplicate_key / "handoff.json").write_text(data, encoding="utf-8")
        expect_rejected(duplicate_key, runtime_ref, "duplicate JSON key")

        manifest_symlink = clone(valid, temporary / "manifest-symlink")
        (manifest_symlink / "handoff.json").unlink()
        (manifest_symlink / "handoff.json").symlink_to(
            valid / "handoff.json"
        )
        expect_rejected(manifest_symlink, runtime_ref, "manifest symlink")

        root_symlink = temporary / "root-symlink"
        root_symlink.symlink_to(valid)
        expect_rejected(root_symlink, runtime_ref, "root symlink")

        closed_fixture = clone(valid, temporary / "closed-fixture")
        closed_fixture_path = (
            closed_fixture / handoff.FIXTURE_DESTINATION.as_posix()
        )
        closed_fixture_path.write_bytes(fixture(transport="closed"))
        refresh_record(
            closed_fixture,
            handoff.FIXTURE_DESTINATION.as_posix(),
        )
        expect_rejected(closed_fixture, runtime_ref, "closed fixture")

        changed_package = clone(valid, temporary / "changed-package")
        package_path = changed_package / "browser/package.json"
        package = json.loads(package_path.read_text(encoding="utf-8"))
        package["devDependencies"]["left-pad"] = "1.3.0"
        package_path.write_text(json.dumps(package), encoding="utf-8")
        refresh_record(changed_package, "browser/package.json")
        expect_rejected(changed_package, runtime_ref, "changed package")

        unexpected_declared = clone(valid, temporary / "unexpected-declared")
        unexpected_path = unexpected_declared / "browser/unexpected.js"
        write(unexpected_path, "export {};\n")
        manifest = load_manifest(unexpected_declared)
        contents = unexpected_path.read_bytes()
        manifest["files"].append(
            {
                "path": "browser/unexpected.js",
                "bytes": len(contents),
                "sha256": hashlib.sha256(contents).hexdigest(),
                "mode": "0644",
            }
        )
        manifest["files"].sort(key=lambda value: value["path"])
        manifest["total_bytes"] += len(contents)
        save_manifest(unexpected_declared, manifest)
        expect_rejected(
            unexpected_declared,
            runtime_ref,
            "unexpected declared source",
        )

        dirty_marker = source / "dirty.txt"
        write(dirty_marker, "dirty\n")
        expect_create_rejected(
            source=source,
            fixture_path=fixture_path,
            runtime_ref=runtime_ref,
            output=temporary / "dirty-output",
            label="dirty source",
            message_contains="?? dirty.txt",
        )
        dirty_marker.unlink()

        expect_create_rejected(
            source=source,
            fixture_path=fixture_path,
            runtime_ref="f" * 40,
            output=temporary / "wrong-ref-output",
            label="wrong runtime source ref",
        )

        closed_input = temporary / "closed-input.json"
        closed_input.write_bytes(fixture(transport="closed"))
        expect_create_rejected(
            source=source,
            fixture_path=closed_input,
            runtime_ref=runtime_ref,
            output=temporary / "closed-output",
            label="closed fixture input",
        )

        expect_create_rejected(
            source=source,
            fixture_path=fixture_path,
            runtime_ref=runtime_ref,
            output=valid,
            label="existing output",
        )

    print("test-homebrew-browser-proof-runtime-handoff.sh: ok")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, handoff.HandoffError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
