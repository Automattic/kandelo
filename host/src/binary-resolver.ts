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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  candidatesFor(relPath: string): string[];
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
    candidatesFor(relPath: string): string[] {
      return packagedBinaryCandidates(relPath, root);
    },
  });
  return tiers;
}

let cachedForkInstrumentationDisabledOutputs: Set<string> | null = null;

interface ProgramOutputPolicy {
  name?: string;
  wasm?: string;
  forkInstrumentation?: string;
}

function outputExtension(wasmPath: string): string {
  const basename = wasmPath.split(/[\\/]/).pop() ?? wasmPath;
  const dot = basename.indexOf(".");
  return dot >= 0 ? basename.slice(dot) : "";
}

function outputRelForPackage(
  packageName: string,
  output: Required<Pick<ProgramOutputPolicy, "name" | "wasm">>,
  outputCount: number,
): string {
  const destName = `${output.name}${outputExtension(output.wasm)}`;
  return outputCount > 1 ? `${packageName}/${destName}` : destName;
}

function parseProgramOutputPolicies(packageToml: string): {
  kind?: string;
  name?: string;
  outputs: ProgramOutputPolicy[];
} {
  const kind = packageToml.match(/^kind\s*=\s*"([^"]+)"/m)?.[1];
  const name = packageToml.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  const outputs: ProgramOutputPolicy[] = [];
  let current: ProgramOutputPolicy | null = null;

  for (const line of packageToml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "[[outputs]]") {
      if (current) outputs.push(current);
      current = {};
      continue;
    }
    if (!current) continue;
    if (trimmed.startsWith("[") && trimmed !== "[[outputs]]") {
      outputs.push(current);
      current = null;
      continue;
    }
    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/);
    if (!match) continue;
    if (match[1] === "name") current.name = match[2];
    if (match[1] === "wasm") current.wasm = match[2];
    if (match[1] === "fork_instrumentation") current.forkInstrumentation = match[2];
  }
  if (current) outputs.push(current);

  return { kind, name, outputs };
}

function forkInstrumentationDisabledOutputs(): Set<string> {
  if (cachedForkInstrumentationDisabledOutputs) {
    return cachedForkInstrumentationDisabledOutputs;
  }

  const disabled = new Set<string>();
  try {
    const registry = join(findRepoRoot(), "packages", "registry");
    for (const entry of readdirSync(registry, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(registry, entry.name, "package.toml");
      if (!existsSync(manifestPath)) continue;
      const parsed = parseProgramOutputPolicies(readFileSync(manifestPath, "utf8"));
      if (parsed.kind !== "program" || !parsed.name) continue;
      const completeOutputs = parsed.outputs.filter(
        (out): out is Required<Pick<ProgramOutputPolicy, "name" | "wasm">> & ProgramOutputPolicy =>
          Boolean(out.name && out.wasm),
      );
      for (const output of completeOutputs) {
        if (output.forkInstrumentation !== "disabled") continue;
        disabled.add(outputRelForPackage(parsed.name, output, completeOutputs.length));
      }
    }
  } catch {
    // Installed package consumers do not carry registry manifests.
  }

  cachedForkInstrumentationDisabledOutputs = disabled;
  return disabled;
}

function stripProgramArch(relPath: string): string | null {
  const adjusted = applyDefaultArch(relPath);
  for (const prefix of ["programs/wasm32/", "programs/wasm64/"]) {
    if (adjusted.startsWith(prefix)) return adjusted.slice(prefix.length);
  }
  return null;
}

function disablesForkInstrumentation(relPath: string): boolean {
  const programRel = stripProgramArch(relPath);
  return programRel !== null && forkInstrumentationDisabledOutputs().has(programRel);
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
    return false;
  }
}

function hasVfsArtifactPolicyFailures(path: string): boolean {
  if (!path.endsWith(".vfs") && !path.endsWith(".vfs.zst")) return false;
  try {
    const metadata = MemoryFileSystem.readImageMetadata(readFileSync(path));
    const declaredAbi = metadata?.kernelAbi;
    return declaredAbi !== undefined && declaredAbi !== ABI_VERSION;
  } catch {
    return false;
  }
}

function hasBinaryArtifactPolicyFailures(path: string, relPath: string): boolean {
  return hasWasmArtifactPolicyFailures(path, relPath) ||
    hasVfsArtifactPolicyFailures(path);
}

function chooseBinaryCandidate(candidates: string[], relPath: string): string | null {
  const existing = candidates.filter((candidate) => existsSync(candidate));
  if (existing.length === 0) return null;

  return existing.find((candidate) => !hasBinaryArtifactPolicyFailures(candidate, relPath)) ?? null;
}

export function resolveBinary(relPath: string): string {
  const adjusted = applyDefaultArch(relPath);
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
  throw new Error(
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
  } catch {
    return null;
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
 * Returned paths preserve `relPaths` order and are guaranteed to share the
 * same local, fetched, or installed-package root.
 */
export function tryResolveBinarySet(relPaths: readonly string[]): string[] | null {
  if (relPaths.length === 0) return [];

  let anyExisting = false;
  const incomplete: string[] = [];
  for (const tier of binaryCandidateTiers()) {
    const selected: string[] = [];
    const unavailable: string[] = [];
    for (const relPath of relPaths) {
      const candidates = tier.candidatesFor(relPath);
      const existing = candidates.filter((candidate) => existsSync(candidate));
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
