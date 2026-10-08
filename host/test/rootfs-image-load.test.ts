/**
 * What the kernel does with a production image, and what it refuses.
 *
 * The kernel mounts the image's own KIFS filesystem through a positioned byte
 * window (`kernel_rootfs_load_image`); the host builds no tree. The only walker
 * of an image's KIFS is `kandelo_image_fs.rs`, the code the kernel itself runs,
 * so its tree fidelity is covered by `runtime-core`'s own suite rather than by
 * a host-side comparison of that Rust against itself.
 *
 * What this file asserts is about the kernel alone: an image the kernel must
 * REFUSE, the bound on how much of an image a boot reads, and the errno a host
 * with no image source gets.
 *
 * Deliberately a FAILURE, not a skip, when its artifacts are absent: a gate
 * that silently passes without its fixtures certifies nothing, and a missing
 * artifact is a provisioning step (`./run.sh setup`), not a boundary.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { VFS_IMAGE_FLAG_HAS_KERNEL_LAZY } from "../src/vfs/vfs-image-transport";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const imageDir = join(repoRoot, "local-binaries/source-only-v1/programs/wasm32");
const kernelPath = tryResolveBinary("kernel.wasm");

/**
 * Every production image the repo builds, named explicitly: a glob that
 * silently matched two images would let this gate pass while proving almost
 * nothing.
 */
const PRODUCTION_IMAGES = [
  "rootfs.vfs.zst",
  "shell.vfs.zst",
  "wordpress.vfs.zst",
  "lamp.vfs.zst",
  "nginx-php-vfs.vfs.zst",
  "nginx-python-vfs.vfs.zst",
  "nginx-vfs.vfs.zst",
  "ruby-todo-vfs.vfs.zst",
  "kandelo-sdk.vfs.zst",
  "mariadb-test.vfs.zst",
] as const;

/** Scratch chunk for reading the RXPT export back out of kernel memory. */
const EXPORT_CHUNK = 64 * 1024;

interface KernelUnderTest {
  memory: WebAssembly.Memory;
  exports: Record<string, CallableFunction>;
  /** How many `host_image_read` calls the kernel made, and how much it moved. */
  imageReads: () => { calls: number; bytes: number; highestOffset: number };
}

async function instantiateKernel(
  kernelBytes: Uint8Array,
  image: Uint8Array,
): Promise<KernelUnderTest> {
  const module = await WebAssembly.compile(kernelBytes as BufferSource);
  // Matches `host/src/kernel.ts`'s kernel memory: shared, with headroom above
  // the linker-derived minimum.
  const memory = new WebAssembly.Memory({
    initial: 24,
    maximum: 16384,
    shared: true,
  });

  let calls = 0;
  let bytes = 0;
  let highestOffset = 0;
  const env: Record<string, unknown> = {
    memory,
    // The whole host contract this test needs: a positioned window onto one
    // image. No name resolution, no id.
    host_image_read: (
      bufPtr: number,
      bufLen: number,
      offsetLo: number,
      offsetHi: number,
    ): number => {
      const offset =
        (BigInt.asUintN(32, BigInt(offsetHi)) << 32n) |
        BigInt.asUintN(32, BigInt(offsetLo));
      const start = Number(offset);
      if (start >= image.length) return 0;
      const n = Math.min(bufLen, image.length - start);
      new Uint8Array(memory.buffer, bufPtr, n).set(
        image.subarray(start, start + n),
      );
      calls += 1;
      bytes += n;
      highestOffset = Math.max(highestOffset, start + n);
      return n;
    },
  };
  // Every other import is stubbed. Neither path under test may reach one; if it
  // did, the stub's `0` would show up as a wrong tree rather than as silence.
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== "env" || imp.name === "memory") continue;
    if (env[imp.name] !== undefined) continue;
    env[imp.name] =
      imp.kind === "function"
        ? () => 0
        : imp.kind === "global"
          ? new WebAssembly.Global({ value: "i32", mutable: true }, 0)
          : undefined;
  }

  const instance = await WebAssembly.instantiate(module, { env } as WebAssembly.Imports);
  return {
    memory,
    exports: instance.exports as unknown as Record<string, CallableFunction>,
    imageReads: () => ({ calls, bytes, highestOffset }),
  };
}

