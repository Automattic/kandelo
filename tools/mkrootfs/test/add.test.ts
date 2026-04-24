import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildImage } from "../src/builder.ts";
import { addFile, parseAddArgs } from "../src/add.ts";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

const here = dirname(fileURLToPath(import.meta.url));

describe("add command", () => {
  it("injects a new file with specified mode/uid/gid and creates parent dirs", async () => {
    const fixture = join(here, "fixtures", "basic");
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });

    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-add-"));
    const imagePath = join(tmp, "rootfs.vfs");
    const srcPath = join(tmp, "payload.txt");
    writeFileSync(imagePath, image);
    writeFileSync(srcPath, "injected\n");
    try {
      await addFile({
        image: imagePath,
        vfsPath: "/srv/data/payload",
        srcFile: srcPath,
        mode: 0o600,
        uid: 42,
        gid: 43,
      });

      // Reopen and verify
      const updated = new Uint8Array(readFileSync(imagePath));
      const mfs = MemoryFileSystem.fromImage(updated);
      const st = mfs.stat("/srv/data/payload");
      expect(st.mode & 0o777).toBe(0o600);
      expect(st.uid).toBe(42);
      expect(st.gid).toBe(43);

      const fd = mfs.open("/srv/data/payload", 0, 0);
      const buf = new Uint8Array(32);
      const n = mfs.read(fd, buf, null, buf.byteLength);
      mfs.close(fd);
      expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("injected\n");

      // Parent dirs got default 0755 0:0
      const srv = mfs.stat("/srv");
      expect(srv.mode & 0o777).toBe(0o755);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("overwrites an existing file atomically", async () => {
    const fixture = join(here, "fixtures", "basic");
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-add-overwrite-"));
    const imagePath = join(tmp, "rootfs.vfs");
    const srcPath = join(tmp, "new-passwd");
    writeFileSync(imagePath, image);
    writeFileSync(srcPath, "replaced\n");
    try {
      await addFile({
        image: imagePath,
        vfsPath: "/etc/passwd",
        srcFile: srcPath,
      });
      const updated = new Uint8Array(readFileSync(imagePath));
      const mfs = MemoryFileSystem.fromImage(updated);
      const fd = mfs.open("/etc/passwd", 0, 0);
      const buf = new Uint8Array(16);
      const n = mfs.read(fd, buf, null, buf.byteLength);
      mfs.close(fd);
      expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("replaced\n");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a directory with a file", async () => {
    const fixture = join(here, "fixtures", "basic");
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });
    const tmp = mkdtempSync(join(tmpdir(), "mkrootfs-add-dir-"));
    const imagePath = join(tmp, "rootfs.vfs");
    const srcPath = join(tmp, "x");
    writeFileSync(imagePath, image);
    writeFileSync(srcPath, "x\n");
    try {
      await expect(
        addFile({ image: imagePath, vfsPath: "/etc", srcFile: srcPath }),
      ).rejects.toThrow(/is a directory/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("parseAddArgs handles flags in any order", () => {
    expect(
      parseAddArgs(["img", "/p", "src", "--uid=7", "--mode=0600", "--gid=8"]),
    ).toEqual({
      image: "img",
      vfsPath: "/p",
      srcFile: "src",
      mode: 0o600,
      uid: 7,
      gid: 8,
    });
  });
});
