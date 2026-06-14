/**
 * Browser MariaDB test runner — executes mysql-test suite in headless Chromium.
 *
 * Launches a Vite dev server, opens the mariadb-test page (which boots
 * MariaDB via SystemInit), then runs each test via window.__runMariadbTest().
 *
 * Usage:
 *   npx tsx scripts/browser-mariadb-test-runner.ts [test1 test2 ...]
 *   npx tsx scripts/browser-mariadb-test-runner.ts --json
 */
import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const BROWSER_DIR = resolve(REPO_ROOT, "apps/browser-demos");
const VITE_BIN = resolve(REPO_ROOT, "node_modules/vite/bin/vite.js");
const VITE_HOST = "127.0.0.1";
const VITE_PORT = Number(process.env.MARIADB_TEST_VITE_PORT ?? 5198); // Different from test-runner's 5199
const DEFAULT_TIMEOUT = 60_000;
const BOOT_TIMEOUT = 180_000; // MariaDB boot can take a while in browser

interface TestResult {
  test: string;
  status: "pass" | "fail" | "skip";
  time_ms: number;
  error?: string;
  stderr?: string;
  runtimeFailure?: string;
}

let viteAlive = false;
const browserConsoleErrors: string[] = [];
const MAX_BROWSER_CONSOLE_ERRORS = 100;

function recordBrowserConsoleError(text: string): void {
  browserConsoleErrors.push(text);
  if (browserConsoleErrors.length > MAX_BROWSER_CONSOLE_ERRORS) {
    browserConsoleErrors.splice(0, browserConsoleErrors.length - MAX_BROWSER_CONSOLE_ERRORS);
  }
  console.error(`[browser] ${text}`);
}

function classifyRuntimeFailure(stderr: string | undefined, browserErrors: readonly string[]): string | undefined {
  const text = `${stderr ?? ""}\n${browserErrors.join("\n")}`;
  if (/out of memory|cannot allocate memory|RangeError:.*memory/i.test(text)) {
    return "browser resource failure: mysqltest out of memory";
  }
  if (/Kernel worker failed|kernel threw|RuntimeError: unreachable|\[process-worker\]/i.test(text)) {
    return "browser runtime failure: kernel worker trap";
  }
  return undefined;
}

async function launchChromium(): Promise<Browser> {
  return chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ["--enable-features=SharedArrayBuffer"],
  });
}

