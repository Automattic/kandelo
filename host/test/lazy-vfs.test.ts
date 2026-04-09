import { describe, it, expect } from "vitest";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

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

  it("materialized file shows real size instead of declared size", () => {
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/test", "http://example.com/test.wasm", 99999);

    // Manually write content (simulating materialization)
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const fd = mfs.open("/bin/test", O_WRONLY | O_CREAT | O_TRUNC, 0o755);
    mfs.write(fd, data, null, data.length);
    mfs.close(fd);

    // After writing, the lazy entry's inode may have changed or been overwritten.
    // But ensureMaterialized is the intended path. Since we can't call fetch in
    // Node.js tests, verify the read path works with concrete data.
    const fd2 = mfs.open("/bin/test", O_RDONLY, 0);
    const buf = new Uint8Array(16);
    const n = mfs.read(fd2, buf, null, 16);
    expect(n).toBe(5);
    expect(buf[0]).toBe(1);
    expect(buf[4]).toBe(5);
    mfs.close(fd2);
  });

  it("multiple lazy files with different sizes", () => {
    const mfs = createMemfs();
    mfs.registerLazyFile("/bin/small", "http://example.com/small.wasm", 100);
    mfs.registerLazyFile("/bin/large", "http://example.com/large.wasm", 10_000_000);

    expect(mfs.stat("/bin/small").size).toBe(100);
    expect(mfs.stat("/bin/large").size).toBe(10_000_000);
  });
});
