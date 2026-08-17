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
import { copyFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { tryResolveBinary } from "../../host/src/binary-resolver.js";
import {
  BENCHMARK_STATIC_ARTIFACTS,
  benchmarkStaticArtifactEvidenceFlags,
  selectBrowserBenchmarkRuntimeArtifacts,
  type BenchmarkRuntimeArtifactSelections,
} from "../artifact-selection.js";
import { withRejectingTimeout } from "../timeout.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const browserDir = resolve(__dirname, "../../apps/browser-demos");

declare global {
  interface Window {
    __runBenchmark: (
      suiteName: string,
      options?: { rounds?: number },
    ) => Promise<Record<string, number>>;
  }
}

/** Suites available in the browser benchmark page. */
const BROWSER_SUITES = [
  "syscall-io", "process-lifecycle", "wordpress",
  "mariadb-aria", "mariadb-aria-64",
  "mariadb-innodb", "mariadb-innodb-64",
];

const DISABLED_BROWSER_SUITES: Record<string, string> = {
  "erlang-ring": "disabled while the Erlang benchmark is unstable",
};

/** Per-suite timeout for page.evaluate (ms). Heavy suites like mariadb need longer. */
const SUITE_TIMEOUTS: Record<string, number> = {
  "syscall-io": 60_000,
  "process-lifecycle": 60_000,
  "wordpress": 300_000,
  "mariadb-aria": 600_000,
  "mariadb-aria-64": 600_000,
  "mariadb-innodb": 600_000,
  "mariadb-innodb-64": 600_000,
};

function assertBrowserArtifactsAvailable(
  runtimeSelections: BenchmarkRuntimeArtifactSelections,
  suiteNames: string[],
): void {
  const kernel = runtimeSelections.kernel;
  if (!kernel.selectedPath || !existsSync(kernel.selectedPath)) {
    throw new Error(
      "Browser benchmark prerequisite is missing: kernel.wasm.\n" +
      "The @kernel-wasm policy resolver found no usable artifact.\n" +
      "Run: bash build.sh",
    );
  }

  for (const artifact of BENCHMARK_STATIC_ARTIFACTS) {
    const used = benchmarkStaticArtifactEvidenceFlags({
      host: "browser",
      suiteFilter: suiteNames.length === 1 ? suiteNames[0] : undefined,
      artifact,
    }).used;
    if (used) {
      const selectedPath = resolve(browserDir, "../..", artifact.path);
      if (existsSync(selectedPath)) continue;
      throw new Error(
        `Browser benchmark prerequisite is missing: ${artifact.path}.\n` +
        "Run: scripts/build-programs.sh",
      );
    }
  }
}

export interface BrowserBenchmarkAssetSelection {
  publicPath: string;
  resolverRequest: string;
  resolverSelectedPath: string | null;
  selectedPath: string | null;
}

function materializePublicAsset(
  relBinaryPath: string,
  publicName: string,
): BrowserBenchmarkAssetSelection {
  const publicPath = resolve(browserDir, "public", publicName);
  if (existsSync(publicPath)) {
    return {
      publicPath,
      resolverRequest: relBinaryPath,
      resolverSelectedPath: null,
      selectedPath: publicPath,
    };
  }

  const sourcePath = tryResolveBinary(relBinaryPath);
  if (!sourcePath || !existsSync(sourcePath)) {
    return {
      publicPath,
      resolverRequest: relBinaryPath,
      resolverSelectedPath: sourcePath,
      selectedPath: null,
    };
  }

  mkdirSync(dirname(publicPath), { recursive: true });
  copyFileSync(sourcePath, publicPath);
  return {
    publicPath,
    resolverRequest: relBinaryPath,
    resolverSelectedPath: sourcePath,
    selectedPath: publicPath,
  };
}

export function prepareBrowserBenchmarkAssets(
  suiteNames: string[] = BROWSER_SUITES,
): Record<string, BrowserBenchmarkAssetSelection> {
  const selections: Record<string, BrowserBenchmarkAssetSelection> = {};
  if (suiteNames.includes("wordpress")) {
    selections["browser.wordpress.vfs"] = materializePublicAsset(
      "programs/wordpress.vfs.zst",
      "wordpress.vfs.zst",
    );
  }

  if (suiteNames.some((suite) => suite === "mariadb-aria" || suite === "mariadb-innodb")) {
    selections["browser.mariadb.wasm32.vfs"] = materializePublicAsset(
      "programs/mariadb-vfs.vfs.zst",
      "mariadb.vfs.zst",
    );
  }

  if (suiteNames.some((suite) => suite === "mariadb-aria-64" || suite === "mariadb-innodb-64")) {
    selections["browser.mariadb.wasm64.vfs"] = materializePublicAsset(
      "programs/wasm64/mariadb-vfs.vfs.zst",
      "mariadb-64.vfs.zst",
    );
  }

  return selections;
}

export interface BrowserBenchmarkOptions {
  suites?: string[];
  rounds?: number;
  runtimeSelections?: BenchmarkRuntimeArtifactSelections;
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
  const requestedSuiteNames = options.suites ?? BROWSER_SUITES;
  const rounds = options.rounds ?? 3;
  const results: Record<string, Record<string, number>> = {};
  const suiteNames: string[] = [];

  for (const suiteName of requestedSuiteNames) {
    const disabledReason = DISABLED_BROWSER_SUITES[suiteName];
    if (disabledReason) {
      console.warn(`  Suite "${suiteName}" disabled in browser, skipping (${disabledReason})`);
      results[suiteName] = {};
      continue;
    }

    if (!BROWSER_SUITES.includes(suiteName)) {
      console.warn(`  Suite "${suiteName}" not available in browser, skipping`);
      continue;
    }

    suiteNames.push(suiteName);
  }

  if (suiteNames.length === 0) {
    return results;
  }

  const runtimeSelections = options.runtimeSelections ??
    selectBrowserBenchmarkRuntimeArtifacts();
  assertBrowserArtifactsAvailable(runtimeSelections, suiteNames);
  prepareBrowserBenchmarkAssets(suiteNames);

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
    optimizeDeps: {
      entries: [resolve(browserDir, "pages/benchmark/index.html")],
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
      console.log(`\n--- ${suiteName} (browser) ---`);
      const roundResults: Record<string, number[]> = {};

      for (let r = 0; r < rounds; r++) {
        console.log(`  round ${r + 1}/${rounds}...`);
        const timeout = SUITE_TIMEOUTS[suiteName] ?? 120_000;
        const metrics = await withRejectingTimeout(
          page.evaluate(
            ([name, opts]) => window.__runBenchmark(name, opts),
            [suiteName, { rounds: 1 }] as const,
          ),
          timeout,
          `Browser benchmark ${suiteName} round ${r + 1}/${rounds} ` +
            `timed out after ${timeout}ms`,
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
