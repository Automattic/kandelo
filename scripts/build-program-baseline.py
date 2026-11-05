#!/usr/bin/env python3
"""Build the supported old-program cohort with its pinned producer, never today's SDK.

Only source provenance and expected output hashes are tracked. Tests consume
these generated files without compiling or restamping programs themselves.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = ROOT / "abi/program-fixtures/v55"
MANIFEST = json.loads((DIRECTORY / "manifest.json").read_text())
FIXTURES = [*MANIFEST["fixtures"], MANIFEST["preparationSource"]]


def run(*args, cwd=ROOT, **kwargs):
    return subprocess.run([str(arg) for arg in args], cwd=cwd, check=True, **kwargs)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(path, fixture):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f"Expected a regular baseline artifact: {path}")
    if path.stat().st_size != fixture["size"] or digest(path) != fixture["sha256"]:
        raise RuntimeError(f"Baseline artifact does not match its pinned manifest: {path}")


def verify_source(source):
    revision = run("git", "rev-parse", "HEAD", cwd=source, capture_output=True, text=True).stdout.strip()
    if revision != MANIFEST["sourceRevision"]:
        raise RuntimeError(f"Wrong baseline producer revision: {revision}")
    run("git", "diff", "--exit-code", "HEAD", "--", cwd=source)
    for fixture in FIXTURES:
        if digest(source / fixture["sourcePath"]) != fixture["sourceSha256"]:
            raise RuntimeError(f"Changed baseline source: {fixture['sourcePath']}")


def produce(source):
    """Called inside the historical checkout's own locked development shell."""
    verify_source(source)
    host = run("rustc", "-vV", cwd=source, capture_output=True, text=True).stdout
    host = next(line.removeprefix("host: ") for line in host.splitlines() if line.startswith("host: "))
    xtask = ["cargo", "run", "-p", "xtask", "--target", host, "--quiet", "--"]
    contract = run(*xtask, "abi-program-digest", cwd=source, capture_output=True, text=True).stdout.strip()
    if contract != MANIFEST["programContractDigest"]:
        raise RuntimeError(f"Historical producer has a different program contract: {contract}")
    run("bash", "scripts/build-musl.sh", "--ensure", "--core-only", cwd=source)
    output = source / "target/program-baseline"
    output.mkdir(parents=True, exist_ok=True)
    for fixture in FIXTURES:
        final = output / fixture["file"]
        raw = final.with_suffix(".raw.wasm") if fixture in MANIFEST["fixtures"] else final
        run("sdk/bin/wasm32posix-cc", *MANIFEST["compileFlags"], fixture["sourcePath"], "-o", raw, cwd=source)
        if raw != final:
            run("scripts/run-wasm-fork-instrument.sh", raw, "-o", final, cwd=source)
    run(*xtask, "stamp-abi-contract", *(output / fixture["file"] for fixture in FIXTURES), cwd=source)
    for fixture in FIXTURES:
        verify(output / fixture["file"], fixture)
    verify_source(source)


def provision():
    cache = ROOT / "target/program-baseline"
    cache.mkdir(parents=True, exist_ok=True)
    # An OS-owned lock also releases after interruption; concurrent Rust,
    # Vitest and browser setup calls cannot modify the producer together.
    with (cache / "build.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        missing = False
        for fixture in FIXTURES:
            artifact = DIRECTORY / fixture["file"]
            if artifact.exists() or artifact.is_symlink():
                verify(artifact, fixture)  # Never silently replace damaged bytes.
            else:
                missing = True
        if not missing:
            return
        revision = MANIFEST["sourceRevision"]
        source = cache / revision
        if not source.exists():
            # A shallow CI checkout may not contain the pinned producer yet.
            available = subprocess.run(["git", "cat-file", "-e", f"{revision}^{{commit}}"], cwd=ROOT,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if available.returncode:
                run("git", "fetch", "--no-tags", "https://github.com/Automattic/kandelo.git", revision)
            run("git", "worktree", "add", "--detach", source, revision)
        verify_source(source)
        run("git", "submodule", "update", "--init", "libc/musl", cwd=source)
        # The old dev-shell clears ambient compiler/SDK overrides and realizes
        # its own flake.lock and rust-toolchain.toml, independently of this PR.
        run(source / "scripts/dev-shell.sh", "python3", Path(__file__).resolve(), "--produce", source, cwd=source)
        for fixture in FIXTURES:
            temporary = DIRECTORY / (fixture["file"] + ".next")
            try:
                shutil.copyfile(source / "target/program-baseline" / fixture["file"], temporary)
                os.replace(temporary, DIRECTORY / fixture["file"])
            finally:
                temporary.unlink(missing_ok=True)
        print("Supported ABI-55 program fixtures built and verified.")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--produce":
        produce(Path(sys.argv[2]).resolve())
    elif len(sys.argv) == 1:
        provision()
    else:
        raise SystemExit("usage: build-program-baseline.py")
