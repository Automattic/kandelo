import { describe, it, expect, afterEach } from "vitest";
import {
  DEFAULT_MOUNT_SPEC,
  buildMountTable,
} from "../../src/vfs/default-mounts";
import {
  resolveForNode,
  createNodeSession,
  destroyNodeSession,
  type NodeSession,
} from "../../src/platform/node-mount-resolver";
import {
  resolveForBrowser,
  createBrowserSession,
} from "../../src/platform/browser-mount-resolver";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";

function buildTinyImage(): ArrayBuffer {
  const sab = new SharedArrayBuffer(256 * 1024);
  const mfs = MemoryFileSystem.create(sab);
  mfs.mkdirWithOwner("/etc", 0o755, 0, 0);
  mfs.createFileWithOwner(
    "/etc/passwd",
    0o644,
    0,
    0,
    new TextEncoder().encode("root:x:0:0:root:/root:/bin/sh\n"),
  );
  // saveImage returns a Promise — but it's sync-friendly (doesn't await anything
  // unless materializeAll is set). For tests we synchronously block.
  return mfs.saveImage().then(
    (img) => img.buffer.slice(img.byteOffset, img.byteOffset + img.byteLength),
  ) as unknown as ArrayBuffer;
}

describe("DEFAULT_MOUNT_SPEC + resolvers", () => {
  it("covers the canonical Unix mount points", () => {
    const paths = DEFAULT_MOUNT_SPEC.map((s) => s.path);
    expect(paths).toContain("/etc");
    expect(paths).toContain("/tmp");
    expect(paths).toContain("/home/user");
    expect(paths).toContain("/var/tmp");
    expect(paths).toContain("/root");
  });

  it("marks /etc as image-backed and read-only", () => {
    const etc = DEFAULT_MOUNT_SPEC.find((s) => s.path === "/etc")!;
    expect(etc.source).toBe("image");
    expect(etc.readonly).toBe(true);
  });

  it("marks /tmp and /var/run as ephemeral scratch", () => {
    expect(DEFAULT_MOUNT_SPEC.find((s) => s.path === "/tmp")).toMatchObject({
      source: "scratch",
      ephemeral: true,
    });
    expect(DEFAULT_MOUNT_SPEC.find((s) => s.path === "/var/run")).toMatchObject({
      source: "scratch",
      ephemeral: true,
    });
  });

  describe("Node resolver", () => {
    let session: NodeSession | null = null;

    afterEach(() => {
      if (session) {
        destroyNodeSession(session);
        session = null;
      }
    });

    it("builds image-backed mounts from the rootfs MemoryFileSystem", async () => {
      const sab = new SharedArrayBuffer(256 * 1024);
      const mfs = MemoryFileSystem.create(sab);
      mfs.mkdirWithOwner("/etc", 0o755, 0, 0);
      mfs.createFileWithOwner("/etc/passwd", 0o644, 0, 0, new TextEncoder().encode("root:x:0:0::/:/bin/sh\n"));
      const img = await mfs.saveImage();

      session = createNodeSession(img.buffer.slice(img.byteOffset, img.byteOffset + img.byteLength));
      const table = buildMountTable(DEFAULT_MOUNT_SPEC, (s) => resolveForNode(s, session!));

      const r = table.resolve("/etc/passwd")!;
      expect(r.entry.mount).toBe("/etc");
      const st = r.entry.backend.stat(r.subPath);
      expect(st.mode & 0o777).toBe(0o644);
      expect(st.uid).toBe(0);
    });

    it("builds scratch mounts as HostDirBackend on per-mount session dirs", () => {
      session = createNodeSession(null);
      // Filter spec to just scratch so we don't need the rootfs image
      const scratchOnly = DEFAULT_MOUNT_SPEC.filter((s) => s.source === "scratch");
      const table = buildMountTable(scratchOnly, (s) => resolveForNode(s, session!));

      const r = table.resolve("/tmp/foo")!;
      // Writing should land on the session scratch dir
      const fd = r.entry.backend.open("/foo", 0x0001 | 0x0040 | 0x0200, 0o644);
      r.entry.backend.write(fd, new TextEncoder().encode("hi"), null, 2);
      r.entry.backend.close(fd);

      const st = r.entry.backend.stat("/foo");
      expect(st.uid).toBe(1000);
    });

    it("destroying the session removes the scratch dir", () => {
      session = createNodeSession(null);
      const dir = session.scratchDir;
      const fs = require("node:fs");
      expect(fs.existsSync(dir)).toBe(true);
      destroyNodeSession(session);
      expect(fs.existsSync(dir)).toBe(false);
      session = null;
    });

    it("refuses image-backed mounts if no image was loaded", () => {
      session = createNodeSession(null);
      expect(() =>
        buildMountTable(DEFAULT_MOUNT_SPEC, (s) => resolveForNode(s, session!)),
      ).toThrow(/requires the rootfs image/);
    });
  });

  describe("Browser resolver", () => {
    it("builds all mounts as MemFsBackend (image or scratch)", async () => {
      const sab = new SharedArrayBuffer(256 * 1024);
      const mfs = MemoryFileSystem.create(sab);
      mfs.mkdirWithOwner("/etc", 0o755, 0, 0);
      mfs.createFileWithOwner("/etc/passwd", 0o644, 0, 0, new TextEncoder().encode("root:x:0:0::/:/bin/sh\n"));
      const img = await mfs.saveImage();

      const session = createBrowserSession(
        img.buffer.slice(img.byteOffset, img.byteOffset + img.byteLength),
      );
      const table = buildMountTable(DEFAULT_MOUNT_SPEC, (s) => resolveForBrowser(s, session));

      const etc = table.resolve("/etc/passwd")!;
      expect(etc.entry.backend.stat(etc.subPath).uid).toBe(0);

      const tmp = table.resolve("/tmp")!;
      // Scratch is a fresh empty MFS — stat of / works as the root dir
      const st = tmp.entry.backend.stat("/");
      expect(st.mode & 0o170000).toBe(0o040000); // S_IFDIR
    });
  });

  it("callers can override the spec selectively before handing to buildMountTable", () => {
    const overridden = DEFAULT_MOUNT_SPEC.map((s) =>
      s.path === "/tmp" ? { ...s, ephemeral: false } : s,
    );
    const tmp = overridden.find((s) => s.path === "/tmp")!;
    expect(tmp.ephemeral).toBe(false);
    // And the original wasn't mutated
    expect(DEFAULT_MOUNT_SPEC.find((s) => s.path === "/tmp")!.ephemeral).toBe(true);
  });
});
