import { describe, it, expect, vi } from "vitest";
import { MemoryFileSystem, type LazyDownloadEvent } from "../src/vfs/memory-fs";

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;

function createMemfs(): MemoryFileSystem {
  const sab = new SharedArrayBuffer(4 * 1024 * 1024);
  return MemoryFileSystem.create(sab);
}

describe("Lazy VFS files", () => {
  it("registerLazyFile creates empty stub and returns inode", () => {
    const mfs = createMemfs();
    const ino = mfs.registerLazyFile("/bin/test", "http://example.com/test.wasm", 1024, 0o755);
    expect(ino).toBeGreaterThan(0);
  });

  it("stat returns declared size for unmaterialized lazy file", () => {
    const mfs = createMemfs();
    const declaredSize = 98765;
    mfs.registerLazyFile("/bin/test", "http://example.com/test.wasm", declaredSize, 0o755);

    const st = mfs.stat("/bin/test");
    expect(st.size).toBe(declaredSize);
    expect(st.mode & 0o777).toBe(0o755);
  });

  it("fstat returns declared size for unmaterialized lazy file", () => {
    const mfs = createMemfs();
    const declaredSize = 54321;
    mfs.registerLazyFile("/bin/test", "http://example.com/test.wasm", declaredSize);

    const fd = mfs.open("/bin/test", O_RDONLY, 0);
    const st = mfs.fstat(fd);
    expect(st.size).toBe(declaredSize);
    mfs.close(fd);
  });

  it("lstat returns declared size for unmaterialized lazy file", () => {
    const mfs = createMemfs();
    const declaredSize = 11111;
    mfs.registerLazyFile("/bin/test", "http://example.com/test.wasm", declaredSize);

    const st = mfs.lstat("/bin/test");
    expect(st.size).toBe(declaredSize);
  });

  it("creates parent directories automatically", () => {
    const mfs = createMemfs();
    mfs.registerLazyFile("/usr/local/bin/tool", "http://example.com/tool.wasm", 100);

    // Should be able to stat the file and parent dirs
    const st = mfs.stat("/usr/local/bin/tool");
    expect(st.size).toBe(100);

    const dir = mfs.stat("/usr/local/bin");
    expect(dir.mode & 0o170000).toBe(0o040000); // S_IFDIR
  });

  it("exportLazyEntries returns all registered lazy files", () => {
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/a", "http://example.com/a.wasm", 100);
    mfs.registerLazyFile("/bin/b", "http://example.com/b.wasm", 200);

    const entries = mfs.exportLazyEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.path).sort()).toEqual(["/bin/a", "/bin/b"]);
    expect(entries.find(e => e.path === "/bin/a")!.size).toBe(100);
    expect(entries.find(e => e.path === "/bin/b")!.size).toBe(200);
  });

  it("getLazyEntry returns lazy metadata and follows symlinks", () => {
    const mfs = createMemfs();
    mfs.registerLazyFile("/usr/bin/tool", "programs/tool.wasm", 100);
    mfs.mkdir("/bin", 0o755);
    mfs.symlink("/usr/bin/tool", "/bin/tool");

    expect(mfs.getLazyEntry("/bin/tool")).toMatchObject({
      path: "/usr/bin/tool",
      url: "programs/tool.wasm",
      size: 100,
    });
  });

  it("rewriteLazyFileUrls updates lazy metadata without changing size", () => {
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/tool", "kandelo-lazy:programs/tool.wasm", 1234);

    mfs.rewriteLazyFileUrls((url, path) => {
      expect(path).toBe("/bin/tool");
      return url.replace("kandelo-lazy:", "/assets/");
    });

    const [entry] = mfs.exportLazyEntries();
    expect(entry.url).toBe("/assets/programs/tool.wasm");
    expect(entry.size).toBe(1234);
    expect(mfs.stat("/bin/tool").size).toBe(1234);
  });

  it("importLazyEntries restores lazy metadata on another instance", () => {
    // Create first instance and register lazy files
    const sab = new SharedArrayBuffer(4 * 1024 * 1024);
    const mfs1 = MemoryFileSystem.create(sab);
    mfs1.registerLazyFile("/bin/tool", "http://example.com/tool.wasm", 5000);

    const entries = mfs1.exportLazyEntries();

    // Mount a second instance on the same SAB
    const mfs2 = MemoryFileSystem.fromExisting(sab);
    mfs2.importLazyEntries(entries);

    // Second instance should see the declared size
    const st = mfs2.stat("/bin/tool");
    expect(st.size).toBe(5000);
  });

  it("rejects invalid declared sizes before registering or importing lazy files", () => {
    const mfs = createMemfs();
    for (const size of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => mfs.registerLazyFile("/bin/tool", "/tool.wasm", size)).toThrow(
        /non-negative safe-integer size/,
      );
    }
    expect(() =>
      mfs.registerLazyFile("/bin/huge", "/huge.wasm", Number.MAX_SAFE_INTEGER)
    ).toThrow(/lazy content limit/);

    const source = createMemfs();
    source.registerLazyFile("/bin/tool", "/tool.wasm", 4);
    const [entry] = source.exportLazyEntries();
    const imported = MemoryFileSystem.fromExisting(source.sharedBuffer);
    expect(() => imported.importLazyEntries([{ ...entry, size: -1 }])).toThrow(
      /non-negative safe-integer size/,
    );
    expect(imported.exportLazyEntries()).toEqual([]);
  });

  it("rejects lazy imports whose inode does not own the declared path", () => {
    const source = createMemfs();
    source.registerLazyFile("/bin/a", "/a.wasm", 1);
    source.registerLazyFile("/bin/b", "/b.wasm", 1);
    const entries = source.exportLazyEntries();
    const imported = MemoryFileSystem.fromExisting(source.sharedBuffer);

    expect(() => imported.importLazyEntries([{ ...entries[0], ino: entries[1].ino }])).toThrow(
      /inode mismatch/,
    );
    expect(imported.exportLazyEntries()).toEqual([]);
  });

  it("rejects non-file, non-empty, aliased, and colliding lazy imports transactionally", () => {
    const source = createMemfs();
    source.registerLazyFile("/bin/tool", "/tool.wasm", 4);
    const [entry] = source.exportLazyEntries();
    source.mkdir("/dir", 0o755);
    source.symlink("/bin/tool", "/alias");

    const imported = MemoryFileSystem.fromExisting(source.sharedBuffer);
    expect(() => imported.importLazyEntries([{
      ...entry,
      path: "/alias",
    }])).toThrow(/inode mismatch|regular file/);
    expect(() => imported.importLazyEntries([{
      ...entry,
      path: "/dir",
      ino: source.lstat("/dir").ino,
    }])).toThrow(/regular file/);

    const fd = source.open("/bin/tool", O_WRONLY, 0);
    source.write(fd, new Uint8Array([1]), null, 1);
    source.close(fd);
    expect(() => imported.importLazyEntries([entry])).toThrow(/empty stub/);
    expect(imported.exportLazyEntries()).toEqual([]);

    const clean = createMemfs();
    clean.registerLazyFile("/bin/tool", "/tool.wasm", 4);
    const cleanEntries = clean.exportLazyEntries();
    const second = MemoryFileSystem.fromExisting(clean.sharedBuffer);
    second.importLazyEntries(cleanEntries);
    expect(() => second.importLazyEntries(cleanEntries)).toThrow(/duplicates/);
    expect(second.exportLazyEntries()).toEqual(cleanEntries);
  });

  it("O_TRUNC through a symlink replaces a lazy stub with a concrete file", async () => {
    const mfs = createMemfs();
    mfs.registerLazyFile("/usr/bin/test", "http://example.com/test.wasm", 99999);
    mfs.mkdir("/bin", 0o755);
    mfs.symlink("/usr/bin/test", "/bin/test");

    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const fd = mfs.open("/bin/test", O_WRONLY | O_CREAT | O_TRUNC, 0o755);
    mfs.write(fd, data, null, data.length);
    mfs.close(fd);

    expect(mfs.getLazyEntry("/bin/test")).toBeNull();
    expect(mfs.exportLazyEntries()).toEqual([]);
    expect(mfs.stat("/usr/bin/test").size).toBe(data.length);

    const restored = MemoryFileSystem.fromImage(await mfs.saveImage());
    expect(restored.exportLazyEntries()).toEqual([]);
    const fd2 = restored.open("/bin/test", O_RDONLY, 0);
    const buf = new Uint8Array(16);
    const n = restored.read(fd2, buf, null, 16);
    expect(n).toBe(5);
    expect(buf.subarray(0, n)).toEqual(data);
    restored.close(fd2);
  });

  it("ftruncate to zero replaces a lazy stub with a concrete file", () => {
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/test", "http://example.com/test.wasm", 99999);

    const fd = mfs.open("/bin/test", O_WRONLY, 0);
    mfs.ftruncate(fd, 0);
    mfs.close(fd);

    expect(mfs.getLazyEntry("/bin/test")).toBeNull();
    expect(mfs.exportLazyEntries()).toEqual([]);
    expect(mfs.stat("/bin/test").size).toBe(0);
  });

  it("multiple lazy files with different sizes", () => {
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/small", "http://example.com/small.wasm", 100);
    mfs.registerLazyFile("/bin/large", "http://example.com/large.wasm", 10_000_000);

    expect(mfs.stat("/bin/small").size).toBe(100);
    expect(mfs.stat("/bin/large").size).toBe(10_000_000);
  });

  it("emits lazy download progress while materializing a file", async () => {
    const originalFetch = globalThis.fetch;
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/test", "http://example.com/test.wasm", 5, 0o755);
    const events: LazyDownloadEvent[] = [];
    const off = mfs.subscribeLazyDownloads((event) => events.push(event));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "5" }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4, 5]));
          controller.close();
        },
      }),
    } as unknown as Response);

    try {
      await expect(mfs.ensureMaterialized("/bin/test")).resolves.toBe(true);
    } finally {
      off();
      globalThis.fetch = originalFetch;
    }

    expect(events.map((event) => event.status)).toEqual([
      "started",
      "progress",
      "progress",
      "complete",
    ]);
    expect(events[0].id.startsWith("file:")).toBe(true);
    expect(events[0]).toMatchObject({
      kind: "file",
      url: "http://example.com/test.wasm",
      path: "/bin/test",
      loadedBytes: 0,
      totalBytes: 5,
    });
    expect(events[2].loadedBytes).toBe(5);
    expect(events[3]).toMatchObject({ loadedBytes: 5, totalBytes: 5 });
  });

  it("rejects a successful response whose bytes do not match the lazy declaration", async () => {
    const originalFetch = globalThis.fetch;
    const mfs = createMemfs();
    mfs.registerLazyFile("/usr/bin/tool", "/binaries/tool.wasm", 1024, 0o755);
    const events: LazyDownloadEvent[] = [];
    const off = mfs.subscribeLazyDownloads((event) => events.push(event));

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("<!doctype html><title>Vite fallback</title>", {
        status: 200,
        headers: { "content-type": "text/html", "content-length": "43" },
      }),
    );

    try {
      await expect(mfs.ensureMaterialized("/usr/bin/tool")).rejects.toThrow(
        "lazy file size mismatch for /usr/bin/tool: expected 1024 bytes, received 43",
      );
    } finally {
      off();
      globalThis.fetch = originalFetch;
    }

    expect(events.map((event) => event.status)).toEqual([
      "started",
      "progress",
      "error",
    ]);
    expect(events.at(-1)).toMatchObject({
      loadedBytes: 43,
      totalBytes: 1024,
      error: "lazy file size mismatch for /usr/bin/tool: expected 1024 bytes, received 43",
    });
    expect(mfs.getLazyEntry("/usr/bin/tool")).toMatchObject({ size: 1024 });
    const fd = mfs.open("/usr/bin/tool", O_RDONLY, 0);
    const bytes = new Uint8Array(8);
    expect(mfs.read(fd, bytes, null, bytes.byteLength)).toBe(0);
    mfs.close(fd);
  });

  it("cancels a lazy response as soon as it exceeds the declared size", async () => {
    const originalFetch = globalThis.fetch;
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/tool", "/binaries/tool.wasm", 3, 0o755);
    const cancel = vi.fn();
    const events: LazyDownloadEvent[] = [];
    const off = mfs.subscribeLazyDownloads((event) => events.push(event));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "4" }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 1]));
          controller.enqueue(new Uint8Array([2, 3]));
        },
        cancel,
      }),
    } as unknown as Response);

    try {
      await expect(mfs.ensureMaterialized("/bin/tool")).rejects.toThrow(
        "lazy file size mismatch for /bin/tool: expected 3 bytes, received 4",
      );
    } finally {
      off();
      globalThis.fetch = originalFetch;
    }

    expect(cancel).toHaveBeenCalledOnce();
    expect(events.map((event) => event.status)).toEqual([
      "started",
      "progress",
      "progress",
      "error",
    ]);
    expect(events.at(-1)).toMatchObject({ loadedBytes: 4, totalBytes: 3 });
    expect(mfs.getLazyEntry("/bin/tool")).toMatchObject({ size: 3 });
  });

  it("uses decoded body bytes instead of Content-Length for integrity", async () => {
    const originalFetch = globalThis.fetch;
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/tool", "/binaries/tool.wasm", 5, 0o755);
    const events: LazyDownloadEvent[] = [];
    const off = mfs.subscribeLazyDownloads((event) => events.push(event));

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-encoding": "gzip", "content-length": "2" }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 1, 2, 3, 4]));
          controller.close();
        },
      }),
    } as unknown as Response);

    try {
      await expect(mfs.ensureMaterialized("/bin/tool")).resolves.toBe(true);
    } finally {
      off();
      globalThis.fetch = originalFetch;
    }

    expect(events.at(-1)).toMatchObject({
      status: "complete",
      loadedBytes: 5,
      totalBytes: 5,
    });
    expect(mfs.getLazyEntry("/bin/tool")).toBeNull();
  });

  it("checks body-less responses against the declared size", async () => {
    const originalFetch = globalThis.fetch;
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/tool", "/binaries/tool.wasm", 4, 0o755);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "2" }),
      body: null,
      arrayBuffer: async () => new Uint8Array([0, 1]).buffer,
    } as unknown as Response);

    try {
      await expect(mfs.ensureMaterialized("/bin/tool")).rejects.toThrow(
        "lazy file size mismatch for /bin/tool: expected 4 bytes, received 2",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(mfs.getLazyEntry("/bin/tool")).toMatchObject({ size: 4 });
  });

  it("can retry the same lazy stub after an integrity failure", async () => {
    const originalFetch = globalThis.fetch;
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/tool", "/binaries/tool.wasm", 4, 0o755);
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([0, 1])))
      .mockResolvedValueOnce(new Response(new Uint8Array([0, 1, 2, 3])));

    try {
      await expect(mfs.ensureMaterialized("/bin/tool")).rejects.toThrow(
        "expected 4 bytes, received 2",
      );
      expect(mfs.getLazyEntry("/bin/tool")).toMatchObject({ size: 4 });
      await expect(mfs.ensureMaterialized("/bin/tool")).resolves.toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(mfs.getLazyEntry("/bin/tool")).toBeNull();
    const fd = mfs.open("/bin/tool", O_RDONLY, 0);
    const bytes = new Uint8Array(4);
    expect(mfs.read(fd, bytes, null, bytes.byteLength)).toBe(4);
    mfs.close(fd);
    expect([...bytes]).toEqual([0, 1, 2, 3]);
  });

  it("deduplicates concurrent materialization of the same lazy inode", async () => {
    const originalFetch = globalThis.fetch;
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/tool", "/binaries/tool.wasm", 4, 0o755);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0, 1, 2, 3])),
    );
    globalThis.fetch = fetchMock;

    try {
      await expect(Promise.all([
        mfs.ensureMaterialized("/bin/tool"),
        mfs.ensureMaterialized("/bin/tool"),
      ])).resolves.toEqual([true, true]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mfs.getLazyEntry("/bin/tool")).toBeNull();
    const fd = mfs.open("/bin/tool", O_RDONLY, 0);
    const bytes = new Uint8Array(4);
    expect(mfs.read(fd, bytes, null, bytes.byteLength)).toBe(4);
    mfs.close(fd);
    expect([...bytes]).toEqual([0, 1, 2, 3]);
  });

  it("retains an empty lazy stub when exact bytes cannot fit in the VFS", async () => {
    const originalFetch = globalThis.fetch;
    const mfs = MemoryFileSystem.create(new SharedArrayBuffer(64 * 1024));
    const expectedBytes = 128 * 1024;
    mfs.registerLazyFile("/tool", "/tool.wasm", expectedBytes, 0o755);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": String(expectedBytes) }),
      body: null,
      arrayBuffer: async () => new Uint8Array(expectedBytes).buffer,
    } as unknown as Response);

    try {
      await expect(mfs.ensureMaterialized("/tool")).rejects.toThrow(
        /could not be stored completely/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(mfs.getLazyEntry("/tool")).toMatchObject({ size: expectedBytes });
    expect(mfs.stat("/tool").size).toBe(expectedBytes);
    const fd = mfs.open("/tool", O_RDONLY, 0);
    const bytes = new Uint8Array(16);
    expect(mfs.read(fd, bytes, null, bytes.byteLength)).toBe(0);
    mfs.close(fd);
  });
});
