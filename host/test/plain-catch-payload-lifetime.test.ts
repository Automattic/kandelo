import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LinkedForkContinuation,
  readLinkedFrameFormat,
} from "../src/fork-continuation";

const FIRST_PAYLOAD = 0x1234;
const SECOND_PAYLOAD = 0x5678;
// WHY: this fixture has no pre-existing mutable globals, so the old B1
// implementation places its arm id and one i32 payload immediately after the
// two pointer words in the module prefix. These offsets name the bytes whose
// ownership is under test; the activation-local replacement must not touch
// them before a continuation exists or after that continuation is released.
const SCRATCH_ARM_OFFSET = 8;
const SCRATCH_PAYLOAD_OFFSET = 12;
const SENTINEL = 0xa5a5a5a5;

describe("plain-catch payload lifetime", () => {
  it("keeps capture state activation-owned before the first fork and after release", () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-plain-catch-lifetime-"));
    try {
      const watPath = join(dir, "plain-catch-lifetime.wat");
      const rawPath = join(dir, "plain-catch-lifetime.wasm");
      const instrumentedPath = join(dir, "plain-catch-lifetime.instrumented.wasm");
      writeFileSync(watPath, `(module
        (import "kernel" "kernel_fork" (func $fork (result i32)))
        (import "env" "memory" (memory 4))
        (tag $payload (param i32))
        (func (export "run") (param $payload i32) (result i32)
          (local $caught i32)
          (block $handler (result i32)
            (try_table (catch $payload $handler)
              local.get $payload
              throw $payload
              unreachable)
            unreachable)
          local.set $caught
          call $fork
          local.get $caught
          i32.add))`);
      execFileSync("wat2wasm", [
        "--enable-exceptions",
        watPath,
        "-o",
        rawPath,
      ]);
      const instrumenterPath = fileURLToPath(
        new URL("../../tools/bin/wasm-fork-instrument", import.meta.url),
      );
      execFileSync(instrumenterPath, [rawPath, "-o", instrumentedPath]);

      const module = new WebAssembly.Module(readFileSync(instrumentedPath));
      const memory = new WebAssembly.Memory({ initial: 4 });
      const view = new DataView(memory.buffer);
      let instance: WebAssembly.Instance;
      let moduleBuffer = 0;
      let firstCaptureKeptLowMemory = false;
      let secondCaptureKeptLowMemory = false;
      let secondCaptureKeptReleasedMemory = false;
      let normalForkCalls = 0;
      const continuation = new LinkedForkContinuation(
        memory,
        readLinkedFrameFormat(module),
        () => 65_536,
        () => {},
        "plain-catch-lifetime",
      );

      const scratchIsSentinel = (base: number): boolean =>
        view.getUint32(base + SCRATCH_ARM_OFFSET, true) === SENTINEL &&
        view.getUint32(base + SCRATCH_PAYLOAD_OFFSET, true) === SENTINEL;
      const fillScratch = (base: number): void => {
        view.setUint32(base + SCRATCH_ARM_OFFSET, SENTINEL, true);
        view.setUint32(base + SCRATCH_PAYLOAD_OFFSET, SENTINEL, true);
      };

      instance = new WebAssembly.Instance(module, {
        env: {
          memory,
          __wpk_fork_frame_reserve: (size: number) =>
            continuation.reserveFrame(size),
          __wpk_fork_frame_commit: (payload: number) =>
            continuation.commitFrame(payload),
          __wpk_fork_frame_next: (size: number) =>
            continuation.nextFrame(size),
        },
        kernel: {
          kernel_fork: () => {
            const state = (instance.exports.wpk_fork_state as () => number)();
            if (state === 2) {
              (instance.exports.wpk_fork_rewind_end as () => void)();
              continuation.finishReplayAndRelease();
              return normalForkCalls === 1 ? 7 : 11;
            }

            normalForkCalls++;
            if (normalForkCalls === 1) {
              firstCaptureKeptLowMemory = scratchIsSentinel(0);
            } else {
              secondCaptureKeptLowMemory = scratchIsSentinel(0);
              secondCaptureKeptReleasedMemory = scratchIsSentinel(moduleBuffer);
            }

            moduleBuffer = Number(continuation.beginUnwind());
            (instance.exports.wpk_fork_unwind_begin as (addr: number) => void)(
              moduleBuffer,
            );
            return 0;
          },
        },
      });

      const run = instance.exports.run as (payload: number) => number;
      fillScratch(0);

      // The first pass drains frames and returns the function's result default.
      expect(run(FIRST_PAYLOAD)).toBe(0);
      (instance.exports.wpk_fork_unwind_end as () => void)();
      continuation.finishUnwind();
      continuation.beginReplay();
      (instance.exports.wpk_fork_rewind_begin as (addr: number) => void)(
        moduleBuffer,
      );
      expect(run(FIRST_PAYLOAD)).toBe(FIRST_PAYLOAD + 7);

      // Once replay releases the continuation, its former bytes are no longer
      // storage owned by fork instrumentation. A later plain catch must not
      // mutate either that retired mapping or low memory before its fork call.
      fillScratch(0);
      fillScratch(moduleBuffer);
      expect(run(SECOND_PAYLOAD)).toBe(0);
      (instance.exports.wpk_fork_unwind_end as () => void)();
      continuation.finishUnwind();
      continuation.beginReplay();
      (instance.exports.wpk_fork_rewind_begin as (addr: number) => void)(
        moduleBuffer,
      );
      expect(run(SECOND_PAYLOAD)).toBe(SECOND_PAYLOAD + 11);

      expect({
        firstCaptureKeptLowMemory,
        secondCaptureKeptLowMemory,
        secondCaptureKeptReleasedMemory,
      }).toEqual({
        firstCaptureKeptLowMemory: true,
        secondCaptureKeptLowMemory: true,
        secondCaptureKeptReleasedMemory: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
