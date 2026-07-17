import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureWasm64ExampleFixture } from "./wasm64-example-fixture";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programs = [
  ["wasm32", join(__dirname, "../../examples/rlimit_fsize_test.wasm")],
  ["wasm64", join(__dirname, "../../examples/rlimit_fsize_test.wasm64.wasm")],
] as const;

describe("RLIMIT_FSIZE operation boundaries", () => {
  it.each(programs)(
    "preserves partial progress for a %s guest",
    async (arch, program) => {
      if (arch === "wasm64") {
        ensureWasm64ExampleFixture("rlimit_fsize_test.c");
      }
      const result = await runCentralizedProgram({
        programPath: program,
        argv: ["rlimit-fsize-test"],
        timeout: 30_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("RLIMIT_FSIZE_PASS");
      expect(result.stderr).toBe("");
    },
  );
});
