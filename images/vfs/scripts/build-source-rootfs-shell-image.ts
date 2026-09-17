/** Compose the canonical browser shell from resolver-owned package outputs. */
import { lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { ABI_VERSION, ERRNO } from "../../../host/src/generated/abi";
import { KandeloImageFs } from "../lib/kandelo-image-fs";
import {
  KANDELO_DEMO_CONFIG_PATH,
  MAX_KANDELO_DEMO_CONFIG_BYTES,
  parseKandeloDemoConfig,
  resolveDemoPresentation,
  validateKandeloDemoConfig,
  type KandeloDemoConfig,
} from "../../../web-libs/kandelo-session/src/demo-config";
import {
  EXPERIMENTAL_TERMINAL_SESSION_PATH,
  MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES,
  parseExperimentalTerminalSession,
  type ExperimentalTerminalProgram,
  type ExperimentalTerminalSession,
} from "../../../web-libs/kandelo-session/src/experimental-terminal-session";
import {
  ensureDirRecursive,
  saveImage,
  sourceDateEpochMilliseconds,
  writeVfsBinary,
} from "./vfs-image-helpers";
import { SHELL_LAZY_BINARY_SPECS } from "../lib/init/shell-binaries";
import {
  SHELL_LAZY_ARCHIVE_SPECS,
  type ShellLazyArchiveResolver,
} from "./shell-lazy-archives";
import {
  populateSourceRootfsShellOverlay,
  PACKAGE_ROOTFS_SHELL_COMPOSITION,
} from "./source-rootfs-shell-overlay";

const REGULAR_FILE_MODE = 0o100000;
const SYMBOLIC_LINK_MODE = 0o120000;
const FILE_TYPE_MASK = 0o170000;
const EXECUTE_BITS = 0o111;

export interface SourceRootfsShellInputs {
  rootfsPath: string;
  bashPath: string;
  fbdoomPath: string;
  modesetPath: string;
  demoConfigPath: string;
  demoProfileOverlayPath: string;
  outFile: string;
  resolveArtifact: ShellLazyArchiveResolver;
  sourceDateEpoch?: string;
}

const REQUIRED_BASH_ALIASES = ["/bin/bash", "/usr/bin/bash"] as const;
export const SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCIES = [
  ...readSourceRootfsShellResolverDependencies(),
] as const;
const SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCY_SET = new Set<string>(
  SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCIES,
);

interface SourceRootfsShellDependencyContract {
  schema: 1;
  dependencies: Array<{
    name: string;
    version: string;
    role: "base-image" | "eager-program" | "eager-file" | "lazy-file" | "lazy-archive";
  }>;
}

function readSourceRootfsShellResolverDependencies(
  path = fileURLToPath(
    new URL(
      "../../../packages/registry/shell/source-rootfs-shell-dependencies.json",
      import.meta.url,
    ),
  ),
): string[] {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema" in value) ||
    value.schema !== 1 ||
    !("dependencies" in value) ||
    !Array.isArray(value.dependencies)
  ) {
    throw new Error(`invalid source-rootfs shell dependency contract: ${path}`);
  }
  const contract = value as SourceRootfsShellDependencyContract;
  const dependencies = contract.dependencies
    .filter(
      ({ role }) =>
        role === "lazy-file" || role === "lazy-archive" || role === "eager-file",
    )
    .map(({ name }) => name);
  if (
    dependencies.length === 0 ||
    dependencies.some((name) => !/^[a-z0-9][a-z0-9._-]*$/.test(name)) ||
    new Set(dependencies).size !== dependencies.length
  ) {
    throw new Error(
      `source-rootfs shell resolver dependencies are invalid: ${path}`,
    );
  }
  return dependencies;
}

