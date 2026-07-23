/**
 * Build a precomposed Homebrew-prefix VFS image from Kandelo/Homebrew sidecars.
 *
 * Usage:
 *   npx tsx images/vfs/scripts/build-homebrew-vfs-image.ts \
 *     --metadata homebrew/homebrew-tap-core/Kandelo/metadata.json \
 *     --tap-root homebrew/homebrew-tap-core \
 *     --brewfile Brewfile \
 *     --arch wasm32 \
 *     --runtime node \
 *     --base-image target/platform-base.vfs.zst \
 *     --out target/homebrew-hello.vfs.zst \
 *     --report target/homebrew-hello.vfs-report.json
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHomebrewVfs,
  type HomebrewVfsBuildOptions,
  type HomebrewVfsBuildResult,
  type HomebrewVfsCompatibilityPolicy,
  type HomebrewVfsRuntimeStateDeclaration,
} from "../../../host/src/homebrew-vfs-builder";
import {
  buildHomebrewLazyLayer,
  encodeHomebrewLazyLayerDescriptor,
  homebrewRuntimeLayerPayloadAsset,
  homebrewRuntimeLayerDescriptorAsset,
  parseHomebrewLazyLayerBasePackageSource,
} from "../../../host/src/homebrew-lazy-layer";
import { fetchHomebrewBottleBytes } from "../../../host/src/homebrew-vfs-fetch";
import {
  planFederatedHomebrewVfs,
  planHomebrewVfs,
  type HomebrewBottleArch,
  type HomebrewRuntime,
  type HomebrewVfsPackagePlan,
  type HomebrewVfsPlan,
} from "../../../host/src/homebrew-vfs-planner";
import {
  MemoryFileSystem,
  type VfsImageMetadata,
} from "../../../host/src/vfs/memory-fs";
import {
  assertPackageDeferredZipTreeState,
  derivePackageDeferredZipTree,
  materializePackageDeferredZipTree,
  registerPackageDeferredZipTree,
  type DerivedPackageDeferredZipTree,
} from "../../../host/src/vfs/package-deferred-tree";
import {
  KANDELO_DEMO_CONFIG_PATH,
  MAX_KANDELO_DEMO_CONFIG_BYTES,
  parseKandeloDemoConfig,
  validateKandeloDemoConfig,
  type KandeloDemoConfig,
} from "../../../web-libs/kandelo-session/src/demo-config";
import {
  KANDELO_SHELL_CONFIG_PATH,
  MAX_KANDELO_SHELL_CONFIG_BYTES,
  MAX_KANDELO_SHELL_EXECUTABLE_BYTES,
  parseKandeloShellConfig,
  type KandeloShellConfig,
} from "../../../web-libs/kandelo-session/src/shell-config";
import {
  ensureDirRecursive,
  saveImage,
  sourceDateEpochMilliseconds,
  writeVfsBinary,
} from "./vfs-image-helpers";

interface CliOptions {
  metadata: string;
  tapRoot: string;
  dependencyTapRoots: Record<string, string>;
  packages: string[];
  brewfile?: string;
  arch: HomebrewBottleArch;
  runtime?: HomebrewRuntime;
  out: string;
  report: string;
  expectedCacheKeys: Record<string, string>;
  allowFallback: boolean;
  bottleCache?: string;
  baseImage?: string;
  maxBytes?: number;
  writeProfile: boolean;
  shellConfig?: string;
  demoConfig?: string;
  catalogCommit?: string;
  migrationLock?: string;
  lazyLayerOut?: string;
  lazyLayerDescriptor?: string;
  lazyLayerBaseImage?: string;
  lazyLayerBasePackageSource?: string;
  runtimeLayerId?: string;
  runtimeLayerPolicy?: string;
  materializationPolicy?: string;
  bottleMirrorRepository?: string;
  bottleMirrorOut?: string;
  packageTreeSpec?: string;
  packageTreeArchive?: string;
  materializePackageTree: boolean;
}

/**
 * Candidate-only composition is injected by a separate entrypoint. Keeping
 * this boundary structural lets the canonical eager builder remain free of
 * candidate composer imports while both paths reuse the same CLI, planning,
 * image metadata, and serialization implementation.
 */
export interface HomebrewVfsImageMaterializationOptions
  extends HomebrewVfsBuildOptions {
  fs: MemoryFileSystem;
  collectionFs: MemoryFileSystem;
  policy: unknown;
  mirrorRepository: string;
}

export interface HomebrewVfsImageMaterializedBuild {
  result: HomebrewVfsBuildResult;
  assert(fs: MemoryFileSystem): void;
  writeBottleMirrorBundle(outputDirectory: string): unknown;
}

export type HomebrewVfsImageMaterializer = (
  plan: HomebrewVfsPlan,
  options: HomebrewVfsImageMaterializationOptions,
) => Promise<HomebrewVfsImageMaterializedBuild>;

const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const SHARED_FS_BLOCK_BYTES = 4096;
const HOMEBREW_COMPOSITION_PATH = "/etc/kandelo/homebrew-vfs.json";
const MAX_SIDECAR_JSON_BYTES = 16_777_216;
const MAX_BREWFILE_BYTES = 65_536;
const MAX_BREWFILE_PACKAGES = 128;
const MAX_BREWFILE_PARSER_OUTPUT_BYTES = 65_536;
const MAX_MIGRATION_LOCK_BYTES = 65_536;
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const TAP_NAME_RE = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;
const PACKAGE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BREWFILE_PARSER = resolve(
  SCRIPT_DIR,
  "../../../scripts/homebrew-brewfile-selection.rb",
);

interface BrewfileSelection {
  schema: 1;
  kind: "kandelo-static-brewfile-v1";
  tap_name: string;
  sha256: string;
  bytes: number;
  packages: string[];
}

interface BaseImageBinding {
  sha256: string;
  bytes: number;
  kernelAbi: number;
}

interface LoadedBaseImage {
  binding: BaseImageBinding;
  metadata: VfsImageMetadata;
}

interface LoadedShellConfig {
  config: KandeloShellConfig;
  source: Uint8Array;
  sha256: string;
  bytes: number;
}

interface LoadedDemoConfig {
  config: KandeloDemoConfig;
  source: Uint8Array;
  sha256: string;
  bytes: number;
}

interface LoadedMigrationLock {
  value: unknown;
  sha256: string;
  bytes: number;
}

