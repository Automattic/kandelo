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

write_sqlite_report() {
  local db="$RESULTS_DIR/testrunner.db"
  local report="$RESULTS_DIR/summary.txt"
  local failures="$RESULTS_DIR/failures.tsv"
  local outcome_dir="$RESULTS_DIR/outcome-lists"
  bash "$REPO_ROOT/scripts/write-sqlite-official-outcome-lists.sh" "$db" "$outcome_dir" || true
  if [ ! -f "$db" ]; then
    {
      echo "No testrunner.db was created at $db"
      echo
      echo "Outcome lists:"
      echo "passed_jobs=$outcome_dir/passed-jobs.tsv"
      echo "failed_jobs=$outcome_dir/failed-jobs.tsv"
      echo "skipped_jobs=$outcome_dir/skipped-jobs.tsv"
      echo "incomplete_jobs=$outcome_dir/incomplete-jobs.tsv"
    } > "$report"
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
      echo
      echo "Outcome lists:"
      echo "passed_jobs=$outcome_dir/passed-jobs.tsv"
      echo "failed_jobs=$outcome_dir/failed-jobs.tsv"
      echo "skipped_jobs=$outcome_dir/skipped-jobs.tsv"
      echo "incomplete_jobs=$outcome_dir/incomplete-jobs.tsv"
    } > "$report"
    : > "$failures"
    echo "===== SQLite official testrunner database summary ====="
    cat "$report"
    return
  fi

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
    echo
    echo "Outcome lists:"
    echo "passed_jobs=$outcome_dir/passed-jobs.tsv"
    echo "failed_jobs=$outcome_dir/failed-jobs.tsv"
    echo "skipped_jobs=$outcome_dir/skipped-jobs.tsv"
    echo "incomplete_jobs=$outcome_dir/incomplete-jobs.tsv"
  } > "$report"

  sqlite3 -header -separator $'\t' "$db" \
    "SELECT jobid, state, displaytype, displayname, coalesce(ntest, 0) AS cases,
            coalesce(nerr, 0) AS errors, coalesce(span, 0) AS ms
       FROM jobs
      WHERE state IN ('failed', 'running', 'omit')
      ORDER BY state, jobid;" > "$failures"

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
