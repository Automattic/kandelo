/**
 * The kernel parsing its own `/` image must produce the SAME base tree the host
 * produces by walking that image for it.
 *
 * Two ways of building the in-kernel rootfs overlay's base layer are compared
 * against each other, inside a real kernel Wasm instance, over a real production
 * image:
 *
 *  A. `kernel_rootfs_load_manifest` — the path in production today. The host
 *     restores the image into `MemoryFileSystem`, walks the restored tree,
 *     resolves every name, reduces the image's lazy JSON through
 *     `buildRootfsLazyWiring`, and re-encodes the whole thing as an RTFS v3 boot
 *     manifest.
 *
 *  B. `kernel_rootfs_load_image` — the kernel mounting the image's own SFFS
 *     filesystem through a positioned byte window (`env.host_image_read`),
 *     walking it itself, and reading the image's own `KLZY` lazy-linkage
 *     section. The host resolves nothing.
 *
 * The oracle is `kernel_rootfs_export_tree`, the RXPT serialization of the
 * overlay's authoritative tree. It is a real oracle rather than a tautology: the
 * two sides reach it through entirely different code (TypeScript `lstat` over a
 * restored `SharedFS` and a JSON-derived lazy map, versus Rust `sffs.rs` inode
 * reads and a binary `KLZY` decode), and RXPT carries mode, uid, gid, size,
 * inode, symlink target, and times — so a disagreement about any of them fails
 * here rather than surfacing as a wrong `ls -l` months later.
 *
 * Deliberately a FAILURE, not a skip, when its artifacts are absent: a gate that
 * silently passes without its fixtures certifies nothing, and a missing artifact
 * is a provisioning step (`./run.sh setup`), not a boundary.
 *
 * One thing this gate made visible and should keep visible: the image checked in
 * at `host/wasm/rootfs.vfs` PREDATES the `KLZY` section (its container flags are
 * `0x5` — lazy JSON and metadata, no kernel-lazy). The kernel refuses such an
 * image outright, because it cannot tell "no lazy files" from "lazy files
 * recorded only in the host-side JSON I cannot read", and reading it
 * best-effort would produce a tree where every deferred file reports size 0.
 * So this test re-emits the image through the real production writer
 * (`MemoryFileSystem.saveImage`) first — which is what a rebuilt image will be —
 * and asserts the refusal separately. The cutover therefore needs the shipped
 * images rebuilt; it cannot consume today's on-disk artifacts.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { buildRootfsLazyWiring } from "../src/vfs/rootfs-lazy-archives";
import { emitRootfsManifest } from "../src/vfs/rootfs-manifest";
import { VFS_IMAGE_FLAG_HAS_KERNEL_LAZY } from "../src/vfs/kernel-lazy-section";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const imagePath = join(repoRoot, "host/wasm/rootfs.vfs");
const kernelPath = tryResolveBinary("kernel.wasm");

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

  const instance = await WebAssembly.instantiate(module, { env });
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
 * `host/wasm/rootfs.vfs` re-emitted through the production writer, so it carries
 * the `KLZY` section the kernel requires. This is what a rebuilt image looks
 * like; the on-disk artifact predates the section.
 */
async function rebuiltImage(): Promise<Uint8Array> {
  const writer = MemoryFileSystem.fromImagePreservingCapacity(
    new Uint8Array(readFileSync(imagePath)),
  );
  await writer.verifyImportedLazyAtomicGroupSeals();
  return new Uint8Array(await writer.saveImage());
}

