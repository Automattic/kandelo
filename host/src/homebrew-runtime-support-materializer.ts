import { createHash } from "node:crypto";

import type { HomebrewBottleDescriptor } from "./homebrew-bottle-descriptor";
import type { HomebrewBottleArch, HomebrewLinkEntry } from "./homebrew-bottle-types";
import { KANDELO_HOMEBREW_GUEST_LAYOUT } from "./homebrew-guest-layout";
import type { HomebrewVfsResourcePolicy } from "./homebrew-vfs-resource-policy";
import { ensureDirRecursive } from "./vfs/image-helpers";
import { MemoryFileSystem } from "./vfs/memory-fs";
import {
  assertPackageDeferredZipTreeState,
  derivePackageDeferredZipTree,
  materializePackageDeferredZipTree,
  registerPackageDeferredZipTree,
  type DerivedPackageDeferredZipTree,
  type PackageDeferredZipTreeSpec,
} from "./vfs/package-deferred-tree";
import { ENOENT, SFSError } from "./vfs/sharedfs-vendor";
import type { TarEntry } from "./vfs/tar";

const BOOTSTRAP_FULL_NAME = "kandelo-dev/tap-core/homebrew-bootstrap";
const BOOTSTRAP_NAME = "homebrew-bootstrap";
const BOOTSTRAP_ZIP_OUTPUT = "homebrew-bootstrap";
const BOOTSTRAP_ZIP_FILENAME = "homebrew-bootstrap.zip";
const BOOTSTRAP_ZIP_PATH = "libexec/homebrew-bootstrap.zip";
const BOOTSTRAP_ENV_OUTPUT = "homebrew-brew";
const BOOTSTRAP_ENV_PATH = "libexec/homebrew-brew.env";
const ENV_PATH = "/etc/homebrew/brew.env";
const ENTRYPOINT = KANDELO_HOMEBREW_GUEST_LAYOUT.stableEntrypoint;
const PREFIX = KANDELO_HOMEBREW_GUEST_LAYOUT.prefix;
const STABLE_BASH = "/bin/bash";
const SOURCE_ROOTFS_BASH = "/usr/bin/bash";
const HOMEBREW_BASH = `${PREFIX}/bin/bash`;
const USER_ID = 1000;
const GROUP_ID = 1000;
const S_IFMT = 0xf000;
const S_IFREG = 0x8000;
const S_IFDIR = 0x4000;
const S_IFLNK = 0xa000;
const textEncoder = new TextEncoder();

const MUTABLE_DIRECTORIES = Object.freeze([
  `${PREFIX}/Cellar`,
  `${PREFIX}/Library/Taps`,
  `${PREFIX}/var/homebrew/linked`,
  `${PREFIX}/var/homebrew/locks`,
  "/home/user/.cache/Homebrew",
]);

export interface PreparedHomebrewRuntimeSupport {
  readonly zipBytes: Uint8Array;
  readonly environmentBytes: Uint8Array;
  readonly tree: DerivedPackageDeferredZipTree;
}

interface HomebrewRuntimeSupportPreparedKeg {
  readonly input: {
    readonly name: string;
    readonly fullName: string;
    readonly version: string;
    readonly arch: HomebrewBottleArch;
    readonly prefix: string;
    readonly cellar: string;
    readonly keg: string;
    readonly payloadRoot: string;
    readonly receipts: readonly string[];
    readonly links: readonly HomebrewLinkEntry[];
    readonly pathPrepend: readonly string[];
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly entries: readonly TarEntry[];
}

export class HomebrewRuntimeSupportMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomebrewRuntimeSupportMaterializationError";
  }
}

