#!/bin/bash
set -euo pipefail

# Run MariaDB mysql-test suite in a headless browser via Playwright.
#
# Prerequisites:
#   bash packages/registry/mariadb/build-mariadb.sh   # builds mariadbd + mysqltest
#   bash build.sh                                  # builds kernel wasm
#   bash images/vfs/scripts/build-mariadb-test-vfs-image.sh  # builds test VFS image
#
# Usage:
#   scripts/run-browser-mariadb-tests.sh              # run curated tests
#   scripts/run-browser-mariadb-tests.sh --all        # run all mysql-test main tests
#   scripts/run-browser-mariadb-tests.sh test1 test2  # run specific tests

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR="$REPO_ROOT/packages/registry/mariadb/mariadb-install"
KERNEL_WASM="$("$REPO_ROOT/scripts/resolve-binary.sh" kernel.wasm 2>/dev/null || true)"
VFS_IMAGE="$REPO_ROOT/apps/browser-demos/public/mariadb-test.vfs.zst"
RUNNER="$REPO_ROOT/scripts/browser-mariadb-test-runner.ts"

# ── Curated tests (from full browser triage of all 1184 tests) ──
# 185 tests verified to pass in headless Chromium with MariaDB on Kandelo.
# Excludes: 230 connect-command tests (deadlock with no-threads), 339 timeouts,
#           143 self-skipping, 287 other failures.
CURATED_TESTS=(
    1st adddate_454 almost_full alter_table_combinations
    alter_table_lock alter_table_mdev539_maria
    alter_table_mdev539_myisam analyze ansi assign_key_cache
    auto_increment bad_frm_crash_5029 bench_count_distinct
    binary bool bulk_replace change_user check_constraint
    check_constraint_show column_compression_utf16
    comment_column comment_column2 comment_database
    comment_index comment_table comments constraints
    contributors create-uca create_drop_db create_drop_event
    create_drop_index create_drop_procedure create_drop_server
    create_drop_trigger create_not_windows create_replace_tmp
    create_w_max_indexes_64 ctype_cp1250_ch
    ctype_cp850 ctype_cp866 ctype_dec8 ctype_filesystem
    ctype_hebrew ctype_mb ctype_partitions ctype_uca_partitions
    ctype_ucs2_query_cache ctype_utf16_def ctype_utf32_def
    ctype_utf32_innodb ctype_utf8_def_upgrade
    ctype_utf8mb4_unicode_ci_def datetime_456 delayed_blob
    deprecated_features fulltext2 fulltext3 fulltext_update
    fulltext_var func_bit func_digest func_encrypt
    func_encrypt_nossl func_encrypt_ucs2 func_equal func_int
    func_op func_sapdb func_test func_timestamp gcc296
    gis-alter_table_online gis-json gis-rt-precise
    greedy_optimizer handler_read_last help
    implicit_char_to_num_conversion in_datetime_241
    index_intersect information_schema2
    information_schema_chmod information_schema_parameters
    information_schema_part information_schema_prepare
    information_schema_routines information_schema_stats
    innodb_ignore_builtin insert_returning_datatypes
    insert_update_autoinc-7150 join_crash key_primary
    last_value log_slow_filter log_state_bug33693 long_tmpdir
    long_unique_bugs_no_sp_protocol long_unique_delayed
    lowercase_table5 lowercase_table_grant lowercase_utf8
    mdev_14586 mdev19198 mdev316 mix2_myisam_ucs2
    multi_statement myisam-system myisam_enable_keys-10506
    myisam_mrr mysql5613mysql mysql57_virtual mysqltest_256
    negation_elimination no-threads no_binlog null_key odbc
    opt_trace_default opt_trace_index_merge opt_trace_ucs2
    order_by_sortkey order_by_zerolength-4285
    order_fill_sortbuf partition_bug18198
    partition_cache_myisam partition_charset partition_default
    partition_error partition_list ps_10nestset ps_1general
    selectivity_notembedded set_statement
    set_statement_notembedded show_create_user
    show_function_with_pad_char_to_full_length
    show_row_order-9226 signal_demo1 signal_demo2 signal_demo3
    signal_sqlmode simple_select single_delete_update
    skip_log_bin sp-bugs2 sp-condition-handler sp-destruct
    sp-memory-leak sp-no-code sp-no-valgrind sp-ucs2 sp-vars
    sp_gis sp_missing_4665 sql_mode_pad_char_to_full_length
    stat_tables_missing statement-expr str_to_datetime_457
    strict_autoinc_1myisam strict_autoinc_3heap subselect_gis
    subselect_sj_aria sysdate_is_now table_elim_debug
    table_options tablelock tablespace temp_table_frm
    temporal_literal timezone4 trigger_no_defaults-11698
    type_char type_date_round type_datetime_round
    type_hex_hybrid type_interval type_nchar type_num
    type_row type_set type_temporal_mariadb53
    type_temporal_mysql56 type_time_round varbinary
)

