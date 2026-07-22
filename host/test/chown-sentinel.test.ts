import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureWasm64ExampleFixture } from "./wasm64-example-fixture";

const __dirname = dirname(fileURLToPath(import.meta.url));
describe("chown ownership, authorization, and set-ID semantics", () => {
  it.each([".wasm", ".wasm64.wasm"])(
    "enforces ownership and link semantics (%s)",
    async (suffix) => {
      if (suffix === ".wasm64.wasm") {
        ensureWasm64ExampleFixture("chown_sentinel_test.c");
      }
      const program = join(__dirname, `../../examples/chown_sentinel_test${suffix}`);
      const result = await runCentralizedProgram({
        programPath: program,
        argv: ["chown-sentinel-test"],
        timeout: 15_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("CHOWN_SENTINEL_PASS");
      expect(result.stderr).toBe("");
    },
  );
});
