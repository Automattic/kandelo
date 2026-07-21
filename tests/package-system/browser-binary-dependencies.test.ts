import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  browserBinaryPackageRoots,
  firstTomlString,
  inspectBrowserBinaryDependencies,
  registryPackagesWithoutBuildToml,
} from "../../scripts/browser-binary-package-roots.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const registryRoot = join(repoRoot, "packages", "registry");
function registryPackageDirs(): string[] {
  return readdirSync(registryRoot)
    .map((name) => join(registryRoot, name))
    .filter((path) => statSync(path).isDirectory())
    .filter((path) => existsSync(join(path, "package.toml")));
}

describe("browser binary dependencies", () => {
  it("requires a build.toml sidecar for every fetchable registry package", () => {
    const missingBuildToml = registryPackageDirs()
      .filter((packageDir) => {
        const manifest = readFileSync(join(packageDir, "package.toml"), "utf8");
        const packageName = firstTomlString(manifest, "name");
        if (packageName && registryPackagesWithoutBuildToml.has(packageName)) {
          return false;
        }
        return !existsSync(join(packageDir, "build.toml"));
      })
      .map((packageDir) => relative(repoRoot, packageDir));

    expect(missingBuildToml).toEqual([]);
  });

  it("backs every browser @binaries import with a fetchable package output", () => {
    const { missingOwners, unfetchableOwners } =
      inspectBrowserBinaryDependencies(repoRoot);

    expect(missingOwners).toEqual([]);
    expect(unfetchableOwners).toEqual([]);
  });

  it("derives the exact package roots needed to bundle the browser app", () => {
    const audit = inspectBrowserBinaryDependencies(repoRoot);
    const roots = browserBinaryPackageRoots(repoRoot, {
      // The exact bottle-built archive is installed after registry fetching.
      excludePackages: ["shell"],
      // @rootfs-vfs is a Vite alias rather than an @binaries import.
      includePackages: ["rootfs"],
    });

    expect(roots).toEqual([...new Set(roots)].sort());
    expect(roots).toContain("rootfs");
    expect(roots).not.toContain("shell");
    expect(roots).toEqual(
      [...new Set([...audit.packageNames, "rootfs"])]
        .filter((name) => name !== "shell")
        .sort(),
    );
  });
});
