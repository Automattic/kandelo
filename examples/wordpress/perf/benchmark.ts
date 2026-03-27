#!/usr/bin/env -S npx tsx
/**
 * wasm-posix-kernel WordPress — Site Editor Performance Benchmark
 *
 * Spawns the WordPress server, installs WordPress, then launches
 * headless Chromium to measure site-editor performance.
 *
 * Designed to produce output comparable to WordPress Playground's
 * `npx nx perf playground-cli`.
 *
 * Usage:
 *   npx tsx examples/wordpress/perf/benchmark.ts
 *   npx tsx examples/wordpress/perf/benchmark.ts --rounds=5
 *   npx tsx examples/wordpress/perf/benchmark.ts --headed
 */

import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { parseArgs } from "util";
import { chromium } from "@playwright/test";
import {
  measureSiteEditor,
  METRIC_NAMES,
  type MeasurementResult,
} from "./measure-site-editor.ts";

interface Options {
  rounds: number;
  headed: boolean;
  port: number;
}

interface BenchmarkResult {
  environment: string;
  metrics: Record<string, number>;
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const WP_DIR = path.resolve(import.meta.dirname, "../wordpress");
const DB_PATH = path.join(WP_DIR, "wp-content/database/wordpress.db");

const ADMIN_USER = "admin";
const ADMIN_PASS = "benchmarkpass123";
const ADMIN_EMAIL = "admin@example.com";

async function main() {
  const opts = getOptions();
  const baseUrl = `http://localhost:${opts.port}`;

  console.log("\n=== wasm-posix-kernel WordPress Site Editor Benchmark ===");
  console.log(`Platform: ${os.platform()} ${os.arch()}`);
  console.log(`Node: ${process.version}`);
  console.log(`CPUs: ${os.cpus().length}`);
  console.log(`Rounds: ${opts.rounds}`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log("");

  let serverProc: ChildProcess | undefined;

  const cleanup = () => {
    if (serverProc?.pid) {
      try {
        process.kill(-serverProc.pid, "SIGKILL");
      } catch {
        // Already gone
      }
    }
  };
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
  process.on("exit", cleanup);

  try {
    // Fresh database for each benchmark
    if (fs.existsSync(DB_PATH)) {
      fs.unlinkSync(DB_PATH);
    }

    // Start server and measure startup
    console.log("--- Starting server ---");
    const { proc, startupMs } = await startServer(opts.port);
    serverProc = proc;
    console.log(`  Startup: ${formatDuration(startupMs)}`);

    // Install WordPress via Playwright
    console.log("\n--- Installing WordPress ---");
    const installMs = await installWordPress(baseUrl, opts.headed);
    console.log(`  Install: ${formatDuration(installMs)}`);

    // Run benchmark rounds
    console.log("\n--- Benchmarking site editor ---");
    const metrics = await runBenchmark(baseUrl, opts);
    console.log("  Done.");

    const result: BenchmarkResult = {
      environment: "wasm-posix-kernel",
      metrics: {
        serverStartup: startupMs,
        wpInstall: installMs,
        ...metrics,
      },
    };

    printResultsTable([result]);
    const savedPath = saveResults([result]);
    console.log(`\nResults saved to: ${savedPath}`);
  } catch (err) {
    console.error(`\nBenchmark failed: ${err}`);
    process.exit(1);
  } finally {
    if (serverProc) {
      console.log("\n  Stopping server...");
      await stopServer(serverProc);
    }
  }

  process.exit(0);
}

function getOptions(): Options {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", default: false },
      rounds: { type: "string", default: "3" },
      headed: { type: "boolean", default: false },
      port: { type: "string", default: "9400" },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`Usage: npx tsx examples/wordpress/perf/benchmark.ts [options]

Measure WordPress site editor performance on wasm-posix-kernel.

Options:
  --rounds=N    Successful rounds required (default: 3, retries up to 2x)
  --headed      Run Chromium in headed mode (for debugging)
  --port=N      Port for the WordPress server (default: 9400)
  --help        Show this help message`);
    process.exit(0);
  }

  const rounds = parseInt(values.rounds as string, 10);
  if (!Number.isInteger(rounds) || rounds < 1) {
    console.error(`Invalid --rounds: ${values.rounds}. Must be >= 1.`);
    process.exit(1);
  }

  return {
    rounds,
    headed: values.headed as boolean,
    port: parseInt(values.port as string, 10),
  };
}

async function startServer(port: number): Promise<{ proc: ChildProcess; startupMs: number }> {
  const startTime = Date.now();
  const proc = spawn(
    "npx",
    ["tsx", "examples/wordpress/serve.ts", String(port)],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
    },
  );

  let stderr = "";
  let stdout = "";
  proc.stderr?.on("data", (data) => { stderr += data.toString(); });
  proc.stdout?.on("data", (data) => { stdout += data.toString(); });

  const readyPattern = /Development Server.*started/i;

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(
        "Server did not start within 180s" +
        (stdout ? `\nstdout: ${stdout.slice(0, 1000)}` : "") +
        (stderr ? `\nstderr: ${stderr.slice(0, 1000)}` : ""),
      ));
    }, 180_000);

    const checkReady = (text: string) => {
      if (readyPattern.test(text)) {
        clearTimeout(timeoutId);
        resolve();
      }
    };

    proc.stderr?.on("data", (data) => checkReady(data.toString()));
    proc.stdout?.on("data", (data) => checkReady(data.toString()));

    proc.on("exit", (code) => {
      clearTimeout(timeoutId);
      reject(new Error(
        `Server exited with code ${code}` +
        (stdout ? `\nstdout: ${stdout.slice(0, 1000)}` : "") +
        (stderr ? `\nstderr: ${stderr.slice(0, 1000)}` : ""),
      ));
    });
  });

  // Wait for the server to actually accept HTTP connections
  await waitForHttp(`http://localhost:${port}/`, 30_000);

  const startupMs = Date.now() - startTime;
  console.log(`  Server ready at http://localhost:${port}`);
  return { proc, startupMs };
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      await resp.body?.cancel();
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`Server did not respond to HTTP within ${timeoutMs}ms`);
}