function readRegularInput(path: string, label: string): Uint8Array {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
  return new Uint8Array(readFileSync(path));
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} must contain valid UTF-8`, { cause: error });
  }
}

function loadDemoConfig(path: string, label: string): KandeloDemoConfig {
  const bytes = readRegularInput(path, "demo config");
  if (bytes.byteLength > MAX_KANDELO_DEMO_CONFIG_BYTES) {
    throw new Error(`${label} exceeds ${MAX_KANDELO_DEMO_CONFIG_BYTES} bytes`);
  }
  const config = parseKandeloDemoConfig(decodeUtf8(bytes, label));
  if (config === null) {
    throw new Error(`${label} has an unsupported version`);
  }
  validateKandeloDemoConfig(config);
  return config;
}

const SOURCE_ROOTFS_DEMO_COMMANDS = {
  doom: {
    executable: "/usr/local/bin/fbdoom",
    command: "/usr/local/bin/fbdoom -iwad /doom1.wad",
  },
  modeset: {
    executable: "/usr/local/bin/modeset",
    command: "/usr/local/bin/modeset",
  },
} as const;

export function composeSourceRootfsDemoConfig(
  basePath: string,
  profileOverlayPath: string,
): Uint8Array {
  const base = loadDemoConfig(basePath, "base demo config");
  const overlay = loadDemoConfig(
    profileOverlayPath,
    "source-rootfs demo profile overlay",
  );
  if (
    overlay.presentation !== undefined ||
    overlay.assets !== undefined ||
    overlay.guide !== undefined
  ) {
    throw new Error(
      "source-rootfs demo profile overlay must contain only named profiles",
    );
  }
  const baseProfiles = base.profiles ?? {};
  const overlayProfiles = overlay.profiles ?? {};
  if (Object.keys(overlayProfiles).length === 0) {
    throw new Error("source-rootfs demo profile overlay has no profiles");
  }
  const expectedProfileIds = Object.keys(SOURCE_ROOTFS_DEMO_COMMANDS).sort();
  const actualProfileIds = Object.keys(overlayProfiles).sort();
  if (
    actualProfileIds.length !== expectedProfileIds.length ||
    actualProfileIds.some(
      (profileId, index) => profileId !== expectedProfileIds[index],
    )
  ) {
    throw new Error(
      "source-rootfs demo profile overlay must contain exactly the " +
        `image-owned profiles: ${expectedProfileIds.join(", ")}`,
    );
  }
  const composedProfiles = { ...baseProfiles };
  for (const profileId of Object.keys(overlayProfiles)) {
    if (Object.hasOwn(baseProfiles, profileId)) {
      // WHY: a package-owned base may already carry these profiles. Accept
      // only an exact structural match so the overlay can neither override nor
      // silently drift from the shared product contract.
      if (
        !isDeepStrictEqual(baseProfiles[profileId], overlayProfiles[profileId])
      ) {
        throw new Error(
          `source-rootfs demo profile overlay drifts from base profile ${profileId}`,
        );
      }
      continue;
    }
    const overlayProfile = overlayProfiles[profileId];
    if (overlayProfile === undefined) {
      throw new Error(
        `source-rootfs demo profile overlay omits profile ${profileId}`,
      );
    }
    composedProfiles[profileId] = overlayProfile;
  }
  const composed: KandeloDemoConfig = {
    ...base,
    profiles: composedProfiles,
  };
  validateKandeloDemoConfig(composed);
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(composed, null, 2)}\n`,
  );
  if (bytes.byteLength > MAX_KANDELO_DEMO_CONFIG_BYTES) {
    throw new Error(
      `composed demo config exceeds ${MAX_KANDELO_DEMO_CONFIG_BYTES} bytes`,
    );
  }
  return bytes;
}

