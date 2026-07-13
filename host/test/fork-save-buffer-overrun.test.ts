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
 * End-to-end behavior was validated against the real ABI 18 Homebrew launcher,
 * whose Bash fork needs 20,012 bytes and now fails with the exact diagnostic
 * instead of corrupting its channel. These tests pin the detection arithmetic
 * that the fork paths rely on.
 */
import { describe, it, expect } from "vitest";
import type { SideModuleForkState } from "../src/dylink";
import {
  finalizeSideModuleForkUnwind,
  forkSaveBufferOverrun,
} from "../src/worker-main";
import { FORK_SAVE_BUFFER_SIZE } from "../src/process-memory";

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
      forkBufSize: FORK_SAVE_BUFFER_SIZE,
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

  it("reports the exact ABI 18 Homebrew launcher overrun", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    const observedFrameBytes = 20_012;
    writeCurrentPos(
      memory,
      FORK_BUF_ADDR,
      FORK_BUF_ADDR + observedFrameBytes,
      4,
    );
    expect(
      forkSaveBufferOverrun(memory, FORK_BUF_ADDR, 4, FORK_SAVE_BUFFER_SIZE),
    ).toBe(observedFrameBytes - FORK_SAVE_BUFFER_SIZE);
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

  it("accepts an independently allocated side-module save that fits", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    const side = createSideForkState("libintl.so", SIDE_FORK_BUF_ADDR);
    writeCurrentPos(
      memory,
      SIDE_FORK_BUF_ADDR,
      SIDE_FORK_BUF_ADDR + FORK_SAVE_BUFFER_SIZE,
      4,
    );

    expect(() => finalizeSideModuleForkUnwind(memory, side.state, 4))
      .not.toThrow();
    expect(side.runtimeState()).toBe(0);
  });

  it("rejects an overflowing side-module save before fork dispatch", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    const side = createSideForkState("libintl.so", SIDE_FORK_BUF_ADDR);
    const overrun = 73;
    writeCurrentPos(
      memory,
      SIDE_FORK_BUF_ADDR,
      SIDE_FORK_BUF_ADDR + FORK_SAVE_BUFFER_SIZE + overrun,
      4,
    );

    expect(() => finalizeSideModuleForkUnwind(memory, side.state, 4)).toThrow(
      `libintl.so: side-module fork() continuation save buffer overflow — ` +
        `the call stack at fork() needed ${FORK_SAVE_BUFFER_SIZE + overrun} ` +
        `bytes but only ${FORK_SAVE_BUFFER_SIZE}`,
    );
    expect(side.runtimeState()).toBe(0);
  });
});
