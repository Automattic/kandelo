import { createHash } from "node:crypto";

import {
  parseHomebrewInstallReceiptDirectDependencies,
  parseHomebrewInstallReceiptRelocation,
  relocateHomebrewBottleFile,
  type HomebrewInstallReceiptDirectDependency,
  type HomebrewInstallReceiptRelocation,
} from "./homebrew-bottle-relocation";
import type {
  HomebrewBottleDependencyIdentity,
  HomebrewBottleDescriptor,
} from "./homebrew-bottle-descriptor";
import type { HomebrewBottleArch, HomebrewLinkEntry } from "./homebrew-bottle-types";
import type { StatResult } from "./types";
import { ensureDirRecursive, writeVfsBinary } from "./vfs/image-helpers";
import { MemoryFileSystem } from "./vfs/memory-fs";
import { parseTarGzip, type TarEntry, type TarGzipLimits } from "./vfs/tar";

const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const MODE_BITS = 0o7777;
const O_RDONLY = 0;
const TEXT_ENCODER = new TextEncoder();

export interface HomebrewBottleMaterializationPackage {
  name: string;
  fullName: string;
  version: string;
  arch: HomebrewBottleArch;
  prefix: string;
  cellar: string;
  keg: string;
  payloadRoot: string;
  receipts: readonly string[];
  links: readonly HomebrewLinkEntry[];
  pathPrepend: readonly string[];
  sha256: string;
  bytes: number;
  failureLabel: string;
}

export interface HomebrewBottleResourceMeasurement {
  compressedBytes: number;
  expandedBytes: number;
  entries: number;
  pathBytes: number;
  linkBytes: number;
}

export type HomebrewReceiptRuntimeDependency = HomebrewInstallReceiptDirectDependency;

export interface PreparedHomebrewKeg {
  input: HomebrewBottleMaterializationPackage;
  entries: readonly TarEntry[];
  receiptRelocation: HomebrewInstallReceiptRelocation | null;
  runtimeDependencies: readonly HomebrewReceiptRuntimeDependency[];
  measurement: HomebrewBottleResourceMeasurement;
}

export interface HomebrewBottleStageReport {
  stagedFiles: number;
  stagedDirectories: number;
  stagedSymlinks: number;
}

export interface HomebrewBottleMaterializationOptions {
  tarLimits?: Partial<TarGzipLimits>;
  expectedDependencies?: readonly HomebrewBottleDependencyIdentity[];
  requireExactKegContainment?: boolean;
  receiptSource?: "archive" | "staged";
  shouldApplyLink?: (
    entry: HomebrewLinkEntry,
    targetPath: string,
  ) => boolean;
}

export interface HomebrewCanonicalOptLink {
  path: string;
  target: string;
}

export interface HomebrewPreparedLinkSelection {
  prepared: PreparedHomebrewKeg;
  entry: HomebrewLinkEntry;
  targetPath: string;
}

export class HomebrewVfsMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomebrewVfsMaterializationError";
  }
}

/** Adapt the provenance-free descriptor into the shared filesystem contract. */
export function descriptorMaterializationPackage(
  descriptor: HomebrewBottleDescriptor,
): HomebrewBottleMaterializationPackage {
  return {
    name: descriptor.name,
    fullName: descriptor.fullName,
    version: descriptor.version,
    arch: descriptor.arch,
    prefix: descriptor.prefix,
    cellar: descriptor.cellar,
    keg: descriptor.keg,
    payloadRoot: descriptor.payloadRoot,
    receipts: descriptor.receipts,
    links: descriptor.links,
    pathPrepend: descriptor.pathPrepend,
    sha256: descriptor.sha256,
    bytes: descriptor.bytes,
    failureLabel: `package ${descriptor.name}@${descriptor.version} ${descriptor.arch} ` +
      `${descriptor.url}`,
  };
}

