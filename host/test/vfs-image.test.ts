import { describe, it, expect, vi } from "vitest";
import { zstdCompressSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ABI_VERSION } from "../src/generated/abi";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { saveImage } from "../../images/vfs/scripts/vfs-image-helpers";

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_RDWR = 0x0002;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

function createMemfs(): MemoryFileSystem {
  const sab = new SharedArrayBuffer(4 * 1024 * 1024);
  return MemoryFileSystem.create(sab);
}

function writeFile(
  mfs: MemoryFileSystem,
  path: string,
  data: Uint8Array,
  mode = 0o644,
): void {
  // Ensure parent directories exist
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (let i = 0; i < parts.length - 1; i++) {
    current += "/" + parts[i];
    try {
      mfs.mkdir(current, 0o755);
    } catch {
      /* exists */
    }
  }
  const fd = mfs.open(path, O_WRONLY | O_CREAT | O_TRUNC, mode);
  mfs.write(fd, data, null, data.length);
  mfs.close(fd);
}

function readFile(mfs: MemoryFileSystem, path: string): Uint8Array {
  const st = mfs.stat(path);
  const fd = mfs.open(path, O_RDONLY, 0);
  const buf = new Uint8Array(st.size);
  const n = mfs.read(fd, buf, null, buf.length);
  mfs.close(fd);
  return buf.subarray(0, n);
}

function readDir(mfs: MemoryFileSystem, path: string): string[] {
  const dh = mfs.opendir(path);
  const names: string[] = [];
  for (;;) {
    const entry = mfs.readdir(dh);
    if (!entry) break;
    if (entry.name !== "." && entry.name !== "..") names.push(entry.name);
  }
  mfs.closedir(dh);
  return names.sort();
}

function stripStandaloneLazyIdentity(image: Uint8Array): Uint8Array {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const sabLen = view.getUint32(12, true);
  const lazyOffset = 16 + sabLen;
  const lazyLen = view.getUint32(lazyOffset, true);
  const entries = JSON.parse(
    new TextDecoder().decode(
      image.subarray(lazyOffset + 4, lazyOffset + 4 + lazyLen),
    ),
  ) as Array<{ generation?: number; dataSequence?: number }>;
  for (const entry of entries) {
    delete entry.generation;
    delete entry.dataSequence;
  }
  const lazyJson = new TextEncoder().encode(JSON.stringify(entries));
  const legacy = new Uint8Array(lazyOffset + 4 + lazyJson.byteLength);
  legacy.set(image.subarray(0, lazyOffset));
  new DataView(legacy.buffer).setUint32(lazyOffset, lazyJson.byteLength, true);
  legacy.set(lazyJson, lazyOffset + 4);
  return legacy;
}