function requireOwnedDemoCommands(
  fs: KandeloImageFs,
  demoBytes: Uint8Array,
): void {
  const config = parseKandeloDemoConfig(
    decodeUtf8(demoBytes, "composed demo config"),
  );
  if (config === null) {
    throw new Error("composed demo config has an unsupported version");
  }
  for (const [profileId, expected] of Object.entries(
    SOURCE_ROOTFS_DEMO_COMMANDS,
  )) {
    const presentation = resolveDemoPresentation(config, profileId);
    if (presentation?.autoCommand !== expected.command) {
      throw new Error(
        `source-rootfs demo profile ${profileId} must launch ${expected.command}`,
      );
    }
    const stat = fs.stat(expected.executable);
    if (
      (stat.mode & FILE_TYPE_MASK) !== REGULAR_FILE_MODE ||
      (stat.mode & EXECUTE_BITS) === 0
    ) {
      throw new Error(
        `source-rootfs demo profile ${profileId} does not own executable ${expected.executable}`,
      );
    }
  }
}

function requireImageExecutable(
  fs: KandeloImageFs,
  config: ExperimentalTerminalProgram,
): void {
  const stat = (() => {
    try {
      return fs.stat(config.path);
    } catch (error) {
      throw new Error(
        `configured terminal program does not exist in the image: ${config.path}`,
        { cause: error },
      );
    }
  })();
  if ((stat.mode & FILE_TYPE_MASK) !== REGULAR_FILE_MODE) {
    throw new Error(`configured terminal program is not a regular file: ${config.path}`);
  }
  if ((stat.mode & EXECUTE_BITS) === 0) {
    throw new Error(`configured terminal program is not executable: ${config.path}`);
  }
}

function readExperimentalTerminalSession(
  fs: KandeloImageFs,
): ExperimentalTerminalSession {
  let stat;
  try {
    stat = fs.lstat(EXPERIMENTAL_TERMINAL_SESSION_PATH);
  } catch (error) {
    throw new Error(
      `source rootfs is missing ${EXPERIMENTAL_TERMINAL_SESSION_PATH}`,
      { cause: error },
    );
  }
  if ((stat.mode & FILE_TYPE_MASK) !== REGULAR_FILE_MODE) {
    throw new Error(`${EXPERIMENTAL_TERMINAL_SESSION_PATH} must be a regular file`);
  }
  if (stat.size > MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES) {
    throw new Error(
      `${EXPERIMENTAL_TERMINAL_SESSION_PATH} exceeds ` +
        `${MAX_EXPERIMENTAL_TERMINAL_SESSION_BYTES} bytes`,
    );
  }
  return parseExperimentalTerminalSession(
    decodeUtf8(
      readVfsBytes(fs, EXPERIMENTAL_TERMINAL_SESSION_PATH),
      EXPERIMENTAL_TERMINAL_SESSION_PATH,
    ),
  );
}

interface LazyIdentity {
  ino: number;
}

interface BashAliasContract {
  path: string;
  kind: "hardlink" | "symlink";
  target?: string;
}

interface SourceBashIdentity {
  identity: LazyIdentity;
  hardlinkPaths: string[];
  aliases: BashAliasContract[];
}

/**
 * Identity is the inode NUMBER alone, where it used to be the inode number and
 * a generation counter.
 *
 * The counter existed because inode numbers can be REUSED: delete a file and a
 * later one may take its number, so two different files would compare equal.
 * The module mints inode numbers from a counter that only rises and never
 * hands one back, so within a build an inode number identifies one file for
 * the whole life of the tree, and there is nothing for a generation to
 * disambiguate.
 *
 * `bigint` because the module's inode numbers are 64-bit; comparing them
 * loosely would defeat the point of comparing them at all.
 */
function sameLazyIdentity(
  entry: { ino: number | bigint },
  identity: LazyIdentity,
): boolean {
  return Number(entry.ino) === identity.ino;
}

type LazyRecords = {
  files: ReturnType<KandeloImageFs["lazyEntries"]>["files"];
  trees: ReturnType<KandeloImageFs["lazyEntries"]>["archives"];
};

function lazyRecords(
  fs: KandeloImageFs,
  omittedIdentities: readonly LazyIdentity[] = [],
): LazyRecords {
  const { files, archives } = fs.lazyEntries();
  return {
    files: files.filter(
      (entry) =>
        !omittedIdentities.some((identity) => sameLazyIdentity(entry, identity)),
    ),
    trees: archives,
  };
}

