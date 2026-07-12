import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("pthread channel reuse", () => {
  it("runs a second pthread after fork reuses the first thread slot", async () => {
    const result = await runCentralizedProgram({
      programPath: join(
        __dirname,
        "../../examples/pthread_channel_reuse_test.wasm",
      ),
      argv: ["pthread-channel-reuse-test"],
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PTHREAD_CHANNEL_REUSE_PASS");
    expect(result.stderr).toBe("");
  });
});
