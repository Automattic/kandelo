import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dinitctlBinary = tryResolveBinary("programs/dinit/dinitctl.wasm");

describe.skipIf(!dinitctlBinary)("dinitctl", () => {
  it("reports a missing control socket as an ordinary process error", async () => {
    const socketPath = "/tmp/kandelo-dinitctl-missing.sock";
    const result = await runCentralizedProgram({
      programPath: dinitctlBinary!,
      argv: ["dinitctl", "-p", socketPath, "list"],
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`connecting to socket: ${socketPath}`);
    expect(result.stderr).not.toContain("WebAssembly.Exception");
    expect(result.stderr).not.toContain("libc++abi: terminating");
  });
});
