import { createHash } from "node:crypto";
import { ABI_VERSION } from "./generated/abi";
import type { StatResult } from "./types";
import type { HomebrewBottleDescriptor } from "./homebrew-bottle-descriptor";
import {
  encodeHomebrewBottleSelection,
  homebrewBottleSelectionSha256,
  projectHomebrewBottleSelection,
} from "./homebrew-bottle-selection";
import type {
  HomebrewLinkEntry,
  HomebrewFlatVfsPlan,
  HomebrewVfsPackagePlan,
  HomebrewVfsPlan,
} from "./homebrew-vfs-planner";
import {
  applyHomebrewCanonicalOptLinks as applyMaterializedOptLinks,
  applyHomebrewCanonicalOptLink as applyMaterializedOptLink,
  applyPreparedHomebrewLinks,
  descriptorMaterializationPackage,
  homebrewCanonicalOptLink as materializedCanonicalOptLink,
  homebrewManifestSourcePath as materializedManifestSourcePath,
  mapHomebrewBottleEntryToGuestPath as mapMaterializedBottleEntry,
  prepareHomebrewKeg,
  prepareStagedHomebrewKegReceipts,
  preflightHomebrewStagingDirectories,
  preflightPreparedHomebrewLinksAndOpt,
  releasePreparedHomebrewKegEntries,
  relocatePreparedHomebrewKeg,
  stagePreparedHomebrewKeg,
  HomebrewVfsMaterializationError,
  type HomebrewBottleMaterializationPackage,
  type PreparedHomebrewKeg,
} from "./homebrew-vfs-materializer";
import { resolveHomebrewVfsResourcePolicy } from "./homebrew-vfs-resource-policy";
import {
  finalizeHomebrewRuntimeSupport,
  HomebrewRuntimeSupportMaterializationError,
  overlayPreparedHomebrewRuntimeSupport,
  prepareHomebrewRuntimeSupport,
} from "./homebrew-runtime-support-materializer";
import { MemoryFileSystem } from "./vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsFile,
} from "./vfs/image-helpers";
import { KANDELO_HOMEBREW_GUEST_LAYOUT } from "./homebrew-guest-layout";

const DEFAULT_IMAGE_BYTES = 128 * 1024 * 1024;
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const MODE_BITS = 0o7777;
const TEXT_ENCODER = new TextEncoder();
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const MAX_BREWFILE_BYTES = 65_536;
const MAX_MIGRATION_LOCK_BYTES = 65_536;
const MAX_RUNTIME_STATE_TEXT_BYTES = 65_536;
const MAX_RUNTIME_STATE_ID = 0x7fff_ffff;

export class HomebrewVfsBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomebrewVfsBuildError";
  }
}

export interface HomebrewVfsBuildOptions {
  fs?: MemoryFileSystem;
  loadBottleBytes: (
    pkg: HomebrewVfsPackagePlan,
  ) => Uint8Array | Promise<Uint8Array>;
  writeProfile?: boolean;
  createdBy?: string;
  selectionSource?: HomebrewVfsSelectionSource;
  catalogCheckout?: HomebrewVfsCatalogCheckout;
  compatibilityPolicy?: HomebrewVfsCompatibilityPolicy;
  migrationLock?: HomebrewVfsMigrationLockBinding;
  /** Consumer-owned aliases/profile/runtime state may be applied after lazy trees register. */
  consumerState?: "apply" | "defer";
}

/**
 * Consumer-owned namespace and writable state applied only after every eager
 * package and deferred package tree has registered its declared paths.
 */
export interface HomebrewVfsConsumerStateOptions {
  fs: MemoryFileSystem;
  compatibilityPolicy?: HomebrewVfsCompatibilityPolicy;
  writeProfile?: boolean;
}

export interface HomebrewVfsConsumerStateResult {
  compatibilityLinks?: HomebrewVfsCompatibilityLinkReport[];
  linkConflicts: HomebrewVfsLinkConflictReport[];
  runtimeState: HomebrewVfsRuntimeStateReport[];
}

export interface HomebrewVfsMigrationLockBinding {
  sha256: string;
  bytes: number;
}

export interface HomebrewVfsCompatibilityPolicy {
  mirror_link_manifest_bin: {
    targets: string[];
  };
  link_conflict_owners: Array<{
    target: string;
    package: string;
    reason: string;
  }>;
  aliases: Array<{
    package: string;
    source_kind: "link" | "keg";
    source: string;
    targets: string[];
  }>;
  runtime_state?: HomebrewVfsRuntimeStateDeclaration[];
}

export interface HomebrewVfsRuntimeStateDeclaration {
  /** Apply this consumer-owned state only when the exact Formula is selected. */
  requires_package: string;
  path: string;
  kind: "directory" | "empty_file" | "text_file";
  mode: number;
  uid: number;
  gid: number;
  reason: string;
  contents?: string;
}

export interface HomebrewVfsCompatibilityLinkReport {
  path: string;
  target: string;
  package: string;
  source: string;
  ownership: "bottle-link-manifest" | "bottle-keg";
}

export interface HomebrewVfsLinkConflictReport {
  path: string;
  target: string;
  owners: string[];
  selected_package: string;
  skipped_packages: string[];
  reason: string;
  resolution: "migration-lock";
}

export interface HomebrewVfsRuntimeStateReport {
  requires_package: string;
  path: string;
  kind: HomebrewVfsRuntimeStateDeclaration["kind"];
  mode: number;
  uid: number;
  gid: number;
  reason: string;
  content_sha256?: string;
  content_bytes?: number;
}

export interface HomebrewVfsCatalogCheckout {
  tapRepository: string;
  tapName: string;
  checkoutCommit: string;
}

export interface HomebrewVfsCatalogReport {
  tap_repository: string;
  tap_name: string;
  checkout_commit: string;
}

export interface HomebrewVfsSelectionSource {
  kind: "brewfile";
  parser: "kandelo-static-brewfile-v1";
  sha256: string;
  bytes: number;
  requestedPackages: string[];
}

export interface HomebrewVfsSelectionReport {
  kind: "packages" | "brewfile";
  requested_packages: string[];
  requested_packages_sha256: string;
  brewfile?: {
    parser: "kandelo-static-brewfile-v1";
    sha256: string;
    bytes: number;
  };
}

export interface HomebrewVfsPackageReport {
  name: string;
  full_name: string;
  tap_repository: string;
  tap_name: string;
  tap_commit: string;
  version: string;
  arch: string;
  source_status: "success" | "fallback";
  metadata_status: string;
  url: string;
  sha256: string;
  bytes: number;
  cache_key_sha: string;
  link_manifest: string;
  prefix: string;
  keg: string;
  staged_files: number;
  staged_directories: number;
  staged_symlinks: number;
  receipts: string[];
  links: string[];
  opt_link: HomebrewVfsOptLinkReport;
  built_from?: {
    tap_repository: string;
    tap_commit: string;
    kandelo_repository: string;
    kandelo_commit: string;
    formula_sha256: string;
  };
}

export interface HomebrewVfsOptLinkReport {
  path: string;
  target: string;
}

