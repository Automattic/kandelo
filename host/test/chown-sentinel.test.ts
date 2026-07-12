import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const program = join(__dirname, "../../examples/chown_sentinel_test.wasm");

describe("chown unchanged-ID sentinels", () => {
  it("preserves IDs and keeps target, fd, and authorization errors visible", async () => {
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["chown-sentinel-test"],
      timeout: 15_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CHOWN_SENTINEL_PASS");
    expect(result.stderr).toBe("");
  });
});
