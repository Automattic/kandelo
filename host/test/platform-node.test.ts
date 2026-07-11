/**
 * Unit tests for the Node platform adapter — specifically the path
 * translation that bridges the kernel's POSIX namespace to Node `fs.*`.
 */

import {
  linkSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { NodePlatformIO, translateWindowsDrivePath } from "../src/platform/node";

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

describe("NodePlatformIO file identity", () => {
  it("preserves hard-link aliases and distinguishes another inode", () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-file-identity-"));
    try {
      const original = join(dir, "original");
      const alias = join(dir, "alias");
      const other = join(dir, "other");
      writeFileSync(original, "one");
      linkSync(original, alias);
      writeFileSync(other, "two");

      const io = new NodePlatformIO();
      const originalStat = io.stat(original);
      const aliasStat = io.stat(alias);
      const otherStat = io.stat(other);
      const originalIdentity = io.fileIdentity(
        original,
        BigInt(originalStat.dev),
        BigInt(originalStat.ino),
      );

      expect(io.fileIdentity(
        alias,
        BigInt(aliasStat.dev),
        BigInt(aliasStat.ino),
      )).toBe(originalIdentity);
      expect(io.fileIdentity(
        other,
        BigInt(otherStat.dev),
        BigInt(otherStat.ino),
      )).not.toBe(originalIdentity);
      expect(io.fileIdentity(original, 0n, 0n)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
