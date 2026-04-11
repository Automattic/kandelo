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
const BROWSER_DIR = resolve(REPO_ROOT, "examples/browser");
const VITE_PORT = 5198; // Different from test-runner's 5199
const DEFAULT_TIMEOUT = 60_000;
const BOOT_TIMEOUT = 180_000; // MariaDB boot can take a while in browser

interface TestResult {
  test: string;
  status: "pass" | "fail" | "skip";
  time_ms: number;
  error?: string;
  stderr?: string;
}

let viteAlive = false;

async function startViteServer(): Promise<ChildProcess> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      "npx",
      ["vite", "--config", resolve(BROWSER_DIR, "vite.config.ts"), "--port", String(VITE_PORT)],
      {
        cwd: BROWSER_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
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
      if (!started && text.includes("Local:")) {
        started = true;
        viteAlive = true;
        clearTimeout(timeout);
        setTimeout(() => resolvePromise(proc), 500);
      }
    });

    proc.stderr!.on("data", () => {});

    proc.on("exit", (code) => {
      viteAlive = false;
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Vite exited with code ${code}`));
      }
    });
  });
}

async function waitForMariadbReady(page: Page, timeout = BOOT_TIMEOUT): Promise<void> {
  await page.goto(`http://localhost:${VITE_PORT}/pages/mariadb-test/`);
  await page.waitForFunction(
    () => (window as any).__mariadbTestReady === true,
    {},
    { timeout },
  );
}

async function runTest(page: Page, testName: string, testTimeout: number): Promise<TestResult> {
  const start = performance.now();

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

    return {
      test: testName,
      status,
      time_ms: elapsed,
      stderr: result.stderr || undefined,
      error: result.exitCode === -1 ? result.stderr : undefined,
    };
  } catch (err: any) {
    return {
      test: testName,
      status: "fail",
      time_ms: Math.round(performance.now() - start),
      error: err.message || String(err),
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  let testTimeout = DEFAULT_TIMEOUT;
  let jsonOutput = false;
  const testNames: string[] = [];

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
    browser = await chromium.launch({
      args: ["--enable-features=SharedArrayBuffer"],
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // Forward browser console errors for debugging
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`[browser] ${msg.text()}`);
      }
    });

    // Navigate and wait for MariaDB to boot
    if (!jsonOutput) {
      console.error("Waiting for MariaDB to boot in browser...");
    }
    await waitForMariadbReady(page);
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
          await waitForMariadbReady(page);
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
      const result = await runTest(page, testName, testTimeout);
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

      // Detect timeout/hang — reload immediately
      const isTimeout = result.error === "TIMEOUT" || result.time_ms > testTimeout * 1.3;
      let needsReload = isTimeout;

      if (!needsReload) {
        try {
          const ready = await page.evaluate(() => (window as any).__mariadbTestReady);
          if (!ready) needsReload = true;
        } catch {
          needsReload = true;
        }
      }

      if (needsReload) {
        if (!jsonOutput) {
          process.stderr.write("  Rebooting MariaDB...\n");
        }
        try {
          await waitForMariadbReady(page);
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
