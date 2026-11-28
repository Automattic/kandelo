#!/usr/bin/env python3
"""Join independent upstream-runner results to a shard without inferring coverage."""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path


def rows(path, kind, sources_by_selector):
    indexed = {}
    if path is not None and path.is_file():
        for line in path.read_text().splitlines():
            row = json.loads(line)
            if row["kind"] != kind:
                continue
            selector = row["selector"]
            source = row.get("sourceFile")
            if source is None:
                # Early receipts predate source identities. Their rows can
                # be attached only when the selection identifies one source.
                selected_sources = sources_by_selector.get(selector, [])
                if len(selected_sources) != 1:
                    raise ValueError(f"Cannot identify the source for {selector} in {path}")
                source = selected_sources[0]
            key = (selector, source)
            if key in indexed:
                raise ValueError(f"Duplicate {kind} record {key} in {path}")
            indexed[key] = row
    return indexed


def disposition(discovery, result, transport):
    if transport and (transport.get("teardownError") or transport.get("outcome") != "finished"):
        return "setup-or-harness-failure" if result else "blocked-unrun"
    if not result:
        return "upstream-skip" if discovery and "skip" in discovery["outcomes"] else "blocked-unrun"
    if result["timeout"]:
        return "timeout"
    if result["unexpected"]:
        # An upstream failure is evidence of a mismatch. A source/fixture
        # investigation distinguishes a compatibility gap from a setup error.
        return "unexpected-needs-triage"
    if result["skipReason"]:
        return "upstream-skip"
    if result["failed"] or result["crash"]:
        return "upstream-expected-nonpass"
    return "pass-selected-case"


def interrupted_attempts(observations, transport, native_results):
    """Match the observer's exact guest command to a unique selected native case."""
    if (not transport or transport.get("phase") != "upstream-runner" or
            transport.get("outcome") == "finished" or not observations or not observations.is_file()):
        return {}
    commands = defaultdict(list)
    unidentified_sources = {source for (_, source), result in native_results.items() if not result}
    for key, result in native_results.items():
        if not result or key[1] in unidentified_sources:
            continue
        argv = result.get("argv", [])
        source_suffix = "/" + key[1]
        scripts = [arg for arg in argv[1:] if arg.endswith(source_suffix)]
        if len(scripts) != 1:
            continue
        root = scripts[0][:-len(source_suffix)] + "/"
        args = tuple("/tmp/node-core-survey/" + arg[len(root):] if arg.startswith(root) else arg
                     for arg in argv[1:])
        commands[("/usr/bin/node", *args)].append(key)

    attempts = {}
    for line_number, line in enumerate(observations.read_text().splitlines(), 1):
        row = json.loads(line)
        kind = row["kind"]
        if kind not in ("launch", "exited", "launch-error"):
            continue
        matches = commands.get(tuple(row["argv"]), ())
        if len(matches) != 1:
            continue
        key = matches[0]
        if kind == "launch":
            if "TEST_SERIAL_ID" not in (row.get("environment") or {}):
                continue
            attempts[key] = {"launchLine": line_number, "argv": row["argv"],
                             "transportOutcome": transport["outcome"]}
        elif key not in attempts:
            continue
        attempts[key].update(lastChildRecord=kind, lastChildLine=line_number)
        for field in ("pid", "exitStatus", "timeout", "error"):
            if field in row:
                attempts[key][field] = row[field]
    return attempts


def summarize(selection, observations, transport, native_results=None):
    expected = [(case["selector"], case["file"]) for case in selection["cases"]]
    expected_keys = set(expected)
    if len(expected_keys) != len(expected):
        raise ValueError("Duplicate source identity in the selected shard")
    sources_by_selector = defaultdict(list)
    for selector, source in expected:
        sources_by_selector[selector].append(source)
    discovered = rows(observations, "discovered", sources_by_selector)
    results = rows(observations, "result", sources_by_selector)
    if unexpected := (discovered.keys() | results.keys()) - expected_keys:
        raise ValueError(f"Unexpected discovery or results: {sorted(unexpected)}")
    if results.keys() - discovered.keys():
        raise ValueError("A result lacks an original suite discovery record")
    classified = {
        key: {
            "disposition": disposition(discovered.get(key), results.get(key), transport),
            "discovery": discovered.get(key),
            "result": results.get(key),
        } for key in expected
    }
    for key, attempt in interrupted_attempts(observations, transport, native_results or {}).items():
        case = classified[key]
        if case["discovery"] and case["result"] is None:
            case["caseAttempt"] = attempt
            case["disposition"] = ("runner-timeout" if attempt["transportOutcome"] == "timeout"
                                   else "runner-interrupted")
    return classified


