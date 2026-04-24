import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/manifest.ts";

describe("manifest parser", () => {
  it("parses directory entries", () => {
    expect(parseManifest("/tmp  d  1777  0  0\n")).toEqual([
      { kind: "node", path: "/tmp", type: "d", mode: 0o1777, uid: 0, gid: 0 },
    ]);
  });

  it("parses file entries with implicit source", () => {
    expect(parseManifest("/etc/passwd  f  0644  0  0\n")).toEqual([
      { kind: "node", path: "/etc/passwd", type: "f", mode: 0o644, uid: 0, gid: 0 },
    ]);
  });

  it("parses file entries with explicit src=", () => {
    expect(parseManifest("/etc/foo  f  0644  0  0  src=configs/foo\n")).toEqual([
      { kind: "node", path: "/etc/foo", type: "f", mode: 0o644, uid: 0, gid: 0, src: "configs/foo" },
    ]);
  });

  it("ignores comments and blank lines", () => {
    const entries = parseManifest("# comment\n\n/tmp  d  1777\n");
    expect(entries).toHaveLength(1);
  });

  it("defaults uid/gid to 0 when omitted", () => {
    const entries = parseManifest("/tmp  d  1777\n");
    expect(entries[0]).toMatchObject({ uid: 0, gid: 0 });
  });

  it("parses octal mode without leading 0", () => {
    const entries = parseManifest("/tmp  d  755\n");
    expect(entries[0]).toMatchObject({ mode: 0o755 });
  });

  it("rejects unknown node types", () => {
    expect(() => parseManifest("/x  q  0644\n")).toThrow(/unknown type/);
  });

  it("rejects malformed fields", () => {
    expect(() => parseManifest("/x f 0644 0 0 bogus\n")).toThrow(/bad extra/);
  });

  it("reports line numbers on errors", () => {
    expect(() => parseManifest("\n\n/x  q  0644\n")).toThrow(/line 3/);
  });
});