/** Verify and decode one bottle without mutating a filesystem. */
export function prepareHomebrewKeg(
  pkg: HomebrewBottleMaterializationPackage,
  bytes: Uint8Array,
  options: HomebrewBottleMaterializationOptions = {},
): PreparedHomebrewKeg {
  verifyBottleBytes(pkg, bytes);
  const entries = parseBottleTarGz(pkg, bytes, options.tarLimits);
  const measurement = measureBottle(bytes, entries);
  let receipt: {
    relocation: HomebrewInstallReceiptRelocation | null;
    runtimeDependencies: HomebrewReceiptRuntimeDependency[];
  };
  if (options.receiptSource === "staged") {
    if (options.requireExactKegContainment === true) {
      indexPreparedEntries(pkg, entries, true);
    }
    receipt = { relocation: null, runtimeDependencies: [] };
  } else {
    const entriesByGuestPath = indexPreparedEntries(
      pkg,
      entries,
      options.requireExactKegContainment ?? false,
    );
    receipt = prepareArchiveReceipt(
      pkg,
      entries,
      entriesByGuestPath,
      options.expectedDependencies,
    );
  }
  return {
    input: pkg,
    entries,
    receiptRelocation: receipt.relocation,
    runtimeDependencies: receipt.runtimeDependencies,
    measurement,
  };
}

/** Reproduce the legacy stage-then-receipt contract against installed paths. */
export function prepareStagedHomebrewKegReceipts(
  fs: MemoryFileSystem,
  prepared: PreparedHomebrewKeg,
): PreparedHomebrewKeg {
  const pkg = prepared.input;
  for (const receipt of pkg.receipts) {
    const path = homebrewManifestSourcePath(pkg, receipt);
    if (tryLstat(fs, path) === null) {
      fail(pkg, `receipt ${receipt} is missing after staging at ${path}`);
    }
  }
  const installReceipts = installReceiptPaths(pkg);
  if (installReceipts.length === 0) return prepared;
  assertSingleInstallReceipt(pkg, installReceipts);
  const receiptPath = homebrewManifestSourcePath(pkg, installReceipts[0]!);
  const receiptStat = fs.lstat(receiptPath);
  if (kind(receiptStat) !== S_IFREG) {
    fail(pkg, `INSTALL_RECEIPT.json is not a regular file at ${receiptPath}`);
  }
  const receipt = prepareReceiptBytes(pkg, readVfsFile(fs, receiptPath));
  return {
    ...prepared,
    receiptRelocation: receipt.relocation,
    runtimeDependencies: receipt.runtimeDependencies,
  };
}

/** Drop the bounded TAR backing buffer as soon as staging no longer needs it. */
export function releasePreparedHomebrewKegEntries(prepared: PreparedHomebrewKeg): void {
  prepared.entries = [];
}

/** Require clean keg roots and real staging/archive parents before the first keg write. */
export function preflightHomebrewStagingDirectories(
  fs: MemoryFileSystem,
  prepared: readonly PreparedHomebrewKeg[],
): void {
  const checked = new Set<string>();
  for (const item of prepared) {
    const pkg = item.input;
    for (const path of [pkg.prefix, pkg.cellar, pkg.keg]) {
      for (const component of absoluteGuestPathComponents(path, pkg)) {
        if (component === pkg.keg) {
          if (tryLstat(fs, component) !== null) {
            fail(pkg, `selected Homebrew keg ${component} must be absent before staging`);
          }
          checked.add(component);
          continue;
        }
        if (checked.has(component)) continue;
        checked.add(component);
        const stat = tryLstat(fs, component);
        if (stat !== null && kind(stat) !== S_IFDIR) {
          fail(
            pkg,
            `existing Homebrew staging path component ${component} is not a real directory`,
          );
        }
      }
    }
    for (const entry of item.entries) {
      const destination = mapHomebrewBottleEntryToGuestPath(pkg, entry.path);
      if (destination === null) continue;
      for (const component of absoluteGuestPathComponents(dirnameGuestPath(destination), pkg)) {
        if (checked.has(component)) continue;
        checked.add(component);
        const stat = tryLstat(fs, component);
        if (stat !== null && kind(stat) !== S_IFDIR) {
          fail(
            pkg,
            `existing Homebrew archive-destination parent ${component} is not a real directory`,
          );
        }
      }
    }
  }
}

