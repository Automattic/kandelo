import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostFileSystem } from "../../src/vfs/host-fs";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";

const O_RDONLY = 0;
const O_DIRECTORY = 0o200000;

describe("directory fsync", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the native durability barrier for Node-backed directories", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-directory-fsync-"));
    roots.push(root);
    mkdirSync(join(root, "journal"));
    const fs = new HostFileSystem(root);
    const fd = fs.open("/journal", O_RDONLY | O_DIRECTORY, 0);

    try {
      expect(() => fs.fsync(fd)).not.toThrow();
    } finally {
      fs.close(fd);
    }
  });

  it("accepts directory fsync when memory writes are already synchronous", () => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    fs.mkdir("/journal", 0o700);
    const fd = fs.open("/journal", O_RDONLY | O_DIRECTORY, 0);

    try {
      expect(() => fs.fsync(fd)).not.toThrow();
    } finally {
      fs.close(fd);
    }
  });
});