# ── Expected failures in browser ──
#
# The browser full-suite runner shares the Node wrapper's PASS/FAIL/XFAIL/XPASS
# contract, but keeps a separate list because browser full-suite artifacts have
# additional VFS and storage-state follow-ups that must stay visible as
# unexpected failures. Only classify known MariaDB build/MTR limitations here:
# release/debug-only tests, disabled event scheduler/plugins, unsupported native
# helper/client/shell commands, and expected-result differences from the
# Aria-only wasm build. See docs/mariadb-project-tests.md.
#
# The curated browser set is expected to pass in focused/default runs. If a
# curated test also appears below as a historical full-suite limitation, keep it
# as expected-pass so the default smoke does not turn green tests into XPASS.
BROWSER_EXPECTED_PASS=("${CURATED_TESTS[@]}")

BROWSER_EXPECTED_FAIL=(
    # release/debug-only surface absent in the production MariaDB build
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
    merge_debug
    myisam_debug
    myisam_debug_keys
    mysqltest_tracking_info_debug
    select_debug
    sequence_debug
    subselect_debug
    system_time_debug
    table_elim_debug
    type_temporal_mysql56_debug
    warnings_debug

    # event scheduler and dynamic plugin expectations not available in browser
    events_1
    events_2
    events_bugs
    events_grant
    events_scheduling
    events_slowlog
    events_trans
    events_trans_notembedded
    plugin
    plugin_innodb
    plugin_load
    plugin_load_option
    plugin_loaderr
    plugin_not_embedded

    # unsupported native helper/client/shell/perl commands in upstream MTR tests
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
    file_contents
    grant_not_windows
    ipv4_and_ipv6
    ipv6
    load_timezones_with_alter_algorithm_inplace
    log_errchk
    log_slow
    my_print_defaults
    myisampack
    mysql
    mysql-bug41486
    mysql-bug45236
    mysql-metadata
    mysql_comments
    mysql_cp932
    mysql_locale_posix
    mysql_not_windows
    mysql_protocols
    mysql_tzinfo_to_sql_symlink
    mysql_upgrade
    mysql_upgrade-20228
    mysql_upgrade-6984
    mysql_upgrade_file_leak
    mysql_upgrade_mysql_json_system_tables
    mysql_upgrade_no_innodb
    mysql_upgrade_to_100502
    mysqladmin
    mysqlcheck
    mysqld--defaults-file
    mysqld--help-aria
    mysqld_help_crash-9183
    mysqld_option_err
    mysqldump-compat
    mysqldump-compat-102
    mysqldump-nl
    mysqldump-no-binlog
    mysqldump-timing
    mysqldump-utf8mb4
    mysqlhotcopy_myisam
    mysqlshow
    mysqlslap
    not_embedded_server
    parser_not_embedded
    partition_not_windows
    repair_symlink-5543
    shutdown_not_windows
    symlink
    temp_table_symlink

    # Aria-only wasm build and upstream expected-result mismatches
    ctype_eucjpms
    ctype_like_range
    ctype_utf16
    ctype_utf16le
    ctype_utf32
    func_json
    insert
    invisible_field
    long_unique
    long_unique_bugs
    long_unique_using_hash
    old-mode
    partition
    partition_alter
    partition_datatype
    partition_example
    partition_exchange
    partition_innodb
    partition_innodb_semi_consistent
    partition_key_cache
    partition_mgm
    partition_mgm_err2
    partition_range
    password_expiration
    ps_2myisam
    ps_5merge
    ps_ddl
    ps_error
    range_innodb
    range_interrupted-13751
    rowid_filter_innodb
    select_safe
    selectivity_no_engine
    servers
    show_check
    signal_code
    skip_grants
    skip_name_resolve
    slowlog_enospace-10508
    slowlog_integrity
    sp-code
    sp-lock
    sp-security
    sp-security-anchor-type
    sp2
    sp_notembedded
    sql_mode
    sql_safe_updates
    ssl_verify_ip
    stat_tables_innodb
    statistics
    statistics_index_crash-7362
    status
    status2
    strict
    subselect3
    sum_distinct
    type_blob
    type_date
    type_datetime
    type_timestamp
    type_timestamp_round
    union
    union_crash-714
    unique
    upgrade
    upgrade_MDEV-19650
    upgrade_MDEV-23102-1
    upgrade_MDEV-23102-2
    upgrade_geometrycolumn_procedure_definer
    upgrade_mdev_24363
    variables
    variables-notembedded
    wait_timeout

    # browser test-image limitations rather than kernel/runtime regressions:
    # generated locale files and per-test server option files remain current
    # limitations of the browser harness after fixture path coverage improves.
    # locale — requires generated server locale/message data not present in
    # the fetch-only browser test image.
    ctype_errors
    ctype_ucs
    ctype_utf8
    ctype_utf8mb4
    date_formats
    default_session
    features
    func_time
    locale

    # charset/LDML — requires per-test *-master.opt server options such as
    # --character-sets-dir=$MYSQL_TEST_DIR/std_data/ldml.
    ctype_ldml
)

