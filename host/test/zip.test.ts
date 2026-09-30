import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import {
  fetchZipCentralDirectory,
  fetchZipMember,
  parseZipCentralDirectory,
} from "../src/vfs/zip";

const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const CENTRAL_DIR_FIXED_SIZE = 46;

function firstCentralDirectoryOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.byteLength - 4; offset++) {
    if (view.getUint32(offset, true) === CENTRAL_DIR_SIGNATURE) return offset;
  }
  throw new Error("central directory entry not found in test ZIP");
}

describe("ZIP central-directory member names", () => {
  it("exposes exact UTF-8 filename bytes without retaining a mutable view", () => {
    const fileName = "share/caf\u00e9.txt";
    const zip = zipSync({
      [fileName]: new TextEncoder().encode("content\n"),
    });
    const [entry] = parseZipCentralDirectory(zip);
    const expected = new TextEncoder().encode(fileName);

    expect(entry.fileName).toBe(fileName);
    expect(entry.fileNameBytes).toEqual(expected);

    const centralOffset = firstCentralDirectoryOffset(zip);
    zip[centralOffset + CENTRAL_DIR_FIXED_SIZE] ^= 0xff;
    expect(entry.fileNameBytes).toEqual(expected);
  });

  it("preserves a leading UTF-8 BOM as part of the filename", () => {
    const fileName = "\ufefftool";
    const [entry] = parseZipCentralDirectory(
      zipSync({ [fileName]: new Uint8Array(0) }),
    );

    expect(entry.fileName).toBe(fileName);
    expect(entry.fileNameBytes).toEqual(new TextEncoder().encode(fileName));
  });

  it("rejects invalid UTF-8 instead of installing a replacement-character name", () => {
    const zip = zipSync({ tool: new Uint8Array(0) });
    const centralOffset = firstCentralDirectoryOffset(zip);
    zip[centralOffset + CENTRAL_DIR_FIXED_SIZE] = 0xff;

    expect(() => parseZipCentralDirectory(zip)).toThrow(
      /Invalid UTF-8 in ZIP member name/,
    );
  });
});

describe("ZIP central-directory member names for display", () => {
  it("lists a legacy code-page name instead of rejecting the archive", () => {
    const zip = zipSync({ tool: new Uint8Array(0) });
    const centralOffset = firstCentralDirectoryOffset(zip);
    zip[centralOffset + CENTRAL_DIR_FIXED_SIZE] = 0xff;

    const [entry] = parseZipCentralDirectory(zip, { names: "display" });
    expect(entry.fileName).toBe("�ool");
    // The exact bytes survive for anything that must match the member.
    expect(entry.fileNameBytes[0]).toBe(0xff);
  });
});

/**
 * A one-member archive written with ZIP64 records, as tools do for archives
 * past 4 GiB or 65,535 entries: every 16/32-bit size, count and offset field
 * is saturated and the real values live in the ZIP64 records.
 */
function zip64Archive(name: string, content: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const parts: number[] = [];
  const u16 = (v: number) => parts.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (v: number) => { u16(v & 0xffff); u16((v >>> 16) & 0xffff); };
  const u64 = (v: number) => { u32(v % 2 ** 32); u32(Math.floor(v / 2 ** 32)); };
  const bytes = (b: Uint8Array) => parts.push(...b);

  // Local header (stored), then data.
  u32(0x04034b50); u16(45); u16(0); u16(0); u16(0); u16(0);
  u32(0); u32(content.length); u32(content.length);
  u16(nameBytes.length); u16(0); bytes(nameBytes); bytes(content);

  const cdOffset = parts.length;
  u32(0x02014b50); u16((3 << 8) | 45); u16(45); u16(0); u16(0); u16(0); u16(0);
  u32(0); u32(0xffffffff); u32(0xffffffff);
  u16(nameBytes.length); u16(4 + 24); u16(0); u16(0); u16(0); u32(0o100644 << 16);
  u32(0xffffffff); bytes(nameBytes);
  u16(0x0001); u16(24); u64(content.length); u64(content.length); u64(0);
  const cdSize = parts.length - cdOffset;

  const eocd64Offset = parts.length;
  u32(0x06064b50); u64(44); u16(45); u16(45); u32(0); u32(0);
  u64(1); u64(1); u64(cdSize); u64(cdOffset);
  u32(0x07064b50); u32(0); u64(eocd64Offset); u32(1);
  u32(0x06054b50); u16(0); u16(0); u16(0xffff); u16(0xffff);
  u32(0xffffffff); u32(0xffffffff); u16(0);
  return Uint8Array.from(parts);
}

