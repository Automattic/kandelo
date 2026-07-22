import { describe, expect, it, vi } from "vitest";
import { Worker } from "node:worker_threads";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  FD_ENTRY_SIZE,
  FD_TABLE_OFFSET,
} from "../src/vfs/sharedfs-vendor";

const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_RDWR = 0x0002;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;
const SEEK_SET = 0;

function create(size = 4 * 1024 * 1024): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(size));
}

function listDir(fs: MemoryFileSystem, path: string): string[] {
  const dd = fs.opendir(path);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = fs.readdir(dd);
      if (!entry) return names;
      if (entry.name !== "." && entry.name !== "..") names.push(entry.name);
    }
  } finally {
    fs.closedir(dd);
  }
}

describe("SharedFS sparse-file safety", () => {
  it("rejects invalid seek results without changing the file offset", () => {
    const fs = create();
    const fd = fs.open("/seek", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    fs.write(fd, new TextEncoder().encode("abcdef"), null, 6);
    expect(fs.seek(fd, 2, SEEK_SET)).toBe(2);

    expect(() => fs.seek(fd, -1, SEEK_SET)).toThrow(/Invalid argument/);
    expect(() => fs.seek(fd, 2 ** 53, SEEK_SET)).toThrow(
      /Value too large for data type/,
    );
    expect(() => fs.seek(fd, Number.MAX_SAFE_INTEGER, 1)).toThrow(
      /Value too large for data type/,
    );
    expect(fs.seek(fd, 0, 1)).toBe(2);

    const byte = new Uint8Array(1);
    expect(fs.read(fd, byte, null, 1)).toBe(1);
    expect(byte[0]).toBe("c".charCodeAt(0));
    fs.close(fd);
  });

  it("extends a multi-gigabyte sparse file without scanning its holes", () => {
    const fs = create();
    const fd = fs.open("/sparse", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const sparseSize = 3_000_000_000;

    const started = performance.now();
    fs.ftruncate(fd, sparseSize);
    expect(performance.now() - started).toBeLessThan(500);
    expect(fs.fstat(fd).size).toBe(sparseSize);

    fs.seek(fd, sparseSize - 1, SEEK_SET);
    expect(fs.write(fd, new Uint8Array([0x7a]), null, 1)).toBe(1);
    const tail = new Uint8Array(4);
    expect(fs.read(fd, tail, sparseSize - 3, tail.length)).toBe(3);
    expect(Array.from(tail.subarray(0, 3))).toEqual([0, 0, 0x7a]);
    fs.close(fd);
  });

  it("rejects invalid and unrepresentable truncate lengths", () => {
    const fs = create();
    const fd = fs.open("/file", O_CREAT | O_RDWR, 0o644);
    expect(() => fs.ftruncate(fd, -1)).toThrow(/Invalid argument/);
    expect(() => fs.ftruncate(fd, Number.NaN)).toThrow(/Invalid argument/);
    expect(() => fs.ftruncate(fd, Number.MAX_SAFE_INTEGER)).toThrow(
      /File too large/,
    );
    expect(fs.fstat(fd).size).toBe(0);
    fs.close(fd);
  });

  it("commits size and data for a positive partial write at ENOSPC", () => {
    const fs = create(128 * 1024);
    const fd = fs.open("/partial", O_CREAT | O_RDWR | O_TRUNC, 0o644);
    const input = new Uint8Array(1024 * 1024).fill(0xa5);
    const written = fs.write(fd, input, null, input.length);

    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(input.length);
    expect(fs.fstat(fd).size).toBe(written);
    const tail = new Uint8Array(1);
    expect(fs.read(fd, tail, written - 1, 1)).toBe(1);
    expect(tail[0]).toBe(0xa5);
    fs.close(fd);
  });
});

describe("SharedFS namespace and image safety", () => {
  it("does not advance a directory cursor when constructing an entry fails", () => {
    const fs = create();
    const fd = fs.open("/retry-entry", O_CREAT | O_WRONLY, 0o644);
    fs.close(fd);
    const retryIno = fs.stat("/retry-entry").ino;
    const dd = fs.opendir("/");
    const shared = (
      fs as unknown as {
        fs: {
          buildStat: (ino: number) => unknown;
        };
      }
    ).fs;
    const originalBuildStat = shared.buildStat.bind(shared);

    try {
      expect(fs.readdir(dd)?.name).toBe(".");
      expect(fs.readdir(dd)?.name).toBe("..");
      const offsetAddress = FD_TABLE_OFFSET + dd * FD_ENTRY_SIZE + 8;
      const view = new DataView(fs.sharedBuffer);
      const offsetBeforeFailure = view.getBigUint64(offsetAddress, true);
      let failuresRemaining = 2;
      const buildStat = vi
        .spyOn(shared, "buildStat")
        .mockImplementation((ino: number) => {
          if (ino === retryIno && failuresRemaining-- > 0) {
            throw new Error("injected stat construction failure");
          }
          return originalBuildStat(ino);
        });

      expect(() => fs.readdir(dd)).toThrow("injected stat construction failure");
      expect(view.getBigUint64(offsetAddress, true)).toBe(offsetBeforeFailure);
      expect(() => fs.readdir(dd)).toThrow("injected stat construction failure");
      expect(view.getBigUint64(offsetAddress, true)).toBe(offsetBeforeFailure);

      buildStat.mockRestore();
      expect(fs.readdir(dd)?.name).toBe("retry-entry");
      expect(view.getBigUint64(offsetAddress, true)).toBeGreaterThan(
        offsetBeforeFailure,
      );
    } finally {
      vi.restoreAllMocks();
      fs.closedir(dd);
    }
  });

  it("hard-links a symlink inode without following its target", () => {
    const fs = create();
    const target = fs.open("/target", O_CREAT | O_WRONLY, 0o644);
    fs.close(target);
    fs.symlink("/target", "/symbolic");

    fs.link("/symbolic", "/alias");
    expect(fs.lstat("/alias").mode & 0xf000).toBe(0xa000);
    expect(fs.lstat("/alias").nlink).toBe(2);
    expect(fs.readlink("/alias")).toBe("/target");

    fs.unlink("/symbolic");
    expect(fs.lstat("/alias").mode & 0xf000).toBe(0xa000);
    expect(fs.lstat("/alias").nlink).toBe(1);
  });

  it("prevents path ABA across workers without deadlocking", async () => {
    const fs = create();
    const initial = fs.open("/slot", O_CREAT | O_WRONLY | O_TRUNC, 0o644);
    fs.write(initial, new Uint8Array([0x11]), null, 1);
    fs.close(initial);

    const controlBuffer = new SharedArrayBuffer(4);
    const control = new Int32Array(controlBuffer);
    const workerUrl = new URL(
      "./fixtures/sharedfs-namespace-worker.ts",
      import.meta.url,
    );
    const makeWorker = (role: "mutator" | "observer") =>
      new Worker(workerUrl, {
        execArgv: ["--import", "tsx"],
        workerData: {
          fsBuffer: fs.sharedBuffer,
          controlBuffer,
          role,
          iterations: 4_000,
        },
      });
    const workers = [makeWorker("mutator"), makeWorker("observer")];
    const results = workers.map(
      (worker) =>
        new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code !== 0) reject(new Error(`SharedFS worker exited ${code}`));
          });
        }),
    );

    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0, workers.length);
    try {
      const completed = Promise.all(results);
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("SharedFS worker watchdog expired")),
          8_000,
        );
      });
      const messages = await Promise.race([completed, timeout]);
      expect(messages).toEqual([{ ok: true }, { ok: true }]);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
    }
  }, 10_000);

  it("polls safely when browser-main-style Atomics.wait is unavailable", async () => {
    const fs = create();
    const worker = new Worker(
      new URL("./fixtures/sharedfs-lock-release-worker.mjs", import.meta.url),
      { workerData: fs.sharedBuffer },
    );
    await new Promise<void>((resolve, reject) => {
      worker.once("message", () => resolve());
      worker.once("error", reject);
    });

    const wait = vi.spyOn(Atomics, "wait").mockImplementation(() => {
      throw new TypeError("Atomics.wait cannot be called on this thread");
    });
    try {
      expect(fs.stat("/").mode & 0xf000).toBe(0x4000);
      expect(wait).toHaveBeenCalled();
    } finally {
      wait.mockRestore();
      await worker.terminate();
    }
  });

  it("leaves a full directory intact after repeated create and rename failures", () => {
    const fs = create(128 * 1024);
    const filler = fs.open("/filler", O_CREAT | O_WRONLY | O_TRUNC, 0o644);
    fs.write(filler, new Uint8Array(1024 * 1024), null, 1024 * 1024);
    fs.close(filler);

    const created: string[] = [];
    let failedName = "";
    for (let i = 0; i < 64; i++) {
      const name = `/${String(i).padStart(2, "0")}-${"x".repeat(180)}`;
      try {
        const fd = fs.open(name, O_CREAT | O_WRONLY, 0o644);
        fs.close(fd);
        created.push(name);
      } catch (error) {
        expect(String(error)).toMatch(/No space left/);
        failedName = name;
        break;
      }
    }

    expect(failedName).not.toBe("");
    const before = listDir(fs, "/").sort();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(() => fs.open(failedName, O_CREAT | O_WRONLY, 0o644)).toThrow(
        /No space left/,
      );
      expect(listDir(fs, "/").sort()).toEqual(before);
    }

    const source = created[0];
    const destination = `/${"r".repeat(220)}`;
    expect(() => fs.rename(source, destination)).toThrow(/No space left/);
    expect(fs.stat(source).mode & 0xf000).toBe(0x8000);
    expect(() => fs.stat(destination)).toThrow(/No such file/);
    expect(listDir(fs, "/").sort()).toEqual(before);
  });

  it("requires quiescent snapshots and clears legacy runtime state on restore", async () => {
    const fs = create();
    const fd = fs.open("/saved", O_CREAT | O_RDWR, 0o644);
    await expect(fs.saveImage()).rejects.toThrow(/open descriptors/);
    fs.close(fd);
    const orphanFd = fs.open("/orphan", O_CREAT | O_RDWR, 0o644);
    const orphanIno = fs.fstat(orphanFd).ino;
    fs.close(orphanFd);

    const image = await fs.saveImage();
    const imageView = new DataView(
      image.buffer,
      image.byteOffset,
      image.byteLength,
    );
    const sabOffset = 16;
    imageView.setUint32(sabOffset + 60, 1, true); // stale grow lock
    imageView.setUint32(sabOffset + 64, 1, true); // stale namespace lock
    imageView.setUint32(sabOffset + 256, 1, true); // stale fd 0

    const inodeTableBlock = imageView.getUint32(sabOffset + 36, true);
    const ino = fs.stat("/saved").ino;
    const inodeOffset = sabOffset + inodeTableBlock * 4096 + (ino % 32) * 128;
    imageView.setUint32(inodeOffset, 0x80000000, true); // stale inode lock
    imageView.setUint32(inodeOffset + 112, 1, true); // stale open ref

    const orphanOffset =
      sabOffset + inodeTableBlock * 4096 + (orphanIno % 32) * 128;
    imageView.setUint32(orphanOffset + 12, 0, true); // unlinked
    imageView.setUint32(orphanOffset + 112, 1, true); // but held open
    imageView.setUint32(sabOffset + 256 + 4, orphanIno, true);

    const rootOffset = sabOffset + inodeTableBlock * 4096 + 128;
    const rootBlock = imageView.getUint32(rootOffset + 48, true);
    const rootSize = Number(imageView.getBigUint64(rootOffset + 16, true));
    const decoder = new TextDecoder();
    for (let pos = 0; pos < rootSize;) {
      const entryOffset = sabOffset + rootBlock * 4096 + pos;
      const recLen = imageView.getUint16(entryOffset + 4, true);
      const nameLen = imageView.getUint16(entryOffset + 6, true);
      const name = decoder.decode(
        image.subarray(entryOffset + 8, entryOffset + 8 + nameLen),
      );
      if (name === "orphan") imageView.setUint32(entryOffset, 0, true);
      pos += recLen;
    }

    const restored = MemoryFileSystem.fromImage(image);
    expect(restored.stat("/saved").ino).toBe(ino);
    expect(() => restored.stat("/orphan")).toThrow(/No such file/);
    const replacement = restored.open(
      "/replacement",
      O_CREAT | O_WRONLY,
      0o644,
    );
    expect(restored.fstat(replacement).ino).toBe(orphanIno);
    restored.close(replacement);
    expect(() => restored.close(0)).toThrow(/Bad file descriptor/);
    await expect(restored.saveImage()).resolves.toBeInstanceOf(Uint8Array);
  });

  it("fails closed instead of removing a corrupt directory", () => {
    const fs = create();
    fs.mkdir("/empty", 0o755);
    const ino = fs.stat("/empty").ino;
    const view = new DataView(fs.sharedBuffer);
    const inodeTableBlock = view.getUint32(36, true);
    const inodeOffset = inodeTableBlock * 4096 + (ino % 32) * 128;
    const dataBlock = view.getUint32(inodeOffset + 48, true);
    const recLenOffset = dataBlock * 4096 + 4;
    const originalRecLen = view.getUint16(recLenOffset, true);

    view.setUint16(recLenOffset, 0, true);
    expect(() => fs.rmdir("/empty")).toThrow(/I\/O error/);
    expect(fs.stat("/empty").ino).toBe(ino);

    view.setUint16(recLenOffset, originalRecLen, true);
    fs.rmdir("/empty");
    expect(() => fs.stat("/empty")).toThrow(/No such file/);
  });

  it("rejects a directory entry that names a free inode slot", () => {
    const fs = create();
    const fd = fs.open("/victim", O_CREAT | O_WRONLY, 0o644);
    fs.close(fd);
    const view = new DataView(fs.sharedBuffer);
    const inodeTableBlock = view.getUint32(36, true);
    const rootOffset = inodeTableBlock * 4096 + 128;
    const rootBlock = view.getUint32(rootOffset + 48, true);
    const rootSize = Number(view.getBigUint64(rootOffset + 16, true));
    const decoder = new TextDecoder();
    let victimEntry = -1;
    for (let pos = 0; pos < rootSize;) {
      const abs = rootBlock * 4096 + pos;
      const recLen = view.getUint16(abs + 4, true);
      const nameLen = view.getUint16(abs + 6, true);
      const name = decoder.decode(
        new Uint8Array(fs.sharedBuffer, abs + 8, nameLen),
      );
      if (name === "victim") victimEntry = abs;
      pos += recLen;
    }
    expect(victimEntry).toBeGreaterThan(0);

    const freeInode = view.getUint32(16, true) - 1;
    view.setUint32(victimEntry, freeInode, true);
    const freeBefore = fs.statfs("/").ffree;
    expect(() => fs.stat("/victim")).toThrow(/I\/O error/);
    expect(() => fs.unlink("/victim")).toThrow(/I\/O error/);
    expect(fs.statfs("/").ffree).toBe(freeBefore);
  });
});

