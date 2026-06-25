import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { runCentralizedProgram } from "./centralized-test-helper";

const pthreadVarargsStackBinary = join(__dirname, "../../examples/pthread-varargs-stack.wasm");

describe.skipIf(!existsSync(pthreadVarargsStackBinary))("pthread varargs stack alignment", () => {
  it("preserves 64-bit varargs and snprintf in pthread workers", async () => {
    const result = await runCentralizedProgram({
      programPath: pthreadVarargsStackBinary,
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("pthread varargs stack ok");
  });
});
