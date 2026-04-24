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

  it("parses symlink with target=", () => {
    expect(parseManifest("/etc/localtime  l  0777  0  0  target=/usr/share/zoneinfo/UTC\n")).toEqual([
      {
        kind: "node",
        path: "/etc/localtime",
        type: "l",
        mode: 0o777,
        uid: 0,
        gid: 0,
        target: "/usr/share/zoneinfo/UTC",
      },
    ]);
  });

  it("parses char device with major= minor=", () => {
    expect(parseManifest("/dev/null  c  0666  0  0  major=1  minor=3\n")).toEqual([
      {
        kind: "node",
        path: "/dev/null",
        type: "c",
        mode: 0o666,
        uid: 0,
        gid: 0,
        major: 1,
        minor: 3,
      },
    ]);
  });

  it("parses block device", () => {
    const entries = parseManifest("/dev/loop0  b  0660  0  0  major=7  minor=0\n");
    expect(entries[0]).toMatchObject({ type: "b", major: 7, minor: 0 });
  });

  it("parses archive directive with base= and per-archive mode/owner", () => {
    expect(parseManifest("archive  url=./vim.zip  base=/usr  fmode=0644  dmode=0755\n")).toEqual([
      {
        kind: "archive",
        url: "./vim.zip",
        base: "/usr",
        fmode: 0o644,
        dmode: 0o755,
        uid: 0,
        gid: 0,
      },
    ]);
  });

  it("defaults archive base to / and modes when omitted", () => {
    expect(parseManifest("archive  url=./system.zip\n")).toEqual([
      {
        kind: "archive",
        url: "./system.zip",
        base: "/",
        fmode: 0o644,
        dmode: 0o755,
        uid: 0,
        gid: 0,
      },
    ]);
  });

  it("rejects archive without url=", () => {
    expect(() => parseManifest("archive  base=/usr\n")).toThrow(/archive requires url/);
  });

  it("rejects unknown archive fields", () => {
    expect(() => parseManifest("archive  url=./x.zip  foo=bar\n")).toThrow(/unknown archive field "foo"/);
  });

  it("archive-urls may contain = characters in the value", () => {
    expect(parseManifest("archive  url=./x.zip?v=1\n")[0]).toMatchObject({ url: "./x.zip?v=1" });
  });
});
