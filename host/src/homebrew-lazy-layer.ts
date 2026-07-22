import { createHash } from "node:crypto";
import { zipSync, type Zippable } from "fflate";
import { buildHomebrewVfs } from "./homebrew-vfs-builder";
import type {
  HomebrewFederatedVfsPlan,
  HomebrewVfsPackagePlan,
  HomebrewVfsPlan,
  HomebrewVfsTapIdentity,
} from "./homebrew-vfs-planner";
import {
  projectHomebrewRuntimeLayerPlan,
  selectHomebrewRuntimeLayer,
} from "./homebrew-runtime-layer-policy";
import type {
  HomebrewDeferredTreeDescriptor,
  HomebrewLazyLayerBasePackageSource,
  HomebrewLazyLayerDescriptor,
  HomebrewLazyLayerEntry,
  HomebrewLazyLayerPackageRecord,
} from "./homebrew-lazy-layer-descriptor";
export type {
  HomebrewDeferredTreeDescriptor,
  HomebrewLazyLayerBasePackageSource,
  HomebrewLazyLayerDescriptor,
  HomebrewLazyLayerEntry,
  HomebrewLazyLayerPackageRecord,
} from "./homebrew-lazy-layer-descriptor";
import { MemoryFileSystem } from "./vfs/memory-fs";

export function homebrewRuntimeLayerPayloadAsset(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`invalid Homebrew runtime layer id ${id}`);
  }
  return `kandelo-homebrew-${id}-layer.bin`;
}

export function homebrewRuntimeLayerDescriptorAsset(id: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`invalid Homebrew runtime layer id ${id}`);
  }
  return `kandelo-homebrew-${id}-layer.json`;
}

const HOMEBREW_VFS_ASSET = "kandelo-homebrew.vfs.zst";
const HOMEBREW_COMPOSITION_PATH = "/etc/kandelo/homebrew-vfs.json";
const HOME_BREW_PREFIX = "/home/linuxbrew/.linuxbrew";
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0);
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;
const MAX_LAYER_ENTRIES = 100_000;
const MAX_LAYER_PATH_BYTES = 4096;
const MAX_SYMLINK_TARGET_BYTES = 65_536;
const MAX_COMPOSITION_BYTES = 16 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;

export interface HomebrewLazyLayerImageSource {
  sha256: string;
  bytes: number;
}

export interface HomebrewLazyLayerBaseVfs {
  fs: MemoryFileSystem;
  image: HomebrewLazyLayerImageSource;
  source: HomebrewLazyLayerBasePackageSource;
}

export interface BuildHomebrewLazyLayerOptions {
  /** Fresh filesystem that will contain only layer-owned package output. */
  fs: MemoryFileSystem;
  /** Exact bottle-built shell image that will own the lower filesystem. */
  baseVfs: HomebrewLazyLayerBaseVfs;
  /** Browser-proven eager image whose immutable release carries this layer. */
  acceptanceVfs: HomebrewLazyLayerImageSource;
  loadBottleBytes: (
    pkg: HomebrewVfsPackagePlan,
  ) => Uint8Array | Promise<Uint8Array>;
  /** Reviewed policy selection required for independently composable runtimes. */
  runtimeLayer: { id: string; policy: unknown };
}

export interface HomebrewLazyLayerBuildResult {
  /** Format-neutral immutable bytes described by `deferred_trees[0]`. */
  payload: Uint8Array;
  descriptor: HomebrewLazyLayerDescriptor;
}

interface ParsedBaseComposition {
  source: Uint8Array;
  packages: Map<string, Record<string, unknown>>;
  packageOrder: string[];
  requestedPackagesSha256: string;
  packageSetSha256: string;
  kernelAbi: number;
}

/**
 * Build a lazy runtime layer above one exact bottle-built main-shell image.
 *
 * The lower image is authoritative. A dependency already present there is
 * reused only when its complete poured-artifact identity matches the current
 * plan. Every non-directory archive path must be absent from the lower image;
 * only common ancestor directories may be shared. This keeps profile and
 * composition metadata in the base and makes an attempted replacement fail
 * instead of silently masking lower filesystem state.
 */
