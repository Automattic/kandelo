import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zipSync } from "fflate";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { parseZipCentralDirectory } from "../src/vfs/zip";
import type { ZipEntry } from "../src/vfs/zip";

const O_RDONLY = 0x0000;

function createMemfs(): MemoryFileSystem {
  const sab = new SharedArrayBuffer(4 * 1024 * 1024);
  return MemoryFileSystem.create(sab);
}

function makeFakeEntries(): ZipEntry[] {
  return [
    {
      fileName: "usr/bin/vim",
      compressedSize: 100,
      uncompressedSize: 500000,
      compressionMethod: 8,
      localHeaderOffset: 0,
      mode: 0o755,
      isDirectory: false,
      isSymlink: false,
      externalAttrs: 0,
      creatorOS: 3,
    },
    {
      fileName: "usr/share/vim/syntax/c.vim",
      compressedSize: 50,
      uncompressedSize: 2048,
      compressionMethod: 8,
      localHeaderOffset: 200,
      mode: 0o644,
      isDirectory: false,
      isSymlink: false,
      externalAttrs: 0,
      creatorOS: 3,
    },
    {
      fileName: "usr/share/vim/README",
      compressedSize: 0,
      uncompressedSize: 0,
      compressionMethod: 0,
      localHeaderOffset: 400,
      mode: 0o644,
      isDirectory: false,
      isSymlink: false,
      externalAttrs: 0,
      creatorOS: 3,
    },
  ];
}

function makeRealZip() {
  const zipBytes = zipSync({
    "bin/hello": new TextEncoder().encode("#!/bin/sh\necho hello"),
    "share/data.txt": new TextEncoder().encode("hello world"),
    "share/empty.txt": new Uint8Array(0),
  });
  return { zipBytes, entries: parseZipCentralDirectory(zipBytes) };
}

// --- Task 3: Registration ---

describe("Lazy archive group registration", () => {
  it("registerLazyArchiveFromEntries creates stubs for all files", () => {
    const mfs = createMemfs();
    const entries = makeFakeEntries();
    const group = mfs.registerLazyArchiveFromEntries(
      "http://example.com/vim.zip",
      entries,
      "/",
    );

    // All 3 files should exist as stubs
    expect(() => mfs.stat("/usr/bin/vim")).not.toThrow();
    expect(() => mfs.stat("/usr/share/vim/syntax/c.vim")).not.toThrow();
    expect(() => mfs.stat("/usr/share/vim/README")).not.toThrow();

    // Group should have 3 entries
    expect(group.entries.size).toBe(3);
    expect(group.materialized).toBe(false);
  });

  it("stat returns declared size for unmaterialized archive files", () => {
    const mfs = createMemfs();
    const entries = makeFakeEntries();
    mfs.registerLazyArchiveFromEntries(
      "http://example.com/vim.zip",
      entries,
      "/",
    );

    expect(mfs.stat("/usr/bin/vim").size).toBe(500000);
    expect(mfs.stat("/usr/share/vim/syntax/c.vim").size).toBe(2048);
  });

  it("fstat and lstat return declared size", () => {
    const mfs = createMemfs();
    const entries = makeFakeEntries();
    mfs.registerLazyArchiveFromEntries(
      "http://example.com/vim.zip",
      entries,
      "/",
    );

    // fstat
    const fd = mfs.open("/usr/bin/vim", O_RDONLY, 0);
    expect(mfs.fstat(fd).size).toBe(500000);
    mfs.close(fd);

    // lstat
    expect(mfs.lstat("/usr/bin/vim").size).toBe(500000);
  });

  it("creates parent directories automatically", () => {
    const mfs = createMemfs();
    const entries = makeFakeEntries();
    mfs.registerLazyArchiveFromEntries(
      "http://example.com/vim.zip",
      entries,
      "/",
    );

    // Deep parent directory should exist
    const dir = mfs.stat("/usr/share/vim/syntax");
    expect(dir.mode & 0o170000).toBe(0o040000); // S_IFDIR
  });

  it("respects mount prefix", () => {
    const mfs = createMemfs();
    const entries: ZipEntry[] = [
      {
        fileName: "bin/tool",
        compressedSize: 10,
        uncompressedSize: 1000,
        compressionMethod: 0,
        localHeaderOffset: 0,
        mode: 0o755,
        isDirectory: false,
        isSymlink: false,
        externalAttrs: 0,
        creatorOS: 3,
      },
    ];

    mfs.registerLazyArchiveFromEntries(
      "http://example.com/pkg.zip",
      entries,
      "/opt/myapp",
    );

    expect(mfs.stat("/opt/myapp/bin/tool").size).toBe(1000);
    expect(() => mfs.stat("/bin/tool")).toThrow();
  });

  it("handles symlink entries with known targets", () => {
    const mfs = createMemfs();
    const entries: ZipEntry[] = [
      {
        fileName: "usr/bin/vi",
        compressedSize: 0,
        uncompressedSize: 3,
        compressionMethod: 0,
        localHeaderOffset: 0,
        mode: 0o120755,
        isDirectory: false,
        isSymlink: true,
        externalAttrs: 0,
        creatorOS: 3,
      },
      {
        fileName: "usr/bin/vim",
        compressedSize: 10,
        uncompressedSize: 5000,
        compressionMethod: 0,
        localHeaderOffset: 100,
        mode: 0o755,
        isDirectory: false,
        isSymlink: false,
        externalAttrs: 0,
        creatorOS: 3,
      },
    ];

    const symlinkTargets = new Map<string, string>();
    symlinkTargets.set("usr/bin/vi", "vim");

    const group = mfs.registerLazyArchiveFromEntries(
      "http://example.com/vim.zip",
      entries,
      "/",
      symlinkTargets,
    );

    // Symlink should exist and point to "vim"
    expect(mfs.readlink("/usr/bin/vi")).toBe("vim");

    // Regular file should exist
    expect(mfs.stat("/usr/bin/vim").size).toBe(5000);

    // Symlink entry should be recorded
    const symlinkEntry = group.entries.get("/usr/bin/vi");
    expect(symlinkEntry).toBeDefined();
    expect(symlinkEntry!.isSymlink).toBe(true);
  });

  it("handles empty files in archive (size 0)", () => {
    const mfs = createMemfs();
    const entries = makeFakeEntries();
    mfs.registerLazyArchiveFromEntries(
      "http://example.com/vim.zip",
      entries,
      "/",
    );

    // The README has size 0
    expect(mfs.stat("/usr/share/vim/README").size).toBe(0);
  });

  it("skips directory entries", () => {
    const mfs = createMemfs();
    const entries: ZipEntry[] = [
      {
        fileName: "usr/bin/",
        compressedSize: 0,
        uncompressedSize: 0,
        compressionMethod: 0,
        localHeaderOffset: 0,
        mode: 0o755,
        isDirectory: true,
        isSymlink: false,
        externalAttrs: 0,
        creatorOS: 3,
      },
      {
        fileName: "usr/bin/tool",
        compressedSize: 10,
        uncompressedSize: 1000,
        compressionMethod: 0,
        localHeaderOffset: 100,
        mode: 0o755,
        isDirectory: false,
        isSymlink: false,
        externalAttrs: 0,
        creatorOS: 3,
      },
    ];

    const group = mfs.registerLazyArchiveFromEntries(
      "http://example.com/pkg.zip",
      entries,
      "/",
    );

    // Only the file should be in the group, not the directory
    expect(group.entries.size).toBe(1);
    expect(group.entries.has("/usr/bin/tool")).toBe(true);
  });
});

