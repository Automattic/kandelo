#!/usr/bin/env python3
"""Expand SQLite official tiers and export durable outcome lists."""

from __future__ import annotations

import argparse
import csv
import json
import os
import shlex
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None


OUTCOME_HEADER = [
    "test",
    "jobid",
    "state",
    "displaytype",
    "cases",
    "errors",
    "duration_ms",
    "reason_or_error",
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    expand = sub.add_parser("expand", help="expand a tier manifest")
    expand.add_argument("--manifest", required=True)
    expand.add_argument("--tier", required=True)
    expand.add_argument("--host", required=True)
    expand.add_argument("--results-root", required=True)
    expand.add_argument("--timeout-ms", type=int)
    expand.add_argument("--shard")

    export = sub.add_parser("export", help="write outcome lists")
    export.add_argument("--results-root", required=True)
    export.add_argument("--planned", required=True)
    export.add_argument("--metadata", required=True)
    export.add_argument("--runner-status", required=True, type=int)
    export.add_argument("--runner-log")
    export.add_argument("--reason")

    args = parser.parse_args()
    if args.command == "expand":
        return expand_tier(args)
    return export_outcomes(args)


def load_tier(manifest_path: Path, name: str) -> dict:
    if tomllib is None:
        raise SystemExit("Python 3.11+ tomllib is required to read official-tiers.toml")
    with manifest_path.open("rb") as f:
        manifest = tomllib.load(f)
    for tier in manifest.get("tiers", []):
        if tier.get("name") == name:
            return tier
    raise SystemExit(f"unknown SQLite official tier: {name}")


def expand_tier(args: argparse.Namespace) -> int:
    manifest_path = Path(args.manifest)
    results_root = Path(args.results_root)
    results_root.mkdir(parents=True, exist_ok=True)
    tier = load_tier(manifest_path, args.tier)

    hosts = tier.get("hosts", [])
    if args.host not in hosts:
        return write_unsupported_host(results_root, manifest_path, tier, args.host)

    tests = tier.get("tests", [])
    if tier.get("sharded") and not tests:
        raise SystemExit(
            f"tier {args.tier} is declared sharded but has no pinned shard manifest yet"
        )
    if not tests:
        raise SystemExit(f"tier {args.tier} has no tests")
    if args.shard:
        raise SystemExit(f"tier {args.tier} does not support --shard yet")

    permutation = tier["permutation"]
    timeout_ms = args.timeout_ms if args.timeout_ms is not None else int(tier["timeout_ms"])
    patterns = exact_tail_patterns(tests, permutation, args.tier)

    planned_path = results_root / "planned-tests.tsv"
    with planned_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, delimiter="\t", lineterminator="\n")
        writer.writerow(["test", "pattern", "tier", "permutation", "host"])
        for test, pattern in zip(tests, patterns):
            writer.writerow([test, pattern, tier["name"], permutation, args.host])

    pattern_path = results_root / "runner-patterns.txt"
    pattern_path.write_text("".join(f"{pattern}\n" for pattern in patterns), encoding="utf-8")

    metadata_path = results_root / "tier-metadata.json"
    metadata = {
        "tier": tier["name"],
        "description": tier.get("description", ""),
        "host": args.host,
        "permutation": permutation,
        "timeout_ms": timeout_ms,
        "gate": bool(tier.get("gate", False)),
        "tests": tests,
        "runner_patterns": patterns,
        "manifest": str(manifest_path),
        "planned_tests": str(planned_path),
        "runner_patterns_file": str(pattern_path),
        "browser_status": tier.get("browser_status"),
        "generated_at": utc_now(),
    }
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")

    env = {
        "SQLITE_OFFICIAL_TIER": tier["name"],
        "SQLITE_OFFICIAL_PERMUTATION": permutation,
        "SQLITE_OFFICIAL_TIMEOUT_MS": str(timeout_ms),
        "SQLITE_OFFICIAL_PLANNED_TESTS": str(planned_path),
        "SQLITE_OFFICIAL_TIER_METADATA": str(metadata_path),
        "SQLITE_OFFICIAL_RUNNER_PATTERNS": str(pattern_path),
    }
    (results_root / "tier-env.sh").write_text(
        "".join(f"{key}={shlex.quote(value)}\n" for key, value in env.items()),
        encoding="utf-8",
    )
    return 0


def exact_tail_patterns(tests: list[str], permutation: str, tier_name: str) -> list[str]:
    seen: dict[str, str] = {}
    duplicates: list[str] = []
    for test in tests:
        base = os.path.basename(test)
        if base in seen:
            duplicates.append(base)
        seen[base] = test
    if duplicates:
        joined = ", ".join(sorted(set(duplicates)))
        raise SystemExit(f"tier {tier_name} has duplicate test basenames: {joined}")
    return [f"^{permutation} {os.path.basename(test)}$" for test in tests]


