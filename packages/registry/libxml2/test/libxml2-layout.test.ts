import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Software written against libxml2 expects upstream's install layout:
// headers in <prefix>/include/libxml2/libxml/ and a pkg-config file whose
// Cflags point at <prefix>/include/libxml2. FFmpeg's configure, for one,
// probes `#include <libxml2/libxml/xmlversion.h>`.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

function libxml2Prefix(): string | null {
  const hostTarget = /host: (\S+)/.exec(
    spawnSync("rustc", ["-vV"], { encoding: "utf8" }).stdout ?? "",
  )?.[1];
  if (!hostTarget) return null;
  const r = spawnSync(
    "cargo",
    // `resolve` builds the package when it is not cached and prints its
    // prefix last, so the test never skips for want of a prior build.
    ["run", "-p", "xtask", "--target", hostTarget, "--quiet", "--", "build-deps", "resolve", "libxml2"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const path = r.stdout?.trim().split("\n").pop();
  return r.status === 0 && path && existsSync(path) ? path : null;
}

const prefix = libxml2Prefix();

describe.skipIf(!prefix)("libxml2 install layout", () => {
  it("installs headers under include/libxml2/libxml like upstream", () => {
    expect(existsSync(join(prefix!, "include/libxml2/libxml/xmlversion.h"))).toBe(true);
    expect(existsSync(join(prefix!, "include/libxml2/libxml/parser.h"))).toBe(true);
  });

  it("points pkg-config Cflags at include/libxml2", () => {
    const pc = readFileSync(join(prefix!, "lib/pkgconfig/libxml-2.0.pc"), "utf8");
    expect(pc).toMatch(/^Cflags: -I\$\{includedir\}\/libxml2$/m);
  });

  it("compiles both include spellings consumers use", () => {
    const dir = mkdtempSync(join(tmpdir(), "libxml2-layout-"));
    try {
      const src = join(dir, "t.c");
      writeFileSync(src,
        "#include <libxml/parser.h>\n#include <libxml2/libxml/xmlversion.h>\n" +
        "int main(void) { xmlCheckVersion(LIBXML_VERSION); return 0; }\n");
      const r = spawnSync("wasm32posix-cc", [
        "-fsyntax-only",
        `-I${join(prefix!, "include/libxml2")}`, // what pkg-config --cflags yields
        `-I${join(prefix!, "include")}`,         // the install prefix's include root
        src,
      ], { encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
