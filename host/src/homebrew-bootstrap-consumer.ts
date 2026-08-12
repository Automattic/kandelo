import { createHash } from "node:crypto";

import { KANDELO_HOMEBREW_GUEST_LAYOUT } from "./homebrew-guest-layout";
import { ensureDirRecursive, writeVfsBinary } from "./vfs/image-helpers";
import type { MemoryFileSystem } from "./vfs/memory-fs";
import type { DerivedPackageDeferredZipTree } from "./vfs/package-deferred-tree";

const HOMEBREW_BOOTSTRAP_ENV_PATH = "/etc/homebrew/brew.env";
const HOMEBREW_BOOTSTRAP_ENTRYPOINT = "/usr/bin/brew";
const HOMEBREW_BOOTSTRAP_PREFIX = KANDELO_HOMEBREW_GUEST_LAYOUT.prefix;
const HOMEBREW_BOOTSTRAP_TARGET = `${HOMEBREW_BOOTSTRAP_PREFIX}/bin/brew`;
const HOMEBREW_BOOTSTRAP_MUTABLE_PATHS = [
  KANDELO_HOMEBREW_GUEST_LAYOUT.cellar,
  `${HOMEBREW_BOOTSTRAP_PREFIX}/Library/Taps`,
  `${HOMEBREW_BOOTSTRAP_PREFIX}/var/homebrew/linked`,
  `${HOMEBREW_BOOTSTRAP_PREFIX}/var/homebrew/locks`,
  "/home/user/.cache/Homebrew",
] as const;

export interface HomebrewBootstrapConsumerState {
  environment: {
    path: typeof HOMEBREW_BOOTSTRAP_ENV_PATH;
    sha256: string;
    bytes: number;
  };
  entrypoint: {
    path: typeof HOMEBREW_BOOTSTRAP_ENTRYPOINT;
    target: typeof HOMEBREW_BOOTSTRAP_TARGET;
  };
  ownership: {
    prefix: typeof HOMEBREW_BOOTSTRAP_PREFIX;
    uid: 1000;
    gid: 1000;
    mutable_paths: string[];
  };
}

/** Adopt the package prefix before registering its deferred bootstrap tree. */
export function prepareHomebrewBootstrapConsumerNamespace(
  fs: MemoryFileSystem,
  tree: DerivedPackageDeferredZipTree,
): void {
  if (
    tree.descriptor.package.name !== "homebrew-bootstrap" ||
    tree.descriptor.mount_prefix !== HOMEBREW_BOOTSTRAP_PREFIX
  ) {
    throw new Error(
      "Homebrew bootstrap ownership requires the canonical deferred source tree",
    );
  }
  for (const path of HOMEBREW_BOOTSTRAP_MUTABLE_PATHS) {
    ensureDirRecursive(fs, path);
  }
  // WHY: the guest package store belongs to the unprivileged Kandelo user.
  // Bottle composition initially creates structural prefix directories as
  // root; adopting the complete prefix here both avoids a false lazy-tree
  // collision and lets in-guest brew update Cellar, taps, links, and locks.
  chownVfsTree(fs, HOMEBREW_BOOTSTRAP_PREFIX, 1000, 1000);
  chownVfsTree(fs, "/home/user/.cache", 1000, 1000);
}

/** Install the exact environment and public activation alias for the tree. */
export function installHomebrewBootstrapConsumerState(
  fs: MemoryFileSystem,
  tree: DerivedPackageDeferredZipTree,
  environment: Uint8Array,
): HomebrewBootstrapConsumerState {
  const descriptor = tree.descriptor;
  if (
    descriptor.content_role !== "source-tree" ||
    descriptor.package.name !== "homebrew-bootstrap" ||
    descriptor.mount_prefix !== HOMEBREW_BOOTSTRAP_PREFIX ||
    !descriptor.activation.roots.includes(HOMEBREW_BOOTSTRAP_TARGET) ||
    !descriptor.inventory.some(
      (entry) =>
        entry.vfs_path === HOMEBREW_BOOTSTRAP_TARGET &&
        entry.type === "file" &&
        (entry.mode & 0o111) !== 0,
    )
  ) {
    throw new Error(
      "Homebrew bootstrap environment requires the canonical deferred source tree",
    );
  }
  // WHY: descriptor ownership alone does not prove the registered VFS still
  // contains its activation root. Check before writing consumer state so a
  // deleted tree member cannot leave a new dangling /usr/bin/brew alias.
  assertHomebrewBootstrapTarget(fs, HOMEBREW_BOOTSTRAP_TARGET);
  for (const path of [
    HOMEBREW_BOOTSTRAP_ENV_PATH,
    HOMEBREW_BOOTSTRAP_ENTRYPOINT,
  ]) {
    if (vfsPathExists(fs, path)) {
      throw new Error(
        `refusing to replace Homebrew bootstrap consumer state: ${path}`,
      );
    }
  }
  ensureDirRecursive(fs, guestDirname(HOMEBREW_BOOTSTRAP_ENV_PATH));
  writeVfsBinary(fs, HOMEBREW_BOOTSTRAP_ENV_PATH, environment, 0o644);
  // WHY: Homebrew derives its canonical Kandelo prefix from this public alias.
  // Pointing PATH straight at bin/brew appears to work but bypasses that
  // launcher contract and can select the wrong prefix or bottle tag.
  fs.symlink(HOMEBREW_BOOTSTRAP_TARGET, HOMEBREW_BOOTSTRAP_ENTRYPOINT);
  const state: HomebrewBootstrapConsumerState = {
    environment: {
      path: HOMEBREW_BOOTSTRAP_ENV_PATH,
      sha256: sha256(environment),
      bytes: environment.byteLength,
    },
    entrypoint: {
      path: HOMEBREW_BOOTSTRAP_ENTRYPOINT,
      target: HOMEBREW_BOOTSTRAP_TARGET,
    },
    ownership: {
      prefix: HOMEBREW_BOOTSTRAP_PREFIX,
      uid: 1000,
      gid: 1000,
      mutable_paths: [...HOMEBREW_BOOTSTRAP_MUTABLE_PATHS],
    },
  };
  assertHomebrewBootstrapConsumerState(fs, state);
  return state;
}

