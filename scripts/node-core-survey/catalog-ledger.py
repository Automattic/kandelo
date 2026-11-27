#!/usr/bin/env python3
"""Index discovered tests and the per-module evidence without inferring coverage."""

import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
from os.path import relpath
from pathlib import Path
import re

from ledger import interrupted_attempts, read_guest_run

HOSTS = ("native", "Node", "Chromium", "Firefox", "WebKit")
TAP_SKIP = re.compile(r"(?:\d+\.\.\d+|ok|not ok).*# SKIP\S*\s+(.*)", re.IGNORECASE)


def case_key(row):
    return row["selector"], row["sourceFile"] if "sourceFile" in row else row["file"]


def direct_attempts(path, archive_sha, native_sha):
    directory = path.parent
    summary = json.loads(path.read_bytes())
    for name, digest in summary["harnessSha256"].items():
        if Path(name).name != name or hashlib.sha256((directory / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f"Direct harness digest differs in {path}: {name}")
    selection_bytes = (directory / "selection.json").read_bytes()
    selection_sha = hashlib.sha256(selection_bytes).hexdigest()
    selection = json.loads(selection_bytes)
    cases = {case["file"]: case for case in selection["cases"]}
    if list(cases) != summary["cases"]:
        raise ValueError(f"Direct case list differs from the selection in {path}")
    phase_field = summary.get("casePhaseField", "file")
    if phase_field not in ("file", "selector") or len({case[phase_field] for case in cases.values()}) != len(cases):
        raise ValueError(f"Direct invocation phases do not identify unique cases in {path}")
    native = [json.loads(line) for line in (directory / "native.jsonl").read_text().splitlines()]
    if native[0].get("nativeReferenceSha256") != native_sha:
        raise ValueError(f"Unrecognized native reference in {path}")
    native_results = {row["sourceFile"]: row for row in native if row["kind"] == "result"}
    host_names = {host.lower(): host for host in HOSTS[1:]}
    for name, host_summary in summary["hosts"].items():
        host = host_names[name]
        report = directory / name
        transport_path = report / "transport.json"
        if host_summary["receipt"] != f"{name}/transport.json":
            raise ValueError(f"Unexpected direct receipt path in {path}")
        inputs = json.loads((report / "inputs.json").read_bytes())
        prepared = inputs["prepared"]
        if (inputs["host"].lower() != name or inputs["image"]["sha256"] != summary["imageSha256"] or
                inputs["kernelSha256"] != summary["kernelSha256"] or inputs["nodePayloads"] != summary["nodePayloads"] or
                prepared["selectionSha256"] != selection_sha or
                prepared["upstreamArchiveSha256"] != archive_sha or
                prepared["fixtureArchiveSha256"] != host_summary["fixtureArchiveSha256"]):
            raise ValueError(f"Direct artifact attribution failed for {name} in {path}")
        receipt = json.loads(transport_path.read_bytes())
        if receipt["outcome"] != "finished" or any(receipt[key] for key in ("error", "teardownError", "diagnostics")):
            raise ValueError(f"Direct execution did not finish cleanly in {transport_path}")
        invocations = {row["phase"]: row for row in receipt["invocations"]}
        if any(invocations[phase]["exitStatus"] != 0 or not invocations[phase]["terminationObserved"]
               for phase in ("installed-node-profile", "fixture-setup")):
            raise ValueError(f"Direct setup failed in {transport_path}")
        declared = host_summary.get("cases")
        if declared is not None and set(declared) != set(cases):
            raise ValueError(f"Direct per-case outcomes do not match the selection in {path}")
        for source, case in cases.items():
            expected = native_results[source]
            actual = invocations[case[phase_field]]
            expected_argv = ["/usr/bin/node", *expected["argv"][1:-1], "/tmp/node-core-survey/" + source]
            if (expected["exitStatus"] != 0 or expected["timeout"] or expected["skipReason"] or
                    actual["argv"] != expected_argv or type(actual["exitStatus"]) is not int or
                    not actual["terminationObserved"] or [p["pid"] for p in actual["processesAfter"]] != [1] or
                    TAP_SKIP.search(actual["stdout"])):
                raise ValueError(f"Direct case did not meet its scope in {transport_path}: {source}")
            status = actual["exitStatus"]
            disposition = "passed" if status == 0 else "failed"
            if declared is None:
                if status != 0:
                    raise ValueError(f"Undeclared direct failure in {transport_path}: {source}")
            elif declared[source] != {"status": disposition, "exitStatus": status, "nativeExitStatus": expected["exitStatus"]}:
                raise ValueError(f"Direct declared outcome differs from transport in {transport_path}: {source}")
            yield case, host, transport_path, actual["argv"], disposition, status


def retained_interruptions(path, ledger, native_sha):
    """Recover child-launch evidence from older immutable shard receipts."""
    if not native_sha:
        return {}
    corrections = {}
    native_results = {case_key(c): c["native"]["result"] for c in ledger["cases"]}
    for host in HOSTS[1:]:
        candidates = {case_key(c) for c in ledger["cases"] if c[host]["disposition"] == "blocked-unrun"
                      and c[host].get("discovery") and c[host].get("result") is None}
        if not candidates:
            continue
        guest = ledger["guestReceipts"][host]
        identity = guest.get("artifactIdentity") or {}
        directory = path.parent / ("node-host" if host == "Node" else host.lower())
        inputs = directory / "inputs.json"
        native = path.parent / "native.jsonl"
        if (guest.get("transport") in (None, "finished") or not identity.get("receiptSha256") or
                not inputs.is_file() or not native.is_file() or not (directory / "observations.jsonl").is_file()):
            continue
        if hashlib.sha256(inputs.read_bytes()).hexdigest() != identity["receiptSha256"]:
            raise ValueError(f"Changed guest inputs in {directory}")
        native_rows = [json.loads(line) for line in native.read_text().splitlines()]
        if not native_rows or native_rows[0].get("nativeReferenceSha256") != native_sha:
            continue
        reference = {case_key(r): r for r in native_rows if r["kind"] == "result" and r.get("sourceFile")}
        comparable = {key: result if result == reference.get(key) else None
                      for key, result in native_results.items()}
        observations, transport, _ = read_guest_run(directory, ledger["selectionSha256"], host)
        for key, attempt in interrupted_attempts(observations, transport, comparable).items():
            if key in candidates:
                corrections[host, key] = attempt
    return corrections


def index(catalog_path, discovery_path, ledger_paths, direct_paths, native_sha):
    with gzip.open(catalog_path, "rt") as source:
        catalog = json.load(source)
    with gzip.open(discovery_path, "rt") as source:
        discovered = [json.loads(line) for line in source]
    tests = {}
    by_source = defaultdict(list)
    for row in discovered:
        key = case_key(row)
        if key in tests:
            raise ValueError(f"Repeated discovery row {key}")
        tests[key] = {"origin": "upstream", "discovery": row, "observations": {}}
        by_source[key[1]].append(key[0])

    modules = {
        route["module"]: {"family": family["family"], "route": route, "selectedCases": []}
        for family in catalog["families"]
        for route in family["routes"]
    }
    family_members = {family["family"]: [] for family in catalog["families"]}
    for family in catalog["families"]:
        for record in family["namedTestCandidates"]:
            family_members[family["family"]].append({
                **record, "nativeDiscoveredSelectors": by_source[record["path"]],
            })

    for path in ledger_paths:
        ledger = json.loads(path.read_bytes())
        interruptions = retained_interruptions(path, ledger, native_sha)
        ledger_path = relpath(path, start=catalog_path.parent)
        for case in ledger["cases"]:
            key = case_key(case)
            origin = case.get("origin", "upstream")
            test = tests.setdefault(key, {"origin": origin, "discovery": None, "observations": {}})
            if test["origin"] != origin:
                raise ValueError(f"Conflicting origins for {key}: {test['origin']} and {origin}")
            for host in HOSTS:
                row = case[host]
                evidence = ledger["nativeObservations"] if host == "native" else ledger["guestReceipts"][host]
                if row["disposition"] == "blocked-unrun" and (host == "native" or not evidence["transport"]):
                    continue
                observation = {
                    "shard": ledger["shard"], "ledger": ledger_path,
                    "disposition": row["disposition"],
                    "evidence": evidence,
                }
                for field in ("untriagedDisposition", "reason", "classificationReason", "finding", "caseAttempt"):
                    if field in row:
                        observation[field] = row[field]
                if (host, key) in interruptions:
                    attempt = interruptions[host, key]
                    observation["originalDisposition"] = row["disposition"]
                    observation["caseAttempt"] = attempt
                    observation["disposition"] = ("runner-timeout" if attempt["transportOutcome"] == "timeout"
                                                  else "runner-interrupted")
                test["observations"].setdefault(host, []).append(observation)
            selected = {"selector": key[0], "sourceFile": key[1], "origin": origin,
                        "contract": case["contract"], "family": case["family"],
                        "owners": case["owners"], "ledger": ledger_path}
            for name in case["modules"]:
                modules.setdefault(name, {"family": case["family"], "route": None, "selectedCases": []})
                modules[name]["selectedCases"].append(selected)

    for path in direct_paths:
        summary_path = relpath(path, start=catalog_path.parent)
        for case, host, receipt, argv, disposition, status in direct_attempts(path, catalog["archiveSha256"], native_sha):
            key = case_key(case)
            origin = case.get("origin", "upstream")
            test = tests.setdefault(key, {"origin": origin, "discovery": None, "observations": {}})
            if test["origin"] != origin:
                raise ValueError(f"Conflicting origins for {key} in {path}")
            evidence = {"summary": summary_path, "receipt": relpath(receipt, start=catalog_path.parent),
                        "argv": argv, "disposition": disposition, "exitStatus": status}
            test.setdefault("directCaseEvidence", {}).setdefault(host, []).append(evidence)
            for name in case["modules"]:
                module = modules.setdefault(name, {"family": case["family"], "route": None, "selectedCases": []})
                module.setdefault("directCaseEvidence", []).append({
                    "host": host, "selector": key[0], "sourceFile": key[1], "contract": case["contract"], **evidence,
                })

    cases = []
    counts = {name: Counter() for name in HOSTS}
    for (selector, source), row in sorted(tests.items()):
        for host in HOSTS:
            # One case may have multiple identified candidates. Keep their
            # results as a list rather than collapsing to a single verdict.
            if host not in row["observations"]:
                row["observations"][host] = [{"disposition": "blocked-unrun"}]
            for visit in row["observations"][host]:
                counts[host][visit["disposition"]] += 1
        cases.append({"selector": selector, "sourceFile": source, **row})

    return {
        "sourceArchiveSha256": catalog["archiveSha256"],
        "candidate2ManifestSha256": catalog["manifestSha256"],
        "discoverySha256": hashlib.sha256(discovery_path.read_bytes()).hexdigest(),
        "scope": "Native discovered test identities plus separately identified observed case outcomes. Guest-only discovery remains open.",
        "memberCoverageDefault": "untested-coverage-gap unless linked to individual original assertions",
        "familyClosure": {family["family"]: "open" for family in catalog["families"]},
        "familyTestCandidates": family_members,
        "observationCounts": counts,
        "modules": modules,
        "tests": cases,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("catalog", type=Path)
    parser.add_argument("discovery", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("ledgers", type=Path, nargs="+")
    parser.add_argument("--direct", type=Path, action="append", default=[], help="Retained direct case summary")
    parser.add_argument("--native-reference-sha256", help="Authenticated native reference for direct case summaries")
    args = parser.parse_args()
    if args.direct and not args.native_reference_sha256:
        parser.error("--direct requires --native-reference-sha256")
    result = index(args.catalog, args.discovery, args.ledgers, args.direct, args.native_reference_sha256)
    with args.output.open("xb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as output:
        output.write((json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n").encode())