export interface HomebrewVfsBuildReport {
  schema: 1;
  image?: string;
  selection: HomebrewVfsSelectionReport;
  catalog?: HomebrewVfsCatalogReport;
  compatibility_links?: HomebrewVfsCompatibilityLinkReport[];
  link_conflicts?: HomebrewVfsLinkConflictReport[];
  runtime_state?: HomebrewVfsRuntimeStateReport[];
  materialization?: {
    policy: "kandelo-homebrew-vfs-materialization-policy";
    embedded_package_order: string[];
    deferred_package_order: string[];
    embedded_tree_count: number;
    deferred_tree_count: number;
    runtime_support?: {
      id: "homebrew-runtime-support";
      activation_root: "/usr/bin/brew";
      activation_capability: "homebrew:runtime";
      package_order: string[];
      tree_count: number;
      deferred_relocation_formulae: string[];
    };
    bottle_mirror: {
      repository: string;
      tag: string;
      collection_sha256: string;
      asset_count: number;
      manifest_path: string;
      manifest_sha256: string;
      manifest_bytes: number;
    };
  };
  migration_lock?: HomebrewVfsMigrationLockBinding;
  metadata: {
    tap_repository: string;
    tap_name: string;
    tap_commit: string;
    kandelo_repository: string;
    kandelo_commit: string;
    kandelo_abi: number;
    release_tag: string;
  };
  packages: HomebrewVfsPackageReport[];
}

export interface HomebrewVfsBuildResult {
  fs: MemoryFileSystem;
  report: HomebrewVfsBuildReport;
}

export interface HomebrewFlatVfsBuildOptions {
  loadBottleBytes: (
    pkg: HomebrewBottleDescriptor,
  ) => Uint8Array | Promise<Uint8Array>;
  /** Optional source state is copied into a private filesystem before mutation. */
  baseFs?: MemoryFileSystem;
}

export interface HomebrewFlatVfsLinkOwnerReport {
  target: string;
  selected_package: string;
  claimants: string[];
}

export interface HomebrewFlatVfsPackageReport {
  name: string;
  full_name: string;
  version: string;
  revision: number;
  bottle_rebuild: number;
  arch: string;
  kandelo_abi: number;
  sha256: string;
  bytes: number;
  prefix: string;
  keg: string;
  staged_files: number;
  staged_directories: number;
  staged_symlinks: number;
  expanded_bytes: number;
  entries: number;
  path_bytes: number;
  link_bytes: number;
  receipts: string[];
  runtime_dependencies: Array<{
    full_name: string;
    version: string;
    revision: number;
  }>;
  links: string[];
  opt_link: HomebrewVfsOptLinkReport;
}

export interface HomebrewFlatVfsBuildReport {
  schema: 1;
  name: string;
  arch: string;
  kandelo_abi: number;
  selection_sha256: string;
  requested_vfs_filename: string;
  resource_policy: "kandelo-homebrew-vfs-generous-v1";
  link_policy: "kandelo-homebrew-link-ownership-v1";
  runtime_support: "kandelo-homebrew-bootstrap-v1";
  environment: { PATH: string };
  link_owners: HomebrewFlatVfsLinkOwnerReport[];
  totals: {
    compressed_bytes: number;
    expanded_bytes: number;
    entries: number;
    path_bytes: number;
    link_bytes: number;
  };
  packages: HomebrewFlatVfsPackageReport[];
}

export interface HomebrewFlatVfsBuildResult {
  fs: MemoryFileSystem;
  report: HomebrewFlatVfsBuildReport;
}

const FLAT_LINK_OWNERSHIP_V1 = Object.freeze({
  id: "kandelo-homebrew-link-ownership-v1" as const,
  collisions: Object.freeze({
    "bin/ed": Object.freeze({
      owner: "kandelo-dev/tap-core/ed",
      claimants: Object.freeze([
        "kandelo-dev/tap-core/ed",
        "kandelo-dev/tap-core/posix-utils-lite",
      ]),
    }),
    "bin/ex": Object.freeze({
      owner: "kandelo-dev/tap-core/vim",
      claimants: Object.freeze([
        "kandelo-dev/tap-core/posix-utils-lite",
        "kandelo-dev/tap-core/vim",
      ]),
    }),
    "bin/more": Object.freeze({
      owner: "kandelo-dev/tap-core/less",
      claimants: Object.freeze([
        "kandelo-dev/tap-core/less",
        "kandelo-dev/tap-core/posix-utils-lite",
      ]),
    }),
  }),
});

interface HomebrewVfsLinkResolution {
  selectedPackageByPath: Map<string, string>;
  reports: HomebrewVfsLinkConflictReport[];
}

/**
 * Apply the full consumer-owned shell surface above an already assembled
 * Homebrew namespace. Deferred regular files may still be unresolved: their
 * registered inode metadata is sufficient to validate executable aliases
 * without fetching bottle contents.
 */
export function applyHomebrewVfsConsumerState(
  plan: HomebrewVfsPlan,
  options: HomebrewVfsConsumerStateOptions,
): HomebrewVfsConsumerStateResult {
  const linkResolution = resolveLinkConflicts(plan, options.compatibilityPolicy);
  const runtimeStateDeclarations = prepareRuntimeState(
    plan,
    options.compatibilityPolicy?.runtime_state,
  );
  return applyHomebrewVfsConsumerStateWithResolution(
    plan,
    options,
    linkResolution,
    runtimeStateDeclarations,
  );
}

