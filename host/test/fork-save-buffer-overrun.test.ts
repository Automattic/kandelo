/**
 * Unit tests for `forkSaveBufferOverrun` — the host-side detector that turns a
 * fork-continuation save-buffer overrun into a truthful failure instead of
 * silent syscall-channel corruption.
 *
 * The instrumented unwind keeps `current_pos` (a pointer-width integer at the
 * base of the save buffer) as the absolute high-water linear-memory address it
 * wrote to. The buffer is `FORK_SAVE_BUFFER_SIZE` bytes and abuts the syscall
 * channel, so any `current_pos > forkBufAddr + FORK_SAVE_BUFFER_SIZE` means the
 * unwind clobbered channel memory. See worker-main.ts and
 * crates/fork-instrument/src/runtime.rs.
 *
 * End-to-end behavior was validated against the real ABI 18 Homebrew launcher,
 * whose Bash fork needs 20,012 bytes and now fails with the exact diagnostic
 * instead of corrupting its channel. These tests pin the detection arithmetic
 * that the fork paths rely on.
 */
import { describe, it, expect } from "vitest";
import { forkSaveBufferOverrun } from "../src/worker-main";
import { FORK_SAVE_BUFFER_SIZE } from "../src/process-memory";

const FORK_BUF_ADDR = 65536; // arbitrary page-aligned buffer base for the test

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

describe("forkSaveBufferOverrun", () => {
  it("reports no overrun when the save fits within the buffer", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    writeCurrentPos(memory, FORK_BUF_ADDR, FORK_BUF_ADDR + 200, 4);
    expect(forkSaveBufferOverrun(memory, FORK_BUF_ADDR, 4)).toBe(0);
  });

  it("treats current_pos exactly at the buffer size as fitting (no overrun)", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    writeCurrentPos(
      memory,
      FORK_BUF_ADDR,
      FORK_BUF_ADDR + FORK_SAVE_BUFFER_SIZE,
      4,
    );
    expect(forkSaveBufferOverrun(memory, FORK_BUF_ADDR, 4)).toBe(0);
  });

  it("reports the exact overrun in bytes when the buffer is exceeded", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    writeCurrentPos(
      memory,
      FORK_BUF_ADDR,
      FORK_BUF_ADDR + FORK_SAVE_BUFFER_SIZE + 4096,
      4,
    );
    expect(forkSaveBufferOverrun(memory, FORK_BUF_ADDR, 4)).toBe(4096);
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
    expect(forkSaveBufferOverrun(memory, FORK_BUF_ADDR, 4)).toBe(
      observedFrameBytes - FORK_SAVE_BUFFER_SIZE,
    );
  });

  it("reads current_pos as i64 on the wasm64 path", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    writeCurrentPos(
      memory,
      FORK_BUF_ADDR,
      FORK_BUF_ADDR + FORK_SAVE_BUFFER_SIZE + 1,
      8,
    );
    expect(forkSaveBufferOverrun(memory, FORK_BUF_ADDR, 8)).toBe(1);
  });
});
