#!/usr/bin/env python3
"""Bounded actual-source controls; baseline failure never counts as a pass."""
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
logs = pathlib.Path(sys.argv[2])
logs.mkdir(parents=True, exist_ok=True)
cases = [
    "owner-finalize", "owner-before-unmap", "duplicate-reference",
    "reopen-unmap", "destroy-unmapped", "collapse-unmap", "explicit-release",
    "self-association", "legacy-normalization", "collapse-reentrant",
]
results = []
for variant in ["before", "data-only", "after"]:
    for case in cases:
        try:
            process = subprocess.run(
                [str(root / variant / "fixture"), case],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=5,
            )
            code, output = process.returncode, process.stdout
        except subprocess.TimeoutExpired as error:
            code, output = "timeout", error.stdout or b""
        (logs / f"{variant}-{case}.log").write_bytes(output)
        entered = f"ENTER {case}\n".encode() in output
        passed = code == 0 and f"PASS {case}\n".encode() in output
        diagnosed = any(marker in output for marker in (
            b"lifecycle_checked_get_data", b"assertion failed",
            b"should be FALSE", b"runtime error:",
        ))
        expected = passed if variant == "after" else (
            entered and diagnosed and code not in (0, "timeout")
        )
        row = {"variant": variant, "case": case, "exit": code, "expected": expected}
        results.append(row)
        print(json.dumps(row), flush=True)
        if not expected:
            print(output.decode(errors="replace"), file=sys.stderr)
(logs / "results.json").write_text(json.dumps(results, indent=2) + "\n")
if not all(row["expected"] for row in results):
    raise SystemExit("FAIL: upstream/partial/full lifecycle controls did not match")
print("PASS: 10 upstream failures, 10 partial-repair failures, 10 patched passes")