/** Build a provenance-free flat bottle selection into a private VFS. */
export async function buildHomebrewVfsSelection(
  planValue: HomebrewFlatVfsPlan,
  options: HomebrewFlatVfsBuildOptions,
): Promise<HomebrewFlatVfsBuildResult> {
  const plan = snapshotFlatPlan(planValue);
  const policy = resolveHomebrewVfsResourcePolicy(plan.resourcePolicy);
  const plannedCompressedBytes = plan.packages.reduce(
    (total, descriptor) => addFlatResource(total, descriptor.bytes, "compressed bytes"),
    0,
  );
  if (plannedCompressedBytes > policy.aggregate.maxCompressedBytes) {
    throw new HomebrewVfsBuildError(
      `flat Homebrew selection exceeds aggregate compressed-byte cap ` +
        `${policy.aggregate.maxCompressedBytes}`,
    );
  }
  const prepared: PreparedHomebrewKeg[] = [];
  const totals = {
    compressed_bytes: 0,
    expanded_bytes: 0,
    entries: 0,
    path_bytes: 0,
    link_bytes: 0,
  };

  // Authenticate and bound the entire closure before any namespace mutation.
  for (const descriptor of plan.packages) {
    const remainingExpandedBytes = policy.aggregate.maxExpandedBytes -
      totals.expanded_bytes;
    const remainingEntries = policy.aggregate.maxEntries - totals.entries;
    if (remainingExpandedBytes <= 0) {
      throw new HomebrewVfsBuildError(
        `flat Homebrew selection exceeds aggregate expanded-byte cap ` +
          `${policy.aggregate.maxExpandedBytes}`,
      );
    }
    if (remainingEntries <= 0) {
      throw new HomebrewVfsBuildError(
        `flat Homebrew selection exceeds aggregate entry cap ${policy.aggregate.maxEntries}`,
      );
    }
    const loaded = await options.loadBottleBytes(structuredClone(descriptor));
    if (!(loaded instanceof Uint8Array)) {
      throw new HomebrewVfsBuildError(
        `flat bottle loader returned non-Uint8Array bytes for ${descriptor.fullName}`,
      );
    }
    const item = runMaterializer(() => prepareHomebrewKeg(
      descriptorMaterializationPackage(descriptor),
      loaded,
      {
        tarLimits: {
          maxCompressedBytes: policy.bottle.maxCompressedBytes,
          maxUncompressedBytes: Math.min(
            policy.bottle.maxExpandedBytes,
            remainingExpandedBytes,
          ),
          maxEntries: Math.min(policy.bottle.maxEntries, remainingEntries),
          maxPathBytes: policy.bottle.maxPathBytes,
          maxLinkBytes: policy.bottle.maxLinkBytes,
        },
        expectedDependencies: descriptor.dependencies,
        requireExactKegContainment: true,
      },
    ));
    prepared.push(item);
    totals.compressed_bytes = addFlatResource(
      totals.compressed_bytes,
      item.measurement.compressedBytes,
      "compressed bytes",
    );
    totals.expanded_bytes = addFlatResource(
      totals.expanded_bytes,
      item.measurement.expandedBytes,
      "expanded bytes",
    );
    totals.entries = addFlatResource(
      totals.entries,
      item.measurement.entries,
      "entries",
    );
    totals.path_bytes = addFlatResource(
      totals.path_bytes,
      item.measurement.pathBytes,
      "path bytes",
    );
    totals.link_bytes = addFlatResource(
      totals.link_bytes,
      item.measurement.linkBytes,
      "link bytes",
    );
  }
  if (totals.compressed_bytes > policy.aggregate.maxCompressedBytes) {
    throw new HomebrewVfsBuildError(
      `flat Homebrew selection exceeds aggregate compressed-byte cap ` +
        `${policy.aggregate.maxCompressedBytes}`,
    );
  }
  if (totals.expanded_bytes > policy.aggregate.maxExpandedBytes) {
    throw new HomebrewVfsBuildError(
      `flat Homebrew selection exceeds aggregate expanded-byte cap ` +
        `${policy.aggregate.maxExpandedBytes}`,
    );
  }
  if (totals.entries > policy.aggregate.maxEntries) {
    throw new HomebrewVfsBuildError(
      `flat Homebrew selection exceeds aggregate entry cap ${policy.aggregate.maxEntries}`,
    );
  }

  const runtimeSupportIndexes = plan.packages.flatMap((descriptor, index) =>
    descriptor.materialization === "homebrew-runtime-support-v1" ? [index] : []
  );
  if (runtimeSupportIndexes.length !== 1) {
    throw new HomebrewVfsBuildError(
      "flat Homebrew plan must contain exactly one runtime-support descriptor",
    );
  }
  const runtimeSupportIndex = runtimeSupportIndexes[0]!;
  const runtimeSupport = runRuntimeSupport(() => prepareHomebrewRuntimeSupport(
    plan.packages[runtimeSupportIndex]!,
    prepared[runtimeSupportIndex]!,
    policy.supportZip,
  ));

  const linkResolution = resolveFlatLinkOwnership(plan.packages, plan.linkPolicy);
  preflightFlatOptIdentities(plan.packages);
  const fs = options.baseFs === undefined
    ? createFlatFs(policy.vfs.maxByteLength)
    : options.baseFs.rebaseToNewFileSystem(policy.vfs.maxByteLength);
  runMaterializer(() => preflightHomebrewStagingDirectories(
    fs,
    prepared,
  ));

  const staged: Array<ReturnType<typeof stagePreparedHomebrewKeg>> = [];
  for (const item of prepared) {
    staged.push(runMaterializer(() => stagePreparedHomebrewKeg(fs, item)));
    runMaterializer(() => releasePreparedHomebrewKegEntries(item));
  }
  for (const item of prepared) {
    runMaterializer(() => relocatePreparedHomebrewKeg(fs, item));
  }

  await runRuntimeSupportAsync(() => overlayPreparedHomebrewRuntimeSupport(
    fs,
    runtimeSupport,
  ));

  runMaterializer(() => preflightPreparedHomebrewLinksAndOpt(
    fs,
    prepared,
    ({ prepared: item, entry }) =>
      linkResolution.selectedOwnerByTarget.get(entry.target) === item.input.fullName,
  ));

  const appliedLinks = prepared.map((item) =>
    runMaterializer(() => applyPreparedHomebrewLinks(
      fs,
      item,
      (entry) => linkResolution.selectedOwnerByTarget.get(entry.target) === item.input.fullName,
    ))
  );
  runMaterializer(() => applyMaterializedOptLinks(fs, prepared.map((item) => item.input)));
  runRuntimeSupport(() => finalizeHomebrewRuntimeSupport(fs, runtimeSupport));
  const path = flatPath(plan.packages);
  if (path.length > 0) {
    ensureDirRecursive(fs, "/etc/profile.d");
    writeVfsFile(
      fs,
      "/etc/profile.d/kandelo-homebrew.sh",
      `export PATH="${path.join(":")}:$PATH"\n`,
      0o644,
    );
  }

  const report: HomebrewFlatVfsBuildReport = {
    schema: 1,
    name: plan.name,
    arch: plan.arch,
    kandelo_abi: plan.kandeloAbi,
    selection_sha256: plan.selectionSha256,
    requested_vfs_filename: plan.requestedVfsFilename,
    resource_policy: plan.resourcePolicy,
    link_policy: plan.linkPolicy,
    runtime_support: plan.runtimeSupport,
    environment: { PATH: path.join(":") },
    link_owners: linkResolution.reports,
    totals,
    packages: plan.packages.map((descriptor, index) => {
      const item = prepared[index]!;
      const stage = staged[index]!;
      return {
        name: descriptor.name,
        full_name: descriptor.fullName,
        version: descriptor.version,
        revision: descriptor.revision,
        bottle_rebuild: descriptor.bottleRebuild,
        arch: descriptor.arch,
        kandelo_abi: descriptor.kandeloAbi,
        sha256: descriptor.sha256,
        bytes: item.measurement.compressedBytes,
        prefix: descriptor.prefix,
        keg: descriptor.keg,
        staged_files: stage.stagedFiles,
        staged_directories: stage.stagedDirectories,
        staged_symlinks: stage.stagedSymlinks,
        expanded_bytes: item.measurement.expandedBytes,
        entries: item.measurement.entries,
        path_bytes: item.measurement.pathBytes,
        link_bytes: item.measurement.linkBytes,
        receipts: [...descriptor.receipts],
        runtime_dependencies: item.runtimeDependencies.map((dependency) => ({
          full_name: dependency.fullName,
          version: dependency.version,
          revision: dependency.revision,
        })),
        links: appliedLinks[index]!,
        opt_link: itemOptLink(item.input),
      };
    }),
  };
  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsFile(
    fs,
    "/etc/kandelo/homebrew-vfs.json",
    `${JSON.stringify(report, null, 2)}\n`,
    0o644,
  );
  return { fs, report };
}

