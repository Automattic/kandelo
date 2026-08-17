#!/usr/bin/env npx tsx
/**
 * Benchmark runner CLI.
 *
 * Usage:
 *   npx tsx benchmarks/run.ts                        # All suites, Node.js
 *   npx tsx benchmarks/run.ts --host=browser         # All suites, browser
 *   npx tsx benchmarks/run.ts --suite=wordpress      # Single suite
 *   npx tsx benchmarks/run.ts --rounds=5             # Multiple rounds (median)
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "fs";
import { resolve, dirname, relative, sep } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import os from "os";
import type {
  BenchmarkArtifactFile,
  BenchmarkArtifactDirectory,
  BenchmarkArtifacts,
  BenchmarkOutput,
  ForkBenchSymbolReport,
  BenchmarkSuite,
} from "./types.js";
import type { BrowserBenchmarkAssetSelection } from "./browser/run-browser.js";
import {
  BENCHMARK_STATIC_ARTIFACTS,
  RUNNABLE_BENCHMARK_SUITES,
  benchmarkInputEvidenceFlags,
  benchmarkStaticArtifactEvidenceFlags,
  selectBrowserBenchmarkRuntimeArtifacts,
  selectNodeBenchmarkRuntimeArtifacts,
  type BenchmarkRuntimeArtifactSelections,
} from "./artifact-selection.js";
import { assertRequiredBenchmarkArtifacts } from "./artifact-evidence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

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

function runGit(args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

type ArtifactFileMetadata = Omit<
  Partial<BenchmarkArtifactFile>,
  "path" | "selectedPath" | "sizeBytes" | "sha256" | "missing"
>;

function repoRelativePath(path: string): string {
  const rel = relative(repoRoot, path);
  if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`)) {
    return rel.split(sep).join("/");
  }
  return path;
}

function fingerprintSelectedFile(
  logicalPath: string,
  selectedPath: string | null,
  metadata: ArtifactFileMetadata = {},
): BenchmarkArtifactFile {
  if (!selectedPath || !existsSync(selectedPath)) {
    return {
      path: logicalPath,
      ...(selectedPath ? { selectedPath } : {}),
      ...metadata,
      missing: true,
    };
  }

  try {
    const bytes = readFileSync(selectedPath);
    return {
      path: logicalPath,
      selectedPath,
      ...metadata,
      sizeBytes: statSync(selectedPath).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    return {
      path: logicalPath,
      selectedPath,
      ...metadata,
      missing: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function fingerprintDirectory(
  logicalPath: string,
  selectedPath: string,
  excludedPaths: string[],
): BenchmarkArtifactDirectory {
  const exclusions = [...excludedPaths].map((path) => path.replaceAll("\\", "/")).sort();
  if (!existsSync(selectedPath)) {
    return {
      path: logicalPath,
      selectedPath,
      missing: true,
      required: true,
      excludedPaths: exclusions,
    };
  }

  const hash = createHash("sha256");
  let fileCount = 0;
  let sizeBytes = 0;
  const activeDirectories = new Set<string>();

  const excluded = (logicalEntry: string): boolean => exclusions.some(
    (entry) => logicalEntry === entry || logicalEntry.startsWith(`${entry}/`),
  );
  const compareNames = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

  const hashFile = (physicalPath: string, logicalEntry: string, kind: string): void => {
    const bytes = readFileSync(physicalPath);
    hash.update(`${kind}\0${logicalEntry}\0${bytes.length}\0`);
    hash.update(bytes);
    hash.update("\0");
    fileCount++;
    sizeBytes += bytes.length;
  };

  const walk = (physicalDirectory: string, logicalDirectory: string): void => {
    const realDirectory = realpathSync(physicalDirectory);
    if (activeDirectories.has(realDirectory)) {
      hash.update(`cycle\0${logicalDirectory}\0`);
      return;
    }

    activeDirectories.add(realDirectory);
    try {
      const entries = readdirSync(physicalDirectory, { withFileTypes: true })
        .sort((a, b) => compareNames(a.name, b.name));
      for (const entry of entries) {
        const logicalEntry = logicalDirectory
          ? `${logicalDirectory}/${entry.name}`
          : entry.name;
        if (excluded(logicalEntry)) continue;

        const physicalEntry = resolve(physicalDirectory, entry.name);
        const stat = lstatSync(physicalEntry);
        if (stat.isSymbolicLink()) {
          const realEntry = realpathSync(physicalEntry);
          const targetStat = statSync(realEntry);
          if (targetStat.isDirectory()) {
            hash.update(`symlink-directory\0${logicalEntry}\0`);
            walk(realEntry, logicalEntry);
          } else if (targetStat.isFile()) {
            hashFile(realEntry, logicalEntry, "symlink-file");
          } else {
            hash.update(`symlink-other\0${logicalEntry}\0`);
          }
        } else if (stat.isDirectory()) {
          hash.update(`directory\0${logicalEntry}\0`);
          walk(physicalEntry, logicalEntry);
        } else if (stat.isFile()) {
          hashFile(physicalEntry, logicalEntry, "file");
        } else {
          hash.update(`other\0${logicalEntry}\0`);
        }
      }
    } finally {
      activeDirectories.delete(realDirectory);
    }
  };

  try {
    hash.update("kandelo-benchmark-directory-v1\0");
    walk(selectedPath, "");
    return {
      path: logicalPath,
      selectedPath,
      fileCount,
      sizeBytes,
      sha256: hash.digest("hex"),
      required: true,
      excludedPaths: exclusions,
    };
  } catch (error) {
    return {
      path: logicalPath,
      selectedPath,
      missing: true,
      required: true,
      excludedPaths: exclusions,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function expectedForkBenchSymbols(_gitHead: string): ForkBenchSymbolReport["expected"] {
  return "wpk_fork_without_legacy";
}

function inspectForkBench(gitHead: string): ForkBenchSymbolReport {
  const forkBenchPath = resolve(repoRoot, "benchmarks/wasm/fork-bench.wasm");
  if (!existsSync(forkBenchPath)) {
    return {
      hasWpkForkSymbols: false,
      hasLegacyForkSymbols: false,
      matchedSymbols: [],
      expected: expectedForkBenchSymbols(gitHead),
      passed: null,
    };
  }

  const text = readFileSync(forkBenchPath).toString("latin1");
  const matchedSymbols = Array.from(new Set(
    text.match(/[A-Za-z0-9_$./:-]*(?:wpk_fork|asyncify)[A-Za-z0-9_$./:-]*/g) ?? [],
  )).sort();
  const hasWpkForkSymbols = matchedSymbols.some((symbol) => symbol.includes("wpk_fork"));
  const hasLegacyForkSymbols = matchedSymbols.some((symbol) => symbol.includes("asyncify"));
  const expected = expectedForkBenchSymbols(gitHead);
  const passed = expected === "wpk_fork_without_legacy"
    ? hasWpkForkSymbols && !hasLegacyForkSymbols
    : null;

  return {
    hasWpkForkSymbols,
    hasLegacyForkSymbols,
    matchedSymbols,
    expected,
    passed,
  };
}

