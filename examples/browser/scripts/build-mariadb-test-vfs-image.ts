/**
 * Build a pre-built VFS image containing MariaDB, mysql-test files, and
 * init descriptors for the browser test runner.
 *
 * Produces: examples/browser/public/mariadb-test.vfs
 *
 * Usage:
 *   npx tsx examples/browser/scripts/build-mariadb-test-vfs-image.ts          # curated tests
 *   npx tsx examples/browser/scripts/build-mariadb-test-vfs-image.ts --all    # ALL tests
 */
import { readFileSync, readdirSync, lstatSync, existsSync } from "fs";
import { join, resolve } from "path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  writeVfsFile,
  writeVfsBinary,
  ensureDir,
  ensureDirRecursive,
  walkAndWrite,
  saveImage,
} from "./vfs-image-helpers";

const MYSQL_TEST_DIR = "examples/libs/mariadb/mariadb-install/mysql-test";
const MARIADB_PATH = "examples/libs/mariadb/mariadb-install/bin/mariadbd.wasm";
const SYSTEM_TABLES_PATH = "examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables.sql";
const SYSTEM_DATA_PATH = "examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables_data.sql";
const OUT_FILE = "examples/browser/public/mariadb-test.vfs";

const includeAll = process.argv.includes("--all");

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

const SETUP_SQL = `\
CREATE DATABASE IF NOT EXISTS mtr;
USE mtr;
CREATE TABLE IF NOT EXISTS test_suppressions (pattern VARCHAR(255));
DROP PROCEDURE IF EXISTS add_suppression;
delimiter |;
CREATE DEFINER='root'@'localhost' PROCEDURE add_suppression(pattern VARCHAR(255))
BEGIN
  INSERT INTO test_suppressions (pattern) VALUES (pattern);
END|
delimiter ;|
REPLACE INTO mysql.global_priv VALUES ('localhost','root','{"access":18446744073709551615}');
REPLACE INTO mysql.global_priv VALUES ('127.0.0.1','root','{"access":18446744073709551615}');
REPLACE INTO mysql.global_priv VALUES ('%','root','{"access":18446744073709551615}');
FLUSH PRIVILEGES;
`;

const RESET_SQL = `DROP DATABASE IF EXISTS test;\nCREATE DATABASE test;\n`;

async function main() {
  // Validate prerequisites
  if (!existsSync(MARIADB_PATH)) {
    console.error("mariadbd.wasm not found. Run: bash examples/libs/mariadb/build-mariadb.sh");
    process.exit(1);
  }

  if (!existsSync(join(MYSQL_TEST_DIR, "main"))) {
    console.error("mysql-test directory not found. Run: bash examples/libs/mariadb/build-mariadb.sh");
    process.exit(1);
  }

  // 128MB SharedArrayBuffer for building the image
  const sab = new SharedArrayBuffer(128 * 1024 * 1024);
  const fs = MemoryFileSystem.create(sab);

  // MariaDB binary
  console.log("Writing mariadbd binary...");
  ensureDirRecursive(fs, "/usr/sbin");
  const mariadbBytes = readFileSync(MARIADB_PATH);
  writeVfsBinary(fs, "/usr/sbin/mariadbd", new Uint8Array(mariadbBytes));

  // Data directories
  for (const dir of ["/data", "/data/mysql", "/data/tmp", "/data/test"]) {
    ensureDirRecursive(fs, dir);
  }

  // Bootstrap SQL
  console.log("Writing bootstrap SQL...");
  const systemTablesSql = readFileSync(SYSTEM_TABLES_PATH, "utf-8");
  const systemDataSql = readFileSync(SYSTEM_DATA_PATH, "utf-8");
  const bootstrapSql = `use mysql;\n${systemTablesSql}\n${systemDataSql}\nCREATE DATABASE IF NOT EXISTS test;\n`;
  ensureDirRecursive(fs, "/etc/mariadb");
  writeVfsFile(fs, "/etc/mariadb/bootstrap.sql", bootstrapSql);

  // /tmp with 0o777
  ensureDir(fs, "/tmp");
  fs.chmod("/tmp", 0o777);

  // Test files
  ensureDirRecursive(fs, "/mysql-test/main");
  let testCount = 0;

  if (includeAll) {
    console.log("Writing ALL .test files from main/...");
    const mainDir = resolve(MYSQL_TEST_DIR, "main");
    for (const name of readdirSync(mainDir).sort()) {
      if (!name.endsWith(".test")) continue;
      const full = join(mainDir, name);
      try {
        const stat = lstatSync(full);
        if (!stat.isFile()) continue;
        const data = readFileSync(full);
        writeVfsBinary(fs, `/mysql-test/main/${name}`, new Uint8Array(data), 0o644);
        testCount++;
      } catch { /* skip */ }
    }
  } else {
    console.log("Writing curated test files...");
    for (const name of CURATED_TESTS) {
      const testFile = resolve(MYSQL_TEST_DIR, "main", `${name}.test`);
      if (existsSync(testFile)) {
        const data = readFileSync(testFile);
        writeVfsBinary(fs, `/mysql-test/main/${name}.test`, new Uint8Array(data), 0o644);
        testCount++;
      }
    }
  }
  console.log(`  ${testCount} test files`);

  // Setup and reset SQL test files
  writeVfsFile(fs, "/mysql-test/main/__setup.test", SETUP_SQL);
  writeVfsFile(fs, "/mysql-test/main/__reset.test", RESET_SQL);

  // Include directory
  const includeDir = resolve(MYSQL_TEST_DIR, "include");
  if (existsSync(includeDir)) {
    console.log("Writing include/ directory...");
    const includeCount = walkAndWrite(fs, includeDir, "/mysql-test/include");
    console.log(`  ${includeCount} include files`);
  }

  // std_data directory
  const stdDataDir = resolve(MYSQL_TEST_DIR, "std_data");
  if (existsSync(stdDataDir)) {
    console.log("Writing std_data/ directory...");
    const stdDataCount = walkAndWrite(fs, stdDataDir, "/mysql-test/std_data");
    console.log(`  ${stdDataCount} std_data files`);
  }

  // Init descriptors
  console.log("Writing init descriptors...");
  ensureDirRecursive(fs, "/etc/init.d");

  writeVfsFile(fs, "/etc/init.d/05-mariadb-bootstrap", [
    "type=oneshot",
    "command=/usr/sbin/mariadbd --no-defaults --bootstrap --datadir=/data --tmpdir=/data/tmp --default-storage-engine=Aria --skip-grant-tables --key-buffer-size=1048576 --table-open-cache=10 --sort-buffer-size=262144 --skip-networking --log-warnings=0 --log-error=/data/bootstrap.log",
    "stdin=/etc/mariadb/bootstrap.sql",
    "ready=stdin-consumed",
    "terminate=true",
    "",
  ].join("\n"));

  writeVfsFile(fs, "/etc/init.d/10-mariadb", [
    "type=daemon",
    "command=/usr/sbin/mariadbd --no-defaults --datadir=/data --tmpdir=/data/tmp --default-storage-engine=Aria --skip-grant-tables --key-buffer-size=1048576 --table-open-cache=10 --sort-buffer-size=262144 --skip-networking=0 --port=3306 --bind-address=0.0.0.0 --socket= --max-connections=10 --thread-handling=no-threads --wait-timeout=10 --net-read-timeout=10 --net-write-timeout=10 --lock-wait-timeout=10 --log-error=/data/error.log",
    "depends=mariadb-bootstrap",
    "ready=port:3306",
    "",
  ].join("\n"));

  // Save image
  await saveImage(fs, OUT_FILE);
  console.log(`${testCount} test files total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
