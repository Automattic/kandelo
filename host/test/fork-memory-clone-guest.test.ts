import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("fork process-memory clone", () => {
  it("copies the parent's exact grown size and boundary bytes", async () => {
    const program = join(
      __dirname,
      "../../examples/fork_memory_clone_test.wasm",
    );
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["fork-memory-clone-test"],
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(
      /FORK_MEMORY_CLONE_PASS pages=\d+ boundary=165/,
    );
    expect(result.stderr).toBe("");
  });
});