export async function buildHomebrewVfs(
  plan: HomebrewVfsPlan,
  options: HomebrewVfsBuildOptions,
): Promise<HomebrewVfsBuildResult> {
  const fs = options.fs ?? createDefaultFs();
  const packageReports: HomebrewVfsPackageReport[] = [];
  const selection = createSelectionReport(plan, options.selectionSource);
  const catalog = createCatalogReport(plan, options.catalogCheckout);
  const migrationLock = createMigrationLockBinding(options.migrationLock);
  const consumerState = options.consumerState ?? "apply";
  if (consumerState !== "apply" && consumerState !== "defer") {
    throw new HomebrewVfsBuildError("Homebrew consumer-state mode is invalid");
  }
  const linkResolution = resolveLinkConflicts(plan, options.compatibilityPolicy);
  // WHY: a deferred bottle collection owns only package trees and link
  // conflict resolution. Consumer-owned files are validated against the final
  // composed namespace later; asking a focused delta to validate base-owned
  // runtime state makes a truthful partial plan look incomplete.
  const runtimeStateDeclarations = consumerState === "apply"
    ? prepareRuntimeState(
      plan,
      options.compatibilityPolicy?.runtime_state,
    )
    : [];

  ensureDirRecursive(fs, "/etc/kandelo");
  const materializationInputs: HomebrewBottleMaterializationPackage[] = [];

  for (const pkg of plan.packages) {
    const bottleBytes = await options.loadBottleBytes(pkg);
    const input = legacyMaterializationPackage(pkg);
    materializationInputs.push(input);
    let prepared = runMaterializer(() => prepareHomebrewKeg(input, bottleBytes, {
      receiptSource: "staged",
    }));
    const staged = runMaterializer(() => stagePreparedHomebrewKeg(fs, prepared));
    runMaterializer(() => releasePreparedHomebrewKegEntries(prepared));
    prepared = runMaterializer(() => prepareStagedHomebrewKegReceipts(fs, prepared));
    runMaterializer(() => relocatePreparedHomebrewKeg(fs, prepared));
    const links = runMaterializer(() => applyPreparedHomebrewLinks(fs, prepared, (_entry, targetPath) => {
      const selectedPackage = linkResolution.selectedPackageByPath.get(targetPath);
      return selectedPackage === undefined || selectedPackage === pkg.fullName;
    }));

    packageReports.push({
      name: pkg.name,
      full_name: pkg.fullName,
      tap_repository: pkg.tapRepository,
      tap_name: pkg.tapName,
      tap_commit: pkg.tapCommit,
      version: pkg.version,
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
      staged_files: staged.stagedFiles,
      staged_directories: staged.stagedDirectories,
      staged_symlinks: staged.stagedSymlinks,
      receipts: [...pkg.linkManifest.receipts],
      links,
      opt_link: itemOptLink(input),
      ...(pkg.builtFrom === undefined ? {} : {
        built_from: {
          tap_repository: pkg.builtFrom.tapRepository,
          tap_commit: pkg.builtFrom.tapCommit,
          kandelo_repository: pkg.builtFrom.kandeloRepository,
          kandelo_commit: pkg.builtFrom.kandeloCommit,
          formula_sha256: pkg.builtFrom.formulaSha256,
        },
      }),
    });
  }

  for (const input of materializationInputs) {
    runMaterializer(() => applyMaterializedOptLink(fs, input));
  }
  const { compatibilityLinks, runtimeState } = consumerState === "apply"
    ? applyHomebrewVfsConsumerStateWithResolution(
      plan,
      {
        fs,
        compatibilityPolicy: options.compatibilityPolicy,
        writeProfile: options.writeProfile,
      },
      linkResolution,
      runtimeStateDeclarations,
    )
    : { compatibilityLinks: undefined, runtimeState: [] };

  const report: HomebrewVfsBuildReport = {
    schema: 1,
    selection,
    ...(catalog === undefined ? {} : { catalog }),
    ...(compatibilityLinks === undefined ? {} : {
      compatibility_links: compatibilityLinks,
    }),
    ...(linkResolution.reports.length === 0 ? {} : {
      link_conflicts: linkResolution.reports,
    }),
    ...(runtimeState.length === 0 ? {} : { runtime_state: runtimeState }),
    ...(migrationLock === undefined ? {} : { migration_lock: migrationLock }),
    metadata: {
      tap_repository: plan.tapRepository,
      tap_name: plan.tapName,
      tap_commit: plan.tapCommit,
      kandelo_repository: plan.kandeloRepository,
      kandelo_commit: plan.kandeloCommit,
      kandelo_abi: plan.kandeloAbi,
      release_tag: plan.releaseTag,
    },
    packages: packageReports,
  };

  writeHomebrewVfsComposition(
    fs,
    plan,
    report,
    options.createdBy ?? "host/src/homebrew-vfs-builder.ts",
  );

  return { fs, report };
}

function applyHomebrewVfsConsumerStateWithResolution(
  plan: HomebrewVfsPlan,
  options: HomebrewVfsConsumerStateOptions,
  linkResolution: HomebrewVfsLinkResolution,
  runtimeStateDeclarations: readonly HomebrewVfsRuntimeStateDeclaration[],
): HomebrewVfsConsumerStateResult {
  const compatibilityLinks = options.compatibilityPolicy === undefined
    ? undefined
    : applyCompatibilityLinks(
      options.fs,
      plan,
      options.compatibilityPolicy,
      linkResolution,
    );
  if (options.writeProfile) writeProfileFragment(options.fs, plan);
  return {
    ...(compatibilityLinks === undefined ? {} : { compatibilityLinks }),
    linkConflicts: [...linkResolution.reports],
    runtimeState: applyRuntimeState(options.fs, runtimeStateDeclarations),
  };
}

/** Write the authoritative guest composition after all package paths exist. */
export function writeHomebrewVfsComposition(
  fs: MemoryFileSystem,
  plan: HomebrewVfsPlan,
  report: HomebrewVfsBuildReport,
  createdBy = "host/src/homebrew-vfs-builder.ts",
): void {
  ensureDirRecursive(fs, "/etc/kandelo");
  const compositionPath = "/etc/kandelo/homebrew-vfs.json";
  if (tryLstat(fs, compositionPath) !== null) {
    throw new HomebrewVfsBuildError(
      `refusing to replace existing Homebrew VFS composition: ${compositionPath}`,
    );
  }
  const plannedPackageNames = plan.packages.map((pkg) => pkg.fullName);
  const reportedPackageNames = report.packages.map((pkg) => pkg.full_name);
  if (
    new Set(plannedPackageNames).size !== plannedPackageNames.length ||
    new Set(reportedPackageNames).size !== reportedPackageNames.length ||
    JSON.stringify(plannedPackageNames) !== JSON.stringify(reportedPackageNames)
  ) {
    throw new HomebrewVfsBuildError(
      "Homebrew VFS composition plan/report package order differs",
    );
  }
  const packageByName = new Map(plan.packages.map((pkg) => [pkg.fullName, pkg]));
  writeVfsFile(
    fs,
    compositionPath,
    JSON.stringify({
      schema: 1,
      created_by: createdBy,
      selection: report.selection,
      ...(report.catalog === undefined ? {} : { catalog: report.catalog }),
      ...(report.compatibility_links === undefined ? {} : {
        compatibility_links: report.compatibility_links,
      }),
      ...(report.link_conflicts === undefined ? {} : {
        link_conflicts: report.link_conflicts,
      }),
      ...(report.runtime_state === undefined ? {} : {
        runtime_state: report.runtime_state,
      }),
      ...(report.materialization === undefined ? {} : {
        materialization: report.materialization,
      }),
      ...(report.migration_lock === undefined ? {} : {
        migration_lock: report.migration_lock,
      }),
      metadata: report.metadata,
      packages: report.packages.map((pkg) => ({
        name: pkg.name,
        full_name: pkg.full_name,
        tap_repository: pkg.tap_repository,
        tap_name: pkg.tap_name,
        tap_commit: pkg.tap_commit,
        version: pkg.version,
        arch: pkg.arch,
        source_status: pkg.source_status,
        metadata_status: pkg.metadata_status,
        url: pkg.url,
        sha256: pkg.sha256,
        bytes: pkg.bytes,
        cache_key_sha: pkg.cache_key_sha,
        link_manifest: pkg.link_manifest,
        prefix: pkg.prefix,
        keg: pkg.keg,
        opt_link: pkg.opt_link,
        ...(pkg.built_from === undefined ? {} : { built_from: pkg.built_from }),
        env: packageByName.get(pkg.full_name)!.linkManifest.env,
      })),
    }, null, 2) + "\n",
    0o644,
  );
}