// --- Task 4: Materialization ---

describe("Lazy archive materialization", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("ensureArchiveMaterialized writes all file contents", async () => {
    const mfs = createMemfs();
    const { zipBytes, entries } = makeRealZip();

    const group = mfs.registerLazyArchiveFromEntries(
      "http://example.com/test.zip",
      entries,
      "/opt",
    );

    // Mock fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    await mfs.ensureArchiveMaterialized(group);

    // Read back file contents
    const fd = mfs.open("/opt/bin/hello", O_RDONLY, 0);
    const buf = new Uint8Array(64);
    const n = mfs.read(fd, buf, null, 64);
    mfs.close(fd);
    const content = new TextDecoder().decode(buf.subarray(0, n));
    expect(content).toBe("#!/bin/sh\necho hello");

    // Check data.txt
    const fd2 = mfs.open("/opt/share/data.txt", O_RDONLY, 0);
    const buf2 = new Uint8Array(64);
    const n2 = mfs.read(fd2, buf2, null, 64);
    mfs.close(fd2);
    expect(new TextDecoder().decode(buf2.subarray(0, n2))).toBe("hello world");
  });

  it("ensureMaterialized triggers archive materialization for any file in the group", async () => {
    const mfs = createMemfs();
    const { zipBytes, entries } = makeRealZip();

    mfs.registerLazyArchiveFromEntries(
      "http://example.com/test.zip",
      entries,
      "/opt",
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    // Materialize by accessing any single file
    const result = await mfs.ensureMaterialized("/opt/share/data.txt");
    expect(result).toBe(true);

    // The other files should also be materialized
    const fd = mfs.open("/opt/bin/hello", O_RDONLY, 0);
    const buf = new Uint8Array(64);
    const n = mfs.read(fd, buf, null, 64);
    mfs.close(fd);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe(
      "#!/bin/sh\necho hello",
    );
  });

  it("all files materialized when any one is accessed", async () => {
    const mfs = createMemfs();
    const { zipBytes, entries } = makeRealZip();

    mfs.registerLazyArchiveFromEntries(
      "http://example.com/test.zip",
      entries,
      "/opt",
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    await mfs.ensureMaterialized("/opt/bin/hello");

    // All files should now have real content, no more lazy entries
    const result = await mfs.ensureMaterialized("/opt/share/data.txt");
    expect(result).toBe(false); // already materialized, nothing to do
  });

  it("double materialization is a no-op (fetch called only once)", async () => {
    const mfs = createMemfs();
    const { zipBytes, entries } = makeRealZip();

    const group = mfs.registerLazyArchiveFromEntries(
      "http://example.com/test.zip",
      entries,
      "/opt",
    );

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);
    globalThis.fetch = fetchMock;

    await mfs.ensureArchiveMaterialized(group);
    await mfs.ensureArchiveMaterialized(group);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves mode changes made to stubs before materialization", async () => {
    const mfs = createMemfs();
    const { zipBytes, entries } = makeRealZip();

    mfs.registerLazyArchiveFromEntries(
      "http://example.com/test.zip",
      entries,
      "/opt",
    );

    // Change mode on a stub before materializing
    mfs.chmod("/opt/bin/hello", 0o700);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    await mfs.ensureMaterialized("/opt/bin/hello");

    // Mode should be preserved (O_WRONLY|O_TRUNC preserves mode)
    const st = mfs.stat("/opt/bin/hello");
    expect(st.mode & 0o777).toBe(0o700);
  });
});

