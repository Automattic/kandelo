import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const program = tryResolveBinary("programs/scm-rights-pipe-lifetime.wasm");

describe("SCM_RIGHTS pipe endpoint lifetime", () => {
  it.skipIf(!program)("transfers live endpoints and collects unreachable rights cycles", async () => {
    const result = await runCentralizedProgram({
      programPath: program!,
      argv: ["scm-rights-pipe-lifetime"],
      timeout: 10_000,
      useDefaultRootfs: false,
    });

    expect(result.exitCode, `stderr=${result.stderr}\nstdout=${result.stdout}`).toBe(0);
    expect(result.stdout).toContain(
      "PASS: SCM_RIGHTS owns pipe endpoints in flight and after receipt",
    );
  });
});
