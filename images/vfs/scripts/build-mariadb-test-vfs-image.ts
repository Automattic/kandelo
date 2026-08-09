/**
 * Build a fully-bootable VFS image for the MariaDB mysql-test browser
 * runner. dinit, the first user process, brings up the test-server tree:
 *
 *   mariadb-bootstrap (scripted, oneshot) → mariadb (process)
 *
 * Once port 3306 is listening the page runs setup SQL and exposes
 * window.__runMariadbTest() for Playwright. Each test invocation
 * spawns mysqltest via kernel.spawn() (transient binary, no service).
 *
 * Produces: $MARIADB_TEST_VFS_OUT (default:
 * apps/browser-demos/public/mariadb-test.vfs.zst).
 *
 * Usage:
 *   npx tsx images/vfs/scripts/build-mariadb-test-vfs-image.ts          # curated tests
 *   npx tsx images/vfs/scripts/build-mariadb-test-vfs-image.ts --all    # ALL tests
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  writeVfsFile,
  writeVfsBinary,
  symlink,
} from "../../../host/src/vfs/image-helpers";
import {
  resolveBinary,
  findRepoRoot,
  tryResolveBinary,
} from "../../../host/src/binary-resolver";
import {
  exactVfsImageMetadata,
  saveImage,
  type ExactVfsImageAbi,
} from "./vfs-image-helpers";
import {
  addDinitInit,
  type DinitBinaryInputs,
  type DinitService,
} from "./dinit-image-helpers";
import { prepareMariadbWritableDirectories } from "./mariadb-image-helpers";
import { copyMariaDbTestSources } from "./mariadb-test-source-copy";
import { ensureSourceExtract } from "./source-extract-helper";

const REPO_ROOT = findRepoRoot();
const COREUTILS_SYMLINK_NAMES = [
  "ls", "cat", "cp", "mv", "rm", "echo", "mkdir", "rmdir", "touch", "pwd",
  "head", "tail", "wc", "sort", "uniq", "cut", "tr", "date", "basename",
  "dirname", "chmod", "chown", "ln", "readlink", "true", "false", "yes",
  "sleep", "env", "printenv", "id", "whoami", "hostname", "uname", "stat",
  "df", "du", "tee", "nl", "paste", "tac", "rev", "expand", "unexpand",
  "fold", "fmt", "pr", "od", "hexdump", "xxd", "sha256sum", "sha512sum",
  "md5sum", "seq", "test", "[",
];

// 184 tests verified to pass in headless Chromium with MariaDB on kandelo.
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
  "signal_sqlmode", "single_delete_update",
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
    "--max-connections=10",
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
      // drain the SQL, then kills and waits for it. The shell is the direct
      // parent and must reap it; PID 1 is a synthetic kernel record with no
      // worker, and dinit runs as the first ordinary user process.
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

export interface MariadbTestVfsInputs {
  mariadbd: Uint8Array;
  dash: Uint8Array;
  coreutils: Uint8Array;
  dinit: DinitBinaryInputs;
  services: Uint8Array;
  systemTablesDirectory: string;
  testSuiteDirectory: string;
  includeAll: boolean;
  outputPath: string;
  targetAbi?: ExactVfsImageAbi;
}

export async function buildMariadbTestVfsImage(
  inputs: MariadbTestVfsInputs,
): Promise<void> {
  const systemTablesPath = join(
    inputs.systemTablesDirectory,
    "mysql_system_tables.sql",
  );
  const systemDataPath = join(
    inputs.systemTablesDirectory,
    "mysql_system_tables_data.sql",
  );
  if (!existsSync(join(inputs.testSuiteDirectory, "main"))) {
    throw new Error("MariaDB staged test-suite input omits main/");
  }
  if (!existsSync(systemTablesPath) || !existsSync(systemDataPath)) {
    throw new Error("MariaDB staged system-tables input is incomplete");
  }
  for (const [label, bytes] of [
    ["mariadbd", inputs.mariadbd],
    ["dash", inputs.dash],
    ["coreutils", inputs.coreutils],
    ["services", inputs.services],
  ] as const) {
    if (bytes.byteLength === 0) throw new Error(`MariaDB staged ${label} is empty`);
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
  prepareMariadbWritableDirectories(fs);

  // dash + coreutils for the bootstrap wrapper script (sh, sleep, kill).
  writeVfsBinary(fs, "/bin/dash", inputs.dash);
  symlink(fs, "/bin/dash", "/bin/sh");
  symlink(fs, "/bin/dash", "/usr/bin/dash");
  symlink(fs, "/bin/dash", "/usr/bin/sh");
  writeVfsBinary(fs, "/bin/coreutils", inputs.coreutils);
  for (const name of COREUTILS_SYMLINK_NAMES) {
    symlink(fs, "/bin/coreutils", `/bin/${name}`);
    symlink(fs, "/bin/coreutils", `/usr/bin/${name}`);
  }

  console.log("  Writing mariadbd binary...");
  writeVfsBinary(fs, "/usr/sbin/mariadbd", inputs.mariadbd);

  console.log("  Writing bootstrap SQL...");
  ensureDirRecursive(fs, "/etc/mariadb");
  const systemTables = readFileSync(systemTablesPath, "utf-8");
  const systemData = readFileSync(systemDataPath, "utf-8");
  const bootstrapSql = `use mysql;\n${systemTables}\n${systemData}\nCREATE DATABASE IF NOT EXISTS test;\n`;
  writeVfsFile(fs, "/etc/mariadb/bootstrap.sql", bootstrapSql);

  // bootstrap-runner: backgrounds mariadbd --bootstrap, sleeps to let it
  // drain SQL, then terminates and reaps the direct child before returning.
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
wait $PID 2>/dev/null || true
exit 0
`);

  console.log(
    inputs.includeAll
      ? "  Writing ALL .test files and required fixtures..."
      : "  Writing curated .test files and required fixtures...",
  );
  const testCount = copyMariaDbTestSources(fs, inputs.testSuiteDirectory, {
    includeAll: inputs.includeAll,
    curatedTests: CURATED_TESTS,
  });
  console.log(`    ${testCount} test files`);

  // Setup and reset SQL test files (run by the page after server-ready)
  writeVfsFile(fs, "/mysql-test/main/__setup.test", SETUP_SQL);
  writeVfsFile(fs, "/mysql-test/main/__reset.test", RESET_SQL);

  // dinit service tree (no auto-boot — page passes target service as argv).
  // We use the default boot:true here because the page only ever wants
  // the mariadb tree up; no engine selection like the mariadb demo.
  addDinitInit(fs, buildServices(), {
    binaries: inputs.dinit,
    services: inputs.services,
  });

  await saveImage(fs, inputs.outputPath, inputs.targetAbi === undefined
    ? {}
    : {
        kernelAbi: inputs.targetAbi.version,
        metadata: exactVfsImageMetadata(
          inputs.targetAbi,
          "images/vfs/scripts/build-mariadb-test-vfs-image.ts",
        ),
      });
  console.log(`==> Wrote ${inputs.outputPath} (${testCount} test files)`);
}

async function main(): Promise<void> {
  const legacyInstall = join(REPO_ROOT, "packages/registry/mariadb/mariadb-install");
  const source = ensureSourceExtract("mariadb", REPO_ROOT);
  const systemTablesDirectory = existsSync(
    join(legacyInstall, "share/mysql/mysql_system_tables.sql"),
  ) ? join(legacyInstall, "share/mysql") : join(source, "scripts");
  const testSuiteDirectory = existsSync(join(legacyInstall, "mysql-test"))
    ? join(legacyInstall, "mysql-test")
    : join(source, "mysql-test");
  const dinitPath = tryResolveBinary("programs/dinit/dinit.wasm") ??
    join(REPO_ROOT, "packages/registry/dinit/bin/dinit.wasm");
  const dinitctlPath = tryResolveBinary("programs/dinit/dinitctl.wasm") ??
    join(REPO_ROOT, "packages/registry/dinit/bin/dinitctl.wasm");
  await buildMariadbTestVfsImage({
    mariadbd: new Uint8Array(readFileSync(resolveBinary("programs/mariadb/mariadbd.wasm"))),
    dash: new Uint8Array(readFileSync(resolveBinary("programs/dash.wasm"))),
    coreutils: new Uint8Array(readFileSync(resolveBinary("programs/coreutils.wasm"))),
    dinit: {
      dinit: new Uint8Array(readFileSync(dinitPath)),
      dinitctl: new Uint8Array(readFileSync(dinitctlPath)),
    },
    services: new Uint8Array(readFileSync(join(REPO_ROOT, "images/rootfs/etc/services"))),
    systemTablesDirectory,
    testSuiteDirectory,
    includeAll: process.argv.includes("--all"),
    outputPath: process.env.MARIADB_TEST_VFS_OUT ??
      join(REPO_ROOT, "apps/browser-demos/public/mariadb-test.vfs.zst"),
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
