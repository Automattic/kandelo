import { describe, expect, it } from "vitest";

import {
  MACHINE_NAME_MAX_LENGTH,
  machineNameFrom,
  presentableMachineName,
  randomMachineName,
} from "../src/machine-name";

const THREE_WORDS = /^[a-z]+-[a-z]+-[a-z]+$/;

describe("machineNameFrom", () => {
  it("joins three lowercase words with dashes", () => {
    expect(machineNameFrom(new Uint8Array([0, 0, 0]))).toMatch(THREE_WORDS);
  });

  it("gives the same name for the same bytes", () => {
    const bytes = new Uint8Array([17, 200, 91]);
    expect(machineNameFrom(bytes)).toBe(machineNameFrom(bytes));
  });

  it("never repeats a noun inside one name", () => {
    for (let first = 0; first < 256; first += 1) {
      for (const second of [0, 1, 46, 47, 255]) {
        const [, a, b] = machineNameFrom(new Uint8Array([3, first, second])).split("-");
        expect(a).not.toBe(b);
      }
    }
  });

  it("needs three bytes", () => {
    expect(() => machineNameFrom(new Uint8Array([1, 2]))).toThrow(/three random bytes/);
  });
});

describe("randomMachineName", () => {
  it("draws a three-word name", () => {
    expect(randomMachineName()).toMatch(THREE_WORDS);
  });

  it("avoids names already taken", () => {
    const taken = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const name = randomMachineName(taken);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
  });
});

describe("presentableMachineName", () => {
  it("trims and keeps a plain name", () => {
    expect(presentableMachineName("  my machine ")).toBe("my machine");
  });

  it("drops control characters", () => {
    expect(presentableMachineName("a\u0000b\u001fc\u007f")).toBe("abc");
  });

  it("caps the length", () => {
    expect(presentableMachineName("x".repeat(100))).toHaveLength(MACHINE_NAME_MAX_LENGTH);
  });

  it("returns null when nothing is left", () => {
    expect(presentableMachineName("   ")).toBeNull();
    expect(presentableMachineName("")).toBeNull();
  });
});
