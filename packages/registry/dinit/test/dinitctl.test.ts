import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dinitctlBinary = tryResolveBinary("programs/dinit/dinitctl.wasm");

describe.skipIf(!dinitctlBinary)("dinitctl", () => {
  it("reports a missing control socket without trapping in the host", async () => {
    const socketPath = "/tmp/kandelo-dinitctl-missing.sock";
    const result = await runCentralizedProgram({
      programPath: dinitctlBinary!,
      argv: ["dinitctl", "-p", socketPath, "list"],
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`connecting to socket: ${socketPath}`);
    expect(result.hostDiagnostics).toEqual([
      expect.objectContaining({ source: "process exit", status: 1 }),
    ]);
    expect(
      result.hostDiagnostics.map(({ message }) => message).join("\n"),
    ).not.toContain("WebAssembly.Exception");
  });
});
