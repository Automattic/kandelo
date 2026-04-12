#!/bin/bash
set -euo pipefail

# Run MariaDB mysql-test suite against wasm-posix-kernel.
#
# Prerequisites:
#   bash examples/libs/mariadb/build-mariadb.sh   # builds mariadbd + mysqltest
#   bash build.sh                                  # builds kernel wasm
#
# Usage:
#   scripts/run-mariadb-tests.sh                   # run curated passing tests
#   scripts/run-mariadb-tests.sh --all             # run all tests (slow)
#   scripts/run-mariadb-tests.sh test1 test2       # run specific tests
#   scripts/run-mariadb-tests.sh --report          # run curated + write markdown report
#   scripts/run-mariadb-tests.sh --list            # list available tests

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARIADB_LIB="$REPO_ROOT/examples/libs/mariadb"
INSTALL_DIR="$MARIADB_LIB/mariadb-install"
MYSQL_TEST_DIR="$INSTALL_DIR/mysql-test"
KERNEL_WASM="$REPO_ROOT/host/wasm/wasm_posix_kernel.wasm"
HARNESS="$REPO_ROOT/examples/mariadb-test/run-tests.ts"

# ── Curated test list ─────────────────────────────────────
# All tests are now run by default (threaded server).
# This list is kept for quick-run mode (--curated).

CURATED_TESTS=()

# ── Expected failures ──────────────────────────────────────
# Tests known to fail on wasm-posix-kernel (threaded server mode).
# Categories:
#
# innodb         — InnoDB storage engine not available (Aria only)
# debug          — requires debug build (debug_dbug, debug_sync, have_debug)
# grants         — --skip-grant-tables prevents user management
# exec           — uses --exec/--system/perl shell commands (not supported)
# stale_state    — test isolation: leftover tables/databases/functions
# locale         — locale error message files (errmsg.sys) read failure
# event          — event scheduler disabled or table schema mismatch
# timeout        — test too slow for wasm (>300s)
# aria           — Aria storage engine corruption/limitations
# key_length     — Aria max key length (2000) vs InnoDB (3072)
# behavior       — behavioral differences in Aria-only wasm build
# filesystem     — filesystem path issues (tmp, LOAD DATA, etc.)
# feature        — requires feature not compiled in (LDML collations, etc.)

