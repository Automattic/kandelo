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
 * `normalizeLegacyRootfs` is gone: it patched a `nobody` line into `/etc/group`
 * for already-published demo images, every image builder emits that line, and
 * re-implementing a demo-image patch inside the kernel is exactly the
 * package-specific platform behaviour the values contract forbids. The
 * remaining two are covered here.
 *
 * This file answers a stronger question than the ordering one, at runtime,
 * with the real functions: **the mutations do not touch the image buffer
 * at all.** `MemoryFileSystem.fromImage` copies the image into a freshly
 * allocated SharedArrayBuffer, and each mutation is an ordinary
 * `mkdir`/`open`/`write` call against that restored filesystem. The image
 * bytes the kernel would read are a different buffer, and the host never
 * writes to it.
 *
 * That makes the ordering moot for image reads rather than merely satisfied:
 * a cursor over the image needs no `Atomics` discipline, whenever it runs,
 * because nothing on the host mutates what it reads. The property the cursor
 * DOES depend on is stated as an obligation below and asserted here, so a
 * future change that points the cursor at the live SharedFS SAB — where the
 * host genuinely does write, including after boot, when lazy content is
 * materialized into a stub — fails this test instead of racing silently.
 *
 * The last test records the flip side truthfully: because the mutations land
 * only in the restored filesystem, a kernel that parses the raw image sees
 * none of them. That is the open issue D-B5. It blocks the CUTOVER (making the
 * kernel the reader), not the dual-write, and it is asserted here so it stays
 * a visible, tested fact rather than a note in a plan.
 */

import { describe, expect, it } from "vitest";

import {
  ensureMountParentDirectories,
  restoreVerifiedImageMounts,
} from "../../src/vfs/default-mounts";
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
 * An image shaped so both remaining host mutations actually fire: no
 * `/usr/local/lib` (so `ensureMountParentDirectories` creates it) and no
 * `/etc/ssl/certs` (so the browser certificate write creates the chain).
 */
async function buildImage(): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(2 * 1024 * 1024));
  fs.mkdir("/usr", 0o755);
  return await fs.saveImage();
}

/** Exactly what `browser-kernel-worker-entry.ts` does with the MITM CA cert. */
function writeBrowserCaCertificate(memfs: MemoryFileSystem): void {
  for (const dir of ["/etc", "/etc/ssl", "/etc/ssl/certs"]) {
    try {
      memfs.mkdir(dir, 0o755);
    } catch {
      /* exists */
    }
  }
  writeText(memfs, "/etc/ssl/certs/ca-certificates.crt", "-----BEGIN CERT-----\n");
}

describe("host mutations and the image bytes a kernel cursor would read", () => {
  it("leaves the image byte-for-byte unchanged while mutating the restored filesystem", async () => {
    const image = await buildImage();
    const pristine = image.slice();

    const spec: MountSpec[] = [{ path: "/", source: "image" }];
    const restored = await restoreVerifiedImageMounts(spec, image);
    const memfs = restored.get(spec[0]);
    expect(memfs, "the `/` image mount was restored").toBeDefined();

    // Mutation 1.
    ensureMountParentDirectories(memfs!, ["/usr/local/lib/kandelo"]);
    expect(memfs!.stat("/usr/local/lib").mode & 0xf000).toBe(0x4000);

    // Mutation 2.
    writeBrowserCaCertificate(memfs!);
    expect(readText(memfs!, "/etc/ssl/certs/ca-certificates.crt")).toContain(
      "BEGIN CERT",
    );

    // The obligation the cursor rests on: none of that reached the image.
    expect(image).toEqual(pristine);
  });

  it("is not vacuous: the same mutations do change the restored filesystem's bytes", async () => {
    // If restore aliased the image instead of copying it, the assertion above
    // would pass only because the mutations had failed. Prove they land
    // somewhere by re-saving and observing a different image.
    const image = await buildImage();
    const spec: MountSpec[] = [{ path: "/", source: "image" }];
    const restored = await restoreVerifiedImageMounts(spec, image);
    const memfs = restored.get(spec[0])!;
    ensureMountParentDirectories(memfs, ["/usr/local/lib/kandelo"]);
    writeBrowserCaCertificate(memfs);

    const resaved = await memfs.saveImage();
    expect(resaved).not.toEqual(image);
    const reloaded = MemoryFileSystem.fromImage(resaved);
    expect(readText(reloaded, "/etc/ssl/certs/ca-certificates.crt")).toContain(
      "BEGIN CERT",
    );
  });

  it("records D-B5: a reader of the raw image sees neither remaining mutation", async () => {
    // The truthful consequence of the property above, asserted rather than
    // assumed. A kernel that parses the image directly sees no
    // `/usr/local/lib` and no CA certificate in the IMAGE.
    //
    // The parent-directory half is no longer a gap in the running system: the
    // kernel now synthesises a foreign mount's ancestors itself when the host
    // registers the prefix (`rootfs::ensure_foreign_mount_parents`), so a
    // kernel that parses the raw image ends up with `/usr/local/lib` anyway —
    // just not from the image bytes, which is what this test reads. The CA
    // certificate is genuine per-session runtime data that can never be in an
    // image and must become a post-`init` write. Until that lands, this test
    // says exactly what the raw image does and does not carry.
    const image = await buildImage();
    const spec: MountSpec[] = [{ path: "/", source: "image" }];
    const restored = await restoreVerifiedImageMounts(spec, image);
    const memfs = restored.get(spec[0])!;
    ensureMountParentDirectories(memfs, ["/usr/local/lib/kandelo"]);
    writeBrowserCaCertificate(memfs);

    const asTheKernelWouldSeeIt = MemoryFileSystem.fromImage(image);
    expect(() => asTheKernelWouldSeeIt.stat("/usr/local/lib")).toThrow();
    expect(() =>
      asTheKernelWouldSeeIt.stat("/etc/ssl/certs/ca-certificates.crt"),
    ).toThrow();
  });
});
