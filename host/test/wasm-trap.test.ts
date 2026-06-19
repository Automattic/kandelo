/**
 * Regression tests for the wasm-port `a_crash` + `{type:"exit"}`-handler
 * cascade fixed in this PR. See the docstring in
 * `host/test/exec-brk-base.test.ts` for the full investigation.
 *
 * These tests don't depend on mariadbd — they exercise the same code
 * paths with minimal C programs:
 *
 *   - `wasm_trap_test`:    `__builtin_trap()` from main(). Worker-main
 *                          reports the unhandled `unreachable`
 *                          RuntimeError as a process failure; the host
 *                          maps it to SIGILL and resolves promptly.
 *
 *   - `oob_trap_test`:     Out-of-bounds linear-memory access maps to
 *                          SIGSEGV.
 *
 *   - `divzero_trap_test`: Integer divide-by-zero maps to SIGFPE.
 *
 *   - `abort_test`:        abort(). musl's abort() raises SIGABRT and
 *                          then loops on `for(;;) a_crash()` as a
 *                          backstop. Before the overlay's `a_crash`
 *                          override the loop spun forever in
 *                          user-space (silent write to addr 0 on
 *                          wasm); now `__builtin_trap()` traps the
 *                          first iteration.
 */
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { runCentralizedProgram } from "./centralized-test-helper";
import { NodeKernelHost } from "../src/node-kernel-host";
import { signalExitStatus, SIGFPE, SIGILL, SIGSEGV } from "../src/trap-signals";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmTrapBin = join(__dirname, "../../examples/wasm_trap_test.wasm");
const oobTrapBin = join(__dirname, "../../examples/oob_trap_test.wasm");
const divzeroTrapBin = join(__dirname, "../../examples/divzero_trap_test.wasm");
const abortBin = join(__dirname, "../../examples/abort_test.wasm");

const programsBuilt = existsSync(wasmTrapBin) &&
  existsSync(oobTrapBin) &&
  existsSync(divzeroTrapBin) &&
  existsSync(abortBin);

function loadWasm(path: string): ArrayBuffer {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

describe.skipIf(!programsBuilt)("wasm trap → host exit (regression)", () => {
  it("__builtin_trap() in user code: spawn() resolves promptly, no hang", async () => {
    const t0 = Date.now();
    const { exitCode, stderr } = await runCentralizedProgram({
      programPath: wasmTrapBin,
      useDefaultRootfs: false,
      timeout: 5000,
    });
    const elapsed = Date.now() - t0;

    expect(stderr).toContain("before-trap");
    expect(stderr).not.toContain("SHOULD-NEVER-REACH");
    // Arbitrary `unreachable` traps are no longer masked as successful exits;
    // only the known kernel_exit path is interpreted as normal termination.
    expect(exitCode).toBe(signalExitStatus(SIGILL));
    expect(stderr).toContain("RuntimeError");
    expect(stderr).toContain("unreachable");
    expect(elapsed).toBeLessThan(3000);
  }, 8_000);

  it("out-of-bounds memory trap resolves as SIGSEGV", async () => {
    const t0 = Date.now();
    const { exitCode, stderr } = await runCentralizedProgram({
      programPath: oobTrapBin,
      useDefaultRootfs: false,
      timeout: 5000,
    });
    const elapsed = Date.now() - t0;

    expect(stderr).toContain("before-oob");
    expect(stderr).not.toContain("SHOULD-NEVER-REACH");
    expect(exitCode).toBe(signalExitStatus(SIGSEGV));
    expect(stderr).toContain("RuntimeError");
    expect(elapsed).toBeLessThan(3000);
  }, 8_000);

  it("integer divide-by-zero trap resolves as SIGFPE", async () => {
    const t0 = Date.now();
    const { exitCode, stderr } = await runCentralizedProgram({
      programPath: divzeroTrapBin,
      useDefaultRootfs: false,
      timeout: 5000,
    });
    const elapsed = Date.now() - t0;

    expect(stderr).toContain("before-divzero");
    expect(stderr).not.toContain("SHOULD-NEVER-REACH");
    expect(exitCode).toBe(signalExitStatus(SIGFPE));
    expect(stderr).toContain("RuntimeError");
    expect(elapsed).toBeLessThan(3000);
  }, 8_000);

  it("abort(): doesn't reach post-abort code, doesn't hang the host", async () => {
    const t0 = Date.now();
    const { exitCode, stderr } = await runCentralizedProgram({
      programPath: abortBin,
      useDefaultRootfs: false,
      timeout: 5000,
    });
    const elapsed = Date.now() - t0;

    expect(stderr).toContain("before-abort");
    expect(stderr).not.toContain("SHOULD-NEVER-REACH");
    // exitCode could legitimately be 132 (abort backstop's unreachable
    // trap) or 134 (128+SIGABRT, when raise(SIGABRT) terminates via the
    // kernel's default action).
    // Both are valid "process terminated" outcomes; the regression
    // we're guarding against is HANGING.
    expect([signalExitStatus(SIGILL), 134]).toContain(exitCode);
    expect(elapsed).toBeLessThan(3000);
  }, 8_000);

  it("same Node host can launch again immediately after an OOB trap", async () => {
    let stdout = "";
    let stderr = "";
    const decode = (data: Uint8Array) => new TextDecoder().decode(data);
    const host = new NodeKernelHost({
      rootfsImage: undefined,
      onStdout: (_pid, data) => { stdout += decode(data); },
      onStderr: (_pid, data) => { stderr += decode(data); },
    });

    await host.init();
    try {
      const trapStatus = await withTimeout(
        host.spawn(loadWasm(oobTrapBin), ["oob_trap_test"]),
        "OOB trap spawn",
      );
      const divzeroStatus = await withTimeout(
        host.spawn(loadWasm(divzeroTrapBin), ["divzero_trap_test"]),
        "post-trap spawn",
      );

      expect(trapStatus).toBe(signalExitStatus(SIGSEGV));
      expect(divzeroStatus).toBe(signalExitStatus(SIGFPE));
      expect(stderr).toContain("before-oob");
      expect(stderr).toContain("before-divzero");
      expect(stdout).toBe("");
    } finally {
      await host.destroy();
    }
  }, 12_000);
});