export async function buildHomebrewLazyLayer(
  plan: HomebrewVfsPlan,
  options: BuildHomebrewLazyLayerOptions,
): Promise<HomebrewLazyLayerBuildResult> {
  if (options.fs === options.baseVfs.fs) {
    throw new Error("Homebrew lazy layer requires separate base and layer filesystems");
  }
  assertImageSource(options.baseVfs.image, "base VFS");
  assertImageSource(options.acceptanceVfs, "acceptance VFS");
  const arch = commonArch(plan);
  const basePackageSource = parseHomebrewLazyLayerBasePackageSource(
    options.baseVfs.source,
    arch,
    plan.kandeloAbi,
  );
  if (
    basePackageSource.output.sha256 !== options.baseVfs.image.sha256 ||
    basePackageSource.output.bytes !== options.baseVfs.image.bytes
  ) {
    throw new Error(
      "Homebrew lazy layer base bytes do not match their canonical package output",
    );
  }
  const base = parseBaseComposition(options.baseVfs, plan.kandeloAbi);
  const runtimeSelection = selectHomebrewRuntimeLayer(
    plan,
    {
      source: basePackageSource,
      packageOrder: base.packageOrder,
    },
    options.runtimeLayer.policy,
    options.runtimeLayer.id,
  );
  const selectedPlan = projectHomebrewRuntimeLayerPlan(plan, runtimeSelection);
  const tapLock = planTapLock(selectedPlan);
  validatePackageTapOwnership(selectedPlan.packages, tapLock);
  const basePackages: HomebrewVfsPackagePlan[] = [];
  const layerPackages: HomebrewVfsPackagePlan[] = [];

  for (const pkg of selectedPlan.packages) {
    const existing = base.packages.get(pkg.fullName);
    if (existing === undefined) {
      layerPackages.push(pkg);
      continue;
    }
    assertBasePackageMatches(existing, pkg);
    basePackages.push(pkg);
  }
  if (layerPackages.length === 0) {
    throw new Error(
      "Homebrew lazy layer selection is already completely owned by the base VFS",
    );
  }

  const layerPlan: HomebrewVfsPlan = {
    ...selectedPlan,
    packages: layerPackages,
  };
  await buildHomebrewVfs(layerPlan, {
    fs: options.fs,
    loadBottleBytes: options.loadBottleBytes,
    writeProfile: false,
    createdBy: "host/src/homebrew-lazy-layer.ts",
  });

  const entries = collectLayerEntries(options.fs, options.baseVfs.fs);
  // ZIP remains a temporary deterministic producer fixture. The public
  // descriptor identifies bytes by decoder/media type and never by filename.
  const payload = createLayerZip(options.fs, entries);
  const payloadSha = digest(payload);
  const releaseTag = `homebrew-vfs-sha256-${options.acceptanceVfs.sha256}`;
  const releaseRoot =
    `https://github.com/${selectedPlan.tapRepository}/releases/download/${releaseTag}`;
  const payloadAsset = homebrewRuntimeLayerPayloadAsset(runtimeSelection.id);
  const baseRecords = basePackages.map(packageRecord);
  const layerRecords = layerPackages.map(packageRecord);
  const runtimeRoot = layerRecords.find((pkg) => pkg.name === runtimeSelection.id);
  if (!runtimeRoot) {
    throw new Error(
      `Homebrew runtime layer ${runtimeSelection.id} has no layer-owned root record`,
    );
  }

  return {
    payload,
    descriptor: {
      schema: 3,
      kind: "kandelo-homebrew-deferred-layer",
      arch,
      mount_prefix: "/",
      tap: {
        repository: selectedPlan.tapRepository,
        name: selectedPlan.tapName,
        commit: selectedPlan.tapCommit,
      },
      tap_lock: tapLock.map((tap) => ({
        repository: tap.tapRepository,
        name: tap.tapName,
        commit: tap.tapCommit,
        kandelo_repository: tap.kandeloRepository,
        kandelo_commit: tap.kandeloCommit,
        kandelo_abi: tap.kandeloAbi,
        bottle_release_tag: tap.releaseTag,
      })),
      kandelo: {
        repository: selectedPlan.kandeloRepository,
        commit: selectedPlan.kandeloCommit,
        abi: selectedPlan.kandeloAbi,
      },
      bottle_release_tag: selectedPlan.releaseTag,
      selection: {
        requested_packages: [...selectedPlan.requestedPackages],
        package_order: selectedPlan.packages.map((pkg) => pkg.fullName),
        base_package_order: basePackages.map((pkg) => pkg.fullName),
        layer_package_order: layerPackages.map((pkg) => pkg.fullName),
      },
      packages: {
        base: baseRecords,
        layer: layerRecords,
      },
      base_vfs: {
        sha256: options.baseVfs.image.sha256,
        bytes: options.baseVfs.image.bytes,
        kernel_abi: base.kernelAbi,
        package_source: basePackageSource,
        composition: {
          path: HOMEBREW_COMPOSITION_PATH,
          sha256: digest(base.source),
          bytes: base.source.byteLength,
          requested_packages_sha256: base.requestedPackagesSha256,
          package_set_sha256: base.packageSetSha256,
          package_count: base.packageOrder.length,
          package_order: base.packageOrder,
        },
      },
      release: {
        repository: selectedPlan.tapRepository,
        tag: releaseTag,
      },
      acceptance_vfs: {
        asset: HOMEBREW_VFS_ASSET,
        url: `${releaseRoot}/${HOMEBREW_VFS_ASSET}`,
        sha256: options.acceptanceVfs.sha256,
        bytes: options.acceptanceVfs.bytes,
      },
      deferred_trees: [createDeferredTreeDescriptor(
        runtimeSelection.id,
        runtimeRoot.keg,
        `${releaseRoot}/${payloadAsset}`,
        payloadSha,
        payload.byteLength,
        entries,
      )],
    },
  };
}

