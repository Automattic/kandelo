import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SHELL_LAZY_ARCHIVE_SPECS } from "../../images/vfs/scripts/shell-lazy-archives";

// A `<pkg>-docs` package that vendors upstream manual pages must pin the
// exact source the `<pkg>` package builds from. Otherwise a version bump of
// the program leaves the shipped manual describing a different release, and
// nothing notices: the page still renders, it is just wrong.
//
// coreutils-docs and lsof-docs are excluded by construction: they carry no
// upstream archive (their pages come from the running binary and from an
// in-repository source), so they declare a repository source instead.

const repoRoot = resolve(import.meta.dirname, "../..");
const registry = join(repoRoot, "packages/registry");

function archiveIdentity(pkg: string): [string, string, string] | null {
  const manifest = join(registry, pkg, "package.toml");
  const result = spawnSync(
    "python3",
    [join(repoRoot, "scripts/package-source-metadata.py"), manifest],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const fields = result.stdout.split("\0").slice(0, 3);
  return fields.length === 3 ? (fields as [string, string, string]) : null;
}

// A docs package whose source rides in a package of another name. npm is
// node-browser-bundle's [source]; that package's version is the bundle's
// own, so only the source archive (URL and SHA-256) is compared, and the
// docs package's version must be the one in that URL.
const SOURCE_OWNERS: Record<string, string> = {
  "npm-docs": "node-browser-bundle",
};

const upstreamDocsPackages = readdirSync(registry)
  .filter((name) => name.endsWith("-docs"))
  .filter((name) =>
    /^provider = "archive"$/m.test(
      readFileSync(join(registry, name, "package.toml"), "utf8"),
    ),
  )
  .sort();

describe("upstream man-page packages", () => {
  it("exist", () => {
    expect(upstreamDocsPackages.length).toBeGreaterThan(0);
  });

  it.each(upstreamDocsPackages)(
    "%s pins the same version, source URL and SHA-256 as its program",
    (docs) => {
      const sourceOwner = SOURCE_OWNERS[docs];
      if (sourceOwner !== undefined) {
        const [version, url, sha256] = archiveIdentity(docs) ?? [];
        expect(archiveIdentity(sourceOwner)?.slice(1)).toEqual([url, sha256]);
        expect(url).toContain(`-${version}.`);
        return;
      }
      const owner = docs.slice(0, -"-docs".length);
      expect(existsSync(join(registry, owner, "package.toml"))).toBe(true);
      expect(archiveIdentity(docs)).toEqual(archiveIdentity(owner));
    },
  );

  it("man-index indexes exactly the shell's docs archives", () => {
    // The index must list every page the shell's docs packages ship and
    // nothing else, or apropos/whatis would miss pages or offer missing ones.
    const manifest = readFileSync(join(registry, "man-index", "package.toml"), "utf8");
    const dependsOn = /^depends_on = \[([^\]]*)\]/m.exec(manifest)?.[1] ?? "";
    const indexed = [...dependsOn.matchAll(/"([a-z0-9.-]+)@[^"]+"/g)].map((m) => m[1]).sort();
    const shellDocs = SHELL_LAZY_ARCHIVE_SPECS
      .filter((spec) => spec.id.endsWith("-docs"))
      .map((spec) => spec.dependency)
      .sort();
    expect(indexed).toEqual(shellDocs);
  });

  it.each(upstreamDocsPackages)("%s is a shell lazy archive", (docs) => {
    const spec = SHELL_LAZY_ARCHIVE_SPECS.find((s) => s.id === docs);
    expect(spec).toMatchObject({
      dependency: docs,
      resolverPath: `programs/wasm32/${docs}.zip`,
      mountPrefix: "/usr/",
    });
    expect(spec?.requiredMember).toMatch(/^share\/man\/man[1-9]\/[^/]+\.[1-9]$/);
  });
});
