import { createHash } from "node:crypto";
import { gzipSync, zipSync, type Zippable } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryFileSystem,
  type LazyTreeActivation,
  type LazyTreeRegistrationEntry,
} from "../src/vfs/memory-fs";

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface TarSpec {
  path: string;
  type?: "file" | "directory" | "symlink" | "hardlink";
  mode: number;
  data?: string;
  target?: string;
}

describe("format-neutral deferred trees", () => {
  it("accepts the filesystem root as the default first-use activation root", () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();

    fs.registerLazyTree(fixture.content, fixture.inventory);

    expect(fs.exportLazyArchiveEntries()[0]?.activation).toEqual({
      mode: "first-use",
      capabilities: ["deferred-tree"],
      roots: ["/"],
    });
  });

  it("materializes a TAR+gzip tree once while preserving hardlink identity", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const fetcher = vi.fn(async () => new Response(fixture.payload));
    fs.setLazyFetcher(fetcher);
    fs.registerLazyTree(fixture.content, fixture.inventory, "/", fixture.activation);

    expect(fetcher).not.toHaveBeenCalled();
    const beforeTarget = fs.lstat("/runtime/tool");
    const beforeAlias = fs.lstat("/runtime/tool-hardlink");
    expect(beforeAlias.ino).toBe(beforeTarget.ino);
    expect(beforeTarget.nlink).toBe(2);
    expect(beforeAlias.size).toBe(7);

    await expect(Promise.all([
      fs.preparePath("/runtime/tool"),
      fs.preparePath("/runtime/tool-hardlink"),
    ])).resolves.toEqual([true, true]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(readText(fs, "/runtime/tool")).toBe("payload");
    expect(readText(fs, "/runtime/tool-hardlink")).toBe("payload");
    const afterTarget = fs.lstat("/runtime/tool");
    const afterAlias = fs.lstat("/runtime/tool-hardlink");
    expect(afterAlias.ino).toBe(afterTarget.ino);
    expect(afterTarget.nlink).toBe(2);
  });

  it("tries byte-identical tree transports in declared order", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const primary = "https://primary.example.invalid/runtime.tar.gz";
    const mirror = "https://mirror.example.invalid/runtime.tar.gz";
    const fetcher = vi.fn(async (url: string) =>
      url === primary
        ? new Response(null, { status: 503 })
        : new Response(fixture.payload)
    );
    fs.setLazyFetcher(fetcher);
    fs.registerLazyTree({
      ...fixture.content,
      transports: [primary, mirror],
    }, fixture.inventory, "/", fixture.activation);

    await expect(fs.preparePath("/runtime/tool")).resolves.toBe(true);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([primary, mirror]);
    expect(readText(fs, "/runtime/tool")).toBe("payload");
  });

  it("round-trips decoder, inventory, activation, and inode groups through an image", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    fs.registerLazyTree(fixture.content, fixture.inventory, "/", fixture.activation);
    const restored = MemoryFileSystem.fromImage(await fs.saveImage());
    const serialized = restored.exportLazyArchiveEntries()[0];

    expect(serialized.content).toEqual(fixture.content);
    expect(serialized.activation).toEqual(fixture.activation);
    expect(serialized.inventory).toEqual(fixture.inventory);
    expect(restored.lstat("/runtime/tool-hardlink").ino)
      .toBe(restored.lstat("/runtime/tool").ino);

    restored.setLazyFetcher(async () => new Response(fixture.payload));
    await restored.preparePath("/runtime/tool-hardlink");
    expect(readText(restored, "/runtime/tool")).toBe("payload");
  });

  it("keeps first-use trees inert and makes boot-prefetch failures fatal", async () => {
    const firstUse = tarTreeFixture("first-use", "first-use");
    const boot = tarTreeFixture("boot-prefetch", "boot");
    const fs = createFs();
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("boot")) throw new Error("transport offline");
      return new Response(firstUse.payload);
    });
    fs.setLazyFetcher(fetcher);
    fs.registerLazyTree(
      firstUse.content,
      firstUse.inventory,
      "/",
      firstUse.activation,
    );
    fs.registerLazyTree(boot.content, boot.inventory, "/", boot.activation);

    expect(fs.stat("/first-use/tool").size).toBe(7);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(fs.prepareBootDeferredTrees()).rejects.toThrow("transport offline");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fs.stat("/first-use/tool").size).toBe(7);
  });

  it("preserves and verifies a symlink-only boot-prefetch tree", async () => {
    const fixture = symlinkTreeFixture();
    const source = createFs();
    source.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      fixture.activation,
    );
    const restored = MemoryFileSystem.fromImage(await source.saveImage());
    const fetcher = vi.fn(async () => new Response(fixture.payload));
    restored.setLazyFetcher(fetcher);

    expect(restored.readlink("/metadata/runtime-link")).toBe("/runtime/target");
    expect(fetcher).not.toHaveBeenCalled();
    expect(restored.exportLazyArchiveEntries()).toHaveLength(1);
    await expect(restored.prepareBootDeferredTrees()).resolves.toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(restored.exportLazyArchiveEntries()).toEqual([]);
  });

  it("rejects undeclared TAR members without mutating any stub", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const inventory = fixture.inventory.filter(
      (entry) => entry.vfsPath !== "/runtime/tool-hardlink",
    );
    fs.registerLazyTree(fixture.content, inventory, "/", fixture.activation);
    fs.setLazyFetcher(async () => new Response(fixture.payload));

    await expect(fs.preparePath("/runtime/tool")).rejects.toThrow(
      /decoded inventory counts differ/,
    );
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    expect(peer.stat("/runtime/tool").size).toBe(0);
  });

  it("rejects impossible hardlink metadata before namespace registration", () => {
    const fixture = tarTreeFixture("first-use");
    const inventory = structuredClone(fixture.inventory);
    const alias = inventory.find((entry) => entry.type === "hardlink")!;
    alias.mode = 0o644;
    const fs = createFs();

    expect(() =>
      fs.registerLazyTree(
        fixture.content,
        inventory,
        "/",
        fixture.activation,
      )
    ).toThrow(/hardlink .* invalid target/);
    expect(() => fs.lstat("/runtime")).toThrow();
  });

  it("bounds ZIP expansion by the declared inventory before mutating a stub", async () => {
    const uncompressed = new TextEncoder().encode("payload".repeat(4_096));
    const input: Zippable = {
      "runtime/tool": [uncompressed, {
        level: 9,
        os: 3,
        attrs: (((0o100000 | 0o755) << 16) >>> 0),
      }],
    };
    const payload = zipSync(input, { level: 9 });
    const centralOffset = findZipCentralDirectory(payload);
    new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
      .setUint32(centralOffset + 24, 1, true);
    const fs = createFs();
    fs.registerLazyTree({
      decoder: "zip-v1",
      mediaType: "application/zip",
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytes: payload.byteLength,
      expandedBytes: 1,
      sourceEntryCount: 1,
      transports: ["https://example.invalid/runtime.zip"],
    }, [{
      vfsPath: "/runtime/tool",
      sourcePath: "runtime/tool",
      type: "file",
      mode: 0o755,
      size: 1,
      inodeGroup: "runtime:tool",
    }], "/", {
      mode: "first-use",
      capabilities: ["test:zip-bound"],
      roots: ["/runtime/tool"],
    });
    fs.setLazyFetcher(async () => new Response(payload));

    await expect(fs.preparePath("/runtime/tool")).rejects.toThrow(
      /expands beyond 1 bytes/,
    );
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    expect(peer.stat("/runtime/tool").size).toBe(0);
  });
});

function findZipCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.byteLength - 4; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) return offset;
  }
  throw new Error("central directory entry not found in test ZIP");
}

function tarTreeFixture(
  mode: LazyTreeActivation["mode"],
  root = "runtime",
) {
  const specs: TarSpec[] = [
    { path: root, type: "directory", mode: 0o755 },
    { path: `${root}/tool`, mode: 0o755, data: "payload" },
    {
      path: `${root}/tool-hardlink`,
      type: "hardlink",
      mode: 0o755,
      target: `${root}/tool`,
    },
  ];
  const tar = tarBytes(specs);
  const payload = gzipSync(tar);
  const inventory: LazyTreeRegistrationEntry[] = [
    {
      vfsPath: `/${root}`,
      sourcePath: root,
      type: "directory",
      mode: 0o755,
      size: 0,
    },
    {
      vfsPath: `/${root}/tool`,
      sourcePath: `${root}/tool`,
      type: "file",
      mode: 0o755,
      size: 7,
      inodeGroup: `${root}:tool`,
    },
    {
      vfsPath: `/${root}/tool-hardlink`,
      sourcePath: `${root}/tool-hardlink`,
      type: "hardlink",
      mode: 0o755,
      size: 7,
      target: `/${root}/tool`,
      inodeGroup: `${root}:tool`,
    },
  ];
  return {
    payload,
    inventory,
    content: {
      decoder: "homebrew-bottle-tar-gzip-v1" as const,
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" as const,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytes: payload.byteLength,
      expandedBytes: tar.byteLength,
      sourceEntryCount: specs.length,
      transports: [`https://example.invalid/${root}.tar.gz`],
    },
    activation: {
      mode,
      capabilities: [`test:${root}`],
      roots: [`/${root}`],
    } satisfies LazyTreeActivation,
  };
}