/**
 * The lazy state that must survive a SAVE.
 *
 * Inode numbers are deliberately dropped. The writer assigns them when it lays
 * out the image, so a saved copy legitimately renumbers every file -- comparing
 * them across a serialization asserts that the writer did NOT do its job. The
 * `MemoryFileSystem` this replaces carried its own inode numbers into the image
 * and back, which is why the comparison could include them before.
 *
 * What is compared is what a save must not change: WHICH paths are deferred,
 * how big each really is, which archive backs it, and the fetch description it
 * carries. A lost file, a changed size, a re-pointed archive or a dropped
 * description all still fail this.
 */
function serializedLazyState(
  fs: KandeloImageFs,
  omittedIdentities: readonly LazyIdentity[] = [],
): string {
  const { files, trees } = lazyRecords(fs, omittedIdentities);
  const withoutIno = ({ ino: _ino, ...rest }: { ino: bigint }) => rest;
  return stableJson({ files: files.map(withoutIno), trees });
}

/**
 * Render a lazy record as text for comparison.
 *
 * `JSON.stringify` THROWS on a `bigint` and renders a `Uint8Array` as an object
 * of indices, and a lazy record carries both: inode numbers are 64-bit and a
 * fetch description is bytes. The descriptor is rendered as hex because it is
 * OPAQUE -- decoding it to print something friendlier would make this
 * comparison depend on a format the kernel promises not to read.
 *
 * It is ONE function because it was briefly two: `lazyState` got the replacer
 * and `requirePreservedLazyState` kept a bare `JSON.stringify`, so the second
 * threw "Do not know how to serialize a BigInt" in a product build that the
 * test suites never reached. Two renderers of the same record could also drift
 * into disagreeing about equality, which is worse than throwing.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) =>
    typeof inner === "bigint"
      ? inner.toString()
      : inner instanceof Uint8Array
        ? Buffer.from(inner).toString("hex")
        : inner,
  );
}

/** The lazy identity at `path`, or null if `path` is not a lazy file. */
function optionalLazyIdentity(
  fs: KandeloImageFs,
  path: string,
): LazyIdentity | null {
  if (!fs.isPathDeferred(path)) return null;
  return { ino: Number(fs.lstat(path).ino) };
}

/**
 * posix-utils-lite's raw `man` applet (cats the unformatted troff source) may
 * already occupy /usr/bin/man on the imported rootfs. The mandoc lazy-archive
 * (registered by populateSourceRootfsShellOverlay) mounts a formatting `man`
 * front-end at the exact same path and is meant to win, superseding the
 * applet's lazy identity there — an intentional identity change, exactly
 * like Bash's lazy-to-eager materialization above. Verify the supersession
 * actually happened rather than silently accepting either an unrelated
 * change or no change at all.
 */
function requireManSupersededByMandoc(
  fs: KandeloImageFs,
  priorIdentity: LazyIdentity | null,
): void {
  if (priorIdentity === null) return;
  const stat = fs.lstat("/usr/bin/man");
  if ((stat.mode & FILE_TYPE_MASK) !== SYMBOLIC_LINK_MODE) {
    throw new Error(
      "/usr/bin/man must be superseded by the mandoc archive's symlink",
    );
  }
  if (sameLazyIdentity(stat, priorIdentity)) {
    throw new Error(
      "/usr/bin/man still resolves to the posix-utils-lite applet",
    );
  }
}

function requireExpectedLazyState(
  before: string,
  fs: KandeloImageFs,
  label: string,
): void {
  const after = serializedLazyState(fs);
  if (after !== before) {
    throw new Error(
      `${label} changed rootfs lazy file or tree identities\n` +
        `before=${before}\nafter=${after}`,
    );
  }
}

