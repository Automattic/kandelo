import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packages = discoverVfsImagePackages();
const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

describe("package build input import closure", () => {
  it("maps source changes to every derived-image cache domain that uses them", () => {
    for (const changedPath of [
      "host/src/process.ts",
      "host/src/kernel-worker.ts",
    ]) {
      expect(packagesAffectedBy(changedPath)).toEqual(["lamp", "wordpress"]);
    }

    expect(packagesAffectedBy("host/src/vfs/memory-fs.ts")).toEqual(packages);

    expect(packagesAffectedBy("host/src/homebrew-bottle-relocation.ts"))
      .toEqual(packages);

    for (const changedPath of [
      "host/src/homebrew-runtime-layer-policy.ts",
      "host/src/homebrew-lazy-layer-descriptor.ts",
      "host/src/vfs/tar.ts",
    ]) {
      expect(packagesAffectedBy(changedPath)).toContain("shell");
    }
  });

  it("keeps materialized shell composition behind its candidate entrypoint", () => {
    const canonicalClosure = new Set(runtimeImportClosure(
      "images/vfs/scripts/build-homebrew-vfs-image.ts",
    ));
    const candidateClosure = new Set(runtimeImportClosure(
      "images/vfs/scripts/build-homebrew-materialized-vfs-image.ts",
    ));
    const composerClosure = runtimeImportClosure(
      "host/src/homebrew-vfs-composer.ts",
    );
    const candidateOwnedModules = [
      "host/src/homebrew-bottle-mirror-plan.ts",
      "host/src/homebrew-runtime-layer-consumer.ts",
      "host/src/homebrew-vfs-composer.ts",
      "host/src/homebrew-vfs-materialization-policy.ts",
      "host/src/vfs/closed-lazy-assets.ts",
    ];

    expect(
      candidateOwnedModules.filter((path) => canonicalClosure.has(path)),
    ).toEqual([]);
    expect(
      candidateOwnedModules.filter((path) => !candidateClosure.has(path)),
    ).toEqual([]);
    expect(
      composerClosure.filter((path) => !candidateClosure.has(path)),
    ).toEqual([]);
    expect(candidateClosure.has(
      "images/vfs/scripts/build-homebrew-vfs-image.ts",
    )).toBe(true);
  });

  for (const packageName of packages) {
    it(`${packageName} declares every repository-local relative import`, () => {
      const buildTomlPath = join(
        repoRoot,
        "packages",
        "registry",
        packageName,
        "build.toml",
      );
      const buildToml = readFileSync(buildTomlPath, "utf8");
      const declaredInputs = parseBuildInputs(buildToml);
      const declaredPaths = declaredInputs.map((input) => resolve(repoRoot, input));
      const scriptPath = buildToml.match(/^script_path\s*=\s*"([^"]+)"\s*$/m)?.[1];

      expect(declaredInputs.length).toBeGreaterThan(0);
      expect(declaredInputs).toEqual([...new Set(declaredInputs)]);
      expect(scriptPath, `${packageName} has no build script`).toBeDefined();
      expect(declaredInputs).toContain(scriptPath);
      for (const declaredPath of declaredPaths) {
        expect(
          existsSync(declaredPath),
          `${packageName} declares missing input ${relative(repoRoot, declaredPath)}`,
        ).toBe(true);
      }

      // Directories are recursive cache coverage boundaries. They are not all
      // execution roots: follow imports into them from the declared build
      // scripts instead of treating unrelated siblings as build dependencies.
      const sourceQueue = declaredPaths.filter(
        (inputPath) =>
          !lstatSync(inputPath).isDirectory() &&
          sourceExtensions.has(extname(inputPath)),
      );
      const inspected = new Set<string>();
      const missing = new Set<string>();

      while (sourceQueue.length > 0) {
        const sourcePath = sourceQueue.pop()!;
        if (inspected.has(sourcePath)) continue;
        inspected.add(sourcePath);

        for (const specifier of relativeImportSpecifiers(
          readFileSync(sourcePath, "utf8"),
        )) {
          const importedPath = resolveImport(sourcePath, specifier);
          expect(
            importedPath,
            `${relative(repoRoot, sourcePath)} has unresolved import ${specifier}`,
          ).not.toBeNull();
          if (importedPath === null) continue;

          expect(
            isWithin(repoRoot, importedPath),
            `${relative(repoRoot, sourcePath)} imports outside the repository: ${specifier}`,
          ).toBe(true);

          if (!declaredPaths.some((declaredPath) => covers(declaredPath, importedPath))) {
            missing.add(
              `${relative(repoRoot, importedPath)} (imported by ${relative(repoRoot, sourcePath)})`,
            );
          }
          if (sourceExtensions.has(extname(importedPath))) sourceQueue.push(importedPath);
        }
      }

      expect([...missing].sort()).toEqual([]);
    });
  }

  it("makes every MariaDB VFS input deterministic", () => {
    for (const [packageName, builderPath, minimumRevision] of [
      ["mariadb-test", "images/vfs/scripts/build-mariadb-test-vfs-image.ts", 4],
      ["mariadb-vfs", "images/vfs/scripts/build-mariadb-vfs-image.ts", 5],
    ] as const) {
      const manifest = readFileSync(
        join(repoRoot, "packages", "registry", packageName, "package.toml"),
        "utf8",
      );
      const buildToml = readFileSync(
        join(repoRoot, "packages", "registry", packageName, "build.toml"),
        "utf8",
      );
      const builder = readFileSync(join(repoRoot, builderPath), "utf8");
      const revision = Number(buildToml.match(/^revision\s*=\s*(\d+)\s*$/m)?.[1]);

      expect(manifest).toMatch(
        /^depends_on\s*=\s*\[[\s\S]*?"coreutils@9\.6"[\s\S]*?\]/m,
      );
      expect(revision).toBeGreaterThanOrEqual(minimumRevision);
      expect(builder).toContain(
        'const COREUTILS_PATH = resolveBinary("programs/coreutils.wasm")',
      );
      expect(builder).not.toContain(
        'tryResolveBinary("programs/coreutils.wasm")',
      );
    }
  });
});

