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
  it("keeps a NAME_MAX entry pending when the caller is one byte short", () => {
    const name = "n".repeat(255);
    const { io, kernel, memory } = createKernelBridge([
      { name, type: 8, ino: 42 },
    ]);
    const hostReaddir = kernel.testAuthority.hostReaddir;
    const bytes = new Uint8Array(memory.buffer);
    bytes.fill(0x6d, 16, 32);
    bytes.fill(0x7e, 128, 128 + name.length);

    expect(hostReaddir(7n, 16, 128, name.length - 1)).toBe(-34); // ERANGE
    expect(io.readdir).toHaveBeenCalledTimes(1);
    expect(bytes.slice(16, 32)).toEqual(new Uint8Array(16).fill(0x6d));
    expect(bytes.slice(128, 128 + name.length)).toEqual(
      new Uint8Array(name.length).fill(0x7e),
    );

    expect(hostReaddir(7n, 16, 128, name.length)).toBe(1);
    expect(io.readdir).toHaveBeenCalledTimes(1);
    const view = new DataView(memory.buffer);
    expect(view.getUint32(28, true)).toBe(name.length);
    expect(new TextDecoder().decode(bytes.slice(128, 128 + name.length)))
      .toBe(name);
  });

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

  it("clears a staged entry even when the backend close fails", () => {
    let failFirstNameRead = true;
    const { io, kernel } = createKernelBridge([
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
    ]);
    io.closedir.mockImplementationOnce(() => {
      throw new Error("injected close failure");
    });
    const bridge = kernel.testAuthority;

    expect(bridge.hostReaddir(7n, 16, 128, 64)).toBeLessThan(0);
    expect(bridge.hostClosedir(7n)).toBeLessThan(0);
    expect(bridge.hostReaddir(7n, 16, 128, 64)).toBe(0);
    expect(io.closedir).toHaveBeenCalledWith(7);
    expect(io.readdir).toHaveBeenCalledTimes(2);
  });

  it("drops stale transport state when opendir returns a reused handle", () => {
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

    new Uint8Array(memory.buffer, 256, 4).set(
      new TextEncoder().encode("/tmp"),
    );
    expect(bridge.hostOpendir(256, 4)).toBe(7n);
    expect(bridge.hostReaddir(7n, 16, 128, 64)).toBe(1);

    expect(io.opendir).toHaveBeenCalledWith("/tmp");
    expect(io.readdir).toHaveBeenCalledTimes(2);
    expect(
      new TextDecoder().decode(
        new Uint8Array(memory.buffer, 128, "new-iterator".length),
      ),
    ).toBe("new-iterator");
  });
});