/** Authenticate and derive runtime support while the original TAR entries exist. */
export function prepareHomebrewRuntimeSupport(
  descriptor: HomebrewBottleDescriptor,
  preparedKeg: HomebrewRuntimeSupportPreparedKeg,
  limits: HomebrewVfsResourcePolicy["supportZip"],
): PreparedHomebrewRuntimeSupport {
  assertBootstrapIdentity(descriptor, preparedKeg);
  assertSupportLimits(limits);
  const [zipOutput, environmentOutput] = exactSupportOutputs(descriptor);
  const zipBytes = authenticatedSupportOutput(descriptor, preparedKeg, zipOutput);
  const environmentBytes = authenticatedSupportOutput(
    descriptor,
    preparedKeg,
    environmentOutput,
  );
  const expectedEnvironment = expectedHomebrewEnvironment(descriptor.arch);
  if (!bytesEqual(environmentBytes, expectedEnvironment)) {
    fail("homebrew-brew.env does not match the exact Kandelo Homebrew environment");
  }
  if (zipBytes.byteLength > limits.maxCompressedBytes) {
    fail(
      `Homebrew runtime-support ZIP byte count ${zipBytes.byteLength} exceeds ` +
        `the limit ${limits.maxCompressedBytes}`,
    );
  }

  let tree: DerivedPackageDeferredZipTree;
  try {
    tree = derivePackageDeferredZipTree(runtimeSupportTreeSpec(descriptor), zipBytes);
  } catch (error) {
    fail(errorMessage(error));
  }
  if (tree.content.expandedBytes > limits.maxExpandedBytes) {
    fail(
      `Homebrew runtime-support ZIP expanded byte count ${tree.content.expandedBytes} ` +
        `exceeds the limit ${limits.maxExpandedBytes}`,
    );
  }
  if (tree.content.sourceEntryCount > limits.maxEntries) {
    fail(
      `Homebrew runtime-support ZIP entry count ${tree.content.sourceEntryCount} ` +
        `exceeds the limit ${limits.maxEntries}`,
    );
  }
  assertRuntimeTreeInventory(tree);
  return Object.freeze({
    zipBytes,
    environmentBytes,
    tree,
  });
}

/** Register and eagerly materialize the authenticated support ZIP. */
export async function overlayPreparedHomebrewRuntimeSupport(
  fs: MemoryFileSystem,
  prepared: PreparedHomebrewRuntimeSupport,
): Promise<void> {
  try {
    const registered = registerPackageDeferredZipTree(fs, prepared.tree);
    await materializePackageDeferredZipTree(fs, registered, prepared.zipBytes);
    assertPackageDeferredZipTreeState(fs, prepared.tree, "materialized");
  } catch (error) {
    fail(errorMessage(error));
  }
}

/** Install guest-facing state and adopt all mutable Homebrew-owned paths. */
export function finalizeHomebrewRuntimeSupport(
  fs: MemoryFileSystem,
  prepared: PreparedHomebrewRuntimeSupport,
): void {
  try {
    const stableBashAction = preflightFinalNamespace(fs);
    for (const path of MUTABLE_DIRECTORIES) ensureDirRecursive(fs, path, 0o755);
    ensureDirRecursive(fs, dirname(ENV_PATH), 0o755);
    fs.createFileWithOwner(ENV_PATH, 0o644, 0, 0, prepared.environmentBytes);
    ensureDirRecursive(fs, dirname(ENTRYPOINT), 0o755);
    fs.symlinkWithOwner(`${PREFIX}/bin/brew`, ENTRYPOINT, 0, 0);
    if (stableBashAction === "replace-source-rootfs-alias") {
      // WHY: stock Homebrew's bootstrap bin/brew declares /bin/bash, while the
      // source-rootfs alias resolves to a deferred program. Only replace that
      // exact alias after proving the selected bottle supplies an eager Bash.
      fs.unlink(STABLE_BASH);
      fs.symlinkWithOwner(HOMEBREW_BASH, STABLE_BASH, 0, 0);
    }

    recursivelyLchown(fs, PREFIX, USER_ID, GROUP_ID);
    recursivelyLchown(fs, "/home/user/.cache", USER_ID, GROUP_ID);
    assertFinalRuntimeSupport(fs, prepared);
  } catch (error) {
    if (error instanceof HomebrewRuntimeSupportMaterializationError) throw error;
    fail(errorMessage(error));
  }
}