/** Stage one already authenticated keg, without relocation or prefix links. */
export function stagePreparedHomebrewKeg(
  fs: MemoryFileSystem,
  prepared: PreparedHomebrewKeg,
): HomebrewBottleStageReport {
  const staged = stagePackage(fs, prepared.input, prepared.entries);
  return {
    stagedFiles: staged.files,
    stagedDirectories: staged.directories,
    stagedSymlinks: staged.symlinks,
  };
}

/** Apply only receipt-owned placeholder relocation to a staged keg. */
export function relocatePreparedHomebrewKeg(
  fs: MemoryFileSystem,
  prepared: PreparedHomebrewKeg,
): void {
  relocateBottlePlaceholders(fs, prepared);
}

/** Validate declared sources and apply only globally selected prefix links. */
export function applyPreparedHomebrewLinks(
  fs: MemoryFileSystem,
  prepared: PreparedHomebrewKeg,
  shouldApply?: HomebrewBottleMaterializationOptions["shouldApplyLink"],
): string[] {
  return applyLinks(fs, prepared.input, shouldApply);
}

/** Validate the complete ordinary/opt link namespace without changing it. */
export function preflightPreparedHomebrewLinksAndOpt(
  fs: MemoryFileSystem,
  prepared: readonly PreparedHomebrewKeg[],
  shouldApply: (selection: HomebrewPreparedLinkSelection) => boolean,
): void {
  const selected: Array<{
    pkg: HomebrewBottleMaterializationPackage;
    entry: HomebrewLinkEntry;
    path: string;
  }> = [];
  const selectedPaths = new Set<string>();
  for (const item of prepared) {
    const pkg = item.input;
    const seenTargets = new Set<string>();
    for (const entry of pkg.links) {
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
      if (!shouldApply({ prepared: item, entry, targetPath })) continue;
      if (selectedPaths.has(targetPath)) {
        fail(pkg, `selected link target ${entry.target} is duplicated`);
      }
      selectedPaths.add(targetPath);
      if (tryLstat(fs, targetPath) !== null) {
        fail(pkg, `link target ${entry.target} already exists at ${targetPath}`);
      }
      assertExistingParentsAreDirectories(fs, pkg, targetPath, `link target ${entry.target}`);
      selected.push({ pkg, entry, path: targetPath });
    }
  }

  assertSelectedTargetHierarchy(selected);
  preflightCanonicalOptLinks(fs, prepared.map((item) => item.input), selected);
}

/** Add one canonical opt link per selected package after all kegs exist. */
export function applyHomebrewCanonicalOptLinks(
  fs: MemoryFileSystem,
  packages: readonly HomebrewBottleMaterializationPackage[],
): void {
  const links = packages.map((pkg) => ({ pkg, link: homebrewCanonicalOptLink(pkg) }));
  const paths = new Set<string>();
  for (const { pkg, link } of links) {
    const targetPath = joinGuestPath(pkg.prefix, link.path);
    if (paths.has(targetPath)) {
      fail(pkg, `canonical opt link ${link.path} is duplicated by selected packages`);
    }
    paths.add(targetPath);
    const optDirectory = joinGuestPath(pkg.prefix, "opt");
    const optDirectoryStat = tryLstat(fs, optDirectory);
    if (optDirectoryStat !== null && kind(optDirectoryStat) !== S_IFDIR) {
      fail(pkg, `canonical opt directory is not a real directory at ${optDirectory}`);
    }
    if (tryLstat(fs, targetPath) !== null) {
      fail(pkg, `canonical opt link ${link.path} already exists at ${targetPath}`);
    }
  }
  for (const { pkg, link } of links) {
    applyHomebrewCanonicalOptLink(fs, pkg, link);
  }
}

