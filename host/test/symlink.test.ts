import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;
const O_RDONLY = 0x0000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFMT = 0o170000;

function createMemfs(): MemoryFileSystem {
  const sab = new SharedArrayBuffer(4 * 1024 * 1024);
  return MemoryFileSystem.create(sab);
}

describe("symlink and lstat", () => {
  it("lstat returns symlink inode, not target", () => {
    const mfs = createMemfs();

    // Create a regular file
    const data = new TextEncoder().encode("hello");
    const fd = mfs.open("/target.txt", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    mfs.write(fd, data, null, data.length);
    mfs.close(fd);

    // Create a symlink to it
    mfs.symlink("/target.txt", "/link.txt");

    // stat follows symlinks — should return the regular file's mode
    const statResult = mfs.stat("/link.txt");
    expect(statResult.mode & S_IFMT).toBe(S_IFREG);
    expect(statResult.size).toBe(5);

    // lstat does NOT follow symlinks — should return the symlink's mode
    const lstatResult = mfs.lstat("/link.txt");
    expect(lstatResult.mode & S_IFMT).toBe(S_IFLNK);
  });

  it("lstat on dangling symlink succeeds", () => {
    const mfs = createMemfs();

    // Create a symlink to a non-existent target
    mfs.symlink("/nonexistent", "/dangling");

    // stat should fail (target doesn't exist)
    expect(() => mfs.stat("/dangling")).toThrow();

    // lstat should succeed (returns the symlink inode itself)
    const st = mfs.lstat("/dangling");
    expect(st.mode & S_IFMT).toBe(S_IFLNK);
  });

  it("readlink returns the symlink target", () => {
    const mfs = createMemfs();
    mfs.symlink("/some/path", "/mylink");
    expect(mfs.readlink("/mylink")).toBe("/some/path");
  });

  it("stat follows chain of symlinks", () => {
    const mfs = createMemfs();

    // Create file, then chain of symlinks
    const data = new TextEncoder().encode("data");
    const fd = mfs.open("/real.txt", O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    mfs.write(fd, data, null, data.length);
    mfs.close(fd);

    mfs.symlink("/real.txt", "/link1");
    mfs.symlink("/link1", "/link2");

    // stat on link2 should follow through link1 to real.txt
    const st = mfs.stat("/link2");
    expect(st.mode & S_IFMT).toBe(S_IFREG);
    expect(st.size).toBe(4);

    // lstat on link2 should return the symlink itself
    const lst = mfs.lstat("/link2");
    expect(lst.mode & S_IFMT).toBe(S_IFLNK);
  });
});
