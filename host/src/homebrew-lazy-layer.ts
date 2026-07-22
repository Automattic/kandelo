import { createHash } from "node:crypto";
import { zipSync, type Zippable } from "fflate";
import {
  buildHomebrewVfs,
  homebrewCanonicalOptLink,
  homebrewManifestSourcePath,
  mapHomebrewBottleEntryToGuestPath,
  type HomebrewVfsCatalogCheckout,
  type HomebrewVfsCompatibilityPolicy,
  type HomebrewVfsBuildReport,
  type HomebrewVfsMigrationLockBinding,
  type HomebrewVfsSelectionSource,
} from "./homebrew-vfs-builder";
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
  HomebrewDeferredTreeDraftDescriptor,
  HomebrewDeferredTreeSourceEntry,
  HomebrewLazyLayerBasePackageSource,
  HomebrewLazyLayerDescriptor,
  HomebrewLazyLayerDraftDescriptor,
  HomebrewLazyLayerEntry,
  HomebrewLazyLayerPackageRecord,
  HomebrewLazyLayerPayload,
  HomebrewRuntimeLayerAssetIdentity,
} from "./homebrew-lazy-layer-descriptor";
import {
  canonicalHomebrewRuntimeLayerBundleIdentityBytes,
  canonicalHomebrewRuntimeLayerDescriptorBytes,
  compareHomebrewCanonicalText,
} from "./homebrew-lazy-layer-descriptor";
export type {
  HomebrewDeferredTreeDescriptor,
  HomebrewDeferredTreeDraftDescriptor,
  HomebrewDeferredTreeDraftTransport,
  HomebrewDeferredTreeSourceEntry,
  HomebrewDeferredTreeTransport,
  HomebrewLazyLayerBasePackageSource,
  HomebrewLazyLayerDescriptor,
  HomebrewLazyLayerDraftDescriptor,
  HomebrewLazyLayerEntry,
  HomebrewLazyLayerPackageRecord,
  HomebrewLazyLayerPayload,
  HomebrewRuntimeLayerAssetIdentity,
} from "./homebrew-lazy-layer-descriptor";
import { MemoryFileSystem } from "./vfs/memory-fs";
import {
  assertVfsDeferredTreeCollectionUsage,
} from "./vfs/deferred-tree-limits";
import { parseTarGzip, type TarEntry } from "./vfs/tar";
import {
  HOMEBREW_RUNTIME_LAYER_LIMITS,
  homebrewRuntimeLayerDescriptorAsset,
  homebrewRuntimeLayerPayloadAsset,
  isHomebrewRuntimeLayerId,
} from "./homebrew-runtime-layer-limits";
export {
  homebrewRuntimeLayerDescriptorAsset,
  homebrewRuntimeLayerPayloadAsset,
} from "./homebrew-runtime-layer-limits";

const HOMEBREW_VFS_ASSET = "kandelo-homebrew.vfs.zst";
const HOMEBREW_VFS_DESCRIPTOR_ASSET = "kandelo-homebrew-vfs.json";
const HOMEBREW_VFS_REPORT_ASSET = "kandelo-homebrew-vfs-report.json";
const HOMEBREW_NODE_EVIDENCE_ASSET = "kandelo-homebrew-node-evidence.json";
const HOMEBREW_BROWSER_EVIDENCE_ASSET = "kandelo-homebrew-browser-evidence.json";
const HOMEBREW_COMPOSITION_PATH = "/etc/kandelo/homebrew-vfs.json";
const HOME_BREW_PREFIX = "/home/linuxbrew/.linuxbrew";
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0);
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;
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

interface BuildHomebrewLazyLayerCommonOptions {
  /** Fresh filesystem that will contain only layer-owned package output. */
  fs: MemoryFileSystem;
  /** Exact bottle-built shell image that will own the lower filesystem. */
  baseVfs: HomebrewLazyLayerBaseVfs;
  /** Browser-proven eager image whose immutable release carries this layer. */
  acceptanceVfs: HomebrewLazyLayerImageSource;
  loadBottleBytes: (
    pkg: HomebrewVfsPackagePlan,
  ) => Uint8Array | Promise<Uint8Array>;
  /** Exact eager-composer conflict policy, when the selected closure needs it. */
  compatibilityPolicy?: HomebrewVfsCompatibilityPolicy;
}

export interface BuildHomebrewLazyLayerOptions extends
  BuildHomebrewLazyLayerCommonOptions {
  /** Reviewed policy selection required for independently composable runtimes. */
  runtimeLayer: { id: string; policy: unknown };
}

export interface HomebrewLazyLayerBuildResult {
  /** Bundle/descriptor identity, independent from every package-owned tree. */
  id: string;
  /** Canonically ordered, byte-identical objects described by all trees. */
  payloads: HomebrewLazyLayerPayload[];
  /** Inert until exact Node/browser evidence closes its independent identity. */
  descriptor: HomebrewLazyLayerDraftDescriptor;
}

export interface HomebrewLazyLayerClosureEvidence {
  descriptor: HomebrewRuntimeLayerAssetIdentity & {
    asset: "kandelo-homebrew-vfs.json";
  };
  report: HomebrewRuntimeLayerAssetIdentity & {
    asset: "kandelo-homebrew-vfs-report.json";
  };
  node: HomebrewRuntimeLayerAssetIdentity & {
    asset: "kandelo-homebrew-node-evidence.json";
  };
  browser: HomebrewRuntimeLayerAssetIdentity & {
    asset: "kandelo-homebrew-browser-evidence.json";
  };
}

interface ParsedBaseComposition {
  source: Uint8Array;
  packages: Map<string, Record<string, unknown>>;
  packageOrder: string[];
  requestedPackagesSha256: string;
  packageSetSha256: string;
  kernelAbi: number;
}

