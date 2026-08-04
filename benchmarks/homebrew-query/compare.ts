#!/usr/bin/env -S npx tsx

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  HomebrewQueryBenchmarkResult,
  HomebrewQueryFixtureManifest,
} from "./contracts";

interface Options {
  beforePath: string;
  afterPath: string;
  maxRegressionPercent: number;
}

interface Comparison {
  metric: string;
  before: number;
  after: number;
  changePercent: number;
  regression: boolean;
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const before = readResult(options.beforePath);
  const after = readResult(options.afterPath);
  assertComparable(before, after);
  const comparisons = compareMedians(
    before.median,
    after.median,
    options.maxRegressionPercent,
  );

  process.stdout.write("| Metric | Before (ms) | After (ms) | Change |\n");
  process.stdout.write("|---|---:|---:|---:|\n");
  for (const comparison of comparisons) {
    const change = Number.isFinite(comparison.changePercent)
      ? `${comparison.changePercent >= 0 ? "+" : ""}` +
        `${comparison.changePercent.toFixed(1)}%`
      : "+infinity";
    process.stdout.write(
      `| ${comparison.metric} | ${comparison.before.toFixed(2)} | ` +
        `${comparison.after.toFixed(2)} | ` +
        `${comparison.regression ? `**${change}**` : change} |\n`,
    );
  }

  const regressions = comparisons.filter((comparison) => comparison.regression);
  if (regressions.length > 0) {
    process.stderr.write(
      `${regressions.length} Homebrew query metric(s) regressed by more than ` +
        `${options.maxRegressionPercent}%\n`,
    );
    process.exitCode = 1;
  }
}

export function compareMedians(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
  maxRegressionPercent: number,
): Comparison[] {
  if (!Number.isFinite(maxRegressionPercent) || maxRegressionPercent <= 0) {
    throw new Error("Homebrew regression threshold must be positive");
  }
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) {
    throw new Error("Homebrew benchmark results contain different metrics");
  }
  return beforeKeys.map((metric) => {
    const baseline = before[metric]!;
    const candidate = after[metric]!;
    if (
      !Number.isFinite(baseline) || baseline < 0 ||
      !Number.isFinite(candidate) || candidate < 0
    ) {
      throw new Error(`Homebrew benchmark metric ${metric} is invalid`);
    }
    const changePercent = baseline === 0
      ? (candidate === 0 ? 0 : Number.POSITIVE_INFINITY)
      : ((candidate - baseline) / baseline) * 100;
    return {
      metric,
      before: baseline,
      after: candidate,
      changePercent,
      regression: changePercent > maxRegressionPercent,
    };
  });
}

function readResult(path: string): HomebrewQueryBenchmarkResult {
  const value = JSON.parse(readFileSync(path, "utf-8")) as
    Partial<HomebrewQueryBenchmarkResult>;
  if (
    value.schema !== 1 ||
    value.kind !== "kandelo-homebrew-query-benchmark-result" ||
    (value.host !== "node" && value.host !== "chromium") ||
    typeof value.median !== "object" || value.median === null ||
    typeof value.fixture !== "object" || value.fixture === null
  ) {
    throw new Error(`Invalid Homebrew query benchmark result: ${path}`);
  }
  return value as HomebrewQueryBenchmarkResult;
}

function assertComparable(
  before: HomebrewQueryBenchmarkResult,
  after: HomebrewQueryBenchmarkResult,
): void {
  if (before.host !== after.host) {
    throw new Error(`Cannot compare ${before.host} with ${after.host}`);
  }
  const beforeIdentity = fixtureIdentity(before.fixture);
  const afterIdentity = fixtureIdentity(after.fixture);
  if (beforeIdentity !== afterIdentity) {
    throw new Error("Homebrew benchmark results used different input artifacts");
  }
}

function fixtureIdentity(fixture: HomebrewQueryFixtureManifest): string {
  return JSON.stringify({
    sourceCommit: fixture.sourceCommit,
    rootfs: fixture.rootfs,
    eagerRootfs: fixture.eagerRootfs,
    kernel: fixture.kernel,
    lazyUrlBase: fixture.lazyUrlBase,
    lazyAssets: fixture.lazyAssets,
    shell: fixture.shell,
    homebrew: fixture.homebrew,
    taps: fixture.taps,
    commands: fixture.commands,
    focusCommandId: fixture.focusCommandId,
  });
}

function parseOptions(argv: string[]): Options {
  const positional: string[] = [];
  let maxRegressionPercent = 25;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument.startsWith("--max-regression-percent=")) {
      maxRegressionPercent = Number(argument.slice(argument.indexOf("=") + 1));
    } else if (argument === "--max-regression-percent") {
      maxRegressionPercent = Number(argv[++index]);
    } else if (argument.startsWith("--")) {
      usage(`Unknown argument: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (positional.length !== 2) usage("Before and after result paths are required");
  if (!Number.isFinite(maxRegressionPercent) || maxRegressionPercent <= 0) {
    usage("--max-regression-percent must be positive");
  }
  return {
    beforePath: positional[0]!,
    afterPath: positional[1]!,
    maxRegressionPercent,
  };
}

function usage(message: string): never {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    "Usage: npx tsx benchmarks/homebrew-query/compare.ts " +
      "BEFORE.json AFTER.json [--max-regression-percent 25]\n",
  );
  process.exit(2);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1]!)).href) main();
