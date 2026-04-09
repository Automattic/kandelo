import { describe, it, expect } from "vitest";
import { DeviceFileSystem } from "../src/vfs/device-fs";

describe("DeviceFileSystem", () => {
  it("opens and closes /dev/null", () => {
    const fs = new DeviceFileSystem();
    const h = fs.open("/null", 0, 0);
    expect(h).toBeGreaterThan(0);
    expect(fs.close(h)).toBe(0);
  });

  it("/dev/null reads return 0 (EOF)", () => {
    const fs = new DeviceFileSystem();
    const h = fs.open("/null", 0, 0);
    const buf = new Uint8Array(64);
    expect(fs.read(h, buf, null, 64)).toBe(0);
    fs.close(h);
  });

  it("/dev/null writes succeed and report length", () => {
    const fs = new DeviceFileSystem();
    const h = fs.open("/null", 1, 0);
    const buf = new Uint8Array([1, 2, 3, 4]);
    expect(fs.write(h, buf, null, 4)).toBe(4);
    fs.close(h);
  });

  it("/dev/zero reads return zero bytes", () => {
    const fs = new DeviceFileSystem();
    const h = fs.open("/zero", 0, 0);
    const buf = new Uint8Array(32);
    buf.fill(0xff);
    const n = fs.read(h, buf, null, 32);
    expect(n).toBe(32);
    expect(buf.every((b) => b === 0)).toBe(true);
    fs.close(h);
  });

  it("/dev/urandom reads return non-zero bytes (probabilistic)", () => {
    const fs = new DeviceFileSystem();
    const h = fs.open("/urandom", 0, 0);
    const buf = new Uint8Array(256);
    const n = fs.read(h, buf, null, 256);
    expect(n).toBe(256);
    // With 256 bytes, probability of all zeros is ~0
    const nonZero = buf.some((b) => b !== 0);
    expect(nonZero).toBe(true);
    fs.close(h);
  });

  it("/dev/random reads same as urandom", () => {
    const fs = new DeviceFileSystem();
    const h = fs.open("/random", 0, 0);
    const buf = new Uint8Array(64);
    expect(fs.read(h, buf, null, 64)).toBe(64);
    fs.close(h);
  });

  it("stat on /dev/null returns character device", () => {
    const fs = new DeviceFileSystem();
    const st = fs.stat("/null");
    expect(st.mode & 0o170000).toBe(0o020000); // S_IFCHR
    expect(st.size).toBe(0);
  });

  it("stat on root returns directory", () => {
    const fs = new DeviceFileSystem();
    const st = fs.stat("/");
    expect(st.mode & 0o170000).toBe(0o040000); // S_IFDIR
  });

  it("throws ENOENT for unknown device", () => {
    const fs = new DeviceFileSystem();
    expect(() => fs.open("/nonexistent", 0, 0)).toThrow("ENOENT");
    expect(() => fs.stat("/nonexistent")).toThrow("ENOENT");
  });

  it("throws EBADF for invalid handle", () => {
    const fs = new DeviceFileSystem();
    expect(() => fs.read(999, new Uint8Array(1), null, 1)).toThrow("EBADF");
    expect(() => fs.close(999)).toThrow("EBADF");
  });

  it("readdir lists all device files", () => {
    const fs = new DeviceFileSystem();
    const dh = fs.opendir("/");
    const entries: { name: string; type: number }[] = [];
    let entry;
    while ((entry = fs.readdir(dh)) !== null) {
      entries.push({ name: entry.name, type: entry.type });
    }
    fs.closedir(dh);
    const names = entries.map(e => e.name);
    expect(names).toContain("null");
    expect(names).toContain("zero");
    expect(names).toContain("urandom");
    expect(names).toContain("random");
    // Kernel-managed entries
    expect(names).toContain("ptmx");
    expect(names).toContain("pts");
    expect(names).toContain("fd");
    expect(names).toContain("stdin");
    expect(names).toContain("stdout");
    expect(names).toContain("stderr");
    // Type checks: pts is a directory, fd/stdin/stdout/stderr are symlinks
    expect(entries.find(e => e.name === "pts")!.type).toBe(4); // DT_DIR
    expect(entries.find(e => e.name === "fd")!.type).toBe(10); // DT_LNK
  });

  it("open /dev root as directory succeeds", () => {
    const fs = new DeviceFileSystem();
    const h = fs.open("/", 0, 0);
    expect(h).toBeGreaterThan(0);
    const st = fs.fstat(h);
    expect(st.mode & 0o170000).toBe(0o040000); // S_IFDIR
    fs.close(h);
  });

  it("stat /dev/pts returns directory", () => {
    const fs = new DeviceFileSystem();
    const st = fs.stat("/pts");
    expect(st.mode & 0o170000).toBe(0o040000); // S_IFDIR
  });

  it("read/write on directory handle throws EISDIR", () => {
    const fs = new DeviceFileSystem();
    const h = fs.open("/", 0, 0);
    expect(() => fs.read(h, new Uint8Array(1), null, 1)).toThrow("EISDIR");
    expect(() => fs.write(h, new Uint8Array(1), null, 1)).toThrow("EISDIR");
    fs.close(h);
  });

  it("seek is a no-op on character devices", () => {
    const fs = new DeviceFileSystem();
    const h = fs.open("/null", 0, 0);
    expect(fs.seek(h, 100, 0)).toBe(0);
    fs.close(h);
  });

  it("works with VirtualPlatformIO mount", async () => {
    // Import dynamically to avoid circular issues
    const { VirtualPlatformIO } = await import("../src/vfs/vfs");
    const { MemoryFileSystem } = await import("../src/vfs/memory-fs");
    const { NodeTimeProvider } = await import("../src/vfs/time");

    const memfs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
    const devfs = new DeviceFileSystem();
    memfs.mkdir("/dev", 0o755);

    const io = new VirtualPlatformIO(
      [
        { mountPoint: "/dev", backend: devfs },
        { mountPoint: "/", backend: memfs },
      ],
      new NodeTimeProvider(),
    );

    // Write to /dev/null
    const h = io.open("/dev/null", 1, 0);
    expect(io.write(h, new Uint8Array([1, 2, 3]), null, 3)).toBe(3);
    io.close(h);

    // Read from /dev/zero
    const h2 = io.open("/dev/zero", 0, 0);
    const buf = new Uint8Array(16);
    buf.fill(0xff);
    expect(io.read(h2, buf, null, 16)).toBe(16);
    expect(buf[0]).toBe(0);
    io.close(h2);

    // Read from /dev/urandom
    const h3 = io.open("/dev/urandom", 0, 0);
    const rbuf = new Uint8Array(32);
    expect(io.read(h3, rbuf, null, 32)).toBe(32);
    io.close(h3);

    // Open /dev as directory (O_RDONLY|O_DIRECTORY) — the scenario that was broken
    const O_DIRECTORY = 0o200000;
    const dh = io.open("/dev", O_DIRECTORY, 0);
    const st = io.fstat(dh);
    expect(st.mode & 0o170000).toBe(0o040000); // S_IFDIR
    io.close(dh);

    // stat /dev returns directory
    const devStat = io.stat("/dev");
    expect(devStat.mode & 0o170000).toBe(0o040000);

    // stat /dev/pts returns directory
    const ptsStat = io.stat("/dev/pts");
    expect(ptsStat.mode & 0o170000).toBe(0o040000);

    // opendir/readdir through VFS
    const dirH = io.opendir("/dev");
    const entries: string[] = [];
    let ent;
    while ((ent = io.readdir(dirH)) !== null) {
      entries.push(ent.name);
    }
    io.closedir(dirH);
    expect(entries).toContain("null");
    expect(entries).toContain("ptmx");
    expect(entries).toContain("pts");
  });
});
