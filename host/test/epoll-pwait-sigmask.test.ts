import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const binary = tryResolveBinary("programs/epoll-pwait-sigmask.wasm");

// A caught signal interrupts the wait while its temporary mask is active.
// The guest checks the original mask again after the signal handler returns.
describe("epoll_pwait signal mask", () => {
  it.skipIf(!binary)(
    "a signal unblocked only by the wait mask ends the wait with EINTR and runs its handler",
    async () => {
      const result = await runCentralizedProgram({
        programPath: binary!,
        argv: ["epoll-pwait-sigmask"],
        useDefaultRootfs: false,
      });

      expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("PASS\n");
    },
    // Two forks plus two 300 ms waits: the fork cost alone runs past
    // vitest's 5 s default.
    60_000,
  );
});
