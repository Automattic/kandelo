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
 * candidate bootstrap's Bash child. Those measurements preserve the ABI 41
 * regression boundary; ABI 42 no longer treats 60 KiB as continuation
 * capacity. These tests keep the retired contiguous-buffer detector truthful
 * without implying that current linked continuations have the old ceiling.
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
});