function requirePreservedLazyState(
  expected: LazyRecords,
  fs: KandeloImageFs,
  label: string,
): void {
  const actual = lazyRecords(fs);
  const actualFiles = new Set(actual.files.map(stableJson));
  const actualTrees = new Set(actual.trees.map(stableJson));
  for (const entry of expected.files) {
    if (!actualFiles.has(stableJson(entry))) {
      throw new Error(`${label} changed a rootfs lazy file identity`);
    }
  }
  for (const entry of expected.trees) {
    if (!actualTrees.has(stableJson(entry))) {
      throw new Error(`${label} changed a rootfs lazy tree identity`);
    }
  }
}

function requireCompleteProductShellContract(fs: KandeloImageFs): void {
  for (const spec of SHELL_LAZY_BINARY_SPECS) {
    if (!fs.isPathDeferred(spec.vfsPath)) {
      throw new Error(
        `source-rootfs shell omitted production lazy utility ${spec.vfsPath}`,
      );
    }
  }
  // Asked of the TREE rather than of a list of URLs. The contract being checked
  // is that the shipped shell can actually run each of these -- which is that
  // the member is present and still deferred, not that some table mentions a
  // URL. A URL is the archive's transport and lives in the fetch description
  // the kernel carries without reading; a rebuild that changed one would fail
  // this check while shipping exactly the right contents.
  for (const spec of SHELL_LAZY_ARCHIVE_SPECS) {
    const member = `${spec.mountPrefix}${spec.requiredMember}`;
    if (!fs.isPathDeferred(member)) {
      throw new Error(
        `source-rootfs shell omitted production lazy archive ${spec.archiveUrl}` +
          ` (${member} is not a deferred member of it)`,
      );
    }
  }
  for (const path of [
    "/etc/gitconfig",
    "/etc/profile",
    "/home/.nethack/perm",
    "/home/.nethack/record",
  ]) {
    fs.stat(path);
  }
  const playground = fs.stat("/home/.nethack");
  if (
    playground.uid !== 1000 ||
    playground.gid !== 1000 ||
    (playground.mode & 0o777) !== 0o777
  ) {
    throw new Error("source-rootfs shell lost the NetHack playground contract");
  }
}

function dependencyEnvKey(name: string): string {
  return name.replaceAll("-", "_").toUpperCase();
}

function strictResolverFromDependencyEnvironment(
  env: NodeJS.ProcessEnv,
  declaredDependencies = SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCY_SET,
): ShellLazyArchiveResolver {
  return (resolverPath, requestedDependency) => {
    const dependency =
      requestedDependency === "git-remote-http" ? "git" : requestedDependency;
    if (!declaredDependencies.has(dependency)) {
      throw new Error(
        `source-rootfs shell requested undeclared dependency ${dependency}`,
      );
    }
    const key = `WASM_POSIX_DEP_${dependencyEnvKey(dependency)}_DIR`;
    const root = env[key];
    if (!root) {
      throw new Error(`source-rootfs shell requires resolver directory ${key}`);
    }
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(
        `${key} must be a real resolver-owned directory: ${root}`,
      );
    }
    const artifact = join(root, basename(resolverPath));
    readRegularInput(artifact, `${dependency} dependency output`);
    return artifact;
  };
}