/** Recheck the bootstrap consumer binding on a live or restored filesystem. */
export function assertHomebrewBootstrapConsumerState(
  fs: MemoryFileSystem,
  expected: HomebrewBootstrapConsumerState,
): void {
  const environment = readVfsBinary(fs, expected.environment.path);
  const environmentStat = fs.lstat(expected.environment.path);
  if (
    environment.byteLength !== expected.environment.bytes ||
    sha256(environment) !== expected.environment.sha256 ||
    (environmentStat.mode & 0xf000) !== 0x8000 ||
    (environmentStat.mode & 0o7777) !== 0o644 ||
    environmentStat.uid !== 0 ||
    environmentStat.gid !== 0
  ) {
    throw new Error("Homebrew bootstrap system environment changed in the VFS");
  }
  const stat = fs.lstat(expected.entrypoint.path);
  if (
    (stat.mode & 0xf000) !== 0xa000 ||
    (stat.mode & 0o7777) !== 0o777 ||
    stat.uid !== 0 ||
    stat.gid !== 0 ||
    fs.readlink(expected.entrypoint.path) !== expected.entrypoint.target
  ) {
    throw new Error("Homebrew bootstrap entrypoint changed in the VFS");
  }
  assertHomebrewBootstrapTarget(fs, expected.entrypoint.target);
  assertVfsTreeOwner(
    fs,
    expected.ownership.prefix,
    expected.ownership.uid,
    expected.ownership.gid,
  );
  for (const path of expected.ownership.mutable_paths) {
    const mutable = fs.lstat(path);
    if (
      (mutable.mode & 0xf000) !== 0x4000 ||
      mutable.uid !== expected.ownership.uid ||
      mutable.gid !== expected.ownership.gid
    ) {
      throw new Error(`Homebrew mutable path has the wrong owner: ${path}`);
    }
  }
}

function assertHomebrewBootstrapTarget(
  fs: MemoryFileSystem,
  path: string,
): void {
  try {
    const target = fs.stat(path);
    if ((target.mode & 0xf000) !== 0x8000 || (target.mode & 0o111) === 0) {
      throw new Error("target is not an executable regular file");
    }
  } catch (error) {
    throw new Error(
      "Homebrew bootstrap environment requires the canonical deferred source tree",
      { cause: error },
    );
  }
}

function chownVfsTree(
  fs: MemoryFileSystem,
  root: string,
  uid: number,
  gid: number,
): void {
  fs.lchown(root, uid, gid);
  if ((fs.lstat(root).mode & 0xf000) !== 0x4000) return;
  const handle = fs.opendir(root);
  try {
    for (;;) {
      const entry = fs.readdir(handle);
      if (entry === null) break;
      if (entry.name === "." || entry.name === "..") continue;
      const path = root === "/" ? `/${entry.name}` : `${root}/${entry.name}`;
      chownVfsTree(fs, path, uid, gid);
    }
  } finally {
    fs.closedir(handle);
  }
}

function assertVfsTreeOwner(
  fs: MemoryFileSystem,
  root: string,
  uid: number,
  gid: number,
): void {
  const stat = fs.lstat(root);
  if (stat.uid !== uid || stat.gid !== gid) {
    throw new Error(`Homebrew prefix entry has the wrong owner: ${root}`);
  }
  if ((stat.mode & 0xf000) !== 0x4000) return;
  const handle = fs.opendir(root);
  try {
    for (;;) {
      const entry = fs.readdir(handle);
      if (entry === null) break;
      if (entry.name === "." || entry.name === "..") continue;
      const path = root === "/" ? `/${entry.name}` : `${root}/${entry.name}`;
      assertVfsTreeOwner(fs, path, uid, gid);
    }
  } finally {
    fs.closedir(handle);
  }
}

function readVfsBinary(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(
        fd,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (count <= 0) throw new Error(`short read from VFS file: ${path}`);
      offset += count;
    }
    return bytes;
  } finally {
    fs.close(fd);
  }
}

function vfsPathExists(fs: MemoryFileSystem, path: string): boolean {
  try {
    fs.lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" && error !== null &&
      "code" in error && error.code === -2
    ) return false;
    throw error;
  }
}

function guestDirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