export interface BuildHomebrewOriginalBottleCollectionOptions {
  /** Fresh filesystem populated only by the selected package collection. */
  fs: MemoryFileSystem;
  /** Concrete lower namespace used solely for collision/ownership projection. */
  baseFs: MemoryFileSystem;
  loadBottleBytes: (
    pkg: HomebrewVfsPackagePlan,
  ) => Uint8Array | Promise<Uint8Array>;
  compatibilityPolicy?: HomebrewVfsCompatibilityPolicy;
  selectionSource?: HomebrewVfsSelectionSource;
  catalogCheckout?: HomebrewVfsCatalogCheckout;
  migrationLock?: HomebrewVfsMigrationLockBinding;
  createdBy?: string;
  /** Optional compatibility IDs; ordinary collection trees derive package IDs. */
  treeIdOverrides?: ReadonlyMap<string, string>;
}

export interface HomebrewOriginalBottleCollectionBuildResult {
  payloads: HomebrewLazyLayerPayload[];
  deferredTrees: HomebrewDeferredTreeDraftDescriptor[];
  packages: HomebrewLazyLayerPackageRecord[];
  /** Exact eager pour/link evidence used to derive guest ownership. */
  report: HomebrewVfsBuildReport;
}

/**
 * Convert an exact selected package collection into independent original-
 * bottle deferred trees. This deliberately has no release, base-receipt,
 * acceptance-image, or runtime-root concern; outer products own those.
 */
export async function buildHomebrewOriginalBottleCollection(
  plan: HomebrewVfsPlan,
  options: BuildHomebrewOriginalBottleCollectionOptions,
): Promise<HomebrewOriginalBottleCollectionBuildResult> {
  if (options.fs === options.baseFs) {
    throw new Error("Homebrew original bottles require separate base and layer filesystems");
  }
  commonArch(plan);
  const tapLock = planTapLock(plan);
  validatePackageTapOwnership(plan.packages, tapLock);
  if (plan.packages.length === 0) {
    throw new Error("Homebrew original bottle collection has no selected packages");
  }
  if (plan.packages.length > HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackages) {
    throw new Error("Homebrew original bottle collection exceeds the package-count cap");
  }
  let declaredArchiveBytes = 0;
  for (const pkg of plan.packages) {
    if (!Number.isSafeInteger(pkg.bytes) || pkg.bytes <= 0) {
      throw new Error(`Homebrew original bottle ${pkg.fullName} has an invalid declared size`);
    }
    if (pkg.bytes > HOMEBREW_RUNTIME_LAYER_LIMITS.maxArchiveBytes) {
      throw new Error(
        `Homebrew original bottle ${pkg.fullName} exceeds the per-bottle archive cap`,
      );
    }
    declaredArchiveBytes += pkg.bytes;
  }
  assertVfsDeferredTreeCollectionUsage({
    groups: plan.packages.length,
    archiveBytes: declaredArchiveBytes,
    expandedBytes: 0,
    payloadBytes: 0,
    entries: 0,
  }, "Homebrew original bottle collection");

  const bottles: PreparedOriginalBottle[] = [];
  let aggregateArchiveBytes = 0;
  let aggregateExpandedBytes = 0;
  let aggregateSourceEntries = 0;
  for (const pkg of plan.packages) {
    const bytes = await options.loadBottleBytes(pkg);
    assertBottleIdentity(pkg, bytes);
    const parsed = parseTarGzip(bytes, {
      label: `Homebrew deferred bottle ${pkg.fullName}`,
      limits: {
        maxCompressedBytes: HOMEBREW_RUNTIME_LAYER_LIMITS.maxArchiveBytes,
        maxUncompressedBytes: HOMEBREW_RUNTIME_LAYER_LIMITS.maxUncompressedBytes,
        maxEntries: HOMEBREW_RUNTIME_LAYER_LIMITS.maxEntries,
      },
    });
    const sourceEntries = createSourceInventory(parsed);
    aggregateArchiveBytes += bytes.byteLength;
    aggregateExpandedBytes += gzipExpandedBytes(bytes);
    aggregateSourceEntries += sourceEntries.length;
    assertVfsDeferredTreeCollectionUsage({
      groups: bottles.length + 1,
      archiveBytes: aggregateArchiveBytes,
      expandedBytes: aggregateExpandedBytes,
      payloadBytes: 0,
      entries: aggregateSourceEntries,
    }, "Homebrew original bottle collection");
    // The expanded TAR is released after each iteration; only compact source
    // truth and the exact compressed object survive to collection closure.
    bottles.push({ pkg, bytes, sourceEntries });
  }

  const bottleBytes = new Map(
    bottles.map((bottle) => [bottle.pkg.fullName, bottle.bytes]),
  );
  const build = await buildHomebrewVfs(plan, {
    fs: options.fs,
    loadBottleBytes: (pkg) => {
      const bytes = bottleBytes.get(pkg.fullName);
      if (bytes === undefined) {
        throw new Error(`Homebrew original bottle did not prepare ${pkg.fullName}`);
      }
      return bytes;
    },
    writeProfile: false,
    createdBy: options.createdBy ?? "host/src/homebrew-lazy-layer.ts",
    selectionSource: options.selectionSource,
    catalogCheckout: options.catalogCheckout,
    migrationLock: options.migrationLock,
    compatibilityPolicy: options.compatibilityPolicy,
    consumerState: "defer",
  });
  const finalEntries = collectLayerEntries(options.fs, options.baseFs);
  const trees = createOriginalBottleTrees(
    bottles,
    finalEntries,
    options.fs,
    options.treeIdOverrides ?? new Map(),
    new Map(build.report.packages.map((pkg) => [pkg.full_name, new Set(pkg.links)])),
  );
  const aggregateGuestEntries = trees.reduce(
    (total, tree) => total + tree.descriptor.inventory.entries.length,
    0,
  );
  const aggregatePayloadBytes = trees.reduce(
    (total, tree) => total + tree.descriptor.inventory.payload_bytes,
    0,
  );
  assertVfsDeferredTreeCollectionUsage({
    groups: trees.length,
    archiveBytes: aggregateArchiveBytes,
    expandedBytes: aggregateExpandedBytes,
    payloadBytes: aggregatePayloadBytes,
    entries: aggregateSourceEntries + aggregateGuestEntries,
  }, "Homebrew original bottle collection");
  return {
    payloads: trees.map((tree) => tree.payload),
    deferredTrees: trees.map((tree) => tree.descriptor),
    packages: plan.packages.map(packageRecord),
    report: build.report,
  };
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
  const arch = commonArch(plan);
  const basePackageSource = parseHomebrewLazyLayerBasePackageSource(
    options.baseVfs.source,
    arch,
    plan.kandeloAbi,
  );
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
  return buildSelectedHomebrewLazyPackageCollection(
    selectedPlan,
    options,
    options.runtimeLayer.id,
    new Map([[runtimeSelection.rootPackage, options.runtimeLayer.id]]),
  );
}

