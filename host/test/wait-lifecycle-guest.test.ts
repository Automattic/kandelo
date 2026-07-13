import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("POSIX child wait lifecycle", () => {
  it("reports stop, continue, exit, WNOWAIT, rusage, procfs, and stopped SIGKILL", async () => {
    const program = join(__dirname, "../../examples/wait_lifecycle_test.wasm");
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["wait-lifecycle-test"],
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("WAIT_LIFECYCLE_PASS");
    expect(result.stderr).toBe("");
  });

  it("uses memory64 wait layouts through same-arch non-forking posix_spawn", async () => {
    const program = join(
      __dirname,
      "../../examples/wait_lifecycle_test.wasm64.wasm",
    );
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["wait-lifecycle-test-wasm64"],
      execPrograms: new Map([
        ["/wait-lifecycle-test-wasm64", program],
      ]),
      useDefaultRootfs: false,
      timeout: 30_000,
      captureForkCount: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("WAIT_LIFECYCLE_PASS");
    expect(result.stderr).toBe("");
    expect(result.forkCount).toBe(0n);
  });
});
