import { describe, it, expect } from "vitest";
import { join } from "path";
import { runCentralizedProgram } from "./centralized-test-helper";

describe("sigpending", () => {
  it("reports pending blocked signals", async () => {
    const { exitCode, stdout } = await runCentralizedProgram({
      programPath: join(__dirname, "../../examples/test-sigpending.wasm"),
    });
    console.log("stdout:", stdout);
    expect(stdout).toContain("PASS");
    expect(exitCode).toBe(0);
  }, 30_000);
});
