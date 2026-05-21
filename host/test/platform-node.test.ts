/**
 * Unit tests for the Node platform adapter — specifically the path
 * translation that bridges the kernel's POSIX namespace to Node `fs.*`.
 */

import { describe, it, expect } from "vitest";
import { translateWindowsDrivePath } from "../src/platform/node";

describe("translateWindowsDrivePath", () => {
  it("converts /C/foo → C:/foo", () => {
    expect(translateWindowsDrivePath("/C/foo")).toBe("C:/foo");
  });

  it("accepts lowercase drive letters", () => {
    expect(translateWindowsDrivePath("/d/projects/wp")).toBe("d:/projects/wp");
  });

  it("converts a bare drive prefix /C → C:/", () => {
    expect(translateWindowsDrivePath("/C")).toBe("C:/");
  });

  it("converts /C/ → C:/", () => {
    expect(translateWindowsDrivePath("/C/")).toBe("C:/");
  });

  it("preserves nested path segments", () => {
    expect(
      translateWindowsDrivePath("/C/Users/RUNNER~1/AppData/Local/Temp/foo"),
    ).toBe("C:/Users/RUNNER~1/AppData/Local/Temp/foo");
  });

  it("returns null for paths without a single-letter drive prefix", () => {
    expect(translateWindowsDrivePath("/foo/bar")).toBeNull();
    expect(translateWindowsDrivePath("/CD/foo")).toBeNull();
    expect(translateWindowsDrivePath("/wordpress")).toBeNull();
  });

  it("returns null for paths missing a leading slash", () => {
    expect(translateWindowsDrivePath("C:/foo")).toBeNull();
    expect(translateWindowsDrivePath("foo/bar")).toBeNull();
    expect(translateWindowsDrivePath("")).toBeNull();
  });

  it("returns null for the root /", () => {
    expect(translateWindowsDrivePath("/")).toBeNull();
  });
});
