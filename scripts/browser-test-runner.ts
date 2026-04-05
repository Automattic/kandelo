/**
 * Browser test runner — executes wasm test binaries in a headless browser.
 *
 * Uses Playwright to launch Chromium, navigate to the test-runner page
 * (served by Vite), and run each test binary via window.__runTest().
 *
 * Usage:
 *   npx tsx scripts/browser-test-runner.ts <wasm-file-or-dir> [--timeout <ms>]
 *
 * When given a directory, runs all .wasm files in it.
 * Outputs JSON lines: { "file": "...", "exitCode": N, "stdout": "...", "stderr": "..." }
 */
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const BROWSER_DIR = resolve(REPO_ROOT, "examples/browser");
const VITE_PORT = 5199; // Use different port than demo tests to avoid conflicts
const DEFAULT_TIMEOUT = 30_000;

interface TestResult {
  file: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs: number;
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
        // Give Vite a moment to fully initialize
        setTimeout(() => resolvePromise(proc), 500);
      }
    });

    proc.stderr!.on("data", (data: Buffer) => {
      // Vite sometimes writes to stderr during startup
      const text = data.toString();
      if (text.includes("error") || text.includes("Error")) {
        if (!started) {
          clearTimeout(timeout);
          reject(new Error(`Vite startup error: ${text}`));
        }
      }
    });

    proc.on("exit", (code) => {
      viteAlive = false;
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Vite exited with code ${code}`));
      }
    });
  });
}

async function waitForTestRunner(page: Page, timeout = 30_000): Promise<void> {
  await page.goto(`http://localhost:${VITE_PORT}/pages/test-runner/`);
  await page.waitForFunction(
    () => (window as any).__testRunnerReady === true,
    {},
    { timeout },
  );
}

interface DataFileSpec {
  path: string;
  data?: number[];
  useWasmBytes?: boolean;
}

function buildDataFiles(
  wasmPath: string,
  dataPrefix: string | null,
  sourceDir: string | null,
  suite: string | null = null,
): { dataFiles: DataFileSpec[]; cwd: string | null; testName: string | null } {
  if (!dataPrefix) return { dataFiles: [], cwd: null, testName: null };

  // Extract test name from wasm filename: "fcntl/open.wasm" -> "fcntl/open"
  const relToPrefix = relative(resolve(dataPrefix), wasmPath);
  const testName = relToPrefix.replace(/\.wasm$/, "");

  // Data directory root in VFS.
  // When suite is provided, nest under /data/<suite> so that ".." from CWD
  // reaches /data which contains <suite>/, matching the Node.js layout.
  const dataRoot = "/data";
  const cwd = suite ? `${dataRoot}/${suite}` : dataRoot;
  const dataFiles: DataFileSpec[] = [];

  // Add the wasm binary at its expected path (tests open themselves by name).
  // Use useWasmBytes flag to avoid re-sending the binary through JSON.
  dataFiles.push({
    path: `${cwd}/${testName}`,
    useWasmBytes: true,
  });

  // Add the .c source file if it exists
  if (sourceDir) {
    const srcPath = resolve(sourceDir, testName + ".c");
    if (existsSync(srcPath)) {
      const srcBytes = readFileSync(srcPath);
      dataFiles.push({
        path: `${cwd}/${testName}.c`,
        data: Array.from(srcBytes),
      });
    }
  }

  return { dataFiles, cwd, testName };
}

async function runSingleTest(
  page: Page,
  wasmPath: string,
  testTimeout: number,
  dataPrefix: string | null = null,
  sourceDir: string | null = null,
  suite: string | null = null,
): Promise<TestResult> {
  const wasmBytes = readFileSync(wasmPath);
  const start = performance.now();
  const relPath = relative(REPO_ROOT, wasmPath);

  const { dataFiles, cwd, testName } = buildDataFiles(wasmPath, dataPrefix, sourceDir, suite);

  // Use test name as argv[0] so self-exec tests (execlp(argv[0],...)) work.
  // Build env with PATH including CWD for bare-name execlp resolution.
  const argv = testName ? [testName] : ["test"];
  const env = cwd
    ? [
        `PATH=${cwd}:/usr/local/bin:/usr/bin:/bin`,
        "HOME=/home",
        "TMPDIR=/tmp",
        "TERM=xterm-256color",
        "LANG=en_US.UTF-8",
        "USER=browser",
        "LOGNAME=browser",
      ]
    : undefined;

  try {
    const result = await page.evaluate(
      async ({ bytes, timeout, dataFiles: df, cwd: cwdPath, argv: av, env: ev }) => {
        const ab = new Uint8Array(bytes).buffer;
        const options: Record<string, any> = {};
        if (df.length > 0) options.dataFiles = df;
        if (cwdPath) options.cwd = cwdPath;
        if (ev) options.env = ev;
        return await (window as any).__runTest(
          ab,
          av,
          timeout,
          Object.keys(options).length > 0 ? options : undefined,
        );
      },
      {
        bytes: Array.from(wasmBytes),
        timeout: testTimeout,
        dataFiles,
        cwd,
        argv,
        env,
      },
    );

    return {
      file: relPath,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Math.round(performance.now() - start),
    };
  } catch (err: any) {
    const msg = err.message || String(err);
    return {
      file: relPath,
      exitCode: -1,
      stdout: "",
      stderr: "",
      error: msg.includes("TIMEOUT") ? "TIMEOUT" : msg,
      durationMs: Math.round(performance.now() - start),
    };
  }
}

function discoverWasmFiles(pathArg: string): string[] {
  const resolved = resolve(pathArg);
  if (!existsSync(resolved)) {
    console.error(`Path does not exist: ${resolved}`);
    process.exit(1);
  }

  const st = statSync(resolved);
  if (st.isFile()) {
    return [resolved];
  }

  // Directory: find all .wasm files recursively
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".wasm")) {
        files.push(full);
      }
    }
  }
  walk(resolved);
  return files.sort();
}

