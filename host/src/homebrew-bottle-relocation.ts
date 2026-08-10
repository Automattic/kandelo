/**
 * Browser-safe implementation of Homebrew's receipt-owned text relocation.
 *
 * Bottles remain immutable transport objects. Only paths named by the exact
 * bottle's INSTALL_RECEIPT.json `changed_files` array are rewritten after the
 * archive has been verified and decoded.
 */

import {
  applyLazyTreeByteTransformRecipe,
  encodeMaterializationBytes,
  type LazyTreeByteTransformRecipe,
} from "./vfs/materialization-plan";

const MAX_BOTTLE_CHANGED_FILES = 100_000;
const MAX_BOTTLE_PATH_BYTES = 4096;
const MAX_BOTTLE_RUNTIME_DEPENDENCIES = 512;
const FULL_NAME_RE = /^([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/;
const HOMEBREW_JAVA_PLACEHOLDER = "@@HOMEBREW_JAVA@@";
const HOMEBREW_OPENJDK_NAME_RE = /^openjdk(?:@\d+(?:\.\d+)*)?/;
const TEXT_ENCODER = new TextEncoder();
const HOMEBREW_TEXT_PLACEHOLDERS = [
  "@@HOMEBREW_PREFIX@@",
  "@@HOMEBREW_CELLAR@@",
  "@@HOMEBREW_REPOSITORY@@",
  "@@HOMEBREW_LIBRARY@@",
  "@@HOMEBREW_PERL@@",
] as const;
const PLACEHOLDER_BYTES = [
  ...HOMEBREW_TEXT_PLACEHOLDERS,
  HOMEBREW_JAVA_PLACEHOLDER,
].map((placeholder) => ({
  placeholder,
  bytes: TEXT_ENCODER.encode(placeholder),
}));

export const HOMEBREW_BOTTLE_RELOCATION_RECIPE_ID =
  "homebrew-receipt-text-v1";

export interface HomebrewInstallReceiptRelocation {
  changedFiles: readonly string[];
  /** Kept opaque until a changed file actually uses the Java placeholder. */
  runtimeDependencies: unknown;
}

export interface HomebrewInstallReceiptDirectDependency {
  fullName: string;
  version: string;
  revision: number;
}

export interface HomebrewBottleRelocationDestination {
  /** Authenticated prefix which owns the exact bottle destination. */
  destinationPrefix: string;
  /** Guest or source path used only to identify a relocation failure. */
  path: string;
}

/**
 * Normalize the sole prefix allowed to interpret one authenticated bottle.
 *
 * Immutable descriptors bind guest paths and relocated byte sizes. Once a
 * receipt destination has been authenticated, consulting a host default could
 * silently produce bytes for a different image.
 */
export function normalizeHomebrewBottleDestinationPrefix(value: string): string {
  validateSafeAbsolutePath(value, "Homebrew bottle destination prefix");
  if (value === "/") {
    throw new Error("Homebrew bottle destination prefix must not be the filesystem root");
  }
  return value;
}

/** Derive and normalize a bottle prefix from one authenticated receipt path. */
export function deriveHomebrewBottleDestinationPrefix(
  receiptGuestPath: string,
  receiptSourcePath: string,
): string {
  validateSafeRelativePath(receiptSourcePath, "Homebrew receipt source path");
  validateSafeAbsolutePath(receiptGuestPath, "Homebrew receipt guest path");
  const cellarSuffix = `/Cellar/${receiptSourcePath}`;
  if (!receiptGuestPath.endsWith(cellarSuffix)) {
    throw new Error(
      `Homebrew receipt guest path does not match its source path: ${receiptGuestPath}`,
    );
  }
  return normalizeHomebrewBottleDestinationPrefix(
    receiptGuestPath.slice(0, -cellarSuffix.length),
  );
}

export function parseHomebrewInstallReceiptRelocation(
  bytes: Uint8Array,
): HomebrewInstallReceiptRelocation {
  const receipt = parseHomebrewInstallReceiptRecord(bytes);
  const changedValue = receipt.changed_files;
  if (
    changedValue !== undefined && changedValue !== null &&
    !Array.isArray(changedValue)
  ) {
    throw new Error(
      "INSTALL_RECEIPT.json changed_files must be an array or null when present",
    );
  }
  const values = Array.isArray(changedValue) ? changedValue : [];
  if (values.length > MAX_BOTTLE_CHANGED_FILES) {
    throw new Error(
      `INSTALL_RECEIPT.json declares ${values.length} changed files, ` +
        `limit ${MAX_BOTTLE_CHANGED_FILES}`,
    );
  }
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string") {
      throw new Error(`INSTALL_RECEIPT.json changed_files[${index}] is not a string`);
    }
    validateSafeRelativePath(value, "Homebrew changed file");
    if (seen.has(value)) {
      throw new Error(`INSTALL_RECEIPT.json repeats changed file ${value}`);
    }
    seen.add(value);
    changedFiles.push(value);
  }
  return {
    changedFiles,
    runtimeDependencies: receipt.runtime_dependencies,
  };
}

