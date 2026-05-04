/**
 * Regression tests for the wasm-port `a_crash` + `{type:"exit"}`-handler
 * cascade fixed in this PR. See the docstring in
 * `host/test/exec-brk-base.test.ts` for the full investigation.
 *
 * These tests don't depend on mariadbd — they exercise the same code
 * paths with minimal C programs:
 *
 *   - `wasm_trap_test`:    `__builtin_trap()` from main(). Worker-main
 *                          catches the resulting `unreachable`
 *                          RuntimeError and posts {type:"exit"}; the
 *                          kernel-worker entry must forward that to
 *                          the host so spawn() resolves. Without the
 *                          handler, this hangs.
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
import { existsSync } from "node:fs";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmTrapBin = join(__dirname, "../../examples/wasm_trap_test.wasm");
const abortBin = join(__dirname, "../../examples/abort_test.wasm");

const programsBuilt = existsSync(wasmTrapBin) && existsSync(abortBin);

describe.skipIf(!programsBuilt)("wasm trap → host exit (regression)", () => {
  it("__builtin_trap() in user code: spawn() resolves promptly, no hang", async () => {
    const t0 = Date.now();
    const { exitCode, stderr } = await runCentralizedProgram({
      programPath: wasmTrapBin,
      timeout: 5000,
    });
    const elapsed = Date.now() - t0;

    expect(stderr).toContain("before-trap");
    expect(stderr).not.toContain("SHOULD-NEVER-REACH");
    // worker-main treats `unreachable` as the normal `_Exit` exit pattern,
    // so exitCode is 0. The point of this test is that spawn() returned —
    // the exit code itself isn't load-bearing.
    expect(exitCode).toBe(0);
    expect(elapsed).toBeLessThan(3000);
  }, 8_000);

  it("abort(): doesn't reach post-abort code, doesn't hang the host", async () => {
    const t0 = Date.now();
    const { exitCode, stderr } = await runCentralizedProgram({
      programPath: abortBin,
      timeout: 5000,
    });
    const elapsed = Date.now() - t0;

    expect(stderr).toContain("before-abort");
    expect(stderr).not.toContain("SHOULD-NEVER-REACH");
    // exitCode could legitimately be 0 (a_crash unreachable trap →
    // worker-main's `_Exit` interpretation) or 134 (128+SIGABRT, when
    // raise(SIGABRT) terminates via the kernel's default action).
    // Both are valid "process terminated" outcomes; the regression
    // we're guarding against is HANGING.
    expect([0, 134]).toContain(exitCode);
    expect(elapsed).toBeLessThan(3000);
  }, 8_000);
});
