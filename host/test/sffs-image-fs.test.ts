import { describe, expect, it } from "vitest";

import { SffsImageFs, SffsImageError } from "../../images/vfs/lib/sffs-image-fs";

/**
 * The bridge driven the way a builder drives it.
 *
 * These tests matter beyond coverage: the module's own tests run NATIVELY, so
 * they exercise the ABI's shape but not its wasm calling convention or the
 * marshalling across the boundary. An earlier ABI bug — pointers typed `u32`,
 * which truncate on a 64-bit native test — was only visible because the Rust
 * tests ran off-target. This is the other half of that check: the same entry
 * points, reached through real wasm, from the language that will call them.
 */
describe("SffsImageFs", () => {
  it("builds a tree and reads it back", () => {
    const fs = SffsImageFs.create();

    fs.mkdir("/etc", 0o755);
    fs.writeFile("/etc/passwd", new TextEncoder().encode("root:x:0:0::/root:/bin/sh\n"), 0o644);
    fs.symlink("passwd", "/etc/pw-link");
    // PARENTS, not the leaf: /usr and /usr/local are created, /usr/local/bin
    // is left to the caller's own mkdir. The Rust doc says "every missing
    // parent of `path`"; this expectation was 3 until the test disagreed.
    expect(fs.ensureDirRecursive("/usr/local/bin", 0o755)).toBe(2);

    const st = fs.lstat("/etc/passwd");
    expect(st.mode & 0o7777).toBe(0o644);
    expect(st.size).toBe(26);

    expect(new TextDecoder().decode(fs.readFile("/etc/passwd"))).toBe(
      "root:x:0:0::/root:/bin/sh\n",
    );
    expect(fs.readlink("/etc/pw-link")).toBe("passwd");
    expect(fs.readdir("/etc").sort()).toEqual(["passwd", "pw-link"]);
  });

  it("reports metadata changes through chmod and chown", () => {
    const fs = SffsImageFs.create();
    fs.mkdir("/opt", 0o700, 1, 2);
    fs.chmod("/opt", 0o751);
    fs.chown("/opt", 5, -1);

    const st = fs.lstat("/opt");
    expect(st.mode & 0o7777).toBe(0o751);
    expect(st.uid).toBe(5);
    expect(st.gid).toBe(2);
  });

  it("clears setuid on chown when asked, and not otherwise", () => {
    const fs = SffsImageFs.create();
    fs.mkdir("/keep", 0o755);
    fs.chmod("/keep", 0o4755);
    fs.chown("/keep", 1, 1);
    expect(fs.lstat("/keep").mode & 0o7777).toBe(0o4755);

    fs.mkdir("/drop", 0o755);
    fs.chmod("/drop", 0o4755);
    fs.chown("/drop", 1, 1, true);
    expect(fs.lstat("/drop").mode & 0o7777).toBe(0o0755);
  });

  it("throws a named errno rather than a number", () => {
    const fs = SffsImageFs.create();
    let caught: unknown;
    try {
      fs.lstat("/absent");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SffsImageError);
    // The name comes from the GENERATED errno table, not a hand-written map.
    expect((caught as Error).message).toContain("ENOENT");
    expect((caught as Error).message).toContain("/absent");
  });

  it("registers a lazy file whose metadata is readable before any fetch", () => {
    const fs = SffsImageFs.create();
    fs.mkdir("/usr", 0o755);
    fs.registerLazyFile({
      path: "/usr/big",
      archiveId: 3,
      sourcePath: "members/big.bin",
      size: 99_999,
      mode: 0o755,
      ino: 40,
    });
    const st = fs.lstat("/usr/big");
    expect(st.size).toBe(99_999);
    expect(st.mode & 0o7777).toBe(0o755);
  });

  it("survives an allocation large enough to grow the module's memory", () => {
    // The bridge takes a FRESH memory view on every access because sm_alloc can
    // grow linear memory and detach older views. A cached view is the classic
    // wasm bridge bug: correct until the first growing allocation.
    const fs = SffsImageFs.create();
    const big = new Uint8Array(4 * 1024 * 1024).fill(0x41);
    fs.writeFile("/big", big, 0o644);
    const back = fs.readFile("/big");
    expect(back.byteLength).toBe(big.byteLength);
    expect(back[0]).toBe(0x41);
    expect(back[back.byteLength - 1]).toBe(0x41);
  });

  it("gives each instance an independent tree", () => {
    const a = SffsImageFs.create();
    a.mkdir("/only-in-a", 0o755);
    const b = SffsImageFs.create();
    expect(() => b.lstat("/only-in-a")).toThrow();
    expect(a.lstat("/only-in-a").mode & 0o7777).toBe(0o755);
  });
});
