#!/usr/bin/env bash
set -euo pipefail

# Run SQLite's official test/testrunner.tcl permutations on Kandelo.
#
# The existing run-sqlite-upstream-tests.sh runner executes each Tcl script
# directly once. This wrapper invokes SQLite's upstream testrunner.tcl so
# official permutations such as veryquick, full, and all can be attempted.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SQLITE_FULL="$REPO_ROOT/packages/registry/sqlite/sqlite-full-src"
TCL_INSTALL="$REPO_ROOT/packages/registry/tcl/tcl-install"
TESTFIXTURE="$REPO_ROOT/packages/registry/sqlite/bin/testfixture.wasm"
SQLITE3="$REPO_ROOT/packages/registry/sqlite/sqlite-install/bin/sqlite3.wasm"

HOST="node"
PERMUTATION="full"
JOBS="${SQLITE_OFFICIAL_JOBS:-1}"
TIMEOUT_MS="${SQLITE_OFFICIAL_TIMEOUT_MS:-600000}"
RESULTS_DIR="${SQLITE_OFFICIAL_RESULTS_DIR:-}"
WORKDIR="${SQLITE_OFFICIAL_WORKDIR:-}"
KEEP_WORKDIR="${SQLITE_OFFICIAL_KEEP_WORKDIR:-0}"
EXTRA_ARGS=()

usage() {
  cat <<EOF
Usage: $0 [OPTIONS] [pattern-or-test ...]

Options:
  --host node|browser       Host to run on (default: node)
  --permutation NAME        veryquick, full, or all (default: full)
  --jobs N                  testrunner.tcl --jobs value (default: 1)
  --timeout-ms N            Outer Kandelo process timeout (default: 600000)
  --results-dir DIR         Copy testrunner.db/logs and summary files to DIR
  --workdir DIR             Use DIR as the testrunner working directory
  --keep-workdir            Do not delete the temporary testrunner workdir
  --explain                 Ask testrunner.tcl to print the planned work
  --help                    Show this help

Examples:
  $0 --permutation veryquick main.test
  $0 --permutation full
  $0 --permutation all --explain

Browser-host official testrunner.tcl delegates to
scripts/run-browser-sqlite-official-tests.sh.
EOF
}

EXPLAIN=false
while [ $# -gt 0 ]; do
  case "$1" in
    --host)
      HOST="${2:-}"
      if [ "$HOST" != "node" ] && [ "$HOST" != "browser" ]; then
        echo "ERROR: --host must be node or browser" >&2
        exit 1
      fi
      shift 2
      ;;
    --permutation)
      PERMUTATION="${2:-}"
      case "$PERMUTATION" in
        veryquick|full|all) ;;
        release|mdevtest|sdevtest)
          echo "ERROR: $PERMUTATION requires host-side rebuilds/fuzz binaries and is not a Kandelo guest permutation yet." >&2
          exit 2
          ;;
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
    --workdir)
      WORKDIR="${2:-}"
      KEEP_WORKDIR=1
      shift 2
      ;;
    --keep-workdir)
      KEEP_WORKDIR=1
      shift
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

if [ "$HOST" = "browser" ]; then
  BROWSER_ARGS=(--permutation "$PERMUTATION" --jobs "$JOBS" --timeout-ms "$TIMEOUT_MS")
  if [ -n "$RESULTS_DIR" ]; then
    BROWSER_ARGS+=(--results-dir "$RESULTS_DIR")
  fi
  if $EXPLAIN; then
    BROWSER_ARGS+=(--explain)
  fi
  if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
    BROWSER_ARGS+=("${EXTRA_ARGS[@]}")
  fi
  exec "$REPO_ROOT/scripts/run-browser-sqlite-official-tests.sh" "${BROWSER_ARGS[@]}"
fi

if [ ! -f "$TESTFIXTURE" ] || [ ! -f "$SQLITE3" ] || [ ! -d "$SQLITE_FULL/test" ] || [ ! -d "$TCL_INSTALL/lib/tcl8.6" ]; then
  echo "ERROR: SQLite/Tcl test prerequisites are missing." >&2
  echo "Run:" >&2
  echo "  bash packages/registry/tcl/build-tcl.sh" >&2
  echo "  bash packages/registry/sqlite/build-testfixture.sh" >&2
  exit 1
fi