function assertBootstrapIdentity(
  descriptor: HomebrewBottleDescriptor,
  preparedKeg: HomebrewRuntimeSupportPreparedKeg,
): void {
  if (
    descriptor.fullName !== BOOTSTRAP_FULL_NAME ||
    descriptor.name !== BOOTSTRAP_NAME ||
    descriptor.materialization !== "homebrew-runtime-support-v1"
  ) {
    fail("runtime support requires the exact selected Homebrew bootstrap descriptor");
  }
  const actual = preparedKeg.input;
  const expected = {
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
  };
  for (const key of [
    "name",
    "fullName",
    "version",
    "arch",
    "prefix",
    "cellar",
    "keg",
    "payloadRoot",
    "sha256",
    "bytes",
  ] as const) {
    if (actual[key] !== expected[key]) {
      fail(`prepared bootstrap keg does not match descriptor field ${key}`);
    }
  }
  for (const key of ["receipts", "links", "pathPrepend"] as const) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) {
      fail(`prepared bootstrap keg does not match descriptor field ${key}`);
    }
  }
}

function exactSupportOutputs(descriptor: HomebrewBottleDescriptor): [
  HomebrewBottleDescriptor["supportOutputs"][number],
  HomebrewBottleDescriptor["supportOutputs"][number],
] {
  const outputs = descriptor.supportOutputs;
  if (
    outputs.length !== 2 ||
    outputs[0]?.name !== BOOTSTRAP_ZIP_OUTPUT ||
    outputs[0]?.kegRelativePath !== BOOTSTRAP_ZIP_PATH ||
    outputs[1]?.name !== BOOTSTRAP_ENV_OUTPUT ||
    outputs[1]?.kegRelativePath !== BOOTSTRAP_ENV_PATH
  ) {
    fail("Homebrew bootstrap descriptor does not declare the exact support outputs");
  }
  return [outputs[0], outputs[1]];
}

function authenticatedSupportOutput(
  descriptor: HomebrewBottleDescriptor,
  preparedKeg: HomebrewRuntimeSupportPreparedKeg,
  output: HomebrewBottleDescriptor["supportOutputs"][number],
): Uint8Array {
  const archivePath = `${descriptor.payloadRoot}/${output.kegRelativePath}`;
  const matches = preparedKeg.entries.filter((entry) => entry.path === archivePath);
  if (matches.length !== 1) {
    fail(
      `support output ${output.name} must be present exactly once at ${archivePath}`,
    );
  }
  const entry = matches[0]!;
  if (entry.type !== "file") {
    fail(`support output ${output.name} at ${archivePath} is not a regular TAR member`);
  }
  const bytes = new Uint8Array(entry.data);
  if (bytes.byteLength !== output.bytes) {
    fail(
      `support output ${output.name} byte count ${bytes.byteLength} does not match ` +
        `declared bytes ${output.bytes}`,
    );
  }
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== output.sha256) {
    fail(
      `support output ${output.name} SHA-256 ${actualSha256} does not match ` +
        `declared SHA-256 ${output.sha256}`,
    );
  }
  return bytes;
}

function runtimeSupportTreeSpec(
  descriptor: HomebrewBottleDescriptor,
): PackageDeferredZipTreeSpec {
  return {
    schema: 1,
    kind: "kandelo-package-deferred-zip-tree",
    id: "homebrew/homebrew-bootstrap",
    content_role: "source-tree",
    package: {
      name: descriptor.name,
      output: BOOTSTRAP_ZIP_FILENAME,
    },
    archive: {
      url: BOOTSTRAP_ZIP_FILENAME,
      mode_policy: "portable-posix-v1",
    },
    mount_prefix: PREFIX,
    owner: { uid: USER_ID, gid: GROUP_ID },
    activation: {
      mode: "boot-prefetch",
      capabilities: ["homebrew:bootstrap"],
      roots: [`${PREFIX}/bin/brew`],
    },
  };
}

function assertRuntimeTreeInventory(tree: DerivedPackageDeferredZipTree): void {
  const brewEntries = tree.entries.filter((entry) => entry.sourcePath === "bin/brew");
  if (
    brewEntries.length !== 1 ||
    brewEntries[0]!.type !== "file" ||
    (brewEntries[0]!.mode & 0o111) === 0
  ) {
    fail("Homebrew runtime-support ZIP must contain exactly one executable regular bin/brew");
  }
  for (const entry of tree.entries) {
    if (entry.type !== "symlink") continue;
    const target = entry.target!;
    if (target.length === 0 || target.startsWith("/")) {
      fail(`Homebrew runtime-support symlink ${entry.sourcePath} target must be relative`);
    }
    const resolved = resolveRelativeWithin(dirname(entry.vfsPath), target, PREFIX);
    if (resolved === null || !isUnder(resolved, PREFIX)) {
      fail(
        `Homebrew runtime-support symlink ${entry.sourcePath} target ` +
          `${JSON.stringify(target)} escapes ${PREFIX}`,
      );
    }
  }
}

