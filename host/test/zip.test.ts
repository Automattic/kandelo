import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import {
  fetchZipCentralDirectory,
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

describe("fetchZipCentralDirectory", () => {
  const URL_UNDER_TEST = "https://archive.example/big.zip";
  // Enough long member names that the central directory is larger than the
  // 64 KiB EOCD tail read, so the directory needs its own ranged read.
  const members = Object.fromEntries(
    Array.from({ length: 800 }, (_, index) => [
      `share/${"d".repeat(80)}/member-${String(index).padStart(4, "0")}.txt`,
      new TextEncoder().encode(`member ${index}\n`),
    ]),
  );
  const archive = zipSync(members, { level: 0 });
  const expectedNames = Object.keys(members);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubServer(
    answer: (range: string | null) => Response,
  ): Array<string | null> {
    const ranges: Array<string | null> = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          headers: {
            "Accept-Ranges": "bytes",
            "Content-Length": String(archive.byteLength),
            ETag: '"v1"',
          },
        });
      }
      const range = new Headers(init?.headers).get("range");
      ranges.push(range);
      return answer(range);
    });
    return ranges;
  }

  it("reads the tail and the directory as exact ranges", async () => {
    const ranges = stubServer((range) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "")!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(archive.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${archive.byteLength}`,
        },
      });
    });

    const { entries, totalSize } = await fetchZipCentralDirectory(URL_UNDER_TEST);
    expect(totalSize).toBe(archive.byteLength);
    expect(entries.map((entry) => entry.fileName)).toEqual(expectedNames);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toBe(
      `bytes=${archive.byteLength - 65557}-${archive.byteLength - 1}`,
    );
  });

  it("parses the whole archive when a relay answers the tail read with 200", async () => {
    const ranges = stubServer(() => new Response(archive, { status: 200 }));

    const { entries, totalSize } = await fetchZipCentralDirectory(URL_UNDER_TEST);
    expect(totalSize).toBe(archive.byteLength);
    expect(entries.map((entry) => entry.fileName)).toEqual(expectedNames);
    // The 200 body is the archive itself; it is used once, not re-fetched and
    // not mistaken for the requested tail.
    expect(ranges).toHaveLength(1);
  });

  it("fails instead of parsing a 206 for the wrong offset", async () => {
    stubServer(() =>
      new Response(archive.slice(0, 65557), {
        status: 206,
        headers: {
          "Content-Range": `bytes 0-65556/${archive.byteLength}`,
        },
      })
    );

    await expect(fetchZipCentralDirectory(URL_UNDER_TEST)).rejects.toThrow(
      /ZIP tail read failed: .*does not start at/,
    );
  });
});