function preflightCanonicalOptLinks(
  fs: MemoryFileSystem,
  packages: readonly HomebrewBottleMaterializationPackage[],
  selected: readonly {
    pkg: HomebrewBottleMaterializationPackage;
    entry: HomebrewLinkEntry;
    path: string;
  }[],
): void {
  const optPaths = new Set<string>();
  for (const pkg of packages) {
    const link = homebrewCanonicalOptLink(pkg);
    const targetPath = joinGuestPath(pkg.prefix, link.path);
    if (optPaths.has(targetPath)) {
      fail(pkg, `canonical opt link ${link.path} is duplicated by selected packages`);
    }
    optPaths.add(targetPath);
    const optDirectory = joinGuestPath(pkg.prefix, "opt");
    const optDirectoryStat = tryLstat(fs, optDirectory);
    if (optDirectoryStat !== null && kind(optDirectoryStat) !== S_IFDIR) {
      fail(pkg, `canonical opt directory is not a real directory at ${optDirectory}`);
    }
    if (tryLstat(fs, targetPath) !== null) {
      fail(pkg, `canonical opt link ${link.path} already exists at ${targetPath}`);
    }
    assertExistingParentsAreDirectories(fs, pkg, targetPath, `canonical opt link ${link.path}`);
    for (const ordinary of selected) {
      if (
        ordinary.path === targetPath ||
        guestPathIsUnder(ordinary.path, targetPath) ||
        (guestPathIsUnder(targetPath, ordinary.path) && ordinary.entry.type !== "directory")
      ) {
        fail(
          pkg,
          `canonical opt link ${link.path} conflicts with selected link target ` +
            `${ordinary.entry.target} from ${ordinary.pkg.fullName}`,
        );
      }
    }
  }
}

/** Apply one canonical opt link with the legacy sequential failure semantics. */
export function applyHomebrewCanonicalOptLink(
  fs: MemoryFileSystem,
  pkg: HomebrewBottleMaterializationPackage,
  link = homebrewCanonicalOptLink(pkg),
): void {
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

export function homebrewCanonicalOptLink(
  pkg: Pick<HomebrewBottleMaterializationPackage, "name" | "prefix" | "keg" | "failureLabel">,
): HomebrewCanonicalOptLink {
  const path = `opt/${pkg.name}`;
  const targetPath = joinGuestPath(pkg.prefix, path);
  const target = relativeGuestPath(dirnameGuestPath(targetPath), pkg.keg);
  if (target.length === 0) {
    fail(pkg, `canonical opt link ${path} cannot target its own parent directory`);
  }
  return { path, target };
}

export function mapHomebrewBottleEntryToGuestPath(
  pkg: Pick<HomebrewBottleMaterializationPackage, "payloadRoot" | "prefix" | "cellar" | "keg">,
  entryPath: string,
): string | null {
  const payloadRoot = trimSlashes(pkg.payloadRoot);
  if (entryPath === payloadRoot) return null;
  if (entryPath.startsWith(`${payloadRoot}/`)) {
    const rel = entryPath.slice(payloadRoot.length + 1);
    return rel.length === 0 ? null : joinGuestPath(pkg.keg, rel);
  }
  const cellarRelative = cellarRelativePath(pkg);
  if (entryPath === cellarRelative || entryPath.startsWith(`${cellarRelative}/`)) {
    return joinGuestPath(pkg.prefix, entryPath);
  }
  return joinGuestPath(pkg.keg, entryPath);
}

export function homebrewManifestSourcePath(
  pkg: Pick<HomebrewBottleMaterializationPackage, "prefix" | "cellar" | "keg">,
  source: string,
): string {
  const cellarRelative = cellarRelativePath(pkg);
  if (source === cellarRelative || source.startsWith(`${cellarRelative}/`)) {
    return joinGuestPath(pkg.prefix, source);
  }
  return joinGuestPath(pkg.keg, source);
}

function verifyBottleBytes(
  pkg: HomebrewBottleMaterializationPackage,
  bytes: Uint8Array,
): void {
  if (bytes.byteLength !== pkg.bytes) {
    fail(pkg, `bottle byte count ${bytes.byteLength} does not match metadata bytes ${pkg.bytes}`);
  }
  const actualSha = sha256(bytes);
  if (actualSha !== pkg.sha256) {
    fail(pkg, `bottle sha256 ${actualSha} does not match metadata sha256 ${pkg.sha256}`);
  }
}

function parseBottleTarGz(
  pkg: HomebrewBottleMaterializationPackage,
  bytes: Uint8Array,
  limits: Partial<TarGzipLimits> | undefined,
): TarEntry[] {
  try {
    return parseTarGzip(bytes, {
      label: packageLabel(pkg),
      ...(limits === undefined ? {} : { limits }),
    });
  } catch (error) {
    fail(pkg, errorMessage(error));
  }
}

function measureBottle(
  bytes: Uint8Array,
  entries: readonly TarEntry[],
): HomebrewBottleResourceMeasurement {
  let pathBytes = 0;
  let linkBytes = 0;
  for (const entry of entries) {
    pathBytes = checkedAdd(pathBytes, TEXT_ENCODER.encode(entry.path).byteLength);
    if (entry.type === "symlink" || entry.type === "hardlink") {
      linkBytes = checkedAdd(linkBytes, TEXT_ENCODER.encode(entry.linkName).byteLength);
    }
  }
  return {
    compressedBytes: bytes.byteLength,
    expandedBytes: new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).getUint32(bytes.byteLength - 4, true),
    entries: entries.length,
    pathBytes,
    linkBytes,
  };
}

