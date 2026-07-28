import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS } from "../src/generated/abi";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ABI_43_RESERVATION_EXPORTS = [
  "kernel_blocking_retry_release",
  "kernel_blocking_retry_token",
  "kernel_spawn_reserved_process",
  "kernel_spawn_scratch_begin",
  "kernel_spawn_scratch_cancel",
  "kernel_spawn_scratch_capacity",
  "kernel_spawn_scratch_pointer",
  "kernel_spawn_scratch_retained_capacity",
  "kernel_transfer_channel_execute",
  "kernel_transfer_io_execute",
  "kernel_transfer_scratch_begin",
  "kernel_transfer_scratch_cancel",
  "kernel_transfer_scratch_capacity",
  "kernel_transfer_scratch_pointer",
] as const;
const ABI_43_CAPACITY_PREFLIGHT_EXPORTS = [
  "kernel_mq_descriptor_msgsize",
] as const;

function continuedShellWords(source: string, firstLine: string): string[] {
  const lines = source.split("\n");
  const start = lines.indexOf(firstLine);
  expect(start).toBeGreaterThanOrEqual(0);
  const words: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const continued = line.endsWith(" \\");
    const word = (continued ? line.slice(0, -2) : line).trim();
    expect(word).toMatch(/^[A-Za-z0-9_]+$/);
    words.push(word);
    if (!continued) break;
  }
  return words;
}

function shellArrayWords(source: string, assignment: string): string[] {
  const lines = source.split("\n");
  const start = lines.indexOf(`${assignment}=(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const words: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const word = line.trim();
    if (word === ")") return words;
    expect(word).toMatch(/^[A-Za-z0-9_]+$/);
    words.push(word);
  }
  throw new Error(`unterminated shell array ${assignment}`);
}

describe("kernel reservation export contract", () => {
  it("makes the complete ABI 43 reservation protocol mandatory", () => {
    const buildGuard = readFileSync(
      join(repoRoot, "packages", "registry", "kernel", "build-kernel.sh"),
      "utf8",
    );
    const runtimeGuard = readFileSync(join(repoRoot, "run.sh"), "utf8");
    const guardedExports = continuedShellWords(
      buildGuard,
      'wasm_require_exports "$OUT" \\',
    );
    const runtimeGuardedExports = shellArrayWords(
      runtimeGuard,
      "KERNEL_REQUIRED_EXPORTS",
    );

    for (const exportName of ABI_43_RESERVATION_EXPORTS) {
      // WHY: both runtime validation and packaged-kernel validation must reject
      // an artifact that exposes only part of a tokenized reservation protocol.
      expect(HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS).toContain(exportName);
      expect(guardedExports).toContain(exportName);
      expect(runtimeGuardedExports).toContain(exportName);
    }
    for (const exportName of ABI_43_CAPACITY_PREFLIGHT_EXPORTS) {
      // WHY: POSIX MQ must resolve the queue-owned message ceiling before a
      // host reservation. A packaged kernel lacking this query could otherwise
      // change EMSGSIZE into ENOMEM or reserve the caller's unbounded capacity.
      expect(HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS).toContain(exportName);
      expect(guardedExports).toContain(exportName);
      expect(runtimeGuardedExports).toContain(exportName);
    }

    // WHY: startup and package installation are two entrances to the same host
    // adapter. Comparing the complete generated ABI list prevents a future
    // required export from being enforced by only one of those entrances.
    expect(guardedExports).toEqual([...HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS]);
    expect(runtimeGuardedExports).toEqual([
      ...HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS,
    ]);
  });
});