function createDeferredTreeDescriptor(
  id: string,
  capabilityRoot: string,
  transportUrl: string,
  sha256: string,
  bytes: number,
  entries: HomebrewLazyLayerEntry[],
): HomebrewDeferredTreeDescriptor {
  const regularGroups = new Set(
    entries.flatMap((entry) => entry.inode_group ? [entry.inode_group] : []),
  );
  const canonicalFiles = entries.filter((entry) => entry.type === "file");
  return {
    id,
    activation: {
      mode: "first-use",
      capabilities: [`homebrew-runtime:${id}`],
      roots: [capabilityRoot],
    },
    content: {
      media_type: "application/zip",
      decoder: "zip-v1",
      sha256,
      bytes,
    },
    transports: [{ url: transportUrl }],
    inventory: {
      entry_count: entries.length,
      source_entry_count: new Set(entries.map((entry) => entry.source_path)).size,
      regular_inode_count: regularGroups.size,
      layer_entry_count: entries.filter((entry) => entry.ownership === "layer").length,
      shared_base_directory_count: entries.filter(
        (entry) => entry.ownership === "shared-base-directory",
      ).length,
      expanded_bytes: entries
        .filter((entry) => entry.type !== "hardlink")
        .reduce((total, entry) => total + entry.size, 0),
      payload_bytes: canonicalFiles.reduce((total, entry) => total + entry.size, 0),
      entries,
    },
  };
}

