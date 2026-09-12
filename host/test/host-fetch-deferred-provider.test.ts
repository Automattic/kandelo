import { describe, expect, it, vi } from "vitest";

import {
  createWasmPosixKernelTestHarness,
  WasmPosixKernel,
} from "../src/kernel";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

const ENOSYS = 38;
const EIO = 5;
const EPERM = 1;

const KIND_FILE = 0;
const KIND_ARCHIVE = 1;

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
  it("reports ENOSYS when no deferred provider is installed", () => {
    const { kernel, memory } = kernelHarness();
    const imports = importsOf(kernel, memory);

    expect(imports.env.host_fetch_deferred(KIND_ARCHIVE, 7, 0, 4096, 4, 0, 0))
      .toBe(-ENOSYS);
  });

  it("passes the kind and the full 64-bit id through to the provider", () => {
    const { kernel, memory } = kernelHarness();
    const imports = importsOf(kernel, memory);
    const seen: Array<{ kind: number; id: bigint }> = [];
    kernel.setRootfsDeferredProvider((kind: number, id: bigint) => {
      seen.push({ kind, id });
      return 0;
    });

    imports.env.host_fetch_deferred(KIND_FILE, 9, 0, 4096, 4, 0, 0);
    // A URL-backed lazy file is addressed by its inode number; an archive by
    // its image-assigned id. Both share the one id argument, and the kind is
    // what tells them apart — never a reserved range of the id.
    imports.env.host_fetch_deferred(KIND_ARCHIVE, 9, 0, 4096, 4, 0, 0);
    // lo/hi words reassemble, so an id above 2^32 is not silently truncated.
    imports.env.host_fetch_deferred(KIND_FILE, 5, 1, 4096, 4, 0, 0);

    expect(seen).toEqual([
      { kind: KIND_FILE, id: 9n },
      { kind: KIND_ARCHIVE, id: 9n },
      { kind: KIND_FILE, id: 0x1_0000_0005n },
    ]);
  });

  it("stages installed provider bytes into the destination exactly once", () => {
    const { kernel, memory } = kernelHarness();
    const imports = importsOf(kernel, memory);
    let retained: Uint8Array | undefined;
    const provider = vi.fn((
      kind: number,
      id: bigint,
      offset: bigint,
      dest: Uint8Array,
    ) => {
      expect(kind).toBe(KIND_ARCHIVE);
      expect(id).toBe(7n);
      expect(offset).toBe(0n);
      retained = dest;
      dest.set([0x41, 0x42]);
      return 2;
    });
    kernel.setRootfsDeferredProvider(provider);

    expect(imports.env.host_fetch_deferred(KIND_ARCHIVE, 7, 0, 4096, 4, 0, 0))
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

    expect(imports.env.host_fetch_deferred(KIND_ARCHIVE, 7, 0, 4096, 4, 0, 0))
      .toBe(-EPERM);
  });

  it("rejects a provider result exceeding the destination capacity as EIO without publishing bytes", () => {
    const { kernel, memory } = kernelHarness();
    const imports = importsOf(kernel, memory);
    kernel.setRootfsDeferredProvider((
      _kind: number,
      _id: bigint,
      _offset: bigint,
      dest: Uint8Array,
    ) => {
      dest.fill(0x6b);
      return dest.byteLength + 1;
    });
    new Uint8Array(memory.buffer, 4096, 8).fill(0xa5);

    expect(imports.env.host_fetch_deferred(KIND_ARCHIVE, 7, 0, 4096, 4, 0, 0))
      .toBe(-EIO);
    expect(new Uint8Array(memory.buffer, 4096, 8))
      .toEqual(new Uint8Array(8).fill(0xa5));
  });
});
