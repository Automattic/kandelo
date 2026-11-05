import { describe, expect, it, vi } from "vitest";

import {
  createWasmPosixKernelTestHarness,
  WasmPosixKernel,
} from "../src/kernel";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

const ENOSYS = 38;
const EIO = 5;
const EPERM = 1;

/** Write a URI into kernel memory and return its (pointer, length) pair.
 *
 * The seam now takes an ADDRESS, so a test of it has to put one somewhere the
 * import can read. 256 is chosen to sit well below the 4096 the destination
 * tests use, so a URI and a destination never overlap. */
function writeUri(memory: WebAssembly.Memory, uri: string, at = 256): [number, number] {
  const bytes = new TextEncoder().encode(uri);
  new Uint8Array(memory.buffer, at, bytes.byteLength).set(bytes);
  return [at, bytes.byteLength];
}

/**
 * Mirrors the `kernelHarness` helper used by the `host_read`/`host_pread`
 * import tests in kernel-public-scratch.test.ts, scoped to what
 * `host_fetch_deferred` needs: a real Memory the destination-factory can
 * validate the pointer/capacity pair against.
 */
function kernelHarness(
  exports: Record<string, unknown> = {},
  pointerWidth: 4 | 8 = 4,
): { kernel: WasmPosixKernel & Record<string, any>; memory: WebAssembly.Memory } {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernel = createWasmPosixKernelTestHarness({
    memory,
    pointerWidth,
    instance: createKernelScratchTestInstance(
      pointerWidth,
      memory,
      () => exports,
      (capacity) => {
        const allocator = exports.kernel_alloc_scratch;
        if (typeof allocator !== "function") {
          throw new Error("missing test implementation for kernel_alloc_scratch");
        }
        return Reflect.apply(allocator, undefined, [capacity]) as number | bigint;
      },
    ),
  }) as WasmPosixKernel & Record<string, any>;
  return { kernel, memory };
}

function importsOf(
  kernel: WasmPosixKernel & Record<string, any>,
  memory: WebAssembly.Memory,
): { env: Record<string, (...args: any[]) => any> } {
  return kernel.testAuthority.buildImportObject(memory) as {
    env: Record<string, (...args: any[]) => any>;
  };
}

