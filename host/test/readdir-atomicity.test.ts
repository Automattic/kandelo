import { describe, expect, it, vi } from "vitest";
import { createWasmPosixKernelTestHarness } from "../src/kernel";
import type { PlatformIO } from "../src/types";

const KERNEL_CONFIG = {
  maxWorkers: 1,
  dataBufferSize: 65_536,
  useSharedMemory: true,
};

function createKernelBridge(entries: Array<{ name: string; type: number; ino: number }>) {
  let index = 0;
  const io = {
    opendir: vi.fn(() => 7),
    readdir: vi.fn(() => entries[index++] ?? null),
    closedir: vi.fn(),
  };
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = createWasmPosixKernelTestHarness({
    config: KERNEL_CONFIG,
    io: io as unknown as PlatformIO,
    memory,
    pointerWidth: 4,
  });
  return { io, kernel, memory };
}

describe("host readdir retry atomicity", () => {
  it("replays an entry when Wasm output marshalling fails after the backend read", () => {
    let failFirstNameRead = true;
    const entry = {
      get name(): string {
        if (failFirstNameRead) {
          failFirstNameRead = false;
          throw new Error("malformed first marshalling attempt");
        }
        return "retry-me";
      },
      type: 8,
      ino: 42,
    };
    const { io, kernel, memory } = createKernelBridge([entry]);
    const hostReaddir = kernel.testAuthority.hostReaddir;

    const result = hostReaddir(7n, 16, 128, 64);
    expect(result).toBeLessThan(0);
    expect(io.readdir).toHaveBeenCalledTimes(1);

    expect(hostReaddir(7n, 16, 128, 64)).toBe(1);
    expect(io.readdir).toHaveBeenCalledTimes(1);

    const view = new DataView(memory.buffer);
    expect(view.getBigUint64(16, true)).toBe(42n);
    expect(view.getUint32(24, true)).toBe(8);
    expect(view.getUint32(28, true)).toBe(entry.name.length);
    expect(
      new TextDecoder().decode(
        new Uint8Array(memory.buffer, 128, entry.name.length),
      ),
    ).toBe(entry.name);
    expect(hostReaddir(7n, 16, 128, 64)).toBe(0);
    expect(io.readdir).toHaveBeenCalledTimes(2);
  });

  it("drops a staged entry when a directory handle closes", () => {
    let failFirstNameRead = true;
    const { io, kernel, memory } = createKernelBridge([
      {
        get name(): string {
          if (failFirstNameRead) {
            failFirstNameRead = false;
            throw new Error("malformed old iterator entry");
          }
          return "old-iterator";
        },
        type: 8,
        ino: 1,
      },
      { name: "new-iterator", type: 4, ino: 2 },
    ]);
    const bridge = kernel.testAuthority;

    expect(bridge.hostReaddir(7n, 16, 128, 64)).toBeLessThan(0);
    expect(bridge.hostClosedir(7n)).toBe(0);
    expect(bridge.hostReaddir(7n, 16, 128, 64)).toBe(1);

    expect(io.closedir).toHaveBeenCalledWith(7);
    expect(io.readdir).toHaveBeenCalledTimes(2);
    expect(
      new TextDecoder().decode(
        new Uint8Array(memory.buffer, 128, "new-iterator".length),
      ),
    ).toBe("new-iterator");
  });
});
