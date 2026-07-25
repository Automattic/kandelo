import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureWasm64ExampleFixture } from "./wasm64-example-fixture";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("timerfd and signalfd scratch marshalling", () => {
  it.each(["wasm32", "wasm64"] as const)(
    "keeps native caller objects bounded (%s)",
    async (arch) => {
      const programPath = arch === "wasm64"
        ? ensureWasm64ExampleFixture("timerfd_signalfd_scratch_test.c")
        : join(repoRoot, "examples/timerfd_signalfd_scratch_test.wasm");
      const result = await runCentralizedProgram({
        programPath,
        timeout: 20_000,
        // This native-layout regression executes a self-contained fixture and
        // must not depend on whichever packaged rootfs happens to be installed.
        useDefaultRootfs: false,
      });

      expect(result.stdout).toContain("timerfd scratch guards: PASS");
      expect(result.stdout).toContain("signalfd scratch mask: PASS");
      expect(result.stdout).toContain("ALL TESTS PASSED");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
    },
    30_000,
  );
});
