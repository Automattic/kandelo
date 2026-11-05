import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROCESS_MEMORY_BYTES = 512 * 65536;

describe("fork churn", () => {
  it("delays forks behind retiring process memory instead of failing them", async () => {
    // The budget also caps the retired-memory backlog in bytes, so three
    // children exiting within the retirement window fill it.
    const result = await runCentralizedProgram({
      programPath: join(__dirname, "fixtures/fork-churn.wasm"),
      argv: ["fork-churn"],
      maxProcessMemoryBytes: 3 * PROCESS_MEMORY_BYTES,
      timeout: 60_000,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("FORK_CHURN_PASS forks=32\n");
    expect(result.exitCode).toBe(0);
  });
});