describe("MemoryFileSystem lazy inode identity", () => {
  it("atomically replaces an existing file with lazy backing", async () => {
    const originalFetch = globalThis.fetch;
    const fs = create();
    const existing = fs.open("/lazy", O_CREAT | O_WRONLY | O_TRUNC, 0o644);
    fs.write(existing, new Uint8Array([9]), null, 1);
    fs.close(existing);

    fs.registerLazyFile("/lazy", "https://example.test/lazy", 1);
    expect(fs.getLazyEntry("/lazy")).toMatchObject({ size: 1 });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "1" }),
      body: null,
      arrayBuffer: () => Promise.resolve(new Uint8Array([7]).buffer),
    } as unknown as Response);

    try {
      await expect(fs.ensureMaterialized("/lazy")).resolves.toBe(true);
      const fd = fs.open("/lazy", O_RDONLY, 0);
      const byte = new Uint8Array(1);
      expect(fs.read(fd, byte, null, 1)).toBe(1);
      fs.close(fd);
      expect(byte[0]).toBe(7);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not overwrite a peer write after replacing an existing lazy path", async () => {
    const originalFetch = globalThis.fetch;
    const fs = create();
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    const existing = fs.open("/lazy", O_CREAT | O_WRONLY | O_TRUNC, 0o644);
    fs.write(existing, new Uint8Array([4]), null, 1);
    fs.close(existing);

    const raw = (
      fs as unknown as {
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
        const writer = peer.open(path, O_WRONLY, 0o644);
        peer.write(writer, new Uint8Array([9]), null, 1);
        peer.close(writer);
        return identity;
      });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "1" }),
      body: null,
      arrayBuffer: () => Promise.resolve(new Uint8Array([7]).buffer),
    } as unknown as Response);

    try {
      fs.registerLazyFile("/lazy", "https://example.test/lazy", 1);
      expect(fs.getLazyEntry("/lazy")).toBeNull();
      await expect(fs.ensureMaterialized("/lazy")).resolves.toBe(false);
      const fd = fs.open("/lazy", O_RDONLY, 0);
      const byte = new Uint8Array(1);
      expect(fs.read(fd, byte, null, 1)).toBe(1);
      fs.close(fd);
      expect(byte[0]).toBe(9);
    } finally {
      createSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it("binds registration to the atomically-created stub identity", async () => {
    const originalFetch = globalThis.fetch;
    const fs = create();
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    type StubIdentity = ReturnType<(typeof fs)["registerLazyFile"]>;
    const raw = (
      fs as unknown as {
        fs: {
          createLazyStub: (
            path: string,
            mode: number,
          ) => {
            ino: StubIdentity;
            generation: number;
            dataSequence: number;
          };
        };
      }
    ).fs;
    const createLazyStub = raw.createLazyStub.bind(raw);
    const createSpy = vi
      .spyOn(raw, "createLazyStub")
      .mockImplementation((path, mode) => {
        const identity = createLazyStub(path, mode);
        peer.rename(path, "/moved");
        const replacement = peer.open(path, O_CREAT | O_WRONLY, 0o644);
        peer.write(replacement, new Uint8Array([9]), null, 1);
        peer.close(replacement);
        return identity;
      });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "1" }),
      body: null,
      arrayBuffer: () => Promise.resolve(new Uint8Array([7]).buffer),
    } as unknown as Response);

    try {
      fs.registerLazyFile("/lazy", "https://example.test/lazy", 1);
      expect(fs.getLazyEntry("/lazy")).toBeNull();
      expect(fs.getLazyEntry("/moved")).not.toBeNull();
      await expect(fs.ensureMaterialized("/moved")).resolves.toBe(true);
      const replacement = fs.open("/lazy", O_RDONLY, 0);
      const byte = new Uint8Array(1);
      expect(fs.read(replacement, byte, null, 1)).toBe(1);
      fs.close(replacement);
      expect(byte[0]).toBe(9);
    } finally {
      createSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects generation-less lazy metadata from a live peer", () => {
    const fs = create();
    fs.registerLazyFile("/lazy", "https://example.test/lazy", 999);
    const [legacy] = fs.exportLazyEntries();
    delete legacy.generation;
    delete legacy.dataSequence;
    fs.unlink("/lazy");
    const replacement = fs.open("/lazy", O_CREAT | O_WRONLY, 0o644);
    fs.close(replacement);

    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    expect(() => peer.importLazyEntries([legacy])).toThrow(
      /requires inode generation and data sequence/,
    );

    expect(peer.getLazyEntry("/lazy")).toBeNull();
    expect(peer.stat("/lazy").size).toBe(0);
  });

  it("rejects sequence-less lazy metadata after same-inode content changes", () => {
    const fs = create();
    fs.registerLazyFile("/lazy", "https://example.test/lazy", 999);
    const [legacy] = fs.exportLazyEntries();
    delete legacy.dataSequence;

    const writer = fs.open("/lazy", O_WRONLY | O_TRUNC, 0o644);
    fs.write(writer, new Uint8Array([9]), null, 1);
    fs.close(writer);

    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    expect(() => peer.importLazyEntries([legacy])).toThrow(
      /requires inode generation and data sequence/,
    );

    expect(peer.getLazyEntry("/lazy")).toBeNull();
    expect(peer.stat("/lazy").size).toBe(1);
  });

  it("does not apply lazy metadata after an inode slot is recycled", () => {
    const fs = create();
    const oldIno = fs.registerLazyFile(
      "/lazy",
      "https://example.test/lazy",
      999,
    );
    const exported = fs.exportLazyEntries();
    fs.unlink("/lazy");

    const fd = fs.open("/replacement", O_CREAT | O_WRONLY, 0o644);
    fs.close(fd);
    expect(fs.stat("/replacement").ino).toBe(oldIno);
    expect(fs.stat("/replacement").size).toBe(0);
    expect(fs.getLazyEntry("/replacement")).toBeNull();

    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    peer.importLazyEntries(exported);
    expect(peer.stat("/replacement").size).toBe(0);
    expect(peer.getLazyEntry("/replacement")).toBeNull();
  });

  it("tracks lazy files across rename and hard-link lifecycle", async () => {
    const originalFetch = globalThis.fetch;
    const fs = create();
    fs.registerLazyFile("/lazy", "https://example.test/lazy", 3);
    fs.rename("/lazy", "/renamed");
    fs.link("/renamed", "/alias");
    fs.unlink("/renamed");

    expect(fs.getLazyEntry("/alias")).toMatchObject({
      path: "/alias",
      size: 3,
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "3" }),
      body: null,
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
    } as unknown as Response);
    try {
      await expect(fs.ensureMaterialized("/alias")).resolves.toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fs.stat("/alias").size).toBe(3);
  });

  it("retains a peer-created hard-link alias after unlink", async () => {
    const originalFetch = globalThis.fetch;
    const fs = create();
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    fs.registerLazyFile("/lazy", "https://example.test/lazy", 1);
    peer.link("/lazy", "/alias");

    fs.unlink("/lazy");
    expect(fs.getLazyEntry("/alias")).toMatchObject({
      path: "/alias",
      paths: ["/alias"],
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "1" }),
      body: null,
      arrayBuffer: () => Promise.resolve(new Uint8Array([7]).buffer),
    } as unknown as Response);

    try {
      await expect(fs.ensureMaterialized("/alias")).resolves.toBe(true);
      const fd = fs.open("/alias", O_RDONLY, 0);
      const byte = new Uint8Array(1);
      expect(fs.read(fd, byte, null, 1)).toBe(1);
      fs.close(fd);
      expect(byte[0]).toBe(7);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retains a peer-created lazy alias when rename replaces its other name", async () => {
    const originalFetch = globalThis.fetch;
    const fs = create();
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    fs.registerLazyFile("/destination", "https://example.test/lazy", 1);
    peer.link("/destination", "/alias");
    const source = fs.open("/source", O_CREAT | O_WRONLY | O_TRUNC, 0o644);
    fs.write(source, new Uint8Array([4]), null, 1);
    fs.close(source);

    fs.rename("/source", "/destination");
    expect(fs.getLazyEntry("/alias")).toMatchObject({ path: "/alias" });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "1" }),
      body: null,
      arrayBuffer: () => Promise.resolve(new Uint8Array([7]).buffer),
    } as unknown as Response);

    try {
      await expect(fs.ensureMaterialized("/alias")).resolves.toBe(true);
      const alias = fs.open("/alias", O_RDONLY, 0);
      const aliasByte = new Uint8Array(1);
      expect(fs.read(alias, aliasByte, null, 1)).toBe(1);
      fs.close(alias);
      expect(aliasByte[0]).toBe(7);

      const destination = fs.open("/destination", O_RDONLY, 0);
      const destinationByte = new Uint8Array(1);
      expect(fs.read(destination, destinationByte, null, 1)).toBe(1);
      fs.close(destination);
      expect(destinationByte[0]).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the identity actually removed when unlink races a peer rename", async () => {
    const originalFetch = globalThis.fetch;
    const fs = create();
    fs.registerLazyFile("/lazy", "https://example.test/lazy", 1);
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    const raw = (
      fs as unknown as {
        fs: { unlink: (path: string) => unknown };
      }
    ).fs;
    const unlink = raw.unlink.bind(raw);
    const unlinkSpy = vi.spyOn(raw, "unlink").mockImplementation((path) => {
      peer.rename(path, "/moved");
      const replacement = peer.open(path, O_CREAT | O_WRONLY, 0o644);
      peer.write(replacement, new Uint8Array([9]), null, 1);
      peer.close(replacement);
      return unlink(path);
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "1" }),
      body: null,
      arrayBuffer: () => Promise.resolve(new Uint8Array([7]).buffer),
    } as unknown as Response);

    try {
      fs.unlink("/lazy");
      expect(fs.getLazyEntry("/moved")).not.toBeNull();
      await expect(fs.ensureMaterialized("/moved")).resolves.toBe(true);
    } finally {
      unlinkSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the source actually renamed when a peer replaces the old path", async () => {
    const originalFetch = globalThis.fetch;
    const fs = create();
    fs.registerLazyFile("/lazy", "https://example.test/lazy", 1);
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    const raw = (
      fs as unknown as {
        fs: { rename: (oldPath: string, newPath: string) => unknown };
      }
    ).fs;
    const rename = raw.rename.bind(raw);
    const renameSpy = vi
      .spyOn(raw, "rename")
      .mockImplementation((oldPath, newPath) => {
        peer.rename(oldPath, "/moved");
        const replacement = peer.open(oldPath, O_CREAT | O_WRONLY, 0o644);
        peer.write(replacement, new Uint8Array([9]), null, 1);
        peer.close(replacement);
        return rename(oldPath, newPath);
      });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "1" }),
      body: null,
      arrayBuffer: () => Promise.resolve(new Uint8Array([7]).buffer),
    } as unknown as Response);

    try {
      fs.rename("/lazy", "/renamed");
      expect(fs.getLazyEntry("/moved")).not.toBeNull();
      expect(fs.stat("/renamed").size).toBe(1);
      await expect(fs.ensureMaterialized("/moved")).resolves.toBe(true);
    } finally {
      renameSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves every lazy hard-link name across instance transfer", () => {
    const fs = create();
    fs.registerLazyFile("/lazy", "https://example.test/lazy", 3);
    fs.link("/lazy", "/alias");

    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    peer.importLazyEntries(fs.exportLazyEntries());
    peer.unlink("/lazy");

    expect(peer.getLazyEntry("/alias")).toMatchObject({
      path: "/alias",
      paths: ["/alias"],
      size: 3,
    });
  });

  it("preserves ordinary and lazy hard-link identity while rebasing", () => {
    const fs = create();
    const regular = fs.open("/regular", O_CREAT | O_WRONLY, 0o644);
    fs.write(regular, new Uint8Array([1, 2, 3]), null, 3);
    fs.close(regular);
    fs.link("/regular", "/regular-alias");
    fs.registerLazyFile("/lazy", "https://example.test/lazy", 3);
    fs.link("/lazy", "/lazy-alias");

    const rebased = fs.rebaseToNewFileSystem(8 * 1024 * 1024);
    expect(rebased.stat("/regular").ino).toBe(
      rebased.stat("/regular-alias").ino,
    );
    expect(rebased.stat("/regular").nlink).toBe(2);
    expect(rebased.stat("/lazy").ino).toBe(rebased.stat("/lazy-alias").ino);
    expect(rebased.stat("/lazy").nlink).toBe(2);
    expect(rebased.getLazyEntry("/lazy-alias")).toMatchObject({
      size: 3,
      paths: expect.arrayContaining(["/lazy", "/lazy-alias"]),
    });
  });

  it("rebases from one coherent snapshot when a peer renames afterward", () => {
    const fs = create();
    fs.registerLazyFile("/lazy", "https://example.test/lazy", 3);
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);

    // Inject the peer mutation immediately after SharedFS captures its bytes
    // and identity map. The rebased result must consistently reflect that
    // captured pre-rename state rather than walking the newer live tree.
    const shared = (
      fs as unknown as {
        fs: { snapshotState: () => unknown };
      }
    ).fs;
    const snapshotState = shared.snapshotState.bind(shared);
    shared.snapshotState = () => {
      const snapshot = snapshotState();
      peer.rename("/lazy", "/moved");
      return snapshot;
    };

    const rebased = fs.rebaseToNewFileSystem(8 * 1024 * 1024);
    expect(peer.stat("/moved").size).toBe(0);
    expect(() => peer.stat("/lazy")).toThrow();
    expect(rebased.stat("/lazy").size).toBe(3);
    expect(() => rebased.stat("/moved")).toThrow();
    expect(rebased.getLazyEntry("/lazy")).toMatchObject({
      path: "/lazy",
      size: 3,
    });
  });

  it("drops deferred backing after an explicit write through a hard link", async () => {
    const fs = create();
    fs.registerLazyFile("/lazy", "https://example.test/lazy", 999);
    fs.link("/lazy", "/alias");

    const fd = fs.open("/alias", O_WRONLY | O_TRUNC, 0o644);
    expect(fs.write(fd, new Uint8Array([0x5a]), null, 1)).toBe(1);
    fs.close(fd);

    expect(fs.stat("/lazy").size).toBe(1);
    expect(fs.getLazyEntry("/lazy")).toBeNull();
    expect(fs.getLazyEntry("/alias")).toBeNull();
    expect(fs.exportLazyEntries()).toEqual([]);
    await expect(fs.ensureMaterialized("/alias")).resolves.toBe(false);
  });

  it("does not apply a delayed fetch to a replacement inode", async () => {
    const originalFetch = globalThis.fetch;
    const fs = create();
    fs.registerLazyFile("/lazy", "https://example.test/lazy", 1);
    let release!: (value: ArrayBuffer) => void;
    const body = new Promise<ArrayBuffer>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "1" }),
      body: null,
      arrayBuffer: () => body,
    } as unknown as Response);

    try {
      const pending = fs.ensureMaterialized("/lazy");
      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

      const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
      peer.unlink("/lazy");
      const replacement = peer.open("/lazy", O_CREAT | O_WRONLY, 0o644);
      peer.write(replacement, new Uint8Array([9]), null, 1);
      peer.close(replacement);

      release(new Uint8Array([1]).buffer);
      await expect(pending).resolves.toBe(false);

      const fd = fs.open("/lazy", O_RDONLY, 0);
      const byte = new Uint8Array(1);
      expect(fs.read(fd, byte, null, 1)).toBe(1);
      fs.close(fd);
      expect(byte[0]).toBe(9);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("finishes one materialization call after a peer rename during fetch", async () => {
    const originalFetch = globalThis.fetch;
    const fs = create();
    fs.registerLazyFile("/lazy", "https://example.test/lazy", 1);
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    let release!: (value: ArrayBuffer) => void;
    const body = new Promise<ArrayBuffer>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "1" }),
      body: null,
      arrayBuffer: () => body,
    } as unknown as Response);

    try {
      const pending = fs.ensureMaterialized("/lazy");
      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
      peer.rename("/lazy", "/moved");
      release(new Uint8Array([7]).buffer);

      await expect(pending).resolves.toBe(true);
      const fd = fs.open("/moved", O_RDONLY, 0);
      const byte = new Uint8Array(1);
      expect(fs.read(fd, byte, null, 1)).toBe(1);
      fs.close(fd);
      expect(byte[0]).toBe(7);
      expect(fs.getLazyEntry("/moved")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps an empty lazy stub retryable after ENOSPC", async () => {
    const originalFetch = globalThis.fetch;
    const fs = create(256 * 1024);
    fs.registerLazyFile("/lazy", "https://example.test/lazy", 4096);
    const filler = fs.open("/filler", O_CREAT | O_WRONLY, 0o644);
    const chunk = new Uint8Array(64 * 1024).fill(0xa5);
    while (fs.write(filler, chunk, null, chunk.length) > 0) {
      // Fill every allocatable block.
    }
    fs.close(filler);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "4096" }),
      body: null,
      arrayBuffer: () => Promise.resolve(new Uint8Array(4096).fill(7).buffer),
    } as unknown as Response);

    try {
      await expect(fs.ensureMaterialized("/lazy")).rejects.toThrow(
        /No space left/,
      );
      expect(fs.getLazyEntry("/lazy")).not.toBeNull();
      expect(fs.stat("/lazy").size).toBe(4096);

      fs.unlink("/filler");
      await expect(fs.ensureMaterialized("/lazy")).resolves.toBe(true);
      const fd = fs.open("/lazy", O_RDONLY, 0);
      const byte = new Uint8Array(1);
      expect(fs.read(fd, byte, null, 1)).toBe(1);
      fs.close(fd);
      expect(byte[0]).toBe(7);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not overwrite a same-inode write that wins after fetch", async () => {
    const originalFetch = globalThis.fetch;
    const fs = create();
    fs.registerLazyFile("/lazy", "https://example.test/lazy", 1);
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "1" }),
      body: null,
      arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer),
    } as unknown as Response);

    type ReplaceArgs = [string, number, number, number, Uint8Array];
    const raw = (
      fs as unknown as {
        fs: { replaceIfIdentity: (...args: ReplaceArgs) => boolean };
      }
    ).fs;
    const replace = raw.replaceIfIdentity.bind(raw);
    const replaceSpy = vi
      .spyOn(raw, "replaceIfIdentity")
      .mockImplementation((...args: ReplaceArgs) => {
        const fd = peer.open("/lazy", O_WRONLY | O_TRUNC, 0o644);
        peer.write(fd, new Uint8Array([9]), null, 1);
        peer.close(fd);
        return replace(...args);
      });

    try {
      await expect(fs.ensureMaterialized("/lazy")).resolves.toBe(false);
      const fd = fs.open("/lazy", O_RDONLY, 0);
      const byte = new Uint8Array(1);
      expect(fs.read(fd, byte, null, 1)).toBe(1);
      fs.close(fd);
      expect(byte[0]).toBe(9);
    } finally {
      replaceSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  it("materializes through a surviving path renamed by another instance", async () => {
    const originalFetch = globalThis.fetch;
    const fs = create();
    fs.registerLazyFile("/lazy", "https://example.test/lazy", 1);
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    fs.symlink("/moved", "/indirect");
    peer.rename("/lazy", "/moved");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-length": "1" }),
      body: null,
      arrayBuffer: () => Promise.resolve(new Uint8Array([7]).buffer),
    } as unknown as Response);

    try {
      await expect(fs.ensureMaterialized("/indirect")).resolves.toBe(true);
      const fd = fs.open("/moved", O_RDONLY, 0);
      const byte = new Uint8Array(1);
      expect(fs.read(fd, byte, null, 1)).toBe(1);
      fs.close(fd);
      expect(byte[0]).toBe(7);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
