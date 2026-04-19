#!/usr/bin/env npx tsx
/**
 * Benchmark runner CLI.
 *
 * Usage:
 *   npx tsx benchmarks/run.ts                        # All suites, Node.js
 *   npx tsx benchmarks/run.ts --host=browser         # All suites, browser
 *   npx tsx benchmarks/run.ts --suite=erlang-ring    # Single suite
 *   npx tsx benchmarks/run.ts --rounds=5             # Multiple rounds (median)
 */
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import os from "os";
import type { BenchmarkSuite, BenchmarkOutput } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { host: "node" | "browser"; suite?: string; rounds: number } {
  let host: "node" | "browser" = "node";
  let suite: string | undefined;
  let rounds = 3;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--host=")) {
      const v = arg.slice(7);
      if (v !== "node" && v !== "browser") {
        console.error(`Invalid host: ${v}. Must be "node" or "browser".`);
        process.exit(1);
      }
      host = v;
    } else if (arg === "--host") {
      const v = args[++i];
      if (v !== "node" && v !== "browser") {
        console.error(`Invalid host: ${v}. Must be "node" or "browser".`);
        process.exit(1);
      }
      host = v;
    } else if (arg.startsWith("--suite=")) {
      suite = arg.slice(8);
    } else if (arg === "--suite") {
      suite = args[++i];
    } else if (arg.startsWith("--rounds=")) {
      rounds = parseInt(arg.slice(9), 10);
      if (isNaN(rounds) || rounds < 1) {
        console.error("--rounds must be a positive integer.");
        process.exit(1);
      }
    } else if (arg === "--rounds") {
      rounds = parseInt(args[++i], 10);
      if (isNaN(rounds) || rounds < 1) {
        console.error("--rounds must be a positive integer.");
        process.exit(1);
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npx tsx benchmarks/run.ts [options]

Options:
  --host=node|browser   Execution host (default: node)
  --suite=<name>        Run a single suite
  --rounds=<n>          Number of rounds per suite (default: 3, reports median)
`);
      process.exit(0);
    }
  }

  return { host, suite, rounds };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Suite name → module path. Loaded lazily so missing suites don't block others. */
const SUITE_MODULES: Record<string, string> = {
  "syscall-io": "./suites/syscall-io.js",
  "process-lifecycle": "./suites/process-lifecycle.js",
  "erlang-ring": "./suites/erlang-ring.js",
  "wordpress": "./suites/wordpress.js",
  "mariadb-aria": "./suites/mariadb-aria.js",
  "mariadb-aria-64": "./suites/mariadb-aria-64.js",
  "mariadb-innodb": "./suites/mariadb-innodb.js",
  "mariadb-innodb-64": "./suites/mariadb-innodb-64.js",
};

async function loadNodeSuites(filter?: string): Promise<BenchmarkSuite[]> {
  const names = filter ? [filter] : Object.keys(SUITE_MODULES);
  const suites: BenchmarkSuite[] = [];

  for (const name of names) {
    const modPath = SUITE_MODULES[name];
    if (!modPath) {
      console.error(`Suite "${name}" not found. Available: ${Object.keys(SUITE_MODULES).join(", ")}`);
      process.exit(1);
    }
    try {
      const mod = await import(modPath);
      suites.push(mod.default as BenchmarkSuite);
    } catch (err: any) {
      if (err.code === "ERR_MODULE_NOT_FOUND") {
        console.warn(`Skipping suite "${name}" (not yet implemented)`);
      } else {
        throw err;
      }
    }
  }

  return suites;
}

async function runSuites(
  suites: BenchmarkSuite[],
  rounds: number,
): Promise<Record<string, Record<string, number>>> {
  const results: Record<string, Record<string, number>> = {};

  for (const suite of suites) {
    console.log(`\n--- ${suite.name} ---`);
    const roundResults: Record<string, number[]> = {};

    for (let r = 0; r < rounds; r++) {
      console.log(`  round ${r + 1}/${rounds}...`);
      const metrics = await suite.run();

      for (const [key, value] of Object.entries(metrics)) {
        if (!roundResults[key]) roundResults[key] = [];
        roundResults[key].push(value);
      }
    }

    // Compute median for each metric
    const suiteResult: Record<string, number> = {};
    for (const [key, values] of Object.entries(roundResults)) {
      suiteResult[key] = Math.round(median(values) * 100) / 100;
    }
    results[suite.name] = suiteResult;

    // Print inline
    for (const [key, value] of Object.entries(suiteResult)) {
      console.log(`  ${key}: ${value}`);
    }
  }

  return results;
}

async function main() {
  const { host, suite: suiteFilter, rounds } = parseArgs(process.argv);

  if (host === "browser") {
    // Browser execution via Playwright
    const { runBrowserBenchmarks } = await import("./browser/run-browser.js");
    const suiteNames = suiteFilter ? [suiteFilter] : undefined;
    const results = await runBrowserBenchmarks({ suites: suiteNames, rounds });

    const output: BenchmarkOutput = {
      timestamp: new Date().toISOString(),
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      host: "browser",
      rounds,
      suites: results,
    };

    const resultsDir = resolve(__dirname, "results");
    mkdirSync(resultsDir, { recursive: true });
    const filename = `benchmark-browser-${Date.now()}.json`;
    const filepath = resolve(resultsDir, filename);
    writeFileSync(filepath, JSON.stringify(output, null, 2) + "\n");
    console.log(`\nResults saved to ${filepath}`);
    return;
  }

  // Node.js execution
  const suites = await loadNodeSuites(suiteFilter);
  if (suites.length === 0) {
    console.error("No suites available to run.");
    process.exit(1);
  }

  console.log(`Running ${suites.length} suite(s), ${rounds} round(s) each (Node.js)`);
  const results = await runSuites(suites, rounds);

  const output: BenchmarkOutput = {
    timestamp: new Date().toISOString(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    host: "node",
    rounds,
    suites: results,
  };

  const resultsDir = resolve(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });
  const filename = `benchmark-node-${Date.now()}.json`;
  const filepath = resolve(resultsDir, filename);
  writeFileSync(filepath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nResults saved to ${filepath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