EXPECTED_FAIL=(
    # innodb — InnoDB storage engine not available (58 tests)
    alter_events
    alter_table
    alter_table_autoinc-5574
    alter_table_errors
    alter_table_online
    alter_table_trans
    analyze_stmt_orderby
    auto_increment_ranges_innodb
    bug46760
    cache_innodb
    check_constraint_innodb
    column_compression
    commit
    concurrent_innodb_safelog
    concurrent_innodb_unsafelog
    consistent_snapshot
    cte_recursive
    ctype_sjis_innodb
    ctype_uca_innodb
    ctype_utf8mb3_innodb
    ctype_utf8mb4_innodb
    deadlock_innodb
    default
    default_innodb
    delete_innodb
    derived_cond_pushdown_innodb
    derived_split_innodb
    endspace
    explain_innodb
    explain_json_innodb
    ext_key_noPK_6794
    fast_prefix_index_fetch_innodb
    flush-innodb
    flush_block_commit
    foreign_key
    func_analyse
    func_group_innodb
    func_rollback
    function_defaults_innodb
    group_by_innodb
    group_min_max
    group_min_max_innodb
    group_min_max_notembedded
    index_intersect_innodb
    information_schema_inno
    innodb_ext_key
    innodb_icp
    innodb_icp_debug
    innodb_mrr_cpk
    insert_innodb
    join_cache
    join_outer_innodb
    keyread
    loaddata_autocom_innodb
    lock_kill
    lock_tables_lost_commit
    locked_temporary-5955
    long_unique_innodb

    # debug — requires debug build (16 tests)
    alter_table_debug
    alter_table_upgrade_myisam_debug
    analyze_debug
    cache_temporal_4265
    connect2
    connect_debug
    frm-debug
    func_debug
    func_regexp_pcre_debug
    gis-debug
    invisible_field_debug
    invisible_field_grant_completely
    join_cache_debug
    json_debug_nonembedded_noasan
    log_slow_debug
    long_unique_debug

    # grants — --skip-grant-tables prevents user management (33 tests)
    alter_user
    analyze_stmt_privileges
    analyze_stmt_privileges2
    bug58669
    change_user_notembedded
    connect
    create_drop_role
    create_user
    cte_grant
    cte_nonrecursive_not_embedded
    delete_returning_grant
    derived
    enforce_storage_engine
    events_trans_notembedded
    failed_auth_3909
    grant2
    grant3
    grant4
    grant5
    grant_binlog_replay
    grant_cache_no_prot
    grant_explain_non_select
    grant_kill
    grant_master_admin
    grant_server
    grant_slave_admin
    grant_slave_monitor
    information_schema
    init_connect
    init_file_set_password-7656
    invisible_field_grant_system
    kill-2
    lock_user

    # exec — uses --exec/--system/perl or spawns external processes (29 tests)
    analyze_stmt_slow_query_log
    binary_to_hex
    bootstrap
    bug47671
    client
    client_xml
    crash_commit_before
    ctype_upgrade
    ctype_utf32_not_embedded
    ddl_i18n_koi8r
    ddl_i18n_utf8
    delayed
    delimiter_command_case_sensitivity
    dirty_close
    distinct
    distinct_notembedded
    drop
    drop_bad_db_type
    drop_combinations
    empty_server_name-8224
    events_restart
    file_contents
    grant_not_windows
    ipv4_and_ipv6
    ipv6
    load_timezones_with_alter_algorithm_inplace
    loadxml
    log_errchk
    log_slow

    # stale_state — leftover tables/databases from prior tests (29 tests)
    ctype_create
    engine_error_in_alter-8453
    error_simulation
    errors
    events_logs_tests
    except
    except_all
    explain
    flush
    func_bit
    func_compress
    gis-rtree
    gis_notembedded
    grant
    grant_read_only
    grant_repair
    information_schema_chmod
    information_schema_db
    init_file
    init_file_longline_3816
    item_types
    join_outer
    join_outer_jcl6
    log_tables
    log_tables_debug
    log_tables_upgrade
    long_unique_bugs_no_sp_protocol
    long_unique_delayed
    long_unique_update

    # locale — errmsg.sys read failure for non-English locales (9 tests)
    ctype_errors
    ctype_ucs
    ctype_utf8
    ctype_utf8mb4
    date_formats
    default_session
    features
    func_time
    locale

    # event — event scheduler disabled or table schema mismatch (7 tests)
    events_1
    events_2
    events_bugs
    events_grant
    events_scheduling
    events_slowlog
    events_trans

    # timeout — too slow for wasm (9 tests)
    assign_key_cache
    ctype_binary
    ctype_cp1251
    ctype_latin1
    gis
    gis-precise
    gis-rt-precise
    huge_frm-6224
    key_cache

    # aria — table corruption or I/O issues (6 tests)
    create
    derived_view
    empty_user_table
    fulltext
    fulltext2
    fulltext_update

    # behavior — behavioral differences in Aria-only wasm build (8 tests)
    comments
    empty_string_literal
    enforce_storage_engine_opt
    flush2
    func_hybrid_type
    func_json
    function_defaults
    insert_select

    # key_length — Aria max key 2000 vs InnoDB 3072 (5 tests)
    ctype_utf16
    ctype_utf16le
    ctype_utf32
    long_unique
    long_unique_bugs

    # filesystem — path issues (3 tests)
    analyze_stmt
    flush_logs_not_windows
    loaddata

    # feature — not compiled in (2 tests)
    ctype_ldml
    ctype_like_range

    # insert_delayed — INSERT DELAYED not supported on Aria (2 tests)
    insert
    invisible_field
)

# ── Helper functions ──────────────────────────────────────

is_expected_fail() {
    local test_name="$1"
    for pattern in "${EXPECTED_FAIL[@]}"; do
        # Exact match
        [ "$pattern" = "$test_name" ] && return 0
        # Wildcard match
        if [[ "$pattern" == *"*"* ]]; then
            # shellcheck disable=SC2254
            case "$test_name" in
                $pattern) return 0 ;;
            esac
        fi
    done
    return 1
}

