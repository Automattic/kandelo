import { describe, expect, it, vi } from "vitest";
import { readImageFileBytes } from "../../benchmarks/read-image-file";

function imageReader(body: Uint8Array, maximumRead = 64 * 1024) {
  let cursor = 0;
  return {
    stat: () => ({ ino: 1, mode: 0o755, uid: 0, gid: 0, size: body.byteLength }),
    open: vi.fn(() => 7),
    close: vi.fn(),
    read: vi.fn((_handle: number, output: Uint8Array, _position: number | bigint | null, length: number) => {
      const count = Math.min(length, maximumRead, body.byteLength - cursor);
      output.set(body.subarray(cursor, cursor + count));
      cursor += count;
      return count;
    }),
  };
}

describe("benchmark image file reads", () => {
  it.each([7, 64 * 1024])("completes short reads capped at %i bytes", maximumRead => {
    const body = Uint8Array.from({ length: 193 * 1024 + 17 }, (_, index) => index * 37 & 255);
    const filesystem = imageReader(body, maximumRead);
    expect(new Uint8Array(readImageFileBytes(filesystem, "/program"))).toEqual(body);
    expect(filesystem.read.mock.calls.length).toBeGreaterThan(1);
    expect(filesystem.read.mock.calls.every(([, , position, length]) => position === null && length <= 65536)).toBe(true);
    expect(filesystem.close).toHaveBeenCalledExactlyOnceWith(7);
  });

  it.each([0, -1, NaN, 1.5, 65537])("refuses invalid progress %s and closes the handle", progress => {
    const filesystem = imageReader(new Uint8Array(65536));
    filesystem.read.mockReturnValue(progress);
    expect(() => readImageFileBytes(filesystem, "/program")).toThrow("Incomplete benchmark image read for /program at 0");
    expect(filesystem.close).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("closes after a read failure without replacing its cause", () => {
    const filesystem = imageReader(new Uint8Array(1));
    const failure = new Error("storage read failed");
    filesystem.read.mockImplementation(() => { throw failure; });
    expect(() => readImageFileBytes(filesystem, "/program")).toThrow(failure);
    expect(filesystem.close).toHaveBeenCalledExactlyOnceWith(7);
  });

  it.each([-1, NaN, 2 ** 32])("refuses unsupported size %s before opening", size => {
    const filesystem = imageReader(new Uint8Array());
    filesystem.stat = () => ({ ino: 1, mode: 0o755, uid: 0, gid: 0, size });
    expect(() => readImageFileBytes(filesystem, "/program")).toThrow("Invalid benchmark image file size");
    expect(filesystem.open).not.toHaveBeenCalled();
  });

  it("returns an empty file without issuing a read", () => {
    const filesystem = imageReader(new Uint8Array());
    expect(readImageFileBytes(filesystem, "/empty").byteLength).toBe(0);
    expect(filesystem.read).not.toHaveBeenCalled();
    expect(filesystem.close).toHaveBeenCalledExactlyOnceWith(7);
  });
});
