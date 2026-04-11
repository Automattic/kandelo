#!/usr/bin/env bash
#
# Build a MariaDB mysql-test bundle (JSON) for the browser test runner.
#
# Usage:
#   scripts/build-mariadb-test-bundle.sh          # curated tests only
#   scripts/build-mariadb-test-bundle.sh --all     # ALL tests (for triage)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MYSQL_TEST_DIR="$REPO_ROOT/examples/libs/mariadb/mariadb-install/mysql-test"
BUNDLE_DIR="$REPO_ROOT/examples/browser/public"
BUNDLE_FILE="$BUNDLE_DIR/mariadb-test-bundle.json"

BUNDLE_ALL=0
if [ "${1:-}" = "--all" ]; then
    BUNDLE_ALL=1
fi

if [ ! -d "$MYSQL_TEST_DIR/main" ]; then
    echo "ERROR: mysql-test directory not found. Run: bash examples/libs/mariadb/build-mariadb.sh" >&2
    exit 1
fi

mkdir -p "$BUNDLE_DIR"

if [ "$BUNDLE_ALL" -eq 1 ]; then
    echo "==> Building MariaDB test bundle (all tests)..."
else
    echo "==> Building MariaDB test bundle (curated)..."
fi

node --experimental-strip-types - "$MYSQL_TEST_DIR" "$BUNDLE_FILE" "$BUNDLE_ALL" << 'BUNDLER'
import { readFileSync, existsSync, readdirSync, lstatSync } from "fs";
import { resolve, relative, join } from "path";
import { createWriteStream } from "fs";

const mysqlTestDir = process.argv[2];
const outFile = process.argv[3];
const bundleAll = process.argv[4] === "1";

interface BundleEntry {
    path: string;
    data: string;
}

const files: BundleEntry[] = [];