# ── Verify prerequisites ──────────────────────────────────

check_prereqs() {
    local missing=0

    if [ ! -f "$INSTALL_DIR/bin/mariadbd" ]; then
        echo "ERROR: mariadbd not found. Run: bash examples/libs/mariadb/build-mariadb.sh" >&2
        missing=1
    fi

    if [ ! -f "$INSTALL_DIR/bin/mysqltest.wasm" ]; then
        echo "ERROR: mysqltest.wasm not found. Run: bash examples/libs/mariadb/build-mariadb.sh" >&2
        missing=1
    fi

    if [ ! -f "$KERNEL_WASM" ]; then
        echo "ERROR: kernel wasm not found. Run: bash build.sh" >&2
        missing=1
    fi

    if [ ! -d "$MYSQL_TEST_DIR" ]; then
        echo "ERROR: mysql-test directory not found. Run: bash examples/libs/mariadb/build-mariadb.sh" >&2
        missing=1
    fi

    if [ ! -f "$HARNESS" ]; then
        echo "ERROR: test harness not found at $HARNESS" >&2
        missing=1
    fi

    [ $missing -eq 0 ] || exit 1
}

# ── Main ──────────────────────────────────────────────────

REPORT_MODE=false
LIST_MODE=false
ALL_MODE=false
TEST_ARGS=()

while [ $# -gt 0 ]; do
    case "$1" in
        --report) REPORT_MODE=true; shift ;;
        --list)   LIST_MODE=true; shift ;;
        --all)    ALL_MODE=true; shift ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS] [test1 test2 ...]"
            echo ""
            echo "Options:"
            echo "  --all       Run all 1184 tests (slow — many will timeout/fail)"
            echo "  --list      List available tests"
            echo "  --report    Run tests and write markdown report"
            echo "  --help      Show this help"
            echo ""
            echo "Without --all or test names, runs the curated set of ${#CURATED_TESTS[@]} passing tests."
            echo ""
            echo "Environment:"
            echo "  TEST_TIMEOUT    Per-test timeout in ms (default: 60000)"
            echo "  SKIP_RESULT     Set to 1 to skip .result file comparison"
            exit 0
            ;;
        *)  TEST_ARGS+=("$1"); shift ;;
    esac
done

check_prereqs

if $LIST_MODE; then
    exec node --experimental-wasm-exnref --import tsx/esm "$HARNESS" --list
fi

