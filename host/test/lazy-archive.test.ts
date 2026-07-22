import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { zipSync } from "fflate";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { parseZipCentralDirectory } from "../src/vfs/zip";
import type { ZipEntry } from "../src/vfs/zip";

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_TRUNC = 0x0200;

function createMemfs(): MemoryFileSystem {
  const sab = new SharedArrayBuffer(4 * 1024 * 1024);
  return MemoryFileSystem.create(sab);
}

function makeFakeEntries(): ZipEntry[] {
  return [
    {
      fileName: "usr/bin/vim",
      fileNameBytes: new TextEncoder().encode("usr/bin/vim"),
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
      fileNameBytes: new TextEncoder().encode("usr/share/vim/syntax/c.vim"),
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
      fileNameBytes: new TextEncoder().encode("usr/share/vim/README"),
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

function makeTwoMemberZip() {
  const zipBytes = zipSync({
    "a.txt": new TextEncoder().encode("alpha"),
    "b.txt": new TextEncoder().encode("bravo"),
  });
  return { zipBytes, entries: parseZipCentralDirectory(zipBytes) };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", copy),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function asUntaggedLegacyArchiveImage(image: Uint8Array): Uint8Array {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const sabLength = view.getUint32(12, true);
  const lazyOffset = 16 + sabLength;
  const lazyLength = view.getUint32(lazyOffset, true);
  const archiveOffset = lazyOffset + 4 + lazyLength;
  const archiveLength = view.getUint32(archiveOffset, true);
  const archiveEnd = archiveOffset + 4 + archiveLength;
  const groups = JSON.parse(new TextDecoder().decode(
    image.subarray(archiveOffset + 4, archiveEnd),
  )) as Array<Record<string, any>>;
  for (const group of groups) {
    delete group.kind;
  }
  const archiveJson = new TextEncoder().encode(JSON.stringify(groups));
  const legacy = new Uint8Array(
    archiveOffset + 4 + archiveJson.byteLength + image.byteLength - archiveEnd,
  );
  legacy.set(image.subarray(0, archiveOffset), 0);
  const legacyView = new DataView(legacy.buffer);
  legacyView.setUint32(8, view.getUint32(8, true) & ~(1 << 3), true);
  legacyView.setUint32(archiveOffset, archiveJson.byteLength, true);
  legacy.set(archiveJson, archiveOffset + 4);
  legacy.set(image.subarray(archiveEnd), archiveOffset + 4 + archiveJson.byteLength);
  return legacy;
}

function readText(mfs: MemoryFileSystem, path: string): string {
  const fd = mfs.open(path, O_RDONLY, 0);
  const buffer = new Uint8Array(64);
  const read = mfs.read(fd, buffer, null, buffer.length);
  mfs.close(fd);
  return new TextDecoder().decode(buffer.subarray(0, read));
}

// --- Task 3: Registration ---

describe("Lazy archive group registration", () => {
  it("rejects malformed immutable archive identities before mutating the VFS", () => {
    for (const integrity of [
      { sha256: "A".repeat(64), bytes: 1 },
      { sha256: "0".repeat(64), bytes: 0 },
      { sha256: "0".repeat(64), bytes: 256 * 1024 * 1024 + 1 },
      { sha256: "0".repeat(64), bytes: 1, extra: true },
    ]) {
      const mfs = createMemfs();
      expect(() => mfs.registerLazyArchiveFromEntries(
        "https://example.com/test.zip",
        makeFakeEntries(),
        "/opt",
        undefined,
        integrity,
      )).toThrow(/Lazy archive integrity/);
      expect(() => mfs.stat("/opt")).toThrow();
      expect(mfs.exportLazyArchiveEntries()).toEqual([]);
    }
  });

  it("atomically replaces an existing file with archive backing", async () => {
    const originalFetch = globalThis.fetch;
    const mfs = createMemfs();
    const { zipBytes, entries } = makeRealZip();
    mfs.mkdir("/opt", 0o755);
    mfs.mkdir("/opt/bin", 0o755);
    mfs.createFileWithOwner("/opt/bin/hello", 0o644, 0, 0, new Uint8Array([9]));

    mfs.registerLazyArchiveFromEntries(
      "http://example.com/test.zip",
      entries,
      "/opt",
    );
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    try {
      await expect(mfs.ensureMaterialized("/opt/bin/hello")).resolves.toBe(
        true,
      );
      expect(readText(mfs, "/opt/bin/hello")).toBe("#!/bin/sh\necho hello");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not overwrite a peer write after replacing an archive path", async () => {
    const originalFetch = globalThis.fetch;
    const mfs = createMemfs();
    const peer = MemoryFileSystem.fromExisting(mfs.sharedBuffer);
    const { zipBytes, entries } = makeRealZip();
    mfs.mkdir("/opt", 0o755);
    mfs.mkdir("/opt/bin", 0o755);
    mfs.createFileWithOwner("/opt/bin/hello", 0o644, 0, 0, new Uint8Array([4]));

    const raw = (
      mfs as unknown as {
        fs: {
          createLazyStub: (
            path: string,
            mode: number,
          ) => { ino: number; generation: number; dataSequence: number };
        };
      }
    ).fs;
    const createLazyStub = raw.createLazyStub.bind(raw);
    const createSpy = vi
      .spyOn(raw, "createLazyStub")
      .mockImplementation((path, mode) => {
        const identity = createLazyStub(path, mode);
        if (path === "/opt/bin/hello") {
          const writer = peer.open(path, O_WRONLY, 0o644);
          peer.write(writer, new Uint8Array([9]), null, 1);
          peer.close(writer);
        }
        return identity;
      });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    try {
      mfs.registerLazyArchiveFromEntries(
        "http://example.com/test.zip",
        entries,
        "/opt",
      );
      await expect(mfs.ensureMaterialized("/opt/bin/hello")).resolves.toBe(
        true,
      );
      const fd = mfs.open("/opt/bin/hello", O_RDONLY, 0);
      const byte = new Uint8Array(1);
      expect(mfs.read(fd, byte, null, 1)).toBe(1);
      mfs.close(fd);
      expect(byte[0]).toBe(9);
    } finally {
      createSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it("replaces stale standalone backing when a path moves into an archive", async () => {
    const originalFetch = globalThis.fetch;
    const mfs = createMemfs();
    const zipBytes = zipSync({ item: new Uint8Array([7]) });
    mfs.registerLazyFile("/item", "http://example.com/old", 1);
    mfs.registerLazyArchiveFromEntries(
      "http://example.com/archive.zip",
      parseZipCentralDirectory(zipBytes),
      "/",
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);
    globalThis.fetch = fetchMock;

    try {
      await expect(mfs.ensureMaterialized("/item")).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledWith("http://example.com/archive.zip");
      const fd = mfs.open("/item", O_RDONLY, 0);
      const byte = new Uint8Array(1);
      expect(mfs.read(fd, byte, null, 1)).toBe(1);
      mfs.close(fd);
      expect(byte[0]).toBe(7);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("replaces stale archive backing when a member becomes standalone", async () => {
    const originalFetch = globalThis.fetch;
    const mfs = createMemfs();
    const zipBytes = zipSync({ item: new Uint8Array([7]) });
    mfs.registerLazyArchiveFromEntries(
      "http://example.com/archive.zip",
      parseZipCentralDirectory(zipBytes),
      "/",
    );
    mfs.registerLazyFile("/item", "http://example.com/standalone", 1);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "1" }),
      body: null,
      arrayBuffer: () => Promise.resolve(new Uint8Array([8]).buffer),
    } as unknown as Response);
    globalThis.fetch = fetchMock;

    try {
      expect(mfs.exportLazyArchiveEntries()).toEqual([]);
      await expect(mfs.ensureMaterialized("/item")).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledWith("http://example.com/standalone");
      const fd = mfs.open("/item", O_RDONLY, 0);
      const byte = new Uint8Array(1);
      expect(mfs.read(fd, byte, null, 1)).toBe(1);
      mfs.close(fd);
      expect(byte[0]).toBe(8);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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
    const peer = MemoryFileSystem.fromExisting(mfs.sharedBuffer);
    const entries = makeFakeEntries();
    mfs.registerLazyArchiveFromEntries(
      "http://example.com/vim.zip",
      entries,
      "/",
    );

    // fstat
    const fd = peer.open("/usr/bin/vim", O_RDONLY, 0);
    expect(mfs.fstat(fd).size).toBe(500000);
    peer.close(fd);

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
        fileNameBytes: new TextEncoder().encode("bin/tool"),
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

  it("rejects regular-file traversal before mutating the VFS", () => {
    const mfs = createMemfs();
    const template = makeFakeEntries()[0];
    const entries: ZipEntry[] = [
      {
        ...template,
        fileName: "safe/first.txt",
        fileNameBytes: new TextEncoder().encode("safe/first.txt"),
      },
      {
        ...template,
        fileName: "../escaped.txt",
        fileNameBytes: new TextEncoder().encode("../escaped.txt"),
      },
    ];

    expect(() =>
      mfs.registerLazyArchiveFromEntries(
        "http://example.com/traversal.zip",
        entries,
        "/sandbox",
      ),
    ).toThrow(/member "\.\.\/escaped\.txt" is not a canonical relative POSIX path/);
    expect(() => mfs.stat("/sandbox")).toThrow();
    expect(() => mfs.stat("/escaped.txt")).toThrow();
    expect(mfs.exportLazyArchiveEntries()).toEqual([]);
  });

  it("rejects symlink traversal before mutating the VFS", () => {
    const mfs = createMemfs();
    const template = makeFakeEntries()[0];
    const entries: ZipEntry[] = [
      {
        ...template,
        fileName: "safe/first.txt",
        fileNameBytes: new TextEncoder().encode("safe/first.txt"),
      },
      {
        ...template,
        fileName: "../escaped-link",
        fileNameBytes: new TextEncoder().encode("../escaped-link"),
        mode: 0o120777,
        isSymlink: true,
      },
    ];
    const symlinkTargets = new Map([["../escaped-link", "target"]]);

    expect(() =>
      mfs.registerLazyArchiveFromEntries(
        "http://example.com/symlink-traversal.zip",
        entries,
        "/sandbox",
        symlinkTargets,
      ),
    ).toThrow(/member "\.\.\/escaped-link" is not a canonical relative POSIX path/);
    expect(() => mfs.stat("/sandbox")).toThrow();
    expect(() => mfs.lstat("/escaped-link")).toThrow();
    expect(mfs.exportLazyArchiveEntries()).toEqual([]);
  });

  it.each([
    {
      label: "an absolute member",
      names: ["/absolute.txt"],
      error: /must be relative, not absolute/,
    },
    {
      label: "a backslash member",
      names: ["bad\\name.txt"],
      error: /contains a backslash/,
    },
    {
      label: "an empty path component",
      names: ["bad//name.txt"],
      error: /not a canonical relative POSIX path/,
    },
    {
      label: "duplicate members",
      names: ["duplicate.txt", "duplicate.txt"],
      error: /collides with another member/,
    },
    {
      label: "a file used as an ancestor",
      names: ["parent", "parent/child.txt"],
      error: /descends through non-directory "parent"/,
    },
  ])("rejects $label before mutating the VFS", ({ names, error }) => {
    const mfs = createMemfs();
    const template = makeFakeEntries()[0];
    const entries = names.map(
      (fileName): ZipEntry => ({
        ...template,
        fileName,
        fileNameBytes: new TextEncoder().encode(fileName),
      }),
    );

    expect(() =>
      mfs.registerLazyArchiveFromEntries(
        "http://example.com/invalid.zip",
        entries,
        "/sandbox",
      ),
    ).toThrow(error);
    expect(() => mfs.stat("/sandbox")).toThrow();
    expect(mfs.exportLazyArchiveEntries()).toEqual([]);
  });

  it("handles symlink entries with known targets", () => {
    const mfs = createMemfs();
    const entries: ZipEntry[] = [
      {
        fileName: "usr/bin/vi",
        fileNameBytes: new TextEncoder().encode("usr/bin/vi"),
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
        fileNameBytes: new TextEncoder().encode("usr/bin/vim"),
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
        fileNameBytes: new TextEncoder().encode("usr/bin/"),
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
        fileNameBytes: new TextEncoder().encode("usr/bin/tool"),
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

  it("materializes an archive only when its immutable identity matches", async () => {
    const mfs = createMemfs();
    const { zipBytes, entries } = makeRealZip();
    mfs.registerLazyArchiveFromEntries(
      "https://example.com/test.zip",
      entries,
      "/opt",
      undefined,
      { sha256: await sha256(zipBytes), bytes: zipBytes.byteLength },
    );
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": String(zipBytes.byteLength) }),
      body: null,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    await expect(mfs.ensureMaterialized("/opt/bin/hello")).resolves.toBe(true);
    expect(readText(mfs, "/opt/bin/hello")).toBe("#!/bin/sh\necho hello");
  });

  it("rejects an archive whose byte count differs from its identity", async () => {
    const mfs = createMemfs();
    const { zipBytes, entries } = makeRealZip();
    mfs.registerLazyArchiveFromEntries(
      "https://example.com/test.zip",
      entries,
      "/opt",
      undefined,
      { sha256: await sha256(zipBytes), bytes: zipBytes.byteLength + 1 },
    );
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": String(zipBytes.byteLength) }),
      body: null,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    await expect(mfs.ensureMaterialized("/opt/bin/hello")).rejects.toThrow(
      /byte count .* does not match expected/,
    );
    expect(mfs.stat("/opt/bin/hello").size).toBe(20);
  });

  it("rejects an archive whose SHA-256 differs from its identity", async () => {
    const mfs = createMemfs();
    const { zipBytes, entries } = makeRealZip();
    mfs.registerLazyArchiveFromEntries(
      "https://example.com/test.zip",
      entries,
      "/opt",
      undefined,
      { sha256: "0".repeat(64), bytes: zipBytes.byteLength },
    );
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": String(zipBytes.byteLength) }),
      body: null,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    await expect(mfs.ensureMaterialized("/opt/bin/hello")).rejects.toThrow(
      /SHA-256 .* does not match expected/,
    );
    expect(mfs.stat("/opt/bin/hello").size).toBe(20);
  });

  it("rejects archive members that differ from their registered metadata", async () => {
    const mfs = createMemfs();
    const { zipBytes, entries } = makeRealZip();
    const declared = entries.map((entry, index) =>
      index === 0
        ? { ...entry, uncompressedSize: entry.uncompressedSize + 1 }
        : entry
    );
    mfs.registerLazyArchiveFromEntries(
      "https://example.com/test.zip",
      declared,
      "/opt",
      undefined,
      { sha256: await sha256(zipBytes), bytes: zipBytes.byteLength },
    );
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": String(zipBytes.byteLength) }),
      body: null,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    await expect(mfs.ensureMaterialized("/opt/bin/hello")).rejects.toThrow(
      /does not match its registered metadata/,
    );
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

  it("keeps a peer-renamed member lazy when another archive member materializes", async () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const owner = MemoryFileSystem.create(sab);
    const peer = MemoryFileSystem.fromExisting(sab);
    const { zipBytes, entries } = makeTwoMemberZip();

    owner.registerLazyArchiveFromEntries(
      "http://example.com/two-members.zip",
      entries,
      "/pkg",
    );
    peer.rename("/pkg/b.txt", "/pkg/moved-b.txt");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    await expect(owner.ensureMaterialized("/pkg/a.txt")).resolves.toBe(true);
    expect(readText(owner, "/pkg/a.txt")).toBe("alpha");

    // Archive commit is group-atomic: resolving a.txt commits the renamed
    // sibling in the same transaction instead of exposing a partial layer.
    await expect(owner.ensureMaterialized("/pkg/moved-b.txt")).resolves.toBe(
      false,
    );
    expect(readText(owner, "/pkg/moved-b.txt")).toBe("bravo");
  });

  it("finishes a requested archive member renamed during its fetch", async () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const owner = MemoryFileSystem.create(sab);
    const peer = MemoryFileSystem.fromExisting(sab);
    const { zipBytes, entries } = makeTwoMemberZip();
    owner.registerLazyArchiveFromEntries(
      "http://example.com/two-members.zip",
      entries,
      "/pkg",
    );
    let release!: (value: ArrayBuffer) => void;
    const body = new Promise<ArrayBuffer>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => body,
    } as unknown as Response);

    const pending = owner.ensureMaterialized("/pkg/a.txt");
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    peer.rename("/pkg/a.txt", "/pkg/moved-a.txt");
    release(zipBytes.buffer);

    await expect(pending).resolves.toBe(true);
    expect(readText(owner, "/pkg/moved-a.txt")).toBe("alpha");
  });

  it("materializes pending archives into a self-contained image", async () => {
    const mfs = createMemfs();
    const { zipBytes, entries } = makeRealZip();
    mfs.registerLazyArchiveFromEntries(
      "http://example.com/test.zip",
      entries,
      "/opt",
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);
    globalThis.fetch = fetchMock;

    const restored = MemoryFileSystem.fromImage(
      await mfs.saveImage({ materializeAll: true }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(restored.exportLazyArchiveEntries()).toEqual([]);
    expect(readText(restored, "/opt/bin/hello")).toBe("#!/bin/sh\necho hello");
    expect(readText(restored, "/opt/share/data.txt")).toBe("hello world");
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

  it("retains a peer-created hard-link alias after unlink", async () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const owner = MemoryFileSystem.create(sab);
    const peer = MemoryFileSystem.fromExisting(sab);
    const { zipBytes, entries } = makeRealZip();
    owner.registerLazyArchiveFromEntries(
      "http://example.com/test.zip",
      entries,
      "/opt",
    );
    peer.link("/opt/bin/hello", "/archive-alias");

    owner.unlink("/opt/bin/hello");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    await expect(owner.ensureMaterialized("/archive-alias")).resolves.toBe(
      true,
    );
    expect(readText(owner, "/archive-alias")).toBe("#!/bin/sh\necho hello");
  });

  it("retains a peer-created archive alias when rename replaces its other name", async () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const owner = MemoryFileSystem.create(sab);
    const peer = MemoryFileSystem.fromExisting(sab);
    const { zipBytes, entries } = makeRealZip();
    owner.registerLazyArchiveFromEntries(
      "http://example.com/test.zip",
      entries,
      "/opt",
    );
    peer.link("/opt/bin/hello", "/archive-alias");
    owner.createFileWithOwner("/source", 0o644, 0, 0, new Uint8Array([4]));

    owner.rename("/source", "/opt/bin/hello");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    await expect(owner.ensureMaterialized("/archive-alias")).resolves.toBe(
      true,
    );
    expect(readText(owner, "/archive-alias")).toBe("#!/bin/sh\necho hello");
    const destination = owner.open("/opt/bin/hello", O_RDONLY, 0);
    const destinationByte = new Uint8Array(1);
    expect(owner.read(destination, destinationByte, null, 1)).toBe(1);
    owner.close(destination);
    expect(destinationByte[0]).toBe(4);
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
    expect(serialized[0].kind).toBe("kandelo-legacy-zip-v1");
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

  it("preserves immutable archive integrity through image serialization", async () => {
    const mfs = createMemfs();
    const { zipBytes, entries } = makeRealZip();
    const integrity = {
      sha256: await sha256(zipBytes),
      bytes: zipBytes.byteLength,
    };
    mfs.registerLazyArchiveFromEntries(
      "https://example.com/test.zip",
      entries,
      "/opt",
      undefined,
      integrity,
    );

    expect(mfs.exportLazyArchiveEntries()[0]).toMatchObject({
      kind: "kandelo-legacy-zip-v1",
      integrity,
    });
    const image = await mfs.saveImage();
    const restored = MemoryFileSystem.fromImage(image);
    expect(restored.exportLazyArchiveEntries()[0].integrity).toEqual(integrity);
    const restoredLegacy = MemoryFileSystem.fromImage(
      asUntaggedLegacyArchiveImage(image),
    );
    expect(restoredLegacy.exportLazyArchiveEntries()[0]).toMatchObject({
      kind: "kandelo-legacy-zip-v1",
      integrity,
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": String(zipBytes.byteLength) }),
      body: null,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);
    await expect(restoredLegacy.ensureMaterialized("/opt/bin/hello"))
      .resolves.toBe(true);
    expect(readText(restoredLegacy, "/opt/bin/hello"))
      .toBe("#!/bin/sh\necho hello");
  });

  it("retains the original archive member name when importing legacy metadata", async () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const owner = MemoryFileSystem.create(sab);
    const { zipBytes, entries } = makeRealZip();
    owner.registerLazyArchiveFromEntries(
      "http://example.com/test.zip",
      entries,
      "/opt",
    );

    const serialized = owner.exportLazyArchiveEntries();
    for (const entry of serialized[0].entries) delete entry.archivePath;

    const restoredMetadata = MemoryFileSystem.fromExisting(sab);
    restoredMetadata.importLazyArchiveEntries(serialized);
    restoredMetadata.rename("/opt/bin/hello", "/opt/bin/moved");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(zipBytes.buffer),
    } as unknown as Response);

    await expect(
      restoredMetadata.ensureMaterialized("/opt/bin/moved"),
    ).resolves.toBe(true);
    expect(readText(restoredMetadata, "/opt/bin/moved")).toBe(
      "#!/bin/sh\necho hello",
    );
  });

  it("rejects sequence-less archive metadata after a live peer write", async () => {
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const owner = MemoryFileSystem.create(sab);
    const { entries } = makeRealZip();
    owner.registerLazyArchiveFromEntries(
      "http://example.com/test.zip",
      entries,
      "/opt",
    );
    const serialized = owner.exportLazyArchiveEntries();
    const hello = serialized[0].entries.find(
      (entry) => entry.vfsPath === "/opt/bin/hello",
    )!;
    delete hello.dataSequence;

    const writer = owner.open("/opt/bin/hello", O_WRONLY | O_TRUNC, 0o644);
    owner.write(writer, new Uint8Array([9]), null, 1);
    owner.close(writer);

    const peer = MemoryFileSystem.fromExisting(sab);
    expect(() => peer.importLazyArchiveEntries(serialized)).toThrow(
      /requires inode generation and data sequence/,
    );

    expect(peer.stat("/opt/bin/hello").size).toBe(1);
    await expect(peer.ensureMaterialized("/opt/bin/hello")).resolves.toBe(
      false,
    );
  });

  it("rebaseToNewFileSystem preserves unmaterialized archive metadata", () => {
    const mfs = createMemfs();
    const entries = makeFakeEntries();
    mfs.registerLazyArchiveFromEntries(
      "http://example.com/vim.zip",
      entries,
      "/",
    );

    const rebased = mfs.rebaseToNewFileSystem(8 * 1024 * 1024);

    expect(rebased.stat("/usr/bin/vim").size).toBe(500000);
    expect(rebased.stat("/usr/share/vim/syntax/c.vim").size).toBe(2048);
    const serialized = rebased.exportLazyArchiveEntries();
    expect(serialized).toHaveLength(1);
    expect(serialized[0]).toMatchObject({
      url: "http://example.com/vim.zip",
      mountPrefix: "/",
      materialized: false,
    });

  });

  it("omits fully materialized groups from deferred archive metadata", async () => {
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

    // Concrete files no longer need archive metadata in another instance.
    const serialized = mfs1.exportLazyArchiveEntries();
    expect(serialized).toEqual([]);

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