if [ -z "$WORKDIR" ]; then
  WORKDIR="$(mktemp -d "${SQLITE_OFFICIAL_TMPDIR:-/tmp}/kandelo-sqlite-official.XXXXXX")"
else
  mkdir -p "$WORKDIR"
fi
chmod 0777 "$WORKDIR"

if [ -z "$RESULTS_DIR" ]; then
  RESULTS_DIR="$REPO_ROOT/test-runs/sqlite-official-${HOST}-${PERMUTATION}/$(date +%Y%m%d-%H%M%S)"
fi
mkdir -p "$RESULTS_DIR"

write_sqlite_report() {
  local db="$WORKDIR/testrunner.db"
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

  mkdir -p "$RESULTS_DIR"
  for artifact in testrunner.db testrunner.log testrunner_build.log; do
    if [ -f "$WORKDIR/$artifact" ]; then
      cp "$WORKDIR/$artifact" "$RESULTS_DIR/$artifact"
    fi
  done

  if ! sqlite3 "$db" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs' LIMIT 1;" | grep -qx 1; then
    {
      echo "SQLite official testrunner summary"
      echo "host=$HOST"
      echo "permutation=$PERMUTATION"
      echo "jobs=$JOBS"
      echo "workdir=$WORKDIR"
      echo "results_dir=$RESULTS_DIR"
      echo
      echo "No usable jobs table was found in $db."
      echo "The run likely failed before testrunner.tcl initialized its control database, or the database is malformed."
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
    echo "host=$HOST"
    echo "permutation=$PERMUTATION"
    echo "jobs=$JOBS"
    echo "workdir=$WORKDIR"
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

cleanup() {
  if [ "$KEEP_WORKDIR" = "1" ]; then
    echo "Keeping SQLite official workdir: $WORKDIR"
  else
    rm -rf "$WORKDIR"
  fi
}
trap cleanup EXIT

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude /testdir "$SQLITE_FULL"/ "$WORKDIR"/
else
  cp -R "$SQLITE_FULL"/. "$WORKDIR"/
  rm -rf "$WORKDIR/testdir"
fi
chmod -R a+rX "$WORKDIR"
chmod 0777 "$WORKDIR"
mkdir -p "$WORKDIR/testdir"
chmod 0777 "$WORKDIR/testdir"
cp "$TESTFIXTURE" "$WORKDIR/testfixture"
cp "$TESTFIXTURE" "$WORKDIR/testfixture.wasm"
cp "$SQLITE3" "$WORKDIR/sqlite3"
cp "$SQLITE3" "$WORKDIR/sqlite3.wasm"
chmod a+rx "$WORKDIR/testfixture" "$WORKDIR/testfixture.wasm" "$WORKDIR/sqlite3" "$WORKDIR/sqlite3.wasm"

RUNNER_TCL="$WORKDIR/kandelo-testrunner.tcl"
cat > "$RUNNER_TCL" <<'TCL'
# Kandelo's Tcl build reports a target OS name that SQLite's testrunner.tcl
# does not classify. Present a Unix-like platform to the upstream runner and
# use its OpenBSD branch so generated helper scripts run with sh instead of
# bash.
set ::tcl_platform(os) OpenBSD
set ::tcl_platform(platform) unix
set argv0 test/testrunner.tcl
source $argv0
TCL
chmod a+r "$RUNNER_TCL"

ARGS=(kandelo-testrunner.tcl --jobs "$JOBS")
if $EXPLAIN; then
  ARGS+=(--explain)
fi
ARGS+=("$PERMUTATION")
if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
  ARGS+=("${EXTRA_ARGS[@]}")
fi

echo "===== SQLite official testrunner.tcl on Kandelo Node host ====="
echo "Permutation: $PERMUTATION | Jobs: $JOBS | Workdir: $WORKDIR"
echo "Results dir: $RESULTS_DIR"

set +e
TCL_LIBRARY="$TCL_INSTALL/lib/tcl8.6" \
KERNEL_CWD="$WORKDIR" \
KERNEL_UID="${SQLITE_TEST_UID:-1000}" \
KERNEL_GID="${SQLITE_TEST_GID:-1000}" \
TIMEOUT="$TIMEOUT_MS" \
node --experimental-wasm-exnref --import tsx/esm \
  "$REPO_ROOT/examples/run-example.ts" \
  "$TESTFIXTURE" \
  "${ARGS[@]}"
status=$?
set -e

write_sqlite_report || true
exit "$status"
