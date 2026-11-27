#!/usr/bin/env python3
"""Revalidate the frozen route and test inventories against the package pin."""

import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile
import tomllib


HERE = Path(__file__).resolve().parent
PIN = HERE.parents[1] / "packages/registry/node-core-source/package.toml"
CANDIDATE_2 = "0629b49f93c9b92607700a22d07c5c3527b1a772228e7a5675953207e84e33be"
RUNNER = {"tools/test.py", "tools/utils.py"}
DOC_MEMBERS = (
    "classes", "methods", "properties", "events", "modules",
    "globals", "ctors", "classMethods", "constructors", "miscs",
)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_verified(path, expected):
    data = path.read_bytes()
    if sha256(data) != expected:
        raise ValueError(f"Digest mismatch for {path}")
    return data


def document_members(unit, parent=()):
    for collection in DOC_MEMBERS:
        for member in unit.get(collection, []):
            label = member.get("textRaw") or member.get("name")
            if label is None:
                continue
            path = (*parent, label)
            signatures = member.get("signatures", [])
            yield {
                "path": path, "kind": collection, "stability": member.get("stability"),
                "overloads": [list(signature.get("params", [])) for signature in signatures],
                "returns": [signature.get("return") for signature in signatures if "return" in signature],
            }
            yield from document_members(member, path)


def audit(archive, handoff):
    research = handoff / "context/node-startup-research"
    frozen = json.loads(read_verified(research / "PLAN-REVIEW-MANIFEST.json", CANDIDATE_2))
    adoption = json.loads((research / "PLAN-ADOPTION.json").read_bytes())
    if adoption["manifestSha256"] != CANDIDATE_2:
        raise ValueError("The reference manifest must match the recorded adoption")
    entry = next(row for row in frozen["reviewDocuments"]
                 if row["path"].endswith("/full-family-owner-map.json"))
    frozen_path = PurePosixPath(entry["frozenPath"])
    family_map = json.loads(read_verified(research / frozen_path.parent.name / frozen_path.name, entry["sha256"]))
    intake_dir = (handoff / "context/node-upstream-execution/b6-review/core-test-gap-catalog-20261121")
    intake = json.loads((intake_dir / "INTAKE.json").read_bytes())
    compressed = read_verified(intake_dir / "SOURCE-INVENTORY.json.gz", intake["sourceInventory"]["sha256"])
    test_inventory = {row["path"]: row for row in json.loads(gzip.decompress(compressed))["files"]}
    public_routes = {
        row["path"]: row
        for family in family_map["families"]
        for row in family["originalPublicModuleRoutes"]
    }
    native_candidates = {
        row["path"]: row
        for family in family_map["families"]
        for row in family["nativeSourceReuseCandidates"]
    }
    for family in family_map["families"]:
        for case in family["namedTestSourceCandidates"]:
            if test_inventory.get(case["path"], {}).get("sha256") != case["sha256"]:
                raise ValueError(f"The frozen test candidate does not match the inventory: {case['path']}")

    pin = tomllib.loads(PIN.read_text())
    with archive.open("rb") as source:
        archive_digest = hashlib.file_digest(source, "sha256").hexdigest()
    if archive_digest != pin["source"]["sha256"] or archive_digest != intake["nodeArchive"]["sha256"]:
        raise ValueError("The package pin and retained inventory must name the same upstream archive")

    verified_tests = set()
    verified_routes = set()
    verified_native = set()
    documented = {}
    with tarfile.open(archive, "r|gz") as tree:
        for member in tree:
            root, _, name = member.name.partition("/")
            if root != f"node-v{pin['version']}":
                raise ValueError(f"Unexpected archive root {root}")
            if member.isdir():
                continue
            if name.startswith("test/") or name in RUNNER:
                record = test_inventory.get(name)
                if (record is None or record["mode"] != member.mode or record["bytes"] != member.size or
                    not member.isfile() or record["kind"] != "regular"):
                    raise ValueError(f"New or changed source inventory entry: {name}")
                if sha256(tree.extractfile(member).read()) != record["sha256"]:
                    raise ValueError(f"Changed source inventory bytes: {name}")
                verified_tests.add(name)
            elif name in public_routes:
                if sha256(tree.extractfile(member).read()) != public_routes[name]["sha256"]:
                    raise ValueError(f"Changed original route bytes: {name}")
                verified_routes.add(name)
            elif name in native_candidates:
                record = native_candidates[name]
                if member.size != record["bytes"] or sha256(tree.extractfile(member).read()) != record["sha256"]:
                    raise ValueError(f"Changed native source candidate: {name}")
                verified_native.add(name)
            elif name.startswith("doc/api/") and name.count("/") == 2 and name.endswith(".json") and name != "doc/api/all.json":
                data = json.load(tree.extractfile(member))
                documented[name] = list(document_members(data))

    if (verified_tests != test_inventory.keys() or verified_routes != public_routes.keys() or
            verified_native != native_candidates.keys()):
        raise ValueError("The archive is missing entries from the retained inventories")
    return {
        "manifestSha256": CANDIDATE_2,
        "archiveSha256": archive_digest,
        "routeFiles": len(verified_routes),
        "nativeCandidates": len(verified_native),
        "testAndFixtureEntries": len(verified_tests),
        "testConfigurationFiles": len(intake["suiteConfigurations"]),
        "documentationEntriesByKind": Counter(member["kind"] for rows in documented.values() for member in rows),
        "documentation": documented,
        "families": [{
            "family": family["family"], "routes": family["originalPublicModuleRoutes"],
            "historicalObligations": family["originalObligations"],
            "membersReviewedForCompatibility": False,
            "owner": family["accountableOwner"], "prerequisites": family["prerequisites"],
            "completionContract": family["completionContract"],
            "candidateBatches": family["candidateBatches"],
            "nativeSourceCandidates": family["nativeSourceReuseCandidates"],
            "namedTestCandidates": family["namedTestSourceCandidates"],
            "unresolvedDynamicCalls": family["unresolvedDynamicCalls"],
        } for family in family_map["families"]],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("handoff", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = audit(args.archive, args.handoff)
    with args.output.open("x") as report:
        json.dump(result, report, indent=2, sort_keys=True)
        report.write("\n")
