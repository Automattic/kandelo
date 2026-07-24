import { describe, expect, it } from "vitest";
import { checkedWasmGuestPointerOffset } from "../src/wasm-guest-pointer";

describe("checkedWasmGuestPointerOffset", () => {
  it.each([
    [0, 0],
    [0x7fff_ffff, 0x7fff_ffff],
    [-0x8000_0000, 0x8000_0000],
    [-1, 0xffff_ffff],
    [0xffff_ffff, 0xffff_ffff],
  ])("normalizes the memory32 value %s to %s", (value, expected) => {
    expect(checkedWasmGuestPointerOffset(value, 4, "memory32 test")).toBe(expected);
  });

  it.each([
    0n,
    -0x8000_0001,
    0x1_0000_0000,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])("rejects the invalid memory32 value %s", (value) => {
    expect(() => checkedWasmGuestPointerOffset(value, 4, "memory32 test"))
      .toThrow(new TypeError("memory32 test: expected an exact memory32 pointer"));
  });

  it.each([
    [0n, 0],
    [1n, 1],
    [BigInt(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ] as const)("normalizes the memory64 value %s to %s", (value, expected) => {
    expect(checkedWasmGuestPointerOffset(value, 8, "memory64 test")).toBe(expected);
  });

  it.each([
    0,
    -(1n << 63n) - 1n,
    (1n << 64n),
  ])("rejects the invalid memory64 representation %s", (value) => {
    expect(() => checkedWasmGuestPointerOffset(value, 8, "memory64 test"))
      .toThrow(new TypeError("memory64 test: expected an exact memory64 pointer"));
  });

  it.each([
    -1n,
    -(1n << 63n),
    BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    (1n << 64n) - 1n,
  ])("rejects the unaddressable memory64 value %s", (value) => {
    expect(() => checkedWasmGuestPointerOffset(value, 8, "memory64 test"))
      .toThrow(
        new RangeError(
          "memory64 test: pointer exceeds JavaScript's exact address range",
        ),
      );
  });
});
