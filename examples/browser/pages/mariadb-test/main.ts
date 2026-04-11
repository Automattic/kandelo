/**
 * MariaDB mysql-test browser runner — boots MariaDB via SystemInit,
 * loads test bundle, and exposes window.__runMariadbTest() for Playwright.
 *
 * Process layout:
 *   pid 1: mariadbd --bootstrap (oneshot, terminated after stdin consumed)
 *   pid 2: mariadbd server (daemon, port 3306)
 *   pid 3+: mysqltest (transient, one per test)
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { SystemInit } from "../../lib/init/system-init";
import { populateMariadbDirs } from "../../lib/init/mariadb-config";
import {
  writeVfsBinary,
  writeVfsFile,
  writeInitDescriptor,
  ensureDir,
  ensureDirRecursive,
} from "../../lib/init/vfs-utils";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import mariadbWasmUrl from "../../../../examples/libs/mariadb/mariadb-install/bin/mariadbd.wasm?url";
import mysqlTestWasmUrl from "../../../../examples/libs/mariadb/mariadb-install/bin/mysqltest.wasm?url";
import systemTablesUrl from "../../../../examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables.sql?url";
import systemDataUrl from "../../../../examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables_data.sql?url";

interface TestResult {
  exitCode: number;
  durationMs: number;
  stderr: string;
}

declare global {
  interface Window {
    __mariadbTestReady: boolean;
    __runMariadbTest: (testName: string, timeoutMs?: number) => Promise<TestResult>;
  }
}

const statusEl = document.getElementById("status")!;
const logEl = document.getElementById("log")!;
const decoder = new TextDecoder();

function appendLog(text: string, cls?: string) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
}

let kernel: BrowserKernel | null = null;
let mysqlTestBytes: ArrayBuffer | null = null;
let testStderr = "";

// Setup SQL: create mtr database with add_suppression procedure, grant root access
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

async function loadTestBundle(): Promise<void> {
  if (!kernel) return;
  const fs = kernel.fs;

  try {
    const resp = await fetch("/mariadb-test-bundle.json");
    if (!resp.ok) {
      appendLog(`Warning: test bundle not found (${resp.status}), tests may fail\n`, "error");
      return;
    }
    const bundle = await resp.json() as { files: Array<{ path: string; data: string }> };

    for (const file of bundle.files) {
      // Ensure parent directory exists
      const lastSlash = file.path.lastIndexOf("/");
      if (lastSlash > 0) {
        ensureDirRecursive(fs, file.path.slice(0, lastSlash));
      }
      // Decode base64 to bytes
      const binary = atob(file.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      writeVfsBinary(fs, file.path, bytes);
    }
    appendLog(`Loaded ${bundle.files.length} test files from bundle\n`, "info");
  } catch (e) {
    appendLog(`Warning: failed to load test bundle: ${e}\n`, "error");
  }
}

/** Spawn mysqltest with given test SQL content. */
async function runMysqlTestCommand(
  testName: string,
  testFile: string,
  timeoutMs: number,
): Promise<TestResult> {
  if (!kernel || !mysqlTestBytes) {
    throw new Error("Kernel or mysqltest not initialized");
  }

  const start = performance.now();
  testStderr = "";

  const argv = [
    "mysqltest", "--no-defaults",
    "--host=127.0.0.1", "--port=3306",
    "--user=root", "--database=test",
    `--test-file=${testFile}`,
    "--basedir=/mysql-test",
    "--tmpdir=/tmp",
    "--silent",
    "--protocol=tcp",
  ];

  const env = [
    "HOME=/tmp", "PATH=/usr/bin", "TMPDIR=/tmp",
    "MYSQL_TEST_DIR=/mysql-test",
    "MYSQLTEST_VARDIR=/data",
    "MYSQL_TMP_DIR=/tmp",
  ];

  try {
    const exitCode = await Promise.race([
      kernel.spawn(mysqlTestBytes, argv, { env, cwd: "/mysql-test" }),
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs),
      ),
    ]);

    return {
      exitCode,
      durationMs: Math.round(performance.now() - start),
      stderr: testStderr.slice(-2000),
    };
  } catch (e: any) {
    return {
      exitCode: -1,
      durationMs: Math.round(performance.now() - start),
      stderr: e.message === "TIMEOUT" ? "TIMEOUT" : e.message,
    };
  }
}

