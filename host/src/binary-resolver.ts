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
  type Dirent,
} from "node:fs";
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
  // Cargo.tomls do not. Cheap check that disambiguates without
  // having to read+parse every Cargo.toml on the way up.
  const cargo = join(dir, "Cargo.toml");
  if (!existsSync(cargo) || !existsSync(join(dir, "package.json"))) {
    return false;
  }
  try {
    return /^\s*\[workspace\]/m.test(readFileSync(cargo, "utf8"));
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

function packageRoot(): string {
  return resolve(currentModuleDir(), "..");
}

/** Cache root used by xtask for immutable package generations. */
export function binaryCacheRoot(): string {
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
   * An installed npm package is one versioned installation identity. Repo
   * mirrors are mutable and need cache-target identity from their symlinks.
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
  try {
    const repo = findRepoRoot();
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
    allowRegularFileClosure: true,
    candidatesFor(relPath: string): string[] {
      return packagedBinaryCandidates(relPath, root);
    },
  });
  return tiers;
}

interface ProgramOutputPolicy {
  name?: string;
  wasm?: string;
  forkInstrumentation?: string;
}

interface ProgramRuntimeFilePolicy {
  artifact?: string;
}

interface ProgramPackageClosureMember {
  relPath: string;
  sourceArtifact: string;
}

interface ProgramPackageClosure {
  manifestPath: string;
  packageName: string;
  members: ProgramPackageClosureMember[];
}

type ParsedProgramOutput = Required<Pick<
  ProgramOutputPolicy,
  "name" | "wasm"
>> & Pick<ProgramOutputPolicy, "forkInstrumentation">;

interface ParsedProgramPackageManifest {
  kind: string;
  name: string;
  outputs: ParsedProgramOutput[];
  runtimeFiles: Required<Pick<ProgramRuntimeFilePolicy, "artifact">>[];
  targetArches: string[];
}

function outputExtension(wasmPath: string): string {
  const basename = wasmPath.split(/[\\/]/).pop() ?? wasmPath;
  const dot = basename.indexOf(".");
  return dot >= 0 ? basename.slice(dot) : "";
}

function outputRelForPackage(
  packageName: string,
  output: Required<Pick<ProgramOutputPolicy, "name" | "wasm">>,
  packageOwned: boolean,
): string {
  const destName = `${output.name}${outputExtension(output.wasm)}`;
  return packageOwned ? `${packageName}/${destName}` : destName;
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

function stripTomlComment(line: string): string {
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote === "\"") {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function plainTomlString(
  value: string,
  manifestPath: string,
  field: string,
): string {
  const basic = value.match(/^"([^"\\]*)"$/);
  const literal = value.match(/^'([^']*)'$/);
  const parsed = basic?.[1] ?? literal?.[1];
  if (parsed === undefined) {
    throw manifestError(
      manifestPath,
      `${field} must be a plain quoted string`,
    );
  }
  return parsed;
}

function plainTomlStringArray(
  value: string,
  manifestPath: string,
  field: string,
): string[] {
  const match = value.match(/^\[\s*(.*?)\s*\]$/);
  if (!match) {
    throw manifestError(
      manifestPath,
      `${field} must be an array of plain quoted strings`,
    );
  }
  const body = match[1]!.trim();
  if (!body) return [];

  const values: string[] = [];
  let rest = body;
  while (rest.length > 0) {
    const entry = rest.match(
      /^\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:,\s*|$)/,
    );
    if (!entry) {
      throw manifestError(
        manifestPath,
        `${field} must contain only plain quoted strings`,
      );
    }
    values.push((entry[1] ?? entry[2])!);
    rest = rest.slice(entry[0].length);
  }
  return values;
}

function topLevelManifestKind(
  packageToml: string,
  manifestPath: string,
): string {
  let section = "";
  let kind: string | undefined;
  for (const rawLine of packageToml.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      section = line;
      continue;
    }
    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (section !== "" || assignment?.[1] !== "kind") continue;
    if (kind !== undefined) {
      throw manifestError(manifestPath, "duplicate top-level kind");
    }
    kind = plainTomlString(assignment[2]!, manifestPath, "kind");
  }
  if (kind === undefined) {
    throw manifestError(
      manifestPath,
      "missing or unsupported top-level kind",
    );
  }
  return kind;
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

