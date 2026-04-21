/**
 * Regression tests for two bugs that silently broke libc-test's
 * `functional/popen` and `regression/daemon-failure`:
 *
 * 1. Initial PID must not be 1. daemon-failure checks `getppid() != 1` as the
 *    "daemon did not detach" condition. If the test harness spawns user
 *    programs at pid 1, forked children see ppid=1 and the test misfires.
 *    (Regressed when PR #289 moved PID allocation into the kernel worker
 *    and reset the counter to 1 — see host/src/node-kernel-worker-entry.ts.)
 *
 * 2. dash's `kill -USR1` must send Linux signal 10, not macOS signal 30.
 *    dash's Makefile runs `mksignames` during build to regenerate signames.c,
 *    and on macOS the host-compiled mksignames emits macOS signal numbers.
 *    The popen test uses `kill -USR1 %d` from a shell child; if the number is
 *    wrong, the parent never receives SIGUSR1.
 *    (Regressed when PR #269 rebuilt dash for the wasm64 channel ABI — the
 *    one-pass build in build-dash.sh let mksignames overwrite the Linux-
 *    numbered signames.c.)
 *
 * These tests exercise the kernel + dash path end-to-end so either regression
 * fails fast in vitest, without needing the full libc-test suite.
 */
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashBinary = join(__dirname, "../../examples/libs/dash/bin/dash.wasm");
const fallbackShBinary = join(__dirname, "../wasm/sh.wasm");

// Prefer the freshly built dash binary over the fallback shell.
const shellBinary = existsSync(dashBinary) ? dashBinary : fallbackShBinary;
const hasShell = existsSync(shellBinary);

describe.skipIf(!hasShell)("popen/daemon regression gates", () => {
  it("initial user-program PID is not 1 (reserved for init)", async () => {
    // daemon-failure's orphan check fires on `getppid() == 1`, so the test
    // harness must not spawn user programs at pid 1.
    const result = await runCentralizedProgram({
      programPath: shellBinary,
      argv: ["dash", "-c", "echo $$"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    const pid = Number.parseInt(result.stdout.trim(), 10);
    expect(Number.isFinite(pid)).toBe(true);
    expect(pid).toBeGreaterThan(1);
  });

  it("shell's signal-10 name is USR1, not BUS", async () => {
    // dash's `kill -l <N>` maps signal numbers to names from its built-in
    // signames.c table. Linux/musl puts SIGUSR1 at 10 and SIGBUS at 7; macOS
    // puts SIGBUS at 10 and SIGUSR1 at 30. If dash was cross-built without
    // the Linux-numbered signames.c patch, `kill -l 10` reports "BUS" and
    // `kill -USR1 $pid` sends signal 30 — which the kernel delivers, but
    // parents listening for SIGUSR1 (10) never see.
    const result = await runCentralizedProgram({
      programPath: shellBinary,
      argv: ["dash", "-c", "kill -l 10"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("USR1");
  });

  it("shell-driven `kill -USR1 $$` reaches the parent as signal 10", async () => {
    // Combined check: dash resolves the symbolic name AND the kernel delivers
    // the signal to the numeric pid. `trap 'echo got=N' N; kill -USR1 $$`
    // should print got=10; printing anything else (got=30, empty) means dash
    // sent the wrong signal number or the kernel lost delivery.
    const result = await runCentralizedProgram({
      programPath: shellBinary,
      argv: [
        "dash",
        "-c",
        "trap 'echo got=10' 10; kill -USR1 $$; echo done",
      ],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("got=10");
    expect(result.stdout).toContain("done");
  });
});