function stagePackage(
  fs: MemoryFileSystem,
  pkg: HomebrewBottleMaterializationPackage,
  entries: readonly TarEntry[],
): { files: number; directories: number; symlinks: number } {
  ensureDirRecursive(fs, pkg.prefix);
  ensureDirRecursive(fs, pkg.cellar);
  ensureDirRecursive(fs, pkg.keg);

  const stagedPaths = new Set<string>();
  const pendingHardlinks: Array<{
    archivePath: string;
    path: string;
    targetArchivePath: string;
    targetPath: string;
  }> = [];
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
      validateArchiveSymlink(pkg, targetPath, entry.linkName);
      fs.symlink(entry.linkName, targetPath);
      symlinks += 1;
    } else {
      const hardlinkTarget = mapHomebrewBottleEntryToGuestPath(pkg, entry.linkName);
      if (
        !guestPathIsUnder(targetPath, pkg.keg) ||
        hardlinkTarget === null ||
        !guestPathIsUnder(hardlinkTarget, pkg.keg)
      ) {
        fail(
          pkg,
          `bottle hardlink ${entry.path} -> ${entry.linkName} ` +
            `is not contained in keg ${pkg.keg}`,
        );
      }
      pendingHardlinks.push({
        archivePath: entry.path,
        path: targetPath,
        targetArchivePath: entry.linkName,
        targetPath: hardlinkTarget,
      });
    }
  }

  files += stageHardlinks(fs, pkg, pendingHardlinks, stagedPaths);
  return { files, directories, symlinks };
}

