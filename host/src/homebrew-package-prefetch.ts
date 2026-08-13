import type { HomebrewPackagePrefetchResult } from "./types";
import { MemoryFileSystem } from "./vfs/memory-fs";

const COMPOSITION_PATH = "/etc/kandelo/homebrew-vfs.json";
const CELLAR_PREFIX = "/opt/kandelo/homebrew/Cellar/";
const FULL_NAME = /^[a-z0-9._-]+\/[a-z0-9._-]+\/[a-z0-9][a-z0-9._-]*$/u;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const MAX_COMPOSITION_BYTES = 4 * 1024 * 1024;
const MAX_PACKAGES = 4_096;
const MAX_DEPENDENCIES = 128;
const MAX_ROOTS = 32;
const MAX_FULL_NAME_BYTES = 512;
const MAX_ROOT_BYTES = 16 * 1024;
const MAX_KEG_BYTES = 4_096;

interface PrefetchPackage {
  fullName: string;
  keg: string;
  dependencies: string[];
}

export async function prefetchHomebrewPackageClosures(
  fs: MemoryFileSystem,
  roots: readonly string[],
): Promise<HomebrewPackagePrefetchResult> {
  if (!(fs instanceof MemoryFileSystem)) {
    throw new Error("Homebrew package prefetch requires a MemoryFileSystem");
  }
  const packages = readHomebrewPrefetchComposition(fs);
  const normalizedRoots = validateHomebrewPackagePrefetchRoots(roots);
  const closure = dependencyFirstClosure(packages, normalizedRoots);
  const materializedPackages: string[] = [];
  const alreadyMaterializedPackages: string[] = [];

  for (const pkg of closure) {
    const changed = await fs.preparePath(pkg.keg);
    (changed ? materializedPackages : alreadyMaterializedPackages)
      .push(pkg.fullName);
  }
  return {
    roots: normalizedRoots,
    packages: closure.map((pkg) => pkg.fullName),
    materializedPackages,
    alreadyMaterializedPackages,
  };
}

function readHomebrewPrefetchComposition(
  fs: MemoryFileSystem,
): Map<string, PrefetchPackage> {
  const stat = fs.stat(COMPOSITION_PATH);
  if (
    (stat.mode & S_IFMT) !== S_IFREG ||
    !Number.isSafeInteger(stat.size) ||
    stat.size <= 0 ||
    stat.size > MAX_COMPOSITION_BYTES
  ) {
    throw new Error("Homebrew prefetch composition is not a bounded regular file");
  }
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(COMPOSITION_PATH, 0, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(fd, bytes.subarray(offset), null, bytes.byteLength - offset);
      if (count <= 0) throw new Error("Homebrew prefetch composition read was short");
      offset += count;
    }
  } finally {
    fs.close(fd);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(
      `Homebrew prefetch composition is not strict UTF-8 JSON: ${boundedError(error)}`,
    );
  }
  if (!isRecord(value) || value.schema !== 1 || !Array.isArray(value.packages)) {
    throw new Error("Homebrew prefetch composition protocol is unsupported");
  }
  if (value.packages.length === 0 || value.packages.length > MAX_PACKAGES) {
    throw new Error("Homebrew prefetch composition package count is invalid");
  }
  const result = new Map<string, PrefetchPackage>();
  for (const [index, candidate] of value.packages.entries()) {
    if (!isRecord(candidate)) {
      throw new Error(`Homebrew prefetch package ${index} is not an object`);
    }
    const fullName = validateFullName(
      candidate.full_name,
      `Homebrew prefetch package ${index}`,
    );
    const keg = validateKeg(candidate.keg, `Homebrew prefetch package ${fullName}`);
    if (!Array.isArray(candidate.dependencies) ||
      candidate.dependencies.length > MAX_DEPENDENCIES) {
      throw new Error(`Homebrew prefetch package ${fullName} dependencies are invalid`);
    }
    const dependencies = candidate.dependencies.map((dependency, dependencyIndex) =>
      validateFullName(
        dependency,
        `Homebrew prefetch package ${fullName} dependency ${dependencyIndex}`,
      )
    );
    if (
      new Set(dependencies).size !== dependencies.length ||
      JSON.stringify(dependencies) !== JSON.stringify([...dependencies].sort())
    ) {
      throw new Error(`Homebrew prefetch package ${fullName} dependencies are not canonical`);
    }
    if (result.has(fullName)) {
      throw new Error(`Homebrew prefetch composition repeats package ${fullName}`);
    }
    result.set(fullName, { fullName, keg, dependencies });
  }

  for (const pkg of result.values()) {
    for (const dependency of pkg.dependencies) {
      if (!result.has(dependency)) {
        throw new Error(
          `Homebrew prefetch package ${pkg.fullName} has missing dependency ${dependency}`,
        );
      }
    }
  }
  assertAcyclic(result);
  return result;
}

