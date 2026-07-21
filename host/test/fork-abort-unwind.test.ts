import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ContinuationAllocationError,
  LinkedForkContinuation,
  readLinkedFrameFormat,
} from "../src/fork-continuation";

describe("instrumented ABORT_UNWINDING", () => {
  it("reconstructs committed inner frames and permits a later successful fork", () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-fork-abort-"));
    try {
      const rawPath = join(dir, "abort.wasm");
      const instrumentedPath = join(dir, "abort.instrumented.wasm");
      // The outer function has a roughly 72 KiB scalar payload. Its caller
      // (run) first commits a small frame into the root chunk, then outer's
      // reservation requires a second mapping where failure is injected.
      const outerLocalCount = 9_000;
      const outerLocalInit = Array.from(
        { length: outerLocalCount },
        (_, index) => `i64.const ${index} local.set ${index}`,
      ).join("\n");
      const wat = `(module
        (import "kernel" "kernel_fork" (func $fork (result i32)))
        (import "env" "memory" (memory 8))
        (func $leaf (result i32) call $fork)
        (func $outer (result i32) (local ${"i64 ".repeat(outerLocalCount)})
          ${outerLocalInit}
          call $leaf)
        (func (export "run") (result i32) (local $saved i32)
          i32.const 7
          local.set $saved
          call $outer
          local.get $saved
          i32.add))`;
      const watPath = join(dir, "abort.wat");
      writeFileSync(watPath, wat);
      execFileSync("wat2wasm", [watPath, "-o", rawPath]);
      execFileSync(resolve("../tools/bin/wasm-fork-instrument"), [
        rawPath,
        "-o",
        instrumentedPath,
      ]);

      const bytes = readFileSync(instrumentedPath);
      const module = new WebAssembly.Module(bytes);
      const memory = new WebAssembly.Memory({ initial: 8 });
      let instance: WebAssembly.Instance;
      let moduleBuffer = 0;
      let forkResult = 0;
      let failGrowth = true;
      let nextAddress = 65_536;
      const released: Array<{ addr: number; size: number }> = [];
      const continuation = new LinkedForkContinuation(
        memory,
        readLinkedFrameFormat(module),
        (size) => {
          if (failGrowth && nextAddress !== 65_536) {
            throw new ContinuationAllocationError(12, size, "injected ENOMEM");
          }
          const addr = nextAddress;
          nextAddress += size;
          return addr;
        },
        (addr, size) => released.push({ addr, size }),
        "abort-e2e",
      );

      const imports = {
        env: {
          memory,
          __wpk_fork_frame_reserve: (size: number) => {
            const frame = continuation.reserveFrame(size);
            if (frame === 0) {
              (instance.exports.wpk_fork_abort_begin as (addr: number) => void)(moduleBuffer);
            }
            return frame;
          },
          __wpk_fork_frame_commit: (payload: number) => continuation.commitFrame(payload),
          __wpk_fork_frame_next: (size: number) => continuation.nextFrame(size),
        },
        kernel: {
          kernel_fork: () => {
            const state = (instance.exports.wpk_fork_state as () => number)();
            if (state === 2) {
              (instance.exports.wpk_fork_rewind_end as () => void)();
              continuation.finishReplayAndRelease();
              return forkResult;
            }
            if (state === 3) {
              const errno = continuation.abortErrno();
              (instance.exports.wpk_fork_abort_end as () => void)();
              continuation.finishAbortReplayAndRelease();
              return -errno;
            }
            moduleBuffer = Number(continuation.beginUnwind());
            (instance.exports.wpk_fork_unwind_begin as (addr: number) => void)(moduleBuffer);
            return 0;
          },
        },
      };
      instance = new WebAssembly.Instance(module, imports);
      const run = instance.exports.run as () => number;
      const state = instance.exports.wpk_fork_state as () => number;

      expect(run()).toBe(-5); // raw -ENOMEM plus the preserved caller local 7
      expect(state()).toBe(0);
      expect(continuation.hasActiveContinuation()).toBe(false);
      expect(released).toEqual([{ addr: 65_536, size: 65_536 }]);

      // Reuse the released root and allow the large second chunk. A negative
      // SYS_FORK result after a complete unwind must replay to the guest.
      failGrowth = false;
      nextAddress = 65_536;
      expect(run()).toBe(0); // transformed unwind returns the result-type default
      expect(state()).toBe(1);
      (instance.exports.wpk_fork_unwind_end as () => void)();
      continuation.finishUnwind();
      forkResult = -11;
      continuation.beginReplay();
      (instance.exports.wpk_fork_rewind_begin as (addr: number) => void)(moduleBuffer);
      expect(run()).toBe(-4);
      expect(state()).toBe(0);
      expect(continuation.hasActiveContinuation()).toBe(false);

      // A later independent fork can still complete successfully.
      nextAddress = 65_536;
      expect(run()).toBe(0);
      (instance.exports.wpk_fork_unwind_end as () => void)();
      continuation.finishUnwind();
      forkResult = 123;
      continuation.beginReplay();
      (instance.exports.wpk_fork_rewind_begin as (addr: number) => void)(moduleBuffer);
      expect(run()).toBe(130);
      expect(state()).toBe(0);
      expect(continuation.hasActiveContinuation()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
