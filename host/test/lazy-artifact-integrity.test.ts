import { describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import {
  MemoryFileSystem,
  type LazyArchiveIntegrity,
} from "../src/vfs/memory-fs";
import { sha256Hex } from "../src/vfs/lazy-fetch";
import { parseZipCentralDirectory } from "../src/vfs/zip";

const O_RDONLY = 0;

function createMemfs(bytes = 4 * 1024 * 1024): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(bytes));
}

function archiveFixture(): {
  zipBytes: Uint8Array;
  entries: ReturnType<typeof parseZipCentralDirectory>;
} {
  const zipBytes = zipSync({
    "bin/tool": new TextEncoder().encode("tool bytes"),
    "lib/runtime.dat": new TextEncoder().encode("runtime bytes"),
  });
  return { zipBytes, entries: parseZipCentralDirectory(zipBytes) };
}

async function integrityFor(bytes: Uint8Array): Promise<LazyArchiveIntegrity> {
  return {
    compressedBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  };
}

function readBytes(fs: MemoryFileSystem, path: string, size: number): Uint8Array {
  const fd = fs.open(path, O_RDONLY, 0);
  const bytes = new Uint8Array(size);
  const read = fs.read(fd, bytes, null, bytes.byteLength);
  fs.close(fd);
  return bytes.subarray(0, read);
}

function response(bytes: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(bytes.byteLength) }),
    body: null,
    arrayBuffer: async () => bytes.slice().buffer,
  } as unknown as Response;
}

function rewriteCentralUncompressedSize(
  zipBytes: Uint8Array,
  size: number,
): Uint8Array {
  const rewritten = zipBytes.slice();
  const view = new DataView(
    rewritten.buffer,
    rewritten.byteOffset,
    rewritten.byteLength,
  );
  for (let offset = 0; offset <= rewritten.byteLength - 46; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint32(offset + 24, size, true);
      return rewritten;
    }
  }
  throw new Error("zip central directory not found");
}