async function buildSelectedHomebrewLazyPackageCollection(
  selectedPlan: HomebrewVfsPlan,
  options: BuildHomebrewLazyLayerCommonOptions,
  bundleId: string,
  treeIdOverrides: ReadonlyMap<string, string>,
): Promise<HomebrewLazyLayerBuildResult> {
  homebrewRuntimeLayerDescriptorAsset(bundleId);
  if (options.fs === options.baseVfs.fs) {
    throw new Error("Homebrew lazy layer requires separate base and layer filesystems");
  }
  assertImageSource(options.baseVfs.image, "base VFS");
  assertImageSource(options.acceptanceVfs, "acceptance VFS");
  const arch = commonArch(selectedPlan);
  const basePackageSource = parseHomebrewLazyLayerBasePackageSource(
    options.baseVfs.source,
    arch,
    selectedPlan.kandeloAbi,
  );
  if (
    basePackageSource.output.sha256 !== options.baseVfs.image.sha256 ||
    basePackageSource.output.bytes !== options.baseVfs.image.bytes
  ) {
    throw new Error(
      "Homebrew lazy layer base bytes do not match their canonical package output",
    );
  }
  const base = parseBaseComposition(options.baseVfs, selectedPlan.kandeloAbi);
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
  const collection = await buildHomebrewOriginalBottleCollection(layerPlan, {
    fs: options.fs,
    baseFs: options.baseVfs.fs,
    loadBottleBytes: options.loadBottleBytes,
    compatibilityPolicy: options.compatibilityPolicy,
    treeIdOverrides,
  });

  const baseRecords = basePackages.map(packageRecord);
  const layerRecords = collection.packages;

  return {
    id: bundleId,
    payloads: collection.payloads,
    descriptor: {
      schema: 5,
      kind: "kandelo-homebrew-deferred-layer-draft",
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
      acceptance_vfs: {
        asset: HOMEBREW_VFS_ASSET,
        sha256: options.acceptanceVfs.sha256,
        bytes: options.acceptanceVfs.bytes,
      },
      deferred_trees: collection.deferredTrees,
    },
  };
}

