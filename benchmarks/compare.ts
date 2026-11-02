#!/usr/bin/env npx tsx
/**
 * Compare two benchmark result JSON files and output a markdown table.
 *
 * Usage:
 *   npx tsx benchmarks/compare.ts before.json after.json [--allow-mixed-kernel-worker]
 *
 * Refuses a Node pair whose sides ran different kernel worker paths
 * (bundled vs tsx), unless --allow-mixed-kernel-worker says that is the
 * comparison being made.
 */
import { readFileSync } from "fs";
import { compareBenchmarkKernelWorkers } from "./host-worker-path.js";
import type { BenchmarkOutput } from "./types.js";

function flatten(suites: Record<string, Record<string, number>>): Record<string, number> {
  const flat: Record<string, number> = {};
  for (const [suite, metrics] of Object.entries(suites)) {
    for (const [key, value] of Object.entries(metrics)) {
      flat[`${suite}/${key}`] = value;
    }
  }
  return flat;
}

/** Metrics where higher is better (throughput). */
const HIGHER_IS_BETTER = new Set([
  "messages_per_sec",
  "pipe_mbps",
  "file_write_mbps",
  "file_read_mbps",
  "stdin_mbps",
]);

function isRegression(key: string, pctChange: number): boolean {
  const metricName = key.split("/").pop() || "";
  if (HIGHER_IS_BETTER.has(metricName)) {
    // For throughput metrics, a decrease is a regression
    return pctChange < -5;
  }
  // For latency/duration metrics, an increase is a regression
  return pctChange > 5;
}

function main() {
  const allowMixed = process.argv.includes("--allow-mixed-kernel-worker");
  const files = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (files.length < 2) {
    console.error(
      "Usage: npx tsx benchmarks/compare.ts <before.json> <after.json> [--allow-mixed-kernel-worker]",
    );
    process.exit(1);
  }

  const [beforeFile, afterFile] = files;

  const before: BenchmarkOutput = JSON.parse(readFileSync(beforeFile, "utf-8"));
  const after: BenchmarkOutput = JSON.parse(readFileSync(afterFile, "utf-8"));

  const workers = compareBenchmarkKernelWorkers(before, after);
  for (const warning of workers.warnings) console.error(`warning: ${warning}`);
  if (workers.error) {
    if (!allowMixed) {
      console.error(`error: ${workers.error}`);
      console.error("Pass --allow-mixed-kernel-worker if that is the comparison you intend.");
      process.exit(1);
    }
    console.error(`warning: ${workers.error}`);
  }
  for (const note of workers.notes) console.log(`${note}  `);
  if (workers.notes.length > 0) console.log("");

  const beforeFlat = flatten(before.suites);
  const afterFlat = flatten(after.suites);

  // Collect all keys from both
  const allKeys = new Set([...Object.keys(beforeFlat), ...Object.keys(afterFlat)]);
  const sortedKeys = [...allKeys].sort();

  console.log("| Benchmark | Before | After | Change |");
  console.log("|-----------|--------|-------|--------|");

  for (const key of sortedKeys) {
    const bVal = beforeFlat[key];
    const aVal = afterFlat[key];

    if (bVal == null && aVal != null) {
      console.log(`| ${key} | — | ${aVal} | new |`);
      continue;
    }
    if (bVal != null && aVal == null) {
      console.log(`| ${key} | ${bVal} | — | removed |`);
      continue;
    }

    const pctChange = bVal === 0 ? 0 : ((aVal - bVal) / bVal) * 100;
    const sign = pctChange > 0 ? "+" : "";
    const pctStr = `${sign}${pctChange.toFixed(1)}%`;

    const regression = isRegression(key, pctChange);
    const changeCell = regression ? `**${pctStr}**` : pctStr;

    console.log(`| ${key} | ${bVal} | ${aVal} | ${changeCell} |`);
  }
}

main();
