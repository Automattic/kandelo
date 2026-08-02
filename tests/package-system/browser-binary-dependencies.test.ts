import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  browserBinariesImports,
  browserBinaryPackageRoots,
  browserRequiredBinariesImports,
  browserRequiredInputs,
  configuredProgramRegistryRoots,
  firstTomlString,
  inspectBrowserBinaryDependencies,
  packageOutputOwners,
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

interface ContextRegistryEntry {
  manifest: string;
  cacheKeys: { wasm32: string; wasm64: string };
  projection?: {
    dependencyClosures: Record<string, Array<{
      packageName: string;
      manifestSha256: string;
      cacheKey: string;
    }>>;
    mirrorPath: string;
  };
}

function contextDependencyIdentity(
  packageName: string,
  manifest: string,
  cacheKey: string,
) {
  return {
    packageName,
    manifestSha256: createHash("sha256").update(manifest).digest("hex"),
    cacheKey,
  };
}

function writeContextRegistry(
  root: string,
  entries: Record<string, ContextRegistryEntry>,
  contextualEntries: Record<string, ContextRegistryEntry> = {},
): void {
  const identities: Record<string, unknown> = {};
  const packages: Record<string, unknown> = {};
  const addProjection = (
    packageName: string,
    entry: ContextRegistryEntry,
  ) => {
    const manifestSha256 = createHash("sha256")
      .update(entry.manifest)
      .digest("hex");
    identities[packageName] = {
      manifestSha256,
      cacheKeys: entry.cacheKeys,
    };
    if (entry.projection) {
      packages[packageName] = {
        manifestSha256,
        arches: ["wasm32"],
        cacheKeys: { wasm32: entry.cacheKeys.wasm32 },
        dependencyClosures: entry.projection.dependencyClosures,
        members: [{
          kind: "output",
          sourceArtifact: entry.projection.mirrorPath,
          mirrorPath: entry.projection.mirrorPath,
          outputName: entry.projection.mirrorPath.replace(/\.wasm$/, ""),
          forkInstrumentation: "auto",
        }],
      };
    }
  };
  for (const [packageName, entry] of Object.entries(contextualEntries)) {
    addProjection(packageName, entry);
  }
  for (const [packageName, entry] of Object.entries(entries)) {
    const packageDir = join(root, packageName);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.toml"), entry.manifest);
    writeFileSync(join(packageDir, "build.toml"), "revision = 1\n");
    addProjection(packageName, entry);
  }
  writeFileSync(
    join(root, "program-packages.json"),
    `${JSON.stringify({
      format: "kandelo-program-packages-v2",
      identities,
      packages,
    }, null, 2)}\n`,
  );
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

  it("gives every locally mirrored composite VFS image a declared package owner", () => {
    const imageScriptsRoot = join(repoRoot, "images", "vfs", "scripts");
    const installers = readdirSync(imageScriptsRoot)
      // These wrappers create complete VFS package outputs. Archive helpers
      // such as build-nethack-zip.sh mirror a declared member of an existing
      // package instead, so their variable-based calls belong to that package's
      // ordinary multi-file generation contract rather than this ownership
      // audit.
      .filter((name) => name.endsWith("-vfs-image.sh"))
      .flatMap((name) => {
        const scriptPath = join(imageScriptsRoot, name);
        return readFileSync(scriptPath, "utf8")
          .split("\n")
          .filter((line) => /^\s*install_local_binary\s+/.test(line))
          .map((line) => {
            const match = line.match(
              /^\s*install_local_binary\s+([a-z0-9][a-z0-9+._-]*)\s+"[^"]*\/([^/"']+\.vfs\.zst)"\s*$/,
            );
            if (!match) {
              throw new Error(
                `composite VFS installer must name its package and source artifact literally: ${scriptPath}: ${line.trim()}`,
              );
            }
            return {
              packageName: match[1]!,
              sourceArtifact: match[2]!,
              scriptPath,
            };
          });
      });
    expect(installers.length).toBeGreaterThan(0);

    const projection = JSON.parse(
      readFileSync(join(registryRoot, "program-packages.json"), "utf8"),
    ) as {
      packages: Record<string, {
        members: Array<{
          kind: string;
          sourceArtifact: string;
          mirrorPath: string;
          forkInstrumentation?: string;
        }>;
      }>;
    };

    for (const { packageName, sourceArtifact } of installers) {
      expect(existsSync(join(registryRoot, packageName, "package.toml"))).toBe(true);
      expect(existsSync(join(registryRoot, packageName, "build.toml"))).toBe(true);
      expect(projection.packages[packageName]?.members).toEqual([
        expect.objectContaining({
          kind: "output",
          sourceArtifact,
          mirrorPath: `${packageName}.vfs.zst`,
          forkInstrumentation: "disabled",
        }),
      ]);
    }
  });

  it("backs every browser @binaries import with a fetchable package output", () => {
    const { missingOwners, unfetchableOwners } =
      inspectBrowserBinaryDependencies(repoRoot);

    expect(missingOwners).toEqual([]);
    expect(unfetchableOwners).toEqual([]);
  });

  it("discovers syntax-level imports without treating generated source strings as imports", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-browser-imports-"));
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      mkdirSync(browserRoot, { recursive: true });
      writeFileSync(
        join(browserRoot, "imports.ts"),
        [
          "const generated = `import ignored from \"@binaries/programs/ignored.wasm?url\";`;",
          "import actual from \"@binaries/programs/actual.wasm?url\";",
          "const dynamic = import(\"@binaries/programs/dynamic.wasm?url\");",
          "const optional = import.meta.glob(\"../../binaries/programs/optional.vfs.zst\", { query: \"?url\", import: \"default\" });",
          "const local = import.meta.glob([\"../../local-binaries/programs/local.vfs.zst\"], { query: \"?url\", import: \"default\" });",
          "const unrelated = import.meta.glob(\"./ordinary-module.ts\");",
          "void generated; void actual; void dynamic; void optional; void local; void unrelated;",
        ].join("\n"),
      );
      expect(browserBinariesImports(fixtureRoot)).toEqual([
        "programs/wasm32/actual.wasm",
        "programs/wasm32/dynamic.wasm",
        "programs/wasm32/local.vfs.zst",
        "programs/wasm32/optional.vfs.zst",
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("derives required binaries from the reachable product graph", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-browser-required-"));
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      mkdirSync(join(browserRoot, "product"), { recursive: true });
      mkdirSync(join(fixtureRoot, "binaries", "programs"), {
        recursive: true,
      });
      writeFileSync(
        join(browserRoot, "entry.ts"),
        [
          'import "./product/required";',
          'void import("./product/dynamic.ts");',
        ].join("\n"),
      );
      writeFileSync(
        join(browserRoot, "product", "required.ts"),
        [
          'import direct from "@binaries/programs/direct.wasm?url";',
          'import nested from "./nested";',
          "void direct; void nested;",
        ].join("\n"),
      );
      writeFileSync(
        join(browserRoot, "product", "nested.ts"),
        [
          'import nested from "../../../binaries/programs/nested.wasm?url";',
          "export default nested;",
        ].join("\n"),
      );
      writeFileSync(
        join(browserRoot, "product", "dynamic.ts"),
        [
          'import dynamic from "@binaries/programs/wasm64/dynamic.wasm?url";',
          "void dynamic;",
        ].join("\n"),
      );
      writeFileSync(
        join(browserRoot, "unreachable.ts"),
        'import unused from "@binaries/programs/unreachable.wasm?url";\nvoid unused;\n',
      );

      expect(
        browserRequiredBinariesImports(fixtureRoot, ["entry.ts"]),
      ).toEqual([
        "programs/wasm32/direct.wasm",
        "programs/wasm32/nested.wasm",
        "programs/wasm64/dynamic.wasm",
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("follows the real repository alias and TypeScript .js substitution", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-browser-alias-"));
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      const hostRoot = join(fixtureRoot, "host", "src");
      mkdirSync(browserRoot, { recursive: true });
      mkdirSync(hostRoot, { recursive: true });
      writeFileSync(
        join(browserRoot, "package.json"),
        JSON.stringify({
          dependencies: {
            react: "1.0.0",
            "@scope/external": "1.0.0",
          },
        }),
      );
      writeFileSync(
        join(browserRoot, "entry.ts"),
        [
          'import React from "react";',
          'import external from "@scope/external/subpath";',
          'import feature from "@host/feature.js";',
          "void React; void external; void feature;",
        ].join("\n"),
      );
      writeFileSync(
        join(hostRoot, "feature.ts"),
        [
          'import feature from "@binaries/programs/feature.wasm?url";',
          "export default feature;",
        ].join("\n"),
      );

      expect(
        browserRequiredBinariesImports(fixtureRoot, ["entry.ts"]),
      ).toEqual(["programs/wasm32/feature.wasm"]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects unknown repository aliases and undeclared packages", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-browser-unknown-"));
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      mkdirSync(browserRoot, { recursive: true });
      writeFileSync(
        join(browserRoot, "package.json"),
        JSON.stringify({ dependencies: { react: "1.0.0" } }),
      );
      writeFileSync(
        join(browserRoot, "entry.ts"),
        'import value from "@unknown/internal";\nvoid value;\n',
      );
      expect(() =>
        browserRequiredBinariesImports(fixtureRoot, ["entry.ts"])
      ).toThrow(/unknown package or repository alias @unknown\/internal/);

      writeFileSync(
        join(browserRoot, "entry.ts"),
        'import value from "undeclared-package";\nvoid value;\n',
      );
      expect(() =>
        browserRequiredBinariesImports(fixtureRoot, ["entry.ts"])
      ).toThrow(/unknown package or repository alias undeclared-package/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("derives JavaScript entries from the selected HTML files", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-browser-html-"));
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      mkdirSync(browserRoot, { recursive: true });
      writeFileSync(
        join(browserRoot, "entry-a.ts"),
        'import value from "@binaries/programs/a.wasm?url";\nvoid value;\n',
      );
      writeFileSync(
        join(browserRoot, "entry-b.ts"),
        'import value from "@binaries/programs/b.wasm?url";\nvoid value;\n',
      );
      const html = join(browserRoot, "index.html");
      writeFileSync(
        html,
        '<script type="module" src="./entry-a.ts"></script>\n',
      );
      expect(browserRequiredInputs(fixtureRoot, {
        htmlEntryFiles: ["index.html"],
      }).imports).toEqual(["programs/wasm32/a.wasm"]);

      // The HTML file, not a duplicated workflow path, owns the Vite entry.
      writeFileSync(
        html,
        '<script type="module" src="./entry-b.ts"></script>\n',
      );
      expect(browserRequiredInputs(fixtureRoot, {
        htmlEntryFiles: ["index.html"],
      }).imports).toEqual(["programs/wasm32/b.wasm"]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("reports virtual artifact modules as separately bound capabilities", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-browser-capability-"));
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      mkdirSync(browserRoot, { recursive: true });
      writeFileSync(
        join(browserRoot, "entry.ts"),
        [
          'import kernel from "@kernel-wasm?url";',
          'import rootfs from "@rootfs-vfs?url";',
          "void kernel; void rootfs;",
        ].join("\n"),
      );

      expect(browserRequiredInputs(fixtureRoot, {
        entryFiles: ["entry.ts"],
      })).toEqual({
        imports: [],
        capabilities: ["kernel-wasm", "rootfs-vfs"],
      });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails closed across entry, alias, HTML, and source symlink escapes", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-browser-escape-"));
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      const hostRoot = join(fixtureRoot, "host", "src");
      mkdirSync(browserRoot, { recursive: true });
      mkdirSync(hostRoot, { recursive: true });
      writeFileSync(join(fixtureRoot, "outside.ts"), "export default 1;\n");
      writeFileSync(
        join(browserRoot, "entry.ts"),
        'import value from "@host/../../outside.ts";\nvoid value;\n',
      );
      expect(() =>
        browserRequiredBinariesImports(fixtureRoot, ["entry.ts"])
      ).toThrow(/alias import escapes @host/);
      expect(() =>
        browserRequiredBinariesImports(fixtureRoot, ["../../../outside.ts"])
      ).toThrow(/entry escapes the app/);

      writeFileSync(
        join(browserRoot, "index.html"),
        '<script type="module" src="../../../outside.ts"></script>\n',
      );
      expect(() => browserRequiredInputs(fixtureRoot, {
        htmlEntryFiles: ["index.html"],
      })).toThrow(/HTML module escapes the app/);

      symlinkSync(join(fixtureRoot, "outside.ts"), join(browserRoot, "linked.ts"));
      expect(() =>
        browserRequiredBinariesImports(fixtureRoot, ["linked.ts"])
      ).toThrow(/source module is a symlink/);

      writeFileSync(
        join(browserRoot, "entry.ts"),
        'import value from "./linked.ts";\nvoid value;\n',
      );
      expect(() =>
        browserRequiredBinariesImports(fixtureRoot, ["entry.ts"])
      ).toThrow(/source module is a symlink/);

      symlinkSync(join(browserRoot, "index.html"), join(browserRoot, "linked.html"));
      expect(() => browserRequiredInputs(fixtureRoot, {
        htmlEntryFiles: ["linked.html"],
      })).toThrow(/HTML entry is not a regular file/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps reachable optional gallery globs out of required materialization", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-browser-glob-"));
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      mkdirSync(browserRoot, { recursive: true });
      writeFileSync(
        join(browserRoot, "entry.ts"),
        [
          'import required from "@binaries/programs/required.wasm?url";',
          'const optional = import.meta.glob("../../binaries/programs/optional.vfs.zst", { query: "?url", import: "default" });',
          "void required; void optional;",
        ].join("\n"),
      );
      writeFileSync(
        join(browserRoot, "unreachable.ts"),
        'import unused from "@binaries/programs/unreachable.wasm?url";\nvoid unused;\n',
      );

      expect(
        browserRequiredBinariesImports(fixtureRoot, ["entry.ts"]),
      ).toEqual(["programs/wasm32/required.wasm"]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when a reachable source glob cannot be projected", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-browser-source-glob-"));
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      mkdirSync(browserRoot, { recursive: true });
      writeFileSync(
        join(browserRoot, "entry.ts"),
        'const modules = import.meta.glob("./plugins/*.ts");\nvoid modules;\n',
      );

      expect(() =>
        browserRequiredBinariesImports(fixtureRoot, ["entry.ts"])
      ).toThrow(/unsupported source glob/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not derive commit-bound browser imports through source symlinks", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-browser-symlink-"));
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      const ambientSource = join(fixtureRoot, "ambient.ts");
      mkdirSync(browserRoot, { recursive: true });
      writeFileSync(
        ambientSource,
        'import binary from "@binaries/programs/wasm32/ambient.wasm?url";\nvoid binary;\n',
      );
      symlinkSync(ambientSource, join(browserRoot, "linked.ts"));

      expect(() => browserBinariesImports(fixtureRoot)).toThrow(
        /browser source tree contains a symlink/,
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("uses repo-anchored external registries with first-hit browser ownership", () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), "kandelo-browser-external-registry-"),
    );
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      const externalRoot = join(fixtureRoot, "third-party", "registry");
      const fallbackRoot = join(fixtureRoot, "packages", "registry");
      const packageName = "external-runtime";
      const manifest = (version: string) => `kind = "program"
name = "${packageName}"
version = "${version}"
depends_on = []
[source]
url = "https://example.test/${packageName}-${version}.tar.gz"
sha256 = "${"0".repeat(64)}"
[license]
spdx = "MIT"
[[outputs]]
name = "${version === "external" ? "external-command" : "fallback-command"}"
wasm = "${version}.wasm"
`;
      const writeRegistryPackage = (
        root: string,
        version: string,
        mirrorPath: string,
      ) => {
        const packageDir = join(root, packageName);
        mkdirSync(packageDir, { recursive: true });
        const text = manifest(version);
        writeFileSync(join(packageDir, "package.toml"), text);
        writeFileSync(join(packageDir, "build.toml"), 'revision = 1\n');
        writeFileSync(
          join(root, "program-packages.json"),
          `${JSON.stringify({
            format: "kandelo-program-packages-v2",
            identities: {
              [packageName]: {
                manifestSha256: createHash("sha256").update(text).digest("hex"),
                cacheKeys: {
                  wasm32: "a".repeat(64),
                  wasm64: "b".repeat(64),
                },
              },
            },
            packages: {
              [packageName]: {
                manifestSha256: createHash("sha256").update(text).digest("hex"),
                arches: ["wasm32"],
                cacheKeys: { wasm32: "a".repeat(64) },
                dependencyClosures: { wasm32: [] },
                members: [{
                  kind: "output",
                  sourceArtifact: `${version}.wasm`,
                  mirrorPath,
                  outputName: mirrorPath.replace(/\.wasm$/, ""),
                  forkInstrumentation: "auto",
                }],
              },
            },
          }, null, 2)}\n`,
        );
      };
      mkdirSync(browserRoot, { recursive: true });
      writeFileSync(
        join(browserRoot, "entry.ts"),
        'import binary from "@binaries/programs/wasm32/external-command.wasm?url";\nvoid binary;\n',
      );
      writeRegistryPackage(externalRoot, "external", "external-command.wasm");
      writeRegistryPackage(fallbackRoot, "fallback", "fallback-command.wasm");
      const registryPath = "third-party/registry:packages/registry";

      expect(configuredProgramRegistryRoots(fixtureRoot, registryPath)).toEqual([
        externalRoot,
        fallbackRoot,
      ]);
      const audit = inspectBrowserBinaryDependencies(fixtureRoot, {
        registryPath,
      });
      expect(audit.missingOwners).toEqual([]);
      expect(audit.unfetchableOwners).toEqual([]);
      expect(audit.packageNames).toEqual([packageName]);
      const owners = packageOutputOwners(fixtureRoot, { registryPath });
      expect(owners.get("programs/wasm32/external-command.wasm")).toMatchObject({
        packageName,
        hasBuildToml: true,
      });
      expect(owners.has("programs/wasm32/fallback-command.wasm")).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("does not expose a lower program when a higher non-program package owns its name", () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), "kandelo-browser-non-program-shadow-"),
    );
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      const upperRoot = join(fixtureRoot, "external");
      const lowerRoot = join(fixtureRoot, "main");
      const packageName = "shadowed-program";
      const outputPath = "shadowed-command.wasm";
      const upperManifest =
        `kind = "library"\nname = "${packageName}"\nversion = "2.0.0"\n`;
      const lowerManifest =
        `kind = "program"\nname = "${packageName}"\nversion = "1.0.0"\n`;
      writeContextRegistry(upperRoot, {
        [packageName]: {
          manifest: upperManifest,
          cacheKeys: {
            wasm32: "1".repeat(64),
            wasm64: "2".repeat(64),
          },
        },
      });
      writeContextRegistry(lowerRoot, {
        [packageName]: {
          manifest: lowerManifest,
          cacheKeys: {
            wasm32: "3".repeat(64),
            wasm64: "4".repeat(64),
          },
          projection: {
            dependencyClosures: { wasm32: [] },
            mirrorPath: outputPath,
          },
        },
      });
      mkdirSync(browserRoot, { recursive: true });
      writeFileSync(
        join(browserRoot, "entry.ts"),
        `import command from "@binaries/programs/wasm32/${outputPath}?url";\nvoid command;\n`,
      );

      const audit = inspectBrowserBinaryDependencies(fixtureRoot, {
        registryPath: "external:main",
      });
      expect(audit.missingOwners).toEqual([
        `programs/wasm32/${outputPath}`,
      ]);
      expect(() =>
        browserBinaryPackageRoots(fixtureRoot, {
          arch: "wasm32",
          registryPath: "external:main",
        })
      ).toThrow(/browser @binaries imports without registry owners/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("accepts identical first-hit identities and order-insensitive external dependency closures", () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), "kandelo-browser-context-safe-"),
    );
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      const upperRoot = join(fixtureRoot, "external");
      const lowerRoot = join(fixtureRoot, "main");
      const sharedName = "z-shared-dependency";
      const auxiliaryName = "a-auxiliary-dependency";
      const externalName = "external-context-program";
      const lowerName = "lower-context-program";
      const sharedManifest =
        `kind = "library"\nname = "${sharedName}"\nversion = "1.0.0"\n`;
      const auxiliaryManifest =
        `kind = "source"\nname = "${auxiliaryName}"\nversion = "1.0.0"\n`;
      const externalManifest =
        `kind = "program"\nname = "${externalName}"\nversion = "1.0.0"\n`;
      const lowerManifest =
        `kind = "program"\nname = "${lowerName}"\nversion = "1.0.0"\n`;
      const sharedKeys = {
        wasm32: "1".repeat(64),
        wasm64: "2".repeat(64),
      };
      const auxiliaryKeys = {
        wasm32: "3".repeat(64),
        wasm64: "3".repeat(64),
      };
      const sharedIdentity = contextDependencyIdentity(
        sharedName,
        sharedManifest,
        sharedKeys.wasm32,
      );
      const auxiliaryIdentity = contextDependencyIdentity(
        auxiliaryName,
        auxiliaryManifest,
        auxiliaryKeys.wasm32,
      );
      writeContextRegistry(
        upperRoot,
        {
          [sharedName]: { manifest: sharedManifest, cacheKeys: sharedKeys },
          [auxiliaryName]: {
            manifest: auxiliaryManifest,
            cacheKeys: auxiliaryKeys,
          },
          [externalName]: {
            manifest: externalManifest,
            cacheKeys: {
              wasm32: "4".repeat(64),
              wasm64: "5".repeat(64),
            },
            projection: {
              // Deliberately reverse lexical order: closure order is not policy.
              dependencyClosures: {
                wasm32: [sharedIdentity, auxiliaryIdentity],
              },
              mirrorPath: "external-context.wasm",
            },
          },
        },
        {
          [lowerName]: {
            manifest: lowerManifest,
            cacheKeys: {
              wasm32: "6".repeat(64),
              wasm64: "7".repeat(64),
            },
            projection: {
              dependencyClosures: { wasm32: [sharedIdentity] },
              mirrorPath: "lower-context.wasm",
            },
          },
        },
      );
      writeContextRegistry(lowerRoot, {
        [sharedName]: { manifest: sharedManifest, cacheKeys: sharedKeys },
        [lowerName]: {
          manifest: lowerManifest,
          cacheKeys: {
            wasm32: "6".repeat(64),
            wasm64: "7".repeat(64),
          },
          projection: {
            dependencyClosures: { wasm32: [sharedIdentity] },
            mirrorPath: "lower-context.wasm",
          },
        },
      });
      mkdirSync(browserRoot, { recursive: true });
      writeFileSync(
        join(browserRoot, "entry.ts"),
        [
          'import external from "@binaries/programs/wasm32/external-context.wasm?url";',
          'import lower from "@binaries/programs/wasm32/lower-context.wasm?url";',
          "void external; void lower;",
        ].join("\n"),
      );
      const registryPath = "external:main";

      const audit = inspectBrowserBinaryDependencies(fixtureRoot, {
        registryPath,
      });
      expect(audit.missingOwners).toEqual([]);
      expect(audit.unfetchableOwners).toEqual([]);
      expect(audit.packageNames).toEqual([externalName, lowerName]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("accepts an external browser program generated against a changed transitive external:main context", () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), "kandelo-browser-external-transitive-"),
    );
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      const upperRoot = join(fixtureRoot, "external");
      const lowerRoot = join(fixtureRoot, "main");
      const leafName = "external-transitive-leaf";
      const middleName = "external-transitive-middle";
      const externalName = "external-transitive-program";
      const lowerLeafManifest =
        `kind = "source"
name = "${leafName}"
version = "1.0.0"
depends_on = []
[source]
url = "https://example.test/${leafName}.tar.gz"
sha256 = "${"0".repeat(64)}"
[license]
spdx = "MIT"
`;
      const upperLeafManifest = lowerLeafManifest.replace(
        "0".repeat(64),
        "1".repeat(64),
      );
      const middleManifest =
        `kind = "library"\nname = "${middleName}"\nversion = "1.0.0"\ndepends_on = ["${leafName}@1.0.0"]\n`;
      const externalManifest =
        `kind = "program"\nname = "${externalName}"\nversion = "1.0.0"\ndepends_on = ["${middleName}@1.0.0"]\n`;
      const upperLeafKeys = {
        wasm32: "1".repeat(64),
        wasm64: "2".repeat(64),
      };
      const combinedMiddleKeys = {
        wasm32: "3".repeat(64),
        wasm64: "4".repeat(64),
      };
      writeContextRegistry(
        upperRoot,
        {
          [leafName]: {
            manifest: upperLeafManifest,
            cacheKeys: upperLeafKeys,
          },
          [externalName]: {
            manifest: externalManifest,
            cacheKeys: {
              wasm32: "5".repeat(64),
              wasm64: "6".repeat(64),
            },
            projection: {
              dependencyClosures: {
                wasm32: [
                  contextDependencyIdentity(
                    leafName,
                    upperLeafManifest,
                    upperLeafKeys.wasm32,
                  ),
                  contextDependencyIdentity(
                    middleName,
                    middleManifest,
                    combinedMiddleKeys.wasm32,
                  ),
                ],
              },
              mirrorPath: "external-transitive.wasm",
            },
          },
        },
        {
          [middleName]: {
            manifest: middleManifest,
            cacheKeys: combinedMiddleKeys,
          },
        },
      );
      writeContextRegistry(lowerRoot, {
        [leafName]: {
          manifest: lowerLeafManifest,
          cacheKeys: {
            wasm32: "7".repeat(64),
            wasm64: "8".repeat(64),
          },
        },
        [middleName]: {
          manifest: middleManifest,
          cacheKeys: {
            wasm32: "9".repeat(64),
            wasm64: "a".repeat(64),
          },
        },
      });
      mkdirSync(browserRoot, { recursive: true });
      writeFileSync(
        join(browserRoot, "entry.ts"),
        'import external from "@binaries/programs/wasm32/external-transitive.wasm?url";\nvoid external;\n',
      );

      const audit = inspectBrowserBinaryDependencies(fixtureRoot, {
        registryPath: "external:main",
      });
      expect(audit.missingOwners).toEqual([]);
      expect(audit.unfetchableOwners).toEqual([]);
      expect(audit.packageNames).toEqual([externalName]);

      writeFileSync(
        join(lowerRoot, middleName, "package.toml"),
        `${middleManifest}build_input = "changed-after-projection"\n`,
      );
      expect(() =>
        inspectBrowserBinaryDependencies(fixtureRoot, {
          registryPath: "external:main",
        })
      ).toThrow(/stale generated package identity.*external-transitive-middle/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("uses the complete top projection for a lower browser program with a direct dependency override", () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), "kandelo-browser-context-direct-"),
    );
    try {
      const upperRoot = join(fixtureRoot, "external");
      const lowerRoot = join(fixtureRoot, "main");
      const dependencyName = "direct-shadow-dependency";
      const programName = "direct-shadow-program";
      const lowerDependencyManifest =
        `kind = "library"
name = "${dependencyName}"
version = "1.0.0"
depends_on = []
[source]
url = "https://example.test/${dependencyName}.tar.gz"
sha256 = "${"0".repeat(64)}"
[license]
spdx = "MIT"
`;
      const upperDependencyManifest = lowerDependencyManifest.replace(
        "0".repeat(64),
        "1".repeat(64),
      );
      const programManifest =
        `kind = "program"\nname = "${programName}"\nversion = "1.0.0"\ndepends_on = ["${dependencyName}@1.0.0"]\n`;
      const upperDependencyIdentity = contextDependencyIdentity(
        dependencyName,
        upperDependencyManifest,
        "8".repeat(64),
      );
      writeContextRegistry(
        upperRoot,
        {
          [dependencyName]: {
            manifest: upperDependencyManifest,
            cacheKeys: {
              wasm32: "8".repeat(64),
              wasm64: "9".repeat(64),
            },
          },
        },
        {
          [programName]: {
            manifest: programManifest,
            cacheKeys: {
              wasm32: "e".repeat(64),
              wasm64: "f".repeat(64),
            },
            projection: {
              dependencyClosures: {
                wasm32: [upperDependencyIdentity],
              },
              mirrorPath: "direct-shadow.wasm",
            },
          },
        },
      );
      writeContextRegistry(lowerRoot, {
        [dependencyName]: {
          manifest: lowerDependencyManifest,
          cacheKeys: {
            wasm32: "a".repeat(64),
            wasm64: "b".repeat(64),
          },
        },
        [programName]: {
          manifest: programManifest,
          cacheKeys: {
            wasm32: "c".repeat(64),
            wasm64: "d".repeat(64),
          },
          projection: {
            dependencyClosures: {
              wasm32: [contextDependencyIdentity(
                dependencyName,
                lowerDependencyManifest,
                "a".repeat(64),
              )],
            },
            mirrorPath: "direct-shadow.wasm",
          },
        },
      });

      const combinedOwners = packageOutputOwners(fixtureRoot, {
        registryPath: "external:main",
      });
      expect(
        combinedOwners.get("programs/wasm32/direct-shadow.wasm"),
      ).toMatchObject({ packageName: programName });

      const fallbackOwners = packageOutputOwners(fixtureRoot, {
        registryPath: "main",
      });
      expect(
        fallbackOwners.get("programs/wasm32/direct-shadow.wasm"),
      ).toMatchObject({ packageName: programName });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("uses the complete top projection for a lower browser program with a transitive dependency override", () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), "kandelo-browser-context-transitive-"),
    );
    try {
      const upperRoot = join(fixtureRoot, "external");
      const lowerRoot = join(fixtureRoot, "main");
      const leafName = "transitive-shadow-source";
      const intermediateName = "transitive-shadow-library";
      const programName = "transitive-shadow-program";
      const lowerLeafManifest =
        `kind = "source"
name = "${leafName}"
version = "1.0.0"
depends_on = []
[source]
url = "https://example.test/${leafName}.tar.gz"
sha256 = "${"0".repeat(64)}"
[license]
spdx = "MIT"
`;
      const upperLeafManifest = lowerLeafManifest.replace(
        "0".repeat(64),
        "1".repeat(64),
      );
      const intermediateManifest =
        `kind = "library"\nname = "${intermediateName}"\nversion = "1.0.0"\ndepends_on = ["${leafName}@1.0.0"]\n`;
      const programManifest =
        `kind = "program"\nname = "${programName}"\nversion = "1.0.0"\ndepends_on = ["${intermediateName}@1.0.0"]\n`;
      const leafIdentity = contextDependencyIdentity(
        leafName,
        lowerLeafManifest,
        "e".repeat(64),
      );
      const intermediateIdentity = contextDependencyIdentity(
        intermediateName,
        intermediateManifest,
        "f".repeat(64),
      );
      const combinedLeafIdentity = contextDependencyIdentity(
        leafName,
        upperLeafManifest,
        "0".repeat(64),
      );
      const combinedIntermediateIdentity = contextDependencyIdentity(
        intermediateName,
        intermediateManifest,
        "4".repeat(64),
      );
      writeContextRegistry(
        upperRoot,
        {
          [leafName]: {
            manifest: upperLeafManifest,
            cacheKeys: {
              wasm32: "0".repeat(64),
              wasm64: "0".repeat(64),
            },
          },
        },
        {
          [intermediateName]: {
            manifest: intermediateManifest,
            cacheKeys: {
              wasm32: "4".repeat(64),
              wasm64: "5".repeat(64),
            },
          },
          [programName]: {
            manifest: programManifest,
            cacheKeys: {
              wasm32: "6".repeat(64),
              wasm64: "7".repeat(64),
            },
            projection: {
              dependencyClosures: {
                wasm32: [
                  combinedIntermediateIdentity,
                  combinedLeafIdentity,
                ],
              },
              mirrorPath: "transitive-shadow.wasm",
            },
          },
        },
      );
      writeContextRegistry(lowerRoot, {
        [leafName]: {
          manifest: lowerLeafManifest,
          cacheKeys: {
            wasm32: leafIdentity.cacheKey,
            wasm64: leafIdentity.cacheKey,
          },
        },
        [intermediateName]: {
          manifest: intermediateManifest,
          cacheKeys: {
            wasm32: intermediateIdentity.cacheKey,
            wasm64: "1".repeat(64),
          },
        },
        [programName]: {
          manifest: programManifest,
          cacheKeys: {
            wasm32: "2".repeat(64),
            wasm64: "3".repeat(64),
          },
          projection: {
            dependencyClosures: {
              wasm32: [intermediateIdentity, leafIdentity],
            },
            mirrorPath: "transitive-shadow.wasm",
          },
        },
      });

      const owners = packageOutputOwners(fixtureRoot, {
        registryPath: "external:main",
      });
      expect(
        owners.get("programs/wasm32/transitive-shadow.wasm"),
      ).toMatchObject({ packageName: programName });
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for absent, stale, or widened external projections", () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), "kandelo-browser-invalid-projection-"),
    );
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      const registry = join(fixtureRoot, "registry");
      const packageName = "external-command-package";
      const packageDir = join(registry, packageName);
      const manifest = `kind = "program"
name = "${packageName}"
version = "1.0.0"
[[outputs]]
name = "external-command"
wasm = "external-command.wasm"
`;
      mkdirSync(browserRoot, { recursive: true });
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(browserRoot, "entry.ts"),
        'import command from "@binaries/programs/wasm32/external-command.wasm?url";\nvoid command;\n',
      );
      writeFileSync(join(packageDir, "package.toml"), manifest);
      writeFileSync(join(packageDir, "build.toml"), "revision = 1\n");
      const projection = {
        manifestSha256: createHash("sha256").update(manifest).digest("hex"),
        arches: ["wasm32"],
        cacheKeys: { wasm32: "a".repeat(64) },
        dependencyClosures: { wasm32: [] },
        members: [{
          kind: "output",
          sourceArtifact: "external-command.wasm",
          mirrorPath: "external-command.wasm",
          outputName: "external-command",
          forkInstrumentation: "auto",
        }],
      };
      const writeIndex = (packageProjection?: Record<string, unknown>) => {
        writeFileSync(
          join(registry, "program-packages.json"),
          `${JSON.stringify({
            format: "kandelo-program-packages-v2",
            identities: {
              [packageName]: {
                manifestSha256:
                  (packageProjection?.manifestSha256 as string | undefined)
                    ?? createHash("sha256").update(manifest).digest("hex"),
                cacheKeys: {
                  wasm32:
                    (packageProjection?.cacheKeys as Record<string, string> | undefined)
                      ?.wasm32 ?? "a".repeat(64),
                  wasm64: "b".repeat(64),
                },
              },
            },
            packages: packageProjection
              ? { [packageName]: packageProjection }
              : {},
          }, null, 2)}\n`,
        );
      };

      writeIndex();
      expect(
        inspectBrowserBinaryDependencies(fixtureRoot, {
          registryPath: "registry",
        }).missingOwners,
      ).toEqual(["programs/wasm32/external-command.wasm"]);

      writeIndex({ ...projection, manifestSha256: "b".repeat(64) });
      expect(() =>
        inspectBrowserBinaryDependencies(fixtureRoot, {
          registryPath: "registry",
        })
      ).toThrow(/stale generated package identity/);

      writeIndex({
        ...projection,
        members: [{
          ...projection.members[0],
          unexpectedPolicy: true,
        }],
      });
      expect(() =>
        inspectBrowserBinaryDependencies(fixtureRoot, {
          registryPath: "registry",
        })
      ).toThrow(/invalid generated program package projection member/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("rejects cross-package file and directory ownership conflicts", () => {
    const fixtureRoot = mkdtempSync(
      join(tmpdir(), "kandelo-browser-owner-conflict-"),
    );
    try {
      const registry = join(fixtureRoot, "registry");
      mkdirSync(registry, { recursive: true });
      const manifests: Record<string, string> = {
        "scalar-owner": `kind = "program"
name = "scalar-owner"
version = "1.0.0"
[[outputs]]
name = "shared"
wasm = "shared"
`,
        shared: `kind = "program"
name = "shared"
version = "1.0.0"
[[outputs]]
name = "child"
wasm = "child.wasm"
[[runtime_files]]
artifact = "data"
guest_path = "/usr/share/data"
`,
      };
      for (const [name, manifest] of Object.entries(manifests)) {
        const packageDir = join(registry, name);
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(join(packageDir, "package.toml"), manifest);
        writeFileSync(join(packageDir, "build.toml"), "revision = 1\n");
      }
      const base = (name: string) => ({
        manifestSha256: createHash("sha256")
          .update(manifests[name]!)
          .digest("hex"),
        arches: ["wasm32"],
        cacheKeys: { wasm32: "c".repeat(64) },
        dependencyClosures: { wasm32: [] },
      });
      writeFileSync(
        join(registry, "program-packages.json"),
        `${JSON.stringify({
          format: "kandelo-program-packages-v2",
          identities: Object.fromEntries(
            Object.entries(manifests).map(([name, manifest]) => [
              name,
              {
                manifestSha256: createHash("sha256")
                  .update(manifest)
                  .digest("hex"),
                cacheKeys: {
                  wasm32: "c".repeat(64),
                  wasm64: "d".repeat(64),
                },
              },
            ]),
          ),
          packages: {
            "scalar-owner": {
              ...base("scalar-owner"),
              members: [{
                kind: "output",
                sourceArtifact: "shared",
                mirrorPath: "shared",
                outputName: "shared",
                forkInstrumentation: "auto",
              }],
            },
            shared: {
              ...base("shared"),
              members: [
                {
                  kind: "output",
                  sourceArtifact: "child.wasm",
                  mirrorPath: "shared/child.wasm",
                  outputName: "child",
                  forkInstrumentation: "auto",
                },
                {
                  kind: "runtime-file",
                  sourceArtifact: "data",
                  mirrorPath: "shared/data",
                  guestPath: "/usr/share/data",
                  mode: 0o644,
                },
              ],
            },
          },
        }, null, 2)}\n`,
      );

      expect(() =>
        packageOutputOwners(fixtureRoot, { registryPath: "registry" })
      ).toThrow(/outputs .* conflict between/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("derives the exact package roots needed to bundle the browser app", () => {
    const audit = inspectBrowserBinaryDependencies(repoRoot);
    const roots = browserBinaryPackageRoots(repoRoot, {
      arch: "wasm32",
      // The exact bottle-built archive is installed after registry fetching.
      excludePackages: ["shell"],
      // @rootfs-vfs is a Vite alias rather than an @binaries import.
      includePackages: ["rootfs"],
    });

    expect(roots).toEqual([...new Set(roots)].sort());
    expect(roots).toContain("rootfs");
    expect(roots).not.toContain("shell");
    expect(roots).toEqual(
      [...new Set([
        ...audit.packageRoots
          .filter((root) => root.arch === "wasm32")
          .map((root) => root.package),
        "rootfs",
      ])]
        .filter((name) => name !== "shell")
        .sort(),
    );
  });

  it("keeps optional gallery images outside the exact shell proof roots", () => {
    const roots = browserBinaryPackageRoots(repoRoot, {
      arch: "wasm32",
      htmlEntryFiles: [
        "index.html",
        "pages/homebrew-vfs-test/index.html",
      ],
      localCapabilities: ["kernel-wasm"],
      packageCapabilities: { "rootfs-vfs": "rootfs" },
      excludePackages: ["shell"],
    });

    expect(roots).toContain("bash");
    // WHY: bootstrap support is extracted from the selected public bottle.
    // Keeping it out of this conventional registry closure prevents the
    // browser proof from silently restoring the retired package bridge.
    expect(roots).not.toContain("homebrew-bootstrap");
    expect(roots).toContain("rootfs");
    expect(roots).not.toContain("shell");
    expect(roots).not.toContain("node-vfs");
    expect(roots).not.toContain("wordpress");
    expect(roots).not.toContain("lamp");
    expect(roots).not.toContain("nginx-vfs");
    expect(roots).not.toContain("nginx-php-vfs");
    expect(roots).not.toContain("erlang-vfs");
  });

  it("requires each exact-shell virtual artifact to have one binding", () => {
    const options = {
      arch: "wasm32" as const,
      htmlEntryFiles: [
        "index.html",
        "pages/homebrew-vfs-test/index.html",
      ],
      excludePackages: ["shell"],
    };
    expect(() => browserBinaryPackageRoots(repoRoot, options)).toThrow(
      /required browser capability has no binding: kernel-wasm/,
    );
    expect(() => browserBinaryPackageRoots(repoRoot, {
      ...options,
      localCapabilities: ["kernel-wasm"],
    })).toThrow(/required browser capability has no binding: rootfs-vfs/);
    expect(() => browserBinaryPackageRoots(repoRoot, {
      ...options,
      localCapabilities: ["kernel-wasm", "rootfs-vfs"],
      packageCapabilities: { "rootfs-vfs": "rootfs" },
    })).toThrow(/browser capability has two bindings: rootfs-vfs/);
  });

  it("keeps wasm32 and wasm64 browser roots in separate package generations", () => {
    const audit = inspectBrowserBinaryDependencies(repoRoot);
    const wasm32Roots = browserBinaryPackageRoots(repoRoot, {
      arch: "wasm32",
      excludePackages: ["shell"],
      includePackages: ["rootfs"],
    });
    const wasm64Roots = browserBinaryPackageRoots(repoRoot, {
      arch: "wasm64",
      excludePackages: ["shell"],
    });

    expect(wasm32Roots).toContain("rootfs");
    expect(wasm64Roots).not.toContain("rootfs");
    expect(wasm64Roots).toEqual(
      [...new Set(
        audit.packageRoots
          .filter((root) => root.arch === "wasm64")
          .map((root) => root.package),
      )].sort(),
    );
    expect(wasm64Roots).toContain("mariadb");
    expect(wasm64Roots).toContain("mariadb-vfs");
  });

  it("does not let a wasm64 import select the same package's wasm32 bottle", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "kandelo-browser-arch-root-"));
    try {
      const browserRoot = join(fixtureRoot, "apps", "browser-demos");
      const registry = join(fixtureRoot, "packages", "registry");
      const packageDir = join(registry, "dual-arch");
      const manifest = [
        'kind = "program"',
        'name = "dual-arch"',
        'version = "1"',
        'arches = ["wasm32", "wasm64"]',
        "",
      ].join("\n");
      const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
      mkdirSync(browserRoot, { recursive: true });
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(browserRoot, "entry.ts"),
        'import binary from "@binaries/programs/wasm64/dual.wasm?url";\nvoid binary;\n',
      );
      writeFileSync(join(packageDir, "package.toml"), manifest);
      writeFileSync(join(packageDir, "build.toml"), "revision = 1\n");
      writeFileSync(
        join(registry, "program-packages.json"),
        `${JSON.stringify({
          format: "kandelo-program-packages-v2",
          identities: {
            "dual-arch": {
              manifestSha256,
              cacheKeys: {
                wasm32: "1".repeat(64),
                wasm64: "2".repeat(64),
              },
            },
          },
          packages: {
            "dual-arch": {
              manifestSha256,
              arches: ["wasm32", "wasm64"],
              cacheKeys: {
                wasm32: "1".repeat(64),
                wasm64: "2".repeat(64),
              },
              dependencyClosures: { wasm32: [], wasm64: [] },
              members: [{
                kind: "output",
                sourceArtifact: "dual.wasm",
                mirrorPath: "dual.wasm",
                outputName: "dual",
                forkInstrumentation: "auto",
              }],
            },
          },
        }, null, 2)}\n`,
      );

      expect(browserBinaryPackageRoots(fixtureRoot, {
        arch: "wasm32",
      })).toEqual([]);
      expect(browserBinaryPackageRoots(fixtureRoot, {
        arch: "wasm64",
      })).toEqual(["dual-arch"]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
