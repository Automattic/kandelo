import { describe, expect, it } from "vitest";

import { MemoryFileSystem } from "../src/vfs/memory-fs";

const O_RDONLY = 0;
const O_WRONLY = 1;
const O_CREAT = 0o100;
const O_TRUNC = 0o1000;
/** SFFS block size (`host/src/vfs/sharedfs-vendor.ts`). */
const BLOCK_SIZE = 4096;
/** VFSI header: magic, version, flags, body length. */
const VFS_IMAGE_HEADER_SIZE = 16;

function writeFile(fs: MemoryFileSystem, path: string, bytes: Uint8Array): void {
  const handle = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  try {
    expect(fs.write(handle, bytes, null, bytes.byteLength)).toBe(bytes.byteLength);
  } finally {
    fs.close(handle);
  }
}

function readFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const handle = fs.open(path, O_RDONLY, 0);
  try {
    const size = Number(fs.lstat(path).size);
    const buffer = new Uint8Array(size);
    expect(fs.read(handle, buffer, 0, size)).toBe(size);
    return buffer;
  } finally {
    fs.close(handle);
  }
}

/**
 * The kernel now reads an image-backed file's CONTENT out of the `/` image,
 * through its own SFFS reader, for the life of the session — not just during
 * the boot walk. The host therefore keeps the image window open past boot, and
 * serves it from the SFFS body the restored `MemoryFileSystem` already holds
 * (`imageBodyBytes`) rather than from a second retained copy of the container.
 *
 * That is a deliberate widening of the window in which the kernel reads a
 * buffer the host can still write to. `crates/runtime-core/src/sffs.rs`
 * implements none of `SharedFS`'s `Atomics` discipline, so "the host does not
 * mutate what the kernel is reading" must be a PROVEN property, not one
 * inherited as an inference from call ordering. These tests pin it.
 *
 * One half is structural and not something a test can observe: the kernel's
 * reads are synchronous inside one kernel entry, and every host mutation of
 * this buffer is a `MemoryFileSystem` call on the same worker thread, so
 * neither can begin while the other is in progress. What a test CAN pin is the
 * other half, and it is the half that would actually break — that the one host
 * mutation which still happens after boot, materializing a URL-backed lazy
 * file, does not disturb the bytes of any other file in the body.
 */
describe("the `/` image body the kernel reads through", () => {
  const plainBytes = new TextEncoder().encode("image-backed content\n");
  const lazyBytes = new TextEncoder().encode("fetched on demand\n");

  function makeFilesystem(): MemoryFileSystem {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    fs.mkdir("/etc", 0o755);
    writeFile(fs, "/etc/plain", plainBytes);
    fs.registerLazyFile(
      "/etc/lazy",
      "https://example.invalid/lazy.bin",
      lazyBytes.byteLength,
      0o644,
    );
    fs.setLazyFetcher(async () => new Response(lazyBytes));
    return fs;
  }

  it("is a live view of the filesystem buffer, not a snapshot of it", () => {
    // The memory argument for keeping the window open rests on this: one copy
    // of a 16-256 MiB body in the worker, not two. A view that had quietly
    // become a copy would still be correct, but the claim in
    // `KERNEL_IMAGE_WINDOW` would no longer be true, and a browser switching
    // VFS images is where that costs the most.
    const fs = makeFilesystem();

    const first = fs.imageBodyBytes();
    expect(fs.imageBodyBytes().buffer).toBe(first.buffer);
    expect(first.buffer).toBe(fs.sharedBuffer);

    // A write through the filesystem lands in the view taken before it, which
    // a snapshot could not do.
    const probe = new TextEncoder().encode("written after the view was taken\n");
    writeFile(fs, "/etc/later", probe);
    expect(fs.imageBodyBytes().buffer).toBe(first.buffer);
  });

  it("is the same bytes a saved image carries as its body section", async () => {
    // The kernel addresses bytes by their offset in the CONTAINER and the host
    // serves them from the body at `VFS_IMAGE_HEADER_SIZE`. That rebasing is
    // only correct because an image's body section IS this buffer.
    const fs = makeFilesystem();
    const image = await fs.saveImage();

    const bodyLength = new DataView(
      image.buffer,
      image.byteOffset,
      image.byteLength,
    ).getUint32(12, true);
    const body = fs.imageBodyBytes();
    expect(bodyLength).toBe(body.byteLength);

    // `saveImage` quiesces runtime state (lock words, the fd table, open
    // counts) that a live buffer legitimately carries, and that state lives in
    // the superblock block. Comparing from the next block on is exactly "the
    // region the kernel reads": the inode table and the data blocks.
    expect(image.subarray(VFS_IMAGE_HEADER_SIZE + BLOCK_SIZE, VFS_IMAGE_HEADER_SIZE + bodyLength))
      .toEqual(body.subarray(BLOCK_SIZE));
  });

  it("keeps an image-backed file's bytes byte-identical across a lazy materialization", async () => {
    // The hazard the whole discipline is about: materializing a URL-backed
    // lazy file allocates blocks and writes into the SAME buffer the kernel
    // serves image-backed content from. If that could move or clobber another
    // file's blocks, the kernel would read a wrong tree with no error anywhere.
    const fs = makeFilesystem();

    const before = new Uint8Array(fs.imageBodyBytes()); // detached copy
    expect(readFile(fs, "/etc/plain")).toEqual(plainBytes);

    expect(await fs.preparePath("/etc/lazy")).toBe(true);
    expect(readFile(fs, "/etc/lazy")).toEqual(lazyBytes);

    // The mutation really did land in this buffer — otherwise the assertions
    // below would be vacuous.
    expect(fs.imageBodyBytes()).not.toEqual(before);

    // And the image-backed file came through it untouched, both through this
    // instance and through an INDEPENDENT mount of the post-materialization
    // body, which is the shape the kernel's own SFFS reader addresses it in.
    expect(readFile(fs, "/etc/plain")).toEqual(plainBytes);
    const independent = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    expect(readFile(independent, "/etc/plain")).toEqual(plainBytes);
  });
});