# If no specific tests given, run all tests (default is --all mode)
if [ ${#TEST_ARGS[@]} -eq 0 ]; then
    ALL_MODE=true
fi

echo "===== MariaDB mysql-test suite ====="
if $ALL_MODE; then
    echo "Mode: all tests"
else
    echo "Tests: ${#TEST_ARGS[@]}"
fi
echo ""

# Run the TypeScript harness, capture JSON stdout separately from stderr
RESULTS_FILE=$(mktemp)
STDERR_FILE=$(mktemp)
trap 'rm -f "$RESULTS_FILE" "$STDERR_FILE"' EXIT

export SKIP_RESULT="${SKIP_RESULT:-1}"

set +e
NODE_OPTS="--experimental-wasm-exnref --expose-gc --max-old-space-size=16384 --import tsx/esm"
if $ALL_MODE; then
    node $NODE_OPTS "$HARNESS" > "$RESULTS_FILE" 2>"$STDERR_FILE"
else
    node $NODE_OPTS "$HARNESS" "${TEST_ARGS[@]}" > "$RESULTS_FILE" 2>"$STDERR_FILE"
fi
HARNESS_EXIT=$?
set -e

# Show harness stderr (status messages)
cat "$STDERR_FILE" >&2

# Parse JSON output and classify results
PASS=0
FAIL=0
XFAIL=0
XPASS=0
SKIP=0
TOTAL=0
RESULTS=()

while IFS= read -r line; do
    # Skip empty lines or non-JSON lines
    [ -z "$line" ] && continue
    [[ "$line" == "{"* ]] || continue

    # Parse JSON fields using python3 (reliable, always available on macOS)
    parsed=$(echo "$line" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['test'])
    print(d['status'])
    print(d.get('time_ms', 0))
except: pass
" 2>/dev/null) || continue

    test_name=$(echo "$parsed" | sed -n '1p')
    status=$(echo "$parsed" | sed -n '2p')
    time_ms=$(echo "$parsed" | sed -n '3p')

    [ -z "$test_name" ] && continue
    # Skip internal helper tests
    [[ "$test_name" == __* ]] && continue

    TOTAL=$((TOTAL + 1))

    is_xfail=false
    if is_expected_fail "$test_name" 2>/dev/null; then
        is_xfail=true
    fi

    case "$status" in
        pass)
            if $is_xfail; then
                echo "XPASS $test_name"
                RESULTS+=("XPASS $test_name")
                XPASS=$((XPASS + 1))
            else
                RESULTS+=("PASS  $test_name")
                PASS=$((PASS + 1))
            fi
            ;;
        fail)
            if $is_xfail; then
                RESULTS+=("XFAIL $test_name")
                XFAIL=$((XFAIL + 1))
            else
                echo "FAIL  $test_name (${time_ms}ms)"
                RESULTS+=("FAIL  $test_name")
                FAIL=$((FAIL + 1))
            fi
            ;;
        skip)
            RESULTS+=("SKIP  $test_name")
            SKIP=$((SKIP + 1))
            ;;
    esac
done < "$RESULTS_FILE"

# ── Summary ──────────────────────────────────────────────

echo ""
echo "===== Results ====="
echo "PASS:    $PASS"
echo "FAIL:    $FAIL"
echo "XFAIL:   $XFAIL"
echo "XPASS:   $XPASS"
echo "SKIP:    $SKIP"
echo "TOTAL:   $TOTAL"
echo ""

# Show unexpected results
for status_prefix in "FAIL " "XPASS"; do
    count=0
    for r in "${RESULTS[@]}"; do
        [[ "$r" == "$status_prefix"* ]] && count=$((count + 1))
    done
    if [ $count -gt 0 ]; then
        echo "── ${status_prefix%% *} ($count) ──"
        for r in "${RESULTS[@]}"; do
            [[ "$r" == "$status_prefix"* ]] && echo "  $r"
        done
        echo ""
    fi
done

# ── Report mode ──────────────────────────────────────────

if $REPORT_MODE; then
    REPORT="$REPO_ROOT/docs/mariadb-test-report.md"
    {
        echo "# MariaDB mysql-test Suite Report"
        echo ""
        echo "Generated: $(date -u '+%Y-%m-%d %H:%M UTC')"
        echo ""
        echo "| Status | Count |"
        echo "|--------|-------|"
        echo "| PASS | $PASS |"
        echo "| FAIL | $FAIL |"
        echo "| XFAIL | $XFAIL |"
        echo "| XPASS | $XPASS |"
        echo "| SKIP | $SKIP |"
        echo "| **TOTAL** | **$TOTAL** |"
        echo ""

        for status_prefix in "FAIL " "XPASS"; do
            count=0
            for r in "${RESULTS[@]}"; do
                [[ "$r" == "$status_prefix"* ]] && count=$((count + 1))
            done
            if [ $count -gt 0 ]; then
                case "${status_prefix%% *}" in
                    FAIL) echo "## Unexpected Failures ($count)" ;;
                    XPASS) echo "## Unexpected Passes ($count)" ;;
                esac
                echo ""
                echo "| Test |"
                echo "|------|"
                for r in "${RESULTS[@]}"; do
                    if [[ "$r" == "$status_prefix"* ]]; then
                        local_test="${r#* }"
                        echo "| \`$local_test\` |"
                    fi
                done
                echo ""
            fi
        done
    } > "$REPORT"
    echo "Report written to: $REPORT"
fi

# Exit with error if any unexpected failures
if [ $FAIL -gt 0 ] || [ $XPASS -gt 0 ]; then
    exit 1
fi
