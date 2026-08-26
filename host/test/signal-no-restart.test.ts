/**
 * A handler installed without SA_RESTART must let the blocking syscall it
 * interrupts fail with EINTR.
 *
 * The host ends a park by completing the channel with EINTR and asking the
 * glue to re-issue the syscall. Only an SA_RESTART handler may ask for that
 * re-issue: the kernel parks whenever a syscall would block and never reads
 * the handler's flags, so the park itself carries no restart intent.
 */
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { tryResolveBinary } from "../src/binary-resolver";

const binary = tryResolveBinary("programs/signal-no-restart.wasm");

describe("signal without SA_RESTART", () => {
  it.skipIf(!binary)(
    "fails the interrupted read with EINTR instead of re-issuing it",
    async () => {
      const result = await runCentralizedProgram({
        programPath: binary!,
        argv: ["signal-no-restart"],
        timeout: 20_000,
      });

      const dump = `stdout=${result.stdout}\nstderr=${result.stderr}`;
      expect(result.stdout, dump).toContain("HANDLER: ran");
      expect(result.stdout, dump).toContain("PASS: signal-no-restart");
      expect(result.exitCode, dump).toBe(0);
    },
    30_000,
  );
});
