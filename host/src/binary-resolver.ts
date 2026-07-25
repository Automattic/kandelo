/**
 * Resolve a packaged artifact (Wasm executable/side module, VFS image,
 * archive, or declared runtime data file) from the repo's
 * `local-binaries/` or `binaries/` tree.
 *
 * Priority:
 *   1. `<repo>/local-binaries/<relPath>` — user-built override, unless it is
 *      a legacy fork artifact and a fresher fetched/package candidate exists.
 *   2. `<repo>/binaries/<relPath>` — populated by `scripts/fetch-binaries.sh`.
 *
 * Throws if neither exists. Callers that want to tolerate a missing binary
 * should catch and fall back themselves.
 *
 * See `docs/binary-releases.md` for the layout.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { describeWasmArtifactPolicyFailures } from "./constants";
import {
  ABI_VERSION,
  HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS,
} from "./generated/abi";
import { MemoryFileSystem } from "./vfs/memory-fs";

const EXECUTABLE_PROGRAM_REQUIRED_EXPORTS = ["__abi_version", "_start"] as const;

/**
 * Walk up from the importing file to find the repo root. Markers:
 * workspace `Cargo.toml` + `package.json`. Both are tracked at the
 * top of the tree and together are unambiguous — they distinguish
 * the repo root from any nested cargo crate or npm subpackage.
 *
 * Per-package `packages/registry/<name>/package.toml` files carry the
 * release-archive metadata directly (URL + sha256 in `[binary]` /
 * `[binary.<arch>]`); there is no central pinfile for the resolver
 * to read.
 */
let cachedRepoRoot: string | null = null;

function currentModuleDir(): string {
  if (typeof __dirname !== "undefined") return __dirname;
  return import.meta.url ? dirname(fileURLToPath(import.meta.url)) : process.cwd();
}

function isRepoRoot(dir: string): boolean {
  // Workspace Cargo.toml has a [workspace] table; nested crate
  // Cargo.tomls do not. The package identity matters too: an installed host
  // package may live below an unrelated consumer's Cargo/npm workspace, which
  // must not be mistaken for a Kandelo source checkout.
  const cargo = join(dir, "Cargo.toml");
  const packageJson = join(dir, "package.json");
  if (!existsSync(cargo) || !existsSync(packageJson)) {
    return false;
  }
  try {
    const packageIdentity = JSON.parse(readFileSync(packageJson, "utf8"));
    return /^\s*\[workspace\]/m.test(readFileSync(cargo, "utf8"))
      && packageIdentity?.name === "kandelo";
  } catch {
    return false;
  }
}

export function findRepoRoot(startFrom?: string): string {
  if (cachedRepoRoot && !startFrom) return cachedRepoRoot;
  const here = startFrom ?? currentModuleDir();
  let dir = resolve(here);
  for (let i = 0; i < 20; i++) {
    if (isRepoRoot(dir)) {
      if (!startFrom) cachedRepoRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not find repo root (expected workspace Cargo.toml + package.json)"
  );
}

function resolverRepoRoot(): string {
  const explicitStart = process.env.WASM_POSIX_BINARY_RESOLVER_REPO_ROOT;
  return explicitStart ? findRepoRoot(explicitStart) : findRepoRoot();
}

function packageRoot(): string {
  return resolve(currentModuleDir(), "..");
}

function hasSourceCheckout(): boolean {
  try {
    resolverRepoRoot();
    return true;
  } catch {
    return false;
  }
}

/**
 * Cache root used by xtask for immutable package generations.
 *
 * `WASM_POSIX_BINARY_CACHE_ROOT` is the explicit cross-language override. It
 * is required when an `archive-stage --cache-root` invocation also publishes
 * symlinks into a binaries mirror that will be consumed in another process.
 */
export function binaryCacheRoot(): string {
  const explicitCacheRoot = process.env.WASM_POSIX_BINARY_CACHE_ROOT;
  if (explicitCacheRoot !== undefined) {
    return isAbsolute(explicitCacheRoot)
      ? resolve(explicitCacheRoot)
      : resolve(resolverRepoRoot(), explicitCacheRoot);
  }
  const xdgCacheHome = process.env.XDG_CACHE_HOME;
  if (xdgCacheHome !== undefined) {
    return resolve(xdgCacheHome, "kandelo");
  }
  const home = process.env.HOME;
  if (home !== undefined) {
    return resolve(home, ".cache", "kandelo");
  }
  return "/tmp/kandelo";
}

/** Only program generations are valid external targets for browser assets. */
export function binaryProgramCacheRoot(): string {
  return join(binaryCacheRoot(), "programs");
}

/**
 * Resolver paths are a portable, slash-separated namespace, not host paths.
 * Reject aliases instead of normalizing them: closure discovery and tier
 * lookup must receive exactly the same spelling or a path such as `pkg/../pkg`
 * could bypass package-level identity checks before `node:path.join` collapses
 * it back onto a declared member.
 */
function requirePortableResolverPath(relPath: string): string {
  if (
    relPath.length === 0
    || relPath.startsWith("/")
    || /^[A-Za-z]:/.test(relPath)
    || relPath.includes("\\")
    || relPath.includes("\0")
    || relPath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(
      `Binary resolver path must be a normalized portable relative path: ${JSON.stringify(relPath)}`,
    );
  }
  return relPath;
}

/**
 * Resolve an artifact relative to the binaries tree.
 *
 * Example paths:
 *   `kernel.wasm`
 *   `userspace.wasm`
 *   `programs/vim.zip`               (implicit wasm32 — see below)
 *   `programs/git/git.wasm`          (implicit wasm32)
 *   `programs/php/icu.dat`           (implicit wasm32 runtime file)
 *   `programs/wasm64/mariadb-vfs.vfs.zst` (explicit arch)
 *
 * Per-arch layout: `binaries/programs/` and `local-binaries/programs/`
 * are split into `wasm32/` and `wasm64/` subtrees so multi-arch
 * programs (e.g. mariadb-vfs) can coexist without last-write-wins.
 * For backward compatibility, callers passing `programs/<x>` without
 * an explicit arch segment are routed to `programs/wasm32/<x>` —
 * almost every host-side caller runs wasm32 user programs against a
 * wasm64 kernel, so wasm32 is the right default. Callers that need
 * the wasm64 build pass `programs/wasm64/<x>` explicitly.
 */
const ARCH_SEGMENTS = new Set(["wasm32", "wasm64"]);

function applyDefaultArch(relPath: string): string {
  requirePortableResolverPath(relPath);
  if (!relPath.startsWith("programs/")) return relPath;
  const tail = relPath.slice("programs/".length);
  const firstSeg = tail.split("/", 1)[0];
  if (ARCH_SEGMENTS.has(firstSeg)) return relPath;
  return `programs/wasm32/${tail}`;
}

function packagedBinaryCandidates(
  relPath: string,
  root = join(packageRoot(), "wasm"),
): string[] {
  const adjusted = applyDefaultArch(relPath);
  const candidates = [join(root, adjusted)];
  if (relPath === "kernel.wasm") {
    candidates.push(join(root, "kandelo-kernel.wasm"));
  } else if (relPath === "userspace.wasm") {
    candidates.push(join(root, "wasm_posix_userspace.wasm"));
  } else if (relPath === "rootfs.vfs") {
    candidates.push(join(root, "rootfs.vfs"));
  }
  return candidates;
}

interface BinaryCandidateTier {
  label: string;
  root: string;
  identity: "local-generation" | "program-cache" | "installed-package";
  /**
   * A genuine installed npm package is one versioned installation identity.
   * A source checkout's host/wasm tree is mutable and never qualifies.
   */
  allowRegularFileClosure: boolean;
  candidatesFor(relPath: string): string[];
}

/** A genuine absence, as distinct from present-but-invalid package state. */
export class BinaryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryNotFoundError";
  }
}

/**
 * Ordered provenance roots used by both single-artifact and package-closure
 * resolution. Keeping the grouping explicit lets a closure fall back as a
 * unit without ever combining local, fetched, and installed-package bytes.
 */
function binaryCandidateTiers(): BinaryCandidateTier[] {
  const tiers: BinaryCandidateTier[] = [];
  let sourceCheckout = false;
  try {
    const repo = resolverRepoRoot();
    sourceCheckout = true;
    for (const [label, root] of [
      ["local-binaries", join(repo, "local-binaries")],
      ["binaries", join(repo, "binaries")],
    ] as const) {
      tiers.push({
        label,
        root,
        identity: label === "local-binaries"
          ? "local-generation"
          : "program-cache",
        allowRegularFileClosure: false,
        candidatesFor(relPath: string): string[] {
          return [join(root, applyDefaultArch(relPath))];
        },
      });
    }
  } catch {
    // Installed npm consumers do not carry a source repo root.
  }

  const root = join(packageRoot(), "wasm");
  tiers.push({
    label: "installed package",
    root,
    identity: "installed-package",
    allowRegularFileClosure: !sourceCheckout,
    candidatesFor(relPath: string): string[] {
      return packagedBinaryCandidates(relPath, root);
    },
  });
  return tiers;
}

interface ProgramPackageClosureMember {
  packageName: string;
  relPath: string;
  sourceArtifact: string;
  cacheKey: string;
  forkInstrumentation: "auto" | "disabled" | null;
  projectionIdentity: string;
}

interface ProgramPackageClosure {
  manifestPath: string;
  packageName: string;
  members: ProgramPackageClosureMember[];
}

