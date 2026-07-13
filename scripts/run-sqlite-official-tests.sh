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
GUEST_SHELL="${SQLITE_TEST_SHELL:-}"

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

if [ -z "$GUEST_SHELL" ]; then
  if ! GUEST_SHELL="$("$REPO_ROOT/scripts/resolve-binary.sh" programs/dash.wasm)"; then
    echo "ERROR: SQLite testrunner child jobs require a current guest /bin/sh-compatible shell." >&2
    echo "Fetch/build dash, or set SQLITE_TEST_SHELL=/path/to/sh.wasm." >&2
    exit 1
  fi
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

write_unavailable_outcome_lists() {
  local reason="$1"
  local out="$RESULTS_DIR/outcome-lists"

  mkdir -p "$out"
  printf 'jobid\tstate\tdisplaytype\tdisplayname\tcases\terrors\tms\tsource\n' > "$out/passed-jobs.tsv"
  printf 'jobid\tstate\tdisplaytype\tdisplayname\tcases\terrors\tms\tsource\n' > "$out/failed-jobs.tsv"
  printf 'jobid\tstate\tdisplaytype\tdisplayname\tcases\terrors\tms\treason\tsource\n' > "$out/skipped-jobs.tsv"
  printf 'jobid\tstate\tdisplaytype\tdisplayname\tcases\terrors\tms\treason\tsource\n' > "$out/incomplete-jobs.tsv"
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
      WHERE state = 'done' AND coalesce(nerr, 0) = 0
      ORDER BY jobid;" > "$out/passed-jobs.tsv"

  sqlite3 -header -separator $'\t' "$db" \
    "SELECT jobid, state, displaytype, displayname,
            coalesce(ntest, 0) AS cases,
            coalesce(nerr, 0) AS errors,
            coalesce(span, 0) AS ms,
            'testrunner.db' AS source
       FROM jobs
      WHERE state = 'failed' OR (state = 'done' AND coalesce(nerr, 0) > 0)
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
    "SELECT coalesce(sum(state='done' AND coalesce(nerr, 0)=0), 0) AS passed_jobs,
            coalesce(sum(state='failed' OR (state='done' AND coalesce(nerr, 0)>0)), 0) AS failed_jobs,
            coalesce(sum(state='omit'), 0) AS skipped_jobs,
            coalesce(sum(state IN ('running','ready')), 0) AS incomplete_jobs,
            'testrunner.db' AS source
       FROM jobs;" > "$out/counts.tsv"
}

write_sqlite_report() {
  local db="$WORKDIR/testrunner.db"
  local report="$RESULTS_DIR/summary.txt"
  local failures="$RESULTS_DIR/failures.tsv"
  if [ ! -f "$db" ]; then
    echo "No testrunner.db was created at $db" > "$report"
    write_unavailable_outcome_lists "No testrunner.db was created at $db."
    return
  fi

  mkdir -p "$RESULTS_DIR"

  # SQLite's testrunner keeps its control database in WAL mode. Checkpoint
  # before copying so timeout artifacts remain self-contained after cleanup.
  sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true

  for artifact in testrunner.db testrunner.db-wal testrunner.db-shm testrunner.log testrunner_build.log; do
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
    } > "$report"
    : > "$failures"
    write_unavailable_outcome_lists "No usable jobs table was found in $db."
    echo "===== SQLite official testrunner database summary ====="
    cat "$report"
    return
  fi

  write_outcome_lists "$db"

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
           OR (state='done' AND coalesce(nerr, 0)>0)
        ORDER BY state, jobid;"
  } > "$report"

  sqlite3 -header -separator $'\t' "$db" \
    "SELECT jobid, state, displaytype, displayname, coalesce(ntest, 0) AS cases,
            coalesce(nerr, 0) AS errors, coalesce(span, 0) AS ms
      FROM jobs
      WHERE state IN ('failed', 'running', 'omit')
         OR (state='done' AND coalesce(nerr, 0)>0)
      ORDER BY state, jobid;" > "$failures"

  echo "===== SQLite official testrunner database summary ====="
  cat "$report"
}