/** Read the whole RXPT tree export back out of the kernel. */
function exportTree(kernel: KernelUnderTest): Uint8Array {
  const ptr = kernel.exports.kernel_alloc_scratch(EXPORT_CHUNK) as number;
  expect(ptr, "kernel_alloc_scratch").toBeGreaterThan(0);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const n = kernel.exports.kernel_rootfs_export_tree(
      offset >>> 0,
      Math.floor(offset / 2 ** 32),
      ptr,
      EXPORT_CHUNK,
    ) as number;
    expect(n, "kernel_rootfs_export_tree").toBeGreaterThanOrEqual(0);
    if (n === 0) break;
    chunks.push(new Uint8Array(kernel.memory.buffer, ptr, n).slice());
    offset += n;
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Entry count from the RXPT header (`magic u32 | version u32 | count u32`). */
function rxptEntryCount(tree: Uint8Array): number {
  return new DataView(tree.buffer, tree.byteOffset, tree.byteLength).getUint32(
    8,
    true,
  );
}

/**
 * A production image re-emitted through the production writer, so the gate
 * exercises the real writer rather than trusting the on-disk bytes. Every
 * shipped image is written by `KandeloImageFs`. The load also authenticates
 * the image's activation cohorts.
 */
async function rebuiltImage(name: string): Promise<Uint8Array> {
  const writer = KandeloImageFs.create();
  writer.loadImage(new Uint8Array(readFileSync(join(imageDir, name))));
  return new Uint8Array(await writer.saveImage());
}

/** The container header's flags word (`magic u32 | version u32 | flags u32`). */
function imageFlags(image: Uint8Array): number {
  return new DataView(image.buffer, image.byteOffset).getUint32(8, true);
}

describe("in-kernel rootfs base tree: image parse vs host-walked manifest", () => {
  it("has the artifacts the parity oracle needs", () => {
    expect(
      existsSync(imageDir),
      `${imageDir} is not built, so this gate would prove nothing. ` +
        "Run ./run.sh setup to produce the production images.",
    ).toBe(true);
    const missing = PRODUCTION_IMAGES.filter(
      (name) => !existsSync(join(imageDir, name)),
    );
    expect(missing, "image directory exists but images are missing").toEqual([]);
    expect(
      kernelPath !== null && existsSync(kernelPath),
      "kernel.wasm is missing, so this gate would prove nothing. " +
        "Run ./run.sh setup to produce it.",
    ).toBe(true);
  });

  it("refuses an image that describes its deferred files nowhere", async () => {
    // Built from a real, current image by removing its description of where
    // deferred bytes come from, so the case stays testable after every
    // artifact is rebuilt.
    //
    // A current image describes its deferred files in an in-body `SDEF`
    // section found through a superblock field; the Rust writer never also
    // emits `KLZY` ("emitting `KLZY` as well would put two descriptions in one
    // image"). So the flag is cleared for the images that still carry one, and
    // `deferred_inode` at superblock offset 76 — the field that says "this
    // image carries an `SDEF` section" — is zeroed, which is what actually
    // makes a current image describe its deferred files nowhere. The
    // precondition is asserted on the field the writer really sets, so a
    // future writer change fails here loudly instead of leaving the surgery
    // inert and the refusal untested.
    const image = await rebuiltImage("rootfs.vfs.zst");
    const SB_DEFERRED_INODE = 76;
    const superblock = findSuperblockOffset(image);
    const freshView = new DataView(image.buffer, image.byteOffset);
    expect(
      freshView.getUint32(superblock + SB_DEFERRED_INODE, true),
      "a freshly written image must describe its deferred files somewhere",
    ).not.toBe(0);

    const stale = image.slice();
    const view = new DataView(stale.buffer, stale.byteOffset);
    view.setUint32(8, imageFlags(stale) & ~VFS_IMAGE_FLAG_HAS_KERNEL_LAZY, true);
    view.setUint32(superblock + SB_DEFERRED_INODE, 0, true);

    const kernelBytes = new Uint8Array(readFileSync(kernelPath!));
    const kernel = await instantiateKernel(kernelBytes, stale);
    expect(
      kernel.exports.kernel_rootfs_load_image(
        stale.length >>> 0,
        Math.floor(stale.length / 2 ** 32),
      ) as number,
      "a stale image must fail loudly, not build a tree of zero-size files",
    ).toBe(-22); // EINVAL
  });

  // Per-entry tree fidelity (mode, uid, gid, size, inode, symlink target,
  // times) is `runtime-core`'s suite over `kandelo_image_fs.rs`. The case below
  // still loads one real production image end to end, so a kernel that cannot
  // parse a shipped artifact at all fails here.

  it("reads only the part of the image its walk touches", async () => {
    const image = await rebuiltImage("rootfs.vfs.zst");
    const kernelBytes = new Uint8Array(readFileSync(kernelPath!));
    const kernel = await instantiateKernel(kernelBytes, image);
    expect(
      kernel.exports.kernel_rootfs_load_image(
        image.length >>> 0,
        Math.floor(image.length / 2 ** 32),
      ) as number,
    ).toBeGreaterThan(0);

    const { calls, bytes, highestOffset } = kernel.imageReads();
    expect(calls, "the kernel must actually pull image bytes").toBeGreaterThan(0);
    expect(highestOffset).toBeLessThanOrEqual(image.length);
    // The point of the cursor: a 16-256 MiB image is never made resident in
    // kernel memory. Measured in bytes MOVED, not in how far the cursor reached
    // — the `KLZY` section is the last thing in the container, so the walk does
    // touch the final bytes while reading only a small fraction of the whole.
    // This asserts the shape, not a tuned number: a whole-image read would be a
    // design regression, not merely a slow path.
    expect(bytes).toBeLessThan(image.length / 2);
  });

  it("reports a host with no image source as ENOSYS, not as a corrupt image", async () => {
    const image = await rebuiltImage("rootfs.vfs.zst");
    const kernelBytes = new Uint8Array(readFileSync(kernelPath!));
    const module = await WebAssembly.compile(kernelBytes as BufferSource);
    const memory = new WebAssembly.Memory({
      initial: 24,
      maximum: 16384,
      shared: true,
    });
    const env: Record<string, unknown> = { memory };
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.module !== "env" || imp.name === "memory") continue;
      // A host with the import declared but no image installed answers ENOSYS,
      // exactly as `WasmPosixKernel` does before `setRootfsImageProvider`.
      env[imp.name] =
        imp.kind === "function"
          ? imp.name === "host_image_read"
            ? () => -38
            : () => 0
          : imp.kind === "global"
            ? new WebAssembly.Global({ value: "i32", mutable: true }, 0)
            : undefined;
    }
    const instance = await WebAssembly.instantiate(module, { env } as WebAssembly.Imports);
    const exports = instance.exports as unknown as Record<string, CallableFunction>;
    const result = exports.kernel_rootfs_load_image(
      image.length >>> 0,
      Math.floor(image.length / 2 ** 32),
    ) as number;
    expect(result, "ENOSYS, not EINVAL: the image is fine, the host is unwired").toBe(
      -38,
    );
  });
});

/**
 * Byte offset of the filesystem superblock inside a VFSI container.
 *
 * Found by its magic rather than computed from the header, so this does not
 * silently move when the container's own layout does — a test that edits a
 * superblock field needs to be sure it edited a superblock field.
 */
function findSuperblockOffset(image: Uint8Array): number {
  const magic = [0x4b, 0x49, 0x46, 0x53]; // "KIFS", little-endian u32 0x4B49_4653
  for (let i = 0; i + 4 <= image.length; i += 4) {
    if (magic.every((b, k) => image[i + k] === b)) return i;
  }
  throw new Error("no filesystem superblock magic in this image");
}