export async function runHomebrewVfsImageBuilder(
  args: string[],
  materialize?: HomebrewVfsImageMaterializer,
): Promise<void> {
  const options = parseArgs(args);
  const metadata = readJsonFile(options.metadata);
  const primaryTapName = metadataTapName(metadata, options.metadata);
  const shellConfig = options.shellConfig
    ? readShellConfig(options.shellConfig)
    : undefined;
  const demoConfig = options.demoConfig
    ? readDemoConfig(options.demoConfig)
    : undefined;
  const migrationLock = options.migrationLock
    ? readMigrationLock(options.migrationLock)
    : undefined;
  const compatibilityPolicy = migrationLock === undefined
    ? undefined
    : migrationLockCompatibilityPolicy(migrationLock.value, options.migrationLock!);
  const brewfileSelection = options.brewfile
    ? readBrewfileSelection(options.brewfile)
    : undefined;
  const requestedPackages = brewfileSelection?.packages ?? options.packages;

  const dependencyMetadata = Object.entries(options.dependencyTapRoots).map(
    ([tapName, tapRoot]) => ({
      tapName,
      tapRoot,
      metadata: readJsonFile(join(tapRoot, "Kandelo/metadata.json")),
    }),
  );
  const tapRoots = new Map<string, string>([
    [primaryTapName, options.tapRoot],
    ...dependencyMetadata.map(({ tapName, tapRoot }) => [tapName, tapRoot] as const),
  ]);
  const commonPlanOptions = {
    packages: requestedPackages,
    arch: options.arch,
    runtime: options.runtime,
    expectedCacheKeys: options.expectedCacheKeys,
    allowFallback: options.allowFallback,
  };
  const plan = dependencyMetadata.length === 0
    ? await planHomebrewVfs(metadata, {
      ...commonPlanOptions,
      expectedTapName: brewfileSelection?.tap_name,
      loadLinkManifest: (relPath: string) => readJsonFile(join(options.tapRoot, relPath)),
    })
    : await planFederatedHomebrewVfs(
      [metadata, ...dependencyMetadata.map(({ metadata: value }) => value)],
      {
        ...commonPlanOptions,
        rootTapName: brewfileSelection?.tap_name ?? primaryTapName,
        loadLinkManifest: (tap, relPath) => {
          const root = tapRoots.get(tap.tapName);
          if (root === undefined) {
            throw new Error(`no immutable checkout is available for tap ${tap.tapName}`);
          }
          return readJsonFile(join(root, relPath));
        },
      },
    );

  const { fs, baseImage, maxByteLength } = createFs(
    options.baseImage,
    options.maxBytes,
    plan.kandeloAbi,
  );
  const loadedBottleBytes = new Map<string, Uint8Array>();
  const loadPlannedBottle = async (pkg: HomebrewVfsPackagePlan) => {
    const existing = loadedBottleBytes.get(pkg.fullName);
    if (existing !== undefined) return existing;
    const bytes = await loadBottleBytes(pkg, options);
    loadedBottleBytes.set(pkg.fullName, bytes);
    return bytes;
  };
  const selectionSource = brewfileSelection ? {
    kind: "brewfile" as const,
    parser: brewfileSelection.kind,
    sha256: brewfileSelection.sha256,
    bytes: brewfileSelection.bytes,
    requestedPackages: brewfileSelection.packages,
  } : undefined;
  const catalogCheckout = options.catalogCommit === undefined ? undefined : {
    tapRepository: plan.tapRepository,
    tapName: plan.tapName,
    checkoutCommit: options.catalogCommit,
  };
  const migrationLockBinding = migrationLock === undefined ? undefined : {
    sha256: migrationLock.sha256,
    bytes: migrationLock.bytes,
  };
  let materializedBuild: HomebrewVfsImageMaterializedBuild | undefined;
  const commonBuildOptions = {
    fs,
    writeProfile: options.writeProfile,
    createdBy: "images/vfs/scripts/build-homebrew-vfs-image.ts",
    selectionSource,
    catalogCheckout,
    compatibilityPolicy,
    migrationLock: migrationLockBinding,
    loadBottleBytes: loadPlannedBottle,
  };
  let result: HomebrewVfsBuildResult;
  if (options.materializationPolicy === undefined) {
    result = await buildHomebrewVfs(plan, commonBuildOptions);
  } else {
    if (materialize === undefined) {
      throw new Error(
        "materialized composition requires the candidate-owned image builder entrypoint",
      );
    }
    materializedBuild = await materialize(plan, {
      ...commonBuildOptions,
      fs,
      collectionFs: createFs(
        undefined,
        maxByteLength,
        plan.kandeloAbi,
      ).fs,
      policy: readJsonFile(options.materializationPolicy),
      mirrorRepository: options.bottleMirrorRepository!,
    });
    result = materializedBuild.result;
    materializedBuild.assert(fs);
  }
  let packageTree: {
    derived: DerivedPackageDeferredZipTree;
    state: "deferred" | "materialized";
  } | undefined;
  if (options.packageTreeSpec !== undefined) {
    const archiveBytes = readPackageTreeArchive(options.packageTreeArchive!);
    const derived = derivePackageDeferredZipTree(
      readJsonFile(options.packageTreeSpec),
      archiveBytes,
    );
    if (basename(options.packageTreeArchive!) !== derived.descriptor.package.output) {
      throw new Error(
        `package tree archive must be named ${derived.descriptor.package.output}`,
      );
    }
    const registered = registerPackageDeferredZipTree(fs, derived);
    if (options.materializePackageTree) {
      await materializePackageDeferredZipTree(fs, registered, archiveBytes);
    }
    const state = options.materializePackageTree ? "materialized" : "deferred";
    assertPackageDeferredZipTreeState(fs, derived, state);
    packageTree = { derived, state };
  }
  if (shellConfig) {
    assertShellExecutable(fs, shellConfig.config.path);
    if (
      materializedBuild !== undefined &&
      fs.isPathDeferred(shellConfig.config.path)
    ) {
      throw new Error(
        `default shell must be embedded rather than deferred: ${shellConfig.config.path}`,
      );
    }
    if (vfsPathExists(fs, KANDELO_SHELL_CONFIG_PATH)) {
      throw new Error(
        `refusing to overwrite existing default shell config: ${KANDELO_SHELL_CONFIG_PATH}`,
      );
    }
    ensureDirRecursive(fs, dirname(KANDELO_SHELL_CONFIG_PATH));
    writeVfsBinary(fs, KANDELO_SHELL_CONFIG_PATH, shellConfig.source, 0o644);
    assertShellExecutable(fs, shellConfig.config.path);
  }
  if (demoConfig) {
    if (vfsPathExists(fs, KANDELO_DEMO_CONFIG_PATH)) {
      throw new Error(
        `refusing to overwrite existing demo config: ${KANDELO_DEMO_CONFIG_PATH}`,
      );
    }
    ensureDirRecursive(fs, dirname(KANDELO_DEMO_CONFIG_PATH));
    writeVfsBinary(fs, KANDELO_DEMO_CONFIG_PATH, demoConfig.source, 0o644);
  }

  const imageBytes = await saveImage(fs, options.out, {
    normalizeTimestampsMs: sourceDateEpochMilliseconds(
      process.env.SOURCE_DATE_EPOCH,
    ),
    metadata: {
      version: 1,
      kernelAbi: plan.kandeloAbi,
      createdBy: "images/vfs/scripts/build-homebrew-vfs-image.ts",
      capacity: { maxByteLength },
      ...(baseImage ? { baseImage: baseImage.binding } : {}),
      ...(packageTree === undefined ? {} : {
        packageDeferredTrees: [packageTreeBinding(packageTree)],
      }),
      homebrew: {
        tapRepository: plan.tapRepository,
        tapName: plan.tapName,
        tapCommit: plan.tapCommit,
        releaseTag: plan.releaseTag,
        ...(result.report.catalog === undefined ? {} : {
          catalog: {
            tapRepository: result.report.catalog.tap_repository,
            tapName: result.report.catalog.tap_name,
            checkoutCommit: result.report.catalog.checkout_commit,
          },
        }),
        ...(result.report.migration_lock === undefined ? {} : {
          migrationLock: {
            sha256: result.report.migration_lock.sha256,
            bytes: result.report.migration_lock.bytes,
          },
        }),
        ...(result.report.runtime_state === undefined ? {} : {
          runtimeState: result.report.runtime_state.map((entry) => ({
            requiresPackage: entry.requires_package,
            path: entry.path,
            kind: entry.kind,
            mode: entry.mode,
            uid: entry.uid,
            gid: entry.gid,
            reason: entry.reason,
            ...(entry.content_sha256 === undefined ? {} : {
              contentSha256: entry.content_sha256,
              contentBytes: entry.content_bytes,
            }),
          })),
        }),
        selection: {
          kind: result.report.selection.kind,
          requestedPackageCount:
            result.report.selection.requested_packages.length,
          requestedPackagesSha256:
            result.report.selection.requested_packages_sha256,
          ...(result.report.selection.brewfile
            ? { brewfile: result.report.selection.brewfile }
            : {}),
        },
        ...(result.report.materialization === undefined ? {} : {
          materialization: result.report.materialization,
        }),
        ...(shellConfig ? {
          defaultShell: {
            path: shellConfig.config.path,
            argv: shellConfig.config.argv,
            configSha256: shellConfig.sha256,
          },
        } : {}),
        ...(demoConfig ? {
          demoConfig: {
            path: KANDELO_DEMO_CONFIG_PATH,
            sha256: demoConfig.sha256,
            bytes: demoConfig.bytes,
          },
        } : {}),
        packages: plan.packages.map((pkg) => ({
          name: pkg.name,
          fullName: pkg.fullName,
          tapRepository: pkg.tapRepository,
          tapName: pkg.tapName,
          tapCommit: pkg.tapCommit,
          version: pkg.version,
          arch: pkg.arch,
          sourceStatus: pkg.sourceStatus,
          cacheKeySha: pkg.cacheKeySha,
          ...(pkg.builtFrom === undefined ? {} : {
            builtFrom: {
              tapRepository: pkg.builtFrom.tapRepository,
              tapCommit: pkg.builtFrom.tapCommit,
              kandeloRepository: pkg.builtFrom.kandeloRepository,
              kandeloCommit: pkg.builtFrom.kandeloCommit,
              formulaSha256: pkg.builtFrom.formulaSha256,
            },
          }),
        })),
      },
    },
  });
  const imageCapacity = MemoryFileSystem.readImageCapacity(imageBytes);
  if (imageCapacity.maxByteLength !== maxByteLength) {
    throw new Error(
      `saved VFS capacity ${imageCapacity.maxByteLength} does not match ` +
      `the declared consumer contract ${maxByteLength}`,
    );
  }
  let bottleMirrorOutput: unknown;
  if (materializedBuild !== undefined || packageTree !== undefined) {
    const restored = MemoryFileSystem.fromImagePreservingCapacity(imageBytes);
    materializedBuild?.assert(restored);
    if (packageTree !== undefined) {
      assertPackageDeferredZipTreeState(
        restored,
        packageTree.derived,
        packageTree.state,
      );
    }
    if (shellConfig !== undefined) {
      assertShellExecutable(restored, shellConfig.config.path);
      if (restored.isPathDeferred(shellConfig.config.path)) {
        throw new Error(
          `saved default shell must be embedded rather than deferred: ` +
            shellConfig.config.path,
        );
      }
    }
    if (materializedBuild !== undefined) {
      bottleMirrorOutput = materializedBuild.writeBottleMirrorBundle(
        options.bottleMirrorOut!,
      );
    }
  }

  if (options.lazyLayerOut && options.lazyLayerDescriptor) {
    const lazyBase = loadLazyLayerBaseVfs(
      options.lazyLayerBaseImage!,
      options.lazyLayerBasePackageSource!,
      plan.kandeloAbi,
      options.arch,
    );
    const layerFs = createFs(undefined, options.maxBytes, plan.kandeloAbi).fs;
    const layer = await buildHomebrewLazyLayer(plan, {
      fs: layerFs,
      baseVfs: lazyBase,
      acceptanceVfs: {
        sha256: createHash("sha256").update(imageBytes).digest("hex"),
        bytes: imageBytes.byteLength,
      },
      loadBottleBytes: loadPlannedBottle,
      compatibilityPolicy,
      runtimeLayer: {
        id: options.runtimeLayerId!,
        policy: readJsonFile(options.runtimeLayerPolicy!),
      },
    });
    mkdirSync(dirname(options.lazyLayerOut), { recursive: true });
    mkdirSync(dirname(options.lazyLayerDescriptor), { recursive: true });
    const rootPayload = layer.payloads.find((payload) => payload.id === options.runtimeLayerId);
    if (rootPayload === undefined || basename(options.lazyLayerOut) !== rootPayload.asset) {
      throw new Error("Homebrew runtime root payload does not match --lazy-layer-out");
    }
    for (const payload of layer.payloads) {
      writeFileSync(join(dirname(options.lazyLayerOut), payload.asset), payload.bytes);
    }
    writeFileSync(
      options.lazyLayerDescriptor,
      encodeHomebrewLazyLayerDescriptor(layer.descriptor),
    );
    console.log(`Homebrew ${options.runtimeLayerId} runtime layer: ${options.lazyLayerOut}`);
    console.log(
      `Homebrew ${options.runtimeLayerId} runtime layer descriptor: ` +
        options.lazyLayerDescriptor,
    );
  }

  const report = {
    ...result.report,
    ...(shellConfig ? {
      default_shell: {
        path: shellConfig.config.path,
        argv: shellConfig.config.argv,
        config_sha256: shellConfig.sha256,
        config_bytes: shellConfig.bytes,
      },
    } : {}),
    ...(demoConfig ? {
      demo_config: {
        path: KANDELO_DEMO_CONFIG_PATH,
        sha256: demoConfig.sha256,
        bytes: demoConfig.bytes,
      },
    } : {}),
    ...(baseImage ? {
      base_image: {
        ...baseImage.binding,
        metadata: baseImage.metadata,
      },
    } : {}),
    image_capacity: {
      byte_length: imageCapacity.byteLength,
      max_byte_length: imageCapacity.maxByteLength,
    },
    ...(bottleMirrorOutput === undefined ? {} : {
      bottle_mirror: bottleMirrorOutput,
    }),
    ...(packageTree === undefined ? {} : {
      package_deferred_trees: [packageTreeBinding(packageTree)],
    }),
    // Report a reproducible artifact identity, not a runner/worktree path.
    image: basename(options.out),
  };
  mkdirSync(dirname(options.report), { recursive: true });
  writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Homebrew VFS report: ${options.report}`);
}

function parseArgs(args: string[]): CliOptions {
  const options: Partial<CliOptions> & {
    dependencyTapRoots: Record<string, string>;
    packages: string[];
    expectedCacheKeys: Record<string, string>;
  } = {
    packages: [],
    expectedCacheKeys: {},
    dependencyTapRoots: {},
    arch: "wasm32",
    allowFallback: true,
    writeProfile: false,
    materializePackageTree: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--metadata":
        options.metadata = requireValue(args, ++i, arg);
        break;
      case "--tap-root":
        options.tapRoot = requireValue(args, ++i, arg);
        break;
      case "--dependency-tap-root": {
        const value = requireValue(args, ++i, arg);
        const separator = value.indexOf("=");
        const tapName = separator < 0 ? "" : value.slice(0, separator);
        const tapRoot = separator < 0 ? "" : value.slice(separator + 1);
        if (!TAP_NAME_RE.test(tapName) || !tapRoot) {
          usage("--dependency-tap-root must be <owner/tap>=<tap-root>");
        }
        if (options.dependencyTapRoots[tapName] !== undefined) {
          usage(`duplicate --dependency-tap-root for ${tapName}`);
        }
        options.dependencyTapRoots[tapName] = tapRoot;
        break;
      }
      case "--package":
        options.packages.push(requireValue(args, ++i, arg));
        break;
      case "--brewfile":
        if (options.brewfile !== undefined) {
          usage("--brewfile may be provided only once");
        }
        options.brewfile = requireValue(args, ++i, arg);
        break;
      case "--arch":
        options.arch = parseArch(requireValue(args, ++i, arg));
        break;
      case "--runtime":
        options.runtime = parseRuntime(requireValue(args, ++i, arg));
        break;
      case "--out":
        options.out = requireValue(args, ++i, arg);
        break;
      case "--report":
        options.report = requireValue(args, ++i, arg);
        break;
      case "--expected-cache-key": {
        const [name, sha] = requireValue(args, ++i, arg).split("=", 2);
        if (!name || !sha) usage(`--expected-cache-key must be <package>=<sha256>`);
        options.expectedCacheKeys[name] = sha;
        break;
      }
      case "--no-fallback":
        options.allowFallback = false;
        break;
      case "--bottle-cache":
        options.bottleCache = requireValue(args, ++i, arg);
        break;
      case "--base-image":
        options.baseImage = parseBaseImagePath(requireValue(args, ++i, arg));
        break;
      case "--max-bytes":
        options.maxBytes = parseByteSize(requireValue(args, ++i, arg));
        break;
      case "--write-profile":
        options.writeProfile = true;
        break;
      case "--shell-config":
        if (options.shellConfig !== undefined) {
          usage("--shell-config may be provided only once");
        }
        options.shellConfig = requireValue(args, ++i, arg);
        break;
      case "--demo-config":
        if (options.demoConfig !== undefined) {
          usage("--demo-config may be provided only once");
        }
        options.demoConfig = requireValue(args, ++i, arg);
        break;
      case "--catalog-commit":
        if (options.catalogCommit !== undefined) {
          usage("--catalog-commit may be provided only once");
        }
        options.catalogCommit = requireValue(args, ++i, arg);
        break;
      case "--migration-lock":
        if (options.migrationLock !== undefined) {
          usage("--migration-lock may be provided only once");
        }
        options.migrationLock = requireValue(args, ++i, arg);
        break;
      case "--lazy-layer-out":
        if (options.lazyLayerOut !== undefined) {
          usage("--lazy-layer-out may be provided only once");
        }
        options.lazyLayerOut = requireValue(args, ++i, arg);
        break;
      case "--lazy-layer-descriptor":
        if (options.lazyLayerDescriptor !== undefined) {
          usage("--lazy-layer-descriptor may be provided only once");
        }
        options.lazyLayerDescriptor = requireValue(args, ++i, arg);
        break;
      case "--lazy-layer-base-image":
        if (options.lazyLayerBaseImage !== undefined) {
          usage("--lazy-layer-base-image may be provided only once");
        }
        options.lazyLayerBaseImage = parseBaseImagePath(
          requireValue(args, ++i, arg),
        );
        break;
      case "--lazy-layer-base-package-source":
        if (options.lazyLayerBasePackageSource !== undefined) {
          usage("--lazy-layer-base-package-source may be provided only once");
        }
        options.lazyLayerBasePackageSource = requireValue(args, ++i, arg);
        break;
      case "--runtime-layer-id":
        if (options.runtimeLayerId !== undefined) {
          usage("--runtime-layer-id may be provided only once");
        }
        options.runtimeLayerId = requireValue(args, ++i, arg);
        break;
      case "--runtime-layer-policy":
        if (options.runtimeLayerPolicy !== undefined) {
          usage("--runtime-layer-policy may be provided only once");
        }
        options.runtimeLayerPolicy = requireValue(args, ++i, arg);
        break;
      case "--materialization-policy":
        if (options.materializationPolicy !== undefined) {
          usage("--materialization-policy may be provided only once");
        }
        options.materializationPolicy = requireValue(args, ++i, arg);
        break;
      case "--bottle-mirror-repository":
        if (options.bottleMirrorRepository !== undefined) {
          usage("--bottle-mirror-repository may be provided only once");
        }
        options.bottleMirrorRepository = requireValue(args, ++i, arg);
        break;
      case "--bottle-mirror-out":
        if (options.bottleMirrorOut !== undefined) {
          usage("--bottle-mirror-out may be provided only once");
        }
        options.bottleMirrorOut = requireValue(args, ++i, arg);
        break;
      case "--package-tree-spec":
        if (options.packageTreeSpec !== undefined) {
          usage("--package-tree-spec may be provided only once");
        }
        options.packageTreeSpec = requireValue(args, ++i, arg);
        break;
      case "--package-tree-archive":
        if (options.packageTreeArchive !== undefined) {
          usage("--package-tree-archive may be provided only once");
        }
        options.packageTreeArchive = requireValue(args, ++i, arg);
        break;
      case "--materialize-package-tree":
        if (options.materializePackageTree) {
          usage("--materialize-package-tree may be provided only once");
        }
        options.materializePackageTree = true;
        break;
      case "--help":
      case "-h":
        usage(undefined, 0);
        break;
      default:
        usage(`unexpected argument ${arg}`);
    }
  }

  for (const required of ["metadata", "tapRoot", "out", "report"] as const) {
    if (!options[required]) usage(`missing --${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  if (options.brewfile && options.packages.length > 0) {
    usage("--brewfile cannot be combined with --package");
  }
  if (!options.brewfile && options.packages.length === 0) {
    usage("exactly one package selection mode is required: --brewfile or --package");
  }
  if (options.baseImage && !existsSync(options.baseImage)) {
    usage(`base image does not exist: ${options.baseImage}`);
  }
  if (options.shellConfig && !options.writeProfile) {
    usage("--shell-config requires --write-profile so the Homebrew environment is initialized");
  }
  if (options.catalogCommit !== undefined && !GIT_SHA_RE.test(options.catalogCommit)) {
    usage("--catalog-commit must be a lowercase 40-character git SHA");
  }
  if (options.catalogCommit !== undefined && Object.keys(options.dependencyTapRoots).length > 0) {
    usage("--catalog-commit currently supports only a single-tap catalog checkout");
  }
  if (options.migrationLock && !existsSync(options.migrationLock)) {
    usage(`migration lock does not exist: ${options.migrationLock}`);
  }
  if (options.demoConfig && !existsSync(options.demoConfig)) {
    usage(`demo config does not exist: ${options.demoConfig}`);
  }
  const materializationOptionCount = [
    options.materializationPolicy,
    options.bottleMirrorRepository,
    options.bottleMirrorOut,
  ].filter((value) => value !== undefined).length;
  if (materializationOptionCount !== 0 && materializationOptionCount !== 3) {
    usage(
      "--materialization-policy, --bottle-mirror-repository, and " +
        "--bottle-mirror-out must be provided together",
    );
  }
  if (
    options.materializationPolicy !== undefined &&
    !existsSync(options.materializationPolicy)
  ) {
    usage(`materialization policy does not exist: ${options.materializationPolicy}`);
  }
  if (options.bottleMirrorOut !== undefined && existsSync(options.bottleMirrorOut)) {
    usage(`bottle mirror output must not already exist: ${options.bottleMirrorOut}`);
  }
  if (Boolean(options.packageTreeSpec) !== Boolean(options.packageTreeArchive)) {
    usage("--package-tree-spec and --package-tree-archive must be provided together");
  }
  if (options.materializePackageTree && options.packageTreeSpec === undefined) {
    usage("--materialize-package-tree requires a package tree");
  }
  if (options.packageTreeSpec !== undefined && !existsSync(options.packageTreeSpec)) {
    usage(`package tree spec does not exist: ${options.packageTreeSpec}`);
  }
  if (options.packageTreeArchive !== undefined && !existsSync(options.packageTreeArchive)) {
    usage(`package tree archive does not exist: ${options.packageTreeArchive}`);
  }
  if (options.materializationPolicy !== undefined && options.lazyLayerOut !== undefined) {
    usage("materialized shell composition cannot also emit a runtime layer");
  }
  if (Boolean(options.lazyLayerOut) !== Boolean(options.lazyLayerDescriptor)) {
    usage("--lazy-layer-out and --lazy-layer-descriptor must be provided together");
  }
  if (
    options.lazyLayerOut &&
    (!options.lazyLayerBaseImage ||
      !options.lazyLayerBasePackageSource ||
      !options.runtimeLayerId ||
      !options.runtimeLayerPolicy)
  ) {
    usage(
      "lazy layer output requires --lazy-layer-base-image and " +
        "--lazy-layer-base-package-source, --runtime-layer-id, and " +
        "--runtime-layer-policy",
    );
  }
  if (options.lazyLayerBaseImage && !options.lazyLayerOut) {
    usage("--lazy-layer-base-image requires lazy layer outputs");
  }
  if (options.lazyLayerBasePackageSource && !options.lazyLayerOut) {
    usage("--lazy-layer-base-package-source requires lazy layer outputs");
  }
  if (options.runtimeLayerId && !options.lazyLayerOut) {
    usage("--runtime-layer-id requires lazy layer outputs");
  }
  if (options.runtimeLayerPolicy && !options.lazyLayerOut) {
    usage("--runtime-layer-policy requires lazy layer outputs");
  }
  if (options.lazyLayerBaseImage && !existsSync(options.lazyLayerBaseImage)) {
    usage(`lazy layer base image does not exist: ${options.lazyLayerBaseImage}`);
  }
  if (
    options.lazyLayerBasePackageSource &&
    !existsSync(options.lazyLayerBasePackageSource)
  ) {
    usage(
      `lazy layer base package source does not exist: ` +
        options.lazyLayerBasePackageSource,
    );
  }
  if (options.runtimeLayerPolicy && !existsSync(options.runtimeLayerPolicy)) {
    usage(`runtime layer policy does not exist: ${options.runtimeLayerPolicy}`);
  }
  if (options.lazyLayerOut && options.runtimeLayerId) {
    const payloadAsset = homebrewRuntimeLayerPayloadAsset(options.runtimeLayerId);
    const descriptorAsset = homebrewRuntimeLayerDescriptorAsset(
      options.runtimeLayerId,
    );
    if (basename(options.lazyLayerOut) !== payloadAsset) {
      usage(`runtime layer payload must be named ${payloadAsset}`);
    }
    if (basename(options.lazyLayerDescriptor!) !== descriptorAsset) {
      usage(`runtime layer descriptor must be named ${descriptorAsset}`);
    }
  }

  return options as CliOptions;
}

function metadataTapName(value: unknown, path: string): string {
  if (
    !isRecord(value) ||
    typeof value.tap_name !== "string" ||
    !TAP_NAME_RE.test(value.tap_name)
  ) {
    throw new Error(`Homebrew metadata has an invalid tap_name: ${path}`);
  }
  return value.tap_name;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) usage(`${flag} requires a value`);
  return value;
}

