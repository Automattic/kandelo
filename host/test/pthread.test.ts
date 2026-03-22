import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("pthread", () => {
  it("creates a thread that modifies shared state and returns a value", async () => {
    const { exitCode, stdout } = await runCentralizedProgram({
      programPath: join(__dirname, "../../examples/test-pthread.wasm"),
      timeout: 30_000,
    });

    expect(stdout).toContain("creating thread");
    expect(stdout).toContain("joining thread");
    expect(stdout).toContain("PASS");
    expect(exitCode).toBe(0);
  }, 30_000);
});