export function parseHomebrewLazyLayerBasePackageSource(
  value: unknown,
  expectedArch?: "wasm32" | "wasm64",
  expectedAbi?: number,
): HomebrewLazyLayerBasePackageSource {
  const root = requireExactRecord(
    value,
    ["schema", "kind", "index", "package", "archive", "output"],
    "Homebrew lazy layer base package source",
  );
  if (root.schema !== 1 || root.kind !== "kandelo-package-output") {
    throw new Error("Homebrew lazy layer base package source has an unsupported identity");
  }
  const index = requireExactRecord(
    root.index,
    ["url", "sha256", "bytes", "abi"],
    "Homebrew lazy layer base package index",
  );
  const packageEntry = requireExactRecord(
    root.package,
    ["name", "version", "revision", "arch", "cache_key_sha"],
    "Homebrew lazy layer base package entry",
  );
  const archive = requireExactRecord(
    root.archive,
    ["format", "url", "sha256", "bytes"],
    "Homebrew lazy layer base package archive",
  );
  const output = requireExactRecord(
    root.output,
    ["name", "path", "sha256", "bytes"],
    "Homebrew lazy layer base package output",
  );
  const arch = requireArch(packageEntry.arch, "Homebrew lazy layer base package arch");
  const abi = requirePositiveInteger(index.abi, "Homebrew lazy layer base package index ABI");
  if (expectedArch !== undefined && arch !== expectedArch) {
    throw new Error(
      `Homebrew lazy layer base package arch ${arch} does not match planned arch ${expectedArch}`,
    );
  }
  if (expectedAbi !== undefined && abi !== expectedAbi) {
    throw new Error(
      `Homebrew lazy layer base package index ABI ${abi} does not match planned ABI ${expectedAbi}`,
    );
  }
  if (archive.format !== "kandelo-package-tar-zstd-v2") {
    throw new Error("Homebrew lazy layer base package archive format is unsupported");
  }
  const outputPath = requireSafeRelativePath(
    output.path,
    "Homebrew lazy layer base package output path",
  );
  return {
    schema: 1,
    kind: "kandelo-package-output",
    index: {
      url: requireHttpsUrl(index.url, "Homebrew lazy layer base package index URL"),
      sha256: requireSha256(index.sha256, "Homebrew lazy layer base package index sha256"),
      bytes: requirePositiveInteger(index.bytes, "Homebrew lazy layer base package index bytes"),
      abi,
    },
    package: {
      name: requirePackageName(packageEntry.name, "Homebrew lazy layer base package name"),
      version: requireString(packageEntry.version, "Homebrew lazy layer base package version"),
      revision: requirePositiveInteger(
        packageEntry.revision,
        "Homebrew lazy layer base package revision",
      ),
      arch,
      cache_key_sha: requireSha256(
        packageEntry.cache_key_sha,
        "Homebrew lazy layer base package cache key",
      ),
    },
    archive: {
      format: "kandelo-package-tar-zstd-v2",
      url: requireHttpsUrl(archive.url, "Homebrew lazy layer base package archive URL"),
      sha256: requireSha256(
        archive.sha256,
        "Homebrew lazy layer base package archive sha256",
      ),
      bytes: requirePositiveInteger(
        archive.bytes,
        "Homebrew lazy layer base package archive bytes",
      ),
    },
    output: {
      name: requirePackageName(output.name, "Homebrew lazy layer base package output name"),
      path: outputPath,
      sha256: requireSha256(
        output.sha256,
        "Homebrew lazy layer base package output sha256",
      ),
      bytes: requirePositiveInteger(
        output.bytes,
        "Homebrew lazy layer base package output bytes",
      ),
    },
  };
}

