import { describe, expect, it } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { signalExitStatus, SIGILL } from "../src/trap-signals";

const __dirname = dirname(fileURLToPath(import.meta.url));
const normalExitBinary = join(__dirname, "../../examples/pthread-normal-exit.wasm");
const trapChildBinary = join(__dirname, "../../examples/pthread-trap-child.wasm");
const trapWaitBinary = join(__dirname, "../../examples/pthread-trap-wait.wasm");

const hasPthreadTrapBinaries = existsSync(normalExitBinary) &&
  existsSync(trapChildBinary) &&
  existsSync(trapWaitBinary);

describe.skipIf(!hasPthreadTrapBinaries)("pthread trap POSIX semantics", () => {
  it("keeps normal pthread return and pthread_exit per-thread", async () => {
    const { exitCode, stdout, stderr } = await runCentralizedProgram({
      programPath: normalExitBinary,
      argv: ["pthread-normal-exit"],
      timeout: 10_000,
      useDefaultRootfs: false,
    });

    expect(stderr).toBe("");
    expect(stdout).toContain("shared_value=18");
    expect(stdout).toContain("PASS pthread normal exit");
    expect(exitCode).toBe(0);
  }, 15_000);

  it("terminates the process when a pthread worker hits an uncaught guest trap", async () => {
    const { exitCode, stderr } = await runCentralizedProgram({
      programPath: trapChildBinary,
      argv: ["pthread-trap-child"],
      timeout: 10_000,
      useDefaultRootfs: false,
    });

    expect(stderr).toContain("pthread-trap-child: before trap");
    expect(stderr).toContain("Thread worker failed");
    expect(stderr).not.toContain("FAIL pthread_join returned");
    expect(exitCode).toBe(signalExitStatus(SIGILL));
  }, 15_000);

  it("makes a fatal pthread trap visible through waitpid signal status", async () => {
    const { exitCode, stdout, stderr } = await runCentralizedProgram({
      programPath: trapWaitBinary,
      argv: ["pthread-trap-wait", "/pthread-trap-child"],
      execPrograms: new Map([["/pthread-trap-child", trapChildBinary]]),
      timeout: 15_000,
      useDefaultRootfs: false,
    });

    expect(stderr).toContain("pthread-trap-child: before trap");
    expect(stdout).toContain("signaled=1");
    expect(stdout).toContain(`termsig=${SIGILL}`);
    expect(stdout).toContain("PASS pthread trap wait status");
    expect(exitCode).toBe(0);
  }, 20_000);
});
