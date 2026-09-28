import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const supportablePosixUtilities = [
  "ar",
  "awk",
  "cal",
  "cflow",
  "cmp",
  "compress",
  "ctags",
  "cxref",
  "diff",
  "ed",
  "ex",
  "find",
  "fuser",
  "gencat",
  "getconf",
  "gettext",
  "iconv",
  "ipcrm",
  "ipcs",
  "lex",
  "locale",
  "logger",
  "man",
  "more",
  "msgfmt",
  "ngettext",
  "nm",
  "patch",
  "pax",
  "ps",
  "renice",
  "strings",
  "strip",
  "tabs",
  "tput",
  "uncompress",
  "uudecode",
  "uuencode",
  "what",
  "xargs",
  "xgettext",
  "yacc",
];

const existingPackageUtilities = new Set([
  "awk",
  "cflow",
  "cmp",
  "compress",
  "ctags",
  "diff",
  "ed",
  "ex",
  "find",
  "gencat",
  "getconf",
  "iconv",
  "lex",
  "locale",
  "man",
  "more",
  "patch",
  "pax",
  "tabs",
  "tput",
  "uncompress",
  "uudecode",
  "uuencode",
  "what",
  "xargs",
  "yacc",
]);

// Optional POSIX utilities Kandelo deliberately omits because no maintained
// implementation exists (see "Shell Utilities" in docs/posix-status.md).
const omittedOptionalUtilities = ["asa"];

function quotedValues(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("rootfs package composition", () => {
  it("maps every supportable missing POSIX utility into the root VFS", () => {
    const text = readFileSync(resolve(repoRoot, "images/rootfs/PACKAGES.toml"), "utf8");
    const installedPaths = new Set<string>();

    for (const match of text.matchAll(/^\s*path\s*=\s*"([^"]+)"/gm)) {
      installedPaths.add(match[1]);
    }
    for (const match of text.matchAll(/^\s*aliases\s*=\s*\[([^\]]*)\]/gms)) {
      for (const alias of quotedValues(match[1])) {
        installedPaths.add(alias);
      }
    }

    const missing = supportablePosixUtilities.filter((utility) => !installedPaths.has(`/usr/bin/${utility}`));
    expect(missing).toEqual([]);

    const omittedButInstalled = omittedOptionalUtilities.filter((utility) =>
      installedPaths.has(`/usr/bin/${utility}`)
    );
    expect(omittedButInstalled).toEqual([]);
  });

  it("declares posix-utils-lite outputs for every supportable utility not supplied by existing packages", () => {
    const rootfsPackage = readFileSync(resolve(repoRoot, "packages/registry/rootfs/package.toml"), "utf8");
    expect(rootfsPackage).toContain('"posix-utils-lite@0.1.0"');

    const litePackage = readFileSync(resolve(repoRoot, "packages/registry/posix-utils-lite/package.toml"), "utf8");
    const outputs = new Set([...litePackage.matchAll(/^\s*name\s*=\s*"([^"]+)"/gm)].map((match) => match[1]));
    outputs.delete("posix-utils-lite");

    const missing = supportablePosixUtilities
      .filter((utility) => !existingPackageUtilities.has(utility))
      .filter((utility) => !outputs.has(utility));

    expect(missing).toEqual([]);

    // A utility an upstream package now supplies must not also ship from
    // posix-utils-lite, or two packages would claim the same /usr/bin path.
    const duplicated = [...outputs].filter((utility) => existingPackageUtilities.has(utility));
    expect(duplicated).toEqual([]);
  });
});
