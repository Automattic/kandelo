import { createHash } from "node:crypto";
import { gunzipSync } from "fflate";
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

const DEFAULT_IMAGE_BYTES = 128 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;
const O_RDONLY = 0;
const MODE_BITS = 0o7777;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const TEXT_ENCODER = new TextEncoder();
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_BREWFILE_BYTES = 65_536;

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
}

export interface HomebrewVfsBuildReport {
  schema: 1;
  image?: string;
  selection: HomebrewVfsSelectionReport;
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

type TarEntryType = "file" | "directory" | "symlink";

interface TarEntry {
  path: string;
  type: TarEntryType;
  mode: number;
  data: Uint8Array;
  linkName?: string;
}

interface StagePackageResult {
  files: number;
  directories: number;
  symlinks: number;
}

export async function buildHomebrewVfs(
  plan: HomebrewVfsPlan,
  options: HomebrewVfsBuildOptions,
): Promise<HomebrewVfsBuildResult> {
  const fs = options.fs ?? createDefaultFs();
  const packageReports: HomebrewVfsPackageReport[] = [];
  const selection = createSelectionReport(plan, options.selectionSource);

  ensureDirRecursive(fs, "/etc/kandelo");

  for (const pkg of plan.packages) {
    const bottleBytes = await options.loadBottleBytes(pkg);
    verifyBottleBytes(pkg, bottleBytes);
    const tarEntries = parseBottleTarGz(pkg, bottleBytes);
    const staged = stagePackage(fs, pkg, tarEntries);
    validateReceipts(fs, pkg);
    const links = applyLinks(fs, pkg);

    packageReports.push({
      name: pkg.name,
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
    });
  }

  const report: HomebrewVfsBuildReport = {
    schema: 1,
    selection,
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
      metadata: report.metadata,
      packages: packageReports.map((pkg) => ({
        name: pkg.name,
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
        env: plan.packages.find((planned) => planned.name === pkg.name)?.linkManifest.env ?? {},
      })),
    }, null, 2) + "\n",
    0o644,
  );

  if (options.writeProfile) {
    writeProfileFragment(fs, plan);
  }

  return { fs, report };
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
    return parseTarGz(bytes, packageLabel(pkg));
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
  let files = 0;
  let directories = 0;
  let symlinks = 0;

  for (const entry of entries) {
    const targetPath = mapBottleEntryToGuestPath(pkg, entry.path);
    if (targetPath === null) continue;

    if (entry.type === "directory") {
      const existing = tryLstat(fs, targetPath);
      if (existing && kind(existing) !== S_IFDIR) {
        fail(pkg, `bottle directory ${entry.path} conflicts with existing ${targetPath}`);
      }
      ensureDirRecursive(fs, targetPath);
      fs.chmod(targetPath, entry.mode || 0o755);
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
      writeVfsBinary(fs, targetPath, entry.data, entry.mode || 0o644);
      files += 1;
    } else {
      const linkName = entry.linkName ?? "";
      validateArchiveSymlink(pkg, targetPath, linkName);
      fs.symlink(linkName, targetPath);
      symlinks += 1;
    }
  }

  return { files, directories, symlinks };
}

function validateReceipts(fs: MemoryFileSystem, pkg: HomebrewVfsPackagePlan): void {
  for (const receipt of pkg.linkManifest.receipts) {
    const path = resolveManifestSource(pkg, receipt);
    if (tryLstat(fs, path) === null) {
      fail(pkg, `receipt ${receipt} is missing after staging at ${path}`);
    }
  }
}

function applyLinks(fs: MemoryFileSystem, pkg: HomebrewVfsPackagePlan): string[] {
  const linkedTargets: string[] = [];
  const seenTargets = new Set<string>();

  for (const entry of pkg.linkManifest.links) {
    if (seenTargets.has(entry.target)) {
      fail(pkg, `link target ${entry.target} is duplicated`);
    }
    seenTargets.add(entry.target);

    const sourcePath = resolveManifestSource(pkg, entry.source);
    const targetPath = joinGuestPath(pkg.prefix, entry.target);
    if (!guestPathIsUnder(targetPath, pkg.prefix)) {
      fail(pkg, `link target ${entry.target} escapes prefix ${pkg.prefix}`);
    }
    const sourceStat = tryStat(fs, sourcePath);
    if (sourceStat === null) {
      fail(pkg, `link source ${entry.source} is missing at ${sourcePath}`);
    }
    if (tryLstat(fs, targetPath) !== null) {
      fail(pkg, `link target ${entry.target} already exists at ${targetPath}`);
    }

    ensureParentDir(fs, targetPath);
    applyLinkEntry(fs, pkg, entry, sourcePath, sourceStat, targetPath);
    linkedTargets.push(entry.target);
  }

  return linkedTargets;
}

function applyLinkEntry(
  fs: MemoryFileSystem,
  pkg: HomebrewVfsPackagePlan,
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
      if (kind(sourceStat) !== S_IFREG) {
        fail(pkg, `file link source ${entry.source} is not a regular file`);
      }
      writeVfsBinary(fs, targetPath, readVfsFile(fs, sourcePath), parseManifestMode(entry, sourceStat));
      return;
    }
    case "directory": {
      if (kind(sourceStat) !== S_IFDIR) {
        fail(pkg, `directory link source ${entry.source} is not a directory`);
      }
      ensureDirRecursive(fs, targetPath);
      fs.chmod(targetPath, parseManifestMode(entry, sourceStat));
      return;
    }
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