function createCatalogReport(
  plan: HomebrewVfsPlan,
  checkout: HomebrewVfsCatalogCheckout | undefined,
): HomebrewVfsCatalogReport | undefined {
  if (checkout === undefined) return undefined;
  if (
    checkout.tapRepository !== plan.tapRepository ||
    checkout.tapName !== plan.tapName
  ) {
    throw new HomebrewVfsBuildError(
      "Homebrew consumer catalog identity does not match the planned root tap",
    );
  }
  if (!GIT_SHA_RE.test(checkout.checkoutCommit)) {
    throw new HomebrewVfsBuildError(
      "Homebrew consumer catalog checkout must be a lowercase 40-character git SHA",
    );
  }
  return {
    tap_repository: checkout.tapRepository,
    tap_name: checkout.tapName,
    checkout_commit: checkout.checkoutCommit,
  };
}

function createMigrationLockBinding(
  binding: HomebrewVfsMigrationLockBinding | undefined,
): HomebrewVfsMigrationLockBinding | undefined {
  if (binding === undefined) return undefined;
  if (
    !SHA256_RE.test(binding.sha256) ||
    !Number.isSafeInteger(binding.bytes) ||
    binding.bytes <= 0 ||
    binding.bytes > MAX_MIGRATION_LOCK_BYTES
  ) {
    throw new HomebrewVfsBuildError("Homebrew migration lock provenance is invalid");
  }
  return { sha256: binding.sha256, bytes: binding.bytes };
}

function createSelectionReport(
  plan: HomebrewVfsPlan,
  source: HomebrewVfsSelectionSource | undefined,
): HomebrewVfsSelectionReport {
  const requestedPackages = [...plan.requestedPackages];
  if (requestedPackages.length === 0) {
    throw new HomebrewVfsBuildError("Homebrew VFS plan has no requested packages");
  }
  const requestedPackagesSha256 = sha256(
    TEXT_ENCODER.encode(JSON.stringify(requestedPackages)),
  );
  if (source === undefined) {
    return {
      kind: "packages",
      requested_packages: requestedPackages,
      requested_packages_sha256: requestedPackagesSha256,
    };
  }
  if (
    source.kind !== "brewfile" ||
    source.parser !== "kandelo-static-brewfile-v1" ||
    !SHA256_RE.test(source.sha256) ||
    !Number.isInteger(source.bytes) ||
    source.bytes <= 0 ||
    source.bytes > MAX_BREWFILE_BYTES
  ) {
    throw new HomebrewVfsBuildError("Homebrew VFS Brewfile selection provenance is invalid");
  }
  if (
    !Array.isArray(source.requestedPackages) ||
    source.requestedPackages.length !== requestedPackages.length ||
    source.requestedPackages.some((pkg, index) => pkg !== requestedPackages[index])
  ) {
    throw new HomebrewVfsBuildError(
      "Homebrew VFS Brewfile requested packages do not match the plan roots",
    );
  }
  return {
    kind: "brewfile",
    requested_packages: requestedPackages,
    requested_packages_sha256: requestedPackagesSha256,
    brewfile: {
      parser: source.parser,
      sha256: source.sha256,
      bytes: source.bytes,
    },
  };
}

function snapshotFlatPlan(value: HomebrewFlatVfsPlan): HomebrewFlatVfsPlan {
  const expectedKeys = [
    "schema",
    "name",
    "arch",
    "kandeloAbi",
    "selectionSha256",
    "requestedVfsFilename",
    "resourcePolicy",
    "linkPolicy",
    "runtimeSupport",
    "packages",
  ];
  if (typeof value !== "object" || value === null) {
    throw new HomebrewVfsBuildError("flat Homebrew VFS plan must be an object");
  }
  const cloned = structuredClone(value) as HomebrewFlatVfsPlan;
  const actualKeys = Object.keys(cloned);
  if (
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key) => expectedKeys.includes(key))
  ) {
    throw new HomebrewVfsBuildError("flat Homebrew VFS plan has unknown or missing fields");
  }
  if (!SHA256_RE.test(cloned.selectionSha256)) {
    throw new HomebrewVfsBuildError("flat Homebrew VFS plan selectionSha256 is invalid");
  }
  const selection = projectHomebrewBottleSelection({
    schema: cloned.schema,
    name: cloned.name,
    arch: cloned.arch,
    kandeloAbi: cloned.kandeloAbi,
    bottles: cloned.packages,
    requestedVfsFilename: cloned.requestedVfsFilename,
    resourcePolicy: cloned.resourcePolicy,
    linkPolicy: cloned.linkPolicy,
    runtimeSupport: cloned.runtimeSupport,
  }, { expectedAbi: ABI_VERSION });
  const actualSelectionSha256 = homebrewBottleSelectionSha256(
    encodeHomebrewBottleSelection(selection),
  );
  if (cloned.selectionSha256 !== actualSelectionSha256) {
    throw new HomebrewVfsBuildError(
      "flat Homebrew VFS plan selectionSha256 does not match its canonical selection",
    );
  }
  return {
    schema: 1,
    name: selection.name,
    arch: selection.arch,
    kandeloAbi: selection.kandeloAbi,
    selectionSha256: cloned.selectionSha256,
    requestedVfsFilename: selection.requestedVfsFilename,
    resourcePolicy: selection.resourcePolicy,
    linkPolicy: selection.linkPolicy,
    runtimeSupport: selection.runtimeSupport,
    packages: selection.bottles,
  };
}

function resolveFlatLinkOwnership(
  packages: readonly HomebrewBottleDescriptor[],
  policyId: HomebrewFlatVfsPlan["linkPolicy"],
): {
  selectedOwnerByTarget: Map<string, string>;
  reports: HomebrewFlatVfsLinkOwnerReport[];
} {
  if (policyId !== FLAT_LINK_OWNERSHIP_V1.id) {
    throw new HomebrewVfsBuildError(`unknown flat Homebrew link policy ${policyId}`);
  }
  const claimantsByTarget = new Map<string, string[]>();
  for (const pkg of packages) {
    for (const link of pkg.links) {
      const claimants = claimantsByTarget.get(link.target) ?? [];
      claimants.push(pkg.fullName);
      claimantsByTarget.set(link.target, claimants);
    }
  }
  const selectedOwnerByTarget = new Map<string, string>();
  const reports: HomebrewFlatVfsLinkOwnerReport[] = [];
  for (const [target, unsortedClaimants] of claimantsByTarget) {
    const claimants = [...unsortedClaimants].sort();
    if (claimants.length === 1) {
      selectedOwnerByTarget.set(target, claimants[0]!);
      continue;
    }
    const declaration = FLAT_LINK_OWNERSHIP_V1.collisions[
      target as keyof typeof FLAT_LINK_OWNERSHIP_V1.collisions
    ];
    if (
      declaration === undefined ||
      claimants.length !== declaration.claimants.length ||
      claimants.some((claimant, index) => claimant !== declaration.claimants[index])
    ) {
      throw new HomebrewVfsBuildError(
        `flat Homebrew link target ${target} has undeclared claimants ${claimants.join(", ")}`,
      );
    }
    selectedOwnerByTarget.set(target, declaration.owner);
    reports.push({
      target,
      selected_package: declaration.owner,
      claimants,
    });
  }
  return { selectedOwnerByTarget, reports };
}

