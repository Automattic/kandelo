import { describe, expect, it } from "vitest";
import { gzipSync } from "fflate";
import {
  parseTarGzip,
  type TarEntry,
} from "../src/vfs/tar";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BLOCK = 512;

interface TarSpec {
  path: string;
  type?: "file" | "directory" | "symlink" | "hardlink" | "pax";
  mode?: number;
  data?: string | Uint8Array;
  linkName?: string;
}

describe("bounded TAR gzip parser", () => {
  it("returns closed file, directory, symlink, and hardlink entry shapes", () => {
    const entries: TarEntry[] = parseTarGzip(gzipTar([
      { path: "runtime", type: "directory", mode: 0o755 },
      { path: "runtime/tool", data: "payload", mode: 0o755 },
      {
        path: "runtime/tool-symlink",
        type: "symlink",
        linkName: "tool",
      },
      {
        path: "runtime/tool-hardlink",
        type: "hardlink",
        linkName: "runtime/tool",
      },
    ]));

    expect(entries.map(({ path, type, mode }) => ({ path, type, mode })))
      .toEqual([
        { path: "runtime", type: "directory", mode: 0o755 },
        { path: "runtime/tool", type: "file", mode: 0o755 },
        { path: "runtime/tool-symlink", type: "symlink", mode: 0o777 },
        { path: "runtime/tool-hardlink", type: "hardlink", mode: 0o644 },
      ]);
    const file = entries.find((entry) => entry.type === "file")!;
    const symlink = entries.find((entry) => entry.type === "symlink")!;
    const hardlink = entries.find((entry) => entry.type === "hardlink")!;
    expect(decoder.decode(file.data)).toBe("payload");
    expect(symlink.linkName).toBe("tool");
    expect(hardlink.linkName).toBe("runtime/tool");
  });

  it("uses byte lengths for UTF-8 PAX records and paths", () => {
    const path = "runtime/naïve/工具";
    const pax = paxRecord("path", path);
    const entries = parseTarGzip(gzipTar([
      { path: "PaxHeaders/tool", type: "pax", data: pax },
      { path: "placeholder", data: "ok" },
    ]), { limits: { maxEntries: 1 } });

    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe(path);
    expect(entries[0].type).toBe("file");
  });

  it("enforces compressed, expanded, header, path, and link bounds", () => {
    const one = gzipTar([{ path: "tool", data: "payload" }]);
    expect(() => parseTarGzip(one, {
      limits: { maxCompressedBytes: one.byteLength - 1 },
    })).toThrow(/compressed byte count/);
    expect(() => parseTarGzip(one, {
      limits: { maxUncompressedBytes: 1024 },
    })).toThrow(/declared uncompressed byte count/);

    const two = gzipTar([
      { path: "one", data: "1" },
      { path: "two", data: "2" },
    ]);
    expect(() => parseTarGzip(two, {
      limits: { maxEntries: 1 },
    })).toThrow(/entry count/);
    expect(() => parseTarGzip(one, {
      limits: { maxPathBytes: 3 },
    })).toThrow(/bounded relative POSIX path/);

    const link = gzipTar([{
      path: "link",
      type: "symlink",
      linkName: "target",
    }]);
    expect(() => parseTarGzip(link, {
      limits: { maxLinkBytes: 3 },
    })).toThrow(/link target/);
  });

  it("rejects traversal in member and hardlink paths", () => {
    expect(() => parseTarGzip(gzipTar([
      { path: "../escape", data: "bad" },
    ]))).toThrow(/unsafe path segment/);
    expect(() => parseTarGzip(gzipTar([
      {
        path: "runtime/alias",
        type: "hardlink",
        linkName: "../escape",
      },
    ]))).toThrow(/unsafe path segment/);
  });

  it("rejects bad TAR checksums and incomplete end markers", () => {
    const badChecksum = tarBytes([{ path: "tool", data: "payload" }]);
    badChecksum[0] ^= 1;
    expect(() => parseTarGzip(gzipSync(badChecksum))).toThrow(/checksum mismatch/);

    const oneEndBlock = tarBytes(
      [{ path: "tool", data: "payload" }],
      1,
    );
    expect(() => parseTarGzip(gzipSync(oneEndBlock))).toThrow(
      /end marker is truncated/,
    );
  });

  it("checks the gzip CRC before exposing TAR entries", () => {
    const archive = gzipTar([{ path: "tool", data: "payload" }]);
    const corrupt = new Uint8Array(archive);
    corrupt[corrupt.byteLength - 8] ^= 1;
    expect(() => parseTarGzip(corrupt)).toThrow(/gzip CRC32 mismatch/);
  });
});

function gzipTar(entries: readonly TarSpec[]): Uint8Array {
  return gzipSync(tarBytes(entries));
}

function tarBytes(
  entries: readonly TarSpec[],
  endBlocks = 2,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = endBlocks * BLOCK;
  for (const entry of entries) {
    const data = entryData(entry);
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
  writeOctal(header, 100, 8, entry.mode ?? defaultMode(entry.type));
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = typeflag(entry.type).charCodeAt(0);
  if (entry.linkName !== undefined) {
    writeString(header, 157, 100, entry.linkName);
  }
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encoded = `${checksum.toString(8).padStart(6, "0")}\0 `;
  writeString(header, 148, 8, encoded);
  return header;
}

function entryData(entry: TarSpec): Uint8Array {
  if (entry.data instanceof Uint8Array) return entry.data;
  if (typeof entry.data === "string") return encoder.encode(entry.data);
  return new Uint8Array();
}

function typeflag(type: TarSpec["type"]): string {
  switch (type) {
    case "directory": return "5";
    case "symlink": return "2";
    case "hardlink": return "1";
    case "pax": return "x";
    default: return "0";
  }
}

function defaultMode(type: TarSpec["type"]): number {
  if (type === "directory") return 0o755;
  if (type === "symlink") return 0o777;
  return 0o644;
}

function paxRecord(key: string, value: string): Uint8Array {
  const body = encoder.encode(`${key}=${value}\n`);
  let digits = 1;
  for (;;) {
    const length = digits + 1 + body.byteLength;
    const text = String(length);
    if (text.length === digits) {
      return concat(encoder.encode(`${text} `), body);
    }
    digits = text.length;
  }
}

function writeString(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > length) throw new Error(`test field is too long: ${value}`);
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

function concat(...chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
