import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { parseZipCentralDirectory } from "../src/vfs/zip";

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