function suiteRequested(filter: string | undefined, names: string[]): boolean {
  return filter === undefined || names.includes(filter);
}

async function collectNodeApplicationArtifacts(
  suiteFilter: string | undefined,
  files: Record<string, BenchmarkArtifactFile>,
  directories: Record<string, BenchmarkArtifactDirectory>,
): Promise<void> {
  if (suiteRequested(suiteFilter, ["wordpress"])) {
    try {
      const { describeWordPressBenchmarkInputs } = await import("./suites/wordpress.js");
      const inputs = describeWordPressBenchmarkInputs();
      files["node.wordpress.php"] = fingerprintSelectedFile(
        inputs.phpResolverRequest,
        inputs.phpBinaryPath,
        {
          required: true,
          used: true,
          resolverRequest: inputs.phpResolverRequest,
          resolverSelectedPath: inputs.phpResolverSelectedPath ?? undefined,
        },
      );
      files["node.wordpress.opcache"] = fingerprintSelectedFile(
        inputs.opcacheResolverRequest,
        inputs.opcachePath,
        {
          required: false,
          used: inputs.opcacheUsed,
          resolverRequest: inputs.opcacheResolverRequest,
          resolverSelectedPath: inputs.opcachePath ?? undefined,
        },
      );
      files["node.wordpress.config"] = fingerprintSelectedFile(
        repoRelativePath(inputs.wpConfigPath),
        inputs.wpConfigPath,
        { required: true, used: true },
      );
      files["node.wordpress.router"] = fingerprintSelectedFile(
        repoRelativePath(inputs.routerScript),
        inputs.routerScript,
        { required: true, used: true },
      );
      directories["node.wordpress.sourceTree"] = fingerprintDirectory(
        repoRelativePath(inputs.wpDir),
        inputs.wpDir,
        [
          "wp-content/database",
          "wp-content/debug.log",
        ],
      );
    } catch (error) {
      files["node.wordpress.inputs"] = {
        path: "node WordPress benchmark inputs",
        missing: true,
        required: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const mariaArches = [
    {
      arch: "wasm32" as const,
      suites: ["mariadb-aria", "mariadb-innodb"],
    },
    {
      arch: "wasm64" as const,
      suites: ["mariadb-aria-64", "mariadb-innodb-64"],
    },
  ];
  for (const { arch, suites } of mariaArches) {
    if (!suiteRequested(suiteFilter, suites)) continue;

    try {
      const { describeMariaDBBenchmarkInputs } = await import("./suites/mariadb.js");
      const inputs = describeMariaDBBenchmarkInputs(arch);
      files[`node.mariadb.${arch}.server`] = fingerprintSelectedFile(
        inputs.serverResolverRequest,
        inputs.serverPath,
        {
          required: true,
          used: true,
          resolverRequest: inputs.serverResolverRequest,
          resolverSelectedPath: inputs.serverResolverSelectedPath ?? undefined,
        },
      );
      files[`node.mariadb.${arch}.client`] = fingerprintSelectedFile(
        inputs.clientResolverRequest,
        inputs.clientPath,
        {
          required: true,
          used: true,
          resolverRequest: inputs.clientResolverRequest,
          resolverSelectedPath: inputs.clientResolverSelectedPath ?? undefined,
        },
      );

      const sqlError = inputs.bootstrapSqlError;
      files[`node.mariadb.${arch}.bootstrap.systemTables`] = fingerprintSelectedFile(
        inputs.bootstrapSql
          ? repoRelativePath(inputs.bootstrapSql.systemTables)
          : `${arch} MariaDB system-tables bootstrap SQL`,
        inputs.bootstrapSql?.systemTables ?? null,
        { required: true, used: true, ...(sqlError ? { error: sqlError } : {}) },
      );
      files[`node.mariadb.${arch}.bootstrap.systemData`] = fingerprintSelectedFile(
        inputs.bootstrapSql
          ? repoRelativePath(inputs.bootstrapSql.systemData)
          : `${arch} MariaDB system-data bootstrap SQL`,
        inputs.bootstrapSql?.systemData ?? null,
        { required: true, used: true, ...(sqlError ? { error: sqlError } : {}) },
      );
    } catch (error) {
      files[`node.mariadb.${arch}.inputs`] = {
        path: `node MariaDB ${arch} benchmark inputs`,
        missing: true,
        required: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function collectBrowserApplicationArtifacts(
  selections: Record<string, BrowserBenchmarkAssetSelection>,
  files: Record<string, BenchmarkArtifactFile>,
): void {
  for (const [name, selection] of Object.entries(selections)) {
    files[name] = fingerprintSelectedFile(
      repoRelativePath(selection.publicPath),
      selection.selectedPath,
      {
        required: true,
        used: true,
        resolverRequest: selection.resolverRequest,
        resolverSelectedPath: selection.resolverSelectedPath ?? undefined,
      },
    );
  }
}

function collectRuntimeArtifacts(
  selections: BenchmarkRuntimeArtifactSelections,
  files: Record<string, BenchmarkArtifactFile>,
  options: { host: "node" | "browser"; suiteFilter?: string },
): void {
  for (const [name, selection] of Object.entries(selections)) {
    const evidenceFlags = benchmarkInputEvidenceFlags({
      ...options,
      suites: name === "rootfs"
        ? ["syscall-io", "process-lifecycle"]
        : RUNNABLE_BENCHMARK_SUITES,
      ...(name === "rootfs" ? { hosts: ["node" as const] } : {}),
    });
    files[`runtime.${name}`] = fingerprintSelectedFile(
      selection.logicalPath,
      selection.selectedPath,
      {
        ...evidenceFlags,
        ...(selection.resolverRequest
          ? { resolverRequest: selection.resolverRequest }
          : {}),
        ...(selection.resolverSelectedPath
          ? { resolverSelectedPath: selection.resolverSelectedPath }
          : {}),
        ...(selection.error ? { error: selection.error } : {}),
      },
    );
  }
}

export async function collectBenchmarkArtifacts(options: {
  host: "node" | "browser";
  suiteFilter?: string;
  browserSelections?: Record<string, BrowserBenchmarkAssetSelection>;
  runtimeSelections?: BenchmarkRuntimeArtifactSelections;
}): Promise<BenchmarkArtifacts> {
  const gitHead = runGit(["rev-parse", "HEAD"]);
  const gitRef = runGit(["name-rev", "--name-only", "--refs=refs/remotes/origin/*", "HEAD"]);
  const files: Record<string, BenchmarkArtifactFile> = Object.fromEntries(
    BENCHMARK_STATIC_ARTIFACTS.map((artifact) => {
      const evidenceFlags = benchmarkStaticArtifactEvidenceFlags({
        host: options.host,
        suiteFilter: options.suiteFilter,
        artifact,
      });
      return [
        artifact.path,
        fingerprintSelectedFile(
          artifact.path,
          resolve(repoRoot, artifact.path),
          evidenceFlags,
        ),
      ];
    }),
  );
  const directories: Record<string, BenchmarkArtifactDirectory> = {};
  const runtimeSelections = options.runtimeSelections ?? (
    options.host === "node"
      ? selectNodeBenchmarkRuntimeArtifacts()
      : selectBrowserBenchmarkRuntimeArtifacts()
  );
  collectRuntimeArtifacts(runtimeSelections, files, options);

  if (options.host === "node") {
    await collectNodeApplicationArtifacts(options.suiteFilter, files, directories);
  } else if (options.browserSelections) {
    collectBrowserApplicationArtifacts(options.browserSelections, files);
  }

  return {
    gitHead,
    gitRef,
    files,
    ...(Object.keys(directories).length > 0 ? { directories } : {}),
    forkBench: inspectForkBench(gitHead),
  };
}

function logArtifacts(artifacts: BenchmarkArtifacts) {
  console.log("\nArtifact fingerprints:");
  console.log(`  git HEAD: ${artifacts.gitHead} (${artifacts.gitRef})`);
  for (const [name, artifact] of Object.entries(artifacts.files)) {
    const label = name === artifact.path ? artifact.path : `${name} (${artifact.path})`;
    const selected = artifact.selectedPath ? ` selected=${artifact.selectedPath}` : "";
    const resolver = artifact.resolverSelectedPath
      ? ` resolver-selected=${artifact.resolverSelectedPath}`
      : "";
    const usage = artifact.used === false ? " used=false" : "";
    if (artifact.missing) {
      const required = artifact.required ? " REQUIRED" : "";
      console.log(`  ${label}: MISSING${required}${usage}${selected}${resolver}`);
      if (artifact.error) console.log(`    error: ${artifact.error}`);
    } else {
      console.log(
        `  ${label}: ${artifact.sizeBytes} bytes sha256=${artifact.sha256}` +
        `${usage}${selected}${resolver}`,
      );
    }
  }
  for (const [name, artifact] of Object.entries(artifacts.directories ?? {})) {
    const label = name === artifact.path ? artifact.path : `${name} (${artifact.path})`;
    if (artifact.missing) {
      console.log(`  ${label}: MISSING${artifact.required ? " REQUIRED" : ""}`);
      if (artifact.error) console.log(`    error: ${artifact.error}`);
    } else {
      console.log(
        `  ${label}: ${artifact.fileCount} files ${artifact.sizeBytes} bytes ` +
        `sha256=${artifact.sha256} selected=${artifact.selectedPath}`,
      );
      if (artifact.excludedPaths?.length) {
        console.log(`    excluded runtime state: ${artifact.excludedPaths.join(", ")}`);
      }
    }
  }
  console.log(
    `  fork-bench symbols: expected=${artifacts.forkBench.expected} ` +
    `wpk_fork=${artifacts.forkBench.hasWpkForkSymbols} ` +
    `legacy_fork=${artifacts.forkBench.hasLegacyForkSymbols} ` +
    `passed=${artifacts.forkBench.passed}`,
  );
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

const DISABLED_SUITES: Record<string, string> = {
  "erlang-ring": "disabled while the Erlang benchmark is unstable",
};

async function loadNodeSuites(filter?: string): Promise<BenchmarkSuite[]> {
  const names = filter
    ? [filter]
    : Object.keys(SUITE_MODULES).filter((name) => !(name in DISABLED_SUITES));
  const suites: BenchmarkSuite[] = [];

  for (const name of names) {
    const disabledReason = DISABLED_SUITES[name];
    if (disabledReason) {
      console.warn(`Skipping suite "${name}" (${disabledReason})`);
      if (filter) {
        suites.push({
          name,
          async run(): Promise<Record<string, number>> {
            console.warn(`  Skipping ${name}: ${disabledReason}`);
            return {};
          },
        });
      }
      continue;
    }

    const modPath = SUITE_MODULES[name];
    if (!modPath) {
      const available = Object.keys(SUITE_MODULES)
        .filter((suiteName) => !(suiteName in DISABLED_SUITES));
      console.error(`Suite "${name}" not found. Available: ${available.join(", ")}`);
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
    const {
      prepareBrowserBenchmarkAssets,
      runBrowserBenchmarks,
    } = await import("./browser/run-browser.js");
    const suiteNames = suiteFilter ? [suiteFilter] : undefined;
    const runtimeSelections = selectBrowserBenchmarkRuntimeArtifacts();
    const browserSelections = prepareBrowserBenchmarkAssets(suiteNames);
    const artifacts = await collectBenchmarkArtifacts({
      host,
      suiteFilter,
      browserSelections,
      runtimeSelections,
    });
    logArtifacts(artifacts);
    assertRequiredBenchmarkArtifacts(artifacts);
    const results = await runBrowserBenchmarks({
      suites: suiteNames,
      rounds,
      runtimeSelections,
    });

    const output: BenchmarkOutput = {
      timestamp: new Date().toISOString(),
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      host: "browser",
      rounds,
      artifacts,
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
  const artifacts = await collectBenchmarkArtifacts({ host, suiteFilter });
  logArtifacts(artifacts);
  assertRequiredBenchmarkArtifacts(artifacts);
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
    artifacts,
    suites: results,
  };

  const resultsDir = resolve(__dirname, "results");
  mkdirSync(resultsDir, { recursive: true });
  const filename = `benchmark-node-${Date.now()}.json`;
  const filepath = resolve(resultsDir, filename);
  writeFileSync(filepath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nResults saved to ${filepath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