async function startViteServer(): Promise<ChildProcess> {
  return new Promise((resolvePromise, reject) => {
    let outputTail = "";
    const appendOutput = (prefix: string, data: Buffer) => {
      outputTail = `${outputTail}${prefix}${data.toString()}`.slice(-8000);
    };
    const proc = spawn(
      process.execPath,
      [
        VITE_BIN,
        "--config", resolve(BROWSER_DIR, "vite.config.ts"),
        "--host", VITE_HOST,
        "--port", String(VITE_PORT),
        "--strictPort",
      ],
      {
        cwd: BROWSER_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          KANDELO_BROWSER_DEMO_INPUTS: "mariadb-test",
          KANDELO_BROWSER_TEST_NO_HMR: "1",
        },
      },
    );

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        proc.kill();
        reject(new Error("Vite server did not start within 30s"));
      }
    }, 30_000);

    proc.stdout!.on("data", (data: Buffer) => {
      const text = data.toString();
      appendOutput("[vite] ", data);
      if (!started && text.includes("Local:")) {
        started = true;
        viteAlive = true;
        clearTimeout(timeout);
        setTimeout(() => resolvePromise(proc), 500);
      }
    });

    proc.stderr!.on("data", (data: Buffer) => appendOutput("[vite:stderr] ", data));

    proc.on("exit", (code) => {
      viteAlive = false;
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Vite exited with code ${code}${outputTail ? `\n${outputTail}` : ""}`));
      }
    });
  });
}

async function waitForMariadbReady(page: Page, timeout = BOOT_TIMEOUT): Promise<void> {
  await page.goto(`http://${VITE_HOST}:${VITE_PORT}/pages/mariadb-test/`);
  try {
    await page.waitForFunction(
      () => (window as any).__mariadbTestReady === true,
      {},
      { timeout },
    );
  } catch (err) {
    const diagnostics = await page.evaluate(() => ({
      status: document.getElementById("status")?.textContent ?? "",
      log: document.getElementById("log")?.textContent?.slice(-4000) ?? "",
    })).catch((diagErr) => ({
      status: "<unavailable>",
      log: `Failed to read page diagnostics: ${diagErr}`,
    }));
    console.error("MariaDB browser page did not become ready.");
    console.error(`Status: ${diagnostics.status}`);
    if (diagnostics.log) console.error(`Log tail:\n${diagnostics.log}`);
    throw err;
  }
}

async function runTest(page: Page, testName: string, testTimeout: number): Promise<TestResult> {
  const start = performance.now();
  const browserErrorStart = browserConsoleErrors.length;

  try {
    const result = await page.evaluate(
      async ({ name, timeout }) => {
        return await (window as any).__runMariadbTest(name, timeout);
      },
      { name: testName, timeout: testTimeout },
    );

    const elapsed = Math.round(performance.now() - start);

    let status: "pass" | "fail" | "skip";
    if (result.exitCode === 0) status = "pass";
    else if (result.exitCode === 62) status = "skip";
    else status = "fail";

    let stderr = result.stderr || undefined;
    if (status === "fail") {
      const serverLog = await page.evaluate(async () => {
        const readFile = (window as any).__readMariadbFile;
        if (typeof readFile !== "function") return "";
        return await readFile("/data/error.log", 3000);
      }).catch(() => "");
      if (serverLog.trim()) {
        stderr = `${stderr ?? ""}\n\n[data/error.log]\n${serverLog.slice(-4000)}`;
      }
    }

    const recentBrowserErrors = browserConsoleErrors.slice(browserErrorStart);
    const runtimeFailure = classifyRuntimeFailure(stderr, recentBrowserErrors);

    return {
      test: testName,
      status,
      time_ms: elapsed,
      stderr,
      error: runtimeFailure ?? (result.exitCode === -1 ? stderr : undefined),
      runtimeFailure,
    };
  } catch (err: any) {
    const recentBrowserErrors = browserConsoleErrors.slice(browserErrorStart);
    const runtimeFailure = classifyRuntimeFailure(err.message || String(err), recentBrowserErrors);
    return {
      test: testName,
      status: "fail",
      time_ms: Math.round(performance.now() - start),
      error: runtimeFailure ?? (err.message || String(err)),
      runtimeFailure,
    };
  }
}

async function isMariadbReady(page: Page, timeoutMs = 5_000): Promise<boolean> {
  try {
    return await Promise.race([
      page.evaluate(async (timeout) => {
        if ((window as any).__mariadbTestReady !== true) return false;
        const probe = (window as any).__probeMariadb;
        if (typeof probe !== "function") return true;
        return await probe(timeout);
      }, timeoutMs),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  } catch {
    return false;
  }
}

function failureRequiresCleanReboot(result: TestResult): boolean {
  const text = `${result.error ?? ""}\n${result.stderr ?? ""}`;
  return text.includes("Out of memory") ||
    text.includes("out of memory") ||
    text.includes("ENOSPC") ||
    text.includes("Errcode: 28") ||
    text.includes("No space left on device") ||
    text.includes("Column count of mysql.proc is wrong") ||
    text.includes("Incorrect definition of table mysql.proc") ||
    text.includes("Cannot load from mysql.proc") ||
    (text.includes("mysql.proc") && text.includes("table is probably corrupted"));
}

async function main() {
  const args = process.argv.slice(2);
  let testTimeout = DEFAULT_TIMEOUT;
  let jsonOutput = false;
  const testNames: string[] = [];
  const rebootAfterFail = process.env.MARIADB_BROWSER_REBOOT_AFTER_FAIL !== "0";

  let batchSize = 0; // 0 = no batching

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timeout" && args[i + 1]) {
      testTimeout = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--json") {
      jsonOutput = true;
    } else if (args[i] === "--batch" && args[i + 1]) {
      batchSize = parseInt(args[i + 1], 10);
      i++;
    } else if (!args[i].startsWith("--")) {
      testNames.push(args[i]);
    }
  }

  if (testNames.length === 0) {
    console.error("Usage: npx tsx scripts/browser-mariadb-test-runner.ts [--json] [--timeout <ms>] test1 test2 ...");
    process.exit(1);
  }

  if (!jsonOutput) {
    console.error(`Running ${testNames.length} MariaDB test(s) in browser...`);
  }

  let viteProc: ChildProcess | null = null;
  let browser: Browser | null = null;

  try {
    // Start Vite
    viteProc = await startViteServer();
    if (!jsonOutput) {
      console.error("Vite server ready.");
    }

    // Launch browser
    browser = await launchChromium();

    let context: BrowserContext | null = null;
    let page: Page | null = null;

    const openReadyPage = async (): Promise<Page> => {
      let lastErr: unknown;

      for (let attempt = 1; attempt <= 3; attempt++) {
        // A MariaDB timeout or a test that kills mysqld can leave browser
        // Workers busy even after navigation. Use a fresh context/page for a
        // real reboot so the kernel worker, VFS image, and dinit tree are all
        // reconstructed. Intermittent browser boots can also reach port-ready
        // but fail setup SQL; retry those from a clean Chromium process before
        // marking a whole chunk as zero-results.
        await context?.close().catch(() => {});
        context = null;
        page = null;
        // Browser process state can remain unhealthy after a wasm worker
        // timeout. Close Chromium itself before rebooting the MariaDB page so
        // the next test starts from a clean JS worker/process tree.
        await browser?.close().catch(() => {});
        browser = await launchChromium();

        context = await browser!.newContext();
        const nextPage = await context.newPage();

        // Forward browser console errors for debugging
        nextPage.on("console", (msg) => {
          if (msg.type() === "error") {
            recordBrowserConsoleError(msg.text());
          }
        });

        try {
          await waitForMariadbReady(nextPage);
          page = nextPage;
          return nextPage;
        } catch (err) {
          lastErr = err;
          if (!jsonOutput && attempt < 3) {
            process.stderr.write(`  Browser MariaDB boot failed; retrying (${attempt}/3)...\n`);
          }
        }
      }

      throw lastErr;
    };

    // Navigate and wait for MariaDB to boot
    if (!jsonOutput) {
      console.error("Waiting for MariaDB to boot in browser...");
    }
    await openReadyPage();
    if (!jsonOutput) {
      console.error("MariaDB ready. Running tests...\n");
    }

    // Run each test
    const results: TestResult[] = [];
    let testsSinceBoot = 0;
    for (let i = 0; i < testNames.length; i++) {
      // Batch reload: reload page every N tests to prevent state accumulation
      if (batchSize > 0 && testsSinceBoot >= batchSize) {
        if (!jsonOutput) {
          process.stderr.write(`  Batch reload (${batchSize} tests done)...\n`);
        }
        try {
          await openReadyPage();
          testsSinceBoot = 0;
        } catch {
          // If reload fails, abort remaining
          for (let j = i; j < testNames.length; j++) {
            const r: TestResult = { test: testNames[j], status: "fail", time_ms: 0, error: "server crashed" };
            results.push(r);
            if (jsonOutput) console.log(JSON.stringify(r));
          }
          break;
        }
      }

      const testName = testNames[i];
      const result = await runTest(page!, testName, testTimeout);
      results.push(result);
      testsSinceBoot++;

      if (jsonOutput) {
        console.log(JSON.stringify(result));
      } else {
        const statusStr = result.error === "TIMEOUT"
          ? "TIME"
          : result.error
            ? "ERROR"
            : result.status === "pass"
              ? "PASS"
              : result.status === "skip"
                ? "SKIP"
                : `FAIL(${result.error || ""})`;
        process.stderr.write(
          `[${i + 1}/${testNames.length}] ${statusStr} ${testName} (${result.time_ms}ms)\n`,
        );
      }

      // Detect timeout/hang — reload immediately, but only when there are
      // more tests to run. A post-test readiness probe can itself block if
      // the just-finished mysqltest left the browser worker busy; probing
      // after the last test only delays process teardown.
      const hasMoreTests = i + 1 < testNames.length;
      const isTimeout = result.error === "TIMEOUT" || result.time_ms > testTimeout * 1.3;
      const needsCleanReboot = failureRequiresCleanReboot(result);
      const isRuntimeFailure = result.runtimeFailure !== undefined;
      const shouldProbe = result.status === "fail" || isTimeout;
      const needsReload = rebootAfterFail && hasMoreTests && (
        needsCleanReboot || isRuntimeFailure || isTimeout || (shouldProbe && !(await isMariadbReady(page!)))
      );

      if (needsReload) {
        if (!jsonOutput) {
          process.stderr.write("  Rebooting MariaDB...\n");
        }
        try {
          await openReadyPage();
          testsSinceBoot = 0;
        } catch {
          for (let j = i + 1; j < testNames.length; j++) {
            const r: TestResult = { test: testNames[j], status: "fail", time_ms: 0, error: "server crashed" };
            results.push(r);
            if (jsonOutput) console.log(JSON.stringify(r));
          }
          break;
        }
      }
    }

    // Print summary
    if (!jsonOutput) {
      const pass = results.filter((r) => r.status === "pass").length;
      const fail = results.filter((r) => r.status === "fail").length;
      const skip = results.filter((r) => r.status === "skip").length;

      console.error(`\n===== Browser MariaDB Test Results =====`);
      console.error(`PASS:    ${pass}`);
      console.error(`FAIL:    ${fail}`);
      console.error(`SKIP:    ${skip}`);
      console.error(`TOTAL:   ${results.length}`);
    }
  } finally {
    if (browser) await browser.close();
    if (viteProc) {
      viteProc.kill();
      await new Promise<void>((r) => {
        viteProc!.on("exit", () => r());
        setTimeout(r, 2000);
      });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