function createDeferredTreeDescriptor(
  id: string,
  capabilityRoot: string,
  transportAsset: string,
  sha256: string,
  bytes: number,
  entries: HomebrewLazyLayerEntry[],
): HomebrewDeferredTreeDraftDescriptor {
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
    transports: [{ kind: "bundle-release", asset: transportAsset }],
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

interface PreparedOriginalBottle {
  pkg: HomebrewVfsPackagePlan;
  bytes: Uint8Array;
  sourceEntries: HomebrewDeferredTreeSourceEntry[];
}

interface OriginalBottleTree {
  payload: HomebrewLazyLayerPayload;
  descriptor: HomebrewDeferredTreeDraftDescriptor;
}

interface GuestAssignment {
  bottle: PreparedOriginalBottle;
  materialization:
    | "archive"
    | "archive-copy"
    | "archive-copy-mode"
    | "descriptor";
  sourcePath: string;
  source?: HomebrewDeferredTreeSourceEntry;
}

/**
 * Project the verified pour into one independently fetched original bottle per
 * package. Complete source truth remains separate from the guest namespace:
 * ignored bottle roots and overlapping source directories are still verified,
 * while link-manifest and opt links are truthfully descriptor-created.
 */
function createOriginalBottleTrees(
  bottles: PreparedOriginalBottle[],
  finalEntries: HomebrewLazyLayerEntry[],
  fs: MemoryFileSystem,
  treeIdOverrides: ReadonlyMap<string, string>,
  appliedLinks: Map<string, Set<string>>,
): OriginalBottleTree[] {
  const treeIdByPackage = new Map<string, string>();
  const packageByTreeId = new Map<string, string>();
  for (const bottle of bottles) {
    const id = treeIdOverrides.get(bottle.pkg.fullName) ?? originalBottleTreeId(bottle.pkg);
    homebrewRuntimeLayerPayloadAsset(id);
    homebrewRuntimeLayerDescriptorAsset(id);
    const prior = packageByTreeId.get(id);
    if (prior !== undefined) {
      throw new Error(`Homebrew original bottles ${prior} and ${bottle.pkg.fullName} share tree ${id}`);
    }
    packageByTreeId.set(id, bottle.pkg.fullName);
    treeIdByPackage.set(bottle.pkg.fullName, id);
  }

  const finalByPath = new Map(finalEntries.map((entry) => [entry.path, entry]));
  const assignments = new Map<string, GuestAssignment>();
  const guestPathBySource = new Map<string, Map<string, string>>();
  const sourceByPath = new Map<string, Map<string, HomebrewDeferredTreeSourceEntry>>();
  const reservedDescriptorSources = new Map<string, Set<string>>();

  for (const bottle of bottles) {
    const packageGuests = new Map<string, string>();
    const packageSources = new Map<string, HomebrewDeferredTreeSourceEntry>();
    for (const source of bottle.sourceEntries) {
      if (packageSources.has(source.path)) {
        throw new Error(
          `Homebrew original bottle ${bottle.pkg.fullName} duplicates source ${source.path}`,
        );
      }
      packageSources.set(source.path, source);
      const guest = mapHomebrewBottleEntryToGuestPath(bottle.pkg, source.path);
      if (guest === null) continue;
      const path = withoutLeadingSlash(guest);
      packageGuests.set(source.path, path);
      const final = finalByPath.get(path);
      if (final === undefined) {
        throw new Error(
          `Homebrew original bottle ${bottle.pkg.fullName} source ${source.path} ` +
            `is absent from its verified pour at /${path}`,
        );
      }
      const prior = assignments.get(path);
      if (prior !== undefined) {
        if (source.type === "directory" && prior.source?.type === "directory") {
          if (source.mode !== prior.source.mode) {
            throw new Error(
              `Homebrew original bottles ${prior.bottle.pkg.fullName} and ` +
                `${bottle.pkg.fullName} assign different modes to directory /${path}`,
            );
          }
          continue;
        }
        throw new Error(
          `Homebrew original bottles ${prior.bottle.pkg.fullName} and ` +
            `${bottle.pkg.fullName} overlap at /${path}`,
        );
      }
      assignments.set(path, {
        bottle,
        materialization: "archive",
        sourcePath: source.path,
        source,
      });
    }
    guestPathBySource.set(bottle.pkg.fullName, packageGuests);
    sourceByPath.set(bottle.pkg.fullName, packageSources);
    reservedDescriptorSources.set(
      bottle.pkg.fullName,
      new Set(packageSources.keys()),
    );
  }

  for (const bottle of bottles) {
    const treeId = treeIdByPackage.get(bottle.pkg.fullName)!;
    const regularSourceByInode = new Map<number | bigint, string>();
    for (const source of bottle.sourceEntries) {
      if (source.type !== "file") continue;
      const guest = guestPathBySource.get(bottle.pkg.fullName)!.get(source.path);
      if (guest === undefined) continue;
      regularSourceByInode.set(fs.stat(`/${guest}`).ino, source.path);
    }
    for (const [index, link] of bottle.pkg.linkManifest.links.entries()) {
      const path = withoutLeadingSlash(`${bottle.pkg.prefix}/${link.target}`);
      if (!appliedLinks.get(bottle.pkg.fullName)?.has(link.target)) {
        continue;
      }
      if (assignments.has(path)) {
        throw new Error(`Homebrew original bottle link ownership overlaps at /${path}`);
      }
      const final = finalByPath.get(path);
      if (final === undefined) throw new Error(`Homebrew applied link is absent at /${path}`);
      if (link.type === "file") {
        const sourceGuest = homebrewManifestSourcePath(bottle.pkg, link.source);
        const sourcePath = regularSourceByInode.get(fs.stat(sourceGuest).ino);
        if (sourcePath === undefined) {
          throw new Error(
            `Homebrew original bottle ${bottle.pkg.fullName} cannot bind copied link ` +
              `${link.target} to a regular source member`,
          );
        }
        const source = sourceByPath.get(bottle.pkg.fullName)!.get(sourcePath);
        if (source?.type !== "file") {
          throw new Error(`Homebrew copied link ${link.target} has no regular source metadata`);
        }
        assignments.set(path, {
          bottle,
          // Link manifests may intentionally install a copy with a reviewed
          // mode override. Keep that boundary explicit in the descriptor.
          materialization: final.mode === source.mode
            ? "archive-copy"
            : "archive-copy-mode",
          sourcePath,
          source,
        });
      } else {
        assignments.set(path, {
          bottle,
          materialization: "descriptor",
          sourcePath: descriptorSourcePath(
            treeId,
            `link-${index}`,
            reservedDescriptorSources.get(bottle.pkg.fullName)!,
          ),
        });
      }
    }
    const opt = homebrewCanonicalOptLink(bottle.pkg);
    const optPath = withoutLeadingSlash(`${bottle.pkg.prefix}/${opt.path}`);
    if (assignments.has(optPath)) {
      throw new Error(`Homebrew original bottle opt ownership overlaps at /${optPath}`);
    }
    if (!finalByPath.has(optPath)) {
      throw new Error(`Homebrew original bottle ${bottle.pkg.fullName} has no canonical opt link`);
    }
    assignments.set(optPath, {
      bottle,
      materialization: "descriptor",
      sourcePath: descriptorSourcePath(
        treeId,
        "opt",
        reservedDescriptorSources.get(bottle.pkg.fullName)!,
      ),
    });
  }

  // The verified pour creates shared ancestor directories which may have no
  // dedicated TAR member. Assign each once to the lexicographically first
  // descendant tree so selected bottle groups never claim the same VFS path.
  for (const entry of finalEntries) {
    if (assignments.has(entry.path)) continue;
    if (entry.type !== "directory") {
      throw new Error(`Homebrew original bottle inventory cannot attribute /${entry.path}`);
    }
    const owners = Array.from(assignments.entries())
      .filter(([path]) => path.startsWith(`${entry.path}/`))
      .map(([, assignment]) => assignment.bottle)
      .sort((left, right) => compareHomebrewCanonicalText(
        treeIdByPackage.get(left.pkg.fullName)!,
        treeIdByPackage.get(right.pkg.fullName)!,
      ));
    const bottle = owners[0];
    if (bottle === undefined) {
      throw new Error(`Homebrew original bottle directory /${entry.path} has no owner`);
    }
    assignments.set(entry.path, {
      bottle,
      materialization: "descriptor",
      sourcePath: descriptorSourcePath(
        treeIdByPackage.get(bottle.pkg.fullName)!,
        `directory-${digest(new TextEncoder().encode(entry.path)).slice(0, 16)}`,
        reservedDescriptorSources.get(bottle.pkg.fullName)!,
      ),
    });
  }

  const trees = bottles.map((bottle): OriginalBottleTree => {
    const id = treeIdByPackage.get(bottle.pkg.fullName)!;
    const sourceEntries = bottle.sourceEntries;
    const canonicalSourceByPath = resolveSourceHardlinks(
      sourceEntries,
      sourceByPath.get(bottle.pkg.fullName)!,
    );
    const entries = Array.from(assignments.entries())
      .filter(([, assignment]) => assignment.bottle === bottle)
      .map(([path, assignment]) => createDirectGuestEntry(
        path,
        assignment,
        finalByPath,
        guestPathBySource.get(bottle.pkg.fullName)!,
        canonicalSourceByPath,
        id,
      ))
      .sort((left, right) => compareHomebrewCanonicalText(left.path, right.path));
    const regularGroups = new Set(
      entries.flatMap((entry) => entry.inode_group ? [entry.inode_group] : []),
    );
    const asset = homebrewRuntimeLayerPayloadAsset(id);
    const transports: HomebrewDeferredTreeDraftDescriptor["transports"] = [
      { kind: "bundle-release", asset },
    ];
    const external = browserReadableExternalBottleUrl(bottle.pkg.url);
    if (external !== undefined) transports.push({ kind: "external-https", url: external });
    return {
      payload: { id, asset, bytes: bottle.bytes },
      descriptor: {
        id,
        package: bottle.pkg.fullName,
        activation: {
          mode: "first-use",
          capabilities: [`homebrew-bottle:${id}`],
          roots: [bottle.pkg.keg],
        },
        content: {
          media_type: "application/vnd.oci.image.layer.v1.tar+gzip",
          decoder: "homebrew-bottle-tar-gzip-v1",
          sha256: bottle.pkg.sha256,
          bytes: bottle.pkg.bytes,
        },
        transports,
        inventory: {
          entry_count: entries.length,
          source_entry_count: sourceEntries.length,
          regular_inode_count: regularGroups.size,
          layer_entry_count: entries.filter((entry) => entry.ownership === "layer").length,
          mergeable_directory_count: entries.filter(
            (entry) => entry.ownership === "mergeable-directory",
          ).length,
          expanded_bytes: gzipExpandedBytes(bottle.bytes),
          payload_bytes: entries
            .filter((entry) => entry.type === "file")
            .reduce((total, entry) => total + entry.size, 0),
          source: {
            schema: 1,
            kind: "homebrew-bottle-tar-gzip-v1",
            entries: sourceEntries,
          },
          entries,
        },
      },
    };
  });
  trees.sort((left, right) => compareHomebrewCanonicalText(left.payload.id, right.payload.id));
  return trees;
}

function createDirectGuestEntry(
  path: string,
  assignment: GuestAssignment,
  finalByPath: Map<string, HomebrewLazyLayerEntry>,
  guestPathBySource: Map<string, string>,
  canonicalSourceByPath: Map<
    string,
    HomebrewDeferredTreeSourceEntry & { type: "file" }
  >,
  treeId: string,
): HomebrewLazyLayerEntry {
  const final = finalByPath.get(path)!;
  const keg = withoutLeadingSlash(assignment.bottle.pkg.keg);
  const ownership: HomebrewLazyLayerEntry["ownership"] = final.type === "directory" &&
      path !== keg && !path.startsWith(`${keg}/`)
    ? "mergeable-directory"
    : "layer";
  if (assignment.materialization === "descriptor") {
    if (final.type !== "directory" && final.type !== "symlink") {
      throw new Error(`Homebrew descriptor-created path /${path} is not structural`);
    }
    return {
      ...final,
      ownership,
      source_path: assignment.sourcePath,
      materialization: "descriptor",
    };
  }
  if (
    assignment.materialization === "archive-copy" ||
    assignment.materialization === "archive-copy-mode"
  ) {
    if (final.type !== "file" || assignment.source?.type !== "file") {
      throw new Error(`Homebrew archive copy /${path} is not regular`);
    }
    if (
      assignment.materialization === "archive-copy" &&
      final.mode !== assignment.source.mode
    ) {
      throw new Error(`Homebrew archive copy /${path} changes its source mode`);
    }
    return {
      ...final,
      ownership,
      source_path: assignment.sourcePath,
      materialization: assignment.materialization,
      inode_group: compactInodeGroup(treeId, "copy", path),
    };
  }
  const source = assignment.source!;
  // The poured filesystem identifies a hardlinked inode, not which pathname
  // the bottle TAR declared as its canonical regular member. `collectPath`
  // chooses the first lexical pathname only for its temporary inventory. Keep
  // the signed source roles authoritative here, after verifying that the
  // poured paths still have the expected size, mode, and shared inode group.
  if (source.type === "file") {
    if (
      (final.type !== "file" && final.type !== "hardlink") ||
      final.size !== source.size ||
      final.mode !== source.mode ||
      final.inode_group === undefined
    ) {
      throw new Error(`Homebrew poured file /${path} differs from source ${source.path}`);
    }
    return {
      path,
      source_path: source.path,
      materialization: "archive",
      type: "file",
      ownership,
      mode: final.mode,
      size: final.size,
      inode_group: compactInodeGroup(treeId, "source", source.path),
    };
  }
  if (source.type === "hardlink") {
    const canonicalSource = canonicalSourceByPath.get(source.path);
    const target = guestPathBySource.get(source.target!);
    const targetFinal = target === undefined ? undefined : finalByPath.get(target);
    if (
      canonicalSource === undefined || target === undefined || targetFinal === undefined ||
      (final.type !== "file" && final.type !== "hardlink") ||
      (targetFinal.type !== "file" && targetFinal.type !== "hardlink") ||
      final.size !== canonicalSource.size || final.mode !== canonicalSource.mode ||
      targetFinal.size !== canonicalSource.size ||
      targetFinal.mode !== canonicalSource.mode ||
      final.inode_group === undefined ||
      final.inode_group !== targetFinal.inode_group
    ) {
      throw new Error(`Homebrew poured hardlink /${path} has no immediate guest target`);
    }
    return {
      path,
      source_path: source.path,
      materialization: "archive",
      type: "hardlink",
      ownership,
      mode: final.mode,
      size: canonicalSource.size,
      target,
      inode_group: compactInodeGroup(treeId, "source", canonicalSource.path),
    };
  }
  if (source.type === "symlink") {
    if (
      final.type !== "symlink" || final.target !== source.target ||
      final.mode !== source.mode
    ) {
      throw new Error(`Homebrew poured symlink /${path} differs from source ${source.path}`);
    }
    return {
      ...final,
      ownership,
      source_path: source.path,
      materialization: "archive",
      mode: final.mode,
    };
  }
  if (final.type !== "directory" || final.mode !== source.mode) {
    throw new Error(`Homebrew poured directory /${path} differs from source ${source.path}`);
  }
  return {
    ...final,
    ownership,
    source_path: source.path,
    materialization: "archive",
    mode: final.mode,
  };
}

function createSourceInventory(entries: TarEntry[]): HomebrewDeferredTreeSourceEntry[] {
  return entries.map((entry): HomebrewDeferredTreeSourceEntry => ({
    path: entry.path,
    type: entry.type,
    mode: entry.mode,
    size: entry.type === "file" ? entry.data.byteLength : 0,
    ...(entry.type === "symlink" || entry.type === "hardlink"
      ? { target: entry.linkName }
      : {}),
  })).sort((left, right) => compareHomebrewCanonicalText(left.path, right.path));
}

function resolveSourceHardlinks(
  entries: readonly HomebrewDeferredTreeSourceEntry[],
  sources: Map<string, HomebrewDeferredTreeSourceEntry>,
): Map<string, HomebrewDeferredTreeSourceEntry & { type: "file" }> {
  const resolved = new Map<
    string,
    HomebrewDeferredTreeSourceEntry & { type: "file" }
  >();
  for (const start of entries) {
    if (start.type !== "hardlink" || resolved.has(start.path)) continue;
    const chain: HomebrewDeferredTreeSourceEntry[] = [];
    const seen = new Set<string>();
    let current = start;
    let canonical: HomebrewDeferredTreeSourceEntry & { type: "file" } | undefined;
    while (current.type === "hardlink") {
      canonical = resolved.get(current.path);
      if (canonical !== undefined) break;
      if (seen.has(current.path)) {
        throw new Error(`Homebrew bottle hardlink cycle at ${current.path}`);
      }
      seen.add(current.path);
      chain.push(current);
      const target = sources.get(current.target!);
      if (target === undefined || (target.type !== "file" && target.type !== "hardlink")) {
        throw new Error(`Homebrew bottle hardlink ${current.path} has no regular source target`);
      }
      current = target;
    }
    if (canonical === undefined) {
      if (current.type !== "file") {
        throw new Error(`Homebrew bottle hardlink ${start.path} has no regular source target`);
      }
      canonical = current as HomebrewDeferredTreeSourceEntry & { type: "file" };
    }
    for (const link of chain) resolved.set(link.path, canonical);
  }
  return resolved;
}

function originalBottleTreeId(pkg: HomebrewVfsPackagePlan): string {
  const slug = pkg.name.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "package";
  const prefix = "bottle-";
  const suffix = `-${digest(new TextEncoder().encode(pkg.fullName)).slice(0, 16)}`;
  const maximumIdBytes = HOMEBREW_RUNTIME_LAYER_LIMITS.maxRuntimeLayerIdBytes;
  const maximumSlugBytes = maximumIdBytes - prefix.length - suffix.length;
  return `${prefix}${slug.slice(0, maximumSlugBytes)}${suffix}`;
}

function compactInodeGroup(treeId: string, kind: "source" | "copy", path: string): string {
  return `${treeId}:${kind}:${digest(new TextEncoder().encode(path))}`;
}

function descriptorSourcePath(
  treeId: string,
  suffix: string,
  reserved: Set<string>,
): string {
  const base = `.kandelo-descriptor/${treeId}/${suffix}`;
  let candidate = base;
  for (let index = 1; reserved.has(candidate); index += 1) {
    candidate = `${base}-${index}`;
  }
  reserved.add(candidate);
  return candidate;
}

function gzipExpandedBytes(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(bytes.byteLength - 4, true);
}

function browserReadableExternalBottleUrl(value: string): string | undefined {
  // Optional browser mirrors use one deliberately narrow, raw lexical shape.
  // This avoids WHATWG URL normalization (encoded hosts, backslashes, and dot
  // segments) disagreeing with Python's urlsplit during credential-free close.
  if (
    !/^https:\/\/github\.com(?::443)?\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/releases\/download\/[A-Za-z0-9][A-Za-z0-9._@+=,-]*\/[A-Za-z0-9][A-Za-z0-9._@+=,-]*$/.test(
      value,
    )
  ) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
      url.hostname !== "github.com" || url.hash !== "" || url.search !== ""
    ) return undefined;
    // The exact URL string is part of the closed descriptor identity. Use URL
    // only as a validator; serializing it would silently remove `:443` and
    // otherwise make the TypeScript and credential-free Python closers differ.
    return value;
  } catch {
    return undefined;
  }
}