function manifestError(manifestPath: string, detail: string): Error {
  return new Error(`Invalid package manifest ${manifestPath}: ${detail}`);
}

/** Presence check that does not turn a dangling symlink into absence. */
function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) return false;
    throw error;
  }
}

function portableArtifactPath(
  value: string,
  manifestPath: string,
  field: string,
): string {
  if (
    value.length === 0
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("\0")
    || value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw manifestError(
      manifestPath,
      `${field} must be a normalized portable relative path`,
    );
  }
  return value;
}

function safeSinglePathComponent(
  value: string,
  manifestPath: string,
  field: string,
  allowAt = true,
): string {
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value.includes("\0")
    || (!allowAt && value.includes("@"))
  ) {
    throw manifestError(
      manifestPath,
      `${field} must be a safe single path component`,
    );
  }
  return value;
}

interface LegacyFlatOutputOwner {
  scalarOwners: Set<string>;
  packagePaths: Map<string, string>;
  shadowedOwners: Set<string>;
}

interface ProgramRegistryIndex {
  legacyFlatOutputs: Map<string, LegacyFlatOutputOwner>;
  forkInstrumentationDisabledOutputs: Map<string, string>;
  identities: Map<string, SelectedPackageProjectionIdentity>;
  unidentifiedPackages: Map<string, string>;
  packages: Map<string, SelectedProgramPackageProjection>;
  unprojectedPackages: Map<string, string>;
}

interface ProgramPackageProjectionMember {
  kind: "output" | "runtime-file";
  sourceArtifact: string;
  mirrorPath: string;
  outputName?: string;
  forkInstrumentation?: "auto" | "disabled";
  guestPath?: string;
  mode?: number;
}

interface ProgramPackageProjection {
  manifestSha256: string;
  arches: string[];
  cacheKeys: Record<string, string>;
  dependencyClosures: Record<string, ProgramDependencyIdentity[]>;
  members: ProgramPackageProjectionMember[];
}

interface ProgramDependencyIdentity {
  packageName: string;
  manifestSha256: string;
  cacheKey: string;
}

interface PackageProjectionIdentity {
  manifestSha256: string;
  cacheKeys: Record<string, string>;
}

interface SelectedPackageProjectionIdentity extends PackageProjectionIdentity {
  packageName: string;
  policyPath: string;
  manifestPath?: string;
}

interface SelectedProgramPackageProjection extends ProgramPackageProjection {
  packageName: string;
  policyPath: string;
  manifestPath?: string;
}

interface LoadedProgramPackageProjection {
  identities: Map<string, PackageProjectionIdentity>;
  packages: Map<string, ProgramPackageProjection>;
  indexPath: string;
}

interface PhysicalProgramProjectionClaim {
  packageName: string;
  projection: ProgramPackageProjection;
  selected: boolean;
}

interface SelectedProgramPackageState {
  identities: Map<string, SelectedPackageProjectionIdentity>;
  unidentifiedPackages: Map<string, string>;
  packages: Map<string, SelectedProgramPackageProjection>;
  unprojectedPackages: Map<string, string>;
  physicalProgramClaims: PhysicalProgramProjectionClaim[];
}

const PROGRAM_PACKAGE_INDEX_FORMAT = "kandelo-program-packages-v2";
const PROGRAM_PACKAGE_INDEX_FILE = "program-packages.json";

type ProgramIndexContextChecker = (
  sourceRepoRoot: string,
  registryRoots: readonly string[],
) => void;

let programIndexContextCheckerForTests: ProgramIndexContextChecker | null = null;
let preparedProgramIndexChecker:
  | { sourceRepoRoot: string; xtaskPath: string }
  | null = null;
let programIndexFreshnessBoundaryDepth = 0;

/**
 * @internal Compatibility hook for test fixtures.
 *
 * Registry policy is deliberately uncached. Package directories and generated
 * projections can change while Vite or a long-lived Node process is running;
 * stale negative cache entries would let a newly package-owned nested path
 * fall through to scalar resolution.
 */
export function resetBinaryResolverManifestCacheForTests(): void {
  // No-op by design.
}

/**
 * @internal Test-only substitution for the Rust source-freshness boundary.
 *
 * Tests that author deliberately synthetic projections can replace the
 * external process while still asserting when and with which ordered roots
 * the boundary runs. Production callers always execute xtask's canonical
 * manifest/cache-key implementation.
 */
export function setProgramIndexContextCheckerForTests(
  checker: ProgramIndexContextChecker | null,
): void {
  programIndexContextCheckerForTests = checker;
}

function configuredProgramRegistryRoots(): string[] | null {
  if (Object.prototype.hasOwnProperty.call(
    process.env,
    "WASM_POSIX_DEPS_REGISTRY",
  )) {
    let sourceRepoRoot: string | null = null;
    return (process.env.WASM_POSIX_DEPS_REGISTRY ?? "")
      .split(":")
      .filter(Boolean)
      .map((entry) => {
        if (entry.startsWith("~/") && process.env.HOME !== undefined) {
          return join(process.env.HOME, entry.slice(2));
        }
        if (isAbsolute(entry)) return resolve(entry);
        sourceRepoRoot ??= resolverRepoRoot();
        return resolve(sourceRepoRoot, entry);
      });
  }
  try {
    return [join(resolverRepoRoot(), "packages", "registry")];
  } catch {
    return null;
  }
}

function completeSourceCheckoutRoot(): string | null {
  let sourceRepoRoot: string;
  try {
    sourceRepoRoot = resolverRepoRoot();
  } catch {
    return null;
  }
  if (
    !existsSync(join(sourceRepoRoot, "tools", "xtask", "Cargo.toml"))
    || !existsSync(join(sourceRepoRoot, "scripts", "dev-shell.sh"))
  ) return null;

  // An installed npm package can live below node_modules in an unrelated
  // Kandelo source checkout. Only source-owned module locations may execute
  // that checkout's policy checker: host/ for the shared TypeScript module,
  // and scripts/ for the generated standalone resolver bundle.
  try {
    const sourceModuleDir = realpathSync(currentModuleDir());
    const realRepoRoot = realpathSync(sourceRepoRoot);
    const sourceOwned = [
      join(realRepoRoot, "host"),
      join(realRepoRoot, "scripts"),
    ].some((ownedRoot) => {
      return existsSync(ownedRoot)
        && pathIsWithin(realpathSync(ownedRoot), sourceModuleDir)
    });
    return sourceOwned ? realRepoRoot : null;
  } catch {
    return null;
  }
}

function commandFailure(
  command: string,
  args: readonly string[],
  result: ReturnType<typeof spawnSync>,
): string {
  const detail = [
    typeof result.stderr === "string" ? result.stderr.trim() : "",
    typeof result.stdout === "string" ? result.stdout.trim() : "",
    result.error?.message ?? "",
  ].filter(Boolean).join("\n");
  return `${command} ${args.join(" ")} failed${
    result.status === null ? "" : ` with status ${result.status}`
  }${detail ? `:\n${detail}` : ""}`;
}

function rustHostTarget(sourceRepoRoot: string): string {
  const inDevShell = process.env.KANDELO_DEV_SHELL_TOOL_PATH !== undefined;
  const command = inDevShell ? "rustc" : "bash";
  const args = inDevShell
    ? ["-vV"]
    : [join(sourceRepoRoot, "scripts", "dev-shell.sh"), "rustc", "-vV"];
  const result = spawnSync(command, args, {
    cwd: sourceRepoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(commandFailure(command, args, result));
  }
  const host = result.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("host: "))
    ?.slice("host: ".length)
    .trim();
  if (!host) {
    throw new Error(
      `Could not determine the Rust host target for ${sourceRepoRoot}`,
    );
  }
  return host;
}

function requireRegularXtask(path: string): string {
  try {
    if (lstatSync(path).isFile()) return realpathSync(path);
  } catch {
    // The caller below reports the complete preparation failure.
  }
  throw new Error(`Prepared xtask is not a regular file: ${path}`);
}