/**
 * Parse the exact direct runtime-dependency identity Homebrew records in a
 * bottle receipt. Transitive entries remain installation metadata but are not
 * descriptor edges.
 */
export function parseHomebrewInstallReceiptDirectDependencies(
  bytes: Uint8Array,
): HomebrewInstallReceiptDirectDependency[] {
  const receipt = parseHomebrewInstallReceiptRecord(bytes);
  const value = receipt.runtime_dependencies;
  if (!Array.isArray(value) || value.length > MAX_BOTTLE_RUNTIME_DEPENDENCIES) {
    throw new Error("INSTALL_RECEIPT.json runtime_dependencies must be a bounded array");
  }
  const dependencies: HomebrewInstallReceiptDirectDependency[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`INSTALL_RECEIPT.json runtime_dependencies[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.declared_directly !== "boolean") {
      throw new Error(
        `INSTALL_RECEIPT.json runtime_dependencies[${index}].declared_directly must be boolean`,
      );
    }
    if (!record.declared_directly) continue;
    const fullName = receiptString(record.full_name, index, "full_name");
    if (!FULL_NAME_RE.test(fullName)) {
      throw new Error(
        `INSTALL_RECEIPT.json runtime_dependencies[${index}].full_name is invalid`,
      );
    }
    const version = receiptString(record.pkg_version, index, "pkg_version");
    const revision = record.revision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
      throw new Error(
        `INSTALL_RECEIPT.json runtime_dependencies[${index}].revision must be a nonnegative integer`,
      );
    }
    if (seen.has(fullName)) {
      throw new Error(`INSTALL_RECEIPT.json repeats direct runtime dependency ${fullName}`);
    }
    seen.add(fullName);
    dependencies.push({ fullName, version, revision });
  }
  dependencies.sort((left, right) => compareCanonicalText(left.fullName, right.fullName));
  return dependencies;
}

function parseHomebrewInstallReceiptRecord(bytes: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(
      "INSTALL_RECEIPT.json is not valid UTF-8 JSON: " + errorMessage(error),
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("INSTALL_RECEIPT.json must contain an object");
  }
  return parsed as Record<string, unknown>;
}

function receiptString(value: unknown, index: number, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `INSTALL_RECEIPT.json runtime_dependencies[${index}].${field} must be a nonempty string`,
    );
  }
  return value;
}

function compareCanonicalText(left: string, right: string): number {
  const leftBytes = TEXT_ENCODER.encode(left);
  const rightBytes = TEXT_ENCODER.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export function relocateHomebrewBottleFile(
  bytes: Uint8Array,
  receipt: HomebrewInstallReceiptRelocation,
  destination: HomebrewBottleRelocationDestination,
): Uint8Array {
  const destinationPrefix = normalizeHomebrewBottleDestinationPrefix(
    destination.destinationPrefix,
  );
  const javaPlaceholder = TEXT_ENCODER.encode(HOMEBREW_JAVA_PLACEHOLDER);
  if (containsBytes(bytes, javaPlaceholder)) {
    const javaHome = homebrewJavaHome(receipt.runtimeDependencies, destinationPrefix);
    if (javaHome === undefined) {
      throw new Error(
        `Homebrew changed file ${destination.path} uses ${HOMEBREW_JAVA_PLACEHOLDER} ` +
        "without exactly one OpenJDK runtime dependency",
      );
    }
  }
  try {
    return applyLazyTreeByteTransformRecipe(
      bytes,
      createHomebrewBottleRelocationRecipe(receipt, destination),
    );
  } catch (error) {
    const remaining = error instanceof Error
      ? PLACEHOLDER_BYTES.find(({ bytes: placeholder }) =>
        error.message.endsWith(
          `retains rejected byte sequence ${encodeMaterializationBytes(placeholder)}`,
        )
      )
      : undefined;
    if (remaining !== undefined) {
      throw new Error(
        `Homebrew changed file ${destination.path} retains ${remaining.placeholder}`,
      );
    }
    throw error;
  }
}

/** Translate authenticated receipt policy into the closed generic recipe. */
export function createHomebrewBottleRelocationRecipe(
  receipt: HomebrewInstallReceiptRelocation,
  destination: HomebrewBottleRelocationDestination,
): LazyTreeByteTransformRecipe {
  const destinationPrefix = normalizeHomebrewBottleDestinationPrefix(
    destination.destinationPrefix,
  );
  const replacements: Array<readonly [string, string]> = [
    ["@@HOMEBREW_PREFIX@@", destinationPrefix],
    ["@@HOMEBREW_CELLAR@@", `${destinationPrefix}/Cellar`],
    ["@@HOMEBREW_REPOSITORY@@", destinationPrefix],
    ["@@HOMEBREW_LIBRARY@@", `${destinationPrefix}/Library`],
    ["@@HOMEBREW_PERL@@", `${destinationPrefix}/opt/perl/bin/perl`],
  ];
  const javaHome = homebrewJavaHome(receipt.runtimeDependencies, destinationPrefix);
  if (javaHome !== undefined) {
    replacements.push([HOMEBREW_JAVA_PLACEHOLDER, javaHome]);
  }
  return {
    id: HOMEBREW_BOTTLE_RELOCATION_RECIPE_ID,
    replacements: replacements.map(([match, replacement]) => ({
      matchHex: encodeMaterializationBytes(TEXT_ENCODER.encode(match)),
      replacementHex: encodeMaterializationBytes(TEXT_ENCODER.encode(replacement)),
    })),
    rejectHex: PLACEHOLDER_BYTES.map(({ bytes }) =>
      encodeMaterializationBytes(bytes)
    ),
  };
}

function homebrewJavaHome(value: unknown, destinationPrefix: string): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const dependency of value) {
    if (typeof dependency !== "object" || dependency === null || Array.isArray(dependency)) {
      continue;
    }
    const record = dependency as Record<string, unknown>;
    const candidate = typeof record.full_name === "string"
      ? record.full_name.split("/").at(-1)
      : typeof record.name === "string"
        ? record.name.split("/").at(-1)
        : undefined;
    const match = candidate === undefined
      ? null
      : HOMEBREW_OPENJDK_NAME_RE.exec(candidate);
    if (candidate !== undefined && match?.[0] === candidate) {
      names.push(candidate);
    }
  }
  const unique = [...new Set(names)];
  return unique.length === 1
    ? `${destinationPrefix}/opt/${unique[0]}/libexec`
    : undefined;
}

function validateSafeAbsolutePath(value: string, label: string): void {
  if (
    !value.startsWith("/") || value.includes("\\") || value.includes("\0") ||
    hasLoneUnicodeSurrogate(value) ||
    TEXT_ENCODER.encode(value).byteLength > MAX_BOTTLE_PATH_BYTES ||
    value.slice(1).split("/").some((part) =>
      part === "" || part === "." || part === ".."
    )
  ) {
    throw new Error(`${label} has an unsafe path segment: ${value}`);
  }
}

function validateSafeRelativePath(value: string, label: string): void {
  if (
    value.length === 0 || value.startsWith("/") || value.includes("\\") ||
    value.includes("\0") || hasLoneUnicodeSurrogate(value) ||
    TEXT_ENCODER.encode(value).byteLength > MAX_BOTTLE_PATH_BYTES ||
    value.split("/").some((part) =>
      part === "" || part === "." || part === ".."
    )
  ) {
    throw new Error(`${label} has an unsafe path segment: ${value}`);
  }
}

function hasLoneUnicodeSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (
      unit <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      index += 1;
      continue;
    }
    return true;
  }
  return false;
}

function containsBytes(bytes: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || needle.byteLength > bytes.byteLength) return false;
  outer: for (let offset = 0; offset <= bytes.byteLength - needle.byteLength; offset += 1) {
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (bytes[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
