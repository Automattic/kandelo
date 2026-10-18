import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

// A writer blocked on a full pipe whose reader exits must get SIGPIPE (or
// EPIPE when SIGPIPE is ignored or caught), and only that writer may be
// affected. `grep -v zzz big.txt | head -3` used to kill the whole kernel:
// the kernel terminated grep by SIGPIPE inside the retried write, and the
// host's vectored-write path then asked the kernel to dequeue a signal for
// the dead task, which the kernel correctly refused.

const fixture = tryResolveBinary("programs/blocked-syscall-signal-death.wasm");
const dash = tryResolveBinary("programs/dash.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const grep = tryResolveBinary("programs/grep.wasm");

describe("signal death inside a blocked syscall", () => {
  it.skipIf(!fixture)(
    "kills or interrupts only the blocked process, for every write, read, and wait path",
    async () => {
      const result = await runCentralizedProgram({
        programPath: fixture!,
        argv: ["blocked-syscall-signal-death"],
        useDefaultRootfs: false,
        timeout: 60_000,
      });

      expect(
        result.exitCode,
        `stdout=${result.stdout}\nstderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toBe("PASS\n");
    },
    90_000,
  );
});

describe.skipIf(!dash || !coreutils || !grep)("shell pipelines into head", () => {
  function runShell(script: string) {
    const execPrograms = new Map<string, string>();
    for (const name of ["head", "seq", "cat"]) {
      execPrograms.set(`/bin/${name}`, coreutils!);
      execPrograms.set(`/usr/bin/${name}`, coreutils!);
    }
    execPrograms.set("/bin/grep", grep!);
    execPrograms.set("/usr/bin/grep", grep!);
    return runCentralizedProgram({
      programPath: dash!,
      argv: ["dash", "-c", script],
      env: ["PATH=/bin:/usr/bin", "HOME=/tmp"],
      execPrograms,
      timeout: 60_000,
    });
  }

  it(
    "terminates a blocked writer with SIGPIPE and keeps the session running",
    async () => {
      // Every command reads a file, never harness stdin.
      const result = await runShell([
        "seq 1 200000 > /tmp/big.txt",
        "grep -v zzz /tmp/big.txt | head -3",
        'echo "pipeline-status=$?"',
        '{ grep -v zzz /tmp/big.txt; echo "writer-status=$?" >&2; } | head -1',
        '{ seq 1 200000; echo "seq-status=$?" >&2; } | head -1',
        // A new process after the deaths proves the kernel is still alive.
        "seq 7 7",
      ].join("\n"));

      expect(
        result.exitCode,
        `stdout=${result.stdout}\nstderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toBe("1\n2\n3\npipeline-status=0\n1\n1\n7\n");
      // 141 = 128 + SIGPIPE: the shell saw each writer die by the signal.
      expect(result.stderr).toContain("writer-status=141");
      expect(result.stderr).toContain("seq-status=141");
    },
    90_000,
  );

  it(
    "returns EPIPE to a blocked writer that ignores SIGPIPE",
    async () => {
      // An ignored disposition survives exec, so seq inherits it, sees
      // write() fail with EPIPE, reports the error, and exits 1.
      const result = await runShell([
        '{ trap "" PIPE; seq 1 200000; echo "seq-status=$?" >&2; } | head -1',
        "seq 7 7",
      ].join("\n"));

      expect(
        result.exitCode,
        `stdout=${result.stdout}\nstderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).toBe("1\n7\n");
      expect(result.stderr).toMatch(/seq: write error: Broken pipe/);
      expect(result.stderr).toContain("seq-status=1");
    },
    90_000,
  );
});