def read_guest_run(directory, selection_sha256, host):
    if directory is None:
        return None, None, None
    identities_path = directory / "inputs.json"
    observations_path = directory / "observations.jsonl"
    transport_path = directory / "transport.json"
    if not transport_path.is_file():
        if observations_path.is_file():
            raise ValueError(f"Unattributed observations in {directory}")
        setup_error = directory / "setup-error.txt"
        if setup_error.is_file():
            return None, {"outcome": "setup-error", "error": setup_error.read_text().strip()}, None
        return None, None, None
    identities = json.loads(identities_path.read_bytes())
    if identities["host"].casefold() != host.casefold():
        raise ValueError(f"Expected {host} observations in {directory}, got {identities['host']}")
    prepared = identities.get("prepared")
    if prepared is None and not observations_path.is_file():
        return None, json.loads(transport_path.read_bytes()), identities
    if prepared is None or prepared["selectionSha256"] != selection_sha256:
        raise ValueError(f"Guest receipt uses a different selection in {directory}")
    return observations_path, json.loads(transport_path.read_bytes()), identities


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("selection", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--native", type=Path)
    parser.add_argument("--node-host", type=Path)
    parser.add_argument("--chromium", type=Path)
    parser.add_argument("--firefox", type=Path)
    parser.add_argument("--webkit", type=Path)
    args = parser.parse_args()
    selection_bytes = args.selection.read_bytes()
    selection = json.loads(selection_bytes)
    selection_sha256 = hashlib.sha256(selection_bytes).hexdigest()
    host_paths = {"Node": args.node_host, "Chromium": args.chromium, "Firefox": args.firefox, "WebKit": args.webkit}
    results = {"native": summarize(selection, args.native, None)}
    native_results = {key: row["result"] for key, row in results["native"].items()}
    receipts = {}
    for host, directory in host_paths.items():
        observations, transport, identities = read_guest_run(directory, selection_sha256, host)
        receipts[host] = {"path": str(directory) if directory else None,
                          "transport": transport and transport["outcome"],
                          "error": transport and (transport.get("error") or transport.get("teardownError")),
                          "artifactIdentity": identities and {
                              "receiptSha256": hashlib.sha256((directory / "inputs.json").read_bytes()).hexdigest(),
                              "imageSha256": identities["image"]["sha256"],
                              "kernelSha256": identities["kernelSha256"],
                              "nodePayloads": identities["nodePayloads"],
                              "lazyAssets": identities.get("lazyAssets"),
                              "fixtureArchiveSha256": (identities.get("prepared") or {}).get("fixtureArchiveSha256"),
                              "observerSha256": identities.get("observerSha256"),
                              "hostVersion": identities["version"],
                              "diagnosticOnly": identities.get("diagnosticOnly", False),
                          }}
        results[host] = summarize(selection, observations, transport, native_results)
    ledger = {
        "shard": selection["id"],
        "selectionSha256": selection_sha256,
        "scope": "Selected case outcomes with case-level provenance. Member, overload and family closure remain unproven.",
        "nativeObservations": str(args.native) if args.native else None,
        "guestReceipts": receipts,
        "cases": [
            {**case, **{host: classified[case["selector"], case["file"]] for host, classified in results.items()}}
            for case in selection["cases"]
        ],
    }
    with args.output.open("x") as output:
        json.dump(ledger, output, indent=2, sort_keys=True)
        output.write("\n")
    for host, classified in results.items():
        print(host, dict(Counter(row["disposition"] for row in classified.values())))
