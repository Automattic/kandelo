import { describe, it, expect } from "vitest";
import { assertForkBufferWithinBounds } from "../src/worker-main";
import { FORK_SAVE_BUFFER_SIZE } from "../src/process-memory";

const FORK_BUF_ADDR = 1024;

function memoryWithCurrentPos(currentPos: number, ptrWidth: 4 | 8): WebAssembly.Memory {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const view = new DataView(memory.buffer);
  if (ptrWidth === 8) view.setBigUint64(FORK_BUF_ADDR, BigInt(currentPos), true);
  else view.setUint32(FORK_BUF_ADDR, currentPos, true);
  return memory;
}

describe("assertForkBufferWithinBounds", () => {
  for (const ptrWidth of [4, 8] as const) {
    it(`accepts current_pos within the buffer (wasm${ptrWidth === 4 ? 32 : 64})`, () => {
      const memory = memoryWithCurrentPos(FORK_SAVE_BUFFER_SIZE - 1, ptrWidth);
      expect(() =>
        assertForkBufferWithinBounds(memory, FORK_BUF_ADDR, ptrWidth, 100),
      ).not.toThrow();
    });

    it(`throws naming the peak when current_pos overflows (wasm${ptrWidth === 4 ? 32 : 64})`, () => {
      const peak = FORK_SAVE_BUFFER_SIZE + 8;
      const memory = memoryWithCurrentPos(peak, ptrWidth);
      expect(() =>
        assertForkBufferWithinBounds(memory, FORK_BUF_ADDR, ptrWidth, 100),
      ).toThrow(new RegExp(`overflow \\(pid=100\\): peak current_pos=${peak}`));
    });
  }

  it("treats exactly-at-capacity as in-bounds (throw is strict >)", () => {
    const memory = memoryWithCurrentPos(FORK_SAVE_BUFFER_SIZE, 4);
    expect(() =>
      assertForkBufferWithinBounds(memory, FORK_BUF_ADDR, 4, 100),
    ).not.toThrow();
  });
});
