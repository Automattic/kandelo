import { describe, expect, it } from "vitest";

import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  listPreparedPlatformDirectory,
  statPreparedPlatformPath,
  VirtualPlatformIO,
} from "../src/vfs/vfs";

const O_WRONLY = 1;
const O_CREAT = 0x40;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

const time = {
  clockGettime: () => ({ sec: 0, nsec: 0 }),
  nanosleep: () => {},
};

function platform(): VirtualPlatformIO {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
  const io = new VirtualPlatformIO([{ mountPoint: "/", backend: fs }], time);
  io.mkdir("/srv", 0o755);
  io.mkdir("/srv/site", 0o750);
  const handle = io.open("/srv/index.html", O_WRONLY | O_CREAT, 0o644);
  io.write(handle, new TextEncoder().encode("hello"), null, 5);
  io.close(handle);
  io.symlink("site", "/srv/current");
  return io;
}

describe("worker-side VFS listing and stat", () => {
  it("lists entries without following symlinks, and reports link targets", async () => {
    const entries = await listPreparedPlatformDirectory(platform(), "/srv");
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    expect([...byName.keys()].sort()).toEqual(["current", "index.html", "site"]);
    expect(byName.get("site")!.mode & S_IFMT).toBe(S_IFDIR);
    expect(byName.get("site")!.mode & 0o777).toBe(0o750);
    expect(byName.get("index.html")!.mode & S_IFMT).toBe(S_IFREG);
    expect(byName.get("index.html")!.size).toBe(5);
    expect(byName.get("current")!.mode & S_IFMT).toBe(S_IFLNK);
    expect(byName.get("current")!.target).toBe("site");
    expect(byName.get("site")!.target).toBeUndefined();
  });

  it("stats through a symlink, unlike a listing entry", async () => {
    const io = platform();
    const viaLink = await statPreparedPlatformPath(io, "/srv/current");
    expect(viaLink.mode & S_IFMT).toBe(S_IFDIR);
    const file = await statPreparedPlatformPath(io, "/srv/index.html");
    expect(file).toMatchObject({ size: 5, uid: 0, gid: 0 });
  });

  it("rejects a missing path instead of answering with an empty listing", async () => {
    const io = platform();
    await expect(listPreparedPlatformDirectory(io, "/nope")).rejects.toThrow();
    await expect(statPreparedPlatformPath(io, "/nope")).rejects.toThrow();
  });
});