function parseProgramPackageClosureManifest(
  packageToml: string,
  manifestPath: string,
): ParsedProgramPackageManifest {
  let section = "";
  let kind: string | undefined;
  let name: string | undefined;
  let arches: string[] | undefined;
  const outputs: ProgramOutputPolicy[] = [];
  const runtimeFiles: ProgramRuntimeFilePolicy[] = [];

  for (const rawLine of packageToml.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const arrayTable = line.match(/^\[\[([A-Za-z0-9_.-]+)\]\]$/);
    if (arrayTable) {
      section = `[[${arrayTable[1]}]]`;
      if (section === "[[outputs]]") outputs.push({});
      if (section === "[[runtime_files]]") runtimeFiles.push({});
      continue;
    }
    const table = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (table) {
      section = `[${table[1]}]`;
      continue;
    }
    if (
      line.startsWith("[[outputs")
      || line.startsWith("[[runtime_files")
    ) {
      throw manifestError(manifestPath, "malformed resolver-owned table header");
    }

    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!assignment) continue;
    const [, key, value] = assignment;
    if (section === "" && key === "kind") {
      if (kind !== undefined) {
        throw manifestError(manifestPath, "duplicate top-level kind");
      }
      kind = plainTomlString(value!, manifestPath, "kind");
    } else if (section === "" && key === "name") {
      if (name !== undefined) {
        throw manifestError(manifestPath, "duplicate top-level name");
      }
      name = plainTomlString(value!, manifestPath, "name");
    } else if (section === "" && key === "arches") {
      if (arches !== undefined) {
        throw manifestError(manifestPath, "duplicate top-level arches");
      }
      arches = plainTomlStringArray(value!, manifestPath, "arches");
    } else if (section === "[[outputs]]" && key === "name") {
      const output = outputs.at(-1)!;
      if (output.name !== undefined) {
        throw manifestError(manifestPath, "duplicate [[outputs]].name");
      }
      output.name = plainTomlString(
        value!,
        manifestPath,
        "[[outputs]].name",
      );
    } else if (section === "[[outputs]]" && key === "wasm") {
      const output = outputs.at(-1)!;
      if (output.wasm !== undefined) {
        throw manifestError(manifestPath, "duplicate [[outputs]].wasm");
      }
      output.wasm = plainTomlString(
        value!,
        manifestPath,
        "[[outputs]].wasm",
      );
    } else if (
      section === "[[outputs]]"
      && key === "fork_instrumentation"
    ) {
      const output = outputs.at(-1)!;
      if (output.forkInstrumentation !== undefined) {
        throw manifestError(
          manifestPath,
          "duplicate [[outputs]].fork_instrumentation",
        );
      }
      output.forkInstrumentation = plainTomlString(
        value!,
        manifestPath,
        "[[outputs]].fork_instrumentation",
      );
    } else if (section === "[[runtime_files]]" && key === "artifact") {
      const runtimeFile = runtimeFiles.at(-1)!;
      if (runtimeFile.artifact !== undefined) {
        throw manifestError(
          manifestPath,
          "duplicate [[runtime_files]].artifact",
        );
      }
      runtimeFile.artifact = plainTomlString(
        value!,
        manifestPath,
        "[[runtime_files]].artifact",
      );
    }
  }

  if (!kind) throw manifestError(manifestPath, "missing top-level kind");
  if (!name) throw manifestError(manifestPath, "missing top-level name");
  if (outputs.length === 0) {
    throw manifestError(manifestPath, "program package has no [[outputs]]");
  }

  const completeOutputs = outputs.map((output, index) => {
    if (!output.name || !output.wasm) {
      throw manifestError(
        manifestPath,
        `[[outputs]] entry ${index + 1} requires name and wasm`,
      );
    }
    if (
      output.forkInstrumentation !== undefined
      && output.forkInstrumentation !== "auto"
      && output.forkInstrumentation !== "disabled"
    ) {
      throw manifestError(
        manifestPath,
        `[[outputs]] entry ${index + 1} fork_instrumentation must be "auto" or "disabled"`,
      );
    }
    return {
      name: safeSinglePathComponent(
        output.name,
        manifestPath,
        `[[outputs]] entry ${index + 1} name`,
      ),
      wasm: portableArtifactPath(
        output.wasm,
        manifestPath,
        `[[outputs]] entry ${index + 1} wasm`,
      ),
      ...(output.forkInstrumentation === undefined
        ? {}
        : { forkInstrumentation: output.forkInstrumentation }),
    };
  });
  const completeRuntimeFiles = runtimeFiles.map((runtimeFile, index) => {
    if (!runtimeFile.artifact) {
      throw manifestError(
        manifestPath,
        `[[runtime_files]] entry ${index + 1} requires artifact`,
      );
    }
    return {
      artifact: portableArtifactPath(
        runtimeFile.artifact,
        manifestPath,
        `[[runtime_files]] entry ${index + 1} artifact`,
      ),
    };
  });

  const targetArches = arches && arches.length > 0 ? arches : ["wasm32"];
  if (
    new Set(targetArches).size !== targetArches.length
    || targetArches.some((arch) => !ARCH_SEGMENTS.has(arch))
  ) {
    throw manifestError(
      manifestPath,
      "arches must list wasm32 and/or wasm64 without duplicates",
    );
  }

  return {
    kind,
    name: safeSinglePathComponent(name, manifestPath, "name", false),
    outputs: completeOutputs,
    runtimeFiles: completeRuntimeFiles,
    targetArches,
  };
}