function readVfsBytes(fs: KandeloImageFs, path: string): Uint8Array {
  const size = fs.stat(path).size;
  const bytes = new Uint8Array(size);
  const fd = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(
        fd,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (count <= 0) throw new Error(`short VFS read for ${path}`);
      offset += count;
    }
  } finally {
    fs.close(fd);
  }
  return bytes;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function requireLazyBashIdentity(
  fs: KandeloImageFs,
): SourceBashIdentity {
  const bashPath = REQUIRED_BASH_ALIASES[0];
  if (!fs.stat(bashPath).deferred) {
    throw new Error(`${bashPath} must be a lazy source-rootfs entry`);
  }
  const identity = { ino: Number(fs.stat(bashPath).ino) };
  // The hardlinks are DERIVED from the tree rather than read from a list the
  // filesystem kept beside it. A hardlink is one inode reachable by several
  // paths, so the paths sharing this inode ARE the hardlinks -- and a list that
  // could disagree with the tree is a list that eventually will.
  const hardlinkPaths = fs
    .lazyEntries()
    .files.filter((entry) => Number(entry.ino) === identity.ino)
    .map((entry) => entry.path)
    .sort();
  const aliases: BashAliasContract[] = [];
  for (const alias of REQUIRED_BASH_ALIASES) {
    const linkStat = fs.lstat(alias);
    const stat = fs.stat(alias);
    // Through `stat`, not `lstat`: an alias may be a symlink, and what must
    // match is the file it RESOLVES to.
    if (Number(stat.ino) !== identity.ino || !stat.deferred) {
      throw new Error(
        `${alias} must resolve to the complete lazy Bash identity`,
      );
    }
    const fileType = linkStat.mode & FILE_TYPE_MASK;
    if (fileType === REGULAR_FILE_MODE) {
      if (!hardlinkPaths.includes(alias)) {
        throw new Error(
          `${alias} is absent from the lazy Bash hardlink ledger`,
        );
      }
      aliases.push({ path: alias, kind: "hardlink" });
    } else if (fileType === SYMBOLIC_LINK_MODE) {
      aliases.push({
        path: alias,
        kind: "symlink",
        target: fs.readlink(alias),
      });
    } else {
      throw new Error(`${alias} is neither a Bash hardlink nor symlink alias`);
    }
  }
  return { identity, hardlinkPaths, aliases };
}

function requireMaterializedBashIdentity(
  fs: KandeloImageFs,
  contract: SourceBashIdentity,
  expectedBytes: Uint8Array,
): void {
  const canonicalPath = contract.hardlinkPaths[0];
  if (canonicalPath === undefined) {
    throw new Error("source Bash identity contains no canonical hardlink");
  }
  const canonical = fs.stat(canonicalPath);
  for (const path of contract.hardlinkPaths) {
    const stat = fs.stat(path);
    if (
      stat.ino !== canonical.ino ||
      (stat.mode & FILE_TYPE_MASK) !== REGULAR_FILE_MODE ||
      (stat.mode & EXECUTE_BITS) === 0
    ) {
      throw new Error(`${path} lost the materialized Bash hardlink identity`);
    }
    if (fs.isPathDeferred(path)) {
      throw new Error(`${path} remained lazy after Bash materialization`);
    }
    if (!bytesEqual(readVfsBytes(fs, path), expectedBytes)) {
      throw new Error(`${path} differs from the resolved Bash dependency`);
    }
  }
  for (const alias of contract.aliases) {
    const linkStat = fs.lstat(alias.path);
    const expectedType =
      alias.kind === "symlink" ? SYMBOLIC_LINK_MODE : REGULAR_FILE_MODE;
    if ((linkStat.mode & FILE_TYPE_MASK) !== expectedType) {
      throw new Error(`${alias.path} changed Bash alias type`);
    }
    if (alias.kind === "symlink" && fs.readlink(alias.path) !== alias.target) {
      throw new Error(`${alias.path} changed Bash symlink target`);
    }
    const stat = fs.stat(alias.path);
    if (Number(stat.ino) !== Number(canonical.ino) || stat.deferred) {
      throw new Error(`${alias.path} does not resolve to materialized Bash`);
    }
    if (!bytesEqual(readVfsBytes(fs, alias.path), expectedBytes)) {
      throw new Error(
        `${alias.path} differs from the resolved Bash dependency`,
      );
    }
  }
}

/**
 * Compose and save one deterministic shell artifact.
 *
 * Every package byte comes from an explicit path supplied by the resolver.
 * Repository-owned JSON and TypeScript are the only other inputs; there is no
 * binary resolver, tap checkout, registry lookup, or network fallback here.
 */
