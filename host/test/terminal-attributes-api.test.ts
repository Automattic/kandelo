import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureWasm64ExampleFixture } from "./wasm64-example-fixture";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const programs = [
  ["wasm32", join(repoRoot, "examples/terminal_attributes_api_test.wasm")],
  [
    "memory64",
    join(repoRoot, "examples/terminal_attributes_api_test.wasm64.wasm"),
  ],
] as const;

describe("terminal attribute and queue APIs through musl", () => {
  it.each(programs)(
    "covers shared PTY attributes, actions, queues, and errors (%s)",
    async (arch, program) => {
      if (arch === "memory64") {
        ensureWasm64ExampleFixture("terminal_attributes_api_test.c");
      }
      const result = await runCentralizedProgram({
        programPath: program,
        argv: ["terminal-attributes-api-test"],
        timeout: 20_000,
        useDefaultRootfs: false,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("TERMINAL_ATTRIBUTES_API_PASS");
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
    },
  );
});
