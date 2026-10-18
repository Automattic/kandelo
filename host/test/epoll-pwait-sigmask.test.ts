import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const binary = tryResolveBinary("programs/epoll-pwait-sigmask.wasm");

// The host runs epoll_pwait as poll retries and holds the caller's signal
// mask across them through kernel_swap_poll_sigmask /
// kernel_restore_poll_sigmask. Without that the mask was silently ignored:
// foot's SIGCHLD reaper never fired and its window stayed open after `exit`.
// The second case checks the kernel side: a handler that interrupts
// epoll_pwait must return to the pre-wait mask, not the wait's mask.
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
