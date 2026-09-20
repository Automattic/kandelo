import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertVfsImageCapacity,
  assertVfsImageHeadroom,
  saveImage,
  sourceDateEpochMilliseconds,
  walkAndWrite,
  writeVfsBinary,
} from "../../images/vfs/scripts/vfs-image-helpers";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

/**
 * THE FIXTURE IS THE PRODUCER THAT SHIPS, 2026-09-17.
 *
 * These helpers are `images/vfs/scripts/vfs-image-helpers`, and every builder
 * that calls them now writes with `KandeloImageFs`. The fixture they wrote
 * into here was `MemoryFileSystem`, so the suite proving the helpers work was
 * proving it against a filesystem no builder uses — and a helper that failed
 * only against the real producer would have passed every one of these.
 */

function withSourceTree(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "vfs-walk-source-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "keep.txt"), "kept");
    writeFileSync(join(root, "skip.txt"), "skipped");
    writeFileSync(join(root, "nested", "tool"), "tool");
    chmodSync(join(root, "nested"), 0o710);
    chmodSync(join(root, "nested", "tool"), 0o751);
    symlinkSync("keep.txt", join(root, "alias"));
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function artifactFileSystem(): KandeloImageFs {
  const fs = KandeloImageFs.create();
  writeVfsBinary(
    fs,
    "/ordinary.bin",
    new TextEncoder().encode("ordinary artifact bytes"),
  );
  return fs;
}

async function expectArtifactInspectionFailure(
  fs: KandeloImageFs,
  failure: Error | RegExp,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "vfs-artifact-inspection-"));
  const output = join(root, "guarded.vfs.zst");
  try {
    await expect(saveImage(fs, output)).rejects.toThrow(failure);
    expect(existsSync(output)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("walkAndWrite", () => {
  it("copies files, directories, modes, and requested symlinks while honoring exclusions", () => {
    withSourceTree((root) => {
      const fs = KandeloImageFs.create();

      const count = walkAndWrite(fs, root, "/payload", {
        exclude: (path) => path === "skip.txt",
        preserveMode: true,
        preserveSymlinks: true,
      });

      expect(count).toBe(3);
      expect(
        new TextDecoder().decode(fs.readFile("/payload/keep.txt")),
      ).toBe("kept");
      expect(
        new TextDecoder().decode(fs.readFile("/payload/nested/tool")),
      ).toBe("tool");
      expect(fs.stat("/payload/nested").mode & 0o7777).toBe(0o710);
      expect(fs.stat("/payload/nested/tool").mode & 0o7777).toBe(0o751);
      expect(fs.readlink("/payload/alias")).toBe("keep.txt");
      expect(() => fs.lstat("/payload/skip.txt")).toThrow();
    });
  });

  it("rejects an unexcluded symlink unless preservation is requested", () => {
    withSourceTree((root) => {
      const fs = KandeloImageFs.create();

      expect(() => walkAndWrite(fs, root, "/payload")).toThrow(
        new RegExp(
          `VFS image source symlink requires preserveSymlinks or an explicit exclude: ` +
            `${join(root, "alias")}`,
        ),
      );
    });
  });

  it("omits a symlink only through an explicit exclusion", () => {
    withSourceTree((root) => {
      const fs = KandeloImageFs.create();

      const count = walkAndWrite(fs, root, "/payload", {
        exclude: (path) => path === "alias",
      });

      expect(count).toBe(3);
      expect(() => fs.lstat("/payload/alias")).toThrow();
      expect(fs.stat("/payload/nested/tool").mode & 0o7777).toBe(0o644);
    });
  });

  it("propagates a host file read failure", () => {
    withSourceTree((root) => {
      const fs = KandeloImageFs.create();

      expect(() =>
        walkAndWrite(fs, root, "/payload", {
          exclude: (path) => {
            if (path === "alias") return true;
            if (path === "keep.txt") unlinkSync(join(root, path));
            return false;
          },
        })
      ).toThrow();
    });
  });

  it("propagates a host symlink read failure", () => {
    withSourceTree((root) => {
      const fs = KandeloImageFs.create();

      expect(() =>
        walkAndWrite(fs, root, "/payload", {
          preserveSymlinks: true,
          exclude: (path) => {
            if (path === "alias") unlinkSync(join(root, path));
            return false;
          },
        })
      ).toThrow();
    });
  });

  it("propagates a VFS write failure instead of silently omitting the file", () => {
    const root = mkdtempSync(join(tmpdir(), "vfs-walk-error-"));
    try {
      writeFileSync(join(root, "payload.bin"), new Uint8Array([1, 2, 3]));
      const failure = new Error("synthetic VFS write failure");
      const fs = {
        mkdir: vi.fn(),
        open: vi.fn(() => { throw failure; }),
      } as unknown as KandeloImageFs;

      expect(() => walkAndWrite(fs, root, "/payload")).toThrow(failure);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // RETIRED 2026-09-17: "propagates terminal ENOSPC after a partial
  // product-tree write". It built a filesystem over a 128 KiB
  // `SharedArrayBuffer`, wrote a 1 MiB file into it, and asserted that the
  // write failed with a PARTIAL file left behind.
  //
  // The condition cannot be expressed against the producer that ships. A
  // `KandeloImageFs` has no fixed-size buffer to exhaust: its memory grows
  // with what is written, and capacity is a DECLARED ceiling recorded in the
  // image rather than an allocation — the maintainer's decision of
  // 2026-09-13, and the reason `assertVfsImageCapacity` exists at all. There
  // is no 128 KiB to run out of.
  //
  // What the case actually defended is not lost. That `walkAndWrite`
  // propagates a mid-write failure rather than silently omitting the file is
  // "propagates a VFS write failure instead of silently omitting the file",
  // just above, which reaches the same branch through a throwing `open`. What
  // goes is the assertion about the PARTIAL bytes, which was a claim about the
  // filesystem's behaviour when full, not about the helper.

  it("rejects a source entry type that a VFS image cannot represent", async () => {
    const root = mkdtempSync(join(tmpdir(), "vfs-walk-socket-"));
    const socketPath = join(root, "runtime.sock");
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const fs = KandeloImageFs.create();

      expect(() => walkAndWrite(fs, root, "/payload")).toThrow(
        new RegExp(`Unsupported VFS image source entry: ${socketPath}`),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("VFS artifact publication inspection", () => {
  it("skips only an explicitly deferred path while inspecting ordinary files", async () => {
    const fs = artifactFileSystem();
    fs.registerLazyFile(
      "/deferred.wasm",
      "https://example.invalid/deferred.wasm",
      4,
      0o755,
    );
    const realOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(
      (path, flags, mode) => {
        if (path === "/deferred.wasm") {
          throw new Error("deferred bytes must not be read during publication");
        }
        return realOpen(path, flags, mode);
      },
    );
    const root = mkdtempSync(join(tmpdir(), "vfs-deferred-inspection-"));
    const output = join(root, "guarded.vfs.zst");
    try {
      await expect(saveImage(fs, output)).resolves.toBeInstanceOf(Uint8Array);
      expect(
        open.mock.calls.some(([path]) => path === "/ordinary.bin"),
      ).toBe(true);
      expect(
        open.mock.calls.some(([path]) => path === "/deferred.wasm"),
      ).toBe(false);
      expect(existsSync(output)).toBe(true);
    } finally {
      open.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("propagates a root-directory inspection failure", async () => {
    const fs = artifactFileSystem();
    const failure = new Error("synthetic artifact opendir failure");
    vi.spyOn(fs, "opendir").mockImplementation(() => {
      throw failure;
    });

    await expectArtifactInspectionFailure(fs, failure);
  });

  it("propagates a directory iteration failure", async () => {
    const fs = artifactFileSystem();
    const failure = new Error("synthetic artifact readdir failure");
    vi.spyOn(fs, "readdir").mockImplementation(() => {
      throw failure;
    });

    await expectArtifactInspectionFailure(fs, failure);
  });

  it("propagates a directory-entry metadata failure", async () => {
    const fs = artifactFileSystem();
    const failure = new Error("synthetic artifact lstat failure");
    const realLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation((path) => {
      if (path === "/ordinary.bin") throw failure;
      return realLstat(path);
    });

    await expectArtifactInspectionFailure(fs, failure);
  });

  it("propagates a non-deferred file stat failure", async () => {
    const fs = artifactFileSystem();
    const failure = new Error("synthetic artifact stat failure");
    vi.spyOn(fs, "stat").mockImplementation(() => {
      throw failure;
    });

    await expectArtifactInspectionFailure(fs, failure);
  });

  it("propagates a non-deferred file open failure", async () => {
    const fs = artifactFileSystem();
    const failure = new Error("synthetic artifact open failure");
    vi.spyOn(fs, "open").mockImplementation(() => {
      throw failure;
    });

    await expectArtifactInspectionFailure(fs, failure);
  });

  it("accepts partial reads only after consuming the complete file", async () => {
    const fs = artifactFileSystem();
    const realRead = fs.read.bind(fs);
    const read = vi.spyOn(fs, "read").mockImplementation(
      (fd, buffer, position, length) =>
        realRead(fd, buffer, position, Math.min(length, 3)),
    );
    const root = mkdtempSync(join(tmpdir(), "vfs-partial-inspection-"));
    const output = join(root, "guarded.vfs.zst");
    try {
      await expect(saveImage(fs, output)).resolves.toBeInstanceOf(Uint8Array);
      expect(read.mock.calls.length).toBeGreaterThan(1);
      expect(existsSync(output)).toBe(true);
    } finally {
      read.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("propagates a non-deferred file read failure", async () => {
    const fs = artifactFileSystem();
    const failure = new Error("synthetic artifact read failure");
    vi.spyOn(fs, "read").mockImplementation(() => {
      throw failure;
    });

    await expectArtifactInspectionFailure(fs, failure);
  });

  it("rejects premature EOF from a non-deferred artifact", async () => {
    const fs = artifactFileSystem();
    vi.spyOn(fs, "read").mockReturnValue(0);

    await expectArtifactInspectionFailure(
      fs,
      /Incomplete VFS artifact read for \/ordinary\.bin: 0 of 23 bytes before result 0/,
    );
  });

  it("propagates a non-deferred file close failure", async () => {
    const fs = artifactFileSystem();
    const failure = new Error("synthetic artifact close failure");
    vi.spyOn(fs, "close").mockImplementation(() => {
      throw failure;
    });

    await expectArtifactInspectionFailure(fs, failure);
  });
});

/**
 * MOVED here from `vfs-image.test.ts`, 2026-09-16.
 *
 * `assertVfsImageCapacity`, `assertVfsImageHeadroom` and
 * `sourceDateEpochMilliseconds` live in the module this file tests and are
 * called by four or more builder scripts each — and every one of them was
 * tested in exactly one place: a file step 5 deletes along with
 * `MemoryFileSystem`, which none of them depend on. Deleting it would have
 * taken the product capacity contract, the runtime headroom reserve and
 * reproducible build timestamps with it, and the commit would have read like
 * progress.
 *
 * Three of these used `MemoryFileSystem` only to PRODUCE an image to judge.
 * They now produce it with `KandeloImageFs`, which is the producer the
 * builders themselves use.
 */
describe("product image capacity and headroom contract", () => {
  function probeImageFs(): KandeloImageFs {
    const fs = KandeloImageFs.create();
    fs.writeFile("/probe", new Uint8Array(8), 0o644);
    return fs;
  }

  it("validates the serialized product capacity contract and reports drift", async () => {
    const image = await probeImageFs().saveImage();
    const { maxByteLength } = KandeloImageFs.readImageCapacity(image);

    expect(() => assertVfsImageCapacity(image, maxByteLength, "test image"))
      .not.toThrow();
    // BOTH directions, because the contract is a match and not a floor.
    //
    // A product asking for more room than the image declares is the obvious
    // one. The other is the masked ceiling: an image whose encoded growth
    // ceiling EXCEEDS what its profile permits boots into a buffer it can
    // outgrow, which is the failure `assertVfsImageFitsProfile` reports as
    // "requires 8388608 VFS bytes, but its profile permits 4194304". A trial
    // that relaxed this comparison to `<` survived an assertion that only
    // probed the first direction.
    expect(() => assertVfsImageCapacity(image, maxByteLength + 4096, "test image"))
      .toThrow(/test image has a .* VFS capacity; .* required/);
    expect(() => assertVfsImageCapacity(image, maxByteLength - 4096, "test image"))
      .toThrow(/test image has a .* VFS capacity; .* required/);
  });

  it.each([-1, 0, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid product capacity %s",
    async (maxByteLength) => {
      const image = await probeImageFs().saveImage();
      expect(() => assertVfsImageCapacity(image, maxByteLength, "test image"))
        .toThrow(/expectedMaxByteLength must be a positive safe integer/);
    },
  );

  it("rejects malformed serialized capacity state", () => {
    // The MODULE judges this: `assertVfsImageCapacity` without a producer
    // calls `KandeloImageFs.readImageCapacity`, because reading a container
    // header in TypeScript would be format knowledge on the wrong side of the
    // boundary. So the refusal arrives as an errno rather than as prose, and
    // the errno is the contract — message text is not.
    expect(() => assertVfsImageCapacity(new Uint8Array(0), 1, "test image"))
      .toThrow(/EINVAL/);
  });

  it("checks free blocks and free inodes as independent resources", () => {
    // The FILESYSTEM judges headroom and reports the numbers behind its
    // verdict; that is what `sm_check_headroom` was added for. Each resource
    // is raised on its own so neither can be the one doing all the refusing.
    const fs = probeImageFs();
    const { freeBytes, freeInodes } = fs.checkHeadroom(0, 0);

    expect(() =>
      assertVfsImageHeadroom(fs, {
        minimumFreeBytes: freeBytes,
        minimumFreeInodes: freeInodes,
      }, "test image")
    ).not.toThrow();
    expect(() =>
      assertVfsImageHeadroom(fs, {
        minimumFreeBytes: freeBytes + 1,
        minimumFreeInodes: freeInodes,
      }, "test image")
    ).toThrow(/test image lacks runtime VFS headroom: .* free bytes remain/);
    expect(() =>
      assertVfsImageHeadroom(fs, {
        minimumFreeBytes: freeBytes,
        minimumFreeInodes: freeInodes + 1,
      }, "test image")
    ).toThrow(/test image lacks runtime VFS headroom: .* free inodes remain/);
  });

  it("enforces the declared reserve before writing a product image", async () => {
    const fs = probeImageFs();
    const { freeBytes, freeInodes } = fs.checkHeadroom(0, 0);
    const dir = mkdtempSync(join(tmpdir(), "vfs-headroom-"));
    try {
      await expect(saveImage(fs, join(dir, "full.vfs.zst"), {
        headroom: {
          minimumFreeBytes: freeBytes + 1,
          minimumFreeInodes: freeInodes + 1,
        },
      })).rejects.toThrow(/lacks runtime VFS headroom.*free bytes.*free inodes/);
      // BEFORE writing, not after: a refused product leaves no artifact for a
      // later step to pick up and ship.
      expect(existsSync(join(dir, "full.vfs.zst"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SOURCE_DATE_EPOCH", () => {
  it.each([
    [undefined, 0],
    ["0", 0],
    ["946684800", 946_684_800_000],
  ])("maps %s to a reproducible millisecond timestamp", (value, expected) => {
    expect(sourceDateEpochMilliseconds(value)).toBe(expected);
  });

  it.each(["-1", "1.5", "01", "NaN", "9007199254741"])(
    "rejects invalid value %s",
    (value) => {
      expect(() => sourceDateEpochMilliseconds(value)).toThrow(
        /SOURCE_DATE_EPOCH/,
      );
    },
  );
});
