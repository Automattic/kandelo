/**
 * Unit tests for `forkSaveBufferOverrun` — the host-side detector that turns a
 * fork-continuation save-buffer overrun into a truthful failure instead of
 * silent syscall-channel corruption.
 *
 * The instrumented unwind keeps `current_pos` (a pointer-width integer at the
 * base of the save buffer) as the absolute high-water linear-memory address it
 * wrote to. Main-process and pthread buffers abut their syscall channels;
 * fork-capable side modules use independent allocations of the same explicit
 * size. In either case, `current_pos > forkBufAddr + forkBufSize` means the
 * unwind crossed the reserved continuation boundary. See worker-main.ts and
 * crates/fork-instrument/src/runtime.rs.
 *
 * End-to-end behavior was measured against the Homebrew dispatcher, its
 * /usr/bin/brew alias launcher, the GTK/GLib desktop path, and the exact
 * candidate bootstrap's Bash child. ABI 41's 60 KiB reserve must fit every
 * measured continuation while retaining truthful detection for larger ones.
 * These tests pin the arithmetic that the fork paths use.
 */
import { describe, it, expect } from "vitest";
import type { SideModuleForkState } from "../src/dylink";
import {
  finalizeSideModuleForkUnwind,
  forkSaveBufferOverrun,
} from "../src/worker-main";
import { FORK_SAVE_BUFFER_SIZE } from "../src/process-memory";
import type { LinkedForkContinuation } from "../src/fork-continuation";

const FORK_BUF_ADDR = 65536; // arbitrary page-aligned buffer base for the test
const SIDE_FORK_BUF_ADDR = 32768; // separate from the process-main test buffer

function writeCurrentPos(
  memory: WebAssembly.Memory,
  addr: number,
  value: number,
  ptrWidth: 4 | 8,
): void {
  const view = new DataView(memory.buffer);
  if (ptrWidth === 8) view.setBigUint64(addr, BigInt(value), true);
  else view.setUint32(addr, value, true);
}

function createSideForkState(
  name: string,
  forkBufAddr: number,
  finishUnwind: () => void = () => {},
): { state: SideModuleForkState; runtimeState: () => number } {
  let value = 1; // UNWINDING
  const instance = {
    exports: {
      wpk_fork_state: () => value,
      wpk_fork_unwind_end: () => {
        value = 0; // NORMAL
      },
    },
  } as unknown as WebAssembly.Instance;
  return {
    state: {
      name,
      instance,
      forkBufAddr,
      continuation: { finishUnwind } as unknown as LinkedForkContinuation,
    },
    runtimeState: () => value,
  };
}

describe("forkSaveBufferOverrun", () => {
  it("reports no overrun when the save fits within the buffer", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    writeCurrentPos(memory, FORK_BUF_ADDR, FORK_BUF_ADDR + 200, 4);
    expect(
      forkSaveBufferOverrun(memory, FORK_BUF_ADDR, 4, FORK_SAVE_BUFFER_SIZE),
    ).toBe(0);
  });

  it("treats current_pos exactly at the buffer size as fitting (no overrun)", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    writeCurrentPos(
      memory,
      FORK_BUF_ADDR,
      FORK_BUF_ADDR + FORK_SAVE_BUFFER_SIZE,
      4,
    );
    expect(
      forkSaveBufferOverrun(memory, FORK_BUF_ADDR, 4, FORK_SAVE_BUFFER_SIZE),
    ).toBe(0);
  });

  it("reports the exact overrun in bytes when the buffer is exceeded", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    writeCurrentPos(
      memory,
      FORK_BUF_ADDR,
      FORK_BUF_ADDR + FORK_SAVE_BUFFER_SIZE + 4096,
      4,
    );
    expect(
      forkSaveBufferOverrun(memory, FORK_BUF_ADDR, 4, FORK_SAVE_BUFFER_SIZE),
    ).toBe(4096);
  });

  it.each([
    ["Homebrew dispatcher", 20_012],
    ["Homebrew /usr/bin/brew alias launcher", 29_212],
    ["GTK/GLib launch", 21_544],
    ["Homebrew candidate Bash recursive evaluator", 49_232],
  ])("fits the measured %s continuation", (_name, observedFrameBytes) => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    writeCurrentPos(
      memory,
      FORK_BUF_ADDR,
      FORK_BUF_ADDR + observedFrameBytes,
      4,
    );
    expect(
      forkSaveBufferOverrun(memory, FORK_BUF_ADDR, 4, FORK_SAVE_BUFFER_SIZE),
    ).toBe(0);
  });

  it("reads current_pos as i64 on the wasm64 path", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    writeCurrentPos(
      memory,
      FORK_BUF_ADDR,
      FORK_BUF_ADDR + FORK_SAVE_BUFFER_SIZE + 1,
      8,
    );
    expect(
      forkSaveBufferOverrun(memory, FORK_BUF_ADDR, 8, FORK_SAVE_BUFFER_SIZE),
    ).toBe(1);
  });

  it("finalizes the side-module linked continuation", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    let finalized = false;
    const side = createSideForkState(
      "libintl.so",
      SIDE_FORK_BUF_ADDR,
      () => { finalized = true; },
    );

    expect(() => finalizeSideModuleForkUnwind(memory, side.state, 4))
      .not.toThrow();
    expect(finalized).toBe(true);
    expect(side.runtimeState()).toBe(0);
  });

  it("propagates linked continuation validation before fork dispatch", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    const side = createSideForkState(
      "libintl.so",
      SIDE_FORK_BUF_ADDR,
      () => { throw new Error("uncommitted linked frame"); },
    );

    expect(() => finalizeSideModuleForkUnwind(memory, side.state, 4))
      .toThrow("uncommitted linked frame");
    expect(side.runtimeState()).toBe(0);
  });
});
