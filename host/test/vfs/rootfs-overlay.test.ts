import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../src/vfs/memory-fs";
import { overlayEtcFromRootfs } from "../../src/vfs/rootfs-overlay";

const S_IFMT = 0xf000;
const S_IFDIR = 0x4000;
const S_IFREG = 0x8000;
const S_IFLNK = 0xa000;

function createFs(bytes = 2 * 1024 * 1024): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(bytes));
}

function writeText(
  fs: MemoryFileSystem,
  path: string,
  text: string,
  mode = 0o644,
): void {
  fs.createFileWithOwner(path, mode, 0, 0, new TextEncoder().encode(text));
}

function readText(fs: MemoryFileSystem, path: string): string {
  const st = fs.stat(path);
  const bytes = new Uint8Array(st.size);
  const fd = fs.open(path, 0, 0);
  try {
    expect(fs.read(fd, bytes, null, bytes.length)).toBe(bytes.length);
  } finally {
    fs.close(fd);
  }
  return new TextDecoder().decode(bytes);
}

describe("legacy browser rootfs /etc overlay", () => {
  it("recursively copies nested files and symlinks while preserving demo leaves", async () => {
    const source = createFs();
    source.mkdirWithOwner("/etc", 0o755, 0, 0);
    source.mkdirWithOwner("/etc/ssl", 0o755, 0, 0);
    source.mkdirWithOwner("/etc/ssl/certs", 0o755, 0, 0);
    writeText(source, "/etc/ssl/openssl.cnf", "canonical\n");
    writeText(source, "/etc/ssl/cert.pem", "root bundle\n");
    source.symlinkWithOwner("../cert.pem", "/etc/ssl/certs/default.pem", 0, 0);
    source.symlinkWithOwner("../cert.pem", "/etc/ssl/certs/copied.pem", 0, 0);

    const target = createFs();
    target.mkdirWithOwner("/etc", 0o755, 0, 0);
    target.mkdirWithOwner("/etc/ssl", 0o700, 1000, 1000);
    target.mkdirWithOwner("/etc/ssl/certs", 0o700, 1000, 1000);
    writeText(target, "/etc/ssl/openssl.cnf", "demo policy\n", 0o600);
    target.symlinkWithOwner(
      "/demo/trust.pem",
      "/etc/ssl/certs/default.pem",
      1000,
      1000,
    );

    overlayEtcFromRootfs(target, await source.saveImage());

    expect(readText(target, "/etc/ssl/openssl.cnf")).toBe("demo policy\n");
    expect(target.stat("/etc/ssl/openssl.cnf").mode & 0o7777).toBe(0o600);
    expect(readText(target, "/etc/ssl/cert.pem")).toBe("root bundle\n");
    expect(target.stat("/etc/ssl/cert.pem")).toMatchObject({
      mode: S_IFREG | 0o644,
      uid: 0,
      gid: 0,
    });
    expect(target.readlink("/etc/ssl/certs/default.pem")).toBe(
      "/demo/trust.pem",
    );
    expect(target.readlink("/etc/ssl/certs/copied.pem")).toBe("../cert.pem");

    expect(target.lstat("/etc").mode & S_IFMT).toBe(S_IFDIR);
    expect(target.lstat("/etc/ssl/cert.pem").mode & S_IFMT).toBe(S_IFREG);
    expect(target.lstat("/etc/ssl/certs/default.pem").mode & S_IFMT).toBe(
      S_IFLNK,
    );
    expect(target.lstat("/etc/ssl/certs/copied.pem")).toMatchObject({
      mode: S_IFLNK | 0o777,
      uid: 0,
      gid: 0,
    });
    // Existing directory ownership and mode remain demo-owned even though
    // missing canonical leaves were merged below it.
    expect(target.stat("/etc/ssl")).toMatchObject({
      mode: S_IFDIR | 0o700,
      uid: 1000,
      gid: 1000,
    });
  });

  it("fails when the canonical image has no /etc tree", async () => {
    const source = createFs();
    const target = createFs();
    const image = await source.saveImage();

    expect(() => overlayEtcFromRootfs(target, image)).toThrow(
      "No such file or directory",
    );
  });

  it("propagates target capacity failures instead of accepting a partial overlay", async () => {
    const source = createFs();
    source.mkdirWithOwner("/etc", 0o755, 0, 0);
    source.mkdirWithOwner("/etc/ssl", 0o755, 0, 0);
    writeText(source, "/etc/ssl/cert.pem", "x".repeat(128 * 1024));
    const target = createFs(64 * 1024);
    const image = await source.saveImage();

    expect(() => overlayEtcFromRootfs(target, image)).toThrow(
      "No space left on device",
    );
  });
});
