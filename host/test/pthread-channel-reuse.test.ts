import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("pthread channel reuse", () => {
  it("reuses a slot and preserves over-aligned large TLS across nested pthread forks", async () => {
    const result = await runCentralizedProgram({
      programPath: join(
        __dirname,
        "../../examples/pthread_channel_reuse_test.wasm",
      ),
      argv: ["pthread-channel-reuse-test"],
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PTHREAD_CHANNEL_REUSE_LARGE_TLS_PASS");
    expect(result.stderr).toBe("");
  }, 40_000);
});
