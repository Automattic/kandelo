import process from "node:process";

import { WASM_PAGE_SIZE } from "../../src/constants";
import { ProcessMemoryAllocator } from "../../src/process-memory";

const gc = globalThis.gc;
if (typeof gc !== "function") {
  throw new Error("retained-wrapper control requires --expose-gc");
}

const allocator = new ProcessMemoryAllocator({
  maxMemories: 2,
  maxTotalBytes: 8 * WASM_PAGE_SIZE,
  retirementAdmissionMemoryThreshold: 2,
  retirementAdmissionByteThreshold: 8 * WASM_PAGE_SIZE,
  retirementBackpressureMs: 0,
  maxRetirementTelemetryRecords: 8,
});

let retainedView: Uint8Array | undefined;

function retireGeneration(retainView: boolean): void {
  const lease = allocator.acquire({
    ptrWidth: 4,
    initialPages: 4,
    maximumPages: 4,
  });
  if (retainView) {
    retainedView = new Uint8Array(lease.memory.buffer);
    allocator.observeTarget(lease.memory, retainedView);
  }
  lease.release();
}

async function collectUntil(
  predicate: () => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (predicate()) return;
  }
  throw new Error(
    `${label}: ${JSON.stringify(allocator.getRetirementStats())}`,
  );
}

retireGeneration(false);
retireGeneration(true);
await collectUntil(
  () => allocator.getRetirementStats().observedFinalizations >= 1,
  "unretained generation was not observed as collectible",
);

const whileRetained = allocator.getRetirementStats();
if (whileRetained.observedFinalizations !== 1) {
  throw new Error(
    `retained typed-array wrapper did not block its generation: ${
      JSON.stringify(whileRetained)
    }`,
  );
}

// Dropping the exact wrapper must let the second generation produce the same
// telemetry. This is a negative control for the real churn tests: the
// observation path distinguishes an unreachable backing from one still rooted
// by a host view instead of declaring success merely because leases retired.
retainedView = undefined;
await collectUntil(
  () => allocator.getRetirementStats().observedFinalizations >= 2,
  "released retained generation was not observed as collectible",
);

process.stdout.write(`${JSON.stringify({
  whileRetained,
  afterRelease: allocator.getRetirementStats(),
})}\n`);
