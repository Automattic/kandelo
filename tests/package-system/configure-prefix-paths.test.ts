import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A path autoconf derives from `--prefix` is the resolver's per-invocation
// staging directory. Compiled into a library it becomes two defects at once:
// the string names a host directory deleted at publication, and it differs
// between two builds of the same recipe, which fails the rebuild-receipt
// comparison and aborts the whole local build. Both libraries below are
// statically linked into foot, waybar and mako, so the leak reaches shipped
// binaries.

const repoRoot = resolve(import.meta.dirname, "../..");
const recipe = (name: string) =>
  readFileSync(
    join(repoRoot, "packages/registry", name, `build-${name}.sh`),
    "utf8",
  );

describe("configure paths compiled into the toolkit libraries", () => {
  it("fontconfig names its template directory as a guest path", () => {
    expect(recipe("fontconfig")).toContain(
      "--with-templatedir=/usr/share/fontconfig/conf.avail",
    );
  });

  it("fontconfig maps the staged source path out of its assert strings", () => {
    expect(recipe("fontconfig")).toContain(
      'CFLAGS="-O2 -ffile-prefix-map=$SRC_DIR=."',
    );
  });

  it("gdk-pixbuf names its locale directory as a guest path", () => {
    expect(recipe("gdk-pixbuf")).toContain("--localedir=/usr/share/locale");
  });
});