function preflightFinalNamespace(
  fs: MemoryFileSystem,
): "none" | "replace-source-rootfs-alias" {
  const brewStat = lstatOrNull(fs, `${PREFIX}/bin/brew`);
  if (
    brewStat === null ||
    (brewStat.mode & S_IFMT) !== S_IFREG ||
    (brewStat.mode & 0o111) === 0
  ) {
    fail("materialized Homebrew bin/brew is not an executable regular file");
  }
  for (const path of [ENV_PATH, ENTRYPOINT]) {
    assertExistingComponentsAreDirectories(fs, dirname(path));
    if (lstatOrNull(fs, path) !== null) {
      fail(`Homebrew runtime-support destination already exists at ${path}`);
    }
  }
  for (const path of MUTABLE_DIRECTORIES) {
    assertExistingComponentsAreDirectories(fs, path);
  }
  return preflightStableBashInterpreter(fs);
}

function preflightStableBashInterpreter(
  fs: MemoryFileSystem,
): "none" | "replace-source-rootfs-alias" {
  const link = lstatOrNull(fs, STABLE_BASH);
  if (link === null) return "none";

  const kind = link.mode & S_IFMT;
  if (kind === S_IFLNK && fs.readlink(STABLE_BASH) === HOMEBREW_BASH) {
    if (link.uid !== 0 || link.gid !== 0) {
      fail(`${STABLE_BASH} Homebrew Bash link must be root-owned`);
    }
    assertEagerHomebrewBash(fs);
    return "none";
  }
  if (
    kind === S_IFLNK &&
    fs.readlink(STABLE_BASH) === SOURCE_ROOTFS_BASH &&
    fs.isPathDeferred(STABLE_BASH)
  ) {
    assertEagerHomebrewBash(fs);
    return "replace-source-rootfs-alias";
  }
  if (fs.isPathDeferred(STABLE_BASH)) {
    fail(`deferred ${STABLE_BASH} conflicts with the supported source-rootfs alias`);
  }
  if (kind === S_IFLNK) {
    fail(`${STABLE_BASH} symlink conflicts with the supported Bash aliases`);
  }
  assertEagerExecutable(fs, STABLE_BASH, "existing /bin/bash");
  return "none";
}

function assertEagerHomebrewBash(fs: MemoryFileSystem): void {
  if (fs.isPathDeferred(HOMEBREW_BASH)) {
    fail("selected Homebrew Bash remains deferred");
  }
  const bash = lstatOrNull(fs, HOMEBREW_BASH);
  if (bash === null || (bash.mode & S_IFMT) !== S_IFREG || (bash.mode & 0o111) === 0) {
    fail("selected Homebrew Bash is not an executable regular file");
  }
}

function assertEagerExecutable(
  fs: MemoryFileSystem,
  path: string,
  label: string,
): void {
  let stat;
  try {
    stat = fs.stat(path);
  } catch (error) {
    fail(`${label} does not resolve to an executable regular file: ${errorMessage(error)}`);
  }
  if ((stat.mode & S_IFMT) !== S_IFREG || (stat.mode & 0o111) === 0) {
    fail(`${label} is not an executable regular file`);
  }
}

function assertFinalRuntimeSupport(
  fs: MemoryFileSystem,
  prepared: PreparedHomebrewRuntimeSupport,
): void {
  assertPackageDeferredZipTreeState(fs, prepared.tree, "materialized");
  const environment = fs.lstat(ENV_PATH);
  if (
    (environment.mode & S_IFMT) !== S_IFREG ||
    (environment.mode & 0o7777) !== 0o644 ||
    environment.uid !== 0 ||
    environment.gid !== 0 ||
    !bytesEqual(readFile(fs, ENV_PATH), prepared.environmentBytes)
  ) {
    fail("installed Homebrew environment changed content, mode, or ownership");
  }
  const entrypoint = fs.lstat(ENTRYPOINT);
  const resolved = fs.stat(ENTRYPOINT);
  if (
    (entrypoint.mode & S_IFMT) !== S_IFLNK ||
    entrypoint.uid !== 0 ||
    entrypoint.gid !== 0 ||
    fs.readlink(ENTRYPOINT) !== `${PREFIX}/bin/brew` ||
    (resolved.mode & S_IFMT) !== S_IFREG ||
    (resolved.mode & 0o111) === 0
  ) {
    fail("installed Homebrew entrypoint is not the root-owned executable bootstrap link");
  }
  assertRecursiveOwnership(fs, PREFIX, USER_ID, GROUP_ID);
  assertRecursiveOwnership(fs, "/home/user/.cache", USER_ID, GROUP_ID);
}