function prepareProgramIndexChecker(sourceRepoRoot: string): string {
  const explicit = process.env.WASM_POSIX_XTASK_BIN;
  if (explicit !== undefined) {
    const explicitPath = isAbsolute(explicit)
      ? resolve(explicit)
      : resolve(sourceRepoRoot, explicit);
    return requireRegularXtask(explicitPath);
  }
  if (preparedProgramIndexChecker?.sourceRepoRoot === sourceRepoRoot) {
    return requireRegularXtask(preparedProgramIndexChecker.xtaskPath);
  }

  const host = rustHostTarget(sourceRepoRoot);
  const xtaskPath = join(
    sourceRepoRoot,
    "target",
    host,
    "release",
    process.platform === "win32" ? "xtask.exe" : "xtask",
  );
  // A path left by an earlier checkout state is not evidence that it contains
  // the current checker. Cargo's incremental no-op is the preparation
  // contract; pay it once per long-lived resolver process, then execute the
  // resulting binary at every public source-policy boundary.
  const cargoArgs = [
    "build",
    "--release",
    "-p",
    "xtask",
    "--target",
    host,
    "--quiet",
  ];
  const inDevShell = process.env.KANDELO_DEV_SHELL_TOOL_PATH !== undefined;
  const command = inDevShell ? "cargo" : "bash";
  const args = inDevShell
    ? cargoArgs
    : [join(sourceRepoRoot, "scripts", "dev-shell.sh"), "cargo", ...cargoArgs];
  const result = spawnSync(command, args, {
    cwd: sourceRepoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(commandFailure(command, args, result));
  }
  preparedProgramIndexChecker = {
    sourceRepoRoot,
    xtaskPath: requireRegularXtask(xtaskPath),
  };
  return preparedProgramIndexChecker.xtaskPath;
}

function checkProgramIndexesInSourceContext(): void {
  const sourceRepoRoot = completeSourceCheckoutRoot();
  if (sourceRepoRoot === null) return;
  const registryRoots = configuredProgramRegistryRoots();
  if (registryRoots === null) return;
  if (programIndexContextCheckerForTests) {
    programIndexContextCheckerForTests(sourceRepoRoot, registryRoots);
    return;
  }

  const xtaskPath = prepareProgramIndexChecker(sourceRepoRoot);
  // WHY: a relocated, sealed xtask still contains the checkout path where it
  // was compiled. Carry the already-authenticated source root in argv so every
  // package identity input comes from this protected source projection, not
  // from compile-time or caller-controlled ambient state.
  const args = [
    "build-deps",
    "program-index-context-check",
    "--source-repo-root",
    sourceRepoRoot,
  ];
  const result = spawnSync(xtaskPath, args, {
    cwd: sourceRepoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      WASM_POSIX_DEPS_REGISTRY: registryRoots.join(":"),
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `Program package source projection is not current:\n${
        commandFailure(xtaskPath, args, result)
      }`,
    );
  }
}

function withFreshProgramIndexes<T>(
  relPaths: readonly string[],
  operation: () => T,
): T {
  if (
    programIndexFreshnessBoundaryDepth > 0
    || !relPaths.some((relPath) => relPath.startsWith("programs/"))
  ) {
    return operation();
  }
  programIndexFreshnessBoundaryDepth += 1;
  try {
    checkProgramIndexesInSourceContext();
    return operation();
  } finally {
    programIndexFreshnessBoundaryDepth -= 1;
  }
}

function hasExactObjectKeys(
  value: object,
  expectedKeys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function readProgramPackageProjection(
  indexPath: string,
): LoadedProgramPackageProjection {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(indexPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Invalid program package index ${indexPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    typeof raw !== "object"
    || raw === null
    || !hasExactObjectKeys(raw, ["format", "identities", "packages"])
    || (raw as { format?: unknown }).format !== PROGRAM_PACKAGE_INDEX_FORMAT
    || typeof (raw as { identities?: unknown }).identities !== "object"
    || (raw as { identities?: unknown }).identities === null
    || Array.isArray((raw as { identities?: unknown }).identities)
    || typeof (raw as { packages?: unknown }).packages !== "object"
    || (raw as { packages?: unknown }).packages === null
    || Array.isArray((raw as { packages?: unknown }).packages)
  ) {
    throw new Error(
      `Invalid program package index ${indexPath}: expected ${PROGRAM_PACKAGE_INDEX_FORMAT}`,
    );
  }

  const identities = new Map<string, PackageProjectionIdentity>();
  const rawIdentities = (raw as {
    identities: Record<string, unknown>;
  }).identities;
  for (const [packageName, rawIdentity] of Object.entries(rawIdentities)) {
    safeSinglePathComponent(packageName, indexPath, "identity package name", false);
    if (
      typeof rawIdentity !== "object"
      || rawIdentity === null
      || !hasExactObjectKeys(rawIdentity, ["manifestSha256", "cacheKeys"])
      || typeof (rawIdentity as { manifestSha256?: unknown }).manifestSha256
        !== "string"
      || !/^[a-f0-9]{64}$/.test(
        (rawIdentity as { manifestSha256: string }).manifestSha256,
      )
      || typeof (rawIdentity as { cacheKeys?: unknown }).cacheKeys !== "object"
      || (rawIdentity as { cacheKeys?: unknown }).cacheKeys === null
      || Array.isArray((rawIdentity as { cacheKeys?: unknown }).cacheKeys)
    ) {
      throw new Error(
        `Invalid program package index ${indexPath}: malformed identity ${JSON.stringify(packageName)}`,
      );
    }
    const cacheKeys = (rawIdentity as {
      cacheKeys: Record<string, unknown>;
    }).cacheKeys;
    if (
      !hasExactObjectKeys(cacheKeys, ["wasm32", "wasm64"])
      || Object.values(cacheKeys).some(
        (cacheKey) =>
          typeof cacheKey !== "string" || !/^[a-f0-9]{64}$/.test(cacheKey),
      )
    ) {
      throw new Error(
        `Invalid program package index ${indexPath}: identity ${JSON.stringify(packageName)} has invalid contextual cache keys`,
      );
    }
    identities.set(packageName, {
      manifestSha256: (rawIdentity as { manifestSha256: string }).manifestSha256,
      cacheKeys: cacheKeys as Record<string, string>,
    });
  }

  const packages = new Map<string, ProgramPackageProjection>();
  const rawPackages = (raw as { packages: Record<string, unknown> }).packages;
  for (const [packageName, rawPackage] of Object.entries(rawPackages)) {
    safeSinglePathComponent(packageName, indexPath, "package name", false);
    if (
      typeof rawPackage !== "object"
      || rawPackage === null
      || !hasExactObjectKeys(rawPackage, [
        "manifestSha256",
        "arches",
        "cacheKeys",
        "dependencyClosures",
        "members",
      ])
      || !Array.isArray((rawPackage as { arches?: unknown }).arches)
      || typeof (rawPackage as { cacheKeys?: unknown }).cacheKeys !== "object"
      || (rawPackage as { cacheKeys?: unknown }).cacheKeys === null
      || Array.isArray((rawPackage as { cacheKeys?: unknown }).cacheKeys)
      || typeof (rawPackage as { dependencyClosures?: unknown })
        .dependencyClosures !== "object"
      || (rawPackage as { dependencyClosures?: unknown })
        .dependencyClosures === null
      || Array.isArray(
        (rawPackage as { dependencyClosures?: unknown }).dependencyClosures,
      )
      || !Array.isArray((rawPackage as { members?: unknown }).members)
      || typeof (rawPackage as { manifestSha256?: unknown }).manifestSha256
        !== "string"
      || !/^[a-f0-9]{64}$/.test(
        (rawPackage as { manifestSha256: string }).manifestSha256,
      )
    ) {
      throw new Error(
        `Invalid program package index ${indexPath}: malformed package ${JSON.stringify(packageName)}`,
      );
    }
    const arches = (rawPackage as { arches: unknown[] }).arches;
    if (
      arches.length === 0
      || new Set(arches).size !== arches.length
      || arches.some((arch) => typeof arch !== "string" || !ARCH_SEGMENTS.has(arch))
    ) {
      throw new Error(
        `Invalid program package index ${indexPath}: package ${JSON.stringify(packageName)} has invalid arches`,
      );
    }
    const cacheKeys = (rawPackage as {
      cacheKeys: Record<string, unknown>;
    }).cacheKeys;
    if (
      !hasExactObjectKeys(cacheKeys, arches as string[])
      || Object.values(cacheKeys).some(
        (cacheKey) =>
          typeof cacheKey !== "string" || !/^[a-f0-9]{64}$/.test(cacheKey),
      )
    ) {
      throw new Error(
        `Invalid program package index ${indexPath}: package ${JSON.stringify(packageName)} has invalid cache keys`,
      );
    }
    const dependencyClosures = (rawPackage as {
      dependencyClosures: Record<string, unknown>;
    }).dependencyClosures;
    if (!hasExactObjectKeys(dependencyClosures, arches as string[])) {
      throw new Error(
        `Invalid program package index ${indexPath}: package ${JSON.stringify(packageName)} has invalid dependency closure arches`,
      );
    }
    const parsedDependencyClosures: Record<string, ProgramDependencyIdentity[]> =
      {};
    for (const arch of arches as string[]) {
      const rawClosure = dependencyClosures[arch];
      if (!Array.isArray(rawClosure)) {
        throw new Error(
          `Invalid program package index ${indexPath}: package ${JSON.stringify(packageName)} has a malformed dependency closure for ${arch}`,
        );
      }
      // Dependency order is deliberately non-semantic. Rust emits a stable
      // order for reproducible checked-in JSON, while consumers require and
      // compare a unique package-identity set.
      const seenDependencies = new Set<string>();
      parsedDependencyClosures[arch] = rawClosure.map(
        (rawDependency, dependencyIndex): ProgramDependencyIdentity => {
          if (
            typeof rawDependency !== "object"
            || rawDependency === null
            || !hasExactObjectKeys(rawDependency, [
              "packageName",
              "manifestSha256",
              "cacheKey",
            ])
            || typeof (rawDependency as { packageName?: unknown }).packageName
              !== "string"
            || typeof (rawDependency as { manifestSha256?: unknown })
              .manifestSha256 !== "string"
            || !/^[a-f0-9]{64}$/.test(
              (rawDependency as { manifestSha256: string }).manifestSha256,
            )
            || typeof (rawDependency as { cacheKey?: unknown }).cacheKey
              !== "string"
            || !/^[a-f0-9]{64}$/.test(
              (rawDependency as { cacheKey: string }).cacheKey,
            )
          ) {
            throw new Error(
              `Invalid program package index ${indexPath}: package ${JSON.stringify(packageName)} dependency ${dependencyIndex + 1} for ${arch} is malformed`,
            );
          }
          const dependency = rawDependency as unknown as ProgramDependencyIdentity;
          safeSinglePathComponent(
            dependency.packageName,
            indexPath,
            `${packageName} dependency packageName`,
            false,
          );
          if (
            dependency.packageName === packageName
            || seenDependencies.has(dependency.packageName)
          ) {
            throw new Error(
              `Invalid program package index ${indexPath}: package ${JSON.stringify(packageName)} dependency closure for ${arch} must contain unique dependencies other than itself`,
            );
          }
          seenDependencies.add(dependency.packageName);
          const contextualIdentity = identities.get(dependency.packageName);
          if (
            !contextualIdentity
            || contextualIdentity.manifestSha256
              !== dependency.manifestSha256
            || contextualIdentity.cacheKeys[arch] !== dependency.cacheKey
          ) {
            throw new Error(
              `Invalid program package index ${indexPath}: package ${JSON.stringify(packageName)} dependency ${JSON.stringify(dependency.packageName)} for ${arch} does not match the index's authoritative contextual identity`,
            );
          }
          return dependency;
        },
      );
    }
    const members = (rawPackage as { members: unknown[] }).members.map(
      (rawMember, memberIndex): ProgramPackageProjectionMember => {
        if (
          typeof rawMember !== "object"
          || rawMember === null
          || (
            (rawMember as { kind?: unknown }).kind !== "output"
            && (rawMember as { kind?: unknown }).kind !== "runtime-file"
          )
          || typeof (rawMember as { sourceArtifact?: unknown }).sourceArtifact
            !== "string"
          || typeof (rawMember as { mirrorPath?: unknown }).mirrorPath !== "string"
        ) {
          throw new Error(
            `Invalid program package index ${indexPath}: package ${JSON.stringify(packageName)} member ${memberIndex + 1} is malformed`,
          );
        }
        const member = rawMember as Record<string, unknown>;
        const expectedMemberKeys = member.kind === "output"
          ? [
            "kind",
            "sourceArtifact",
            "mirrorPath",
            "outputName",
            "forkInstrumentation",
          ]
          : [
            "kind",
            "sourceArtifact",
            "mirrorPath",
            "guestPath",
            "mode",
          ];
        if (!hasExactObjectKeys(member, expectedMemberKeys)) {
          throw new Error(
            `Invalid program package index ${indexPath}: package ${JSON.stringify(packageName)} member ${memberIndex + 1} has unknown or missing fields`,
          );
        }
        portableArtifactPath(
          member.sourceArtifact as string,
          indexPath,
          `${packageName} sourceArtifact`,
        );
        portableArtifactPath(
          member.mirrorPath as string,
          indexPath,
          `${packageName} mirrorPath`,
        );
        if (member.kind === "output") {
          if (
            typeof member.outputName !== "string"
            || (
              member.forkInstrumentation !== "auto"
              && member.forkInstrumentation !== "disabled"
            )
          ) {
            throw new Error(
              `Invalid program package index ${indexPath}: package ${JSON.stringify(packageName)} output member lacks outputName or forkInstrumentation`,
            );
          }
          safeSinglePathComponent(
            member.outputName,
            indexPath,
            `${packageName} outputName`,
          );
        } else if (
          typeof member.guestPath !== "string"
          || !member.guestPath.startsWith("/")
          || !Number.isInteger(member.mode)
          || (member.mode as number) < 0
          || (member.mode as number) > 0o777
        ) {
          throw new Error(
            `Invalid program package index ${indexPath}: package ${JSON.stringify(packageName)} runtime member lacks valid guestPath or mode`,
          );
        }
        return member as unknown as ProgramPackageProjectionMember;
      },
    );
    if (
      members.length === 0
      || new Set(members.map((member) => member.sourceArtifact)).size
        !== members.length
      || new Set(members.map((member) => member.mirrorPath)).size
        !== members.length
      || (
        members.length === 1
        && members[0]!.mirrorPath.includes("/")
      )
      || (
        members.length > 1
        && members.some(
          (member) => !member.mirrorPath.startsWith(`${packageName}/`),
        )
      )
    ) {
      throw new Error(
        `Invalid program package index ${indexPath}: package ${JSON.stringify(packageName)} members are empty, collide, or violate scalar/package-directory layout`,
      );
    }
    const manifestSha256 =
      (rawPackage as { manifestSha256: string }).manifestSha256;
    const identity = identities.get(packageName);
    if (
      !identity
      || identity.manifestSha256 !== manifestSha256
      || (arches as string[]).some(
        (arch) => identity.cacheKeys[arch] !== cacheKeys[arch],
      )
    ) {
      throw new Error(
        `Invalid program package index ${indexPath}: package ${JSON.stringify(packageName)} does not match its contextual package identity`,
      );
    }
    packages.set(packageName, {
      manifestSha256,
      arches: arches as string[],
      cacheKeys: cacheKeys as Record<string, string>,
      dependencyClosures: parsedDependencyClosures,
      members,
    });
  }
  return { identities, packages, indexPath };
}

function programPackageProjectionIdentity(
  projection: ProgramPackageProjection,
): string {
  return JSON.stringify({
    manifestSha256: projection.manifestSha256,
    arches: projection.arches,
    cacheKeys: Object.fromEntries(
      projection.arches.map((arch) => [arch, projection.cacheKeys[arch]]),
    ),
    dependencyClosures: Object.fromEntries(
      projection.arches.map((arch) => [
        arch,
        [...projection.dependencyClosures[arch]!].sort((left, right) =>
          left.packageName < right.packageName
            ? -1
            : left.packageName > right.packageName
            ? 1
            : 0
        ),
      ]),
    ),
    members: projection.members.map((member) =>
      member.kind === "output"
        ? {
          kind: member.kind,
          sourceArtifact: member.sourceArtifact,
          mirrorPath: member.mirrorPath,
          outputName: member.outputName,
          forkInstrumentation: member.forkInstrumentation,
        }
        : {
          kind: member.kind,
          sourceArtifact: member.sourceArtifact,
          mirrorPath: member.mirrorPath,
          guestPath: member.guestPath,
          mode: member.mode,
        }
    ),
  });
}

function bundledProgramPackageProjection(): LoadedProgramPackageProjection | null {
  const indexPath = join(packageRoot(), "wasm", PROGRAM_PACKAGE_INDEX_FILE);
  return pathEntryExists(indexPath)
    ? readProgramPackageProjection(indexPath)
    : null;
}

/**
 * An explicit registry remains the authored policy source. The projection
 * shipped beside installed bytes is independent identity evidence, but its
 * namespaces must not fall through to generic scalar lookup merely because a
 * custom registry omitted them.
 */
function bundledProgramClaimForPath(adjusted: string): string | null {
  const loaded = bundledProgramPackageProjection();
  if (!loaded) return null;
  const components = adjusted.split("/");
  if (
    components[0] !== "programs"
    || !ARCH_SEGMENTS.has(components[1]!)
  ) return null;
  const arch = components[1]!;
  if (components.length >= 4) {
    const packageName = components[2]!;
    const projection = loaded.packages.get(packageName);
    return projection?.arches.includes(arch) ? packageName : null;
  }
  if (components.length !== 3) return null;
  const flatName = components[2]!;
  for (const [packageName, projection] of loaded.packages) {
    if (
      projection.arches.includes(arch)
      && projection.members.some(
        (member) =>
          member.kind === "output"
          && member.mirrorPath.split("/").at(-1) === flatName,
      )
    ) return packageName;
  }
  return null;
}

function rejectUnselectedBundledProgramClaim(adjusted: string): void {
  const packageName = bundledProgramClaimForPath(adjusted);
  if (packageName) {
    throw new Error(
      `Installed package resolver path ${JSON.stringify(adjusted)} is owned by ` +
        `${JSON.stringify(packageName)}, but that package is not selected by ` +
        `the configured program registry`,
    );
  }
}

function selectedProgramPackageState(): SelectedProgramPackageState {
  const roots = configuredProgramRegistryRoots();
  const identities = new Map<string, SelectedPackageProjectionIdentity>();
  const unidentifiedPackages = new Map<string, string>();
  const packages = new Map<string, SelectedProgramPackageProjection>();
  const unprojectedPackages = new Map<string, string>();
  const physicalProgramClaims: PhysicalProgramProjectionClaim[] = [];

  if (roots === null) {
    const indexPath = join(packageRoot(), "wasm", PROGRAM_PACKAGE_INDEX_FILE);
    if (!pathEntryExists(indexPath)) {
      return {
        identities,
        unidentifiedPackages,
        packages,
        unprojectedPackages,
        physicalProgramClaims,
      };
    }
    const loaded = readProgramPackageProjection(indexPath);
    for (const [packageName, identity] of loaded.identities) {
      identities.set(packageName, {
        ...identity,
        packageName,
        policyPath: `${loaded.indexPath}#identities.${packageName}`,
      });
    }
    for (const [packageName, projection] of loaded.packages) {
      physicalProgramClaims.push({
        packageName,
        projection,
        selected: true,
      });
      packages.set(packageName, {
        ...projection,
        packageName,
        policyPath: `${loaded.indexPath}#${packageName}`,
      });
    }
    return {
      identities,
      unidentifiedPackages,
      packages,
      unprojectedPackages,
      physicalProgramClaims,
    };
  }

  const claimed = new Set<string>();
  let authoritativeIdentities:
    | Map<string, PackageProjectionIdentity>
    | null = null;
  let authoritativePackages:
    | Map<string, ProgramPackageProjection>
    | null = null;
  for (const root of roots) {
    if (!pathEntryExists(root)) continue;
    if (!statSync(root).isDirectory()) {
      throw new Error(`Program registry root is not a directory: ${root}`);
    }
    const indexPath = join(root, PROGRAM_PACKAGE_INDEX_FILE);
    if (!pathEntryExists(indexPath)) {
      throw new Error(
        `Program registry ${root} is missing ${PROGRAM_PACKAGE_INDEX_FILE}; generate it with xtask build-deps program-index`,
      );
    }
    const loaded = readProgramPackageProjection(indexPath);
    // The highest-priority existing root was generated against the complete
    // ordered registry path. It owns both contextual identities and program
    // projections for every first-hit package, including lower-root programs
    // rekeyed by a dependency-only override. Lower indexes retain suffix-
    // context projections as fallbacks and namespace evidence only.
    authoritativeIdentities ??= loaded.identities;
    authoritativePackages ??= loaded.packages;
    const entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const packageName = entry.name;
      const manifestPath = join(root, packageName, "package.toml");
      if (!pathEntryExists(manifestPath)) continue;
      let isFile = false;
      try {
        isFile = statSync(manifestPath).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) continue;
      const physicalProjection = loaded.packages.get(packageName);
      const selected = !claimed.has(packageName);
      if (physicalProjection) {
        physicalProgramClaims.push({
          packageName,
          projection: physicalProjection,
          selected,
        });
      }
      if (!selected) continue;
      claimed.add(packageName);
      const identity = authoritativeIdentities.get(packageName);
      if (identity) {
        identities.set(packageName, {
          ...identity,
          packageName,
          manifestPath,
          policyPath: manifestPath,
        });
      } else {
        unidentifiedPackages.set(packageName, manifestPath);
      }
      const projection = authoritativePackages.get(packageName);
      if (!projection) {
        unprojectedPackages.set(packageName, manifestPath);
        continue;
      }
      packages.set(packageName, {
        ...projection,
        packageName,
        manifestPath,
        policyPath: manifestPath,
      });
    }
  }
  return {
    identities,
    unidentifiedPackages,
    packages,
    unprojectedPackages,
    physicalProgramClaims,
  };
}

function verifySelectedPackageIdentity(
  identity: SelectedPackageProjectionIdentity,
): void {
  if (!identity.manifestPath) return;
  let bytes: Buffer;
  try {
    bytes = readFileSync(identity.manifestPath);
  } catch (error) {
    throw new Error(
      `Program package identity cannot verify ${identity.manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== identity.manifestSha256) {
    throw new Error(
      `Program package identity is stale for ${identity.manifestPath}; regenerate ${PROGRAM_PACKAGE_INDEX_FILE}`,
    );
  }
}

function verifySelectedProgramPackage(
  projection: SelectedProgramPackageProjection,
): void {
  if (!projection.manifestPath) return;
  let bytes: Buffer;
  try {
    bytes = readFileSync(projection.manifestPath);
  } catch (error) {
    throw new Error(
      `Program package projection cannot verify ${projection.manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== projection.manifestSha256) {
    throw new Error(
      `Program package projection is stale for ${projection.manifestPath}; regenerate ${PROGRAM_PACKAGE_INDEX_FILE}`,
    );
  }
}

function selectedProgramPackage(
  packageName: string,
): SelectedProgramPackageProjection | null {
  const index = programRegistryIndex();
  const projection = index.packages.get(packageName);
  if (projection) {
    verifySelectedProgramPackage(projection);
    return projection;
  }
  const manifestPath = index.unprojectedPackages.get(packageName);
  if (manifestPath) {
    throw new Error(
      `Package ${JSON.stringify(packageName)} is selected at ${manifestPath} but is absent from ${PROGRAM_PACKAGE_INDEX_FILE}; regenerate the registry projection`,
    );
  }
  return null;
}

function verifyProgramDependencyContext(
  projection: SelectedProgramPackageProjection,
  arch: string,
): void {
  const expectedDependencies = projection.dependencyClosures[arch];
  if (!expectedDependencies) {
    throw manifestError(
      projection.policyPath,
      `package ${JSON.stringify(projection.packageName)} lacks a dependency identity closure for ${arch}`,
    );
  }
  const state = selectedProgramPackageState();
  const selectedProgramIdentity = state.identities.get(projection.packageName);
  if (!selectedProgramIdentity) {
    const unidentified = state.unidentifiedPackages.get(projection.packageName);
    throw new Error(
      `Program package ${JSON.stringify(projection.packageName)} has no authoritative ` +
        `contextual identity for ${arch}${
          unidentified ? ` at ${unidentified}` : ""
        }; regenerate ${PROGRAM_PACKAGE_INDEX_FILE} with the exact ordered registry roots`,
    );
  }
  verifySelectedPackageIdentity(selectedProgramIdentity);
  const selectedProgramCacheKey = selectedProgramIdentity.cacheKeys[arch];
  if (
    selectedProgramIdentity.manifestSha256 !== projection.manifestSha256
    || selectedProgramCacheKey !== projection.cacheKeys[arch]
  ) {
    throw new Error(
      `Program package ${JSON.stringify(projection.packageName)} was projected with ` +
        `manifest ${projection.manifestSha256} and cache key ${projection.cacheKeys[arch]}` +
        ` for ${arch}, but the authoritative first-hit registry context at ` +
        `${selectedProgramIdentity.policyPath} requires manifest ` +
        `${selectedProgramIdentity.manifestSha256} and cache key ` +
        `${selectedProgramCacheKey ?? "<missing>"}. Regenerate this program projection ` +
        `with the exact ordered registry roots; the highest-priority index must ` +
        `carry the complete combined-context projection rather than relying on ` +
        `a lower suffix-context build identity.`,
    );
  }
  for (const expected of expectedDependencies) {
    const selected = state.identities.get(expected.packageName);
    if (!selected) {
      const unidentified = state.unidentifiedPackages.get(expected.packageName);
      if (unidentified) {
        throw new Error(
          `Program package ${JSON.stringify(projection.packageName)} was generated against ` +
            `dependency ${JSON.stringify(expected.packageName)}, but the first-hit package at ` +
            `${unidentified} has no contextual identity in ${PROGRAM_PACKAGE_INDEX_FILE}`,
        );
      }
      throw new Error(
        `Program package ${JSON.stringify(projection.packageName)} was generated against ` +
          `dependency ${JSON.stringify(expected.packageName)}, but that dependency is absent ` +
          `from the configured first-hit registry roots`,
      );
    }
    verifySelectedPackageIdentity(selected);
    const selectedCacheKey = selected.cacheKeys[arch];
    if (
      selected.manifestSha256 !== expected.manifestSha256
      || selectedCacheKey !== expected.cacheKey
    ) {
      throw new Error(
        `Program package ${JSON.stringify(projection.packageName)} has a contextual cache ` +
          `identity mismatch for ${arch}: its projection expects dependency ` +
          `${JSON.stringify(expected.packageName)} manifest ${expected.manifestSha256} ` +
          `and cache key ${expected.cacheKey}, but first-hit selection at ` +
          `${selected.policyPath} provides manifest ${selected.manifestSha256} and cache key ` +
          `${selectedCacheKey ?? "<missing>"}. Regenerate the program projection with the ` +
          `exact ordered registry roots; the complete highest-priority projection must ` +
          `bind every selected program to the same combined dependency context.`,
      );
    }
  }
}

function programRegistryIndex(): ProgramRegistryIndex {
  const state = selectedProgramPackageState();
  const { physicalProgramClaims, ...selectedState } = state;
  const index: ProgramRegistryIndex = {
    ...selectedState,
    legacyFlatOutputs: new Map(),
    forkInstrumentationDisabledOutputs: new Map(),
  };
  const resolverPaths: Array<{
    arch: string;
    path: string;
    packageName: string;
  }> = [];
  for (const projection of state.packages.values()) {
    const packageOwned = projection.members.length > 1;
    for (const arch of projection.arches) {
      for (const member of projection.members) {
        const conflict = resolverPaths.find(
          (previous) =>
            previous.arch === arch
            && (
              previous.path === member.mirrorPath
              || previous.path.startsWith(`${member.mirrorPath}/`)
              || member.mirrorPath.startsWith(`${previous.path}/`)
            ),
        );
        if (conflict) {
          throw new Error(
            `Program resolver paths programs/${arch}/${conflict.path} and programs/${arch}/${member.mirrorPath} conflict between selected packages ${JSON.stringify(conflict.packageName)} and ${JSON.stringify(projection.packageName)}`,
          );
        }
        resolverPaths.push({
          arch,
          path: member.mirrorPath,
          packageName: projection.packageName,
        });
        if (member.kind !== "output") continue;
        const flatPath = member.mirrorPath.split("/").at(-1)!;
        const key = `${arch}/${flatPath}`;
        let owner = index.legacyFlatOutputs.get(key);
        if (!owner) {
          owner = {
            scalarOwners: new Set(),
            packagePaths: new Map(),
            shadowedOwners: new Set(),
          };
          index.legacyFlatOutputs.set(key, owner);
        }
        if (packageOwned) {
          owner.packagePaths.set(
            `programs/${arch}/${member.mirrorPath}`,
            projection.packageName,
          );
        } else {
          owner.scalarOwners.add(projection.packageName);
        }
        if (member.forkInstrumentation === "disabled") {
          index.forkInstrumentationDisabledOutputs.set(
            `${arch}/${member.mirrorPath}`,
            projection.packageName,
          );
        }
      }
    }
  }
  // A lower physical program can be shadowed by a higher package of another
  // kind (or by a different program layout). Its old flat mirror path must
  // remain a fail-closed namespace claim; otherwise generic scalar lookup
  // could serve stale bytes that bypass the actual first-hit package. A
  // selected lower program reprojected by the authoritative top index already
  // has active claims for the same manifest-owned members.
  for (
    const { packageName, projection, selected } of physicalProgramClaims
  ) {
    if (selected && state.packages.has(packageName)) continue;
    for (const arch of projection.arches) {
      for (const member of projection.members) {
        if (member.kind !== "output") continue;
        const flatPath = member.mirrorPath.split("/").at(-1)!;
        const key = `${arch}/${flatPath}`;
        let owner = index.legacyFlatOutputs.get(key);
        if (!owner) {
          owner = {
            scalarOwners: new Set(),
            packagePaths: new Map(),
            shadowedOwners: new Set(),
          };
          index.legacyFlatOutputs.set(key, owner);
        }
        owner.shadowedOwners.add(packageName);
      }
    }
  }

  return index;
}

/**
 * Reject the former flat spelling of an output that now belongs to a
 * multi-member package directory. Without this migration guard, a stale
 * `programs/<arch>/<output>` symlink can enter scalar lookup and bypass the
 * package closure. A flat spelling remains valid when a true single-member
 * package owns the same output name.
 */
function selectedFlatProgramPackage(
  adjusted: string,
): SelectedProgramPackageProjection | null {
  const components = adjusted.split("/");
  if (
    components.length !== 3
    || components[0] !== "programs"
    || !ARCH_SEGMENTS.has(components[1]!)
  ) return null;
  const owner = programRegistryIndex().legacyFlatOutputs.get(
    `${components[1]}/${components[2]}`,
  );
  if (!owner) return null;
  for (const packageName of owner.scalarOwners) {
    const projection = selectedProgramPackage(packageName);
    if (projection) return projection;
  }
  for (const packageName of owner.packagePaths.values()) {
    selectedProgramPackage(packageName);
  }
  if (owner.packagePaths.size > 0) {
    throw new Error(
      `Legacy flat resolver path ${JSON.stringify(adjusted)} belongs to a multi-member package; use ${[...owner.packagePaths.keys()].sort().map((path) => JSON.stringify(path)).join(" or ")}`,
    );
  }
  for (const packageName of owner.shadowedOwners) {
    const projection = selectedProgramPackage(packageName);
    if (projection) return projection;
    throw new Error(
      `Legacy flat resolver path ${JSON.stringify(adjusted)} is claimed by ` +
        `a lower-root program package ${JSON.stringify(packageName)}, but its ` +
        `first-hit selected package does not project that program; stale scalar ` +
        `mirror fallback is forbidden`,
    );
  }
  return null;
}

function closureForProjection(
  projection: SelectedProgramPackageProjection,
  arch: string,
  adjusted: string,
): ProgramPackageClosure {
  if (!projection.arches.includes(arch)) {
    throw manifestError(
      projection.policyPath,
      `package ${JSON.stringify(projection.packageName)} does not declare resolver artifacts for ${arch}`,
    );
  }
  const cacheKey = projection.cacheKeys[arch];
  if (!cacheKey) {
    throw manifestError(
      projection.policyPath,
      `package ${JSON.stringify(projection.packageName)} lacks a cache identity for ${arch}`,
    );
  }
  verifyProgramDependencyContext(projection, arch);
  const projectionIdentity = programPackageProjectionIdentity(projection);
  const members: ProgramPackageClosureMember[] = projection.members.map(
    (member) => ({
      packageName: projection.packageName,
      relPath: `programs/${arch}/${member.mirrorPath}`,
      sourceArtifact: member.sourceArtifact,
      cacheKey,
      forkInstrumentation: member.kind === "output"
        ? member.forkInstrumentation ?? null
        : null,
      projectionIdentity,
    }),
  );
  if (!members.some((member) => member.relPath === adjusted)) {
    throw manifestError(
      projection.policyPath,
      `resolver path ${JSON.stringify(adjusted)} is not a declared member of package ${JSON.stringify(projection.packageName)}`,
    );
  }
  return {
    manifestPath: projection.policyPath,
    packageName: projection.packageName,
    members,
  };
}

function discoverProgramPackageClosure(
  relPath: string,
): ProgramPackageClosure | null {
  const adjusted = applyDefaultArch(relPath);
  const components = adjusted.split("/");
  if (
    components[0] === "programs"
    && !hasSourceCheckout()
    && bundledProgramPackageProjection() === null
  ) {
    throw new Error(
      `Installed host package is missing wasm/${PROGRAM_PACKAGE_INDEX_FILE}; ` +
        `program artifacts cannot be resolved without packaged policy`,
    );
  }
  if (components.length === 3) {
    const projection = selectedFlatProgramPackage(adjusted);
    if (projection) {
      return closureForProjection(projection, components[1]!, adjusted);
    }
    rejectUnselectedBundledProgramClaim(adjusted);
    return null;
  }
  if (
    components.length < 4
    || components[0] !== "programs"
    || !ARCH_SEGMENTS.has(components[1]!)
  ) return null;
  const arch = components[1]!;
  const packageDirectory = components[2]!;
  const projection = selectedProgramPackage(packageDirectory);
  if (!projection) {
    rejectUnselectedBundledProgramClaim(adjusted);
    return null;
  }
  return closureForProjection(projection, arch, adjusted);
}

/**
 * Return every output and runtime file when `relPath` names a projected
 * program package. Even a one-member package carries an exact selected cache
 * identity; packages with multiple members additionally resolve as one
 * all-or-nothing closure.
 *
 * An absent registry directory means the path is not package-owned. Once the
 * directory exists, a missing, unreadable, or incomplete manifest is an error
 * rather than permission to fall back to single-output resolution.
 */
export function programOutputClosureRelPaths(relPath: string): string[] | null {
  return withFreshProgramIndexes([relPath], () =>
    discoverProgramPackageClosure(relPath)?.members.map(
      (member) => member.relPath,
    ) ?? null
  );
}

function stripProgramArch(relPath: string): string | null {
  const adjusted = applyDefaultArch(relPath);
  for (const prefix of ["programs/wasm32/", "programs/wasm64/"]) {
    if (adjusted.startsWith(prefix)) return adjusted.slice(prefix.length);
  }
  return null;
}

function disablesForkInstrumentation(relPath: string): boolean {
  const adjusted = applyDefaultArch(relPath);
  for (const arch of ARCH_SEGMENTS) {
    const prefix = `programs/${arch}/`;
    if (adjusted.startsWith(prefix)) {
      const packageName = programRegistryIndex()
        .forkInstrumentationDisabledOutputs.get(
          `${arch}/${adjusted.slice(prefix.length)}`,
        );
      if (!packageName) return false;
      return selectedProgramPackage(packageName) !== null;
    }
  }
  return false;
}

function requiredExportsForRelPath(relPath: string): readonly string[] | undefined {
  const adjusted = applyDefaultArch(relPath);
  if (adjusted === "kernel.wasm") {
    return HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS;
  }

  const programRel = stripProgramArch(adjusted);
  if (programRel && programRel.endsWith(".wasm")) {
    return EXECUTABLE_PROGRAM_REQUIRED_EXPORTS;
  }

  return undefined;
}

function hasWasmArtifactPolicyFailures(
  path: string,
  relPath: string,
  capturedForkInstrumentation?: "auto" | "disabled" | null,
): boolean {
  if (!path.endsWith(".wasm")) return false;
  try {
    const bytes = readFileSync(path);
    const programBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const forkDisabled = capturedForkInstrumentation === undefined
      ? disablesForkInstrumentation(relPath)
      : capturedForkInstrumentation === "disabled";
    return describeWasmArtifactPolicyFailures(programBytes, {
      expectedAbi: ABI_VERSION,
      requiredExports: requiredExportsForRelPath(relPath),
      requireForkInstrumentation: forkDisabled ? false : undefined,
      forbidForkInstrumentation: forkDisabled,
    }).length > 0;
  } catch {
    // A path declared as executable Wasm must remain fail-closed when its
    // bytes or policy metadata cannot be inspected.
    return true;
  }
}

function hasVfsArtifactPolicyFailures(path: string): boolean {
  if (!path.endsWith(".vfs") && !path.endsWith(".vfs.zst")) return false;
  try {
    const metadata = MemoryFileSystem.readImageMetadata(readFileSync(path));
    const declaredAbi = metadata?.kernelAbi;
    return declaredAbi !== undefined && declaredAbi !== ABI_VERSION;
  } catch {
    // A path declared as a VFS image must remain fail-closed when its header,
    // compression, or metadata cannot be inspected. This also keeps the
    // TypeScript and shell resolvers aligned.
    return true;
  }
}

function hasBinaryArtifactPolicyFailures(
  path: string,
  relPath: string,
  capturedForkInstrumentation?: "auto" | "disabled" | null,
): boolean {
  return hasWasmArtifactPolicyFailures(
    path,
    relPath,
    capturedForkInstrumentation,
  ) ||
    hasVfsArtifactPolicyFailures(path);
}

function chooseBinaryCandidate(
  candidates: string[],
  relPath: string,
  capturedForkInstrumentation?: "auto" | "disabled" | null,
): string | null {
  const existing = candidates.filter(pathEntryExists);
  if (existing.length === 0) return null;

  return existing.find((candidate) => {
    try {
      return statSync(candidate).isFile()
        && !hasBinaryArtifactPolicyFailures(
          candidate,
          relPath,
          capturedForkInstrumentation,
        );
    } catch {
      return false;
    }
  }) ?? null;
}

function pinScalarCandidate(
  candidate: string,
  relPath: string,
  capturedForkInstrumentation?: "auto" | "disabled" | null,
): string {
  try {
    const metadata = lstatSync(candidate);
    if (!metadata.isSymbolicLink()) return candidate;
    const pinned = realpathSync(candidate);
    if (
      !statSync(pinned).isFile()
      || hasBinaryArtifactPolicyFailures(
        pinned,
        relPath,
        capturedForkInstrumentation,
      )
    ) {
      throw new Error("canonical target is not an accepted regular file");
    }
    if (
      applyDefaultArch(relPath).startsWith("programs/")
      && isResolverOwnedProgramGenerationTarget(pinned)
    ) {
      throw new Error(
        "resolver-owned program generation has no matching selected package projection",
      );
    }
    return pinned;
  } catch (error) {
    throw new Error(
      `Binary changed or became invalid while pinning ${relPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function isResolverOwnedProgramGenerationTarget(path: string): boolean {
  const roots = [binaryProgramCacheRoot()];
  try {
    roots.push(
      join(
        resolverRepoRoot(),
        "local-binaries",
        ".kandelo-local-generations",
      ),
    );
  } catch {
    // Installed consumers have no local source-build generation namespace.
  }
  return roots.some((root) => {
    try {
      return pathEntryExists(root)
        && pathIsWithin(realpathSync(root), path);
    } catch {
      return false;
    }
  });
}

function pathIsWithin(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === ""
    || (
      pathFromRoot !== ".."
      && !pathFromRoot.startsWith(`..${sep}`)
      && !isAbsolute(pathFromRoot)
    );
}

function canonicalRootForArtifact(
  resolvedTarget: string,
  sourceArtifact: string,
): string | null {
  const parts = sourceArtifact.split("/");
  let root = resolvedTarget;
  for (let index = 0; index < parts.length; index++) root = dirname(root);
  return resolve(root, ...parts) === resolvedTarget ? root : null;
}

function mutableGenerationIdentityFailure(
  tier: BinaryCandidateTier,
  sharedRoot: string,
  members: readonly ProgramPackageClosureMember[],
): string | null {
  const [programs, arch] = members[0]!.relPath.split("/");
  const packageName = members[0]!.packageName;
  if (
    programs !== "programs"
    || !ARCH_SEGMENTS.has(arch!)
    || !packageName
    || members.some((member) => member.packageName !== packageName)
  ) return "declared package members do not share a valid program namespace";
  if (!statSync(sharedRoot).isDirectory()) {
    return "shared package generation root is not a directory";
  }
  const cacheKey = members[0]!.cacheKey;
  if (
    !/^[a-f0-9]{64}$/.test(cacheKey)
    || members.some((member) => member.cacheKey !== cacheKey)
  ) {
    return "declared package members do not share one valid cache identity";
  }

  if (tier.identity === "local-generation") {
    const expectedParentPath = join(
      tier.root,
      ".kandelo-local-generations",
      arch!,
      packageName,
      cacheKey,
    );
    if (!pathEntryExists(expectedParentPath)) {
      return "local mirror targets are not one direct immutable local generation";
    }
    const expectedParent = realpathSync(expectedParentPath);
    return dirname(sharedRoot) === expectedParent
      ? null
      : "local mirror targets are not one direct immutable local generation";
  }
  if (tier.identity === "program-cache") {
    const expectedParentPath = binaryProgramCacheRoot();
    if (!pathEntryExists(expectedParentPath)) {
      return "fetched mirror targets are not one canonical program-cache generation";
    }
    const expectedParent = realpathSync(expectedParentPath);
    const generationName = basename(sharedRoot);
    const hasCanonicalName = generationName.startsWith(`${packageName}-`)
      && new RegExp(`-rev[0-9]+-${arch}-${cacheKey}$`).test(generationName);
    return dirname(sharedRoot) === expectedParent && hasCanonicalName
      ? null
      : "fetched mirror targets are not one canonical program-cache generation";
  }
  return "installed-package symlink closures are not an immutable installed identity";
}

interface PinnedPackageClosure {
  paths: string[];
}

interface RejectedPackageClosure {
  failure: string;
}

/**
 * Verify that a selected multi-member package is one generation and return
 * canonical member paths inside that generation. Returning the mirror paths
 * would reopen a time-of-check/time-of-use race: the live package directory
 * can be atomically replaced after validation, changing what those strings
 * name before a caller reads them.
 */
function pinPackageClosureIdentity(
  tier: BinaryCandidateTier,
  selected: readonly string[],
  members: readonly ProgramPackageClosureMember[],
): PinnedPackageClosure | RejectedPackageClosure {
  if (selected.length !== members.length) {
    return { failure: "internal member/path count mismatch" };
  }

  try {
    const linkKinds = selected.map((candidate) => {
      const metadata = lstatSync(candidate);
      if (metadata.isSymbolicLink()) return "symlink" as const;
      if (metadata.isFile()) return "file" as const;
      return "other" as const;
    });
    if (linkKinds.includes("other")) {
      return {
        failure: "a selected mirror member is neither a regular file nor a symlink",
      };
    }
    const allSymlinks = linkKinds.every((kind) => kind === "symlink");
    const allFiles = linkKinds.every((kind) => kind === "file");
    if (!allSymlinks && !allFiles) {
      return {
        failure: "regular files and symlinks cannot share one package identity",
      };
    }

    if (allFiles) {
      if (!tier.allowRegularFileClosure) {
        return {
          failure: "a mutable source-checkout wasm tree is not an installed package identity",
        };
      }
      const packageName = members[0]!.packageName;
      const projectionIdentity = members[0]!.projectionIdentity;
      if (
        members.some(
          (member) =>
            member.packageName !== packageName
            || member.projectionIdentity !== projectionIdentity,
        )
      ) {
        return {
          failure: "declared members do not share one selected package projection",
        };
      }
      const bundled = bundledProgramPackageProjection();
      const bundledProjection = bundled?.packages.get(packageName);
      if (
        !bundledProjection
        || programPackageProjectionIdentity(bundledProjection)
          !== projectionIdentity
      ) {
        return {
          failure: "installed bytes do not match the selected package projection",
        };
      }
      const installedRoot = realpathSync(tier.root);
      const pinnedPaths: string[] = [];
      for (const candidate of selected) {
        const resolvedCandidate = realpathSync(candidate);
        if (
          !pathIsWithin(installedRoot, resolvedCandidate)
          || !statSync(resolvedCandidate).isFile()
        ) {
          return {
            failure: "an installed-package member escapes its immutable wasm tree",
          };
        }
        pinnedPaths.push(resolvedCandidate);
      }
      return { paths: pinnedPaths };
    }

    let sharedRoot: string | null = null;
    const pinnedPaths: string[] = [];
    for (let index = 0; index < selected.length; index++) {
      const resolvedTarget = realpathSync(selected[index]!);
      if (!statSync(resolvedTarget).isFile()) {
        return {
          failure: `${members[index]!.relPath} does not resolve to a regular file`,
        };
      }
      const canonicalRoot = canonicalRootForArtifact(
        resolvedTarget,
        members[index]!.sourceArtifact,
      );
      if (!canonicalRoot) {
        return {
          failure: `${members[index]!.relPath} does not target its declared source artifact ${members[index]!.sourceArtifact}`,
        };
      }
      if (sharedRoot === null) {
        sharedRoot = canonicalRoot;
      } else if (canonicalRoot !== sharedRoot) {
        return {
          failure: "member symlinks target different canonical package generations",
        };
      }
      pinnedPaths.push(resolvedTarget);
    }
    const generationFailure = mutableGenerationIdentityFailure(
      tier,
      sharedRoot!,
      members,
    );
    if (generationFailure) return { failure: generationFailure };
    return { paths: pinnedPaths };
  } catch (error) {
    return {
      failure: `cannot inspect package identity: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function samePackageClosure(
  left: ProgramPackageClosure,
  right: ProgramPackageClosure,
): boolean {
  if (
    left.manifestPath !== right.manifestPath
    || left.members.length !== right.members.length
  ) {
    return false;
  }
  const rightByPath = new Map(
    right.members.map((member) => [
      member.relPath,
      `${member.packageName}\0${member.sourceArtifact}\0${member.cacheKey}\0${member.forkInstrumentation ?? ""}\0${member.projectionIdentity}`,
    ]),
  );
  return left.members.every(
    (member) =>
      rightByPath.get(member.relPath)
        === `${member.packageName}\0${member.sourceArtifact}\0${member.cacheKey}\0${member.forkInstrumentation ?? ""}\0${member.projectionIdentity}`,
  );
}

function closureMembersForRequestedSet(
  relPaths: readonly string[],
): ProgramPackageClosureMember[] | null {
  let closure: ProgramPackageClosure | null = null;
  for (const relPath of relPaths) {
    const discovered = discoverProgramPackageClosure(relPath);
    if (!discovered) continue;
    if (closure && !samePackageClosure(closure, discovered)) {
      throw new Error(
        "A binary set cannot combine members from different package closures",
      );
    }
    closure = discovered;
  }
  if (!closure) return null;

  const requested = new Set(relPaths.map(applyDefaultArch));
  const declared = new Set(closure.members.map((member) => member.relPath));
  if (
    requested.size !== relPaths.length
    || requested.size !== declared.size
    || [...declared].some((relPath) => !requested.has(relPath))
  ) {
    throw new Error(
      `Package ${closure.packageName} must resolve its complete declared ` +
        `closure: ${[...declared].join(", ")}`,
    );
  }
  const memberByPath = new Map(
    closure.members.map((member) => [member.relPath, member]),
  );
  return relPaths.map((relPath) => memberByPath.get(applyDefaultArch(relPath))!);
}

export function resolveBinary(relPath: string): string {
  return withFreshProgramIndexes([relPath], () =>
    resolveBinaryInFreshProgramContext(relPath)
  );
}

function resolveBinaryInFreshProgramContext(relPath: string): string {
  const adjusted = applyDefaultArch(relPath);
  const packageClosure = discoverProgramPackageClosure(adjusted);
  if (packageClosure) {
    const selected = tryResolveBinarySetFromTiers(
      packageClosure.members.map((member) => member.relPath),
      packageClosure.members,
    );
    if (selected) {
      return selected[
        packageClosure.members.findIndex((member) => member.relPath === adjusted)
      ]!;
    }
    // The package scan already checked every member in every tier. Never
    // re-enter scalar lookup for a package-owned path: a concurrent publisher
    // could otherwise create one member between the two scans and bypass the
    // closure/identity contract.
    throw new BinaryNotFoundError(
      `Package artifacts not found for ${packageClosure.packageName}: ${adjusted}`,
    );
  }
  const checked: string[] = [];
  const candidates: string[] = [];
  for (const tier of binaryCandidateTiers()) {
    for (const candidate of tier.candidatesFor(relPath)) {
      checked.push(candidate);
      candidates.push(candidate);
    }
  }
  const candidate = chooseBinaryCandidate(candidates, relPath);
  if (candidate) return pinScalarCandidate(candidate, relPath);
  if (candidates.some(pathEntryExists)) {
    throw new Error(
      `Binary exists but was rejected by artifact policy: ${relPath}\n` +
        checked.map((p) => `  checked: ${p}`).join("\n"),
    );
  }
  throw new BinaryNotFoundError(
    `Binary not found: ${relPath}\n` +
      checked.map((p) => `  checked: ${p}`).join("\n") +
      `\n  Run scripts/fetch-binaries.sh, place a file at local-binaries/${adjusted}, or install a package that includes wasm/${relPath}.`
  );
}

/**
 * Like `resolveBinary` but returns `null` instead of throwing when the
 * binary is absent. Callers choose how to handle the miss.
 */
export function tryResolveBinary(relPath: string): string | null {
  try {
    return resolveBinary(relPath);
  } catch (error) {
    if (error instanceof BinaryNotFoundError) return null;
    throw error;
  }
}

/**
 * Resolve several independent optional artifacts after one source-projection
 * freshness check.
 *
 * Unlike `tryResolveBinarySet`, these paths do not need to belong to one
 * package closure and the returned entries may independently be `null`.
 * Each package-owned path still resolves its complete declared closure from
 * one verified generation. Requests for multiple members of the same package
 * share that one pinned closure, so an atomic live-mirror replacement cannot
 * mix generations inside the returned batch. This API exists for consumers
 * such as the example runner that load many unrelated optional programs at
 * one synchronous boundary; invoking the canonical Rust freshness checker
 * once per program would make module startup scale with the number of
 * optional commands.
 */
export function tryResolveBinaries(
  relPaths: readonly string[],
): Array<string | null> {
  return withFreshProgramIndexes(relPaths, () => {
    const results = new Array<string | null>(relPaths.length).fill(null);
    const independentRequests: Array<{
      index: number;
      relPath: string;
    }> = [];
    const packageGroups: Array<{
      closure: ProgramPackageClosure;
      requests: Array<{
        index: number;
        adjustedRelPath: string;
      }>;
    }> = [];

    for (const [index, relPath] of relPaths.entries()) {
      const adjustedRelPath = applyDefaultArch(relPath);
      const closure = discoverProgramPackageClosure(adjustedRelPath);
      if (!closure) {
        independentRequests.push({ index, relPath });
        continue;
      }
      let group = packageGroups.find((candidate) =>
        samePackageClosure(candidate.closure, closure)
      );
      if (!group) {
        group = { closure, requests: [] };
        packageGroups.push(group);
      }
      group.requests.push({ index, adjustedRelPath });
    }

    for (const { closure, requests } of packageGroups) {
      // Resolve the declared closure once, then map every requested member
      // from those pinned paths. Re-resolving member-by-member would reopen a
      // race with the publisher's atomic live-directory replacement.
      const selected = tryResolveBinarySetFromTiers(
        closure.members.map((member) => member.relPath),
        closure.members,
      );
      if (selected === null) continue;
      const selectedByRelPath = new Map(
        closure.members.map((member, index) => [
          member.relPath,
          selected[index]!,
        ]),
      );
      for (const request of requests) {
        const resolved = selectedByRelPath.get(request.adjustedRelPath);
        if (resolved === undefined) {
          throw new Error(
            `Internal package projection omitted ${request.adjustedRelPath}`,
          );
        }
        results[request.index] = resolved;
      }
    }

    for (const { index, relPath } of independentRequests) {
      try {
        results[index] = resolveBinaryInFreshProgramContext(relPath);
      } catch (error) {
        if (error instanceof BinaryNotFoundError) continue;
        throw error;
      }
    }
    return results;
  });
}

/**
 * Resolve a related artifact set from one complete provenance tier.
 *
 * A partial or policy-invalid local tier is skipped as a whole when a later
 * tier is complete. If artifacts exist across the candidate roots but no
 * single root contains an accepted complete set, this throws instead of
 * silently composing a package from unrelated builds. It returns `null` only
 * when none of the requested artifacts exists in any tier.
 *
 * Returned paths preserve `relPaths` order and share one verified provenance
 * identity. For symlink-backed package closures they are canonical generation
 * member paths, not mutable live-mirror paths. The fetched cache still assumes
 * no concurrent force-rebuild or stale-entry repair of the same cache key.
 */
export function tryResolveBinarySet(relPaths: readonly string[]): string[] | null {
  return withFreshProgramIndexes(relPaths, () => {
    const closureMembers = closureMembersForRequestedSet(relPaths);
    return tryResolveBinarySetFromTiers(relPaths, closureMembers);
  });
}

function tryResolveBinarySetFromTiers(
  relPaths: readonly string[],
  closureMembers: readonly ProgramPackageClosureMember[] | null,
): string[] | null {
  if (relPaths.length === 0) return [];

  let anyExisting = false;
  const incomplete: string[] = [];
  for (const tier of binaryCandidateTiers()) {
    const selected: string[] = [];
    const unavailable: string[] = [];
    if (closureMembers) {
      const [programs, arch, packageName] = closureMembers[0]!.relPath.split("/");
      if (programs === "programs" && arch && packageName) {
        anyExisting ||= pathEntryExists(join(tier.root, programs, arch, packageName));
      }
    }
    for (const [index, relPath] of relPaths.entries()) {
      const candidates = tier.candidatesFor(relPath);
      const existing = candidates.filter(pathEntryExists);
      anyExisting ||= existing.length > 0;
      const candidate = chooseBinaryCandidate(
        candidates,
        relPath,
        closureMembers?.[index]?.forkInstrumentation,
      );
      if (candidate) {
        selected.push(candidate);
      } else if (existing.length > 0) {
        unavailable.push(`${relPath} (rejected by artifact policy)`);
      } else {
        unavailable.push(`${relPath} (missing)`);
      }
    }
    if (unavailable.length === 0 && closureMembers) {
      const identity = pinPackageClosureIdentity(
        tier,
        selected,
        closureMembers,
      );
      if ("failure" in identity) {
        unavailable.push(`shared package identity rejected: ${identity.failure}`);
      } else {
        const rejectedPinnedMembers = identity.paths.flatMap((path, index) =>
          hasBinaryArtifactPolicyFailures(
            path,
            relPaths[index]!,
            closureMembers[index]!.forkInstrumentation,
          )
            ? [relPaths[index]!]
            : []
        );
        if (rejectedPinnedMembers.length > 0) {
          unavailable.push(
            `pinned package generation rejected by artifact policy: ${rejectedPinnedMembers.join(", ")}`,
          );
        } else {
          return identity.paths;
        }
      }
    }
    if (unavailable.length === 0) {
      return selected.map((path, index) =>
        pinScalarCandidate(
          path,
          relPaths[index]!,
          closureMembers?.[index]?.forkInstrumentation,
        )
      );
    }
    incomplete.push(
      `  ${tier.label} (${tier.root}): ${unavailable.join(", ")}`,
    );
  }

  if (!anyExisting) return null;
  throw new Error(
    "Package artifact closure is incomplete: no single provenance tier " +
      "contains every accepted artifact, and tiers will not be mixed.\n" +
      incomplete.join("\n"),
  );
}

/** Returns the absolute path of binaries/ whether or not it exists. */
export function binariesDir(): string {
  return join(resolverRepoRoot(), "binaries");
}

/** Returns the absolute path of local-binaries/ whether or not it exists. */
export function localBinariesDir(): string {
  return join(resolverRepoRoot(), "local-binaries");
}
