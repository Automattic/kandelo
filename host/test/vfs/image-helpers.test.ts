import { describe, expect, it, vi } from "vitest";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import type { VfsImageFilesystem } from "../../src/vfs/vfs-image-filesystem";
import {
  ensureDir,
  ensureDirRecursive,
  symlink,
  writeVfsBinary,
  writeVfsFile,
} from "../../src/vfs/image-helpers";
import {
  ensureDir as ensureBrowserDir,
  ensureDirRecursive as ensureBrowserDirRecursive,
  writeVfsBinary as writeBrowserVfsBinary,
  writeVfsFile as writeBrowserVfsFile,
} from "../../../apps/browser-demos/lib/init/vfs-utils";
// Errnos from `vfs-errors.ts`, not from the vendored filesystem that
// re-exports them: `sharedfs-vendor.ts` goes with `memory-fs.ts`.
import { EEXIST, ENOSPC } from "../../src/vfs/vfs-errors";

const O_RDONLY = 0;

function readFile(fs: VfsImageFilesystem, path: string): Uint8Array {
  const size = fs.stat(path).size;
  const bytes = new Uint8Array(size);
  const fd = fs.open(path, O_RDONLY, 0);
  try {
    const read = fs.read(fd, bytes, null, bytes.length);
    if (read !== bytes.length) {
      throw new Error(`short test read: ${read} of ${bytes.length}`);
    }
  } finally {
    fs.close(fd);
  }
  return bytes;
}

describe("VFS image write helpers", () => {
  it("backs browser-demo writers with the shared strict helpers", () => {
    expect(writeBrowserVfsBinary).toBe(writeVfsBinary);
    expect(writeBrowserVfsFile).toBe(writeVfsFile);
    expect(ensureBrowserDir).toBe(ensureDir);
    expect(ensureBrowserDirRecursive).toBe(ensureDirRecursive);
  });

  it("ignores only EEXIST while creating directories and symlinks", () => {
    const existing = Object.assign(new Error("exists"), { code: EEXIST });
    const full = Object.assign(new Error("full"), { code: ENOSPC });
    const mkdir = vi.fn()
      .mockImplementationOnce(() => { throw existing; })
      .mockImplementationOnce(() => { throw full; });
    const createSymlink = vi.fn()
      .mockImplementationOnce(() => { throw existing; })
      .mockImplementationOnce(() => { throw full; });
    const fs = {
      mkdir,
      symlink: createSymlink,
    } as unknown as VfsImageFilesystem;

    expect(() => ensureDir(fs, "/already-there")).not.toThrow();
    expect(() => ensureDir(fs, "/no-space")).toThrow(full);
    expect(() => symlink(fs, "/target", "/already-there")).not.toThrow();
    expect(() => symlink(fs, "/target", "/no-space")).toThrow(full);
  });

  it("stops recursive creation at the first non-EEXIST failure", () => {
    const full = Object.assign(new Error("full"), { code: ENOSPC });
    const mkdir = vi.fn((path: string) => {
      if (path === "/one/two") throw full;
    });
    const fs = { mkdir } as unknown as VfsImageFilesystem;

    expect(() => ensureDirRecursive(fs, "/one/two/three")).toThrow(full);
    expect(mkdir.mock.calls.map(([path]) => path)).toEqual(["/one", "/one/two"]);
  });

  // Built by `KandeloImageFs`, the producer that ships, because the claim is
  // about the HELPER and any image filesystem can carry it.
  it("stages every byte of a binary file", () => {
    const fs = KandeloImageFs.create();
    const data = new Uint8Array(256 * 1024);
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;

    writeVfsBinary(fs, "/payload.bin", data, 0o640);

    expect(fs.stat("/payload.bin").size).toBe(data.length);
    expect(readFile(fs, "/payload.bin")).toEqual(data);
  });

  // RETIRED 2026-09-17: "reports terminal ENOSPC after preserving a positive
  // partial write". It stayed on `MemoryFileSystem` while that class existed,
  // with the reason recorded: the claim is that a FIXED-CAPACITY backend
  // running out mid-write leaves the partial bytes, and `KandeloImageFs` has
  // no fixed capacity to run out of — it is module-backed with a declared
  // growth ceiling rather than an allocation.
  //
  // Keeping it meant keeping the last import of the class this file otherwise
  // no longer uses, for a condition no shipping producer can reach. Its
  // sibling in `host/test/vfs-image-helpers.test.ts` went for the same reason
  // in the same tranche. What both defended — that `writeVfsBinary`
  // propagates a mid-write failure instead of silently omitting the file —
  // survives in "continues from the correct offset after a positive short
  // write" below and in the mock-driven write-failure case beside it.

  it("continues from the correct offset after a positive short write", () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const close = vi.fn();
    const write = vi.fn()
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(2);
    const fs = {
      open: vi.fn(() => 7),
      write,
      close,
    } as unknown as VfsImageFilesystem;

    writeVfsBinary(fs, "/fixture.bin", data);

    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0][1]).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(write.mock.calls[0].slice(2)).toEqual([0, 4]);
    expect(write.mock.calls[1][1]).toEqual(new Uint8Array([3, 4]));
    expect(write.mock.calls[1].slice(2)).toEqual([2, 2]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(7);
  });

  it("closes the descriptor for zero, negative, invalid, and thrown writes", () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const outcomes: Array<number | Error> = [
      0,
      -28,
      5,
      new Error("ENOSPC"),
    ];

    for (const outcome of outcomes) {
      const close = vi.fn();
      const fs = {
        open: vi.fn(() => 7),
        write: vi.fn(() => {
          if (outcome instanceof Error) throw outcome;
          return outcome;
        }),
        close,
      } as unknown as VfsImageFilesystem;

      expect(() => writeVfsBinary(fs, "/fixture.bin", data)).toThrow();
      expect(close).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith(7);
    }
  });
});
