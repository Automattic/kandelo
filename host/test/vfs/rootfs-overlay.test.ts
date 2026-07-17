import { describe, expect, it, vi } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { overlayEtcFromRootfs } from "../../src/vfs/rootfs-overlay";
import {
  ENOENT,
  ENOSPC,
  S_IFDIR,
  S_IFLNK,
  S_IFMT,
  S_IFREG,
  SFSError,
} from "../../src/vfs/sharedfs-vendor";

function createFs(bytes = 2 * 1024 * 1024): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(bytes));
}

function writeText(
  fs: MemoryFileSystem,
  path: string,
  text: string,
  mode = 0o644,
  uid = 0,
  gid = 0,
): void {
  fs.createFileWithOwner(
    path,
    mode,
    uid,
    gid,
    new TextEncoder().encode(text),
  );
}

function readText(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    expect(fs.read(fd, bytes, null, bytes.length)).toBe(bytes.length);
  } finally {
    fs.close(fd);
  }
  return new TextDecoder().decode(bytes);
}

function captureError(operation: () => void): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}

describe("canonical rootfs /etc overlay", () => {
  it("copies nested state and metadata while preserving caller-owned entries", async () => {
    const source = createFs();
    source.mkdirWithOwner("/etc", 0o755, 0, 0);
    source.mkdirWithOwner("/etc/ssl", 0o755, 0, 0);
    source.mkdirWithOwner("/etc/ssl/certs", 0o750, 12, 34);
    writeText(source, "/etc/ssl/openssl.cnf", "canonical\n");
    writeText(source, "/etc/ssl/cert.pem", "root bundle\n", 0o640, 12, 34);
    source.symlinkWithOwner("../cert.pem", "/etc/ssl/certs/default.pem", 12, 34);
    source.symlinkWithOwner("../cert.pem", "/etc/ssl/certs/copied.pem", 12, 34);

    const target = createFs();
    target.mkdirWithOwner("/etc", 0o755, 0, 0);
    target.mkdirWithOwner("/etc/ssl", 0o700, 1000, 1000);
    target.mkdirWithOwner("/etc/ssl/certs", 0o700, 1000, 1000);
    writeText(target, "/etc/ssl/openssl.cnf", "caller policy\n", 0o600, 1000, 1000);
    target.symlinkWithOwner(
      "/caller/trust.pem",
      "/etc/ssl/certs/default.pem",
      1000,
      1000,
    );

    overlayEtcFromRootfs(target, await source.saveImage());

    expect(readText(target, "/etc/ssl/openssl.cnf")).toBe("caller policy\n");
    expect(target.stat("/etc/ssl/openssl.cnf")).toMatchObject({
      mode: S_IFREG | 0o600,
      uid: 1000,
      gid: 1000,
    });
    expect(readText(target, "/etc/ssl/cert.pem")).toBe("root bundle\n");
    expect(target.stat("/etc/ssl/cert.pem")).toMatchObject({
      mode: S_IFREG | 0o640,
      uid: 12,
      gid: 34,
    });
    expect(target.readlink("/etc/ssl/certs/default.pem")).toBe(
      "/caller/trust.pem",
    );
    expect(target.readlink("/etc/ssl/certs/copied.pem")).toBe("../cert.pem");
    expect(target.lstat("/etc/ssl/certs/copied.pem")).toMatchObject({
      mode: S_IFLNK | 0o777,
      uid: 12,
      gid: 34,
    });

    expect(target.lstat("/etc").mode & S_IFMT).toBe(S_IFDIR);
    expect(target.lstat("/etc/ssl/cert.pem").mode & S_IFMT).toBe(S_IFREG);
    expect(target.lstat("/etc/ssl/certs/copied.pem").mode & S_IFMT).toBe(
      S_IFLNK,
    );
    expect(target.stat("/etc/ssl")).toMatchObject({
      mode: S_IFDIR | 0o700,
      uid: 1000,
      gid: 1000,
    });
    expect(target.stat("/etc/ssl/certs")).toMatchObject({
      mode: S_IFDIR | 0o700,
      uid: 1000,
      gid: 1000,
    });
  });

  it("preserves metadata on canonical directories created in the target", async () => {
    const source = createFs();
    source.mkdirWithOwner("/etc", 0o751, 12, 34);
    source.mkdirWithOwner("/etc/ssl", 0o750, 56, 78);
    const target = createFs();

    overlayEtcFromRootfs(target, await source.saveImage());

    expect(target.stat("/etc")).toMatchObject({
      mode: S_IFDIR | 0o751,
      uid: 12,
      gid: 34,
    });
    expect(target.stat("/etc/ssl")).toMatchObject({
      mode: S_IFDIR | 0o750,
      uid: 56,
      gid: 78,
    });
  });

  it("propagates ENOENT when the canonical image has no /etc tree", async () => {
    const source = createFs();
    const target = createFs();
    const image = await source.saveImage();

    const error = captureError(() => overlayEtcFromRootfs(target, image));

    expect(error).toBeInstanceOf(SFSError);
    expect((error as SFSError).code).toBe(ENOENT);
  });

  it("rejects a short source read instead of copying a truncated file", async () => {
    const source = createFs();
    source.mkdirWithOwner("/etc", 0o755, 0, 0);
    writeText(source, "/etc/hosts", "127.0.0.1 localhost\n");
    const image = await source.saveImage();
    const target = createFs();
    const readSpy = vi
      .spyOn(MemoryFileSystem.prototype, "read")
      .mockReturnValueOnce(0);

    try {
      expect(() => overlayEtcFromRootfs(target, image)).toThrow(
        "Short read while copying canonical rootfs path /etc/hosts: 0/20 bytes",
      );
    } finally {
      readSpy.mockRestore();
    }
  });

  it("propagates target capacity failures instead of accepting a partial overlay", async () => {
    const source = createFs();
    source.mkdirWithOwner("/etc", 0o755, 0, 0);
    source.mkdirWithOwner("/etc/ssl", 0o755, 0, 0);
    writeText(source, "/etc/ssl/cert.pem", "x".repeat(128 * 1024));
    const target = createFs(64 * 1024);
    const image = await source.saveImage();

    const error = captureError(() => overlayEtcFromRootfs(target, image));

    expect(error).toBeInstanceOf(SFSError);
    expect((error as SFSError).code).toBe(ENOSPC);
  });
});
