#!/usr/bin/env python3
"""Bounded actual-source controls; baseline failure never counts as a pass."""
import json
import pathlib
import re
import subprocess
import sys

def known_collapse_read_fault(root, variant, case, code, output):
    """Recognize only the symbolicated stale-node read in this counterfactual."""
    if (variant not in ("before", "data-only")
            or case not in ("collapse-unmap", "collapse-reentrant")
            or code not in (-6, 1)):
        return False
    if not all(marker in output for marker in (
        b"UndefinedBehaviorSanitizer:DEADLYSIGNAL",
        b"ERROR: UndefinedBehaviorSanitizer: SEGV on unknown address",
        b"The signal is caused by a READ memory access.",
    )):
        return False
    if not re.search(rb"(?m)^==[0-9]+==ABORTING\s*$", output):
        return False
    source = pathlib.Path(root) / variant / "src/window.c"
    try:
        lines = source.read_text().splitlines()
    except OSError:
        return False
    # Bind the diagnostic to this run's exact compiled source, never a suffix
    # such as window.c or a generic sanitizer signal from another operation.
    location = re.escape(str(source).encode())
    frame = re.search(
        rb"(?m)^\s*#0 0x[0-9a-fA-F]+ in window_collapse_popups "
        + location + rb":([0-9]+):([0-9]+)\s*$", output,
    )
    if not frame:
        return False
    line, column = int(frame[1]), int(frame[2])
    if not (1 <= line <= len(lines) and 1 <= column <= len(lines[line - 1])):
        return False
    # Both collapse fixtures enter this traversal. This access immediately
    # follows hide emitting unmap and freeing the
    # live iterator node. A different source statement is not this proof.
    if lines[line - 1].strip() != "if(GTK_IS_MENU(iter->data))":
        return False
    preceding = [text.strip() for text in lines[:line - 1] if text.strip()]
    if not preceding or preceding[-1] != "gtk_widget_hide(iter->data);":
        return False
    start = "void window_collapse_popups ( GtkWidget *self )"
    traversal = "for(iter=*refs; iter; iter=g_list_next(iter))"
    if start not in preceding or traversal not in preceding[preceding.index(start):]:
        return False
    summary = (rb"(?m)^SUMMARY: UndefinedBehaviorSanitizer: SEGV " + location
               + f":{line}:{column} in window_collapse_popups".encode() + rb"\s*$")
    return re.search(summary, output) is not None


def expected_case(root, variant, case, code, output):
    entered = f"ENTER {case}\n".encode() in output
    passed = code == 0 and f"PASS {case}\n".encode() in output
    diagnosed = any(marker in output for marker in (
        b"lifecycle_checked_get_data", b"assertion failed",
        b"should be FALSE", b"runtime error:",
    )) or known_collapse_read_fault(root, variant, case, code, output)
    return passed if variant == "after" else (
        entered and diagnosed and code not in (0, "timeout")
    )


def main():
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
            expected = expected_case(root, variant, case, code, output)
            row = {"variant": variant, "case": case, "exit": code, "expected": expected}
            results.append(row)
            print(json.dumps(row), flush=True)
            if not expected:
                print(output.decode(errors="replace"), file=sys.stderr)
    (logs / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    if not all(row["expected"] for row in results):
        raise SystemExit("FAIL: upstream/partial/full lifecycle controls did not match")
    print("PASS: 10 upstream failures, 10 partial-repair failures, 10 patched passes")


if __name__ == "__main__":
    main()
