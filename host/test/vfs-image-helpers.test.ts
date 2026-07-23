import {
  chmodSync,
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
import { walkAndWrite } from "../../images/vfs/scripts/vfs-image-helpers";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const O_RDONLY = 0;

function readFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const size = fs.stat(path).size;
  const bytes = new Uint8Array(size);
  const fd = fs.open(path, O_RDONLY, 0);
  try {
    const count = fs.read(fd, bytes, null, bytes.byteLength);
    if (count !== bytes.byteLength) {
      throw new Error(`short test read: ${count} of ${bytes.byteLength}`);
    }
  } finally {
    fs.close(fd);
  }
  return bytes;
}

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

describe("walkAndWrite", () => {
  it("copies files, directories, modes, and requested symlinks while honoring exclusions", () => {
    withSourceTree((root) => {
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));

      const count = walkAndWrite(fs, root, "/payload", {
        exclude: (path) => path === "skip.txt",
        preserveMode: true,
        preserveSymlinks: true,
      });

      expect(count).toBe(3);
      expect(
        new TextDecoder().decode(readFile(fs, "/payload/keep.txt")),
      ).toBe("kept");
      expect(
        new TextDecoder().decode(readFile(fs, "/payload/nested/tool")),
      ).toBe("tool");
      expect(fs.stat("/payload/nested").mode & 0o7777).toBe(0o710);
      expect(fs.stat("/payload/nested/tool").mode & 0o7777).toBe(0o751);
      expect(fs.readlink("/payload/alias")).toBe("keep.txt");
      expect(() => fs.lstat("/payload/skip.txt")).toThrow();
    });
  });

  it("rejects an unexcluded symlink unless preservation is requested", () => {
    withSourceTree((root) => {
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));

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
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));

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
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));

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
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));

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
      } as unknown as MemoryFileSystem;

      expect(() => walkAndWrite(fs, root, "/payload")).toThrow(failure);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("propagates terminal ENOSPC after a partial product-tree write", () => {
    const root = mkdtempSync(join(tmpdir(), "vfs-walk-enospc-"));
    try {
      writeFileSync(join(root, "payload.bin"), new Uint8Array(1024 * 1024));
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(128 * 1024));

      expect(() => walkAndWrite(fs, root, "/payload")).toThrow();
      expect(fs.stat("/payload/payload.bin").size).toBeGreaterThan(0);
      expect(fs.stat("/payload/payload.bin").size).toBeLessThan(1024 * 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a source entry type that a VFS image cannot represent", async () => {
    const root = mkdtempSync(join(tmpdir(), "vfs-walk-socket-"));
    const socketPath = join(root, "runtime.sock");
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));

      expect(() => walkAndWrite(fs, root, "/payload")).toThrow(
        new RegExp(`Unsupported VFS image source entry: ${socketPath}`),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
