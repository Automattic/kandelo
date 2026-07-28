#!/usr/bin/env python3
"""Executable contract tests for the main-shell release finalizer."""

from __future__ import annotations

import hashlib
import json
import pathlib
import shutil
import subprocess
import tempfile


REPO = pathlib.Path(__file__).resolve().parent.parent
FINALIZER = REPO / "scripts/finalize-homebrew-main-shell-release.py"
COPIED = [
    "homebrew/main-shell-migration-lock.json",
    "homebrew/main-shell-homebrew-runtime-support.json",
    "homebrew/main-shell-lazy-artifact-lock.json",
    "homebrew/main-shell-materialization-policy.json",
    "homebrew/homebrew-bootstrap-source-lock.json",
    "homebrew/main-shell-brew-package-tree.json",
    "homebrew/main-shell.Brewfile",
    "homebrew/main-shell-demo.json",
    "packages/registry/shell/build.toml",
    "docs/homebrew-publishing.md",
]
TAP_NAME = "kandelo-dev/tap-core"
DEPENDENCIES = {
    "bash": ["ncurses"],
    "ncurses": ["libcxx"],
    "m4": ["dash"],
    "diffutils": ["coreutils", "ed"],
    "tar": ["dash", "gzip"],
    "curl": ["libcurl", "openssl", "zlib"],
    "git": [
        "coreutils",
        "dash",
        "diffutils",
        "grep",
        "less",
        "libcurl",
        "openssl",
        "sed",
        "vim",
        "zlib",
    ],
    "libcurl": ["openssl", "zlib"],
    "less": ["ncurses"],
    "vim": ["ncurses"],
    "ruby": ["zlib"],
    "file-formula": ["libmagic"],
}


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(*arguments: str, success: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [str(FINALIZER), *arguments],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if success and result.returncode != 0:
        raise AssertionError(result.stderr)
    if not success and result.returncode == 0:
        raise AssertionError("invalid finalization unexpectedly succeeded")
    return result


def copy_source(root: pathlib.Path) -> pathlib.Path:
    source = root / "source"
    for relative in COPIED:
        destination = source / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPO / relative, destination)
    return source


def package_record(name: str, formula: dict | None) -> dict:
    revision = formula["revision"] if formula else 0
    version = formula["version"] if formula else "1.0"
    if revision:
        version = f"{version}_{revision}"
    rebuild = formula["bottle_rebuild"] if formula else 1
    if name in {"file-formula", "make", "nano", "nethack", "unzip", "wget", "zip"}:
        rebuild += 1
    bottle_sha = hashlib.sha256(f"bottle:{name}:{rebuild}".encode()).hexdigest()
    return {
        "name": name,
        "full_name": f"{TAP_NAME}/{name}",
        "version": version,
        "formula_revision": revision,
        "bottle_rebuild": rebuild,
        "dependencies": [
            {"name": dependency, "full_name": f"{TAP_NAME}/{dependency}"}
            for dependency in DEPENDENCIES.get(name, [])
        ],
        "bottles": [
            {
                "arch": "wasm32",
                "bottle_tag": "wasm32_kandelo",
                "status": "success",
                "kandelo_abi": 42,
                "bytes": 100 + len(name),
                "sha256": bottle_sha,
                "cache_key_sha": bottle_sha,
                "url": (
                    "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core/"
                    f"{name}/blobs/sha256:{bottle_sha}"
                ),
                "runtime_support": ["node"],
                "built_from": {
                    "tap_repository": "kandelo-dev/homebrew-tap-core",
                    "tap_commit": "a" * 40,
                    "kandelo_repository": "Automattic/kandelo",
                    "kandelo_commit": (
                        "b" * 40 if name == "gawk" else "c" * 40
                    ),
                    "formula_sha256": hashlib.sha256(
                        f"formula:{name}".encode()
                    ).hexdigest(),
                },
            }
        ],
    }


