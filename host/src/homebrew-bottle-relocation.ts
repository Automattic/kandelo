/**
 * Browser-safe implementation of Homebrew's receipt-owned text relocation.
 *
 * Bottles remain immutable transport objects. Only paths named by the exact
 * bottle's INSTALL_RECEIPT.json `changed_files` array are rewritten after the
 * archive has been verified and decoded.
 */

const MAX_BOTTLE_CHANGED_FILES = 100_000;
const MAX_BOTTLE_PATH_BYTES = 4096;
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

export interface HomebrewInstallReceiptRelocation {
  changedFiles: readonly string[];
  /** Kept opaque until a changed file actually uses the Java placeholder. */
  runtimeDependencies: unknown;
}

export interface HomebrewBottleRelocationDestination {
  /** Authenticated guest prefix that owns the bottle's Cellar. */
  guestPrefix: string;
  /** Guest or source path used only to identify a relocation failure. */
  path: string;
}

/**
 * Recover the prefix recorded by one authenticated deferred-tree descriptor.
 *
 * The destination is the authority because immutable descriptors retain the
 * exact path and relocated byte sizes they were built for. A newer runtime
 * must not silently reinterpret those bytes using its own default prefix.
 */
export function deriveHomebrewBottleGuestPrefix(
  receiptGuestPath: string,
  receiptSourcePath: string,
): string {
  validateSafeRelativePath(receiptSourcePath, "Homebrew receipt source path");
  validateSafeAbsolutePath(receiptGuestPath, "Homebrew receipt guest path");
  const cellarSuffix = `/Cellar/${receiptSourcePath}`;
  if (!receiptGuestPath.endsWith(cellarSuffix)) {
    throw new Error(
      `Homebrew receipt guest path does not match its source path: ` +
        receiptGuestPath,
    );
  }
  return validateGuestPrefix(
    receiptGuestPath.slice(0, -cellarSuffix.length),
  );
}

export function parseHomebrewInstallReceiptRelocation(
  bytes: Uint8Array,
): HomebrewInstallReceiptRelocation {
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
  const receipt = parsed as Record<string, unknown>;
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

export function relocateHomebrewBottleFile(
  bytes: Uint8Array,
  receipt: HomebrewInstallReceiptRelocation,
  destination: HomebrewBottleRelocationDestination,
): Uint8Array {
  const guestPrefix = validateGuestPrefix(destination.guestPrefix);
  const replacements = [
    ["@@HOMEBREW_PREFIX@@", guestPrefix],
    ["@@HOMEBREW_CELLAR@@", `${guestPrefix}/Cellar`],
    ["@@HOMEBREW_REPOSITORY@@", guestPrefix],
    ["@@HOMEBREW_LIBRARY@@", `${guestPrefix}/Library`],
    ["@@HOMEBREW_PERL@@", `${guestPrefix}/opt/perl/bin/perl`],
  ] as const;
  let relocated = bytes;
  for (const [placeholder, replacement] of replacements) {
    relocated = replaceBytes(
      relocated,
      TEXT_ENCODER.encode(placeholder),
      TEXT_ENCODER.encode(replacement),
    );
  }
  const javaPlaceholder = TEXT_ENCODER.encode(HOMEBREW_JAVA_PLACEHOLDER);
  if (containsBytes(relocated, javaPlaceholder)) {
    const javaHome = homebrewJavaHome(
      receipt.runtimeDependencies,
      guestPrefix,
    );
    if (javaHome === undefined) {
      throw new Error(
        `Homebrew changed file ${destination.path} uses ` +
          `${HOMEBREW_JAVA_PLACEHOLDER} ` +
          "without exactly one OpenJDK runtime dependency",
      );
    }
    relocated = replaceBytes(relocated, javaPlaceholder, TEXT_ENCODER.encode(javaHome));
  }
  const remaining = PLACEHOLDER_BYTES.find(({ bytes: placeholder }) =>
    containsBytes(relocated, placeholder)
  );
  if (remaining !== undefined) {
    throw new Error(
      `Homebrew changed file ${destination.path} retains ` +
        remaining.placeholder,
    );
  }
  return relocated;
}

function homebrewJavaHome(
  value: unknown,
  guestPrefix: string,
): string | undefined {
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
    ? `${guestPrefix}/opt/${unique[0]}/libexec`
    : undefined;
}

function validateGuestPrefix(value: string): string {
  validateSafeAbsolutePath(value, "Homebrew guest prefix");
  if (value === "/") {
    throw new Error("Homebrew guest prefix must not be the filesystem root");
  }
  return value;
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

function replaceBytes(
  bytes: Uint8Array,
  needle: Uint8Array,
  replacement: Uint8Array,
): Uint8Array {
  const offsets: number[] = [];
  for (let offset = 0; offset <= bytes.byteLength - needle.byteLength;) {
    let equal = true;
    for (let index = 0; index < needle.byteLength; index += 1) {
      if (bytes[offset + index] !== needle[index]) {
        equal = false;
        break;
      }
    }
    if (equal) {
      offsets.push(offset);
      offset += needle.byteLength;
    } else {
      offset += 1;
    }
  }
  if (offsets.length === 0) return bytes;
  const result = new Uint8Array(
    bytes.byteLength + offsets.length * (replacement.byteLength - needle.byteLength),
  );
  let sourceOffset = 0;
  let targetOffset = 0;
  for (const offset of offsets) {
    const prefix = bytes.subarray(sourceOffset, offset);
    result.set(prefix, targetOffset);
    targetOffset += prefix.byteLength;
    result.set(replacement, targetOffset);
    targetOffset += replacement.byteLength;
    sourceOffset = offset + needle.byteLength;
  }
  result.set(bytes.subarray(sourceOffset), targetOffset);
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
