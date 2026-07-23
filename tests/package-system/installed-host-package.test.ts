import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = resolve(import.meta.dirname, "../..");
const fixtureRoots: string[] = [];

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("installed host package binary policy", () => {
  it("binds installed scalar and multi-member bytes to packaged projection identity", () => {
    execFileSync("npm", ["--prefix", "host", "run", "build"], {
      cwd: repoRoot,
      stdio: "pipe",
    });

    const root = mkdtempSync(join(tmpdir(), "kandelo-packed-host-"));
    fixtureRoots.push(root);
    const staging = join(root, "staging");
    const wasmRoot = join(staging, "wasm");
    const multiName = "packed-runtime";
    const scalarName = "packed-command-package";
    const dependencyName = "packed-runtime-dependency";
    const auxiliaryDependencyName = "packed-runtime-auxiliary";
    const scalarOutput = "packed-command.zip";
    const imageRel = `programs/wasm32/${multiName}/image.zip`;
    const runtimeRel =
      `programs/wasm32/${multiName}/share/runtime.dat`;
    const scalarRel = `programs/wasm32/${scalarOutput}`;
    const multiManifest = `kind = "program"
name = "${multiName}"
version = "1.0.0"
depends_on = ["${dependencyName}@1.0.0", "${auxiliaryDependencyName}@1.0.0"]
[[outputs]]
name = "image"
wasm = "artifacts/image.zip"
[[runtime_files]]
artifact = "share/runtime.dat"
guest_path = "/usr/share/packed-runtime/runtime.dat"
`;
    const scalarManifest = `kind = "program"
name = "${scalarName}"
version = "1.0.0"
[[outputs]]
name = "packed-command"
wasm = "bin/${scalarOutput}"
`;
    const dependencyManifest = `kind = "library"
name = "${dependencyName}"
version = "1.0.0"
`;
    const auxiliaryDependencyManifest = `kind = "source"
name = "${auxiliaryDependencyName}"
version = "1.0.0"
`;
    const dependencyIdentity = {
      packageName: dependencyName,
      manifestSha256: createHash("sha256")
        .update(dependencyManifest)
        .digest("hex"),
      cacheKey: "d".repeat(64),
    };
    const auxiliaryDependencyIdentity = {
      packageName: auxiliaryDependencyName,
      manifestSha256: createHash("sha256")
        .update(auxiliaryDependencyManifest)
        .digest("hex"),
      cacheKey: "c".repeat(64),
    };
    const multiProjection = {
      manifestSha256: createHash("sha256").update(multiManifest).digest("hex"),
      arches: ["wasm32"],
      cacheKeys: { wasm32: "1".repeat(64) },
      dependencyClosures: {
        wasm32: [dependencyIdentity, auxiliaryDependencyIdentity],
      },
      members: [
        {
          kind: "output",
          sourceArtifact: "artifacts/image.zip",
          mirrorPath: `${multiName}/image.zip`,
          outputName: "image",
          forkInstrumentation: "auto",
        },
        {
          kind: "runtime-file",
          sourceArtifact: "share/runtime.dat",
          mirrorPath: `${multiName}/share/runtime.dat`,
          guestPath: "/usr/share/packed-runtime/runtime.dat",
          mode: 0o644,
        },
      ],
    };
    const scalarProjection = {
      manifestSha256: createHash("sha256").update(scalarManifest).digest("hex"),
      arches: ["wasm32"],
      cacheKeys: { wasm32: "2".repeat(64) },
      dependencyClosures: { wasm32: [] },
      members: [{
        kind: "output",
        sourceArtifact: `bin/${scalarOutput}`,
        mirrorPath: scalarOutput,
        outputName: "packed-command",
        forkInstrumentation: "auto",
      }],
    };
    const bundledPackages = {
      [multiName]: multiProjection,
      [scalarName]: scalarProjection,
    };
    const bundledIdentities: Record<string, unknown> = Object.fromEntries(
      Object.entries(bundledPackages).map(([packageName, projection]) => [
        packageName,
        {
          manifestSha256: projection.manifestSha256,
          cacheKeys: {
            wasm32: projection.cacheKeys.wasm32,
            wasm64: createHash("sha256")
              .update(`${packageName}:wasm64`)
              .digest("hex"),
          },
        },
      ]),
    );
    bundledIdentities[dependencyName] = {
      manifestSha256: dependencyIdentity.manifestSha256,
      cacheKeys: {
        wasm32: dependencyIdentity.cacheKey,
        wasm64: "e".repeat(64),
      },
    };
    bundledIdentities[auxiliaryDependencyName] = {
      manifestSha256: auxiliaryDependencyIdentity.manifestSha256,
      cacheKeys: {
        wasm32: auxiliaryDependencyIdentity.cacheKey,
        wasm64: "b".repeat(64),
      },
    };

    mkdirSync(join(wasmRoot, dirname(imageRel)), { recursive: true });
    mkdirSync(join(wasmRoot, dirname(runtimeRel)), { recursive: true });
    mkdirSync(join(wasmRoot, dirname(scalarRel)), { recursive: true });
    cpSync(join(repoRoot, "host", "dist"), join(staging, "dist"), {
      recursive: true,
    });
    cpSync(join(repoRoot, "host", "package.json"), join(staging, "package.json"));
    writeFileSync(join(wasmRoot, imageRel), "packed image");
    writeFileSync(join(wasmRoot, runtimeRel), "packed runtime");
    writeFileSync(join(wasmRoot, scalarRel), "packed scalar");
    writeFileSync(
      join(wasmRoot, "program-packages.json"),
      `${JSON.stringify({
        format: "kandelo-program-packages-v2",
        identities: bundledIdentities,
        packages: bundledPackages,
      }, null, 2)}\n`,
    );

    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--ignore-scripts", "--json"], {
        cwd: staging,
        encoding: "utf8",
      }),
    ) as Array<{ filename: string }>;
    const archive = join(staging, packed[0]!.filename);
    const listing = execFileSync("tar", ["-tzf", archive], {
      encoding: "utf8",
    });
    expect(listing).toContain("package/wasm/program-packages.json");
    expect(listing).toContain(`package/wasm/${imageRel}`);
    expect(listing).toContain(`package/wasm/${runtimeRel}`);
    expect(listing).toContain(`package/wasm/${scalarRel}`);

    const consumer = join(root, "consumer");
    const modules = join(consumer, "node_modules");
    mkdirSync(modules, { recursive: true });
    execFileSync("tar", ["-xzf", archive], { cwd: root });
    cpSync(join(root, "package"), join(modules, "wasm-posix-host"), {
      recursive: true,
    });
    for (const dependency of ["fflate", "fzstd"]) {
      symlinkSync(
        join(repoRoot, "node_modules", dependency),
        join(modules, dependency),
        "dir",
      );
    }
    writeFileSync(
      join(consumer, "package.json"),
      '{"name":"isolated-host-consumer","private":true,"type":"module"}\n',
    );
    const baseEnv = { ...process.env };
    delete baseEnv.WASM_POSIX_DEPS_REGISTRY;
    delete baseEnv.WASM_POSIX_BINARY_RESOLVER_REPO_ROOT;

    const writeRegistry = (
      name: string,
      packages: Record<string, {
        manifest: string;
        projection?: Record<string, unknown>;
        cacheKeys?: Record<string, string>;
      }>,
      contextualPackages: Record<string, {
        manifest: string;
        cacheKeys: Record<string, string>;
        projection?: Record<string, unknown>;
      }> = {},
    ): string => {
      const registry = join(root, name);
      mkdirSync(registry, { recursive: true });
      const identities: Record<string, unknown> = {};
      const projections: Record<string, unknown> = {};
      for (
        const [packageName, entry] of Object.entries(contextualPackages)
      ) {
        identities[packageName] = {
          manifestSha256: createHash("sha256")
            .update(entry.manifest)
            .digest("hex"),
          cacheKeys: entry.cacheKeys,
        };
        if (entry.projection) projections[packageName] = entry.projection;
      }
      for (const [packageName, entry] of Object.entries(packages)) {
        const packageDir = join(registry, packageName);
        mkdirSync(packageDir, { recursive: true });
        writeFileSync(join(packageDir, "package.toml"), entry.manifest);
        if (entry.projection) projections[packageName] = entry.projection;
        const projection = entry.projection as {
          manifestSha256?: string;
          cacheKeys?: Record<string, string>;
        } | undefined;
        const manifestSha256 = createHash("sha256")
          .update(entry.manifest)
          .digest("hex");
        const cacheKeys = entry.cacheKeys ?? projection?.cacheKeys ?? {};
        identities[packageName] = {
          manifestSha256,
          cacheKeys: {
            wasm32: cacheKeys.wasm32
              ?? createHash("sha256").update(`${packageName}:wasm32`).digest("hex"),
            wasm64: cacheKeys.wasm64
              ?? createHash("sha256").update(`${packageName}:wasm64`).digest("hex"),
          },
        };
      }
      writeFileSync(
        join(registry, "program-packages.json"),
        `${JSON.stringify({
          format: "kandelo-program-packages-v2",
          identities,
          packages: projections,
        }, null, 2)}\n`,
      );
      return registry;
    };
    const equivalentRegistry = writeRegistry("registry-equivalent", {
      [multiName]: {
        manifest: multiManifest,
        projection: {
          ...multiProjection,
          // Runtime identity is a unique package-identity set. Reverse the
          // deterministic generator order to prove serialization order alone
          // cannot reject the same installed package generation.
          dependencyClosures: {
            wasm32: [
              auxiliaryDependencyIdentity,
              dependencyIdentity,
            ],
          },
        },
      },
      [scalarName]: {
        manifest: scalarManifest,
        projection: scalarProjection,
      },
      [dependencyName]: {
        manifest: dependencyManifest,
        cacheKeys: {
          wasm32: dependencyIdentity.cacheKey,
          wasm64: "e".repeat(64),
        },
      },
      [auxiliaryDependencyName]: {
        manifest: auxiliaryDependencyManifest,
        cacheKeys: {
          wasm32: auxiliaryDependencyIdentity.cacheKey,
          wasm64: "b".repeat(64),
        },
      },
    });
    const mismatchedRegistry = writeRegistry("registry-mismatched", {
      [multiName]: {
        manifest: multiManifest,
        projection: {
          ...multiProjection,
          cacheKeys: { wasm32: "3".repeat(64) },
        },
      },
      [scalarName]: {
        manifest: scalarManifest,
        projection: {
          ...scalarProjection,
          cacheKeys: { wasm32: "4".repeat(64) },
        },
      },
      [dependencyName]: {
        manifest: dependencyManifest,
        cacheKeys: {
          wasm32: dependencyIdentity.cacheKey,
          wasm64: "e".repeat(64),
        },
      },
      [auxiliaryDependencyName]: {
        manifest: auxiliaryDependencyManifest,
        cacheKeys: {
          wasm32: auxiliaryDependencyIdentity.cacheKey,
          wasm64: "b".repeat(64),
        },
      },
    });
    const contextMismatchedRegistry = writeRegistry(
      "registry-context-mismatch",
      {
        [dependencyName]: {
          manifest: dependencyManifest.replace("1.0.0", "2.0.0"),
          cacheKeys: {
            wasm32: "f".repeat(64),
            wasm64: "0".repeat(64),
          },
        },
      },
      {
        [multiName]: {
          manifest: multiManifest,
          cacheKeys: {
            wasm32: "9".repeat(64),
            wasm64: "a".repeat(64),
          },
          projection: {
            ...multiProjection,
            cacheKeys: { wasm32: "9".repeat(64) },
            dependencyClosures: {
              wasm32: [{
                packageName: dependencyName,
                manifestSha256: createHash("sha256")
                  .update(dependencyManifest.replace("1.0.0", "2.0.0"))
                  .digest("hex"),
                cacheKey: "f".repeat(64),
              }],
            },
          },
        },
        [scalarName]: {
          manifest: scalarManifest,
          cacheKeys: {
            wasm32: scalarProjection.cacheKeys.wasm32,
            wasm64: "b".repeat(64),
          },
          projection: scalarProjection,
        },
      },
    );
    const unrelatedName = "unrelated-runtime";
    const unrelatedManifest = `kind = "program"
name = "${unrelatedName}"
version = "1.0.0"
[[outputs]]
name = "unrelated"
wasm = "unrelated.wasm"
`;
    const unrelatedRegistry = writeRegistry("registry-unrelated", {
      [unrelatedName]: {
        manifest: unrelatedManifest,
        projection: {
          manifestSha256: createHash("sha256")
            .update(unrelatedManifest)
            .digest("hex"),
          arches: ["wasm32"],
          cacheKeys: { wasm32: "5".repeat(64) },
          dependencyClosures: { wasm32: [] },
          members: [{
            kind: "output",
            sourceArtifact: "unrelated.wasm",
            mirrorPath: "unrelated.wasm",
            outputName: "unrelated",
            forkInstrumentation: "auto",
          }],
        },
      },
    });

    const runResolver = (
      registry?: string,
    ): Record<string, { path?: string; error?: string }> => {
      const env = { ...baseEnv };
      if (registry === undefined) {
        delete env.WASM_POSIX_DEPS_REGISTRY;
      } else {
        env.WASM_POSIX_DEPS_REGISTRY = registry;
      }
      return JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { resolveBinary } from "wasm-posix-host";
const result = {};
for (const [name, rel] of Object.entries(${JSON.stringify({
              multi: imageRel,
              scalar: scalarRel,
            })})) {
  try {
    result[name] = { path: resolveBinary(rel) };
  } catch (error) {
    result[name] = { error: error instanceof Error ? error.message : String(error) };
  }
}
process.stdout.write(JSON.stringify(result));`,
          ],
          {
            cwd: consumer,
            encoding: "utf8",
            env,
          },
        ),
      ) as Record<string, { path?: string; error?: string }>;
    };

    for (const result of [runResolver(), runResolver(equivalentRegistry)]) {
      expect(result.multi?.error).toBeUndefined();
      expect(result.scalar?.error).toBeUndefined();
      expect(readFileSync(result.multi!.path!, "utf8")).toBe("packed image");
      expect(readFileSync(result.scalar!.path!, "utf8")).toBe("packed scalar");
    }
    const installedWasmRoot = realpathSync(
      join(modules, "wasm-posix-host", "wasm"),
    );
    const resolved = runResolver(equivalentRegistry);
    expect(resolved.multi!.path!.startsWith(`${installedWasmRoot}/`)).toBe(true);
    expect(resolved.scalar!.path!.startsWith(`${installedWasmRoot}/`)).toBe(true);

    for (const entry of Object.values(runResolver(mismatchedRegistry))) {
      expect(entry.error).toMatch(
        /installed bytes do not match the selected package projection/,
      );
    }
    const contextMismatch = runResolver(
      `${contextMismatchedRegistry}:${equivalentRegistry}`,
    );
    expect(contextMismatch.multi?.error).toMatch(
      /installed bytes do not match the selected package projection/,
    );
    expect(contextMismatch.scalar?.error).toBeUndefined();
    expect(readFileSync(contextMismatch.scalar!.path!, "utf8")).toBe(
      "packed scalar",
    );
    for (const entry of Object.values(runResolver(unrelatedRegistry))) {
      expect(entry.error).toMatch(
        /owned by .*but that package is not selected/,
      );
    }

    rmSync(
      join(modules, "wasm-posix-host", "wasm", "program-packages.json"),
    );
    for (const entry of Object.values(runResolver())) {
      expect(entry.error).toMatch(
        /missing wasm\/program-packages\.json/,
      );
    }
  }, 120_000);
});
