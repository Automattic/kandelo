#!/usr/bin/env python3
"""Stage unchanged upstream sources and suite metadata for a selected shard."""

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import tomllib


HERE = Path(__file__).resolve().parent
PIN = HERE.parents[1] / "packages/registry/node-core-source/package.toml"
RUNNER = {"tools/test.py", "tools/utils.py", "tools/pseudo-tty.py"}


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def prepare(archive, selection, output):
    pin = tomllib.loads(PIN.read_text())
    expected = pin["source"]["sha256"]
    if digest(archive) != expected:
        raise ValueError(f"Expected the node-core-source archive with SHA-256 {expected}")

    shard = json.loads(selection.read_bytes())
    required = RUNNER | set(shard["fixtures"]) | {case["file"] for case in shard["cases"]}
    fixture_directories = {PurePosixPath(name) for name in shard.get("fixtureDirectories", [])}
    for directory in fixture_directories:
        if directory.parts[:2] != ("test", "fixtures") or len(directory.parts) < 3 or ".." in directory.parts:
            raise ValueError(f"Unexpected fixture directory {directory}")
    staged_directories = set()
    supplemental = {}
    for case in shard["cases"]:
        if case.get("origin") != "kandelo":
            continue
        path = PurePosixPath(case["file"])
        if path.parent != PurePosixPath("test/parallel") or not path.name.startswith("test-kandelo-"):
            raise ValueError(f"Unexpected Kandelo test path {path}")
        supplemental[str(path)] = (HERE / "supplemental" / path.name).read_bytes()
    optional = set()
    for case in shard["cases"]:
        if case["selector"].startswith("pseudo-tty/"):
            stem = PurePosixPath(case["file"]).with_suffix("")
            required.add(str(stem) + ".out")
            optional.add(str(stem) + ".in")

    output.mkdir()
    fixture_archive = output / "fixtures.tar"
    files = {}
    with tarfile.open(archive, "r|gz") as upstream, tarfile.open(fixture_archive, "w") as staged:
        for member in upstream:
            root, _, name = member.name.partition("/")
            if root != f"node-v{pin['version']}":
                raise ValueError(f"Unexpected archive root {root}")
            path = PurePosixPath(name)
            if name in supplemental:
                raise ValueError(f"Kandelo test collides with upstream source: {name}")
            suite_metadata = name.startswith("test/") and len(path.parts) <= 3 and (
                path.name == "testcfg.py" or path.suffix == ".status"
            )
            shared_helpers = name.startswith(("test/common/", "test/testpy/")) and not member.isdir()
            fixture_parents = fixture_directories.intersection(path.parents) if not member.isdir() else set()
            if name not in (required | optional) and not suite_metadata and not shared_helpers and not fixture_parents:
                continue
            if not member.isfile() or path.is_absolute() or ".." in path.parts or name in files:
                raise ValueError(f"Unsupported or duplicate shard input {name}")
            with upstream.extractfile(member) as source:
                content = source.read()
            member.name = name
            staged.addfile(member, io.BytesIO(content))
            files[name] = hashlib.sha256(content).hexdigest()
            staged_directories.update(fixture_parents)

        for name, content in sorted(supplemental.items()):
            member = tarfile.TarInfo(name)
            member.size = len(content)
            staged.addfile(member, io.BytesIO(content))
            files[name] = hashlib.sha256(content).hexdigest()

    if missing := required - files.keys():
        raise ValueError(f"Missing shard inputs: {sorted(missing)}")
    if missing_directories := fixture_directories - staged_directories:
        raise ValueError(f"Missing fixture directories: {sorted(map(str, missing_directories))}")
    identity = {
        "nodeVersion": pin["version"],
        "upstreamArchiveSha256": expected,
        "fixtureArchiveSha256": digest(fixture_archive),
        "selectionSha256": digest(selection),
        "files": files,
        "shard": shard,
    }
    if supplemental:
        identity["supplementalFiles"] = {name: files[name] for name in sorted(supplemental)}
    (output / "inputs.json").write_text(json.dumps(identity, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("selection", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    prepare(args.archive, args.selection, args.output)