def write_unsupported_host(results_root: Path, manifest_path: Path, tier: dict, host: str) -> int:
    reason = (
        f"host {host} is not supported for {tier['name']}; supported hosts: "
        + ", ".join(tier.get("hosts", []))
    )
    metadata_path = results_root / "tier-metadata.json"
    metadata_path.write_text(
        json.dumps(
            {
                "tier": tier["name"],
                "description": tier.get("description", ""),
                "host": host,
                "permutation": tier.get("permutation"),
                "timeout_ms": int(tier.get("timeout_ms", 0)),
                "gate": bool(tier.get("gate", False)),
                "tests": tier.get("tests", []),
                "manifest": str(manifest_path),
                "browser_status": tier.get("browser_status"),
                "unsupported_reason": reason,
                "generated_at": utc_now(),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    planned_path = results_root / "planned-tests.tsv"
    with planned_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f, delimiter="\t", lineterminator="\n")
        writer.writerow(["test", "pattern", "tier", "permutation", "host"])
        for test in tier.get("tests", []):
            writer.writerow([test, "", tier["name"], tier.get("permutation", ""), host])
    export_args = argparse.Namespace(
        results_root=str(results_root),
        planned=str(planned_path),
        metadata=str(metadata_path),
        runner_status=2,
        runner_log=None,
        reason=reason,
    )
    export_outcomes(export_args)
    return 2


def export_outcomes(args: argparse.Namespace) -> int:
    results_root = Path(args.results_root)
    results_root.mkdir(parents=True, exist_ok=True)
    planned = read_planned(Path(args.planned))
    metadata = json.loads(Path(args.metadata).read_text(encoding="utf-8"))
    reason = args.reason or derive_runner_reason(args.runner_status, args.runner_log)

    db_path = results_root / "testrunner.db"
    passed: list[dict] = []
    failed: list[dict] = []
    skipped: list[dict] = []
    incomplete: list[dict] = []
    unexpected: list[dict] = []

    rows, db_error = read_jobs(db_path)
    if db_error is not None:
        if not metadata.get("unsupported_reason"):
            failed.append(synthetic_row("harness-setup", "failed", reason or db_error))
        for item in planned:
            incomplete.append(synthetic_row(item["test"], "incomplete", reason or db_error))
    else:
        classify_rows(
            rows,
            planned,
            args.runner_status,
            passed,
            failed,
            skipped,
            incomplete,
            unexpected,
            reason,
        )

    write_outcome_lists(results_root, passed, failed, skipped, incomplete)
    write_browser_status(results_root, metadata)
    summary = write_summary(
        results_root=results_root,
        metadata=metadata,
        planned=planned,
        runner_status=args.runner_status,
        runner_log=args.runner_log,
        db_path=db_path,
        db_error=db_error,
        passed=passed,
        failed=failed,
        skipped=skipped,
        incomplete=incomplete,
        unexpected=unexpected,
        reason=reason,
    )
    return 0 if summary["tier_status"] == "passed" else 1


def read_planned(path: Path) -> list[dict]:
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def derive_runner_reason(status: int, runner_log: str | None) -> str:
    if runner_log:
        path = Path(runner_log)
        if path.exists():
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if line.startswith("ERROR:") or line.startswith("Error:"):
                    return line
    return default_runner_reason(status)


def default_runner_reason(status: int) -> str:
    if status == 0:
        return ""
    return f"runner exited with status {status}"


def read_jobs(db_path: Path) -> tuple[list[dict], str | None]:
    if not db_path.exists():
        return [], f"no testrunner.db at {db_path}"
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        has_jobs = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs' LIMIT 1"
        ).fetchone()
        if not has_jobs:
            con.close()
            return [], f"{db_path} has no jobs table"
        rows = [
            dict(row)
            for row in con.execute(
                """
                SELECT jobid, state, displaytype, displayname,
                       coalesce(ntest, 0) AS cases,
                       coalesce(nerr, 0) AS errors,
                       coalesce(span, 0) AS duration_ms,
                       coalesce(output, '') AS output
                  FROM jobs
                 ORDER BY jobid
                """
            )
        ]
        con.close()
        return rows, None
    except Exception as exc:
        return [], f"could not read {db_path}: {exc}"


def classify_rows(
    rows: list[dict],
    planned: list[dict],
    runner_status: int,
    passed: list[dict],
    failed: list[dict],
    skipped: list[dict],
    incomplete: list[dict],
    unexpected: list[dict],
    runner_reason: str,
) -> None:
    planned_tests = [item["test"] for item in planned]
    planned_set = set(planned_tests)
    planned_by_base: dict[str, str | None] = {}
    for test in planned_tests:
        base = os.path.basename(test)
        planned_by_base[base] = test if base not in planned_by_base else None

    seen: set[str] = set()
    for row in rows:
        test = normalize_display_name(row["displayname"])
        if test not in planned_set:
            base_match = planned_by_base.get(os.path.basename(test))
            if base_match:
                test = base_match
        if test not in planned_set:
            unexpected_row = row_to_outcome(row, normalize_display_name(row["displayname"]))
            unexpected_row["reason_or_error"] = "unexpected job selected by tier runner"
            failed.append(unexpected_row)
            unexpected.append(unexpected_row)
            continue

        seen.add(test)
        outcome = row_to_outcome(row, test)
        state = row["state"]
        errors = int(row["errors"])
        if state == "done" and errors == 0:
            outcome["reason_or_error"] = f"ntest={row['cases']} nerr=0"
            passed.append(outcome)
        elif state == "omit":
            outcome["reason_or_error"] = first_output_line(row["output"]) or "sqlite testrunner omitted job"
            skipped.append(outcome)
        elif state == "failed" or errors > 0:
            outcome["reason_or_error"] = first_output_line(row["output"]) or f"nerr={errors}"
            failed.append(outcome)
        else:
            job_reason = f"state={state}"
            if runner_status:
                job_reason = f"{runner_reason or default_runner_reason(runner_status)}; {job_reason}"
            outcome["reason_or_error"] = job_reason
            incomplete.append(outcome)

    for test in planned_tests:
        if test not in seen:
            job_reason = "planned job was not present in testrunner.db"
            if runner_status:
                job_reason = f"{runner_reason or default_runner_reason(runner_status)}; {job_reason}"
            incomplete.append(synthetic_row(test, "incomplete", job_reason))


def normalize_display_name(displayname: str) -> str:
    if displayname.startswith("config="):
        parts = displayname.split(" ", 1)
        if len(parts) == 2:
            return parts[1]
    return displayname


def row_to_outcome(row: dict, test: str) -> dict:
    return {
        "test": test,
        "jobid": str(row["jobid"]),
        "state": row["state"],
        "displaytype": row["displaytype"],
        "cases": str(row["cases"]),
        "errors": str(row["errors"]),
        "duration_ms": str(row["duration_ms"]),
        "reason_or_error": "",
    }


def synthetic_row(test: str, state: str, reason: str) -> dict:
    return {
        "test": test,
        "jobid": "",
        "state": state,
        "displaytype": "harness" if test == "harness-setup" else "tcl",
        "cases": "0",
        "errors": "1" if state == "failed" else "0",
        "duration_ms": "0",
        "reason_or_error": reason,
    }


def first_output_line(output: str) -> str:
    for line in output.splitlines():
        line = line.strip()
        if line:
            return line
    return ""


def write_outcome_lists(
    results_root: Path,
    passed: list[dict],
    failed: list[dict],
    skipped: list[dict],
    incomplete: list[dict],
) -> None:
    lists = results_root / "outcome-lists"
    lists.mkdir(parents=True, exist_ok=True)
    write_tsv(lists / "passed-tests.tsv", passed)
    write_tsv(lists / "failed-tests.tsv", failed)
    write_tsv(lists / "skipped-tests.tsv", skipped)
    write_tsv(lists / "incomplete-tests.tsv", incomplete)


def write_tsv(path: Path, rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=OUTCOME_HEADER,
            delimiter="\t",
            lineterminator="\n",
        )
        writer.writeheader()
        for row in rows:
            writer.writerow({key: sanitize_tsv(str(row.get(key, ""))) for key in OUTCOME_HEADER})


def sanitize_tsv(value: str) -> str:
    return value.replace("\t", " ").replace("\r", " ").replace("\n", " ")


def write_browser_status(results_root: Path, metadata: dict) -> None:
    status = metadata.get("browser_status")
    if not status:
        return
    (results_root / "browser-status.json").write_text(
        json.dumps(status, indent=2) + "\n",
        encoding="utf-8",
    )
    lines = [
        "# Browser Status",
        "",
        f"Status: `{status.get('status', 'unknown')}`",
    ]
    if status.get("follow_up"):
        lines.append(f"Follow-up: `{status['follow_up']}`")
    if status.get("reason"):
        lines.extend(["", status["reason"]])
    (results_root / "browser-status.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_summary(
    *,
    results_root: Path,
    metadata: dict,
    planned: list[dict],
    runner_status: int,
    runner_log: str | None,
    db_path: Path,
    db_error: str | None,
    passed: list[dict],
    failed: list[dict],
    skipped: list[dict],
    incomplete: list[dict],
    unexpected: list[dict],
    reason: str,
) -> dict:
    counts = {
        "planned": len(planned),
        "passed": len(passed),
        "failed": len(failed),
        "skipped": len(skipped),
        "incomplete": len(incomplete),
        "unexpected": len(unexpected),
    }
    if (
        runner_status == 0
        and counts["failed"] == 0
        and counts["skipped"] == 0
        and counts["incomplete"] == 0
        and counts["unexpected"] == 0
        and counts["passed"] == counts["planned"]
    ):
        tier_status = "passed"
    elif counts["failed"] or counts["unexpected"]:
        tier_status = "failed"
    else:
        tier_status = "incomplete"

    artifacts = {
        "planned": str(results_root / "planned-tests.tsv"),
        "metadata": str(results_root / "tier-metadata.json"),
        "passed": str(results_root / "outcome-lists" / "passed-tests.tsv"),
        "failed": str(results_root / "outcome-lists" / "failed-tests.tsv"),
        "skipped": str(results_root / "outcome-lists" / "skipped-tests.tsv"),
        "incomplete": str(results_root / "outcome-lists" / "incomplete-tests.tsv"),
        "summary_json": str(results_root / "summary.json"),
        "summary_md": str(results_root / "summary.md"),
    }
    if runner_log:
        artifacts["runner_log"] = runner_log
    if db_path.exists():
        artifacts["testrunner_db"] = str(db_path)
    if metadata.get("browser_status"):
        artifacts["browser_status"] = str(results_root / "browser-status.json")

    summary = {
        "suite": "sqlite-official-tier",
        "tier": metadata.get("tier"),
        "host": metadata.get("host"),
        "permutation": metadata.get("permutation"),
        "gate": metadata.get("gate", False),
        "tier_status": tier_status,
        "runner_status": runner_status,
        "reason": reason,
        "db_error": db_error,
        "generated_at": utc_now(),
        "results_root": str(results_root),
        "counts": counts,
        "browser_status": metadata.get("browser_status"),
        "artifacts": artifacts,
    }
    (results_root / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    write_summary_md(results_root / "summary.md", summary, planned, passed, failed, skipped, incomplete)
    return summary


def write_summary_md(
    path: Path,
    summary: dict,
    planned: list[dict],
    passed: list[dict],
    failed: list[dict],
    skipped: list[dict],
    incomplete: list[dict],
) -> None:
    counts = summary["counts"]
    lines = [
        f"# SQLite Official Tier: {summary['tier']}",
        "",
        f"Host: `{summary['host']}`",
        f"Permutation: `{summary['permutation']}`",
        f"Tier status: `{summary['tier_status']}`",
        f"Runner exit: `{summary['runner_status']}`",
        (
            "Counts: "
            f"{counts['passed']} passed, {counts['failed']} failed, "
            f"{counts['skipped']} skipped, {counts['incomplete']} incomplete, "
            f"{counts['planned']} planned"
        ),
        "",
        "## Artifacts",
        "",
    ]
    for key, value in summary["artifacts"].items():
        lines.append(f"- `{key}`: `{value}`")
    if summary.get("browser_status"):
        lines.extend(["", "## Browser Status", ""])
        lines.append(f"Status: `{summary['browser_status'].get('status', 'unknown')}`")
        if summary["browser_status"].get("follow_up"):
            lines.append(f"Follow-up: `{summary['browser_status']['follow_up']}`")
        if summary["browser_status"].get("reason"):
            lines.extend(["", summary["browser_status"]["reason"]])
    lines.extend(["", "## Planned Tests", ""])
    for item in planned:
        lines.append(f"- `{item['test']}`")
    append_notable(lines, "Failed", failed)
    append_notable(lines, "Skipped", skipped)
    append_notable(lines, "Incomplete", incomplete)
    if passed:
        lines.extend(["", "## Passed", ""])
        for row in passed:
            lines.append(f"- `{row['test']}` ({row['duration_ms']} ms)")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def append_notable(lines: list[str], title: str, rows: list[dict]) -> None:
    if not rows:
        return
    lines.extend(["", f"## {title}", ""])
    for row in rows[:50]:
        lines.append(f"- `{row['test']}`: {row.get('reason_or_error', '')}")


if __name__ == "__main__":
    raise SystemExit(main())
