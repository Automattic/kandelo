import { describe, expect, it } from "vitest";

import { IOCTL_REQUESTS } from "../src/generated/abi";
import { resolveIoctlContract } from "../src/ioctl-contract";

/** Builds the same encoding the musl `_IOC` macros produce. */
function evioc(dir: number, nr: number, size: number): number {
  return ((dir << 30) | (size << 16) | (0x45 << 8) | nr) >>> 0;
}

const EVIOCGNAME_NR = 0x06;
const EVIOCGBIT_NR_BASE = 0x20;
const EVIOCGABS_NR_BASE = 0x40;
const MAX_CALLER_LENGTH = 256;

describe("ioctl contract resolution", () => {
  it("resolves exact-numbered requests out of the generated table", () => {
    expect(resolveIoctlContract(0x540b)).toEqual(IOCTL_REQUESTS[0x540b]);
    expect(resolveIoctlContract(0x8004_4501)).toMatchObject({
      argKind: "pointer",
      direction: "out",
      wasm32Size: 4,
    });
    expect(resolveIoctlContract(0x4004_4590)).toMatchObject({
      argKind: "scalar-i32",
    });
  });

  it("resolves EVIOCGABS on every axis at the absinfo size", () => {
    for (let axis = 0; axis < 64; axis++) {
      expect(
        resolveIoctlContract(evioc(2, EVIOCGABS_NR_BASE + axis, 24)),
        `axis ${axis}`,
      ).toEqual({
        argKind: "pointer",
        direction: "out",
        wasm32Size: 24,
        wasm64Size: 24,
      });
    }
  });

  it("rejects an EVIOCGABS request sized as anything but absinfo", () => {
    expect(resolveIoctlContract(evioc(2, EVIOCGABS_NR_BASE, 16))).toBeUndefined();
  });

  it("carries the caller's length for EVIOCGNAME and EVIOCGBIT", () => {
    for (const size of [1, 32, MAX_CALLER_LENGTH]) {
      expect(
        resolveIoctlContract(evioc(2, EVIOCGNAME_NR, size))?.wasm32Size,
      ).toBe(size);
      expect(
        resolveIoctlContract(evioc(2, EVIOCGBIT_NR_BASE + 1, size))?.wasm32Size,
      ).toBe(size);
    }
  });

  it("rejects a zero or oversized caller length", () => {
    for (const nr of [EVIOCGNAME_NR, EVIOCGBIT_NR_BASE]) {
      expect(resolveIoctlContract(evioc(2, nr, 0))).toBeUndefined();
      expect(
        resolveIoctlContract(evioc(2, nr, MAX_CALLER_LENGTH + 1)),
      ).toBeUndefined();
    }
  });

  it("ignores a foreign magic or a write direction", () => {
    const foreignMagic =
      ((2 << 30) | (24 << 16) | (0x44 << 8) | EVIOCGABS_NR_BASE) >>> 0;
    expect(resolveIoctlContract(foreignMagic)).toBeUndefined();
    expect(
      resolveIoctlContract(evioc(1, EVIOCGABS_NR_BASE, 24)),
    ).toBeUndefined();
  });

  it("leaves an unknown request unresolved", () => {
    expect(resolveIoctlContract(0xdead_0000)).toBeUndefined();
  });
});