describe("host_fetch_deferred provider seam", () => {
  it.each([4, 8] as const)("shares one isolated image/journal/index/compaction staging backing and recovers from storage detachment for width %s", width => {
    const { kernel, memory } = kernelHarness({}, width);
    const imports = importsOf(kernel, memory);
    const buffers = new Set<ArrayBufferLike>();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pointer = width === 8 ? 4096n : 4096;
    kernel.setRootfsImageProvider((_offset: bigint, bytes: Uint8Array) => {
      buffers.add(bytes.buffer); bytes.fill(0x39); return bytes.byteLength;
    });
    expect(imports.env.host_image_read(pointer, 4, 0, 0)).toBe(4);
    try {
      for (const [setter, imported] of [
        ["setPersistentOverlayStorage", "host_overlay_read"],
        ["setPersistentOverlayTargetStorage", "host_overlay_target_read"],
        ["setPersistentOverlayCompactionStorage", "host_overlay_compaction_read"],
      ]) {
        kernel[setter!]({ readExactAt(_offset: bigint, bytes: Uint8Array) {
          buffers.add(bytes.buffer);
          expect(new Uint8Array(bytes.buffer).every(value => value === 0)).toBe(true);
          expect(imports.env.host_image_read(pointer, 4, 0, 0)).toBe(-EIO);
          bytes.fill(0x5a);
        } });
        expect(imports.env[imported!]!(17n, pointer, 4)).toBe(0);
        expect([...new Uint8Array(memory.buffer, 4096, 4)]).toEqual(Array(4).fill(0x5a));
      }
      expect(buffers.size).toBe(1);
      kernel.setPersistentOverlayStorage({ readExactAt(_offset: bigint, bytes: Uint8Array) {
        const backing = bytes.buffer as ArrayBuffer;
        structuredClone(backing, { transfer: [backing] });
      }, len: () => 0, writeAllAt: () => {}, flush: () => {}, truncate: () => {}, close: () => {} });
      expect(imports.env.host_overlay_read(17n, pointer, 4)).toBe(-EIO);
      expect([...new Uint8Array(memory.buffer, 4096, 4)]).toEqual(Array(4).fill(0x5a));
      expect(imports.env.host_image_read(pointer, 4, 0, 0)).toBe(4);
      expect([...new Uint8Array(memory.buffer, 4096, 4)]).toEqual(Array(4).fill(0x39));
    } finally { warning.mockRestore(); }
  });

  it.each([4, 8] as const)("replaces provider-detached image scratch and permits a later retry for width %s", width => {
    for (const result of [-EIO, 4]) {
      const { kernel, memory } = kernelHarness({}, width);
      const imports = importsOf(kernel, memory);
      const pointer = width === 8 ? 4096n : 4096;
      const destination = new Uint8Array(memory.buffer, 4096, 4);
      destination.fill(0x5a);
      kernel.setRootfsImageProvider((_offset: bigint, staged: Uint8Array) => {
        staged.fill(0xff);
        structuredClone(staged.buffer, { transfer: [staged.buffer] });
        return result;
      });
      expect(imports.env.host_image_read(pointer, 4, 0, 0)).toBe(result < 0 ? -EIO : -14);
      expect([...destination]).toEqual([0x5a, 0x5a, 0x5a, 0x5a]);
      const succeeding = vi.fn((_offset: bigint, staged: Uint8Array) => { staged.fill(0x39); return staged.byteLength; });
      kernel.setRootfsImageProvider(succeeding);
      expect(imports.env.host_image_read(pointer, 4, 0, 0)).toBe(4);
      expect([...destination]).toEqual([0x39, 0x39, 0x39, 0x39]);
      expect(succeeding).toHaveBeenCalledOnce();
    }
  });

  it.each([4, 8] as const)("reuses one cleared image staging backing without lending kernel memory for width %s", width => {
    const { kernel, memory } = kernelHarness({}, width);
    const imports = importsOf(kernel, memory);
    const buffers = new Set<ArrayBufferLike>();
    let retained: Uint8Array | undefined;
    kernel.setRootfsImageProvider((_offset: bigint, staged: Uint8Array) => {
      expect(staged.buffer).not.toBe(memory.buffer);
      expect(new Uint8Array(staged.buffer).every(value => value === 0)).toBe(true);
      buffers.add(staged.buffer);
      retained = staged;
      staged.fill(0x39);
      return staged.byteLength;
    });
    const pointer = width === 8 ? 4096n : 4096;
    for (let count = 0; count < 100; count += 1) {
      expect(imports.env.host_image_read(pointer, 4096, count, 0)).toBe(4096);
      retained!.fill(0xff);
      expect(new Uint8Array(memory.buffer, 4096, 4096).every(value => value === 0x39)).toBe(true);
    }
    expect(buffers.size).toBe(1);
    expect(imports.env.host_image_read(pointer, 65537, 0, 0)).toBe(65537);
    expect(buffers.size).toBe(2);
  });

  it.each([4, 8] as const)("refuses nested image scratch reuse without disturbing its outer read for width %s", width => {
    const { kernel, memory } = kernelHarness({}, width);
    const imports = importsOf(kernel, memory);
    const pointer = width === 8 ? 4096n : 4096;
    const nestedPointer = width === 8 ? 8192n : 8192;
    new Uint8Array(memory.buffer, 8192, 4).fill(0x5a);
    kernel.setRootfsImageProvider((_offset: bigint, staged: Uint8Array) => {
      staged.fill(0x39);
      expect(imports.env.host_image_read(nestedPointer, 4, 0, 0)).toBe(-EIO);
      return staged.byteLength;
    });
    expect(imports.env.host_image_read(pointer, 4, 0, 0)).toBe(4);
    expect([...new Uint8Array(memory.buffer, 4096, 4)]).toEqual([0x39, 0x39, 0x39, 0x39]);
    expect([...new Uint8Array(memory.buffer, 8192, 4)]).toEqual([0x5a, 0x5a, 0x5a, 0x5a]);
  });

  it.each([4, 8] as const)("keeps storage-read failures atomic and diagnostics bounded across slots for pointer width %s", width => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const [setter, imported] of [
        ["setPersistentOverlayStorage", "host_overlay_read"],
        ["setPersistentOverlayTargetStorage", "host_overlay_target_read"],
        ["setPersistentOverlayCompactionStorage", "host_overlay_compaction_read"],
      ]) {
        const { kernel, memory } = kernelHarness({}, width);
        const imports = importsOf(kernel, memory);
        const destination = new Uint8Array(memory.buffer, 4096, 4);
        destination.fill(0x5a);
        kernel[setter!]({ readExactAt(_offset: bigint, staged: Uint8Array) {
          staged.fill(0xff);
          throw Object.assign(new Error("storage read failed"), { code: "EIO" });
        } });
        const pointer = width === 8 ? 4096n : 4096;
        expect(imports.env[imported!]!(17n, pointer, 4)).toBe(-EIO);
        expect(imports.env[imported!]!(18n, pointer, 4)).toBe(-EIO);
        expect([...destination]).toEqual([0x5a, 0x5a, 0x5a, 0x5a]);
      }
      expect(warning).toHaveBeenCalledTimes(3);
    } finally { warning.mockRestore(); }
  });

  it.each([4, 8] as const)("reports one image-provider failure without publishing partial bytes for pointer width %s", width => {
    const { kernel, memory } = kernelHarness({}, width);
    const imports = importsOf(kernel, memory);
    const destination = new Uint8Array(memory.buffer, 4096, 4);
    destination.fill(0x5a);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("diagnostic failure"); });
    try {
      kernel.setRootfsImageProvider((_offset: bigint, staged: Uint8Array) => {
        staged.fill(0xff);
        throw new Error("image transport failed");
      });
      const pointer = width === 8 ? 4096n : 4096;
      expect(imports.env.host_image_read(pointer, 4, 1, 1)).toBe(-EIO);
      expect(imports.env.host_image_read(pointer, 4, 2, 1)).toBe(-EIO);
      expect([...destination]).toEqual([0x5a, 0x5a, 0x5a, 0x5a]);
      expect(warning).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("provider failed at byte 4294967297 for 4 bytes"));
    } finally { warning.mockRestore(); }
  });

  it("reports ENOSYS when no deferred provider is installed", () => {
    const { kernel, memory } = kernelHarness();
    const imports = importsOf(kernel, memory);

    const [uriPtr, uriLen] = writeUri(memory, "https://example.invalid/a.zip");
    expect(imports.env.host_fetch_deferred(uriPtr, uriLen, 4096, 4, 0, 0))
      .toBe(-ENOSYS);
  });

  it("passes the address through to the provider verbatim", () => {
    const { kernel, memory } = kernelHarness();
    const imports = importsOf(kernel, memory);
    const seen: string[] = [];
    kernel.setRootfsDeferredProvider((uri: string) => {
      seen.push(uri);
      return 0;
    });

    // There is no `kind` and no id. A lazy file and an archive are the same
    // request at different addresses, so what this seam must carry is the
    // address and nothing else — and it must carry it UNCHANGED, because the
    // host has no table to repair a mangled one against.
    for (const uri of [
      "https://example.invalid/file.wasm",
      "https://example.invalid/archive.zip",
      // Non-ASCII and a query string: the seam is bytes, not a parsed URL.
      "https://example.invalid/caf\u00e9.wasm?v=2&x=%20",
    ]) {
      const [p, l] = writeUri(memory, uri);
      imports.env.host_fetch_deferred(p, l, 4096, 4, 0, 0);
    }

    expect(seen).toEqual([
      "https://example.invalid/file.wasm",
      "https://example.invalid/archive.zip",
      "https://example.invalid/caf\u00e9.wasm?v=2&x=%20",
    ]);
  });

  it("reassembles the full 64-bit offset, so a read past 4 GiB is not truncated", () => {
    const { kernel, memory } = kernelHarness();
    const imports = importsOf(kernel, memory);
    const seen: bigint[] = [];
    kernel.setRootfsDeferredProvider((_uri: string, offset: bigint) => {
      seen.push(offset);
      return 0;
    });

    const [p, l] = writeUri(memory, "https://example.invalid/big.bin");
    imports.env.host_fetch_deferred(p, l, 4096, 4, 9, 0);
    imports.env.host_fetch_deferred(p, l, 4096, 4, 5, 1);

    expect(seen).toEqual([9n, 0x1_0000_0005n]);
  });

  it("stages installed provider bytes into the destination exactly once", () => {
    const { kernel, memory } = kernelHarness();
    const imports = importsOf(kernel, memory);
    let retained: Uint8Array | undefined;
    const provider = vi.fn((
      uri: string,
      offset: bigint,
      dest: Uint8Array,
    ) => {
      expect(uri).toBe("https://example.invalid/a.zip");
      expect(offset).toBe(0n);
      retained = dest;
      dest.set([0x41, 0x42]);
      return 2;
    });
    kernel.setRootfsDeferredProvider(provider);

    const [uriPtr, uriLen] = writeUri(memory, "https://example.invalid/a.zip");
    expect(imports.env.host_fetch_deferred(uriPtr, uriLen, 4096, 4, 0, 0))
      .toBe(2);
    expect(provider).toHaveBeenCalledOnce();
    expect(new Uint8Array(memory.buffer, 4096, 4))
      .toEqual(new Uint8Array([0x41, 0x42, 0, 0]));

    // Bytes are staged and published once, never lent live: mutating the
    // provider's own buffer after the call must not retroactively change
    // published kernel memory.
    retained![0] = 0x7f;
    expect(new Uint8Array(memory.buffer, 4096, 2))
      .toEqual(new Uint8Array([0x41, 0x42]));
  });

  it("passes a provider-reported negative errno through unchanged", () => {
    const { kernel, memory } = kernelHarness();
    const imports = importsOf(kernel, memory);
    kernel.setRootfsDeferredProvider(() => -EPERM);

    const [uriPtr, uriLen] = writeUri(memory, "https://example.invalid/a.zip");
    expect(imports.env.host_fetch_deferred(uriPtr, uriLen, 4096, 4, 0, 0))
      .toBe(-EPERM);
  });

  it("rejects a provider result exceeding the destination capacity as EIO without publishing bytes", () => {
    const { kernel, memory } = kernelHarness();
    const imports = importsOf(kernel, memory);
    kernel.setRootfsDeferredProvider((
      _uri: string,
      _offset: bigint,
      dest: Uint8Array,
    ) => {
      dest.fill(0x6b);
      return dest.byteLength + 1;
    });
    const [uriPtr, uriLen] = writeUri(memory, "https://example.invalid/a.zip");
    new Uint8Array(memory.buffer, 4096, 8).fill(0xa5);

    expect(imports.env.host_fetch_deferred(uriPtr, uriLen, 4096, 4, 0, 0))
      .toBe(-EIO);
    expect(new Uint8Array(memory.buffer, 4096, 8))
      .toEqual(new Uint8Array(8).fill(0xa5));
  });
});
