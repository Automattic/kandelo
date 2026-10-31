import { describe, expect, it } from "vitest";
import { persistentImageIdentityWords, snapshotPersistentImageReadBinding } from "../src/vfs/image-integrity";

const identity = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

describe("persistent base ABI binding", () => {
  it("marshals exactly eight little-endian identity words", () => {
    expect(persistentImageIdentityWords(identity)).toEqual([
      0x03020100, 0x07060504, 0x0b0a0908, 0x0f0e0d0c,
      0x13121110, 0x17161514, 0x1b1a1918, 0x1f1e1d1c,
    ]);
    expect(persistentImageIdentityWords("ff".repeat(32))).toEqual(Array(8).fill(0xffff_ffff));
    for (const invalid of ["", "ff".repeat(31), "ff".repeat(33), "g".repeat(64), "A".repeat(64)]) {
      expect(() => persistentImageIdentityWords(invalid)).toThrow();
    }
  });

  it("takes an immutable bounded copy without choosing the on-disk checking policy", () => {
    const input = { identitySha256: identity, dataCachePages: 2, indexCachePages: 1 };
    const copy = snapshotPersistentImageReadBinding(input);
    input.identitySha256 = "ff".repeat(32);
    input.dataCachePages = 64;
    expect(copy).toEqual({ identitySha256: identity, dataCachePages: 2, indexCachePages: 1 });
    expect(Object.isFrozen(copy)).toBe(true);
    expect(snapshotPersistentImageReadBinding({ identitySha256: identity, dataCachePages: 64, indexCachePages: 64 }).dataCachePages).toBe(64);
  });

  it("accepts only a paired zero request for native budget-aware cache selection", () => {
    const binding = snapshotPersistentImageReadBinding({ identitySha256: identity, dataCachePages: 0, indexCachePages: 0 });
    expect(binding.dataCachePages).toBe(0);
    expect(binding.indexCachePages).toBe(0);
    expect(Object.isFrozen(binding)).toBe(true);
  });

  it("refuses missing identities and invalid cache budgets", () => {
    for (const value of [null, false, {}, { identitySha256: identity }, { identitySha256: "ff", dataCachePages: 1, indexCachePages: 1 }]) {
      expect(() => snapshotPersistentImageReadBinding(value)).toThrow();
    }
    for (const limit of [0, -1, 65, 1.5, Number.NaN, Infinity, "1", 1n]) {
      expect(() => snapshotPersistentImageReadBinding({ identitySha256: identity, dataCachePages: limit, indexCachePages: 1 })).toThrow();
      expect(() => snapshotPersistentImageReadBinding({ identitySha256: identity, dataCachePages: 1, indexCachePages: limit })).toThrow();
    }
  });
});
