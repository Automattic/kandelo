import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { ABI_SYSCALLS } from "../src/generated/abi";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { runCentralizedProgram } from "./centralized-test-helper";

/**
 * A sleep is a kernel park with a deadline.
 *
 * `nanosleep`, `clock_nanosleep` and `usleep` park the caller in the Rust
 * kernel (`crates/runtime-core/src/wait_park.rs`); the deadline, a caught
 * signal (with the `rem` write POSIX requires), and `pthread_cancel` are
 * kernel decisions the host only publishes. The native host runs the
 * signal-free cases from the same source
 * (`crates/host-native/fixtures/native_sleep.c`).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const binary = join(__dirname, "../../examples/sleep-kernel-wait.wasm");

describe.skipIf(!existsSync(binary))("kernel-owned sleeps", () => {
  it("answers every way a sleep can end", async () => {
    const { exitCode, stdout, stderr } = await runCentralizedProgram({
      programPath: binary,
      argv: ["sleep-kernel-wait"],
      timeout: 30_000,
    });
    for (const name of [
      "duration",
      "zero",
      "invalid",
      "absolute",
      "usleep",
      "threads",
      "cancel",
      "signal-rem",
      "sleep-left",
      "signal-absolute",
      "blocked-signal",
    ]) {
      expect(stdout, stderr).toContain(`ok ${name}\n`);
    }
    expect(stdout).toContain("PASS");
    expect(exitCode).toBe(0);
  }, 40_000);
});

describe("PTY signals versus kernel-owned sleeps", () => {
  // Resolving the programs and composing the image take seconds under load;
  // keep them outside the timed interactive session.
  let rootfsImage: Uint8Array;
  beforeAll(async () => {
    const image = KandeloImageFs.create();
    image.mkdir("/bin", 0o755);
    image.mkdir("/tmp", 0o1777);
    image.writeFile("/bin/bash", readFileSync(resolveBinary("programs/bash.wasm")), 0o755);
    image.writeFile("/bin/sleep", readFileSync(resolveBinary("programs/coreutils.wasm")), 0o755);
    rootfsImage = await image.saveImage();
  }, 120_000);

  it("interrupts a foreground sleep and returns status 130 to the interactive shell", async () => {
    let output = "";
    let sleepingPid: number | undefined;
    const exits = new Map<number, number | undefined>();
    const diagnostics: string[] = [];
    const host = new NodeKernelHost({
      rootfsImage,
      onPtyOutput: (_pid, data) => { output += new TextDecoder().decode(data); },
      onHostDiagnostic: (event) => diagnostics.push(event.message),
      onProcessEvent: (event) => {
        if (event.kind === "exit") exits.set(event.pid, event.exitStatus);
      },
    });
    await host.init();
    const unsubscribe = host.subscribeSyscalls((event) => {
      if (event.nr === ABI_SYSCALLS.Nanosleep || event.nr === ABI_SYSCALLS.ClockNanosleep) {
        sleepingPid = event.pid;
      }
    });
    try {
      const shell = await host.spawnFromVfs("/bin/bash", ["bash", "--noprofile", "--norc", "-i"], {
        pty: true,
        env: ["PATH=/bin", "HOME=/", "PS1=INTERRUPT_PROMPT> ", "TERM=dumb"],
      });
      await expect.poll(() => output).toContain("INTERRUPT_PROMPT> ");
      output = "";
      host.ptyWrite(shell.pid, new TextEncoder().encode("sleep 30\n"));
      // Observe the syscall the kernel parked, not an arbitrary launch delay.
      await expect.poll(() => sleepingPid).toBeDefined();
      const started = performance.now();
      host.ptyWrite(shell.pid, new Uint8Array([3]));
      await expect.poll(() => output, { timeout: 1_000, intervals: [10] }).toContain("INTERRUPT_PROMPT> ");
      expect(performance.now() - started).toBeLessThan(1_000);
      await expect.poll(() => exits.get(sleepingPid!)).toBe(130);
      output = "";
      host.ptyWrite(shell.pid, new TextEncoder().encode("printf 'INTERRUPT_%s:%s\\n' STATUS \"$?\"\n"));
      await expect.poll(() => output).toContain("INTERRUPT_STATUS:130");
      host.ptyWrite(shell.pid, new TextEncoder().encode("exit\n"));
      await shell.exit;
      expect(diagnostics).toEqual([]);
    } finally {
      unsubscribe();
      await host.destroy();
    }
  }, 30_000);
});