function mapBottleEntryToGuestPath(pkg: HomebrewVfsPackagePlan, entryPath: string): string | null {
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

function resolveManifestSource(pkg: HomebrewVfsPackagePlan, source: string): string {
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

function parseTarGz(bytes: Uint8Array, label: string): TarEntry[] {
  let tarBytes: Uint8Array;
  try {
    tarBytes = gunzipSync(bytes);
  } catch (err) {
    throw new HomebrewVfsBuildError(
      `${label}: cannot gunzip bottle: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseTar(tarBytes, label);
}

function parseTar(bytes: Uint8Array, label: string): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let localPax: Record<string, string> | null = null;
  let globalPax: Record<string, string> = {};

  while (offset + TAR_BLOCK_BYTES <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    offset += TAR_BLOCK_BYTES;

    if (isZeroBlock(header)) {
      break;
    }

    validateTarChecksum(header, label);
    const typeflag = readStringField(header, 156, 1) || "0";
    const size = readTarNumber(header, 124, 12, `${label}: tar entry size`);
    const mode = readTarNumber(header, 100, 8, `${label}: tar entry mode`) & MODE_BITS;
    if (offset + size > bytes.byteLength) {
      throw new HomebrewVfsBuildError(`${label}: tar entry is truncated`);
    }
    const data = bytes.subarray(offset, offset + size);
    offset += Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;

    const rawName = tarPathFromHeader(header, label);
    const rawLinkName = readStringField(header, 157, 100);

    if (typeflag === "x" || typeflag === "g") {
      const parsedPax = parsePaxRecords(data, label);
      if (typeflag === "x") {
        localPax = parsedPax;
      } else {
        globalPax = { ...globalPax, ...parsedPax };
      }
      continue;
    }

    const pax = { ...globalPax, ...(localPax ?? {}) };
    localPax = null;
    const path = normalizeTarEntryPath(pax.path ?? rawName, label);
    const linkName = pax.linkpath ?? rawLinkName;

    switch (typeflag) {
      case "0":
      case "\0":
        entries.push({ path, type: "file", mode: mode || 0o644, data });
        break;
      case "5":
        entries.push({ path, type: "directory", mode: mode || 0o755, data: new Uint8Array() });
        break;
      case "2":
        entries.push({
          path,
          type: "symlink",
          mode: mode || 0o777,
          data: new Uint8Array(),
          linkName,
        });
        break;
      case "1":
        throw new HomebrewVfsBuildError(`${label}: unsupported tar hardlink ${path}`);
      case "3":
      case "4":
      case "6":
        throw new HomebrewVfsBuildError(`${label}: unsupported tar device/fifo entry ${path}`);
      default:
        throw new HomebrewVfsBuildError(`${label}: unsupported tar entry type ${JSON.stringify(typeflag)} for ${path}`);
    }
  }

  return entries;
}

function parsePaxRecords(data: Uint8Array, label: string): Record<string, string> {
  const text = decodeUtf8(data, `${label}: pax header`);
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space <= offset) {
      throw new HomebrewVfsBuildError(`${label}: invalid pax record length`);
    }
    const recordLength = Number.parseInt(text.slice(offset, space), 10);
    if (!Number.isSafeInteger(recordLength) || recordLength <= 0) {
      throw new HomebrewVfsBuildError(`${label}: invalid pax record length`);
    }
    const record = text.slice(offset, offset + recordLength);
    if (record.length !== recordLength || !record.endsWith("\n")) {
      throw new HomebrewVfsBuildError(`${label}: truncated pax record`);
    }
    const equals = record.indexOf("=", space - offset + 1);
    if (equals < 0) {
      throw new HomebrewVfsBuildError(`${label}: invalid pax record`);
    }
    const key = record.slice(space - offset + 1, equals);
    const value = record.slice(equals + 1, -1);
    out[key] = value;
    offset += recordLength;
  }
  return out;
}

function validateTarChecksum(header: Uint8Array, label: string): void {
  const recorded = readTarNumber(header, 148, 8, `${label}: tar checksum`);
  let sum = 0;
  for (let i = 0; i < header.length; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  if (recorded !== sum) {
    throw new HomebrewVfsBuildError(`${label}: tar checksum mismatch`);
  }
}

function tarPathFromHeader(header: Uint8Array, label: string): string {
  const name = readStringField(header, 0, 100);
  const prefix = readStringField(header, 345, 155);
  return normalizeTarEntryPath(prefix ? `${prefix}/${name}` : name, label);
}

function normalizeTarEntryPath(path: string, label: string): string {
  let normalized = path;
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+$/g, "");
  validateSafeRelativePath(normalized, `${label}: tar path`);
  return normalized;
}

function readStringField(bytes: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && bytes[end] !== 0) end += 1;
  if (end === offset) return "";
  return decodeUtf8(bytes.subarray(offset, end), "tar string field");
}

function readTarNumber(bytes: Uint8Array, offset: number, length: number, label: string): number {
  const first = bytes[offset];
  if ((first & 0x80) !== 0) {
    throw new HomebrewVfsBuildError(`${label}: base-256 tar numbers are not supported`);
  }
  const raw = readStringField(bytes, offset, length).trim();
  if (raw.length === 0) return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new HomebrewVfsBuildError(`${label}: invalid octal number`);
  }
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HomebrewVfsBuildError(`${label}: invalid tar number`);
  }
  return value;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    throw new HomebrewVfsBuildError(`${label} contains non-UTF-8 text`);
  }
}

function validateSafeRelativePath(path: string, label: string): void {
  if (path.length === 0 || path.startsWith("/")) {
    throw new HomebrewVfsBuildError(`${label} ${JSON.stringify(path)} must be a relative path`);
  }
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new HomebrewVfsBuildError(`${label} ${JSON.stringify(path)} contains an unsafe path segment`);
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
