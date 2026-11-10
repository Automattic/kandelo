#!/usr/bin/env python3
"""Reproduce pinned program cohorts; establish a new cohort only explicitly.

The active ABI-56 cohort must be compiled from its own normal SDK. ABI-55
artifacts remain an immutable historical negative control, never stamp inputs.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
ACTIVE_ABI = 56


def run(*args, cwd=ROOT, **kwargs):
    return subprocess.run([str(arg) for arg in args], cwd=cwd, check=True, **kwargs)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def directory(version):
    return ROOT / f"abi/program-fixtures/v{version}"


def records(manifest):
    return [*manifest["fixtures"], manifest["preparationSource"]]


def active_contract():
    baseline = json.loads((ROOT / "abi/supported-program-baseline.json").read_text())
    if baseline["abi_version"] != ACTIVE_ABI or not re.fullmatch(r"[0-9a-f]{64}", baseline["program_contract_digest"]):
        raise RuntimeError("ABI-56 baseline digest is not sealed; regenerate/review the source-derived ABI snapshot first")
    return baseline["program_contract_digest"]


def read_manifest(version):
    path = directory(version) / "manifest.json"
    if not path.is_file():
        raise RuntimeError(f"Missing pinned ABI-{version} fixture manifest. Establish ABI-56 with scripts/dev-shell.sh python3 scripts/build-program-baseline.py --create-current; never relabel ABI-55 bytes")
    manifest = json.loads(path.read_text())
    if manifest["version"] != 1 or manifest["programAbi"] != version:
        raise RuntimeError(f"Wrong baseline fixture manifest: {path}")
    if version == ACTIVE_ABI and manifest["programContractDigest"] != active_contract():
        raise RuntimeError("ABI-56 fixture manifest does not match the declared program baseline")
    return manifest


def verify(path, fixture):
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f"Expected a regular baseline artifact: {path}")
    if path.stat().st_size != fixture["size"] or digest(path) != fixture["sha256"]:
        raise RuntimeError(f"Baseline artifact does not match its pinned manifest: {path}")


def verify_source(source, manifest):
    revision = run("git", "rev-parse", "HEAD", cwd=source, capture_output=True, text=True).stdout.strip()
    if revision != manifest["sourceRevision"]:
        raise RuntimeError(f"Wrong baseline producer revision: {revision}")
    run("git", "diff", "--exit-code", "HEAD", "--", cwd=source)
    for fixture in records(manifest):
        if digest(source / fixture["sourcePath"]) != fixture["sourceSha256"]:
            raise RuntimeError(f"Changed baseline source: {fixture['sourcePath']}")


def produce(source, manifest, output, capture=False):
    """Use the pinned producer's own SDK, musl, instrumenter and stamp tool."""
    verify_source(source, manifest)
    host = run("rustc", "-vV", cwd=source, capture_output=True, text=True).stdout
    host = next(line.removeprefix("host: ") for line in host.splitlines() if line.startswith("host: "))
    xtask = ["cargo", "run", "-p", "xtask", "--target", host, "--quiet", "--"]
    contract = run(*xtask, "abi-program-digest", cwd=source, capture_output=True, text=True).stdout.strip()
    if contract != manifest["programContractDigest"]:
        raise RuntimeError(f"Producer has a different program contract: {contract}")
    run("bash", "scripts/build-musl.sh", "--ensure", "--core-only", cwd=source)
    output.mkdir(parents=True, exist_ok=True)
    for fixture in records(manifest):
        final = output / fixture["file"]
        raw = final.with_suffix(".raw.wasm") if fixture in manifest["fixtures"] else final
        run("sdk/bin/wasm32posix-cc", *manifest["compileFlags"], fixture["sourcePath"], "-o", raw, cwd=source)
        if raw != final:
            run("scripts/run-wasm-fork-instrument.sh", raw, "-o", final, cwd=source)
    # Only freshly compiled outputs of this invocation are stamp inputs.
    run(*xtask, "stamp-abi-contract", *(output / fixture["file"] for fixture in records(manifest)), cwd=source)
    for fixture in records(manifest):
        artifact = output / fixture["file"]
        if capture:
            fixture.update(size=artifact.stat().st_size, sha256=digest(artifact))
        else:
            verify(artifact, fixture)
    verify_source(source, manifest)