function parseArch(value: string): HomebrewBottleArch {
  if (value === "wasm32" || value === "wasm64") return value;
  usage(`--arch must be wasm32 or wasm64, got ${value}`);
}

function parseRuntime(value: string): HomebrewRuntime {
  if (value === "node" || value === "browser") return value;
  usage(`--runtime must be node or browser, got ${value}`);
}

function parseByteSize(value: string): number {
  const match = /^([1-9][0-9]*)([kKmMgG]i?[bB]?|[bB])?$/.exec(value);
  if (!match) usage(`--max-bytes must be a positive byte size, got ${value}`);
  const amount = Number(match[1]);
  const suffix = (match[2] ?? "b").toLowerCase();
  const multiplier = suffix.startsWith("g") ? 1024 ** 3
    : suffix.startsWith("m") ? 1024 ** 2
    : suffix.startsWith("k") ? 1024
    : 1;
  const bytes = amount * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    usage(`--max-bytes is too large: ${value}`);
  }
  if (bytes % SHARED_FS_BLOCK_BYTES !== 0) {
    usage(`--max-bytes must be a multiple of ${SHARED_FS_BLOCK_BYTES} bytes`);
  }
  return bytes;
}

function parseBaseImagePath(value: string): string {
  if (!value.endsWith(".vfs") && !value.endsWith(".vfs.zst")) {
    usage(`--base-image must end in .vfs or .vfs.zst, got ${value}`);
  }
  return value;
}

