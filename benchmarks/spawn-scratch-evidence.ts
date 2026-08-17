import {
  SPAWN_WIRE_HEADER_BYTES,
  SPAWN_WIRE_STRING_OFFSET_BYTES,
} from "../host/src/generated/abi.js";

const LARGE_ENV_COUNT = 84;
const LARGE_ENV_ENTRY_BYTES = 1000;
const LARGE_ARG_COUNT = 1;
const LARGE_ARG_STRING_BYTES = "hello".length + 1;

export const SPAWN_SCRATCH_LARGE_WIRE_BYTES =
  SPAWN_WIRE_HEADER_BYTES
  + SPAWN_WIRE_STRING_OFFSET_BYTES * (LARGE_ARG_COUNT + LARGE_ENV_COUNT)
  + LARGE_ARG_STRING_BYTES
  + LARGE_ENV_COUNT * LARGE_ENV_ENTRY_BYTES;

const TIMING_KEYS = [
  "spawn_ms",
  "spawn_large_first_ms",
  "spawn_large_repeat_ms",
] as const;

function parseMetrics(stdout: string): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const match = line.match(/^(\w+)=([\d.eE+-]+)$/);
    if (match) {
      metrics[match[1]] = Number(match[2]);
    }
  }
  return metrics;
}

function requireNonnegativeFinite(
  value: number | undefined,
  label: string,
): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    throw new Error(`spawn-bench returned invalid ${label}: ${String(value)}`);
  }
  return value;
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`spawn-bench returned invalid ${label}: ${String(value)}`);
  }
  return value;
}

export function collectSpawnScratchEvidence(options: {
  stdout: string;
  retainedCapacity: number;
  kernelMemoryPages: number;
}): Record<string, number> {
  const metrics = parseMetrics(options.stdout);
  for (const key of TIMING_KEYS) {
    requireNonnegativeFinite(metrics[key], key);
  }

  const reportedWireBytes = requirePositiveSafeInteger(
    metrics.spawn_large_wire_bytes,
    "spawn_large_wire_bytes",
  );
  if (reportedWireBytes !== SPAWN_SCRATCH_LARGE_WIRE_BYTES) {
    throw new Error(
      "spawn-bench large wire size drifted: " +
      `expected ${SPAWN_SCRATCH_LARGE_WIRE_BYTES}, got ${reportedWireBytes}`,
    );
  }

  const retainedCapacity = requirePositiveSafeInteger(
    options.retainedCapacity,
    "retained scratch capacity",
  );
  if (retainedCapacity < SPAWN_SCRATCH_LARGE_WIRE_BYTES) {
    throw new Error(
      "spawn-bench did not retain enough scratch for the exercised large blob: " +
      `${retainedCapacity} < ${SPAWN_SCRATCH_LARGE_WIRE_BYTES}`,
    );
  }
  const kernelMemoryPages = requirePositiveSafeInteger(
    options.kernelMemoryPages,
    "kernel memory pages",
  );
  const kernelMemoryBytes = kernelMemoryPages * 65_536;
  if (!Number.isSafeInteger(kernelMemoryBytes)) {
    throw new Error(
      `spawn-bench kernel memory byte count is unsafe: ${kernelMemoryBytes}`,
    );
  }

  return {
    ...metrics,
    spawn_scratch_retained_bytes: retainedCapacity,
    spawn_scratch_kernel_bytes: kernelMemoryBytes,
  };
}