export function encodeHomebrewLazyLayerDescriptor(
  descriptor: HomebrewLazyLayerDescriptor,
): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(descriptor, null, 2)}\n`);
}

function assertImageSource(
  source: HomebrewLazyLayerImageSource,
  label: string,
): void {
  if (!SHA256_RE.test(source.sha256)) {
    throw new Error(`Homebrew lazy layer ${label} sha256 is invalid`);
  }
  if (!Number.isSafeInteger(source.bytes) || source.bytes <= 0) {
    throw new Error(`Homebrew lazy layer ${label} byte count is invalid`);
  }
}

function commonArch(plan: HomebrewVfsPlan): "wasm32" | "wasm64" {
  const arch = plan.packages[0]?.arch;
  if (arch === undefined || plan.packages.some((pkg) => pkg.arch !== arch)) {
    throw new Error("Homebrew lazy layer plan must have one non-empty architecture");
  }
  return arch;
}

function planTapLock(plan: HomebrewVfsPlan): HomebrewVfsTapIdentity[] {
  const federated = plan as Partial<HomebrewFederatedVfsPlan>;
  const candidates = Array.isArray(federated.taps)
    ? federated.taps
    : [{
      tapRepository: plan.tapRepository,
      tapName: plan.tapName,
      tapCommit: plan.tapCommit,
      kandeloRepository: plan.kandeloRepository,
      kandeloCommit: plan.kandeloCommit,
      kandeloAbi: plan.kandeloAbi,
      releaseTag: plan.releaseTag,
    }];
  const byName = new Map<string, HomebrewVfsTapIdentity>();
  const byRepository = new Map<string, string>();
  for (const tap of candidates) {
    if (
      typeof tap.tapRepository !== "string" ||
      typeof tap.tapName !== "string" ||
      !GIT_SHA_RE.test(tap.tapCommit) ||
      typeof tap.kandeloRepository !== "string" ||
      !GIT_SHA_RE.test(tap.kandeloCommit) ||
      tap.kandeloAbi !== plan.kandeloAbi ||
      typeof tap.releaseTag !== "string" ||
      tap.releaseTag.length === 0
    ) {
      throw new Error("Homebrew lazy layer tap lock is invalid");
    }
    const repository = tap.tapRepository.toLowerCase();
    if (byName.has(tap.tapName) || byRepository.has(repository)) {
      throw new Error("Homebrew lazy layer tap lock has duplicate tap identity");
    }
    byName.set(tap.tapName, tap);
    byRepository.set(repository, tap.tapName);
  }
  const root = byName.get(plan.tapName);
  if (
    root === undefined ||
    root.tapRepository.toLowerCase() !== plan.tapRepository.toLowerCase() ||
    root.tapCommit !== plan.tapCommit
  ) {
    throw new Error("Homebrew lazy layer tap lock does not contain the exact root tap");
  }
  return [...candidates].sort((left, right) => compareText(left.tapName, right.tapName));
}

function validatePackageTapOwnership(
  packages: readonly HomebrewVfsPackagePlan[],
  tapLock: readonly HomebrewVfsTapIdentity[],
): void {
  const taps = new Map(tapLock.map((tap) => [tap.tapName, tap]));
  for (const pkg of packages) {
    const tap = taps.get(pkg.tapName);
    if (
      tap === undefined ||
      tap.tapRepository.toLowerCase() !== pkg.tapRepository.toLowerCase() ||
      pkg.fullName !== `${pkg.tapName}/${pkg.name}` ||
      pkg.kandeloAbi !== tap.kandeloAbi
    ) {
      throw new Error(
        `Homebrew lazy layer package ${pkg.fullName} is not owned by its exact locked tap`,
      );
    }
    if (!GIT_SHA_RE.test(pkg.tapCommit) || !GIT_SHA_RE.test(pkg.kandeloCommit)) {
      throw new Error(
        `Homebrew lazy layer package ${pkg.fullName} has invalid build provenance`,
      );
    }
    if (pkg.builtFrom === undefined) {
      if (
        pkg.tapCommit !== tap.tapCommit ||
        pkg.kandeloRepository.toLowerCase() !== tap.kandeloRepository.toLowerCase() ||
        pkg.kandeloCommit !== tap.kandeloCommit
      ) {
        throw new Error(
          `Homebrew lazy layer package ${pkg.fullName} does not match its locked tap snapshot`,
        );
      }
      continue;
    }
    if (
      pkg.builtFrom.tapRepository.toLowerCase() !== tap.tapRepository.toLowerCase() ||
      pkg.tapCommit !== pkg.builtFrom.tapCommit ||
      pkg.kandeloRepository.toLowerCase() !==
        pkg.builtFrom.kandeloRepository.toLowerCase() ||
      pkg.kandeloCommit !== pkg.builtFrom.kandeloCommit
    ) {
      throw new Error(
        `Homebrew lazy layer package ${pkg.fullName} has inconsistent bottle build provenance`,
      );
    }
  }
}

function packageRecord(pkg: HomebrewVfsPackagePlan): HomebrewLazyLayerPackageRecord {
  return {
    name: pkg.name,
    full_name: pkg.fullName,
    tap_repository: pkg.tapRepository,
    tap_name: pkg.tapName,
    tap_commit: pkg.tapCommit,
    version: pkg.version,
    formula_revision: pkg.formulaRevision,
    bottle_rebuild: pkg.bottleRebuild,
    arch: pkg.arch,
    source_status: pkg.sourceStatus,
    metadata_status: pkg.metadataStatus,
    url: pkg.url,
    sha256: pkg.sha256,
    bytes: pkg.bytes,
    cache_key_sha: pkg.cacheKeySha,
    link_manifest: pkg.linkManifestPath,
    prefix: pkg.prefix,
    keg: pkg.keg,
    opt_link: {
      path: `opt/${pkg.name}`,
      target: `../${pkg.keg.slice(`${pkg.prefix}/`.length)}`,
    },
    ...(pkg.builtFrom === undefined ? {} : {
      built_from: {
        tap_repository: pkg.builtFrom.tapRepository,
        tap_commit: pkg.builtFrom.tapCommit,
        kandelo_repository: pkg.builtFrom.kandeloRepository,
        kandelo_commit: pkg.builtFrom.kandeloCommit,
        formula_sha256: pkg.builtFrom.formulaSha256,
      },
    }),
  };
}

function parseBaseComposition(
  baseVfs: HomebrewLazyLayerBaseVfs,
  expectedAbi: number,
): ParsedBaseComposition {
  const metadata = baseVfs.fs.getImageMetadata();
  if (metadata?.kernelAbi !== expectedAbi) {
    throw new Error(
      `Homebrew lazy layer base VFS ABI ${String(metadata?.kernelAbi)} ` +
        `does not match planned ABI ${expectedAbi}`,
    );
  }
  const source = readFile(
    baseVfs.fs,
    HOMEBREW_COMPOSITION_PATH,
    MAX_COMPOSITION_BYTES,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source));
  } catch (error) {
    throw new Error(
      `Homebrew lazy layer base composition is invalid JSON: ${errorMessage(error)}`,
    );
  }
  const composition = requireRecord(parsed, "base Homebrew composition");
  if (composition.schema !== 1) {
    throw new Error("Homebrew lazy layer base composition has an unsupported schema");
  }
  const compositionMetadata = requireRecord(
    composition.metadata,
    "base Homebrew composition metadata",
  );
  if (compositionMetadata.kandelo_abi !== expectedAbi) {
    throw new Error(
      "Homebrew lazy layer base composition ABI does not match the planned ABI",
    );
  }
  const selection = requireRecord(
    composition.selection,
    "base Homebrew composition selection",
  );
  const requestedPackagesSha256 = requireSha256(
    selection.requested_packages_sha256,
    "base Homebrew composition requested package digest",
  );
  if (!Array.isArray(composition.packages) || composition.packages.length === 0) {
    throw new Error("Homebrew lazy layer base composition has no packages");
  }
  const packages = new Map<string, Record<string, unknown>>();
  const packageOrder: string[] = [];
  for (const [index, value] of composition.packages.entries()) {
    const pkg = requireRecord(value, `base Homebrew package ${index}`);
    const fullName = requireString(pkg.full_name, `base Homebrew package ${index} full_name`);
    if (packages.has(fullName)) {
      throw new Error(`Homebrew lazy layer base composition duplicates ${fullName}`);
    }
    packages.set(fullName, pkg);
    packageOrder.push(fullName);
  }

  const imageHomebrew = requireRecord(
    metadata.homebrew,
    "base VFS image Homebrew metadata",
  );
  if (!Array.isArray(imageHomebrew.packages)) {
    throw new Error("Homebrew lazy layer base VFS metadata has no package closure");
  }
  const imagePackageOrder = imageHomebrew.packages.map((value, index) => {
    const pkg = requireRecord(value, `base VFS metadata package ${index}`);
    return requireString(pkg.fullName, `base VFS metadata package ${index} fullName`);
  });
  if (!arraysEqual(imagePackageOrder, packageOrder)) {
    throw new Error(
      "Homebrew lazy layer base VFS metadata and guest composition disagree on package order",
    );
  }

  return {
    source,
    packages,
    packageOrder,
    requestedPackagesSha256,
    packageSetSha256: digest(
      new TextEncoder().encode(JSON.stringify(composition.packages)),
    ),
    kernelAbi: expectedAbi,
  };
}

function assertBasePackageMatches(
  base: Record<string, unknown>,
  planned: HomebrewVfsPackagePlan,
): void {
  const expected = packageArtifactIdentity(packageRecord(planned));
  const actual = packageArtifactIdentity(base);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Homebrew lazy layer base owns ${planned.fullName} with a different bottle identity`,
    );
  }
}

