import { createHash } from "node:crypto";
import { zipSync, type Zippable } from "fflate";
import {
  buildHomebrewVfs,
  type HomebrewVfsSelectionSource,
} from "./homebrew-vfs-builder";
import type {
  HomebrewVfsPackagePlan,
  HomebrewVfsPlan,
} from "./homebrew-vfs-planner";
import { MemoryFileSystem } from "./vfs/memory-fs";

export const HOMEBREW_LAZY_LAYER_ARCHIVE =
  "kandelo-homebrew-shell-layer.zip";
export const HOMEBREW_LAZY_LAYER_DESCRIPTOR =
  "kandelo-homebrew-shell-layer.json";

const HOMEBREW_VFS_ASSET = "kandelo-homebrew.vfs.zst";
const HOME_BREW_PREFIX = "/home/linuxbrew/.linuxbrew";
const INCLUDED_ROOTS = [
  HOME_BREW_PREFIX,
  "/etc/kandelo/homebrew-vfs.json",
  "/etc/profile.d/kandelo-homebrew.sh",
] as const;
const ZIP_EPOCH = new Date(1980, 0, 1, 0, 0, 0);
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;
const MAX_LAYER_ENTRIES = 100_000;
const MAX_LAYER_PATH_BYTES = 4096;
const MAX_SYMLINK_TARGET_BYTES = 65_536;

export interface HomebrewLazyLayerSourceVfs {
  sha256: string;
  bytes: number;
}

export interface HomebrewLazyLayerEntry {
  path: string;
  type: "directory" | "file" | "symlink";
  mode: number;
  size: number;
  target?: string;
}

export interface HomebrewLazyLayerDescriptor {
  schema: 1;
  kind: "kandelo-homebrew-lazy-archive";
  arch: "wasm32" | "wasm64";
  mount_prefix: "/";
  tap: {
    repository: string;
    name: string;
    commit: string;
  };
  kandelo: {
    repository: string;
    commit: string;
    abi: number;
  };
  bottle_release_tag: string;
  selection: {
    requested_packages: string[];
    package_order: string[];
  };
  packages: Array<{
    name: string;
    full_name: string;
    tap_repository: string;
    tap_name: string;
    tap_commit: string;
    version: string;
    arch: "wasm32" | "wasm64";
    source_status: "success" | "fallback";
    metadata_status: string;
    url: string;
    sha256: string;
    bytes: number;
    cache_key_sha: string;
    link_manifest: string;
  }>;
  release: {
    repository: string;
    tag: string;
  };
  source_vfs: {
    asset: typeof HOMEBREW_VFS_ASSET;
    url: string;
    sha256: string;
    bytes: number;
  };
  archive: {
    format: "zip";
    asset: typeof HOMEBREW_LAZY_LAYER_ARCHIVE;
    url: string;
    sha256: string;
    bytes: number;
    entry_count: number;
    uncompressed_bytes: number;
  };
  entries: HomebrewLazyLayerEntry[];
}

export interface BuildHomebrewLazyLayerOptions {
  fs: MemoryFileSystem;
  sourceVfs: HomebrewLazyLayerSourceVfs;
  loadBottleBytes: (
    pkg: HomebrewVfsPackagePlan,
  ) => Uint8Array | Promise<Uint8Array>;
  selectionSource?: HomebrewVfsSelectionSource;
}

export interface HomebrewLazyLayerBuildResult {
  archive: Uint8Array;
  descriptor: HomebrewLazyLayerDescriptor;
}

/**
 * Build a browser-fetchable ZIP from the exact Homebrew closure used by the
 * eager VFS publisher. This is a transport artifact only: it preserves the
 * poured keg, link-manifest results, opt links, and profile fragment without
 * claiming that the browser runtime mounts the layer yet.
 */
