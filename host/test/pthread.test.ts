import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pthreadBinary = join(__dirname, "../../examples/test-pthread.wasm");
const hasBinary = existsSync(pthreadBinary);

describe.skipIf(!hasBinary)("pthread", () => {
  it("creates a thread that modifies shared state and returns a value", async () => {
    const { exitCode, stdout } = await runCentralizedProgram({
      programPath: pthreadBinary,
      timeout: 30_000,
    });

    expect(stdout).toContain("creating thread");
    expect(stdout).toContain("joining thread");
    expect(stdout).toContain("PASS");
    expect(exitCode).toBe(0);
  }, 30_000);
});