function recursivelyLchown(
  fs: MemoryFileSystem,
  path: string,
  uid: number,
  gid: number,
): void {
  const stat = fs.lstat(path);
  if ((stat.mode & S_IFMT) === S_IFDIR) {
    const directory = fs.opendir(path);
    try {
      for (;;) {
        const entry = fs.readdir(directory);
        if (entry === null) break;
        if (entry.name === "." || entry.name === "..") continue;
        recursivelyLchown(fs, join(path, entry.name), uid, gid);
      }
    } finally {
      fs.closedir(directory);
    }
  }
  fs.lchown(path, uid, gid);
}

function assertRecursiveOwnership(
  fs: MemoryFileSystem,
  path: string,
  uid: number,
  gid: number,
): void {
  const stat = fs.lstat(path);
  if (stat.uid !== uid || stat.gid !== gid) {
    fail(`Homebrew writable path ${path} has owner ${stat.uid}:${stat.gid}`);
  }
  if ((stat.mode & S_IFMT) !== S_IFDIR) return;
  const directory = fs.opendir(path);
  try {
    for (;;) {
      const entry = fs.readdir(directory);
      if (entry === null) break;
      if (entry.name === "." || entry.name === "..") continue;
      assertRecursiveOwnership(fs, join(path, entry.name), uid, gid);
    }
  } finally {
    fs.closedir(directory);
  }
}

function assertExistingComponentsAreDirectories(
  fs: MemoryFileSystem,
  path: string,
): void {
  let current = "";
  for (const segment of path.split("/").filter(Boolean)) {
    current += `/${segment}`;
    const stat = lstatOrNull(fs, current);
    if (stat !== null && (stat.mode & S_IFMT) !== S_IFDIR) {
      fail(`Homebrew runtime-support parent ${current} is not a real directory`);
    }
  }
}

function expectedHomebrewEnvironment(arch: HomebrewBottleArch): Uint8Array {
  return textEncoder.encode(
    "HOMEBREW_NO_ANALYTICS=1\n" +
      "HOMEBREW_NO_AUTO_UPDATE=1\n" +
      "HOMEBREW_NO_INSTALL_FROM_API=1\n" +
      "HOMEBREW_AUTOMATICALLY_SET_NO_INSTALL_FROM_API=1\n" +
      "HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY=1\n" +
      `HOMEBREW_KANDELO_BOTTLE_TAG=${arch}_kandelo\n`,
  );
}

function assertSupportLimits(limits: HomebrewVfsResourcePolicy["supportZip"]): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail(`Homebrew runtime-support ${name} limit is invalid`);
    }
  }
}

function resolveRelativeWithin(
  directory: string,
  target: string,
  root: string,
): string | null {
  const segments = directory.split("/").filter(Boolean);
  const rootSegments = root.split("/").filter(Boolean);
  if (!isUnder(directory, root)) return null;
  for (const segment of target.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length <= rootSegments.length) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return `/${segments.join("/")}`;
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function readFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    const count = fs.read(fd, bytes, null, bytes.byteLength);
    if (count !== bytes.byteLength) fail(`short read from Homebrew runtime-support path ${path}`);
    return bytes;
  } finally {
    fs.close(fd);
  }
}

function lstatOrNull(fs: MemoryFileSystem, path: string) {
  try {
    return fs.lstat(path);
  } catch (error) {
    if (error instanceof SFSError && error.code === ENOENT) return null;
    throw error;
  }
}

function join(parent: string, child: string): string {
  return parent === "/" ? `/${child}` : `${parent}/${child}`;
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): never {
  throw new HomebrewRuntimeSupportMaterializationError(message);
}