patch_sqlite_testrunner_platform() {
  local runner="$1"
  local tmp

  if grep -q "Kandelo testrunner host selection for child jobs" "$runner"; then
    return
  fi

  tmp="${runner}.kandelo-platform.$$"
  awk '
    NR == 4 {
      print ""
      print "# Kandelo testrunner host selection for child jobs."
      print "# This controls only the SQLite helper-script launcher. Keep tcl_platform"
      print "# unchanged so the tests continue to observe the real Tcl target."
      print "set ::kandelo_testrunner_host Kandelo"
    }
    $0 == "switch -nocase -glob -- $tcl_platform(os) {" {
      print "set testrunner_host $tcl_platform(os)"
      print "if {[info exists ::kandelo_testrunner_host]} {"
      print "  set testrunner_host $::kandelo_testrunner_host"
      print "}"
      print "switch -nocase -glob -- $testrunner_host {"
      next
    }
    $0 == "  *openbsd* {" {
      print "  *kandelo* {"
      print "    set TRG(platform)    linux"
      print "    set TRG(make)        make.sh"
      print "    set TRG(makecmd)     \"sh make.sh\""
      print "    set TRG(testfixture) testfixture"
      print "    set TRG(shell)       sqlite3"
      print "    set TRG(run)         run.sh"
      print "    set TRG(runcmd)      \"sh run.sh\""
      print "  }"
    }
    { print }
  ' "$runner" > "$tmp"
  mv "$tmp" "$runner"
  chmod a+r "$runner"

  for required in \
    'set ::kandelo_testrunner_host Kandelo' \
    'switch -nocase -glob -- $testrunner_host {' \
    '*kandelo* {'
  do
    if ! grep -Fq "$required" "$runner"; then
      echo "ERROR: failed to patch SQLite testrunner.tcl host selection: missing $required" >&2
      exit 1
    fi
  done
}

