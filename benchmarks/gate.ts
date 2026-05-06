#!/usr/bin/env npx tsx
/**
 * Compare two benchmark JSON outputs and gate on regression / missing suite.
 *
 * Used by .github/workflows/benchmarks.yml. Prints a markdown table to stdout
 * (suitable for posting as a PR comment), and exits non-zero when either:
 *   - any metric regresses by more than --threshold percent, or
 *   - a suite expected on both sides has zero metrics on either side
 *     (i.e. the suite silently skipped — treated as "broken at baseline").
 *
 * Usage:
 *   npx tsx benchmarks/gate.ts \
 *     --before path/to/before.json \
 *     --after  path/to/after.json \
 *     --expected syscall-io,process-lifecycle,... \
 *     --threshold 5
 */
import { readFileSync } from "fs";
import type { BenchmarkOutput } from "./types.js";

interface Args {
  before: string;
  after: string;
  expected: string[];
  threshold: number;
  label: string;
}

function parseArgs(argv: string[]): Args {
  let before = "";
  let after = "";
  let expected: string[] = [];
  let threshold = 5;
  let label = "";

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--before") before = args[++i];
    else if (a === "--after") after = args[++i];
    else if (a === "--expected") expected = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--threshold") threshold = parseFloat(args[++i]);
    else if (a === "--label") label = args[++i];
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  if (!before || !after || expected.length === 0) {
    console.error("Usage: gate.ts --before X --after Y --expected a,b,c [--threshold 5] [--label name]");
    process.exit(2);
  }
  return { before, after, expected, threshold, label };
}

const HIGHER_IS_BETTER = new Set([
  "messages_per_sec",
  "pipe_mbps",
  "file_write_mbps",
  "file_read_mbps",
]);

function isRegression(metricName: string, pctChange: number, threshold: number): boolean {
  if (HIGHER_IS_BETTER.has(metricName)) return pctChange < -threshold;
  return pctChange > threshold;
}

function flatten(suites: Record<string, Record<string, number>>): Record<string, number> {
  const flat: Record<string, number> = {};
  for (const [s, metrics] of Object.entries(suites)) {
    for (const [k, v] of Object.entries(metrics)) flat[`${s}/${k}`] = v;
  }
  return flat;
}

function main() {
  const { before, after, expected, threshold, label } = parseArgs(process.argv);

  const beforeOut: BenchmarkOutput = JSON.parse(readFileSync(before, "utf-8"));
  const afterOut: BenchmarkOutput = JSON.parse(readFileSync(after, "utf-8"));

  // Hard-fail on missing/silent-skip suites (suite present but empty).
  const missing: { side: "before" | "after"; suite: string }[] = [];
  for (const s of expected) {
    const beforeMetrics = beforeOut.suites[s];
    const afterMetrics = afterOut.suites[s];
    if (!beforeMetrics || Object.keys(beforeMetrics).length === 0) missing.push({ side: "before", suite: s });
    if (!afterMetrics || Object.keys(afterMetrics).length === 0) missing.push({ side: "after", suite: s });
  }

  const beforeFlat = flatten(beforeOut.suites);
  const afterFlat = flatten(afterOut.suites);
  const allKeys = [...new Set([...Object.keys(beforeFlat), ...Object.keys(afterFlat)])].sort();

  // Markdown table — written to stdout for the workflow to capture.
  if (label) console.log(`### ${label}\n`);
  console.log("| Benchmark | Before | After | Change |");
  console.log("|-----------|--------|-------|--------|");

  const regressions: { key: string; pct: number }[] = [];
  for (const key of allKeys) {
    const b = beforeFlat[key];
    const a = afterFlat[key];
    if (b == null && a != null) { console.log(`| ${key} | — | ${a} | new |`); continue; }
    if (b != null && a == null) { console.log(`| ${key} | ${b} | — | removed |`); continue; }

    const pct = b === 0 ? 0 : ((a - b) / b) * 100;
    const sign = pct > 0 ? "+" : "";
    const pctStr = `${sign}${pct.toFixed(1)}%`;
    const metric = key.split("/").pop() || "";
    const reg = isRegression(metric, pct, threshold);
    if (reg) regressions.push({ key, pct });
    console.log(`| ${key} | ${b} | ${a} | ${reg ? `**${pctStr}**` : pctStr} |`);
  }

  console.log("");
  if (missing.length > 0) {
    console.log(`**Missing suites (silent skip — hard fail):**`);
    for (const m of missing) console.log(`- \`${m.suite}\` (${m.side})`);
    console.log("");
  }
  if (regressions.length > 0) {
    console.log(`**Regressions > ${threshold}%:**`);
    for (const r of regressions) console.log(`- \`${r.key}\`: ${r.pct.toFixed(1)}%`);
    console.log("");
  }

  const fail = missing.length > 0 || regressions.length > 0;
  if (fail) {
    console.error(
      `gate: FAIL (${missing.length} missing, ${regressions.length} regression${regressions.length === 1 ? "" : "s"})`,
    );
    process.exit(1);
  }
  console.error("gate: PASS");
}

main();
