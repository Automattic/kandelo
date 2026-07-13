#!/usr/bin/env python3
"""Emit durable SQLite testrunner case and job outcome lists."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


OK_RE = re.compile(r"^(?P<name>.+?)\.\.\. Ok$")
OMITTED_RE = re.compile(r"^(?P<name>.+?)\.\.\. Omitted$")
FAIL_RE = re.compile(r"^! (?P<name>\S+) expected:")
FAILURES_RE = re.compile(r"^!Failures on these tests:\s*(?P<names>.*)$")
SUMMARY_RE = re.compile(r"\b(?P<errors>\d+) errors out of (?P<tests>\d+) tests\b")
OMITTED_DETAIL_RE = re.compile(r"^\.\s+(?P<name>\S+)\s+(?P<reason>.+)$")

@dataclass
class ParsedOutput:
    passed: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    skipped_counted: list[tuple[str, str]] = field(default_factory=list)
    skipped_detail: list[tuple[str, str]] = field(default_factory=list)
    summary_tests: int | None = None
    summary_errors: int | None = None


@dataclass
class Job:
    jobid: int | None
    state: str
    displaytype: str
    displayname: str
    ntest: int | None
    nerr: int | None
    span: int | None
    output: str


def normalize_output(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def append_unique(items: list[str], value: str) -> None:
    if value not in items:
        items.append(value)


def append_unique_pair(items: list[tuple[str, str]], value: tuple[str, str]) -> None:
    if value not in items:
        items.append(value)


def upsert_named_pair(items: list[tuple[str, str]], value: tuple[str, str]) -> None:
    for index, (name, _) in enumerate(items):
        if name == value[0]:
            items[index] = value
            return
    items.append(value)


def parse_output(text: str) -> ParsedOutput:
    parsed = ParsedOutput()
    in_omitted_detail = False
    failure_summary: list[str] = []

    for line in normalize_output(text).splitlines():
        line = line.strip()
        if not line:
            continue

        summary = SUMMARY_RE.search(line)
        if summary:
            parsed.summary_errors = int(summary.group("errors"))
            parsed.summary_tests = int(summary.group("tests"))

        if line == "Omitted test cases:":
            in_omitted_detail = True
            continue

        if in_omitted_detail:
            omitted_detail = OMITTED_DETAIL_RE.match(line)
            if omitted_detail:
                append_unique_pair(
                    parsed.skipped_detail,
                    (omitted_detail.group("name"), omitted_detail.group("reason")),
                )
                continue
            in_omitted_detail = False

        ok = OK_RE.match(line)
        if ok:
            parsed.passed.append(ok.group("name"))
            continue

        omitted = OMITTED_RE.match(line)
        if omitted:
            append_unique_pair(parsed.skipped_counted, (omitted.group("name"), "omitted by SQLite test harness"))
            continue

        failures = FAILURES_RE.match(line)
        if failures:
            failure_summary.extend(name for name in failures.group("names").split() if name)
            continue

        fail = FAIL_RE.match(line)
        if fail:
            append_unique(parsed.failed, fail.group("name"))

    if failure_summary:
        parsed.failed = failure_summary

    return parsed


def decode_db_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if value is None:
        return ""
    return str(value)


def read_jobs_from_db(db_path: Path) -> tuple[list[Job], str | None]:
    if not db_path.exists():
        return [], f"testrunner database is missing: {db_path}"

    db_uri = f"{db_path.resolve().as_uri()}?mode=ro"
    con = sqlite3.connect(db_uri, uri=True)
    # Some archived browser runs contain non-UTF-8 bytes in Tcl output. Read
    # TEXT as bytes so one diagnostic byte cannot make the whole report fail.
    con.text_factory = bytes
    try:
        has_jobs = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs' LIMIT 1"
        ).fetchone()
        if not has_jobs:
            return [], f"testrunner database has no jobs table: {db_path}"

        rows = con.execute(
            """
            SELECT jobid, state, displaytype, displayname,
                   ntest, nerr, span, coalesce(output, '')
              FROM jobs
             ORDER BY jobid
            """
        ).fetchall()
    finally:
        con.close()

    jobs = [
        Job(
            jobid=row[0],
            state=decode_db_text(row[1]),
            displaytype=decode_db_text(row[2]),
            displayname=decode_db_text(row[3]),
            ntest=row[4],
            nerr=row[5],
            span=row[6],
            output=decode_db_text(row[7]),
        )
        for row in rows
    ]
    return jobs, None


def read_stdout_job(stdout_path: Path, display_name: str) -> tuple[list[Job], str | None]:
    if not stdout_path.exists():
        return [], f"stdout file is missing: {stdout_path}"
    output = stdout_path.read_text(encoding="utf-8", errors="replace")
    parsed = parse_output(output)
    ntest = parsed.summary_tests
    nerr = parsed.summary_errors
    state = "failed" if nerr and nerr > 0 else "done"
    return [
        Job(
            jobid=1,
            state=state,
            displaytype="direct",
            displayname=display_name or "direct stdout",
            ntest=ntest,
            nerr=nerr,
            span=None,
            output=output,
        )
    ], None


def job_row(job: Job) -> list[Any]:
    return [
        "" if job.jobid is None else job.jobid,
        job.state,
        job.displaytype,
        job.displayname,
        "" if job.ntest is None else job.ntest,
        "" if job.nerr is None else job.nerr,
        "" if job.span is None else job.span,
    ]


def add_unavailable(unavailable: list[dict[str, Any]], category: str, reason: str, job: Job | None = None) -> None:
    entry: dict[str, Any] = {"category": category, "reason": reason}
    if job is not None:
        entry["job"] = {
            "jobid": job.jobid,
            "state": job.state,
            "displaytype": job.displaytype,
            "displayname": job.displayname,
            "ntest": job.ntest,
            "nerr": job.nerr,
        }
    unavailable.append(entry)


def build_outcomes(jobs: list[Job], source_reason: str | None) -> dict[str, Any]:
    passed_cases: list[str] = []
    failed_cases: list[str] = []
    skipped_cases: list[tuple[str, str]] = []
    passed_jobs: list[list[Any]] = []
    failed_jobs: list[list[Any]] = []
    skipped_jobs: list[list[Any]] = []
    incomplete_jobs: list[list[Any]] = []
    unattributed_passed_cases: list[list[Any]] = []
    unavailable: list[dict[str, Any]] = []

    if source_reason is not None:
        add_unavailable(unavailable, "all", source_reason)

    reported_executed_cases = 0
    reported_case_errors = 0

    for job in jobs:
        parsed = parse_output(job.output) if job.output else None
        effective_errors = job.nerr
        if effective_errors is None and parsed is not None:
            effective_errors = parsed.summary_errors

        if job.state == "done" and not effective_errors:
            passed_jobs.append(job_row(job))
        elif job.state == "failed" or (job.state == "done" and effective_errors):
            failed_jobs.append(job_row(job))
        elif job.state == "omit":
            skipped_jobs.append(job_row(job))
            add_unavailable(
                unavailable,
                "skipped_cases",
                "SQLite testrunner marked this job omitted; no case-level skip names are available.",
                job,
            )
            continue
        elif job.state in {"ready", "running", "halt", ""}:
            incomplete_jobs.append(job_row(job))
            add_unavailable(
                unavailable,
                "all_cases",
                f"SQLite testrunner job is incomplete with state {job.state or '<empty>'}.",
                job,
            )
            continue

        if not job.output:
            add_unavailable(unavailable, "all_cases", "SQLite job output is empty.", job)
            continue

        assert parsed is not None
        ntest = job.ntest if job.ntest is not None else parsed.summary_tests
        nerr = effective_errors
        if ntest is None or nerr is None:
            add_unavailable(unavailable, "all_cases", "Could not find SQLite 'errors out of tests' summary.", job)
            continue

        reported_executed_cases += ntest
        reported_case_errors += nerr

        job_skipped: list[tuple[str, str]] = []
        for skipped in parsed.skipped_counted:
            upsert_named_pair(job_skipped, skipped)
        for skipped in parsed.skipped_detail:
            # SQLite prints some omissions twice: once as `... Omitted` and
            # again in its detailed reason list. Keep one row and prefer the
            # specific reason.
            upsert_named_pair(job_skipped, skipped)
        for skipped in job_skipped:
            upsert_named_pair(skipped_cases, skipped)

        if len(parsed.failed) == nerr:
            failed_cases.extend(parsed.failed)
        elif nerr == 0 and not parsed.failed:
            pass
        else:
            failed_cases.extend(parsed.failed)
            add_unavailable(
                unavailable,
                "failed_cases",
                f"Parsed {len(parsed.failed)} failed case names, but SQLite reported {nerr} case errors.",
                job,
            )

        expected_passed = ntest - nerr - len(parsed.skipped_counted)
        missing_passed = expected_passed - len(parsed.passed)
        if missing_passed > 0:
            unattributed_passed_cases.append([
                "" if job.jobid is None else job.jobid,
                job.displayname,
                missing_passed,
                "SQLite reported passed cases without corresponding named Ok lines",
            ])
            add_unavailable(
                unavailable,
                "passed_cases",
                f"SQLite reported {expected_passed} passed cases, but only {len(parsed.passed)} names were present in output.",
                job,
            )
        elif missing_passed < 0:
            add_unavailable(
                unavailable,
                "passed_cases",
                f"Parsed {len(parsed.passed)} passed case names, but SQLite reported only {expected_passed} passed cases.",
                job,
            )
        passed_cases.extend(parsed.passed)

    selected_cases = reported_executed_cases + len(skipped_cases)
    categories = {
        "passed_cases": {
            "count": len(passed_cases),
            "unattributed_count": sum(row[2] for row in unattributed_passed_cases),
            "status": "available"
            if not any(entry["category"] in {"passed_cases", "all_cases", "all"} for entry in unavailable)
            else "partial",
        },
        "failed_cases": {
            "count": len(failed_cases),
            "status": "available"
            if not any(entry["category"] in {"failed_cases", "all_cases", "all"} for entry in unavailable)
            else "partial",
        },
        "skipped_cases": {
            "count": len(skipped_cases),
            "status": "available"
            if not any(entry["category"] in {"skipped_cases", "all_cases", "all"} for entry in unavailable)
            else "partial",
        },
    }

    return {
        "schema_version": 1,
        "summary": {
            "reported_executed_cases": reported_executed_cases,
            "reported_case_errors": reported_case_errors,
            "selected_cases": selected_cases,
            "passed_cases": len(passed_cases),
            "failed_cases": len(failed_cases),
            "skipped_cases": len(skipped_cases),
            "unattributed_passed_cases": sum(row[2] for row in unattributed_passed_cases),
            "jobs": {
                "passed": len(passed_jobs),
                "failed": len(failed_jobs),
                "skipped": len(skipped_jobs),
                "incomplete": len(incomplete_jobs),
            },
        },
        "categories": categories,
        "unavailable": unavailable,
        "lists": {
            "passed_cases": passed_cases,
            "failed_cases": failed_cases,
            "skipped_cases": skipped_cases,
            "unattributed_passed_cases": unattributed_passed_cases,
            "passed_jobs": passed_jobs,
            "failed_jobs": failed_jobs,
            "skipped_jobs": skipped_jobs,
            "incomplete_jobs": incomplete_jobs,
        },
    }


def write_lines(path: Path, lines: list[str]) -> None:
    path.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")


def write_tsv(path: Path, header: list[str], rows: list[list[Any] | tuple[Any, ...]]) -> None:
    out = ["\t".join(header)]
    for row in rows:
        out.append("\t".join(str(value) for value in row))
    path.write_text("\n".join(out) + "\n", encoding="utf-8")


def write_outputs(results_dir: Path, outcomes: dict[str, Any], source: dict[str, Any]) -> None:
    out_dir = results_dir / "outcome-lists"
    out_dir.mkdir(parents=True, exist_ok=True)
    lists = outcomes["lists"]

    write_lines(out_dir / "passed-cases.txt", lists["passed_cases"])
    write_lines(out_dir / "failed-cases.txt", lists["failed_cases"])
    write_tsv(out_dir / "skipped-cases.tsv", ["case", "reason"], lists["skipped_cases"])
    write_tsv(
        out_dir / "unattributed-passed-cases.tsv",
        ["jobid", "displayname", "count", "reason"],
        lists["unattributed_passed_cases"],
    )
    job_header = ["jobid", "state", "displaytype", "displayname", "cases", "errors", "ms"]
    write_tsv(out_dir / "passed-jobs.tsv", job_header, lists["passed_jobs"])
    write_tsv(out_dir / "failed-jobs.tsv", job_header, lists["failed_jobs"])
    write_tsv(out_dir / "skipped-jobs.tsv", job_header, lists["skipped_jobs"])
    write_tsv(out_dir / "incomplete-jobs.tsv", job_header, lists["incomplete_jobs"])

    serializable = {
        "schema_version": outcomes["schema_version"],
        "source": source,
        "summary": outcomes["summary"],
        "categories": outcomes["categories"],
        "unavailable": outcomes["unavailable"],
        "artifacts": {
            "passed_cases": str(out_dir / "passed-cases.txt"),
            "failed_cases": str(out_dir / "failed-cases.txt"),
            "skipped_cases": str(out_dir / "skipped-cases.tsv"),
            "unattributed_passed_cases": str(out_dir / "unattributed-passed-cases.tsv"),
            "passed_jobs": str(out_dir / "passed-jobs.tsv"),
            "failed_jobs": str(out_dir / "failed-jobs.tsv"),
            "skipped_jobs": str(out_dir / "skipped-jobs.tsv"),
            "incomplete_jobs": str(out_dir / "incomplete-jobs.tsv"),
        },
    }
    (out_dir / "case-outcomes.json").write_text(
        json.dumps(serializable, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (out_dir / "unavailable-categories.json").write_text(
        json.dumps(outcomes["unavailable"], indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    summary = outcomes["summary"]
    lines = [
        "# SQLite Case Outcomes",
        "",
        f"Executed cases reported by SQLite: {summary['reported_executed_cases']}",
        f"Case errors reported by SQLite: {summary['reported_case_errors']}",
        f"Passed case list entries: {summary['passed_cases']}",
        f"Failed case list entries: {summary['failed_cases']}",
        f"Skipped case list entries: {summary['skipped_cases']}",
        f"Passed cases without names in SQLite output: {summary['unattributed_passed_cases']}",
        "",
    ]
    if outcomes["unavailable"]:
        lines.append("Unavailable or partial categories:")
        for entry in outcomes["unavailable"]:
            lines.append(f"- {entry['category']}: {entry['reason']}")
    else:
        lines.append("All emitted case categories are complete for the reported harness totals.")
    lines.append("")
    (results_dir / "summary-case-outcomes.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, help="SQLite testrunner.db to inspect")
    parser.add_argument("--stdout-file", type=Path, help="Direct-run stdout file to inspect")
    parser.add_argument("--results-dir", type=Path, required=True, help="Directory for outcome-list artifacts")
    parser.add_argument("--host", default="", help="Host label for metadata")
    parser.add_argument("--permutation", default="", help="SQLite permutation label for metadata")
    parser.add_argument("--display-name", default="", help="Display name for stdout-only direct runs")
    args = parser.parse_args()

    jobs: list[Job]
    reason: str | None
    source: dict[str, Any] = {
        "host": args.host,
        "permutation": args.permutation,
    }

    if args.db is not None and args.db.exists():
        jobs, reason = read_jobs_from_db(args.db)
        source.update({"kind": "testrunner-db", "path": str(args.db)})
    elif args.stdout_file is not None:
        jobs, reason = read_stdout_job(args.stdout_file, args.display_name)
        source.update({"kind": "direct-stdout", "path": str(args.stdout_file)})
    elif args.db is not None:
        jobs, reason = read_jobs_from_db(args.db)
        source.update({"kind": "testrunner-db", "path": str(args.db)})
    else:
        jobs, reason = [], "no --db or --stdout-file source was provided"
        source.update({"kind": "missing"})

    outcomes = build_outcomes(jobs, reason)
    write_outputs(args.results_dir, outcomes, source)
    print(f"===== SQLite case outcome lists: {args.results_dir / 'outcome-lists'} =====")
    print((args.results_dir / "summary-case-outcomes.md").read_text(encoding="utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
