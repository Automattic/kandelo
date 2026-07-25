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

  it("rejects runtime pointer widths other than wasm32 and wasm64", () => {
    expect(() => checkedWasmGuestPointerOffset(
      0,
      5 as 4,
      "invalid-width test",
    )).toThrow(
      new TypeError(
        "invalid-width test: pointer width must be exactly 4 or 8",
      ),
    );
  });

  it("uses captured numeric intrinsics after host globals are replaced", () => {
    const originalBigInt = globalThis.BigInt;
    const originalNumber = globalThis.Number;
    const originalAsUintN = originalBigInt.asUintN;
    const originalIsSafeInteger = originalNumber.isSafeInteger;
    let memory32Result: number | undefined;
    let memory64Result: number | undefined;
    let invalidMemory32Error: unknown;

    try {
      globalThis.BigInt = (() => 0n) as BigIntConstructor;
      globalThis.Number = (() => -1) as NumberConstructor;
      originalBigInt.asUintN = () => 0n;
      originalNumber.isSafeInteger = () => true;

      memory32Result = checkedWasmGuestPointerOffset(
        -1,
        4,
        "mutated memory32 test",
      );
      memory64Result = checkedWasmGuestPointerOffset(
        0x1_0000_0000n,
        8,
        "mutated memory64 test",
      );
      try {
        checkedWasmGuestPointerOffset(
          1.5,
          4,
          "mutated invalid memory32 test",
        );
      } catch (error) {
        invalidMemory32Error = error;
      }
    } finally {
      originalBigInt.asUintN = originalAsUintN;
      originalNumber.isSafeInteger = originalIsSafeInteger;
      globalThis.BigInt = originalBigInt;
      globalThis.Number = originalNumber;
    }

    expect(memory32Result).toBe(0xffff_ffff);
    expect(memory64Result).toBe(0x1_0000_0000);
    expect(invalidMemory32Error).toEqual(
      new TypeError(
        "mutated invalid memory32 test: expected an exact memory32 pointer",
      ),
    );
  });
});