interface LegacyFlatOutputOwner {
  hasScalarOwner: boolean;
  packagePaths: Set<string>;
}

interface ProgramRegistryIndex {
  legacyFlatOutputs: Map<string, LegacyFlatOutputOwner>;
  forkInstrumentationDisabledOutputs: Set<string>;
}

let cachedProgramRegistryIndex: ProgramRegistryIndex | null = null;

/** @internal Test fixtures call this after changing registry manifests. */
export function resetBinaryResolverManifestCacheForTests(): void {
  cachedProgramRegistryIndex = null;
}

function programRegistryIndex(): ProgramRegistryIndex {
  if (cachedProgramRegistryIndex) return cachedProgramRegistryIndex;

  const index: ProgramRegistryIndex = {
    legacyFlatOutputs: new Map(),
    forkInstrumentationDisabledOutputs: new Set(),
  };
  let registry: string;
  try {
    registry = join(findRepoRoot(), "packages", "registry");
  } catch {
    cachedProgramRegistryIndex = index;
    return index;
  }

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(registry, { withFileTypes: true });
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && error.code === "ENOENT"
    ) {
      cachedProgramRegistryIndex = index;
      return index;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(registry, entry.name, "package.toml");
    if (!pathEntryExists(manifestPath)) continue;
    const packageToml = readFileSync(manifestPath, "utf8");
    if (topLevelManifestKind(packageToml, manifestPath) !== "program") continue;
    const parsed = parseProgramPackageClosureManifest(packageToml, manifestPath);
    if (parsed.kind !== "program") continue;
    if (parsed.name !== entry.name) {
      throw manifestError(
        manifestPath,
        `top-level name ${JSON.stringify(parsed.name)} does not match registry directory ${JSON.stringify(entry.name)}`,
      );
    }

    const packageOwned = parsed.outputs.length + parsed.runtimeFiles.length > 1;
    for (const arch of parsed.targetArches) {
      for (const output of parsed.outputs) {
        const flatOutput = outputRelForPackage(parsed.name, output, false);
        const key = `${arch}/${flatOutput}`;
        let owner = index.legacyFlatOutputs.get(key);
        if (!owner) {
          owner = { hasScalarOwner: false, packagePaths: new Set() };
          index.legacyFlatOutputs.set(key, owner);
        }
        if (packageOwned) {
          owner.packagePaths.add(
            `programs/${arch}/${outputRelForPackage(parsed.name, output, true)}`,
          );
        } else {
          owner.hasScalarOwner = true;
        }

        if (output.forkInstrumentation === "disabled") {
          index.forkInstrumentationDisabledOutputs.add(
            `${arch}/${outputRelForPackage(parsed.name, output, packageOwned)}`,
          );
        }
      }
    }
  }

  cachedProgramRegistryIndex = index;
  return index;
}

