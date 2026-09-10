/**
 * SD-B3: is it safe for the kernel to read an image with a lock-free cursor
 * while the host is still running?
 *
 * The doubt was recorded as an ORDERING question — "the three known host
 * mutations (`normalizeLegacyRootfs`, `ensureMountParentDirectories`, and the
 * browser TLS-certificate write) all precede `init`, but that is INFERRED from
 * call ordering and is not proven by a test." A paged cursor re-reads blocks
 * after boot, so it widens whatever window that ordering closes.
 *
 * **The boot cutover closed it by removing the mutations, not by ordering
 * them.** All three are gone from the path between restoring an image and the
 * kernel parsing it:
 *
 *  - `normalizeLegacyRootfs` was deleted. It patched a `nobody` line into
 *    `/etc/group` for already-published demo images; every image builder emits
 *    that line, and re-implementing a demo-image patch inside the kernel is the
 *    package-specific platform behaviour the values contract forbids.
 *  - `ensureMountParentDirectories` was deleted. Making a foreign mount point
 *    reachable is now `rootfs::set_foreign_prefixes`'s job, in the kernel where
 *    the namespace and the permission checks are.
 *  - The browser TLS-certificate write moved to `rootfsWriteFile` after `init`.
 *    It never touches the restored `MemoryFileSystem` at all now — a write there
 *    would land in a tree nothing reads.
 *
 * So the question this file answers is the strong form: **restoring an image
 * leaves both the image bytes AND the restored tree exactly as the image
 * describes them.** The cursor needs no `Atomics` discipline, whenever it runs,
 * because nothing on the host changes what it reads or what it means.
 *
 * The last test keeps the underlying property honest rather than assuming it:
 * `MemoryFileSystem.fromImage` COPIES into a fresh SharedArrayBuffer, so even a
 * deliberate mutation of the restored filesystem cannot reach the image. A
 * future change that points the cursor at the live SharedFS SAB — where the host
 * genuinely does write, including after boot, when lazy content is materialized
 * into a stub — fails here instead of racing silently.
 */

import { describe, expect, it } from "vitest";

import { restoreVerifiedImageMounts } from "../../src/vfs/default-mounts";
import type { MountSpec } from "../../src/vfs/default-mounts";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";

const O_WRONLY_CREAT_TRUNC = 0o1101;

function writeText(fs: MemoryFileSystem, path: string, text: string): void {
  const bytes = new TextEncoder().encode(text);
  const fd = fs.open(path, O_WRONLY_CREAT_TRUNC, 0o644);
  try {
    fs.write(fd, bytes, null, bytes.byteLength);
  } finally {
    fs.close(fd);
  }
}

function readText(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    fs.read(fd, bytes, null, bytes.byteLength);
  } finally {
    fs.close(fd);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * An image shaped like the ones the deleted mutations used to "fix": an
 * `/etc/group` with no `nobody` line, no `/usr/local/lib`, and no
 * `/etc/ssl/certs`. Nothing may quietly repair any of it.
 */
async function buildImage(): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(2 * 1024 * 1024));
  fs.mkdir("/etc", 0o755);
  writeText(fs, "/etc/group", "root:x:0:\n");
  fs.mkdir("/usr", 0o755);
  return await fs.saveImage();
}

describe("restoring a `/` image for a kernel that parses it", () => {
  it("leaves the image byte-for-byte unchanged", async () => {
    const image = await buildImage();
    const pristine = image.slice();

    const spec: MountSpec[] = [{ path: "/", source: "image" }];
    const restored = await restoreVerifiedImageMounts(spec, image);
    expect(restored.get(spec[0]), "the `/` image mount was restored").toBeDefined();

    expect(image).toEqual(pristine);
  });

  it("restores exactly what the image describes, repairing nothing", async () => {
    // The kernel builds its tree from these bytes. If the host quietly amended
    // the restored copy, the host and the kernel would disagree about `/` — and
    // the host's copy is the one no longer consulted for the tree, so the
    // amendment would silently do nothing at all. Asserting the absence keeps a
    // re-added "compatibility" patch from becoming an invisible no-op.
    const image = await buildImage();
    const spec: MountSpec[] = [{ path: "/", source: "image" }];
    const restored = await restoreVerifiedImageMounts(spec, image);
    const memfs = restored.get(spec[0])!;

    expect(readText(memfs, "/etc/group")).not.toContain("nobody:");
    expect(() => memfs.stat("/usr/local")).toThrow();
    expect(() => memfs.stat("/etc/ssl/certs")).toThrow();
  });

  it("is not vacuous: the restore is a copy, so a mutation cannot reach the image", async () => {
    // If restore aliased the image instead of copying it, the first test would
    // pass only because nothing had been written. Write deliberately, and show
    // the bytes land somewhere else.
    const image = await buildImage();
    const pristine = image.slice();
    const spec: MountSpec[] = [{ path: "/", source: "image" }];
    const restored = await restoreVerifiedImageMounts(spec, image);
    const memfs = restored.get(spec[0])!;

    memfs.mkdir("/usr/local", 0o755);
    writeText(memfs, "/usr/local/marker", "written after restore");

    expect(image).toEqual(pristine);
    const resaved = await memfs.saveImage();
    expect(resaved).not.toEqual(image);
    expect(
      readText(MemoryFileSystem.fromImage(resaved), "/usr/local/marker"),
    ).toBe("written after restore");
  });
});