function readPackageTreeArchive(path: string): Uint8Array {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error(`package tree archive is not a nonempty regular file: ${path}`);
  }
  return new Uint8Array(readFileSync(path));
}

function packageTreeBinding(tree: {
  derived: DerivedPackageDeferredZipTree;
  state: "deferred" | "materialized";
}) {
  const descriptor = tree.derived.descriptor;
  return {
    schema: descriptor.schema,
    kind: descriptor.kind,
    id: descriptor.id,
    content_role: descriptor.content_role,
    package: descriptor.package,
    descriptor: {
      sha256: tree.derived.descriptorSha256,
      bytes: tree.derived.descriptorBytes.byteLength,
    },
    archive: {
      output: descriptor.package.output,
      url: descriptor.archive.url,
      sha256: descriptor.archive.sha256,
      bytes: descriptor.archive.bytes,
      expanded_bytes: descriptor.archive.expanded_bytes,
      source_entry_count: descriptor.archive.source_entry_count,
    },
    mount_prefix: descriptor.mount_prefix,
    owner: descriptor.owner,
    activation: descriptor.activation,
    state: tree.state,
  };
}

function createFs(
  baseImage: string | undefined,
  maxBytes: number | undefined,
  expectedAbi: number,
): { fs: MemoryFileSystem; baseImage?: LoadedBaseImage; maxByteLength: number } {
  if (baseImage) {
    const image = new Uint8Array(readFileSync(baseImage));
    const restored = MemoryFileSystem.fromImagePreservingCapacity(image);
    const metadata = restored.getImageMetadata();
    if (metadata?.kernelAbi === undefined) {
      throw new Error(
        `base image ${baseImage} does not declare its required kernel ABI`,
      );
    }
    if (metadata.kernelAbi !== expectedAbi) {
      throw new Error(
        `base image ${baseImage} declares kernel ABI ${metadata.kernelAbi}, ` +
        `but bottle metadata requires ABI ${expectedAbi}`,
      );
    }
    if (
      metadata.homebrew !== undefined ||
      vfsPathExists(restored, HOMEBREW_COMPOSITION_PATH)
    ) {
      throw new Error(
        `base image ${baseImage} already contains a Homebrew composition; ` +
        "use a platform-only base image",
      );
    }

    const loadedBase: LoadedBaseImage = {
      binding: {
        sha256: createHash("sha256").update(image).digest("hex"),
        bytes: image.byteLength,
        kernelAbi: metadata.kernelAbi,
      },
      metadata,
    };
    const recordedMaxBytes =
      MemoryFileSystem.readImageCapacity(image).maxByteLength;
    if (!Number.isSafeInteger(recordedMaxBytes) || recordedMaxBytes <= 0) {
      throw new Error(
        `base image ${baseImage} declares an invalid filesystem capacity`,
      );
    }

    const targetMaxBytes = maxBytes ?? recordedMaxBytes;
    if (targetMaxBytes !== recordedMaxBytes) {
      console.log(
        `Rebasing base VFS capacity from ${formatMib(recordedMaxBytes)} ` +
        `to ${formatMib(targetMaxBytes)}...`,
      );
      return {
        fs: restored.rebaseToNewFileSystem(targetMaxBytes),
        baseImage: loadedBase,
        maxByteLength: targetMaxBytes,
      };
    }
    return {
      fs: restored,
      baseImage: loadedBase,
      maxByteLength: targetMaxBytes,
    };
  }

  const initialBytes = maxBytes ?? DEFAULT_MAX_BYTES;
  const SharedArrayBufferCtor = SharedArrayBuffer as new (
    byteLength: number,
    options?: { maxByteLength?: number },
  ) => SharedArrayBuffer;
  const sab = new SharedArrayBufferCtor(initialBytes, {
    maxByteLength: initialBytes,
  });
  return {
    fs: MemoryFileSystem.create(sab, initialBytes),
    maxByteLength: initialBytes,
  };
}