/**
 * Reject the former flat spelling of an output that now belongs to a
 * multi-member package directory. Without this migration guard, a stale
 * `programs/<arch>/<output>` symlink can enter scalar lookup and bypass the
 * package closure. A flat spelling remains valid when a true single-member
 * package owns the same output name.
 */
function rejectLegacyFlatPackageMember(adjusted: string): void {
  const components = adjusted.split("/");
  if (
    components.length !== 3
    || components[0] !== "programs"
    || !ARCH_SEGMENTS.has(components[1]!)
  ) return;
  const owner = programRegistryIndex().legacyFlatOutputs.get(
    `${components[1]}/${components[2]}`,
  );
  if (owner && !owner.hasScalarOwner && owner.packagePaths.size > 0) {
    throw new Error(
      `Legacy flat resolver path ${JSON.stringify(adjusted)} belongs to a multi-member package; use ${[...owner.packagePaths].sort().map((path) => JSON.stringify(path)).join(" or ")}`,
    );
  }
}

function discoverProgramPackageClosure(
  relPath: string,
): ProgramPackageClosure | null {
  const adjusted = applyDefaultArch(relPath);
  const components = adjusted.split("/");
  if (components.length === 3) {
    rejectLegacyFlatPackageMember(adjusted);
    return null;
  }
  if (
    components.length < 4
    || components[0] !== "programs"
    || !ARCH_SEGMENTS.has(components[1]!)
  ) return null;
  const arch = components[1]!;
  const packageDirectory = components[2]!;

  let repoRoot: string;
  try {
    repoRoot = findRepoRoot();
  } catch {
    // An installed host package has no source registry to inspect.
    return null;
  }
  const packageDirectoryPath = join(
    repoRoot,
    "packages",
    "registry",
    packageDirectory!,
  );
  if (!pathEntryExists(packageDirectoryPath)) return null;
  const manifestPath = join(packageDirectoryPath, "package.toml");
  if (!pathEntryExists(manifestPath)) {
    throw manifestError(
      manifestPath,
      "registry package directory exists but package.toml is missing",
    );
  }

  let packageToml: string;
  try {
    packageToml = readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw manifestError(
      manifestPath,
      `cannot read it: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = parseProgramPackageClosureManifest(packageToml, manifestPath);
  if (parsed.kind !== "program") {
    throw manifestError(
      manifestPath,
      `expected kind "program", found ${JSON.stringify(parsed.kind)}`,
    );
  }
  if (parsed.name !== packageDirectory) {
    throw manifestError(
      manifestPath,
      `top-level name ${JSON.stringify(parsed.name)} does not match registry directory ${JSON.stringify(packageDirectory)}`,
    );
  }
  if (!parsed.targetArches.includes(arch)) {
    throw manifestError(
      manifestPath,
      `package ${JSON.stringify(parsed.name)} does not declare resolver artifacts for ${arch}`,
    );
  }

  // A package-level transaction is needed whenever more than one declared
  // member must come from the same build, including one executable plus a
  // runtime archive (CPython and Erlang use that shape).
  const packageOwned = parsed.outputs.length + parsed.runtimeFiles.length > 1;
  if (!packageOwned) return null;

  const members: ProgramPackageClosureMember[] = [
    ...parsed.outputs.map((output) => ({
      relPath: `programs/${arch}/${outputRelForPackage(
        parsed.name,
        output,
        packageOwned,
      )}`,
      sourceArtifact: output.wasm,
    })),
    ...parsed.runtimeFiles.map((runtimeFile) => ({
      relPath: `programs/${arch}/${parsed.name}/${runtimeFile.artifact}`,
      sourceArtifact: runtimeFile.artifact,
    })),
  ];
  const relPathSet = new Set(members.map((member) => member.relPath));
  const artifactSet = new Set(members.map((member) => member.sourceArtifact));
  if (relPathSet.size !== members.length) {
    throw manifestError(manifestPath, "declared outputs collide in the resolver mirror");
  }
  if (artifactSet.size !== members.length) {
    throw manifestError(manifestPath, "declared source artifact paths are not unique");
  }

  if (!relPathSet.has(adjusted)) {
    throw manifestError(
      manifestPath,
      `resolver path ${JSON.stringify(adjusted)} is not a declared member of multi-member package ${JSON.stringify(parsed.name)}`,
    );
  }
  return { manifestPath, packageName: parsed.name, members };
}

/**
 * Return every output and runtime file when `relPath` names a member of a
 * multi-member program package. Outputs and runtime files are resolved as one
 * transaction whenever their combined count is greater than one.
 *
 * An absent registry directory means the path is not package-owned. Once the
 * directory exists, a missing, unreadable, or incomplete manifest is an error
 * rather than permission to fall back to single-output resolution.
 */
export function programOutputClosureRelPaths(relPath: string): string[] | null {
  return discoverProgramPackageClosure(relPath)?.members.map(
    (member) => member.relPath,
  ) ?? null;
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
      return programRegistryIndex().forkInstrumentationDisabledOutputs.has(
        `${arch}/${adjusted.slice(prefix.length)}`,
      );
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

function hasWasmArtifactPolicyFailures(path: string, relPath: string): boolean {
  if (!path.endsWith(".wasm")) return false;
  try {
    const bytes = readFileSync(path);
    const programBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const forkDisabled = disablesForkInstrumentation(relPath);
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

function hasBinaryArtifactPolicyFailures(path: string, relPath: string): boolean {
  return hasWasmArtifactPolicyFailures(path, relPath) ||
    hasVfsArtifactPolicyFailures(path);
}

function chooseBinaryCandidate(candidates: string[], relPath: string): string | null {
  const existing = candidates.filter(pathEntryExists);
  if (existing.length === 0) return null;

  return existing.find((candidate) => {
    try {
      return statSync(candidate).isFile()
        && !hasBinaryArtifactPolicyFailures(candidate, relPath);
    } catch {
      return false;
    }
  }) ?? null;
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
  const [programs, arch, packageName] = members[0]!.relPath.split("/");
  if (
    programs !== "programs"
    || !ARCH_SEGMENTS.has(arch!)
    || !packageName
  ) return "declared package members do not share a valid program namespace";
  if (!statSync(sharedRoot).isDirectory()) {
    return "shared package generation root is not a directory";
  }

  if (tier.identity === "local-generation") {
    const expectedParentPath = join(
      tier.root,
      ".kandelo-local-generations",
      arch!,
      packageName,
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
      && new RegExp(`-rev[0-9]+-${arch}-[a-f0-9]{64}$`).test(generationName);
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
          failure: "mutable repo mirrors need symlinks to one canonical package generation",
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
    right.members.map((member) => [member.relPath, member.sourceArtifact]),
  );
  return left.members.every(
    (member) => rightByPath.get(member.relPath) === member.sourceArtifact,
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
  if (candidate) return candidate;
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
  const closureMembers = closureMembersForRequestedSet(relPaths);
  return tryResolveBinarySetFromTiers(relPaths, closureMembers);
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
    for (const relPath of relPaths) {
      const candidates = tier.candidatesFor(relPath);
      const existing = candidates.filter(pathEntryExists);
      anyExisting ||= existing.length > 0;
      const candidate = chooseBinaryCandidate(candidates, relPath);
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
          hasBinaryArtifactPolicyFailures(path, relPaths[index]!)
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
    if (unavailable.length === 0) return selected;
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
  return join(findRepoRoot(), "binaries");
}

/** Returns the absolute path of local-binaries/ whether or not it exists. */
export function localBinariesDir(): string {
  return join(findRepoRoot(), "local-binaries");
}
