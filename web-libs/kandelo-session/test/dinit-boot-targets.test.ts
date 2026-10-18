import { describe, expect, it } from "vitest";
import {
  readDinitBootTargets,
  type DinitBootTargetsFileSystem,
} from "../src/dinit-boot-targets";

const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;

function fixture(
  content: string | Uint8Array,
  opts: {
    missing?: boolean;
    mode?: number;
    size?: number;
  } = {},
): { fs: DinitBootTargetsFileSystem; state: { openCalls: number; closeCalls: number } } {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const state = { openCalls: 0, closeCalls: 0 };
  let cursor = 0;
  const fs: DinitBootTargetsFileSystem = {
    lstat(_path: string) {
      if (opts.missing) {
        const err = new Error("ENOENT: no such file or directory") as Error & { code?: string };
        err.code = "ENOENT";
        throw err;
      }
      return {
        mode: opts.mode ?? (S_IFREG | 0o644),
        size: opts.size ?? bytes.byteLength,
      };
    },
    open() {
      state.openCalls += 1;
      return 1;
    },
    read(_handle, buffer, _offset, length) {
      const count = Math.min(length, bytes.byteLength - cursor);
      if (count > 0) buffer.set(bytes.subarray(cursor, cursor + count));
      cursor += count;
      return count;
    },
    close() {
      state.closeCalls += 1;
    },
  };
  return { fs, state };
}

describe("readDinitBootTargets", () => {
  it("reads the depends-on closure from the target's dinit service file", () => {
    const { fs } = fixture(
      "type = internal\ndepends-on = php-fpm\ndepends-on = nginx\n",
    );
    expect(readDinitBootTargets(fs, "boot")).toEqual(["php-fpm", "nginx"]);
  });

  it("returns an empty list for a target with no dependencies", () => {
    const { fs } = fixture("type = process\ncommand = /usr/sbin/nginx\n");
    expect(readDinitBootTargets(fs, "nginx")).toEqual([]);
  });

  it("ignores comments, blank lines, and unrelated directives", () => {
    const { fs } = fixture(
      [
        "# aggregator",
        "type = internal",
        "",
        "  depends-on = mariadb  ",
        "restart = false",
        "depends-on = php-fpm",
      ].join("\n"),
    );
    expect(readDinitBootTargets(fs, "boot")).toEqual(["mariadb", "php-fpm"]);
  });

  it("fails loudly, naming the missing service, instead of hanging on a readiness probe that can never pass", () => {
    const { fs } = fixture("", { missing: true });
    expect(() => readDinitBootTargets(fs, "ruby-todo")).toThrow(
      'dinit boot target "ruby-todo" is missing: /etc/dinit.d/ruby-todo does not exist',
    );
  });

  it("rejects an oversized service file before opening it", () => {
    const { fs, state } = fixture("", { size: 65_537 });
    expect(() => readDinitBootTargets(fs, "boot")).toThrow("exceeds 65536 bytes");
    expect(state.openCalls).toBe(0);
  });

  it("rejects a non-regular dinit service node", () => {
    const { fs } = fixture("", { mode: S_IFDIR | 0o755 });
    expect(() => readDinitBootTargets(fs, "boot")).toThrow("must be a regular file");
  });

  it("rejects an incomplete read and still closes the file", () => {
    const { fs, state } = fixture("ab", { size: 3 });
    expect(() => readDinitBootTargets(fs, "boot")).toThrow(
      "could not be read completely",
    );
    expect(state.openCalls).toBe(1);
    expect(state.closeCalls).toBe(1);
  });

  it("rejects invalid UTF-8", () => {
    const { fs } = fixture(new Uint8Array([0xff]));
    expect(() => readDinitBootTargets(fs, "boot")).toThrow("is not valid UTF-8");
  });
});
