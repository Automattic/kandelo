import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  readPreparedPlatformFile,
  VirtualPlatformIO,
} from "../src/vfs/vfs";
import { parseZipCentralDirectory } from "../src/vfs/zip";

const O_RDONLY = 0;
const O_WRONLY = 1;
const O_CREAT = 0x40;
const O_TRUNC = 0x200;

const time = {
  clockGettime: () => ({ sec: 0, nsec: 0 }),
  nanosleep: () => {},
};

function createFs(bytes = 4 * 1024 * 1024): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(bytes));
}

function platform(fs: MemoryFileSystem): VirtualPlatformIO {
  return new VirtualPlatformIO([{ mountPoint: "/", backend: fs }], time);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function registerArchive(
  fs: MemoryFileSystem,
  bytes: Uint8Array,
  url = "https://example.test/runtime.zip",
): Promise<void> {
  fs.registerLazyArchiveFromEntries(
    url,
    parseZipCentralDirectory(bytes),
    "/runtime",
    undefined,
    { sha256: await sha256(bytes), bytes: bytes.byteLength },
  );
}

function response(bytes: Uint8Array): Response {
  return new Response(bytes, {
    headers: { "content-length": String(bytes.byteLength) },
  });
}

describe("prepared lazy VFS I/O", () => {
  it("does not fetch at registration/stat and deduplicates concurrent open/API reads", async () => {
    const fs = createFs();
    const archive = zipSync({
      "bin/runtime": new TextEncoder().encode("runtime-bytes"),
      "share/data": new TextEncoder().encode("shared-data"),
    });
    await registerArchive(fs, archive);
    const fetcher = vi.fn(async () => response(archive));
    fs.setLazyFetcher(fetcher);
    const io = platform(fs);

    expect(fs.stat("/runtime/bin/runtime").size).toBe(13);
    expect(fetcher).not.toHaveBeenCalled();

    // The synchronous syscall-facing layer starts preparation with internal
    // EAGAIN. Both ordinary API reads then join that same archive operation.
    expect(() => io.open("/runtime/bin/runtime", O_RDONLY, 0)).toThrow(
      /EAGAIN: lazy backing/,
    );
    const [runtime, data] = await Promise.all([
      readPreparedPlatformFile(io, "/runtime/bin/runtime"),
      readPreparedPlatformFile(io, "/runtime/share/data"),
    ]);

    expect(new TextDecoder().decode(runtime.data)).toBe("runtime-bytes");
    expect(new TextDecoder().decode(data.data)).toBe("shared-data");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fs.stat("/runtime/bin/runtime").size).toBe(13);
    expect(fs.exportLazyArchiveEntries()).toEqual([]);
  });

  it("rolls back digest failure and permits a later explicit retry", async () => {
    const fs = createFs();
    const archive = zipSync({
      "a": new TextEncoder().encode("alpha"),
      "b": new TextEncoder().encode("bravo"),
    });
    await registerArchive(fs, archive);
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    let served = new Uint8Array(archive.map((byte, index) =>
      index === 0 ? byte ^ 0xff : byte
    ));
    const fetcher = vi.fn(async () => response(served));
    fs.setLazyFetcher(fetcher);
    const io = platform(fs);

    await expect(Promise.all([
      readPreparedPlatformFile(io, "/runtime/a"),
      readPreparedPlatformFile(io, "/runtime/b"),
    ])).rejects.toThrow(/SHA-256/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(peer.stat("/runtime/a").size).toBe(0);
    expect(peer.stat("/runtime/b").size).toBe(0);
    expect(fs.stat("/runtime/a").size).toBe(5);
    expect(fs.stat("/runtime/b").size).toBe(5);

    served = archive;
    await expect(readPreparedPlatformFile(io, "/runtime/a")).resolves
      .toMatchObject({ data: new TextEncoder().encode("alpha") });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("extracts every member before committing the first stub", async () => {
    const fs = createFs();
    const good = zipSync({
      "a": new TextEncoder().encode("alpha"),
      "b": new TextEncoder().encode("bravo"),
    });
    const entries = parseZipCentralDirectory(good);
    const broken = good.slice();
    const secondHeader = entries[1].localHeaderOffset;
    broken[secondHeader] ^= 0xff;
    fs.registerLazyArchiveFromEntries(
      "https://example.test/broken.zip",
      entries,
      "/runtime",
      undefined,
      { sha256: await sha256(broken), bytes: broken.byteLength },
    );
    fs.setLazyFetcher(async () => response(broken));
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);

    await expect(
      readPreparedPlatformFile(platform(fs), "/runtime/a"),
    ).rejects.toThrow(/Invalid local file header signature/);
    expect(peer.stat("/runtime/a").size).toBe(0);
    expect(peer.stat("/runtime/b").size).toBe(0);
    expect(fs.stat("/runtime/a").size).toBe(5);
    expect(fs.stat("/runtime/b").size).toBe(5);
  });

  it("rolls every member back on allocation failure and succeeds after space is freed", async () => {
    const fs = createFs(1024 * 1024);
    const payloadA = new Uint8Array(8192).fill(0x41);
    const payloadB = new Uint8Array(8192).fill(0x42);
    const archive = zipSync({ a: payloadA, b: payloadB });
    await registerArchive(fs, archive);
    fs.setLazyFetcher(async () => response(archive));

    const filler = fs.open("/filler", O_CREAT | O_WRONLY | O_TRUNC, 0o600);
    const block = new Uint8Array(4096).fill(0xcc);
    let fillerBytes = 0;
    for (;;) {
      const written = fs.write(filler, block, null, block.byteLength);
      if (written <= 0) break;
      fillerBytes += written;
      if (written < block.byteLength) break;
    }
    fs.ftruncate(filler, Math.max(0, fillerBytes - 3 * 4096));
    fs.close(filler);

    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    const io = platform(fs);
    await expect(readPreparedPlatformFile(io, "/runtime/a")).rejects.toThrow(
      /No space left/,
    );
    expect(peer.stat("/runtime/a").size).toBe(0);
    expect(peer.stat("/runtime/b").size).toBe(0);
    expect(fs.stat("/runtime/a").size).toBe(payloadA.byteLength);
    expect(fs.stat("/runtime/b").size).toBe(payloadB.byteLength);

    fs.unlink("/filler");
    const prepared = await readPreparedPlatformFile(io, "/runtime/b");
    expect(prepared.data).toEqual(payloadB);
  });

  it("survives an already-open handle closing while preparation is pending", async () => {
    const fs = createFs();
    const archive = zipSync({ tool: new TextEncoder().encode("tool") });
    await registerArchive(fs, archive);
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    const handle = peer.open("/runtime/tool", O_RDONLY, 0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fs.setLazyFetcher(async () => {
      await gate;
      return response(archive);
    });

    expect(() => fs.read(handle, new Uint8Array(4), null, 4)).toThrow(
      /EAGAIN: lazy backing/,
    );
    const pending = fs.preparePath("/runtime/tool");
    peer.close(handle);
    release();

    await expect(pending).resolves.toBe(true);
    await expect(readPreparedPlatformFile(platform(fs), "/runtime/tool"))
      .resolves.toMatchObject({ data: new TextEncoder().encode("tool") });
  });
});
