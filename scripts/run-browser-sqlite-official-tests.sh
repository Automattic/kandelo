#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PERMUTATION="full"
JOBS="${SQLITE_OFFICIAL_JOBS:-1}"
TIMEOUT_MS="${SQLITE_OFFICIAL_TIMEOUT_MS:-600000}"
RESULTS_DIR="${SQLITE_OFFICIAL_RESULTS_DIR:-}"
EXPLAIN=false
EXTRA_ARGS=()

usage() {
  cat <<EOF
Usage: $0 [OPTIONS] [pattern-or-test ...]

Options:
  --permutation NAME  veryquick, full, or all (default: full)
  --jobs N            testrunner.tcl --jobs value (default: 1)
  --timeout-ms N      Browser command timeout (default: 600000)
  --results-dir DIR   Copy testrunner.db/logs and summary files to DIR
  --explain           Ask testrunner.tcl to print planned work
  --help              Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --permutation)
      PERMUTATION="${2:-}"
      case "$PERMUTATION" in
        veryquick|full|all) ;;
        *)
          echo "ERROR: unsupported permutation: $PERMUTATION" >&2
          exit 1
          ;;
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
    --results-dir)
      RESULTS_DIR="${2:-}"
      shift 2
      ;;
    --explain)
      EXPLAIN=true
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

if [ -z "$RESULTS_DIR" ]; then
  RESULTS_DIR="$REPO_ROOT/test-runs/sqlite-official-browser-${PERMUTATION}/$(date +%Y%m%d-%H%M%S)"
fi
mkdir -p "$RESULTS_DIR"

write_unavailable_outcome_lists() {
  local reason="$1"
  local out="$RESULTS_DIR/outcome-lists"

  mkdir -p "$out"
  printf 'jobid\tstate\tdisplaytype\tdisplayname\tcases\terrors\tms\tsource\n' > "$out/passed-jobs.tsv"
  printf 'jobid\tstate\tdisplaytype\tdisplayname\tcases\terrors\tms\tsource\n' > "$out/failed-jobs.tsv"
  printf 'jobid\tstate\tdisplaytype\tdisplayname\tcases\terrors\tms\treason\tsource\n' > "$out/skipped-jobs.tsv"
  printf 'jobid\tstate\tdisplaytype\tdisplayname\tcases\terrors\tms\treason\tsource\n' > "$out/incomplete-jobs.tsv"
  printf 'jobid\tdisplaytype\tdisplayname\tcase\treason\n' > "$out/skipped-cases.tsv"
  printf '\tunavailable\t\t\t0\t0\t0\t%s\trunner\n' "$reason" >> "$out/incomplete-jobs.tsv"
  {
    printf 'passed_jobs\tfailed_jobs\tskipped_jobs\tincomplete_jobs\tnote\n'
    printf '0\t0\t0\t1\t%s\n' "$reason"
  } > "$out/counts.tsv"
}

write_outcome_lists() {
  local db="$1"
  local out="$RESULTS_DIR/outcome-lists"

  mkdir -p "$out"
  sqlite3 -header -separator $'\t' "$db" \
    "SELECT jobid, state, displaytype, displayname,
            coalesce(ntest, 0) AS cases,
            coalesce(nerr, 0) AS errors,
            coalesce(span, 0) AS ms,
            'testrunner.db' AS source
       FROM jobs
      WHERE state = 'done'
      ORDER BY jobid;" > "$out/passed-jobs.tsv"

  sqlite3 -header -separator $'\t' "$db" \
    "SELECT jobid, state, displaytype, displayname,
            coalesce(ntest, 0) AS cases,
            coalesce(nerr, 0) AS errors,
            coalesce(span, 0) AS ms,
            'testrunner.db' AS source
       FROM jobs
      WHERE state = 'failed'
      ORDER BY jobid;" > "$out/failed-jobs.tsv"

  sqlite3 -header -separator $'\t' "$db" \
    "SELECT jobid, state, displaytype, displayname,
            coalesce(ntest, 0) AS cases,
            coalesce(nerr, 0) AS errors,
            coalesce(span, 0) AS ms,
            'runner omitted' AS reason,
            'testrunner.db' AS source
       FROM jobs
      WHERE state = 'omit'
      ORDER BY jobid;" > "$out/skipped-jobs.tsv"

  sqlite3 -header -separator $'\t' "$db" \
    "SELECT jobid, state, displaytype, displayname,
            coalesce(ntest, 0) AS cases,
            coalesce(nerr, 0) AS errors,
            coalesce(span, 0) AS ms,
            CASE state
              WHEN 'running' THEN 'runner exited before job completed'
              WHEN 'ready' THEN 'not started before runner exit'
              ELSE 'not completed before runner exit'
            END AS reason,
            'testrunner.db' AS source
       FROM jobs
      WHERE state IN ('running', 'ready')
      ORDER BY state, jobid;" > "$out/incomplete-jobs.tsv"

  sqlite3 -header -separator $'\t' "$db" \
    "SELECT sum(state='done') AS passed_jobs,
            sum(state='failed') AS failed_jobs,
            sum(state='omit') AS skipped_jobs,
            sum(state IN ('running','ready')) AS incomplete_jobs,
            'testrunner.db' AS source
       FROM jobs;" > "$out/counts.tsv"

  python3 - "$db" "$out/skipped-cases.tsv" <<'PY'
import csv
import re
import sqlite3
import sys

db_path, out_path = sys.argv[1], sys.argv[2]
line_re = re.compile(r"^\.\s+(\S+)\s+(.+)$")
with sqlite3.connect(db_path) as con, open(out_path, "w", newline="", encoding="utf-8") as out:
    writer = csv.writer(out, delimiter="\t")
    writer.writerow(["jobid", "displaytype", "displayname", "case", "reason"])
    for jobid, displaytype, displayname, output in con.execute(
        "SELECT jobid, displaytype, displayname, coalesce(output, '') FROM jobs ORDER BY jobid"
    ):
        for line in output.splitlines():
            match = line_re.match(line)
            if match:
                writer.writerow([jobid, displaytype, displayname, match.group(1), match.group(2)])
PY
}