function packageArtifactIdentity(value: unknown): Record<string, unknown> {
  const record = requireRecord(value, "Homebrew package identity");
  const builtFrom = record.built_from === undefined
    ? undefined
    : requireRecord(record.built_from, "Homebrew package built_from");
  const optLink = requireRecord(record.opt_link, "Homebrew package opt_link");
  return {
    name: requireString(record.name, "Homebrew package name"),
    full_name: requireString(record.full_name, "Homebrew package full_name"),
    tap_repository: requireString(record.tap_repository, "Homebrew package tap_repository"),
    tap_name: requireString(record.tap_name, "Homebrew package tap_name"),
    tap_commit: requireString(record.tap_commit, "Homebrew package tap_commit"),
    version: requireString(record.version, "Homebrew package version"),
    arch: requireString(record.arch, "Homebrew package arch"),
    source_status: requireString(record.source_status, "Homebrew package source_status"),
    metadata_status: requireString(record.metadata_status, "Homebrew package metadata_status"),
    url: requireString(record.url, "Homebrew package URL"),
    sha256: requireSha256(record.sha256, "Homebrew package sha256"),
    bytes: requirePositiveInteger(record.bytes, "Homebrew package bytes"),
    cache_key_sha: requireSha256(record.cache_key_sha, "Homebrew package cache key"),
    link_manifest: requireString(record.link_manifest, "Homebrew package link manifest"),
    prefix: requireString(record.prefix, "Homebrew package prefix"),
    keg: requireString(record.keg, "Homebrew package keg"),
    opt_link: {
      path: requireString(optLink.path, "Homebrew package opt link path"),
      target: requireString(optLink.target, "Homebrew package opt link target"),
    },
    ...(builtFrom === undefined ? {} : {
      built_from: {
        tap_repository: requireString(
          builtFrom.tap_repository,
          "Homebrew package built_from tap_repository",
        ),
        tap_commit: requireString(
          builtFrom.tap_commit,
          "Homebrew package built_from tap_commit",
        ),
        kandelo_repository: requireString(
          builtFrom.kandelo_repository,
          "Homebrew package built_from kandelo_repository",
        ),
        kandelo_commit: requireString(
          builtFrom.kandelo_commit,
          "Homebrew package built_from kandelo_commit",
        ),
        formula_sha256: requireSha256(
          builtFrom.formula_sha256,
          "Homebrew package built_from formula_sha256",
        ),
      },
    }),
  };
}

