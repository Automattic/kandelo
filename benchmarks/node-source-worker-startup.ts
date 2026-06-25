#!/usr/bin/env npx tsx
/**
 * Compare Node's source-checkout worker bundle with the prior per-worker tsx
 * loader. This benchmark intentionally bypasses the bundle resolver for its
 * baseline so both paths run from the same checkout and worker source.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  NodeWorkerAdapter,
  type WorkerHandle,
} from "../host/src/worker-adapter";

type Mode = "bundle" | "tsx";

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, received ${raw}`);
  }
  return parsed;
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function waitForMessage(handle: WorkerHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("worker did not reply within five seconds")),
      5_000,
    );
    handle.on("message", () => {
      clearTimeout(timeout);
      resolve();
    });
    handle.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    handle.on("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`worker exited ${code}`));
      }
    });
  });
}

async function runMode(
  mode: Mode,
  entry: URL,
  workers: number,
): Promise<number> {
  const adapter = new NodeWorkerAdapter(entry);
  if (mode === "tsx") {
    // WHY: returning null reproduces the source-checkout load order before the
    // bundle path existed while leaving every other Worker option identical.
    (
      adapter as unknown as {
        resolveBundledSourceEntry: () => null;
      }
    ).resolveBundledSourceEntry = () => null;
  }

  try {
    const start = performance.now();
    for (let index = 0; index < workers; index++) {
      const handle = adapter.createWorker({ index });
      try {
        await waitForMessage(handle);
      } finally {
        await handle.terminate().catch(() => undefined);
      }
    }
    return performance.now() - start;
  } finally {
    const bundledEntry = (
      adapter as unknown as { _bundledSourceEntry?: URL | false }
    )._bundledSourceEntry;
    if (bundledEntry instanceof URL) {
      rmSync(dirname(fileURLToPath(bundledEntry)), {
        recursive: true,
        force: true,
      });
    }
  }
}

const trials = positiveInteger(option("trials"), 3);
const workers = positiveInteger(option("workers"), 8);
const sourceDir = mkdtempSync(join(tmpdir(), "kandelo-worker-benchmark-"));
const entryPath = join(sourceDir, "ready.ts");
writeFileSync(
  entryPath,
  [
    'import { parentPort, workerData } from "node:worker_threads";',
    "parentPort?.postMessage(workerData);",
  ].join("\n"),
);

const measurements: Record<Mode, number[]> = { bundle: [], tsx: [] };
try {
  const entry = pathToFileURL(entryPath);
  for (let trial = 0; trial < trials; trial++) {
    const order: readonly Mode[] = trial % 2 === 0
      ? ["tsx", "bundle"]
      : ["bundle", "tsx"];
    for (const mode of order) {
      measurements[mode].push(await runMode(mode, entry, workers));
    }
  }
} finally {
  rmSync(sourceDir, { recursive: true, force: true });
}

const tsxMedianMs = median(measurements.tsx);
const bundleMedianMs = median(measurements.bundle);
console.log(JSON.stringify({
  schema: 1,
  measuredAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpu: cpus()[0]?.model ?? "unknown",
  trials,
  workersPerTrial: workers,
  includesOneTimeBundleCost: true,
  tsxMs: measurements.tsx.map((value) => Number(value.toFixed(1))),
  bundleMs: measurements.bundle.map((value) => Number(value.toFixed(1))),
  tsxMedianMs: Number(tsxMedianMs.toFixed(1)),
  bundleMedianMs: Number(bundleMedianMs.toFixed(1)),
  medianRatio: Number((tsxMedianMs / bundleMedianMs).toFixed(2)),
}, null, 2));
