import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureWasm64ExampleFixture } from "./wasm64-example-fixture";

const testDir = dirname(fileURLToPath(import.meta.url));
const wasm32Binary = join(
  testDir,
  "../../examples/process_native_layout_test.wasm",
);

describe("caller-native syscall layouts", () => {
  it.each(["wasm32", "wasm64"] as const)(
    "round-trips signal, timer, message-queue, statfs, and sysinfo records (%s)",
    async (arch) => {
      const programPath = arch === "wasm64"
        ? ensureWasm64ExampleFixture("process_native_layout_test.c")
        : wasm32Binary;
      const result = await runCentralizedProgram({
        programPath,
        timeout: 20_000,
        useDefaultRootfs: false,
      });

      expect(result.stdout).toContain("PROCESS NATIVE LAYOUTS PASSED");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.hostDiagnostics).toEqual([]);
    },
    30_000,
  );
});