function packagesAffectedBy(changedPath: string): string[] {
  const absoluteChangedPath = resolve(repoRoot, changedPath);
  return packages
    .filter((packageName) => {
      const buildTomlPath = join(
        repoRoot,
        "packages",
        "registry",
        packageName,
        "build.toml",
      );
      const declaredPaths = parseBuildInputs(
        readFileSync(buildTomlPath, "utf8"),
      ).map((input) => resolve(repoRoot, input));
      return declaredPaths.some((declaredPath) =>
        covers(declaredPath, absoluteChangedPath)
      );
    })
    .sort();
}

function discoverVfsImagePackages(): string[] {
  const registryRoot = join(repoRoot, "packages", "registry");
  return readdirSync(registryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((packageName) => {
      const manifestPath = join(registryRoot, packageName, "package.toml");
      if (!existsSync(manifestPath)) return false;
      const manifest = readFileSync(manifestPath, "utf8");
      return manifest
        .split(/^\s*\[\[outputs\]\]\s*$/m)
        .slice(1)
        .some((block) =>
          /^\s*wasm\s*=\s*"[^"]+\.vfs(?:\.zst)?"\s*(?:#.*)?$/m.test(block)
        );
    })
    .sort();
}

function runtimeImportClosure(entryPath: string): string[] {
  const queue = [resolve(repoRoot, entryPath)];
  const inspected = new Set<string>();

  while (queue.length > 0) {
    const sourcePath = queue.pop()!;
    if (inspected.has(sourcePath)) continue;
    if (!isWithin(repoRoot, sourcePath)) {
      throw new Error(`runtime import escaped the repository: ${sourcePath}`);
    }
    inspected.add(sourcePath);

    for (const specifier of relativeImportSpecifiers(
      readFileSync(sourcePath, "utf8"),
    )) {
      const importedPath = resolveImport(sourcePath, specifier);
      if (importedPath === null) {
        throw new Error(
          `${relative(repoRoot, sourcePath)} has unresolved import ${specifier}`,
        );
      }
      if (sourceExtensions.has(extname(importedPath))) queue.push(importedPath);
    }
  }

  return [...inspected]
    .map((path) => relative(repoRoot, path))
    .sort();
}

function parseBuildInputs(buildToml: string): string[] {
  const lines = buildToml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^inputs\s*=\s*\[\s*$/.test(line));
  if (start < 0) throw new Error("build.toml has no multiline inputs array");

  const inputs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\]\s*$/.test(line)) return inputs;
    const match = line.match(/^\s*"([^"]+)"\s*,?\s*(?:#.*)?$/);
    if (match) inputs.push(match[1]);
  }
  throw new Error("build.toml inputs array is not terminated");
}

function relativeImportSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  // The image builders run through tsx, which strips type-only imports. Those
  // declarations cannot change the generated image bytes and are therefore
  // outside the executable import closure. Mixed imports remain runtime
  // inputs. A package may still declare a schema-only module explicitly when
  // that authored contract belongs in its provenance, as shell does for the
  // deferred-layer descriptor.
  const runtimeSource = source.replace(
    /\b(?:import|export)\s+type\b[^;]*?\bfrom\s*["'][^"']+["']\s*;?/gs,
    "",
  );
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'();]*?\s+from\s*)?["'](\.[^"']*)["']/gs,
    /\bimport\s*\(\s*["'](\.[^"']*)["']\s*\)/g,
    /\brequire(?:\.resolve)?\s*\(\s*["'](\.[^"']*)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of runtimeSource.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

function resolveImport(sourcePath: string, rawSpecifier: string): string | null {
  const specifier = rawSpecifier.replace(/[?#].*$/, "");
  const unresolved = resolve(dirname(sourcePath), specifier);
  const extension = extname(unresolved);
  const candidates = [unresolved];

  if (extension === ".js") {
    candidates.push(
      unresolved.slice(0, -3) + ".ts",
      unresolved.slice(0, -3) + ".tsx",
    );
  } else if (extension === ".mjs") {
    candidates.push(unresolved.slice(0, -4) + ".mts");
  } else if (extension === ".cjs") {
    candidates.push(unresolved.slice(0, -4) + ".cts");
  } else if (extension === "") {
    for (const sourceExtension of sourceExtensions) {
      candidates.push(unresolved + sourceExtension);
      candidates.push(join(unresolved, `index${sourceExtension}`));
    }
    candidates.push(unresolved + ".json");
  }

  return candidates.find(
    (candidate) => existsSync(candidate) && !lstatSync(candidate).isDirectory(),
  ) ?? null;
}

function covers(declaredPath: string, importedPath: string): boolean {
  if (declaredPath === importedPath) return true;
  return lstatSync(declaredPath).isDirectory() && isWithin(declaredPath, importedPath);
}

function isWithin(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === "" || (
    !isAbsolute(childRelative) &&
    childRelative !== ".." &&
    !childRelative.startsWith(`..${sep}`)
  );
}
