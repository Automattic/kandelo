import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildImage } from "../src/builder.ts";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

const here = dirname(fileURLToPath(import.meta.url));

describe("image builder", () => {
  it("builds an image from source tree + manifest", async () => {
    const fixture = join(here, "fixtures", "basic");
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });
    const mfs = MemoryFileSystem.fromImage(image);

    // Directories with honest mode/owner
    const etc = mfs.stat("/etc");
    expect(etc.mode & 0o777).toBe(0o755);
    expect(etc.uid).toBe(0);
    expect(etc.gid).toBe(0);

    const tmp = mfs.stat("/tmp");
    expect(tmp.mode & 0o7777).toBe(0o1777);

    const alice = mfs.stat("/home/alice");
    expect(alice.mode & 0o777).toBe(0o700);
    expect(alice.uid).toBe(1000);
    expect(alice.gid).toBe(1000);

    // File content + mode + owner
    const passwd = mfs.stat("/etc/passwd");
    expect(passwd.mode & 0o777).toBe(0o644);
    expect(passwd.uid).toBe(0);
    expect(passwd.gid).toBe(0);

    const fd = mfs.open("/etc/passwd", 0, 0);
    const buf = new Uint8Array(256);
    const n = mfs.read(fd, buf, null, buf.byteLength);
    mfs.close(fd);
    const text = new TextDecoder().decode(buf.subarray(0, n));
    expect(text).toContain("root:x:0:0");
    expect(text).toContain("daemon:x:1:1");
    expect(text).toContain("nobody:x:65534:65534");
  });

  it("resolves explicit src= relative to repoRoot, bypassing sourceTree", async () => {
    const fixture = join(here, "fixtures", "explicit-src");
    const image = await buildImage({
      sourceTree: join(fixture, "rootfs"),
      manifest: join(fixture, "MANIFEST"),
      repoRoot: fixture,
    });
    const mfs = MemoryFileSystem.fromImage(image);

    const st = mfs.stat("/etc/mytool.conf");
    expect(st.mode & 0o777).toBe(0o644);

    const fd = mfs.open("/etc/mytool.conf", 0, 0);
    const buf = new Uint8Array(64);
    const n = mfs.read(fd, buf, null, buf.byteLength);
    mfs.close(fd);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("some config\n");
  });

  it("errors when source tree contains files not declared in manifest", async () => {
    const fixture = join(here, "fixtures", "stray-file");
    await expect(
      buildImage({
        sourceTree: join(fixture, "rootfs"),
        manifest: join(fixture, "MANIFEST"),
        repoRoot: fixture,
      }),
    ).rejects.toThrow(/orphan\.conf.*not in manifest/);
  });
});
