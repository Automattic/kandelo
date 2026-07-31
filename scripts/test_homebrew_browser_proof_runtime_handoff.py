#!/usr/bin/env python3
"""Contract tests for the bounded public browser-proof runtime handoff."""

from __future__ import annotations

import copy
import hashlib
import http.client
import json
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable

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
    except handoff.HandoffError:
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


def test_static_server(root: Path) -> None:
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
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
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

        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
        connection.request("GET", "/%2e%2e/package.json")
        response = connection.getresponse()
        response.read()
        connection.close()
        assert response.status == 400

        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
        connection.request("POST", "/")
        response = connection.getresponse()
        response.read()
        connection.close()
        assert response.status == 405
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


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
