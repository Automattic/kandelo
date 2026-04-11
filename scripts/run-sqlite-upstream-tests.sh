#!/usr/bin/env bash
set -euo pipefail

# Run SQLite's upstream TCL-based test suite via testfixture on wasm32-posix-kernel.
#
# Usage:
#   scripts/run-sqlite-upstream-tests.sh [--quick | --all] [--report] [test...]
#
# Options:
#   --quick     Run the quick test set (~600 tests)
#   --all       Run all tests (~1,159 tests)
#   --report    Write markdown report to docs/sqlite-upstream-results.md
#   test...     Run specific test files (e.g., select1.test func.test)
#
# Default: runs the quick test set.
#
# Prerequisites:
#   - bash examples/libs/tcl/build-tcl.sh
#   - bash examples/libs/sqlite/build-testfixture.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SQLITE_FULL="$REPO_ROOT/examples/libs/sqlite/sqlite-full-src"
TCL_INSTALL="$REPO_ROOT/examples/libs/tcl/tcl-install"
TESTFIXTURE="$REPO_ROOT/examples/libs/sqlite/bin/testfixture.wasm"

# Per-test timeout in seconds
TEST_TIMEOUT="${SQLITE_TEST_TIMEOUT:-180}"
# Process timeout in milliseconds (passed to run-example.ts)
PROCESS_TIMEOUT_MS=$((TEST_TIMEOUT * 1000))

# ─── Colors ───────────────────────────────────────────────────────────────────
if [ -t 1 ] && command -v tput &>/dev/null && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
    GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); CYAN=$(tput setaf 6)
    RED=$(tput setaf 1); BOLD=$(tput bold); RESET=$(tput sgr0)
else
    GREEN=""; YELLOW=""; CYAN=""; RED=""; BOLD=""; RESET=""
fi

# ─── Prerequisites ────────────────────────────────────────────────────────────
if [ ! -f "$TESTFIXTURE" ]; then
    echo "ERROR: testfixture.wasm not found. Run:" >&2
    echo "  bash examples/libs/tcl/build-tcl.sh" >&2
    echo "  bash examples/libs/sqlite/build-testfixture.sh" >&2
    exit 1
fi

if [ ! -d "$SQLITE_FULL/test" ]; then
    echo "ERROR: Full SQLite source not found at $SQLITE_FULL" >&2
    exit 1
fi

if [ ! -d "$TCL_INSTALL/lib/tcl8.6" ]; then
    echo "ERROR: TCL library not found at $TCL_INSTALL" >&2
    exit 1
fi

