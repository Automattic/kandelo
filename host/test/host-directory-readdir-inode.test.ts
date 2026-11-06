/**
 * Directory entries on host-directory backends carry the file serial number
 * stat reports (POSIX `d_ino`). A zero `d_ino` reads as a deleted entry: bash
 * skips such entries when globbing, so `*.lev` on a host-directory mount
 * matched nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OPEN_FLAGS } from "../src/generated/abi";
import { NodePlatformIO } from "../src/platform/node";
import { HostFileSystem } from "../src/vfs/host-fs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function populatedDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "kandelo-readdir-ino-"));
  roots.push(root);
  writeFileSync(join(root, "bigrm-1.lev"), "level");
  mkdirSync(join(root, "sub"));
  symlinkSync("bigrm-1.lev", join(root, "link"));
  return root;
}

function drain(read: () => { name: string; ino: number | bigint } | null) {
  const entries = new Map<string, bigint>();
  for (let entry = read(); entry !== null; entry = read()) {
    entries.set(entry.name, BigInt(entry.ino));
  }
  return entries;
}

describe("host-directory readdir inode numbers", () => {
  it("HostFileSystem reports each entry's lstat inode", () => {
    const root = populatedDirectory();
    const backend = new HostFileSystem(root);
    const handle = backend.opendir("/");
    const entries = drain(() => backend.readdir(handle));
    backend.closedir(handle);
    for (const name of ["bigrm-1.lev", "sub", "link"]) {
      expect(entries.get(name), name).toBe(BigInt(backend.lstat(`/${name}`).ino));
      expect(entries.get(name), name).not.toBe(0n);
    }
  });

  it("NodePlatformIO reports each entry's lstat inode", () => {
    const root = populatedDirectory();
    const io = new NodePlatformIO();
    const [{ handle: rootHandle }] = io.foreignMountRoots();
    const handle = io.openat(rootHandle, root.slice(1), OPEN_FLAGS.O_RDONLY | OPEN_FLAGS.O_DIRECTORY, 0);
    const entries = drain(() => io.readdir(handle));
    for (const name of ["bigrm-1.lev", "sub", "link"]) {
      expect(entries.get(name), name).toBe(BigInt(io.lstat(join(root, name)).ino));
      expect(entries.get(name), name).not.toBe(0n);
    }
  });
});
