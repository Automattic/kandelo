import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { ensureDirRecursive } from "../../src/vfs/image-helpers";

describe("uid/gid round-trip through image", () => {
  it("saveImage + fromImage preserves uid/gid", async () => {
    const sab1 = new SharedArrayBuffer(1024 * 1024);
    const fs1 = MemoryFileSystem.create(sab1);
    ensureDirRecursive(fs1, "/etc");
    fs1.createFileWithOwner(
      "/etc/passwd",
      0o644,
      0,
      0,
      new TextEncoder().encode("root:x:0:0:root:/root:/bin/sh\n"),
    );
    ensureDirRecursive(fs1, "/home");
    fs1.mkdirWithOwner("/home/alice", 0o755, 1000, 1000);

    const image = await fs1.saveImage();
    const fs2 = MemoryFileSystem.fromImage(image);

    const stPasswd = fs2.stat("/etc/passwd");
    expect(stPasswd.uid).toBe(0);
    expect(stPasswd.gid).toBe(0);

    const stHome = fs2.stat("/home/alice");
    expect(stHome.uid).toBe(1000);
    expect(stHome.gid).toBe(1000);
  });

  it("preserves distinctive non-default uid/gid pair through round-trip", async () => {
    // Picks values unlikely to ever be a default (4242:5353) so a buggy
    // saveImage that zero-fills the new INO_UID/INO_GID bytes can't pass
    // by accident. If this test ever passes against a stub that returns
    // {uid:0,gid:0}, that stub would have to be very specifically wrong.
    const sab1 = new SharedArrayBuffer(1024 * 1024);
    const fs1 = MemoryFileSystem.create(sab1);
    fs1.createFileWithOwner(
      "/marker",
      0o600,
      4242,
      5353,
      new TextEncoder().encode("hi"),
    );

    const image = await fs1.saveImage();
    const fs2 = MemoryFileSystem.fromImage(image);

    const st = fs2.stat("/marker");
    expect(st.uid).toBe(4242);
    expect(st.gid).toBe(5353);
    expect(st.mode & 0o777).toBe(0o600);
    expect(st.size).toBe(2);
  });

  it("survives load → mutate → save → load (round-trip in both directions)", async () => {
    // Guards against an asymmetry where the first save preserves uid/gid
    // but a save performed on a freshly-loaded image drops them (e.g. if
    // adaptStat were ever the only path that propagates them and a future
    // refactor took a shortcut on re-serialization).
    const sab1 = new SharedArrayBuffer(1024 * 1024);
    const fs1 = MemoryFileSystem.create(sab1);
    fs1.createFileWithOwner(
      "/file",
      0o644,
      0,
      0,
      new TextEncoder().encode("data"),
    );

    const image1 = await fs1.saveImage();
    const fs2 = MemoryFileSystem.fromImage(image1);

    // Mutate in fs2 (post-load) and round-trip again.
    fs2.chown("/file", 7777, 8888);
    const image2 = await fs2.saveImage();
    const fs3 = MemoryFileSystem.fromImage(image2);

    const st = fs3.stat("/file");
    expect(st.uid).toBe(7777);
    expect(st.gid).toBe(8888);
  });
});
