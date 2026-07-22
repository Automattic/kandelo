import { zstdCompressSync } from "node:zlib";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadShellBaseFileSystemFromImage } from "../../images/vfs/scripts/shell-vfs-build";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import type { ZipEntry } from "../src/vfs/zip";

const MiB = 1024 * 1024;
const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

function writeFile(fs: MemoryFileSystem, path: string, text: string): void {
  const fd = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  const bytes = new TextEncoder().encode(text);
  fs.write(fd, bytes, null, bytes.byteLength);
  fs.close(fd);
}

function readFile(fs: MemoryFileSystem, path: string): string {
  const size = fs.stat(path).size;
  const fd = fs.open(path, O_RDONLY, 0);
  const bytes = new Uint8Array(size);
  const count = fs.read(fd, bytes, null, size);
  fs.close(fd);
  return new TextDecoder().decode(bytes.subarray(0, count));
}

function lazyArchiveEntry(): ZipEntry {
  return {
    fileName: "usr/share/demo/archive.txt",
    fileNameBytes: new TextEncoder().encode("usr/share/demo/archive.txt"),
    compressedSize: 10,
    uncompressedSize: 4096,
    compressionMethod: 8,
    localHeaderOffset: 0,
    mode: 0o644,
    isDirectory: false,
    isSymlink: false,
    externalAttrs: 0,
    creatorOS: 3,
  };
}

async function sourceImage(
  byteLength: number,
  maxByteLength: number,
): Promise<Uint8Array> {
  const buffer = new SharedArrayBuffer(byteLength, { maxByteLength });
  const fs = MemoryFileSystem.create(buffer, maxByteLength);
  writeFile(fs, "/ordinary.txt", "preserved contents");
  fs.registerLazyFile(
    "/bin/lazy-tool",
    "https://example.invalid/lazy-tool.wasm",
    123_456,
    0o755,
  );
  fs.registerLazyArchiveFromEntries(
    "https://example.invalid/demo.zip",
    [lazyArchiveEntry()],
    "/",
  );
  return fs.saveImage({
    metadata: { version: 1, createdBy: "shell-vfs-build.test" },
  });
}

function expectContentsPreserved(fs: MemoryFileSystem): void {
  expect(readFile(fs, "/ordinary.txt")).toBe("preserved contents");
  expect(fs.stat("/bin/lazy-tool").size).toBe(123_456);
  expect(fs.stat("/bin/lazy-tool").mode & 0o777).toBe(0o755);
  expect(fs.exportLazyEntries()).toMatchObject([
    {
      path: "/bin/lazy-tool",
      url: "https://example.invalid/lazy-tool.wasm",
      size: 123_456,
    },
  ]);
  expect(fs.stat("/usr/share/demo/archive.txt").size).toBe(4096);
  expect(fs.exportLazyArchiveEntries()).toMatchObject([
    {
      url: "https://example.invalid/demo.zip",
      mountPrefix: "/",
      materialized: false,
    },
  ]);
}

describe("shell VFS base composition", () => {
  it("routes every shell-derived product builder through the headroom gate", () => {
    const scriptsDir = join(import.meta.dirname, "../../images/vfs/scripts");
    const builders = readdirSync(scriptsDir)
      .filter((name) => name.startsWith("build-") && name.endsWith("-vfs-image.ts"))
      .filter((name) =>
        readFileSync(join(scriptsDir, name), "utf8").includes(
          "loadShellBaseFileSystem(",
        )
      )
      .sort();

    expect(builders).toEqual([
      "build-lamp-vfs-image.ts",
      "build-nginx-php-vfs-image.ts",
      "build-nginx-vfs-image.ts",
      "build-node-vfs-image.ts",
      "build-wp-vfs-image.ts",
    ]);
    for (const builder of builders) {
      const source = readFileSync(join(scriptsDir, builder), "utf8");
      expect(source, builder).toContain("saveShellDerivedVfsImage(");
      expect(source, builder).not.toMatch(/\bsaveImage\(/);
    }
  });

  it("rebases a serialized source larger than the downstream capacity", async () => {
    const image = await sourceImage(16 * MiB, 32 * MiB);
    const compressed = new Uint8Array(zstdCompressSync(image));

    expect(() =>
      MemoryFileSystem.fromImage(compressed, { maxByteLength: 8 * MiB }),
    ).toThrow(RangeError);

    const rebased = loadShellBaseFileSystemFromImage(compressed, 8 * MiB);

    expect(rebased.sharedBuffer.byteLength).toBe(8 * MiB);
    expect(rebased.sharedBuffer.maxByteLength).toBe(8 * MiB);
    const stats = rebased.statfs("/");
    expect(stats.blocks * stats.bsize).toBe(8 * MiB);
    expectContentsPreserved(rebased);
  });

  it("rebases upward to the downstream image's exact capacity", async () => {
    const image = await sourceImage(4 * MiB, 8 * MiB);

    const rebased = loadShellBaseFileSystemFromImage(image, 32 * MiB);

    expect(rebased.sharedBuffer.maxByteLength).toBe(32 * MiB);
    const stats = rebased.statfs("/");
    expect(stats.blocks * stats.bsize).toBe(32 * MiB);
    expectContentsPreserved(rebased);
  });

  it("preserves the source filesystem when capacities already match", async () => {
    const image = await sourceImage(4 * MiB, 8 * MiB);

    const restored = loadShellBaseFileSystemFromImage(image, 8 * MiB);

    expect(restored.sharedBuffer.byteLength).toBe(4 * MiB);
    expect(restored.sharedBuffer.maxByteLength).toBe(8 * MiB);
    expectContentsPreserved(restored);
  });
});
