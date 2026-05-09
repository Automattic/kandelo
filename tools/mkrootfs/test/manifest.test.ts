import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/manifest.ts";

describe("manifest parser — directories, files, symlinks, devices", () => {
  describe("directories", () => {
    it("parses a directory entry", () => {
      expect(parseManifest("/tmp  d  1777  0  0\n")).toEqual([
        { kind: "node", path: "/tmp", type: "d", mode: 0o1777, uid: 0, gid: 0 },
      ]);
    });

    it("parses a nested directory with non-zero uid/gid", () => {
      expect(parseManifest("/var/log  d  0755  100  200\n")).toEqual([
        { kind: "node", path: "/var/log", type: "d", mode: 0o755, uid: 100, gid: 200 },
      ]);
    });
  });

  describe("regular files", () => {
    it("parses a file entry without explicit src", () => {
      expect(parseManifest("/etc/passwd  f  0644  0  0\n")).toEqual([
        { kind: "node", path: "/etc/passwd", type: "f", mode: 0o644, uid: 0, gid: 0 },
      ]);
    });

    it("parses a file entry with src= override", () => {
      expect(parseManifest("/etc/foo  f  0644  0  0  src=configs/foo\n")).toEqual([
        { kind: "node", path: "/etc/foo", type: "f", mode: 0o644, uid: 0, gid: 0, src: "configs/foo" },
      ]);
    });
  });

  describe("symlinks", () => {
    it("parses a symlink with target=", () => {
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

    it("rejects a symlink missing target=", () => {
      expect(() => parseManifest("/etc/localtime  l  0777  0  0\n")).toThrow(/target=/);
    });

    it("rejects a symlink with empty target= value", () => {
      expect(() => parseManifest("/etc/localtime  l  0777  0  0  target=\n")).toThrow(
        /target.*empty|empty.*target/i,
      );
    });
  });

  describe("character devices", () => {
    it("parses a char device with major= minor=", () => {
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

    it("rejects a char device missing major=", () => {
      expect(() => parseManifest("/dev/null  c  0666  0  0  minor=3\n")).toThrow(/major=/);
    });

    it("rejects a char device missing minor=", () => {
      expect(() => parseManifest("/dev/null  c  0666  0  0  major=1\n")).toThrow(/minor=/);
    });
  });

  describe("block devices", () => {
    it("parses a block device with major= minor=", () => {
      expect(parseManifest("/dev/loop0  b  0660  0  0  major=7  minor=0\n")).toEqual([
        {
          kind: "node",
          path: "/dev/loop0",
          type: "b",
          mode: 0o660,
          uid: 0,
          gid: 0,
          major: 7,
          minor: 0,
        },
      ]);
    });

    it("rejects a block device missing major= and minor=", () => {
      expect(() => parseManifest("/dev/loop0  b  0660  0  0\n")).toThrow(/major=|minor=/);
    });
  });

  describe("comments and whitespace", () => {
    it("ignores blank lines", () => {
      expect(parseManifest("\n\n/tmp  d  1777  0  0\n\n")).toHaveLength(1);
    });

    it("ignores full-line comments", () => {
      expect(parseManifest("# this is a comment\n/tmp  d  1777  0  0\n")).toHaveLength(1);
    });

    it("ignores trailing comments after entries", () => {
      const entries = parseManifest("/tmp  d  1777  0  0  # trailing\n");
      expect(entries).toEqual([
        { kind: "node", path: "/tmp", type: "d", mode: 0o1777, uid: 0, gid: 0 },
      ]);
    });

    it("ignores comments with leading whitespace", () => {
      expect(parseManifest("   # indented comment\n/tmp  d  1777  0  0\n")).toHaveLength(1);
    });

    it("tolerates tabs and multiple spaces between fields", () => {
      const entries = parseManifest("/tmp\td\t1777\t0\t0\n");
      expect(entries[0]).toMatchObject({ path: "/tmp", type: "d", mode: 0o1777 });
    });

    it("preserves # inside extra values (symlink target with hash)", () => {
      const entries = parseManifest("/etc/foo  l  0644  0  0  target=/path/with#hash\n");
      expect(entries[0]).toMatchObject({ target: "/path/with#hash" });
    });

    it("strips full-line comments starting at column 0", () => {
      expect(parseManifest("# comment at start\n/tmp  d  1777  0  0\n")).toHaveLength(1);
    });

    it("strips indented full-line comments", () => {
      expect(parseManifest("  # indented comment\n/tmp  d  1777  0  0\n")).toHaveLength(1);
    });

    it("strips trailing comments preceded by whitespace", () => {
      const entries = parseManifest("/etc/foo  f  0644  0  0  # trailing comment\n");
      expect(entries[0]).toMatchObject({ path: "/etc/foo", type: "f" });
      expect(entries[0]).not.toHaveProperty("src");
    });

    it("preserves # inside src= value with no preceding whitespace", () => {
      const entries = parseManifest("/etc/foo  f  0644  0  0  src=foo#bar\n");
      expect(entries[0]).toMatchObject({ src: "foo#bar" });
    });
  });

  describe("uid/gid defaults", () => {
    it("defaults uid and gid to 0 when omitted", () => {
      expect(parseManifest("/tmp  d  1777\n")).toEqual([
        { kind: "node", path: "/tmp", type: "d", mode: 0o1777, uid: 0, gid: 0 },
      ]);
    });

    it("defaults gid to 0 when only uid given", () => {
      expect(parseManifest("/tmp  d  1777  42\n")).toEqual([
        { kind: "node", path: "/tmp", type: "d", mode: 0o1777, uid: 42, gid: 0 },
      ]);
    });
  });

  describe("mode parsing", () => {
    it("parses octal mode without leading 0", () => {
      expect(parseManifest("/tmp  d  755\n")[0]).toMatchObject({ mode: 0o755 });
    });

    it("parses octal mode with leading 0", () => {
      expect(parseManifest("/tmp  d  0755\n")[0]).toMatchObject({ mode: 0o755 });
    });

    it("rejects non-octal digits in mode", () => {
      expect(() => parseManifest("/tmp  d  0888\n")).toThrow(/line 1.*mode|invalid octal/);
    });

    it("rejects non-numeric mode", () => {
      expect(() => parseManifest("/tmp  d  abcd\n")).toThrow(/mode|invalid octal/);
    });
  });

  describe("error reporting", () => {
    it("reports 1-indexed line numbers", () => {
      expect(() => parseManifest("\n\n/x  q  0644\n")).toThrow(/line 3/);
    });

    it("reports unknown node types", () => {
      expect(() => parseManifest("/x  q  0644\n")).toThrow(/unknown type.*"q"/);
    });

    it("reports too few fields", () => {
      expect(() => parseManifest("/x  d\n")).toThrow(/line 1/);
    });

    it("reports unknown extra fields", () => {
      expect(() => parseManifest("/x  f  0644  0  0  bogus=value\n")).toThrow(/line 1.*bogus|unknown field/);
    });

    it("reports malformed extras (no = sign)", () => {
      expect(() => parseManifest("/x  f  0644  0  0  bogus\n")).toThrow(/line 1/);
    });

    it("rejects non-absolute paths", () => {
      expect(() => parseManifest("etc/passwd  f  0644  0  0\n")).toThrow(/absolute|path/);
    });

    it("includes sourcePath in errors when provided", () => {
      expect(() => parseManifest("/x  q  0644\n", "MANIFEST")).toThrow(/MANIFEST/);
    });

    it("reports invalid integer for uid", () => {
      expect(() => parseManifest("/x  d  0755  abc  0\n")).toThrow(/integer|invalid/);
    });
  });

  describe("archive directive (deferred to Task 2.3)", () => {
    it("rejects archive lines with a clear deferred-implementation message", () => {
      expect(() => parseManifest("archive  url=./vim.zip\n")).toThrow(
        /archive.*Task 2\.3|archive.*not.*implemented|archive.*deferred/i,
      );
    });
  });

  describe("multiple entries", () => {
    it("parses several entries on consecutive lines", () => {
      const text = [
        "# rootfs manifest",
        "/etc            d  0755  0  0",
        "/etc/passwd     f  0644  0  0",
        "/etc/localtime  l  0777  0  0  target=/usr/share/zoneinfo/UTC",
        "/dev/null       c  0666  0  0  major=1  minor=3",
        "",
      ].join("\n");
      const entries = parseManifest(text);
      expect(entries).toHaveLength(4);
      expect(entries.map((e) => (e as { path: string }).path)).toEqual([
        "/etc",
        "/etc/passwd",
        "/etc/localtime",
        "/dev/null",
      ]);
    });
  });
});