def create_tap(root: pathlib.Path, source: pathlib.Path, omit: str | None = None) -> pathlib.Path:
    tap = root / "tap"
    (tap / "Kandelo").mkdir(parents=True)
    lock = json.loads((source / "homebrew/main-shell-migration-lock.json").read_text())
    support = json.loads(
        (source / "homebrew/main-shell-homebrew-runtime-support.json").read_text()
    )
    formulae = {
        entry["formula"]["name"]: entry["formula"] for entry in lock["packages"]
    }
    names = {
        identity.split("/")[-1] for identity in lock["formula_closure"]
    } | {
        identity.split("/")[-1]
        for identity in support["availability"]["reusable_public_abi42"]
    }
    if omit:
        names.remove(omit)
    metadata = {
        "schema": 1,
        "generated_at": "2026-07-28T00:00:00Z",
        "generator": "test",
        "tap_repository": "kandelo-dev/homebrew-tap-core",
        "tap_name": TAP_NAME,
        "tap_commit": "d" * 40,
        "kandelo_repository": "Automattic/kandelo",
        "kandelo_commit": "c" * 40,
        "kandelo_abi": 42,
        "release_tag": "bottles-abi-v42",
        "packages": [
            package_record(name, formulae.get(name)) for name in sorted(names)
        ],
    }
    (tap / "Kandelo/metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    subprocess.run(["git", "-C", str(tap), "init", "-q"], check=True)
    subprocess.run(
        ["git", "-C", str(tap), "config", "user.email", "test@example.invalid"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(tap), "config", "user.name", "Finalizer test"],
        check=True,
    )
    subprocess.run(["git", "-C", str(tap), "add", "Kandelo/metadata.json"], check=True)
    subprocess.run(
        ["git", "-C", str(tap), "commit", "-qm", "fixture"], check=True
    )
    return tap


with tempfile.TemporaryDirectory(prefix="kandelo-shell-finalizer-test.") as temporary:
    root = pathlib.Path(temporary)
    source = copy_source(root)
    tap = create_tap(root, source)
    paths = [source / relative for relative in COPIED]
    before = {path: digest(path) for path in paths}

    preview = run("--source-root", str(source), "--tap-root", str(tap))
    preview_json = json.loads(preview.stdout)
    assert preview_json["applied"] is False
    assert preview_json["artifact_state"] == "pending"
    assert before == {path: digest(path) for path in paths}

    applied = run(
        "--source-root", str(source), "--tap-root", str(tap), "--apply"
    )
    applied_json = json.loads(applied.stdout)
    assert applied_json["applied"] is True
    assert applied_json["roots"] == 32
    assert applied_json["base_formulae"] == 38
    assert applied_json["embedded"] == 3
    assert applied_json["lazy"] == 35
    assert applied_json["runtime_extra"] == 1
    assert applied_json["total"] == 39
    head = subprocess.run(
        ["git", "-C", str(tap), "rev-parse", "HEAD"],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    ).stdout.strip()
    migration = json.loads(
        (source / "homebrew/main-shell-migration-lock.json").read_text()
    )
    support = json.loads(
        (source / "homebrew/main-shell-homebrew-runtime-support.json").read_text()
    )
    artifact_lock = json.loads(
        (source / "homebrew/main-shell-lazy-artifact-lock.json").read_text()
    )
    assert migration["catalog"]["tap_commit"] == head
    assert support["catalog"]["tap_commit"] == head
    assert support["availability"]["audited_catalog"]["checkout_commit"] == head
    assert artifact_lock["state"] == "pending"
    assert artifact_lock["image"] is None
    assert 'publication_state = "pending"' in (
        source / "packages/registry/shell/build.toml"
    ).read_text()
    rebuilt = {
        entry["formula"]["name"]: entry["formula"]["bottle_rebuild"]
        for entry in migration["packages"]
    }
    assert rebuilt["file-formula"] == 4
    assert rebuilt["zip"] == 2

    artifact = root / "shell.vfs.zst"
    artifact.write_bytes(b"reviewed deterministic shell bytes\n")
    sealed = run(
        "--source-root",
        str(source),
        "--tap-root",
        str(tap),
        "--artifact",
        str(artifact),
        "--apply",
    )
    sealed_json = json.loads(sealed.stdout)
    assert sealed_json["artifact_state"] == "sealed"
    artifact_lock = json.loads(
        (source / "homebrew/main-shell-lazy-artifact-lock.json").read_text()
    )
    assert artifact_lock["image"] == {
        "sha256": digest(artifact),
        "bytes": artifact.stat().st_size,
    }
    assert 'publication_state = "ready"' in (
        source / "packages/registry/shell/build.toml"
    ).read_text()

    (tap / "untracked").write_text("dirty\n")
    dirty = run(
        "--source-root", str(source), "--tap-root", str(tap), success=False
    )
    assert "tap checkout must be clean" in dirty.stderr

with tempfile.TemporaryDirectory(prefix="kandelo-shell-finalizer-fail.") as temporary:
    root = pathlib.Path(temporary)
    source = copy_source(root)
    tap = create_tap(root, source, omit="zip")
    paths = [source / relative for relative in COPIED]
    before = {path: digest(path) for path in paths}
    missing = run(
        "--source-root",
        str(source),
        "--tap-root",
        str(tap),
        "--apply",
        success=False,
    )
    assert "missing shell root zip" in missing.stderr
    assert before == {path: digest(path) for path in paths}

print("test-finalize-homebrew-main-shell-release: ok")
