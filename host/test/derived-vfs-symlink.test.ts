import { describe, expect, it } from "vitest";
import { symlinkWithParentDirectories } from "../../images/vfs/scripts/derived-vfs-symlink";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { writeVfsFile } from "../src/vfs/image-helpers";

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

describe("derived VFS symlink installation", () => {
  it("creates every missing parent owned by the derived image", () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));

    symlinkWithParentDirectories(
      fs,
      "/usr/bin/node",
      "/usr/local/bin/node",
    );

    expect(fs.stat("/usr").mode & S_IFMT).toBe(S_IFDIR);
    expect(fs.stat("/usr/local").mode & S_IFMT).toBe(S_IFDIR);
    expect(fs.stat("/usr/local/bin").mode & S_IFMT).toBe(S_IFDIR);
    expect(fs.readlink("/usr/local/bin/node")).toBe("/usr/bin/node");
  });

  it("does not hide an invalid parent owned by the derived image", () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    writeVfsFile(fs, "/usr", "not a directory");

    expect(() =>
      symlinkWithParentDirectories(
        fs,
        "/usr/bin/node",
        "/usr/local/bin/node",
      )
    ).toThrow();
  });
});
