/**
 * Build a fully-bootable VFS image for the MariaDB mysql-test browser
 * runner. dinit (PID 1) brings up the test-server tree:
 *
 *   mariadb-bootstrap (scripted, oneshot) → mariadb (process)
 *
 * Once port 3306 is listening the page runs setup SQL and exposes
 * window.__runMariadbTest() for Playwright. Each test invocation
 * spawns mysqltest via kernel.spawn() (transient binary, no service).
 *
 * Produces: $MARIADB_TEST_VFS_OUT (default:
 * examples/browser/public/mariadb-test.vfs).
 *
 * Usage:
 *   npx tsx examples/browser/scripts/build-mariadb-test-vfs-image.ts          # curated tests
 *   npx tsx examples/browser/scripts/build-mariadb-test-vfs-image.ts --all    # ALL tests
 */
import { readFileSync, readdirSync, lstatSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  writeVfsFile,
  writeVfsBinary,
  symlink,
} from "../../../host/src/vfs/image-helpers";
import { resolveBinary, tryResolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import { saveImage, walkAndWrite } from "./vfs-image-helpers";
import { addDinitInit, type DinitService } from "./dinit-image-helpers";

const REPO_ROOT = findRepoRoot();
const MYSQL_TEST_DIR = join(REPO_ROOT, "examples/libs/mariadb/mariadb-install/mysql-test");
const MARIADB_PATH = resolveBinary("programs/mariadb/mariadbd.wasm");
const SYSTEM_TABLES_PATH = join(REPO_ROOT, "examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables.sql");
const SYSTEM_DATA_PATH = join(REPO_ROOT, "examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables_data.sql");
const DASH_PATH = resolveBinary("programs/dash.wasm");
const COREUTILS_PATH = tryResolveBinary("programs/coreutils.wasm");

const OUT_FILE = process.env.MARIADB_TEST_VFS_OUT
  ?? join(REPO_ROOT, "examples/browser/public/mariadb-test.vfs");

const includeAll = process.argv.includes("--all");

const COREUTILS_SYMLINK_NAMES = [
  "ls", "cat", "cp", "mv", "rm", "echo", "mkdir", "rmdir", "touch", "pwd",
  "head", "tail", "wc", "sort", "uniq", "cut", "tr", "date", "basename",
  "dirname", "chmod", "chown", "ln", "readlink", "true", "false", "yes",
  "sleep", "env", "printenv", "id", "whoami", "hostname", "uname", "stat",
  "df", "du", "tee", "nl", "paste", "tac", "rev", "expand", "unexpand",
  "fold", "fmt", "pr", "od", "hexdump", "xxd", "sha256sum", "sha512sum",
  "md5sum", "seq", "test", "[",
];

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

function commonMariadbArgs(): string[] {
  return [
    "/usr/sbin/mariadbd", "--no-defaults",
    // mariadbd refuses to run as root by default; the bootstrap SQL
    // populates mysql.user / global_priv so root@127.0.0.1 has full
    // access. The daemon itself runs as the mysql user (uid 101).
    "--user=mysql",
    "--datadir=/data", "--tmpdir=/data/tmp",
    "--default-storage-engine=Aria",
    "--skip-grant-tables",
    "--key-buffer-size=1048576", "--table-open-cache=10",
    "--sort-buffer-size=262144",
  ];
}

function buildServices(): DinitService[] {
  const args = commonMariadbArgs();
  const daemonCmd = [
    ...args,
    "--skip-networking=0", "--port=3306",
    "--bind-address=0.0.0.0", "--socket=",
    "--max-connections=10", "--thread-handling=no-threads",
    "--wait-timeout=10", "--net-read-timeout=10",
    "--net-write-timeout=10", "--lock-wait-timeout=10",
    "--log-error=/data/error.log",
  ].join(" ");

  return [
    {
      name: "mariadb-bootstrap",
      type: "scripted",
      // mariadbd --bootstrap doesn't exit at stdin EOF in the wasm port.
      // The wrapper backgrounds it, sleeps long enough for bootstrap to
      // drain the SQL, then kills it. **No `wait`** — dinit (PID 1)
      // reaps orphans aggressively and dash's `wait` builtin then blocks
      // indefinitely. Letting dinit reap is fine.
      command: "/bin/sh /etc/mariadb/bootstrap.sh",
      logfile: "/var/log/mariadb-bootstrap.log",
      restart: false,
    },
    {
      name: "mariadb",
      type: "process",
      command: daemonCmd,
      dependsOn: ["mariadb-bootstrap"],
      logfile: "/var/log/mariadb.log",
      restart: false,
    },
  ];
}

async function main() {
  if (!existsSync(MARIADB_PATH)) {
    console.error("mariadbd.wasm not found. Run: bash examples/libs/mariadb/build-mariadb.sh");
    process.exit(1);
  }
  if (!existsSync(join(MYSQL_TEST_DIR, "main"))) {
    console.error("mysql-test directory not found. Run: bash examples/libs/mariadb/build-mariadb.sh");
    process.exit(1);
  }
  if (!existsSync(SYSTEM_TABLES_PATH) || !existsSync(SYSTEM_DATA_PATH)) {
    console.error(`MariaDB bootstrap SQL files missing under examples/libs/mariadb/mariadb-install/share/mysql/`);
    process.exit(1);
  }

  console.log("==> Building MariaDB test-runner VFS image");

  const sab = new SharedArrayBuffer(64 * 1024 * 1024, { maxByteLength: 256 * 1024 * 1024 });
  const fs = MemoryFileSystem.create(sab, 256 * 1024 * 1024);

  for (const dir of [
    "/tmp", "/home", "/dev", "/etc", "/bin", "/usr", "/usr/bin",
    "/usr/local", "/usr/local/bin", "/usr/share", "/root", "/usr/sbin",
    "/data", "/data/mysql", "/data/tmp", "/data/test",
  ]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o777);

  // dash + coreutils for the bootstrap wrapper script (sh, sleep, kill).
  if (existsSync(DASH_PATH)) {
    writeVfsBinary(fs, "/bin/dash", new Uint8Array(readFileSync(DASH_PATH)));
    symlink(fs, "/bin/dash", "/bin/sh");
    symlink(fs, "/bin/dash", "/usr/bin/dash");
    symlink(fs, "/bin/dash", "/usr/bin/sh");
  }
  if (COREUTILS_PATH && existsSync(COREUTILS_PATH)) {
    writeVfsBinary(fs, "/bin/coreutils", new Uint8Array(readFileSync(COREUTILS_PATH)));
  } else {
    console.warn("  Warning: coreutils.wasm not found — bootstrap wrapper will fail at sleep");
  }
  for (const name of COREUTILS_SYMLINK_NAMES) {
    symlink(fs, "/bin/coreutils", `/bin/${name}`);
    symlink(fs, "/bin/coreutils", `/usr/bin/${name}`);
  }

  console.log("  Writing mariadbd binary...");
  writeVfsBinary(fs, "/usr/sbin/mariadbd", new Uint8Array(readFileSync(MARIADB_PATH)));

  console.log("  Writing bootstrap SQL...");
  ensureDirRecursive(fs, "/etc/mariadb");
  const systemTables = readFileSync(SYSTEM_TABLES_PATH, "utf-8");
  const systemData = readFileSync(SYSTEM_DATA_PATH, "utf-8");
  const bootstrapSql = `use mysql;\n${systemTables}\n${systemData}\nCREATE DATABASE IF NOT EXISTS test;\n`;
  writeVfsFile(fs, "/etc/mariadb/bootstrap.sql", bootstrapSql);

  // bootstrap-runner: backgrounds mariadbd --bootstrap, sleeps to let
  // it drain SQL, then SIGTERMs it. See per-engine notes in
  // build-mariadb-vfs-image.ts for why `wait` is unsafe here.
  const bootstrapArgs = [
    ...commonMariadbArgs(),
    "--bootstrap", "--skip-networking", "--log-warnings=0",
    "--log-error=/data/bootstrap.log",
  ].join(" ");
  writeVfsFile(fs, "/etc/mariadb/bootstrap.sh", `${bootstrapArgs} < /etc/mariadb/bootstrap.sql &
PID=$!
sleep 30
kill -TERM $PID 2>/dev/null
sleep 1
kill -KILL $PID 2>/dev/null
exit 0
`);

  // Test files
  ensureDirRecursive(fs, "/mysql-test/main");
  let testCount = 0;

  if (includeAll) {
    console.log("  Writing ALL .test files from main/...");
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
    console.log("  Writing curated test files...");
    for (const name of CURATED_TESTS) {
      const testFile = resolve(MYSQL_TEST_DIR, "main", `${name}.test`);
      if (existsSync(testFile)) {
        const data = readFileSync(testFile);
        writeVfsBinary(fs, `/mysql-test/main/${name}.test`, new Uint8Array(data), 0o644);
        testCount++;
      }
    }
  }
  console.log(`    ${testCount} test files`);

  // Setup and reset SQL test files (run by the page after server-ready)
  writeVfsFile(fs, "/mysql-test/main/__setup.test", SETUP_SQL);
  writeVfsFile(fs, "/mysql-test/main/__reset.test", RESET_SQL);

  // Include + std_data directories
  const includeDir = resolve(MYSQL_TEST_DIR, "include");
  if (existsSync(includeDir)) {
    console.log("  Writing include/ directory...");
    walkAndWrite(fs, includeDir, "/mysql-test/include");
  }
  const stdDataDir = resolve(MYSQL_TEST_DIR, "std_data");
  if (existsSync(stdDataDir)) {
    console.log("  Writing std_data/ directory...");
    walkAndWrite(fs, stdDataDir, "/mysql-test/std_data");
  }

  // dinit service tree (no auto-boot — page passes target service as argv).
  // We use the default boot:true here because the page only ever wants
  // the mariadb tree up; no engine selection like the mariadb demo.
  addDinitInit(fs, buildServices());

  await saveImage(fs, OUT_FILE);
  console.log(`==> Wrote ${OUT_FILE} (${testCount} test files)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