export async function buildSourceRootfsShellImage(
  inputs: SourceRootfsShellInputs,
): Promise<Uint8Array> {
  const rootfs = readRegularInput(inputs.rootfsPath, "rootfs dependency");
  // READING THE METADATA LOADS THE IMAGE, and the loader refuses one that
  // declares an ABI it does not speak. So a WRONG ABI arrives here as `EPROTO`
  // rather than as a number this gate can compare, and the gate's own message
  // — which names the requirement and is the reason a build's failure is
  // actionable — would never be reached.
  //
  // The refusal is the loader's and stays the loader's; what this adds is the
  // sentence a person building an image needs. A MISSING declaration still
  // reaches the comparison below, because an image that declares no ABI makes
  // no claim for the loader to refuse.
  let sourceMetadata;
  try {
    sourceMetadata = KandeloImageFs.readImageMetadata(rootfs);
  } catch (error) {
    if ((error as { errno?: number } | null)?.errno === ERRNO.EPROTO) {
      throw new Error(
        `rootfs dependency must explicitly declare kernel ABI ${ABI_VERSION}; ` +
          `it declares a different one and this reader cannot say which — ` +
          `rebuild it`,
      );
    }
    throw error;
  }
  if (sourceMetadata?.kernelAbi !== ABI_VERSION) {
    throw new Error(
      `rootfs dependency must explicitly declare kernel ABI ${ABI_VERSION}; ` +
        `got ${String(sourceMetadata?.kernelAbi)}`,
    );
  }
  const sourceCapacity = KandeloImageFs.readImageCapacity(rootfs);
  // The load AUTHENTICATES. Verification runs inside the module's
  // `sm_load_image`, so the source image gains its authority only after its
  // activation cohorts checked out -- there is no window between importing and
  // authenticating, and no second call to forget.
  const fs = KandeloImageFs.create();
  fs.loadImage(rootfs);
  const terminalSession = readExperimentalTerminalSession(fs);
  const demo = composeSourceRootfsDemoConfig(
    inputs.demoConfigPath,
    inputs.demoProfileOverlayPath,
  );

  // WHY: the terminal document is image-owned policy. Validate its programs
  // against the unmodified source rootfs before overlays can accidentally make
  // a missing executable appear present.
  requireImageExecutable(fs, terminalSession.initial);
  if (terminalSession.afterExit !== undefined) {
    requireImageExecutable(fs, terminalSession.afterExit);
  }
  const sourceBash = requireLazyBashIdentity(fs);
  // WHY: mandoc is expected to supersede posix-utils-lite's raw `man` applet
  // at the same VFS path (see requireManSupersededByMandoc below). Capture
  // its prior identity now, alongside Bash's, so the overlay's "nothing else
  // changed" check does not flag this one intentional supersession.
  const priorManIdentity = optionalLazyIdentity(fs, "/usr/bin/man");
  const omittedLazyIdentities = [
    sourceBash.identity,
    ...(priorManIdentity ? [priorManIdentity] : []),
  ];
  const unrelatedLazyBefore = lazyRecords(fs, omittedLazyIdentities);

  const bash = readRegularInput(inputs.bashPath, "bash dependency");
  const fbdoom = readRegularInput(inputs.fbdoomPath, "fbdoom dependency");
  const modeset = readRegularInput(inputs.modesetPath, "modeset dependency");

  // WHY: Bash remains the ordinary account shell and is therefore eager after
  // login. Opening its canonical alias follows a symlink when present,
  // truncating the one lazy inode while preserving both its
  // hard-link ledger and the rootfs's symlink topology.
  writeVfsBinary(fs, REQUIRED_BASH_ALIASES[0], bash, 0o755);
  requireMaterializedBashIdentity(fs, sourceBash, bash);
  requirePreservedLazyState(unrelatedLazyBefore, fs, "Bash materialization");

  populateSourceRootfsShellOverlay(fs, inputs.resolveArtifact);
  requirePreservedLazyState(
    unrelatedLazyBefore,
    fs,
    "production shell overlay",
  );
  requireManSupersededByMandoc(fs, priorManIdentity);
  requireCompleteProductShellContract(fs);

  ensureDirRecursive(fs, "/usr/local/bin");
  writeVfsBinary(fs, "/usr/local/bin/fbdoom", fbdoom, 0o755);
  writeVfsBinary(fs, "/usr/local/bin/modeset", modeset, 0o755);
  // WHY: the package shell must not promise optional programs it does not own.
  // Bind its extra profiles to executable bytes so a metadata-only edit cannot
  // advertise a demo that boots successfully but never launches its workload.
  requireOwnedDemoCommands(fs, demo);
  ensureDirRecursive(fs, "/etc/kandelo");
  writeVfsBinary(fs, KANDELO_DEMO_CONFIG_PATH, demo, 0o644);

  // WHY: Bash is the one intentional eager identity. Every other source-rootfs
  // first-use download must retain the same path, URL, size, and tree metadata.
  const composedLazyState = serializedLazyState(fs);

  const image = await saveImage(fs, inputs.outFile, {
    expectedMaxByteLength: sourceCapacity.maxByteLength,
    metadata: {
      ...sourceMetadata,
      version: 1,
      kernelAbi: ABI_VERSION,
      createdBy: "build-source-rootfs-shell-image",
      shellComposition: PACKAGE_ROOTFS_SHELL_COMPOSITION,
    },
    normalizeTimestampsMs: sourceDateEpochMilliseconds(
      inputs.sourceDateEpoch ?? process.env.SOURCE_DATE_EPOCH,
    ),
  });

  const outputMetadata = KandeloImageFs.readImageMetadata(image);
  if (outputMetadata?.kernelAbi !== ABI_VERSION) {
    throw new Error("composed shell lost its explicit kernel ABI");
  }
  if (
    KandeloImageFs.readImageCapacity(image).maxByteLength !==
    sourceCapacity.maxByteLength
  ) {
    throw new Error("composed shell changed the rootfs capacity contract");
  }
  // A separate import boundary on purpose: the post-save assertions check the
  // bytes that were WRITTEN rather than inheriting trust from the tree that
  // wrote them. Loading them back is what authenticates their seals.
  const outputFs = KandeloImageFs.create();
  outputFs.loadImage(image);
  requireMaterializedBashIdentity(outputFs, sourceBash, bash);
  requireExpectedLazyState(
    composedLazyState,
    outputFs,
    "serialized source-rootfs shell",
  );
  requireCompleteProductShellContract(outputFs);
  readExperimentalTerminalSession(outputFs);
  return image;
}