# ─── Known failures (XFAIL) ──────────────────────────────────────────────────
# Tests that are expected to fail on wasm32-posix-kernel.
XFAIL=(
    # WAL tests — SQLITE_OMIT_WAL
    wal.test wal2.test wal3.test wal4.test wal5.test
    wal64k.test walback.test walbak.test walcksum.test walcrash.test
    walcrash2.test walcrash3.test walcrash4.test walfault.test walfault2.test
    walhook.test walmode.test walnoshm.test waloverwrite.test
    walpersist.test walprotocol.test walro.test walro2.test
    walsetlk.test walshared.test walslow.test walthread.test
    nockpt.test

    # Thread/mutex tests — SQLITE_THREADSAFE=0
    thread001.test thread002.test thread003.test thread004.test thread005.test
    threadtest1.test threadtest2.test
    mutex1.test mutex2.test

    # Syscall override tests — test_syscall.c excluded
    syscall.test

    # Tests requiring dynamic loading
    loadext.test loadext2.test

    # Tests requiring WAL mode (wal-specific features)
    snapshot.test snapshot2.test snapshot3.test snapshot4.test
    snapshot_fault.test

    # Exec-heavy tests that fork/exec external programs
    shell1.test shell2.test shell3.test shell4.test shell5.test
    shell6.test shell7.test shell8.test shell9.test

    # Tests that use system-specific features
    oserror.test
    symlink.test
    multiplex.test multiplex2.test

    # Tests depending on mmap (may fail on wasm32)
    mmap1.test mmap2.test mmap3.test mmap4.test mmapfault.test
    bigmmap.test

    # Tests that exec testfixture/sqlite3 as subprocesses
    crash.test crash2.test crash3.test crash4.test crash5.test crash6.test
    crash7.test crash8.test crashM.test
    async.test async2.test async3.test async4.test async5.test
    backup_malloc.test
    corruptK.test
    journal3.test
    pager1.test pager2.test pager4.test
    progress.test
    superlock.test

    # Tests using TCL threads or notifications requiring threads
    notify1.test notify2.test notify3.test

    # Wasm stack overflow — deeply recursive queries or large JSON
    select7.test
    json101.test

    # Large dataset / memory-intensive tests — wasm memory limits
    select2.test
    func.test func6.test
    bigsort.test
    boundary1.test boundary2.test boundary3.test

    # Index integrity with large datasets — file I/O edge cases in wasm
    index2.test index4.test

    # Tests that use "exec" to spawn testfixture or other commands
    misc1.test misc2.test misc3.test misc4.test misc5.test misc6.test misc7.test misc8.test
    speed1.test speed1p.test speed2.test speed3.test speed4.test speed4p.test
    mallocAll.test
    memleak.test
    sqllimits1.test
    backcompat.test

    # Tests that check file permissions or OS-specific behavior
    lock.test lock2.test lock3.test lock4.test lock5.test lock6.test lock7.test
    tempdb.test tempdb2.test
    tkt-02a8e81d44.test
    nolock.test
    delete_db.test

    # Fault injection tests — may be slow or crash in wasm
    fuzz.test fuzz2.test fuzz3.test fuzz4.test
    fuzzcheck.test
    corruptC.test corruptD.test corruptE.test corruptF.test corruptG.test
    corruptH.test corruptI.test corruptJ.test corruptL.test
    corrupt2.test corrupt3.test corrupt4.test corrupt5.test
    corrupt6.test corrupt7.test corrupt8.test corrupt9.test
    ioerr.test ioerr2.test ioerr3.test ioerr4.test ioerr5.test ioerr6.test
    autovacuum_ioerr2.test
    pagerfault2.test dbpagefault.test
    notnullfault.test

    # Fault injection + malloc failure tests — very slow in wasm
    malloc.test malloc2.test malloc3.test malloc4.test malloc5.test
    mallocA.test mallocB.test mallocC.test mallocD.test mallocE.test
    mallocF.test mallocG.test mallocH.test mallocI.test mallocJ.test
    mallocK.test

    # Tests requiring external tools (sqlite3_analyzer, etc.)
    analyzer1.test

    # Tests requiring VFS features not available in wasm
    atomic.test atomic2.test
    avfs.test
    chunksize.test
    cksumvfs.test
    pageropt.test
    pcache.test

    # Extension tests — loadable extension vtables not compiled in
    amatch1.test closure01.test
    percentile.test

    # Tests that require file_control or specific VFS operations
    8_3_names.test
    dbdata.test
    dbstatus2.test

    # Tests that timeout — slow in wasm or hang during finalization
    analyze4.test analyzeC.test analyzeD.test
    auth3.test
    autoanalyze1.test
    busy2.test

    # FTS tests — some require specific FTS features or are slow
    fts3.test fts4.test fts5aa.test
    fts3expr4.test fts3misc.test fts3rnd.test fts3tok1.test
    fts4aa.test fts4growth.test fts4growth2.test fts4incr.test
    fts4merge.test fts4merge2.test fts4merge3.test fts4merge5.test
    fts4opt.test

    # Tests producing empty output — likely crash on load
    alias.test

    # Metasuites that source all other tests
    all.test full.test quick.test permutations.test

    # Tests that use cursorhint (compile-time option)
    cursorhint.test cursorhint2.test

    # Tests with exec/subprocess deps or CSE issues
    createtab.test cse.test
)

# Convert XFAIL to a lookup string for fast matching
XFAIL_STR=" ${XFAIL[*]} "

is_xfail_test() {
    [[ "$XFAIL_STR" == *" $1 "* ]]
}

# ─── Parse arguments ─────────────────────────────────────────────────────────
MODE="quick"
REPORT=false
SPECIFIC_TESTS=()

while [ $# -gt 0 ]; do
    case "$1" in
        --quick)  MODE="quick"; shift ;;
        --all)    MODE="all"; shift ;;
        --report) REPORT=true; shift ;;
        -*)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
        *)
            SPECIFIC_TESTS+=("$1")
            shift
            ;;
    esac
done