function symlinkTreeFixture() {
  const target = "/runtime/target";
  const specs: TarSpec[] = [{
    path: "metadata/runtime-link",
    type: "symlink",
    mode: 0o777,
    target,
  }];
  const tar = tarBytes(specs);
  const payload = gzipSync(tar);
  return {
    payload,
    inventory: [{
      vfsPath: "/metadata/runtime-link",
      sourcePath: "metadata/runtime-link",
      type: "symlink" as const,
      mode: 0o777,
      size: encoder.encode(target).byteLength,
      target,
    }],
    content: {
      decoder: "homebrew-bottle-tar-gzip-v1" as const,
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" as const,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytes: payload.byteLength,
      expandedBytes: tar.byteLength,
      sourceEntryCount: specs.length,
      transports: ["https://example.invalid/metadata.tar.gz"],
    },
    activation: {
      mode: "boot-prefetch" as const,
      capabilities: ["test:metadata"],
      roots: ["/metadata"],
    },
  };
}

function createFs(): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
}

function readText(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    expect(fs.read(fd, bytes, null, bytes.byteLength)).toBe(bytes.byteLength);
  } finally {
    fs.close(fd);
  }
  return decoder.decode(bytes);
}

function tarBytes(entries: readonly TarSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 2 * BLOCK;
  for (const entry of entries) {
    const data = encoder.encode(entry.data ?? "");
    const payload = new Uint8Array(Math.ceil(data.byteLength / BLOCK) * BLOCK);
    payload.set(data);
    const header = tarHeader(entry, data.byteLength);
    chunks.push(header, payload);
    total += header.byteLength + payload.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function tarHeader(entry: TarSpec, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  writeString(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.type === "directory"
    ? "5".charCodeAt(0)
    : entry.type === "hardlink"
      ? "1".charCodeAt(0)
      : entry.type === "symlink"
        ? "2".charCodeAt(0)
        : "0".charCodeAt(0);
  if (entry.target) writeString(header, 157, 100, entry.target);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function writeString(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > length) throw new Error("test TAR field is too long");
  target.set(bytes, offset);
}

function writeOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  writeString(
    target,
    offset,
    length,
    `${value.toString(8).padStart(length - 2, "0")}\0`,
  );
}