export async function buildHomebrewLazyLayer(
  plan: HomebrewVfsPlan,
  options: BuildHomebrewLazyLayerOptions,
): Promise<HomebrewLazyLayerBuildResult> {
  assertSourceVfs(options.sourceVfs);
  const { fs } = await buildHomebrewVfs(plan, {
    fs: options.fs,
    loadBottleBytes: options.loadBottleBytes,
    selectionSource: options.selectionSource,
    writeProfile: true,
    createdBy: "host/src/homebrew-lazy-layer.ts",
  });
  const entries = collectLayerEntries(fs);
  const archive = createLayerZip(fs, entries);
  const archiveSha = digest(archive);
  const releaseTag = `homebrew-vfs-sha256-${options.sourceVfs.sha256}`;
  const releaseRoot =
    `https://github.com/${plan.tapRepository}/releases/download/${releaseTag}`;
  const arch = commonArch(plan);

  return {
    archive,
    descriptor: {
      schema: 1,
      kind: "kandelo-homebrew-lazy-archive",
      arch,
      mount_prefix: "/",
      tap: {
        repository: plan.tapRepository,
        name: plan.tapName,
        commit: plan.tapCommit,
      },
      kandelo: {
        repository: plan.kandeloRepository,
        commit: plan.kandeloCommit,
        abi: plan.kandeloAbi,
      },
      bottle_release_tag: plan.releaseTag,
      selection: {
        requested_packages: [...plan.requestedPackages],
        package_order: plan.packages.map((pkg) => pkg.fullName),
      },
      packages: plan.packages.map(packageRecord),
      release: {
        repository: plan.tapRepository,
        tag: releaseTag,
      },
      source_vfs: {
        asset: HOMEBREW_VFS_ASSET,
        url: `${releaseRoot}/${HOMEBREW_VFS_ASSET}`,
        sha256: options.sourceVfs.sha256,
        bytes: options.sourceVfs.bytes,
      },
      archive: {
        format: "zip",
        asset: HOMEBREW_LAZY_LAYER_ARCHIVE,
        url: `${releaseRoot}/${HOMEBREW_LAZY_LAYER_ARCHIVE}`,
        sha256: archiveSha,
        bytes: archive.byteLength,
        entry_count: entries.length,
        uncompressed_bytes: entries.reduce(
          (total, entry) => total + entry.size,
          0,
        ),
      },
      entries,
    },
  };
}

export function encodeHomebrewLazyLayerDescriptor(
  descriptor: HomebrewLazyLayerDescriptor,
): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(descriptor, null, 2)}\n`);
}

function assertSourceVfs(source: HomebrewLazyLayerSourceVfs): void {
  if (!/^[0-9a-f]{64}$/.test(source.sha256)) {
    throw new Error("Homebrew lazy layer source VFS sha256 is invalid");
  }
  if (!Number.isSafeInteger(source.bytes) || source.bytes <= 0) {
    throw new Error("Homebrew lazy layer source VFS byte count is invalid");
  }
}

function commonArch(plan: HomebrewVfsPlan): "wasm32" | "wasm64" {
  const arch = plan.packages[0]?.arch;
  if (arch === undefined || plan.packages.some((pkg) => pkg.arch !== arch)) {
    throw new Error("Homebrew lazy layer plan must have one non-empty architecture");
  }
  return arch;
}

function packageRecord(pkg: HomebrewVfsPackagePlan) {
  return {
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
  };
}

function collectLayerEntries(fs: MemoryFileSystem): HomebrewLazyLayerEntry[] {
  const entries: HomebrewLazyLayerEntry[] = [];
  for (const root of INCLUDED_ROOTS) {
    if (pathExists(fs, root)) collectPath(fs, root, entries);
  }
  entries.sort((left, right) => compareText(left.path, right.path));
  if (!entries.some((entry) => entry.path === withoutLeadingSlash(HOME_BREW_PREFIX))) {
    throw new Error("Homebrew lazy layer is missing its poured prefix");
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
): void {
  const stat = fs.lstat(vfsPath);
  const path = withoutLeadingSlash(vfsPath);
  validateArchivePath(path);
  const mode = stat.mode & 0o7777;
  const type = stat.mode & S_IFMT;
  if (type === S_IFDIR) {
    entries.push({ path, type: "directory", mode, size: 0 });
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
      collectPath(fs, `${vfsPath}/${name}`, entries);
    }
    return;
  }
  if (type === S_IFREG) {
    entries.push({ path, type: "file", mode, size: stat.size });
    return;
  }
  if (type === S_IFLNK) {
    const target = fs.readlink(vfsPath);
    const targetBytes = new TextEncoder().encode(target).byteLength;
    if (targetBytes === 0 || targetBytes > MAX_SYMLINK_TARGET_BYTES) {
      throw new Error(`Homebrew lazy layer symlink target is invalid: ${vfsPath}`);
    }
    entries.push({ path, type: "symlink", mode, size: targetBytes, target });
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

function readFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
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