function preflightFlatOptIdentities(packages: readonly HomebrewBottleDescriptor[]): void {
  const byPath = new Map<string, string>();
  for (const pkg of packages) {
    const path = `${pkg.prefix}/opt/${pkg.name}`;
    const existing = byPath.get(path);
    if (existing !== undefined) {
      throw new HomebrewVfsBuildError(
        `flat Homebrew opt path ${path} is shared by ${existing} and ${pkg.fullName}`,
      );
    }
    byPath.set(path, pkg.fullName);
  }
}

function flatPath(packages: readonly HomebrewBottleDescriptor[]): string[] {
  const paths = new Set<string>();
  for (const pkg of packages) {
    for (const relative of pkg.pathPrepend) {
      paths.add(joinGuestPath(pkg.prefix, relative));
    }
  }
  return [...paths];
}

function itemOptLink(pkg: HomebrewBottleMaterializationPackage): HomebrewVfsOptLinkReport {
  return materializedCanonicalOptLink(pkg);
}

function addFlatResource(current: number, amount: number, label: string): number {
  const sum = current + amount;
  if (!Number.isSafeInteger(sum)) {
    throw new HomebrewVfsBuildError(`flat Homebrew aggregate ${label} is unsafe`);
  }
  return sum;
}

function createFlatFs(maxByteLength: number): MemoryFileSystem {
  const SharedArrayBufferCtor = SharedArrayBuffer as new (
    byteLength: number,
    options?: { maxByteLength?: number },
  ) => SharedArrayBuffer;
  const initialByteLength = Math.min(DEFAULT_IMAGE_BYTES, maxByteLength);
  const sab = new SharedArrayBufferCtor(initialByteLength, { maxByteLength });
  return MemoryFileSystem.create(sab, maxByteLength);
}

function legacyMaterializationPackage(
  pkg: HomebrewVfsPackagePlan,
): HomebrewBottleMaterializationPackage {
  return {
    name: pkg.name,
    fullName: pkg.fullName,
    version: pkg.version,
    arch: pkg.arch,
    prefix: pkg.prefix,
    cellar: pkg.cellar,
    keg: pkg.keg,
    payloadRoot: pkg.payloadRoot,
    receipts: pkg.linkManifest.receipts,
    links: pkg.linkManifest.links,
    pathPrepend: pkg.linkManifest.env.PATH_prepend ?? [],
    sha256: pkg.sha256,
    bytes: pkg.bytes,
    failureLabel: `${packageLabel(pkg)} ${pkg.sourceStatus} ${pkg.linkManifestPath} ${pkg.url}`,
  };
}

function createDefaultFs(): MemoryFileSystem {
  const SharedArrayBufferCtor = SharedArrayBuffer as new (
    byteLength: number,
    options?: { maxByteLength?: number },
  ) => SharedArrayBuffer;
  const sab = new SharedArrayBufferCtor(DEFAULT_IMAGE_BYTES, {
    maxByteLength: DEFAULT_IMAGE_BYTES,
  });
  return MemoryFileSystem.create(sab, DEFAULT_IMAGE_BYTES);
}