function assertBottleIdentity(pkg: HomebrewVfsPackagePlan, bytes: Uint8Array): void {
  if (bytes.byteLength !== pkg.bytes || digest(bytes) !== pkg.sha256) {
    throw new Error(`Homebrew deferred bottle ${pkg.fullName} differs from package metadata`);
  }
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
  descriptor: HomebrewLazyLayerDraftDescriptor | HomebrewLazyLayerDescriptor,
): Uint8Array {
  if (descriptor.kind === "kandelo-homebrew-deferred-layer") {
    return canonicalHomebrewRuntimeLayerDescriptorBytes(descriptor);
  }
  return new TextEncoder().encode(`${JSON.stringify(descriptor, null, 2)}\n`);
}

/**
 * Close an inert producer descriptor after exact acceptance evidence exists.
 * Production publication performs the same operation in the credential-free
 * Python handoff validator; this implementation keeps the producer contract
 * independently testable and documents the cross-language identity algorithm.
 */
export function closeHomebrewLazyLayerDescriptor(
  draft: HomebrewLazyLayerDraftDescriptor,
  evidence: HomebrewLazyLayerClosureEvidence,
): HomebrewLazyLayerDescriptor {
  if (
    (draft.schema !== 4 && draft.schema !== 5) ||
    draft.kind !== "kandelo-homebrew-deferred-layer-draft"
  ) {
    throw new Error("Homebrew lazy layer draft has an unsupported identity");
  }
  if (
    draft.deferred_trees.length === 0 ||
    draft.deferred_trees.length > HOMEBREW_RUNTIME_LAYER_LIMITS.maxTrees
  ) {
    throw new Error(
      `Homebrew lazy layer draft must have one to ` +
        `${HOMEBREW_RUNTIME_LAYER_LIMITS.maxTrees} deferred trees`,
    );
  }
  if (
    draft.packages.layer.length === 0 ||
    draft.packages.layer.length > HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackages
  ) {
    throw new Error(
      `Homebrew lazy layer draft must have one to ` +
        `${HOMEBREW_RUNTIME_LAYER_LIMITS.maxPackages} layer packages`,
    );
  }
  if (
    draft.selection.requested_packages.length === 0 ||
    draft.selection.requested_packages.length >
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxRequestedPackages
  ) {
    throw new Error(
      `Homebrew lazy layer draft must have one to ` +
        `${HOMEBREW_RUNTIME_LAYER_LIMITS.maxRequestedPackages} requested packages`,
    );
  }
  assertLazyLayerDraftSchemaShape(draft);
  assertAssetIdentity(draft.acceptance_vfs, HOMEBREW_VFS_ASSET, "acceptance VFS");
  assertAssetIdentity(
    evidence.descriptor,
    HOMEBREW_VFS_DESCRIPTOR_ASSET,
    "acceptance descriptor",
  );
  assertAssetIdentity(
    evidence.report,
    HOMEBREW_VFS_REPORT_ASSET,
    "acceptance report",
  );
  assertAssetIdentity(
    evidence.node,
    HOMEBREW_NODE_EVIDENCE_ASSET,
    "Node acceptance evidence",
  );
  assertAssetIdentity(
    evidence.browser,
    HOMEBREW_BROWSER_EVIDENCE_ASSET,
    "browser acceptance evidence",
  );
  const treeAssets = draft.deferred_trees.map((tree) => {
    if (
      tree.transports.length === 0 ||
      tree.transports.length > HOMEBREW_RUNTIME_LAYER_LIMITS.maxTransportsPerTree
    ) {
      throw new Error(
        `Homebrew lazy layer draft tree ${tree.id} must have one to ` +
          `${HOMEBREW_RUNTIME_LAYER_LIMITS.maxTransportsPerTree} transports`,
      );
    }
    const releaseTransports = tree.transports.filter((transport) =>
      transport.kind === "bundle-release"
    );
    if (releaseTransports.length !== 1) {
      throw new Error(
        `Homebrew lazy layer draft tree ${tree.id} must have one bundle release asset`,
      );
    }
    for (const transport of tree.transports) {
      if (transport.kind === "external-https") {
        assertImmutableHttpsTransport(transport.url, tree.id);
      }
    }
    const asset = releaseTransports[0].asset;
    assertAssetIdentity(
      { asset, sha256: tree.content.sha256, bytes: tree.content.bytes },
      homebrewRuntimeLayerPayloadAsset(tree.id),
      `deferred tree ${tree.id}`,
    );
    return { id: tree.id, asset, sha256: tree.content.sha256, bytes: tree.content.bytes };
  });
  const acceptanceTag = `homebrew-vfs-sha256-${draft.acceptance_vfs.sha256}`;
  const acceptanceRoot =
    `https://github.com/${draft.tap.repository}/releases/download/${acceptanceTag}`;
  const releasePlaceholder = "homebrew-runtime-layer-sha256-" + "0".repeat(64);
  const releaseRoot =
    `https://github.com/${draft.tap.repository}/releases/download/${releasePlaceholder}`;
  const descriptor: HomebrewLazyLayerDescriptor = {
    ...draft,
    kind: "kandelo-homebrew-deferred-layer",
    bundle: {
      schema: 1,
      kind: "kandelo-homebrew-runtime-layer-bundle",
      algorithm: "sha256-canonical-json-v1",
      descriptor_encoding: "canonical-json-v1",
      sha256: "0".repeat(64),
      assets: {
        acceptance_vfs: { ...draft.acceptance_vfs },
        acceptance_descriptor: { ...evidence.descriptor },
        acceptance_report: { ...evidence.report },
        acceptance_node_evidence: { ...evidence.node },
        acceptance_browser_evidence: { ...evidence.browser },
        deferred_trees: treeAssets,
      },
    },
    release: {
      repository: draft.tap.repository,
      tag: releasePlaceholder,
    },
    acceptance_vfs: {
      ...draft.acceptance_vfs,
      asset: HOMEBREW_VFS_ASSET,
      url: `${acceptanceRoot}/${HOMEBREW_VFS_ASSET}`,
    },
    acceptance_evidence: {
      descriptor: withReleaseUrl(evidence.descriptor, acceptanceRoot),
      report: withReleaseUrl(evidence.report, acceptanceRoot),
      node: withReleaseUrl(evidence.node, acceptanceRoot),
      browser: withReleaseUrl(evidence.browser, acceptanceRoot),
    },
    deferred_trees: draft.deferred_trees.map((tree) => ({
      ...tree,
      transports: tree.transports.map((transport) =>
        transport.kind === "bundle-release"
          ? {
            ...transport,
            url: `${releaseRoot}/${transport.asset}`,
          }
          : transport
      ),
    })),
  };
  const bundleSha = digest(
    canonicalHomebrewRuntimeLayerBundleIdentityBytes(descriptor),
  );
  const releaseTag = `homebrew-runtime-layer-sha256-${bundleSha}`;
  const closedRoot =
    `https://github.com/${draft.tap.repository}/releases/download/${releaseTag}`;
  descriptor.bundle.sha256 = bundleSha;
  descriptor.release.tag = releaseTag;
  for (const tree of descriptor.deferred_trees) {
    for (const transport of tree.transports) {
      if (transport.kind === "bundle-release") {
        transport.url = `${closedRoot}/${transport.asset}`;
      }
    }
  }
  return descriptor;
}

