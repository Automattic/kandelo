import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Two concurrent builds of one recipe must install the same bytes. The
// resolver compares the loser's receipt against the winner's and aborts the
// whole local build when they differ, so a package that bakes anything
// per-invocation into its output takes every downstream product with it.
// This is exactly how one ncurses build killed vim and every product behind
// it, hours into a local build, while the next run passed on the cached
// winner.

const repoRoot = resolve(import.meta.dirname, "../..");
const ncursesBuilder = join(
  repoRoot,
  "packages/registry/ncurses/build-ncurses.sh",
);

describe("ncurses package contract", () => {
  const source = readFileSync(ncursesBuilder, "utf8");

  it("pins deterministic ar flags so archives do not carry a build timestamp", () => {
    expect(source).toContain("export cf_cv_ar_flags='-curvD'");
  });

  it("drops the config script that reports the resolver's staging prefix", () => {
    expect(source).toContain('rm -f "$INSTALL_DIR/bin/ncursesw6-config"');
  });

  it("strips the staged source path out of the generated curses.h comment", () => {
    expect(source).toContain(
      'sed -i.bak "s|$SRC_DIR/include/|include/|g" "$INSTALL_DIR/include/ncursesw/curses.h"',
    );
  });
});