function collectLayerEntries(
  layerFs: MemoryFileSystem,
  baseFs: MemoryFileSystem,
): HomebrewLazyLayerEntry[] {
  if (!pathExists(layerFs, HOME_BREW_PREFIX)) {
    throw new Error("Homebrew lazy layer is missing its poured prefix");
  }
  const entries: HomebrewLazyLayerEntry[] = [];
  collectPath(layerFs, HOME_BREW_PREFIX, entries, new Map());
  entries.sort((left, right) => compareText(left.path, right.path));
  for (const entry of entries) {
    const basePath = `/${entry.path}`;
    if (!pathExists(baseFs, basePath)) continue;
    const baseType = baseFs.lstat(basePath).mode & S_IFMT;
    if (entry.type === "directory" && baseType === S_IFDIR) {
      entry.ownership = "shared-base-directory";
      continue;
    }
    throw new Error(
      `Homebrew lazy layer path collides with base-owned path: ${basePath}`,
    );
  }
  if (!entries.some((entry) => entry.ownership === "layer" && entry.type !== "directory")) {
    throw new Error("Homebrew lazy layer has no layer-owned files or symlinks");
  }
  if (entries.length > MAX_LAYER_ENTRIES) {
    throw new Error(
      `Homebrew lazy layer has ${entries.length} entries; maximum is ${MAX_LAYER_ENTRIES}`,
    );
  }
  return entries;
}

function collectPath(
  fs: MemoryFileSystem,
  vfsPath: string,
  entries: HomebrewLazyLayerEntry[],
  regularInodes: Map<number, HomebrewLazyLayerEntry>,
): void {
  const stat = fs.lstat(vfsPath);
  const path = withoutLeadingSlash(vfsPath);
  validateArchivePath(path);
  const mode = stat.mode & 0o7777;
  const type = stat.mode & S_IFMT;
  if (type === S_IFDIR) {
    entries.push({
      path,
      source_path: path,
      type: "directory",
      ownership: "layer",
      mode,
      size: 0,
    });
    const names: string[] = [];
    const handle = fs.opendir(vfsPath);
    try {
      for (;;) {
        const entry = fs.readdir(handle);
        if (entry === null) break;
        if (entry.name !== "." && entry.name !== "..") names.push(entry.name);
      }
    } finally {
      fs.closedir(handle);
    }
    names.sort(compareText);
    for (const name of names) {
      collectPath(fs, `${vfsPath}/${name}`, entries, regularInodes);
    }
    return;
  }
  if (type === S_IFREG) {
    const canonical = regularInodes.get(stat.ino);
    if (canonical !== undefined) {
      entries.push({
        path,
        // The ZIP scaffold stores one member per inode. The namespace alias
        // is reconstructed from the trusted inventory at registration.
        source_path: canonical.source_path,
        type: "hardlink",
        ownership: "layer",
        mode,
        size: stat.size,
        target: canonical.path,
        inode_group: canonical.inode_group,
      });
      return;
    }
    const entry: HomebrewLazyLayerEntry = {
      path,
      source_path: path,
      type: "file",
      ownership: "layer",
      mode,
      size: stat.size,
      inode_group: path,
    };
    regularInodes.set(stat.ino, entry);
    entries.push(entry);
    return;
  }
  if (type === S_IFLNK) {
    const target = fs.readlink(vfsPath);
    const targetBytes = new TextEncoder().encode(target).byteLength;
    if (targetBytes === 0 || targetBytes > MAX_SYMLINK_TARGET_BYTES) {
      throw new Error(`Homebrew lazy layer symlink target is invalid: ${vfsPath}`);
    }
    entries.push({
      path,
      source_path: path,
      type: "symlink",
      ownership: "layer",
      mode,
      size: targetBytes,
      target,
    });
    return;
  }
  throw new Error(`Homebrew lazy layer cannot archive special file: ${vfsPath}`);
}

