/**
 * Unit tests for `forkSaveBufferOverrun` — the host-side detector that turns a
 * fork-continuation save-buffer overrun into a truthful failure instead of
 * silent syscall-channel corruption.
 *
 * The instrumented unwind keeps `current_pos` (a pointer-width integer at the
 * base of the save buffer) as the high-water byte offset it wrote to. The
 * buffer is `FORK_SAVE_BUFFER_SIZE` bytes and abuts the syscall channel, so any
 * `current_pos > FORK_SAVE_BUFFER_SIZE` means the unwind clobbered channel
 * memory. See worker-main.ts and crates/fork-instrument/src/runtime.rs.
 *
 * End-to-end behavior (a too-deep fork producing the diagnostic rather than a
 * silent crash) was validated manually in a real browser by temporarily
 * shrinking FORK_SAVE_BUFFER_SIZE; that path can't be exercised at the real
 * 16 KiB size via deep recursion because the wasm engine's call-stack limit is
 * hit first. These tests pin the detection arithmetic that the fork paths rely on.
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
    writeCurrentPos(memory, FORK_BUF_ADDR, 200, 4); // frames_start_offset-ish
    expect(forkSaveBufferOverrun(memory, FORK_BUF_ADDR, 4)).toBe(0);
  });

  it("treats current_pos exactly at the buffer size as fitting (no overrun)", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    writeCurrentPos(memory, FORK_BUF_ADDR, FORK_SAVE_BUFFER_SIZE, 4);
    expect(forkSaveBufferOverrun(memory, FORK_BUF_ADDR, 4)).toBe(0);
  });

  it("reports the exact overrun in bytes when the buffer is exceeded", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    writeCurrentPos(memory, FORK_BUF_ADDR, FORK_SAVE_BUFFER_SIZE + 4096, 4);
    expect(forkSaveBufferOverrun(memory, FORK_BUF_ADDR, 4)).toBe(4096);
  });

  it("reads current_pos as i64 on the wasm64 path", () => {
    const memory = new WebAssembly.Memory({ initial: 3 });
    writeCurrentPos(memory, FORK_BUF_ADDR, FORK_SAVE_BUFFER_SIZE + 1, 8);
    expect(forkSaveBufferOverrun(memory, FORK_BUF_ADDR, 8)).toBe(1);
  });
});
