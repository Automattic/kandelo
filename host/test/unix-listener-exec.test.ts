import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const program = join(__dirname, "../../examples/unix_listener_exec_test.wasm");

describe("AF_UNIX listener inheritance across fork and exec", () => {
  it("accepts a pre-exec queued connection in the replacement worker", async () => {
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["/bin/unix-listener-exec"],
      execPrograms: new Map([["/bin/unix-listener-exec", program]]),
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("UNIX_LISTENER_EXEC_PASS");
    expect(result.stderr).toBe("");
    expect(result.hostDiagnostics).toEqual([]);
  });
});