function stageHardlinks(
  fs: MemoryFileSystem,
  pkg: HomebrewBottleMaterializationPackage,
  hardlinks: Array<{
    archivePath: string;
    path: string;
    targetArchivePath: string;
    targetPath: string;
  }>,
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
    const unresolved: typeof pending = [];
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

function indexPreparedEntries(
  pkg: HomebrewBottleMaterializationPackage,
  entries: readonly TarEntry[],
  requireExactKegContainment: boolean,
): Map<string, TarEntry> {
  const byGuestPath = new Map<string, TarEntry>();
  for (const entry of entries) {
    const guestPath = mapHomebrewBottleEntryToGuestPath(pkg, entry.path);
    if (guestPath === null) continue;
    if (requireExactKegContainment && !guestPathIsUnder(guestPath, pkg.keg)) {
      fail(
        pkg,
        `bottle entry ${entry.path} is not contained in exact keg ${pkg.keg}`,
      );
    }
    if (byGuestPath.has(guestPath)) {
      fail(pkg, `bottle entries map to duplicate staged path ${guestPath}`);
    }
    byGuestPath.set(guestPath, entry);
  }
  return byGuestPath;
}

function prepareArchiveReceipt(
  pkg: HomebrewBottleMaterializationPackage,
  entries: readonly TarEntry[],
  entriesByGuestPath: ReadonlyMap<string, TarEntry>,
  expectedDependencies: readonly HomebrewBottleDependencyIdentity[] | undefined,
): {
  relocation: HomebrewInstallReceiptRelocation | null;
  runtimeDependencies: HomebrewReceiptRuntimeDependency[];
} {
  for (const receipt of pkg.receipts) {
    const path = homebrewManifestSourcePath(pkg, receipt);
    const entry = entriesByGuestPath.get(path);
    if (entry === undefined || (entry.type !== "file" && entry.type !== "hardlink")) {
      fail(pkg, `receipt ${receipt} is missing or not regular in bottle at ${path}`);
    }
  }
  const installReceipts = installReceiptPaths(pkg);
  if (installReceipts.length === 0) {
    return { relocation: null, runtimeDependencies: [] };
  }
  assertSingleInstallReceipt(pkg, installReceipts);
  const receiptPath = homebrewManifestSourcePath(pkg, installReceipts[0]!);
  const receiptEntry = entriesByGuestPath.get(receiptPath)!;
  const receiptBytes = resolveTarRegularEntry(pkg, receiptEntry, entries).data;
  return prepareReceiptBytes(pkg, receiptBytes, expectedDependencies);
}

function prepareReceiptBytes(
  pkg: HomebrewBottleMaterializationPackage,
  receiptBytes: Uint8Array,
  expectedDependencies?: readonly HomebrewBottleDependencyIdentity[],
): {
  relocation: HomebrewInstallReceiptRelocation;
  runtimeDependencies: HomebrewReceiptRuntimeDependency[];
} {
  let relocation: HomebrewInstallReceiptRelocation;
  try {
    relocation = parseHomebrewInstallReceiptRelocation(receiptBytes);
  } catch (error) {
    fail(pkg, errorMessage(error));
  }
  let dependencies: HomebrewReceiptRuntimeDependency[] = [];
  if (expectedDependencies !== undefined) {
    try {
      dependencies = parseHomebrewInstallReceiptDirectDependencies(receiptBytes);
    } catch (error) {
      fail(pkg, errorMessage(error));
    }
    assertRuntimeDependencies(pkg, dependencies, expectedDependencies);
  }
  return { relocation, runtimeDependencies: dependencies };
}

function installReceiptPaths(pkg: HomebrewBottleMaterializationPackage): string[] {
  return pkg.receipts.filter((receipt) =>
    receipt === "INSTALL_RECEIPT.json" || receipt.endsWith("/INSTALL_RECEIPT.json")
  );
}

function assertSingleInstallReceipt(
  pkg: HomebrewBottleMaterializationPackage,
  installReceipts: readonly string[],
): void {
  if (installReceipts.length !== 1) {
    fail(
      pkg,
      `link manifest declares ${installReceipts.length} INSTALL_RECEIPT.json files, expected one`,
    );
  }
}

function resolveTarRegularEntry(
  pkg: HomebrewBottleMaterializationPackage,
  start: TarEntry,
  entries: readonly TarEntry[],
): Extract<TarEntry, { type: "file" }> {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const seen = new Set<string>();
  let current = start;
  while (current.type === "hardlink") {
    if (seen.has(current.path)) {
      fail(pkg, `bottle hardlink cycle reaches receipt ${current.path}`);
    }
    seen.add(current.path);
    const target = byPath.get(current.linkName);
    if (target === undefined || (target.type !== "file" && target.type !== "hardlink")) {
      fail(pkg, `bottle hardlink receipt ${current.path} has no regular source`);
    }
    current = target;
  }
  if (current.type !== "file") {
    fail(pkg, `bottle receipt ${current.path} is not a regular file`);
  }
  return current;
}

function assertRuntimeDependencies(
  pkg: HomebrewBottleMaterializationPackage,
  actual: readonly HomebrewReceiptRuntimeDependency[],
  expected: readonly HomebrewBottleDependencyIdentity[],
): void {
  const projected = expected.map(({ fullName, version, revision }) => ({
    fullName,
    version,
    revision,
  }));
  if (
    actual.length !== projected.length ||
    actual.some((dependency, index) =>
      dependency.fullName !== projected[index]?.fullName ||
      dependency.version !== projected[index]?.version ||
      dependency.revision !== projected[index]?.revision
    )
  ) {
    fail(pkg, "INSTALL_RECEIPT.json direct runtime dependencies do not match descriptor edges");
  }
}

function relocateBottlePlaceholders(
  fs: MemoryFileSystem,
  prepared: PreparedHomebrewKeg,
): void {
  const pkg = prepared.input;
  const relocation = prepared.receiptRelocation;
  if (relocation === null) return;
  const changedPaths = new Set<string>();
  for (const value of relocation.changedFiles) {
    changedPaths.add(joinGuestPath(pkg.keg, value));
  }
  for (const path of changedPaths) {
    const stat = tryLstat(fs, path);
    if (stat === null || kind(stat) !== S_IFREG) {
      fail(pkg, `Homebrew changed file is missing or not regular: ${path}`);
    }
    let relocated: Uint8Array;
    try {
      relocated = relocateHomebrewBottleFile(readVfsFile(fs, path), relocation, path);
    } catch (error) {
      fail(pkg, errorMessage(error));
    }
    writeVfsBinary(fs, path, relocated, stat.mode & MODE_BITS);
  }
}

function applyLinks(
  fs: MemoryFileSystem,
  pkg: HomebrewBottleMaterializationPackage,
  shouldApply: HomebrewBottleMaterializationOptions["shouldApplyLink"],
): string[] {
  const applied: string[] = [];
  const seenTargets = new Set<string>();
  for (const entry of pkg.links) {
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
    if (shouldApply !== undefined && !shouldApply(entry, targetPath)) continue;
    if (tryLstat(fs, targetPath) !== null) {
      fail(pkg, `link target ${entry.target} already exists at ${targetPath}`);
    }
    ensureParentDir(fs, targetPath);
    applyLinkEntry(fs, entry, sourcePath, sourceStat, targetPath);
    applied.push(entry.target);
  }
  return applied;
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
    case "file":
      writeVfsBinary(
        fs,
        targetPath,
        readVfsFile(fs, sourcePath),
        parseManifestMode(entry, sourceStat),
      );
      return;
    case "directory":
      ensureDirRecursive(fs, targetPath);
      fs.chmod(targetPath, parseManifestMode(entry, sourceStat));
  }
}

