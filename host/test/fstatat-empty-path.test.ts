import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureWasm64ExampleFixture } from "./wasm64-example-fixture";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("fstatat AT_EMPTY_PATH guest ABI", () => {
  it.each([".wasm", ".wasm64.wasm"])(
    "targets descriptors and AT_FDCWD while preserving errno (%s)",
    async (suffix) => {
      if (suffix === ".wasm64.wasm") {
        ensureWasm64ExampleFixture("fstatat_empty_path_test.c");
      }
      const result = await runCentralizedProgram({
        programPath: join(repoRoot, `examples/fstatat_empty_path_test${suffix}`),
        argv: ["fstatat-empty-path-test"],
        timeout: 15_000,
        useDefaultRootfs: false,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("FSTATAT_EMPTY_PATH_PASS");
      expect(result.stderr).toBe("");
    },
  );
});
