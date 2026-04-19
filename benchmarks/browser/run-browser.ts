/**
 * Playwright harness for running benchmarks in the browser.
 *
 * 1. Starts the Vite dev server
 * 2. Navigates to the benchmark page
 * 3. Calls window.__runBenchmark() for each suite
 * 4. Collects and returns results
 */
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const browserDir = resolve(__dirname, "../../examples/browser");

/** Suites available in the browser benchmark page. */
const BROWSER_SUITES = [
  "syscall-io", "process-lifecycle", "erlang-ring", "wordpress",
  "mariadb-aria", "mariadb-aria-64",
  "mariadb-innodb", "mariadb-innodb-64",
];

/** Per-suite timeout for page.evaluate (ms). Heavy suites like mariadb need longer. */
const SUITE_TIMEOUTS: Record<string, number> = {
  "syscall-io": 60_000,
  "process-lifecycle": 60_000,
  "erlang-ring": 120_000,
  "wordpress": 300_000,
  "mariadb-aria": 600_000,
  "mariadb-aria-64": 600_000,
  "mariadb-innodb": 600_000,
  "mariadb-innodb-64": 600_000,
};

export interface BrowserBenchmarkOptions {
  suites?: string[];
  rounds?: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export async function runBrowserBenchmarks(
  options: BrowserBenchmarkOptions = {},
): Promise<Record<string, Record<string, number>>> {
  const suiteNames = options.suites ?? BROWSER_SUITES;
  const rounds = options.rounds ?? 3;
  const results: Record<string, Record<string, number>> = {};

  // Start Vite dev server
  console.log("Starting Vite dev server...");
  const server: ViteDevServer = await createServer({
    root: browserDir,
    configFile: resolve(browserDir, "vite.config.ts"),
    server: {
      port: 0, // random port
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
    logLevel: "warn",
  });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === "object" && address ? address.port : 5173;
  console.log(`Vite dev server running on port ${port}`);

  // Launch browser
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext();
    const page: Page = await context.newPage();

    // Surface page-side log() calls and errors so suite-skip reasons (e.g.
    // "missing binary, run …") and assertion failures are visible in the
    // harness output rather than silently hidden in the page DOM.
    page.on("console", (msg) => {
      const t = msg.type();
      if (t === "log" || t === "info" || t === "warning" || t === "error") {
        console.log(`  [page] ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => {
      console.error(`  [page error] ${err.message}`);
    });

    // Navigate to benchmark page
    await page.goto(`http://localhost:${port}/pages/benchmark/`, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });

    // Wait for page to be ready
    await page.waitForFunction(() => typeof window.__runBenchmark === "function", {
      timeout: 15_000,
    });

    // Run each suite
    for (const suiteName of suiteNames) {
      if (!BROWSER_SUITES.includes(suiteName)) {
        console.warn(`  Suite "${suiteName}" not available in browser, skipping`);
        continue;
      }

      console.log(`\n--- ${suiteName} (browser) ---`);
      const roundResults: Record<string, number[]> = {};

      for (let r = 0; r < rounds; r++) {
        console.log(`  round ${r + 1}/${rounds}...`);
        const timeout = SUITE_TIMEOUTS[suiteName] ?? 120_000;
        page.setDefaultTimeout(timeout);
        const metrics = await page.evaluate(
          ([name, opts]) => window.__runBenchmark(name, opts),
          [suiteName, { rounds: 1 }] as const,
        );

        for (const [key, value] of Object.entries(metrics)) {
          if (!roundResults[key]) roundResults[key] = [];
          roundResults[key].push(value);
        }
      }

      const suiteResult: Record<string, number> = {};
      for (const [key, values] of Object.entries(roundResults)) {
        suiteResult[key] = Math.round(median(values) * 100) / 100;
      }
      results[suiteName] = suiteResult;

      for (const [key, value] of Object.entries(suiteResult)) {
        console.log(`  ${key}: ${value}`);
      }
    }
  } finally {
    if (browser) await browser.close();
    await server.close();
  }

  return results;
}