function validateLinkEntrySource(
  pkg: HomebrewBottleMaterializationPackage,
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

function assertSelectedTargetHierarchy(
  selected: readonly {
    pkg: HomebrewBottleMaterializationPackage;
    entry: HomebrewLinkEntry;
    path: string;
  }[],
): void {
  for (let leftIndex = 0; leftIndex < selected.length; leftIndex += 1) {
    const left = selected[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < selected.length; rightIndex += 1) {
      const right = selected[rightIndex]!;
      if (
        guestPathIsUnder(right.path, left.path) ||
        guestPathIsUnder(left.path, right.path)
      ) {
        fail(
          right.pkg,
          `selected link targets ${left.entry.target} and ${right.entry.target} are nested; ` +
            "nested targets are unsupported",
        );
      }
    }
  }
}

function assertExistingParentsAreDirectories(
  fs: MemoryFileSystem,
  pkg: HomebrewBottleMaterializationPackage,
  targetPath: string,
  label: string,
): void {
  let parent = dirnameGuestPath(targetPath);
  while (guestPathIsUnder(parent, pkg.prefix)) {
    const stat = tryLstat(fs, parent);
    if (stat !== null && kind(stat) !== S_IFDIR) {
      fail(pkg, `${label} has a non-directory parent at ${parent}`);
    }
    if (parent === pkg.prefix) return;
    parent = dirnameGuestPath(parent);
  }
}

function validateArchiveSymlink(
  pkg: HomebrewBottleMaterializationPackage,
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
  return Number.isFinite(parsed) ? parsed & MODE_BITS : sourceStat.mode & MODE_BITS;
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  const fd = fs.open(path, O_RDONLY, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    fs.read(fd, bytes, null, bytes.byteLength);
    return bytes;
  } finally {
    fs.close(fd);
  }
}

function validateSafeRelativePath(path: string, label: string): void {
  if (path.length === 0 || path.startsWith("/")) {
    throw new HomebrewVfsMaterializationError(
      `${label} ${JSON.stringify(path)} must be a relative path`,
    );
  }
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new HomebrewVfsMaterializationError(
        `${label} ${JSON.stringify(path)} contains an unsafe path segment`,
      );
    }
  }
}

