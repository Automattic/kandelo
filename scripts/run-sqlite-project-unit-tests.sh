#!/usr/bin/env bash
set -euo pipefail

# Run SQLite's official project unit-test harness on Kandelo hosts.
#
# This wraps scripts/run-sqlite-official-tests.sh so one command can exercise
# the same upstream testrunner.tcl permutation on the Node host, the browser
# host, or both, and then leave a combined markdown summary with pass counts.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

HOST="both"
PERMUTATION="full"
JOBS="${SQLITE_PROJECT_UNIT_JOBS:-${SQLITE_OFFICIAL_JOBS:-1}}"
TIMEOUT_MS="${SQLITE_PROJECT_UNIT_TIMEOUT_MS:-${SQLITE_OFFICIAL_TIMEOUT_MS:-600000}}"
RESULTS_ROOT="${SQLITE_PROJECT_UNIT_RESULTS_ROOT:-}"
EXPLAIN=false
FAIL_FAST=false
EXTRA_ARGS=()

usage() {
  cat <<USAGE
Usage: $0 [OPTIONS] [pattern-or-test ...]

Options:
  --host node|browser|both  Host(s) to run (default: both)
  --permutation NAME        SQLite testrunner permutation: veryquick, full, all (default: full)
  --jobs N                  testrunner.tcl --jobs value for each host (default: 1)
  --timeout-ms N            Per-host outer timeout in milliseconds (default: 600000)
  --results-root DIR        Root directory for per-host artifacts and combined summary
  --explain                 Ask testrunner.tcl to print the planned work
  --fail-fast               Stop after the first host exits non-zero
  --help                    Show this help

Examples:
  $0 --host both --permutation full --jobs 2 --timeout-ms 21600000
  $0 --host node --permutation veryquick busy2.test walsetlk.test

Artifacts:
  Each host writes to <results-root>/<host>/ using run-sqlite-official-tests.sh.
  The combined markdown summary is written to <results-root>/combined-summary.md.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      HOST="${2:-}"
      case "$HOST" in
        node|browser|both) ;;
        *) echo "ERROR: --host must be node, browser, or both" >&2; exit 1 ;;
      esac
      shift 2
      ;;
    --permutation)
      PERMUTATION="${2:-}"
      case "$PERMUTATION" in
        veryquick|full|all) ;;
        *) echo "ERROR: unsupported permutation: $PERMUTATION" >&2; exit 1 ;;
      esac
      shift 2
      ;;
    --jobs)
      JOBS="${2:-}"
      shift 2
      ;;
    --timeout-ms)
      TIMEOUT_MS="${2:-}"
      shift 2
      ;;
    --results-root)
      RESULTS_ROOT="${2:-}"
      shift 2
      ;;
    --explain)
      EXPLAIN=true
      shift
      ;;
    --fail-fast)
      FAIL_FAST=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      EXTRA_ARGS+=("$1")
      shift
      ;;
  esac
done

if [ -z "$RESULTS_ROOT" ]; then
  RESULTS_ROOT="$REPO_ROOT/test-runs/sqlite-project-unit-${PERMUTATION}/$(date +%Y%m%d-%H%M%S)"
fi
mkdir -p "$RESULTS_ROOT"

case "$HOST" in
  node) HOSTS=(node) ;;
  browser) HOSTS=(browser) ;;
  both) HOSTS=(node browser) ;;
esac

STATUSES=()
HOST_STATUS_FILE="$RESULTS_ROOT/host-status.tsv"
: > "$HOST_STATUS_FILE"

for host in "${HOSTS[@]}"; do
  host_results="$RESULTS_ROOT/$host"
  mkdir -p "$host_results"
  args=(
    --host "$host"
    --permutation "$PERMUTATION"
    --jobs "$JOBS"
    --timeout-ms "$TIMEOUT_MS"
    --results-dir "$host_results"
  )
  if $EXPLAIN; then
    args+=(--explain)
  fi
  if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
    args+=("${EXTRA_ARGS[@]}")
  fi

  echo "===== SQLite project unit tests on Kandelo $host host ====="
  echo "Permutation: $PERMUTATION | Jobs: $JOBS | Results: $host_results"

  set +e
  bash "$REPO_ROOT/scripts/run-sqlite-official-tests.sh" "${args[@]}"
  status=$?
  set -e

  STATUSES+=("$status")
  printf '%s\t%s\n' "$host" "$status" >> "$HOST_STATUS_FILE"

  if [ "$status" -ne 0 ] && $FAIL_FAST; then
    break
  fi
done

python_args=("$RESULTS_ROOT" "$PERMUTATION" "$JOBS" "$TIMEOUT_MS")
if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
  python_args+=("${EXTRA_ARGS[@]}")
fi

python3 - "${python_args[@]}" <<'PY'
import csv
import os
import sqlite3
import sys
from pathlib import Path

results_root = Path(sys.argv[1])
permutation = sys.argv[2]
jobs_arg = sys.argv[3]
timeout_ms = sys.argv[4]
patterns = sys.argv[5:]
status_path = results_root / "host-status.tsv"

hosts = []
if status_path.exists():
    with status_path.open(newline="") as f:
        for row in csv.reader(f, delimiter="\t"):
            if len(row) == 2:
                hosts.append((row[0], int(row[1])))

def q1(cur, sql):
    row = cur.execute(sql).fetchone()
    return row[0] if row else None