patch_sqlite_testrunner_guest_paths() {
  local runner="$1"
  local tmp

  if grep -q "Kandelo guest path shim for all-mode child jobs" "$runner"; then
    return
  fi

  tmp="${runner}.kandelo-paths.$$"
  awk '
    {
      print
      if (!inserted && $0 == "cd $dir") {
        print ""
        print "# Kandelo guest path shim for all-mode child jobs."
        print "# testrunner.tcl builds child run.sh files from host-normalized paths;"
        print "# convert workdir-local paths back to paths relative to each testdirN"
        print "# directory, because SQLite runs the script after cd-ing into it."
        print "proc kandelo_guest_path {path} {"
        print "  set normalized [file normalize $path]"
        print "  set topdir [file normalize [file dirname $::testdir]]"
        print "  set exe [file normalize [info nameofexec]]"
        print "  set script [file normalize [info script]]"
        print "  if {[string equal $normalized $exe]} { return \"../testfixture.wasm\" }"
        print "  if {[string equal $normalized $script]} { return \"../test/testrunner.tcl\" }"
        print "  if {[string equal $normalized $topdir]} { return \"..\" }"
        print "  set prefix \"${topdir}/\""
        print "  if {[string first $prefix $normalized] == 0} {"
        print "    return \"../[string range $normalized [string length $prefix] end]\""
        print "  }"
        print "  return $path"
        print "}"
        print "set ::kandelo_inline_run_sh 1"
        print "set ::kandelo_chunk_pipe_output 1"
        inserted = 1
      } else if ($0 == "    set displayname [string map [list $topdir/ {}] $f]") {
        print "    set testfixture_guest [kandelo_guest_path $testfixture]"
        print "    set testrunner_tcl_guest [kandelo_guest_path $testrunner_tcl]"
        print "    set f_guest [kandelo_guest_path $f]"
      }
    }
  ' "$runner" > "$tmp"
  mv "$tmp" "$runner"

  tmp="${runner}.kandelo-paths-subst.$$"
  awk '
    $0 == "      set cmd \"$testfixture $f\"" {
      print "      set cmd \"$testfixture_guest $f_guest\""
      next
    }
    $0 == "      set cmd \"$testfixture $testrunner_tcl $config $f\"" {
      print "      set cmd \"$testfixture_guest $testrunner_tcl_guest $config $f_guest\""
      next
    }
    $0 == "    set set_tmp_dir \"export SQLITE_TMPDIR=\\\"[file normalize $dir]\\\"\"" {
      print "    set set_tmp_dir \"export SQLITE_TMPDIR=.\""
      next
    }
    $0 == "    set fd [open \"|$TRG(runcmd) 2>@1\" r]" {
      print "    if {[info exists ::kandelo_inline_run_sh] && $::kandelo_inline_run_sh} {"
      print "      set inline_cmd \"$set_tmp_dir\\n$job(cmd)\""
      print "      set fd [open \"|sh -c [list $inline_cmd] 2>@1\" r]"
      print "    } else {"
      print "      set fd [open \"|$TRG(runcmd) 2>@1\" r]"
      print "    }"
      next
    }
    $0 == "    set rc [catch { gets $fd line } res]" {
      print "    if {[info exists ::kandelo_chunk_pipe_output] && $::kandelo_chunk_pipe_output} {"
      print "      set rc [catch { read $fd 4096 } res]"
      print "      if {$rc} {"
      print "        puts \"ERROR $res\""
      print "      }"
      print "      if {!$rc && [string length $res] > 0} {"
      print "        append O($iJob) $res"
      print "      }"
      print "    } else {"
      print "      set rc [catch { gets $fd line } res]"
      next
    }
    $0 == "    if {$res>=0} {" {
      print "    if {![info exists ::kandelo_chunk_pipe_output] || !$::kandelo_chunk_pipe_output} {"
      print "      if {$res>=0} {"
      next
    }
    $0 == "      append O($iJob) \"$line\\n\"" {
      print
      print "      }"
      print "    }"
      next
    }
    { print }
  ' "$runner" > "$tmp"
  mv "$tmp" "$runner"
  chmod a+r "$runner"

  for required in \
    'set ::kandelo_inline_run_sh 1' \
    'set ::kandelo_chunk_pipe_output 1' \
    'set fd [open "|sh -c [list $inline_cmd] 2>@1" r]' \
    'set rc [catch { read $fd 4096 } res]'
  do
    if ! grep -Fq "$required" "$runner"; then
      echo "ERROR: failed to patch SQLite testrunner.tcl for Kandelo all-mode jobs: missing $required" >&2
      exit 1
    fi
  done
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
if [ -n "$GUEST_SHELL" ]; then
  cp "$GUEST_SHELL" "$WORKDIR/sh"
  cp "$GUEST_SHELL" "$WORKDIR/sh.wasm"
  chmod a+rx "$WORKDIR/sh" "$WORKDIR/sh.wasm"
fi
patch_sqlite_testrunner_platform "$WORKDIR/test/testrunner.tcl"
patch_sqlite_testrunner_guest_paths "$WORKDIR/test/testrunner.tcl"

RUNNER_TCL="$WORKDIR/kandelo-testrunner.tcl"
cat > "$RUNNER_TCL" <<'TCL'
# Select Kandelo's helper-script launcher without changing Tcl target metadata
# observed by SQLite's tests.
set ::kandelo_testrunner_host Kandelo
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
KERNEL_PATH="$WORKDIR:${KERNEL_PATH:-/usr/local/bin:/usr/bin:/bin}" \
KERNEL_UID="${SQLITE_TEST_UID:-1000}" \
KERNEL_GID="${SQLITE_TEST_GID:-1000}" \
TIMEOUT="$TIMEOUT_MS" \
node --experimental-wasm-exnref --import tsx/esm \
  "$REPO_ROOT/examples/run-example.ts" \
  "$WORKDIR/testfixture.wasm" \
  "${ARGS[@]}"
status=$?
set -e

write_sqlite_report || true
exit "$status"
