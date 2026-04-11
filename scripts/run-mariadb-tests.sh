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
# Tests verified to pass on wasm-posix-kernel with SKIP_RESULT=1.
# Single-connection only (no-threads server), non-InnoDB, non-debug,
# non-exec, finishing within 60s timeout.

CURATED_TESTS=(
    1st
    adddate_454
    almost_full
    alter_table_lock
    alter_table_mdev539_maria
    alter_table_mdev539_myisam
    alter_table_upgrade_aria
    alter_table_upgrade_myisam
    analyze
    ansi
    assign_key_cache
    auto_increment
    bad_frm_crash_5029
    bench_count_distinct
    bool
    bulk_replace
    check_constraint
    check_constraint_show
    column_compression_parts
    column_compression_utf16
    comment_column
    comment_column2
    comment_database
    comment_index
    comments
    constraints
    contributors
    create-uca
    create_drop_db
    create_replace_tmp
    create_drop_trigger
    ctype_cp850
    ctype_cp866
    ctype_dec8
    ctype_filesystem
    ctype_hebrew
    ctype_mb
    ctype_partitions
    ctype_utf16_def
    ctype_utf32_def
    ctype_utf8_def_upgrade
    ctype_utf8mb4_unicode_ci_def
    datetime_456
    deprecated_features
    frm_bad_row_type-7333
    fulltext3
    fulltext_charsets
    fulltext_multi
    func_encrypt_ucs2
    func_equal
    func_op
    func_timestamp
    gcc296
    in_datetime_241
    information_schema2
    information_schema_prepare
    innodb_ignore_builtin
    insert_returning_datatypes
    insert_update_autoinc-7150
    key_primary
    last_value
    log_slow_filter
    log_state_bug33693
    long_tmpdir
    lowercase_utf8
    mdev19198
    mdev316
    mysqltest_256
    no_binlog
    opt_trace_default
    order_fill_sortbuf
    replace_returning_datatypes
    rollback
    set_statement_notembedded
    simple_select
    sp-bugs2
    sp-no-code
    sp-no-valgrind
    sql_mode_pad_char_to_full_length
    str_to_datetime_457
    sysdate_is_now
    tablelock
    timezone4
    trigger_no_defaults-11698
    type_char
    type_nchar
    type_temporal_mariadb53
    type_temporal_mysql56
)

# ── Expected failures ──────────────────────────────────────
# Tests known to fail on wasm-posix-kernel. Categories:
#
# multi_connect  — uses mysqltest 'connect' command for concurrent connections;
#                  deadlocks with --thread-handling=no-threads (single-threaded)
# innodb         — InnoDB storage engine not available (Aria only)
# exec           — uses --exec/--system shell commands (not supported)
# debug          — requires debug build (debug_dbug, debug_sync, have_debug)
# ssl            — SSL/TLS not compiled in
# binlog         — requires binary log (have_log_bin)
# grant          — uses CREATE USER/REVOKE (blocked by --skip-grant-tables)
# plugin         — requires dynamic plugin loading (not supported on wasm32)
# big_test       — requires BIG_TEST variable (extremely long tests)
# timeout        — test too large/slow for 60s timeout on wasm
# vardir         — test uses file system paths outside MYSQLTEST_VARDIR
# feature        — requires unavailable feature (profiling, staging, etc.)