# ── Helpers ──

matches_test_pattern() {
    local test_name="$1"
    shift
    for pattern in "$@"; do
        [ "$pattern" = "$test_name" ] && return 0
        if [[ "$pattern" == *"*"* ]]; then
            case "$test_name" in
                $pattern) return 0 ;;
            esac
        fi
    done
    return 1
}

is_expected_fail() {
    local test_name="$1"
    if matches_test_pattern "$test_name" "${BROWSER_EXPECTED_PASS[@]+"${BROWSER_EXPECTED_PASS[@]}"}"; then
        return 1
    fi
    if matches_test_pattern "$test_name" "${BROWSER_EXPECTED_FAIL[@]+"${BROWSER_EXPECTED_FAIL[@]}"}"; then
        return 0
    fi
    return 1
}

check_prereqs() {
    local missing=0

    if [ ! -f "$INSTALL_DIR/bin/mariadbd" ]; then
        echo "ERROR: mariadbd not found. Run: bash packages/registry/mariadb/build-mariadb.sh" >&2
        missing=1
    fi

    if [ ! -f "$INSTALL_DIR/bin/mysqltest.wasm" ]; then
        echo "ERROR: mysqltest.wasm not found. Run: bash packages/registry/mariadb/build-mariadb.sh" >&2
        missing=1
    fi

    if [ ! -f "$KERNEL_WASM" ]; then
        echo "ERROR: kernel wasm not found. Run: bash build.sh" >&2
        missing=1
    fi

    if [ ! -f "$RUNNER" ]; then
        echo "ERROR: browser test runner not found at $RUNNER" >&2
        missing=1
    fi

    # Check Playwright
    if ! npx playwright --version >/dev/null 2>&1; then
        echo "ERROR: Playwright not installed. Run: npx playwright install chromium" >&2
        missing=1
    fi

    [ $missing -eq 0 ] || exit 1
}

# ── Main ──

TEST_ARGS=()
ALL_MODE=false

while [ $# -gt 0 ]; do
    case "$1" in
        --all)
            ALL_MODE=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS] [test1 test2 ...]"
            echo ""
            echo "Options:"
            echo "  --all    Run every mysql-test main/*.test file present in the MariaDB tree."
            echo ""
            echo "Without --all or test names, runs the curated set of ${#CURATED_TESTS[@]} tests."
            echo ""
            echo "Environment:"
            echo "  TEST_TIMEOUT    Per-test timeout in ms (default: 60000)"
            exit 0
            ;;
        *)  TEST_ARGS+=("$1"); shift ;;
    esac
done

check_prereqs

discover_all_tests() {
    local main_dir="$INSTALL_DIR/mysql-test/main"
    if [ ! -d "$main_dir" ]; then
        echo "ERROR: mysql-test main directory not found at $main_dir" >&2
        echo "Run: bash packages/registry/mariadb/build-mariadb.sh" >&2
        exit 1
    fi
    find "$main_dir" -maxdepth 1 -type f -name '*.test' \
        | sed 's#.*/##; s#\.test$##' \
        | sort
}

# Build test VFS image if missing. Full-suite mode forces a rebuild so
# the image contains every main/*.test file instead of only the curated set.
if [ ! -f "$VFS_IMAGE" ] || $ALL_MODE; then
    echo "Building test VFS image..."
    if $ALL_MODE; then
        bash "$REPO_ROOT/images/vfs/scripts/build-mariadb-test-vfs-image.sh" --all
    else
        bash "$REPO_ROOT/images/vfs/scripts/build-mariadb-test-vfs-image.sh"
    fi
fi

