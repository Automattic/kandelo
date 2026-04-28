/**
 * MariaDB mysql-test browser runner — boots MariaDB via SystemInit,
 * loads test files from VFS image, and exposes window.__runMariadbTest() for Playwright.
 *
 * Process layout:
 *   pid 1: mariadbd --bootstrap (oneshot, terminated after stdin consumed)
 *   pid 2: mariadbd server (daemon, port 3306)
 *   pid 3+: mysqltest (transient, one per test)
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { decompressVfsImage } from "../../../../host/src/vfs/load-image";
import { SystemInit } from "../../lib/init/system-init";
import kernelWasmUrl from "@kernel-wasm?url";
import mysqlTestWasmUrl from "../../../../binaries/programs/wasm32/mariadb/mysqltest.wasm?url";
import VFS_IMAGE_URL from "@binaries/programs/wasm32/mariadb-test.vfs?url";

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

  // Fetch kernel, VFS image, and mysqltest in parallel
  const [kernelBytes, vfsImageBuf, mysqlTestBytesResult] =
    await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(VFS_IMAGE_URL).then((r) => {
        if (!r.ok) {
          throw new Error(
            `Failed to load VFS image from ${VFS_IMAGE_URL} (${r.status}). ` +
            `Run: bash examples/libs/mariadb-test/build-mariadb-test.sh`
          );
        }
        return r.arrayBuffer();
      }),
      fetch(mysqlTestWasmUrl).then((r) => r.arrayBuffer()),
    ]);

  mysqlTestBytes = mysqlTestBytesResult;

  appendLog(
    `Loaded: kernel ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
    `VFS image ${(vfsImageBuf.byteLength / (1024 * 1024)).toFixed(1)}MB, ` +
    `mysqltest ${(mysqlTestBytesResult.byteLength / (1024 * 1024)).toFixed(1)}MB\n`,
    "info",
  );

  // Restore MemoryFileSystem from the pre-built VFS image
  statusEl.textContent = "Restoring VFS from image...";
  const memfs = MemoryFileSystem.fromImage(decompressVfsImage(new Uint8Array(vfsImageBuf)), {
    maxByteLength: 512 * 1024 * 1024,
  });

  // Create kernel with pre-built filesystem
  kernel = new BrowserKernel({
    memfs,
    maxWorkers: 12,
    onStdout: (data) => {
      // Server stdout — mostly noise, ignore for tests
    },
    onStderr: (data) => {
      testStderr += decoder.decode(data);
    },
  });

  await kernel.init(kernelBytes);

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