function resolveLinkConflicts(
  plan: HomebrewVfsPlan,
  policy: HomebrewVfsCompatibilityPolicy | undefined,
): HomebrewVfsLinkResolution {
  const entriesByPath = new Map<
    string,
    Array<{ pkg: HomebrewVfsPackagePlan; entry: HomebrewLinkEntry }>
  >();
  const packageByFullName = new Map(plan.packages.map((pkg) => [pkg.fullName, pkg]));

  for (const pkg of plan.packages) {
    const seenTargets = new Set<string>();
    for (const entry of pkg.linkManifest.links) {
      if (seenTargets.has(entry.target)) {
        fail(pkg, `link target ${entry.target} is duplicated`);
      }
      seenTargets.add(entry.target);
      const path = joinGuestPath(pkg.prefix, entry.target);
      if (!guestPathIsUnder(path, pkg.prefix)) {
        fail(pkg, `link target ${entry.target} escapes prefix ${pkg.prefix}`);
      }
      const entries = entriesByPath.get(path) ?? [];
      entries.push({ pkg, entry });
      entriesByPath.set(path, entries);
    }
  }

  if (policy !== undefined && !Array.isArray(policy.link_conflict_owners)) {
    throw new HomebrewVfsBuildError(
      "Homebrew compatibility link_conflict_owners policy is invalid",
    );
  }
  const declarations = new Map<
    string,
    { target: string; package: string; reason: string }
  >();
  for (const declaration of policy?.link_conflict_owners ?? []) {
    if (
      typeof declaration?.target !== "string" ||
      typeof declaration.package !== "string" ||
      typeof declaration.reason !== "string" ||
      declaration.reason.trim().length === 0
    ) {
      throw new HomebrewVfsBuildError(
        "Homebrew compatibility link conflict owner is invalid",
      );
    }
    validateSafeRelativePath(
      declaration.target,
      "Homebrew compatibility link conflict target",
    );
    if (declarations.has(declaration.target)) {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility link conflict target ${declaration.target} is declared more than once`,
      );
    }
    declarations.set(declaration.target, declaration);
  }

  const selectedPackageByPath = new Map<string, string>();
  const reports: HomebrewVfsLinkConflictReport[] = [];
  for (const [path, entries] of entriesByPath) {
    const owners = Array.from(new Set(entries.map(({ pkg }) => pkg.fullName)));
    if (owners.length < 2) continue;
    const targets = Array.from(new Set(entries.map(({ entry }) => entry.target)));
    if (targets.length !== 1) {
      throw new HomebrewVfsBuildError(
        `Homebrew link conflict at ${path} has non-canonical target identities`,
      );
    }
    const target = targets[0];
    const declaration = declarations.get(target);
    if (declaration === undefined) {
      throw new HomebrewVfsBuildError(
        `Homebrew link target ${target} is owned by ${owners.join(", ")}; ` +
          "the migration lock must select an owner",
      );
    }
    if (!owners.includes(declaration.package)) {
      throw new HomebrewVfsBuildError(
        `Homebrew migration-lock owner ${declaration.package} does not own conflicting target ${target}`,
      );
    }
    selectedPackageByPath.set(path, declaration.package);
    reports.push({
      path,
      target,
      owners,
      selected_package: declaration.package,
      skipped_packages: owners.filter((owner) => owner !== declaration.package),
      reason: declaration.reason,
      resolution: "migration-lock",
    });
  }

  for (const declaration of declarations.values()) {
    const selectedPackage = packageByFullName.get(declaration.package);
    if (selectedPackage === undefined) {
      // A full migration lock is also used for focused partial selections.
      // Its conflict policy becomes active as soon as its selected owner is
      // present; the complete main-shell plan therefore checks every entry.
      continue;
    }
    const path = joinGuestPath(selectedPackage.prefix, declaration.target);
    if (selectedPackageByPath.get(path) !== declaration.package) {
      throw new HomebrewVfsBuildError(
        `Homebrew migration-lock owner declaration for ${declaration.target} ` +
          "is stale or unnecessary",
      );
    }
  }

  return { selectedPackageByPath, reports };
}

function applyCompatibilityLinks(
  fs: MemoryFileSystem,
  plan: HomebrewVfsPlan,
  policy: HomebrewVfsCompatibilityPolicy,
  resolution: HomebrewVfsLinkResolution,
): HomebrewVfsCompatibilityLinkReport[] {
  if (
    !policy ||
    !policy.mirror_link_manifest_bin ||
    !Array.isArray(policy.mirror_link_manifest_bin.targets) ||
    !Array.isArray(policy.link_conflict_owners) ||
    !Array.isArray(policy.aliases)
  ) {
    throw new HomebrewVfsBuildError("Homebrew compatibility policy is invalid");
  }

  const packageByFullName = new Map(plan.packages.map((pkg) => [pkg.fullName, pkg]));
  const ownedBinLinks = new Map<
    string,
    {
      pkg: HomebrewVfsPackagePlan;
      source: string;
      sourcePath: string;
      ownership: "bottle-link-manifest";
    }
  >();
  for (const pkg of plan.packages) {
    for (const entry of pkg.linkManifest.links) {
      if (!/^bin\/[^/]+$/.test(entry.target)) continue;
      const path = joinGuestPath(pkg.prefix, entry.target);
      const selectedPackage = resolution.selectedPackageByPath.get(path);
      if (selectedPackage !== undefined && selectedPackage !== pkg.fullName) continue;
      const key = `${pkg.fullName}\0${entry.target}`;
      ownedBinLinks.set(key, {
        pkg,
        source: entry.target,
        sourcePath: joinGuestPath(pkg.prefix, entry.target),
        ownership: "bottle-link-manifest",
      });
    }
  }

  const reports: HomebrewVfsCompatibilityLinkReport[] = [];
  const targetedPaths = new Set<string>();
  const mirrorTargets = new Set(policy.mirror_link_manifest_bin.targets);
  if (mirrorTargets.size !== policy.mirror_link_manifest_bin.targets.length) {
    throw new HomebrewVfsBuildError("Homebrew compatibility mirror targets are duplicated");
  }
  for (const targetDirectory of mirrorTargets) {
    validateCompatibilityAbsolutePath(targetDirectory, "mirror target directory");
    if (
      guestPathIsUnder(
        targetDirectory,
        plan.packages[0]?.prefix ?? KANDELO_HOMEBREW_GUEST_LAYOUT.prefix,
      )
    ) {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility mirror target ${targetDirectory} must be outside the Homebrew prefix`,
      );
    }
    for (const owned of ownedBinLinks.values()) {
      const basename = owned.source.slice("bin/".length);
      createCompatibilityLink(
        fs,
        owned,
        `${targetDirectory.replace(/\/+$/g, "")}/${basename}`,
        targetedPaths,
        reports,
      );
    }
  }

  for (const alias of policy.aliases) {
    if (
      typeof alias?.package !== "string" ||
      (alias.source_kind !== "link" && alias.source_kind !== "keg") ||
      typeof alias.source !== "string" ||
      !Array.isArray(alias.targets) ||
      alias.targets.some((target) => typeof target !== "string")
    ) {
      throw new HomebrewVfsBuildError("Homebrew compatibility alias is invalid");
    }
    validateSafeRelativePath(alias.source, "Homebrew compatibility alias source");
    const pkg = packageByFullName.get(alias.package);
    if (pkg === undefined) {
      continue;
    }
    const manifestOwned = ownedBinLinks.get(`${pkg.fullName}\0${alias.source}`);
    if (alias.source_kind === "link" && manifestOwned === undefined) {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility alias ${alias.package}:${alias.source} ` +
          "is not owned by that bottle's link manifest",
      );
    }
    if (alias.source_kind === "keg" && manifestOwned !== undefined) {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility alias ${alias.package}:${alias.source} is a linked source; ` +
          'declare source_kind "link"',
      );
    }
    const owned = manifestOwned ?? {
      pkg,
      source: alias.source,
      sourcePath: homebrewManifestSourcePath(pkg, alias.source),
      ownership: "bottle-keg" as const,
    };
    if (new Set(alias.targets).size !== alias.targets.length) {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility alias ${alias.package}:${alias.source} has duplicate targets`,
      );
    }
    for (const target of alias.targets) {
      validateCompatibilityAbsolutePath(target, "alias target");
      createCompatibilityLink(fs, owned, target, targetedPaths, reports);
    }
  }

  return reports;
}

function createCompatibilityLink(
  fs: MemoryFileSystem,
  owned: {
    pkg: HomebrewVfsPackagePlan;
    source: string;
    sourcePath: string;
    ownership: "bottle-link-manifest" | "bottle-keg";
  },
  targetPath: string,
  targetedPaths: Set<string>,
  reports: HomebrewVfsCompatibilityLinkReport[],
): void {
  if (targetedPaths.has(targetPath)) {
    throw new HomebrewVfsBuildError(
      `Homebrew compatibility target ${targetPath} is assigned more than once`,
    );
  }
  targetedPaths.add(targetPath);
  const sourceStat = tryStat(fs, owned.sourcePath);
  if (sourceStat === null || kind(sourceStat) !== S_IFREG || (sourceStat.mode & 0o111) === 0) {
    fail(
      owned.pkg,
      `compatibility source ${owned.source} is not an executable regular bottle file`,
    );
  }
  if (tryLstat(fs, targetPath) !== null) {
    throw new HomebrewVfsBuildError(
      `Homebrew compatibility target ${targetPath} already exists in the platform base or another package`,
    );
  }
  ensureParentDir(fs, targetPath);
  fs.symlink(owned.sourcePath, targetPath);
  reports.push({
    path: targetPath,
    target: owned.sourcePath,
    package: owned.pkg.fullName,
    source: owned.source,
    ownership: owned.ownership,
  });
}

function validateCompatibilityAbsolutePath(path: string, label: string): void {
  if (
    !path.startsWith("/") ||
    path === "/" ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").slice(1).some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new HomebrewVfsBuildError(
      `Homebrew compatibility ${label} ${JSON.stringify(path)} is not a normalized absolute path`,
    );
  }
}

function prepareRuntimeState(
  plan: HomebrewVfsPlan,
  declarations: HomebrewVfsRuntimeStateDeclaration[] | undefined,
): HomebrewVfsRuntimeStateDeclaration[] {
  if (declarations === undefined) return [];
  if (!Array.isArray(declarations)) {
    throw new HomebrewVfsBuildError("Homebrew compatibility runtime_state policy is invalid");
  }

  const selectedPackages = new Set(plan.packages.map((pkg) => pkg.fullName));
  const prefixes = new Set(plan.packages.map((pkg) => pkg.prefix));
  const byPath = new Map<string, HomebrewVfsRuntimeStateDeclaration>();
  for (const [index, declaration] of declarations.entries()) {
    if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility runtime_state[${index}] is invalid`,
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
    if (declaration.kind === "text_file") expectedKeys.push("contents");
    const actualKeys = Object.keys(declaration).sort();
    expectedKeys.sort();
    if (actualKeys.join("\0") !== expectedKeys.join("\0")) {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility runtime_state[${index}] has an unsupported shape`,
      );
    }
    if (
      typeof declaration.requires_package !== "string" ||
      !selectedPackages.has(declaration.requires_package)
    ) {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility runtime_state[${index}] requires_package is not in the selected plan`,
      );
    }
    if (
      declaration.kind !== "directory" &&
      declaration.kind !== "empty_file" &&
      declaration.kind !== "text_file"
    ) {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility runtime_state[${index}] kind is invalid`,
      );
    }
    if (typeof declaration.path !== "string") {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility runtime_state[${index}] path is invalid`,
      );
    }
    validateCompatibilityAbsolutePath(
      declaration.path,
      `runtime state path at index ${index}`,
    );
    if (
      declaration.path === "/etc/kandelo" ||
      guestPathIsUnder(declaration.path, "/etc/kandelo")
    ) {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility runtime state path ${declaration.path} is reserved for image metadata`,
      );
    }
    for (const prefix of prefixes) {
      if (declaration.path === prefix || guestPathIsUnder(declaration.path, prefix)) {
        throw new HomebrewVfsBuildError(
          `Homebrew compatibility runtime state path ${declaration.path} must be outside bottle prefixes`,
        );
      }
    }
    if (
      !Number.isSafeInteger(declaration.mode) ||
      declaration.mode < 0 ||
      declaration.mode > MODE_BITS
    ) {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility runtime_state[${index}] mode is invalid`,
      );
    }
    for (const field of ["uid", "gid"] as const) {
      const value = declaration[field];
      if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RUNTIME_STATE_ID) {
        throw new HomebrewVfsBuildError(
          `Homebrew compatibility runtime_state[${index}] ${field} is invalid`,
        );
      }
    }
    if (
      typeof declaration.reason !== "string" ||
      declaration.reason.trim().length === 0 ||
      declaration.reason.length > 1024
    ) {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility runtime_state[${index}] reason is invalid`,
      );
    }
    if (declaration.kind === "text_file") {
      if (
        typeof declaration.contents !== "string" ||
        TEXT_ENCODER.encode(declaration.contents).byteLength > MAX_RUNTIME_STATE_TEXT_BYTES
      ) {
        throw new HomebrewVfsBuildError(
          `Homebrew compatibility runtime_state[${index}] contents are invalid`,
        );
      }
    }
    if (byPath.has(declaration.path)) {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility runtime state path ${declaration.path} is declared more than once`,
      );
    }
    byPath.set(declaration.path, declaration);
  }

  for (const declaration of declarations) {
    let ancestor = dirnameGuestPath(declaration.path);
    while (ancestor !== "/") {
      const parent = byPath.get(ancestor);
      if (parent !== undefined && parent.kind !== "directory") {
        throw new HomebrewVfsBuildError(
          `Homebrew compatibility runtime state ${parent.path} cannot contain ${declaration.path}`,
        );
      }
      ancestor = dirnameGuestPath(ancestor);
    }
  }

  return declarations.map((declaration) => ({ ...declaration }));
}