async function main() {
  const args = process.argv.slice(2);
  let testTimeout = DEFAULT_TIMEOUT;
  let jsonOutput = false;
  let listFile: string | null = null;
  let reloadInterval = 3; // Default: reload every 3 tests to prevent OOM
  let dataPrefix: string | null = null; // Base path for constructing VFS data files
  let sourceDir: string | null = null; // Directory containing .c source files
  let suiteName: string | null = null; // Suite name for nested data directory layout
  const paths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timeout" && args[i + 1]) {
      testTimeout = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--json") {
      jsonOutput = true;
    } else if (args[i] === "--list" && args[i + 1]) {
      listFile = args[i + 1];
      i++;
    } else if (args[i] === "--reload-interval" && args[i + 1]) {
      reloadInterval = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--data-prefix" && args[i + 1]) {
      dataPrefix = resolve(args[i + 1]);
      i++;
    } else if (args[i] === "--source-dir" && args[i + 1]) {
      sourceDir = resolve(args[i + 1]);
      i++;
    } else if (args[i] === "--suite" && args[i + 1]) {
      suiteName = args[i + 1];
      i++;
    } else {
      paths.push(args[i]);
    }
  }

  // Discover all wasm files
  const wasmFiles: string[] = [];

  // Read from list file if provided
  if (listFile) {
    const content = readFileSync(listFile, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        wasmFiles.push(resolve(trimmed));
      }
    }
  }

  for (const p of paths) {
    wasmFiles.push(...discoverWasmFiles(p));
  }

  if (wasmFiles.length === 0) {
    console.error("Usage: npx tsx scripts/browser-test-runner.ts <wasm-file-or-dir> [--list <file>] [--timeout <ms>] [--json]");
    process.exit(1);
  }

  if (!jsonOutput) {
    console.error(`Found ${wasmFiles.length} test(s). Starting browser...`);
  }

  // Start Vite server
  let viteProc: ChildProcess | null = null;
  let browser: Browser | null = null;

  async function ensureVite(): Promise<void> {
    if (viteAlive && viteProc && !viteProc.killed) return;
    // Kill old process if it exists
    if (viteProc) {
      try { viteProc.kill(); } catch {}
      await new Promise<void>((r) => {
        viteProc!.on("exit", () => r());
        setTimeout(r, 2000);
      });
    }
    if (!jsonOutput) {
      process.stderr.write("  Restarting Vite server...\n");
    }
    viteProc = await startViteServer();
  }

  async function safeWaitForTestRunner(page: Page): Promise<void> {
    try {
      await waitForTestRunner(page);
    } catch {
      // Vite may have crashed — restart it and retry
      await ensureVite();
      await waitForTestRunner(page);
    }
  }

  try {
    viteProc = await startViteServer();

    // Launch browser
    browser = await chromium.launch({
      args: [
        // Required for SharedArrayBuffer
        "--enable-features=SharedArrayBuffer",
      ],
    });

    let context = await browser.newContext();
    let page = await context.newPage();

    // Forward browser console for debugging
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`[browser] ${msg.text()}`);
      }
    });

    // Navigate to test runner and wait for it to be ready
    await safeWaitForTestRunner(page);

    if (!jsonOutput) {
      console.error("Test runner ready. Running tests...\n");
    }

    // Run each test — reload page every reloadInterval tests to prevent OOM.
    // Each test creates a 1GB SharedArrayBuffer (16384 pages, pre-allocated
    // for shared memory). Chrome's virtual address space fills up after ~3-4
    // tests. Use fresh browser contexts periodically to fully release address space.
    const results: TestResult[] = [];
    let testsSinceReload = 0;

    for (let i = 0; i < wasmFiles.length; i++) {
      const wasmPath = wasmFiles[i];
      const relPath = relative(REPO_ROOT, wasmPath);

      let result = await runSingleTest(page, wasmPath, testTimeout, dataPrefix, sourceDir, suiteName);

      // If OOM, create fresh context and retry once
      if (result.error && result.error.includes("could not allocate memory")) {
        if (!jsonOutput) {
          process.stderr.write("  OOM detected, creating fresh context...\n");
        }
        await context.close();
        context = await browser.newContext();
        page = await context.newPage();
        page.on("console", (msg) => {
          if (msg.type() === "error") {
            console.error(`[browser] ${msg.text()}`);
          }
        });
        await safeWaitForTestRunner(page);
        testsSinceReload = 0;
        result = await runSingleTest(page, wasmPath, testTimeout, dataPrefix, sourceDir, suiteName);
      }

      results.push(result);
      testsSinceReload++;

      if (jsonOutput) {
        console.log(JSON.stringify(result));
      } else {
        const status = result.error === "TIMEOUT"
          ? "TIME"
          : result.error
            ? "ERROR"
            : result.exitCode === 0
              ? "PASS"
              : `FAIL(${result.exitCode})`;
        process.stderr.write(`[${i + 1}/${wasmFiles.length}] ${status} ${relPath} (${result.durationMs}ms)\n`);
      }

      // Periodic reload to prevent OOM accumulation.
      // Use fresh browser context every 15 tests (5 reload cycles) to fully
      // release SharedArrayBuffer address space.
      if (testsSinceReload >= reloadInterval && i < wasmFiles.length - 1) {
        if (testsSinceReload >= reloadInterval * 5) {
          // Fresh context for full memory release
          await context.close();
          context = await browser.newContext();
          page = await context.newPage();
          page.on("console", (msg) => {
            if (msg.type() === "error") {
              console.error(`[browser] ${msg.text()}`);
            }
          });
          await safeWaitForTestRunner(page);
          testsSinceReload = 0;
        } else {
          await safeWaitForTestRunner(page);
          testsSinceReload = 0;
        }
        continue;
      }

      // If the test crashed the page, reload it
      try {
        const ready = await page.evaluate(() => (window as any).__testRunnerReady);
        if (!ready) throw new Error("not ready");
      } catch {
        if (!jsonOutput) {
          process.stderr.write("  Page crashed, reloading...\n");
        }
        await safeWaitForTestRunner(page);
        testsSinceReload = 0;
      }
    }

    // Print summary
    if (!jsonOutput) {
      const pass = results.filter((r) => !r.error && r.exitCode === 0).length;
      const fail = results.filter((r) => !r.error && r.exitCode !== 0).length;
      const timeout = results.filter((r) => r.error === "TIMEOUT").length;
      const error = results.filter((r) => r.error && r.error !== "TIMEOUT").length;

      console.error(`\n===== Browser Test Results =====`);
      console.error(`PASS:    ${pass}`);
      console.error(`FAIL:    ${fail}`);
      console.error(`TIMEOUT: ${timeout}`);
      console.error(`ERROR:   ${error}`);
      console.error(`TOTAL:   ${results.length}`);
    }
  } finally {
    if (browser) await browser.close();
    if (viteProc) {
      viteProc.kill();
      // Wait for process to actually exit
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
