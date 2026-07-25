import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const programs = [
  ["wasm32", resolveBinary("programs/wasm32/scm-rights-pipe-lifetime.wasm")],
  ["wasm64", resolveBinary("programs/wasm64/scm-rights-pipe-lifetime.wasm")],
] as const;

describe("SCM_RIGHTS pipe and FIFO reference lifetime", () => {
  it.each(programs)(
    "transfers exact pipe/FIFO ownership and rejects lossy socket rights (%s)",
    async (_arch, program) => {
      const result = await runCentralizedProgram({
        programPath: program,
        argv: ["scm-rights-pipe-lifetime"],
        timeout: 10_000,
        useDefaultRootfs: false,
      });

      expect(
        result.exitCode,
        `stderr=${result.stderr}\nstdout=${result.stdout}`,
      ).toBe(0);
      expect(result.stdout).toContain(
        "PASS: SCM_RIGHTS owns pipe and FIFO references in flight and after receipt",
      );
      expect(result.stdout).toContain("SCM_RIGHTS_SOCKET_REJECTION_PASS");
    },
  );
});