describe("ZIP64 archives", () => {
  it("reads counts, sizes and offsets from the ZIP64 records", () => {
    const content = new TextEncoder().encode("sixty-four\n");
    const [entry] = parseZipCentralDirectory(zip64Archive("big/rom.bin", content));
    expect(entry).toMatchObject({
      fileName: "big/rom.bin",
      compressedSize: content.length,
      uncompressedSize: content.length,
      localHeaderOffset: 0,
      encrypted: false,
    });
  });

  it("rejects a saturated archive with no ZIP64 end record", () => {
    const zip = zipSync({ a: new Uint8Array(1) });
    const view = new DataView(zip.buffer);
    const eocd = zip.length - 22;
    view.setUint16(eocd + 10, 0xffff, true);
    expect(() => parseZipCentralDirectory(zip)).toThrow(/no ZIP64 end record/);
  });
});

describe("untrusted ZIP directories", () => {
  it("refuses more entries than the caller accepts", () => {
    const zip = zipSync({ a: new Uint8Array(1), b: new Uint8Array(1), c: new Uint8Array(1) });
    expect(() => parseZipCentralDirectory(zip, { maxEntries: 2 })).toThrow(
      /declares 3 entries; at most 2/,
    );
  });

  it("refuses an entry count the directory cannot hold", () => {
    const zip = zipSync({ a: new Uint8Array(1) });
    new DataView(zip.buffer).setUint16(zip.length - 22 + 10, 5000, true);
    expect(() => parseZipCentralDirectory(zip)).toThrow(/declares 5000 entries/);
  });

  it("refuses a directory offset past the end records instead of reading out of bounds", () => {
    const zip = zipSync({ a: new Uint8Array(1) });
    new DataView(zip.buffer).setUint32(zip.length - 22 + 16, zip.length + 100, true);
    expect(() => parseZipCentralDirectory(zip)).toThrow(/lies outside the archive/);
  });

  it("refuses an entry whose data would start inside the directory", () => {
    const zip = zipSync({ a: new Uint8Array(1) });
    const central = firstCentralDirectoryOffset(zip);
    new DataView(zip.buffer).setUint32(central + 42, central, true);
    expect(() => parseZipCentralDirectory(zip)).toThrow(/outside the archive's data/);
  });

  it("marks encrypted members, and extraction refuses them", async () => {
    const zip = zipSync({ secret: new Uint8Array(4) }, { level: 0 });
    const central = firstCentralDirectoryOffset(zip);
    new DataView(zip.buffer).setUint16(central + 8, 1, true);
    const [entry] = parseZipCentralDirectory(zip);
    expect(entry.encrypted).toBe(true);
    await expect(
      fetchZipMember(
        "https://archive.example/x.zip",
        { entries: [entry], totalSize: zip.length, wholeArchive: zip },
        entry,
        { maxBytes: 1024 },
      ),
    ).rejects.toThrow(/encrypted/);
  });
});

describe("fetchZipCentralDirectory", () => {
  const URL_UNDER_TEST = "https://archive.example/big.zip";
  // Enough long member names that the central directory is larger than the
  // tail read, so the directory needs its own ranged read.
  const members = Object.fromEntries(
    Array.from({ length: 800 }, (_, index) => [
      `share/${"d".repeat(80)}/member-${String(index).padStart(4, "0")}.txt`,
      new TextEncoder().encode(`member ${index}\n`),
    ]),
  );
  const archive = zipSync(members, { level: 6 });
  const expectedNames = Object.keys(members);
  const TAIL = 65557 + 20 + 56;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Serve `bytes` for `bytes=a-b` and `bytes=-n` ranges. */
  function slice(range: string | null, etag = '"v1"'): Response {
    const suffix = /^bytes=-(\d+)$/.exec(range ?? "");
    const explicit = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    let start: number;
    let end: number;
    if (suffix) {
      start = Math.max(0, archive.byteLength - Number(suffix[1]));
      end = archive.byteLength - 1;
    } else if (explicit) {
      start = Number(explicit[1]);
      end = Math.min(Number(explicit[2]), archive.byteLength - 1);
    } else {
      return new Response(archive, { status: 200 });
    }
    return new Response(archive.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${archive.byteLength}`,
        ETag: etag,
      },
    });
  }

  function stubServer(answer: (range: string | null) => Response): Array<string | null> {
    const ranges: Array<string | null> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      const range = new Headers(init?.headers).get("range");
      ranges.push(range);
      return answer(range);
    });
    return ranges;
  }

  it("reads the tail by suffix, then the directory, as exact ranges", async () => {
    const ranges = stubServer((range) => slice(range));

    const { entries, totalSize, entityTag } = await fetchZipCentralDirectory(URL_UNDER_TEST);
    expect(totalSize).toBe(archive.byteLength);
    expect(entityTag).toBe('"v1"');
    expect(entries.map((entry) => entry.fileName)).toEqual(expectedNames);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toBe(`bytes=-${TAIL}`);
    expect(ranges[1]).toMatch(new RegExp(`^bytes=\\d+-${archive.byteLength - TAIL - 1}$`));
  });

  it("uses a caller's fetch, so reads can go through a relay", async () => {
    const relayed: string[] = [];
    const { entries } = await fetchZipCentralDirectory(URL_UNDER_TEST, {
      fetch: async (url, init) => {
        relayed.push(url);
        return slice(new Headers(init.headers).get("range"));
      },
    });
    expect(entries).toHaveLength(expectedNames.length);
    expect(relayed).toEqual([URL_UNDER_TEST, URL_UNDER_TEST]);
  });

  it("parses the whole archive when a relay answers the tail read with 200", async () => {
    const ranges = stubServer(() => new Response(archive, { status: 200 }));

    const directory = await fetchZipCentralDirectory(URL_UNDER_TEST);
    expect(directory.totalSize).toBe(archive.byteLength);
    expect(directory.entries.map((entry) => entry.fileName)).toEqual(expectedNames);
    expect(directory.wholeArchive).toBeDefined();
    // The 200 body is the archive itself; it is used once, not re-fetched and
    // not mistaken for the requested tail.
    expect(ranges).toHaveLength(1);
  });

  it("refuses a whole archive larger than the caller downloads whole", async () => {
    stubServer(() => new Response(archive, {
      status: 200,
      headers: { "Content-Length": String(archive.byteLength) },
    }));
    await expect(
      fetchZipCentralDirectory(URL_UNDER_TEST, { maxWholeArchiveBytes: 1024 }),
    ).rejects.toThrow(/larger than the 1024 bytes that are downloaded whole/);
  });

  it("refuses a directory larger than the caller reads", async () => {
    stubServer((range) => slice(range));
    await expect(
      fetchZipCentralDirectory(URL_UNDER_TEST, { maxDirectoryBytes: 1024 }),
    ).rejects.toThrow(/at most 1024 are read/);
  });

  it("fails instead of parsing a 206 for the wrong offset", async () => {
    stubServer(() =>
      new Response(archive.slice(0, TAIL), {
        status: 206,
        headers: { "Content-Range": `bytes 0-${TAIL - 1}/${archive.byteLength}` },
      })
    );
    await expect(fetchZipCentralDirectory(URL_UNDER_TEST)).rejects.toThrow(
      /ZIP tail read failed/,
    );
  });

  it("fails when the archive changes between the tail and directory reads", async () => {
    let reads = 0;
    stubServer((range) => {
      reads += 1;
      // Same length, new version: only the ETag reveals the change.
      return slice(range, reads === 1 ? '"v1"' : '"v2"');
    });
    await expect(fetchZipCentralDirectory(URL_UNDER_TEST)).rejects.toThrow(
      /ZIP central directory read failed: resource changed/,
    );
  });

  it("does not send If-Range, which the browser CORS proxy cannot carry", async () => {
    const sent: Headers[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return new Response(archive, { status: 200 });
    });
    await fetchZipCentralDirectory(URL_UNDER_TEST);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get("if-range")).toBeNull();
  });

  it("extracts one member with a single range read", async () => {
    const ranges = stubServer((range) => slice(range));
    const directory = await fetchZipCentralDirectory(URL_UNDER_TEST);
    const entry = directory.entries[417]!;
    const member = await fetchZipMember(URL_UNDER_TEST, directory, entry, { maxBytes: 1024 });
    expect(new TextDecoder().decode(member)).toBe("member 417\n");
    expect(ranges).toHaveLength(3);
    expect(ranges[2]).toMatch(new RegExp(`^bytes=${entry.localHeaderOffset}-\\d+$`));
  });

  it("refuses a member larger than the caller accepts, before reading it", async () => {
    const ranges = stubServer((range) => slice(range));
    const directory = await fetchZipCentralDirectory(URL_UNDER_TEST);
    await expect(
      fetchZipMember(URL_UNDER_TEST, directory, directory.entries[0]!, { maxBytes: 4 }),
    ).rejects.toThrow(/at most 4 are accepted/);
    expect(ranges).toHaveLength(2);
  });

  it("reads a ZIP64 archive's directory over ranges", async () => {
    const content = new TextEncoder().encode("from a zip64 archive\n");
    const zip64 = zip64Archive("rom.bin", content);
    const fetchImpl = async (_url: string, init: RequestInit) => {
      const range = new Headers(init.headers).get("range") ?? "";
      const suffix = /^bytes=-(\d+)$/.exec(range);
      const explicit = /^bytes=(\d+)-(\d+)$/.exec(range);
      const start = suffix ? Math.max(0, zip64.length - Number(suffix[1])) : Number(explicit![1]);
      const end = suffix ? zip64.length - 1 : Math.min(Number(explicit![2]), zip64.length - 1);
      return new Response(zip64.slice(start, end + 1), {
        status: 206,
        headers: { "Content-Range": `bytes ${start}-${end}/${zip64.length}` },
      });
    };
    const directory = await fetchZipCentralDirectory("https://archive.example/z64.zip", {
      fetch: fetchImpl,
    });
    expect(directory.entries.map((entry) => entry.fileName)).toEqual(["rom.bin"]);
    const member = await fetchZipMember(
      "https://archive.example/z64.zip",
      directory,
      directory.entries[0]!,
      { maxBytes: 1024, fetch: fetchImpl },
    );
    expect(new TextDecoder().decode(member)).toBe("from a zip64 archive\n");
  });
});