if (bundleAll) {
    // Bundle ALL .test files from main/
    const mainDir = resolve(mysqlTestDir, "main");
    for (const name of readdirSync(mainDir).sort()) {
        if (!name.endsWith(".test")) continue;
        const full = join(mainDir, name);
        try {
            const lstat = lstatSync(full);
            if (!lstat.isFile()) continue;
            files.push({
                path: `/mysql-test/main/${name}`,
                data: readFileSync(full).toString("base64"),
            });
        } catch { /* skip */ }
    }
} else {
    // 185 tests verified to pass in headless Chromium with MariaDB on wasm-posix-kernel.
    const CURATED_TESTS = [
        "1st", "adddate_454", "almost_full", "alter_table_combinations",
        "alter_table_lock", "alter_table_mdev539_maria",
        "alter_table_mdev539_myisam", "analyze", "ansi", "assign_key_cache",
        "auto_increment", "bad_frm_crash_5029", "bench_count_distinct",
        "binary", "bool", "bulk_replace", "change_user", "check_constraint",
        "check_constraint_show", "column_compression_utf16",
        "comment_column", "comment_column2", "comment_database",
        "comment_index", "comment_table", "comments", "constraints",
        "contributors", "create-uca", "create_drop_db", "create_drop_event",
        "create_drop_index", "create_drop_procedure", "create_drop_server",
        "create_drop_trigger", "create_not_windows", "create_replace_tmp",
        "create_w_max_indexes_64", "ctype_cp1250_ch",
        "ctype_cp850", "ctype_cp866", "ctype_dec8", "ctype_filesystem",
        "ctype_hebrew", "ctype_mb", "ctype_partitions", "ctype_uca_partitions",
        "ctype_ucs2_query_cache", "ctype_utf16_def", "ctype_utf32_def",
        "ctype_utf32_innodb", "ctype_utf8_def_upgrade",
        "ctype_utf8mb4_unicode_ci_def", "datetime_456", "delayed_blob",
        "deprecated_features", "fulltext2", "fulltext3", "fulltext_update",
        "fulltext_var", "func_bit", "func_digest", "func_encrypt",
        "func_encrypt_nossl", "func_encrypt_ucs2", "func_equal", "func_int",
        "func_op", "func_sapdb", "func_test", "func_timestamp", "gcc296",
        "gis-alter_table_online", "gis-json", "gis-rt-precise",
        "greedy_optimizer", "handler_read_last", "help",
        "implicit_char_to_num_conversion", "in_datetime_241",
        "index_intersect", "information_schema2",
        "information_schema_chmod", "information_schema_parameters",
        "information_schema_part", "information_schema_prepare",
        "information_schema_routines", "information_schema_stats",
        "innodb_ignore_builtin", "insert_returning_datatypes",
        "insert_update_autoinc-7150", "join_crash", "key_primary",
        "last_value", "log_slow_filter", "log_state_bug33693", "long_tmpdir",
        "long_unique_bugs_no_sp_protocol", "long_unique_delayed",
        "lowercase_table5", "lowercase_table_grant", "lowercase_utf8",
        "mdev_14586", "mdev19198", "mdev316", "mix2_myisam_ucs2",
        "multi_statement", "myisam-system", "myisam_enable_keys-10506",
        "myisam_mrr", "mysql5613mysql", "mysql57_virtual", "mysqltest_256",
        "negation_elimination", "no-threads", "no_binlog", "null_key", "odbc",
        "opt_trace_default", "opt_trace_index_merge", "opt_trace_ucs2",
        "order_by_sortkey", "order_by_zerolength-4285",
        "order_fill_sortbuf", "partition_bug18198",
        "partition_cache_myisam", "partition_charset", "partition_default",
        "partition_error", "partition_list", "ps_10nestset", "ps_1general",
        "selectivity_notembedded", "set_statement",
        "set_statement_notembedded", "show_create_user",
        "show_function_with_pad_char_to_full_length",
        "show_row_order-9226", "signal_demo1", "signal_demo2", "signal_demo3",
        "signal_sqlmode", "simple_select", "single_delete_update",
        "skip_log_bin", "sp-bugs2", "sp-condition-handler", "sp-destruct",
        "sp-memory-leak", "sp-no-code", "sp-no-valgrind", "sp-ucs2", "sp-vars",
        "sp_gis", "sp_missing_4665", "sql_mode_pad_char_to_full_length",
        "stat_tables_missing", "statement-expr", "str_to_datetime_457",
        "strict_autoinc_1myisam", "strict_autoinc_3heap", "subselect_gis",
        "subselect_sj_aria", "sysdate_is_now", "table_elim_debug",
        "table_options", "tablelock", "tablespace", "temp_table_frm",
        "temporal_literal", "timezone4", "trigger_no_defaults-11698",
        "type_char", "type_date_round", "type_datetime_round",
        "type_hex_hybrid", "type_interval", "type_nchar", "type_num",
        "type_row", "type_set", "type_temporal_mariadb53",
        "type_temporal_mysql56", "type_time_round", "varbinary",
    ];

    for (const name of CURATED_TESTS) {
        const testFile = resolve(mysqlTestDir, "main", `${name}.test`);
        if (existsSync(testFile)) {
            files.push({
                path: `/mysql-test/main/${name}.test`,
                data: readFileSync(testFile).toString("base64"),
            });
        }
    }
}

// Bundle entire include/ directory (needed by ~20 curated tests)
function collectDir(rootDir: string, mountPrefix: string) {
    function walk(dir: string) {
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            try {
                const lstat = lstatSync(full);
                if (lstat.isSymbolicLink()) continue;
                if (lstat.isDirectory()) {
                    walk(full);
                } else if (lstat.isFile()) {
                    const rel = relative(rootDir, full);
                    files.push({
                        path: `${mountPrefix}/${rel}`,
                        data: readFileSync(full).toString("base64"),
                    });
                }
            } catch { /* skip unreadable */ }
        }
    }
    walk(rootDir);
}

const includeDir = resolve(mysqlTestDir, "include");
if (existsSync(includeDir)) {
    collectDir(includeDir, "/mysql-test/include");
}

// Bundle std_data/ (needed by curated tests like bad_frm_crash_5029, type_temporal_*)
const stdDataDir = resolve(mysqlTestDir, "std_data");
if (existsSync(stdDataDir)) {
    collectDir(stdDataDir, "/mysql-test/std_data");
}

// Stream JSON to file
const stream = createWriteStream(outFile);
let totalBytes = 0;

function write(s: string) {
    stream.write(s);
    totalBytes += Buffer.byteLength(s);
}

write('{"files":[');
for (let i = 0; i < files.length; i++) {
    if (i > 0) write(",");
    write(JSON.stringify(files[i]));
}
write("]}");
stream.end();

await new Promise<void>((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
});

const sizeMB = (totalBytes / (1024 * 1024)).toFixed(1);
console.log(`Bundle: ${files.length} files, ${sizeMB} MB`);
BUNDLER

echo "==> Bundle written to $BUNDLE_FILE"
ls -lh "$BUNDLE_FILE"
