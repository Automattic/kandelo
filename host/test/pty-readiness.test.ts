import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
describe("guest PTY input and repaint output", () => {
  it("preserves output and readiness through poll, select, pselect, epoll, and blocking read", async () => {
    const result = await runCentralizedProgram({
      programPath: join(repoRoot, "examples/pty_readiness_test.wasm"),
      argv: ["pty-readiness"],
      timeout: 30_000,
      useDefaultRootfs: false,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("PTY_READINESS_PASS");
    expect(result.stdout.match(/PTY_ROUNDTRIP/g)).toHaveLength(5);
    expect(result.stderr).toBe("");
    expect(result.hostDiagnostics).toEqual([]);
  }, 40_000);
});
