import { describe, expect, it } from "vitest";

import { SffsImageFs, SffsImageError } from "../../images/vfs/lib/sffs-image-fs";
import { writeVfsBinary } from "../src/vfs/image-helpers";
import { OPEN_FLAGS } from "../src/generated/abi";

const O_WRONLY_CREAT_TRUNC =
  OPEN_FLAGS.O_WRONLY | OPEN_FLAGS.O_CREAT | OPEN_FLAGS.O_TRUNC;

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
    expect(fs.readDirNames("/etc").sort()).toEqual(["passwd", "pw-link"]);
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

  it("reads through POSIX-shaped handles, as the helpers do", () => {
    const fs = SffsImageFs.create();
    fs.writeFile("/data", new TextEncoder().encode("hello world"), 0o644);

    // The read loop `vfs-image-helpers.ts` actually uses: open, read with a
    // null position so the cursor advances, close.
    // Read in SMALL CHUNKS on purpose. A single read of the whole file never
    // reuses the cursor, so a version that failed to advance it passed — a
    // mutant that survived until this loop chunked.
    const fd = fs.open("/data", 0, 0);
    const buf = new Uint8Array(11);
    let offset = 0;
    let reads = 0;
    while (offset < buf.length) {
      const n = fs.read(fd, buf.subarray(offset), null, Math.min(4, buf.length - offset));
      expect(n).toBeGreaterThan(0);
      offset += n;
      reads += 1;
    }
    fs.close(fd);
    expect(reads).toBeGreaterThan(1, "the point of this test is multiple reads");
    expect(new TextDecoder().decode(buf)).toBe("hello world");

    // An explicit position does NOT advance the cursor.
    const fd2 = fs.open("/data");
    const two = new Uint8Array(2);
    expect(fs.read(fd2, two, 6, 2)).toBe(2);
    expect(new TextDecoder().decode(two)).toBe("wo");
    expect(fs.read(fd2, two, null, 2)).toBe(2);
    expect(new TextDecoder().decode(two)).toBe("he");
    fs.close(fd2);
  });

  it("iterates directories through opendir/readdir/closedir", () => {
    const fs = SffsImageFs.create();
    fs.mkdir("/d", 0o755);
    for (const name of ["a", "b", "c"]) {
      fs.writeFile(`/d/${name}`, new Uint8Array(0), 0o644);
    }
    const dh = fs.opendir("/d");
    const seen: string[] = [];
    for (;;) {
      const entry = fs.readdir(dh);
      if (!entry) break;
      seen.push(entry.name);
    }
    fs.closedir(dh);
    expect(seen.sort()).toEqual(["a", "b", "c"]);
  });

  it("rejects a handle it did not issue", () => {
    const fs = SffsImageFs.create();
    expect(() => fs.close(999)).toThrow(/bad file handle/);
    expect(() => fs.readdir(999)).toThrow(/bad directory handle/);
  });

  it("registers a lazy file whose metadata is readable before any fetch", () => {
    const fs = SffsImageFs.create();
    fs.mkdir("/usr", 0o755);
    fs.registerArchiveMember({
      path: "/usr/big",
      archiveId: 3,
      sourcePath: "members/big.bin",
      size: 99_999,
      mode: 0o755,
      ino: 40,
      archiveBytes: 8_000_000,
    });
    const st = fs.lstat("/usr/big");
    expect(st.size).toBe(99_999);
    expect(st.mode & 0o7777).toBe(0o755);
  });

  it("exports a whole container the kernel format readers accept", () => {
    // The bridge's half of the builder-facing save: drive the tree through the
    // ABI, then drain the finished image. What comes out must be a CONTAINER,
    // because a bare SFFS body is not an image -- nothing can find the
    // filesystem inside it or the sections beside it.
    const fs = SffsImageFs.create();
    fs.mkdir("/usr", 0o755);
    fs.writeFile("/usr/hello", new TextEncoder().encode("hi"), 0o644);

    const image = fs.exportImage();
    // The magic is written as a little-endian u32, so "VFSI" lands on disk
    // byte-reversed. Asserted as the reversal rather than as the literal
    // "ISFV", so the test says which property it is checking -- and spelled out
    // because this constant does NOT reach TypeScript through a generator, the
    // same hand-carried-ABI shape as L-D2, W-D1 and V-D1.
    expect(new TextDecoder().decode(image.subarray(0, 4))).toBe(
      [..."VFSI"].reverse().join(""),
    );
    // The header records the BODY's length, not the whole image's. That is what
    // makes these bytes a container rather than a bare filesystem: there are
    // sections after the body that the body knows nothing about.
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const bodyLen = view.getUint32(12, true);
    expect(bodyLen).toBeGreaterThan(0);
    expect(bodyLen).toBeLessThan(image.byteLength);
  });

  it("carries image metadata through the export without parsing it", () => {
    const fs = SffsImageFs.create();
    const metadata = { version: 1, kernelAbi: 44, createdBy: "a test" };
    fs.setImageMetadata(metadata);
    const image = fs.exportImage();
    // The metadata rides in the container as the bytes we handed over. Found by
    // searching rather than by offset, because the section's position depends
    // on which other sections the image declares -- and asserting the offset
    // would be asserting the container layout, which is not this test's claim.
    const needle = new TextEncoder().encode(JSON.stringify(metadata));
    const haystack = new TextDecoder().decode(image);
    expect(haystack).toContain(new TextDecoder().decode(needle));
  });

  it("streams the export in chunks smaller than the image", () => {
    // The export is offset-addressable so a 249 MiB image never has to live in
    // the module's linear memory. A one-chunk read would pass even if it were
    // not, so this forces many chunks and checks the result is identical.
    const fs = SffsImageFs.create();
    fs.mkdir("/d", 0o755);
    fs.writeFile("/d/big", new Uint8Array(300_000).fill(0x41), 0o644);

    const whole = fs.exportImage(1 << 20);
    const chunked = fs.exportImage(4096);
    expect(chunked.byteLength).toBe(whole.byteLength);
    expect(Array.from(chunked.subarray(0, 64))).toEqual(
      Array.from(whole.subarray(0, 64)),
    );
    expect(Array.from(chunked.subarray(-64))).toEqual(
      Array.from(whole.subarray(-64)),
    );
  });

  it("answers whether a path's bytes are in the image", () => {
    // The question builder recipes ask: "is this resident?" They asked it of
    // the TypeScript filesystem, which is the only reason they needed the
    // implementation rather than an interface.
    const fs = SffsImageFs.create();
    fs.mkdir("/usr", 0o755);
    fs.writeFile("/usr/here", new TextEncoder().encode("bytes"), 0o644);
    fs.registerArchiveMember({
      path: "/usr/there",
      archiveId: 3,
      sourcePath: "members/big.bin",
      size: 99_999,
      mode: 0o755,
      ino: 40,
      archiveBytes: 8_000_000,
    });

    const here = fs.lstat("/usr/here");
    expect(here.deferred).toBe(false);
    expect(here.size).toBe(5);
    expect(fs.isPathDeferred("/usr/here")).toBe(false);

    const there = fs.lstat("/usr/there");
    expect(there.deferred).toBe(true);
    expect(there.ino).toBe(40);
    // The REAL size, not the zero-length stub in the body. A recipe asking how
    // big a deferred file is must not have to fetch it first.
    expect(there.size).toBe(99_999);
    expect(there.archiveId).toBe(3);
    expect(fs.isPathDeferred("/usr/there")).toBe(true);

    expect(() => fs.isPathDeferred("/nope")).toThrow(/ENOENT/);
  });

  it("registers a file fetched standalone, with no archive behind it", () => {
    // 79 files in the shipped shell image have this shape, and it is the shape
    // lane S's setuid defect is about. The bridge could not express it until
    // the archive declaration stopped being unconditional.
    const fs = SffsImageFs.create();
    const url = new TextEncoder().encode("https://example.invalid/sudo#sha256:feed");
    fs.registerArchiveMember({
      path: "/sudo",
      archiveId: 0,
      sourcePath: "",
      size: 99_999,
      mode: 0o4755,
      ino: 40,
      archiveBytes: 0,
      archiveDescriptor: url,
    });
    const st = fs.lstat("/sudo");
    expect(st.deferred).toBe(true);
    expect(st.size).toBe(99_999);
    expect(st.archiveId).toBe(0);
    expect(st.mode & 0o7777).toBe(0o4755);
  });

  it("judges headroom and reports the numbers either way", () => {
    // The assertion builders make — "this image must ship with room to write" —
    // now comes back as a verdict computed in Rust rather than a statfs the
    // caller has to turn into one.
    const fs = SffsImageFs.create();
    fs.writeFile("/f", new TextEncoder().encode("hello"), 0o644);

    const ok = fs.checkHeadroom(0, 0);
    expect(ok.met).toBe(true);
    expect(ok.freeBytes).toBeGreaterThan(0);
    expect(ok.freeInodes).toBeGreaterThan(0);

    // Unmeetable: still returns the measurement, because a caller that only
    // learns "no" cannot say by how much.
    const no = fs.checkHeadroom(Number.MAX_SAFE_INTEGER, 0);
    expect(no.met).toBe(false);
    expect(no.requiredBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(no.freeBytes).toBe(ok.freeBytes);
  });

  it("refuses one archive declared with two different lengths", () => {
    // The member's size and the ARCHIVE's size are different numbers, and the
    // second is what bounds the fetch. Two lengths for one archive would make
    // that bound depend on registration order, so it is refused rather than
    // resolved.
    const fs = SffsImageFs.create();
    fs.mkdir("/usr", 0o755);
    const member = (ino: number, archiveBytes: number) => ({
      path: `/usr/m${ino}`,
      archiveId: 3,
      sourcePath: `members/m${ino}`,
      size: 10,
      mode: 0o644,
      ino,
      archiveBytes,
    });
    fs.registerArchiveMember(member(40, 8_000_000));
    // The same length again is a no-op, so a builder may register many members
    // of one archive without tracking whether it has declared it.
    expect(() => fs.registerArchiveMember(member(41, 8_000_000))).not.toThrow();
    expect(() => fs.registerArchiveMember(member(42, 9_000_000))).toThrow(/EINVAL/);
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

  it("writes a binary through the same helper path a recipe uses", () => {
    // `writeVfsBinary` is how every recipe puts a program into an image: open
    // with O_WRONLY|O_CREAT|O_TRUNC, write the whole buffer, close. Typechecking
    // the bridge against the interface proves the methods EXIST; this proves
    // they work, which is the part the repoint actually depends on.
    const fs = SffsImageFs.create();
    fs.mkdir("/usr", 0o755);
    fs.mkdir("/usr/bin", 0o755);
    writeVfsBinary(fs, "/usr/bin/prog", new Uint8Array([1, 2, 3, 4, 5]), 0o755);
    expect(fs.readFile("/usr/bin/prog")).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(fs.lstat("/usr/bin/prog").mode & 0o7777).toBe(0o755);
  });

  it("truncates on O_TRUNC instead of splicing into the old bytes", () => {
    // The bridge ignored its open flags until `write` existed, and ignoring
    // them would not have been harmless: a second build writing a SHORTER file
    // over a longer one would have kept the old file's tail. The image would
    // build, mount and boot, containing bytes nobody wrote.
    const fs = SffsImageFs.create();
    writeVfsBinary(fs, "/f", new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]), 0o644);
    writeVfsBinary(fs, "/f", new Uint8Array([1, 2, 3]), 0o644);
    expect(fs.readFile("/f")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("writes at a position past the end by zero-filling the gap", () => {
    const fs = SffsImageFs.create();
    const fd = fs.open("/sparse", O_WRONLY_CREAT_TRUNC, 0o644);
    fs.write(fd, new Uint8Array([7, 7]), 4, 2);
    fs.close(fd);
    // Length must agree with where the bytes are; dropping the gap would
    // produce a two-byte file whose content sat at offset four.
    expect(fs.readFile("/sparse")).toEqual(new Uint8Array([0, 0, 0, 0, 7, 7]));
  });

  it("keeps the tail when writing into the middle of a longer file", () => {
    // The zero-fill test above cannot see a `end = at + length` mutation,
    // because its file is empty and both spellings give the same answer. Only
    // an EXISTING file longer than the write can tell them apart: the mutant
    // truncates everything past the patch.
    const fs = SffsImageFs.create();
    fs.writeFile("/patch", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 0o644);
    const fd = fs.open("/patch", OPEN_FLAGS.O_WRONLY, 0o644);
    fs.write(fd, new Uint8Array([9, 9]), 2, 2);
    fs.close(fd);
    expect(fs.readFile("/patch")).toEqual(
      new Uint8Array([1, 2, 9, 9, 5, 6, 7, 8]),
    );
  });

  it("writes only the length it was asked for, not the whole buffer", () => {
    // A caller handing over a larger buffer and a smaller length is how a
    // partial write is expressed. Taking the whole buffer would write bytes
    // the caller did not offer, and report a count it did not ask for.
    const fs = SffsImageFs.create();
    const fd = fs.open("/partial", O_WRONLY_CREAT_TRUNC, 0o644);
    const took = fs.write(fd, new Uint8Array([1, 2, 3, 4, 5]), 0, 2);
    fs.close(fd);
    expect(took).toBe(2);
    expect(fs.readFile("/partial")).toEqual(new Uint8Array([1, 2]));
  });

  it("opens a missing path only when asked to create it", () => {
    const fs = SffsImageFs.create();
    expect(() => fs.open("/absent", OPEN_FLAGS.O_RDONLY, 0o644)).toThrow();
    // And the failed open must not have left the file behind.
    expect(() => fs.lstat("/absent")).toThrow();
  });

  it("advances its own cursor when no position is given", () => {
    const fs = SffsImageFs.create();
    const fd = fs.open("/seq", O_WRONLY_CREAT_TRUNC, 0o644);
    fs.write(fd, new Uint8Array([1, 2]), null, 2);
    fs.write(fd, new Uint8Array([3, 4]), null, 2);
    fs.close(fd);
    expect(fs.readFile("/seq")).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("follows symlinks for stat and stops at the link for lstat", () => {
    const fs = SffsImageFs.create();
    fs.writeFile("/target", new Uint8Array([1, 2, 3]), 0o644);
    fs.symlink("/target", "/link", 0, 0);
    expect(fs.stat("/link").size).toBe(3);
    expect(fs.stat("/link").mode & 0o170000).toBe(0o100000);
    expect(fs.lstat("/link").mode & 0o170000).toBe(0o120000);
  });

  it("resolves a relative symlink against the link's own directory", () => {
    const fs = SffsImageFs.create();
    fs.mkdir("/d", 0o755);
    fs.writeFile("/d/target", new Uint8Array([1, 2, 3, 4]), 0o644);
    fs.symlink("target", "/d/link", 0, 0);
    expect(fs.stat("/d/link").size).toBe(4);
  });

  it("refuses a symlink cycle rather than following it forever", () => {
    const fs = SffsImageFs.create();
    fs.symlink("/b", "/a", 0, 0);
    fs.symlink("/a", "/b", 0, 0);
    expect(() => fs.stat("/a")).toThrow();
  });

  it("bounds the chain it will follow, and the bound is the one it states", () => {
    // A cycle alone cannot pin the LIMIT: raise it from forty to four million
    // and the cycle test still passes, just slowly — H-11's mutant detectable
    // only by hanging. A chain measures the bound directly and in bounded time:
    // thirty-nine links resolve, forty-one do not.
    const fs = SffsImageFs.create();
    fs.writeFile("/end", new Uint8Array([1]), 0o644);
    fs.symlink("/end", "/hop0", 0, 0);
    for (let i = 1; i < 60; i += 1) {
      fs.symlink(`/hop${i - 1}`, `/hop${i}`, 0, 0);
    }
    expect(fs.stat("/hop37").size).toBe(1);
    expect(() => fs.stat("/hop50")).toThrow();
  });

  it("gives each instance an independent tree", () => {
    const a = SffsImageFs.create();
    a.mkdir("/only-in-a", 0o755);
    const b = SffsImageFs.create();
    expect(() => b.lstat("/only-in-a")).toThrow();
    expect(a.lstat("/only-in-a").mode & 0o7777).toBe(0o755);
  });
});
