import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

const timerThreadBinary = tryResolveBinary("programs/posix-timer-thread.wasm");

describe("POSIX SIGEV_THREAD timers", () => {
  it.skipIf(!timerThreadBinary)(
    "delivers concurrent timer expirations to musl's dedicated helper threads",
    async () => {
      const result = await runCentralizedProgram({
        programPath: timerThreadBinary!,
        argv: ["posix-timer-thread"],
        timeout: 10_000,
        useDefaultRootfs: false,
      });

      expect(result.exitCode, `stderr=${result.stderr}\nstdout=${result.stdout}`).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("CALLBACKS: first=1/41 second=1/42");
      expect(result.stdout).toMatch(
        /SIGNAL_TIMER: code=-2 value=77 timer=\d+ overrun=[1-9]\d* reset=0/,
      );
      expect(result.stdout).toMatch(
        /WAIT_DEADLINE: delivered=\d+ms timeout=\d+ms/,
      );
      expect(result.stdout).toContain("HELPER_CHURN: 24");
      expect(result.stdout).toContain("PASS");
    },
  );
});