function joinGuestPath(base: string, relativePath: string): string {
  validateSafeRelativePath(relativePath, "guest path");
  return `${base.replace(/\/+$/g, "")}/${relativePath}`;
}

function cellarRelativePath(
  pkg: Pick<HomebrewBottleMaterializationPackage, "prefix" | "cellar" | "failureLabel">,
): string {
  const prefix = `${pkg.prefix.replace(/\/+$/g, "")}/`;
  if (!pkg.cellar.startsWith(prefix)) {
    fail(pkg, `cellar ${pkg.cellar} is not under prefix ${pkg.prefix}`);
  }
  const relative = pkg.cellar.slice(prefix.length);
  validateSafeRelativePath(relative, "Homebrew cellar");
  return relative;
}

function normalizeRelativeFrom(base: string, relativePath: string): string {
  const parts = base.split("/").filter(Boolean);
  for (const segment of relativePath.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

function dirnameGuestPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function absoluteGuestPathComponents(
  path: string,
  pkg: Pick<HomebrewBottleMaterializationPackage, "failureLabel">,
): string[] {
  if (!path.startsWith("/")) {
    fail(pkg, `Homebrew staging path ${path} is not absolute`);
  }
  const components = ["/"];
  let current = "";
  for (const segment of path.split("/").filter(Boolean)) {
    if (segment === "." || segment === "..") {
      fail(pkg, `Homebrew staging path ${path} has an unsafe component`);
    }
    current += `/${segment}`;
    components.push(current);
  }
  return components;
}

function relativeGuestPath(fromDirectory: string, targetPath: string): string {
  const from = fromDirectory.split("/").filter(Boolean);
  const target = targetPath.split("/").filter(Boolean);
  let shared = 0;
  while (shared < from.length && shared < target.length && from[shared] === target[shared]) {
    shared += 1;
  }
  return [...from.slice(shared).map(() => ".."), ...target.slice(shared)].join("/");
}

function ensureParentDir(fs: MemoryFileSystem, path: string): void {
  ensureDirRecursive(fs, dirnameGuestPath(path));
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function guestPathIsUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
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

function kind(stat: StatResult): number {
  return stat.mode & S_IFMT;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function packageLabel(pkg: Pick<HomebrewBottleMaterializationPackage, "name" | "version" | "arch">): string {
  return `package ${pkg.name}@${pkg.version} ${pkg.arch}`;
}

function checkedAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new HomebrewVfsMaterializationError("Homebrew bottle resource sum is unsafe");
  }
  return sum;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(
  pkg: Pick<HomebrewBottleMaterializationPackage, "failureLabel">,
  message: string,
): never {
  throw new HomebrewVfsMaterializationError(`${pkg.failureLabel}: ${message}`);
}
