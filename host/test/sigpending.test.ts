import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sigpendingBinary = join(__dirname, "../../examples/test-sigpending.wasm");
const hasBinary = existsSync(sigpendingBinary);

describe.skipIf(!hasBinary)("sigpending", () => {
  it("reports pending blocked signals", async () => {
    const { exitCode, stdout } = await runCentralizedProgram({
      programPath: sigpendingBinary,
    });
    expect(stdout).toContain("PASS");
    expect(exitCode).toBe(0);
  }, 30_000);
});