function loadLazyLayerBaseVfs(
  path: string,
  packageSourcePath: string,
  expectedAbi: number,
  expectedArch: HomebrewBottleArch,
): {
  fs: MemoryFileSystem;
  image: { sha256: string; bytes: number };
  source: ReturnType<typeof parseHomebrewLazyLayerBasePackageSource>;
} {
  const image = new Uint8Array(readFileSync(path));
  const source = parseHomebrewLazyLayerBasePackageSource(
    readJsonFile(packageSourcePath),
    expectedArch,
    expectedAbi,
  );
  const imageBinding = {
    sha256: createHash("sha256").update(image).digest("hex"),
    bytes: image.byteLength,
  };
  if (
    source.output.sha256 !== imageBinding.sha256 ||
    source.output.bytes !== imageBinding.bytes
  ) {
    throw new Error(
      `lazy layer base image ${path} does not match package source ` +
        packageSourcePath,
    );
  }
  const fs = MemoryFileSystem.fromImagePreservingCapacity(image);
  const metadata = fs.getImageMetadata();
  if (metadata?.kernelAbi !== expectedAbi) {
    throw new Error(
      `lazy layer base image ${path} declares kernel ABI ` +
        `${String(metadata?.kernelAbi)}, but bottle metadata requires ABI ${expectedAbi}`,
    );
  }
  if (
    metadata.homebrew === undefined ||
    !vfsPathExists(fs, HOMEBREW_COMPOSITION_PATH)
  ) {
    throw new Error(
      `lazy layer base image ${path} is not a bottle-built Homebrew composition`,
    );
  }
  return {
    fs,
    image: imageBinding,
    source,
  };
}