EXPECTED_FAIL=(
    # ─── Multi-connection tests (connect command deadlocks with no-threads) ───
    # These tests open concurrent connections via mysqltest's 'connect' command.
    # With --thread-handling=no-threads, the server handles one connection at a
    # time, so the 2nd connection blocks until the 1st completes → deadlock.
    # ~111 tests in this category. Listed by pattern where possible.
    "aborted_clients"
    "change_user_notembedded"
    "check"                # uses connect
    "compress"
    "connect-abstract"
    "connect-no-db"
    "count_distinct"       # multiple connections
    "create"               # also uses CREATE USER
    "create_delayed"
    "create_user"
    "ctype_errors"
    "ctype_ldml"           # custom collation + connect
    "delayed_blob"
    "events_2"
    "events_restart"
    "events_scheduling"
    "flush2"
    "handlersocket"
    "handler_read_last"
    "having"
    "init_file"
    "ipv4_and_ipv6"
    "ipv6"
    "kill_query-6728"
    "lotofstack"
    "multi_statement"
    "no-threads"
    "odbc"
    "partition_open_files_limit"
    "profiling"
    "query_cache_merge"
    "query_cache_ps_no_prot"
    "query_cache_ps_ps_prot"
    "query_cache_with_views"
    "secure_file_priv_win"
    "select_found"
    "select_safe"
    "show"
    "signal"
    "signal_demo1"
    "signal_demo2"
    "signal_demo3"
    "single_delete_update"
    "stack"
    "stack-crash"
    "variables-notembedded"

    # ─── InnoDB-dependent tests ───
    # Matched by content grep; ~228 tests reference InnoDB engine.
    # Not individually listed — filtered at the harness level or caught by
    # the error "Unknown storage engine 'innodb'".

    # ─── exec/system tests ───
    # Tests that use --exec or --system directives to run shell commands.
    "delimiter_command_case_sensitivity"
    "bug47671"

    # ─── Grant/privilege tests ───
    # Tests that use CREATE USER, GRANT, REVOKE — blocked by --skip-grant-tables
    "bug58669"
    "create_drop_user"
    "enforce_storage_engine_opt"
    "grant_cache_no_prot"
    "grant_cache_ps_prot"
    "grant_repair"
    "sql_safe_updates"

    # ─── Plugin/dynamic loading tests ───
    # Tests that use INSTALL PLUGIN — not supported on wasm32
    "truncate_badse"
    "plugin"
    "plugin_load"
    "plugin_load_option"
    "plugin_maturity"
    "blackhole"
    "blackhole_plugin"
    "partition_blackhole"
    "partition_example"
    "udf"
    "udf_notembedded"
    "udf_query_cache"
    "udf_skip_grants"

    # ─── Timeout tests ───
    # Tests that consistently exceed 60s on wasm due to large data sets,
    # complex queries, or slow operations.
    "bigint"
    "brackets"
    "case"
    "compare"
    "count_distinct2"
    "create_utf8"
    "ctype_ascii"
    "ctype_binary"
    "ctype_swe7"
    "ctype_ucs2_def"
    "empty_string_literal"
    "fulltext_distinct"
    "group_by_null"
    "item_types"
    "key_diff"
    "mdev375"
    "myisam-optimize"
    "precedence_bugs"
    "second_frac-9175"
    "select_pkeycache"
    "statistics_close"
    "subselect_no_exists_to_in"
    "subselect_no_scache"
    "system_mysql_db"
    "temporal_scale_4283"
    "update_ignore_216"
    "win_i_s"
    "win_percent_cume"

    # ─── Feature/config tests ───
    "long_unique_using_hash"  # max key length mismatch (2000 vs expected)
    "ctype_utf8mb4_heap"      # missing errmsg.sys / lc_time_names
    "ctype_utf8mb4_myisam"    # missing errmsg.sys / lc_time_names
    "row-checksum-old"        # references InnoDB
    "alter_table_autoinc-5574" # references InnoDB
    "alter_table_errors"      # references InnoDB
    "bug46760"                # references InnoDB
    "cache_temporal_4265"     # requires debug_dbug
    "ctype_create"            # database name conflict
    "create_not_windows"      # VARDIR path issue with data dir
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

# If no specific tests given and not --all, use curated list
if [ ${#TEST_ARGS[@]} -eq 0 ] && ! $ALL_MODE; then
    TEST_ARGS=("${CURATED_TESTS[@]}")
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
if $ALL_MODE; then
    node --experimental-wasm-exnref --import tsx/esm "$HARNESS" > "$RESULTS_FILE" 2>"$STDERR_FILE"
else
    node --experimental-wasm-exnref --import tsx/esm "$HARNESS" "${TEST_ARGS[@]}" > "$RESULTS_FILE" 2>"$STDERR_FILE"
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