// --- Task 5: Unlink tracking ---

describe("Lazy archive unlink tracking", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("unlink marks archive entry as deleted", () => {
    const mfs = createMemfs();
    const entries = makeFakeEntries();
    const group = mfs.registerLazyArchiveFromEntries(
      "http://example.com/vim.zip",
      entries,
      "/",
    );

    mfs.unlink("/usr/bin/vim");

    const entry = group.entries.get("/usr/bin/vim");
    expect(entry).toBeDefined();
    expect(entry!.deleted).toBe(true);
  });

  it("deleted entries are skipped during materialization", async () => {
    const mfs = createMemfs();
    const { zipBytes, entries } = makeRealZip();

    mfs.registerLazyArchiveFromEntries(
      "http://example.com/test.zip",
      entries,
      "/opt",
    );

    // Delete a file before materializing
    mfs.unlink("/opt/bin/hello");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    // Materialize via another file
    await mfs.ensureMaterialized("/opt/share/data.txt");

    // The deleted file should NOT be restored
    expect(() => mfs.stat("/opt/bin/hello")).toThrow();

    // Other files should be materialized
    const fd = mfs.open("/opt/share/data.txt", O_RDONLY, 0);
    const buf = new Uint8Array(64);
    const n = mfs.read(fd, buf, null, 64);
    mfs.close(fd);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("hello world");
  });

  it("unlink of non-archive file does not affect archive groups", () => {
    const mfs = createMemfs();
    const entries = makeFakeEntries();
    const group = mfs.registerLazyArchiveFromEntries(
      "http://example.com/vim.zip",
      entries,
      "/",
    );

    // Create a separate file and unlink it
    mfs.mkdir("/tmp", 0o755);
    const fd = mfs.open("/tmp/other.txt", 0o1101, 0o644);
    mfs.close(fd);
    mfs.unlink("/tmp/other.txt");

    // Archive entries should all still be non-deleted
    for (const [, entry] of group.entries) {
      expect(entry.deleted).toBe(false);
    }
  });
});

// --- Task 6: Export/import ---

describe("Lazy archive export/import", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("exports and imports archive group metadata", () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs1 = MemoryFileSystem.create(sab);
    const entries = makeFakeEntries();
    mfs1.registerLazyArchiveFromEntries(
      "http://example.com/vim.zip",
      entries,
      "/",
    );

    // Export from instance 1
    const serialized = mfs1.exportLazyArchiveEntries();
    expect(serialized).toHaveLength(1);
    expect(serialized[0].url).toBe("http://example.com/vim.zip");
    expect(serialized[0].mountPrefix).toBe("/");
    expect(serialized[0].materialized).toBe(false);
    expect(serialized[0].entries).toHaveLength(3);

    // Import into instance 2 on the same SAB
    const mfs2 = MemoryFileSystem.fromExisting(sab);
    mfs2.importLazyArchiveEntries(serialized);

    // stat on instance 2 should return declared sizes
    expect(mfs2.stat("/usr/bin/vim").size).toBe(500000);
    expect(mfs2.stat("/usr/share/vim/syntax/c.vim").size).toBe(2048);
    expect(mfs2.stat("/usr/share/vim/README").size).toBe(0);
  });

  it("import of materialized group does not populate lazyArchiveInodes", async () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs1 = MemoryFileSystem.create(sab);
    const { zipBytes, entries } = makeRealZip();

    mfs1.registerLazyArchiveFromEntries(
      "http://example.com/test.zip",
      entries,
      "/opt",
    );

    // Materialize via mock fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    await mfs1.ensureMaterialized("/opt/bin/hello");

    // Export from instance 1 — group should be materialized
    const serialized = mfs1.exportLazyArchiveEntries();
    expect(serialized).toHaveLength(1);
    expect(serialized[0].materialized).toBe(true);

    // Import into instance 2 on the same SAB
    const mfs2 = MemoryFileSystem.fromExisting(sab);
    mfs2.importLazyArchiveEntries(serialized);

    // stat should return real file sizes (not lazy overrides)
    // "#!/bin/sh\necho hello" = 20 bytes
    expect(mfs2.stat("/opt/bin/hello").size).toBe(20);
    // "hello world" = 11 bytes
    expect(mfs2.stat("/opt/share/data.txt").size).toBe(11);
  });
});