function formatMib(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MiB`;
}

function vfsPathExists(fs: MemoryFileSystem, path: string): boolean {
  try {
    fs.lstat(path);
    return true;
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === -2
    ) {
      return false;
    }
    throw err;
  }
}

function readJsonFile(path: string): unknown {
  const bytes = readBoundedRegularFile(
    path,
    MAX_SIDECAR_JSON_BYTES,
    "Homebrew sidecar JSON",
  );
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function readMigrationLock(path: string): LoadedMigrationLock {
  const source = readBoundedRegularFile(
    path,
    MAX_MIGRATION_LOCK_BYTES,
    "Homebrew migration lock",
  );
  return {
    value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source)),
    sha256: createHash("sha256").update(source).digest("hex"),
    bytes: source.byteLength,
  };
}

function migrationLockCompatibilityPolicy(
  value: unknown,
  path: string,
): HomebrewVfsCompatibilityPolicy {
  if (!isRecord(value) || value.schema !== 1 || !isRecord(value.compatibility)) {
    throw new Error(`Homebrew migration lock has an invalid schema: ${path}`);
  }
  const compatibility = value.compatibility;
  if (
    !isRecord(compatibility.mirror_link_manifest_bin) ||
    !Array.isArray(compatibility.mirror_link_manifest_bin.targets) ||
    !compatibility.mirror_link_manifest_bin.targets.every(
      (entry) => typeof entry === "string",
    ) ||
    !Array.isArray(compatibility.link_conflict_owners) ||
    !Array.isArray(compatibility.aliases) ||
    (compatibility.runtime_state !== undefined &&
      !Array.isArray(compatibility.runtime_state))
  ) {
    throw new Error(`Homebrew migration lock has an invalid compatibility policy: ${path}`);
  }
  const linkConflictOwners = compatibility.link_conflict_owners.map((value, index) => {
    if (
      !isRecord(value) ||
      typeof value.target !== "string" ||
      typeof value.package !== "string" ||
      typeof value.reason !== "string"
    ) {
      throw new Error(
        `Homebrew migration lock compatibility.link_conflict_owners[${index}] is invalid: ${path}`,
      );
    }
    return {
      target: value.target,
      package: value.package,
      reason: value.reason,
    };
  });
  const aliases = compatibility.aliases.map<
    HomebrewVfsCompatibilityPolicy["aliases"][number]
  >((value, index) => {
    if (
      !isRecord(value) ||
      typeof value.package !== "string" ||
      (value.source_kind !== "link" && value.source_kind !== "keg") ||
      typeof value.source !== "string" ||
      !Array.isArray(value.targets) ||
      !value.targets.every((entry) => typeof entry === "string")
    ) {
      throw new Error(
        `Homebrew migration lock compatibility.aliases[${index}] is invalid: ${path}`,
      );
    }
    return {
      package: value.package,
      source_kind: value.source_kind,
      source: value.source,
      targets: [...value.targets],
    };
  });
  const runtimeState = (compatibility.runtime_state ?? []).map<
    HomebrewVfsRuntimeStateDeclaration
  >((value, index) => {
    if (!isRecord(value)) {
      throw new Error(
        `Homebrew migration lock compatibility.runtime_state[${index}] is invalid: ${path}`,
      );
    }
    const expectedKeys = [
      "gid",
      "kind",
      "mode",
      "path",
      "reason",
      "requires_package",
      "uid",
    ];
    if (value.kind === "text_file") expectedKeys.push("contents");
    if (
      Object.keys(value).sort().join("\0") !== expectedKeys.sort().join("\0") ||
      typeof value.requires_package !== "string" ||
      typeof value.path !== "string" ||
      (value.kind !== "directory" &&
        value.kind !== "empty_file" &&
        value.kind !== "text_file") ||
      typeof value.mode !== "number" ||
      typeof value.uid !== "number" ||
      typeof value.gid !== "number" ||
      typeof value.reason !== "string" ||
      (value.kind === "text_file" && typeof value.contents !== "string")
    ) {
      throw new Error(
        `Homebrew migration lock compatibility.runtime_state[${index}] is invalid: ${path}`,
      );
    }
    return {
      requires_package: value.requires_package,
      path: value.path,
      kind: value.kind,
      mode: value.mode,
      uid: value.uid,
      gid: value.gid,
      reason: value.reason,
      ...(value.kind === "text_file" ? { contents: value.contents as string } : {}),
    };
  });
  return {
    mirror_link_manifest_bin: {
      targets: [...compatibility.mirror_link_manifest_bin.targets] as string[],
    },
    link_conflict_owners: linkConflictOwners,
    aliases,
    runtime_state: runtimeState,
  };
}

function readShellConfig(path: string): LoadedShellConfig {
  const bytes = readBoundedRegularFile(
    path,
    MAX_KANDELO_SHELL_CONFIG_BYTES,
    "Kandelo default shell config",
  );
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const config = parseKandeloShellConfig(source);
  if (!config) {
    throw new Error(`Kandelo default shell config has an unsupported version: ${path}`);
  }
  return {
    config,
    source: bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

function readDemoConfig(path: string): LoadedDemoConfig {
  const bytes = readBoundedRegularFile(
    path,
    MAX_KANDELO_DEMO_CONFIG_BYTES,
    "Kandelo demo config",
  );
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Kandelo demo config is not valid UTF-8: ${path}`);
  }
  let config: KandeloDemoConfig | null;
  try {
    config = parseKandeloDemoConfig(source);
  } catch {
    throw new Error(`Kandelo demo config is not valid JSON: ${path}`);
  }
  if (config === null) {
    throw new Error(`Kandelo demo config has an unsupported version: ${path}`);
  }
  try {
    validateKandeloDemoConfig(config);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Kandelo demo config is invalid: ${path}: ${detail}`);
  }
  return {
    config,
    source: bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
  };
}

function assertShellExecutable(fs: MemoryFileSystem, path: string): void {
  let stat;
  try {
    stat = fs.stat(path);
  } catch {
    throw new Error(`default shell executable is missing from the composed VFS: ${path}`);
  }
  if ((stat.mode & 0xf000) !== 0x8000) {
    throw new Error(`default shell path is not a regular file in the composed VFS: ${path}`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`default shell is not executable in the composed VFS: ${path}`);
  }
  if (stat.size > MAX_KANDELO_SHELL_EXECUTABLE_BYTES) {
    throw new Error(
      `default shell exceeds ${MAX_KANDELO_SHELL_EXECUTABLE_BYTES} bytes in the composed VFS: ${path}`,
    );
  }
}

function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
): Uint8Array {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
  if (stat.size > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes: ${path}`);
  }
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes: ${path}`);
  }
  return bytes;
}

function readBrewfileSelection(path: string): BrewfileSelection {
  const parsed = spawnSync("ruby", [BREWFILE_PARSER, path], {
    encoding: "utf8",
    maxBuffer: MAX_BREWFILE_PARSER_OUTPUT_BYTES,
  });
  if (parsed.error) {
    throw new Error(`cannot parse Brewfile ${path}: ${parsed.error.message}`);
  }
  if (parsed.status !== 0) {
    const detail = parsed.stderr.trim() ||
      `parser exited with status ${String(parsed.status)}`;
    throw new Error(`cannot parse Brewfile ${path}: ${detail}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(parsed.stdout);
  } catch {
    throw new Error(`Brewfile parser returned invalid JSON for ${path}`);
  }
  if (!isRecord(value)) {
    throw new Error(`Brewfile parser returned a non-object for ${path}`);
  }
  const expectedKeys = ["bytes", "kind", "packages", "schema", "sha256", "tap_name"];
  if (Object.keys(value).sort().join("\0") !== expectedKeys.join("\0")) {
    throw new Error(`Brewfile parser returned an unsupported result shape for ${path}`);
  }
  if (value.schema !== 1 || value.kind !== "kandelo-static-brewfile-v1") {
    throw new Error(`Brewfile parser returned an unsupported schema for ${path}`);
  }
  if (typeof value.tap_name !== "string" || !TAP_NAME_RE.test(value.tap_name)) {
    throw new Error(`Brewfile parser returned an invalid tap name for ${path}`);
  }
  if (typeof value.sha256 !== "string" || !SHA256_RE.test(value.sha256)) {
    throw new Error(`Brewfile parser returned an invalid sha256 for ${path}`);
  }
  if (
    typeof value.bytes !== "number" ||
    !Number.isInteger(value.bytes) ||
    value.bytes <= 0 ||
    value.bytes > MAX_BREWFILE_BYTES
  ) {
    throw new Error(`Brewfile parser returned an invalid byte count for ${path}`);
  }
  if (
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    value.packages.length > MAX_BREWFILE_PACKAGES ||
    value.packages.some((pkg) =>
      typeof pkg !== "string" || !PACKAGE_NAME_RE.test(pkg)
    ) ||
    new Set(value.packages).size !== value.packages.length
  ) {
    throw new Error(`Brewfile parser returned invalid requested packages for ${path}`);
  }
  return value as unknown as BrewfileSelection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadBottleBytes(
  pkg: HomebrewVfsPackagePlan,
  options: CliOptions,
): Promise<Uint8Array> {
  if (pkg.url.startsWith("file://")) {
    return new Uint8Array(readFileSync(fileURLToPath(pkg.url)));
  }

  const cachePath = options.bottleCache
    ? join(options.bottleCache, `${pkg.sha256}.tar.gz`)
    : undefined;
  if (cachePath && existsSync(cachePath)) {
    return new Uint8Array(readFileSync(cachePath));
  }

  if (!pkg.url.startsWith("https://")) {
    throw new Error(
      `package ${pkg.name}@${pkg.version} bottle URL must be https:// or file://, got ${pkg.url}`,
    );
  }

  const bytes = await fetchHomebrewBottleBytes(pkg.url);
  if (cachePath) {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, bytes);
  }
  return bytes;
}