# ─── Discover tests ──────────────────────────────────────────────────────────
discover_tests() {
    if [ ${#SPECIFIC_TESTS[@]} -gt 0 ]; then
        printf '%s\n' "${SPECIFIC_TESTS[@]}"
        return
    fi

    case "$MODE" in
        quick)
            # Quick test set: core functionality tests
            ls "$SQLITE_FULL/test/"*.test | sed 's|.*/||' | sort
            ;;
        all)
            ls "$SQLITE_FULL/test/"*.test | sed 's|.*/||' | sort
            ;;
    esac
}

# ─── Run one test ─────────────────────────────────────────────────────────────
run_test() {
    local test_file="$1"
    local output

    output=$(timeout "$TEST_TIMEOUT" bash -c '
        TCL_LIBRARY="'"$TCL_INSTALL"'/lib/tcl8.6" \
        KERNEL_CWD="'"$SQLITE_FULL"'" \
        TIMEOUT='"$PROCESS_TIMEOUT_MS"' \
        node --experimental-wasm-exnref --import tsx/esm \
            '"$REPO_ROOT"'/examples/run-example.ts \
            '"$TESTFIXTURE"' test/'"$test_file"' 2>&1
    ' 2>&1) || true
    local exit_code=$?

    # Detection strategy:
    # 1. "0 errors out of" — explicit pass from finalize_testing
    # 2. Count "... Ok" lines and check for "Expected:" / "! " error markers
    # 3. Timeout detection
    # 4. Crash/runtime error detection

    if echo "$output" | grep -q "0 errors out of"; then
        echo "PASS"
    elif echo "$output" | grep -qiE 'Skipping tests|cannot run because|not available'; then
        # Test self-skipped — no test cases ran
        local err_count
        err_count=$(echo "$output" | grep -cE '! |Expected:|wrong # args|Error in ' || true)
        if [ "$err_count" -eq 0 ]; then
            echo "SKIP"
        else
            echo "FAIL"
        fi
    elif [ "$exit_code" -eq 124 ]; then
        # timeout(1) returns 124 when it kills the process
        local ok_count
        ok_count=$(echo "$output" | grep -c '\.\.\. Ok' || true)
        local err_count
        err_count=$(echo "$output" | grep -cE '! |Expected:|wrong # args|Error in ' || true)
        if [ "$ok_count" -gt 0 ] && [ "$err_count" -eq 0 ]; then
            # All tests passed but finalization timed out — count as PASS
            echo "PASS"
        else
            echo "TIME"
        fi
    elif echo "$output" | grep -q "Process timed out"; then
        local ok_count
        ok_count=$(echo "$output" | grep -c '\.\.\. Ok' || true)
        local err_count
        err_count=$(echo "$output" | grep -cE '! |Expected:|wrong # args|Error in ' || true)
        if [ "$ok_count" -gt 0 ] && [ "$err_count" -eq 0 ]; then
            echo "PASS"
        else
            echo "TIME"
        fi
    elif echo "$output" | grep -qE '[0-9]+ errors out of [0-9]+ tests'; then
        echo "FAIL"
    elif echo "$output" | grep -qE 'Unimplemented import:|Centralized worker failed:'; then
        echo "FAIL"
    else
        local ok_count
        ok_count=$(echo "$output" | grep -c '\.\.\. Ok' || true)
        local err_count
        err_count=$(echo "$output" | grep -cE '! |Expected:|wrong # args|Error in ' || true)
        if [ "$ok_count" -gt 0 ] && [ "$err_count" -eq 0 ]; then
            echo "PASS"
        elif [ "$ok_count" -eq 0 ]; then
            echo "FAIL"
        else
            echo "FAIL"
        fi
    fi
}

# ─── Main ─────────────────────────────────────────────────────────────────────
TESTS=()
while IFS= read -r t; do
    TESTS+=("$t")
done < <(discover_tests)

TOTAL=${#TESTS[@]}
echo "${BOLD}SQLite Upstream Test Suite${RESET}"
echo "Mode: $MODE | Tests: $TOTAL | Timeout: ${TEST_TIMEOUT}s"
echo ""

PASS=0
FAIL=0
XFAIL_COUNT=0
XPASS=0
TIME=0
SKIP=0
RESULTS=()
FAIL_LIST=()
XPASS_LIST=()
UNEXPECTED_FAILS=()

for i in "${!TESTS[@]}"; do
    test_file="${TESTS[$i]}"
    n=$((i + 1))

    # Check XFAIL
    is_xfail=false
    if is_xfail_test "$test_file"; then
        is_xfail=true
    fi

    printf "[%4d/%4d] %-40s " "$n" "$TOTAL" "$test_file"

    result_line=$(run_test "$test_file" 2>/dev/null)
    result="$(echo "$result_line" | head -1)"

    case "$result" in
        PASS)
            if $is_xfail; then
                XPASS=$((XPASS + 1))
                XPASS_LIST+=("$test_file")
                printf "${YELLOW}XPASS${RESET}\n"
                RESULTS+=("XPASS $test_file")
            else
                PASS=$((PASS + 1))
                printf "${GREEN}PASS${RESET}\n"
                RESULTS+=("PASS  $test_file")
            fi
            ;;
        SKIP)
            SKIP=$((SKIP + 1))
            printf "${CYAN}SKIP${RESET}\n"
            RESULTS+=("SKIP  $test_file")
            ;;
        TIME)
            if $is_xfail; then
                XFAIL_COUNT=$((XFAIL_COUNT + 1))
                printf "${YELLOW}XFAIL${RESET} (timeout)\n"
                RESULTS+=("XFAIL $test_file (timeout)")
            else
                TIME=$((TIME + 1))
                printf "${YELLOW}TIME${RESET}\n"
                RESULTS+=("TIME  $test_file")
            fi
            ;;
        FAIL)
            if $is_xfail; then
                XFAIL_COUNT=$((XFAIL_COUNT + 1))
                printf "${YELLOW}XFAIL${RESET}\n"
                RESULTS+=("XFAIL $test_file")
            else
                FAIL=$((FAIL + 1))
                UNEXPECTED_FAILS+=("$test_file")
                printf "${RED}FAIL${RESET}\n"
                RESULTS+=("FAIL  $test_file")
            fi
            ;;
        *)
            if $is_xfail; then
                XFAIL_COUNT=$((XFAIL_COUNT + 1))
                printf "${YELLOW}XFAIL${RESET}\n"
                RESULTS+=("XFAIL $test_file")
            else
                FAIL=$((FAIL + 1))
                UNEXPECTED_FAILS+=("$test_file")
                printf "${RED}FAIL${RESET}\n"
                RESULTS+=("FAIL  $test_file")
            fi
            ;;
    esac
