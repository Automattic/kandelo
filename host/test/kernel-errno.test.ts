import { describe, expect, it } from "vitest";
import { negErrno } from "../src/kernel";

describe("negErrno", () => {
  it.each([
    ["EBADF", -9],
    ["EMFILE", -24],
    ["ENFILE", -23],
    ["EROFS", -30],
    ["ENOTSUP", -95],
    ["EOPNOTSUPP", -95],
  ])("maps a plain %s platform error", (name, expected) => {
    expect(negErrno(new Error(`${name}: backend failure`))).toBe(expected);
  });

  it("preserves numeric backend and Node errno values", () => {
    expect(negErrno({ code: -28 })).toBe(-28);
    expect(negErrno({ code: 28 })).toBe(-28);
    expect(negErrno({ errno: -2 })).toBe(-2);
  });

  it("uses EIO only for an unclassified error", () => {
    expect(negErrno(new Error("opaque backend failure"))).toBe(-5);
  });
});
