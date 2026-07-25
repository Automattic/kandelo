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
  saveImage,
  walkAndWrite,
  writeVfsBinary,
} from "../../images/vfs/scripts/vfs-image-helpers";
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

function artifactFileSystem(): MemoryFileSystem {
  const fs = MemoryFileSystem.create(
    new SharedArrayBuffer(4 * 1024 * 1024),
  );
  writeVfsBinary(
    fs,
    "/ordinary.bin",
    new TextEncoder().encode("ordinary artifact bytes"),
  );
  return fs;
}

async function expectArtifactInspectionFailure(
  fs: MemoryFileSystem,
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
