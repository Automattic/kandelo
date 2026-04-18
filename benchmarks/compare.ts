#!/usr/bin/env npx tsx
/**
 * Compare two benchmark result JSON files and output a markdown table.
 *
 * Usage:
 *   npx tsx benchmarks/compare.ts before.json after.json
 */
import { readFileSync } from "fs";
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
  if (process.argv.length < 4) {
    console.error("Usage: npx tsx benchmarks/compare.ts <before.json> <after.json>");
    process.exit(1);
  }

  const beforeFile = process.argv[2];
  const afterFile = process.argv[3];

  const before: BenchmarkOutput = JSON.parse(readFileSync(beforeFile, "utf-8"));
  const after: BenchmarkOutput = JSON.parse(readFileSync(afterFile, "utf-8"));

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