repair_testrunner_db_from_log() {
  local db="$1"
  local log="$RESULTS_DIR/testrunner.log"
  local report="$RESULTS_DIR/testrunner-db-repair.tsv"

  if [ ! -f "$log" ]; then
    return
  fi

  python3 - "$db" "$log" "$report" <<'PY'
import re
import sqlite3
import sys
import time
from pathlib import Path

db_path = Path(sys.argv[1])
log_path = Path(sys.argv[2])
report_path = Path(sys.argv[3])

log = log_path.read_text(encoding="utf-8", errors="replace")
header_re = re.compile(r"^### (?P<name>.+?) (?P<ms>\d+)ms \((?P<state>done|failed)\)\s*$", re.MULTILINE)
summary_re = re.compile(r"\b(?P<errors>\d+) errors out of (?P<tests>\d+) tests(?: on (?P<platform>[^\n]+))?")
version_re = re.compile(r"\bSQLite \d\d\d\d-\d\d-\d\d \d\d:\d\d:\d\d [0-9a-fA-F]+")

blocks = {}
headers = list(header_re.finditer(log))
for i, match in enumerate(headers):
    body_start = match.end()
    body_end = headers[i + 1].start() if i + 1 < len(headers) else len(log)
    body = log[body_start:body_end].strip()
    blocks[match.group("name")] = {
        "state": match.group("state"),
        "span": int(match.group("ms")),
        "output": body,
    }

repaired = []
now_ms = int(time.time() * 1000)
with sqlite3.connect(db_path) as con:
    rows = con.execute(
        """
        SELECT jobid, state, displayname, starttime
          FROM jobs
         WHERE state IN ('running', 'ready')
            OR ntest IS NULL
            OR nerr IS NULL
        """
    ).fetchall()
    for jobid, state, displayname, starttime in rows:
        block = blocks.get(displayname)
        if not block:
            continue
        summary = summary_re.search(block["output"])
        if not summary:
            continue
        version = version_re.search(block["output"])
        span = block["span"]
        endtime = int(starttime or now_ms) + span
        nerr = int(summary.group("errors"))
        ntest = int(summary.group("tests"))
        platform = (summary.group("platform") or "").strip() or None
        svers = version.group(0) if version else None
        con.execute(
            """
            UPDATE jobs
               SET output = ?,
                   state = ?,
                   endtime = ?,
                   span = ?,
                   ntest = ?,
                   nerr = ?,
                   svers = ?,
                   pltfm = ?
             WHERE jobid = ?
            """,
            (block["output"], block["state"], endtime, span, ntest, nerr, svers, platform, jobid),
        )
        repaired.append((jobid, state, block["state"], displayname, ntest, nerr, span))

    if repaired:
        con.execute(
            "UPDATE config SET value = (SELECT coalesce(sum(nerr), 0) FROM jobs) WHERE name = 'nfail'"
        )
        con.execute(
            "UPDATE config SET value = (SELECT coalesce(sum(ntest), 0) FROM jobs) WHERE name = 'ntest'"
        )
        con.execute(
            "REPLACE INTO config VALUES('end', (SELECT coalesce(max(endtime), ?) FROM jobs))",
            (now_ms,),
        )
        con.commit()

with report_path.open("w", encoding="utf-8") as f:
    f.write("jobid\told_state\tnew_state\tdisplayname\tcases\terrors\tms\n")
    for row in repaired:
        f.write("\t".join(str(value) for value in row) + "\n")
PY
}