function createLayerZip(
  fs: MemoryFileSystem,
  entries: readonly HomebrewLazyLayerEntry[],
): Uint8Array {
  const input: Zippable = {};
  for (const entry of entries) {
    if (entry.type === "hardlink") continue;
    const archivePath = entry.type === "directory" ? `${entry.path}/` : entry.path;
    const typeMode = entry.type === "directory"
      ? S_IFDIR
      : entry.type === "symlink"
        ? S_IFLNK
        : S_IFREG;
    const bytes = entry.type === "file"
      ? readFile(fs, `/${entry.path}`)
      : entry.type === "symlink"
        ? new TextEncoder().encode(entry.target ?? "")
        : new Uint8Array();
    input[archivePath] = [bytes, {
      level: entry.type === "file" ? 9 : 0,
      mtime: ZIP_EPOCH,
      os: 3,
      attrs: (((typeMode | entry.mode) << 16) >>> 0),
    }];
  }
  return zipSync(input, { level: 9 });
}

function readFile(
  fs: MemoryFileSystem,
  path: string,
  maximum = Number.MAX_SAFE_INTEGER,
): Uint8Array {
  const stat = fs.stat(path);
  if ((stat.mode & S_IFMT) !== S_IFREG || stat.size > maximum) {
    throw new Error(`Homebrew lazy layer cannot read bounded regular file: ${path}`);
  }
  const bytes = new Uint8Array(stat.size);
  const descriptor = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = fs.read(
        descriptor,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (read <= 0) throw new Error(`short read while archiving ${path}`);
      offset += read;
    }
  } finally {
    fs.close(descriptor);
  }
  return bytes;
}

function validateArchivePath(path: string): void {
  const bytes = new TextEncoder().encode(path).byteLength;
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((component) => component === "" || component === "." || component === "..") ||
    bytes > MAX_LAYER_PATH_BYTES
  ) {
    throw new Error(`Homebrew lazy layer has unsafe archive path: ${path}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const result = requireRecord(value, label);
  const actual = Object.keys(result).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (!arraysEqual(actual, expected)) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
  return result;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!SHA256_RE.test(result)) throw new Error(`${label} must be a SHA-256 digest`);
  return result;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function requireArch(value: unknown, label: string): "wasm32" | "wasm64" {
  if (value !== "wasm32" && value !== "wasm64") {
    throw new Error(`${label} must be wasm32 or wasm64`);
  }
  return value;
}

function requirePackageName(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!/^[a-z0-9][a-z0-9._+-]*$/.test(result)) {
    throw new Error(`${label} is not a portable package name`);
  }
  return result;
}

function requireSafeRelativePath(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (
    result.startsWith("/") ||
    result.includes("\\") ||
    result.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} is not a safe relative artifact path`);
  }
  return result;
}

function requireHttpsUrl(value: unknown, label: string): string {
  const result = requireString(value, label);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`${label} must be an unauthenticated HTTPS URL without a fragment`);
  }
  return parsed.href;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function withoutLeadingSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

function pathExists(fs: MemoryFileSystem, path: string): boolean {
  try {
    fs.lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === -2
    ) {
      return false;
    }
    throw error;
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
