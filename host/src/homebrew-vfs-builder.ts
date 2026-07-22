import { createHash } from "node:crypto";
import type { StatResult } from "./types";
import type {
  HomebrewLinkEntry,
  HomebrewVfsPackagePlan,
  HomebrewVfsPlan,
} from "./homebrew-vfs-planner";
import { MemoryFileSystem } from "./vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "./vfs/image-helpers";
import { parseTarGzip, type TarEntry } from "./vfs/tar";

const DEFAULT_IMAGE_BYTES = 128 * 1024 * 1024;
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;
const O_RDONLY = 0;
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

interface StagePackageResult {
  files: number;
  directories: number;
  symlinks: number;
}

interface PendingHardlink {
  archivePath: string;
  path: string;
  targetArchivePath: string;
  targetPath: string;
}

interface HomebrewVfsLinkResolution {
  selectedPackageByPath: Map<string, string>;
  reports: HomebrewVfsLinkConflictReport[];
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
  const runtimeStateDeclarations = prepareRuntimeState(
    plan,
    options.compatibilityPolicy?.runtime_state,
  );

  ensureDirRecursive(fs, "/etc/kandelo");

  for (const pkg of plan.packages) {
    const bottleBytes = await options.loadBottleBytes(pkg);
    verifyBottleBytes(pkg, bottleBytes);
    const tarEntries = parseBottleTarGz(pkg, bottleBytes);
    const staged = stagePackage(fs, pkg, tarEntries);
    validateReceipts(fs, pkg);
    const links = applyLinks(fs, pkg, linkResolution);

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
      staged_files: staged.files,
      staged_directories: staged.directories,
      staged_symlinks: staged.symlinks,
      receipts: [...pkg.linkManifest.receipts],
      links,
      opt_link: homebrewCanonicalOptLink(pkg),
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

  applyCanonicalOptLinks(fs, plan.packages);
  const { compatibilityLinks, runtimeState } = consumerState === "apply"
    ? applyHomebrewVfsConsumerStateWithResolution(
      fs,
      plan,
      options,
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

  writeVfsFile(
    fs,
    "/etc/kandelo/homebrew-vfs.json",
    JSON.stringify({
      schema: 1,
      created_by: options.createdBy ?? "host/src/homebrew-vfs-builder.ts",
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
      metadata: report.metadata,
      packages: packageReports.map((pkg) => ({
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
        env: plan.packages.find((planned) => planned.fullName === pkg.full_name)?.linkManifest.env ?? {},
      })),
    }, null, 2) + "\n",
    0o644,
  );

  return { fs, report };
}

function applyHomebrewVfsConsumerStateWithResolution(
  fs: MemoryFileSystem,
  plan: HomebrewVfsPlan,
  options: HomebrewVfsBuildOptions,
  linkResolution: HomebrewVfsLinkResolution,
  runtimeStateDeclarations: readonly HomebrewVfsRuntimeStateDeclaration[],
): {
  compatibilityLinks: HomebrewVfsCompatibilityLinkReport[] | undefined;
  runtimeState: HomebrewVfsRuntimeStateReport[];
} {
  const compatibilityLinks = options.compatibilityPolicy === undefined
    ? undefined
    : applyCompatibilityLinks(fs, plan, options.compatibilityPolicy, linkResolution);
  if (options.writeProfile) writeProfileFragment(fs, plan);
  return {
    compatibilityLinks,
    runtimeState: applyRuntimeState(fs, runtimeStateDeclarations),
  };
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

function verifyBottleBytes(pkg: HomebrewVfsPackagePlan, bytes: Uint8Array): void {
  if (bytes.byteLength !== pkg.bytes) {
    fail(pkg, `bottle byte count ${bytes.byteLength} does not match metadata bytes ${pkg.bytes}`);
  }
  const actualSha = sha256(bytes);
  if (actualSha !== pkg.sha256) {
    fail(pkg, `bottle sha256 ${actualSha} does not match metadata sha256 ${pkg.sha256}`);
  }
}

function parseBottleTarGz(pkg: HomebrewVfsPackagePlan, bytes: Uint8Array): TarEntry[] {
  try {
    return parseTarGzip(bytes, { label: packageLabel(pkg) });
  } catch (err) {
    fail(pkg, err instanceof Error ? err.message : String(err));
  }
}

function stagePackage(
  fs: MemoryFileSystem,
  pkg: HomebrewVfsPackagePlan,
  entries: TarEntry[],
): StagePackageResult {
  ensureDirRecursive(fs, pkg.prefix);
  ensureDirRecursive(fs, pkg.cellar);
  ensureDirRecursive(fs, pkg.keg);

  const stagedPaths = new Set<string>();
  const pendingHardlinks: PendingHardlink[] = [];
  let files = 0;
  let directories = 0;
  let symlinks = 0;

  for (const entry of entries) {
    const targetPath = mapHomebrewBottleEntryToGuestPath(pkg, entry.path);
    if (targetPath === null) continue;

    if (entry.type === "directory") {
      const existing = tryLstat(fs, targetPath);
      if (existing && kind(existing) !== S_IFDIR) {
        fail(pkg, `bottle directory ${entry.path} conflicts with existing ${targetPath}`);
      }
      ensureDirRecursive(fs, targetPath);
      fs.chmod(targetPath, entry.mode);
      if (!stagedPaths.has(targetPath)) {
        stagedPaths.add(targetPath);
        directories += 1;
      }
      continue;
    }

    if (tryLstat(fs, targetPath) !== null || stagedPaths.has(targetPath)) {
      fail(pkg, `bottle entry ${entry.path} maps to duplicate staged path ${targetPath}`);
    }

    ensureParentDir(fs, targetPath);
    stagedPaths.add(targetPath);

    if (entry.type === "file") {
      writeVfsBinary(fs, targetPath, entry.data, entry.mode);
      files += 1;
    } else if (entry.type === "symlink") {
      const linkName = entry.linkName ?? "";
      validateArchiveSymlink(pkg, targetPath, linkName);
      fs.symlink(linkName, targetPath);
      symlinks += 1;
    } else {
      const targetArchivePath = entry.linkName ?? "";
      const hardlinkTarget = mapHomebrewBottleEntryToGuestPath(pkg, targetArchivePath);
      if (
        !guestPathIsUnder(targetPath, pkg.keg) ||
        hardlinkTarget === null ||
        !guestPathIsUnder(hardlinkTarget, pkg.keg)
      ) {
        fail(
          pkg,
          `bottle hardlink ${entry.path} -> ${targetArchivePath} ` +
            `is not contained in keg ${pkg.keg}`,
        );
      }
      pendingHardlinks.push({
        archivePath: entry.path,
        path: targetPath,
        targetArchivePath,
        targetPath: hardlinkTarget,
      });
    }
  }

  files += stageHardlinks(fs, pkg, pendingHardlinks, stagedPaths);

  return { files, directories, symlinks };
}

function stageHardlinks(
  fs: MemoryFileSystem,
  pkg: HomebrewVfsPackagePlan,
  hardlinks: PendingHardlink[],
  stagedPaths: Set<string>,
): number {
  for (const hardlink of hardlinks) {
    if (!stagedPaths.has(hardlink.targetPath)) {
      fail(
        pkg,
        `bottle hardlink ${hardlink.archivePath} target ` +
          `${hardlink.targetArchivePath} is not staged by this bottle`,
      );
    }
  }

  let pending = hardlinks;
  let linked = 0;

  while (pending.length > 0) {
    const unresolved: PendingHardlink[] = [];
    let progressed = false;

    for (const hardlink of pending) {
      const target = tryLstat(fs, hardlink.targetPath);
      if (target === null) {
        unresolved.push(hardlink);
        continue;
      }
      if (kind(target) !== S_IFREG) {
        fail(
          pkg,
          `bottle hardlink ${hardlink.archivePath} target ` +
            `${hardlink.targetArchivePath} is not a regular file`,
        );
      }
      fs.link(hardlink.targetPath, hardlink.path);
      linked += 1;
      progressed = true;
    }

    if (!progressed) {
      const details = unresolved
        .map((entry) => `${entry.archivePath} -> ${entry.targetArchivePath}`)
        .join(", ");
      fail(pkg, `bottle hardlink target is missing or cyclic: ${details}`);
    }
    pending = unresolved;
  }

  return linked;
}

function validateReceipts(fs: MemoryFileSystem, pkg: HomebrewVfsPackagePlan): void {
  for (const receipt of pkg.linkManifest.receipts) {
    const path = homebrewManifestSourcePath(pkg, receipt);
    if (tryLstat(fs, path) === null) {
      fail(pkg, `receipt ${receipt} is missing after staging at ${path}`);
    }
  }
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

function applyLinks(
  fs: MemoryFileSystem,
  pkg: HomebrewVfsPackagePlan,
  resolution: HomebrewVfsLinkResolution,
): string[] {
  const applied: string[] = [];
  const seenTargets = new Set<string>();

  for (const entry of pkg.linkManifest.links) {
    if (seenTargets.has(entry.target)) {
      fail(pkg, `link target ${entry.target} is duplicated`);
    }
    seenTargets.add(entry.target);

    const sourcePath = homebrewManifestSourcePath(pkg, entry.source);
    const targetPath = joinGuestPath(pkg.prefix, entry.target);
    if (!guestPathIsUnder(targetPath, pkg.prefix)) {
      fail(pkg, `link target ${entry.target} escapes prefix ${pkg.prefix}`);
    }
    const sourceStat = tryStat(fs, sourcePath);
    if (sourceStat === null) {
      fail(pkg, `link source ${entry.source} is missing at ${sourcePath}`);
    }
    validateLinkEntrySource(pkg, entry, sourceStat);
    const selectedPackage = resolution.selectedPackageByPath.get(targetPath);
    if (selectedPackage !== undefined && selectedPackage !== pkg.fullName) {
      continue;
    }
    if (tryLstat(fs, targetPath) !== null) {
      fail(pkg, `link target ${entry.target} already exists at ${targetPath}`);
    }

    ensureParentDir(fs, targetPath);
    applyLinkEntry(fs, entry, sourcePath, sourceStat, targetPath);
    applied.push(entry.target);
  }

  return applied;
}

function applyCanonicalOptLinks(
  fs: MemoryFileSystem,
  packages: readonly HomebrewVfsPackagePlan[],
): void {
  for (const pkg of packages) {
    const link = homebrewCanonicalOptLink(pkg);
    const optDirectory = joinGuestPath(pkg.prefix, "opt");
    const optDirectoryStat = tryLstat(fs, optDirectory);
    if (optDirectoryStat === null) {
      ensureDirRecursive(fs, optDirectory);
    } else if (kind(optDirectoryStat) !== S_IFDIR) {
      fail(pkg, `canonical opt directory is not a real directory at ${optDirectory}`);
    }
    const targetPath = joinGuestPath(pkg.prefix, link.path);
    if (tryLstat(fs, targetPath) !== null) {
      fail(pkg, `canonical opt link ${link.path} already exists at ${targetPath}`);
    }
    fs.symlink(link.target, targetPath);
  }
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
    if (guestPathIsUnder(targetDirectory, plan.packages[0]?.prefix ?? "/home/linuxbrew/.linuxbrew")) {
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
  const path = `opt/${pkg.name}`;
  const targetPath = joinGuestPath(pkg.prefix, path);
  const target = relativeGuestPath(dirnameGuestPath(targetPath), pkg.keg);
  if (target.length === 0) {
    fail(pkg, `canonical opt link ${path} cannot target its own parent directory`);
  }
  return {
    path,
    target,
  };
}

function applyLinkEntry(
  fs: MemoryFileSystem,
  entry: HomebrewLinkEntry,
  sourcePath: string,
  sourceStat: StatResult,
  targetPath: string,
): void {
  switch (entry.type) {
    case "symlink":
      fs.symlink(sourcePath, targetPath);
      return;
    case "file": {
      writeVfsBinary(fs, targetPath, readVfsFile(fs, sourcePath), parseManifestMode(entry, sourceStat));
      return;
    }
    case "directory": {
      ensureDirRecursive(fs, targetPath);
      fs.chmod(targetPath, parseManifestMode(entry, sourceStat));
      return;
    }
  }
}

function validateLinkEntrySource(
  pkg: HomebrewVfsPackagePlan,
  entry: HomebrewLinkEntry,
  sourceStat: StatResult,
): void {
  if (entry.type === "file" && kind(sourceStat) !== S_IFREG) {
    fail(pkg, `file link source ${entry.source} is not a regular file`);
  }
  if (entry.type === "directory" && kind(sourceStat) !== S_IFDIR) {
    fail(pkg, `directory link source ${entry.source} is not a directory`);
  }
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
  const payloadRoot = trimSlashes(pkg.payloadRoot);
  if (entryPath === payloadRoot) return null;
  if (entryPath.startsWith(`${payloadRoot}/`)) {
    const rel = entryPath.slice(payloadRoot.length + 1);
    return rel.length === 0 ? null : joinGuestPath(pkg.keg, rel);
  }
  if (entryPath === "Cellar" || entryPath.startsWith("Cellar/")) {
    return joinGuestPath(pkg.prefix, entryPath);
  }
  return joinGuestPath(pkg.keg, entryPath);
}

export function homebrewManifestSourcePath(
  pkg: HomebrewVfsPackagePlan,
  source: string,
): string {
  if (source === "Cellar" || source.startsWith("Cellar/")) {
    return joinGuestPath(pkg.prefix, source);
  }
  return joinGuestPath(pkg.keg, source);
}

function validateArchiveSymlink(
  pkg: HomebrewVfsPackagePlan,
  linkPath: string,
  linkTarget: string,
): void {
  if (linkTarget.length === 0) fail(pkg, `archive symlink ${linkPath} has an empty target`);
  if (linkTarget.startsWith("/") || hasScheme(linkTarget)) {
    fail(pkg, `archive symlink ${linkPath} has non-relative target ${linkTarget}`);
  }
  const normalized = normalizeRelativeFrom(dirnameGuestPath(linkPath), linkTarget);
  if (!guestPathIsUnder(normalized, pkg.keg)) {
    fail(pkg, `archive symlink ${linkPath} target ${linkTarget} escapes keg ${pkg.keg}`);
  }
}

function parseManifestMode(entry: HomebrewLinkEntry, sourceStat: StatResult): number {
  if (entry.mode === undefined) return sourceStat.mode & MODE_BITS;
  const parsed = Number.parseInt(entry.mode, 8);
  if (!Number.isFinite(parsed)) return sourceStat.mode & MODE_BITS;
  return parsed & MODE_BITS;
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const st = fs.stat(path);
  const fd = fs.open(path, O_RDONLY, 0);
  try {
    const out = new Uint8Array(st.size);
    fs.read(fd, out, null, out.length);
    return out;
  } finally {
    fs.close(fd);
  }
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

function normalizeRelativeFrom(base: string, rel: string): string {
  const baseParts = base.split("/").filter(Boolean);
  for (const segment of rel.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      baseParts.pop();
    } else {
      baseParts.push(segment);
    }
  }
  return `/${baseParts.join("/")}`;
}

function joinGuestPath(base: string, rel: string): string {
  validateSafeRelativePath(rel, "guest path");
  return `${base.replace(/\/+$/g, "")}/${rel}`;
}

function dirnameGuestPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function relativeGuestPath(fromDirectory: string, targetPath: string): string {
  const fromParts = fromDirectory.split("/").filter(Boolean);
  const targetParts = targetPath.split("/").filter(Boolean);
  let shared = 0;
  while (
    shared < fromParts.length &&
    shared < targetParts.length &&
    fromParts[shared] === targetParts[shared]
  ) {
    shared += 1;
  }
  return [
    ...fromParts.slice(shared).map(() => ".."),
    ...targetParts.slice(shared),
  ].join("/");
}

function ensureParentDir(fs: MemoryFileSystem, path: string): void {
  ensureDirRecursive(fs, dirnameGuestPath(path));
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+/g, "").replace(/\/+$/g, "");
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

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function packageLabel(pkg: HomebrewVfsPackagePlan): string {
  return `package ${pkg.name}@${pkg.version} ${pkg.arch}`;
}

function fail(pkg: HomebrewVfsPackagePlan, message: string): never {
  throw new HomebrewVfsBuildError(
    `${packageLabel(pkg)} ${pkg.sourceStatus} ${pkg.linkManifestPath} ${pkg.url}: ${message}`,
  );
}