describe("lazy artifact integrity", () => {
  it("rejects unsafe standalone declarations and imports transactionally", () => {
    const fs = createMemfs();
    for (const size of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => fs.registerLazyFile("/bin/tool", "tool.wasm", size)).toThrow(
        /non-negative safe-integer size/,
      );
    }

    fs.registerLazyFile("/bin/tool", "tool.wasm", 4);
    const [entry] = fs.exportLazyEntries();
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    expect(() => peer.importLazyEntries([{ ...entry, size: -1 }])).toThrow(
      /non-negative safe-integer size/,
    );
    expect(peer.exportLazyEntries()).toEqual([]);
  });

  it("retains a standalone stub after a short response and coalesces a retry", async () => {
    const originalFetch = globalThis.fetch;
    const fs = createMemfs();
    fs.registerLazyFile("/bin/tool", "https://example.test/tool.wasm", 4, 0o755);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(new Uint8Array([1, 2])))
      .mockResolvedValueOnce(response(new Uint8Array([1, 2, 3, 4])));
    globalThis.fetch = fetchMock;

    try {
      await expect(fs.ensureMaterialized("/bin/tool")).rejects.toThrow(
        /expected 4 bytes, received 2/,
      );
      expect(fs.getLazyEntry("/bin/tool")).toMatchObject({ size: 4 });
      expect(readBytes(fs, "/bin/tool", 4)).toHaveLength(0);

      await expect(Promise.all([
        fs.ensureMaterialized("/bin/tool"),
        fs.ensureMaterialized("/bin/tool"),
      ])).resolves.toEqual([true, true]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fs.getLazyEntry("/bin/tool")).toBeNull();
    expect([...readBytes(fs, "/bin/tool", 4)]).toEqual([1, 2, 3, 4]);
  });

  it("requires a complete archive integrity pair and persists it in VFS images", async () => {
    const { zipBytes, entries } = archiveFixture();
    const integrity = await integrityFor(zipBytes);
    const invalid = createMemfs();
    expect(() => invalid.registerLazyArchiveFromEntries(
      "runtime.zip",
      entries,
      "/opt",
      undefined,
      { compressedBytes: zipBytes.byteLength } as LazyArchiveIntegrity,
    )).toThrow(/compressedBytes and sha256 together/);

    const fs = createMemfs();
    fs.registerLazyArchiveFromEntries(
      "runtime.zip",
      entries,
      "/opt",
      undefined,
      integrity,
    );
    const restored = MemoryFileSystem.fromImage(await fs.saveImage());
    expect(restored.exportLazyArchiveEntries()).toEqual([
      expect.objectContaining(integrity),
    ]);
  });

  it("rejects oversized, truncated, and trailing lazy image sections", async () => {
    const fs = createMemfs();
    fs.registerLazyFile("/bin/tool", "tool.wasm", 4, 0o755);
    const image = await fs.saveImage();
    const header = new DataView(
      image.buffer,
      image.byteOffset,
      image.byteLength,
    );
    const lazyOffset = 16 + header.getUint32(12, true);

    const oversized = image.slice();
    new DataView(oversized.buffer).setUint32(
      lazyOffset,
      16 * 1024 * 1024 + 1,
      true,
    );
    expect(() => MemoryFileSystem.fromImage(oversized)).toThrow(
      /lazy file metadata exceeds/,
    );

    const truncated = image.slice();
    const truncatedView = new DataView(truncated.buffer);
    truncatedView.setUint32(
      lazyOffset,
      truncatedView.getUint32(lazyOffset, true) + 1,
      true,
    );
    expect(() => MemoryFileSystem.fromImage(truncated)).toThrow(/truncated/);

    const trailing = new Uint8Array(image.byteLength + 1);
    trailing.set(image);
    expect(() => MemoryFileSystem.fromImage(trailing)).toThrow(/trailing bytes/);
  });

  it("verifies archive bytes before replacing any member and can retry", async () => {
    const originalFetch = globalThis.fetch;
    const { zipBytes, entries } = archiveFixture();
    const fs = createMemfs();
    const integrity = await integrityFor(zipBytes);
    fs.registerLazyArchiveFromEntries(
      "https://example.test/runtime.zip",
      entries,
      "/opt",
      undefined,
      integrity,
    );
    const corrupted = zipBytes.slice();
    corrupted[0] ^= 0xff;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(corrupted))
      .mockResolvedValueOnce(response(zipBytes));
    globalThis.fetch = fetchMock;

    try {
      await expect(fs.ensureMaterialized("/opt/bin/tool")).rejects.toThrow(
        /SHA-256 mismatch/,
      );
      expect(readBytes(fs, "/opt/bin/tool", 32)).toHaveLength(0);
      expect(readBytes(fs, "/opt/lib/runtime.dat", 32)).toHaveLength(0);
      expect(fs.exportLazyArchiveEntries()).toHaveLength(1);

      await expect(fs.ensureMaterialized("/opt/bin/tool")).resolves.toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new TextDecoder().decode(readBytes(fs, "/opt/bin/tool", 32))).toBe(
      "tool bytes",
    );
    expect(new TextDecoder().decode(readBytes(fs, "/opt/lib/runtime.dat", 32))).toBe(
      "runtime bytes",
    );
    expect(fs.exportLazyArchiveEntries()).toEqual([]);
  });

  it("rejects member-size drift before replacing any archive stub", async () => {
    const originalFetch = globalThis.fetch;
    const { zipBytes, entries } = archiveFixture();
    const fs = createMemfs();
    const group = fs.registerLazyArchiveFromEntries(
      "https://example.test/runtime.zip",
      entries,
      "/opt",
      undefined,
      await integrityFor(zipBytes),
    );
    group.entries.get("/opt/bin/tool")!.size += 1;
    globalThis.fetch = vi.fn().mockResolvedValue(response(zipBytes));

    try {
      await expect(fs.ensureMaterialized("/opt/bin/tool")).rejects.toThrow(
        /size mismatch/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(readBytes(fs, "/opt/bin/tool", 32)).toHaveLength(0);
    expect(readBytes(fs, "/opt/lib/runtime.dat", 32)).toHaveLength(0);
    expect(group.materialized).toBe(false);
  });

  it("bounds deflate output by the central-directory member size", async () => {
    const originalFetch = globalThis.fetch;
    const expanded = zipSync({ "bin/expanded": new Uint8Array(1024 * 1024) });
    const zipBytes = rewriteCentralUncompressedSize(expanded, 1);
    const fs = createMemfs();
    fs.registerLazyArchiveFromEntries(
      "https://example.test/expanded.zip",
      parseZipCentralDirectory(zipBytes),
      "/opt",
      undefined,
      await integrityFor(zipBytes),
    );
    globalThis.fetch = vi.fn().mockResolvedValue(response(zipBytes));

    try {
      await expect(fs.ensureMaterialized("/opt/bin/expanded")).rejects.toThrow(
        /expected 1 bytes, received at least 2/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(readBytes(fs, "/opt/bin/expanded", 8)).toHaveLength(0);
    expect(fs.exportLazyArchiveEntries()).toHaveLength(1);
  });
});