def create_current():
    """One intentional new-baseline operation, never called by test setup."""
    target = directory(ACTIVE_ABI)
    run("git", "cat-file", "-e", "HEAD:abi/program-fixtures/v56/inputs.json")
    plan = json.loads((target / "inputs.json").read_text())
    if plan["version"] != 1 or plan["programAbi"] != ACTIVE_ABI:
        raise RuntimeError("Wrong new-baseline source plan")
    cache = ROOT / "target/program-baseline"
    cache.mkdir(parents=True, exist_ok=True)
    with (cache / "build.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # Refuse before compiling: no overwriting a cohort or adopting partial
        # old outputs. A new manifest binds actual fresh output bytes last.
        for name in ["manifest.json", *(row["file"] for row in records(plan))]:
            if (target / name).exists() or (target / name).is_symlink():
                raise RuntimeError(f"New baseline destination already exists: {target / name}")
        revision = run("git", "rev-parse", "HEAD", capture_output=True, text=True).stdout.strip()
        manifest = {**plan, "programContractDigest": active_contract(), "sourceRevision": revision,
                    "producer": "scripts/build-program-baseline.py --create-current with the sourceRevision normal SDK, musl, instrumenter and ABI stamp tool"}
        for fixture in records(manifest):
            fixture["sourceSha256"] = digest(ROOT / fixture["sourcePath"])
        with tempfile.TemporaryDirectory(prefix="new-v56-", dir=cache) as temp:
            output = Path(temp)
            produce(ROOT, manifest, output, capture=True)
            for fixture in records(manifest):
                # Non-replacing publication keeps an unrelated/newer owner.
                with tempfile.NamedTemporaryFile(prefix=".baseline-", dir=target) as copied:
                    shutil.copyfile(output / fixture["file"], copied.name)
                    verify(Path(copied.name), fixture)
                    os.link(copied.name, target / fixture["file"])
            with (target / "manifest.json").open("x") as stream:
                stream.write(json.dumps(manifest, indent=2) + "\n")
        print("Fresh normal ABI-56 fixtures captured. Review/commit the manifest; ABI-55 files were not touched.")


def provision_one(version):
    manifest = read_manifest(version)
    target = directory(version)
    if all((target / row["file"]).exists() for row in records(manifest)):
        for fixture in records(manifest):
            verify(target / fixture["file"], fixture)
        return
    for fixture in records(manifest):
        artifact = target / fixture["file"]
        if artifact.exists() or artifact.is_symlink():
            verify(artifact, fixture)  # Never silently replace damaged bytes.
    revision = manifest["sourceRevision"]
    source = ROOT / "target/program-baseline" / revision
    if not source.exists():
        available = subprocess.run(["git", "cat-file", "-e", f"{revision}^{{commit}}"], cwd=ROOT,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if available.returncode:
            run("git", "fetch", "--no-tags", "https://github.com/Automattic/kandelo.git", revision)
        run("git", "worktree", "add", "--detach", source, revision)
    verify_source(source, manifest)
    run("git", "submodule", "update", "--init", "libc/musl", cwd=source)
    run(source / "scripts/dev-shell.sh", "python3", Path(__file__).resolve(), "--produce", source, str(version), cwd=source)
    for fixture in records(manifest):
        artifact = target / fixture["file"]
        if artifact.exists() or artifact.is_symlink():
            verify(artifact, fixture)
            continue
        temporary = target / (fixture["file"] + ".next")
        try:
            shutil.copyfile(source / "target/program-baseline" / fixture["file"], temporary)
            os.link(temporary, artifact)
        finally:
            temporary.unlink(missing_ok=True)
    print(f"ABI-{version} program fixtures reproduced and verified.")


def provision():
    # Validate the active cohort before spending resources on historical input.
    read_manifest(ACTIVE_ABI)
    cache = ROOT / "target/program-baseline"
    cache.mkdir(parents=True, exist_ok=True)
    with (cache / "build.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        provision_one(ACTIVE_ABI)
        provision_one(55)  # Immutable refusal/parser control, not a supported ABI.


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--produce":
        version = int(sys.argv[3])
        if version not in (55, ACTIVE_ABI):
            raise SystemExit("Unknown frozen program cohort")
        source = Path(sys.argv[2]).resolve()
        produce(source, read_manifest(version), source / "target/program-baseline")
    elif sys.argv[1:] == ["--create-current"]:
        create_current()
    elif len(sys.argv) == 1:
        provision()
    else:
        raise SystemExit("usage: build-program-baseline.py [--create-current]")