# Use all/curated tests if none specified
if [ ${#TEST_ARGS[@]} -eq 0 ]; then
    if $ALL_MODE; then
        while IFS= read -r test_name; do
            TEST_ARGS+=("$test_name")
        done < <(discover_all_tests)
    else
        TEST_ARGS=("${CURATED_TESTS[@]}")
    fi
fi

echo "===== MariaDB mysql-test (browser) ====="
if $ALL_MODE; then
    echo "Mode: all tests"
fi
echo "Tests: ${#TEST_ARGS[@]}"
echo ""

# Run the Playwright runner, capture JSON output
RESULTS_FILE=$(mktemp)
STDERR_FILE=$(mktemp)
trap 'rm -f "$RESULTS_FILE" "$STDERR_FILE"' EXIT

TIMEOUT="${TEST_TIMEOUT:-60000}"

RUNNER_RETRIES="${MARIADB_BROWSER_RUNNER_RETRIES:-3}"
RUNNER_EXIT=0
for ((attempt=1; attempt<=RUNNER_RETRIES; attempt++)); do
    : > "$RESULTS_FILE"
    : > "$STDERR_FILE"
    set +e
    npx tsx "$RUNNER" --json --timeout "$TIMEOUT" "${TEST_ARGS[@]}" > "$RESULTS_FILE" 2>"$STDERR_FILE"
    RUNNER_EXIT=$?
    set -e

    # Browser boots can intermittently fail before producing any JSON result
    # (usually while the page reaches TCP listen but setup SQL times out).
    # Retry the whole browser process for that case; once at least one result
    # exists, preserve it exactly so all test outcomes remain visible.
    if grep -q '^{' "$RESULTS_FILE" || [ "$attempt" -ge "$RUNNER_RETRIES" ]; then
        break
    fi
    echo "NOTE: MariaDB browser runner produced zero JSON results on attempt $attempt/$RUNNER_RETRIES; retrying" >&2
    tail -40 "$STDERR_FILE" >&2 || true
    sleep 1
done

# Show runner stderr
cat "$STDERR_FILE" >&2

# Parse JSON results
PASS=0
FAIL=0
XFAIL=0
XPASS=0
SKIP=0
TOTAL=0
RESULTS=()

while IFS= read -r line; do
    [ -z "$line" ] && continue
    [[ "$line" == "{"* ]] || continue

    parsed=$(echo "$line" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['test'])
    print(d['status'])
    print(d.get('time_ms', 0))
    import base64
    error = d.get('error') or ''
    stderr = d.get('stderr') or ''
    if error and stderr and error not in stderr:
        detail = f'{error}: {stderr}'
    else:
        detail = error or stderr
    print(base64.b64encode(detail.encode()).decode())
except: pass
" 2>/dev/null) || continue

    test_name=$(echo "$parsed" | sed -n '1p')
    status=$(echo "$parsed" | sed -n '2p')
    time_ms=$(echo "$parsed" | sed -n '3p')
    stderr_b64=$(echo "$parsed" | sed -n '4p')
    stderr_summary=""
    if [ -n "$stderr_b64" ]; then
        stderr_summary=$(printf '%s' "$stderr_b64" | python3 -c "
import sys, base64
try:
    text = base64.b64decode(sys.stdin.read()).decode('utf-8', 'replace')
    print(' '.join(text.split())[:240])
except Exception:
    pass
" 2>/dev/null || true)
    fi

    [ -z "$test_name" ] && continue
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
                if [ -n "$stderr_summary" ]; then
                    echo "FAIL  $test_name (${time_ms}ms) -- $stderr_summary"
                else
                    echo "FAIL  $test_name (${time_ms}ms)"
                fi
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

# Summary
echo ""
echo "===== Results ====="
echo "PASS:    $PASS"
echo "FAIL:    $FAIL"
echo "XFAIL:   $XFAIL"
echo "XPASS:   $XPASS"
echo "SKIP:    $SKIP"
echo "TOTAL:   $TOTAL"
echo ""

if [ "$RUNNER_EXIT" -ne 0 ]; then
    echo "NOTE: MariaDB browser harness raw runner exited with status $RUNNER_EXIT; classified results below determine wrapper status" >&2
fi
if [ "$TOTAL" -eq 0 ]; then
    echo "ERROR: MariaDB browser harness produced zero test results" >&2
fi

# Show unexpected results
for status_prefix in "FAIL " "XPASS"; do
    count=0
    for r in "${RESULTS[@]+"${RESULTS[@]}"}"; do
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

# Exit with error only if result collection failed or unexpected results remain.
# The browser runner exits non-zero whenever any raw mysqltest invocation fails,
# including failures intentionally classified here as XFAIL. Treat the wrapper's
# expected-failure classification as authoritative for shell status.
if [ "$TOTAL" -eq 0 ] || [ $FAIL -gt 0 ] || [ $XPASS -gt 0 ]; then
    exit 1
fi
