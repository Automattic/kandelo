#!/usr/bin/env python3
"""Audit source identities for the manual snapshot ownership review.

This verifies authenticated source locations and preserved runtime inputs. It
does not infer C++ semantics from text matches or execute a guest runtime.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identity(path):
    data = Path(path).read_bytes()
    return {"path": str(path), "bytes": len(data), "sha256": digest(data)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    root = Path("tests/nodejs/upstream")
    manifest = json.loads(Path("third_party/nodejs/sources.json").read_bytes())
    catalog = json.loads((root / "mksnapshot-contracts.json").read_bytes())
    index = json.loads((root / "native-registration-index.json").read_bytes())
    assert digest(args.archive.read_bytes()) == manifest["source"]["sha256"]
    assert catalog["sourceArchive"]["sha256"] == index["archiveSha256"] == manifest["source"]["sha256"]
    assert catalog["sourceCommit"] == index["target"]["sourceCommit"] == manifest["source"]["commit"]
    assert catalog["sourceVersion"] == index["target"]["version"] == manifest["version"]
    assert digest(Path("third_party/nodejs/sources.json").read_bytes()) == index["sourceManifestSha256"]

    reviewed = catalog["ownershipReview"]["sourceEvidence"]
    selected = {row["path"] for row in reviewed}
    native = {row["path"]: row for row in index["files"]}
    archive_sources = {}
    prefix = "node-v" + manifest["version"] + "/"
    with tarfile.open(args.archive, "r|gz") as archive:
        for member in archive:
            if not member.isfile() or not member.name.startswith(prefix):
                continue
            name = member.name[len(prefix):]
            if name in selected or (name.startswith("src/") and name.endswith((".cc", ".h"))):
                assert name not in archive_sources, name
                archive_sources[name] = archive.extractfile(member).read()
    actual_native = {name for name in archive_sources if name.startswith("src/") and name.endswith((".cc", ".h"))}
    assert actual_native == set(native)
    for name, row in native.items():
        data = archive_sources[name]
        assert len(data) == row["bytes"] and digest(data) == row["sha256"], name
    spans = 0
    for row in reviewed:
        data = archive_sources[row["path"]]
        assert len(data) == row["bytes"] and digest(data) == row["sha256"], row["path"]
        lines = data.splitlines(keepends=True)
        for span in row["reviewedSpans"]:
            start, end = span["lines"]
            assert 1 <= start <= end <= len(lines)
            assert digest(b"".join(lines[start - 1:end])) == span["sha256"], (row["path"], start, end)
            spans += 1
    javascript_bytes = 0
    javascript_files = 0
    for row in manifest["files"]:
        actual = identity(Path("third_party/nodejs/upstream") / row["path"])
        assert actual["bytes"] == row["bytes"] and actual["sha256"] == row["sha256"], row["path"]
        if row.get("builtinId") is not None:
            javascript_files += 1
            javascript_bytes += actual["bytes"]
    occurrences = []
    for name in sorted(native):
        for line, text in enumerate(archive_sources[name].decode().splitlines(), 1):
            if "snapshot_deserialize_callback" in text:
                occurrences.append({"path": name, "line": line})

    # Preserve the identified compiler phase's runtime inputs. These three
    # metadata files are intentionally updated by this later source review.
    changed_metadata = {"docs/nodejs-upstream-runtime.md", str(root / "implementation-ledger.json"), str(root / "mksnapshot-contracts.json")}
    previous_path = root / "function-compiler-engine-check.json"
    previous = json.loads(previous_path.read_bytes())
    preserved = []
    for row in previous["testedInputs"]:
        if row["path"] in changed_metadata:
            continue
        assert identity(row["path"]) == row, row["path"]
        preserved.append(row["path"])
    for key in ("program", "kernel"):
        assert identity(previous[key]["path"]) == previous[key], key
    inputs = ["scripts/verify-nodejs-mksnapshot-ownership.py", "third_party/nodejs/sources.json",
              str(root / "native-registration-index.json"), str(previous_path),
              str(root / "mksnapshot-contracts.json"), str(root / "mksnapshot-ownership.md"),
              "docs/nodejs-upstream-runtime.md", str(root / "implementation-ledger.json"),
              "packages/registry/spidermonkey/node-upstream/per-context.cpp",
              "packages/registry/spidermonkey/node-upstream/codec-native-api.h",
              "packages/registry/spidermonkey/node-upstream/codecs.cpp",
              "packages/registry/spidermonkey/node-upstream/environment-codecs-inl.h"]
    report = {
        "schema": 1, "verifiedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "scope": "Source provenance/location audit for manual ownership review; no automated semantic proof or new runtime evidence",
        "sourceHeadAtVerification": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "archive": identity(args.archive), "inputs": [identity(path) for path in inputs],
        "nativeFilesMatched": len(native), "reviewedFilesMatched": len(reviewed), "reviewedSpansMatched": spans,
        "sourceIdentity": {"importedFiles": len(manifest["files"]), "javascriptFiles": javascript_files, "javascriptBytes": javascript_bytes},
        "literalDeserializeCallbackOccurrences": occurrences,
        "literalScanLimitation": "Literal substring locations only; generic macros and JS runner calls require manual review",
        "priorCompilerReceiptPreservedInputs": preserved,
        "priorArtifactIdentities": {key: previous[key] for key in ("program", "kernel")},
        "laterMetadataChangesExcluded": sorted(changed_metadata),
        "runtimeEvidenceAdded": False, "startupAccepted": False, "fullContractCatalogComplete": False,
    }
    args.report.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ["nativeFilesMatched", "reviewedFilesMatched", "reviewedSpansMatched", "sourceIdentity", "runtimeEvidenceAdded", "startupAccepted"]}))


if __name__ == "__main__":
    main()
