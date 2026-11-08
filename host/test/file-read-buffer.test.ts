import { describe, expect, it } from "vitest";
import { FileReadBuffer } from "../src/vfs/file-read-buffer";
import { ERRNO } from "../src/generated/abi";
import { selectVfsFileReadBytes } from "../src/runtime-memory-profile";

describe("bounded host file-read results", () => {
  it("preallocates known lengths and returns the complete result without a merge allocation", () => {
    const buffer = new FileReadBuffer(32, 16);
    expect(buffer.capacity).toBe(16);
    buffer.append(new Uint8Array([1, 2]));
    buffer.append(new Uint8Array([3, 4, 5]));
    expect([...buffer.finish()]).toEqual([1, 2, 3, 4, 5]);
    expect(buffer.capacity).toBe(16);
    expect(() => buffer.append(new Uint8Array([6]))).toThrow(expect.objectContaining({ errno: ERRNO.EINVAL }));
  });

  it("accepts short chunks and zero-size hints without treating either as EOF", () => {
    const buffer = new FileReadBuffer(257);
    for (let index = 0; index < 257; index++) buffer.append(new Uint8Array([index % 251]));
    expect(buffer.capacity).toBe(257);
    expect(buffer.finish()).toEqual(Uint8Array.from({ length: 257 }, (_, index) => index % 251));
  });

  it("refuses oversized hints or growth without changing accepted bytes and permits retry", () => {
    expect(() => new FileReadBuffer(8, 9)).toThrow(expect.objectContaining({ errno: ERRNO.ENOMEM }));
    const buffer = new FileReadBuffer(8);
    buffer.append(new Uint8Array([1, 2, 3]));
    expect(() => buffer.append(new Uint8Array(6))).toThrow(expect.objectContaining({ errno: ERRNO.ENOMEM }));
    expect(buffer.length).toBe(3);
    buffer.append(new Uint8Array([4, 5, 6, 7, 8]));
    expect([...buffer.finish()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("uses the existing executable-size error independently of the inspection memory allowance", () => {
    expect(() => new FileReadBuffer(8, 9, ERRNO.EFBIG)).toThrow(expect.objectContaining({ errno: ERRNO.EFBIG }));
  });

  it.each([0, -1, 1.5, NaN, Infinity])("refuses invalid memory allowances (%s)", limit => {
    expect(() => new FileReadBuffer(limit)).toThrow(expect.objectContaining({ errno: ERRNO.EINVAL }));
  });

  it("selects an explicit bounded result allowance independently of disk capacity", () => {
    expect(selectVfsFileReadBytes()).toBe(64 * 1024 * 1024);
    expect(selectVfsFileReadBytes(undefined, 1024)).toBe(16 * 1024 * 1024);
    expect(selectVfsFileReadBytes(4096, 1024)).toBe(4096);
    expect(selectVfsFileReadBytes(64 * 1024 * 1024, 1024)).toBe(64 * 1024 * 1024);
    for (const invalid of [0, -1, 1.5, NaN, Infinity, 64 * 1024 * 1024 + 1]) {
      expect(() => selectVfsFileReadBytes(invalid, 1024)).toThrow(RangeError);
    }
  });
});