function parseArguments(argv: readonly string[]): SourceRootfsShellInputs {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--rootfs",
    "--bash",
    "--fbdoom",
    "--modeset",
    "--demo-config",
    "--demo-profile-overlay",
    "--dependency-contract",
    "--out",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      flag === undefined ||
      !allowed.has(flag) ||
      value === undefined ||
      value.length === 0 ||
      values.has(flag)
    ) {
      throw new Error(
        "usage: build-source-rootfs-shell-image.ts " +
          "--rootfs <rootfs.vfs> --bash <bash.wasm> --fbdoom <fbdoom.wasm> " +
          "--modeset <modeset.wasm> " +
          "--demo-config <demo.json> --demo-profile-overlay <profiles.json> " +
          "--dependency-contract <dependencies.json> " +
          "--out <shell.vfs.zst>",
      );
    }
    values.set(flag, value);
  }
  if (values.size !== allowed.size) {
    throw new Error("source-rootfs shell composer is missing a required input");
  }
  return {
    rootfsPath: values.get("--rootfs")!,
    bashPath: values.get("--bash")!,
    fbdoomPath: values.get("--fbdoom")!,
    modesetPath: values.get("--modeset")!,
    demoConfigPath: values.get("--demo-config")!,
    demoProfileOverlayPath: values.get("--demo-profile-overlay")!,
    outFile: values.get("--out")!,
    resolveArtifact: strictResolverFromDependencyEnvironment(
      process.env,
      new Set(
        readSourceRootfsShellResolverDependencies(
          values.get("--dependency-contract")!,
        ),
      ),
    ),
  };
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entrypoint)).href
) {
  buildSourceRootfsShellImage(parseArguments(process.argv.slice(2))).catch(
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