write_sqlite_report() {
  local db="$RESULTS_DIR/testrunner.db"
  local report="$RESULTS_DIR/summary.txt"
  local failures="$RESULTS_DIR/failures.tsv"
  local outcome_dir="$RESULTS_DIR/outcome-lists"
  if [ ! -f "$db" ]; then
    echo "No testrunner.db was created at $db" > "$report"
    write_unavailable_outcome_lists "No testrunner.db was created at $db."
    return
  fi

  if ! sqlite3 "$db" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs' LIMIT 1;" | grep -qx 1; then
    {
      echo "SQLite official testrunner summary"
      echo "host=browser"
      echo "permutation=$PERMUTATION"
      echo "jobs=$JOBS"
      echo "results_dir=$RESULTS_DIR"
      echo
      echo "No usable jobs table was found in $db."
      echo "The run likely failed before testrunner.tcl initialized its control database, or the exported database is malformed."
      echo
      echo "Available artifacts:"
      find "$RESULTS_DIR" -maxdepth 1 -type f -name 'testrunner.*' -print | sort
    } > "$report"
    : > "$failures"
    write_unavailable_outcome_lists "No usable jobs table was found in $db."
    echo "===== SQLite official testrunner database summary ====="
    cat "$report"
    return
  fi

  repair_testrunner_db_from_log "$db"
  write_outcome_lists "$db"

  {
    echo "SQLite official testrunner summary"
    echo "host=browser"
    echo "permutation=$PERMUTATION"
    echo "jobs=$JOBS"
    echo "results_dir=$RESULTS_DIR"
    echo
    sqlite3 -header -column "$db" \
      "SELECT count(*) AS total_jobs,
              sum(state='done') AS done_jobs,
              sum(state='failed') AS failed_jobs,
              sum(state='omit') AS omitted_jobs,
              sum(state='running') AS running_jobs,
              sum(state='ready') AS ready_jobs,
              coalesce(sum(ntest), 0) AS total_cases,
              coalesce(sum(nerr), 0) AS total_case_errors
         FROM jobs;"
    echo
    sqlite3 -header -column "$db" \
      "SELECT state,
              count(*) AS jobs,
              coalesce(sum(ntest), 0) AS cases,
              coalesce(sum(nerr), 0) AS case_errors
         FROM jobs
        GROUP BY state
        ORDER BY state;"
    echo
    echo "Skipped SQLite subcases with reasons:"
    awk 'NR > 1 { count++ } END { print count + 0 }' "$outcome_dir/skipped-cases.tsv"
    echo
    echo "Jobs by SQLite testrunner config:"
    sqlite3 -header -column "$db" \
      "WITH configs AS (
         SELECT CASE
                  WHEN displayname LIKE 'config=% %'
                  THEN substr(displayname, 8, instr(substr(displayname, 8), ' ') - 1)
                  ELSE 'full'
                END AS config,
                ntest,
                nerr
           FROM jobs
       )
       SELECT config,
              count(*) AS jobs,
              coalesce(sum(ntest), 0) AS cases,
              coalesce(sum(nerr), 0) AS case_errors
         FROM configs
        GROUP BY config
        ORDER BY CASE WHEN config='full' THEN 0 ELSE 1 END, config;"
    echo
    echo "Failed, running, and omitted jobs:"
    sqlite3 -header -column "$db" \
      "SELECT jobid, state, displaytype, displayname, coalesce(ntest, 0) AS cases,
              coalesce(nerr, 0) AS errors, coalesce(span, 0) AS ms
         FROM jobs
        WHERE state IN ('failed', 'running', 'omit')
        ORDER BY state, jobid;"
  } > "$report"

  sqlite3 -header -separator $'\t' "$db" \
    "SELECT jobid, state, displaytype, displayname, coalesce(ntest, 0) AS cases,
            coalesce(nerr, 0) AS errors, coalesce(span, 0) AS ms
       FROM jobs
      WHERE state IN ('failed', 'running', 'omit')
      ORDER BY state, jobid;" > "$failures"

  python3 "$REPO_ROOT/scripts/sqlite-case-outcomes.py" \
    --db "$db" \
    --results-dir "$RESULTS_DIR" \
    --host browser \
    --permutation "$PERMUTATION" || true

  echo "===== SQLite official testrunner database summary ====="
  cat "$report"
}

ARGS=(testfixture kandelo-testrunner.tcl --jobs "$JOBS")
if $EXPLAIN; then
  ARGS+=(--explain)
fi
ARGS+=("$PERMUTATION")
if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
  ARGS+=("${EXTRA_ARGS[@]}")
fi

echo "===== SQLite official testrunner.tcl on Kandelo browser host ====="
echo "Permutation: $PERMUTATION | Jobs: $JOBS"
echo "Results dir: $RESULTS_DIR"

set +e
node --import tsx/esm "$REPO_ROOT/scripts/browser-sqlite-official-runner.ts" \
  --timeout-ms "$TIMEOUT_MS" \
  --results-dir "$RESULTS_DIR" \
  "${ARGS[@]}"
status=$?
set -e

write_sqlite_report || true
exit "$status"