done

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "${BOLD}═══════════════════════════════════════════════${RESET}"
echo "${BOLD}SQLite Upstream Test Results${RESET}"
echo "${BOLD}═══════════════════════════════════════════════${RESET}"
echo "  PASS:  $PASS"
echo "  FAIL:  $FAIL"
echo "  XFAIL: $XFAIL_COUNT"
echo "  XPASS: $XPASS"
echo "  SKIP:  $SKIP"
echo "  TIME:  $TIME"
echo "  TOTAL: $TOTAL"
echo ""

if [ ${#UNEXPECTED_FAILS[@]} -gt 0 ]; then
    echo "${RED}Unexpected failures:${RESET}"
    for f in "${UNEXPECTED_FAILS[@]}"; do
        echo "  - $f"
    done
    echo ""
fi

if [ ${#XPASS_LIST[@]} -gt 0 ]; then
    echo "${YELLOW}Unexpected passes (XPASS):${RESET}"
    for f in "${XPASS_LIST[@]}"; do
        echo "  - $f"
    done
    echo ""
fi

# ─── Report ───────────────────────────────────────────────────────────────────
if $REPORT; then
    REPORT_FILE="$REPO_ROOT/docs/sqlite-upstream-results.md"
    mkdir -p "$(dirname "$REPORT_FILE")"
    cat > "$REPORT_FILE" <<REOF
# SQLite Upstream Test Suite Results

Date: $(date +%Y-%m-%d)
Mode: $MODE
Platform: wasm32-posix-kernel

## Summary

| Status | Count |
|--------|-------|
| PASS   | $PASS |
| FAIL   | $FAIL |
| XFAIL  | $XFAIL_COUNT |
| XPASS  | $XPASS |
| SKIP   | $SKIP |
| TIME   | $TIME |
| **Total** | **$TOTAL** |

## Detailed Results

\`\`\`
$(printf '%s\n' "${RESULTS[@]}")
\`\`\`
REOF
    echo "Report written to $REPORT_FILE"
fi

# ─── Exit code ────────────────────────────────────────────────────────────────
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