function usage(message?: string, code = 2): never {
  if (message) console.error(`build-homebrew-vfs-image: ${message}`);
  console.error(`usage: npx tsx images/vfs/scripts/build-homebrew-vfs-image.ts \\
  --metadata <Kandelo/metadata.json> \\
  --tap-root <tap-root> \\
  [--dependency-tap-root <owner/tap>=<tap-root> ...] \\
  (--brewfile <Brewfile> | --package <name> [--package <name> ...]) \\
  --arch <wasm32|wasm64> [--runtime <node|browser>] \\
  --out <image.vfs.zst> \\
  --report <report.json> \\
  [--expected-cache-key <name>=<sha256>] [--no-fallback] \\
  [--bottle-cache <dir>] [--base-image <base.vfs[.zst]>] \\
  [--max-bytes <bytes|MiB>] [--write-profile] \\
  [--shell-config <shell.json>] [--demo-config <demo.json>] \\
  [--catalog-commit <full-sha>] \\
  [--migration-lock <lock.json>] \\
  [--materialization-policy <policy.json> \\
   --bottle-mirror-repository <owner/repository> \\
   --bottle-mirror-out <new-directory>] \\
  [--package-tree-spec <tree.json> \\
   --package-tree-archive <package-output.zip> \\
   [--materialize-package-tree]] \\
  [--lazy-layer-out <layer.bin> \\
   --lazy-layer-descriptor <layer.json> \\
   --lazy-layer-base-image <main-shell.vfs[.zst]> \\
   --lazy-layer-base-package-source <source.json> \\
   --runtime-layer-id <id> \\
   --runtime-layer-policy <policy.json>]`);
  process.exit(code);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  runHomebrewVfsImageBuilder(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