function assertLazyLayerDraftSchemaShape(
  draft: HomebrewLazyLayerDraftDescriptor,
): void {
  for (const tree of draft.deferred_trees) {
    if (
      tree.activation.capabilities.length === 0 ||
      tree.activation.capabilities.length >
        HOMEBREW_RUNTIME_LAYER_LIMITS.maxActivationCapabilities ||
      tree.activation.capabilities.some((capability) =>
        new TextEncoder().encode(capability).byteLength >
          HOMEBREW_RUNTIME_LAYER_LIMITS.maxActivationCapabilityBytes
      )
    ) {
      throw new Error(
        `Homebrew lazy layer draft tree ${tree.id} has invalid activation capabilities`,
      );
    }
    if (
      tree.activation.roots.length === 0 ||
      tree.activation.roots.length > HOMEBREW_RUNTIME_LAYER_LIMITS.maxActivationRoots ||
      tree.activation.roots.some((root) =>
        new TextEncoder().encode(root).byteLength >
          HOMEBREW_RUNTIME_LAYER_LIMITS.maxPathBytes
      )
    ) {
      throw new Error(
        `Homebrew lazy layer draft tree ${tree.id} has invalid activation roots`,
      );
    }
    const originalBottle = draft.schema === 5;
    const hasPackage = tree.package !== undefined;
    const hasSource = tree.inventory.source !== undefined;
    const hasCompleteMaterialization = tree.inventory.entries.every(
      (entry) => entry.materialization !== undefined,
    );
    const hasAnyMaterialization = tree.inventory.entries.some(
      (entry) => entry.materialization !== undefined,
    );
    if (originalBottle) {
      if (
        !hasPackage || !hasSource || !hasCompleteMaterialization ||
        tree.content.decoder !== "homebrew-bottle-tar-gzip-v1" ||
        tree.content.media_type !==
          "application/vnd.oci.image.layer.v1.tar+gzip"
      ) {
        throw new Error(
          `Homebrew lazy layer schema 5 tree ${tree.id} is not a complete original bottle`,
        );
      }
    } else if (
      hasPackage || hasSource || hasAnyMaterialization ||
      tree.content.decoder !== "zip-v1" ||
      tree.content.media_type !== "application/zip"
    ) {
      throw new Error(
        `Homebrew lazy layer schema 4 tree ${tree.id} is not an exact legacy ZIP tree`,
      );
    }
  }
}

