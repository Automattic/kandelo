/**
 * MariaDB mysql-test browser runner — boots a service-demo VFS image
 * with dinit (PID 1) bringing up:
 *
 *   mariadb-bootstrap (scripted, oneshot) → mariadb (process)
 *
 * Once port 3306 is listening, the page runs setup SQL via mysqltest
 * and exposes window.__runMariadbTest() for Playwright. Each test
 * invocation is a transient kernel.spawn() of mysqltest.wasm — those
 * processes are not part of the dinit service tree.
 *
 * Process layout once boot completes:
 *   pid 1: dinit (--container)
 *   pid 100+: mariadb-bootstrap (exits cleanly after SQL drained)
 *   pid 100+: mariadb (daemon, port 3306)
 *   pid 100+: mysqltest (transient, one per __runMariadbTest call)
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import kernelWasmUrl from "@kernel-wasm?url";
import mysqlTestWasmUrl from "@binaries/programs/wasm32/mariadb/mysqltest.wasm?url";

const MYSQL_PORT = 3306;

interface TestResult {
  exitCode: number;
  durationMs: number;
  stderr: string;
}

declare global {
  interface Window {
    __mariadbTestReady: boolean;
    __runMariadbTest: (testName: string, timeoutMs?: number) => Promise<TestResult>;
    __probeMariadb: (timeoutMs?: number) => Promise<boolean>;
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

async function ensureMysqlTestDirs(): Promise<void> {
  if (!kernel) return;
  try {
    const { exit } = await kernel.spawnFromVfs(
      "/bin/mkdir",
      ["mkdir", "-p", "/data/tmp", "/tmp", "/log", "/run"],
      { env: ["PATH=/bin:/usr/bin"], cwd: "/" },
    );
    await exit;
    const chmod = await kernel.spawnFromVfs(
      "/bin/chmod",
      ["chmod", "777", "/data/tmp", "/tmp"],
      { env: ["PATH=/bin:/usr/bin"], cwd: "/" },
    );
    await chmod.exit;
  } catch {
    // The actual mysqltest invocation will report a concrete path error if
    // the VFS helper is unavailable. Keep this best-effort so harness startup
    // failures still surface through the normal test result path.
  }
}

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
  await ensureMysqlTestDirs();

  const argv = [
    "mysqltest", "--no-defaults",
    "--host=127.0.0.1", "--port=3306",
    "--user=root", "--database=test",
    `--test-file=${testFile}`,
    "--basedir=/mysql-test",
    "--tmpdir=/data/tmp",
    "--silent",
    "--protocol=tcp",
  ];

  const env = [
    "HOME=/tmp", "PATH=/usr/bin", "TMPDIR=/data/tmp",
    "MYSQL_TEST_DIR=/mysql-test",
    // The upstream MTR tests require MYSQLD_DATADIR to be inside
    // MYSQLTEST_VARDIR, and many hard-code $MYSQLTEST_VARDIR/tmp. The server
    // itself still uses /tmp for internal temp tables; before each mysqltest
    // spawn we recreate /data/tmp because tests may create/drop a database
    // named `tmp`, which maps to the same datadir path.
    "MYSQLTEST_VARDIR=/data",
    "MYSQL_TMP_DIR=/data/tmp",
    "MYSQLD_DATADIR=/data/master-data",
    "MYSQL_BINDIR=/usr/bin",
    "MYSQL_SHAREDIR=/usr/share/mysql",
    "MYSQL_LIBDIR=/usr/lib",
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

  const [kernelBytes, vfsImageBuf, mysqlTestBytesResult] = await Promise.all([
    fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
    fetch("/mariadb-test.vfs.zst").then((r) => {
      if (!r.ok) {
        throw new Error(
          `mariadb-test.vfs.zst not found (${r.status}). ` +
          `Run: bash images/vfs/scripts/build-mariadb-test-vfs-image.sh`,
        );
      }
      return r.arrayBuffer();
    }),
    fetch(mysqlTestWasmUrl).then((r) => r.arrayBuffer()),
  ]);

  mysqlTestBytes = mysqlTestBytesResult;
  const vfsImage = new Uint8Array(vfsImageBuf);

  appendLog(
    `Loaded: kernel ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
    `VFS image ${(vfsImage.byteLength / (1024 * 1024)).toFixed(1)}MB, ` +
    `mysqltest ${(mysqlTestBytesResult.byteLength / (1024 * 1024)).toFixed(1)}MB\n`,
    "info",
  );

  statusEl.textContent = "Booting MariaDB via dinit...";
  appendLog("Booting MariaDB via dinit...\n", "info");

  let portReadyResolve: (() => void) | null = null;
  const portReady = new Promise<void>((resolve) => { portReadyResolve = resolve; });

  kernel = new BrowserKernel({
    kernelOwnedFs: true,
    maxWorkers: 12,
    onStdout: (_data) => {
      // Server stdout — mostly noise, ignore for tests.
    },
    onStderr: (data) => {
      testStderr += decoder.decode(data);
    },
    onListenTcp: (_pid, _fd, port) => {
      appendLog(`service listening on :${port}\n`, "info");
      if (port === MYSQL_PORT) portReadyResolve?.();
    },
  });

  const { exit } = await kernel.boot({
    kernelWasm: kernelBytes,
    vfsImage,
    argv: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl", "mariadb"],
    env: ["HOME=/root", "TERM=xterm-256color", "USER=root", "LOGNAME=root", "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin"],
    cwd: "/root",
    uid: 0,
    gid: 0,
  });

  // Surface dinit exit if it ever happens — should not while tests run.
  exit.then((code) => {
    appendLog(`\ndinit exited with code ${code}\n`, "info");
    statusEl.textContent = `dinit exited with code ${code}`;
  });

  await portReady;
  appendLog("Server ready on port 3306.\n", "info");

  // Setup SQL needs a brief retry — port-bind happens before
  // the server's accept loop is fully ready.
  statusEl.textContent = "Running setup SQL...";
  let setupResult: TestResult | null = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    setupResult = await runMysqlTestCommand("__setup", "/mysql-test/main/__setup.test", 30000);
    if (setupResult.exitCode === 0) break;
    appendLog(`Setup attempt ${attempt} failed (exit ${setupResult.exitCode}); retrying...\n`, "info");
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!setupResult || setupResult.exitCode !== 0) {
    appendLog(`Warning: setup SQL exited with code ${setupResult?.exitCode}\n`, "error");
  } else {
    appendLog("Setup SQL complete.\n", "info");
  }

  window.__probeMariadb = async (timeoutMs = 5000): Promise<boolean> => {
    const result = await runMysqlTestCommand("__probe", "/mysql-test/main/__probe.test", timeoutMs);
    return result.exitCode === 0;
  };

  window.__runMariadbTest = async (testName: string, timeoutMs = 60000): Promise<TestResult> => {
    const resetResult = await runMysqlTestCommand("__reset", "/mysql-test/main/__reset.test", 15000);
    if (resetResult.exitCode !== 0 && resetResult.stderr !== "TIMEOUT") {
      // Non-fatal — continue anyway.
    }
    const testFile = `/mysql-test/main/${testName}.test`;
    return runMysqlTestCommand(testName, testFile, timeoutMs);
  };

  window.__mariadbTestReady = true;
  statusEl.textContent = "Ready — waiting for test commands";
  appendLog("Test runner ready.\n", "info");
}

init().catch((err) => {
  statusEl.textContent = `Error: ${err.message}`;
  appendLog(`Error: ${err.message}\n`, "error");
  console.error("MariaDB test runner init failed:", err);
});
