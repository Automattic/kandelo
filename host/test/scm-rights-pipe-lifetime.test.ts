import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const program = resolveBinary("programs/scm-rights-pipe-lifetime.wasm");

describe("SCM_RIGHTS pipe and FIFO reference lifetime", () => {
  it("transfers exact pipe and FIFO ownership and collects rights cycles", async () => {
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["scm-rights-pipe-lifetime"],
      timeout: 10_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode, `stderr=${result.stderr}\nstdout=${result.stdout}`).toBe(0);
    expect(result.stdout).toContain(
      "PASS: SCM_RIGHTS owns pipe and FIFO references in flight and after receipt",
    );
  });
});