function assertImmutableHttpsTransport(url: string, treeId: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Homebrew lazy layer draft tree ${treeId} has an invalid transport URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(`Homebrew lazy layer draft tree ${treeId} has an unsafe transport URL`);
  }
}

function withReleaseUrl<T extends HomebrewRuntimeLayerAssetIdentity>(
  identity: T,
  releaseRoot: string,
): T & { url: string } {
  return { ...identity, url: `${releaseRoot}/${identity.asset}` };
}

function assertAssetIdentity(
  identity: HomebrewRuntimeLayerAssetIdentity,
  expectedAsset: string,
  label: string,
): void {
  if (
    identity.asset !== expectedAsset ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identity.asset) ||
    new TextEncoder().encode(identity.asset).byteLength >
      HOMEBREW_RUNTIME_LAYER_LIMITS.maxReleaseAssetNameBytes
  ) {
    throw new Error(`Homebrew lazy layer ${label} asset is invalid`);
  }
  if (!SHA256_RE.test(identity.sha256)) {
    throw new Error(`Homebrew lazy layer ${label} digest is invalid`);
  }
  if (!Number.isSafeInteger(identity.bytes) || identity.bytes <= 0) {
    throw new Error(`Homebrew lazy layer ${label} byte count is invalid`);
  }
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
  return [...candidates].sort((left, right) =>
    compareHomebrewCanonicalText(left.tapName, right.tapName)
  );
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
    HOMEBREW_RUNTIME_LAYER_LIMITS.maxDescriptorBytes,
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
  entries.sort((left, right) => compareHomebrewCanonicalText(left.path, right.path));
  for (const entry of entries) {
    const basePath = `/${entry.path}`;
    if (!pathExists(baseFs, basePath)) continue;
    const baseStat = baseFs.lstat(basePath);
    const baseType = baseStat.mode & S_IFMT;
    if (entry.type === "directory" && baseType === S_IFDIR) {
      if ((baseStat.mode & 0o7777) !== entry.mode) {
        throw new Error(
          `Homebrew original bottle mergeable directory mode differs from base: ${basePath}`,
        );
      }
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
  if (entries.length > HOMEBREW_RUNTIME_LAYER_LIMITS.maxEntries) {
    throw new Error(
      `Homebrew lazy layer has ${entries.length} entries; maximum is ` +
        `${HOMEBREW_RUNTIME_LAYER_LIMITS.maxEntries}`,
    );
  }
  return entries;
}

function collectPath(
  fs: MemoryFileSystem,
  vfsPath: string,
  entries: HomebrewLazyLayerEntry[],
  regularInodes: Map<number | bigint, HomebrewLazyLayerEntry>,
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
    names.sort(compareHomebrewCanonicalText);
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
    if (
      targetBytes === 0 ||
      targetBytes > HOMEBREW_RUNTIME_LAYER_LIMITS.maxSymlinkTargetBytes
    ) {
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
    bytes > HOMEBREW_RUNTIME_LAYER_LIMITS.maxPathBytes
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
  const actual = Object.keys(result).sort(compareHomebrewCanonicalText);
  const expected = [...keys].sort(compareHomebrewCanonicalText);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
