import { describe, it, expect } from "vitest";
import { synthesizePosixMode } from "../../src/platform/native-metadata";

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

// Windows has no POSIX permission model: Node's `fs.statSync` reports every
// entry as 0o666 (writable) or 0o444 (read-only), with no execute/search bit
// on directories, and `chmod` can't express POSIX bits. `synthesizePosixMode`
// represents host-backed entries as world-accessible so a privilege-dropped
// guest process can both traverse and write the mounted sandbox (WordPress
// writes its SQLite database, uploads, and cache into it), honoring only the
// read-only attribute Windows does expose. These inputs are exactly what Node
// reports on Windows.
describe("synthesizePosixMode", () => {
  it("gives writable directories full rwx for owner, group, and other", () => {
    expect(synthesizePosixMode(S_IFDIR | 0o666)).toBe(S_IFDIR | 0o777);
  });

  it("keeps read-only directories traversable but not writable", () => {
    expect(synthesizePosixMode(S_IFDIR | 0o444)).toBe(S_IFDIR | 0o555);
  });

  it("maps writable regular files to world read/write (0o666)", () => {
    expect(synthesizePosixMode(S_IFREG | 0o666)).toBe(S_IFREG | 0o666);
  });

  it("maps read-only regular files to 0o444", () => {
    expect(synthesizePosixMode(S_IFREG | 0o444)).toBe(S_IFREG | 0o444);
  });

  it("reports symlinks as 0o777 regardless of the read-only attribute", () => {
    expect(synthesizePosixMode(S_IFLNK | 0o666)).toBe(S_IFLNK | 0o777);
    expect(synthesizePosixMode(S_IFLNK | 0o444)).toBe(S_IFLNK | 0o777);
  });

  it("preserves the file-type bits", () => {
    expect(synthesizePosixMode(S_IFDIR | 0o666) & 0o170000).toBe(S_IFDIR);
    expect(synthesizePosixMode(S_IFREG | 0o666) & 0o170000).toBe(S_IFREG);
  });

  it("gives writable directories other search+write, so lookup and writes succeed", () => {
    // Windows reports writable dirs as 0o666; the uid-dropped worker needs
    // both the search (0o1) and write (0o2) bit as "other".
    expect(synthesizePosixMode(S_IFDIR | 0o666) & 0o003).toBe(0o003);
  });
});