describe("in-kernel rootfs base tree: image parse vs host-walked manifest", () => {
  it("has the artifacts the parity oracle needs", () => {
    expect(
      existsSync(imagePath),
      `${imagePath} is missing, so this gate would prove nothing. ` +
        "Run ./run.sh setup to produce it.",
    ).toBe(true);
    expect(
      kernelPath !== null && existsSync(kernelPath),
      "kernel.wasm is missing, so this gate would prove nothing. " +
        "Run ./run.sh setup to produce it.",
    ).toBe(true);
  });

  it("refuses an image that predates the kernel-lazy section", async () => {
    const image = new Uint8Array(readFileSync(imagePath));
    const kernelBytes = new Uint8Array(readFileSync(kernelPath!));
    const flags = new DataView(image.buffer, image.byteOffset).getUint32(8, true);
    expect(
      flags & VFS_IMAGE_FLAG_HAS_KERNEL_LAZY,
      "this assertion is about the pre-KLZY case; rebuild the fixture expectation " +
        "once host/wasm/rootfs.vfs is regenerated with a KLZY section",
    ).toBe(0);

    const kernel = await instantiateKernel(kernelBytes, image);
    expect(
      kernel.exports.kernel_rootfs_load_image(
        image.length >>> 0,
        Math.floor(image.length / 2 ** 32),
      ) as number,
      "a stale image must fail loudly, not build a tree of zero-size files",
    ).toBe(-22); // EINVAL
  });

  it("produces a byte-identical tree from the image and from the manifest", async () => {
    const onDisk = new Uint8Array(readFileSync(imagePath));
    const kernelBytes = new Uint8Array(readFileSync(kernelPath!));

    // Re-emit through the real production writer so the image carries the
    // `KLZY` section a rebuilt image will carry. This exercises `saveImage`,
    // not just the encoder.
    const writer = MemoryFileSystem.fromImagePreservingCapacity(onDisk);
    await writer.verifyImportedLazyAtomicGroupSeals();
    const image = new Uint8Array(await writer.saveImage());
    expect(
      new DataView(image.buffer, image.byteOffset).getUint32(8, true) &
        VFS_IMAGE_FLAG_HAS_KERNEL_LAZY,
      "the re-emitted image must declare a KLZY section",
    ).not.toBe(0);

    // --- B: the kernel parses the image itself. -----------------------------
    const fromImage = await instantiateKernel(kernelBytes, image);
    const loaded = fromImage.exports.kernel_rootfs_load_image(
      image.length >>> 0,
      Math.floor(image.length / 2 ** 32),
    ) as number;
    expect(loaded, "kernel_rootfs_load_image").toBeGreaterThan(0);
    const imageTree = exportTree(fromImage);

    // --- A: the host walks the image and hands over a manifest. -------------
    const fs = MemoryFileSystem.fromImagePreservingCapacity(image);
    await fs.verifyImportedLazyAtomicGroupSeals();
    const { lazyInput } = buildRootfsLazyWiring(
      fs.exportLazyArchiveEntries(),
      async () => {
        throw new Error("no fetch during tree-parity checking");
      },
    );
    const { buffer, entryCount } = emitRootfsManifest(fs, (p) => p, lazyInput);

    const fromManifest = await instantiateKernel(kernelBytes, image);
    const manifestPtr = fromManifest.exports.kernel_alloc_scratch(
      buffer.length,
    ) as number;
    expect(manifestPtr, "kernel_alloc_scratch for the manifest").toBeGreaterThan(
      0,
    );
    new Uint8Array(fromManifest.memory.buffer, manifestPtr, buffer.length).set(
      buffer,
    );
    const manifestLoaded = fromManifest.exports.kernel_rootfs_load_manifest(
      manifestPtr,
      buffer.length,
    ) as number;
    expect(manifestLoaded, "kernel_rootfs_load_manifest").toBe(entryCount);
    const manifestTree = exportTree(fromManifest);

    // --- The comparison. ---------------------------------------------------
    // Entry counts first, so a size mismatch reports as "375 vs 374" rather
    // than as an opaque byte diff.
    expect(rxptEntryCount(imageTree)).toBe(rxptEntryCount(manifestTree));
    expect(loaded).toBe(entryCount);
    expect(imageTree.length).toBe(manifestTree.length);
    expect(Buffer.from(imageTree).equals(Buffer.from(manifestTree))).toBe(true);

    // Non-vacuity: an empty or trivial tree would make the equality above
    // meaningless. `rootfs.vfs` is the shell base image.
    expect(rxptEntryCount(imageTree)).toBeGreaterThan(100);
  });

  it("reads only the part of the image its walk touches", async () => {
    const image = await rebuiltImage();
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
    const image = await rebuiltImage();
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
    const instance = await WebAssembly.instantiate(module, { env });
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
