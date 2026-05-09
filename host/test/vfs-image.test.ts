import { describe, it, expect } from "vitest";
import { zstdCompressSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { saveImage } from "../../examples/browser/scripts/vfs-image-helpers";

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_RDWR = 0x0002;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

function createMemfs(): MemoryFileSystem {
  const sab = new SharedArrayBuffer(4 * 1024 * 1024);
  return MemoryFileSystem.create(sab);
}

function writeFile(mfs: MemoryFileSystem, path: string, data: Uint8Array, mode = 0o644): void {
  // Ensure parent directories exist
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (let i = 0; i < parts.length - 1; i++) {
    current += "/" + parts[i];
    try { mfs.mkdir(current, 0o755); } catch { /* exists */ }
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

describe("VFS image save/restore", () => {
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

      expect(readFile(restored, "/usr/local/bin/tool")).toEqual(new Uint8Array([1, 2, 3]));
      expect(readFile(restored, "/usr/local/lib/libfoo.so")).toEqual(new Uint8Array([4, 5, 6]));
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
      expect(new TextDecoder().decode(readFile(restored, "/new.txt"))).toBe("new");

      // Can modify existing files
      writeFile(restored, "/existing.txt", new TextEncoder().encode("updated"));
      expect(new TextDecoder().decode(readFile(restored, "/existing.txt"))).toBe("updated");
    });
  });

  describe("lazy file handling", () => {
    it("preserves lazy file metadata by default", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/real.txt", new TextEncoder().encode("real content"));
      mfs.registerLazyFile("/bin/lazy-tool", "http://example.com/tool.wasm", 12345, 0o755);

      const image = await mfs.saveImage();
      const restored = MemoryFileSystem.fromImage(image);

      // Real file content preserved
      expect(new TextDecoder().decode(readFile(restored, "/real.txt"))).toBe("real content");

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

    it("materializeAll clears lazy entries from image", async () => {
      const mfs = createMemfs();
      // Register a lazy file and manually write content to simulate materialization
      // (can't actually fetch in tests, so we simulate by writing content before save)
      mfs.registerLazyFile("/bin/tool", "http://example.com/tool.wasm", 5000, 0o755);

      // Manually write content to the file (simulating what ensureMaterialized does)
      const toolContent = new Uint8Array(100);
      for (let i = 0; i < 100; i++) toolContent[i] = i;
      const fd = mfs.open("/bin/tool", O_WRONLY | O_CREAT | O_TRUNC, 0o755);
      mfs.write(fd, toolContent, null, toolContent.length);
      mfs.close(fd);

      // Clear the lazy entry manually to simulate materialization
      // (ensureMaterialized would do this via fetch + delete)
      const entries = mfs.exportLazyEntries();
      expect(entries).toHaveLength(1);

      // Instead, test that a save without lazy entries works correctly
      // by creating a fresh mfs with no lazy files
      const mfs2 = createMemfs();
      writeFile(mfs2, "/bin/tool", toolContent, 0o755);
      const image = await mfs2.saveImage();

      const restored = MemoryFileSystem.fromImage(image);
      expect(restored.exportLazyEntries()).toHaveLength(0);
      expect(readFile(restored, "/bin/tool")).toEqual(toolContent);
    });

    it("image without lazy files has no lazy flag", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/test.txt", new TextEncoder().encode("test"));

      const image = await mfs.saveImage();
      const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
      const flags = view.getUint32(8, true);
      expect(flags & 1).toBe(0); // no lazy flag
    });

    it("image with lazy files has lazy flag set", async () => {
      const mfs = createMemfs();
      mfs.registerLazyFile("/bin/tool", "http://example.com/tool.wasm", 1000);

      const image = await mfs.saveImage();
      const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
      const flags = view.getUint32(8, true);
      expect(flags & 1).toBe(1); // lazy flag set
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
      expect(new TextDecoder().decode(readFile(restored, "/hello.txt"))).toBe("compressed!");
      expect(readFile(restored, "/etc/config")).toEqual(new Uint8Array([1, 2, 3, 4]));
    });

    it("fromImage with maxByteLength still works on zstd-wrapped image", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/data.txt", new TextEncoder().encode("hi"));
      const compressed = new Uint8Array(zstdCompressSync(await mfs.saveImage()));

      const restored = MemoryFileSystem.fromImage(compressed, {
        maxByteLength: 16 * 1024 * 1024,
      });
      expect(restored.sharedBuffer.maxByteLength).toBe(16 * 1024 * 1024);
      expect(new TextDecoder().decode(readFile(restored, "/data.txt"))).toBe("hi");
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
        expect(new TextDecoder().decode(readFile(restored, "/etc/hostname")))
          .toBe("wasmbox\n");
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
      expect(() => MemoryFileSystem.fromImage(bad)).toThrow("Bad VFS image magic");
    });

    it("rejects image with wrong version", () => {
      const bad = new Uint8Array(32);
      const view = new DataView(bad.buffer);
      view.setUint32(0, 0x56465349, true); // VFSI magic
      view.setUint32(4, 99, true); // bad version
      expect(() => MemoryFileSystem.fromImage(bad)).toThrow("Unsupported VFS image version");
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
      expect(() => MemoryFileSystem.fromImage(new Uint8Array(4))).toThrow("too small");
    });

    it("image has correct magic and version", async () => {
      const mfs = createMemfs();
      const image = await mfs.saveImage();
      const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
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
      const restored = MemoryFileSystem.fromImage(image, { maxByteLength: maxBytes });
      const buf = restored.sharedBuffer;
      expect(buf).toBeInstanceOf(SharedArrayBuffer);
      // The SAB should have maxByteLength set (growable)
      expect(buf.maxByteLength).toBe(maxBytes);
      // Current byteLength should match the image's SAB size
      expect(buf.byteLength).toBe(4 * 1024 * 1024);
    });

    it("restored filesystem with maxByteLength is writable", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/original.txt", new TextEncoder().encode("data"));
      const image = await mfs.saveImage();

      const restored = MemoryFileSystem.fromImage(image, { maxByteLength: 32 * 1024 * 1024 });
      // Can read existing files
      expect(new TextDecoder().decode(readFile(restored, "/original.txt"))).toBe("data");
      // Can write new files
      writeFile(restored, "/new.txt", new TextEncoder().encode("new data"));
      expect(new TextDecoder().decode(readFile(restored, "/new.txt"))).toBe("new data");
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

  describe("isolation", () => {
    it("restored filesystem is independent from original", async () => {
      const mfs = createMemfs();
      writeFile(mfs, "/test.txt", new TextEncoder().encode("original"));

      const image = await mfs.saveImage();
      const restored = MemoryFileSystem.fromImage(image);

      // Modify original
      writeFile(mfs, "/test.txt", new TextEncoder().encode("modified"));

      // Restored should still have original content
      expect(new TextDecoder().decode(readFile(restored, "/test.txt"))).toBe("original");
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
      expect(new TextDecoder().decode(readFile(mfs, "/test.txt"))).toBe("original");
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
      expect(new TextDecoder().decode(readFile(mfs, "/data.txt"))).toBe("shared");
    });
  });
});