function applyRuntimeState(
  fs: MemoryFileSystem,
  declarations: readonly HomebrewVfsRuntimeStateDeclaration[],
): HomebrewVfsRuntimeStateReport[] {
  const reports = new Map<string, HomebrewVfsRuntimeStateReport>();
  const ordered = [...declarations].sort((left, right) =>
    pathDepth(left.path) - pathDepth(right.path)
  );
  for (const declaration of ordered) {
    if (tryLstat(fs, declaration.path) !== null) {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility runtime state path ${declaration.path} already exists in the platform base or a bottle`,
      );
    }
    const parent = dirnameGuestPath(declaration.path);
    const parentStat = tryLstat(fs, parent);
    if (parentStat === null || kind(parentStat) !== S_IFDIR) {
      throw new HomebrewVfsBuildError(
        `Homebrew compatibility runtime state parent ${parent} is not an existing directory`,
      );
    }

    const report: HomebrewVfsRuntimeStateReport = {
      requires_package: declaration.requires_package,
      path: declaration.path,
      kind: declaration.kind,
      mode: declaration.mode,
      uid: declaration.uid,
      gid: declaration.gid,
      reason: declaration.reason,
    };
    if (declaration.kind === "directory") {
      fs.mkdirWithOwner(
        declaration.path,
        declaration.mode,
        declaration.uid,
        declaration.gid,
      );
    } else {
      const content = declaration.kind === "text_file"
        ? TEXT_ENCODER.encode(declaration.contents!)
        : new Uint8Array();
      fs.createFileWithOwner(
        declaration.path,
        declaration.mode,
        declaration.uid,
        declaration.gid,
        content,
      );
      report.content_sha256 = sha256(content);
      report.content_bytes = content.byteLength;
    }
    reports.set(declaration.path, report);
  }
  return declarations.map((declaration) => reports.get(declaration.path)!);
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

export function homebrewCanonicalOptLink(
  pkg: HomebrewVfsPackagePlan,
): HomebrewVfsOptLinkReport {
  return materializedCanonicalOptLink(legacyMaterializationPackage(pkg));
}

function writeProfileFragment(fs: MemoryFileSystem, plan: HomebrewVfsPlan): void {
  const prefixes = new Set<string>();
  for (const pkg of plan.packages) {
    for (const rel of pkg.linkManifest.env.PATH_prepend ?? []) {
      prefixes.add(joinGuestPath(pkg.prefix, rel));
    }
  }
  if (prefixes.size === 0) return;
  ensureDirRecursive(fs, "/etc/profile.d");
  writeVfsFile(
    fs,
    "/etc/profile.d/kandelo-homebrew.sh",
    `export PATH="${Array.from(prefixes).join(":")}:$PATH"\n`,
    0o644,
  );
}

export function mapHomebrewBottleEntryToGuestPath(
  pkg: HomebrewVfsPackagePlan,
  entryPath: string,
): string | null {
  return mapMaterializedBottleEntry(legacyMaterializationPackage(pkg), entryPath);
}

export function homebrewManifestSourcePath(
  pkg: HomebrewVfsPackagePlan,
  source: string,
): string {
  return materializedManifestSourcePath(legacyMaterializationPackage(pkg), source);
}

function validateSafeRelativePath(path: string, label: string): void {
  if (path.length === 0 || path.startsWith("/")) {
    throw new HomebrewVfsBuildError(
      `${label} ${JSON.stringify(path)} must be a relative path`,
    );
  }
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new HomebrewVfsBuildError(
        `${label} ${JSON.stringify(path)} contains an unsafe path segment`,
      );
    }
  }
}

function joinGuestPath(base: string, rel: string): string {
  validateSafeRelativePath(rel, "guest path");
  return `${base.replace(/\/+$/g, "")}/${rel}`;
}

function dirnameGuestPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function ensureParentDir(fs: MemoryFileSystem, path: string): void {
  ensureDirRecursive(fs, dirnameGuestPath(path));
}

function guestPathIsUnder(child: string, parent: string): boolean {
  const normalizedParent = parent.endsWith("/") ? parent : `${parent}/`;
  return child === parent || child.startsWith(normalizedParent);
}

function tryLstat(fs: MemoryFileSystem, path: string): StatResult | null {
  try {
    return fs.lstat(path);
  } catch {
    return null;
  }
}

function tryStat(fs: MemoryFileSystem, path: string): StatResult | null {
  try {
    return fs.stat(path);
  } catch {
    return null;
  }
}

function kind(st: StatResult): number {
  return st.mode & S_IFMT;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function packageLabel(pkg: HomebrewVfsPackagePlan): string {
  return `package ${pkg.name}@${pkg.version} ${pkg.arch}`;
}

function runMaterializer<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof HomebrewVfsMaterializationError) {
      throw new HomebrewVfsBuildError(error.message);
    }
    throw error;
  }
}

function runRuntimeSupport<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof HomebrewRuntimeSupportMaterializationError) {
      throw new HomebrewVfsBuildError(error.message);
    }
    throw error;
  }
}

async function runRuntimeSupportAsync<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HomebrewRuntimeSupportMaterializationError) {
      throw new HomebrewVfsBuildError(error.message);
    }
    throw error;
  }
}

function fail(pkg: HomebrewVfsPackagePlan, message: string): never {
  throw new HomebrewVfsBuildError(
    `${packageLabel(pkg)} ${pkg.sourceStatus} ${pkg.linkManifestPath} ${pkg.url}: ${message}`,
  );
}