def summarize_text_report(host: str, status: int, reason: str):
    host_dir = results_root / host
    report_path = host_dir / "summary.txt"
    summary = {
        "host": host,
        "status": status,
        "total": None,
        "done": None,
        "failed": None,
        "omit": None,
        "running": None,
        "ready": None,
        "cases": None,
        "case_errors": None,
        "notable": reason,
    }
    if not report_path.exists():
        return summary
    lines = report_path.read_text(encoding="utf-8", errors="replace").splitlines()
    keys = [
        "total", "done", "failed", "omit", "running", "ready", "cases", "case_errors",
    ]
    for i, line in enumerate(lines):
        if "total_jobs" in line and "done_jobs" in line and i + 2 < len(lines):
            values = lines[i + 2].split()
            if len(values) >= len(keys):
                for key, value in zip(keys, values):
                    try:
                        summary[key] = int(value.replace(",", ""))
                    except ValueError:
                        pass
            break
    notable = []
    in_notable = False
    for line in lines:
        if line.startswith("Failed, running, and omitted jobs:"):
            in_notable = True
            continue
        if not in_notable:
            continue
        parts = line.split()
        if len(parts) >= 4 and parts[0].isdigit() and parts[1] in {"failed", "running", "omit"}:
            notable.append(f"{parts[1]}:{parts[3]}")
        if len(notable) >= 5:
            break
    if notable:
        summary["notable"] = "; ".join(notable)
    elif any(summary[key] is not None for key in keys):
        summary["notable"] = reason
    return summary

def summarize_db(host: str, status: int):
    host_dir = results_root / host
    db_path = host_dir / "testrunner.db"
    summary = {
        "host": host,
        "status": status,
        "total": None,
        "done": None,
        "failed": None,
        "omit": None,
        "running": None,
        "ready": None,
        "cases": None,
        "case_errors": None,
        "notable": "",
    }
    if not db_path.exists():
        return summarize_text_report(host, status, "no testrunner.db")
    try:
        con = sqlite3.connect(str(db_path))
        cur = con.cursor()
        has_jobs = cur.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs' LIMIT 1"
        ).fetchone()
        if not has_jobs:
            return summarize_text_report(host, status, "testrunner.db has no jobs table")
        row = cur.execute(
            """
            SELECT count(*),
                   coalesce(sum(state='done'), 0),
                   coalesce(sum(state='failed'), 0),
                   coalesce(sum(state='omit'), 0),
                   coalesce(sum(state='running'), 0),
                   coalesce(sum(state='ready'), 0),
                   coalesce(sum(ntest), 0),
                   coalesce(sum(nerr), 0)
              FROM jobs
            """
        ).fetchone()
        (
            summary["total"], summary["done"], summary["failed"], summary["omit"],
            summary["running"], summary["ready"], summary["cases"], summary["case_errors"],
        ) = row
        notable_rows = cur.execute(
            """
            SELECT state, displayname, coalesce(ntest, 0), coalesce(nerr, 0)
              FROM jobs
             WHERE state IN ('failed', 'running', 'omit')
             ORDER BY CASE state WHEN 'failed' THEN 0 WHEN 'running' THEN 1 ELSE 2 END, jobid
             LIMIT 5
            """
        ).fetchall()
        if notable_rows:
            summary["notable"] = "; ".join(
                f"{state}:{name} ({cases} cases/{errs} errors)"
                for state, name, cases, errs in notable_rows
            )
        con.close()
    except Exception as exc:  # keep the wrapper useful even with partial DBs
        return summarize_text_report(host, status, f"summary error: {exc}")
    return summary

summaries = [summarize_db(host, status) for host, status in hosts]

report = results_root / "combined-summary.md"
with report.open("w", encoding="utf-8") as f:
    f.write("# SQLite Project Unit Tests on Kandelo\n\n")
    f.write(f"Results root: `{results_root}`\n\n")
    f.write("## Invocation\n\n")
    f.write(f"- Permutation: `{permutation}`\n")
    f.write(f"- Jobs per host: `{jobs_arg}`\n")
    f.write(f"- Timeout per host: `{timeout_ms}` ms\n")
    if patterns:
        f.write("- Patterns/tests: " + ", ".join(f"`{p}`" for p in patterns) + "\n")
    else:
        f.write("- Patterns/tests: full permutation default\n")
    f.write("\n## Host summary\n\n")
    f.write("| Host | Runner exit | Total jobs | Done | Failed | Omitted | Running | Ready | SQLite cases | Case errors | Current challenges |\n")
    f.write("|------|-------------|------------|------|--------|---------|---------|-------|--------------|-------------|--------------------|\n")
    for s in summaries:
        def cell(key):
            value = s[key]
            return "-" if value is None else str(value)
        f.write(
            f"| `{s['host']}` | {s['status']} | {cell('total')} | {cell('done')} | "
            f"{cell('failed')} | {cell('omit')} | {cell('running')} | {cell('ready')} | "
            f"{cell('cases')} | {cell('case_errors')} | {s['notable'] or '-'} |\n"
        )
    f.write("\n## Artifacts\n\n")
    for host, _status in hosts:
        f.write(f"- `{host}`: `{results_root / host}`\n")
    f.write("\n")

print(f"===== Combined SQLite project unit test summary: {report} =====")
print(report.read_text(encoding="utf-8"))
PY

final_status=0
for status in "${STATUSES[@]}"; do
  if [ "$status" -ne 0 ]; then
    final_status="$status"
    break
  fi
done
exit "$final_status"