async function init() {
  statusEl.textContent = "Loading resources...";

  // Fetch all resources in parallel
  const [kernelBytes, mariadbBytes, mysqlTestBytesResult, systemTablesSql, systemDataSql] =
    await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(mariadbWasmUrl).then((r) => r.arrayBuffer()),
      fetch(mysqlTestWasmUrl).then((r) => r.arrayBuffer()),
      fetch(systemTablesUrl).then((r) => r.text()),
      fetch(systemDataUrl).then((r) => r.text()),
    ]);

  mysqlTestBytes = mysqlTestBytesResult;

  appendLog(
    `Loaded: kernel ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
    `mariadbd ${(mariadbBytes.byteLength / (1024 * 1024)).toFixed(1)}MB, ` +
    `mysqltest ${(mysqlTestBytesResult.byteLength / (1024 * 1024)).toFixed(1)}MB\n`,
    "info",
  );

  // Create kernel
  kernel = new BrowserKernel({
    maxWorkers: 12,
    fsSize: 256 * 1024 * 1024,
    onStdout: (data) => {
      // Server stdout — mostly noise, ignore for tests
    },
    onStderr: (data) => {
      testStderr += decoder.decode(data);
    },
  });

  await kernel.init(kernelBytes);

  // Populate VFS
  statusEl.textContent = "Populating filesystem...";
  const fs = kernel.fs;

  ensureDirRecursive(fs, "/usr/sbin");
  writeVfsBinary(fs, "/usr/sbin/mariadbd", new Uint8Array(mariadbBytes));
  populateMariadbDirs(fs);

  // Write bootstrap SQL
  const bootstrapSql = `use mysql;\n${systemTablesSql}\n${systemDataSql}\nCREATE DATABASE IF NOT EXISTS test;\n`;
  ensureDirRecursive(fs, "/etc/mariadb");
  writeVfsFile(fs, "/etc/mariadb/bootstrap.sql", bootstrapSql);

  // Write setup and reset test files
  ensureDirRecursive(fs, "/mysql-test/main");
  writeVfsFile(fs, "/mysql-test/main/__setup.test", SETUP_SQL);
  writeVfsFile(fs, "/mysql-test/main/__reset.test", RESET_SQL);

  // Load test bundle
  await loadTestBundle();

  // Ensure /data dir for MYSQLTEST_VARDIR
  ensureDirRecursive(fs, "/data/tmp");

  // Write init descriptors (bootstrap + server only, no shell)
  writeInitDescriptor(fs, "05-mariadb-bootstrap", {
    type: "oneshot",
    command: "/usr/sbin/mariadbd --no-defaults --bootstrap --datadir=/data --tmpdir=/data/tmp --default-storage-engine=Aria --skip-grant-tables --key-buffer-size=1048576 --table-open-cache=10 --sort-buffer-size=262144 --skip-networking --log-warnings=0 --log-error=/data/bootstrap.log",
    stdin: "/etc/mariadb/bootstrap.sql",
    ready: "stdin-consumed",
    terminate: "true",
  });

  writeInitDescriptor(fs, "10-mariadb", {
    type: "daemon",
    command: "/usr/sbin/mariadbd --no-defaults --datadir=/data --tmpdir=/data/tmp --default-storage-engine=Aria --skip-grant-tables --key-buffer-size=1048576 --table-open-cache=10 --sort-buffer-size=262144 --skip-networking=0 --port=3306 --bind-address=0.0.0.0 --socket= --max-connections=10 --thread-handling=no-threads --wait-timeout=10 --net-read-timeout=10 --net-write-timeout=10 --lock-wait-timeout=10 --log-error=/data/error.log",
    depends: "mariadb-bootstrap",
    ready: "port:3306",
  });

  // Boot
  statusEl.textContent = "Booting MariaDB...";
  appendLog("Booting MariaDB...\n", "info");

  const initSystem = new SystemInit(kernel, {
    onLog: (msg, level) => appendLog(msg + "\n", level === "info" ? "info" : "error"),
    onServiceReady: async (name) => {
      if (name === "mariadb-bootstrap") {
        appendLog("Bootstrap complete.\n", "info");
      }
      if (name === "mariadb") {
        appendLog("Server ready on port 3306.\n", "info");

        // Run setup SQL
        statusEl.textContent = "Running setup SQL...";
        const setupResult = await runMysqlTestCommand("__setup", "/mysql-test/main/__setup.test", 30000);
        if (setupResult.exitCode !== 0) {
          appendLog(`Warning: setup SQL exited with code ${setupResult.exitCode}\n`, "error");
        } else {
          appendLog("Setup SQL complete.\n", "info");
        }

        // Expose test runner API
        window.__runMariadbTest = async (testName: string, timeoutMs = 60000): Promise<TestResult> => {
          // Reset test database
          const resetResult = await runMysqlTestCommand("__reset", "/mysql-test/main/__reset.test", 15000);
          if (resetResult.exitCode !== 0 && resetResult.stderr !== "TIMEOUT") {
            // Non-fatal — continue anyway
          }

          // Run actual test
          const testFile = `/mysql-test/main/${testName}.test`;
          return runMysqlTestCommand(testName, testFile, timeoutMs);
        };

        window.__mariadbTestReady = true;
        statusEl.textContent = "Ready — waiting for test commands";
        appendLog("Test runner ready.\n", "info");
      }
    },
  });

  await initSystem.boot();
}

init().catch((err) => {
  statusEl.textContent = `Error: ${err.message}`;
  appendLog(`Error: ${err.message}\n`, "error");
  console.error("MariaDB test runner init failed:", err);
});