export function validateHomebrewPackagePrefetchRoots(
  roots: readonly string[],
): string[] {
  if (!Array.isArray(roots) || roots.length === 0 || roots.length > MAX_ROOTS) {
    throw new Error("Homebrew package prefetch roots are outside their count bound");
  }
  const result: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const [index, candidate] of roots.entries()) {
    const root = validateFullName(candidate, `Homebrew package prefetch root ${index}`);
    bytes += utf8Length(root);
    if (bytes > MAX_ROOT_BYTES) {
      throw new Error("Homebrew package prefetch roots exceed their UTF-8 byte bound");
    }
    if (!seen.has(root)) {
      seen.add(root);
      result.push(root);
    }
  }
  return result;
}

/**
 * Reduce worker failures to one bounded diagnostic string before crossing the
 * trust boundary. URLs can contain credentials and transport paths are not a
 * stable part of the public host API, so redact them rather than echoing them.
 */
export function boundedHomebrewPackagePrefetchError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(/\b(?:https?|file):\/\/\S+/gu, "[redacted location]")
    .replace(/\b(?:authorization|password|token)\s*[:=]\s*\S+/giu, "$1=[redacted]");
  const encoder = new TextEncoder();
  if (encoder.encode(redacted).byteLength <= 512) return redacted;
  let result = "";
  for (const codePoint of redacted) {
    if (encoder.encode(result + codePoint).byteLength > 512) break;
    result += codePoint;
  }
  return result;
}

function dependencyFirstClosure(
  packages: Map<string, PrefetchPackage>,
  roots: readonly string[],
): PrefetchPackage[] {
  const result: PrefetchPackage[] = [];
  const visited = new Set<string>();
  const visit = (fullName: string): void => {
    if (visited.has(fullName)) return;
    const pkg = packages.get(fullName);
    if (pkg === undefined) {
      throw new Error(`Homebrew package ${fullName} is absent from the Homebrew composition`);
    }
    visited.add(fullName);
    for (const dependency of pkg.dependencies) visit(dependency);
    result.push(pkg);
  };
  for (const root of roots) visit(root);
  return result;
}

function assertAcyclic(packages: Map<string, PrefetchPackage>): void {
  const complete = new Set<string>();
  const active = new Set<string>();
  const visit = (fullName: string): void => {
    if (complete.has(fullName)) return;
    if (active.has(fullName)) {
      throw new Error(`Homebrew prefetch composition has a dependency cycle at ${fullName}`);
    }
    active.add(fullName);
    for (const dependency of packages.get(fullName)!.dependencies) visit(dependency);
    active.delete(fullName);
    complete.add(fullName);
  };
  for (const fullName of packages.keys()) visit(fullName);
}

function validateFullName(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    utf8Length(value) > MAX_FULL_NAME_BYTES ||
    !FULL_NAME.test(value)
  ) {
    throw new Error(`${label} full name is invalid`);
  }
  return value;
}

function validateKeg(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    utf8Length(value) > MAX_KEG_BYTES ||
    !value.startsWith(CELLAR_PREFIX) ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.split("/").some((part) => part === "." || part === "..") ||
    value.slice(CELLAR_PREFIX.length).split("/").length !== 2
  ) {
    throw new Error(`${label} keg is not a normalized Cellar path`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512);
}
