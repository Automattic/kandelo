import { readFileSync } from "node:fs";
import process from "node:process";

import { resolveBinary } from "../../src/binary-resolver";
import { NodeKernelHost } from "../../src/node-kernel-host";

const MIB = 1024 * 1024;
const childPath = "/bin/process-memory-reclamation-churn";
const programPath = new URL(
  "./process-memory-reclamation-churn.wasm",
  import.meta.url,
);
const warmupChildren = Number(process.env.KANDELO_RECLAIM_WARMUP_CHILDREN ?? 4);
const waveChildren = Number(process.env.KANDELO_RECLAIM_WAVE_CHILDREN ?? 8);
const waveCount = Number(process.env.KANDELO_RECLAIM_WAVES ?? 6);
const childMiB = Number(process.env.KANDELO_RECLAIM_CHILD_MIB ?? 8);
const pressureBytes = Number(
  process.env.KANDELO_RECLAIM_PRESSURE_BYTES ?? 32 * MIB,
);

// Permit the dedicated kernel Worker to consume this test-only measurement
// control. Ordinary NodeKernelHost callers cannot alter the pressure default.
process.env.KANDELO_RECLAIM_MEASUREMENT = "1";

type MemorySample = {
  completedChildren: number;
  rssBytes: number;
};

function readArrayBuffer(path: string | URL): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilReaped(
  host: NodeKernelHost,
  pids: ReadonlySet<number>,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const maps = await Promise.all(
      [...pids].map((pid) => host.readProcMaps(pid)),
    );
    if (maps.every((entry) => entry === null)) {
      // The final root disappears only after its Worker has terminated and
      // host-owned process teardown has run. Give the notified waitAsync
      // reaction a few event-loop turns to release its native promise root.
      for (let turn = 0; turn < 4; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return;
    }
    await delay(10);
  }
  throw new Error(
    `process teardown did not reap pids: ${[...pids].join(", ")}`,
  );
}

function lateLinearSlope(samples: readonly MemorySample[]): number {
  const late = samples.slice(Math.max(1, Math.floor(samples.length / 3)));
  const xMean = late.reduce(
    (sum, sample) => sum + sample.completedChildren,
    0,
  ) / late.length;
  const yMean = late.reduce(
    (sum, sample) => sum + sample.rssBytes,
    0,
  ) / late.length;
  let covariance = 0;
  let variance = 0;
  for (const sample of late) {
    const dx = sample.completedChildren - xMean;
    covariance += dx * (sample.rssBytes - yMean);
    variance += dx * dx;
  }
  return variance === 0 ? 0 : covariance / variance;
}

async function main(): Promise<void> {
  if (typeof globalThis.gc === "function") {
    throw new Error("RSS reclamation must run without --expose-gc");
  }

  const program = readArrayBuffer(programPath);
  const stderr: string[] = [];
  const diagnostics: string[] = [];
  let currentPids = new Set<number>();
  const host = new NodeKernelHost({
    execPrograms: { [childPath]: programPath.pathname },
    rootfsImage: undefined,
    onStderr: (_pid, bytes) => {
      stderr.push(new TextDecoder().decode(bytes));
    },
    onHostDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic.message);
    },
    onProcessEvent: (event) => {
      if (event.kind === "spawn") currentPids.add(event.pid);
    },
  });

  const runWave = async (children: number): Promise<void> => {
    currentPids = new Set<number>();
    const exitCode = await host.spawn(program, [
      "process-memory-reclamation-churn",
      String(children),
      String(childMiB),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `churn exited ${exitCode}: ${stderr.join("") || "<no stderr>"}`,
      );
    }
    await waitUntilReaped(host, currentPids);
  };

  await host.init(readArrayBuffer(resolveBinary("kernel.wasm")));
  const samples: MemorySample[] = [];
  try {
    await runWave(warmupChildren);
    samples.push({
      completedChildren: 0,
      rssBytes: process.memoryUsage.rss(),
    });

    for (let wave = 1; wave <= waveCount; wave += 1) {
      await runWave(waveChildren);
      samples.push({
        completedChildren: wave * waveChildren,
        rssBytes: process.memoryUsage.rss(),
      });
    }
  } finally {
    await host.destroy();
  }

  const slopeBytesPerChild = lateLinearSlope(samples);
  const lateSamples = samples.slice(Math.max(1, Math.floor(samples.length / 3)));
  const lateGrowthBytes =
    lateSamples[lateSamples.length - 1]!.rssBytes - lateSamples[0]!.rssBytes;
  process.stdout.write(`${JSON.stringify({
    warmupChildren,
    waveChildren,
    waveCount,
    childMiB,
    pressureBytes,
    samples,
    slopeBytesPerChild,
    slopeMiBPerChild: slopeBytesPerChild / MIB,
    lateGrowthBytes,
    lateGrowthMiB: lateGrowthBytes / MIB,
    stderr,
    diagnostics,
  })}\n`);
}

await main();