async function stopServer(proc: ChildProcess): Promise<void> {
  if (!proc.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)]);
    } else {
      process.kill(-proc.pid, "SIGTERM");
    }
  } catch {
    // Already gone
  }
  await sleep(2000);
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    // Already gone
  }
}

async function installWordPress(baseUrl: string, headed: boolean): Promise<number> {
  const startTime = Date.now();

  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(`${baseUrl}/wp-admin/install.php`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

    // Fill install form
    await page.getByRole("textbox", { name: "Site Title" }).fill("Wasm WordPress");
    await page.getByRole("textbox", { name: "Username" }).fill(ADMIN_USER);

    // Clear the auto-generated password and set our own
    const passwordField = page.getByRole("textbox", { name: "Password" });
    await passwordField.fill(ADMIN_PASS);

    await page.getByRole("textbox", { name: "Your Email" }).fill(ADMIN_EMAIL);

    // Check "Confirm use of weak password" if visible
    const weakPwCheckbox = page.getByRole("checkbox", { name: /weak password/i });
    if (await weakPwCheckbox.isVisible({ timeout: 1000 }).catch(() => false)) {
      await weakPwCheckbox.check();
    }

    await page.getByRole("button", { name: "Install WordPress" }).click();

    // Wait for success
    await page.getByRole("heading", { name: "Success!" }).waitFor({
      timeout: 120_000,
    });
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  return Date.now() - startTime;
}

async function runBenchmark(
  baseUrl: string,
  opts: Options,
): Promise<Record<string, number>> {
  const maxAttempts = opts.rounds * 2;
  console.log(
    `  Collecting ${opts.rounds} successful round${opts.rounds > 1 ? "s" : ""} (up to ${maxAttempts} attempts)...`,
  );

  const allMeasurements: MeasurementResult[] = [];
  let attempts = 0;

  while (allMeasurements.length < opts.rounds && attempts < maxAttempts) {
    attempts++;
    const label =
      `${allMeasurements.length + 1}/${opts.rounds}` +
      (attempts > allMeasurements.length + 1
        ? ` (attempt ${attempts}/${maxAttempts})`
        : "");
    console.log(`    Round ${label}...`);

    try {
      const result = await Promise.race([
        measureSiteEditor({
          url: baseUrl,
          username: ADMIN_USER,
          password: ADMIN_PASS,
          headed: opts.headed,
        }),
        sleep(600_000).then(() => {
          throw new Error("Measurement timed out");
        }),
      ]);
      allMeasurements.push(result);

      const parts = METRIC_NAMES.filter((m) => result[m] !== undefined)
        .map((m) => `${m}=${formatDuration(result[m]!)}`)
        .join(", ");
      console.log(`    ${parts}`);
    } catch (err) {
      console.warn(`    Attempt ${attempts} failed: ${err}`);
    }

    if (allMeasurements.length < opts.rounds) {
      await sleep(1000);
    }
  }

  if (allMeasurements.length < opts.rounds) {
    throw new Error(
      `Only ${allMeasurements.length}/${opts.rounds} rounds succeeded after ${maxAttempts} attempts`,
    );
  }

  const medians: Record<string, number> = {};
  for (const metric of METRIC_NAMES) {
    const values = allMeasurements
      .map((m) => m[metric])
      .filter((v): v is number => v !== undefined);
    if (values.length > 0) {
      medians[metric] = median(values);
    }
  }

  return medians;
}

function printResultsTable(results: BenchmarkResult[]): void {
  if (results.length === 0) {
    console.log("\nNo results to display.");
    return;
  }

  const allMetrics = new Set<string>();
  for (const r of results) {
    Object.keys(r.metrics).forEach((k) => allMetrics.add(k));
  }
  const metrics = [...allMetrics].sort();

  const metricColWidth = Math.max(20, ...metrics.map((m) => m.length + 2));
  const envColWidth = Math.max(
    20,
    ...results.map((r) => r.environment.length + 2),
  );
  const lineWidth = metricColWidth + envColWidth * results.length;

  console.log("\n\nResults");
  console.log("=".repeat(lineWidth));

  const header =
    "Metric".padEnd(metricColWidth) +
    results.map((r) => r.environment.padEnd(envColWidth)).join("");
  console.log(header);
  console.log("-".repeat(lineWidth));

  for (const metric of metrics) {
    let row = metric.padEnd(metricColWidth);
    for (const r of results) {
      const value = r.metrics[metric];
      row +=
        value !== undefined
          ? formatDuration(value).padEnd(envColWidth)
          : "\u2014".padEnd(envColWidth);
    }
    console.log(row);
  }

  console.log("=".repeat(lineWidth));
}

function saveResults(results: BenchmarkResult[]): string {
  const artifactsDir = path.resolve(import.meta.dirname, "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });

  const summaryPath = path.join(artifactsDir, `benchmark-${Date.now()}.json`);
  const summary = {
    date: new Date().toISOString(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    cpus: os.cpus().length,
    results,
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  return summaryPath;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