describe("VFS image save/restore", () => {
  describe("snapshot timestamp policy", () => {
    it("normalizes only the detached image while runtime timestamps remain real", async () => {
      const runtimeNow = 1_700_000_123_456;
      const normalizedNow = 946_684_800_000;
      const now = vi.spyOn(Date, "now").mockReturnValue(runtimeNow);

      try {
        const mfs = createMemfs();
        mfs.mkdir("/tree", 0o755);
        writeFile(
          mfs,
          "/tree/file.txt",
          new TextEncoder().encode("contents"),
        );
        mfs.symlink("tree/file.txt", "/link");

        const liveFile = mfs.stat("/tree/file.txt");
        expect(liveFile.atimeMs).toBe(runtimeNow);
        expect(liveFile.mtimeMs).toBe(runtimeNow);
        expect(liveFile.ctimeMs).toBe(runtimeNow);

        const normalizedImage = await mfs.saveImage({
          normalizeTimestampsMs: normalizedNow,
        });

        // Snapshot normalization must never rewrite authoritative live state.
        expect(mfs.stat("/tree/file.txt")).toEqual(liveFile);

        const restored = MemoryFileSystem.fromImage(normalizedImage);
        for (const path of ["/", "/tree", "/tree/file.txt", "/link"]) {
          const stat = restored.lstat(path);
          expect(stat.atimeMs, `${path} atime`).toBe(normalizedNow);
          expect(stat.mtimeMs, `${path} mtime`).toBe(normalizedNow);
          expect(stat.ctimeMs, `${path} ctime`).toBe(normalizedNow);
        }

        // Ordinary runtime snapshots preserve the POSIX timestamps they saw.
        const ordinary = MemoryFileSystem.fromImage(await mfs.saveImage());
        expect(ordinary.stat("/tree/file.txt").atimeMs).toBe(runtimeNow);
        expect(ordinary.stat("/tree/file.txt").mtimeMs).toBe(runtimeNow);
        expect(ordinary.stat("/tree/file.txt").ctimeMs).toBe(runtimeNow);
      } finally {
        now.mockRestore();
      }
    });

    it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
      "rejects invalid normalized timestamp %s",
      async (normalizeTimestampsMs) => {
        const mfs = createMemfs();
        await expect(
          mfs.saveImage({ normalizeTimestampsMs }),
        ).rejects.toThrow(/non-negative safe integer/);
      },
    );

    it("clears wall-clock timestamps retained by freed inode slots", async () => {
      const build = async (runtimeNow: number): Promise<Uint8Array> => {
        const now = vi.spyOn(Date, "now").mockReturnValue(runtimeNow);
        try {
          const mfs = createMemfs();
          writeFile(mfs, "/kept", new Uint8Array([1, 2, 3]));
          writeFile(mfs, "/discarded", new Uint8Array([4, 5, 6]));
          mfs.unlink("/discarded");
          return await mfs.saveImage({ normalizeTimestampsMs: 0 });
        } finally {
          now.mockRestore();
        }
      };

      const first = await build(1_700_000_000_000);
      const second = await build(1_800_000_000_000);
      expect(second.byteLength).toBe(first.byteLength);
      expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    });
  });

  describe("saveImage + fromImage round-trip", () => {
    it("preserves a single file", async () => {
      const mfs = createMemfs();
      const content = new TextEncoder().encode("hello world");
      writeFile(mfs, "/greeting.txt", content);

      const image = await mfs.saveImage();
      const restored = MemoryFileSystem.fromImage(image);

      const read = readFile(restored, "/greeting.txt");
      expect(new TextDecoder().decode(read)).toBe("hello world");
    });

    it("preserves file permissions", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/script.sh", new Uint8Array([0x23, 0x21]), 0o755);

      const image = await mfs.saveImage();
      const restored = MemoryFileSystem.fromImage(image);

      const st = restored.stat("/script.sh");
      expect(st.mode & 0o777).toBe(0o755);
    });

    it("preserves directory structure", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/usr/local/bin/tool", new Uint8Array([1, 2, 3]));
      writeFile(mfs, "/usr/local/lib/libfoo.so", new Uint8Array([4, 5, 6]));
      writeFile(mfs, "/etc/config", new Uint8Array([7, 8]));

      const image = await mfs.saveImage();
      const restored = MemoryFileSystem.fromImage(image);

      expect(readFile(restored, "/usr/local/bin/tool")).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      expect(readFile(restored, "/usr/local/lib/libfoo.so")).toEqual(
        new Uint8Array([4, 5, 6]),
      );
      expect(readFile(restored, "/etc/config")).toEqual(new Uint8Array([7, 8]));

      // Verify directory listing
      expect(readDir(restored, "/usr/local")).toEqual(["bin", "lib"]);
    });

    it("preserves symlinks", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/target.txt", new TextEncoder().encode("data"));
      mfs.symlink("/target.txt", "/link.txt");

      const image = await mfs.saveImage();
      const restored = MemoryFileSystem.fromImage(image);

      expect(restored.readlink("/link.txt")).toBe("/target.txt");
      const read = readFile(restored, "/link.txt");
      expect(new TextDecoder().decode(read)).toBe("data");
    });

    it("preserves multiple files of varying sizes", async () => {
      const mfs = createMemfs();
      // Empty file
      writeFile(mfs, "/empty", new Uint8Array(0));
      // Small file
      writeFile(mfs, "/small", new Uint8Array([42]));
      // Larger file (64KB)
      const large = new Uint8Array(64 * 1024);
      for (let i = 0; i < large.length; i++) large[i] = i & 0xff;
      writeFile(mfs, "/large", large);

      const image = await mfs.saveImage();
      const restored = MemoryFileSystem.fromImage(image);

      expect(restored.stat("/empty").size).toBe(0);
      expect(readFile(restored, "/small")).toEqual(new Uint8Array([42]));
      const readLarge = readFile(restored, "/large");
      expect(readLarge.length).toBe(64 * 1024);
      expect(readLarge[0]).toBe(0);
      expect(readLarge[255]).toBe(255);
      expect(readLarge[256]).toBe(0);
    });

    it("produces a valid image even with an empty filesystem", async () => {
      const mfs = createMemfs();
      const image = await mfs.saveImage();
      const restored = MemoryFileSystem.fromImage(image);

      // Root directory should exist
      const st = restored.stat("/");
      expect(st.mode & 0o170000).toBe(0o040000); // S_IFDIR
    });

    it("restored filesystem is writable", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/existing.txt", new TextEncoder().encode("old"));

      const image = await mfs.saveImage();
      const restored = MemoryFileSystem.fromImage(image);

      // Can write new files
      writeFile(restored, "/new.txt", new TextEncoder().encode("new"));
      expect(new TextDecoder().decode(readFile(restored, "/new.txt"))).toBe(
        "new",
      );

      // Can modify existing files
      writeFile(restored, "/existing.txt", new TextEncoder().encode("updated"));
      expect(
        new TextDecoder().decode(readFile(restored, "/existing.txt")),
      ).toBe("updated");
    });
  });

  describe("lazy file handling", () => {
    it("preserves lazy file metadata by default", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/real.txt", new TextEncoder().encode("real content"));
      mfs.registerLazyFile(
        "/bin/lazy-tool",
        "http://example.com/tool.wasm",
        12345,
        0o755,
      );

      const image = await mfs.saveImage();
      const restored = MemoryFileSystem.fromImage(image);

      // Real file content preserved
      expect(new TextDecoder().decode(readFile(restored, "/real.txt"))).toBe(
        "real content",
      );

      // Lazy file metadata preserved — stat reports declared size
      const st = restored.stat("/bin/lazy-tool");
      expect(st.size).toBe(12345);
      expect(st.mode & 0o777).toBe(0o755);

      // Lazy entries are exported correctly from restored instance
      const entries = restored.exportLazyEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe("/bin/lazy-tool");
      expect(entries[0].url).toBe("http://example.com/tool.wasm");
      expect(entries[0].size).toBe(12345);
    });

    it("restores identity-less lazy metadata only from its coherent legacy image", async () => {
      const mfs = createMemfs();
      mfs.registerLazyFile(
        "/bin/legacy-tool",
        "http://example.com/legacy.wasm",
        54321,
        0o755,
      );

      const restored = MemoryFileSystem.fromImage(
        stripStandaloneLazyIdentity(await mfs.saveImage()),
      );

      expect(restored.getLazyEntry("/bin/legacy-tool")).toMatchObject({
        path: "/bin/legacy-tool",
        url: "http://example.com/legacy.wasm",
        size: 54321,
      });
      expect(restored.stat("/bin/legacy-tool").size).toBe(54321);
    });

    it("preserves multiple lazy files", async () => {
      const mfs = createMemfs();
      mfs.registerLazyFile("/bin/a", "http://example.com/a.wasm", 100);
      mfs.registerLazyFile("/bin/b", "http://example.com/b.wasm", 200);
      mfs.registerLazyFile("/usr/lib/c.so", "http://example.com/c.so", 300);

      const image = await mfs.saveImage();
      const restored = MemoryFileSystem.fromImage(image);

      const entries = restored.exportLazyEntries();
      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.path).sort()).toEqual([
        "/bin/a",
        "/bin/b",
        "/usr/lib/c.so",
      ]);
    });

    it("reconciles a peer-renamed lazy path before saving", async () => {
      const sab = new SharedArrayBuffer(4 * 1024 * 1024);
      const fsA = MemoryFileSystem.create(sab);
      const fsB = MemoryFileSystem.fromExisting(sab);
      const url = "http://example.com/lazy.wasm";

      fsA.registerLazyFile("/lazy", url, 12_345, 0o755);
      fsB.rename("/lazy", "/moved");

      const restored = MemoryFileSystem.fromImage(await fsA.saveImage());
      expect(() => restored.stat("/lazy")).toThrow(/No such file/);
      expect(restored.stat("/moved").size).toBe(12_345);
      expect(restored.getLazyEntry("/moved")).toMatchObject({
        path: "/moved",
        url,
        size: 12_345,
      });
      expect(restored.exportLazyEntries()).toHaveLength(1);
    });

    it("explicit content replacement clears lazy entries from the image", async () => {
      const mfs = createMemfs();
      mfs.registerLazyFile(
        "/bin/tool",
        "http://example.com/tool.wasm",
        5000,
        0o755,
      );

      const toolContent = new Uint8Array(100);
      for (let i = 0; i < 100; i++) toolContent[i] = i;
      const fd = mfs.open("/bin/tool", O_WRONLY | O_CREAT | O_TRUNC, 0o755);
      mfs.write(fd, toolContent, null, toolContent.length);
      mfs.close(fd);

      expect(mfs.exportLazyEntries()).toHaveLength(0);
      const image = await mfs.saveImage();

      const restored = MemoryFileSystem.fromImage(image);
      expect(restored.exportLazyEntries()).toHaveLength(0);
      expect(readFile(restored, "/bin/tool")).toEqual(toolContent);
    });

    it("image without lazy files has no lazy flag", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/test.txt", new TextEncoder().encode("test"));

      const image = await mfs.saveImage();
      const view = new DataView(
        image.buffer,
        image.byteOffset,
        image.byteLength,
      );
      const flags = view.getUint32(8, true);
      expect(flags & 1).toBe(0); // no lazy flag
    });

    it("image with lazy files has lazy flag set", async () => {
      const mfs = createMemfs();
      mfs.registerLazyFile("/bin/tool", "http://example.com/tool.wasm", 1000);

      const image = await mfs.saveImage();
      const view = new DataView(
        image.buffer,
        image.byteOffset,
        image.byteLength,
      );
      const flags = view.getUint32(8, true);
      expect(flags & 1).toBe(1); // lazy flag set
    });
  });

  describe("image metadata", () => {
    it("stores and restores a kernel ABI declaration", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/bin/tool", new Uint8Array([0, 97, 115, 109]), 0o755);
      mfs.setImageMetadata({
        version: 1,
        kernelAbi: 11,
        createdBy: "vfs-image.test",
      });

      const image = await mfs.saveImage();
      const view = new DataView(
        image.buffer,
        image.byteOffset,
        image.byteLength,
      );
      const flags = view.getUint32(8, true);
      expect(flags & 4).toBe(4); // metadata flag set

      expect(MemoryFileSystem.readImageMetadata(image)).toEqual({
        version: 1,
        kernelAbi: 11,
        createdBy: "vfs-image.test",
      });

      const restored = MemoryFileSystem.fromImage(image);
      expect(restored.getImageMetadata()).toEqual({
        version: 1,
        kernelAbi: 11,
        createdBy: "vfs-image.test",
      });
      expect(new TextDecoder().decode(readFile(restored, "/bin/tool"))).toBe(
        "\0asm",
      );
    });

    it("preserves metadata when a restored image is saved again", async () => {
      const mfs = createMemfs();
      const image = await mfs.saveImage({
        metadata: { version: 1, kernelAbi: 9 },
      });

      const restored = MemoryFileSystem.fromImage(image);
      const resaved = await restored.saveImage();

      expect(MemoryFileSystem.readImageMetadata(resaved)).toEqual({
        version: 1,
        kernelAbi: 9,
      });
    });

    it("can clear metadata on save", async () => {
      const mfs = createMemfs();
      const image = await mfs.saveImage({
        metadata: { version: 1, kernelAbi: 9 },
      });
      const restored = MemoryFileSystem.fromImage(image);

      const cleared = await restored.saveImage({ metadata: null });
      const view = new DataView(
        cleared.buffer,
        cleared.byteOffset,
        cleared.byteLength,
      );
      const flags = view.getUint32(8, true);
      expect(flags & 4).toBe(0);
      expect(MemoryFileSystem.readImageMetadata(cleared)).toBeNull();
    });

    it("reads metadata from a zstd-wrapped image without materializing callers' fs state", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/data.txt", new TextEncoder().encode("metadata"));
      const image = await mfs.saveImage({
        metadata: { version: 1, kernelAbi: ABI_VERSION },
      });
      const compressed = new Uint8Array(zstdCompressSync(image));

      expect(MemoryFileSystem.readImageMetadata(compressed)).toEqual({
        version: 1,
        kernelAbi: ABI_VERSION,
      });
      expect(MemoryFileSystem.fromImage(compressed).getImageMetadata()).toEqual(
        {
          version: 1,
          kernelAbi: ABI_VERSION,
        },
      );
    });

    it("rejects malformed metadata declarations", async () => {
      const mfs = createMemfs();
      await expect(
        mfs.saveImage({ metadata: { version: 1, kernelAbi: 1.5 } }),
      ).rejects.toThrow(/kernelAbi/);
      await expect(
        mfs.saveImage({ metadata: { version: 2 as 1, kernelAbi: 11 } }),
      ).rejects.toThrow(/metadata version/);
    });

    it("validates a declared kernel ABI against the running ABI supplied by the caller", async () => {
      const mfs = createMemfs();
      const olderAbi = ABI_VERSION - 1;
      const image = await mfs.saveImage({
        metadata: { version: 1, kernelAbi: olderAbi },
      });

      expect(() =>
        MemoryFileSystem.assertImageKernelAbi(image, olderAbi),
      ).not.toThrow();
      expect(() =>
        MemoryFileSystem.assertImageKernelAbi(image, ABI_VERSION, "test image"),
      ).toThrow(
        new RegExp(
          `test image requires kernel ABI ${olderAbi}.*running kernel is ABI ${ABI_VERSION}`,
        ),
      );
    });
  });

  describe("zstd-compressed images", () => {
    it("fromImage transparently decompresses a zstd-wrapped image", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/hello.txt", new TextEncoder().encode("compressed!"));
      writeFile(mfs, "/etc/config", new Uint8Array([1, 2, 3, 4]));

      const image = await mfs.saveImage();
      const compressed = new Uint8Array(zstdCompressSync(image));

      // Sanity-check the zstd magic so we know the test is exercising the path.
      expect(compressed[0]).toBe(0x28);
      expect(compressed[1]).toBe(0xb5);
      expect(compressed[2]).toBe(0x2f);
      expect(compressed[3]).toBe(0xfd);

      const restored = MemoryFileSystem.fromImage(compressed);
      expect(new TextDecoder().decode(readFile(restored, "/hello.txt"))).toBe(
        "compressed!",
      );
      expect(readFile(restored, "/etc/config")).toEqual(
        new Uint8Array([1, 2, 3, 4]),
      );
    });

    it("fromImage with maxByteLength still works on zstd-wrapped image", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/data.txt", new TextEncoder().encode("hi"));
      const compressed = new Uint8Array(
        zstdCompressSync(await mfs.saveImage()),
      );

      const restored = MemoryFileSystem.fromImage(compressed, {
        maxByteLength: 16 * 1024 * 1024,
      });
      expect(restored.sharedBuffer.maxByteLength).toBe(16 * 1024 * 1024);
      expect(new TextDecoder().decode(readFile(restored, "/data.txt"))).toBe(
        "hi",
      );
    });

    it("saveImage writes a .vfs.zst that fromImage can restore", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/etc/hostname", new TextEncoder().encode("wasmbox\n"));
      // Non-zero pattern so the zstd ratio actually reflects content,
      // not just the empty SAB tail.
      const big = new Uint8Array(200 * 1024);
      for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
      writeFile(mfs, "/usr/lib/libfoo.so", big, 0o755);

      const dir = mkdtempSync(join(tmpdir(), "vfs-zst-"));
      const out = join(dir, "test.vfs.zst");
      try {
        await saveImage(mfs, out);

        // File on disk: starts with zstd magic, smaller than SAB.
        const onDisk = new Uint8Array(readFileSync(out));
        expect(onDisk[0]).toBe(0x28);
        expect(onDisk[1]).toBe(0xb5);
        expect(onDisk[2]).toBe(0x2f);
        expect(onDisk[3]).toBe(0xfd);
        expect(statSync(out).size).toBeLessThan(mfs.sharedBuffer.byteLength);

        // Round-trip through fromImage straight from the on-disk bytes.
        const restored = MemoryFileSystem.fromImage(onDisk, {
          maxByteLength: 8 * 1024 * 1024,
        });
        expect(
          new TextDecoder().decode(readFile(restored, "/etc/hostname")),
        ).toBe("wasmbox\n");
        const restoredBig = readFile(restored, "/usr/lib/libfoo.so");
        expect(restoredBig.length).toBe(big.length);
        expect(restoredBig).toEqual(big);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("saveImage rejects a non-.vfs.zst output path", async () => {
      const mfs = createMemfs();
      const dir = mkdtempSync(join(tmpdir(), "vfs-zst-"));
      try {
        await expect(saveImage(mfs, join(dir, "wrong.vfs"))).rejects.toThrow(
          /must end in \.vfs\.zst/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("image format validation", () => {
    it("rejects image with bad magic", () => {
      const bad = new Uint8Array(32);
      new DataView(bad.buffer).setUint32(0, 0xdeadbeef, true);
      expect(() => MemoryFileSystem.fromImage(bad)).toThrow(
        "Bad VFS image magic",
      );
    });

    it("rejects image with wrong version", () => {
      const bad = new Uint8Array(32);
      const view = new DataView(bad.buffer);
      view.setUint32(0, 0x56465349, true); // VFSI magic
      view.setUint32(4, 99, true); // bad version
      expect(() => MemoryFileSystem.fromImage(bad)).toThrow(
        "Unsupported VFS image version",
      );
    });

    it("rejects truncated image", () => {
      const bad = new Uint8Array(16);
      const view = new DataView(bad.buffer);
      view.setUint32(0, 0x56465349, true);
      view.setUint32(4, 1, true);
      view.setUint32(8, 0, true);
      view.setUint32(12, 1000000, true); // claims 1MB of SAB data but only 16 bytes total
      expect(() => MemoryFileSystem.fromImage(bad)).toThrow("truncated");
    });

    it("rejects image that is too small", () => {
      expect(() => MemoryFileSystem.fromImage(new Uint8Array(4))).toThrow(
        "too small",
      );
    });

    it("image has correct magic and version", async () => {
      const mfs = createMemfs();
      const image = await mfs.saveImage();
      const view = new DataView(
        image.buffer,
        image.byteOffset,
        image.byteLength,
      );
      expect(view.getUint32(0, true)).toBe(0x56465349); // "VFSI"
      expect(view.getUint32(4, true)).toBe(1); // version 1
    });
  });

  describe("sharedBuffer getter", () => {
    it("returns the underlying SharedArrayBuffer", () => {
      const mfs = createMemfs();
      const buf = mfs.sharedBuffer;
      expect(buf).toBeInstanceOf(SharedArrayBuffer);
      expect(buf.byteLength).toBe(4 * 1024 * 1024);
    });

    it("returns the same buffer on repeated calls", () => {
      const mfs = createMemfs();
      expect(mfs.sharedBuffer).toBe(mfs.sharedBuffer);
    });

    it("returns the restored SAB after fromImage", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/test.txt", new TextEncoder().encode("hello"));
      const image = await mfs.saveImage();
      const restored = MemoryFileSystem.fromImage(image);
      const buf = restored.sharedBuffer;
      expect(buf).toBeInstanceOf(SharedArrayBuffer);
      // Restored SAB should be a different object from original
      expect(buf).not.toBe(mfs.sharedBuffer);
    });
  });

  describe("fromImage with maxByteLength", () => {
    it("creates a growable SharedArrayBuffer", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/test.txt", new TextEncoder().encode("hello"));
      const image = await mfs.saveImage();

      const maxBytes = 16 * 1024 * 1024;
      const restored = MemoryFileSystem.fromImage(image, {
        maxByteLength: maxBytes,
      });
      const buf = restored.sharedBuffer;
      expect(buf).toBeInstanceOf(SharedArrayBuffer);
      // The SAB should have maxByteLength set (growable)
      expect(buf.maxByteLength).toBe(maxBytes);
      // Current byteLength should match the image's SAB size
      expect(buf.byteLength).toBe(4 * 1024 * 1024);
    });

    it("restored growable filesystem reports the image's permitted max capacity", async () => {
      const initialBytes = 1 * 1024 * 1024;
      const maxBytes = 8 * 1024 * 1024;
      const sab = new SharedArrayBuffer(initialBytes, {
        maxByteLength: maxBytes,
      });
      const mfs = MemoryFileSystem.create(sab, maxBytes);
      writeFile(mfs, "/test.txt", new TextEncoder().encode("hello"));
      const image = await mfs.saveImage();

      const restored = MemoryFileSystem.fromImage(image, {
        maxByteLength: maxBytes,
      });
      const stats = restored.statfs("/");

      expect(restored.sharedBuffer.byteLength).toBe(initialBytes);
      expect(restored.sharedBuffer.maxByteLength).toBe(maxBytes);
      expect(stats.blocks * stats.bsize).toBe(maxBytes);
      expect(stats.bfree).toBeGreaterThan(initialBytes / stats.bsize);
    });

    it("restored statfs capacity is capped by the image superblock max", async () => {
      const initialBytes = 1 * 1024 * 1024;
      const imageMaxBytes = 4 * 1024 * 1024;
      const runtimeMaxBytes = 8 * 1024 * 1024;
      const sab = new SharedArrayBuffer(initialBytes, {
        maxByteLength: imageMaxBytes,
      });
      const mfs = MemoryFileSystem.create(sab, imageMaxBytes);
      const image = await mfs.saveImage();

      const restored = MemoryFileSystem.fromImage(image, {
        maxByteLength: runtimeMaxBytes,
      });
      const stats = restored.statfs("/");

      expect(restored.sharedBuffer.maxByteLength).toBe(runtimeMaxBytes);
      expect(stats.blocks * stats.bsize).toBe(imageMaxBytes);
    });

    it("restored filesystem with maxByteLength is writable", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/original.txt", new TextEncoder().encode("data"));
      const image = await mfs.saveImage();

      const restored = MemoryFileSystem.fromImage(image, {
        maxByteLength: 32 * 1024 * 1024,
      });
      // Can read existing files
      expect(
        new TextDecoder().decode(readFile(restored, "/original.txt")),
      ).toBe("data");
      // Can write new files
      writeFile(restored, "/new.txt", new TextEncoder().encode("new data"));
      expect(new TextDecoder().decode(readFile(restored, "/new.txt"))).toBe(
        "new data",
      );
    });

    it("without maxByteLength creates a non-growable SAB", async () => {
      const mfs = createMemfs();
      const image = await mfs.saveImage();
      const restored = MemoryFileSystem.fromImage(image);
      const buf = restored.sharedBuffer;
      // Non-growable SABs have maxByteLength === byteLength
      expect(buf.maxByteLength).toBe(buf.byteLength);
    });
  });

  describe("rebaseToNewFileSystem", () => {
    it("grows the initial buffer to fit metadata for a 2 GiB image", () => {
      const source = createMemfs();
      writeFile(source, "/data.txt", new TextEncoder().encode("base"));

      const maxBytes = 2 * 1024 * 1024 * 1024;
      const rebased = source.rebaseToNewFileSystem(maxBytes);
      const stats = rebased.statfs("/");

      expect(rebased.sharedBuffer.byteLength).toBeGreaterThan(16 * 1024 * 1024);
      expect(rebased.sharedBuffer.maxByteLength).toBe(maxBytes);
      expect(stats.blocks * stats.bsize).toBe(maxBytes);
      expect(new TextDecoder().decode(readFile(rebased, "/data.txt"))).toBe(
        "base",
      );
    });

    it("raises the filesystem max beyond the source image superblock cap", async () => {
      const initialBytes = 1 * 1024 * 1024;
      const imageMaxBytes = 2 * 1024 * 1024;
      const rebaseMaxBytes = 8 * 1024 * 1024;
      const sab = new SharedArrayBuffer(initialBytes, {
        maxByteLength: imageMaxBytes,
      });
      const mfs = MemoryFileSystem.create(sab, imageMaxBytes);
      writeFile(mfs, "/data.txt", new TextEncoder().encode("base"));
      const image = await mfs.saveImage();

      const restored = MemoryFileSystem.fromImage(image, {
        maxByteLength: rebaseMaxBytes,
      });
      expect(restored.statfs("/").blocks * restored.statfs("/").bsize).toBe(
        imageMaxBytes,
      );

      const rebased = restored.rebaseToNewFileSystem(rebaseMaxBytes);
      const stats = rebased.statfs("/");
      expect(rebased.sharedBuffer.maxByteLength).toBe(rebaseMaxBytes);
      expect(stats.blocks * stats.bsize).toBe(rebaseMaxBytes);
      expect(new TextDecoder().decode(readFile(rebased, "/data.txt"))).toBe(
        "base",
      );

      const rebasedImage = await rebased.saveImage();
      const rerestored = MemoryFileSystem.fromImage(rebasedImage, {
        maxByteLength: rebaseMaxBytes,
      });
      const rerestoredStats = rerestored.statfs("/");
      expect(rerestoredStats.blocks * rerestoredStats.bsize).toBe(
        rebaseMaxBytes,
      );
    });

    it("preserves lazy file metadata without materializing stubs", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/real.txt", new TextEncoder().encode("real"));
      mfs.registerLazyFile(
        "/bin/lazy-tool",
        "http://example.com/tool.wasm",
        5_000_000,
        0o755,
      );

      const rebased = mfs.rebaseToNewFileSystem(16 * 1024 * 1024);

      expect(new TextDecoder().decode(readFile(rebased, "/real.txt"))).toBe(
        "real",
      );
      expect(rebased.stat("/bin/lazy-tool").size).toBe(5_000_000);
      expect(rebased.stat("/bin/lazy-tool").mode & 0o777).toBe(0o755);
      expect(rebased.exportLazyEntries()).toMatchObject([
        {
          path: "/bin/lazy-tool",
          url: "http://example.com/tool.wasm",
          size: 5_000_000,
        },
      ]);

      const fd = rebased.open("/bin/lazy-tool", O_RDONLY, 0);
      const buf = new Uint8Array(16);
      expect(rebased.read(fd, buf, null, buf.length)).toBe(0);
      rebased.close(fd);
    });
  });

  describe("isolation", () => {
    it("restored filesystem is independent from original", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/test.txt", new TextEncoder().encode("original"));

      const image = await mfs.saveImage();
      const restored = MemoryFileSystem.fromImage(image);

      // Modify original
      writeFile(mfs, "/test.txt", new TextEncoder().encode("modified"));

      // Restored should still have original content
      expect(new TextDecoder().decode(readFile(restored, "/test.txt"))).toBe(
        "original",
      );
    });

    it("modifications to restored filesystem don't affect original", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/test.txt", new TextEncoder().encode("original"));

      const image = await mfs.saveImage();
      const restored = MemoryFileSystem.fromImage(image);

      // Modify restored
      writeFile(restored, "/test.txt", new TextEncoder().encode("changed"));
      writeFile(restored, "/new.txt", new TextEncoder().encode("new"));

      // Original should be untouched
      expect(new TextDecoder().decode(readFile(mfs, "/test.txt"))).toBe(
        "original",
      );
      expect(() => mfs.stat("/new.txt")).toThrow();
    });

    it("can create multiple independent restores from the same image", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/data.txt", new TextEncoder().encode("shared"));

      const image = await mfs.saveImage();
      const r1 = MemoryFileSystem.fromImage(image);
      const r2 = MemoryFileSystem.fromImage(image);

      writeFile(r1, "/data.txt", new TextEncoder().encode("r1"));
      writeFile(r2, "/data.txt", new TextEncoder().encode("r2"));

      expect(new TextDecoder().decode(readFile(r1, "/data.txt"))).toBe("r1");
      expect(new TextDecoder().decode(readFile(r2, "/data.txt"))).toBe("r2");
      expect(new TextDecoder().decode(readFile(mfs, "/data.txt"))).toBe(
        "shared",
      );
    });
  });
});
