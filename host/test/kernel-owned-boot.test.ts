import { describe, expect, it } from "vitest";
import {
  createEmptyBuildFs,
  overlayEtcFromRootfs,
} from "../../apps/browser-demos/lib/kernel-owned-boot";
import type { MemoryFileSystem } from "../src/vfs/memory-fs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function addFile(
  fs: MemoryFileSystem,
  path: string,
  contents: string,
  mode = 0o644,
  uid = 0,
  gid = 0,
): void {
  fs.createFileWithOwner(path, mode, uid, gid, encoder.encode(contents));
}

function readFile(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    expect(fs.read(fd, bytes, null, bytes.length)).toBe(bytes.length);
  } finally {
    fs.close(fd);
  }
  return decoder.decode(bytes);
}

describe("kernel-owned browser image assembly", () => {
  it("recursively merges canonical /etc while preserving caller leaves", async () => {
    const source = createEmptyBuildFs();
    source.mkdirWithOwner("/etc", 0o755, 0, 0);
    source.mkdirWithOwner("/etc/ssl", 0o750, 12, 34);
    addFile(source, "/etc/hosts", "canonical hosts\n");
    addFile(source, "/etc/ssl/openssl.cnf", "canonical config\n");
    addFile(source, "/etc/ssl/cert.pem", "canonical cert\n", 0o640, 12, 34);
    source.symlinkWithOwner("cert.pem", "/etc/ssl/current.pem", 12, 34);

    const target = createEmptyBuildFs();
    target.mkdirWithOwner("/etc", 0o755, 0, 0);
    target.mkdirWithOwner("/etc/ssl", 0o755, 1000, 1000);
    addFile(target, "/etc/ssl/openssl.cnf", "demo config\n", 0o600, 1000, 1000);

    overlayEtcFromRootfs(target, await source.saveImage());

    expect(readFile(target, "/etc/hosts")).toBe("canonical hosts\n");
    expect(readFile(target, "/etc/ssl/cert.pem")).toBe("canonical cert\n");
    expect(readFile(target, "/etc/ssl/openssl.cnf")).toBe("demo config\n");
    expect(target.readlink("/etc/ssl/current.pem")).toBe("cert.pem");
    expect(target.stat("/etc/ssl/cert.pem")).toMatchObject({
      mode: expect.any(Number),
      uid: 12,
      gid: 34,
    });
    expect(target.stat("/etc/ssl/cert.pem").mode & 0o7777).toBe(0o640);
    expect(target.stat("/etc/ssl/openssl.cnf")).toMatchObject({
      uid: 1000,
      gid: 1000,
    });
  });

  it("fails loudly when the canonical image has no /etc tree", async () => {
    const source = createEmptyBuildFs();
    const target = createEmptyBuildFs();
    const image = await source.saveImage();

    expect(() => overlayEtcFromRootfs(target, image)).toThrow();
  });
});
